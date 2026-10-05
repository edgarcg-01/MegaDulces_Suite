'use strict';
/**
 * `[RD.29.2]` — **El tope de inventario de ruta es $80,000, no $40,000.**
 *
 * Lo corrigió Edgar: `[RD.29]` sembró 40,000 y el límite del negocio es **80,000**.
 *
 * ── Lo que cambia el número, medido antes de aplicarlo ────────────────────────────────────
 *
 * | | con 40,000 | con 80,000 |
 * |---|---|---|
 * | rutas que lo pasan hoy | **5 de 11** | **0 de 11** |
 *
 * El camión más cargado es la **501 con $53,171**, el **66 %** del tope nuevo. O sea que con
 * 80,000 **hoy no se dispara ninguna**, y conviene decirlo en vez de celebrar un tablero verde:
 *
 * ⭐ **Es un techo de prevención, no un detector de lo que ya pasó.** Existe para que nadie lo
 * cruce, y que hoy nadie lo cruce es justamente el estado deseado — no una señal de que la
 * medida sobra. Lo que sí deja de contestar es «quién acumula más de lo normal»: para eso está
 * la columna de lo que trae, ordenable, no el semáforo.
 *
 * ⚠️ Sólo se mueven las filas que siguen en el valor sembrado (40,000). Si alguien ya ajustó una
 * ruta a mano, su número se respeta: una migración correctiva no pisa una decisión humana.
 */

exports.up = async function up(knex) {
  const actualizadas = await knex('commercial.warehouses')
    .whereNull('deleted_at')
    .where('inventory_max_mxn', 40000)
    .whereIn('id', knex('analytics.mv_rd_route_identity').select('warehouse_id'))
    .update({ inventory_max_mxn: 80000, updated_at: knex.fn.now() });
  console.log(`  · [RD.29.2] tope movido de 40,000 a 80,000 en ${actualizadas} ruta(s)`);

  const { rows } = await knex.raw(`
    SELECT count(*)::int AS total,
           count(*) FILTER (WHERE w.inventory_max_mxn = 80000)::int AS en_80k,
           count(*) FILTER (WHERE w.inventory_max_mxn IS NULL)::int AS sin_tope
      FROM analytics.mv_rd_route_identity i
      JOIN commercial.warehouses w ON w.id = i.warehouse_id AND w.deleted_at IS NULL`);
  const r = rows[0];
  console.log(`  · [RD.29.2] ${r.en_80k} de ${r.total} rutas en 80,000 · ${r.sin_tope} sin tope`);
  // Freno: una ruta sin tope publica un guion y nadie se entera de que le falta.
  if (Number(r.sin_tope) > 0) {
    throw new Error(`[RD.29.2] ${r.sin_tope} ruta(s) quedaron sin tope declarado`);
  }
};

exports.down = async function down(knex) {
  await knex('commercial.warehouses')
    .whereNull('deleted_at')
    .where('inventory_max_mxn', 80000)
    .whereIn('id', knex('analytics.mv_rd_route_identity').select('warehouse_id'))
    .update({ inventory_max_mxn: 40000, updated_at: knex.fn.now() });
};
