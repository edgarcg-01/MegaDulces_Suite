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

---

## PV.4 — Auditor del **TIPO** de póliza (D/E/I) · 2026-09-18 · 🧪 en código

> ⚠️ **Colisión de prefijo, declarada, no resuelta acá:** el 2026-09-17 se abrió en
> `01_TRACKER_PROGRESO.md` una **"Fase PV — Presupuesto de Ventas"** (hija de Fase PU),
> que no tiene nada que ver con esta. `PV` quedó doble-ocupado, igual que pasó con
> ADR-052. Este sprint sigue la numeración de **esta** fase (PV.3 → PV.4) porque es su
> continuación literal. **Quien renombre, que renombre una sola y actualice ambos docs.**

### De dónde salió

De revisar dos documentos reales que trajo Dirección: un TXT de pólizas de **ContPAQi**
(septiembre 2026, tipo **2 = Egresos**, folios 250–263) contra un PDF de **Kepler** del
doctype **`XA1001` "Gastos"** (póliza **D = Diario**). La lectura inicial fue que Kepler
estaba asignando mal el tipo y había que avisarle a quien sube las pólizas.

### Lo que se midió, y por qué la premisa no se sostenía

`XA1001` **abona a `203` / `201` (proveedores), no a efectivo** — o sea es un **devengo**,
y una póliza que no mueve efectivo **es Diario por definición**. El pago sale después por
`X-D-26-1` "Transferencia a proveedor", que **sí** abona a banco (`102`) y **sí** está
declarado `E`. Kepler está bien ahí, y el smoke lo deja clavado para que nadie lo
"arregle".

**Decode de `kepler_ods.kdmm`** (el catálogo de doctypes): la llave es `c1`-`c2`-`c3`-`c4`
(género-letra-número-subtipo), `c5` = descripción, `c17` = prefijo (`KFXA1001`),
**`c18` = tipo de póliza** (`D`/`E`/`I`), `c19` = cuenta de cargo, `c20` = cuenta de abono.
Kepler declara **142 doctypes en D, 22 en E y 6 en I** — la capacidad existe.

⭐ **`c20` depende de la SUCURSAL, no del concepto:** `X-A-10-1` abona a `203` en la
sucursal `00` y a `201` en las seis restantes. Cualquier consulta de gastos que filtre por
una sola cuenta pierde la otra mitad.

### (A) Incongruencias del catálogo — lo que sí está mal

Criterio **derivado del propio catálogo**: si el doctype toca efectivo o equivalentes
(**`102` y `111` bancos, `110` caja**) el tipo debe ser `E` o `I`; si no los toca, `D`.

⚠️ **El criterio ingenuo "mueve `102`" marca 24 doctypes y 13 son falsos positivos**,
porque `X-D-20-1` "Pago prov. Efectivo" mueve **caja (`110`)**, no banco. Un tablero con
18 de 24 filas equivocadas se ignora en una semana; la prueba negativa está en el smoke.

Medido con el criterio correcto: **11 incongruencias**, de las cuales **2 con uso en 2026**:

| doctype | descripción | declarado | debería | docs | importe |
|---|---|---|---|---|---|
| `U-A-40-1` | Anticipo (carga banco `102`, abona `206`) | `D` | `I` | 4 | $509,844 |
| `U-D-9-1` | Ticket Crédito (no mueve efectivo) | `I` | `D` | 7 | $18,139 |

Las otras **9 están dormidas** (0 documentos en 2026) — entre ellas `X-A-9-3/4/5`
"Gastos de importación / indirectos / no deducibles", declarados `E` abonando a `210`,
que son los hermanos de `X-A-10-1` y contradicen el criterio al revés. Catálogo dormido
**no es trabajo pendiente**, y la pantalla los separa.

**66 doctypes no declaran cuentas → `no_juzgable`.** Se cuentan aparte: sumarlos a "ok"
sería dibujar un verde sobre algo que no se miró.

### (B) Brecha de modelo Kepler ↔ ContPAQi

No es un error de tipo: **son dos modelos distintos del mismo hecho**. Kepler registra el
gasto en **dos tiempos** (devengo contra proveedores → pago contra banco) y ContPAQi, en
el TXT revisado, en **uno solo** (gasto + IVA **contra banco directo**, tipo 2 Egresos).
$66,839,481 en 8,247 documentos `X-A-10-1` en 2026 devengados de un lado contra pólizas
de egreso que ya traen el banco del otro: **ninguna comparación por tipo va a cuadrar**, y
no porque alguien haya subido mal el archivo.

Se mide sin inventar liga 1:1 (no existe): monto por tipo de póliza y mes sobre
`analytics.gl_polizas`, que ya tenía `source` (`kepler`|`contpaqi`) desde PV.3.

### Lo que NO se construyó, a propósito

- **Bandeja nueva: no.** Se reusa `finance.findings` (Maat) con su triage, evidencia y
  auto-supresión L2. **ADR-056**: ya van ocho bandejas inventadas; ésta es la novena que
  no se hace. Mismo patrón que `FiscalFindingsBridgeService`.
- **Pantalla nueva: no.** Bloque dentro de `/contabilidad/polizas`, que ya existía con su
  permiso `FISCAL_CONTAB_VER`. **Permiso nuevo: no.**
- **Migración / tabla / importer: no.** Todo deriva del ODS y de `analytics`.

### El aviso: dos trampas que había que esquivar

1. ⛔ **`notifyCritical()` no le llega a nadie hoy.** Emite alertas `finance_finding`, y la
   campana las descarta en la puerta: `FINANCE_NOTIF_ENABLED = false` en
   `notifications-bell.component.ts`, apagado a propósito porque "el badge traía cientos
   de hallazgos sin triar". Se usa `notify()` con **tipo propio `polizas_tipo`**, que no
   pasa por ese flag.
2. ⛔ **Un tipo nuevo sin su `if` le llega a TODOS**: el ruteo de la campana es una lista
   de `if` explícitos y el default **deja pasar**. Se cableó
   `canSeeTipoPoliza` (`FISCAL_CONTAB_VER`) + ícono. *Un aviso mal ruteado se ignora
   igual que uno que falta* — misma lección que LC.6.2 con el permiso declarado y no
   repartido.

### ADR-056 en los dos bloques

Cada bloque devuelve `state: 'measured' | 'not_measured'` **con motivo**. En esta base
`analytics.gl_polizas` está en **0 filas** (el importer de PV.3 nunca corrió acá), así que
el cruce **se declara ciego** — se ve en pantalla como "Control a ciegas" y viaja como
hallazgo propio `poliza_tipo_no_medido`. *"No encontré nada" y "no busqué" se leen igual
en una pantalla y significan lo contrario.*

### Entregado

`PolizaTypeAuditService` + `PolizaTypeFindingsBridgeService` (cron 00:45 MX) ·
4 endpoints bajo `/contabilidad/polizas/tipos/*` · bloque en la pantalla (arriba de los
filtros: lo primero que debe verse es si el control pudo correr) · ruteo en la campana ·
smoke `test-newdb-poliza-type-audit` **16/16** corrido contra la base, con sus negativas,
en la suite de regresión. Builds api + view OK. Commit `696bf629`.

### Pendiente

1. **Verificación HTTP** (ADR-044) y **validación visual** — los dev servers los levanta Edgar.
2. **Redeploy** api + view. **Sin migraciones ni permisos nuevos → no hace falta re-login.**
3. El bloque (B) sigue **ciego en prod** hasta que corran los importers de PV.3
   (`import-contpaqi-polizas.js` + `import-kepler-polizas.js`) — el pendiente que esta
   fase ya traía.
