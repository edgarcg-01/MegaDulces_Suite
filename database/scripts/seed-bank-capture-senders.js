/* eslint-disable no-console */
/**
 * Fase CBW (ADR-042) — Seed/importer de remitentes autorizados de captura bancaria
 * por WhatsApp (allowlist `finance.bank_capture_senders`).
 *
 * "Prepara todo, la lista al final": este script YA está listo. Cuando tengas la
 * lista de remitentes, la pones en un archivo (CSV o JSON) o inline en SENDERS[] y
 * corres el script. Idempotente (UPSERT por (tenant, phone)); re-correrlo actualiza.
 *
 * FORMATO (CSV con encabezado; separador , o ;):
 *   phone,full_name,sucursal,cuenta
 *   4431234567,Jose Mendez,30,BBVA 5712
 *   +52 443 987 6543,Maria Lopez,73,1604
 *   ...
 *   - phone: cualquier forma (10 díg / +52 / 521…) → se normaliza a 52XXXXXXXXXX.
 *   - full_name: nombre de la persona (se usa para atribuir el depósito).
 *   - sucursal: código S de su plaza (30/73/10…). Opcional.
 *   - cuenta: "BANCO LABEL" (ej "BBVA 5712") o solo el label/tail ("5712"). Opcional
 *             (si el OCR lee la cuenta, se resuelve sola; esto es el fallback).
 *
 * USO:
 *   Dry-run (default, NO escribe):   node database/scripts/seed-bank-capture-senders.js --file senders.csv
 *   Aplicar:                         node database/scripts/seed-bank-capture-senders.js --file senders.csv --apply
 *   Contra prod:  DATABASE_URL_NEW="postgresql://…railway" node database/scripts/seed-bank-capture-senders.js --file senders.csv --apply
 *
 * Sin --file usa el arreglo inline SENDERS[] (vacío por ahora → imprime el formato y sale).
 */
const fs = require('fs');
try { require('dotenv').config(); } catch (e) { /* opcional */ }

const MEGA = '00000000-0000-0000-0000-00000000d01c';
const APPLY = process.argv.includes('--apply');
const fileArg = (() => { const i = process.argv.indexOf('--file'); return i >= 0 ? process.argv[i + 1] : null; })();

// ── Lista inline (opcional). Llénala aquí O usa --file. ─────────────────────────
/** @type {{phone:string, full_name:string, sucursal?:string, cuenta?:string}[]} */
const SENDERS = [
  // { phone: '4431234567', full_name: 'Jose Mendez', sucursal: '30', cuenta: 'BBVA 5712' },
];

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
  const headers = lines[0].split(delim).map((h) => h.trim().toLowerCase());
  const idx = (name) => headers.indexOf(name);
  const iPhone = idx('phone'), iName = idx('full_name'), iSuc = idx('sucursal'), iCta = idx('cuenta');
  if (iPhone < 0 || iName < 0) throw new Error('El CSV necesita al menos las columnas: phone, full_name');
  return lines.slice(1).map((l) => {
    const c = l.split(delim);
    return {
      phone: (c[iPhone] || '').trim(),
      full_name: (c[iName] || '').trim(),
      sucursal: iSuc >= 0 ? (c[iSuc] || '').trim() : '',
      cuenta: iCta >= 0 ? (c[iCta] || '').trim() : '',
    };
  }).filter((r) => r.phone && r.full_name);
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
  if (!s) return { id: null, note: 'sin cuenta (fallback: OCR / a mano)' };
  // "BBVA 5712" → banco + label
  const m = s.match(/^([A-Za-zÁÉÍÓÚñÑ ]+?)\s+([\w-]+)$/);
  if (m) {
    const bank = m[1].trim().toUpperCase();
    const label = m[2].trim();
    const row = await knex('finance.bank_accounts')
      .where({ tenant_id: MEGA, active: true }).whereRaw('upper(bank) = ?', [bank]).andWhere('account_label', label).first('id', 'bank', 'account_label');
    if (row) return { id: row.id, note: `${row.bank} ${row.account_label}` };
  }
  // solo label / tail 4 dígitos
  const digits = s.replace(/\D/g, '');
  const label = digits.length >= 4 ? digits.slice(-4) : s;
  const row = await knex('finance.bank_accounts')
    .where({ tenant_id: MEGA, active: true }).andWhere('account_label', label).first('id', 'bank', 'account_label');
  if (row) return { id: row.id, note: `${row.bank} ${row.account_label}` };
  return { id: null, note: `⚠️ cuenta "${s}" NO encontrada → queda sin cuenta` };
}

(async () => {
  const list = loadSenders();
  if (!list.length) {
    console.log('Sin remitentes que cargar. Llena --file <csv|json> o el arreglo SENDERS[] inline.');
    console.log('Formato CSV:\n  phone,full_name,sucursal,cuenta\n  4431234567,Jose Mendez,30,BBVA 5712');
    process.exit(0);
  }
  const knex = require('knex')({ client: 'pg', connection: { connectionString: process.env.DATABASE_URL_NEW } });
  const target = (process.env.DATABASE_URL_NEW || '').includes('rlwy.net') ? 'PROD (Railway)' : 'local';
  console.log(`\n${APPLY ? '🟢 APLICANDO' : '🔎 DRY-RUN (no escribe)'} · destino: ${target} · ${list.length} remitentes\n`);

  let ok = 0, warn = 0;
  try {
    await knex.transaction(async (trx) => {
      await trx.raw(`SET LOCAL app.tenant_id = '${MEGA}'`);
      for (const s of list) {
        const phone = normalizeMxPhone(s.phone);
        if (!phone) { console.log(`  ✗ "${s.phone}" (${s.full_name}) — teléfono inválido, saltado`); warn++; continue; }
        const acct = await resolveAccount(trx, s.cuenta);
        if (!acct.id) warn++; else ok++;
        console.log(`  ${acct.id ? '✓' : '·'} ${phone}  ${s.full_name.padEnd(24)} suc=${(s.sucursal || '—').padEnd(4)} cuenta=${acct.note}`);
        if (APPLY) {
          await trx('finance.bank_capture_senders')
            .insert({ tenant_id: MEGA, phone, full_name: s.full_name, sucursal: s.sucursal || null, default_bank_account_id: acct.id, active: true, created_by: 'seed' })
            .onConflict(['tenant_id', 'phone'])
            .merge({ full_name: s.full_name, sucursal: s.sucursal || null, default_bank_account_id: acct.id, active: true, updated_at: trx.fn.now() });
        }
      }
      if (!APPLY) throw new Error('__DRYRUN__'); // rollback en dry-run
    });
  } catch (e) {
    if (e.message !== '__DRYRUN__') { console.error('\nError:', e.message); await knex.destroy(); process.exit(1); }
  }
  console.log(`\n${APPLY ? 'Aplicado' : 'Dry-run'}: ${ok} con cuenta resuelta, ${warn} sin cuenta/advertencia.`);
  if (!APPLY) console.log('→ Corre otra vez con --apply para escribir.');
  await knex.destroy();
  process.exit(0);
})();
