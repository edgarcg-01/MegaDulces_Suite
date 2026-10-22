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
| **CB.9** | **Rediseño a "la tabla que cuadra" + pestaña ¿Cuadra?** (pedido de Edgar: interfaz simple/entendible). La vista **default** pasa a **Movimientos** (tabla de todos los ingresos/egresos) con un **banner de cuadre** arriba (Ingresos · Egresos · Neto · Movimientos + veredicto ✓/✗ con link «Ver por qué»). Nueva pestaña **¿Cuadra?** = agregador `diagnostico(period)` + `GET /finance/bank/diagnostico`: lista accionable de descuadres ordenada por impacto, cada ítem con **qué es + monto + qué falta hacer** (sin_clasificar, saldo no cierra por cuenta, cuenta sin cargar tipo CAJA GENERAL, traspasos TI=TE, diferencias vs Kepler). Reúsa `balances`+`reconciliation`+conteos (sin data nueva). Segmento reordenado: Movimientos · ¿Cuadra? (con badge de conteo) · Concentrado · Conciliación Kepler · Cuentas · Admin. **Fix incluido:** `concentrado()` fallaba en prod (42803 GROUP BY binding vs literal) → agrupa por `mc.group_key`. Verificado en vivo contra Railway: 18/19 cuentas cuadran, diagnóstico = 3 ítems (1 saldo + 94 sin clasificar $1.46M + CAJA CG). Builds verdes. Operations surface (quiet-luxury, tokens, dark-first, tabular-nums). | ✅ 2026-07-22 (local) |
| **CB.8** | **Cuadre de saldos + 2º pase del matcher.** Sin migración (`opening_balance` ya existía en CB.0): el import (web+CLI) ahora **deriva el saldo inicial** de la 1ª fila con SALDO (`opening = saldo − neto`). `balances(period)` + `GET /finance/bank/balances` + card **"Cuadre de saldos"** en Conciliación: por cuenta `inicial + depósitos − retiros == final` (Δ, badge) + check **TI=TE** (traspasos internos netean). Hallazgo `banco_saldo_no_cuadra` (error_captura) por cuenta descuadrada. **2º pase del matcher**: retiros ≥$10k aún sin casar → monto exacto **sin tope de fecha** (confianza 0.5, `matched_by='motor-2p'`). Smoke local (rollback, opening derivado de `running_balance`): 19 cuentas → **6 cuadran / 13 descuadran** (señal real: no foot-ean); 2º pase rescató **solo 1** match y el **$1.03M sigue sin casar** → corrige la hipótesis previa: los grandes sin casar son **descuadre de MONTO** (centavos banco≠Kepler), no gap de fecha. **Próximo lever: tolerancia de monto (±$X) + fuzzy-name** (diferido). Builds verdes. | ✅ 2026-07-22 (local) |
| **CB.7** | **Diferencias → bandeja de hallazgos de Maat.** `syncFindings(period)` empuja las diferencias de conciliación a `finance.findings` vía el port `FINANCE_FINDINGS_SINK_PORT` (`@Optional`, best-effort, mismo patrón que el bridge de `libs/fiscal`). 3 reglas deterministas: `banco_retiro_sin_kepler` (riesgo, retiro ≥$50k sin casar; crítico ≥$500k), `banco_sin_clasificar` (error_captura, agregado del periodo), `banco_pnl_descuadre` (riesgo, categoría vs mayor Kepler \|Δ\|≥$10k). Dedup estable → re-sync actualiza, no duplica. Auto-push best-effort al final de `runMatch`; botón "Enviar a Hallazgos" en la vista Conciliación. `POST /finance/bank/findings/sync`. Aparecen en `/finanzas/hallazgos` con triage + feedback L2 que ya existía. Smoke E2E transaccional: 188 retiros materiales → 188 findings, FK `rule_registry` OK, idempotente. Builds verdes. | ✅ 2026-07-22 (local) |
| **CB.6** | **Admin + reglas de clasificación en DB.** Migración `20260722160000` (`finance.bank_classify_rules`, RLS, 26 reglas seed que **reproducen exacto** el `classify()` de CB.1+CB.5) + `20260722160500` (`bank_movements.classified_by` rule/manual). Motor `classifyWith(compiled, M, C, concept)` lee reglas de DB en `importWorkbook` **y** en el CLI (mata la duplicación: la fuente de verdad es la tabla). Backend CRUD: `POST/PATCH /accounts`, `POST/PATCH /categories`, `GET/POST/PATCH/DELETE /rules`, `POST /reclassify` (re-aplica reglas respetando `classified_by='manual'`; re-import ya no pisa la categoría). Frontend: vista **Admin** con 3 sub-tabs (reglas / categorías / cuentas) editables inline + alta + botón "Reclasificar movimientos". Write=`FINANCE_FINDINGS_GESTIONAR`. Smoke: **0 divergencias motor-DB vs stored en 4,865 movs** (migración neutral); reclassify idempotente + manual intacto (test transaccional c/rollback). Builds api+view verdes. | ✅ 2026-07-22 (local) |

| **CB.23** | **Sync del workbook maestro (Google Sheet vía export público).** El Excel maestro del mes en curso es un Google Sheet compartido "cualquiera con el enlace" → `SheetSyncService` baja el `.xlsx` de `/export?format=xlsx` (sin cuenta de servicio ni webhook) y lo procesa con el **mismo parser** del upload web (`importFromBuffer`, refactor de `importWorkbook`). Compara sha1 vs `last_hash` (no reprocesa sin cambios). **Disparo:** `@Cron('0 */3 * * * *', TZ MX)` guardeado por `SHEET_SYNC_ENABLED=true` + `config.active`, y botón "Sincronizar del Sheet" en el header. Mig `20260812120000`: `bank_movements.sync_source` ('upload'\|'sheet') + `deleted_at` (soft-delete) + `finance.sheet_sync_config` (RLS, seed MEGA active=false). **Barrido soft-delete:** cada pull marca `deleted_at` las filas 'sheet' del periodo×cuentas que ya no vinieron (updated_at < t0); UPSERT revive las que reaparecen; NUNCA toca filas 'upload'. `deleted_at IS NULL` agregado a las **19 lecturas** de `bank_movements`. **Endpoints:** `GET/PATCH /sheet-sync/config`, `POST /sheet-sync/run`. **4 fixes del parser** (verificados vs el workbook real de agosto, 2,393 movs): (1) alias Santander `SNTDR`→`STDR` (las 4 cuentas casaban vacío); (2) CAJA GENERAL sin header FECHA (fecha en col antes de M); (3) skip-list `MOVIMIENTOS GENERAL`/`RESUMEN DE SALDOS`/`POR IDENTIFICAR`; (4) fecha en **mes-español** `"05/Ago./2026"` (Banorte) — el parser viejo la tiraba silenciosamente (~82 movs, incl. $345k/$415k) + guard año 2000–2100. Builds api+view verdes. | 🔨 2026-08-12 (local) |
| **CB.24** | **Cuadre 3 vías (Workbook ↔ Kepler 102 ↔ ContPAQi).** `GET /finance/bank/three-way` + vista "Cuadre 3 vías". **Nivel 1 (control-total):** 2 filas Ingresos/Egresos × 3 fuentes + deltas por par (W–K/W–C/K–C) + semáforo ±$1k — aquí "cuadran las 3". **Nivel 2 (por cuenta):** Workbook ↔ ContPAQi (el 102 de Kepler **no se desglosa por banco** → Kepler solo en el control-total; nota explícita). Compone `contpaqiCompare` (Workbook+ContPAQi, universo kind='bank') + total del 102 de `bank_postings` (C=ingreso/A=egreso). Answer-first (veredicto arriba). Builds verdes. | 🔨 2026-08-12 (local) |
| **CB.44** | **El conciliador de tesorería cruza el borde de mes.** Sale de un caso real (suc. 01, cliente `C1011`): factura `U-D-8` 0000319 del **21-jul** por **$1,653.00**, **pagada el 24-jul**, y capturada como cobro `U-A-7` 0000213 el **12-AGO a las 16:52** — junto con otros cinco del mismo cliente (**$20,565.85**, teclados entre 16:50 y 16:54). El banco lo tiene en **julio** y Kepler en **agosto**. `runMatchTreasury` cortaba los **DOS** lados al mes calendario (`st.period` del banco y `fecha_valor` de Kepler), así que los pases que anunciaban «±10d» y «sin tope de fecha» **no podían salir del periodo**: el depósito no tenía candidato POSIBLE y el mismo dinero se reportaba como faltante **de los dos lados**. **Pool de Kepler abierto a mes ±45d** con guarda anti doble-cobro entre periodos (el `used` vive en UNA corrida y el borrado de matches es por `bank_movement_id`); **los pases 1-4 siguen viendo sólo el mes** (cero regresión). **Pase 5 (lote):** Kepler YA trae el lote armado (mismo pagador + cuenta + fecha) — se suma el grupo en vez de reconstruirlo con suma de subconjuntos, que se topaba en **5 sumandos** (el lote tenía 6, el **único** de 6+ en todo 2026) y recortaba a los **30 candidatos más GRANDES**, dejando fuera justo los renglones chicos (el $1,653 ranqueaba **~136 de 147**). **Pase 6:** 1:1 exacto fuera del mes, sin piso de importe. **Declaración ADR-056 `fecha_no_confiable`** por **(cuenta × doctype)**: donde `fecha_valor == fecha_captura` conciliar por fecha es imposible **por diseño** y hay que DECIRLO, no reportar los cobros como «no existe en el banco». Medido: la **suc. 00 retrofecha** (`c9≠c68` en ~92%, lag 2-5 días) y la **01 no lo hace nunca** (`6721 × U-A-7` al **95%**, $2.8M en la ventana). ⚠️ El grano es cuenta × doctype, **no** cuenta: agregado da 27% y **parece sano**. Smoke `test-newdb-bank-crossmonth-match.js` **23/23** (en la regresión): carga el `.ts` **REAL** vía ts-node, lado Kepler desde el ODS local, lado banco sintético, todo en trx con rollback; **3 negativas** (importe inventado, depósito a 7 meses, `U-A-5` de la misma cuenta que sí retrofecha) y una de **REGRESIÓN** que atrapó un bug propio de esta entrega: `pg` devuelve `date` como **Date** y `String(d).slice(0,10)` da **"Tue Sep 01"** → el filtro «dentro del periodo» daba **siempre falso** y mataba los pases 1-4 enteros — el caso cruzado seguía verde y lo tapaba. ⚠️ **La causa RAÍZ es de captura, no de código**: en la suc. 01 `fecha valor` = `fecha captura` = el día que se tecleó (9-15 días distintos al mes para 196-211 cobros). ~~Mientras no se retrofeche, ningún motor puede conciliar por fecha: **$6,858,008.40** de cobranza 2026.~~ ⛔ **ESTA ÚLTIMA FRASE ESTÁ REFUTADA — ver CB.48 (2026-09-24).** La fecha real SÍ se captura: vive en el **complemento de pago SAT** (`kepler_ods.kdfe33pagm1.c7`), y el motor estaba leyendo `fecha_valor`, que es el día del tecleo. El monto es el mismo al peso porque son exactamente esos cobros los que tienen complemento. Lo demás de esta fila sigue en pie; lo que se cae es la conclusión de que hacía falta cambiar la práctica de captura. ⚠️ Se deja tachado y no borrado a propósito: una conclusión medida que resultó falsa enseña más que su ausencia — el error fue dar por inexistente un dato sin haber buscado dónde más podía estar. | ✅ 2026-09-21 (local, commit `789e700a`) · ⛔ conclusión refutada 2026-09-24 |
| **CB.46** | **El tablero medía TRES cosas hacia el lado verde, y las tres se midieron antes de tocarlas.** (1) **El chip «Conciliado» decía siempre «sin correr».** `matchResult` es un signal que sólo llena el POST de la sesión y que se resetea al cambiar de periodo: nunca se hidrataba de la DB. Ago-2026 tiene **1,467 movimientos casados en prod** y la pantalla abría diciendo «sin correr» — o sea invitando a re-disparar una escritura innecesaria. `diagnostico` ahora devuelve `recon_estado` (mismo par que `runMatch`: monto casado / monto de retiros) y **declara `stale`**: medido, **los 9 periodos se re-importaron DESPUÉS de su último match** (el último fue el **18-ago**; sep se importó el 23-sep), así que el % describe un universo que ya cambió y los movimientos nuevos entran como `pending` sin que nadie vuelva a conciliar. Ago pasa de «sin correr» a **«63% · desactualizado»**. (2) **El chip «Clasificado» inflaba 5-13 pp todos los meses.** El numerador descontaba el sin-clasificar del **Concentrado**, que excluye `kind='cash'` a propósito, contra un denominador que **sí** incluye la caja: mayo decía **99%** y el real era **86%**, y el Cierre listaba los 662 reales dos centímetros más abajo. Ahora los dos lados salen de `diagnostico`. Además el `?? 100` que apagaba el aviso cuando no había dato pasa a avisar: *no medido* no es *todo bien* (ADR-056). (3) **La pantalla tenía DOS universos.** Concentrado/Cuadre/Cierre/Conciliación filtran por `st.period`; `ingresos-control` y `egresos-control` filtraban por `movement_date`. Medido: **84 movimientos** tienen la fecha fuera del periodo de su propio estado de cuenta, y en **ago-2026** eso dejaba **$722,950 de depósitos y $706,842 de retiros** fuera de la bandeja de control **sin declararlo** — su veredicto salía verde por omisión. Los dos controles pasan a `st.period` (**$2,264,247 recuperados en 6 periodos**, sin regresión de latencia: 185 ms vs 194 ms, 389 páginas). **Causa raíz cerrada:** `excelDate()` aceptaba cualquier año de 4 dígitos y nunca lo contrastaba contra `--period`; ahora hay compuerta con **ROLLBACK** (el import ya corría en transacción, así que el rechazo es todo-o-nada) y escape `--allow-fecha-fuera`. ⚠️ **La medición corrigió dos veces mi propia lectura**: los 84 **no** son todos typos — **61 son legítimos** (cierre que el banco liquida en el corte siguiente), así que el umbral es **±1 mes**, no «distinto del periodo»; y la primera aserción del candado («todos son el último día del mes») la **refutó la población completa** (13 caen en el último día **hábil** — 30-may-2026 fue sábado). ⚠️ **Queda ABIERTO y declarado, no tapado:** 14 movimientos de **CAJA GENERAL** ($43,285) fechados el **19-ago** dentro del corte de sep-2026 y **con el concepto en NULL** — no son desfase de corte ni typo de año; es captura suelta y hay que preguntarle a quien la hace. Lo que no se pudo casar por fecha rota va a un bucket **`fecha_invalida`** propio, fuera de `explicado` y de `sin_explicar`: acusar al ERP de un hueco que no existe enseña a ignorar la bandeja. Incluye el **reorden de buckets de CB.43**: `traspaso` se resuelve **antes** que `pago_erp` — el consumo es greedy y el pago casa sólo por monto+fecha (Kepler no dice de qué banco salió), así que un traspaso coincidente se etiquetaba como pago **y además quemaba** ese pago, dejando sin respaldo al retiro real. Candado `test-newdb-bank-date-gate.js` **10/10** en la regresión: ejerce la función **REAL** del importer (una copia de la regla en el test se pone verde sola), con **4 negativas** (los 2 typos que ya entraron a prod, el año -1, y las dos fronteras: +1 mes no pasa porque el desfase de corte sólo va hacia atrás, -2 tampoco) y **tercer estado NO MEDIDO** donde no hay filas con qué comprobarse. Builds api+view verdes. | 🔨 2026-09-24 (local) |
| **CB.47** | **El traspaso interno se reportaba como «depósito sin origen».** Reporte de Edgar: *«traspasos internos no se consideran y eso hace que desconcilie el sistema»*. Medido y confirmado. `egresosControl` tenía bucket `traspaso`; **`ingresosControl` —el que lleva meses en prod— no**: sus buckets eran tesorería / cobranza / caja / sin_explicar, así que todo depósito entre cuentas propias caía en «sin explicar» salvo que Kepler lo trajera por casualidad. **Medido en prod:** abr-2026 = **59% del sin explicar ($17,879,000 de $30,545,811)**; ago-2026 = 7%; volumen total **$216,097,722 en 9 meses**. La diferencia entre meses **no es ruido**: depende de si la cuenta ORIGEN tiene su estado de cuenta cargado. Ahora `ingresosControl` empareja contra el **retiro espejo en OTRA cuenta nuestra** (±$1, ±3d) y estrena `via_traspaso` + `via_factoraje`; `egresosControl` gana el mismo trato para `TI`/`TE` (antes sólo miraba `group_key`). **Lo que NO tiene espejo va a `traspaso_sin_contraparte`, no a «sin explicar»** — la acción es *«carga el estado de cuenta que falta»*, no *«investiga este depósito»*, y meterlo en `explicado` sería dibujar: ninguno de los dos, se DECLARA (ADR-056). ⚠️ **La causa dominante es de COBERTURA, no de captura:** mar y may no tienen cargadas 5 cuentas (**1604, 1621, 2169, 4885, 5565**), y la **1604 no tiene un solo movimiento en mar/abr/may** pese a tener statement en abril. Los TI/TE no netean en **7 de 9 meses** (peor abr: 146 TI contra 104 TE, Δ **$8,727,000**; mar Δ $4,503,000). Ene y feb netean exacto. **Código muerto retirado en `reconciliation()`:** había un `EXCLUDE = {traspaso, factoraje}` que sumaba `bankIn/bankOut` sin ellos y treinta líneas después los **pisaba** con los totales del estado de cuenta, que sí los traen — con un comentario que afirmaba lo contrario de lo que el método hacía. Y queda escrita la razón de fondo, medida: **el lado Kepler TAMBIÉN trae los traspasos**, así que quitarlos de un solo lado desbalancea (excluirlos sólo del banco mueve el Δ de ene de **+$5.4M a −$20.0M** y el de mar de **−$2.2M a −$32.3M**). No había que excluirlos: había que **emparejarlos**. **El hallazgo del Cierre ahora es accionable:** decía «falta el otro lado de un traspaso» sin decir cuál — inservible cuando son 42 patas entre 5,221 movimientos; ahora lista los huérfanos mayores y **nombra la cuenta cuyo estado de cuenta falta**. Frontend: celda «Entre cuentas propias» (rotulada *no es ingreso*), segmento propio en la barra, columna en el desglose por cuenta —sin ella las columnas no sumaban el total de la fila y el faltante parecía un hueco— y un bloque **«no se pudo medir»** en rayado con su acción. Candado extendido a **14/14** con 2 negativas del emparejamiento (el espejo exige OTRA cuenta; un importe desplazado $999,777.13 no casa). Builds api+view verdes. | 🔨 2026-09-24 (local) |
| **CB.48** | **⭐ El complemento de pago SAT tenía la fecha real todo este tiempo — y REFUTA la conclusión de CB.44.** Disparado por una captura de pantalla de Kepler (doc `UA0701-0000214`, suc PH): la ventana «Recepción de pagos SAT» muestra **Fecha de pago 31/07/2026 16:52** mientras la póliza está fechada **12/08/2026**. Vive en `kepler_ods.kdfe33pagm1` y **nadie lo estaba leyendo**. **Lo que se cae:** CB.44 concluyó que *«la causa RAÍZ es de captura, no de código… mientras no se retrofeche, ningún motor puede conciliar por fecha: $6,858,008.40 de cobranza 2026»*. **Sí se retrofecha** — en `c7` del complemento, no en `fecha_valor`. El motor leía el campo equivocado, y el monto declarado irreconciliable **coincide al peso** con los cobros de la suc 01 que TIENEN complemento ($6,858,008). No hace falta cambiar cómo captura la gente. **Decode verificado contra la pantalla**, campo por campo, 7 coincidencias independientes (fecha+hora, forma de pago `01`=Efectivo, moneda MXN, paridad 1.000000, monto $6,784.00, número de operación) — no por corazonada (ERP_KEPLER §5 regla 0). Columnas: `c7` fecha/hora real · `c8` forma de pago SAT · `c12` monto · `c13` nº de operación · `c19` RFC del banco · `c20` CLABE. **Magnitud medida en PROD REAL:** suc 01 **554 de 585** y suc 06 **95 de 95** mueven la fecha, 6.9 y 7.1 días de promedio = **$8,698,578** que la póliza fechaba mal y ahora tienen candidato. (Contra Railway daba $8,472,420: mismo orden, distinto número — por eso se re-midió.) Suc 02/03 casi no mueven: ahí la póliza ya venía bien. **Entrega:** vista `analytics.v_kepler_payment_complement` (**derive-no-copy**, 2,583 filas tras descartar 787 réplicas con `c1=sucursal`) + `_coverage`, y `runMatchTreasury` toma la fecha del complemento cuando existe — incluido el cálculo de `dentro`, para que un cobro tecleado en agosto cuyo pago fue el 31-jul entre en los pases de JULIO. El resultado expone `complemento_sat {usados, dias_promedio, disponibles}`: un cambio que mueve el número tiene que poder mostrarlo. ⚠️ **ALCANCE, para no sobrevenderlo:** el complemento sólo existe para **`U-A-7` (Cobro CFDI)**. El grueso de la cobranza es `U-A-5` del CEDIS — **29,127 cobros / $452M, cero complementos**, porque el SAT sólo lo exige en pago diferido (PPD). Cubre el **~2% del dinero** de cobranza y el **100% del problema**: donde la póliza no trae la fecha real (01 y 06) hay complemento, y donde no hay complemento (00) la póliza ya viene retrofechada. ⚠️ **La CLABE NO rescata cobertura, arbitra:** el feed ya deriva `account_label` de `c45` en el **100%** de los U-A-7, y los dos testigos coinciden en **201 de 202**. Su valor es de verificación — y ya **contradijo uno**: suc 01 folio 0000018, el feed dice 6721 y la CLABE dice 5712 ($9,199). Declarado, no barrido. ⚠️ **Límite declarado:** 2 documentos ($15,241) tienen la póliza a más de 45 días de su pago real y quedan fuera del pool del matcher, que se acota por `fecha_valor`. Candado `test-newdb-kepler-payment-complement.js` **9/9** con 4 negativas. Build api verde. **PROD 2026-09-24: aplicada en prod REAL (`md` `192.168.0.222:5434`, cluster `7688376744939610156`, batch 532) por el auto-deploy** ⛔ **y antes, por error, en Railway (batch 529) — que es la prod VIEJA, congelada desde el 22-sep.** El `FLEET_DB_URL` de una máquina de escritorio apunta a Railway y toda la medición inicial de esta fase salió de ahí; se **re-midió** contra prod real y los hallazgos se sostienen con cifras distintas (ver abajo). Es el mismo error que `[CT.7]`, `[VL.13]` y `[VL.14]`: *un destino equivocado no falla, triunfa en el lugar equivocado*.** — una sola transacción con `lock_timeout`, ejecutando el `up` real de la migración (no una copia del SQL), **sin** `migrate.latest()`: prod tiene 837 migraciones registradas y DOS tablas de control, y un `latest` mal apuntado las reaplicaría. Verificado en vivo: las 2 vistas con `security_invoker=true` y `SELECT` para `app_runtime` (no se heredan al recrear), y el candado **9/9 contra la vista real**. ⚠️ **El código del servicio NO está desplegado**: el API de Railway sigue corriendo el matcher que lee `fecha_valor`. La vista está lista y nadie la consume todavía. **Caso de prueba localizado y medido:** el depósito espejo del doc de la foto EXISTE — cuenta **6721**, **31/07/2026**, **$6,784.00**, concepto *«Venta TLMK PH DIEGO MAESTRO»* (el cliente `c32` del cobro), en el periodo **2026-07** del banco — y está en **`recon_status='pending'`**: nunca se evaluó, porque julio-2026 jamás se concilió (sólo ene y ago tienen matches, del 18-ago). Cuatro coincidencias independientes esperando a que alguien corra el matcher. **Código YA desplegado** en `prod-api` (verificado: el bundle contiene la vista; contenedor reiniciado 23:20 UTC). **Demostrado read-only que el par casa en el pase 1**: del lado Kepler hay **exactamente 1** candidato (`U-A-7 0000214`, $6,784.00, póliza 12/08 / complemento **31/07**, cuenta 6721) y del lado banco **exactamente 1** (6721, 31/07, $6,784, `pending`). Uno a uno, sin ambigüedad. ⛔ **Falta lo único que queda: correr «Conciliar» en 2026-07** — ese periodo tiene **7,223 movimientos, el 100% en `pending` ($159.7M)**: nunca se concilió. | 🔨 2026-09-24 · migración ✅ PROD (batch 529) |
| **CB.49** | **Las pestañas miraban fechas distintas — el resolvedor sube a la vista.** CB.48 metió la fecha real del complemento SAT **sólo en `runMatchTreasury`**, y el resultado fue que el cobro `UA0701-0000214` quedó **casado en la base y «En ContPAQi» en pantalla, a la vez**: la pestaña Cuadre arma su propio pareo, con su propio pool, y ese pool seguía acotado por `fecha_valor`. No era ese pool: eran **once** consultas del servicio filtrando igual. **Entrega:** `analytics.kepler_bank_movements.fecha_efectiva = COALESCE(complemento, póliza)` (mig `20260924230000`, **PROD batch 536**), los 12 filtros del dominio bancos migrados, y `runMatchTreasury` simplificado — ya no carga el complemento por su cuenta, lo lee de la vista, que es lo que impide que alguien se olvide. ⚠️ **`fecha_valor` NO cambia de significado**: sigue siendo la póliza, para quien cuadra contra los libros y para Caja General / `mv_caja_movimientos` / `db-health`. **Tres desalineaciones que nadie había visto y que daban números mal aun con el filtro bien:** `threeWayDaily` filtraba por efectiva y **agrupaba por póliza** (días con movimientos que no sumaban a ningún renglón), el SQL de duplicados restaba el `dup_monto` de un **día ajeno**, y `threeWayDetail` **mostraba** una fecha distinta de la que usaba para parear. **Verificado en prod real:** 0 violaciones del invariante en 49,244 filas · **0 llaves duplicadas** (el LEFT JOIN no multiplica, que era el riesgo de inflar todos los totales) · 153 documentos cambian de mes ($2,030,366) y **124 tienen su depósito esperándolos** · en julio, **27 movimientos ($338,687) ganan pareja** en el Cuadre. El caso de la foto pasa de **0 candidatos** con la póliza a **1 exacto** con la efectiva. ⛔ **Tres fallos propios en el camino, los tres del mismo tipo — la compuerta no cubría lo que yo creía:** (1) un **acento grave** dentro de un comentario del SQL cerró el template literal y la migración **reventó al aplicarse en prod** (`Unexpected identifier`), porque `nx build` no compila `database/**` y **mi candado leía la migración con un REGEX**, que se pone verde con un archivo que ni parsea — es la regla del repo sobre smokes por regex, rota por mí dos commits antes; ahora las **854 migraciones se parsean con `vm.Script`** (~200 ms, sólo parsea, no ejecuta) y la de la fase se `require` de verdad, **probado rompiéndolo**. (2) El renombre de la migración se commiteó con `git commit -- <ruta_nueva>`, y **un pathspec no arrastra la ruta que desaparece**: en `origin/main` quedaron los DOS archivos, la compuerta de `auto-deploy.sh` vio una migración sin aplicar y **frenó el despliegue de los 9 commits pendientes de varias sesiones**. (3) Antes de eso, CB.48 se midió y se aplicó contra **Railway**, la prod vieja. Candado `test-newdb-bank-fecha-efectiva.js` (código + base + sintaxis). **Desplegado en prod 18:25 CST.** | ✅ 2026-09-24 (PROD) |
| **CB.50** | **«En Kepler, sin banco» mezclaba tres cosas, y la de verdad quedaba enterrada.** Reporte de Edgar con ~120 renglones: *«todos estos están sin conciliar»*. Verificado — y sí, ninguno casa 1:1; pero **por tres razones distintas que pedían acciones distintas**, y la pantalla sólo distinguía una (con una aclaración al final del renglón). **Medido en julio-2026 sobre los 3,599 cobros sin casar:** `otro_periodo` **2,793 / $69,920,666** (el banco SÍ lo tiene, en otro mes — desfase de corte) · `banco_agrupa` **750 / $7,849,442** (no existe NINGÚN depósito de ese importe: el banco recibió el dinero junto con otras ventas) · **`sin_casar` 56 / $762,519 — la única excepción real, el 1.6%**. La partición es exhaustiva y se verifica: los tres suman 3,599 exacto. **La evidencia del `banco_agrupa` no es una corazonada:** de 10 renglones tomados al azar, **9 no tienen depósito de ese importe ni en ±60 días**; y el mes entero lo confirma — Kepler registra **3,395 entradas por $78.4M** y el banco **3,091 depósitos por $69.6M**: la misma plata en menos pedazos. Decirle «no existe en el banco» a eso es acusar de un faltante que no hay. **Entrega:** el backend resuelve `motivo` (`otro_periodo` > `banco_agrupa` > `sin_casar`) y lo manda ya decidido — si lo resolviera la pantalla, el drill, el resumen y la tabla podrían discrepar; más los contadores por grupo. El Cuadre los muestra en **tres secciones colapsables**, con la excepción real **primero y abierta** y las dos explicadas cerradas: enterrar 56 renglones bajo 3,543 ya explicados es cómo una bandeja se vuelve invisible. El color marca la ACCIÓN, no la categoría. ⚠️ **Se corrigió una hipótesis propia en el camino:** supuse que el matching se había corrido antes del deploy de CB.49 y que re-correrlo arreglaría la lista; medido, el último match de julio es de las **18:26:32** y el deploy de las **18:25:39** — ya había corrido con el código nuevo. El residuo es estructural (bulto vs partido), no de oportunidad. ⚠️ **Hallazgo para cobranza, no de código:** *José Alberto Saldaña, $38,470 del 14/07* tiene **DOS** documentos de Kepler por el mismo importe y cliente (`U-A-5 0021778` en la cuenta 6721 y `U-A-7 0000053` en la 3041) contra **UN** solo depósito. Parece doble registro; si hay más casos así, inflan la cartera. Builds api+view verdes. | 🔨 2026-09-24 (local) |
| **CB.25** | **Webhook (push) del Sheet** — DIFERIDO hasta tener acceso a Google Cloud. Apps Script `onEdit` debounced → `POST` con secreto → dispara `syncCurrent()` inmediato. Se enchufa encima del sync sin rehacer nada. | ⏸️ diferido |

**Decisiones tomadas (Edgar 2026-07-22):** catálogo **rediseñado limpio** (no migrar códigos Excel); ingesta por **subir el XLSX** en CB.1.
**Decisión (Edgar 2026-08-12):** sync del workbook maestro por **polling + botón** (webhook diferido, sin GCP aún); borrados = **soft-delete por barrido**; cadencia 3 min.

### Estrategia de corte (Edgar 2026-07-22)

Dos fases de operación, con **julio 2026 (mes actual) como línea de corte**:

1. **Histórico → vía Excel (backfill).** Todos los meses **hasta julio 2026 inclusive** se concilian importando los workbooks Excel mensuales con el importer CB.1 (`--file "<MES> 2026.xlsx" --period YYYY-MM`, idempotente). Deja el histórico completo cargado en `finance.bank_*` sin recapturar nada a mano.
2. **Adelante → vía interfaz.** A partir de **agosto 2026** se deja de usar el Excel: los estados de cuenta se suben/capturan y concilian **en `/finanzas/bancos`** (upload web CB.2.1 + reclasificación + motor de conciliación CB.4). El Excel se retira.

**CB.1-backfill (pendiente de insumos):** el importer ya es genérico; falta **cargar los workbooks de feb–jul 2026** (solo tengo enero). Cuando Edgar los provea, se corre el importer una vez por mes (o un loop) → histórico completo. Ver [`CB.1b`] abajo.

## 4. Diferido / decisiones abiertas
- ~~**CB.52.1 — pendiente OPERATIVO:** aplicar~~ ✅ **APLICADA** (batch 977, 2026-10-20 16:04 MX). Era: `20261020155755_bank_rules_comision_tpv_prioridad.js` a prod. La hermana `20261020151727` ya entró (**batch 976**, 15:40 MX) y alcanzó al **98 %**; faltan los **28 movimientos ($8,229.81)** capturados con el código del depósito. Sin DDL → la compuerta la clasifica **NO_MEDIDO y frena al equipo**: va **antes** de mergear. Comando en la cabecera de [`apply-one-migration-prod.js`](../../../database/scripts/apply-one-migration-prod.js). El archivo ya está en `md:/tmp`, **hash verificado** `740cf832eea8e698`.
- **CB.47 — pendiente OPERATIVO (lo que de verdad cierra el descuadre):** cargar los estados de cuenta que faltan — **mar y may: 1604, 1621, 2169, 4885, 5565**; feb: 4885; abr/jun/sep: 3660. Y revisar la **1604**, que en abril tiene `bank_statement` pero **cero movimientos**. Mientras falten, sus traspasos seguirán sin contraparte por diseño: el sistema ya no los acusa de «sin origen», pero tampoco puede inventar la pata que no está.
- **CB.46 — pendiente HUMANO:** ¿quién captura los **14 movimientos de CAJA GENERAL** ($43,285) con fecha **19-ago** dentro del corte de **sep-2026** y **sin concepto**? No son desfase de corte ni typo de año, y ningún umbral puede decidirlo solo.
- **CB.46 — pendiente OPERATIVO (requiere ventana + OK):** los **23 movimientos ya en prod** con el año mal (**$1,579,507**: 17 en `2027-08-06` de la cuenta 7744, 6 en el año `0206` de la 4176). La compuerta evita que entren **nuevos**; los que ya están sólo se arreglan corrigiendo la celda y re-importando el mes, o con un UPDATE puntual. **No se tocó**: es escritura a prod en horario hábil.
- **CB.46 — pendiente OPERATIVO:** **re-correr «Conciliar»** en los 9 periodos. Hoy sólo ene y ago tienen matches, del **18-ago**, y los 9 se re-importaron después; **7 periodos están 100% `pending`** (nunca se evaluaron). Es un POST que escribe: va con ventana.
- **CB.46 — clasificación, ordenada por PESOS y no por filas (R6):** por filas el problema es la **caja** (29.2% de sus movimientos sin categoría en sep); por pesos es **abril, cuenta 4166: $15.7M en 24 movimientos** (`PREPAGO LEM / Retiro de Recursos / disposición crédito`, una línea de crédito revolvente que ninguna de las 36 reglas activas toca). **24 filas, una regla.** Agregar reglas es escritura: va con OK.
- **CB.46 — AJENO a la fase, medido de paso:** `analytics.kepler_bank_movements` hace **Parallel Seq Scan sobre `kdm1`** — escanea **612,087 filas para devolver 452**, **61,308 páginas** (76% desde disco), **7.0 s**. No es latencia ni caché fría: es el plan. La pestaña **Cuadre** lo consume, o sea que hoy tarda >7 s contra un gate de 1 s. El arreglo es un índice, que es DDL sobre una tabla que el CDC escribe cada minuto → **ventana y autorización**.
- ~~**CB.44 — pendiente HUMANO (lo único que resuelve de fondo):** que en la sucursal 01 se capture el cobro con la fecha del depósito en `fecha valor`.~~ ⛔ **REFUTADO por CB.48 (2026-09-24):** la fecha real **ya se captura**, en el complemento de pago SAT (`kdfe33pagm1.c7`); el motor leía `fecha_valor`, que es el día del tecleo. No era «lo único que resuelve de fondo» ni requería cambiar la práctica de nadie — era leer el campo correcto. Sigue siendo **deseable** que `fecha valor` traiga el día real (ayudaría a los `U-A-5`, que no llevan complemento), pero ya no bloquea.
- **CB.44 — sin verificar:** no se confirmó contra `finance.bank_movements` de **prod** si el depósito del 24-jul fue por los $1,653 solos o por el lote completo de $20,565.85 (decide cómo agrupar). Consulta de un minuto, read-only.
- CB.4.1: **fuzzy-name** (contraparte) para subir el match rate por conteo (hoy solo monto+fecha); diferencias (retiros sin casar) → `finance.findings` clase conciliación; **matching de cobranza** por-transacción (hoy control-total: Kepler agrega por plaza, no casa 1:1).
- `kepler_link` por banco (mapear el `102` consolidado de Kepler a cada cuenta) — CB.4; el banco en Kepler vive en `c7` sucio.
- Parser de estado de cuenta crudo por banco (elimina el doble tecleo) — post CB.1.
- `caja_ahorro` → cuenta Kepler exacta por confirmar (¿`205`?).
- `CAJA GENERAL` tiene layout de columnas distinto al de bancos → el importer necesita rama especial.

---

## 5. `[CB.52]` 🚀 La comisión de terminal dejaba de ser comisión porque el banco dice «CREDITO»

**✅ EN PROD, COMPLETO, 2026-10-20** — `20261020151727` (**batch 976**, 15:40 MX) llevó el 98 % y
`20261020155755` (**batch 977**, 16:04 MX) cerró el resto. Verificado leyendo prod con la misma
consulta del antes:

| | Antes | Después |
|---|---:|---:|
| `comision_bancaria` | 0 | **1,590 · $342,603.91** |
| `iva_acreditable` | 1,567 | 1,586 · $54,834.41 |
| atorados en `cobranza` | 25 · $8,209.04 | **0** |
| sin categoría | 800 | **0** |

**Controles, los dos intactos:** los **647 depósitos** de venta con tarjeta siguen en `cobranza`
con **$4,975,481.93**, y el pago de crédito real sigue en `pago_credito` (**36 movs ·
$2,109,268**). Commits locales sin push: `10c7c5a3d` · `73332d8c7` · `092189e5b` · `2e3f2c25e` ·
`ac01b6d2f`.

⚠️ **Observación de paso, NO de esta fase:** 2 `PAGO DE INTERESES` ($33,403.47) están en
`iva_acreditable` porque llegaron con `code 147`. Son de antes (15-oct) y esta migración no los
tocó; si son el IVA del interés están bien, y si no, es otra captura con el código cambiado.
**No medido.**

> ⛔⛔ **Lo que costó, y la lección que vale más que el arreglo.** El archivo se copió a
> `md:/tmp` **antes** de corregirle las prioridades, y al aplicarlo corrió **la versión vieja**:
> reglas en 138/139 con `match_code ^612$`. El ledger quedó diciendo `20261020151727` aplicada
> — con un contenido que ya no es el del repo. **Una migración aplicada no se edita** (el
> ledger describiría algo que nunca corrió): se restauró al contenido que SÍ corrió y la
> corrección vive en una migración hermana.
> ⭐ **El candado que faltaba es de dos líneas: `sha256sum` del archivo local contra el del
> destino, antes de ejecutar.** Al copiar la hermana se hizo, y coincidió (`740cf832eea8e698`).
> Nada en el camino avisa de esto: el script valida la identidad del clúster, no la del archivo.

Salió de medir una afirmación de [`FASE_CP8`](FASE_CP8_PUENTE_CONTPAQI.md) §39.3, que suponía
que ContPAQi llevaba los pagos de crédito «por su módulo de tesorería, no como renglón de
póliza». ⛔ **Refutado:** están como renglón, en `2140110004 BANORTE CREDITO SIMPLE #089386050`
contra `1020080000`. Lo que no cuadraba era **nuestra clasificación**.

La regla `priority 142` (`code ^612$`, concepto `CAPITAL|CREDITO|CRÉDITO|PRESTAMO|…`) se lleva
los cargos `APLI TASA DE DES CREDITO/1750968xx TERMINALES PUNTO DE VENTA`, que son **la comisión
que cobra el banco por cobrar con tarjeta**. Medido en prod (sólo lectura) — la misma comisión
estaba repartida en **cuatro** estados, igual que midió `[CP.8.46]`:

| | Movs | Importe |
|---|---:|---:|
| mal en `pago_credito` | 770 | $202,130.82 |
| variante `DEBITO`, **sin categoría** (ninguna regla la tomaba) | 792 | $131,849.15 |
| capturadas con `code 102`, perdidas en `cobranza` | 21 | $8,124.85 |
| en `iva_acreditable` sin ser IVA | 7 | $499.09 |
| **→ `comision_bancaria`** | **1,590** | **$342,603.91** |
| el IVA de esa comisión que llegó con otro código **→ `iva_acreditable`** | 26 | $1,425.45 |
| pago de crédito REAL (`PAGO DE CAPITAL`/`DE INTERESES`), **no se toca** | ~4/mes | $230k/mes |

⚠️ **Las reglas van en prioridad 54 y 55, no en los 130.** La `61` (`type ^I$`) y la `70`
(`code ^102$`) mandan a `cobranza` antes de llegar ahí, y 21 de esas comisiones vienen
capturadas justamente con el código del depósito. Por eso tampoco llevan `match_code`: el
código del renglón es lo que viene mal.

⚠️ **Falso positivo declarado:** de los ~3,176 movimientos con esa frase, **uno** trae el
importe en depósito ($114.01, 24-jul — parece devolución de comisión) y queda en
`comision_bancaria`. El motor clasifica por texto y no ve el importe.

Contabilidad ya las lleva bien: **85 de 85** de la muestra jul–sep >$500 tienen su línea en
`611-003 COMISIONES BANCARIAS`, a **−3 a +14 días** del movimiento bancario (⭐ sirve para
calibrar la ventana del motor). Control placebo con un importe inventado: 0 coincidencias.

⚠️ **Por qué el regex es estrecho.** `TERMINALES PUNTO DE VENTA` a secas también está en el
**depósito** de la venta con tarjeta: **672 movimientos / $4,983,804.98** hoy correctos en
`cobranza`. Una regla por esa frase sola convertiría cinco millones de ingreso en comisión. Las
dos reglas nuevas exigen `code = 612` **y** `TASA DE DES(C)? (CREDITO|DEBITO)`.

⚠️ **El IVA de esa comisión** ya iba bien a `iva_acreditable` con `code 147` (1,567 movs); **9
llegaron con `code 612`** y quedaban sin categoría → los toma la regla `138`.

Candado: [`bank-classify-comision-tpv.spec.ts`](../../../libs/finance/src/lib/bank/bank-classify-comision-tpv.spec.ts)
— 11 casos con conceptos textuales de prod + **3 pruebas negativas**: sin la regla, la comisión
vuelve a `pago_credito` y la variante `DEBITO` a `sin_clasificar`; y **con la regla correcta pero
colocada en 139**, la comisión con `code 102` se pierde en `cobranza` mientras la de `612` sigue
bien — o sea, el defecto de prioridad sería invisible sin ese caso. **14/14 verde, mutado a rojo
dos veces** (quitarle `DEBITO` al regex, y bajar la regla a prioridad 139).

⛔ **Lo que NO cierra:** el motor de clasificación vive **duplicado** — `classifyWith` en
`finance-bank.service.ts` y una copia en `import-bank-statement.js`. El candado prueba la del
servicio. Unificarlo es deuda con nombre (ADR-056).

---

## 6. `[CB.53]` 🧪 La conciliación corre al llegar el dato, no por reloj

**EN CÓDIGO 2026-10-21** · commit `abd55a602` · sin migración · **apagado por defecto**.

**El defecto:** `runMatch` sólo corría apretando un botón. Medido el 21-oct, el último pareo era
de la tarde anterior y **octubre llevaba 62.9 % casado contra el 89.1 % de septiembre** — no
porque el motor falle, sino porque nadie lo volvió a correr.

⛔ **No es un `@Cron`** (Edgar, 2026-10-19: *«nada de crons»*). Se reusa el carril que ya corre en
producción: `feeds-ingest` emite `NOTIFY caja_fuente` cuando su UPSERT toca `kepler_ods.kdm1` o
`kdb1` — las dos tablas de las que deriva `analytics.kepler_bank_movements`.

⭐ **Y acá, a diferencia de Caja, no hay que esperar ningún refresh:** esa es una **VISTA viva**
(verificado en prod), no una matvista. Caja tuvo que escuchar el aviso *posterior* al refresh
porque lee `mv_caja_movimientos`; de este lado el dato ya está cuando llega el aviso.

**Lo que cuesta una corrida** (prod, sólo lectura, 21-oct): lado Kepler **2.41 s** en frío ·
1.01 s caliente (12,429 filas, ventana ±45 d) · lado banco **0.45 s** (3,943 filas). ⚠️ El
comentario del propio motor decía «~7 s» — esa cifra envejeció. Por eso el aviso **no dispara el
motor directo**: espera el silencio de la ráfaga (`quiet` 60 s) y compara la **firma** del
periodo (filas + última fecha + centavos, de los dos lados). Firma igual = no corre, y lo dice.

**Qué periodos re-evalúa:** el mes en curso y, hasta el día 20, también el anterior. No es un
número elegido: el lag de captura de Kepler tiene **mediana 2–5 días y máximo 19**, así que un
documento del mes pasado puede llegar hoy y sin esa ventana no vuelve a tener quien lo busque.

**Candados:** 15 casos del motor puro + **3 pruebas negativas** (con el corte en 0 el mes
anterior deja de mirarse; sin firma todo aviso correría; los 4 motivos de NO correr son distintos
entre sí, ninguno es un `return` mudo). 29/29 verde en el área, **mutado a rojo una vez**.

⛔ **Lo que FALTA para que esto sirva** (hoy no hace nada):

1. **Desplegar.** El worker corre la imagen vieja; el oyente no existe allá todavía.
2. **Prender `ENABLE_BANK_RECON_AVISO=true`** en el worker. Apagado por defecto a propósito:
   `runMatch` **escribe**, y desplegar no debe ser, por sí solo, empezar a conciliar.
3. **Ejercerlo contra base real.** Un camino que escribe no está probado hasta que corrió
   (regla dura del proyecto). Los candados prueban la decisión, no la escritura.

⚠️ **Hueco declarado:** la carga del estado de cuenta **no emite ningún aviso**, igual que el
carril de pólizas `kdc2*` (`[CG.198]`). En la práctica se tapa solo porque cada corrida
re-evalúa el periodo entero — un estado de cuenta cargado a las 10:00 lo recoge el primer aviso
de Kepler posterior — pero **no está garantizado por construcción**.

## 7. `[CB.54]` 🧪 Egresos que el motor de reglas dejaba sin categoría (2026-10-22)

Lo encontró la búsqueda de «Oscar Hernandez» en el puente ContPAQi (`[CP.8.78]`): su pago no aparecía porque
no tenía categoría. Medido en prod (sólo lectura), ene–oct 2026: **5,686 egresos sin categoría, $53.2 M**
(banco 1,182 / $40.6 M · Caja General 4,504 / $12.5 M), 12–26 % cada mes. Todos `classified_by='rule'`: el
motor corrió y devolvió `sin_clasificar`. **Sólo 234 categorizaciones manuales en el año.**

| Hueco | Ejemplo | Arreglo (migración `20261022125305`) |
|---|---|---|
| Texto en la columna de **código**, concepto vacío (BANORTE 7744, SANTANDER 2169) | «Comision», «Nomina 06», «PAGO DE CAPITAL…» | reglas por `match_code` (880–883) |
| Nómina / traslado de valores / SUA con un código que su regla no espera | «Servicio Panamericano» en 613 | reglas por concepto, cualquier código (900–903) |
| Línea de crédito revolvente LC/PLEM/PL/TL con código «/» | «CREDITO LIQUIDO DISP… COBRO» | `traspaso_entre_cuentas`, como los 9 ya categorizados (890) |
| **Beneficiario con nombre propio** en 612/613 | «Oscar Hernandez», «Valentin Oyanguren» | ⛔ **no lo resuelve ninguna regla**: memoria por beneficiario (pendiente) |

Simulado con el motor real (control 30,915/30,915): **213 de 2026 categorizados ($21.7 M), 0 cambios** a lo ya
categorizado. Descartado: usar el código como concepto cuando viene vacío (mandaba 71 «Comision» bancarias a
`comisiones_venta`). Prueba `bank-rules-cb54.spec.ts`. ⚠️ **NO aplicada en prod** al cerrar esta sección.
Pendientes: memoria por beneficiario + aviso «N sin categoría» en Bancos; Caja General (4,504) es de la fase CGA.
