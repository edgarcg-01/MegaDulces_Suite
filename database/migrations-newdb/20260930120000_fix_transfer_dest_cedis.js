/**
 * `[DM.11e]` — **Los traspasos al CEDIS se le estaban acreditando a 8ESQ.**
 *
 * ── EL SÍNTOMA ──────────────────────────────────────────────────────────────────────────────
 * En `/almacen/movimientos`, filtrando por el almacén 8ESQ, aparecían envíos cuyo destino real
 * es el CEDIS. El documento `0000176` de Morelia Abastos lo mostraba como `↔ 8ESQ`.
 *
 * ── LA CAUSA, MEDIDA ────────────────────────────────────────────────────────────────────────
 * `analytics.transfer_dest_map` tenía:
 *
 *     TI000  "CENTRO DE DISTRIBUCIÓN ( CEDIS)"  ->  almacén 03 (8ESQ)     ⛔
 *
 * Ese vínculo lo puso el auto-ligado `[DM.11d]` de `import-stock-movements.js`, que ata
 * `dest_code -> almacén` por **verdad de recepción**: parea la salida con su recepción por
 * `folio` + `serie` dentro de 15 días y se queda con el almacén que más veces gana.
 *
 * El problema es que **la recepción del CEDIS no vive en `analytics.stock_movements`** — el
 * propio importer lo dice: *"re-intenta ~310 dest_codes viejos sin contraparte —CEDIS/rutas—
 * que nunca ligan"*. Y los folios son **secuencia por sucursal**, así que se parean entre
 * sucursales distintas por pura coincidencia.
 *
 * Medido en prod el 2026-09-30, a nivel DOCUMENTO y sobre un año:
 *
 *     TI000: 15 envíos · 13 SIN recepción · 2 pareados con 8ESQ (Canindo, recibidos 5 y 7 días
 *            después) = **13 % de evidencia**
 *
 * Dos coincidencias sobre quince alcanzaron, porque el ganador se elegía con
 * `DISTINCT ON (dest_code) ... ORDER BY n DESC` — **sin mínimo y sin exigir dominancia**.
 * Para contraste, los vínculos legítimos van de **82 % a 97 %**:
 *
 *     TI006 82% · TI009 86% · TI007 87% · TI002 90% · TI001 91% · TI008 95% · TI003 97%
 *
 * ── LO QUE COSTABA ──────────────────────────────────────────────────────────────────────────
 * En 120 días, **15 documentos · 5,476 piezas · $123,454.08** salidos de Canindo, Morelia
 * Abastos y Padre Hidalgo se le acreditaban a 8ESQ.
 *
 * ── LO QUE HACE ESTA MIGRACIÓN ──────────────────────────────────────────────────────────────
 * Reapunta `TI000` al almacén del CEDIS. **No inventa el destino**: lo resuelve del catálogo
 * (`commercial.warehouses`, código `00`, nombre con "CEDIS"). Si ese almacén no existe, la fila
 * se deja en **NULL** —destino declarado como desconocido— en vez de conservar uno falso: una
 * pantalla que dice "(sin destino)" se investiga; una que dice "8ESQ" se cobra.
 *
 * ⚠️ El auto-ligado sólo escribe `WHERE warehouse_id IS NULL`, así que un valor curado como éste
 * **se respeta** y no lo vuelve a pisar. El candado que impide que vuelva a pasar con OTRO
 * `dest_code` va en el importer (umbral de evidencia), no acá.
 *
 * ⚠️ NO se toca `TI009`, que hoy apunta a `MD-32` mientras la evidencia (86 %) señala a `07
 * Morelia Madero`. Son **el mismo lugar físico bajo dos códigos** —el residuo del cutover
 * Wincaja→Kepler que ya documentó `AUD-DAT.21`— y elegir uno sin decidir primero cuál es el
 * canónico sólo movería el problema de lugar.
 *
 * Candado: `database/tests/test-newdb-transfer-dest-evidence.js`.
 */

const CEDIS = 'TI000';

exports.up = async function up(knex) {
  const tenants = await knex('public.tenants').select('id');
  for (const { id: tenantId } of tenants) {
    const fila = await knex('analytics.transfer_dest_map')
      .where({ tenant_id: tenantId, dest_code: CEDIS }).first('warehouse_id', 'dest_label');
    if (!fila) continue;

    // El destino se RESUELVE del catálogo, no se escribe a mano.
    const cedis = await knex('commercial.warehouses')
      .where({ tenant_id: tenantId })
      .whereNull('deleted_at')
      .andWhere((b) => b.where('code', '00').orWhereRaw(`name ILIKE '%CEDIS%'`))
      .orderByRaw(`CASE WHEN code = '00' THEN 0 ELSE 1 END`)
      .first('id', 'code', 'name');

    const destino = cedis ? cedis.id : null;
    if (fila.warehouse_id === destino) continue; // idempotente

    await knex('analytics.transfer_dest_map')
      .where({ tenant_id: tenantId, dest_code: CEDIS })
      .update({ warehouse_id: destino, updated_at: knex.fn.now() });

    // eslint-disable-next-line no-console
    console.log(cedis
      ? `[DM.11e] ${CEDIS} -> ${cedis.code} ${cedis.name} (antes: ${fila.warehouse_id || 'NULL'})`
      : `[DM.11e] ${CEDIS} -> NULL: no hay almacén de CEDIS en el catálogo, se DECLARA desconocido`);
  }
};

exports.down = async function down(knex) {
  // El valor anterior era incorrecto (apuntaba a 8ESQ por dos pareos espurios). Revertir a NULL
  // deja el destino declarado como desconocido, que es el estado honesto previo a la curación:
  // restaurar el vínculo falso sería reintroducir el defecto a propósito.
  const tenants = await knex('public.tenants').select('id');
  for (const { id: tenantId } of tenants) {
    await knex('analytics.transfer_dest_map')
      .where({ tenant_id: tenantId, dest_code: CEDIS })
      .update({ warehouse_id: null, updated_at: knex.fn.now() });
  }
};
