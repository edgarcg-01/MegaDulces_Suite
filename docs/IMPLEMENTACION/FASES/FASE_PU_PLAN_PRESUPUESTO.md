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

Y por eso lo que este carril venía llamando *«el plan de ingreso declara 3.05× la venta real»*
nunca fue un error a explicar: **es lo que pasa cuando nadie revisa lo que la máquina propuso.**
⚠️ Esa cifra, además, **era mía y estaba mal** (§1.5): el plan es **1.20×** el FY2026 y **0.90×**
el FY2027. Lo que la máquina dejó sin revisar no es un múltiplo disparatado — es **$0.00 planeado
en Halloween, Navidad y Reyes** (§1.6), que es peor y no se veía.

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

### 1.4 ⛔ Y el circuito de pago **nunca corrió** — verificado por Tesorería, re-medido acá

| | |
|---|---|
| `finance.payment_calendar_lots` | **0 filas** |
| `finance.payment_allocations` | **0 filas** |
| `finance.payment_allocation_items` | **0 filas** |
| `expense_obligations` | 312 · **pagadas 0** · **reservadas 0** · las 312 nacidas el 2026-10-07 |

**Ni un pago pasó jamás por este sistema**, ni completo ni parcial.

⭐ Eso **responde y disuelve** la pregunta de §7.7 (*«¿la obligación nace antes del pago o se
registra después?»*): **no se puede contestar desde la base, porque no hay un solo caso**. El ledger
de cinco estados no documenta tarde — *todavía no documenta nada*. El circuito real de pago vive
**entero fuera** de la Suite, y eso convierte la pregunta en **bloqueo humano**, no en medición
pendiente. Hallazgo de `trade-marketing-cc`, verificado acá antes de incorporarlo.

> ⚠️ **Corrección a una lectura mía, de Tesorería y tenía razón.** Este plan preguntaba si
> `budget.daily_capacity` estaba *«vacía como `expense_plan_settings`»*. **No lo está: tiene 22
> filas y las puso una persona (`superoot`).** El defecto es otro — y re-midiéndolo apareció uno
> peor que el reportado: **las 22 filas cubren del 2026-09-01 al 2026-09-30, un mes que ya cerró.**
> Hoy es 10 de octubre: **no hay un solo día futuro con tope autorizado.** A eso se suma `[TES.9]`
> —su lector trata el día sin fila como **cero autorizado** en vez de *capacidad no definida*—, con
> lo que el calendario de pagos opera hoy sin techo y sin saberlo.

### 1.5 ⛔ La cifra que este carril más repitió estaba mal — y el denominador era el problema

Este plan, la torre de control y dos mensajes a los otros carriles citaron *«el plan de ingreso
declara **3.05×** la venta real»*. **No reproduce.** Lo levantó Ingresos y lo re-medí acá contra
`analytics.sales_daily`:

| | |
|---|---|
| Venta real, 12 meses cerrados (2025-10 → 2026-09) | **$669,067,048.83** |
| Plan **FY2026** $806,217,118.81 | **1.20×** |
| Plan **FY2027** $604,775,116.21 | **0.90×** |
| Para que diera 3.05, el denominador tendría que ser | **$198,286,923.35** ≈ 3.6 meses |

⛔ **Comparé un plan ANUAL contra una venta PARCIAL.** Es un denominador sin declarar: el mismo
defecto que este carril le marcó a la superficie de ingreso («el 81.6 % *del plan*» siendo de
Mostrador) y que corrigió en su propio `[PU.VG.11]` («38.72 %» sumando dos ejercicios). **Tercera
vez en dos días, y las tres veces la aritmética estaba bien.**

⚠️ **Lo que NO cambia:** que nadie firmó el plan. 1.20× sigue siendo una meta que ninguna persona
aprobó. El error estaba en el **tamaño** del disparate, no en que hubiera uno.

> ⛔ **Y este párrafo tenía otro error mío, levantado por Ingresos y peor de lo que ellos vieron.**
> Decía que `sales_daily` con fechas futuras «inflaba el denominador que produjo el 3.05». Medido:
> son **4 filas por $230.49 — el 0.0000 %** del año en curso. Ingresos marcó que la magnitud no
> alcanzaba; al verificarlo apareció que **la dirección también estaba al revés**: inflar un
> denominador **baja** el múltiplo, y para llegar a 3.05 hace falta uno **más chico**
> ($198,286,923.35 = **40.1 %** del año en curso). Las filas futuras empujaban **en contra** de mi
> propia explicación.
>
> ⭐ **La lección es más fina que el número:** le colgué a una cifra una causa que sonaba razonable
> **sin comprobar que empujara para el lado correcto**. Eso es una afirmación causal disfrazada de
> medición — y pasó en el párrafo donde estaba corrigiendo mi propio denominador sin declarar.
> **La causa del 3.05 es una sola y ya estaba escrita: plan anual contra venta parcial.**

⚠️ **Hallazgo aparte, que sigue valiendo y no es la causa de nada de esto:** `analytics.sales_daily`
tiene **4 filas con `sale_date` en el futuro** (2026-12-06, $230.49). No es de este carril y no se
persiguió; queda reportado porque un fact de venta con fecha futura **no debería existir**, por
chico que sea.

⚠️ Mi 12-meses ($669,067,048.83) e Ingresos ($660,980,381.64) difieren **1.2 %** por la fuente
(`analytics.sales_daily` contra `v_sellout_daily`). **No se promedian**: las dos llevan a 1.2×, y
cuál arbitra es una pregunta abierta de Fase VP.

### 1.6 ⭐⭐ Y al medir el denominador apareció algo peor: el plan 2027 proyecta CERO la temporada

Ingresos reportó *«FY2027 tiene 10 de 13 períodos con meta»* y este carril midió *«13 de 13»*.
**Los dos son correctos y miden cosas distintas** — y la diferencia es el hallazgo:

```
FY2026  P1=68.9M P2=65.2M … P11=65.2M  P12=74.9M  P13=79.1M
FY2027  P1=66.8M P2=59.2M … P11=0      P12=0      P13=0        (99 filas en CERO)
```

**Las filas existen y declaran cero.** No es un período ausente: es un período **planeado en
$0.00**. En una dulcería, P11–P13 son **Halloween, Navidad y Reyes** — en FY2026 valieron
**$219,2 M, el 27.2 % del año**.

⭐ Y eso explica la caída que Ingresos marcó como artefacto: el plan 2027 es **$201.4 M** menor que
el 2026, y el Q4 que le falta al 2026 vale **$219.2 M**. **No «baja 25 %»: le falta la temporada.**

⛔ **Es la trampa fundacional de este proyecto, dentro del presupuesto**: un cero que significa «no
sé» se suma en silencio y se lee como medición. Un presupuesto que proyecta cero en su mejor
trimestre **no es conservador, está roto** — y ningún tablero lo iba a gritar porque $0.00 es un
número perfectamente válido.

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
que hoy se usa como las tres cosas: como **meta** nadie la firmó, como **pronóstico** proyecta
**$0.00** en Halloween, Navidad y Reyes (§1.6), y como **permiso de gasto** autorizaría contra una
venta que el propio plan dice que no va a ocurrir.

⚠️ Una versión anterior de este párrafo citaba *«3.05×»* como prueba. **Esa cifra era mía y estaba
mal** — comparaba un plan anual contra una venta parcial. Corregida y explicada en §1.5; el
argumento se sostiene sin ella, y de hecho mejor.

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
captura. ⛔ **Y acá este plan se equivocó de fuente, lo levantó Ingresos midiendo antes de construir.**
`analytics.sales_daily` no tiene cliente, es cierto; pero `analytics.erp_sales_invoices`, que sí lo
tiene, **cubre $32,066,375 = 4.85 % del plan, y el 77 % de eso es TELEMARK**. Construir ahí
«clientes × frecuencia × ticket» describiría el 4.85 % y lo llamaría *los drivers del negocio* —
**el mismo defecto que este documento existe para corregir, metido en el diseño de la fase
siguiente**. **Mostrador, el 58.5 % del plan, no deja factura por cliente.**

⇒ **El driver se declara POR CANAL**: donde hay cliente (telemarketing, preventa), `clientes ×
frecuencia × ticket`; donde no lo hay (Mostrador), `tickets × ticket promedio`, y **se dice cuál
es cuál**. Un driver uniforme sobre canales que no comparten grano es un promedio sin universo.

**D3 · Cada partida tiene un nombre antes de tener un peso.** Sin `responsible`, la partida **no se
materializa**. Es compuerta, no campo opcional.

**D4 · El libro recupera el eje de tiempo.** `period_month` NULL en 139 de 139 significa que se puede
quemar el año en enero sin que nada avise. El perfil mensual ya existe en `expense_plan_lines` — hay
que bajarlo al libro, y `[PU.VG.7]` ya midió por qué no se puede hacer cambiando el grano a lo bruto.

**D5 · Cerrar el mes es un acto, no una consulta.** Un cierre congela meta, pronóstico y real del
mes, con el puente PVM que explica la diferencia. Sin cierre congelado, nadie puede decir **por qué
cambió enero** — que es la pregunta que originó la Fase VP.

**D6 · El ciclo de efectivo entra al presupuesto como restricción, no como reporte.** Un plan de
crecimiento que no declara cuánta caja consume **no es un plan**. 

⭐⭐ **Y medido con Tesorería, la pierna que falta es la que decide el signo.** Ellos ya tienen dos
de las tres: **DSO 34.7** y **DPO 77.3 / 50.0**. O sea:

```
ciclo = DIO + 34.7 − 77.3 = DIO − 42.6
```

**Hoy el proveedor financia 42.6 días de operación.** Si el inventario rota en menos que eso el
ciclo es **negativo** y crecer *libera* caja; si rota en más, cada peso de crecimiento hay que
financiarlo. **Las dos conclusiones son opuestas y las separa la única pierna que no tenemos.**

⛔ Y no está bloqueada por falta de dato sino por **valuación**: el DIO espera a que la **Fase MR**
cierre el costo de inventario. **Eso convierte a MR en prerrequisito del Sprint 5, no en un trabajo
paralelo** — y es lo primero que hay que destrabar si el objetivo es crecer.

⚠️ La pierna de **cartera también existe** y Tesorería ya la usa (`cobranza-prevista.ts` sobre
`kepler_ods.kdue`); este plan la había puesto como «por verificar». Corrección suya.

---

## 5 · El plan de trabajo — quién hace qué

> **Regla de este plan, y es la que cambia la forma de trabajar:** ⭐ **ningún carril verifica sus
> propias cifras.** Es lo único que funcionó: Ingresos midió las mías y encontró un error real que
> yo no veía; yo medí las suyas y encontré un denominador mal nombrado. Solos no lo vimos.

| Sprint | Qué | Quién construye | Quién verifica |
|---|---|---|---|
| **0 · La verdad del proceso** | Dónde vive el presupuesto real hoy; quién lo arma; `sales_targets` ¿persona o importer? | **Ingresos** + **Tesorería** | este carril |
| **1 · Los tres números** | Separar meta / pronóstico / asignación en el esquema; migrar lo que el autopiloto escribió a `pronostico`, **no a meta** | **Tesorería** | Ingresos |
| **2 · Drivers de ingreso** | ⛔ **Reescrito: la fuente no alcanzaba.** `erp_sales_invoices` cubre **4.85 %** del plan y **77 % de eso es TELEMARK**. Van **drivers distintos por canal**, declarando cuál tiene cliente y cuál no: con cliente (telemarketing, preventa) `clientes × frecuencia × ticket`; sin cliente (**Mostrador, el 58.5 % del plan**) `tickets × ticket promedio` desde `v_sellout_daily`. El renglón se deriva | **Ingresos** | Tesorería |
| **3 · Dueño y clase de gasto** | `responsible` obligatorio; `expense_class` capturado; compuerta que impide materializar sin dueño | **Tesorería** | Ingresos |
| **4 · El puente PVM** | Precio / volumen / mezcla sobre la desviación de venta | **Ingresos** | este carril |
| **5 · Ciclo de efectivo** | DIO + DSO − DPO. ⛔ **Depende de que Fase MR cierre la valuación de inventario**: DSO y DPO ya están, el signo lo decide DIO | **Tesorería** | Ingresos |
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
6. **¿Cuál es la meta de crecimiento, y de dónde sale?** Medido (§1.5): el plan FY2026 es **1.20×**
   la venta de los últimos 12 meses cerrados y el FY2027 **0.90×** — y **ninguno lo firmó nadie**.
   ⛔ Y antes de fijar una meta hay que contestar §1.6: **¿por qué el plan 2027 proyecta cero en
   noviembre, diciembre y enero?** Si es un defecto del motor se arregla; si alguien decidió no
   planear la temporada, es la decisión más cara del ejercicio y no está escrita en ningún lado.
7. **¿Quién decide hoy que algo se paga, y contra qué tope?** ⛔ Reemplaza a la pregunta que este
   plan traía (*«¿la obligación nace antes o después del pago?»*), que quedó **demostrada como no
   medible**: `payment_calendar_lots`, `payment_allocations` y `payment_allocation_items` están
   **las tres en 0 filas**, y ninguna de las 312 obligaciones tiene un peso pagado ni reservado.
   **El circuito real de pago vive entero fuera de la Suite.** Diseñar cinco estados contra un
   circuito que nadie describió es el riesgo que este plan quería evitar, y la evidencia no lo
   resuelve: lo confirma como bloqueo.
8. **¿Quién define el tope de pago por día, y cada cuánto se revisa?** Las únicas 22 filas de
   capacidad que puso una persona cubren **del 1 al 30 de septiembre, un mes que ya cerró**. Hoy
   no hay un solo día futuro con techo autorizado.

---

## 8 · Lección de método

⭐⭐ **Una superficie bien construida sobre un dato que nadie verificó sigue siendo un ejercicio.**
Este carril entregó una concentración medida, con 32 aserciones, siete mutaciones en rojo y 27
comprobaciones contra producción — y describía la salida de nuestro propio autopiloto. **El rigor
sobre la fuente equivocada no es rigor: es rigor mal dirigido**, y se ve igual de verde.

⭐ **Corolario para los tres carriles:** antes de medir algo, preguntarse *¿quién escribió este
dato?* Si la respuesta es «nosotros», no es una medición del negocio.

---

## 9 · Cómo se debería trabajar — la regla, con la evidencia del día que la sostiene

Edgar pidió *«cómo se debería hacer correctamente»*. Lo que sigue **no es una propuesta**: es lo que
produjo resultados el 2026-10-10 entre los tres carriles, medido.

### 9.1 ⭐⭐ Ningún carril verifica sus propias cifras

**Las cinco correcciones del día salieron del CRUCE, ninguna del esfuerzo individual.** Las tres
sesiones somos capaces, y aun así **ninguna vio lo suyo**:

| Lo encontró | Qué corrigió | De quién era el error |
|---|---|---|
| Ingresos | el denominador del **3.05×** (plan anual contra venta parcial) | este carril |
| Ingresos | la asimetría leída del conteo absoluto («4 contra 9») y no del top-1 | este carril |
| Ingresos | el Sprint 2 sobre una fuente que cubre **4.85 %** del plan | este carril |
| este carril | «el 81.6 % **del plan**» siendo de Mostrador | Ingresos |
| este carril | las **99 filas en $0.00** de P11–P13, leídas como «períodos faltantes» | Ingresos |
| Tesorería | `daily_capacity` declarada vacía cuando tiene 22 filas de una persona | este carril |
| Tesorería | el circuito de pago **nunca corrió**: la pregunta no era medible | este carril |
| este carril | esas 22 filas cubren **un mes ya cerrado** | Tesorería |
| este carril | dos candados de Tesorería fuera del runner, sin correr | otro carril |

⛔ **El patrón, y es el que justifica la regla:** cada error lo encontró **quien no lo escribió**.
Revisar lo propio no falla por falta de rigor — falla porque quien escribió la cifra ya aceptó su
premisa.

### 9.2 Las tres preguntas que ninguna cifra contesta sola

Del día salieron tres, y las tres son independientes:

1. **¿Quién escribió este dato?** Si la respuesta es *«nosotros»*, no es una medición del negocio
   (§1.1: `autopilot` escribió el presupuesto entero).
2. **¿Cuál es el universo?** Un porcentaje correcto sobre un universo que la frase no nombra es
   indefendible. Pasó **tres veces en dos días**, y las tres la aritmética estaba bien.
3. **¿Hacia dónde empuja la causa?** No alcanza con medir si la causa propuesta **pesa**: hay que ver
   si empuja **para el lado correcto**. (§1.5: las filas futuras empujaban *en contra* de la
   explicación que yo les había colgado.)

### 9.3 Y la que vale para el rol de auditor

⭐ **Una corrección que llega de un carril hermano se mide, no se acepta ni se rechaza.** Las nueve de
§9.1 se re-midieron con consulta propia antes de incorporarse — y en **dos** de ellas la
verificación encontró más de lo que traía el reporte: la dirección invertida del §1.5, y que la
capacidad cubría un mes cerrado.

⛔ **Y el reparto no se relaya.** Dos veces hoy un carril le pasó a otro una autorización de Edgar
como si fuera propia, y las dos veces el que la recibió hizo bien en no tomarla. **Una instrucción
baja de quien manda a cada sesión, o no baja.** Medir no necesita reparto; construir sí.

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
