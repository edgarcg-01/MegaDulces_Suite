/* eslint-disable no-console */
/**
 * `[PQ.50]` CANDADO DEL CIERRE DE TRASPASOS QUE NO SALIERON A KEPLER — corre el SQL REAL de
 * `traspaso-no-ejecutado.ts` (ts-node).
 *
 * ── Por qué existe, medido en prod el 2026-11-04 ────────────────────────────────────────────
 *
 * 1,152 traspasos aprobados sin documento en Kepler (la escritura de traspasos está apagada), 867
 * con más de 7 días ($17.3 M). D29 (PM, 2026-11-04): se cierran con motivo, una vez y después solos
 * en cada lectura de la bandeja. Es un camino que ESCRIBE en prod: regla 13.
 *
 * ── Las dos mitades ─────────────────────────────────────────────────────────────────────────
 *
 *   1. **SÓLO LECTURA.** El conteo del módulo contra un TESTIGO escrito aparte, y dos placebos: con
 *      el reloj diez años atrás no hay nada que cerrar, y con el reloj un año adelante nunca hay
 *      menos que hoy. Sin traspasos aprobados en la base: NO MEDIDO.
 *   2. **CASOS SINTÉTICOS — ESCRIBEN, con ROLLBACK, sólo contra una base LOCAL** (el CI): se cierra
 *      el viejo, con motivo, sin persona y con la hora del cierre (el CHECK de motivo se cumple), y
 *      NO se cierran el de 6 días, el que tiene folio de Kepler, el capturado a mano, el que pidió
 *      una sucursal, la compra ni el que está por aprobar. El tope cierra los más viejos primero.
 *
 * Lo que NO ejerce: la llamada desde `asociarOcDeKepler()` (lectura de la bandeja). Eso lo cubre
 * la prueba de código del servicio.
 */
const path = require('path');
try { require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env'), quiet: true }); } catch { /* opcional */ }

const T = '00000000-0000-0000-0000-00000000d01c';
let pass = 0, fail = 0, nm = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m); } };
const noMedido = (m) => { nm++; console.log('  ·  NO MEDIDO —', m); };
const fin = async (knexes) => {
  for (const k of knexes) { try { await k.destroy(); } catch { /* nada */ } }
  console.log(`\n  ${pass} ✓ · ${fail} ✗ · ${nm} no medido`);
  process.exit(fail ? 1 : (pass ? 0 : 2));
};

let mod;
try {
  require('ts-node').register({
    transpileOnly: true, skipProject: true,
    compilerOptions: { module: 'commonjs', target: 'es2020', esModuleInterop: true, moduleResolution: 'node', ignoreDeprecations: '6.0' },
  });
  mod = require(path.resolve(__dirname, '../../libs/commercial/src/lib/commercial-replenishment/traspaso-no-ejecutado.ts'));
} catch (e) {
  console.log(`  ·  NO MEDIDO — no se pudo cargar traspaso-no-ejecutado.ts con ts-node: ${e.message}`);
  process.exit(2);
}
const { contarTraspasosNoEjecutados, cerrarTraspasosNoEjecutados, MOTIVO_TRASPASO_NO_EJECUTADO } = mod;

/** El TESTIGO: el mismo universo, escrito aparte del módulo. */
async function testigo(db, ahora) {
  const r = await db.raw(`
    SELECT count(*)::int AS n
      FROM commercial.purchase_requisitions
     WHERE tenant_id = ? AND estado = 'approved' AND source_type = 'branch'
       AND kepler_folio IS NULL AND oc_folio IS NULL AND requested_by_branch IS NOT TRUE
       AND COALESCE(approved_at, created_at) + interval '7 days' < ?::timestamptz`, [T, ahora]);
  return Number(r.rows[0].n);
}

(async () => {
  const knexes = [];
  console.log('\n[PQ.50] Cierre de traspasos aprobados que no salieron a Kepler\n');

  // ── 1. Sólo lectura ───────────────────────────────────────────────────────────────────────
  console.log('1) El universo contra un testigo (sólo lectura)');
  const ro = require('knex')(require('../knexfile-newdb.js').development);
  knexes.push(ro);
  try {
    await ro.transaction(async (trx) => {
      await trx.raw('SET TRANSACTION READ ONLY');
      await trx.raw(`SELECT set_config('app.tenant_id', ?, true)`, [T]);
      const hay = Number((await trx.raw(
        `SELECT count(*)::int n FROM commercial.purchase_requisitions WHERE tenant_id = ? AND source_type = 'branch' AND estado = 'approved'`, [T])).rows[0].n);
      if (!hay) { noMedido('sin traspasos aprobados en esta base: el universo no se pudo comparar con datos reales'); throw new Error('__ROLLBACK__'); }
      const hoy = new Date();
      const n = await contarTraspasosNoEjecutados(trx, T, hoy);
      const w = await testigo(trx, hoy);
      console.log(`   ${hay} traspaso(s) aprobados · se cerrarían ${n} · testigo ${w}`);
      ok(n === w, 'el módulo cuenta EXACTAMENTE lo que cuenta el testigo');
      ok(n < hay || hay === 0, `no cierra todo lo aprobado (${n} de ${hay}): lo de 7 días o menos sigue vivo`);
      const atras = await contarTraspasosNoEjecutados(trx, T, new Date(hoy.getTime() - 3650 * 86400000));
      ok(atras === 0, `PLACEBO: con el reloj diez años atrás no hay nada que cerrar (${atras})`);
      const adelante = await contarTraspasosNoEjecutados(trx, T, new Date(hoy.getTime() + 365 * 86400000));
      ok(adelante >= n, `PLACEBO: con el reloj un año adelante no hay menos que hoy (${adelante} ≥ ${n})`);
      throw new Error('__ROLLBACK__');
    });
  } catch (e) {
    if (!/__ROLLBACK__/.test(e.message)) { fail++; console.log('  ✗ la lectura falló:', e.message); }
  }

  // ── 2. Casos sintéticos: escriben, con rollback, sólo en base local ───────────────────────
  console.log('\n2) Casos sintéticos (escriben con ROLLBACK, sólo base local)');
  const { classify } = require('./_lib/assert-safe-target');
  const url = process.env.DATABASE_URL_NEW_RUNTIME || process.env.DATABASE_URL_NEW || null;
  const kind = classify(url).kind;
  if (kind !== 'local') {
    noMedido(`destino ${kind}: los casos que escriben sólo corren contra una base local (el CI)`);
    return fin(knexes);
  }
  const rw = require('knex')({ client: 'pg', connection: url });
  knexes.push(rw);
  try {
    await rw.transaction(async (trx) => {
      await trx.raw(`SELECT set_config('app.tenant_id', ?, true)`, [T]);
      const wh = (await trx.raw(`SELECT id FROM commercial.warehouses WHERE tenant_id = ? ORDER BY id LIMIT 2`, [T])).rows;
      if (wh.length < 2) { noMedido('la base sembrada no trae dos almacenes del tenant'); throw new Error('__ROLLBACK__'); }
      const [DST, SRC] = [wh[0].id, wh[1].id];
      const ahora = new Date();
      const dias = (d) => new Date(ahora.getTime() - d * 86400000);
      const alta = async (o) => {
        const [r] = await trx('commercial.purchase_requisitions').insert({
          tenant_id: T, warehouse_id: DST, source_type: o.src || 'branch', source_warehouse_id: (o.src || 'branch') === 'branch' ? SRC : null,
          folio: `RQ-TEST-${Math.random().toString(36).slice(2, 9)}`, estado: o.estado || 'approved', target_basis: 'max',
          total_lines: 1, total_units: 1, total_cost: 0, created_at: o.creada || dias(o.d + 1), approved_at: o.estado === 'pending_approval' ? null : (o.aprobada || dias(o.d)),
          kepler_sucursal: o.kepler ? '01' : null, kepler_folio: o.kepler ? '0009999' : null,
          oc_sucursal: o.oc ? '01' : null, oc_folio: o.oc ? '0009998' : null,
          requested_by_branch: !!o.suc,
        }).returning(['id']);
        return r.id;
      };
      const estado = async (id) => trx('commercial.purchase_requisitions').where({ id }).first('estado', 'rejection_reason', 'rejected_by', 'rejected_at');

      // El tope: tres viejísimos (2000) para que ningún dato sembrado les gane el turno.
      const t1 = await alta({ aprobada: new Date('2000-01-01T12:00:00Z'), creada: new Date('2000-01-01T00:00:00Z') });
      const t2 = await alta({ aprobada: new Date('2000-01-02T12:00:00Z'), creada: new Date('2000-01-02T00:00:00Z') });
      const t3 = await alta({ aprobada: new Date('2000-01-03T12:00:00Z'), creada: new Date('2000-01-03T00:00:00Z') });
      const c2 = await cerrarTraspasosNoEjecutados(trx, T, ahora, 2);
      const [e1, e2, e3] = [await estado(t1), await estado(t2), await estado(t3)];
      ok(c2 === 2 && e1.estado === 'cancelled' && e2.estado === 'cancelled' && e3.estado === 'approved',
        `el tope cierra los MÁS VIEJOS primero (cerró ${c2}; ${e1.estado}/${e2.estado}/${e3.estado})`);
      ok(String(e1.rejection_reason || '').startsWith(`${MOTIVO_TRASPASO_NO_EJECUTADO}: Compras lo aprobó el 01-01-2000`),
        `el motivo dice qué pasó y cuándo se aprobó: «${String(e1.rejection_reason).slice(0, 70)}…»`);
      ok(e1.rejected_by === null && e1.rejected_at && Math.abs(new Date(e1.rejected_at).getTime() - ahora.getTime()) < 2000,
        'lo cerró el sistema (sin persona) a la hora del cierre — el CHECK de motivo se cumple');

      const viejo = await alta({ d: 8 });
      const seis = await alta({ d: 6 });
      const conFolio = await alta({ d: 30, kepler: true });
      const capturado = await alta({ d: 30, kepler: true, oc: true, estado: 'ordered' });
      const aMano = await alta({ d: 30, oc: true });
      const deSucursal = await alta({ d: 30, suc: true });
      const compra = await alta({ d: 30, src: 'supplier' });
      const porAprobar = await alta({ d: 30, estado: 'pending_approval' });
      await cerrarTraspasosNoEjecutados(trx, T, ahora, 100000);
      ok((await estado(viejo)).estado === 'cancelled', 'el traspaso aprobado hace 8 días, sin folio: CERRADO');
      ok((await estado(t3)).estado === 'cancelled', 'el que dejó el tope se cierra en la siguiente llamada');
      ok((await estado(seis)).estado === 'approved', 'NEGATIVA: el de 6 días sigue vivo (la mesa todavía lo muestra)');
      ok((await estado(conFolio)).estado === 'approved', 'NEGATIVA: el que tiene folio de Kepler no se toca (PQ.26 lo ordena)');
      ok((await estado(capturado)).estado === 'ordered', 'NEGATIVA: el ya ordenado no se toca');
      ok((await estado(aMano)).estado === 'approved', 'NEGATIVA: el que tiene traspaso capturado a mano no se toca');
      ok((await estado(deSucursal)).estado === 'approved', 'NEGATIVA: el que pidió una sucursal no se toca (la mesa diría «RECHAZADA»)');
      ok((await estado(compra)).estado === 'approved', 'NEGATIVA: una compra no es un traspaso');
      ok((await estado(porAprobar)).estado === 'pending_approval', 'NEGATIVA: lo que está por aprobar no se toca');
      const otraVez = await cerrarTraspasosNoEjecutados(trx, T, ahora, 100000);
      ok(otraVez === 0, `repetir no cierra nada más (${otraVez})`);
      throw new Error('__ROLLBACK__');
    });
  } catch (e) {
    if (!/__ROLLBACK__/.test(e.message)) { fail++; console.log('  ✗ los casos sintéticos fallaron:', e.message); }
  }
  return fin(knexes);
})().catch(async (e) => { console.error('  ✗', e.message); process.exit(1); });
