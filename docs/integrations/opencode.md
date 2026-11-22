# OpenCode

Connect OpenCode to tuxevil-rotator to use Google Antigravity models as your OpenCode provider.

## Automatic Installation CLI (`install-opencode`)

You can install and configure the discovery plugin automatically on your local machine or on remote hosts via SSH using the built-in CLI:

### 1. Install to a Remote Host via SSH
```bash
# Basic SSH install to remote host
tuxevil-rotator install-opencode --host 192.168.1.50 --user ubuntu --rotator-url http://10.128.128.164:51200/v1

# With custom SSH key, virtual API key, and provider name
tuxevil-rotator install-opencode \
  --host 192.168.1.50 \
  --user dev \
  --ssh-key ~/.ssh/id_rsa \
  --rotator-url http://10.128.128.164:51200/v1 \
  --provider-id antigravity \
  --provider-name "Antigravity Dev" \
  --api-key rk-your-virtual-key
```

### 2. Install to Local Agent
```bash
tuxevil-rotator install-opencode --rotator-url http://10.128.128.164:51200/v1
```

### CLI Parameters for `install-opencode`:
| Flag | Description | Default |
| :--- | :--- | :--- |
| `--host <ip\|hostname>` | Target machine hostname or IP (omit for localhost) | `localhost` |
| `--user <username>` | SSH user for remote installation | Current user |
| `--port <number>` | SSH port | `22` |
| `--ssh-key <path>` | Path to private SSH key | Default SSH identities |
| `--rotator-url <url>` | Rotator endpoint URL (`/v1`) | `http://127.0.0.1:51200/v1` |
| `--provider-id <id>` | Provider ID inside `opencode.json` | `antigravity` |
| `--provider-name <name>` | Display name in OpenCode TUI | `Antigravity (rotator)` |
| `--api-key <key>` | Virtual API key or token | None |
| `--target-dir <path>` | Target config directory on host | `~/.config/opencode` |
| `--dry-run` | Prints the remote script without executing | `false` |

---

## Manual Installation and Plugin Details

Instead of manually maintaining the `models` dictionary in `opencode.json`, you can enable the bundled **OpenCode Discovery Plugin**. It queries the rotator's `/v1/models` endpoint when OpenCode loads and registers the provider with all available models, their real context limits and tool-calling capabilities — and it keeps refreshing that inventory in the background (every 10 minutes by default).

> The plugin uses the **OpenCode 2.x plugin API** (`{ id, setup }` with `ctx.provider.transform`). OpenCode 1.x does not load it; targets must run OpenCode 2 or newer.

Register the plugin directory in your `opencode.json`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "/path/to/pi-antigravity-rotator/plugins/opencode-discovery",
      "options": {
        // Optional: specify the rotator URL (defaults to TUXEVIL_ROTATOR_BASE_URL or http://127.0.0.1:51200/v1)
        "baseURL": "http://10.128.128.164:51200/v1",
        "providerID": "antigravity",
        // Optional: background re-discovery interval in ms. Default 600000, 0 disables.
        "refreshMs": 600000
      }
    }
  ],
  "model": "antigravity/gemini-3.8-flash-high"
}
```

The plugin automatically detects the URL in this order:
1. `baseURL` option passed directly in the plugin entry of `opencode.json`.
2. `TUXEVIL_ROTATOR_BASE_URL` or `ROTATOR_URL` environment variables.
3. Provider entries with a rotator-compatible `baseURL` (via `provider.*.options.baseURL` or the V2 provider registry).
4. Fallback to `http://127.0.0.1:51200/v1`.

If the rotator is unreachable at load time, the plugin degrades safely: it logs a warning and leaves the statically configured `provider.models` intact.

---

## Manual Static Configuration

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "antigravity": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "Antigravity (local)",
      "options": {
        "baseURL": "http://localhost:51200/v1"
      },
      "models": {
        "gemini-3.8-flash-high": {
          "name": "Gemini 3.8 Flash High",
          "limit": { "context": 1000000, "output": 65536 }
        },
        "gemini-3.8-flash-medium": {
          "name": "Gemini 3.8 Flash Medium",
          "limit": { "context": 1000000, "output": 65536 }
        },
        "gemini-3.8-flash-low": {
          "name": "Gemini 3.8 Flash Low",
          "limit": { "context": 1000000, "output": 65536 }
        },
        "gemini-3.7-flash-tiered": {
          "name": "Gemini 3.7 Flash Tiered (Thinking)",
          "limit": { "context": 1000000, "output": 65536 },
          "options": {
            "reasoningEffort": "high"
          }
        },
        "gemini-3.6-flash-high": {
          "name": "Gemini 3.6 Flash High",
          "limit": { "context": 1000000, "output": 65536 }
        },
        "gemini-3.6-flash-medium": {
          "name": "Gemini 3.6 Flash Medium",
          "limit": { "context": 1000000, "output": 65536 }
        },
        "gemini-3.1-pro-low": {
          "name": "Gemini 3.1 Pro",
          "limit": { "context": 1000000, "output": 65536 }
        },
        "claude-sonnet-4-6": {
          "name": "Claude Sonnet 4.6",
          "limit": { "context": 1000000, "output": 64000 }
        },
        "claude-opus-4-6-thinking": {
          "name": "Claude Opus 4.6 Thinking",
          "limit": { "context": 1000000, "output": 64000 }
        }
      }
    }
  },
  "model": "antigravity/gemini-3.8-flash-high"
}
```

## Setting the API Key

**Option A: Via `/connect` command inside OpenCode (recommended)**

```
/connect
```

Select "Other", enter provider ID `antigravity`, then enter your key (`no-key` if no Virtual Keys are configured, or your `rk-...` Virtual Key).

**Option B: Environment variable in config**

```jsonc
{
  "provider": {
    "antigravity": {
      "options": {
        "baseURL": "http://localhost:51200/v1",
        "apiKey": "{env:TUXEVIL_ROTATOR_KEY}"
      }
    }
  }
}
```

Then set `TUXEVIL_ROTATOR_KEY=no-key` (or your `rk-...` key) in your shell.

## Selecting a Model

Set as default in config:

```json
{ "model": "antigravity/gemini-3.8-flash-high" }
```

Or via CLI flag:

```bash
opencode --model antigravity/gemini-3.8-flash-high
```

Or use `/models` inside OpenCode to pick interactively.

## Thinking & Reasoning Levels

Antigravity models handle reasoning and internal thinking in three ways:

### 1. Named Reasoning Levels (Gemini 3.8)

Gemini 3.8 exposes separate native model IDs for `low`, `medium`, and `high` reasoning. Select the desired level through the model ID; the rotator leaves thinking adaptive within that upstream level.

| Model ID | Context Window | Reasoning Level |
| :--- | :--- | :--- |
| `gemini-3.8-flash-high` | 1,000,000 | High |
| `gemini-3.8-flash-medium` | 1,000,000 | Medium |
| `gemini-3.8-flash-low` | 1,000,000 | Low |

### 2. Adaptive Thinking (`gemini-3.7-flash-tiered`)

`gemini-3.7-flash-tiered` uses Google's dynamic thinking level. By default, it operates adaptively (the model decides how many tokens to think). You can control the thinking depth using standard `reasoning_effort`:

| Level | Upstream `thinkingLevel` | Use Case |
| :--- | :--- | :--- |
| **`low`** | `LOW` | Quick responses, straightforward edits, simple questions. |
| **`medium`** | `MEDIUM` | Balanced reasoning for standard coding and multi-file refactors. |
| **`high`** | `HIGH` | Deep architectural design, complex bug diagnosis, deep multi-step planning. |
| *(default)* | Adaptive | Model dynamically adjusts thinking tokens based on prompt complexity. |

### 3. Fixed Token Budgets (Gemini 3.6 / 3.1 & Claude)

For earlier Gemini models and Claude, the thinking budget is predetermined by model ID:

| Model ID | Context Window | Thinking Budget |
| :--- | :--- | :--- |
| `gemini-3.7-flash-tiered` | 1,000,000 | Dynamic / Tiered (`low` / `medium` / `high`) |
| `gemini-3.6-flash-high` | 1,000,000 | 10,000 tokens (fixed) |
| `gemini-3.6-flash-medium` | 1,000,000 | 4,000 tokens (fixed) |
| `gemini-3.6-flash-low` | 1,000,000 | 1,000 tokens (fixed) |
| `gemini-3.1-pro-low` | 1,000,000 | 1,001 tokens (fixed) |
| `claude-sonnet-4-6` | 1,000,000 | 32,768 tokens (fixed) |
| `claude-opus-4-6-thinking` | 1,000,000 | 32,768 tokens (fixed) |

## Reasoning effort levels

Both connection commands install the shared capability mapper and refresh static model definitions from the live catalog:

```bash
tuxevil-rotator install-opencode --rotator-url http://127.0.0.1:51200/v1
tuxevil-rotator install-agent --target opencode --rotator-url http://127.0.0.1:51200/v1
```

Codex models, Antigravity `effortRouting` aliases (with two or more served scalar levels), and adaptive `-tiered` Gemini models keep one ID. The discovery plugin maps `meta.reasoning_efforts` to OpenCode 2 `capabilities.reasoning.effort` and variants such as `high` with `settings.reasoningEffort: "high"`. For example, select `tuxevil-rotator/gpt-5.6-sol#high` or `tuxevil-rotator/gemini-3.8-flash#high` (use an ID present in your catalog). The legacy `provider.models` fallback uses `variants.high.reasoningEffort`; OpenCode 2 migrates that form.

The plugin refreshes when model capabilities change, including when the IDs stay the same. Existing model options, custom/disabled variants and limits remain authoritative. Installation backs up existing JSON and leaves the chosen default model and existing API key unchanged when no new key is supplied. If the rotator is offline, existing model definitions are retained.

Only efforts advertised by the model are offered. Fixed Antigravity variant IDs do not acquire guessed Codex effort controls. `ultra` is a harness mode and is not generated as a raw API effort. Reload the provider or restart OpenCode after upgrading the plugin. See [OpenCode variants](https://dev.opencode.ai/v2/docs/models/#variants).

## Advanced Settings & Prompt Compression

You can pass custom headers in `opencode.json` to enable features like token compression:

```jsonc
{
  "provider": {
    "antigravity": {
      "options": {
        "baseURL": "http://localhost:51200/v1",
        "headers": {
          "X-Rotator-Compression": "rtk+lite"
        }
      }
    }
  }
}
```

## Notes

- The `npm` field must be `"@ai-sdk/openai-compatible"` for the OpenAI Chat Completions endpoint
- Model IDs in the config must match what `GET /v1/models` returns from the rotator
- Add as many models as you want to the `models` map — only listed ones appear in the picker
- `tuxevil-rotator` automatically sanitizes complex JSON schemas sent by OpenCode tools (`read`, `edit`, `shell`, `task`, `grep`, `glob`), stripping unsupported keywords so Antigravity executes them seamlessly.
