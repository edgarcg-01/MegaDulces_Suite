/**
 * `[NORM.3]` Nace `commercial.v_product_label_prices`: la forma CONSOLIDADA (una fila por
 * producto) del dato de etiqueta.
 *
 * ── Para qué, si hoy no cambia nada ─────────────────────────────────────────────────────────
 * Hoy es un pasa-manos: `commercial.product_label_prices` ya tiene una fila por producto, así que
 * esta vista devuelve exactamente lo mismo. Existe para que los lectores que **no distinguen
 * plaza** se muden ANTES de que la tabla gane el grano por sucursal (`20260911240300`).
 *
 * Ese orden no es estético. Cuando la tabla pase a tener ocho filas por producto:
 *   · un `LEFT JOIN ... ON product_id` sin agregar **multiplica filas por ocho** — ventas, costos
 *     y planes de compra inflados sin un solo error en el log;
 *   · un `max(box_size) GROUP BY product_id` deja de ser *el valor* y pasa a ser *el máximo entre
 *     ocho tiendas*, que es peor porque no se nota: el número cambia y nada falla.
 *
 * Mudar primero y cambiar el grano después deja cada paso verificable por separado. Mientras esta
 * vista sea pasa-manos, cualquier lector repuntado tiene que devolver **lo mismo byte a byte** —
 * y eso se puede comprobar antes de tocar la tabla.
 *
 * ── Por qué la tabla manda y la vista deriva ────────────────────────────────────────────────
 * El grano fino (producto × tienda) es el hecho: Kepler fija precio por plaza. Lo consolidado es
 * una opinión sobre ese hecho (la moda). La regla del proyecto es derivar, no materializar una
 * segunda copia — así que el hecho vive en la tabla y la opinión se calcula.
 *
 * ⚠️ `security_invoker` y el `GRANT` NO se heredan: la tabla tiene RLS FORCE y sin `security_invoker`
 * la vista leería con los permisos del dueño, saltándose el aislamiento por tenant.
 *
 * @param { import("knex").Knex } knex
 */

exports.up = async function up(knex) {
  await knex.raw(`
    CREATE OR REPLACE VIEW commercial.v_product_label_prices AS
    SELECT * FROM commercial.product_label_prices`);
  await knex.raw(`ALTER VIEW commercial.v_product_label_prices SET (security_invoker = true)`);
  await knex.raw(`GRANT SELECT ON commercial.v_product_label_prices TO app_runtime`);
  await knex.raw(`COMMENT ON VIEW commercial.v_product_label_prices IS
    'Forma CONSOLIDADA (1 fila por producto) del dato de etiqueta. Los lectores que no distinguen sucursal leen ACÁ. [NORM.3] la vuelve la moda entre plazas cuando la tabla gana grano por sucursal.'`);

  // Prueba de que el pasa-manos realmente pasa: si la vista no devuelve lo mismo que la tabla,
  // repuntar lectores sería cambiarles el dato. Un gate sin prueba es una intención.
  const { rows } = await knex.raw(`
    SELECT (SELECT count(*) FROM commercial.product_label_prices) AS tabla,
           (SELECT count(*) FROM commercial.v_product_label_prices) AS vista`);
  if (rows[0].tabla !== rows[0].vista) {
    throw new Error(`[NORM.3] la vista no es pasa-manos: tabla ${rows[0].tabla} vs vista ${rows[0].vista}`);
  }
  console.log(`[NORM.3] v_product_label_prices creada (pasa-manos verificado: ${rows[0].vista} filas).`);
};

exports.down = async function down(knex) {
  await knex.raw(`DROP VIEW IF EXISTS commercial.v_product_label_prices`);
};
