/* eslint-disable no-console */
/**
 * `[MS.1.6]` Fase MS (ADR-081) — Mesa de Servicio, CAPA 1 (base de datos). Smoke DB-direct, con
 * ROLLBACK al final: cero efecto real.
 *
 * Qué verifica (y por qué cada bloque trae su prueba NEGATIVA):
 *   1. Schema: las 11 tablas existen, con RLS FORZADO y la política `tenant_isolation`.
 *   2. Grants: la matriz EXACTA por tabla (el registro no se edita ni se borra desde la API).
 *   3. Semillas: cola TI, 12 categorías, los 4 plazos propuestos, escalamiento APAGADO.
 *   4. Folio `SRV-AAAA-NNNNN`: UPSERT atómico y formato exigido por la base.
 *   5. El ticket: las invariantes de la máquina de estados que la BASE hace cumplir.
 *   6. Hilo, adjuntos y tiempo: una nota interna jamás es pública; sólo imagen/PDF; minutos > 0.
 *   7. Avisos: WhatsApp exige consentimiento; un aviso enviado tiene hora; la anti-repetición.
 *   8. Contacto en `identity.users`: formato de correo y teléfono canónico.
 *   9. Aislamiento por tenant y permisos REALES, actuando como `app_runtime` (un superusuario se
 *      salta el RLS: sin `SET LOCAL ROLE` este bloque se pondría verde midiendo nada).
 *
 * ⚠️ «Un gate sin prueba negativa es una intención» (ADR-056): cada CHECK se rompe a propósito UNA vez
 * y se exige el código de error exacto, y cada negativa trae su CONTROL POSITIVO (la misma fila sin el
 * defecto SÍ entra) — sin él, un rechazo podría venir de una consulta rota y no del CHECK.
 */
const knex = require('knex')(require('../knexfile-newdb.js').development);
require('./_lib/assert-safe-target').assertSafeTarget('test-newdb-service-desk');

const T = '00000000-0000-0000-0000-00000000d01c';

let pass = 0;
let fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; console.log('  ✓', msg); } else { fail++; console.log('  ✗', msg); }
}
/** Corre `fn` dentro de un SAVEPOINT y devuelve el código SQLSTATE del error (null si no falló). */
async function codigo(trx, fn) {
  await trx.raw('SAVEPOINT sp_sd');
  let code = null;
  try { await fn(); } catch (e) { code = e.code || e.message; }
  await trx.raw('ROLLBACK TO SAVEPOINT sp_sd');
  return code;
}

const TABLAS = [
  'queues', 'categories', 'sla_policies', 'settings', 'request_sequences', 'requests',
  'request_messages', 'request_attachments', 'work_log', 'notification_prefs', 'notification_log',
];

/** Matriz de grants para `app_runtime` — `FASE_MS_SOLICITUD_TABLAS_Y_ACCESOS.md` §4.2. */
const GRANTS = {
  queues: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'],
  categories: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'],
  sla_policies: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'],
  settings: ['SELECT', 'INSERT', 'UPDATE'],
  request_sequences: ['SELECT', 'INSERT', 'UPDATE'],
  requests: ['SELECT', 'INSERT', 'UPDATE'],
  request_messages: ['SELECT', 'INSERT'],
  request_attachments: ['SELECT', 'INSERT'],
  work_log: ['SELECT', 'INSERT'],
  notification_prefs: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'],
  notification_log: ['SELECT', 'INSERT'],
};
const TODOS = ['SELECT', 'INSERT', 'UPDATE', 'DELETE'];

(async () => {
  try {
    // ── 1. Schema ────────────────────────────────────────────────────────────────────────────
    console.log('\n── 1. Schema, RLS forzado y política de aislamiento');
    for (const t of TABLAS) {
      const r = await knex.raw(
        `SELECT c.relrowsecurity rls, c.relforcerowsecurity frz,
                EXISTS (SELECT 1 FROM pg_policies p WHERE p.schemaname='servicedesk' AND p.tablename=? AND p.policyname='tenant_isolation') pol
           FROM pg_class c WHERE c.oid = to_regclass(?)`,
        [t, `servicedesk.${t}`],
      );
      const row = r.rows[0];
      ok(!!row && row.rls === true && row.frz === true && row.pol === true,
        `servicedesk.${t}: existe, RLS activo y FORZADO, política tenant_isolation`);
    }
    const usage = await knex.raw(`SELECT has_schema_privilege('app_runtime','servicedesk','USAGE') u`);
    ok(usage.rows[0].u === true, 'app_runtime tiene USAGE del schema (sin él: 42501, ya pasó con `budget`)');

    // ── 2. Grants exactos ───────────────────────────────────────────────────────────────────
    console.log('\n── 2. Grants por tabla: lo que cada una necesita, no más');
    for (const t of TABLAS) {
      const tiene = [];
      for (const p of TODOS) {
        const r = await knex.raw(`SELECT has_table_privilege('app_runtime', ?, ?) v`, [`servicedesk.${t}`, p]);
        if (r.rows[0].v) tiene.push(p);
      }
      const esperado = GRANTS[t];
      ok(JSON.stringify(tiene) === JSON.stringify(esperado),
        `servicedesk.${t}: app_runtime tiene ${tiene.join('+')} (esperado ${esperado.join('+')})`);
    }

    // ── 3. Semillas ─────────────────────────────────────────────────────────────────────────
    console.log('\n── 3. Semillas de arranque');
    const cola = await knex('servicedesk.queues').where({ tenant_id: T, code: 'ti' }).first();
    ok(!!cola, 'existe la cola TI');
    ok(cola && cola.responsibility_key === null,
      'la cola nace SIN responsibility_key (la clave nace en MS.3.6 con su bandeja; el candado de me-work la exigiría antes)');
    const cats = await knex('servicedesk.categories').where({ tenant_id: T, queue_id: cola.id }).orderBy('sort_order');
    ok(cats.length === 12, `12 categorías de TI sembradas (hay ${cats.length})`);
    ok(cats.filter((c) => c.requires_branch).length === 4, '4 categorías exigen sucursal (soporte, CCTV, redes, inventario)');
    const sla = Object.fromEntries((await knex('servicedesk.sla_policies').where({ tenant_id: T })).map((r) => [r.priority, r]));
    ok(sla.urgente && sla.urgente.first_response_minutes === 30 && sla.urgente.resolution_minutes === 240 && sla.urgente.clock === 'calendar',
      'Urgente: 30 min / 4 h, reloj corrido');
    ok(sla.alta && sla.alta.first_response_minutes === 120 && sla.alta.resolution_minutes === 480 && sla.alta.clock === 'business',
      'Alta: 2 h / 1 día hábil (480 min), reloj hábil');
    ok(sla.media && sla.media.first_response_minutes === 240 && sla.media.resolution_minutes === 1440,
      'Media: 4 h / 3 días hábiles (1440 min)');
    ok(sla.baja && sla.baja.first_response_minutes === 480 && sla.baja.resolution_minutes === 3360,
      'Baja: 1 día hábil / 7 días hábiles (3360 min)');
    const st = await knex('servicedesk.settings').where({ tenant_id: T }).first();
    ok(st && st.escalation_enabled === false, '⭐ el escalamiento ARRANCA APAGADO (primero el SLA mide, después escala)');
    ok(st && st.auto_close_days === 3 && st.escalate_at_pct === 80, 'auto-cierre a 3 días y aviso al 80 %');

    // Una persona real con quién probar: sin ella, los FK de abajo no se pueden medir.
    const usuario = await knex('identity.users').where({ tenant_id: T }).whereNull('deleted_at').first('id');
    if (!usuario || !cats.length) {
      console.log('  ⚠️  NO MEDIDO: no hay un usuario o categorías con qué probar el ciclo del ticket');
      fail++;
      return;
    }
    const U = usuario.id;
    const C = cats.find((c) => c.code === 'otro');

    // ── Todo lo que sigue corre dentro de UNA transacción que se revierte ───────────────────
    await knex.transaction(async (trx) => {
      let n = 0;
      const folio = () => `SRV-2099-${String(++n).padStart(5, '0')}`;
      const base = (o = {}) => ({
        tenant_id: T, folio: folio(), queue_id: cola.id, category_id: C.id,
        title: 'Smoke MS.1.6', requester_id: U, ...o,
      });
      const ins = (o) => trx('servicedesk.requests').insert(base(o)).returning('*');

      // ── 4. Folio ──────────────────────────────────────────────────────────────────────
      console.log('\n── 4. Folio SRV-AAAA-NNNNN');
      const up = () => trx.raw(
        `INSERT INTO servicedesk.request_sequences (tenant_id, year, last_number) VALUES (?, 2099, 1)
         ON CONFLICT (tenant_id, year) DO UPDATE SET last_number = servicedesk.request_sequences.last_number + 1
         RETURNING last_number`, [T]);
      const a = (await up()).rows[0].last_number;
      const b = (await up()).rows[0].last_number;
      ok(a === 1 && b === 2, `el UPSERT atómico entrega consecutivos sin colisión (${a}, ${b})`);
      ok((await codigo(trx, () => ins({ folio: 'SRV-99-1' }))) === '23514', 'NEGATIVA: un folio mal formado lo rechaza la base (23514)');
      ok((await codigo(trx, () => ins({ folio: 'srv-2099-00001' }))) === '23514', 'NEGATIVA: el folio es sensible a mayúsculas (23514)');
      const r1 = (await ins({ folio: 'SRV-2099-90001' }))[0];
      ok(!!r1 && r1.status === 'nuevo' && r1.priority === 'media' && r1.impact === 'yo' && r1.channel === 'web',
        'CONTROL: un ticket válido entra, con los defaults esperados (nuevo / media / yo / web)');
      ok((await codigo(trx, () => ins({ folio: 'SRV-2099-90001' }))) === '23505', 'NEGATIVA: el folio no se repite dentro del tenant (23505)');

      // ── 5. Máquina de estados ─────────────────────────────────────────────────────────
      console.log('\n── 5. El ticket: invariantes que la BASE hace cumplir');
      const neg = async (desc, o, esperado = '23514') => {
        const c = await codigo(trx, () => ins(o));
        ok(c === esperado, `NEGATIVA: ${desc} (${esperado}${c !== esperado ? `, dio ${c}` : ''})`);
      };
      await neg('«asignado» sin asignado', { status: 'asignado' });
      await neg('«en_proceso» sin asignado', { status: 'en_proceso' });
      await neg('asignado sin fecha de asignación', { assigned_to: U });
      await neg('fecha de asignación sin asignado', { assigned_at: new Date() });
      await neg('«en_espera» sin el reloj pausado', { status: 'en_espera' });
      await neg('reloj pausado pero el estado NO es «en_espera»', { paused_at: new Date() });
      await neg('«resuelto» sin hora de resolución', { status: 'resuelto' });
      await neg('«cerrado» sin hora de cierre ni motivo', { status: 'cerrado', resolved_at: new Date() });
      await neg('«cerrado» con motivo «cancelado»', { status: 'cerrado', resolved_at: new Date(), closed_at: new Date(), close_reason: 'cancelado' });
      await neg('«cancelado» con motivo «confirmado»', { status: 'cancelado', closed_at: new Date(), close_reason: 'confirmado' });
      await neg('«cancelado» sin motivo', { status: 'cancelado', closed_at: new Date() });
      await neg('estado inventado', { status: 'archivado' });
      await neg('prioridad inventada', { priority: 'critica' });
      await neg('prioridad sugerida inventada', { priority_suggested: 'critica' });
      await neg('impacto inventado', { impact: 'mundo' });
      await neg('canal inventado', { channel: 'paloma' });
      await neg('título vacío', { title: '   ' });
      await neg('título de más de 200 caracteres', { title: 'x'.repeat(201) });
      await neg('minutos pausados negativos', { paused_minutes: -1 });
      await neg('external_refs que no es un objeto', { external_refs: JSON.stringify([1]) });
      await neg('un solicitante que no existe en el padrón', { requester_id: '00000000-0000-0000-0000-000000000bad' }, '23503');
      await neg('asignar a alguien que no existe en el padrón', { assigned_to: '00000000-0000-0000-0000-000000000bad', assigned_at: new Date() }, '23503');

      // CONTROLES POSITIVOS: la misma fila sin el defecto SÍ entra. Sin ellos, cada rechazo de arriba
      // podría venir de una consulta rota y no del CHECK.
      const pos = async (desc, o) => {
        const c = await codigo(trx, () => ins(o));
        ok(c === null, `CONTROL: ${desc} SÍ entra${c ? ` (falló con ${c})` : ''}`);
      };
      await pos('«asignado» con asignado y fecha', { status: 'asignado', assigned_to: U, assigned_by: U, assigned_at: new Date() });
      await pos('«en_espera» con el reloj pausado', { status: 'en_espera', paused_at: new Date() });
      await pos('«resuelto» con hora de resolución', { status: 'resuelto', resolved_at: new Date() });
      await pos('«cerrado» confirmado', { status: 'cerrado', resolved_at: new Date(), closed_at: new Date(), close_reason: 'confirmado' });
      await pos('«cerrado» por auto-cierre', { status: 'cerrado', resolved_at: new Date(), closed_at: new Date(), close_reason: 'auto' });
      await pos('«cancelado» con su motivo', { status: 'cancelado', closed_at: new Date(), close_reason: 'cancelado' });
      await pos('prioridad «urgente» con impacto «red» y bloqueo', { priority: 'urgente', priority_suggested: 'urgente', impact: 'red', blocks_work: true });

      // ── 6. Hilo, adjuntos y tiempo ────────────────────────────────────────────────────
      console.log('\n── 6. Hilo, adjuntos y tiempo trabajado');
      const rid = r1.id;
      const msg = (o) => trx('servicedesk.request_messages').insert({ tenant_id: T, request_id: rid, kind: 'comment', body: 'hola', ...o }).returning('*');
      ok((await codigo(trx, () => msg({ kind: 'internal_note', visibility: 'public', body: 'secreto' }))) === '23514',
        '⭐ NEGATIVA: una NOTA INTERNA no puede ser pública (23514) — el fallo más caro de la fase');
      ok((await codigo(trx, () => msg({ kind: 'internal_note', visibility: 'internal', body: 'secreto' }))) === null,
        'CONTROL: la misma nota, interna, SÍ entra');
      ok((await codigo(trx, () => msg({ kind: 'comment', body: '   ' }))) === '23514', 'NEGATIVA: un comentario vacío (23514)');
      ok((await codigo(trx, () => msg({ kind: 'status', body: '' }))) === null, 'CONTROL: un cambio de estado puede ir sin texto (lo describe `meta`)');
      ok((await codigo(trx, () => msg({ kind: 'grito' }))) === '23514', 'NEGATIVA: un tipo de mensaje inventado (23514)');
      ok((await codigo(trx, () => msg({ visibility: 'secreta' }))) === '23514', 'NEGATIVA: una visibilidad inventada (23514)');
      ok((await codigo(trx, () => msg({ author_id: '00000000-0000-0000-0000-000000000bad' }))) === '23503', 'NEGATIVA: un autor que no existe (23503)');

      const att = (o) => trx('servicedesk.request_attachments').insert({
        tenant_id: T, request_id: rid, storage_key: 'servicedesk/x/y.pdf', file_name: 'y.pdf',
        content_type: 'application/pdf', size_bytes: 1234, ...o }).returning('*');
      ok((await codigo(trx, () => att({}))) === null, 'CONTROL: un PDF con tamaño SÍ entra');
      ok((await codigo(trx, () => att({ content_type: 'image/png' }))) === null, 'CONTROL: una imagen SÍ entra');
      ok((await codigo(trx, () => att({ content_type: 'text/html' }))) === '23514', '⭐ NEGATIVA: un HTML adjunto lo rechaza la base (23514)');
      ok((await codigo(trx, () => att({ content_type: 'application/x-msdownload' }))) === '23514', 'NEGATIVA: un ejecutable adjunto (23514)');
      ok((await codigo(trx, () => att({ size_bytes: 0 }))) === '23514', 'NEGATIVA: un adjunto de 0 bytes (23514)');
      ok((await codigo(trx, () => att({ storage_key: '  ' }))) === '23514', 'NEGATIVA: un adjunto sin llave de almacenamiento (23514)');

      const wl = (o) => trx('servicedesk.work_log').insert({ tenant_id: T, request_id: rid, user_id: U, minutes: 30, ...o }).returning('*');
      ok((await codigo(trx, () => wl({}))) === null, 'CONTROL: 30 minutos de trabajo SÍ entran');
      ok((await codigo(trx, () => wl({ minutes: 0 }))) === '23514', 'NEGATIVA: 0 minutos (23514)');
      ok((await codigo(trx, () => wl({ minutes: 1441 }))) === '23514', 'NEGATIVA: más de un día en un solo registro (23514)');
      ok((await codigo(trx, () => wl({ started_at: '2026-10-02T10:00:00Z', ended_at: '2026-10-02T09:00:00Z' }))) === '23514',
        'NEGATIVA: terminar antes de empezar (23514)');
      ok((await codigo(trx, () => wl({ source: 'excel' }))) === '23514', 'NEGATIVA: un origen de tiempo inventado (23514)');
      ok((await codigo(trx, () => wl({ source: 'bitacora', minutes: 15 }))) === null, 'CONTROL: source=bitacora está reservado y SÍ entra (unificación, MS.8)');

      // ── 7. Avisos ─────────────────────────────────────────────────────────────────────
      console.log('\n── 7. Avisos: consentimiento y entrega');
      const pref = (o) => trx('servicedesk.notification_prefs').insert({ tenant_id: T, user_id: U, ...o }).returning('*');
      ok((await codigo(trx, () => pref({ whatsapp_enabled: true }))) === '23514',
        '⭐ NEGATIVA: WhatsApp encendido SIN fecha de aceptación (23514) — el canal exige consentimiento explícito');
      ok((await codigo(trx, () => pref({ whatsapp_enabled: true, whatsapp_opt_in_at: new Date() }))) === null,
        'CONTROL: con la fecha de aceptación SÍ entra');
      ok((await codigo(trx, () => pref({}))) === null, 'CONTROL: por defecto, correo sí y WhatsApp no');

      const lg = (o) => trx('servicedesk.notification_log').insert({
        tenant_id: T, request_id: rid, recipient_id: U, event: 'creado', channel: 'email', status: 'sent', sent_at: new Date(), ...o }).returning('*');
      ok((await codigo(trx, () => lg({}))) === null, 'CONTROL: un aviso enviado, con su hora, SÍ entra');
      ok((await codigo(trx, () => lg({ sent_at: null }))) === '23514', 'NEGATIVA: «enviado» sin hora de envío (23514)');
      ok((await codigo(trx, () => lg({ status: 'failed', sent_at: null }))) === '23514', '⭐ NEGATIVA: «fallido» sin motivo (23514) — un fallo mudo no se mide');
      ok((await codigo(trx, () => lg({ status: 'failed', sent_at: null, error: 'SMTP sin configurar' }))) === null, 'CONTROL: «fallido» con su motivo SÍ entra');
      ok((await codigo(trx, () => lg({ status: 'skipped', sent_at: null }))) === '23514', 'NEGATIVA: «omitido» sin motivo (23514)');
      ok((await codigo(trx, () => lg({ channel: 'paloma' }))) === '23514', 'NEGATIVA: un canal inventado (23514)');
      // ⚠️ Estos dos primeros PERSISTEN a propósito (sin savepoint): si se revirtieran, el repetido de abajo no
      // tendría con qué chocar y la prueba saldría verde midiendo nada.
      ok((await lg({ dedup_key: 'creado:1:U', channel: 'email' })).length === 1, 'CONTROL: primer envío con clave de anti-repetición (persiste)');
      ok((await codigo(trx, () => lg({ dedup_key: 'creado:1:U', channel: 'email' }))) === '23505',
        '⭐ NEGATIVA: el MISMO aviso, al mismo destinatario, por el mismo canal, no se envía dos veces (23505)');
      ok((await codigo(trx, () => lg({ dedup_key: 'creado:1:U', channel: 'whatsapp' }))) === null,
        'CONTROL: el mismo evento por OTRO canal sí es otro aviso');
      ok((await lg({ dedup_key: 'caido:1:U', status: 'failed', sent_at: null, error: 'x' })).length === 1, 'CONTROL: un intento fallido (persiste)…');
      ok((await codigo(trx, () => lg({ dedup_key: 'caido:1:U' }))) === null,
        '… no bloquea el reintento: la anti-repetición sólo cuenta lo ENVIADO');

      // ── 8. Contacto en identity.users ─────────────────────────────────────────────────
      console.log('\n── 8. Contacto en identity.users: formato');
      const setUser = (o) => trx('identity.users').where({ id: U }).update(o);
      ok((await codigo(trx, () => setUser({ email: 'sin-arroba' }))) === '23514', 'NEGATIVA: un correo sin arroba (23514)');
      ok((await codigo(trx, () => setUser({ email: 'a b@c.com' }))) === '23514', 'NEGATIVA: un correo con espacios (23514)');
      ok((await codigo(trx, () => setUser({ email: 'persona@megadulces.com.mx' }))) === null, 'CONTROL: un correo válido SÍ entra');
      ok((await codigo(trx, () => setUser({ phone: '4491234567' }))) === '23514', '⭐ NEGATIVA: un teléfono SIN normalizar a 52XXXXXXXXXX (23514)');
      ok((await codigo(trx, () => setUser({ phone: '+524491234567' }))) === '23514', 'NEGATIVA: un teléfono con signo + (23514)');
      ok((await codigo(trx, () => setUser({ phone: '524491234567' }))) === null, 'CONTROL: el canónico 52 + 10 dígitos SÍ entra');
      ok((await codigo(trx, () => setUser({ email: null, phone: null }))) === null, 'CONTROL: ambos son opcionales (NULL)');
      const norm = await trx.raw(`SELECT public.mx_normalize_phone('449 123 4567') p`);
      ok(norm.rows[0].p === '524491234567', 'mx_normalize_phone entrega el mismo formato canónico que exige el CHECK (524491234567)');

      // ── 9. Aislamiento por tenant y permisos reales (como app_runtime) ───────────────
      console.log('\n── 9. Aislamiento por tenant y permisos REALES (SET LOCAL ROLE app_runtime)');
      const otro = '00000000-0000-0000-0000-0000000000f9';
      const comoRuntime = async (tenant, fn) => {
        await trx.raw('SET LOCAL ROLE app_runtime');
        await trx.raw(`SET LOCAL app.tenant_id = '${tenant}'`);
        // Sin `finally`: tras un error la transaccion queda abortada y un RESET ROLE ahi lanzaria 25P02, que
        // taparia el codigo real. El ROLLBACK TO SAVEPOINT de `codigo()` revierte tambien el SET LOCAL.
        const r = await fn();
        await trx.raw('RESET ROLE');
        return r;
      };
      const propias = await comoRuntime(T, async () => Number((await trx('servicedesk.requests').count('* as n'))[0].n));
      ok(propias >= 1, `CONTROL: con su propio tenant, app_runtime VE los tickets (${propias}) — el 0 de abajo es RLS, no una consulta rota`);
      const ajenas = await comoRuntime(otro, async () => Number((await trx('servicedesk.requests').count('* as n'))[0].n));
      ok(ajenas === 0, `⭐ NEGATIVA: con OTRO tenant puesto, NO ve ningún ticket (vio ${ajenas})`);
      for (const t of ['request_messages', 'request_attachments', 'work_log', 'notification_log', 'notification_prefs', 'queues']) {
        const v = await comoRuntime(otro, async () => Number((await trx(`servicedesk.${t}`).count('* as n'))[0].n));
        ok(v === 0, `NEGATIVA: servicedesk.${t} tampoco se ve desde otro tenant (vio ${v})`);
      }
      const escribeAjeno = await codigo(trx, () => comoRuntime(otro, () => trx('servicedesk.requests').insert(base({ folio: 'SRV-2099-90500' }))));
      ok(escribeAjeno === '42501', `⭐ NEGATIVA: con otro tenant puesto NO se puede ESCRIBIR un ticket del tenant real (42501, dio ${escribeAjeno})`);
      const escribePropio = await codigo(trx, () => comoRuntime(T, () => trx('servicedesk.requests').insert(base({ folio: 'SRV-2099-90501' }))));
      ok(escribePropio === null, `CONTROL: con su propio tenant el mismo INSERT SÍ entra (dio ${escribePropio})`);

      // Permisos reales: el registro no se edita ni se borra desde la API.
      const rt = (fn) => codigo(trx, () => comoRuntime(T, fn));
      ok((await rt(() => trx('servicedesk.requests').where({ id: rid }).update({ title: 'editado' }))) === null,
        'CONTROL: app_runtime SÍ puede actualizar un ticket (cambiar estado, asignar)');
      ok((await rt(() => trx('servicedesk.requests').where({ id: rid }).del())) === '42501',
        '⭐ NEGATIVA: app_runtime NO puede borrar un ticket (42501): un ticket se cancela, no se borra');
      ok((await rt(() => trx('servicedesk.request_messages').where({ request_id: rid }).update({ body: 'reescrito' }))) === '42501',
        '⭐ NEGATIVA: app_runtime NO puede editar el hilo (42501): es registro');
      ok((await rt(() => trx('servicedesk.request_messages').where({ request_id: rid }).del())) === '42501', 'NEGATIVA: ni borrarlo (42501)');
      ok((await rt(() => trx('servicedesk.work_log').where({ request_id: rid }).update({ minutes: 1 }))) === '42501', 'NEGATIVA: ni editar el tiempo trabajado (42501)');
      ok((await rt(() => trx('servicedesk.notification_log').where({ request_id: rid }).del())) === '42501', 'NEGATIVA: ni borrar el registro de avisos (42501)');
      ok((await rt(() => trx('servicedesk.request_attachments').where({ request_id: rid }).update({ file_name: 'otro.pdf' }))) === '42501', 'NEGATIVA: ni renombrar un adjunto (42501)');
      ok((await rt(() => trx('servicedesk.settings').where({ tenant_id: T }).del())) === '42501', 'NEGATIVA: los ajustes no se borran (42501)');
      ok((await rt(() => trx('servicedesk.categories').where({ id: C.id }).update({ active: true }))) === null, 'CONTROL: las categorías SÍ se editan desde pantalla');
      ok((await rt(() => trx('servicedesk.notification_prefs').where({ user_id: U }).del())) === null, 'CONTROL: las preferencias SÍ se pueden retirar');

      throw new Error('__ROLLBACK__'); // ← cero efecto real
    }).catch((e) => { if (e.message !== '__ROLLBACK__') throw e; });

    // Prueba de que el rollback fue real.
    const sobra = await knex('servicedesk.requests').where({ tenant_id: T }).where('folio', 'like', 'SRV-2099-%').count('* as n').first();
    ok(Number(sobra.n) === 0, 'rollback real: no quedó ningún ticket de prueba (SRV-2099-*)');
    const pref = await knex('identity.users').where({ tenant_id: T }).whereNotNull('phone').count('* as n').first();
    ok(Number(pref.n) === 0, 'rollback real: ningún teléfono de prueba quedó en identity.users');
  } catch (e) {
    fail++;
    console.log('\n  ✗ EXCEPCIÓN:', e.message);
  } finally {
    await knex.destroy();
    console.log(`\n${pass} ✓ / ${fail} ✗`);
    process.exit(fail ? 1 : 0);
  }
})();
