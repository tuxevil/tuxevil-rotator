// Dialogs, the side drawer, pop-up menus, confirmations and toasts.
// Dialog and Drawer use the native <dialog> element: focus is trapped,
// Escape closes it and focus returns to the opener.

import type { ComponentChildren, JSX } from "preact";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "preact/hooks";
import { confirmRequest, dismissToast, toasts } from "../state/actions.js";
import { Button } from "./ui.js";
import { Icon, type IconName } from "./icons.js";

export function useNativeDialog(open: boolean) {
  const ref = useRef<HTMLDialogElement>(null);
  useLayoutEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    else if (!open && dialog.open) dialog.close();
  }, [open]);
  return ref;
}

export function Dialog({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  size = "md",
}: {
  open: boolean;
  onClose: () => void;
  title: ComponentChildren;
  description?: ComponentChildren;
  children?: ComponentChildren;
  footer?: ComponentChildren;
  size?: "sm" | "md" | "lg";
}): JSX.Element {
  const ref = useNativeDialog(open);
  const titleId = useId();
  return (
    <dialog
      ref={ref}
      class={`dialog dialog-${size}`}
      aria-labelledby={titleId}
      onClose={() => {
        if (open) onClose();
      }}
      onClick={(event) => {
        if (event.target === ref.current) onClose();
      }}
    >
      {open && (
        <div class="dialog-inner">
          <header class="dialog-head">
            <div>
              <h2 class="dialog-title" id={titleId}>
                {title}
              </h2>
              {description && <p class="dialog-description">{description}</p>}
            </div>
            <Button variant="ghost" size="sm" icon="x" iconOnly onClick={onClose}>
              Close
            </Button>
          </header>
          {children && <div class="dialog-body">{children}</div>}
          {footer && <footer class="dialog-foot">{footer}</footer>}
        </div>
      )}
    </dialog>
  );
}

export function Drawer({
  open,
  onClose,
  label,
  children,
}: {
  open: boolean;
  onClose: () => void;
  label: string;
  children?: ComponentChildren;
}): JSX.Element {
  const ref = useNativeDialog(open);
  return (
    <dialog
      ref={ref}
      class="drawer"
      aria-label={label}
      onClose={() => {
        if (open) onClose();
      }}
      onClick={(event) => {
        if (event.target === ref.current) onClose();
      }}
    >
      {open && <div class="drawer-inner">{children}</div>}
    </dialog>
  );
}

export type Placement = "bottom-end" | "bottom-start" | "right-end";

type LayerPosition = { top?: number; bottom?: number; left?: number; right?: number };

function placeLayer(rect: DOMRect, placement: Placement): LayerPosition {
  switch (placement) {
    case "bottom-start":
      return { top: rect.bottom + 6, left: Math.max(8, rect.left) };
    case "right-end":
      return { bottom: Math.max(8, window.innerHeight - rect.bottom), left: rect.right + 10 };
    default:
      return { top: rect.bottom + 6, right: Math.max(8, window.innerWidth - rect.right) };
  }
}

function layerStyle(position: LayerPosition): Record<string, string> {
  const style: Record<string, string> = {};
  for (const [key, value] of Object.entries(position)) if (value !== undefined) style[key] = `${value}px`;
  return style;
}

/**
 * A floating layer anchored to a trigger button: closes on an outside
 * pointer, Escape, scroll or resize, and returns focus to the trigger.
 */
function useAnchoredLayer(placement: Placement, focusSelector: string) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<LayerPosition | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const layerRef = useRef<HTMLDivElement>(null);

  const close = (focusButton = false) => {
    setOpen(false);
    if (focusButton) buttonRef.current?.focus();
  };

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: Event) => {
      const target = event.target as Node;
      if (layerRef.current?.contains(target) || buttonRef.current?.contains(target)) return;
      close();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        close(true);
      }
    };
    const onScroll = (event: Event) => {
      if (layerRef.current?.contains(event.target as Node)) return;
      close();
    };
    const onResize = () => close();
    document.addEventListener("pointerdown", onPointer, true);
    document.addEventListener("keydown", onKey, true);
    window.addEventListener("resize", onResize);
    window.addEventListener("scroll", onScroll, true);
    const layer = layerRef.current;
    (layer?.querySelector<HTMLElement>("[data-autofocus]") ?? layer?.querySelector<HTMLElement>(focusSelector))?.focus();
    return () => {
      document.removeEventListener("pointerdown", onPointer, true);
      document.removeEventListener("keydown", onKey, true);
      window.removeEventListener("resize", onResize);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [open]);

  const toggle = () => {
    if (open) return close();
    const rect = buttonRef.current?.getBoundingClientRect();
    if (rect) setPosition(placeLayer(rect, placement));
    setOpen(true);
  };

  return { open, position, buttonRef, layerRef, close, toggle };
}

export type MenuItem =
  | {
      label: string;
      onSelect: () => void;
      icon?: IconName;
      danger?: boolean;
      disabled?: boolean;
      /** Radio items mark the current choice; checkbox items toggle. */
      checked?: boolean;
      kind?: "radio" | "checkbox";
      hint?: string;
    }
  | { heading: string }
  | "separator";

export function Menu({
  label,
  icon = "more",
  text,
  items,
  size = "sm",
  placement = "bottom-end",
  trigger,
  triggerClass,
  header,
}: {
  label: string;
  icon?: IconName;
  text?: string;
  items: MenuItem[];
  size?: "sm" | "md";
  placement?: Placement;
  /** Replaces the default icon button content. */
  trigger?: ComponentChildren;
  triggerClass?: string;
  header?: ComponentChildren;
}): JSX.Element {
  const layer = useAnchoredLayer(placement, "button:not([disabled])");

  const onMenuKey = (event: KeyboardEvent) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    const buttons = [...(layer.layerRef.current?.querySelectorAll<HTMLButtonElement>("button:not([disabled])") ?? [])];
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.key === "ArrowDown" ? index + 1 : index - 1;
    buttons[(next + buttons.length) % buttons.length]?.focus();
  };

  return (
    <span class="menu-anchor">
      <button
        ref={layer.buttonRef}
        type="button"
        class={triggerClass ?? `btn btn-ghost btn-${size}${text ? "" : " btn-icon"}`}
        aria-haspopup="menu"
        aria-expanded={layer.open}
        aria-label={text ? undefined : label}
        title={trigger ? undefined : label}
        onClick={layer.toggle}
      >
        {trigger ?? (
          <>
            <Icon name={icon} size={size === "sm" ? 15 : 16} />
            {text && <span>{text}</span>}
          </>
        )}
      </button>
      {layer.open && layer.position && (
        <div
          ref={layer.layerRef}
          class={`menu menu-${placement}`}
          role="menu"
          aria-label={label}
          style={layerStyle(layer.position)}
          onKeyDown={onMenuKey}
        >
          {header && <div class="menu-header">{header}</div>}
          {items.map((item, i) => {
            if (item === "separator") return <div key={`sep-${i}`} class="menu-sep" role="separator" />;
            if ("heading" in item)
              return (
                <div key={`h-${item.heading}`} class="menu-heading" role="presentation">
                  {item.heading}
                </div>
              );
            const role =
              item.checked === undefined ? "menuitem" : item.kind === "checkbox" ? "menuitemcheckbox" : "menuitemradio";
            return (
              <button
                key={item.label}
                type="button"
                role={role}
                aria-checked={item.checked}
                class={`menu-item${item.danger ? " is-danger" : ""}${item.checked ? " is-checked" : ""}`}
                disabled={item.disabled}
                onClick={() => {
                  layer.close(true);
                  item.onSelect();
                }}
              >
                <span class="menu-icon">{item.icon ? <Icon name={item.icon} size={15} /> : null}</span>
                <span class="menu-label">{item.label}</span>
                {item.hint && <span class="menu-hint">{item.hint}</span>}
                {item.checked && (
                  <span class="menu-check">
                    <Icon name="check" size={14} strokeWidth={2.25} />
                  </span>
                )}
              </button>
            );
          })}
        </div>
      )}
    </span>
  );
}

/** A non-modal panel anchored to a trigger button (the inbox, the support note). */
export function Popover({
  label,
  trigger,
  triggerClass,
  triggerTitle,
  placement = "bottom-end",
  class: className,
  children,
}: {
  label: string;
  trigger: ComponentChildren;
  triggerClass: string;
  triggerTitle?: string;
  placement?: Placement;
  class?: string;
  children: (close: () => void) => ComponentChildren;
}): JSX.Element {
  const layer = useAnchoredLayer(placement, "a[href], button:not([disabled])");
  return (
    <span class="menu-anchor">
      <button
        ref={layer.buttonRef}
        type="button"
        class={triggerClass}
        aria-haspopup="dialog"
        aria-expanded={layer.open}
        aria-label={label}
        title={triggerTitle}
        onClick={layer.toggle}
      >
        {trigger}
      </button>
      {layer.open && layer.position && (
        <div
          ref={layer.layerRef}
          class={`popover popover-${placement}${className ? ` ${className}` : ""}`}
          role="dialog"
          aria-label={label}
          style={layerStyle(layer.position)}
        >
          {children(() => layer.close(true))}
        </div>
      )}
    </span>
  );
}

export function ConfirmHost(): JSX.Element {
  const request = confirmRequest.value;
  const [typed, setTyped] = useState("");
  useEffect(() => setTyped(""), [request]);
  const settle = (ok: boolean) => {
    request?.resolve(ok);
    confirmRequest.value = null;
  };
  const blocked = Boolean(request?.typeToConfirm) && typed.trim().toLowerCase() !== request?.typeToConfirm;
  return (
    <Dialog
      open={Boolean(request)}
      onClose={() => settle(false)}
      title={request?.title ?? ""}
      size="sm"
      footer={
        <>
          <Button onClick={() => settle(false)}>Cancel</Button>
          <Button
            variant={request?.danger ? "danger" : "primary"}
            disabled={blocked}
            onClick={() => settle(true)}
          >
            {request?.confirmLabel ?? "Confirm"}
          </Button>
        </>
      }
    >
      <p class="confirm-body">{request?.body}</p>
      {request?.typeToConfirm && (
        <label class="field">
          <span class="field-label">
            Type <code>{request.typeToConfirm}</code> to confirm
          </span>
          <input
            class="input"
            value={typed}
            autocomplete="off"
            spellcheck={false}
            onInput={(event) => setTyped((event.target as HTMLInputElement).value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !blocked) settle(true);
            }}
          />
        </label>
      )}
    </Dialog>
  );
}

const TOAST_ICONS: Record<string, IconName> = {
  success: "checkCircle",
  error: "critical",
  info: "info",
};

/**
 * Toasts live in a manual popover so they render in the top layer, above
 * an open drawer or dialog. Re-showing moves them to the front.
 */
export function ToastHost(): JSX.Element {
  const ref = useRef<HTMLDivElement>(null);
  const items = toasts.value;
  useLayoutEffect(() => {
    const el = ref.current as (HTMLDivElement & { showPopover?: () => void; hidePopover?: () => void }) | null;
    if (!el || typeof el.showPopover !== "function") return;
    try {
      if (el.matches(":popover-open")) el.hidePopover!();
      if (items.length > 0) el.showPopover();
    } catch {
      // popover unsupported or detached; the fixed-position fallback still works
    }
  }, [items]);
  return (
    <div ref={ref} popover="manual" class="toasts" role="region" aria-label="Notifications" aria-live="polite">
      {items.map((t) => (
        <div key={t.id} class={`toast toast-${t.tone}`} role={t.tone === "error" ? "alert" : "status"}>
          <Icon name={TOAST_ICONS[t.tone]} size={16} />
          <span class="toast-message">{t.message}</span>
          <button type="button" class="toast-close" aria-label="Dismiss" onClick={() => dismissToast(t.id)}>
            <Icon name="x" size={14} />
          </button>
        </div>
      ))}
    </div>
  );
}
