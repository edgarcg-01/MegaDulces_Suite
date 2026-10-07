/**
 * MAAT.10 — Sync del grafo de proveedores (colusión) hacia Neo4j.
 *
 * Lee `analytics.expense_documents` del newdb y reconstruye el subgrafo del
 * tenant en Neo4j (idempotente: wipe + rebuild), modelo bipartito:
 *   (:Beneficiario {tenant_id,name,total}) -[:USA_RFC {docs,importe}]-> (:Rfc {tenant_id,rfc})
 *
 * Espeja MaatProviderGraphService.sync() para que app y script escriban igual.
 * El mismo grafo admite en el futuro aristas forenses (USA_CUENTA/REP_LEGAL/
 * DOMICILIO) sin re-modelar.
 *
 * Uso (desde database/):
 *   DATABASE_URL_NEW='postgres://...?sslmode=no-verify' \
 *   NEO4J_URI='neo4j+s://xxxx.databases.neo4j.io' NEO4J_USER='neo4j' NEO4J_PASSWORD='...' \
 *   node scripts/sync-maat-provider-graph.js
 */
const mainCfg = require('../knexfile-newdb.js').development; // carga .env raíz
const knexLib = require('knex');
const neo4j = require('neo4j-driver');

const NEO4J_URI = process.env.NEO4J_URI;
if (!NEO4J_URI) { console.error('ERROR: falta NEO4J_URI'); process.exit(1); }
const NEO4J_USER = process.env.NEO4J_USER || 'neo4j';
const NEO4J_PASSWORD = process.env.NEO4J_PASSWORD || '';
const TENANT = process.env.MAAT_TENANT_ID || '00000000-0000-0000-0000-00000000d01c';
const CHUNK = 1000;

const mainConn = process.env.DATABASE_URL_NEW
  ? { client: 'pg', connection: { connectionString: process.env.DATABASE_URL_NEW, ssl: { rejectUnauthorized: false } }, pool: { min: 0, max: 2 } }
  : mainCfg;
const pg = knexLib(mainConn);
const driver = neo4j.driver(NEO4J_URI, neo4j.auth.basic(NEO4J_USER, NEO4J_PASSWORD));

(async () => {
  const rows = await pg('analytics.expense_documents')
    .where('tenant_id', TENANT)
    .whereRaw("NULLIF(btrim(rfc),'') IS NOT NULL")
    .whereRaw("NULLIF(btrim(beneficiario),'') IS NOT NULL")
    .groupByRaw('upper(btrim(beneficiario)), upper(btrim(rfc))')
    .select(
      pg.raw('upper(btrim(beneficiario)) AS name'),
      pg.raw('upper(btrim(rfc)) AS rfc'),
      pg.raw('count(*)::int AS docs'),
      pg.raw('ROUND(SUM(importe)::numeric,2)::float8 AS importe'),
    );
  console.log(`pares (beneficiario,rfc): ${rows.length}`);

  const s = driver.session();
  try {
    await s.run('CREATE INDEX maat_benef_idx IF NOT EXISTS FOR (b:Beneficiario) ON (b.tenant_id, b.name)').catch(() => {});
    await s.run('CREATE INDEX maat_rfc_idx IF NOT EXISTS FOR (r:Rfc) ON (r.tenant_id, r.rfc)').catch(() => {});
    await s.run('MATCH (n) WHERE n.tenant_id = $t DETACH DELETE n', { t: TENANT });

    const pairs = rows.map((r) => ({ name: r.name, rfc: r.rfc, docs: Number(r.docs), importe: Number(r.importe) }));
    for (let i = 0; i < pairs.length; i += CHUNK) {
      await s.run(
        `UNWIND $rows AS row
         MERGE (b:Beneficiario {tenant_id: $t, name: row.name})
           ON CREATE SET b.total = row.importe
           ON MATCH  SET b.total = coalesce(b.total, 0) + row.importe
         MERGE (r:Rfc {tenant_id: $t, rfc: row.rfc})
         MERGE (b)-[u:USA_RFC]->(r)
           SET u.docs = row.docs, u.importe = row.importe`,
        { t: TENANT, rows: pairs.slice(i, i + CHUNK) },
      );
      console.log(`  cargados ${Math.min(i + CHUNK, pairs.length)}/${pairs.length}`);
    }

    const c = await s.run(
      `MATCH (b:Beneficiario {tenant_id:$t}) WITH count(b) AS nb
       OPTIONAL MATCH (r:Rfc {tenant_id:$t}) WITH nb, count(r) AS nr
       OPTIONAL MATCH (:Beneficiario {tenant_id:$t})-[u:USA_RFC]->(:Rfc {tenant_id:$t})
       RETURN nb, nr, count(u) AS ne`, { t: TENANT });
    const rec = c.records[0];
    const n = (v) => (neo4j.isInt(v) ? v.toNumber() : Number(v || 0));
    console.log(`✅ Grafo: ${n(rec.get('nb'))} beneficiarios, ${n(rec.get('nr'))} RFC, ${n(rec.get('ne'))} aristas.`);
  } finally {
    await s.close();
    await driver.close();
    await pg.destroy();
  }
})().catch((e) => { console.error(e); process.exit(1); });
