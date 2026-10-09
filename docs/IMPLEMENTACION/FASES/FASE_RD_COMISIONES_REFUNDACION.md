# Fase RD — Refundación de Comisiones de Ruta Directa

> **Estado**: 🔨 PLANEADO 2026-10-08 · sin código · ADR-088 propuesto
> **Disparador**: *"analizá esta interfaz, es obsoleta vieja e infuncional: `/comercial/comisiones`"*
> más el workbook `INDICADORES RD 2026 (1).xlsx` al día.
> **Antecede**: [`FASE_RD_CICLO_QUINCENAL`](FASE_RD_CICLO_QUINCENAL.md) (RD.6, RD.17–RD.23).

---

## 0. Lo que se midió antes de planear

Todo lo de abajo es medición contra **prod** (`pg-prod` en `md`, k3s `ns/prod`, imagen
`1a592cf9`) y contra el archivo, el 2026-10-08. Nada sale de memoria.

| # | Qué se midió | Resultado |
|---|---|---|
| 1 | ¿La pantalla es vieja? | **No.** Reescrita el 7–8 de octubre, prod la sirve desde las 11:09. Angular con señales, `OnPush`, tokens de `DESIGN.md`, master-detail. |
| 2 | `commercial.commission_runs` | **0 filas. Nunca tuvo ninguna**, ni borradas. `commission_run_lines`: 0. |
| 3 | ¿Alguien lo intentó? | Sí. Log de la API, **11:16:07**: `20 cerrada(s) · 0 calculada(s) · 0 saltada(s) · 20 falla(s) · 248,596 ms`. |
| 4 | ⛔ Por qué falla | `42703: column "dias_multifuente" of relation "commission_runs" does not exist`. **Reproducido contra prod** en transacción revertida. |
| 5 | ¿El motor sabe calcular? | **Sí, al centavo.** Q1 ruta por ruta contra el libro: 21 → `228,380.02 = 228,380.02`; 23, 26, 27 y 28 exactos; 22 difiere **1¢**. |
| 6 | ¿Y el costo? | **Existe desde enero**: `costo_wincaja` en Q1 = `2,284,501.85`, 143 de 143 días. El motor ya lo usa como respaldo. Lo que arranca en junio es el **COGS del embarque**, que es otra fuente. |
| 7 | Qué paga el libro en 2026 | 20 quincenas · comisión chofer **$1,580,327.48** · supervisor **$395,081.87** · **neto $796,981.88** · **238 ruta-periodo**. |
| 8 | Universo | 13 rutas comisionan. `VEC-PH-H` vende **$271,509.07 en Q1** con veredicto `tipo_sin_declarar`. 321/322/505 siguen `comisiona = true` con la fuente muerta 99–128 días. |
| 9 | Costo de calcular | **12–13 s por quincena**, porque `v_rd_commission_sales` lee la vista **viva** `v_rd_route_daily`. |
| 10 | Y existe su matvista | `analytics.mv_rd_route_daily_200d`, **refresco cada 30 min**, ya consumida por Ventas por ruta. El motor de comisiones es el único que no la usa. |
| 11 | Quién puede | **15 personas** abren la pantalla; **11** pueden calcular (`direccion` 2, `finanzas` 1, `superadmin` 8). |
| 12 | El candado | `commission-inmutable.spec.ts` llama `persist(trx,'t1',PERIODO,ESCALA,{},[],ctx)` — **`{}` como totales, sobre dobles de knex**. El propio archivo advierte en su línea 17 que no ejecuta SQL. |

### 0.1 Dos cosas que afirmé y la medición corrigió

- *"El costo no existe antes de junio"* — **falso**. No existe el **COGS del embarque**; el costo
  de línea de Wincaja está completo desde enero y la precedencia del motor ya lo toma
  (`cogs_ruta ?? cogs_erp ?? costo_wincaja`). Las dos fuentes son **complementarias**: Wincaja
  cubre ene–ago y el ledger jun–oct, con un traslape de tres meses donde una arbitra a la otra.
- *"Nadie apretó el botón"* — **falso**. Lo apretaron, tardó 4 min 09 s y falló 20 de 20.

---

## 1. La tesis

⭐⭐ **El módulo intenta RE-DERIVAR lo que ya se pagó, y eso está al revés.**

Una quincena pagada **no es un cálculo: es el registro de un depósito que ocurrió**. El propio
motor ya lo dice en `persist()` — *"lo pagado no se edita, nunca, ni con `replace`"* — pero el
módulo nació sin la historia, así que la única forma de llenar la pantalla es pedirle al motor
que reconstruya 20 quincenas desde fuentes que, para esas fechas, ya no son el testigo que se
usó para pagar.

Lo que eso cuesta, medido: publicar Q20 con el motor **le pagaría $0 a la 504 en vez de
$1,092.46**, porque le faltan 7 de 12 días y el tramo más bajo es un acantilado en $189,999.99
de venta. No es un error de cuentas: es pedirle a la fuente de hoy que responda por el pasado.

**La refundación es invertir el orden:**

| | Hoy | Refundado |
|---|---|---|
| La historia | se re-deriva, y sale mal | **se espeja** del libro, congelada, `pagado` |
| El motor | tendría que pagar 20 quincenas viejas | **calcula sólo hacia adelante** |
| La confianza | una tabla de 125 comparaciones hecha a mano dentro de un `.md` | **238 ruta-periodo de contraste, en pantalla** |
| La pantalla | cascarón | el año completo, desde el día 1 |

Resuelve solo tres cosas: la 504 deja de bloquear la publicación (Q20 entra como pagada e
intocable), el motor gana un árbitro de 238 filas contra el cual medirse, y la pantalla deja de
ser un cascarón sin esperar a que la fuente se repare.

> ⚠️ **No contradice la regla #1 del proyecto (cero importers).** Lo que se carga no es un
> derivado que haya que re-correr ni agendar: es un **histórico congelado de un hecho**,
> exactamente el caso que la regla permite como tabla real. Se carga una vez, se cuadra al
> centavo, y no se vuelve a tocar.

---

## 2. El plan

### [RD.50] Destrabar — sin esto nada más importa ⛔ ruta crítica

El `INSERT` falla el **100%** de las veces, para toda quincena, desde `c4dff2b04` (PR #303).

1. `totales()` devuelve `dias_multifuente`; `persist()` hace `...totals` dentro del `INSERT`; esa
   columna vive en `commission_run_lines`, **no** en `commission_runs`. Dos caminos:
   **(a)** sacarla del spread (cero migraciones) o **(b)** darle columna, que es lo fiel a la
   intención porque la compuerta de traslape ya la consume. **Recomendado: (b)** — el valor
   agregado del periodo merece congelarse igual que `dias_con_venta`.
2. **El motivo al log.** Hoy `fallas[]` viaja sólo en la respuesta HTTP: quien cierre la pestaña
   pierde el diagnóstico, y el log dice `20 falla(s)` sin una palabra de por qué.
3. **Candado que INSERTA de verdad**, en `database/run-all-tests.js` contra una DB real. Los
   dobles de knex no ven un `42703`: este repo ya lo pagó 13 veces y el archivo lo tenía escrito.
   ⭐ La aserción correcta no es *"el insert funciona"* sino **`Object.keys(totales(...)) ⊆
   columnas de `commission_runs``**, con prueba negativa: agregarle una clave inventada a
   `totales()` tiene que ponerlo rojo.

**Medición de cierre**: `recalculate-from` sobre una quincena cerrada deja fila, y la mutación
del punto 3 falla.

---

### [RD.51] El espejo del libro — la historia que ya se pagó

Carga **única y verificada** de las 20 quincenas de `INDICADORES RD 2026` a `commission_runs` y
`_run_lines`, con `status = 'pagado'` y `origen = 'libro'`.

- **238 ruta-periodo**, dos beneficiarios cada una (chofer + supervisor).
- **No se carga si no cuadra al centavo** contra los tres totales del punto 7 de §0. El cuadre es
  precondición, no reporte posterior.
- Las filas que el libro marca `NO APLICA` entran con `motivo_no_pago`, **no como $0**: son dos
  hechos distintos, y pintarlos igual es lo que esconde una ruta que dejó de vender.
- ⚠️ Lo que el libro **no trae** (días cubiertos, fuentes, veredicto de costo) entra **NULL con
  motivo**, nunca cero. Un recibo viejo no puede afirmar una cobertura que nadie midió.
- `commission_runs_una_viva_por_periodo` y el freno de `persist()` ya garantizan el resto: una vez
  cargada, **ni el motor ni el botón pueden pisarla**.

**Medición de cierre**: la pantalla abre en 2026 y muestra 20 quincenas con monto, origen `libro`
y estado `pagado`. El tablero sigue costando milisegundos, porque lee tabla y no vista.

#### Estado 2026-10-08 — cargador escrito y cuadrado en seco, carga BLOQUEADA

`database/scripts/cargar-libro-comisiones-rd.js`. Medido contra prod, sin escribir:

```
238 ruta-periodo (190 con pago, 48 sin tramo)
comision del chofer      1,580,327.48   Δ 0.00
a pagar (neto)             796,981.88   Δ 0.00
20% del supervisor         395,081.87   Δ 0.00   (informativo, NO se carga)
precondiciones: escala ✔ · 20 quincenas ✔ · rutas ✔ · fechas 20/20 ✔ · tabla vacia ✔
```

⭐ **El mapa ruta → bloque sale del propio workbook**, no de los rótulos: las fórmulas de
`FORMATO DE PAGO` apuntan a `COMISIONES!<col><fila>`. Los rótulos dicen `RUTA CANINDO 503 (501)`
y el número entre paréntesis es un nombre viejo — leerlo mal cambia a quién se le paga.

⚠️ La primera versión comparaba la fecha de cierre tomando sólo las que están en **texto**:
**1 de 20** comprobadas, y la precondición salía ✔ igual. La cobertura es parte de la aserción.

#### ⛔ La línea del SUPERVISOR no se carga — y no es por falta de dato

Medido en `FORMATO DE SUPERVISOR`: **el libro le paga dos cosas distintas a dos supervisores.**

```
T19 (ANGEL)      → INDEX(… MATCH($T$16, $B$12:$E$12) …)  → columna E = "Comisión"  (el 20 %)
T25 (FRANCISCO)  → INDEX(… MATCH($G$12, $B$12:$G$12) …)  → columna G = "Bono por alcance"
```

Y el pie del recibo de FRANCISCO suma el bono **dos veces** — «Suma de Comisiónes a Pagar»
`2,400` + «Bono por alcance de %» `2,400` = «Total a Pagar» `4,800` — mientras su 20 % del
periodo (2,004.77 + 1,771.86 + 2,405.04 + 1,680.81 = **7,862.48**) **no entra en ningún
renglón**. El mismo recibo publica además «Neto del recibo» `2,400` contra «Total a Pagar»
`4,800`.

Escribir eso como `pagado` afirmaría un hecho que el archivo no sostiene. Se declara en la nota
de cada corrida y pasa a ser decisión (abierto #3). ⭐ Y tiene consecuencia sobre el motor: su
modelo limpio —20 % por ruta menos deducción por persona— **no reproduce lo que se le pagó a por
lo menos un supervisor**, así que la compuerta de promoción de `[RD.52]` debe medirse **sólo
sobre la línea del chofer** hasta que esto se resuelva.

---

### [RD.52] El contraste — el valor que hoy no existe en ninguna pantalla

Pestaña **Libro vs motor** por ruta-periodo: Δ$, Δ% y **veredicto** (`cuadra` ·
`fuente_incompleta` · `otra_causa`).

Hoy esa comparación existe como una tabla de 125 filas dentro de un `.md`, hecha a mano una vez.
Con el espejo cargado son **238 filas que se recalculan solas**, y convierten la historia en la
prueba del motor. De las 125 ya medidas: **108 cuadran** (desviación mediana 0.11%), 14 son días
que le faltan a la fuente, y **3 descuadran sin causa conocida** — esas 3 son el trabajo.

⭐ **Compuerta de promoción**: el motor no pasa de auditor a pagador hasta que **N quincenas
consecutivas cuadren dentro de X%**. N y X los fija Edgar, pero el mecanismo se construye acá, y
mientras no se cumpla la pantalla lo **declara** en vez de sugerir que el motor ya manda.

#### La medición, 2026-10-08 — las 238 ruta-periodo, ya con los dos lados comparables

Lo que se le pagó al chofer según el recibo, contra lo que el motor pagaría hoy:

| veredicto | n | pago libro | pago motor | Δ |
|---|---:|---:|---:|---:|
| cuadra (≤ $1) | **111** | 551,006.43 | 551,006.22 | −0.21 |
| difiere ≤ 5 % | 46 | 230,925.98 | 231,031.08 | **+105.10** |
| difiere > 5 % | 22 | 120,555.20 | 79,291.15 | −41,264.05 |
| el libro pagó y el motor **NO** (acantilado) | **9** | 26,932.74 | 0.00 | **−26,932.74** |
| sin fuente en el motor | 5 | 8,361.52 | 0.00 | −8,361.52 |
| ninguno paga (coinciden) | 45 | 0 | 0 | 0 |
| | **238** | **937,781.87** | **861,328.45** | **−76,453.42** |

⭐ **111 de las 193 que pagan cuadran al peso (57.5 %)**, y el total del libro reproduce exacto el
que quedó cargado — o sea que el contraste no arrastra un error de lectura.

⛔ **Lo que duele está concentrado en 14 filas**: 9 por el acantilado del tramo y 5 sin fuente,
**$35,294 que el motor tiraría a CERO**. Más 22 que difieren más de 5 % por −$41,264. Si el motor
hubiera pagado 2026, los choferes habrían cobrado **$76,453 menos — el 8.2 %**.

⚠️ El bucket de ≤5 % es el único donde el motor paga **de más** (+$105): ahí los bonos compensan
la diferencia de venta. No es ruido simétrico.

⚠️ La medición se hizo con SQL que **reimplementa** la regla del motor leyendo sus propias tablas
(`commission_scale_tiers`, `commission_bonuses`, `share_supervisor_pct`). Sirve para dimensionar;
**la pantalla tiene que llamar al motor real** (`computeRun` en modo vista previa), porque una
copia se desincroniza. Y no puede vivir en `commission_runs`: el índice
`commission_runs_una_viva_por_periodo` prohíbe una segunda corrida viva por periodo, así que el
contraste necesita tabla propia.

---

### [RD.53] La fuente — lo que hace que el motor pague mal

1. ⭐⭐ **Latido con `max(fecha)`, no con filas entregadas.** `ingest.route_push_heartbeat` de la 504
   está **verde** con 5,348 filas diarias desde `192.168.50.21` mientras reescribe la misma
   ventana vieja: *la camioneta sube todos los días y lo que sube no tiene fechas nuevas*. Con la
   fecha más nueva en el latido, esto se veía el 2 de octubre y no el 8.
2. **Depurar el padrón**: 505 lleva 28 días sin dato, 322 lleva 99 y 321 lleva 128, y las tres
   siguen `comisiona = true`.
3. **`VEC-PH-H`** vende $271,509 en Q1 y su veredicto es `tipo_sin_declarar`. Declararla o
   excluirla, pero *"no sé"* no es un estado en el que una ruta pueda quedarse un año.
4. Con el padrón limpio, `cobertura_dias` pasa de **avisar a bloquear** sin falsos positivos. Hoy
   no puede: marca 22 y 8 de esas cuadran al 0.0% porque el camión de verdad no salió, y una
   compuerta que grita en falso una de cada tres veces enseña a ignorar el tablero.
5. **Una venta fechada 2026-12-06** (ruta 22, $230.49) entraría sola en una quincena de diciembre.

---

### [RD.54] El acto de calcular — sacarlo del request

- Hoy es un **POST bloqueante de 4 min 09 s**, sin progreso, sin reintento y sin rastro si el
  navegador se cae. El cálculo debe correr en el `worker` (que ya existe en prod) y la pantalla
  consultar estado.
- ⭐ **Perf**: `v_rd_commission_sales` lee la vista viva mientras `mv_rd_route_daily_200d` —
  refresco cada 30 min, ya consumida por Ventas por ruta — está ahí. 13 s a milisegundos.
  ⛔ **Pero la matvista cubre 200 días, y hoy eso arranca el 2026-03-22**: cambiarla a secas
  **borraría Q1–Q6 en silencio**, que es exactamente la clase de error que esta fase existe para
  no repetir. Va híbrido declarado (matvista dentro de la ventana, vista viva fuera), o la
  ventana se amplía a propósito y con su medición.
- Revisar **quién puede calcular**: 11 personas con `GESTIONAR`, 8 de ellas por `superadmin`.
  Calcular nómina no es administrar la plataforma.

---

### [RD.55] El recibo — `FORMATO DE PAGO`

Lo que falta no es la plantilla: es el **padrón de personas**. La hoja trae RFC, CURP, NSS y
fecha de inicio de relación laboral, y nada de eso vive en `identity.users`. **Depende de
[`FASE_RH`](FASE_RH_MIGRACION_MEGA_TALENTO.md)**, y se declara así en vez de improvisarse.

⛔ **Y hay que arreglar el origen antes de copiarlo**: en `FORMATO DE PAGO`, las rutas **321 y 322
comparten RFC, CURP, NSS y fecha de ingreso** (`GUPJ-960926-3G6` · `53-13-96-0676-7` ·
2021-10-02) con nombres de chofer distintos. Es la hoja que alimenta nómina: hoy la identidad
fiscal del 322 es la del 321.

---

### [RD.56] Lo que el libro tiene y la pantalla no

El workbook son **11 hojas**; la pantalla cubre **1.5** (`COMISIONES` y parte de `FORMATO DE
SUPERVISOR`). Por orden de dinero, no de hoja:

| Hoja | Qué aporta | Dónde vive hoy |
|---|---|---|
| `CONTROL DE GASTOS RD` | el gasto real por ruta (2,066 filas) | fuera |
| `OPERACION DE LAS RUTAS` | $/km, rendimiento km/l, % de rentabilidad | parcial en `[RD.3]`/`[RD.5]` |
| `OBJETIVO MENSUAL RD` | el bono por objetivo | fuera, y sus 3 criterios siguen sin definirse |
| `COSTO RD PH` / `COSTO RD CANINDO` | costo fijo por ruta | fuera |
| `CONCENTRADO DE INFORMACIÓN` | el diario que alimenta todo | ⭐ es lo que el ODS ya deriva |

---

### [RD.57] ✅ Rentabilidad de Ruta Directa — la pregunta que la comisión no contesta (2026-10-08)

`/comercial/ruta-directa/rentabilidad`. Permiso propio `COMMERCIAL_ROUTE_PROFIT_VER` (4 roles,
15 personas, derivado de quién ya ve la nómina de RD). Migraciones **845** (datos) y **846**
(permiso) en prod. Candado `test-newdb-rd-rentabilidad.js`.

**Lo que resultó derivable, medido contra prod:**

| El libro teclea | ¿Sale del sistema? | De dónde |
|---|---|---|
| Odómetro | ✅ **por ruta y por día** | `logistics.trackers.route_number` ⋈ `vehicle_positions.odometer` |
| Gasto por concepto | ✅ pero **por PLAZA** | 3 departamentos contables: `1-01-10-20` · `1-03-50-51` · `1-02-32-98` |
| Ruta del gasto | ⛔ no | la contabilidad llega al departamento; el comentario dice "combustible rd" |
| Litros · `$/litro` · `km/l` | ⛔ no | el CFDI guarda sólo el encabezado; XML en 105 de 6,241 facturas |

**Combustible RD 2026 = $821,778** contra los $523,166 que acumula el libro: la contabilidad
tiene **más** que el Excel, no menos.

⭐ **El hueco que destapó:** el libro paga **$1,721,128** de comisión y bonos en 2026; la
contabilidad registra **$1,057,960** en los tres departamentos de RD. Faltan **$663,168**, en las
14 quincenas, sin una excepción. La hipótesis del rezago a la quincena siguiente **se probó y no
lo explica** (con N+1 el delta sigue entre −$28k y −$42k). Se declara con monto; no se netea.

⚠️ **Tres trampas del dato, las tres con guarda:** dos trackers por ruta (unidad + dashcam, cada
uno con su odómetro) · el odómetro que se reinicia (1 de 736 filas: 21,202 km en un día) · la
misma clave de departamento con dos grafías (`CANINDO RD.` y `CANINDO RD`), que agrupada por
nombre parte el total en dos sin avisar.

⭐ **El umbral de «día medido» lo fijó el dato, no el pulgar.** La regla obvia (pocos pings = no
medido) es falsa: un día de 5-19 pings con **20 horas de cobertura** es el camión reportando
**quieto**. El separador son las horas, con un hueco limpio entre 2.1 y 10.1.

### [RD.58] ✅ Quién viene empeorando — la serie (2026-10-08)

`GET /commercial/route-profit/series`. Tendencia por ruta: las últimas tres quincenas contra las
tres anteriores. Es lo que una foto de una quincena no puede dar, y el libro tampoco porque cada
quincena vive en su propia hoja.

⛔⛔ **La primera versión estaba mal y la medición lo destapó antes de publicarla.** Las **seis**
rutas con GPS salían «empeorando» a la vez, con caídas de −$72 a −$230. Que las seis cayeran
juntas no es desempeño: es un artefacto. Medido:

| Quincena | Días con señal | km ruta 26 |
|---|---|---|
| 15 | **3 de 14** | 337 |
| 16 | **11 de 14** | 699 |
| 17–20 | 14 de 14 | 988–1,054 |

El `$/km` de la Q15 dividía la venta de **catorce** días entre **tres** de kilómetros. No
empeoraron: **se completó la medición**. Es el denominador incompleto de `[IC.8]`.

**El arreglo:** el `$/km` sólo se publica con la quincena **completa** de GPS, y cada punto
declara su cobertura (`completa` / `parcial` / `sin_gps`). Después: 3 suben, 2 bajan levemente, y
los niveles son coherentes (160–250 en vez de 300–410). La **28 pasó de «−230, empeora» a sin
base**, que es la verdad. El control del candado: sin la guarda el `$/km` llega a **$675.48**;
con ella el máximo publicado es **$255.65**, sobre **25 de 52** ruta-quincena parciales.

⭐ **Lo que sobrevive como hallazgo:** la **321** es la única cuyo margen empeora (−1.09 pp) y la
**501** la única que mejora (+3.56 pp); las otras once caen dentro de ±0.7.

⛔ **Sin meta, y se declara.** `budget.sales_plan_lines` tiene las 13 rutas de RD con 13 periodos
cada una, pero los **tres** presupuestos cargados están en `borrador`, **ninguno autorizado**, uno
marcado `is_test` y el único de 2026 se llama literalmente **`prueba 2`**. Además hay **tres filas
por (ruta, periodo)** con montos distintos (461,357 / 574,368 / 574,368 en el periodo 1 de la
ruta 21), así que unir sin elegir presupuesto **triplica la meta**.

### [RD.59] ✅ El bono por objetivo mensual, configurable (2026-10-08)

Edgar confirmó que **sigue vigente** y que tiene que ser configurable. Migración **848** en prod.
`/comercial/comisiones/objetivo`, con `COMMISSIONS_VER` para leer y `GESTIONAR` para cambiar.

⭐ **No se creó una máquina de bonos: ya existía.** `commercial.commission_bonuses` tiene 14 filas
vivas, editadas el 7-oct, con `metrica` + `umbral` + `comparador` + `monto` + `route_code`
versionadas por escala — ahí viven *Lavadas*, *Lonche*, *Chalán* y el *Alcance de margen* del
supervisor, este **con umbral distinto por ruta**. Una tabla paralela habría sido la copia que
`GOTCHAS §32` prohíbe. Lo que le faltaba: **periodo** (todo era quincenal), **grupo y peso** (cada
bono era todo-o-nada), **activo** (por eso el objetivo *quedó parado* en vez de apagarse) y dos
métricas nuevas.

⛔⛔ **La guarda que iba primero.** `computeRun` leía **todos** los bonos de la escala sin filtrar.
Una fila mensual habría entrado al cálculo **quincenal** y se habría pagado **dos veces por mes**,
en silencio. Medido: sin el filtro el motor vería **17** bonos donde ve 14. `periodo` nace
`NOT NULL DEFAULT 'quincena'` y el motor filtra `periodo='quincena' AND activo`.

**Dos de los tres criterios dejan de marcarse y se miden:**

| Criterio | Peso | Cómo se resuelve |
|---|---|---|
| Visitas | 50% | ✅ `tickets` por ruta — sep-2026: de 165 (la 505) a 1,118 (la 503). ⚠️ Son visitas **con venta** |
| Desarrollo de marcas | 25% | ⛔ **no derivable** — `v_sellout_daily` con el `vendor_code` de RD devuelve **0 filas** → se marca, con motivo obligatorio |
| Volumen | 25% | ✅ la venta del mes — sep-2026: de $94,608 a $529,895 |

⛔⛔ **Sin marcar NO es «no cumplió», y ésa es la diferencia con la hoja.** En el Excel una celda
vacía vale `0%`: el silencio **castiga**. Acá `cumplido` es **ternario** y el `null` suma a
`sin_resolver_pct`, que se publica **al lado**. Verificado contra prod en septiembre: las rutas
**321 y 322**, que no vendieron, salen **0% alcanzado y 100% sin resolver** — no reprobadas; la
**505**, que sí se quedó corta, sale con **75% fallado**. `alcanzado + sin_resolver + fallado = 100`
en las 13 rutas.

**Tres guardas más, de pensar cómo se rompe:** umbral 0 **no regala** el criterio (sale `sin umbral
configurado`, porque con 0 todo lo cumple) · **no se deja marcar a mano lo que sí se puede medir**
(sería pisar la medición sin que se note) · los pesos tienen que **seguir sumando 100 después** de
editar uno, y como un CHECK no ve otras filas, se exige en el servicio antes de escribir.

⛔ **Nace apagado y NO paga.** `activo=false`, `monto=0`, y la configuración publica
`entra_a_nomina: false`. El importe y los umbrales **no se inventaron**: los fija el negocio desde
la pantalla. *Medir antes de pagar.*

⭐ **El candado de `[RD.6]` hizo su trabajo dos veces** al correrlo: su conteo de "3 bonos de
chofer" se cayó con los criterios sembrados (se arregló **filtrando como el motor**, no subiendo el
número), y su vigilancia de RLS usa `relname LIKE 'commission%'` — `objective_marks` **no empieza
con commission**, así que habría quedado sin vigilar. Se amplió el patrón, no sólo el conteo.

### [RD.60] ✅ Gasto renglón por renglón + la ficha de cada unidad (2026-10-08)

⛔ **Las dos las había declarado NO construibles, y me equivoqué.** Al volver a medir, las dos
salen — con menos de lo que el libro promete, y con algo que el libro no tiene. Lo que estaba mal
no era la medición de los huecos (siguen siendo ciertos, se enumeran abajo) sino la conclusión que
saqué de ella: *un dato faltante no vuelve inútil a la pantalla; la vuelve una pantalla que tiene
que declarar el hueco.*

**`/comercial/ruta-directa/gastos` — el gasto renglón por renglón.** Es la hoja `CONTROL DE GASTOS
RD`, salvo que los renglones **ya existen**: salen de la contabilidad, nadie los captura. `[RD.57]`
los muestra agregados; ésta muestra el movimiento. Medido en la quincena 20: **95 renglones, 17
conceptos, 89 con comentario**, y el comentario dice cosas que nadie miraba (`ARRENDAMIENTO NP300
RD PH` $18,525.86 · `ROTULACIÓN CAMIONETA PIN PON` $7,000 · `LONA PARA CAMIONETA DE RD` $350).
⛔ El comentario **se muestra como texto y no se parsea**: a veces nombra la camioneta, pero
derivar la ruta de una cadena escrita a mano sería adivinar.

**`/comercial/ruta-directa/flota` — la ficha de cada unidad.** El padrón sigue casi vacío **y la
pantalla lo dice en la cara** en vez de verse pobre: cada ficha enumera *«falta capturar: modelo,
año, número de serie, aseguradora»*, que convierte «la pantalla está pobre» en «esto es trabajo
pendiente» (ADR-056). ⭐ Y da lo que el libro no tenía: el **odómetro vivo** del GPS, los días sin
reportar, y los **vínculos sospechosos** — la 321 sale marcada sola.

**Dos defectos que encontró el propio armado:**

- El `track` de la tabla pegaba dos campos nulables para fabricar una llave. **`expense_entries` ya
  tiene `id`**, y en el dato hay **dos `CASETAS MORELIA` de $26.10 el mismo día**: un `track` que
  colisiona hace que Angular reutilice la fila equivocada justo al reordenar, que es lo que esa
  tabla hace. El arreglo no era callar al compilador con `!`.
- **El total de arriba y el de abajo se dicen los dos.** El de arriba es el de la quincena entera
  (`v_rd_expense_period`), el de abajo el de lo que se ve con el filtro puesto. Si el total saliera
  de la página, una tabla filtrada publicaría una cifra más chica sin avisar. Hay **tope de 400
  renglones y se declara** cuando trunca.

Mismo permiso `COMMERCIAL_ROUTE_PROFIT_VER` — **sin migración y sin re-login**. Validado contra
prod: el total cuadra al centavo ($288,988.44 = $288,988.44), **16 ms** el gasto y **17 ms** la
flota. Con esto Ruta Directa suma **cinco pantallas**.

---

### La única pantalla del artefacto que sigue sin construirse

- **El recibo (hoja 6).** Bloqueado por el **padrón de personas** (Fase RH): la hoja trae RFC,
  CURP, NSS y fecha de inicio de relación laboral, y nada de eso vive en `identity.users`. El
  detalle —y el defecto del origen, que las rutas **321 y 322 comparten identidad fiscal**— en
  `[RD.55]`.

**Lo que se midió como hueco y sigue siéndolo, dentro de pantallas que SÍ se construyeron:**

- **`$/litro` por carga** (hoja 3): no hay dato — ni litros ni ruta en el gasto. La pantalla
  muestra el renglón; el rendimiento no.
- **Vencimiento de póliza** (hoja 4): **no existe la columna en toda la base**, y era justo el
  aviso que la hoja prometía. La ficha lo enumera como pendiente de captura, no lo dibuja. ⚠️ Hay
  un **segundo padrón** (`analytics.v_kepler_transporte`) con placas en **tres formatos**
  (`NS-0886-D`, `NB-0703D`, `GN3865D`) que cubre **4 de las 8** camionetas de RD.
- **Desarrollo de marcas** (hoja 5): `v_sellout_daily` con el `vendor_code` de las rutas de RD
  devuelve **0 filas**. El criterio existe en `[RD.59]` y se **marca a mano con motivo**, porque no
  se puede medir. Sus otros dos criterios sí se miden: **visitas** (`tickets` por ruta; ⚠️ son
  visitas **con venta**, la que no vendió no deja ticket) y **volumen** (su meta sigue sin
  autorizarse).

---

### Auditoría de lo construido esta semana — tres defectos míos, medidos contra prod (2026-10-09)

Auditar el código propio de ayer encontró, otra vez, lo que su validación original había dejado
pasar. Los tres son de la misma familia: **una ausencia publicada como si fuera un hecho.**

**`[RD.58.3]` — el `$/km` estaba escrito DOS veces y sólo se arregló una.** `[RD.58]` endureció la
regla y `[RD.58.2]` la corrigió; las dos veces **en `serie()` solamente**, porque `rentabilidad()`
tenía su propia copia con los dos defectos que la otra ya no tenía. Medido sobre 2026: de **35
ruta-quincena** con kilometraje, **13 (37%)** daban en la tarjeta una cifra que la serie se negaba
a publicar — incluida la que motivó toda la corrección, la ruta 21 en la Q15 con **$450.94/km sobre
3 de 14 días medidos**. Mediana de lo retirado **$340.72/km** contra **$206.10** de lo que queda:
**1.65×**, el artefacto del denominador intacto. ⭐ El arreglo NO fue copiar la guarda buena a la
segunda consulta —escribirla dos veces es lo que produjo esto— sino sacarla a `KM_SQL`, una
constante que ambas interpolan; el veredicto pasa a llamarse `cobertura_km` con los mismos valores
en las dos. *Mientras una regla esté escrita dos veces, arreglarla una vez va a seguir pareciendo
que la arregló entera.*

**`[RD.59.3]` — la pantalla del objetivo dibujaba ceros y guardaba marcas invisibles.**
(1) `dias_con_venta: m?.dias ?? 0` **dibujaba un cero**: para un mes anterior a la fuente las 13
rutas publicaban *«0 días con venta»* **al lado** de criterios que decían *«sin fuente para ese
mes»* — el renglón se contradecía a sí mismo y el cero es el que se lee. (2) La guarda protegía el
borde **pasado** y no el **futuro**: `resultado(2027,5)` afirmaba *«la ruta no registró venta en el
mes»* sobre un mes que no ha ocurrido. (3) `marcar()` no validaba `route_code` —no hay FK, el
universo es una vista—, así que una ruta mal escrita se guardaba, devolvía 200 y **no aparecía
nunca**: el usuario veía «guardado» y la pantalla seguía diciendo «sin marcar». (4) `anio` no se
validaba aunque `mes` sí. Y se declara que la fuente es una **ventana rodante de 200 días**: un mes
que hoy se mide deja de medirse solo, así que un bono viejo se audita guardando el resultado, no
recalculándolo.

**`[RD.60.1]` — la placa se usaba como EXPRESIÓN REGULAR.** El vínculo sospechoso comparaba con
`!~`, o sea que tomaba la placa como patrón. Verificado en prod: una placa con un **paréntesis
suelto rompe la consulta entera** (`parentheses () not balanced`) y una con un **punto da falso
negativo** —el punto matchea cualquier carácter, así que un vínculo malo se ve bien—. Hoy ninguna
de las 56 placas trae metacaracteres, así que el riesgo es **latente, no vivo**; pero ya conviven
**ocho formatos** (`XXXXXX`, `XXX-XXX`, `XX-XXXX-X`…): el dato no está disciplinado. Además la
cobertura del padrón estaba **escrita a mano en el texto del hueco** («de 56 unidades, el año en
1») — cierta el día que se midió y vigente para siempre. Es la lección de `[CDRP.2.1]`; ahora se
cuenta cada vez, y aparece lo que el texto fijo omitía: **modelo 18/56**.

#### `[RD.61]` El hueco de $551,274.08 — RESUELTO, y de paso tres conclusiones mías refutadas

⛔⛔ **Ninguna de las dos rutas se retiró: las dos operan, en Kepler, con código nuevo.** La huella
que lo prueba es el chofer:

```
321  Joseph Agustin Guerrero  ->  2V001  "RVMM02 JOSEPH AGUSTIN GUERERRO"  alm 07  $297,595.45
322  (el chofer cambió)       ->  2V003  "RVMM01 GUILLERMO HERNANDEZ"      alm 07  $548,594.30
```

`RVMM` = **R**uta **V**ecinal **M**orelia **M**adero. La sucursal 32 tenía **dos** rutas en Wincaja
(321, 322) y tiene **dos** en Kepler (2V001, 2V003), desde el **2026-09-08**, que es exactamente su
fecha de corte. El chofer de la 321 es el mismo de los dos lados.

**El hueco son DOS tramos que no son la misma cosa:**

| Tramo | Veredicto |
|---|---|
| **02-jun → 07-sep** (321) · **01-jul → 07-sep** (322) | ⛔ **El hueco real.** La caja de la camioneta dejó de recogerse mientras la sucursal 32 seguía vendiendo normal (**$1.9M/mes** de mostrador hasta el 07-sep). |
| **desde el 08-sep** | ✅ No es hueco: es el corte a Kepler. Las rutas siguen con código nuevo. |

**El mecanismo**, que el catálogo de Wincaja ya tenía escrito: `caja 98 = ruta_bordo`, con la nota
*«la venta a bordo ocurre en el camión (fuera de esta base)»*. **La venta de ruta vive en una caja
Wincaja física montada en la camioneta.** Cada ruta corta el día del corte de su sucursal madre —
`21,23,26,27` con la 10 el 06-27, `501-505` con la 50 el 08-11— y el carril de empuje del CEDIS
(`route_push_lines`) las releva. **321 y 322 cortaron dos y tres meses ANTES que su madre y nunca
entraron al carril de empuje.** Su `status` en `wincaja.branches` sigue en `'route'`; `VEC-PH-H` sí
quedó `'archived'` cuando terminó. Nadie las tocó. Fase WR ya las traía declaradas como diferidas.

**Las tres cosas que afirmé y la medición refutó:**

1. ⛔ *«están retiradas»* — **falso**: venden $846,189.75 desde el 08-sep bajo los códigos nuevos.
2. ⛔ *«descartada la renumeración»* — **la descarté con la prueba equivocada.** Busqué una ruta que
   naciera el día que la 321 murió (2026-06-02). El renombre no ocurre en el hueco de datos: ocurre
   en **el corte de la sucursal**, el 2026-09-08, que es justo cuando nacen las 2V. *Buscar el
   relevo en la fecha de la ausencia y no en la del evento que lo causa es no buscarlo.*
3. ⛔ *«el libro es la única fuente que afirma que hubo venta»* — **falso**: el GPS también. La 322
   hizo **1,226 km en agosto, 992 en septiembre y 250 en octubre**, con sus dos aparatos (unidad y
   cámara) sobre la placa correcta `GC2558C`. Ese testigo estaba disponible desde el principio.

⛔⛔ **Y lo que costó el método:** con las tres conclusiones de arriba se apagó la ruta 321 en
`commission_route_config` de prod. **Se revirtió el mismo día** (13 de 13 activas, estado original)
al aparecer el renombre. La evidencia que había —la fuente murió, el libro dejó de pagar, el GPS
casi quieto— era **toda cierta y toda llevaba a la conclusión equivocada**. *Se escribió en
producción antes de terminar de medir; la autorización no reemplaza a la medición.*

**Lo que queda abierto, con número:** las dos rutas venden **$846,189.75 desde el 2026-09-08** y el
libro **no les paga comisión** (ningún renglón). El universo ya las clasifica `fuera_no_es_camion`,
igual que las demás vecinales, así que puede ser correcto — pero el mismo chofer que comisionaba
en junio no comisiona hoy. **Decisión de Edgar**, no derivable: ¿la comisión de RD sigue al chofer
o al tipo de ruta? ⚠️ La **505** es distinta: intermitente, no renombrada (10 de 19 quincenas,
última actividad hace 29 días); el umbral de 60 días la deja correctamente sin marcar.

---

## 3. Lo que NO se va a hacer, y por qué

- **Volver a poner el cron.** Una quincena cerrada es un valor congelado; el reloj que despertaba
  48 veces al día para un hecho que ocurre 24 veces al año ya se retiró con razón (`[RD.22]`).
- **Recalcular lo pagado.** Si la escala cambia con efecto retroactivo, la diferencia entra como
  ajuste en la siguiente. Reescribir la historia la desalinea de lo que de verdad se depositó.
- **Migrar el libro entero de un golpe.** Se migra la hoja que paga; las otras entran por dinero.
- **Afilar `cobertura_dias` desde el motor.** No distingue *"no salió"* de *"se perdió el día"*
  porque la fuente es el único testigo de las dos. Se arregla con el padrón, no con un umbral.

---

## 4. Decisiones que no son mías

| # | Qué | Quién |
|---|---|---|
| 1 | ⭐ **Resuelto en parte por `[RD.61]`**: 321 y 322 **no** se retiraron — son `2V001` y `2V003` en Kepler desde el 2026-09-08 y venden **$846,189.75**. Lo que queda es otra pregunta: el libro **no les paga comisión** y el universo las clasifica `fuera_no_es_camion`. ¿La comisión de RD sigue al **chofer** o al **tipo de ruta**? La 505 es intermitente, no renombrada | Edgar |
| 2 | ¿`VEC-PH-H` entra, se excluye, o se declara? | Edgar |
| 3 | Los tres Jefes de Zona: el libro y la escala sembrada coinciden en **uno de tres** | Edgar |
| 4 | Los 3 criterios del objetivo mensual (visitas, desarrollo de marca, volumen) | Edgar + investigación |
| 5 | N y X de la compuerta de promoción de `[RD.52]` | Edgar |
| 6 | ¿El motor llega a pagar, o se queda de auditor del libro? | Edgar |

---

## 5. Orden sugerido

```
[RD.50] destrabar ────────────────────────────────────── hoy, 1 sesión
   └─ [RD.51] espejo del libro ───────────────────────── la pantalla sirve el día 1
         └─ [RD.52] contraste ─────────────────────────── el motor se gana la confianza
   [RD.53] fuente ────────────── en paralelo: es de otra gente (padrón) y de otro carril (latido)
   [RD.54] el acto ───────────── después de [RD.51]: sin historia no hay nada que acelerar
   [RD.55] recibo ────────────── bloqueado por FASE_RH
   [RD.56] el resto del libro ── por dinero
```

⭐ **[RD.50] más [RD.51] son la entrega que cambia la percepción**: la pantalla pasa de cascarón a
mostrar el año completo con lo que de verdad se pagó, sin depender de que la fuente se repare ni
de que alguien espere 4 minutos frente a un botón.
