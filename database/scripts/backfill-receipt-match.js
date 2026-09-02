#!/usr/bin/env node
/**
 * `[RE.25]` — Calcula las señales del cuadre para los comprobantes **ya subidos**.
 *
 * La migración `20260902160000` agrega `prov_score` / `prov_rfc_match` / `paquete_ok` en `NULL`,
 * y de ahí en adelante `attach()` las llena sola. Este script cubre el pasado: sin él, todo lo
 * subido antes queda en `sin_datos` — que sería mentira, porque el dato SÍ está (en `ocr_*`),
 * sólo que nadie lo había comparado nunca.
 *
 * Corre el **motor real** (`receipt-match.ts`), no una reimplementación: si el criterio cambia,
 * un re-run deja la historia consistente con lo que decide hoy el flujo vivo.
 *
 * Es **idempotente y re-ejecutable**: recalcula desde `ocr_*` + la entrada de Kepler, así que
 * correrlo dos veces da lo mismo. Sólo escribe las 3 columnas de análisis — no toca `status`,
 * `monto_match`, ni nada del trámite.
 *
 * Uso:
 *   node database/scripts/backfill-receipt-match.js            # contra DATABASE_URL_NEW
 *   node database/scripts/backfill-receipt-match.js --dry-run  # muestra el reparto, no escribe
 *   DATABASE_URL_NEW=<prod> node database/scripts/backfill-receipt-match.js
 */

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env'), quiet: true });

const DRY = process.argv.includes('--dry-run');
const DST = process.env.DATABASE_URL_NEW;
if (!DST) { console.error('Falta DATABASE_URL_NEW'); process.exit(1); }

require('ts-node').register({
  transpileOnly: true, skipProject: true,
  compilerOptions: { module: 'commonjs', target: 'es2020', esModuleInterop: true, moduleResolution: 'node', ignoreDeprecations: '6.0' },
});
const {
  parecidoNombre, rfcComparable, rfcBienFormado, bucketDeSenales, evaluarPaquete,
  evaluarFolioInterno, HOJAS_INTERNAS,
} = require(path.resolve(__dirname, '../../libs/finance/src/lib/goods-receipt-proofs/receipt-match.ts'));

const knex = require('knex')({
  client: 'pg',
  connection: /localhost|127\.0\.0\.1|192\.168/.test(DST) ? DST : { connectionString: DST, ssl: { rejectUnauthorized: false } },
  pool: { min: 0, max: 4 },
});

(async () => {
  let escritos = 0;
  try {
    const hay = await knex.schema.withSchema('finance').hasColumn('goods_receipt_proofs', 'prov_score');
    if (!hay) {
      console.error('❌ Falta la migración 20260902160000 (no existe `prov_score`). Corré `knex migrate:latest` primero.');
      process.exit(1);
    }

    // Se lee el proveedor de la ENTRADA VIVA (`erp_goods_receipts`) y no la copia congelada en
    // `goods_receipt_proofs.proveedor_nombre`: esa se guardó al adjuntar y puede haber quedado
    // atrás si el catálogo se corrigió después. La entrada es la fuente.
    const rows = await knex.raw(`
      SELECT p.id, p.folio, p.ocr_proveedor, p.ocr_rfc, p.ocr_raw, p.monto_match, p.files,
             g.proveedor_nombre, g.proveedor_rfc
        FROM finance.goods_receipt_proofs p
        JOIN analytics.erp_goods_receipts g
          ON g.tenant_id = p.tenant_id AND g.sucursal = p.sucursal AND g.folio = p.folio`);

    const reparto = { cuadra: 0, revisar: 0, sin_datos: 0, sin_evidencia: 0 };
    let conHoja = 0, sinHoja = 0, hojaDesconocida = 0, folioCasa = 0, folioNoCasa = 0;
    const updates = [];

    for (const r of rows.rows) {
      let raw = r.ocr_raw;
      if (typeof raw === 'string') { try { raw = JSON.parse(raw); } catch { raw = null; } }

      const prov_score = parecidoNombre(r.ocr_proveedor, r.proveedor_nombre);
      const rfcPapel = rfcBienFormado(r.ocr_rfc) ? rfcComparable(r.ocr_rfc) : null;
      const rfcKepler = rfcBienFormado(r.proveedor_rfc) ? rfcComparable(r.proveedor_rfc) : null;
      const prov_rfc_match = rfcPapel && rfcKepler ? rfcPapel === rfcKepler : null;

      // El ROL declarado por el capturista manda sobre lo que el OCR adivinó: la hoja interna
      // aparece en 93 de 161 por rol y en 7 por `documents_present`.
      let files = r.files;
      if (typeof files === 'string') { try { files = JSON.parse(files); } catch { files = null; } }
      const paquete_ok = evaluarPaquete(
        Array.isArray(files) ? files.map((f) => f && f.role) : null,
        Array.isArray(raw && raw.documents_present) ? raw.documents_present.map((d) => d && d.type) : null,
      );

      // `[RE.26]` El folio impreso en nuestra hoja, contra el de la entrada.
      const folio_interno = (Array.isArray(files) ? files : [])
        .find((f) => f && HOJAS_INTERNAS.has(String(f.role)) && f.ocr_folio)?.ocr_folio ?? null;
      const folio_interno_ok = evaluarFolioInterno(folio_interno, r.folio);
      if (folio_interno_ok === true) folioCasa++; else if (folio_interno_ok === false) folioNoCasa++;

      if (paquete_ok === true) conHoja++; else if (paquete_ok === false) sinHoja++; else hojaDesconocida++;
      reparto[bucketDeSenales({ n: 1, any_match: r.monto_match, prov_score, prov_rfc_match })]++;
      updates.push({ id: r.id, prov_score, prov_rfc_match, paquete_ok, folio_interno, folio_interno_ok });
    }

    console.log(`\n${DRY ? '[DRY-RUN] ' : ''}${rows.rows.length} comprobante(s) evaluado(s)`);
    console.table([{
      cuadra: reparto.cuadra, revisar: reparto.revisar, sin_datos: reparto.sin_datos,
      'paquete con hoja': conHoja, 'sin hoja': sinHoja, 'no se sabe': hojaDesconocida,
      'folio interno casa': folioCasa, 'folio NO casa': folioNoCasa,
    }]);

    if (DRY) { console.log('Nada escrito (--dry-run).'); }
    else {
      // De a lotes y en una sola transacción: o queda todo evaluado o nada, para que no haya un
      // estado intermedio donde el tablero cuenta la mitad.
      await knex.transaction(async (trx) => {
        for (let i = 0; i < updates.length; i += 200) {
          const lote = updates.slice(i, i + 200);
          await Promise.all(lote.map((u) => trx('finance.goods_receipt_proofs')
            .where({ id: u.id })
            .update({
              prov_score: u.prov_score, prov_rfc_match: u.prov_rfc_match, paquete_ok: u.paquete_ok,
              folio_interno: u.folio_interno, folio_interno_ok: u.folio_interno_ok,
            })));
          escritos += lote.length;
        }
      });
      console.log(`✅ ${escritos} actualizado(s).`);
    }
  } catch (e) {
    console.error('❌', e.message);
    process.exitCode = 1;
  } finally {
    await knex.destroy();
  }
})();
