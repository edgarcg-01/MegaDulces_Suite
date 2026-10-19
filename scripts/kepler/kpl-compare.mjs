/** Compara el diccionario extraido contra lo que la documentacion ya registra. */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

// Raíz del repo: dos niveles arriba de scripts/kepler/, o $REPO_ROOT.
import { fileURLToPath } from "node:url";
const repo =
  process.env.REPO_ROOT ??
  fileURLToPath(new URL("../..", import.meta.url));
const report = JSON.parse(readFileSync(process.argv[2], "utf8"));

const collect = (dir, out = []) => {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) collect(path, out);
    else if (name.endsWith(".md")) out.push(path);
  }
  return out;
};

const docs = collect(join(repo, "docs"));
let corpus = "";
for (const path of docs) corpus += readFileSync(path, "utf8") + "\n";
console.log(`documentos leidos ${docs.length}  (${(corpus.length / 1024).toFixed(0)} KB)`);

// Acepta las grafias reales del repo: `kdud.c17`, kdud.c17, "kdii.c33/c34/c35", "c34=punto".
const documented = (table, column) => {
  const ordinal = column.slice(1);
  const direct = new RegExp(`${table}[^\\n]{0,8}?\\.?\\b${column}\\b`, "i");
  if (direct.test(corpus)) return "directa";
  // Serie corta: `kdii.c33`=minimo, `c34`=..., `c35`=... en la misma linea.
  const series = new RegExp(`${table}\\.c\\d+[^\\n]{0,160}\\bc${ordinal}\\b`, "i");
  return series.test(corpus) ? "en serie" : undefined;
};

const known = [];
const fresh = [];
for (const entry of report.columns) {
  const how = documented(entry.table, entry.column);
  (how ? known : fresh).push({ ...entry, how });
}

console.log(`\ncolumnas extraidas  ${report.columns.length}`);
console.log(`ya documentadas     ${known.length}`);
console.log(`NUEVAS              ${fresh.length}`);

console.log(`\n=== ya documentadas (control: deben aparecer kdii.c33/34/35 y kdud.c17) ===`);
for (const entry of known)
  console.log(`  ${`${entry.table}.${entry.column}`.padEnd(12)} ${String(entry.labels.join(" | ")).padEnd(26)} [${entry.how}]`);

console.log(`\n=== nuevas, por tabla ===`);
const byTable = new Map();
for (const entry of fresh) byTable.set(entry.table, (byTable.get(entry.table) ?? []).concat(entry));
for (const [table, rows] of [...byTable].sort((a, b) => b[1].length - a[1].length)) {
  console.log(`\n  ${table}  (${rows.length})`);
  for (const row of rows) console.log(`    ${row.column.padEnd(6)} ${row.labels.join(" | ")}`);
}
