#!/usr/bin/env node
/**
 * Extrae el diccionario `etiqueta -> tabla.cN` del corpus de formas .kpl de Kepler.
 *
 * Mecanismo verificado contra tres hechos independientes (2026-10-16):
 *   - invcatprdpag.kpl -> kdii.c33/c34/c35 (minimo / punto de reorden / maximo), FASE_RA
 *   - md_cat_cli.kpl   -> kdud.c17 (descuento del cliente), ERP_KEPLER.md 2.6
 *   - la propia `fun Cambio(numero_campo, ...)` arma el comando kdb contra el alias `a`
 *
 * Lo que NO se pudo establecer se declara `unknown`; nunca se rellena con un default.
 */

import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

const corpusDir = process.argv[2];
const outPath = process.argv[3];
if (!corpusDir) {
  console.error("uso: node kpl-decode.js <dir-corpus> [salida.json]");
  process.exit(2);
}

/** Lee una forma .kpl (UTF-16 LE con BOM) como texto. */
const readForm = (path) => {
  const bytes = readFileSync(path);
  if (bytes[0] === 0xff && bytes[1] === 0xfe)
    return bytes.toString("ucs2").replace(/^﻿/, "");
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return undefined; // UTF-16 BE: no observado
  return bytes.toString("utf8"); // algunas libs vienen en 8 bits
};

/** `kdb.open("e,kdie,f,kdif,...")` -> { e: "kdie", f: "kdif" } */
const aliasMap = (source, baseTable) => {
  const aliases = new Map();
  if (baseTable) aliases.set("a", baseTable);
  for (const match of source.matchAll(/kdb\.open\s*\(\s*"([^"]*)"/g)) {
    const parts = match[1].split(",").map((part) => part.trim());
    for (let i = 0; i + 1 < parts.length; i += 2)
      if (/^[a-z]$/i.test(parts[i]) && /^[A-Za-z]\w+$/.test(parts[i + 1]))
        aliases.set(parts[i].toLowerCase(), parts[i + 1].toLowerCase());
  }
  return aliases;
};

/**
 * Confirma que esta forma usa `Cambio(numero_campo, ...)` para escribir contra la
 * tabla base. Sin esta prueba el ordinal no se puede atribuir a `tabla_base`.
 *
 * Dos convenciones observadas, ambas con el mismo `fun Cambio(numero_campo,...)`:
 *   A) `"datos,a,1," & ... & numero_campo` con `kdb.open("a," & tabla_base)` — mayoría.
 *   B) `tabla_base & ",1," & ... & numero_campo` directo — p.ej. cxpcatpropag (kdxd).
 * En ambas, el log a `logmov` escribe el ordinal como campo 5 (misma semántica).
 */
const cambioBinding = (source, baseTable) => {
  const at = source.search(/\bfun\s+Cambio\s*\(/);
  if (at === -1) return { confirmed: false, reason: "sin `fun Cambio`" };
  const body = source.slice(at, at + 2000);
  const param = body.match(/\bfun\s+Cambio\s*\(\s*(\w+)/)?.[1];
  const usesParam = param !== undefined && body.includes(param);
  const writesAliasA = /"datos\s*,\s*a\s*,/.test(body);
  const writesBaseDirect =
    /tabla_base\s*&\s*",\s*1\s*,/.test(body) ||
    (baseTable !== undefined && new RegExp(`"${baseTable}\\s*,\\s*1\\s*,`, "i").test(body));
  const logsOrdinal = /logmov[^"]*5\s*,\s*'["&]*\s*&\s*numero_campo/.test(body) ||
    /5\s*,\s*'["&]*\s*&\s*numero_campo/.test(body);
  const targetsBase = writesAliasA || writesBaseDirect || logsOrdinal;
  if (!targetsBase)
    return { confirmed: false, reason: "`Cambio` no escribe el ordinal contra la tabla base" };
  if (!usesParam)
    return { confirmed: false, reason: "`Cambio` no propaga su primer argumento" };
  return { confirmed: true, param, convention: writesAliasA ? "alias-a" : "tabla-directa" };
};

/** Texto visible de un `<txt ...>Etiqueta</txt>`, sin markup ni entidades. */
const cleanLabel = (raw) =>
  raw
    .replace(/<[^>]*>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();

const FIELD_TAG = /<(inp|edt|chck|cmb|txtm|lst|dte|num)\b([^>]*)>/gi;
const TXT_TAG = /<txt\b[^>]*>([\s\S]*?)<\/txt>/gi;

/** Empareja cada campo con `Cambio(N,..)` contra la etiqueta `<txt>` que lo precede. */
const extractFields = (source) => {
  const labels = [];
  for (const match of source.matchAll(TXT_TAG)) {
    const text = cleanLabel(match[1]);
    if (text) labels.push({ at: match.index, text });
  }
  const labelBefore = (position) => {
    let found;
    for (const label of labels) {
      if (label.at > position) break;
      found = label;
    }
    return found;
  };
  // Una etiqueta de grupo seguida de calificadores: "Descuentos" + "(1)" + "(2)"...
  // El calificador inmediato manda; el nombre del grupo es la etiqueta anterior que
  // NO sea calificador, y puede estar varios campos atras.
  const isQualifier = (text) => /^[([]/.test(text);
  const compositeLabel = (position) => {
    const previous = labels.filter((label) => label.at < position);
    const nearest = previous.at(-1);
    if (nearest === undefined) return undefined;
    if (!isQualifier(nearest.text)) return nearest.text;
    for (let i = previous.length - 2; i >= 0; i -= 1)
      if (!isQualifier(previous[i].text))
        return `${previous[i].text} ${nearest.text}`;
    return nearest.text;
  };

  const rows = [];
  for (const match of source.matchAll(FIELD_TAG)) {
    const attributes = match[2];
    const cambio = attributes.match(/OnChange\s*=\s*"Cambio\(\s*(\d+)\s*,\s*([^,")]*)/);
    if (!cambio) continue;
    const id = attributes.match(/\bid\s*=\s*"([^"]*)"/)?.[1];
    rows.push({
      column: `c${cambio[1]}`,
      ordinal: Number(cambio[1]),
      field_id: id ?? cambio[2].trim() ?? null,
      label: compositeLabel(match.index) ?? labelBefore(match.index)?.text ?? null,
      type: attributes.match(/\btype\s*=\s*"([^"]*)"/)?.[1] ?? null,
      decimals: attributes.match(/\bnd\s*=\s*"(\d+)"/)?.[1] ?? null,
      max_len: attributes.match(/\bnc\s*=\s*"(\d+)"/)?.[1] ?? null,
      widget: match[1].toLowerCase(),
    });
  }
  return rows;
};

const forms = readdirSync(corpusDir).filter((name) => name.toLowerCase().endsWith(".kpl"));
const entries = [];
const skipped = [];
let formsWithBinding = 0;

for (const name of forms) {
  const source = readForm(join(corpusDir, name));
  if (source === undefined) {
    skipped.push({ form: name, reason: "codificacion no reconocida" });
    continue;
  }
  const baseTable = source.match(/tabla_base\s*=\s*"([^"]+)"/)?.[1]?.toLowerCase();
  const fields = extractFields(source);
  if (fields.length === 0) {
    skipped.push({ form: name, reason: "sin campos con Cambio(N,..)" });
    continue;
  }
  const binding = cambioBinding(source, baseTable);
  if (!binding.confirmed) {
    skipped.push({ form: name, reason: binding.reason, fields: fields.length });
    continue;
  }
  if (!baseTable) {
    skipped.push({ form: name, reason: "sin `tabla_base`", fields: fields.length });
    continue;
  }
  formsWithBinding += 1;
  const aliases = aliasMap(source, baseTable);
  const title = source.match(/<pag\b[^>]*\btit\s*=\s*"([^"]*)"/)?.[1] ?? null;
  for (const field of fields)
    entries.push({
      table: baseTable,
      ...field,
      form: basename(name),
      form_title: title,
      declared_fields: source.match(/camposDeseados\s*=\s*"([^"]+)"/)?.[1] ?? null,
      aliases: Object.fromEntries(aliases),
      evidence: "observed:kpl-source",
    });
}

// Un mismo (tabla, columna) puede venir de varias formas: se conservan todas las etiquetas.
const byColumn = new Map();
for (const entry of entries) {
  const key = `${entry.table}.${entry.column}`;
  const bucket = byColumn.get(key) ?? { table: entry.table, column: entry.column, labels: [], forms: [] };
  if (entry.label && !bucket.labels.includes(entry.label)) bucket.labels.push(entry.label);
  if (!bucket.forms.includes(entry.form)) bucket.forms.push(entry.form);
  byColumn.set(key, bucket);
}

const conflicting = [...byColumn.values()].filter((bucket) => bucket.labels.length > 1);
const unlabeled = entries.filter((entry) => entry.label === null);

const report = {
  generated_at: new Date().toISOString(),
  corpus: corpusDir,
  forms_scanned: forms.length,
  forms_with_confirmed_binding: formsWithBinding,
  bindings: entries.length,
  distinct_columns: byColumn.size,
  tables: [...new Set(entries.map((entry) => entry.table))].sort(),
  conflicting_labels: conflicting.length,
  unlabeled_bindings: unlabeled.length,
  skipped: skipped.length,
  entries,
  columns: [...byColumn.values()].sort(
    (a, b) => a.table.localeCompare(b.table) || Number(a.column.slice(1)) - Number(b.column.slice(1)),
  ),
  not_measured: { skipped, conflicting, unlabeled },
};

if (outPath) writeFileSync(outPath, JSON.stringify(report, null, 2));

console.log(`formas en el corpus           ${report.forms_scanned}`);
console.log(`formas con binding confirmado ${report.forms_with_confirmed_binding}`);
console.log(`bindings etiqueta->columna    ${report.bindings}`);
console.log(`columnas distintas            ${report.distinct_columns}`);
console.log(`tablas cubiertas              ${report.tables.length}  ${report.tables.join(" ")}`);
console.log(`-- DECLARADO SIN MEDIR --`);
console.log(`formas salteadas              ${report.skipped}`);
console.log(`bindings sin etiqueta         ${report.unlabeled_bindings}`);
console.log(`columnas con etiqueta en conflicto ${report.conflicting_labels}`);
