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
 *   · si Kepler dejó la unidad o el producto SIN código (relleno = SKU): ésos se CONSERVAN con la unidad de Kepler
 *     (decisión de Edgar, 2026-11-17: `buscarConservables`, abajo; 55 así el 13-nov);
 *   · si la fila Wincaja nunca fue de Kepler.
 * La regla de «qué trae Kepler hoy» es la del hop-2 (`computeBarcodes`), no una copia.
 */
const { computeBarcodes, computeBarcodesDetalle } = require('../../../services/feeds-ingest/barcode-compute');

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

/**
 * `[CANON.6.14]` Decisión de Edgar (2026-11-17): «los que Kepler dejó SIN código se conservan en el escáner, con la
 * unidad de Kepler». Son filas Wincaja VIVAS cuyo (sku, código) tuvo una fila `kepler_*` que el hop-2 dio de BAJA cuando
 * Kepler puso relleno: con la regla de hoy (`normalizeBarcodesFromOds`, que ya no las da de baja) esa fila Kepler
 * seguiría viva. Medido el 17-nov: 60 de 61 tenían la unidad de Wincaja (CJA) donde Kepler decía PAQ o PZA — al escanear
 * el código, el sistema creía que era una caja.
 *
 * Entra si: el SKU sigue en `kdii` y su producto vivo; la unidad de la fila Kepler sigue existiendo en Kepler SIN ningún
 * código real (`computeBarcodesDetalle`, la misma regla del hop-2); Kepler no trae ese mismo código en otro formato (sin
 * ceros: ésos son los 6 de `buscarRevividosReemplazados`, aparte); y el código no vive en OTRO SKU (lo declara, no lo
 * resuelve: dos productos con el mismo código es otra decisión).
 * Devuelve { conservables: [{ wincajaId, keplerId, sku, barcode, unidadWincaja, unidadKepler }], enOtroSku: [...] }.
 */
async function buscarConservables(client, tenantId) {
  const cand = (await client.query(`
    SELECT DISTINCT ON (w.id) w.id AS wincaja_id, w.sku, w.barcode, w.unit AS unidad_wincaja,
           k.id AS kepler_id, k.unit AS unidad_kepler
      FROM catalog.product_barcodes w
      JOIN catalog.product_barcodes k ON k.tenant_id = w.tenant_id AND k.sku = w.sku AND k.barcode = w.barcode
                                      AND k.source LIKE 'kepler\\_%' AND k.deleted_at IS NOT NULL
      JOIN catalog.products p ON p.tenant_id = w.tenant_id AND btrim(p.sku) = btrim(w.sku) AND p.deleted_at IS NULL
     WHERE w.tenant_id = $1 AND w.source = 'wincaja' AND w.deleted_at IS NULL
     ORDER BY w.id, k.deleted_at DESC`, [tenantId])).rows;
  if (!cand.length) return { conservables: [], enOtroSku: [] };
  const skus = [...new Set(cand.map((r) => String(r.sku).trim()))];
  const { codigos, unidades } = await computeBarcodesDetalle(client, { schema: 'kepler_ods', skus });
  const unidad = new Map(unidades.map((u) => [`${u.sku}|${u.unit}`, u]));
  const otros = new Set((await client.query(`
    SELECT barcode || '|' || btrim(sku) AS k FROM catalog.product_barcodes
     WHERE tenant_id = $1 AND deleted_at IS NULL AND barcode = ANY($2)`, [tenantId, cand.map((r) => r.barcode)])).rows.map((r) => r.k));
  const conservables = [], enOtroSku = [];
  for (const r of cand) {
    const sku = String(r.sku).trim();
    if (codigos.some((h) => h.sku === sku && sinCeros(h.barcode) === sinCeros(r.barcode))) continue; // Kepler lo trae (otro formato)
    const u = unidad.get(`${sku}|${String(r.unidad_kepler || '').trim().toUpperCase()}`);
    if (!u || u.con_codigo) continue; // la unidad ya no existe, o Kepler trae otro código real en ella (reemplazo)
    const item = { wincajaId: r.wincaja_id, keplerId: r.kepler_id, sku: r.sku, barcode: r.barcode, unidadWincaja: r.unidad_wincaja, unidadKepler: r.unidad_kepler };
    const vivoEnOtro = [...otros].some((k) => k.startsWith(`${r.barcode}|`) && k !== `${r.barcode}|${sku}`);
    (vivoEnOtro ? enOtroSku : conservables).push(item);
  }
  return { conservables, enOtroSku };
}

/**
 * Por cada uno, en UNA transacción: baja la fila Wincaja y revive la fila Kepler (su unidad, su factor). El índice único
 * (tenant, sku, código) vivo obliga a ese orden. Devuelve cuántas filas Kepler revivió.
 */
async function conservar(client, tenantId, items) {
  if (!Array.isArray(items) || !items.length) return 0;
  await client.query('BEGIN');
  try {
    await client.query(`SET LOCAL app.tenant_id = '${tenantId}'`);
    let n = 0;
    for (const it of items) {
      const w = await client.query(`
        UPDATE catalog.product_barcodes SET deleted_at = now(), updated_at = now()
         WHERE tenant_id = $1 AND id = $2 AND source = 'wincaja' AND deleted_at IS NULL`, [tenantId, it.wincajaId]);
      if (w.rowCount !== 1) continue;
      const k = await client.query(`
        UPDATE catalog.product_barcodes SET deleted_at = NULL, updated_at = now(), synced_at = now()
         WHERE tenant_id = $1 AND id = $2 AND source LIKE 'kepler\\_%' AND deleted_at IS NOT NULL`, [tenantId, it.keplerId]);
      if (k.rowCount !== 1) throw new Error(`la fila Kepler ${it.keplerId} (${it.sku}/${it.barcode}) no se pudo revivir: no se deja el código sin fila`);
      n++;
    }
    await client.query('COMMIT');
    return n;
  } catch (e) { await client.query('ROLLBACK').catch(() => undefined); throw e; }
}

module.exports = { buscarRevividosReemplazados, retirarRevividos, buscarConservables, conservar };
