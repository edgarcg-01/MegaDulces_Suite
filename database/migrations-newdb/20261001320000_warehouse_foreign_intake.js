/**
 * `[DM.20]` — **Cuánta mercancía ajena entró al almacén de una sucursal, declarada por plaza.**
 *
 * ── LA PREGUNTA DE EDGAR ────────────────────────────────────────────────────────────────────
 * *"¿y la carga de productos se le hará a CEDIS o a Morelia?"* — y después *"sí, hazlo"* a
 * publicar el inventario, costo y margen del CEDIS **descontando** lo que fue de Morelia Abastos
 * y Canindo.
 *
 * ── ⛔ LA RESTA NO SE PUEDE HACER, Y POR ESO ESTA VISTA NO LA HACE ──────────────────────────
 * El almacén del CEDIS en Kepler se usó como **el libro de otras plazas**: les entró la compra
 * (`X-A-40`, centro `C-010` = Morelia Abastos) y les salió el traspaso. Verificado con el caso
 * del ticket `T990008354`: los SKUs `90041`/`90044` entraron al almacén `00` **sólo** bajo
 * "COMPRA PROVEEDOR MORELIA ABAST" (2,880 y 1,536 u, hasta el 15-sep) y **nunca** bajo el centro
 * del CEDIS. El CEDIS jamás compró esos productos. Y Morelia Abastos **además** descontó esa
 * misma salida en su propia Wincaja el 16-sep: el mismo físico, en dos libros.
 *
 * **Pero el inventario es FUNGIBLE.** Una vez que las 2,880 unidades de Morelia conviven en el
 * almacén `00` con las del CEDIS, **ningún dato dice cuál unidad salió**. Medido:
 *
 *     las SALIDAS (`U-D-13` 8,867 docs · `U-D-41` 790) traen `c12`, pero son códigos de
 *     caja/ruta (`00001`, `30001`, `50PV1`), **no** el centro de compra (`C-NNN`).
 *
 * Restar exigiría **suponer** un reparto (FIFO, proporcional, promedio). Eso no es medir: es la
 * invención que esta familia de fases existe para no cometer. Así que **la vista declara la
 * exposición, no un neto** (ADR-056).
 *
 * ── LO QUE SÍ ES MEDIBLE, Y ES GRANDE ───────────────────────────────────────────────────────
 * La ENTRADA sí está atribuida: `kdm1.c12` dice de quién era la compra, y lo dice el ERP.
 * Medido sobre `X-A-40` (el documento que mueve inventario) en el almacén `00`, 2026:
 *
 *     de otra plaza          5,873 docs · 32,668,286 u · $220,477,210   ← 76% de las unidades
 *     CEDIS (propio)         2,234 docs · 10,456,113 u · $195,758,912
 *     sin centro declarado     494 docs ·  1,302,938 u · $ 24,534,054
 *
 * Y cuatro meses seguidos **Morelia Abastos movió más documentos por el almacén del CEDIS que el
 * propio CEDIS** (may 251-231 · jun 270-254 · jul 306-287 · ago 314-281).
 *
 * ── ⭐ YA PARÓ, Y LA VISTA LO MUESTRA SOLA ─────────────────────────────────────────────────
 * Edgar abrió la sesión diciendo *"el problema no es actual"*. Es exacto y queda medido: Canindo
 * cerró en septiembre, Padre Hidalgo quedó en 6, Morelia Abastos cerró con su corte del 18-sep,
 * y **octubre va en cero**. El grano es mensual justamente para que eso se vea sin preguntar.
 *
 * ── POR QUÉ `X-A-40` Y NO `X-A-20` ──────────────────────────────────────────────────────────
 * `[DM.19]` resolvió el origen sobre `X-A-20` ("Aplica Orden Entrada"), que es el documento
 * CONTABLE. El que **mueve el inventario** es `X-A-40` (`c8='S'`), y es el que importa para una
 * pregunta de existencia. Son universos parecidos pero no iguales, y usar uno por el otro sería
 * el mismo error de universo que ya cometí hoy dos veces.
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  await knex.raw(`
    CREATE OR REPLACE VIEW analytics.v_warehouse_foreign_intake
      WITH (security_invoker = true) AS
    WITH pc AS MATERIALIZED (
      SELECT * FROM analytics.v_erp_purchase_center
    ), ent AS (
      SELECT m.sucursal,
             date_trunc('month', m.c9::date)::date AS mes,
             NULLIF(btrim(m.c12), '') AS centro_code,
             m.c6 AS folio,
             l.c9::numeric AS unidades,
             l.c13::numeric AS importe
        FROM kepler_ods.kdm1 m
        JOIN kepler_ods.kdm2 l
          ON l.sucursal = m.sucursal AND l.c2 = m.c2 AND l.c3 = m.c3
         AND l.c4 = m.c4 AND l.c6 = m.c6 AND l.c5 = m.c5
       WHERE m.c2 = 'X' AND m.c3 = 'A' AND btrim(m.c4::text) = '40'
         AND btrim(m.c1) = m.sucursal
         AND btrim(COALESCE(m.c43, '')) <> 'C'
    )
    SELECT ws.tenant_id,
           e.sucursal,
           ws.id   AS warehouse_id,
           ws.name AS warehouse_name,
           e.mes,
           e.centro_code,
           pc.centro_desc,
           -- De quién era la compra. NULL cuando el documento no lo declara: se DECLARA, no se
           -- reparte entre los demás ni se da por propio.
           pc.plaza_warehouse_id,
           pc.plaza_warehouse_name,
           CASE
             WHEN e.centro_code IS NULL     THEN 'sin_centro'
             WHEN pc.centro_code IS NULL    THEN 'centro_fuera_de_catalogo'
             WHEN NOT pc.es_centro_de_plaza THEN 'centro_no_dice_plaza'
             WHEN pc.es_centro_propio       THEN 'propio'
             ELSE 'de_otra_plaza'
           END AS intake_veredicto,
           count(DISTINCT e.folio)::int AS docs,
           sum(e.unidades)              AS unidades,
           sum(e.importe)               AS importe
      FROM ent e
      JOIN commercial.warehouses ws
        ON ws.kepler_code = e.sucursal AND ws.deleted_at IS NULL
      LEFT JOIN pc
        ON pc.sucursal = e.sucursal AND pc.centro_code = e.centro_code
     GROUP BY 1,2,3,4,5,6,7,8,9,10`);

  await knex.raw(`GRANT SELECT ON analytics.v_warehouse_foreign_intake TO app_runtime`);

  await knex.raw(`
    COMMENT ON VIEW analytics.v_warehouse_foreign_intake IS
      'DM.20 — mercancia que ENTRO al almacen de una sucursal declarada por plaza (kdm1.c12). '
      'NO es un neto: las SALIDAS no traen centro de compra (su c12 son codigos de caja/ruta), '
      'asi que una vez dentro del almacen el inventario es fungible y restar exigiria suponer '
      'un reparto. Se declara la exposicion, nunca un saldo repartido.'`);
};

exports.down = async function (knex) {
  await knex.raw(`DROP VIEW IF EXISTS analytics.v_warehouse_foreign_intake`);
};
