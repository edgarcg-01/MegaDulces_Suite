/* eslint-disable no-console */
/**
 * CB (3ª fuente) — Libro de bancos Kepler por CUENTA → analytics.kepler_bank_movements.
 *
 * Lee tesorería (md.kdm1 ⋈ md.kdb1) de CEDIS md_00 y materializa el movimiento bancario por cuenta.
 * Reglas verificadas 2026-08-12 (ver migración 20260812130000):
 *   importe=c16 · dirección por tipo-de-doc · N-A-26 traspaso = 2 piernas (−c45,+c47) · excluye c43='C'.
 *
 *   node database/importers/kepler/import-kepler-bank-movements.js            # dry-run
 *   node database/importers/kepler/import-kepler-bank-movements.js --apply
 * Env: DATABASE_URL_NEW (prod) · KEPLER_BANK_SRC (default md_00) · KEPLER_BANK_DAYS (ventana rodante c68; 0=todo).
 */
const { Client } = require('pg');

const M = process.env.CRON_TENANT_ID || '00000000-0000-0000-0000-00000000d01c';
const DST = process.env.DATABASE_URL_NEW || 'postgresql://postgres:superoot@localhost:5433/postgres_platform';
const { branchUrl } = require('../lib/kepler-branches');
const SRC = process.env.KEPLER_BANK_SRC || branchUrl('00'); // CEDIS md_00
const APPLY = process.argv.includes('--apply');
const DAYS = Math.max(0, Number(process.env.KEPLER_BANK_DAYS) || 0);
const BATCH = 800;

// Dirección en banco por tipo de doc (c2-c3-c4). Verificado contra md_00.
const DIR = {
  'U-A-5': 'entrada', 'U-A-25': 'entrada', 'X-A-45': 'entrada',
  'X-D-26': 'salida', 'X-D-25': 'salida', 'X-D-60': 'salida', 'X-D-10': 'salida',
  'N-A-26': 'traspaso',
};
const CAJAS = new Set(['0010', '0011', '0040']);
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const dstr = (d) => { if (!d) return null; const s = d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10); return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null; };
const clean = (v) => { const s = String(v == null ? '' : v).trim(); return s || null; };

(async () => {
  console.log(`\n=== Bancos Kepler (md_00, kdm1⋈kdb1) → analytics.kepler_bank_movements (${APPLY ? 'APPLY' : 'DRY-RUN'})${DAYS ? ` · ventana ${DAYS}d` : ''} ===\n`);
  const src = new Client({ connectionString: SRC, connectionTimeoutMillis: 10000, statement_timeout: 180000 });
  await src.connect();

  // Catálogo de cuentas (kdb1): clave → {nombre, cuenta_contable, tipo}
  const kdb1 = (await src.query(`SELECT btrim(c1) clave, btrim(c2) nombre, btrim(c5) cta, btrim(c9) rfc FROM md.kdb1 WHERE btrim(coalesce(c1,''))<>''`)).rows;
  const bank = new Map();
  for (const r of kdb1) {
    const tipo = !/^102/.test(r.cta || '') ? 'puente' : (CAJAS.has(r.clave) ? 'caja' : 'banco');
    bank.set(r.clave, { nombre: r.nombre, cta: r.cta, tipo });
  }
  console.log(`  kdb1: ${bank.size} cuentas (${[...bank.values()].filter((b) => b.tipo === 'banco').length} banco · ${[...bank.values()].filter((b) => b.tipo === 'caja').length} caja · ${[...bank.values()].filter((b) => b.tipo === 'puente').length} puente)`);

  // Documentos de tesorería que tocan banco (c45 ∈ kdb1), NO cancelados. Ventana rodante por c68 (captura).
  const claves = [...bank.keys()];
  const where = [`btrim(c45::text) = ANY($1)`, `btrim(coalesce(c43::text,'')) <> 'C'`];
  const params = [claves];
  if (DAYS) { where.push(`c68::date >= (CURRENT_DATE - ${DAYS})`); }
  const docs = (await src.query(
    `SELECT btrim(c1::text) suc, btrim(c2::text)||'-'||btrim(c3::text)||'-'||btrim(c4::text) dt, btrim(c6::text) folio,
            c9::date fecha_valor, c68::date fecha_captura, c16::numeric importe,
            btrim(c24::text) concepto, btrim(c31::text) metodo, btrim(c32::text) beneficiario, btrim(c45::text) c45, btrim(c47::text) c47
       FROM md.kdm1 WHERE ${where.join(' AND ')}`, params)).rows;
  await src.end();
  console.log(`  docs bancarios: ${docs.length}`);

  // Materializar (traspaso = 2 piernas)
  const out = [];
  const row = (d, clave, flujo, signo, pierna, contra) => {
    const b = bank.get(clave) || {};
    out.push([M, d.suc || '00', d.dt, d.folio, clave, b.cta || null, b.nombre || null, b.tipo || null,
      flujo, round2(d.importe), signo, dstr(d.fecha_valor), dstr(d.fecha_captura), clean(d.concepto),
      clean(d.metodo), clean(d.beneficiario), flujo === 'traspaso', contra || null, pierna]);
  };
  let traspasos = 0, otros = 0;
  for (const d of docs) {
    let flujo = DIR[d.dt];
    if (!flujo) { flujo = d.metodo === 'Cob' ? 'entrada' : (['Tra', 'Che', 'Ant'].includes(d.metodo) ? 'salida' : 'otro'); if (flujo === 'otro') otros++; }
    if (flujo === 'traspaso') {
      traspasos++;
      row(d, d.c45, 'traspaso', -1, 'origen', d.c47);                 // sale del origen
      if (d.c47 && bank.has(d.c47)) row(d, d.c47, 'traspaso', +1, 'destino', d.c45); // entra al destino
    } else {
      row(d, d.c45, flujo, flujo === 'entrada' ? 1 : -1, 'mov', null);
    }
  }
  const nEnt = out.filter((r) => r[8] === 'entrada').reduce((s, r) => s + r[9], 0);
  const nSal = out.filter((r) => r[8] === 'salida').reduce((s, r) => s + r[9], 0);
  console.log(`  filas: ${out.length} (${traspasos} traspasos → 2 piernas · ${otros} tipo desconocido)`);
  console.log(`  entradas $${round2(nEnt).toLocaleString()} · salidas $${round2(nSal).toLocaleString()}`);

  if (!APPLY) { console.log('\n[DRY-RUN] nada escrito. Corré con --apply.'); return; }

  const db = new Client({ connectionString: DST, ssl: /rlwy|railway|proxy/i.test(DST) ? { rejectUnauthorized: false } : false });
  await db.connect();
  await db.query(`
    CREATE TABLE IF NOT EXISTS analytics.kepler_bank_movements (
      tenant_id uuid NOT NULL, sucursal text NOT NULL, doc_tipo text NOT NULL, folio text NOT NULL, clave_banco text NOT NULL,
      cuenta_contable text, banco_nombre text, tipo_cuenta text, flujo text NOT NULL, importe numeric NOT NULL, signo smallint,
      fecha_valor date, fecha_captura date, concepto text, metodo text, beneficiario text, es_traspaso boolean DEFAULT false,
      contra_clave text, pierna text, account_label text, computed_at timestamptz DEFAULT now(),
      PRIMARY KEY (tenant_id, sucursal, doc_tipo, folio, clave_banco))`);
  // account_label = crosswalk clave_banco → finance.bank_accounts (para el cuadre por cuenta).
  await db.query(`ALTER TABLE analytics.kepler_bank_movements ADD COLUMN IF NOT EXISTS account_label text`);
  const COLS = ['tenant_id', 'sucursal', 'doc_tipo', 'folio', 'clave_banco', 'cuenta_contable', 'banco_nombre', 'tipo_cuenta', 'flujo', 'importe', 'signo', 'fecha_valor', 'fecha_captura', 'concepto', 'metodo', 'beneficiario', 'es_traspaso', 'contra_clave', 'pierna'];
  const PK = ['tenant_id', 'sucursal', 'doc_tipo', 'folio', 'clave_banco'];
  const nonpk = COLS.filter((c) => !PK.includes(c));
  const n = COLS.length;
  let changed = 0;
  for (let i = 0; i < out.length; i += BATCH) {
    const chunk = out.slice(i, i + BATCH);
    const ph = chunk.map((_, j) => `(${Array.from({ length: n }, (_, k) => `$${j * n + k + 1}`).join(',')})`).join(',');
    const r = await db.query(
      `INSERT INTO analytics.kepler_bank_movements AS t (${COLS.join(',')}) VALUES ${ph}
       ON CONFLICT (${PK.join(',')}) DO UPDATE SET ${nonpk.map((c) => `${c}=EXCLUDED.${c}`).join(',')}, computed_at=now()
       WHERE (${nonpk.map((c) => `t.${c}`).join(',')}) IS DISTINCT FROM (${nonpk.map((c) => `EXCLUDED.${c}`).join(',')})`,
      chunk.flat());
    changed += r.rowCount;
  }
  // Backfill del crosswalk clave_banco → account_label (idempotente, churn-free).
  //   1) exacto (label = número de cuenta) · 2) caja '0011'→'CG' · 3) sufijo (Kepler 5854→854, 6506→506)
  const bf = await db.query(`
    UPDATE analytics.kepler_bank_movements k SET account_label = sub.label
      FROM (
        SELECT d.tenant_id, d.clave_banco,
          COALESCE(
            (SELECT ba.account_label FROM finance.bank_accounts ba WHERE ba.tenant_id=d.tenant_id AND ba.account_label=d.clave_banco LIMIT 1),
            CASE WHEN d.clave_banco='0011' THEN 'CG' END,
            (SELECT ba.account_label FROM finance.bank_accounts ba WHERE ba.tenant_id=d.tenant_id AND length(ba.account_label)>=3
               AND d.clave_banco LIKE '%'||ba.account_label AND d.clave_banco<>ba.account_label ORDER BY length(ba.account_label) DESC LIMIT 1)
          ) AS label
        FROM (SELECT DISTINCT tenant_id, clave_banco FROM analytics.kepler_bank_movements) d
      ) sub
     WHERE k.tenant_id=sub.tenant_id AND k.clave_banco=sub.clave_banco
       AND sub.label IS NOT NULL AND k.account_label IS DISTINCT FROM sub.label`);
  await db.end();
  console.log(`\n[APPLY] ${out.length} filas · ${changed} escritas · account_label backfill: ${bf.rowCount}.`);
})().catch((e) => { console.error('\nERROR:', e.message); process.exit(1); });
