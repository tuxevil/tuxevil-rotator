/**
 * OpenCode V2 Model Discovery Plugin for tuxevil-rotator
 *
 * Fetches the active model list from a tuxevil-rotator (or any OpenAI-compatible)
 * /v1/models endpoint and registers / refreshes the provider through the OpenCode 2
 * plugin API (`ctx.provider.transform`).
 *
 * Replaces the V1 `plugins/opencode-discovery.js`, whose function-style default
 * export OpenCode 2.x refuses to load ("Plugin must export a default definition
 * with an id and an effect or setup function").
 *
 * Options (`plugins[].options` in opencode.json):
 *   - baseURL      explicit rotator endpoint (else env, else config scan, else default)
 *   - providerID   target provider id (default "antigravity")
 *   - providerName display name (default "Antigravity (rotator)")
 *   - timeoutMs    fetch timeout (default 3500)
 *   - refreshMs    background re-discovery interval (default 600000; 0 disables)
 */

import { openCodeReasoning, openCodeVariants } from "./capabilities.mjs"

const PLUGIN_ID = "tuxevil.model-discovery"
const DEFAULT_BASE_URL = "http://127.0.0.1:51200/v1"
const DEFAULT_PROVIDER_PACKAGE = "@opencode/ai/providers/openai-compatible"

// The host provides `@opencode/plugin` at runtime and redirects the import to its
// own instance; outside OpenCode (unit tests) the import simply fails and the
// guarded helpers below fall back to plain objects.
let SDK = {}
try {
  SDK = await import("@opencode/plugin")
} catch {
  SDK = {}
}

function makeModelID(id) {
  try {
    return SDK?.Model?.ID?.make?.(id) ?? id
  } catch {
    return id
  }
}

function makeProviderID(id) {
  try {
    return SDK?.Provider?.ID?.make?.(id) ?? id
  } catch {
    return id
  }
}

function modelInfoDefault(providerID, id) {
  try {
    return SDK?.Model?.Info?.default?.(makeProviderID(providerID), makeModelID(id)) ?? {}
  } catch {
    return {}
  }
}

function providerInfoEmpty(providerID) {
  try {
    return SDK?.Provider?.Info?.empty?.(makeProviderID(providerID)) ?? {}
  } catch {
    return {}
  }
}

/**
 * Normalizes the many shapes a provider collection can take into
 * `{ id, name, baseURL }` records.
 *
 * Accepted inputs:
 *   - V2 `ctx.provider.list()` output (array or `{ providers }`)
 *   - V2 provider records (`{ info: { name, settings: { baseURL } } }`)
 *   - V1 `config.provider` maps (`{ [id]: { name, options: { baseURL } } }`)
 */
export function normalizeProviderEntries(input) {
  let list
  if (Array.isArray(input)) {
    list = input
  } else if (input && typeof input === "object" && Array.isArray(input.providers)) {
    list = input.providers
  } else if (input && typeof input === "object") {
    list = Object.entries(input).map(([id, value]) => ({ id, ...value }))
  } else {
    list = []
  }

  return list
    .map((entry) => {
      const id =
        entry?.id ?? entry?.providerID ?? entry?.info?.id ?? entry?.provider?.id ?? (typeof entry === "string" ? entry : undefined)
      if (!id) return null
      const baseURL =
        entry?.info?.settings?.baseURL ??
        entry?.settings?.baseURL ??
        entry?.provider?.settings?.baseURL ??
        entry?.options?.baseURL ??
        entry?.baseURL ??
        null
      const name =
        entry?.info?.name ?? entry?.provider?.name ?? entry?.name ?? null
      return { id, name, baseURL }
    })
    .filter(Boolean)
}

/**
 * Resolves the options for this plugin run.
 * Precedence (same as the V1 plugin):
 *   1. explicit plugin options
 *   2. environment variables (TUXEVIL_ROTATOR_BASE_URL, ROTATOR_URL)
 *   3. discovered provider whose baseURL mentions 51200 / rotator / antigravity
 *   4. default http://127.0.0.1:51200/v1
 */
export function resolvePluginOptions(options = {}, providerEntries = []) {
  const entries = normalizeProviderEntries(providerEntries)
  const envBaseURL = process.env.TUXEVIL_ROTATOR_BASE_URL || process.env.ROTATOR_URL

  let baseURL = options.baseURL || envBaseURL || null
  let providerID = options.providerID || null
  let providerName = options.providerName || null

  if (!baseURL) {
    const found = entries.find((entry) => {
      const url = entry.baseURL
      return typeof url === "string" && (url.includes("51200") || url.includes("rotator") || url.includes("antigravity"))
    })
    if (found) {
      baseURL = found.baseURL ?? null
      if (!providerID) providerID = found.id
      if (!providerName) providerName = found.name
    }
  }

  // Scan backwards once so a long internal slash run cannot cause ReDoS.
  const baseURLText = String(baseURL ?? DEFAULT_BASE_URL)
  let end = baseURLText.length
  while (end > 0 && baseURLText.charCodeAt(end - 1) === 47) end--

  return {
    baseURL: baseURLText.slice(0, end),
    providerID: providerID || "antigravity",
    providerName: providerName || "Antigravity (rotator)",
    timeoutMs: Number(options.timeoutMs) || 3500,
    refreshMs: options.refreshMs === 0 ? 0 : Number(options.refreshMs) || 600_000,
  }
}

/**
 * Fetches available models from the target rotator endpoint.
 */
export async function fetchRotatorModels(baseURL, timeoutMs = 3500) {
  const modelsUrl = `${baseURL}/models`
  let url
  try {
    url = new URL(modelsUrl)
  } catch {
    throw new Error(`fetch() URL is invalid: "${modelsUrl}" (bad baseURL "${baseURL}")`)
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`Unsupported URL protocol in "${modelsUrl}"`)
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: "application/json" },
    })

    if (!res.ok) {
      throw new Error(`Endpoint returned status ${res.status}: ${res.statusText}`)
    }

    const json = await res.json()
    if (!json || !Array.isArray(json.data)) {
      throw new Error('Invalid response format: "data" array not found')
    }

    return json.data
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Maps a raw model object from the rotator /v1/models endpoint to an
 * OpenCode model definition core (limit + capabilities).
 */
export function mapModelToOpenCode(rawModel) {
  const id = rawModel.id
  const meta = rawModel.meta || rawModel.info || {}

  const contextLimit =
    Number(meta.context_length) || Number(rawModel.context_window) || Number(rawModel.max_model_len) || 128000
  const outputLimit = Number(meta.max_output_tokens) || 8192

  const isMultimodal = Boolean(meta.multimodal)
  const toolCalling = meta.tool_calling !== false

  return {
    id,
    modelDef: {
      name: id,
      limit: { context: contextLimit, output: outputLimit },
      capabilities: {
        tools: toolCalling,
        input: isMultimodal ? ["text", "image"] : ["text"],
        output: ["text"],
        ...openCodeReasoning(rawModel),
      },
      ...(openCodeVariants(rawModel).length ? { variants: openCodeVariants(rawModel) } : {}),
    },
  }
}

function toModelMap(models) {
  if (models instanceof Map) return models
  if (models && typeof models === "object") return new Map(Object.entries(models))
  return new Map()
}

function safeGet(editor, id) {
  try {
    return editor?.get?.(id)
  } catch {
    return undefined
  }
}

function modelSignature(models) {
  return JSON.stringify(
    (models ?? [])
      .map((model) => [model?.id, model?.meta])
      .filter(Boolean)
      .sort(),
  )
}

function mergeProviderInfo(existingProvider, resolved) {
  const prior = existingProvider ?? {}
  return {
    ...providerInfoEmpty(resolved.providerID),
    ...prior,
    name: prior.name || resolved.providerName,
    activation: prior.activation || "enabled",
    package: prior.package || DEFAULT_PROVIDER_PACKAGE,
    settings: { ...(prior.settings ?? {}), baseURL: resolved.baseURL },
  }
}

/**
 * OpenCode V2 Plugin Entrypoint (plain-object definition, same pattern the
 * official @openviking/opencode-plugin uses).
 */
export default {
  id: PLUGIN_ID,
  async setup(ctx) {
    const options = (ctx && ctx.options) || {}
    let entries
    try {
      entries = normalizeProviderEntries(await ctx?.provider?.list?.())
    } catch {
      entries = []
    }

    const resolved = resolvePluginOptions(options, entries)
    const source = { models: null }
    let lastSignature = null

    async function load() {
      try {
        const models = await fetchRotatorModels(resolved.baseURL, resolved.timeoutMs)
        const list = Array.isArray(models) ? models : []
        const changed = lastSignature !== null && modelSignature(list) !== lastSignature
        source.models = list
        lastSignature = modelSignature(list)
        return { ok: true, changed }
      } catch (err) {
        // Safe degrade: never fail OpenCode startup when the rotator is unreachable
        console.warn(`[opencode-discovery] model discovery skipped: ${err?.message ?? err}`)
        return { ok: false, changed: false }
      }
    }

    const first = await load()
    if (!first.ok || !source.models?.length) return undefined

    const toModelInfo = (raw, existingModel) => {
      const { id, modelDef } = mapModelToOpenCode(raw)
      const existingReasoning = existingModel?.capabilities?.reasoning
      const discoveredReasoning = modelDef.capabilities.reasoning
      const mergedReasoning =
        discoveredReasoning || existingReasoning
          ? { ...(discoveredReasoning ?? {}), ...(existingReasoning ?? {}) }
          : undefined
      return {
        ...modelInfoDefault(resolved.providerID, id),
        ...(existingModel ?? {}),
        id: makeModelID(id),
        name: existingModel?.name || modelDef.name,
        capabilities: {
          ...modelDef.capabilities,
          ...(existingModel?.capabilities ?? {}),
          ...(mergedReasoning ? { reasoning: mergedReasoning } : {}),
        },
        limit: { ...modelDef.limit, ...(existingModel?.limit ?? {}) },
        ...(modelDef.variants ? { variants: [...new Map([...modelDef.variants, ...(Array.isArray(existingModel?.variants) ? existingModel.variants : [])].map(v => [v.id, v])).values()] } : {}),
      }
    }

    await ctx.provider.transform((editor) => {
      if (!source.models?.length) return
      const existing = safeGet(editor, resolved.providerID)
      const existingModels = toModelMap(existing?.models)
      const models = source.models.flatMap((raw) =>
        raw?.id ? [toModelInfo(raw, existingModels.get(raw.id) ?? null)] : [],
      )
      editor.add({ info: mergeProviderInfo(existing?.provider, resolved), models })
    })

    if (resolved.refreshMs <= 0) return undefined

    const timer = setInterval(() => {
      void (async () => {
        const result = await load()
        if (!result.changed) return
        try {
          await ctx.provider.reload()
        } catch {
          // Registry reload unavailable; keep the last known inventory
        }
      })()
    }, resolved.refreshMs)
    if (typeof timer.unref === "function") timer.unref()

    return () => clearInterval(timer)
  },
}

