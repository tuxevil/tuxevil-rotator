# Plan de soporte para `aicode.googleapis.com` (`google.gca.aicode.v1main`)

Documento técnico basado en ingeniería inversa de `/Applications/Antigravity.app` v2.34.0 (`Contents/Resources/bin/language_server`, compilado en Go 1.28) y pruebas contra las APIs reales de Google.

## 1. Hallazgos del cliente oficial (`Antigravity.app` 2.34.0)

Aunque el binario incluye descriptores `.proto` de servicios gRPC (`google.gca.aicode.v1main.PredictionService` y `ManagementService`), `CodeAssistClient` consume AICode por **HTTP JSON + SSE (`protojson`)**, igual que `daily-cloudcode-pa.googleapis.com`:

- **Base URL:** `https://aicode.googleapis.com` (preprod: `https://preprod-aicode.sandbox.googleapis.com`; override env: `AICODE_ENDPOINT_URL`).
- **Generación streaming:** `POST https://aicode.googleapis.com/v1alpha:streamGenerateContent?alt=sse`
- **Generación síncrona:** `POST https://aicode.googleapis.com/v1alpha:generateContent`
- **Cuota:** `GET https://aicode.googleapis.com/v1alpha:fetchQuotaStatus`
- **Configuración y experimentos:** `GET https://aicode.googleapis.com/v1alpha:fetchConfig`
- **Licencias y tier:** `GET https://aicode.googleapis.com/v1alpha:fetchLicenses`
- **Información de usuario:** `GET https://aicode.googleapis.com/v1alpha/userInfo`

### Reglas de activación en `StreamGenerateContent`

La app oficial envía el tráfico de generación a `aicode.googleapis.com` cuando se cumplen las tres condiciones siguientes (`useAICodePredictionFlow` + `aicodeEntitlement`):

1. **Cuenta personal (`personal_consumer`):** cuenta Google consumer (no workspace/enterprise/business; `gcpManaged !== true` en `loadCodeAssist`).
2. **Experimento activo:** `listExperiments` devuelve `{ name: "use-aicode-mendel", boolValue: true }` (o `USE_AICODE=true`).
3. **Scope y estado del token:** el token OAuth contiene `https://www.googleapis.com/auth/aicode` y la cuenta no está en cooldown de scope (`!isInAICodeScopeCooldown()`).

Si falta cualquiera de las tres condiciones, o si AICode responde HTTP `403` con `ACCESS_TOKEN_SCOPE_INSUFFICIENT`, la app marca `markAICodeScopeMissing()` y hace fallback automático a `daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse`.

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
- Capturar `scope` en el refresh de token (`ensureGoogleToken`), evaluar `loadCodeAssist` + `listExperiments` con caché de 6h por generación de credencial y mostrar advertencia por cuenta en `accounts` cuando se cumplan las 3 reglas de migración (personal consumer + `use-aicode-mendel` activo + falta scope `aicode`).

### Fase 2: Cliente de gestión AICode (`v1alpha` discovery + entitlement) (completada)
- `src/providers/google-antigravity/aicode.ts`:
  - `fetchAicodeConfig(account)` (`GET /v1alpha:fetchConfig`, caché 5m): indexa `availableExperiences` activos (entradas con `model`) y lee `use-aicode-mendel`.
  - `fetchAicodeLicenses(account)` (`GET /v1alpha:fetchLicenses`, caché 5m): resuelve `entitlement.userTier`.
  - Manejo explícito de `403 ACCESS_TOKEN_SCOPE_INSUFFICIENT`: registra cooldown de 1h en memoria (`markAicodeScopeMissing`, sin invalidar CCPA ni activar pausa protectora) y hace fallback a `v1internal`.

### Fase 3: Conversor y forwarding de generación AICode (completada)
- `src/providers/google-antigravity/aicode-forward.ts` + `src/providers/google-antigravity/forward.ts`:
  - Traduce `RequestBody` de `v1internal` hacia `google.gca.aicode.v1main.GenerateContentRequest` plano con `aicode: { experience }` y `entitlement: { userTier }` (`model` y `aicode` son `oneof inference` en el proto), omitiendo `project`, `requestId`, `userPromptId`, `requestType` y `userAgent`.
  - Solo enruta a `POST https://aicode.googleapis.com/v1alpha:streamGenerateContent?alt=sse` cuando la cuenta cumple las 3 reglas (`personalConsumer`, `useAicodeMendel`, scope `aicode` y sin cooldown) **y** el modelo existe en `fetchConfig.availableExperiences` (modelos exclusivos de CCPA como `gemini-4-hydrogen-high` permanecen en `daily-cloudcode-pa.googleapis.com`).
  - Envuelve los chunks SSE planos de `GenerateContentResponse` en `{ response: ... }` para mantener compatibilidad con `proxy.ts`, `compat.ts` y clientes `v1internal`.
  - Ante `403 ACCESS_TOKEN_SCOPE_INSUFFICIENT`, activa el cooldown de 1h y reintenta inmediatamente la misma petición contra `daily-cloudcode-pa/v1internal`.
  - Pruebas de ruta, conversión, caché y fallback en `test/aicode-routing.test.ts`.

### Fase 4: Cuota AICode y re-autenticación de cuentas (completada)
- Integrado `GET /v1alpha:fetchQuotaStatus` en `src/providers/google-antigravity/quota.ts` + `src/providers/google-antigravity/aicode.ts` para cuentas elegibles:
  - `sanitizeSummaryBucket` normaliza `refreshWindowLabel` -> `window` para reutilizar `parseGoogleQuotaSummaryResponse` sobre `quotaSummary` (`groups[].buckets[]`).
  - `mergeAicodeQuotaIntoResponse` combina `buckets[]` + `fetchConfig.availableExperiences` (p. ej. `claude-opus-5-5-high`, `claude-sonnet-5-5-high`) con `fetchAvailableModels` sin perder modelos exclusivos de CCPA (`gemini-4-hydrogen-high`).
  - Ante `403 ACCESS_TOKEN_SCOPE_INSUFFICIENT`, registra cooldown de 1h y hace fallback inmediato a `retrieveUserQuotaSummary` sin marcar la cuenta.
- Cobertura en `test/aicode-routing.test.ts` (conversión, SSE, fallback 403, `fetchQuotaStatus`).
