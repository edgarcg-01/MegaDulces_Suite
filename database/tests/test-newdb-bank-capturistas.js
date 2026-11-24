/* eslint-disable no-console */
/**
 * [BFU.4.5.10] CANDADO — quién responde por los depósitos de cada CUENTA se DERIVA de quién los captura en Kepler.
 *
 * `analytics.v_kepler_deposit_capturers` (vista sobre la conciliación y el ODS) + `identity.user_kepler_logins` (el par
 * login de Kepler → usuario de la Suite, dato propio). Verifica:
 *   (1) la tabla y la vista existen (la migración 20261124100054 corrió) y la vista es `security_invoker` (si no, se
 *       lee con los permisos de su dueño y se salta el RLS de `finance.bank_movements`);
 *   (2) la vista NO infla: por cuenta, sus depósitos no pasan de los depósitos distintos casados con `U-A-5`/`U-A-7`
 *       en los últimos 30 días, y declara cuántos quedaron sin capturista;
 *   (3) cada cuenta con depósitos tiene un primer lugar (los empates se declaran);
 *   (4) en base LOCAL, dentro de una transacción que se deshace, con filas sintéticas en una cuenta sintética:
 *       a. NEGATIVA: un login en minúsculas o con espacios se rechaza (CHECK);
 *       b. NEGATIVA: el mismo login vivo dos veces se rechaza; dado de baja, se puede volver a dar de alta;
 *       c. dos depósitos capturados por « zzprueba » (U-A-5) y uno por ZZOTRO (U-A-7): ZZPRUEBA primer lugar con
 *          2 depósitos de venta y parte 0.667, ZZOTRO segundo con 1 de cobro, y ZZPRUEBA con el usuario del par;
 *       d. NEGATIVAS de lo que NO cuenta: un retiro casado con un U-A-5, un depósito de hace 40 días, y el segundo
 *          documento de un depósito casado con dos (cuenta una vez, por el de mayor importe);
 *       e. NEGATIVA: con el par dado de baja, la vista ya no da usuario.
 *
 *   DATABASE_URL_NEW=... node database/tests/test-newdb-bank-capturistas.js
 */
'use strict';
const { Client } = require('pg');
const { classify } = require('../../libs/platform-core/src/lib/provenance/target-guard.js');

(async () => {
  let ok = 0, fail = 0;
  const pass = (m) => { ok++; console.log('  ✔ ' + m); };
  const bad = (m) => { fail++; console.log('  ✖ ' + m); };
  const noMedido = (m) => console.log('  ⚠ NO MEDIDO: ' + m);
  console.log('\n=== [BFU.4.5.10] Quién captura los depósitos de cada cuenta ===\n');

  const url = process.env.DATABASE_URL_NEW;
  if (!url) { noMedido('sin DATABASE_URL_NEW (corre en el CI)'); console.log(`\n${ok} ✔ · ${fail} ✖\n`); return; }
  const destino = classify(url).kind;
  const c = new Client({ connectionString: url, statement_timeout: 60000 });
  await c.connect();
  const q = (s, p) => c.query(s, p).then((r) => r.rows);
  try {
    const [obj] = await q(`SELECT to_regclass('identity.user_kepler_logins') IS NOT NULL tabla,
                                  to_regclass('analytics.v_kepler_deposit_capturers') IS NOT NULL vista,
                                  (SELECT coalesce('security_invoker=true' = ANY (reloptions), false) FROM pg_class
                                    WHERE oid = to_regclass('analytics.v_kepler_deposit_capturers')) invoker`);
    if (!obj.tabla || !obj.vista) { bad(`(1) falta ${!obj.tabla ? 'la tabla' : 'la vista'} (¿corrió la migración 20261124100054?)`); return; }
    if (obj.invoker) pass('(1) identity.user_kepler_logins y analytics.v_kepler_deposit_capturers existen; la vista es security_invoker');
    else bad('(1) la vista NO es security_invoker: se lee con los permisos de su dueño y se salta el RLS de los movimientos');

    const filas = await q(`SELECT bank_account_id::text cuenta, sum(depositos)::int depositos, count(*) FILTER (WHERE lugar = 1)::int primeros
                             FROM analytics.v_kepler_deposit_capturers GROUP BY 1`);
    const base = await q(`SELECT bm.bank_account_id::text cuenta, count(DISTINCT bm.id)::int depositos
                            FROM finance.bank_movements bm JOIN finance.bank_recon_matches r ON r.bank_movement_id = bm.id
                           WHERE bm.amount_in > 0 AND bm.deleted_at IS NULL AND bm.movement_date >= current_date - 30
                             AND r.kepler_doc_tipo IN ('U-A-5', 'U-A-7') GROUP BY 1`);
    if (!base.length) noMedido('(2)(3) no hay depósitos casados con U-A-5/U-A-7 en los últimos 30 días en esta base');
    else {
      const enVista = new Map(filas.map((r) => [r.cuenta, r]));
      const infladas = base.filter((b) => (enVista.get(b.cuenta)?.depositos ?? 0) > b.depositos);
      const fantasma = filas.filter((f) => !base.some((b) => b.cuenta === f.cuenta));
      const sinCapturista = base.reduce((s, b) => s + b.depositos - (enVista.get(b.cuenta)?.depositos ?? 0), 0);
      if (!infladas.length && !fantasma.length) pass(`(2) la vista no infla: ${filas.reduce((s, r) => s + r.depositos, 0)} depósitos en ${filas.length} cuentas; sin capturista ${sinCapturista} (declarado)`);
      else bad(`(2) la vista cuenta más depósitos que la fuente en ${infladas.length} cuentas, o cuentas que la fuente no tiene: ${fantasma.length}`);
      const sinPrimero = filas.filter((r) => r.primeros === 0);
      const empates = filas.filter((r) => r.primeros > 1);
      if (!sinPrimero.length) pass(`(3) cada cuenta tiene primer lugar${empates.length ? ` (empates declarados: ${empates.length})` : ''}`);
      else bad(`(3) cuentas sin primer lugar: ${sinPrimero.length}`);
    }

    if (destino !== 'local') { noMedido(`(4) la base es «${destino}»: las filas sintéticas sólo se escriben en una base local`); return; }
    const [u] = await q(`SELECT id, tenant_id FROM identity.users WHERE deleted_at IS NULL LIMIT 1`);
    if (!u) { noMedido('(4) la base no tiene usuarios para el par'); return; }
    await c.query('BEGIN');
    try {
      await c.query(`SELECT set_config('app.tenant_id', $1, true)`, [u.tenant_id]);
      const rechaza = async (sql, params, codigo) => {
        await c.query('SAVEPOINT p');
        try { await c.query(sql, params); await c.query('RELEASE SAVEPOINT p'); return false; } catch (e) { await c.query('ROLLBACK TO SAVEPOINT p'); return e.code === codigo; }
      };
      const ins = `INSERT INTO identity.user_kepler_logins (tenant_id, user_id, kepler_login) VALUES ($1, $2, $3)`;
      if (await rechaza(ins, [u.tenant_id, u.id, 'zzprueba'], '23514') && await rechaza(ins, [u.tenant_id, u.id, ' ZZPRUEBA'], '23514')) pass('(4a) negativa: un login en minúsculas o con espacios se rechaza');
      else bad('(4a) un login sin normalizar entró');
      await c.query(ins, [u.tenant_id, u.id, 'ZZPRUEBA']);
      if (await rechaza(ins, [u.tenant_id, u.id, 'ZZPRUEBA'], '23505')) pass('(4b) negativa: el mismo login vivo dos veces se rechaza');
      else bad('(4b) el mismo login vivo entró dos veces');

      // Una cuenta sintética con su estado de cuenta.
      const [cta] = await q(`INSERT INTO finance.bank_accounts (tenant_id, bank, account_label) VALUES ($1, 'ZZBANCO', 'ZZ-BFU4510') RETURNING id`, [u.tenant_id]);
      const [st] = await q(`INSERT INTO finance.bank_statements (tenant_id, bank_account_id, period) VALUES ($1, $2, 'ZZ') RETURNING id`, [u.tenant_id, cta.id]);
      let n = 0;
      // Un movimiento del banco casado con documentos de Kepler: [doc_tipo, capturista, importe].
      const mov = async ({ entra = 100, sale = 0, dias = 0, docs }) => {
        n++;
        const [m] = await q(`INSERT INTO finance.bank_movements (tenant_id, statement_id, bank_account_id, movement_date, amount_in, amount_out, client_uuid, sync_source, classified_by)
                             VALUES ($1, $2, $3, current_date - $4::int, $5, $6, $7, 'banco', 'banco') RETURNING id`,
          [u.tenant_id, st.id, cta.id, dias, entra, sale, `zz-bfu4510-${n}`]);
        for (const [i, [tipo, quien, importe]] of docs.entries()) {
          const folio = `ZZ${n}-${i}`;
          await c.query(`INSERT INTO kepler_ods.kdm1 (sucursal, c1, c2, c3, c4, c5, c6, c67) VALUES ('ZZ', 'ZZ', 'ZZ', 'ZZ', 'ZZ', 'ZZ', $1, $2)`, [folio, quien]);
          await c.query(`INSERT INTO analytics.bank_movement_legs (tenant_id, src_sucursal, src_c1, src_c2, src_c3, src_c4, src_c5, src_c6,
                           sucursal, doc_tipo, folio, clave_banco, flujo, importe, es_traspaso, pierna, fecha_captura)
                         VALUES ($1, 'ZZ', 'ZZ', 'ZZ', 'ZZ', 'ZZ', 'ZZ', $2, 'ZZ', $3, $2, 'ZZ', 'entrada', $4, false, 'mov', current_date - $5::int)`,
            [u.tenant_id, folio, tipo, importe, dias]);
          await c.query(`INSERT INTO finance.bank_recon_matches (tenant_id, bank_movement_id, kepler_sucursal, kepler_doc_tipo, kepler_doc_folio, kepler_amount, match_type)
                         VALUES ($1, $2, 'ZZ', $3, $4, $5, 'exact')`, [u.tenant_id, m.id, tipo, folio, importe]);
        }
      };
      // (4c) lo que cuenta: dos depósitos de venta de ZZPRUEBA (uno además casado con un U-A-7 menor de ZZOTRO) y un cobro de ZZOTRO.
      await mov({ docs: [['U-A-5', ' zzprueba ', 100], ['U-A-7', 'ZZOTRO', 1]] });
      await mov({ docs: [['U-A-5', 'zzprueba', 100]] });
      await mov({ docs: [['U-A-7', 'ZZOTRO', 100]] });
      // (4d) lo que NO cuenta: un retiro casado con un U-A-5 de ZZPRUEBA y un depósito de hace 40 días de ZZOTRO.
      await mov({ entra: 0, sale: 100, docs: [['U-A-5', 'ZZPRUEBA', 100]] });
      await mov({ dias: 40, docs: [['U-A-7', 'ZZOTRO', 100]] });

      const ver = () => q(`SELECT kepler_login, lugar::int, depositos, de_venta_sucursal, de_cobro_cliente, parte::float, capturo_esta_semana, user_id
                             FROM analytics.v_kepler_deposit_capturers WHERE bank_account_id = $1 ORDER BY lugar, kepler_login`, [cta.id]);
      const v = await ver();
      const [a, b] = v;
      if (v.length === 2 && a.kepler_login === 'ZZPRUEBA' && a.lugar === 1 && a.depositos === 2 && a.de_venta_sucursal === 2 && Math.abs(a.parte - 0.667) < 1e-9
          && a.capturo_esta_semana && a.user_id === u.id && b.kepler_login === 'ZZOTRO' && b.lugar === 2 && b.de_cobro_cliente === 1 && b.user_id === null) {
        pass('(4c) ZZPRUEBA primer lugar (2 de venta, parte 0.667, con el usuario del par) y ZZOTRO segundo (1 de cobro, sin par)');
      } else bad(`(4c) la vista dio ${JSON.stringify(v)}`);
      if (a && b && a.depositos + b.depositos === 3) pass('(4d) negativas: el retiro, el depósito de hace 40 días y el segundo documento de un depósito no cuentan');
      else bad(`(4d) cuenta ${a && b ? a.depositos + b.depositos : '?'} depósitos, no 3`);

      await c.query(`UPDATE identity.user_kepler_logins SET deleted_at = now() WHERE kepler_login = 'ZZPRUEBA'`);
      const [v2] = await ver();
      if (v2 && v2.kepler_login === 'ZZPRUEBA' && v2.user_id === null) pass('(4e) negativa: con el par dado de baja, la vista ya no da usuario');
      else bad(`(4e) con el par dado de baja la vista dio ${JSON.stringify(v2)}`);
      if (!(await rechaza(ins, [u.tenant_id, u.id, 'ZZPRUEBA'], '23505'))) pass('(4b) control: dado de baja, el login se puede volver a dar de alta');
      else bad('(4b) dado de baja, el login no se pudo volver a dar de alta');
    } finally { await c.query('ROLLBACK'); }
  } finally {
    await c.end();
    console.log(`\n${ok} ✔ · ${fail} ✖\n`);
    process.exitCode = fail ? 1 : 0;
  }
})().catch((e) => { console.error('ERROR', e.message); process.exit(1); });
