#!/usr/bin/env node
/**
 * Compuerta de `git push` — los escaneos estáticos, ANTES del push.
 *
 * ─── Por qué existe ────────────────────────────────────────────────────────────
 * Medido el 2026-09-30, sobre los 30 días previos:
 *
 *   · ~58 de 60 commits a `main` entraron por **push directo**, no por PR.
 *   · De los últimos 20 pushes a `main`: **15 rojos, 1 verde**, 4 cancelados.
 *
 * El CI no está roto — atrapa defectos reales (dos veces ese día: tokens CSS que
 * no existen). Lo que falla es que corre DESPUÉS, sobre la rama de la que se
 * deploya. Esta compuerta mueve ese veredicto a ANTES del push, que es donde sirve.
 *
 * ─── ⚠️ Lo que cambió, y por qué CAPA 1 ya no bloquea ──────────────────────────
 * Este encabezado afirmaba tres cosas que HOY son falsas, y conviene dejar escrito
 * que caducaron en vez de borrarlas:
 *
 *   ✗ «mientras GitHub no la deje activar» · ✗ «el repo pasó a privado en plan
 *   free → 403» · ✗ «la protección de rama NO es una opción».
 *
 * Medido el 2026-10-02: el repo es **PÚBLICO**, y la protección de `main` está
 * **PRENDIDA** — exige `Build & typecheck (affected)` + `Secret scan (gitleaks)`,
 * y bloquea force-push, borrado e historia no lineal. El `403` de entonces era
 * «Upgrade to GitHub Pro»; hoy la API contesta con la protección real.
 *
 * El 2026-10-03 se apagó `enforce_admins` a pedido del dueño: **el admin empuja
 * directo a `main`** (modelo Railway: push → `sellar` mueve `ci-green` → el vigía
 * de `md` despliega en ~30 s). Cualquier otra cuenta sigue obligada a PR con los
 * dos checks en verde — eso NO se aflojó.
 *
 * O sea: la autoridad que CAPA 1 suplía ya vive del lado del servidor, y para el
 * admin —a quien GitHub ahora SÍ autoriza— bloquear acá es frenar lo que el
 * servidor permite. Por eso CAPA 1 pasó a AVISAR.
 *
 * ⛔ Y el motivo de fondo no es la comodidad: la única salida que un bloqueo deja
 *    es `git push --no-verify`, que apaga **también la CAPA 2** —los gates que sí
 *    atrapan defectos reales—. Un candado que obliga a desactivarlo entero para
 *    hacer lo que el servidor autoriza protege MENOS que no estar. La red no se
 *    perdió, se movió a `[CI.SELLO]`, que no se evade.
 *
 * ─── Las dos capas, y por qué son distintas ───────────────────────────────────
 *
 *   CAPA 1 — push directo a `main`. **Avisa y sigue.**
 *     Sigue existiendo porque empujar a la rama de la que se deploya merece una
 *     línea en pantalla: eso sale a producción solo, en ~30 s.
 *
 *   CAPA 2 — los gates baratos, acotados a TUS archivos. **Bloquea sólo lo tuyo.**
 *     ⛔ La trampa que esto evita: los gates son de repo completo, y el repo TIENE
 *     deuda preexistente (medido: `check-primeng-api` marca decenas de archivos de
 *     `styleClass` en <p-select>, ajenos a quien empuja hoy). Un hook que corriera
 *     el gate entero nacería ROJO para todos y lo desactivarían el primer día —
 *     que es exactamente cómo se muere una compuerta. Así que se intersecta la
 *     salida del gate con los archivos que viajan en ESTE push: si el hallazgo no
 *     lo trajiste vos, se informa como deuda y NO frena.
 *
 * ─── Lo que esta compuerta NO hace, declarado ─────────────────────────────────
 *   · No corre build, typecheck ni tests — eso es del CI (minutos, no segundos).
 *     Acá sólo viven los escaneos estáticos que cuestan ~10 s en total.
 *   · No protege contra `--no-verify`, ni contra un force-push hecho desde otra
 *     máquina o desde la web de GitHub, ni existe para quien no corrió
 *     `npm run hooks:install`. Es una compuerta de CLIENTE: sirve por RAPIDEZ
 *     —te dice en 2.5 s lo que el CI te diría en 5 min— no por autoridad.
 *
 *     ⭐ La que manda es `[CI.SELLO]`, del lado del servidor: el job `sellar` de
 *     `ci.yml` mueve la rama marcadora `ci-green` cuando pasan `build` y
 *     `secret-scan`, y `ops/prod/auto-deploy.sh` se niega a desplegar un commit
 *     que `ci-green` no haya bendecido. Esa no se evade.
 *     ⛔ La protección de rama de GitHub NO es una opción: el repo es privado en
 *     plan free y la cuenta no pasa a Pro (decisión del 2026-09-30).
 *   · No mide si tu cambio MEJORA la deuda; sólo que no la empeore en tus archivos.
 *
 * Uso: lo invoca `.githooks/pre-push` (ver `npm run hooks:install`).
 *      Escape de emergencia: `git push --no-verify` — deja rastro en el reflog y
 *      es exactamente lo que el CI va a encontrar después.
 */

'use strict';

const { execFileSync, execFile } = require('child_process');
const path = require('path');
const { DEL_PUSH } = require('./compuertas');
const { sinCodigo } = require('./check-commit-codigo');

const RAIZ = path.resolve(__dirname, '..');

/** Ramas a las que nadie empuja directo. `main` es de la que se deploya. */
const RAMAS_PROTEGIDAS = new Set(['main', 'master', 'production']);

/**
 * ⭐ Gates que corren acá: los que `scripts/compuertas.js` marca `push: true`.
 *
 * **Estaban declarados DOS veces** —acá y en `check-all.js`, con forma distinta— y las dos
 * listas ya habían divergido: medido el 2026-10-01, `check-dense-tables` y `check-css-tokens`
 * corrían en este push y **no** en `npm run check`, cuyo encabezado dice "corre todas las que
 * existen". Con un solo registro eso no se puede escribir.
 *
 * El criterio de admisión no cambia y vive en el registro, junto al campo `push`: escaneo
 * estático, sin red, sin DB, medido por debajo de ~3 s.
 *
 * 🔸 **Cambia una cosa, cosmética y declarada:** el rótulo que se imprime ahora es el corto del
 * registro (`templates`, `primeng`, `teclado`…) y no el largo que vivía sólo acá (`literales de
 * template`, `API retirada de PrimeNG`…). Es el mismo que imprime `npm run check`, así que las
 * dos salidas por fin nombran igual a la misma compuerta.
 */
const GATES = DEL_PUSH;

/** Un sha de puros ceros = la ref se está borrando. */
const SHA_CERO = /^0+$/;

function git(...args) {
  return execFileSync('git', args, { cwd: RAIZ, encoding: 'utf8' }).trim();
}

/**
 * Lee stdin de forma SÍNCRONA y robusta.
 *
 * ⚠️ Esto se escribió con `fs.readFileSync(0)` y la prueba negativa lo reprobó:
 * en Windows/Git Bash el fd 0 de un hook tira **EAGAIN**, el `catch` se lo
 * tragaba y la compuerta imprimía `✓` sin haber leído una sola ref. O sea: verde
 * sin haber medido nada, que es peor que estar roja. Por eso el EAGAIN se
 * reintenta en vez de darse por vencido, y por eso quien llama distingue
 * "leí y venía vacío" de "no pude leer" (ver `LecturaStdin.ok`).
 */
function leerStdinCrudo() {
  const fs = require('fs');
  const trozos = [];
  const buf = Buffer.alloc(65536);
  const limite = Date.now() + 2000; // techo: nunca colgar el push de nadie
  for (;;) {
    let n;
    try {
      n = fs.readSync(0, buf, 0, buf.length, null);
    } catch (e) {
      if (e.code === 'EAGAIN' && Date.now() < limite) continue; // stdin aún no listo
      if (e.code === 'EOF' || e.code === 'EAGAIN') break;
      return { ok: false, texto: '' };
    }
    if (n === 0) break;
    trozos.push(Buffer.from(buf.subarray(0, n)));
  }
  return { ok: true, texto: Buffer.concat(trozos).toString('utf8') };
}

/** Parsea el protocolo de `pre-push`: `<ref local> <sha local> <ref remota> <sha remoto>`. */
function leerStdin() {
  const { ok, texto } = leerStdinCrudo();
  const empujes = texto
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const [refLocal, shaLocal, refRemota, shaRemoto] = l.split(/\s+/);
      return { refLocal, shaLocal, refRemota, shaRemoto };
    });

  if (empujes.length) return empujes;

  // ── Respaldo: git no nos dio refs (o no se pudieron leer) ──────────────────
  // ⛔ Acá NO se puede devolver vacío y seguir: eso pinta de verde un push que
  //    nadie miró. La rama de HEAD es la que se está empujando en el caso común
  //    (`git push`, `git push origin <rama>`), así que al menos la CAPA 1 —que es
  //    la que ataca la causa raíz medida— sigue teniendo dientes.
  try {
    const rama = git('rev-parse', '--abbrev-ref', 'HEAD');
    const sha = git('rev-parse', 'HEAD');
    if (!ok) {
      console.error('⚠️  compuerta: no pude leer las refs del push; caigo a la rama de HEAD.');
    }
    return [{ refLocal: `refs/heads/${rama}`, shaLocal: sha, refRemota: `refs/heads/${rama}`, shaRemoto: '' }];
  } catch {
    return [];
  }
}

/**
 * Los archivos que viajan en este push.
 *
 * ⚠️ El caso que se olvida: rama nueva → el remoto manda sha de ceros, y
 * `git diff <ceros>..HEAD` no existe. Ahí el rango correcto es contra
 * `origin/main`, no contra la nada: si no, o revienta o devuelve el repo entero.
 */
function archivosDelPush({ shaLocal, shaRemoto }) {
  let base;
  if (!shaRemoto || SHA_CERO.test(shaRemoto)) {
    try {
      base = git('merge-base', 'origin/main', shaLocal);
    } catch {
      return null; // sin base comparable → no se puede acotar; se informa, no se bloquea
    }
  } else {
    base = shaRemoto;
  }
  try {
    // ⛔ TRES puntos, no dos. `git diff A..B` es un diff de dos PUNTAS: si tu rama
    //    está atrasada respecto del remoto, te atribuye también —al revés— todo lo
    //    que el remoto cambió y vos no tenés. Medido el 2026-09-30 con `main`
    //    ahead 9 / behind 13: la compuerta culpaba de `finanzas-caja-general`,
    //    `finanzas-mis-gastos` y `compras-costo-estandar` a un push que no tocaba
    //    ninguno de los tres. `A...B` arranca en el merge-base, que es la única
    //    definición honesta de "lo que traigo yo".
    //    ⚠️ En un push fast-forward normal los dos dan igual, así que esto NO se ve
    //    hasta que alguien empuja desde una rama atrasada — y entonces la compuerta
    //    frena por trabajo ajeno, que es como se pierde la confianza en un gate.
    return new Set(
      git('diff', '--name-only', `${base}...${shaLocal}`)
        .split('\n')
        .map((f) => f.trim())
        .filter(Boolean),
    );
  } catch {
    return null;
  }
}

/**
 * Tope por compuerta. Medido el 2026-11-20: las 28 juntas tardan 10–28 s, y ese día `lint-boundary-gate`
 * se quedó 10 min sin CPU ni hijos hasta que alguien la mató. Sin tope, el push espera para siempre.
 */
const TOPE_MS = Number(process.env.GATE_PUSH_TOPE_MS) || 180_000;

function correrGate(gate, topeMs = TOPE_MS) {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [gate.ruta || path.join(RAIZ, 'scripts', gate.script)],
      { cwd: RAIZ, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: topeMs, killSignal: 'SIGTERM' },
      (err, stdout, stderr) => {
        // ⛔ Una compuerta que vence el tope o muere por una señal NO midió nada. Antes caía como «rojo
        // sin rutas tuyas» = «deuda preexistente (no frena)» y el push pasaba: medido el 2026-11-20, una
        // compuerta matada a mano dio «nada rojo en tus archivos».
        // En Windows matar un proceso NO deja señal: Node lo ve como código de salida (así fue el `Stop-Process`
        // del 2026-11-20). Por eso también cuenta como muerta una compuerta roja que no imprimió NADA: toda
        // compuerta que de verdad encuentra algo lo dice.
        const salida = `${stdout || ''}${stderr || ''}`;
        const muda = Boolean(err) && !salida.trim();
        const murio = Boolean(err && (err.killed || err.signal)) || muda;
        const motivo = !murio
          ? null
          : err.killed
            ? `no terminó en ${Math.round(topeMs / 1000)} s`
            : err.signal
              ? `terminó por la señal ${err.signal}`
              : `terminó sin decir nada (código ${err.code})`;
        resolve({ gate, rojo: Boolean(err), murio, motivo, salida });
      },
    );
  });
}

/**
 * El veredicto, sin efectos (para poder probarlo). `muertas` = NO MEDIDAS: frenan, como el boundary-gate
 * cuando no puede medir (fail-closed, ADR-056). `tuyos` = rojas que nombran tus archivos. `ajenos` = rojas
 * que terminaron y no nombran nada tuyo (deuda preexistente, no frena).
 */
function clasificar(resultados, mios) {
  const muertas = [];
  const tuyos = [];
  const ajenos = [];
  for (const r of resultados) {
    if (r.murio) { muertas.push(r); continue; }
    if (!r.rojo) continue;
    const culpaTuya = [...rutasQueNombra(r.salida)].filter((x) => mios.has(x));
    if (culpaTuya.length) tuyos.push({ ...r, archivos: culpaTuya });
    else ajenos.push(r);
  }
  return { muertas, tuyos, ajenos };
}

/** Extrae las rutas de repo que el gate nombra en su salida.
 *
 * ⛔ El `replace` va ANTES del `match`, no después. Medido el 2026-10-09 en Windows, que es
 * donde corre el equipo: las compuertas imprimen con `path.relative()`, o sea `scripts\x.js`
 * con barra invertida, y `RUTA` exige barra normal. Normalizar el resultado del `match` no
 * sirve: no hay resultado que normalizar. Se extraían **0 rutas**, `culpaTuya` quedaba vacío
 * y un gate EN ROJO caía en la rama de abajo como «deuda preexistente, NO la trajiste vos
 * (no frena)» → el push pasaba con exit 0.
 *
 * ⭐ Una compuerta en rojo que el runner le atribuye a otro se lee igual que una verde.
 * Probado contra dos gates reales (`check-set-bind-param`, `check-sql-backticks`) sembrando
 * un archivo roto: antes 0 rutas extraídas, después 1 y el push bloquea.
 */
const RUTA = /(?:apps|libs|database|scripts|ops|tools)\/[A-Za-z0-9._/-]+\.[A-Za-z0-9]+/g;

function rutasQueNombra(salida) {
  return new Set(String(salida).replace(/\\/g, '/').match(RUTA) || []);
}

async function main() {
  const empujes = leerStdin();

  // ─── CAPA 1 — `main` no recibe pushes ──────────────────────────────────────
  for (const e of empujes) {
    if (!e.refRemota) continue;
    const rama = e.refRemota.replace('refs/heads/', '');
    if (!RAMAS_PROTEGIDAS.has(rama)) continue;
    if (SHA_CERO.test(e.shaLocal || '')) continue; // borrado de rama, no es un push de código

    // Cuántos commits traés. Si venimos del respaldo no hay sha remoto, así que
    // se cuenta contra la rama remota homónima — si no, dice "0" y desconcierta.
    const n = (() => {
      for (const base of [e.shaRemoto, `origin/${rama}`]) {
        if (!base || SHA_CERO.test(base)) continue;
        try {
          return git('rev-list', '--count', `${base}..${e.shaLocal}`);
        } catch {
          /* siguiente candidato */
        }
      }
      return '?';
    })();

    console.error(`
⚠️  Push DIRECTO a \`${rama}\` — permitido, y avisado.

   Traés ${n} commit(s). \`${rama}\` es la rama de la que se deploya: esto sale a
   producción solo, en ~30 s, sin que nadie más lo mire.

   Medido el 2026-09-30: de los últimos 20 pushes directos a \`main\`,
   **15 quedaron en rojo y 1 en verde**. Por eso el aviso.

   Lo que te cubre si éste sale rojo: \`sellar\` no mueve \`ci-green\`, y
   \`auto-deploy.sh\` se niega a desplegar lo que \`ci-green\` no bendijo. O sea
   \`main\` puede ponerse roja, pero lo rojo NO llega a producción — eso sí, tampoco
   llega nada más hasta que la arregles.

   Si preferís que lo revise alguien antes:

       git switch -c feat/<descripción-corta> && git push -u origin HEAD
       gh pr create --base main --fill
`);
    // ⚠️ AVISA, NO BLOQUEA — y el porqué está medido, no es una concesión:
    //
    //   · Hasta el 2026-10-02 esta compuerta era lo ÚNICO que había: GitHub
    //     contestaba 403 a `branches/main/protection` y a `rulesets`.
    //   · Hoy la protección está PRENDIDA (checks obligatorios, sin force-push,
    //     sin borrado, historia lineal) y el 2026-10-03 se apagó `enforce_admins`
    //     a pedido del dueño: el admin empuja directo, cualquier otra cuenta sigue
    //     obligada a PR con los dos checks en verde.
    //
    // ⛔ Bloquear acá sería frenar a quien el servidor YA autoriza, y la salida que
    //    eso fuerza es `--no-verify`, que apaga TAMBIÉN la CAPA 2 — los gates que sí
    //    atrapan defectos. Un candado que empuja a la gente a desactivarlo entero
    //    protege menos que no estar. Por eso informa y sigue a CAPA 2.
    //
    // La autoridad vive en `[CI.SELLO]`, del lado del servidor, que no se evade.
    break;
  }

  // ─── CAPA 3 — `[CAMBIOS.1]` cada commit lleva el código de su tarjeta ───────────
  // Regla de Edgar (2026-10-21): todo cambio se comunica. `CAMBIOS.md` del tablero se arma de
  // los títulos de commit; uno sin `[CÓDIGO]` no aparece bajo ninguna tarjeta. Se revisan SÓLO
  // los commits de ESTE push (no la historia).
  // ⛔ AVISA, no bloquea: el que FRENA es `.githooks/commit-msg`, antes de que el commit exista.
  //    Acá el commit ya existe y corregirlo exigiría reescribirlo (`--amend`/`rebase`), que en el
  //    checkout compartido está PROHIBIDO (CLAUDE.md: ya pisó trabajo ajeno). Lo que se coló sin
  //    hook queda a la vista en CAMBIOS.md como «sin tarjeta», con su autor.
  {
    const sinCodigoDelPush = [];
    for (const e of empujes) {
      if (!e.shaLocal || SHA_CERO.test(e.shaLocal)) continue;
      let base = e.shaRemoto && !SHA_CERO.test(e.shaRemoto) ? e.shaRemoto : null;
      if (!base) { try { base = git('merge-base', 'origin/main', e.shaLocal); } catch { base = null; } }
      if (!base) continue; // sin base comparable no se puede acotar: no se inventa un rango
      let titulos = [];
      try { titulos = git('log', '--no-merges', '--pretty=%h %s', `${base}..${e.shaLocal}`).split('\n').filter(Boolean); } catch { continue; }
      const malos = sinCodigo(titulos.map((t) => t.replace(/^\S+ /, '')));
      for (const t of titulos) if (malos.includes(t.replace(/^\S+ /, ''))) sinCodigoDelPush.push(t);
    }
    if (sinCodigoDelPush.length) {
      console.error(`
⚠️  [CAMBIOS.1] ${sinCodigoDelPush.length} commit(s) sin el código de su tarjeta en el título:
${sinCodigoDelPush.map((t) => '   · ' + t).join('\n')}

   Regla del equipo: todo cambio se comunica, y la bitácora (CAMBIOS.md del tablero PM) se arma
   de los títulos de commit. Estos van a aparecer ahí como «sin tarjeta», con tu nombre.
   ⛔ NO los reescribas (--amend/rebase están prohibidos en el checkout compartido). Para los
   siguientes, el hook commit-msg ya lo frena: corré \`npm run hooks:install\` si no te frenó.
   Formato: tipo([CÓDIGO]): qué cambia  ·  feat([CGA-A.16]): …  fix([OPS]): …  docs([ADR-095]): …
`);
    }
  }

  // ─── CAPA 2 — los gates, acotados a tus archivos ───────────────────────────
  const mios = empujes.reduce((acc, e) => {
    if (SHA_CERO.test(e.shaLocal || '')) return acc;
    const f = archivosDelPush(e);
    if (f) for (const x of f) acc.add(x);
    return acc;
  }, new Set());

  if (mios.size === 0) {
    console.error('✓ compuerta: nada que revisar (push sin archivos comparables).');
    process.exit(0);
  }

  const t0 = Date.now();
  const resultados = await Promise.all(GATES.map(correrGate));
  const ms = Date.now() - t0;

  const { muertas, tuyos, ajenos } = clasificar(resultados, mios);

  if (muertas.length) {
    console.error(`\n⛔ ${muertas.length} compuerta(s) NO MEDIDAS — tu push no se revisó entero, así que no pasa:\n`);
    for (const m of muertas) console.error(`   ✗ ${m.gate.nombre}: ${m.motivo}`);
    console.error(`
   No es un rojo de tu código: la compuerta no terminó. Vuelve a empujar; si se repite, corre
   el gate solo (node scripts/${muertas[0].gate.script}) y avisa en el canal del equipo.
   ⛔ No la saltes con --no-verify: una compuerta que no midió no puede decir «nada rojo».
`);
    process.exit(1);
  }

  if (ajenos.length) {
    console.error(
      `\nℹ️  Deuda preexistente, NO la trajiste vos (no frena): ${ajenos
        .map((a) => a.gate.nombre)
        .join(' · ')}`,
    );
  }

  if (tuyos.length === 0) {
    console.error(`✓ compuerta: ${GATES.length} gates en ${ms} ms · nada rojo en tus ${mios.size} archivo(s).\n`);
    process.exit(0);
  }

  console.error(`\n⛔ Tu push trae ${tuyos.length} gate(s) en rojo — bloqueado.\n`);
  for (const t of tuyos) {
    console.error(`   ✗ ${t.gate.nombre}`);
    for (const a of t.archivos) console.error(`       · ${a}`);
    const detalle = t.salida
      .split('\n')
      .filter((l) => l.trim() && !/^\s*$/.test(l))
      .slice(0, 14);
    console.error(detalle.map((l) => `     ${l}`).join('\n'));
    console.error('');
  }
  console.error(`   Corré el gate solo para ver el detalle completo, p. ej.:
       node scripts/${tuyos[0].gate.script}

   Si de verdad hay que empujar igual (y el CI lo va a marcar rojo de todos modos):
       git push --no-verify
`);
  process.exit(1);
}

/**
 * `--self-test`: la prueba negativa del veredicto (regla 12). Compuertas inventadas: una que se cuelga, una que
 * muere por una señal, una roja que no nombra tus archivos (deuda: NO debe frenar) y una verde.
 */
async function autoPrueba() {
  const fs = require('fs');
  const os = require('os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-push-self-'));
  const gate = (nombre, codigo) => {
    const ruta = path.join(dir, `${nombre}.js`);
    fs.writeFileSync(ruta, codigo);
    return { nombre, script: `${nombre}.js`, ruta };
  };
  const colgada = gate('colgada', 'setInterval(() => {}, 1000);');
  const senal = gate('senal', "process.kill(process.pid, 'SIGTERM'); setInterval(() => {}, 1000);");
  const ajena = gate('ajena', "console.log('falla en apps/view/src/otra-pantalla.ts'); process.exit(1);");
  const verde = gate('verde', "console.log('ok'); process.exit(0);");
  const tuya = gate('tuya', "console.log('falla en apps/view/src/mia.ts'); process.exit(1);");
  const mios = new Set(['apps/view/src/mia.ts']);
  const r = await Promise.all([colgada, senal, ajena, verde, tuya].map((g) => correrGate(g, 1500)));
  const { muertas, tuyos, ajenos } = clasificar(r, mios);
  const nombres = (xs) => xs.map((x) => x.gate.nombre).sort().join(',');
  const casos = [
    ['la colgada y la matada son NO MEDIDAS', nombres(muertas) === 'colgada,senal'],
    ['la colgada dice que venció el tope', /no terminó en 2 s/.test(r[0].motivo || '')],
    ['la roja ajena sigue siendo deuda (no frena)', nombres(ajenos) === 'ajena'],
    ['la roja con tu archivo frena', nombres(tuyos) === 'tuya'],
    ['la verde no aparece en ninguna lista', !muertas.concat(tuyos, ajenos).some((x) => x.gate.nombre === 'verde')],
  ];
  fs.rmSync(dir, { recursive: true, force: true });
  for (const [txt, ok] of casos) console.log(`${ok ? '✓' : '✗'} ${txt}`);
  const fallas = casos.filter(([, ok]) => !ok).length;
  console.log(fallas ? `✗ gate-push --self-test: ${fallas} falla(s)` : '✓ gate-push --self-test: 5/5');
  process.exit(fallas ? 1 : 0);
}

if (process.argv.includes('--self-test')) {
  autoPrueba().catch((e) => { console.error('✗ gate-push --self-test reventó:', e); process.exit(1); });
} else main().catch((e) => {
  // ⚠️ Una compuerta que revienta NO debe frenar el trabajo de nadie: se declara y deja pasar.
  console.error(`⚠️  compuerta de push: falló al correr (${e && e.message}). Se deja pasar; el CI decide.`);
  process.exit(0);
});
