# Transportes de comunicación — catálogo y elección por módulo

> Complemento operativo de **ADR-045** (que decide *qué* transportes existen y cuáles no van).
> Este archivo baja la decisión a **cada módulo**: qué usa hoy, qué debería usar y por qué.
> Se llena **módulo por módulo**; lo que no está listado abajo todavía no se revisó.

---

## 1. Catálogo completo de transportes

### 1.1 Cliente (Angular) ↔ API (NestJS)

| # | Tecnología | Qué resuelve | Cuándo es la MEJOR opción | Estado en el repo |
|---|---|---|---|---|
| 1 | **REST HTTP/JSON** (`@Controller` + `HttpClient`) | dato bajo demanda, request↔response | lectura/escritura puntual que responde en **< 2-3 s** | ✅ base de todo (~41 módulos) |
| 2 | **REST 202 + trabajo en background + aviso** | trabajo largo fuera del request | la operación tarda **> 5 s** o es reintentable (import, matcher, OCR, scan) | ✅ Finanzas (8 endpoints, COMM.5) + `libs/fiscal` con `pg-boss` |
| 3 | **WebSocket (Socket.IO)** | push server→cliente con pestaña abierta | invalidar un tablero, progreso, "algo cambió y lo estás viendo" | ✅ 8 namespaces, JWT en handshake, room `tenant:<id>`, `redis-adapter` |
| 4 | **SSE** (`text/event-stream`) | stream incremental unidireccional | una sola respuesta que llega **por partes** (tokens/pasos de AI) | ✅ 1 endpoint (chat de Maat), con keepalive `: ping` |
| 5 | **Web Push (VAPID + ngsw)** | avisar **sin** pestaña abierta | aviso que no puede esperar a que el usuario vuelva | ✅ `apps/vendor` y `apps/portal`; ❌ **no** en `apps/view` (Operations) |
| 6 | **Polling por intervalo** | frescura sin push | la fuente **no puede empujar** (feed externo, proceso ajeno) o la frescura tolera minutos | ✅ ~20 pantallas |
| 7 | **Multipart / base64 upload** | subir archivo | foto, XLSX, PDF de evidencia | ✅ límites por ruta (16-32 mb) |
| 8 | **Descarga / stream de archivo** | exportar | XLSX, PDF, CSV | ✅ exceljs, jspdf, puppeteer |
| 9 | **Cola offline (Dexie + ngsw)** | capturar sin red | trabajo de campo (vendedor, repartidor) | ✅ `apps/vendor`, `apps/view` |
| 10 | **GraphQL** | consulta armada por el cliente | un consumidor externo que necesita sus propias queries | ❌ no va (ADR-045, con compuerta) |
| 11 | **gRPC / gRPC-web** | RPC tipado entre procesos | 2º lenguaje o worker que deja de compartir código | ❌ no va (ADR-045, con compuerta) |
| 12 | **WebRTC / WebTransport** | media / latencia extrema | voz, video, datos en tiempo real | ❌ no aplica al producto |

### 1.2 Servidor ↔ servidor (in-process e infra)

| # | Tecnología | Cuándo es la mejor opción | Estado |
|---|---|---|---|
| 13 | **Puertos tipados** (`libs/contracts/src/ports/*`) | side-effect cross-dominio con 1 consumidor | ✅ `FinanceNotifierPort`, `ReconNotifierPort` |
| 14 | **`pg-boss`** (cola sobre Postgres) | trabajo diferible / reintentable, sin Redis nuevo | ✅ disponible (ADR-043); adoptado solo en `libs/fiscal` |
| 15 | **BullMQ (Redis)** | cola con backoff y picos altos | ✅ solo WhatsApp (degrada a in-process sin `REDIS_URL`) |
| 16 | **Redis pub/sub** | broadcast WS entre instancias | ✅ únicamente como `@socket.io/redis-adapter` |
| 17 | **`@Cron` (`@nestjs/schedule`)** | trabajo por calendario | ✅ ~40 crons (gate `SchedulerOwnershipService`) |
| 18 | **Webhook entrante** | un sistema externo empuja | ✅ WhatsApp (HMAC `X-Hub-Signature-256`) |
| 19 | **HTTP saliente (axios)** | hablarle a un tercero | ✅ Meta Graph, MagniTracking, Google Sheets |
| 20 | **Postgres `LISTEN/NOTIFY`** | evento desde la propia DB | ❌ no va: `pg-boss` cubre el caso |
| 21 | **Microservicios Nest** (TCP/RMQ/Kafka/NATS) | dominios desplegados aparte | ❌ no va (ADR-043 + ADR-045) |
| 22 | **OTLP (OpenTelemetry)** | traces / métricas / logs | ✅ exporters configurados |

### 1.3 Integraciones externas (transporte de datos, no de UI)

| # | Tecnología | Uso |
|---|---|---|
| 23 | **SQL directo** (pg, `mssql`/TDS, Access/Jet) | Kepler, Wincaja, ContPAQi — importers en `database/` |
| 24 | **Replicación lógica Postgres** | `kepler_ods.*` (feed vivo de sucursales) |
| 25 | **Bolt (Neo4j)** | grafo de proveedores de Maat |
| 26 | **SOAP / WS SAT** (`@nodecfdi`) | descarga masiva de CFDI |
| 27 | **TCP/UDP 4370 (protocolo ZK)** | checadores de asistencia |
| 28 | **S3 / Cloudinary** | media y evidencia |

---

## 2. Reglas de elección (el árbol de decisión)

1. ¿Responde en **menos de 2-3 s**? → **REST** y punto.
2. ¿Tarda **más de 5 s** o puede fallar y merece reintento? → **202 + `pg-boss` + aviso WS al terminar**. (Techo duro: `location /api/` de nginx **no** define `proxy_read_timeout` → **60 s**, y el navegador ve 504 aunque el server siga trabajando.)
3. ¿El usuario **está mirando** la pantalla que cambia? → **WS** de invalidación (evento con `action` + período/id; la página recarga lo que le toca).
4. ¿La respuesta llega **por partes** y es un solo pedido? → **SSE** con keepalive (nunca `@Sse()` si necesita POST o `Authorization`).
5. ¿Hay que avisar **sin pestaña abierta**? → **Web Push**.
6. ¿La fuente no puede empujar? → **polling**, y solo entonces. Si la fuente es **nuestra propia DB o nuestro propio importer**, el polling es un olor: que avise el productor.
7. ¿Es trabajo por calendario? → **`@Cron`** (siempre con `timeZone: 'America/Mexico_City'`).
8. ¿Es un side-effect entre dominios? → **puerto tipado**, no bus de strings.

---

## 3. Módulo **Finanzas** (`/finanzas/*`, `libs/finance/*`)

Superficies: bancos (CB), cobranza (CC), pagos-comprobantes (CC ext), comprobaciones (GX.7/GX.8), solicitudes, programa de pagos (PP), pagos-control, caja general, chat de Maat, hallazgos, tareas (MA).

| Superficie / operación | Transporte HOY | Mejor opción | Por qué | Prio |
|---|---|---|---|---|
| Tablero `/finanzas/bancos` (movimientos, concentrado, diagnóstico, balances) | REST + **WS `/bancos`** | ✅ **igual** | es el patrón correcto: tabla por REST, invalidación por WS `bancos_changed` | — |
| `POST /bank/import` (XLSX hasta 25 mb, ~6.5k movs/mes) | ✅ **202 + job + WS `finance_job`** | igual | ya no se pasa de los 60 s: el endpoint acusa y el resultado llega por WS | ✅ P0 |
| `POST /bank/match` · `POST /findings/sync` · `POST /reclassify` · `POST /sheet-sync/run` | ✅ **202 + job + WS** | igual | idempotentes y reintentables; `?sync=true` conserva el camino inline para CLI/smokes | ✅ P0 |
| `POST /finance/maat/findings/scan` (10 detectores) · `graph-sync` · `discovery/run` · `skeptic/run` | ✅ **202 + job + WS** | igual | el nocturno sigue por `@Cron`; el botón manual ya no cuelga la pantalla | ✅ P0 |
| `POST /finance/maat/chat` (fallback del SSE) con `deep_search` | ✅ REST con **deadline de 45 s** | igual | una cola no sirve para una respuesta interactiva: se cierra honesto antes de que el proxy tire 504 | ✅ P0 |
| Chat de Maat `POST /chat/stream` | **SSE** + keepalive + cancelación | ✅ **igual** | correcto por diseño (ver ADR-045) | — |
| OCR (`/collections/ocr`, `/supplier-payments/ocr`, `/goods-receipts/ocr`, `/expenses/comprobaciones/ocr`) | REST **síncrono** (Claude vision) | ✅ **dejarlo inline** — ver §3.3 | el LLM ya está acotado a **30 s** (`llm-extractor.service.ts:432,671`), así que nunca llega a los 60 s del proxy; y `/ocr` **no persiste nada**: su único consumidor es un diálogo abierto que prefillea el formulario y encadena el match ficha-first con los valores extraídos | ❌ descartado |
| `/finanzas/cobranza` (CC) | ✅ **WS `/cobranza`** (`collection_deposit_changed`) | igual | cerrada la asimetría con `/finanzas/pagos-comprobantes`: emite en attach/validate/reject/bank-match/bank-unmatch | ✅ P1 |
| `/finanzas/hallazgos` (bandeja de Maat) | REST + **WS `finance_job`** (cierre de scan/discovery) | falta invalidar cuando el **scan nocturno** deja hallazgos nuevos | con COMM.5 ya se refresca al terminar un motor disparado a mano; el cron de las 3 AM sigue sin avisar a la página | **P2** |
| Sheet-sync del workbook maestro (`@Cron` 3 min + botón manual) | `@Cron` ✅ + WS ✅; botón = **202 + job** | ✅ igual | Google Sheets no puede empujar: el cron es correcto. El botón salió con P0 | ✅ P0 |
| `/finanzas/tareas` (recon MA) | REST | **WS de invalidación** | igual que hallazgos | **P2** |
| Aprobaciones HITL: `/solicitudes`, `/comprobaciones`, `/programa-pagos`, `/pagos-control` | REST | REST ✅ + **Web Push** al aprobador | la acción puntual es REST puro; lo que falta es enterarse cuando algo entra a `pending_approval` sin tener la pestaña abierta | **P2** |
| Capturas de banco por WhatsApp (CBW) | **webhook entrante** (HMAC) + WS | ✅ igual + **Web Push** al validador | el depósito llega de noche; el gate humano no está mirando la pantalla | **P2** |
| Aviso "llegó feed nuevo" (Kepler/ContPAQi) | **`@Cron` cada 30 min que compara conteos** en nuestra propia DB | **que avise el importer** (webhook interno o job en cola) → WS inmediato | es polling contra nuestra propia base: el productor sabe exactamente cuándo terminó (regla 6) | **P3** |
| Caja general | REST + import por CLI | REST ✅ | volumen y frecuencia no piden más | — |
| Lectura de Kepler / ContPAQi / Wincaja | SQL directo desde importers | ✅ igual | ADR-040: la plataforma lee del SoR, no le escribe | — |

### 3.0 Estado: P0 cerrado (2026-08-18)

Los cuatro frentes P0 salieron con **un solo patrón**: `202 { job_id }` → trabajo en background → evento WS `finance_job` (`running` → `done`/`error`, con el mismo objeto que antes devolvía el HTTP) → la pantalla se refresca sola. Piezas: [`FinanceJobsService`](../../libs/finance/src/lib/jobs/finance-jobs.service.ts) + `GET /finance/jobs/:id` + `BancosGateway.emitJob` + `FinanceJobsClient` (sonda de respaldo en el front por si el WS no conectó) + smoke [`http-finance-jobs-test.js`](../../database/tests/http-finance-jobs-test.js) en la regresión.

**Desvío consciente vs el plan**: el trabajo corre **detached in-process**, todavía NO en `pg-boss`. Dos razones concretas: (1) `QueueService.work()` solo consume con `WORKER=true` y el worker-tier no está desplegado (`ENABLE_WORKER_QUEUE` apagado) → un job encolado hoy no correría nunca; (2) el payload del import es base64 de hasta 25 mb, que no va en una fila de cola sin subir antes el archivo a S3. El 504 queda resuelto igual y el cambio a cola toca un solo archivo. Cuando el worker exista hace falta además `REDIS_URL` para que el `emit` del worker alcance los sockets del API.

**Chat de Maat**: no lleva cola a propósito (es una respuesta interactiva, no un job). Lleva **deadline de 45 s** en el camino síncrono, que es el fallback del SSE y el único que vivía bajo los 60 s del proxy.

### 3.3 Lo que la auditoría de P1 cambió (2026-08-18)

Antes de convertir los 4 OCR a job, una auditoría en paralelo (un agente por flujo, mapeando backend→frontend) **tumbó el ítem con evidencia**, y la verifiqué a mano:

1. **No hay riesgo de 504**: `LlmExtractorService` acota **cada** llamada vision con `timeoutMs: 30_000` ([`llm-extractor.service.ts:432,671`](../../libs/platform-core/src/lib/ai/llm-extractor.service.ts)). El OCR no puede pasarse de los 60 s de nginx. La premisa de mi propio ítem ("un PDF grande se lleva decenas de segundos hasta el 504") era **falsa**.
2. **El 202 rompería el único caso de uso**: `/ocr` es *preview puro*, no persiste nada. Su consumidor es un diálogo abierto: el `next()` prefillea el formulario **y encadena** el match ficha-first (`runCapMatch()`) con el monto y la fecha recién extraídos. Con 202 ese `next()` llega vacío y hay que reconstruir la cadena por WS para no ganar nada.
3. **Los candidatos reales a timeout del módulo son otros, y no son de transporte** — son **costo de query**, así que la respuesta es SQL, no un job:

| Endpoint | Problema | Prio |
|---|---|---|
| `GET /finance/collections/:sucursal/:folio` | **N+1 verificado**: `detail()` llama `bankMatch()` **por cada** depósito adjunto dentro del loop ([`collection-deposits.service.ts:364`](../../libs/finance/src/lib/collection-deposits/collection-deposits.service.ts)) | P2-perf |
| `GET /finance/collections/bank/unmatched` | `EXISTS` correlacionado por fila; el peor candidato a timeout del módulo y no estaba en ninguna lista | P2-perf |

**Regla que queda**: un endpoint largo va a job **solo si su trabajo tiene efecto persistente**. Si es un cálculo efímero que alimenta la pantalla que lo pidió, el arreglo es acotar tiempo (deadline/timeout), no diferirlo. Mismo criterio que llevó al chat de Maat a deadline en vez de cola.

### 3.1 El hallazgo que ordena las prioridades

`location /api/` en [`nginx.conf`](../../nginx.conf) **no define `proxy_read_timeout`** → vale el default de nginx: **60 s**. Todo lo marcado **P0** es una operación síncrona que puede pasarse de ahí: el navegador recibe **504** mientras el backend sigue trabajando, y el usuario no sabe si el import/matcher quedó aplicado. Subir el timeout es un parche (deja un spinner colgado y no sobrevive un reinicio del proceso); el arreglo real es **202 + cola + WS**, que ya está disponible (`pg-boss`, ADR-043) y con patrón de referencia en `libs/fiscal` (descarga SAT).

Nota: ese mismo default de 60 s **cortaba el SSE** del chat cuando una tool tardaba — por eso el keepalive `: ping` de 15 s (COMM.1) no es cosmético.

### 3.2 Backlog priorizado (Finanzas)

- ~~**P0**~~ ✅ **hecho 2026-08-18** — 8 endpoints a `202 + job + WS` + deadline en el chat síncrono. Pendiente de este frente: mover el trabajo a `pg-boss` (necesita worker desplegado + archivo en S3) y persistir el registro de jobs (hoy es memoria del proceso: un reinicio lo borra y otra instancia no lo ve).
- ~~**P1**~~ ✅ **hecho 2026-08-18** — WS `/cobranza` (COMM.6). El ítem de "OCR a job" quedó **descartado con evidencia** (§3.3): el LLM ya está acotado a 30 s y el 202 rompería el prefill. En su lugar salieron dos ítems **P2-perf** de costo de query (N+1 en `detail`, `EXISTS` correlacionado en `bank/unmatched`).
- **P2 — Web Push en Operations** (`apps/view` no lo tiene): aprobaciones pendientes y hallazgo crítico.
- **P3 — matar el polling interno** de `finance-feed-scanner`: que el importer avise al terminar.

---

## 4. Módulos pendientes de revisar

Comercial · Compras · Logística (+ rastreo de flota) · Trade/Horus · Tienda · Almacén/Inventario · Vendedor · Portal B2B · Televenta · Fiscal · Contabilidad · Admin.
