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
- `v_rd_commission_sales` hace **timeout a 120 s** sobre el año; `mv_rd_route_daily_200d` cubre
  desde **2026-04-02**, o sea que **no cubre Q1–Q6**.
- ⛔ **Cambiar a la matvista a secas borra Q1–Q6 en silencio** — es exactamente el error que
  `[RD.58]` ya pagó con el `$/km`. Va **híbrido declarado** (matvista dentro de su ventana, vista
  viva fuera) **o** la ventana se amplía a propósito, con su medición de costo de refresco.
- **Cierre**: el escaneo del año completa en < 5 s **y** Q1 devuelve el mismo total al centavo que
  devuelve hoy. Las dos aserciones, no una.

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

## 8. Definición de hecho (los 7 del método)

Cada item cierra con: (1) métrica **antes/después** medida, (2) **prueba negativa** del gate,
(3) escritura ejercida contra base real si el item escribe, (4) procedencia declarada de cada
número publicado, (5) `01_TRACKER_PROGRESO.md` + `03_LOG_REVISIONES.md` actualizados, (6) ADR si
hubo decisión, (7) permiso **repartido** en prod si el item agrega superficie.
