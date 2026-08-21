/* eslint-disable no-console */
/**
 * §8-B — Pre-stage del SUBSCRIBER de una rama Kepler para replicación lógica → kepler_md_<code>.
 *
 * Clona el DDL COMPLETO del schema `md` del publisher (host remoto, read-only `platform_ro`)
 * a una base nueva `kepler_md_<code>` en el contenedor de réplicas locales (:5433). Deja todo
 * listo para que el ÚNICO paso que falta sea `CREATE SUBSCRIPTION` (que necesita la publicación
 * del POS + el secreto de `ods_repl`, los corre Edgar).
 *
 * Reusa el patrón del piloto md_03 (introspección columnas format_type + PK). Idempotente:
 * CREATE DATABASE / TABLE IF NOT EXISTS; no borra ni toca datos. NO crea la subscription.
 *
 *   node database/importers/kepler/setup-branch-subscriber.js --branch=00            # dry-run (plan)
 *   node database/importers/kepler/setup-branch-subscriber.js --branch=00 --apply    # crea DB + DDL
 *
 * Escribe SOLO al :5433 local (permitido). Lee el publisher read-only. Nunca imprime secretos.
 */
const { Client } = require('pg');
const { branchUrl, BRANCHES } = require('../lib/kepler-branches');

const CODE = (process.argv.find((a) => a.startsWith('--branch=')) || '').split('=')[1] || '00';
const APPLY = process.argv.includes('--apply');
const REPLICA_BASE = process.env.KEPLER_REPLICA_BASE || 'postgresql://postgres:superoot@localhost:5433/postgres_platform';
const DBNAME = `kepler_md_${CODE}`;
const qid = (id) => '"' + String(id).replace(/"/g, '""') + '"';

(async () => {
  console.log(`\n=== §8-B subscriber pre-stage: rama ${CODE} → ${DBNAME} (${APPLY ? 'APPLY' : 'DRY-RUN'}) ===\n`);

  // 1) Leer DDL del publisher (remoto, read-only)
  const pub = new Client({ connectionString: branchUrl(CODE), connectionTimeoutMillis: 10000, statement_timeout: 120000 });
  await pub.connect();
  let tables;
  try {
    tables = (await pub.query(`
      SELECT c.relname,
        (SELECT jsonb_agg(jsonb_build_object('name', a.attname, 'type', format_type(a.atttypid, a.atttypmod), 'notnull', a.attnotnull) ORDER BY a.attnum)
           FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped) cols,
        (SELECT array_agg(a.attname::text ORDER BY array_position(i.indkey, a.attnum))
           FROM pg_index i JOIN pg_attribute a ON a.attrelid=i.indrelid AND a.attnum=ANY(i.indkey)
          WHERE i.indrelid=c.oid AND i.indisprimary) pk
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='md' AND c.relkind='r' ORDER BY c.relname`)).rows;
  } finally { await pub.end().catch(() => {}); }
  const withPk = tables.filter((t) => t.pk && t.pk.length);
  const noPk = tables.filter((t) => !t.pk || !t.pk.length);
  console.log(`  publisher ${DBNAME.replace('kepler_', '')}: ${tables.length} tablas · ${withPk.length} con PK · ${noPk.length} SIN PK`);
  if (noPk.length) console.log(`  ⚠ sin PK (no replican UPDATE/DELETE por PK): ${noPk.map((t) => t.relname).slice(0, 20).join(', ')}${noPk.length > 20 ? '…' : ''}`);

  if (!APPLY) {
    console.log(`\n[DRY-RUN] crearía ${DBNAME} + ${tables.length} tablas en ${new URL(REPLICA_BASE).host}. Corré con --apply.`);
    printEdgarSteps();
    return;
  }

  // 2) CREATE DATABASE (autocommit, fuera de tx) en la maintenance DB
  const admin = new Client({ connectionString: REPLICA_BASE });
  await admin.connect();
  try {
    const exists = (await admin.query(`SELECT 1 FROM pg_database WHERE datname=$1`, [DBNAME])).rowCount > 0;
    if (exists) console.log(`  ${DBNAME} ya existe — reuso (idempotente)`);
    else { await admin.query(`CREATE DATABASE ${qid(DBNAME)}`); console.log(`  ✓ CREATE DATABASE ${DBNAME}`); }
  } finally { await admin.end().catch(() => {}); }

  // 3) Clonar DDL en la base nueva
  const sub = new Client({ connectionString: (() => { const u = new URL(REPLICA_BASE); u.pathname = `/${DBNAME}`; return u.toString(); })() });
  await sub.connect();
  let created = 0, skipped = 0;
  try {
    await sub.query('CREATE SCHEMA IF NOT EXISTS md');
    for (const t of tables) {
      const already = (await sub.query(`SELECT to_regclass('md.'||$1) r`, [t.relname])).rows[0].r;
      if (already) { skipped++; continue; }
      const colDefs = (t.cols || []).map((c) => `${qid(c.name)} ${c.type}${c.notnull ? ' NOT NULL' : ''}`).join(', ');
      let ddl = `CREATE TABLE md.${qid(t.relname)} (${colDefs}`;
      if (t.pk && t.pk.length) ddl += `, PRIMARY KEY (${t.pk.map(qid).join(', ')})`;
      ddl += ')';
      await sub.query(ddl);
      created++;
    }
    console.log(`  ✓ DDL: ${created} tablas creadas · ${skipped} ya existían`);
  } finally { await sub.end().catch(() => {}); }

  console.log(`\n[APPLY] ${DBNAME} listo con ${tables.length} tablas (VACÍAS). Falta SOLO la subscription (Edgar):`);
  printEdgarSteps();

  function printEdgarSteps() {
    const b = BRANCHES.find((x) => x.code === CODE) || {};
    const host = b.host || '192.168.9.95', port = b.port || 5432, db = b.db || `md_${CODE}`;
    console.log(`
  ── En el POS ${host} (Edgar, superuser + OS):
     postgresql.conf: wal_level=logical + max_slot_wal_keep_size='20GB'  → RESTART
     CREATE ROLE ods_repl WITH REPLICATION LOGIN PASSWORD '<secreto>';
     GRANT USAGE ON SCHEMA md TO ods_repl; GRANT SELECT ON ALL TABLES IN SCHEMA md TO ods_repl;
     ALTER DEFAULT PRIVILEGES IN SCHEMA md GRANT SELECT ON TABLES TO ods_repl;
     CREATE PUBLICATION ods_pub FOR TABLES IN SCHEMA md;
     pg_hba.conf: host ${db} ods_repl <IP_SUBSCRIBER>/32 scram-sha-256 ; SELECT pg_reload_conf();

  ── En el subscriber :5433 (la DB ${DBNAME} YA está lista):
     psql -p 5433 -d ${DBNAME} -c "CREATE SUBSCRIPTION sub_md_${CODE} \\
       CONNECTION 'host=${host} port=${port} dbname=${db} user=ods_repl password=<secreto>' PUBLICATION ods_pub"
     (dispara la copia inicial; luego replicate-ods-live la toma solo — '00' ya está en ODS_LIVE_BRANCHES)`);
  }
})().catch((e) => { console.error('\nERROR:', e.message); process.exit(1); });
