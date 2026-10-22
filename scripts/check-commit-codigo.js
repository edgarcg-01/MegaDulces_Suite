#!/usr/bin/env node
/**
 * `[CAMBIOS.1]` — Todo commit lleva el CÓDIGO de su tarjeta en el título.
 *
 * ── Por qué es una regla (Edgar, 2026-10-21) ─────────────────────────────────────────────────
 * *"Necesito un apartado donde se comunique todos los cambios que haga cada usuario, y es una
 * regla que deben hacer todos."* El apartado (`CAMBIOS.md` del tablero PM) se GENERA de los
 * commits: un commit sin código no aparece bajo ninguna tarjeta, o sea que es un cambio que nadie
 * comunicó. Medido sobre 30 días: Edgar 92 %, IngeDavid 94 %, Francisco 91 %, 0Sistemas 98 % ya lo
 * cumplían — la regla formaliza la costumbre, no cambia el día a día.
 *
 * ── Qué cuenta como código ───────────────────────────────────────────────────────────────────
 * Un `[…]` en el TÍTULO con letras/números y `.`, `-`, `+`, `/`: `feat([CGA-A.15b]): …`,
 * `fix([VP.2.3]+[OBS.1]): …`, `docs([PM.2]): …`. Los merges no se revisan (no son un cambio
 * propio). Un `Revert "…"` hereda el código del commit que revierte.
 *
 * Uso: lo llama `scripts/gate-push.js` (CAPA 3) con los títulos del push.
 *      `node scripts/check-commit-codigo.js --self` → prueba negativa (debe fallar lo que debe).
 */
'use strict';

const CODIGO = /\[[A-Za-z0-9][A-Za-z0-9.+\-/ ]*\]/;

/** Devuelve los títulos que NO llevan código. */
function sinCodigo(titulos) {
  return titulos.filter((t) => t && !/^Merge /.test(t) && !CODIGO.test(t));
}

module.exports = { sinCodigo, CODIGO };

// Modo hook: `.githooks/commit-msg` pasa la ruta del archivo con el mensaje.
if (require.main === module && process.argv.includes('--mensaje')) {
  const archivo = process.argv[process.argv.indexOf('--mensaje') + 1];
  let titulo = '';
  try {
    titulo = require('fs').readFileSync(archivo, 'utf8').split(/\r?\n/).find((l) => l.trim() && !l.startsWith('#')) || '';
  } catch { process.exit(0); } // sin mensaje legible no se inventa un rechazo
  if (sinCodigo([titulo.trim()]).length) {
    console.error(`
⛔ [CAMBIOS.1] El título del commit no lleva el código de su tarjeta:
     «${titulo.trim().slice(0, 100)}»

   Regla del equipo: todo cambio se comunica, y la bitácora (CAMBIOS.md del tablero PM) se arma
   de los títulos de commit. Formato:  tipo([CÓDIGO]): qué cambia
     feat([CGA-A.16]): …    fix([OPS]): …    docs([ADR-095]): …
   ¿No hay tarjeta? Usa el código del área ([OPS], [CI], [DOCS]) o créala en el tablero.
   El commit NO se creó: vuelve a correrlo con el título corregido.
`);
    process.exit(1);
  }
  process.exit(0);
}

if (require.main === module && process.argv.includes('--self')) {
  const deben = ['feat([CGA-A.15b]): cada fila sin contraparte', 'fix([VP.2.3]+[OBS.1]): x', 'docs([PM.2]): y',
    'Merge branch main', 'Revert "feat([ERR.1]): z"', 'chore([CD.22]): a'];
  const noDeben = ['fix: arregla el login', 'wip', 'feat(caja): sin corchetes', 'docs: [] vacío', 'Update README.md'];
  const malPasa = sinCodigo(deben);
  const malFrena = noDeben.filter((t) => !sinCodigo([t]).length);
  if (malPasa.length || malFrena.length) {
    console.error('✗ check-commit-codigo --self FALLÓ');
    if (malPasa.length) console.error('  frena lo que debe pasar:', malPasa);
    if (malFrena.length) console.error('  deja pasar lo que debe frenar:', malFrena);
    process.exit(1);
  }
  console.log(`✓ check-commit-codigo --self: ${deben.length} pasan, ${noDeben.length} frenan`);
}
