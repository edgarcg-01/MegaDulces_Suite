# Fase PU — La torre de control de Dirección General en `/presupuestos`

> **Qué es esto.** El plan de qué herramientas recibe **Dirección General** en el módulo Presupuestos
> y qué datos debe observar ahí, **medido contra producción antes de proponer nada**. Pedido de Edgar,
> 2026-10-09: *«pensá qué herramientas le debemos dar a Dirección General y qué datos deben observar
> acá, considerando que ésta es su torre de control»*.
>
> Hereda **ADR-056** (lo que no se puede medir se DECLARA), **ADR-066** (Fase PU), **ADR-076** (un KPI
> directivo no se publica sin puesto ocupado, misma fuente que la pantalla y umbral registrado) y
> **ADR-061** (el cuadro de Dirección se renderiza dentro de «Mi trabajo», no en una pantalla nueva).

**Medido:** 2026-10-09 · `192.168.0.222:5434/railway` (`pg-prod` de `md`) · `default_transaction_read_only = on`
· **cero escrituras**. Script: `scratchpad/conc2.js`.

---

## 1 · La tesis

**En este módulo nunca se ha autorizado nada.** No es que falte tablero: falta que algo pase por una
firma. Medido hoy:

| Hecho | Cifra |
|---|---|
| Obligaciones esperando autorización | **156 · $74,809,091.57** · `con_firma: 0` · desde el **2026-10-07** |
| Ejercicios con `authorized_by` | **0 de 3** (los 3 en `borrador`) |
| Filas en `analytics.kpi_thresholds` | **0 en TODO el sistema** |
| Gasto autorizado con freno duro | **0 de 26 partidas** — las 26 en `advertencia` |
| El ledger de 5 estados, operado | **$0.00** en reservado, comprometido, ejercido y pagado |

⭐ **El recurso escaso de Dirección no es información: es su atención y su firma — y hoy nada se la
pide.** Un tablero que se mira y no se acciona es un reporte; lo que lo vuelve torre de control es que
cada cifra traiga **el botón que la cambia**.

---

## 2 · Lo que Dirección debe VER (las tres, medibles hoy)

### 2.1 Qué espera mi firma, cuánto pesa y desde cuándo

**$74.8 M en 156 obligaciones**, esperando desde el 7-oct. Es el único número donde la acción de
Dirección cambia algo el mismo día.

⛔ **Esto NO lo construye este carril: ya existe.** El carril de Tesorería lo entregó en `[TES.17]`
(`libs/finance/src/lib/budget/pending-approvals.service.ts`) con las dos colas —ejercicios y
obligaciones—, `vacia_porque` derivado, `que_se_traba` por renglón y el duplicado `is_test` excluido y
declarado. **Le falta la pantalla**, y su autor la tiene asignada.

> ⚠️ **Corrección registrada.** El 2026-10-09 este carril propuso *«si eligieras una sola, la cola de
> firmas»* sin haber mirado que ya estaba escrita. Construirla habría sido una duplicación con dos
> implementaciones del mismo conteo. **Antes de proponer una superficie, medir si un carril hermano ya
> la tiene** — el repositorio compartido lo dice en un `git log`.

### 2.2 Cuánto del gasto puede mover, y cuánto no  ⭐ *este carril*

La pregunta real de Dirección frente a un presupuesto es **«¿puedo recortar?»**, y hoy la pantalla
muestra 14 renglones que se ven todos iguales. Medido:

```
FY2027 (PRE-2027-002) · 14 partidas · $74,850,066.62
   SUELDOS Y SALARIOS              $41,538,367.09   55.50%   acum  55.50%
   GASTOS LOGISTICOS                $9,230,750.68   12.33%   acum  67.83%
   GASTOS DE VENTA                  $8,705,596.80   11.63%   acum  79.46%
   GASTOS DE LOCAL                  $6,914,410.12    9.24%   acum  88.70%
   … 10 partidas más suman 11.30%

FY2026 (PRE-2026-002) · 12 partidas · $32,425,843.06
   SUELDOS Y SALARIOS              $16,285,102.80   50.22%   acum  50.22%
   GASTOS LOGISTICOS                $6,233,983.33   19.23%   acum  69.45%
   …
```

⭐ **Tres partidas deciden el 80 % del gasto de 2027; dos deciden el de 2026.** Y la primera es más de
la mitad en los dos ejercicios. Ésa es la respuesta honesta a «¿puedo recortar?»: **no rápido, y no sin
tocar gente.**

⛔ **El agregado de los dos ejercicios NO se publica.** Sumar FY2026 + FY2027 da $107,275,909.68 y
pone a la partida mayor en **38.72 %** —o en 53.90 % si se suman los dos renglones de SUELDOS, que
son de años distintos—, cuando el ejercicio real es **55.4954 %**. Son **16.78 pp de deformación**
(medido por el candado) sobre una cifra que no corresponde a ningún año fiscal y contra la que nadie
puede firmar. La concentración se mide **por ejercicio**, siempre.

### 2.3 Qué tan lejos va el gasto de su ritmo

**$13,653,449.54** que el plan dice devengados y el libro no registra, en 12 partidas con consumo
registrado en cero. Hoy eso se publica como `OCUPACIÓN 0.0 %`, que se lee *«no hemos gastado»*.

Ya entregado por este carril en `[PU.VG.7]` (`libs/finance/src/lib/budget/budget-phasing.ts`,
columnas «Debería a hoy» y «Ritmo» de la pestaña **Gastos**).

⭐ **Y la pestaña Ejercicio lo publicaba MUDO.** La misma `ocupacion()` pinta 0.0 % ahí sin ninguna
explicación al lado — y no es una fila suelta: medido, **las 26 partidas tienen los cuatro estados
en $0.00**, así que la columna dice 0.0 % en todas y «Disponible» dice el total. Cerrado en esta
entrega sin mover el número: la columna gana un `title` que distingue las dos lecturas (el helper
es **compartido**, así que arregla las dos pestañas a la vez) y la pestaña declara en una línea que
el libro no registra un movimiento. **Un «100 % disponible» que sale de `original − 0 − 0` es una
tautología, no una medición.**

---

## 3 · Lo que Dirección debe DECIDIR (tres decisiones con monto)

Están declaradas y **ninguna tiene dueño asignado**. No son trabajo de código: son actos de Dirección
que el código sólo puede poner enfrente.

| Decisión | Lo que está en juego | Dónde vive hoy |
|---|---|---|
| ¿El gasto lleva **freno duro**? | **$107,275,909.68** · 26 de 26 partidas en `advertencia`, **cero** en `bloqueo` | `budget_lines.control_level` |
| ¿Quién **firma el supuesto**? | el plan no es presupuesto hasta que alguien firme | `budget.budgets.authorized_by` = NULL en 3 de 3 |
| ¿Cómo se cierra un **ejercicio parcial**? | FY2026 publica **5 de 12 meses** como si fuera anual | `expense_plan_lines.year_month` |

---

## 4 · Lo que NO se puede publicar todavía — y hay que decirlo

**`analytics.kpi_thresholds` tiene 0 filas en todo el sistema.** Por **ADR-076** eso significa que
**ningún KPI puede llevar semáforo hoy**: saldrían `sin_meta`, ni buenos ni malos.

> ⛔ **Si se arman 16 mosaicos y 13 dicen «sin meta», la torre enseña a ignorarse en una semana.**
> Primero se registran los umbrales; después se pinta el color.

Y estas preguntas **no tienen respuesta posible** con lo que hay capturado — medido, no supuesto:

| Pregunta de Dirección | Por qué no se puede contestar | Medición |
|---|---|---|
| ¿Quién responde por esta desviación? | la columna existe y está vacía | `responsible`: **0 de 26** |
| ¿Es gasto fijo o variable? | la columna existe y está vacía | `expense_class`: **0 de 26** |
| ¿Es precio o volumen? | no existe cantidad en ninguna tabla del módulo | — |
| ¿Cuánto gasto por peso vendido? | el plan de ingreso declara **3.05×** la venta real | el denominador haría falsa cualquier razón |
| ¿Cuánto llevo ejercido? | el ledger de 5 estados nunca se operó | reservado/comprometido/ejercido/pagado = **$0.00** |

Además, **$7,382,153.07** de impuestos y gastos financieros quedan **enteramente fuera** del
presupuesto (familias 7 y 8).

⚠️ **El `disponible` de hoy es una tautología.** `available_amount` se computa como
`original − reservado − pagado`, y los dos sustraendos son cero en las 26 partidas: la pantalla dice
«100 % disponible» porque nadie operó el ledger, no porque haya plata.

---

## 5 · Dónde vive — y esto es lo que más importa

⛔ **No una pantalla nueva.** `ADR-076` ya lo resolvió: el cuadro de Dirección se renderiza dentro de
**«Mi trabajo»** (`/projects`, ADR-061). Un tablero aparte sería la 12.ª landing y rompería `[SN.30]`.

**Presupuestos PUBLICA sus KPIs a ese contrato; no construye torre propia.** Lo que este módulo debe
hacer es tener la cifra lista, con su fuente y su veredicto, para cuando CDRP la pida.

---

## 6 · Qué se construye, en orden

| # | Qué | Carril | Estado |
|---|---|---|---|
| 1 | Bandeja de firmas — servicio | Tesorería `[TES.17]` | ✅ en código |
| 2 | Bandeja de firmas — pantalla | Tesorería | 🔨 asignada |
| 3 | **Concentración del gasto por ejercicio** | **este carril `[PU.VG.10]`** | **✅ entregado — §9** |
| 4 | La pestaña Ejercicio deja de publicar un **0.0 % mudo** | este carril `[PU.VG.10]` | **✅ entregado — §9** |
| 5 | Registrar umbrales de las 3 decisiones | **Dirección** (no es código) | ⬜ bloqueante de todo semáforo |
| 6 | Capturar `responsible` y `expense_class` | **Dirección / Finanzas** (captura humana) | ⬜ bloqueante de §4 |

---

## 7 · `[PU.VG.10]` — Concentración del gasto: el alcance de ESTA entrega

**Contesta una sola pregunta: ¿cuánto del gasto de este ejercicio puede mover Dirección, y cuánto
no?** Y declara, en la misma superficie, lo que impide contestar las otras.

**Lo que entrega:**

1. `libs/finance/src/lib/budget/budget-concentration.ts` — función **pura**: dada la lista de partidas
   de **un** ejercicio, devuelve el orden descendente con porcentaje y acumulado, cuántas partidas
   hacen el 80 %, y la cobertura de los campos que faltan. Vive en `libs/` porque un primitivo
   inventado en una fase no la cierra hasta compartirse (**ADR-056**).
2. `budget-concentration.spec.ts` — con **prueba de mutación**: invertir el orden o contar el 80 % con
   `<` en vez de `<=` tiene que poner el candado en rojo.
3. `ExpenseConcentration` en `libs/contracts` — el tipo lo comparten servicio y plantilla.
4. `GET budgets/:id/expense-plan/concentracion` — por ejercicio, **nunca agregado**.
5. Bloque en la pestaña **Gastos**: la tabla de concentración + la línea «N partidas deciden el 80 %»
   + el aviso de lo que no se puede contestar.
6. `database/tests/test-newdb-budget-concentracion.js` — smoke DB-direct **read-only** contra prod, con
   prueba negativa.

**Lo que NO entrega, declarado:**

- No dibuja semáforo: sin `kpi_thresholds` el estado sería `sin_meta`, y pintarlo verde sería el
  `cfg ? classify : 'ok'` que la Fase VP ya midió dando verde incondicional.
- No propone el recorte. Decir «recortá SUELDOS» es una decisión de negocio con gente adentro.
- No suma ejercicios (§2.2).
- No toca la bandeja de firmas (§2.1, es del carril hermano).

---

## 8 · Lección de método

⭐ **Antes de proponer una superficie, medir si un carril hermano ya la tiene.** La cola de firmas se
propuso acá como *«la única por la que empezaría»* estando ya escrita y commiteada en `main` por el
carril de Tesorería. El costo de no mirar no es sólo el trabajo repetido: son **dos implementaciones
del mismo conteo**, que es exactamente el defecto que la Fase VP documenta en ocho bandejas de
hallazgos distintas.

⭐ **Un agregado que nadie puede ejecutar no es un dato.** «$107.3 M, SUELDOS 53.9 %» suma dos
ejercicios fiscales; ningún director puede firmar contra esa cifra. El mismo dato partido por ejercicio
—55.50 % y 50.22 %— sí se puede accionar. **El universo es parte del número.**

---

## 9 · `[PU.VG.10]` entregado — lo que quedó y con qué se comprueba

| Pieza | Archivo | Comprobación |
|---|---|---|
| Función pura | `libs/finance/src/lib/budget/budget-concentration.ts` | — |
| Unitaria | `budget-concentration.spec.ts` | **16 ✓**, mutada a rojo **3 veces** |
| Contrato | `libs/contracts/src/http/budget-expense-plan.contract.ts` | typecheck de plantillas ✓ |
| Servicio + endpoint | `budget-expense-plan.service.ts` · `GET budgets/:id/expense-plan/concentracion` | — |
| Pantalla | pestaña **Gastos** de `/finanzas/presupuesto` | `check:templates` ✓ · `check:templates-types` ✓ |
| Declaración del 0.0 % | pestañas **Ejercicio** y **Gastos** (helper compartido) | `check:estilos` ✓ · `nx test view` ✓ |
| Candado DB-direct | `database/tests/test-newdb-budget-concentracion.js` | **19 ✓ / 0 ✗ / 0 no medido** contra prod |

**Las tres mutaciones que ponen la unitaria en rojo** (un candado sin prueba negativa es una
intención):

| Mutación | Qué rompe | Rojo |
|---|---|---|
| `>= 80` → `> 80` | el borde exacto: una partida de 80.00 % pediría un renglón de más | 1 de 16 |
| la fila sin monto suma 0 | la ausencia dibujada como cero subdeclara la concentración | 2 de 16 |
| orden ascendente | la concentración al revés | 6 de 16 |

**Y la prueba negativa del candado contra prod** mide que la definición no es un no-op: la lectura
ingenua («cuántas caben enteras abajo del 80 %») daría **3 en FY2027 y 2 en FY2026**, cuando las
respuestas correctas son **4 y 3**. Si un ejercicio no distinguiera las dos, el bloque reporta
**NO MEDIDO** en vez de ponerse verde.

⚠️ **Falta, declarado:** verificación HTTP del endpoint (ADR-044) y validación visual — no se
levanta backend en local durante una sesión. Sin migración ni permiso nuevo: **no hace falta
re-login**, sí redeploy de `api` + `view`.

---

## 10 · `[PU.VG.11]` El acuerdo entre sesiones — un primitivo, una gramática

> **Para la sesión de Ventas.** Esta sección es el acuerdo, no una opinión sobre su pantalla. Lo
> que su superficie de `DECIDIR` hizo bien está adoptado acá, y lo que se corrige se corrige en
> **las dos mitades**, porque la falta fue simétrica.

### 10.1 El hallazgo que lo motivó, medido contra prod el 2026-10-09

La superficie de ingreso publicaba *«4 de 8 entidades cargan el 81.6 % del plan»*. Verificado:

| Afirmación | Veredicto |
|---|---|
| Subtotal Mostrador $353,538,587.63 | ✅ **exacto al centavo** (8 renglones) |
| «la mayor es el 34.8 % de Mostrador» | ✅ 34.76 % |
| «2 entidades aportan menos del 5 % cada una» | ✅ 3.63 % y 1.85 % |
| «los **nueve** renglones de Mostrador» | ⚠️ son **ocho** |
| «4 de 8 cargan el 81.6 % **del plan**» | ⛔ ese 81.6 % es **de Mostrador** |

```
Mostrador  $353,538,587.63 = 58.46 % del plan $604,775,116.21
las 4 mayores:  81.64 % de Mostrador   vs   47.72 % del plan     → 33.91 pp
```

⛔ **Y es exactamente mi falta, espejada.** Yo sumé FY2026 + FY2027 y publiqué 38.72 % donde el
ejercicio real es 55.4954 %. **Las dos cifras son aritméticamente correctas sobre un universo que
la frase no nombra.** Ninguno de los dos mintió; los dos omitimos el denominador.

### 10.2 Lo que el recorte borraba, y es lo más caro

El mismo primitivo sobre los dos lados **completos**:

| | Renglones | La mayor | Cruzan el 80 % |
|---|---|---|---|
| **Ingreso** | 33 | **20.32 %** | **9** |
| **Gasto** | 14 | **55.4954 %** | **4** |

⭐ **El gasto está concentrado y el ingreso no.** Traducido: *no se puede recortar rápido, pero
tampoco se depende de un cliente*. Esa asimetría es la decisión que Dirección necesita y **ninguna
de las dos mitades la decía** — la de ingreso porque mostraba un canal donde la concentración se ve
artificialmente alta, la de gasto porque no mostraba concentración.

### 10.3 El acuerdo, en cuatro puntos

**(1) Un solo primitivo, ya compartido.** `libs/finance/src/lib/budget/budget-concentration.ts`
es puro y **agnóstico**: recibe filas con `concept` + `original_amount` y no sabe de qué son. Los
números de §10.1 y §10.2 salieron de él. Ventas lo importa; no hay que escribir nada.

**(2) El universo es un ARGUMENTO con unión discriminada.**

```ts
type Universo =
  | { nombre: string; completo: true }
  | { nombre: string; completo: false; de: string; pct: number | null };
```

No se puede construir un resultado sin declarar si el conjunto está completo o es un recorte, **y de
qué es recorte**. Un comentario que pide nombrar el universo se puede no leer; un tipo que no
compila, no. `pct: null` = no medible, **nunca 0**.

**(3) La regla de N se fija: la que CRUZA el umbral, y el umbral se nombra.** *«N renglones deciden
el 80 % de \<universo\>»*. El 80 % y el 5 % de la frase inversa son **cortes de descripción, no
políticas**: viajan en la salida (`umbral_pct`, `umbral_menor_pct`) y la frase los dice. Un corte
que se usa y no se dice es indistinguible de una política que nadie firmó.

**(4) La frase la emite el SERVIDOR.** `fraseConcentracion()` devuelve `{ titular, detalle,
inversa, es_ausencia }`. Si la arma cada plantilla, las dos mitades vuelven a contar la misma idea
con dos gramáticas — que es el problema que esto cierra. Hereda el espíritu de ADR-076: el veredicto
no lo arma el cliente.

### 10.4 Lo que este carril ADOPTA de la superficie de Ventas

- **El titular contesta, y contesta que no cuando no se puede.** Mi bloque **preguntaba**
  («¿Cuánto se puede mover?»); ahora afirma, y cuando no hay con qué, el titular lo declara
  (`es_ausencia`) en vez de dejar un bloque vacío, que se lee como «todo bien».
- **La frase inversa.** *«10 renglones aportan menos del 5 % cada uno (11.30 % entre todos): no
  mueven el total.»* Le dice a quien decide **dónde no mirar** — la mitad que ninguna tabla
  ordenada por importe contesta.

### 10.5 Lo que queda del lado de Ventas

1. Cambiar *«del plan»* por *«de Mostrador»*, **o** mostrar el ingreso completo.
2. Si se queda el recorte, declarar que **Mostrador es el 58.46 % del plan** — con el primitivo sale
   solo en `detalle`.
3. Corregir «nueve renglones» → **ocho**.
4. «Mostrador» repetido en las cuatro filas es tinta muerta: va en el encabezado.
5. El tercer modo (teléfono) no se pudo verificar: en la imagen sólo viajan oscuro y claro.

**No se propone tocar el layout.** El answer-first sin tabla es correcto y la paridad oscuro/claro
se ve limpia.

### 10.6 Verificación de este acuerdo

| Qué | Dónde | Resultado |
|---|---|---|
| Unitaria | `budget-concentration.spec.ts` | **32 ✓**, mutada a rojo **7 veces** |
| Candado DB-direct | `test-newdb-budget-concentracion.js` | **25 ✓ / 0 ✗ / 0 no medido** contra prod |
| Las 6 suites de budget | `libs/finance` | **104 ✓** |

**Las siete mutaciones:** borde `>= 80` → `> 80` · la fila sin monto suma 0 · orden ascendente ·
`menores` con `<=` · la frase omite la fracción del recorte · `es_ausencia` clavado en `false` ·
`de el` sin contraer.

⚠️ **Y una trampa del método, vivida acá:** la primera mutación con `sed` **no aplicó**, y eso se ve
**idéntico** a una mutación que las pruebas sobrevivieron. El script de mutación ahora **falla con
exit 2** si no encuentra la línea. *Una mutación que no se aplica es un candado verde que no probó
nada.*

**La prueba negativa que sostiene todo §10:** el candado mide **las dos lecturas del mismo hecho**
contra prod y **exige que difieran** — hoy 81.64 % contra 47.72 %, **33.91 pp**. Si coincidieran,
nombrar el universo sería decorativo y esta sección no haría falta.
