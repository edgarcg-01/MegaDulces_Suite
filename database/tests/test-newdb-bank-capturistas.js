/* eslint-disable no-console */
/**
 * [BFU.4.5.10] CANDADO — quién responde por los depósitos de cada sucursal se DERIVA de quién los captura en Kepler.
 *
 * `analytics.v_kepler_deposit_capturers` (vista sobre el ODS) + `identity.user_kepler_logins` (el par login de Kepler →
 * usuario de la Suite, dato propio). Verifica:
 *   (1) la tabla y la vista existen (la migración 20261124100054 corrió);
 *   (2) la vista NO infla: por sucursal y tipo, sus documentos no pasan de los documentos distintos de los últimos 30
 *       días en `analytics.bank_movement_legs`, y declara cuántos quedaron sin capturista;
 *   (3) cada sucursal y tipo con documentos tiene un primer lugar (los empates se declaran);
 *   (4) en base LOCAL, dentro de una transacción que se deshace, con filas sintéticas:
 *       a. NEGATIVA: un login en minúsculas o con espacios se rechaza (CHECK);
 *       b. NEGATIVA: el mismo login vivo dos veces se rechaza; dado de baja, se puede volver a dar de alta;
 *       c. un documento sintético capturado por « zzprueba » aparece en la vista como ZZPRUEBA, primer lugar, parte 1,
 *          capturó esta semana, y con el usuario de la Suite del par;
 *       d. NEGATIVA: con el par dado de baja, la vista ya no da usuario.
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
  console.log('\n=== [BFU.4.5.10] Quién captura los depósitos de cada sucursal ===\n');

  const url = process.env.DATABASE_URL_NEW;
  if (!url) { noMedido('sin DATABASE_URL_NEW (corre en el CI)'); console.log(`\n${ok} ✔ · ${fail} ✖\n`); return; }
  const destino = classify(url).kind;
  const c = new Client({ connectionString: url, statement_timeout: 60000 });
  await c.connect();
  const q = (s, p) => c.query(s, p).then((r) => r.rows);
  try {
    const [obj] = await q(`SELECT to_regclass('identity.user_kepler_logins') IS NOT NULL tabla,
                                  to_regclass('analytics.v_kepler_deposit_capturers') IS NOT NULL vista`);
    if (!obj.tabla || !obj.vista) { bad(`(1) falta ${!obj.tabla ? 'la tabla' : 'la vista'} (¿corrió la migración 20261124100054?)`); return; }
    pass('(1) identity.user_kepler_logins y analytics.v_kepler_deposit_capturers existen');

    const filas = await q(`SELECT sucursal, doc_tipo, sum(docs)::int docs, count(*) FILTER (WHERE lugar = 1)::int primeros
                             FROM analytics.v_kepler_deposit_capturers GROUP BY 1, 2`);
    const base = await q(`SELECT sucursal, doc_tipo, count(DISTINCT folio)::int docs FROM analytics.bank_movement_legs
                           WHERE doc_tipo IN ('U-A-5', 'U-A-7') AND fecha_captura >= current_date - 30 GROUP BY 1, 2`);
    if (!base.length) noMedido('(2)(3) no hay documentos de depósito de los últimos 30 días en esta base');
    else {
      const llave = (r) => `${r.sucursal}|${r.doc_tipo}`;
      const enVista = new Map(filas.map((r) => [llave(r), r]));
      const infladas = base.filter((b) => (enVista.get(llave(b))?.docs ?? 0) > b.docs);
      const sinCapturista = base.reduce((s, b) => s + b.docs - (enVista.get(llave(b))?.docs ?? 0), 0);
      if (infladas.length === 0) pass(`(2) la vista no infla: ${filas.reduce((s, r) => s + r.docs, 0)} documentos en ${filas.length} grupos; sin capturista ${sinCapturista} (declarado)`);
      else bad(`(2) la vista cuenta más documentos que la fuente en: ${infladas.map(llave).join(', ')}`);
      const sinPrimero = filas.filter((r) => r.primeros === 0);
      const empates = filas.filter((r) => r.primeros > 1);
      if (sinPrimero.length === 0) pass(`(3) cada sucursal y tipo tiene primer lugar${empates.length ? ` (empates declarados: ${empates.map(llave).join(', ')})` : ''}`);
      else bad(`(3) sin primer lugar: ${sinPrimero.map(llave).join(', ')}`);
    }

    if (destino !== 'local') { noMedido(`(4) la base es «${destino}»: las filas sintéticas sólo se escriben en una base local`); return; }
    const [u] = await q(`SELECT id, tenant_id FROM identity.users WHERE deleted_at IS NULL LIMIT 1`);
    if (!u) { noMedido('(4) la base no tiene usuarios para el par'); return; }
    await c.query('BEGIN');
    try {
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

      await c.query(`INSERT INTO kepler_ods.kdm1 (sucursal, c1, c2, c3, c4, c5, c6, c67) VALUES ('ZZ', 'ZZ', 'ZZ', 'ZZ', 'ZZ', 'ZZ', 'ZZ', ' zzprueba ')`);
      await c.query(`INSERT INTO analytics.bank_movement_legs (tenant_id, src_sucursal, src_c1, src_c2, src_c3, src_c4, src_c5, src_c6,
                       sucursal, doc_tipo, folio, clave_banco, flujo, importe, es_traspaso, pierna, fecha_captura)
                     VALUES ($1, 'ZZ', 'ZZ', 'ZZ', 'ZZ', 'ZZ', 'ZZ', 'ZZ', 'ZZ', 'U-A-5', 'ZZ1', 'ZZ', 'entrada', 1, false, 'mov', current_date)`, [u.tenant_id]);
      const ver = () => q(`SELECT kepler_login, lugar, parte, capturo_esta_semana, user_id FROM analytics.v_kepler_deposit_capturers WHERE sucursal = 'ZZ'`);
      const [v] = await ver();
      if (v && v.kepler_login === 'ZZPRUEBA' && Number(v.lugar) === 1 && Number(v.parte) === 1 && v.capturo_esta_semana && v.user_id === u.id) pass('(4c) el documento sintético sale con su capturista normalizado, primer lugar, parte 1 y el usuario del par');
      else bad(`(4c) la vista dio ${JSON.stringify(v)}`);

      await c.query(`UPDATE identity.user_kepler_logins SET deleted_at = now() WHERE kepler_login = 'ZZPRUEBA'`);
      const [v2] = await ver();
      if (v2 && v2.user_id === null) pass('(4d) negativa: con el par dado de baja, la vista ya no da usuario');
      else bad(`(4d) con el par dado de baja la vista dio ${JSON.stringify(v2)}`);
      if (!(await rechaza(ins, [u.tenant_id, u.id, 'ZZPRUEBA'], '23505'))) pass('(4b) control: dado de baja, el login se puede volver a dar de alta');
      else bad('(4b) dado de baja, el login no se pudo volver a dar de alta');
    } finally { await c.query('ROLLBACK'); }
  } finally {
    await c.end();
    console.log(`\n${ok} ✔ · ${fail} ✖\n`);
    process.exitCode = fail ? 1 : 0;
  }
})().catch((e) => { console.error('ERROR', e.message); process.exit(1); });
