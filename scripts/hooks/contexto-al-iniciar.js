#!/usr/bin/env node
/**
 * Hook SessionStart — ninguna sesión arranca en blanco.
 *
 * ⭐ POR QUE EXISTE. Varias sesiones de Claude trabajan sobre el MISMO árbol, y cada una
 * arranca sin saber qué hizo la anterior, en qué quedó el tablero ni qué archivos del árbol
 * son trabajo vivo de otra. Lo que no sabe, lo supone; y lo que supone, a veces lo inventa.
 * La memoria personal de Claude no se comparte entre máquinas (CLAUDE.md, «Modo de trabajo»):
 * lo que sí se comparte es el repo. Este hook le lee el repo a la sesión al empezar.
 *
 * Corre en los cuatro orígenes de SessionStart: `startup`, `resume`, `clear` y `compact`.
 * El de `compact` es el que más importa: después de compactar, la conversación perdió el
 * detalle, y la sesión tiende a seguir "de memoria" con lo que ya no ve.
 *
 * Qué le entrega a la sesión (en ese orden, acotado a ~70 renglones):
 *   1. Rama, último commit y lo que hay sin commitear en el árbol (¿de otra sesión?).
 *   2. El tablero (`.claude/skills/pm/tablero.js`): fases por estado y cupo.
 *   3. Los relevos de `.claude/relevos/` de las últimas 72 h (skill `relevo`).
 *   4. Dónde están los planes maestros (un objetivo por sesión).
 *   5. Las reglas para no inventar (skill `sin-inventar`).
 *
 * ⛔ NUNCA falla por su propia infraestructura: si git, node o un archivo no responden, esa
 *    sección dice "NO MEDIDO" y el hook sale 0. Un hook que rompe el arranque se desactiva.
 *
 * Prueba negativa:  node scripts/hooks/contexto-al-iniciar.js --self-test
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const RAIZ = path.resolve(__dirname, '..', '..');
const DIR_RELEVOS = path.join(RAIZ, '.claude', 'relevos');
const DIR_FASES = path.join(RAIZ, 'docs', 'IMPLEMENTACION', 'FASES');
const HORAS_RELEVO = 72;
const TOPE_ARBOL = 8;

// ───────────────────────── funciones puras (las prueba --self-test) ─────────────────────────

/** `git status --porcelain` → { modificados, sinVersionar, muestra[] } */
function resumenArbol(porcelain) {
  const lineas = String(porcelain || '').split('\n').filter((l) => l.trim());
  const sinVersionar = lineas.filter((l) => l.startsWith('??')).length;
  return {
    modificados: lineas.length - sinVersionar,
    sinVersionar,
    muestra: lineas.slice(0, TOPE_ARBOL).map((l) => l.trim()),
    resto: Math.max(0, lineas.length - TOPE_ARBOL),
  };
}

/** Saca los campos que importan de un relevo (formato de la skill `relevo`). */
function leerRelevo(texto) {
  const campo = (nombre) => {
    const m = String(texto || '').match(new RegExp('^\\**\\s*' + nombre + '\\s*\\**\\s*:\\s*\\**\\s*(.+)$', 'im'));
    return m ? m[1].trim() : null;
  };
  const titulo = (String(texto || '').match(/^#\s*(.+)$/m) || [])[1] || null;
  return {
    titulo: titulo ? titulo.replace(/^Relevo\s*[—-]\s*/i, '').trim() : null,
    objetivo: campo('Objetivo'),
    siguiente: campo('Siguiente paso'),
    decide: campo('Decide') || campo('Decisiones pendientes'),
  };
}

/** ¿El relevo es reciente? */
function esReciente(mtimeMs, ahoraMs, horas = HORAS_RELEVO) {
  return ahoraMs - mtimeMs <= horas * 3600 * 1000;
}

function haceCuanto(mtimeMs, ahoraMs) {
  const min = Math.round((ahoraMs - mtimeMs) / 60000);
  if (min < 60) return `hace ${min} min`;
  const h = Math.round(min / 60);
  return h < 48 ? `hace ${h} h` : `hace ${Math.round(h / 24)} d`;
}

/** Encabezados «PLAN MAESTRO» en un doc → [{ linea, texto }] */
function planesEn(texto) {
  return String(texto || '')
    .split('\n')
    .map((l, i) => ({ linea: i + 1, texto: l }))
    .filter((x) => /^#{1,4}\s.*plan maestro/i.test(x.texto))
    .map((x) => ({ linea: x.linea, texto: x.texto.replace(/^#+\s*/, '').trim() }));
}

const REGLAS_SIN_INVENTAR = [
  'Todo nombre que cites (archivo, función, tabla, columna, endpoint, permiso) lo VERIFICASTE con grep/Read en esta sesión. Si no, no lo escribas como hecho.',
  'Toda cifra lleva consulta y fecha. Lo que no mediste dice NO MEDIDO (ADR-056); nunca un número redondo "aproximado".',
  'Si el pedido es ambiguo o depende de algo que no está en el repo: pregunta (D1…Dn) en vez de suponer. Lo de dinero, personas y prioridades es de Edgar.',
  'Antes de cambiar código: skill `criterio` (ficha por capas). Antes de decir "listo": `cierre-por-capas`. Al pausar o antes de /clear: `relevo`.',
  'Archivos modificados que no son tuyos pueden ser de OTRA sesión: no los toques, no los commitees, pregunta.',
];

// ───────────────────────── lectura del entorno (tolerante a fallas) ─────────────────────────

function git(args) {
  try {
    return execFileSync('git', args, { cwd: RAIZ, encoding: 'utf8', timeout: 4000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
}

function seccionRepo() {
  const rama = git(['rev-parse', '--abbrev-ref', 'HEAD']);
  const ultimo = git(['log', '-1', '--format=%h · %ad · %s', '--date=format:%Y-%m-%d %H:%M']);
  const st = git(['status', '--porcelain', '--untracked-files=normal']);
  if (rama == null) return ['1. REPO: NO MEDIDO (git no respondió).'];
  const out = [`1. REPO: rama \`${rama}\` · último commit ${ultimo || 'NO MEDIDO'}`];
  if (st == null) {
    out.push('   Árbol: NO MEDIDO.');
  } else {
    const a = resumenArbol(st);
    if (!a.modificados && !a.sinVersionar) out.push('   Árbol limpio.');
    else {
      out.push(`   Árbol: ${a.modificados} modificado(s) · ${a.sinVersionar} sin versionar. ⚠️ Pueden ser de OTRA sesión — no los toques sin preguntar:`);
      for (const l of a.muestra) out.push('     ' + l);
      if (a.resto) out.push(`     … y ${a.resto} más`);
    }
  }
  return out;
}

function seccionTablero() {
  const script = path.join(RAIZ, '.claude', 'skills', 'pm', 'tablero.js');
  if (!fs.existsSync(script)) return ['2. TABLERO: NO MEDIDO (no está .claude/skills/pm/tablero.js).'];
  try {
    const txt = execFileSync(process.execPath, [script], { cwd: RAIZ, encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] });
    const lineas = txt.split('\n').filter((l) => l.trim()).slice(0, 9);
    return ['2. TABLERO (roadmap de CLAUDE.md, contado ahora):', ...lineas.map((l) => '   ' + l.trim())];
  } catch {
    return ['2. TABLERO: NO MEDIDO (tablero.js falló).'];
  }
}

function seccionRelevos(ahora) {
  const out = [`3. RELEVOS de sesiones (.claude/relevos/, últimas ${HORAS_RELEVO} h):`];
  let archivos = [];
  try {
    archivos = fs
      .readdirSync(DIR_RELEVOS)
      .filter((f) => f.endsWith('.md'))
      .map((f) => ({ f, st: fs.statSync(path.join(DIR_RELEVOS, f)) }))
      .filter((x) => esReciente(x.st.mtimeMs, ahora))
      .sort((a, b) => b.st.mtimeMs - a.st.mtimeMs)
      .slice(0, 6);
  } catch {
    /* sin carpeta = sin relevos */
  }
  if (!archivos.length) {
    out.push('   Ninguno. Si el usuario no dice en qué trabajar, pregúntale; no elijas tú una tarea.');
    return out;
  }
  for (const { f, st } of archivos) {
    let r = {};
    try {
      r = leerRelevo(fs.readFileSync(path.join(DIR_RELEVOS, f), 'utf8'));
    } catch {
      /* ilegible: se lista igual */
    }
    out.push(`   • ${f} · ${haceCuanto(st.mtimeMs, ahora)} · ${r.titulo || 'sin título'}`);
    out.push(`     Objetivo: ${r.objetivo || 'NO ESCRITO'} · Siguiente: ${r.siguiente || 'NO ESCRITO'}${r.decide ? ' · Decide: ' + r.decide : ''}`);
  }
  out.push('   Si el usuario retoma uno de estos, LEE el relevo completo antes de hacer nada (skill `relevo`).');
  return out;
}

function seccionPlanes() {
  const out = ['4. PLANES MAESTROS (un objetivo por sesión):'];
  let hallados = [];
  try {
    for (const f of fs.readdirSync(DIR_FASES).filter((x) => x.endsWith('.md'))) {
      for (const p of planesEn(fs.readFileSync(path.join(DIR_FASES, f), 'utf8'))) {
        hallados.push(`docs/IMPLEMENTACION/FASES/${f}:${p.linea} — ${p.texto}`);
      }
    }
  } catch {
    return ['4. PLANES MAESTROS: NO MEDIDO (no pude leer FASES/).'];
  }
  if (!hallados.length) out.push('   Ninguno encontrado.');
  hallados.slice(0, 5).forEach((h) => out.push('   ' + h));
  out.push('   Si te asignan un objetivo de un plan maestro (S1, S2… o un código [XX.N]), lee SU sección completa, su DoD y de qué depende.');
  return out;
}

function armar(origen, ahora = Date.now()) {
  const fecha = new Date(ahora).toLocaleString('es-MX', { timeZone: 'America/Mexico_City' });
  const out = [`CONTEXTO AL INICIAR — ${fecha} (origen: ${origen || 'startup'}) · scripts/hooks/contexto-al-iniciar.js`];
  if (origen === 'compact') {
    out.push('⚠️ SE COMPACTÓ LA CONVERSACIÓN: perdiste detalle. Antes de seguir, relee el relevo de tu objetivo y los archivos que estabas tocando. No sigas de memoria.');
  }
  out.push(...seccionRepo(), ...seccionTablero(), ...seccionRelevos(ahora), ...seccionPlanes());
  out.push('5. PARA NO INVENTAR (skill `sin-inventar`):');
  REGLAS_SIN_INVENTAR.forEach((r, i) => out.push(`   ${String.fromCharCode(97 + i)}) ${r}`));
  return out.join('\n');
}

// ───────────────────────── prueba negativa ─────────────────────────

if (process.argv.includes('--self-test')) {
  const fallas = [];
  const ok = (cond, msg) => cond || fallas.push(msg);

  const a = resumenArbol(' M apps/vendor/x.ts\n?? nuevo.md\n?? otro.md\n');
  ok(a.modificados === 1 && a.sinVersionar === 2, 'resumenArbol cuenta mal modificados/sin versionar');
  ok(resumenArbol('').modificados === 0, 'resumenArbol con árbol limpio');
  const muchos = resumenArbol(Array.from({ length: 12 }, (_, i) => ` M f${i}.ts`).join('\n'));
  ok(muchos.muestra.length === TOPE_ARBOL && muchos.resto === 4, 'resumenArbol no acota la muestra');

  const r = leerRelevo('# Relevo — [CGA-A.33] Saldo de CAOS\nObjetivo: el saldo defendible\n**Siguiente paso:** arqueo físico\nDecide: D1 qué suma Dotar\n');
  ok(r.titulo === '[CGA-A.33] Saldo de CAOS', `leerRelevo título: ${r.titulo}`);
  ok(r.objetivo === 'el saldo defendible', 'leerRelevo objetivo');
  ok(r.siguiente === 'arqueo físico', 'leerRelevo siguiente (con negritas)');
  ok(r.decide === 'D1 qué suma Dotar', 'leerRelevo decide');
  const vacio = leerRelevo('texto sin formato');
  ok(vacio.objetivo === null && vacio.titulo === null, 'leerRelevo inventa campos que no existen');

  const ahora = Date.UTC(2026, 10, 18, 12);
  ok(esReciente(ahora - 3600e3, ahora), 'esReciente: 1 h debería ser reciente');
  ok(!esReciente(ahora - 80 * 3600e3, ahora), 'esReciente: 80 h NO debería ser reciente');

  const pl = planesEn('# Fase\n## 11. ⭐⭐ PLAN MAESTRO — un objetivo por sesión\ntexto plan maestro suelto\n');
  ok(pl.length === 1 && pl[0].linea === 2, 'planesEn: debe tomar solo encabezados');

  const txt = armar('compact', ahora);
  ok(/SE COMPACTÓ/.test(txt), 'armar(compact) no avisa de la compactación');
  ok(!/SE COMPACTÓ/.test(armar('startup', ahora)), 'armar(startup) avisa de una compactación que no hubo');
  ok(txt.split('\n').length < 90, `la salida es demasiado larga (${txt.split('\n').length} renglones)`);

  if (fallas.length) {
    fallas.forEach((f) => console.error('✗ ' + f));
    console.error(`\ncontexto-al-iniciar: ${fallas.length} prueba(s) en rojo.`);
    process.exit(1);
  }
  console.log('contexto-al-iniciar: 14/14 pruebas ✓');
  process.exit(0);
}

// ───────────────────────── hook ─────────────────────────

let crudo = '';
process.stdin.on('data', (d) => (crudo += d));
process.stdin.on('end', () => {
  let origen = 'startup';
  try {
    origen = JSON.parse(crudo || '{}').source || 'startup';
  } catch {
    /* entrada rara: se arranca igual */
  }
  let texto;
  try {
    texto = armar(origen);
  } catch (e) {
    texto = 'CONTEXTO AL INICIAR: NO MEDIDO (el hook falló: ' + (e && e.message) + '). Lee CLAUDE.md y pregunta en qué trabajar.';
  }
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: texto } }));
  process.exit(0);
});
