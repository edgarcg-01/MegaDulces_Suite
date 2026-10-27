#!/usr/bin/env node
/**
 * Hook PreToolUse — hace CUMPLIR la regla "nada de Python".
 *
 * ⭐ POR QUE EXISTE (auditoria 2026-10-14). `CLAUDE.md` dice "⛔ NADA DE PYTHON" en
 * mayusculas desde el 5-oct, y la regla se incumplio igual. El motivo no era que
 * faltara la regla: era que NADA la ejecutaba. Al contrario, `~/.claude/settings.json`
 * tenia 27 reglas que la AUTO-APROBABAN, dos de ellas comodines:
 *
 *     Bash(python -c ' *)      <- cualquier python -c, para siempre
 *     Bash(python -)           <- justo la forma que cuelga esperando stdin
 *
 * O sea que la sesion que agarraba Python por reflejo no encontraba NINGUNA friccion:
 * ni prompt, ni bloqueo. Una regla que solo vive en la prosa no es una regla.
 *
 * El costo medido del incumplimiento (2026-10-12): 9 procesos `python.exe -` huerfanos
 * desde el 7-oct, 8.8 de 12 nucleos y ~366 h de CPU quemadas. Al matarlos, `nx build api`
 * paso de 2m05s a 1m03s.
 *
 * Esto es defensa en profundidad sobre las reglas `deny` del settings: el deny frena el
 * comando, este hook ademas EXPLICA con que reemplazarlo, que es lo que evita el segundo
 * intento con otra sintaxis.
 *
 * ⚠️ NO bloquea un `python` que sea parte de otra palabra ni de una ruta de datos
 * (`/ruta/python-cosas/archivo.txt`): se exige que sea el comando, al principio o
 * despues de un separador de shell. La prueba negativa vive en el bloque de abajo.
 */
'use strict';

let crudo = '';
process.stdin.on('data', (d) => (crudo += d));
process.stdin.on('end', () => {
  let entrada;
  try {
    entrada = JSON.parse(crudo || '{}');
  } catch {
    process.exit(0); // si no entiendo la entrada, no estorbo
  }
  const cmd = String(entrada?.tool_input?.command || '');
  const hallazgo = detecta(cmd);
  if (!hallazgo) process.exit(0);

  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason:
          `⛔ "${hallazgo}" esta prohibido en este repo (CLAUDE.md, regla 4).\n\n` +
          'Los lenguajes del proyecto son Node/TypeScript/JavaScript, SQL y PowerShell/Bash.\n' +
          'Medido el 2026-10-12: 9 procesos python huerfanos quemaron ~366 h de CPU y\n' +
          '8.8 de 12 nucleos; al matarlos `nx build api` bajo de 2m05s a 1m03s. Un\n' +
          '`python - <<EOF` mal formado no falla: espera stdin para siempre, sin log.\n\n' +
          'En su lugar:\n' +
          '  · archivos            -> las herramientas Edit / Write\n' +
          '  · procesar datos      -> node -e "..."  (SIN heredoc)\n' +
          '  · algo mas largo      -> Write al scratchpad + node <ruta>\n' +
          '  · texto               -> grep / awk / sed\n' +
          '  · base de datos       -> psql o node con knex',
      },
    })
  );
  process.exit(0);
});

/**
 * Devuelve el comando prohibido que encontro, o null.
 *
 * ⭐ Exige POSICION DE COMANDO, no mera presencia. La primera version solo buscaba
 * la palabra tras un espacio y su prueba negativa la agarro bloqueando
 * `grep python archivo.txt` y `grep -i python docs/GOTCHAS.md` -- o sea, impedia
 * BUSCAR la palabra en la documentacion que explica la regla. Un gate que estorba
 * en lo cotidiano se desactiva a la semana, y entonces no protege de nada.
 */
function detecta(cmd) {
  // 1. Partir en comandos por los separadores de shell.
  const partes = String(cmd).split(SEPARADORES);
  for (const parte of partes) {
    let t = tokens(parte);
    // 2. Saltar lo que SIEMPRE precede al comando real: asignaciones de entorno
    //    (VAR=x) y envoltorios (timeout 30, env, nohup, exec, time, sudo).
    for (;;) {
      if (!t.length) break;
      if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(t[0])) { t = t.slice(1); continue; }
      if (/^(env|nohup|exec|time|sudo|command)$/i.test(t[0])) { t = t.slice(1); continue; }
      if (/^timeout$/i.test(t[0])) { t = t.slice(/^[0-9]+[smh]?$/i.test(t[1] || "") ? 2 : 1); continue; }
      break;
    }
    // 3. Recien ahora, el primer token es el COMANDO. Se le quita la ruta y el
    //    sufijo .exe para que `C:/Python/python.exe` tambien caiga.
    const c = (t[0] || '')
      .replace(/^.*[\\/]/, '')
      .replace(/\.exe$/i, '')
      .toLowerCase();
    if (PROHIBIDOS.test(c)) return c;
  }
  return null;
}

/**
 * Separadores de shell que cierran un comando y abren otro.
 * Van como constante y no en linea porque este archivo ya se corrompio una vez
 * al escribirlo con un heredoc: bash se comio los backslashes del regex y dejo
 * una expresion invalida. Es la regla 13 de CLAUDE.md.
 */
const SEPARADORES = /\|\||&&|[;|&\n]|\$\(|`/;

/** Los comandos que este repo no usa (CLAUDE.md, regla 4). */
const PROHIBIDOS = /^(python3?|py|pip3?|pipx)$/;

/** Trocea respetando comillas, para que `echo "pip install"` no cuente. */
function tokens(s) {
  const trozos = String(s).match(/"[^"]*"|'[^']*'|\S+/g) || [];
  return trozos.filter((x) => !/^["']/.test(x));
}

module.exports = { detecta };
