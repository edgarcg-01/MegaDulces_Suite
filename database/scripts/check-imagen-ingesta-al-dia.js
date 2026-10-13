'use strict';
/**
 * ⭐⭐ `[CG.121]` — **Cuánto atraso lleva el CÓDIGO DE INGESTA que corre en producción.**
 *
 *   node database/scripts/check-imagen-ingesta-al-dia.js
 *   node database/scripts/check-imagen-ingesta-al-dia.js --dias=3     # tope antes de fallar
 *
 * Sólo lee. Necesita SSH a `md` (el mismo acceso que el runbook de despliegue).
 *
 * ── Por qué existe, medido el 2026-10-13 ────────────────────────────────────────────────────
 *
 * Edgar: *"aún existen capturas a mano, hay que buscar qué nos falló"*. La cadena resultó tener
 * **seis capas, cada una tapando a la siguiente**:
 *
 *   1. `ops/prod/auto-deploy.sh` **excluye `trade-ingest` a propósito** (`grep -v '^trade-ingest$'`):
 *      es la única imagen del cluster que NO se reconstruye sola.
 *   2. Nadie la reconstruyó desde el **07-oct** (`trade-ingest:6522e3fd9`), con `origin/main` en
 *      el 13-oct. **Seis días.**
 *   3. El oyente que refresca la bandeja de caja se escribió el **09-oct** (`[CG.76]`, commit
 *      `9a44d0403`) — o sea que **no está dentro de la imagen**: `grep -c escuchar` da 0.
 *   4. Su manifiesto `ops/k3s/26-caja-mv-push.deployment.yaml` está commiteado y **nunca llegó al
 *      servidor**: `~/ops/k3s` es una copia a mano y le faltan 4 archivos del repo.
 *   5. Su latido quedó en `running` desde el 09-oct, de una corrida a mano que murió.
 *   6. Y como `mv_caja_push` no tenía `maxRunH`, el tablero lo pintó **amarillo** cuatro días.
 *
 * ⛔ **Y lo que esto invalida es una regla que el equipo tenía por cierta**: *"editar un importer
 * despliega a prod al instante"*. Era verdad cuando la ingesta corría desde un checkout; desde
 * que vive en un contenedor **un importer editado no llega a producción hasta que alguien
 * reconstruya la imagen a mano**. Seis días de cambios de `database/importers/**` estaban en
 * `main` y no en prod sin que nada lo dijera.
 *
 * ── Qué mide, y qué NO ──────────────────────────────────────────────────────────────────────
 *
 * Mide **entrega**, no intención: el tag que los pods están corriendo contra `origin/main`. Y
 * enumera qué archivos de ingesta cambiaron en el medio, porque "4 días de atraso" no dice lo
 * mismo que "4 días de atraso y 11 importers tocados".
 *
 * ⚠️ **No reconstruye ni despliega nada.** Reconstruir la imagen de ingesta arrastra el trabajo
 * de todas las sesiones que tocaron importers, así que es una decisión de quien opera, no de una
 * compuerta.
 *
 * ⚠️ Si no hay SSH, reporta **NO MEDIDO** y sale 0. Un "no pude preguntar" no puede verse igual
 * que un "está al día" (ADR-056).
 */

const { execFileSync } = require('node:child_process');

const HOST = process.env.PROD_SSH || 'superoot@192.168.0.222';
const TOPE_DIAS = Number((process.argv.find((a) => a.startsWith('--dias=')) || '').split('=')[1]) || 3;

/** Los directorios cuyo código viaja DENTRO de `trade-ingest`. */
const RUTAS_INGESTA = ['database/importers/', 'services/feeds-ingest/', 'ops/ingest/'];

const sh = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8', timeout: 45_000 }).trim();

(() => {
  let tags;
  try {
    const out = sh('ssh', [
      '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', HOST,
      'kubectl -n ingesta get deploy -o jsonpath=' +
      '"{range .items[*]}{.metadata.name}{\\" \\"}{.spec.template.spec.containers[0].image}{\\"\\n\\"}{end}"',
    ]);
    tags = out.split('\n').filter(Boolean).map((l) => {
      const [carril, img] = l.trim().split(/\s+/);
      return { carril, tag: (img || '').split(':').pop() };
    });
  } catch (e) {
    console.log('ⓘ NO MEDIDO — no se pudo preguntarle al cluster: ' + String(e.message).slice(0, 90));
    console.log(`  Hace falta SSH a ${HOST}. "No pude preguntar" NO es "está al día".`);
    return;
  }

  if (!tags.length) { console.log('ⓘ NO MEDIDO — el namespace `ingesta` no devolvió deployments.'); return; }

  const unicos = [...new Set(tags.map((t) => t.tag))];
  console.log(`\nCarriles de ingesta en prod (${tags.length}):`);
  for (const t of tags) console.log(`  ${t.carril.padEnd(24)} ${t.tag}`);

  if (unicos.length > 1) {
    // ⚠️ Dos tags conviviendo no es un detalle: significa que un despliegue quedó a medias y
    // distintos carriles corren código distinto de la MISMA tubería.
    console.log(`\n⚠ ${unicos.length} tags distintos conviviendo: ${unicos.join(', ')}`);
  }

  let head, atraso = null, cambios = [];
  try {
    sh('git', ['fetch', '--quiet', 'origin', 'main']);
  } catch { /* sin red: se compara contra lo que haya local, y se dice */ }
  try {
    head = sh('git', ['rev-parse', '--short', 'origin/main']);
  } catch {
    console.log('\nⓘ NO MEDIDO — no se pudo leer `origin/main`.');
    return;
  }

  for (const tag of unicos) {
    let fechaImg;
    try {
      fechaImg = sh('git', ['log', '-1', '--format=%ad', '--date=short', tag]);
    } catch {
      console.log(`\n⚠ el tag \`${tag}\` no existe en este repo: no se puede fechar.`);
      continue;
    }
    const fechaHead = sh('git', ['log', '-1', '--format=%ad', '--date=short', head]);
    const dias = Math.round((new Date(fechaHead) - new Date(fechaImg)) / 86400000);
    atraso = Math.max(atraso ?? 0, dias);

    const lista = (() => {
      try {
        return sh('git', ['diff', '--name-only', `${tag}..${head}`, '--', ...RUTAS_INGESTA])
          .split('\n').filter(Boolean);
      } catch { return []; }
    })();
    cambios = cambios.concat(lista);

    console.log(`\n  imagen \`${tag}\` = ${fechaImg}   ·   origin/main \`${head}\` = ${fechaHead}`);
    console.log(`  atraso: ${dias} día(s) · ${lista.length} archivo(s) de ingesta cambiados en el medio`);
    for (const f of lista.slice(0, 15)) console.log(`      ${f}`);
    if (lista.length > 15) console.log(`      … y ${lista.length - 15} más`);
  }

  const unicosCambios = [...new Set(cambios)];
  console.log('');
  if (atraso == null) {
    console.log('ⓘ NO MEDIDO — ningún tag se pudo fechar contra este repo.');
  } else if (atraso > TOPE_DIAS) {
    console.log(
      `⚠ LA INGESTA ESTÁ ATRASADA ${atraso} día(s) (tope ${TOPE_DIAS}) con ${unicosCambios.length} archivo(s)`
      + ' cambiados que NO están corriendo en producción.');
    console.log('  `trade-ingest` está excluida del auto-deploy: sólo se reconstruye a mano.');
  } else {
    console.log(`✓ La ingesta corre código de hace ${atraso} día(s), dentro del tope de ${TOPE_DIAS}.`);
  }
})();
