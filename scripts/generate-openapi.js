#!/usr/bin/env node
/**
 * Snapshot del contrato OpenAPI de la API (ADR-045).
 *
 * Antes existía `npm run generate:openapi` apuntando a `scripts/generate-openapi.ts`,
 * un archivo que NO estaba en el repo: el script estaba roto y el cliente Angular
 * generado (`generate:client`) nunca se adoptó — los ~41 módulos usan services HTTP
 * escritos a mano. Se retiró la generación de cliente y queda esto: bajar el
 * documento que Swagger ya expone y diffear el contrato contra el snapshot previo,
 * para ver qué endpoints se agregaron/quitaron antes de commitear.
 *
 * Uso:
 *   node dist/apps/api/main.js            # la API tiene que estar arriba
 *   npm run generate:openapi              # escribe ./swagger.json (gitignored)
 *
 * Env:
 *   API_DOCS_URL  URL completa del JSON; si no se da, prueba API_PORT, 3334 y 3333
 *   API_PORT      puerto del API local (main.ts default 3334; el dev local suele usar 3333)
 */
const fs = require('fs');
const path = require('path');

const OUT = path.resolve(__dirname, '..', 'swagger.json');
/** Candidatos en orden: env explícito → API_PORT → los dos puertos usados en el repo. */
const candidates = process.env.API_DOCS_URL
  ? [process.env.API_DOCS_URL]
  : [process.env.API_PORT, 3334, 3333]
      .filter(Boolean)
      .map((port) => `http://127.0.0.1:${port}/api/docs-json`);

/** path+method de cada operación, para diffear contratos. */
function operations(doc) {
  const ops = new Set();
  for (const [p, item] of Object.entries(doc.paths || {})) {
    for (const method of Object.keys(item || {})) {
      if (['get', 'post', 'put', 'patch', 'delete', 'head', 'options'].includes(method)) {
        ops.add(`${method.toUpperCase()} ${p}`);
      }
    }
  }
  return ops;
}

(async () => {
  let doc = null;
  const errors = [];
  for (const url of candidates) {
    try {
      const res = await fetch(url, { headers: { accept: 'application/json' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      doc = await res.json();
      console.log(`· contrato leído de ${url}`);
      break;
    } catch (e) {
      errors.push(`${url} → ${e.message}`);
    }
  }
  if (!doc) {
    console.error('✖ No pude leer el OpenAPI:');
    for (const e of errors) console.error(`  ${e}`);
    console.error('  Levantá la API primero: nx build api && node dist/apps/api/main.js');
    process.exit(1);
  }
  if (!doc || !doc.paths || (!doc.openapi && !doc.swagger)) {
    console.error('✖ La respuesta no parece un documento OpenAPI.');
    process.exit(1);
  }

  const now = operations(doc);
  let before = null;
  if (fs.existsSync(OUT)) {
    try {
      before = operations(JSON.parse(fs.readFileSync(OUT, 'utf8')));
    } catch {
      /* snapshot previo corrupto: se ignora */
    }
  }

  fs.writeFileSync(OUT, JSON.stringify(doc, null, 2), 'utf8');
  console.log(`✔ ${OUT}`);
  console.log(`  ${Object.keys(doc.paths).length} paths · ${now.size} operaciones · ${(doc.tags || []).length} tags`);
  console.log('  nota: refleja los módulos wireados en ESE proceso (p.ej. ENABLE_MULTITENANT).');

  if (before) {
    const added = [...now].filter((o) => !before.has(o)).sort();
    const removed = [...before].filter((o) => !now.has(o)).sort();
    if (!added.length && !removed.length) console.log('  contrato sin cambios vs snapshot previo');
    for (const o of added) console.log(`  + ${o}`);
    for (const o of removed) console.log(`  - ${o}`);
  }
})();
