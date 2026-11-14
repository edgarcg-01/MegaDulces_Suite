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
let leerRequisicionEnReplica;
let leerCancelacionKeplerDeRequisicion;
let MOTIVO_CANCELADA_EN_KEPLER;
process.env.JWT_SECRET = process.env.JWT_SECRET || `prueba-local-pq110-${'x'.repeat(40)}`;
try {
  require('ts-node').register({ transpileOnly: true, skipProject: true,
    compilerOptions: { module: 'commonjs', moduleResolution: 'node', target: 'es2021', experimentalDecorators: true, emitDecoratorMetadata: true, ignoreDeprecations: '6.0' } });
  const tsc = require('typescript');
  const base = tsc.readConfigFile(path.join(RAIZ, 'tsconfig.base.json'), tsc.sys.readFile).config;
  require('tsconfig-paths').register({ baseUrl: RAIZ, paths: base.compilerOptions.paths });
  require('reflect-metadata');
  ({ OcCancelacionService: Servicio, leerCancelacionKeplerDeRequisicion } = require(path.join(RAIZ, 'libs/commercial/src/lib/commercial-replenishment/oc-cancelacion.service.ts')));
  ({ leerRequisicionEnReplica } = require(path.join(RAIZ, 'libs/commercial/src/lib/commercial-replenishment/kepler-requisicion-replica.ts')));
  ({ MOTIVO_CANCELADA_EN_KEPLER } = require(path.join(RAIZ, 'libs/commercial/src/lib/commercial-replenishment/kepler-req-cancelacion.ts')));
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
      await trx.raw(`DELETE FROM commercial.purchase_order_cancellations WHERE oc_folio LIKE 'PQ110%' OR requisicion_folio LIKE 'KR7%'`).catch(nada);

      const llamadas = [];
      const llamadasRq = [];
      const doble = {
        respuesta: null, respuestaRq: null,
        cancelar: async (e) => { llamadas.push(e); return doble.respuesta(e); },
        cancelarRequisicion: async (e) => { llamadasRq.push(e); return doble.respuestaRq(e); },
      };
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
      ok(await status(() => s.disponible(SUC, 'PQ110D')) === 404, 'disponible: sucursal fuera del alcance → 404 también');
      alcance = null;

      // 7b. GET …/cancelacion: ¿se puede OFRECER el botón? (no escribe). La réplica es un doble aquí;
      //     su SQL se ejerce aparte, abajo, contra la base real.
      let replica = null; let lecturas = 0;
      s.leerReplica = async () => { lecturas++; return replica; };
      const OK_REQ = { oc: { ...ORIGINAL, folio: 'PQ110G' }, coincidencias: 1, vales_vivos: [], otras_oc_vivas: [],
        requisicion: { serie: '1', folio: '0000087', estado: 'F', total: 351489.45, renglones: 0 } };
      const ya = await s.disponible(SUC, 'PQ110A');
      ok(ya.disponible === false && /ya se canceló/.test(ya.porque || '') && ya.ultima?.estado === 'cancelada' && ya.ultima?.requisicion_reabierta === '0000087',
        'disponible: la OC ya cancelada no ofrece botón y trae el último intento', ya);
      replica = OK_REQ;
      const si = await s.disponible(SUC, 'PQ110G');
      ok(si.disponible === true && si.porque === null && si.reabriria_requisicion === '0000087' && si.ultima === null,
        'disponible: pendiente, sin vale, de requisición F → sí, y dice qué requisición reabriría', si);
      replica = { ...OK_REQ, vales_vivos: ['0000533'] };
      const conVale = await s.disponible(SUC, 'PQ110G');
      ok(conVale.disponible === false && /vale de entrada \(0000533\)/.test(conVale.porque || ''), 'disponible: con vale vivo → no, y dice cuál', conVale);
      replica = null;
      const sinReplica = await s.disponible(SUC, 'PQ110G');
      ok(sinReplica.disponible === false && /réplica/.test(sinReplica.porque || ''), 'disponible: sin réplica de Kepler → no, y lo declara', sinReplica);
      const antesApagado = lecturas;
      await sw({ encendida: false });
      const apagado = await s.disponible(SUC, 'PQ110G');
      ok(apagado.disponible === false && /apagado/.test(apagado.porque || '') && !/\b08\b/.test(apagado.porque || '') && lecturas === antesApagado,
        'disponible: apagado → no, nombra la sucursal (no «08») y ni lee la réplica', apagado);
      await sw({ encendida: true });
      delete s.leerReplica;

      // 7c. El SQL de la réplica, REAL (si la base tiene kepler_ods): un folio que no existe → 0 coincidencias.
      const real = await s.tk.run((k) => Servicio.prototype.leerReplica.call(s, k, SUC, 'PQ110NOEXISTE')).catch((e) => ({ error: e.message }));
      if (real === null) noMedido('la base no tiene kepler_ods.kdm1: el SQL de la réplica no se ejerció');
      else ok(real && real.coincidencias === 0 && real.oc === null && Array.isArray(real.vales_vivos), 'leerReplica contra la base real: folio inexistente → 0 coincidencias, sin error', real);

      // 7d. `[KR.7]` El SQL del lector de la requisición en la réplica (la ficha y, después, la regla de KR.7),
      // REAL: un folio que no existe → sin requisición y sin OC, sin error de columnas ni de tipos.
      const rqReal = await s.tk.run((k) => leerRequisicionEnReplica(k, SUC, 'KR7NOEXISTE')).catch((e) => ({ error: e.message }));
      if (rqReal === null) noMedido('la base no tiene kepler_ods.kdm1: el SQL del lector de KR.7 no se ejerció');
      else ok(rqReal && rqReal.requisicion === null && Array.isArray(rqReal.ocs) && rqReal.ocs.length === 0,
        'leerRequisicionEnReplica contra la base real: folio inexistente → sin requisición ni OC, sin error', rqReal);

      // ── `[KR.7]` Cancelar la REQUISICIÓN en Kepler desde su ficha: el mismo servicio, otro documento ──────
      const kr7 = (await trx.raw(`SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'commercial'
                                    AND table_name = 'purchase_order_cancellations' AND column_name = 'document_type') x`)).rows[0].x;
      if (!kr7) noMedido('la base no tiene la migración 20261114120335 (KR.7): los casos de la requisición no se ejercieron');
      else {
        console.log('\n  [KR.7] la requisición');
        // Las requisiciones de prueba se siembran como dueño (app_runtime no da de alta almacenes ni proveedores).
        await trx.raw('RESET ROLE');
        const [wh] = await trx('commercial.warehouses').insert({ tenant_id: T, code: 'PRBKR7', name: 'Prueba KR.7' }).returning('id');
        const [sp] = await trx('catalog.suppliers').insert({ tenant_id: T, code: 'PRBKR7', name: 'PROVEEDOR PRUEBA KR7' }).returning('id');
        const rq = async (o) => {
          const [r] = await trx('commercial.purchase_requisitions').insert({
            tenant_id: T, warehouse_id: wh.id || wh, supplier_id: sp.id || sp, source_type: o.source_type ?? 'supplier',
            estado: o.estado ?? 'ordered', target_basis: 'max', folio: `RQ-KR7-${Math.random().toString(36).slice(2, 9)}`,
            total_lines: 0, total_units: 0, total_cost: 0,
            kepler_sucursal: o.folio ? SUC : null, kepler_folio: o.folio ?? null, ...(o.extra ?? {}),
          }).returning('id');
          return r.id || r;
        };
        const R1 = await rq({ folio: 'KR7A' });
        const R2 = await rq({ folio: 'KR7B' });
        const R3 = await rq({ folio: 'KR7C' });
        const R4 = await rq({ folio: 'KR7D', estado: 'cancelled', extra: { rejection_reason: 'Rechazada antes por quien autoriza', rejected_at: new Date() } });
        const R5 = await rq({ folio: null });
        await trx.raw('SET LOCAL ROLE app_runtime');
        const est = (id) => trx('commercial.purchase_requisitions').where({ id }).first('estado', 'rejection_reason', 'rejected_by');
        const swRq = (cambios) => trx('commercial.kepler_push_switch').where({ tenant_id: T, sucursal: SUC, tipo: 'cancela_requisicion' }).update(cambios);
        const pantallaRq = { motivo: 'El proveedor ya no surte este pedido' };
        const ORIG_RQ = { serie: '1', folio: 'KR7A', estado: 'A', total: 36552.12, capturista: 'SUITE', fecha_captura: '2026-10-29', hora_captura: '12:40', renglones: 7 };

        // K1-K3. Motivo, «no llegó a Kepler» e interruptor: ninguno llega a Kepler.
        ok(await status(() => s.cancelarRequisicion(R1, { motivo: 'ya no' })) === 400, 'KR.7: motivo de menos de 10 letras → 400');
        ok(await status(() => s.cancelarRequisicion(R5, pantallaRq)) === 409, 'KR.7: una requisición que no llegó a Kepler → 409');
        const r5 = await s.disponibleRequisicion(R5);
        ok(r5.disponible === false && /no llegó a Kepler/.test(r5.porque || '') && r5.folio === null, 'KR.7 disponible: no llegó a Kepler → no, y lo dice', r5);
        const swSem = await trx('commercial.kepler_push_switch').where({ sucursal: SUC, tipo: 'cancela_requisicion' }).first();
        ok(swSem?.encendida === false && Number(swSem?.tope_dia) === 1, 'KR.7: la migración siembra cancela_requisicion APAGADO con tope 1', swSem);
        ok(await status(() => s.cancelarRequisicion(R1, pantallaRq)) === 503, 'KR.7: interruptor apagado → 503');
        ok(llamadasRq.length === 0, 'KR.7: ni el motivo corto, ni la que no llegó, ni el apagado llegan a Kepler', llamadasRq);

        // K4. Encendido: Kepler la cancela → bitácora + D43 (la de la Suite queda cancelada con motivo y quién).
        await swRq({ encendida: true, tope_dia: null });
        doble.respuestaRq = () => ({ estado: 'cancelada', original: ORIG_RQ });
        const k4 = await s.cancelarRequisicion(R1, pantallaRq);
        ok(k4.estado === 'cancelada' && k4.rechazo === null && k4.suite_cancelada === true && k4.folio === 'KR7A' && k4.cancelada_por === 'prueba.pq110',
          'KR.7: cancelada → la respuesta dice que la Suite también la canceló, y quién', k4);
        ok(llamadasRq[0]?.sucursal === SUC && llamadasRq[0]?.folio === 'KR7A' && llamadasRq[0]?.capturista === 'SUITE' && /^\d{2}:\d{2}$/.test(llamadasRq[0]?.hora),
          'KR.7: a Kepler va la llave de Kepler de la requisición (no su id de la Suite) con capturista SUITE', llamadasRq[0]);
        const f4 = await trx('commercial.purchase_order_cancellations').where({ requisicion_folio: 'KR7A' }).first();
        ok(f4?.document_type === 'requisicion' && f4?.oc_folio === null && f4?.requisition_id === R1 && f4?.estado === 'cancelada'
          && f4?.motivo === pantallaRq.motivo && f4?.kepler_original?.fecha_captura === '2026-10-29' && f4?.kepler_original?.hora_captura === '12:40',
          'KR.7: la bitácora guarda documento, requisición de la Suite, motivo y lo que Kepler pierde', f4);
        const e4 = await est(R1);
        ok(e4?.estado === 'cancelled' && e4?.rejection_reason === `${MOTIVO_CANCELADA_EN_KEPLER}: ${pantallaRq.motivo}` && e4?.rejected_by === ME,
          'D43: la requisición de la Suite queda cancelled, con el motivo (inicio fijo) y quién', e4);

        // K4b. Lo que lee la ficha (C3): la cancelación desde la Suite, con el SQL real de getRequisition.
        const lk1 = await leerCancelacionKeplerDeRequisicion(trx, T, R1);
        ok(lk1?.motivo === pantallaRq.motivo && lk1?.por === 'prueba.pq110' && !Number.isNaN(Date.parse(lk1?.en)),
          'C3: la ficha lee cuándo, quién y por qué se canceló en Kepler desde la Suite', lk1);
        ok(await leerCancelacionKeplerDeRequisicion(trx, T, R3) === null, 'C3 NEGATIVA: una requisición que no se canceló desde aquí → null');

        // K5. Otra vez → 409.
        ok(await status(() => s.cancelarRequisicion(R1, pantallaRq)) === 409, 'KR.7: la misma requisición otra vez → 409');

        // K6. El tope es POR DOCUMENTO.
        await swRq({ tope_dia: 1 });
        const antesRq = llamadasRq.length;
        ok(await status(() => s.cancelarRequisicion(R2, pantallaRq)) === 503 && llamadasRq.length === antesRq, 'KR.7: tope 1 por día → la segunda requisición 503 sin llegar a Kepler');
        await sw({ tope_dia: 2 });
        doble.respuesta = () => ({ estado: 'cancelada', original: { ...ORIGINAL, folio: 'PQ110H' } });
        const h = await s.cancelar(SUC, 'PQ110H', pantalla).catch((e) => ({ error: e.message }));
        ok(h.estado === 'cancelada',
          'NEGATIVA del tope: la requisición cancelada hoy NO gasta el tope de las OC (1 OC + 1 requisición con tope 2 de OC → pasa)', h);
        await sw({ tope_dia: null });
        await swRq({ tope_dia: null });

        // K7. Kepler rechaza → bitácora `rechazada`; la Suite NO cambia.
        doble.respuestaRq = () => ({ estado: 'rechazada', motivo: 'Tiene viva la orden de compra 0000393: primero se cancela la OC (Kepler no cancela una requisición con OC viva)' });
        const k7 = await s.cancelarRequisicion(R2, pantallaRq);
        ok(k7.estado === 'rechazada' && /0000393/.test(k7.rechazo || '') && k7.suite_cancelada === false, 'KR.7: Kepler rechaza → rechazada con el porqué', k7);
        ok((await est(R2))?.estado === 'ordered', 'KR.7: rechazada en Kepler → la de la Suite sigue como estaba');
        ok(await leerCancelacionKeplerDeRequisicion(trx, T, R2) === null, 'C3 NEGATIVA: un intento RECHAZADO no se lee como cancelación');

        // K8. Ya cancelada en la Suite (la ficha avisaba «sigue viva en Kepler»): Kepler la cancela, la Suite conserva su motivo.
        doble.respuestaRq = () => ({ estado: 'cancelada', original: { ...ORIG_RQ, folio: 'KR7D' } });
        const k8 = await s.cancelarRequisicion(R4, pantallaRq);
        const e8 = await est(R4);
        ok(k8.estado === 'cancelada' && k8.suite_cancelada === false && e8?.rejection_reason === 'Rechazada antes por quien autoriza',
          'D43: ya cancelada en la Suite → no se pisa su motivo, y la respuesta lo dice (suite_cancelada false)', { k8, e8 });

        // K9. Alcance por la sucursal de Kepler.
        alcance = ['01'];
        ok(await status(() => s.cancelarRequisicion(R3, pantallaRq)) === 404, 'KR.7: sucursal fuera del alcance → 404');
        ok(await status(() => s.disponibleRequisicion(R3)) === 404, 'KR.7 disponible: fuera del alcance → 404 también');
        alcance = null;

        // K10. GET …/kepler-cancellation (no escribe). La réplica es un doble; su SQL ya se ejerció en 7d.
        let replicaRq = null; let lecturasRq = 0;
        s.leerRequisicionReplica = async () => { lecturasRq++; return replicaRq; };
        const ya1 = await s.disponibleRequisicion(R1);
        ok(ya1.disponible === false && /ya se canceló/.test(ya1.porque || '') && ya1.ultima?.estado === 'cancelada' && ya1.ultima?.suite_cancelada === null,
          'KR.7 disponible: ya cancelada → no, con el último intento (suite_cancelada null: la bitácora no lo guarda)', ya1);
        const doc = (folio, estado) => ({ folio, estado, cancelada: null });
        replicaRq = { requisicion: doc('KR7C', 'A'), ocs: [doc('0000390', 'C')] };
        const si3 = await s.disponibleRequisicion(R3);
        ok(si3.disponible === true && si3.porque === null && si3.folio === 'KR7C', 'KR.7 disponible: reabierta con su OC cancelada → sí', si3);
        replicaRq = { requisicion: doc('KR7C', 'F'), ocs: [doc('0000393', 'N')] };
        const viva = await s.disponibleRequisicion(R3);
        ok(viva.disponible === false && /0000393/.test(viva.porque || ''), 'KR.7 disponible: con OC viva → no, y dice cuál', viva);
        replicaRq = null;
        const sinRep = await s.disponibleRequisicion(R3);
        ok(sinRep.disponible === false && /réplica/.test(sinRep.porque || ''), 'KR.7 disponible: sin réplica → no, y lo declara', sinRep);
        const antesApRq = lecturasRq;
        await swRq({ encendida: false });
        const ap = await s.disponibleRequisicion(R3);
        ok(ap.disponible === false && /apagado/.test(ap.porque || '') && !/\b08\b/.test(ap.porque || '') && lecturasRq === antesApRq,
          'KR.7 disponible: apagado → no, nombra la sucursal y ni lee la réplica', ap);
        delete s.leerRequisicionReplica;

        // K11. NEGATIVAS de la tabla para el renglón de requisición.
        const bRq = { tenant_id: T, sucursal: SUC, motivo: pantallaRq.motivo, created_by: ME, document_type: 'requisicion' };
        ok(await status(() => s.tk.run((k) => k('commercial.purchase_order_cancellations').insert({ ...bRq, requisicion_folio: 'KR7E', estado: 'rechazada', rechazo: 'x' }))) === '23514',
          'NEGATIVA: renglón de requisición sin requisition_id no entra (CHECK)');
        ok(await status(() => s.tk.run((k) => k('commercial.purchase_order_cancellations').insert({ ...bRq, requisicion_folio: 'KR7E', requisition_id: R3, oc_folio: 'PQ110Z', estado: 'rechazada', rechazo: 'x' }))) === '23514',
          'NEGATIVA: renglón de requisición con oc_folio no entra (CHECK)');
        ok(await status(() => s.tk.run((k) => k('commercial.purchase_order_cancellations').insert({ ...bRq, requisicion_folio: 'KR7A', requisition_id: R1, estado: 'cancelada' }))) === '23505',
          'NEGATIVA: la misma requisición cancelada dos veces no entra (índice único)');
        ok(await status(() => s.tk.run((k) => k('commercial.purchase_order_cancellations').insert({ tenant_id: T, sucursal: SUC, motivo: pantalla.motivo, estado: 'rechazada', rechazo: 'x' }))) === '23514',
          'NEGATIVA: renglón de OC sin oc_folio no entra (CHECK) — relajar el NOT NULL no lo abrió');
      }

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
      const otro = (await trx.raw(`SELECT count(*)::int n FROM commercial.purchase_order_cancellations WHERE oc_folio LIKE 'PQ110%' OR requisicion_folio LIKE 'KR7%'`)).rows[0].n;
      ok(otro === 0, 'RLS: otro tenant no ve ninguna cancelación', otro);

      throw Object.assign(new Error('rollback'), { esRollback: true });
    }).catch((e) => { if (!e.esRollback) throw e; });

    const quedaron = await knex.transaction(async (t) => {
      await t.raw(`SELECT set_config('app.tenant_id', ?, true)`, [T]);
      return (await t.raw(`SELECT count(*)::int n FROM commercial.purchase_order_cancellations WHERE oc_folio LIKE 'PQ110%' OR requisicion_folio LIKE 'KR7%'`)).rows[0].n;
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
