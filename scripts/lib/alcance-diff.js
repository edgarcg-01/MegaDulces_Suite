// ═══════════════════════════════════════════════════════════════════════════════════════════
// `[CD.2]` ACOTAR UNA COMPUERTA A LO QUE EL CAMBIO TOCO — Y DECLARARLO
//
// ── El defecto que corrige ─────────────────────────────────────────────────────────────────
// `check:tables` y `check:tokens` barren `apps/view/src`, `apps/vendor/src` y `apps/portal/src`
// ENTEROS. Medido el 2026-10-02 sobre el commit `1d3c504dc`, que toca UN archivo
// (`compras-pedido-real.component.ts`): su corrida de CI se puso roja por CINCO archivos
// distintos, ninguno de ellos el que el commit tocó.
//
// Resultado: **las 15 corridas más recientes del CI en rojo, las 15**. Una compuerta que se pone
// roja por deuda ajena enseña a ignorar el tablero, que es exactamente lo que ADR-056 nombra. El
// repo ya resolvió esta forma para `lint` con el ratchet de `scripts/lint-changed.js`; esto es el
// mismo mecanismo, aplicado a las compuertas de diseño que quedaron afuera.
//
// ── Por qué no alcanza con bajar el umbral o con una lista de excepciones ──────────────────
// Porque las dos esconden la deuda. El ratchet no la esconde: la deuda vieja se sigue
// MIDIENDO e imprimiendo, y lo único que cambia es quién la paga — el que la escribe, no el
// próximo que pase cerca.
//
// ⭐ SIEMPRE DECLARA SI ACOTO O NO. Un verde acotado y un verde de barrido completo no
//    significan lo mismo, y confundirlos es volver a dibujar un cero (ADR-056).
// ═══════════════════════════════════════════════════════════════════════════════════════════
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
}

/**
 * Resuelve el commit base contra el que comparar.
 * En CI lo pone `nrwl/nx-set-shas` (NX_BASE). Fuera de CI se usa el upstream, y si no hay,
 * no se acota: no se inventa una base.
 */
function resolverBase(cwd) {
  if (process.env.NX_BASE) return { base: process.env.NX_BASE, origen: 'NX_BASE (nx-set-shas)' };
  for (const cand of ['@{upstream}', 'origin/main']) {
    try {
      const sha = git(['merge-base', 'HEAD', cand], cwd);
      if (sha) return { base: sha, origen: `merge-base con ${cand}` };
    } catch { /* sigue probando */ }
  }
  return { base: null, origen: null };
}

/**
 * Acota `archivos` (rutas absolutas) a los que el cambio tocó.
 *
 * @returns {{archivos: string[], acotado: boolean, motivo: string, base: string|null}}
 *   `acotado:false` significa BARRIDO COMPLETO, y el llamador tiene que decirlo en su salida.
 */
function acotarACambiados(archivos, { raiz = process.cwd(), activar = null } = {}) {
  // Por defecto se acota sólo si hay una base real. `activar` permite forzarlo (--solo-cambiados)
  // o apagarlo (--todo) desde la línea de comandos del script que lo use.
  if (activar === false) {
    return { archivos, acotado: false, motivo: 'barrido completo pedido explícitamente', base: null };
  }

  const { base, origen } = resolverBase(raiz);
  if (!base) {
    return {
      archivos,
      acotado: false,
      motivo: 'no hay commit base contra el cual comparar — barrido completo',
      base: null,
    };
  }

  let cambiados;
  try {
    const head = process.env.NX_HEAD || 'HEAD';
    cambiados = new Set(
      git(['diff', '--name-only', `${base}..${head}`], raiz)
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)
        .map((l) => path.resolve(raiz, l))
    );
  } catch (e) {
    // ⛔ No se pudo leer el diff: NO se acota. Acotar sin poder medir el diff dejaría pasar todo.
    return {
      archivos,
      acotado: false,
      motivo: `no se pudo leer el diff (${e.message.split('\n')[0]}) — barrido completo`,
      base,
    };
  }

  // Se cruzan con los que existen: un archivo borrado aparece en el diff y no se puede leer.
  const filtrados = archivos.filter((f) => cambiados.has(path.resolve(f)) && fs.existsSync(f));

  return {
    archivos: filtrados,
    acotado: true,
    motivo: `acotado a ${filtrados.length} archivo(s) que este cambio tocó (base: ${origen})`,
    base,
  };
}

/** Línea única y uniforme para que las compuertas declaren su alcance igual. */
function declararAlcance(r, totalOriginal) {
  return r.acotado
    ? `   alcance: ${r.archivos.length} de ${totalOriginal} archivo(s) — ${r.motivo}`
    : `   alcance: BARRIDO COMPLETO (${totalOriginal} archivos) — ${r.motivo}`;
}

module.exports = { acotarACambiados, declararAlcance, resolverBase };
