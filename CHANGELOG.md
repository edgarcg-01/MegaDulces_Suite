# Changelog

> Cambios notables del repo Trade Marketing. Vivo como complemento de
> [`docs/IMPLEMENTACION/03_LOG_REVISIONES.md`](docs/IMPLEMENTACION/03_LOG_REVISIONES.md) (detalle de sprints) y
> [`docs/IMPLEMENTACION/01_TRACKER_PROGRESO.md`](docs/IMPLEMENTACION/01_TRACKER_PROGRESO.md) (kanban). Este archivo es para "¿qué cambió las últimas N semanas?" sin abrir git log.
>
> Convención: secciones por fecha (más reciente arriba). Cada release agrupa por **Added / Changed / Fixed / Deprecated / Removed / Internal**. Actualizar al cerrar sprint o feature relevante.

---

## [Unreleased]

### Fixed — Catálogo: costo por mediana+ancla-de-precio y factor de caja correcto (2026-07-15)
- **Costo (kdik.c16):** dos SKUs mostraban costos absurdos (`83780`=$906, `83785`=$610 cuando lo real es ~$42/~$29). Causa: `liveCostVotes` tomaba, entre valores singleton (el redondeo por sucursal impide colisiones a 4dp), el **más grande** — justo la basura de valuación de md_00 — y el guard "conserva snapshot si difiere >10×" **preservaba la basura porque el snapshot .245 traía el mismo 906**. Nuevo `liveCost`: **mediana** entre sucursales + rechazo de outliers >4×/<0.25×, anclada a la **regla de precio de la casa** (`c90/1.2333`, no al snapshot). **429 costos ≥3× corregidos** (no 133).
- **Factor de caja (Exist. Caja / CostoXCaja):** los `/20KG` Gustinos mostraban CostoXCaja=costo y Exist.Caja=piezas (factor_venta=1 en snapshot). El factor de VENTA vive en **`c81` (pz/paq)**, no en `c84` (que es la **caja máster**: TIC TAC c81=12 / c84=144). Regla segura: conservar `factor_venta` del snapshot cuando ya es >1 (dulces/goma/refresco correctos), rellenar desde `c81` solo cuando quedó en 1 (granel). **154 fills, 0 regresiones** sobre factores >1. Ej.: `PAQ COCA COLA 355ML/24`→24, `MAZAPAN /40`→40, pasta `/20KG`→20.
- Aplicado a prod (UPDATE 11,992); ya vive vía el cron nightly. Sin deploy (dato).

### Fixed — /comercial/salidas: productos con existencia sin venta ya aparecen (2026-07-15)
- El reporte se anclaba en `analytics.product_sales` → los productos lento-movimiento (existencia real pero 0 ventas en el período) **no aparecían**. Ahora `salidasReport` anexa un query desde `commercial.stock` (misma forma que la meta), **scopeado a las sucursales con venta en el período** (subquery, para no meter CEDIS/Morelia/Canindo fuera de alcance), dedup contra ventas, y en el merge quedan con Venta=0 / cobertura=null. Verificado: `70244` (stock 8 en Padre Hidalgo, 0 ventas 30d) ahora entra. **Requiere redeploy API.**

### Changed — Fase FISCAL: el frontend fiscal es su propio proyecto "Contabilidad" (2026-07-15)
- Por decisión de Edgar, **todo lo fiscal es un proyecto aparte "Contabilidad"** (`/contabilidad/*`), separado de Finanzas. Las 9 páginas + sus servicios se movieron de `modules/finanzas/` a `modules/contabilidad/` y se renombraron `Contabilidad*Component`; nuevo `CONTABILIDAD_TABS`. **Finanzas** conserva solo egresos/solicitudes/hallazgos/Maat.
- Nuevo proyecto de primer nivel: tarjeta en `/projects` (icono calculator, gate por los perms `FISCAL_*`), rama en `LayoutComponent` (`currentProject='contabilidad'` + nav propio + **early-return** para roles contables sin `REPORTES_VER_*` + label), nodo en `authz-tree`. Rutas `/contabilidad/*` con `permissionGuard`. Build view producción verde.

### Added — Fase FISCAL: frontend (surface Operations) (2026-07-15)
- **Foundation:** 5 permisos fiscales nuevos en el enum frontend (`FISCAL_CFDI_VER`, `FISCAL_CONCILIACION_VER`, `FISCAL_DIOT_VER`, `FISCAL_CONTAB_VER`, `FISCAL_DESCARGA_VER/GESTIONAR`, `FISCAL_CREDENCIALES_GESTIONAR`) + `permission-meta` (labels/categoría Finanzas) + `authz-tree` (nodos bajo Finanzas). 4 tabs nuevos en `FINANZAS_TABS` + 4 rutas en `/finanzas/*` con `permissionGuard`.
- **3 páginas nuevas + wire de Listas SAT** (Operations: page-head Hanken, `p-table` sm, Geist Mono + `tabular-nums`, quiet-luxury monocromático con sunset solo en activo, tokens canónicos, `:host{display:block}`, matriz de estados loading/empty/error con empty≠error, dark first-class por tokens que flipean):
  - **CFDI** (`/finanzas/cfdi`) — almacén 4.0: KPIs (CFDI/monto/IVA/PPD) + filtros (rol/tipo/fechas/búsqueda) + tabla densa con paginación lazy server-side; estatus SAT como badge semántico.
  - **Conciliación** (`/finanzas/conciliacion`) — dos vistas: REP (PPD sin REP / saldo insoluto) y Cruce CFDI↔póliza (gastos sin CFDI / CFDI sin registrar), con KPIs por vista.
  - **DIOT / IVA** (`/finanzas/diot`) — selector de periodo + resumen de IVA (trasladado/acreditable → a cargo/favor) + DIOT por proveedor (tercero/operación/base/IVA).
  - **Listas SAT** (`/finanzas/listas-sat`) — ya existía, ahora **ruteada + en tabs** (estaba huérfana).
- Empty-states honestos: "se llena al correr la descarga masiva" (fiscal.cfdis vacío = esperado, no error).
- **Slice 2 (5 páginas más):** **Descarga masiva** (`/finanzas/descarga`, bandeja + alta con dialog + expand a paquetes, gate `FISCAL_DESCARGA_GESTIONAR`), **Materialidad** (`/finanzas/materialidad`, dossier por RFC: veredicto + cadena orden→recepción→factura→pago + listas), **Contabilidad electrónica** (`/finanzas/contabilidad`, descarga XML catálogo/balanza vía Blob), **Impuestos provisionales** (`/finanzas/impuestos`, form ISR+IVA con coeficiente + desglose + nota "validar con contador"), **Credenciales/e.firma** (`/finanzas/credenciales`, estado de vigencia + alta cifrada con upload .cer/.key→base64 + confirm de borrado). +6 tabs, +5 rutas, +6 nodos authz-tree. `p-dialog`/`p-confirmDialog` para overlays (sombra+borde, correcto). **Fix:** `@else if (x; as y)` no se permite en Angular control-flow → `@if` anidado.
- **Verificado:** `nx build view --skip-nx-cache` producción verde (ambos slices). **Pendiente:** verificación visual (light/dark/móvil) — requiere servir el build.

### Added — Fase FISCAL (FISCAL.18): impuestos provisionales ISR + IVA (2026-07-15)
- **`ImpuestosService.pagoProvisional`** (`libs/fiscal/impuestos`): cálculo de apoyo del pago provisional mensual. **ISR** (Art. 14 LISR) = ingresos nominales acumulados del ejercicio (balanza `analytics.ledger_monthly` familia 4, abonos−cargos) × **coeficiente de utilidad** × tasa (30%) − PTU − pérdidas − pagos provisionales previos − ISR retenido. **IVA** reusa `DiotService.ivaResumen` (flujo efectivo PUE/PPD). Devuelve ISR + IVA + total a pagar.
- El **coeficiente de utilidad es un input obligatorio** (viene de la declaración anual del ejercicio anterior; no se puede derivar de la contabilidad corriente). `GET /fiscal/impuestos/provisional?period=YYYY-MM&cu=…&ptu=&perdidas=&pagos_previos=&retenido=`. Permiso `FISCAL_DIOT_VER`.
- **⚠️ Cálculo de APOYO — validar con contador antes de declarar** (la respuesta incluye esta nota). **Validado vs prod:** ingresos Ene-Jul 2026 = $387M (familia 4, ~$55M/mes, consistente con la venta anual ~$671M); aritmética ISR correcta (base×tasa).
- **Con esto el backend fiscal queda completo (beta):** capas 1-7 del mapa. Diferidos menores: PDF representación impresa, pólizas XML (PLZ), evidencia foto en materialidad, mapeo `CodAgrupador` SAT.

### Added — Fase FISCAL (FISCAL.10.1): expediente de materialidad por proveedor (2026-07-15)
- **`MaterialidadService`** (`libs/fiscal/materialidad`): arma el expediente de defensa de un proveedor (clave si es EFOS). Reúne, determinista: estatus en listas SAT (EFOS 69-B/Art.69, `fiscal.sat_list_matches`), CFDIs recibidos + cancelados (`fiscal.cfdis`), y la **cadena de suministro** (orden→recepción→factura→pago de `analytics.expense_doc_chain` — la recepción física es la evidencia más fuerte de materialidad) + operaciones/monto (`analytics.expense_documents`). Emite un **veredicto heurístico** (crítico/revisar/parcial/sólida).
- **API** `GET /fiscal/materialidad/:rfc`. Permiso `FISCAL_LISTAS_VER` (defensa EFOS = dominio listas). Sin tablas nuevas.
- **Validado contra prod REAL:** expediente de DISTRIBUIDORA DE LA ROSA (DRO020122GZ9): 390 operaciones, $52.5M, 371 cadenas con **95% de recepción física → veredicto SÓLIDA**. CFDIs/listas vacíos hasta correr descarga/ingesta (degradación correcta). El backend devuelve el expediente en JSON; el PDF y la evidencia foto anexa quedan al frontend (jsPDF).

### Deployed (Railway prod) — Fase FISCAL: 8 migraciones fiscales aplicadas a producción (2026-07-15)
- Aplicadas a **Railway prod** (`trolley.proxy.rlwy.net/railway`) vía `knex migrate:up` una por una (batches 114-121) las **8 migraciones fiscales** (`160000`–`170600`). **Solo fiscales:** las 2 migraciones de Horus pendientes (`horus_chat_log`, `execution_thresholds_auto`, de otro thread) se dejaron **sin aplicar** deliberadamente (no deployar trabajo ajeno como efecto secundario).
- **Validación prod:** 11 tablas `fiscal.*` + RLS FORCE + 8 políticas + permisos en 36/36 roles + fix crítico FISCAL.3 verificado en tabla real (sin 42P10, job de prueba limpiado) + balanza FISCAL.9 contra `analytics.ledger_monthly` prod (jul-2026, 176 cuentas, cuadra).
- **⚠️ SEGURIDAD:** el password de la URL usada es uno de los 3 expuestos en el incidente 2026-07-14 y **sigue sin rotar** — usar/rotar es acción de Edgar; se usó solo transitoriamente (env var, nunca a archivo). **Pendiente prod:** `FISCAL_CRYPTO_KEY`/`FISCAL_R2_*` en env + redeploy del API (endpoints `/fiscal/*` no vivos hasta reconstruir la imagen) + re-login + correr descarga.

### Deployed (dev) + Verified — Fase FISCAL: migraciones aplicadas a la DB nueva + validación 15/15 (2026-07-15)
- **Migraciones APLICADAS** a la DB nueva de desarrollo (`localhost:5433/postgres_platform`, contenedor Docker `pgvector-md` = `DATABASE_URL_NEW`; el default `.245` está obsoleto). `npx knex migrate:latest --knexfile database/knexfile-newdb.js` → **batch 179, 10 migraciones** (las 8 fiscales `160000`–`170600` + planogram + horus, todas pendientes). Perms fiscales backfilleados a **56 roles**. (Se arrancó Docker Desktop + `pgvector-md`, que estaba caído).
- **Validación contra la DB real 15/15:** 11 tablas `fiscal.*` con RLS ENABLE+FORCE + 8 políticas + grants a `app_runtime`; permisos en los 56 roles (admin `FISCAL_CFDI_VER=true`); **fix crítico FISCAL.3 verificado en la tabla real** (`ON CONFLICT` índice parcial sin 42P10 + dedup, job de prueba limpiado); RLS aísla por tenant; **FISCAL.9 balanza contra `analytics.ledger_monthly` REAL** (jul-2026: 176 cuentas, `SaldoFin=SaldoIni+Debe−Haber` cuadra en todas, Σdebe≈Σhaber≈$44.9M — el descuadre ~$12k es el bug conocido de Kepler XD5501, no del código).
- Antes: validación de lógica 26/26 en arnés desechable + parsers CFDI/REP + balanza XML validados local.
- **Pendiente (prod / infra):** aplicar migraciones a **Railway prod**, `FISCAL_CRYPTO_KEY`/`FISCAL_R2_*` en env, **redeploy del API** (el contenedor corre imagen vieja → endpoints `/fiscal/*` aún no vivos), re-login, correr descarga masiva para poblar `fiscal.cfdis`, validar las 2 firmas WS del SAT en sandbox, mapeo `CodAgrupador`.

### Added — Fase FISCAL (FISCAL.9): contabilidad electrónica (XMLs SAT) (2026-07-14)
- **`ContabilidadElectronicaService`** (`libs/fiscal/contabilidad`): genera on-the-fly desde `analytics.ledger_monthly` (balanza consolidada por todas las sucursales):
  - **Balanza de Comprobación** (SAT BCE 1.3): `SaldoIni` = Σ neto de los meses previos del mismo ejercicio; `Debe`/`Haber` del mes; `SaldoFin` = SaldoIni + Debe − Haber. FULL OUTER JOIN mes↔inicial (incluye cuentas con saldo pero sin movimiento). `FechaModBal` = último día del mes. Validado local (XML bien formado + aritmética de saldos).
  - **Catálogo de Cuentas** (SAT 1.3): NumCta/Desc/Nivel (1 mayor, 2 subcuenta)/Natur (D activo/costos/gastos, A pasivo/capital/ingresos)/SubCtaDe.
- **API** `GET /fiscal/contabilidad-electronica/{balanza,catalogo}?period=YYYY-MM` (devuelve `application/xml`). RFC del contribuyente vía `?rfc=` o la e.firma activa (`fiscal.sat_credentials`). Permiso `FISCAL_CONTAB_VER` (mig `20260714170600`, solo permiso).
- **⚠️ `CodAgrupador`** (código agrupador del SAT) no existe en Kepler → placeholder = mayor; para XML 100% válido falta el mapeo `cuenta_mayor → código agrupador SAT`. Pólizas XML (namespace PLZ) diferido.
- **Verificado:** `nx build api` producción verde; balanza XML validada local (well-formed + SaldoFin=SaldoIni+Debe−Haber). **Pendiente:** aplicar migración + mapeo CodAgrupador. **Siguiente: FISCAL.10** (PDF + expediente de materialidad) o FISCAL.18 (impuestos provisionales).

### Added — Fase FISCAL (FISCAL.6): validación de estatus CFDI ante el SAT (2026-07-14)
- **`EstatusService` + `SatEstatusService`** (`libs/fiscal/estatus`): consulta el WS público del SAT `ConsultaCFDIService` (SOAP, **sin e.firma** — solo la expresión `?re=&rr=&tt=&id=`) por lote y actualiza `fiscal.cfdis.estatus_sat` (vigente/cancelado/desconocido) + `estatus_checked_at`. Re-consulta a los 30 días (el emisor puede cancelar después). Throttle 150 ms entre llamadas. Transporte detrás del port `SAT_ESTATUS_PORT`.
- **Hallazgo `cfdi_cancelado` (critical) a Maat:** un CFDI recibido que el SAT reporta CANCELADO y que se dedujo/acreditó es deducción improcedente → bandeja de Maat. Cierra el bucle con conciliación/DIOT, que ya excluían `estatus_sat='cancelado'`.
- **API** `POST /fiscal/estatus/check` (lote manual) + **cron** 09:00 UTC por tenant. Reusa `FISCAL_CFDI_VER` (sin migración nueva).
- **Verificado:** `nx build api` producción verde. **⚠️ El formato de `tt` (total) que espera el WS debe validarse contra el servicio real** con un CFDI conocido (como la firma de FISCAL.4). **Pendiente:** poblar `fiscal.cfdis`. **Siguiente: FISCAL.9** (contabilidad electrónica XML) o FISCAL.10 (PDF + materialidad).

### Added — Fase FISCAL (FISCAL.8.1): DIOT + conciliación de IVA (2026-07-14)
- **`DiotService`** (`libs/fiscal/diot`): arma la DIOT del periodo (YYYY-MM) desde `fiscal.cfdis` recibidas con **IVA efectivamente pagado** (flujo): PUE cuenta en el mes de la factura; PPD en el mes del pago (REP), prorrateando el IVA por `ImpPagado` de `fiscal.cfdi_payment_links`. Un renglón por proveedor con `tipo_tercero` (04 nacional / 05 extranjero / 15 global inferido del RFC) y `tipo_operacion` (default '85'). `GET /fiscal/diot?period=YYYY-MM`.
- **Conciliación de IVA:** `ivaResumen(period)` = IVA acreditable (recibidas pagado) vs trasladado (emitidas cobrado) → IVA a cargo / a favor. Formaliza el efecto PUE/PPD en el acreditamiento. `GET /fiscal/diot/iva`.
- **Permiso** `FISCAL_DIOT_VER` (mig `20260714170500`, solo backfill de permiso — la DIOT se calcula on-the-fly, sin tabla ni WS). Determinista, sin LLM.
- **Verificado:** `nx build api` producción verde; migración `170500` valida sintaxis. **Pendiente:** poblar `fiscal.cfdis` (descarga masiva) + aplicar migración + sync `FISCAL_DIOT_VER` en enum frontend. **Siguiente: FISCAL.6** (estatus CFDI vigente/cancelado ante SAT — otro WS) o FISCAL.9 (contabilidad electrónica).

### Added — Fase FISCAL (FISCAL.5.2): conciliación CFDI ↔ póliza contable (heurística) (2026-07-14)
- **Hallazgo (investigación en vivo de Kepler):** Kepler **no almacena el UUID del CFDI**. Verificado contra las 6 sucursales (192.168.9.95/10.10/42.42/40.40/44.44/54.54): las tablas de facturación electrónica `kdfecfd`/`kdcecfdpol`/`kdfecedocuuid`/`kdfecfdcom` están **vacías** en todas; `kdm1` (200 cols) no trae UUID; lo único poblado son catálogos SAT (Carta Porte: productos/pedimentos/unidades) + config del emisor. Mega Dulces no usa Kepler para CFDI → los recibidos llegan solo de la descarga masiva (FISCAL.4). **⇒ el cruce exacto por UUID es imposible; se hace heurístico.**
- **`PolizaCruceService`** (`libs/fiscal/conciliacion`): casa `fiscal.cfdis` (recibidas) contra `analytics.expense_documents` (pólizas Kepler) por **RFC + importe ±$1 + fecha ±5 días**. `analytics.expense_documents` no tiene RLS → filtro de tenant explícito; `fiscal.*` sí (tk.run).
  - **CFDI sin póliza:** comprobante recibido no registrado como gasto (siempre en alcance).
  - **Póliza sin CFDI:** gasto/deducción sin CFDI que lo respalde — **coverage-scoped**: solo dentro de rangos ya descargados (`download_requests.estado='descargada'`), para no marcar todo gasto como sin comprobante antes de correr la descarga masiva.
- **API** `/fiscal/conciliacion/cruce/{stats,cfdi-sin-poliza,poliza-sin-cfdi,scan}`. **Hallazgos a Maat:** `poliza_sin_cfdi` (riesgo de deducción sin soporte) + `cfdi_sin_poliza` (gasto no contabilizado). Sumado al cron nocturno de conciliación. Permiso `FISCAL_CONCILIACION_VER`.
- **Verificado:** `nx build api` producción verde. **Pendiente:** poblar `fiscal.cfdis` (correr descarga masiva) para que el cruce arroje resultados; afinar tolerancias con data real. Sin migración nueva (reusa tablas existentes).

### Added — Fase FISCAL (FISCAL.5.1): conciliación PUE/PPD ↔ REP (complementos de pago) (2026-07-14)
- **`fiscal.cfdi_payment_links`** (mig `20260714170400`, RLS forzado): materializa los `DoctoRelacionado` de cada CFDI tipo 'P' (REP) → qué factura PPD liquida, con `imp_pagado`/`imp_saldo_insoluto`/`num_parcialidad`. UNIQUE `(tenant, rep_uuid, docto_uuid, num_parcialidad)` (parcialidad default 1 para deduplicar en re-ingesta).
- **Parser REP** (`CfdiParserService.extractPagos`): para tipo 'P' extrae el complemento `Pagos` 1.0/2.0 (namespace-agnóstico vía `removeNSPrefix`). La ingesta persiste los links junto con los CFDI (mismo flujo de `handlePaquete`). Validado con REP real (2 DoctoRelacionado, UUID `"0012"` intacto).
- **`ConciliacionService`** (`libs/fiscal/conciliacion`): sobre `fiscal.cfdis` + `cfdi_payment_links`, determinista: **saldo insoluto** por factura PPD (`total − Σ ImpPagado`), **PPD sin REP**, y `stats`. API `/fiscal/conciliacion` (`stats` / `ppd-sin-rep` / `saldo-insoluto` / `POST scan`). Permiso `FISCAL_CONCILIACION_VER`.
- **Hallazgos a Maat:** el scan empuja `ppd_sin_rep` (warn, riesgo de no deducibilidad/IVA no acreditable) y `ppd_saldo_insoluto` (info) a `finance.findings` vía `FINANCE_FINDINGS_SINK_PORT` (idempotente por `dedup_key`, respeta L2). **Cron nocturno** 08:00 UTC por tenant activo.
- **Verificado:** `nx build api` producción verde; migración `170400` valida sintaxis; parser REP validado local. **Pendiente:** aplicar migración a DB + smoke + re-login + sync `FISCAL_CONCILIACION_VER` en enum frontend. **Siguiente: FISCAL.5.2** (CFDI ↔ póliza contable, requiere schema `analytics.expense_documents`).

### Added — Fase FISCAL (FISCAL.2/3/4): bóveda credenciales + job runner Postgres + descarga masiva CFDI (2026-07-14)
- **FISCAL.2 — Bóveda de credenciales SAT** (`libs/fiscal/vault`): guarda la e.firma (cert público tal cual; `.key`/contraseña/CIEC **cifradas AES-256-GCM** con master key en env `FISCAL_CRYPTO_KEY`, no AWS KMS — decisión Railway). `CryptoService.withDecryptedEfirma` descifra en memoria y **zeroiza** los buffers en `finally`. Parsea vigencia + valida RFC del `.cer` (X509). API `/fiscal/credentials` (alta base64 / status no sensible / delete); el material cifrado nunca sale por API. Permiso `FISCAL_CREDENCIALES_GESTIONAR`. Schema `fiscal.sat_credentials` (RLS forzado, mig `20260714170000`).
- **FISCAL.3 — Cola de trabajos en Postgres** (`libs/fiscal/jobs`, reemplazo de BullMQ per regla): `fiscal.jobs` (RLS) + `JobQueueService` (encolado idempotente por `dedup_key`) + `JobRunnerService` (@Cron 30s, claim `FOR UPDATE SKIP LOCKED` por tenant, backoff exponencial + full jitter, DLQ `status='dead'`, registro de handlers por `type`, `FiscalPermanentError` = no-retry). Mig `20260714170100`.
- **FISCAL.4 — Descarga masiva de CFDI (WS SAT)** (`libs/fiscal/descarga`), informado por el doc SAT de Verificación: pipeline `solicitud→verificación(polling one-shot)→paquete` orquestado sobre `fiscal.jobs`, firmando con la e.firma de la bóveda. Máquina de estados con los `EstadoSolicitud` 1-6 del doc + códigos (300-305/5000-5011). Transporte SOAP detrás del port `SAT_SOAP_PORT` (impl referencia `SatSoapService` con node:crypto RSA-SHA1). Schema `fiscal.download_requests`/`download_packages` (RLS, mig `20260714170200`). API `/fiscal/descarga`. Permisos `FISCAL_DESCARGA_VER/GESTIONAR`.
  - **⚠️ La firma WS-Security debe validarse contra el sandbox del SAT** antes de prod; el port permite swapear a `@nodecfdi/sat-ws-descarga-masiva` sin tocar la orquestación.
- **FISCAL.4.2 — Parser + almacén CFDI 4.0** (`libs/fiscal/cfdi`): `fiscal.cfdis` (cabecera indexada + `impuestos`/`raw` JSONB, RLS forzado, UNIQUE tenant+uuid, mig `20260714170300`). `CfdiParserService` (`fast-xml-parser`, `removeNSPrefix`, **`parseAttributeValue:false`** → RFC/folio `"0012"` NO se corrompe a `12`; extrae UUID/timbre/impuestos; validado con CFDI 4.0 real). `CfdiIngestService` descomprime el ZIP (`adm-zip`), parsea y hace UPSERT idempotente por chunks (200). `CfdiStorageService` sube el ZIP a **R2** (env `FISCAL_R2_*`, WORM/Object-Lock best-effort, degrada a "no almacenado" si falta config; 1 PUT por paquete). Cableado en `handlePaquete`: el paquete queda `parseado` con `num_cfdis`. API `/fiscal/cfdi` (list/stats/get), permiso `FISCAL_CFDI_VER`.
- **Fixed — 13 hallazgos de review adversarial (24 agentes) sobre FISCAL.2/3/4:**
  - **CRÍTICO** `job-queue`: `ON CONFLICT (tenant_id, dedup_key)` no infería el índice **parcial** (`WHERE dedup_key IS NOT NULL`) → 42P10 en **cada** enqueue → pipeline muerto. Fix: predicado en el conflict target.
  - `job-runner`: sin reaper, un crash/redeploy a media dejaba jobs en `running` para siempre. Fix: reset de `running` con lock vencido (>10min) → `pending`. Hook `onDead` para reconciliar el agregado al llegar a DLQ.
  - `orchestrator`: (1) Terminada con 0 paquetes colgaba el request → cierra `descargada`; (2) paquete en DLQ dejaba el request colgado + error no persistido → `deadPaquete` marca `error` + reconcilia; (3) blip transitorio del WS (estado 0) abandonaba una solicitud viva → sigue polleando; (4) skip-guard `'terminada'` + loop no re-ejecutable strandeaban paquetes → guard relajado + loop recupera id existente; (5) `handleSolicitud`/`handlePaquete` idempotentes (no re-solicita ni re-descarga).
  - `sat-soap`: `attr('EstadoSolicitud')` matcheaba dentro de `CodigoEstadoSolicitud` → `\b` ancla el nombre. `sat-ws.types`: `5003`/`5011` → permanentes (no reintentar). `crypto`: si el 2º `open()` lanzaba, la llave privada ya descifrada no se zeroizaba → movido dentro del `try`.
- **Verificado:** `nx build api` producción verde; 4 migraciones validan sintaxis; parser CFDI 4.0 validado con XML real (gotcha `"0012"` OK). **Pendiente:** aplicar migraciones a DB nueva (LAN inalcanzable) + `FISCAL_CRYPTO_KEY` + `FISCAL_R2_*` en env + smoke + re-login + sync `FISCAL_CFDI_VER` en enum frontend.

### Fixed — FISCAL.1.1 periodo corrupto en el bridge a Maat (2026-07-14)
- El bridge calculaba `periodo` con `String(fecha).slice(0,7)` sobre una columna `date` que pg devuelve como `Date` → producía `"Tue Jul"` en vez de `"2026-07"`, corrompiendo el agrupamiento por mes de `finance.findings`. Fix: formateador `ym()` que usa componentes locales de `Date` o slice de string. (Hallazgo del review adversarial de FISCAL.1.1.)

### Added — Fase FISCAL (FISCAL.0+FISCAL.1): motor de listas SAT + validación de RFC (2026-07-14)
- **Nuevo proyecto/dominio `libs/fiscal`** (`@megadulces/fiscal`) — primera capacidad de auditoría fiscal/cumplimiento SAT. Frontera limpia: depende solo de `platform-core`. Adaptado al stack del proyecto (Cron + Postgres, **sin BullMQ/Redis/AWS KMS** del SDD original). Mapa completo de 28 módulos en [`FASE_FISCAL_CONTABILIDAD.md`](docs/IMPLEMENTACION/FASES/FASE_FISCAL_CONTABILIDAD.md).
- **Motor genérico de listas SAT** (endosado por Edgar): un solo schema/servicio cruza **N listas** contra los RFCs de proveedores del tenant (`analytics.expense_documents`, que YA tiene RFCs reales). No depende del WS de Descarga Masiva. Motor determinista (SQL puro), sin LLM. Listas nuevas = 1 entrada en `sat-lists.config.ts`, cero cambios de schema.
  - **FISCAL.0 = EFOS (CFF Art. 69-B):** presuntos/definitivos/desvirtuados.
  - **FISCAL.1 = Art. 69** (créditos firmes/exigibles/cancelados/no localizados/sentencias/CSD sin efectos; URLs Azure Blob del SAT confirmadas por research, override `LISTA69_CSV_URLS`) **+ validación estructural de RFC** (`formato_invalido`, `rfc_generico`) sobre los proveedores.
- **Schema (mig `20260714160000_fiscal_sat_lists`):** GLOBALES `fiscal.sat_list_rfcs` / `sat_list_staging` / `sat_list_versions` (dato público, sin RLS, discriminador `lista`) + TENANT-SCOPED `fiscal.sat_list_matches` y `fiscal.rfc_issues` (RLS forzado) con triage humano (`nuevo|en_revision|confirmado|descartado`). Permisos `FISCAL_LISTAS_VER` ← `FINANCE_EXPENSES_VER`, `FISCAL_LISTAS_GESTIONAR` ← `FINANCE_FINDINGS_GESTIONAR`.
- **Ingesta idempotente por hash:** `SatListIngestService` descarga las URLs de cada lista (Latin1), parser quote-aware con header por nombre de columna (config por lista), merge con detección de delta. `SatListCrossService` (cruce, preserva triage), `RfcValidationService` (estructural), `FiscalListasService` (bandejas/stats/drill/triage), `FiscalListasScannerService` (@Cron 07:00 UTC).
- **API `/fiscal/listas/*`:** `matches` (filtra por lista/situación/estado, ordenada por gravedad), `stats`, `status`, `matches/:rfc/documents` (drill), `rfc-issues`, `PATCH .../estado` (triage), `POST scan` (tenant actual), `POST refresh` (descarga + cruce global).
- **FISCAL.1.1 — bridge a `finance.findings` (bandeja unificada de Maat):** los proveedores en listas SAT (situación de riesgo) y los RFC con problema estructural se consolidan como hallazgos en la bandeja de Maat, vía **port de inversión** `FINANCE_FINDINGS_SINK_PORT` (declarado en `@megadulces/contracts`, implementado por `MaatFindingsSinkService`, ligado en el composition root `FinanceFindingsSinkBindingModule`). `libs/fiscal` NO importa `libs/finance` (frontera limpia). El sink registra la regla en `rule_registry` antes del finding (respeta la FK), respeta la auto-supresión L2 (omite reglas suprimidas), es idempotente por `dedup_key` y NO pisa el `status` (triage humano). 4 reglas nuevas: `proveedor_efos`, `proveedor_lista69`, `rfc_formato_invalido`, `rfc_generico`. Disparado por `POST /fiscal/listas/scan` (tenant actual) y por el cron nocturno (todos los tenants). Best-effort: si Maat no está, es no-op.
- **Decisiones (Edgar):** (1) motor de listas/CFDI en `libs/fiscal`, hallazgos consolidados en `finance.findings` (Maat) — ✅ FISCAL.1.1; (2) object storage XML = **Cloudflare R2 con Bucket Locks** (egress $0, S3-compatible, WORM real; Cloudinary solo para fotos) — a implementar en capa documental; (3) deploy target Railway (e.firma → pgcrypto/env, no AWS KMS).
- **Verificado:** `nx build api` producción verde; migración valida sintaxis; smoke `test-newdb-fiscal-efos.js` en la regresión. **Pendiente:** aplicar migración a DB nueva (LAN `.245` no alcanzable desde esta sesión) + smoke/regresión + re-login (permisos) + verificar HEAD de URLs Art. 69 + página frontend + sync enum Permission frontend.

### Added — Fase W: ingesta del POS Wincaja (Access 97) a `wincaja.*` (2026-07-13)
- **ADR-031.** Sucursales de Mega Dulces corren un POS distinto a Kepler — **Wincaja**, en **Access 97 (Jet 3.5)**, un `.mdb` por sucursal en `.245`. Feasibilidad verificada: ACE 12/16 rechazan el formato 97; abre `Microsoft.Jet.OLEDB.4.0` **32-bit** read-only, sin instalar nada.
- **8 sucursales pobladas** (crosswalk `wincaja.branches`): `00 BPIRAPUATO`, `10 PHIDALGO`, `30 MORELIA ABASTOS`, `32 MORELIA MADERO`, `40 8ESQUINAS`, `44 YURECUARO`, `50 CANINDO`, `54 ZAMORA CENTRO` (`42 PIEDAD` vacía → fuera). Vivas hoy en Wincaja (movs julio): 00/30/32/50; `40/44/54` último mov ene-mar (ya en Kepler); `10` a fin de junio. Las que Kepler no ve (30/32/50) hoy están **ciegas** en la plataforma → traerlas = cobertura nueva, no duplicación.
- **Dos carpetas / datasets:** `Actuales` (vivo, período corriente — las 8) + `Concentradas` (histórico consolidado — solo 10/30/32/50). Coexisten vía columna **`source_dataset`** en el PK → no se pisan.
- **Decisión:** landing schema separado `wincaja.*` (21 tablas espejo, RLS forzado, `tenant_id` + `source_branch` + `source_dataset`) + crosswalk. **Nunca** merge en `commercial.*`/`analytics.*`. Recarga full por (sucursal, dataset) = idempotente. El solapamiento con Kepler se vuelve conciliación (feature).
- **Importer 2 etapas** (`database/importers/wincaja/`): (A) `extract-table.ps1` PowerShell 32-bit + Jet 4.0 → JSONL; (B) `import-wincaja.js` Node → dedupe last-wins + recarga full con `SET LOCAL app.tenant_id`; resuelve filename por prefijo (case-insensitive), BPIRAPUATO usa su archivo `MOV` (masters+movs). Numéricos = `numeric` sin precisión (bronze acepta la fuente tal cual, incl. `CostoPromedio` corrupto 2.29e16). CLI `--branch <cod|all> --domain <...|all> --dataset <actual|concentrada|both> --apply`.
- **Migración `20260713120000_wincaja_landing_schema`** aplicada local. **Pendiente prod:** migración a Railway + agendar importer en `.245` (LAN) + confirmar cadencia real de las carpetas.

### Added — Agrupamiento por área de roles y usuarios en /admin (2026-07-11)
- **`/admin/roles`:** el grid de roles ahora se agrupa en secciones por área (Sistemas, Mercadotecnia, Compras, … + "Externos" y "Otros/heredados"), con header por área y conteo.
- **`/admin/users`:** la tabla (desktop, `rowGroupMode` subheader) y las cards (mobile, secciones) se agrupan por el área del rol de cada usuario.
- **Mapa área↔rol** en `role-presets.ts`: los 13 roles de plantilla mapean a su propia área; los roles **heredados** (superadmin/admin→Sistemas, jefe_marketing→Mercadotecnia, vendedor/supervisor→Rutas, tele_operator→Telemarketing, customer_b2b→Externos, etc.) mapean vía `LEGACY_ROLE_AREA` (editable) para que el agrupamiento sea útil desde ya; lo no mapeado cae en "Otros".
- Solo presentación (sin cambios de authz). **Pendiente prod:** redeploy `view`.

### Added — Roles por área (13 roles) + plantillas en el editor (2026-07-11)
- **Modelo:** 1 rol por área del organigrama Mega Dulces, permisos en 2 niveles — PRIMARIO (ver+gestionar de los módulos core) + SECUNDARIO (ver+gestionar de módulos vecinos, por orden/estética). `prevencion_auditoria` = secundario **solo-ver global** (integridad de auditoría); `sistemas` = acceso total.
- **13 roles:** `sistemas, contabilidad, compras, mercadotecnia, credito_cobranza, prevencion_auditoria, tesoreria, finanzas, rh, sucursal, cedis, rutas, telemarketing`. Conviven con los roles actuales (no los pisa).
- **Fuente única:** `apps/view/.../core/constants/role-presets.ts` (`MODULE_GROUPS` + `AREA_PRESETS` + resolver). La migración `20260711120000_area_role_presets_seed` replica la composición y crea los roles por tenant (`ON CONFLICT DO NOTHING`, idempotente).
- **Plantillas en `/admin/roles`:** selector "Aplicar plantilla…" que rellena el árbol con la plantilla del área (respeta anti-escalation; deja dirty para revisar y guardar).
- **Pendiente prod:** redeploy `view` + migración `20260711120000` + reasignar usuarios + re-login.

### Added — Auto-received: cierra las OC contra la orden de entrada de Kepler (RA.15.1) (2026-07-10)
- **Cierra el ciclo sin captura manual.** Mega Dulces hace la recepción **en Kepler** (doc `X-A-40`), no en la plataforma → nuestras OC quedarían `open` para siempre. El feed `import-auto-received.js` (on-prem, BULK) detecta el `X-A-40` y genera la OE que cierra la OC.
- **No mueve stock:** como Kepler ya procesó el `X-A-40`, esa existencia **ya viene en el snapshot nocturno** → la OE va con `source='kepler'` + `stock_applied=false` (evita doble-conteo). Mig `20260710200000` (`goods_receipts.source` + `source_kepler_folio` + índice único parcial = idempotente).
- **Matching heurístico** (decisión Edgar, sin folio compartido / sin write-back): por **presencia sku+almacén+fecha**. Un `X-A-40` posterior a la OC (mismo almacén) con el sku de una línea pendiente → la cierra en full (la qty Kepler viene en PAQ/CJA ≠ piezas; MD captura de golpe → fill ~100%). Dedup por folio + OC más vieja primero + cap al pendiente.
- **Verificación:** smoke `test-auto-received-matching.js` **9/9** + integración contra `md_03` real (4,266 líneas de entrada / 347 folios; concilia correcto). Wireado en `run-prod-feeds.js` (nightly, tras `import-in-transit`).
- **Limitación consciente:** el match es por presencia (no reconcilia cantidad exacta por la ambigüedad de unidad); como no toca inventario, un falso positivo sólo afecta estado/fill-rate de la OC. **Pendiente prod:** aplicar mig `20260710200000` a Railway + agendar el feed en el runner.

### Added — Cadena de compra real: Requisición → OC → OE que mueve stock (RA.15, ADR-031) (2026-07-10)
- **Motivación (Edgar):** el flujo de compras aplastaba la cadena de Kepler en flags de estado ("cada paso sólo cambia un botón"). Re-verificado contra Kepler vivo (`md_03`): la compra son **documentos distintos** — `X-A-30` requisición (opcional) → `X-A-35` OC → `X-A-37` vale → `X-A-40` orden de entrada (**única que toca el kardex `kdij`**) → `X-A-20` aplica/CxP. Conteos 6-12m (br03): 279 req / 781 OC / 765 entrada; 504 OCs directas.
- **Schema** (mig `20260710180000`, batch 164 local): `commercial.purchase_orders`+`_lines` (OC, folio `OC-YYYY-NNNNN`, estado `open→partial→received→cancelled`), `commercial.goods_receipts`+`_lines` (OE, folio `OE-YYYY-NNNNN`, **parciales**), `commercial.purchase_doc_sequences`. RLS forzado + FK compuestas `(tenant_id, id)`.
- **Backend** `CommercialPurchaseOrdersService` (`/commercial/purchase-orders`): generar OC desde requisición aprobada (RQ→ordered), OC directa, lista/detalle, cancelar, y **recepción (OE) que MUEVE `commercial.stock`** (`in` al destino; traspaso además `out` al origen con clamp). Overlay optimista — el snapshot nocturno de Kepler reconcilia (sin doble-conteo permanente). Al completar: OC→received + RQ→received (traza). Fill rate = recibido/pedido.
- **Frontend** `/compras/ordenes` (lista con avance) + `/compras/ordenes/:id` (detalle + diálogo de recepción parcial con costo real). Botón "Generar orden de compra" en la requisición aprobada. Nav "Órdenes de compra".
- **Verificación:** smoke `test-newdb-purchase-chain.js` **21/21** (en la regression); builds api+view OK.
- **Diferido:** vale `X-A-37` + CxP `X-A-20` (→ PaymentsService, Fase LM); auto-received por matching contra `X-A-40`; espejar traspaso género `N`. **Pendiente prod:** aplicar mig a Railway + redeploy api+view + re-login.

### Added — Diario de movimientos: export a Excel y PDF (DM.6) (2026-07-13)
- `GET /commercial/movements/export.{xlsx,pdf}` (mismos filtros que la vista: rango, almacenes, tipo, dirección, estado, búsqueda). **Excel** = 2 hojas: "Documentos" (folios englobados con estado de traspaso + auditoría, cap 5,000) y "Traspasos" (validación salida↔recepción con Δ). **PDF** = KPIs + ambas tablas (cap 1,200 docs, nota al truncar). Patrón SellOutExport (ExcelJS + puppeteer). Botones Excel/PDF en el header de `/almacen/movimientos`.
- **Rediseño empresarial de ambos formatos (2026-07-13)**, alineado a DESIGN.md (Stone + sunset). **PDF**: masthead con marca + acento sunset, 5 KPI cards, chips de traspasos, secciones numeradas, pills semánticas de estado, folios en mono, encabezado de tabla repetido por página, fila TOTAL, footer con "Página X de Y" + sello de uso interno. **Excel (eficiencia)**: masthead oscuro + cinta sunset, banda de 5 KPIs por hoja, **autofiltro + paneles congelados + sin gridlines**, fechas como valores reales (filtrables), estados con relleno semántico, **data bars en Valor**, Δ en +/− rojo, fila de totales, `printTitlesRow` al imprimir y tabs coloreados. Smoke runtime: XLSX re-leído con ExcelJS (valida merges/data bars) + PDF verificado visualmente. **Gotcha**: el HTML del PDF debe fijar `background:#fff` explícito — con el OS en dark, Chrome pinta la hoja oscura (el Sell-Out ya lo llevaba).
- **Tope de tránsito 15 días en el pareo** (medido: 99.4% de los pareos exactos ≤11d): coincidencias de folio con docs de semanas atrás ya no generan "diferencia" fantasma → clasifican "sin origen". Calidad final: **308/316 exactos (97.5%), 8 diferencias reales** (patrón detectado: la sucursal 05 recibe sistemáticamente más de lo que CEDIS documenta; faltante 120 pzs CEDIS→03 folio 0000190 validado contra crudo).

### Changed — Catálogo: IVA/IEPS desde la tasa realmente FACTURADA (CFDI 4.0 vivo) (2026-07-14)
- **Decode nuevo `md.kdfe4imp`** (impuestos por concepto del CFDI 4.0): `c11`=impuesto SAT ('002' IVA / '003' IEPS), `c14`=tasa, `c12`='Tasa', y se une al documento Kepler por `c4..c8` + `c9`=nº de línea → `kdm2.c7` → SKU. Es la tasa **legalmente cobrada al cliente**, no la config. Validado: 631 SKUs facturados @01; el snapshot difería 16% en IVA y 30% en IEPS (desfase).
- `import-catalog-bulk` la adopta con criterio conservador: **≥3 facturas y ≥90% de consistencia** por SKU (unión de las 6 sucursales, ~22.5k impuestos leídos); si no hay evidencia suficiente se queda la del snapshot. Aplicado a prod: **414 productos con tasa corregida**. Distribución resultante coherente (4,374 IEPS 8% sin IVA = dulces; 2,131 IVA 16%; 262 ambos).

### Changed — Catálogo: costos y datos base ahora de Kepler VIVO (overlay kdii/kdik) (2026-07-14)
- `import-catalog-bulk` ahora **superpone datos vivos sobre TODO el catálogo** en cada corrida (no solo altas): **costo unitario CIVA = `kdik.c16`** (decode validado contra la regla de precio de la casa: `precio_pieza = c16 × 1.2333`, exacto en múltiples SKUs), costo por caja (`c16 × kdii.c84`, o el UXC implícito del snapshot), barcode (`c7`) y unidad (`c11`) rellenan si faltan. Costo por **moda entre las 6 sucursales** + seguro anti-basura de valuación (el kdik del CEDIS trae valores tipo 0.00016; con 1 solo voto se exige ≤10× del snapshot). Aplicado a prod: **11,992 productos actualizados, 4,190 con costo distinto al snapshot** (~30% del catálogo tenía costos viejos; incluye correcciones de base pieza-vs-paquete como Kinder Huevo 155.61→19.84 que inflaba ×8 el costo de venta en /salidas). Los 153 costos $0.01 = marcadores promo reales (ya excluidos por `is_promo`).
- **Fix deadlock reproducible** del merge: `SHARE ROW EXCLUSIVE` no frena `SELECT … FOR UPDATE` (ROW SHARE compatible) y su UPDATE posterior cerraba el ciclo → lock subido a **`EXCLUSIVE`** (los SELECT normales no se bloquean).
- Con esto TODO lo operativo lee Kepler vivo: catálogo (altas+costos), ventas, etiquetas/precios, stock, reorden, tránsito, movimientos. Del snapshot `.245` solo quedan campos fríos (descripción/IVA/factores/ubicaciones).

### Fixed — /comercial/salidas: productos nuevos de Kepler invisibles (delta kdii vivo) (2026-07-14)
- **Caso reportado (marca "Pablo Ignacio Michel Ontiveros", línea 795):** sus 4 productos con venta real (cereales 200g, ~700 unidades desde 29-jun) no aparecían. Causa raíz en cadena: (1) el sync de catálogo lee `catalogo_completo`/`productos_activos` de `.245` — **tablas snapshot con refresh MANUAL, desfasadas** — que no traían los SKUs nuevos; (2) el feed de ventas descarta SKUs sin catálogo → tiraba sus unidades; (3) el reporte solo pinta filas con venta.
- **Fix de fondo:** `import-catalog-bulk` ahora hace un **delta de altas desde `kdii` VIVO** (unión de las 6 sucursales; sku/nombre/línea→brand/barcode/unidad, costos NULL hasta que la consolidación refresque). Encontró **555 SKUs** fuera de la consolidación → 438 altas aplicadas a prod. Feeds mensual+diario re-corridos (SKUs sin match: ~600→79). La marca pasó de 1 producto visible a **los 13 de Kepler** con venta en 5 sucursales. El cron nocturno ya trae el delta para futuras altas.
- **Lección de decode:** el folio Kepler colisiona ENTRE SERIES del mismo tipo — UD10 tiene 3,561 folios multi-serie en 2026 solo en la 01 → todo join `kdm1⋈kdm2` de facturas DEBE incluir `c5` (serie). Los tipos del Diario de movimientos no colisionan (verificado 0 en 2026).

### Added — Diario de movimientos: Aplicación de orden de entrada como doc informativo (DM.9) (2026-07-14)
- Decode: **"Aplicación de orden de entrada" = `XA2001` (`ApEntOr1`)**, el paso CONTABLE de la cadena de compras (`OC 35 → vale 37 → orden 40 → aplicación 20`) que genera la CxP al proveedor. `k_binv=0` y **espeja las líneas de su XA40 1:1** (verificado: mismo folio, 830 pzs, $3,472.25 idénticos) → sumarla doblaría las entradas. Catálogo `doctype` completo (37 tipos) documentado en `ERP_KEPLER_SCHEMA.md`.
- Se carga al feed como **tipo informativo**: `movement_kind='info'`, `signed_qty=0` (importer `INFO_TYPES` dir=0). El service la **excluye de KPIs y listado por default**; aparece solo al filtrar por su tipo de documento — ahí la vista muestra sus importes (total CxP del rango). Drill completo: líneas + chip "Aplica a la orden de entrada {folio} · no mueve inventario". Tag neutro (secondary), Cantidad "—" en listado y exports. Reseed prod con las aplicaciones incluidas.

### Added — Diario de movimientos: filtro Origen/Destino de traspasos (DM.8) (2026-07-14)
- Nuevo multiselect **"Origen/Destino (traspasos)"**: muestra solo documentos de traspaso donde el origen **o** el destino (propio o **contraparte del pareo**) esté en la selección — responde "¿qué se llevó A Zamora?" desde las salidas del CEDIS, cosa que el filtro Almacenes (dueño del documento) no puede. Param `transfer_wh_ids` (CSV); reusa el camino en-memoria del filtro Estado (`annotateTransferStatus` ahora guarda `cp_warehouse_id`), se combina con Estado, y aplica también a `transfers-check` (origen O destino ∈ selección) → exports incluidos. Con el filtro activo, summary/aggregate se acotan a docs de traspaso (la fila de día es navegación; el corte exacto por contraparte vive en la expansión y el export). Limitación de datos: una salida **en tránsito** no registra destino (el back-pointer vive en la recepción) → solo matchea por su origen.

### Changed — Diario de movimientos: PDF más legible (DM.6c) (2026-07-13)
- Tipografía del PDF escalada para lectura (cuerpo 8.5→9.5px, **cifras 10.5px**, KPIs 13.5→17px, folios mono 9.5px, pills 8.5px, headers 8px) + más aire en filas. Se **quita la columna "Líneas"** del PDF (el Excel la conserva para filtrar). Verificado con render visual.
- **Almacén por NOMBRE en vez de código** (`01` → "Padre Hidalgo") en toda la superficie DM: tabla por día, diálogo del documento (header, barra de relación, contraparte), Excel (columna Almacén + Origen/Destino de traspasos, anchos ajustados) y PDF. Backend: `lines/document/counterpart` devuelven `warehouse_name`; en `transfers-check` los campos de display `origin_wh/dest_wh` ahora traen `coalesce(name, code)`.

### Fixed — Diario de movimientos: valorización usaba el costo UNITARIO como importe (DM.7) (2026-07-13)
- **Caso real reportado (Orden de entrada `0000179` alm 01):** el detalle mostraba $47/$50/$50 y total $147 para 400/62.55/41.05 unidades — "no cuadra". Causa: el feed leía **`kdm2.c12` como importe de línea**, pero en Kepler **`c12` = precio/costo unitario y `c13` = importe** (`c13 = c9×c12`, verificado **100% en 18 tipos de documento × 4 sucursales**, Σ idénticas). El doc real vale **$24,100.97**. El decode original validó cantidades contra existencia, nunca importes; los demás importers (pólizas, kardex, ventas por ruta, tickets) siempre usaron `c13` — solo `import-stock-movements.js` estaba mal.
- **Fix:** importer ahora `unit_cost = c12` y `amount = c13` (fallback `qty×c12`). **Reseed prod: 96,562 líneas** de las 6 sucursales; folio verificado en Railway: 3 líneas · 503.60 · $24,100.97 exacto. Todo "Valor" del reporte (columna, KPI "Valor movido", exports) queda ahora en importes reales — es fix de datos, la página viva ya lo muestra sin redeploy.
- **Cantidades fraccionarias (KG):** la UI redondeaba (503.6 → "504"); ahora `number:'1.0-2'` en la página y 2 decimales en los exports (enteros se ven limpios). Decode corregido en `ERP_KEPLER_SCHEMA.md`.

### Fixed — Diario de movimientos: pareo con guard de fechas + líneas sin catálogo (DM.5) (2026-07-13)
- **Caso real reportado (folio 0000227):** la UI pareaba la recepción `0000102@03` (07-08) con el `0000227` del **CEDIS (07-13)** — imposible físicamente; el origen verdadero era el `0000227` de la **sucursal 01 (07-07)**, colisión de folios entre sucursales. Validado contra crudo: suc01 1,124 pzs = 1,124 recibidas, **0 SKUs con diferencia**.
- **Fix 1 — guard de fechas:** la recepción nunca es anterior a la salida (`ship.doc_date <= rcv.doc_date`) en los 4 puntos del pareo (transfersCheck LATERAL + unreceived + counterpart del documento + estado por fila). El CEDIS 0000227 ahora clasifica **En tránsito**.
- **Fix 2 — SKUs fuera de catálogo ya NO se descartan:** el importer perdía líneas (610 pzs en ese doc → totales falsos → "diferencia" fantasma). Mig `20260713100000`: `product_id` nullable + columna `sku` denormalizada; `document()` muestra "(sin catálogo)". Reseed prod: **96,156 líneas**.
- **Calidad tras ambos fixes:** 322 pareos reales, **310 exactos (96%)** (antes 268/437 = 61% con falsos positivos); ~160 recepciones "sin origen" = salida anterior a la ventana 120d del feed.
- **UI:** filtro **Estado (traspasos)** = En tránsito / Completado / Con diferencia + columna Estado por documento + **botón Auditar por fila** (además del "Auditar A ↔ B" del diálogo).
- **Pendiente prod:** redeploy api+view + re-login.

### Added — Diario de movimientos: traspasos con contraparte + auditoría humana (DM.3/DM.4) (2026-07-10)
- **Traspasos decodificados por reconciliación** (greedy vs `kdil`, exist=`c4+c8−c9`): entradas `UA50` (recepción) / `NA06/NA25` / **`NA30`** (físico entrada, hallazgo nuevo); salida real del CEDIS = **`UD41`** (reconciliación EXACTA err 45.2→0.0). Excluidos con prueba: `UD13` (factura del traspaso — líneas de SERVICIO sin producto), `UD40` (pedido, duplica), `NA44/NA45` (duplican UA50/XA40), `UD06` consolidación, `UD10` factura, cadena `XA35/37/20/30`. Filtro global de líneas `SER`.
- **Pareo salida↔recepción** por `(tipo 41, serie, folio)` — la recepción guarda `c37/c38/c39` del origen; la serie desambigua folios repetidos entre sucursales. **Ranking LATERAL** (cantidad y fecha más cercanas) porque los folios son secuencias por sucursal y `c10/c11` no discriminan (verificado: par real TI001≠TI002). Mig `20260710170000` agrega `doc_serie/parent_serie` al feed. Validado en prod: **437/440 recepciones con origen**, 268 exactas, 169 con diferencia (= cola del auditor).
- **DM.4 auditoría humana**: `commercial.stock_movement_audits` (mig `20260710180000`, RLS forzado; identidad wh+doc_code+serie+folio; fila = auditado). `POST /commercial/movements/audit` (gate `COMMERCIAL_INVENTORY_SUPERVISAR`); columna "Auditado" en la lista; botón **"Auditar A ↔ B"** tras revisar la comparación.
- **UI simplificada** `/almacen/movimientos`: agrupada **por día** (expandible) → documentos del día → diálogo con **relación explícita** (`🔗 folio A · origen · salida ⟷ folio B · destino · recepción`), banner de validación (recibido / diferencia Δ / sin recepción) y **documento + contraparte lado a lado**. Endpoints nuevos: `GET document` (counterpart + audited + doc_serie), `GET transfers-check`. Fix `NG8007` (expandedRowKeys a one-way).
- **Perf importer**: CTE `MATERIALIZED` (cabeceras primero) — los schemas sync del consolidado no tienen índices y el planner caía a nested-loop 182k×2M (30+ min); ahora **~18s/sucursal**. Reseed prod: **94,151 líneas / 6 sucursales** con series. Migs `170000`+`180000` ya aplicadas a Railway.
- **Pendiente prod:** redeploy api+view (endpoints/página nuevos) + re-login.

### Added — Diario de movimientos: mejora del reporte Kepler (feed + API + página) (2026-07-10)
- **Fase DM** — reemplaza/mejora el reporte Kepler "Almacenes → Reportes → Existencia → Movimientos" (que lee `md.kdm1`⋈`md.kdm2`). Diseño rector: **agregación primero, folio a folio bajo demanda**.
- **DM.0 feed** `analytics.stock_movements` (mig `20260710160000`, line-level, windowed) + importer `database/importers/kepler/import-stock-movements.js` (BULK, reusa `STOCK_BRANCH_MAP`). Qué mueve inventario lo decide el catálogo **autoritativo** `md.doctype` (`k_binv=1`, 14 tipos); el signo sale de la naturaleza (`c3`: `A`=entrada +, `D`=salida −). La factura `U/D/10` NO mueve stock → se excluye. **Validado** reconciliando Σ signed vs `md.kdil` existencia (48≈47 / 98≈84 / 18≈15). Dry-run md_03: 7,792 líneas.
- **DM.1 backend** `libs/commercial/commercial-movements` — `GET /commercial/movements/{summary,aggregate,lines,filters}`. `aggregate` re-agrupa por `product|doc_code|day|warehouse`; `lines` = drill folio a folio. Permiso `COMMERCIAL_INVENTORY_VER`.
- **DM.2 frontend** `/almacen/movimientos` (Operations denso, quiet-luxury): KPIs (entradas/salidas/neto/valor/docs), filtros (agrupación, almacén, fechas, dirección, tipo, búsqueda), tabla agregada + drill en diálogo con los folios. Nav "Movimientos" en Almacén.
- **Doc:** [`ERP_KEPLER_SCHEMA.md`](docs/IMPLEMENTACION/ERP_KEPLER_SCHEMA.md) §"Reporte Diario de movimientos" (taxonomía Género/Naturaleza/Tipo → `c2/c3/c4`, folio `[G][N][Tipo][Serie]`, 7 áreas de mejora).
- **Pendiente prod:** aplicar mig `20260710160000` + correr importer (cron nocturno) + redeploy api+view + re-login.

### Fixed — Comentario en migración `20260710130000` cerraba el bloque `/* */` antes de tiempo (2026-07-10)
- `top-*` seguido de `/erp-promos` formaba `*/` → `SyntaxError: Unexpected token ')'` al cargar la migración → **bloqueaba `migrate:latest`** (y el boot de Railway). Reescrito el comentario. La migración de report-perms nunca había corrido por esto.

### Fixed — Resolución de rol→permisos case-insensitive (raíz de "rebota a captures") (2026-07-10)
- **Causa raíz normalizada:** el lookup `role_permissions.role_name` era case-sensitive en 3 rutas (login MT `auth-mt.service`, login legacy `auth.service`, y `PermissionsCacheService` del guard). Si `users.role_name` (minúscula, convención) difería del `role_permissions.role_name` (p.ej. `Auxiliar_mercadotecnia` capitalizado creado desde la UI) → el rol no se encontraba → **0 permisos** → usuario rebotado a `/dashboard/captures`. Afectaba a `gloria_garcia` y 4 usuarios más.
- **Fix:** los 3 lookups comparan ahora `LOWER(role_name) = LOWER(?)`; la key del cache del guard se normaliza a minúscula (get + invalidate). Un mismatch de mayúsculas deja de romper la resolución — **sin necesitar tocar datos**.
- **Prevención:** `CatalogsService` normaliza `role_name` a minúscula al **crear** y **renombrar** roles.
- El fix de datos (mig `20260710150000`) sigue disponible para dejar la data canónica, pero ya no es requisito.
- **Pendiente prod:** redeploy `api` + **re-login** del usuario (el front lee permisos del JWT del login).

### Added — Permisos dedicados para 2 páginas independientes (ERP promos + Ventas de vendedor) (2026-07-10)
- Continuación del split: se separaron las páginas cuyos endpoints **no** se comparten con hermanas (sin riesgo de 403). Las páginas de flujos cohesivos (Compras, Logística-embarques, Flotilla, Tienda-vivo, Inventario-sesiones) **NO** se parten porque comparten endpoints y el guard backend es AND-only — partirlas daría 403 (requeriría soporte OR en backend).
- **`COMMERCIAL_ERP_PROMOS_VER`** → `/comercial/erp-promos` + endpoint `analytics/erp-promotions` (antes ruta bajo PROMOTIONS_VER y endpoint bajo ANALYTICS_VER — inconsistencia resuelta).
- **`COMMERCIAL_VENDOR_SALES_VER`** → `/comercial/vendor-sales` + los 4 endpoints `commercial/vendor-sales/reports/*` (antes ROUTE_CONTROL_VER, que ahora queda solo para Control de ruta / tickets).
- **Finanzas NO se partió:** `solicitudes` comparte `expenses/filters` y `expenses/sucursales` con `egresos` → es cohesivo, no independiente.
- Cableado completo (enum, ability, meta, authz-tree, ruta, nav, projects anyOf, landing). Migración `20260710140000`: VENDOR_SALES ← ROUTE_CONTROL_VER; ERP_PROMOS ← (PROMOTIONS_VER AND ANALYTICS_VER). Idempotente.
- **Pendiente prod:** redeploy api+view + migración + re-login.

### Fixed — Editor de permisos completo: 8 permisos faltantes ahora visibles/etiquetados (2026-07-10)
- **Auditoría enum vs UI:** 3 permisos eran **invisibles** en el editor árbol de roles (no estaban en `AUTHZ_TREE`) → no se podían otorgar desde `/admin/roles`: `RECONCILIATION_VER`, `RECONCILIATION_GESTIONAR` (Cuadre / Supervisor de movimientos, `/almacen/cuadre`) y `LOGISTICS_HOME_DISPATCH` (Reparto, `/reparto`). Agregados: módulo "Cuadre" en Almacén + nuevo proyecto "Reparto".
- **5 permisos sin label/desglose** en `PERMISSION_META` (aparecían con la clave cruda): `SUPERVISOR_AI_VER`, `SUPERVISOR_AI_APROBAR`, `ROUTE_CONTROL_VER`, `ROUTE_TICKET_CAPTURE`, `LOGISTICS_HOME_DISPATCH`. Agregadas etiquetas + descripción + categoría.
- **Resultado:** los 97 permisos del enum ahora están 100% en el árbol del editor y en el desglose por módulo. Sin migración (los permisos ya existían y estaban asignados; solo faltaba exponerlos en la UI). Redeploy `view` para verlo.

### Added — Split de COMMERCIAL_ANALYTICS_VER en permisos dedicados por reporte (2026-07-10)
- **Continuación del split de Sell-Out a TODOS los reportes** que compartían `COMMERCIAL_ANALYTICS_VER`, para poder acotar un rol a reportes específicos.
- **6 permisos nuevos** (cada uno gatea su página + endpoints): `COMMERCIAL_SALIDAS_VER` (Salidas), `COMMERCIAL_ROUTE_SALES_VER` (Ventas por ruta), `COMMERCIAL_CUSTOMERS360_VER` (Clientes 360 = erp-customers), `COMMERCIAL_HISTORICAL_VER` (Histórico), `COMMERCIAL_DEADSTOCK_VER` (Stock muerto), `COMMERCIAL_INVHEALTH_VER` (Salud de inventario). Traspasos **reusa** el existente `LOGISTICS_TRANSFERS_VER` (su ruta ya lo exigía; se alineó el endpoint `/analytics/transfers`).
- **Command Center** + endpoints agregados (overview/network/top-*/erp-promos/erp-shipments) quedan como paraguas bajo `COMMERCIAL_ANALYTICS_VER`.
- Cableado completo en cada permiso: enum back+front, `ability.factory` (subject+action) + `AppSubject`, `permission-meta`, `authz-tree` (módulos toggleables bajo Comercial/Almacén), rutas, nav, tabs (reports-tabs + customers-tabs), y `projects.component` (anyOf de Ventas/Almacén/Logística).
- **Landing dinámico generalizado** (`landingRedirectGuard` factory): índices de `/comercial`, `/almacen` y `/logistica` ahora redirigen a la primera superficie accesible del rol (antes redirect fijo que rebotaba a roles acotados).
- **Migración `20260710130000`:** backfill no-regresión (roles con `COMMERCIAL_ANALYTICS_VER=true` reciben los 6 nuevos). Idempotente. Transfers sin backfill (quien lo usaba ya tiene `LOGISTICS_TRANSFERS_VER`).
- **Pendiente prod:** redeploy api+view + correr la migración + re-login.

### Added — Permiso dedicado Sell-Out + rol acotado Auxiliar_mercadotecnia (2026-07-10)
- **Problema:** todo el controller `commercial/analytics` (~30 endpoints) y 4+ rutas frontend (command-center, salidas, customers-360, sell-out) compartían el permiso `COMMERCIAL_ANALYTICS_VER`. No había forma de dar acceso a **solo** el reporte Sell-Out.
- **Nuevo permiso `COMMERCIAL_SELLOUT_VER`** (enum back+front, `ability.factory` subject `commercial_sellout`+action `read`, `AppSubject`, `permission-meta`, `authz-tree` como módulo toggleable). Los 5 endpoints `sell-out*` y la ruta+nav frontend pasan a exigir este permiso en vez de `COMMERCIAL_ANALYTICS_VER`.
- **Landing dinámico `/comercial`** (`comercialHomeGuard`): el índice ya no redirige siempre a command-center (que exige analytics) — ahora manda a la primera superficie accesible del rol (command-center → orders → customers → pricing → sell-out). Un rol acotado a Sell-Out aterriza en su página en vez de rebotar a captures.
- **Proyecto "Ventas"** ahora visible también con `COMMERCIAL_ANALYTICS_VER`/`COMMERCIAL_SELLOUT_VER` en su `anyOf`.
- **Migración `20260710120000_commercial_sellout_perm_backfill`:** backfill no-regresión (todo rol con `COMMERCIAL_ANALYTICS_VER=true` recibe `COMMERCIAL_SELLOUT_VER=true`) + grant explícito a `Auxiliar_mercadotecnia`. Idempotente (`-> 'KEY' IS NULL`).
- **Verificación:** builds prod api+view OK. **Pendiente prod:** redeploy api+view + correr la migración (o el SQL equivalente) contra Railway + **re-login** (el frontend gatea por el snapshot de permisos del JWT). La escritura directa a prod se dejó para el deploy controlado (revisión del backfill masivo).

### Fixed — Roles: fuga cross-tenant en lectura/edición + etiqueta "Acceso total" (2026-07-10)
- **Aislamiento multi-tenant en el CRUD de roles (`libs/trade/.../catalogs.service.ts`):** las queries a `role_permissions` corrían por `KNEX_CONNECTION` (no RLS-scoped) filtrando **solo por `role_name`/`id`**. Como `role_permissions` es UNIQUE `(tenant_id, role_name)`, con 2+ tenants el `.first()` era **no-determinista** (mismo footgun que ya se corrigió en `PermissionsCacheService`, incidente 2026-06-16): un tenant podía **leer o sobrescribir** el rol homónimo de otro. Se agregó filtro `tenant_id` explícito (`tenantCtx.requireTenantId()`) en `getByType('roles')`, `getRolePermissions`, `updateRolePermissions` (lookup + UPDATE + `invalidate` ahora tenant-scoped), y en el delete/rename (lookup por PK + **conteo de usuarios asignados**, que sin tenant contaba usuarios de otros tenants → bloqueo/permiso erróneo). Hoy no era explotable (beta single-tenant), era deuda latente antes del 2º tenant.
- **`fullAccess` del grid de roles (`admin-roles-grid.component.ts`):** mostraba "Acceso total" según `REPORTES_VER_GLOBAL`, pero el god-mode real es **por nombre de rol** (`superadmin`/`admin`, ver `ability.factory.isPlatformAdminRole`). Un rol custom con ese flag se pintaba "Acceso total" (falso) y admin/superadmin salían en "NO". Ahora deriva de `PLATFORM_ADMIN_ROLES` — sincronizado con el backend.
- **Verificación:** builds prod api+view OK. Regression: aserciones de aislamiento de roles verdes; único delta 24→23 fue la suite HTTP flaky `http-routes-analysis-test` (ruido teardown libuv en Windows), que aislada pasa **15/15 ×3** con estos cambios. Sin relación causal con el código tocado.

### Fixed — Catálogo: proveedores faltantes, descuadre a cajas e higiene de SKUs legacy (2026-07-10)
- **Investigación (raíz):** validado contra el **código fuente del reporte de existencias de Kepler** (`invrepexsrep.kpl`): existencia por almacén = `kdil.c4+c8−c9` (join `kdii.c1=kdil.c3`, filtro `c1=sucursal, c2=almacén`); por sucursal = `kdik.c4+c5−c6`. Cross-check `kdil` vs `kdik` → **dif=0**. Nuestro feed de stock (`import-branch-stock-live.js`) reproduce la fórmula exacta. **La existencia estaba bien**; los síntomas venían del **catálogo**.
- **Proveedores multi-branch (`import-kepler-suppliers.js`):** antes leía `kdii.c3` solo de **md_03** → ~800 productos sin proveedor porque su ficha vive en otra sucursal. Ahora **une las 6 sucursales** (1er `c3` no vacío gana), reusa `STOCK_BRANCH_MAP`, tolera sucursales caídas. Baja el "sin proveedor" de **~40% → ~15%**.
- **Cajas unit-aware (`salidasReport` + XLSX):** `venta_cajas`/`exist_cja` se calculan **solo si `unit_sale` es pieza (PZA)**; para **CJA** (venta ya en cajas) o **KGS** (granel) dividir por `factor_sale` descuadraba → ahora devuelve `null` y la UI muestra **"—"** en vez de un número incorrecto. Nueva **columna "Unidad"** (PZA/CJA/KGS) en tabla + XLSX, con las no-pieza resaltadas para verificar de un vistazo.
- **Higiene de catálogo (`database/scripts/deactivate-legacy-skus.js`):** soft-delete de SKUs **activos, sin proveedor, sin stock, sin venta y ausentes del maestro `kdii` de las 6 sucursales** (códigos legacy que solo viven en el catálogo agregado de .245). Dry-run por default; **guarda dura** aborta si no alcanza las 6 sucursales. **Aplicado en LOCAL: 3,399 productos** (activos 11,929 → 8,530). Reversible (`deleted_at=NULL`).
- **Pendiente prod (Railway):** redeploy api+view + correr on-prem `import-kepler-suppliers --apply` y `deactivate-legacy-skus --apply` contra Railway. Runbook: [`RUNBOOKS/RUNBOOK_CATALOGO_PROVEEDORES_CAJAS.md`](docs/IMPLEMENTACION/RUNBOOKS/RUNBOOK_CATALOGO_PROVEEDORES_CAJAS.md).

### Added — Etiquetera de anaquel (proyecto Tienda) (2026-07-09)
- **Nueva feature `/tienda/etiquetas`** (permiso `STORE_LIVE_VER`): imprime etiquetas de anaquel con precio escalonado (pieza/mayoreo/paquete/caja), diseño 1:1 del arte Mega Dulces. Buscar en catálogo o pegar lista de códigos + copias por producto.
- **Tabla `commercial.product_label_prices`** (mig `20260709120000_commercial_product_label_prices`): 1 fila/producto — gramaje, barcode validado, matriz de 5 precios + factores; RLS forzado. **Columna `unit_base`** (mig `20260709120000_commercial_product_label_unit_base`, `kdii.c11`): el **precio grande "Precio por ___"** es dinámico — PZA→pieza (c90) · PAQ→paquete (c91, ~76% del catálogo) · KG→kg ($/kg, granel) · CJA→caja (c92).
- **Decode Kepler:** `kdii` (c1/c2/c7/c11/c81/c84/c90/c91/c92) + `kdpv_prod_util` (mayoreo). Barcode se genera del número (Kepler no guarda imagen); simbología por longitud. Gramaje parseado del nombre (cubre `50G/8`, `5K`, `KGS`, `OZ`, `ML`, `LT`).
- **Backend** `libs/commercial/commercial-labels`: `GET /store/labels/search` + `POST /store/labels/resolve` (batch, `TenantKnexService`/RLS). **Importer** `import-label-data.js` (idempotente, no pisa `source='manual'`).
- **Frontend:** `LabelComponent` (115×40 mm, sin iconos, rojo en SKU + nº de piezas, JsBarcode) + página con multiselect de secciones y **simulación de hoja Carta**. Impresión en **hoja Carta horizontal, 2 etiquetas/fila (~8/hoja)** con líneas de recorte, vía iframe aislado (color forzado, `@page` confiable).
- **Prod (Railway):** tablas creadas (`migrate:up`, sin arrastrar migraciones RA) + **8,013 filas cargadas** (SKU 20186 verificado). Detalle en `docs/IMPLEMENTACION/FASES/FASE_ETIQUETAS_ANAQUEL.md`. **Pendiente:** redeploy `view` + re-import on-prem contra Kepler vivo.

### Added — Compras: origen proveedor/sucursal, multi-sucursal, compra segura y flujo de recepción (Fase RA.11–RA.14) (2026-07-09)
- **Investigación: cadena de compras real de Kepler (verificada vivo).** El folio `xa3701-0007556` = **Vale de entrada** (doctype custom `X-A-37`). Cadena completa: Requisición `X-A-30` (opcional) → Orden de compra `X-A-35` → Vale de entrada `X-A-37` → **Orden de entrada `X-A-40` (aquí entra al inventario)** → Aplica/CxP `X-A-20`. **Compra a proveedor (género X) ≠ traspaso desde CEDIS (género N: `N-A-6`/`N-D-6`).** Kepler NO guarda mínimo de pedido ni lead time. Detalle en `docs/IMPLEMENTACION/FASES/FASE_RA_REABASTECIMIENTO.md` §2.5.
- **Origen de surtido por línea (RA.11):** cada línea de la requisición puede ser **compra a proveedor** o **traspaso interno desde otra sucursal** (`source_type`+`source_warehouse_id`; MVP solo clasifica, no mueve inventario). Selector de origen en el dialog de "Generar requisición".
- **Selector multi-sucursal (RA.12):** el reporte de existencia crítica ahora surte **varias sucursales a la vez** (`p-multiSelect`); la selección se agrupa y crea **una requisición por almacén de destino**.
- **Compra segura — mínimo en cajas (RA.13a):** `catalog.suppliers.min_order_boxes` (captura manual, Kepler no lo trae). El dialog **avisa** cuando el pedido a un proveedor no alcanza su mínimo de cajas (Σ `final_qty / factor_purchase`).
- **Flujo post-aprobación (RA.14):** state machine `approved → ordered → received` espejo de la cadena Kepler. Botones **"Marcar ordenada"** / **"Marcar recibida"** en el detalle; la recepción captura `received_qty` por línea → base del **fill rate** (recibido/pedido).
- **Backend:** `commercial-replenishment` — `warehouse_ids` (CSV) en critical-stock/summary, `source_type`/`source_warehouse_id` en el DTO+insert, `markOrdered`/`markReceived`, `setSupplierMinBoxes`. Migración `20260709120000_ra_purchasing_flow` (idempotente): columnas de origen/recepción + `estado` CHECK += `received` + `suppliers.min_order_boxes`.
- **OC en tránsito (RA.5):** `analytics.purchase_in_transit` (mig `20260709140000`) + importer `import-in-transit.js` que lee las órdenes de compra de Kepler (`X-A-35`) **sin** orden de entrada (`X-A-40`) aguas abajo — mercancía pedida que aún no entró. El reporte resta el tránsito del sugerido (`max(0, objetivo − existencia − tránsito)`) y muestra la columna **"OC a recibir"**. Se agenda en el runner nightly.
- **Hallazgos + scanner nocturno (RA.8):** `commercial.replenishment_findings` (mig `20260709160000`) + `ReplenishmentScannerService` (`@Cron` 00:00 MX) que detecta **agotados clase A** (crítica) y **bajo punto de reorden** (alta/media), restando el tránsito. Bandeja **`/compras/hallazgos`** con "Escanear ahora" (`POST /replenishment/scan-now`). UPSERT idempotente por `dedup_key`, se auto-resuelve al despejarse. WS realtime diferido; el cron se apaga con `ENABLE_REPLENISHMENT_SCAN=false`.
- **Pendiente:** RA.13b (fill rate histórico — bajo valor: fill rate ~100% artificial) + RA.14 auto-received desde Kepler. Prod: migs Railway + re-login + redeploy api+view + agendar `import-in-transit` + `scan-now`/cron.

### Added — Compras: DRP multi-echelon (CEDIS planeado sobre demanda de la red) (Fase RA-PRO.6) (2026-07-09)
- **Problema:** el CEDIS no vende directo → planeado por su propia venta quedaba **sin política de reorden** y las sucursales no podían surtirse de él. DRP lo planea por lo que consume la red.
- **Topología de red** (mig `20260709190000`): `commercial.warehouses.source_warehouse_id` — NULL = CEDIS (compra a proveedores), set = sucursal (traspaso desde ese CEDIS). Define el árbol de 2 niveles + guard anti-self.
- **Motor DRP** `import-network-reorder.js`: para cada CEDIS, `media_red = Σ avg(sucursal) + avg(propio)` y **`σ_red = √(Σ σ(sucursal)² + σ(propio)²)`** (risk pooling — las varianzas suman, el CV agregado baja), luego `safety = ceil(Z(0.98)×σ_red×√lead)`. Escribe la política del CEDIS (no pisa kepler/manual). Wireado en el nightly tras `import-computed-reorder`.
- **Frontend `/compras/red`** (nav "Red de abasto"): configura de qué CEDIS se surte cada sucursal + KPIs (CEDIS / sucursales surtidas / sin origen). Backend `GET /network` + `POST /warehouses/:id/source`.
- **Verificación:** smoke `test-newdb-ra-network.js` 7/7 (media Σ=7, σ=√25=5, guard self-source) en la suite. Builds api+view OK. Migración aplicada a Railway.
- **Diferido (RA-PRO.6.2):** vista de distribución por producto (matriz CEDIS+sucursales con traspasos sugeridos) + asignación cuando el CEDIS no alcanza para toda la red.

### Added — Compras: parámetros de compra por proveedor (lead time + mínimo) (Fase RA-PRO.3) (2026-07-09)
- **Hallazgo: Kepler NO codifica lead time real.** Medido en vivo (suc 03, 365d, cadena OC `X-A-35` → orden de entrada `X-A-40`): 73% mismo día, mediana 0, promedio negativo (−7.6d, entradas fechadas antes que su OC) → las fechas son artefacto de captura. Se descarta derivar lead time de Kepler; se **captura manual**.
- **Nueva página `/compras/proveedores`** (permiso `COMPRAS_VER`): tabla editable de **lead time (días)** + **pedido mínimo (cajas)** por proveedor, con # de productos. Ambos alimentan el motor: punto de reorden `avg×lead` y safety stock `Z×σ×√lead`.
- **Backend:** `commercial-replenishment` — `GET /suppliers` (parámetros + product_count) + `POST /suppliers/:id/lead-time`. Sin migración (columnas `catalog.suppliers.lead_time_days`/`min_order_boxes` ya existían). Builds api+view OK.
- **Diferido:** variabilidad del lead time (σ_LT) para el safety stock — Kepler no da la señal.

### Added — Compras profesional: safety stock por nivel de servicio + segmentación ABC-XYZ (Fase RA-PRO.1/2) (2026-07-09)
- **Benchmark contra la industria** (SAP IBP, Blue Yonder, RELEX, Netstock, GAINSystems): documento `docs/IMPLEMENTACION/FASES/FASE_RA_BENCHMARK_ENTERPRISE.md` con los 4 pilares del reabastecimiento profesional, gap analysis honesto y roadmap RA-PRO.1–8.
- **Safety stock por nivel de servicio (RA-PRO.1):** reemplaza el heurístico de "días de cobertura fijos" por la fórmula estándar `safety = ceil(Z(servicio) × σ_demanda × √lead)` y `reorder = ceil(avg×lead) + safety`. σ (desviación poblacional 90d, incluye días cero) se computa en `import-inventory-health.js`; Z se deriva del nivel de servicio (inversa normal Acklam) por clase ABC (A=0.98/B=0.95/C=0.90; override `RA_SERVICE_A/B/C`) con piso de días para A/B cuando σ=0. Persistido en `commercial.reorder_policy` (`service_level`/`policy_method='service_level'`).
- **Segmentación ABC-XYZ (RA-PRO.2):** nuevo eje **XYZ** por coeficiente de variación `CV=σ/μ` (X≤0.5 estable · Y≤1.0 variable · Z>1.0 errático) en `analytics.inventory_health.xyz_class` + snapshot en `reorder_policy`. El ABC ya lo calcula la Fase ABC.
- **Migración `20260709180000_ra_pro_service_level_abcxyz`** (aditiva, idempotente): `analytics.inventory_health` += `stddev_daily_units/demand_cv/xyz_class`; `commercial.reorder_policy` += `service_level/abc_class/xyz_class/demand_cv/policy_method` + CHECKs.
- **Backend:** `commercial-replenishment` critical-stock expone `safety_stock/service_level/xyz_class/demand_cv/policy_method/lead_time_days/avg_daily_units` + filtro `xyz`.
- **Frontend `/compras` (Existencia Crítica):** columna **"Clase"** (ABC·XYZ, Z resaltado como riesgo de pronóstico), columna **"Colchón"** (safety stock + % nivel de servicio, tooltip con la fórmula), filtros ABC y XYZ.
- **Verificación:** smoke `test-newdb-ra-service-level.js` 18/18 (σ/CV población 90d, clase XYZ, `Z×σ×√LT`, piso, CHECK) en la regression suite. Builds api+view OK.
- **Pendiente:** números reales se pueblan por el nightly del runner (`sales-fact → inventory-health → computed-reorder`, ya wireado). Prod: mig a Railway + redeploy. Siguiente: RA-PRO.3 lead time real, RA-PRO.4 Croston, RA-PRO.5 vendor scorecard.

### Added — Repartidor: flujo GUIADO de entrega + reglas de negocio (Fase LM.11) (2026-07-08)
- **"Llevar pedidos" — una secuencia guiada de principio a fin.** Nuevo componente `rider-route-run`: ve sus pendientes → botón **"Llevar pedidos (N)"** → mapa con las paradas en el orden óptimo → **"Iniciar ruta"** → por parada: navega (Waze/Google Maps) y, al **acercarse al domicilio** (geocerca ~40 m, o botón "Ya llegué"), se habilita **"Entregar pedido"** → monto + cobro + **firma del cliente** → **auto-avanza a la siguiente** → al terminar, **arqueo ciego**.
- **Geocerca de llegada** (`GeofenceService`): `watchPosition` + distancia haversine en vivo + precisión GPS. Radio configurable (default 40 m — 10 m no es fiable en GPS de celular) con override manual "Ya llegué".
- **Arqueo CIEGO de fin de día:** el repartidor cuenta su efectivo por denominación **sin ver lo esperado**; el sistema calcula y **revela la diferencia al cerrar**. `POST /commercial/rider-liquidations/my/blind-close` (auto-scoped por JWT) + `:id/reconcile` (el encargado valida después). Migración `20260708150000` (`is_blind` + `reconciled_by/at`).

### Changed — Reparto: el repartidor NO decide precio ni evidencia (reglas de negocio) (2026-07-08)
- **Precio fijo del ticket.** El repartidor ya no teclea el monto: se cobra exactamente `amount_to_collect` de la parada (backend ignora cualquier monto enviado). La app muestra "Cobrar $X" bloqueado y solo captura el efectivo recibido para el cambio.
- **Firma obligatoria.** La entrega exige la firma del cliente (`signature_url`); el backend la rechaza sin ella. La app reemplaza el checkbox auto-declarado por un **canvas de firma real**.
- **Notificaciones in-app** al asignar (repartidor) y al entregar (tienda) vía WebSocket `/alerts` (`delivery_assigned`/`delivery_delivered`), con *seam* listo para WhatsApp (cliente/repartidor/tienda) cuando se elija BSP (Fase F).
- **Tracking de tienda:** `GET /commercial/home-delivery/dispatched` + vista `/reparto/seguimiento` (estado, repartidor, hora de despacho/entrega).
- **Desacople Reparto ↔ Logística:** la entrega vive en `commercial.home_deliveries` (tabla propia) asignada a un **usuario repartidor** (`rider_user_id`), no a un chofer de flota (mig `20260703140000`). El dropdown de asignación lista usuarios con rol `repartidor` (`GET /commercial/home-delivery/riders`).
- **Todo a domicilio es CONTRA-ENTREGA** (2026-07-09): el despacho fuerza `collect_on_delivery=true` + `amount = total del ticket`; nada llega "ya pagado" (aunque el ticket Kepler diga CONTADO — eso es la venta en tienda). La UI de tienda muestra "Contra-entrega — cobra $X en efectivo al entregar, monto fijo".
- **Mapa del repartidor INTERACTIVO** (2026-07-09): la ruta guiada usa un mapa Leaflet (`rider-map`) con **posición en vivo** + ruta + paradas, en lugar de la imagen estática. La navegación por voz sigue en **Waze/Google Maps** (deep-link) — es la mejor opción para el manejo; el turn-by-turn embebido (Mapbox Nav SDK) se descarta por costo/nativo y menor valor en última milla.
- **Pendiente prod:** migs `20260703140000`, `20260708130000`, `20260708150000` a Railway + re-login + smoke blind-close + validación GPS en device.

### Added — Reparto: mapa + ubicación en mapa + ruta óptima del repartidor (Fase LM.10) (2026-07-08)
- **Ver a dónde va el pedido y dónde está el repartidor.** `/reparto/seguimiento` ahora tiene mapa (átomo `app-map`) con dos capas conmutables: **destinos** (pin por entrega del día, color por estado) y **repartidores en vivo** (capa persistente; seed HTTP `GET /commercial/home-delivery/rider-positions` + upsert por WS `route_ping`, refresco ~15 s).
- **Elegir el domicilio en el mapa.** `/reparto/asignar` incorpora un picker: botón "Ubicar dirección" (geocoding directo Mapbox, sesgo MX/La Piedad) + click/arrastre del pin para ajustar (con geocoding inverso que rellena la calle). Fija `delivery_address.lat/lng` en el despacho. `app-map` extendido con `pickable` + `mapClick` + pin arrastrable (no-breaking).
- **Ruta óptima del repartidor.** Nueva pestaña **Ruta** en la app del repartidor: paradas pendientes del día en el mejor orden de visita (solver open-route NN + 2-opt, haversine) sobre imagen estática Mapbox con pines numerados + **navegación real por parada** (deep-links Waze / Google Maps). Origen resuelto: GPS fresco del repartidor → coord de sucursal → centroide. El repartidor ahora **emite GPS en vivo** (`RoutePingService` enganchado en `rider-shell`), lo que alimenta el mapa de tienda.
- **Backend:** geocoding en `MapboxService` (`geocodeForward`/`reverseGeocode`) + endpoints `GET /reports/geocode` y `/reverse-geocode`. `GET /commercial/home-delivery/my-route` (repartidor) persiste `sequence_order`; `GET .../rider-positions` (tienda). Migración `20260708130000`: `home_deliveries.sequence_order/route_eta_min/route_computed_at` + `home_delivery_warehouses.lat/lng`. Builds view/vendor/api OK; smoke DB (schema + queries) OK.
- **Pendiente prod:** mig `20260708130000` a Railway + coords de sucursal opcionales para mejor origen. Interactivo Leaflet en la app repartidor: diferido (MVP = imagen + deep-links).

### Added — Supervisor de Movimientos: cruce independiente (SM.8 / P6) — plan de prevención CERRADO (2026-07-08)
- **El techo del sistema.** `analytics.pos_ticket_sales` (mig `20260708240000`) + importer `import-pos-ticket-sales` agrega tickets POS crudos (`kdm1` U/D/10) por sucursal×cajero×día (capa atómica). Regla **`venta_vs_tickets`** (plano `cruce`): compara vs el total del corte (capa agregada) → detecta tickets cancelados/editados tras el cierre o corte inventado, algo que la cuadre propia de Kepler no ve. 672/683 reconcilian a ±$100; 76 corte×día divergen ≥$500 (51 sin tickets — ej. 09-ene suc03 corte $50k+ sin un solo ticket).
- **SM.8 (P1–P6) completo:** el motor corre **10 reglas** en 3 planos; consola de 7 tabs; ciclo detectar→priorizar→intervenir→medir cerrado.

### Added — Proyecto Compras / Reabastecimiento (Fase RA, ADR-030) (2026-07-08)
- **Trae a la plataforma el reabastecimiento que Kepler ya opera.** Decode verificado: `kdii.c33`=mínimo, `c34`=punto de reorden, `c35`=máximo (piezas, NO precios — la doc estaba mal, corregida). Motor decide / humano aprueba / LLM fuera (ADR-016).
- **Nuevo proyecto de primer nivel "Compras"** (`/compras`): tile en projects + nav propio + permisos `COMPRAS_VER`/`COMPRAS_GESTIONAR`. Página **Existencia crítica** (existencia vs mín/reorden/máx + sugerido, filtros por almacén/bucket/proveedor/objetivo) y **Requisiciones** (bandeja + detalle con aprobar/rechazar, HITL).
- **Schema** (mig `20260708120000`): `commercial.reorder_policy` (grano producto×almacén, `source` kepler/computed/manual), `purchase_requisitions`/`_lines`, `requisition_sequences` (folio `RQ-YYYY-NNNNN` atómico), `catalog.suppliers.lead_time_days`. RLS forzado. Backfill de permisos (mig `20260708120100`).
- **Importers** (BULK, on-prem → Railway, reusan `STOCK_BRANCH_MAP`): `import-reorder-policy.js` (Kepler → reorder_policy, preserva `manual`) — 3924 políticas en local; `import-computed-reorder.js` (reorden por demanda desde `inventory_health` para el ~82% sin config Kepler; CEDIS=0 → 100% computado). Wired en `run-prod-feeds nightly`.
- **Backend** `commercial-replenishment`: `GET critical-stock` (buckets agotado/bajo_minimo/bajo_reorden/sano/sobrestock + `sugerido = max(0, objetivo − existencia − en_tránsito)`), `summary`, `filters`, `requisitions` CRUD + approve/reject. Validado vs data real: 449 agotado / 447 bajo mín / 83 bajo reorden, sugerido $1.1M.
- Diferido: RA.5 (OC a recibir/tránsito), RA.8 (cron nightly + hallazgos + alertas). **Pendiente prod:** migs a Railway + re-login + agendar importers + redeploy.

### Added — Supervisor de Movimientos: cerrar el loop (SM.8 / P5) (2026-07-08)
- **Detectar → priorizar → intervenir → medir.** `reconciliation.actions` (mig `20260708220000`, RLS) + `ReconciliationActionsService`: propone una palanca anclada a un foco + fecha + responsable (HITL, ADR-013), snapshotea baseline. Endpoints `POST/GET /actions` + `PATCH /actions/:id/status`.
- **Efectividad diff-in-diff** (Horus-L L3): faltante 30d antes vs después en el alcance, menos el cambio de la red (control). Consola: botón **Crear acción** en Focos + tab **Acciones** con antes/después/DiD. Smoke: DiD calculado correcto.

### Added — Supervisor de Movimientos: focos (SM.8 / P4) (2026-07-08)
- **Priorización dirigida.** `GET /reconciliation/focos?scope=caja|cajero`: ranking por faltante + señales (%exacto, %handoff, turnos≥10h) con la **palanca recomendada** derivada de la señal dominante. Consola: tab **Focos** con toggle caja/cajero. Data real: suc05-caja4 $70,781 → Arqueo ciego; suc02-caja2 $43,041 → Arqueo de relevo. El supervisor ataca de arriba hacia abajo sabiendo QUÉ hacer.

### Added — Supervisor de Movimientos: límite de jornada (SM.8 / P3) (2026-07-08)
- **Regla `turno_largo`**: cajero×sucursal×mes con ≥5 jornadas ≥10h (el turno largo dobla el descuadre: 12% vs 6%) → señal RH. KPI "Turnos ≥10h" en Resumen. Data real: 16 cajero×mes; destapa la correlación fatiga↔pérdida en persona (TANIA SÁNCHEZ suc05: 20 turnos ≥10h en junio, $17,432 faltante).

### Added — Supervisor de Movimientos: arqueo de relevo (SM.8 / P2) (2026-07-08)
- **Ataca los $320k que viven en cambios de turno.** `blind_counts` extendida (mig `20260708200000`): `tipo` cierre/relevo + `cajero_entrante`. El relevo sella cuánto entregó el cajero saliente al entrante en el handoff → responsabilidad por persona.
- **Regla `handoff_sin_relevo`**: caja×mes con ≥3 cambios de cajero + faltante ≥$2k sin arqueo de relevo → **34 caja×mes** en data real (suc05-caja4 abr: 23 handoffs, $32k). Consola: toggle Cierre/Relevo + cajero entrante en el tab Arqueo ciego.

### Added — Supervisor de Movimientos: arqueo ciego (SM.8 / P1) (2026-07-08)
- **La palanca #1 contra el descuadre enmascarado.** `reconciliation.blind_counts` (mig `20260708180000`, RLS) + `BlindCountService`: el cajero/supervisor captura el conteo físico por denominación (MXN) **sin ver el esperado**; al guardar el sistema revela la diferencia **real** vs el esperado de Kepler. Endpoints `POST/GET /reconciliation/blind-counts`.
- **Regla `arqueo_ciego_divergente`**: `|esperado − contado_ciego| ≥ umbral`, **crítico** cuando Kepler dio el corte por cuadrado (`|c35|<50`) = enmascaramiento confirmado. Consola: tab **Arqueo ciego** (pad de denominaciones ciego + revelación + historial).
- Smoke E2E: corte real de Kepler $121,961 (diff 0) + arqueo ciego −$800 → destapa faltante real $800 con `ENMASCARÓ=true`. Habilita el piloto P0 (medir tasa real vs 7.5% base).

### Added — Supervisor de Movimientos: cuándo/circunstancia + plan de prevención (SM.7b/SM.8) (2026-07-08)
- **Deducción sobre 2178 cortes:** el descuadre no es aleatorio — máximo riesgo en **lunes/sábado, turno >10h (12% vs 6%), cierre en cambio de turno (15/18h), caja que cambió de manos** (82% de cortes, $320k de $379k del faltante). Cajas calientes suc02-caja1/2, suc05-caja4/5. Tendencia al alza en 2026.
- **Ingesta horaria:** `hora_apertura`/`hora_cierre`/`duracion_horas`/`handoff` en `cash_cuts` (mig `20260708160000` + importer lee c6/c11). Regla `corte_riesgo_circunstancia` (cambio de cajero + turno ≥10h + cuadre exacto + ≥$5k → **154 cortes** de $50-65k a auditar). Detalle del corte muestra horario + circunstancia.
- **Plan de prevención (SM.8)** en el doc de fase: P0 confirmar (piloto arqueo ciego) → P1 forzar arqueo ciego en nuestra capa (palanca #1) → P2 arqueo de relevo → P3 límite de jornada → P4 foco puntos calientes → P5 loop HITL + diff-in-diff → P6 cruce independiente vs tickets POS.

### Added — Supervisor de Movimientos: nombres de cajero (SM.7) (2026-07-08)
- Catálogo `analytics.pos_cashiers` + importer `import-pos-cashiers` (une Kepler `kdpv_gerentes` códigos prefijados + `kdpv_kdku` cortos, escopeado por sucursal): **742 cajeros, 100% de cortes resueltos**. Los códigos (`54TYSL`, `40VMC`) ahora muestran nombre en cortes, resumen y en los 4 detectores de caja → los hallazgos nombran al culpable (ej. TANIA YAZMIN SÁNCHEZ LEAL, $57k faltante en 9 cortes). Codes basura caen a fallback.

### Added — Supervisor de Movimientos: desglose completo del corte (SM.7) (2026-07-08)
- **Por qué cuadra o no un corte**, descifrado en vivo de `md.kdpv_folio_caja` (2178 cortes red completa). Un corte = **esperado (sistema) vs contado (arqueo)** por forma de pago (efectivo/tarjeta/transferencia) + desglose del arqueo (billetes/monedas/otros) + efectivo retirado.
- **Regla `arqueo_no_ciego`** (nueva): 1456 de 1993 cortes de monto alto (**73%**) cierran con contado idéntico al esperado al centavo — imposible en conteo físico real. El descuadre bajo NO garantiza caja sana; el arqueo no es ciego. Detecta cajero×mes ≥90% exacto (**49 hallazgos** en data real).
- **Regla `descuadre_no_efectivo`** (nueva): descuadres de tarjeta/transferencia (c36/c37), antes 100% invisibles — **73 cortes** afectados.
- **Consola** `/almacen/cuadre`: Resumen con KPI arqueo-no-ciego + nota; Cortes master-detail (3 formas de pago esperado/contado/diff + desglose arqueo) con filtros de fecha; Movimientos con **nombre de producto** (join `public.products`) + filtros de fecha; nombre de sucursal.

### Fixed — Corte: `total_venta` subestimaba la venta (2026-07-08)
- `total_venta` mapeaba `c49` (≈ solo efectivo). La venta real del turno = efectivo+tarjeta+transferencia esperados. Nueva columna `venta_total`: **$61.3M** real vs $54.2M viejo (−$7.1M). Migración `20260708120000_cash_cuts_desglose` (+7 columnas idempotentes + backfill). Importer `import-cash-cuts` lee c36/c37/c43/c44/c45/c48 y SSL condicional por host.

### Fixed — Maat chat: "No pude generar una respuesta" en respuestas largas (2026-07-07)
- **Causa** (reproducida contra la API): `MAX_TOKENS=1500` cortaba las respuestas detalladas (análisis por sucursal, tablas) → el tool-call `render_response` quedaba truncado (`stop_reason=max_tokens`) y `narrative` volvía vacío. Solo pasaba en respuestas largas → intermitente.
- **Fix en 3 niveles**: (1) `MAX_TOKENS` 1500→4096 cubre respuestas ricas; (2) `retryConcise` reintenta una vez con nudge de concisión + 8192 tokens si aún trunca (recuperó 6959 chars en la prueba); (3) mensaje accionable ("acota la pregunta…") en vez del genérico. `THINK_MAX_TOKENS` 4096→8192. Commit `9382918`.

### Added — Maat: grafo de colusión de proveedores en Neo4j (MAAT.10) (2026-07-07)
- `maat_red_proveedores` ahora prefiere un **grafo Neo4j** para el recorrido multi-hop de la red de proveedores (anillos de colusión), con **fallback automático al CTE recursivo en Postgres** si Neo4j no está configurado. Cero cambio de comportamiento en prod hasta provisionar la instancia.
- **`Neo4jModule`** en platform-core (token `NEO4J_DRIVER`, `@Global`, degrada a `null` sin `NEO4J_URI`) + **`MaatProviderGraphService`** en libs/finance: modelo bipartito `(:Beneficiario)-[:USA_RFC]->(:Rfc)` (fan-in/fan-out/anillos), `sync`/`network`/`rings`. Aristas forenses futuras (cuenta bancaria / rep legal / domicilio) ya modeladas, pendientes de ingesta (el 201 de Kepler es plano).
- **Decisión** (Edgar): poner las tuberías ahora aunque la data forense no exista aún — cuando llegue, es solo agregar aristas al mismo grafo. `neo4j-driver@6` agregado.
- **Backfill**: `POST /finance/maat/findings/graph-sync` + script on-prem `database/scripts/sync-maat-provider-graph.js`. **Verificado** el Cypher en vivo (Neo4j 5.26): anillo sintético → multi-hop a 2 saltos + fan-in/fan-out correctos. **Pendiente prod**: provisionar Neo4j + `NEO4J_*` en Railway + sync.

### Added — Maat RAG: retrieval semántico de conocimiento (MAAT.9) (2026-07-07)
- El tool `maat_conocimiento` ahora busca por **similitud coseno** (Voyage voyage-3 + pgvector) en vez de ILIKE → entiende parafraseo/sinónimos ("centro de costos por departamento" encuentra la entrada aunque no compartan palabras).
- **No agrega tecnología nueva**: reusa `EmbeddingsService` + la DB vector dedicada de Fase K (`VECTOR_DATABASE_URL`), ambos en `platform-core`. Nuevo `MaatKnowledgeVectorService` (tabla `maat_knowledge_embeddings`, HNSW coseno, PK `(tenant_id,kind,title)`). **Degrada solo**: sin vector DB / VOYAGE_API_KEY / ante error → fallback a ILIKE (el chat nunca se rompe).
- **Sync automático**: guardar/retirar conocimiento (chat REST) embebe/quita la entrada al vuelo. Backfill vía `POST /finance/maat/knowledge/reindex` o script on-prem `database/scripts/embed-maat-knowledge.js`.
- **Verificado contra la DB RAG de prod**: 28/28 entradas embebidas; queries parafraseadas devuelven la entrada correcta (señal 0.44–0.59 vs ruido 0.33–0.40, umbral 0.42). Corpus-RAG de documentos contables (PDFs) diferido — no hay corpus cargado.

### Added — Geocercas indexadas para tracking GPS de campo (Track GPS.B) (2026-07-03)
- **Contexto:** análisis de la arquitectura de tracking GPS del vendedor (foreground service nativo + Dexie batching + REST-batch + WS live-map) confirmó que está ~90% construida. **Única brecha técnica real: sin índice espacial** — las geocercas ("¿entró a la tienda?", clientes cercanos) se calculaban con haversine en JS/SQL sin índice.
- **Decisión:** PostGIS **NO disponible** en la instancia (`postgres_platform`, PG 18.4 — ni instalada ni en `pg_available_extensions`). `cube` + `earthdistance` **sí** → alternativa liviana elegida (misma capacidad de radio indexado con GiST, sin instalar paquetes de OS). Documentado como plan B en el análisis previo.
- **Migración `20260703140000_gps_earthdistance_geofence`** (idempotente + **defensiva**: si las extensiones no están o el rol no es superuser, NO crea nada y NO tira error → no crashea boot en Railway; los índices solo se crean si la extensión quedó instalada). `CREATE EXTENSION ... SCHEMA public` explícito (sin esto se instalaban en `identity`, primer schema del search_path). Índices GiST funcionales: `idx_route_pings_earth` sobre `route_location_pings(ll_to_earth(lat,lng))` + `idx_customers_earth` sobre `commercial.customers(ll_to_earth(latitude,longitude))` parcial.
- **Verificado (DB local):** extensiones instaladas, ambos índices creados, `earth_distance` da 1574m (correcto vs ~1500m), y `EXPLAIN` de una geocerca por radio confirma **Index Scan using idx_route_pings_earth** (usa el índice, no seq scan).
- **Pendiente:** aplicar la migración a Railway al cutover (confirmar que el rol tenga superuser o que `cube`/`earthdistance` estén pre-creados — si no, la migración skipea graciosamente). Tracks GPS.A (deploy+prueba en device: patch nativo ✅ ya aplicado en node_modules, falta APK+prueba pantalla apagada), GPS.C (verificar live-map E2E con app arriba) y GPS.D (provisionar `REDIS_URL` en Railway — el `ReportsIoAdapter` ya está codeado) quedan como trabajo operacional/de device.

### Added — Proyecto "Tienda": monitor de tickets de venta EN VIVO (Fase TDA) (2026-07-02)
- Nuevo proyecto `/tienda` (card en /projects) que muestra los **tickets POS de cada sucursal en tiempo real**. Builds api+view verdes; sin deploy.
- **Habilitador:** Kepler guarda la hora del ticket **al minuto** en `kdm1.c62` (100% poblado) + `c9` fecha. Datos en vivo (verificado: tickets a la hora actual).
- **Arquitectura (WS ≠ sin polling):** el WebSocket empuja al navegador (sin polling del navegador), pero Kepler no notifica altas (poner trigger/LISTEN al ERP = invasivo, descartado) → **único punto de polling** = `poller on-prem cada ~25s → POST /store/live/ingest → Socket.IO namespace /store → navegador`. Reusa patrón AlertsGateway (JWT handshake, rooms por tenant, path /reports/socket.io).
- **Backend** `apps/api/src/modules/store/`: gateway `/store`, `StoreService` (ingest idempotente + emite; snapshot KPIs día/curva horaria TZ MX/últimos tickets; alerta ticket grande), controller (`POST /store/live/ingest` @Public + guard `x-store-ingest-key`; `GET /store/live/snapshot` gate `STORE_LIVE_VER`), migración `20260702180000_analytics_store_live_tickets`, permiso `STORE_LIVE_VER`.
- **Poller** `database/importers/kepler/live-tickets-poller.js` (proceso continuo, ventana deslizante 5min/25s, lee kdm1⋈kdm2 c4=10 con canasta, push a prod).
- **Frontend** proyecto `/tienda`: `TiendaLiveComponent` (ticker con flash + expandir canasta del ticket, KPIs del día en vivo, barras de horas pico 6-22h, feed de alertas, indicador EN VIVO) + `StoreSocketService` (Socket.IO /store) + card + ruta + nav.
- **Pendiente prod:** migración + env `STORE_INGEST_KEY`/`STORE_INGEST_URL` + correr el poller on-prem + deploy. `STORE_LIVE_VER` lo tienen admin/superadmin (manage:all); otros roles requieren backfill + re-login.

### Added — Apartado de Traspasos (movimientos que NO son venta) (Fase T) (2026-07-02)
- **Contexto:** los "traspasos"/consolidación interna de Kepler ya estaban FUERA de los reportes de venta (efecto del fix ×2 `c4=10`), pero eran **invisibles** y la exclusión era implícita. Se les hace apartado propio + se blinda la exclusión. Builds api+view verdes; sin deploy.
- **Análisis (datos):** el bloque `c4=6` (serie `UD06`, ~$46M/año, 1 doc/día CONTADO, ≈90% de la venta en cada sucursal) = **consolidación interna** (confirmado por el usuario), NO venta — era el causante del ×2. Los N-traspasos (`N/D/6`, `N/D/25`) = 0 en la práctica; sí hay `U/A/50` "Recepción Traspaso" (~$11M/año). Verificado: `sales_daily` en prod solo trae canales `tienda`+`credito` (sin traspaso).
- **T.2/T.3:** migración `analytics.transfers_monthly` (kind: consolidacion/recepcion/traspaso_salida/traspaso_entrada) · feed `import-transfers-monthly.js` (6 sucursales vivas, UPSERT-acumulativo GREATEST) · `transfersReport()` + endpoints `/commercial/analytics/transfers` (+`.xlsx`).
- **T.4:** página `/logistica/traspasos` (matriz sucursal×tipo mes a mes, KPIs, desglose por tipo, XLSX) + item de nav en Logística + link "Traspasos (no venta)" en el tab Reportes de Comercial.
- **T.1 (blindaje):** test `database/tests/verify-no-transfer-leak.js` — invariante "ningún canal de traspaso en `sales_daily`" (la única defensa real es `c4=10` en el origen; `UD06` es CONTADO → se disfrazaría de canal `tienda`, un filtro por canal NO lo atrapa). PASS en prod.
- **T.6 — CEDIS incluido (a partir de "¿y cedis?"):** CEDIS (md_00) NO era $0 — es el hub. Su distribución vive en **`U/D/13` = $320M/año** (SALIDA por traspaso), con destino en `kdm1.c10` decodificado vía catálogo `kdud` (P.V./TLMKT/RUTA — incluye Morelia y Canindo, NO consolidadas). Se agregó `kind='salida_cedis'` + columna `dest_label` (destino real) al feed/tabla/reporte/UI. **Fix de valor:** el importe de `U/D/13` está en el **header `kdm1.c16`**, no en las líneas `kdm2` (c13≈0) → el feed ahora suma valor+docs del header y unidades de kdm2. Poblado en prod: 267 filas, salida_cedis $320M + consolidación $47M + recepción $12M. Builds verdes, regresión PASS.
- **Pendiente prod:** aplicar migración `20260702170000` + agendar `import-transfers-monthly.js` (nightly) + re-login no requerido (reusa `COMMERCIAL_ORDERS_VER`). Nota: los valores de `consolidacion`/`recepcion` traen un ~2-3% residual de la 1ª corrida (base línea) por el UPSERT-GREATEST; un reset de la tabla los deja 100% base-header (requiere autorización de DROP en prod).

### Added — Feed de logística/embarques de Kepler (Fase KV.8) (2026-07-01)
- Explota la logística REAL del ERP Kepler (`md.kdpord` embarques + dims `kdm_rutas`/`kdm_chofer`/`kdm_transporte`), mismo patrón que ventas: on-prem lee, bulk a prod, **separado** del módulo Fase J (`analytics.erp_shipments`, no pisa `logistics.*` de la app). Build api verde.
- **Hallazgo:** Kepler sí tiene logística; la plataforma ya tenía el módulo Fase J completo (22 tablas) pero **capturado a mano**; las dims se habían importado una vez con un script one-off; los **embarques (`kdpord`) no se traían** — ese era el gap.
- Migración `analytics.erp_shipments` (fact grano-línea) · `import-erp-shipments.js` (multi-sucursal, full refresh, dry-run vuelca muestra cruda para calibrar columnas + `KDPORD_DATE_COL`) · `import-logistics-dims.js` (idempotente) · modo `logistics` + nightly en `run-prod-feeds.js` · crons @05:15/05:20 · `erpShipments()` + endpoint `/commercial/analytics/erp-shipments` + tool `thot_shipments` (Thot ya responde "embarques por ruta/estado/día").
- **Pendiente prod:** aplicar migración + calibrar `KDPORD_DATE_COL` con dry-run on-prem + correr feed.

### Added — Thot "aprende del uso": few-shot + feedback loop 👍/👎 (Fase TC.4a/5a / ADR-026) (2026-07-01)
- **No es fine-tuning ni hornear cifras** (eso quedaría stale + alucinaría): Thot aprende del USO con una **biblioteca de ejemplos verificados** (pregunta → tools → respuesta) inyectados como **few-shot** según similitud. Patrón verified-queries (Snowflake) / few-shot RAG (Uber). Determinista y auditable (ADR-021).
- **TC.4a**: migración `commercial.thot_chat_examples` (RLS, por perfil) + 14 ejemplos **semilla** en código (valor desde el deploy, incl. la lección "ventas en ruta") + injection por solape de tokens. Endpoints `/thot/examples` (GET/POST/PATCH + `from-log`).
- **TC.5a feedback loop**: migración `thot_chat_log` +`feedback`/+`promoted`; el chat devuelve `log_id`; `POST /thot/feedback` (👍/👎); cola `GET /thot/examples/candidates` (👍 sin promover) → promover a ejemplo. **Botones 👍/👎** en chat de portal y vendedor + **pantalla de curaduría** `/comercial/thot-curation` (revisar cola, promover 1-clic, alta manual, enable/disable).
- **Mejoras de comportamiento** (vistas en prod con "% de ventas en ruta"): regla **"investigá antes de preguntar"** (probá la dimensión obvia en vez de pedir aclaración) + `flexible_aggregate` devuelve **`share_pct` determinista** (el LLM ya no calcula % de cabeza ni se equivoca).
- **Pendiente prod:** aplicar migraciones `thot_chat_examples` + `thot_chat_log_feedback`. Diferido TC.4b (embeddings; pgvector es Docker local, falta resolver en Railway).

### Added / Security — Thot Chat en Portal y Vendor con perfiles scoped (Fase TC-S/P/V / ADR-026) (2026-06-30)
- Lleva el asistente conversacional a las apps de **cliente** y **vendedor**. Builds api+portal+vendor verdes. Sin deploy.
- **Security (TC-S):** se detectó y cerró un leak — `customer_b2b` y `vendedor` tienen `COMMERCIAL_ORDERS_VER`, así que con el gate original podían pegarle al chat **admin** y ver TODO el tenant (márgenes, todos los clientes). Fix: el endpoint admin `/thot/chat` rechaza esos roles; cada audiencia tiene su endpoint scoped.
- **Refactor a perfiles:** `ThotChatService` agnóstico (recibe `ToolProvider` + `ThotScope`); el scope se deriva del JWT y se **impone server-side** (el LLM nunca elige cliente/almacén fuera de alcance).
- **TC-P Portal** (`customer_b2b`): `PortalThotToolsService` scoped a `customer_id`, **sin márgenes ni datos de terceros** (mis pedidos / recomendaciones / lo habitual / catálogo+mi precio / disponibilidad / promos) + `/portal/thot/chat` + UI Storefront `/portal/assistant`.
- **TC-V Vendor:** `VendorThotToolsService` scoped a la **cartera** (rutas asignadas), márgenes OK (interno): buscar cliente / 360 / historial / sugeridos / mi día / inactivos / stock + `/vendor/thot/chat` + UI mobile con **voz Web Speech es-MX** `/vendor/assistant`.
- **Surtido PH:** disponibilidad/stock de portal y vendor sale del almacén **MD-10** (`THOT_FULFILLMENT_WAREHOUSE`), alineado con el feed `import-ph-stock-live.js`.
- **TC-E:** `http-thot-chat-scoped-test.js` (red-team de fuga: admin rechaza al cliente, superficie de tools acotada por perfil, no entrega márgenes).
- **Pendiente:** reiniciar API (build nuevo) + correr el red-team. `apps/view` quedó rojo por WIP ajeno (`ThotAiInputComponent`), no de esta fase.

### Added — Thot Chat: analítica conversacional sobre ventas (Fase TC / ADR-026) (2026-06-30)
- **Qué:** "Pregúntale a Thot" — un chat que responde preguntas complejas de ventas/inventario/clientes/márgenes en lenguaje natural, orquestando vía **tool-use de Claude** los métodos deterministas que ya existen. Builds api+view verdes. Sin deploy.
- **Decisión (ADR-026):** capa conversacional sobre el motor, **NO RAG sobre la DB**. Validado contra cómo lo hacen Uber/LinkedIn/Snowflake/Databricks/Anthropic: capa semántica curada + tools deterministas + RAG solo para entidades + evals. El LLM **nunca calcula ni genera SQL**; los números salen de tools tenant-scoped (RLS). Read-only.
- **TC.0 — Tool registry + capa semántica** (`libs/commercial/.../thot-chat/`): `thot-semantic.ts` (glosario de negocio ES + reglas duras) y `thot-tools.service.ts` (~20 tools `thot_*` envolviendo `CommercialAnalyticsService` + `ThotService`, con distinción venta real ERP vs pipeline B2B) + `resolve_entity` (RAG ligero ILIKE) + `flexible_aggregate` (escape hatch con whitelist, sin SQL libre) + `list_warehouses`.
- **TC.1 — `ThotChatService`:** bucle tool-use (máx 6 iteraciones, timeout 30s) con self-correction (errores de tool vuelven como texto accionable). Modelo Haiku 4.5 por defecto, env `THOT_CHAT_MODEL` para Sonnet. Degrada limpio sin `ANTHROPIC_API_KEY`.
- **TC.2 — Endpoint** `POST /commercial/intelligence/thot/chat` (gated `COMMERCIAL_ORDERS_VER`, sin permiso nuevo → sin re-login) + persistencia auditable `commercial.thot_chat_log` (migración `20260630200000`, RLS forzado, append-only).
- **TC.3 — Frontend** `/comercial/thot-chat` (Operations): hilo de chat, prompts sugeridos, **render estructurado** de las tablas que devolvieron las tools (transparencia) + tab "Pregúntale a Thot" en la barra de analytics.
- **Evals:** `database/tests/http-thot-chat-test.js` (golden-questions: verifica el ruteo a la tool correcta, estilo LinkedIn SQL Bot).
- **Pendiente prod:** aplicar migración + `ANTHROPIC_API_KEY` + correr evals live.

### Added — Subida GPS nativa en background (app Vendedor, patch al plugin) (2026-06-29)
- Diagnóstico por logcat (teléfono Honor): el foreground service **sobrevive** al bloqueo, pero la subida vivía
  en el WebView (que se congela al bloquear) → los fixes capturados con pantalla bloqueada no se subían.
- **Patch nativo** (`@capacitor-community/background-geolocation` vía patch-package): el `BackgroundGeolocationService`
  ahora **POSTea los fixes directo** a `/reports/route-pings` con `HttpURLConnection` en un executor (cola in-memory
  con retry, token Bearer cacheado — el JWT dura 12h). Nuevo método `setUploadConfig` y opciones `uploadUrl/authToken/routeId`.
- **Aditivo**: el path JS (Dexie + drain) queda de respaldo cuando la app está viva; el server deduplica por `client_uuid`.
- Cierra el gap "capturado pero no subido al bloquear". **El Java se compila solo al armar el APK** (no en `nx build`).
- Sigue pendiente del lado device: probar **al aire libre** (el GPS no engancha indoor bloqueado) + whitelist Honor.
  `POST_NOTIFICATIONS` (notif invisible en Android 13+) no resuelto pero no bloquea el tracking.

### Added / Fixed — Auditoría del take-order del vendedor: offline-first + robustez (2026-06-29)
- Origen: auditoría del apartado "tomar pedido" de `apps/vendor` (8 hallazgos). 6 altos/medios corregidos, **builds api+vendor verdes**. Sin deploy.
- **Added — Offline-first** (`#1`, híbrido por conectividad para no regresionar el flujo online): el vendedor ahora puede **abrir, armar y confirmar** un pedido **sin señal**; se sincroniza solo al reconectar.
  - Dexie **v8**: `vendorCatalogCache` (catálogo por price-list, dedup) + `vendorCustomerCache` (cliente + habituales) → abrir sin red; `pedidosPendientes` (draft local con `serverOrderId` como guard de idempotencia).
  - Nuevos `ConnectivityService` (signal online/offline) y `OfflineOrderService` (draft local + totales client-side). `take-order` ramifica por conectividad (banner "Sin conexión", mic de voz oculto offline). `order-success` muestra "Se enviará al reconectar".
  - Replay en `OfflineSyncService.sincronizarPedidosPendientes` (createDraft → PUT lines → POST place), best-effort, idempotente. Límite: un cliente creado offline no se puede pedir offline (sin contexto cacheado).
  - **Visibilidad** (para que un replay fallido no sea un pedido perdido en silencio): sección **"Pedidos sin enviar"** en *Mi día* (chip "En cola" / "No se pudo enviar"; los muertos tras 5 reintentos tienen **Reintentar** y **Descartar**) + badge con el conteo en el header "Mi día".
- **Added — `POST /commercial/orders/:id/place`** (`#4`): toma un pedido **draft → confirmed en 1 transacción atómica e idempotente** (reemplaza el encadenado `updateDraftHeader→confirm→approve`, que ante un fallo de red dejaba el pedido en `pending_approval` y el reintento atascado en "solo desde draft"). Preventa no reserva stock (igual que `confirm`).
- **Fixed — Chattiness de red** (`#2`): cantidad **optimista** + debounce (los `+/−` ya no pegan al backend por cada tap → 1 update por ráfaga); sugerencias Thot fuera del camino caliente.
- **Fixed — Carga inicial** (`#3`): eliminado el doble `getCustomer` y el doble `draftForCustomer` al abrir un cliente (2 rondas en vez de ~8-11 requests).
- **Changed — Pedido sugerido** (`#6`): pasa de auto-armarse (riesgo de agendar de más) a **opt-in** (banner "¿Cargar pedido sugerido?").
- **Fixed — Mensaje de stock** (`#5`): ya no promete un "backorder" inexistente; en preventa avisa "stock actual bajo, se surte al repartir".
- **Internal**: borrado `updateDraftHeader` (huérfano tras `place`); eliminado `setQty`. **Pendiente**: verificación en device real + test http de `/place` en la regression.

### Fixed — Auditoría del inventario físico (Fase I): integridad + reconcile cíclico + endurecimiento (2026-06-27)
- Origen: auditoría multi-agente de `/comercial/inventory` (38 hallazgos verificados, 4 refutados). 6 bloques aplicados, **regression verde en vivo**. Detalle en `inventory-count.service.ts` + 5 migraciones `20260627*`.
- **Integridad / SoD**: el doble conteo ciego ya no se puede colapsar (nadie pisa el `count_1`/`count_2` de otra persona); el reconciliador no puede ser quien **resolvió** ítems (nueva col `resolved_by` + set de segregación); `cancel()` con `FOR UPDATE` (cierra carrera cancel↔reconcile); `submitCount`/`reconcile` **fail-closed** si no hay usuario.
- **Reconcile cíclico (reestructura, ADR-pendiente)**: los folios **no congelados** ya no se bloquean por movimientos — reconcilian con **delta relativo** contra el libro al momento del conteo (`book_at_count`), preservando las ventas ocurridas durante el conteo en vez de borrarlas con un set absoluto. Lock antes de calcular (cierra TOCTOU). El set absoluto + freeze guard se mantiene para conteos **congelados**.
- **Contabilidad de varianza**: la varianza/IRA se calcula contra `book_at_count` en cíclicos (ya no infla la merma con ventas del período); **costo congelado al reconciliar** (`unit_cost` + `net_variance_value`/`variance_value_abs` por folio) → el valor de merma no deriva si cambia `cost_base`; `reason_code` exigible en varianzas materiales (opt-in por umbral).
- **Operabilidad del día de conteo**: endpoint blind-safe `GET /commercial/inventory/counts/:id/catalog` + pre-cache offline al iniciar jornada (1er scan offline ya reconoce); escaneos rechazados (409) visibles + flush periódico + reintento; badge "Estancado" en folios y aviso anticipado de almacén congelado en Existencias.
- **Robustez**: guards del path inventory-source (CHECK `quantity>=0`/`>=reserved` + reserva en reconcile); folio de 0 ítems rechazado; año del folio en TZ MX; `statement_timeout` + logging en reconcile; kepler-export arreglado para folios inventory-source (ya no emite SKU null/$0).
- **Diferido**: aprobación por valor (#12), tolerancia/IRA por clase ABC (#17), hook GL/COGS, limpieza del CHECK de estados muertos. **Pendiente prod**: aplicar las 5 migraciones en el deploy.

### Added — Tiendas de oportunidad: prospección con INEGI DENUE (Fase DENUE) (2026-06-24)
- Nueva capa **"Tiendas de oportunidad"** en `dashboard/commercial-map`: descubre PdV reales (dulcerías,
  abarrotes, minisúper) que **aún no son clientes** vía **INEGI DENUE** (dato abierto → almacenable con atribución).
- Backend en `libs/trade/commercial-map`: `DenueClientService` (Buscar/BuscarAreaAct/Cuantificar/Ficha),
  `ProspectsService` (ingesta + **dedup** JS por haversine + Dice-bigrams contra `stores` + `commercial.customers`
  + whitespace score), `ProspectsController` (9 endpoints), cron nocturno de re-dedup. Tablas
  `commercial.prospect_sources` + `prospect_stores` (RLS forzado). Permisos `COMMERCIAL_MAP_PROSPECTS_VER/_GESTIONAR`.
- Frontend: capa aditiva reusando `MapLayer`/`MapLegend` (patrón "Personal en vivo") + dialog de prospecto +
  botón "Cosechar oportunidades (DENUE)" (cosecha por área Michoacán, geocercada). ADR-025.
- Scoping Mega Dulces: **Michoacán (entidad 16) + geocerca 100 km de La Piedad** (centro/radio en config,
  triple filtro: ingesta `passesGeo` + purga en `dedup` + filtro SQL en `list`). Cosecha robusta vía
  `BuscarAreaAct` (el endpoint `Buscar` lo rate-limitea INEGI por IP).
- **Inteligencia DENUE (opción A)**: `GET /prospects/penetration` (clientes ÷ universo por SCIAN y municipio
  + densidad por territorio + total real vía `Cuantificar`), `POST /prospects/enrich-customers` (completa
  teléfono/email vacíos de clientes desde su match DENUE), y `whitespace_score` ahora pondera el tamaño del
  negocio (`estrato`). Dialog "Penetración" + botón "Enriquecer clientes" en el mapa.
- **Aplicado a PROD**: migraciones corrieron en el deploy (tablas + config Michoacán/La Piedad sembrada +
  permisos en roles). Pendiente: `DENUE_TOKEN` en Railway + re-login para cosechar.

### Added — Salud del tracking en segundo plano + guía de ubicación (app Vendedor) (2026-06-24)
- Cuando el GPS deja de registrarse con la pantalla bloqueada, el problema #1 es operativo (permiso de
  ubicación que no es "todo el tiempo" + optimización de batería que mata el foreground service).
- `RoutePingService` ahora expone `trackingHealth()` ('ok'|'web'|'permission'|'inactive'): captura el error
  `NOT_AUTHORIZED` del watcher nativo y si el watcher quedó activo. `openSettings()` lleva a los ajustes de la app.
- **Banner** en el shell del vendedor cuando el tracking está degradado + **guía de 3 pasos** (permiso "Permitir
  todo el tiempo" / batería "Sin restricciones" / Autostart en Xiaomi-Huawei-Oppo-Vivo) + **onboarding one-time**.
- Diagnóstico pendiente (test de la notificación con pantalla bloqueada) para decidir si hace falta el plugin
  nativo de pago (`@transistorsoft/...`, HTTP nativo + heartbeat) — el actual es solo-por-movimiento y sube vía WebView.

### Changed — Basemap Mapbox (tiles) en vez de OSM, theme-aware + switcher Satélite (2026-06-23)
- El átomo de mapa compartido (`app-map`) ahora pinta con **tiles de Mapbox** (reusa el token del backend,
  expuesto como `pk.` en `environment.ts`) en vez del tile server público de OSM (que no es apto para producción:
  política de uso, sin SLA). **Una línea, un archivo** → las 4 superficies (live/rutas/comercial/field) lo heredan.
- **Theme-aware con estilos propios "Mercado"** (Mapbox Studio): claro = "Streets", oscuro = "Dark 2D" según
  el tema de la app (respeta DESIGN.md). Verificado end-to-end (tiles 200 image/png). Slots configurables.
- **Switcher Mapa/Satélite** (`satellite-streets-v12`, útil para ver la fachada del PdV) + tiles **@2x retina**.
- Centro inicial (cuando no hay datos que encuadrar) cambiado de Morelia → **La Piedad, Mich.** (`[20.2984, -101.9884]`),
  ahora input `fallbackCenter`/`fallbackZoom` overridable por pantalla. Con datos, `fitBounds` lo pisa; en Mapa en Vivo,
  seleccionar a una persona ya centra en su última posición (`panTo`).
- Fallback a OSM si falta el token (no rompe dev). El basemap NO depende de la env de Railway (token en el bundle);
  las capacidades de backend (ETA/optimize/matching) sí siguen necesitando `MAPBOX_TOKEN` en Railway.
- Pendiente: restringir el token `pk.` por URL en el panel de Mapbox (Account → Tokens) para proteger la cuota.

### Fixed — Inteligencia comercial resurfaceada tras la fusión Mapa de Campo (2026-06-23)
- La fusión MF.1 enterró el Mapa Comercial como 4ª pestaña ("Exhibición") y **rompió el acceso**: la ruta
  `field-map` solo pedía `RUTAS_VER`, así que un rol con **solo `COMMERCIAL_MAP_VER`** ya no podía llegar
  (nav sin entrada directa + guard de ruta lo bloqueaba). No se perdió data — `commercial-map` estaba intacto.
- **Restaurado**: ítem de nav directo **"Mapa Comercial"** (gateado `COMMERCIAL_MAP_VER`) bajo el grupo "Mapas".
- **Guard OR** (`anyPermissionGuard`): `field-map` ahora admite `RUTAS_VER` **o** `COMMERCIAL_MAP_VER`.
- **Default inteligente**: un rol solo-comercial aterriza directo en la pestaña Comercial (no en "Equipo" vacía);
  las pestañas de tracking solo se muestran con `RUTAS_VER`. Pestaña "Exhibición" renombrada → **"Comercial"**.

### Added — Capacidades Mapbox: geocoding, ETA, optimización, imagen (backend) (2026-06-23)
- **Geocoding** (`database/scripts/geocode-mapbox.js`): geocodifica `commercial.customers` (dirección → lat/lng)
  vía Mapbox con score de relevancia — mejor que Nominatim; mejores coords → mejor geofence/cobertura/visitas.
- **`MapboxService`** + endpoints: `GET /reports/eta` (Directions con tráfico → minutos al próximo cliente),
  `POST /reports/optimize-stops` (Optimization, orden óptimo de visita ≤12 paradas), y `map_image_url` en
  `vendor-day` (Static Images — imagen del recorrido para PDF/WhatsApp). Verificado contra Mapbox con datos reales.
- Pendiente: wiring UI (ETA/optimizar en app vendedor) + `MAPBOX_TOKEN` en Railway.

### Added — Resumen del equipo (Mapa de Campo → Equipo) (2026-06-23)
- Nueva pestaña **Equipo** (vista por defecto de Mapa de Campo): tabla del personal de campo activo hoy con
  estado en vivo, jornada, km aprox, visitas detectadas por GPS y **cuántas sin captura** (ordenada por gap).
  Clic en una fila → salta a "Por vendedor" de ese vendedor/día. Endpoint `GET /reports/team-day` (barato,
  sin map-matching: pings crudos + paradas + geofence + capturas por ventana de tiempo).

### Added — Detección automática de visitas (GPS) (2026-06-23)
- En **Mapa de Campo → Por vendedor**, las paradas geofenceadas a una tienda (≥5 min, ≤90 m) se listan como
  **visitas detectadas**, cruzadas con las capturas reales por **ventana de tiempo** (confiable, no depende del
  `store_id` ralo de capturas) → badge **capturó / sin captura**. KPI con conteo + "sin captura". Resuelve el gap
  de cobertura real: "estuvo en la tienda pero no registró visita". Sin esquema nuevo (reusa `getVendorDay`).

### Added — Mapa de Campo: superficie unificada (consolida Rutas + Historial + Comercial) (2026-06-23)
- Nuevo `/dashboard/field-map` con selector de vista **Por ruta / Por vendedor / Exhibición** (refleja `?view=`).
  Consolida 3 superficies de mapa en 1 entrada de nav (MF.1: cada vista monta su componente existente, sin
  regresión). Nav de "Mapas" baja de 4 a 2 ítems (Mapa en Vivo + Mapa de Campo). Tab Exhibición gateada
  `COMMERCIAL_MAP_VER`. Rutas viejas siguen vivas para deep-links. Pendiente MF.2+: unificar mapa + drill-down.

### Changed — Tracking: tag de plataforma + APK con fixes (2026-06-23)
- Pings ahora llevan `platform` (web/android/ios) — migración `route_location_pings.platform` + DTO + ingest +
  ambos clientes. Zanja "¿web o nativo?" en el diagnóstico de por qué un vendedor no aparece.
- APK nativo reconstruido con todos los fixes de tracking (anti-loop, heartbeat detenido, background). **Lo
  desplegado estaba viejo**: requiere redeploy + reinstalar APK + en el teléfono "Permitir todo el tiempo" +
  quitar optimización de batería para rastrear con pantalla bloqueada.

### Added — Mapa en Vivo: alertas en vivo (detenido / sin señal) (2026-06-23)
- **`FieldAlertsScannerService`** (`@Cron */4 min`, read-only sobre `route_location_pings`): detecta
  **offline** (dejó de reportar hace 20–180 min) e **idle** (≥15 min detenido dentro de 70 m). Cooldown 1 h
  por (tenant, usuario, tipo). Emite `field_alert` por el WS `/reports` (room global + equipo del supervisor).
- Cockpit: **feed de alertas** arriba de la lista (clic → enfoca a la persona) + ⚠ en las filas marcadas;
  upsert por usuario+tipo, expiran a los 20 min.

### Added — Mapa en Vivo: cockpit de supervisión (2026-06-23)
- **Clic en una persona → SidePeek** con estado, última señal, velocidad, KPIs GPS de hoy
  (km/paradas/movimiento) y botón "Ver recorrido del día" (deep-link a Historial con prefill por queryParams).
- **Trail del seleccionado**: al elegir a alguien dibuja su recorrido del día (por calles) + paradas
  sobre el mapa, junto al cursor en vivo.
- **Capa de Tiendas** (toggle): contexto del personal vs tiendas. Endpoint liviano `GET /reports/stores-geo`.
- **Estado por persona** (en traslado / en {tienda} por geofence / detenido) + **búsqueda** en la lista
  + leyenda con toggles de capa (Personal / Tiendas).

### Added — Rutas R.4: playback del recorrido (2026-06-23)
- En **Historial de vendedor**, barra de reproducción: play/pausa + slider (scrub) + velocidad 1×/2×/4×
  + reloj aproximado. Un cursor recorre la geometría pegada a calles (modo `persistent` del átomo
  app-map); la ruta completa se ve tenue y el tramo ya recorrido se resalta. Sin backend nuevo.

### Added — Rutas R.3/R.5: Historial de vendedor (día por calles + KPIs) (2026-06-23)
- Nueva vista **"Historial"** (`/dashboard/vendor-history`, nav bajo grupo "Mapas", gate `RUTAS_VER`):
  elegís **vendedor + fecha** y ves su día completo — recorrido pegado a calles, paradas y métricas.
- **KPIs (R.5)**: distancia real (km), # de paradas, tiempo en paradas, tiempo en movimiento,
  velocidad media (km/h), jornada (primer–último movimiento).
- Backend: `GET /reports/field-users?date` (vendedores con actividad GPS ese día) +
  `GET /reports/vendor-day?user_id&date` (recorrido snapped + paradas + KPIs). Enforce de scope
  (own → solo a sí mismo; team → solo su equipo). Reusa `MapMatchingService` (caché por user+día).

### Added — Rutas R.1/R.2: historial "por calles" (map-matching) + paradas (2026-06-23)
- **Recorrido pegado a la red de calles** (antes líneas rectas entre breadcrumbs): map-matching con
  **Mapbox** (`MAPBOX_TOKEN`), arquitectura matcher+caché — el recorrido de un día pasado se calcula
  una vez y se guarda en `public.route_snapped_tracks` (mig 20260623120000). El día de hoy no se cachea.
- **`MapMatchingService`** (libs/trade/reports): pings → downsample → chunks ≤100 → `/matching/v5` →
  geometría GeoJSON + distancia real. Chunk fallido cae a línea cruda. Proveedor intercambiable.
- **Paradas automáticas** (R.2): dwell ≥5 min dentro de 40 m → marcador con duración + **geofence ≤90 m**
  contra `stores` para nombrar la tienda. Llegada/salida derivadas del GPS.
- Endpoint `GET /reports/routes/:id/snapped?date=` (gate `RUTAS_VER`, scope own/team).
- Frontend **Rutas**: toggle "Por calles" → dibuja la geometría snapped + paradas + "X km reales".
- Requiere en deploy: aplicar la migración + setear `MAPBOX_TOKEN` en Railway (sin token degrada a línea cruda).

### Added — MapKit: núcleo de mapa compartido + cruce de contexto en vivo (2026-06-23)
- **Átomo `app-map` ampliado (aditivo)**: input `layers: MapLayer[]` (cada capa en su `L.LayerGroup`,
  conmutable sin redibujar las demás), modo `persistent` (mueve marcadores con `setLatLng` para tracking
  fluido), `MapMarker.kind:'user'` + `ring`, `autoFit:'always'|'once'|'off'`, métodos `recenter()/panTo()/invalidate()`.
  Defaults = comportamiento legacy byte-por-byte (routes/commercial/logística intactos).
- Nuevos shared: `map-legend/` (toggles de capa + conteo), `core/services/map-live-layer.service.ts`
  (capa de posiciones en vivo reutilizable: seed `/reports/live-positions` + stream WS `route_ping`),
  `shared/util/relative-age.ts` (frescura + edad relativa tokenizada).
- **Capa "Personal en vivo"** opcional en **Mapa Comercial** y **Rutas** (gateada `RUTAS_VER`): superpone
  vendedores en tiempo real sobre las tiendas / sobre el recorrido histórico — el cruce de contexto del supervisor.
- Nav: las 3 superficies de mapa agrupadas bajo sección **"Mapas"**.

### Changed — live-map migrado al átomo MapKit
- `live-map` consume `app-map` (modo `persistent`) + `MapLiveLayerService`; se borró su Leaflet inline propio
  y `live-tracking.service.ts`. Sin cambio funcional visible.

### Fixed — off-by-one de fecha en TZ México
- `routes-analysis` (`isoOffset`) y `commercial-map` (`fmtDate`) ahora formatean la fecha en
  `America/Mexico_City`, no en la TZ del browser (evita cargar el día equivocado fuera de MX).

### Internal — diferido (con razón)
- `logistica-live → WS`: consume `liveShipments()` (agregado por embarque, no pings de usuario) → requiere
  emisión WS por embarque en backend; no es swap limpio.
- Migración de drill-down de `commercial-map` a SidePeek+Customer360 (regla #8 DESIGN.md): pendiente de QA visual.

### Added — PA.4a: conteo particionado por pasillo (foundation + avance por pasillo)
- `openCount` ahora **stampa `items.aisle_id`** desde `commercial.stock.aisle_id` al abrir el folio (modo
  commercial) → el conteo queda particionado por pasillo. (Modo inventory/SKU: aisle_id null, fase posterior.)
- `aisleProgress(countId)` + **`GET /commercial/inventory/counts/:id/aisle-progress`** (gate SUPERVISAR):
  por pasillo → total / contados / sin contar / discrepancias / resueltos, + bucket "sin pasillo".
- Build api verde + checks en el smoke PA.3+PA.4 (2 pasillos × 2 items stampeados, 0 sin pasillo). ⏳ reinicio.
  Siguiente PA.4b: el contador cuenta SOLO su pasillo (submitCount enforce) + freeze por pasillo.

### Changed — reparto de equipos = PAREJO (se eliminó el generador proporcional PA.2)
- Decisión del usuario 2026-06-19: el reparto de contadores por pasillo es **parejo** (contadores ÷ pasillos),
  no proporcional-a-unidades. Se **eliminó** el generador proporcional de PA.2 (`WarehouseAislesService.generateTeamPlan`,
  `POST /commercial/inventory/aisles/plan`, y su smoke `http-inventory-team-plan-test.js`). El generador
  vive en el tablero por folio (PA.3 `generate-teams`, parejo). Addendum en ADR-024. Reintroducir proporcional
  como `mode` si se necesita.

### Added — PA.3: tablero de equipos por folio (staffing por pasillo) + smoke
- `InventoryTeamService` + `InventoryTeamController`: `GET/POST /commercial/inventory/counts/:id/aisle-teams`
  (board + set manual) y `POST .../generate-teams` (auto-generar). Persiste supervisor + contadores **por
  pasillo** en `inventory_count_assignments.aisle_id`. **Generador parejo** (contadores ÷ pasillos, resto de
  a 1). Frontend `/comercial/inventory/sessions/:id/teams` (grilla 2D, pool del día, auto + ajuste manual)
  + botón "Equipos por pasillo" en el detalle del folio. Build view+api verde + **smoke PA.3** agregado.
- **⚠️ Divergencia de generador (pendiente de reconciliar):** PA.3 usa reparto **parejo** (decisión del
  usuario, override del proporcional de ADR-024). El `/aisles/plan` proporcional-por-unidades (PA.2) queda
  como preview alternativo, no usado por el tablero. ⏳ reinicio + QA visual.

### Added — PA.2: generador de equipos proporcional (1 supervisor/pasillo + contadores por unidades)
- `WarehouseAislesService.generateTeamPlan` + **`POST /commercial/inventory/aisles/plan`** (gate `ASIGNAR`):
  dado un almacén + pool del día (supervisor_ids / counter_ids; default = todos los asignables por permiso),
  arma el plan — **1 supervisor por pasillo** si hay suficientes, o **clusters balanceados (LPT)** si hay
  menos supervisores que pasillos; **contadores proporcionales a las unidades** de cada pasillo
  (`c_i = max(min, round(C·w_i/W))`, con ajuste de redondeo para repartir exactamente C). Warnings de
  faltantes (supervisores/contadores). **No persiste** (la asignación a un folio es PA.3).
- Build api verde + smoke PA.2 (`http-inventory-team-plan-test.js`, registrado): 1:1 supervisor, Σ
  contadores = pool, mín por pasillo, pasillo más pesado ≥ contadores, cluster con 1 supervisor. ⏳ reinicio.

### Added — PA.1b: editor 2D de pasillos (UI) + endpoint de marcas
- Página **`/comercial/inventory/aisles`** (tab "Pasillos" en el strip de inventario, gate `ASIGNAR`).
  Surface Operations (DESIGN.md): **grilla CSS 2D** — cada pasillo en su `grid_row/col`+span, con
  código/nombre/carga (unidades + #SKUs) + barra de carga; **panel lateral** al seleccionar (editar
  nombre/posición · borrar con confirm · **asignación bulk** SKU→pasillo en 4 modos: **marca / clase ABC /
  rango SKU / sin-asignar**); tile "Sin pasillo"; dialog "Nuevo pasillo". `tabular-nums`, in-page hairline.
- Backend: **`GET /commercial/inventory/aisles/brands`** (marcas con stock en el almacén, para el dropdown
  de asignación) + `ComercialService` { listAisles, aisleBrands, createAisle, updateAisle, deleteAisle, assignSkusToAisle }.
- **Layout de pasillos completo** (PA.0 schema + PA.1a backend + PA.1b UI). Build view+api verde.
  ⏳ QA visual + reinicio. Siguiente: PA.2 (generador de equipos proporcional).

### Added — PA.1a: backend de pasillos (CRUD + mapeo bulk SKU→pasillo + carga)
- `WarehouseAislesService` + **`/commercial/inventory/aisles`** (gate `COMMERCIAL_INVENTORY_ASIGNAR`):
  CRUD de pasillos (posición 2D `grid_row/col` + `span`); `GET ?warehouse_id=` devuelve cada pasillo con su
  **carga** (unidades = `Σ quantity` + `#SKUs`) + el bucket **"Sin pasillo"**; **`POST .../assign`** mapea
  SKUs→pasillo en **bulk** por filtro (`product_ids` / `brand_id` / `abc_class` / rango SKU / `only_unassigned`;
  `aisle_id=null` des-asigna).
- Guards: código único por almacén (409), borrar pasillo **bloqueado si un folio abierto lo usa**, `assign`
  exige al menos un filtro (anti assign-all accidental). Setear `stock.aisle_id` NO dispara el trigger FEFO.
- Build api verde + smoke PA.1 (`http-inventory-aisles-test.js`, registrado). ⏳ requiere **reinicio**.

### Added — PA.0: schema de pasillos 2D + dimensión de pasillo en el conteo (ADR-024)
- Arranca la **Fase PA** (conteo zonificado): el almacén se divide en **pasillos 2D**, 1 supervisor/pasillo,
  equipo de contadores proporcional. Diseño en `FASES/FASE_PASILLOS_EQUIPOS.md` + **ADR-024**.
- **`commercial.warehouse_aisles`** (mig `20260619140000`, RLS forzado): layout permanente — `code`, `name`,
  posición 2D (`grid_row/col` + `span`), por almacén. + **`commercial.stock.aisle_id`** (mapeo SKU→pasillo,
  grano warehouse×product) + **`inventory_count_assignments.aisle_id`** (tablero por folio; unique recreado a
  `(tenant,count,aisle,user,role)` NULLS NOT DISTINCT para permitir supervisor en varios pasillos) +
  **`inventory_count_items.aisle_id`** (foto al abrir → particiona el conteo).
- FK de `aisle_id` = columna simple a `warehouse_aisles.id` con **`ON DELETE SET NULL`** (borrar un pasillo
  NO borra stock/items; el order flow ignora `aisle_id`). Verificado DB-direct (alta, mapeo, carga en
  unidades, SET NULL). Decisiones: dominio inventario · alta manual · proporcional a unidades · grilla · híbrido.

### Added — ABC.3b: UI de conteo cíclico (cierra la fase ABC)
- Página **`/comercial/inventory/abc`** (tab "Cíclico" en el strip de inventario, gate SUPERVISAR).
  Superficie **Operations** (DESIGN.md): page-head Hanken bold, **KPI strip** (Por contar ahora · Valor
  clasificado · barra de Distribución ABC) + **tabla densa** con dos vistas (`p-selectButton`): **Agenda
  de conteo** (cycle-due, accionable) y **Clasificación ABC** (por valor de consumo).
- Acciones: **Recalcular ABC** (ghost → `/abc/refresh`) y **Generar folios** (sunset → `/abc/generate-cycle-folios`,
  habilitado al elegir almacén + confirm dialog). `p-tag [severity]` mapeado (A=success/B=warn/C=secondary;
  due=danger/warn/secondary), `tabular-nums` en cifras, empty states con CTA, in-page hairline sin sombra.
- Backend: nuevo **`GET /commercial/inventory/abc/summary`** (conteo+valor por clase para KPIs exactos sin
  cargar todas las filas) + `ComercialService` { abcSummary, listAbc, cycleDue, refreshAbc, generateCycleFolios }.
- **Fase ABC completa en código** (clasificar → due → contar acotado → automatizar → UI). Build view+api
  verde + summary en smoke I.6. ⏳ QA visual + reinicio.

### Added — ABC.3a: scheduler de conteo cíclico (cron + disparo manual)
- `CycleCountSchedulerService` — `@Cron('0 0 8 * * *')` (gateado por `ENABLE_CYCLE_COUNT_CRON=true`):
  itera tenants en `tenantCtx.run({tenantId})` (CLS sintético, patrón recommendations-refresh) → por
  almacén toma lo que está due (ABC.1, prioriza A, cap 50) y abre un folio cíclico acotado (ABC.2).
  Anti-duplicado: si el almacén ya tiene folio abierto → `skipped` (no re-crea).
- **`POST /commercial/inventory/abc/generate-cycle-folios`** (gate SUPERVISAR, scoped al tenant del JWT,
  opcional `warehouse_id`/`max_items`): disparo manual del scheduler (para QA / on-demand).
- Backend del control continuo **completo** (clasificar → ver due → contar acotado → automatizar). Solo
  resta ABC.3b (UI). Smoke I.7 §5 (genera 1 folio + anti-duplicado). Build verde. ⏳ requiere reinicio.

### Added — ABC.1: due/agenda de conteo cíclico (cycle-due)
- `InventoryAbcService.cycleDue()` cruza `commercial.abc_classification` × historial reconciliado
  (`MAX(inventory_counts.reconciled_at)` por (almacén,producto) de folios `reconciled`) → calcula
  `next_due = last_counted_at + cadencia(clase)` (A=30 / B=90 / C=365 días); nunca contado = due ya.
- **`GET /commercial/inventory/abc/cycle-due`** (?warehouse_id=&abc_class=&only_due=, gate SUPERVISAR):
  lista lo que toca contar, orden A-primero / más-vencido-primero, con `is_due`, `next_due`, `days_overdue`
  y summary `by_class`. Con ABC.0+ABC.1+ABC.2 el flujo manual está completo (clasificar → ver qué toca →
  contar solo eso).
- Verificado DB-direct (`database/scripts/verify-abc-cycle-due.js`: orden A→C, cadencia 30/365,
  nunca-contado → due + next_due null) + smoke I.6 §5. Build verde. ⏳ requiere reinicio para verde live.

### Added — ABC.2: conteo cíclico acotado (open-cycle)
- El corazón del conteo cíclico: hoy `openCount` sembraba **todo** el almacén (`type='cycle'` no acotaba
  nada). Ahora `openCount` acepta `product_ids?` → siembra solo ese subset (commercial por `product_id`;
  inventory mapea a `sku` vía catalog). Nuevo `openCycleCount` + **`POST /commercial/inventory/counts/open-cycle`**
  (gate SUPERVISAR): genera un folio `type='cycle'` por **clase ABC** (toma los productos de esa clase del
  almacén desde `abc_classification`) o por **lista explícita**, capeado, con **freeze=false** por default
  (un cíclico no congela el almacén; el full sigue congelando).
- **Freeze-integrity guard scopeado a los productos del folio**: un movimiento de un SKU que el folio NO
  está contando ya no bloquea el reconcile. Para un full count el comportamiento es idéntico (items =
  snapshot completo); habilita el cíclico en caliente. (La I.5 A1 sigue válida: el movimiento del producto
  contado sí bloquea.)
- Smoke I.7 (`http-inventory-cycle-count-test.js`, registrado): open-cycle por clase → 3 items; por lista →
  exactamente el subset; sin clase/lista → 400. Build api verde. ⏳ requiere **reinicio** para verde live.

### Added — ABC.0: clasificación ABC por (almacén, producto)
- Primer paso de **conteo cíclico programado** (ver `FASES/FASE_ABC_CYCLE_COUNT.md`). Clasifica cada
  (almacén, producto) por **valor de consumo anualizado** (unidades vendidas en pedidos `fulfilled`,
  ventana 90d → anualizada × `catalog.cost_base`), vía **Pareto por almacén** (share acumulado
  **exclusivo**: el top mover siempre cae en A — el inclusivo mandaba a C al único mover de un almacén).
- **`commercial.abc_classification`** (mig `20260619100000`, RLS forzado, FKs compuestas, unique natural
  por (tenant,wh,product)). Recompute full atómico (DELETE+INSERT en una trx).
- **`InventoryAbcService`** + **`GET /commercial/inventory/abc`** (?warehouse_id=&abc_class=) y
  **`POST /commercial/inventory/abc/refresh`** (?window_days=), ambos gate `SUPERVISAR` (como IRA).
- Verificado DB-direct (`database/scripts/verify-abc-compute.js`: 32 849 clasificados, SQL válido,
  toda fila clase ∈ {A,B,C} + value_share ∈ [0,1]). Smoke I.6 (`http-inventory-abc-test.js`, registrado
  en run-all-tests). Build api verde. ⏳ requiere **reinicio** para verde live (endpoints nuevos).

### Added — P2.3 FEFO: trazabilidad del lote consumido por cada venta
- **`commercial.stock_lot_movements`** (mig `20260618230000`, RLS forzado, append-only, FKs compuestas a
  tablas reales): ledger por lote de qué se consumió, cuánto, y por qué referencia (pedido).
- **`OrderStockService.consume`** ahora hace **diff before/after** de `stock_lots` (el trigger ya hace el
  decremento FEFO; acá se **observa** el resultado real, sin re-simular) y registra una fila por lote
  consumido, ligada al `order_id`. Misma trx; sin cambios de comportamiento ni montos.
- **`GET /commercial/inventory/lot-movements`** (gate `AJUSTAR`, como `/movements`): filtros `lot_code`
  (recall "¿qué pedidos consumieron el lote X?"), `reference_id` ("¿de qué lotes salió el pedido Y?"),
  `product_id`/`warehouse_id`.
- Build api verde + check en smoke alerts (pedido que despacha lote vencido → lot-movement qty 5 ligado
  al pedido). ⏳ requiere **reinicio** (es código de API). Deferred: trazar ajustes/reconcile a nivel lote.

### Added — P2.2c FEFO: dashboard "Por vencer" (cierra P2.2)
- **Página `/comercial/inventory/expiring`** (gate `COMMERCIAL_INVENTORY_VER`, tab "Por vencer" en el strip
  de inventario): consume `GET /commercial/inventory/expiring`. KPIs (valor en riesgo al costo / # lotes /
  # ya vencidos), tabla con tag de días-a-caducar (vencido + ≤7d = `danger`, ≤15d = `warn`), filtro de
  ventana (7/15/30/60/90 días) + almacén. Fila resaltada si está vencida.
- `ComercialService.listExpiringLots()` + interfaz `ExpiringLot`. Build view verde. ⏳ verificación visual manual.
- **P2.2 (caducidad/FEFO) = completa** beta scope: captura → endpoint → alerta cron → gate warn → dashboard.
  Verificado live: I.5 26/26, alerts WS 25/25, trigger expired-last (script + J.6.1 19/0). Siguiente: P2.3.

### Added — P2.2d FEFO: no despachar vencido primero + aviso `sold_expired` (warn, NO block)
- **Decisión** (addendum ADR-022): la política de venta de vencidos es **avisar, no bloquear** — para
  no meter el motor en el camino del dinero (reserva). Reversible a block configurable si el negocio lo pide.
- **Trigger expired-last** (mig `20260618220000`, `CREATE OR REPLACE` de `fn_rebalance_stock_lots`): el
  decremento FEFO ahora consume **lotes no-vencidos primero** (`ORDER BY (expiry<hoy) ASC, expiry ASC`),
  vencidos solo como último recurso. La venta normal ya no despacha producto caducado. Invariante intacto.
  **Verificado** (`database/scripts/verify-fefo-expired-last.js`: bueno baja 10→5, vencido queda 10) +
  order flow **J.6.1 19/0** sin cambios.
- **Aviso `sold_expired`**: `OrderStockService.consume` devuelve `expiredConsumed` (= `qty − bueno_no_vencido`);
  `OrdersService.fulfillInTransaction` acumula los hits y emite alerta WS `warn` (`AlertsService.emitSoldExpired`)
  cuando un despacho tocó lote vencido. Cambio **no-bloqueante** y sin alterar montos. Nuevo tipo `sold_expired`.
- Build api verde + check WS en smoke alerts (almacén con solo lote vencido → fulfill → recibe `sold_expired`).
  ⏳ la parte de aviso requiere **reinicio** para probar live (el trigger ya está activo, es DB-level).

### Added — P2.2b FEFO: cron de alerta de lotes por vencer
- **`AlertsScannerService` scan #3** (`expiring_lots`): detecta lotes de `commercial.stock_lots` con
  `expiry_date <= hoy+30d` y `quantity > 0` (incluye **vencidos**) → emite alerta WS vía nuevo
  `AlertsService.emitExpiringLots` con severidad `critical` (≤7 días o vencido) o `warn`. Reusa el
  patrón de `low_stock` (scoping por `SET LOCAL app.tenant_id`, cooldown 1h anti-spam). Cron global
  sigue gateado por `ENABLE_COMMERCIAL_ALERTS`; `POST /commercial/alerts/scan-now` lo dispara manual.
- Nuevo tipo `expiring_lots` en `AlertType` + umbrales `EXPIRING_LOTS_DAYS=30` / `EXPIRING_LOTS_CRITICAL_DAYS=7`.
- Build api verde + check WS en el smoke de alerts (almacén dedicado + lote a +3d → recibe alerta `critical`;
  almacén soft-deleteado queda inactive y no se re-escanea). ⏳ requiere **reinicio** para probar live.
- P2.1b + P2.2a ✅ **verificados LIVE** (smoke I.5 26/26 tras reinicio): captura de lote, `/lots`, `/expiring`.
- Roadmap actualizado: P2.2b dividido → P2.2b alerta (✅ código) / P2.2c dashboard "Por vencer" / P2.2d
  gate de venta de vencidos (diseño primero — conflige con el invariante del trigger).

### Added — P2.2a FEFO: endpoint de lotes por vencer (base de alertas de caducidad)
- **`GET /commercial/inventory/expiring?days=30&warehouse_id=`** (gate VER): lotes con caducidad
  ≤ hoy+`days` y stock > 0 (incluye **vencidos** — `days_to_expiry` puede ser ≤0), con
  producto/almacén/`value_at_cost`, orden por caducidad ASC. Base del dashboard/cron de caducidad
  (P2.2b). Build api verde + checks en smoke I.5 (ventana 90 incluye el lote a +60d, ventana 30 no).
- Endurecido el smoke I.5: un endpoint ausente ya no tumba la suite (guard array-or-not).
- ⏳ P2.1b + P2.2a son código de API → requieren **reinicio** para probar live.

### Added — P2.1b FEFO: captura de lote/caducidad en recepción + lectura de lotes
- **`POST /commercial/inventory/movements`** (`recordMovement`) acepta `lot_code` + `expiry_date`
  (YYYY-MM-DD) en movimientos `'in'` (recepción): upserta el **lote real** en `commercial.stock_lots`
  **antes** del update de stock, y el trigger `trg_rebalance_stock_lots` mantiene el lote `NA`
  balanceado (SUM(lotes)=stock sigue valiendo).
- **`GET /commercial/inventory/stock/:warehouse_id/:product_id/lots`** (gate VER): lotes de un
  producto en un almacén, **orden FEFO** (caducidad ASC, NULLS al final). Habilita P2.2 (alertas
  "por vencer") y P2.5 (mostrar caducidad al vender).
- Build api verde + check en smoke I.5. ⏳ Requiere **reinicio de API** para probar live (código de API).

### Added — P2.1a FEFO: trigger del invariante stock↔stock_lots (+ FEFO-decrement)
- **Trigger `trg_rebalance_stock_lots`** (mig `20260618210000`) `AFTER INSERT OR UPDATE OF quantity ON
  commercial.stock`: mantiene `SUM(stock_lots.quantity) = stock.quantity` para **todos** los writers
  (order flow, ajustes, reconcile, route) **sin tocar código de servicio**. El lote `NA` balancea; una
  baja que excede el buffer NA **decrementa lotes reales FEFO** (caducidad ASC) → ya cubre el grueso
  del consumo FEFO (P2.3).
- Reserved a nivel de lote **diferido** (P2.3): se ponen en 0 los `reserved_quantity` de lotes; el
  reserved sigue intacto en `commercial.stock`. La fase 1 mantiene el invariante de **quantity**.
- **Verificado**: lógica del trigger (aumento / recepción de lote real / baja con decremento FEFO, en
  trx con rollback) + **order flow real** (`http-shipment-hook-fulfill-test` 19/0, el consume escribe
  stock y dispara el trigger) + inventario 22/0. Cambio DB-only (no requiere reinicio de API).
- Siguiente **P2.1b**: captura `lot_code`+`expiry_date` en recepción (`recordMovement('in')`) — sin
  ella todos los lotes son `NA`. Ver `FASES/FASE_FEFO_CADUCIDAD.md`.

### Added — P2.0 Caducidad/FEFO: sub-ledger de lotes `commercial.stock_lots` (ADR-022)
- **Nueva tabla `commercial.stock_lots`** (mig `20260618200000`): descompone `commercial.stock` por
  `(lote, fecha_caducidad)`. `commercial.stock` sigue siendo el **total autoritativo**; invariante
  `SUM(stock_lots.quantity) por (tenant,wh,product) = stock.quantity`. Base para FEFO sin reescribir
  el order flow. RLS forzado, FKs compuestas a tablas reales (`identity.tenants`,
  `commercial.warehouses`, `catalog.products`), unique natural `NULLS NOT DISTINCT`, índice FEFO.
- **Backfill**: 1 lote `NA` (sin caducidad) por cada fila de `stock` (32 835 local) → invariante OK
  desde el día 1, verificado (0 desbalances).
- **Gate del ERP resuelto**: la data sincronizada **no trae caducidad** → P2.1 será **captura en
  recepción** (no sync). Plan P2.0–P2.5 en `FASES/FASE_FEFO_CADUCIDAD.md`. Sin cambios de runtime aún.

### Added — Inventario físico: tolerancia + count-back (P1, cierra fase)
- **Umbral de recuento por folio** (`recount_threshold_pct`, mig `20260618190000`, default 0 = off):
  en `computeDiscrepancies`, items cuyos conteos **coinciden** pero cuya |varianza vs teórico| excede
  `expected·pct/100` **no se auto-resuelven** → quedan en `discrepancy` para forzar recuento/revisión
  antes de mover el saldo (control estándar: out-of-tolerance ⇒ count-back).
- **Frontend**: input "Umbral de recuento %" en el dialog de abrir folio (`/comercial/inventory/sessions`).
- Smoke I.5 cubre el caso fuera-de-tolerancia. **Cierra P1** (A3 ledger + reason-codes + IRA + tolerancia).

### Added — Inventario físico: KPI de exactitud (IRA) + shrinkage por causa (P1)
- **Endpoint `GET /commercial/inventory/counts/ira`** (gate SUPERVISAR): sobre folios
  **reconciliados** (filtros `warehouse_id`/`from`/`to`/`tolerance_pct`) computa **IRA por piezas**
  (items dentro de tolerancia / total), **exactitud por valor** (1 − Σ|Δ|·costo / Σ teórico·costo),
  **variación neta** (merma/sobrante en $), **shrinkage por causa** (desglose por `reason_code`) y
  **IRA por folio**. Tolerancia configurable (default 0 = exacto; benchmark industria meta >97%).
- **Frontend** nueva página `/comercial/inventory/ira` ("Exactitud (IRA)", nav gate SUPERVISAR):
  KPI cards (IRA / exactitud valor / variación neta / folios), filtro por almacén + tolerancia,
  tabla de shrinkage por causa y folios recientes con IRA y merma. Smoke I.5 verifica el shape.

### Added — Inventario físico: reason-codes de varianza (P1)
- **Clasificación estructurada del motivo de varianza** al resolver un item (merma / caducado /
  dañado / robo / error_conteo / error_sistema / devolución / transferencia / encontrado / otro)
  en vez de solo `notes` libre. `caducado` es clave para dulcería. Taxonomía validada a nivel
  servicio (`VARIANCE_REASONS`), extensible sin migración.
- **Migración `20260618180000`**: columna `reason_code` en `inventory_count_items` y propagada al
  **ledger** (`commercial.stock_movements` + `inventory.warehouse_stock_movements`) → analytics/IRA
  podrán agregar shrinkage por causa sin re-joinear los items del folio.
- **Endpoint** `GET /commercial/inventory/counts/variance-reasons` (gate SUPERVISAR) para el dropdown.
- **Frontend**: el dialog "Resolver item" (`/comercial/inventory/sessions/:id`) ahora tiene un
  selector de motivo (`p-select`) + nota de detalle; la clasificación persiste y sobrevive a
  re-computar discrepancias. Smoke I.5 extendido (catálogo + persistencia de `merma`).
- Habilita el siguiente P1 (KPI de IRA + dashboard de shrinkage por causa).

### Added — Inventario físico: ledger auditable + costo en modo `inventory` (P1/A3)
- **Nueva tabla `inventory.warehouse_stock_movements`** (mig `20260618170000`): bitácora append-only
  por SKU, espejo de `commercial.stock_movements` para el mundo `inventory.*` (RLS forzado, grant
  `app_runtime`). La reconciliación de folios en **modo inventory** ya **deja rastro** (`adjust` con
  before/after, `reference_type=inventory_count`) — antes ajustaba `inventory.warehouse_stock` sin
  auditoría.
- **`getProgress.value_at_variance` deja de salir $0 en modo inventory**: costo proxy derivado de
  `inventory.products` (`venta_valor_costo_anual / venta_unidad_anual`), con fallback a
  `catalog.products.cost_base`. El supervisor ya ve el $ en riesgo en folios inventory-source.
- Pendiente: test E2E del modo inventory (el smoke I.5 cubre modo commercial). Ver `FASE_I_INVENTARIO.md` §I.5.

### Fixed — Inventario físico (conteo): endurecimiento de correctness (P0)
- **Freeze integrity guard en `reconcile`**: si el almacén no quedó congelado y hubo movimientos
  de stock desde que se abrió el folio, la reconciliación (set absoluto al físico) **borraba esas
  ventas**. Ahora `reconcile` **bloquea** con error claro si detecta `stock_movements` (ref ≠
  `inventory_count`) desde `started_at` (modo `commercial`).
- **`computeDiscrepancies` ya no revierte resoluciones manuales**: re-correr "calcular
  discrepancias" devolvía items `resolved`→`discrepancy` (bloqueando el reconcile) y pisaba
  overrides del supervisor. Ahora salta los `resolved`.
- **Segregación en el 3er conteo (desempate)**: `submitCount` rechaza `count_3` de quien ya hizo
  `count_1`/`count_2` de ese SKU (antes solo `count_2` tenía segregación).
- Verificado en LOCAL que `inventory_count_items.product_id` es nullable + FK dropeada (modo
  `inventory`). **Pendiente confirmar en prod**. Roadmap P1/P2 en `FASE_I_INVENTARIO.md` §I.5.

### Fixed — Stock: freeze guard en `release` + error claro al entregar sin físico
- **`OrderStockService.release` ahora respeta el freeze guard** (`assertNotFrozen`), igual que
  `reserve`/`consume`. Antes, con un conteo físico congelado (`freeze_movements`), cancelar /
  borrar / reducir-línea de un pedido **sí movía `reserved_quantity`** a media cuenta y falseaba
  la varianza. **Cambio de comportamiento:** esas acciones ahora devuelven **409** mientras el
  almacén tenga un folio de inventario abierto (intencional — el conteo es breve, se reintenta al cerrar).
- **`OrderStockService.consume`**: si el físico no alcanza al entregar (caso preventa, que no
  reserva al confirmar por diseño), rebota con **409 claro** en vez de la violación cruda de
  `CHECK quantity>=0`. No cambia el diseño de preventa.

### Removed — Scanners de alertas huérfanos (split L.7 abortado)
- Borrados `commercial-alerts/low-stock-scanner.service.ts` y `vip-inactive-scanner.service.ts`:
  nunca se registraron como providers (sus `@Cron` jamás corrieron). `AlertsScannerService` queda
  como única fuente de `low_stock` + `vip_inactive` (gateado por `ENABLE_COMMERCIAL_ALERTS`).
  Elimina el footgun de doble emisión. Ver `FASE_L_SCHEMA_REORG.md` §L.7.

### Added — CM.6 · "Productos más frecuentes" por tienda en el Mapa Comercial
- En el detalle de tienda (`/dashboard/commercial-map`), nueva sección con los **productos que más
  aparecen en las capturas de esa tienda** (`daily_captures.exhibiciones[].productosMarcados`):
  ranking por **en cuántas visitas apareció** (+ veces marcado). Backend
  `GET /commercial-map/stores/:id/top-products` (gate `COMMERCIAL_MAP_VER`, store-céntrico
  tenant+zona). Smoke extendido.
- **Decisión de fuente:** se evaluó el ERP Kepler (`ventas.tercero_id`) pero las tiendas auditadas
  **no cruzan** con los clientes de venta del ERP (0/35 por código, ~7/35 por nombre — universos
  distintos: PdV de trade vs terceros-persona del ERP). Por eso la fuente son las **capturas** (sí
  ligadas a la tienda por `store_id`). Se revirtió la maquinaria ERP/Thot explorada (feature
  `customer_product_history` + señal de historial en `thot.suggest`): con 3.4% de linkage no
  aportaba. Thot queda igual.

### Added — CM.5 · Superbuscador de productos en el Mapa Comercial + ruta de la tienda
- **Endpoint `GET /commercial-map/product-presence`** (gate `COMMERCIAL_MAP_VER`): dado `q`
  (contains ILIKE sobre nombre/sku/barcode) **o** `product_ids` (CSV, ej. del matcher IA),
  devuelve las **tiendas y las visitas** donde esos productos aparecen en
  `exhibiciones[].productosMarcados` (contención JSONB `@>`, GIN-friendly). Store-céntrico
  (tenant + zona, sin filtro own/team); cada visita trae `matchedProducts`. Coord híbrida.
- **Frontend**: superbuscador en `/dashboard/commercial-map` con toggle **"Inteligente"** —
  ON interpreta el texto vía matcher IA Fase K (`/api/ai/products/match-ai`, Voyage) → product_ids
  → presencia, con **fallback automático a contains** si la IA no da match o no está disponible.
  Al buscar, el **mapa se filtra** a las tiendas con el producto (resaltadas) y un **panel de
  resultados** lista cada tienda (con su ruta) → visitas donde apareció (folio/fecha/vendedor +
  productos que matchearon); clic en tienda abre su historial; botón "Limpiar".
- **Ruta de la tienda** ahora en la info: `getStoreHistory` devuelve `store.ruta` (join a
  `catalogs`), mostrada en el detalle de la tienda y en el header del dialog de visita.
- Smoke `http-commercial-map-test.js` extendido (product-presence por ids y por `q` + ruta).
  **Requiere reinicio de la API** para registrar la ruta nueva (HMR no re-registra rutas).

### Added — Fase I.4 · Asignación de personas a un folio de inventario
- **Permiso `COMMERCIAL_INVENTORY_ASIGNAR`** (enum BE+FE, ability.factory, permission-meta, seed + backfill a superadmin/admin/supervisor). Quién puede asignar contadores/supervisores a un folio.
- **Migración `20260615160000`**: `commercial.inventory_count_assignments` (count_id, user_id, assignment_role counter|supervisor, assigned_by; RLS; FK cascade al folio).
- **Backend** (endpoints en `/commercial/inventory/counts`): `GET assignable-users?role=` (usuarios cuyo rol tiene CONTAR/SUPERVISAR), `GET :id/assignments`, `POST :id/assignments` (reemplaza la lista de un rol), `GET mine` (folios que el contador puede contar). **Opt-in por folio**: si un folio tiene contadores asignados, `submitCount` solo deja contar a ellos; si no tiene ninguno, queda abierto (compat). El contador ahora ve solo sus folios (o los abiertos).
- **Frontend**: en el detalle del folio (`/comercial/inventory/sessions/:id`), panel con dos MultiSelect — **Contadores** y **Supervisores** asignados (guarda al cerrar el panel). Visible solo con permiso ASIGNAR. La página de Conteo usa `mine` (cada contador ve lo que le toca).

### Added — Reporte de stock muerto (capital parado)
- **Backend** `GET /commercial/analytics/dead-stock?warehouse_id=&limit=` (gate ORDERS_VER): existencia > 0 sin venta en **90 días** (`sales_units_90d = 0` estricto — NULL = rotación no computada, no se reporta) → capital parado al costo, items + resumen por almacén. Usa `catalog.products` (la vista public no expone rotación). Migración `20260615150000` agrega `sales_units_90d`; el feed de rotación Kepler ahora lo persiste (ventana 90d evita falsos positivos estacionales como el aguinaldo navideño que 30d marcaba). KEPLER-03: **473 SKUs / $1.22M parado**.
- **Frontend** página `/comercial/dead-stock` ("Stock muerto", nav, icono alerta): KPIs (capital parado / SKUs), resumen por almacén, tabla densa (almacén/SKU/producto/marca/rotación/existencia/costo/capital) con filtro por almacén y paginación. Accionable para compras (liquidar / dejar de surtir).

### Added — Write-back de Fase I → formato de ajuste Kepler (export)
- Endpoint `GET /commercial/inventory/counts/:id/kepler-export` (gate RECONCILIAR): toma un folio de inventario **reconciliado** y emite el ajuste en formato Kepler — sucursal (de `KEPLER-NN`), y por cada varianza: `InvOut` (merma, variance<0) / `InvIn` (sobrante, variance>0) con cantidad, unidad, costo y valor; summary merma/sobrante/neto. Mapeo descifrado de `doctype`: PhysInv (ND3001) / InvIn (NA2002) / InvOut (ND0502). **No escribe en el ERP** (producción, header 200 cols, import desconocido) — produce el documento para importar/capturar. Validado: AGUA −4→InvOut $9.93, CHURRO +5→InvIn $22.68.

### Added — Proveedores reales de Kepler → suppliers + products.supplier_id
- **Migración `20260615140000`**: tabla `catalog.suppliers` (code/name, RLS, FK tenant) + `catalog.products.supplier_id` (FK `ON DELETE SET NULL (supplier_id)` PG15+). El `category_id` previo era inconsistente (a veces proveedor real, a veces depto genérico) → queda deprecado, no se toca (usado en thot/pricing/analytics); la taxonomía real ya vive en department/product_line.
- **Importer** `import-kepler-suppliers.js`: siembra **542 proveedores** desde `kdig` y enlaza **7,221 productos** a su proveedor real vía `kdii.c3`. Top: MONDELEZ 297 / FÁBRICAS SELECTAS 294 / DE LA ROSA 246. Verificado: AGUA→NUEVA WALT MART (antes mal como "ABARROTES"), KINDER→FERRERO, CHURRO→JUANA AYALA. (Costo de compra disponible en `kdpv_prov_prod` si se requiere; cost_base ya está poblado.)

### Added — UoM real + taxonomía de categorías de Kepler → products
- **Mapeo descifrado** de catálogos de dimensión Kepler: `kdid`=unidad (PZA/PAQ/CJA/KG), `kdie`=departamento (DULCES/BEBIDAS/BOTANAS), `kdif`=línea (CHOCOLATE PASTELITO…), `kdig`=proveedor. Columnas: `kdii.c11`=unidad, `c4`=depto, `c5`=línea, `c3`=proveedor.
- **Migración `20260615130000`**: + `catalog.products.department` + `product_line` (no toca `category_id`, que en realidad = proveedor).
- **Importer** `import-kepler-uom-categories.js`: corrige `unit_sale`/`unit_purchase` desde Kepler (**7,795 productos** — el sync previo había defaulteado casi todo a PZA; ahora PAQ 5,848/PZA 4,831/KG 189, realista → **cierra el hueco de UoM de Fase I**) y puebla department/product_line (**2,210** con taxonomía real; el resto es "NO APLICA" en Kepler). Verificado: GALL ANIMALITOS=KG, Kinder=DULCES/CHOCOLATE PASTELITO, Agua=BEBIDAS/AGUA EMBOTELLADA.

### Added — Rotación real de Kepler → Thot (catalog.products)
- **Análisis** `database/scripts/kepler-rotation-analysis.js` (read-only): descifra ventas en `kdm1`/`kdm2` (doc venta c2='U' c3='D' c4=10, 149k tickets POS). Top movers, **stock muerto** (existencia sin ventas → capital parado al costo) y slow movers por días de inventario. Suc 03 90d: **503 SKUs muertos = $567,877 parados**.
- **Feed a Thot** `database/importers/kepler/import-kepler-rotation.js` (dry-run/apply): puebla `catalog.products.rotation_tier` (alta/media/baja por percentil de unidades 90d; **dead=null** → peso mínimo) + `sales_units_30d` con venta real. **3,855 productos** (alta 856 / media 1215 / baja 1307 / dead 477). Thot usa estos campos sin cambio de código → la rotación real y el stock muerto entran al score; verificado AGUA/CHURRO/Kinder=alta. (Branch 03 como referencia; sync vivo pendiente.)

### Added — Precios de venta reales de Kepler → product_prices
- **Importer** `database/importers/kepler/import-kepler-prices.js` (dry-run/apply): fuente `md.kdpv_prod_util` (9,036 SKUs con precio escalonado por presentación + tiers de volumen). Decisión: el gradiente de precio por cliente son los **tiers de volumen** (no la presentación). Por SKU se toma su presentación principal (PZA>PAQ>CJA>KG>BTO) y sus tiers ordenados caro→barato se mapean **tier 0 → P1 (público) … → P4 (mayorista)**, rellenando listas faltantes con el mejor precio. **7,617 SKUs match, 30,468 upserts P1-P4**. Verificado: CHURRO P1 $5.35(min3)/P2 $5.08(min5)/P3-P4 $4.99(min10). tax_rate=0.16 asumido (verificar si Kepler ya incluye IVA).

### Fixed — FKs compuestas ON DELETE SET NULL anulaban tenant_id (bug sistémico)
- Migración `20260615120000`: **31 FKs** en commercial/logistics/trade tenían `FOREIGN KEY (tenant_id, X) REFERENCES ... ON DELETE SET NULL`, que al borrar el padre intentaba poner NULL en `tenant_id` (NOT NULL) → crash (vivido al borrar pedidos: `shipments`). Recreadas con la forma de Postgres 15+ `ON DELETE SET NULL (X)` que anula **solo** las columnas no-tenant. Migración dinámica + idempotente (no toca las ya corregidas). 0 FKs buggy restantes.

### Changed — Limpieza de datos inventados (deja solo data real) + import logística Kepler
- **Comercial** (`database/scripts/cleanup-invented-data.js`, transaccional dry-run/apply): borradas 1,397 filas inventadas — 354 pedidos dev (PD-*) + líneas/historial, 22 clientes TST-/DEMO- + refs (recommended_baskets/customer_360/commerce_signals), 26 productos + 5 marcas testdata (B.3.2), almacenes `INV-TEST-WH` y `TRUCK-*`, stock seed de MD-CENTRAL, 2 folios smoke. Conserva catálogo real, 2,925 clientes reales, listas de precio reales, **MD-10/30/50/CEDIS** (stock real) y **KEPLER-03**. Desliga `shipments.order_id` (FK compuesta ON DELETE SET NULL anularía `tenant_id` NOT NULL — bug de schema esquivado).
- **Logística** (`database/scripts/logistics-clean-and-import-kepler.js`): wipe de data de prueba (241 embarques EMB-* + cascade guías/gastos/checklists/fotos, 37 choferes TEST, 39 vehículos TEST, 27 periodos de nómina, "Ruta Local Demo") + **import real de Kepler**: 8 choferes (nombres reales), 11 vehículos (placas reales), 27 rutas nuevas (25 de las 52 ya existían del import del Excel → confirma que son las rutas reales). Conserva rutas reales del Excel + config_finance. Resultado: 8 choferes / 11 unidades / 123 rutas / 0 embarques.

### Added — ERP Kepler: dump restaurado + descifrado + importer de stock real
- **`database/BACKUP.sql`** (228 MB, pg_dump custom-format de la DB `md_03` schema `md`) restaurado a Postgres local (`localhost:5433`, DB `md_03`). Es el ERP **Kepler** de Mega Dulces, **esquema ofuscado** (tablas `kdXX`, columnas `c1..cN` sin nombres). Mapeo inferido desde datos documentado en [`docs/IMPLEMENTACION/ERP_KEPLER_SCHEMA.md`](docs/IMPLEMENTACION/ERP_KEPLER_SCHEMA.md): `kdii`=maestro productos (c1=SKU, c2=nombre, c7=barcode), `kdil`=existencia por sucursal (c9), `kdik`=valuación (costo=c9/c6), `kdm1/kdm2`=documentos (incl. ajustes de inventario — no hay tabla de conteo físico dedicada). 2 sucursales: 02 (vieja) y 03 (viva).
- **Importer** `database/importers/kepler/import-kepler-stock.js` (dry-run por defecto, `--apply` escribe, idempotente): join `kdii.c1 == public.products.sku` (97% overlap), existencia `kdil.c9`, costo `kdik`. **Aplicado**: sucursal 03 → almacén nuevo **KEPLER-03**, **3,936 SKUs / 1,127,490 unidades** de stock real. La Fase I ya puede contar contra cifras verdaderas. Costos validados como realistas (Agua $2.52, Kinder Delice $11.28).

### Added — Fase I · Inventario físico (I.0 + I.1 backend): conteo cíclico/total por almacén
- **Digitaliza "hacer inventario"** (marbeteo + doble conteo + recaptura del checador) como sesión con **conteo ciego**, **doble conteo** por contadores distintos y **reconciliación auditable**. Jerarquía: contador (cuenta a ciegas) → supervisor (analiza/resuelve) → reconciliador/jefe (autoriza el ajuste del saldo = del dinero).
- **Schema** (mig `20260613100000`, `commercial.*`): `inventory_counts` (folio INV-YYYY-NNNNN, state machine open→counting→review→ready_to_reconcile→reconciled|cancelled, índice parcial único **un folio abierto por almacén**), `inventory_count_items` (`expected_qty` = snapshot del teórico **oculto al contador**, `count_1/2/3`+`counted_by_*`, `final_qty`, `variance`, status), `inventory_count_sequences`. RLS forzado + grants `app_runtime`. FK tenant→`identity.tenants`, producto→`catalog.products` (los `public.*` son vistas tras la reorg).
- **Permisos** `COMMERCIAL_INVENTORY_{CONTAR,SUPERVISAR,RECONCILIAR}` (enum BE+FE, `ability.factory` subject `commercial_inventory`, seed de roles + backfill idempotente `20260613110000`). **Requiere re-login**.
- **Backend** `InventoryCountService`+`InventoryCountController` (`/commercial/inventory/counts`): open+snapshot, count (ciego, barcode o product_id, segregación count_2≠count_1, sobrantes), progress (cobertura %, discrepancias, **valor $ en riesgo**, productividad por contador), items, compute (discrepancias + count_3 rompe empate), resolve, reconcile (ajusta stock + movimientos `adjust` reference_type=`inventory_count` en una trx), cancel.
- **3 controles críticos**: (1) **coverage guard** — reconcile rechaza SKUs con `count_1 IS NULL` (un no-contado nunca se trata como cero → no se destruye stock real); (2) **freeze guard cross-module** — `assertWarehouseNotFrozen` en `orders.reserveStockInline/consumeStockInline` + `adjustStock/recordMovement`: con folio abierto y `freeze_movements`, se bloquea mover stock (el teórico no deriva); (3) varianza contra `quantity` (on-hand) respetando el CHECK `quantity >= reserved`.
- **Smoke** `test-newdb-inventory-count.js` (DB-direct, `app_runtime`, RLS) **13/13 ✓**, en `run-all-tests.js`.
- **I.2 frontend contador** — página `/comercial/inventory/count` (mobile-first para handheld HID): selector de folio, barra de progreso **ciega** (`GET /count-progress`, sin teórico/varianza), captura código→cantidad→Enter de un gesto, feed de últimos conteos con badge de slot. Nav "Conteo físico". Backend: endpoint count-progress ciego (gate CONTAR), submit devuelve sku/nombre para confirmar el SKU escaneado, y corrección same-counter (re-escaneo del mismo contador sobreescribe su count_1; solo otro contador dispara count_2).
- **I.3 frontend supervisor** — `/comercial/inventory/sessions` (lista + dialog abrir folio: almacén, tipo, toggles congelar/doble-ciego) y `/comercial/inventory/sessions/:id` (KPIs cobertura/sin-contar/discrepancias/**valor $ en riesgo**, calcular discrepancias, **reconciliar** con confirmación gate RECONCILIAR, cancelar, filtro Todos/Discrepancias/Pendientes, tabla de items teórico/C1/C2/C3/final/varianza, dialog resolver item con motivo). Nav "Folios inventario". **Fase I frontend+backend completos (beta scope)**; falta validación visual.

### Fixed — /dashboard/routes responsive en móvil
- La tabla densa "Visitas y tiempos" (8 columnas) no contenía su overflow → empujaba el ancho de **toda** la página en teléfono (KPIs/mapa/header se renderizaban a ~660px, cortados y con scroll horizontal global). Ahora las tablas tienen **scroll horizontal propio** (`overflow-x:auto` + `min-width` solo en la tabla ancha), así la página vuelve al ancho del viewport y la tabla se navega con swipe.

### Added — Mapa Comercial (CM): exhibidores Mega Dulces vs competencia en mapa + historial por tienda
- **Módulo `commercial-map`** (`libs/trade`, 2 endpoints read-only sobre `daily_captures.exhibiciones` JSONB — la fuente VIVA; las tablas `visits`/`exhibitions` son código muerto): `GET /commercial-map/stores` (tiendas con **coord híbrida** `COALESCE(stores.lat, última GPS de captura)` + conteo propio/competencia/sin-clasificar derivado del flag `perteneceMegaDulces` + `presence` + `unlocatedCount`) y `GET /commercial-map/stores/:id/history` (historial de visitas con exhibiciones separadas **Mega Dulces vs Competencia**: foto, concepto, ubicación, nivel, score, productos). Connection legacy + filtro `tenant_id` explícito (**no** `TenantKnexService`). Scoping **store-céntrico**: el historial y los conteos traen **todas las visitas de la tienda** (acotado por tenant + zona del requester, que ya controla qué tiendas ve) — sin filtro own/team de usuario, que ocultaría visitas de otros reps en la misma tienda.
- **Permiso `COMMERCIAL_MAP_VER`** (enum BE+FE, `ability.factory` subject `commercial_map`+action `read`, `AppSubject`). Seed de roles (superadmin/admin/supervisor/jefe_marketing) + backfill idempotente `20260613100000` (`-> 'KEY' IS NULL`). **Requiere re-login** (el permiso vive en el JWT).
- **Página `/dashboard/commercial-map`** ("Mapa Comercial", nav Trade, icono `pi-map-marker`): superficie Operations (densa, master-detail). Mapa Leaflet con marcadores coloreados por presencia (🟢 Mega Dulces · 🔴 competencia · 🟠 ambas · 🔵 sin clasificar · ⚪ sin visitar), leyenda con conteos + badge "N sin ubicar", filtros de presencia/zona/búsqueda (client-side) + **selector de período** (Todo/Hoy/Semana/Mes/Personalizado con datepicker, estilo /reports — recarga del server). Click en tienda → panel con KPIs + **lista de visitas**; clic en una visita → **ventana (`p-dialog`) con su descripción completa** (exhibiciones con foto, chips propio/competencia, productos, ubicación/nivel, score — estilo Seguimiento); clic en la foto → **lightbox ampliado**. El mapa Leaflet va aislado (`isolation`) para no pisar el sidebar.
- **`MapComponent`** (`shared/components/map`): nuevo `output markerClick` + campo opcional `id` en `MapMarker` (no-breaking; routes-analysis sin cambios).
- **Smoke `http-commercial-map-test.js`** registrado en `run-all-tests.js`.

### Added — Modo Vendedor v2 · V.0: cartera del vendedor + orden de visita
- **`commercial.vendor_sales_routes`** (mig `20260610100000`): qué rutas de venta (`sales_route`) cubre cada vendedor — el `supervisor_ventas` asigna. La cartera del vendedor = clientes de esas rutas. + **`customers.visit_sequence`**: orden de visita del cliente dentro de su ruta. FK a `identity.*` (las tablas reales; `public.users/tenants` son vistas), RLS, idempotente.
- **Módulo `commercial-vendor-routes`** (7 endpoints): rutas+conteo+asignados, vendedores asignables, clientes-por-ruta, asignar/quitar (idempotente), "mi cartera" (vendedor), ordenar (`visit_sequence` 1..N). Gestión gateada por `USUARIOS_ASIGNAR_RUTA` (lo tiene `supervisor_ventas`), lectura por `COMMERCIAL_CUSTOMERS_VER` — sin permiso nuevo (evita el riesgo de ability.factory).
- **Página `/comercial/cartera`** ("Cartera de ventas"): el supervisor asigna/quita rutas a vendedores y **ordena la secuencia de visita** de los clientes de cada ruta con botones subir/bajar (PrimeNG 18 no expone `reorderableRows`). Ítem en el nav comercial.

### Added — Modo Vendedor v2 · V.1: backend de pedidos por cartera + ciclo de vida del vendedor
- **`GET /commercial/orders` con filtros nuevos**: `?statuses=pending_approval,confirmed` (multi-status CSV), `?mine=true` (restringe a clientes de la cartera del vendedor del JWT vía `vendor_sales_routes`) y columna calculada **`is_preventa`** (`true` si el pedido lo originó el cliente desde el Portal B2B — su user es `customer_b2b`; `false` si lo tomó un vendedor en campo). Base de "Por entregar".
- **`GET /commercial/customers?mine=true`**: cartera del vendedor (clientes de sus rutas) ordenada por `visit_sequence` (nulls al final). Base de "Clientes por ver" / "Pedido nuevo".
- **`VendorService`**: métodos `myCartera()`, `pendingDeliveries()`, `approve()` (pending_approval→confirmed), `fulfill()` (confirmed→fulfilled) + tipo `VendorOrder` (Order enriquecida con `is_preventa`/`customer_name`/`route_name`).
- **Ciclo de pedido para roles de campo**: el vendedor ahora gestiona su cartera de punta a punta. Seed `FIELD_PERMS` + backfill `20260610110000` activan `COMMERCIAL_ORDERS_CONFIRMAR` / `FULFILL` / `CANCELAR` en `colaborador` / `ejecutivo` / `vendedor` (idempotente, merge guardado por `@>`). Las 3 keys ya estaban mapeadas en `ability.factory`. **Requiere re-login** (el permiso vive en el JWT).

### Changed — Modo Vendedor v2 · V.2: el modo vendedor reorganizado en 4 apartados
- **Nuevo bottom nav del modo vendedor**: **Pedido** · **Por entregar** · **Por visitar** · **Buscar** (antes Clientes / Mi día / Cierre). "Mi día" y "Cierre de ruta" pasan a accesos en el header (no pierden alcance). Default de `/vendor` → `new-order`. Entradas a Modo Vendedor (nav admin, landing de proyectos, links internos) repuntadas a `/vendor/new-order`; `/vendor/customers` queda como redirect a `search`.
- **Pedido nuevo** (`/vendor/new-order`): la cartera del vendedor (clientes de sus rutas asignadas) **en orden de visita** (`visit_sequence`, badge numerado), con filtro y tag de ruta. Tocar un cliente abre la toma de pedido. Empty state guía a pedir cartera al supervisor + fallback a Buscar.
- **Buscar** (`/vendor/search`): búsqueda sobre **todo** el catálogo de clientes (esté o no en la cartera) — es el `vendor-customers` previo, retitulado.
- **Por entregar** (`/vendor/pending`, V.3) y **Por visitar** (`/vendor/visits`, V.4): apartados creados con placeholder "Disponible pronto" — el backend de Por entregar (`pendingDeliveries`/`approve`/`fulfill`) ya existe (V.1).

### Added — Modo Vendedor v2 · V.3: apartado "Por entregar" operativo
- **`/vendor/pending`** ya no es placeholder: lista los pedidos pendientes de la cartera del vendedor (preventa del Portal B2B + de campo), en dos secciones — **Por aprobar** (`pending_approval`) y **Listos para entregar** (`confirmed`). Cada pedido muestra cliente, folio, total, hora, tag de origen (**Preventa**/**Campo** según `is_preventa`) y expande sus líneas bajo demanda (`orderById`).
- **Acciones con confirmación**: **Aprobar** (`pending_approval → confirmed`) y **Marcar entregado** (`confirmed → fulfilled`, descuenta inventario), cada una con `ConfirmDialog` + toast de resultado y recarga de la lista. Botón con `loading` mientras la operación está en vuelo; errores del backend se muestran en el toast.

### Added — Modo Vendedor v2 · V.4: apartado "Por visitar" + check-in (cierra v2)
- **`commercial.vendor_visits`** (mig `20260610120000`): cada fila = un check-in explícito del vendedor a un cliente (`visited_at`, `notes`, `latitude`/`longitude` nullable para geo-check-in futuro). FK a `identity.*` (tablas reales) + a `commercial.customers (tenant_id, id)`, RLS forzado, grants `app_runtime`, idempotente.
- **Backend** (`commercial-vendor-routes`): `GET /coverage` (cobertura del día — la cartera anotada con `visited_today` calculado en **TZ MX** + última visita; gateado por `COMMERCIAL_CUSTOMERS_VER`) y `POST /check-in` (registra la visita; gateado por `VISITAS_REGISTRAR`, que los roles de campo ya tienen). Smoke RLS E2E OK (cartera → check-in voltea el flag).
- **`/vendor/visits`** ya no es placeholder: la cartera en orden de visita con barra de progreso ("X de N visitados hoy"), check-in por cliente (optimista + toast) que pinta el cliente como visitado, y atajo a tomar pedido. `VendorService.coverage()`/`checkIn()` + tipo `CoverageCustomer`.

### Added — Modo Vendedor v2 · V.5.0: backend para "Mi ruta" (interfaz única client-centric)
- **`commercial.orders.requested_delivery_date`** (date, nullable; mig `20260610130000` + índice parcial): fecha de entrega agendada para el "pedido futuro". `createDraft`/`updateDraft` la aceptan (validan `YYYY-MM-DD`); `list()` la devuelve.
- **`POST /commercial/orders/:id/deliver-now`** (autoventa — "pedido al instante"): fast-forward a `fulfilled` en **una transacción** desde `draft`/`pending_approval`/`confirmed` (reserva + congela + confirma + consume stock, reusando `fulfillInTransaction`). Gateado por `COMMERCIAL_ORDERS_FULFILL`. Consume del almacén central (beta); la conciliación del camión vive en los tickets del cierre.
- **`GET /commercial/vendor-routes/home`**: feed del home "Mi ruta" — la cartera del vendedor (orden de visita) anotada de **un solo fetch** con `visited_today`, `ordered_today` (TZ MX), `last_visit_at` y `pending_orders[]` (total + `is_preventa` + fecha de entrega) + `pending_count`/`pending_total`/`has_preventa_pending`. Smoke RLS E2E OK (campo vs preventa distinguidos).
- **`VendorService`**: `home()`, `deliverNow()` + `updateDraftHeader` acepta `requested_delivery_date` + tipos `HomeCustomer`/`HomePendingOrder`.

### Changed — Modo Vendedor v2 · V.5.1: home "Mi ruta" client-centric (una sola pantalla)
- **El modo vendedor es ahora una sola pantalla**: `/vendor/route-home` ("Mi ruta") = la cartera en orden de visita; cada cliente abre un **bottom-sheet** con todas sus acciones sin salir de la lista — **Ver pedido pendiente · Pedido al instante · Pedido futuro · Marcar visita · Registrar ticket · Capturar exhibición · Llamar/WhatsApp**. Consume `home()` de un fetch. Chips por cliente (preventa pendiente · N por entregar · pedido hoy · visitado), barra de progreso de visitas y filtro client-side.
- **Check-in en el sheet** (reusa `checkIn`, optimista). Contacto directo (tel / wa.me). "Capturar exhibición" enlaza a `/dashboard/vendor-capture` (fusión profunda en V.5.3).
- **Nav colapsado**: bottom nav a **2** (Mi ruta · Cierre) + **Buscar** y **Mi día** como íconos en el header. Las pestañas Pedido/Por entregar/Por visitar se vuelven el home + sus rutas siguen vivas (las usa el sheet). `/vendor` y `/vendor/new-order` redirigen a `route-home`; se eliminó el componente `vendor-new-order` (superado).

### Changed — Modo Vendedor v2 · Rediseño móvil "Mercado" (R.1: Mi ruta)
- **`/vendor/route-home` rediseñada** mobile-first sobre el design system Mercado (preview en `designs/vendor-redesign-20260610/`): **hero full-bleed** con gradiente cálido (sangra el gutter del shell), **anillo de progreso** (visitados/total) y **KPIs del día** (pedidos · vendido · por entregar, mono tabular). El banner de reorden NBA pasa a **identidad ember** (✦). Las cards de cliente ganan **riel de estado** a la izquierda (verde visitado · ámbar preventa · sunset reordenar · stone pendiente), chips tokenizados (se eliminó el hex inline), y **FAB sunset "Pedido"** en la zona del pulgar que abre el próximo cliente. El bottom-sheet ahora destaca la acción primaria ("Pedido al instante") como botón sunset; sheet entra con `--spring`. `prefers-reduced-motion` respetado.
- **Motion tokens** en `tokens.css`: `--ease-standard`, `--ease`, `--spring` (reuso global). Toda la lógica NBA (`nbaDue`/`recordSignal`/dueIds/onlyDue) + check-in + sheet preservada.
- **R.2 · Tomar pedido** rediseñado + modos cableados: header con chip de modo, catálogo en filas livianas con **"+" de 44px** (badge de cantidad en carrito), sección de carrito con **steppers** + totales, y **cart pill flotante** (zona del pulgar) como CTA único. **Instante** (autoventa) → `POST /orders/:id/deliver-now` ("Cobrar y entregar", descuenta stock); **futuro** → date-picker + `requested_delivery_date` y confirma ("Agendar pedido"). Háptico en add/stepper/confirm. Se quitaron `p-table`/`p-inputNumber`/`p-card`/`p-selectButton` (markup propio liviano).
- **R.3 · Pedido confirmado** (`/vendor/order-success`): pantalla de éxito que celebra al instante (datos por queryParams, sin fetch) — **check dibujado** (SVG stroke) + pop spring + **confetti** amarillo (sello) + háptico de éxito. Verde "¡Entregado!" (instante) / info "¡Pedido agendado!" (futuro, con fecha). CTA en zona del pulgar: **enviar ticket por WhatsApp** (mensaje pre-armado) + volver a la ruta. `take-order` navega acá tras cobrar/agendar. `prefers-reduced-motion` desactiva confetti/animación.
- **R.4 · Notificaciones** (`/vendor/notifications`) + **bell en el header**: inbox derivado (sin backend persistente todavía) que agrega lo accionable de endpoints existentes — **preventa pendiente** (→ aprobar), **clientes para reordenar hoy** (NBA, → tomar pedido) y **pedidos de hoy** — agrupado, con íconos de tipo (warn/ember/ok) y tap-to-act. Badge en vivo diferido (requiere conteo liviano / backend de notificaciones).
- **R.5 · re-skin de pantallas secundarias**: **Mi día** ahora con mini-hero + KPIs (mono tabular) y filas de pedido con chip de estado tokenizado (Spanish labels). **Buscar** con search pill + filas livianas con avatar de iniciales (sin `p-card`). *Por entregar* / *Por visitar* ya usaban el lenguaje de chips/riel (V.3/V.4); *Cierre de ruta* conserva su diseño propio. Cierra el rediseño móvil del Modo Vendedor (R.1–R.5).
- **R.6 · pulido: esquinas + colorimetría de /vendor-capture**: el shell del vendedor sube los radios (`--r-sm..2xl`) vía override scopeado → **todas las esquinas con token quedan más redondeadas** (look moderno) en cascada a todo el módulo; + bump de los radios hardcodeados (badges/avatares/botones). **Colorimetría golden** tomada de `/vendor-capture` (fusionado al shell como "Capturar"): los heroes pasan de sunset rojo a **golden-orange** (`#F68F1E`, vía `--v-hero-grad`), el seq badge a tinte marca/ámbar (`--v-seq-bg/fg`). Sunset `--action` se conserva solo en CTAs sólidos (contraste de texto blanco).

### Fixed — Supervisor de ventas asignable a vendedores (no solo colaboradores)
- **`/admin/users`**: el selector "Jefe / Supervisor de Ventas" solo aparecía (y solo se conservaba) para el rol `colaborador`; al elegir `vendedor` o `ejecutivo` se ocultaba y el `supervisor_id` se forzaba a `null`. Ahora aplica a todos los roles de campo (`colaborador`, `ejecutivo`, `vendedor`) — vía `isSupervisedRole()` — tanto en el form como en el listado (desktop + mobile).
- **Efecto colateral resuelto en Asignación diaria**: esa pantalla arma el equipo con `users WHERE supervisor_id = <supervisor logueado>`. Como los vendedores nunca podían tener `supervisor_id`, no aparecían en el equipo de su supervisor de ventas. Con el supervisor ya asignable, el vendedor aparece y el supervisor puede asignarle su ruta diaria. (Backend ya soportaba `supervisor_id` + `/users/supervisors` + `findBySupervisor`; el hueco era solo de UI.)

### Fixed — Ventas (comercial): sesión de corrección de bugs
- **Televenta dashboard 100% roto** (`dashboardMetrics`): consultaba columnas inexistentes en `commercial.lead_reservations` (`status`, `user_id` → 500 siempre) y filtraba `call_logs.outcome` por valores en español (`pedido_tomado`…) que el CHECK prohíbe (métricas en 0). Alineado al schema real (`released_at IS NULL`, `reserved_by_user_id`) y al enum canónico (`sale`/`no_answer`/`callback_scheduled`/`no_sale`).
- **`adjustStock` no atómico**: se partía en 3 transacciones (read → recordMovement → overwrite) → saldo corrupto ante crash y lost-update concurrente. Ahora un único `tk.run` con `forUpdate`, valida `new_quantity >= reserved` y registra `quantity_before/after` correctos.
- **`reserveLead` 409 espurio**: no pre-liberaba reservas vencidas antes del INSERT → chocaba el UNIQUE parcial sobre leads que la cola sí ofrece. Ahora pre-libera (`released_reason='expired'`) en el mismo trx.
- **`bulkUpsertPrices` no avanzaba `updated_at`**: el `.merge()` lo referenciaba pero las rows no lo seteaban. Ahora cada row setea `updated_at: now()`.
- **Fechas por defecto en UTC, no MX** (route-tickets + vendor-sales): `toISOString().slice(0,10)` ocultaba capturas de 18:00–23:59 MX. Ahora usan `todayMx()`/`toMxDateKey()`.
- **Desvincular tienda de cliente no persistía**: tanto el `linkStore` inline como el dialog de edición (`save()`) mandaban `store_id: undefined` (backend lo trata como "sin cambio"). Ahora ambos mandan `null`, consistente con `linkRoute`. Quitado de paso el método muerto `onToggleActive()`.
- **KPIs de pedidos sobre la página visible**: hero "Ventas en la ventana" y counts de history reflejaban solo la página. El backend `list` ahora devuelve `total_amount` agregado del filtro y el front usa `statusCounts()` reales.
- **Fugas RxJS**: 25 `.subscribe()` en 6 componentes de `/comercial` sin `takeUntilDestroyed` (incl. streams permanentes `route.data` y `search$`). Todas envueltas.

### Changed — Alertas realtime desactivadas
- **Apagadas todas las alertas realtime del Command Center** (decisión de producto): el scanner cron `AlertsScannerService` (emitía `low_stock_critical` + `vip_inactive` cada 5 min) queda gateado por `ENABLE_COMMERCIAL_ALERTS` (default off); el Command Center ya no abre el socket de alertas ni muestra el feed/toasts en vivo (se limpió el feed, el tag "En vivo" y los helpers huérfanos). Se mantienen el panel informativo "Stock bajo" del dashboard (endpoint analytics) y el resto del dashboard. Reactivable con `ENABLE_COMMERCIAL_ALERTS=true`.

### Added — Cliente comercial: WhatsApp + ruta de venta estructurada
- **Columna `whatsapp`** en `commercial.customers` (normalizada a E.164, índice único parcial por tenant) — migración `20260609140000` idempotente (local+prod). El backend normaliza a `+52…` en create/update y mapea colisiones (23505) a 409; el front la expone en el dialog y en la ficha del cliente, en lugar del viejo selector de tienda.
- **Columna `sales_route`** (ruta de venta): la ruta que el ERP traía como texto en `notes` ("Ruta: RUTA 21") se migró a un campo estructurado. Script `backfill-customer-sales-route.js` pobló **2.859 clientes** (12 rutas). La columna "Ruta" de `/comercial/customers` ahora muestra `sales_route`. (`route_id` sigue apuntando a logística, hoy vacía — son rutas distintas.)

### Changed — /comercial/customers alineado al vínculo tienda↔cliente
- **Vínculo de tienda ahora es de solo lectura**: se quitó el selector inline "Vincular tienda" de la tabla y el campo editable del dialog (cada tienda nace como cliente al alta; el vínculo no se edita a mano). Se muestra como chip read-only. Eliminados los métodos/signals huérfanos (`linkStore`, `linkRoute`, `routeName`, etc.).
- **Backend blindado**: `store_id` es inmutable vía PATCH (no se puede cambiar ni quitar un vínculo existente — `BadRequestException`); violaciones de unicidad devuelven **409** con mensaje claro en vez de 500.
- **Hallazgo (workflow de análisis)**: el modelo NO es 1:1 en los datos — hay **2.941 clientes del ERP** vs **36 tiendas** de Trade. Los 19 STR- del bulk previo no duplican clientes ERP (tiendas piloto distintas); quedan 5 homónimos internos del ERP para revisión manual.

### Added — Modelo 1:1 tienda↔cliente (Ventas)
- **Cada tienda de Trade Marketing es un cliente comercial.** `database/scripts/promote-all-stores-to-customers.js` (dry-run default, `--apply` para escribir): promueve en bulk todas las tiendas activas sin cliente a `commercial.customers`, idempotente, reusando la lógica de `createFromStore` (code `STR-…`, name = nombre de la tienda, price_list default). Poblado inicial: **36/36 tiendas activas ↔ clientes**.
- **Auto-provisión al alta**: al crear una tienda en Trade (`StoresService.create`) se crea automáticamente su cliente comercial, vía el nuevo Port `CUSTOMER_PROVISIONING_PORT` (inversión de dependencia trade→commercial en el composition root, `@Optional` para no acoplar la app legacy, best-effort post-commit — si falla no rompe el alta de la tienda).
- Migración `20260609120000`: índice único parcial `commercial.customers (tenant_id, store_id) WHERE store_id IS NOT NULL AND deleted_at IS NULL` — garantiza el 1:1 (un store, un cliente activo).

### Added
- `database/scripts/README.md` — mapa de 92 archivos agrupado en 11 familias con estado 🟢🟡🔵⚫.
- `.env.example` — +18 vars que estaban undocumentadas (cutover, vector, tests E2E, S3, etc.).
- `package.json` — npm scripts `regression`, `import:commercial`, `seed:testdata` (loop completo), `cutover:preflight`, `cutover:smoke`, `embeddings:backfill`, `embeddings:sync`, `migrate:new`, `seed:new`.
- `DESIGN.md` — sección **"Mercado / Operations"** extendiendo el design system a `/dashboard/*`, `/comercial/*`, `/logistica/*`, `/admin/*`, `/vendor/*`, `/televenta/*`. Mismo sistema, 2 surfaces (Storefront + Operations).
- `CHANGELOG.md` — este archivo.

### Changed
- `CLAUDE.md` — Design System ahora cubre 2 surfaces (era solo `/portal`).
- **Rutas — tienda↔ruta "última gana"**: el hook `maybeAssignStoreRoute` ahora reasigna `stores.ruta_id` a la ruta de CADA captura (antes solo asignaba si la tienda no tenía ruta). Así el apartado Rutas agrupa cada tienda bajo la ruta que la capturó por última vez. Cambio en `libs/trade/.../daily-captures.service.ts`.

### Added
- `database/scripts/backfill-store-route-from-captures.js` — backfill idempotente (dry-run por default) que aplica "última gana" a la data histórica: cada tienda hereda la ruta de su captura más reciente con `route_id`.

### Fixed
- **Rutas — ruta duplicada por zona del store**: `getRoutesData` sacaba la zona de cada tienda (`stores.zona_id`) y la metía en el `GROUP BY`, fragmentando una ruta en una fila por cada zona distinta de sus tiendas (ej. "RUTA 23 / LA PIEDAD RD" + "RUTA 23 / —" para tiendas sin zona). Ahora la zona viene de la **ruta** (`catalogs.parent_id → zones`) y el filtro de zona usa `c.parent_id` → una fila por ruta. Complemento: el hook `maybeAssignStoreRoute` ahora también alinea `stores.zona_id` a la zona de la ruta en cada captura, y `database/scripts/backfill-store-zone-from-route.js` corrige la data histórica (dry-run por default).
- **Rutas — timezone mismatch maestro vs detalle**: la lista de rutas (`getRoutesData`) filtraba por `DATE(hora_inicio)` en UTC mientras el detalle (`getRouteVisits`/`getRouteStores`) usaba `AT TIME ZONE 'America/Mexico_City'`. Las capturas de la tarde-noche MX caían en el día UTC siguiente → el conteo "N vis" del maestro no cuadraba con el detalle y rutas con actividad real desaparecían con el rango default = hoy. Alineado todo a MX.
- **vendor-capture**: selector de ruta ahora usa `p-select` (igual que captura diaria) en vez de `<select>` nativo.

### Added — Tiempos muertos (detección)
- **Fase 1 (derivado, sin captar data nueva)**: `GET /reports/routes/:id/idle` y `GET /reports/idle/summary`. Detecta tiempo muerto entre visitas consecutivas del mismo vendedor: `idle = max(0, gap − traslado_estimado)`, traslado = haversine(tiendas)/25 km/h, umbral muerto 20 min. UI en /routes: KPI "Tiempo muerto" + columna "Muerto antes" por visita. Resumen agregado por vendedor para dashboard. `computeIdleSegments` corta por (vendedor, día MX).
- **Fase 2 (breadcrumbs GPS)**: tabla `public.route_location_pings` (mig 20260609100000, sin RLS patrón push_subscriptions). Dexie v5 `routePings` + `RoutePingService` (ping cada 3 min en foreground con ruta activa, cola offline, sync bulk idempotente a `POST /reports/route-pings`). Refinamiento: `getRouteIdle` separa estacionado vs traslado con los pings (idle real = tiempo estacionado), con indicador GPS en la UI. Fallback al estimado por haversine si no hay breadcrumbs.

### Pending
- **Plan migración tokens.css** documentado en DESIGN.md → no aplicado (riesgo de regresión visual cross-app).
- **T1** scripts hardening (`--dry-run` uniforme + `assertEnvVars()`).
- **T2** hints contextuales en tests al fallar (TenantKnex, ability.factory).
- **T3** `docker-compose.dev.yml` + `npm run dev:up`.

---

## 2026-06-08 — Apartado Rutas + Cierre Ruta UI + DX hardening

### Added
- **`/dashboard/routes`** — apartado completo con master-detail (lista rutas + KPIs + mapa Leaflet recorrido + tabla visitas + tabla tiendas). Permiso `RUTAS_VER`. Backend reusa `/reports` (cero schema nuevo). Fases 0-3 (permiso → backend → frontend → backfill).
- **`/comercial` cierre-ruta** — vista admin "Ventas de vendedor" (ticket OCR).
- **Customers Kepler import** — `customers-from-excel.js` + `link-customers-to-stores.js` para combinar maestro Kepler con `commercial.customers`.

### Fixed
- **PWA overflow-x** — `<main>` con `overflow-y-auto` forzaba `overflow-x: auto` → pantalla se deslizaba lateral. Fix: `overflow-x: hidden` en main + body + html, sin romper tablas anchas.
- **Reports** — chromium del SO en Docker + `executablePath` puppeteer, templates `hbs` en webpack assets.
- **PWA service worker** — catalogs/zones/customers a estrategia **freshness** (no cache-first, evita data stale post-merge).

### Internal
- DX review aplicada (F1+F2+F5 del review `/plan-devex-review`): scripts README, .env.example, npm aliases.

---

## 2026-06-07 a 2026-06-05 — Vendor capture + tickets + auth

### Added
- **Vendor capture** — ticket multi-foto, OCR mejorado, visita siempre primero + link `daily_capture_id` + `product_id` via aliases.
- **Catalog aliases** — sistema `trade.catalog_aliases` para mapear UUIDs viejos de conceptos a vigentes. Reporte y resolver de capturas consultan aliases. Migración faltante 20260606100000 agregada en remediation.

### Fixed
- **Auth JWT** — JWT >4KB no entraba en cookie → persistir en localStorage.
- **Auth-trigger** — `auto_populate_tenant_id` no sobrevivió `SET SCHEMA` en prod → mig 20260606000000 dinámica recrea trigger en 57 tablas multi-tenant.
- **Captures** — ticket vendedor acumula varias fotos del MISMO ticket; remap `sku→product_id`; bloquear visita vendedor sin productos.
- **Touch targets ≥44px** en sidebar nav + topbar user menu (F010 design audit).

---

## 2026-06-04 — Portal B2B standalone deploy + Design audit codemods

### Added
- **Portal B2B en repo aparte** — `Portal_MegaDulces` con `API_UPSTREAM` + nginx resolver. `customer_b2b` permisos scoped (mig 20260605120000).
- **Telemetría endpoint** — `commercial-portal-telemetry` con ingesta + resumen.

### Changed
- **Design audit codemods** — sweep monocromo `comercial/*`, `logistica/*`, `portal/catalog`. Codemod hex pass 2 (cart, televenta). AI accent purple `#8b5cf6` → token `--ai-accent` semantic (G1). Tipografía 10-12px + font-weight hierarchy + shadow decorativa fuera (F4/F6/F9).

---

## 2026-06-03 — Module Isolation Sprint (iso.0–iso.6)

### Internal
- **Monolito modular endurecido** — 41 módulos NestJS reorganizados en libs Nx por dominio (`platform-core`, `contracts`, `commercial`, `logistics`, `trade`). Fronteras enforced con `enforce-module-boundaries: error`. Port DI-invertido logistics→commercial. 1 deployable. Ver memoria `project_module_isolation`.

### Fixed
- **FDW boot migrations** — migraciones que ejecutan query contra FDW mega_dulces_srv (.245) crasheaban boot en Railway. Mig 110000 ajustada. Ver memoria `feedback_fdw_boot_migrations`.

---

## 2026-06-02 — Cierre formal Comercial Fases B+C+D+E

### Added
- **ADR-013** — `pending_approval` order status (cliente confirm → `/approve` vendedor → confirmed).
- **Regression suite ampliada** — 19/19 verde, ~155 sub-assertions en ~10.6s.

### Fixed
- **28 mappings ability.factory** — permisos COMMERCIAL_* y LOGISTICS_* sin map a subject/action causaban 403 "permisos dinámicos" para todo rol sin `manage:all`. Ver memoria `feedback_ability_factory_mapping`.

### Internal
- **Fases B+C+D+E cerradas** (beta scope) con regression suite como fuente de verdad. Ver memoria `project_comercial_cierre_formal`.

---

## 2026-05-27 — Fase E Televenta + Fase J Logística + Fase K AI

### Added
- **Fase E Televenta** (CERRADA beta) — workflow call center sin telefonía. Rol `tele_operator`, pool autoservicio, cron @5min libera leads expirados. Smoke 29/29. Endpoints `/api/commercial/televenta/*`. Frontend `/televenta/*` con 4 páginas.
- **Fase J Logística** (CERRADA beta) — embarques, flotilla, costos, guías, liquidaciones, reports. 7 backend modules + 5 admin pages + analytics + hooks cross-project Comercial↔Logística. UI port desde `_imported/logistica/` (Dashboard ops, Personal/Staff con MultiSelect roles, Guides global con 5 KPIs, Costs con KPIs + dialog 10 categorías).
- **Fase K AI product match** (CERRADA beta) — Docker `pgvector-md` (pg18 + vector 0.8.2) + Voyage AI `voyage-3` (1024 dims) + Claude Haiku 4.5 en wizard captures paso 5. 1278 SKUs embedded. Endpoint `/api/ai/products/match-ai`, threshold 0.40, throttle tier `long`. EmbeddingSyncService @Cron cada 15min + endpoint manual. Script `sync-from-remote.js` Docker↔.245.

### Internal
- **K-debt cerrado** — refactor `catalogs.service.ts` + `daily-assignments.service.ts` + `stores.service.ts` para no escribir a columna virtual `activo BOOLEAN GENERATED`.

---

## 2026-05-26 — Sprint A.0-multitenant + Fases B+C+D (todo en un día)

### Added
- **A.0 Multitenant** (CERRADA beta) — nueva DB Postgres 18.4 multi-tenant en `192.168.0.245:5432/postgres_platform`. Schema completo 19 tablas + 95 índices + 18 RLS + rol `app_runtime` + seeds. `TenantContextService` (AsyncLocalStorage) + Interceptor + auth-mt. 1804/1830 rows migrados desde legacy (98.6%).
- **Fase B Core Comercial** (CERRADA beta) — 9 tablas en schema `commercial.*` (customers, warehouses, price_lists, product_prices, stock, stock_movements, orders, order_lines, payments). State machine orders `draft → confirmed → fulfilled`. Generator `PD-YYYY-NNNNN`. CLI importer + test data realista (5 brands + 25 products + 25 prices + 20 customers + 25 stock).
- **Fase C Sales Intelligence** (CERRADA beta) — 7 endpoints `/commercial/analytics/*` (overview, top-customers, top-products, sales-by-brand, low-stock, etc.) + 3 materialized views + `AnalyticsRefreshService` @Cron('*/15min'). Frontend Command Center con 4 KPIs + 4 tablas + alertas WS realtime (low_stock_critical, vip_inactive).
- **Fase D Catálogo + Portal B2B** (CERRADA beta) — `customer_id` UUID + composite FK + `commercial.order_status_history`. Rol `customer_b2b`. Portal Web B2B en `/portal/*` (PortalLogin, PortalCatalog, PortalCart, PortalOrders, PortalOrderDetail). Vendor app mobile-first `/vendor/*` (ADR-005: extender `apps/view` no app RN separada). Canasta estratégica v1 (base/focus/exploration/innovation con score 0..1).
- **ADRs 010, 011, 012** — multi-tenancy shared DB + tenant_id, Voyage AI embeddings, pgvector en DB legacy.

### Internal
- **A.0bis hardening** — Helmet + Throttler 3-tier + body limits 2mb, nginx security headers, console→Logger, Zod schemas para JSONBs.

---

## Pre-2026-05 — Auditoría base + decisiones iniciales

### Added
- **Auditoría base** (60 findings) en [`docs/IMPLEMENTACION/AUDITORIA_BASE_INICIAL.md`](docs/IMPLEMENTACION/AUDITORIA_BASE_INICIAL.md).
- **Stack inicial** — NestJS 11 + Knex + PostgreSQL + Socket.IO + Cloudinary; Angular 18 standalone + PrimeNG + Tailwind + Spartan UI; Capacitor + Dexie mobile; Nx monorepo + Docker + Railway.
- **Auditoría visitas + scoring + reports** funcional. No tomaba pedidos, no catálogo comercial, no multi-tenant.

---

## Convención de updates

1. **Al cerrar feature o sprint** — agregar entry bajo la fecha actual.
2. **Una sección `[Unreleased]`** al tope agrega los cambios sin tag formal.
3. **Categorías estándar:** Added · Changed · Fixed · Deprecated · Removed · Internal · Pending.
4. **No duplicar lo de `03_LOG_REVISIONES.md`** — ese tiene el detalle de lessons learned + diff de archivos. CHANGELOG es la vista "scan en 30 segundos".
5. **Referenciar memoria cuando aplique** — `project_*` o `feedback_*` para más contexto.
