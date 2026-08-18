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
| 2 | **REST 202 + cola + aviso** | trabajo largo fuera del request | la operación tarda **> 5 s** o es reintentable (import, matcher, OCR, scan) | ⚠️ patrón usado solo en `libs/fiscal` (descarga SAT) |
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
| `POST /bank/import` (XLSX hasta 25 mb, ~6.5k movs/mes) | REST **síncrono** | **202 + `pg-boss` + WS con progreso** | supera fácil los 60 s de nginx → 504 con el import a medias y el usuario sin saber si quedó | **P0** |
| `POST /bank/match` (conciliación, 2 pases) · `POST /findings/sync` · `POST /reclassify` | REST **síncrono** | **202 + cola + WS** | mismo riesgo; además son idempotentes y reintentables (encajan exacto en una cola) | **P0** |
| `POST /finance/maat/scan-now` (10 detectores) | REST **síncrono** | **202 + cola + WS** | el nocturno ya corre por `@Cron`; el botón manual es el mismo trabajo largo | **P0** |
| `POST /finance/maat/chat` (fallback del SSE) con `deep_search` | REST **síncrono** (12 iteraciones × Claude + tools) | **solo stream**, o 202 + cola | el fallback puede tardar minutos: choca con los 60 s justo cuando el SSE ya falló | **P0** |
| Chat de Maat `POST /chat/stream` | **SSE** + keepalive + cancelación | ✅ **igual** | correcto por diseño (ver ADR-045) | — |
| OCR (`/collections/ocr`, `/supplier-payments/ocr`, `/goods-receipts/ocr`, `/expenses/comprobaciones/ocr`) | REST **síncrono** (Claude vision) | **202 + cola + WS por documento** | el usuario espera mirando; un PDF grande o un reintento se lleva decenas de segundos | **P1** |
| `/finanzas/cobranza` (CC) | REST, **sin WS** | **WS** (`collections_changed`) | asimetría: su gemelo `/finanzas/pagos-comprobantes` **sí** tiene gateway; misma bandeja, mismo comportamiento esperado | **P1** |
| `/finanzas/hallazgos` (bandeja de Maat) | REST; el aviso llega por la **campana** (`/alerts`) | **WS de invalidación** en la propia página + REST | hoy hay que recargar a mano para ver el resultado de un scan que ya terminó | **P1** |
| Sheet-sync del workbook maestro (`@Cron` 3 min + botón manual) | `@Cron` ✅ + WS ✅; el botón es síncrono | cron igual; **botón → cola** | Google Sheets no puede empujar: el cron es correcto. El botón comparte el riesgo del import | **P1** |
| `/finanzas/tareas` (recon MA) | REST | **WS de invalidación** | igual que hallazgos | **P2** |
| Aprobaciones HITL: `/solicitudes`, `/comprobaciones`, `/programa-pagos`, `/pagos-control` | REST | REST ✅ + **Web Push** al aprobador | la acción puntual es REST puro; lo que falta es enterarse cuando algo entra a `pending_approval` sin tener la pestaña abierta | **P2** |
| Capturas de banco por WhatsApp (CBW) | **webhook entrante** (HMAC) + WS | ✅ igual + **Web Push** al validador | el depósito llega de noche; el gate humano no está mirando la pantalla | **P2** |
| Aviso "llegó feed nuevo" (Kepler/ContPAQi) | **`@Cron` cada 30 min que compara conteos** en nuestra propia DB | **que avise el importer** (webhook interno o job en cola) → WS inmediato | es polling contra nuestra propia base: el productor sabe exactamente cuándo terminó (regla 6) | **P3** |
| Caja general | REST + import por CLI | REST ✅ | volumen y frecuencia no piden más | — |
| Lectura de Kepler / ContPAQi / Wincaja | SQL directo desde importers | ✅ igual | ADR-040: la plataforma lee del SoR, no le escribe | — |

### 3.1 El hallazgo que ordena las prioridades

`location /api/` en [`nginx.conf`](../../nginx.conf) **no define `proxy_read_timeout`** → vale el default de nginx: **60 s**. Todo lo marcado **P0** es una operación síncrona que puede pasarse de ahí: el navegador recibe **504** mientras el backend sigue trabajando, y el usuario no sabe si el import/matcher quedó aplicado. Subir el timeout es un parche (deja un spinner colgado y no sobrevive un reinicio del proceso); el arreglo real es **202 + cola + WS**, que ya está disponible (`pg-boss`, ADR-043) y con patrón de referencia en `libs/fiscal` (descarga SAT).

Nota: ese mismo default de 60 s **cortaba el SSE** del chat cuando una tool tardaba — por eso el keepalive `: ping` de 15 s (COMM.1) no es cosmético.

### 3.2 Backlog priorizado (Finanzas)

- **P0 — un solo patrón resuelve 4 endpoints**: `POST /bank/import`, `POST /bank/match` (+ `findings/sync`, `reclassify`), `POST /maat/scan-now` y el fallback `POST /maat/chat` con `deep_search` → `202 { job_id }` + `pg-boss` + evento WS al terminar (reusando `bancos.gateway` donde aplica).
- **P1 — simetría de tiempo real**: gateway/evento para `/finanzas/cobranza` y para la bandeja de hallazgos; OCR y el botón de sheet-sync a cola.
- **P2 — Web Push en Operations** (`apps/view` no lo tiene): aprobaciones pendientes y hallazgo crítico.
- **P3 — matar el polling interno** de `finance-feed-scanner`: que el importer avise al terminar.

---

## 4. Módulos pendientes de revisar

Comercial · Compras · Logística (+ rastreo de flota) · Trade/Horus · Tienda · Almacén/Inventario · Vendedor · Portal B2B · Televenta · Fiscal · Contabilidad · Admin.
