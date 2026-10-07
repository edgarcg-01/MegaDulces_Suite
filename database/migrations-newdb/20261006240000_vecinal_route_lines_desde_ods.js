'use strict';
/**
 * `[VEC.1]` — **`v_route_sales_lines` deja de leer la vecinal del importer y la toma del ODS.**
 *
 * Sigue a `20261006230000` (`[VEC.0]`), que construyo la verdad derivada. Esta migracion la
 * enchufa donde la consumen el drill-down por ticket, el desglose por producto/cliente y la
 * tarjeta de incentivos (`RoutePromoService`), que hoy leen `analytics.route_push_lines`.
 *
 * ⛔ Medido en prod: de las **103,394 lineas vecinales** que hay en esa tabla, ~3 de cada 4 son
 * de **otras cajas** — el defecto del join sin `c5` descrito en `[VEC.0]`. No es un problema de
 * totales nada mas: el desglose dice que la ruta vendio productos que nunca subio al camion, y
 * sobre ese desglose se calculan incentivos (`metric = clientes_distintos` por SKU).
 *
 * ── El cambio, en dos piezas ────────────────────────────────────────────────────────────────
 *
 *   1. La pierna del **push** (`route_push_lines`) se acota a las rutas que de verdad le
 *      pertenecen — las camionetas, cuyo `route_no` es numerico (`21`..`28`, `501`..`505`). Esa
 *      pierna sigue viniendo del runner `.249` y **no se toca**: es otra fuente, con su propia
 *      deuda, y mezclarla en este cambio seria cambiar dos cosas a la vez.
 *   2. Entra una pierna nueva desde `analytics.v_kepler_vecinal_sales_lines`.
 *
 * ⚠️ **El ticket vecinal es `(caja, folio)`.** El folio solo es unico DENTRO de su caja, y
 * `consecutivo` es justamente lo que el servicio cuenta con `count(DISTINCT ...)` para decir
 * cuantos tickets hizo la ruta. Por eso aca `consecutivo` se emite como `caja || '-' || folio` y
 * el `doc_ref` conserva el folio a secas, que es lo que se le muestra a una persona.
 *
 * ⚠️ `vendedor` se llena con el codigo de ruta. En la venta a bordo **la ruta ES el vendedor**
 * (lo mismo que ya asumia `evaluateIncentive`), y dejarlo en NULL dejaria sin dimension a quien
 * agrupe por vendedor.
 *
 * ── Como se edita una vista de 30 columnas sin reescribirla a mano ──────────────────────────
 *
 * Se parte de `pg_get_viewdef` y se hacen DOS sustituciones de texto **verificadas**: si una
 * marca no aparece exactamente una vez, la migracion aborta y no cambia nada. Reescribir las 30
 * columnas a mano es la via rapida para perder una en silencio; una sustitucion que se niega a
 * adivinar, no. Es el mismo patron que `20261006210000` uso sobre esta clase de vista.
 *
 * @param { import("knex").Knex } knex
 */

const VISTA = 'analytics.v_route_sales_lines';

// Marca 1: el final de la pierna del push — el `LEFT JOIN` al catálogo que la cierra, justo antes
// del `UNION ALL` siguiente. Ahí se le cuelga el WHERE que la acota a las camionetas.
//
// ⚠️⚠️ **`pg_get_viewdef` imprime según el `search_path` de QUIEN PREGUNTA.** No es un detalle
// de estilo: el mismo objeto sale distinto en dos sesiones. Medido contra prod — desde una sesión
// de consulta la definición dice `catalog.products`, y desde el pod de la API, que tiene
// `search_path = identity, catalog, trade, …`, dice `products` a secas, porque el schema ya está
// en la ruta. Un primer intento comparaba el texto literal y daba **0 coincidencias** sobre una
// vista que sí contenía lo que se buscaba.
//
// Por eso: el schema es opcional en la expresión, y arriba se fija el `search_path` para que la
// definición venga calificada de todas formas. *El texto de un catálogo no es un contrato; la
// secuencia de tokens, sí.*
const M1_RX = /(FROM\s+(?:analytics\.)?route_push_lines\s+rpl\s+LEFT JOIN\s+(?:catalog\.)?products\s+pr\s+ON[^\n]*)/;
const M1_SUFIJO = `
  WHERE rpl.route_no !~ '^[0-9]V[0-9]'`;

// Pierna nueva: la vecinal, derivada del ODS. Mismo orden y tipos que las otras tres.
const PIERNA_VECINAL = `
UNION ALL
 SELECT vl.tenant_id,
    vl.route_no AS source_branch,
    'ruta_venta'::text AS sale_channel,
    vl.business_date,
    vl.sku,
    vl.qty,
    vl.importe,
    (vl.caja || '-'::text) || vl.folio AS consecutivo,
    vl.folio AS doc_ref,
    vl.cliente,
    'kepler_vecinal'::text AS source,
    vl.producto,
    vl.unidad,
    'linea'::text AS unidad_origen,
    COALESCE(vl.precio_unitario,
        CASE
            WHEN vl.qty <> 0::numeric THEN vl.importe / vl.qty
            ELSE NULL::numeric
        END) AS precio_unitario,
    NULL::numeric AS costo,
    NULL::numeric AS iva,
    NULL::numeric AS ieps,
    NULL::numeric AS descuento1,
    NULL::numeric AS descuento2,
    NULL::text AS hora,
    'ticket'::text AS doc_tipo,
    NULL::text AS forma_pago,
    NULL::text AS forma_pago_desc,
    NULL::boolean AS forma_pago_credito,
    NULL::boolean AS forma_pago_tarjeta,
    vl.route_no AS vendedor,
    NULL::text AS cajero,
    vl.caja,
    pr.id AS product_id
   FROM analytics.v_kepler_vecinal_sales_lines vl
     LEFT JOIN catalog.products pr ON pr.tenant_id = vl.tenant_id AND btrim(pr.sku::text) = btrim(vl.sku) AND pr.deleted_at IS NULL`;

const COMENTARIO =
  '[VEC.1] Une las piernas de venta en ruta. La vecinal sale de analytics.'
  + 'v_kepler_vecinal_sales_lines (derivada del ODS); la de route_push_lines queda acotada a las '
  + 'camionetas (route_no numerico) porque el importer vecinal fue retirado y dejaba ~3 de cada 4 '
  + 'lineas de OTRAS cajas. El ticket vecinal es (caja, folio): el folio solo es unico dentro de '
  + 'su caja, por eso consecutivo = caja-folio.';

/** Aplica una sustitucion que DEBE ocurrir exactamente una vez, o aborta sin tocar nada. */
const lit = (s) => `'${String(s).replace(/'/g, "''")}'`;

function acotarPiernaDelPush(texto) {
  const global = new RegExp(M1_RX.source, 'g');
  const veces = (texto.match(global) || []).length;
  if (veces !== 1) {
    throw new Error(
      `[VEC.1] la pierna del push aparece ${veces} veces en ${VISTA} (se esperaba 1). `
      + 'La vista cambio de forma: revisar a mano antes de reaplicar.',
    );
  }
  return texto.replace(M1_RX, `$1${M1_SUFIJO}`);
}

exports.up = async function up(knex) {
  // Con el `search_path` reducido, `pg_get_viewdef` califica todos los objetos y la definición
  // deja de depender de quién la pida (ver la nota de M1_RX).
  await knex.raw(`SET LOCAL search_path = pg_catalog`);
  const def = (await knex.raw(`SELECT pg_get_viewdef('${VISTA}'::regclass, true) AS d`)).rows[0].d;

  if (def.includes('v_kepler_vecinal_sales_lines')) return; // ya aplicada

  let nueva = acotarPiernaDelPush(def);
  nueva = nueva.replace(/;\s*$/, '') + PIERNA_VECINAL;

  await knex.raw(`CREATE OR REPLACE VIEW ${VISTA} AS ${nueva}`);
  await knex.raw(`GRANT SELECT ON ${VISTA} TO app_runtime`);
  await knex.raw(`COMMENT ON VIEW ${VISTA} IS ${lit(COMENTARIO)}`);
};

exports.down = async function down(knex) {
  const def = (await knex.raw(`SELECT pg_get_viewdef('${VISTA}'::regclass, true) AS d`)).rows[0].d;
  if (!def.includes('v_kepler_vecinal_sales_lines')) return;

  // La vuelta corta la pierna vecinal por su propio `UNION ALL` y le quita el WHERE que acotaba
  // la del push. Si la vista fue editada por otra mano en el medio, esto no encuentra lo que
  // busca y es mejor que falle acá que dejarla a medias.
  const sinPierna = def.split(/UNION ALL\s+SELECT\s+vl\.tenant_id/)[0];
  const restaurada = sinPierna.replace(/\s*WHERE rpl\.route_no !~ '\^\[0-9\]V\[0-9\]'/, '');
  if (restaurada === sinPierna) throw new Error('[VEC.1] no se encontró el WHERE de la pierna del push: revisar a mano');
  await knex.raw(`CREATE OR REPLACE VIEW ${VISTA} AS ${restaurada}`);
  await knex.raw(`GRANT SELECT ON ${VISTA} TO app_runtime`);
  await knex.raw(`COMMENT ON VIEW ${VISTA} IS NULL`);
};
