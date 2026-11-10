#!/usr/bin/env node
/* eslint-disable no-console */
'use strict';
/**
 * Fase RH · `[RH.3.5b]` — CARGA ÚNICA de los ARCHIVOS de Mega Talento al bucket privado de la Suite: CV, INE, CURP…
 * del expediente y lo que la gente mandó por el chat. Corre DESPUÉS de `carga-reclutamiento-mega-talento.js --con-bot`
 * (lee lo que ésa dejó en la Suite; no necesita la base de Mega Talento) y ANTES de apagar Railway (`[RH.4]`).
 *
 * Por qué: los archivos viven en el servidor del bot de Mega Talento en Railway (`…/archivo/<token>`, ~5,500) y en
 * Cloudinary (~275). La Suite los mostraba con esa liga externa: el día que se apaga Railway, el expediente queda vacío.
 *
 *   DATABASE_URL_NEW=… node database/scripts/rh/carga-archivos-mega-talento.js [--limite 50]  # ENSAYO: baja, no sube
 *   … --aplicar                                       # sube al bucket (S3_*) y escribe las llaves
 *   … --destino-prod --aplicar                        # el corte, dentro del pod de la API (CARGA_URL="$DATABASE_URL_NEW")
 *
 * ── Qué hace (medido el 2026-11-09) ─────────────────────────────────────────────────────────────────────────────────
 *  · Junta las ligas de Mega Talento SIN llave del bucket: las del expediente (`documents[].url`), las de los mensajes
 *    (`payload.media_url`) y el CV/reverso/licencia que sólo están en su columna (los de Cloudinary no estaban en el
 *    expediente: la ficha no los mostraba). La misma liga se baja UNA vez (5,806 únicas; 1.5 GB).
 *  · La llave es FIJA por liga (`talent/<tenant>/mega-talento/<sha256>.<ext>`): correrla otra vez reescribe el mismo
 *    objeto, no deja huérfanos.
 *  · Al expediente se le agrega `storage_key` y la ficha ya firma la llave en vez de la liga (`documentos()`); la liga
 *    de origen se conserva. Al mensaje, `payload.storage_key`.
 *  · ENSAYO (por omisión): baja cada archivo para probar que existe y cuánto pesa, NO sube nada y deshace la base. Subir
 *    en un ensayo dejaría objetos sin dueño.
 *
 * ── Lo que NO trae (y se declara) ───────────────────────────────────────────────────────────────────────────────────
 *  · Lo que ya no existe en Mega Talento (33 ligas daban 404 el 9-nov): queda la liga, contado.
 *  · Lo que sólo esté en el DISCO del bot (`archivo_local`, sin liga): desde fuera no se alcanza y se cuenta aparte.
 *    Eran 438 de julio; el 9-nov Mega Talento les generó su liga (respaldo en su tabla `_respaldo_docs_sin_url_20261109`)
 *    y ya bajan como los demás. Queda 1 que el bot nunca descargó de WhatsApp: no existe en ningún lado.
 *  · Las ligas a sitios de terceros (el reporte de la prueba en `podium.midot.com`): no son de Mega Talento.
 */
const crypto = require('crypto');
const path = require('path');

const TENANT_MD = '00000000-0000-0000-0000-00000000d01c';
/** De dónde son los archivos de Mega Talento. Nada fuera de aquí se toca. */
const ORIGENES_MT = ['https://bot-rh-production.up.railway.app/', 'https://res.cloudinary.com/'];
const MAX_BYTES = 25 * 1024 * 1024;
const EXT = {
  'application/pdf': 'pdf', 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'audio/ogg': 'ogg', 'video/mp4': 'mp4',
  'application/msword': 'doc', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx', 'application/zip': 'zip', 'text/plain': 'txt',
};

const esDeMT = (u) => typeof u === 'string' && ORIGENES_MT.some((o) => u.startsWith(o));
const tipoDe = (ct) => String(ct || 'application/octet-stream').split(';')[0].trim().toLowerCase();
/** La llave del bucket: fija por liga, para que repetir la carga no duplique. */
const llaveDe = (tenantId, url, ct) =>
  `talent/${tenantId}/mega-talento/${crypto.createHash('sha256').update(url).digest('hex').slice(0, 32)}.${EXT[tipoDe(ct)] || 'bin'}`;
/** Las columnas que traen archivo y no siempre están en el expediente, con el casillero de la Suite al que van. */
const COLUMNAS = [
  { col: 'cv_url', slot: 'cv', nombre: 'CV (Mega Talento)' },
  { col: 'cv_back_url', slot: 'cv', nombre: 'CV, reverso (Mega Talento)' },
  { col: 'license_url', slot: 'licencia', nombre: 'Licencia (Mega Talento)' },
];

/** Lo que hay que mover, leído de la Suite. */
async function inventario(trx, tenantId) {
  const candidatos = (await trx('talent.candidates').where({ tenant_id: tenantId })
    .where((q) => q.whereRaw(`documents::text LIKE '%https://%'`).orWhere('cv_url', 'like', 'https://%')
      .orWhere('cv_back_url', 'like', 'https://%').orWhere('license_url', 'like', 'https://%'))
    .select('id', 'documents', 'cv_url', 'cv_back_url', 'license_url', 'created_at'));
  const mensajes = (await trx.raw(`
    SELECT payload->>'media_url' AS url, count(*)::int AS n FROM whatsapp.messages
     WHERE tenant_id = ? AND flow = 'recruitment' AND payload->>'media_url' IS NOT NULL AND payload->>'storage_key' IS NULL
     GROUP BY 1`, [tenantId])).rows;
  const urls = new Set();
  let sinLiga = 0;
  const conSinLiga = new Set();
  for (const c of candidatos) {
    const docs = Array.isArray(c.documents) ? c.documents : [];
    for (const d of docs) {
      if (d && esDeMT(d.url) && !d.storage_key) urls.add(d.url);
      if (d && !d.url && !d.storage_key && d.archivo_local) { sinLiga++; conSinLiga.add(c.id); }
    }
    // La columna sólo cuenta si su archivo no está ya en el expediente (con llave o sin ella: ése ya se contó arriba).
    const enExpediente = new Set(docs.map((d) => d && d.url).filter(Boolean));
    for (const { col } of COLUMNAS) if (esDeMT(c[col]) && !enExpediente.has(c[col])) urls.add(c[col]);
  }
  for (const m of mensajes) if (esDeMT(m.url)) urls.add(m.url);
  return { candidatos, mensajes, urls: [...urls], sinLiga, candidatosSinLiga: conSinLiga.size };
}

/**
 * Baja cada liga UNA vez y la sube (si hay `subir`). Devuelve qué llave quedó para cada liga y lo que no se pudo, con
 * su motivo. `bajar(url)` → `{ ok, status, body: Buffer, contentType }`.
 */
async function mover(urls, tenantId, { bajar, subir, concurrencia = 4, avisar = null }) {
  const movidos = new Map();
  const perdidos = {};
  let bytes = 0, i = 0, hechos = 0;
  const t0 = Date.now();
  async function uno(url) {
    let r;
    try { r = await bajar(url); } catch (e) { r = { ok: false, status: e.name || 'error_de_red' }; }
    if (!r.ok) { perdidos[r.status] = (perdidos[r.status] || 0) + 1; return; }
    if (r.body.length > MAX_BYTES) { perdidos.demasiado_grande = (perdidos.demasiado_grande || 0) + 1; return; }
    const ct = tipoDe(r.contentType);
    const key = llaveDe(tenantId, url, ct);
    if (subir) await subir(key, r.body, ct);
    movidos.set(url, { key, ct, bytes: r.body.length });
    bytes += r.body.length;
  }
  await Promise.all(Array.from({ length: concurrencia }, async () => {
    while (i < urls.length) {
      await uno(urls[i++]);
      if (avisar && ++hechos % 500 === 0) avisar(`  … ${hechos}/${urls.length} · ${Math.round(bytes / 1048576)} MB · ${Math.round((Date.now() - t0) / 1000)} s`);
    }
  }));
  return { movidos, perdidos, bytes };
}

/** Escribe las llaves: al expediente (y agrega lo que sólo estaba en su columna) y a los mensajes. */
async function escribirLlaves(trx, tenantId, inv, movidos) {
  let docsConLlave = 0, docsAgregados = 0, candidatosTocados = 0;
  for (const c of inv.candidatos) {
    const docs = Array.isArray(c.documents) ? c.documents : [];
    let cambio = false;
    const nuevos = docs.map((d) => {
      const m = d && !d.storage_key && movidos.get(d.url);
      if (!m) return d;
      cambio = true; docsConLlave++;
      return { ...d, storage_key: m.key, mime_type: d.mime_type || m.ct, size_bytes: d.size_bytes ?? m.bytes };
    });
    const yaEstan = new Set(docs.map((d) => d && d.url).filter(Boolean));
    for (const { col, slot, nombre } of COLUMNAS) {
      const m = movidos.get(c[col]);
      if (!m || yaEstan.has(c[col])) continue;
      yaEstan.add(c[col]);
      cambio = true; docsAgregados++;
      nuevos.push({ slot, filename: nombre, mime_type: m.ct, size_bytes: m.bytes, storage_key: m.key, url: c[col],
        origen: 'mega_talento', recibido_en: new Date(c.created_at).toISOString() });
    }
    if (!cambio) continue;
    candidatosTocados++;
    await trx('talent.candidates').where({ tenant_id: tenantId, id: c.id }).update({ documents: JSON.stringify(nuevos) });
  }
  const filas = inv.mensajes.filter((m) => movidos.has(m.url)).map((m) => ({ url: m.url, k: movidos.get(m.url).key, ct: movidos.get(m.url).ct }));
  const msgs = filas.length ? (await trx.raw(`
    UPDATE whatsapp.messages m SET payload = m.payload || jsonb_build_object('storage_key', x.k, 'mime_type', x.ct)
      FROM jsonb_to_recordset(?::jsonb) AS x(url text, k text, ct text)
     WHERE m.tenant_id = ? AND m.flow = 'recruitment' AND m.payload->>'media_url' = x.url AND m.payload->>'storage_key' IS NULL`,
  [JSON.stringify(filas), tenantId])).rowCount : 0;
  return { docsConLlave, docsAgregados, candidatosTocados, mensajes: msgs };
}

/** Todo junto, dentro de `trx`. Devuelve el cuadre. */
async function cargarArchivos(trx, { tenantId = TENANT_MD, bajar, subir = null, limite = null, concurrencia = 4, log = null } = {}) {
  const inv = await inventario(trx, tenantId);
  const urls = limite ? inv.urls.slice(0, limite) : inv.urls;
  if (log) log(`  ligas de Mega Talento sin llave: ${inv.urls.length}${limite ? ` (se prueban ${urls.length})` : ''} · ${inv.mensajes.length} de mensajes`);
  const { movidos, perdidos, bytes } = await mover(urls, tenantId, { bajar, subir, concurrencia, avisar: log });
  const escrito = await escribirLlaves(trx, tenantId, inv, movidos);
  const cuadre = {
    ligas: inv.urls.length, probadas: urls.length, movidas: movidos.size, mb: Math.round(bytes / 1048576), perdidas: perdidos,
    subidas: subir ? movidos.size : 0, ...escrito,
    no_movido: {
      sin_liga: { documentos: inv.sinLiga, candidatos: inv.candidatosSinLiga, por: 'sólo en el disco del bot de Mega Talento: los saca quien lo administra' },
    },
  };
  if (log) {
    log(`  movidas ${cuadre.movidas}/${cuadre.probadas} (${cuadre.mb} MB) · ${subir ? `subidas ${cuadre.subidas}` : 'NO se subió nada (ensayo)'}`);
    log(`  expediente: ${escrito.docsConLlave} con llave · ${escrito.docsAgregados} agregados (estaban sólo en su columna) · ${escrito.candidatosTocados} candidatos · mensajes: ${escrito.mensajes}`);
    if (Object.keys(perdidos).length) log(`  ⚠️ no se pudieron bajar: ${JSON.stringify(perdidos)} — se queda la liga`);
    log(`  ⚠️ NO movido: ${inv.sinLiga} documentos de ${inv.candidatosSinLiga} candidatos sin liga — ${cuadre.no_movido.sin_liga.por}`);
  }
  return cuadre;
}

/** Bajar de verdad: con tiempo límite y un reintento si falla la red. */
async function bajarHttp(url) {
  for (let intento = 0; ; intento++) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(60_000) });
      if (!r.ok) return { ok: false, status: r.status };
      return { ok: true, status: r.status, body: Buffer.from(await r.arrayBuffer()), contentType: r.headers.get('content-type') };
    } catch (e) {
      if (intento >= 1) throw e;
    }
  }
}

/** Subir al bucket de la Suite, con las mismas variables que `ObjectStorageService`. */
function subidorS3() {
  const env = process.env;
  const cfg = { endpoint: env.S3_ENDPOINT || env.AWS_ENDPOINT_URL_S3, bucket: env.S3_BUCKET || env.AWS_S3_BUCKET,
    id: env.S3_ACCESS_KEY_ID || env.AWS_ACCESS_KEY_ID, secreto: env.S3_SECRET_ACCESS_KEY || env.AWS_SECRET_ACCESS_KEY };
  if (!cfg.endpoint || !cfg.bucket || !cfg.id || !cfg.secreto) throw new Error('--aplicar necesita el bucket (S3_ENDPOINT, S3_BUCKET, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY): dentro del pod de la API ya están.');
  const { S3Client, PutObjectCommand, HeadObjectCommand } = require('@aws-sdk/client-s3');
  const s3 = new S3Client({ region: env.S3_REGION || env.AWS_REGION || 'auto', endpoint: cfg.endpoint,
    credentials: { accessKeyId: cfg.id, secretAccessKey: cfg.secreto }, forcePathStyle: true });
  const subir = (key, body, ct) => s3.send(new PutObjectCommand({ Bucket: cfg.bucket, Key: key, Body: body, ContentType: ct, ContentDisposition: 'inline' }));
  /** Antes de bajar 1.5 GB: que el bucket acepte un objeto (y se pueda leer). */
  subir.probar = async () => {
    const key = `talent/${TENANT_MD}/mega-talento/_prueba.txt`;
    await subir(key, Buffer.from('prueba de la carga de archivos de Mega Talento'), 'text/plain');
    await s3.send(new HeadObjectCommand({ Bucket: cfg.bucket, Key: key }));
  };
  return subir;
}

async function main() {
  const arg = (n) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : null; };
  const aplicar = process.argv.includes('--aplicar');
  const destinoProd = process.argv.includes('--destino-prod');
  const limite = arg('--limite') ? Number(arg('--limite')) : null;
  if (aplicar && limite) throw new Error('--limite es para el ensayo: con --aplicar se mueve todo.');
  try { require('dotenv').config({ path: process.env.DOTENV_PATH || path.resolve(__dirname, '../../../.env') }); } catch { /* sin dotenv */ }
  let url;
  if (destinoProd) {
    url = process.env.CARGA_URL;
    if (!url) throw new Error('--destino-prod necesita CARGA_URL (dentro del pod: CARGA_URL="$DATABASE_URL_NEW").');
  } else {
    require('../../tests/_lib/assert-safe-target').assertSafeTarget('carga-archivos-mega-talento');
    url = process.env.DATABASE_URL_NEW;
  }
  const subir = aplicar ? subidorS3() : null;
  if (subir) await subir.probar();
  const knex = require('knex')({ client: 'pg', connection: url, pool: { min: 0, max: 1 } });
  const t0 = Date.now();
  const DESHACER = new Error('ensayo');
  try {
    if (destinoProd) await require('./carga-unica-mega-talento').verificarDestinoProd(knex);
    await knex.transaction(async (trx) => {
      await trx.raw(`SELECT set_config('app.tenant_id', ?, true)`, [TENANT_MD]);
      console.log(`Archivos de Mega Talento → ${destinoProd ? 'PROD · ' : ''}${aplicar ? 'SE SUBEN Y SE ESCRIBEN' : 'ENSAYO (baja, no sube, se deshace)'}`);
      await cargarArchivos(trx, { bajar: bajarHttp, subir, limite, log: console.log });
      console.log(`\nListo en ${Math.round((Date.now() - t0) / 1000)} s.`);
      if (!aplicar) throw DESHACER;
    });
  } catch (e) {
    if (e !== DESHACER) throw e;
    console.log('Ensayo: no quedó nada escrito ni subido.');
  } finally {
    await knex.destroy();
  }
}

if (require.main === module) {
  main().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
}

module.exports = { cargarArchivos, llaveDe, ORIGENES_MT };
