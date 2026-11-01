import type { JSX } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { Button, EmptyState, Panel, Pill } from "../components/ui.js";
import { Icon } from "../components/icons.js";
import { copyText, downloadText } from "./shared.js";
import { toast } from "../state/actions.js";
import { masked, masker } from "../state/store.js";
import { transcribeAudio } from "../state/transcription-client.js";
import { newId, type TranscriptionState } from "../lib/playground.js";
import {
  AUDIO_ACCEPT,
  AudioRecorder,
  audioFileLimit,
  MAX_RECORDING_MS,
  validateAudioFile,
  type RecordingState,
} from "../lib/audio-recorder.js";
import { formatDateTime, formatMs, pluralize } from "../lib/format.js";

interface Props {
  state: TranscriptionState;
  models: string[];
  maxBodyBytes: number;
  disabled: boolean;
  onChange: (update: (state: TranscriptionState) => TranscriptionState) => void;
  onBusyChange: (busy: boolean) => void;
  controllers: Map<string, AbortController>;
}
interface Problem {
  title: string;
  message: string;
}
const message = (err: unknown): string =>
  err instanceof Error ? err.message : String(err);
function clock(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

export function TranscriptionPage({
  state,
  models,
  maxBodyBytes,
  disabled,
  onChange,
  onBusyChange,
  controllers,
}: Props): JSX.Element {
  const [file, setFile] = useState<File | null>(null);
  const [url, setUrl] = useState("");
  const [recording, setRecording] = useState<RecordingState>("idle");
  const [elapsed, setElapsed] = useState(0);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<Problem | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const formRef = useRef<HTMLDivElement>(null);
  const capture = useRef<AudioRecorder | null>(null);
  const request = useRef<AbortController | null>(null);
  const mounted = useRef(true);
  const refocus = useRef(false);
  const maxBytes = audioFileLimit(maxBodyBytes);
  const available = models.filter(
    (id) =>
      id === "whisper-1" || (/^gemini-/i.test(id) && !/image|tts/i.test(id)),
  );
  const selected =
    state.model ||
    (available.includes("whisper-1") ? "whisper-1" : available[0] || "");
  const active = sending || recording !== "idle";
  const locked = disabled || active;
  const canRecord =
    typeof MediaRecorder !== "undefined" &&
    !!navigator.mediaDevices?.getUserMedia &&
    window.isSecureContext;

  useEffect(() => {
    onBusyChange(active);
  }, [active]);
  useEffect(() => {
    mounted.current = true;
    const recorder = new AudioRecorder({
      maxBytes,
      onState: (value) => {
        if (mounted.current) setRecording(value);
        if (value === "idle") controllers.delete("microphone");
      },
      onFile: (audio) => {
        if (mounted.current) {
          setFile(audio);
          setError(null);
        }
      },
      onError: (text) => {
        if (mounted.current)
          setError({ title: "Couldn't record audio", message: text });
      },
    });
    capture.current = recorder;
    return () => {
      mounted.current = false;
      recorder.cancel();
      request.current?.abort();
      controllers.delete("microphone");
      controllers.delete("transcription");
      onBusyChange(false);
    };
  }, [maxBytes]);
  useEffect(() => {
    if (!file) {
      setUrl("");
      return;
    }
    const next = URL.createObjectURL(file);
    setUrl(next);
    return () => URL.revokeObjectURL(next);
  }, [file]);
  useEffect(() => {
    if (recording !== "recording") return;
    const started = Date.now();
    setElapsed(0);
    const timer = setInterval(() => setElapsed(Date.now() - started), 1000);
    return () => clearInterval(timer);
  }, [recording]);
  // Record, Stop, Cancel, Remove and Transcribe hide or disable themselves.
  // When that drops keyboard focus, move it to the next useful control.
  useEffect(() => {
    const root = formRef.current;
    const focused = document.activeElement;
    if (!refocus.current || !root) return;
    // Cancel holds focus only while permission is pending; once recording
    // starts, Enter should stop (and keep) the clip rather than discard it.
    if (recording === "recording" && focused && root.contains(focused)) {
      root
        .querySelector<HTMLElement>(".pg-audio-actions button:not(:disabled)")
        ?.focus();
      return;
    }
    if (
      focused &&
      focused !== document.body &&
      !(focused instanceof HTMLButtonElement && focused.disabled)
    )
      return;
    const next =
      sending || (recording === "idle" && file)
        ? ".config-actions button:not(:disabled)"
        : ".pg-audio-actions button:not(:disabled)";
    root.querySelector<HTMLElement>(next)?.focus();
  }, [recording, sending, file]);
  // Once the user moves on (clicks or tabs elsewhere), stop pulling focus back.
  useEffect(() => {
    const release = (event: Event): void => {
      if (!formRef.current?.contains(event.target as Node))
        refocus.current = false;
    };
    document.addEventListener("pointerdown", release, true);
    document.addEventListener("focusin", release, true);
    return () => {
      document.removeEventListener("pointerdown", release, true);
      document.removeEventListener("focusin", release, true);
    };
  }, []);

  function selectFile(next: File): void {
    try {
      validateAudioFile(next, maxBytes);
      setFile(next);
      setError(null);
    } catch (err) {
      setError({ title: "Couldn't use this file", message: message(err) });
    }
  }
  function startRecording(): void {
    if (!canRecord || locked) return;
    setError(null);
    setFile(null);
    const controller = new AbortController();
    controller.signal.addEventListener(
      "abort",
      () => capture.current?.cancel(),
      { once: true },
    );
    controllers.set("microphone", controller);
    void capture.current?.start();
  }
  async function transcribe(): Promise<void> {
    if (!file || locked) return;
    if (!available.includes(selected)) {
      setError({
        title: "Transcription failed",
        message: "Choose an enabled audio model.",
      });
      return;
    }
    const controller = new AbortController();
    request.current = controller;
    controllers.set("transcription", controller);
    setSending(true);
    setError(null);
    try {
      const result = await transcribeAudio(
        {
          file,
          model: selected,
          language: state.language.trim(),
          prompt: state.prompt,
          maxBodyBytes,
        },
        controller.signal,
      );
      if (mounted.current)
        onChange((current) => ({
          ...current,
          model: selected,
          results: [
            { ...result, id: newId(), createdAt: Date.now() },
            ...current.results,
          ],
        }));
    } catch (err) {
      if (mounted.current)
        setError(
          controller.signal.aborted
            ? {
                title: "Transcription cancelled",
                message: "No transcript was saved.",
              }
            : { title: "Transcription failed", message: message(err) },
        );
    } finally {
      controllers.delete("transcription");
      request.current = null;
      if (mounted.current) setSending(false);
    }
  }

  const fileName = file && (masked.value ? "Audio file" : file.name);
  const hint = `WAV, MP3, M4A/MP4, WebM, OGG/OGA, FLAC or PCM up to ${(
    maxBytes /
    1024 /
    1024
  ).toFixed(1)} MiB. ${
    canRecord
      ? `Recording stops after ${pluralize(MAX_RECORDING_MS / 60_000, "minute")}.`
      : "Recording needs HTTPS or localhost and a browser with MediaRecorder support."
  }`;
  const announcement =
    recording === "requesting"
      ? "Waiting for microphone permission…"
      : recording === "recording"
        ? "Recording"
        : recording === "finalizing"
          ? "Preparing recording…"
          : sending
            ? "Transcribing…"
            : "";

  return (
    <>
      <Panel
        title="Transcription"
        subtitle="Upload or record audio to transcribe it. Audio isn't saved; only transcripts are."
      >
        <div class="form" ref={formRef}>
          <div class="form-row">
            <label class="field">
              <span class="field-label">Audio model</span>
              <select
                class="select"
                aria-label="Audio model"
                value={selected}
                disabled={locked}
                onChange={(e) =>
                  onChange((current) => ({
                    ...current,
                    model: e.currentTarget.value,
                  }))
                }
              >
                {!available.length && (
                  <option value="">No audio models enabled</option>
                )}
                {state.model && !available.includes(state.model) && (
                  <option value={state.model}>
                    {state.model} (unavailable)
                  </option>
                )}
                {available.map((model) => (
                  <option key={model} value={model}>
                    {model}
                  </option>
                ))}
              </select>
              <span class="field-hint">
                Transcription uses Gemini. whisper-1 is a compatibility alias;
                audio support depends on the selected model.
              </span>
            </label>
            <label class="field">
              <span class="field-label">Language (optional)</span>
              <input
                class="input"
                value={state.language}
                maxLength={12}
                placeholder="Auto detect (e.g. es, en)"
                disabled={locked}
                onInput={(e) =>
                  onChange((current) => ({
                    ...current,
                    language: e.currentTarget.value,
                  }))
                }
              />
            </label>
          </div>
          <label class="field">
            <span class="field-label">Vocabulary context (optional)</span>
            <textarea
              class="input"
              rows={3}
              maxLength={1000}
              value={state.prompt}
              disabled={locked}
              placeholder="Names, technical terms or other vocabulary to help recognition."
              onInput={(e) =>
                onChange((current) => ({
                  ...current,
                  prompt: e.currentTarget.value,
                }))
              }
            />
          </label>
          <div class="field">
            <div class="pg-audio-actions">
              {recording === "idle" ? (
                <>
                  <Button
                    key="upload"
                    icon="upload"
                    disabled={locked}
                    onClick={() => inputRef.current?.click()}
                  >
                    Upload audio
                  </Button>
                  <Button
                    key="record"
                    icon="mic"
                    disabled={locked || !canRecord}
                    onClick={() => {
                      refocus.current = true;
                      startRecording();
                    }}
                  >
                    Record
                  </Button>
                </>
              ) : (
                <>
                  {recording === "recording" ? (
                    <Pill tone="bad">Recording {clock(elapsed)}</Pill>
                  ) : (
                    <Pill tone="muted">
                      {recording === "requesting"
                        ? "Waiting for microphone permission…"
                        : "Preparing recording…"}
                    </Pill>
                  )}
                  {recording === "recording" && (
                    <Button
                      key="stop"
                      onClick={() => {
                        refocus.current = true;
                        capture.current?.stop();
                      }}
                    >
                      Stop recording
                    </Button>
                  )}
                  <Button
                    key="cancel"
                    variant="ghost"
                    aria-label="Cancel recording"
                    onClick={() => {
                      refocus.current = true;
                      capture.current?.cancel();
                    }}
                  >
                    Cancel
                  </Button>
                </>
              )}
              <input
                ref={inputRef}
                class="sr-only"
                type="file"
                accept={AUDIO_ACCEPT}
                aria-label="Audio file"
                disabled={locked}
                onChange={(e) => {
                  const next = e.currentTarget.files?.[0];
                  e.currentTarget.value = "";
                  if (next) selectFile(next);
                }}
              />
              <span class="sr-only" role="status">
                {announcement}
              </span>
            </div>
            <span class="field-hint">{hint}</span>
          </div>
          {file && (
            <div class="pg-audio-file">
              <div class="pg-audio-file-head">
                <div class="pg-audio-file-name">
                  <strong class="truncate" title={fileName ?? undefined}>
                    {fileName}
                  </strong>
                  <div class="cell-sub">
                    {(file.size / 1024).toFixed(1)} KiB
                  </div>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  icon="x"
                  iconOnly
                  title={`Remove ${fileName}`}
                  disabled={locked}
                  onClick={() => {
                    refocus.current = true;
                    setFile(null);
                  }}
                >
                  {`Remove ${fileName}`}
                </Button>
              </div>
              {url && (
                <audio
                  controls
                  preload="metadata"
                  src={url}
                  aria-label="Audio preview"
                />
              )}
            </div>
          )}
          {error && (
            <div class="callout tone-bad" role="alert">
              <Icon name="critical" size={16} />
              <div>
                <strong>{error.title}</strong>
                <p>{masker.value.text(error.message)}</p>
              </div>
            </div>
          )}
          <div class="config-actions">
            <span class="spacer" />
            {sending && (
              <Button
                variant="ghost"
                onClick={() => {
                  refocus.current = true;
                  request.current?.abort();
                }}
              >
                Cancel transcription
              </Button>
            )}
            <Button
              variant="primary"
              loading={sending}
              disabled={locked || !file || !available.includes(selected)}
              onClick={() => {
                refocus.current = true;
                void transcribe();
              }}
            >
              {sending ? "Transcribing…" : "Transcribe"}
            </Button>
          </div>
        </div>
      </Panel>
      <Panel title="Transcripts" flush>
        {state.results.length ? (
          <ul class="pg-transcripts">
            {state.results.map((result) => (
              <li key={result.id} class="pg-transcript">
                <div class="pg-transcript-main">
                  <strong class="pg-transcript-name">
                    {masked.value ? "Transcript" : result.filename}
                  </strong>
                  <div class="cell-sub">
                    {result.model} · {formatDateTime(result.createdAt)} ·{" "}
                    {formatMs(result.elapsedMs)}
                  </div>
                  <p
                    class={`pg-transcript-text${result.text ? "" : " muted"}`}
                  >
                    {result.text
                      ? masker.value.text(result.text)
                      : "No clear speech detected."}
                  </p>
                </div>
                <div class="pg-transcript-actions">
                  <Button
                    variant="ghost"
                    size="sm"
                    icon="copy"
                    onClick={() =>
                      void copyText(result.text).then((ok) =>
                        toast(
                          ok ? "Transcript copied" : "Could not copy transcript",
                          ok ? "success" : "error",
                        ),
                      )
                    }
                  >
                    Copy
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    icon="download"
                    onClick={() =>
                      downloadText(
                        `transcript-${result.id}.txt`,
                        result.text,
                        "text/plain;charset=utf-8",
                      )
                    }
                  >
                    Download
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    icon="trash"
                    iconOnly
                    title="Delete transcript"
                    disabled={locked}
                    onClick={() =>
                      onChange((current) => ({
                        ...current,
                        results: current.results.filter(
                          (r) => r.id !== result.id,
                        ),
                      }))
                    }
                  >
                    Delete transcript
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <EmptyState icon="mic" title="No transcripts yet" />
        )}
      </Panel>
    </>
  );
}
