# Fase VP — Verdad y Procedencia

> **ADR-056** · arrancó 2026-09-05 · hereda [`FASE_OBS`](FASE_OBS_INGESTA_OBSERVABLE.md) (ADR-053)
> y ADR-052 (contratos del boundary).
>
> **Estado: VP.0 ✅ · VP.1 ✅ · VP.2 🔨 (2.1 hecho) · VP.3 ⬜ · VP.4 ⬜ · VP.5 ⬜**

---

## 1. Por qué

Edgar: *"a menudo me dicen que existen cambios en los números de la empresa"*, y la sensación de que
la plataforma **no maneja procedencia, ni log de cambios, ni una verdad absoluta**.

La auditoría (2026-09-05, medida contra el repo) encontró algo distinto de lo esperado. **No falta
arquitectura.** Cada primitivo necesario ya estaba construido, bien hecho, aplicado a exactamente un
dominio, y nunca generalizado:

| Primitivo | Dónde ya existía | Alcance real |
|---|---|---|
| Frescura declarada | `libs/commercial/src/lib/shared/freshness.ts` (OBS, 2026-09-02) | **4 de 171** endpoints analíticos |
| Cobertura medida | `commercial-profitability.service.ts` | **1** pantalla |
| Unidad que viaja con el número | 5 vistas canónicas + puerta `unitMargin()` | **9 de 264** servicios |
| Versión de la regla amarrada al hecho | `daily_captures.config_version_id → scoring_config_versions` | **1** dominio |
| Valor anterior | `route_rebalance_log.previous_state` | **3 de 13** tablas de historia |
| Cuadre contra árbitro | `test-newdb-fact-vs-kepler.js` | **1** superficie |
| Latido de importer | `database/importers/lib/cron-heartbeat.js` | **13 de 109** · **0** de datos maestros |
| Bloqueo duro al no cuadrar | `purchase-book.service.ts:962` | **1 en todo el repo** |

**La causa es de proceso.** El proyecto crece por fases; cada una entrega una rebanada vertical,
inventa el primitivo que necesita, lo documenta en su `.md` y cierra. Nada dice *"y ahora subilo a
`libs/`"*. El tracker rastrea **fases**, no **invariantes**.

### El número llegaba desnudo

| Medición | Valor |
|---|---|
| Interfaces de respuesta en servicios frontend | **874** |
| ...que mencionan `as_of` | **6** |
| Rutas declaradas en `apps/view` | **187** |
| ...que consumen `db-health` | **1** |
| Endpoints en los 5 controllers analíticos | **171** |
| ...que devolvían frescura | **~4** |
| Commits históricos que arreglan corrección numérica | **570** |

Muestra literal de esos 570: *"recupera **$8.07M/mes** que la copia tiraba"* · *"**$4.44M/mes**"* ·
*"sólo miraba una de las dos puertas — **$2.1M en riesgo**"*. **Todos los encontró un humano** abriendo
una pantalla y sorprendiéndose del número.

### Las tres mentiras que estaban vivas

1. **`FRESHNESS_UNKNOWN` salía con `stale: false`.** Los consumidores preguntan `@if (f.stale)` → cuando
   fallaba la medición **la etiquetera no mostraba nada**: afirmaba frescura por silencio, en la misma
   pantalla que el 27-ago imprimió seis días de precios viejos, uno **54% bajo costo**. El primitivo
   escrito para evitar exactamente eso lo reproducía, a tres días de nacer.
   Peor: su test decía *"FRESHNESS_UNKNOWN no afirma frescura"* y verificaba `data_as_of: null` —
   cierto **también con el bug**. Estuvo verde todo el tiempo que la mentira estuvo viva, porque
   miraba el campo vecino.
2. **21 de 24 píldoras de frescura** decían *"actualizado hace 2 min"* midiendo el reloj del navegador.
   La peor: `tienda-arqueo` con `label="Kepler"` sobre un `new Date()` local.
3. **`db-health` clasificaba con `cfg ? classify(...) : 'ok'`** → las 3 matvistas del refresh nocturno
   que arman el sell-out latían sin umbral y salían **verdes por siempre**; la única registrada tenía
   los umbrales del otro cron y gritaba `critical` todos los días.

### El sell-out: tres capas ciegas apiladas

Es el reporte más consultado del negocio e iba de la migración a la pantalla **sin tocar un solo
archivo de prueba**.

1. El dedup Kepler↔Wincaja es un predicado de **fechas escrito a mano** en varios archivos. La
   migración prometía en un comentario que *"un test de paridad lo verifica"* — **no existía**.
2. El refresh nocturno tenía `try/catch` **por matvista**: si fallaba la pierna Kepler, el rollup
   mensual se materializaba igual sobre una unión medio rancia. **Ordenar no es depender.**
3. El monitor reportaba verde incondicional para 3 de las 4 matvistas involucradas.

Los tres mecanismos que existían para detectar el problema estaban ciegos **en el mismo punto**.

### Lo que NO era el problema

- **No eran las capas.** MR.5 tenía capas limpias y publicaba 14.62% de margen contra 11.32% real.
  Las capas resuelven acoplamiento, no verdad.
- **No era falta de rigor en lo construido.** Lo que existe está probado y bien pensado
  (`v_feed_freshness` incluso rechaza a propósito duplicar umbrales). Lo que falta es **alcance**.
- **No era falta de detección.** En el incidente OBS los 7 latidos estuvieron verdes y correctos seis
  días: *un latido prueba que el caño se mueve, no que llegó todo.*

---

## 2. Decisiones (Edgar, 2026-09-05)

1. **Arrancar por parar la mentira activa**, no por el contrato de fondo.
2. **En meses cerrados manda el congelado**, y la diferencia se declara como hallazgo.
3. **La suite entra a CI** (no sólo arreglar el runner local).

---

## 3. Las seis reglas (ADR-056)

1. El número viaja con su procedencia, y **la forma la define un contrato**, no cada consumidor.
2. El veredicto es **ternario**: `fresh | stale | unknown`. Un booleano no puede decir "no sé".
3. **Lo que no se pudo medir se declara** — nunca se dibuja como cero ni como verde. Vale para el dato,
   para la cobertura y **para los tests**.
4. **Poblado no es fresco**, y **ordenar no es depender**.
5. **Un primitivo inventado en una fase no cierra la fase** hasta que vive en `libs/` o queda como
   deuda con nombre en el tracker.
6. **Un gate sin prueba negativa es una intención**: hay que romperlo a propósito una vez y ver el rojo.

---

## 4. Sprints

### VP.0 — Parar la mentira activa ✅ (2026-09-05)

- ✅ **VP.0.1** `Freshness.status: 'fresh'|'stale'|'unknown'`; `stale` queda **derivado**
  (`status !== 'fresh'`) para que un consumidor viejo avise en `unknown` sin tocarlo.
  `composeFreshness([])` deja de caer en `some([]) === false` = fresco. La etiquetera parte el aviso
  en dos ("viejo" tiene edad que mostrar; "no se pudo medir" no la tiene).
  Commit `4877bdb1` · archivos: `libs/commercial/src/lib/shared/freshness.ts`,
  `commercial-labels.service.ts`, `tienda-etiquetas.component.ts`.
- ✅ **VP.0.2** La píldora declara **qué mide**. `measures: 'data' | 'fetch'` **requerido** — con
  `strictTemplates` un call-site que no lo declare no compila. Clasificados uno por uno contra la
  fuente de cada timestamp: **3 `data`** (`f.dato_al`, `r.checked_at`, `max(imported_at)`) y **21
  `fetch`**. Las de carga dicen "cargado hace N" y pierden el punto verde (aro hueco: el verde afirma
  salud del dato y ésas no la midieron). Commit `7ecc20f6` · 25 archivos.
- ✅ **VP.0.3** Guard de **edad** en matvistas. Los tres guards del sell-out preguntaban
  `relispopulated`, que es `true` para siempre tras el primer populate. `SellOutReport.freshness`
  declara la edad vía `laneAt()` con tolerancia 26 h (el mismo `warnH` de `CRON_JOBS`). No bloquea:
  informa y nombra el eslabón. Commit `8644f1e9`.
- ✅ **VP.0.4** `db-health`: el default pasa de `'ok'` a `'unknown'`; las 4 matvistas del refresh
  nocturno quedan registradas con umbral de job diario (26 h / 50 h); `analytics_refresh_wincaja`
  deja de tener los umbrales del cron de 15 min. La nota de `unknown` dice *"SIN UMBRAL… registrarlo"*,
  no *"SIN CORRER"* — corrió y terminó bien; confundirlos manda a revisar la máquina de feeds sin
  motivo. Commit `4877bdb1`.
- ✅ **VP.0.5** El candado **genérico**: todo `job_key` que late en `analytics.cron_runs` tiene que
  tener umbral en `CRON_JOBS`. La lista enumerada a mano sólo protegía lo que alguien recordó escribir
  — y no nombraba las tres huérfanas. Falla en los dos sentidos: job vivo sin umbral → registrarlo;
  latido muerto → borrarlo (lección de OBS.8). Commit `4877bdb1`.
- ✅ **VP.0.6** `coverage.measured: boolean`. El camino sell-out por vendedor **hardcodeaba**
  `{ branches_with_data: [], branches_missing: [], note: '<texto fijo>' }` — dos arreglos vacíos se
  leen como "no falta ninguna sucursal", una afirmación que nadie hizo. Ese pivote agrupa por vendedor
  y `selloutVendorLeg` ni selecciona sucursal: el eje **no se puede medir ahí**. Commit `8644f1e9`.

### VP.1 — El candado del sell-out ✅ (2026-09-05)

- ✅ **VP.1.1** Se retira `KEPLER_SELLOUT_DEDUP`, que tenía **una sola referencia: su propia
  declaración**. Al mover el dedup adentro de `v_sellout_daily` quedó muerto, pero su docstring seguía
  diciendo *"centralizado acá para que vendedores/canales lo reusen"*. Una copia muerta que sigue
  **pareciendo** canónica es peor que no tenerla. Commit `0cf06cd4`.
- ✅ **VP.1.2** `database/tests/test-newdb-sellout-parity.js` — el candado que el docstring prometía.
  Cuatro preguntas: (a) los literales empatan entre las copias vivas; (b) **cero doble conteo** por
  sucursal-día (normaliza 10→01, 42→02, 50→06); (c) **cero hueco** a los dos lados de cada corte —
  *el traslape se ve, el hueco no*; (d) rollup mensual == vista diaria **al peso**.
  Con **tercer estado**: lo que no se puede medir reporta `NO MEDIDO`, no ✔.
  Medido en `platform_test`: **16 OK · 0 fallas · 2 NO MEDIDOS**; el rollup cuadra al centavo
  (Δ 0.00) en 2026-06/07/08. Commit `0cf06cd4`.
- ✅ **VP.1.3** El refresh valida **dependencias**: si falla `mv_kepler_sales_daily`, `mv_sellout_monthly`
  no se refresca. Mejor el rollup de ayer —viejo pero coherente, y declarado— que uno de hoy mezclando
  piernas. Además el `continue` mudo (MV borrada → ni error ni latido, sólo `debug`) pasa a tratarse
  como falla. Commit `282ea311`.

### VP.2 — El contrato de procedencia 🔨

- ✅ **VP.2.1** `libs/contracts/src/http/provenance.contract.ts` — `Freshness`, `FreshnessInput`,
  `FreshnessStatus`, `Coverage`. El tipo había nacido en `libs/commercial` el 2026-09-02 y **a los tres
  días ya estaba copiado a mano** en `apps/view/.../tienda/etiquetas.service.ts`. El dominio conserva
  la lógica; el contrato define la forma. Commit `8644f1e9`.
- ⬜ **VP.2.2** Aplicar el envelope por tráfico: `commercial-analytics` (62 endpoints) →
  `commercial-intelligence` (47) → `commercial-replenishment` (40) → el resto. Reusar
  `composeFreshness()`/`laneAt()`; el modelo de cobertura ya resuelto está en
  `commercial-profitability.service.ts`.
- ⬜ **VP.2.3** `scripts/check-provenance.js` — **cuarta compuerta**: endpoint analítico nuevo o
  modificado sin envelope = CI rojo. Ratchet como TS.0 (error en líneas nuevas, warn en el resto).
  ⚠️ El modelo a calcar es `database/tests/test-authz-route-coverage.js` bloque [2] — regex sobre
  el fuente **con PISO** (`size > 100`) — y **no** `scripts/check-authz-tree.js`, que esta línea
  citaba: ese script se borró en `[SN.5]` (2026-09-10) porque leía shims re-export de una línea,
  contaba 0 claves y pintaba verde. Un gate que se pone verde sobre el vacío es la primera cosa que
  esta compuerta tiene que impedir de sí misma.

### VP.3 — Historia de datos maestros ⬜

Hoy: **cero** historial para precio, costo, punto de reorden, precio de etiqueta y factor de caja.
De los ~11 importers que los escriben, **cero** tienen latido, **cero** setean `updated_by` (la columna
**miente**) y **cero** conservan el valor anterior. `import-computed-reorder.js` e
`import-network-reorder.js` pisan **9 columnas de política de golpe**: si un punto de reorden pasa de
40 a 12 y dispara una requisición equivocada, no hay forma de saber que era 40.

- ⬜ **VP.3.1** `analytics.master_data_history` por **trigger genérico**. El repo tiene cero triggers de
  auditoría pero ~20 instancias de `trg_auto_populate_tenant_id`: el patrón ya está desplegado a escala.
  Cumple `GOTCHAS.md` §32 — es un hecho nuevo (el cambio), no una copia.
- ⬜ **VP.3.2** Los importers de datos maestros suman `cron-heartbeat` y setean
  `updated_by = 'importer:<nombre>'`. Una columna que miente es peor que una ausente.
- ⬜ **VP.3.3** `cron_runs` gana historial (hoy la PK `(tenant_id, job_key)` guarda **sólo la última
  corrida**: no se puede contestar *"¿cuántas filas tocó el importer de precios el martes?"*).

### VP.4 — Cerrar el mes ⬜ *(congelado manda)*

- ⬜ **VP.4.1** `analytics.period_close (superficie, periodo, cifra, definicion_hash, watermarks, …)`.
  `definicion_hash` = hash del `pg_get_viewdef` vigente + del predicado de dedup. El patrón es
  `daily_captures.config_version_id → scoring_config_versions`, que ya amarra la regla vigente al hecho.
- ⬜ **VP.4.2** Un mes cerrado **se sirve del cierre**, no del recálculo.
- ⬜ **VP.4.3** Un cron compara recálculo contra cierre → si difiere, **abre hallazgo** nombrando qué
  fuente se movió (watermark distinto) o si cambió la definición (hash distinto). **Ese es el log de
  cambios que hoy no existe**: *"¿por qué cambió enero?"* pasa a tener respuesta.
- ⬜ **VP.4.4** Reusar bandeja, no crear la novena: hay **8** tablas de findings y un puerto
  (`finance-findings-sink.port.ts`) que usa sólo finance. Generalizarlo es parte del item.

### VP.5 — La compuerta ve números ⬜

- ⬜ **VP.5.1** Las **21 pruebas huérfanas** entran a `run-all-tests.js`. Primera:
  `test-newdb-cash-cuts-sync.js`, que valida un sync que **ya falló en prod** (20 cortes de la sucursal
  02 con $300k+ en el ODS y no en la tabla).
- ⬜ **VP.5.2** Las pruebas "skip-graceful" (`test-newdb-contpaqi-bank.js`, `-bank-link.js`,
  `test-newdb-pagos-conciliacion.js`) **fallan sin datos** en vez de pasar en verde. Hoy pasan justo en
  el entorno donde alguien las correría.
- ⬜ **VP.5.3** Job nuevo en `.github/workflows/ci.yml` con Postgres de servicio + seed: arranca con las
  **87 suites DB-direct** (no necesitan API arriba), las 41 HTTP en un segundo paso. Es el pendiente que
  el propio `ci.yml` declara **dos veces**.

---

## 5. Pendientes / riesgos

- ⚠️ **El traslape y el hueco del sell-out siguen SIN MEDIR** donde importan. `platform_test` tiene
  `mv_wincaja_sales_daily` vacía, así que los bloques 2-3 del candado reportan `NO MEDIDO`. **Falta
  correr `test-newdb-sellout-parity.js` contra prod** (es read-only).
- ⚠️ El commit `0cf06cd4` **se llevó trabajo en vuelo ajeno** (`monto_neto`) al stagear
  `commercial-analytics.service.ts` completo mientras Edgar lo editaba. El commit compila y su mensaje
  no lo menciona. Lección: revisar `git diff` del archivo **antes** de stagear cuando hay dos manos.
- ⚠️ **Quinta vez** que un acento grave dentro de un `template` literal tumba el build con NG5002
  (`GOTCHAS.md` §34).
- **Fuera de alcance, declarado**: retirar los 173 importers (es Fase CANON), partir los god services
  (`commercial-analytics.service.ts`, 4,778 líneas — pero no antes de tener el candado de VP.1 puesto),
  `warehouses.kepler_code` = 0 filas (el mapa de sucursales sigue en 7 copias),
  `kepler_vs_contpaqi_descuadre` sigue `enabled: false` por decisión documentada.

---

## 6. Verificación

| Sprint | Cómo se comprueba |
|---|---|
| VP.0 | Apagar el feed de etiquetas → la etiquetera **debe** avisar. Renombrar una MV → `db-health` marca `unknown`, no verde. `test-newdb-feed-observability.js` **80/0**. |
| VP.0.2 | **Prueba negativa hecha**: quitar `measures` de un call-site tumbó el build de prod (exit 255); restaurado, verde. |
| VP.1 | `test-newdb-sellout-parity.js` — mover a mano una fecha de corte debe **romperlo**. |
| VP.2 | `check-provenance.js` en rojo al agregar un endpoint analítico sin envelope. |
| VP.3 | Cambiar un precio por importer → fila en `master_data_history` con valor anterior y `source`. |
| VP.4 | Cerrar jul-2026, alterar una fuente, correr el comparador → hallazgo que nombra el watermark. |
| VP.5 | `node database/run-all-tests.js` verde local; CI rojo al romper una aserción de datos. |

---

## Observaciones de diseño UI — revisión del plan (2026-10-26)

> **Con qué se miró: el plan, no la pantalla** (nivel C). Nada visual se da por medido; lo que
> sólo se comprueba con la pantalla viva va como criterio a verificar. La ley es
> [`ESTANDAR_DE_INTERFACES.md`](../../ESTANDAR_DE_INTERFACES.md) (§ = sus secciones) y su
> implementación [`DESIGN.md`](../../../DESIGN.md). Severidad: 🔴 la pantalla afirmaría algo falso,
> escondería lo que importa o perdería trabajo — **bloquea pasar C3 a 🚀** · 🟠 se resuelve dentro
> de la fase · 🟡 mejora; si no entra, queda como deuda con nombre.
> Lo de VP.0 ya está en pantalla (las 24 píldoras de frescura, la etiquetera): ahí cada observación
> es un criterio a verificar, no un defecto medido. De VP.2.2 en adelante todavía no hay interfaz:
> esto es diseño previo, y por eso es barato corregirlo aquí.

**La pregunta que contesta (prueba de la frase, §4.0b):**

- **La procedencia en cada cifra:** VP no tiene una pantalla: es lo que cada número lleva consigo.
  Lo que contesta, en cada cifra, es *«¿Puedo usar este número tal como está?»* — una pregunta. El
  riesgo del plan es contestar además *«¿de dónde sale?»* en el mismo lugar: es otra pregunta
  (§4.0 A). Corte: la primera se contesta en la cifra, de un vistazo y sólo cuando la respuesta es
  «no del todo»; la segunda vive a un gesto (VP.UI.2).
- **Cierre de mes (VP.4):** *«¿Por qué cambió esta cifra desde que se cerró el mes?»* — una
  pregunta, y se hace mirando la cifra, no la bandeja.
- **Historial de datos maestros (VP.3):** *«¿Cuánto valía esto antes y quién lo cambió?»* — «quién»
  es atributo del mismo cambio: una pregunta.

**Jerarquía propuesta (§3.7 · DESIGN §Q.5):** primario = el número del negocio · secundario = su
excepción de procedencia, pegada al número (atrasado, parcial, sin medir, mes cerrado que hoy
recalcula distinto) · terciario = la procedencia completa (fuentes, edad por carril, cobertura,
definición), a un gesto.

| # | Sev | Observación (desde la silla de quien la usa) y costo | Ley | Criterio de aceptación |
|---|---|---|---|---|
| VP.UI.1 | 🔴 | **El contrato tiene compuerta en el servidor y ninguna en la pantalla.** VP.2.3 pone rojo un endpoint sin envelope; nada pone rojo una pantalla que recibe `status: 'unknown'` y pinta la cifra limpia — la mentira que VP nació a parar (21 de 24 píldoras medían el reloj del navegador). Es el defecto de `Q.1`, que mide que exista `MetricStrip`: presencia de un lado, nada del otro. | §1.3 · Cruce 6 (lo que viaja contra lo que se pinta) · ADR-056 regla 6 | Item C3 con compuerta de frontend, con trinquete como `check:pantalla`: todo tipo de respuesta que trae `freshness` o `coverage` tiene un consumidor que lo pinta con la pieza compartida. Prueba negativa: quitar el `app-freshness-pill` de un consumidor la pone en rojo. |
| VP.UI.2 | 🔴 | **El plan no dice cómo se pinta la procedencia, y aplicada a 171 endpoints satura.** Una píldora por cifra en una pantalla de 28 montos son 28 píldoras; con todo marcado, la que dice «sin medir» se pierde entre las que dicen «al día» (§4.0 B: ruido) y la jerarquía se aplana (§3.7). Un aviso que nadie distingue es un aviso escondido. | §4.0 B · §3.7 · §2.1 | Regla escrita en el plan y en `DESIGN.md`: (1) una sola píldora por pantalla, en el encabezado, compuesta con `composeFreshness()` (gana la peor); (2) en la cifra sólo aparece la **excepción** que cambia su lectura —«atrasado 9 h», «parcial: faltan 2 de 8 sucursales», «sin medir»—, con texto; (3) la procedencia completa en `app-side-peek` «De dónde sale este número»; (4) fresco y completo = nada en la cifra. |
| VP.UI.3 | 🔴 | **Un total parcial se lee como el de la red.** `coverage` trae `branches_missing`, pero el plan no dice qué le pasa a la cifra cuando falta una sucursal. Un sell-out —«el reporte más consultado del negocio»— que suma 6 de 8 sucursales se lee como completo; VP.0.6 ya corrigió el caso de los dos arreglos vacíos que afirmaban que no faltaba ninguna. | §1.6 · §1.3 · nombres, no códigos | Total con cobertura incompleta lleva junto a la cifra «Parcial: sin Zamora y Yurécuaro» (nombres con la pipe `\| sucursal`); con `measured: false`, «Sin saber si faltan sucursales». El PDF y el export llevan la misma leyenda (§1.5). |
| VP.UI.4 | 🟠 | **La unidad no está en el contrato.** `provenance.contract.ts` trae `Freshness` y `Coverage`; la unidad «que viaja con el número» está en **9 de 264** servicios y VP.2.2 no la incluye. Es la familia de error más cara del proyecto: ADR-051 (3.3 pp de margen falso por mezclar pieza y caja) y CANON.0.1 (costos 32×). | §1.6 | `unit` (pieza · caja · paquete; con o sin IVA; costo o precio) entra al envelope y a la compuerta de VP.2.3. La pantalla imprime la unidad en el encabezado de la columna o junto a la cifra siempre que no sea un conteo. |
| VP.UI.5 | 🟠 | **Las píldoras de «carga» se confunden con las de dato.** 21 de 24 son `fetch` y dicen «cargado hace N» con un aro hueco, en el mismo lugar y forma que una de dato: «cargado hace 2 min» se lee como «dato de hace 2 min». La diferencia aro/punto es justo la que desaparece en Alto Contraste. | §1.1 · §2.3 · §3.6 | La píldora `fetch` dice literal «Consultado a las 10:42 · edad del dato sin medir». Meta medible: de 21 a 0 conforme VP.2.2 trae `data_as_of`. Revisión en nivel A de las 24, con `forced-colors`. |
| VP.UI.6 | 🟠 | **Un mes cerrado puede mostrar dos cifras en dos lugares (VP.4).** La pantalla sirve el congelado y el comparador abre un hallazgo en otra bandeja: quien recalcula, exporta o mira otra pantalla ve otro número para el mismo mes, y junto a la cifra nada lo dice. | §1.5 · §3.2 | La cifra de un mes cerrado lleva «Cerrado el 05-ago». Si el recálculo difiere, un chip secundario junto a la cifra: «Recalculado hoy: $X (Δ $Y) — cambió [la fuente · la definición]», con enlace al hallazgo. PDF y export usan el congelado, con la misma nota. |
| VP.UI.7 | 🟠 | **El historial (VP.3) no tiene puerta, y `updated_by` miente hoy.** La pregunta de Edgar —«¿por qué cambió este número?»— se hace mirando el número (un punto de reorden que pasó de 40 a 12). Si una pantalla muestra hoy «Actualizado por», muestra un autor que no es. | §3.4 · §1.1 · §1.3 | En cada pantalla que muestra un dato maestro (precio, costo, punto de reorden, factor de caja), «Ver historial» abre `app-side-peek` con valor anterior, fecha y origen (`importer:<nombre>` o persona). Hasta VP.3.2, todo «Actualizado por» dice «Sin autor registrado». |
| VP.UI.8 | 🟠 | **«Atrasado» no dice qué carril ni a quién avisar.** `db-health` lo consume **1 de 187** rutas, así que la píldora sabe que algo está viejo y no puede decir qué. | §3.4 · DESIGN §X.6 | La píldora en `stale`/`unknown` nombra el eslabón («Ventas de Wincaja sin correr desde las 03:10») y lleva al estado de carriles con el filtro puesto. Conserva la distinción de `db-health` entre «sin umbral» y «sin correr». |
| VP.UI.9 | 🟡 | **Una bandeja, no la novena (VP.4.4), pero con motores que no se suman:** a `/finanzas/hallazgos` ya llegan diferencias de banco (`[CB.7]`), listas del SAT (`[CP.3]`) y detectores de Maat, y llegará el comparador de cierre. | §1.6 · §4.0 A | Cada hallazgo dice su motor, su regla y la fecha de su última medición. Los totales se parten por motor y clase; nunca un «N hallazgos · $X» que suma un retiro sin casar con un proveedor en lista. Lo que la fuente ya no detecta sale de pendientes con «Ya no se detecta (dd-mmm)». |
| VP.UI.10 | 🟡 | **Cada pantalla dice «viejo» a su manera:** la etiquetera «viejo» / «no se pudo medir», Bancos «desactualizado», el contrato `fresh \| stale \| unknown`. | §3.8 · §5.4 | Tres rótulos únicos, desde la pieza compartida: «Al día» · «Atrasado (hace N)» · «Sin medir», definidos en el diccionario con `app-context-help`. Ningún componente escribe el suyo. |

**Lo que esta revisión no cubre:** VP.5 (pruebas, sin interfaz), el cálculo de `composeFreshness()`
y los umbrales de `CRON_JOBS`, y cómo se ven hoy las 24 píldoras en la pantalla viva (nivel A).
