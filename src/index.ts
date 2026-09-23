// Entry point - loads config and starts the proxy

import { join } from "node:path";
import type { Config } from "./types.js";
import { AccountRotator } from "./rotator.js";
import { startProxy } from "./proxy.js";
import { closeAllAudioWebSockets } from "./audio-transcription.js";
import { getConfigDir } from "./paths.js";
import { TelemetryReporter, setActiveReporter } from "./telemetry.js";
import { loadConfig as loadConfigFromStore, importLegacyOllamaRotatorAccounts } from "./account-store.js";
import {
  ensureAdminToken,
  getConfiguredAdminToken,
  setPersistedAdminToken,
} from "./admin-auth.js";
import { warnIfUsingFallbackOAuthCreds } from "./providers/google-antigravity/oauth.js";
import { warnIfInsecureTelemetryEndpoint } from "./telemetry.js";
import {
  setModelSpecsOverride,
  loadResponsesStore,
  flushResponsesStore,
} from "./compat.js";
import { setModelAliasesOverride, setEffortRoutingOverride } from "./types.js";
import { readTextFile, writeTextFileAtomic } from "./storage.js";
import { initDb, isDbConfigured } from "./db-store.js";
import { runKeyMigrations } from "./key-migrations.js";
import { flushSpendLogs, stopRetentionCleanup, startRetentionCleanup } from "./spend-logger.js";
import { stopPendingSessionReaper } from "./onboarding.js";
import { getProxyExposureWarning } from "./exposure.js";
import { closeProxyDispatchers } from "./providers/proxy-dispatcher.js";

function loadConfig(): Config {
  try {
    const config = loadConfigFromStore();

    if (!config.accounts || config.accounts.length === 0) {
      console.error(
        "No accounts configured. Run 'tuxevil-rotator login' to add one.",
      );
      process.exit(1);
    }

    return config;
  } catch (err) {
    console.error(`Failed to load config: ${err}`);
    process.exit(1);
  }
}

const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;
const SHUTDOWN_SERVER_CLOSE_TIMEOUT_MS = 3_000;
const SHUTDOWN_FORCE_EXIT_MS = 10_000;

/**
 * Show a one-time, non-intrusive star reminder after 24h since first install.
 * Creates .first-boot on first run, shows prompt once after 24h,
 * then writes .star-prompted so it never appears again.
 */
async function maybeShowStarNudge(): Promise<void> {
  const dir = getConfigDir();
  const promptedPath = join(dir, ".star-prompted");
  try {
    if ((await readTextFile(promptedPath)) !== null) return;
  } catch {
    return;
  }

  const firstBootPath = join(dir, ".first-boot");
  let firstBootMs: number;

  try {
    const firstBoot = await readTextFile(firstBootPath);
    if (firstBoot !== null) {
      firstBootMs = parseInt(firstBoot.trim(), 10);
      if (Number.isNaN(firstBootMs)) return;
    } else {
      // First ever boot — record timestamp
      firstBootMs = Date.now();
      try {
        await writeTextFileAtomic(firstBootPath, String(firstBootMs));
      } catch {
        /* best effort */
      }
      return; // too early, come back after 24h
    }
  } catch {
    return;
  }

  if (Date.now() - firstBootMs < TWENTY_FOUR_HOURS_MS) return; // not yet

  // Show it once
  console.log("  ╭──────────────────────────────────────────────────────────╮");
  console.log("  │  ⭐ Enjoying tuxevil-rotator?                     │");
  console.log("  │  github.com/tuxevil/tuxevil-rotator              │");
  console.log("  │  A star helps others find it. Thanks!                   │");
  console.log("  ╰──────────────────────────────────────────────────────────╯");
  console.log();

  try {
    await writeTextFileAtomic(promptedPath, String(Date.now()));
  } catch {
    /* best effort */
  }
}

/**
 * Resolve the effective admin token at startup. If no TUXEVIL_ROTATOR_ADMIN_TOKEN
 * env var is set and no persisted token exists, a new token is generated,
 * saved to the repository, and printed to the operator once. This ensures
 * admin routes are protected by default on first run.
 */
async function bootstrapAdminToken(): Promise<void> {
  const resolved = await ensureAdminToken();
  setPersistedAdminToken(resolved.token);
  if (resolved.source === "generated") {
    console.log();
    console.log(
      "  ╭──────────────────────────────────────────────────────────╮",
    );
    console.log(
      "  │  Generated admin token (saved to repository):           │",
    );
    const tokenPreview =
      resolved.token.length > 12
        ? `${resolved.token.slice(0, 8)}…${resolved.token.slice(-4)}`
        : resolved.token;
    console.log(`  │  ${tokenPreview}  │`);
    console.log(
      "  │                                                          │",
    );
    console.log(
      "  │  Header: x-rotator-admin-token: <token>                  │",
    );
    console.log(
      "  │  Bearer: Authorization: Bearer <token>                   │",
    );
    console.log(
      "  │  URL:    <url>?token=<token>                             │",
    );
    console.log(
      "  ╰──────────────────────────────────────────────────────────╯",
    );
    console.log();
  }
}

function maybeWarnAboutAdminExposure(config: Config): void {
  if (getConfiguredAdminToken()) return;
  console.warn("WARNING: TUXEVIL_ROTATOR_ADMIN_TOKEN is not configured.");
  console.warn(
    `WARNING: Dashboard and /api/* routes are open on ${config.bindHost}:${config.proxyPort}.`,
  );
  console.warn(
    "WARNING: For local-only use, prefer bindHost=127.0.0.1 or set TUXEVIL_ROTATOR_ADMIN_TOKEN.",
  );
  console.warn();
}

function maybeWarnAboutProxyExposure(config: Config): void {
  const warning = getProxyExposureWarning(config);
  if (!warning) return;
  console.warn(`WARNING: ${warning}`);
  console.warn(
    "WARNING: TUXEVIL_ROTATOR_ADMIN_TOKEN protects dashboard/admin APIs, but not the native or /v1 proxy routes.",
  );
  console.warn();
}

export async function main(): Promise<void> {
  console.log("=== Tuxevil Rotator ===");
  console.log();

  await initDb();
  await runKeyMigrations();
  // PostgreSQL is the authoritative account store. Importing the legacy
  // Ollama JSON here would allow a stale disk credential to re-enter on boot.
  if (!isDbConfigured()) {
    await importLegacyOllamaRotatorAccounts();
  }
  startRetentionCleanup();

  const config = loadConfig();
  console.log(`Loaded ${config.accounts.length} accounts`);
  console.log(
    `Rotation: ${config.requestsPerRotation} requests / ${config.rotateOnQuotaDrop}% quota drop`,
  );
  console.log(
    `Quota poll: every ${Math.round((config.quotaPollIntervalMs || 300000) / 1000)}s`,
  );
  console.log(
    `Concurrency cap: ${config.maxConcurrentRequestsPerAccount} request/account, ${config.maxConcurrentRequestsPerProjectModel} request/project+model`,
  );
  console.log(`Bind host: ${config.bindHost}`);
  console.log(`Routing policy: ${config.routingPolicy}`);
  console.log(
    `Safety breaker: ${config.projectCircuitBreaker429Threshold} provider 429s / ${Math.round((config.projectCircuitBreakerWindowMs || 0) / 60000)}m pauses project+model for ${Math.round((config.projectCircuitBreakerCooldownMs || 0) / 60000)}m`,
  );
  console.log(
    `Protective pause: ${Math.round((config.protectivePauseMs || 0) / 3600000)}h after serious flag`,
  );
  console.log();

  for (const account of config.accounts) {
    console.log(`  ${account.label || account.email} (${account.email})`);
  }
  console.log();

  await maybeShowStarNudge();
  await bootstrapAdminToken();
  maybeWarnAboutAdminExposure(config);
  maybeWarnAboutProxyExposure(config);
  warnIfUsingFallbackOAuthCreds();
  warnIfInsecureTelemetryEndpoint();
  setModelSpecsOverride(config.modelSpecs ?? null);
  setModelAliasesOverride(config.modelAliases ?? null);
  setEffortRoutingOverride(config.effortRouting ?? null);
  void loadResponsesStore();

  const rotator = new AccountRotator(config);
  await rotator.primeOllamaCatalog();
  await rotator.primeCodexCatalog();

  // ── Telemetry (anonymous, opt-out via TUXEVIL_ROTATOR_TELEMETRY=off) ──
  const telemetry = new TelemetryReporter(() => {
    const status = rotator.getStatus();

    // getTokenUsage() deduplicates rolled-up buckets and exposes tokensByModel
    const tu = rotator.getTokenUsage();
    const tokensByModel = tu.tokensByModel;

    return {
      accountCount: status.accounts.length,
      modelsUsed: Object.keys(status.activeAccounts),
      totalRequests: status.totalRequestsAllAccounts,
      uptimeSeconds: Math.round(status.uptime / 1000),
      routingHealthState: status.routingHealth.state,
      flaggedCount: status.routingHealth.flaggedCount,
      disabledCount: status.routingHealth.disabledCount,
      proCount: status.accounts.filter((a) => a.proDetected).length,
      freeCount: status.accounts.filter((a) => !a.proDetected).length,
      tokensByModel,
    };
  });
  setActiveReporter(telemetry);
  void telemetry.start();

  let server: ReturnType<typeof startProxy> | null = null;
  let shuttingDown = false;

  // ── Graceful shutdown ──
  const shutdown = async (): Promise<void> => {
    // npm/tsx wrappers can deliver the same Ctrl+C twice; a forced exit here would skip the flushes.
    if (shuttingDown) {
      console.log("Shutdown already in progress");
      return;
    }
    shuttingDown = true;
    console.log("\nShutting down...");
    // Last resort if a flush hangs; cleared before the normal exit so it can never fire later.
    const forceExitTimer = setTimeout(() => {
      console.error(`Shutdown did not finish within ${SHUTDOWN_FORCE_EXIT_MS}ms; forcing exit`);
      process.exit(1);
    }, SHUTDOWN_FORCE_EXIT_MS);
    forceExitTimer.unref();
    stopRetentionCleanup();
    closeAllAudioWebSockets();
    const currentServer = server;
    if (currentServer) {
      // Bounded: a peer that never finishes closing must not keep the flushes below from running.
      await new Promise<void>((resolve) => {
        const closeTimer = setTimeout(() => {
          console.warn(
            `Proxy server did not close within ${SHUTDOWN_SERVER_CLOSE_TIMEOUT_MS}ms; continuing shutdown`,
          );
          resolve();
        }, SHUTDOWN_SERVER_CLOSE_TIMEOUT_MS);
        closeTimer.unref();
        currentServer.close(() => {
          clearTimeout(closeTimer);
          resolve();
        });
        (currentServer as any).closeAllConnections?.();
      });
    }
    await flushSpendLogs();
    await flushResponsesStore();
    await rotator.flushPendingStateSave();
    await rotator.flushPendingTokenUsageSave();
    await telemetry.shutdown();
    rotator.stopQuotaPolling();
    stopPendingSessionReaper();
    await closeProxyDispatchers();
    const { closeDb } = await import("./db-store.js");
    await closeDb();
    clearTimeout(forceExitTimer);
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());

  server = startProxy(rotator, config.proxyPort, config.bindHost || "0.0.0.0");
}

// Direct execution
if (process.argv[1]?.includes("index")) {
  main().catch((err) => {
    console.error("Fatal startup error:", err);
    process.exit(1);
  });
}
