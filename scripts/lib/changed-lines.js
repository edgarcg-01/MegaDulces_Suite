'use strict';
/**
 * Diff del PR/push: qué archivos cambiaron y QUÉ LÍNEAS son nuevas en cada uno.
 *
 * Esto no es nuevo: `scripts/lint-boundary-gate.js` (TS.0 / ADR-052) lo resolvió
 * primero y lo dijo bien — *ratchet a nivel LÍNEA, no archivo: tocar un service
 * legacy no te obliga a tipar toda su deuda vieja; sólo lo que agregás o
 * modificás debe venir limpio*. Lo que faltaba era que viviera en un lugar
 * compartido en vez de adentro de un solo script (ADR-056: un primitivo no
 * cierra la fase hasta que vive compartido o queda declarado como deuda).
 *
 * Base/head: `NX_BASE`/`NX_HEAD` (los pone `nrwl/nx-set-shas` en CI); en local
 * cae a `git merge-base origin/main HEAD`, y de ahí a `HEAD~1`.
 */

const { execSync } = require('node:child_process');

function sh(cmd) {
  return execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
}

/** SHA contra el que se compara. Nunca tira: si no puede, devuelve `HEAD`. */
function resolveBase() {
  if (process.env.NX_BASE) return process.env.NX_BASE;
  try { return sh('git merge-base origin/main HEAD'); } catch { /* sin origin/main */ }
  try { return sh('git rev-parse HEAD~1'); } catch { /* primer commit */ }
  return 'HEAD';
}

function resolveHead() {
  return process.env.NX_HEAD || 'HEAD';
}

/**
 * Archivos agregados/copiados/modificados/renombrados entre base y head.
 * ⚠️ `--diff-filter=ACMR` deja fuera los BORRADOS a propósito: lintar un archivo
 * que ya no existe falla por "no such file", no por su contenido.
 * Devuelve `null` si el diff no se pudo calcular — que NO es lo mismo que `[]`.
 */
function changedFiles(base, head, { workingTree = false } = {}) {
  try {
    const out = new Set(
      sh(`git diff --name-only --diff-filter=ACMR ${base} ${head}`)
        .split(String.fromCharCode(10)).map((f) => f.trim()).filter(Boolean),
    );
    if (workingTree) {
      // ⚠️ Sin esto, correr el gate en LOCAL antes de commitear devuelve "OK" sin
      // haber mirado el trabajo — un verde que no midió nada, que es peor que un
      // rojo (ADR-056). En CI no aplica: ahí base y head son commits.
      const extra = sh('git diff --name-only --diff-filter=ACMR HEAD') + String.fromCharCode(10)
        + sh('git ls-files --others --exclude-standard');
      for (const f of extra.split(String.fromCharCode(10))) if (f.trim()) out.add(f.trim());
    }
    return [...out];
  } catch {
    return null;
  }
}

/** ¿Está versionado en ese commit? Un archivo nuevo sin commitear no lo está. */
function isTracked(file, ref) {
  try { sh(`git cat-file -e ${ref}:"${file}"`); return true; } catch { return false; }
}

/**
 * Números de línea del LADO NUEVO que el diff agregó o modificó en un archivo.
 * Sale de `--unified=0`: las líneas `-` no avanzan el contador del lado nuevo.
 */
function changedLines(file, base, head, { workingTree = false } = {}) {
  const set = new Set();
  // Con `workingTree` el lado nuevo es el árbol de trabajo: se omite el head y
  // `git diff base -- file` compara base contra lo que hay en disco.
  const rango = workingTree ? `${base}` : `${base} ${head}`;
  let diff = '';
  try { diff = sh(`git diff --unified=0 ${rango} -- "${file}"`); } catch { return set; }
  let newLine = 0;
  for (const line of diff.split('\n')) {
    const m = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (m) { newLine = parseInt(m[1], 10); continue; }
    if (line.startsWith('+++') || line.startsWith('---')) continue;
    if (line.startsWith('+')) { set.add(newLine); newLine++; }
  }
  return set;
}

/** `Map<archivo, Set<línea nueva>>`. */
function changedLinesByFile(files, base, head, opts = {}) {
  const fs = require('node:fs');
  return new Map(files.map((f) => {
    // Archivo nuevo sin versionar: `git diff` no lo ve, y TODAS sus líneas son nuevas.
    if (opts.workingTree && !isTracked(f, base)) {
      let n = 0;
      try { n = fs.readFileSync(f, 'utf8').split(String.fromCharCode(10)).length; } catch { /* borrado entre medio */ }
      return [f, new Set(Array.from({ length: n }, (_, i) => i + 1))];
    }
    return [f, changedLines(f, base, head, opts)];
  }));
}

module.exports = { sh, resolveBase, resolveHead, changedFiles, changedLines, changedLinesByFile, isTracked };
