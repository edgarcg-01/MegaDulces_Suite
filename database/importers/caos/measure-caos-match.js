/**
 * CS.0/CS.4 — Sonda de MEDICIÓN (read-only) del cruce CAOS ↔ Kepler caja 0011.
 *
 * NO escribe nada. Contesta la única pregunta que decide si el árbitro es viable:
 * ¿el cruce por importe + fecha entre el conteo de la máquina (CAOS) y la contabilidad de la Caja
 * General (Kepler `kdm1 c45=0011`, sucursal 00) SIGNIFICA algo, o es ruido de densidad de importes?
 *
 * Un cruce por importe sin su PLACEBO no significa nada (regla del proyecto). Por eso mide tres cosas:
 *   1. match exacto   — importe igual (al peso) Y |fecha| ≤ 1 día  → la señal
 *   2. match sólo-importe — importe igual en CUALQUIER día del período → el techo de ambigüedad
 *   3. PLACEBO — se barajan las fechas de CAOS y se repite el match exacto → el piso de ruido
 * Si (1) ≈ (3), la fecha no aporta y los importes son demasiado densos: el árbitro sería teatro.
 *
 * Corre en `md` (feeds-cron): alcanza CAOS (192.168.0.110) y prod (`DATABASE_URL_NEW`).
 *   CAOS_USER=… CAOS_PASS=… node measure-caos-match.js
 */
'use strict';
const { CaosAdapter } = require('./caos-adapter');
const { Client } = require('pg');

const TENANT = process.env.CRON_TENANT_ID || '00000000-0000-0000-0000-00000000d01c';
const DAY = 86400000;

function parseTotal(t) {
  const s = Array.isArray(t) ? (t[0] || '') : String(t || '');
  return Math.round((Number(s.replace(/[^0-9.\-]/g, '')) || 0) * 100); // centavos
}
function parseDia(s) { // "24/09/2026 10:03:34" → epoch del día (MX)
  const m = /(\d{2})\/(\d{2})\/(\d{4})/.exec(String(s || ''));
  return m ? Date.parse(`${m[3]}-${m[2]}-${m[1]}T00:00:00-06:00`) : NaN;
}

async function main() {
  const a = new CaosAdapter();
  if (!a.isConfigured()) throw new Error('CAOS sin credenciales (CAOS_USER/CAOS_PASS)');

  // Todo el histórico de CAOS.
  const from = new Date('2026-01-01T00:00:00-06:00');
  const to = new Date();
  const tx = await a.getTransactions({ from, to });
  const dep = tx.filter((t) => /dep[oó]sito/i.test(t.type)).map((t) => ({ cent: parseTotal(t.transactionTotal), dia: parseDia(t.date) }));
  const dis = tx.filter((t) => /dispensar/i.test(t.type)).map((t) => ({ cent: parseTotal(t.transactionTotal), dia: parseDia(t.date) }));
  console.log(`CAOS: ${tx.length} movimientos · ${dep.length} depósitos · ${dis.length} dispensaciones`);

  const c = new Client({ connectionString: process.env.DATABASE_URL_NEW, ssl: false, statement_timeout: 60000 });
  await c.connect();

  // Diagnóstico de la Caja General 0011 en prod (sucursal 00).
  const diag = await c.query(`
    SELECT clave_banco, tipo_cuenta, count(*) n
      FROM analytics.kepler_bank_movements
     WHERE tenant_id=$1 AND sucursal='00'
     GROUP BY 1,2 ORDER BY n DESC LIMIT 8`, [TENANT]);
  console.log('Kepler suc 00 por clave/tipo:');
  diag.rows.forEach((r) => console.log(`   clave=${r.clave_banco} tipo=${r.tipo_cuenta} n=${r.n}`));

  // Lado Kepler caja: importe (centavos) + día, para el período de CAOS.
  const kep = await c.query(`
    SELECT round(importe*100)::bigint cent, fecha_valor::text fv, signo
      FROM analytics.kepler_bank_movements
     WHERE tenant_id=$1 AND sucursal='00' AND tipo_cuenta='caja'
       AND fecha_valor >= '2026-05-01'`, [TENANT]);
  console.log(`Kepler caja (suc 00, tipo_cuenta=caja, desde 2026-05): ${kep.rows.length} movimientos`);

  // Índices por importe → lista de días, y por (importe,día) para el match exacto.
  const porImporte = new Map();
  const porImpDia = new Set();
  for (const r of kep.rows) {
    const dia = Date.parse(r.fv + 'T00:00:00-06:00');
    if (!porImporte.has(r.cent)) porImporte.set(r.cent, []);
    porImporte.get(r.cent).push(dia);
    porImpDia.add(`${r.cent}|${r.fv}`);
  }

  const matchExacto = (arr, corrimientoDias = 0) => {
    let ok = 0;
    for (const d of arr) {
      if (!Number.isFinite(d.dia) || !d.cent) continue;
      const dias = porImporte.get(d.cent);
      if (!dias) continue;
      const centro = d.dia + corrimientoDias * DAY;
      if (dias.some((kd) => Math.abs(kd - centro) <= 1 * DAY)) ok++;
    }
    return ok;
  };
  const matchSoloImporte = (arr) => arr.filter((d) => d.cent && porImporte.has(d.cent)).length;

  const pct = (n, d) => d ? (100 * n / d).toFixed(1) + '%' : 'n/a';

  for (const [nombre, arr] of [['DEPÓSITOS', dep], ['DISPENSACIONES', dis]]) {
    const exacto = matchExacto(arr);
    const soloImp = matchSoloImporte(arr);
    // Placebo: correr las fechas de CAOS +37 días (fuera de su ventana real) y re-match exacto.
    const placebo = matchExacto(arr, 37);
    console.log(`\n${nombre} (${arr.length}):`);
    console.log(`   match exacto (importe + ≤1día) : ${exacto}  (${pct(exacto, arr.length)})`);
    console.log(`   match sólo-importe (techo)     : ${soloImp}  (${pct(soloImp, arr.length)})`);
    console.log(`   PLACEBO (fecha +37d, piso ruido): ${placebo}  (${pct(placebo, arr.length)})`);
    const señal = exacto - placebo;
    console.log(`   → señal sobre el ruido          : ${señal}  (${pct(señal, arr.length)}) ${señal <= placebo ? '⚠️ el cruce por importe+fecha NO se distingue del ruido' : '✅ hay señal por encima del placebo'}`);
  }

  await c.end();
}

main().catch((e) => { console.error('FALLÓ:', e.message); process.exit(1); });
