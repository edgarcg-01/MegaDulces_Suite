/* eslint-disable no-console */
/**
 * Etiquetera — datos de etiqueta Kepler → commercial.product_label_prices (BULK, source='kepler').
 *
 * BACKSTOP RECONCILIADOR nocturno (full-catálogo). La frescura AL-MOMENTO la da el hop-2
 * `normalizeLabelsFromOds` en services/feeds-ingest/apply-handlers.js (se dispara al llegar un cambio
 * de kdii/kdpv al ODS). Ambos comparten la MISMA computación: services/feeds-ingest/label-compute
 * (single source of truth) → sin divergencia. Ver feedback_ods_derived_realtime_no_batch_lag.
 *
 * Fuente (default `ods`): kepler_ods.kdii/kdpv_prod_util en el MISMO Postgres de prod (@min, CANON.1.2;
 * une las 6 sucursales por `sucursal`). Fallback `--source=kp`: KP_CONCENTRADA kp.* en .245 (@4h).
 * Reconciliación de precio de pieza = misma regla que BASE-MXN (excl CEDIS + moda retail; piso c90>0.05).
 * NUNCA pisa filas source='manual'. Churn-free (solo reescribe lo que cambió).
 *
 * Este script mapea sku→product_id (con fallback por barcode para productos sin sku, que el hop-2 NO
 * cubre → por eso el nightly sigue siendo necesario) y hace el backfill de public.products.barcode.
 *
 *   node database/importers/kepler/import-label-data.js          # dry-run
 *   node database/importers/kepler/import-label-data.js --apply  # commit
 */

const { Client } = require('pg');
const { declararActor } = require('../lib/declare-actor');
const { computeLabels, toStageTuple, upsertLabels, barcodeFormat } = require('../../../services/feeds-ingest/label-compute');
/**
 * `[TDA.8]` El aviso de que un precio de etiqueta cambió.
 *
 * ── Por qué estaba faltando justo acá ────────────────────────────────────────────────────
 * `notifyLabelPricesChanged` se escribió en `[TDA.1]` y se cableó en `apply-handlers.js` — el
 * hop-2 del servicio `feeds-ingest`. Pero **el que publica el precio de etiqueta hoy es ESTE
 * script**: `[VL.4b]` lo movió al carril `prices` (cada 30 min) del servidor nuevo, y este camino
 * llamaba `upsertLabels` **sin el 5º parámetro**, así que ni siquiera sabía qué había cambiado.
 *
 * O sea: el aviso no estaba apagado por configuración — **no estaba conectado al camino que
 * corre**. La etiquetera tiene su banner de precio vivo desde TDA.1 y nunca se disparó.
 */
const { notifyLabelPricesChanged } = require('../../../services/feeds-ingest/notify-store');

const M = '00000000-0000-0000-0000-00000000d01c';
const DST = process.env.DATABASE_URL_NEW || (() => { throw new Error('falta la URL de la DB destino: exporta DATABASE_URL_NEW — la copia local :5433/postgres_platform fue PURGADA 2026-09-08 (ver reference_prod_db_connection_topology)'); })();
const SOURCE = (process.argv.find((a) => a.startsWith('--source=')) || '').split('=')[1] || 'ods';
const KSCHEMA = SOURCE === 'ods' ? 'kepler_ods' : 'kp';
const SRC = process.env.KEPLER_URL || 'postgresql://postgres:superoot@192.168.0.245:5432/KP_CONCENTRADA';
const APPLY = process.argv.includes('--apply');

(async () => {
  const db = new Client({ connectionString: DST });
  await db.connect();
  // [VP.3.2] Quien escribe, declarado: el trigger de analytics.master_data_history lo lee
  // solo. Nunca lanza — el actor es metadata, un feed no se cae por no poder firmar.
  await declararActor(db, 'import-label-data');
  const useOds = SOURCE === 'ods';
  const src = useOds ? null : new Client({ connectionString: SRC });
  if (!useOds) {
    try { await src.connect(); }
    catch (e) { console.error(`ERROR: sin conexión a Kepler (${SRC}): ${e.message}`); await db.end(); process.exitCode = 1; return; }
  }
  const readSrc = useOds ? db : src;

  try {
    console.log(`\n=== Etiquetas Kepler → commercial.product_label_prices (${APPLY ? 'APPLY' : 'DRY-RUN'}) ===`);
    console.log(`  fuente: ${useOds ? 'kepler_ods (same-DB prod, @min)' : SRC.replace(/:[^:@/]+@/, ':***@')} · cómputo compartido con el hop-2 (label-compute)\n`);

    // Catálogo: índices por SKU y por BARCODE (fallback para productos SIN sku). ORDER (deleted_at IS
    // NULL) ASC → activos al final GANAN el skuToId.set (last-wins, no cuelga del borrado).
    const prods = (await db.query(
      `SELECT id, btrim(coalesce(sku,'')) AS sku, btrim(coalesce(barcode,'')) AS barcode
         FROM public.products WHERE tenant_id=$1
        ORDER BY (deleted_at IS NULL) ASC`, [M])).rows;
    const skuToId = new Map(), bcToId = new Map(), curBarcodeById = new Map(), eansInUse = new Set();
    for (const p of prods) {
      if (p.sku) skuToId.set(p.sku, p.id);
      if (p.barcode && !bcToId.has(p.barcode)) bcToId.set(p.barcode, p.id);
      curBarcodeById.set(p.id, p.barcode);
      if (barcodeFormat(p.barcode)) eansInUse.add(p.barcode);
    }
    console.log(`  catálogo: ${skuToId.size} con sku · ${bcToId.size} con barcode`);

    // Cómputo COMPARTIDO (reconciliación moda + tiers kdpv + gramaje/unidades/barcode).
    const labels = await computeLabels(readSrc, { schema: KSCHEMA });
    console.log(`  labels computados: ${labels.length}`);

    if (process.env.DEBUG_SKU) {
      const dbg = (await readSrc.query(
        `SELECT btrim(c1) sku, c90 piece_c90, btrim(c80) u1, c81 f1, c91 p1_c91,
                btrim(c83) u2, c84 f2, c92 p2_c92, c11 unit_base
           FROM ${KSCHEMA}.kdii WHERE btrim(c1)=$1 ORDER BY c90::numeric DESC`,
        [String(process.env.DEBUG_SKU).trim()])).rows;
      console.log(`\n[DEBUG ${process.env.DEBUG_SKU}] filas en kdii (todas las sucursales):`);
      console.table(dbg);
    }

    // map sku→pid (fallback barcode), dedup por pid, decisiones de backfill, tuples staged.
    let matched = 0, unmatched = 0, noBarcode = 0, dupPid = 0;
    const staged = [], barcodeFixes = [], claimedEan = new Set(), stagedPids = new Set();
    for (const lab of labels) {
      let pid = skuToId.get(lab.sku);
      if (!pid) { const bc = String(lab.barcode_raw || '').trim(); if (bc) pid = bcToId.get(bc); }
      if (!pid) { unmatched++; continue; }
      if (stagedPids.has(pid)) { dupPid++; continue; }  // 1ª (mayor c90 por DISTINCT ON) gana
      stagedPids.add(pid);
      if (!lab.barcode_format) noBarcode++;
      // Backfill products.barcode: actual NO-EAN + EAN real libre (sin colisión). Idempotente.
      if (lab.barcode_format) {
        const cur = curBarcodeById.get(pid) || '';
        const ean = String(lab.barcode).trim();
        if (cur !== ean && !barcodeFormat(cur) && !eansInUse.has(ean) && !claimedEan.has(ean)) {
          barcodeFixes.push([pid, ean]); claimedEan.add(ean);
        }
      }
      staged.push(toStageTuple(lab, pid));
      matched++;
    }
    console.log(`  match catálogo: ${matched} · sin match: ${unmatched} · sin barcode válido: ${noBarcode} · pid duplicado saltado: ${dupPid}`);
    console.log(`  backfill products.barcode (SKU/basura → EAN real, sin colisión): ${barcodeFixes.length}`);
    console.table(staged.slice(0, 6).map((s) => ({ content: s[1], barcode: s[2], fmt: s[3], pza: s[4], may_pza: s[6], paq: s[8], box: s[10] })));

    if (!APPLY) { console.log('\n[DRY-RUN] nada cambió. Corré con --apply.'); return; }

    await db.query('BEGIN');
    await db.query(`SET LOCAL app.tenant_id = '${M}'`);
    // `[TDA.8]` `cambiados` recoge los product_id que REALMENTE se escribieron. El UPSERT es
    // churn-free, así que esto no son "los que se intentaron" sino "los que cambiaron" — es la
    // diferencia entre avisar 9,000 veces por corrida y avisar lo que pasó.
    const cambiados = [];
    const changed = await upsertLabels(db, M, staged, 1000, cambiados); // churn-free, source<>'manual'
    // Backfill products.barcode (casos seguros). Guard re-valida (idempotente + anti-carrera).
    let bcFixed = 0;
    for (const [pid, ean] of barcodeFixes) {
      const res = await db.query(
        `UPDATE public.products SET barcode=$2, updated_at=now()
          WHERE id=$1 AND tenant_id=$3
            AND btrim(coalesce(barcode,'')) !~ '^[0-9]{8}$|^[0-9]{12}$|^[0-9]{13}$'
            AND NOT EXISTS (SELECT 1 FROM public.products x
                             WHERE x.tenant_id=$3 AND x.id<>$1 AND btrim(coalesce(x.barcode,''))=$2)`,
        [pid, ean, M]);
      bcFixed += res.rowCount;
    }
    await db.query('COMMIT');
    console.log(`\n[APPLY] COMMIT — ${changed} filas de etiqueta cambiadas (churn-free) · ${bcFixed} barcodes backfilled.`);

    // `[TDA.8]` El aviso va DESPUÉS del COMMIT: es un aviso, no el dato. Si el API no contesta, el
    // precio ya quedó guardado y las pantallas lo verán al siguiente escaneo — el comportamiento
    // de siempre. `notifyLabelPricesChanged` no lanza nunca y trae su propio timeout de 3 s.
    //
    // ⚠️ ACÁ SÍ SE ESPERA, y es la diferencia con `apply-handlers.js`, que dispara sin `await`.
    // Aquel corre dentro de un servidor vivo; ESTO es un CLI que termina: sin el `await` el
    // proceso se va antes de que el POST salga del socket y el aviso se pierde en silencio —
    // con el log diciendo que todo salió bien. Es el mismo modo de falla que la Fase OBS
    // persigue: el sistema reportando éxito sin haber entregado nada.
    if (cambiados.length) {
      const salio = await notifyLabelPricesChanged(M, cambiados, console.warn);
      console.log(
        salio
          ? `[APPLY] aviso enviado: ${cambiados.length} producto(s) con precio nuevo.`
          : `[APPLY] aviso NO enviado (${cambiados.length} producto(s)): las pantallas se enterarán al siguiente escaneo.`,
      );
    }
  } catch (e) {
    await db.query('ROLLBACK').catch(() => {});
    console.error('\nERROR (rollback):', e.message);
    process.exitCode = 1;
  } finally {
    await db.end();
    if (src) await src.end().catch(() => {});
  }
})();
