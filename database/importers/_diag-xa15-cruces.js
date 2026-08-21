/* eslint-disable no-console */
/**
 * DIAG (read-only) — ¿contra qué se puede CRUZAR una solicitud de gasto?
 *
 * Segunda pasada de `_diag-xa15-kepler-fields.js`: ahí salió que Kepler guarda 72 columnas
 * con dato y nosotros exponemos 8. Acá se mide, con números, qué tanto pegan las columnas
 * candidatas contra lo que ya tenemos en la plataforma:
 *   c22 → RFC del beneficiario  (ContPAQi, listas SAT/EFOS, pagos a proveedor)
 *   c10 → clave de cuenta/beneficiario del catálogo Kepler
 *   c30 → área o quien autoriza · c11 → referencia libre
 *   c14/c16/c17/c18/c90 → impuesto, total, condición, vencimiento, forma
 * Uso: node database/importers/_diag-xa15-cruces.js [NOMBRE_VAR_URL]
 */
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env') });
const { Client } = require('pg');

const URL_VAR = process.argv[2] || 'FLEET_DB_URL';
const F15 = `c2='X' AND c3='A' AND btrim(c4::text)='15' AND btrim(c5::text)='1' AND btrim(c1::text)=sucursal::text`;
const h = (t) => console.log(`\n${'='.repeat(88)}\n${t}\n${'='.repeat(88)}`);
const pad = (s, n) => String(s).padEnd(n).slice(0, n);

(async () => {
  const cs = process.env[URL_VAR];
  if (!cs) { console.error(`Falta ${URL_VAR}`); process.exit(1); }
  const pg = new Client({ connectionString: cs, ssl: { rejectUnauthorized: false } });
  await pg.connect();
  const q = async (sql, p = []) => (await pg.query(sql, p)).rows;
  const has = async (t) => !!(await q(`SELECT to_regclass($1) r`, [t]))[0].r;

  await pg.query(`CREATE TEMP TABLE _s AS SELECT * FROM kepler_ods.kdm1 WHERE ${F15}`);
  const [{ n }] = await q(`SELECT count(*)::int n FROM _s`);
  console.log(`solicitudes de gasto X-A-15: ${n.toLocaleString('es-MX')}`);

  // ── c10: taxonomía de la clave ────────────────────────────────────────────
  h('c10 — clave de cuenta / beneficiario (337 distintas)');
  for (const r of await q(`SELECT left(btrim(c10::text),2) p, count(*)::int docs, count(DISTINCT btrim(c10::text))::int claves,
                                  round(sum(c16::numeric))::bigint monto
                             FROM _s GROUP BY 1 ORDER BY 2 DESC`)) {
    console.log(`  ${pad(r.p, 5)}${pad(r.docs, 8)}docs  ${pad(r.claves, 6)}claves  $${Number(r.monto).toLocaleString('es-MX')}`);
  }
  console.log('  ejemplos clave→beneficiario:');
  for (const r of await q(`SELECT btrim(c10::text) k, max(btrim(c32::text)) b, count(*)::int n
                             FROM _s GROUP BY 1 ORDER BY 3 DESC LIMIT 8`)) {
    console.log(`    ${pad(r.k, 10)}${pad(r.b, 42)}${r.n}`);
  }

  // ── c22: RFC — el cruce de mayor valor ────────────────────────────────────
  h('c22 — RFC del beneficiario: contra qué pega');
  const [{ con, rfcs }] = await q(`SELECT count(*) FILTER (WHERE nullif(btrim(c22::text),'') IS NOT NULL)::int con,
                                          count(DISTINCT nullif(btrim(c22::text),''))::int rfcs FROM _s`);
  console.log(`  con RFC: ${con.toLocaleString('es-MX')}/${n.toLocaleString('es-MX')} (${(100 * con / n).toFixed(0)}%) · ${rfcs} RFC distintos`);
  const cruces = [
    ['analytics.contpaqi_suppliers', 'rfc', 'proveedores ContPAQi'],
    ['fiscal.sat_list_rfcs', 'rfc', 'listas SAT (69B / EFOS)'],
    ['analytics.erp_supplier_payments', 'rfc', 'pagos a proveedor'],
    ['commercial.suppliers', 'rfc', 'proveedores de la plataforma'],
  ];
  for (const [t, col, label] of cruces) {
    if (!(await has(t))) { console.log(`  ${pad(label, 34)}(no existe ${t})`); continue; }
    const okCol = (await q(`SELECT 1 FROM information_schema.columns WHERE table_schema=split_part($1,'.',1) AND table_name=split_part($1,'.',2) AND column_name=$2`, [t, col])).length;
    if (!okCol) { console.log(`  ${pad(label, 34)}(${t} no tiene columna ${col})`); continue; }
    const [r] = await q(`SELECT count(DISTINCT s.rfc)::int m FROM (SELECT DISTINCT upper(btrim(c22::text)) rfc FROM _s WHERE nullif(btrim(c22::text),'') IS NOT NULL) s
                          WHERE EXISTS (SELECT 1 FROM ${t} x WHERE upper(btrim(x.${col}::text))=s.rfc)`);
    console.log(`  ${pad(label, 34)}${r.m}/${rfcs} RFC (${(100 * r.m / (rfcs || 1)).toFixed(0)}%)`);
  }

  // ── c30 / c11 / c90 / c17 ─────────────────────────────────────────────────
  h('c30 · c11 · c90 · c17 — qué son');
  for (const [col, label] of [['c30', 'c30 (94%)'], ['c11', 'c11 (80%)'], ['c90', 'c90 (47%)'], ['c17', 'c17 (100%)']]) {
    const vals = await q(`SELECT btrim(${col}::text) v, count(*)::int k FROM _s WHERE nullif(btrim(${col}::text),'') IS NOT NULL GROUP BY 1 ORDER BY 2 DESC LIMIT 8`);
    console.log(`  ${label}: ` + vals.map((r) => `${r.v}(${r.k})`).join('  '));
  }

  // ── c14 vs c16: ¿impuesto? ────────────────────────────────────────────────
  h('c14 vs c16 — ¿c14 es el IVA del total c16?');
  for (const r of await q(`SELECT round(avg(c14::numeric),2) c14_prom, round(avg(c16::numeric),2) c16_prom,
       count(*) FILTER (WHERE c14::numeric>0)::int con_c14,
       count(*) FILTER (WHERE abs(c14::numeric - round(c16::numeric/1.16*0.16,2)) <= 0.05)::int cuadra_iva16,
       count(*) FILTER (WHERE abs(c14::numeric - round(c16::numeric*0.16,2)) <= 0.05)::int c14_es_16pct_de_c16
       FROM _s WHERE c16::numeric > 0`)) console.log('  ', r);

  // ── c18 vs c9: ¿vencimiento? ──────────────────────────────────────────────
  h('c18 vs c9 — ¿c18 es fecha de vencimiento?');
  for (const r of await q(`SELECT count(*) FILTER (WHERE c18::date = c9::date)::int igual,
       count(*) FILTER (WHERE c18::date > c9::date)::int posterior,
       count(*) FILTER (WHERE c18::date < c9::date)::int anterior,
       round(avg(c18::date - c9::date),1) dias_prom FROM _s`)) console.log('  ', r);

  // ── Cobertura por sucursal: ¿el feed llega de todas? ──────────────────────
  h('Cobertura por sucursal (el feed sólo trae 4)');
  for (const r of await q(`SELECT sucursal, count(*)::int docs, min(c9::date) d1, max(c9::date) d2,
                                  round(sum(c16::numeric))::bigint monto FROM _s GROUP BY 1 ORDER BY 1`)) {
    console.log(`  ${pad(r.sucursal, 5)}${pad(r.docs, 8)}docs  ${r.d1} → ${r.d2}  $${Number(r.monto).toLocaleString('es-MX')}`);
  }

  // ── ¿Existe la póliza contable del gasto? ─────────────────────────────────
  h('Cadena contable: ¿el gasto X-A-10 tiene póliza?');
  if (await has('analytics.expense_doc_chain')) {
    for (const r of await q(`SELECT count(*)::int n FROM analytics.expense_doc_chain`)) console.log('  analytics.expense_doc_chain filas:', r.n);
  } else console.log('  analytics.expense_doc_chain no existe');
  if (await has('analytics.expense_documents')) {
    for (const r of await q(`SELECT count(*)::int n, count(*) FILTER (WHERE solicitud_folio IS NOT NULL)::int con_sol
                               FROM analytics.expense_documents WHERE doc_tipo='XA1001'`)) {
      console.log(`  expense_documents XA1001: ${r.n} · con solicitud ligada: ${r.con_sol}`);
    }
    const cols = (await q(`SELECT column_name FROM information_schema.columns WHERE table_schema='analytics' AND table_name='expense_documents' ORDER BY 1`)).map((r) => r.column_name);
    console.log('  columnas expense_documents:', cols.join(', '));
  }

  await pg.end();
})().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
