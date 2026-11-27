# Plan de soporte para `aicode.googleapis.com` (`google.gca.aicode.v1main`)

Documento técnico basado en ingeniería inversa de `/Applications/Antigravity.app` v2.34.0 y v2.35.2 (`Contents/Resources/bin/language_server`, Go 1.28; 2.35.2 = CL `1029311855`) y pruebas contra las APIs reales de Google.

## 1. Hallazgos del cliente oficial (`Antigravity.app` 2.34.0 / 2.35.2)

Aunque el binario incluye descriptores `.proto` de servicios gRPC (`google.gca.aicode.v1main.PredictionService` y `ManagementService`), `CodeAssistClient` consume AICode por **HTTP JSON + SSE (`protojson`)**, igual que `daily-cloudcode-pa.googleapis.com`:

- **Base URL:** `https://aicode.googleapis.com` (preprod: `https://preprod-aicode.sandbox.googleapis.com`; override env: `AICODE_ENDPOINT_URL`).
- **Generación streaming:** `POST https://aicode.googleapis.com/v1alpha:streamGenerateContent?alt=sse`
- **Generación síncrona:** `POST https://aicode.googleapis.com/v1alpha:generateContent`
- **Cuota:** `GET https://aicode.googleapis.com/v1alpha:fetchQuotaStatus`
- **Configuración y experimentos:** `GET https://aicode.googleapis.com/v1alpha:fetchConfig`
- **Licencias y tier:** `GET https://aicode.googleapis.com/v1alpha:fetchLicenses`
- **Información de usuario:** `GET https://aicode.googleapis.com/v1alpha/userInfo`

### Reglas de activación en `StreamGenerateContent` (corregidas con 2.35.2)

`openStreamGenerateContent` y `GenerateContent` solo envían la generación a `aicode.googleapis.com` cuando se cumplen **todas** estas condiciones:

1. **Cuenta personal (`personal_consumer`):** `ResolveAuthMode` devuelve `personal_consumer` (cuenta consumer; `gcpManaged !== true` en `loadCodeAssist`).
2. **`useAICodePredictionFlow()` es true:** si existe la env `USE_AICODE`, manda su valor; si no, exige el flag Mendel `enable-inference-traffic-migration` (aplicado vía `SetUseAICodePredictionFlow`).
3. **Scope y estado del token:** el token contiene `https://www.googleapis.com/auth/aicode` y la cuenta no está en cooldown de scope (`!isInAICodeScopeCooldown()`).

La decisión no filtra por modelo. Si no se cumplen, la generación va a `daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse`. Ante `403 ACCESS_TOKEN_SCOPE_INSUFFICIENT`, la app marca `markAICodeScopeMissing()` (cooldown 1h) y vuelve a CCPA.

Otros flags relacionados:

- `use-aicode-mendel` **no** enruta generación: `ccpaRoutesToAICode` solo lo usa `ListExperiments` para leer experimentos desde `GET /v1alpha:fetchConfig` (log real: `UseAICodeMendel routing switch changed: false -> true`).
- `dark-launch-aicode-quota-status`: `fetchQuotaStatus` solo corre como *shadow eval* (`runAICodeQuotaSummaryShadowEval`) junto a CCPA `retrieveUserQuotaSummary`, que sigue siendo la fuente de cuota.
- `use-aicode-fetch-licenses` / `shadow-call-aicode-fetch-licenses`: controlan `FetchLicensesFromAICode` fuera del prediction flow.

Valores observados el 2026-11-26 en cuentas personales Pro reautenticadas: `enable-inference-traffic-migration=false`, `use-aicode-mendel=true`, `dark-launch-aicode-quota-status=false`, `use-aicode-fetch-licenses=false`. Con esos valores, Antigravity.app 2.35.2 genera todo por CCPA. `fetchConfig.availableExperiences` tampoco incluye `gemini-4-hydrogen/neon/argon`.

---

## 2. Diferencias de contrato entre CCPA (`v1internal`) y AICode (`v1alpha`)

| Aspecto | CCPA (`daily-cloudcode-pa/v1internal`) | AICode (`aicode/v1alpha`) |
|---|---|---|
| Base URL | `https://daily-cloudcode-pa.googleapis.com` | `https://aicode.googleapis.com` |
| Auth scope requerido | `cloud-platform`, `cclog`, `experimentsandconfigs` | Los anteriores + `https://www.googleapis.com/auth/aicode` |
| Payload request | Envuelto: `{ project, requestId, request: {...}, model, userPromptId, userAgent, requestType }` | Plano (`google.gca.aicode.v1main.GenerateContentRequest`): `{ model, aicode: { experience, ... }, contents, systemInstruction, tools, toolConfig, labels, safetySettings, generationConfig, sessionId, entitlement: { userTier } }` |
| Payload response SSE | Envuelto: `{ response: { candidates, usageMetadata }, traceId, metadata }` | Plano (`google.gca.aicode.v1main.GenerateContentResponse`): `{ candidates, promptFeedback, usageMetadata, modelVersion, responseId, creditUsageMetadata }` |
| Cuota | `POST /v1internal:fetchAvailableModels` + `POST /v1internal:retrieveUserQuotaSummary` | `GET /v1alpha:fetchQuotaStatus` (`buckets[]`, `quotaSummary.groups[]`, `availableCredits[]`) |
| Experimentos / catálogo | `POST /v1internal:listExperiments` | `GET /v1alpha:fetchConfig` (`experimentConfig`, `availableExperiences`, `availableModels`, `agySurfaceConfig`) |
| Headers | `Authorization`, `User-Agent`, `Content-Type` (sin `X-Goog-User-Project` salvo env dev) | Iguales (`Authorization`, `User-Agent`, `Content-Type`, opcional `X-Goog-Request-Reason`; sin `X-Goog-User-Project` salvo `AICODE_DEV_PROJECT`) |

---

## 3. Fases de implementación en `pi-antigravity-rotator`

### Fase 1: Visibilidad y prevención (completada)
- Incluir `https://www.googleapis.com/auth/aicode` en `SCOPES` (`src/providers/google-antigravity/oauth.ts`) para nuevos logins.
- Mantener `autoWarmupEnabled: false` para evitar kickstarts sintéticos.
- Capturar `scope` en el refresh de token (`ensureGoogleToken`), evaluar `loadCodeAssist` + `listExperiments` con caché de 6h por generación de credencial y mostrar advertencia por cuenta en `accounts` cuando la cuenta es personal consumer, tiene `use-aicode-mendel` activo y le falta el scope `aicode`.
- La misma consulta guarda `enable-inference-traffic-migration` y `dark-launch-aicode-quota-status`.

### Fase 2: Cliente de gestión AICode (`v1alpha` discovery + entitlement) (completada)
- `src/providers/google-antigravity/aicode.ts`:
  - `fetchAicodeConfig(account)` (`GET /v1alpha:fetchConfig`, caché 5m): indexa `availableExperiences` activos (entradas con `model`) y lee `use-aicode-mendel` y `enable-inference-traffic-migration`. Solo se llama cuando la generación ya va por AICode.
  - `fetchAicodeLicenses(account)` (`GET /v1alpha:fetchLicenses`, caché 5m): resuelve `entitlement.userTier`.
  - Manejo explícito de `403 ACCESS_TOKEN_SCOPE_INSUFFICIENT`: registra cooldown de 1h en memoria (`markAicodeScopeMissing`, sin invalidar CCPA ni activar pausa protectora) y hace fallback a `v1internal`.

### Fase 3: Conversor y forwarding de generación AICode (completada)
- `src/providers/google-antigravity/aicode-forward.ts` + `src/providers/google-antigravity/forward.ts`:
  - Traduce `RequestBody` de `v1internal` hacia `google.gca.aicode.v1main.GenerateContentRequest` plano con `aicode: { experience }` y `entitlement: { userTier }` (`model` y `aicode` son `oneof inference` en el proto), omitiendo `project`, `requestId`, `userPromptId`, `requestType` y `userAgent`.
  - Solo enruta a `POST https://aicode.googleapis.com/v1alpha:streamGenerateContent?alt=sse` cuando la cuenta cumple las reglas de la sección 1 (`personalConsumer`, `enable-inference-traffic-migration` o `USE_AICODE=true`, scope `aicode` y sin cooldown) **y** el modelo existe en `fetchConfig.availableExperiences` (modelos exclusivos de CCPA como `gemini-4-hydrogen-high` permanecen en `daily-cloudcode-pa.googleapis.com`).
  - `USE_AICODE` vale `auto` por defecto: AICode queda apagado y solo se activa por cuenta cuando Google enciende `enable-inference-traffic-migration`. `USE_AICODE=false` lo desactiva siempre (generación y shadow de cuota); `USE_AICODE=true` lo fuerza.
  - Envuelve los chunks SSE planos de `GenerateContentResponse` en `{ response: ... }` para mantener compatibilidad con `proxy.ts`, `compat.ts` y clientes `v1internal`.
  - Ante `403 ACCESS_TOKEN_SCOPE_INSUFFICIENT`, activa el cooldown de 1h y reintenta inmediatamente la misma petición contra `daily-cloudcode-pa/v1internal`.
  - Pruebas de ruta, conversión, caché y fallback en `test/aicode-routing.test.ts`.

### Fase 4: Cuota AICode y re-autenticación de cuentas (corregida)
- La fuente de cuota es siempre CCPA (`fetchAvailableModels` + `retrieveUserQuotaSummary`), igual que Antigravity.app.
- `GET /v1alpha:fetchQuotaStatus` solo se llama como shadow cuando `dark-launch-aicode-quota-status` está activo (`shouldShadowAicodeQuotaStatus`); su resultado no reemplaza la cuota CCPA. `USE_AICODE=false` lo desactiva.
- `parseGoogleQuotaSummaryResponse` acepta `refreshWindowLabel` (`5h`/`weekly`) además de `window`.
- Ante `403 ACCESS_TOKEN_SCOPE_INSUFFICIENT` en el shadow, registra cooldown de 1h sin marcar la cuenta.
- Cobertura en `test/aicode-routing.test.ts` (conversión, SSE, fallback 403, regla de migración, shadow de cuota).
