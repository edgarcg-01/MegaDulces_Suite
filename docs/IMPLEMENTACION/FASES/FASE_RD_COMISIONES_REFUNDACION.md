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
| 1 | El padrón: ¿321/322/505 siguen comisionando o se marcan inactivas? | Edgar |
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
