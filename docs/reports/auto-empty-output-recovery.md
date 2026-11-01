# Recuperación de respuestas vacías en auto

Fecha: 2026-10-31. Seguimiento: pi-antigravity-rotator-e47t.

La pausa temporal por modelo evitaba repetir inmediatamente Beam, pero otra selección de Ollama también podía terminar sin texto ni herramientas. Pi seguía recibiendo un error y detenía su trabajo.

Para solicitudes Chat Completions con streaming y modelo `auto`, el rotador ahora retiene el prefijo de Ollama hasta detectar texto útil o una herramienta con nombre. Si termina vacío, excede 30 segundos o supera 1 MiB antes de producir salida útil, pausa ese modelo y vuelve a seleccionar una alternativa una sola vez. La nueva selección conserva la validación de permisos y capacidades existente. Cada intento registra su resultado por separado.

Cuando ya se entregó texto o una herramienta al cliente no se repite la solicitud. Las solicitudes a modelos explícitos conservan su comportamiento anterior. Esta recuperación no demuestra la causa original de las respuestas vacías de Ollama ni completa por sí misma la tarea del agente remoto.

Validación: `npm run check`: 1383 pruebas, 1381 aprobadas, 2 omitidas, sin fallos; tipos correctos; lint sin errores y 17 advertencias existentes. Las pruebas cubren texto, herramientas, respuesta de solo razonamiento, límites de espera/memoria, reproducción exacta del prefijo, recuperación en una alternativa y detención después del segundo intento vacío.
