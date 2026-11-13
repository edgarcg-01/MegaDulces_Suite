#!/usr/bin/env node
'use strict';
/**
 * `[PQ.110]` — Cancelar OC desde la Suite: el servicio REAL contra Postgres real, como `app_runtime`.
 *
 * ⛔ Regla 13: un endpoint que escribe no está probado hasta ejercerlo contra base real con el payload
 * de la pantalla (`{ motivo }`). Carga `oc-cancelacion.service.ts` con ts-node y le pone un DOBLE de
 * Kepler (en el CI no hay ERP; el adaptador real se ensaya aparte, en `ops/prod/ensayo-cancelar-oc/`).
 * Lo real: la tabla, sus CHECK, el índice único, RLS, los grants, el interruptor y el tope.
 *
 *   1. Motivo corto → 400 sin consultar Kepler.
 *   2. Interruptor apagado → 503 sin consultar Kepler.
 *   3. Encendido: cancelada → renglón con lo que Kepler pierde (capturista, fecha y hora originales).
 *   4. La misma OC otra vez → 409.
 *   5. Tope de 1 por día → 503 para la segunda.
 *   6. Kepler rechaza → renglón `rechazada` con el porqué; la respuesta lo dice.
 *   7. Sucursal fuera del alcance → 404.
 *   8. ⛔ NEGATIVA de la tabla: `rechazada` sin porqué no entra (CHECK); `cancelada` dos veces tampoco (índice).
 *   9. RLS: otro tenant no ve nada. 10. ROLLBACK real.
 *
 * Lo que NO mide: la capa HTTP (guardia de la llave, parseo del body) ni el SQL contra Kepler.
 * ⛔ No se corre con el `.env` por defecto: apunta a producción. Corre en el job `pruebas-db`.
 */
const path = require('path');
const { randomUUID } = require('crypto');
const RAIZ = path.resolve(__dirname, '..', '..');

const T = '00000000-0000-0000-0000-00000000d01c';
const OTRO_TENANT = '00000000-0000-0000-0000-0000000a1c00';
const ME = randomUUID();
const SUC = '08';
let pass = 0, fail = 0, nm = 0;
const nada = () => undefined;
const ok = (c, m, extra) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m, extra !== undefined ? JSON.stringify(extra) : ''); } };
const noMedido = (m) => { nm++; console.log('  ·  NO MEDIDO —', m); };

let Servicio;
process.env.JWT_SECRET = process.env.JWT_SECRET || `prueba-local-pq110-${'x'.repeat(40)}`;
try {
  require('ts-node').register({ transpileOnly: true, skipProject: true,
    compilerOptions: { module: 'commonjs', moduleResolution: 'node', target: 'es2021', experimentalDecorators: true, emitDecoratorMetadata: true, ignoreDeprecations: '6.0' } });
  const tsc = require('typescript');
  const base = tsc.readConfigFile(path.join(RAIZ, 'tsconfig.base.json'), tsc.sys.readFile).config;
  require('tsconfig-paths').register({ baseUrl: RAIZ, paths: base.compilerOptions.paths });
  require('reflect-metadata');
  ({ OcCancelacionService: Servicio } = require(path.join(RAIZ, 'libs/commercial/src/lib/commercial-replenishment/oc-cancelacion.service.ts')));
} catch (e) {
  console.log(`  ·  NO MEDIDO — no se pudo cargar el servicio con ts-node: ${e.message}`);
  process.exit(2);
}

const knex = require('knex')(require('../knexfile-newdb.js').development);
require('./_lib/assert-safe-target').assertSafeTarget('test-newdb-pq110-cancelar-oc');

async function status(fn) {
  try { await fn(); return 200; } catch (e) { return typeof e.getStatus === 'function' ? e.getStatus() : (e.code || e.message); }
}

/** Lo que Kepler devuelve de la OC antes de cancelarla (la OC de la Suite `08|0000393`, ensayada el 2026-11-13). */
const ORIGINAL = {
  serie: '1', folio: 'PQ110A', estado: 'N', total: 351489.45, capturista: 'SUITE', fecha_captura: '2026-11-13',
  hora_captura: '11:48', renglones: 4, origen_tipo: '30', origen_folio: '0000087',
};

(async () => {
  try {
    console.log('\n[PQ.110] Cancelar OC — el servicio REAL que escribe, como app_runtime\n');
    const id = (await knex.raw('SELECT system_identifier::text sid, current_database() db FROM pg_control_system()')).rows[0];
    console.log(`   base ${id.db} · system_identifier ${id.sid}`);
    if (!(await knex.raw(`SELECT to_regclass('commercial.purchase_order_cancellations') t`)).rows[0].t) {
      noMedido('la base no tiene commercial.purchase_order_cancellations (falta la migración 20261113142557)');
      return;
    }

    await knex.transaction(async (trx) => {
      await trx.raw('SET LOCAL ROLE app_runtime');
      await trx.raw(`SELECT set_config('app.tenant_id', ?, true)`, [T]);
      await trx.raw(`DELETE FROM commercial.purchase_order_cancellations WHERE oc_folio LIKE 'PQ110%'`).catch(nada);

      const llamadas = [];
      const doble = { respuesta: null, cancelar: async (e) => { llamadas.push(e); return doble.respuesta(e); } };
      let alcance = null;
      const s = Object.create(Servicio.prototype);
      Object.assign(s, {
        logger: { log: nada, warn: nada, error: nada, debug: nada },
        tenantCtx: { requireTenantId: () => T, get: () => ({ tenantId: T, userId: ME, username: 'prueba.pq110' }) },
        scope: { readParam: async () => alcance },
        kepler: doble,
        tk: { run: async (fn) => {
          await trx.raw('SAVEPOINT sp_pq110');
          try { const r = await fn(trx); await trx.raw('RELEASE SAVEPOINT sp_pq110'); return r; }
          catch (e) { await trx.raw('ROLLBACK TO SAVEPOINT sp_pq110'); throw e; }
        } },
      });
      const pantalla = { motivo: 'El proveedor no surtió y ya no se necesita' };
      const sw = (cambios) => trx('commercial.kepler_push_switch').where({ tenant_id: T, sucursal: SUC, tipo: 'cancela_oc' }).update(cambios);

      // 1-2. Motivo e interruptor: ninguno llega a Kepler.
      ok(await status(() => s.cancelar(SUC, 'PQ110A', { motivo: 'ya no' })) === 400, 'motivo de menos de 10 letras → 400');
      ok((await trx('commercial.kepler_push_switch').where({ sucursal: SUC, tipo: 'cancela_oc' }).first())?.encendida === false,
        'la migración siembra el interruptor cancela_oc APAGADO');
      ok(await status(() => s.cancelar(SUC, 'PQ110A', pantalla)) === 503, 'interruptor apagado → 503');
      ok(llamadas.length === 0, 'ni el motivo corto ni el interruptor apagado llegan a Kepler', llamadas);

      // 3. Encendido, sin tope: cancelada.
      await sw({ encendida: true, tope_dia: null });
      doble.respuesta = () => ({ estado: 'cancelada', original: ORIGINAL, requisicion: { folio: '0000087', total: 351489.45, renglones: 4 } });
      const a = await s.cancelar(SUC, 'PQ110A', pantalla);
      ok(a.estado === 'cancelada' && a.rechazo === null && a.requisicion_reabierta === '0000087' && a.cancelada_por === 'prueba.pq110',
        'cancelada: la respuesta dice la requisición reabierta y quién', a);
      ok(llamadas[0]?.capturista === 'SUITE' && /^\d{4}-\d{2}-\d{2}$/.test(llamadas[0]?.fecha) && /^\d{2}:\d{2}$/.test(llamadas[0]?.hora),
        'a Kepler va capturista SUITE, fecha YYYY-MM-DD y hora HH:MM de México', llamadas[0]);
      const fila = await trx('commercial.purchase_order_cancellations').where({ oc_folio: 'PQ110A' }).first();
      ok(fila && fila.estado === 'cancelada' && fila.motivo === pantalla.motivo && fila.requisicion_folio === '0000087' && fila.requisicion_reabierta === true,
        'el renglón guarda motivo, requisición y que se reabrió', fila);
      ok(fila?.kepler_original?.capturista === 'SUITE' && fila?.kepler_original?.fecha_captura === '2026-11-13' && fila?.kepler_original?.hora_captura === '11:48',
        'el renglón guarda lo que Kepler pierde: capturista, fecha y hora originales', fila?.kepler_original);

      // 4. La misma OC otra vez.
      ok(await status(() => s.cancelar(SUC, 'PQ110A', pantalla)) === 409, 'la misma OC otra vez → 409');

      // 5. Tope de 1 por día.
      await sw({ tope_dia: 1 });
      const antes = llamadas.length;
      ok(await status(() => s.cancelar(SUC, 'PQ110B', pantalla)) === 503 && llamadas.length === antes, 'tope 1 por día: la segunda → 503 sin llegar a Kepler');

      // 6. Kepler rechaza.
      await sw({ tope_dia: null });
      doble.respuesta = () => ({ estado: 'rechazada', motivo: 'La OC ya tiene vale de entrada (0000533)', original: { ...ORIGINAL, folio: 'PQ110C' } });
      const c = await s.cancelar(SUC, 'PQ110C', pantalla);
      ok(c.estado === 'rechazada' && /vale/.test(c.rechazo || ''), 'Kepler rechaza → estado rechazada con el porqué', c);
      const fc = await trx('commercial.purchase_order_cancellations').where({ oc_folio: 'PQ110C' }).first();
      ok(fc?.estado === 'rechazada' && /vale/.test(fc?.rechazo || '') && fc?.requisicion_reabierta === false, 'el rechazo también queda registrado', fc);

      // 7. Alcance.
      alcance = ['01'];
      ok(await status(() => s.cancelar(SUC, 'PQ110D', pantalla)) === 404, 'sucursal fuera del alcance → 404');
      alcance = null;

      // 8. NEGATIVAS de la tabla.
      const base = { tenant_id: T, sucursal: SUC, motivo: pantalla.motivo, created_by: ME };
      ok(await status(() => s.tk.run((k) => k('commercial.purchase_order_cancellations').insert({ ...base, oc_folio: 'PQ110E', estado: 'rechazada' }))) === '23514',
        'NEGATIVA: rechazada sin porqué no entra (CHECK)');
      ok(await status(() => s.tk.run((k) => k('commercial.purchase_order_cancellations').insert({ ...base, oc_folio: 'PQ110A', estado: 'cancelada' }))) === '23505',
        'NEGATIVA: cancelada dos veces no entra (índice único)');
      ok(await status(() => s.tk.run((k) => k('commercial.purchase_order_cancellations').insert({ ...base, oc_folio: 'PQ110F', estado: 'cancelada', motivo: 'corto' }))) === '23514',
        'NEGATIVA: motivo corto no entra (CHECK)');

      // 9. RLS.
      await trx.raw(`SELECT set_config('app.tenant_id', ?, true)`, [OTRO_TENANT]);
      const otro = (await trx.raw(`SELECT count(*)::int n FROM commercial.purchase_order_cancellations WHERE oc_folio LIKE 'PQ110%'`)).rows[0].n;
      ok(otro === 0, 'RLS: otro tenant no ve ninguna cancelación', otro);

      throw Object.assign(new Error('rollback'), { esRollback: true });
    }).catch((e) => { if (!e.esRollback) throw e; });

    const quedaron = await knex.transaction(async (t) => {
      await t.raw(`SELECT set_config('app.tenant_id', ?, true)`, [T]);
      return (await t.raw(`SELECT count(*)::int n FROM commercial.purchase_order_cancellations WHERE oc_folio LIKE 'PQ110%'`)).rows[0].n;
    });
    ok(quedaron === 0, 'ROLLBACK real: no quedó ninguna cancelación de la prueba');
  } catch (e) {
    fail++;
    console.log('  ✗ error inesperado:', e.message);
  } finally {
    await knex.destroy();
    console.log(`\n  ${pass} ✓ · ${fail} ✗ · ${nm} no medido`);
    process.exit(fail ? 1 : (pass ? 0 : 2));
  }
})();
