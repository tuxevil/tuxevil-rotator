// Chart colors by model family: Claude reds, Gemini blues, Codex ambers,
// Ollama greens. Darker shades are the more expensive models.

const MODEL_COLORS: Record<string, string> = {
  // Claude pool, most to least expensive
  "claude-opus-4-6-thinking": "#b91c1c",
  "claude-opus-4-5-thinking": "#b91c1c",
  "claude-opus-4-5": "#b91c1c",
  "claude-opus-5-5": "#dc2626",
  "claude-opus-5-5-high": "#dc2626",
  "claude-opus-5-5-medium": "#dc2626",
  "claude-opus-5-5-low": "#dc2626",
  "claude-sonnet-4-6": "#ef4444",
  "claude-sonnet-4-6-thinking": "#ef4444",
  "claude-sonnet-4-5": "#ef4444",
  "claude-sonnet-4-5-thinking": "#ef4444",
  "claude-sonnet-5-5": "#f87171",
  "claude-sonnet-5-5-high": "#f87171",
  "claude-sonnet-5-5-medium": "#f87171",
  "claude-sonnet-5-5-low": "#f87171",
  "gpt-oss-120b-medium": "#fca5a5",
  "gpt-oss-120b": "#fca5a5",

  // Gemini pool, most to least expensive
  "gemini-4-carbon": "#1e3a8a",
  "gemini-4-carbon-disabled": "#1e3a8a",
  "gemini-4-carbon-high": "#1e3a8a",
  "gemini-4-carbon-medium": "#1e40af",
  "gemini-4-carbon-low": "#1d4ed8",
  "gemini-4-neon": "#4338ca",
  "gemini-4-neon-disabled": "#4338ca",
  "gemini-4-neon-xhigh": "#3730a3",
  "gemini-4-neon-high": "#4338ca",
  "gemini-4-neon-medium": "#4f46e5",
  "gemini-4-neon-low": "#6366f1",
  "gemini-4-argon": "#2563eb",
  "gemini-4-argon-disabled": "#60a5fa",
  "gemini-4-argon-high": "#2563eb",
  "gemini-4-argon-medium": "#3b82f6",
  "gemini-4-argon-low": "#60a5fa",
  "gemini-4-hydrogen": "#0369a1",
  "gemini-4-hydrogen-disabled": "#0ea5e9",
  "gemini-4-hydrogen-xhigh": "#0c4a6e",
  "gemini-4-hydrogen-high": "#0369a1",
  "gemini-4-hydrogen-medium": "#0ea5e9",
  "gemini-4-hydrogen-low": "#38bdf8",
  "gemini-4-hydrogen-tiered": "#0369a1",
  "gemini-4-hydrogen-tiered-xhigh": "#0c4a6e",
  "gemini-4-hydrogen-tiered-high": "#0369a1",
  "gemini-4-hydrogen-sonar": "#0ea5e9",
  "gemini-3.1-pro": "#3b82f6",
  "gemini-3.1-pro-high": "#3b82f6",
  "gemini-3.1-pro-low": "#3b82f6",
  "gemini-3-pro-high": "#3b82f6",
  "gemini-3-pro-low": "#3b82f6",
  "gemini-3.6-flash": "#38bdf8",
  "gemini-3.6-flash-high": "#38bdf8",
  "gemini-3.6-flash-medium": "#38bdf8",
  "gemini-3.6-flash-low": "#38bdf8",
  "gemini-3.6-flash-tiered": "#38bdf8",
  "gemini-3.8-flash": "#0284c7",
  "gemini-3.8-flash-tiered": "#0284c7",
  "gemini-3.8-flash-high": "#0284c7",
  "gemini-3.8-flash-medium": "#0284c7",
  "gemini-3.8-flash-low": "#0284c7",
  "gemini-3-flash-agent": "#93c5fd",
  "gemini-3-flash": "#93c5fd",

  // Codex pool, most to least expensive
  "gpt-6-astra": "#713f12",
  "gpt-6.2-astra": "#854d0e",
  "gpt-6-sol": "#a16207",
  "gpt-6.2-sol": "#b45309",
  "gpt-6.1-sol": "#ca8a04",
  "gpt-6.1-terra": "#facc15",
  "gpt-6-luna": "#fde047",
  "gpt-5.6-sol": "#a16207",
  "gpt-5.6-terra": "#eab308",
  "gpt-5.6-luna": "#fde047",

  // Ollama pool, most to least expensive
  "kimi-k3": "#047857",
  "kimi-k3.1-pro": "#047857",
  "kimi-k2.7-code": "#047857",
  "kimi-k2.6": "#047857",
  "muse-spark-open": "#065f46",
  "hy4": "#059669",
  "qwen3.5:397b": "#0f766e",
  "glm-5.3": "#10b981",
  "glm-5.3-flash": "#34d399",
  "glm-5.2": "#10b981",
  "glm-5.1": "#10b981",
  "nemotron-3-ultra": "#15803d",
  "nemotron-3-super": "#15803d",
  "mistral-large-4": "#22c55e",
  "mistral-large-3:675b": "#22c55e",
  "nemotron-3-nano:30b": "#22c55e",
  "mimo-v2.6-pro": "#16a34a",
  "mimo-v2.6-flash": "#4ade80",
  "gemma4:31b": "#65a30d",
  "minimax-m3": "#84cc16",
  "minimax-m2.7": "#84cc16",
  "minimax-m3.1-flash": "#a3e635",
  "deepseek-v4-pro": "#2dd4bf",
  "deepseek-v4.1-flash": "#5eead4",
  "deepseek-v4.1-flash:1017": "#5eead4",
  "inkling-2-small": "#6ee7b7",
  "gpt-oss:120b": "#86efac",
  "deepseek-v4-flash:preview": "#5eead4",
  "deepseek-v4-flash:0731": "#5eead4",
  "beam": "#bef264",
  "gpt-oss:20b": "#dcfce7",

  __other__: "#10b981",
};

export function modelColor(model: string | null | undefined): string {
  if (!model) return MODEL_COLORS["__other__"];
  if (MODEL_COLORS[model]) return MODEL_COLORS[model];

  const lower = model.toLowerCase();
  // Family fallbacks for models without an explicit color.
  // Claude pool
  if (lower.indexOf("opus-5-5") !== -1 || lower.indexOf("opus-5.5") !== -1) return "#dc2626";
  if (lower.indexOf("opus") !== -1) return "#b91c1c";
  if (lower.indexOf("sonnet-5-5") !== -1 || lower.indexOf("sonnet-5.5") !== -1) return "#f87171";
  if (lower.indexOf("sonnet") !== -1 || lower.indexOf("claude") !== -1) return "#ef4444";
  if (lower === "gpt-oss-120b" || lower === "gpt-oss-120b-medium") return "#fca5a5";

  // Gemini pool
  if (lower.indexOf("4-carbon") !== -1) return "#1e3a8a";
  if (lower.indexOf("4-neon") !== -1) return "#4338ca";
  if (lower.indexOf("4-argon") !== -1) return "#2563eb";
  if (lower.indexOf("4-hydrogen") !== -1) return "#0369a1";
  if (lower.indexOf("3.1-pro") !== -1 || lower.indexOf("3-pro") !== -1) return "#3b82f6";
  if (lower.indexOf("3.8-flash") !== -1) return "#0284c7";
  if (lower.indexOf("3.6-flash") !== -1) return "#38bdf8";
  if (lower.indexOf("gemini") !== -1 || lower.indexOf("3-flash") !== -1) return "#93c5fd";

  // Codex pool
  if (lower.indexOf("gpt-6.2-astra") !== -1) return "#854d0e";
  if (lower.indexOf("gpt-6-astra") !== -1) return "#713f12";
  if (lower.indexOf("gpt-6.2-sol") !== -1) return "#b45309";
  if (lower.indexOf("gpt-6.1-sol") !== -1) return "#ca8a04";
  if (lower.indexOf("gpt-6-sol") !== -1) return "#a16207";
  if (lower.indexOf("gpt-6.1-terra") !== -1) return "#facc15";
  if (lower.indexOf("gpt-6-luna") !== -1) return "#fde047";
  if (lower.indexOf("gpt-5.6-sol") !== -1) return "#a16207";
  if (lower.indexOf("gpt-5.6-terra") !== -1) return "#eab308";
  if (lower.indexOf("gpt-5.6-luna") !== -1) return "#fde047";

  // Ollama pool
  if (lower.indexOf("kimi") !== -1) return "#047857";
  if (lower.indexOf("muse-spark") !== -1) return "#065f46";
  if (lower.indexOf("hy4") !== -1) return "#059669";
  if (lower.indexOf("qwen") !== -1) return "#0f766e";
  if (lower.indexOf("glm") !== -1) return "#10b981";
  if (lower.indexOf("nemotron-3-super") !== -1 || lower.indexOf("nemotron-3-ultra") !== -1) return "#15803d";
  if (lower.indexOf("mistral") !== -1 || lower.indexOf("nemotron") !== -1) return "#22c55e";
  if (lower.indexOf("mimo") !== -1) return "#16a34a";
  if (lower.indexOf("gemma") !== -1) return "#65a30d";
  if (lower.indexOf("minimax") !== -1) return "#84cc16";
  if (lower.indexOf("deepseek-v4-pro") !== -1) return "#2dd4bf";
  if (lower.indexOf("deepseek") !== -1) return "#5eead4";
  if (lower.indexOf("inkling") !== -1) return "#6ee7b7";
  if (lower.indexOf("beam") !== -1) return "#bef264";
  if (lower.indexOf("gpt-oss:120b") !== -1) return "#86efac";
  if (lower.indexOf("gpt-oss") !== -1) return "#dcfce7";

  return "#10b981";
}
