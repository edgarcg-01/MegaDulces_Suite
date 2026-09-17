'use strict';
/**
 * `[JZ.6]` — **DE QUÉ ZONA ES CADA RUTA, Y CUÁL DE ELLAS ES VECINAL.**
 *
 * ── Qué corrige ─────────────────────────────────────────────────────────────────────────────
 * `[JZ.2]` resolvió la pertenencia de una ruta **por el catálogo** (`trade.catalogs`, `parent_id`
 * = zona) y ahí quedaron tres claves que dos zonas se disputaban. La disputa **no existía**: el
 * registro operativo ya dice de quién es cada ruta, y lo dice sin ambigüedad.
 *
 *     wincaja.branches  →  is_route = true, parent_branch = la sucursal MADRE
 *
 * Medido el 2026-09-17: **18 rutas (5 vecinales, una de ellas histórica), 0 ambiguas, 0
 * huérfanas** — y el fact de venta por ruta
 * (`analytics.v_rd_route_daily`) no tiene **ni una** fila que este puente no resuelva.
 *
 * ⛔ **Y contradice al catálogo en algo que ya estaba publicado.** El catálogo pone `RUTA 501…505`
 * en ZAMORA (y duplica 501/502 en CANINDO); Wincaja dice que las cinco cuelgan de la sucursal
 * **50 = CANINDO**, que es desde donde cargan. Con esto ZAMORA se queda **sin ninguna ruta** y
 * CANINDO gana las cinco. Gana el registro operativo: el catálogo es una etiqueta que alguien
 * teclea, `parent_branch` es de dónde sale la mercancía.
 *
 * ── La vecinal, que es el pedido ────────────────────────────────────────────────────────────
 * Edgar (2026-09-17): *«hay que mostrar vecinal aparte»*. Las vecinales **sí venden** —$944,740 en
 * LA PIEDAD del 1 al 16 de septiembre— y hasta hoy no aparecían en ningún lado de la portada,
 * porque no tienen almacén `RUTA-*` propio en `commercial.warehouses` y `[JZ.2]` las declaraba
 * `sin_almacen`. Acá se clasifican por lo que dice su nombre en el registro operativo
 * (`RUTA VECINAL PH 01`, `RUTA VECINAL ABASTOS LP`…), no por una lista escrita a mano.
 *
 * ⚠️ **Son de la MISMA zona que su sucursal madre**, no de las zonas `* VECINAL` de
 * `trade.zones`. Las vecinales de La Piedad cuelgan de Padre Hidalgo (01) y de La Piedad Abastos
 * (02), así que su zona es `LA PIEDAD RD`. Las zonas `LA PIEDAD VECINAL` / `ZAMORA VECINAL` son
 * eje de PERSONAS (5 vendedores tienen su ficha ahí) y no de venta: no tienen ni un almacén.
 * «Aparte» es un BLOQUE dentro de la zona, no una zona aparte.
 *
 * ── Por qué no se extiende `analytics.v_route_plaza` ────────────────────────────────────────
 * Esa vista ya resuelve ruta → sucursal madre, y está bien hecha. Pero filtra
 * `source_branch ~ '^[0-9]+$'` —sólo dígitos— así que **excluye justamente las vecinales**
 * (`1V001`…`1V004`). Quitarle el filtro cambiaría lo que ven sus dos consumidores de `[RS.13]`
 * (el layout de plaza del sell-out), que hoy dependen de recibir sólo camionetas numeradas. Esta
 * vista contesta **otra pregunta** —ruta → ZONA, y de qué tipo es— y cubre las 18.
 *
 * ── `historica` ─────────────────────────────────────────────────────────────────────────────
 * ⚠️ `VEC-PH-H` («RUTA VECINAL PH histórico Wincaja») termina el 26-jun-2026 y `1V001`/`1V002`
 * arrancan el 27-jun: es la MISMA ruta antes del corte. Sumarla junto a sus sucesoras duplicaría
 * el histórico. Se marca y el consumidor la excluye; no se borra, porque para una pregunta sobre
 * 2025 sigue siendo el dato bueno.
 *
 * VISTA, no tabla: las dos fuentes son propias y vivas (regla principal del proyecto).
 *
 * @param { import("knex").Knex } knex
 */

const VISTA = 'analytics.v_route_zone';

exports.up = async function up(knex) {
  await knex.raw(`
    CREATE OR REPLACE VIEW ${VISTA} WITH (security_invoker = true) AS
    SELECT
      r.tenant_id,
      btrim(r.source_branch)                          AS route_code,
      btrim(r.branch_name)                            AS route_name,
      -- El tipo sale del NOMBRE que le puso la operación, no de una lista a mano: si mañana dan
      -- de alta otra vecinal, entra sola.
      CASE WHEN btrim(r.branch_name) ILIKE '%VECINAL%' THEN 'vecinal' ELSE 'ruta' END AS tipo,
      -- ⚠️ La predecesora del corte de junio. Se marca, no se borra.
      (btrim(r.branch_name) ILIKE '%hist%')            AS historica,
      w.id                                             AS parent_warehouse_id,
      w.code                                           AS parent_code,
      w.name                                           AS parent_name,
      w.zone_id,
      z.name                                           AS zona_name
    FROM wincaja.branches r
    JOIN wincaja.branches p
      ON  p.tenant_id = r.tenant_id
      AND btrim(p.source_branch) = btrim(r.parent_branch)
      AND p.is_route = false
    /*
     * La sucursal madre se identifica con la MISMA precedencia que usa v_route_plaza:
     * kepler_code primero y warehouse_code como respaldo. No es capricho -- MORELIA MADERO (32)
     * no tiene kepler_code y su codigo de almacen es 07; sin el COALESCE, sus dos rutas se
     * quedarian sin zona y desaparecerian de la portada de su jefe.
     *
     * (Sin comillas invertidas: este comentario vive DENTRO de un template literal y un backtick
     * lo cierra. Es la octava vez que esta trampa cobra en el repo.)
     */
    JOIN commercial.warehouses w
      ON  w.tenant_id = r.tenant_id
      AND w.deleted_at IS NULL
      AND w.code = COALESCE(NULLIF(btrim(p.kepler_code), ''), NULLIF(btrim(p.warehouse_code), ''))
    LEFT JOIN trade.zones z
      ON z.id = w.zone_id AND z.tenant_id = w.tenant_id
    WHERE r.is_route = true
  `);

  await knex.raw(`
    COMMENT ON VIEW ${VISTA} IS
    '[JZ.6] Ruta -> sucursal MADRE -> zona, y de que tipo es (ruta / vecinal), desde wincaja.branches (registro operativo). '
    'Reemplaza al catalogo como fuente de pertenencia: trade.catalogs pone 501-505 en ZAMORA y Wincaja dice CANINDO (parent_branch=50), '
    'que es de donde cargan. Cubre las VECINALES, que analytics.v_route_plaza excluye por filtrar source_branch a solo digitos. '
    'historica=true marca VEC-PH-H, predecesora de 1V001/1V002 antes del corte del 27-jun-2026: el consumidor la excluye para no duplicar. '
    'Medido 2026-09-17: 18 rutas (5 vecinales, 1 historica), 0 ambiguas, 0 filas de analytics.v_rd_route_daily sin puente.'
  `);

  // El GRANT no se hereda: sin esto el rol de la app no lee la vista y falla en runtime.
  await knex.raw(`GRANT SELECT ON ${VISTA} TO app_runtime`);
};

exports.down = async function down(knex) {
  await knex.raw(`DROP VIEW IF EXISTS ${VISTA}`);
};
