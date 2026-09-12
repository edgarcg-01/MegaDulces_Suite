/**
 * `[NORM.3]` `analytics.v_sellout_daily` pasa a leer la vista consolidada de etiquetas.
 *
 * Es la segunda de las dos VISTAS PLANAS que dependen de `commercial.product_label_prices` (la
 * otra, `v_product_box_factor`, se repuntó en `20260911240100`). Ambas traen el factor de caja con
 * `max(box_size) GROUP BY product_id`: hoy eso es *el valor* porque hay una fila por producto;
 * cuando la tabla gane grano por sucursal pasaría a ser *el máximo entre ocho tiendas*.
 *
 * ── Por qué acá se reescribe la definición VIVA en vez de copiarla a mano ────────────────────
 * La definición tiene ~5 KB y fue tocada por siete migraciones (sell-out neto, canal vecinal,
 * dedup Madero 07, van push…). Transcribirla acá sería crear una octava copia que se separa de la
 * real en la primera corrección. En vez de eso se **lee la definición viva, se le cambia el
 * nombre de la relación y se vuelve a crear**, con aserciones a los dos lados.
 *
 * ── Lo que esta migración NO alcanza, y hay que decirlo con número ───────────────────────────
 * ⛔ `analytics.mv_kepler_sales_daily` y `analytics.mv_wincaja_sales_daily` son MATERIALIZADAS:
 * no existe `CREATE OR REPLACE MATERIALIZED VIEW`, y un `DROP ... CASCADE` se llevaría también a
 * `mv_sales_blended`, `v_sellout_daily` y `mv_sellout_monthly` — cinco objetos y 4.7 M de filas a
 * reconstruir. Medido el 2026-09-11 cuánto compra ese riesgo: el `max(box_size)` entre plazas
 * difiere del consolidado en **6 SKUs de 9,366 (0.06 %)** — 17116, 17210, 83652, 89045, 92026,
 * 99870 — con **$868,071 de venta en 90 días sobre $156.8 M (0.55 %)**.
 *
 * Reconstruir la cadena entera del sell-out por seis SKUs no es proporcionado. Queda DECLARADO en
 * el tracker con esos nombres y ese monto, para repuntarse en la próxima reconstrucción de esas
 * matvistas — no disfrazado de "ya está". La compuerta de `20260911240300` las nombra una por una
 * y sigue abortando ante cualquier dependiente NUEVO.
 *
 * @param { import("knex").Knex } knex
 */

const OBJ = 'analytics.v_sellout_daily';
const TABLA = 'commercial.product_label_prices';
const VISTA = 'commercial.v_product_label_prices';

/**
 * Reescribe la definición viva cambiando la relación, con aserciones a ambos lados.
 *
 * ⚠️ El token de la tabla (`product_label_prices`) es PREFIJO del de la vista
 * (`v_product_label_prices`): un `replace` ingenuo hacia adelante produciría `v_v_...` y hacia
 * atrás no encontraría nada. Por eso cada dirección trae su propio patrón anclado, en vez de
 * invertir el mismo — es el tipo de "simetría aparente" que rompe el `down` y sólo se descubre
 * cuando hace falta revertir.
 */
async function repuntar(knex, haciaLaVista) {
  // ⚠️ `?`, no `$1`: knex.raw NO entiende los placeholders nativos de Postgres — los cuenta como
  // cero bindings y tira "Expected 1 bindings, saw 0". Es el mismo bug que costó la corrida CV.7.
  const { rows } = await knex.raw(`SELECT pg_get_viewdef(?::regclass, true) AS def`, [OBJ]);
  const def = rows[0].def;

  // `pg_get_viewdef` califica cada referencia a columna con el nombre de la relación
  // (`product_label_prices.box_size`), así que el reemplazo es del TOKEN, no sólo del `FROM`: si
  // se cambia la tabla y se dejan los calificadores, la vista no compila.
  const buscar = haciaLaVista ? /(?<!v_)\bproduct_label_prices\b/g : /\bv_product_label_prices\b/g;
  const poner = haciaLaVista ? 'v_product_label_prices' : 'product_label_prices';

  const antes = (def.match(buscar) || []).length;
  if (!antes) throw new Error(`[NORM.3] ${OBJ} no menciona el origen esperado: ¿ya estaba repuntada?`);
  const nuevaDef = def.replace(buscar, poner);
  const quedan = (nuevaDef.match(buscar) || []).length;
  if (quedan) throw new Error(`[NORM.3] quedaron ${quedan} referencias sin reemplazar`);

  await knex.raw(`CREATE OR REPLACE VIEW ${OBJ} AS ${nuevaDef}`);
  await knex.raw(`GRANT SELECT ON ${OBJ} TO app_runtime`);
  return antes;
}

exports.up = async function up(knex) {
  const n = await repuntar(knex, true);

  // Comprobación por DEPENDENCIA REAL, no por texto: la vista ya no puede colgar de la tabla.
  const { rows: dep } = await knex.raw(`
    SELECT 1 FROM pg_depend d
      JOIN pg_rewrite rw ON rw.oid = d.objid
      JOIN pg_class c2   ON c2.oid = rw.ev_class
     WHERE d.refobjid = '${TABLA}'::regclass AND c2.relname = 'v_sellout_daily'`);
  if (dep.length) throw new Error(`[NORM.3] ${OBJ} sigue dependiendo de ${TABLA}`);

  console.log(`[NORM.3] ${OBJ} repuntada a ${VISTA} (${n} referencias).`);
  console.log(
    '⬜ DECLARADO, no resuelto: mv_kepler_sales_daily y mv_wincaja_sales_daily siguen leyendo la ' +
    'tabla. Exposición medida: 6 SKUs (17116, 17210, 83652, 89045, 92026, 99870), $868,071/90d.',
  );
};

exports.down = async function down(knex) {
  await repuntar(knex, false);
  console.log(`[NORM.3] ${OBJ} de vuelta a ${TABLA}.`);
};
