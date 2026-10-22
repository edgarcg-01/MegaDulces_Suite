/* eslint-disable no-console */
/**
 * Fusiona el ESQUELETO del ERP (estructura de las réplicas) con el SIGNIFICADO
 * obtenido por ingeniería inversa (diccionario de las formas .kpl).
 *
 * Resultado: la estructura anotada — cada columna con su tipo real y, cuando la RE la
 * decodificó, su significado. Lo no decodificado se DECLARA opaco, no se inventa.
 *
 * Uso: node scripts/kepler/kepler-merge.mjs <estructura.json> <diccionario.json> [salida.json]
 */
import { readFileSync, writeFileSync } from "node:fs";

const [structPath, dictPath, outPath] = process.argv.slice(2);
if (!structPath || !dictPath) {
  console.error("uso: kepler-merge.mjs <estructura.json> <diccionario.json> [salida.json]");
  process.exit(2);
}
const struct = JSON.parse(readFileSync(structPath, "utf8"));
const dict = JSON.parse(readFileSync(dictPath, "utf8"));

// Índice del diccionario de RE: "tabla.cN" -> etiqueta(s) de pantalla.
const meaning = new Map();
for (const c of dict.columns) meaning.set(`${c.table}.${c.column}`, c.labels.join(" | "));

// Tablas de negocio con decode conocido (las que vale la pena anotar en detalle).
const BUSINESS = new Set(["kdii", "kdud", "kdudent", "kduv", "kdxd", "kdm1", "kdm2", "kdmm", "kdik", "kdil"]);

const byTable = new Map();
for (const col of struct.columns) {
  if (!byTable.has(col.table)) byTable.set(col.table, []);
  byTable.get(col.table).push(col);
}

const annotated = [];
let decodedCols = 0;
for (const [table, cols] of byTable) {
  const known = cols.filter((c) => meaning.has(`${table}.${c.name}`)).length;
  decodedCols += known;
  annotated.push({
    table,
    columns: cols.length,
    decoded_by_re: known,
    detail: BUSINESS.has(table)
      ? cols.map((c) => ({
          column: c.name,
          type: c.type + (c.precision ? `(${c.precision}${c.scale ? "," + c.scale : ""})` : ""),
          meaning: meaning.get(`${table}.${c.name}`) ?? null, // null = opaca, sin decode
        }))
      : undefined,
  });
}
annotated.sort((a, b) => b.decoded_by_re - a.decoded_by_re || b.columns - a.columns);

const report = {
  generated_at: new Date().toISOString(),
  skeleton: { source: struct.source, branch: struct.reference_branch,
    tables: struct.reference_table_count, columns: struct.reference_column_count },
  reverse_engineering: { source: "formas .kpl (scripts/kepler/kpl-decode.mjs)",
    columns_decoded: dict.distinct_columns, tables_touched: dict.tables.length },
  coverage: {
    columns_total: struct.reference_column_count,
    columns_with_meaning: decodedCols,
    pct: ((decodedCols / struct.reference_column_count) * 100).toFixed(2) + "%",
  },
  tables: annotated,
};
if (outPath) writeFileSync(outPath, JSON.stringify(report, null, 2));

console.log(`esqueleto (réplica)  : ${report.skeleton.tables} tablas, ${report.skeleton.columns} columnas`);
console.log(`RE (formas .kpl)     : ${report.reverse_engineering.columns_decoded} columnas decodificadas`);
console.log(`cobertura con sentido: ${report.coverage.columns_with_meaning}/${report.coverage.columns_total}  (${report.coverage.pct})`);
console.log(`\ntablas de negocio anotadas en detalle:`);
for (const t of annotated.filter((t) => t.detail))
  console.log(`  ${t.table.padEnd(10)} ${String(t.decoded_by_re).padStart(3)}/${t.columns} columnas con significado`);
