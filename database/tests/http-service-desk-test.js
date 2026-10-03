/* eslint-disable no-console */
/**
 * `[MS.2.9]` — **Mesa de Servicio por HTTP, con roles de PERMISO MÍNIMO y sus pruebas negativas.**
 *
 * Por qué existe aparte del smoke de base (`test-newdb-service-desk.js`): ese inserta directo a las tablas
 * y comprueba los CHECK/RLS/grants del esquema, pero NO toca los guards, ni el SQL de los servicios, ni la
 * máquina de estados. ADR-044: la verificación HTTP es su propio paso.
 *
 * ⚠️ Y no se prueba con un admin: los roles de plataforma pasan por god-mode, así que una puerta mal puesta
 * sale VERDE con `superoot` y roja para todos los demás. Cuatro usuarios efímeros, TODOS con el rol
 * `colaborador` (que recibe `SERVICIO_REPORTAR` por la migración 20261002170000 y NADA más de la mesa):
 *
 *   · solicitante  → sólo REPORTAR.
 *   · otro         → sólo REPORTAR. Existe para probar que NO ve el ticket ajeno.
 *   · agente       → + override de persona SERVICIO_ATENDER (así se prueba también que el override cuenta).
 *   · coordinación → + overrides SERVICIO_ATENDER y SERVICIO_COORDINAR.
 *
 * Lo que este archivo afirma y que ningún otro cubre:
 *   1. el alta CONGELA lo que debe (folio SRV-AAAA-NNNNN, prioridad sugerida, plazos del SLA del reloj de la
 *      política: `urgente` corre corrido, 30 min);
 *   2. quien no es solicitante ni atiende recibe **404** (no 403) y no ve notas internas ni el tiempo;
 *   3. la MÁQUINA DE ESTADOS manda sobre el rol: el solicitante no resuelve, el agente no confirma, nadie
 *      salta estados — cada negativa rota a propósito;
 *   4. `en_espera` pausa el reloj y la respuesta del solicitante lo reanuda sola;
 *   5. sólo la coordinación reasigna, y sólo a quien atiende de verdad.
 *
 * Lo que se DECLARA NO MEDIDO en vez de dibujarlo verde (se imprime al final):
 *   · el adjunto VÁLIDO de punta a punta, si el bucket no está configurado en este entorno;
 *   · el aislamiento entre tenants POR HTTP (lo cubre RLS en `test-newdb-service-desk.js`);
 *   · el barrido del SLA y las notificaciones (llegan con MS.2.6/2.7).
 *
 * Pre-requisitos: API en :3334 y las migraciones de la Mesa de Servicio aplicadas.
 * Uso: node database/tests/http-service-desk-test.js
 */
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env'), quiet: true });
const knex = require('knex')(require('../knexfile-newdb.js').development);
const bcrypt = require('bcryptjs');

const BASE = 'http://localhost:3334/api';
const T = process.env.TENANT_ID || '00000000-0000-0000-0000-00000000d01c';
const SUF = String(Date.now()).slice(-8);
const PASS_PLANO = `Smoke!${SUF}`;
const SD = '/service-desk';
// Un rol sin NADA de la mesa salvo REPORTAR (repartido por la migración 20261002170000) y que no es admin.
const ROL_BASE = 'colaborador';

let pass = 0;
let fail = 0;
const noMedido = [];
const check = (name, cond, det) => {
  if (cond) {
    console.log(`  ✅ ${name}`);
    pass++;
  } else {
    console.log(`  ❌ ${name}${det ? ' — ' + det : ''}`);
    fail++;
  }
};

async function req(method, p, token, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const r = await fetch(`${BASE}${p}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let json = null;
  try {
    json = await r.json();
  } catch {
    /* respuesta sin cuerpo */
  }
  return { status: r.status, body: json };
}

const dump = (r) => `status ${r.status} ${JSON.stringify(r.body).slice(0, 140)}`;

async function crearUsuario(etiqueta, overrides = []) {
  const username = `smoke_sd_${etiqueta}_${SUF}`.slice(0, 40);
  const [{ id }] = await knex('identity.users')
    .insert({ tenant_id: T, username, nombre: `SMOKE ${etiqueta}`, password_hash: await bcrypt.hash(PASS_PLANO, 10), role_name: ROL_BASE })
    .returning('id');
  for (const k of overrides) {
    await knex('identity.user_permissions').insert({ tenant_id: T, user_id: id, permission_key: k, allow: true, nota: 'smoke http-service-desk-test' });
  }
  const r = await req('POST', '/auth-mt/login', null, { tenant_slug: 'mega_dulces', username, password: PASS_PLANO });
  return { id, username, token: r.body?.access_token ?? null, loginStatus: r.status };
}

// PNG de 1×1 válido y un HTML disfrazado de imagen: la firma, no el tipo declarado, es lo que manda.
const PNG_1X1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const dataUri = (mime, buf) => `data:${mime};base64,${buf.toString('base64')}`;

(async () => {
  console.log('\n=== [MS.2.9] Mesa de Servicio por HTTP — roles mínimos y pruebas negativas ===\n');
  const usuarios = [];
  let restaurar = null;
  try {
    // ── 0. Los cuatro usuarios efímeros ──────────────────────────────────────────
    console.log('0 — usuarios de prueba (se borran al final)');
    const sol = await crearUsuario('solicitante');
    const otro = await crearUsuario('otro');
    const agente = await crearUsuario('agente', ['SERVICIO_ATENDER']);
    const coord = await crearUsuario('coord', ['SERVICIO_ATENDER', 'SERVICIO_COORDINAR']);
    usuarios.push(sol, otro, agente, coord);
    for (const u of usuarios) check(`login de ${u.username}`, !!u.token, `status ${u.loginStatus}`);
    if (usuarios.some((u) => !u.token)) {
      console.log('\n  ⚠️  NO MEDIDO: sin token no se puede probar ningún gate.');
      return;
    }
    const payload = JSON.parse(Buffer.from(sol.token.split('.')[1], 'base64').toString());
    check(`el token es de un rol NO admin (role=${payload.role_name}): sin esto todo pasaría por god-mode`, payload.role_name === ROL_BASE);

    // ── 1. Catálogo ─────────────────────────────────────────────────────────────
    console.log('\n1 — catálogo');
    const cat = await req('GET', `${SD}/catalog`, sol.token);
    check('GET /catalog → 200', cat.status === 200, dump(cat));
    check('trae colas, categorías y los 4 impactos', cat.body?.queues?.length >= 1 && cat.body?.categories?.length >= 1 && cat.body?.impacts?.length === 4, dump(cat));
    const catSimple = (cat.body?.categories ?? []).find((c) => !c.requires_branch);
    const catConSucursal = (cat.body?.categories ?? []).find((c) => c.requires_branch);
    check('hay una categoría que NO exige sucursal (para el resto del test)', !!catSimple);
    if (!catSimple) return;

    // ── 2. Alta ─────────────────────────────────────────────────────────────────
    console.log('\n2 — alta y prioridad SUGERIDA');
    const t1 = await req('POST', `${SD}/requests`, sol.token, { category_id: catSimple.id, title: 'No me abre el ERP', description: 'Sale un error al entrar', impact: 'yo', blocks_work: false });
    check('POST /requests → 200/201', t1.status === 200 || t1.status === 201, dump(t1));
    const T1 = t1.body;
    check('folio SRV-AAAA-NNNNN', /^SRV-\d{4}-\d{5}$/.test(T1?.folio ?? ''), T1?.folio);
    check('nace en «nuevo», sin asignar', T1?.status === 'nuevo' && !T1?.assigned_to);
    check('la prioridad confirmada arranca igual a la sugerida', T1?.priority === T1?.priority_suggested, `${T1?.priority}/${T1?.priority_suggested}`);
    check('trae los plazos del SLA calculados', !!T1?.sla?.due_at && !!T1?.sla?.first_response_due_at && T1.sla.paused === false);
    check('el hilo arranca con UN mensaje del sistema', T1?.messages?.length === 1 && T1.messages[0].kind === 'system');
    check('el snapshot del solicitante quedó escrito', T1?.requester_id === sol.id && !!T1?.requester_name);

    const t2 = await req('POST', `${SD}/requests`, sol.token, { category_id: catSimple.id, title: 'Se cayó el sistema en toda la sucursal', impact: 'sucursal', blocks_work: true, warehouse_code: '02' });
    const T2 = t2.body;
    check('⭐ «me bloquea + afecta a la sucursal» sugiere URGENTE', T2?.priority === 'urgente', `${T2?.priority}`);
    const minPrimera = (new Date(T2?.sla?.first_response_due_at) - new Date(T2?.created_at)) / 60000;
    check('⭐ el reloj de «urgente» es CORRIDO: primera respuesta a ~30 min', Math.abs(minPrimera - 30) < 1, `${minPrimera.toFixed(2)} min`);
    check('la sucursal se muestra con su nombre', T2?.warehouse_name === 'La Piedad Abastos', T2?.warehouse_name);
    check('folios distintos y crecientes', !!T1?.folio && !!T2?.folio && T2.folio > T1.folio, `${T1?.folio} → ${T2?.folio}`);

    console.log('\n   negativas del alta');
    check('título vacío → 400', (await req('POST', `${SD}/requests`, sol.token, { category_id: catSimple.id, title: '   ' })).status === 400);
    check('título de 201 caracteres → 400', (await req('POST', `${SD}/requests`, sol.token, { category_id: catSimple.id, title: 'x'.repeat(201) })).status === 400);
    check('categoría inexistente → 400', (await req('POST', `${SD}/requests`, sol.token, { category_id: '00000000-0000-0000-0000-000000000000', title: 'x' })).status === 400);
    check('category_id que no es uuid → 400 (no un 500 de Postgres)', (await req('POST', `${SD}/requests`, sol.token, { category_id: 'abc', title: 'x' })).status === 400);
    check('impacto inventado → 400', (await req('POST', `${SD}/requests`, sol.token, { category_id: catSimple.id, title: 'x', impact: 'cosmico' })).status === 400);
    check('sucursal desconocida → 400', (await req('POST', `${SD}/requests`, sol.token, { category_id: catSimple.id, title: 'x', warehouse_code: '99' })).status === 400);
    check('sucursal de la era Wincaja cerrada («30») → 400', (await req('POST', `${SD}/requests`, sol.token, { category_id: catSimple.id, title: 'x', warehouse_code: '30' })).status === 400);
    if (catConSucursal) {
      check('categoría que exige sucursal, sin sucursal → 400', (await req('POST', `${SD}/requests`, sol.token, { category_id: catConSucursal.id, title: 'x' })).status === 400);
    } else {
      noMedido.push('ninguna categoría del catálogo exige sucursal: la negativa «requires_branch» no se pudo ejercer');
    }
    check('sin token → 401', (await req('POST', `${SD}/requests`, null, { category_id: catSimple.id, title: 'x' })).status === 401);

    console.log('\n   adjuntos: la FIRMA manda, no el tipo declarado');
    const html = Buffer.from('<html><script>alert(document.cookie)</script></html>');
    const rHtml = await req('POST', `${SD}/requests`, sol.token, { category_id: catSimple.id, title: 'x', attachments: [{ file_base64: dataUri('image/png', html), file_name: 'foto.png' }] });
    check('⭐ un HTML declarado como image/png se RECHAZA (400)', rHtml.status === 400, dump(rHtml));
    const rVacio = await req('POST', `${SD}/requests`, sol.token, { category_id: catSimple.id, title: 'x', attachments: [{ file_base64: 'data:image/png;base64,', file_name: 'a.png' }] });
    check('adjunto vacío → 400', rVacio.status === 400);
    const seis = Array.from({ length: 6 }, () => ({ file_base64: dataUri('image/png', PNG_1X1) }));
    check('más de 5 adjuntos por envío → 400', (await req('POST', `${SD}/requests`, sol.token, { category_id: catSimple.id, title: 'x', attachments: seis })).status === 400);
    const antes = Number((await knex('servicedesk.requests').where({ tenant_id: T }).count({ n: '*' }).first()).n);
    const rOk = await req('POST', `${SD}/requests`, sol.token, { category_id: catSimple.id, title: 'Con foto', attachments: [{ file_base64: dataUri('image/png', PNG_1X1), file_name: 'captura.png' }] });
    if (rOk.status === 200 || rOk.status === 201) {
      check('un PNG honesto se acepta y queda ligado al ticket', rOk.body?.attachments?.length === 1 && rOk.body.attachments[0].content_type === 'image/png', dump(rOk));
      check('el adjunto llega con URL prefirmada', !!rOk.body?.attachments?.[0]?.url);
    } else {
      noMedido.push(`adjunto VÁLIDO de punta a punta (el bucket no respondió: ${dump(rOk)})`);
      const despues = Number((await knex('servicedesk.requests').where({ tenant_id: T }).count({ n: '*' }).first()).n);
      check('⭐ si la subida falla NO queda un ticket huérfano', despues === antes, `antes=${antes} después=${despues}`);
    }

    // ── 3. Alcance: quién ve qué ────────────────────────────────────────────────
    console.log('\n3 — alcance');
    const ajeno = await req('GET', `${SD}/requests/${T1.id}`, otro.token);
    check('⭐ el ticket de otra persona → 404 (no 403: no se confirma que existe)', ajeno.status === 404, dump(ajeno));
    check('el solicitante sí ve el suyo', (await req('GET', `${SD}/requests/${T1.id}`, sol.token)).status === 200);
    check('id que no es uuid → 404', (await req('GET', `${SD}/requests/abc`, sol.token)).status === 404);
    const mine = await req('GET', `${SD}/requests/mine`, sol.token);
    check('«mis solicitudes» incluye las suyas', mine.body?.rows?.some((r) => r.id === T1.id) && mine.body?.rows?.some((r) => r.id === T2.id), dump(mine));
    const mineOtro = await req('GET', `${SD}/requests/mine`, otro.token);
    check('«mis solicitudes» de otra persona NO incluye las ajenas', !mineOtro.body?.rows?.some((r) => r.id === T1.id));
    check('el solicitante NO entra a la bandeja → 403', (await req('GET', `${SD}/requests/inbox`, sol.token)).status === 403);
    check('el solicitante NO ve el tablero → 403', (await req('GET', `${SD}/requests/stats`, sol.token)).status === 403);
    check('el solicitante NO ve la lista de agentes → 403', (await req('GET', `${SD}/agents`, sol.token)).status === 403);

    // ── 4. Bandeja, tomar y asignar ─────────────────────────────────────────────
    console.log('\n4 — bandeja, tomar y asignar');
    const inbox = await req('GET', `${SD}/requests/inbox?scope=unassigned&limit=200`, agente.token);
    check('el agente entra a la bandeja → 200', inbox.status === 200, dump(inbox));
    const idx1 = inbox.body?.rows?.findIndex((r) => r.id === T1.id);
    const idx2 = inbox.body?.rows?.findIndex((r) => r.id === T2.id);
    check('ambos tickets están en «sin asignar»', idx1 >= 0 && idx2 >= 0);
    check('⭐ el URGENTE va antes que el de prioridad menor', idx2 < idx1, `urgente@${idx2} vs ${T1.priority}@${idx1}`);
    check('filtro de prioridad inválido → 400', (await req('GET', `${SD}/requests/inbox?priority=critica`, agente.token)).status === 400);
    check('scope inválido → 400', (await req('GET', `${SD}/requests/inbox?scope=todo`, agente.token)).status === 400);
    const busca = await req('GET', `${SD}/requests/inbox?scope=all&search=${encodeURIComponent('abre el ERP')}`, agente.token);
    check('la búsqueda por texto encuentra el ticket', busca.body?.rows?.some((r) => r.id === T1.id), dump(busca));

    check('el solicitante NO puede tomar → 403', (await req('POST', `${SD}/requests/${T1.id}/take`, sol.token)).status === 403);
    const take = await req('POST', `${SD}/requests/${T1.id}/take`, agente.token);
    check('el agente toma → «asignado» a él', take.status < 300 && take.body?.status === 'asignado' && take.body?.assigned_to === agente.id, dump(take));
    check('tomar cuenta como PRIMERA RESPUESTA', !!take.body?.sla?.first_responded_at);
    check('⭐ nadie le quita un ticket tomado: segundo take → 409', (await req('POST', `${SD}/requests/${T1.id}/take`, coord.token)).status === 409);
    check('el agente NO reasigna (sólo coordinación) → 403', (await req('POST', `${SD}/requests/${T2.id}/assign`, agente.token, { user_id: agente.id })).status === 403);

    const ag = await req('GET', `${SD}/agents`, coord.token);
    check('la coordinación ve la lista de agentes → 200', ag.status === 200, dump(ag));
    check('el agente con override de PERSONA aparece en la lista', ag.body?.some((a) => a.user_id === agente.id));
    check('quien sólo reporta NO aparece', !ag.body?.some((a) => a.user_id === sol.id || a.user_id === otro.id));
    check('⭐ asignar a quien NO atiende → 400', (await req('POST', `${SD}/requests/${T2.id}/assign`, coord.token, { user_id: otro.id })).status === 400);
    check('asignar a un user_id que no es uuid → 400', (await req('POST', `${SD}/requests/${T2.id}/assign`, coord.token, { user_id: 'xyz' })).status === 400);
    const asg = await req('POST', `${SD}/requests/${T2.id}/assign`, coord.token, { user_id: agente.id });
    check('la coordinación asigna a un agente → «asignado»', asg.status < 300 && asg.body?.assigned_to === agente.id && asg.body?.status === 'asignado', dump(asg));

    // ── 5. El hilo y las notas internas ─────────────────────────────────────────
    console.log('\n5 — el hilo y las notas internas');
    check('el solicitante NO puede dejar nota interna → 403', (await req('POST', `${SD}/requests/${T1.id}/messages`, sol.token, { body: 'secreto', visibility: 'internal' })).status === 403);
    check('mensaje vacío → 400', (await req('POST', `${SD}/requests/${T1.id}/messages`, sol.token, { body: '  ' })).status === 400);
    const nota = await req('POST', `${SD}/requests/${T1.id}/messages`, agente.token, { body: 'Parece el usuario bloqueado en Kepler', visibility: 'internal' });
    check('el agente deja una nota interna', nota.status < 300, dump(nota));
    const pub = await req('POST', `${SD}/requests/${T1.id}/messages`, agente.token, { body: 'Estoy revisando tu acceso' });
    check('el agente comenta en público', pub.status < 300, dump(pub));
    const vSol = await req('GET', `${SD}/requests/${T1.id}`, sol.token);
    const vAg = await req('GET', `${SD}/requests/${T1.id}`, agente.token);
    check('⭐ el solicitante NO recibe la nota interna', !vSol.body?.messages?.some((m) => m.kind === 'internal_note' || m.visibility === 'internal'), JSON.stringify(vSol.body?.messages?.map((m) => m.kind)));
    check('el solicitante SÍ ve el comentario público', vSol.body?.messages?.some((m) => m.body === 'Estoy revisando tu acceso'));
    check('el agente ve la nota interna', vAg.body?.messages?.some((m) => m.kind === 'internal_note'));
    check('⭐ el solicitante ve MENOS mensajes que el agente (el filtro es del servidor)', vSol.body.messages.length < vAg.body.messages.length);
    check('⭐ el hilo lleva el NOMBRE de quien escribió, no su usuario (el JWT sólo trae el usuario: lo destapó la revisión visual)', vAg.body.messages.some((m) => m.kind === 'comment' && m.author_label === 'SMOKE agente') && !vAg.body.messages.some((m) => m.author_label === agente.username), JSON.stringify(vAg.body.messages.map((m) => m.author_label)));

    // ── 6. Tiempo trabajado ─────────────────────────────────────────────────────
    console.log('\n6 — tiempo trabajado');
    check('el solicitante NO registra tiempo → 403', (await req('POST', `${SD}/requests/${T1.id}/time`, sol.token, { minutes: 10 })).status === 403);
    check('0 minutos → 400', (await req('POST', `${SD}/requests/${T1.id}/time`, agente.token, { minutes: 0 })).status === 400);
    check('1441 minutos → 400', (await req('POST', `${SD}/requests/${T1.id}/time`, agente.token, { minutes: 1441 })).status === 400);
    const tiempo = await req('POST', `${SD}/requests/${T1.id}/time`, agente.token, { minutes: 30, note: 'Revisión de accesos' });
    check('el agente registra 30 min', tiempo.status < 300 && tiempo.body?.time_logged_minutes === 30, dump(tiempo));
    check('⭐ el solicitante NO ve el tiempo registrado', (await req('GET', `${SD}/requests/${T1.id}`, sol.token)).body?.time_logged_minutes === null);

    // ── 7. La máquina de estados ────────────────────────────────────────────────
    console.log('\n7 — la máquina de estados');
    check('⭐ nadie salta estados: asignado → resuelto → 409', (await req('POST', `${SD}/requests/${T1.id}/status`, agente.token, { status: 'resuelto', note: 'listo' })).status === 409);
    check('estado inventado → 400', (await req('POST', `${SD}/requests/${T1.id}/status`, agente.token, { status: 'volando' })).status === 400);
    check('«asignado» no se fija por status (hay que asignar) → 400', (await req('POST', `${SD}/requests/${T1.id}/status`, coord.token, { status: 'asignado' })).status === 400);
    const proc = await req('POST', `${SD}/requests/${T1.id}/status`, agente.token, { status: 'en_proceso' });
    check('el agente inicia → «en_proceso»', proc.status < 300 && proc.body?.status === 'en_proceso', dump(proc));
    check('⭐ el solicitante NO resuelve su propio ticket → 403', (await req('POST', `${SD}/requests/${T1.id}/status`, sol.token, { status: 'resuelto', note: 'ya quedó' })).status === 403);
    check('el solicitante NO cancela uno en proceso (sólo coordinación) → 403', (await req('POST', `${SD}/requests/${T1.id}/cancel`, sol.token, {})).status === 403);

    const espera = await req('POST', `${SD}/requests/${T1.id}/status`, agente.token, { status: 'en_espera', note: 'Espero que me confirmes tu usuario' });
    check('el agente pone «en_espera»', espera.status < 300 && espera.body?.status === 'en_espera', dump(espera));
    check('⭐ en espera el reloj del SLA queda PAUSADO', espera.body?.sla?.paused === true);
    const responde = await req('POST', `${SD}/requests/${T1.id}/messages`, sol.token, { body: 'Mi usuario es jperez' });
    check('el solicitante responde', responde.status < 300, dump(responde));
    check('⭐ su respuesta REANUDA el ticket sola (en_proceso, reloj corriendo)', responde.body?.status === 'en_proceso' && responde.body?.sla?.paused === false, `${responde.body?.status} paused=${responde.body?.sla?.paused}`);

    check('resolver SIN nota → 400', (await req('POST', `${SD}/requests/${T1.id}/status`, agente.token, { status: 'resuelto' })).status === 400);
    const resuelto = await req('POST', `${SD}/requests/${T1.id}/status`, agente.token, { status: 'resuelto', note: 'Se desbloqueó el usuario en Kepler' });
    check('el agente resuelve con nota', resuelto.status < 300 && resuelto.body?.status === 'resuelto' && !!resuelto.body?.resolved_at && resuelto.body?.resolution_note, dump(resuelto));
    check('⭐ quien resuelve NO cierra: el agente no confirma → 403', (await req('POST', `${SD}/requests/${T1.id}/confirm`, agente.token, {})).status === 403);
    check('otra persona no puede confirmar → 404', (await req('POST', `${SD}/requests/${T1.id}/confirm`, otro.token, {})).status === 404);

    const reabre0 = await req('POST', `${SD}/requests/${T1.id}/reopen`, sol.token, {});
    check('reabrir SIN decir qué falla → 400', reabre0.status === 400, dump(reabre0));
    const reabre = await req('POST', `${SD}/requests/${T1.id}/reopen`, sol.token, { note: 'Sigue sin entrar' });
    check('el solicitante reabre → «en_proceso» y cuenta la reapertura', reabre.status < 300 && reabre.body?.status === 'en_proceso' && reabre.body?.reopened_count === 1 && !reabre.body?.resolved_at, dump(reabre));

    await req('POST', `${SD}/requests/${T1.id}/status`, agente.token, { status: 'resuelto', note: 'Ahora sí, se reseteó la contraseña' });
    const confirma = await req('POST', `${SD}/requests/${T1.id}/confirm`, sol.token, {});
    check('el solicitante confirma → «cerrado» por «confirmado»', confirma.status < 300 && confirma.body?.status === 'cerrado' && confirma.body?.close_reason === 'confirmado' && !!confirma.body?.closed_at, dump(confirma));
    check('⭐ un ticket cerrado no admite más mensajes → 409', (await req('POST', `${SD}/requests/${T1.id}/messages`, sol.token, { body: 'otra cosa' })).status === 409);
    check('⭐ y no se vuelve a abrir desde «cerrado» → 409', (await req('POST', `${SD}/requests/${T1.id}/reopen`, sol.token, { note: 'x' })).status === 409);

    // ── 8. Prioridad ────────────────────────────────────────────────────────────
    console.log('\n8 — prioridad');
    check('⭐ el solicitante NO sube su prioridad para saltarse la fila → 403', (await req('POST', `${SD}/requests/${T2.id}/priority`, sol.token, { priority: 'urgente' })).status === 403);
    check('prioridad inventada → 400', (await req('POST', `${SD}/requests/${T2.id}/priority`, agente.token, { priority: 'critica' })).status === 400);
    check('misma prioridad → 400', (await req('POST', `${SD}/requests/${T2.id}/priority`, agente.token, { priority: 'urgente' })).status === 400);
    const antesDue = T2.sla.due_at;
    const baja = await req('POST', `${SD}/requests/${T2.id}/priority`, agente.token, { priority: 'baja', reason: 'Ya hay solución provisional' });
    check('el agente baja la prioridad y los PLAZOS se recalculan', baja.status < 300 && baja.body?.priority === 'baja' && baja.body?.sla?.due_at !== antesDue, dump(baja));
    check('la prioridad SUGERIDA original se conserva (auditoría)', baja.body?.priority_suggested === 'urgente', `${baja.body?.priority_suggested}`);
    check('el cambio queda en el hilo como «priority»', baja.body?.messages?.some((m) => m.kind === 'priority'));

    // ── 9. Cancelar y tablero ───────────────────────────────────────────────────
    console.log('\n9 — cancelar y tablero');
    const t3 = await req('POST', `${SD}/requests`, sol.token, { category_id: catSimple.id, title: 'Ya no lo necesito' });
    const canc = await req('POST', `${SD}/requests/${t3.body?.id}/cancel`, sol.token, { note: 'Se arregló solo' });
    check('el solicitante cancela uno «nuevo» → «cancelado» por «cancelado»', canc.status < 300 && canc.body?.status === 'cancelado' && canc.body?.close_reason === 'cancelado', dump(canc));
    check('lo cancelado es final → no se reabre (409)', (await req('POST', `${SD}/requests/${t3.body?.id}/reopen`, sol.token, { note: 'x' })).status === 409);

    const st = await req('GET', `${SD}/requests/stats`, agente.token);
    check('el tablero responde con abiertas y por prioridad', st.status === 200 && st.body?.open_total >= 1 && typeof st.body?.by_priority === 'object', dump(st));

    // ── 10. La base sigue coherente después de todo lo anterior ──────────────────
    console.log('\n10 — coherencia en la base');
    const ids = [T1.id, T2.id, t3.body?.id].filter(Boolean);
    const msgs = await knex('servicedesk.request_messages').whereIn('request_id', ids).where({ visibility: 'public', kind: 'internal_note' }).count({ n: '*' }).first();
    check('⭐ ninguna nota interna quedó pública en la base', Number(msgs.n) === 0);
    const dup = await knex('servicedesk.requests').where({ tenant_id: T }).groupBy('folio').havingRaw('count(*) > 1').select('folio');
    check('ningún folio repetido', dup.length === 0, JSON.stringify(dup));
    const wl = await knex('servicedesk.work_log').where({ request_id: T1.id }).sum({ m: 'minutes' }).first();
    check('el tiempo quedó en work_log con fuente «suite»', Number(wl.m) === 30);

    // ════════════════════════════════════════════════════════════════════════════
    // PARTE C — preferencias, avisos, configuración, SLA y auto-cierre
    // ════════════════════════════════════════════════════════════════════════════

    // Se guarda el estado de la configuración ANTES de tocarla: se restaura al final (la base dev es compartida).
    restaurar = {
      settings: await knex('servicedesk.settings').where({ tenant_id: T }).first(),
      policies: await knex('servicedesk.sla_policies').where({ tenant_id: T }).select('priority', 'first_response_minutes', 'resolution_minutes', 'clock'),
    };

    // ── 11. Configuración ───────────────────────────────────────────────────────
    console.log('\n11 — configuración (sólo coordinación)');
    for (const [quien, u] of [['el solicitante', sol], ['el agente (sin COORDINAR)', agente]]) {
      check(`${quien} NO lee la configuración → 403`, (await req('GET', `${SD}/config`, u.token)).status === 403);
      check(`${quien} NO la modifica → 403`, (await req('PUT', `${SD}/config/settings`, u.token, { auto_close_days: 5 })).status === 403);
      check(`${quien} NO dispara el barrido del SLA → 403`, (await req('POST', `${SD}/sla/scan-now`, u.token)).status === 403);
    }
    const cfg = await req('GET', `${SD}/config`, coord.token);
    check('la coordinación lee la configuración → 200', cfg.status === 200, dump(cfg));
    check('⭐ la escalación está APAGADA de fábrica (primero se mide)', cfg.body?.settings?.escalation_enabled === false, JSON.stringify(cfg.body?.settings));
    check('trae las 4 políticas, urgente primero en el reloj corrido', cfg.body?.policies?.length === 4 && cfg.body.policies.find((p) => p.priority === 'urgente')?.clock === 'calendar');
    check('el horario hábil de fábrica es Lun–Sáb 08:00–19:00 en hora de México', JSON.stringify(cfg.body?.settings?.business_days) === '[1,2,3,4,5,6]' && cfg.body?.settings?.business_start === '08:00' && cfg.body?.settings?.business_end === '19:00' && cfg.body?.settings?.tz === 'America/Mexico_City');

    console.log('\n   negativas de la configuración');
    const put = (p, body, tok = coord.token) => req('PUT', `${SD}${p}`, tok, body);
    check('día 7 no existe → 400', (await put('/config/settings', { business_days: [1, 7] })).status === 400);
    check('lista de días vacía → 400', (await put('/config/settings', { business_days: [] })).status === 400);
    check('hora mal escrita → 400', (await put('/config/settings', { business_start: '8am' })).status === 400);
    check('⭐ el horario no puede terminar antes de empezar (contra lo que quedaría) → 400', (await put('/config/settings', { business_end: '07:00' })).status === 400);
    check('zona horaria inventada → 400', (await put('/config/settings', { tz: 'Marte/Fobos' })).status === 400);
    check('auto-cierre de 0 días → 400', (await put('/config/settings', { auto_close_days: 0 })).status === 400);
    check('umbral de 0 % → 400', (await put('/config/settings', { escalate_at_pct: 0 })).status === 400);
    check('adjuntos de 16 MB → 400', (await put('/config/settings', { max_attachment_mb: 16 })).status === 400);
    check('escalation_enabled que no es booleano → 400', (await put('/config/settings', { escalation_enabled: 'si' })).status === 400);
    check('sin ningún campo → 400', (await put('/config/settings', {})).status === 400);
    check('⭐ la primera respuesta no puede tardar más que la resolución → 400', (await put('/config/policies/media', { first_response_minutes: 5000, resolution_minutes: 100 })).status === 400);
    check('prioridad inventada en la política → 400', (await put('/config/policies/critica', { resolution_minutes: 10 })).status === 400);
    check('reloj inventado → 400', (await put('/config/policies/media', { clock: 'lunar' })).status === 400);

    const okSet = await put('/config/settings', { auto_close_days: 4 });
    check('un cambio válido aplica y se devuelve la configuración nueva', okSet.status === 200 && okSet.body?.settings?.auto_close_days === 4, dump(okSet));
    const okPol = await put('/config/policies/baja', { resolution_minutes: 4000 });
    check('un cambio válido de política aplica', okPol.status === 200 && okPol.body?.policies?.find((p) => p.priority === 'baja')?.resolution_minutes === 4000, dump(okPol));

    const queues = cfg.body?.queues ?? [];
    const cola = queues[0];
    const codigo = `smoke_${SUF}`;
    check('código de categoría con mayúsculas → 400', (await req('POST', `${SD}/config/categories`, coord.token, { queue_id: cola?.id, code: 'MALO', name: 'x' })).status === 400);
    check('categoría sin nombre → 400', (await req('POST', `${SD}/config/categories`, coord.token, { queue_id: cola?.id, code: codigo, name: ' ' })).status === 400);
    check('categoría con cola inexistente → 400', (await req('POST', `${SD}/config/categories`, coord.token, { queue_id: '00000000-0000-0000-0000-000000000000', code: codigo, name: 'x' })).status === 400);
    const catNueva = await req('POST', `${SD}/config/categories`, coord.token, { queue_id: cola?.id, code: codigo, name: 'SMOKE categoría', default_priority: 'alta' });
    check('la coordinación da de alta una categoría', catNueva.status < 300 && catNueva.body?.categories?.some((c) => c.code === codigo), dump(catNueva));
    check('⭐ código repetido en la misma cola → 409', (await req('POST', `${SD}/config/categories`, coord.token, { queue_id: cola?.id, code: codigo, name: 'otra' })).status === 409);
    const nuevaId = catNueva.body?.categories?.find((c) => c.code === codigo)?.id;
    const visibleAntes = (await req('GET', `${SD}/catalog`, sol.token)).body?.categories?.some((c) => c.id === nuevaId);
    check('la categoría nueva aparece en el catálogo del solicitante', visibleAntes === true);
    const tAlta = await req('POST', `${SD}/requests`, sol.token, { category_id: nuevaId, title: 'SMOKE: categoría alta, impacto bajo' });
    check('una categoría «alta» sube la prioridad aunque el impacto sea «yo» sin bloqueo', tAlta.body?.priority === 'alta', `${tAlta.body?.priority}`);
    const apaga = await req('PUT', `${SD}/config/categories/${nuevaId}`, coord.token, { active: false });
    check('apagar una categoría no la borra', apaga.status === 200 && apaga.body?.categories?.find((c) => c.id === nuevaId)?.active === false, dump(apaga));
    check('⭐ una categoría apagada ya no se ofrece al solicitante', (await req('GET', `${SD}/catalog`, sol.token)).body?.categories?.every((c) => c.id !== nuevaId));
    check('⭐ y no se puede crear un ticket con ella → 400', (await req('POST', `${SD}/requests`, sol.token, { category_id: nuevaId, title: 'x' })).status === 400);
    check('los tickets viejos conservan su categoría apagada', (await req('GET', `${SD}/requests/${tAlta.body?.id}`, sol.token)).body?.category_id === nuevaId);
    check('editar con id que no es uuid → 404', (await req('PUT', `${SD}/config/categories/abc`, coord.token, { active: true })).status === 404);
    check('cola con código inválido → 400', (await req('POST', `${SD}/config/queues`, coord.token, { code: '1Mal', name: 'x' })).status === 400);
    check('cola con un departamento que no existe → 400', (await req('POST', `${SD}/config/queues`, coord.token, { code: `smoke_q_${SUF}`, name: 'x', department_code: 'no_existe_zzz' })).status === 400);

    // ── 12. Preferencias y contacto ─────────────────────────────────────────────
    console.log('\n12 — preferencias y contacto (cada quien sobre sí mismo)');
    const p0 = await req('GET', `${SD}/me/preferences`, sol.token);
    check('GET /me/preferences → 200 con el correo encendido por defecto y WhatsApp apagado', p0.status === 200 && p0.body?.email_enabled === true && p0.body?.whatsapp_enabled === false && p0.body?.whatsapp_opt_in_at === null, dump(p0));
    check('correo mal escrito → 400', (await req('PUT', `${SD}/me/preferences`, sol.token, { email: 'no-es-correo' })).status === 400);
    check('teléfono que no es de México de 10 dígitos → 400', (await req('PUT', `${SD}/me/preferences`, sol.token, { phone: '123' })).status === 400);
    check('⭐ activar WhatsApp SIN teléfono registrado → 400', (await req('PUT', `${SD}/me/preferences`, sol.token, { whatsapp_enabled: true })).status === 400);
    check('un campo que no es booleano → 400', (await req('PUT', `${SD}/me/preferences`, sol.token, { email_enabled: 'si' })).status === 400);
    const pTel = await req('PUT', `${SD}/me/preferences`, sol.token, { phone: '443 123 4567', email: `smoke_${SUF}@ejemplo.mx` });
    check('el teléfono se guarda en forma canónica 52XXXXXXXXXX', pTel.status === 200 && pTel.body?.phone === '524431234567', dump(pTel));
    check('el correo se guarda', pTel.body?.email === `smoke_${SUF}@ejemplo.mx`);
    const pWa = await req('PUT', `${SD}/me/preferences`, sol.token, { whatsapp_enabled: true });
    check('⭐ al activar WhatsApp queda escrita la FECHA DE CONSENTIMIENTO', pWa.status === 200 && pWa.body?.whatsapp_enabled === true && !!pWa.body?.whatsapp_opt_in_at, dump(pWa));
    check('⭐ nadie edita el contacto de OTRA persona: el cuerpo no acepta un user_id', (await req('PUT', `${SD}/me/preferences`, otro.token, { user_id: sol.id, email: 'robo@ejemplo.mx' })).status === 200 && (await knex('identity.users').where({ id: sol.id }).first('email')).email === `smoke_${SUF}@ejemplo.mx`);
    const pOtro = await req('GET', `${SD}/me/preferences`, otro.token);
    check('y las preferencias de otra persona no se mezclan con las mías', pOtro.body?.phone === null && pOtro.body?.whatsapp_enabled === false);

    // ── 13. Avisos ──────────────────────────────────────────────────────────────
    console.log('\n13 — avisos');
    const nAg = await req('GET', `${SD}/me/notifications`, agente.token);
    check('GET /me/notifications → 200', nAg.status === 200 && Array.isArray(nAg.body), dump(nAg));
    check('⭐ quien recibe un ticket asignado por la coordinación RECIBE el aviso «asignado»', nAg.body?.some((n) => n.event === 'asignado' && n.folio === T2.folio), JSON.stringify(nAg.body?.map((n) => n.event)));
    check('⭐ y quien se lo asigna a sí mismo (take) NO se auto-avisa', !nAg.body?.some((n) => n.event === 'asignado' && n.folio === T1.folio));
    check('lo urgente le llega a quien atiende como «nuevo_prioritario»', nAg.body?.some((n) => n.event === 'nuevo_prioritario' && n.folio === T2.folio && n.severity === 'critical'));
    const nSol = await req('GET', `${SD}/me/notifications`, sol.token);
    check('el solicitante recibió el comentario público del agente', nSol.body?.some((n) => n.event === 'comentario' && n.folio === T1.folio));
    check('⭐ y que su ticket quedó «resuelto» (dos veces: hubo una reapertura)', nSol.body?.filter((n) => n.event === 'resuelto' && n.folio === T1.folio).length === 2, JSON.stringify(nSol.body?.map((n) => n.event)));
    check('⭐ NINGÚN aviso del solicitante contiene el texto de la nota interna', !JSON.stringify(nSol.body).includes('usuario bloqueado en Kepler'));
    check('el agente fue avisado de la reapertura', nAg.body?.some((n) => n.event === 'reabierto' && n.folio === T1.folio));
    check('cada aviso trae título, mensaje con el folio y severidad', nSol.body?.every((n) => n.title && n.message.includes('SRV-') && ['info', 'warn', 'critical'].includes(n.severity)));
    check('`since` en el futuro no devuelve nada (la campana no relee lo ya mostrado)', (await req('GET', `${SD}/me/notifications?since=${encodeURIComponent(new Date(Date.now() + 3600e3).toISOString())}`, sol.token)).body?.length === 0);
    check('cada persona sólo ve SUS avisos', !(await req('GET', `${SD}/me/notifications`, otro.token)).body?.some((n) => n.folio === T1.folio));

    // Un aviso con el correo y el WhatsApp configurados deja el resultado de CADA canal.
    const t4 = await req('POST', `${SD}/requests`, sol.token, { category_id: catSimple.id, title: 'Aviso por tres canales' });
    await req('POST', `${SD}/requests/${t4.body?.id}/take`, agente.token);
    await req('POST', `${SD}/requests/${t4.body?.id}/messages`, agente.token, { body: 'Ya lo estoy viendo' });
    const log4 = await knex('servicedesk.notification_log').where({ request_id: t4.body?.id, recipient_id: sol.id, event: 'comentario' }).select('channel', 'status', 'error');
    const porCanal = Object.fromEntries(log4.map((l) => [l.channel, l]));
    check('⭐ el canal «app» queda ENVIADO (la fila es la entrega)', porCanal.app?.status === 'sent', JSON.stringify(log4));
    check('⭐ el correo queda registrado con su motivo, no fingido (SMTP sin configurar o enviado)', porCanal.email && ((porCanal.email.status === 'skipped' && porCanal.email.error === 'smtp_no_configurado') || porCanal.email.status === 'sent'), JSON.stringify(porCanal.email));
    check('⭐ WhatsApp (consentido) queda registrado como «no configurado», no fingido', porCanal.whatsapp?.status === 'skipped' && porCanal.whatsapp?.error === 'whatsapp_no_configurado', JSON.stringify(porCanal.whatsapp));
    const logOtro = await knex('servicedesk.notification_log').where({ request_id: t4.body?.id, recipient_id: agente.id }).select('channel', 'status', 'error');
    check('quien NO activó WhatsApp no genera ningún intento de WhatsApp', !logOtro.some((l) => l.channel === 'whatsapp'));
    check('⭐ sin correo registrado, el aviso por correo se declara «sin_correo_registrado»', (await knex('servicedesk.notification_log').where({ recipient_id: agente.id, channel: 'email', error: 'sin_correo_registrado' }).count({ n: '*' }).first()).n > 0);
    const apagaCorreo = await req('PUT', `${SD}/me/preferences`, sol.token, { email_enabled: false });
    check('apagar el correo se guarda', apagaCorreo.body?.email_enabled === false);
    await req('POST', `${SD}/requests/${t4.body?.id}/messages`, agente.token, { body: 'Segundo mensaje' });
    const sinCorreo = await knex('servicedesk.notification_log').where({ request_id: t4.body?.id, recipient_id: sol.id, channel: 'email' }).count({ n: '*' }).first();
    check('⭐ quien apagó el correo no recibe NI SIQUIERA un intento más por ese canal', Number(sinCorreo.n) === 1, `intentos de correo: ${sinCorreo.n}`);
    const dedup = await knex.raw(
      `SELECT dedup_key, channel, count(*)::int n FROM servicedesk.notification_log
        WHERE request_id = ? AND status = 'sent' GROUP BY 1,2 HAVING count(*) > 1`, [t4.body?.id]);
    check('⭐ ningún aviso ENVIADO se repite (la llave de dedup lo impide)', dedup.rows.length === 0, JSON.stringify(dedup.rows));

    // ── 14. SLA: medir primero, escalar después ─────────────────────────────────
    console.log('\n14 — barrido del SLA y auto-cierre');
    const t5 = await req('POST', `${SD}/requests`, sol.token, { category_id: catSimple.id, title: 'SMOKE: se me pasó el plazo' });
    await knex('servicedesk.requests').where({ id: t5.body?.id }).update({
      due_at: new Date(Date.now() - 3600e3), first_response_due_at: new Date(Date.now() - 7200e3),
    });
    const avisosAntes = Number((await knex('servicedesk.notification_log').where({ request_id: t5.body?.id }).whereIn('event', ['sla_vencido', 'sla_primera_respuesta_vencida', 'sla_por_vencer']).count({ n: '*' }).first()).n);
    const scan1 = await req('POST', `${SD}/sla/scan-now`, coord.token);
    check('POST /sla/scan-now → 200', scan1.status < 300, dump(scan1));
    check('⭐ el barrido MARCA lo que venció (primera respuesta Y resolución)', scan1.body?.marcados >= 2, JSON.stringify(scan1.body));
    const f5 = await knex('servicedesk.requests').where({ id: t5.body?.id }).first('sla_first_breached_at', 'sla_resolution_breached_at');
    check('las dos marcas quedaron escritas en el ticket', !!f5.sla_first_breached_at && !!f5.sla_resolution_breached_at);
    const avisosDespues = Number((await knex('servicedesk.notification_log').where({ request_id: t5.body?.id }).whereIn('event', ['sla_vencido', 'sla_primera_respuesta_vencida', 'sla_por_vencer']).count({ n: '*' }).first()).n);
    check('⭐ con la escalación APAGADA se mide pero NO se avisa a nadie', avisosDespues === avisosAntes && scan1.body?.avisos === 0, `avisos ${avisosAntes}→${avisosDespues}, resultado ${JSON.stringify(scan1.body)}`);
    check('el tablero cuenta lo vencido', (await req('GET', `${SD}/requests/stats`, agente.token)).body?.resolution_breached >= 1);
    const vista5 = await req('GET', `${SD}/requests/${t5.body?.id}`, sol.token);
    check('la vista del ticket dice que el SLA venció', vista5.body?.sla?.resolution_breached === true && vista5.body?.sla?.first_breached === true);
    const scan2 = await req('POST', `${SD}/sla/scan-now`, coord.token);
    check('⭐ IDEMPOTENTE: el segundo barrido no vuelve a marcar nada', scan2.body?.marcados === 0, JSON.stringify(scan2.body));

    // Se enciende la escalación: ahora SÍ se avisa, y una sola vez.
    check('la coordinación enciende la escalación', (await put('/config/settings', { escalation_enabled: true })).body?.settings?.escalation_enabled === true);
    const t6 = await req('POST', `${SD}/requests`, sol.token, { category_id: catSimple.id, title: 'SMOKE: vencida con escalación' });
    await knex('servicedesk.requests').where({ id: t6.body?.id }).update({ due_at: new Date(Date.now() - 3600e3), first_response_due_at: new Date(Date.now() - 7200e3) });
    const scan3 = await req('POST', `${SD}/sla/scan-now`, coord.token);
    check('con la escalación encendida el barrido AVISA', scan3.body?.avisos >= 1, JSON.stringify(scan3.body));
    const av6 = await knex('servicedesk.notification_log').where({ request_id: t6.body?.id, channel: 'app' }).select('event', 'recipient_id');
    check('⭐ un ticket SIN asignado avisa a quien atiende (agente y coordinación)', [agente.id, coord.id].every((id) => av6.some((a) => a.recipient_id === id && a.event === 'sla_vencido')), JSON.stringify(av6));
    check('⭐ el solicitante NO recibe los avisos internos del SLA', !av6.some((a) => a.recipient_id === sol.id));
    const n6 = av6.length;
    await req('POST', `${SD}/sla/scan-now`, coord.token);
    const n6b = (await knex('servicedesk.notification_log').where({ request_id: t6.body?.id, channel: 'app' }).count({ n: '*' }).first()).n;
    check('⭐ IDEMPOTENTE con avisos: un segundo barrido no repite ninguno', Number(n6b) === n6, `${n6} → ${n6b}`);
    await put('/config/settings', { escalation_enabled: false });

    // Auto-cierre: lo resuelto que nadie objetó se cierra solo.
    const t7 = await req('POST', `${SD}/requests`, sol.token, { category_id: catSimple.id, title: 'SMOKE: se cierra solo' });
    await req('POST', `${SD}/requests/${t7.body?.id}/take`, agente.token);
    await req('POST', `${SD}/requests/${t7.body?.id}/status`, agente.token, { status: 'en_proceso' });
    await req('POST', `${SD}/requests/${t7.body?.id}/status`, agente.token, { status: 'resuelto', note: 'Listo' });
    const antesAC = await req('POST', `${SD}/sla/scan-now`, coord.token);
    check('un resuelto RECIENTE no se cierra solo', (await knex('servicedesk.requests').where({ id: t7.body?.id }).first('status')).status === 'resuelto' && antesAC.body?.autocerrados === 0, JSON.stringify(antesAC.body));
    await knex('servicedesk.requests').where({ id: t7.body?.id }).update({ resolved_at: new Date(Date.now() - 6 * 86400e3) });
    const scanAC = await req('POST', `${SD}/sla/scan-now`, coord.token);
    check('⭐ un resuelto de hace 6 días (con auto_close_days = 4) se cierra SOLO', scanAC.body?.autocerrados >= 1, JSON.stringify(scanAC.body));
    const f7 = await knex('servicedesk.requests').where({ id: t7.body?.id }).first('status', 'close_reason', 'closed_by', 'closed_at');
    check('queda «cerrado» por «auto», sin persona que lo cerrara', f7.status === 'cerrado' && f7.close_reason === 'auto' && f7.closed_by === null && !!f7.closed_at, JSON.stringify(f7));
    const nSol2 = await req('GET', `${SD}/me/notifications`, sol.token);
    check('⭐ y el solicitante recibe «autocerrado» con cómo reabrir', nSol2.body?.some((n) => n.event === 'autocerrado' && n.folio === t7.body?.folio && n.message.toLowerCase().includes('repórtalo')));
    const hilo7 = await req('GET', `${SD}/requests/${t7.body?.id}`, sol.token);
    check('el hilo conserva el cierre automático con autor «Sistema»', hilo7.body?.messages?.some((m) => m.kind === 'status' && m.author_label === 'Sistema' && m.author_id === null));
    check('⭐ IDEMPOTENTE: el segundo barrido no cierra nada más', (await req('POST', `${SD}/sla/scan-now`, coord.token)).body?.autocerrados === 0);
    const latido = await knex('analytics.cron_runs').where({ tenant_id: T, job_key: 'service_desk_sla' }).first('status', 'rows_affected', 'last_finish', 'error');
    check('⭐ el barrido DEJA LATIDO en analytics.cron_runs (aun el manual)', !!latido && !!latido.last_finish, JSON.stringify(latido));
    check('y el latido no está en error', latido?.status === 'ok', JSON.stringify(latido));

    // ── 15. «A tu nombre» en Mi trabajo ─────────────────────────────────────────────
    console.log('\n15 — Mi trabajo › «A tu nombre» (GET /users/me/work)');
    const ABIERTOS = ['nuevo', 'asignado', 'en_proceso', 'en_espera'];
    const FUENTE = 'servicedesk.requests';
    const tareaDe = (r) => (r.body?.tareas ?? []).find((t) => t.fuente === FUENTE);

    // Un ticket en ESPERA, vencido: sigue siendo del agente pero su reloj está pausado.
    const tp = await req('POST', `${SD}/requests`, sol.token, { category_id: catSimple.id, title: 'SMOKE: en espera, con plazo viejo' });
    await req('POST', `${SD}/requests/${tp.body?.id}/take`, agente.token);
    await req('POST', `${SD}/requests/${tp.body?.id}/status`, agente.token, { status: 'en_espera', note: 'Espero al solicitante' });
    await knex('servicedesk.requests').where({ id: tp.body?.id }).update({ due_at: new Date(Date.now() - 5 * 3600e3) });
    // Y uno vencido de verdad, con el reloj corriendo.
    const tv = await req('POST', `${SD}/requests`, sol.token, { category_id: catSimple.id, title: 'SMOKE: vencido con reloj corriendo' });
    await req('POST', `${SD}/requests/${tv.body?.id}/take`, agente.token);
    await knex('servicedesk.requests').where({ id: tv.body?.id }).update({ due_at: new Date(Date.now() - 2 * 3600e3) });

    const wAg = await req('GET', '/users/me/work', agente.token);
    check('GET /users/me/work → 200', wAg.status === 200, dump(wAg));
    const tarea = tareaDe(wAg);
    check('⭐ el agente VE «Solicitudes de servicio a tu cargo» en lo asignado a su nombre', !!tarea, JSON.stringify((wAg.body?.tareas ?? []).map((t) => t.fuente)));
    const enDb = await knex('servicedesk.requests').where({ tenant_id: T, assigned_to: agente.id }).whereNull('deleted_at').whereIn('status', ABIERTOS)
      .select(knex.raw('count(*)::int AS n'), knex.raw('count(*) FILTER (WHERE paused_at IS NULL AND due_at < now())::int AS vivas'), knex.raw('count(*) FILTER (WHERE due_at < now())::int AS con_pausadas')).first();
    check('el total es EXACTAMENTE lo abierto que tiene asignado (medido contra la base)', tarea?.total === enDb.n, `${tarea?.total} vs ${enDb.n}`);
    check('⭐ el ticket en espera cuenta en el total pero NO como vencido: su reloj está pausado', tarea?.vencidas === enDb.vivas && enDb.con_pausadas > enDb.vivas, `vencidas ${tarea?.vencidas} · vivas ${enDb.vivas} · si contara las pausadas ${enDb.con_pausadas}`);
    check('⭐ el vencido con reloj corriendo SÍ cuenta (la prueba no es vacua)', enDb.vivas >= 1 && tarea?.vencidas >= 1);
    check('enlaza a la bandeja, filtrada a «lo mío»', tarea?.ruta === '/servicio/bandeja' && tarea?.queryParams?.scope === 'mine', JSON.stringify([tarea?.ruta, tarea?.queryParams]));
    check('declara lo que la fuente no puede contestar (en_espera proyectado a pending, sin historial de reasignación)', Array.isArray(tarea?.no_responde) && tarea.no_responde.length >= 2);

    const wSol = await req('GET', '/users/me/work', sol.token);
    check('⭐ quien sólo REPORTA no tiene nada a su nombre: tickets que abrió no son tareas suyas', !tareaDe(wSol), JSON.stringify((wSol.body?.tareas ?? []).map((t) => t.fuente)));

    // Rol 2 del contrato de tarea: si el dueño no tiene el permiso que abre la ruta, la fila se muestra SIN enlace y dice por qué.
    const sinPerm = await crearUsuario('sinperm');
    usuarios.push(sinPerm);
    const ts = await req('POST', `${SD}/requests`, sol.token, { category_id: catSimple.id, title: 'SMOKE: asignado a quien no puede abrirla' });
    await knex('servicedesk.requests').where({ id: ts.body?.id }).update({ assigned_to: sinPerm.id, assigned_by: agente.id, assigned_at: new Date(), status: 'asignado' });
    const wSin = await req('GET', '/users/me/work', sinPerm.token);
    const tSin = tareaDe(wSin);
    check('⭐ asignada a quien NO tiene permiso: la fila se muestra (no se esconde la discrepancia)', !!tSin && tSin.total === 1, JSON.stringify(wSin.body?.tareas));
    check('…pero SIN enlace y con el motivo (enlazarla invitaría a un 403)', tSin?.ruta === null && tSin?.queryParams === null && /Pídeselo a Sistemas/.test(tSin?.sin_acceso ?? ''), JSON.stringify([tSin?.ruta, tSin?.sin_acceso]));
    check('un ticket cerrado deja de ser tarea', await (async () => {
      const antes = tareaDe(await req('GET', '/users/me/work', agente.token))?.total;
      await req('POST', `${SD}/requests/${tv.body?.id}/status`, agente.token, { status: 'en_proceso' });
      await req('POST', `${SD}/requests/${tv.body?.id}/status`, agente.token, { status: 'resuelto', note: 'Listo' });
      const despues = tareaDe(await req('GET', '/users/me/work', agente.token))?.total;
      return despues === antes - 1;
    })());

    // ── 16. La cola sin asignar en Mi trabajo, con plazo ajustable ───────────────────
    console.log('\n16 — Mi trabajo › cola sin asignar (plazo en minutos HÁBILES, ajustable)');
    const BANDEJA = 'servicio-sin-asignar';
    const pendDe = (r) => (r.body?.pendientes ?? []).find((p) => p.id === BANDEJA);

    // `[SN.30]` Una cola se muestra SÓLO a quien responde de ella: el permiso abre la pantalla pero no pone la cola
    // en la portada. `coord` recibe la responsabilidad (se borra en cascada con el usuario); `agente` no.
    await knex('identity.user_responsibilities').insert({ tenant_id: T, user_id: coord.id, responsibility_key: 'servicio.atender', accion: 'suma', nota: 'smoke http-service-desk-test' });
    const cfg16 = await req('GET', `${SD}/config`, coord.token);
    check('⭐ el plazo nace en 60 minutos (1 hora) de fábrica', cfg16.body?.settings?.unassigned_alert_minutes === 60, JSON.stringify(cfg16.body?.settings));
    check('un plazo de 4 min (< 5) → 400', (await put('/config/settings', { unassigned_alert_minutes: 4 })).status === 400);
    check('un plazo de 1441 min (> 24 h) → 400', (await put('/config/settings', { unassigned_alert_minutes: 1441 })).status === 400);
    check('un plazo que no es entero → 400', (await put('/config/settings', { unassigned_alert_minutes: 'una hora' })).status === 400);
    check('el agente (sin COORDINAR) NO puede ajustarlo → 403', (await req('PUT', `${SD}/config/settings`, agente.token, { unassigned_alert_minutes: 10 })).status === 403);

    // Calendario de 24 h × 7 días SÓLO durante esta prueba: la espera hábil de un ticket de hace 3 h es entonces 180 min
    // aunque la corrida sea de noche (se restaura al final, junto con el resto de la configuración).
    check('calendario corrido para medir sin depender de la hora de la corrida', (await put('/config/settings', { business_days: [0, 1, 2, 3, 4, 5, 6], business_start: '00:00', business_end: '23:59' })).status < 300);
    const tn = await req('POST', `${SD}/requests`, sol.token, { category_id: catSimple.id, title: 'SMOKE: nadie lo ha tomado' });
    await knex('servicedesk.requests').where({ id: tn.body?.id }).update({ created_at: new Date(Date.now() - 3 * 3600e3) });
    const viejoDb = await knex('servicedesk.requests').where({ tenant_id: T, status: 'nuevo' }).whereNull('assigned_to').whereNull('deleted_at').min({ m: 'created_at' }).count({ n: '*' }).first();

    const w16 = await req('GET', '/users/me/work', coord.token);
    const b16 = pendDe(w16);
    check('⭐ quien atiende ve «Solicitudes de servicio sin asignar» en Mi trabajo', !!b16, JSON.stringify((w16.body?.pendientes ?? []).map((p) => p.id)));
    check('el total es EXACTAMENTE lo que la bandeja del servicio llama «Sin asignar» (medido contra la base)', b16?.total === Number(viejoDb.n), `${b16?.total} vs ${viejoDb.n}`);
    check('enlaza a la bandeja de atención', b16?.ruta === '/servicio/bandeja', JSON.stringify(b16?.ruta));
    check('⭐ declara el plazo con el que se juzgó: 60 min hábiles, sin umbral en días', b16?.umbral_minutos_habiles === 60 && b16?.umbral_dias === null, JSON.stringify([b16?.umbral_minutos_habiles, b16?.umbral_dias]));
    const esperaEsperada = (Date.now() - new Date(viejoDb.m).getTime()) / 60000;
    check('la espera del más viejo se mide en minutos (≥ 175 con el ticket de hace 3 h)', b16?.espera_minutos_habiles >= 175 && Math.abs(b16.espera_minutos_habiles - esperaEsperada) < 3, `${b16?.espera_minutos_habiles} vs ${esperaEsperada.toFixed(1)}`);
    check('⭐ con la espera al triple del plazo la cola NUNCA sale «al día» (atrasada, o algo de mayor prioridad)', ['se_acumula', 'atrasada', 'congelada'].includes(b16?.veredicto), b16?.veredicto);

    // La prueba de que es AJUSTABLE sin desplegar: se cambia el plazo y la siguiente lectura ya lo trae.
    check('el plazo se ajusta desde la configuración', (await put('/config/settings', { unassigned_alert_minutes: 1440 })).status < 300);
    const b16b = pendDe(await req('GET', '/users/me/work', coord.token));
    check('⭐ y Mi trabajo lo usa en la SIGUIENTE lectura (1440 min), sin reiniciar nada', b16b?.umbral_minutos_habiles === 1440, JSON.stringify(b16b?.umbral_minutos_habiles));
    check('con 24 h de plazo, un ticket de hace 3 h ya no es «atrasada» (el plazo es el único camino a ese veredicto)', b16b?.veredicto !== 'atrasada', b16b?.veredicto);
    await put('/config/settings', { unassigned_alert_minutes: 60 });

    // Tener el PERMISO no basta: el agente atiende pero no responde de repartir, y la cola no es suya.
    check('⭐ quien tiene el permiso pero NO responde de la cola no la ve (la bandeja no es de todo el que abre la pantalla)', !pendDe(await req('GET', '/users/me/work', agente.token)));

    // Sin permiso, sin bandeja: la cola no se le muestra a quien no atiende (y no se le inventa un cero).
    const wSol16 = await req('GET', '/users/me/work', sol.token);
    check('⭐ quien sólo reporta NO ve la cola sin asignar', !pendDe(wSol16), JSON.stringify((wSol16.body?.pendientes ?? []).map((p) => p.id)));

    // Tomarlo la saca de la cola: el total baja en uno.
    const antes16 = pendDe(await req('GET', '/users/me/work', coord.token))?.total;
    await req('POST', `${SD}/requests/${tn.body?.id}/take`, agente.token);
    const despues16 = pendDe(await req('GET', '/users/me/work', coord.token))?.total ?? 0;
    check('⭐ tomar el ticket lo saca de la cola sin asignar', despues16 === antes16 - 1, `${antes16} → ${despues16}`);

    {
    // ── 17. Asignación automática por regla (categoría o palabra clave) ─────────────────
    console.log('\n17 — asignación automática: una persona + categoría o palabras clave');
    const felipe = await crearUsuario('felipe', ['SERVICIO_ATENDER']);
    const david = await crearUsuario('david', ['SERVICIO_ATENDER']);
    const sinAtender = await crearUsuario('sinatender');
    usuarios.push(felipe, david, sinAtender);
    const catDesarrollo = (cat.body?.categories ?? []).find((c) => c.name === 'Desarrollo');
    check('el catálogo trae la categoría «Desarrollo» (migración 20261003110000)', !!catDesarrollo, JSON.stringify((cat.body?.categories ?? []).map((c) => c.name)));
    const crear = (title, extra = {}, cid = catSimple.id) => req('POST', `${SD}/requests`, sol.token, { category_id: cid, title, ...extra });
    const detalle = (id, tok = coord.token) => req('GET', `${SD}/requests/${id}`, tok);
    const reglas = (r) => r.body?.rules ?? [];

    // Administración: sólo la coordinación, y valida.
    check('el solicitante NO ve las reglas → 403', (await req('GET', `${SD}/config/routing`, sol.token)).status === 403);
    check('el agente (sin COORDINAR) NO las crea → 403', (await req('POST', `${SD}/config/routing`, agente.token, { name: 'x', keywords: ['a'], assignee_id: felipe.id })).status === 403);
    check('regla sin nombre → 400', (await req('POST', `${SD}/config/routing`, coord.token, { keywords: ['a'], assignee_id: felipe.id })).status === 400);
    check('⭐ regla sin categoría NI palabras → 400 (no se dispararía nunca)', (await req('POST', `${SD}/config/routing`, coord.token, { name: 'SMOKE vacía', assignee_id: felipe.id })).status === 400);
    check('regla sin persona → 400', (await req('POST', `${SD}/config/routing`, coord.token, { name: 'SMOKE sin persona', keywords: ['a'] })).status === 400);
    check('persona inexistente → 400', (await req('POST', `${SD}/config/routing`, coord.token, { name: 'SMOKE fantasma', keywords: ['a'], assignee_id: '00000000-0000-4000-8000-000000000000' })).status === 400);
    check('palabras que no son una lista → 400', (await req('POST', `${SD}/config/routing`, coord.token, { name: 'SMOKE mal', keywords: 'impresora', assignee_id: felipe.id })).status === 400);

    const rA = await req('POST', `${SD}/config/routing`, coord.token, { name: 'SMOKE equipo', keywords: ['Sistemas', 'CPU', ' Impresora ', 'impresora'], assignee_id: felipe.id, sort_order: 10 });
    check('⭐ alta de la regla de equipo → 200', rA.status < 300, dump(rA));
    const rAx = reglas(rA).find((r) => r.name === 'SMOKE equipo');
    check('las palabras se guardan normalizadas y sin repetir', JSON.stringify(rAx?.keywords) === JSON.stringify(['sistemas', 'cpu', 'impresora']), JSON.stringify(rAx?.keywords));
    check('la persona que puede atender sale «assignee_ok»', rAx?.assignee_ok === true);
    const rB = await req('POST', `${SD}/config/routing`, coord.token, { name: 'SMOKE desarrollo', keywords: ['desarrollo'], category_id: catDesarrollo?.id, assignee_id: david.id, sort_order: 20 });
    check('⭐ alta de la regla de desarrollo (categoría + palabra) → 200', rB.status < 300, dump(rB));
    const rBx = reglas(rB).find((r) => r.name === 'SMOKE desarrollo');
    const rC = await req('POST', `${SD}/config/routing`, coord.token, { name: 'SMOKE sin permiso', keywords: ['plotter'], assignee_id: sinAtender.id, sort_order: 30 });
    const rCx = reglas(rC).find((r) => r.name === 'SMOKE sin permiso');
    check('⭐ la persona SIN permiso de atender se marca «assignee_ok = false»', rCx?.assignee_ok === false, JSON.stringify(rCx));

    // Asignación al crear: por palabra, con acentos, mayúsculas y plural.
    const t1 = await crear('Falla la IMPRESORA de caja');
    const d1 = await detalle(t1.body?.id);
    check('⭐ «impresora» en el título → asignada a Felipe, ya en «asignado»', d1.body?.status === 'asignado' && d1.body?.assigned_to === felipe.id, JSON.stringify([d1.body?.status, d1.body?.assigned_to]));
    const f1 = await knex('servicedesk.requests').where({ id: t1.body?.id }).first('assigned_by', 'assigned_at', 'first_responded_at', 'status');
    check('⭐ la asignó el SISTEMA: no hay persona en `assigned_by`', f1.assigned_by === null && !!f1.assigned_at, JSON.stringify(f1));
    check('⭐ la asignación automática NO cuenta como primera respuesta (el reloj de respuesta sigue corriendo)', f1.first_responded_at === null, JSON.stringify(f1.first_responded_at));
    const a1 = (d1.body?.messages ?? []).find((m) => m.kind === 'assignment');
    check('el hilo dice quién, por qué regla y por qué palabra', a1?.meta?.auto === true && a1?.meta?.rule_name === 'SMOKE equipo' && a1?.meta?.keyword === 'impresora' && a1?.author_label === 'Sistema', JSON.stringify(a1));
    const nF = await req('GET', `${SD}/me/notifications`, felipe.token);
    check('⭐ Felipe recibe «Te asignaron una solicitud» y el aviso dice que fue AUTOMÁTICA', nF.body?.some((n) => n.event === 'asignado' && n.folio === t1.body?.folio && /autom/i.test(n.message)), JSON.stringify(nF.body?.slice(0, 2)));

    const t2 = await crear('Mis IMPRESORAS no imprimen', { description: 'desde ayer' });
    check('el plural y las mayúsculas también entran', (await detalle(t2.body?.id)).body?.assigned_to === felipe.id);
    const t3 = await crear('Se quemó la cpu del mostrador');
    check('«cpu» → Felipe', (await detalle(t3.body?.id)).body?.assigned_to === felipe.id);
    const t4 = await crear('Hola', { description: 'Necesito ayuda con SISTEMAS' });
    check('la palabra puede ir en la DESCRIPCIÓN', (await detalle(t4.body?.id)).body?.assigned_to === felipe.id);

    // Por categoría, sin que el texto diga nada.
    const t5 = await crear('Quiero algo nuevo', {}, catDesarrollo?.id);
    check('⭐ la categoría «Desarrollo» → David aunque el texto no diga nada', (await detalle(t5.body?.id)).body?.assigned_to === david.id);

    // El orden desambigua.
    const t6 = await crear('La impresora y el desarrollo del reporte');
    check('⭐ si menciona las dos cosas gana la regla que va primero (Felipe, orden 10)', (await detalle(t6.body?.id)).body?.assigned_to === felipe.id);

    // Sin regla: queda para quien reparte.
    const t7 = await crear('No puedo entrar a mi correo');
    const d7 = await detalle(t7.body?.id);
    check('⭐ sin regla que aplique, queda «nuevo» y sin asignar', d7.body?.status === 'nuevo' && d7.body?.assigned_to === null, JSON.stringify([d7.body?.status, d7.body?.assigned_to]));
    const t8 = await crear('Lo ocurrido en la bodega');
    check('⛔ una clave NO se encuentra en medio de otra palabra: sin regla → sin asignar', (await detalle(t8.body?.id)).body?.assigned_to === null);

    // Lo asignado automáticamente sale de la cola «sin asignar».
    const sinAsig = await req('GET', `${SD}/requests/inbox?scope=unassigned&limit=100`, coord.token);
    const idsSin = (sinAsig.body?.rows ?? []).map((r) => r.id);
    check('⭐ lo auto-asignado NO aparece en «Sin asignar»; lo que ninguna regla atrapó, sí', !idsSin.includes(t1.body?.id) && idsSin.includes(t7.body?.id));
    const mias = await req('GET', `${SD}/requests/inbox?scope=mine&limit=100`, felipe.token);
    check('y sí aparece en «Mías» de Felipe', (mias.body?.rows ?? []).some((r) => r.id === t1.body?.id));

    // Destino que no puede atender: NO se le asigna.
    const t9 = await crear('Se atoró el plotter de planos');
    const d9 = await detalle(t9.body?.id);
    check('⭐ la regla gana pero su persona NO puede atender → el ticket queda SIN asignar', d9.body?.status === 'nuevo' && d9.body?.assigned_to === null, JSON.stringify([d9.body?.status, d9.body?.assigned_to]));
    check('…y una nota INTERNA dice por qué (quien atiende la ve)', (d9.body?.messages ?? []).some((m) => m.visibility === 'internal' && /Asignación automática omitida/.test(m.body)));
    const d9sol = await detalle(t9.body?.id, sol.token);
    check('⛔ quien reportó NO ve esa nota interna', !(d9sol.body?.messages ?? []).some((m) => /Asignación automática omitida/.test(m.body)));

    // Prioridad alta + asignación: el asignado recibe SU aviso y no el genérico.
    const t10 = await crear('Se cayó la impresora de toda la sucursal', { impact: 'sucursal', blocks_work: true, warehouse_code: '02' });
    const d10 = await detalle(t10.body?.id);
    check('un ticket urgente también se auto-asigna', d10.body?.priority === 'urgente' && d10.body?.assigned_to === felipe.id, JSON.stringify([d10.body?.priority, d10.body?.assigned_to]));
    const nF2 = (await req('GET', `${SD}/me/notifications`, felipe.token)).body ?? [];
    const nD2 = (await req('GET', `${SD}/me/notifications`, david.token)).body ?? [];
    check('⭐ el asignado NO recibe además el aviso genérico «sin atender» del mismo ticket', !nF2.some((n) => n.event === 'nuevo_prioritario' && n.folio === t10.body?.folio) && nF2.some((n) => n.event === 'asignado' && n.folio === t10.body?.folio));
    check('el resto de quienes atienden SÍ recibe el aviso prioritario', nD2.some((n) => n.event === 'nuevo_prioritario' && n.folio === t10.body?.folio));

    // El asignado actúa: ahí sí cuenta la primera respuesta.
    await req('POST', `${SD}/requests/${t1.body?.id}/status`, felipe.token, { status: 'en_proceso' });
    const f1b = await knex('servicedesk.requests').where({ id: t1.body?.id }).first('first_responded_at', 'status');
    check('⭐ cuando Felipe empieza a trabajarlo SÍ se registra la primera respuesta', f1b.status === 'en_proceso' && !!f1b.first_responded_at, JSON.stringify(f1b));

    // Administración: editar, apagar, retirar.
    const up = await req('PUT', `${SD}/config/routing/${rAx?.id}`, coord.token, { keywords: ['impresora'] });
    check('editar las palabras de una regla', up.status < 300 && JSON.stringify(reglas(up).find((r) => r.id === rAx?.id)?.keywords) === '["impresora"]', dump(up));
    check('⭐ con «sistemas» fuera de la regla, ese texto ya no se asigna', (await detalle((await crear('Problema con sistemas')).body?.id)).body?.assigned_to === null);
    check('apagar la regla', (await req('PUT', `${SD}/config/routing/${rAx?.id}`, coord.token, { active: false })).status < 300);
    check('⭐ regla apagada no asigna', (await detalle((await crear('Otra impresora rota')).body?.id)).body?.assigned_to === null);
    check('encenderla', (await req('PUT', `${SD}/config/routing/${rAx?.id}`, coord.token, { active: true })).status < 300);
    check('editar dejando la regla sin categoría ni palabras → 400', (await req('PUT', `${SD}/config/routing/${rAx?.id}`, coord.token, { keywords: [] })).status === 400);
    const del = await req('DELETE', `${SD}/config/routing/${rAx?.id}`, coord.token);
    check('⭐ retirar una regla la saca de la lista', del.status < 300 && !reglas(del).some((r) => r.id === rAx?.id), dump(del));
    check('⭐ y ya no asigna', (await detalle((await crear('Y otra impresora más')).body?.id)).body?.assigned_to === null);
    check('retirar dos veces → 404', (await req('DELETE', `${SD}/config/routing/${rAx?.id}`, coord.token)).status === 404);
    await req('DELETE', `${SD}/config/routing/${rBx?.id}`, coord.token);
    await req('DELETE', `${SD}/config/routing/${rCx?.id}`, coord.token);

    }

    // ── 18. Reportes: cumplimiento, tiempos y recurrentes ─────────────────────────────
    {
      console.log('\n18 — reportes de la mesa (sólo coordinación)');
      const rep = (q = '', tok = coord.token) => req('GET', `${SD}/reports${q}`, tok);
      check('el solicitante NO ve los reportes → 403', (await rep('', sol.token)).status === 403);
      check('el agente (sin COORDINAR) NO los ve → 403', (await rep('', agente.token)).status === 403);
      check('sin token → 401', (await rep('', null)).status === 401);
      check('fecha imposible (31 de febrero) → 400, no se «corrige»', (await rep('?from=2026-02-31&to=2026-03-05')).status === 400);
      check('desde posterior a hasta → 400', (await rep('?from=2026-10-07&to=2026-10-06')).status === 400);
      check('periodo de más de 366 días → 400', (await rep('?from=2024-01-01&to=2026-10-06')).status === 400);
      check('fecha que no es fecha → 400', (await rep('?from=ayer')).status === 400);

      const hoy = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Mexico_City', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
      const q = `?from=${hoy}&to=${hoy}`;
      const antes = await rep(q);
      check('⭐ coordinación lee el reporte → 200', antes.status === 200, dump(antes));
      const A = antes.body;
      check('trae periodo, momento de medición y las cuatro prioridades (urgente primero)', A?.periodo?.desde === hoy && !!A?.medido_at && JSON.stringify(A?.por_prioridad?.map((p) => p.priority)) === '["urgente","alta","media","baja"]', JSON.stringify([A?.periodo, A?.por_prioridad?.map((p) => p.priority)]));
      check('sin parámetros son los últimos 30 días', (await rep()).body?.periodo?.hasta === hoy);

      // El total cuadra contra la base, medido independientemente.
      const enBase = await knex('servicedesk.requests').where({ tenant_id: T }).whereNull('deleted_at')
        .whereRaw(`created_at >= (?::date)::timestamp AT TIME ZONE 'America/Mexico_City' AND created_at < ((?::date + 1))::timestamp AT TIME ZONE 'America/Mexico_City'`, [hoy, hoy])
        .count({ n: '*' }).first();
      check('⭐ «creadas» es EXACTAMENTE lo que hay en la base para ese día (medido aparte)', A?.totales?.creados === Number(enBase.n), `${A?.totales?.creados} vs ${enBase.n}`);
      check('las tres rebanadas (prioridad, sucursal, estado) suman el mismo total', A.por_prioridad.reduce((s, p) => s + p.creados, 0) === A.totales.creados && A.por_sucursal.reduce((s, x) => s + x.creados, 0) === A.totales.creados && A.totales.resueltos + A.totales.abiertos + A.totales.cancelados === A.totales.creados, JSON.stringify(A.totales));
      check('⛔ el reporte NO trae nada por persona (ni asignado ni solicitante)', !/"(assign[a-z_]*|requester[a-z_]*|resolved_by|assignee[a-z_]*)":/i.test(JSON.stringify(A)));
      check('declara lo que no mide', Array.isArray(A.no_medido) && A.no_medido.some((t) => /personas/.test(t)));

      // Un ticket sin responder con el plazo vencido suma UN incumplido en primera respuesta; cancelarlo lo saca.
      const catX = catSimple.id;
      const mk = (title, extra = {}) => req('POST', `${SD}/requests`, sol.token, { category_id: catX, title, ...extra });
      const venc = await mk('SMOKE reporte: vencida sin responder');
      await knex('servicedesk.requests').where({ id: venc.body?.id }).update({ first_response_due_at: new Date(Date.now() - 3600e3), due_at: new Date(Date.now() - 1800e3) });
      const r1 = (await rep(q)).body;
      check('⭐ creadas +1 y un incumplido más de primera respuesta Y de resolución', r1.totales.creados === A.totales.creados + 1 && r1.primera_respuesta.incumplidos === A.primera_respuesta.incumplidos + 1 && r1.resolucion.incumplidos === A.resolucion.incumplidos + 1, JSON.stringify([r1.primera_respuesta, A.primera_respuesta]));
      await req('POST', `${SD}/requests/${venc.body?.id}/cancel`, sol.token, {});
      const r2 = (await rep(q)).body;
      check('⭐ cancelarla NO la cuenta como incumplida (sigue siendo demanda: creadas no baja)', r2.primera_respuesta.incumplidos === A.primera_respuesta.incumplidos && r2.resolucion.incumplidos === A.resolucion.incumplidos && r2.totales.creados === A.totales.creados + 1 && r2.totales.cancelados === A.totales.cancelados + 1, JSON.stringify([r2.totales, A.totales]));

      // Resolver a tiempo suma un cumplido y entra a los tiempos.
      const ok1 = await mk('SMOKE reporte: se resuelve a tiempo');
      await req('POST', `${SD}/requests/${ok1.body?.id}/take`, agente.token);
      await req('POST', `${SD}/requests/${ok1.body?.id}/status`, agente.token, { status: 'en_proceso' });
      await req('POST', `${SD}/requests/${ok1.body?.id}/status`, agente.token, { status: 'resuelto', note: 'Listo' });
      const r3 = (await rep(q)).body;
      check('⭐ resolver a tiempo suma un cumplido en primera respuesta y en resolución', r3.primera_respuesta.cumplidos === r2.primera_respuesta.cumplidos + 1 && r3.resolucion.cumplidos === r2.resolucion.cumplidos + 1 && r3.totales.resueltos === r2.totales.resueltos + 1, JSON.stringify([r3.resolucion, r2.resolucion]));
      const prio = r3.por_prioridad.find((p) => p.t_resolucion.n > 0);
      check('hay tiempos de resolución medidos (n > 0) con mediana y P90', !!prio && prio.t_resolucion.p50 !== null && prio.t_resolucion.p90 !== null, JSON.stringify(r3.por_prioridad.map((p) => [p.priority, p.t_resolucion])));
      check('⛔ una prioridad sin tickets resueltos NO muestra 0 minutos sino null', r3.por_prioridad.filter((p) => p.t_resolucion.n === 0).every((p) => p.t_resolucion.p50 === null && p.t_resolucion.p90 === null));

      // Recurrentes: la misma categoría en la misma sucursal, 3 veces.
      const antesRec = (r3.recurrentes ?? []).find((x) => x.category_id === catX && x.warehouse_code === '04')?.n ?? 0;
      for (let i = 0; i < 3; i++) await mk(`SMOKE reporte: se repite ${i}`, { warehouse_code: '04' });
      const r4 = (await rep(q)).body;
      const rec = (r4.recurrentes ?? []).find((x) => x.category_id === catX && x.warehouse_code === '04');
      check('⭐ tres iguales en la misma sucursal aparecen en «lo que se repite»', !!rec && rec.n === antesRec + 3, JSON.stringify(rec));
      check('el reporte nombra la sucursal', typeof rec?.warehouse_name === 'string' && rec.warehouse_name.length > 0, JSON.stringify(rec));
      check('el reporte de ayer NO incluye los tickets de hoy (el periodo corta por creación)', (await rep(`?from=2020-01-01&to=2020-01-02`)).body?.totales?.creados === 0);
    }

    noMedido.push('correo y WhatsApp REALES: el SMTP no está configurado y la plantilla de Meta no está aprobada (P5); lo que se afirma es que el resultado queda DECLARADO por canal');
    noMedido.push('push en vivo por WebSocket (la API de este test corre sin cliente conectado); el poll de la campana sí se midió');

    noMedido.push('aislamiento entre tenants POR HTTP (lo cubre RLS en test-newdb-service-desk.js)');
  } finally {
    // La base dev es compartida: lo que la prueba cambió de la CONFIGURACIÓN se restaura tal como estaba.
    if (restaurar) {
      const { tenant_id, created_at, created_by, ...ajustes } = restaurar.settings;
      await knex('servicedesk.settings').where({ tenant_id: T }).update(ajustes);
      for (const p of restaurar.policies) {
        await knex('servicedesk.sla_policies').where({ tenant_id: T, priority: p.priority }).update({
          first_response_minutes: p.first_response_minutes, resolution_minutes: p.resolution_minutes, clock: p.clock,
        });
      }
    }
    // Se borra con la conexión PRIVILEGIADA: `app_runtime` no tiene DELETE sobre el registro, y es lo correcto.
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
      await knex('servicedesk.routing_rules').whereIn('assignee_id', ids).del();
      await knex('servicedesk.notification_prefs').whereIn('user_id', ids).del();
      await knex('identity.user_permissions').whereIn('user_id', ids).del();
      await knex('identity.user_roles').whereIn('user_id', ids).del();
      await knex('identity.users').whereIn('id', ids).del();
    }
    await knex('servicedesk.categories').where({ tenant_id: T }).where('code', 'like', 'smoke_%').del();
    await knex('servicedesk.queues').where({ tenant_id: T }).where('code', 'like', 'smoke_%').del();
    await knex.destroy();
  }

  if (noMedido.length) {
    console.log('\n  NO MEDIDO (declarado, no dibujado como verde):');
    for (const n of noMedido) console.log(`   · ${n}`);
  }
  console.log(`\n=== ${pass} ✅  ${fail} ❌ ===\n`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
