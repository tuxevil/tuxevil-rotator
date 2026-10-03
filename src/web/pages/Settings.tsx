// Settings: routing controls, routing policy, benchmark, the raw config
// file, appearance and project information.

import type { JSX } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import type { Config } from "../../types.js";
import { formatDuration, formatMs } from "../lib/format.js";
import { ROUTING_POLICIES } from "../lib/status.js";
import { actions, confirmAction, toast } from "../state/actions.js";
import { api, runBenchmark, type BenchmarkResult, type BenchmarkSummary } from "../state/api.js";
import { authRequired, masked, masker, now, overview, refreshSnapshot, signOut, theme, type ThemePref } from "../state/store.js";
import { Icon } from "../components/icons.js";
import { Button, EmptyState, KeyValue, PageHeader, Panel, Pill, Segmented, Spinner, Switch } from "../components/ui.js";
import { downloadUrl, openAddAccount } from "./shared.js";

export function SettingsPage(): JSX.Element {
  const data = overview.value!;
  return (
    <>
      <PageHeader title="Settings" description="How the rotator routes traffic, plus tools and project information." />
      <div class="settings">
        <nav class="settings-nav" aria-label="Settings sections">
          <a href="#routing">Routing</a>
          <a href="#policy">Policy</a>
          <a href="#accounts">Accounts</a>
          <a href="#benchmark">Benchmark</a>
          <a href="#config">Configuration</a>
          <a href="#appearance">Appearance</a>
          <a href="#about">About</a>
        </nav>
        <div class="settings-body">
          <Panel id="routing" title="Routing controls" subtitle="Applied immediately to every account.">
            <div class="controls">
              <Switch
                label="Allow fresh windows"
                checked={data.operatorControls.allowFreshWindowStarts}
                onChange={(on) => actions.setFreshWindows(on)}
                description="When off, running 5-hour and 7-day windows are used first and no idle account starts a new window. Individual accounts can still be allowed from their menu."
              />
              <Switch
                label="Auto-warmup"
                checked={data.operatorControls.autoWarmupEnabled}
                onChange={(on) => actions.setAutoWarmup(on)}
                description="Each quota poll, accounts with the fresh-window override get one minimal request so their windows start before real traffic needs them."
              />
              {Object.keys(data.circuitBreakers.model).length + Object.keys(data.circuitBreakers.project).length > 0 && (
                <div class="callout tone-warn">
                  <Icon name="zap" size={16} />
                  <div>
                    <strong>Circuit breakers are open</strong>
                    <p>
                      {Object.keys(data.circuitBreakers.model).join(", ") || "Project-level breakers"} paused after repeated rate limits.
                    </p>
                    <Button size="sm" variant="danger" onClick={() => void actions.resetBreaker()}>
                      Reset all breakers
                    </Button>
                  </div>
                </div>
              )}
            </div>
          </Panel>
          <PolicyPanel />
          <Panel
            id="accounts"
            title="Accounts"
            subtitle="Sign in with Google Antigravity, Ollama, OpenAI Codex or OpenCode Zen in a new tab."
            actions={
              <Button variant="primary" icon="plus" onClick={openAddAccount}>
                Add account
              </Button>
            }
          >
            <p class="muted">
              {data.hostedOAuthConfigured
                ? "Hosted OAuth is configured, so Google sign-in happens in the browser."
                : "Hosted OAuth is not configured; the login page walks you through the CLI flow and paste-back."}
            </p>
          </Panel>
          <BenchmarkPanel />
          <ConfigPanel />
          <Panel id="appearance" title="Appearance and privacy">
            <div class="controls">
              <div class="setting-row">
                <div>
                  <div class="setting-label">Theme</div>
                  <div class="switch-description">Follows your system unless you pick one.</div>
                </div>
                <Segmented
                  label="Theme"
                  value={theme.value}
                  onChange={(v: ThemePref) => (theme.value = v)}
                  options={[
                    { value: "system", label: "System" },
                    { value: "light", label: "Light" },
                    { value: "dark", label: "Dark" },
                  ]}
                />
              </div>
              <Switch
                label="Privacy mask"
                checked={masked.value}
                onChange={(on) => {
                  masked.value = on;
                }}
                description="Replaces account names, emails, keys and IP addresses with placeholders, for screenshots and screen sharing. Add ?mask=1 to a link to open it masked."
              />
            </div>
          </Panel>
          <AboutPanel />
        </div>
      </div>
    </>
  );
}

const POLICY_FIELDS = [
  { key: "requestsPerRotation", label: "Requests per rotation", hint: "Requests an account serves before rotating, when quota data is unavailable.", min: 1, unit: "" },
  { key: "rotateOnQuotaDrop", label: "Rotate on quota drop", hint: "Rotate after a model's quota falls by this many points (0 uses the request count).", min: 0, unit: "%" },
  { key: "maxConcurrentRequestsPerAccount", label: "Concurrent requests per account", hint: "Hard cap on parallel requests to one account.", min: 1, unit: "" },
  { key: "quotaPollMinutes", label: "Quota poll interval", hint: "How often quota is refreshed from each provider.", min: 1, unit: "min" },
] as const;

type PolicyForm = {
  routingPolicy: string;
  requestsPerRotation: string;
  rotateOnQuotaDrop: string;
  maxConcurrentRequestsPerAccount: string;
  quotaPollMinutes: string;
};

function toForm(config: Config): PolicyForm {
  return {
    routingPolicy: config.routingPolicy || "timer-first",
    requestsPerRotation: String(config.requestsPerRotation ?? 5),
    rotateOnQuotaDrop: String(config.rotateOnQuotaDrop ?? 0),
    maxConcurrentRequestsPerAccount: String(config.maxConcurrentRequestsPerAccount ?? 5),
    quotaPollMinutes: String(Math.round((config.quotaPollIntervalMs ?? 300_000) / 60_000)),
  };
}

function PolicyPanel(): JSX.Element {
  const [config, setConfig] = useState<Config | null>(null);
  const [form, setForm] = useState<PolicyForm | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const load = async () => {
    try {
      const next = await api.config();
      setConfig(next);
      setForm(toForm(next));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };
  useEffect(() => {
    void load();
  }, []);

  const dirty = Boolean(config && form && JSON.stringify(toForm(config)) !== JSON.stringify(form));

  const save = async () => {
    if (!form) return;
    setSaving(true);
    setError(null);
    try {
      const fresh = await api.config();
      const next: Config = {
        ...fresh,
        routingPolicy: form.routingPolicy as Config["routingPolicy"],
        requestsPerRotation: Number(form.requestsPerRotation),
        rotateOnQuotaDrop: Number(form.rotateOnQuotaDrop),
        maxConcurrentRequestsPerAccount: Number(form.maxConcurrentRequestsPerAccount),
        quotaPollIntervalMs: Number(form.quotaPollMinutes) * 60_000,
      };
      await api.saveConfig(next);
      toast("Routing policy saved", "success");
      await load();
      void refreshSnapshot();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Panel
      id="policy"
      title="Routing policy"
      subtitle="Which account serves the next request."
      actions={
        dirty && (
          <>
            <Button onClick={() => config && setForm(toForm(config))}>Discard</Button>
            <Button variant="primary" loading={saving} onClick={() => void save()}>
              Save
            </Button>
          </>
        )
      }
    >
      {!form ? (
        error ? (
          <EmptyState icon="critical" title="Could not load the configuration">
            {error}
          </EmptyState>
        ) : (
          <Spinner />
        )
      ) : (
        <div class="form">
          <fieldset class="radio-cards">
            <legend class="sr-only">Routing policy</legend>
            {ROUTING_POLICIES.map((policy) => (
              <label key={policy.value} class={`radio-card${form.routingPolicy === policy.value ? " is-checked" : ""}`}>
                <input
                  type="radio"
                  name="routingPolicy"
                  value={policy.value}
                  checked={form.routingPolicy === policy.value}
                  onChange={() => setForm({ ...form, routingPolicy: policy.value })}
                />
                <span>
                  <strong>{policy.label}</strong>
                  <span class="radio-card-text">{policy.description}</span>
                </span>
              </label>
            ))}
          </fieldset>
          <div class="form-grid">
            {POLICY_FIELDS.map((field) => (
              <label class="field" key={field.key}>
                <span class="field-label">{field.label}</span>
                <span class="input-unit">
                  <input
                    class="input"
                    type="number"
                    min={field.min}
                    value={form[field.key]}
                    onInput={(e) => setForm({ ...form, [field.key]: (e.target as HTMLInputElement).value })}
                  />
                  {field.unit && <span>{field.unit}</span>}
                </span>
                <span class="field-hint">{field.hint}</span>
              </label>
            ))}
          </div>
          {error && (
            <p class="form-error" role="alert">
              {error}
            </p>
          )}
          <p class="field-hint">Everything else (breakers, budgets, aliases, model specs) lives in the configuration file below.</p>
        </div>
      )}
    </Panel>
  );
}

function BenchmarkPanel(): JSX.Element {
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<{ completed: number; total: number } | null>(null);
  const [results, setResults] = useState<BenchmarkResult[]>([]);
  const [summary, setSummary] = useState<BenchmarkSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const m = masker.value;

  const start = async () => {
    setRunning(true);
    setError(null);
    setSummary(null);
    setResults([]);
    try {
      await runBenchmark((event) => {
        if (event.type === "start") setProgress({ completed: 0, total: event.total });
        else if (event.type === "progress") {
          setProgress({ completed: event.completed, total: event.total });
          setResults((prev) => [...prev.filter((r) => r.account !== event.result.account), event.result]);
        } else if (event.type === "complete") {
          setResults(event.results);
          setSummary(event.summary);
        } else if (event.type === "error") setError(event.error);
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRunning(false);
    }
  };

  return (
    <Panel
      id="benchmark"
      title="Benchmark"
      subtitle="Send one small request through each active account and measure latency. Results are not saved."
      actions={
        <Button icon="play" loading={running} onClick={() => void start()}>
          {running ? `Running ${progress ? `${progress.completed}/${progress.total}` : "…"}` : "Run benchmark"}
        </Button>
      }
      flush
    >
      {error && (
        <div class="callout tone-bad panel-callout">
          <Icon name="critical" size={16} />
          <div>Benchmark failed: {error}</div>
        </div>
      )}
      {summary && (
        <div class="stats stats-inline">
          <span>
            <strong class="num">{summary.successRate.toFixed(0)}%</strong> succeeded
          </span>
          <span>
            <strong class="num">{formatMs(summary.averageLatencyMs)}</strong> avg latency
          </span>
          <span>
            <strong class="num">{formatMs(summary.averageTtfbMs)}</strong> avg first byte
          </span>
          {summary.averageTokensPerSecond !== null && (
            <span>
              <strong class="num">{summary.averageTokensPerSecond.toFixed(1)}</strong> tokens/s
            </span>
          )}
        </div>
      )}
      {results.length > 0 ? (
        <div class="table-scroll">
          <table class="table table-compact">
            <thead>
              <tr>
                <th scope="col">Account</th>
                <th scope="col">Result</th>
                <th scope="col" class="num-col">Latency</th>
                <th scope="col" class="num-col">First byte</th>
                <th scope="col" class="num-col hide-sm">Tokens/s</th>
              </tr>
            </thead>
            <tbody>
              {results.map((r) => (
                <tr key={r.account}>
                  <td>{m.name(r.account)}</td>
                  <td>
                    <Pill tone={r.status === "success" ? "ok" : r.status === "skipped" ? "warn" : "bad"}>
                      {r.status === "success" ? "OK" : r.status === "skipped" ? "Skipped" : "Failed"}
                    </Pill>
                    {r.error && <div class="cell-sub">{m.text(r.error)}</div>}
                  </td>
                  <td class="num num-col">{formatMs(r.latencyMs)}</td>
                  <td class="num num-col">{formatMs(r.ttfbMs)}</td>
                  <td class="num num-col hide-sm">{r.tokensPerSecond === null ? "—" : r.tokensPerSecond.toFixed(1)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        !running && !error && <p class="panel-note">No benchmark run in this session.</p>
      )}
    </Panel>
  );
}

function ConfigPanel(): JSX.Element {
  const [text, setText] = useState<string | null>(null);
  const [original, setOriginal] = useState("");
  const [status, setStatus] = useState<{ tone: "ok" | "bad" | "muted"; message: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const load = async () => {
    try {
      const config = await api.config();
      const json = JSON.stringify(config, null, 2);
      setText(json);
      setOriginal(json);
      setStatus({ tone: "muted", message: "Loaded the running configuration." });
    } catch (err) {
      setStatus({ tone: "bad", message: err instanceof Error ? err.message : String(err) });
    }
  };

  const parse = (): unknown | null => {
    try {
      return JSON.parse(text ?? "");
    } catch (err) {
      setStatus({ tone: "bad", message: `Not valid JSON: ${err instanceof Error ? err.message : String(err)}` });
      return null;
    }
  };

  const save = async () => {
    const parsed = parse();
    if (parsed === null) return;
    setSaving(true);
    try {
      await api.saveConfig(parsed);
      setOriginal(text ?? "");
      setStatus({ tone: "ok", message: "Saved and applied." });
      toast("Configuration saved", "success");
      void refreshSnapshot();
    } catch (err) {
      setStatus({ tone: "bad", message: err instanceof Error ? err.message : String(err) });
    } finally {
      setSaving(false);
    }
  };

  const importFile = async (file: File) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(await file.text());
    } catch {
      toast(`${file.name} is not valid JSON`, "error");
      return;
    }
    const ok = await confirmAction({
      title: `Import ${file.name}?`,
      body: "The imported file replaces the whole configuration, including every account. Export the current one first if you may need it.",
      confirmLabel: "Replace configuration",
      danger: true,
    });
    if (!ok) return;
    try {
      const result = await api.importConfig(parsed);
      toast(`Imported configuration with ${result.importedAccounts} accounts`, "success");
      if (text !== null) await load();
      void refreshSnapshot();
    } catch (err) {
      toast(`Import failed: ${err instanceof Error ? err.message : String(err)}`, "error");
    }
  };

  const dirty = text !== null && text !== original;

  return (
    <Panel
      id="config"
      title="Configuration file"
      subtitle="The full accounts.json the rotator runs with. It contains account credentials; keep it private."
      actions={
        <>
          <Button icon="download" onClick={() => downloadUrl("/api/config/export")}>
            Export
          </Button>
          <Button icon="upload" onClick={() => fileRef.current?.click()}>
            Import
          </Button>
          <input
            ref={fileRef}
            type="file"
            accept="application/json,.json"
            class="sr-only"
            tabIndex={-1}
            onChange={(e) => {
              const input = e.target as HTMLInputElement;
              const file = input.files?.[0];
              input.value = "";
              if (file) void importFile(file);
            }}
          />
        </>
      }
    >
      {masked.value ? (
        <EmptyState icon="eyeOff" title="Hidden while the privacy mask is on">
          The configuration includes emails and credentials.
        </EmptyState>
      ) : text === null ? (
        <div class="config-closed">
          <p class="muted">Edit the raw JSON for settings the forms above do not cover.</p>
          <Button icon="edit" onClick={() => void load()}>
            Open editor
          </Button>
          {status?.tone === "bad" && <p class="form-error">{status.message}</p>}
        </div>
      ) : (
        <div class="config-editor">
          <textarea
            class="code-input"
            spellcheck={false}
            aria-label="Configuration JSON"
            value={text}
            onInput={(e) => setText((e.target as HTMLTextAreaElement).value)}
          />
          <div class="config-actions">
            {status && <span class={`config-status tone-text-${status.tone}`}>{status.message}</span>}
            <span class="spacer" />
            <Button onClick={() => void load()} disabled={saving}>
              {dirty ? "Discard changes" : "Reload"}
            </Button>
            <Button variant="primary" loading={saving} disabled={!dirty} onClick={() => void save()}>
              Save
            </Button>
          </div>
        </div>
      )}
    </Panel>
  );
}

function AboutPanel(): JSX.Element {
  const data = overview.value!;
  const update = data.updateInfo;
  return (
    <Panel id="about" title="About">
      <KeyValue
        items={[
          ["Version", <span class="num">v{data.version}{update?.updateAvailable && update.latestVersion ? <Pill tone="info">{update.latestVersion} available</Pill> : null}</span>],
          ["Uptime", <span class="num">{formatDuration(now.value - data.startedAt)}</span>],
          ["Listening on", <span class="num">{data.security.bindHost}:{data.proxyPort}</span>],
          ["Admin token", data.security.adminTokenConfigured ? "Required for the dashboard and admin API" : "Not configured"],
          ["Request history", data.capabilities.database ? "PostgreSQL" : "In memory only (no DATABASE_URL)"],
        ]}
      />
      <div class="about-links">
        <a class="btn btn-secondary btn-md" href="https://github.com/tuxevil/tuxevil-rotator" target="_blank" rel="noopener noreferrer">
          <Icon name="github" /> GitHub
        </a>
        <a class="btn btn-secondary btn-md" href="https://github.com/tuxevil/tuxevil-rotator/issues" target="_blank" rel="noopener noreferrer">
          Report an issue
        </a>
        <a class="btn btn-secondary btn-md" href="https://tuxevil.com" target="_blank" rel="noopener noreferrer">
          <Icon name="globe" /> tuxevil.com
        </a>
        {authRequired.value && (
          <Button icon="logout" onClick={() => void signOut()}>
            Sign out
          </Button>
        )}
      </div>
      <div class="support-card">
        <Icon name="heart" size={18} />
        <div>
          <strong>Support the project</strong>
          <p>
            If the rotator saves you money on AI API costs, consider <a href="https://ko-fi.com/tuxevil" target="_blank" rel="noopener noreferrer">supporting it on Ko-fi</a>.
            Starring the repository, reporting bugs and sharing it with others helps too.
          </p>
        </div>
      </div>
    </Panel>
  );
}
