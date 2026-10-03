// Small presentational building blocks shared by every page.

import type { ComponentChildren, JSX } from "preact";
import { useState } from "preact/hooks";
import type { AccountState, Tone } from "../lib/status.js";
import { accountStatus, providerLabel } from "../lib/status.js";
import { formatDuration, formatRelative } from "../lib/format.js";
import { navigate } from "../state/router.js";
import { now } from "../state/store.js";
import { Icon, type IconName } from "./icons.js";

type ButtonProps = Omit<JSX.HTMLAttributes<HTMLButtonElement>, "icon" | "size"> & {
  variant?: "primary" | "secondary" | "ghost" | "danger";
  size?: "sm" | "md";
  icon?: IconName;
  iconOnly?: boolean;
  loading?: boolean;
  disabled?: boolean;
  type?: "button" | "submit";
};

export function Button({
  variant = "secondary",
  size = "md",
  icon,
  iconOnly,
  loading,
  disabled,
  children,
  class: className,
  type = "button",
  ...rest
}: ButtonProps): JSX.Element {
  return (
    <button
      type={type}
      class={`btn btn-${variant} btn-${size}${iconOnly ? " btn-icon" : ""}${loading ? " is-loading" : ""}${className ? ` ${className}` : ""}`}
      disabled={disabled || loading}
      aria-busy={loading ? "true" : undefined}
      {...rest}
    >
      {icon && <Icon name={icon} size={size === "sm" ? 14 : 16} />}
      {children && <span class={iconOnly ? "sr-only" : undefined}>{children}</span>}
    </button>
  );
}

/** Runs an async handler and shows a busy state until it settles. */
export function AsyncButton({
  onClick,
  ...props
}: Omit<ButtonProps, "onClick"> & { onClick: () => Promise<unknown> | unknown }): JSX.Element {
  const [busy, setBusy] = useState(false);
  return (
    <Button
      {...props}
      loading={busy || props.loading}
      onClick={async () => {
        setBusy(true);
        try {
          await onClick();
        } finally {
          setBusy(false);
        }
      }}
    />
  );
}

export function Link({
  href,
  children,
  class: className,
  title,
  onClick,
  ...rest
}: Omit<JSX.HTMLAttributes<HTMLAnchorElement>, "onClick"> & {
  href: string;
  onClick?: (event: MouseEvent) => void;
}): JSX.Element {
  return (
    <a
      href={href}
      class={className}
      title={title}
      {...rest}
      onClick={(event) => {
        onClick?.(event);
        if (
          event.defaultPrevented ||
          event.button !== 0 ||
          event.metaKey ||
          event.ctrlKey ||
          event.shiftKey ||
          event.altKey
        )
          return;
        event.preventDefault();
        navigate(href);
      }}
    >
      {children}
    </a>
  );
}

export function Pill({
  tone = "neutral",
  children,
  dot = true,
  title,
}: {
  tone?: Tone;
  children: ComponentChildren;
  dot?: boolean;
  title?: string;
}): JSX.Element {
  return (
    <span class={`pill tone-${tone}`} title={title}>
      {dot && <span class="pill-dot" aria-hidden="true" />}
      {children}
    </span>
  );
}

export function StatusPill({ status }: { status: AccountState }): JSX.Element {
  const meta = accountStatus(status);
  return (
    <Pill tone={meta.tone} title={meta.description}>
      {meta.label}
    </Pill>
  );
}

export function Tag({ children, title }: { children: ComponentChildren; title?: string }): JSX.Element {
  return (
    <span class="tag" title={title}>
      {children}
    </span>
  );
}

export function ProviderTags({ ids }: { ids: string[] }): JSX.Element {
  return (
    <span class="tag-row">
      {ids.map((id) => (
        <Tag key={id}>{providerLabel(id)}</Tag>
      ))}
    </span>
  );
}

export function Switch({
  checked,
  onChange,
  label,
  description,
  disabled,
}: {
  checked: boolean;
  onChange: (next: boolean) => void | Promise<unknown>;
  label: string;
  description?: ComponentChildren;
  disabled?: boolean;
}): JSX.Element {
  const [busy, setBusy] = useState(false);
  return (
    <div class="switch-field">
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        class={`switch${checked ? " is-on" : ""}`}
        disabled={disabled || busy}
        onClick={async () => {
          setBusy(true);
          try {
            await onChange(!checked);
          } finally {
            setBusy(false);
          }
        }}
      >
        <span class="switch-track" aria-hidden="true">
          <span class="switch-thumb" />
        </span>
        <span class="switch-label">{label}</span>
      </button>
      {description && <div class="switch-description">{description}</div>}
    </div>
  );
}

export function Segmented<T extends string>({
  options,
  value,
  onChange,
  label,
  size = "md",
  class: className,
}: {
  options: Array<{ value: T; label: ComponentChildren; title?: string }>;
  value: T;
  onChange: (value: T) => void;
  label: string;
  size?: "sm" | "md";
  class?: string;
}): JSX.Element {
  return (
    <div class={`segmented segmented-${size}${className ? ` ${className}` : ""}`} role="group" aria-label={label}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          class={option.value === value ? "is-active" : undefined}
          aria-pressed={option.value === value}
          title={option.title}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

export function Panel({
  title,
  subtitle,
  actions,
  children,
  id,
  flush,
  class: className,
}: {
  title?: ComponentChildren;
  subtitle?: ComponentChildren;
  actions?: ComponentChildren;
  children: ComponentChildren;
  id?: string;
  flush?: boolean;
  class?: string;
}): JSX.Element {
  return (
    <section class={`panel${flush ? " panel-flush" : ""}${className ? ` ${className}` : ""}`} id={id}>
      {(title || actions) && (
        <header class="panel-head">
          <div class="panel-titles">
            {title && <h2 class="panel-title">{title}</h2>}
            {subtitle && <p class="panel-subtitle">{subtitle}</p>}
          </div>
          {actions && <div class="panel-actions">{actions}</div>}
        </header>
      )}
      <div class="panel-body">{children}</div>
    </section>
  );
}

export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: ComponentChildren;
  actions?: ComponentChildren;
}): JSX.Element {
  return (
    <header class="page-head">
      <div>
        <h1 class="page-title">{title}</h1>
        {description && <p class="page-description">{description}</p>}
      </div>
      {actions && <div class="page-actions">{actions}</div>}
    </header>
  );
}

export function EmptyState({
  icon = "info",
  title,
  children,
  action,
}: {
  icon?: IconName;
  title: string;
  children?: ComponentChildren;
  action?: ComponentChildren;
}): JSX.Element {
  return (
    <div class="empty">
      <span class="empty-icon">
        <Icon name={icon} size={18} />
      </span>
      <strong>{title}</strong>
      {children && <p>{children}</p>}
      {action}
    </div>
  );
}

export function quotaTone(percent: number): Tone {
  if (percent <= 0) return "bad";
  if (percent < 20) return "warn";
  return "neutral";
}

/** Quota bar: neutral unless the pool is low (amber) or empty (red). */
export function Meter({
  value,
  label,
  tone,
  size = "md",
}: {
  value: number;
  label: string;
  tone?: Tone;
  size?: "sm" | "md";
}): JSX.Element {
  const clamped = Math.max(0, Math.min(100, Math.round(value)));
  const resolved = tone ?? quotaTone(clamped);
  return (
    <span
      class={`meter meter-${size} tone-${resolved}`}
      role="meter"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={clamped}
      aria-label={label}
    >
      <span class="meter-fill" style={{ width: `${clamped}%` }} />
    </span>
  );
}

export function Countdown({ until, fallback = "—" }: { until: number | null | undefined; fallback?: string }): JSX.Element {
  const remaining = (until ?? 0) - now.value;
  return (
    <span class="num" title={until ? new Date(until).toLocaleString() : undefined}>
      {remaining > 0 ? formatDuration(remaining) : fallback}
    </span>
  );
}

export function RelativeTime({ ts }: { ts: number | null | undefined }): JSX.Element {
  return (
    <span title={ts ? new Date(ts).toLocaleString() : "Never"}>{formatRelative(ts, now.value)}</span>
  );
}

export function Stat({
  label,
  value,
  sub,
  tone,
}: {
  label: ComponentChildren;
  value: ComponentChildren;
  sub?: ComponentChildren;
  tone?: Tone;
}): JSX.Element {
  return (
    <div class={`stat${tone ? ` tone-${tone}` : ""}`}>
      <div class="stat-label">{label}</div>
      <div class="stat-value num">{value}</div>
      {sub && <div class="stat-sub">{sub}</div>}
    </div>
  );
}

export function KeyValue({ items }: { items: Array<[ComponentChildren, ComponentChildren]> }): JSX.Element {
  return (
    <dl class="kv">
      {items.map(([key, value], i) => (
        <div class="kv-row" key={i}>
          <dt>{key}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

export function SearchInput({
  value,
  onInput,
  placeholder,
  label,
  inputRef,
  shortcut,
}: {
  value: string;
  onInput: (value: string) => void;
  placeholder: string;
  label: string;
  inputRef?: { current: HTMLInputElement | null };
  /** Key that focuses the field, shown while it is empty. */
  shortcut?: string;
}): JSX.Element {
  return (
    <label class="search">
      <Icon name="search" size={15} />
      <input
        ref={inputRef}
        type="search"
        value={value}
        placeholder={placeholder}
        aria-label={label}
        autocomplete="off"
        spellcheck={false}
        onInput={(event) => onInput((event.target as HTMLInputElement).value)}
      />
      {shortcut && !value && <kbd class="search-kbd">{shortcut}</kbd>}
    </label>
  );
}

export function Spinner(): JSX.Element {
  return <span class="spinner" role="status" aria-label="Loading" />;
}
