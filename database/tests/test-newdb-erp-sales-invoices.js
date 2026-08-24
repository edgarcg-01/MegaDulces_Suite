/* eslint-disable no-console */
/**
 * Smoke AX.0 — vistas en vivo de facturas de venta (`analytics.erp_sales_invoices` / `_lines`).
 *
 * Ancla en la factura 06 UD0801-0000087 (Canindo, 2026-08-20), verificada renglón por renglón
 * contra el CFDI impreso. Si el decode de Kepler se rompe, este smoke lo caza.
 *
 *   node database/tests/test-newdb-erp-sales-invoices.js
 *   DATABASE_URL_NEW=<prod> node database/tests/test-newdb-erp-sales-invoices.js
 */
const { Client } = require('pg');

const DST = process.env.DATABASE_URL_NEW || 'postgresql://postgres:superoot@localhost:5433/postgres_platform';
const FOLIO = '06UD0801-0000087';
// Verdad verificada a mano contra el CFDI timbrado (UUID 88bbd441-aa1e-41e8-95c5-5492a5b56d44).
const ESPERADO = {
  total: 43904.54, ieps: 3024.24, descuento: 1264.34, subtotal: 42144.64,
  cliente_code: 'C3078', cliente_rfc: 'GAOC6811161K9',
  vendedor_nombre: 'DANIEL FRANCISCO FRANCO', doc_origen: 'UD4101-0000023',
  dias_credito: 6, vencimiento: '2026-08-26', // fecha 20-ago + 6 días de crédito del cliente
  lineas: 12, suma_lineas: 45262.41,
};

let ok = 0; const fallos = [];
const chk = (cond, msg) => { cond ? ok++ : fallos.push(msg); };
const num = (v) => Math.round(Number(v) * 100) / 100;

(async () => {
  const db = new Client({ connectionString: DST, ssl: /rlwy|railway|proxy/i.test(DST) ? { rejectUnauthorized: false } : false, statement_timeout: 120000 });
  await db.connect();
  console.log(`\n=== Smoke AX.0 — facturas de venta en vivo (${FOLIO}) ===\n`);

  // skip-graceful: sin las vistas (migración pendiente en esta DB) no hay nada que afirmar.
  const existen = (await db.query(`SELECT
      to_regclass('analytics.erp_sales_invoices') AS h,
      to_regclass('analytics.erp_sales_invoice_lines') AS l`)).rows[0];
  if (!existen.h || !existen.l) {
    console.log('SKIP — faltan las vistas analytics.erp_sales_invoice*; corré las migraciones (20260822140000 / 20260824120000).');
    await db.end();
    process.exit(0);
  }

  for (const v of ['erp_sales_invoices', 'erp_sales_invoice_lines']) {
    const r = (await db.query(`SELECT relkind FROM pg_class WHERE oid = to_regclass($1)`, [`analytics.${v}`])).rows[0];
    chk(r && r.relkind === 'v', `analytics.${v} debe ser VISTA (derive-no-copy), es: ${r ? r.relkind : 'no existe'}`);
  }

  // Se filtra por COLUMNAS SIMPLES, igual que el service: `folio_digital` es una expresión
  // compuesta dentro de la vista y el planner no la empuja al índice (3,031 ms vs 162 ms).
  const P = { sucursal: '06', doc_prefix: 'UD0801', folio: '0000087' };
  const t0 = Date.now();
  const h = (await db.query(`SELECT * FROM analytics.erp_sales_invoices
     WHERE sucursal=$1 AND doc_prefix=$2 AND folio=$3`, [P.sucursal, P.doc_prefix, P.folio])).rows[0];
  const msHdr = Date.now() - t0;
  chk(!!h, `no encontré la cabecera ${FOLIO}`);
  if (h) {
    chk(num(h.total) === ESPERADO.total, `total ${h.total} ≠ ${ESPERADO.total}`);
    chk(num(h.ieps) === ESPERADO.ieps, `ieps ${h.ieps} ≠ ${ESPERADO.ieps}`);
    chk(num(h.descuento) === ESPERADO.descuento, `descuento ${h.descuento} ≠ ${ESPERADO.descuento}`);
    chk(num(h.subtotal) === ESPERADO.subtotal, `subtotal ${h.subtotal} ≠ ${ESPERADO.subtotal}`);
    chk(h.cliente_code === ESPERADO.cliente_code, `cliente ${h.cliente_code}`);
    chk(h.cliente_rfc === ESPERADO.cliente_rfc, `rfc ${h.cliente_rfc}`);
    chk(h.vendedor_nombre === ESPERADO.vendedor_nombre, `vendedor ${h.vendedor_nombre}`);
    chk(h.doc_origen === ESPERADO.doc_origen, `pedido origen ${h.doc_origen}`);
    chk(Number(h.dias_credito) === ESPERADO.dias_credito, `dias_credito ${h.dias_credito} ≠ ${ESPERADO.dias_credito}`);
    // el driver devuelve Date → formatear en LOCAL (la fecha viene sin tz; toISOString la correría un día)
    const venc = h.vencimiento instanceof Date
      ? `${h.vencimiento.getFullYear()}-${String(h.vencimiento.getMonth() + 1).padStart(2, '0')}-${String(h.vencimiento.getDate()).padStart(2, '0')}`
      : String(h.vencimiento).slice(0, 10);
    chk(venc === ESPERADO.vencimiento, `vencimiento ${venc} ≠ ${ESPERADO.vencimiento}`);
    chk(h.doc_tipo === 'telemarketing', `doc_tipo ${h.doc_tipo}`);
    chk(!!h.warehouse_id, 'warehouse_id sin resolver');
    // subtotal + ieps − descuento debe reconstruir el total (cuadre fiscal del CFDI)
    chk(num(Number(h.subtotal) + Number(h.ieps) - Number(h.descuento)) === ESPERADO.total, 'no cuadra subtotal+IEPS−desc = total');
  }

  const t1 = Date.now();
  const l = (await db.query(`SELECT * FROM analytics.erp_sales_invoice_lines
     WHERE sucursal=$1 AND doc_prefix=$2 AND folio=$3 ORDER BY linea`, [P.sucursal, P.doc_prefix, P.folio])).rows;
  const msLin = Date.now() - t1;
  chk(l.length === ESPERADO.lineas, `líneas ${l.length} ≠ ${ESPERADO.lineas}`);
  chk(num(l.reduce((a, r) => a + Number(r.importe), 0)) === ESPERADO.suma_lineas, `Σ líneas ${l.reduce((a, r) => a + Number(r.importe), 0)} ≠ ${ESPERADO.suma_lineas}`);
  chk(l.every((r) => Number(r.cantidad) > 0), 'hay líneas con cantidad 0');
  chk(l.every((r) => r.unidad !== 'SER'), 'se coló una línea de SERVICIO');
  // cada importe debe ser cantidad × precio (evita que un cambio de decode desalinee columnas)
  chk(l.every((r) => Math.abs(Number(r.cantidad) * Number(r.precio_unitario) - Number(r.importe)) < 0.02),
    'alguna línea no cumple importe = cantidad × precio');
  // factores conocidos del catálogo (verificados): Doritos 5/caja, Pal Piña 24, Gansito 12
  const f = Object.fromEntries(l.map((r) => [r.sku, r.factor_caja === null ? null : Number(r.factor_caja)]));
  chk(f['87231'] === 5 && f['97127'] === 24 && f['78229'] === 12, `factores de caja: ${JSON.stringify({ d: f['87231'], p: f['97127'], g: f['78229'] })}`);
  chk(f['97040'] === null, 'SKU 97040 no debe traer factor (no está capturado en el catálogo)');
  // ── unidades VERBATIM de Kepler (mig 20260824120000) ──────────────────────────────────────
  // Regla 2026-08-24: cero unidades inventadas. La vista es passthrough de kdm2.c11 (unidad de
  // la línea) y kdii.c11/c83 (unidad de venta y bulto del catálogo). Este bloque compara la
  // vista contra las columnas CRUDAS: si alguien vuelve a meter un mapeo/traducción, revienta.
  const tieneUnidades = l.length > 0 && 'unidad_venta' in l[0] && 'unidad_bulto' in l[0];
  chk(tieneUnidades, 'faltan unidad_venta/unidad_bulto — ¿se aplicó la mig 20260824120000?');
  if (tieneUnidades) {
    const crudo = (await db.query(`
      SELECT (li.c7)::int AS linea, btrim(li.c8::text) AS sku,
        NULLIF(btrim(li.c11::text),'') AS unidad,
        NULLIF(btrim(k.c11::text),'')  AS unidad_venta,
        NULLIF(btrim(k.c83::text),'')  AS unidad_bulto,
        NULLIF(coalesce(nullif(regexp_replace(k.c84::text,'[^0-9.]','','g'),'')::numeric,0),0) AS factor_caja
      FROM kepler_ods.kdm2 li
      LEFT JOIN kepler_ods.kdii k
        ON btrim(k.sucursal)=btrim(li.sucursal) AND btrim(k.c1::text)=btrim(li.c8::text)
      WHERE btrim(li.sucursal)=$1 AND li.c2='U' AND li.c3='D' AND (li.c4)::int=8 AND (li.c5)::int=1
        AND btrim(li.c6::text)=$2
        AND coalesce(btrim(li.c11::text),'')<>'SER' AND abs(coalesce((li.c9)::numeric,0))>0`,
      [P.sucursal, P.folio])).rows;
    chk(crudo.length === l.length, `crudo ${crudo.length} líneas vs vista ${l.length}`);
    const S = (v) => (v === null || v === undefined ? null : String(v));
    const N = (v) => (v === null || v === undefined ? null : Number(v));
    const difs = [];
    for (const c of crudo) {
      const v = l.find((x) => Number(x.linea) === Number(c.linea));
      if (!v) { difs.push(`L${c.linea} ausente en la vista`); continue; }
      for (const campo of ['unidad', 'unidad_venta', 'unidad_bulto']) {
        if (S(v[campo]) !== S(c[campo])) difs.push(`L${c.linea} ${c.sku} ${campo}: vista=${v[campo]} ≠ Kepler=${c[campo]}`);
      }
      if (N(v.factor_caja) !== N(c.factor_caja)) difs.push(`L${c.linea} ${c.sku} factor: vista=${v.factor_caja} ≠ kdii.c84=${c.factor_caja}`);
    }
    chk(difs.length === 0, `unidades/factor NO coinciden con Kepler crudo → ${difs.slice(0, 4).join(' | ')}`);
    // anclas conocidas del catálogo (por si el crudo cambiara de sucursal/SKU)
    const uu = Object.fromEntries(l.map((r) => [r.sku, [r.unidad_venta, r.unidad_bulto]]));
    chk(uu['97127'] && uu['97127'][0] === 'PAQ' && uu['97127'][1] === 'CJA', 'SKU 97127 debe traer venta=PAQ bulto=CJA (kdii)');
    chk(uu['97040'] && uu['97040'][1] === null, 'SKU 97040 sin bulto en kdii → unidad_bulto NULL');
    // la vista NO puede acuñar unidades: todo código que sale debe existir crudo en kdm2.c11
    const crudoUn = new Set(crudo.map((c) => S(c.unidad)));
    chk(l.every((r) => crudoUn.has(S(r.unidad))), 'la vista trae unidades que no existen en kdm2.c11');
  }

  // U/D/13 es factura de traspaso CEDIS (puro servicio) — no debe aparecer nunca
  const t13 = (await db.query(`SELECT count(*)::int n FROM analytics.erp_sales_invoices WHERE doc_prefix LIKE 'UD13%'`)).rows[0].n;
  chk(t13 === 0, `se colaron ${t13} documentos U/D/13 (traspaso CEDIS, sin producto)`);

  console.log(`  cabecera ${msHdr} ms · líneas ${msLin} ms`);
  if (msHdr > 1500 || msLin > 1500) console.log('  ⚠ lento: ¿se aplicó la migración de índices 20260822140100?');
  console.log(`\n${fallos.length ? '⚠' : '✅'} ${ok} checks OK · ${fallos.length} fallos`);
  fallos.forEach((f2) => console.log('   ✗ ' + f2));
  await db.end();
  process.exit(fallos.length ? 1 : 0);
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
