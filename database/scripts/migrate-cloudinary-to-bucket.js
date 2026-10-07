#!/usr/bin/env node
/*
 * RE.6 — Migra los comprobantes que se subieron a Cloudinary → bucket S3 privado
 * (Railway/Tigris). Los PDF en Cloudinary NO abren (delivery de PDF bloqueado);
 * este script los baja, los re-sube al bucket y reescribe el `files` JSONB para
 * que la app los sirva con URL prefirmada.
 *
 * Identifica un archivo Cloudinary por su `url` (https://res.cloudinary.com/...).
 * Los archivos ya migrados (url = key del bucket, sin http) se saltan → IDEMPOTENTE.
 *
 * Uso:
 *   node database/scripts/migrate-cloudinary-to-bucket.js            # DRY-RUN (solo cuenta)
 *   node database/scripts/migrate-cloudinary-to-bucket.js --apply    # migra de verdad
 *   ... --table=goods_receipt_proofs   # solo una tabla
 *   ... --limit=50                     # tope de filas por tabla (pruebas)
 *
 * Env requerido:
 *   MIG_DB_URL (o DATABASE_URL_NEW / DATABASE_URL)  → la DB nueva multi-tenant
 *   S3_ENDPOINT / S3_REGION / S3_BUCKET / S3_ACCESS_KEY_ID / S3_SECRET_ACCESS_KEY
 *
 * OJO PDFs: Cloudinary bloquea el delivery de PDF por default → un GET al secure_url
 * da 401. Antes de `--apply`, habilitá temporalmente "Allow delivery of PDF and ZIP
 * files" en Cloudinary (Settings → Security). Las imágenes migran sin ese toggle.
 */
const { Client } = require('pg');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const { randomUUID } = require('crypto');

const APPLY = process.argv.includes('--apply');
const ONLY = (process.argv.find((a) => a.startsWith('--table=')) || '').split('=')[1] || '';
const LIMIT = Number((process.argv.find((a) => a.startsWith('--limit=')) || '').split('=')[1] || 0);

const DB_URL = process.env.MIG_DB_URL || process.env.DATABASE_URL_NEW || process.env.DATABASE_URL;
if (!DB_URL) { console.error('Falta MIG_DB_URL / DATABASE_URL_NEW / DATABASE_URL'); process.exit(1); }
for (const k of ['S3_ENDPOINT', 'S3_BUCKET', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY']) {
  if (!process.env[k]) { console.error(`Falta env ${k}`); process.exit(1); }
}

const s3 = new S3Client({
  region: process.env.S3_REGION || 'auto',
  endpoint: process.env.S3_ENDPOINT,
  forcePathStyle: true,
  credentials: { accessKeyId: process.env.S3_ACCESS_KEY_ID, secretAccessKey: process.env.S3_SECRET_ACCESS_KEY },
});

// Tabla → carpeta destino en el bucket. `prefix` = raíz de la key (mismo esquema que los services).
const TABLES = [
  { schema: 'finance', table: 'goods_receipt_proofs', folder: 'goods-receipts', prefix: 'finance' },
  { schema: 'finance', table: 'supplier_payment_proofs', folder: 'supplier-payments', prefix: 'finance' },
  { schema: 'finance', table: 'collection_deposits', folder: 'collection-deposits', prefix: 'finance' },
  { schema: 'finance', table: 'expense_proofs', folder: 'expense-proofs', prefix: 'finance' },
  { schema: 'finance', table: 'expense_comprobaciones', folder: 'expense-comprobaciones', prefix: 'finance' },
  { schema: 'finance', table: 'bank_captures', folder: 'bank-captures', prefix: 'finance' },
];

const isCloud = (f) => /^https?:\/\/res\.cloudinary\.com/i.test((f && f.url) || '');

async function migrateFile(f, tenantId, t) {
  const resp = await fetch(f.url);
  if (!resp.ok) throw new Error(`GET ${resp.status}`);
  const ct = (resp.headers.get('content-type') || '').toLowerCase();
  const buf = Buffer.from(await resp.arrayBuffer());
  const isPdf = ct.includes('pdf') || /\.pdf(\?|$)/i.test(f.url) || f.kind === 'pdf';
  const ext = isPdf ? 'pdf' : ((ct.split('/')[1] || 'bin').replace(/[^a-z0-9]/g, '') || 'bin');
  const key = `${t.prefix}/${tenantId}/${t.folder}/${randomUUID()}.${ext}`;
  await s3.send(new PutObjectCommand({
    Bucket: process.env.S3_BUCKET, Key: key, Body: buf,
    ContentType: isPdf ? 'application/pdf' : (ct || 'application/octet-stream'),
    ContentDisposition: 'inline',
  }));
  // Conserva role/name/sha256/ocr_*; solo cambia el apuntador al bucket.
  return { ...f, url: key, public_id: key, kind: isPdf ? 'pdf' : 'image' };
}

(async () => {
  const local = /localhost|127\.0\.0\.1|192\.168\./.test(DB_URL);
  const db = new Client({ connectionString: DB_URL, ssl: local ? false : { rejectUnauthorized: false } });
  await db.connect();
  console.log(`\nMigración Cloudinary → bucket "${process.env.S3_BUCKET}" — ${APPLY ? 'APLICANDO' : 'DRY-RUN'}\n`);
  let totC = 0, totM = 0, totF = 0;
  for (const t of TABLES) {
    if (ONLY && t.table !== ONLY) continue;
    let rows;
    try {
      rows = (await db.query(
        `SELECT id, tenant_id, files FROM ${t.schema}.${t.table}
         WHERE files::text ILIKE '%res.cloudinary.com%' ${LIMIT ? `LIMIT ${LIMIT}` : ''}`,
      )).rows;
    } catch (e) {
      console.log(`  ${t.schema}.${t.table}: (omitida — ${e.message})`);
      continue;
    }
    let cand = 0, mig = 0, fail = 0;
    for (const r of rows) {
      const files = typeof r.files === 'string' ? JSON.parse(r.files || '[]') : (r.files || []);
      let changed = false;
      const out = [];
      for (const f of files) {
        if (!isCloud(f)) { out.push(f); continue; }
        cand++; totC++;
        if (!APPLY) { out.push(f); continue; }
        try { out.push(await migrateFile(f, r.tenant_id, t)); changed = true; mig++; totM++; }
        catch (e) { out.push(f); fail++; totF++; console.warn(`  ✗ ${t.table}#${r.id} ${String(f.url).slice(0, 64)} → ${e.message}`); }
      }
      if (changed) await db.query(`UPDATE ${t.schema}.${t.table} SET files = $1::jsonb WHERE id = $2`, [JSON.stringify(out), r.id]);
    }
    console.log(`  ${t.schema}.${t.table}: ${cand} archivo(s) Cloudinary${APPLY ? ` · ${mig} migrados · ${fail} fallidos` : ''}`);
  }
  console.log(`\nTotal: ${totC} candidato(s)${APPLY ? ` · ${totM} migrado(s) · ${totF} fallido(s)` : ''}`);
  if (!APPLY) console.log('Dry-run. Corré con --apply para migrar. (Habilitá "Allow delivery of PDF and ZIP" en Cloudinary o los PDF darán 401.)');
  await db.end();
})().catch((e) => { console.error(e); process.exit(1); });
