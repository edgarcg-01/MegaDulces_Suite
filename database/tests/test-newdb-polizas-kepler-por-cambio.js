#!/usr/bin/env node
/* eslint-disable no-console */
'use strict';
/**
 * `[OPS-AUD.14]` — El reporte de pólizas de Kepler se mantiene desde el ODS por cambio, y da lo
 * MISMO que el importer que reemplaza, salvo lo que el importer hacía mal (renglones viejos).
 *
 * Aplica la migración `20261027135745` DENTRO de una transacción con ROLLBACK, sobre un mes de
 * prueba (`kdc29907` = 2099-07) para no tocar nada real. La transformación del importer
 * (`import-kepler-polizas.js`) está portada abajo y es el testigo de paridad.
 *
 *   DATABASE_URL_NEW=postgresql://postgres:postgres@127.0.0.1:5432/postgres_platform \
 *     node database/tests/test-newdb-polizas-kepler-por-cambio.js
 */
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env') });
const URL = process.env.DATABASE_URL_NEW;
require('./_lib/assert-safe-target').assertSafeTarget('test-newdb-polizas-kepler-por-cambio', { url: URL });
const { Client } = require('pg');
const migracion = require('../migrations-newdb/20261027135745_ops_aud14_polizas_kepler_por_cambio.js');

let ok = 0, bad = 0;
const t = (name, cond, extra) => {
  if (cond) { ok++; console.log(`  ✔ ${name}`); }
  else { bad++; console.log(`  ✘ ${name}${extra ? ' — ' + extra : ''}`); }
};
const M = '00000000-0000-0000-0000-00000000d01c';
const TABLA = 'kdc29907';
const Y = 2099, MES = 7, AM = '2099-07';

/** La transformación de import-kepler-polizas.js, aplicada a filas de UNA sucursal (b.code). */
function importer(rows, code, nombres) {
  const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
  const lines = [], heads = new Map();
  for (const r of rows) {
    if (!(Number(r.c5) > 0) || !['C', 'A'].includes(r.c4)) continue;
    const c14 = r.c14 == null ? null : String(r.c14);
    if (!(c14 == null || c14.trim() === '' || c14.trim() === code)) continue;
    const docRaw = (r.c15 == null || r.c16 == null || r.c17 == null || r.c18 == null) ? null
      : `${r.c15}${r.c16}${String(Number(r.c17)).padStart(2, '0')}${String(Number(r.c18)).padStart(2, '0')}`;
    const suc = String(c14 || code).trim() || code;
    const folio = (r.c19 == null || String(r.c19).trim() === '') ? 'S/F' : String(r.c19).trim();
    const doc = (docRaw || '0000').trim();
    const cuenta = String(r.c3 || '').trim();
    const imp = round2(r.c5);
    const key = `${suc}|${doc}|${folio}`;
    if (!heads.has(key)) heads.set(key, { suc, doc, folio, cargos: 0, abonos: 0, n: 0 });
    const h = heads.get(key);
    if (r.c4 === 'C') h.cargos = round2(h.cargos + imp); else h.abonos = round2(h.abonos + imp);
    h.n++;
    lines.push([suc, doc, folio, cuenta, nombres.get(cuenta) || null, cuenta.split('-')[0], cuenta.slice(0, 1), r.c4, imp.toFixed(2),
      (r.c6 || '').trim() || null, AM].join('|'));
  }
  return { lines: lines.sort(), heads: [...heads.values()].map((h) => `${h.suc}|${h.doc}|${h.folio}|${h.cargos.toFixed(2)}|${h.abonos.toFixed(2)}|${h.n}`).sort() };
}

(async () => {
  if (!URL) { console.error('falta DATABASE_URL_NEW'); process.exit(1); }
  const c = new Client({ connectionString: URL });
  await c.connect();
  const q = async (sql, b) => (await c.query(sql, b)).rows;
  const knexLike = { raw: (sql, binds) => {
    if (!binds) return c.query(sql);
    let i = 0; return c.query(sql.replace(/\?/g, () => `$${++i}`), binds);
  } };

  console.log('\n=== [OPS-AUD.14] pólizas de Kepler mantenidas por cambio desde el ODS ===\n');
  await c.query('BEGIN');
  try {
    const hay = await q(`SELECT to_regclass('analytics.gl_poliza_lines') l, to_regclass('kepler_ods.kdc22609') k, to_regclass('kepler_ods.kdco') co`);
    if (!hay[0].l || !hay[0].k || !hay[0].co) { console.log('  NO MEDIDO — faltan tablas en esta base'); await c.query('ROLLBACK'); process.exit(0); }

    await c.query(`CREATE TABLE kepler_ods.${TABLA} (LIKE kepler_ods.kdc22609)`);
    await c.query(`DELETE FROM kepler_ods.kdco WHERE sucursal = '00' AND c3 IN ('601-015','762-001','102-001','115')`);
    await c.query(`INSERT INTO kepler_ods.kdco (sucursal, c1, c2, c3) VALUES ('00','T1','SUELDOS','601-015'),('00','T2','SUA','762-001'),('00','T3','BANCOS','102-001')`);
    const fila = (o) => ({ sucursal: '00', c1: 1, c2: '2099-07-16', c3: '601-015', c4: 'C', c5: 100, c6: 'POLIZA', c8: 'x', c10: 1,
      c14: null, c15: 'X', c16: 'D', c17: 26, c18: 1, c19: '100', ...o });
    const sembrar = async (filas) => {
      const cols = Object.keys(filas[0]);
      const vals = filas.map((f, i) => `(${cols.map((_, j) => `$${i * cols.length + j + 1}`).join(',')})`).join(',');
      await c.query(`INSERT INTO kepler_ods.${TABLA} (${cols.join(',')}) VALUES ${vals}`, filas.flatMap((f) => cols.map((k) => f[k])));
    };
    // ODS ANTES de la migración (ya hay datos cuando se engancha).
    await sembrar([
      fila({ c3: '762-001', c4: 'C', c5: 500, c10: 1, c19: '200' }),            // la cuenta que Contabilidad va a corregir
      fila({ c3: '102-001', c4: 'A', c5: 500, c10: 2, c19: '200' }),
      fila({ c3: '601-015', c4: 'C', c5: 100, c10: 1 }),
      fila({ c3: '102-001', c4: 'A', c5: 100, c10: 2 }),
      fila({ c3: '102-001', c4: 'A', c5: 0, c10: 3 }),                         // $0: fuera
      fila({ c3: '115', c4: 'C', c5: 50, c10: 1, c19: '', c15: 'Y', c16: 'Z', c17: 1, c18: 1 }), // S/F
      fila({ c3: '115', c4: 'C', c5: 70, c10: 1, c19: '300', c14: '03' }),     // de OTRA plaza: fuera
      fila({ c3: '115', c4: 'C', c5: 80, c10: 1, c19: '400', c14: '00' }),     // c14 = su plaza: dentro
    ]);
    // El reporte como lo dejó el importer: un renglón VIEJO que ya no existe en Kepler, una
    // sucursal (05) que el ODS no trae para este mes, y una póliza de ContPAQi.
    await c.query(`INSERT INTO analytics.gl_poliza_lines (tenant_id, source, sucursal, ejercicio, periodo, tipo_pol, folio, num_movto, cuenta, cargo_abono, importe, anio_mes)
                   VALUES ($1,'kepler','00',$2,$3,'XD2601','999',1,'762-001','C',123,$4),
                          ($1,'kepler','05',$2,$3,'XD2601','555',1,'601-015','C',77,$4),
                          ($1,'contpaqi','00',$2,$3,'D','1',1,'601-015','C',10,$4)`, [M, Y, MES, AM]);
    await c.query(`INSERT INTO analytics.gl_polizas (tenant_id, source, sucursal, ejercicio, periodo, tipo_pol, folio, anio_mes, cargos, abonos, neto, num_lines)
                   VALUES ($1,'kepler','05',$2,$3,'XD2601','555',$4,77,0,77,1)`, [M, Y, MES, AM]);

    await migracion.up(knexLike);
    const trg = await q(`SELECT count(*)::int n FROM pg_trigger t JOIN pg_class r ON r.oid=t.tgrelid WHERE r.relname=$1 AND t.tgname LIKE 'tg_glk_%'`, [TABLA]);
    t('la migración engancha los 4 triggers en la tabla del mes', trg[0].n === 4, `n=${trg[0].n}`);

    const nombres = new Map((await q(`SELECT btrim(c3) cod, nullif(btrim(min(c2)),'') nom FROM kepler_ods.kdco WHERE sucursal='00' GROUP BY 1`)).map((r) => [r.cod, r.nom]));
    const paridad = async (etiqueta) => {
      const ods = await q(`SELECT * FROM kepler_ods.${TABLA} WHERE sucursal = '00'`);
      const esperado = importer(ods, '00', nombres);
      const lines = (await q(`SELECT sucursal||'|'||tipo_pol||'|'||folio||'|'||cuenta||'|'||coalesce(cuenta_nombre,'')||'|'||cuenta_mayor||'|'||familia||'|'||cargo_abono||'|'||to_char(importe,'FM999999990.00')||'|'||coalesce(referencia,'')||'|'||anio_mes AS k
          FROM analytics.gl_poliza_lines WHERE source='kepler' AND ejercicio=$1 AND periodo=$2 AND sucursal='00' ORDER BY 1`, [Y, MES])).map((r) => r.k);
      const heads = (await q(`SELECT sucursal||'|'||tipo_pol||'|'||folio||'|'||to_char(cargos,'FM999999990.00')||'|'||to_char(abonos,'FM999999990.00')||'|'||num_lines AS k
          FROM analytics.gl_polizas WHERE source='kepler' AND ejercicio=$1 AND periodo=$2 AND sucursal='00' ORDER BY 1`, [Y, MES])).map((r) => r.k);
      const norm = (a) => a.map((s) => s.replace(/\|\|/g, '||')).sort();
      const eL = esperado.lines.map((s) => s.replace(/\|null\|/g, '||')).map((s) => s.replace(/\|null$/, '|')).sort();
      t(`${etiqueta}: renglones = transformación del importer (${lines.length})`, JSON.stringify(norm(lines)) === JSON.stringify(eL),
        `\n      trigger ${JSON.stringify(norm(lines))}\n      importer ${JSON.stringify(eL)}`);
      t(`${etiqueta}: cabeceras = importer (${heads.length})`, JSON.stringify(heads.sort()) === JSON.stringify(esperado.heads),
        `\n      trigger ${JSON.stringify(heads)}\n      importer ${JSON.stringify(esperado.heads)}`);
    };
    const renglones = async (where) => (await q(`SELECT count(*)::int n FROM analytics.gl_poliza_lines WHERE ejercicio=$1 AND periodo=$2 AND ${where}`, [Y, MES]))[0].n;

    await paridad('carga inicial');
    t('el renglón VIEJO del importer (762-001 · folio 999) desapareció', (await renglones(`source='kepler' AND folio='999'`)) === 0);
    t('⛔ FRENO: la sucursal 05, que el ODS no trae este mes, queda intacta', (await renglones(`source='kepler' AND sucursal='05'`)) === 1
      && (await q(`SELECT count(*)::int n FROM analytics.gl_polizas WHERE source='kepler' AND sucursal='05' AND ejercicio=$1`, [Y]))[0].n === 1);
    t('ContPAQi no se toca', (await renglones(`source='contpaqi'`)) === 1);
    t('el renglón de OTRA plaza (c14=03) no entra; el de c14 = su plaza sí',
      (await renglones(`source='kepler' AND folio='300'`)) === 0 && (await renglones(`source='kepler' AND folio='400'`)) === 1);

    // ── El caso real: Contabilidad cambia la CUENTA de un renglón ──────────────
    await c.query(`UPDATE kepler_ods.${TABLA} SET c3 = '601-015' WHERE c19 = '200' AND c3 = '762-001'`);
    t('cambio de cuenta: el 762-001 viejo DESAPARECE (antes se quedaba para siempre)',
      (await renglones(`source='kepler' AND folio='200' AND cuenta='762-001'`)) === 0
      && (await renglones(`source='kepler' AND folio='200' AND cuenta='601-015'`)) === 1);
    await paridad('tras cambio de cuenta');

    const antes = await q(`SELECT folio, num_movto, cuenta, cargo_abono FROM analytics.gl_poliza_lines WHERE source='kepler' AND ejercicio=$1 ORDER BY 1,2`, [Y]);
    await c.query(`UPDATE kepler_ods.${TABLA} SET c5 = c5`);
    const despues = await q(`SELECT folio, num_movto, cuenta, cargo_abono FROM analytics.gl_poliza_lines WHERE source='kepler' AND ejercicio=$1 ORDER BY 1,2`, [Y]);
    t('num_movto es ESTABLE: reescribir todo el mes da los mismos números', JSON.stringify(antes) === JSON.stringify(despues));

    await c.query(`DELETE FROM kepler_ods.${TABLA} WHERE c19 = '100' AND c4 = 'A' AND c5 = 100`);
    t('baja de un renglón: sale del reporte y la cabecera se recalcula',
      (await renglones(`source='kepler' AND folio='100'`)) === 1
      && (await q(`SELECT abonos::text a, num_lines FROM analytics.gl_polizas WHERE source='kepler' AND folio='100' AND ejercicio=$1`, [Y]))[0]?.num_lines === 1);
    await sembrar([fila({ c3: '601-015', c4: 'C', c5: 42, c10: 1, c19: '500' })]);
    t('alta de una póliza nueva: aparece al instante', (await renglones(`source='kepler' AND folio='500'`)) === 1);
    await paridad('tras bajas y altas');

    // ── ⛔ Árbitro: en limpio 0/0; un renglón borrado a mano se detecta ───────
    const [d0] = await q(`SELECT * FROM analytics.gl_polizas_kepler_drift($1)`, [TABLA]);
    t('árbitro en limpio: 0 faltan · 0 sobran', Number(d0.faltan) === 0 && Number(d0.sobran) === 0, JSON.stringify(d0));
    await c.query(`DELETE FROM analytics.gl_poliza_lines WHERE source='kepler' AND folio='500' AND ejercicio=$1`, [Y]);
    const [d1] = await q(`SELECT * FROM analytics.gl_polizas_kepler_drift($1)`, [TABLA]);
    t('PRUEBA NEGATIVA árbitro: un renglón borrado a mano → faltan=1', Number(d1.faltan) === 1, JSON.stringify(d1));
    await q(`SELECT analytics.kepler_poliza_rebuild($1, NULL)`, [TABLA]);

    // ── ⛔ Un error dentro del trigger NO frena la ingesta ─────────────────────
    await c.query(`ALTER TABLE analytics.gl_poliza_lines ADD CONSTRAINT ck_prueba_glk CHECK (importe <> 999.99)`);
    await sembrar([fila({ c3: '601-015', c5: 999.99, c19: '600' })]);
    t('PRUEBA NEGATIVA error: el renglón SÍ entra al ODS', (await q(`SELECT count(*)::int n FROM kepler_ods.${TABLA} WHERE c19='600'`))[0].n === 1);
    const errs = await q(`SELECT tabla, operacion, sqlstate FROM analytics.gl_polizas_kepler_errors`);
    t('… y el error queda registrado', errs.length === 1 && errs[0].tabla === TABLA && errs[0].sqlstate === '23514', JSON.stringify(errs));
    await c.query(`ALTER TABLE analytics.gl_poliza_lines DROP CONSTRAINT ck_prueba_glk`);

    // ── La tabla del mes nuevo se engancha sola ───────────────────────────────
    await c.query(`CREATE TABLE kepler_ods.kdc29908 (LIKE kepler_ods.kdc22609)`);
    const auto = await q(`SELECT count(*)::int n FROM pg_trigger t JOIN pg_class r ON r.oid=t.tgrelid WHERE r.relname='kdc29908' AND t.tgname LIKE 'tg_glk_%'`);
    t('CREATE TABLE kdc29908 → sus 4 triggers se ponen solos (sin cron)', auto[0].n === 4, `n=${auto[0].n}`);

    await migracion.down(knexLike);
    const resto = await q(`SELECT (SELECT count(*)::int FROM pg_trigger WHERE tgname LIKE 'tg_glk_%') g,
                                  (SELECT count(*)::int FROM pg_event_trigger WHERE evtname = 'kdc2_gl_polizas_auto') e`);
    t('down: sin triggers ni event trigger', resto[0].g === 0 && resto[0].e === 0, JSON.stringify(resto[0]));
  } catch (e) {
    bad++; console.log(`  ✘ excepción: ${e.message}`);
  } finally {
    await c.query('ROLLBACK').catch(() => {});
    await c.end();
  }
  console.log(`\n${ok} ✔ · ${bad} ✘\n`);
  process.exit(bad ? 1 : 0);
})();
