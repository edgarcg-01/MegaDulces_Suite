/* eslint-disable no-console */
/**
 * ¿Está este POS Kepler listo para entrar al pipeline del ODS?
 *
 * Se corre DESDE ESTE SERVIDOR (el que va a hospedar la réplica), porque la mitad de lo que hay que
 * comprobar no es el contenido de la DB sino si **desde acá** se puede llegar: `listen_addresses`,
 * el firewall y `pg_hba.conf` sólo se prueban conectándose. Un `psql` corrido en el propio POS los
 * da por buenos y no prueba nada.
 *
 * Ocho comprobaciones, en el orden en que fallan de verdad:
 *   1. el puerto responde                        → si no: servicio caído, firewall, o listen_addresses
 *   2. `platform_ro` autentica                   → si no: falta el rol, la password, o el pg_hba
 *   3. `ods_repl` existe y tiene REPLICATION     → sin eso la suscripción no conecta nunca
 *   4. `wal_level = logical`                     → exige reinicio del POS si hay que cambiarlo
 *   5. hay slots y wal_senders libres            → 10/10 en los POS medidos
 *   6. la publicación existe y cubre el schema md
 *   7. se puede LEER de verdad (md.kdm1) y cuál es su última venta
 *   8. ninguna tabla de md sin identidad de fila  → propagarían INSERT pero no UPDATE/DELETE
 *
 * Sólo LEE. No crea nada, no escribe.
 *
 *   node database/scripts/verificar-pos-kepler.js --host=192.168.32.32 --port=1977 --db=md_07
 *   node database/scripts/verificar-pos-kepler.js --branch=02        # una ya cableada, de control
 */
'use strict';
const net = require('net');
const { Client } = require('pg');

const arg = (n) => (process.argv.find((a) => a.startsWith(`--${n}=`)) || '').split('=')[1];
const USER = process.env.KEPLER_RO_USER || 'platform_ro';
const PASS = process.env.KEPLER_RO_PASS || 'kepler123';

/** Las ramas ya cableadas, para poder correr el verificador de control. Fuente: lib/kepler-branches. */
let CONOCIDAS = [];
try {
  ({ BRANCHES: CONOCIDAS } = require('../importers/lib/kepler-branches'));
} catch { CONOCIDAS = []; }

let ok = 0; let fail = 0; let warn = 0;
const bien = (m) => { ok++; console.log(`  ✔ ${m}`); };
const mal = (m, comoArreglar) => {
  fail++; console.log(`  ✖ ${m}`);
  if (comoArreglar) console.log(`      → ${comoArreglar}`);
};
const ojo = (m) => { warn++; console.log(`  ⚠ ${m}`); };

function tcp(host, port, ms = 4000) {
  return new Promise((res) => {
    const s = new net.Socket();
    let listo = false;
    s.setTimeout(ms);
    s.once('connect', () => { listo = true; s.destroy(); res(true); });
    s.once('timeout', () => { s.destroy(); res(false); });
    s.once('error', () => { if (!listo) res(false); });
    s.connect(port, host);
  });
}

(async () => {
  let host = arg('host'); let port = Number(arg('port')) || 5432; let db = arg('db');
  const br = arg('branch');
  if (br) {
    const b = CONOCIDAS.find((x) => x.code === br);
    if (!b) { console.error(`no conozco la rama ${br}. Ramas: ${CONOCIDAS.map((x) => x.code).join(', ')}`); process.exit(2); }
    if (!b.host) { console.error(`la rama ${br} no tiene host remoto (se lee del replica local ${b.replica})`); process.exit(2); }
    host = b.host; port = b.port; db = b.db;
  }
  if (!host || !db) {
    console.error('faltan datos. Uso: --host=IP --port=N --db=md_NN   |   --branch=NN');
    process.exit(2);
  }

  console.log(`\n=== POS ${host}:${port}/${db} — ¿listo para el ODS? ===\n`);

  // 1 ── el puerto responde
  if (!await tcp(host, port)) {
    mal(`el puerto ${port} no responde`,
      'revisar: el servicio de Postgres arriba · `listen_addresses` con la LAN (o `*`) en '
      + 'postgresql.conf · el firewall de Windows del POS abriendo ese puerto. Los POS ya '
      + 'cableados usan listen_addresses=* y puerto 5432 (la 01 y la 06 usan 1977).');
    console.log(`\n=== ${ok} OK · ${fail} FALTA · ${warn} OJO ===`);
    console.log('\nSin puerto no se puede comprobar nada más. El resto del alta está en');
    console.log('docs/RUNBOOK_ALTA_SUCURSAL_KEPLER.md y database/scripts/kepler-pos-alta-ods.sql');
    process.exit(1);
  }
  bien(`el puerto ${port} responde`);

  // 2 ── platform_ro autentica
  const c = new Client({
    connectionString: `postgresql://${USER}:${PASS}@${host}:${port}/${db}`,
    connectionTimeoutMillis: 8000, statement_timeout: 30000,
  });
  try {
    await c.connect();
    bien(`\`${USER}\` autentica contra ${db}`);
  } catch (e) {
    const m = String(e.message || '');
    mal(`\`${USER}\` no pudo entrar: ${m.slice(0, 80)}`,
      /no pg_hba|no entry|no existe la entrada/i.test(m)
        ? 'falta el renglón en pg_hba.conf para la IP de ESTE servidor (ver el runbook) + `pg_ctl reload`'
        : /password|autentif|authentication/i.test(m)
          ? `el rol existe pero la password no coincide con la que usa este servidor. Correr kepler-pos-alta-ods.sql, o alinear KEPLER_RO_PASS`
          : /does not exist|no existe/i.test(m)
            ? `falta la base \`${db}\` o el rol \`${USER}\`: correr kepler-pos-alta-ods.sql en el POS`
            : 'ver el runbook');
    console.log(`\n=== ${ok} OK · ${fail} FALTA · ${warn} OJO ===`);
    process.exit(1);
  }

  const q = async (sql, params) => {
    try { return (await c.query(sql, params)).rows; } catch (e) { return { _err: e.message }; }
  };

  // 3 ── ods_repl con REPLICATION
  const roles = await q("SELECT rolname, rolreplication FROM pg_roles WHERE rolname IN ('ods_repl','platform_ro')");
  if (roles._err) ojo(`no se pudieron leer los roles: ${roles._err.slice(0, 60)}`);
  else {
    const r = roles.find((x) => x.rolname === 'ods_repl');
    if (!r) mal('no existe el rol `ods_repl`', 'correr kepler-pos-alta-ods.sql en el POS');
    else if (!r.rolreplication) mal('`ods_repl` existe pero SIN el atributo REPLICATION',
      'ALTER ROLE ods_repl REPLICATION;  — sin eso la suscripción nunca conecta');
    else bien('`ods_repl` existe y tiene REPLICATION');
  }

  // 4 y 5 ── wal_level y capacidad de replicación
  const cfg = await q(`SELECT name, setting FROM pg_settings
     WHERE name IN ('wal_level','max_replication_slots','max_wal_senders','listen_addresses','server_version')`);
  const get = (n) => (Array.isArray(cfg) ? (cfg.find((x) => x.name === n) || {}).setting : undefined);
  if (get('wal_level') === 'logical') bien('`wal_level = logical`');
  else {
    mal(`\`wal_level = ${get('wal_level')}\` (hace falta \`logical\`)`,
      'editar postgresql.conf → wal_level = logical  ·  REQUIERE REINICIAR el servicio (no basta reload)');
  }
  const slots = Number(get('max_replication_slots') || 0);
  const senders = Number(get('max_wal_senders') || 0);
  const usados = await q('SELECT count(*)::int n FROM pg_replication_slots');
  const nUsados = Array.isArray(usados) ? usados[0].n : 0;
  if (slots >= 1 && senders >= 1 && slots > nUsados) bien(`hay capacidad de replicación (slots ${nUsados}/${slots} · wal_senders ${senders})`);
  else mal(`sin capacidad: slots ${nUsados}/${slots} · wal_senders ${senders}`,
    'postgresql.conf → max_replication_slots = 10, max_wal_senders = 10 (lo que usan los POS ya cableados) + REINICIAR');

  // 6 ── la publicación
  const pub = await q(`SELECT p.pubname, n.nspname,
       (SELECT count(*)::int FROM pg_publication_tables t WHERE t.pubname = p.pubname) tablas
     FROM pg_publication p
     LEFT JOIN pg_publication_namespace pn ON pn.pnpubid = p.oid
     LEFT JOIN pg_namespace n ON n.oid = pn.pnnspid`);
  if (pub._err) ojo(`no se pudo leer la publicación: ${pub._err.slice(0, 60)}`);
  else if (!pub.length) mal('no hay ninguna publicación', 'correr kepler-pos-alta-ods.sql en el POS');
  else {
    const p = pub.find((x) => x.pubname === 'ods_pub_pilot') || pub[0];
    if (p.pubname !== 'ods_pub_pilot') ojo(`la publicación se llama \`${p.pubname}\`, no \`ods_pub_pilot\` — el suscriptor necesitará ese nombre`);
    if (p.nspname !== 'md') ojo(`la publicación no está declarada FOR TABLES IN SCHEMA md (schema=${p.nspname || 'lista explícita'}): una tabla nueva de Kepler NO entraría sola`);
    if (Number(p.tablas) > 0) bien(`publicación \`${p.pubname}\` con ${p.tablas} tablas`);
    else mal(`la publicación \`${p.pubname}\` no cubre ninguna tabla`, 'revisar su definición');
  }

  // 7 ── una lectura de verdad
  const kdm1 = await q("SELECT count(*)::bigint n, max(c9::date) ult FROM md.kdm1 WHERE c9::date <= current_date");
  if (kdm1._err) mal(`no se puede leer md.kdm1: ${kdm1._err.slice(0, 70)}`,
    'GRANT USAGE ON SCHEMA md + GRANT SELECT ON ALL TABLES IN SCHEMA md (lo hace el script de alta)');
  else bien(`lectura real OK: md.kdm1 tiene ${Number(kdm1[0].n).toLocaleString('es-MX')} movimientos · último ${String(kdm1[0].ult).slice(0, 10)}`);

  const suc = await q('SELECT DISTINCT sucursal FROM md.kdm1 ORDER BY 1 LIMIT 6');
  if (!suc._err && suc.length) {
    console.log(`      sucursal(es) que declara este POS: ${suc.map((x) => x.sucursal).join(', ')}`);
    console.log('      ⚠️ ése es el código con el que su venta va a entrar al ODS — confirmalo antes de');
    console.log('         registrar la rama, porque de ahí cuelgan el sell-out y el corte con Wincaja.');
  }

  // 8 ── identidad de fila
  const sinPk = await q(`SELECT count(*)::int n FROM pg_class k JOIN pg_namespace n ON n.oid = k.relnamespace
     WHERE k.relkind='r' AND n.nspname='md' AND k.relreplident='d'
       AND NOT EXISTS (SELECT 1 FROM pg_constraint co WHERE co.conrelid=k.oid AND co.contype='p')`);
  if (sinPk._err) ojo('no se pudo medir la identidad de fila de las tablas');
  else if (Number(sinPk[0].n) === 0) bien('todas las tablas de `md` tienen identidad de fila (propagan UPDATE y DELETE)');
  else ojo(`${sinPk[0].n} tablas de \`md\` sin PK ni REPLICA IDENTITY: propagarían INSERT pero NO update/delete`);

  await c.end();
  console.log(`\n=== ${ok} OK · ${fail} FALTA · ${warn} OJO ===`);
  if (fail) {
    console.log('\nEl POS todavía NO está listo. Qué correr allá: database/scripts/kepler-pos-alta-ods.sql');
    console.log('Renglones exactos de postgresql.conf / pg_hba.conf: docs/RUNBOOK_ALTA_SUCURSAL_KEPLER.md');
    process.exit(1);
  }
  console.log('\nEl POS está listo del lado del servidor. Sigue el cableado de este lado');
  console.log('(réplica + suscripción + registro de la rama): docs/RUNBOOK_ALTA_SUCURSAL_KEPLER.md §3');
  return undefined;
})().catch((e) => { console.error('FALLO:', e.message); process.exit(1); });
