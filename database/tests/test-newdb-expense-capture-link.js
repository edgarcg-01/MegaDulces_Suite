/**
 * GX.9 — smoke de la captura de gasto por link.
 *
 * Recorre el ciclo completo contra la API viva: emitir el link → abrirlo como lo abriría el
 * trabajador (sin sesión) → subir las fotos → mandar el gasto → verlo en la bandeja «sin
 * folio» → ligarlo a una solicitud de Kepler → comprobar que salió de la bandeja.
 *
 * Y lo que NO debe pasar, que es la mitad del valor: que un link revocado siga sirviendo, que
 * la superficie pública devuelva algo de la empresa, que una captura sin folio se cuele al
 * mapa folio→expediente del tablero, o que se cierre sola porque el OCR cuadró.
 *
 * Los JWT se firman acá con el mismo `JWT_SECRET` que verifica la API: el smoke no tiene
 * contraseña de nadie y no debe necesitarla.
 *
 *   node database/tests/test-newdb-expense-capture-link.js
 */
'use strict';
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env') });
const jwt = require('jsonwebtoken');
const { Client } = require('pg');

const API = process.env.SMOKE_API_URL || 'http://127.0.0.1:3334/api';
const TENANT = '00000000-0000-0000-0000-00000000d01c';
const SECRET = process.env.JWT_SECRET;

let ok = 0, fail = 0;
const check = (cond, label, extra) => {
  if (cond) { ok++; console.log(`  ok   ${label}`); }
  else { fail++; console.log(`  FALLA ${label}${extra ? ` → ${extra}` : ''}`); }
};

/**
 * Login real, como el resto de los smokes del repo. Firmar el JWT a mano parecía más
 * directo, pero el secreto del proceso que está sirviendo no tiene por qué ser el del
 * `.env` de esta shell — y además así se ejercita el camino de auth de verdad.
 */
async function adminToken() {
  const r = await fetch(`${API}/auth-mt/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tenant_slug: 'mega_dulces', username: 'superoot', password: 'superoot' }),
  });
  const j = await r.json().catch(() => ({}));
  if (!j?.access_token) throw new Error(`login falló (status ${r.status}): ${JSON.stringify(j)}`);
  return j.access_token;
}

async function api(method, url, { token, body } = {}) {
  const res = await fetch(`${API}${url}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch { /* 204 y errores sin cuerpo */ }
  return { status: res.status, body: json };
}

/** Un PNG 1x1 real, para no depender de archivos en disco. */
const PNG_1X1 = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

(async () => {
  if (!SECRET) { console.error('Falta JWT_SECRET en .env (hace falta para el caso del token con firma ajena)'); process.exit(1); }
  const db = new Client({ connectionString: process.env.DATABASE_URL_NEW });
  await db.connect();
  const admin = await adminToken();
  let linkId = null;
  const creados = [];

  try {
    console.log('\n── 1. Emitir el link ────────────────────────────────────────');
    const em = await api('POST', '/finance/expenses/capture-links', {
      token: admin, body: { persona: 'smoke gx9 trabajador', sucursal: '00', nota: 'smoke' },
    });
    check(em.status === 201 || em.status === 200, 'se emite el link', `status ${em.status}`);
    check(!!em.body?.url && !!em.body?.token, 'devuelve URL y token para compartir');
    linkId = em.body?.id;
    const capToken = em.body?.token;
    check(em.body?.persona === 'SMOKE GX9 TRABAJADOR', 'la persona se guarda normalizada', em.body?.persona);

    console.log('\n── 2. Abrirlo como el trabajador (sin sesión) ───────────────');
    const ctx = await api('GET', `/finance/captura/${capToken}`);
    check(ctx.status === 200, 'el link abre sin Authorization', `status ${ctx.status}`);
    check(ctx.body?.persona === 'SMOKE GX9 TRABAJADOR', 'se identifica solo, no lo teclea');
    check(Array.isArray(ctx.body?.sucursales) && ctx.body.sucursales.length > 0, 'trae el catálogo de sucursales');
    check(Array.isArray(ctx.body?.capturas) && ctx.body.capturas.length === 0, 'arranca sin capturas previas');
    // La superficie pública no debe filtrar NADA de la empresa.
    const fuga = JSON.stringify(ctx.body || {});
    check(!/folio|kepler|XA15/i.test(fuga), 'no devuelve nada de Kepler ni folios ajenos');

    console.log('\n── 3. Subir fotos y mandar el gasto ─────────────────────────');
    // El bucket (S3_*) NO está configurado en local: las env existen pero vienen vacías. Es
    // carencia del entorno, previa a esta fase — el flujo interno de captura sube por el MISMO
    // `storage.putFile` y falla igual. Se detecta y se DICE, en vez de quedar en rojo eterno:
    // un smoke rojo por el entorno deja de leerse, y entonces ya no avisa de nada.
    const up1 = await api('POST', `/finance/captura/${capToken}/upload`, { body: { file_base64: PNG_1X1, role: 'solicitud_kepler' } });
    const sinBucket = up1.status === 400 && /Almacenamiento no configurado/i.test(up1.body?.message || '');

    let files;
    if (sinBucket) {
      console.log('  SKIP  el bucket no está configurado (S3_* vacías) — NO se prueba que los bytes lleguen.');
      console.log('        El resto sí: se fabrican las referencias de archivo, que es lo único');
      console.log('        que mira el servicio (role + url).');
      files = [
        { role: 'solicitud_kepler', url: 'smoke/gx9/solicitud.jpg', public_id: 'smoke/gx9/solicitud.jpg', kind: 'image' },
        { role: 'comprobante_1', url: 'smoke/gx9/ticket.jpg', public_id: 'smoke/gx9/ticket.jpg', kind: 'image' },
      ];
    } else {
      check(up1.status === 201 || up1.status === 200, 'sube la solicitud firmada', `status ${up1.status} ${JSON.stringify(up1.body)}`);
      const up2 = await api('POST', `/finance/captura/${capToken}/upload`, { body: { file_base64: PNG_1X1, role: 'comprobante_1' } });
      check(up2.status === 201 || up2.status === 200, 'sube el ticket', `status ${up2.status}`);
      files = [up1.body, up2.body].filter(Boolean);
    }

    // Guardas de contenido: no dependen del bucket, así que se prueban siempre.
    const faltaFirmada = await api('POST', `/finance/captura/${capToken}`, {
      body: { importe: 10, concepto: 'x', beneficiario: 'x', sucursal: '00', clasificacion: 'fiscal', files: [] },
    });
    check(faltaFirmada.status === 400 && /solicitud firmada/i.test(faltaFirmada.body?.message || ''),
      'sin la solicitud firmada NO deja mandar', JSON.stringify(faltaFirmada.body));
    const sinMotivo = await api('POST', `/finance/captura/${capToken}`, {
      body: { importe: 10, concepto: 'x', beneficiario: 'x', sucursal: '00', clasificacion: 'no_comprobable', files: [files[0]] },
    });
    check(sinMotivo.status === 400 && /por qu/i.test(sinMotivo.body?.message || ''),
      'un gasto no comprobable exige motivo', JSON.stringify(sinMotivo.body));
    const sub = await api('POST', `/finance/captura/${capToken}`, {
      body: {
        importe: 1234.56, concepto: 'smoke gx9 gasolina', beneficiario: 'GASOLINERA SMOKE',
        sucursal: '00', clasificacion: 'no_fiscal_comprobable', files,
        camera: 'live', captured_at: new Date().toISOString(), user_agent: 'smoke',
      },
    });
    check(sub.status === 201 || sub.status === 200, 'manda el gasto', `status ${sub.status} ${JSON.stringify(sub.body)}`);
    if (sub.body?.id) creados.push(sub.body.id);

    const row = (await db.query(
      `SELECT folio_solicitud, status, origen, capture_link_id, solicitante, importe::numeric, capture_meta
         FROM finance.expense_proofs WHERE id=$1`, [sub.body?.id])).rows[0];
    check(row?.folio_solicitud === null, 'queda SIN folio (es la novedad de la fase)');
    check(row?.origen === 'link', 'queda marcado como venido del link');
    check(row?.status === 'recibida', 'NUNCA se auto-valida, aunque el OCR cuadre', `status ${row?.status}`);
    check(row?.capture_link_id === linkId, 'queda ligado a su link');
    check(row?.solicitante === 'SMOKE GX9 TRABAJADOR', 'el solicitante sale del token, no del formulario');
    check(row?.capture_meta?.camera === 'live', 'guarda si la cámara fue en vivo');

    console.log('\n── 4. El tablero de folios NO se ensucia ────────────────────');
    const mapa = await api('GET', '/finance/expenses/proofs/status-by-folio', { token: admin });
    check(mapa.status === 200, 'el mapa folio→expediente responde');
    check(!Object.prototype.hasOwnProperty.call(mapa.body || {}, 'null'), 'la captura sin folio NO entra como clave null');

    console.log('\n── 5. La bandeja «sin folio» ────────────────────────────────');
    const band = await api('GET', '/finance/expenses/proofs/sin-folio', { token: admin });
    check(band.status === 200, 'la bandeja responde');
    const mia = (band.body?.rows || []).find((r) => r.id === sub.body?.id);
    check(!!mia, 'la captura aparece en la bandeja');
    check(mia?.fotos === 2, 'cuenta las 2 fotos', `fotos=${mia?.fotos}`);
    check(mia?.tiene_solicitud === true, 'sabe que trae la solicitud firmada');

    console.log('\n── 6. Ligarla con una solicitud de Kepler ───────────────────');
    const sol = (await db.query(
      `SELECT folio, importe::numeric AS importe FROM analytics.expense_requests
        WHERE tenant_id=$1 ORDER BY fecha DESC LIMIT 1`, [TENANT])).rows[0];
    if (!sol) {
      console.log('  SKIP  no hay solicitudes en analytics.expense_requests (kepler_ods vacío en esta DB)');
      console.log('        el paso de ligar NO se puede probar acá — ver platform_test');
    } else {
      const mt = await api('POST', `/finance/expenses/proofs/${sub.body.id}/match`, { token: admin, body: { folio: sol.folio } });
      check(mt.status === 201 || mt.status === 200, 'liga la captura con su folio', `status ${mt.status} ${JSON.stringify(mt.body)}`);
      const after = (await db.query(
        `SELECT folio_solicitud, importe::numeric AS importe, capture_meta FROM finance.expense_proofs WHERE id=$1`,
        [sub.body.id])).rows[0];
      check(after?.folio_solicitud === sol.folio, 'le queda el folio puesto');
      check(Number(after?.importe) === Number(sol.importe), 'el importe pasa a ser el de Kepler');
      check(Number(after?.capture_meta?.importe_declarado) === 1234.56, 'conserva lo que declaró el trabajador');

      const band2 = await api('GET', '/finance/expenses/proofs/sin-folio', { token: admin });
      check(!(band2.body?.rows || []).some((r) => r.id === sub.body.id), 'sale de la bandeja al ligarse');
    }

    console.log('\n── 7. Revocar corta el acceso al instante ───────────────────');
    const rv = await api('DELETE', `/finance/expenses/capture-links/${linkId}`, { token: admin });
    check(rv.status === 200, 'se revoca el link', `status ${rv.status}`);
    const despues = await api('GET', `/finance/captura/${capToken}`);
    check(despues.status === 403, 'el MISMO token deja de servir sin esperar a que expire', `status ${despues.status}`);
    const subDespues = await api('POST', `/finance/captura/${capToken}`, {
      body: { importe: 1, concepto: 'x', beneficiario: 'x', sucursal: '00', clasificacion: 'no_comprobable', comentarios: 'x', files: [] },
    });
    check(subDespues.status === 403, 'tampoco deja subir después de revocado', `status ${subDespues.status}`);

    console.log('\n── 8. Token inventado ───────────────────────────────────────');
    const falso = await api('GET', '/finance/captura/esto.no.es.un.token');
    check(falso.status === 403, 'un token inventado se rechaza', `status ${falso.status}`);
    const otroSecreto = jwt.sign({ t: 'expense_capture', lid: linkId, tenant_id: TENANT }, 'secreto-equivocado', { algorithm: 'HS256' });
    const firmaMala = await api('GET', `/finance/captura/${otroSecreto}`);
    check(firmaMala.status === 403, 'un token firmado con otro secreto se rechaza', `status ${firmaMala.status}`);

  } finally {
    // Limpieza: el smoke no deja basura en la bandeja de nadie.
    if (creados.length) await db.query(`DELETE FROM finance.expense_proofs WHERE id = ANY($1::uuid[])`, [creados]);
    if (linkId) await db.query(`DELETE FROM finance.expense_capture_links WHERE id=$1`, [linkId]);
    await db.end();
    console.log(`\n${'─'.repeat(60)}\n${ok} ok · ${fail} fallas\n`);
    process.exit(fail ? 1 : 0);
  }
})().catch((e) => { console.error('\nEXPLOTÓ:', e.message); process.exit(1); });
