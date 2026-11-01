import type { ChatMessage } from "../../providers/google-antigravity/translators.js";
import {
  extractPreservedBlocks,
  restorePreservedBlocks,
} from "../preservation.js";
import { detectCommandType } from "./command-detector.js";
import { matchRtkFilter } from "./filter-loader.js";
import { applyLineFilter } from "./line-filter.js";

export interface RtkCompressionResult {
  messages: ChatMessage[];
  compressed: boolean;
  techniquesUsed: string[];
  appliedRules: string[];
  linesStripped: number;
}

function isToolOrTerminalMessage(msg: ChatMessage): boolean {
  if (msg.role === "tool") return true;
  if (typeof msg.content === "string") {
    // Check if string content has tool output markers
    if (msg.content.includes("Command output:") || msg.content.includes("stdout:") || msg.content.includes("stderr:")) {
      return true;
    }
  }
  return false;
}

export function compressRTK(
  messages: ChatMessage[],
  options?: {
    enabledFilters?: string[];
    disabledFilters?: string[];
    maxLinesPerResult?: number;
  },
): RtkCompressionResult {
  const techniquesUsed: string[] = [];
  const appliedRules: string[] = [];
  let linesStripped = 0;
  let compressed = false;

  const resultMessages = messages.map((msg) => {
    if (!isToolOrTerminalMessage(msg)) return msg;

    let contentText = "";
    if (typeof msg.content === "string") {
      contentText = msg.content;
    } else if (Array.isArray(msg.content)) {
      contentText = msg.content
        .map((part) => (typeof part === "string" ? part : part.text || ""))
        .join("\n");
    }

    if (!contentText || contentText.length < 100) return msg;

    // Preserve code, URLs, paths etc. before filtering lines
    const preservation = extractPreservedBlocks(contentText);

    const detection = detectCommandType(preservation.text);
    const filter = matchRtkFilter(detection.type, detection.command, preservation.text);

    if (!filter) return msg;

    if (
      options?.disabledFilters &&
      options.disabledFilters.includes(filter.id)
    ) {
      return msg;
    }

    const filterRes = applyLineFilter(preservation.text, filter);
    linesStripped += filterRes.strippedLines;

    if (filterRes.strippedLines > 0 || filterRes.appliedRules.length > 0) {
      compressed = true;
      if (!techniquesUsed.includes(`rtk:${filter.id}`)) {
        techniquesUsed.push(`rtk:${filter.id}`);
      }
      appliedRules.push(...filterRes.appliedRules);
    }

    const restoredText = restorePreservedBlocks(
      filterRes.text,
      preservation.blocks,
    );

    return {
      ...msg,
      content: restoredText,
    };
  });

  return {
    messages: resultMessages,
    compressed,
    techniquesUsed,
    appliedRules,
    linesStripped,
  };
}
