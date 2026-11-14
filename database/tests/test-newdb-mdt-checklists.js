#!/usr/bin/env node
'use strict';
/**
 * `[MDT.2.1]`–`[MDT.2.5]` — El motor de checklist (tareas por puesto): el servicio REAL contra Postgres
 * real, como `app_runtime`.
 *
 * ⛔ Regla 13: un endpoint que escribe no está probado hasta ejercerlo contra base real con el payload
 * de la pantalla. Carga `checklists.service.ts` con ts-node; el bucket es un DOBLE (en el CI no hay S3):
 * lo real es la tabla, sus CHECK, sus índices únicos, RLS, los grants y el SQL de cada camino.
 *
 *   1. Mis tareas: se DERIVAN de la norma (diaria sí, semanal de otro día no, otro puesto no).
 *   2. Abrir: crea la entrega con su versión y vencimiento; abrir otra vez devuelve LA MISMA (idempotente).
 *      Fecha futura → 400 · más de 7 días atrás → 400 · tarea de otro puesto → 404 · semanal fuera de su día → 400.
 *   3. Guardar punto: texto en blanco no es evidencia; texto real sí (hecho + sello del servidor).
 *   4. Evidencia: foto válida → archivo + hecho. Foto en un punto escrito → 400 SIN tocar el bucket.
 *      PDF en un punto que sólo acepta foto → 400. Un PNG que dice ser JPEG → 400.
 *   5. Entregar: con puntos sin evidencia y sin nota → 400; con nota → entregada, lo que falta queda
 *      JUSTIFICADO (no hecho). Después ya no se escribe (409).
 *   6. Ver: otra persona → 404; el jefe de su cadena y sucursal → sí; el jefe NO ve a quien está en otra sucursal.
 *   7. Equipo: la gente de la cadena y la sucursal del jefe, con su avance.
 *   8. Norma: versión hacia atrás → 400; versión nueva → 2, y la entrega ya abierta SIGUE con la 1.
 *   9. Mi trabajo: la fuente `platform.checklist_runs` cuenta lo pendiente DERIVADO (sin fila emitida).
 *  10. NEGATIVAS de la tabla (CHECK e índices) · RLS de otro tenant · ROLLBACK real.
 *
 * Lo que NO mide: la capa HTTP (guardia de las llaves: la cubre `checklists.controller.spec.ts`) ni el
 * bucket real. ⛔ No se corre con el `.env` por defecto: apunta a producción. Corre en el job `pruebas-db`.
 */
const path = require('path');
const { randomUUID } = require('crypto');
const RAIZ = path.resolve(__dirname, '..', '..');

const T = '00000000-0000-0000-0000-00000000d01c';
const OTRO_TENANT = '00000000-0000-0000-0000-0000000a1c00';
const ME = randomUUID();
const OTRA = randomUUID();
const LEJOS = randomUUID();
const JEFE = randomUUID();
const PUESTO = 'mdt_prueba_puesto';
const PUESTO_JEFE = 'mdt_prueba_jefe';
const OTRO_PUESTO = 'mdt_prueba_otro';
let pass = 0, fail = 0, nm = 0;
const nada = () => undefined;
const ok = (c, m, extra) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m, extra !== undefined ? JSON.stringify(extra) : ''); } };
const noMedido = (m) => { nm++; console.log('  ·  NO MEDIDO —', m); };

let Servicio;
let fuenteMiTrabajo;
process.env.JWT_SECRET = process.env.JWT_SECRET || `prueba-local-mdt-${'x'.repeat(40)}`;
try {
  require('ts-node').register({ transpileOnly: true, skipProject: true,
    compilerOptions: { module: 'commonjs', moduleResolution: 'node', target: 'es2021', experimentalDecorators: true, emitDecoratorMetadata: true, ignoreDeprecations: '6.0' } });
  const tsc = require('typescript');
  const base = tsc.readConfigFile(path.join(RAIZ, 'tsconfig.base.json'), tsc.sys.readFile).config;
  require('tsconfig-paths').register({ baseUrl: RAIZ, paths: base.compilerOptions.paths });
  require('reflect-metadata');
  ({ ChecklistsService: Servicio } = require(path.join(RAIZ, 'libs/platform-core/src/lib/checklists/checklists.service.ts')));
  const { FUENTES_VISIBLES } = require(path.join(RAIZ, 'libs/trade/src/lib/users/me-tasks.ts'));
  fuenteMiTrabajo = FUENTES_VISIBLES.find((f) => f.fuente === 'platform.checklist_runs');
} catch (e) {
  console.log(`  ·  NO MEDIDO — no se pudo cargar el servicio con ts-node: ${e.message}`);
  process.exit(2);
}

const knex = require('knex')(require('../knexfile-newdb.js').development);
require('./_lib/assert-safe-target').assertSafeTarget('test-newdb-mdt-checklists');

async function status(fn) {
  try { await fn(); return 200; } catch (e) { return typeof e.getStatus === 'function' ? e.getStatus() : (e.code || e.message); }
}

/** Un JPEG mínimo: la firma FF D8 FF es lo que mira `validarAdjunto`. */
const JPEG = 'data:image/jpeg;base64,' + Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0xff, 0xd9]).toString('base64');
const PDF = 'data:application/pdf;base64,' + Buffer.from('%PDF-1.4\n%prueba\n').toString('base64');
const PNG_QUE_DICE_JPEG = 'data:image/jpeg;base64,' + Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]).toString('base64');

const PUNTOS = [
  { id: 'p0', label: 'Pasillos libres', block: null, evidence: 'photos', accepts_documents: false, requires_amount: false, requires_folio: false, requires_comment: false },
  { id: 'p1', label: 'Ausencias cubiertas', block: null, evidence: 'text', accepts_documents: false, requires_amount: false, requires_folio: false, requires_comment: false },
  { id: 'p2', label: 'Pendientes del turno', block: 'Cierre', evidence: 'list', accepts_documents: false, requires_amount: false, requires_folio: false, requires_comment: false },
];

(async () => {
  try {
    console.log('\n[MDT] Motor de checklist — el servicio REAL que escribe, como app_runtime\n');
    const id = (await knex.raw('SELECT system_identifier::text sid, current_database() db FROM pg_control_system()')).rows[0];
    console.log(`   base ${id.db} · system_identifier ${id.sid}`);
    if (!(await knex.raw(`SELECT to_regclass('platform.checklist_runs') t`)).rows[0].t) {
      noMedido('la base no tiene platform.checklist_runs (falta la migración 20261113175536)');
      return;
    }
    if (!(await knex.raw('SELECT 1 FROM identity.tenants WHERE id = ?', [T])).rows.length) {
      noMedido('la base no tiene el tenant mega_dulces: no hay dónde sembrar');
      return;
    }
    const hayRol = (await knex.raw(`SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime'`)).rows.length === 1;
    const hoy = (await knex.raw(`SELECT to_char((now() AT TIME ZONE 'America/Mexico_City')::date, 'YYYY-MM-DD') h`)).rows[0].h;
    const dow = (await knex.raw(`SELECT EXTRACT(ISODOW FROM (now() AT TIME ZONE 'America/Mexico_City'))::int d`)).rows[0].d;
    const otroDia = (dow % 7) + 1; // un día de la semana que NO es hoy

    await knex.transaction(async (trx) => {
      // ── 0. Siembra (dueño de la base): puestos, personas, dos plantillas y una de otro puesto ──
      await trx.raw(`SELECT set_config('app.tenant_id', ?, true)`, [T]);
      // `identity.users.role_name` es FK a `role_permissions`: un rol propio, para no depender de la siembra.
      await trx.raw(`INSERT INTO identity.role_permissions (tenant_id, role_name, permissions)
        VALUES (?, 'mdt_prueba', '{"TAREAS_PUESTO_ENTREGAR": true}'::jsonb)
        ON CONFLICT (tenant_id, role_name) DO UPDATE SET permissions = EXCLUDED.permissions`, [T]);
      for (const [code, jefe] of [[PUESTO_JEFE, null], [PUESTO, PUESTO_JEFE], [OTRO_PUESTO, null]]) {
        await trx.raw(`INSERT INTO identity.positions (tenant_id, code, name, reports_to_position_code)
          VALUES (?, ?, ?, ?) ON CONFLICT (tenant_id, code) DO NOTHING`, [T, code, 'Prueba ' + code, jefe]);
      }
      for (const [uid, user, puesto, suc] of [[ME, 'mdt_me', PUESTO, '01'], [OTRA, 'mdt_otra', PUESTO, '01'],
        [LEJOS, 'mdt_lejos', PUESTO, '02'], [JEFE, 'mdt_jefe', PUESTO_JEFE, '01']]) {
        await trx.raw(`INSERT INTO identity.users (id, tenant_id, username, nombre, role_name, activo, password_hash, status, kind, position_code, warehouse_code)
          VALUES (?, ?, ?, ?, 'mdt_prueba', true, 'prueba-sin-login', 'active', 'interno', ?, ?)`, [uid, T, user, 'Prueba ' + user, puesto, suc]);
      }
      const tpl = async (key, frequency, weekday, puesto) => {
        const { rows: [t] } = await trx.raw(`INSERT INTO platform.checklist_templates (tenant_id, key, domain, name, moment, frequency, weekday, document_title)
          VALUES (?, ?, 'manual_puesto', ?, 'cierre', ?, ?, 'Manual de prueba') RETURNING id`, [T, key, 'Tarea ' + key, frequency, weekday]);
        await trx.raw(`INSERT INTO platform.checklist_template_versions (tenant_id, template_id, version, valid_from, items, change_note)
          VALUES (?, ?, 1, DATE '2026-01-01', ?::jsonb, 'prueba')`, [T, t.id, JSON.stringify(PUNTOS)]);
        await trx.raw(`INSERT INTO platform.checklist_template_positions (tenant_id, template_id, position_code) VALUES (?, ?, ?)`, [T, t.id, puesto]);
        return t.id;
      };
      const DIARIA = await tpl('mdtprueba.diaria', 'daily', null, PUESTO);
      const SEMANAL = await tpl('mdtprueba.semanal', 'weekly', otroDia, PUESTO);
      const AJENA = await tpl('mdtprueba.ajena', 'daily', null, OTRO_PUESTO);

      if (hayRol) await trx.raw('SET LOCAL ROLE app_runtime');
      await trx.raw(`SELECT set_config('app.tenant_id', ?, true)`, [T]);

      let yo = ME;
      const bucket = { subidas: 0, borradas: 0 };
      const s = Object.create(Servicio.prototype);
      Object.assign(s, {
        logger: { log: nada, warn: nada, error: nada, debug: nada },
        tenantCtx: { requireTenantId: () => T, get: () => ({ tenantId: T, userId: yo }) },
        storage: {
          putBuffer: async (_b, _t, carpeta) => { bucket.subidas++; return { key: `${carpeta}/${randomUUID()}.jpg` }; },
          signedUrl: async (k) => `https://bucket.prueba/${k}`,
          remove: async () => { bucket.borradas++; },
        },
        tk: { run: async (fn) => {
          await trx.raw('SAVEPOINT sp_mdt');
          try { const r = await fn(trx); await trx.raw('RELEASE SAVEPOINT sp_mdt'); return r; }
          catch (e) { await trx.raw('ROLLBACK TO SAVEPOINT sp_mdt'); throw e; }
        } },
      });

      // ── 1. Mis tareas, derivadas ──
      const mias = await s.misTareas();
      const keys = mias.tareas.map((t) => t.key);
      ok(mias.position_code === PUESTO && keys.includes('mdtprueba.diaria'), 'mis tareas: la diaria de mi puesto aparece SIN que nadie la emita', keys);
      ok(!keys.includes('mdtprueba.semanal'), 'mis tareas: la semanal de otro día no aparece', keys);
      ok(!keys.includes('mdtprueba.ajena'), 'mis tareas: la de otro puesto no aparece', keys);
      ok(mias.tareas.find((t) => t.key === 'mdtprueba.diaria')?.estado === 'pendiente' && mias.tareas[0]?.run_id === null,
        'mis tareas: sin abrir = pendiente, sin fila', mias.tareas[0]);

      // ── 9. Mi trabajo: cuenta lo pendiente DERIVADO ──
      if (!fuenteMiTrabajo) noMedido('la fuente platform.checklist_runs no está en FUENTES_VISIBLES');
      else {
        const m = await fuenteMiTrabajo.medir(trx, T, OTRA);
        ok(m.total === 1 && m.vence_at !== null && m.vencidas !== null, 'Mi trabajo: 1 pendiente derivado para quien no abrió nada', m);
      }

      // ── 2. Abrir ──
      const pantalla = { template_id: DIARIA, period_date: hoy };
      const a = await s.abrir(pantalla);
      ok(a.status === 'in_progress' && a.version === 1 && a.editable === true && a.puntos.length === 3,
        'abrir: entrega en proceso, versión 1, editable, 3 puntos', { status: a.status, version: a.version, puntos: a.puntos.length });
      const fila = await trx('platform.checklist_runs').where({ id: a.id }).first();
      ok(fila.assigned_to === ME && fila.assigned_by === null && fila.position_code === PUESTO && fila.warehouse_code === '01',
        'abrir: assigned_to = yo, assigned_by NULL (la asignó la norma), puesto y sucursal sellados', fila);
      ok((await s.abrir(pantalla)).id === a.id, 'abrir otra vez devuelve LA MISMA entrega (idempotente)');
      ok(await status(() => s.abrir({ template_id: DIARIA, period_date: '2999-01-01' })) === 400, 'abrir: fecha futura → 400');
      ok(await status(() => s.abrir({ template_id: DIARIA, period_date: '2020-01-01' })) === 400, 'abrir: más de 7 días atrás → 400');
      ok(await status(() => s.abrir({ template_id: AJENA, period_date: hoy })) === 404, 'abrir: tarea de otro puesto → 404');
      ok(await status(() => s.abrir({ template_id: SEMANAL, period_date: hoy })) === 400, 'abrir: semanal fuera de su día → 400');

      // ── 3. Guardar punto ──
      let d = await s.guardarPunto(a.id, 'p1', { text: '   ' });
      ok(d.puntos.find((p) => p.id === 'p1').estado === 'no_ejecutado', 'texto en blanco NO es evidencia');
      d = await s.guardarPunto(a.id, 'p1', { text: 'Cubrió Ana el turno' });
      const p1 = d.puntos.find((p) => p.id === 'p1');
      ok(p1.estado === 'hecho' && !!p1.respuesta.done_at, 'texto real → hecho, con sello del servidor', p1.respuesta);
      ok(await status(() => s.guardarPunto(a.id, 'p9', { text: 'x' })) === 404, 'punto que no está en la norma → 404');

      // ── 4. Evidencia ──
      d = await s.subirEvidencia(a.id, 'p0', { file_base64: JPEG, file_name: 'pasillo.jpg' });
      const p0 = d.puntos.find((p) => p.id === 'p0');
      ok(p0.estado === 'hecho' && p0.archivos.length === 1 && p0.archivos[0].url.startsWith('https://') && bucket.subidas === 1,
        'foto válida → archivo con URL firmada y punto hecho', { estado: p0.estado, archivos: p0.archivos.length, subidas: bucket.subidas });
      const archivo = await trx('platform.checklist_run_files').where({ run_id: a.id }).first();
      ok(archivo && archivo.mime === 'image/jpeg' && archivo.uploaded_by === ME && !/^https?:/.test(archivo.storage_key),
        'el archivo guarda la LLAVE (no la URL) y el tipo detectado', archivo);
      ok(await status(() => s.subirEvidencia(a.id, 'p1', { file_base64: JPEG })) === 400 && bucket.subidas === 1,
        'foto en un punto escrito → 400 SIN tocar el bucket');
      ok(await status(() => s.subirEvidencia(a.id, 'p0', { file_base64: PDF })) === 400, 'PDF en un punto que sólo acepta foto → 400');
      ok(await status(() => s.subirEvidencia(a.id, 'p0', { file_base64: PNG_QUE_DICE_JPEG })) === 400, 'un PNG que dice ser JPEG → 400 (firma)');

      // ── 6. Ver: otra persona no; el jefe de su cadena y sucursal sí ──
      yo = OTRA;
      ok(await status(() => s.detalle(a.id, false)) === 404, 'otra persona sin llave de equipo → 404');
      ok(await status(() => s.guardarPunto(a.id, 'p1', { text: 'yo' })) === 403, 'otra persona no escribe en mi entrega → 403');
      yo = LEJOS;
      const lejana = await s.abrir({ template_id: DIARIA, period_date: hoy });
      yo = JEFE;
      const vistaJefe = await s.detalle(a.id, true);
      ok(vistaJefe.id === a.id && vistaJefe.editable === false, 'el jefe de mi cadena y sucursal la ve, en sólo lectura');
      ok(await status(() => s.detalle(lejana.id, true)) === 404, 'el jefe NO ve a quien está en otra sucursal → 404');
      ok(await status(() => s.detalle(a.id, false)) === 404, 'el jefe sin la llave de equipo → 404');

      // ── 7. Equipo ──
      const eq = await s.equipo();
      const ids = eq.personas.map((p) => p.user_id);
      ok(ids.includes(ME) && ids.includes(OTRA) && !ids.includes(LEJOS) && !ids.includes(JEFE),
        'equipo: mi cadena y mi sucursal; ni otra sucursal ni yo mismo', ids.length);
      const yoEnEquipo = eq.personas.find((p) => p.user_id === ME);
      ok(yoEnEquipo && yoEnEquipo.en_proceso === 1 && yoEnEquipo.puntos.hechos === 2 && yoEnEquipo.detalle.length === 1,
        'equipo: el avance de la persona sale de su entrega', yoEnEquipo);

      // ── 5. Entregar ──
      yo = ME;
      ok(await status(() => s.entregar(a.id, {})) === 400, 'entregar con un punto sin evidencia y sin nota → 400');
      d = await s.entregar(a.id, { employee_note: 'No hubo pendientes que anotar' });
      ok(d.status === 'submitted' && d.submitted_at && typeof d.submitted_late === 'boolean', 'entregar con nota → entregada, con sello y si fue tarde', d.status);
      ok(d.avance.hechos === 2 && d.avance.justificados === 1 && d.avance.sin_ejecutar === 0,
        'lo que faltaba queda JUSTIFICADO, no hecho', d.avance);
      ok(await status(() => s.guardarPunto(a.id, 'p2', { list: ['x'] })) === 409, 'entregada: ya no se escribe → 409');
      ok(await status(() => s.subirEvidencia(a.id, 'p0', { file_base64: JPEG })) === 409, 'entregada: ya no se sube evidencia → 409');

      // ── 8. Norma ──
      ok(await status(() => s.nuevaVersion(DIARIA, { items: PUNTOS, change_note: 'hacia atrás', valid_from: '2026-01-02' })) === 400,
        'versión con vigencia en el pasado → 400');
      ok(await status(() => s.nuevaVersion(DIARIA, { items: [], change_note: 'vacía' })) === 400, 'versión sin puntos → 400');
      const v2 = await s.nuevaVersion(DIARIA, { items: [...PUNTOS, { ...PUNTOS[0], id: 'p3', label: 'Luces apagadas' }], change_note: 'agrega un punto' });
      ok(v2.version === 2 && v2.puntos.length === 4, 'versión nueva → 2, con el punto agregado', { version: v2.version });
      ok((await s.detalle(a.id, false)).version === 1, 'la entrega ya hecha SIGUE con la versión 1');

      // ── 8b. La hora límite es parte de la norma y se versiona (MDT.3.2b · MDT.UI.1) ──
      const horaMx = (iso) => new Date(iso).toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'America/Mexico_City' });
      const venceAntes = (await s.detalle(a.id, false)).due_at;
      ok(await status(() => s.nuevaVersion(DIARIA, { items: PUNTOS, change_note: 'mal escrita', due_time: '25:00' })) === 400, 'hora límite inválida → 400');
      ok(await status(() => s.nuevaVersion(DIARIA, { items: PUNTOS, change_note: 'antes de empezar', due_time: '05:30' })) === 400,
        'hora límite antes del inicio del día de la tarea (06:00) → 400');
      const v3 = await s.nuevaVersion(DIARIA, { items: PUNTOS, change_note: 'la apertura se revisa a las 10', due_time: '10:00' });
      ok(v3.version === 3 && v3.due_time === '10:00' && v3.change_note === 'la apertura se revisa a las 10',
        'versión con hora → la norma dice 10:00 y su motivo', { version: v3.version, due_time: v3.due_time });
      const v4 = await s.nuevaVersion(DIARIA, { items: PUNTOS, change_note: 'sólo cambian los puntos' });
      ok(v4.version === 4 && v4.due_time === '10:00', 'una versión SIN hora conserva la que regía (no regresa a 23:00)', v4.due_time);
      ok((await s.detalle(a.id, false)).due_at === venceAntes, 'la entrega ya abierta conserva su hora límite');
      yo = OTRA; // nunca abrió la diaria: su tarea de hoy se DERIVA con la hora nueva
      const deOtra = (await s.misTareas()).tareas.find((t) => t.template_id === DIARIA);
      ok(deOtra && horaMx(deOtra.due_at) === '10:00', 'la tarea derivada de hoy vence a las 10:00', deOtra && horaMx(deOtra.due_at));
      yo = ME;

      // ── 10. NEGATIVAS de la tabla ──
      const run = { tenant_id: T, template_id: DIARIA, version_id: fila.version_id, assigned_to: OTRA, assigned_at: new Date(), due_at: new Date() };
      ok(await status(() => s.tk.run((k) => k('platform.checklist_runs').insert({ ...run, period_date: '2026-01-05', status: 'submitted' }))) === '23514',
        'NEGATIVA: entregada sin submitted_at no entra (CHECK)');
      ok(await status(() => s.tk.run((k) => k('platform.checklist_runs').insert({ ...run, assigned_to: ME, period_date: hoy }))) === '23505',
        'NEGATIVA: dos entregas de la misma tarea, persona y día no entran (índice único)');
      ok(await status(() => s.tk.run((k) => k('platform.checklist_runs').insert({ ...run, template_id: SEMANAL, period_date: '2026-01-06' }))) === '23503',
        'NEGATIVA: una versión de OTRA plantilla no entra (FK compuesta)');
      ok(await status(() => s.tk.run((k) => k('platform.checklist_templates').insert({ tenant_id: T, key: 'mdtprueba.mala', domain: 'manual_puesto', name: 'x', frequency: 'weekly' }))) === '23514',
        'NEGATIVA: semanal sin día de la semana no entra (CHECK)');
      ok(await status(() => s.tk.run((k) => k('platform.checklist_template_versions').insert({ tenant_id: T, template_id: AJENA, version: 2, valid_from: '2026-01-01', items: '[]', change_note: 'x' }))) === '23514',
        'NEGATIVA: una versión sin puntos no entra (CHECK)');
      if (hayRol) {
        ok(await status(() => s.tk.run((k) => k('platform.checklist_template_versions').where({ template_id: DIARIA }).update({ change_note: 'pisada' }))) === '42501',
          'NEGATIVA: app_runtime no puede reescribir una versión (registro: sólo INSERT)');
      } else noMedido('sin el rol app_runtime no se mide el grant de sólo-INSERT de las versiones');

      // ── RLS ──
      await trx.raw(`SELECT set_config('app.tenant_id', ?, true)`, [OTRO_TENANT]);
      const otro = (await trx.raw(`SELECT count(*)::int n FROM platform.checklist_runs WHERE template_id = ?`, [DIARIA])).rows[0].n;
      if (hayRol) ok(otro === 0, 'RLS: otro tenant no ve ninguna entrega', otro);
      else noMedido('sin el rol app_runtime (superusuario) RLS no aplica: no se mide');

      throw Object.assign(new Error('rollback'), { esRollback: true });
    }).catch((e) => { if (!e.esRollback) throw e; });

    const quedaron = (await knex.raw(`SELECT count(*)::int n FROM platform.checklist_templates WHERE key LIKE 'mdtprueba.%'`)).rows[0].n;
    ok(quedaron === 0, 'ROLLBACK real: no quedó ninguna plantilla de la prueba');
  } catch (e) {
    fail++;
    console.log('  ✗ error inesperado:', e.message);
  } finally {
    await knex.destroy();
    console.log(`\n  ${pass} ✓ · ${fail} ✗ · ${nm} no medido`);
    process.exit(fail ? 1 : (pass ? 0 : 2));
  }
})();
