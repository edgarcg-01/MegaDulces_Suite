# FASE CB — Conciliación bancaria (interfaz que reemplaza el Excel)

> **Estado:** 🔨 EN CURSO — CB.0 ✅ 2026-07-22 · **ADR:** ADR-033 (aceptado)
> **Tesis:** el workbook Excel manual de bancos ("CUENTAS LUIS FRANCISCO") → interfaz en el proyecto Finanzas: subir estado de cuenta → clasificar con catálogo limpio → conciliar contra Kepler → bandeja de diferencias. Motor decide / humano clasifica / LLM fuera del cuadre (ADR-016/028).
> **Pedido de Edgar:** "mudaremos de .xlsx a hacer todo desde una interfaz. pero primero es entender y luego hacer."

---

## 0. Qué entendimos del Excel (validado 2026-07-22)

Fuente: `01 ENERO 2026.xlsx` (+ `.csv` de 1 hoja + `.zip` con las 22 hojas en HTML). Es el **lado banco** del dinero, a nivel estado de cuenta.

- **22 hojas:** 19 cuentas de banco + `CAJA GENERAL` + `FACTORAJE` + `TOTAL MOV` + `CONCENTRADO`.
- **Bancos:** Santander ×4 (2169/1604/1621/5565), BBVA ×6 (5712/6586/4176/4885/6721/2182), Banorte/BTE ×3 (3041/7744/7133), BanBajío/BB ×4 (3660/4166/854/506), Banamex ×1 (1463).
- **Volumen:** ~4,865 movimientos/mes clasificados a mano.
- **Columnas por línea:** `FECHA · M (tipo) · S (sucursal/plaza) · C (cuenta) · PROVEEDOR (concepto) · RETIRO · DEPOSITO · SALDO`.

**Totales enero 2026 (mi parse == CONCENTRADO, al peso):**

| Concepto | Enero 2026 |
|---|---:|
| INGRESOS (depósitos) | $52,949,859 |
| COMPRAS (pago proveedor) | $43,534,807 |
| GASTOS | $6,584,511 |
| Traspasos TI=TE (neto 0) | $25,400,000 |
| Saldo inicial → final | $471,345 → $922,400 |

**Taxonomía `M` (tipo de flujo):** `I` ingreso · `G` gasto · `C` compra · `TE`/`TI` traspaso · `CF` compra c/factoraje · `PF` pago factoraje · `DS` dev SPEI · `ID` ingreso por devolución · (`i` typo de I).

**Códigos `C` del Excel están SOBRECARGADOS** (por eso rediseñamos, no migramos tal cual):
- `102` = depósito/cobranza. `510` = compra mercancía (Rosa/Mondelez/Ferrero). `147` = IVA.
- `612` = **cajón de sastre**: SUA/IMSS $1.05M + comisión bancaria $99k + pago capital + arrendamiento + traslado valores.
- `613` = caja de ahorro + compra vehículo (Automotores Flosol→activo fijo) + pagos a personas.
- `610` = **NÓMINA** (Nómina 01/04/05).
- Basura de captura: `(vacío)` $1.6M, `/` $1.5M, `50`, `i`, `501`, `621`, `631`.

## 1. Relación con Kepler (la piedra Rosetta)

El workbook es el **detalle por banco que Kepler colapsa en el código único `102`** (17 bancos comparten `102`; el banco real vive en `c7` texto libre — ver [`../KEPLER_CONTABILIDAD_MODELO.md`](../KEPLER_CONTABILIDAD_MODELO.md) §Familia 1).

- Hoja `BNMX 1463` = subcuenta Kepler cuyo nombre en `kdco` es literalmente **"BANAMEX 1463"** (código `102`).
- Hoja `FACTORAJE` = Kepler `210`. Hoja `CAJA GENERAL` = subcuentas caja chica de Kepler (`102-0030/0040/0042`), **no** el 102 bancario.
- **Signo invertido:** banco `DEPÓSITO` ↔ Kepler `102` **cargo**; banco `RETIRO` ↔ Kepler `102` **abono**.
- Sanity check: Kepler `102` enero cargos $40.8M vs ingresos bancarios workbook (~$52.95M − caja) ≈ $43.7M → mismo orden, gap explicable por caja/timing/factoraje. **Conciliación viable.**

**Crosswalk código Excel → cuenta Kepler** (implementado como catálogo `finance.movement_categories`):

| Excel `C`/`M` | Categoría limpia | Kepler |
|---|---|---|
| I / 102 | `cobranza` | `102`↔`115` (UA0501) |
| C / 510, 501 | `compra_mercancia` | `511` + `201`/`102` (XD2601) |
| CF | `compra_factoraje` | `201`/`210` |
| PF | `pago_factoraje` | `210` |
| 610 | `nomina` | `601` |
| 612·SUA | `imss_sua` | `762` |
| 612·COMISION | `comision_bancaria` | `611-003` |
| 147 | `iva_acreditable` | `122` |
| 612·capital | `pago_credito` | `210`/`103` |
| 613, 621, 631 | `caja_ahorro` / `gasto_admin` / `pension` / `renta` / `traslado_valores` | `608`/`603`/`602`/`601` |
| TE/TI, `-` | `traspaso_entre_cuentas` | inter-`102`/`103` (neto 0) |
| DS/ID | `devolucion_spei` / `ingreso_devolucion` | reverso |
| (vacío)/`/` | `sin_clasificar` | — (bandeja UI) |

## 2. Schema (`finance.bank_*`) — CB.0 ✅

Migración [`20260722130000_finance_bank_reconciliation.js`](../../../database/migrations-newdb/20260722130000_finance_bank_reconciliation.js). RLS forzado + grants `app_runtime` + seed. Aplicada a **local (Batch 197)**; pendiente Railway.

| Tabla | Propósito | Clave |
|---|---|---|
| `finance.bank_accounts` | 19 bancos + caja + factoraje como entidad | `(tenant, bank, account_label)`. Seed: 20 cuentas |
| `finance.movement_categories` | catálogo limpio alineado a Kepler | `(tenant, code)`. Seed: 18 categorías |
| `finance.bank_statements` | estado de cuenta por (cuenta × periodo): saldos + totales | `(tenant, bank_account_id, period)` |
| `finance.bank_movements` | una fila por línea del estado de cuenta | UPSERT por `(tenant, client_uuid)` |
| `finance.bank_recon_matches` | cruce movimiento banco ↔ posting Kepler | `(tenant, bank_movement_id, kepler_doc_tipo, kepler_doc_folio)` |

## 3. Plan por fases

| Sprint | Alcance | Estado |
|---|---|---|
| **CB.0** | ADR-033 + schema `finance.bank_*` + seed catálogo/cuentas | ✅ 2026-07-22 (local) |
| **CB.1** | Importer `import-bank-statement.js` (exceljs): XLSX → `bank_statements`+`bank_movements`, traduce código Excel→categoría (regex de concepto para 612/613), valida totales vs CONCENTRADO, UPSERT por `client_uuid` | ✅ 2026-07-22 (local) |
| **CB.1b** | Backfill histórico: correr el importer para **feb–jul 2026** (un workbook por mes) → histórico completo en `finance.bank_*`. Insumo: los XLSX mensuales (Edgar). | ⬜ (falta insumos) |
| **CB.2** | Backend `libs/finance` módulo `finance-bank`: endpoints `GET /finance/bank/{accounts,categories,periods,statements,concentrado,movements}` + `PATCH /movements/:id/category`. Read=`FINANCE_EXPENSES_VER`, reclasificar=`FINANCE_FINDINGS_GESTIONAR`. Build api verde + queries verificadas vs local. **Upload web + reconcile → CB.2.1/CB.4.** | ✅ 2026-07-22 |
| **CB.2.1** | Upload web: `POST /finance/bank/import` (base64, exceljs server-side, misma clasificación que CB.1) + botón "Subir estado de cuenta" en `/finanzas/bancos` (deriva periodo del nombre, UPSERT). Body limit 25mb en la ruta. Build api+view verde; path exceljs-buffer + knex `onConflict().merge()` verificado idempotente. → **habilita backfill y go-forward sin CLI.** | ✅ 2026-07-22 |
| **CB.3** | Frontend `/finanzas/bancos` (Operations, PrimeNG, dark-first): tablero CONCENTRADO (pivote cuenta×grupo + MetricStrip KPIs) · grid de movimientos con **reclasificación inline optimista** (select por fila, resalta sin_clasificar) · lista de cuentas. Tab "Bancos" + ruta `permissionGuard(FINANCE_EXPENSES_VER)`. Build view verde. **Validación visual manual pendiente.** | ✅ 2026-07-22 |
| **CB.5** | Afinar clasificación: +3 categorías (`compra_tarjeta`→608, `servicios`→603, `impuestos`→761, mig `20260722140000`) + reglas de concepto para 612/613 (DISPOSICION POR POS, DOMICILIACION/CFE, SAT, RENTA TPV). classify() idéntico en CLI+service. **sin_clasificar 11.0%→1.9%** (534→94) en enero. | ✅ 2026-07-22 |
| **CB.4** | Conciliación banco↔Kepler (control-total): `GET /finance/bank/reconciliation` + vista "Conciliación". **Caja:** depósitos/retiros banco (excl. traspasos) vs `102` cargos/abonos. **P&L:** gasto del banco por categoría vs cargos del mayor Kepler (lee `analytics.ledger_monthly`). Deltas con tolerancia ±$1k. Verificado local (detectó IMSS 762→601, timing 511). Build api+view verde. | ✅ 2026-07-22 (control-total) |
| **CB.4.1** | Matching por-transacción: feed `analytics.bank_postings` (postings 102 Kepler, `import-bank-postings.js`, PK client_uuid, CEDIS) + `runMatch()` (retiros banco ↔ abonos 102 por monto exacto + fecha ±7d, greedy) → `finance.bank_recon_matches` + `recon_status`. Endpoint `POST /finance/bank/match` + botón "Correr matching" + columna concil. en Movimientos. Enero: **402/1932 casados (21% conteo / 60% monto = $31.7M)** — casan los pagos grandes a proveedor; comisiones/nómina/tarjeta quedan sin casar (Kepler los agrupa). Feed en nightly+finance. Build api+view verde. | ✅ 2026-07-22 |
| **CB.4.2** | Diferencias: `GET /finance/bank/differences` + 2 listas en la vista Conciliación (retiros banco sin casar / pagos Kepler sin casar, rankeados por monto). Verificado E2E local. Reveló que el top sin-casar de ambos lados es el MISMO pago ($1.03M Rosa) que el matcher no pareó por gap de fecha → señal accionable. Build api+view verde. | ✅ 2026-07-22 |

**Decisiones tomadas (Edgar 2026-07-22):** catálogo **rediseñado limpio** (no migrar códigos Excel); ingesta por **subir el XLSX** en CB.1.

### Estrategia de corte (Edgar 2026-07-22)

Dos fases de operación, con **julio 2026 (mes actual) como línea de corte**:

1. **Histórico → vía Excel (backfill).** Todos los meses **hasta julio 2026 inclusive** se concilian importando los workbooks Excel mensuales con el importer CB.1 (`--file "<MES> 2026.xlsx" --period YYYY-MM`, idempotente). Deja el histórico completo cargado en `finance.bank_*` sin recapturar nada a mano.
2. **Adelante → vía interfaz.** A partir de **agosto 2026** se deja de usar el Excel: los estados de cuenta se suben/capturan y concilian **en `/finanzas/bancos`** (upload web CB.2.1 + reclasificación + motor de conciliación CB.4). El Excel se retira.

**CB.1-backfill (pendiente de insumos):** el importer ya es genérico; falta **cargar los workbooks de feb–jul 2026** (solo tengo enero). Cuando Edgar los provea, se corre el importer una vez por mes (o un loop) → histórico completo. Ver [`CB.1b`] abajo.

## 4. Diferido / decisiones abiertas
- CB.4.1: **fuzzy-name** (contraparte) para subir el match rate por conteo (hoy solo monto+fecha); diferencias (retiros sin casar) → `finance.findings` clase conciliación; **matching de cobranza** por-transacción (hoy control-total: Kepler agrega por plaza, no casa 1:1).
- `kepler_link` por banco (mapear el `102` consolidado de Kepler a cada cuenta) — CB.4; el banco en Kepler vive en `c7` sucio.
- Parser de estado de cuenta crudo por banco (elimina el doble tecleo) — post CB.1.
- `caja_ahorro` → cuenta Kepler exacta por confirmar (¿`205`?).
- `CAJA GENERAL` tiene layout de columnas distinto al de bancos → el importer necesita rama especial.
