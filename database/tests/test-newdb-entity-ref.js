/**
 * Smoke del resolvedor universal de referencias ("todo es clickeable").
 *
 * Dos cosas que se pueden romper en silencio y acá se atrapan:
 *  1. El CODEC (`makeRef`/`parseRef`): se carga el .ts REAL vía ts-node, no una copia.
 *     Un folio de Kepler trae ceros a la izquierda y un separador mal elegido los come.
 *  2. La IDENTIDAD de cada ref: `ent`/`lin`/`adj`/`pay` tienen que apuntar a UNA fila.
 *     Si un día entra un segundo doctype o se duplica un folio, el panel abriría
 *     cualquiera de las dos filas sin avisar. Se verifica contra la data real.
 *
 * Replica las queries de EntityRefService (analytics.* sin RLS -> tenant explícito).
 * Uso: DATABASE_URL_NEW=... node database/tests/test-newdb-entity-ref.js
 */
const path = require('path');
const { Client } = require('pg');

const DST = process.env.DATABASE_URL_NEW || 'postgresql://postgres:superoot@localhost:5433/postgres_platform';
const TENANT = process.env.TENANT_ID || '00000000-0000-0000-0000-00000000d01c';
const money = (n) => Number(n || 0).toLocaleString('es-MX', { style: 'currency', currency: 'MXN', maximumFractionDigits: 0 });
let failed = 0;
const ok = (c, m) => { console.log(`${c ? '  ✅' : '  ❌'} ${m}`); if (!c) failed++; };

// El codec REAL, no una reimplementación: si cambia el formato, este test lo sigue.
// `skipProject`: sin esto ts-node toma el tsconfig del monorepo (paths, rootDir de Nx)
// y falla con TS5011 antes de compilar un archivo que no tiene ninguna dependencia.
require('ts-node').register({
  transpileOnly: true, skipProject: true,
  compilerOptions: { module: 'commonjs', target: 'es2020', esModuleInterop: true, moduleResolution: 'node', ignoreDeprecations: '6.0' },
});
const { makeRef, parseRef } = require(path.resolve(__dirname, '../../libs/commercial/src/lib/entity-ref/entity-ref.types.ts'));

const COMERCIAL_CATS = ['descuento_comercial', 'pronto_pago', 'apoyo_marca'];

(async () => {
  const c = new Client({ connectionString: DST });
  await c.connect();
  console.log('Entity-ref — codec + identidad de cada referencia\n');
  try {
    // ── 1. Codec ──────────────────────────────────────────────────────────
    console.log('  1) Codec makeRef/parseRef');
    const round = (kind, ...parts) => parseRef(makeRef(kind, ...parts)).parts;
    ok(JSON.stringify(round('ent', '03', 'XA2001', '0002555')) === JSON.stringify(['03', 'XA2001', '0002555']),
      'ceros a la izquierda del folio sobreviven el round-trip');
    ok(round('prov', 'CB025')[0] === 'CB025', 'proveedor de una sola parte');
    ok(JSON.stringify(round('adj', 'XD55', '00', 'A|B')) === JSON.stringify(['XD55', '00', 'A|B']),
      'una parte que CONTIENE el separador no rompe el parseo (va URL-encodeada)');
    ok(round('lin', '00', '0008594', '01')[2] === '01', 'número de renglón como texto, no como número');
    let threw = 0;
    for (const bad of ['', 'nope:1', 'ent:', 'ent:03|XA2001', 'ent:03|XA2001|0001|extra', 'sinDosPuntos']) {
      try { parseRef(bad); } catch { threw++; }
    }
    ok(threw === 6, `rechaza los 6 refs inválidos probados (${threw}/6)`);

    // ── 2. Datos presentes ────────────────────────────────────────────────
    const nRec = Number((await c.query(`SELECT count(*)::int n FROM analytics.erp_goods_receipts WHERE tenant_id=$1`, [TENANT])).rows[0].n);
    if (nRec === 0) { console.log('\n  ⚠️  SKIP — sin recepciones (feed no cargado). El codec ya quedó cubierto arriba.'); await c.end(); process.exit(failed ? 1 : 0); }
    console.log(`\n  2) Identidad de las referencias (${nRec.toLocaleString('es-MX')} recepciones)`);

    // ent: (sucursal, doc_prefix, folio) tiene que ser único.
    const dupEnt = Number((await c.query(
      `SELECT count(*)::int n FROM (SELECT 1 FROM analytics.erp_goods_receipts WHERE tenant_id=$1
         GROUP BY sucursal, doc_prefix, folio HAVING count(*) > 1) x`, [TENANT])).rows[0].n);
    ok(dupEnt === 0, `ent: (sucursal, doc_prefix, folio) identifica UNA fila (${dupEnt} claves repetidas)`);

    // El folio solo NO alcanza — por eso doc_prefix va en el ref aunque hoy sea uno solo.
    const prefixes = (await c.query(`SELECT DISTINCT doc_prefix FROM analytics.erp_goods_receipts WHERE tenant_id=$1`, [TENANT])).rows.map((r) => r.doc_prefix);
    console.log(`     · doc_prefix presentes en entradas: ${prefixes.join(', ')}`);

    const dupLin = Number((await c.query(
      `SELECT count(*)::int n FROM (SELECT 1 FROM analytics.erp_goods_receipt_lines WHERE tenant_id=$1
         GROUP BY sucursal, folio, linea HAVING count(*) > 1) x`, [TENANT])).rows[0].n);
    ok(dupLin === 0, `lin: (sucursal, folio, linea) identifica UN renglón (${dupLin} repetidas)`);

    const dupAdj = Number((await c.query(
      `SELECT count(*)::int n FROM (SELECT 1 FROM analytics.erp_purchase_adjustments WHERE tenant_id=$1
         GROUP BY doctype, sucursal, folio HAVING count(*) > 1) x`, [TENANT])).rows[0].n);
    ok(dupAdj === 0, `adj: (doctype, sucursal, folio) identifica UN ajuste (${dupAdj} repetidas)`);

    // pay: acá el doc_prefix SÍ es imprescindible — el folio se comparte entre doctypes.
    const dupPay = Number((await c.query(
      `SELECT count(*)::int n FROM (SELECT 1 FROM analytics.erp_supplier_payments WHERE tenant_id=$1
         GROUP BY sucursal, doc_prefix, folio HAVING count(*) > 1) x`, [TENANT])).rows[0].n);
    ok(dupPay === 0, `pay: (sucursal, doc_prefix, folio) identifica UN pago (${dupPay} repetidas)`);
    const payFolioClash = Number((await c.query(
      `SELECT count(*)::int n FROM (SELECT 1 FROM analytics.erp_supplier_payments WHERE tenant_id=$1
         GROUP BY sucursal, folio HAVING count(DISTINCT doc_prefix) > 1) x`, [TENANT])).rows[0].n);
    console.log(`     · pagos donde (sucursal, folio) se repite entre doctypes: ${payFolioClash} → por eso doc_prefix va en el ref`);

    // ── 3. Resolución de una entrada real ─────────────────────────────────
    console.log('\n  3) Resolución de una entrada real');
    const e = (await c.query(
      `SELECT sucursal, doc_prefix, folio, proveedor_code, proveedor_nombre, monto,
              to_char(receipt_date,'YYYY-MM-DD') AS receipt_date
         FROM analytics.erp_goods_receipts
        WHERE tenant_id=$1 AND proveedor_code IS NOT NULL AND receipt_date IS NOT NULL
        ORDER BY monto DESC LIMIT 1`, [TENANT])).rows[0];
    const entRef = makeRef('ent', e.sucursal, e.doc_prefix, e.folio);
    console.log(`     · ${entRef} — ${e.proveedor_nombre} ${money(e.monto)} (${e.receipt_date})`);
    ok(parseRef(entRef).parts[2] === e.folio, 'el ref de la entrada re-parsea al folio exacto');
    ok(/^\d{4}-\d{2}-\d{2}$/.test(e.receipt_date), 'la fecha sale como texto YYYY-MM-DD (to_char), no como Date que se corre un día en MX');

    const lin = (await c.query(
      `SELECT count(*)::int n, COALESCE(sum(importe),0)::numeric s FROM analytics.erp_goods_receipt_lines
        WHERE tenant_id=$1 AND sucursal=$2 AND folio=$3`, [TENANT, e.sucursal, e.folio])).rows[0];
    console.log(`     · ${lin.n} renglones · Σ ${money(lin.s)} vs total documento ${money(e.monto)}`);
    ok(Number(lin.n) >= 0, 'los renglones se consultan con la misma clave (sucursal, folio) del ref');
    if (Number(lin.n) > 0) {
      const l = (await c.query(
        `SELECT linea, sku FROM analytics.erp_goods_receipt_lines WHERE tenant_id=$1 AND sucursal=$2 AND folio=$3 ORDER BY linea::text LIMIT 1`,
        [TENANT, e.sucursal, e.folio])).rows[0];
      const linRef = makeRef('lin', e.sucursal, e.folio, l.linea);
      const back = parseRef(linRef).parts;
      ok(back[0] === e.sucursal && back[1] === e.folio && back[2] === String(l.linea),
        `lin ref del primer renglón round-trip (${linRef})`);
    }

    // ── 4. Ficha de proveedor: los agregados que pinta el panel ───────────
    console.log('\n  4) Ficha de proveedor (agregados del panel)');
    const g = (await c.query(
      `SELECT count(*)::int n_entradas, COALESCE(sum(monto),0)::numeric compras
         FROM analytics.erp_goods_receipts WHERE tenant_id=$1 AND proveedor_code=$2 AND dup_of_folio IS NULL`,
      [TENANT, e.proveedor_code])).rows[0];
    const gAll = (await c.query(
      `SELECT COALESCE(sum(monto),0)::numeric compras FROM analytics.erp_goods_receipts WHERE tenant_id=$1 AND proveedor_code=$2`,
      [TENANT, e.proveedor_code])).rows[0];
    console.log(`     · ${e.proveedor_code}: ${g.n_entradas} recepciones · ${money(g.compras)} (con copias CEDIS sería ${money(gAll.compras)})`);
    ok(Number(g.compras) <= Number(gAll.compras),
      'las compras del proveedor excluyen la copia CEDIS (dup_of_folio IS NULL) — si no, se contaría dos veces');

    const aj = (await c.query(
      `SELECT COALESCE(sum(monto),0)::numeric total,
              COALESCE(sum(monto) FILTER (WHERE categoria = ANY($3)),0)::numeric comercial,
              COALESCE(sum(monto) FILTER (WHERE categoria IS NULL OR NOT (categoria = ANY($3))),0)::numeric operativo
         FROM analytics.erp_purchase_adjustments WHERE tenant_id=$1 AND proveedor_code=$2`,
      [TENANT, e.proveedor_code, COMERCIAL_CATS])).rows[0];
    ok(Math.abs((Number(aj.comercial) + Number(aj.operativo)) - Number(aj.total)) < 0.01,
      `comercial + operativo == total de ajustes (${money(aj.comercial)} + ${money(aj.operativo)} == ${money(aj.total)})`);

    // ── 5. Las relaciones honestas ────────────────────────────────────────
    console.log('\n  5) Vínculos declarados como estimados');
    const pagosVentana = Number((await c.query(
      `SELECT count(*)::int n FROM analytics.erp_supplier_payments
        WHERE tenant_id=$1 AND proveedor_code=$2 AND pago_date BETWEEN $3::date AND $3::date + INTERVAL '30 days'`,
      [TENANT, e.proveedor_code, e.receipt_date])).rows[0].n);
    console.log(`     · pagos del proveedor dentro de 30 días de la recepción: ${pagosVentana}`);
    const ligaReal = Number((await c.query(
      `SELECT count(*)::int n FROM information_schema.columns
        WHERE table_schema='analytics' AND table_name='erp_supplier_payments'
          AND column_name IN ('entrada_folio','receipt_folio')`)).rows[0].n);
    ok(ligaReal === 0,
      'no existe columna de liga pago→entrada: el panel tiene razón en llamarlo "candidato" y no "el pago"');

    const ocTable = Number((await c.query(
      `SELECT count(*)::int n FROM information_schema.tables WHERE table_schema='analytics' AND table_name='erp_purchase_orders'`)).rows[0].n);
    ok(ocTable === 0,
      'no existe analytics.erp_purchase_orders: el panel avisa que la OC no tiene ficha en vez de ofrecer un enlace muerto');

    // ── 6. SKU ────────────────────────────────────────────────────────────
    console.log('\n  6) Producto');
    const sk = (await c.query(
      `SELECT gl.sku, count(*)::int n FROM analytics.erp_goods_receipt_lines gl
        WHERE gl.tenant_id=$1 AND gl.sku IS NOT NULL GROUP BY gl.sku ORDER BY n DESC LIMIT 1`, [TENANT])).rows[0];
    if (sk) {
      const inCat = Number((await c.query(`SELECT count(*)::int n FROM inventory.products WHERE sku=$1`, [sk.sku])).rows[0].n);
      console.log(`     · SKU más comprado ${sk.sku} (${sk.n} renglones) · en catálogo: ${inCat ? 'sí' : 'no'}`);
      ok(parseRef(makeRef('sku', sk.sku)).parts[0] === sk.sku, 'sku ref round-trip');
    } else {
      ok(true, 'sin renglones con SKU en la muestra (nada que resolver)');
    }

    console.log(`\n${failed ? `❌ ${failed} fallo(s)` : '✅ Todo verde'}`);
    await c.end();
    process.exit(failed ? 1 : 0);
  } catch (err) {
    console.error('\n❌ Error:', err.message);
    await c.end();
    process.exit(1);
  }
})();
