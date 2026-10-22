/* eslint-disable no-console */
/**
 * Estructura COMPLETA del ERP Kepler, censada desde las réplicas read-only (md:5433).
 * Sólo SELECT sobre information_schema / pg_catalog: no escribe, no lee datos de negocio.
 *
 * Censa las 9 ramas (kepler_md_00..08), calcula la unión y el núcleo común, y vuelca el
 * detalle de columnas (con tipo) de una rama de referencia. Refresca ERP_KEPLER.md §2.4.
 *
 * Uso: node scripts/kepler/kepler-structure.mjs [salida.json] [--ref kepler_md_01]
 */
import pg from "pg";
import { readFileSync, writeFileSync } from "node:fs";

const base = readFileSync(".env", "utf8")
  .split("\n")
  .find((l) => l.startsWith("KEPLER_REPLICA_BASE="))
  ?.slice("KEPLER_REPLICA_BASE=".length)
  .trim()
  .replace(/^["']|["']$/g, "");
if (!base) throw new Error("KEPLER_REPLICA_BASE no está en .env");

const args = process.argv.slice(2);
const outPath = args.find((a) => !a.startsWith("--")) ?? null;
const refArg = args.includes("--ref") ? args[args.indexOf("--ref") + 1] : undefined;

const connect = async (database) => {
  const url = new URL(base);
  if (database) url.pathname = "/" + database;
  const client = new pg.Client({ connectionString: url.toString(), statement_timeout: 30000 });
  await client.connect();
  return client;
};

const tablesOf = async (client) => {
  const { rows } = await client.query(`
    SELECT c.table_schema, c.table_name, count(*)::int AS cols
    FROM information_schema.columns c
    WHERE c.table_schema NOT IN ('pg_catalog','information_schema')
    GROUP BY c.table_schema, c.table_name`);
  return rows;
};

const columnsOf = async (client) => {
  const { rows } = await client.query(`
    SELECT table_schema, table_name, column_name, ordinal_position,
           data_type, is_nullable, character_maximum_length, numeric_precision, numeric_scale
    FROM information_schema.columns
    WHERE table_schema NOT IN ('pg_catalog','information_schema')
    ORDER BY table_schema, table_name, ordinal_position`);
  return rows;
};

const main = async () => {
  const root = await connect();
  const { rows: dbRows } = await root.query(
    `SELECT datname FROM pg_database WHERE datistemplate=false ORDER BY datname`,
  );
  await root.end();
  const branches = dbRows.map((r) => r.datname).filter((n) => /^kepler_md_\d+$/.test(n));
  console.log("ramas Kepler:", branches.join(", "));

  // Censo por rama.
  const perBranch = {};
  const tableBranches = new Map(); // "schema.table" -> Set(ramas)
  for (const branch of branches) {
    const client = await connect(branch);
    const tables = await tablesOf(client);
    await client.end();
    perBranch[branch] = tables.length;
    for (const t of tables) {
      const key = `${t.table_schema}.${t.table_name}`;
      if (!tableBranches.has(key)) tableBranches.set(key, new Set());
      tableBranches.get(key).add(branch);
    }
    console.log(`  ${branch}: ${tables.length} tablas`);
  }

  const union = [...tableBranches.keys()].sort();
  const common = union.filter((k) => tableBranches.get(k).size === branches.length);
  const drift = union
    .filter((k) => tableBranches.get(k).size < branches.length)
    .map((k) => ({ table: k, in_branches: [...tableBranches.get(k)].sort() }));

  // Detalle de columnas de la rama de referencia (la más completa, o --ref).
  const ref = refArg ?? branches.map((b) => [b, perBranch[b]]).sort((a, c) => c[1] - a[1])[0][0];
  const refClient = await connect(ref);
  const cols = await columnsOf(refClient);
  await refClient.end();

  const report = {
    generated_at: new Date().toISOString(),
    source: "replicas Kepler md:5433 (read-only)",
    branches,
    tables_per_branch: perBranch,
    tables_in_union: union.length,
    tables_in_all_branches: common.length,
    tables_with_drift: drift.length,
    reference_branch: ref,
    reference_table_count: new Set(cols.map((c) => `${c.table_schema}.${c.table_name}`)).size,
    reference_column_count: cols.length,
    drift,
    columns: cols.map((c) => ({
      schema: c.table_schema,
      table: c.table_name,
      name: c.column_name,
      pos: c.ordinal_position,
      type: c.data_type,
      nullable: c.is_nullable === "YES",
      max_len: c.character_maximum_length,
      precision: c.numeric_precision,
      scale: c.numeric_scale,
    })),
  };

  if (outPath) writeFileSync(outPath, JSON.stringify(report, null, 2));
  console.log(`\nunión de tablas        : ${report.tables_in_union}`);
  console.log(`comunes a las ${branches.length} ramas : ${report.tables_in_all_branches}`);
  console.log(`con drift (no en todas): ${report.tables_with_drift}`);
  console.log(`rama de referencia     : ${ref}  (${report.reference_table_count} tablas, ${report.reference_column_count} columnas)`);
  if (outPath) console.log(`\nescrito en ${outPath}`);
};

main().catch((e) => {
  console.error("ERROR:", e.message);
  process.exit(1);
});
