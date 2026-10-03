# Mapa — ingresos y egresos en `/presupuesto`

> **Qué es esto.** Edgar: *«necesito que agreguemos los ingresos y egresos a /presupuesto. para
> esto necesito que generemos un mapa»*. Esto es el mapa: de dónde sale cada peso, con qué grano,
> sobre qué universo, por dónde se une al presupuesto y **qué no se puede unir**.
>
> **Todo lo de acá está MEDIDO contra prod el 2026-10-02**, no estimado. La ventana de referencia
> es **enero–septiembre 2026** (meses cerrados) salvo donde se diga otra cosa.
>
> Hereda ADR-066 (Presupuestos), ADR-073 (presupuesto de gasto auto-propuesto), ADR-074
> (materialización plan → ledger), ADR-056 (lo que no se puede medir se DECLARA) y ADR-059 (cada
> número se arbitra).

---

## 1. El hallazgo que cambia el pedido

⭐ **Casi todo lo que se pide YA ESTÁ CONSTRUIDO. Lo que falta no es código: son datos y dos
decisiones.** Medido en la base de prod:

| pieza | ¿existe el código? | filas en PROD |
|---|---|---:|
| Plan de **ventas** (la meta) — `budget.sales_plan_lines` | ✅ Fase PV | **418** |
| Real de **ventas** — `analytics.v_sellout_daily` rolado 13×4 | ✅ `BudgetSalesComparisonService` | — (vista viva) |
| Plan de **gastos** (propuesta) — `budget.expense_plan_lines` | ✅ Fase PVG / ADR-073 | **0** |
| Real de **gastos** — `analytics.expense_entries` por mes | ✅ ya lo lee `BudgetExpensePlanService` | — (vista viva) |
| **Libro mayor de 5 estados** — `budget.budget_lines` | ✅ `BudgetLinesService` | **0** |
| **Materialización** plan → partidas | ✅ Fase PR.1 / ADR-074 | nunca corrida |
| Movimientos del ledger — `budget.line_movements` | ✅ | **0** |
| Obligaciones de gasto — `budget.expense_obligations` | ✅ Fase TP | **0** |
| Campañas — `budget.campaigns` | ✅ | **0** |

> ⛔ **El presupuesto de gasto existe, se auto-propone desde Kepler, y nunca se ejecutó.** La
> pantalla de Gastos está vacía no porque falte el motor, sino porque **nadie le dio al botón de
> proponer**. Lo mismo con la materialización a partidas.

⚠️ **Y el único plan que SÍ tiene datos está incompleto.** El ejercicio FY2027 (`presupesto`,
estado `borrador`) trae $468.8 M, pero no cubre el año:

| periodo 13×4 | entidades con meta (de 43) | meta |
|---|---:|---:|
| P1 – P5 | 43 | ~$49 M c/u |
| **P6** | **31** ⛔ | $47.9 M |
| P7 – P9 | 43 | ~$53 M c/u |
| **P10** | 43 | **$12.4 M** ⚠️ (una cuarta parte de un periodo normal) |
| **P11 · P12 · P13** | **0** ⛔ | **$0** |

P11–P13 van del **11-oct al 31-dic de 2027** — la temporada alta de una dulcería. Comparar
cualquier real contra este plan va a dar «cumplimiento» inflado en 3 de 13 periodos, porque la meta
es cero y el divisor no existe. **Eso se arregla capturando, no programando.**

---

## 2. Los CUATRO «ingresos» de la suite, medidos sobre la misma ventana

Esto es lo que hace falta entender antes de conectar nada: **no hay un número de ingreso, hay
cuatro, y los cuatro son correctos para preguntas distintas.** Enero–septiembre 2026:

| # | fuente | monto | qué mide | grano |
|---|---|---:|---|---|
| **A** | `analytics.income_entries_src` — lo que publica `/finanzas/ingresos` | **$491,483,103.07** | la **póliza contable 401 del CEDIS** (`UD1301` + `UA25xx`) | póliza × canal × plaza × día |
| **B** | `analytics.mv_sales_blended` — el fact arbitrado (ADR-059) | **$471,974,881.88** | el **hecho de venta**, las 8 sucursales + rutas | ticket × SKU × día |
| **C** | `analytics.v_sellout_daily` — **el que hoy usa Presupuesto de Ventas** | **$474,704,346.42** | sell-out, mismo universo que B con otro corte | ticket × SKU × día |
| **D** | `analytics.ledger_monthly` familia 4 — la balanza | **$660,995,159.46** | el ingreso contable de **todas** las sucursales | cuenta × sucursal × mes |

### ⛔ A no es «el ingreso de la empresa», y D no se puede sumar

**A, medido en agosto-2026 con la liga por folio:**

| qué es | documentos | monto | % |
|---|---:|---:|---:|
| **traspaso interno** (el CEDIS facturándole a sus propias tiendas y rutas) | 896 | **$47,013,704.57** | **84.49 %** |
| venta a cliente de afuera | 675 | $8,628,969.15 | 15.51 % |

**D, por sucursal (ene–sep 2026):** `00` = **$519,286,713.87** · las 8 sucursales juntas =
**$141,724,445.59**.

⭐ Sumarlos **cuenta la misma mercancía dos veces**: una cuando el CEDIS le factura a la tienda
(ingreso en `00`) y otra cuando la tienda se la vende al público (ingreso en su sucursal). No es un
error de los datos: es cómo se contabiliza un traspaso. **La balanza familia 4 consolidada NO es el
ingreso del negocio.**

⚠️ **El tamaño exacto del duplicado en ene–sep NO está medido.** Lo medido es la proporción interna
del CEDIS en una ventana de 90 días (84 %) y en agosto (84.49 %). Extrapolarlo a nueve meses sería
inventarlo. Si esa cifra va a sostener una decisión, hay que correr el puente sobre el periodo
completo — se puede, cuesta unos segundos.

### Lo que cada uno sirve para presupuestar

- **B/C → la meta comercial.** Es lo que vende el negocio a alguien de afuera, por canal y por
  sucursal/ruta. **Es el que ya está conectado** y es el correcto para «¿cumplimos la venta?».
- **A → la conciliación contable.** Sirve para cuadrar contra la balanza y para ver cobranza; **no**
  para medir desempeño comercial, porque el 84 % es la casa moviéndose mercancía a sí misma.
- **D → el amarre fiscal.** Es contra lo que contabilidad va a cuadrar. Entra como *referencia*, no
  como meta.

---

## 3. Los DOS «egresos», y por qué el de `/finanzas/egresos` no entra entero

Enero–septiembre 2026:

| # | fuente | monto | grano |
|---|---|---:|---|
| **E** | `analytics.expense_entries` — lo que publica `/finanzas/egresos` | **$516,562,484.87** | póliza × cuenta × sucursal × día |
| **F** | `analytics.ledger_monthly` familias 5+6 | **$582,650,968.75** | cuenta × sucursal × mes |

### ⛔ El 87.8 % de E no es gasto: es compra de mercancía

Por familia contable, que es el corte que importa:

| familia | qué es | monto | % de E | movimientos |
|---|---|---:|---:|---:|
| **5** | **compra de mercancía a proveedores** (cuenta 511) | **$453,666,694.83** | **87.82 %** | 10,486 |
| **6** | **gasto operativo** | **$55,951,943.94** | 10.83 % | 20,501 |
| 7 | impuestos y gastos financieros | $4,461,316.89 | 0.86 % | 466 |
| 1 | activo no circulante — **inversión**, no gasto (cuenta 150) | $2,482,529.21 | 0.48 % | 163 |

Dentro de la familia 6, las cinco cuentas que la explican: sueldos y salarios **$31,153,775.32** ·
gastos logísticos $6,924,601.85 · gastos de venta $6,498,524.86 · gastos de local $5,188,172.53 ·
publicidad y promoción $1,486,132.21.

⭐ **Meter E completo como «gasto» publicaría un presupuesto de gasto operativo nueve veces más
grande de lo que es.** El gasto operativo real son **$55.95 M en nueve meses**, no $516.6 M. Por eso
`BudgetExpensePlanService` ya trae por defecto `families: ['6']` — la decisión está tomada en el
código y hay que respetarla.

Las otras tres familias **no desaparecen: cambian de renglón**, y la pantalla ya tiene el tipo para
cada una (`line_type`):

| familia | cuenta | `line_type` que le toca | presupuestado hoy |
|---|---|---|---|
| 5 | 511 | `compra_inventario` | ❌ no |
| 6 | 6xx | `gasto` | ❌ no (plan en 0) |
| 1 | 150 | `inversion` | ❌ no |
| 7 | 7xx | `gasto` financiero / impuestos | ❌ no |
| — | del fact | `costo_ventas` | ❌ no |

⚠️ **Y compra ≠ costo de ventas.** Son dos renglones distintos y el presupuesto necesita los dos: la
compra es salida de caja (va al flujo), el costo de ventas es lo que consume el margen. Medido del
fact arbitrado, ene–sep 2026: venta **$471,974,881.88** · costo **$416,044,146.97** · margen
**11.85 %**. Confundirlos es lo que ya costó 3.3 pp de margen falso en la Fase MR.

### ⚠️ El egreso es casi todo CEDIS

| sucursal | egreso E | movimientos |
|---|---:|---:|
| **00** | **$462,111,546.47** (89.5 %) | 29,185 |
| 01 | $32,625,531.25 | 579 |
| 06 · 03 · 05 · 08 · 02 · 04 · 07 | $21,825,407.15 juntas | 1,852 |

Presupuestar «por sucursal» con esto deja ocho renglones chiquitos y uno gigante. El interruptor ya
existe (`expense_plan_settings.by_sucursal`), pero **la decisión de si el gasto se presupuesta
consolidado o por sucursal es de Dirección**, no del motor.

---

## 4. Las llaves — por dónde se unen, y las dos que NO

| eje | del lado del PLAN | del lado del REAL | ¿une? |
|---|---|---|---|
| **gasto** | `expense_plan_lines (account_code, sucursal, year_month)` | `expense_entries (cuenta_mayor, sucursal, mes)` | ✅ **limpio**: misma cuenta, misma sucursal, mismo mes |
| **venta** | `sales_plan_lines (entity_key, period_no)` | `v_sellout_daily (channel, warehouse_code)` ⋈ `v_retail_calendar` | ✅ ya conectado |
| **tiempo** | ventas en **13×4**, gastos en **mes** | — | ⛔ **NO une** |
| **canal** | `mostrador, credito, mayoreo, preventa, ruta, contado_nf` | `/finanzas/ingresos`: `mostrador, telemarketing, ruta, reparto_vecinal, contado, otro` | ⛔ **NO une** |

### ⛔ El calendario: 13×4 contra mes

Medido sobre FY2027: **P1 = enero completo (31 días) y P2 = febrero completo (28)**, pero de **P3 en
adelante son bloques de 28 días que ya no coinciden con ningún mes** (P3 = 1→28 mar, P4 = 29 mar→25
abr, …, P13 = 6→31 dic, 26 días).

O sea: una pantalla que ponga **venta en 13×4** y **gasto en meses** en la misma fila está restando
periodos que no son el mismo tiempo. Hay tres salidas y **ninguna es gratis**:

1. **Un solo calendario mensual para todo el presupuesto.** Lo más simple de leer y de cuadrar
   contra contabilidad. Cuesta: el plan de ventas 13×4 ya capturado (418 líneas) habría que
   reproyectarlo, y el 13×4 existe porque así compara el negocio semana contra semana.
2. **Rolar el gasto al 13×4.** Cuesta: el gasto contable nace mensual y repartirlo por días hábiles
   es una **asignación inventada** — justo lo que ADR-056 prohíbe dibujar sin declararlo.
3. **Dos ejes declarados, y el Resultado sólo a nivel mes.** Ventas sigue en 13×4 para lo comercial;
   el P&L y el flujo viven en meses. Es lo único que no inventa nada. **Es la recomendación.**

### ⛔ El canal: dos vocabularios, ninguno derivado del otro

`analytics.v_sales_entity` (el eje del plan de ventas) trae 44 entidades en **6 canales**: `ruta`
(13), `contado_nf` (8), `mostrador` (8), `preventa` (7), `mayoreo` (5), `credito` (3).

`/finanzas/ingresos` parsea su canal del **concepto de la póliza** con una expresión regular, y le
salen otros seis: `mostrador`, `telemarketing`, `ruta`, `reparto_vecinal`, `contado`, `otro`.

⚠️ **Además los rótulos del contable están dados vuelta** (`[IG.7]`): lo que dice «mostrador» es
traspaso interno, y la venta de mayoreo real cae en «otro». **Cruzar los dos canales por nombre
daría un resultado que parece correcto y no lo es.** Si alguna vez hay que unirlos, la llave es
`sucursal`, nunca el nombre del canal.

⚠️ Y `contado_nf` (8 entidades del plan) es el documento **`UD1201`**, que `/finanzas/ingresos`
**excluye a propósito** de su alcance y declara aparte ($426,425.81 en 90 días). O sea: el plan de
ventas ya presupuesta un canal que el ingreso contable no publica.

---

## 5. El mapa de conexión, renglón por renglón

Esto es lo que debería mostrar `/presupuesto` cuando esté completo. **Cada renglón con su fuente de
plan, su fuente de real y su estado hoy.**

| # | renglón | plan (meta) | real | grano | estado |
|---|---|---|---|---|---|
| 1 | **Venta** | `sales_plan_lines` | `v_sellout_daily` ⋈ `v_retail_calendar` | entidad × P13×4 | ✅ **ya está** (plan incompleto) |
| 2 | **− Costo de ventas** | ⬜ falta | `mv_sales_blended.cost` | sucursal × mes | ⛔ **falta todo** |
| 3 | **= Margen bruto** | derivado | derivado | mes | ⛔ |
| 4 | **− Gasto operativo** | `expense_plan_lines` (familia 6) | `expense_entries` | cuenta mayor × sucursal × mes | 🔨 **motor listo, 0 filas** |
| 5 | **− Gastos financieros e impuestos** | ⬜ falta | `expense_entries` familia 7 | cuenta × mes | ⛔ |
| 6 | **= Resultado de operación** | derivado | derivado | mes | ⛔ |
| 7 | **Compra de inventario** | ⬜ falta | `expense_entries` cuenta 511 | proveedor × mes | ⛔ (es flujo, no P&L) |
| 8 | **Inversión** | ⬜ falta | `expense_entries` cuenta 150 | cuenta × mes | ⛔ |
| 9 | **Cobranza prevista** | — | `analytics.customer_receivables` | documento × vencimiento | ✅ ya está (Flujo) |
| 10 | **Pagos previstos** | — | obligaciones Fase TP | obligación × fecha | 🔨 código listo, **0 filas** |
| 11 | **Saldo en bancos** | — | `finance.bank_movements` | cuenta × día | ✅ ya está (Flujo) |
| 12 | *Referencia fiscal* | — | `ledger_monthly` fam. 4/5/6 | cuenta × sucursal × mes | ⛔ (sólo para cuadrar) |

---

## 6. Qué hacer, en orden — y lo que de verdad cuesta cada paso

| paso | qué es | esfuerzo | lo desbloquea |
|---|---|---|---|
| **0** | **Completar el plan de ventas FY2027**: P6 (faltan 12 entidades), P10 (está al 25 %), P11–P13 (vacíos) | ⬜ **captura humana**, cero código | que el cumplimiento deje de ser falso en 3 de 13 periodos |
| **1** | **Correr la propuesta de gasto** (`POST` de `BudgetExpensePlanService`, familia 6) para FY2027 | ⬜ **un clic**, cero código | el renglón 4 del P&L, con plan **y** real |
| **2** | **Materializar** los dos planes a `budget_lines` (ADR-074) | ⬜ **un clic**, cero código | el ledger de 5 estados, la ocupación y el control de sobregiro |
| **3** | Decidir el **eje de tiempo** (§4) y escribirlo en el ADR | ⬜ **decisión** | que ventas y gastos se puedan restar en la misma fila |
| **4** | Renglón **costo de ventas**: real desde `mv_sales_blended.cost`, plan como % de la venta planeada | 🔨 ~1 día | margen bruto presupuestado |
| **5** | Renglones **compra de inventario** (511) e **inversión** (150), separados del gasto | 🔨 ~1 día | que el flujo deje de ignorar $453.7 M |
| **6** | **Estado de resultados presupuestado** (la vista que suma 1→6) | 🔨 ~1 día | la pregunta que nadie puede contestar hoy |
| **7** | **Cuadre contra la balanza** (`ledger_monthly`) como árbitro, con su hueco declarado | 🔨 ~1 día | ADR-059 sobre esta pantalla |

⭐ **Los pasos 0, 1 y 2 no son código: son tres acciones sobre pantallas que ya existen.** Hasta que
no se hagan, construir los pasos 4–7 es llenar una pantalla que no tiene con qué comparar.

---

## 7. Lo que NO hay que hacer (con el monto del error)

| ⛔ la tentación | lo que pasa | medido |
|---|---|---|
| Sumar la balanza familia 4 de todas las sucursales y llamarlo «ingreso» | cuenta dos veces el traspaso CEDIS→tienda | $519.3 M de `00` + $141.7 M de sucursales, con 84 % de `00` interno |
| Meter `/finanzas/egresos` completo como «gasto» | el gasto operativo sale **9×** más grande | $516.6 M contra los $55.95 M reales de familia 6 |
| Usar el ingreso contable (A) como meta comercial | se presupuesta sobre 84 % de dinero que no sale de la casa | agosto-2026: $47.0 M de $55.6 M |
| Cruzar canal de ventas contra canal del contable por nombre | los rótulos del contable están invertidos (`[IG.7]`) | — |
| Poner venta 13×4 y gasto mensual en la misma fila | se restan periodos que no son el mismo tiempo | de P3 en adelante ningún periodo coincide con un mes |
| Tratar compra (511) como costo de ventas | el margen presupuestado queda sin sentido | compra $453.7 M vs costo $416.0 M |

---

## 8. Las decisiones que no son mías

1. ⛔ **El eje de tiempo** (§4): ¿todo a meses, el gasto rolado a 13×4, o dos ejes declarados con el
   Resultado sólo a mes? **Recomiendo dos ejes declarados** — es el único que no inventa una
   asignación.
2. ⛔ **Gasto consolidado o por sucursal.** Con el 89.5 % en el CEDIS, por sucursal deja ocho
   renglones marginales. El interruptor ya existe.
3. ⛔ **Qué es «ingreso» para el presupuesto**: la venta a cliente de afuera (B/C) o el ingreso
   contable completo (A, con su 84 % interno). Hoy la pantalla usa el primero; `/finanzas/ingresos`
   publica el segundo, y los dos son ciertos.
4. ⛔ **Si `contado_nf` (`UD1201`) entra al presupuesto de ventas.** Ya está en el plan y está fuera
   del ingreso contable publicado. Contabilidad tiene que dictaminarlo (es el mismo pendiente que
   `/finanzas/ingresos` declara desde `[IG.3.1]`).
5. ⛔ **Quién completa el plan FY2027.** Sin P11–P13 el presupuesto no cubre la temporada alta.

---

## 9. Lo que este mapa NO midió

- **El monto exacto del traspaso interno en ene–sep 2026.** Sólo está medida la proporción en dos
  ventanas (90 días: 84 % · agosto: 84.49 %). Extrapolarlo sería inventarlo.
- **La conciliación A ↔ D** (el contable del CEDIS contra la balanza de `00`): difieren en
  **$27,803,610.80** sobre ene–sep, y la causa probable está documentada (`UD1201` y `UD4102` fuera
  del alcance de `income_entries_src`), pero **no se verificó renglón por renglón**.
- **Si `v_sellout_daily` cubre el año entero en todas las plazas.** Medido: `05` arranca el 17-mar,
  `04` el 18-feb y `RUTA-505` el 30-may de 2026. Pueden ser aperturas reales o huecos de ingesta;
  **no se investigó**, y afecta cualquier comparación año contra año.
