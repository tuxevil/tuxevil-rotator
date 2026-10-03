import { existsSync } from "node:fs";
import type { Config } from "./types.js";

type ExposureConfig = Pick<Config, "bindHost" | "proxyPort">;

export function isLoopbackBindHost(bindHost?: string | null): boolean {
  const host = (bindHost || "0.0.0.0").trim().toLowerCase();
  return host === "localhost" || host === "127.0.0.1" || host === "::1";
}

/**
 * Inside a container the rotator must bind 0.0.0.0, and how far the port
 * reaches is decided by where the container publishes it, which it cannot see.
 * The Docker image sets TUXEVIL_ROTATOR_CONTAINER=1.
 */
export function isRunningInContainer(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.TUXEVIL_ROTATOR_CONTAINER === "1") return true;
  return existsSync("/.dockerenv") || existsSync("/run/.containerenv");
}

export function getProxyExposureWarning(
  config: ExposureConfig,
  inContainer: boolean = isRunningInContainer(),
): string | null {
  const bindHost = config.bindHost || "0.0.0.0";
  if (isLoopbackBindHost(bindHost)) return null;
  if (inContainer) {
    return (
      `Native and /v1 compatibility proxy routes are unauthenticated by design and listen on ${bindHost}:${config.proxyPort} inside this container, so they reach as far as the published port. ` +
      "The bundled docker-compose.yml publishes it on 127.0.0.1 only; put a firewall or trusted reverse proxy in front before publishing it on a network."
    );
  }
  return (
    `Native and /v1 compatibility proxy routes are unauthenticated by design and are listening on ${bindHost}:${config.proxyPort}. ` +
    "Restrict this port to localhost/LAN, a firewall, or a trusted reverse proxy, or set bindHost to 127.0.0.1 for local-only use."
  );
}
