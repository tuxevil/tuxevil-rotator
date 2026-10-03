import { overview } from "../state/store.js";

/** Account sign-in lives on the server-rendered login pages; open it in a new tab. */
export function openAddAccount(): void {
  const path = overview.value?.hostedOAuthConfigured ? "/login" : "/login-cli";
  window.open(path, "_blank", "noopener");
}

export function downloadUrl(href: string): void {
  const link = document.createElement("a");
  link.href = href;
  link.rel = "noopener";
  document.body.appendChild(link);
  link.click();
  link.remove();
}

export function downloadText(filename: string, text: string, type = "application/json"): void {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
