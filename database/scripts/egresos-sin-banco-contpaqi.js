#!/usr/bin/env node
'use strict';
/**
 * `[CP.8.85]` — **Pólizas de egreso de la contadora sin movimiento de banco que case: ¿por qué?**
 *
 * `[CP.8.83]` encontró 717 pólizas ($76.1 M, ene–sep 2026) cuyo renglón de banco no casa con ningún movimiento de
 * Bancos (misma cuenta, mismo importe, ±3 días). Por cada renglón de banco se busca en `finance.bank_movements`
 * —TODOS los movimientos, también los que el puente no toma— y se clasifica:
 *
 *   cuenta_sin_bancos      la cuenta de ContPAQi no está ligada a ninguna cuenta de Bancos (`contpaqi_cuenta`)
 *   mes_sin_estado         la cuenta existe pero no hay estado de cuenta cargado ese mes
 *   iva_aparte             el banco trae el importe partido en subtotal + IVA (dos movimientos) y ella uno
 *   suma_del_dia           la suma de 2–6 movimientos de ese día y cuenta da el importe (ella agrupó)
 *   fecha_fuera            el mismo importe existe en la cuenta pero a más de 3 días
 *   es_deposito            el importe existe como DEPÓSITO (ella lo asentó como egreso)
 *   ya_usado               el movimiento existe pero ya casó con otra póliza suya
 *   no_existe              nada de lo anterior
 *
 *   node database/scripts/egresos-sin-banco-contpaqi.js --desde=2026-01 --hasta=2026-09 [--json=salida.json]
 *
 * Sólo lectura, verifica `system_identifier`.
 */
const path = require('path');
const fs = require('fs');
const ROOT = path.resolve(__dirname, '..', '..');
require('dotenv').config({ path: path.join(ROOT, '.env'), quiet: true });

const PROD = '7688376744939610156';
const MEGA = '00000000-0000-0000-0000-00000000d01c';
const arg = (n, d) => { const p = process.argv.find((a) => a.startsWith(`--${n}=`)); return p ? p.split('=').slice(1).join('=') : d; };
const DESDE = arg('desde', '2026-01'); const HASTA = arg('hasta', DESDE); const JSON_OUT = arg('json', null);
const cent = (n) => Math.round(Number(n) * 100);
const dias = (a, b) => Math.round((Date.parse(`${a}T12:00:00Z`) - Date.parse(`${b}T12:00:00Z`)) / 86400000);
const finMes = (m) => { const [y, mm] = m.split('-').map(Number); return new Date(Date.UTC(y, mm, 1)).toISOString().slice(0, 10); };

(async () => {
  const knex = require('knex')({ client: 'pg', connection: process.env.DATABASE_URL_NEW,
    pool: { min: 0, max: 1, afterCreate: (c, d) => c.query('SET default_transaction_read_only = on', (e) => d(e, c)) } });
  const sid = (await knex.raw('SELECT system_identifier::text AS s FROM pg_control_system()')).rows[0].s;
  if (sid !== PROD) { console.error(`⛔ no es prod (${sid})`); process.exit(1); }
  const r = await knex.transaction(async (trx) => {
    await trx.raw(`SELECT set_config('app.tenant_id', ?, true)`, [MEGA]);
    const lineas = (await trx.raw(`
      SELECT p.ejercicio, p.periodo, p.folio, p.concepto, to_char(p.fecha,'YYYY-MM-DD') f, l.num_movto, l.cuenta, l.cuenta_nombre, l.importe::float8 imp
        FROM analytics.gl_poliza_lines l
        JOIN analytics.gl_polizas p ON p.tenant_id=l.tenant_id AND p.source=l.source AND p.ejercicio=l.ejercicio AND p.periodo=l.periodo AND p.tipo_pol=l.tipo_pol AND p.folio=l.folio
       WHERE l.source='contpaqi' AND l.tipo_pol='2' AND l.cargo_abono='A' AND l.cuenta ~ '^102'
         AND p.fecha >= ?::date AND p.fecha < ?::date`, [`${DESDE}-01`, finMes(HASTA)])).rows;
    const movs = (await trx.raw(`
      SELECT m.id, ba.contpaqi_cuenta cta, to_char(m.movement_date,'YYYY-MM-DD') f, m.amount_out::float8 sale, m.amount_in::float8 entra,
             c.code cat, coalesce(m.concept, m.raw_code, '') concepto
        FROM finance.bank_movements m JOIN finance.bank_accounts ba ON ba.id = m.bank_account_id
        LEFT JOIN finance.movement_categories c ON c.id = m.category_id
       WHERE m.tenant_id = ? AND m.deleted_at IS NULL AND ba.contpaqi_cuenta IS NOT NULL
         AND m.movement_date >= ?::date - 10 AND m.movement_date < ?::date + 10`, [MEGA, `${DESDE}-01`, finMes(HASTA)])).rows;
    const estados = (await trx.raw(`
      SELECT DISTINCT ba.contpaqi_cuenta cta, st.period FROM finance.bank_statements st JOIN finance.bank_accounts ba ON ba.id = st.bank_account_id
       WHERE ba.contpaqi_cuenta IS NOT NULL`)).rows;
    const cuentas = (await trx.raw(`SELECT DISTINCT contpaqi_cuenta cta FROM finance.bank_accounts WHERE contpaqi_cuenta IS NOT NULL`)).rows;
    return { lineas, movs, estados, cuentas };
  });
  const ctas = new Set(r.cuentas.map((x) => x.cta));
  const conEstado = new Set(r.estados.map((x) => `${x.cta}|${x.period}`));
  const porCta = new Map(); for (const m of r.movs) { if (!porCta.has(m.cta)) porCta.set(m.cta, []); porCta.get(m.cta).push(m); }

  // 1ª pasada, igual que el universo: cada renglón contra un egreso de la misma cuenta, mismo importe, ±3 días.
  const usados = new Set(); const sinPar = [];
  const ordenadas = [...r.lineas].sort((a, b) => a.f.localeCompare(b.f) || a.folio.localeCompare(b.folio));
  for (const l of ordenadas) {
    const c = (porCta.get(l.cuenta) ?? []).filter((m) => !usados.has(m.id) && cent(m.sale) === cent(l.imp) && Math.abs(dias(m.f, l.f)) <= 3)
      .sort((a, b) => Math.abs(dias(a.f, l.f)) - Math.abs(dias(b.f, l.f)));
    if (c.length) usados.add(c[0].id); else sinPar.push(l);
  }
  // 2ª: la causa de cada renglón sin par.
  const causas = {}; const detalle = [];
  const contar = (k, l) => { causas[k] = causas[k] ?? { renglones: 0, importe: 0, cuentas: new Map() }; causas[k].renglones++; causas[k].importe += l.imp;
    const n = `${l.cuenta} ${l.cuenta_nombre ?? ''}`.trim(); causas[k].cuentas.set(n, (causas[k].cuentas.get(n) ?? 0) + 1); };
  for (const l of sinPar) {
    const ms = porCta.get(l.cuenta) ?? [];
    const delDia = ms.filter((m) => m.f === l.f && m.sale > 0 && !usados.has(m.id));
    let causa;
    if (!ctas.has(l.cuenta)) causa = 'cuenta_sin_bancos';
    else if (!conEstado.has(`${l.cuenta}|${l.f.slice(0, 7)}`)) causa = 'mes_sin_estado';
    else if (delDia.some((m) => delDia.some((n) => n.id !== m.id && Math.abs(cent(m.sale) + cent(n.sale) - cent(l.imp)) <= 1 && Math.abs(cent(n.sale) - Math.round(cent(m.sale) * 0.16)) <= 2))) causa = 'iva_aparte';
    else {
      // ¿Suma de 2..6 movimientos del día? (cota: los 18 más grandes por debajo del importe)
      const cand = delDia.filter((m) => cent(m.sale) < cent(l.imp)).sort((a, b) => b.sale - a.sale).slice(0, 18);
      let suma = false;
      const rec = (i, s, n) => { if (suma) return; if (n >= 2 && Math.abs(s - cent(l.imp)) <= 1) { suma = true; return; } if (n >= 6 || i >= cand.length || s > cent(l.imp)) return; rec(i + 1, s + cent(cand[i].sale), n + 1); rec(i + 1, s, n); };
      rec(0, 0, 0);
      const mismoImp = ms.filter((m) => cent(m.sale) === cent(l.imp));
      if (suma) causa = 'suma_del_dia';
      else if (mismoImp.some((m) => !usados.has(m.id) && Math.abs(dias(m.f, l.f)) > 3)) causa = 'fecha_fuera';
      else if (mismoImp.some((m) => usados.has(m.id))) causa = 'ya_usado';
      else if (ms.some((m) => cent(m.entra) === cent(l.imp) && Math.abs(dias(m.f, l.f)) <= 3)) causa = 'es_deposito';
      else causa = 'no_existe';
    }
    contar(causa, l);
    detalle.push({ causa, poliza: `${l.periodo}/${l.ejercicio} ${l.folio}`, fecha: l.f, cuenta: l.cuenta, banco: l.cuenta_nombre, importe: l.imp, concepto: l.concepto });
  }
  const tot = sinPar.reduce((a, l) => a + l.imp, 0);
  console.log(`[CP.8.85] renglones de banco de egresos sin movimiento que case · ${DESDE} → ${HASTA}: ${sinPar.length} de ${r.lineas.length} · $${(tot / 1e6).toFixed(1)} M`);
  for (const [k, v] of Object.entries(causas).sort((a, b) => b[1].importe - a[1].importe)) {
    console.log(`  ${k.padEnd(18)} ${String(v.renglones).padStart(5)}  $${(v.importe / 1e6).toFixed(2).padStart(7)} M   ${[...v.cuentas.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([c, n]) => `${c} (${n})`).join(' · ')}`);
  }
  if (JSON_OUT) fs.writeFileSync(JSON_OUT, JSON.stringify({ desde: DESDE, hasta: HASTA, detalle }, null, 1));
  await knex.destroy();
})().catch((e) => { console.error('ERR', e && e.stack); process.exit(1); });
