#!/usr/bin/env node
'use strict';
/**
 * `[CP.8.86]` — **¿Quién decide la cuenta de un gasto: la categoría del banco o el proveedor?**
 *
 * `[CP.8.18]` derivó categoría → cuenta y la mayoría de las categorías salieron sin regla concluyente (una
 * categoría como «gasto admin» reparte en decenas de cuentas). La póliza de Oscar Hernández sugiere la otra llave:
 * sus 15 pagos de 2025–2026 van todos a 5200730000. Esto mide, sobre las pólizas de egreso de la contadora con
 * gasto 52xx y CFDI:
 *
 *   · por RFC: ¿qué tan concentrado está en UNA cuenta?
 *   · la regla «la cuenta que ese RFC usó ANTES» (sin mirar la póliza que se califica): ¿cuántas acierta?
 *   · la forma: una póliza por pago (1 renglón de banco) o agrupada.
 *
 *   node database/scripts/gasto-por-rfc-contpaqi.js [--desde=2025-01-01] [--hasta=2026-10-01]
 *
 * Sólo lectura, verifica `system_identifier`.
 */
const path = require('path');
const ROOT = path.resolve(__dirname, '..', '..');
require('dotenv').config({ path: path.join(ROOT, '.env'), quiet: true });
const PROD = '7688376744939610156';
const MEGA = '00000000-0000-0000-0000-00000000d01c';
const arg = (n, d) => { const p = process.argv.find((a) => a.startsWith(`--${n}=`)); return p ? p.split('=').slice(1).join('=') : d; };
const DESDE = arg('desde', '2025-01-01'); const HASTA = arg('hasta', '2026-10-01');

(async () => {
  const knex = require('knex')({ client: 'pg', connection: process.env.DATABASE_URL_NEW,
    pool: { min: 0, max: 1, afterCreate: (c, d) => c.query('SET default_transaction_read_only = on', (e) => d(e, c)) } });
  const sid = (await knex.raw('SELECT system_identifier::text AS s FROM pg_control_system()')).rows[0].s;
  if (sid !== PROD) { console.error(`⛔ no es prod (${sid})`); process.exit(1); }
  const filas = await knex.transaction(async (trx) => {
    await trx.raw(`SELECT set_config('app.tenant_id', ?, true)`, [MEGA]);
    return (await trx.raw(`
      WITH p AS (
        SELECT p.tenant_id, p.ejercicio, p.periodo, p.folio, p.fecha
          FROM analytics.gl_polizas p
         WHERE p.source='contpaqi' AND p.tipo_pol='2' AND p.fecha >= ?::date AND p.fecha < ?::date)
      SELECT p.ejercicio, p.periodo, p.folio, to_char(p.fecha,'YYYY-MM-DD') f,
             array_agg(DISTINCT l.cuenta) FILTER (WHERE l.cargo_abono='C' AND l.cuenta ~ '^52') gastos,
             array_agg(DISTINCT upper(l.cfdi_uuid)) FILTER (WHERE l.cfdi_uuid IS NOT NULL) uuids,
             count(*) FILTER (WHERE l.cargo_abono='A' AND l.cuenta ~ '^102') bancos,
             bool_or(l.cargo_abono='C' AND l.cuenta ~ '^(2120|50[12]0|2140|215)') otro_rubro
        FROM p JOIN analytics.gl_poliza_lines l ON l.tenant_id=p.tenant_id AND l.source='contpaqi' AND l.ejercicio=p.ejercicio
         AND l.periodo=p.periodo AND l.tipo_pol='2' AND l.folio=p.folio
       GROUP BY 1,2,3,4`, [DESDE, HASTA])).rows;
  });
  const gasto = filas.filter((x) => x.gastos && x.gastos.length && !x.otro_rubro);
  const todosU = [...new Set(gasto.flatMap((x) => x.uuids ?? []))];
  const rfcDe = new Map((await knex.transaction(async (trx) => {
    await trx.raw(`SELECT set_config('app.tenant_id', ?, true)`, [MEGA]);
    return (await trx.raw(`SELECT upper(uuid) u, emisor_rfc rfc FROM fiscal.cfdis WHERE rol='recibidas' AND tipo_comprobante='I' AND upper(uuid) = ANY(?)`, [todosU])).rows;
  })).map((x) => [x.u, x.rfc]));
  console.log(`[CP.8.86] pólizas de egreso con gasto 52xx (sin proveedor/tarjeta/nómina) ${DESDE} → ${HASTA}: ${gasto.length}`);
  const conCfdi = gasto.filter((x) => (x.uuids ?? []).some((u) => rfcDe.has(u)));
  const unBanco = gasto.filter((x) => Number(x.bancos) === 1).length;
  console.log(`  con CFDI de proveedor identificable: ${conCfdi.length} · una sola pata de banco: ${unBanco} · agrupadas (>1 banco): ${gasto.length - unBanco}`);
  // Una póliza → (rfc, cuenta) cuando trae UN rfc y UNA cuenta de gasto.
  const obs = conCfdi.map((x) => ({ f: x.f, rfcs: [...new Set((x.uuids ?? []).map((u) => rfcDe.get(u)).filter(Boolean))], gastos: x.gastos, bancos: Number(x.bancos) }))
    .filter((x) => x.rfcs.length === 1).map((x) => ({ ...x, rfc: x.rfcs[0] })).sort((a, b) => a.f.localeCompare(b.f));
  const unaCuenta = obs.filter((x) => x.gastos.length === 1);
  console.log(`  con un solo RFC: ${obs.length} · de ésas con UNA sola cuenta de gasto: ${unaCuenta.length}`);
  // Concentración por RFC.
  const porRfc = new Map(); for (const o of unaCuenta) { if (!porRfc.has(o.rfc)) porRfc.set(o.rfc, new Map()); const m = porRfc.get(o.rfc); m.set(o.gastos[0], (m.get(o.gastos[0]) ?? 0) + 1); }
  let rfc2 = 0, puros = 0, enModa = 0, totObs = 0;
  for (const m of porRfc.values()) { const n = [...m.values()].reduce((a, b) => a + b, 0); if (n < 2) continue; rfc2++; if (m.size === 1) puros++; enModa += Math.max(...m.values()); totObs += n; }
  console.log(`  RFC con ≥2 pólizas: ${rfc2} · usan UNA sola cuenta: ${puros} · pólizas en la cuenta más usada de su RFC: ${enModa}/${totObs} (${(100 * enModa / totObs).toFixed(1)} %)`);
  // La regla: «la cuenta más usada por ese RFC ANTES de esta póliza».
  const hist = new Map(); let pred = 0, ok = 0, sinHist = 0;
  for (const o of unaCuenta) {
    const h = hist.get(o.rfc);
    if (!h || !h.size) sinHist++;
    else { pred++; const moda = [...h.entries()].sort((a, b) => b[1] - a[1])[0][0]; if (moda === o.gastos[0]) ok++; }
    if (!hist.has(o.rfc)) hist.set(o.rfc, new Map()); const m = hist.get(o.rfc); m.set(o.gastos[0], (m.get(o.gastos[0]) ?? 0) + 1);
  }
  console.log(`  ⭐ regla «la cuenta que ese RFC usó antes»: acierta ${ok}/${pred} (${(100 * ok / pred).toFixed(1)} %) · primera vez del RFC (sin historia): ${sinHist}`);
  // Placebo: la cuenta más usada por OTRO RFC elegido al azar con historia.
  const rfcs = [...porRfc.keys()]; let pOk = 0, pN = 0; const h2 = new Map(); let seed = 7;
  const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  for (const o of unaCuenta) {
    const otros = rfcs.filter((r) => r !== o.rfc && h2.has(r));
    if (otros.length) { const r = otros[Math.floor(rnd() * otros.length)]; const moda = [...h2.get(r).entries()].sort((a, b) => b[1] - a[1])[0][0]; pN++; if (moda === o.gastos[0]) pOk++; }
    if (!h2.has(o.rfc)) h2.set(o.rfc, new Map()); const m = h2.get(o.rfc); m.set(o.gastos[0], (m.get(o.gastos[0]) ?? 0) + 1);
  }
  console.log(`  placebo (la cuenta de OTRO RFC): ${pOk}/${pN} (${(100 * pOk / pN).toFixed(1)} %)`);
  console.log(`  forma de las que tienen UN RFC: una póliza por pago ${obs.filter((x) => x.bancos === 1).length} · agrupadas ${obs.filter((x) => x.bancos > 1).length}`);
  await knex.destroy();
})().catch((e) => { console.error('ERR', e && e.stack); process.exit(1); });
