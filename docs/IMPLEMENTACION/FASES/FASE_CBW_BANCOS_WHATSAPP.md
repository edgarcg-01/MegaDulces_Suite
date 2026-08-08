# Fase CBW — Captura bancaria por WhatsApp (ficha/captura → libro de bancos)

> **Estado:** 🟢 CONSTRUIDA (beta, local) 2026-08-06 — CBW.0–CBW.4 ✅ · **ADR:** ADR-042 (aceptado)
> **Tesis:** un número de WhatsApp **ya existente** recibe la foto de una ficha de depósito / captura de transferencia de un remitente autorizado (encargado de plaza); el bot corre **OCR**, la atribuye (persona + sucursal + cuenta + importe), pide **confirmación en el chat**, y la deja en una **bandeja de captura** dentro de `/finanzas/bancos` para que un humano la valide y la cuadre contra el estado de cuenta. Read-first sobre el libro autoritativo: la foto es un **comprobante**, no un asiento — nunca toca `bank_movements` de forma directa. Hereda ADR-016 (motor decide el dinero / humano confirma / LLM fuera del cuadre), ADR-033 (libro de bancos `finance.bank_*`) y ADR-034 (el bot no cierra el dinero).

---

## 1. Tesis (qué hace corta esta fase)

**~85% ya existe.** No se construye el canal, ni el OCR, ni el libro. Se cablea lo que ya está:

| Pieza reusada | Estado | Dónde |
|---|---|---|
| Canal WhatsApp (Meta Cloud API, número existente) + webhook + dedup | ✅ Fase F | [libs/whatsapp](../../../libs/whatsapp/src/lib/) — `meta-cloud.adapter.ts`, `webhook/whatsapp-webhook.controller.ts`, `webhook/whatsapp-ingest.service.ts` |
| OCR ficha/transferencia (imagen **y PDF nativo**) | ✅ Fase CC | `LlmExtractorService.extractDepositSlip()` → `{monto, fecha, banco, cuenta_dest, referencia, ordenante, metodo}` |
| Almacenamiento del archivo | ✅ | `CloudinaryService.uploadDocumentBase64()` |
| Patrón subir→OCR→cuadre→HITL (molde exacto a copiar) | ✅ Fase CC | `libs/finance/.../collection-deposits` |
| Libro de bancos (destino) + catálogo de cuentas/categorías/sucursal | ✅ Fase CB | `finance.bank_*`, `/finanzas/bancos` |
| Identidad E.164 canónica del teléfono | ✅ FIQ.0 | `libs/platform-core/.../mx-phone.ts` (`normalizeMxPhone`) |

**Lo único nuevo:** (1) descargar el binario de la imagen desde Meta (media API — el único sprint pendiente del bot, FIQ.9); (2) un **registro de remitentes** que da identidad al teléfono; (3) ruteo por remitente autorizado que desvía la foto al flujo bancario en vez del bot comercial; (4) una tabla staging + bandeja UI.

---

## 2. Decisiones (Edgar, 2026-08-06)

| Decisión | Elección | Razón |
|---|---|---|
| ¿Qué es "agregar la foto al libro"? | **Bandeja de captura (staging) → humano valida** | La foto es un comprobante, no un asiento. No contamina el cuadre de CB ni viola ADR-016. |
| ¿Quién puede postear? | **Allowlist de remitentes de tesorería** | Un cliente no puede inyectar movimientos falsos. Mismo número puede servir al bot comercial: el ruteo por remitente separa caminos. |
| Autonomía del agente | **Confirma en chat antes de registrar** | Doble control humano (chat + UI). Máxima seguridad sobre el dinero. |
| "El cargo" | **= el importe** (monto de la ficha) | Aclarado por Edgar. Sale del OCR (`monto`) → `amount_in`/`amount_out`. No es puesto ni categoría contable. |

---

## 3. Qué aporta el libro de bancos (`/finanzas/bancos`) + verificación del Excel

Verificación profunda de `01 ENERO 2026.xlsx` (2026-08-06), integridad **confirmada al peso** contra el CONCENTRADO (I $52.95M / C $43.53M / G $6.58M / TI=TE $25.4M). Hallazgos relevantes para el diseño:

- **Los depósitos son exactamente lo que capturaría el bot:** 2,906 depósitos/mes (`M=I`), **99.8% código `102`**, conceptos `VENTAS <plaza>` / `VTA TARJETA <plaza>` / `DEP. EFECTIVO` / `TLMKT`. Son **ventas diarias que cada plaza deposita**.
- **Organizados por sucursal** (`S`): S30 lidera ($10.3M), luego S73, S75, S50, S10… → el remitente WhatsApp mapea 1:1 a una plaza.
- **El nombre de la persona NO está en las hojas de banco**; en CAJA GENERAL se teclea a mano en `DESCRIPCION` ("Jose Mendez"). Con WhatsApp ese nombre lo da el remitente automáticamente.
- ⚠️ **Fragilidad detectada (para CB, no para CBW):** hoja `BBVA 5712` con `A1` corrupto (`3115.7` en vez de `"FECHA"`) → el importer de CB detecta header por la palabra "FECHA" y la omitiría (~$14.3M ingresos). Recomendación lateral: endurecer la detección de header por firma de columnas. **No bloquea CBW** (CBW no re-importa el Excel), se anota como finding en `AUDITORIA_BASE_INICIAL.md`.

### Mapeo XLSX → libro → captura WhatsApp

| Columna Excel | Campo `bank_movements` | En la captura WhatsApp sale de… |
|---|---|---|
| `DEPOSITO`/`INGRESO` | `amount_in` | **OCR `monto`** ("el cargo") |
| `RETIRO`/`EGRESO` | `amount_out` | OCR `monto` (si egreso) |
| hoja + `C`/`CTA` | `bank_account_id` + `raw_code` | **OCR (banco + últimos-4)** → `bank_accounts`; fallback cuenta del remitente |
| `S` | `sucursal` | **sucursal del remitente** |
| `PROVEEDOR`/`DESCRIPCION` | `concept` | **nombre del remitente** + `ordenante` del OCR |
| `M` | `raw_type` | derivado (`I` por defecto en depósito) |
| `FECHA` | `movement_date` | OCR `fecha` |
| — (no existe) | *quién envió* | **teléfono → registro de remitentes** |

---

## 4. Arquitectura

```
Encargado de plaza (WhatsApp, número autorizado)
      │ manda foto de ficha / captura de transferencia
      ▼
POST /webhooks/whatsapp   (verify + HMAC + dedup por wa_message_id)   ◄── YA EXISTE
      │ type=image/document → media_id
      ▼
whatsapp-ingest.service    ── ¿from_phone ∈ bank_capture_senders(active)? ──┐
      │ NO (o sin imagen)                                                    │ SÍ + imagen
      ▼                                                                      ▼
ConversationOrchestrator (bot comercial)                     BankCaptureService  ← NUEVO
      (camino existente, sin cambios)                             │
                                                                  ├─ MetaCloudAdapter.downloadMedia(media_id)  ← CBW.0
                                                                  ├─ CloudinaryService.uploadDocumentBase64()
                                                                  ├─ LlmExtractorService.extractDepositSlip()
                                                                  ├─ resolver bank_account_id (OCR banco+últ4 → catálogo → default del remitente)
                                                                  ├─ INSERT finance.bank_capture_inbox (status='pendiente_confirmacion')
                                                                  └─ responde por WhatsApp: "Leí $X, banco Y, ref Z — ¿confirmo? SÍ/NO"
                                                                        │ SÍ → status='confirmado'   · NO → 'descartado'
      ▼
/finanzas/bancos › pestaña "Capturas WhatsApp"     ← NUEVO
      │ humano revisa preview + edita atribución
      ├─ validar  → status='validado'
      ├─ cuadrar  → liga a un finance.bank_movements real (bank_movement_id)   [cuando el estado de cuenta ya está cargado]
      └─ rechazar → status='rechazado'
```

**Regla dura:** el `BankCaptureService` **nunca auto-asienta al llegar** — la captura vive en `bank_capture_inbox` (staging). Es la **validación humana** (en la bandeja) la que **materializa el depósito como renglón en el libro** (`finance.bank_movements`: `M=I` / código `102` / cobranza, statement del mes de la cuenta, totales actualizados, `client_uuid=whatsapp:<id>` idempotente). Modelo *go-forward* de CB (agosto 2026+ el libro se lleva por la interfaz, no por Excel). El renglón nace `recon_status='pending'` y concilia contra Kepler/ContPAQi como cualquier otro.

---

## 5. Modelo de datos (CBW.1)

Migración nueva `20260806xxxxxx_finance_bank_capture.js` — schema `finance`, RLS forzado + grants `app_runtime`, patrón A.0mt (`tenant_id` NOT NULL + audit).

### `finance.bank_capture_senders` — registro de remitentes (allowlist + identidad)
| Columna | Tipo | Nota |
|---|---|---|
| `id` | uuid PK | |
| `tenant_id` | uuid NOT NULL | RLS |
| `phone` | text NOT NULL | E.164 canónico (`normalizeMxPhone`) |
| `full_name` | text NOT NULL | nombre de la persona → atribución |
| `sucursal` | text NULL | código `S` de su plaza (30/73/10…) |
| `default_bank_account_id` | uuid NULL FK `bank_accounts` | cuenta por defecto si el OCR no resuelve |
| `active` | bool DEFAULT true | si no está o `false` → no postea |
| audit | | `created_at/by`, `updated_at` |
| | | **UNIQUE(tenant_id, phone)** |

### `finance.bank_capture_inbox` — la captura
| Columna | Tipo | Nota |
|---|---|---|
| `id` | uuid PK | |
| `tenant_id` | uuid NOT NULL | RLS |
| `source` | text DEFAULT `'whatsapp'` | |
| `from_phone` | text NOT NULL | E.164 |
| `sender_id` | uuid NULL FK `bank_capture_senders` | quién envió |
| `wa_message_id` | text | idempotencia (**UNIQUE(tenant_id, wa_message_id)**) |
| `files` | jsonb | `[{url, public_id, kind}]` Cloudinary (patrón CC) |
| `ocr_status` | text | `ok/ilegible/sin_key` |
| `ocr_monto/ocr_fecha/ocr_banco/ocr_cuenta_dest/ocr_referencia/ocr_ordenante/ocr_metodo` | | crudo del OCR |
| `bank_account_id` | uuid NULL FK `bank_accounts` | resuelto (o a mano) |
| `sucursal` | text NULL | del remitente |
| `concept` | text NULL | nombre remitente + ordenante |
| `amount_in` / `amount_out` | numeric DEFAULT 0 | "el cargo" |
| `movement_date` | date NULL | del OCR |
| `status` | text DEFAULT `'pendiente_confirmacion'` | CHECK IN (`pendiente_confirmacion, confirmado, validado, rechazado, descartado`) |
| `bank_movement_id` | uuid NULL FK `bank_movements` | cuando se cuadra contra el estado de cuenta |
| audit | | `validated_by`, `validated_at`, `created_at/by`, `updated_at` |

Índices: por `status`, por `from_phone`, parcial `WHERE bank_movement_id IS NULL` (pendientes de cuadre).

---

## 6. Sprints

| Sprint | Tema | Entregable | Estado |
|---|---|---|---|
| **CBW.0** | Media download (FIQ.9) | `MetaCloudAdapter.downloadMedia(media_id)`: `GET /{media_id}` (Graph) → URL temporal → descarga binario con token → `{buffer, mime}`. Habilita `type=image` y `type=document` en `whatsapp-ingest`. Simulador: inyecta un data-URI directo. Smoke del contrato media_id→bytes. | ✅ 2026-08-06 (local) |
| **CBW.1** | Schema + remitentes | Migración `bank_capture_senders` + `bank_capture_inbox` (RLS forzado, grants, audit). Seed de remitentes de Edgar (teléfono→nombre→sucursal→cuenta). Permisos (§7). | ✅ 2026-08-06 (local) |
| **CBW.2** | Ruteo + captura + OCR | En `whatsapp-ingest`: si `from_phone ∈ senders(active)` **y** trae imagen/documento → `BankCaptureService.capture()` (download → Cloudinary → `extractDepositSlip` → resolver cuenta → INSERT `pendiente_confirmacion`), **NO** al orquestador comercial. `BankCaptureService` calca `collection-deposits.service`. | ✅ 2026-08-06 (local) |
| **CBW.3** | Confirmación en chat | Máquina de estado mínima por teléfono: tras capturar, el bot responde con lo leído y pide `SÍ/NO`. `SÍ`→`confirmado`, `NO`→`descartado`, timeout/ambiguo→se queda pendiente y avisa. Idempotente ante reenvíos. | ✅ 2026-08-06 (local) |
| **CBW.4** | Bandeja UI + cuadre | Pestaña **"Capturas WhatsApp"** en `/finanzas/bancos`: tabla densa (remitente, sucursal, cuenta, monto, estado) + preview de la imagen + editar atribución + validar/rechazar + botón **cuadrar** contra `bank_movements` (reusa el matcher por monto+fecha de CB). Backend `/finance/bank-captures`. Smoke suite en `run-all-tests.js`. | ✅ 2026-08-06 (local) |
| **CBW.4.1** | Notificación a Crédito y Cobranza | Al registrar/confirmar un nuevo depósito, **avisar a Crédito y Cobranza** (Perla) reusando el sistema de notificaciones existente (bell header + toast WS, patrón CXP/`db_health_alerts`). La notificación lleva remitente + sucursal + monto + link a la captura, para que Cobranza aplique el depósito al cliente. Dirigido por permiso/rol de crédito y cobranza (no hardcodear a una persona). | ✅ 2026-08-06 (local) |
| **CBW.4.2** | Manejo de errores + prevención | Blindaje defensivo de todo el pipeline con estado registrado (`error_detail`) + aviso a Cobranza en cada falla: **no se subió** (Cloudinary falla → guarda la captura igual + reintento sugerido), **no es válido** (OCR sin monto/banco/ref → "no parece comprobante"), **no se pudo escribir en el libro** (postToLedger falla al validar → registra + notifica + no marca validado). La captura se guarda SIEMPRE (no se pierde evidencia). UI: fila resaltada + chip de advertencia + contador "N con problema". Éxito limpia el error. Mig `20260806140000` (`error_detail`). Smoke 27/27. | ✅ 2026-08-06 (local) |
| **CBW.5** | Sin SÍ/NO — número solo interno | Decisión de Edgar: el número es **solo para depósitos internos**. Cada foto entra **directa a la bandeja como "por validar"** (`status='confirmado'`) — se quita el paso de confirmación por chat (el "sí" en lote era ambiguo cuando el encargado manda varios seguidos). El bot solo **acusa recibo** ("✅ Recibí tu depósito de $X"). Un autorizado que manda texto sin foto recibe un **recordatorio** ("📸 mándame la foto"), NO cae en el bot comercial. Cada foto = captura independiente (1 min o 10 días da igual; nada se pierde). **Cobranza es el único gate** (valida → materializa). Notificación a Cobranza en cada depósito nuevo. Smoke DB 26/26 + HTTP E2E. | ✅ 2026-08-08 (local) |

**Ruta crítica:** CBW.0 → CBW.1 → CBW.2 → CBW.3 → CBW.4 (secuencial; CBW.0 y CBW.1 son independientes entre sí y adelantables en paralelo).

> Regla del proyecto: cada sprint cierra con smoke test + entry en `01_TRACKER_PROGRESO.md` + build OK. Todo se construye y prueba con `WHATSAPP_PROVIDER=simulator` (inyectando por `POST /webhooks/whatsapp/sim`); solo el envío/recepción real en prod exige credenciales Meta.

---

## 7. Permisos

Reusar los de CB (independencia por módulo, no crear silo nuevo):
- **`FINANCE_BANK_VER`** — ver la bandeja de capturas.
- **`FINANCE_BANK_GESTIONAR`** — validar / rechazar / cuadrar / administrar el registro de remitentes.

Backfill migration + re-login (patrón `KEY IS NULL`).

---

## 8. Requisitos operativos (Edgar, fuera de código)

Bloquean **producción real**, NO el desarrollo con simulador:

1. Credenciales Meta reales en Railway: `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_APP_SECRET`, `WHATSAPP_VERIFY_TOKEN` + `WHATSAPP_PROVIDER=meta` (hoy el canal está en simulador).
2. `ANTHROPIC_API_KEY` en Railway (ya requerido por Maat/OCR).
3. `CLOUDINARY_*` en Railway (ya requerido).
4. **Lista de remitentes** (teléfono → nombre → sucursal → cuenta) — el importer ya está listo: `database/scripts/seed-bank-capture-senders.js` (CSV/JSON, normaliza teléfono, resuelve cuenta, UPSERT idempotente, dry-run por default). Solo falta llenar la lista y correr `--apply`. Formato CSV: `phone,full_name,sucursal,cuenta`.
5. Confirmar que el número es interno; si se comparte con el bot comercial, el ruteo por allowlist ya separa caminos (mismo número, dos flujos según remitente).
6. Migración de las 2 tablas + permisos aplicada a Railway (Batch nuevo).

---

## 9. Diferido / decisiones abiertas

- **Cuadre automático captura↔estado de cuenta**: el MVP cuadra a mano en la bandeja; automatizar el match (monto+fecha, tolerancia $1, greedy) reusando el matcher de CB.4.1 queda como CBW.5.
- **Multi-imagen por captura** (ficha + comprobante): el schema (`files` jsonb) ya lo soporta; el flujo del bot arranca con 1 imagen/mensaje.
- **Notas de voz / audio** (el encargado dicta el depósito): diferido (patrón STT, ADR abierto en FIQ).
- **Outbound proactivo** ("faltó tu depósito de hoy"): fuera de alcance; vive en el motor de reorden/nudges si se quisiera.
- **PaymentsService / cobro online**: N/A — esto es evidencia de depósito, no cobro.

---

## 10. Referencias

- **ADR-042** (propuesto) — Captura bancaria por WhatsApp: la foto es comprobante en staging (nunca asiento directo); allowlist de remitentes da identidad al teléfono; humano valida y cuadra. Hereda ADR-016/033/034.
- [`FASE_F_WHATSAPP_BOT.md`](FASE_F_WHATSAPP_BOT.md) — canal Meta + webhook + adapter (base reusada).
- [`FASE_FIQ_BOT_WHATSAPP_10X.md`](FASE_FIQ_BOT_WHATSAPP_10X.md) — FIQ.9 (media download) es el enabler compartido con CBW.0.
- [`FASE_CB_CONCILIACION_BANCARIA.md`](FASE_CB_CONCILIACION_BANCARIA.md) — libro `finance.bank_*` (destino) + matcher de cuadre.
- [`FASE_CC_COMPROBANTES_COBRANZA.md`](FASE_CC_COMPROBANTES_COBRANZA.md) — patrón subir→OCR→cuadre→HITL (molde a copiar).
