# Fase PV — Validación y Cuadre de Pólizas

> **ADR-041.** Responde la pregunta del área de contabilidad: *"¿esta póliza se
> subió mal?"* — a nivel de **póliza individual**, no agregado. Hereda ADR-016/028:
> el motor decide con SQL determinista, Maat narra, **nunca escribimos a Kepler ni
> ContPAQi** (solo lectura + bandeja de hallazgos).

## Problema

Hasta hoy detectamos anomalías **agregadas o heurísticas** (18 detectores Maat), pero
NO podíamos señalar una póliza concreta y decir "esta no cuadra / cuenta equivocada /
periodo equivocado". La razón: ninguna tabla nuestra guardaba la **partida doble
completa por póliza**:

- `analytics.expense_entries` → solo la pata de **cargo** de compras/gastos (511/6xx).
- `analytics.ledger_monthly` → **SUM mensual por cuenta** (pierde la póliza).
- El único cuadre existente era el caso puntual XD5501 (bug de IVA).

## Fuente: ambas + reconciliar

El dato crudo SÍ existe en el SoR y solo faltaba persistir el detalle completo:

| Fuente | Tablas | Rol |
|---|---|---|
| **ContPAQi** (SoR fiscal, SQL Server COMPAC @ .35) | `Polizas` (108k; header con `Cargos`/`Abonos` ya totalizados + `Guid`), `MovimientosPoliza` (1.1M; las dos patas, `IdCuenta`/`TipoMovto`/`Importe`), `AsocCFDIs` (917k; **UUID del CFDI ↔ movimiento**), `Cuentas` (`Afectable`) | **verdad fiscal** — cuadre + CFDI exacto |
| **Kepler** (operativo, 6 sucursales) | `kdc2YYMM` (`c3` cuenta / `c4` cargo-abono / `c5` importe) | **detalle por sucursal** — lo que ContPAQi consolida al ~2% |

Reconciliar = marcar dónde el total de una póliza en Kepler ≠ ContPAQi.

## Entregables

### PV.0 — Schema (`analytics.*`, tenant explícito, sin RLS como el resto de analytics)
- **`analytics.gl_polizas`** — header unificado: `source` (kepler|contpaqi), sucursal,
  ejercicio, periodo, tipo_pol, folio, fecha, concepto, cargos, abonos, neto, guid,
  tiene_doc_bancario. PK `(tenant, source, ejercicio, periodo, tipo_pol, folio, sucursal)`.
- **`analytics.gl_poliza_lines`** — patas: misma llave del header + num_movto, cuenta,
  cuenta_nombre, cuenta_afectable, cargo_abono, importe, referencia, cfdi_uuid, sat_agrupador.
- Mig `20260731130000_analytics_gl_polizas.js` (idempotente, GRANT SELECT app_runtime).

### PV.1 — Importers (READ-ONLY, idempotentes, UPSERT no DELETE)
- **`import-contpaqi-polizas.js`** — `Polizas` ⋈ `MovimientosPoliza` ⋈ `Cuentas` ⋈ `AsocCFDIs`.
  Header + patas + UUID. Fuente primaria del cuadre. `--from <año>` (default 2025), `--apply`.
- **`import-kepler-polizas.js`** — `kdc2YYMM` de las 6 sucursales, ambas patas (`c4` in ('C','A')),
  filtra `c5>0`. Reusa `STOCK_BRANCH_MAP`/patrón de feeds LAN.

### PV.2 — Detectores (`MaatPolizaService`, escriben a `finance.findings`)
| Detector | clase | Condición | Antes imposible |
|---|---|---|---|
| `poliza_no_cuadra` | error_captura | `abs(cargos−abonos) ≥ $0.01` por póliza | ✅ el gap raíz |
| `cuenta_no_afectable` | error_captura | pata postea a cuenta padre (no-hoja) | nuevo |
| `periodo_sospechoso` | error_captura | fecha de la póliza fuera de su periodo/mes | enmascarado hoy |
| `poliza_duplicada_exacta` | riesgo | mismo (cuenta, importe, fecha, referencia) en folios distintos | se borraba en silencio |
| `cfdi_importe_no_coincide` | riesgo | póliza ⋈ CFDI por **UUID** (`AsocCFDIs`), `abs(Δ) ≥ tol` | ✅ exacto, no heurístico |
| `kepler_vs_contpaqi_descuadre` | riesgo | total mensual por cuenta Kepler ≠ ContPAQi | ✅ el valor de "ambas" |

Corren en el `MaatScannerService` nocturno existente + `scan-now`.

### PV.3 — UI "Auditor de Pólizas" (`/contabilidad/polizas`, nueva tab)
- Backend `FinancePolizasModule` (`PolizasController` @`contabilidad/polizas` + `PolizasService`):
  `GET /` (lista con semáforo de cuadre + filtros), `GET /:src/:key` (detalle con patas + CFDI),
  `POST /scan`. Permiso `FISCAL_CONTAB_VER` / `_GESTIONAR` (reusa, sin permiso nuevo).
- Frontend: página densa master-detail (patrón Operations, DESIGN.md), tab en `CONTABILIDAD_TABS`.

### PV.4 — Maat
- Tool `maat_poliza_cuadre` (lee `gl_polizas`/`findings`) para "¿qué pólizas no cuadran en junio?".

## Scope honesto (lo que NO hace)
- No corrige pólizas (solo detecta; la corrección es en ContPAQi/Kepler por el contador).
- No es contabilidad electrónica válida (eso es el cód-agrupador, Fase FE.11).
- No reemplaza al contador — le da la bandeja de "revisá estas".

## Decisiones abiertas
1. **Reconciliación Kepler↔ContPAQi**: la llave `(ejercicio,periodo,tipo_pol,folio)` puede no
   ser 1:1 (numeración distinta) → arrancar por **totales mensuales por cuenta**, refinar a folio si empata.
2. **Volumen**: 1.1M líneas ContPAQi — arrancar **2025–2026**, ampliar con `--from`.
3. **Cobertura `AsocCFDIs`**: no toda pata tiene CFDI (esperado) → `cfdi_importe_no_coincide` solo evalúa las que sí.

## Estado
🟢 **Verificado LOCAL con data real 2026-07-31.** Migración aplicada a Docker local + importer
Kepler corrido (96,682 patas / 36,031 pólizas / 3 meses / 6 sucursales). El motor caza **384
pólizas descuadradas con folio** — las top son `XD5501` (el bug de IVA en descuentos, abono
huérfano a 122-001, ya conocido en el modelo contable). Builds api+view verdes.

Lección de deploy: las tablas `kdc2YYMM` de Kepler viven en el schema **`md`**, no en public
(fix: prefijo `md.` + `to_regclass`).

**Pendiente prod (requiere máquina de feeds + Railway):**
1. **Railway** — aplicar mig `20260731130000` (`DATABASE_URL_NEW`=Railway → `npx knex migrate:latest --knexfile database/knexfile-newdb.js`).
2. **ContPAQi** (máquina de feeds, `CONTPAQI_SQL_PASSWORD` + acceso SQL Server .35) —
   `node database/importers/contpaqi/import-contpaqi-polizas.js --from 2025 --apply`.
   Verificar ahí el join real de `AsocCFDIs` (va en try/catch; si el nombre de columna difiere,
   ajustar la query — el core header+patas entra igual).
3. **Kepler** (feeds LAN) — `node database/importers/kepler/import-kepler-polizas.js --months 18 --apply`.
4. **Redeploy** api + view + re-login (para tomar la nueva ruta/permiso en el token).
