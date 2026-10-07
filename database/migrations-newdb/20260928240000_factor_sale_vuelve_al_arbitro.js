/**
 * `[VSO.10]` El trinquete del FACTOR DE CAJA vuelve a cero — y se cierra la gotera que lo rompió.
 *
 * ── Qué estaba roto ─────────────────────────────────────────────────────────────────────────
 * `test-newdb-truth-parity.js` mide `catalog.products.factor_sale` contra
 * `analytics.v_product_box_factor` con baseline **0**, y ese cero es un INVARIANTE a propósito:
 * `[VA.3]` no administró la divergencia, la eliminó. Medido hoy: **50 discrepancias**.
 *
 * ── Por qué volvieron, medido ───────────────────────────────────────────────────────────────
 * No fue un feed pisando el valor. Se parten en dos casos, y el grande no es un error de nadie:
 *
 *   35  `factor_sale` VACÍO, el árbitro SÍ tiene testigo  ($100,418 / 90 d)
 *   14  publicado distinto, testigo `kepler_c84`           ($33,737)
 *    1  publicado distinto, testigo `etiquetera`           ($42,475)
 *    1  publicado distinto, testigo `override_no_dato`     ($115,537)
 *
 * Los 35 son **productos nuevos**: `repoint-catalog-presence.js` los inserta y no escribe
 * `factor_sale` — su comentario dice «precio/uom/costo los enriquecen sus feeds», pero de
 * `factor_sale` **ningún carril agendado se hace cargo** (§5bis.4 de `VERDAD_ABSOLUTA.md` ya lo
 * había medido: los cuatro escritores están fuera de todo carril). La ausencia entra sola, y
 * cuando se midió eran 22; hoy 35. Un invariante con una gotera abierta no es un invariante: es
 * un candado que va a volver a ponerse rojo cada semana hasta que alguien tape el agujero.
 *
 * ⛔ **Por eso esta migración no alcanza sola.** En el mismo commit, `repoint-catalog-presence.js`
 * gana un paso que rellena `factor_sale` desde el árbitro después de insertar. El resolvedor cruza
 * `kepler_ods.kdii` por **SKU** (`l.sku = p.sku`), así que un producto recién insertado tiene
 * testigo en el mismo instante — no hace falta esperar a otro feed.
 *
 * ── Los 16 que publicaban OTRO valor: el árbitro gana, y se verificó uno por uno el de más peso ─
 *   `59086` CHECHI FRESCO MINI SURTIDO — publicaba **1**, el árbitro dice **24**, y lo respaldan
 *     DOS testigos independientes: `kdii.c81` (paquete) = 24 y la etiquetera = 24. El `1` es la
 *     forma PELIGROSA de la discrepancia: se lee «se vende por pieza» sobre un paquete de 24.
 *   `30540` ALMENDRA CONFITADA 10 KG ($115,537, el de más dinero) — publicaba **10**, el árbitro
 *     dice **20**, y coinciden `kdii.c84` = 20 **y** la etiquetera = 20. El `10` no lo sostiene
 *     ningún testigo. (El override manual decía **1** y el resolvedor ya lo había descartado —
 *     de ahí su `source = override_no_dato`.)
 *
 * No se decide fila por fila cuál testigo gana: esa precedencia ya la encoda el resolvedor, y
 * re-implementarla acá sería la segunda implementación del primitivo que §5 prohíbe.
 *
 * ⛔ Las filas con `source = 'default'` NO se tocan: ahí el árbitro no afirma nada, y escribir un
 * `default` convertiría «no sé» en un 1.
 *
 * Idempotente y verificado: aborta si después de escribir la paridad no da cero.
 * @param { import("knex").Knex } knex
 */

const TENANT = '00000000-0000-0000-0000-00000000d01c';

/**
 * La MISMA condición que mide el candado — no una parecida.
 *
 * ⚠️ `b.box_factor <> round(b.box_factor)` sale aparte porque NO es una discrepancia: es un
 * límite de REPRESENTACIÓN. `catalog.products.factor_sale` es `integer` y el árbitro puede emitir
 * una fracción cuando el "factor" no es un conteo sino un PESO — el caso vivo es `99136 CROQUETA
 * DOG CHOW ADULT 22.7KG`, donde el árbitro dice `22.70` y la columna sólo puede guardar `23`.
 * Medido: **1 de 9,003** productos con testigo (0.011%), con **$0 de venta en 90 días**.
 * Lo destapó la propia aserción de esta migración, que escribió 51 y encontró 1 que no cerraba.
 */
const FRACCIONARIO = `b.box_factor <> round(b.box_factor)`;
const DISCREPANTES = `
  FROM catalog.products p
  JOIN analytics.v_product_box_factor b ON b.product_id = p.id AND b.tenant_id = p.tenant_id
 WHERE p.tenant_id = ?::uuid AND p.deleted_at IS NULL
   AND b.source <> 'default'
   AND p.factor_sale::numeric IS DISTINCT FROM b.box_factor::numeric`;

exports.up = async function (knex) {
  const antes = (await knex.raw(
    `SELECT count(*)::int n,
            count(*) FILTER (WHERE p.factor_sale IS NULL)::int vacios ${DISCREPANTES}`, [TENANT])).rows[0];
  if (Number(antes.n) === 0) {
    console.log('  el factor de caja publicado ya concuerda con el árbitro — idempotente, skip.');
    return;
  }
  console.log(`  antes: ${antes.n} discrepancia(s) — ${antes.vacios} con factor_sale vacío, ${antes.n - antes.vacios} con otro valor`);

  const r = await knex.raw(
    `UPDATE catalog.products p
        SET factor_sale = b.box_factor::int, updated_at = now()
       FROM analytics.v_product_box_factor b
      WHERE b.product_id = p.id AND b.tenant_id = p.tenant_id
        AND p.tenant_id = ?::uuid AND p.deleted_at IS NULL
        AND b.source <> 'default'
        AND NOT (${FRACCIONARIO})
        AND p.factor_sale::numeric IS DISTINCT FROM b.box_factor::numeric`, [TENANT]);
  console.log(`  escritos: ${r.rowCount} producto(s) con el valor del árbitro`);

  // Lo que quede tiene que ser EXACTAMENTE lo no representable, y se imprime por nombre. Si queda
  // algo más, la migración falla en vez de decir que arregló lo que no arregló.
  const resto = (await knex.raw(
    `SELECT p.sku, p.nombre, p.factor_sale AS publicado, b.box_factor AS arbitro,
            (${FRACCIONARIO}) AS no_representable ${DISCREPANTES}`, [TENANT])).rows;
  for (const x of resto) {
    console.log(`  ⓘ no representable · ${x.sku} ${String(x.nombre).slice(0, 34)} — el árbitro dice ${x.arbitro} y la columna es integer (queda ${x.publicado})`);
  }
  const noDeclarados = resto.filter((x) => !x.no_representable);
  if (noDeclarados.length) {
    throw new Error(`ABORT: quedaron ${noDeclarados.length} discrepancias que NO son de representación (${noDeclarados.map((x) => x.sku).join(', ')}). El trinquete seguiría rojo y la migración diría que lo arregló.`);
  }
};

exports.down = async function () {
  // ⛔ Sin vuelta atrás a propósito: el valor anterior era NULL o un número que NINGÚN testigo
  // sostiene. Restaurarlo sería re-publicar el error. Si hiciera falta revertir, el camino es
  // corregir el ÁRBITRO (su fuente) y dejar que esta misma migración vuelva a escribir.
};
