/**
 * Preflight helpers para scripts destructivos en database/scripts/.
 *
 * Uso típico al inicio de un script:
 *
 *   const { assertEnv, parseFlags, confirmDestructive } = require('./_lib/preflight');
 *   const flags = parseFlags(process.argv);
 *   assertEnv(['DATABASE_URL'], { script: __filename });
 *   if (flags.execute && !flags.yes) await confirmDestructive('Esto borra X tabla');
 *
 * Razonamiento: hoy cada script reimplementa estos checks de forma distinta
 * (algunos no validan env vars, otros usan --execute, otros --apply, otros
 * --dry-run). Centralizar acá baja el riesgo de correr el destructivo
 * equivocado en la DB equivocada.
 */

const path = require('path');

/**
 * Aborta si falta alguna env var requerida. Mensaje incluye link a .env.example
 * y el nombre del script para diagnóstico.
 *
 * @param {string[]} required
 * @param {{script?: string}} opts
 */
function assertEnv(required, opts = {}) {
  const missing = required.filter((k) => !process.env[k]);
  if (missing.length === 0) return;

  const scriptName = opts.script ? path.basename(opts.script) : 'este script';
  console.error('\n❌ Faltan variables de entorno requeridas por ' + scriptName + ':\n');
  for (const k of missing) console.error('   • ' + k);
  console.error('\n   Documentadas en .env.example. Copiá .env.example → .env y completá los valores.\n');
  process.exit(1);
}

/**
 * Parser uniforme de flags comunes. NO modifica nombres existentes (--execute
 * y --apply siguen funcionando), solo expone una vista única.
 *
 * Convención (no rompe scripts viejos):
 *   - dryRun  = TRUE por default. Pasa a false si el script ve --execute / --apply / --yes / --commit.
 *   - execute = alias de "vas a escribir".
 *   - yes     = skip prompt de confirmación interactiva.
 *
 * @param {string[]} argv (process.argv)
 */
function parseFlags(argv) {
  const args = argv.slice(2);
  const has = (f) => args.includes(f);
  const execute = has('--execute') || has('--apply') || has('--commit');
  return {
    raw: args,
    execute,
    dryRun: !execute,
    yes: has('--yes') || has('-y'),
    verbose: has('--verbose') || has('-v'),
    help: has('--help') || has('-h'),
  };
}

/**
 * Pide confirmación interactiva antes de proceder. Skip si stdin no es TTY
 * (CI / pipelines) o si --yes está presente. Si NO es TTY y NO hay --yes,
 * aborta con instrucción de pasar --yes explícito.
 *
 * @param {string} message - qué va a hacer la operación destructiva
 * @param {{yes?: boolean}} opts
 * @returns {Promise<void>}
 */
async function confirmDestructive(message, opts = {}) {
  if (opts.yes) return;
  if (!process.stdin.isTTY) {
    console.error('\n❌ Operación destructiva sin --yes en modo no-interactivo. Pasá --yes para confirmar.\n');
    process.exit(1);
  }

  process.stdout.write('\n⚠️  ' + message + '\n   Confirmá escribiendo "yes" + Enter: ');

  return new Promise((resolve) => {
    process.stdin.setEncoding('utf8');
    process.stdin.once('data', (chunk) => {
      const answer = chunk.toString().trim().toLowerCase();
      if (answer !== 'yes') {
        console.error('\n   Abortado por el usuario.\n');
        process.exit(0);
      }
      resolve();
    });
  });
}

/**
 * Muestra info de target DB (host + db name) extraído de DATABASE_URL.
 * Útil al inicio de scripts destructivos: el usuario VE en qué DB va a operar.
 *
 * @param {string} envVar - nombre de la env var con la URL
 */
function logTarget(envVar) {
  const url = process.env[envVar];
  if (!url) return;
  try {
    const u = new URL(url);
    console.log('   Target: ' + envVar + ' = ' + (u.hostname || '?') + ':' + (u.port || '5432') + (u.pathname || ''));
  } catch {
    console.log('   Target: ' + envVar + ' = <URL inválida>');
  }
}

module.exports = { assertEnv, parseFlags, confirmDestructive, logTarget };
