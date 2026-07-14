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
| 6 | **Almacén CFDI 4.0** (tabla `fiscal.cfdis` particionada + JSONB) | ⬜ | SDD Fase 2. XML crudo a Object Storage, cabecera indexada en DB. |
| 7 | **Parser XML masivo** (streaming, sin fugas de memoria) | ⬜ | SDD Fase 3. `fast-xml-parser` + `pLimit`, cuidado con RFCs `"0012"`→`12`. |
| 8 | **Motor de impuestos — PUE/PPD ↔ REP** (complementos de pago) | ⬜ | SDD Fase 2. Vínculo lógico por `uuid_factura` + físico async. Saldo insoluto materializado. |
| 9 | **Conciliación CFDI ↔ póliza contable** (Kepler) | ⬜ | El cruce de mayor valor. Reusa `analytics.expense_doc_chain` (lineage ya existe en Maat). |

### Capa 3 — Cumplimiento / Riesgo

| # | Módulo | Estado | Reusa / Nota |
|---|--------|--------|--------------|
| 10 | **EFOS 69-B** (lista negra, CFF 69-B) | ✅ | **FISCAL.0 hecho.** Motor genérico `fiscal.sat_list_*` (lista='69B') + cruce vs `expense_documents`. Bandeja + triage. |
| 11 | **Lista 69** (firmes/cancelados/no localizados/exigibles/sentencias) | ✅ | **FISCAL.1 hecho.** lista='69', URLs Azure Blob del SAT en config (override `LISTA69_CSV_URLS`, verificar HEAD). |
| 12 | **Validación de estatus CFDI ante SAT** (vigente/cancelado) | ⬜ | WS de verificación. Detecta CFDI cancelados que siguen deducidos. |
| 13 | **Validación de RFC / LCO** (RFC inexistente o inválido) | 🔨⏳ | **FISCAL.1 estructural hecho** (`fiscal.rfc_issues`: formato_invalido/rfc_generico). Existencia ante SAT (LCO/CSF) diferida. |

### Capa 4 — Contabilidad y reportes fiscales

| # | Módulo | Estado | Reusa / Nota |
|---|--------|--------|--------------|
| 14 | **Balanza / catálogo de cuentas** | ✅ | `analytics.ledger_monthly` (Maat MAAT.1). Cuadra vs análisis contable. |
| 15 | **Contabilidad electrónica** (XML catálogo + balanza + pólizas SAT) | ⬜ | Genera los XML que exige el SAT desde la balanza existente. |
| 16 | **DIOT** (Declaración Informativa de Operaciones con Terceros) | ⬜ | Se arma desde CFDI recibidos + `ap_provider`. |
| 17 | **Conciliación de IVA** (acreditable vs trasladado, efectivamente pagado) | ⬜⏳ | Maat ya detecta el bug de IVA. Formalizar el cálculo PUE/PPD. |
| 18 | **Impuestos provisionales** (ISR/IVA mensual) | ⬜ | Cierre fiscal mensual. |

### Capa 5 — Gestión documental

| # | Módulo | Estado | Reusa / Nota |
|---|--------|--------|--------------|
| 19 | **Object Storage** (XML WORM + evidencias) | ✅⏳ | Cloudinary ya en uso; evaluar S3/Object Lock para XML legal (retención 5 años). |
| 20 | **Generación de PDF** (representación impresa + expedientes) | ⬜ | SDD Fase 5. jsPDF/PDFKit ya se usa en logística. |
| 21 | **Expediente de materialidad** (evidencia foto anexa) | ⬜ | Clave para defender operaciones con proveedores EFOS. |

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
3. **FISCAL.1.1 — Bridge a `finance.findings`** ⬜ — consolidar matches/issues en la bandeja de Maat (decisión Edgar). Siguiente paso natural.
4. **FISCAL.2 — Bóveda de credenciales SAT** ⬜ — pgcrypto/env (Railway, no AWS KMS). Desbloquea descarga.
5. **FISCAL.3 — Job runner Postgres** ⬜ — fundación para pipelines pesados sin BullMQ.
6. **FISCAL.4 — Descarga masiva CFDI + almacén + parser** ⬜ — el eje CFDI (SDD Fases 2-3).
7. **FISCAL.5 — Conciliación CFDI ↔ póliza + PUE/PPD ↔ REP** ⬜ — el cruce de mayor valor.
8. **FISCAL.6 — Estatus CFDI ante SAT + validación cancelados** ⬜.
9. **FISCAL.7 — Detectores fiscales nuevos en Maat** ⬜ — CFDI sin póliza, IVA descuadrado, etc.
10. **FISCAL.8 — DIOT + conciliación IVA** ⬜.
11. **FISCAL.9 — Contabilidad electrónica (XMLs SAT)** ⬜.
12. **FISCAL.10 — Documental: PDF (R2 Bucket Locks) + expediente de materialidad** ⬜.

**Ruta crítica:** FISCAL.2 (bóveda) → FISCAL.3 (job runner) → FISCAL.4 (descarga) → FISCAL.5 (conciliación). Todo lo de listas (EFOS/69/RFC) y lo que se apoya en Kepler+Maat corre en paralelo sin depender del WS del SAT.

---

## Decisiones (2026-07-14, Edgar)

- ✅ **Dominio Fiscal:** motor de listas/CFDI en `libs/fiscal`; **hallazgos consolidados en `finance.findings`** (bandeja de Maat). Bridge pendiente = FISCAL.1.1.
- ✅ **Object storage XML:** **Cloudflare R2 con Bucket Locks** (WORM real, egress $0, S3-compatible con `@aws-sdk/client-s3`). Cloudinary se queda solo para evidencias fotográficas. Alternativa formal-compliance: Backblaze B2. Implementación en capa documental (FISCAL.10). Activar retención al escribir cada objeto (`ObjectLockRetainUntilDate` = fecha_emisión + 5 años).
- ✅ **e.firma / credenciales:** deploy en **Railway** → `pgcrypto`/env (no AWS KMS). FISCAL.2.

### Abiertas
- **ADR:** falta formalizar el ADR del dominio Fiscal (número siguiente disponible).
- **PAC:** Facturama ya integrado (timbrado) — ¿mismo PAC para descarga/verificación de estatus, o WS del SAT directo?
- **Art. 69 URLs:** verificar con HEAD las rutas Azure Blob del SAT antes de confiar en prod; idealmente scrapear el índice `contribuyentes_publicados.html` en runtime.
