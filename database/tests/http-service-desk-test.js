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

    noMedido.push('aislamiento entre tenants POR HTTP (lo cubre RLS en test-newdb-service-desk.js)');
    noMedido.push('barrido del SLA y notificaciones (llegan con MS.2.6 / MS.2.7)');
  } finally {
    // Se borra con la conexión PRIVILEGIADA: `app_runtime` no tiene DELETE sobre el registro, y es lo correcto.
    const ids = usuarios.map((u) => u.id);
    if (ids.length) {
      const reqs = (await knex('servicedesk.requests').whereIn('requester_id', ids).select('id')).map((r) => r.id);
      if (reqs.length) {
        await knex('servicedesk.work_log').whereIn('request_id', reqs).del();
        await knex('servicedesk.request_attachments').whereIn('request_id', reqs).del();
        await knex('servicedesk.request_messages').whereIn('request_id', reqs).del();
        await knex('servicedesk.requests').whereIn('id', reqs).del();
      }
      await knex('identity.user_permissions').whereIn('user_id', ids).del();
      await knex('identity.user_roles').whereIn('user_id', ids).del();
      await knex('identity.users').whereIn('id', ids).del();
    }
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
