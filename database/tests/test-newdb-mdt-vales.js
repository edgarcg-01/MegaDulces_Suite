#!/usr/bin/env node
'use strict';
/**
 * `[MDT.2.3]` — El vale de servicio: el servicio REAL contra Postgres real, como `app_runtime`.
 *
 * ⛔ Regla 13: un endpoint que escribe no está probado hasta ejercerlo contra base real con el payload de
 * la pantalla. Carga `work-orders.service.ts` con ts-node; el bucket es un DOBLE (en el CI no hay S3): lo
 * real es la tabla, sus CHECK y triggers, el consecutivo, RLS, los grants y el SQL de cada camino.
 *
 *   1. Levantar: dos altas → folios N y N+1 (el consecutivo va dentro de la transacción; en MDTask era
 *      max()+1 afuera y la segunda de dos simultáneas daba 500). Sin área → 400.
 *   2. Lista y ver: quien lo pidió lo ve en «mine»; quien coordina pide «all»; alguien sin relación ni
 *      llave → 404 (no se confirma que exista).
 *   3. Tomar: quien sólo levanta → 403; quien atiende → en proceso a su nombre; otra vez → 409.
 *   4. Trabajo: quien no es el asignado → 403; el asignado → guarda.
 *   5. Completar: sin el trabajo escrito → 400; con él → completado. Ninguna firma es obligatoria (D8b).
 *   6. Firmas: PNG válido → firma; un PNG que dice ser JPEG → 400 SIN tocar el bucket; repetir el papel →
 *      409 y lo subido se borra; quitar una firma de un vale completado → 409 (y el trigger, 23514).
 *   7. Cancelar y reabrir: el solicitante no cancela un vale en proceso (403); sin motivo → 400; quien
 *      coordina cancela y reabre (vuelve en proceso porque tiene responsable); el historial lo guarda todo.
 *   8. Asignar: a alguien sin llave de vales → 400; a alguien con llave → en proceso, y Mi trabajo se lo cuenta.
 *   9. NEGATIVAS de la tabla (trigger del folio, CHECK, índice único, sin DELETE) · RLS · ROLLBACK real.
 *
 * Lo que NO mide: la capa HTTP (la guardia de las llaves la cubre `work-orders.controller.spec.ts`) ni el
 * bucket real. ⛔ No se corre con el `.env` por defecto: apunta a producción. Corre en el job `pruebas-db`.
 */
const path = require('path');
const { randomUUID } = require('crypto');
const RAIZ = path.resolve(__dirname, '..', '..');

const T = '00000000-0000-0000-0000-00000000d01c';
const OTRO_TENANT = '00000000-0000-0000-0000-0000000a1c00';
const PIDE = randomUUID();
const ATIENDE = randomUUID();
const COORD = randomUUID();
const SIN_LLAVE = randomUUID();
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
  ({ WorkOrdersService: Servicio } = require(path.join(RAIZ, 'libs/platform-core/src/lib/work-orders/work-orders.service.ts')));
  const { FUENTES_VISIBLES } = require(path.join(RAIZ, 'libs/trade/src/lib/users/me-tasks.ts'));
  fuenteMiTrabajo = FUENTES_VISIBLES.find((f) => f.fuente === 'platform.work_orders');
} catch (e) {
  console.log(`  ·  NO MEDIDO — no se pudo cargar el servicio con ts-node: ${e.message}`);
  process.exit(2);
}

const knex = require('knex')(require('../knexfile-newdb.js').development);
require('./_lib/assert-safe-target').assertSafeTarget('test-newdb-mdt-vales');

async function status(fn) {
  try { await fn(); return 200; } catch (e) { return typeof e.getStatus === 'function' ? e.getStatus() : (e.code || e.message); }
}

/** Un PNG mínimo: la firma 89 50 4E 47 es lo que mira `validarAdjunto`. */
const PNG = 'data:image/png;base64,' + Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]).toString('base64');
const PNG_QUE_DICE_JPEG = 'data:image/jpeg;base64,' + Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]).toString('base64');
const LEVANTA = { atender: false, gestionar: false };
const ATIENDE_LL = { atender: true, gestionar: false };
const COORDINA = { atender: false, gestionar: true };

(async () => {
  try {
    console.log('\n[MDT] Vale de servicio — el servicio REAL que escribe, como app_runtime\n');
    const id = (await knex.raw('SELECT system_identifier::text sid, current_database() db FROM pg_control_system()')).rows[0];
    console.log(`   base ${id.db} · system_identifier ${id.sid}`);
    if (!(await knex.raw(`SELECT to_regclass('platform.work_orders') t`)).rows[0].t) {
      noMedido('la base no tiene platform.work_orders (falta la migración 20261114094841)');
      return;
    }
    if (!(await knex.raw('SELECT 1 FROM identity.tenants WHERE id = ?', [T])).rows.length) {
      noMedido('la base no tiene el tenant mega_dulces: no hay dónde sembrar');
      return;
    }
    const hayRol = (await knex.raw(`SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime'`)).rows.length === 1;

    await knex.transaction(async (trx) => {
      // ── 0. Siembra (dueño de la base): un rol con la llave de levantar y otro sin llaves de vales ──
      await trx.raw(`SELECT set_config('app.tenant_id', ?, true)`, [T]);
      for (const [rol, perms] of [['mdt_prueba_vale_si', '{"VALE_SERVICIO_LEVANTAR": true}'], ['mdt_prueba_vale_no', '{}']]) {
        await trx.raw(`INSERT INTO identity.role_permissions (tenant_id, role_name, permissions) VALUES (?, ?, ?::jsonb)
          ON CONFLICT (tenant_id, role_name) DO UPDATE SET permissions = EXCLUDED.permissions`, [T, rol, perms]);
      }
      for (const [uid, user, rol] of [[PIDE, 'mdt_vale_pide', 'mdt_prueba_vale_si'], [ATIENDE, 'mdt_vale_atiende', 'mdt_prueba_vale_si'],
        [COORD, 'mdt_vale_coord', 'mdt_prueba_vale_si'], [SIN_LLAVE, 'mdt_vale_sin', 'mdt_prueba_vale_no']]) {
        await trx.raw(`INSERT INTO identity.users (id, tenant_id, username, nombre, role_name, activo, password_hash, status, kind)
          VALUES (?, ?, ?, ?, ?, true, 'prueba-sin-login', 'active', 'interno')`, [uid, T, user, 'Prueba ' + user, rol]);
      }

      if (hayRol) await trx.raw('SET LOCAL ROLE app_runtime');
      await trx.raw(`SELECT set_config('app.tenant_id', ?, true)`, [T]);

      let yo = PIDE;
      const bucket = { subidas: 0, borradas: 0 };
      const s = Object.create(Servicio.prototype);
      Object.assign(s, {
        logger: { log: nada, warn: nada, error: nada, debug: nada },
        tenantCtx: { requireTenantId: () => T, get: () => ({ tenantId: T, userId: yo }) },
        storage: {
          putBuffer: async (_b, _t, carpeta) => { bucket.subidas++; return { key: `${carpeta}/${randomUUID()}.png` }; },
          signedUrl: async (k) => `https://bucket.prueba/${k}`,
          remove: async () => { bucket.borradas++; },
        },
        tk: { run: async (fn) => {
          await trx.raw('SAVEPOINT sp_vale');
          try { const r = await fn(trx); await trx.raw('RELEASE SAVEPOINT sp_vale'); return r; }
          catch (e) { await trx.raw('ROLLBACK TO SAVEPOINT sp_vale'); throw e; }
        } },
      });

      // ── 1. Levantar (payload de la pantalla) ──
      ok(await status(() => s.crear({ requesting_area: ' ', activity: 'x' }, LEVANTA)) === 400, 'levantar sin área → 400');
      const v1 = await s.crear({ requesting_area: 'Sucursal de prueba', activity: 'Fuga en el baño', location_detail: 'Baño de personal' }, LEVANTA);
      const v2 = await s.crear({ requesting_area: 'Sucursal de prueba', activity: 'Cambiar la chapa del almacén' }, LEVANTA);
      ok(v1.status === 'open' && v1.requested_by === PIDE && v1.requester_name === 'Prueba mdt_vale_pide', 'levantar → abierto, a nombre de quien lo pidió', v1.status);
      ok(v2.folio === v1.folio + 1, 'dos altas → folios consecutivos N y N+1 (consecutivo dentro de la transacción)', [v1.folio, v2.folio]);
      ok(v1.eventos.length === 1 && v1.eventos[0].kind === 'created', 'el historial nace con «created»', v1.eventos.map((e) => e.kind));

      // ── 2. Lista y ver ──
      const mias = await s.lista(LEVANTA, 'all');
      ok(mias.scope === 'mine' && mias.vales.some((x) => x.id === v1.id), 'quien sólo levanta pide «all» y recibe «mine», con lo suyo', mias.scope);
      yo = COORD;
      const todas = await s.lista(COORDINA, 'all');
      ok(todas.scope === 'all' && todas.vales.some((x) => x.id === v2.id) && typeof todas.has_more === 'boolean', 'quien coordina ve todos y la lista declara si se topó');
      yo = SIN_LLAVE;
      ok(await status(() => s.detalle(v1.id, LEVANTA)) === 404, 'alguien sin relación ni llave de atender → 404');

      // ── 3. Tomar ──
      yo = PIDE;
      ok(await status(() => s.tomar(v1.id, LEVANTA)) === 403, 'quien sólo levanta no toma → 403');
      yo = ATIENDE;
      const t1 = await s.tomar(v1.id, ATIENDE_LL);
      ok(t1.status === 'in_progress' && t1.assigned_to === ATIENDE && t1.started_at, 'tomar → en proceso, a mi nombre, con inicio', t1.status);
      ok(await status(() => s.tomar(v1.id, ATIENDE_LL)) === 409, 'tomar otra vez → 409 (ya no está abierto)');

      // ── 4. Trabajo ──
      yo = PIDE;
      ok(await status(() => s.guardarTrabajo(v1.id, { work_detail: 'yo no' }, LEVANTA)) === 403, 'quien no es el asignado no captura el trabajo → 403');
      yo = ATIENDE;
      const g1 = await s.guardarTrabajo(v1.id, { materials_used: 'Cinta teflón', needs_follow_up: false }, ATIENDE_LL);
      ok(g1.materials_used === 'Cinta teflón' && g1.needs_follow_up === false, 'el asignado guarda materiales y seguimiento', g1.materials_used);

      // ── 5. Completar ──
      yo = ATIENDE;
      await s.tomar(v2.id, ATIENDE_LL);
      ok(await status(() => s.completar(v2.id, {}, ATIENDE_LL)) === 400, 'completar sin el trabajo escrito → 400');
      const c2 = await s.completar(v2.id, { work_detail: 'Se cambió la chapa y se probaron las dos llaves' }, ATIENDE_LL);
      ok(c2.status === 'completed' && c2.completed_at && c2.firmas === 0, 'con el trabajo → completado, SIN firmas (D8b: ninguna obligatoria)', c2.status);

      // ── 6. Firmas ──
      const antes = bucket.subidas;
      ok(await status(() => s.firmar(v2.id, { role: 'performed', signer_name: 'Técnico', image_base64: PNG_QUE_DICE_JPEG }, ATIENDE_LL)) === 400
        && bucket.subidas === antes, 'un PNG que dice ser JPEG → 400 SIN tocar el bucket');
      const f2 = await s.firmar(v2.id, { role: 'performed', signer_name: 'Técnico de prueba', image_base64: PNG }, ATIENDE_LL);
      ok(f2.firmas_detalle.length === 1 && f2.firmas_detalle[0].role === 'performed' && f2.firmas_detalle[0].url, 'firma «realizado» → guardada, con su URL firmada');
      const borradasAntes = bucket.borradas;
      ok(await status(() => s.firmar(v2.id, { role: 'performed', signer_name: 'Otra vez', image_base64: PNG }, ATIENDE_LL)) === 409
        && bucket.borradas === borradasAntes + 1, 'repetir el papel → 409 y lo subido se borra del bucket');
      ok(await status(() => s.quitarFirma(v2.id, f2.firmas_detalle[0].id, ATIENDE_LL)) === 409, 'quitar una firma de un vale completado → 409');
      ok(await status(() => s.tk.run((k) => k('platform.work_order_signatures').where({ id: f2.firmas_detalle[0].id })
        .update({ deleted_at: k.fn.now(), deleted_by: ATIENDE }))) === '23514', 'NEGATIVA: el trigger tampoco deja quitarla por SQL (23514)');

      // ── 7. Cancelar y reabrir ──
      yo = PIDE;
      ok(await status(() => s.cancelar(v1.id, { reason: 'ya no' }, LEVANTA)) === 403, 'el solicitante no cancela un vale EN PROCESO → 403');
      yo = COORD;
      ok(await status(() => s.cancelar(v1.id, {}, COORDINA)) === 400, 'cancelar sin motivo → 400');
      const x1 = await s.cancelar(v1.id, { reason: 'Lo resolvió el proveedor' }, COORDINA);
      ok(x1.status === 'cancelled' && x1.cancel_reason === 'Lo resolvió el proveedor', 'quien coordina cancela con motivo', x1.status);
      ok(await status(() => s.reabrir(v1.id, {}, COORDINA)) === 400, 'reabrir sin motivo → 400');
      const r1 = await s.reabrir(v1.id, { reason: 'Volvió la fuga' }, COORDINA);
      ok(r1.status === 'in_progress' && r1.assigned_to === ATIENDE && !r1.cancelled_at, 'reabrir → en proceso (tiene responsable), sin rastro del cierre en la fila', r1.status);
      const kinds = r1.eventos.map((e) => e.kind);
      ok(['created', 'taken', 'updated', 'cancelled', 'reopened'].every((k) => kinds.includes(k)) && r1.eventos.find((e) => e.kind === 'cancelled').note === 'Lo resolvió el proveedor',
        'el historial guarda todo, incluido el motivo de la cancelación', kinds);

      // ── 8. Asignar ──
      yo = PIDE;
      const v3 = await s.crear({ requesting_area: 'Oficina', activity: 'Revisar el aire acondicionado' }, LEVANTA);
      yo = COORD;
      ok(await status(() => s.asignar(v3.id, { user_id: SIN_LLAVE }, COORDINA)) === 400, 'asignar a alguien sin llave de vales → 400 (no podría abrirlo)');
      const a3 = await s.asignar(v3.id, { user_id: PIDE }, COORDINA);
      ok(a3.status === 'in_progress' && a3.assigned_to === PIDE && a3.assignee_name === 'Prueba mdt_vale_pide', 'asignar → en proceso a nombre de esa persona', a3.status);
      if (fuenteMiTrabajo) {
        const m = await fuenteMiTrabajo.medir(trx, T, PIDE);
        ok(m.total === 1 && m.vence_at === null, 'Mi trabajo le cuenta 1 vale a su nombre, sin vencimiento inventado', m);
      } else noMedido('Mi trabajo no tiene la fuente platform.work_orders');

      // ── 9. NEGATIVAS de la tabla ──
      ok(await status(() => s.tk.run((k) => k('platform.work_orders').where({ id: v3.id }).update({ folio: 999999 }))) === '23514',
        'NEGATIVA: el folio no cambia (trigger)');
      const fila = { tenant_id: T, requesting_area: 'x', activity: 'x', requester_name: 'x' };
      ok(await status(() => s.tk.run((k) => k('platform.work_orders').insert({ ...fila, folio: 990001, status: 'completed', completed_at: k.fn.now(), assigned_to: ATIENDE, assigned_at: k.fn.now(), started_at: k.fn.now() }))) === '23514',
        'NEGATIVA: completado sin el trabajo escrito no entra (CHECK)');
      ok(await status(() => s.tk.run((k) => k('platform.work_orders').insert({ ...fila, folio: 990002, status: 'open', assigned_to: ATIENDE, assigned_at: k.fn.now() }))) === '23514',
        'NEGATIVA: abierto con responsable no entra (CHECK)');
      ok(await status(() => s.tk.run((k) => k('platform.work_orders').insert({ ...fila, folio: v1.folio }))) === '23505',
        'NEGATIVA: un folio repetido no entra (índice único)');
      if (hayRol) {
        ok(await status(() => s.tk.run((k) => k('platform.work_orders').where({ id: v3.id }).del())) === '42501',
          'NEGATIVA: app_runtime no borra un vale (se cancela)');
      } else noMedido('sin el rol app_runtime no se mide el grant sin DELETE');

      // ── RLS ──
      await trx.raw(`SELECT set_config('app.tenant_id', ?, true)`, [OTRO_TENANT]);
      const otro = (await trx.raw(`SELECT count(*)::int n FROM platform.work_orders WHERE id = ANY(?::uuid[])`, [[v1.id, v2.id, v3.id]])).rows[0].n;
      if (hayRol) ok(otro === 0, 'RLS: otro tenant no ve ningún vale', otro);
      else noMedido('sin el rol app_runtime (superusuario) RLS no aplica: no se mide');

      throw Object.assign(new Error('rollback'), { esRollback: true });
    }).catch((e) => { if (!e.esRollback) throw e; });

    const quedaron = (await knex.raw(`SELECT count(*)::int n FROM identity.users WHERE username LIKE 'mdt_vale_%'`)).rows[0].n;
    ok(quedaron === 0, 'ROLLBACK real: no quedó ninguna persona ni vale de la prueba');
  } catch (e) {
    fail++;
    console.log('  ✗ error inesperado:', e.message);
  } finally {
    await knex.destroy();
    console.log(`\n  ${pass} ✓ · ${fail} ✗ · ${nm} no medido`);
    process.exit(fail ? 1 : (pass ? 0 : 2));
  }
})();
