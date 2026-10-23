#!/usr/bin/env node
'use strict';
/**
 * [PQ.4] La agenda por proveedor dice lo MISMO que el ciclo por canal — servicio real, sólo lectura.
 *
 * `worklistProveedores` reusa la álgebra de `worklist` (mismos filtros, mismo `agg`), pero es
 * OTRA consulta: si diera otro sugerido, serían dos números para el mismo hecho. Acá se cruzan
 * las dos vías sobre la misma base, antes de que alguien las lea en pantalla:
 *   · los canales de la agenda (Σ n_canales) = el total del ciclo
 *   · los vencidos de la agenda (Σ n_vencidos) = los vencidos del ciclo
 *   · los proveedores vencidos del ciclo (`prov_vencidos`, [PQ.5]) = filas de la agenda con vencidos
 *   · para cada proveedor cuyos canales entran TODOS en la página del ciclo, Σ suggested_cost cuadra
 *   · cada fila de la agenda vale una sola vez (supplier_id único) y `sucursales_tocan` sólo trae
 *     canales con fecha ≤ hoy
 * Sin datos: NO MEDIDO, nunca ✔.
 */
const path = require('path');
try { require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env'), quiet: true }); } catch { /* opcional */ }

const T = '00000000-0000-0000-0000-00000000d01c';
let pass = 0, fail = 0, nm = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m); } };
const noMedido = (m) => { nm++; console.log('  ·  NO MEDIDO —', m); };
const salir = () => { console.log(`\n  ${pass} ✓ · ${fail} ✗ · ${nm} no medido`); process.exit(fail ? 1 : (pass ? 0 : 2)); };

let Servicio;
try {
  require('ts-node').register({
    transpileOnly: true, skipProject: true,
    compilerOptions: { module: 'commonjs', moduleResolution: 'node', target: 'es2021', experimentalDecorators: true, emitDecoratorMetadata: true, ignoreDeprecations: '6.0' },
  });
  const tsc = require('typescript');
  const base = tsc.readConfigFile(path.join(__dirname, '../../tsconfig.base.json'), tsc.sys.readFile).config;
  require('tsconfig-paths').register({ baseUrl: path.join(__dirname, '../..'), paths: base.compilerOptions.paths });
  require('reflect-metadata');
  ({ CommercialReplenishmentService: Servicio } = require(path.join(__dirname, '../../libs/commercial/src/lib/commercial-replenishment/commercial-replenishment.service.ts')));
} catch (e) {
  console.log(`  ·  NO MEDIDO — no se pudo cargar el servicio real con ts-node: ${e.message}`);
  process.exit(2);
}

const knex = require('knex')(require('../knexfile-newdb.js').development);

function servicio() {
  const s = Object.create(Servicio.prototype);
  Object.assign(s, {
    logger: { log() {}, warn() {}, error() {}, debug() {} },
    tenantCtx: { requireTenantId: () => T, get: () => ({ tenantId: T, userId: null }) },
    scope: { warehouseIds: async () => null, readParam: async () => null },
    tk: { run: (fn) => knex.transaction(async (trx) => {
      await trx.raw('SET TRANSACTION READ ONLY');
      await trx.raw('SET LOCAL statement_timeout = 120000');
      await trx.raw('SELECT set_config(\'app.tenant_id\', ?, true)', [T]);
      return fn(trx);
    }) },
  });
  return s;
}
const n = (v) => Number(v) || 0;

(async () => {
  console.log('\n[PQ.4] Agenda por proveedor contra el ciclo por canal — servicio real, sólo lectura\n');
  const id = (await knex.raw('SELECT system_identifier::text sid, current_database() db FROM pg_control_system()')).rows[0];
  console.log(`   base ${id.db} · system_identifier ${id.sid}`);
  const s = servicio();

  const t0 = Date.now();
  const ciclo = await s.worklist({ via: 'purchase', pageSize: 500 });
  const t1 = Date.now();
  const agenda = await s.worklistProveedores({ via: 'purchase' });
  const t2 = Date.now();
  console.log(`   ciclo ${ciclo.total} canales (${ciclo.rows.length} en la página) en ${t1 - t0} ms · agenda ${agenda.total} proveedores en ${t2 - t1} ms`);
  if (!ciclo.total) { noMedido('la base no trae canales de compra activos'); await knex.destroy(); return salir(); }

  ok(agenda.rows.length === agenda.total, 'la agenda publica tantas filas como declara');
  ok(new Set(agenda.rows.map((r) => r.supplier_id)).size === agenda.rows.length, 'cada proveedor sale UNA vez');
  const sumCanales = agenda.rows.reduce((a, r) => a + n(r.n_canales), 0);
  ok(sumCanales === n(ciclo.total), `Σ canales de la agenda (${sumCanales}) = canales del ciclo (${ciclo.total})`);
  const sumVenc = agenda.rows.reduce((a, r) => a + n(r.n_vencidos), 0);
  ok(sumVenc === n(ciclo.vencidos), `Σ vencidos de la agenda (${sumVenc}) = vencidos del ciclo (${ciclo.vencidos})`);
  const provVenc = agenda.rows.filter((r) => n(r.n_vencidos) > 0).length;
  if (ciclo.prov_vencidos == null) noMedido('el ciclo no publica prov_vencidos (servidor anterior a PQ.5)');
  else ok(provVenc === n(ciclo.prov_vencidos), `proveedores con vencidos: agenda ${provVenc} = ciclo ${ciclo.prov_vencidos}`);
  ok(agenda.rows.every((r) => (r.sucursales_tocan ?? []).every((x) => n(x.days_to_due) <= 0)), '«sucursales_tocan» sólo trae canales con fecha ≤ hoy');
  ok(agenda.rows.every((r) => n(r.sucursales_tocan?.length) === n(r.n_vencidos) + n(r.n_hoy)), '«sucursales_tocan» cuenta exactamente vencidos + hoy');
  const orden = agenda.rows.map((r) => r.next_due_date || '9999').every((d, i, a) => i === 0 || a[i - 1] <= d);
  ok(orden, 'ordenada por la fecha más urgente (vencidos primero)');

  // Sugerido por proveedor: sólo los proveedores cuyos canales entran TODOS en la página del ciclo.
  const porProv = new Map();
  for (const r of ciclo.rows) { const p = porProv.get(r.supplier_id) ?? { n: 0, costo: 0, below: 0 }; p.n++; p.costo += n(r.suggested_cost); p.below += n(r.n_below); porProv.set(r.supplier_id, p); }
  let comparables = 0, cuadran = 0, peor = null;
  for (const a of agenda.rows) {
    const p = porProv.get(a.supplier_id);
    if (!p || p.n !== n(a.n_canales)) continue;
    comparables++;
    const d = Math.abs(p.costo - n(a.suggested_cost));
    if (d < 0.01 && p.below === n(a.n_below)) cuadran++;
    else if (!peor || d > peor.d) peor = { d, prov: a.supplier_name, agenda: n(a.suggested_cost), ciclo: p.costo };
  }
  if (!comparables) noMedido('ningún proveedor tiene todos sus canales dentro de la página de 500');
  else ok(cuadran === comparables, `sugerido y bajo-reorden por proveedor: ${cuadran} de ${comparables} cuadran al centavo${peor ? ` (peor: ${peor.prov} agenda ${peor.agenda} vs ciclo ${peor.ciclo})` : ''}`);
  ok(t2 - t1 < 1000, `la agenda tarda ${t2 - t1} ms (regla: < 1,000 ms; < 500 ms es la meta)`);

  await knex.destroy();
  salir();
})().catch(async (e) => { console.error('  ✗', e.message); await knex.destroy(); process.exit(1); });
