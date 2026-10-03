/**
 * `[MS.2.4]` Adjuntos de la Mesa de Servicio contra un bucket S3 REAL — el pedazo que el E2E principal
 * (`http-service-desk-test.js`) declara «NO MEDIDO» cuando no hay bucket: el adjunto VÁLIDO de punta a punta.
 *
 * Qué se defiende, contra un servidor S3 de verdad (no un mock en memoria del proceso):
 *   1. Un PNG y un PDF honestos se suben, quedan ligados al ticket y su URL prefirmada devuelve LOS MISMOS BYTES.
 *   2. El objeto existe en el bucket con el tamaño y el tipo correctos, bajo `service-desk/requests/`.
 *   3. Un adjunto también entra por un mensaje del hilo.
 *   4. ⭐ Lo rechazado NO deja basura: un HTML disfrazado de PNG, un adjunto vacío y uno que excede el tope fallan
 *      sin escribir NADA al bucket.
 *   5. ⭐ Si la transacción falla DESPUÉS de subir (la categoría exige sucursal y no se mandó), el servicio borra
 *      del bucket lo que ya había subido: ni ticket huérfano ni objeto huérfano.
 *   6. La URL prefirmada es del ticket: quien no tiene acceso al ticket no la recibe, y una URL con la firma
 *      alterada el bucket la rechaza.
 *
 * Pre-requisitos: API en :3334 **arrancada con las mismas variables S3_*** que este script, y un bucket S3
 * (cualquiera: MinIO, Cloudflare R2, Zenko CloudServer). Sin `S3_ENDPOINT` el script SE SALTA con exit 0 y lo dice:
 * un test que no puede medir no se pinta de verde.
 *
 *   S3_ENDPOINT=http://localhost:8000 S3_BUCKET=ms-adjuntos S3_ACCESS_KEY_ID=... S3_SECRET_ACCESS_KEY=... \
 *   node database/tests/http-service-desk-attachments-s3-test.js
 *
 * Crea el bucket si no existe y BORRA al final todo objeto que él creó (lista antes y después).
 */
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env'), quiet: true });

if (!process.env.S3_ENDPOINT || !process.env.S3_BUCKET || !process.env.S3_ACCESS_KEY_ID || !process.env.S3_SECRET_ACCESS_KEY) {
  console.log('\n  ⚠️  NO MEDIDO: faltan S3_ENDPOINT / S3_BUCKET / S3_ACCESS_KEY_ID / S3_SECRET_ACCESS_KEY.');
  console.log('     El adjunto válido de punta a punta necesita un bucket real; este test no se pinta de verde sin uno.\n');
  process.exit(0);
}

const knex = require('knex')(require('../knexfile-newdb.js').development);
const bcrypt = require('bcryptjs');
const { S3Client, ListObjectsV2Command, HeadObjectCommand, DeleteObjectCommand, CreateBucketCommand, HeadBucketCommand } = require('@aws-sdk/client-s3');

const BASE = 'http://localhost:3334/api';
const T = process.env.TENANT_ID || '00000000-0000-0000-0000-00000000d01c';
const SUF = String(Date.now()).slice(-8);
const PASS_PLANO = `Smoke!${SUF}`;
const SD = '/service-desk';
const BUCKET = process.env.S3_BUCKET;
const PREFIJO = 'service-desk/requests/';

const s3 = new S3Client({
  region: process.env.S3_REGION || 'auto',
  endpoint: process.env.S3_ENDPOINT,
  credentials: { accessKeyId: process.env.S3_ACCESS_KEY_ID, secretAccessKey: process.env.S3_SECRET_ACCESS_KEY },
  forcePathStyle: true,
});

let pass = 0;
let fail = 0;
const check = (name, cond, det) => {
  if (cond) { console.log(`  ✅ ${name}`); pass++; } else { console.log(`  ❌ ${name}${det ? ' — ' + det : ''}`); fail++; }
};

async function req(method, p, token, body) {
  const r = await fetch(BASE + p, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text();
  let json; try { json = JSON.parse(t); } catch { json = t; }
  return { status: r.status, body: json };
}
const dump = (r) => `status ${r.status} ${JSON.stringify(r.body).slice(0, 160)}`;

async function crearUsuario(etiqueta, overrides = []) {
  const username = `smoke_s3_${etiqueta}_${SUF}`.slice(0, 40);
  const [{ id }] = await knex('identity.users')
    .insert({ tenant_id: T, username, nombre: `SMOKE ${etiqueta}`, password_hash: await bcrypt.hash(PASS_PLANO, 10), role_name: 'colaborador' })
    .returning('id');
  for (const k of overrides) await knex('identity.user_permissions').insert({ tenant_id: T, user_id: id, permission_key: k, allow: true, nota: 'smoke adjuntos s3' });
  const r = await req('POST', '/auth-mt/login', null, { tenant_slug: 'mega_dulces', username, password: PASS_PLANO });
  return { id, username, token: r.body?.access_token ?? null };
}

/** Todas las llaves del bucket bajo el prefijo de la mesa. */
async function llaves() {
  const out = [];
  let token;
  do {
    const r = await s3.send(new ListObjectsV2Command({ Bucket: BUCKET, Prefix: PREFIJO, ContinuationToken: token }));
    for (const o of r.Contents ?? []) out.push(o.Key);
    token = r.IsTruncated ? r.NextContinuationToken : undefined;
  } while (token);
  return out;
}

const PNG_1X1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const PDF_MIN = Buffer.from('%PDF-1.1\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 10 10]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF');
const dataUri = (mime, buf) => `data:${mime};base64,${buf.toString('base64')}`;

(async () => {
  console.log('\n=== [MS.2.4] Adjuntos de la mesa contra un bucket S3 real ===\n');
  const usuarios = [];
  let ajustes = null;
  let antes = [];
  try {
    // El bucket tiene que existir: se crea si falta (idempotente).
    try { await s3.send(new HeadBucketCommand({ Bucket: BUCKET })); } catch { await s3.send(new CreateBucketCommand({ Bucket: BUCKET })); }
    antes = await llaves();
    console.log(`0 — bucket «${BUCKET}» en ${process.env.S3_ENDPOINT} (${antes.length} objeto(s) previos bajo ${PREFIJO})`);

    const sol = await crearUsuario('solicitante');
    const otro = await crearUsuario('otro');
    const agente = await crearUsuario('agente', ['SERVICIO_ATENDER']);
    const coord = await crearUsuario('coord', ['SERVICIO_ATENDER', 'SERVICIO_COORDINAR']);
    usuarios.push(sol, otro, agente, coord);
    for (const u of usuarios) check(`login de ${u.username}`, !!u.token);
    if (usuarios.some((u) => !u.token)) return;

    const cat = await req('GET', `${SD}/catalog`, sol.token);
    const catLibre = (cat.body?.categories ?? []).find((c) => !c.requires_branch);
    const catSucursal = (cat.body?.categories ?? []).find((c) => c.requires_branch);
    check('hay una categoría libre y una que exige sucursal', !!catLibre && !!catSucursal);
    if (!catLibre || !catSucursal) return;
    ajustes = await knex('servicedesk.settings').where({ tenant_id: T }).first('max_attachment_mb');

    // ── 1–2. Un PNG y un PDF honestos: de punta a punta ─────────────────────────────
    console.log('\n1 — el adjunto VÁLIDO de punta a punta');
    const t1 = await req('POST', `${SD}/requests`, sol.token, {
      category_id: catLibre.id, title: 'SMOKE S3: con foto y PDF',
      attachments: [{ file_base64: dataUri('image/png', PNG_1X1), file_name: 'captura.png' }, { file_base64: dataUri('application/pdf', PDF_MIN), file_name: 'factura.pdf' }],
    });
    check('⭐ el alta con PNG + PDF responde 201', t1.status === 201, dump(t1));
    const adj = t1.body?.attachments ?? [];
    check('quedan DOS adjuntos ligados al ticket, con su tipo real', adj.length === 2 && adj.some((a) => a.content_type === 'image/png') && adj.some((a) => a.content_type === 'application/pdf'), JSON.stringify(adj.map((a) => [a.file_name, a.content_type])));
    const png = adj.find((a) => a.content_type === 'image/png');
    const pdf = adj.find((a) => a.content_type === 'application/pdf');

    const bajar = async (url) => { const r = await fetch(url); return { status: r.status, tipo: r.headers.get('content-type'), buf: Buffer.from(await r.arrayBuffer()) }; };
    const dPng = png?.url ? await bajar(png.url) : null;
    check('⭐ la URL prefirmada del PNG devuelve los MISMOS BYTES (sin cabecera de autorización)', dPng?.status === 200 && dPng.buf.equals(PNG_1X1), `${dPng?.status} ${dPng?.buf?.length}b`);
    check('…con el tipo de contenido correcto', /image\/png/.test(dPng?.tipo ?? ''), dPng?.tipo);
    const dPdf = pdf?.url ? await bajar(pdf.url) : null;
    check('⭐ y la del PDF también, byte a byte', dPdf?.status === 200 && dPdf.buf.equals(PDF_MIN), `${dPdf?.status} ${dPdf?.buf?.length}b`);

    const fila = await knex('servicedesk.request_attachments').where({ request_id: t1.body?.id }).select('storage_key', 'size_bytes', 'content_type');
    check('la base guarda la llave, el tamaño y el tipo reales', fila.length === 2 && fila.every((f) => f.storage_key.startsWith(PREFIJO)) && fila.some((f) => Number(f.size_bytes) === PNG_1X1.length), JSON.stringify(fila));
    const heads = await Promise.all(fila.map((f) => s3.send(new HeadObjectCommand({ Bucket: BUCKET, Key: f.storage_key })).catch(() => null)));
    check('⭐ los dos objetos EXISTEN en el bucket con el tamaño que dice la base', heads.every(Boolean) && fila.every((f, i) => Number(heads[i].ContentLength) === Number(f.size_bytes)), JSON.stringify(heads.map((h) => h?.ContentLength)));
    check('el tipo guardado en el bucket es el declarado y validado por firma', heads.some((h) => h?.ContentType === 'image/png') && heads.some((h) => h?.ContentType === 'application/pdf'), JSON.stringify(heads.map((h) => h?.ContentType)));

    // ── 3. Por un mensaje del hilo ──────────────────────────────────────────────────
    console.log('\n2 — un adjunto también entra por el hilo');
    const m1 = await req('POST', `${SD}/requests/${t1.body?.id}/messages`, sol.token, { body: 'Te dejo otra foto', attachments: [{ file_base64: dataUri('image/png', PNG_1X1), file_name: 'otra.png' }] });
    check('⭐ comentar con foto → 201 y el ticket ya trae tres adjuntos', m1.status < 300 && (m1.body?.attachments ?? []).length === 3, dump(m1));
    const nuevo = (m1.body?.attachments ?? []).find((a) => a.file_name === 'otra.png');
    const dNuevo = nuevo?.url ? await bajar(nuevo.url) : null;
    check('y el del mensaje se puede descargar', dNuevo?.status === 200 && dNuevo.buf.equals(PNG_1X1));

    // ── 4. Lo rechazado no deja basura ──────────────────────────────────────────────
    console.log('\n3 — lo rechazado NO escribe nada al bucket');
    const base = (await llaves()).length;
    const html = Buffer.from('<html><script>alert(document.cookie)</script></html>');
    check('HTML disfrazado de PNG → 400', (await req('POST', `${SD}/requests`, sol.token, { category_id: catLibre.id, title: 'x', attachments: [{ file_base64: dataUri('image/png', html), file_name: 'foto.png' }] })).status === 400);
    check('adjunto vacío → 400', (await req('POST', `${SD}/requests`, sol.token, { category_id: catLibre.id, title: 'x', attachments: [{ file_base64: 'data:image/png;base64,', file_name: 'a.png' }] })).status === 400);
    // Un tope de 1 MB y un PNG VÁLIDO por firma pero de 1.2 MB: debe rechazarse antes de tocar el bucket.
    await knex('servicedesk.settings').where({ tenant_id: T }).update({ max_attachment_mb: 1 });
    const grande = Buffer.concat([PNG_1X1, Buffer.alloc(1.2 * 1024 * 1024, 7)]);
    const rGrande = await req('POST', `${SD}/requests`, sol.token, { category_id: catLibre.id, title: 'x', attachments: [{ file_base64: dataUri('image/png', grande), file_name: 'grande.png' }] });
    check('⭐ un archivo que excede el tope configurado (1 MB) → 400', rGrande.status === 400, dump(rGrande));
    await knex('servicedesk.settings').where({ tenant_id: T }).update({ max_attachment_mb: Number(ajustes.max_attachment_mb) });
    check('⭐ NADA de eso escribió al bucket', (await llaves()).length === base, `${base} → ${(await llaves()).length}`);

    // ── 5. La transacción falla DESPUÉS de subir ────────────────────────────────────
    console.log('\n4 — si la base falla después de subir, no queda objeto huérfano');
    const nTickets = Number((await knex('servicedesk.requests').where({ tenant_id: T }).count({ n: '*' }).first()).n);
    const r5 = await req('POST', `${SD}/requests`, sol.token, { category_id: catSucursal.id, title: 'SMOKE S3: sin sucursal', attachments: [{ file_base64: dataUri('image/png', PNG_1X1), file_name: 'huerfana.png' }] });
    check('⭐ la categoría exige sucursal y no se mandó → 400 (falla DESPUÉS de haber subido)', r5.status === 400, dump(r5));
    check('⭐ el servicio BORRÓ del bucket lo que ya había subido (ni objeto huérfano)', (await llaves()).length === base, `${base} → ${(await llaves()).length}`);
    check('y no quedó ticket huérfano', Number((await knex('servicedesk.requests').where({ tenant_id: T }).count({ n: '*' }).first()).n) === nTickets);

    // ── 6. La URL es del ticket ─────────────────────────────────────────────────────
    console.log('\n5 — quién recibe la URL');
    const ajeno = await req('GET', `${SD}/requests/${t1.body?.id}`, otro.token);
    check('⭐ quien NO es del ticket no lo ve, y por tanto NO recibe ninguna URL → 404', ajeno.status === 404 && !JSON.stringify(ajeno.body).includes('X-Amz-Signature'), dump(ajeno));
    const deAgente = await req('GET', `${SD}/requests/${t1.body?.id}`, agente.token);
    check('quien atiende sí recibe las URLs', (deAgente.body?.attachments ?? []).length === 3 && deAgente.body.attachments.every((a) => !!a.url));
    const alterada = png.url.replace(/X-Amz-Signature=[0-9a-f]+/i, 'X-Amz-Signature=' + '0'.repeat(64));
    const dAlt = await fetch(alterada);
    check('⭐ una URL con la firma ALTERADA la rechaza el bucket (403)', dAlt.status === 403, `status ${dAlt.status}`);
    check('la URL declara caducidad (no es permanente)', /X-Amz-Expires=\d+/i.test(png.url), png.url.slice(0, 200));
  } finally {
    if (ajustes) await knex('servicedesk.settings').where({ tenant_id: T }).update({ max_attachment_mb: Number(ajustes.max_attachment_mb) });
    // Se borra del bucket SÓLO lo que este script creó (lo que no estaba en la lista de antes).
    let borrados = 0;
    try {
      const antesSet = new Set(antes);
      for (const k of await llaves()) if (!antesSet.has(k)) { await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: k })); borrados++; }
    } catch (e) { console.log(`  ⚠️ no se pudo limpiar el bucket: ${e.message}`); }
    const ids = usuarios.map((u) => u.id);
    if (ids.length) {
      const reqs = (await knex('servicedesk.requests').whereIn('requester_id', ids).select('id')).map((r) => r.id);
      await knex('servicedesk.notification_log').whereIn('recipient_id', ids).del();
      if (reqs.length) {
        await knex('servicedesk.notification_log').whereIn('request_id', reqs).del();
        await knex('servicedesk.work_log').whereIn('request_id', reqs).del();
        await knex('servicedesk.request_attachments').whereIn('request_id', reqs).del();
        await knex('servicedesk.request_messages').whereIn('request_id', reqs).del();
        await knex('servicedesk.requests').whereIn('id', reqs).del();
      }
      await knex('servicedesk.notification_prefs').whereIn('user_id', ids).del();
      await knex('identity.user_permissions').whereIn('user_id', ids).del();
      await knex('identity.user_roles').whereIn('user_id', ids).del();
      await knex('identity.users').whereIn('id', ids).del();
    }
    console.log(`\n  (limpieza: ${borrados} objeto(s) del bucket y ${ids.length} usuario(s) de prueba)`);
    await knex.destroy();
  }
  console.log(`\n=== ${pass} ✅  ${fail} ❌ ===`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
