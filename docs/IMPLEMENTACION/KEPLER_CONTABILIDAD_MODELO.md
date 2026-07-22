# Kepler — Modelo contable (pólizas `kdc2`) descifrado

> **Qué es esto:** el mapeo del **libro contable** de Kepler (pólizas de diario mensuales `kdc2YYMM` + catálogo de cuentas `kdco`), derivado empíricamente de la data viva de **`md_00`** (empresa principal / CEDIS de Mega Dulces).
>
> Complementa a [`ERP_KEPLER_SCHEMA.md`](ERP_KEPLER_SCHEMA.md) (que cubre las tablas de **producto/inventario**: `kdii`, `kdil`, `kdik`, `kdm1/kdm2`). Este doc cubre la **contabilidad financiera**.
>
> **Cómo se derivó (2026-07-06):** análisis adversarial familia-por-familia (7 familias de cuenta) + 4 cross-checks de identidades contables sobre 12 meses de pólizas (`kdc22508`…`kdc22607`) vía agentes contra `postgresql://platform_ro@192.168.9.95:5432/md_00`. Es difícil de re-derivar — **mantener vivo**.
>
> **Origen práctico:** este análisis nació validando el feed de egresos (`/comercial/egresos`, ver [`FASES/`](FASES/) y el importer `database/importers/kepler/import-expenses-polizas.js`). Explica por qué las compras 511 y las ventas 401 requieren tratamiento especial por período.

---

## ⭐ El hallazgo transversal (lee esto primero)

**La contabilidad "de verdad" (documento-a-documento) de `md_00` arranca entre dic-2025 y ene-2026.** Antes, TODO el P&L (ventas, compras, gastos) se capturaba en **modo resumen mensual contra la cuenta puente `999 PRESUPUESTOS`** — una póliza por mes, sin factura, sin folio.

| Proceso | Modo resumen/presupuesto (contra 999) | Captura documento-a-documento |
|---|---|---|
| **Compras (511)** | ene 2025 → dic 2025 | desde **dic-2025** (factura vs 201) |
| **Gastos (6xx, 7xx)** | ene 2025 → dic 2025 | desde **ene-2026** (XA1001 vs 201/203) |
| **Ventas (401)** | ene 2025 → dic 2025 | desde **ene-2026** (UD1301 vs 115) |

**Consecuencias que afectan CUALQUIER reporte:**
1. Una serie de "12 meses" tiene en realidad **~7 meses de operación real + ~5 meses de estimados presupuestales**.
2. **dic-2025 está DOBLE** en varias cuentas (convivieron el presupuesto y las primeras facturas).
3. Los agregados 2025 **no son comparables** con 2026 (peras vs manzanas).
4. Nov y dic 2025 se postearon **el día 7 del propio mes** → son forecast, no cifras reales.

---

## Estructura de las tablas

### Pólizas: `kdc2YYMM` (una tabla por mes)

`kdc2` + `YY` + `MM`. Ej: `kdc22607` = julio 2026, `kdc22512` = dic 2025.

| Columna | Significado | Notas |
|---|---|---|
| `c2` | fecha de la póliza | ⚠️ puede ser retro-fechada (fecha ≠ captura) |
| `c3` | **cuenta contable** | `'511'` (mayor) o `'601-001'` (subcuenta). Mayor = `split_part(c3,'-',1)` |
| `c4` | `'C'` = cargo · `'A'` = abono | naturaleza del movimiento |
| **`c5`** | **importe** | ⚠️ USAR c5 — `c9` llega en 0 a veces |
| `c6` | concepto / beneficiario | texto libre (proveedor, canal, "COMPRA-MES"…). Sucio: typos, truncados |
| `c10` | línea dentro de la póliza | |
| `c14` | sucursal | |
| `c15..c18` | componentes del tipo de documento | `doc_tipo = c15\|\|c16\|\|lpad(c17,2)\|\|lpad(c18,2)` (ej. `XA2001`) |
| `c19` | folio del documento | **vacío/null en pólizas de resumen/diario** (presupuesto, cierres, ajustes) |

**Regla de oro:** filtrar `c5 > 0` en cualquier agregado — hay cientos de líneas `$0` de documentos cancelados (`'BAJA - XA20001-…'`, `'Póliza cancelada'`) que inflan los conteos sin afectar montos.

### Documentos fuente: `kdm1` (cabecera) + `kdm2` (líneas)

Detrás de cada póliza hay un documento. Descifrado 2026-07-06 (reconciliación 12/12 exacta vs pólizas).

- **Llave** (une póliza ↔ documento ↔ líneas): `(sucursal, doc_tipo, folio)` =
  `kdc2.(c14, c15‖c16‖lpad(c17,2)‖lpad(c18,2), c19)` = `kdm1.(c1, c2‖c3‖lpad(c4,2)‖lpad(c5,2), c6)`. ⚠️ el folio **solo** no es único entre tipos — filtrar por doc_tipo completo.
- **`kdm1`** (cabecera, ~82k filas): `c6`=folio · `c9`=fecha contable · `c18`=fecha doc · `c14`=IVA · `c16`=total · `c22`=RFC · `c24`=concepto · `c31`=clase (Apl/Gas/Fac/Tra/Sol) · `c32`=beneficiario · `c48`=área · `c67`=usuario que capturó · `c37/c39`=doc origen (solicitud XA1501 para gastos).
- **`kdm2`** (líneas, ~180k filas): misma llave (c1..c6) + `c8`=SKU · `c9`=cantidad · **`c10`=nombre del producto** · `c11`=presentación · `c12`=costo unitario · `c13`=importe de línea.
- **Cobertura:** las **compras (XA2001)** SÍ traen líneas de producto (7,055/7,335 docs, ~5 líneas/doc). Los **gastos (XA1001)**, **pagos (XD2601)** y **solicitudes (XA1501)** NO tienen líneas en kdm2 — su detalle es la cuenta contable + (gastos) la solicitud enlazada.

**Feature GX v3 — desglose en la interfaz (`/comercial/egresos`):**
- **Drill al documento:** clic en un documento → cabecera (proveedor/RFC/concepto/área) + posturas contables + líneas de producto. Tablas `analytics.expense_documents` + `analytics.expense_document_lines`, feed `import-expenses-polizas.js`, endpoint `GET .../expenses/document`.
- **Vista Proveedores:** auxiliar de la cuenta 201 (compra, pagos, saldo, #facturas, DPO) reconstruido en `analytics.ap_provider` (feed `import-ap-findings.js`), endpoint `.../expenses/providers`.
- **Vista Hallazgos:** las anomalías contables navegables (no CSV) — `iva_bug` (XD5501 con 122-001 huérfano), `prov_203` (provisiones sin descargar), `anticipo_107` (anticipos sin aplicar). Tabla `analytics.expense_findings`, endpoint `.../expenses/findings`.
- **Vistas Área y Beneficiario:** ya disponibles vía `group_by` del reporte.

### Catálogo de cuentas: `kdco`

`c3` = código, `c2` = nombre. **⚠️ Catálogo sucio** — NO es llave única por `c3`:
- **Códigos duplicados con nombres distintos:** `115` = `'CARGO A CLIENTES'` y `'ABONO A CLIENTES'`; `761` = `'IMPUESTO ISR'` y `'SAT'`; `511`, `401-001/002/003`, `760`, `702-002` también duplicados.
- **Cuentas fantasma (movidas pero SIN fila en kdco):** `107`, `122-002`, `203`, `205`, `206`, `403`, `512`, el mayor `401`, el mayor `702`, el mayor `517`.
- **Nombres incoherentes:** el mayor `140` = `'EQUIPO PARA SOLDAR'` cuando `140-001` son préstamos.
- **Familia 6 (gastos):** `kdco` es un catálogo de **CONCEPTOS**, no de cuentas — N conceptos mapean a 1 subcuenta. Un `JOIN` por `c3` **duplica filas**; usar `min(c2)` o el concepto de la póliza (`c6`).

---

## Las 7 familias de cuenta (`md_00`, 12 meses)

Naturaleza y volumen observados. Montos redondeados.

| Fam | Tema | Cargos 12m | Abonos 12m | Cuentas mayor con movimiento |
|---|---|---:|---:|---|
| **1** | Activo | $1,474M | $1,449M | 102, 103, 107, 114, 115, 116, 122, 140, 150 |
| **2** | Pasivo | $349M | $430M | 201, 203, 205, 206, 210 |
| **4** | Ingresos | $55M | $726M | 401, 403 |
| **5** | Costos | $1,467M | $799M | 509, 511, 512, 513, 514, 515, 516, 517 |
| **6** | Gastos operación | $71M | $3M | 601–613, 659 (111 subcuentas) |
| **7** | Otros gastos | $3.9M | $0 | 702, 760, 761, 762, 763 |
| **9** | Presupuestos | $339M | $356M | 999 (única) |

### Familia 9 — `999 PRESUPUESTOS` (la pieza que explica todo)

No es una cuenta de control presupuestal: fue **el pivote de todo el P&L 2025**. Cargaba contra ventas (`999`↔`401`) y abonaba contra compras (`511`↔`999`) y gastos (`6xx`↔`999`). 172 movimientos, todos pólizas de diario sin folio.
- **Murió en ene-2026** al arrancar la captura por documento. Único uso posterior: 1 ajuste de $7.4M (mar-2026).
- **Quedó con saldo acreedor residual ~$27.4M que nadie cerró** contra resultados.
- Corrección: el mecanismo arrancó en **ene-2025**, no ago-2025.

### Familia 4 — Ingresos (`401`, `403`)

- **`401` VENTAS** — abonos brutos ~$726M PERO:
  - Incluyen **$54.67M de una reclasificación interna** (`'VENTAS ABRIL 26'`, vive en la tabla de marzo `kdc22603`, `C 401-002 ↔ A 401-001/003/004`, neto $0) → **venta real ≈ $671M, no $726M**.
  - ago-dic 2025 ($339M) son pólizas resumen contra 999 (nov/dic = forecast).
  - **Todo el detalle 2026 cae en `401-002`** sin importar canal → las subcuentas NO sirven para mezcla de canal; el canal real vive en `c6` (P.V., TLMKT, R.D., R.V.).
  - **⚠️ El NOMBRE de `401-002` es basura y engaña:** `kdco` de CEDIS la llama `'VENTA FLETES A TERCEROS'` y otra sucursal `'VENTAS VECINAL'` — **ninguno es cierto**. NO es fletes ni vecinal: es la cuenta de venta CONSOLIDADA de todo. Clasificar SIEMPRE por `c6`, nunca por el nombre de subcuenta.
  - **⚠️ DOS reglas críticas para contar la venta 401 (verificado 2026-07-22):**
    1. **SOLO CEDIS (`md_00`, c14='00').** La venta se contabiliza CENTRALIZADA en CEDIS con TODAS las plazas en `c6` ('P.V. 8 Esquinas', 'TLMKT Canindo'…). Las DBs de sucursal **replican** esas mismas ventas → sumar las 6 **duplica ~$62M**. La cobranza `UA0501` ($314.8M) solo cuadra con CEDIS.
    2. **SOLO el documento de venta `UD1301`** (`doc_tipo = c15‖c16‖lpad(c17,2)‖lpad(c18,2)`). Los otros doc_tipo en 401 (`UD1201` $10M notas, `0000`, `XA1001` bajas) NO son venta. Los postings "CONTADO" que no son UD1301 son resúmenes que duplican.
  - **Venta real 2026 = `$357.5M`** (CEDIS, UD1301) — cuadra con `sales_daily` (~$343M) y con la cobranza. Composición por `c6`:

    | Canal (`c6`) | 2026 | Qué es |
    | --- | ---: | --- |
    | Mostrador (`P.V.`/`PISO`/`SUCURSAL`) | $204.1M | Piso de ventas por plaza |
    | Telemarketing (`TLMKT`) | $94.0M | Mayoreo/televenta — **lo que `sales_daily` NO captura** |
    | Ruta (`R.D.`/`RUTA NN`) | $33.5M | Reparto (501–504, 21–28, Morelia 321) |
    | Otro (nombre de cliente) | $19.3M | Crédito individual sin prefijo de canal |
    | Reparto vecinal (`R.V.`) | $6.4M | |
    | Contado | $0.2M | |

    → Feed: [`import-sales-by-channel.js`](../../database/importers/kepler/import-sales-by-channel.js) → `analytics.sales_by_channel_monthly`. 2025 no aplica (fue presupuesto, sin UD1301).
  - **⚠️ El P&L se consolida en CEDIS (sucursal '00'); NO sumar las 6 sucursales.** Las DBs de sucursal REPLICAN la venta (fam 4) y el costo (fam 5) que CEDIS ya centraliza → sumar toda la red duplica (~+$59M ingresos, +$79M costo) y hunde el margen bruto de **17.6% (correcto, CEDIS-solo) a 10% (mal)**. El `ledger_monthly` guarda las 6 sucursales (necesario para el balance/fam 1-2, que sí son locales), pero **cualquier P&L filtra `sucursal='00'`**. Corregido: `maat_pnl` ahora hace default a '00'. **P&L 2026 real (CEDIS): ingresos $357.7M − costo $294.8M = bruta $62.9M (17.6%) − gastos $39.5M − otros $5.2M + fam9 $7.4M ≈ utilidad neta ~$18-26M (5-7%)** (rango por el tratamiento de fam 9 y el corte de inventario post-abr).
  - Pólizas de venta **sin línea de IVA** (`C 115 = A 401` exacto).
- **`403` devoluciones/NC reales** — solo $667k/12m. No existe en kdco. **Los "$55M de cargos a 401" NO son devoluciones** (son la reclass + fletes neteados).

### Familia 5 — Costos (sistema de inventarios periódico)

Juego completo del costo: `Costo = 509 inv.inicial + 511 compras + 514 gastos compra + 517 insumos − 512 devol − 513 desc − 516 inv.final`.

- **`509` inv. inicial / `516` inv. final** — asiento mensual (doc `0000`) contra `114`. `516[mes M] = 509[mes M+1]` exacto. **⚠️ El cierre se cortó en abril-2026** → sin costo de ventas real desde mayo.
- **`511` COMPRAS** — **$685.6M** (el dato viejo "$1,369M" era FALSO, ~2x inflado). Dos capas:
  - Presupuesto (`C 511 / A 999`) ago-dic 2025 = $313.2M.
  - Factura (`C 511 / A 201`) desde dic-2025 = $379.8M.
  - **DIC-2025 DOBLE:** presupuesto $75.3M + facturas $63.1M el mismo mes (~$63M duplicado).
  - **$16.45M de IVA cargados dentro de 511** (pólizas `'IMPUESTO EN COMPRAS'`, ene-mar) → costo inflado esos meses.
- **`513` desc. sobre compras** neto ~$10.2M (bruto $17.6M − ajuste $7.4M "año pasado"). Se registra en el asiento de **PAGO** (`C 201 / A 513`), no en el de compra.
- **`515` ajuste traspaso interno** ↔ **`116`** = movimiento de mercancía CEDIS↔sucursal. **NO es compra ni venta externa.** Cuadraba en $0 exacto ene-mar; descuadra desde abr (−$1.9M may). Mueve ~$210M/año (30% del volumen de venta).
- `512` devol. compra $519k · `514` gastos compra $2.26M · `517` insumos empaque $38k (menores).

### Familia 1 — Activo

- **`102` BANCOS Y CAJA** — **17 cuentas bancarias comparten el código `102`** (el banco va en `c7` texto libre, a veces es una fecha) → imposible auditar por banco desde la contabilidad. Cobranza entra por `UA0501` (`C 102 / A 115`); pagos salen por `XD2601/XD2501` (`C 201 / A 102`).
- **`115` CLIENTES** — cartera en una sola cuenta (detalle por cliente NO está en contabilidad, vive en el auxiliar). DSO ~7-8 días. Venta crédito `C 115 / A 401` (UD1301); cobranza `C 102 / A 115` (UA0501, ~$314M, cuadra al peso).
- **`114` INVENTARIO** — solo asiento mensual de apertura/cierre (~$60M). Corte en abr-2026.
- **`107`** (fantasma) — $11.4M de anticipos a proveedores (`C 107 / A 102`, doc XD6001) que **JAMÁS se aplican** (0 abonos) → posible doble conteo del flujo a proveedores.
- **`150` activo fijo** — **sin depreciación registrada** en 12m; compra de vehículos usados directo a la cuenta; un abono de $967k sin documento.
- `116` traspasos (+$3.1M descuadre, ajustado a fin de mes) · `122` IVA acreditable (con reclasificaciones que ensucian) · `103`/`140` préstamos.

### Familia 2 — Pasivo

- **`201` PASIVO A PROVEEDORES** — cuenta plana (proveedor solo en `c6`, con typos que duplican). El **"+$66M de deuda creciendo" es artefacto de captura**, no deuda real: dic-2025 cargó el backlog de facturas sin sus pagos históricos. En régimen 2026 la deuda **baja** (−$14.6M ene-jun). NOMINA opera como "proveedor" aquí.
- **`203`** (fantasma) — **$13.6M de provisiones (nómina, IMSS/SUA, SAT, Banorte) que JAMÁS se descargan** (0 cargos). Los pagos de nómina salen por 201 → descuadre estructural ~$2.2-2.6M/mes desde may-2026.
- **`210` "FACTORAJE"** — nombre engañoso: son **préstamos de la dirección** (Rodolfo Sepúlveda, etc.) y crédito Banorte. Nunca toca el banco (entra por 103, paga por 203).
- `205` IVA trasladado de fletes ($28k) · `206` un préstamo ($500k).

### Familia 6 — Gastos de operación

- **`601` nómina = 54% de la familia** ($38M): sueldos, finiquitos, SUA/IMSS parcial, PTU.
- **`609` gastos de dirección/dueños ($2.4M/año anualizado):** tarjetas de crédito y compras Liverpool de los directores + **"préstamos personales GLG/LFLG" registrados como GASTO** (no como cuenta por cobrar a socios) — fiscalmente cuestionable.
- **Error notable:** $2.07M de inventario inicial de nov-2025 mal posteados a `603-004` (internet/teléfono).
- `602` flota/logística · `603` rentas/servicios · `605`/`613` TI-Kepler (partido en dos mayores) · `606` trade marketing (bonos a capitanes de marca, candidato a conciliar con el módulo de la app) · `608` admin · `611` gasto de venta · `612` robo/asalto · `659` mermas ($96k/año = 0.15% del inventario, implausiblemente bajo).

### Familia 7 — Otros gastos (financiero + impuestos)

- **`702` financiero** — **$1.54M de "intereses en efectivo" pagados a la dirección** (Carmen Rodríguez Vera) = financiamiento informal de parte relacionada; 39% de la familia.
- **`762` SUA solo captura ~12% del costo IMSS** (el 88% va a 601) → NO usar 7xx como proxy de carga social.
- `760` predial/cedular · `761` ISR/SAT (con **recargos recurrentes** = pagan tarde) · `763` 3% estatal sobre nómina.
- Todo capturado en **ráfagas retro-fechadas** (SUA: 30 líneas en un solo día) → las series mensuales no reflejan devengo.

---

## Cross-checks de identidades contables (verificados)

### ✅ Ciclo de compra — cierra al 99.7%
Compra `C 511 / A 201` → pago `C 201 / A 102` (94.1%) + descuento `A 513` (5.0%). La deuda de proveedores **no crece en régimen**. Única fuga: el doble conteo de dic-2025 (~11% del año).

### ✅ Ciclo de venta — cierra al peso
- **100% a crédito** contable: toda venta se asienta `C 115 / A 401`; **NO existe póliza de contado** (`C 102 / A 401`). El "contado" es económico (se cobra en ~7 días).
- **Cobranza = banco EXACTO** los 7 meses: `UA0501` abona 115 $314,845,460.38 = carga 102 $314,845,460.38. Sin fugas.
- **DSO ≈ 7-8 días** (cobranza cuasi-inmediata). Cartera se estabiliza en ~$13.3M; el "+$14.6M de crecimiento" es engañoso (+$18.5M es solo el arranque de enero; feb-jul en realidad drena −$3.9M).
- **Sin IVA trasladado:** ratio `C 115 / A 401` = 1.000087 (con IVA 16% sería 1.16). Ventas posteadas netas — a validar con contabilidad dónde se reconoce el IVA.
- Los "cargos a 401" fuera de la reclass ($48,917) son **bajas/cancelaciones, NO fletes** (hipótesis de fletes descartada). Devoluciones reales = `403` vía `UA2501` ($668k).

### ⚠️ Partida doble — NO cuadra desde ene-2026
2025 cuadra a centavo. Pero ene-2026→jul-2026 descuadra **−$981k acumulado** (abonos > cargos). **Causa raíz (96%):** las pólizas de descuento sobre compras `XD5501` postean un **abono huérfano a `122-001` IVA ACREDITABLE sin contrapartida de cargo** (idéntico al descuadre en 406/447 pólizas). Corre ene-may, se autocorrige en junio. **Efecto:** el IVA acreditable queda subestimado ~$996k → riesgo de conciliación fiscal.

### ✅ Ciclo de inventario / margen bruto — articulación cuadra, margen volátil por diseño
Sistema **periódico**: el conteo físico (`516`) es el *plug* → el margen mensual se mueve con el ΔInventario, no con la operación. **No usar el margen de un solo mes.**

- **Articulación exacta:** 8/9 enlaces `516[M] = 509[M+1]` al peso; único desfase $49.92 (dic-2025→ene-2026), inmaterial.
- **Fórmula del COGS:** `INV_INI(509) + COMPRAS(511) − desc(513) − devol(512) + gastos compra(514) + insumos(517) − INV_FIN(516)`.
- **Traspasos `116`/`515` quedan FUERA del COGS** (netean ~$0, `C=A` exacto ene-mar). Sumarlos duplicaría ~$34-40M/mes.

| Mes | COGS derivado | Venta | Margen | Nota |
|---|---:|---:|---:|---|
| ago-2025 | $56.96M | $56.88M | −0.1% | presupuesto vs presupuesto (no real) |
| sep-2025 | $55.86M | $56.24M | 0.7% | budget-vs-budget |
| oct-2025 | $55.75M | $65.84M | 15.3% | budget |
| nov-2025 | $59.53M | $65.23M | 8.7% | budget |
| dic-2025 | $62.36M | $94.92M | 34.3% | **inflado** (venta-resumen $94.9M; compra=factura $63.1M, excluido presup $75.3M) |
| **ene-2026** | $45.91M | $58.70M | **21.8%** | real (limpio) |
| **feb-2026** | $43.47M | $52.40M | **17.0%** | real |
| **mar-2026** | $41.43M | $54.51M | **24.0%** | real (limpio) |
| **abr-2026** | $54.15M | $56.74M | **4.6%** | outlier (conteo bajó $5.5M) |
| may-jul 2026 | — | (venta sí) | **N/D** | **sin cierre de inventario** → COGS no computable |

- **Margen real 2026 (ene-abr agregado) = 16.8%** ($37.4M sobre $222.3M), justo bajo la banda esperada 18-28%, **arrastrado por abril**. Los meses limpios (ene 21.8%, mar 24.0%) promedian ~23%, **dentro de banda** — sano para distribuidora de dulces.
- **2025 no es margen real** (venta y compra ambos presupuesto).
- **Crítico confirmado:** hay que excluir el IVA de 511 — incluir los $16.45M de "IMPUESTO EN COMPRAS" bajaría el margen de enero de 21.8% a ~13%.

---

## Implicaciones para feeds y reportes (accionable)

| Métrica | Regla al construir el feed |
|---|---|
| **Compras (511)** | Elegir UNA capa por mes: presupuesto (ago-nov 2025) o factura (dic-2025+). En dic-2025 preferir factura ($63.1M), descartar presupuesto ($75.3M). Excluir traspasos internos (`515`/`116`) y beneficiario interno CEDIS↔sucursal. Los $16.45M de "IMPUESTO EN COMPRAS" (ene-mar) inflan el costo. → *Ya implementado en `import-expenses-polizas.js`.* |
| **Ventas (401)** | Restar la reclass intra-401 ($54.67M en marzo). Venta real ≈ $671M, no $726M. ago-dic 2025 = presupuesto (nov/dic forecast). Canal real en `c6`, NO en subcuenta. |
| **Costo de ventas / margen** | Solo computable ago-2025 → **abr-2026** (cierre de inventario cortado). May-jul 2026 NO tienen costo real en libros. |
| **IVA acreditable** | Subestimado ~$996k ene-may 2026 por el bug de `XD5501` — no confiar en el saldo de `122` para conciliación. |
| **Flujo de caja / pagos** | Solo `XD2601`+`XD2501` son pagos con dinero; `XD5501` son descuentos. Sumar todos los cargos de 201 sobreestima egresos ~6%. |
| **Carga social / IMSS** | NO usar familia 7 (762 = 12%); el 88% del IMSS está en 601. |
| **Cualquier agregado** | Filtrar `c5 > 0` (líneas $0 de cancelaciones). JOIN a `kdco` por `c3` duplica en familia 6. |

---

## Anomalías priorizadas (para contabilidad)

1. **Doble conteo dic-2025 en 511** (~$63M) — presupuesto + factura sin reversa.
2. **Partida doble rota ene-may 2026** (−$996k) — IVA acreditable huérfano en `XD5501`.
3. **203 (fantasma) acumula $13.6M** de provisiones que nunca se descargan.
4. **Cierre de inventarios cortado** desde may-2026 (sin costo de ventas real).
5. **107 anticipos ($11.4M) nunca aplicados** — posible doble flujo a proveedores.
6. **Préstamos a socios (609) tratados como gasto** — cuestionable fiscalmente.
7. **Activo fijo sin depreciación**; CAPEX ($135k servidor) cargado a gasto.
8. **Catálogo `kdco` sucio** — cuentas fantasma, códigos duplicados, nombres incoherentes.
9. **Intereses en efectivo a la dirección** ($1.54M) — financiamiento de parte relacionada.
10. **Impuestos retro-fechados en lotes** + recargos SAT recurrentes (pagos extemporáneos).

---

*Derivado: 2026-07-06 · fuente `md_00` vía `platform_ro` · método: análisis adversarial multi-agente sobre 12 meses de pólizas. Ver también [`ERP_KEPLER_SCHEMA.md`](ERP_KEPLER_SCHEMA.md), [`KEPLER_CATALOGO_TABLAS.md`](KEPLER_CATALOGO_TABLAS.md).*
