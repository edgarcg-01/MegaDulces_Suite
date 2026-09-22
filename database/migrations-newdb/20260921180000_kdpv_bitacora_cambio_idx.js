/**
 * `[ETQ-CAMBIOS.6]` Índice de expresión para que "Cambios de precio" abra en menos de un segundo.
 *
 * ── Lo medido, en prod, antes de tocar nada ─────────────────────────────────────────────────
 * `kepler_ods.kdpv_bitacora_precios` = **8,272,799 filas · 2,420 MB**. La pantalla corría tres
 * consultas contra `analytics.v_label_price_changes` y las TRES hacían Parallel Seq Scan:
 *
 *   `max(fecha)` por sucursal (`fuente_al`) ... 57,482 bloques · **14,515 ms en frío**
 *   `count(*)` del día (`ocultos_centavo`) ... 57,313 bloques
 *   la lista del día ......................... 57,338 bloques
 *
 * O sea **~1.3 GB de buffers por carga de pantalla**. Los 261 ms que reportaban la segunda y la
 * tercera eran caché caliente que había dejado la primera: mismo conteo de bloques, distinto ms.
 * ⚠️ Por eso el veredicto se da en BLOQUES, no en ms — el ms mide qué tan tibia está la caché.
 *
 * ── Por qué ningún índice servía ────────────────────────────────────────────────────────────
 * La vista pone las columnas de filtro **en la lista de selección envueltas en funciones**:
 *
 *   `btrim(b.sucursal) AS sucursal`  ·  `b.c1::date AS fecha`
 *
 * Postgres inserta la vista en la consulta, así que un `WHERE sucursal='08' AND fecha='...'`
 * perfectamente inocente se convierte en `btrim(sucursal)='08' AND c1::date='...'`. Eso es una
 * expresión sobre columna: **ningún índice normal aplica**, y la PK `(sucursal, c1, c2, c3, c4)`
 * de 775 MB queda mirando.
 *
 * ⛔ El encabezado de `20260921170000_v_label_price_changes.js` afirma *"Medido: 4 bloques,
 * 0.1 ms"* y advierte que el consumidor no envuelva en `btrim()`. Las dos cosas son inexactas:
 * la medición se hizo cuando la tabla llegaba al 2026-09-01 y le faltaban las ramas 07 y 08, y
 * **el consumidor no puede evitar el `btrim()` porque lo pone la vista**. Se corrige acá en vez
 * de editar aquella migración, que ya está aplicada.
 *
 * ── El índice ───────────────────────────────────────────────────────────────────────────────
 * Mismas expresiones que la vista — si cambian allá, cambian acá o el índice deja de aplicar.
 * Es **PARCIAL con el mismo predicado de la vista**: de las 8.27M filas sólo **548,106 (6.6%)**
 * son cambios que mueven el precio impreso. Indexar el 6.6% cuesta una fracción de la PK.
 *
 * Sirve a las tres consultas con la misma estructura:
 *   · `max(fecha) WHERE sucursal=?`  → Limit + Index Scan: la primera entrada de esa plaza.
 *   · `sucursal=? AND fecha=?`       → rango de unas centenas de filas, no 8.27M.
 *
 * `(c1::date)` va **DESC** porque el uso real es "el día más reciente" y "ayer": el orden del
 * índice se elige por cómo se lee, no por costumbre.
 *
 * CONCURRENTLY + `transaction:false` (patrón de AX.0b, `20260822140100`): el carril del ODS le
 * escribe a esta tabla cada 5 min y un `CREATE INDEX` normal toma ACCESS EXCLUSIVE. Knex corre
 * cada migración en transacción por default y CONCURRENTLY no lo permite.
 *
 * ⚠️ Un índice NO es una copia (regla principal del proyecto): no duplica el dato, no introduce
 * rezago, no hay que re-correrlo. Lo único que se paga es un poco de UPSERT en el replicador.
 */

exports.config = { transaction: false };

const NOMBRE = 'ix_kdpv_bitacora_cambio_plaza_dia';
const TABLA = 'kepler_ods.kdpv_bitacora_precios';
// Copiadas VERBATIM de `analytics.v_label_price_changes`. El predicado parcial tiene que ser
// textualmente el de la vista o el probador de implicación de Postgres no lo reconoce y el índice
// queda inerte — inerte y en verde, que es la peor forma de no servir.
const EXPR = '(btrim(sucursal), ((c1)::date) DESC)';
const WHERE = 'round(c6, 2) IS DISTINCT FROM round(c7, 2)';

exports.up = async function up(knex) {
  await knex.raw(
    `CREATE INDEX CONCURRENTLY IF NOT EXISTS ${NOMBRE} ON ${TABLA} ${EXPR} WHERE ${WHERE}`);
  await knex.raw(`COMMENT ON INDEX kepler_ods.${NOMBRE} IS
    'ETQ-CAMBIOS.6 — sirve a analytics.v_label_price_changes. Parcial con el MISMO predicado de la vista (6.6% de las filas). Antes: 3 Parallel Seq Scan de ~57,400 bloques cada uno por carga de pantalla (14.5 s en frio). Las expresiones son las de la vista: si cambian alla, cambian aca o el indice deja de aplicar.'`);
};

exports.down = async function down(knex) {
  await knex.raw(`DROP INDEX CONCURRENTLY IF EXISTS kepler_ods.${NOMBRE}`);
};
