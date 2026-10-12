#!/usr/bin/env node
/**
 * `[AUD.1]` — **Auditoría de UNA pantalla contra las reglas binding de `DESIGN.md`.**
 *
 * ── Por qué existe ───────────────────────────────────────────────────────────────────────
 * Las cinco compuertas de CSS (`check:templates`, `estilos`, `motion`, `tokens`, `tables`)
 * miden **propiedades del archivo**: que el literal cierre, que el color sea un token, que la
 * animación no pase de 350 ms. Ninguna mide si la pantalla **cumple el contrato de producto**:
 * si abre con el veredicto, si separa cargando de vacío de error, si declara la edad del dato,
 * si su rejilla se recorre con el teclado.
 *
 * Eso se venía revisando a mano, pantalla por pantalla, y a mano se escapa: `Flota RD` publicó
 * CERO unidades desde su estreno y nadie lo vio hasta que un humano miró la pantalla
 * (`[RD.60.3]`); el configurador del bono se borró en un refactor y el defecto llegó al usuario
 * (`[RD.UI.2.2]`). Una revisión que sólo ocurre cuando alguien se acuerda no es una revisión.
 *
 * ── Qué mide, y qué NO ───────────────────────────────────────────────────────────────────
 * Mide lo que se puede leer del código con certeza: la presencia de los primitivos que
 * `DESIGN.md` marca binding, y la forma de la rejilla. **No mide** si la pantalla se entiende —
 * eso sigue necesitando ojos. Lo que hace es que los ojos lleguen a una pantalla que ya pasó
 * lo mecánico, en vez de gastarse en encontrarlo.
 *
 * ⛔ Y no mide el TIEMPO: el gate de «menos de 1 segundo» se mide contra la base, no contra el
 * archivo. Vive en `check-pantalla-tiempo.js`, que corre dentro del pod porque desde una
 * laptop la latencia de red contamina la cifra.
 *
 * Uso:
 *   node scripts/check-pantalla.js comercial-comisiones        # una
 *   node scripts/check-pantalla.js --todas                     # el barrido
 *   node scripts/check-pantalla.js --self-test                 # prueba negativa
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', 'apps/view/src/app/modules');

/**
 * Las reglas. Cada una dice de dónde sale, qué busca y **por qué importa** — un hallazgo sin
 * su porqué se lee como capricho y se ignora.
 */
const REGLAS = [
  {
    id: 'Q.1', nombre: 'answer-first',
    busca: (s) => /<app-metric-strip|<app-metric-card/.test(s),
    por: 'La pantalla abre con el veredicto, no con el grid crudo. Sin MetricStrip lo primero que ve el usuario son N filas.',
  },
  {
    id: '§2', nombre: 'matriz de estados',
    busca: (s) => /<app-load-state/.test(s),
    por: 'Sin LoadState, «cargando», «vacío» y «error de red» se pintan igual — y el usuario no sabe si reintentar.',
  },
  {
    id: '§9', nombre: 'frescura del dato',
    busca: (s) => /<app-freshness-pill/.test(s),
    por: 'Dato volátil sin edad declarada se lee como «al día». Es el defecto que costó seis días de precios viejos.',
    soloSi: (s) => /signal<|httpResource|\.subscribe\(/.test(s),
  },
  {
    id: 'P', nombre: 'ayuda contextual',
    busca: (s) => /<app-context-help/.test(s),
    por: 'Pantalla con jerga derivada (veredictos, cobertura, umbrales) necesita su entrada del diccionario versionado.',
    soloSi: (s) => /veredicto|cobertura|umbral|sin_fuente|no_comparable|comisiona/.test(s),
    aviso: true,
  },
  {
    id: 'O.4', nombre: 'rejilla en p-table',
    busca: (s) => !/^\s*<table/m.test(s) || /<p-table/.test(s),
    por: 'Sin p-table no hay pSelectableRow: el teclado (D.7), el header fijo y la 1a columna congelada quedan fuera de alcance.',
  },
  {
    id: 'D.7', nombre: 'teclado en la rejilla',
    busca: (s) => !/<p-table/.test(s) || /\[pSelectableRow\]|<button/.test(s),
    por: 'Una rejilla que no se recorre con flechas obliga a tabular fila por fila, o a usar el mouse.',
  },
  {
    id: 'D.8', nombre: 'busqueda canonica',
    busca: (s) => !/toLowerCase\(\)\.includes\(/.test(s),
    por: 'toLowerCase().includes() ignora acentos, no admite varias palabras y es sensible al orden. Va applySmartSearch o coincideBusqueda.',
  },
  {
    id: 'D.4c', nombre: 'tablist solo si son pestanas',
    busca: (s) => !/role="tablist"/.test(s) || /role="tabpanel"/.test(s),
    por: 'Un role=tablist sin tabpanel miente al lector de pantalla: casi siempre es un selector de una opcion (radiogroup).',
  },
  {
    id: '#9', nombre: 'responsividad por contenedor',
    busca: (s) => /@container|dt-stack|dt-scope/.test(s),
    por: 'La pantalla se embebe a anchos distintos segun el sidebar. Sin @container ni dt-stack no declara que hace en angosto.',
    aviso: true,
  },
  {
    id: 'TBL', nombre: 'definicion fija escondida en un title',
    // ⛔ La primera version contaba TODOS los title y marcaba 7 en Comisiones. Estaba mal
    // planteada: mezclaba dos cosas distintas. Un [title]='tipDias(l)' lleva los numeros de
    // ESE renglon -- es EVIDENCIA, y su casa es un side-peek, no el diccionario. Un
    // title='texto fijo' es una DEFINICION: la misma para todas las filas, y hoy solo la
    // alcanza quien tiene mouse. Se cuenta solo la segunda, que es la que la regla P sabe
    // adonde mandar.
    busca: (s) => (s.match(/[ \n\t]title="[^"]{20,}"/g) || []).length === 0,
    por: 'Una definicion FIJA dentro de un title solo existe para quien tiene mouse. Va al diccionario (regla P).',
    aviso: true,
  },
];


/**
 * `[AUD.2]` — **Chequeo SEMANTICO: el archivo no sólo parsea, TIPA.**
 *
 * ⛔ Nace de un defecto que llegó al build del usuario. Un `d as CommissionRunDetail` sobre el
 * payload del preview pasó las cinco compuertas de CSS, pasó el parseo con el compilador de TS,
 * pasó esta misma auditoría de reglas — y murió en `Build & typecheck` con `TS2352`. La causa:
 * **validar que un archivo PARSEA no es validar que TIPA.** Un `as` es sintaxis perfecta y
 * mentira semántica.
 *
 * Importa más de lo que parece en este repo: ⛔⛔ no se compila ni se levanta nada en local
 * (regla dura), así que el único que tipaba era el CI. Entre escribir el error y verlo pasan
 * un push y varios minutos — o, como pasó, lo ve el usuario antes que el CI.
 *
 * ⚠️ Cuesta ~10 s: carga el programa entero (1,075 archivos) para resolver los `paths` de
 * `tsconfig.base.json`. Por eso NO corre en el barrido `--todas` (serían 40 minutos): corre
 * cuando se audita UNA pantalla, que es justo cuando se la está tocando.
 */
function tipaBien(file) {
  const ts = require('typescript');
  const base = path.resolve(__dirname, '..');
  const cfg = ts.readConfigFile(path.join(base, 'tsconfig.base.json'), ts.sys.readFile);
  if (cfg.error) return { ok: null, motivo: 'no se pudo leer tsconfig.base.json' };
  const parsed = ts.parseJsonConfigFileContent(cfg.config, ts.sys, base);
  const abs = path.resolve(file);
  const prog = ts.createProgram([abs], { ...parsed.options, noEmit: true, skipLibCheck: true });
  const sf = prog.getSourceFile(abs);
  if (!sf) return { ok: null, motivo: 'el compilador no cargó el archivo' };
  const d = prog.getSemanticDiagnostics(sf);
  return {
    ok: d.length === 0,
    errores: d.slice(0, 5).map((x) => {
      const p = x.file.getLineAndCharacterOfPosition(x.start);
      return `TS${x.code} linea ${p.line + 1}: ${ts.flattenDiagnosticMessageText(x.messageText, ' ')}`;
    }),
  };
}

function pantallas() {
  const out = [];
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.component\.ts$/.test(e.name) && !/\.spec\.ts$/.test(e.name)) out.push(p);
    }
  })(ROOT);
  return out;
}

/** Sólo las PÁGINAS: un componente de `components/` es una pieza, no una pantalla. */
const esPagina = (p) => /[\\/]pages[\\/]/.test(p);

function auditar(file) {
  const s = fs.readFileSync(file, 'utf8');
  const fallas = [];
  const avisos = [];
  for (const r of REGLAS) {
    if (r.soloSi && !r.soloSi(s)) continue;
    if (r.busca(s)) continue;
    (r.aviso ? avisos : fallas).push(r);
  }
  return { fallas, avisos };
}

// ── Prueba negativa ────────────────────────────────────────────────────────────────────────
// Una compuerta que nunca vio un rojo es una intención. Se le da una pantalla inventada que
// viola TODO y se exige que las cace; y una que cumple, para que no marque falsos.
if (process.argv.includes('--self-test')) {
  const mala = `@Component({ template: \`<div><table><tr><td>x</td></tr></table>
    <div role="tablist"></div></div>\`, }) class X {
    f = this.rows.filter(r => r.n.toLowerCase().includes(q)); }`;
  const buena = `@Component({ template: \`<app-metric-strip /><app-load-state>
    <app-freshness-pill measures="data" /><p-table class="dt-stack"><tr [pSelectableRow]="r"></tr></p-table>
    </app-load-state>\`, }) class Y { x = signal(null); }`;
  const cazadas = REGLAS.filter((r) => (!r.soloSi || r.soloSi(mala)) && !r.busca(mala));
  const falsos = REGLAS.filter((r) => (!r.soloSi || r.soloSi(buena)) && !r.busca(buena));
  console.log(`  pantalla INVENTADA que viola todo -> ${cazadas.length} regla(s) cazadas: ${cazadas.map((r) => r.id).join(', ')}`);
  console.log(`  pantalla que CUMPLE              -> ${falsos.length} falso(s) positivo(s): ${falsos.map((r) => r.id).join(', ') || 'ninguno'}`);
  const ok = cazadas.length >= 5 && falsos.length === 0;
  console.log(ok ? '\n  ✔ la compuerta ve el rojo y no inventa' : '\n  ✖ CONTROL fallido');
  process.exit(ok ? 0 : 1);
}

const arg = process.argv[2];
const todas = process.argv.includes('--todas');
const objetivo = pantallas().filter((p) => (todas ? esPagina(p) : arg && p.includes(arg)));

if (!objetivo.length) {
  console.error(`  no encontré ninguna pantalla con "${arg || ''}". Usá --todas para el barrido.`);
  process.exit(1);
}

let conFallas = 0;
let totalFallas = 0;
for (const f of objetivo.sort()) {
  const { fallas, avisos } = auditar(f);
  const nom = path.basename(f).replace('.component.ts', '');
  // `[AUD.2]` El chequeo de tipos, solo al auditar UNA pantalla: cuesta ~10 s y en el barrido
  // serian 40 minutos. Es justo cuando se la esta tocando que importa.
  if (!todas) {
    const t = tipaBien(f);
    if (t.ok === false) {
      conFallas++; totalFallas += t.errores.length;
      console.log(`
  ✖ ${nom} — NO TIPA (esto muere en Build & typecheck):`);
      for (const e of t.errores) console.log(`      ✖ ${e}`);
    } else if (t.ok === null) {
      // Lo que no se pudo medir se DECLARA, nunca se da por bueno (ADR-056).
      console.log(`
  ⓘ ${nom}: tipos NO MEDIDOS — ${t.motivo}`);
    } else {
      console.log(`  ✔ ${nom}: tipa (0 errores semanticos)`);
    }
  }
  if (!fallas.length && !avisos.length) { if (!todas) console.log(`  ✔ ${nom}: cumple las ${REGLAS.length} reglas`); continue; }
  if (fallas.length) { conFallas++; totalFallas += fallas.length; }
  if (todas && !fallas.length) continue;
  console.log(`\n  ${fallas.length ? '✖' : '⚠'} ${nom}`);
  for (const r of fallas) console.log(`      ✖ ${r.id.padEnd(5)} ${r.nombre.padEnd(30)} ${r.por}`);
  if (!todas) for (const r of avisos) console.log(`      ⚠ ${r.id.padEnd(5)} ${r.nombre.padEnd(30)} ${r.por}`);
}

console.log(`\n  ${objetivo.length} pantalla(s) · ${conFallas} con falla(s) · ${totalFallas} falla(s) en total`);
process.exit(0); // informativo hasta que el barrido baje; el gate duro se enciende por pantalla
