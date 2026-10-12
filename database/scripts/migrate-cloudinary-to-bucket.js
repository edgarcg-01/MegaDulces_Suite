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
 * [AT.1.2] PDFs: Cloudinary bloquea su ENTREGA por default y un GET al secure_url da 401.
 * YA NO hace falta tocar la consola: el script reintenta por `private_download_url` (endpoint
 * de API, firmado con CLOUDINARY_API_SECRET), que no pasa por las reglas de entrega.
 * Verificado en prod: 206 + bytes que abren con %PDF-. Ver `urlFirmadaDeApi()`.
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

/**
 * `[AT.1.2]` — **Los PDF se bajan por la API firmada, no por la URL de entrega.**
 *
 * La cabecera de este archivo decía: *«Antes de `--apply`, habilitá temporalmente "Allow delivery
 * of PDF and ZIP files" en Cloudinary»*. Eso convertía la migración en algo que **nadie podía
 * correr** sin entrar a una consola de un tercero — y por eso los 1,200 comprobantes de pago del
 * 2026-08-05 siguieron un mes y medio con su evidencia inalcanzable: ni el carril `[AT.1]` ni la
 * persona que abre la pantalla podían verla.
 *
 * ⭐⭐ Medido dentro del pod de prod el 2026-10-12, con control negativo:
 *
 * | vía | resultado |
 * |---|---|
 * | `secure_url` público | **401** (`image/gif`, el marcador de bloqueo) |
 * | el mismo, **firmado** (`sign_url`) | **401** — firmar NO alcanza |
 * | un `public_id` **inventado** | **404** — o sea el 401 es «bloqueado», no «no está» |
 * | Admin API `api.resource` | **el asset EXISTE**: 88,635 bytes, `pdf`, subido 2026-08-06 |
 * | ⭐ **`private_download_url`** | **206 · `application/pdf` · los bytes abren con `%PDF-`** |
 *
 * `private_download_url` pega contra el endpoint de **API** (`/image/download`), firmado con el
 * secreto, y **no pasa por las reglas de entrega**. Con eso la migración se corre **hoy**, sin
 * tocar la consola.
 *
 * ⚠️ Sólo se usa como **respaldo**, cuando la URL pública falla: si algún día el bloqueo se
 * levanta, la vía normal sigue siendo la primera y esto no estorba. Y si falta
 * `CLOUDINARY_API_SECRET`, se **declara** en vez de reportar «no se pudo bajar» a secas.
 */
function urlFirmadaDeApi(f) {
  const pid = String((f && f.public_id) || '').trim();
  if (!pid) return null;
  if (!process.env.CLOUDINARY_API_SECRET || !process.env.CLOUDINARY_API_KEY || !process.env.CLOUDINARY_CLOUD_NAME) return null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { v2: cl } = require('cloudinary');
    cl.config({
      cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
      api_key: process.env.CLOUDINARY_API_KEY,
      api_secret: process.env.CLOUDINARY_API_SECRET,
      secure: true,
    });
    // El formato sale de la URL guardada; `image` es el resource_type con el que se subieron
    // (verificado en prod: las 1,200 son `/image/upload/….pdf`).
    const ext = (/\.([a-z0-9]{1,8})(?:\?|$)/i.exec(f.url || '') || [])[1] || 'pdf';
    return cl.utils.private_download_url(pid, ext, { resource_type: 'image', type: 'upload' });
  } catch (e) {
    return null;
  }
}

async function bajar(f) {
  const directa = await fetch(f.url);
  if (directa.ok) return directa;
  // ⛔ 401 = entrega bloqueada (NO «no existe»: eso da 404, verificado). Se reintenta por la API.
  if (directa.status !== 401) throw new Error(`GET ${directa.status}`);
  const firmada = urlFirmadaDeApi(f);
  if (!firmada) {
    throw new Error('GET 401 y no hay CLOUDINARY_API_SECRET para bajarlo por la API firmada');
  }
  const porApi = await fetch(firmada);
  if (!porApi.ok) throw new Error(`GET 401 (entrega) y ${porApi.status} (API firmada)`);
  return porApi;
}

async function migrateFile(f, tenantId, t) {
  const resp = await bajar(f);
  const ct = (resp.headers.get('content-type') || '').toLowerCase();
  const buf = Buffer.from(await resp.arrayBuffer());
  // ⛔ Lo que vuelve tiene que ser el DOCUMENTO, no el marcador de bloqueo. Cloudinary responde
  // los PDF restringidos con un `image/gif` de 0 bytes: subir eso al bucket sería reemplazar
  // evidencia por un placeholder, y el apuntador quedaría diciendo que ya está migrada.
  if (!buf.length) throw new Error('el cuerpo vino VACÍO: no se migra un archivo de 0 bytes');
  const pareceBloqueo = ct.includes('gif') && (f.kind === 'pdf' || /\.pdf(\?|$)/i.test(f.url || ''));
  if (pareceBloqueo) throw new Error('Cloudinary devolvió el marcador de bloqueo (image/gif) en vez del PDF');
  const isPdf = ct.includes('pdf') || /\.pdf(\?|$)/i.test(f.url) || f.kind === 'pdf';
  const ext = isPdf ? 'pdf' : ((ct.split('/')[1] || 'bin').replace(/[^a-z0-9]/g, '') || 'bin');
  const key = `${t.prefix}/${tenantId}/${t.folder}/${randomUUID()}.${ext}`;
  await s3.send(new PutObjectCommand({
    Bucket: process.env.S3_BUCKET, Key: key, Body: buf,
    ContentType: isPdf ? 'application/pdf' : (ct || 'application/octet-stream'),
    ContentDisposition: 'inline',
  }));
  // Conserva role/name/sha256/ocr_*; solo cambia el apuntador al bucket.
  //
  // ⭐ `[AT.1.2]` …y GUARDA DE DÓNDE VENÍA. Sin esto la migración es una puerta de un solo
  // sentido: al pisar `public_id` con la llave nueva, el asset original de Cloudinary queda sin
  // nadie que lo nombre, así que un error de subida (o un PDF que resultó ser otra cosa) ya no
  // se puede rehacer ni auditar. El asset sigue existiendo del otro lado; lo que se perdía era
  // su dirección. La huella viaja EN LA FILA, no sólo en un log.
  return {
    ...f,
    url: key,
    public_id: key,
    kind: isPdf ? 'pdf' : 'image',
    cloudinary_public_id: f.public_id || null,
    cloudinary_url: f.url || null,
    migrado_en: new Date().toISOString(),
  };
}

// `[AT.1.2]` Exportado para poder EJERCER la bajada contra Cloudinary sin migrar nada. La
// alternativa era copiar estas funciones a un script de prueba, y copiar es exactamente como se
// escapó el bug del regex de `[AT.1.1]`: lo que se prueba tiene que ser el código que corre.
module.exports = { bajar, urlFirmadaDeApi, isCloud };

// Sólo corre la migración si se invocó el archivo directamente, no al requerirlo.
if (require.main !== module) return;

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
  if (!APPLY) console.log('Dry-run. Corré con --apply para migrar. Los PDF bloqueados se bajan por la API firmada (requiere CLOUDINARY_API_SECRET).');
  await db.end();
})().catch((e) => { console.error(e); process.exit(1); });
