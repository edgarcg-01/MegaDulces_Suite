#!/usr/bin/env node
/**
 * La protección de `main`, COMO CÓDIGO.
 *
 * ─── Por qué este archivo existe ───────────────────────────────────────────────
 * Medido el 2026-09-30: el repo es privado y la cuenta está en plan free, así que
 * GitHub responde **403** a `branches/main/protection` Y a `rulesets`:
 *
 *     "Upgrade to GitHub Pro or make this repository public to enable this feature."
 *
 * O sea: hoy `main` **no tiene ninguna protección**, aunque ONBOARDING.md §8 diga
 * que sí (esa línea quedó de cuando el repo era público). Nadie está haciendo nada
 * mal: la compuerta no existe.
 *
 * El día que el plan lo permita, esto NO debe ser "acordarse de qué casillas
 * palomear en Settings". Debe ser un comando, reproducible y revisable en un diff.
 * Eso es este script.
 *
 *     node scripts/apply-branch-protection.js --dry-run    # muestra qué mandaría
 *     node scripts/apply-branch-protection.js --apply      # lo aplica
 *
 * ─── La trampa que ya cobró en este repo ──────────────────────────────────────
 * ⚠️ Activar la protección NO alcanza. Medido el 2026-09-18 (cuando el repo era
 * público y sí había protección): `main` exigía 1 review, pero
 * `required_status_checks` estaba en **null** — un PR con el CI en rojo se
 * mergeaba igual. Una protección sin checks obligatorios es una intención.
 * Por eso `CHECKS_OBLIGATORIOS` de abajo es la parte que de verdad importa.
 *
 * ⛔ Y los nombres tienen que ser EXACTOS a los `name:` de los jobs de
 *    `.github/workflows/ci.yml`. Si se escribe uno que no existe, GitHub lo acepta
 *    sin chistar y queda esperando para siempre un check que nunca llega: el PR
 *    no se puede mergear NUNCA y parece un bug de GitHub. Por eso el script los
 *    verifica contra las corridas reales antes de mandar nada.
 */

'use strict';

const { execFileSync } = require('child_process');

const REPO = 'edgarcg-01/MegaDulces_Suite';
const RAMA = 'main';

/**
 * Los tres jobs de `ci.yml`, por su `name:` exacto.
 * Verificados contra la corrida 36757614416 del 2026-09-30.
 */
const CHECKS_OBLIGATORIOS = [
  'Build & typecheck (affected)',
  'Lint & test (affected)',
  'Secret scan (gitleaks)',
];

const PROTECCION = {
  // El CI tiene que estar verde, y calculado sobre `main` al día — si no, se
  // puede mergear algo que pasaba hace una semana contra un `main` que ya cambió.
  required_status_checks: {
    strict: true,
    contexts: CHECKS_OBLIGATORIOS,
  },
  enforce_admins: false, // el lead necesita poder desbloquear una emergencia
  required_pull_request_reviews: {
    required_approving_review_count: 1,
    require_code_owner_reviews: true, // CODEOWNERS ya enruta al equipo
    dismiss_stale_reviews: true, // un push nuevo invalida el review viejo
  },
  restrictions: null,
  allow_force_pushes: false,
  allow_deletions: false,
  required_linear_history: true, // el repo ya quedó en squash-only
  required_conversation_resolution: true,
};

function gh(args, { permitirFallo = false } = {}) {
  try {
    return execFileSync('gh', args, { encoding: 'utf8' });
  } catch (e) {
    if (permitirFallo) return null;
    throw e;
  }
}

function main() {
  const aplicar = process.argv.includes('--apply');

  // ── 1. ¿El plan lo permite hoy? ────────────────────────────────────────────
  const sonda = gh(['api', `repos/${REPO}/branches/${RAMA}/protection`], { permitirFallo: true });
  if (sonda === null) {
    console.log(`
⛔ GitHub todavía responde 403 a la protección de \`${RAMA}\`.

   Es el plan, no el repo: privado + free no incluye protected branches ni rulesets.
   Lo desbloquea el dueño de la cuenta (\`edgarcg-01\`) pasando a GitHub Pro, o
   volviendo el repo público — que NO se recomienda: los docs traen IPs internas,
   hostnames de DB y cifras del negocio.

   Mientras tanto la compuerta es de CLIENTE: \`npm run hooks:install\`.
`);
    process.exit(2);
  }

  // ── 2. Los nombres de los checks, contra las corridas REALES ───────────────
  //    Un nombre inventado deja el PR esperando para siempre. Se verifica antes.
  const crudo = gh(
    ['run', 'list', '--limit', '20', '--json', 'databaseId,conclusion'],
    { permitirFallo: true },
  );
  if (crudo) {
    const corridas = JSON.parse(crudo).filter((r) => r.conclusion);
    const vistos = new Set();
    for (const c of corridas.slice(0, 5)) {
      const j = gh(['run', 'view', String(c.databaseId), '--json', 'jobs'], { permitirFallo: true });
      if (!j) continue;
      for (const job of JSON.parse(j).jobs || []) vistos.add(job.name);
    }
    const fantasmas = CHECKS_OBLIGATORIOS.filter((c) => !vistos.has(c));
    if (fantasmas.length && vistos.size) {
      console.error(`
⛔ Estos checks NO aparecen en ninguna corrida reciente:

${fantasmas.map((f) => `     · ${f}`).join('\n')}

   Jobs que el CI sí reporta hoy:
${[...vistos].map((v) => `     · ${v}`).join('\n')}

   Si se aplican así, el PR queda esperando un check que nunca llega y no se
   puede mergear nunca. Corregí \`CHECKS_OBLIGATORIOS\` en este archivo primero.
`);
      process.exit(1);
    }
  }

  // ── 3. Aplicar ─────────────────────────────────────────────────────────────
  if (!aplicar) {
    console.log('— Simulacro (sin --apply). Esto es lo que se mandaría:\n');
    console.log(JSON.stringify(PROTECCION, null, 2));
    console.log(`\n   Para aplicarlo: node scripts/apply-branch-protection.js --apply`);
    return;
  }

  execFileSync(
    'gh',
    ['api', '-X', 'PUT', `repos/${REPO}/branches/${RAMA}/protection`, '--input', '-'],
    { input: JSON.stringify(PROTECCION), encoding: 'utf8', stdio: ['pipe', 'inherit', 'inherit'] },
  );
  console.log(`\n✓ Protección aplicada a \`${RAMA}\`.`);
  console.log('  ⚠️ Prueba negativa obligatoria: abrí un PR con el CI en rojo y comprobá');
  console.log('     que GitHub NO deja mergearlo. Un gate sin prueba negativa es una intención.');
}

main();
