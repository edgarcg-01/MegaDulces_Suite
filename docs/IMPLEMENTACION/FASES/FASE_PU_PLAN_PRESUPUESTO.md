# Plan de Presupuestos — reinventar cómo se administra, para crecer

> **Qué es esto.** El plan de rediseño del proceso de presupuesto de Mega Dulces. Pedido de Edgar,
> 2026-10-10: *«necesitamos una verdad absoluta, no ejercicios… investigá hoy cómo lo hacen las
> grandes empresas, qué valor necesitamos de su forma de trabajar para reinventar nuestra forma de
> presupuestos. Necesito crecimiento, y el crecimiento está en cómo administramos el presupuesto»*.
>
> **Reparto de trabajo, decidido por Edgar el mismo día:** este carril (`PU.VG`) **arma el plan y
> audita**; los carriles de **Ingresos** (`trade-marketing-06`) y **Tesorería** (`trade-marketing-cc`)
> **lo construyen**. Este documento es el encargo, no el código.
>
> **No es un ejercicio.** Cada afirmación de §1 tiene una consulta contra `pg-prod` detrás, en solo
> lectura. Cada práctica de §2 tiene una fuente. Lo que no se pudo medir está en §7.

**Medido:** 2026-10-10 · `192.168.0.222:5434` (`pg-prod`) · `default_transaction_read_only = on`.

---

## 1 · Por qué hay que reinventarlo: lo que medí hoy

### 1.1 ⛔ El presupuesto lo escribió una máquina, y nadie lo firmó

| Tabla | Quién la escribió |
|---|---|
| `budget.budgets` | 2 `superoot` · 1 **`autopilot`** |
| `budget.budget_lines` | **139 `autopilot`** |
| `budget.expense_plan_lines` | **374 `autopilot`** |
| `budget.sales_plan_lines` | **1,287 `autopilot`** |
| `budget.expense_obligations` | **312 `autopilot`** |
| `budget.expense_plan_settings` | **0 filas** |
| `budgets.authorized_by` | **NULL en los 3 ejercicios** |

**Un autopiloto copió el histórico de Kepler y lo llamó presupuesto.** Ningún humano firmó un
supuesto de gasto —la tabla está vacía— ni autorizó un ejercicio. El único humano creó 2 cabeceras.

⭐⭐ **La consecuencia que invalida todo lo construido encima:** auditar `budget.*` es **cruzar
nuestra propia implementación consigo misma**. Cuando este carril midió *«el gasto está en 4
renglones»* y el de Ingresos midió *«Mostrador es el 34.8 %»*, los dos estábamos describiendo **la
salida de nuestro propio motor**, no el negocio.

Y por eso el *«plan de ingreso 3.05× la venta real»* nunca fue un error a explicar: **es lo que pasa
cuando nadie revisa lo que la máquina propuso.**

### 1.2 Las cinco ausencias que impiden administrar

| Qué falta | Medido |
|---|---|
| Dueño por partida | `responsible`: **0 de 26** |
| Fijo / variable | `expense_class`: **0 de 26** |
| Eje de tiempo en el libro | `period_month`: **NULL en 139 de 139** |
| Freno que frene | `control_level = 'bloqueo'`: **0 de 26** |
| El libro operado | reservado + comprometido + ejercido + pagado = **$0.00** |

### 1.3 Y el presupuesto de verdad puede no estar acá

Hay **tres** lugares donde vive algo parecido a una meta, y **ninguno está declarado como el que
manda**: `commercial.sales_targets` (**572 filas, sin `created_by`: no se sabe quién las puso**),
`commercial.margin_targets` (1 fila) y la balanza de ContPAQi (58,051 filas / 2,337 cuentas).
Más lo que esté en un Excel que ninguna sesión vio. **§7 lo convierte en pregunta para personas.**

---

## 2 · Qué hacen las empresas grandes — y qué vale para nosotros

Cinco prácticas, con la razón por la que aplican **a una distribuidora**, no en abstracto.

### 2.1 ⭐⭐ Separar los TRES números que el presupuesto confunde

El presupuesto tradicional intenta servir **tres propósitos a la vez** —fijar la meta, pronosticar
lo que va a pasar, y asignar recursos—, y ahí está el defecto: *una meta es una aspiración, un
pronóstico es una expectativa, y la asignación de recursos es cómo se hace realidad la aspiración.*
Son números distintos, y forzarlos a ser uno solo los corrompe: si la meta y el pronóstico son el
mismo número, **nadie pronostica honesto** —pronosticar mal te deja mal parado— y si el pronóstico
es también el permiso para gastar, **todos piden de más**.

⭐ **Para nosotros esto no es teoría: es exactamente lo que pasó.** El autopiloto produjo UN número
que hoy se usa como las tres cosas. Y el 3.05× es la prueba: como meta es ambiciosa, como pronóstico
es falsa, y como permiso de gasto sería ruinosa.

### 2.2 ⭐ Planear por DRIVERS, no por «el año pasado + %»

El método que reemplazó al incremental: el plan se arma desde las **palancas que el negocio
controla** (clientes, frecuencia, ticket, precio, margen), no desde renglones contables. La
diferencia de fondo **no es técnica, es de conversación**: con drivers se discute *qué palanca
movemos*, no *cuánto le subo a este renglón*. Y cuando algo cambia, se actualizan uno o dos drivers
en vez de rehacer el modelo. La evidencia publicada apunta a mejoras de **más del 25 % en exactitud
de pronóstico** frente al método incremental.

⛔ **Nuestro método hoy es literalmente el que esta práctica reemplaza**: `historico_ajustado` (año
anterior × crecimiento) y `estacional`, que **ni siquiera es estacional** — es `suma(meses)/n`, un
promedio plano, medido.

### 2.3 Pronóstico RODANTE, no foto anual

12 a 18 meses que se **re-pronostican cada mes**, agregando un período al cerrar cada uno; 12 meses
cubre un ciclo estacional completo. El punto no es la frecuencia: es que **el re-pronóstico esté
agendado y no sea una reacción a una crisis**.

⭐ **Para una dulcería esto es grande:** el negocio tiene picos duros (Día del Niño, Halloween,
Navidad, Reyes). Un presupuesto anual fijo decide en noviembre cosas que se ejecutan en octubre del
año siguiente, con once meses de información sin usar.

### 2.4 Dueño por categoría de costo (de ZBB), sin el ZBB completo

La pieza que vale de *zero-based budgeting* **no es rearmar todo desde cero** —eso es caro y se
degrada en recorte—, sino el **dueño de categoría de costo**: una persona responsable de cada
familia de gasto, que cuestiona lo que se pide, fija criterios y negocia volumen. El valor medido de
ZBB está en **la rendición de cuentas**, no en el ahorro.

⛔ **Nosotros tenemos 0 de 26 partidas con dueño.** Ésta es la práctica de mayor retorno y la más
barata de adoptar: **no requiere software, requiere nombres.**

### 2.5 El puente precio / volumen / mezcla, para saber POR QUÉ se falló

Una desviación de venta se descompone en **precio** (cobré distinto), **volumen** (vendí más o menos
piezas) y **mezcla** (cambió qué se vendió). El mismo faltante pide acciones opuestas: *volumen* se
corrige con acción comercial; *mezcla*, con portafolio y precios. Sin el puente, la junta discute un
número y nadie sabe qué hacer el lunes.

### 2.6 ⭐⭐ Y la que nadie pide pero es la que financia el crecimiento: el ciclo de efectivo

El dato que ordena todo lo demás: **crecer empeora el efectivo antes de mejorarlo.** Una
distribuidora que duplica ventas suele duplicar el dinero atrapado en cartera e inventario — por eso
*distribuidoras que crecen rápido se quedan sin caja mostrando utilidad*. El ciclo = días de
inventario + días de cartera − días de proveedor; la referencia de mayoreo/distribución ronda **60
días**, con rango típico de 50 a 90. **Cada día que se recorta libera un día de caja operativa.**

⭐ **Edgar pidió crecimiento. Ésta es la palanca de crecimiento que no requiere vender más:** en una
distribuidora, recortar el ciclo financia la expansión **sin deuda**.

---

## 3 · ⛔ Lo que NO vamos a copiar, y por qué

Copiar la práctica completa de una corporación a una empresa de 8 sucursales es la forma más rápida
de producir otro ejercicio.

| Práctica | Veredicto |
|---|---|
| **ZBB completo** (rearmar cada peso desde cero, cada año) | ⛔ **No.** Se degrada en recorte y mata crecimiento, que es lo contrario del pedido. Se toma **sólo el dueño de categoría** (§2.4). |
| **Abolir el presupuesto** (Beyond Budgeting puro) | ⛔ **No.** Acá todavía no existe **uno** que funcione; no se puede abolir lo que no se tiene. Se toma **la separación de los tres números** (§2.1). |
| **Software de planeación** (Anaplan / Adaptive / Pigment) | ⛔ **No.** El problema no es la herramienta: es que **nadie firma**. Una licencia no crea un dueño. |
| **Pronóstico mensual desde el mes 1** | ⚠️ **No todavía.** Re-pronosticar un plan que nadie revisó es automatizar el error. Primero un plan firmado (§5, Sprint 1). |
| **Semáforos y metas por KPI** | ⚠️ **Sólo con umbral registrado** (ADR-076). ⚠️ `analytics.kpi_thresholds` **dejó de estar en cero: tiene 5 filas** — alguien las registró hoy, y hay que ver si alguna aplica al presupuesto antes de pintar nada. |

---

## 4 · El modelo nuevo — seis decisiones de diseño

**D1 · Tres números, tres tablas, tres dueños.** `meta` (la aspiración, la firma Dirección),
`pronostico` (lo que de verdad esperamos, lo firma quien opera, y **se premia que sea honesto, no
que sea alto**) y `asignacion` (el permiso de gasto, que es el único que frena). **Hoy los tres son
la misma fila y por eso ninguno sirve.**

**D2 · El plan se arma por drivers, y el renglón contable es la SALIDA.** Ingreso =
`clientes_activos × frecuencia × ticket`, por canal. Gasto = `fijo` (no se mueve con el volumen) +
`variable` (se mueve con un driver declarado). El renglón de `budget_lines` se **deriva**; nadie lo
captura. ⚠️ **Verificado hoy: `analytics.sales_daily` NO tiene cliente** (producto × almacén × canal
× fecha) — la descomposición sale de **`analytics.erp_sales_invoices`**, que sí trae `cliente_code`,
`fecha`, `vendedor_code` y `sucursal`. **Es una pierna que hay que construir, no una que ya está.**

**D3 · Cada partida tiene un nombre antes de tener un peso.** Sin `responsible`, la partida **no se
materializa**. Es compuerta, no campo opcional.

**D4 · El libro recupera el eje de tiempo.** `period_month` NULL en 139 de 139 significa que se puede
quemar el año en enero sin que nada avise. El perfil mensual ya existe en `expense_plan_lines` — hay
que bajarlo al libro, y `[PU.VG.7]` ya midió por qué no se puede hacer cambiando el grano a lo bruto.

**D5 · Cerrar el mes es un acto, no una consulta.** Un cierre congela meta, pronóstico y real del
mes, con el puente PVM que explica la diferencia. Sin cierre congelado, nadie puede decir **por qué
cambió enero** — que es la pregunta que originó la Fase VP.

**D6 · El ciclo de efectivo entra al presupuesto como restricción, no como reporte.** Un plan de
crecimiento que no declara cuánta caja consume **no es un plan**. ⚠️ Medido hoy: la pierna de
proveedores existe (`erp_supplier_payments`, 4,735 filas); **cartera e inventario hay que verificar
columna por columna** — mi primer intento falló por nombres y eso es exactamente lo que no se
declara a ciegas.

---

## 5 · El plan de trabajo — quién hace qué

> **Regla de este plan, y es la que cambia la forma de trabajar:** ⭐ **ningún carril verifica sus
> propias cifras.** Es lo único que funcionó: Ingresos midió las mías y encontró un error real que
> yo no veía; yo medí las suyas y encontré un denominador mal nombrado. Solos no lo vimos.

| Sprint | Qué | Quién construye | Quién verifica |
|---|---|---|---|
| **0 · La verdad del proceso** | Dónde vive el presupuesto real hoy; quién lo arma; `sales_targets` ¿persona o importer? | **Ingresos** + **Tesorería** | este carril |
| **1 · Los tres números** | Separar meta / pronóstico / asignación en el esquema; migrar lo que el autopiloto escribió a `pronostico`, **no a meta** | **Tesorería** | Ingresos |
| **2 · Drivers de ingreso** | `clientes × frecuencia × ticket` por canal desde `erp_sales_invoices`; el renglón se deriva | **Ingresos** | Tesorería |
| **3 · Dueño y clase de gasto** | `responsible` obligatorio; `expense_class` capturado; compuerta que impide materializar sin dueño | **Tesorería** | Ingresos |
| **4 · El puente PVM** | Precio / volumen / mezcla sobre la desviación de venta | **Ingresos** | este carril |
| **5 · Ciclo de efectivo** | DIO + DSO − DPO, y cuánta caja consume el plan de crecimiento | **Tesorería** | Ingresos |
| **6 · Cierre mensual** | Congelar el mes; rodar el horizonte | **ambos** | este carril |

⛔ **Sprint 0 bloquea a todos los demás.** Construir sobre un proceso que no entendimos es cómo
llegamos acá.

---

## 6 · Qué audito yo, y con qué regla

No apruebo nada que no cumpla las seis:

1. **Fuente declarada.** Cada cifra dice de qué tabla salió y con qué ventana.
2. **Universo nombrado.** Un porcentaje sin denominador no se publica (`ExpenseUniverse`, ya en el
   contrato). Las dos mitades ya fallamos en esto, espejadas.
3. **Verificado por otro carril**, con una implementación distinta, sobre el dato real.
4. **Candado con prueba negativa.** Un gate que nunca se pone rojo es una intención. ⚠️ Y **una
   mutación que no se aplica se ve idéntica a una que las pruebas sobrevivieron** — el script falla
   con exit 2 si no encuentra la línea.
5. **Lo que no se puede medir se DECLARA** (ADR-056): NULL con motivo, nunca 0 ni verde.
6. **El primitivo vive en `libs/`**, o es deuda con nombre en el tracker.

⚠️ **Y lo que yo no puedo hacer:** no «controlo» las otras sesiones — especifico, reviso y **me
niego a aceptar lo que no esté verificado**. Si un carril discrepa con una medición mía, la medición
pierde si está mal: ya pasó hoy y la corrección quedó escrita con el nombre de quien la encontró.

---

## 7 · ⛔ Lo que ninguna sesión puede contestar — es para personas

Ninguna de estas sale de una base de datos. **Adivinarlas es volver al ejercicio.**

1. **¿Quién arma hoy el presupuesto, con qué herramienta y en qué mes?** Si la respuesta es «Francisco
   en un Excel en noviembre», el módulo tiene que leer **ese** Excel o reemplazar **ese** trámite.
2. **¿Quién lo aprueba, y qué significa hoy aprobarlo?** Medido: nadie aprobó nunca nada acá.
3. **¿Las 572 filas de `commercial.sales_targets` las puso una persona o un importer?** Sin
   `created_by` no se puede saber, y de eso depende si ya existe una meta real.
4. **¿Contra qué se compara al cierre del mes — y quién mira esa comparación?**
5. **¿Quién va a ser dueño de cada familia de gasto?** Son ~12 nombres. Es la decisión de mayor
   retorno de todo el plan y **no cuesta software**.
6. **¿Cuál es la meta de crecimiento, y de dónde sale?** Hoy el plan dice 3.05× la venta real sin que
   nadie la haya firmado.

---

## 8 · Lección de método

⭐⭐ **Una superficie bien construida sobre un dato que nadie verificó sigue siendo un ejercicio.**
Este carril entregó una concentración medida, con 32 aserciones, siete mutaciones en rojo y 27
comprobaciones contra producción — y describía la salida de nuestro propio autopiloto. **El rigor
sobre la fuente equivocada no es rigor: es rigor mal dirigido**, y se ve igual de verde.

⭐ **Corolario para los tres carriles:** antes de medir algo, preguntarse *¿quién escribió este
dato?* Si la respuesta es «nosotros», no es una medición del negocio.

---

## Fuentes

- [Driver-Based Planning in FP&A — Corporate Finance Institute](https://corporatefinanceinstitute.com/resources/fpa/driver-based-planning-guide/)
- [Driver-Based Planning: A Complete Guide for FP&A Teams](https://finopsmasters.com/category/fpa/driver-based-planning-guide/)
- [Going Beyond Budgeting — BCG](https://www.bcg.com/publications/2021/the-future-is-beyond-budgeting)
- [Agile Meets Beyond Budgeting — BCG (PDF)](https://web-assets.bcg.com/25/61/d4a3c2ca44489b8f04006f068533/agile-meets-beyond-budgeting.pdf)
- [Beyond Budgeting: Overcome Budgeting's Inefficiency and Conflicts — CFO Perspective](https://cfoperspective.com/beyond-budgeting-overcome-budgetings-inefficiency-and-conflicts/)
- [Rolling Forecasts: The Complete FP&A Guide — Farseer](https://www.farseer.com/blog/rolling-forecast/)
- [How to build a rolling forecast — Aleph](https://www.getaleph.com/answers/what-is-a-rolling-forecast)
- [To Make Zero-Based Budgeting Work, Change Behavior — BCG](https://www.bcg.com/publications/2021/changing-how-companies-manage-cost-with-zero-based-budgeting)
- [How absolute zero-based budgeting can heat up growth — McKinsey](https://www.mckinsey.com/capabilities/operations/our-insights/how-absolute-zero-based-budgeting-can-heat-up-growth)
- [How to perform a sales bridge (price volume mix analysis) — Under Controlling](https://undercontrolling.com/sales-bridge-volume-price-mix-analysis/)
- [Explaining variance analysis — Pigment](https://www.pigment.com/blog/variance-analysis-explained)
- [A Distributor's Working Capital and Cash-Conversion Playbook — Pease Bell](https://www.peasebell.com/insights/distribution-working-capital-playbook/)
- [Cash Conversion Cycle: Formula, Benchmarks & 7 Fixes — Blackpeak CFO](https://blackpeakcfo.com/blog/cash-conversion-cycle-guide/)
