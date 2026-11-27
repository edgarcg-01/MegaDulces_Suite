#!/usr/bin/env node
/**
 * [PQ.3.29] La requisición de compra de la Suite atiende la revisión del Calendario en la sucursal DESTINO (anexo C
 * §10.18, DC40) — `SQL_REQUISICIONES_SUITE` contra Postgres real, con el repositorio real (`leerRequisiciones`, ts-node)
 * leyendo como `app_runtime` con el tenant puesto.
 *
 * ── QUÉ AFIRMA ───────────────────────────────────────────────────────────────────────────
 *  1. Una requisición de compra que sale de la 08 con renglones para 05 y 06 cuenta en 05 y 06, el día que se creó, y
 *     NO en la 08 (la que emite, sin renglones para ella).
 *  2. Un renglón sin destino cuenta en la sucursal que emite.
 *  3. NEGATIVAS: cancelada no cuenta; borrador no cuenta; un traspaso (con almacén origen) no cuenta; un renglón de
 *     traspaso dentro de una requisición de compra no cuenta; la de hace 70 días queda fuera de la ventana; sin pedir su
 *     clave ni su ficha, no sale.
 *  4. R5: pedida por FICHA (no por clave) también sale, con la clave de su ficha.
 *
 * Todo dentro de una transacción que se REVIERTE: no deja filas. Sin un producto en la base (los renglones lo piden por
 * llave) sale con 2 = NO MEDIDO, nunca ✔.
 * ⛔ Escribe (aunque revierta): exige `assert-safe-target`, nunca contra producción.
 */
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env'), quiet: true });
require('./_lib/assert-safe-target').assertSafeTarget('test-newdb-pq3-29-requisicion-atiende');
const { noMedido, correr } = require('./_lib/no-medido');

const RAIZ = path.resolve(__dirname, '..', '..');
let R;
try {
  require('ts-node').register({ transpileOnly: true, skipProject: true,
    compilerOptions: { module: 'commonjs', moduleResolution: 'node', target: 'es2021', experimentalDecorators: true, emitDecoratorMetadata: true, ignoreDeprecations: '6.0' } });
  const tsc = require('typescript');
  const base = tsc.readConfigFile(path.join(RAIZ, 'tsconfig.base.json'), tsc.sys.readFile).config;
  require('tsconfig-paths').register({ baseUrl: RAIZ, paths: base.compilerOptions.paths });
  R = require(path.join(RAIZ, 'libs/commercial/src/lib/purchase-calendar/purchase-calendar.repo.ts'));
} catch (e) {
  noMedido(`no se pudo cargar el repositorio con ts-node: ${e.message}`);
}
const knex = require('knex')(require('../knexfile-newdb.js').development);
const TENANT = '00000000-0000-0000-0000-00000000d01c';

let ok = 0;
let ko = 0;
const check = (desc, cond, detalle) => {
  if (cond) { ok += 1; console.log(`  ✓ ${desc}`); }
  else { ko += 1; console.log(`  ✗ ${desc}${detalle !== undefined ? `  → ${JSON.stringify(detalle)}` : ''}`); }
};

correr(async () => {
  console.log('\n[PQ.3.29] la requisición de compra de la Suite atiende la revisión en la sucursal destino — Postgres real\n');
  const trx = await knex.transaction();
  try {
    await trx.raw(`SELECT set_config('app.tenant_id', ?, true)`, [TENANT]);
    const prod = await trx('catalog.products').where({ tenant_id: TENANT }).first('id');
    if (!prod) { await trx.rollback(); await knex.destroy(); noMedido('la base no tiene ningún producto (los renglones de requisición lo piden por llave)'); return; }
    const hoy = await R.hoyMx(trx);
    const sumar = (f, n) => { const d = new Date(`${f}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

    // Sucursales (las que falten se crean dentro de la transacción).
    const wh = {};
    for (const code of ['01', '02', '03', '04', '05', '06', '07', '08']) {
      let w = await trx('commercial.warehouses').where({ tenant_id: TENANT, code }).whereNull('deleted_at').first('id');
      if (!w) [w] = await trx('commercial.warehouses').insert({ tenant_id: TENANT, code, name: `Prueba ${code}`, kepler_code: code, active: true }).returning('id');
      wh[code] = w.id ?? w;
    }
    const [a] = await trx('catalog.suppliers').insert({ tenant_id: TENANT, code: 'PQ329A', name: 'PRUEBA PQ.3.29 A' }).returning('id');
    const [b] = await trx('catalog.suppliers').insert({ tenant_id: TENANT, code: 'PQ329B', name: 'PRUEBA PQ.3.29 B' }).returning('id');
    const A = a.id ?? a; const B = b.id ?? b;
    let n = 0;
    // Una requisición con sus renglones: `destinos` = sucursal destino por renglón (null = sin destino).
    const requisicion = async ({ prov = A, emite = '08', estado = 'approved', destinos, dias = 0, origen = null, origenRenglon = null }) => {
      n += 1;
      const [r] = await trx('commercial.purchase_requisitions').insert({
        tenant_id: TENANT, warehouse_id: wh[emite], supplier_id: prov, folio: `PQ329-${n}`, estado,
        source_type: origen ? 'branch' : 'supplier', source_warehouse_id: origen ? wh[origen] : null,
        created_at: trx.raw(`(?::date + time '12:00') AT TIME ZONE 'America/Mexico_City'`, [sumar(hoy, dias)]),
      }).returning('id');
      const rid = r.id ?? r;
      for (const d of destinos) {
        await trx('commercial.purchase_requisition_lines').insert({ tenant_id: TENANT, requisition_id: rid, product_id: prod.id, supplier_id: prov,
          destination_warehouse_id: d ? wh[d] : null, source_warehouse_id: origenRenglon ? wh[origenRenglon] : null });
      }
    };
    await requisicion({ destinos: ['05', '06'] });                       // cuenta en 05 y 06, no en 08
    await requisicion({ emite: '07', destinos: [null] });                // sin destino: cuenta en la 07 (la que emite)
    await requisicion({ estado: 'cancelled', destinos: ['04'] });        // NO
    await requisicion({ estado: 'draft', destinos: ['03'] });            // NO
    await requisicion({ origen: '08', destinos: ['02'] });               // traspaso: NO
    await requisicion({ destinos: ['01'], origenRenglon: '08' });        // renglón de traspaso: NO
    await requisicion({ destinos: ['06'], dias: -70 });                  // fuera de la ventana: no agrega fecha
    await requisicion({ prov: B, destinos: ['05'] });                    // R5: por ficha

    // Reglas de sucursal de HOY (su día de la semana): 05 tiene requisición de hoy; 04 sólo una cancelada.
    const isoHoy = ((new Date(`${hoy}T12:00:00Z`).getUTCDay() + 6) % 7) + 1;
    for (const b of ['05', '04']) {
      await trx('commercial.purchase_review_rules').insert({ tenant_id: TENANT, supplier_code: 'PQ329A', scope: 'branch', branch_code: b,
        pattern: 'weekdays', weekdays: [isoHoy], created_by: 'prueba', updated_by: 'prueba',
        created_at: trx.raw(`now() - interval '1 day'`), updated_at: trx.raw(`now() - interval '1 day'`) });
    }

    await trx.raw('SET LOCAL ROLE app_runtime');
    const desde = sumar(hoy, -62);
    const filas = await R.leerRequisiciones(trx, { hoy, desde, codes: ['PQ329A'], fichas: [] });
    const de = (prov, plaza) => filas.find((f) => f.supplier_code === prov && f.plaza === plaza);
    const plazas = filas.filter((f) => f.supplier_code === 'PQ329A').map((f) => f.plaza).sort();
    check('cuenta en 05 y 06 (destinos) y en 07 (sin destino: la que emite); nada más', JSON.stringify(plazas) === JSON.stringify(['05', '06', '07']), plazas);
    check('NO cuenta en la 08 que emite sin renglones para ella', !de('PQ329A', '08'));
    check('el día que se creó (hora de México)', de('PQ329A', '05')?.fechas?.includes(hoy) && de('PQ329A', '05')?.ultima === hoy, de('PQ329A', '05'));
    check('NEGATIVA: cancelada no cuenta (04)', !de('PQ329A', '04'));
    check('NEGATIVA: borrador no cuenta (03)', !de('PQ329A', '03'));
    check('NEGATIVA: un traspaso no cuenta (02)', !de('PQ329A', '02'));
    check('NEGATIVA: un renglón de traspaso no cuenta (01)', !de('PQ329A', '01'));
    check('NEGATIVA: la de hace 70 días no agrega fecha (06 sólo trae la de hoy)', JSON.stringify(de('PQ329A', '06')?.fechas) === JSON.stringify([hoy]), de('PQ329A', '06'));
    check('NEGATIVA: sin pedir su clave ni su ficha, el proveedor B no sale', !filas.some((f) => f.supplier_code === 'PQ329B'));
    const porFicha = await R.leerRequisiciones(trx, { hoy, desde, codes: ['NO-EXISTE'], fichas: [B] });
    check('R5: pedida por ficha, sale con la clave de su ficha', porFicha.length === 1 && porFicha[0].supplier_code === 'PQ329B' && porFicha[0].plaza === '05' && porFicha[0].supplier_id === B, porFicha);
    check('sin claves ni fichas no consulta', (await R.leerRequisiciones(trx, { hoy, desde, codes: [], fichas: [] })).length === 0);

    // El calendario de verdad las usa (`leerCalendario`). En un SAVEPOINT: una base sin las vistas de Kepler lo declara.
    await trx.raw('SAVEPOINT sp_cal');
    try {
      const cal = await R.leerCalendario(trx, TENANT, null);
      await trx.raw('RELEASE SAVEPOINT sp_cal');
      const r05 = cal.reglas.find((r) => r.supplier_code === 'PQ329A' && r.branch_code === '05');
      const r04 = cal.reglas.find((r) => r.supplier_code === 'PQ329A' && r.branch_code === '04');
      check('leerCalendario: la regla de la 05 queda al día por su requisición de hoy', r05?.estado?.estado === 'al_dia'
        && r05?.ultima_actividad?.fuente === 'requisicion' && r05?.ultima_actividad?.fecha === hoy, r05 && { estado: r05.estado, ultima: r05.ultima_actividad });
      check('NEGATIVA leerCalendario: la de la 04 (sólo una requisición cancelada) NO queda al día', r04 && r04.estado.estado !== 'al_dia', r04 && r04.estado);
    } catch (e) {
      await trx.raw('ROLLBACK TO SAVEPOINT sp_cal');
      console.log(`  ○ NO MEDIDO — leerCalendario en esta base: ${String(e.message).split(' - ').pop()}`);
    }
  } finally {
    if (!trx.isCompleted()) await trx.rollback();
  }
  console.log(`\n${ok} ✓ · ${ko} ✗\n`);
  await knex.destroy();
  process.exit(ko ? 1 : 0);
});
