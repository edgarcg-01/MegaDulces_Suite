'use strict';
/**
 * `[CANON.6.14]` Códigos de barras que `import-product-barcodes.js` REVIVIÓ desde la foto congelada de Wincaja después
 * de que Kepler los retiró — y que Kepler YA REEMPLAZÓ por otro código real en la misma unidad. Decisión de Edgar
 * (2026-11-13): «hay que omitir los que Kepler ya reemplazó».
 *
 * Un revivido es una fila VIVA `source='wincaja'` cuyo (sku, código) tuvo una fila `kepler_*` que el hop-2 dio de BAJA.
 * Entra a la baja sólo si HOY Kepler trae otro código real en alguna de las unidades de esa fila Kepler. NO entra:
 *   · si Kepler trae ese mismo código sin ceros a la izquierda (`0664697025397` ↔ `664697025397`): es el MISMO
 *     código en otro formato (EAN-13 / UPC-A), no un reemplazo — bajarlo dejaría sin escanear al lector que manda 13
 *     dígitos (6 así el 13-nov);
 *   · si Kepler dejó la unidad o el producto SIN código (relleno = SKU): eso pide otra regla (55 así el 13-nov);
 *   · si la fila Wincaja nunca fue de Kepler.
 * La regla de «qué trae Kepler hoy» es la del hop-2 (`computeBarcodes`), no una copia.
 */
const { computeBarcodes } = require('../../../services/feeds-ingest/barcode-compute');

const sinCeros = (v) => String(v || '').replace(/^0+/, '');

/** Devuelve [{ id, sku, barcode, unidad, reemplazo }] — sólo lee. */
async function buscarRevividosReemplazados(client, tenantId) {
  const cand = (await client.query(`
    SELECT w.id, w.sku, w.barcode, w.unit, array_agg(DISTINCT k.source) AS fuentes
      FROM catalog.product_barcodes w
      JOIN catalog.product_barcodes k ON k.tenant_id = w.tenant_id AND k.sku = w.sku AND k.barcode = w.barcode
                                      AND k.source LIKE 'kepler\\_%' AND k.deleted_at IS NOT NULL
     WHERE w.tenant_id = $1 AND w.source = 'wincaja' AND w.deleted_at IS NULL
     GROUP BY w.id, w.sku, w.barcode, w.unit`, [tenantId])).rows;
  if (!cand.length) return [];
  const hoy = await computeBarcodes(client, { schema: 'kepler_ods', skus: [...new Set(cand.map((r) => String(r.sku).trim()))] });
  const porSku = new Map();
  for (const h of hoy) { if (!porSku.has(h.sku)) porSku.set(h.sku, []); porSku.get(h.sku).push(h); }
  const out = [];
  for (const r of cand) {
    const k = porSku.get(String(r.sku).trim()) || [];
    if (k.some((h) => sinCeros(h.barcode) === sinCeros(r.barcode))) continue; // el mismo código (o en otro formato)
    const reemplazo = k.find((h) => r.fuentes.includes(h.source));
    if (reemplazo) out.push({ id: r.id, sku: r.sku, barcode: r.barcode, unidad: r.unit, reemplazo: `${reemplazo.barcode}/${reemplazo.unit}` });
  }
  return out;
}

/** Da de baja (soft-delete) esas filas, en una transacción. Devuelve cuántas. */
async function retirarRevividos(client, tenantId, ids) {
  if (!Array.isArray(ids) || !ids.length) return 0;
  await client.query('BEGIN');
  try {
    await client.query(`SET LOCAL app.tenant_id = '${tenantId}'`);
    const r = await client.query(`
      UPDATE catalog.product_barcodes SET deleted_at = now(), updated_at = now()
       WHERE tenant_id = $1 AND id = ANY($2::uuid[]) AND source = 'wincaja' AND deleted_at IS NULL`, [tenantId, ids]);
    await client.query('COMMIT');
    return r.rowCount;
  } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; }
}

module.exports = { buscarRevividosReemplazados, retirarRevividos };
