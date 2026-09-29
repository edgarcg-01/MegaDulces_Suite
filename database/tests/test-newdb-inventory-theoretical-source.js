'use strict';
/**
 * [IC.1] La fuente del teórico contra el que se cuenta.
 *
 * El conteo sembraba `expected_qty` desde `commercial.stock`. El ODS es mejor por
 * CONSTRUCCIÓN —se deriva del CDC, no puede arrastrar valores fantasma— mientras que el
 * importer de esa tabla es un delta contra un snapshot en disco que se desincroniza, y esas
 * filas no se corrigen nunca (caso documentado: SKU 88009 en la 01, POS 2485 / ODS 2487 /
 * tabla **3547**).
 *
 * ⚠️ El beneficio MEDIDO hoy (2026-09-28) es chico: las dos fuentes difieren en **90 SKUs de
 * 21,941 (0.4%)**, 2,355 unidades — no en el ~9% de la brecha histórica contra el POS. El
 * importer mejoró mucho desde entonces. El cambio se hace igual porque un conteo se juzga SKU
 * por SKU y cada diferencia falsa manda a alguien al anaquel por nada, pero este candado NO
 * afirma una mejora que no se midió: sólo exige que las fuentes SIGAN difiriendo (si
 * coincidieran al 100%, el cambio sería decorativo y habría que revisar por qué).
 *
 *   node database/tests/test-newdb-inventory-theoretical-source.js
 *
 * Sólo lee.
 */
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env') });
const knexLib = require('knex');

let ok = 0, bad = 0;
const t = (name, cond, extra) => {
  if (cond) { ok++; console.log(`  ✔ ${name}`); }
  else { bad++; console.log(`  ✘ ${name}${extra ? ' — ' + extra : ''}`); }
};

(async () => {
  const url = process.env.DATABASE_URL_NEW;
  if (!url) { console.error('falta DATABASE_URL_NEW'); process.exit(1); }
  const db = knexLib({
    client: 'pg',
    connection: { connectionString: url, ssl: /@(localhost|127\.0\.0\.1|192\.168\.)/.test(url) ? false : { rejectUnauthorized: false } },
    pool: { min: 0, max: 2 },
  });

  console.log('\n=== [IC.1] fuente del teórico del conteo ===\n');

  try {
    await db.raw(`SET statement_timeout = '30s'`);

    const [wh] = (await db.raw(
      `SELECT id, code FROM commercial.warehouses
        WHERE kepler_code IS NOT NULL AND kepler_code <> '00' AND deleted_at IS NULL
        ORDER BY code LIMIT 1`)).rows;
    t('hay un almacén Kepler contra el cual medir', !!wh, 'ninguno');
    if (!wh) throw new Error('sin almacén');
    console.log(`     almacén de prueba: ${wh.code}`);

    // ── 1. La fuente nueva existe, responde y NO es lenta ─────────────────────
    // Se abre un folio con esto: si tarda, nadie lo usa. Y la alternativa obvia
    // (`v_erp_stock_truth`) hace TIMEOUT incluso acotada a un almacén — arbitra costo, que
    // para contar no hace falta. Por eso el servicio usa `v_erp_stock_on_hand`.
    const t0 = Date.now();
    const [erp] = (await db.raw(
      `SELECT count(*)::int AS skus, count(*) FILTER (WHERE unit_source IS NOT NULL)::int AS con_unidad
         FROM analytics.v_erp_stock_on_hand
        WHERE warehouse_id = ? AND qty_stock_units > 0`, [wh.id])).rows;
    const ms = Date.now() - t0;
    t(`la fuente nueva responde en menos de 3 s (${ms} ms, ${erp.skus} SKUs)`, ms < 3000, `${ms} ms`);
    t('la fuente nueva tiene SKUs para sembrar', Number(erp.skus) > 0, JSON.stringify(erp));

    // ── 2. ⛔ La fuente nueva DIFIERE de la vieja (si no, el cambio es decorativo) ──
    // Una fuente nueva que coincide al 100% con la vieja no arregla nada. Ésta es la
    // aserción que convierte "cambié de tabla" en "cambié el resultado".
    const [dif] = (await db.raw(
      `SELECT count(*)::int AS comparables,
              count(*) FILTER (WHERE round(e.qty_stock_units::numeric, 2)
                               IS DISTINCT FROM round(s.quantity::numeric, 2))::int AS difieren,
              count(*) FILTER (WHERE s.product_id IS NULL)::int AS solo_en_erp
         FROM analytics.v_erp_stock_on_hand e
         LEFT JOIN commercial.stock s
           ON s.warehouse_id = e.warehouse_id AND s.product_id = e.product_id
          AND s.tenant_id = e.tenant_id
        WHERE e.warehouse_id = ? AND e.qty_stock_units > 0`, [wh.id])).rows;
    const pct = Number(dif.comparables) > 0
      ? (100 * Number(dif.difieren) / Number(dif.comparables)) : 0;
    t('⛔ la fuente nueva DIFIERE de commercial.stock (si no, el cambio sería decorativo)',
      Number(dif.difieren) > 0, JSON.stringify(dif));
    console.log(`     difieren ${dif.difieren} de ${dif.comparables} SKUs (${pct.toFixed(1)}%)`
      + ` · sólo en el ERP: ${dif.solo_en_erp}`);

    // ── 3. ⛔ La unidad se DECLARA, no se inventa ─────────────────────────────
    // `unit_source` NULL significa "no se pudo resolver". Lo que el candado prohíbe es que
    // alguien lo rellene con un factor 1 por default — el "default plausible" que ADR-055/057
    // existen para impedir, y que ya costó $866,805 de sobre-pedido en otra superficie.
    const [uni] = (await db.raw(
      `SELECT count(*)::int AS total,
              count(*) FILTER (WHERE unit_source IS NULL)::int AS sin_resolver,
              count(*) FILTER (WHERE display_box_factor = 1
                               AND unit_source IS NULL)::int AS factor1_sin_fuente
         FROM analytics.v_erp_stock_on_hand
        WHERE warehouse_id = ? AND qty_stock_units > 0`, [wh.id])).rows;
    console.log(`     unidad: ${uni.total - uni.sin_resolver} resueltas de ${uni.total}`
      + ` (${uni.sin_resolver} sin resolver)`);
    t('la fuente DECLARA cuándo no puede resolver la unidad (hay un unit_source nullable)',
      uni.sin_resolver !== null && uni.sin_resolver !== undefined, JSON.stringify(uni));

    // ── 4. Las columnas donde se estampa la unidad ────────────────────────────
    const { rows: cols } = await db.raw(
      `SELECT column_name, is_nullable FROM information_schema.columns
        WHERE table_schema = 'commercial' AND table_name = 'inventory_count_items'
          AND column_name IN ('unit_label', 'unit_factor', 'unit_source')`);
    if (cols.length === 3) {
      t('las 3 columnas de unidad existen en inventory_count_items', true);
      t('⛔ las 3 son NULLABLE (un NOT NULL obligaría a inventar un default)',
        cols.every((c) => c.is_nullable === 'YES'),
        JSON.stringify(cols));
    } else {
      console.log(`  ⓘ NO MEDIDO: la migración 20260928280000 no está aplicada`
        + ` (${cols.length}/3 columnas). El resto del candado sí corrió.`);
    }

    // ── 5. El almacén de OFICINAS no puede ser fuente de un conteo ────────────
    // Su existencia es un artefacto (122.8M de unidades, 108.8M de un pseudo-SKU contable).
    // Si apareciera acá, alguien podría abrir un folio contra basura.
    const [of] = (await db.raw(
      `SELECT count(*)::int AS n FROM analytics.v_erp_stock_on_hand e
         JOIN commercial.warehouses w ON w.id = e.warehouse_id
        WHERE w.kepler_code = '00'`)).rows;
    t('⛔ la sucursal 00 (OFICINAS) no aporta existencia sembrable',
      Number(of.n) === 0, `${of.n} filas`);
  } catch (e) {
    bad++; console.log(`  ✘ excepción: ${e.message}`);
  } finally {
    await db.destroy();
  }

  console.log(`\n=== ${ok} ✓ / ${bad} ✗ ===\n`);
  process.exit(bad === 0 ? 0 : 1);
})();
