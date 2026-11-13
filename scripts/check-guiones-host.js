#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * `[OPS.ING.2]` Compuerta: la lista de guiones del host de `md` (`ops/prod/guiones-del-host.txt`) no se desfasa de
 * lo que esos guiones llaman, y nadie vuelve a subirlos desde una laptop.
 *
 * ── Por qué existe ──────────────────────────────────────────────────────────
 * Desde el 2026-11-12, `md` instala sus guiones solo (`ops/prod/instalar-guiones.sh`, al final de cada despliegue)
 * desde el commit que la API ya sirve. Instala LO QUE DICE LA LISTA. Un guion nuevo que otro llama y nadie agrega a
 * la lista no llega nunca, sin un solo error: el que lo llama falla en `md` el día que lo necesita. Es el defecto
 * que `deploy.sh` ya había vivido con `compuerta-migraciones.sh` (`[CD.1]`): «si un guion de esta lista llama a
 * otro archivo, ese archivo va en la lista». Allá era una regla escrita; acá se comprueba.
 *
 * ── Qué mide (estático: sin red, sin base, sin `sh`) ────────────────────────
 *  1. La lista se lee: cada renglón es `<archivo> auto|mano [<destino>]`, el archivo existe en `ops/prod/`, sin
 *     repetidos, y un `auto` no declara destino.
 *  2. Todo `~/ops/prod/<x>` o `$HOME/ops/prod/<x>` (y `$(dirname "$0")/<x>`) que nombre un guion listado está en la
 *     lista. Lo que vive SÓLO en `md` (`vigia.env`, bitácoras, estados) no cuenta.
 *  3. Todo guion que la agenda (`ops/prod/crontab.*`) llama es `auto`.
 *  4. `auto-deploy.sh` llama a `instalar_guiones` en sus dos salidas sanas y nunca en seco, su latido calla en la
 *     prueba en seco y en seco no borra la cuarentena (si no, la prueba de `instalar-guiones.sh` miente o escribe).
 *  5. `deploy.sh subir_compose` sólo sube desde la laptop lo que la lista marca `mano`.
 *
 *   node scripts/check-guiones-host.js                # la compuerta
 *   node scripts/check-guiones-host.js --self-test    # prueba negativa + el instalador en un repo de juguete
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync, spawnSync } = require('child_process');

const RAIZ = path.resolve(__dirname, '..');
const PROD = 'ops/prod';
const LISTA = `${PROD}/guiones-del-host.txt`;
const SOLO_EN_MD = new Set(['vigia.env']);
const EXT_GUION = /\.(sh|awk|sql|js)$/;

/** Lee la lista: [{ archivo, modo, destino, linea }] y los errores de forma. */
function leerLista(texto) {
  const entradas = [];
  const errores = [];
  texto.replace(/\r/g, '').split('\n').forEach((crudo, i) => {
    const l = crudo.replace(/#.*/, '').trim();
    if (!l) return;
    const [archivo, modo, destino, ...resto] = l.split(/\s+/);
    const donde = `${LISTA}:${i + 1}`;
    if (resto.length) errores.push(`${donde}: campos de más («${l}»)`);
    if (!['auto', 'mano'].includes(modo)) errores.push(`${donde}: modo «${modo ?? ''}» (auto | mano)`);
    if (/[/\\]/.test(archivo) || archivo.startsWith('.')) errores.push(`${donde}: «${archivo}» no es un nombre de ~/ops/prod`);
    if (modo === 'auto' && destino) errores.push(`${donde}: ${archivo} es auto y declara destino (un auto vive en ~/ops/prod)`);
    if (entradas.some((e) => e.archivo === archivo)) errores.push(`${donde}: ${archivo} repetido`);
    entradas.push({ archivo, modo, destino, linea: i + 1 });
  });
  return { entradas, errores };
}

/** Los nombres de `~/ops/prod` que un guion llama. */
function llamadas(texto) {
  const out = new Set();
  const re = /(?:\$HOME|\$\{HOME\}|~)\/ops\/prod\/([A-Za-z0-9][A-Za-z0-9._-]*)|\$\(dirname "\$0"\)\/([A-Za-z0-9][A-Za-z0-9._-]*)/g;
  for (const m of texto.matchAll(re)) out.add(m[1] ?? m[2]);
  return out;
}

/**
 * La compuerta, PURA: recibe los textos (ruta del repo → contenido) y la lista de archivos de `ops/prod/`, devuelve
 * los hallazgos. Pura para que la prueba negativa la rompa sin tocar el disco.
 */
function revisar(textos, enProd) {
  const h = [];
  const lista = textos[LISTA];
  if (lista == null) return [`${LISTA}: no existe — sin lista, md no instala nada`];
  const { entradas, errores } = leerLista(lista);
  h.push(...errores);
  if (!entradas.length) h.push(`${LISTA}: vacía`);
  const listados = new Map(entradas.map((e) => [e.archivo, e]));

  // 1. Cada listado existe en el repo.
  for (const e of entradas) if (!enProd.has(e.archivo)) h.push(`${LISTA}:${e.linea}: ${e.archivo} no está en ${PROD}/`);

  // 2. Lo que llaman los guiones listados, listado.
  for (const e of entradas) {
    const t = textos[`${PROD}/${e.archivo}`];
    if (t == null || !EXT_GUION.test(e.archivo)) continue;
    for (const x of llamadas(t)) {
      if (SOLO_EN_MD.has(x) || !EXT_GUION.test(x) || listados.has(x)) continue;
      h.push(enProd.has(x)
        ? `${PROD}/${e.archivo}: llama a ~/ops/prod/${x} y ${x} no está en ${LISTA} — en md no llegaría nunca`
        : `${PROD}/${e.archivo}: llama a ~/ops/prod/${x} y el repo no lo tiene`);
    }
  }

  // 3. Lo que llama la agenda, auto.
  for (const [ruta, t] of Object.entries(textos)) {
    if (!/^ops\/prod\/crontab\./.test(ruta)) continue;
    for (const linea of t.replace(/\r/g, '').split('\n')) {
      if (/^\s*#/.test(linea) || !linea.trim()) continue;
      for (const x of llamadas(linea)) {
        if (!EXT_GUION.test(x)) continue;
        const e = listados.get(x);
        if (!e || e.modo !== 'auto') h.push(`${ruta}: la agenda llama a ${x} y no es auto en ${LISTA}`);
      }
    }
  }

  // 4. El desplegador, cableado.
  const auto = textos[`${PROD}/auto-deploy.sh`] ?? '';
  const ad = `${PROD}/auto-deploy.sh`;
  if (!/^instalar_guiones\(\) \{$/m.test(auto)) h.push(`${ad}: no define instalar_guiones()`);
  // «Al día»: junto con la ingesta y NUNCA en seco (la prueba en seco de instalar-guiones.sh lo llamaría en ciclo).
  if (!/^\s*\[ "\$SECO" = 1 \] \|\| \{ desplegar_ingesta; instalar_guiones; \}$/m.test(auto)) {
    h.push(`${ad}: en el «al día» falta \`[ "$SECO" = 1 ] || { desplegar_ingesta; instalar_guiones; }\``);
  }
  // «Desplegado»: una sola llamada suelta, después de la ingesta (esa salida no existe en seco: sale antes).
  const sueltas = (auto.match(/^\s*instalar_guiones$/gm) ?? []).length;
  if (sueltas !== 1) h.push(`${ad}: en el «desplegado» instalar_guiones se llama ${sueltas} vez/veces (va 1)`);
  if (!/^\s*\[ "\$\{AUTO_DEPLOY_PRUEBA:-\}" = 1 \] && return 0$/m.test(auto)) h.push(`${ad}: latir() no calla con AUTO_DEPLOY_PRUEBA=1 (la prueba en seco pisaría el latido del despliegue)`);
  if (/^\s*rm -f "\$CUARENTENA"$/m.test(auto)) h.push(`${ad}: borra la cuarentena también en seco`);

  // 5. Desde la laptop, sólo lo que es `mano`.
  const dep = textos[`${PROD}/deploy.sh`] ?? '';
  const sube = /^\s*_guiones="([^"]*)"/m.exec(dep)?.[1].split(/\s+/).filter(Boolean) ?? [];
  for (const x of sube) {
    const e = listados.get(x);
    if (!e || e.modo !== 'mano') h.push(`${PROD}/deploy.sh: subir_compose sube ${x} desde la laptop y la lista no lo marca mano`);
  }
  return h;
}

function leerRepo() {
  const enProd = new Set(fs.readdirSync(path.join(RAIZ, PROD)));
  const textos = {};
  for (const f of enProd) {
    const p = path.join(RAIZ, PROD, f);
    if (fs.statSync(p).isFile()) textos[`${PROD}/${f}`] = fs.readFileSync(p, 'utf8');
  }
  return { textos, enProd };
}

// ── La prueba negativa ─────────────────────────────────────────────────────────────────────────────────────────────
function selfTest() {
  let fallas = 0;
  const caso = (ok, msg) => { if (ok) console.log('  ✓ ' + msg); else { console.error('  ✖ ' + msg); fallas++; } };
  const { textos, enProd } = leerRepo();
  const base = revisar(textos, enProd);
  caso(base.length === 0, `el repo tal cual pasa (${base.length} hallazgo(s)${base.length ? ': ' + base[0] : ''})`);

  const mut = (desc, cambiar, espera) => {
    const t = { ...textos };
    const e = new Set(enProd);
    cambiar(t, e);
    const r = revisar(t, e);
    caso(r.some((x) => espera.test(x)), `${desc} → rojo`);
  };
  mut('sacar pgprod.sh de la lista', (t) => { t[LISTA] = t[LISTA].replace(/^pgprod\.sh .*$/m, ''); }, /llama a ~\/ops\/prod\/pgprod\.sh y pgprod\.sh no está en/);
  mut('podar-registro.sh a mano', (t) => { t[LISTA] = t[LISTA].replace(/^podar-registro\.sh\s+auto$/m, 'podar-registro.sh mano'); }, /la agenda llama a podar-registro\.sh/);
  mut('un listado que no existe', (t) => { t[LISTA] += '\nfantasma.sh auto\n'; }, /fantasma\.sh no está en ops\/prod/);
  mut('modo inventado', (t) => { t[LISTA] += '\nnode.sh siempre\n'; }, /modo «siempre»/);
  mut('quitar la llamada del «desplegado»', (t) => { t[`${PROD}/auto-deploy.sh`] = t[`${PROD}/auto-deploy.sh`].replace(/^instalar_guiones$/m, ''); }, /se llama 0 vez/);
  mut('el «al día» instala también en seco', (t) => { t[`${PROD}/auto-deploy.sh`] = t[`${PROD}/auto-deploy.sh`].replace('[ "$SECO" = 1 ] || { desplegar_ingesta; instalar_guiones; }', '[ "$SECO" = 1 ] || desplegar_ingesta; instalar_guiones'); }, /en el «al día» falta/);
  mut('el latido habla en la prueba', (t) => { t[`${PROD}/auto-deploy.sh`] = t[`${PROD}/auto-deploy.sh`].replace(/^\s*\[ "\$\{AUTO_DEPLOY_PRUEBA:-\}" = 1 \] && return 0$/m, ''); }, /latir\(\) no calla/);
  mut('la cuarentena se borra en seco', (t) => { t[`${PROD}/auto-deploy.sh`] = t[`${PROD}/auto-deploy.sh`].replace('[ "$SECO" = 1 ] || rm -f "$CUARENTENA"', 'rm -f "$CUARENTENA"'); }, /borra la cuarentena también en seco/);
  mut('la laptop vuelve a subir auto-deploy.sh', (t) => { t[`${PROD}/deploy.sh`] = t[`${PROD}/deploy.sh`].replace('_guiones="docker-compose.yml Caddyfile"', '_guiones="docker-compose.yml Caddyfile auto-deploy.sh"'); }, /sube auto-deploy\.sh desde la laptop/);
  mut('un guion nuevo que nadie lista', (t, e) => { e.add('nuevo.sh'); t[`${PROD}/termometro.sh`] += '\nsh "$HOME/ops/prod/nuevo.sh"\n'; }, /llama a ~\/ops\/prod\/nuevo\.sh y nuevo\.sh no está en/);

  instaladorEnJuguete(caso);
  if (fallas) { console.error(`\n✖ self-test: ${fallas} caso(s) fallaron — la compuerta no sirve.`); process.exit(1); }
  console.log('\n✓ self-test: la compuerta marca lo que debe, deja pasar lo que debe, y el instalador es todo o nada.');
}

/** `instalar-guiones.sh` de verdad, en un repo de juguete: lo que promete su cabecera. Cuenta vía `caso`. */
function instaladorEnJuguete(c) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'guiones-'));
  try {
    const repo = path.join(tmp, 'repo');
    const dest = path.join(tmp, 'dest');
    const latidos = path.join(tmp, 'latidos.sql');
    const posix = (p) => p.replace(/\\/g, '/'); // `sh` de Git en Windows: rutas con `/`
    fs.mkdirSync(path.join(repo, PROD), { recursive: true });
    const g = (...a) => execFileSync('git', a, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    g('init', '-q'); g('config', 'user.email', 't@t'); g('config', 'user.name', 't'); g('config', 'core.autocrlf', 'false');
    fs.copyFileSync(path.join(RAIZ, PROD, 'instalar-guiones.sh'), path.join(repo, PROD, 'instalar-guiones.sh'));
    const escribir = (f, s) => fs.writeFileSync(path.join(repo, PROD, f), s);
    escribir('guiones-del-host.txt', 'pgprod.sh auto\nauto-deploy.sh auto\nuno.sh auto\ndatos.sql auto\nvigia-ci-green.sh mano\n');
    escribir('pgprod.sh', '#!/bin/sh\ncat >> "$LATIDOS"\n');
    escribir('auto-deploy.sh', '#!/bin/sh\necho "al día en v1"\n');
    escribir('uno.sh', '#!/bin/sh\necho uno-v1\n');
    escribir('datos.sql', 'SELECT 1;\n');
    escribir('vigia-ci-green.sh', '#!/bin/sh\necho vigia-v2\n');
    const commit = (m) => { g('add', '-A'); g('commit', '-qm', m); return g('rev-parse', 'HEAD'); };
    commit('v1');
    const correr = (...args) => {
      try { fs.rmSync(latidos, { force: true }); } catch { /* nada */ }
      const r = spawnSync('sh', [`${PROD}/instalar-guiones.sh`, ...args], {
        cwd: repo, encoding: 'utf8',
        env: { ...process.env, AUTO_DEPLOY_EN_CURSO: '1', INSTALAR_GUIONES_DEST: posix(dest), LATIDOS: posix(latidos), AUTO_DEPLOY_BRANCH: 'main' },
      });
      return { rc: r.status, out: `${r.stdout}${r.stderr}`, latido: fs.existsSync(latidos) ? fs.readFileSync(latidos, 'utf8') : '' };
    };
    const en = (f) => fs.readFileSync(path.join(dest, f), 'utf8');
    const hay = (f) => fs.existsSync(path.join(dest, f));

    // 1. Primera vez: pone los auto, avisa del mano que no está.
    let r = correr();
    c(r.rc === 0 && en('uno.sh').includes('uno-v1') && hay('datos.sql') && !hay('vigia-ci-green.sh'),
      'primera pasada: instala los auto y NO el mano');
    c(/a mano y DISTINTO.*vigia-ci-green\.sh/.test(r.out) && /'ok'/.test(r.latido), 'avisa del mano que falta, y late ok');
    if (process.platform !== 'win32') c((fs.statSync(path.join(dest, 'uno.sh')).mode & 0o111) !== 0, 'el .sh queda ejecutable');

    // 2. Otra vez, sin cambios: no toca nada.
    const mtime = fs.statSync(path.join(dest, 'uno.sh')).mtimeMs;
    r = correr();
    c(r.rc === 0 && /al día con/.test(r.out) && fs.statSync(path.join(dest, 'uno.sh')).mtimeMs === mtime, 'segunda pasada: al día, no reescribe');

    // 3. Cambia uno: lo pone y deja la previa.
    escribir('uno.sh', '#!/bin/sh\necho uno-v2\n'); commit('v2');
    r = correr('--ver');
    c(r.rc === 0 && /se instalarían desde \w+: uno\.sh/.test(r.out) && en('uno.sh').includes('uno-v1') && r.latido === '',
      '--ver: dice qué se instalaría, no instala y no late');
    r = correr();
    c(r.rc === 0 && en('uno.sh').includes('uno-v2') && en('uno.sh.anterior').includes('uno-v1'), 'un cambio: se instala y la previa queda en .anterior');

    // 4. NEGATIVA: uno no pasa sh -n → no se instala NINGUNO (tampoco el otro que cambió bien).
    escribir('uno.sh', '#!/bin/sh\nif then\n'); escribir('datos.sql', 'SELECT 2;\n'); commit('v3-roto');
    r = correr();
    c(r.rc === 1 && en('uno.sh').includes('uno-v2') && en('datos.sql').includes('SELECT 1') && /no pasa sh -n/.test(r.out) && /'error'/.test(r.latido),
      'NEGATIVA sh -n: sale 1, no instala ninguno, late error');

    // 5. NEGATIVA: el auto-deploy nuevo no pasa su prueba en seco → vuelven TODOS los de la pasada.
    escribir('uno.sh', '#!/bin/sh\necho uno-v4\n'); escribir('auto-deploy.sh', '#!/bin/sh\necho "se rompió"; exit 3\n'); commit('v4');
    r = correr();
    c(r.rc === 1 && en('auto-deploy.sh').includes('al día en v1') && en('uno.sh').includes('uno-v2') && en('datos.sql').includes('SELECT 1'),
      'NEGATIVA prueba en seco: vuelven auto-deploy.sh, uno.sh y datos.sql a su copia anterior');
    c(/NO pasó su prueba en seco/.test(r.out) && /se rompió/.test(r.out), 'y dice por qué, con la salida de la prueba');

    // 6. La prueba en seco pasa (y le llegan las variables de prueba) → queda puesto.
    escribir('auto-deploy.sh', '#!/bin/sh\n[ "$AUTO_DEPLOY_PRUEBA" = 1 ] && [ "$1" = --seco ] || exit 4\necho "al día en v5"\n'); commit('v5');
    r = correr();
    c(r.rc === 0 && en('auto-deploy.sh').includes('v5') && /pasó su prueba en seco: al día en v5/.test(r.out),
      'el desplegador nuevo se prueba en seco CON AUTO_DEPLOY_PRUEBA=1 y queda puesto');

    // 7. NEGATIVA: la lista nombra algo que el commit no trae → no toca nada.
    escribir('guiones-del-host.txt', 'pgprod.sh auto\nauto-deploy.sh auto\nuno.sh auto\nno-existe.sh auto\n');
    escribir('uno.sh', '#!/bin/sh\necho uno-v6\n'); commit('v6');
    r = correr();
    c(r.rc === 1 && en('uno.sh').includes('uno-v4') && /no-existe\.sh/.test(r.out), 'NEGATIVA lista rota: sale 1 y no instala la mitad');
  } catch (e) {
    c(false, `el juguete no corrió: ${e.message.split('\n')[0]}`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function main() {
  const { textos, enProd } = leerRepo();
  const h = revisar(textos, enProd);
  if (h.length) {
    console.error(`✖ guiones-host — ${h.length} problema(s):\n`);
    for (const x of h) console.error('  ' + x);
    console.error(`\n  md instala SÓLO lo que dice ${LISTA}. Lo que no está ahí no llega nunca, y nadie avisa.`);
    process.exit(1);
  }
  const { entradas } = leerLista(textos[LISTA]);
  const auto = entradas.filter((e) => e.modo === 'auto').length;
  console.log(`✓ guiones-host: ${entradas.length} en la lista (${auto} auto, ${entradas.length - auto} a mano); todo lo que llaman está listado`);
}

if (require.main === module) {
  if (process.argv.includes('--self-test')) selfTest();
  else main();
}

module.exports = { revisar, leerLista, llamadas };
