# Fase RD (continuación) — El motor de comisiones que sí paga

> **Estado**: 🔨 PLANEADO 2026-10-19 · sin código
> **Disparador**: *"lo que hoy existe no sirve, necesito objetivos claros, un motor que me dé los
> resultados, que funcione con la información de antes, hoy y futura"*.
> **Antecede**: [`FASE_RD_COMISIONES_REFUNDACION`](FASE_RD_COMISIONES_REFUNDACION.md) (RD.50–RD.66,
> todos en prod) y [`FASE_RD_CICLO_QUINCENAL`](FASE_RD_CICLO_QUINCENAL.md) (RD.6, RD.17–RD.23).
> ⛔ **No es una fase nueva.** Es la continuación de RD, que hoy **no tiene fila en el roadmap de
> `CLAUDE.md`** ni items `[RD.50..66]` en el tracker. Registrar las dos cosas es parte de `[RD.70]`.

---

## 0. Lo que se midió hoy, 2026-10-19

Todo contra `pg-prod` (`system_identifier 7688376744939610156`, base `railway`), sólo lectura.
Ninguna cifra sale de memoria ni del doc anterior.

| # | Qué se midió | Resultado |
|---|---|---|
| 1 | `commission_runs` | **20 filas. Las 20 `status='pagado'`, `origen='libro'`**, creadas el 2026-10-08. Total $937,781.87 |
| 2 | ⛔ Corridas del **motor** | **CERO.** No existe ni una corrida con `origen` distinto de `libro`, nunca |
| 3 | ⛔ `commission_engine_lines` | **0 filas** → la pestaña **«Libro vs motor»** está **vacía en producción**. El código de `[RD.52]` existe; nadie disparó `POST /contrast/run` |
| 4 | Periodos | **27, todos de 2026.** Del 1 al 20 con corrida; del **21 al 27, ninguna** |
| 5 | ⛔⛔ Q21 | **08-oct → 21-oct. Cierra en 2 días**, y es la **primera quincena sin espejo del Excel**. El 22 de octubre la pantalla no tiene con qué pagar |
| 6 | ⛔ El piso del tabulador en Q21 | Con **9–10 días cargados de los 12 transcurridos**, las **10 rutas con dato están TODAS por debajo** del primer escalón ($189,999.99). La más cerca, la 503, a **$2,641.12**. Si cerrara hoy, el motor pagaría **$0 a las 13 rutas** |
| 7 | ⛔⛔ El padrón contra la realidad | **321 y 322** siguen `comisiona=true` con `en_identidad=false` y **0 días de venta** (321: **139 días**; 322: **110**). Sus presuntos relevos **2V001 y 2V003** venden **$351,664.85 en Q21** y el universo los clasifica **`fuera_no_es_camion`** → el motor paga a quien no vende e ignora a quien vende |
| 7b | ⛔ **El relevo 322 → 2V003 NO está probado** — corrige a `[RD.61]` | El catálogo del ERP dice **`2V001 JOSEPH AGUSTIN GUERRERO PEREZ`**, que es **exactamente** el `chofer_nombre` del **321** en `commission_route_config`: ese relevo sí está probado por un hecho independiente. Pero **`2V003` es `GUILLERMO HERNANDEZ ALMANZA`** y el chofer del **322** es **`Eduardo Miranda Romero`**: **no coinciden**. `[RD.61]` lo dio por relevo anotando *«el chofer cambió»* — o sea que el único testigo que sostenía el otro par **no sostiene éste**. Queda como hipótesis, no como hecho |
| 8 | ⛔ La 504 | **18 días sin un solo dato** (último 2026-10-01). En Q21 tiene **0 días** → $0 |
| 9 | La 505 | **1 día, $851.83** en Q21. Sin chofer en `commission_route_config` (`chofer_nombre` NULL) |
| 10 | ⛔ El costo | **0 de los días de Q21 traen `costo_wincaja`** en ninguna ruta → el subtotal y el margen de la quincena en curso no tienen costo |
| 11 | ⛔ Una venta en el FUTURO | La ruta **22** tiene venta fechada **2026-12-06** (−48 días desde hoy). Entraría sola a una quincena de diciembre |
| 12 | ⛔ Perf de la fuente | `analytics.v_rd_commission_sales` **no soporta un escaneo del año: timeout a 120 s**. Una ventana de 14 días cuesta ~1.1 s |
| 13 | La matvista que la aceleraría | `mv_rd_route_daily_200d` cubre **2026-04-02 → 2026-12-06**. **No cubre Q1–Q6**: usarla a secas las borraría en silencio |
| 14 | ⛔ «La información de antes» | **No existe.** Cero periodos, cero corridas y cero escalas anteriores a 2026-01-01. El módulo nació sin historia previa |
| 15 | El tabulador | **1 sola versión** (`RD-2026`), **4 escalones**, `share_supervisor_pct = 20%`. `commission_beneficiary_config`: **0 filas** |
| 16 | ⛔ Verdad absoluta | **`docs/VERDAD_ABSOLUTA.md` no menciona la palabra «comisión» ni una vez.** El número que paga nómina no tiene árbitro declarado |
| 17 | ⛔ Registro | **124 commits `[RD.*]` en 60 días**, y los items **RD.50 a RD.66 no están en el tracker** (el último registrado es RD.9). **No hay fila RD en el roadmap** |
| 18 | Compuerta de diseño | `comercial-comisiones` **✔ pasa las 10 reglas**. `comercial-comisiones-objetivo` **✖ Q.1** (abre con grid, no con veredicto) |

### 0.1 Dos cosas que el doc anterior afirmaba y la medición de hoy corrige

- *«la pestaña Libro vs motor convierte la historia en la prueba del motor»* — **hoy no prueba
  nada**: la tabla que la alimenta tiene **0 filas** en prod. La pestaña se construyó y nunca se
  llenó.
- *«321 y 322 siguen `comisiona = true` con la fuente muerta»* — **sigue cierto 11 días después**,
  y ahora se sabe que no es una ruta muerta sino una **mal identificada**: vende $351 mil bajo otro
  código que el universo excluye.

---

## 1. La finalidad del submódulo — para qué existe

`/comercial/comisiones` no es un reporte. Es **el acto de decidir cuánto dinero sale de la empresa
hacia 13 choferes y 3 supervisores cada 14 días**. Contesta tres preguntas, en este orden:

| # | La pregunta | Quién la hace | Hoy |
|---|---|---|---|
| **1** | ¿Cuánto se le paga a cada quien esta quincena, y con qué número se calculó? | Nómina / Dirección | ⛔ sólo para lo que ya se pagó en el Excel. Para la quincena que cierra en 2 días, **nada** |
| **2** | ¿Ese número es confiable? ¿Con cuántos días, de qué fuente, con qué costo? | Quien aprueba | 🟡 los campos existen; el contraste que los valida está **vacío** |
| **3** | ¿Qué habría que hacer distinto la próxima? | El supervisor | ✅ «Lo que faltó» funciona — **sobre el espejo del libro, no sobre la quincena viva** |

⭐ **La diferencia entre un reporte y esto:** un reporte equivocado se corrige mañana. Acá, un
número equivocado **ya se depositó**, y un número ausente es **un chofer que no cobró**.

⭐⭐ **Por eso el objetivo del módulo NO es «calcular bien».** Ya calcula bien: `[RD.6]` cuadró
163/163 celdas al centavo y `[RD.23]` cuadró Q1 ruta por ruta contra el libro. **El objetivo es que
el número salga a tiempo, sobre el universo correcto, y que la pantalla diga de qué no está
seguro.** Lo que falla hoy es las tres cosas, no la aritmética.

---

## 2. Por qué «no sirve» — el diagnóstico en una línea

> **Se construyó un motor y un espejo, y el espejo se llenó. El motor nunca arrancó en producción.**

Las 20 quincenas que la pantalla muestra son **un Excel copiado**, no un cálculo. La primera
quincena que el Excel ya no cubre **cierra en dos días**. Y si se apretara el botón hoy, el motor
pagaría **$0 a las 13 rutas** —porque les faltan días—, **$0 a las dos rutas de Morelia que sí
venden** —porque están bajo otro código— y **le pagaría a dos códigos muertos**.

**Tres causas, una por capa:**

| Capa | La causa | Evidencia |
|---|---|---|
| **C0 dato** | El padrón de rutas no sigue a la realidad del ERP, y la fuente llega incompleta sin que nada lo frene | 321/322 fantasma · 2V001/2V003 excluidas · 504 con 18 días · 0 días con costo · una venta en diciembre |
| **C1 dominio** | El motor no tiene árbitro vivo ni compuerta de promoción: nadie sabe si está listo para pagar | `commission_engine_lines` = 0 · `VERDAD_ABSOLUTA.md` sin una línea de comisión |
| **C2/C3 API/UI** | El cálculo es un acto manual, bloqueante, que nadie tiene agendado hacer | sin corridas del motor en 11 días · cálculo de ~12 s/quincena dentro del request · la fuente no soporta el año |

---

## 3. Objetivos — medibles, con su cifra de hoy

| # | Objetivo | Hoy | Meta | Cómo se verifica |
|---|---|---|---|---|
| **O1** | **La quincena que cierra se paga sin que nadie se acuerde** | 0 corridas del motor | Q21 cerrada con corrida en `borrador` **antes de las 08:00 del 2026-10-22** | `select count(*) from commission_runs where period_id=Q21 and origen='motor'` = 1 |
| **O2** | **El universo que cobra = el universo que vende** | 2 rutas fantasma pagan, 2 rutas de $351k no | 0 rutas `comisiona=true` sin venta en 30 días · 0 rutas con venta > $100k/quincena sin veredicto declarado | `v_rd_commission_universe` sin `tipo_sin_declarar` y sin `comisiona` huérfanas |
| **O3** | **Ningún número se publica sin declarar con qué se calculó** | 0 menciones en `VERDAD_ABSOLUTA.md` | Sección propia con los 6 resolvedores (venta, subtotal, costo, escalón, bono, deducción) | `grep -c comisi docs/VERDAD_ABSOLUTA.md` > 0 + cada fila de la pantalla con su `*_veredicto` |
| **O4** | **El motor se gana el derecho a pagar, no se lo dan** | contraste vacío | **N quincenas consecutivas** dentro de **X%** contra el libro, medidas y publicadas (N y X los fija Dirección — **D5**) | `commission_engine_lines` con las 20 quincenas del espejo + compuerta que bloquea |
| **O5** | **La historia anterior a 2026 existe o se declara que no** | 0 periodos < 2026 | Veredicto escrito: se carga, o la pantalla dice **«sin historia antes de 2026-01-01»** en vez de abrir vacía | la pantalla en año 2025 no muestra una tabla en blanco |
| **O6** | **La pantalla abre en menos de 1 s** y el cálculo no vive en el request | tablero 2.2 ms ✔ · cálculo ~12 s bloqueante · la fuente hace timeout al año | tablero < 500 ms · cálculo en el `worker` con estado consultable | medición antes/después en el item |

---

## 4. El plan por capas — C0 → C1 → C2 → C3

> Regla del método: **una capa no sube hasta que la de abajo está verificada**. Acá eso no es
> burocracia: calcular sobre un padrón sucio produce un depósito equivocado.

### C0 — El dato (sin esto, todo lo demás paga mal)

#### `[RD.70]` Registrar lo que ya existe — 1 sesión, bloquea el resto
No es papeleo: **17 items en prod sin fila en el tracker** significa que nadie sabe qué está hecho,
y esta misma sesión tuvo que reconstruirlo leyendo 124 commits.
- Fila **RD** en el roadmap de `CLAUDE.md` (sin fila, la fase no existe — método §7).
- Items `[RD.50]`–`[RD.66]` en `01_TRACKER_PROGRESO.md` con su estado real medido (✅ prod).
- Entrada en `03_LOG_REVISIONES.md`.
- **Cierre**: `node .claude/skills/pm/tablero.js RD` deja de decir *«commits sin items»*.

#### `[RD.71]` ⛔⛔ El padrón sigue al ERP — ruta crítica, es dinero mal pagado
- **321 → 2V001** y **322 → 2V003**: el relevo ya está probado en `[RD.61]` (mismo chofer, misma
  plaza, `RVMM` = Ruta Vecinal Morelia Madero, corte 2026-09-08). Falta **escribirlo**:
  `commission_route_config` con vigencia (`valid_from`/`valid_to`), **sin borrar** la fila vieja —
  lo que cobró el 321 hasta el 2026-06-02 siguió siendo del 321.
- ⭐ **El veredicto `fuera_no_es_camion` de 2V001/2V003 es la pregunta de Dirección (D1)**, no un
  bug: ¿la comisión de RD sigue al **chofer** o al **tipo de ruta**? Hasta que se responda, **se
  declara** en la pestaña «Fuera» con su monto ($351,664.85 en Q21), no se decide en el código.
- **`VEC-PH-H`**: `tipo_sin_declarar` desde hace un año (D2).
- **505**: `chofer_nombre` NULL con la ruta activa — o se captura o se apaga.
- ⛔ **La guarda que va primero**: un `route_code` con `comisiona=true` y **cero venta en 30 días**
  tiene que **salir en la pantalla con su motivo**, no desaparecer. *La ausencia silenciosa es lo
  que dejó dos fantasmas un año.*
- **Prueba negativa**: inventar una ruta activa sin venta tiene que ponerla roja en el tablero.
- **Cierre**: 0 rutas `comisiona` sin identidad; cada ruta que vende > $100k/quincena tiene
  veredicto explícito.

#### `[RD.72]` El latido dice la verdad — `max(fecha)`, no filas
Ya está escrito como hallazgo en `[RD.53]` y **sigue sin construirse**: la 504 lleva **18 días**
sin dato y nada avisó.
- `ingest.*_heartbeat` publica **la fecha más nueva entregada**, no sólo que llegaron filas.
- La pantalla de comisiones muestra la **edad de la fuente por ruta** antes del total (ya hay
  `data_as_of` a nivel corrida; falta por ruta).
- **Alerta cuando una ruta activa pasa de 3 días sin dato**, por el carril de `db_health` que ya
  existe — no una bandeja nueva (ADR-056).
- **Cierre**: el 2026-10-01 la 504 habría disparado aviso el 2026-10-04, no el 2026-10-19.

#### `[RD.73]` Las dos trampas del calendario
- ⛔ **La venta del futuro**: ruta 22 con fecha **2026-12-06**. El motor tiene que **rechazar**
  `business_date > current_date` con motivo, no sumarla. Prueba negativa obligatoria.
- **El costo que falta**: 0 de los días de Q21 traen `costo_wincaja`. Hay que medir **por qué**
  (¿rezago del feed, o la fuente cambió al cortar a Kepler?) y **declararlo**, porque el subtotal
  sin costo no es el mismo número. ⛔ Si el subtotal se publica sin costo, se marca
  `costo_veredicto='sin_costo'` y **no se dibuja un margen de 0%**.
- **Cierre**: una fila sembrada con fecha futura no entra; una quincena sin costo lo dice en la
  cara.

#### `[RD.74]` La ventana — que la fuente aguante el año

⭐ **El híbrido YA EXISTE y funciona: `[RD.54]` lo construyó.** `v_rd_commission_sales` lee
`v_rd_route_daily_rapido`, que es `mv_rd_route_daily_200d UNION ALL` la vista viva para lo que
cae antes de la matvista, con el corte **fila por fila**. ⛔ Y la poda **sí** funciona: el
`EXPLAIN ANALYZE` muestra la rama viva con `rows=0` y su subplan `never executed` cuando la
matvista cubre la ventana. *Dos hipótesis mías —«la vista de costo es la cara» y «el planner no
puede podar la rama viva»— eran falsas y la medición las tiró.*

**Lo que de verdad cuesta, medido el 2026-10-19 sobre las 20 quincenas (tiempos estables,
variación 1.1–1.2× en tres vueltas, o sea estructural y no contención):**

| | |
|---|---|
| Contrastar el año entero | **136.8 s** de lectura (venta 130 s · costo 7 s) |
| Más el trabajo del motor | ≈ **4 min 09 s**, que es justo lo que el log del 7-oct midió |
| Q1 (enero) | **~9 s** · Q10 (mayo) ~4.2 s · Q20 (sep-oct) **~1.0 s** |
| La consulta de **costo** | ≤ 1.5 s, y **0 filas en Q1–Q12**: el COGS del embarque arranca en Q13 (18-jun) |

**Por qué, aislado en una sola comparación:**

```
Q1 (ene)      matvista DIRECTO        11 ms ·   0 filas   <- no la cubre
              solo la rama viva    8,361 ms · 143 filas   <- todo el costo esta aca
Q20 (sep-oct) matvista DIRECTO       278 ms · 201 filas
              solo la rama viva    1,178 ms ·   0 filas   <- peaje fijo aunque no aporte
```

1. ⛔ **La matvista arranca el 2026-04-02** (200 días), así que **Q1–Q7 las sirve la vista viva
   entera**: 6–17 s cada una. No es un defecto del híbrido, es su ventana.
2. ⚠️ **Y su cobertura es RALA en el medio**: 2,614 filas para ~22 rutas × ~200 días, cuando el
   lleno serían ~4,400. Por eso Q9–Q15 —que están dentro de la ventana— igual caen parcialmente
   a la rama viva y cuestan 4–8 s.
3. Aun cuando la matvista cubre todo, la rama viva cobra un **peaje fijo de ~1.2 s** devolviendo
   cero filas.

**Entonces el trabajo de `[RD.74]` es la VENTANA, no el híbrido**: ampliarla para que cubra el
año. ⛔ Eso es un `REFRESH MATERIALIZED VIEW` sobre una matvista que **ya consumen Ventas por
ruta y me-zona** — escritura pesada, va **fuera de horario** y con su medición de costo de
refresco, porque hoy se refresca cada 30 min.

- **Cierre**: el escaneo del año completa en < 5 s **y** Q1 devuelve el mismo total al centavo
  que devuelve hoy. Las dos aserciones, no una — acelerar perdiendo Q1 es el error de `[RD.58]`.

---

### C1 — El dominio (el motor se gana la confianza)

#### `[RD.75]` Llenar el contraste — el árbitro que se construyó y quedó vacío
- Correr `POST /contrast/run` sobre **las 20 quincenas del espejo** y dejar las filas en
  `commission_engine_lines` (hoy: 0).
- ⚠️ Cuesta ~12 s × 20 = **~4 min**, así que va **fuera de horario hábil** (regla dura de
  `CLAUDE.md`) y **después de `[RD.74]`**, para no volver a pagar los 12 s.
- **Cierre**: la pestaña «Libro vs motor» muestra **238 ruta-periodo** en prod, no una tabla vacía.
  Y el total del lado «libro» reproduce **$937,781.87** — si no, el contraste arrastra un error de
  lectura y no se publica.

#### `[RD.76]` ⭐⭐ La compuerta de promoción — el motor pasa de auditor a pagador
El mecanismo que `[RD.52]` describió y no se construyó.
- Estado explícito del motor: **`auditor`** → **`pagador`**, guardado y versionado, no inferido.
- La promoción exige **N quincenas consecutivas dentro de X%** sobre **la línea del chofer**
  (⛔ la del supervisor queda fuera hasta resolver **D3**: el libro le paga al supervisor
  FRANCISCO un bono duplicado que su propio recibo no cuadra).
- **Mientras sea `auditor`, la pantalla lo DECLARA** y la corrida del motor nace en `borrador` y
  **no se puede pasar a `pagado` sin aprobación humana explícita** (ADR-016, ya respetado).
- **Prueba negativa**: con N−1 quincenas buenas, promover tiene que fallar.
- **Cierre**: el estado es visible en la pantalla y el intento de saltarlo devuelve error.

#### `[RD.77]` ⭐⭐ La verdad absoluta de la comisión — `VERDAD_ABSOLUTA.md`
Hoy **cero menciones**. Seis números deciden un depósito y ninguno tiene árbitro declarado:

| Número | Resolvedor único | Testigo independiente | Trampa ya conocida |
|---|---|---|---|
| **venta** de la ruta | `v_rd_commission_sales.venta` | el corte de caja de la camioneta (Wincaja caja 98) | la caja viaja en el camión; al cortar a Kepler cambia de código (`[RD.61]`) |
| **subtotal** (la base) | `v_rd_commission_sales.subtotal` | `scales.base_field` | bruto vs neto: `[RD.2]` ya lo pagó una vez |
| **costo** | `cogs_ruta ?? cogs_erp ?? costo_wincaja` | el COGS del embarque (jun–oct) | ⛔ 0 días con costo en Q21 |
| **escalón** | `commission_scale_tiers` vigente a la fecha | el tabulador firmado | **es un acantilado**: $356.77 de menos = $0 en vez de $4,827.96 |
| **bono** | `commission_bonuses` con `periodo` y `activo` | el recibo | sin el filtro, un bono mensual se paga **dos veces** (`[RD.59]`) |
| **deducción supervisor** | por **persona**, agregada | el recibo de nómina | el recibo de FRANCISCO se contradice a sí mismo (**D3**) |

- Y lo que **no se puede medir se declara**: cobertura de días, fuente del día, veredicto del
  costo. ⛔ Nunca un cero dibujado (ADR-056).
- **Cierre**: sección en `VERDAD_ABSOLUTA.md` con su índice, y cada columna de dinero de la
  pantalla con su procedencia al lado.

---

### C2 — La API (el acto deja de depender de que alguien se acuerde)

#### `[RD.78]` ⭐ La automatización — y por qué NO es un cron
⛔ **El cron ya se retiró con razón** (`[RD.22]`): despertar 48 veces al día para un hecho que
ocurre 24 veces al año. Volver a ponerlo sería repetir el error.
**Lo correcto es por evento, con condición:**

```
cierra la quincena (date_to < hoy)
        └─ ¿la fuente está completa para TODAS las rutas activas?
              ├─ sí  → el worker calcula y deja la corrida en BORRADOR + avisa a quien aprueba
              └─ no  → NO calcula. Deja la quincena en «esperando fuente» con
                       la lista de rutas y días que faltan, y vuelve a intentar.
```

- ⭐⭐ **La condición es la parte importante.** Calcular con días faltantes no produce «un número
  aproximado»: produce **$0**, porque el tabulador es un acantilado. Medido hoy: con 9–10 de 14
  días, **las 10 rutas con dato quedan bajo el piso**. *Un motor que calcula sin fuente completa es
  peor que uno que no calcula, porque el cero se ve como un resultado.*
- El cálculo corre en el **`worker` que ya existe en prod**, no en el request de 4 minutos.
- **Nunca aprueba ni paga solo.** Deja `borrador`. ADR-016.
- **Prueba negativa**: con una ruta activa sin días, la automatización **no debe** dejar corrida.
- **Cierre**: Q22 (cierra 2026-11-04) aparece calculada sin que nadie apriete nada, o aparece
  «esperando fuente» nombrando la ruta.

#### `[RD.79]` El estado consultable y el histórico
- `GET /commercial/commissions/runs/:id/status` — progreso, no un POST que bloquea 4 min.
- ⛔ **Un endpoint que escribe no está probado hasta que una prueba lo ejerció contra base real con
  el payload de la pantalla** (regla dura; costó el arqueo de caja 8 días en cero). Esto aplica a
  `/compute`, `/recalculate-from`, `/contrast/run`, `/scales` y `/objective/marks` — **5 endpoints
  de escritura, ninguno con prueba de extremo a extremo hoy**.
- **Cierre**: suite en `database/run-all-tests.js` (`--solo-db` donde aplique) que **inserta de
  verdad**, con prueba negativa.

---

### C3 — La UI (lo que el usuario ve)

#### `[RD.80]` La pantalla deja de hablar sólo del pasado
`comercial-comisiones` **ya pasa las 10 reglas** de la compuerta — no hay que rediseñarla, hay que
darle qué mostrar:
- **El periodo en curso primero**, con su proyección (`[RD.65]` ya la calcula) y **la cuenta
  regresiva**: *«Q21 cierra en 2 días · faltan 4 días de fuente en 3 rutas»*.
- Cada ruta con **su edad de fuente** y su **veredicto de costo** al lado del monto.
- El estado del motor (`auditor` / `pagador`) **visible**, no implícito.
- **Año 2025**: o tiene datos, o dice *«sin historia antes de 2026-01-01»* — ⛔ nunca una tabla
  vacía que se lee como «no cobraron».
- ⚠️ Cargar la skill `diseno` y correr `npm run check:pantalla -- comisiones` **antes y después**:
  ninguna falla nueva.

#### `[RD.81]` Arreglar `comercial-comisiones-objetivo`
Falla **Q.1** medido hoy: abre con el grid crudo en vez del veredicto. Falta su `MetricStrip` y su
entrada del diccionario (jerga derivada: veredictos, umbrales, cobertura).

#### `[RD.82]` ⏸️ El recibo — bloqueado, y se declara
`FORMATO DE PAGO` necesita RFC, CURP, NSS y fecha de ingreso, que **no viven en `identity.users`**.
**Depende de [`FASE_RH`](FASE_RH_MIGRACION_MEGA_TALENTO.md)** (🔴 planeada, sin código).
⛔ Y hay un defecto en el origen que hay que arreglar antes de copiarlo: **321 y 322 comparten RFC,
CURP, NSS y fecha de ingreso** con choferes distintos. Es la hoja que alimenta nómina.

---

## 5. «Antes, hoy y futura» — qué significa cada una

| | Qué es | Veredicto medido | Qué se hace |
|---|---|---|---|
| **Antes** (< 2026) | 0 periodos, 0 corridas | **no existe** | **O5**: o se carga del libro viejo si existe (D4), o la pantalla lo **declara**. ⛔ No se re-deriva: la fuente de hoy no puede responder por 2025 |
| **Antes** (2026 Q1–Q20) | 20 quincenas espejadas del Excel, `pagado`, intocables | ✅ existe y cuadra | **no se toca nunca.** Sirve de **árbitro** del motor (`[RD.75]`) |
| **Hoy** (Q21, cierra en 2 días) | sin corrida, fuente incompleta, 2 rutas mal identificadas | ⛔ **no se puede pagar** | `[RD.71]`+`[RD.72]`+`[RD.73]` son precondición. Es la ruta crítica |
| **Futura** (Q22…Q27) | periodos creados, sin nada más | 🟡 listo el calendario | `[RD.78]`: se calculan solas al cerrar, **si** la fuente está completa |

---

## 6. Decisiones que no son mías

| # | Qué hay que decidir | Por qué no lo puedo derivar | Monto en juego |
|---|---|---|---|
| ~~**D1**~~ ✅ **Decidida y revertida:** 2026-10-20 «tipo de ruta» (escrita sólo en la nota del padrón de 321/322) → **2026-11-03 «sigue al CHOFER», con retroactivo al 2026-09-08** (Edgar, confirmada después de mostrarle la contradicción). Retroactivo medido: **$0** — 2V001 vendió $52,692 / $132,066 / $90,702 / $105,197 en Q18–Q21, todo bajo el primer escalón ($189,999.99) y bajo el bono más bajo ($215,999.99). Eduardo Miranda (322) no tiene ruta en Kepler; 2V003 es de otro chofer y no entra. Se aplica dando de alta 2V001 en «Quién cobra». Pregunta `rd.universo.sigue_a` de la [Fase DP](FASE_DP_DEFINICIONES_DE_NEGOCIO.md). | | |
| ~~D1 original~~ | ¿La comisión de RD sigue al **chofer** o al **tipo de ruta**? ⭐ **321 → 2V001 está probado** (mismo chofer, `JOSEPH AGUSTIN GUERRERO PEREZ`, en los dos lados). ⛔ **322 → 2V003 NO**: el chofer del 322 es `Eduardo Miranda Romero` y el de 2V003 es `GUILLERMO HERNANDEZ ALMANZA` | El universo las excluye y el libro no les paga; puede ser correcto o puede ser un hueco. Y para el 322 falta todavía saber **qué pasó con esa ruta** | **$351,664.85 en Q21** |
| **D2** | `VEC-PH-H`: ¿entra, se excluye o se declara? | Lleva un año en `tipo_sin_declarar` | $271,509.07 medido en Q1 |
| **D3** | La línea del **supervisor**: el recibo de FRANCISCO publica «Neto $2,400» contra «Total a Pagar $4,800» y su 20% ($7,862.48) no aparece | El archivo se contradice; escribirlo sería afirmar un hecho que no sostiene | ~$395,081.87/año |
| **D4** | ¿Existe libro de comisiones **anterior a 2026**? ¿Se carga? | No hay rastro en la base | la historia completa |
| **D5** | **N** y **X** de la compuerta de promoción (`[RD.76]`) | Es tolerancia de negocio, no técnica | que el motor pague o no |
| **D6** | ¿Quién puede **calcular**? Hoy 11 personas, 8 por `superadmin` | Calcular nómina ≠ administrar la plataforma | — |
| **D7** | El piso del tabulador es un **acantilado** en $189,999.99 ⛔ ¿es intencional? | 6 rutas no cobraron nada estando a menos de $10,000 del piso | $30,264 medidos en 2026 |

---

## 7. Orden y cupo

```
[RD.70] registrar ──────────────────────────────── 1 sesión, desbloquea saber qué hay
[RD.71] padrón ⛔ ruta crítica ─────────────────┐
[RD.72] latido ─────────────────────────────────┤ C0 — sin esto se paga mal
[RD.73] calendario (futuro + costo) ────────────┤
[RD.74] ventana/perf ───────────────────────────┘
      └─ [RD.75] llenar el contraste ──┐
      └─ [RD.77] verdad absoluta ──────┤ C1 — el motor se gana la confianza
            └─ [RD.76] compuerta ──────┘
                  └─ [RD.78] automatización por evento ──┐ C2
                  └─ [RD.79] estado + pruebas de escritura ┘
                        └─ [RD.80] la pantalla del presente ──┐ C3
                        └─ [RD.81] objetivo (Q.1) ────────────┘
                        └─ [RD.82] ⏸️ recibo — bloqueado por FASE_RH
```

⛔ **Advertencia de cupo.** El tablero mide hoy **15 fases 🔨 contra un tope de 4**. Esta fase **no
es nueva** —es RD, que ya está en curso y sin fila—, pero abrirla formalmente exige **cerrar o
pasar a ⏸️ otra**. Es decisión del PM.

⚠️ **Lo que NO alcanza para Q21.** El cierre es el 2026-10-21. `[RD.71]` + `[RD.73]` son lo mínimo
para que la corrida no sea falsa, y aun así **la fuente va a seguir incompleta** (504 con 18 días).
La salida honesta para Q21 es **calcular, dejar en borrador y declarar las rutas sin fuente** —
nunca publicar $0 como si fuera un resultado.

---

## 7.1 Revisión de las tres capas antes de entregar (2026-10-20)

> Pedido de Edgar: *«antes de dar un entregable en prod tenemos que revisar el backend, la
> estructura de datos y el frontend»*. Todo lo de abajo es medición contra prod, sólo lectura.

### C0 — Estructura de datos: **sólida**, con tres huecos

Lo que está bien, y conviene decirlo porque es lo que permite confiar en el resto:

| Comprobación | Resultado |
|---|---|
| RLS | **forzado en las 9 tablas**, 1 política cada una |
| Constraints | **36** entre FK y CHECK — los estados, los beneficiarios, los rangos de escalón y el `valid_to > valid_from` están en la base, no sólo en el código |
| Índices naturales | las 9 tablas, más `commission_runs_una_viva_por_periodo` (parcial, excluye `anulado`) |
| ⭐ Cabecera vs líneas | **las 20 corridas cuadran**: `total_a_pagar` = suma de `a_pagar`, 0 diferencias > medio centavo |
| Huérfanos | **0** en las cuatro relaciones |

**Los tres huecos:**

1. ⛔ **`commission_engine_lines` no tiene audit fields** — sin `created_at`, `updated_at`,
   `deleted_at` ni `created_by`, y **sin FK a `tenant_id`**. Es la única de las nueve. Viola la
   regla dura de `CLAUDE.md` («tablas nuevas: `tenant_id` + audit fields completos»). Tiene
   `computed_at`, que no es lo mismo: no dice **quién** la escribió.
2. ⛔⛔ **`commission_route_config` no tiene vigencia.** No hay `valid_from`/`valid_to`, así que
   **no se puede representar «la 321 fue de RD hasta el 2026-07-15»** — sólo se puede apagar, que
   pierde la fecha. La escala sí tiene vigencia (`[RD.66]`); el padrón de rutas no. Es lo que
   obligó a que `[RD.71.1]` escriba la fecha dentro de un texto libre en vez de en una columna.
   ⚠️ Y hasta esa migración **tampoco tenía `notes`**: una ruta apagada no tenía dónde decir por qué.
3. **`commission_beneficiary_config` está vacía** (0 filas) desde que existe. Declarada y nunca
   usada: el beneficiario sale de `commission_route_config`. O se usa o se retira — una tabla
   vacía con FK y constraints parece un mecanismo y no lo es.

### C1/C2 — Backend: **correcto en lo que decide el dinero**, con dos huecos

⭐ **Lo más importante del módulo está bien resuelto, y hay que decirlo porque yo mismo afirmé lo
contrario tres veces en esta fase:** el motor **distingue no tener fuente de vender poco**.

```ts
if (!v) { ... 'sin_dato_en_la_fuente' ... }   // subtotal NULL, no 0
if (!tier) { ... 'bajo_umbral' ... }          // y SIEMPRE con dias_esperados al lado
```

O sea que la **504**, con cero días, **no va a «cobrar $0»**: sale declarada como sin fuente, con
`subtotal = null`. Es exactamente ADR-056, aplicado donde más importa.

1. ⛔ **RETIRADO el 2026-10-20 — este hallazgo era mío y estaba mal.** Dije que `bajo_umbral` no
   distingue *«vendió poco»* de *«le faltan días»* y que el veredicto necesitaba un valor nuevo
   (`bajo_umbral_con_cobertura_corta`). **Al ir a construirlo, la distinción ya estaba hecha**:
   cada línea publica `dias_con_venta` y `dias_esperados` —la mediana de **sus hermanas de
   plaza**, no un número fijo—, la pantalla pinta la celda en alerta (`diasCortos`) y su tooltip
   dice exactamente lo que hay que decir:

   > *«{N} días contra los {M} que trabajaron sus hermanas de plaza. Puede ser que el camión no
   > salió, o que la fuente perdió el día: **el motor no los distingue, porque la fuente es el
   > único testigo de las dos cosas**.»*

   ⭐ Y agregar el valor al enum **habría roto algo**: `esFuera()` del componente clasifica con
   `DENTRO = new Set(['sin_dato_en_la_fuente','bajo_umbral'])`, así que un motivo nuevo habría
   mandado la ruta a la pestaña «No comisionan» — o sea, habría **escondido** la fila que yo
   quería hacer más visible. *Recorrer los consumidores antes de agregar un valor a un enum no
   es burocracia: acá era la diferencia entre mejorar y romper.*
2. ⛔ **Cinco endpoints que ESCRIBEN sin una sola prueba que los ejerza** contra base real:
   `/compute`, `/recalculate-from`, `/contrast/run`, `/scales`, `/objective/marks`. Es la regla
   dura que costó el arqueo de caja 8 días en cero.
3. ⛔ **El cálculo vive en el request** (~4 min, sin progreso ni reintento) — `[RD.54]`, abierto.

### C3 — Frontend: **pasa la compuerta**, con dos huecos

| Pantalla | Estado |
|---|---|
| `comercial-comisiones` | ✔ tipa · **✔ cumple las 10 reglas** · distingue `sin dato en la fuente` de `bajo umbral` con etiquetas propias |
| `comercial-comisiones-objetivo` | ✖ **Q.1 answer-first** — abre con el grid crudo · ⚠ falta su entrada del diccionario |

4. ⛔ **La pestaña «Padrón» de `[RD.80]` no tiene validación visual.** Pasa el auditor estático,
   pero nadie la ha visto renderizada. Es el hueco que `ONBOARDING §8.0b.14` manda declarar.
5. ⚠️ `GET /commissions/universe` tuvo **cero consumidores durante tres semanas** y nadie lo
   notó. No hay nada que detecte un endpoint publicado y no consumido.

### Lo que esta revisión concluye

⭐ **Las tres capas están mejor de lo que yo venía diciendo.** El módulo no está roto: está
**incompleto y sin ejercitar**. La estructura es sólida, el motor decide bien, y la pantalla
cumple. Lo que falta es que **nada de esto se ha ejercido de punta a punta ni una vez en
producción** — el motor jamás calculó una quincena, el contraste está vacío y cinco escrituras no
tienen prueba.

⛔ **Entonces el bloqueante del entregable no es un defecto: es la ausencia de ejercicio.** Y la
revisión estática no lo puede cerrar — hace falta correr `/preview` sobre una quincena real y
comparar contra el libro, que es la única prueba que vale.

**Qué bloquea qué, para decidir:**

| Entregable | ¿Bloqueado? |
|---|---|
| `[RD.71.1]` apagar 321/322 | **No** por la revisión — es `UPDATE` de 2 filas, idempotente, probado con su `down`. Bloqueado sólo por el push |
| Pagar Q21 con el motor | **Sí**: la 504 y la 501 sin fuente, y ninguna escritura ejercida |
| Pestaña «Padrón» | **Sí**: falta verla renderizada |

---

## 7.2 `[AUD-A6]` Todo lo que es comisión de RD, en una sola interfaz (2026-10-20)

> Pedido de Edgar: *«necesito que comisiones y objetivo RD, o todo lo que involucre las
> comisiones, viva en una misma interfaz»*.

### Dónde está el límite, medido por el PERMISO

| ruta | permiso | ¿entra? |
|---|---|---|
| `/comercial/comisiones` | `COMMERCIAL_COMMISSIONS_VER` | — |
| `/comercial/comisiones/objetivo` | **el mismo** | ✅ |
| `/finanzas/comisiones-logistica` | `FINANCE_EXPENSES_COMPROBAR` **ó** `LOGISTICS_SHIPMENTS_GESTIONAR` | ⛔ **no** |

⛔ **La de Logística queda fuera, y no es una preferencia:** tiene **otro permiso**, otra
población (choferes de **embarque**, no de Ruta Directa) y otro dominio (Fase J). Fundirla haría
una de dos cosas, las dos malas: **filtrar la nómina de RD** a quien sólo comprueba gastos, o
**dejar fuera** a quien hoy la ve. *El permiso es el que dice dónde termina una interfaz.*

### ⭐⭐ Se COMPONE, no se funde — y el número lo decidió

Copiar las 572 líneas del Objetivo dentro de la clase de 1,545 habría producido **10 colisiones
de nombre**, medidas:

```
tabsRD · perms · cargando · filaSel · anio · anios
puedeGestionar · constructor · cargar · etiquetaEstado
```

Entre ellas **`cargar()`** y **`etiquetaEstado()`**, que hacen cosas distintas en cada pantalla.
Es la trampa que la skill `diseno` nombra: *«reusar un nombre de propiedad en una clase larga no
da error: gana la última declaración»*.

Así que el Objetivo **sigue siendo su propio componente** y se embebe con una entrada nueva,
`embebido`, que sólo apaga su cromo (la tira de pestañas y el H1, que el anfitrión ya pinta).
**Control del cambio: los 11 métodos y las 2 tablas del Objetivo siguen existiendo**, uno por
uno, porque nada se copió.

### El conmutador va SOBRE el eje del tiempo, no entre las pestañas

⛔ El Objetivo **no** es una séptima pestaña de las de abajo. Aquellas son vistas de **UNA
quincena**; el objetivo es **mensual**. Colgarlo ahí haría que su contenido **cambiara al elegir
otra quincena** — afirmaría algo falso. Por eso el conmutador —*Nómina quincenal · Bono por
objetivo*— vive un nivel arriba.

### Lo que NO se rompe

- `/comercial/comisiones/objetivo` **sigue viva** y abre directamente la vista del bono: los
  enlaces y favoritos existentes llegan a donde llegaban. *Se retira la pestaña, no el camino.*
- La pestaña «Objetivo RD» sale de `RUTA_DIRECTA_TABS` — el sub-módulo pasa de 7 a 6.
- Mismo permiso en las dos puertas: **nadie necesita re-login**.

### Lo que esto corrige del argumento anterior

El comentario que justificaba la separación decía: *«configurar un bono y verificar una corrida
de nómina son dos trabajos distintos»*. Describía bien dos **tareas** — y sacaba de ahí la
conclusión equivocada: son **el mismo número mirado por sus dos lados**, porque el bono **entra a
la quincena**. Dos tareas no son dos pantallas.

---

## 8. Definición de hecho (los 7 del método)

Cada item cierra con: (1) métrica **antes/después** medida, (2) **prueba negativa** del gate,
(3) escritura ejercida contra base real si el item escribe, (4) procedencia declarada de cada
número publicado, (5) `01_TRACKER_PROGRESO.md` + `03_LOG_REVISIONES.md` actualizados, (6) ADR si
hubo decisión, (7) permiso **repartido** en prod si el item agrega superficie.

---

## 9. ⭐⭐ El giro del 2026-10-20 — el motor deja de auditar y pasa a producir

> **Edgar, 2026-10-20:** *«la información pasada ya se pagó y ya se registró. Ahora que tenemos
> acceso a esta información de primera mano, necesito que ahora todo ese proceso se haga aquí. El
> principal: una verdad absoluta de comisiones generada 100 % por el motor.»*

Esto **cambia el destino de la fase**, no sólo su orden. Hasta hoy el submódulo se construyó para
**verificar** una nómina que se hacía afuera. A partir de acá la nómina **se hace aquí**, y lo de
afuera queda como historia cerrada.

### 9.1 Lo que el giro resuelve, y lo que NO

**Resuelve `D4`.** La historia anterior está pagada y registrada: el motor **no la reabre, no la
corrige y no la vuelve a pagar**. Las 20 corridas con `origen = 'libro'` son un **archivo**.

⛔ **No resuelve `O4`, y confundirlos sería el error caro.** Que lo pasado no se corrija no
significa que no sirva: son **238 ruta-periodo con su depósito real**, y es el **único testigo
independiente** que el motor va a tener nunca (ADR-059: una cifra se arbitra contra un testigo del
mismo ERP y grano). El libro pasa de **destino** a **banco de calibración**. Se lee, se compara, y
no se escribe.

> **El criterio que separa las dos cosas:** si una fila del contraste discrepa, lo que se corrige
> es **el motor**, nunca el libro.

### 9.2 ⛔⛔ El hallazgo que bloquea «que todo el proceso se haga aquí»

Medido contra prod el 2026-10-20. El módulo de comisiones **sólo puede insertar en 5 tablas**:
`commission_scales`, `commission_scale_tiers`, `commission_runs`, `commission_run_lines` y
`commission_engine_lines`. De los insumos que deciden un depósito:

| Insumo | Quién lo decide | ¿Se captura en la app hoy? |
|---|---|---|
| venta · subtotal | derivado del ODS | ✅ automático |
| costo (COGS) | derivado, con veredicto | ✅ automático |
| tabulador y escalones | Dirección | ✅ `POST /commissions/scales` |
| **padrón de rutas** (quién comisiona, su nómina de banco, su chofer y su supervisor) | Comercial | ❌ **sólo por migración** |
| **bonos** | Dirección | ❌ hay `UPDATE`, **no hay `INSERT`** |
| **criterios del objetivo** | Dirección | ⚠️ `PATCH` edita; **no se pueden crear** |
| `commission_beneficiary_config` | — | ❌ **0 filas**: tabla que nadie usa |

⭐ **La prueba de que esto no es teórico es esta misma fase.** Mover las rutas **321 y 322** de
Ruta Directa a Vecinal —un hecho operativo, decidido por Comercial— costó **escribir una migración,
commitearla, empujarla y aplicarla a prod a mano**. Un cambio de padrón no puede necesitar un
desarrollador: mientras lo necesite, **el proceso no está aquí**, está en el repositorio.

### 9.3 El objetivo principal, enunciado para que se pueda medir

> **O0 — Una quincena de comisiones se produce entera dentro de la aplicación: sus insumos se
> capturan aquí, el motor la calcula, una persona la aprueba aquí y el chofer recibe su recibo
> desde aquí. Cero Excel, cero migración, cero SQL a mano.**

| | Hoy | Meta |
|---|---|---|
| corridas con `origen = 'motor'` | **0 de 20** | **todas** desde Q21 |
| insumos capturables en la app | **3 de 7** | **7 de 7** |
| cambios de padrón que exigen un despliegue | **el 100 %** | **0** |
| corridas con `approved_at` | **0 de 20** | **todas** las del motor |
| filas de contraste con el lado del motor | **0 de 238** | **238** |

### 9.4 Los items nuevos

#### C2 — Los insumos entran aquí (el corazón del pedido)

- **`[RD.84.0]` 🧪 ⛔⛔ El padrón se lee A LA FECHA DEL PERIODO — prerequisito del resto.**
  Medido el 2026-10-20: `v_rd_commission_universe` resuelve `comisiona = (en config AND activo)`
  **sin ninguna fecha**, y el motor la consumía sin pasarle el periodo. Con la baja de las rutas
  321/322 ya aplicada, recalcular las quincenas en que sí eran Ruta Directa daba:

  | | |
  |---|---:|
  | el libro les pagó, 5 quincenas con pago | **$19,096.84** |
  | el motor, al recalcularlas hoy | **$0.00** |

  ⭐⭐ **Una baja correcta reescribía la historia**, y por el único camino que el módulo tiene
  para escribir (`recalculate-from`). Va **antes** de `[RD.84]`: darle el botón a Comercial sin
  esto es repartir la trampa — cada baja hecha desde la pantalla borraría lo ya pagado en el
  siguiente recálculo.
  - Migración `20261020140919`: agrega **`activo_desde`** (la mitad que faltaba del par; sin
    ella un alta de hoy comisionaría la quincena 1). Aditiva, `NULL` = «desde siempre», **no
    cambia un solo resultado por sí sola**.
  - La regla vive en el motor (`universo(trx, tenantId, from, to)`), **no en la vista**: una
    vista no toma parámetros y los otros ocho consumidores preguntan por el universo **de hoy**,
    que es lo correcto para ellos.
  - Candado `test-newdb-rd-padron-vigencia.js`, con **prueba negativa**: la regla vieja tiene que
    equivocarse sobre estos mismos datos. Verificado contra prod — Q14 `vigente` ✓ / Q15 ✗.
  - ⚠️ Una baja **a mitad de quincena** paga la quincena entera: el tabulador no se prorratea sin
    inventar un escalón. `[RD.84]` tiene que avisarlo y proponer el cierre del periodo.

- **`[RD.84]` El padrón se administra en la pantalla.** Alta, baja y edición de una ruta, con
  `activo_hasta`, **motivo obligatorio** y bitácora de quién lo cambió. Las columnas ya existen
  (batch 968); falta el endpoint y la pantalla.
  ⛔ **Prueba negativa:** dar de baja una ruta **sin motivo** tiene que fallar, y una baja **no**
  puede alterar una corrida ya pagada.
- **`[RD.85]` Los bonos se capturan aquí.** Alta y baja con su vigencia por periodo.
  ⚠️ El filtro por `periodo` es lo que impidió que un bono mensual se pagara **dos veces**
  (`[RD.59]`): el alta tiene que exigirlo, no ofrecerlo.
- **`[RD.86]` El tabulador se edita con simulación.** Cambiar un escalón muestra, **antes de
  guardar**, a quién le cambia el depósito y en cuánto. El tabulador es un **acantilado**: hoy
  $356.77 de menos convierten $4,827.96 en **$0**, y eso no se puede firmar a ciegas.
- **`[RD.87]` La automatización por evento** — ya descrita en `[RD.78]`, más el estado consultable
  de `[RD.79]`. **Nunca aprueba ni paga sola**: deja `borrador`.

#### C3 — La pantalla cierra el ciclo

- **`[RD.83]` ✅ hecho el 2026-10-20** (`518a4b306`): aprobar, marcar pagada y anular se ejecutan
  en la pantalla. El ciclo de cuatro pasos dejó de ser un dibujo.
- **`[RD.88]` El recibo por chofer**, emitido desde aquí. Era `[RD.82]`, en espera. Mientras el
  recibo venga de afuera, el chofer cobra contra un papel que el motor no produjo — y **O0 no se
  cumple aunque el número sea correcto**.
- **`[RD.89]` La bandeja: qué falta hoy para que la quincena se pague.** Un solo lugar que
  responda, sin que nadie recorra pestañas: qué quincena cerró sin número, qué corrida espera
  aprobación, qué ruta va a comisionar sobre nada y qué ruta vende sin comisionar.

#### Auditoría del 2026-10-28 (nivel C + B, sin validación visual)

- **`[RD.91]` 🧪 La compuerta de deducción era verde por construcción** (`c77d7cf82`). Q21
  publicaba **neto $51,522.93 = tras nómina**, `total_deduccion` 0.00 y `deduccion_configurada`
  en «pasa», con sus 11 renglones de supervisor en `sin_configurar` y
  `commission_beneficiary_config` en **0 filas**. La compuerta contaba líneas que el motor llenaba
  **después** de llamarla. Ahora lee los beneficiarios y el neto va `NULL` si falta una deducción.
  Prueba negativa en `commission-deduccion.spec.ts`. ⛔ Queda: desplegar y **recalcular Q21**.
- **`[RD.92]` 🧪 La pantalla** (`ff6ee2963`): la proyección de `[RD.65]` por fin se dibuja (la
  rama «sin corrida» iba primero y la dejaba muerta) · Quién cobra, Bonos y Tabulador suben al
  conmutador de arriba (con Q22–Q27 no se podían abrir) · neto sin medir declarado en la tarjeta
  y en Aprobar · pago vencido visible · `cobertura_dias` con rótulo · tabulador de sólo lectura
  sin permiso.
- **`[RD.93]` 🧪 El contraste de Q21 en adelante: libro contra la corrida del MOTOR.** La pestaña
  «Libro vs motor» no sirve desde Q21 (la corrida viva ya es del motor y el libro llega después;
  cargarlo como corrida choca con `una_viva_por_periodo` y sería otra copia). Queda listo
  `node database/scripts/comparar-libro-motor-rd.js "<libro>.xlsx" --q 21 [--csv salida.csv]`:
  sólo lectura en prod, mismo veredicto que la vista, mismo lector del Excel que el espejo
  (extraído a `database/scripts/lib/libro-comisiones-rd.js`; salida del cargador idéntica antes y
  después). Controles: Q20 contra su espejo **10/10 cuadran** · libro Q19 contra motor Q20
  **0/11**. ⛔ El libro más nuevo en mano (8-oct) trae Q1–Q20: **falta el Excel con Q21**.
  - **Modo CSV (las entradas), corrido sobre Q21 el 2026-10-28** con la hoja CONCENTRADO que
    mandó Edgar: **9 de 11 rutas** ven la misma venta que el libro. A la fuente del motor **le
    faltan 2 días** (dos rutas, un día cada una, ~1.7 % de la venta de la quincena), y por uno de
    ellos una ruta queda **bajo el umbral** en el motor y sobre él en el libro: es el acantilado
    de D7 causado por un día perdido, no por la regla. Hipótesis a medir (no confirmada): los
    renglones tardíos que el carril `ctid` de `kdm2` no ve.
  - **El subtotal —la base de la comisión— difiere con la venta cuadrada en casi todos los
    días, también en Q19** (114 de 115): es una diferencia de DEFINICIÓN, en los dos sentidos, con
    montos que se repiten entre rutas. Por ruta y quincena mueve hasta ~2.8 %. Abierto: qué
    producto/impuesto arma cada lado.
  - Una fila del libro se contradice sola (subtotal menor que el costo); se declara antes de
    comparar, no se cuenta como diferencia del motor.
- **`[RD.94]` 🔨 Los dos días que no llegaron (investigación del 2026-10-28).** Recorrido capa
  por capa: la matview del motor = la vista viva = `analytics.route_push_lines` = `mart.ventas`
  del runner, al folio. **El hueco nace en la van, antes del runner.** Huellas: en una ruta el
  consecutivo de la serie `UD1001` se REINICIA a `0000001` al día siguiente del faltante; en la
  otra los folios de antes y después del faltante son consecutivos (ese día no hubo `UD1001`).
  Ningún día de ninguna ruta suma el importe que el libro registra. Mecanismo que lo vuelve
  silencioso: el agente sólo sube `U-D-10` de UNA serie (`ROUTE_SERIE`) y el merge del runner
  sólo reescribe las fechas del lote — un día con otra serie no sube y nada lo marca.
  **Hipótesis (sin confirmar): esos días se vendieron con otra serie.** Se confirma en la van con
  `route-push/DIAGNOSTICO-SERIES.ps1` (sólo lee). Si se confirma, la decisión es si el agente de
  una van de UNA ruta sube todas sus series U-D-10.
- **`[RD.95]` 🧪 El subtotal del push con la tasa de KEPLER** (`c3cfd60df`, migración
  `20261028170837_rd_route_daily_tasa_kepler`, **sin aplicar**). Medido: (1) hasta Q19 el libro
  **prorrateaba** el subtotal (subtotal/venta idéntico todos los días de cada ruta), así que antes
  de Q20 no arbitra la base; (2) el motor sacaba la tasa de `wincaja.articulos` y **tiraba en
  silencio** las líneas sin ficha (Q21: 188 líneas, 0.67 % de la venta); (3) con la tasa de Kepler
  (`kdii.c18/c19`, idéntica en 00/01/06) los días que cuadran con el libro pasan de **42→103 de
  117 (Q20)** y **53→102 de 121 (Q21)**, y la consulta baja de ~700 a ~200 ms. Dos
  implementaciones (JS y el SQL de la migración) coinciden; el `down` es idéntico a la definición
  viva (con control); la bandera `derivado_tasa_kepler_incompleto` se probó quitando la tasa a un
  SKU. Efecto en Q21: +$382.82 de comisión a los choferes que cobran. Residuo: 19 días de Q21 con
  el motor arriba del libro; el único patrón repetido es el SKU 17160 (Kepler exento, el libro al
  16 %), candidato sin control negativo. ⛔ Falta: aplicarla a prod (una por una), esperar el
  refresco de 30 min de la matview y recalcular Q21.
  **2026-10-29:** aplicada en prod (28-oct) y el código RD.91–97 desplegado. ⚠️ Su `CREATE OR
  REPLACE` sin `WITH` le quitó a la vista `security_invoker` (lo devuelve `[RD.98]`). Q21 **sigue
  sin recalcular**: borrador del 23-oct, con el neto viejo.
- **`[RD.96]` 🧪 El veredicto de costo del periodo ya no sale «sin costo» siempre** (`25398ceb2`).
  El pliegue del peor veredicto arrancaba en `sin_costo`, que ya es el peor: nunca cambiaba. En
  Q21 la fuente tiene 70 ruta-día con dos fuentes y 51 con una, cero sin costo. No mueve dinero.
- **`[RD.97]` 🧪 La quincena en curso es «acumulado», no «proyección»** (`529acb3c9`): sin la caja
  roja de «no se puede aprobar» por compuertas que en curso son normales, y con el nombre del chofer.
- **`[RD.98]` 🧪 El contraste libro↔motor: de a una quincena y sólo con libro** (migración
  `20261029121941_rd_contraste_solo_libro`, **sin aplicar**). Medido en prod el 2026-10-29:
  `commission_engine_lines` **nunca tuvo una fila**, y la pantalla mostraba 260 «sin medir», de
  los que **22 eran Q21, una corrida del MOTOR**: contrastarla habría medido el motor contra sí
  mismo. El botón pedía el año entero en una sola petición (~12 s × 20 quincenas), que detrás del
  túnel de Cloudflare (corte documentado a 100 s) no puede terminar, y las fallas por quincena
  que el servidor sí devolvía se tiraban sin mostrarse. Ahora: la vista y el servicio sólo toman
  corridas `origen = 'libro'` (el SELECT nuevo da 238 filas, sin Q21; el del `down` es idéntico a
  la vista viva, con control); `contrastarPeriodo` rechaza una quincena sin libro **antes** de
  correr el motor (prueba roja sin la guarda); la pantalla corre de a una con avance y lista las
  fallas. De paso devuelve `security_invoker` a `v_rd_route_daily`; hoy no cambia ninguna fila,
  porque sus bases no tienen RLS. ⛔ Sin validación visual. Falta: aplicar la migración y
  correr el contraste **desde prod**.

#### Transversal

- **`[RD.90]` La verdad absoluta de la comisión** en `VERDAD_ABSOLUTA.md` — hoy **cero menciones**.
  Los seis resolvedores de §`[RD.77]`, cada uno con su testigo y su trampa.
  ⛔ **Sin esto `O0` no se puede afirmar**: «generada 100 % por el motor» es una frase hasta que
  está escrito **qué arbitra cada uno de los seis números** que deciden el depósito.

### 9.4bis Decisiones firmadas (Edgar, 2026-10-29)

- **D5** — el motor pasa a pagador con **2 quincenas seguidas en que cada chofer coincide a ±$1**.
  ⭐ **El subtotal se arbitra contra KEPLER, no contra el libro** (ADR-059: testigo del mismo ERP
  y grano). Venta, %, bonos y nómina, contra el libro. Medido: en Q20 venta, %, bonos y nómina
  cuadran al centavo en 10 de 10; sólo difiere el subtotal. En los 3 pares visibles en el ODS
  (almacenes de camioneta `01-00N`, Q18–Q20) el motor queda a $4–$20 de la cabecera de Kepler
  (`kdm1.c16 − c14 − c15`) y el libro a −$50, +$884 y −$453: **el que se aleja es el libro**.
  ⚠️ Sólo 1 de 10 rutas tiene su documento en el ODS; para las demás, el testigo exige que el
  push mande los impuestos de la cabecera.
- **D6** — se separa en 3 permisos: calcular (Comercial), aprobar (Dirección), marcar pagado
  (Finanzas).
- **D7** — manda el **tabulador firmado**: debajo de $189,999.99 no se cobra. Lo que sí se
  arregla son los días perdidos en la fuente, que hunden rutas debajo del piso.
- **D3** — Edgar eligió «20 % de sus rutas + bonos − nómina de banco», con la nómina a buscar en
  egresos. ⚠️ **Lo que dicen los egresos (2026-10-29):** en Canindo el supervisor cobra
  **$2,400 fijos en Q19, Q20 y Q21** (`XA1001`, «Comisiones periodo N RD CAN»), sin importar la
  venta; el motor le calcularía ~$8,000 en Q21. Con la fórmula elegida, la «nómina» tendría que
  variar cada quincena para dar $2,400. **Vuelve a firma** con este dato. En Padre Hidalgo no se
  puede aislar: la transferencia junta RD, RV y TLMK.
- **Q21 ya se pagó el 22-oct desde el libro** (egresos `XA1001`). El borrador del motor del 23-oct
  ya no decide nada: sirve para contrastar. Cruce contra lo pagado: 502 coincide a 7 centavos; 501
  la pagó el libro (~$3,202.66) y el motor no (el día perdido del 15-oct la deja bajo el umbral);
  504, el motor $799 arriba, sin explicar todavía.

- ⛔ **D5 SUSPENDIDA para Q22 (Edgar, 2026-11-04): «mañana pagamos nosotros».** La suite paga
  Q22 (22-oct a 4-nov) el **5-nov** sin las 2 quincenas de control. Medido ese día (sólo
  lectura): las 11 rutas activas con todos sus días hasta el 3-nov; padrón con nómina de banco en
  las 11; bonos de quincena iguales a los del libro; la cadena de permisos existe (calcular:
  Dirección/Finanzas · aprobar: Dirección · pagar: Finanzas). ⚠️ Riesgos para ese pago: (1) la
  compuerta de frescura pasa con que UNA ruta tenga el último día — calcular antes de que
  lleguen las 11 paga un día incompleto; (2) **el supervisor**: `commission_beneficiary_config`
  tiene 0 filas, así que su línea sale «20 % sin deducción» (Q21: ~$8,000 contra los $2,400 fijos
  que paga Canindo) — D3 sigue sin cerrar; (3) la 505 no tiene chofer en el padrón (Q22 bajo el
  umbral: no cobra). Contraste de Q22 con el libro: NO MEDIDO hasta tener el libro.
  - **D3 para Q22 = opción A (Edgar, 2026-11-04): la suite paga SÓLO a los choferes; el
    supervisor se paga por fuera, como hasta hoy.** Las líneas `supervisor` de la corrida no se
    depositan. ⚠️ **Deuda con nombre `[RD.105]`**: `setStatus('pagado')` marca la corrida
    entera — no hay forma de decir «el supervisor se pagó fuera», así que el registro afirma
    más de lo que la suite pagó; hasta que exista, la corrida de Q22 se lee con esta nota.
  - **Quién calcula Q22: el automático de las 07:30 del 5-nov** (`[RD.87]`,
    `commission-auto-run.service.ts`): corre después del refresco de las 06:20 y sólo si la fuente
    de todas las rutas vigentes está viva; deja `borrador`, nunca aprueba. ⛔ **Nadie oprime
    «Calcular» el 4-nov**: el freno es `to > hoy`, así que ese día (`to = hoy`) deja escribir la
    corrida con la venta del día a medias, y una corrida no se reescribe sola. Si a las 07:30 no
    calcula (nombra rutas rezagadas), se calcula a mano con esas rutas a la vista.
- **D3 firmado (Edgar, 2026-10-29): la fórmula — 20 % + bonos − nómina de banco — y «que todo
  se pueda configurar».** → `[RD.100]`.

#### `[RD.100]` 🧪 La nómina del supervisor y su porcentaje, configurables desde la pantalla
- **Nómina de banco del supervisor** (`commission_beneficiary_config`, 0 filas y ningún camino
  para escribirla): `GET/POST /commercial/commissions/supervisors`, y en «Quién cobra» una tabla
  editable en la fila. Cada cambio es una **versión con fecha** (cierra la vigente, abre otra; con
  la misma fecha corrige en sitio); el nombre tiene que ser el supervisor exacto del padrón;
  una fecha detrás de la vigente se rechaza. Medido en prod (sólo lectura): lista los 3
  supervisores del padrón en 16 ms, los 3 «sin capturar».
- ⛔ **De paso, una trampa cerrada:** `deducciones()` filtraba por la versión del tabulador, así
  que **estrenar un tabulador nuevo dejaba a todos los supervisores en `sin_configurar`** sin
  tocar su nómina. Ahora filtra por persona y fecha (y por tenant, explícito).
- **La parte del supervisor (20 %)** ya vivía en el tabulador pero la pantalla no la dejaba
  cambiar: ahora se edita al estrenar una versión, y la confirmación la nombra si cambia. El
  servidor valida 0–100.
- Pruebas: `test-newdb-rd-commission-escrituras.js` cruza las columnas obligatorias contra el
  servicio nuevo (rojo al quitar `scale_id`) y ejerce la escritura versionada en transacción
  revertida con dos negativas (ventana vacía → 23514, sin escala → 23502) — **la parte que
  escribe sólo corre en CI** (`pruebas-db`): aquí el rol es de sólo lectura, NO MEDIDO.
  `apps/api/src/composition/commercial-commissions.metadata.spec.ts` lee `design:paramtypes`
  (rojo al quitar el provider del módulo). ⛔ Sin validación visual.
- ⚠️ Falta: **capturar la nómina de los dos supervisores** (Edgar / Comercial), y después
  recalcular.

#### `[RD.101]` 🧪 Tres llaves: calcula Comercial, aprueba Dirección, paga Finanzas (D6)
- **Lo medido antes (prod, sólo lectura, 2026-10-30):** `GESTIONAR` calculaba, aprobaba y pagaba;
  lo tienen `direccion`, `finanzas` y `superadmin`. De 21 corridas vivas **ninguna** tiene
  `approved_by` ni `paid_by` (20 del libro, 1 borrador): nadie pierde un acto que ya ejercía.
- **Dos llaves nuevas:** `COMMERCIAL_COMMISSIONS_APROBAR` (`/approve`) y
  `COMMERCIAL_COMMISSIONS_PAGAR` (`/pay`). `GESTIONAR` queda para calcular y configurar. Anular:
  un borrador lo anula quien calcula o aprueba; **una aprobada sólo quien aprueba** (deshace la
  aprobación).
- ⭐ **Nadie aprueba lo que calculó:** `setStatus` rechaza (403) que `approved_by` sea el
  `created_by` de la corrida — recalcular borra e inserta, así que es el último que calculó. La
  que deja el cron (`created_by` nulo) la aprueba quien tenga la llave. **Vale también para el
  superadmin**: el god-mode saltea la llave, no esta regla.
- **Reparto** (migración `20261030094901`, sólo `UPDATE`): APROBAR → `direccion`, `superadmin`;
  PAGAR → `finanzas`, `superadmin`; los demás roles vivos en `false` explícito. Ensayada en una
  sesión de prod sobre una **copia temporal** de `role_permissions` (control: la marca en la
  temporal se ve, la tabla real queda con 0 claves): `up` da exactamente esos roles, la segunda
  corrida cambia 0 filas y `down` deja 0 diferencias.
- ⚠️ **No existe un rol de gerencia «comercial»**: los candidatos son `supervisor_ventas` (cobran
  comisión: calcularían la suya) y `analisis_ventas`. `GESTIONAR` **no se movió**: sigue en
  dirección y finanzas, y el control lo pone la regla de arriba. Quién de Comercial calcula se
  concede desde /admin/roles cuando Edgar lo nombre.
- **Pantalla:** cada botón se ofrece a quien tiene su llave; a quien calculó no se le ofrece
  «Aprobar» y se le dice por qué. El servidor vuelve a decidir.
- Pruebas: `commission-tres-llaves.spec.ts` (7) — la regla, su control, el cron, anular, y la
  llave de cada endpoint leída de la metadata que consulta `RolesGuard`; rojo al apagar la regla.
  ⛔ Sin validación visual.

#### `[RD.102]` 🧪 La pantalla deja de afirmar lo que la corrida no es (auditoría 2026-11-03)
- **Lo medido (nivel A, pantalla viva + `GET /runs/:id` de Q21):** la columna «%» del chofer
  publicaba el % del **tabulador** (5) y el chofer cobra **4**: el otro 1 es del supervisor
  (`share_supervisor_pct` 20 %). En la ruta 504, «4.562 %» contra 3.65 % cobrado. Los $14,772.55
  de los supervisores vivían escritos en la fila del chofer.
- ⭐ **Q21 se guardó el 23-oct, antes de `[RD.96]` (28-oct):** 22 de 22 renglones dicen
  `sin_costo` con el costo presente (`cogs_ruta` en las 11, `cogs_erp` en 21–28), y la leyenda
  afirmaba «el markup no se puede medir y el bono del supervisor no paga» junto a un Markup lleno
  y **$1,800 de bonos de supervisor pagados**. Era lo que Dirección iba a leer al aprobar.
- **Lo que cambia:** `% chofer` (la parte del chofer, con el reparto en el `title`) y
  `% tabulador` en «Lo que faltó» · `costoRancio()`: si un renglón dice `sin_costo` con costo,
  **no se ofrece Aprobar**, el acto pasa a «Falta recalcularla» con **Recalcular Q21**
  (`recalculate-from`, GESTIONAR) y la leyenda declara la procedencia como sin medir ·
  el detalle de las compuertas sin códigos (`fuente_unica` → «una sola fuente de costo») ·
  la tarjeta de arriba ya no repite el neto con «− deducciones $0.00» · Cobertura sin verde ·
  la ruta sin chofer dice «sin chofer en «Quién cobra»» · **Anular** en rojo y apartado de la
  principal.
- ⚠️ **Deuda con nombre:** el freno es **sólo de la pantalla**; `setStatus` del servidor no
  revisa el veredicto rancio, así que una llamada directa a `/approve` todavía lo aprobaría.
- ⚠️ **Falta el acto:** recalcular Q21 (escribe; lo hace quien tenga GESTIONAR, y la aprueba
  **otra** persona por `[RD.101]`). No se ejecutó en esta sesión.
- Pruebas: `check:templates`, `check:estilos` y `check:pantalla -- comercial-comisiones` en verde;
  `ngc --noEmit` sin errores, con control (un método inexistente en la celda nueva → TS2339).
  Validación visual en claro a 2111 px sobre Q21. ⛔ **Sin validación**: oscuro, `forced-colors`,
  teléfono, y el estilo de **Anular** (con la corrida rancia no se ofrece; no hay otro borrador).

### 9.4b Pedidos de Lupita Sánchez (WhatsApp, 2026-11-03) — acotados, sin código

> Pedido literal: *«último viernes de mes se les paga bono de asistencia y puntualidad · los días
> de vacaciones, incapacidad o algún percance (mantenimiento de vehículo o de cómputo) se
> promedian con los 3 últimos periodos ya pagados · cobro de faltante de mercancía, ya existe un
> cliente referenciado (cobro faltante inventario) · faltan rutas vecinal y rutas TLMK»*.
> Medido en `pg-prod` (sólo lectura, `7688376744939610156`) el mismo día.
> ⛔ El cupo está excedido (6 🔨 contra 4) y RD **no tiene fila** en el roadmap de `CLAUDE.md`:
> esto se registra, no se abre.

| Item | Pedido | Lo medido hoy | Lo que falta para empezar |
|---|---|---|---|
| `[RD.103]` ⬜ | **Rutas vecinales y TLMK** en el motor | El universo ya las ve y las deja fuera (`fuera_no_es_camion` ×8, `tipo_sin_declarar` ×1, `config_inactiva` 321/322 en Q21). `VERDAD_ABSOLUTA` §32.5: vecinales **$2.2M de venta en 30 días sin configurar**; 321+322 **$846,189.75 desde el 2026-09-08** sin comisión. TLMK: **cero** en el motor. El motor ya admite una escala por ruta (`commission_route_config.scale_id`) | El **tabulador** de cada tipo (escalones, % y base) y quién cobra · la decisión abierta: ¿la comisión sigue al **chofer** o al **tipo de ruta**? |
| `[RD.104]` ⬜ | **Ausencia justificada** = promedio de los 3 últimos periodos pagados | Hay 20 quincenas pagadas para sacar el promedio, y el motor ya cuenta `dias_con_venta / dias_esperados` (Q21: la 505 vendió 3 de 11 días). **El motivo del día no existe en ningún lado**: `hr.attendance_incidents` = **0 filas** | Qué se promedia (comisión, venta o subtotal) y si cubre el día o la quincena entera · quién captura el motivo (vacaciones, incapacidad, taller, cómputo) y con qué comprobante. Sin motivo capturado, el motor no distingue «no salió» de «la fuente perdió el día» (la compuerta `cobertura_dias` ya lo dice así) |
| `[RD.105]` ⬜ | **Bono de asistencia y puntualidad**, último viernes de mes | `hr.attendance_logs` = **0**, `hr.attendance_days` = **0** en prod: la suite no tiene checadas (la fase RH está 🔨). El motor sólo paga bonos `periodo='quincena'`; los mensuales (`objetivo_mensual`) se calculan y no entran a la nómina (`[RD.59]`) | El monto y la regla (cuántas faltas o retardos lo pierden) · la fuente de asistencia: o RH aterriza las checadas, o se marca a mano con responsable y motivo, como «Desarrollo de marcas» |
| `[RD.106]` ⬜ | **Cobro de faltante de mercancía** | El cliente existe: `kdud` **`RD001` «COBRO FALTANTE INVENTARIO»** en las 9 sucursales. **0 documentos** a su nombre en `kdm1` (`c10`…`c15`, `c85`) y **0** en `kdue`; control: 50 clientes reales de la matriz dan 5,103 documentos por `c10` | Cómo se cobra hoy y a quién (¿venta a `RD001` en Kepler, en Wincaja, o se descuenta de la comisión?) · de dónde sale el faltante: el inventario de ruta **no existe como saldo en Kepler** |

| `[RD.107]` 🧪 | **La pantalla dejaba de decir que las vecinales «puede ser correcto» que no cobren** | Edgar, 2026-11-04: *«muchas de vecinal están activas, éstas también comisionan»*. Medido en prod: 8 vecinales venden **$2,664,904.61** de subtotal en 30 días (1V001–1V004, 2V001, 2V003, 2V005, 3V001; todas con fuente viva) y el libro de la suite (`commission_runs.origen = 'libro'`, 20 quincenas) **no trae ninguna**: sólo 21–28, 321, 322 y 501–505. O sea que su comisión se paga **fuera de la suite** y su tabulador no está en ningún lado que podamos leer. La pantalla ahora las separa («Comisiona, pero el cálculo no tiene su tabulador») y el diccionario dejó de decir «puede ser correcto» | Para `RD.103`: **dónde se calcula hoy** la comisión vecinal (hoja, quién) — de ahí sale el tabulador y quién cobra. Las preguntas `rd.vecinal.*` siguen sin dueño |

**Orden recomendado (dinero × esfuerzo):** `RD.103` primero (es la venta más grande sin
comisión) → `RD.104` → `RD.106` → `RD.105` (depende de que RH aterrice las checadas).

#### `[RD.103]` rehecho: un tabulador por familia, el sistema PROPONE y la persona decide (Edgar, 2026-11-04)

> *«Es por eso que debemos dejar un sistema de configuración para determinar estos parámetros.»*
> *«El sistema propone cuánto debe ser con base en lo que generan, gastos, históricos, etc., pero
> el último en considerar esto es el usuario.»* — Edgar, 2026-11-04

**Lo medido hoy (prod, sólo lectura, sid `7688376744939610156`):**

| Hecho | Cifra |
|---|---|
| Tabuladores que existen | **uno**: `RD-2026` (desde el 2026-01-01), 4 escalones de 3.75 % a 5 %; el primero empieza en $189,999.99 |
| Cómo elige el motor | `loadScale()` toma la escala vigente **por fecha**, una para todas las rutas. `commission_route_config.scale_id` existe y **el motor no lo lee** |
| ⚠️ Riesgo latente | «Quién cobra» acepta cualquier `route_code`: dar de alta una vecinal la pagaría con el tabulador RD **sin aviso** |
| Lo que RD cuesta (libro, 20 quincenas, 238 líneas del chofer) | comisión = **3.36 %** del subtotal (3.66 % con bonos) = **21.4 % del margen bruto** (margen 15.7 %); 190 de 238 líneas cobraron |
| Lo que venden las vecinales por quincena (Q14–Q21) | entre ~$52k y ~$327k; 1V001 ~$150–216k, el resto casi siempre bajo $140k. Con el tabulador RD casi ninguna cobraría |
| ⚠️ Unidad | en la fuente vecinal **subtotal = venta** en todas las filas: no se sabe si es con o sin IVA (**NO MEDIDO**, regla 10) |
| ⚠️ Costo | `costo_wincaja` vacío en todas las vecinales: **el margen vecinal no se puede calcular de esta fuente** |
| Gastos por ruta vecinal | **NO MEDIDO** (candidato: `expense_entries.dpto`) |
| Lo pagado a vecinales | **fuera de la suite**: el libro no trae ninguna (`[RD.107]`) |

**Los items, por capa:**

| # | Capa | Item | Árbitro |
|---|---|---|---|
| RD.103.0 🧪 | C0 | Medir para las vecinales: la unidad del monto (¿con IVA?), su **costo** desde Kepler (margen), sus **gastos** atribuibles y, si existe, la hoja con lo que se les paga hoy | La unidad contra el documento de Kepler; el costo contra lo pagado al proveedor; la hoja de pagos como testigo de la propuesta |
| RD.103.1 🧪 | C0 | `familia` (`ruta_directa` · `vecinal` · `tlmk`) en `commission_scales` y en `commission_route_config`, con valor por omisión `ruta_directa`: lo que hay no cambia y la API desplegada sigue escribiendo | Las 13 filas del padrón y `RD-2026` quedan en `ruta_directa` |
| RD.103.2 | C1 | El motor elige el tabulador **de la familia de cada ruta**; una ruta cuya familia no tiene tabulador vigente sale con motivo `sin_tabulador` (declarado, nunca $0 callado) | Antes/después: Q14–Q21 de Ruta Directa **idénticas al centavo** |
| RD.103.3 | C1 | **La propuesta**: escalones armados sobre la venta real de la familia en las últimas quincenas, para que la comisión cueste la parte del margen que la persona fije (por omisión, la de RD: 21.4 %), con lo que habría costado quincena por quincena. Lo que no se midió (gastos) sale declarado, no como cero | Reproducir con la propuesta el costo de RD sobre el libro |
| RD.103.4 | C2 | Tabuladores por familia; `GET` de la propuesta; «Quién cobra» exige la familia explícita para un código vecinal | Arranque (`design:paramtypes`) + servicio real contra base |
| RD.103.5 | C3 | Tabulador › Vecinal: la propuesta **aparte**, con su fuente y su costo simulado; «usarla como base» la copia a los escalones editables; **la persona estrena** la versión. Contestar `rd.vecinal.tabulador` = estrenar ese tabulador | `check:pantalla` + vista viva |

**`[RD.103.0]` medido (2026-11-04, sólo lectura, prod):**

| Insumo | Hallazgo | Qué se hizo |
|---|---|---|
| **Unidad del monto** | ⛔ El «subtotal» vecinal de `v_rd_route_daily` era el importe de `kdm2.c13` **con IVA e IEPS**: Q14–Q21, **+9.3 % a +12.7 %** sobre el neto que declara el documento de Kepler. La venta sí era correcta. Con 2V001 en «Quién cobra» se habría pagado comisión sobre impuestos | Migración `20261104103527`: la rama vecinal deriva el neto con la tasa de Kepler (la misma fórmula que el push, `[RD.95]`). Ejercido el SQL contra la vista viva, 200 días: **push y Wincaja idénticos en 1,935 filas**; vecinal cambia el subtotal en 782 de 784 días y la venta en 0; contra el neto de Kepler queda en **±0.9 %**. Candado `test-newdb-rd-vecinal-subtotal-neto.js`, **rojo verificado** contra prod antes de aplicar (8 de 8 rutas) |
| **SKUs sin tasa** | 1V001: $13,713 de $1,494,419 (0.92 %) en SKUs que no están en `kdii` de ninguna sucursal (17160, 17322, 96870, 65134, 17335); 17178 sólo en `07` | La vecinal toma la tasa de `00` y si falta, de otra sucursal; lo que no tiene tasa en ninguna queda **declarado** (`derivado_tasa_kepler_incompleto`), no adivinado. Deuda aparte: 59 líneas del push ($8,744 en 200 días) sin tasa en `00` |
| **Costo** | ⛔ `kdm2.c62` **mezcla unidades**: a veces es el costo de la línea (18022: 1,913.82 ÷ 50 = 38.28 = su `c77`) y a veces el unitario (17067: 45.26 por 41.77 kg, `c77` 43.53/kg). Con él el «margen» vecinal daba 45–67 %, imposible | Se descarta `c62`. **Cantidad × `kdii.c77`** (costo estándar) da margen de **10.8–14.7 %** en Q21 (RD: 15.7 %) y cubre ≥97.6 % del importe. ⚠️ `c77` es el costo de HOY, no el de la fecha de venta: se declara |
| **Gastos** | No hay gasto por ruta. Sí por **canal y plaza** en `analytics.expense_entries.dpto` (desde el 2026-08-06): «MORELIA MADERO VECINAL», «VECINAL PADRE HIDALGO», «ZAMORA CENTRO VECINAL», «LA PIEDAD ABASTOS VECINAL», y los TLMK. El grueso es **SUELDOS** y arrendamiento vehicular | La propuesta podrá usar el gasto del canal por plaza, prorrateado por venta, **declarado** como prorrateo |
| **Lo pagado a vecinales** | La comisión vecinal no aparece como cuenta propia: «VIATICOS Y COMISIONES» y «BONOS POR VENTAS» son montos chicos; lo probable es que vaya dentro de SUELDOS. **NO MEDIDO** como cifra separable | Sigue haciendo falta la hoja (o la persona) que la calcula: es el único testigo |

**`[RD.103.1]` en código:** migración `20261104103945` — `familia` (`ruta_directa` · `vecinal` · `tlmk`) en `commission_scales` y `commission_route_config`, `NOT NULL DEFAULT 'ruta_directa'` con CHECK; los tres caminos que insertan hoy (`createScaleVersion()`, alta del padrón, semilla `20260908120100`) no mandan la columna y el DEFAULT los cubre. Prueba `test-newdb-rd-familia-tabulador.js` (negativa: familia inventada → 23514; control: `vecinal` entra; un INSERT como el de la API desplegada queda en `ruta_directa`). **NO MEDIDO**: corre en el CI (contra prod sale «no medido» y no escribe). ⚠️ Las dos pruebas faltan de registrar en `run-all-tests.js` (el mismo bloqueo que DP).

**Decisiones (las tomo y las anuncio; Edgar firma):**
- **D-V1. La propuesta nunca se aplica sola.** Se guarda como propuesta (D2 de la fase DP) con su
  fuente («calculada por el sistema el <fecha> con Q14–Q21»); sólo una versión estrenada por una
  persona paga.
- **D-V2. La familia va en la fila de «Quién cobra», no se deduce del código.** 2V001 es código
  vecinal y, por «sigue al chofer», cobra con el tabulador de Ruta Directa.
- **D-V3. Objetivo por omisión de la propuesta = la parte del margen que hoy cuesta RD (21.4 %).**
  Es el único costo de comisión que la empresa ya paga y puede medirse; la persona lo mueve.

#### Cómo se preguntan: dentro del sistema, como parámetro configurable (Edgar, 2026-11-03)

> *«Hoy las preguntas hay que hacerlas en un sistema configurable.»* Las preguntas de arriba **no
> se mandan por WhatsApp**: cada una es un **parámetro** del motor. Mientras nadie lo defina, el
> parámetro **es** la pregunta abierta: se ve en la pantalla, tiene dueño, y el motor declara
> «sin definir» (ADR-056), nunca lo rellena con cero. Contestar es configurarlo, con fecha, autor
> y vigencia, igual que una versión del tabulador.

**Qué ya se configura y qué no** (código al 2026-11-03):

| Pregunta | Parámetro | ¿Configurable hoy? | Qué hay que cambiar |
|---|---|---|---|
| Tabulador de vecinal y de TLMK | una escala **por tipo de ruta** | ❌ `loadScale(trx, onDate)` elige **una** escala por fecha para todas las rutas; `commission_route_config.scale_id` existe y el motor no lo lee. La exclusión de vecinales vive fija en `analytics.v_rd_commission_universe` (`fuera_no_es_camion`) | La escala sale de la ruta (o de su tipo). El tipo que comisiona deja de ser una regla de la vista y pasa a ser ajuste. TLMK **no es una ruta**: su base de venta es otra (`U-D-40`, ADR-113) |
| ¿La comisión sigue al chofer o a la ruta? | regla del universo | ❌ | Se decide una vez (Edgar) y queda como ajuste con vigencia |
| Ausencia justificada | base (`comision`/`venta`/`subtotal`), ventana (N = 3 pagadas), alcance (día o quincena) y motivos válidos | ❌ | Captura del motivo por ruta × día, con comprobante; el motor promedia las N corridas **pagadas** |
| Bono de asistencia y puntualidad | monto, faltas y retardos que lo pierden, día de pago («último viernes del mes») | 🟡 los bonos se configuran (`/bonuses`: métrica, umbral, monto, beneficiario), pero **no hay métrica de asistencia** y lo mensual no entra a la nómina | Métrica `asistencia` cuando RH tenga checadas (hoy 0); mientras, `manual` con responsable y motivo |
| Cobro de faltante | de dónde sale el monto y si se descuenta de la comisión | ❌ las deducciones son nómina por ruta y deducción del supervisor | Una deducción configurable «faltante de inventario», con su fuente declarada |

⛔ **ADR-056: no se inventa un «parámetro pendiente» sólo para comisiones.** Ya hay otro igual
escrito a mano en Mi trabajo («Indicadores con meta: pendientes de definición (P-01 · P-11)»).
Si se construye, va a `libs/platform-core` (pregunta, dueño, tipo, valor con vigencia, «sin
definir» declarado) y su bandeja sale en «Mi trabajo › A tu nombre» del dueño. Es decisión de
Edgar: primitivo compartido o deuda con nombre.

⭐ **Decidido el 2026-11-03: primitivo compartido → [Fase DP](FASE_DP_DEFINICIONES_DE_NEGOCIO.md).**
Las preguntas de esta tabla ya viven ahí como 17 filas de `platform.business_definitions`
(`consumer = 'commercial.commissions'`), sin dueño todavía. `[RD.103]`–`[RD.106]` las LEEN; no
las vuelven a preguntar.

### 9.5 Lo que necesita firma antes de que el motor pague

| | Decisión | Por qué no la puedo tomar yo |
|---|---|---|
| **D5** | **N** quincenas y **X** % para promover el motor de auditor a pagador | es el apetito de riesgo sobre la nómina de 11 personas |
| **D7** | el acantilado de $189,999.99 | **9 filas, $26,932.74** que el libro pagó y el motor no. O el tabulador tiene un piso suave, o esas 9 no cobran |
| **D3** | la línea del supervisor | el recibo de FRANCISCO **se contradice a sí mismo**; el motor no puede elegir cuál de las dos versiones es la buena |
| ~~**D6**~~ | ~~¿quién calcula, quién aprueba y quién paga?~~ | **firmada y hecha** → `[RD.101]` |
| **nueva** | **¿Q21 la paga el motor o el libro?** | **cierra el 21 de octubre**. Es la primera quincena que puede nacer del motor. ⚠️ Al 2026-10-28 su pago (24-oct) ya venció y sigue en **borrador**; y su neto no se puede afirmar sin **D3** (`[RD.91]`) |
