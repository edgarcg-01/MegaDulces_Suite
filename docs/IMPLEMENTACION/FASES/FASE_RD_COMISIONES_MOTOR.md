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
| **D1** | ¿La comisión de RD sigue al **chofer** o al **tipo de ruta**? ⭐ **321 → 2V001 está probado** (mismo chofer, `JOSEPH AGUSTIN GUERRERO PEREZ`, en los dos lados). ⛔ **322 → 2V003 NO**: el chofer del 322 es `Eduardo Miranda Romero` y el de 2V003 es `GUILLERMO HERNANDEZ ALMANZA` | El universo las excluye y el libro no les paga; puede ser correcto o puede ser un hueco. Y para el 322 falta todavía saber **qué pasó con esa ruta** | **$351,664.85 en Q21** |
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
