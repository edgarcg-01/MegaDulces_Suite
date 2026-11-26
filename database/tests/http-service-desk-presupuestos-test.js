/* eslint-disable no-console */
/**
 * `[MSP.2]` — **Mesa de Servicio: un área como Presupuestos y Requerimientos, por HTTP, con permiso mínimo y sus negativas.**
 * Plan: `docs/IMPLEMENTACION/FASES/FASE_MSP_PRESUPUESTOS_Y_REQUERIMIENTOS.md`.
 *
 * No depende de la siembra (`[MSP.0.2]`): arma DOS colas efímeras con los MISMOS valores (`smoke_pres_*` y `smoke_mto_*`) y las borra al
 * final. Sí depende del ESQUEMA (`[MSP.0.1]`): si la base no lo tiene, aborta y lo dice.
 *
 * Usuarios efímeros, todos con el rol `colaborador` (sólo `SERVICIO_REPORTAR`) para que ninguna puerta salga verde por god-mode:
 *   · encargado  — puesto PERMITIDO por la cola; sólo reporta.
 *   · cajera     — puesto NO permitido; sólo reporta.
 *   · coordPres  — coordina la cola de Presupuestos (Ernesto).
 *   · tecMto     — atiende la cola destino (Mantenimiento).
 *   · coordTi    — coordina TI: no es de Presupuestos.
 *
 * La matriz (cada negativa con su control):
 *    1. catálogo: el área se ofrece al puesto permitido y a su coordinación; NO a la cajera, que sí ve TI.
 *    2. alta: la cajera → 403 (y el mensaje dice quién sí); sin descripción / sin observaciones / sin evidencia → 400; completa → OK.
 *    3. a nombre de otra persona: la coordinación a nombre de la cajera → 403; a nombre del encargado → OK.
 *    4. dictamen: lo da sólo la coordinación del área (TI → 404, el solicitante → 403); valor inventado o sin motivo → 400.
 *    5. resolver sin dictamen → 409; «no autorizada» no genera orden (409); corregir a «autorizada» → OK y el solicitante lo ve.
 *    6. orden de servicio: sin tomar → 409; a un área fuera de la lista → 400; sin riesgo en Mantenimiento → 400; completa → OK;
 *       nace a nombre del encargado, con su sucursal y su evidencia; el padre queda en espera (`orden_servicio`).
 *    7. con la orden en marcha el dictamen ya no se cambia (409); el comentario del solicitante NO reanuda al padre.
 *    8. resolver la orden → el padre se resuelve SOLO, con la nota de la orden.
 *    9. una orden cancelada NO resuelve al padre: se anota y espera a la coordinación.
 *   10. CONTROL: TI sigue igual (cualquiera levanta, sin descripción, sin dictamen).
 *
 * Pre-requisitos: API en :3334 levantada DESDE el código que trae `[MSP.2]`, y `[MSP.0.1]` aplicada en la base local.
 * Uso: node database/tests/http-service-desk-presupuestos-test.js
 */
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env'), quiet: true });
const knex = require('knex')(require('../knexfile-newdb.js').development);
require('./_lib/assert-safe-target').assertSafeTarget('http-service-desk-presupuestos-test');
const bcrypt = require('bcryptjs');

const BASE = process.env.SD_API_BASE || 'http://localhost:3334/api';
const T = process.env.TENANT_ID || '00000000-0000-0000-0000-00000000d01c';
const SUF = String(Date.now()).slice(-8);
const PASS_PLANO = `Smoke!${SUF}`;
const SD = '/service-desk';
const ROL_BASE = 'colaborador';
const PNG_1X1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const dataUri = (mime, buf) => `data:${mime};base64,${buf.toString('base64')}`;

let pass = 0;
let fail = 0;
const noMedido = [];
const check = (name, cond, det) => {
  if (cond) { console.log(`  ✅ ${name}`); pass++; } else { console.log(`  ❌ ${name}${det ? ' — ' + det : ''}`); fail++; }
};
async function req(method, p, token, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const r = await fetch(`${BASE}${p}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let json = null;
  try { json = await r.json(); } catch { /* sin cuerpo */ }
  return { status: r.status, body: json };
}
const dump = (r) => `status ${r.status} ${JSON.stringify(r.body).slice(0, 180)}`;
const okHttp = (r) => r.status === 200 || r.status === 201;

/** Cada usuario se anota AL INSERTARLO: si el login truena después (API reiniciando), la limpieza igual lo borra. */
const creados = [];
async function crearUsuario(etiqueta, { puesto = null, permisos = [], membresias = [], sucursal = null } = {}) {
  const username = `smoke_msp_${etiqueta}_${SUF}`.slice(0, 40);
  const [{ id }] = await knex('identity.users')
    .insert({ tenant_id: T, username, nombre: `SMOKE MSP ${etiqueta}`, password_hash: await bcrypt.hash(PASS_PLANO, 10), role_name: ROL_BASE, position_code: puesto, warehouse_code: sucursal })
    .returning('id');
  creados.push(id);
  for (const k of permisos) await knex('identity.user_permissions').insert({ tenant_id: T, user_id: id, permission_key: k, allow: true, nota: 'smoke http-service-desk-presupuestos-test' });
  for (const m of membresias) await knex('servicedesk.queue_members').insert({ tenant_id: T, queue_id: m.queue_id, user_id: id, role: m.role });
  const r = await req('POST', '/auth-mt/login', null, { tenant_slug: 'mega_dulces', username, password: PASS_PLANO });
  return { id, username, token: r.body?.access_token ?? null, loginStatus: r.status };
}

(async () => {
  console.log('\n=== [MSP.2] Presupuestos y Requerimientos por HTTP — permiso mínimo y negativas ===\n');
  const usuarios = [];
  const colas = [];
  try {
    const tiene = await knex.schema.withSchema('servicedesk').hasColumn('queues', 'requires_decision');
    if (!tiene) {
      console.log('  ⛔ la base local NO tiene el esquema de [MSP.0.1] (20261118132504_servicedesk_presupuestos_esquema): aplícalo primero.');
      fail++;
      return;
    }
    // Dos puestos reales de la base local: uno que la cola acepta y otro que no.
    const puestos = await knex('identity.positions').where({ tenant_id: T }).orderBy('code').limit(2).pluck('code');
    if (puestos.length < 2) throw new Error('la base local necesita al menos 2 puestos en identity.positions');
    const [PUESTO_OK, PUESTO_NO] = puestos;

    // ── 0. Las dos colas efímeras (los mismos valores que la siembra real) ──
    console.log('0 — colas y usuarios de prueba (se borran al final)');
    const [mto] = await knex('servicedesk.queues')
      .insert({ tenant_id: T, code: `smoke_mto_${SUF}`, name: `SMOKE Mantenimiento ${SUF}`, priority_model: 'riesgo_operacion', active: true, sort_order: 998 })
      .returning(['id', 'code', 'name']);
    colas.push(mto.id);
    const [pres] = await knex('servicedesk.queues')
      .insert({
        tenant_id: T, code: `smoke_pres_${SUF}`, name: `SMOKE Presupuestos ${SUF}`, priority_model: 'impacto', active: true, sort_order: 999,
        uses_priority: false, sla_enabled: false, requires_description: true, requires_decision: true,
        requester_positions: knex.raw('?::text[]', [[PUESTO_OK]]), work_order_queue_codes: knex.raw('?::text[]', [[mto.code]]),
      })
      .returning(['id', 'code', 'name']);
    colas.push(pres.id);
    const [catPres] = await knex('servicedesk.categories').insert({ tenant_id: T, queue_id: pres.id, code: `smoke_gastos_${SUF}`, name: 'Gastos operativos', default_priority: 'media', requires_branch: true }).returning('id');
    const [catMto] = await knex('servicedesk.categories').insert({ tenant_id: T, queue_id: mto.id, code: `smoke_cortina_${SUF}`, name: 'Cortinas', default_priority: 'media', requires_branch: false }).returning('id');
    const ti = await knex('servicedesk.queues').where({ tenant_id: T, code: 'ti' }).first('id');
    const catTi = await knex('servicedesk.categories').where({ tenant_id: T, queue_id: ti.id, active: true }).whereNull('deleted_at').first('id');
    await knex('servicedesk.queue_fields').insert([
      { tenant_id: T, queue_id: pres.id, code: 'observaciones', label: 'Observaciones', type: 'text', required: true, sort_order: 10 },
      { tenant_id: T, queue_id: pres.id, code: 'evidencia', label: 'Evidencia', type: 'photo', required: true, sort_order: 20 },
    ]);

    const encargado = await crearUsuario('encargado', { puesto: PUESTO_OK, sucursal: '03' });
    const cajera = await crearUsuario('cajera', { puesto: PUESTO_NO, sucursal: '03' });
    const coordPres = await crearUsuario('coordpres', { puesto: PUESTO_NO, permisos: ['SERVICIO_ATENDER', 'SERVICIO_COORDINAR'], membresias: [{ queue_id: pres.id, role: 'coordinador' }] });
    const tecMto = await crearUsuario('tecmto', { permisos: ['SERVICIO_ATENDER'], membresias: [{ queue_id: mto.id, role: 'tecnico' }] });
    const coordTi = await crearUsuario('coordti', { permisos: ['SERVICIO_ATENDER', 'SERVICIO_COORDINAR'], membresias: [{ queue_id: ti.id, role: 'coordinador' }] });
    usuarios.push(encargado, cajera, coordPres, tecMto, coordTi);
    for (const u of usuarios) check(`login de ${u.username}`, !!u.token, `status ${u.loginStatus}`);
    if (usuarios.some((u) => !u.token)) {
      // Sin token todo lo demás sería un 401 en cascada, no una medición. El login admite 5 intentos por minuto y esta prueba usa 5.
      const limitado = usuarios.some((u) => u.loginStatus === 429);
      console.log(`  ⛔ falta al menos un login${limitado ? ' (429: límite de 5 por minuto — espera 60 s y vuelve a correrla)' : ''}: se aborta sin medir lo demás`);
      return;
    }

    // ── 1. Catálogo ──
    console.log('\n1 — catálogo');
    const catEnc = await req('GET', `${SD}/catalog`, encargado.token);
    const catCaj = await req('GET', `${SD}/catalog`, cajera.token);
    const catCoo = await req('GET', `${SD}/catalog`, coordPres.token);
    const ve = (r, id) => !!r.body?.queues?.some((q) => q.id === id);
    check('⭐ al puesto permitido se le ofrece el área', ve(catEnc, pres.id), dump(catEnc));
    check('⭐ NEGATIVA: a la cajera NO se le ofrece (ni sus categorías)', !ve(catCaj, pres.id) && !catCaj.body?.categories?.some((c) => c.queue_id === pres.id), dump(catCaj));
    check('CONTROL: la cajera sí ve TI', ve(catCaj, ti.id));
    check('a su coordinación (miembro) sí se le ofrece', ve(catCoo, pres.id));
    const qEnc = catEnc.body?.queues?.find((q) => q.id === pres.id);
    check('declara requires_description, requires_decision y a qué áreas manda órdenes', qEnc?.requires_description === true && qEnc?.requires_decision === true && JSON.stringify(qEnc?.work_order_queue_codes) === JSON.stringify([mto.code]), JSON.stringify(qEnc));
    check('⛔ la lista de puestos NO sale en la respuesta', !JSON.stringify(catEnc.body).includes('requester_positions'));

    // ── 2. Alta ──
    console.log('\n2 — alta');
    const foto = [{ file_base64: dataUri('image/png', PNG_1X1), file_name: 'cotizacion.png' }];
    const payload = { category_id: catPres.id, title: 'Cortina de la entrada rota', description: 'La cortina metálica no baja; se cotizó el cambio', warehouse_code: '03', extra: { observaciones: 'Urge: no se puede cerrar la tienda' }, attachments: foto };
    // Cada negativa exige SU motivo, no sólo el código: un 400 de otra cosa (p. ej. el bucket) no cuenta como verde.
    const motivo = (r, status, re) => r.status === status && re.test(r.body?.message ?? '');
    // La cajera manda la foto: el 403 debe salir ANTES de tocar el bucket (con o sin almacenamiento configurado).
    const rCaj = await req('POST', `${SD}/requests`, cajera.token, payload);
    check('⭐ NEGATIVA: la cajera → 403, antes de tocar el bucket', rCaj.status === 403, dump(rCaj));
    check('y el 403 dice qué puestos sí pueden', /sólo recibe solicitudes de/.test(rCaj.body?.message ?? ''), dump(rCaj));
    // «Sin evidencia» va sin adjuntos: se mide con la evidencia todavía obligatoria, haya bucket o no.
    const sinEv = await req('POST', `${SD}/requests`, encargado.token, { ...payload, attachments: [] });
    check('⭐ NEGATIVA: sin evidencia → 400 por la evidencia', motivo(sinEv, 400, /«Evidencia»/), dump(sinEv));
    let P = await req('POST', `${SD}/requests`, encargado.token, payload);
    const conEvidencia = okHttp(P);
    if (!conEvidencia) {
      noMedido.push(`alta CON evidencia de punta a punta y la evidencia heredada por la orden: el bucket no respondió (${dump(P)}); la negativa «sin evidencia → 400» sí se midió`);
      await knex('servicedesk.queue_fields').where({ queue_id: pres.id, code: 'evidencia' }).update({ required: false });
      P = await req('POST', `${SD}/requests`, encargado.token, { ...payload, attachments: [] });
    }
    check('⭐ CONTROL: el encargado con todo completo → OK', okHttp(P), dump(P));
    // Las demás, con el cuerpo que SÍ pasa la evidencia (con bucket, la foto; sin él, sin foto).
    const base = conEvidencia ? payload : { ...payload, attachments: [] };
    const sinDesc = await req('POST', `${SD}/requests`, encargado.token, { ...base, description: '  ' });
    check('⭐ NEGATIVA: sin descripción → 400 por la descripción', motivo(sinDesc, 400, /descripción es obligatoria/), dump(sinDesc));
    const sinObs = await req('POST', `${SD}/requests`, encargado.token, { ...base, extra: {} });
    check('⭐ NEGATIVA: sin observaciones → 400 por las observaciones', motivo(sinObs, 400, /«Observaciones»/), dump(sinObs));
    const sinSuc = await req('POST', `${SD}/requests`, encargado.token, { ...base, warehouse_code: null });
    check('NEGATIVA: sin sucursal → 400 por la sucursal', motivo(sinSuc, 400, /ubicación/), dump(sinSuc));
    const padreId = P.body?.id;
    check('nace sin prioridad publicada ni plazos (la cola no los usa)', P.body?.priority === null && P.body?.sla?.due_at === null, dump(P));
    check('nace sin dictamen y declara que lo exige', P.body?.decision === null && P.body?.requires_decision === true, dump(P));

    // ── 3. A nombre de otra persona ──
    console.log('\n3 — a nombre de otra persona');
    const aCaj = await req('POST', `${SD}/requests`, coordPres.token, { ...payload, requester_id: cajera.id, ...(conEvidencia ? {} : { attachments: [] }) });
    check('⭐ NEGATIVA: la coordinación NO puede abrirle la puerta a un puesto que el área no recibe → 403', motivo(aCaj, 403, /sólo recibe solicitudes de/), dump(aCaj));
    const aEnc = await req('POST', `${SD}/requests`, coordPres.token, { ...payload, requester_id: encargado.id, ...(conEvidencia ? {} : { attachments: [] }) });
    check('CONTROL: a nombre del encargado → OK', okHttp(aEnc), dump(aEnc));

    // ── 4. Dictamen: quién ──
    console.log('\n4 — dictamen: quién y cómo');
    const dTi = await req('POST', `${SD}/requests/${padreId}/decision`, coordTi.token, { decision: 'autorizado', note: 'x' });
    check('⭐ NEGATIVA: la coordinación de TI → 404 (no es de esta área: ni sabe que existe)', dTi.status === 404, dump(dTi));
    const dSol = await req('POST', `${SD}/requests/${padreId}/decision`, encargado.token, { decision: 'autorizado', note: 'me autorizo' });
    check('⭐ NEGATIVA: el solicitante → 403', dSol.status === 403, dump(dSol));
    const dInv = await req('POST', `${SD}/requests/${padreId}/decision`, coordPres.token, { decision: 'quizas', note: 'x' });
    check('NEGATIVA: valor inventado → 400 por el valor', motivo(dInv, 400, /debe ser uno de/), dump(dInv));
    const dSinNota = await req('POST', `${SD}/requests/${padreId}/decision`, coordPres.token, { decision: 'autorizado', note: ' ' });
    check('NEGATIVA: sin motivo → 400 por el motivo', motivo(dSinNota, 400, /motivo del dictamen/), dump(dSinNota));

    // ── 5. Resolver exige dictamen; «no autorizada» no genera orden ──
    console.log('\n5 — resolver exige dictamen');
    check('la coordinación la toma', okHttp(await req('POST', `${SD}/requests/${padreId}/take`, coordPres.token)));
    check('pasa a en proceso', okHttp(await req('POST', `${SD}/requests/${padreId}/status`, coordPres.token, { status: 'en_proceso' })));
    const sinDict = await req('POST', `${SD}/requests/${padreId}/status`, coordPres.token, { status: 'resuelto', note: 'listo' });
    check('⭐ NEGATIVA: resolver SIN dictamen → 409 por el dictamen', motivo(sinDict, 409, /Registra el dictamen/), dump(sinDict));
    const no = await req('POST', `${SD}/requests/${padreId}/decision`, coordPres.token, { decision: 'no_autorizado', note: 'Sin presupuesto en el rubro este mes' });
    check('dictamen «no autorizado» → OK', okHttp(no) && no.body?.decision?.decision === 'no_autorizado', dump(no));
    const ordNo = await req('POST', `${SD}/requests/${padreId}/work-orders`, coordPres.token, { queue_id: mto.id, category_id: catMto.id, instructions: 'Cambiar cortina', safety_risk: false });
    check('⭐ NEGATIVA: una «no autorizada» NO genera orden → 409', motivo(ordNo, 409, /NO autorizada no genera/), dump(ordNo));
    const si = await req('POST', `${SD}/requests/${padreId}/decision`, coordPres.token, { decision: 'autorizado', note: 'Autorizado con cargo a mantenimiento de sucursales' });
    check('⭐ se corrige a «autorizado» (aún sin órdenes) → OK', okHttp(si) && si.body?.decision?.decision === 'autorizado', dump(si));
    const verSol = await req('GET', `${SD}/requests/${padreId}`, encargado.token);
    check('⭐ el solicitante ve el dictamen y su motivo', verSol.body?.decision?.decision === 'autorizado' && /cargo a mantenimiento/.test(verSol.body?.decision?.note ?? ''), dump(verSol));
    const avisoDict = await knex('servicedesk.notification_log').where({ request_id: padreId, recipient_id: encargado.id }).where('dedup_key', 'like', 'dictamen:%').count({ n: '*' }).first().catch(() => null);
    if (avisoDict) check('al solicitante le llega el aviso del dictamen', Number(avisoDict.n) >= 1, `n=${avisoDict?.n}`);
    else noMedido.push('el aviso «dictamen» en notification_log (no se pudo leer la tabla)');

    // ── 6. La orden de servicio ──
    console.log('\n6 — orden de servicio');
    const P2 = (await req('POST', `${SD}/requests`, encargado.token, { ...payload, title: 'Otra: bomba de agua', ...(conEvidencia ? {} : { attachments: [] }) })).body;
    await req('POST', `${SD}/requests/${P2?.id}/decision`, coordPres.token, { decision: 'autorizado', note: 'ok' });
    const sinTomar = await req('POST', `${SD}/requests/${P2?.id}/work-orders`, coordPres.token, { queue_id: mto.id, category_id: catMto.id, instructions: 'Revisar bomba', safety_risk: false });
    check('⭐ NEGATIVA: sin tomar la solicitud → 409', sinTomar.status === 409 && /Toma/.test(sinTomar.body?.message ?? ''), dump(sinTomar));
    const aTi = await req('POST', `${SD}/requests/${padreId}/work-orders`, coordPres.token, { queue_id: ti.id, category_id: catTi.id, instructions: 'x' });
    check('⭐ NEGATIVA: a un área fuera de la lista (TI) → 400 por el destino', motivo(aTi, 400, /no recibe órdenes de servicio de esta/), dump(aTi));
    const sinRiesgo = await req('POST', `${SD}/requests/${padreId}/work-orders`, coordPres.token, { queue_id: mto.id, category_id: catMto.id, instructions: 'Cambiar cortina' });
    check('NEGATIVA: Mantenimiento sin «¿hay riesgo?» → 400 por el riesgo', motivo(sinRiesgo, 400, /riesgo para personas/), dump(sinRiesgo));
    const sinInstr = await req('POST', `${SD}/requests/${padreId}/work-orders`, coordPres.token, { queue_id: mto.id, category_id: catMto.id, instructions: ' ', safety_risk: false });
    check('NEGATIVA: sin instrucciones → 400 por las instrucciones', motivo(sinInstr, 400, /qué debe hacer/), dump(sinInstr));
    const ordTi = await req('POST', `${SD}/requests/${padreId}/work-orders`, coordTi.token, { queue_id: mto.id, category_id: catMto.id, instructions: 'x', safety_risk: false });
    check('NEGATIVA: la coordinación de TI → 404', ordTi.status === 404, dump(ordTi));
    const O = await req('POST', `${SD}/requests/${padreId}/work-orders`, coordPres.token, { queue_id: mto.id, category_id: catMto.id, instructions: 'Cambiar la cortina metálica de la entrada', safety_risk: true });
    check('⭐ CONTROL: la orden completa → OK y devuelve la ficha del PADRE', okHttp(O) && O.body?.id === padreId, dump(O));
    const wo = O.body?.work_orders?.[0];
    check('⭐ el padre lista la orden con su folio, área y estado', O.body?.work_orders?.length === 1 && wo?.queue_name === mto.name && wo?.status, JSON.stringify(O.body?.work_orders));
    check('⭐ el padre queda EN ESPERA por la orden (orden_servicio)', O.body?.status === 'en_espera' && O.body?.pause_reason === 'orden_servicio', `${O.body?.status}/${O.body?.pause_reason}`);
    const hija = wo?.id ? await knex('servicedesk.requests').where({ id: wo.id }).first() : null; // sin orden, rojo y seguir (no una excepción)
    check('⭐ la orden nace a nombre del encargado, con su sucursal, ligada al padre', hija?.requester_id === encargado.id && hija?.warehouse_code === '03' && hija?.parent_request_id === padreId, JSON.stringify(hija && { r: hija.requester_id, w: hija.warehouse_code, p: hija.parent_request_id }));
    check('y la abrió la coordinación', hija?.created_by === coordPres.id);
    if (conEvidencia && hija) {
      const adjH = await knex('servicedesk.request_attachments').where({ request_id: hija?.id }).count({ n: '*' }).first();
      check('⭐ la orden HEREDA la evidencia del padre', Number(adjH.n) >= 1, `n=${adjH.n}`);
    }
    const verHija = await req('GET', `${SD}/requests/${wo?.id}`, tecMto.token);
    check('⭐ Mantenimiento ve la orden y de dónde viene', okHttp(verHija) && verHija.body?.parent?.id === padreId && verHija.body?.parent?.queue_name === pres.name, dump(verHija));
    const verPadreMto = await req('GET', `${SD}/requests/${padreId}`, tecMto.token);
    check('⛔ pero NO abre la solicitud de Presupuestos (404)', verPadreMto.status === 404, dump(verPadreMto));
    const verHijaSol = await req('GET', `${SD}/requests/${wo?.id}`, encargado.token);
    check('el encargado ve su orden (es el titular)', okHttp(verHijaSol));

    // ── 7. Con la orden en marcha ──
    console.log('\n7 — con la orden en marcha');
    const cambio = await req('POST', `${SD}/requests/${padreId}/decision`, coordPres.token, { decision: 'no_autorizado', note: 'me arrepentí' });
    check('⭐ NEGATIVA: el dictamen ya no se cambia → 409', motivo(cambio, 409, /ya no se cambia/), dump(cambio));
    await req('POST', `${SD}/requests/${padreId}/messages`, encargado.token, { body: '¿Para cuándo?' });
    const tras = (await req('GET', `${SD}/requests/${padreId}`, encargado.token)).body;
    check('⭐ el comentario del solicitante NO reanuda al padre (espera a la orden, no a él)', tras?.status === 'en_espera' && tras?.pause_reason === 'orden_servicio', `${tras?.status}/${tras?.pause_reason}`);
    const pausaManual = await req('POST', `${SD}/requests/${aEnc.body?.id}/status`, coordPres.token, { status: 'en_espera', pause_reason: 'orden_servicio' });
    check('NEGATIVA: «orden_servicio» no se elige a mano → 400 (o 409 por estado)', pausaManual.status === 400 || pausaManual.status === 409, dump(pausaManual));

    // ── 8. Resolver la orden resuelve al padre ──
    console.log('\n8 — la orden resuelta resuelve al padre');
    check('Mantenimiento toma la orden', okHttp(await req('POST', `${SD}/requests/${wo?.id}/take`, tecMto.token)));
    check('la inicia', okHttp(await req('POST', `${SD}/requests/${wo?.id}/status`, tecMto.token, { status: 'en_proceso' })));
    const res = await req('POST', `${SD}/requests/${wo?.id}/status`, tecMto.token, { status: 'resuelto', note: 'Cortina cambiada y probada' });
    check('y la resuelve', okHttp(res), dump(res));
    const padreFin = (await req('GET', `${SD}/requests/${padreId}`, encargado.token)).body;
    check('⭐ el padre quedó RESUELTO solo', padreFin?.status === 'resuelto', padreFin?.status);
    check('⭐ con la nota de la orden', (padreFin?.resolution_note ?? '').includes(wo?.folio) && (padreFin?.resolution_note ?? '').includes('Cortina cambiada'), padreFin?.resolution_note);
    check('y el hilo del padre cuenta lo que pasó (enviada y resuelta)', (padreFin?.messages ?? []).filter((m) => m.meta?.work_order_id === wo?.id).length >= 2);

    // ── 9. Una orden cancelada NO resuelve al padre ──
    console.log('\n9 — una orden cancelada no resuelve al padre');
    const p3 = aEnc.body?.id;
    await req('POST', `${SD}/requests/${p3}/take`, coordPres.token);
    await req('POST', `${SD}/requests/${p3}/decision`, coordPres.token, { decision: 'autorizado', note: 'ok' });
    const O3 = await req('POST', `${SD}/requests/${p3}/work-orders`, coordPres.token, { queue_id: mto.id, category_id: catMto.id, instructions: 'Revisar', safety_risk: false });
    const wo3 = O3.body?.work_orders?.[0];
    check('orden generada', okHttp(O3) && !!wo3, dump(O3));
    const canc = await req('POST', `${SD}/requests/${wo3?.id}/cancel`, encargado.token, { note: 'Ya no hace falta' });
    check('el titular la cancela', okHttp(canc), dump(canc));
    const p3Fin = (await req('GET', `${SD}/requests/${p3}`, coordPres.token)).body;
    check('⭐ el padre SIGUE en espera (nada se resolvió: decide la coordinación)', p3Fin?.status === 'en_espera', p3Fin?.status);
    check('y su hilo dice que la orden se canceló', (p3Fin?.messages ?? []).some((m) => m.meta?.work_order_status === 'cancelado'));

    // ── 10. CONTROL: TI sigue igual ──
    console.log('\n10 — CONTROL: TI no cambia');
    // La ubicación va porque la categoría de TI que toque puede exigirla (eso es de TI, no de esta fase); lo que se prueba es quién y la descripción.
    const tiOk = await req('POST', `${SD}/requests`, cajera.token, { category_id: catTi.id, title: 'SMOKE MSP: TI sin descripción', warehouse_code: '03' });
    check('⭐ en TI cualquiera levanta (la cajera) y sin descripción, como siempre', okHttp(tiOk), dump(tiOk));
    check('y TI no declara dictamen', tiOk.body?.requires_decision === false && tiOk.body?.decision === null);
  } finally {
    const ids = creados;
    if (ids.length) {
      const reqs = (await knex('servicedesk.requests').whereIn('requester_id', ids).select('id')).map((r) => r.id);
      await knex('servicedesk.notification_log').whereIn('recipient_id', ids).del();
      if (reqs.length) {
        await knex('servicedesk.requests').whereIn('id', reqs).update({ parent_request_id: null });
        await knex('servicedesk.notification_log').whereIn('request_id', reqs).del();
        await knex('servicedesk.work_log').whereIn('request_id', reqs).del();
        await knex('servicedesk.request_attachments').whereIn('request_id', reqs).del();
        await knex('servicedesk.request_links').whereIn('request_id', reqs).del();
        await knex('servicedesk.request_messages').whereIn('request_id', reqs).del();
        await knex('servicedesk.requests').whereIn('id', reqs).del();
      }
      await knex('servicedesk.queue_members').whereIn('user_id', ids).del();
      await knex('servicedesk.notification_prefs').whereIn('user_id', ids).del();
      await knex('identity.user_permissions').whereIn('user_id', ids).del();
      await knex('identity.user_roles').whereIn('user_id', ids).del();
      await knex('identity.users').whereIn('id', ids).del();
    }
    if (colas.length) {
      await knex('servicedesk.queue_members').whereIn('queue_id', colas).del();
      await knex('servicedesk.queue_fields').whereIn('queue_id', colas).del();
      await knex('servicedesk.categories').whereIn('queue_id', colas).del();
      await knex('servicedesk.queues').whereIn('id', colas).del();
    }
    await knex.destroy();
    if (noMedido.length) {
      console.log('\n  NO MEDIDO (declarado, no dibujado como verde):');
      for (const n of noMedido) console.log(`   · ${n}`);
    }
    console.log(`\n=== ${pass} ✅  ${fail} ❌ ===\n`);
    process.exit(fail ? 1 : 0);
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
