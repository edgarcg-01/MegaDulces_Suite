/* eslint-disable */
/**
 * `[IC.CEDIS.5]` — **El almacén `00` se llama «CEDIS», a secas.** Decisión de Edgar (2026-10-01):
 * *"antes era CEDIS BIRAPUATO; ahora sólo debe llamarse CEDIS para identificar el nuevo CEDIS de
 * Kepler"*.
 *
 * ── LA CADENA DE NOMBRES, PARA QUE NADIE LA RECONSTRUYA MAL ─────────────────────────────────────
 *   `Cedis Oficinas`    → mig 20260907210000 (nombraba la sucursal KEPLER, que era OFICINAS)
 *   `CEDIS BPIRAPUATO`  → mig 20260930140000 (nombraba el ARCHIVO `.mdb` de Wincaja)
 *   `CEDIS Irapuato`    → ESTA (nombra la PLAZA… que tampoco hace falta)
 *   `CEDIS`             →
 *
 * ⭐ El criterio de la decisión: los otros tres hubs de compra llevan el nombre de su plaza
 * (`01 Padre Hidalgo`, `08 Morelia Abastos`, `06 Canindo`) porque son sucursales que ADEMÁS
 * consolidan. El `00` no es una plaza que consolida: **es el CEDIS**, el único corporativo, y
 * `mainCedis()` de `/compras/pedido` lo elige justamente por eso. Un nombre que agrega la ciudad
 * sugiere que puede haber otro CEDIS en otra ciudad, y hoy no lo hay.
 *
 * ── POR QUÉ ES SEGURO ──────────────────────────────────────────────────────────────────────────
 * Se barrió el repo antes de tocar: **ningún predicado compara contra el nombre literal**. Las
 * coincidencias son todas rótulos, comentarios o texto de ayuda. El nombre es PRESENTACIÓN; la
 * identidad del almacén son `code`, `kepler_code` y `wincaja_source_branch`, que no se tocan.
 *
 * ⚠️ Se condiciona a los dos nombres conocidos en vez de pisar a ciegas: si otra sesión ya lo
 * renombró a otra cosa, esta migración no se lo lleva por delante.
 *
 * ⛔ Y NO se edita `20260930140000` para "corregir" el nombre ahí: está aplicada en prod (batch
 * 644). Una migración aplicada es historia, no un borrador.
 */
exports.up = async function up(knex) {
  const TENANT = '00000000-0000-0000-0000-00000000d01c';

  await knex('commercial.warehouses')
    .where({ tenant_id: TENANT, code: '00' })
    .whereIn('name', ['CEDIS Irapuato', 'CEDIS BPIRAPUATO'])
    .update({ name: 'CEDIS', updated_at: knex.fn.now() });
};

exports.down = async function down(knex) {
  const TENANT = '00000000-0000-0000-0000-00000000d01c';
  await knex('commercial.warehouses')
    .where({ tenant_id: TENANT, code: '00', name: 'CEDIS' })
    .update({ name: 'CEDIS Irapuato', updated_at: knex.fn.now() });
};
