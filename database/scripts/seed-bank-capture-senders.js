/* eslint-disable no-console */
/**
 * Fase CBW.6 (ADR-042) — Seed/importer de remitentes autorizados de captura bancaria
 * por WhatsApp (allowlist `finance.bank_capture_senders`).
 *
 * Los remitentes son los CLIENTES de telemarketing (grupo Kepler 1M001, ~80) que
 * pagan por depósito y mandan su ficha. Cobranza dura: cada remitente lleva su
 * clave Kepler (`customer_code`) + RFC → el depósito se atribuye al cliente.
 *
 * FORMATO (CSV con encabezado; separador , o ;). Columnas reconocidas:
 *   customer_code, full_name, phone, tel2, rfc, sucursal, cuenta
 *   - phone / tel2: cualquier forma → se normaliza a 52XXXXXXXXXX. tel2 crea una
 *     2ª fila para el MISMO cliente (puede mandar desde cualquiera de sus números).
 *   - customer_code: clave Kepler (C1002, 10001…). Excluye TI* y ONLINE (sucursales internas).
 *   - rfc: opcional; si falta, se ENRIQUECE desde analytics.erp_customers por customer_code.
 *   - cuenta: "BANCO LABEL" o tail 4 (opcional; el OCR resuelve la cuenta del depósito).
 *
 * USO:
 *   Dry-run (default):   node database/scripts/seed-bank-capture-senders.js --file clientes.csv
 *   Aplicar:             node database/scripts/seed-bank-capture-senders.js --file clientes.csv --apply
 *   Contra prod:  DATABASE_URL_NEW="postgresql://…railway" node … --file clientes.csv --apply
 */
const fs = require('fs');
try { require('dotenv').config(); } catch (e) { /* opcional */ }

const MEGA = '00000000-0000-0000-0000-00000000d01c';
const APPLY = process.argv.includes('--apply');
const fileArg = (() => { const i = process.argv.indexOf('--file'); return i >= 0 ? process.argv[i + 1] : null; })();

/** @type {{customer_code?:string, phone:string, tel2?:string, full_name:string, rfc?:string, sucursal?:string, cuenta?:string}[]} */
const SENDERS = [];

// Réplica EXACTA de normalizeMxPhone (libs/platform-core/.../mx-phone.ts) — 52XXXXXXXXXX.
function normalizeMxPhone(input) {
  let d = String(input ?? '').replace(/\D/g, '').replace(/^00/, '');
  if (!d) return null;
  if (d.length === 10) return '52' + d;
  if (d.length === 12 && d.startsWith('52')) return d;
  if (d.length === 13 && d.startsWith('521')) return '52' + d.slice(3);
  return d;
}

function parseCsv(text) {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  if (!lines.length) return [];
  const delim = lines[0].includes(';') ? ';' : ',';
  const H = lines[0].split(delim).map((h) => h.trim().toLowerCase());
  const at = (c, name) => { const i = H.indexOf(name); return i >= 0 ? (c[i] || '').trim() : ''; };
  if (H.indexOf('phone') < 0 || H.indexOf('full_name') < 0) throw new Error('El CSV necesita al menos: phone, full_name');
  return lines.slice(1).map((l) => {
    const c = l.split(delim);
    return {
      customer_code: at(c, 'customer_code') || at(c, 'clave'),
      full_name: at(c, 'full_name') || at(c, 'nombre'),
      phone: at(c, 'phone') || at(c, 'tel1'),
      tel2: at(c, 'tel2'),
      rfc: at(c, 'rfc'),
      sucursal: at(c, 'sucursal'),
      cuenta: at(c, 'cuenta'),
    };
  }).filter((r) => r.full_name);
}

function loadSenders() {
  if (fileArg) {
    const raw = fs.readFileSync(fileArg, 'utf8');
    if (fileArg.toLowerCase().endsWith('.json')) return JSON.parse(raw);
    return parseCsv(raw);
  }
  return SENDERS;
}

/** Resuelve default_bank_account_id desde "BANCO LABEL" o el tail de 4 dígitos. */
async function resolveAccount(knex, cuenta) {
  const s = String(cuenta || '').trim();
  if (!s) return { id: null, note: '' };
  const m = s.match(/^([A-Za-zÁÉÍÓÚñÑ ]+?)\s+([\w-]+)$/);
  if (m) {
    const row = await knex('finance.bank_accounts').where({ tenant_id: MEGA, active: true })
      .whereRaw('upper(bank) = ?', [m[1].trim().toUpperCase()]).andWhere('account_label', m[2].trim()).first('id', 'bank', 'account_label');
    if (row) return { id: row.id, note: `${row.bank} ${row.account_label}` };
  }
  const digits = s.replace(/\D/g, '');
  const label = digits.length >= 4 ? digits.slice(-4) : s;
  const row = await knex('finance.bank_accounts').where({ tenant_id: MEGA, active: true }).andWhere('account_label', label).first('id', 'bank', 'account_label');
  return row ? { id: row.id, note: `${row.bank} ${row.account_label}` } : { id: null, note: `⚠️ cuenta "${s}" no encontrada` };
}

(async () => {
  const list = loadSenders();
  if (!list.length) {
    console.log('Sin remitentes. Usa --file <csv|json>. Formato:\n  customer_code,full_name,phone,tel2,rfc\n  C1002,ELIZABETH RUIZ MIRAMONTES,3521018330,,');
    process.exit(0);
  }
  // Expandir tel2 → 2ª entrada del mismo cliente; excluir sucursales internas (TI*, ONLINE).
  const rows = [];
  let skippedInternal = 0;
  for (const s of list) {
    const code = String(s.customer_code || '').trim().toUpperCase();
    if (/^TI\d|^ONLINE/.test(code)) { skippedInternal++; continue; } // sucursal interna / e-commerce
    for (const p of [s.phone, s.tel2]) {
      const phone = normalizeMxPhone(p);
      if (phone) rows.push({ ...s, phone });
    }
  }

  const knex = require('knex')({ client: 'pg', connection: { connectionString: process.env.DATABASE_URL_NEW } });
  const target = (process.env.DATABASE_URL_NEW || '').includes('rlwy.net') ? 'PROD (Railway)' : 'local';
  console.log(`\n${APPLY ? '🟢 APLICANDO' : '🔎 DRY-RUN (no escribe)'} · destino: ${target} · ${rows.length} teléfonos (${list.length} filas, ${skippedInternal} internos excluidos)\n`);

  let ok = 0, conCuenta = 0, conRfc = 0;
  try {
    await knex.transaction(async (trx) => {
      await trx.raw(`SET LOCAL app.tenant_id = '${MEGA}'`);
      // Cache de RFC por clave desde el espejo de Kepler (analytics.erp_customers).
      const rfcByCode = new Map();
      const codes = [...new Set(rows.map((r) => (r.customer_code || '').trim()).filter(Boolean))];
      if (codes.length) {
        try {
          const ec = await trx('analytics.erp_customers').where({ tenant_id: MEGA }).whereIn('erp_code', codes).select('erp_code', 'rfc');
          for (const e of ec) if (e.rfc) rfcByCode.set(String(e.erp_code), e.rfc);
        } catch (e) { console.log(`  (aviso) no pude enriquecer RFC de erp_customers: ${e.message}`); }
      }
      for (const s of rows) {
        const rfc = (s.rfc || '').trim() || rfcByCode.get((s.customer_code || '').trim()) || null;
        const acct = await resolveAccount(trx, s.cuenta);
        if (acct.id) conCuenta++; if (rfc) conRfc++; ok++;
        console.log(`  ✓ ${s.phone}  ${String(s.full_name).slice(0, 30).padEnd(30)} ${(s.customer_code || '—').padEnd(7)} rfc=${(rfc || '—').padEnd(14)} ${acct.note}`);
        if (APPLY) {
          await trx('finance.bank_capture_senders')
            .insert({ tenant_id: MEGA, phone: s.phone, full_name: s.full_name, sucursal: s.sucursal || null, default_bank_account_id: acct.id, customer_code: s.customer_code || null, rfc, active: true, created_by: 'seed' })
            .onConflict(['tenant_id', 'phone'])
            .merge({ full_name: s.full_name, sucursal: s.sucursal || null, default_bank_account_id: acct.id, customer_code: s.customer_code || null, rfc, active: true, updated_at: trx.fn.now() });
        }
      }
      if (!APPLY) throw new Error('__DRYRUN__');
    });
  } catch (e) {
    if (e.message !== '__DRYRUN__') { console.error('\nError:', e.message); await knex.destroy(); process.exit(1); }
  }
  console.log(`\n${APPLY ? 'Aplicado' : 'Dry-run'}: ${ok} remitentes · ${conRfc} con RFC · ${conCuenta} con cuenta default.`);
  if (!APPLY) console.log('→ Corre otra vez con --apply para escribir.');
  await knex.destroy();
  process.exit(0);
})();
