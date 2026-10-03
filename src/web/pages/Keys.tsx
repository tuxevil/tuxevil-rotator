// Virtual keys: per-client API keys with optional model allowlists.

import type { JSX } from "preact";
import { useEffect, useMemo, useState } from "preact/hooks";
import type { VirtualKey } from "../../types.js";
import { pluralize } from "../lib/format.js";
import { api, type ModelCatalogEntry } from "../state/api.js";
import { confirmAction, toast } from "../state/actions.js";
import { query, setQuery } from "../state/router.js";
import { masker, overview } from "../state/store.js";
import { Dialog } from "../components/overlays.js";
import { Menu } from "../components/overlays.js";
import {
  Button,
  EmptyState,
  PageHeader,
  Pill,
  RelativeTime,
  SearchInput,
  Segmented,
  Spinner,
  Stat,
} from "../components/ui.js";
import { Icon } from "../components/icons.js";
import { copyText } from "./shared.js";

const PROVIDER_GROUPS: Record<string, string> = {
  "tuxevil-rotator": "Google Antigravity",
  "google-antigravity": "Google Antigravity",
  "openai-codex": "OpenAI Codex",
  ollama: "Ollama Cloud",
  "opencode-zen": "OpenCode Zen",
};

export function KeysPage(): JSX.Element {
  if (!overview.value?.capabilities.database) {
    return (
      <>
        <PageHeader title="Virtual keys" description="Give each client its own API key and limit which models it can use." />
        <div class="panel">
          <EmptyState icon="keys" title="Virtual keys need PostgreSQL">
            Keys and their request history are stored in the database. Set <code>DATABASE_URL</code> and restart the rotator to
            enable them. Until then, clients call the proxy without a key. See docs/virtual-keys.md.
          </EmptyState>
        </div>
      </>
    );
  }
  return <KeysManager />;
}

type Editing = { mode: "create" } | { mode: "edit"; key: VirtualKey } | null;

function KeysManager(): JSX.Element {
  const [keys, setKeys] = useState<VirtualKey[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<Editing>(null);
  const params = query.value;
  const search = params.get("q") ?? "";
  const status = params.get("status") ?? "all";
  const m = masker.value;

  const load = () =>
    api.keys().then(
      (r) => {
        setKeys(r.keys);
        setError(null);
      },
      (err) => setError(err instanceof Error ? err.message : String(err)),
    );
  useEffect(() => {
    void load();
  }, []);

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (keys ?? []).filter((k) => {
      if (status === "active" && k.blocked) return false;
      if (status === "blocked" && !k.blocked) return false;
      if (!q) return true;
      return [k.keyAlias, k.keyName, k.userId ?? ""].some((v) => v.toLowerCase().includes(q));
    });
  }, [keys, search, status]);

  const active = (keys ?? []).filter((k) => !k.blocked).length;
  const blocked = (keys ?? []).length - active;

  const setBlocked = async (key: VirtualKey, next: boolean) => {
    if (next) {
      const ok = await confirmAction({
        title: `Block ${m.key(key.keyAlias)}?`,
        body: "Requests that use this key are rejected until you unblock it.",
        confirmLabel: "Block key",
        danger: true,
      });
      if (!ok) return;
    }
    try {
      await api.updateKey(key.tokenHash, { blocked: next });
      toast(next ? `${m.key(key.keyAlias)} blocked` : `${m.key(key.keyAlias)} unblocked`, "success");
      void load();
    } catch (err) {
      toast(`Could not update the key: ${err instanceof Error ? err.message : String(err)}`, "error");
    }
  };

  const remove = async (key: VirtualKey) => {
    const ok = await confirmAction({
      title: `Delete ${m.key(key.keyAlias)}?`,
      body: "Clients using this key stop working immediately. Its request history is kept. This cannot be undone.",
      confirmLabel: "Delete key",
      danger: true,
      typeToConfirm: "delete",
    });
    if (!ok) return;
    try {
      await api.deleteKey(key.tokenHash);
      toast(`${m.key(key.keyAlias)} deleted`, "success");
      void load();
    } catch (err) {
      toast(`Could not delete the key: ${err instanceof Error ? err.message : String(err)}`, "error");
    }
  };

  return (
    <>
      <PageHeader
        title="Virtual keys"
        description="Give each client its own API key and limit which models it can use."
        actions={
          <Button variant="primary" icon="plus" onClick={() => setEditing({ mode: "create" })}>
            New key
          </Button>
        }
      />
      <div class="stats stats-card">
        <Stat label="Keys" value={keys ? keys.length : "—"} />
        <Stat label="Active" value={keys ? active : "—"} />
        <Stat label="Blocked" value={keys ? blocked : "—"} tone={blocked > 0 ? "warn" : undefined} />
      </div>
      <div class="toolbar">
        <Segmented
          label="Filter by status"
          size="sm"
          value={status}
          onChange={(v) => setQuery({ status: v === "all" ? null : v })}
          options={[
            { value: "all", label: "All" },
            { value: "active", label: "Active" },
            { value: "blocked", label: "Blocked" },
          ]}
        />
        <div class="toolbar-right">
          <span data-page-search>
            <SearchInput value={search} onInput={(v) => setQuery({ q: v || null })} placeholder="Alias, key or user" label="Search keys" shortcut="/" />
          </span>
        </div>
      </div>
      <div class="panel panel-flush">
        {error && !keys ? (
          <EmptyState icon="critical" title="Could not load keys">
            {error}
          </EmptyState>
        ) : !keys ? (
          <div class="panel-loading">
            <Spinner />
          </div>
        ) : keys.length === 0 ? (
          <EmptyState icon="keys" title="No virtual keys yet" action={<Button variant="primary" icon="plus" onClick={() => setEditing({ mode: "create" })}>New key</Button>}>
            Without keys, any client that can reach the proxy can use it.
          </EmptyState>
        ) : visible.length === 0 ? (
          <EmptyState icon="search" title="No keys match" />
        ) : (
          <div class="table-scroll">
            <table class="table">
              <thead>
                <tr>
                  <th scope="col">Key</th>
                  <th scope="col" class="hide-sm">User</th>
                  <th scope="col">Models</th>
                  <th scope="col">Status</th>
                  <th scope="col" class="hide-sm">Last used</th>
                  <th scope="col">
                    <span class="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {visible.map((key) => (
                  <tr key={key.tokenHash} class={key.blocked ? "is-inactive" : undefined}>
                    <th scope="row">
                      <div class="account-name">{m.key(key.keyAlias)}</div>
                      <div class="cell-sub mono-text">{m.enabled ? "rk-•••" : key.keyName}</div>
                    </th>
                    <td class="hide-sm">{key.userId ? (m.enabled ? "•••" : key.userId) : <span class="muted">—</span>}</td>
                    <td>
                      {!key.models || key.models.length === 0 ? (
                        <span class="muted">All models</span>
                      ) : (
                        <span class="chip-row">
                          {key.models.slice(0, 3).map((model) => (
                            <span class="chip" key={model}>
                              {model}
                            </span>
                          ))}
                          {key.models.length > 3 && <span class="cell-sub">+{key.models.length - 3}</span>}
                        </span>
                      )}
                    </td>
                    <td>
                      <Pill tone={key.blocked ? "bad" : "ok"}>{key.blocked ? "Blocked" : "Active"}</Pill>
                    </td>
                    <td class="hide-sm muted">
                      <RelativeTime ts={key.lastActive ? Date.parse(key.lastActive) : null} />
                    </td>
                    <td class="cell-action">
                      <Menu
                        label={`Actions for ${m.key(key.keyAlias)}`}
                        items={[
                          { label: "Edit models", icon: "edit", onSelect: () => setEditing({ mode: "edit", key }) },
                          key.blocked
                            ? { label: "Unblock", icon: "play", onSelect: () => void setBlocked(key, false) }
                            : { label: "Block", icon: "ban", onSelect: () => void setBlocked(key, true) },
                          "separator",
                          { label: "Delete key…", icon: "trash", danger: true, onSelect: () => void remove(key) },
                        ]}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      <KeyDialog editing={editing} onClose={() => setEditing(null)} onSaved={() => void load()} />
    </>
  );
}

let catalogCache: ModelCatalogEntry[] | null = null;

function KeyDialog({ editing, onClose, onSaved }: { editing: Editing; onClose: () => void; onSaved: () => void }): JSX.Element {
  const [alias, setAlias] = useState("");
  const [userId, setUserId] = useState("");
  const [models, setModels] = useState<Set<string>>(new Set());
  const [catalog, setCatalog] = useState<ModelCatalogEntry[] | null>(catalogCache);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [rawKey, setRawKey] = useState<string | null>(null);

  useEffect(() => {
    if (!editing) return;
    setError(null);
    setRawKey(null);
    setBusy(false);
    if (editing.mode === "edit") {
      setAlias(editing.key.keyAlias);
      setUserId(editing.key.userId ?? "");
      setModels(new Set(editing.key.models ?? []));
    } else {
      setAlias("");
      setUserId("");
      setModels(new Set());
    }
    if (!catalogCache) {
      api.models().then(
        (r) => {
          catalogCache = r.data;
          setCatalog(r.data);
        },
        () => setCatalog([]),
      );
    }
  }, [editing]);

  const groups = useMemo(() => {
    const out = new Map<string, string[]>();
    for (const entry of catalog ?? []) {
      const group = PROVIDER_GROUPS[entry.owned_by ?? ""] ?? entry.owned_by ?? "Other";
      const list = out.get(group) ?? [];
      if (!list.includes(entry.id)) list.push(entry.id);
      out.set(group, list);
    }
    return [...out.entries()];
  }, [catalog]);

  const toggle = (id: string) => {
    const next = new Set(models);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setModels(next);
  };

  const submit = async () => {
    setError(null);
    if (editing?.mode === "create" && !alias.trim()) {
      setError("Give the key an alias, for example the client that will use it.");
      return;
    }
    setBusy(true);
    try {
      if (editing?.mode === "create") {
        const result = await api.generateKey({ alias: alias.trim(), userId: userId.trim() || null, models: [...models] });
        setRawKey(result.rawKey);
      } else if (editing?.mode === "edit") {
        await api.updateKey(editing.key.tokenHash, { models: [...models] });
        toast("Allowed models updated", "success");
        onClose();
      }
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const total = (catalog ?? []).length;
  const scope = models.size === 0 ? "All models allowed" : `${models.size} of ${total} models allowed`;

  return (
    <Dialog
      open={Boolean(editing)}
      onClose={onClose}
      size="lg"
      title={rawKey ? "Key created" : editing?.mode === "edit" ? `Edit ${editing.key.keyAlias}` : "New virtual key"}
      description={rawKey ? undefined : "Leave every model unchecked to allow all of them."}
      footer={
        rawKey ? (
          <Button variant="primary" onClick={onClose}>
            Done
          </Button>
        ) : (
          <>
            <Button onClick={onClose}>Cancel</Button>
            <Button variant="primary" loading={busy} onClick={() => void submit()}>
              {editing?.mode === "edit" ? "Save changes" : "Create key"}
            </Button>
          </>
        )
      }
    >
      {rawKey ? (
        <div class="key-reveal">
          <p>
            <Icon name="warning" size={14} /> Copy the key now. It is stored hashed and cannot be shown again.
          </p>
          <code class="key-value">{rawKey}</code>
          <Button
            icon="copy"
            onClick={async () => toast((await copyText(rawKey)) ? "Key copied" : "Copy failed; select the key and copy it manually", "info")}
          >
            Copy key
          </Button>
        </div>
      ) : (
        <div class="form">
          <div class="form-row">
            <label class="field">
              <span class="field-label">Alias</span>
              <input
                class="input"
                value={alias}
                disabled={editing?.mode === "edit"}
                placeholder="cursor-laptop"
                onInput={(e) => setAlias((e.target as HTMLInputElement).value)}
              />
            </label>
            <label class="field">
              <span class="field-label">
                User <span class="muted">(optional)</span>
              </span>
              <input
                class="input"
                value={userId}
                disabled={editing?.mode === "edit"}
                placeholder="alex"
                onInput={(e) => setUserId((e.target as HTMLInputElement).value)}
              />
            </label>
          </div>
          <div class="field">
            <div class="field-label-row">
              <span class="field-label">Allowed models</span>
              <span class={`muted${models.size > 0 ? " tone-text-warn" : ""}`}>{scope}</span>
              <span class="spacer" />
              <button type="button" class="link-button" onClick={() => setModels(new Set((catalog ?? []).map((c) => c.id)))}>
                Select all
              </button>
              <button type="button" class="link-button" onClick={() => setModels(new Set())}>
                Clear
              </button>
            </div>
            {!catalog ? (
              <Spinner />
            ) : groups.length === 0 ? (
              <p class="muted">No models available. Connect a provider account first.</p>
            ) : (
              <div class="model-groups">
                {groups.map(([group, ids]) => (
                  <fieldset key={group} class="model-group">
                    <legend>
                      {group} <span class="muted">{pluralize(ids.length, "model")}</span>
                    </legend>
                    <div class="model-grid">
                      {ids.map((id) => (
                        <label key={id} class="checkbox model-option">
                          <input type="checkbox" checked={models.has(id)} onChange={() => toggle(id)} />
                          <span class="truncate" title={id}>
                            {id}
                          </span>
                        </label>
                      ))}
                    </div>
                  </fieldset>
                ))}
              </div>
            )}
          </div>
          {error && (
            <p class="form-error" role="alert">
              {error}
            </p>
          )}
        </div>
      )}
    </Dialog>
  );
}
