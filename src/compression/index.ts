import type { ChatMessage } from "../providers/google-antigravity/translators.js";
import { compressLite } from "./lite.js";
import { compressRTK } from "./rtk/index.js";

export type CompressionMode = "off" | "lite" | "rtk" | "rtk+lite";

export interface CompressionStats {
  mode: CompressionMode;
  originalChars: number;
  compressedChars: number;
  savedChars: number;
  savingsPercent: number;
  techniques: string[];
}

export function parseCompressionMode(
  reqHeader?: string | string[] | null,
  configDefault: string = "off",
): CompressionMode {
  const headerVal = Array.isArray(reqHeader) ? reqHeader[0] : reqHeader;
  const raw = (headerVal || configDefault || "off").trim().toLowerCase();
  if (raw === "lite") return "lite";
  if (raw === "rtk") return "rtk";
  if (raw === "rtk+lite" || raw === "lite+rtk") return "rtk+lite";
  return "off";
}

export function applyPromptCompression(
  messages: ChatMessage[],
  mode: CompressionMode,
  options?: { model?: string },
): {
  messages: ChatMessage[];
  stats: CompressionStats | null;
} {
  if (mode === "off" || !messages || messages.length === 0) {
    return { messages, stats: null };
  }

  function countChars(msgs: ChatMessage[]): number {
    let total = 0;
    for (const m of msgs) {
      if (typeof m.content === "string") {
        total += m.content.length;
      } else if (Array.isArray(m.content)) {
        for (const p of m.content) {
          if (p.type === "text" && typeof p.text === "string") {
            total += p.text.length;
          }
        }
      }
    }
    return total;
  }

  const originalChars = countChars(messages);
  let currentMessages = messages;
  const techniques: string[] = [];

  if (mode === "rtk" || mode === "rtk+lite") {
    const rtkRes = compressRTK(currentMessages);
    currentMessages = rtkRes.messages;
    if (rtkRes.compressed) {
      techniques.push("rtk");
    }
  }

  if (mode === "lite" || mode === "rtk+lite") {
    const liteRes = compressLite(currentMessages, options);
    currentMessages = liteRes.messages;
    techniques.push(...liteRes.techniques);
  }

  const compressedChars = countChars(currentMessages);
  const savedChars = Math.max(0, originalChars - compressedChars);
  const savingsPercent =
    originalChars > 0 ? Math.round((savedChars / originalChars) * 100) : 0;

  const stats: CompressionStats = {
    mode,
    originalChars,
    compressedChars,
    savedChars,
    savingsPercent,
    techniques,
  };

  return {
    messages: currentMessages,
    stats,
  };
}
