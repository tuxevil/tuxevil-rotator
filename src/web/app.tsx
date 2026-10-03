import type { ComponentChildren, JSX } from "preact";
import { useEffect, useMemo, useState } from "preact/hooks";
import { buildAttention, actionableCount, SEVERITY_ICON, SEVERITY_TONE, type AttentionItem } from "./lib/attention.js";
import { formatRelative } from "./lib/format.js";
import { needsAttention } from "./lib/status.js";
import {
  accounts,
  authRequired,
  authState,
  connection,
  masked,
  masker,
  now,
  overview,
  paletteOpen,
  railExpanded,
  signIn,
  signOut,
  theme,
} from "./state/store.js";
import { api } from "./state/api.js";
import { toast } from "./state/actions.js";
import { readPref, writePref } from "./state/prefs.js";
import { accountPath, BASE, navigate, query, route } from "./state/router.js";
import { NAV, PAGE_TITLES, type NavItem } from "./nav.js";
import { Icon, LogoMark } from "./components/icons.js";
import { ConfirmHost, Drawer, Menu, Popover, ToastHost } from "./components/overlays.js";
import { CommandPalette, MOD_KEY } from "./components/command.js";
import { AsyncButton, Button, Link, Spinner } from "./components/ui.js";
import { OverviewPage } from "./pages/Overview.js";
import { AccountsPage } from "./pages/Accounts.js";
import { AccountDetail } from "./pages/AccountDetail.js";
import { RequestsPage } from "./pages/Requests.js";
import { UsagePage } from "./pages/Usage.js";
import { KeysPage } from "./pages/Keys.js";
import { SettingsPage } from "./pages/Settings.js";
import { openAddAccount } from "./pages/shared.js";

/** Below this width the rail becomes a slide-over sheet. */
const COMPACT_QUERY = "(max-width: 760px)";
const SUPPORT_URL = "https://ko-fi.com/tuxevil";

export function App(): JSX.Element {
  const auth = authState.value;
  if (auth === "checking") {
    return (
      <div class="boot">
        <Spinner />
      </div>
    );
  }
  if (auth === "signed-out") return <LoginScreen />;
  return <Shell />;
}

function useDocumentTitle(): void {
  const page = route.value.page;
  const data = overview.value;
  const issues = data ? data.accounts.filter(needsAttention).length : 0;
  useEffect(() => {
    const title = page === "not-found" ? "Not found" : PAGE_TITLES[page];
    document.title = `${issues > 0 ? `(${issues}) ` : ""}${title} · Tuxevil Rotator`;
  }, [page, issues]);
}

function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const list = window.matchMedia(query);
    const onChange = () => setMatches(list.matches);
    onChange();
    list.addEventListener("change", onChange);
    return () => list.removeEventListener("change", onChange);
  }, [query]);
  return matches;
}

function useAttention(): AttentionItem[] {
  const data = overview.value;
  const minute = Math.floor(now.value / 60_000);
  return useMemo(() => (data ? buildAttention(data, Date.now(), masker.value.name) : []), [data, masker.value, minute]);
}

function Shell(): JSX.Element {
  const current = route.value;
  const [navOpen, setNavOpen] = useState(false);
  const compact = useMediaQuery(COMPACT_QUERY);
  useDocumentTitle();

  useEffect(() => setNavOpen(false), [current.page, compact]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === "k") {
        event.preventDefault();
        paletteOpen.value = !paletteOpen.value;
        return;
      }
      if (event.key === "Escape") setNavOpen(false);
      const target = event.target as HTMLElement | null;
      if (target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key === "/") {
        const search = document.querySelector<HTMLInputElement>("[data-page-search] input");
        event.preventDefault();
        if (search) search.focus();
        else paletteOpen.value = true;
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  const toggleNav = () => {
    if (compact) setNavOpen(!navOpen);
    else railExpanded.value = !railExpanded.value;
  };

  let page: JSX.Element;
  switch (current.page) {
    case "overview":
      page = <OverviewPage />;
      break;
    case "accounts":
      page = <AccountsPage />;
      break;
    case "requests":
      page = <RequestsPage />;
      break;
    case "usage":
      page = <UsagePage />;
      break;
    case "keys":
      page = <KeysPage />;
      break;
    case "settings":
      page = <SettingsPage />;
      break;
    default:
      page = <NotFound />;
  }

  const drawerEmail = current.account;
  const closeDrawer = () => {
    const back = query.value.toString();
    navigate(`${BASE}/accounts${back ? `?${back}` : ""}`, { replace: false });
  };

  return (
    <div class={`app${railExpanded.value ? " rail-expanded" : ""}${navOpen ? " nav-open" : ""}`}>
      <a class="skip-link" href="#main">
        Skip to content
      </a>
      <TopBar navOpen={compact ? navOpen : railExpanded.value} onToggleNav={toggleNav} />
      <Rail />
      <div class="rail-scrim" aria-hidden="true" onClick={() => setNavOpen(false)} />
      <main class="canvas" id="main" tabIndex={-1}>
        <Banners />
        {overview.value ? (
          <div class="page" key={current.page}>
            {page}
          </div>
        ) : (
          <div class="page page-loading">
            <Spinner />
            <span>{connection.value.error ? `Waiting for the rotator — ${connection.value.error}` : "Loading the rotator state…"}</span>
          </div>
        )}
      </main>
      <Drawer open={Boolean(drawerEmail) && Boolean(overview.value)} onClose={closeDrawer} label="Account details">
        {drawerEmail && overview.value && <AccountDetail email={drawerEmail} onClose={closeDrawer} />}
      </Drawer>
      <CommandPalette />
      <ConfirmHost />
      <ToastHost />
    </div>
  );
}

// ── Top bar ─────────────────────────────────────────────────────────────

/** `navOpen`: the rail is expanded (desktop) or the nav sheet is open (phone). */
function TopBar({ navOpen, onToggleNav }: { navOpen: boolean; onToggleNav: () => void }): JSX.Element {
  return (
    <header class="topbar">
      <div class="topbar-start">
        <Link href={BASE} class="brand-pill" aria-label="Tuxevil Rotator overview">
          <LogoMark size={22} />
          <span class="brand-name">Tuxevil Rotator</span>
          <span class="brand-sep" aria-hidden="true" />
          <LiveIndicator compact />
        </Link>
        <div class="pill-group" role="group" aria-label="Navigation">
          <button
            type="button"
            class="pill-btn"
            aria-label={navOpen ? "Collapse sidebar" : "Expand sidebar"}
            aria-expanded={navOpen}
            title={navOpen ? "Collapse sidebar" : "Expand sidebar"}
            onClick={onToggleNav}
          >
            <Icon name="panelLeft" size={17} />
          </button>
          <button type="button" class="pill-btn" aria-label="Add account" title="Add account" onClick={openAddAccount}>
            <Icon name="plus" size={17} />
          </button>
        </div>
      </div>
      <div class="topbar-end">
        <button type="button" class="search-trigger" onClick={() => (paletteOpen.value = true)}>
          <Icon name="search" size={16} />
          <span class="search-trigger-text">Search or jump to…</span>
          <span class="search-trigger-keys" aria-hidden="true">
            <kbd>{MOD_KEY}</kbd>
            <kbd>K</kbd>
          </span>
        </button>
        <Inbox />
      </div>
    </header>
  );
}

function attentionEmail(item: AttentionItem): string | null {
  for (const action of item.actions) if ("email" in action) return action.email;
  return null;
}

function Inbox(): JSX.Element {
  const items = useAttention();
  const count = actionableCount(items);
  const urgent = items.filter((i) => i.severity !== "info");
  const notes = items.length - urgent.length;
  const shown = (urgent.length > 0 ? urgent : items).slice(0, 6);

  const open = (item: AttentionItem) => {
    const email = attentionEmail(item);
    if (email) {
      navigate(accountPath(email));
      return;
    }
    navigate(BASE);
    requestAnimationFrame(() =>
      document.getElementById("attention")?.scrollIntoView({ behavior: "smooth", block: "start" }),
    );
  };

  return (
    <Popover
      label={count > 0 ? `Needs you: ${count}` : "Needs you"}
      triggerClass={`icon-pill${count > 0 ? " has-badge" : ""}`}
      triggerTitle="Needs you"
      class="inbox"
      trigger={
        <>
          <Icon name="bell" size={17} />
          {count > 0 && <span class="icon-pill-badge num">{count > 9 ? "9+" : count}</span>}
        </>
      }
    >
      {(close) => (
        <>
          <header class="inbox-head">
            <strong>Needs you</strong>
            <span class="muted">
              {urgent.length > 0
                ? `${urgent.length} to look at${notes ? ` · ${notes} ${notes === 1 ? "note" : "notes"}` : ""}`
                : notes > 0
                  ? `${notes} ${notes === 1 ? "note" : "notes"}`
                  : "All clear"}
            </span>
          </header>
          {shown.length === 0 ? (
            <div class="inbox-empty">
              <span class="inbox-empty-icon">
                <Icon name="checkCircle" size={20} />
              </span>
              <strong>Nothing needs you</strong>
              <span class="muted">Every account is routing normally.</span>
            </div>
          ) : (
            <ul class="inbox-list">
              {shown.map((item) => (
                <li key={item.id}>
                  <button
                    type="button"
                    class={`inbox-item tone-${SEVERITY_TONE[item.severity]}`}
                    onClick={() => {
                      close();
                      open(item);
                    }}
                  >
                    <span class="inbox-item-icon">
                      <Icon name={SEVERITY_ICON[item.severity]} size={16} />
                    </span>
                    <span class="inbox-item-text">
                      <strong>{item.title}</strong>
                      <span>{masker.value.text(item.detail)}</span>
                    </span>
                    <Icon name="chevronRight" size={14} class="inbox-item-chevron" />
                  </button>
                </li>
              ))}
            </ul>
          )}
          <footer class="inbox-foot">
            <Link
              href={BASE}
              class="btn btn-ghost btn-sm"
              onClick={() => {
                close();
                requestAnimationFrame(() => document.getElementById("attention")?.scrollIntoView({ block: "start" }));
              }}
            >
              Open overview <Icon name="arrowUpRight" size={14} />
            </Link>
          </footer>
        </>
      )}
    </Popover>
  );
}

// ── Rail ────────────────────────────────────────────────────────────────

function Rail(): JSX.Element {
  const items = useAttention();
  const attention = actionableCount(items);
  const issues = accounts.value.filter(needsAttention).length;
  const page = route.value.page;
  const primary = NAV.filter((item) => item.id !== "settings");
  const settings = NAV.find((item) => item.id === "settings")!;
  const badgeFor = (item: NavItem) =>
    item.id === "overview" && attention > 0
      ? { count: attention, title: "Items that need you" }
      : item.id === "accounts" && issues > 0
        ? { count: issues, title: "Accounts that need attention" }
        : null;

  return (
    <nav class="rail" aria-label="Dashboard">
      <div class="rail-group">
        {primary.map((item) => (
          <RailLink key={item.id} item={item} active={page === item.id} badge={badgeFor(item)} />
        ))}
      </div>
      <div class="rail-foot">
        <RailLink item={settings} active={page === "settings"} badge={null} />
        <SupportNudge />
        <ProfileMenu />
      </div>
    </nav>
  );
}

function RailLink({
  item,
  active,
  badge,
}: {
  item: NavItem;
  active: boolean;
  badge: { count: number; title: string } | null;
}): JSX.Element {
  return (
    <Link
      href={item.href}
      class={`rail-item${active ? " is-active" : ""}`}
      aria-current={active ? "page" : undefined}
      data-tooltip={item.label}
    >
      <span class="rail-icon">
        <Icon name={item.icon} size={18} />
        {badge && <span class="rail-dot" aria-hidden="true" />}
      </span>
      <span class="rail-label">{item.label}</span>
      {badge && (
        <span class="rail-count num" title={badge.title}>
          {badge.count}
        </span>
      )}
    </Link>
  );
}

function ProfileMenu(): JSX.Element {
  const data = overview.value;
  const value = theme.value;
  return (
    <Menu
      label="Profile and preferences"
      placement="right-end"
      triggerClass="rail-profile"
      trigger={
        <>
          <span class="avatar" aria-hidden="true">
            <Icon name="user" size={16} />
          </span>
          <span class="rail-profile-text">
            <strong>Administrator</strong>
            <span>{data ? `v${data.version}` : "Tuxevil Rotator"}</span>
          </span>
          <Icon name="more" size={15} class="rail-profile-more" />
        </>
      }
      header={
        <div class="menu-profile">
          <span class="avatar avatar-lg" aria-hidden="true">
            <Icon name="user" size={18} />
          </span>
          <span class="menu-profile-text">
            <strong>Administrator</strong>
            <span>
              Tuxevil Rotator{data ? ` v${data.version}` : ""}
              {data ? ` · port ${data.proxyPort}` : ""}
            </span>
          </span>
        </div>
      }
      items={[
        { heading: "Theme" },
        { label: "System", icon: "monitor", checked: value === "system", onSelect: () => (theme.value = "system") },
        { label: "Light", icon: "sun", checked: value === "light", onSelect: () => (theme.value = "light") },
        { label: "Dark", icon: "moon", checked: value === "dark", onSelect: () => (theme.value = "dark") },
        "separator",
        {
          label: "Privacy mask",
          icon: masked.value ? "eyeOff" : "eye",
          kind: "checkbox",
          checked: masked.value,
          onSelect: () => (masked.value = !masked.value),
        },
        { label: "Command palette", icon: "search", hint: `${MOD_KEY}K`, onSelect: () => (paletteOpen.value = true) },
        { label: "Support the project", icon: "heart", onSelect: () => window.open(SUPPORT_URL, "_blank", "noopener") },
        ...(authRequired.value
          ? (["separator", { label: "Sign out", icon: "logout", onSelect: () => void signOut() }] as const)
          : []),
      ]}
    />
  );
}

export function LiveIndicator({ compact }: { compact?: boolean }): JSX.Element {
  const { state, lastUpdate, error } = connection.value;
  const label = { live: "Live", polling: "Reconnecting", offline: "Offline", connecting: "Connecting" }[state];
  const detail =
    state === "offline"
      ? `Cannot reach the rotator${error ? `: ${error}` : ""}`
      : state === "polling"
        ? "Live stream dropped; polling every 15s while it reconnects"
        : state === "live"
          ? "Streaming live updates"
          : "Connecting to the rotator";
  return (
    <span class={`live live-${state}${compact ? " live-compact" : ""}`} title={detail} role="status">
      <span class="live-dot" aria-hidden="true" />
      <span class="live-label">
        {label}
        {!compact && lastUpdate > 0 && state !== "live" && (
          <span class="live-age"> · {formatRelative(lastUpdate, now.value)}</span>
        )}
      </span>
    </span>
  );
}

const SUPPORT_SNOOZE_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Quiet, dismissible support ask; returns every 30 days unless turned off.
 * A card in the expanded rail, a heart that opens the same note when collapsed.
 */
function SupportNudge(): JSX.Element | null {
  const [visible, setVisible] = useState(() => {
    if (readPref("hideDonationModal", "")) return false;
    const snoozedAt = Number(readPref("donationPromptSnoozedAt", "0")) || 0;
    return Date.now() - snoozedAt > SUPPORT_SNOOZE_MS;
  });
  if (!visible) return null;
  const snooze = () => {
    writePref("donationPromptSnoozedAt", String(Date.now()));
    setVisible(false);
  };
  const body = (
    <>
      <span class="support-icon">
        <Icon name="heart" size={14} />
      </span>
      <span class="support-text">
        Saving money with the rotator?{" "}
        <a href={SUPPORT_URL} target="_blank" rel="noopener noreferrer">
          Support the project
        </a>
      </span>
    </>
  );
  return (
    <>
      <div class="support-nudge">
        {body}
        <button type="button" class="support-dismiss" aria-label="Dismiss for 30 days" title="Dismiss for 30 days" onClick={snooze}>
          <Icon name="x" size={12} />
        </button>
      </div>
      <span class="support-mini">
        <Popover
          label="Support the project"
          triggerClass="rail-item rail-heart"
          triggerTitle="Support the project"
          placement="right-end"
          class="support-pop"
          trigger={
            <span class="rail-icon">
              <Icon name="heart" size={18} />
            </span>
          }
        >
          {(close) => (
            <>
              <div class="support-pop-body">{body}</div>
              <div class="support-pop-actions">
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    close();
                    snooze();
                  }}
                >
                  Not now
                </Button>
                <a class="btn btn-primary btn-sm" href={SUPPORT_URL} target="_blank" rel="noopener noreferrer" data-autofocus>
                  <Icon name="heart" size={14} /> Support
                </a>
              </div>
            </>
          )}
        </Popover>
      </span>
    </>
  );
}

// ── Banners ─────────────────────────────────────────────────────────────

function Banners(): JSX.Element | null {
  const data = overview.value;
  const [dismissed, setDismissed] = useState(() => readPref("updateDismissed", ""));
  const [pendingRestart, setPendingRestart] = useState(() => readPref("updatePendingRestart", ""));
  const [hiddenNotices, setHiddenNotices] = useState<string[]>([]);
  if (!data) return null;
  const update = data.updateInfo;
  const banners: ComponentChildren[] = [];

  if (connection.value.state === "offline" && connection.value.lastUpdate > 0) {
    banners.push(
      <div class="banner tone-bad" key="offline" role="alert">
        <span class="banner-icon">
          <Icon name="critical" size={16} />
        </span>
        <div class="banner-text">
          <strong>Can't reach the rotator.</strong> Showing data from {formatRelative(connection.value.lastUpdate, now.value)}; retrying in the background.
        </div>
      </div>,
    );
  }

  if (pendingRestart) {
    banners.push(
      <div class="banner tone-ok" key="restart">
        <span class="banner-icon">
          <Icon name="checkCircle" size={16} />
        </span>
        <div class="banner-text">
          <strong>Updated to v{pendingRestart}.</strong> Restart the rotator process to run the new version.
        </div>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            writePref("updatePendingRestart", null);
            setPendingRestart("");
          }}
        >
          Dismiss
        </Button>
      </div>,
    );
  } else if (update?.updateAvailable && update.latestVersion && dismissed !== update.latestVersion) {
    const latest = update.latestVersion;
    banners.push(
      <div class="banner tone-info" key="update">
        <span class="banner-icon">
          <Icon name="download" size={16} />
        </span>
        <div class="banner-text">
          <strong>Version {latest} is available.</strong> You are running v{update.currentVersion}.
        </div>
        <div class="banner-actions">
          <a class="btn btn-ghost btn-sm" href="https://github.com/tuxevil/tuxevil-rotator/releases" target="_blank" rel="noopener noreferrer">
            Changelog
          </a>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              writePref("updateDismissed", latest);
              setDismissed(latest);
            }}
          >
            Dismiss
          </Button>
          <AsyncButton
            size="sm"
            variant="primary"
            onClick={async () => {
              try {
                const result = await api.selfUpdate();
                if (result.ok && result.to) {
                  writePref("updatePendingRestart", result.to);
                  setPendingRestart(result.to);
                } else toast(`Update failed: ${result.message || "unknown error"}`, "error");
              } catch (err) {
                toast(`Update failed: ${err instanceof Error ? err.message : String(err)}`, "error");
              }
            }}
          >
            Update now
          </AsyncButton>
        </div>
      </div>,
    );
  }

  for (const notice of data.notifications) {
    if (hiddenNotices.includes(notice.id) || readPref(`notif-dismissed-${notice.id}`, "")) continue;
    const tone = notice.type === "critical" ? "bad" : notice.type === "warning" ? "warn" : "info";
    let actionUrl: string | null;
    try {
      const parsed = notice.actionUrl ? new URL(notice.actionUrl, window.location.origin) : null;
      actionUrl = parsed && (parsed.protocol === "https:" || parsed.protocol === "http:") ? parsed.href : null;
    } catch {
      actionUrl = null;
    }
    banners.push(
      <div class={`banner tone-${tone}`} key={`n-${notice.id}`}>
        <span class="banner-icon">
          <Icon name={notice.type === "info" ? "info" : "warning"} size={16} />
        </span>
        <div class="banner-text">
          <strong>{notice.title}</strong> {notice.message}
        </div>
        <div class="banner-actions">
          {actionUrl && (
            <a class="btn btn-ghost btn-sm" href={actionUrl} target="_blank" rel="noopener noreferrer">
              {notice.actionLabel || "Learn more"}
            </a>
          )}
          <Button
            size="sm"
            variant="ghost"
            icon="x"
            iconOnly
            onClick={() => {
              writePref(`notif-dismissed-${notice.id}`, "1");
              setHiddenNotices([...hiddenNotices, notice.id]);
            }}
          >
            Dismiss
          </Button>
        </div>
      </div>,
    );
  }

  return banners.length > 0 ? <div class="banners">{banners}</div> : null;
}

function NotFound(): JSX.Element {
  return (
    <div class="empty empty-page">
      <span class="empty-icon">
        <Icon name="search" size={20} />
      </span>
      <strong>This page does not exist.</strong>
      <Link href={BASE} class="btn btn-secondary btn-md">
        Go to the overview
      </Link>
    </div>
  );
}

// ── Sign in ─────────────────────────────────────────────────────────────

function LoginScreen(): JSX.Element {
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(() =>
    new URLSearchParams(window.location.search).get("auth") === "invalid"
      ? "That sign-in link has an invalid or outdated token."
      : null,
  );

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.has("auth")) {
      params.delete("auth");
      const rest = params.toString();
      window.history.replaceState(null, "", window.location.pathname + (rest ? `?${rest}` : ""));
    }
  }, []);

  const submit = async (event: Event) => {
    event.preventDefault();
    if (!token.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await signIn(token.trim());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div class="login">
      <div class="login-glow" aria-hidden="true" />
      <form class="login-card" onSubmit={submit}>
        <div class="login-brand">
          <LogoMark size={40} />
        </div>
        <div class="login-titles">
          <h1>Sign in to Tuxevil Rotator</h1>
          <p class="login-help">
            Paste the admin token (<code>TUXEVIL_ROTATOR_ADMIN_TOKEN</code>). Links ending in <code>?token=…</code> sign you in directly.
          </p>
        </div>
        <label class="field">
          <span class="field-label">Admin token</span>
          <input
            class="input input-lg"
            type="password"
            name="admin-token"
            autocomplete="current-password"
            value={token}
            spellcheck={false}
            autofocus
            onInput={(event) => setToken((event.target as HTMLInputElement).value)}
          />
        </label>
        {error && (
          <p class="form-error" role="alert">
            {error}
          </p>
        )}
        <Button type="submit" variant="primary" class="btn-block" loading={busy} disabled={!token.trim()}>
          Sign in
        </Button>
        <p class="login-foot">The browser keeps a session cookie for 30 days; the token itself is not stored.</p>
      </form>
    </div>
  );
}
