import { Fragment, type JSX } from "preact";
import { useEffect, useId, useRef, useState } from "preact/hooks";
import {
  Button,
  EmptyState,
  KeyValue,
  PageHeader,
  Panel,
  Pill,
  Segmented,
  Spinner,
  Switch,
  Tag,
} from "../components/ui.js";
import { Icon } from "../components/icons.js";
import { Menu, type MenuItem } from "../components/overlays.js";
import { confirmAction, toast } from "../state/actions.js";
import { api } from "../state/api.js";
import { query, setQuery } from "../state/router.js";
import { masked, masker, overview } from "../state/store.js";
import {
  currentDocument,
  initializePlayground,
  saveWorkspace,
  storageError,
  updateDocument,
  workspace,
} from "../state/playground.js";
import { PlaygroundError, runChat } from "../state/playground-client.js";
import {
  buildChatRequest,
  newTranscription,
  CASES,
  complianceRequest,
  DEFAULT_PARAMETERS,
  emptyResult,
  errorVerdict,
  evaluateCompliance,
  isAudioOnlyModel,
  newDocument,
  newId,
  newPanel,
  userMessage,
  VERDICT_LABELS,
  type CaseId,
  type ChatRequest,
  type ChatResult,
  type ComplianceResult,
  type ImageAttachment,
  type Parameters,
  type PlaygroundDocument,
  type PlaygroundPanel,
  type PlaygroundTab,
  type Turn,
  type Verdict,
} from "../lib/playground.js";
import { parsePlaygroundDocument } from "../lib/playground-storage.js";
import type { Tone } from "../lib/status.js";
import { TranscriptionPage } from "./Transcription.js";
import { copyText } from "./shared.js";
import { formatMs, formatUsd } from "../lib/format.js";

const TABS: Array<{ value: PlaygroundTab; label: string }> = [
  { value: "chat", label: "Chat" },
  { value: "compare", label: "Compare" },
  { value: "compliance", label: "Compliance" },
  { value: "transcription", label: "Transcription" },
];
const DESCRIPTION =
  "Chat with, compare and test models through the rotator. Requests use real quota.";
const MAX_COMPLIANCE_MODELS = 3;
const VERDICT_TONES: Record<Verdict, Tone> = {
  passed: "ok",
  failed: "bad",
  error: "bad",
  unsupported: "warn",
  cancelled: "muted",
};
const CANCELLED_MESSAGE = "Request cancelled.";
const errorText = (err: unknown): string =>
  err instanceof Error ? err.message : String(err);
/** Saved or imported selections may still hold an audio-only model; those
 * can't answer chat requests, so they are shown but never run. */
const runnableComplianceModels = (d: PlaygroundDocument): string[] =>
  d.complianceModels.filter((model) => !isAudioOnlyModel(model));
/** Seconds keep playgrounds saved in the same minute apart; under the privacy
 * mask every title reads "Saved playground". */
const savedAt = (ms: number): string =>
  new Date(ms).toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
const historyLabel = (d: PlaygroundDocument): string =>
  `${masked.value ? "Saved playground" : d.title} · ${savedAt(d.updatedAt)}`;
const copy = async (text: string): Promise<void> =>
  toast((await copyText(text)) ? "Copied to the clipboard" : "Copy failed", "info");
/** Times that were never measured (null, or 0 before a response) read "—";
 * formatMs alone turns null into "0ms". */
const duration = (ms: number | null | undefined): string =>
  ms ? formatMs(ms) : "—";

interface ComplianceProgress {
  done: number;
  total: number;
  retry: boolean;
}

export function PlaygroundPage(): JSX.Element {
  const doc = currentDocument();
  const requestedTab = query.value.get("tab");
  const tab: PlaygroundTab =
    requestedTab === "compare" ||
    requestedTab === "compliance" ||
    requestedTab === "transcription"
      ? requestedTab
      : "chat";
  // null until the first load settles, so "No enabled models" never flashes.
  const [models, setModels] = useState<string[] | null>(null);
  const [modelError, setModelError] = useState("");
  const [busy, setBusy] = useState<string[]>([]);
  const [checking, setChecking] = useState(false);
  const [progress, setProgress] = useState<ComplianceProgress | null>(null);
  const [finished, setFinished] = useState("");
  const [audioBusy, setAudioBusy] = useState(false);
  const [maxBodyBytes, setMaxBodyBytes] = useState(25 * 1024 * 1024);
  const controllers = useRef(new Map<string, AbortController>());
  const importRef = useRef<HTMLInputElement>(null);
  const imageRef = useRef<HTMLInputElement>(null);
  const routing = JSON.stringify([
    overview.value?.modelCatalogRevision,
    overview.value?.accounts.map((a) => [
      a.email,
      a.status,
      a.disabledProviders,
      a.invalidProviders,
    ]),
  ]);
  const running = checking || busy.length > 0 || audioBusy;
  const available = models ?? [];

  const loadModels = async () => {
    try {
      const response = await api.models();
      setModels([...new Set(response.data.map((m) => m.id))].sort());
      setModelError("");
    } catch (err) {
      setModelError(errorText(err));
    }
  };
  useEffect(() => {
    void initializePlayground();
  }, []);
  useEffect(() => {
    void loadModels();
  }, [routing]);
  useEffect(() => {
    void api
      .playgroundConfig()
      .then((config) => setMaxBodyBytes(config.maxBodyBytes))
      .catch(() => {});
    const active = controllers.current;
    return () => {
      for (const controller of active.values()) controller.abort();
    };
  }, []);

  function patchPanel(
    id: string,
    update: (panel: PlaygroundPanel) => PlaygroundPanel,
    immediate = false,
  ): void {
    updateDocument(
      (d) => ({
        ...d,
        chat: d.chat.id === id ? update(d.chat) : d.chat,
        compare: d.compare.map((p) => (p.id === id ? update(p) : p)),
      }),
      immediate,
    );
  }
  function changeParams(id: string, patch: Partial<Parameters>): void {
    updateDocument((d) => ({
      ...d,
      chat:
        d.chat.id === id
          ? { ...d.chat, params: { ...d.chat.params, ...patch } }
          : d.chat,
      compare: d.compare.map((p) =>
        p.id === id || (d.sync && d.compare.some((p) => p.id === id))
          ? { ...p, params: { ...p.params, ...patch } }
          : p,
      ),
    }));
  }
  function ensureSize(request: ChatRequest): void {
    if (new Blob([JSON.stringify(request)]).size > maxBodyBytes)
      throw new Error(
        `Request exceeds the server's ${(maxBodyBytes / 1024 / 1024).toFixed(1)} MiB limit. Remove images or start a new conversation.`,
      );
  }
  async function executePanel(
    panel: PlaygroundPanel,
    request: ChatRequest,
    retry: boolean,
  ): Promise<void> {
    const documentId = doc!.id;
    const controller = new AbortController();
    controllers.current.set(panel.id, controller);
    setBusy((ids) => [...ids, panel.id]);
    const turns = retry ? panel.turns.slice(0, -1) : panel.turns;
    const index = turns.length;
    patchPanel(panel.id, (p) => ({
      ...p,
      turns: [...turns, { request, result: null }],
    }));
    const setTurn = (result: ChatResult, error?: string) => {
      if (currentDocument()?.id !== documentId) return;
      patchPanel(
        panel.id,
        (p) => ({
          ...p,
          turns: p.turns.map((turn, i) =>
            i === index
              ? { request, result, ...(error ? { error } : {}) }
              : turn,
          ),
        }),
        result.done || !!error,
      );
    };
    try {
      setTurn(
        await runChat(request, controller.signal, (result) => setTurn(result)),
      );
    } catch (err) {
      if (err instanceof PlaygroundError) setTurn(err.result, err.message);
      else toast(errorText(err), "error");
    } finally {
      controllers.current.delete(panel.id);
      setBusy((ids) => ids.filter((id) => id !== panel.id));
    }
  }
  async function send(retryPanel?: PlaygroundPanel): Promise<void> {
    if (!doc) return;
    try {
      const panels = retryPanel
        ? [retryPanel]
        : tab === "compare"
          ? doc.compare
          : [doc.chat];
      const next = userMessage(doc.draft, doc.images);
      if (!retryPanel && !doc.draft.trim() && !doc.images.length) return;
      const requests = panels.map((panel) => {
        if (!available.includes(panel.model))
          throw new Error("Choose an enabled model in every panel.");
        const lastRequest = panel.turns.at(-1)?.request;
        const message =
          retryPanel && lastRequest
            ? lastRequest.messages[lastRequest.messages.length - 1]
            : next;
        const request = buildChatRequest(panel, message, !!retryPanel);
        ensureSize(request);
        return request;
      });
      if (!retryPanel)
        updateDocument((d) => ({
          ...d,
          draft: "",
          images: [],
          title:
            d.title === "Untitled playground"
              ? doc.draft.trim().slice(0, 60) || "Image conversation"
              : d.title,
        }));
      await Promise.all(
        panels.map((panel, i) =>
          executePanel(panel, requests[i], !!retryPanel),
        ),
      );
    } catch (err) {
      toast(errorText(err), "error");
    }
  }
  async function attach(files: File[]): Promise<void> {
    const documentId = doc?.id;
    try {
      const attachments: ImageAttachment[] = [];
      if (
        files.some(
          (file) =>
            !["image/png", "image/jpeg", "image/webp"].includes(file.type),
        )
      )
        throw new Error("Choose PNG, JPEG or WebP images.");
      if (
        (files.reduce((sum, file) => sum + file.size, 0) * 4) / 3 >
        maxBodyBytes
      )
        throw new Error("Images exceed the request size limit.");
      for (const file of files) {
        const url = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result));
          reader.onerror = () => reject(reader.error);
          reader.readAsDataURL(file);
        });
        attachments.push({ name: file.name, url });
      }
      if (currentDocument()?.id === documentId)
        updateDocument((d) => ({
          ...d,
          images: [...d.images, ...attachments],
        }));
    } catch (err) {
      toast(errorText(err), "error");
    }
  }
  function newPlayground(): void {
    const fresh = newDocument();
    saveWorkspace(
      {
        ...workspace.value!,
        currentId: fresh.id,
        documents: [...workspace.value!.documents, fresh],
      },
      true,
    );
  }
  function exportDoc(): void {
    if (!doc) return;
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(doc, null, 2)], { type: "application/json" }),
    );
    const a = document.createElement("a");
    a.href = url;
    a.download = `playground-${doc.id}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  async function importDoc(file: File): Promise<void> {
    try {
      if (file.size > 100 * 1024 * 1024)
        throw new Error("Playground imports must be smaller than 100 MiB.");
      const imported = parsePlaygroundDocument(JSON.parse(await file.text()));
      const state = workspace.value!;
      const restored = { ...imported, id: newId(), updatedAt: Date.now() };
      saveWorkspace(
        {
          ...state,
          currentId: restored.id,
          documents: [...state.documents, restored],
        },
        true,
      );
      toast("Imported playground. No requests were sent.", "success");
    } catch (err) {
      toast(errorText(err), "error");
    }
  }
  async function deleteHistory(all: boolean): Promise<void> {
    if (!doc || !workspace.value) return;
    if (
      !(await confirmAction({
        title: all
          ? "Delete all playground history?"
          : "Delete this playground?",
        body: "This removes the local copy from this browser. Export anything you want to keep first.",
        confirmLabel: "Delete",
        danger: true,
      }))
    )
      return;
    const remaining = all
      ? []
      : workspace.value.documents.filter((d) => d.id !== doc.id);
    if (!remaining.length) remaining.push(newDocument());
    saveWorkspace(
      { version: 1, currentId: remaining[0].id, documents: remaining },
      true,
    );
  }
  async function runCompliance(retry = false): Promise<void> {
    if (!doc || !runnableComplianceModels(doc).length || !doc.cases.length)
      return;
    const documentId = doc.id;
    const failed = doc.results.filter(
      (r) => r.verdict === "failed" || r.verdict === "error",
    );
    const jobs = runnableComplianceModels(doc).map((model) => ({
      model,
      cases: doc.cases.filter(
        (caseId) =>
          !retry ||
          failed.some((r) => r.model === model && r.caseId === caseId),
      ),
    }));
    if (jobs.some((job) => !available.includes(job.model))) {
      toast("Select enabled models before running compliance.", "error");
      return;
    }
    const jobKey = (model: string, caseId: CaseId) =>
      JSON.stringify([model, caseId]);
    const selected = new Set(
      jobs.flatMap((job) =>
        job.cases.map((caseId) => jobKey(job.model, caseId)),
      ),
    );
    updateDocument((d) => ({
      ...d,
      results: retry
        ? d.results.filter((r) => !selected.has(jobKey(r.model, r.caseId)))
        : [],
    }));
    let done = 0;
    setFinished("");
    setProgress({ done, total: selected.size, retry });
    setChecking(true);
    try {
      await Promise.all(
        jobs.map(async ({ model, cases }) => {
          const controller = new AbortController();
          controllers.current.set(`compliance:${model}`, controller);
          try {
            for (const caseId of cases) {
              const request = complianceRequest(model, caseId);
              let row: ComplianceResult;
              try {
                if (controller.signal.aborted)
                  throw new PlaygroundError(
                    CANCELLED_MESSAGE,
                    emptyResult(),
                    true,
                  );
                const result = await runChat(request, controller.signal);
                row = {
                  model,
                  caseId,
                  ...evaluateCompliance(caseId, result),
                  turn: { request, result },
                };
              } catch (err) {
                row = {
                  model,
                  caseId,
                  verdict:
                    err instanceof PlaygroundError && err.cancelled
                      ? "cancelled"
                      : errorVerdict(
                          err instanceof PlaygroundError
                            ? err.result.status
                            : 0,
                          errorText(err),
                        ),
                  explanation: errorText(err),
                  turn: {
                    request,
                    result: err instanceof PlaygroundError ? err.result : null,
                    error: errorText(err),
                  },
                };
              }
              if (currentDocument()?.id === documentId)
                updateDocument((d) => ({ ...d, results: [...d.results, row] }));
              done += 1;
              setProgress({ done, total: selected.size, retry });
            }
          } finally {
            controllers.current.delete(`compliance:${model}`);
          }
        }),
      );
    } finally {
      setChecking(false);
      setProgress(null);
      const latest = currentDocument();
      if (latest?.id === documentId) {
        const passed = latest.results.filter(
          (r) => r.verdict === "passed",
        ).length;
        setFinished(
          `Compliance run finished: ${passed} of ${latest.results.length} tests passed.`,
        );
      }
    }
  }

  if (!doc)
    return (
      <>
        <PageHeader title="Playground" description={DESCRIPTION} />
        <div class="panel">
          <div class="panel-loading">
            <Spinner />
          </div>
        </div>
      </>
    );

  const compare = tab === "compare";
  const stopAll = running && (
    <Button
      size="sm"
      icon="stop"
      onClick={() => {
        for (const c of controllers.current.values()) c.abort();
      }}
    >
      Stop all
    </Button>
  );
  const selectedCount = doc.complianceModels.length;
  const testCount = runnableComplianceModels(doc).length * doc.cases.length;
  const failedCount = doc.results.filter(
    (r) => r.verdict === "failed" || r.verdict === "error",
  ).length;
  const progressLabel = progress
    ? `Running ${progress.done}/${progress.total}`
    : "";

  return (
    <>
      <PageHeader
        title="Playground"
        description={DESCRIPTION}
        actions={
          <>
            <label class="inline-select pg-history">
              <span class="sr-only">Saved playground</span>
              <select
                class="select"
                title={historyLabel(doc)}
                disabled={running}
                value={doc.id}
                onChange={(e) =>
                  saveWorkspace(
                    { ...workspace.value!, currentId: e.currentTarget.value },
                    true,
                  )
                }
              >
                {workspace.value!.documents.map((d) => (
                  <option key={d.id} value={d.id}>
                    {historyLabel(d)}
                  </option>
                ))}
              </select>
            </label>
            <Menu
              label="More playground actions"
              size="md"
              triggerClass="btn btn-secondary btn-md btn-icon"
              items={[
                { heading: "Saved in this browser" },
                { label: "Export", icon: "download", onSelect: exportDoc },
                {
                  label: "Import…",
                  icon: "upload",
                  disabled: running,
                  onSelect: () => importRef.current?.click(),
                },
                "separator",
                {
                  label: "Delete this playground…",
                  icon: "trash",
                  danger: true,
                  disabled: running,
                  onSelect: () => void deleteHistory(false),
                },
                {
                  label: "Delete all history…",
                  danger: true,
                  disabled: running,
                  onSelect: () => void deleteHistory(true),
                },
              ]}
            />
            <Button
              variant="primary"
              icon="plus"
              class="pg-new"
              disabled={running}
              onClick={newPlayground}
            >
              New playground
            </Button>
            <input
              ref={importRef}
              type="file"
              accept="application/json,.json"
              class="sr-only"
              aria-label="Import playground"
              onChange={(e) => {
                const file = e.currentTarget.files?.[0];
                e.currentTarget.value = "";
                if (file) void importDoc(file);
              }}
            />
          </>
        }
      />
      {storageError.value && (
        <div class="callout tone-warn" role="alert">
          <Icon name="warning" size={16} />
          <div>
            <strong>Local history could not be saved</strong>
            <p>
              Your work is still in memory; export it to keep it.{" "}
              {masker.value.text(storageError.value)}
            </p>
            <Button size="sm" icon="download" onClick={exportDoc}>
              Export
            </Button>
          </div>
        </div>
      )}
      {modelError && (
        <div class="callout tone-bad" role="alert">
          <Icon name="critical" size={16} />
          <div>
            <strong>Could not load models</strong>
            <p>{modelError}</p>
            <Button size="sm" icon="refresh" onClick={() => void loadModels()}>
              Reload models
            </Button>
          </div>
        </div>
      )}
      <div class="toolbar">
        <Segmented
          class="pg-modes"
          label="Playground mode"
          value={tab}
          options={TABS}
          onChange={(value) => setQuery({ tab: value }, { replace: false })}
        />
        {(running || compare) && (
          <div class="toolbar-right">
            {stopAll}
            {compare && (
              <>
                <Switch
                  label="Same parameters for all models"
                  checked={doc.sync}
                  disabled={running}
                  onChange={(on) =>
                    updateDocument((d) => ({
                      ...d,
                      sync: on,
                      compare: on
                        ? d.compare.map((p) => ({
                            ...p,
                            params: { ...d.compare[0].params },
                          }))
                        : d.compare,
                    }))
                  }
                />
                {doc.compare.length < 3 && (
                  <Button
                    size="sm"
                    icon="plus"
                    disabled={running}
                    onClick={() =>
                      updateDocument((d) => ({
                        ...d,
                        compare: [
                          ...d.compare,
                          {
                            ...newPanel(),
                            params: d.sync
                              ? { ...d.compare[0].params }
                              : { ...newPanel().params },
                          },
                        ],
                      }))
                    }
                  >
                    Add model
                  </Button>
                )}
              </>
            )}
          </div>
        )}
      </div>
      {models && !models.length && (
        <div class="panel">
          <EmptyState
            icon="models"
            title="No enabled models"
            action={
              <Button icon="refresh" onClick={() => void loadModels()}>
                Reload models
              </Button>
            }
          >
            Connect a provider and enable models on the Models page, then
            reload the catalog.
          </EmptyState>
        </div>
      )}
      {models === null && !modelError ? (
        <div class="panel">
          <div class="panel-loading">
            <Spinner />
          </div>
        </div>
      ) : tab === "transcription" ? (
        <TranscriptionPage
          key={doc.id}
          state={doc.transcription ?? newTranscription()}
          models={available}
          maxBodyBytes={maxBodyBytes}
          disabled={checking || busy.length > 0}
          onBusyChange={setAudioBusy}
          controllers={controllers.current}
          onChange={(update) =>
            updateDocument(
              (d) => ({
                ...d,
                transcription: update(d.transcription ?? newTranscription()),
              }),
              true,
            )
          }
        />
      ) : tab === "compliance" ? (
        <>
          <Panel
            title="API compliance"
            subtitle="Checks Chat Completions behavior through the rotator. Select up to three models. Uses real quota."
            actions={
              <>
                <span class="sr-only" role="status">
                  {progress
                    ? `Running ${progress.done} of ${progress.total} tests`
                    : finished}
                </span>
                <Button
                  icon="refresh"
                  loading={!!progress?.retry}
                  disabled={running || !failedCount}
                  onClick={() => void runCompliance(true)}
                >
                  {progress?.retry ? progressLabel : "Retry failed"}
                </Button>
                <Button
                  variant="primary"
                  icon="play"
                  loading={!!progress && !progress.retry}
                  disabled={running || !testCount}
                  onClick={() => void runCompliance()}
                >
                  {progress && !progress.retry
                    ? progressLabel
                    : testCount
                      ? `Run ${testCount} ${testCount === 1 ? "test" : "tests"}`
                      : "Run tests"}
                </Button>
              </>
            }
          >
            <div class="form pg-picker">
              <div class="field">
                <div class="field-label-row">
                  <span class="field-label">Models</span>
                  <span class="muted">
                    {selectedCount} of {MAX_COMPLIANCE_MODELS} selected
                  </span>
                  <span class="spacer" />
                  {selectedCount > 0 && !running && (
                    <button
                      type="button"
                      class="link-button"
                      onClick={() =>
                        updateDocument((d) => ({ ...d, complianceModels: [] }))
                      }
                    >
                      Clear
                    </button>
                  )}
                </div>
                <div
                  class="model-groups"
                  role="group"
                  aria-label="Compliance models"
                >
                  <div class="model-grid">
                    {[...new Set([...available, ...doc.complianceModels])].map(
                      (model) => {
                        const checked = doc.complianceModels.includes(model);
                        const audioOnly = isAudioOnlyModel(model);
                        return (
                          <label key={model} class="checkbox model-option">
                            <input
                              type="checkbox"
                              checked={checked}
                              disabled={
                                running ||
                                (!checked &&
                                  (audioOnly ||
                                    selectedCount >= MAX_COMPLIANCE_MODELS))
                              }
                              onChange={(e) =>
                                updateDocument((d) => ({
                                  ...d,
                                  complianceModels: e.currentTarget.checked
                                    ? [...d.complianceModels, model]
                                    : d.complianceModels.filter(
                                        (m) => m !== model,
                                      ),
                                }))
                              }
                            />
                            <span class="truncate" title={model}>
                              {model}
                            </span>
                            {!available.includes(model) ? (
                              <Pill tone="warn" dot={false}>
                                Unavailable
                              </Pill>
                            ) : (
                              audioOnly && (
                                <Pill tone="muted" dot={false}>
                                  Audio only
                                </Pill>
                              )
                            )}
                          </label>
                        );
                      },
                    )}
                  </div>
                </div>
              </div>
              <div class="field">
                <div class="field-label-row">
                  <span class="field-label">Tests</span>
                </div>
                <div
                  class="model-groups"
                  role="group"
                  aria-label="Compliance tests"
                >
                  <div class="model-grid">
                    {CASES.map((c) => (
                      <label key={c.id} class="checkbox model-option">
                        <input
                          type="checkbox"
                          disabled={running}
                          checked={doc.cases.includes(c.id)}
                          onChange={(e) =>
                            updateDocument((d) => ({
                              ...d,
                              cases: e.currentTarget.checked
                                ? [...d.cases, c.id]
                                : d.cases.filter((id) => id !== c.id),
                            }))
                          }
                        />
                        <span class="truncate" title={c.label}>
                          {c.label}
                        </span>
                      </label>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          </Panel>
          <Panel title="Results" flush>
            <ComplianceResults results={doc.results} running={checking} />
          </Panel>
        </>
      ) : (
        <>
          {compare ? (
            <div class={`pg-compare pg-compare-${doc.compare.length}`}>
              {doc.compare.map((panel, i) => (
                <ConversationPanel
                  key={panel.id}
                  panel={panel}
                  label={`Model ${i + 1}`}
                  compare
                  models={available}
                  busy={busy.includes(panel.id)}
                  running={running}
                  onModel={(model) =>
                    patchPanel(panel.id, (p) => ({ ...p, model, turns: [] }))
                  }
                  onParams={(patch) => changeParams(panel.id, patch)}
                  onRetry={() => void send(panel)}
                  onClear={() =>
                    patchPanel(panel.id, (p) => ({ ...p, turns: [] }))
                  }
                  onRemove={
                    doc.compare.length > 2
                      ? () => {
                          updateDocument((d) => ({
                            ...d,
                            compare: d.compare.filter((p) => p.id !== panel.id),
                          }));
                          // The removed column took focus with it; move to
                          // the model select of the column now in its place.
                          requestAnimationFrame(() => {
                            const selects = document.querySelectorAll<HTMLElement>(
                              ".pg-compare .pg-model select",
                            );
                            selects[Math.min(i, selects.length - 1)]?.focus();
                          });
                        }
                      : undefined
                  }
                  onStop={() => controllers.current.get(panel.id)?.abort()}
                />
              ))}
            </div>
          ) : (
            <ConversationPanel
              key={doc.chat.id}
              panel={doc.chat}
              label="Model"
              compare={false}
              models={available}
              busy={busy.includes(doc.chat.id)}
              running={running}
              onModel={(model) =>
                patchPanel(doc.chat.id, (p) => ({ ...p, model, turns: [] }))
              }
              onParams={(patch) => changeParams(doc.chat.id, patch)}
              onRetry={() => void send(doc.chat)}
              onClear={() =>
                patchPanel(doc.chat.id, (p) => ({ ...p, turns: [] }))
              }
              onStop={() => controllers.current.get(doc.chat.id)?.abort()}
            />
          )}
          <form
            class="panel pg-composer"
            onSubmit={(e) => {
              e.preventDefault();
              if (!running) void send();
            }}
          >
            <div class="panel-body">
              <textarea
                class="input"
                rows={3}
                aria-label={compare ? "Message all models" : "Message"}
                placeholder={
                  compare
                    ? "Message all models…"
                    : "Ask a question or attach an image…"
                }
                value={doc.draft}
                disabled={running}
                onInput={(e) =>
                  updateDocument((d) => ({
                    ...d,
                    draft: e.currentTarget.value,
                  }))
                }
              />
              {!!doc.images.length && (
                <div class="pg-attachments">
                  {doc.images.map((image, i) => (
                    <div key={i} class="pg-attachment">
                      {masked.value ? (
                        <Icon name="image" size={20} />
                      ) : (
                        <img src={image.url} alt={image.name} />
                      )}
                      <Button
                        variant="ghost"
                        size="sm"
                        icon="x"
                        iconOnly
                        disabled={running}
                        onClick={() =>
                          updateDocument((d) => ({
                            ...d,
                            images: d.images.filter((_, index) => i !== index),
                          }))
                        }
                      >
                        {`Remove ${masked.value ? "image" : image.name}`}
                      </Button>
                    </div>
                  ))}
                </div>
              )}
              <div class="pg-composer-foot">
                <Button
                  icon="image"
                  title="Requires a vision model"
                  disabled={running}
                  onClick={() => imageRef.current?.click()}
                >
                  Attach images
                </Button>
                <input
                  ref={imageRef}
                  type="file"
                  multiple
                  accept="image/png,image/jpeg,image/webp"
                  class="sr-only"
                  aria-label="Attach images"
                  onChange={(e) => {
                    const files = Array.from(e.currentTarget.files ?? []);
                    e.currentTarget.value = "";
                    void attach(files);
                  }}
                />
                <span class="spacer" />
                <Button
                  variant="primary"
                  type="submit"
                  disabled={
                    running ||
                    !available.length ||
                    (!doc.draft.trim() && !doc.images.length)
                  }
                >
                  {compare ? "Send to all" : "Send"}
                </Button>
              </div>
            </div>
          </form>
        </>
      )}
    </>
  );
}

/** Chat's "Conversation" panel and each Compare column. */
function ConversationPanel({
  panel,
  label,
  compare,
  models,
  busy,
  running,
  onModel,
  onParams,
  onRetry,
  onClear,
  onRemove,
  onStop,
}: {
  panel: PlaygroundPanel;
  /** Accessible name of the model select ("Model", "Model 1", …). */
  label: string;
  compare: boolean;
  models: string[];
  busy: boolean;
  running: boolean;
  onModel: (model: string) => void;
  onParams: (patch: Partial<Parameters>) => void;
  onRetry: () => void;
  onClear: () => void;
  onRemove?: () => void;
  onStop: () => void;
}): JSX.Element {
  const [paramsOpen, setParamsOpen] = useState(false);
  const turnsRef = useRef<HTMLDivElement>(null);
  const paramsId = `pg-params-${panel.id}`;
  const tags = parameterTags(panel.params);
  const idle = running || !panel.turns.length;
  const items: MenuItem[] = [
    {
      label: "Retry last turn",
      icon: "refresh",
      disabled: idle,
      onSelect: onRetry,
    },
    { label: "Clear conversation", icon: "x", disabled: idle, onSelect: onClear },
  ];
  if (onRemove)
    items.push("separator", {
      label: "Remove model",
      icon: "trash",
      danger: true,
      disabled: running,
      onSelect: onRemove,
    });
  const actions = (
    <>
      <label class="pg-model">
        <span class="sr-only">{label}</span>
        <select
          class="select"
          title={panel.model || "Choose a model"}
          disabled={running}
          value={panel.model}
          onChange={(e) => onModel(e.currentTarget.value)}
        >
          <option value="">Choose a model</option>
          {panel.model && !models.includes(panel.model) && (
            <option value={panel.model}>{panel.model} (unavailable)</option>
          )}
          {models.map((model) => (
            <option value={model} key={model}>
              {model}
            </option>
          ))}
        </select>
      </label>
      {compare && busy && (
        <Button
          size="sm"
          icon="stop"
          class="pg-collapsible"
          title={`Stop ${label}`}
          aria-label={`Stop ${label}`}
          onClick={onStop}
        >
          Stop
        </Button>
      )}
      <Button
        variant="ghost"
        size="sm"
        icon="settings"
        class="pg-collapsible"
        title="Parameters"
        aria-label={compare ? `${label} parameters` : undefined}
        aria-expanded={paramsOpen}
        aria-controls={paramsOpen ? paramsId : undefined}
        onClick={() => setParamsOpen(!paramsOpen)}
      >
        Parameters
      </Button>
      <Menu
        label={compare ? `${label} actions` : "Conversation actions"}
        items={items}
        disabled={
          !items.some(
            (item) =>
              typeof item === "object" && "onSelect" in item && !item.disabled,
          )
        }
      />
    </>
  );
  return (
    <Panel
      class="pg-panel"
      title={compare ? undefined : "Conversation"}
      actions={actions}
    >
      {tags.length > 0 && (
        <span class="tag-row">
          {tags.map((tag) => (
            <Tag key={tag}>{tag}</Tag>
          ))}
        </span>
      )}
      {paramsOpen && (
        <div id={paramsId} class="pg-params">
          <ParameterEditor
            params={panel.params}
            disabled={running}
            onChange={onParams}
          />
        </div>
      )}
      <div
        ref={turnsRef}
        class="pg-turns"
        tabIndex={-1}
        aria-live="polite"
        aria-busy={busy}
      >
        {panel.turns.length ? (
          panel.turns.map((turn, i) => (
            <TurnView
              key={i}
              turn={turn}
              detailsLabel={
                compare
                  ? `${label}, turn ${i + 1} details`
                  : `Turn ${i + 1} details`
              }
              onRetry={
                i === panel.turns.length - 1 && !busy
                  ? () => {
                      // The callout holding Retry is replaced by the new
                      // turn; keep focus in this conversation.
                      turnsRef.current?.focus({ preventScroll: true });
                      onRetry();
                    }
                  : undefined
              }
              running={running}
            />
          ))
        ) : (
          <EmptyState icon="play" title="No messages yet">
            Send a message to test this model.
          </EmptyState>
        )}
      </div>
    </Panel>
  );
}

/** Parameters that differ from a new panel, shown as tags in the panel body. */
function parameterTags(params: Parameters): string[] {
  const tags: string[] = [];
  if (params.system.trim()) tags.push("System prompt");
  if (params.temperature !== DEFAULT_PARAMETERS.temperature)
    tags.push(`Temperature ${params.temperature}`);
  if (params.maxTokens !== DEFAULT_PARAMETERS.maxTokens)
    tags.push(
      params.maxTokens ? `Max tokens ${params.maxTokens}` : "No max tokens",
    );
  if (params.effort) tags.push(`Reasoning ${params.effort}`);
  if (params.tools.trim()) tags.push("Tools");
  if (params.stream !== DEFAULT_PARAMETERS.stream)
    tags.push(params.stream ? "Streaming" : "Streaming off");
  return tags;
}

function ParameterEditor({
  params,
  disabled,
  onChange,
}: {
  params: Parameters;
  disabled: boolean;
  onChange: (patch: Partial<Parameters>) => void;
}): JSX.Element {
  const id = useId();
  return (
    <div class="form">
      <label class="field">
        <span class="field-label">System prompt</span>
        <textarea
          class="input"
          rows={3}
          placeholder="Optional instructions sent before every message"
          disabled={disabled}
          value={params.system}
          onInput={(e) => onChange({ system: e.currentTarget.value })}
        />
      </label>
      <div class="form-grid">
        <label class="field">
          <span class="field-label">Temperature</span>
          <input
            class="input"
            type="number"
            min="0"
            max="2"
            step="0.1"
            placeholder="Provider default"
            disabled={disabled}
            value={params.temperature}
            onInput={(e) => onChange({ temperature: e.currentTarget.value })}
          />
        </label>
        <label class="field">
          <span class="field-label">Max tokens</span>
          <input
            class="input"
            type="number"
            min="1"
            step="1"
            placeholder="Provider default"
            disabled={disabled}
            value={params.maxTokens}
            onInput={(e) => onChange({ maxTokens: e.currentTarget.value })}
          />
        </label>
        <label class="field">
          <span class="field-label">Reasoning effort</span>
          <select
            class="select"
            disabled={disabled}
            value={params.effort}
            onChange={(e) => onChange({ effort: e.currentTarget.value })}
          >
            <option value="">Provider default</option>
            {["minimal", "low", "medium", "high", "xhigh"].map((effort) => (
              <option key={effort} value={effort}>
                {effort}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div class="field">
        <label class="field-label" for={`${id}-tools`}>
          Tools JSON (optional)
        </label>
        <textarea
          id={`${id}-tools`}
          class="code-input"
          rows={4}
          spellcheck={false}
          aria-describedby={`${id}-tools-hint`}
          placeholder='[{"type":"function","function":{"name":"example","parameters":{"type":"object"}}}]'
          disabled={disabled}
          value={params.tools}
          onInput={(e) => onChange({ tools: e.currentTarget.value })}
        />
        <span class="field-hint" id={`${id}-tools-hint`}>
          Sent as entered; support depends on the model. Tool calls are shown,
          not executed.
        </span>
      </div>
      <Switch
        label="Stream response"
        checked={params.stream}
        disabled={disabled}
        onChange={(on) => onChange({ stream: on })}
      />
    </div>
  );
}

function TurnView({
  turn,
  detailsLabel,
  onRetry,
  running,
}: {
  turn: Turn;
  /** Accessible name of the Details toggle ("Turn 2 details", …). */
  detailsLabel: string;
  /** Offered on a failed last turn. */
  onRetry?: () => void;
  running: boolean;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const result = turn.result;
  const lastMessage = turn.request.messages.at(-1)?.content;
  const m = masker.value;
  const content =
    typeof lastMessage === "string"
      ? [{ type: "text" as const, text: lastMessage }]
      : (lastMessage ?? []);
  const images = content.flatMap((part) =>
    part.type === "image_url" ? [part.image_url.url] : [],
  );
  return (
    <article class="pg-turn">
      <div class="pg-user">
        <span class="field-label">You</span>
        {content.map(
          (part, i) =>
            part.type === "text" && (
              <p key={i} class="pg-message">
                {m.text(part.text)}
              </p>
            ),
        )}
        {!!images.length && (
          <div class="pg-attachments">
            {images.map((url, i) => (
              <div key={i} class="pg-attachment">
                {masked.value ? (
                  <>
                    <Icon name="image" size={20} />
                    <span class="sr-only">Image hidden</span>
                  </>
                ) : (
                  <img src={url} alt="Attached image" />
                )}
              </div>
            ))}
          </div>
        )}
      </div>
      <div class="pg-assistant">
        <span class="field-label">Assistant</span>
        {result?.reasoning && (
          <div
            class="pg-reasoning"
            tabIndex={0}
            role="region"
            aria-label="Reasoning"
          >
            {m.text(result.reasoning)}
          </div>
        )}
        {result?.content ? (
          <p class="pg-message">{m.text(result.content)}</p>
        ) : (
          !turn.error &&
          !result?.tools.length && (
            <p class="pg-message muted">
              {result?.done ? "Empty response." : "Waiting for response…"}
            </p>
          )
        )}
        {!!result?.tools.length && (
          <>
            <span class="field-label">Tool calls (not executed)</span>
            <pre class="code">
              {m.text(JSON.stringify(result.tools, null, 2))}
            </pre>
          </>
        )}
        {turn.error && (
          <div class="callout tone-bad" role="alert">
            <Icon name="critical" size={16} />
            <div>
              <strong>
                {turn.error === CANCELLED_MESSAGE
                  ? "Request stopped"
                  : "Request failed"}
              </strong>
              <p>{m.text(turn.error)}</p>
              {onRetry && (
                <Button
                  size="sm"
                  icon="refresh"
                  disabled={running}
                  onClick={onRetry}
                >
                  Retry
                </Button>
              )}
            </div>
          </div>
        )}
        <div class="pg-turn-foot">
          {result && <Metrics result={result} class="pg-metrics" />}
          <Button
            variant="ghost"
            size="sm"
            icon={open ? "chevronDown" : "chevronRight"}
            aria-label={detailsLabel}
            aria-expanded={open}
            onClick={() => setOpen(!open)}
          >
            Details
          </Button>
        </div>
        {open && <TurnInspector turn={turn} />}
      </div>
    </article>
  );
}

function Metrics({
  result,
  class: className,
}: {
  result: ChatResult;
  class?: string;
}): JSX.Element {
  const cost = Number(result.metadata["x-rotator-cost-usd"] ?? NaN);
  return (
    <div class={`inspector-meta${className ? ` ${className}` : ""}`}>
      <span>Total {duration(result.durationMs)}</span>
      <span>First content {duration(result.firstContentMs)}</span>
      <span>
        Tokens {result.inputTokens ?? "—"} / {result.outputTokens ?? "—"}
      </span>
      <span>Finish {result.finishReason ?? "—"}</span>
      <span>
        List-price value {Number.isFinite(cost) ? formatUsd(cost) : "—"}
      </span>
    </div>
  );
}

const INSPECTOR_TABS = [
  { value: "request", label: "Request" },
  { value: "response", label: "Response" },
  { value: "routing", label: "Routing" },
] as const;
type InspectorTab = (typeof INSPECTOR_TABS)[number]["value"];

/** Inline image data would swamp the preview; keep a recognizable prefix. */
const omitImageData = (_: string, value: unknown): unknown =>
  typeof value === "string" && value.startsWith("data:image/")
    ? `${value.slice(0, 45)}… [image data omitted from preview]`
    : value;

/** Request / Response / Routing payloads, as in the Requests inspector. */
function TurnInspector({
  turn,
  meta,
  note,
}: {
  turn: Turn;
  /** Repeat the turn metrics above the tabs (table rows have no room). */
  meta?: boolean;
  /** A line above everything else, such as a compliance explanation. */
  note?: string;
}): JSX.Element {
  const [tab, setTab] = useState<InspectorTab>("request");
  const result = turn.result;
  const metrics = (
    <>
      {note && <p>{note}</p>}
      {meta && result && <Metrics result={result} />}
    </>
  );
  // The turn list is a polite live region; raw JSON must not be read out
  // when Details opens or a tab switches.
  if (masked.value)
    return (
      <div class="inspector" aria-live="off">
        {metrics}
        <p class="muted">Raw details hidden while the privacy mask is on.</p>
      </div>
    );
  const raw = result?.raw ?? [];
  const routing = Object.entries(result?.metadata ?? {});
  const payload =
    tab === "request"
      ? turn.request
      : tab === "response"
        ? raw.length > 1
          ? raw
          : raw[0]
        : routing.length
          ? result?.metadata
          : undefined;
  const text =
    payload === undefined ? "" : JSON.stringify(payload, omitImageData, 2);
  // Copy keeps inline images so a copied request can be replayed as is.
  const full = payload === undefined ? "" : JSON.stringify(payload, null, 2);
  return (
    <div class="inspector" aria-live="off">
      {metrics}
      <div class="tabs tabs-sm" role="tablist" aria-label="Turn details">
        {INSPECTOR_TABS.map((t) => (
          <button
            key={t.value}
            type="button"
            role="tab"
            aria-selected={tab === t.value}
            class={tab === t.value ? "is-active" : undefined}
            onClick={() => setTab(t.value)}
          >
            {t.label}
          </button>
        ))}
        <span class="tabs-spacer" />
        <Button
          size="sm"
          variant="ghost"
          icon="copy"
          disabled={!text}
          onClick={() => void copy(full)}
        >
          Copy
        </Button>
      </div>
      {!text ? (
        <p class="muted">Nothing recorded.</p>
      ) : tab === "routing" ? (
        <KeyValue items={routing.map(([key, value]) => [key, value])} />
      ) : (
        <pre class="code">{text}</pre>
      )}
    </div>
  );
}

const SUMMARY: Array<[Verdict, string, string]> = [
  ["passed", "passed", "passed"],
  ["failed", "failed", "failed"],
  ["unsupported", "not supported", "not supported"],
  ["error", "error", "errors"],
  ["cancelled", "cancelled", "cancelled"],
];

function ComplianceResults({
  results,
  running,
}: {
  results: ComplianceResult[];
  running: boolean;
}): JSX.Element {
  const [open, setOpen] = useState<string | null>(null);
  const m = masker.value;
  if (!results.length)
    return running ? (
      <div class="panel-loading">
        <Spinner />
      </div>
    ) : (
      <EmptyState icon="checkCircle" title="No results yet">
        Choose models and tests, then run them.
      </EmptyState>
    );
  const counts = new Map<Verdict, number>();
  for (const r of results)
    counts.set(r.verdict, (counts.get(r.verdict) ?? 0) + 1);
  // Parallel runs finish out of order; group by model, then test order.
  const order = CASES.map((c) => c.id);
  const rows = results
    .map((row, index) => ({ row, index }))
    .sort(
      (a, b) =>
        a.row.model.localeCompare(b.row.model) ||
        order.indexOf(a.row.caseId) - order.indexOf(b.row.caseId) ||
        a.index - b.index,
    );
  return (
    <>
      <div class="stats stats-inline">
        {SUMMARY.map(([verdict, one, many]) => {
          const count = counts.get(verdict) ?? 0;
          return (
            (count > 0 || verdict === "passed") && (
              <span key={verdict}>
                <strong class="num">{count}</strong>{" "}
                {count === 1 ? one : many}
              </span>
            )
          );
        })}
      </div>
      <div class="table-scroll">
        <table class="table table-compact pg-results">
          <thead>
            <tr>
              <th scope="col">Model</th>
              <th scope="col">Test</th>
              <th scope="col">Result</th>
              <th scope="col" class="num-col hide-sm">
                Duration
              </th>
              <th scope="col">
                <span class="sr-only">Details</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ row, index }) => {
              const key = JSON.stringify([row.model, row.caseId]);
              const expanded = open === key;
              const toggle = () => setOpen(expanded ? null : key);
              const explanation = m.text(row.explanation);
              const testLabel =
                CASES.find((c) => c.id === row.caseId)?.label ?? row.caseId;
              return (
                <Fragment key={`${key}:${index}`}>
                  <tr
                    class={`history-row${expanded ? " is-open" : ""}`}
                    onClick={toggle}
                  >
                    <td>{row.model}</td>
                    <td>{testLabel}</td>
                    <td>
                      <Pill
                        tone={VERDICT_TONES[row.verdict]}
                        title={row.verdict === "passed" ? explanation : undefined}
                      >
                        {VERDICT_LABELS[row.verdict]}
                      </Pill>
                      {row.verdict !== "passed" && explanation && (
                        <div class="cell-sub">{explanation}</div>
                      )}
                    </td>
                    <td class="num num-col hide-sm">
                      {duration(row.turn.result?.durationMs)}
                    </td>
                    <td class="cell-action">
                      <Button
                        size="sm"
                        variant="ghost"
                        iconOnly
                        icon={expanded ? "chevronDown" : "chevronRight"}
                        aria-expanded={expanded}
                        onClick={(event) => {
                          event.stopPropagation();
                          toggle();
                        }}
                      >
                        {`${expanded ? "Hide" : "Show"} details for ${row.model}, ${testLabel}`}
                      </Button>
                    </td>
                  </tr>
                  {expanded && (
                    <tr class="history-detail">
                      <td colSpan={5}>
                        <TurnInspector turn={row.turn} meta note={explanation} />
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}
