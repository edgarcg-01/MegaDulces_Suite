/**
 * `[AB.41]` LOS PRODUCTOS DE «LO QUE TE VA A LLEGAR» — el SQL exacto del servicio, contra prod, SÓLO LECTURA.
 *
 * Toma de `autoabasto-pedido.service.ts` el texto de `VIENE_RENGLONES_SQL` (pedido / embarque de Kepler) y
 * `REQ_RENGLONES_SQL` (requisición de la Suite), con la ventana de `ya-pedido-sucursal.ts`, y comprueba:
 *   1. Un embarque real sin recibir: devuelve sus productos y la suma en base cuadra con `kdm2.c9` leída
 *      aparte (testigo independiente, sin el SQL del servicio).
 *   2. Un pedido abierto real: igual.
 *   3. ⛔ ALCANCE: el mismo folio pedido desde OTRA sucursal devuelve cero renglones.
 *   4. Una requisición de la Suite: sus productos; ⛔ desde otro almacén, cero.
 *   5. Cada consulta tarda menos de 300 ms.
 * Sin documentos con qué probar: NO MEDIDO, nunca ✔.
 *
 * Uso: node database/tests/test-newdb-autoabasto-viene-renglones.js
 */
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');
try { require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env'), quiet: true }); } catch { /* opcional */ }

const T = '00000000-0000-0000-0000-00000000d01c';
const LIB = path.join(__dirname, '..', '..', 'libs', 'commercial', 'src', 'lib', 'commercial-replenishment');
let pass = 0, fail = 0, nm = 0;
const ok = (c, m, extra) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m, extra !== undefined ? JSON.stringify(extra) : ''); } };
const noMedido = (m) => { nm++; console.log('  ·  NO MEDIDO —', m); };

const svc = fs.readFileSync(path.join(LIB, 'autoabasto-pedido.service.ts'), 'utf8');
const ya = fs.readFileSync(path.join(LIB, 'ya-pedido-sucursal.ts'), 'utf8');
const ventana = Number((ya.match(/export const VENTANA_VIENE_DIAS = (\d+);/) || [])[1]);
const constante = (nombre) => {
  const m = svc.match(new RegExp(`const ${nombre} = \`([\\s\\S]*?)\`;`));
  if (!m) throw new Error(`no encontré ${nombre}`);
  return m[1].replace(/\$\{VENTANA_VIENE_DIAS\}/g, String(ventana));
};
/** Los parámetros con nombre de knex (`:t`) a posicionales de pg, sin tocar los `::cast`. */
function posicional(sql, binds) {
  const vals = [];
  const idx = {};
  const texto = sql.replace(/(?<!:):(?!:)([a-z_]+)\b/g, (_, n) => {
    if (!(n in binds)) throw new Error(`falta el parámetro :${n}`);
    if (!(n in idx)) { vals.push(binds[n]); idx[n] = vals.length; }
    return `$${idx[n]}`;
  });
  return { texto, vals };
}

(async () => {
  if (!(ventana > 0)) throw new Error('no encontré VENTANA_VIENE_DIAS');
  const VIENE = constante('VIENE_RENGLONES_SQL');
  const REQ = constante('REQ_RENGLONES_SQL');
  const c = new Client({ connectionString: process.env.DATABASE_URL_NEW });
  await c.connect();
  const correr = async (sql, binds) => {
    const { texto, vals } = posicional(sql, binds);
    const t0 = Date.now();
    const r = await c.query(texto, vals);
    return { rows: r.rows, ms: Date.now() - t0 };
  };
  try {
    await c.query('BEGIN READ ONLY');
    await c.query("SELECT set_config('app.tenant_id', $1, true)", [T]);
    console.log('  base', (await c.query('SELECT system_identifier::text s FROM pg_control_system()')).rows[0].s);

    // Un documento real por tipo, con su sucursal destino (por el cliente de traspaso).
    const muestra = async (doctype) => (await c.query(`
      SELECT cat.suc_code, btrim(h.sucursal) AS origen, (h.c5)::int AS serie, btrim(h.c6::text) AS folio, h.sucursal AS s_raw, h.c2, h.c3, h.c4, h.c5, h.c6
        FROM kepler_ods.kdm1 h
        JOIN analytics.v_erp_branch_catalog cat ON cat.tenant_id = $1 AND cat.dest_code = btrim(h.c10::text)
       WHERE h.c2 = 'U' AND h.c3 = 'D' AND (h.c4)::int = $2 AND btrim(h.c1) = btrim(h.sucursal)
         AND h.c9 >= current_date - 7 AND btrim(COALESCE(h.c43, '')) <> 'C'
         AND EXISTS (SELECT 1 FROM kepler_ods.kdm2 x WHERE x.sucursal = h.sucursal AND x.c2 = h.c2 AND x.c3 = h.c3 AND x.c4 = h.c4
                       AND x.c5 = h.c5 AND x.c6 = h.c6 AND btrim(x.c1) = btrim(x.sucursal) AND NULLIF(btrim(x.c8::text), '') IS NOT NULL)
       ORDER BY h.c9 DESC LIMIT 1`, [T, doctype])).rows[0];
    // El testigo: la base sumada directo de kdm2 (versión vigente = la de esa fila de kdm1).
    const testigo = async (d) => (await c.query(`
      SELECT count(DISTINCT btrim(x.c8::text))::int AS skus, COALESCE(sum(NULLIF(btrim(x.c9::text), '')::numeric), 0)::numeric AS base
        FROM kepler_ods.kdm2 x
       WHERE x.sucursal = $1 AND x.c2 = $2 AND x.c3 = $3 AND x.c4 = $4 AND x.c5 = $5 AND x.c6 = $6
         AND btrim(x.c1) = btrim(x.sucursal) AND NULLIF(btrim(x.c8::text), '') IS NOT NULL`,
    [d.s_raw, d.c2, d.c3, d.c4, d.c5, d.c6])).rows[0];
    const otraSuc = async (suc) => (await c.query(
      'SELECT suc_code FROM analytics.v_erp_branch_catalog WHERE tenant_id = $1 AND suc_code <> $2 ORDER BY suc_code LIMIT 1', [T, suc])).rows[0]?.suc_code;

    for (const [doctype, nombre] of [[41, 'embarque'], [40, 'pedido']]) {
      console.log(`\n  ${doctype === 41 ? '1' : '2'} · un ${nombre} real`);
      const d = await muestra(doctype);
      if (!d) { noMedido(`no hay ${nombre}s de traspaso en los últimos 7 días`); continue; }
      const binds = { t: T, suc: d.suc_code, doctype, origen: d.origen, serie: d.serie, folio: d.folio };
      const r = await correr(VIENE, binds);
      const w = await testigo(d);
      const skus = new Set(r.rows.map((x) => x.sku)).size;
      const base = r.rows.reduce((s, x) => s + Number(x.cantidad_base || 0), 0);
      ok(r.rows.length > 0 && skus === w.skus && Math.abs(base - Number(w.base)) < 1e-6,
        `${nombre} ${d.origen}→${d.suc_code} folio ${d.folio}: ${skus} productos, ${base} en base = testigo ${w.skus} / ${Number(w.base)}`);
      ok(r.ms < 300, `tarda ${r.ms} ms`);
      const sinNombre = r.rows.filter((x) => !x.nombre).length;
      console.log(`     ${r.rows.filter((x) => x.cantidad == null).length} sin presentación capturada · ${sinNombre} sin nombre en el catálogo`);

      console.log(`  3 · ⛔ alcance del ${nombre}`);
      const otra = await otraSuc(d.suc_code);
      if (!otra) noMedido('no hay otra sucursal con cliente de traspaso');
      else {
        const ajeno = await correr(VIENE, { ...binds, suc: otra });
        ok(ajeno.rows.length === 0, `el mismo folio pedido desde ${otra}: ${ajeno.rows.length} renglones (debe ser 0)`);
      }
    }

    console.log('\n  4 · una requisición de la Suite');
    const q = (await c.query(`
      SELECT r.id, r.warehouse_id, count(*)::int AS n
        FROM commercial.purchase_requisitions r
        JOIN commercial.purchase_requisition_lines l ON l.requisition_id = r.id AND l.tenant_id = r.tenant_id
       WHERE r.tenant_id = $1 AND COALESCE(l.final_qty, 0) > 0
       GROUP BY r.id, r.warehouse_id, r.created_at ORDER BY r.created_at DESC LIMIT 1`, [T])).rows[0];
    if (!q) noMedido('no hay requisiciones con renglones');
    else {
      const r = await correr(REQ, { t: T, id: q.id, wh: q.warehouse_id });
      ok(r.rows.length > 0 && r.rows.length <= q.n, `${r.rows.length} productos (la requisición tiene ${q.n} renglones)`);
      ok(r.ms < 300, `tarda ${r.ms} ms`);
      const otroWh = (await c.query('SELECT id FROM commercial.warehouses WHERE tenant_id = $1 AND id <> $2 LIMIT 1', [T, q.warehouse_id])).rows[0]?.id;
      const ajeno = await correr(REQ, { t: T, id: q.id, wh: otroWh });
      ok(ajeno.rows.length === 0, `⛔ desde otro almacén: ${ajeno.rows.length} renglones (debe ser 0)`);
    }
  } finally {
    await c.query('ROLLBACK').catch(() => undefined);
    await c.end();
  }
})().catch((e) => { fail++; console.log('  ✗ error:', e.message); })
  .finally(() => { console.log(`\n  ${pass} ✓ · ${fail} ✗ · ${nm} no medido`); process.exit(fail ? 1 : (pass ? 0 : 2)); });
