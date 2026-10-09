# Fase FISCAL — Contabilidad y Cumplimiento SAT (mapa de módulos)

> Dominio nuevo `libs/fiscal` (`@megadulces/fiscal`). Nace del SDD
> [`system_design_backend_saas_fiscal.md`](../../../system_design_backend_saas_fiscal.md)
> (SaaS fiscal estilo ezaudita) **adaptado al monorepo**: Cron + Postgres,
> **sin BullMQ/Redis/AWS KMS**. No es un producto externo: es la capacidad
> contable/fiscal interna de Mega Dulces, que se apoya en lo que ya existe
> (Kepler contable, Maat, PAC Facturama, multi-tenant/RLS).

## Tesis

El "proyecto de contabilidad" NO se construye desde cero. Ya tenemos las tres
patas caras: **la fuente contable** (Kepler → `analytics.*`), **la capa AI**
(Maat) y **el timbrado** (PAC Facturama). Lo que falta es el **eje CFDI**
(descargar, almacenar, conciliar contra pólizas) y el **cumplimiento**
(EFOS ✅, estatus SAT, DIOT, contabilidad electrónica). El valor está en el
**cruce**: CFDI ↔ póliza ↔ pago ↔ lista negra.

Regla heredada (ADR-016): **el motor decide, el agente comunica, el LLM fuera
del camino del dinero.** Los números salen de SQL determinista; Maat narra.

---

## Mapa de módulos por capa

Leyenda: ✅ existe/reutilizable · 🔨 hecho este sprint · ⬜ por construir · ⏳ parcial

### Capa 1 — Ingesta / Fuentes de datos

| # | Módulo | Estado | Reusa / Nota |
|---|--------|--------|--------------|
| 1 | **Bóveda de credenciales SAT** (e.firma `.cer/.key`, CIEC) — `CryptoService` | ⬜ | SDD Fase 1 adaptado: **pgcrypto/env**, no AWS KMS. Desencriptado efímero en memoria. Bloquea descarga masiva. |
| 2 | **Descarga masiva CFDI** (WS SAT Descarga Masiva) | ⬜ | SDD Fase 3 adaptado: pipeline `solicitud→verificación→paquete→parse` sobre **job-table Postgres + Cron**, no BullMQ. |
| 3 | **CFDI emitidos / timbrado** | ✅⏳ | Ya existe [PAC Facturama](../../../libs/logistics/src/lib/logistics-cartaporte/pac.service.ts) (Carta Porte). Extender a facturación general. |
| 4 | **Importador contable Kepler** (pólizas, balanza, auxiliares) | ✅ | `import-expenses-polizas.js`, `import-ledger-chain.js`. Alimenta `analytics.ledger_monthly`, `expense_*`, `ap_provider`. |
| 5 | **POS Wincaja** (ventas/caja sucursales) | ✅ | `wincaja.*` (Fase W). Fuente de ingresos para conciliación. |

### Capa 2 — Núcleo CFDI

| # | Módulo | Estado | Reusa / Nota |
|---|--------|--------|--------------|
| 6 | **Almacén CFDI 4.0** (tabla `fiscal.cfdis` + JSONB) | ✅ | **FISCAL.4.2 hecho.** `fiscal.cfdis` (cabecera indexada + `impuestos`/`raw` JSONB, RLS, UNIQUE tenant+uuid). XML crudo en R2 (1 ZIP/paquete). Falta particionar por `fecha` a volumen. |
| 7 | **Parser XML masivo** | ✅ | **FISCAL.4.2 hecho.** `CfdiParserService` (`fast-xml-parser`, `removeNSPrefix`, `parseAttributeValue:false` → RFC/folio `"0012"` intacto). Ingesta por chunks (200) desde el ZIP con `adm-zip`. Validado con CFDI 4.0 real. |
| 8 | **Motor de impuestos — PUE/PPD ↔ REP** (complementos de pago) | ✅ | **FISCAL.5.1 hecho.** `fiscal.cfdi_payment_links` (DoctoRelacionado de cada REP). Saldo insoluto = total − Σ ImpPagado; detecta PPD sin REP + saldo pendiente. `/fiscal/conciliacion` + hallazgos a Maat + cron nocturno. |
| 9 | **Conciliación CFDI ↔ póliza contable** (Kepler) | ✅ | **FISCAL.5.2 hecho (heurística).** ⚠️ **Kepler NO guarda el UUID del CFDI** (verificado en vivo: `kdfecfd`/`kdcecfdpol`/`kdfecedocuuid` vacías en las 6 sucursales; `kdm1` sin UUID) → no hay JOIN exacto. Cruce por **RFC+importe±1+fecha±5d** vs `analytics.expense_documents`, scoped a periodos con descarga. Detecta CFDI-sin-póliza + póliza-sin-CFDI. `/fiscal/conciliacion/cruce/*` + hallazgos a Maat. |

### Capa 3 — Cumplimiento / Riesgo

| # | Módulo | Estado | Reusa / Nota |
|---|--------|--------|--------------|
| 10 | **EFOS 69-B** (lista negra, CFF 69-B) | ✅ | **FISCAL.0 hecho.** Motor genérico `fiscal.sat_list_*` (lista='69B') + cruce vs `expense_documents`. Bandeja + triage. |
| 11 | **Lista 69** (firmes/cancelados/no localizados/exigibles/sentencias) | ✅ | **FISCAL.1 hecho.** lista='69', URLs Azure Blob del SAT en config (override `LISTA69_CSV_URLS`, verificar HEAD). |
| 12 | **Validación de estatus CFDI ante SAT** (vigente/cancelado) | ✅ | **FISCAL.6 hecho.** `EstatusService` consulta `ConsultaCFDIService` (WS público, **sin e.firma**) por lote → actualiza `fiscal.cfdis.estatus_sat`. CFDI recibido cancelado → hallazgo `cfdi_cancelado` (critical) a Maat. `/fiscal/estatus/check` + cron 09:00 UTC. Port `SAT_ESTATUS_PORT`. ⚠️ formato `tt` validar en WS real. |
| 13 | **Validación de RFC / LCO** (RFC inexistente o inválido) | 🔨⏳ | **FISCAL.1 estructural hecho** (`fiscal.rfc_issues`: formato_invalido/rfc_generico). Existencia ante SAT (LCO/CSF) diferida. |

### Capa 4 — Contabilidad y reportes fiscales

| # | Módulo | Estado | Reusa / Nota |
|---|--------|--------|--------------|
| 14 | **Balanza / catálogo de cuentas** | ✅ | `analytics.ledger_monthly` (Maat MAAT.1). Cuadra vs análisis contable. |
| 15 | **Contabilidad electrónica** (XML catálogo + balanza + pólizas SAT) | ✅⏳ | **FISCAL.9 hecho (catálogo + balanza).** `ContabilidadElectronicaService` genera **Balanza BCE 1.3** (SaldoIni=Σneto previos del ejercicio, SaldoFin=SaldoIni+Debe−Haber, validado) + **Catálogo 1.3** desde `analytics.ledger_monthly`. `/fiscal/contabilidad-electronica/{balanza,catalogo}`. ⚠️ `CodAgrupador` = placeholder (falta mapeo SAT). Pólizas XML (PLZ) diferido. |
| 16 | **DIOT** (Declaración Informativa de Operaciones con Terceros) | ✅ | **FISCAL.8.1 hecho.** `DiotService.build(period)` desde `fiscal.cfdis` recibidas con **IVA efectivamente pagado** (PUE en emisión / PPD prorrateado al pagarse el REP). Renglón por proveedor + tipo_tercero (04/05/15). `/fiscal/diot`. Perm `FISCAL_DIOT_VER`. |
| 17 | **Conciliación de IVA** (acreditable vs trasladado, efectivamente pagado) | ✅ | **FISCAL.8.1 hecho.** `DiotService.ivaResumen(period)`: acreditable (recibidas pagado) vs trasladado (emitidas cobrado) → IVA a cargo/favor. `/fiscal/diot/iva`. Cálculo PUE/PPD flujo formalizado. |
| 18 | **Impuestos provisionales** (ISR/IVA mensual) | ✅⏳ | **FISCAL.18 hecho.** `ImpuestosService.pagoProvisional(period, {cu,...})`: ISR = ingresos nominales acum (balanza fam 4) × coeficiente de utilidad × 30% − pagos previos − retenciones; IVA reusa `DiotService`. `/fiscal/impuestos/provisional`. **⚠️ Cálculo de apoyo — validar con contador; CU es input del ejercicio anterior.** Validado vs prod (ingresos Ene-Jul $387M). |

### Capa 5 — Gestión documental

| # | Módulo | Estado | Reusa / Nota |
|---|--------|--------|--------------|
| 19 | **Object Storage** (XML WORM + evidencias) | ✅⏳ | Cloudinary ya en uso; evaluar S3/Object Lock para XML legal (retención 5 años). |
| 20 | **Generación de PDF** (representación impresa + expedientes) | ⬜ | SDD Fase 5. jsPDF/PDFKit ya se usa en logística. |
| 21 | **Expediente de materialidad** | ✅⏳ | **FISCAL.10.1 hecho.** `MaterialidadService.buildDossier(rfc)`: listas SAT + CFDIs + estatus + **cadena de suministro** (orden→recepción→factura→pago de `expense_doc_chain`; recepción física = evidencia) + veredicto heurístico. `/fiscal/materialidad/:rfc`. **Validado contra prod real** (DISTRIBUIDORA DE LA ROSA: 390 ops, 95% recepción → SÓLIDA). Evidencia foto anexa + PDF diferido (frontend con jsPDF). |

### Capa 6 — Inteligencia (AI) y motor de patrones

| # | Módulo | Estado | Reusa / Nota |
|---|--------|--------|--------------|
| 22 | **Maat — AI de Finanzas** (chat tool-use, hallazgos, feedback L2) | ✅ | [libs/finance](../../../libs/finance/src/lib/maat/). Se vuelve la capa AI de todo el proyecto contable. |
| 23 | **Detectores fiscales** (CFDI sin póliza, póliza sin CFDI, IVA descuadrado, EFOS) | 🔨⏳ | EFOS ya alimenta la bandeja. Sumar detectores nuevos al motor de Maat (`finance.findings`). |
| 24 | **Acciones propuestas (HITL)** | ✅ | `finance.proposed_actions` (Maat 3.0). Nunca escribe a Kepler; propone y humano aprueba. |

### Capa 7 — Plataforma transversal

| # | Módulo | Estado | Reusa / Nota |
|---|--------|--------|--------------|
| 25 | **Multi-tenant + RLS** | ✅ | `platform-core` (`TenantKnexService`, `current_tenant_id()`). |
| 26 | **Permisos / roles contables** | ✅🔨 | `FINANCE_*` + `FISCAL_EFOS_*` nuevos. Roles por área ya existen. |
| 27 | **Job runner Postgres** (reemplazo de BullMQ) | ⬜ | Necesario para descarga masiva. Cron + tabla de jobs idempotente. |
| 28 | **Observabilidad** (Pino, métricas cola/SAT) | ⏳ | SDD Fase 6. Parcial hoy. |

---

## Secuencia sugerida (rebanadas verticales)

1. **FISCAL.0 — EFOS 69-B** ✅ *(código; falta aplicar en DB + smoke)*. Generalizado a motor de listas.
2. **FISCAL.1 — Art. 69 + validación RFC** ✅ *(código; falta aplicar en DB + smoke)*. Motor genérico de listas (`sat-lists.config.ts`) + `fiscal.rfc_issues`.
3. **FISCAL.1.1 — Bridge a `finance.findings`** ✅ *(código; falta aplicar en DB + smoke)* — matches/issues consolidados en la bandeja de Maat vía port `FINANCE_FINDINGS_SINK_PORT` (fiscal no importa finance). 4 reglas nuevas, respeta FK+L2+triage, best-effort.
4. **FISCAL.2 — Bóveda de credenciales SAT** ✅ *(código; falta DB + `FISCAL_CRYPTO_KEY`)* — AES-256-GCM master key en env (no AWS KMS). `withDecryptedEfirma` con zeroing. `fiscal.sat_credentials` RLS. Desbloquea descarga.
5. **FISCAL.3 — Job runner Postgres** ✅ *(código; falta DB)* — `fiscal.jobs`, claim FOR UPDATE SKIP LOCKED, backoff+jitter, DLQ, handlers por type. Sin BullMQ.
6. **FISCAL.4 — Descarga masiva CFDI** ✅ *(código; falta DB + validar firma en sandbox SAT)* — pipeline solicitud→verificación→paquete sobre jobs, port `SAT_SOAP_PORT` (impl node:crypto, swapeable a `@nodecfdi/sat-ws-descarga-masiva`). Estados 1-6 del doc SAT. **13 hallazgos de review adversarial corregidos** (crítico: `ON CONFLICT` sobre índice parcial → 42P10; reaper de jobs zombie; requests colgados; idempotencia; `attr()` substring; zeroing de llave).
   - **FISCAL.4.2 — Parse + almacén** ✅ *(código; falta DB + `FISCAL_R2_*` env)* — `fiscal.cfdis` + `CfdiParserService` (validado con CFDI 4.0 real) + `CfdiIngestService` (ZIP→parse→upsert, chunks 200) + `CfdiStorageService` (R2 env-gated, WORM best-effort). Cableado en `handlePaquete` → paquete queda `parseado` con `num_cfdis`. API `/fiscal/cfdi` (list/stats/get), perm `FISCAL_CFDI_VER`.
7. **FISCAL.5 — Conciliación** ⏳
   - **FISCAL.5.1 — PUE/PPD ↔ REP** ✅ *(código; falta DB)* — `fiscal.cfdi_payment_links` + `ConciliacionService` (saldo insoluto = total − Σ ImpPagado; PPD sin REP; stats). API `/fiscal/conciliacion` (stats/ppd-sin-rep/saldo-insoluto/scan) + cron nocturno 08:00 UTC + hallazgos a Maat (reglas `ppd_sin_rep`, `ppd_saldo_insoluto`). Parser REP validado. Perm `FISCAL_CONCILIACION_VER`. Mig `20260714170400`.
   - **FISCAL.5.2 — CFDI ↔ póliza contable** ✅ *(código; falta DB)* — **hallazgo: Kepler NO guarda el UUID del CFDI** (verificado en vivo contra las 6 sucursales: `kdfecfd`/`kdcecfdpol`/`kdfecedocuuid` vacías; `kdm1` 200 cols sin UUID; solo catálogos SAT poblados). → cruce heurístico `PolizaCruceService` por RFC+importe±$1+fecha±5d vs `analytics.expense_documents` (sin RLS → filtro tenant explícito). **Coverage-scoped:** "póliza sin CFDI" solo dentro de rangos ya descargados (`download_requests.estado='descargada'`), para no marcar todo gasto como sin comprobante antes de correr la descarga. `/fiscal/conciliacion/cruce/{stats,cfdi-sin-poliza,poliza-sin-cfdi,scan}` + hallazgos a Maat (`poliza_sin_cfdi`, `cfdi_sin_poliza`) + cron.
8. **FISCAL.6 — Estatus CFDI ante SAT + validación cancelados** ✅ *(código; falta DB + data CFDI + validar `tt` en WS real)* — `EstatusService` + `ConsultaCFDIService` (WS público sin e.firma) → `estatus_sat` + hallazgo `cfdi_cancelado`. `/fiscal/estatus/check` + cron. Reusa perm `FISCAL_CFDI_VER`, sin migración.
9. **FISCAL.7 — Detectores fiscales nuevos en Maat** ⬜ — CFDI sin póliza, IVA descuadrado, etc.
10. **FISCAL.8 — DIOT + conciliación IVA** ✅ *(FISCAL.8.1 código; falta DB + data CFDI)* — `DiotService` desde `fiscal.cfdis` con IVA **efectivamente pagado** (PUE emisión / PPD prorrateado al pagar REP). `/fiscal/diot` (DIOT por proveedor) + `/fiscal/diot/iva` (acreditable vs trasladado → a cargo/favor). Perm `FISCAL_DIOT_VER` (mig `20260714170500`, solo permiso). Sin tabla nueva.
11. **FISCAL.9 — Contabilidad electrónica (XMLs SAT)** ✅ *(catálogo + balanza; código; falta DB + mapeo CodAgrupador SAT)* — `ContabilidadElectronicaService` genera Balanza BCE 1.3 + Catálogo 1.3 desde `analytics.ledger_monthly`. Saldos calculados + validados. `/fiscal/contabilidad-electronica/*`. Perm `FISCAL_CONTAB_VER` (mig `20260714170600`). Pólizas XML (PLZ) diferido.
12. **FISCAL.10 — Documental: expediente de materialidad** ✅ *(FISCAL.10.1; validado vs prod real)* — `MaterialidadService.buildDossier(rfc)` (listas + CFDIs + cadena orden→recepción→factura→pago + veredicto). `/fiscal/materialidad/:rfc`. PDF representación impresa + evidencia foto anexa diferidos.

**Ruta crítica:** FISCAL.2 ✅ → FISCAL.3 ✅ → FISCAL.4 ✅ → FISCAL.4.2 ✅ → FISCAL.5.1 ✅ → FISCAL.5.2 ✅ → FISCAL.6 ✅ → FISCAL.8.1 ✅ → FISCAL.9 ✅ → FISCAL.10.1 ✅ → FISCAL.18 ✅. **BACKEND FISCAL COMPLETO (beta).** Aplicado dev (localhost:5433) + Railway prod (8 migs). Diferidos (menores): PDF representación impresa (frontend jsPDF), pólizas XML (PLZ), evidencia foto en materialidad, mapeo CodAgrupador SAT. Pendiente operacional: rotar creds Railway, redeploy API, envs (`FISCAL_CRYPTO_KEY`/`FISCAL_R2_*`), correr descarga, validar 2 firmas WS en sandbox, frontend.

---

## Decisiones (2026-07-14, Edgar)

- ✅ **Dominio Fiscal:** motor de listas/CFDI en `libs/fiscal`; **hallazgos consolidados en `finance.findings`** (bandeja de Maat). Bridge pendiente = FISCAL.1.1.
- ✅ **Object storage XML:** **Cloudflare R2 con Bucket Locks** (WORM real, egress $0, S3-compatible con `@aws-sdk/client-s3`). Cloudinary se queda solo para evidencias fotográficas. Alternativa formal-compliance: Backblaze B2. Implementación en capa documental (FISCAL.10). Activar retención al escribir cada objeto (`ObjectLockRetainUntilDate` = fecha_emisión + 5 años).
- ✅ **e.firma / credenciales:** deploy en **Railway** → `pgcrypto`/env (no AWS KMS). FISCAL.2.

### Abiertas
- **ADR:** falta formalizar el ADR del dominio Fiscal (número siguiente disponible).
- **PAC:** Facturama ya integrado (timbrado) — ¿mismo PAC para descarga/verificación de estatus, o WS del SAT directo?
- **Art. 69 URLs:** verificar con HEAD las rutas Azure Blob del SAT antes de confiar en prod; idealmente scrapear el índice `contribuyentes_publicados.html` en runtime.

---

## MAT.5 — La pasada masiva del casamiento CFDI ↔ operación (2026-10-09) 🧪

Nace de una auditoría que pidió Edgar: *"qué procesos existen que no están casados?"*. Se midieron
las **once juntas** de la cadena documental contra prod, y de ahí salió esta fase.

### ⛔⛔ El hallazgo: dos tablas de casamiento en prod con CERO filas

| junta | universo | casados | |
|---|---:|---:|---:|
| REP (complemento de pago) → factura | 176 | 176 | 100 % |
| CFDI recibido → contabilidad | 14,982 | 12,579 | 84.0 % |
| Factura de proveedor → pago aplicado (`kdxf`) | 23,598 | 18,998 | 80.5 % |
| OC de Kepler → entrada de mercancía | 12,977 | 10,487 | 80.8 % |
| Movimiento bancario → documento Kepler | 60,550 | 18,915 | 31.2 % |
| Pago a proveedor → comprobante escaneado | 4,714 | 1,350 | 28.6 % |
| Entrada de mercancía → factura (por importe) | 6,210 | 1,641 | 26.4 % |
| Requisición nuestra → OC de Kepler | 751 | 63 | 8.4 % |
| Entrada de mercancía → CFDI (por folio) | 6,210 | 41 | 1.1 % |
| **Cobro de cliente → ficha de depósito** | 27,921 | **0** | ⛔ |
| **CFDI recibido → operación de Kepler** | 14,982 | **0** | ⛔ |

⭐ **El patrón:** lo que casa por **llave estructural** casa (100 %, 84 %, 80 %); lo que depende de
que alguien **teclee una referencia o suba un papel**, no. El 1.1 % de entrada↔CFDI es literalmente
`F-18852`, `10-8853`, `0-F8803` escritos a mano.

⛔ Y lo peor no es lo que falta casar: **`fiscal.cfdi_assignments` y `finance.collection_deposits`
están en producción, con esquema, índices, OCR y pantalla, y nunca se usaron ni una vez.** No es un
hueco de datos: es trabajo terminado que no entró a la operación.

### Por qué `cfdi_assignments` quedó vacía — y por qué eso SÍ es código

`reconcile()` recibe **UN RFC a la vez** y propone candidatos para confirmar factura por factura.
Con **399 proveedores** y **14,891 CFDIs recibidos** en 365 días, nadie iba a hacerlo nunca. El
sugeridor es bueno; lo que faltaba era la pasada masiva.

Medido con la MISMA heurística de `reconcile` (RFC + importe ±$1 + fecha ±5 d):

| | CFDIs |
|---|---:|
| recibidos en 365 d | 14,891 |
| con al menos un candidato fuerte | 2,297 |
| con **un solo** candidato | 2,016 |
| **pares estrictamente 1:1** | **1,900 · $99,961,324** |

### ⛔⛔ La decisión que manda: proponer no es confirmar

El `CHECK` sólo admitía `confirmed` y `rejected`. Escribir el casamiento automático como
`confirmed` **sería una mentira con consecuencia fiscal**: esta tabla es la evidencia de
materialidad que consume `MAT.3`, y un cruce por importe y fecha es una **pista fuerte, no la
prueba de que la operación existió**. Confirmado queda indistinguible de lo que una persona
verificó — y ésa es justo la diferencia que importa en una auditoría.

⇒ Estado nuevo **`auto`** (mig `20261009153940`). Los consumidores que filtran `confirmed` ven
exactamente lo mismo que antes —nadie hereda evidencia que nadie miró— y la persona pasa de
**buscar** los pares a **aprobarlos** (`confirm-batch`, que es donde queda su nombre).

⭐ **Dos índices únicos parciales**, aprovechando que la tabla está VACÍA: es el único momento en
que no pueden fallar al crearse. Vuelven estructural lo que hoy era una promesa del comentario del
servicio ("1:1 en ambos sentidos"). `rejected` queda fuera: descartar el mismo par N veces no es
asignar.

### Lo que el lote NO hace, a propósito

- ⛔ **No usa el casamiento DÉBIL** (`[MAT.1.1]`, sin RFC, cruzado porque dos nombres comparten una
  palabra). Proponerlo en masa siembra trabajo de revisión en vez de ahorrarlo.
- ⛔ **Sólo el 1:1 estricto.** De 2,725 pares candidatos, 1,900 cumplen; los otros 825 quedan para
  la persona, que es exactamente donde su criterio vale algo.
- ⭐ **Declara el universo.** La respuesta trae `cfdis_sin_candidato` y `pares_ambiguos` aparte,
  porque «1,900 propuestas» sin denominador se lee como *«ya está casado todo lo que se podía»* y
  es falso: ~12,900 CFDIs no tienen **ni un** candidato. Eso no es ambigüedad, es ausencia.

### Candado

`materialidad-auto.spec.ts`, 22 aserciones. ⚠️ Vive en `libs/finance` porque **`libs/fiscal` no
tiene runner de tests** y dárselo toca la config de Nx, que no se toca sin autorización — se
declara la deuda en vez de cambiar la config por mi cuenta.

**Mutado a rojo** poniendo `'confirmed'` donde va `'auto'`: caen las dos aserciones de consecuencia
fiscal. ⛔ Y una negativa mía nació mal otra vez: barría todo el `INSERT` y salía roja con el código
correcto, porque los `NOT EXISTS` de idempotencia nombran `'confirmed'` legítimamente —están
**comprobando** filas, no insertándolas—. Se acotó a la lista de valores.

### ⚠️ Lo que falta, y NO se hizo

- ⛔ **La migración no se aplicó** y **el lote no se corrió contra prod**. Correrlo escribe ~1,900
  filas en una tabla de evidencia fiscal: va con autorización explícita y fuera de horario.
- ⛔ **`finance.collection_deposits` no se arregla con código.** Está completa —OCR, cuadre,
  pantalla, permisos— y vacía porque nadie sube la ficha de depósito. Es un cambio de proceso, con
  dueño, no un sprint.
- **La pantalla** de materialidad todavía pinta igual una propuesta y una confirmación: el backend
  ya manda `status`, falta que el front lo use y ofrezca el confirmar en lote.
- ⛔ **El traspaso no cuadra con nadie**: $119.3 M salieron y $79.6 M se registraron recibidos en
  180 d, con el hueco **creciendo** (jul $7.1 M → sep $16.4 M) y **negativo** en mayo-junio. Eso
  descarta rezago de tránsito: las dos puntas no son un par que cuadre. Nadie lo ha cuadrado nunca
  y es el movimiento por el que pasa casi todo el inventario de la red.
