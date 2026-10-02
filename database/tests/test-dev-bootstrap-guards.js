/* eslint-disable no-console */
/**
 * `[DEV.BOOT]` — Las protecciones de `database/scripts/dev-bootstrap-empty-db.js`, con prueba NEGATIVA.
 *
 * Ese script crea roles, extensiones y marca migraciones como aplicadas SIN ejecutarlas: apuntado al
 * servidor equivocado haría daño de verdad (GOTCHAS §24, §52, §75). «Un gate sin prueba negativa es una
 * intención» (ADR-056): cada regla se rompe a propósito UNA vez y se exige el rechazo (exit 2), y un
 * CONTROL POSITIVO demuestra que el rechazo viene de la regla y no de que el script esté roto.
 *
 * No necesita base de datos: todo lo que se prueba se decide ANTES de conectar. Lo que sí necesita una
 * base —«el clúster ya trae el search_path fijado por rol» y «el clúster tiene bases ajenas»— se probó a
 * mano contra un clúster real (ver FASE_MS §11) y NO se reproduce acá: se declara, no se dibuja como verde.
 */
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const SCRIPT = path.resolve(__dirname, '..', 'scripts', 'dev-bootstrap-empty-db.js');
let pass = 0;
let fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; // Las URL de abajo van SIN contrasena a proposito. No es descuido: el guardia que se prueba
// solo mira u.hostname y u.pathname -- nunca la credencial -- asi que una URL sin password
// prueba exactamente lo mismo. Y con usuario:clave@ el escaneo de secretos las marcaba como
// hallazgo: la lista blanca cubre las claves de dev sobre hosts LOCALES, y aca los hosts son
// remotos A PROPOSITO, porque de eso se trata la prueba. Ponerle una excepcion al escaner
// para que pase un fixture es aflojar la compuerta equivocada.
console.log('  ✓', msg); } else { fail++; console.log('  ✗', msg); } };

function correr(argv, env = {}) {
  const limpio = { ...process.env };
  delete limpio.DEV_BOOTSTRAP_URL;
  const r = spawnSync(process.execPath, [SCRIPT, ...argv], {
    env: { ...limpio, ...env }, encoding: 'utf8', timeout: 20000,
  });
  return { code: r.status, out: `${r.stdout || ''}\n${r.stderr || ''}` };
}

console.log('\n── 1. Sin URL explícita: muestra la ayuda y NO adivina un destino');
let r = correr([]);
ok(r.code === 2 && /Uso: node/.test(r.out), 'sin --url sale con 2 y muestra el uso');
r = correr([], { DATABASE_URL_NEW: 'postgresql://postgres@192.168.0.222:5434/postgres_platform' });
ok(r.code === 2 && /Uso: node/.test(r.out) && !/192\.168\.0\.222/.test(r.out.replace(/Uso:[\s\S]*/m, '')),
  '⭐ NEGATIVA: con DATABASE_URL_NEW apuntando a un servidor remoto NO lo toma por defecto (ése es el que ya hizo medir la base equivocada)');
r = correr(['--help']);
ok(r.code === 0 && /Uso: node/.test(r.out), 'CONTROL: --help sí sale con 0');

console.log('\n── 2. Solo local');
for (const [host, etiqueta] of [
  ['192.168.0.222:5434', 'el servidor de prod (md)'],
  ['192.168.0.245:5432', 'el espejo retirado (.245)'],
  ['10.0.0.5:5432', 'una IP privada cualquiera'],
  ['db.ejemplo.com:5432', 'un nombre de dominio'],
  ['0.0.0.0:5432', '0.0.0.0'],
]) {
  r = correr(['--url', `postgresql://postgres@${host}/postgres_platform`]);
  ok(r.code === 2 && /no es local/.test(r.out), `⭐ NEGATIVA: se niega contra ${etiqueta} (${host})`);
}
ok(correr(['--url', 'esto-no-es-una-url']).code === 2, 'NEGATIVA: una URL ilegible se rechaza (2), no explota');

console.log('\n── 3. La base no puede parecer de producción');
for (const db of ['railway', 'prod', 'produccion', 'prod_copy', 'RAILWAY']) {
  r = correr(['--url', `postgresql://postgres@127.0.0.1:5442/${db}`]);
  ok(r.code === 2 && /no parece una base de desarrollo/.test(r.out), `⭐ NEGATIVA: rechaza una base llamada "${db}" aunque el host sea local`);
}
r = correr(['--url', 'postgresql://postgres@127.0.0.1:5442/']);
ok(r.code === 2, 'NEGATIVA: sin nombre de base se rechaza');

console.log('\n── 4. CONTROL POSITIVO: lo permitido SÍ pasa los guardias');
// Host local y nombre de desarrollo, pero un puerto donde no escucha nadie: tiene que PASAR las
// protecciones y fallar recién al conectar (exit 1, no 2). Sin este control, los rechazos de arriba
// podrían venir de que el script esté roto y no de la regla.
for (const host of ['127.0.0.1', 'localhost', '[::1]']) {
  r = correr(['--url', `postgresql://postgres@${host}:1/bootstrap_check`]);
  ok(r.code === 1 && !/no es local|no parece una base de desarrollo|Uso: node/.test(r.out),
    `CONTROL: ${host} con una base de desarrollo pasa los guardias y falla al CONECTAR (exit ${r.code})`);
}

console.log('\n── 5. Argumentos');
ok(correr(['--url', 'postgresql://postgres@127.0.0.1:1/dev', '--no-existe']).code === 2, 'NEGATIVA: un argumento desconocido se rechaza (2)');

console.log('\n── 6. El script no toma DATABASE_URL_NEW como destino');
const src = fs.readFileSync(SCRIPT, 'utf8');
ok(!/process\.env\.DATABASE_URL_NEW/.test(src), 'el código fuente no lee process.env.DATABASE_URL_NEW (sólo lo ESCRIBE para knex)');
ok(/FRONTERA_ANALITICA/.test(src) && /Un clúster, una base|UN CLÚSTER, UNA BASE/.test(src),
  'las dos reglas que sólo se prueban contra un clúster real (frontera estructural y un-clúster-una-base) siguen en el código');

console.log('\n── Declarado, NO medido aquí (necesita un clúster real)');
console.log('  ~ NO MEDIDO: «el clúster ya trae search_path por rol» → rechaza (probado a mano 2026-10-02)');
console.log('  ~ NO MEDIDO: «el clúster tiene bases ajenas al stack» → rechaza');
console.log('  ~ NO MEDIDO: que el arranque completo llegue al final (corrida de ~10 min; ver FASE_MS §11)');

console.log(`\n${pass} ✓ / ${fail} ✗`);
process.exit(fail ? 1 : 0);
