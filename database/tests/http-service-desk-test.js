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

let _colaTi = null;
async function idColaTi() {
  _colaTi ??= (await knex('servicedesk.queues').where({ tenant_id: T, code: 'ti' }).first('id')).id;
  return _colaTi;
}

/**
 * `membresias`: a qué colas pertenece (`[{ queue_id, role }]`). `[MS.7.6]` Sin indicarlo, quien recibe SERVICIO_ATENDER o
 * SERVICIO_COORDINAR queda como miembro de TI (coordinador si tiene la de coordinar): es lo que hace la migración de
 * respaldo con quien ya atendía TI. Con `[]` se prueba al que tiene la clave pero NINGUNA cola.
 */
async function crearUsuario(etiqueta, overrides = [], membresias) {
  const username = `smoke_sd_${etiqueta}_${SUF}`.slice(0, 40);
  const [{ id }] = await knex('identity.users')
    .insert({ tenant_id: T, username, nombre: `SMOKE ${etiqueta}`, password_hash: await bcrypt.hash(PASS_PLANO, 10), role_name: ROL_BASE })
    .returning('id');
  for (const k of overrides) {
    await knex('identity.user_permissions').insert({ tenant_id: T, user_id: id, permission_key: k, allow: true, nota: 'smoke http-service-desk-test' });
  }
  const atiende = overrides.includes('SERVICIO_ATENDER') || overrides.includes('SERVICIO_COORDINAR');
  const miembro = membresias ?? (atiende ? [{ queue_id: await idColaTi(), role: overrides.includes('SERVICIO_COORDINAR') ? 'coordinador' : 'tecnico' }] : []);
  for (const m of miembro) await knex('servicedesk.queue_members').insert({ tenant_id: T, queue_id: m.queue_id, user_id: id, role: m.role });
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
  let mtoActivaAntes = null; // `[MS.7.14]` la cola de Mantenimiento vuelve a como estaba
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

    const espera = await req('POST', `${SD}/requests/${T1.id}/status`, agente.token, { status: 'en_espera', pause_reason: 'solicitante', note: 'Espero que me confirmes tu usuario' });
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
      policies: await knex('servicedesk.sla_policies').where({ tenant_id: T }).whereNull('queue_id').select('priority', 'first_response_minutes', 'resolution_minutes', 'clock'),
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
    // `[MS.7.2]` La respuesta trae también los plazos propios de cada cola (queue_id con valor): las GENERALES son las de queue_id null.
    const generales = (cfg.body?.policies ?? []).filter((p) => p.queue_id === null);
    check('trae las 4 políticas GENERALES, urgente primero en el reloj corrido', generales.length === 4 && generales.find((p) => p.priority === 'urgente')?.clock === 'calendar');
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
    await req('POST', `${SD}/requests/${tp.body?.id}/status`, agente.token, { status: 'en_espera', pause_reason: 'solicitante', note: 'Espero al solicitante' });
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
    // `[MS.7.18]` «Sin asignar» es el de las colas de ESTA persona (coord es de TI), no el de toda la empresa.
    const viejoDb = await knex('servicedesk.requests').where({ tenant_id: T, status: 'nuevo' }).whereNull('assigned_to').whereNull('deleted_at')
      .whereIn('queue_id', knex('servicedesk.queue_members').where({ user_id: coord.id, active: true }).select('queue_id'))
      .min({ m: 'created_at' }).count({ n: '*' }).first();

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

    // ── 19. Levantar una solicitud A NOMBRE DE otra persona (sólo quien atiende) ──────────
    {
      console.log('\n19 — quien atiende levanta una solicitud a nombre de otra persona');
      const detalle = (id, tok = coord.token) => req('GET', `${SD}/requests/${id}`, tok);
      const catSucursalPrueba = (cat.body?.categories ?? []).find((c) => c.requires_branch);
      const deptos = await knex('identity.departments').where({ tenant_id: T }).whereNull('deleted_at').orderBy('orden').limit(2).select('code', 'name');
      check('hay al menos 2 áreas en el catálogo para probar el cambio de área', deptos.length >= 2, JSON.stringify(deptos));
      const [depA, depB] = deptos;
      // La ficha de `sol` trae área y sucursal: es lo que el formulario precarga.
      await knex('identity.users').where({ id: sol.id }).update({ department_code: depA.code, warehouse_code: '02' });
      const servicio = await crearUsuario('cuentaservicio');
      const baja = await crearUsuario('dadadebaja');
      usuarios.push(servicio, baja);
      await knex('identity.users').where({ id: servicio.id }).update({ kind: 'servicio' });
      await knex('identity.users').where({ id: baja.id }).update({ deleted_at: new Date() });

      // Buscador de personas.
      check('el solicitante NO puede buscar personas → 403', (await req('GET', `${SD}/requesters?search=smoke`, sol.token)).status === 403);
      check('el solicitante NO ve el catálogo de áreas → 403', (await req('GET', `${SD}/departments`, sol.token)).status === 403);
      const dp = await req('GET', `${SD}/departments`, agente.token);
      check('quien atiende ve las áreas (código y nombre)', dp.status === 200 && dp.body?.length >= 2 && dp.body.every((d) => d.code && d.name), dump(dp));
      check('⛔ una búsqueda de 1 letra devuelve vacío (no es un padrón navegable)', (await req('GET', `${SD}/requesters?search=s`, agente.token)).body?.length === 0);
      check('sin texto, vacío', (await req('GET', `${SD}/requesters`, agente.token)).body?.length === 0);
      const b1 = await req('GET', `${SD}/requesters?search=${encodeURIComponent('SMOKE solicitante')}`, agente.token);
      const esSol = (b1.body ?? []).find((p) => p.user_id === sol.id);
      check('⭐ quien atiende encuentra a la persona por nombre', b1.status === 200 && !!esSol, dump(b1));
      check('trae su área (con nombre) y su sucursal para precargar el formulario', esSol?.department_code === depA.code && esSol?.department_name === depA.name && esSol?.warehouse_code === '02' && !!esSol?.warehouse_name, JSON.stringify(esSol));
      check('⛔ NO trae correo, teléfono ni nada de credenciales', !/email|phone|password|hash|token/i.test(JSON.stringify(b1.body)));
      const todos = await req('GET', `${SD}/requesters?search=smoke`, agente.token);
      const ids = (todos.body ?? []).map((p) => p.user_id);
      check('⭐ no ofrece cuentas de servicio ni personas dadas de baja', !ids.includes(servicio.id) && !ids.includes(baja.id) && ids.includes(sol.id), JSON.stringify(ids));
      check('tope de 20 resultados', (todos.body ?? []).length <= 20);

      // Levantar a nombre de otra persona.
      const nombreAg = (await knex('identity.users').where({ id: agente.id }).first('nombre')).nombre;
      const cT = await req('POST', `${SD}/requests`, agente.token, { category_id: catSimple.id, title: 'SMOKE a nombre de: se les cae la caja', description: 'Me lo pidieron por teléfono', requester_id: sol.id, impact: 'varios' });
      check('⭐ quien atiende levanta la solicitud a nombre de otra persona → 201', cT.status === 201, dump(cT));
      const dT = await detalle(cT.body?.id, coord.token);
      check('⭐ el SOLICITANTE es la otra persona, no quien la levantó', dT.body?.requester_id === sol.id && dT.body?.requester_name === 'SMOKE solicitante', JSON.stringify([dT.body?.requester_id, dT.body?.requester_name]));
      check('⭐ la ficha dice QUIÉN la levantó', dT.body?.opened_by_name === nombreAg, JSON.stringify(dT.body?.opened_by_name));
      check('toma el ÁREA de la ficha del solicitante (con su nombre)', dT.body?.requester_department_code === depA.code && dT.body?.requester_department_name === depA.name, JSON.stringify([dT.body?.requester_department_code, dT.body?.requester_department_name]));
      const mA = (dT.body?.messages ?? []).find((m) => m.kind === 'system');
      check('el hilo lo deja dicho: «levantada por … a nombre de …»', /levantada por .* a nombre de SMOKE solicitante/.test(mA?.body ?? '') && mA?.meta?.opened_on_behalf === true && mA?.meta?.opened_by === agente.id, JSON.stringify(mA));
      const filaT = await knex('servicedesk.requests').where({ id: cT.body?.id }).first('created_by', 'requester_id');
      check('la base guarda quién la creó (el agente) aparte del solicitante', filaT.created_by === agente.id && filaT.requester_id === sol.id, JSON.stringify(filaT));

      // La persona la ve, la recibe y la puede cerrar.
      const mias = await req('GET', `${SD}/requests/mine?scope=open&limit=100`, sol.token);
      check('⭐ la solicitud aparece en «Mis solicitudes» de la persona', (mias.body?.rows ?? []).some((r) => r.id === cT.body?.id));
      const dSol = await detalle(cT.body?.id, sol.token);
      check('la persona abre su ficha y ve quién la levantó', dSol.status === 200 && dSol.body?.opened_by_name === nombreAg, dump(dSol));
      const nS = await req('GET', `${SD}/me/notifications`, sol.token);
      check('⭐ a la persona se le AVISA que se levantó una solicitud a su nombre', nS.body?.some((n) => n.event === 'levantada' && n.folio === cT.body?.folio && /la levantó/.test(n.message)), JSON.stringify(nS.body?.slice(0, 2)));
      const nA = await req('GET', `${SD}/me/notifications`, agente.token);
      check('quien la levantó no recibe aviso de su propia acción', !nA.body?.some((n) => n.event === 'levantada' && n.folio === cT.body?.folio));
      check('quien atiende NO queda como solicitante: no la ve en su «Mis solicitudes»', !((await req('GET', `${SD}/requests/mine?scope=open&limit=100`, agente.token)).body?.rows ?? []).some((r) => r.id === cT.body?.id));
      await req('POST', `${SD}/requests/${cT.body?.id}/take`, agente.token);
      await req('POST', `${SD}/requests/${cT.body?.id}/status`, agente.token, { status: 'en_proceso' });
      await req('POST', `${SD}/requests/${cT.body?.id}/status`, agente.token, { status: 'resuelto', note: 'Listo' });
      const conf = await req('POST', `${SD}/requests/${cT.body?.id}/confirm`, sol.token, {});
      check('⭐ y es la PERSONA (no quien la levantó) quien la confirma y la cierra', conf.status < 300 && conf.body?.status === 'cerrado', dump(conf));
      const tOb = await req('POST', `${SD}/requests`, agente.token, { category_id: catSimple.id, title: 'SMOKE a nombre de: confirmar', requester_id: sol.id });
      await req('POST', `${SD}/requests/${tOb.body?.id}/take`, agente.token);
      await req('POST', `${SD}/requests/${tOb.body?.id}/status`, agente.token, { status: 'en_proceso' });
      await req('POST', `${SD}/requests/${tOb.body?.id}/status`, agente.token, { status: 'resuelto', note: 'Listo' });
      check('⛔ quien la levantó NO puede confirmarla en lugar de la persona', (await req('POST', `${SD}/requests/${tOb.body?.id}/confirm`, agente.token, {})).status >= 400);

      // Cambiar el área.
      const cB = await req('POST', `${SD}/requests`, agente.token, { category_id: catSimple.id, title: 'SMOKE a nombre de: otra área', requester_id: sol.id, department_code: depB.code });
      check('⭐ quien atiende puede indicar OTRA área distinta a la de la ficha', (await detalle(cB.body?.id)).body?.requester_department_code === depB.code && (await detalle(cB.body?.id)).body?.requester_department_name === depB.name);
      check('un área que no existe → 400', (await req('POST', `${SD}/requests`, agente.token, { category_id: catSimple.id, title: 'x', requester_id: sol.id, department_code: 'no_existe_esta_area' })).status === 400);
      const cC = await req('POST', `${SD}/requests`, agente.token, { category_id: catSimple.id, title: 'SMOKE a nombre de: sólo el área', department_code: depB.code });
      const dC = await detalle(cC.body?.id);
      check('el área también se puede indicar sin cambiar de persona (la solicitud queda a nombre de quien la levanta)', dC.body?.requester_id === agente.id && dC.body?.requester_department_code === depB.code && dC.body?.opened_by_name === null, JSON.stringify([dC.body?.requester_id, dC.body?.requester_department_code, dC.body?.opened_by_name]));

      // Sucursal.
      const sRequerida = await req('POST', `${SD}/requests`, agente.token, { category_id: catSucursalPrueba.id, title: 'SMOKE a nombre de: sin sucursal', requester_id: sol.id });
      check('una categoría que EXIGE sucursal la sigue exigiendo aunque se levante a nombre de otro → 400', sRequerida.status === 400, dump(sRequerida));
      const sOk = await req('POST', `${SD}/requests`, agente.token, { category_id: catSucursalPrueba.id, title: 'SMOKE a nombre de: con sucursal', requester_id: sol.id, warehouse_code: '03' });
      check('con la sucursal indicada por quien atiende se acepta y queda esa sucursal', sOk.status === 201 && sOk.body?.warehouse_code === '03', dump(sOk));

      // Quién NO puede.
      check('⭐ el solicitante NO puede levantarla a nombre de OTRA persona → 403', (await req('POST', `${SD}/requests`, sol.token, { category_id: catSimple.id, title: 'x', requester_id: otro.id })).status === 403);
      check('⭐ ni cambiar el área → 403', (await req('POST', `${SD}/requests`, sol.token, { category_id: catSimple.id, title: 'x', department_code: depB.code })).status === 403);
      const propio = await req('POST', `${SD}/requests`, sol.token, { category_id: catSimple.id, title: 'SMOKE: a mi propio nombre', requester_id: sol.id });
      check('mandar su PROPIO id equivale a no mandarlo (sigue siendo suya) → 201', propio.status === 201 && propio.body?.requester_id === sol.id && propio.body?.opened_by_name === null, dump(propio));

      // Personas que no pueden figurar.
      check('persona inexistente → 400', (await req('POST', `${SD}/requests`, agente.token, { category_id: catSimple.id, title: 'x', requester_id: '00000000-0000-4000-8000-000000000000' })).status === 400);
      check('⛔ una cuenta de servicio no puede ser solicitante → 400', (await req('POST', `${SD}/requests`, agente.token, { category_id: catSimple.id, title: 'x', requester_id: servicio.id })).status === 400);
      check('⛔ una persona dada de baja no puede ser solicitante → 400', (await req('POST', `${SD}/requests`, agente.token, { category_id: catSimple.id, title: 'x', requester_id: baja.id })).status === 400);
      check('requester_id que no es uuid → 400', (await req('POST', `${SD}/requests`, agente.token, { category_id: catSimple.id, title: 'x', requester_id: 'no-soy-uuid' })).status === 400);
    }

    // ── 22. [MS.7.6] Acceso por cola: clave ∩ pertenencia, y el god-mode como única excepción ───────────
    {
      console.log('\n22 — acceso por cola: un técnico de Mantenimiento no ve TI (y al revés)');
      const colaTi = await knex('servicedesk.queues').where({ tenant_id: T, code: 'ti' }).first('id');
      const [{ id: qMto }] = await knex('servicedesk.queues').insert({ tenant_id: T, code: 'smoke_mto76', name: 'SMOKE Mantenimiento', sort_order: 900 }).returning('id');
      const [{ id: catMto }] = await knex('servicedesk.categories').insert({ tenant_id: T, queue_id: qMto, code: 'smoke_mto76_cat', name: 'SMOKE Mto categoría', default_priority: 'media', requires_branch: false }).returning('id');
      const tecMto = await crearUsuario('tecmto', ['SERVICIO_ATENDER'], [{ queue_id: qMto, role: 'tecnico' }]);
      const coordMto = await crearUsuario('coordmto', ['SERVICIO_ATENDER', 'SERVICIO_COORDINAR'], [{ queue_id: qMto, role: 'coordinador' }]);
      const huerfano = await crearUsuario('huerfano', ['SERVICIO_ATENDER', 'SERVICIO_COORDINAR'], []);
      const dios = await crearUsuario('dios');
      await knex('identity.users').where({ id: dios.id }).update({ role_name: 'superadmin' });
      dios.token = (await req('POST', '/auth-mt/login', null, { tenant_slug: 'mega_dulces', username: dios.username, password: PASS_PLANO })).body?.access_token ?? null;
      usuarios.push(tecMto, coordMto, huerfano, dios);
      check('los usuarios de la prueba entran', [tecMto, coordMto, huerfano, dios].every((u) => !!u.token));

      const palabra = `smokepalabra${SUF}`;
      const mk = (token, categoria, title, extra = {}) => req('POST', `${SD}/requests`, token, { category_id: categoria, title, ...extra });
      const tMto = await mk(sol.token, catMto, 'SMOKE 7.6 ticket de Mantenimiento');
      const tTi = await mk(sol.token, catSimple.id, 'SMOKE 7.6 ticket de TI');
      check('quien reporta puede levantar a cualquier cola (el alta no se acota)', tMto.status === 201 && tTi.status === 201, dump(tMto) + dump(tTi));
      const idMto = tMto.body?.id;
      const idTi = tTi.body?.id;
      const filasDe = async (token, qs = '') => (await req('GET', `${SD}/requests/inbox?scope=all&limit=200${qs}`, token)).body?.rows ?? [];
      const ids = (rows) => new Set(rows.map((r) => r.id));

      // ── bandeja, ficha y tablero ──
      const bTec = ids(await filasDe(tecMto.token));
      check('⭐ el técnico de Mantenimiento ve el ticket de Mantenimiento en su bandeja', bTec.has(idMto));
      check('⭐ y NO ve el de TI', !bTec.has(idTi));
      const bAg = ids(await filasDe(agente.token));
      check('⭐ el agente de TI ve el de TI y NO el de Mantenimiento', bAg.has(idTi) && !bAg.has(idMto));
      const bCoord = ids(await filasDe(coord.token));
      check('⭐ ni siquiera el COORDINADOR de TI ve el de Mantenimiento (otra cola, otra coordinación)', bCoord.has(idTi) && !bCoord.has(idMto));
      check('⛔ el técnico de Mantenimiento NO abre el ticket de TI por URL directa → 404', (await req('GET', `${SD}/requests/${idTi}`, tecMto.token)).status === 404);
      check('⛔ el agente de TI NO abre el de Mantenimiento por URL directa → 404', (await req('GET', `${SD}/requests/${idMto}`, agente.token)).status === 404);
      check('⛔ el coordinador de TI tampoco → 404', (await req('GET', `${SD}/requests/${idMto}`, coord.token)).status === 404);
      check('quien reportó SÍ ve su ticket de Mantenimiento', (await req('GET', `${SD}/requests/${idMto}`, sol.token)).status === 200);
      check('otro solicitante NO lo ve → 404', (await req('GET', `${SD}/requests/${idMto}`, otro.token)).status === 404);

      const abiertosMto = Number((await knex('servicedesk.requests').where({ queue_id: qMto }).whereNull('deleted_at').whereNotIn('status', ['cerrado', 'cancelado']).count({ n: '*' }).first()).n);
      const stTec = (await req('GET', `${SD}/requests/stats`, tecMto.token)).body;
      check('⭐ el tablero del técnico cuenta SÓLO su cola', stTec?.open_total === abiertosMto, JSON.stringify(stTec));
      const abiertosTi = Number((await knex('servicedesk.requests').where({ queue_id: colaTi.id }).whereNull('deleted_at').whereNotIn('status', ['cerrado', 'cancelado']).count({ n: '*' }).first()).n);
      const stAg = (await req('GET', `${SD}/requests/stats`, agente.token)).body;
      check('⭐ el tablero del agente de TI NO suma Mantenimiento', stAg?.open_total === abiertosTi, `${stAg?.open_total} vs ${abiertosTi}`);

      // ── la clave SOLA no basta ──
      const bHue = await req('GET', `${SD}/requests/inbox?scope=all&limit=200`, huerfano.token);
      check('⛔ NEGATIVA — quien tiene las claves pero NINGUNA cola ve 0 solicitudes (no «todas»)', bHue.status === 200 && (bHue.body?.rows ?? []).length === 0 && bHue.body?.total === 0, dump(bHue));
      const stHue = (await req('GET', `${SD}/requests/stats`, huerfano.token)).body;
      check('⛔ y su tablero sale en ceros (no el total de la empresa)', stHue?.open_total === 0 && stHue?.unassigned === 0, JSON.stringify(stHue));
      check('⛔ no abre ninguna ficha ajena → 404', (await req('GET', `${SD}/requests/${idTi}`, huerfano.token)).status === 404);
      check('⛔ no tiene reporte (no coordina ninguna cola) → 403, no un reporte vacío', (await req('GET', `${SD}/reports`, huerfano.token)).status === 403);

      // ── el god-mode es la única excepción ──
      const bDios = ids(await filasDe(dios.token));
      check('⭐ el god-mode ve las dos colas', bDios.has(idMto) && bDios.has(idTi));
      check('y abre cualquier ficha', (await req('GET', `${SD}/requests/${idMto}`, dios.token)).status === 200);

      // ── acciones sobre el ticket ──
      check('⛔ el agente de TI NO toma el ticket de Mantenimiento → 404', (await req('POST', `${SD}/requests/${idMto}/take`, agente.token)).status === 404);
      check('⛔ el agente de TI NO deja una nota interna en él → 404', (await req('POST', `${SD}/requests/${idMto}/messages`, agente.token, { body: 'intruso', visibility: 'internal' })).status === 404);
      check('⛔ ni registra tiempo en él → 404', (await req('POST', `${SD}/requests/${idMto}/time`, agente.token, { minutes: 5 })).status === 404);
      check('⛔ el coordinador de TI NO cambia su prioridad → 404', (await req('POST', `${SD}/requests/${idMto}/priority`, coord.token, { priority: 'alta', reason: 'intruso' })).status === 404);
      check('⛔ el coordinador de TI NO lo asigna → 404', (await req('POST', `${SD}/requests/${idMto}/assign`, coord.token, { user_id: tecMto.id })).status === 404);
      check('el técnico de Mantenimiento SÍ lo toma', (await req('POST', `${SD}/requests/${idMto}/take`, tecMto.token)).status < 300);
      const tMto2 = await mk(sol.token, catMto, 'SMOKE 7.6 segundo de Mantenimiento');
      check('⛔ el técnico (sin la clave de coordinar) no asigna a otro → 403', (await req('POST', `${SD}/requests/${tMto2.body?.id}/assign`, tecMto.token, { user_id: coordMto.id })).status === 403);
      check('⭐ la coordinación de Mantenimiento asigna a su técnico', (await req('POST', `${SD}/requests/${tMto2.body?.id}/assign`, coordMto.token, { user_id: tecMto.id })).status < 300);
      const tMto3 = await mk(sol.token, catMto, 'SMOKE 7.6 tercero de Mantenimiento');
      const aTi = await req('POST', `${SD}/requests/${tMto3.body?.id}/assign`, coordMto.token, { user_id: agente.id });
      check('⛔ NO se asigna a alguien que no es de ESA cola (el agente de TI) → 400', aTi.status === 400, dump(aTi));

      // ── la lista de quien se puede asignar ──
      const agTecnico = (await req('GET', `${SD}/agents`, tecMto.token)).body ?? [];
      check('⭐ el técnico de Mantenimiento ve a su coordinación y a sí mismo, y a NADIE de TI', agTecnico.some((a) => a.user_id === coordMto.id) && agTecnico.every((a) => a.user_id !== agente.id && a.user_id !== coord.id), JSON.stringify(agTecnico.map((a) => a.username)));
      const agTi = (await req('GET', `${SD}/agents`, agente.token)).body ?? [];
      check('⭐ el agente de TI no ve a nadie de Mantenimiento', agTi.some((a) => a.user_id === coord.id) && agTi.every((a) => a.user_id !== tecMto.id && a.user_id !== coordMto.id), JSON.stringify(agTi.map((a) => a.username)));
      check('⛔ pedir los agentes de una cola ajena → 404', (await req('GET', `${SD}/agents?queue_id=${qMto}`, agente.token)).status === 404);

      // ── reporte ──
      const hoy = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Mexico_City', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
      const repMto = await req('GET', `${SD}/reports?from=${hoy}&to=${hoy}`, coordMto.token);
      const creadosMto = Number((await knex('servicedesk.requests').where({ queue_id: qMto }).whereNull('deleted_at').count({ n: '*' }).first()).n);
      check('⭐ el reporte de la coordinación de Mantenimiento cuenta SÓLO sus tickets', repMto.status === 200 && repMto.body?.totales?.creados === creadosMto, `${repMto.body?.totales?.creados} vs ${creadosMto}`);
      const repTi = await req('GET', `${SD}/reports?from=${hoy}&to=${hoy}`, coord.token);
      const creadosTi = Number((await knex('servicedesk.requests').where({ queue_id: colaTi.id }).whereNull('deleted_at').where('created_at', '>=', knex.raw(`(?::date)::timestamp AT TIME ZONE 'America/Mexico_City'`, [hoy])).count({ n: '*' }).first()).n);
      check('⭐ el de la coordinación de TI NO suma Mantenimiento', repTi.status === 200 && repTi.body?.totales?.creados === creadosTi, `${repTi.body?.totales?.creados} vs ${creadosTi}`);
      check('⛔ pedir el reporte de una cola que no coordina → 403', (await req('GET', `${SD}/reports?from=${hoy}&to=${hoy}&queue_id=${qMto}`, coord.token)).status === 403);
      check('⛔ el técnico (sin la clave de coordinar) no tiene reporte → 403', (await req('GET', `${SD}/reports`, tecMto.token)).status === 403);

      // ── miembros ──
      const mMto = await req('GET', `${SD}/config/queues/${qMto}/members`, coordMto.token);
      check('⭐ la coordinación ve a los miembros de su cola, con quién es coordinador', mMto.status === 200 && mMto.body?.members?.some((m) => m.user_id === coordMto.id && m.role === 'coordinador') && mMto.body?.members?.some((m) => m.user_id === tecMto.id && m.role === 'tecnico'), dump(mMto));
      check('⛔ quien no atiende esa cola no ve sus miembros → 404', (await req('GET', `${SD}/config/queues/${qMto}/members`, agente.token)).status === 404);
      check('⛔ el COORDINADOR DE TI no se agrega a Mantenimiento → 403', (await req('PUT', `${SD}/config/queues/${qMto}/members/${coord.id}`, coord.token, { role: 'tecnico' })).status === 403);
      check('⛔ el técnico no agrega a nadie → 403', (await req('PUT', `${SD}/config/queues/${qMto}/members/${agente.id}`, tecMto.token, { role: 'tecnico' })).status === 403);
      check('⛔ no se agrega a quien no tiene la clave de atender (el solicitante) → 400', (await req('PUT', `${SD}/config/queues/${qMto}/members/${sol.id}`, coordMto.token, { role: 'tecnico' })).status === 400);
      check('⛔ no se nombra coordinador a quien no tiene la clave de coordinar → 400', (await req('PUT', `${SD}/config/queues/${qMto}/members/${agente.id}`, coordMto.token, { role: 'coordinador' })).status === 400);
      check('⛔ un rol inventado → 400', (await req('PUT', `${SD}/config/queues/${qMto}/members/${agente.id}`, coordMto.token, { role: 'rey' })).status === 400);
      check('⛔ la cola no se queda sin coordinación (la única no se baja a técnico) → 409', (await req('PUT', `${SD}/config/queues/${qMto}/members/${coordMto.id}`, coordMto.token, { role: 'tecnico' })).status === 409);
      check('⛔ ni se quita a la única coordinación → 409', (await req('DELETE', `${SD}/config/queues/${qMto}/members/${coordMto.id}`, coordMto.token)).status === 409);
      check('⛔ no se quita a quien tiene solicitudes abiertas asignadas → 409', (await req('DELETE', `${SD}/config/queues/${qMto}/members/${tecMto.id}`, coordMto.token)).status === 409);
      const aHue = await req('PUT', `${SD}/config/queues/${qMto}/members/${huerfano.id}`, coordMto.token, { role: 'tecnico' });
      check('⭐ la coordinación de la cola agrega a una persona con la clave', aHue.status === 200 && aHue.body?.members?.some((m) => m.user_id === huerfano.id), dump(aHue));
      check('⭐ y esa persona YA ve los tickets de la cola', ids(await filasDe(huerfano.token)).has(idMto));
      const qHue = await req('DELETE', `${SD}/config/queues/${qMto}/members/${huerfano.id}`, coordMto.token);
      check('se le puede quitar (sin solicitudes asignadas)', qHue.status === 200 && !qHue.body?.members?.some((m) => m.user_id === huerfano.id), dump(qHue));
      check('⭐ y deja de verlos', !ids(await filasDe(huerfano.token)).has(idMto));
      check('el god-mode también administra miembros', (await req('PUT', `${SD}/config/queues/${qMto}/members/${huerfano.id}`, dios.token, { role: 'tecnico' })).status === 200);

      // ── `[MS.7.17]` la pantalla de miembros: a quién se puede agregar y quién puede administrar ──
      const cand = await req('GET', `${SD}/config/queues/${qMto}/candidates`, coordMto.token);
      const idsCand = new Set((cand.body ?? []).map((x) => x.user_id));
      check('⭐ los candidatos son quienes tienen la clave y aún NO son miembros (el agente y el coordinador de TI)', cand.status === 200 && idsCand.has(agente.id) && idsCand.has(coord.id), dump(cand));
      check('⛔ y NO aparecen quienes ya son miembros', !idsCand.has(tecMto.id) && !idsCand.has(coordMto.id) && !idsCand.has(huerfano.id));
      check('⛔ ni quien no tiene la clave de atender (el solicitante)', !idsCand.has(sol.id));
      check('cada candidato dice si podría coordinar', (cand.body ?? []).find((x) => x.user_id === coord.id)?.can_coordinate === true && (cand.body ?? []).find((x) => x.user_id === agente.id)?.can_coordinate === false);
      check('⛔ el coordinador de TI NO ve los candidatos de Mantenimiento → 403', (await req('GET', `${SD}/config/queues/${qMto}/candidates`, coord.token)).status === 403);
      check('⛔ el técnico (sin la clave de coordinar) tampoco → 403', (await req('GET', `${SD}/config/queues/${qMto}/candidates`, tecMto.token)).status === 403);
      check('⛔ una cola inexistente → 404', (await req('GET', `${SD}/config/queues/00000000-0000-0000-0000-000000000000/candidates`, dios.token)).status === 404);
      const mgCoord = await req('GET', `${SD}/config/queues/${qMto}/members`, coordMto.token);
      const mgTec = await req('GET', `${SD}/config/queues/${qMto}/members`, tecMto.token);
      check('⭐ la respuesta dice si quien pregunta puede administrar: la coordinación sí…', mgCoord.body?.can_manage === true);
      check('⛔ …el técnico NO (ve con quién trabaja, pero la pantalla no le ofrece los controles)', mgTec.status === 200 && mgTec.body?.can_manage === false);
      check('el god-mode sí', (await req('GET', `${SD}/config/queues/${qMto}/members`, dios.token)).body?.can_manage === true);

      // ── configuración de la cola ──
      check('⛔ la coordinación de TI NO cambia una categoría de Mantenimiento → 403', (await req('PUT', `${SD}/config/categories/${catMto}`, coord.token, { name: 'robada' })).status === 403);
      check('⛔ ni le agrega una → 403', (await req('POST', `${SD}/config/categories`, coord.token, { queue_id: qMto, code: 'smoke_x', name: 'x' })).status === 403);
      check('⛔ ni renombra la cola → 403', (await req('PUT', `${SD}/config/queues/${qMto}`, coord.token, { name: 'robada' })).status === 403);
      check('la coordinación de Mantenimiento SÍ edita su categoría', (await req('PUT', `${SD}/config/categories/${catMto}`, coordMto.token, { name: 'SMOKE Mto categoría' })).status === 200);
      const nueva = await req('POST', `${SD}/config/queues`, coordMto.token, { code: 'smoke_mto76_b', name: 'SMOKE cola creada' });
      const colaB = (nueva.body?.queues ?? []).find((q) => q.code === 'smoke_mto76_b');
      const mB = colaB ? await req('GET', `${SD}/config/queues/${colaB.id}/members`, coordMto.token) : null;
      check('⭐ quien crea una cola queda como su coordinador (si no, crearía algo que ya no ve)', !!colaB && mB?.status === 200 && mB.body?.members?.some((m) => m.user_id === coordMto.id && m.role === 'coordinador'), dump(nueva));

      // ── ruteo: una regla de palabra clave de TI no dispara sobre Mantenimiento ──
      const regla = await req('POST', `${SD}/config/routing`, coord.token, { name: `SMOKE 7.6 ${SUF}`, keywords: [palabra], assignee_id: agente.id });
      check('la regla de palabra clave se crea', regla.status === 200 || regla.status === 201, dump(regla));
      const rTi = await mk(sol.token, catSimple.id, `SMOKE 7.6 ${palabra} en TI`);
      const rMto = await mk(sol.token, catMto, `SMOKE 7.6 ${palabra} en Mantenimiento`);
      check('⭐ en TI la regla sigue asignando (nada cambia para TI)', rTi.body?.assigned_to === agente.id, JSON.stringify([rTi.body?.assigned_to, rTi.body?.status]));
      check('⭐ en Mantenimiento NO dispara (su destino no es de esa cola): queda sin asignar', !rMto.body?.assigned_to && rMto.body?.status === 'nuevo', JSON.stringify([rMto.body?.assigned_to, rMto.body?.status]));

      // ── avisos por cola ──
      const urgMto = await mk(sol.token, catMto, 'SMOKE 7.6 urgente de Mantenimiento', { impact: 'red', blocks_work: true });
      const dest = new Set((await knex('servicedesk.notification_log').where({ request_id: urgMto.body?.id }).pluck('recipient_id')));
      if (dest.size) {
        check('⭐ el aviso de «nuevo prioritario» llega a la cola de Mantenimiento', dest.has(tecMto.id) || dest.has(coordMto.id), JSON.stringify([...dest]));
        check('⛔ y NO despierta a TI', !dest.has(agente.id) && !dest.has(coord.id), JSON.stringify([...dest]));
      } else {
        noMedido.push('avisos por cola: el aviso «nuevo prioritario» no dejó filas en notification_log (canal apagado en este entorno)');
      }
    }

    // ── 23. [MS.7.18] «Mi trabajo»: lo sin asignar es de TUS colas ───────────────────────────────────
    {
      console.log('\n23 — Mi trabajo › lo sin asignar se cuenta sólo en las colas de cada persona');
      const BAND = 'servicio-sin-asignar';
      const colaTi = await knex('servicedesk.queues').where({ tenant_id: T, code: 'ti' }).first('id');
      const [{ id: qCnt }] = await knex('servicedesk.queues').insert({ tenant_id: T, code: 'smoke_mw718', name: 'SMOKE Mi trabajo', sort_order: 901 }).returning('id');
      const [{ id: catCnt }] = await knex('servicedesk.categories').insert({ tenant_id: T, queue_id: qCnt, code: 'smoke_mw718_cat', name: 'SMOKE MW cat', default_priority: 'media', requires_branch: false }).returning('id');
      const reparte = await crearUsuario('mw_reparte', ['SERVICIO_ATENDER', 'SERVICIO_COORDINAR'], [{ queue_id: qCnt, role: 'coordinador' }]);
      const sinCola = await crearUsuario('mw_sincola', ['SERVICIO_ATENDER', 'SERVICIO_COORDINAR'], []);
      usuarios.push(reparte, sinCola);
      for (const u of [reparte, sinCola]) {
        await knex('identity.user_responsibilities').insert({ tenant_id: T, user_id: u.id, responsibility_key: 'servicio.atender', accion: 'suma', nota: 'smoke http-service-desk-test' });
      }
      // Dos sin asignar en la cola nueva, uno más en TI.
      await req('POST', `${SD}/requests`, sol.token, { category_id: catCnt, title: 'SMOKE 7.18 sin asignar A' });
      await req('POST', `${SD}/requests`, sol.token, { category_id: catCnt, title: 'SMOKE 7.18 sin asignar B' });
      await req('POST', `${SD}/requests`, sol.token, { category_id: catSimple.id, title: 'SMOKE 7.18 sin asignar en TI' });
      const sinAsignarDe = async (queueIds) => Number((await knex('servicedesk.requests').where({ tenant_id: T, status: 'nuevo' }).whereNull('assigned_to').whereNull('deleted_at').whereIn('queue_id', queueIds).count({ n: '*' }).first()).n);
      const pend = (r) => (r.body?.pendientes ?? []).find((p) => p.id === BAND);
      const wR = await req('GET', '/users/me/work', reparte.token);
      check('⭐ quien reparte la cola nueva ve sus 2 sin asignar, y NO los de TI', pend(wR)?.total === (await sinAsignarDe([qCnt])) && pend(wR)?.total === 2, JSON.stringify([pend(wR)?.total, await sinAsignarDe([qCnt])]));
      const wC = await req('GET', '/users/me/work', coord.token);
      const totalTi = await sinAsignarDe([colaTi.id]);
      check('⭐ y quien reparte TI cuenta SÓLO los de TI (no suma la cola nueva)', pend(wC)?.total === totalTi, JSON.stringify([pend(wC)?.total, totalTi]));
      const wS = await req('GET', '/users/me/work', sinCola.token);
      check('⛔ NEGATIVA — quien responde de repartir pero NO pertenece a ninguna cola no ve «0 por asignar»', !pend(wS), JSON.stringify(pend(wS)));
      const noMed = (wS.body?.no_medido ?? []).find((n) => n.id === BAND);
      check('⭐ …se DECLARA que no se pudo medir, con el motivo (no se dibuja un cero que se lea «estás al día»)', !!noMed && /ninguna cola/i.test(noMed.motivo ?? ''), JSON.stringify(wS.body?.no_medido));
      // Agregarlo a una cola lo arregla en la SIGUIENTE lectura.
      await knex('servicedesk.queue_members').insert({ tenant_id: T, queue_id: qCnt, user_id: sinCola.id, role: 'tecnico' });
      const wS2 = await req('GET', '/users/me/work', sinCola.token);
      check('al agregarlo a la cola, la siguiente lectura ya cuenta lo suyo', pend(wS2)?.total === 2, JSON.stringify(pend(wS2)?.total));

      // El reporte dice de qué colas puede ser, para el selector.
      const hoy = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Mexico_City', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
      const repR = await req('GET', `${SD}/reports?from=${hoy}&to=${hoy}`, reparte.token);
      check('⭐ el reporte declara las colas de las que puede ser (sólo las que coordina) y que no se acotó', repR.status === 200 && repR.body?.colas?.length === 1 && repR.body.colas[0].id === qCnt && repR.body.cola_id === null, JSON.stringify([repR.body?.colas, repR.body?.cola_id]));
      const repR2 = await req('GET', `${SD}/reports?from=${hoy}&to=${hoy}&queue_id=${qCnt}`, reparte.token);
      check('y al acotar por queue_id lo repite en cola_id', repR2.status === 200 && repR2.body?.cola_id === qCnt);
    }

    // ── 24. [MS.7.14] Mantenimiento: sembrada APAGADA, y se enciende desde la pantalla ───────────────
    {
      console.log('\n24 — Mantenimiento sembrada: apagada y sin miembros hasta que su coordinación la enciende');
      const mto = await knex('servicedesk.queues').where({ tenant_id: T, code: 'mantenimiento' }).first('id', 'active');
      if (!mto) {
        noMedido.push('siembra de Mantenimiento (MS.7.14): la cola no está sembrada en este destino; se omiten sus comprobaciones');
      } else {
        mtoActivaAntes = mto.active;
        await knex('servicedesk.queues').where({ id: mto.id }).update({ active: false }); // punto de partida conocido
        const catPlomeria = await knex('servicedesk.categories').where({ queue_id: mto.id, code: 'plomeria' }).first('id');
        const dios2 = await crearUsuario('dios2');
        await knex('identity.users').where({ id: dios2.id }).update({ role_name: 'superadmin' });
        dios2.token = (await req('POST', '/auth-mt/login', null, { tenant_slug: 'mega_dulces', username: dios2.username, password: PASS_PLANO })).body?.access_token ?? null;
        const jefe = await crearUsuario('mto_jefe', ['SERVICIO_ATENDER', 'SERVICIO_COORDINAR'], []);
        usuarios.push(dios2, jefe);

        const idsDe = async (token) => new Set(((await req('GET', `${SD}/requests/inbox?scope=all&limit=200`, token)).body?.rows ?? []).map((r) => r.id));
        const cat0 = (await req('GET', `${SD}/catalog`, sol.token)).body;
        check('⭐ APAGADA: el catálogo NO ofrece la cola ni sus categorías (un ticket ahí nacería en una bandeja que nadie ve)', !(cat0?.queues ?? []).some((q) => q.id === mto.id) && !(cat0?.categories ?? []).some((k) => k.queue_id === mto.id), JSON.stringify((cat0?.queues ?? []).map((q) => q.name)));
        const intento = await req('POST', `${SD}/requests`, sol.token, { category_id: catPlomeria.id, title: 'SMOKE 7.14 con la cola apagada', warehouse_code: 'EC' });
        check('⛔ y levantar un ticket en una categoría suya → 400 (no queda un ticket huérfano)', intento.status === 400, dump(intento));
        const cfgDios = await req('GET', `${SD}/config`, dios2.token);
        check('el god-mode SÍ la ve en la configuración (apagada) para poder encenderla', (cfgDios.body?.queues ?? []).some((q) => q.id === mto.id && q.active === false));
        check('⛔ quien tiene las claves pero NO es de la cola no puede encenderla → 403', (await req('PUT', `${SD}/config/queues/${mto.id}`, jefe.token, { active: true })).status === 403);

        // El camino real: un administrador nombra a la coordinación; ella enciende la cola.
        const nombra = await req('PUT', `${SD}/config/queues/${mto.id}/members/${jefe.id}`, dios2.token, { role: 'coordinador' });
        check('⭐ 1) un administrador nombra a quien coordina la cola', nombra.status === 200 && nombra.body?.members?.some((m) => m.user_id === jefe.id && m.role === 'coordinador'), dump(nombra));
        const enciende = await req('PUT', `${SD}/config/queues/${mto.id}`, jefe.token, { active: true });
        check('⭐ 2) ESA coordinación enciende la cola (no hizo falta código ni migración)', enciende.status === 200 && (enciende.body?.queues ?? []).some((q) => q.id === mto.id && q.active === true), dump(enciende));
        const cat1 = (await req('GET', `${SD}/catalog`, sol.token)).body;
        const susCats = (cat1?.categories ?? []).filter((k) => k.queue_id === mto.id);
        check('⭐ encendida, el catálogo ofrece sus 11 categorías', susCats.length === 11, String(susCats.length));
        check('y todas exigen ubicación', susCats.every((k) => k.requires_branch === true));
        // `[MS.7.7]` Mantenimiento usa riesgo × operación: el alta lleva SIEMPRE la respuesta de riesgo (si no, el 400 sería por eso y no por la ubicación).
        const sinUbic = await req('POST', `${SD}/requests`, sol.token, { category_id: catPlomeria.id, title: 'SMOKE 7.14 sin ubicación', safety_risk: false });
        check('⛔ sin ubicación → 400 (una falla de mantenimiento es EN un sitio)', sinUbic.status === 400, dump(sinUbic));
        const sinRiesgo = await req('POST', `${SD}/requests`, sol.token, { category_id: catPlomeria.id, title: 'SMOKE 7.14 sin contestar el riesgo', warehouse_code: 'EC' });
        check('⭐ `[MS.7.7]` Mantenimiento ya sugiere la prioridad por riesgo × operación: SIN contestar el riesgo → 400', sinRiesgo.status === 400, dump(sinRiesgo));
        const tEc = await req('POST', `${SD}/requests`, sol.token, { category_id: catPlomeria.id, title: 'SMOKE 7.14 fuga en el estacionamiento', warehouse_code: 'EC', safety_risk: false, blocks_work: false });
        check('⭐ «Estacionamiento CEDIS» (EC) es una ubicación válida y se nombra bien', tEc.status === 201 && tEc.body?.warehouse_name === 'Estacionamiento CEDIS', dump(tEc));
        const bJefe = await idsDe(jefe.token);
        check('⭐ la coordinación de Mantenimiento ve el ticket en SU bandeja', bJefe.has(tEc.body?.id));
        const bTi = await idsDe(agente.token);
        check('⛔ y la gente de TI NO lo ve (el aislamiento por cola ya lo garantiza)', !bTi.has(tEc.body?.id));
        check('el ticket cae SIN asignar (no hay regla ni responsable por omisión: lo reparte la coordinación)', tEc.body?.status === 'nuevo' && !tEc.body?.assigned_to, JSON.stringify([tEc.body?.status, tEc.body?.assigned_to]));
      }
    }

    // ── 25. [MS.7.2] SLA por cola: la política de la cola manda, y lo no cambiado se hereda ──────────
    {
      console.log('\n25 — SLA por cola: plazos propios, herencia de la general, y quién puede cambiarlos');
      const [{ id: qSla }] = await knex('servicedesk.queues').insert({ tenant_id: T, code: 'smoke_sla72', name: 'SMOKE SLA por cola', sort_order: 902 }).returning('id');
      const [{ id: catSla }] = await knex('servicedesk.categories').insert({ tenant_id: T, queue_id: qSla, code: 'smoke_sla72_cat', name: 'SMOKE SLA cat', default_priority: 'media', requires_branch: false }).returning('id');
      const jefeSla = await crearUsuario('sla_jefe', ['SERVICIO_ATENDER', 'SERVICIO_COORDINAR'], [{ queue_id: qSla, role: 'coordinador' }]);
      const tecSla = await crearUsuario('sla_tec', ['SERVICIO_ATENDER'], [{ queue_id: qSla, role: 'tecnico' }]);
      const diosSla = await crearUsuario('sla_dios');
      await knex('identity.users').where({ id: diosSla.id }).update({ role_name: 'superadmin' });
      diosSla.token = (await req('POST', '/auth-mt/login', null, { tenant_slug: 'mega_dulces', username: diosSla.username, password: PASS_PLANO })).body?.access_token ?? null;
      usuarios.push(jefeSla, tecSla, diosSla);

      const pol = (qs = '') => knex('servicedesk.sla_policies').where({ tenant_id: T }).modify((qb) => (qs ? qb.where({ queue_id: qs }) : qb.whereNull('queue_id')));
      const minutosDe = async (id) => {
        const r = await knex('servicedesk.requests').where({ id }).first('created_at', 'due_at', 'first_response_due_at');
        return { resolucion: (new Date(r.due_at) - new Date(r.created_at)) / 60000, primera: (new Date(r.first_response_due_at) - new Date(r.created_at)) / 60000 };
      };
      const cerca = (a, b) => Math.abs(a - b) < 0.5;
      const generalMedia = await pol().where({ priority: 'media' }).first('clock', 'first_response_minutes', 'resolution_minutes');

      // Sin plazo propio: hereda la general (nada cambia para una cola nueva).
      const t0 = await req('POST', `${SD}/requests`, sol.token, { category_id: catSla, title: 'SMOKE 7.2 hereda la general' });
      check('una cola nueva SIN plazos propios no tiene ninguna fila de SLA (hereda sin sembrar nada)', (await pol(qSla)).length === 0);
      const m0 = await minutosDe(t0.body?.id);
      if (generalMedia.clock === 'calendar') check('⭐ …y su ticket se mide con los minutos de la general', cerca(m0.resolucion, generalMedia.resolution_minutes), JSON.stringify([m0, generalMedia]));
      else noMedido.push('SLA por cola: la general «media» corre en horario hábil en este destino; la aritmética exacta se comprueba con un reloj corrido (se fija en la prueba siguiente)');

      // Permisos.
      const cfg = (token) => req('PUT', `${SD}/config/policies/media?queue_id=${qSla}`, token, { first_response_minutes: 10, resolution_minutes: 100, clock: 'calendar' });
      check('⛔ el coordinador de TI NO cambia los plazos de otra cola → 403', (await cfg(coord.token)).status === 403);
      check('⛔ el técnico (sin la clave de coordinar) tampoco → 403', (await cfg(tecSla.token)).status === 403);
      check('⛔ un queue_id inválido → 400', (await req('PUT', `${SD}/config/policies/media?queue_id=no-es-uuid`, diosSla.token, { resolution_minutes: 100 })).status === 400);
      check('⛔ una cola inexistente → 404', (await req('PUT', `${SD}/config/policies/media?queue_id=00000000-0000-0000-0000-000000000000`, diosSla.token, { resolution_minutes: 100 })).status === 404);
      check('⛔ primera respuesta mayor que la resolución → 400', (await req('PUT', `${SD}/config/policies/media?queue_id=${qSla}`, jefeSla.token, { first_response_minutes: 500, resolution_minutes: 100 })).status === 400);
      check('⛔ y no se crea nada con la petición rechazada', (await pol(qSla)).length === 0);

      // Su coordinación fija plazos propios (reloj corrido: aritmética exacta).
      const ok1 = await cfg(jefeSla.token);
      check('⭐ la coordinación de la cola fija sus plazos', ok1.status === 200, dump(ok1));
      const propia = await pol(qSla);
      check('⭐ nace UNA fila propia (copia de la general con el cambio) y la general NO se toca', propia.length === 1 && propia[0].priority === 'media' && propia[0].resolution_minutes === 100, JSON.stringify(propia));
      const generalDespues = await pol().where({ priority: 'media' }).first('first_response_minutes', 'resolution_minutes', 'clock');
      check('la política general de «media» sigue igual', generalDespues.resolution_minutes === generalMedia.resolution_minutes && generalDespues.clock === generalMedia.clock);
      const cfgVista = await req('GET', `${SD}/config`, jefeSla.token);
      check('la configuración declara de qué cola es cada plazo (queue_id) y conserva las generales con null', (cfgVista.body?.policies ?? []).some((p) => p.queue_id === qSla && p.priority === 'media') && (cfgVista.body?.policies ?? []).filter((p) => p.queue_id === null).length === 4, JSON.stringify((cfgVista.body?.policies ?? []).map((p) => [p.queue_id, p.priority])));

      const t1 = await req('POST', `${SD}/requests`, sol.token, { category_id: catSla, title: 'SMOKE 7.2 con plazo propio' });
      const m1 = await minutosDe(t1.body?.id);
      check('⭐ el ticket NUEVO se mide con el plazo de SU cola (100 min), no con el general', cerca(m1.resolucion, 100) && cerca(m1.primera, 10), JSON.stringify(m1));
      const tTi = await req('POST', `${SD}/requests`, sol.token, { category_id: catSimple.id, title: 'SMOKE 7.2 TI no cambia' });
      const mTi = await minutosDe(tTi.body?.id);
      const generalTi = await pol().where({ priority: 'media' }).first('clock', 'resolution_minutes');
      if (generalTi.clock === 'calendar') check('⭐ y un ticket de TI sigue midiéndose con la general (el cambio de una cola no se filtra a otra)', cerca(mTi.resolucion, generalTi.resolution_minutes), JSON.stringify([mTi, generalTi]));
      else check('un ticket de TI NO se mide con los 100 min de la otra cola', !cerca(mTi.resolucion, 100), JSON.stringify(mTi));

      // Cambiar plazos otra vez edita, no duplica.
      await req('PUT', `${SD}/config/policies/media?queue_id=${qSla}`, jefeSla.token, { resolution_minutes: 120 });
      const trasEditar = await pol(qSla);
      check('⭐ cambiar otra vez EDITA la fila (no la duplica)', trasEditar.length === 1 && trasEditar[0].resolution_minutes === 120, JSON.stringify(trasEditar));

      // Herencia parcial: sólo se cambió «media»; «baja» sigue siendo la general.
      const cambiaPrio = await req('POST', `${SD}/requests/${t1.body?.id}/priority`, jefeSla.token, { priority: 'baja', reason: 'SMOKE 7.2' });
      const generalBaja = await pol().where({ priority: 'baja' }).first('clock', 'resolution_minutes');
      check('el cambio de prioridad se acepta', cambiaPrio.status < 300, dump(cambiaPrio));
      const mB = await minutosDe(t1.body?.id);
      if (generalBaja.clock === 'calendar') check('⭐ HERENCIA PARCIAL: «baja» (que la cola no cambió) se mide con la general', cerca(mB.resolucion, generalBaja.resolution_minutes), JSON.stringify([mB, generalBaja]));
      else check('⭐ HERENCIA PARCIAL: «baja» ya no se mide con el plazo propio de «media»', !cerca(mB.resolucion, 120), JSON.stringify(mB));

      // Volver a heredar.
      check('⛔ el coordinador de TI NO borra el plazo propio de otra cola → 403', (await req('DELETE', `${SD}/config/policies/media?queue_id=${qSla}`, coord.token)).status === 403);
      check('⛔ sin queue_id no hay qué borrar → 400', (await req('DELETE', `${SD}/config/policies/media`, jefeSla.token)).status === 400);
      const quita = await req('DELETE', `${SD}/config/policies/media?queue_id=${qSla}`, jefeSla.token);
      check('⭐ la coordinación vuelve a heredar la general (se borra su plazo propio)', quita.status === 200 && (await pol(qSla)).length === 0, dump(quita));
      check('⛔ borrar lo que ya no existe → 404', (await req('DELETE', `${SD}/config/policies/media?queue_id=${qSla}`, jefeSla.token)).status === 404);
      const t2 = await req('POST', `${SD}/requests`, sol.token, { category_id: catSla, title: 'SMOKE 7.2 vuelve a la general' });
      const m2 = await minutosDe(t2.body?.id);
      if (generalMedia.clock === 'calendar') check('⭐ el ticket nuevo vuelve a medirse con la general', cerca(m2.resolucion, generalMedia.resolution_minutes), JSON.stringify([m2, generalMedia]));
      else check('el ticket nuevo ya no se mide con el plazo propio', !cerca(m2.resolucion, 120), JSON.stringify(m2));

      // La política general sigue editable como siempre (y sin queue_id no se crea nada por cola).
      const filasAntes = (await knex('servicedesk.sla_policies').where({ tenant_id: T }).whereNotNull('queue_id')).length;
      check('la política general se sigue editando sin queue_id (compatibilidad)', (await req('PUT', `${SD}/config/policies/media`, coord.token, { first_response_minutes: generalMedia.first_response_minutes })).status === 200);
      check('…y no crea filas por cola', (await knex('servicedesk.sla_policies').where({ tenant_id: T }).whereNotNull('queue_id')).length === filasAntes);
    }

    // ── 26. [MS.7.7] Prioridad por modelo de cola: riesgo × operación (Mantenimiento) vs impacto (TI) ───
    {
      console.log('\n26 — la prioridad se sugiere según el MODELO de la cola (por valor, no por nombre)');
      const [{ id: qR }] = await knex('servicedesk.queues').insert({ tenant_id: T, code: 'smoke_rsk77', name: 'SMOKE Riesgo', sort_order: 903 }).returning('id');
      const [{ id: catR }] = await knex('servicedesk.categories').insert({ tenant_id: T, queue_id: qR, code: 'smoke_rsk77_cat', name: 'SMOKE R media', default_priority: 'media', requires_branch: false }).returning('id');
      const [{ id: catRAlta }] = await knex('servicedesk.categories').insert({ tenant_id: T, queue_id: qR, code: 'smoke_rsk77_alta', name: 'SMOKE R alta', default_priority: 'alta', requires_branch: false }).returning('id');
      const jefeR = await crearUsuario('rsk_jefe', ['SERVICIO_ATENDER', 'SERVICIO_COORDINAR'], [{ queue_id: qR, role: 'coordinador' }]);
      usuarios.push(jefeR);
      const mk = (cat, extra = {}) => req('POST', `${SD}/requests`, sol.token, { category_id: cat, title: 'SMOKE 7.7 ' + Math.random().toString(36).slice(2, 7), ...extra });
      const cambiaModelo = (token, valor) => req('PUT', `${SD}/config/queues/${qR}`, token, { priority_model: valor });

      // La cola nace con el modelo de siempre: nada cambia para quien no lo toque.
      const antes = await mk(catR, { impact: 'red', blocks_work: true });
      check('⭐ una cola NUEVA nace en el modelo de IMPACTO (como TI): bloquea + red → urgente', antes.status === 201 && antes.body?.priority === 'urgente', dump(antes));
      check('⭐ y en ese modelo `safety_risk` queda NULL («no se preguntó»), no un false inventado', antes.body?.safety_risk === null, JSON.stringify(antes.body?.safety_risk));
      const conRiesgoEnImpacto = await mk(catR, { impact: 'yo', blocks_work: false, safety_risk: true });
      check('⛔ en el modelo de impacto el riesgo se IGNORA (no sube la prioridad de TI) y no se guarda', conRiesgoEnImpacto.status === 201 && conRiesgoEnImpacto.body?.priority !== 'alta' && conRiesgoEnImpacto.body?.safety_risk === null, dump(conRiesgoEnImpacto));
      const catalogo = (await req('GET', `${SD}/catalog`, sol.token)).body;
      check('el catálogo declara el modelo de cada cola (para que el formulario sepa qué preguntar)', (catalogo?.queues ?? []).every((q) => ['impacto', 'riesgo_operacion'].includes(q.priority_model)) && (catalogo?.queues ?? []).find((q) => q.id === qR)?.priority_model === 'impacto', JSON.stringify((catalogo?.queues ?? []).map((q) => [q.code, q.priority_model])));

      // Quién puede cambiar el modelo.
      check('⛔ el coordinador de TI NO cambia el modelo de OTRA cola → 403', (await cambiaModelo(coord.token, 'riesgo_operacion')).status === 403);
      check('⛔ un modelo inventado → 400', (await cambiaModelo(jefeR.token, 'por_tamano')).status === 400);
      check('⛔ y no cambió nada con las peticiones rechazadas', (await knex('servicedesk.queues').where({ id: qR }).first('priority_model')).priority_model === 'impacto');
      const ok = await cambiaModelo(jefeR.token, 'riesgo_operacion');
      check('⭐ la coordinación DE LA COLA cambia su modelo', ok.status === 200 && (ok.body?.queues ?? []).find((q) => q.id === qR)?.priority_model === 'riesgo_operacion', dump(ok));

      // La matriz de riesgo × operación.
      const caso = async (riesgo, detiene, esperada, cat = catR) => {
        const r = await mk(cat, { safety_risk: riesgo, blocks_work: detiene, impact: 'yo' });
        check(`riesgo ${riesgo ? 'SÍ' : 'no'} × detiene ${detiene ? 'SÍ' : 'no'} → ${esperada}`, r.status === 201 && r.body?.priority === esperada && r.body?.priority_suggested === esperada, dump(r));
        return r;
      };
      const rUrg = await caso(true, true, 'urgente');
      await caso(true, false, 'alta');
      await caso(false, true, 'alta');
      const rMed = await caso(false, false, 'media');
      check('⭐ el riesgo se GUARDA y la ficha lo devuelve (para mostrarlo)', rUrg.body?.safety_risk === true && rMed.body?.safety_risk === false && rUrg.body?.blocks_work === true, JSON.stringify([rUrg.body?.safety_risk, rMed.body?.safety_risk]));
      const rImp = await mk(catR, { safety_risk: false, blocks_work: false, impact: 'red' });
      check('⭐ el IMPACTO ya no cuenta en esta cola (aunque llegue «red», sin riesgo ni paro es media)', rImp.status === 201 && rImp.body?.priority === 'media', dump(rImp));
      const piso = await mk(catRAlta, { safety_risk: false, blocks_work: false });
      check('la categoría pone su PISO también aquí (una categoría «alta» no baja a media)', piso.status === 201 && piso.body?.priority === 'alta', dump(piso));

      // El riesgo es obligatorio: nunca se adivina «no hay riesgo».
      const sin = await mk(catR, { blocks_work: true });
      check('⛔ SIN contestar el riesgo → 400 (el peligro no se infiere por omisión)', sin.status === 400, dump(sin));
      check('⛔ riesgo que no es verdadero/falso («no») → 400', (await mk(catR, { safety_risk: 'no', blocks_work: false })).status === 400);
      check('⛔ riesgo nulo → 400', (await mk(catR, { safety_risk: null })).status === 400);
      const huerfanos = await knex('servicedesk.requests').where({ queue_id: qR }).whereRaw(`title like 'SMOKE 7.7%'`).count({ n: '*' }).first();
      check('y las peticiones rechazadas no dejaron tickets a medias', Number(huerfanos.n) === 8, String(huerfanos.n)); // 8 creados: antes, riesgo-ignorado, 4 de la matriz, impacto-sin-peso y piso; los 3 rechazados no dejaron nada

      // El cambio de prioridad lo sigue haciendo sólo quien atiende (la persona NO la baja).
      check('⛔ quien reportó NO baja la prioridad de su propio ticket → 403', (await req('POST', `${SD}/requests/${rUrg.body?.id}/priority`, sol.token, { priority: 'baja', reason: 'yo' })).status === 403);
      check('la coordinación de la cola SÍ la cambia', (await req('POST', `${SD}/requests/${rUrg.body?.id}/priority`, jefeR.token, { priority: 'alta', reason: 'revisado' })).status < 300);

      // Volver al modelo de impacto devuelve el comportamiento de siempre.
      await cambiaModelo(jefeR.token, 'impacto');
      const vuelta = await mk(catR, { impact: 'red', blocks_work: true });
      check('⭐ al volver a «impacto» la cola se comporta como TI otra vez', vuelta.status === 201 && vuelta.body?.priority === 'urgente' && vuelta.body?.safety_risk === null, dump(vuelta));

      // TI no cambió.
      const ti = await req('POST', `${SD}/requests`, sol.token, { category_id: catSimple.id, title: 'SMOKE 7.7 TI', impact: 'yo', blocks_work: false });
      check('⭐ TI sigue en impacto: no se le pide el riesgo y su ticket queda con safety_risk NULL', ti.status === 201 && ti.body?.safety_risk === null, dump(ti));
    }

    // ── 27. [MS.7.3] Zonas: el lugar DENTRO de la ubicación (sólo la pregunta la cola que lo declara) ─────
    {
      console.log('\n27 — zonas: catálogo editable, ticket con zona opcional, y sólo en la cola que la pregunta');
      const [{ id: qZ }] = await knex('servicedesk.queues').insert({ tenant_id: T, code: 'smoke_zn73', name: 'SMOKE Zonas', sort_order: 904 }).returning('id');
      const [{ id: catZ }] = await knex('servicedesk.categories').insert({ tenant_id: T, queue_id: qZ, code: 'smoke_zn73_cat', name: 'SMOKE Z', default_priority: 'media', requires_branch: false }).returning('id');
      const jefeZ = await crearUsuario('zn_jefe', ['SERVICIO_ATENDER', 'SERVICIO_COORDINAR'], [{ queue_id: qZ, role: 'coordinador' }]);
      const sinCola = await crearUsuario('zn_sincola', ['SERVICIO_ATENDER', 'SERVICIO_COORDINAR'], []);
      usuarios.push(jefeZ, sinCola);
      const mk = (cat, extra = {}) => req('POST', `${SD}/requests`, sol.token, { category_id: cat, title: 'SMOKE 7.3 ' + Math.random().toString(36).slice(2, 7), ...extra });
      const pregunta = (token, v) => req('PUT', `${SD}/config/queues/${qZ}`, token, { asks_zone: v });

      // El catálogo trae las zonas y declara qué colas la preguntan.
      const c0 = (await req('GET', `${SD}/catalog`, sol.token)).body;
      check('⭐ el catálogo trae las 5 zonas sembradas, activas y ordenadas', ['bodega', 'anden', 'oficina', 'banos', 'exterior'].every((z) => (c0?.zones ?? []).some((k) => k.code === z)), JSON.stringify((c0?.zones ?? []).map((k) => k.code)));
      check('y cada cola declara `asks_zone` (por valor); TI NO la pregunta', (c0?.queues ?? []).every((q) => typeof q.asks_zone === 'boolean') && (c0?.queues ?? []).filter((q) => q.code === 'ti').every((q) => q.asks_zone === false), JSON.stringify((c0?.queues ?? []).map((q) => [q.code, q.asks_zone])));

      // Una cola que NO la pregunta IGNORA la zona (no se guarda).
      const ignorada = await mk(catZ, { zone_code: 'bodega' });
      check('⛔ en una cola que NO pregunta la zona, la zona se IGNORA (queda sin zona)', ignorada.status === 201 && ignorada.body?.zone_code === null && ignorada.body?.zone_name === null, dump(ignorada));

      // Quién enciende la pregunta.
      check('⛔ quien coordina OTRA cola no cambia lo que ésta pregunta → 403', (await pregunta(coord.token, true)).status === 403);
      check('⛔ asks_zone que no es verdadero/falso → 400', (await req('PUT', `${SD}/config/queues/${qZ}`, jefeZ.token, { asks_zone: 'si' })).status === 400);
      const enciende = await pregunta(jefeZ.token, true);
      check('⭐ la coordinación DE LA COLA enciende la pregunta', enciende.status === 200 && (enciende.body?.queues ?? []).find((q) => q.id === qZ)?.asks_zone === true, dump(enciende));

      // Con la pregunta encendida.
      const conZona = await mk(catZ, { zone_code: 'anden' });
      check('⭐ con la pregunta encendida la zona se GUARDA y la ficha trae su nombre', conZona.status === 201 && conZona.body?.zone_code === 'anden' && conZona.body?.zone_name === 'Andén', dump(conZona));
      const detalle = await req('GET', `${SD}/requests/${conZona.body?.id}`, sol.token);
      check('y el detalle (para quien reportó) también la muestra', detalle.status === 200 && detalle.body?.zone_name === 'Andén', dump(detalle));
      const sinZona = await mk(catZ);
      check('la zona es OPCIONAL: sin ella el ticket se levanta igual', sinZona.status === 201 && sinZona.body?.zone_code === null, dump(sinZona));
      const vacia = await mk(catZ, { zone_code: '  ' });
      check('una zona en blanco se trata como «sin zona» (no como error)', vacia.status === 201 && vacia.body?.zone_code === null, dump(vacia));
      const falsa = await mk(catZ, { zone_code: 'sotano_secreto' });
      check('⛔ una zona que no existe → 400 (no hay zonas inventadas)', falsa.status === 400, dump(falsa));

      // Administrar el catálogo.
      const alta = (token, dto) => req('POST', `${SD}/config/zones`, token, dto);
      check('⛔ quien reportó (sin permisos) NO da de alta zonas → 403', (await alta(sol.token, { code: 'smoke_a', name: 'A' })).status === 403);
      check('⛔ quien tiene las claves pero no coordina NINGUNA cola → 403', (await alta(sinCola.token, { code: 'smoke_a', name: 'A' })).status === 403);
      check('⛔ un código mal formado → 400', (await alta(jefeZ.token, { code: 'Con Espacios', name: 'A' })).status === 400);
      check('⛔ sin nombre → 400', (await alta(jefeZ.token, { code: 'smoke_a', name: '  ' })).status === 400);
      const nueva = await alta(jefeZ.token, { code: 'smoke_patio', name: 'Patio de maniobras' });
      check('⭐ quien coordina una cola da de alta una zona (aparece en la configuración)', nueva.status < 300 && (nueva.body?.zones ?? []).some((z) => z.code === 'smoke_patio' && z.active === true), dump(nueva));
      check('⛔ el código no se repite', [400, 409].includes((await alta(jefeZ.token, { code: 'smoke_patio', name: 'Otra' })).status));
      const zid = (nueva.body?.zones ?? []).find((z) => z.code === 'smoke_patio')?.id;
      check('⛔ el código de una zona NO se cambia → 400', (await req('PUT', `${SD}/config/zones/${zid}`, jefeZ.token, { code: 'otro_codigo' })).status === 400);
      const renombra = await req('PUT', `${SD}/config/zones/${zid}`, jefeZ.token, { name: 'Patio' });
      check('se renombra', renombra.status === 200 && (renombra.body?.zones ?? []).some((z) => z.id === zid && z.name === 'Patio'), dump(renombra));
      const usaPatio = await mk(catZ, { zone_code: 'smoke_patio' });
      check('⭐ la zona nueva ya se puede elegir al reportar', usaPatio.status === 201 && usaPatio.body?.zone_name === 'Patio', dump(usaPatio));
      const apaga = await req('PUT', `${SD}/config/zones/${zid}`, jefeZ.token, { active: false });
      check('apagar no borra: sigue en la configuración, apagada', apaga.status === 200 && (apaga.body?.zones ?? []).some((z) => z.id === zid && z.active === false), dump(apaga));
      const c1 = (await req('GET', `${SD}/catalog`, sol.token)).body;
      check('⭐ apagada, el catálogo ya no la ofrece', !(c1?.zones ?? []).some((z) => z.code === 'smoke_patio'));
      check('⛔ y elegirla a mano → 400', (await mk(catZ, { zone_code: 'smoke_patio' })).status === 400);
      const vieja = await req('GET', `${SD}/requests/${usaPatio.body?.id}`, sol.token);
      check('⭐ pero el ticket viejo CONSERVA su zona apagada (el historial no se reescribe)', vieja.status === 200 && vieja.body?.zone_name === 'Patio', dump(vieja));
      check('⛔ una zona inexistente al editar → 404', (await req('PUT', `${SD}/config/zones/00000000-0000-0000-0000-0000000000ee`, jefeZ.token, { active: true })).status === 404);

      // Apagar la pregunta: la zona deja de viajar de nuevo.
      await pregunta(jefeZ.token, false);
      const otraVez = await mk(catZ, { zone_code: 'bodega' });
      check('⛔ al apagar la pregunta la zona vuelve a ignorarse', otraVez.status === 201 && otraVez.body?.zone_code === null, dump(otraVez));

      // TI no cambió.
      const ti = await req('POST', `${SD}/requests`, sol.token, { category_id: catSimple.id, title: 'SMOKE 7.3 TI', impact: 'yo', blocks_work: false, zone_code: 'bodega' });
      check('⭐ TI sigue igual: la zona no se pregunta, no se guarda y el ticket se levanta', ti.status === 201 && ti.body?.zone_code === null, dump(ti));
    }

    // ── 28. [MS.7.4] + [MS.7.8] Campos propios por cola: se declaran por configuración y se validan al reportar ───
    {
      console.log('\n28 — campos propios por cola: alta, validación al reportar, ficha etiquetada y permisos');
      const [{ id: qC }] = await knex('servicedesk.queues').insert({ tenant_id: T, code: 'smoke_cf74', name: 'SMOKE Campos', sort_order: 905 }).returning('id');
      const [{ id: catC }] = await knex('servicedesk.categories').insert({ tenant_id: T, queue_id: qC, code: 'smoke_cf74_cat', name: 'SMOKE C', default_priority: 'media', requires_branch: false }).returning('id');
      const jefeC = await crearUsuario('cf_jefe', ['SERVICIO_ATENDER', 'SERVICIO_COORDINAR'], [{ queue_id: qC, role: 'coordinador' }]);
      usuarios.push(jefeC);
      const mk = (extra, adjuntos) => req('POST', `${SD}/requests`, sol.token, { category_id: catC, title: 'SMOKE 7.4 ' + Math.random().toString(36).slice(2, 7), ...(extra !== undefined ? { extra } : {}), ...(adjuntos ? { attachments: adjuntos } : {}) });
      const alta = (token, dto, cola = qC) => req('POST', `${SD}/config/queues/${cola}/fields`, token, dto);
      const PNG = { file_base64: dataUri('image/png', PNG_1X1), file_name: 'falla.png' };

      // Una cola sin campos se comporta como siempre.
      const base = await mk();
      check('⭐ una cola SIN campos se levanta como siempre y guarda extra vacío', base.status === 201 && Array.isArray(base.body?.extra) && base.body.extra.length === 0, dump(base));
      const c0 = (await req('GET', `${SD}/catalog`, sol.token)).body;
      check('el catálogo declara `fields` (vacío para las colas que no tienen)', Array.isArray(c0?.fields) && !(c0.fields ?? []).some((f) => f.queue_id === qC), JSON.stringify(c0?.fields));

      // Quién declara campos.
      check('⛔ quien coordina OTRA cola no declara campos en ésta → 403', (await alta(coord.token, { code: 'afecta', label: '¿Afecta a clientes?', type: 'boolean' })).status === 403);
      check('⛔ quien reportó (sin permisos) → 403', (await alta(sol.token, { code: 'afecta', label: '¿Afecta a clientes?', type: 'boolean' })).status === 403);
      check('⛔ código mal formado → 400', (await alta(jefeC.token, { code: 'Con Espacios', label: 'x', type: 'boolean' })).status === 400);
      check('⛔ tipo desconocido → 400', (await alta(jefeC.token, { code: 'fecha', label: 'Fecha', type: 'fecha' })).status === 400);
      check('⛔ un select con UNA opción → 400', (await alta(jefeC.token, { code: 'tipo', label: 'Tipo', type: 'select', options: ['sola'] })).status === 400);
      check('⛔ una pregunta vacía → 400', (await alta(jefeC.token, { code: 'afecta', label: '  ', type: 'boolean' })).status === 400);
      check('⛔ una cola inexistente → 403/404 (nadie la coordina)', [403, 404].includes((await alta(jefeC.token, { code: 'afecta', label: 'x', type: 'boolean' }, '00000000-0000-0000-0000-0000000000ee')).status));
      const a1 = await alta(jefeC.token, { code: 'afecta', label: '¿Afecta a clientes?', type: 'boolean', required: true, sort_order: 10 });
      check('⭐ la coordinación DE LA COLA declara un sí/no requerido', a1.status < 300 && (a1.body?.fields ?? []).some((f) => f.queue_id === qC && f.code === 'afecta' && f.required === true && f.active === true), dump(a1));
      await alta(jefeC.token, { code: 'tipo_falla', label: 'Tipo de falla', type: 'select', options: ['Eléctrica', 'Hidráulica', 'Otra'], sort_order: 20 });
      await alta(jefeC.token, { code: 'equipo', label: 'Equipo', type: 'text', sort_order: 30 });
      const aFoto = await alta(jefeC.token, { code: 'foto', label: 'Foto de la falla', type: 'photo', required: false, sort_order: 40 });
      check('⛔ el código no se repite en la misma cola', [400, 409].includes((await alta(jefeC.token, { code: 'afecta', label: 'otra', type: 'boolean' })).status));
      const fAfecta = (a1.body?.fields ?? []).find((f) => f.code === 'afecta');
      const fFoto = (aFoto.body?.fields ?? []).find((f) => f.code === 'foto');
      check('⛔ el código de un campo NO se cambia → 400', (await req('PUT', `${SD}/config/fields/${fAfecta?.id}`, jefeC.token, { code: 'otro' })).status === 400);
      check('⛔ el tipo de un campo NO se cambia → 400', (await req('PUT', `${SD}/config/fields/${fAfecta?.id}`, jefeC.token, { type: 'text' })).status === 400);
      check('⛔ quien coordina OTRA cola no edita este campo → 403 (se autoriza por la cola DEL CAMPO)', (await req('PUT', `${SD}/config/fields/${fAfecta?.id}`, coord.token, { label: 'hackeado' })).status === 403);
      check('⛔ opciones en un campo que no es select → 400', (await req('PUT', `${SD}/config/fields/${fAfecta?.id}`, jefeC.token, { options: ['a', 'b'] })).status === 400);

      // El catálogo los ofrece (sólo activos, en su orden).
      const c1 = (await req('GET', `${SD}/catalog`, sol.token)).body;
      const susCampos = (c1?.fields ?? []).filter((f) => f.queue_id === qC);
      check('⭐ el catálogo ofrece sus 4 campos ordenados', susCampos.map((f) => f.code).join(',') === 'afecta,tipo_falla,equipo,foto', JSON.stringify(susCampos.map((f) => f.code)));
      check('y las opciones del select viajan', susCampos.find((f) => f.code === 'tipo_falla')?.options?.length === 3);

      // Validación al reportar.
      const sinContestar = await mk({});
      check('⛔ un requerido sin contestar → 400 con la razón', sinContestar.status === 400 && /obligatorio/.test(JSON.stringify(sinContestar.body)), dump(sinContestar));
      const sinExtra = await mk();
      check('⛔ sin mandar `extra` con un requerido declarado → 400', sinExtra.status === 400, dump(sinExtra));
      check('⛔ un sí/no que no es booleano → 400', (await mk({ afecta: 'no' })).status === 400);
      check('⛔ una opción fuera de la lista → 400', (await mk({ afecta: true, tipo_falla: 'Mecánica' })).status === 400);
      check('⛔ un campo que la cola NO declara → 400 (no se ignora)', (await mk({ afecta: true, inventado: 'x' })).status === 400);
      check('⛔ un texto de más de 500 caracteres → 400', (await mk({ afecta: true, equipo: 'a'.repeat(501) })).status === 400);
      check('⛔ `extra` que no es un objeto → 400', (await mk([1, 2])).status === 400);
      check('⛔ la foto no viaja en `extra` → 400', (await mk({ afecta: true, foto: 'data:image/png;base64,xx' })).status === 400);
      const huerfanos = await knex('servicedesk.requests').where({ queue_id: qC }).whereRaw(`title like 'SMOKE 7.4%'`).count({ n: '*' }).first();
      check('y las peticiones rechazadas no dejaron tickets a medias (sólo el primero, sin campos)', Number(huerfanos.n) === 1, String(huerfanos.n));

      const bien = await mk({ afecta: false, tipo_falla: 'Eléctrica', equipo: '  Compresor 2  ' });
      check('⭐ con todo bien se levanta; `false` ES una respuesta', bien.status === 201, dump(bien));
      const ficha = await req('GET', `${SD}/requests/${bien.body?.id}`, sol.token);
      const ex = ficha.body?.extra ?? [];
      check('⭐ la ficha devuelve lo contestado CON la pregunta, en el orden de los campos y normalizado', ex.map((e) => `${e.label}=${e.value}`).join('|') === '¿Afecta a clientes?=false|Tipo de falla=Eléctrica|Equipo=Compresor 2', JSON.stringify(ex));
      const guardado = await knex('servicedesk.requests').where({ id: bien.body?.id }).first('extra');
      check('en la base queda sólo lo contestado, por código', JSON.stringify(Object.keys(guardado.extra).sort()) === JSON.stringify(['afecta', 'equipo', 'tipo_falla']), JSON.stringify(guardado.extra));
      const parcial = await mk({ afecta: true });
      check('lo OPCIONAL sin contestar no se guarda (ni null ni vacío)', parcial.status === 201 && (await knex('servicedesk.requests').where({ id: parcial.body?.id }).first('extra')).extra?.tipo_falla === undefined, dump(parcial));

      // Foto requerida (la capacidad existe; ninguna cola real la activa).
      const req1 = await req('PUT', `${SD}/config/fields/${fFoto?.id}`, jefeC.token, { required: true });
      check('la coordinación puede volver requerida la foto', req1.status === 200 && (req1.body?.fields ?? []).find((f) => f.id === fFoto?.id)?.required === true, dump(req1));
      const sinFoto = await mk({ afecta: true });
      check('⛔ foto requerida SIN adjunto → 400', sinFoto.status === 400 && /foto/i.test(JSON.stringify(sinFoto.body)), dump(sinFoto));
      const conFoto = await mk({ afecta: true }, [PNG]);
      if (conFoto.status === 201) check('⭐ foto requerida CON adjunto → se levanta y el adjunto queda ligado', (conFoto.body?.attachments ?? []).length === 1, dump(conFoto));
      else noMedido.push(`foto requerida CON adjunto válido (MS.7.4): el bucket no respondió (${conFoto.status}); la negativa «sin foto → 400» sí se midió`);
      await req('PUT', `${SD}/config/fields/${fFoto?.id}`, jefeC.token, { required: false }); // los siguientes no llevan adjunto

      // Editar: la pregunta cambia para lo nuevo; el ticket viejo conserva SU pregunta... (la etiqueta sale de la definición vigente).
      const renombra = await req('PUT', `${SD}/config/fields/${fAfecta?.id}`, jefeC.token, { label: '¿Afecta a los clientes?' });
      check('se renombra la pregunta', renombra.status === 200 && (renombra.body?.fields ?? []).some((f) => f.id === fAfecta?.id && f.label === '¿Afecta a los clientes?'), dump(renombra));
      // Apagar un campo requerido: deja de pedirse, el ticket viejo conserva su respuesta.
      const apaga = await req('PUT', `${SD}/config/fields/${fAfecta?.id}`, jefeC.token, { active: false });
      check('apagar no borra: sigue en la configuración, apagado', apaga.status === 200 && (apaga.body?.fields ?? []).some((f) => f.id === fAfecta?.id && f.active === false), dump(apaga));
      const c2 = (await req('GET', `${SD}/catalog`, sol.token)).body;
      check('⭐ apagado, el catálogo ya no lo ofrece', !(c2?.fields ?? []).some((f) => f.code === 'afecta'));
      const yaNoPide = await mk({ tipo_falla: 'Otra' });
      check('⭐ y ya no se exige aunque fuera requerido', yaNoPide.status === 201, dump(yaNoPide));
      check('⛔ mandar la respuesta de un campo apagado → 400 (la cola ya no lo declara)', (await mk({ afecta: true })).status === 400);
      const vieja = await req('GET', `${SD}/requests/${bien.body?.id}`, sol.token);
      check('⭐ el ticket viejo CONSERVA su respuesta del campo apagado, con su pregunta', (vieja.body?.extra ?? []).some((e) => e.code === 'afecta' && e.value === false), JSON.stringify(vieja.body?.extra));
      check('⛔ editar un campo inexistente → 404', (await req('PUT', `${SD}/config/fields/00000000-0000-0000-0000-0000000000ee`, jefeC.token, { active: true })).status === 404);

      // Opciones editables.
      const fTipo = (c1?.fields ?? []).find((f) => f.code === 'tipo_falla');
      const [rowTipo] = await knex('servicedesk.queue_fields').where({ queue_id: qC, code: 'tipo_falla' }).select('id');
      const cambia = await req('PUT', `${SD}/config/fields/${rowTipo.id}`, jefeC.token, { options: ['Eléctrica', 'Hidráulica', 'Mecánica'] });
      check('las opciones de un select se editan', cambia.status === 200 && (cambia.body?.fields ?? []).find((f) => f.id === rowTipo.id)?.options?.includes('Mecánica'), dump(cambia));
      check('⛔ pero una sola opción → 400', (await req('PUT', `${SD}/config/fields/${rowTipo.id}`, jefeC.token, { options: ['sola'] })).status === 400);
      check('(control) el campo de opciones sigue declarado', !!fTipo);

      // TI no cambió.
      const ti = await req('POST', `${SD}/requests`, sol.token, { category_id: catSimple.id, title: 'SMOKE 7.4 TI', impact: 'yo', blocks_work: false, extra: { afecta: true } });
      check('⛔ TI no declara ese campo: mandarlo → 400 (los campos son por cola)', ti.status === 400, dump(ti));
      const ti2 = await req('POST', `${SD}/requests`, sol.token, { category_id: catSimple.id, title: 'SMOKE 7.4 TI ok', impact: 'yo', blocks_work: false });
      check('⭐ TI sigue igual: sin campos propios se levanta como siempre', ti2.status === 201 && (ti2.body?.extra ?? []).length === 0, dump(ti2));
    }

    // ── 29. [MS.7.9] Motivo de pausa: qué se espera decide si la respuesta de la persona reanuda el ticket ───
    {
      console.log('\n29 — motivo de pausa en «en espera»');
      const nuevoTicket = async (t) => {
        const r = await req('POST', `${SD}/requests`, sol.token, { category_id: catSimple.id, title: 'SMOKE 7.9 ' + t, impact: 'yo', blocks_work: false });
        await req('POST', `${SD}/requests/${r.body?.id}/assign`, coord.token, { user_id: agente.id });
        await req('POST', `${SD}/requests/${r.body?.id}/status`, agente.token, { status: 'en_proceso' });
        return r.body?.id;
      };
      const estado = (id, body, token = agente.token) => req('POST', `${SD}/requests/${id}/status`, token, body);
      const ver = async (id) => (await req('GET', `${SD}/requests/${id}`, sol.token)).body;

      const a = await nuevoTicket('sin motivo');
      const sinMotivo = await estado(a, { status: 'en_espera' });
      check('⛔ poner en espera SIN motivo → 400 (sin él «en espera» no dice qué se espera)', sinMotivo.status === 400, dump(sinMotivo));
      check('⛔ motivo inventado → 400', (await estado(a, { status: 'en_espera', pause_reason: 'porque_si' })).status === 400);
      check('⛔ motivo con un estado que no es «en espera» → 400 (no se ignora)', (await estado(a, { status: 'resuelto', note: 'x', pause_reason: 'proveedor' })).status === 400);
      check('⛔ y el ticket no cambió con las peticiones rechazadas', (await ver(a))?.status === 'en_proceso');

      const pa = await estado(a, { status: 'en_espera', pause_reason: 'proveedor', note: 'Espero la pieza del proveedor' });
      check('⭐ con motivo: queda en espera, con su motivo y el reloj pausado', pa.status < 300 && pa.body?.status === 'en_espera' && pa.body?.pause_reason === 'proveedor' && pa.body?.sla?.paused === true, dump(pa));
      const hilo = (await req('GET', `${SD}/requests/${a}`, agente.token)).body?.messages ?? [];
      check('el hilo deja el motivo en el mensaje de estado', hilo.some((m) => m.kind === 'status' && m.meta?.pause_reason === 'proveedor'), JSON.stringify(hilo.map((m) => m.meta)));

      const dueAntes = (await ver(a))?.sla?.due_at;
      const comenta = await req('POST', `${SD}/requests/${a}/messages`, sol.token, { body: '¿Ya llegó la pieza?' });
      const despues = await ver(a);
      check('⭐ esperando al PROVEEDOR, que la persona comente NO reanuda (sigue en espera y pausado)', comenta.status < 300 && despues?.status === 'en_espera' && despues?.pause_reason === 'proveedor' && despues?.sla?.paused === true, `${despues?.status} ${despues?.pause_reason} paused=${despues?.sla?.paused}`);
      check('y el plazo no se movió: el reloj no corre en pausa', despues?.sla?.due_at === dueAntes, `${dueAntes} → ${despues?.sla?.due_at}`);

      const reanuda = await estado(a, { status: 'en_proceso', note: 'Llegó la pieza' });
      check('⭐ quien atiende reanuda: vuelve a en proceso, el reloj corre y el motivo SE VA', reanuda.status < 300 && reanuda.body?.status === 'en_proceso' && reanuda.body?.pause_reason === null && reanuda.body?.sla?.paused === false, dump(reanuda));

      const b = await nuevoTicket('solicitante');
      await estado(b, { status: 'en_espera', pause_reason: 'solicitante', note: 'Necesito que me digas el equipo' });
      const resp = await req('POST', `${SD}/requests/${b}/messages`, sol.token, { body: 'Es la caja 3' });
      const rb = await ver(b);
      check('⭐ esperando a la PERSONA, su respuesta SÍ reanuda sola y se va el motivo', resp.status < 300 && rb?.status === 'en_proceso' && rb?.pause_reason === null && rb?.sla?.paused === false, `${rb?.status} ${rb?.pause_reason}`);

      const c = await nuevoTicket('resolver desde la espera');
      await estado(c, { status: 'en_espera', pause_reason: 'refaccion' });
      const res = await estado(c, { status: 'resuelto', note: 'Se resolvió sin la refacción' });
      check('resolver desde «en espera» también limpia el motivo', res.status < 300 && res.body?.status === 'resuelto' && res.body?.pause_reason === null, dump(res));
      const d = await nuevoTicket('cancelar desde la espera');
      await estado(d, { status: 'en_espera', pause_reason: 'aprobacion' });
      const can = await req('POST', `${SD}/requests/${d}/cancel`, coord.token, {});
      check('cancelar desde «en espera» limpia el motivo (no queda un motivo huérfano)', can.status < 300 && can.body?.status === 'cancelado' && can.body?.pause_reason === null, dump(can));
      const enBase = await knex('servicedesk.requests').whereIn('id', [a, b, c, d]).whereNotNull('pause_reason').count({ n: '*' }).first();
      check('⭐ en la base no quedó ningún motivo fuera de «en espera»', Number(enBase.n) === 0, String(enBase.n));
      check('⛔ quien reportó no pone en espera → 403', (await estado(a, { status: 'en_espera', pause_reason: 'otro' }, sol.token)).status === 403);
    }

    // ── 30. [MS.7.10] Ruteo por ubicación + responsable por omisión (sólo a miembros de la cola) ───────
    {
      console.log('\n30 — ruteo por ubicación y responsable por omisión');
      const [{ id: qR }] = await knex('servicedesk.queues').insert({ tenant_id: T, code: 'smoke_rt710', name: 'SMOKE Ruteo', sort_order: 906 }).returning('id');
      const [{ id: catR }] = await knex('servicedesk.categories').insert({ tenant_id: T, queue_id: qR, code: 'smoke_rt710_a', name: 'SMOKE RT a', default_priority: 'media', requires_branch: false }).returning('id');
      const [{ id: catR2 }] = await knex('servicedesk.categories').insert({ tenant_id: T, queue_id: qR, code: 'smoke_rt710_b', name: 'SMOKE RT b', default_priority: 'media', requires_branch: false }).returning('id');
      const jefeR = await crearUsuario('rt_jefe', ['SERVICIO_ATENDER', 'SERVICIO_COORDINAR'], [{ queue_id: qR, role: 'coordinador' }]);
      const tecR = await crearUsuario('rt_tec', ['SERVICIO_ATENDER'], [{ queue_id: qR, role: 'tecnico' }]);
      usuarios.push(jefeR, tecR);
      const mk = (cat, extra = {}) => req('POST', `${SD}/requests`, sol.token, { category_id: cat, title: 'SMOKE 7.10 ' + Math.random().toString(36).slice(2, 7), ...extra });
      const ficha = async (r) => (await req('GET', `${SD}/requests/${r.body?.id}`, jefeR.token)).body;
      const regla = (token, dto) => req('POST', `${SD}/config/routing`, token, dto);
      const quien = async (r) => (await ficha(r))?.assigned_to ?? null;

      // Validación de la regla.
      check('⛔ una ubicación que no existe → 400', (await regla(coord.token, { name: 'SMOKE 710 mala', warehouse_code: 'ZZ', assignee_id: tecR.id })).status === 400);
      check('⛔ sin categoría, palabras NI ubicación sigue siendo → 400', (await regla(coord.token, { name: 'SMOKE 710 vacía', assignee_id: tecR.id })).status === 400);
      check('⛔ quitarle a una regla su ÚNICO disparador (la ubicación) → 400', await (async () => {
        const a = await regla(coord.token, { name: 'SMOKE 710 temporal', warehouse_code: 'OF', assignee_id: tecR.id, sort_order: 5000 });
        const id = (a.body?.rules ?? []).find((r) => r.name === 'SMOKE 710 temporal')?.id;
        const r = await req('PUT', `${SD}/config/routing/${id}`, coord.token, { warehouse_code: null });
        await knex('servicedesk.routing_rules').where({ id }).del();
        return r.status === 400;
      })());

      // A) sólo ubicación.
      const rA = await regla(coord.token, { name: 'SMOKE 710 oficinas', warehouse_code: 'OF', assignee_id: tecR.id, sort_order: 50 });
      const ruleA = (rA.body?.rules ?? []).find((r) => r.name === 'SMOKE 710 oficinas');
      check('⭐ una regla sólo por UBICACIÓN se da de alta y la lista dice su nombre', rA.status < 300 && ruleA?.warehouse_code === 'OF' && ruleA?.warehouse_name === 'Oficinas Corporativas', dump(rA));
      const t1 = await mk(catR, { warehouse_code: 'OF' });
      const f1 = await ficha(t1);
      check('⭐ un ticket de esa ubicación cae a su persona, ya asignado', f1?.assigned_to === tecR.id && f1?.status === 'asignado', JSON.stringify([f1?.status, f1?.assigned_to]));
      const m1 = (f1?.messages ?? []).find((m) => m.kind === 'assignment');
      check('el hilo dice que fue por UBICACIÓN y por qué regla', m1?.meta?.reason === 'location' && m1?.meta?.rule_name === 'SMOKE 710 oficinas', JSON.stringify(m1?.meta));
      check('⛔ de OTRA ubicación la regla NO aplica (queda sin asignar)', (await quien(await mk(catR, { warehouse_code: 'EC' }))) === null);
      check('⛔ y sin ubicación tampoco', (await quien(await mk(catR))) === null);

      // B) la más específica gana, aunque vaya después en el orden.
      await regla(coord.token, { name: 'SMOKE 710 cat+ubic', category_id: catR, warehouse_code: 'OF', assignee_id: jefeR.id, sort_order: 90 });
      check('⭐ categoría + ubicación le gana a ubicación sola, AUNQUE vaya después (orden 90 > 50)', (await quien(await mk(catR, { warehouse_code: 'OF' }))) === jefeR.id);
      check('⭐ otra categoría de la cola, misma ubicación → la regla de ubicación (la específica no aplica)', (await quien(await mk(catR2, { warehouse_code: 'OF' }))) === tecR.id);
      check('⛔ la categoría correcta en OTRA ubicación → nadie (ninguna regla aplica)', (await quien(await mk(catR, { warehouse_code: 'EC' }))) === null);

      // C) responsable por omisión.
      const def = (token, v) => req('PUT', `${SD}/config/queues/${qR}`, token, { default_assignee_id: v });
      const cfg0 = (await req('GET', `${SD}/config`, jefeR.token)).body;
      check('la cola nace SIN responsable por omisión (los sin regla quedan «Sin asignar»)', (cfg0?.queues ?? []).find((q) => q.id === qR)?.default_assignee_id === null);
      check('⛔ un id mal formado → 400', (await def(jefeR.token, 'no-es-uuid')).status === 400);
      check('⛔ alguien que NO es de la cola (la persona que reporta) → 400', (await def(jefeR.token, sol.id)).status === 400);
      check('⛔ alguien con permiso pero miembro de OTRA cola (el agente de TI) → 400', (await def(jefeR.token, agente.id)).status === 400);
      check('⛔ un usuario que no existe → 400', (await def(jefeR.token, '00000000-0000-4000-8000-000000000000')).status === 400);
      check('⛔ quien coordina OTRA cola no lo cambia → 403', (await def(coord.token, tecR.id)).status === 403);
      const ponDef = await def(jefeR.token, tecR.id);
      const qCfg = (ponDef.body?.queues ?? []).find((q) => q.id === qR);
      check('⭐ la coordinación DE LA COLA lo pone (un miembro) y la configuración dice su nombre', ponDef.status === 200 && qCfg?.default_assignee_id === tecR.id && !!qCfg?.default_assignee_name, dump(ponDef));

      const tDef = await mk(catR, { warehouse_code: 'EC' });
      const fDef = await ficha(tDef);
      check('⭐ sin regla que aplique, cae el responsable por omisión (asignado)', fDef?.assigned_to === tecR.id && fDef?.status === 'asignado', JSON.stringify([fDef?.status, fDef?.assigned_to]));
      const mDef = (fDef?.messages ?? []).find((m) => m.kind === 'assignment');
      check('el hilo dice que fue por OMISIÓN (sin regla)', mDef?.meta?.reason === 'default' && mDef?.meta?.rule_id === null, JSON.stringify(mDef?.meta));
      check('⭐ una regla que aplica le GANA al responsable por omisión', (await quien(await mk(catR, { warehouse_code: 'OF' }))) === jefeR.id);

      // D) nunca a quien no es miembro.
      await knex('servicedesk.queue_members').where({ queue_id: qR, user_id: tecR.id }).update({ active: false });
      const tFuera = await mk(catR, { warehouse_code: 'EC' });
      const fFuera = await ficha(tFuera);
      check('⛔ si el responsable YA NO es miembro de la cola, el ticket queda SIN asignar (nunca a un no-miembro)', fFuera?.assigned_to === null && fFuera?.status === 'nuevo', JSON.stringify([fFuera?.status, fFuera?.assigned_to]));
      check('⭐ y una nota interna lo dice, para que el error se vea', (fFuera?.messages ?? []).some((m) => m.visibility === 'internal' && /responsable por omisi/i.test(m.body)), JSON.stringify((fFuera?.messages ?? []).map((m) => m.body)));
      const fFueraSol = (await req('GET', `${SD}/requests/${tFuera.body?.id}`, sol.token)).body;
      check('⛔ y quien reportó NO ve esa nota interna', !(fFueraSol?.messages ?? []).some((m) => /responsable por omisi/i.test(m.body)));
      await knex('servicedesk.queue_members').where({ queue_id: qR, user_id: tecR.id }).update({ active: true });

      // E) se puede quitar.
      const quita = await def(jefeR.token, null);
      check('se quita el responsable por omisión (null)', quita.status === 200 && (quita.body?.queues ?? []).find((q) => q.id === qR)?.default_assignee_id === null, dump(quita));
      check('⭐ sin él, lo sin regla vuelve a quedar «Sin asignar»', (await quien(await mk(catR, { warehouse_code: 'EC' }))) === null);

      // F) quien sale de la cola deja de ser su responsable por omisión (no queda un responsable fantasma).
      const tec2 = await crearUsuario('rt_tec2', ['SERVICIO_ATENDER'], [{ queue_id: qR, role: 'tecnico' }]);
      usuarios.push(tec2);
      await def(jefeR.token, tec2.id);
      const sale = await req('DELETE', `${SD}/config/queues/${qR}/members/${tec2.id}`, jefeR.token);
      const tras = (await req('GET', `${SD}/config`, jefeR.token)).body;
      check('⭐ al quitar de la cola a su responsable por omisión, éste se limpia', sale.status < 300 && (tras?.queues ?? []).find((q) => q.id === qR)?.default_assignee_id === null, dump(sale));

      // TI no cambió.
      const cfgTi = (await req('GET', `${SD}/config`, coord.token)).body;
      check('⭐ TI sigue sin responsable por omisión', (cfgTi?.queues ?? []).filter((q) => q.code === 'ti').every((q) => q.default_assignee_id === null));
      const tiOf = await req('POST', `${SD}/requests`, sol.token, { category_id: catSimple.id, title: 'SMOKE 7.10 TI en oficinas', impact: 'yo', blocks_work: false, warehouse_code: 'OF' });
      check('⛔ las reglas de OTRA cola (ubicación Oficinas → persona de Ruteo) NO tocan un ticket de TI', tiOf.status === 201 && ((await req('GET', `${SD}/requests/${tiOf.body?.id}`, coord.token)).body?.assigned_to ?? null) !== tecR.id);

      await knex('servicedesk.routing_rules').whereIn('assignee_id', [tecR.id, jefeR.id]).del();
    }

    // ── 20b. Filtrar y ordenar la bandeja (el orden lo pone el SERVIDOR) ───────────────
    {
      console.log('\n20b — la bandeja filtra y ordena en el servidor (categoría, atiende, fechas, columnas)');
      const tag = `SMOKE orden ${Date.now().toString(36)}`;
      const hoy = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Mexico_City', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
      const mk = (title, extra = {}) => req('POST', `${SD}/requests`, sol.token, { category_id: catSimple.id, title: `${tag} ${title}`, ...extra });
      const tZeta = await mk('zeta', { warehouse_code: '03' });
      const tAlfa = await mk('alfa');
      const tMike = await mk('mike', { warehouse_code: 'OF' });
      await req('POST', `${SD}/requests/${tAlfa.body?.id}/take`, agente.token);
      check('las 3 solicitudes de prueba se crean', [tZeta, tAlfa, tMike].every((t) => t.status === 201 || t.status === 200), dump(tZeta));

      const lista = (qs = '') => req('GET', `${SD}/requests/inbox?scope=all${qs.includes('limit=') ? '' : '&limit=100'}&search=${encodeURIComponent(tag)}${qs}`, coord.token);
      const titulos = (r) => (r.body?.rows ?? []).map((x) => x.title.replace(`${tag} `, ''));
      const folios = (r) => (r.body?.rows ?? []).map((x) => x.folio);

      check('sin sort sigue el orden de siempre y trae las 3', (await lista()).body?.total === 3);
      check('⭐ sort=solicitud asc → alfa, mike, zeta', titulos(await lista('&sort=solicitud&dir=asc')).join() === 'alfa,mike,zeta');
      check('⭐ sort=solicitud desc → zeta, mike, alfa', titulos(await lista('&sort=solicitud&dir=desc')).join() === 'zeta,mike,alfa');
      const fAsc = folios(await lista('&sort=folio&dir=asc'));
      const fDesc = folios(await lista('&sort=folio&dir=desc'));
      check('sort=folio asc/desc se invierten entre sí', fAsc.length === 3 && fAsc.join() === [...fDesc].reverse().join() && fAsc.join() === [...fAsc].sort().join(), JSON.stringify([fAsc, fDesc]));
      check('sin dir, el orden es ascendente', titulos(await lista('&sort=solicitud')).join() === 'alfa,mike,zeta');

      // Los vacíos van SIEMPRE al final, sin importar la dirección.
      const ubAsc = titulos(await lista('&sort=ubicacion&dir=asc'));
      const ubDesc = titulos(await lista('&sort=ubicacion&dir=desc'));
      check('⭐ sort=ubicacion ordena por el NOMBRE que se ve (8 Esquinas → Oficinas Corporativas), no por el código', ubAsc.slice(0, 2).join() === 'zeta,mike', ubAsc.join());
      check('⭐ sort=ubicacion: «sin ubicación» (alfa) queda al FINAL en asc', ubAsc[2] === 'alfa', ubAsc.join());
      check('⭐ y TAMBIÉN al final en desc (un vacío no es «lo más grande»)', ubDesc[2] === 'alfa', ubDesc.join());
      const atAsc = titulos(await lista('&sort=atiende&dir=asc'));
      const atDesc = titulos(await lista('&sort=atiende&dir=desc'));
      check('⭐ sort=atiende: quien tiene responsable va primero en asc y en desc; los sin asignar al final', atAsc[0] === 'alfa' && atDesc[0] === 'alfa', JSON.stringify([atAsc, atDesc]));

      // Paginar con orden: cada página continúa a la anterior, sin repetir ni saltarse.
      const p1 = titulos(await lista('&sort=solicitud&dir=asc&limit=2&offset=0'));
      const p2 = titulos(await lista('&sort=solicitud&dir=asc&limit=2&offset=2'));
      check('⭐ el orden vale a través de las páginas (el servidor ordena ANTES de cortar)', [...p1, ...p2].join() === 'alfa,mike,zeta', JSON.stringify([p1, p2]));
      const r3 = await lista('&sort=solicitud&limit=2');
      check('y el total no cambia por ordenar', r3.body?.total === 3 && r3.body?.rows?.length === 2, dump(r3));

      // Filtros nuevos.
      const aAgente = await lista(`&assigned_to=${agente.id}`);
      check('⭐ assigned_to=<usuario> trae sólo lo suyo', titulos(aAgente).join() === 'alfa', titulos(aAgente).join());
      const aNone = await lista('&assigned_to=none');
      check('⭐ assigned_to=none trae lo SIN asignar', titulos(aNone).sort().join() === 'mike,zeta', titulos(aNone).join());
      check('⛔ assigned_to con basura → 400', (await lista('&assigned_to=no-es-un-usuario')).status === 400);

      check('⭐ category_id filtra por categoría', (await lista(`&category_id=${catSimple.id}`)).body?.total === 3);
      check('una categoría que existe pero sin solicitudes → 0 (no error)', (await lista('&category_id=00000000-0000-0000-0000-000000000000')).body?.total === 0);
      check('⛔ category_id con basura → 400', (await lista('&category_id=xx')).status === 400);

      check('⭐ from/to del día traen las 3 (el día se mide en la zona de la mesa)', (await lista(`&from=${hoy}&to=${hoy}`)).body?.total === 3);
      check('⭐ un rango del pasado trae 0', (await lista('&from=2000-01-01&to=2000-01-02')).body?.total === 0);
      check('sólo from (abierto por el final) trae las 3', (await lista(`&from=${hoy}`)).body?.total === 3);
      check('⛔ from posterior a to → 400', (await lista('&from=2026-10-05&to=2026-10-01')).status === 400);
      check('⛔ una fecha imposible (2026-13-45) → 400', (await lista('&from=2026-13-45')).status === 400);
      check('⛔ una fecha en otro formato (05/10/2026) → 400', (await lista('&to=05/10/2026')).status === 400);

      check('⭐ status=asignado trae sólo la que se tomó', titulos(await lista('&status=asignado')).join() === 'alfa');
      const combo = await lista(`&assigned_to=none&warehouse_code=OF&from=${hoy}&to=${hoy}&sort=folio&dir=desc`);
      check('⭐ los filtros se COMBINAN (sin asignar + oficinas + hoy) → sólo «mike»', titulos(combo).join() === 'mike', titulos(combo).join());

      // Lista cerrada: la columna llega por la URL y va a un ORDER BY en crudo.
      check('⛔ sort desconocido → 400', (await lista('&sort=password')).status === 400);
      check('⛔ sort con inyección → 400 (y nada se concatena)', (await lista(`&sort=${encodeURIComponent('r.id; DROP TABLE servicedesk.requests; --')}`)).status === 400);
      check('⛔ dir desconocida → 400', (await lista('&sort=folio&dir=sideways')).status === 400);
      const sigue = await knex('servicedesk.requests').where('title', 'like', `${tag}%`).count({ n: '*' }).first();
      check('la tabla sigue ahí tras el intento de inyección', Number(sigue.n) === 3, JSON.stringify(sigue));
      const columnas = ['folio', 'solicitud', 'reporto', 'ubicacion', 'prioridad', 'estado', 'atiende', 'plazo', 'alta'];
      const resultados = [];
      for (const col of columnas) for (const dir of ['asc', 'desc']) resultados.push([col, dir, (await lista(`&sort=${col}&dir=${dir}`)).status]);
      check('⭐ las 9 columnas que ofrece la pantalla, en las dos direcciones, las acepta el servidor (18/18)', resultados.every(([, , s]) => s === 200), JSON.stringify(resultados.filter(([, , s]) => s !== 200)));
      check('⛔ quien no atiende NO accede a la bandeja ni con filtros → 403', (await req('GET', `${SD}/requests/inbox?scope=all&sort=folio`, sol.token)).status === 403);
    }

    // ── 20. Oficinas Corporativas como ubicación (no es una sucursal Kepler) ───────────
    {
      console.log('\n20 — «Oficinas Corporativas» como ubicación de una solicitud');
      const catSuc = (cat.body?.categories ?? []).find((c) => c.requires_branch);
      const mk = (title, extra = {}, cid = catSimple.id) => req('POST', `${SD}/requests`, sol.token, { category_id: cid, title, ...extra });
      const hoy = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Mexico_City', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
      const tOf = await mk('SMOKE oficinas: no imprime el área de compras', { warehouse_code: 'OF' });
      check('⭐ una solicitud con ubicación «OF» se acepta → 201', tOf.status === 201, dump(tOf));
      check('⭐ y se nombra «Oficinas Corporativas» (no «OF»)', tOf.body?.warehouse_code === 'OF' && tOf.body?.warehouse_name === 'Oficinas Corporativas', JSON.stringify([tOf.body?.warehouse_code, tOf.body?.warehouse_name]));
      const tMin = await mk('SMOKE oficinas: minúsculas', { warehouse_code: 'of' });
      check('sin distinguir mayúsculas, y se guarda en el código canónico «OF»', tMin.status === 201 && tMin.body?.warehouse_code === 'OF', dump(tMin));
      check('⭐ una categoría que EXIGE sucursal acepta las oficinas como ubicación', !!catSuc && (await mk('SMOKE oficinas: categoría con sucursal', { warehouse_code: 'OF' }, catSuc.id)).status === 201);
      check('⛔ NEGATIVA — un código desconocido sigue rechazándose → 400', (await mk('x', { warehouse_code: 'XX' })).status === 400);
      check('⛔ NEGATIVA — y las eras cerradas de Wincaja («30») también → 400', (await mk('x', { warehouse_code: '30' })).status === 400);
      check('⛔ NEGATIVA — «09» (fuera del espacio de Kepler) también → 400', (await mk('x', { warehouse_code: '09' })).status === 400);
      check('las sucursales de siempre siguen valiendo («03»)', (await mk('SMOKE oficinas: sucursal normal', { warehouse_code: '03' })).body?.warehouse_name === '8 Esquinas');
      const filtro = await req('GET', `${SD}/requests/inbox?scope=all&warehouse_code=OF&limit=100`, coord.token);
      check('⭐ la bandeja filtra por las oficinas', (filtro.body?.rows ?? []).some((r) => r.id === tOf.body?.id) && (filtro.body?.rows ?? []).every((r) => r.warehouse_code === 'OF' || r.warehouse_name === 'Oficinas Corporativas'), dump(filtro));
      const rep = await req('GET', `${SD}/reports?from=${hoy}&to=${hoy}`, coord.token);
      const fila = (rep.body?.por_sucursal ?? []).find((x) => x.warehouse_code === 'OF');
      check('⭐ el reporte por sucursal trae a las oficinas, con su nombre', !!fila && fila.warehouse_name === 'Oficinas Corporativas' && fila.creados >= 3, JSON.stringify(fila));
      const enBase = await knex('servicedesk.requests').where({ id: tOf.body?.id }).first('warehouse_code');
      check('la base guarda «OF» (varchar(20), sin chocar con ningún código de Kepler)', enBase.warehouse_code === 'OF');
    }

    // ── 21. El tiempo registrado: la lista en la ficha y las horas en Reportes ───────────
    {
      console.log('\n21 — tiempo registrado: lista en la ficha (sólo quien atiende) y horas por categoría');
      const detalle = (id, tok = coord.token) => req('GET', `${SD}/requests/${id}`, tok);
      const hoy = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Mexico_City', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
      const reporte = () => req('GET', `${SD}/reports?from=${hoy}&to=${hoy}`, coord.token);
      const nombreAg = (await knex('identity.users').where({ id: agente.id }).first('nombre')).nombre;
      const catOtra = (cat.body?.categories ?? []).find((c) => c.id !== catSimple.id && !c.requires_branch && c.name !== 'Desarrollo');

      const antes = (await reporte()).body;
      const filaAntes = antes.por_categoria.find((c) => c.category_id === catSimple.id);
      const tt = await req('POST', `${SD}/requests`, sol.token, { category_id: catSimple.id, title: 'SMOKE tiempo: se registra el trabajo' });
      await req('POST', `${SD}/requests/${tt.body?.id}/take`, agente.token);
      const l1 = await req('POST', `${SD}/requests/${tt.body?.id}/time`, agente.token, { minutes: 30, note: 'Cambié el cable de red del mostrador' });
      const l2 = await req('POST', `${SD}/requests/${tt.body?.id}/time`, agente.token, { minutes: 45 });
      check('quien atiende registra tiempo (con y sin nota) → 2xx', l1.status < 300 && l2.status < 300, dump(l1) + ' ' + dump(l2));

      const dAg = await detalle(tt.body?.id, agente.token);
      const ent = dAg.body?.time_entries;
      check('⭐ la ficha de quien atiende trae la LISTA de registros', Array.isArray(ent) && ent.length === 2, JSON.stringify(ent));
      check('⭐ cada registro dice cuánto, quién, cuándo y qué hizo', ent?.[0]?.minutes === 30 && ent[0].user_name === nombreAg && ent[0].note === 'Cambié el cable de red del mostrador' && !!ent[0].created_at && ent[0].source === 'suite', JSON.stringify(ent?.[0]));
      check('el segundo, sin nota, trae `note: null` (no una cadena vacía)', ent?.[1]?.minutes === 45 && ent[1].note === null, JSON.stringify(ent?.[1]));
      check('van del más viejo al más nuevo', new Date(ent?.[0]?.created_at).getTime() <= new Date(ent?.[1]?.created_at).getTime());
      check('⭐ el total es la suma de la lista (75), no un número aparte', dAg.body?.time_logged_minutes === 75 && ent.reduce((s, e) => s + e.minutes, 0) === 75, String(dAg.body?.time_logged_minutes));

      const dSol = await detalle(tt.body?.id, sol.token);
      check('⛔ quien REPORTÓ recibe `time_entries: null` (no «lista vacía»: no tiene acceso)', dSol.status === 200 && dSol.body?.time_entries === null && dSol.body?.time_logged_minutes === null, JSON.stringify([dSol.body?.time_entries, dSol.body?.time_logged_minutes]));
      check('⛔ y en NADA de su respuesta aparece la nota del trabajo', !JSON.stringify(dSol.body).includes('Cambié el cable'));
      check('⛔ el solicitante NO puede registrar tiempo → 403', (await req('POST', `${SD}/requests/${tt.body?.id}/time`, sol.token, { minutes: 10 })).status === 403);
      check('⛔ minutos fuera de rango → 400', (await req('POST', `${SD}/requests/${tt.body?.id}/time`, agente.token, { minutes: 0 })).status === 400 && (await req('POST', `${SD}/requests/${tt.body?.id}/time`, agente.token, { minutes: 1441 })).status === 400);

      // Reportes: horas por categoría, con su cobertura.
      const despues = (await reporte()).body;
      const filaDesp = despues.por_categoria.find((c) => c.category_id === catSimple.id);
      check('⭐ el reporte suma +75 minutos a la categoría y +1 solicitud con tiempo', (filaDesp.minutos_trabajados ?? 0) === (filaAntes?.minutos_trabajados ?? 0) + 75 && filaDesp.con_tiempo === (filaAntes?.con_tiempo ?? 0) + 1, JSON.stringify([filaAntes, filaDesp]));
      check('el total del periodo también', (despues.totales.minutos_trabajados ?? 0) === (antes.totales.minutos_trabajados ?? 0) + 75 && despues.totales.con_tiempo === antes.totales.con_tiempo + 1);
      if (catOtra) {
        await req('POST', `${SD}/requests`, sol.token, { category_id: catOtra.id, title: 'SMOKE tiempo: nadie registra aquí' });
        const filaOtra = (await reporte()).body.por_categoria.find((c) => c.category_id === catOtra.id);
        check('⛔ una categoría donde NADIE registró tiempo sale `null` y `con_tiempo: 0`, NUNCA «0 minutos»', filaOtra?.minutos_trabajados === null && filaOtra?.con_tiempo === 0, JSON.stringify(filaOtra));
      } else {
        noMedido.push('ninguna otra categoría libre para probar el «null, no 0» de las horas por categoría');
      }
      check('⛔ el reporte sigue sin traer nada por persona', !/"(assign[a-z_]*|requester[a-z_]*|resolved_by|assignee[a-z_]*|user[a-z_]*)":/i.test(JSON.stringify(despues)));
      check('y declara que el tiempo es sólo el que se registra a mano', despues.no_medido.some((t) => /sólo el que se registra a mano/.test(t)));
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
        await knex('servicedesk.sla_policies').where({ tenant_id: T, priority: p.priority }).whereNull('queue_id').update({
          first_response_minutes: p.first_response_minutes, resolution_minutes: p.resolution_minutes, clock: p.clock,
        });
      }
    }
    if (mtoActivaAntes !== null) await knex('servicedesk.queues').where({ tenant_id: T, code: 'mantenimiento' }).update({ active: mtoActivaAntes });
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
      await knex('servicedesk.queue_members').whereIn('user_id', ids).del();
      await knex('servicedesk.notification_prefs').whereIn('user_id', ids).del();
      await knex('identity.user_permissions').whereIn('user_id', ids).del();
      await knex('identity.user_roles').whereIn('user_id', ids).del();
      await knex('identity.users').whereIn('id', ids).del();
    }
    await knex('servicedesk.queue_members').whereIn('queue_id', knex('servicedesk.queues').where({ tenant_id: T }).where('code', 'like', 'smoke_%').select('id')).del();
    await knex('servicedesk.sla_policies').whereIn('queue_id', knex('servicedesk.queues').where({ tenant_id: T }).where('code', 'like', 'smoke_%').select('id')).del();
    await knex('servicedesk.categories').where({ tenant_id: T }).where('code', 'like', 'smoke_%').del();
    await knex('servicedesk.queue_fields').whereIn('queue_id', knex('servicedesk.queues').where({ tenant_id: T }).where('code', 'like', 'smoke_%').select('id')).del();
    await knex('servicedesk.zones').where({ tenant_id: T }).where('code', 'like', 'smoke_%').del();
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
