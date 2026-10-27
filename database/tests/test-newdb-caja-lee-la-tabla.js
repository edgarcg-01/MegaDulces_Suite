#!/usr/bin/env node
/* eslint-disable no-console */
'use strict';
/**
 * `[OPS-AUD.11.4]` (ADR-104) — Caja General y Bancos leen la tabla mantenida por trigger, y lo
 * que publican es EXACTAMENTE lo que publicaban antes.
 *
 * Aplica 11.1 y 11.4 DENTRO de una transacción, siembra datos sintéticos y hace ROLLBACK.
 *
 * Qué prueba:
 *   · `kepler_bank_movements`, `mv_caja_movimientos` y la bandeja `v_caja_movimientos_pendientes`
 *     dan lo mismo antes (vista que recorre kdm1 + materializada refrescada) y después;
 *   · la bandeja se repone con su `security_invoker` y sus permisos;
 *   · un movimiento nuevo de caja aparece AL INSTANTE, sin refrescar nada;
 *   · el payload del aviso trae la firma que leen caja-realtime y caja-autollenado, y `suma`;
 *   · ⛔ la migración ABORTA si la vista nueva no da lo mismo que la vieja (prueba negativa);
 *   · ⛔ un error en el aviso no frena la escritura de kdm1 y queda registrado (prueba negativa);
 *   · `down` vuelve a la materializada con sus índices, y `up` es repetible.
 *
 * ⚠️ NO MEDIDO acá: la ENTREGA del NOTIFY (en una transacción revertida nunca sale). Se verifica
 *    en prod con `LISTEN caja_movimientos` después de aplicar.
 *
 *   DATABASE_URL_NEW=postgresql://postgres:postgres@127.0.0.1:5432/postgres_platform \
 *     node database/tests/test-newdb-caja-lee-la-tabla.js
 */
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env') });
const URL = process.env.DATABASE_URL_NEW;
require('./_lib/assert-safe-target').assertSafeTarget('test-newdb-caja-lee-la-tabla', { url: URL });
const { Client } = require('pg');
const m111 = require('../migrations-newdb/20261027124906_ops_aud11_bank_movement_legs.js');
const m114 = require('../migrations-newdb/20261027153139_ops_aud11_4_caja_lee_la_tabla.js');

const M = '00000000-0000-0000-0000-00000000d01c';
let ok = 0, bad = 0;
const t = (name, cond, extra) => {
  if (cond) { ok++; console.log(`  ✔ ${name}`); }
  else { bad++; console.log(`  ✘ ${name}${extra ? ' — ' + extra : ''}`); }
};

(async () => {
  if (!URL) { console.error('falta DATABASE_URL_NEW'); process.exit(1); }
  const c = new Client({ connectionString: URL });
  await c.connect();
  const q = async (sql, b) => (await c.query(sql, b)).rows;
  const knexLike = {
    raw: (sql, binds) => {
      if (!binds) return c.query(sql);
      let i = 0;
      return c.query(sql.replace(/\?/g, () => `$${++i}`), binds);
    },
  };
  const silencio = async (fn) => { const l = console.log; console.log = () => {}; try { return await fn(); } finally { console.log = l; } };

  console.log('\n=== [OPS-AUD.11.4] la caja lee la tabla, sin REFRESH ===\n');
  await c.query('BEGIN');
  try {
    const [hay] = await q(`SELECT to_regclass('analytics.kepler_bank_movements') v,
      (SELECT relkind::text FROM pg_class WHERE oid = to_regclass('analytics.mv_caja_movimientos')) mv,
      to_regclass('finance.v_caja_movimientos_pendientes') p, to_regclass('analytics.v_kepler_payment_complement') pc`);
    if (!hay.v || hay.mv !== 'm' || !hay.p || !hay.pc) {
      console.log(`  NO MEDIDO — esta base no tiene la forma de antes (mv=${hay.mv})`);
      await c.query('ROLLBACK'); await c.end(); process.exit(0);
    }
    await c.query('DELETE FROM kepler_ods.kdm1');
    await c.query('DELETE FROM kepler_ods.kdb1');
    await c.query(`SET LOCAL app.tenant_id = '${M}'`);

    await c.query(`INSERT INTO kepler_ods.kdb1 (sucursal, c1, c2, c3, c5) VALUES
      ('01','0011','CAJA GENERAL','EFECTIVO','1020001'),
      ('01','0012','CAJA CHICA','EFECTIVO','1020002'),
      ('01','0201','BANBAJIO','','1020201'),
      ('01','9001','PUENTE','','2050001')`);
    const doc = (c4, folio, c45, extra = {}) => ({
      sucursal: '01', c1: '01', c2: extra.c2 || 'X', c3: extra.c3 || 'A', c4, c5: 1, c6: folio, c45,
      c9: '2026-10-27', c68: '2026-10-27 10:00', c16: 1500, c24: `concepto ${folio}`, c31: extra.c31 || null,
      c32: 'beneficiario', c10: 'E01', c43: extra.c43 || null, c47: extra.c47 || null,
    });
    const insertar = async (filas) => {
      const campos = Object.keys(filas[0]);
      const valores = filas.map((f, i) => `(${campos.map((_, j) => `$${i * campos.length + j + 1}`).join(',')})`).join(',');
      await c.query(`INSERT INTO kepler_ods.kdm1 (${campos.join(',')}) VALUES ${valores}`, filas.flatMap((f) => campos.map((k) => f[k])));
    };
    await insertar([
      doc(45, 'C1', '0011'),                                          // entrada a caja
      doc(26, 'C2', '0012', { c2: 'X', c3: 'D' }),                    // salida de caja chica
      doc(26, 'C3', '0201', { c2: 'X', c3: 'D' }),                    // salida de banco
      doc(26, 'C4', '0201', { c2: 'N', c3: 'A', c47: '0011' }),       // traspaso banco → caja
      doc(45, 'C5', '0011', { c43: 'C' }),                            // cancelado
      doc(99, 'C6', '9001', { c2: 'Y', c3: 'Z', c31: 'Cob' }),        // puente
    ]);

    await silencio(() => m111.up(knexLike));

    // ── La FOTO de antes: vista que recorre kdm1 + materializada refrescada + bandeja ────────
    await c.query('REFRESH MATERIALIZED VIEW analytics.mv_caja_movimientos');
    const COLS_V = (await q(`SELECT attname FROM pg_attribute WHERE attrelid='analytics.kepler_bank_movements'::regclass
                               AND attnum>0 AND NOT attisdropped AND attname<>'computed_at' ORDER BY attnum`)).map((r) => `"${r.attname}"`).join(', ');
    const COLS_MV = (await q(`SELECT attname FROM pg_attribute WHERE attrelid='analytics.mv_caja_movimientos'::regclass
                               AND attnum>0 AND NOT attisdropped ORDER BY attnum`)).map((r) => `"${r.attname}"`).join(', ');
    await c.query(`CREATE TEMP TABLE _v0 AS SELECT ${COLS_V} FROM analytics.kepler_bank_movements`);
    await c.query(`CREATE TEMP TABLE _mv0 AS SELECT ${COLS_MV} FROM analytics.mv_caja_movimientos`);
    await c.query(`CREATE TEMP TABLE _p0 AS SELECT * FROM finance.v_caja_movimientos_pendientes`);
    const [acl0] = await q(`SELECT reloptions, relacl::text acl FROM pg_class WHERE oid='finance.v_caja_movimientos_pendientes'::regclass`);
    const [n0] = await q(`SELECT (SELECT count(*) FROM _v0)::int v, (SELECT count(*) FROM _mv0)::int mv, (SELECT count(*) FROM _p0)::int p`);
    t(`la foto de antes tiene datos (vista ${n0.v}, caja ${n0.mv}, bandeja ${n0.p})`, n0.v === 6 && n0.mv === 3 && n0.p === 2,
      JSON.stringify(n0));

    // ── ⛔ PRUEBA NEGATIVA: si la nueva no da lo mismo, la migración aborta sin tocar nada ────
    await c.query('SAVEPOINT neg');
    await c.query(`DELETE FROM analytics.bank_movement_legs WHERE folio='C1'`);  // tabla desfasada a mano
    let aborto = null;
    try { await silencio(() => m114.up(knexLike)); } catch (e) { aborto = e.message; }
    await c.query('ROLLBACK TO SAVEPOINT neg');
    t('PRUEBA NEGATIVA: con la tabla desfasada la migración ABORTA', !!aborto && /NO da lo mismo/.test(aborto), aborto || 'no abortó');
    const [kind0] = await q(`SELECT relkind::text k FROM pg_class WHERE oid='analytics.mv_caja_movimientos'::regclass`);
    t('…y la caja sigue materializada (no tocó nada)', kind0.k === 'm');

    // ── La migración ─────────────────────────────────────────────────────────────────────────
    const autofill = async () => (await q(`SELECT (SELECT relkind::text FROM pg_class WHERE oid = to_regclass('analytics.mv_caja_autofill_entidad')) k`))[0].k;
    const hayAutofill = (await autofill()) === 'm' && !!(await q(`SELECT to_regclass('kepler_ods.kdxf') a, to_regclass('kepler_ods.kdc22610') b`))
      .every((r) => r.a && r.b);
    if (hayAutofill) {
      // C1 (pendiente de caja, entidad E01) → su documento destino D1 → póliza con UNA cuenta:
      // lo mínimo para que el autollenado publique una entidad.
      await c.query(`INSERT INTO kepler_ods.kdxf (sucursal,c1,c2,c3,c4,c5,c6,c7,c8,c9)
                     VALUES ('01','01','x','2026-10-27',45,1,'C1',26,1,'D1')`);
      await c.query(`INSERT INTO kepler_ods.kdc22610 (sucursal,c1,c2,c3,c8,c10,c14,c17,c19)
                     VALUES ('01',1,'2026-10-27','601-001','D',1,'01',26,'D1')`);
      await c.query(`REFRESH MATERIALIZED VIEW analytics.mv_caja_autofill_entidad`);
    }
    const filasAutofill = hayAutofill ? (await q(`SELECT count(*)::int n FROM analytics.mv_caja_autofill_entidad`))[0].n : null;
    // Como en prod: la migración corre SIN tenant en la sesión (si la prueba se lo dejara puesto,
    // pasaría aunque la migración no lo fijara — y ése es justo el defecto que hay que cazar).
    await c.query(`SELECT set_config('app.tenant_id', '', true)`);
    await silencio(() => m114.up(knexLike));
    t('la migración deja el tenant de la sesión como estaba (vacío)',
      ((await q(`SELECT current_setting('app.tenant_id', true) t`))[0].t || '') === '');
    await c.query(`SELECT set_config('app.tenant_id', $1, true)`, [M]);
    if (hayAutofill) {
      const n = (await q(`SELECT count(*)::int n FROM analytics.mv_caja_autofill_entidad`))[0].n;
      t(`la nieta materializada (mv_caja_autofill_entidad) se repone con sus filas (${filasAutofill} → ${n})`,
        (await autofill()) === 'm' && n === filasAutofill && filasAutofill > 0, `antes=${filasAutofill} después=${n}`);
    } else {
      console.log('  NO MEDIDO — esta base no tiene mv_caja_autofill_entidad');
    }
    const [kind1] = await q(`SELECT relkind::text k FROM pg_class WHERE oid='analytics.mv_caja_movimientos'::regclass`);
    t('mv_caja_movimientos ya es VISTA (nada que refrescar)', kind1.k === 'v', kind1.k);

    const igual = async (etiqueta, foto, sql) => {
      const [r] = await q(`WITH n AS (${sql})
        SELECT (SELECT count(*) FROM (SELECT * FROM ${foto} EXCEPT ALL SELECT * FROM n) a)::int faltan,
               (SELECT count(*) FROM (SELECT * FROM n EXCEPT ALL SELECT * FROM ${foto}) b)::int sobran`);
      t(`${etiqueta}: igual que antes`, r.faltan === 0 && r.sobran === 0, `faltan=${r.faltan} sobran=${r.sobran}`);
    };
    await igual('kepler_bank_movements', '_v0', `SELECT ${COLS_V} FROM analytics.kepler_bank_movements`);
    await igual('mv_caja_movimientos', '_mv0', `SELECT ${COLS_MV} FROM analytics.mv_caja_movimientos`);
    await igual('bandeja v_caja_movimientos_pendientes', '_p0', `SELECT * FROM finance.v_caja_movimientos_pendientes`);
    const [acl1] = await q(`SELECT reloptions, relacl::text acl FROM pg_class WHERE oid='finance.v_caja_movimientos_pendientes'::regclass`);
    t('la bandeja conserva security_invoker y permisos',
      JSON.stringify(acl1.reloptions) === JSON.stringify(acl0.reloptions) && acl1.acl === acl0.acl,
      `${JSON.stringify(acl1)} vs ${JSON.stringify(acl0)}`);

    // ── En vivo, sin refrescar ───────────────────────────────────────────────────────────────
    await insertar([doc(45, 'C7', '0011', { c16: 321.5 })]);
    t('un movimiento nuevo de caja aparece AL INSTANTE en la caja y en la bandeja',
      (await q(`SELECT count(*)::int n FROM analytics.mv_caja_movimientos WHERE folio='C7'`))[0].n === 1
      && (await q(`SELECT count(*)::int n FROM finance.v_caja_movimientos_pendientes WHERE folio='C7'`))[0].n === 1);
    await c.query(`UPDATE kepler_ods.kdm1 SET c16 = 400 WHERE c6='C7'`);
    t('una corrección de importe se ve al instante',
      (await q(`SELECT importe::numeric i FROM analytics.mv_caja_movimientos WHERE folio='C7'`))[0].i === '400.00'
      || Number((await q(`SELECT importe i FROM analytics.mv_caja_movimientos WHERE folio='C7'`))[0].i) === 400);

    // ── El payload del aviso ─────────────────────────────────────────────────────────────────
    const pl = (await q(`SELECT analytics.caja_aviso_payloads() p`)).map((r) => JSON.parse(r.p));
    const [agg] = await q(`SELECT count(*)::int filas, max(folio) mf, max(fecha_captura)::text mc, round(sum(importe),2)::text s
                             FROM analytics.mv_caja_movimientos`);
    t('payload: un aviso por tenant', pl.length === 1 && pl[0].tenant_id === M, JSON.stringify(pl));
    t('payload: filas/max_folio/max_captura/suma iguales al agregado de la caja',
      pl[0].filas === agg.filas && pl[0].max_folio === agg.mf && pl[0].max_captura === agg.mc && pl[0].suma === agg.s,
      `${JSON.stringify(pl[0])} vs ${JSON.stringify(agg)}`);
    t('payload: la firma es filas|max_folio|max_captura|suma (la que arma caja-autollenado)',
      pl[0].firma === `${pl[0].filas}|${pl[0].max_folio}|${pl[0].max_captura}|${pl[0].suma}`, pl[0].firma);
    const trg = await q(`SELECT tgname FROM pg_trigger WHERE tgrelid='analytics.bank_movement_legs'::regclass AND NOT tgisinternal ORDER BY 1`);
    t('3 triggers de aviso en la tabla', trg.length === 3, trg.map((r) => r.tgname).join(','));

    // ── ⛔ PRUEBA NEGATIVA: un aviso que falla no frena la ingesta ──────────────────────────
    await c.query(`ALTER FUNCTION analytics.caja_aviso_payloads() RENAME TO caja_aviso_payloads_x`);
    await insertar([doc(45, 'C8', '0011')]);
    await c.query(`ALTER FUNCTION analytics.caja_aviso_payloads_x() RENAME TO caja_aviso_payloads`);
    t('PRUEBA NEGATIVA aviso roto: el kdm1 se escribe y la pierna también',
      (await q(`SELECT count(*)::int n FROM kepler_ods.kdm1 WHERE c6='C8'`))[0].n === 1
      && (await q(`SELECT count(*)::int n FROM analytics.bank_movement_legs WHERE folio='C8'`))[0].n === 1);
    t('…y el error queda registrado',
      (await q(`SELECT count(*)::int n FROM analytics.bank_movement_legs_errors WHERE tabla='bank_movement_legs:aviso'`))[0].n >= 1);
    t('un movimiento de BANCO no avisa a la caja (no registra nada aunque el aviso esté roto)', await (async () => {
      await c.query(`ALTER FUNCTION analytics.caja_aviso_payloads() RENAME TO caja_aviso_payloads_x`);
      const [a] = await q(`SELECT count(*)::int n FROM analytics.bank_movement_legs_errors`);
      await insertar([doc(26, 'C9', '0201', { c2: 'X', c3: 'D' })]);
      const [b] = await q(`SELECT count(*)::int n FROM analytics.bank_movement_legs_errors`);
      await c.query(`ALTER FUNCTION analytics.caja_aviso_payloads_x() RENAME TO caja_aviso_payloads`);
      return a.n === b.n;
    })());

    // ── down y up de nuevo ───────────────────────────────────────────────────────────────────
    await silencio(() => m114.down(knexLike));
    const [kind2] = await q(`SELECT relkind::text k,
      (SELECT count(*)::int FROM pg_indexes WHERE schemaname='analytics' AND tablename='mv_caja_movimientos') ix
      FROM pg_class WHERE oid='analytics.mv_caja_movimientos'::regclass`);
    t('down: vuelve a materializada con sus 2 índices', kind2.k === 'm' && kind2.ix === 2, JSON.stringify(kind2));
    t('down: la bandeja sigue existiendo', !!(await q(`SELECT to_regclass('finance.v_caja_movimientos_pendientes') r`))[0].r);
    await silencio(() => m114.up(knexLike));
    await silencio(() => m114.up(knexLike));
    const [kind3] = await q(`SELECT relkind::text k FROM pg_class WHERE oid='analytics.mv_caja_movimientos'::regclass`);
    t('up repetible (dos veces seguidas): queda en vista', kind3.k === 'v');
  } catch (e) {
    bad++; console.log(`  ✘ excepción: ${e.message}`);
  } finally {
    await c.query('ROLLBACK').catch(() => {});
    await c.end();
  }
  console.log(`\n  ${ok} ✔ · ${bad} ✘\n`);
  process.exit(bad ? 1 : 0);
})();
