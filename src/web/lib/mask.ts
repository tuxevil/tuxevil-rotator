// Privacy mask for screenshots and screen sharing. Names map to stable
// "Account N" aliases (ordered by email, so they survive reloads) and
// emails, keys and IPs are redacted.

export interface Masker {
  enabled: boolean;
  /** Display name for an account email or label (label when unmasked). */
  name(email: string): string;
  email(email: string | null | undefined): string;
  /** Replace any account label or email inside free text. */
  text(message: string): string;
  key(display: string | null | undefined): string;
  ip(ip: string | null | undefined): string;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Replace whole-word occurrences only, so a label like "Al" leaves "Alert" alone. */
function replaceWord(text: string, word: string, replacement: string): string {
  const start = /^\w/.test(word) ? "\\b" : "";
  const end = /\w$/.test(word) ? "\\b" : "";
  return text.replace(new RegExp(`${start}${escapeRegExp(word)}${end}`, "g"), replacement);
}

export function createMasker(
  accounts: Array<{ email: string; label?: string | null }>,
  enabled: boolean,
): Masker {
  const labels = new Map(accounts.map((a) => [a.email, a.label || a.email]));
  const aliases = new Map<string, string>();
  [...accounts]
    .map((a) => a.email)
    .sort((a, b) => a.localeCompare(b))
    .forEach((email, i) => aliases.set(email, `Account ${i + 1}`));
  const keyAliases = new Map<string, string>();
  // Request logs and benchmark rows identify an account by its label.
  const emailByLabel = new Map<string, string>();
  for (const [email, label] of labels) if (!labels.has(label)) emailByLabel.set(label, email);

  const alias = (email: string): string => {
    let value = aliases.get(email);
    if (!value) {
      value = `Account ${aliases.size + 1}`;
      aliases.set(email, value);
    }
    return value;
  };

  return {
    enabled,
    name(account) {
      if (!account) return "";
      const email = emailByLabel.get(account) ?? account;
      return enabled ? alias(email) : labels.get(email) ?? email;
    },
    email(email) {
      if (!email) return "";
      if (!enabled) return email;
      if (!email.includes("@")) return "•••";
      return `${alias(email).toLowerCase().replace(/ /g, "-")}@•••`;
    },
    text(message) {
      if (!enabled || !message) return message;
      let out = message;
      for (const [email, label] of labels) {
        const replacement = alias(email);
        out = out.split(email).join(replacement);
        if (label && label !== email) out = replaceWord(out, label, replacement);
      }
      return out.replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, "•••@•••");
    },
    key(display) {
      if (!display) return "";
      if (!enabled || display === "unauthenticated") return display;
      if (display.startsWith("rk-")) return "rk-•••";
      let value = keyAliases.get(display);
      if (!value) {
        value = `Key ${keyAliases.size + 1}`;
        keyAliases.set(display, value);
      }
      return value;
    },
    ip(ip) {
      if (!ip || ip === "-") return ip || "";
      if (!enabled) return ip;
      const parts = ip.split(".");
      return parts.length === 4 ? `${parts[0]}.${parts[1]}.x.x` : "•••";
    },
  };
}
