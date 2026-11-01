import {
  extractPreservedBlocks,
  restorePreservedBlocks,
} from "./preservation.js";
import type { ChatMessage } from "../providers/google-antigravity/translators.js";

export interface LiteCompressionOptions {
  /** Maximum length for tool result messages before truncation (default: 2000) */
  maxToolResultChars?: number;
  /** Replace base64 image data URLs / image parts with text placeholders (default: false) */
  replaceImages?: boolean;
  /** Deprecated compatibility option; instruction deduplication always compares complete messages. */
  maxSystemCharsHash?: number;
  /** Target model name for model-specific optimizations */
  model?: string;
}

export interface LiteCompressionResult {
  messages: ChatMessage[];
  compressed: boolean;
  techniques: string[];
  tokensSavedEstimate: number;
}

/**
 * Collapses consecutive newlines (>2 -> 2) and strips trailing whitespace per line,
 * while respecting preserved blocks (code, URLs, paths, env vars, etc.).
 */
export function collapseWhitespace(text: string): string {
  if (!text || typeof text !== "string") return text || "";
  const { text: extracted, blocks } = extractPreservedBlocks(text);
  // Collapse 3+ newlines to 2
  let processed = extracted.replace(/\n{3,}/g, "\n\n");
  // Strip trailing spaces/tabs on each line
  processed = processed.replace(/[ \t]+$/gm, "");
  return restorePreservedBlocks(processed, blocks);
}

/**
 * Applies lightweight compression. Tool-result truncation and optional image replacement are lossy.
 */
export function compressLite(
  messages: ChatMessage[],
  options: LiteCompressionOptions = {},
): LiteCompressionResult {
  if (!Array.isArray(messages) || messages.length === 0) {
    return {
      messages: messages || [],
      compressed: false,
      techniques: [],
      tokensSavedEstimate: 0,
    };
  }

  const maxToolResultChars = options.maxToolResultChars ?? 2000;
  const replaceImages = options.replaceImages ?? false;

  const techniquesUsed = new Set<string>();
  let originalCharCount = 0;
  let compressedCharCount = 0;

  // Track system prompts seen so far for deduplication
  const seenSystemPrompts = new Set<string>();

  const processedMessages: ChatMessage[] = [];

  for (const msg of messages) {
    const rawContentStr = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content);
    originalCharCount += rawContentStr.length;

    // 1. System Prompt Deduplication
    if (msg.role === "system" || msg.role === "developer") {
      const promptKey = JSON.stringify(msg);
      if (seenSystemPrompts.has(promptKey)) {
        techniquesUsed.add("dedup_system_prompt");
        continue; // Drop duplicate system prompt
      }
      seenSystemPrompts.add(promptKey);
    }

    // Clone message for modification
    let newContent = msg.content;
    let modified = false;

    // 2. Base64 Image replacement (if requested or data URL detected)
    if (replaceImages) {
      if (typeof newContent === "string") {
        if (newContent.includes("data:image/")) {
          newContent = newContent.replace(
            /data:image\/([a-zA-Z0-9+-]+);base64,[A-Za-z0-9+/=]+/g,
            (_match, format) => `[image: ${format}]`,
          );
          modified = true;
          techniquesUsed.add("replace_image_urls");
        }
      } else if (Array.isArray(newContent)) {
        const updatedParts = newContent.map((part) => {
          if (part && typeof part === "object") {
            if (part.type === "image_url" && typeof part.image_url === "object" && part.image_url) {
              const url = (part.image_url as { url?: string }).url || "";
              const match = url.match(/^data:image\/([a-zA-Z0-9+-]+);base64,/);
              const fmt = match ? match[1] : "image";
              modified = true;
              techniquesUsed.add("replace_image_urls");
              return { type: "text", text: `[image: ${fmt}]` };
            }
            if (part.type === "text" && typeof part.text === "string" && part.text.includes("data:image/")) {
              const text = part.text.replace(
                /data:image\/([a-zA-Z0-9+-]+);base64,[A-Za-z0-9+/=]+/g,
                (_m, format) => `[image: ${format}]`,
              );
              modified = true;
              techniquesUsed.add("replace_image_urls");
              return { ...part, text };
            }
          }
          return part;
        });
        if (modified) {
          newContent = updatedParts;
        }
      }
    }

    // 3. Tool Result Truncation (> maxToolResultChars)
    if (msg.role === "tool" || msg.tool_call_id) {
      if (typeof newContent === "string" && newContent.length > maxToolResultChars) {
        const { text: extracted, blocks } = extractPreservedBlocks(newContent);
        if (extracted.length > maxToolResultChars) {
          // Truncate at word boundary backoff
          let cutoff = maxToolResultChars;
          const spaceIdx = extracted.lastIndexOf(" ", cutoff);
          const newlineIdx = extracted.lastIndexOf("\n", cutoff);
          const lastBoundary = Math.max(spaceIdx, newlineIdx);
          if (lastBoundary > cutoff * 0.7) {
            cutoff = lastBoundary;
          }
          const truncatedExtracted = extracted.slice(0, cutoff) + "\n...[truncated]";
          newContent = restorePreservedBlocks(truncatedExtracted, blocks);
          modified = true;
          techniquesUsed.add("compress_tool_results");
        }
      }
    }

    // 4. Whitespace Collapsing
    if (typeof newContent === "string") {
      const collapsed = collapseWhitespace(newContent);
      if (collapsed !== newContent) {
        newContent = collapsed;
        modified = true;
        techniquesUsed.add("collapse_whitespace");
      }
    } else if (Array.isArray(newContent)) {
      const updatedParts = newContent.map((part) => {
        if (part && typeof part === "object" && part.type === "text" && typeof part.text === "string") {
          const collapsed = collapseWhitespace(part.text);
          if (collapsed !== part.text) {
            modified = true;
            techniquesUsed.add("collapse_whitespace");
            return { ...part, text: collapsed };
          }
        }
        return part;
      });
      if (modified) {
        newContent = updatedParts;
      }
    }

    const processedMsg: ChatMessage = modified
      ? { ...msg, content: newContent }
      : msg;

    // 5. Redundant Consecutive Message Removal
    if (processedMessages.length > 0) {
      const prev = processedMessages[processedMessages.length - 1];
      if (
        prev.role === processedMsg.role &&
        JSON.stringify(prev.content) === JSON.stringify(processedMsg.content) &&
        prev.name === processedMsg.name &&
        prev.tool_call_id === processedMsg.tool_call_id
      ) {
        techniquesUsed.add("remove_redundant_content");
        continue; // Skip consecutive duplicate message
      }
    }

    processedMessages.push(processedMsg);
    const newContentStr = typeof processedMsg.content === "string" ? processedMsg.content : JSON.stringify(processedMsg.content);
    compressedCharCount += newContentStr.length;
  }

  const charsSaved = Math.max(0, originalCharCount - compressedCharCount);
  // Estimate ~4 chars per token
  const tokensSavedEstimate = Math.round(charsSaved / 4);

  return {
    messages: processedMessages,
    compressed: techniquesUsed.size > 0,
    techniques: Array.from(techniquesUsed),
    tokensSavedEstimate,
  };
}
