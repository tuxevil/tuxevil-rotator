// ⌘K command palette: jump to a page or an account, or run a quick action.

import type { JSX } from "preact";
import { useEffect, useId, useMemo, useRef, useState } from "preact/hooks";
import { accountStatus, providerIds, providerLabel } from "../lib/status.js";
import { NAV } from "../nav.js";
import { accountPath, navigate, route } from "../state/router.js";
import {
  accounts,
  authRequired,
  masked,
  masker,
  paletteOpen,
  railExpanded,
  signOut,
  theme,
} from "../state/store.js";
import { downloadUrl, openAddAccount } from "../pages/shared.js";
import { Icon, type IconName } from "./icons.js";
import { useNativeDialog } from "./overlays.js";
import { Pill } from "./ui.js";

type Group = "Pages" | "Accounts" | "Actions";

interface Command {
  id: string;
  group: Group;
  label: string;
  sub?: string;
  icon: IconName;
  haystack: string;
  run: () => void;
  trailing?: JSX.Element;
}

const GROUP_ORDER: Group[] = ["Pages", "Accounts", "Actions"];

/** The palette shortcut's modifier, as the platform labels it. */
export const MOD_KEY = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent) ? "⌘" : "Ctrl";
const ACCOUNT_PREVIEW = 6;

function matches(command: Command, terms: string[]): boolean {
  return terms.every((term) => command.haystack.includes(term));
}

function useCommands(): Command[] {
  const m = masker.value;
  const current = route.value.page;
  return useMemo(() => {
    const pages: Command[] = NAV.map((item) => ({
      id: `page-${item.id}`,
      group: "Pages",
      label: item.label,
      icon: item.icon,
      haystack: `${item.label} ${item.keywords}`.toLowerCase(),
      run: () => navigate(item.href),
      trailing: current === item.id ? <span class="palette-current">Current</span> : undefined,
    }));
    const accountCommands: Command[] = accounts.value.map((account) => {
      const name = m.name(account.email);
      const email = m.email(account.email);
      const providers = providerIds(account).map(providerLabel);
      const status = accountStatus(account.status);
      return {
        id: `account-${account.email}`,
        group: "Accounts",
        label: name,
        sub: [email !== name ? email : null, ...providers].filter(Boolean).join(" · "),
        icon: "user",
        haystack: `${name} ${m.enabled ? "" : account.email} ${providers.join(" ")} ${status.label}`.toLowerCase(),
        run: () => navigate(accountPath(account.email)),
        trailing: (
          <Pill tone={status.tone} title={status.description}>
            {status.label}
          </Pill>
        ),
      };
    });
    const themeLabel = { system: "Follow the system theme", light: "Use the light theme", dark: "Use the dark theme" } as const;
    type Action = { id: string; label: string; icon: IconName; keywords: string; run: () => void };
    const actions: Action[] = [
      { id: "add-account", label: "Add an account", icon: "plus", keywords: "new sign in login provider", run: openAddAccount },
      ...(["light", "dark", "system"] as const)
        .filter((value) => value !== theme.value)
        .map((value) => ({
          id: `theme-${value}`,
          label: themeLabel[value],
          icon: (value === "light" ? "sun" : value === "dark" ? "moon" : "monitor") as IconName,
          keywords: "theme appearance mode",
          run: () => (theme.value = value),
        })),
      {
        id: "mask",
        label: masked.value ? "Turn off the privacy mask" : "Turn on the privacy mask",
        icon: (masked.value ? "eye" : "eyeOff") as IconName,
        keywords: "privacy hide names emails screenshot",
        run: () => (masked.value = !masked.value),
      },
      {
        id: "rail",
        label: railExpanded.value ? "Collapse the sidebar" : "Expand the sidebar",
        icon: "panelLeft" as IconName,
        keywords: "sidebar rail navigation labels",
        run: () => (railExpanded.value = !railExpanded.value),
      },
      {
        id: "export-csv",
        label: "Export usage as CSV",
        icon: "download" as IconName,
        keywords: "tokens download spreadsheet",
        run: () => downloadUrl("/api/dashboard/usage/export?format=csv"),
      },
      ...(authRequired.value
        ? [{ id: "sign-out", label: "Sign out", icon: "logout" as IconName, keywords: "log out session", run: () => void signOut() }]
        : []),
    ];
    const actionCommands: Command[] = actions.map((action) => ({
      id: action.id,
      group: "Actions" as const,
      label: action.label,
      icon: action.icon,
      haystack: `${action.label} ${action.keywords}`.toLowerCase(),
      run: action.run,
    }));
    return [...pages, ...accountCommands, ...actionCommands];
  }, [accounts.value, m, current, theme.value, masked.value, railExpanded.value, authRequired.value]);
}

export function CommandPalette(): JSX.Element {
  const open = paletteOpen.value;
  const ref = useNativeDialog(open);
  const [text, setText] = useState("");
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const listId = useId();
  const commands = useCommands();

  useEffect(() => {
    if (open) {
      setText("");
      setActive(0);
    }
  }, [open]);

  const results = useMemo(() => {
    const terms = text.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const found = terms.length === 0 ? commands : commands.filter((c) => matches(c, terms));
    const grouped = GROUP_ORDER.map((group) => {
      let items = found.filter((c) => c.group === group);
      if (group === "Accounts" && terms.length === 0) items = items.slice(0, ACCOUNT_PREVIEW);
      return { group, items };
    }).filter((g) => g.items.length > 0);
    return { grouped, flat: grouped.flatMap((g) => g.items) };
  }, [commands, text]);

  useEffect(() => setActive(0), [text]);

  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const close = () => (paletteOpen.value = false);
  const runAt = (index: number) => {
    const command = results.flat[index];
    if (!command) return;
    close();
    command.run();
  };

  const onKeyDown = (event: KeyboardEvent) => {
    const count = results.flat.length;
    if (event.key === "ArrowDown" || (event.key === "n" && event.ctrlKey)) {
      event.preventDefault();
      if (count) setActive((active + 1) % count);
    } else if (event.key === "ArrowUp" || (event.key === "p" && event.ctrlKey)) {
      event.preventDefault();
      if (count) setActive((active - 1 + count) % count);
    } else if (event.key === "Enter") {
      event.preventDefault();
      runAt(active);
    }
  };

  let index = -1;
  return (
    <dialog
      ref={ref}
      class="palette"
      aria-label="Command palette"
      onClose={() => {
        if (open) close();
      }}
      onClick={(event) => {
        if (event.target === ref.current) close();
      }}
    >
      {open && (
        <div class="palette-inner">
          <div class="palette-search">
            <Icon name="search" size={17} />
            <input
              type="text"
              value={text}
              placeholder="Search pages, accounts and actions…"
              aria-label="Search pages, accounts and actions"
              role="combobox"
              aria-expanded="true"
              aria-controls={listId}
              aria-activedescendant={results.flat[active] ? `${listId}-${active}` : undefined}
              autocomplete="off"
              spellcheck={false}
              autofocus
              onInput={(event) => setText((event.target as HTMLInputElement).value)}
              onKeyDown={onKeyDown}
            />
            <kbd>Esc</kbd>
          </div>
          <div class="palette-results" id={listId} role="listbox" aria-label="Results" ref={listRef}>
            {results.flat.length === 0 ? (
              <div class="palette-empty">
                <Icon name="search" size={18} />
                <span>Nothing matches “{text.trim()}”</span>
              </div>
            ) : (
              results.grouped.map(({ group, items }) => (
                <div class="palette-group" key={group} role="presentation">
                  <div class="palette-group-label" role="presentation">
                    {group}
                  </div>
                  {items.map((command) => {
                    index += 1;
                    const i = index;
                    return (
                      <div
                        key={command.id}
                        id={`${listId}-${i}`}
                        data-index={i}
                        role="option"
                        aria-selected={i === active}
                        class={`palette-item${i === active ? " is-active" : ""}`}
                        onPointerMove={() => i !== active && setActive(i)}
                        onClick={() => runAt(i)}
                      >
                        <span class="palette-icon">
                          <Icon name={command.icon} size={16} />
                        </span>
                        <span class="palette-text">
                          <span class="palette-label">{command.label}</span>
                          {command.sub && <span class="palette-sub">{command.sub}</span>}
                        </span>
                        {command.trailing}
                        <span class="palette-enter" aria-hidden="true">
                          <Icon name="cornerDownLeft" size={14} />
                        </span>
                      </div>
                    );
                  })}
                </div>
              ))
            )}
          </div>
          <div class="palette-foot" aria-hidden="true">
            <span>
              <kbd>↑</kbd>
              <kbd>↓</kbd> to move
            </span>
            <span>
              <kbd>↵</kbd> to open
            </span>
            <span class="palette-foot-end">
              <kbd>{MOD_KEY}</kbd>
              <kbd>K</kbd> anywhere
            </span>
          </div>
        </div>
      )}
    </dialog>
  );
}
