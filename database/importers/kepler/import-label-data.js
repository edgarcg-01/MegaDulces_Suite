/* eslint-disable no-console */
/**
 * Etiquetera — datos de etiqueta Kepler → commercial.product_label_prices (BULK, source='kepler').
 *
 * ⛔ RETIRADO del carril `prices` (cada 30 min) el 2026-11-14 [CANON.6.19]. HERRAMIENTA MANUAL.
 * Lo de cada día lo hace el hop-2 de la ingesta AL LLEGAR el cambio de kdii / kdpv_prod_util:
 * `normalizeLabelsFromOds` (la etiqueta, con la MISMA computación: services/feeds-ingest/label-compute) y
 * `normalizeProductsFromOds` (el EAN de catalog.products.barcode cuando la ficha trae el SKU en c7). Medido antes de
 * retirarlo: desde el 13-nov no escribía nada salvo DOS carreras en que pisó con el precio viejo lo que el hop-2 acababa
 * de poner (el hop-2 lo regresó a los 3–6 s); 0 de 79,042 etiquetas difieren del ODS y 0 EAN pendientes. Lo vigila el
 * árbitro `etiquetas_evento` de db-health.
 *
 *   sin --apply  mide: cuántas etiquetas cambiaría (las escribe en una transacción que se REVIERTE) y qué productos
 *                esperan su EAN. Debe dar 0 y 0.
 *   --apply      recalcula todas las etiquetas y pone los EAN pendientes con la regla del hop-2.
 *
 * Fuente (default `ods`): kepler_ods.kdii/kdpv_prod_util en el MISMO Postgres de prod (@min, CANON.1.2;
 * une las 6 sucursales por `sucursal`). Fallback `--source=kp`: KP_CONCENTRADA kp.* en .245 (@4h).
 * Reconciliación de precio de pieza = misma regla que BASE-MXN (excl CEDIS + moda retail; piso c90>0.05).
 * NUNCA pisa filas source='manual'. Churn-free (solo reescribe lo que cambió).
 *
 * Este script mapea sku→product_id. El EAN de catalog.products.barcode ya no lo escribe él: delega en
 * `normalizeProductsFromOds` (acotado a los SKU que lo esperan), para que la regla viva en UN lugar.
 *
 * `[CANON.6.7]` (2026-11-11) — SIN fallback por barcode. Ese fallback amarraba un SKU de Kepler que no
 * está en el catálogo al producto que comparte su código de barras. Medido en prod: los 13 amarres eran
 * TODOS SKUs `* DESCONTINUADO`, y 7 caían sobre un producto VIGENTE (SUPER VELA 84234 ← 70216 descontinuado,
 * BLISTER FOAMY 96842 ← 96230): como el SKU descontinuado es menor, llegaba primero, se quedaba el producto
 * y escribía SU precio ($71.51 contra $40.37). El hop-2 lo regresaba ~20 min después, y así cada media hora
 * durante un mes (master_data_history: 12 + 12 escrituras por fila al día). Ahora la identidad es la del
 * hop-2: SÓLO por sku.
 *
 *   node database/importers/kepler/import-label-data.js          # dry-run
 *   node database/importers/kepler/import-label-data.js --apply  # commit
 */

const { Client } = require('pg');
const { declararActor } = require('../lib/declare-actor');
const { computeLabels, toStageTuple, upsertLabels, barcodeFormat, LABEL_STAGE_COLS } = require('../../../services/feeds-ingest/label-compute');
/**
 * `[TDA.8]` El aviso de que un precio de etiqueta cambió.
 *
 * ── Por qué estaba faltando justo acá ────────────────────────────────────────────────────
 * `notifyLabelPricesChanged` se escribió en `[TDA.1]` y se cableó en `apply-handlers.js` — el
 * hop-2 del servicio `feeds-ingest`. Pero **el que publica el precio de etiqueta hoy es ESTE
 * script**: `[VL.4b]` lo movió al carril `prices` (cada 30 min) del servidor nuevo, y este camino
 * llamaba `upsertLabels` **sin el 5º parámetro**, así que ni siquiera sabía qué había cambiado.
 *
 * ⚠️ Ese "cada 30 min" estaba escrito como la expresión de cron (asterisco, barra, 30) DENTRO de
 * este bloque de comentario: la barra cerraba el comentario ahí mismo y **el archivo dejaba de
 * compilar** — Node ni siquiera lo cargaba. Misma familia que
 * `feedback_no_backticks_in_css_comments`: un carácter con significado sintáctico metido en un
 * comentario. La cadencia se escribe en palabras, nunca con la expresión de cron.
 *
 * O sea: el aviso no estaba apagado por configuración — **no estaba conectado al camino que
 * corre**. La etiquetera tiene su banner de precio vivo desde TDA.1 y nunca se disparó.
 */
const { notifyLabelPricesChanged } = require('../../../services/feeds-ingest/notify-store');
const { normalizeProductsFromOds } = require('../../../services/feeds-ingest/apply-handlers');

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

    // Catálogo. `[CANON.6.19]` El sku → producto, sólo de los VIVOS, como el hop-2 (antes caía en un borrado cuando el
    // SKU no tenía vivo; medido el 14-nov: 0 etiquetas así). Los EAN en uso, de TODOS (borrados incluidos): es la guarda
    // del EAN (dos productos con el mismo código el escáner no los distingue).
    const prods = (await db.query(
      `SELECT id, btrim(coalesce(sku,'')) AS sku, btrim(coalesce(barcode,'')) AS barcode, deleted_at IS NULL AS vivo
         FROM catalog.products WHERE tenant_id=$1`, [M])).rows;
    const skuToId = new Map(), curBarcodeById = new Map(), eansInUse = new Set();
    for (const p of prods) {
      if (p.sku && p.vivo) skuToId.set(p.sku, p.id);
      curBarcodeById.set(p.id, p.barcode);
      if (barcodeFormat(p.barcode)) eansInUse.add(p.barcode);
    }
    console.log(`  catálogo: ${skuToId.size} vivos con sku`);

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

    // map sku→pid (fallback barcode), dedup por (pid, PLAZA), decisiones de backfill, tuples staged.
    // `[NORM.3]` El dedupe era por `pid` a secas: se quedaba con una plaza y descartaba las otras
    // siete. Ahora cada tienda aporta su fila; el guard sólo protege de la misma plaza repetida.
    let matched = 0, unmatched = 0, noBarcode = 0, dupPid = 0;
    const staged = [], stagedPids = new Set(), eanPendiente = new Set();
    // Un producto puede ser reclamado por más de un SKU (el fallback por barcode). El PRIMERO se
    // queda con TODAS sus plazas; los demás se saltan enteros. Se lleva explícito en vez de
    // confiar en que las filas vengan contiguas por SKU: hoy vienen así por el `ORDER BY` del
    // cómputo, pero si alguien lo cambia, un producto terminaría con la plaza 01 de un SKU y la
    // 02 de otro — un precio que no existe en ningún lado y que nada marcaría como raro.
    const duenoDePid = new Map();
    for (const lab of labels) {
      // `[CANON.6.7]` Sólo por sku, igual que el hop-2 (ver la cabecera: el fallback por barcode sólo
      // amarraba SKUs descontinuados y pisaba el precio de productos vigentes).
      const pid = skuToId.get(lab.sku);
      if (!pid) { unmatched++; continue; }
      const dueno = duenoDePid.get(pid);
      if (dueno === undefined) duenoDePid.set(pid, lab.sku);
      else if (dueno !== lab.sku) { dupPid++; continue; }
      const clave = `${pid} ${lab.sucursal}`;
      if (stagedPids.has(clave)) { dupPid++; continue; }
      stagedPids.add(clave);
      if (!lab.barcode_format) noBarcode++;
      // `[CANON.6.19]` ¿Espera su EAN? Código actual que no es EAN, y Kepler trae en esta plaza un EAN que no tiene otro
      // producto. Sólo se MIDE aquí; lo pone `normalizeProductsFromOds` (la regla del hop-2), abajo.
      if (lab.barcode_format && !barcodeFormat(curBarcodeById.get(pid) || '') && !eansInUse.has(String(lab.barcode).trim())) {
        eanPendiente.add(lab.sku);
      }
      staged.push(toStageTuple(lab, pid));
      matched++;
    }
    console.log(`  match catálogo: ${matched} · sin match: ${unmatched} · sin barcode válido: ${noBarcode} · pid duplicado saltado: ${dupPid}`);
    const pendientes = [...eanPendiente].sort();
    console.log(`  productos que esperan su EAN (código que no es EAN y Kepler trae uno libre): ${pendientes.length}`
      + (pendientes.length ? ` — ${pendientes.slice(0, 12).join(', ')}${pendientes.length > 12 ? ', …' : ''}` : ''));
    // Los índices siguen a LABEL_STAGE_COLS: `sucursal` entró en la posición 1 y corrió todo lo
    // demás un lugar. Se leen por nombre para que el próximo cambio de columnas no los desalinee.
    const ix = (c) => LABEL_STAGE_COLS.indexOf(c);
    console.table(staged.slice(0, 6).map((s) => ({
      plaza: s[ix('sucursal')], content: s[ix('content')], barcode: s[ix('barcode')],
      fmt: s[ix('barcode_format')], pza: s[ix('piece_price')],
      may_pza: s[ix('wholesale_piece_price')], paq: s[ix('pack_price')], box: s[ix('box_price')],
    })));

    await db.query('BEGIN');
    await db.query(`SET LOCAL app.tenant_id = '${M}'`);
    // `[TDA.8]` `cambiados` recoge los product_id que REALMENTE se escribieron. El UPSERT es
    // churn-free, así que esto no son "los que se intentaron" sino "los que cambiaron" — es la
    // diferencia entre avisar 9,000 veces por corrida y avisar lo que pasó.
    const cambiados = [];
    const changed = await upsertLabels(db, M, staged, 1000, cambiados); // churn-free, source<>'manual'
    if (!APPLY) {
      // `[CANON.6.19]` La medición: lo que escribiría, escrito y REVERTIDO. Con el hop-2 sano da 0 y 0.
      await db.query('ROLLBACK');
      console.log(`\n[EN SECO] ROLLBACK — ${changed} filas de etiqueta cambiarían · ${pendientes.length} productos esperan su EAN. Corré con --apply.`);
      return;
    }
    await db.query('COMMIT');
    // `[CANON.6.19]` El EAN con la regla del hop-2 (su propia transacción), acotada a los SKU que lo esperan.
    const bcFixed = pendientes.length ? await normalizeProductsFromOds(db, M, pendientes) : 0;
    console.log(`\n[APPLY] COMMIT — ${changed} filas de etiqueta cambiadas (churn-free) · ${bcFixed} escrituras al catálogo para ${pendientes.length} productos que esperaban su EAN (la identidad y el EAN, con la regla del hop-2).`);

    // `[TDA.8]` El aviso va DESPUÉS del COMMIT: es un aviso, no el dato. Si el API no contesta, el
    // precio ya quedó guardado y las pantallas lo verán al siguiente escaneo — el comportamiento
    // de siempre. `notifyLabelPricesChanged` no lanza nunca y trae su propio timeout de 3 s.
    //
    // ⚠️ ACÁ SÍ SE ESPERA, y es la diferencia con `apply-handlers.js`, que dispara sin `await`.
    // Aquel corre dentro de un servidor vivo; ESTO es un CLI que termina: sin el `await` el
    // proceso se va antes de que el POST salga del socket y el aviso se pierde en silencio —
    // con el log diciendo que todo salió bien. Es el mismo modo de falla que la Fase OBS
    // persigue: el sistema reportando éxito sin haber entregado nada.
    // `[NORM.3]` Se deduplica: con grano por plaza el mismo producto vuelve hasta 8 veces y el
    // aviso es por PRODUCTO (cada pantalla re-consulta filtrando por SU sucursal).
    const avisar = Array.from(new Set(cambiados));
    if (avisar.length) {
      const salio = await notifyLabelPricesChanged(M, avisar, console.warn);
      console.log(
        salio
          ? `[APPLY] aviso enviado: ${avisar.length} producto(s) con precio nuevo.`
          : `[APPLY] aviso NO enviado (${avisar.length} producto(s)): las pantallas se enterarán al siguiente escaneo.`,
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
