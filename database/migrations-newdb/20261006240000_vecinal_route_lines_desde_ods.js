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

// Marca 1: el final de la pierna del push. Se le cuelga el WHERE que la acota a las camionetas.
const M1_BUSCA = `     LEFT JOIN catalog.products pr ON pr.tenant_id = rpl.tenant_id AND btrim(pr.sku::text) = btrim(rpl.sku) AND pr.deleted_at IS NULL`;
const M1_PONE = `${M1_BUSCA}
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
function sustituirUnaVez(texto, busca, pone, etiqueta) {
  const partes = texto.split(busca);
  if (partes.length !== 2) {
    throw new Error(
      `[VEC.1] la marca "${etiqueta}" aparece ${partes.length - 1} veces en ${VISTA} (se esperaba 1). `
      + 'La vista cambio de forma: revisar a mano antes de reaplicar.',
    );
  }
  return partes.join(pone);
}

exports.up = async function up(knex) {
  const def = (await knex.raw(`SELECT pg_get_viewdef('${VISTA}'::regclass, true) AS d`)).rows[0].d;

  if (def.includes('v_kepler_vecinal_sales_lines')) return; // ya aplicada

  let nueva = sustituirUnaVez(def, M1_BUSCA, M1_PONE, 'pierna del push');
  nueva = nueva.replace(/;\s*$/, '') + PIERNA_VECINAL;

  await knex.raw(`CREATE OR REPLACE VIEW ${VISTA} AS ${nueva}`);
  await knex.raw(`GRANT SELECT ON ${VISTA} TO app_runtime`);
  await knex.raw(`COMMENT ON VIEW ${VISTA} IS ?`, [COMENTARIO]);
};

exports.down = async function down(knex) {
  const def = (await knex.raw(`SELECT pg_get_viewdef('${VISTA}'::regclass, true) AS d`)).rows[0].d;
  if (!def.includes('v_kepler_vecinal_sales_lines')) return;

  const sinPierna = def.split(PIERNA_VECINAL.replace(/\s+$/, ''))[0];
  const restaurada = sustituirUnaVez(sinPierna, M1_PONE, M1_BUSCA, 'pierna del push (vuelta)');
  await knex.raw(`CREATE OR REPLACE VIEW ${VISTA} AS ${restaurada}`);
  await knex.raw(`GRANT SELECT ON ${VISTA} TO app_runtime`);
  await knex.raw(`COMMENT ON VIEW ${VISTA} IS NULL`);
};
