#!/usr/bin/env node
/**
 * `[AUTHZ-HARD.0/6]` — El arranque falla CERRADO.
 *
 * Dos posturas de fallo que la auditoría encontró abiertas y que este smoke fija para que no
 * regresen:
 *   1. `requireJwtSecret()` — el secreto de firma del JWT no puede ser el default público del repo
 *      ni faltar. Antes cada módulo hacía `process.env.JWT_SECRET || 'super_secret_dev_key_...'`, y
 *      con ese default cualquiera forja un superadmin. El helper debe LANZAR en producción.
 *   2. `assertAuthWiring()` — los guards globales de auth cuelgan de `ENABLE_MULTITENANT`; el
 *      arranque debe abortar en producción si esa var no está en 'true' (si no, sirve sin auth).
 *
 * Lee el helper REAL vía ts-node (mismo patrón que test-newdb-user-dto): sigue al código, no lo
 * copia. No toca DB ni red.
 *
 * Correr: node database/tests/test-authz-boot.js
 */
const path = require('path');
const REPO = path.resolve(__dirname, '..', '..');

require(path.join(REPO, 'node_modules', 'ts-node')).register({
  transpileOnly: true, skipProject: true,
  compilerOptions: { module: 'commonjs', target: 'es2020', esModuleInterop: true, moduleResolution: 'node', experimentalDecorators: true, emitDecoratorMetadata: true, ignoreDeprecations: '6.0' },
});

let fail = 0;
const ok = (cond, msg) => { console.log(`  ${cond ? '✓' : '✗ FALLO:'} ${msg}`); if (!cond) fail++; };
const throws = (fn) => { try { fn(); return false; } catch { return true; } };

const DEFAULT = 'super_secret_dev_key_change_in_prod';
const { requireJwtSecret } = require(path.join(REPO, 'libs/platform-core/src/lib/auth/jwt-secret.ts'));

const saveEnv = { s: process.env.JWT_SECRET, n: process.env.NODE_ENV };
const setEnv = (secret, nodeEnv) => {
  if (secret === undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = secret;
  if (nodeEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = nodeEnv;
};

console.log('\n[1] requireJwtSecret() — fail-closed del secreto de firma');
setEnv(undefined, 'production');
ok(throws(() => requireJwtSecret()), 'sin JWT_SECRET → lanza');
setEnv(DEFAULT, 'production');
ok(throws(() => requireJwtSecret()), 'JWT_SECRET = default público + producción → lanza');
setEnv(DEFAULT, 'development');
ok(!throws(() => requireJwtSecret()), 'JWT_SECRET = default en dev → tolerado (no rompe el entorno local)');
setEnv('un-secreto-de-verdad-largo-y-aleatorio-123456', 'production');
ok(!throws(() => requireJwtSecret()) && requireJwtSecret() === 'un-secreto-de-verdad-largo-y-aleatorio-123456',
  'JWT_SECRET real → lo devuelve');

console.log('\n[2] main.ts — el boot aborta sin ENABLE_MULTITENANT en producción');
const mainSrc = require('fs').readFileSync(path.join(REPO, 'apps/api/src/main.ts'), 'utf8');
ok(/assertAuthWiring\s*\(\s*\)/.test(mainSrc) && /await\s+NestFactory/.test(mainSrc)
  && mainSrc.indexOf('assertAuthWiring()') < mainSrc.indexOf('await NestFactory'),
  'bootstrap() llama assertAuthWiring() ANTES de crear la app');
ok(/ENABLE_MULTITENANT'\]\s*!==\s*'true'/.test(mainSrc) && /production/.test(mainSrc) && /throw new Error/.test(mainSrc),
  'assertAuthWiring lanza si NODE_ENV=production y ENABLE_MULTITENANT != true');

console.log('\n[3] Sin default de secreto hardcodeado en el código vivo (sólo el helper y el shared-auth muerto)');
const { execSync } = require('child_process');
let hits = '';
try {
  hits = execSync(`git -C "${REPO}" grep -l "super_secret_dev_key_change_in_prod" -- apps libs || true`, { encoding: 'utf8' });
} catch { hits = ''; }
const files = hits.split('\n').map((s) => s.trim()).filter(Boolean)
  .filter((f) => !f.endsWith('jwt-secret.ts') && !f.includes('shared-auth'));
ok(files.length === 0, `cero módulos con el secreto default (fuera del helper): ${files.join(', ') || '0'}`);

setEnv(saveEnv.s, saveEnv.n);
console.log(`\n${fail === 0 ? '✅' : '❌'} AUTHZ boot: ${fail === 0 ? 'todo verde' : fail + ' fallo(s)'}`);
process.exit(fail === 0 ? 0 : 1);
