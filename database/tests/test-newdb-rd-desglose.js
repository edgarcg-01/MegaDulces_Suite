#!/usr/bin/env node
'use strict';
/* eslint-disable no-console */
/**
 * `[RD.111]` El DESGLOSE de la comisión suma, nivel por nivel, a lo que explica.
 *
 * Edgar, 2026-11-04: *«al darle clic a cada vendedor me pueda desglosar por qué esa comisión…
 * el desglose del desglose del desglose»*. Un desglose que no suma a la cifra de arriba es peor
 * que no tenerlo: se lee, se cree y manda a buscar una diferencia que no existe. Así que esto
 * carga el SERVICIO REAL (ts-node) y comprueba cada escalón de la escalera:
 *
 *   1. Los DÍAS de cada ruta suman la venta de su línea en la corrida (la corrida está
 *      congelada: si la fuente cambió desde que se calculó, se reporta la ruta — la pantalla
 *      lo dice igual).
 *   2. El ESCALÓN que devuelve el desglose, aplicado a la venta, da el % que se pagó.
 *   3. Los TICKETS de un día suman la venta de ese día, en una fuente `push` y en una `wincaja`
 *      (las dos aritméticas: en el envío el importe ya trae impuestos, en Wincaja se le suman).
 *   4. Los RENGLONES de cada ticket suman el ticket.
 *   5. Lo que entra mal se rechaza con 400/404, no con un 500 ni con una consulta abierta.
 *   6. Cada lectura cabe en el presupuesto de 500 ms.
 *
 * Sólo lectura (transacción READ ONLY). Sin corrida del motor en el destino: NO MEDIDO.
 *   DATABASE_URL_NEW=… node database/tests/test-newdb-rd-desglose.js
 */
const path = require('path');
const RAIZ = path.resolve(__dirname, '..', '..');
const URL = process.env.DATABASE_URL_NEW || process.env.DST_URL
  || (() => { throw new Error('falta la URL de la DB destino: exporta DATABASE_URL_NEW'); })();
const T = process.env.WINCAJA_TENANT_ID || '00000000-0000-0000-0000-00000000d01c';

let pass = 0, fail = 0, nm = 0;
const ok = (c, m, extra) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m, extra !== undefined ? JSON.stringify(extra) : ''); } };
const noMedido = (m) => { nm++; console.log('  ·  NO MEDIDO —', m); };

let Servicio; let elegirEscalon;
process.env.JWT_SECRET = process.env.JWT_SECRET || `prueba-local-rd111-${'x'.repeat(40)}`;
try {
  require('ts-node').register({ transpileOnly: true, skipProject: true,
    compilerOptions: { module: 'commonjs', moduleResolution: 'node', target: 'es2021', experimentalDecorators: true, emitDecoratorMetadata: true, ignoreDeprecations: '6.0' } });
  const tsc = require('typescript');
  const base = tsc.readConfigFile(path.join(RAIZ, 'tsconfig.base.json'), tsc.sys.readFile).config;
  require('tsconfig-paths').register({ baseUrl: RAIZ, paths: base.compilerOptions.paths });
  require('reflect-metadata');
  const dir = path.join(RAIZ, 'libs/commercial/src/lib/commercial-commissions');
  ({ CommercialCommissionsService: Servicio } = require(path.join(dir, 'commercial-commissions.service.ts')));
  ({ elegirEscalon } = require(path.join(dir, 'commission-escalon.logic.ts')));
} catch (e) {
  console.log(`  ·  NO MEDIDO — no se pudo cargar el servicio con ts-node: ${e.message}`);
  process.exit(2);
}

const knex = require('knex')({ client: 'pg', connection: URL, pool: { min: 0, max: 1 } });

async function status(fn) {
  try { await fn(); return 200; } catch (e) { return typeof e.getStatus === 'function' ? e.getStatus() : (e.code || e.message); }
}
async function cronometro(fn) { const t0 = Date.now(); const r = await fn(); return [r, Date.now() - t0]; }
const cerca = (a, b, tol) => Math.abs(Number(a) - Number(b)) <= tol;

(async () => {
  try {
    console.log('\n[RD.111] El desglose de la comisión suma, nivel por nivel\n');
    await knex.transaction(async (trx) => {
      await trx.raw('SET TRANSACTION READ ONLY');
      await trx.raw('SELECT set_config(\'app.tenant_id\', ?, true)', [T]);
      const s = Object.create(Servicio.prototype);
      Object.assign(s, {
        logger: { log() {}, warn() {}, error() {}, debug() {} },
        tenantCtx: { requireTenantId: () => T, get: () => ({ tenantId: T, userId: null }) },
        tk: { run: async (fn) => {
          await trx.raw('SAVEPOINT sp_rd111');
          try { const r = await fn(trx); await trx.raw('RELEASE SAVEPOINT sp_rd111'); return r; }
          catch (e) { await trx.raw('ROLLBACK TO SAVEPOINT sp_rd111'); throw e; }
        } },
      });

      const run = await trx('commercial.commission_runs as r')
        .join('commercial.commission_periods as p', 'p.id', 'r.period_id')
        .whereNull('r.deleted_at').whereNot('r.origen', 'libro').whereNot('r.status', 'anulado')
        .orderBy('p.date_from', 'desc').first('r.id', 'r.period_id', 'p.period_no', 'p.anio');
      if (!run) { noMedido('no hay corrida del motor en este destino'); return; }
      const lineas = await trx('commercial.commission_run_lines')
        .where({ run_id: run.id, beneficiario: 'chofer' }).whereNull('deleted_at')
        .where('venta', '>', 0)
        .select('route_code', 'venta', 'pct_aplicado', 'motivo_no_pago', 'scale_id');
      console.log(`  corrida de Q${run.period_no}/${run.anio}: ${lineas.length} línea(s) de chofer con venta\n`);
      if (!lineas.length) { noMedido('la corrida no tiene líneas de chofer con venta'); return; }

      console.log('── 1 y 2. Los días suman la línea; el escalón da el % pagado');
      const movidas = []; let lento = 0; let pctMal = []; let conPct = 0; let primera = null;
      for (const l of lineas) {
        const [d, ms] = await cronometro(() => s.desgloseRuta(l.route_code, run.period_id, l.scale_id));
        if (ms > 500) lento++;
        if (!primera) primera = d;
        const suma = d.dias.reduce((t, x) => t + x.venta, 0);
        if (!cerca(suma, l.venta, 1)) movidas.push(`${l.route_code}: línea ${l.venta} · días ${suma.toFixed(2)}`);
        if (l.pct_aplicado != null && d.escala?.gate_field === 'venta') {
          conPct++;
          const e = elegirEscalon(d.escala.escalones, Number(l.venta));
          if (!e || Number(e.pct) !== Number(l.pct_aplicado)) pctMal.push(`${l.route_code}: pagó ${l.pct_aplicado}% · escalón ${e?.pct ?? 'ninguno'}`);
        }
      }
      ok(movidas.length === 0, `la suma de los días = la venta de la línea en ${lineas.length - movidas.length} de ${lineas.length} rutas`, movidas);
      if (conPct) ok(pctMal.length === 0, `el escalón del desglose da el % pagado en ${conPct - pctMal.length} de ${conPct}`, pctMal);
      else noMedido('ninguna línea pagó con escalón por venta');
      ok(primera.escala && primera.escala.escalones.length > 0, `el desglose trae los escalones del tabulador (${primera.escala?.escalones.length ?? 0})`);
      // CONTROL: el comparador tiene que marcar una línea cuya venta no es la de los días.
      const l0 = lineas[0];
      const d0 = await s.desgloseRuta(l0.route_code, run.period_id, l0.scale_id);
      const suma0 = d0.dias.reduce((t, x) => t + x.venta, 0);
      ok(!cerca(suma0 - (d0.dias[0]?.venta ?? 0), l0.venta, 1) || d0.dias.length === 0,
        'CONTROL: quitarle un día a la suma la separa de la línea (el comparador no es un no-op)');

      console.log('\n── 3 y 4. Los tickets suman el día; los renglones suman el ticket');
      const ventanaAntigua = await trx.raw(`SELECT route_code, to_char(business_date,'YYYY-MM-DD') AS dia, venta::float8 AS venta
          FROM analytics.v_rd_commission_sales WHERE fuentes_dia = 'wincaja' AND venta > 0
            AND business_date >= current_date - 200 AND business_date <= current_date
          ORDER BY business_date DESC LIMIT 1`).then((r) => r.rows[0]);
      // El envío desde la camioneta es la fuente de las 11 rutas que se pagan hoy: su aritmética
      // (el importe YA trae impuestos) se prueba con un día real de la quincena de la corrida.
      // ⚠️ Las fechas van LITERALES: con un JOIN al periodo el planificador no empuja el rango a
      // la vista y la consulta se pasa del statement_timeout (medido al escribir esta prueba).
      const diaPush = await trx.raw(`SELECT route_code, to_char(business_date,'YYYY-MM-DD') AS dia, venta::float8 AS venta
          FROM analytics.v_rd_commission_sales
         WHERE fuentes_dia = 'push' AND venta > 0 AND business_date BETWEEN ?::date AND ?::date
         ORDER BY business_date DESC, route_code LIMIT 1`, [d0.period.date_from, d0.period.date_to]).then((r) => r.rows[0]);
      const casos = [
        ...d0.dias.slice(0, 3).map((x) => ({ route_code: l0.route_code, dia: x.dia, venta: x.venta, fuente: x.fuentes_dia })),
        ...(ventanaAntigua ? [{ ...ventanaAntigua, fuente: 'wincaja' }] : []),
        ...(diaPush ? [{ ...diaPush, fuente: 'push' }] : []),
      ];
      if (!diaPush) noMedido('no hay un día sólo-push en la quincena de la corrida: la aritmética del envío queda sin probar');
      if (!ventanaAntigua) noMedido('no hay un día sólo-Wincaja en los últimos 200 días: la aritmética de Wincaja queda sin probar');
      for (const c of casos) {
        const [t, ms] = await cronometro(() => s.desgloseTickets(c.route_code, c.dia));
        if (ms > 500) lento++;
        const suma = t.tickets.reduce((a, x) => a + x.venta, 0);
        ok(cerca(suma, c.venta, 0.05), `${c.route_code} el ${c.dia} (${c.fuente}): ${t.tickets.length} tickets suman ${suma.toFixed(2)} · día ${c.venta.toFixed(2)}`);
        const malos = t.tickets.filter((k) => !cerca(k.renglones.reduce((a, r) => a + r.venta, 0), k.venta, 0.02));
        ok(malos.length === 0, `  los renglones suman su ticket en ${t.tickets.length - malos.length} de ${t.tickets.length}`, malos.slice(0, 3).map((k) => k.consecutivo));
      }

      console.log('\n── 5. Lo que entra mal');
      ok((await status(() => s.desgloseTickets('21; drop', '2026-11-04'))) === 400, 'route_code con caracteres raros: 400');
      ok((await status(() => s.desgloseTickets('21', '04/11/2026'))) === 400, 'día mal escrito: 400');
      ok((await status(() => s.desgloseRuta('21', '00000000-0000-0000-0000-000000000bad', null))) === 404, 'periodo inexistente: 404');
      // Una línea vieja sin scale_id usa el tabulador vigente al cierre y LO DICE.
      const sinEscala = await s.desgloseRuta(l0.route_code, run.period_id, null);
      ok(sinEscala.dias.length === d0.dias.length
        && (sinEscala.escala === null || sinEscala.escala.origen === 'vigente_al_cierre'),
      `sin scale_id declara de dónde sacó el tabulador (${sinEscala.escala?.origen ?? 'sin tabulador'}) y los días no cambian`);
      if (d0.escala) ok(d0.escala.origen === 'linea' || d0.escala.origen === 'vigente_al_cierre', `la escala declara su origen (${d0.escala.origen})`);

      console.log('\n── 6. Presupuesto');
      ok(lento === 0, `ninguna lectura pasó de 500 ms (${lento} lentas)`);
    });
  } catch (e) {
    fail++; console.log('\nFATAL:', e.message);
  } finally {
    await knex.destroy();
    console.log(`\n=== ${pass} OK · ${fail} fallas · ${nm} NO MEDIDOS ===\n`);
    process.exit(fail ? 1 : 0);
  }
})();
