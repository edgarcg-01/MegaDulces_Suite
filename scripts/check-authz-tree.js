#!/usr/bin/env node
/**
 * Guard de completitud del manifiesto AUTHZ_TREE (Fase AZ).
 * apps/view no tiene runner de tests, así que esta verificación vive como script.
 * Correr:  node scripts/check-authz-tree.js
 *
 * Verifica, por regex sobre los .ts (sin compilar):
 *  1. Todo permiso del enum Permission (frontend) está referenciado en AUTHZ_TREE
 *     (como hoja de módulo, accessPermission de app, o en LEGACY_PERMISSIONS).
 *  2. Ninguna referencia del árbol apunta a un permiso inexistente.
 *  3. Ningún permiso aparece en >1 lugar del árbol (invariante "sin compartir").
 */
const fs = require('fs');
const path = require('path');

const base = path.join(__dirname, '..', 'apps', 'view', 'src', 'app', 'core', 'constants');
const permsSrc = fs.readFileSync(path.join(base, 'permissions.ts'), 'utf8');
const treeSrc = fs.readFileSync(path.join(base, 'authz-tree.ts'), 'utf8');

const enumKeys = new Set();
for (const m of permsSrc.matchAll(/^\s*([A-Z0-9_]+)\s*=\s*'([A-Z0-9_]+)'/gm)) {
  enumKeys.add(m[1]);
}

const counts = {};
for (const m of treeSrc.matchAll(/Permission\.([A-Z0-9_]+)/g)) {
  counts[m[1]] = (counts[m[1]] || 0) + 1;
}
const treeRefs = new Set(Object.keys(counts));

const missing = [...enumKeys].filter((k) => !treeRefs.has(k));
const orphan = [...treeRefs].filter((k) => !enumKeys.has(k));
const shared = Object.entries(counts)
  .filter(([, n]) => n > 1)
  .map(([k, n]) => `${k}(×${n})`);

console.log(`Enum keys:           ${enumKeys.size}`);
console.log(`Tree refs:           ${treeRefs.size}`);
console.log(`Missing (enum→tree): ${missing.length ? missing.join(', ') : 'none'}`);
console.log(`Orphan  (tree→enum): ${orphan.length ? orphan.join(', ') : 'none'}`);
console.log(`Shared  (>1 módulo): ${shared.length ? shared.join(', ') : 'none'}`);

if (missing.length || orphan.length || shared.length) {
  console.error('\n✗ AUTHZ_TREE incompleto/inconsistente — ver arriba.');
  process.exit(1);
}
console.log('\n✓ AUTHZ_TREE completo y sin permisos compartidos.');
