#!/usr/bin/env node
/**
 * `[AUD.10]` — **Una lista que se topa en silencio.**
 *
 * ── El caso que la paga ────────────────────────────────────────────────────────────────────
 * Medido en producción el 2026-10-20, en el libro de `/finanzas/caja-general`, periodo 01→19 oct:
 *
 *     248 movimientos en el periodo · 100 pintados · 148 filas invisibles, $1,943,998.57
 *
 * Y nada lo decía. Dos omisiones, las dos de una línea: `cargar()` **no mandaba `limit`** (el
 * servidor usa 100 por default, tope 500) y **`has_more` llegaba en la respuesta y nadie lo
 * miraba**. El encabezado publicaba «248» porque el KPI se calcula sin tope — la pantalla decía
 * un número y mostraba otro.
 *
 * ⛔ **Y un paginador no lo arregla: lo empeora.** Pagina lo traído y publica «1–25 de 100» con
 * total seguridad mientras el encabezado dice 248. **La confianza que da un control es parte de
 * lo que afirma** (`docs/ESTANDAR_DE_INTERFACES.md`, Capa 1 · Veracidad, regla 1.2).
 *
 * ── Qué mide, exactamente ──────────────────────────────────────────────────────────────────
 * Una pantalla queda marcada cuando se dan **las dos** cosas a la vez:
 *
 *   1. llama a un método de servicio que acepta `limit` **sin mandarlo** (acepta un default del
 *      servidor que desde la pantalla es invisible), **y**
 *   2. en todo el archivo **no mira ninguna señal de tope** (`has_more`, `total`, `truncad`…).
 *
 * Las dos juntas son la definición de «topada en silencio». Por separado no: mandar el default a
 * sabiendas está bien si la lista es chica (los Cortes son 7 en todo el histórico, medido), y
 * mirar la señal ya es declararlo, que es lo único que esta regla exige.
 *
 * ⛔ **Lo que NO mide, declarado.** No sabe si el KPI y la lista cuentan el mismo universo —eso
 * necesita ejecutar— ni ve listas cuyo contrato no tiene señal de tope **ninguna**, que hoy son
 * casi todas: de 35 servicios con `limit`, sólo 2 respuestas declaran `has_more`. Esta compuerta
 * cubre el caso medido; el hueco grande queda declarado en `[AUD.11]`.
 *
 * Uso:
 *   node scripts/check-cifra-recorrible.js                # el barrido (sólo lo NUEVO frena)
 *   node scripts/check-cifra-recorrible.js --sellar-deuda # re-sella la línea base
 *   node scripts/check-cifra-recorrible.js --self-test    # prueba negativa
 */
const fs = require('fs');
const path = require('path');

const RAIZ = path.resolve(__dirname, '..');
const APPS = ['apps/view/src', 'apps/vendor/src', 'apps/portal/src'];
const DEUDA_FILE = path.join(__dirname, 'check-cifra-recorrible.deuda.json');

const rel = (f) => path.relative(RAIZ, f).replace(/\\/g, '/');

/**
 * Señales de que la pantalla SÍ mira si la lista se topó.
 *
 * ⛔⛔ **`totalRecords` NO está acá, y sacarlo fue el arreglo más importante de esta compuerta.**
 * Estaba en la primera versión y la volvía casi inútil: `totalRecords` es el token del paginador
 * de PrimeNG (`currentPageReportTemplate="{first}–{last} de {totalRecords}"`), o sea **el conteo
 * de lo YA TRAÍDO**. Con él en la lista, toda pantalla con paginador quedaba exenta — y son
 * exactamente las más propensas a mentir, porque un paginador publica «1–25 de 100» con total
 * seguridad mientras el encabezado dice 248.
 *
 * ⭐ Lo destapó la prueba negativa: rotas las dos condiciones en una pantalla real, la compuerta
 * seguía en verde. El `--self-test` no lo veía porque sus casos no tenían paginador.
 */
const SENALES = /has_more|hasMore|truncad|total_filas|\btopad/i;

function archivos(filtro) {
  const out = [];
  for (const base of APPS) {
    const dir = path.join(RAIZ, base);
    if (!fs.existsSync(dir)) continue;
    (function walk(d) {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (filtro(e.name)) out.push(p);
      }
    })(dir);
  }
  return out;
}

/**
 * Los métodos de servicio que aceptan `limit`. Se leen de la FIRMA, no del cuerpo: un `limit`
 * dentro del método es su propio default, no algo que la pantalla pueda mandar.
 */
function metodosConLimite() {
  const nombres = new Map();   // nombre -> Set<basename del .service.ts que lo declara con `limit`>
  for (const f of archivos((n) => n.endsWith('.service.ts'))) {
    const src = fs.readFileSync(f, 'utf8');
    // `nombre(args): Observable<…>` en una o varias líneas, hasta el primer `{` del cuerpo.
    const re = /(?:^|\n)\s{0,4}(?:async\s+)?([a-zA-Z_][\w$]*)\s*\(([\s\S]{0,600}?)\)\s*:/g;
    let m;
    while ((m = re.exec(src))) {
      const [, nombre, args] = m;
      if (!/\blimit\s*\??\s*:/.test(args)) continue;
      if (!nombres.has(nombre)) nombres.set(nombre, new Set());
      nombres.get(nombre).add(path.basename(f, '.ts'));
    }
  }
  return nombres;
}

/**
 * ⛔⛔ **El nombre del método NO alcanza: hay colisiones entre servicios, y una costó un push.**
 *
 * Medido el 2026-10-22. `caos.service.ts` declara `movimientos({ …, limit? })`, así que
 * `movimientos` entraba a la lista de «métodos con tope». Desde entonces la compuerta marcaba
 * **cualquier** `.movimientos(` de cualquier pantalla — y marcó
 * `contabilidad-contpaqi-puente.component.ts:905`, que llama al `movimientos()` de
 * `contpaqi-puente.service.ts`: **otro servicio, otra firma, SIN `limit`**, y cuyo backend es
 * explícitamente sin tope con el motivo escrito al lado («la pantalla dice 437 movimientos y la
 * lista tiene que poder llegar a 437»).
 *
 * O sea: pedía mandar un `limit` que el método no acepta, para evitar un truncamiento que no
 * existe. ⭐ Y eso es peor que no tener la compuerta: un rojo imposible de satisfacer enseña a
 * empujar con `--no-verify`, que es justamente la puerta que esta familia de candados cierra.
 *
 * El arreglo: se exige que la pantalla **importe** alguno de los servicios que de verdad
 * declaran ese método con `limit`. Si la pantalla no importa ningún `.service` por ruta relativa
 * —no se pudo resolver—, se marca igual: no medir no es permiso (ADR-056).
 */
function importaElServicio(src, duenos) {
  const re = /from\s+['"]([^'"]+)['"]/g;
  let m; let vioAlgunServicio = false;
  while ((m = re.exec(src))) {
    const base = path.basename(m[1]);
    if (!base.endsWith('.service')) continue;
    vioAlgunServicio = true;
    if (duenos.has(base)) return true;
  }
  return !vioAlgunServicio;   // sin servicios importados: no se pudo resolver -> se marca
}

/** El texto de los argumentos de `.metodo(` que arranca en `desde`, emparejando paréntesis. */
function argumentosDe(src, desde) {
  let d = 0;
  for (let i = desde; i < src.length && i < desde + 2000; i++) {
    if (src[i] === '(') d++;
    else if (src[i] === ')') { d--; if (d === 0) return src.slice(desde, i + 1); }
  }
  return src.slice(desde, desde + 2000);
}

/**
 * ⛔⛔ **El fuente SIN comentarios, y esto también lo destapó la prueba negativa.**
 *
 * La señal se buscaba sobre el archivo entero, así que **una palabra en prosa eximía la
 * compuerta**: el componente de Caja General explica en sus comentarios por qué la lista se
 * «topaba», y con eso solo quedaba exento aunque el código ya no mirara nada. Una compuerta que
 * se silencia escribiendo un comentario no es una compuerta.
 *
 * ⚠️ Se tiran RENGLONES de comentario, no se parsea: un `//` dentro de un literal se lleva
 * puesta la mitad de un `https://`, y acá hay plantillas de Angular con URLs adentro.
 */
function sinComentarios(src) {
  return src.split('\n')
    .filter((l) => !/^\s*(\/\/|\*|\/\*|<!--)/.test(l))
    .join('\n');
}

/**
 * ⛔⛔ **La señal se busca EN LA VECINDAD DE LA LLAMADA, no en el archivo entero.**
 *
 * La primera versión preguntaba «¿este archivo menciona `has_more`?» y eso es la granularidad
 * equivocada: `finanzas-caja-general.component.ts` tiene **8,000 líneas y cinco listas**, así que
 * **una sola que declarara su tope eximía a las otras cuatro**. Probado rompiendo el libro a
 * propósito: la compuerta seguía en verde porque otra lista del mismo archivo tenía su
 * `truncada` signal.
 *
 * Acá se mira desde la llamada hasta el final de su `subscribe`, que es donde se lee la
 * respuesta y, si alguien la mira, donde está.
 */
const VECINDAD = 1500;

function auditar(file, metodos) {
  const bruto = fs.readFileSync(file, 'utf8');
  const src = sinComentarios(bruto);
  const hallazgos = [];
  for (const [nombre, duenos] of metodos) {
    // El método se llama igual en varios servicios: sólo cuenta si ESTA pantalla usa uno que
    // de verdad acepta `limit`. Ver `importaElServicio`.
    if (!importaElServicio(bruto, duenos)) continue;
    /**
     * ⛔⛔ **DOS SEGMENTOS, NO UNO: `this.svc.metodo(` y NUNCA `this.metodo(`.**
     *
     * El primer intento era `\.<metodo>\(` a secas y dio **41 pantallas, con falsos adentro**.
     * Verificadas dos a mano antes de sellar nada: `almacen-cuadre:575` era `this.cortes()` y
     * `product-search:89` era `this.query()` — **lecturas de signal**, no llamadas a un
     * servicio. En Angular con signals `this.algo()` es la forma más común que hay en el
     * archivo, así que la aguja floja marcaba justamente el ruido de fondo.
     *
     * ⭐ Un servicio siempre se llama a través de su campo (`this.svc.x(`, `this.caja.x(`), o
     * sea **dos puntos**; un signal se lee con uno. Esa es toda la diferencia, y alcanza.
     */
    const re = new RegExp('\\bthis\\.[A-Za-z_$][\\w$]*\\.' +
      nombre.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\(', 'g');
    let m;
    while ((m = re.exec(src))) {
      const args = argumentosDe(src, m.index + m[0].length - 1);
      if (/\blimit\s*:/.test(args)) continue;   // manda el tope a sabiendas
      // ¿Mira la señal al recibir? Se busca desde la llamada hasta el final de su `subscribe`.
      if (SENALES.test(src.slice(m.index, m.index + VECINDAD))) continue;
      const linea = src.slice(0, m.index).split('\n').length;
      hallazgos.push({ metodo: nombre, linea });
    }
  }
  return hallazgos.length ? hallazgos : null;
}

// ── Prueba negativa ──────────────────────────────────────────────────────────────────────────
// Una compuerta que nunca vio un rojo es una intención. Se le dan los cuatro casos.
if (process.argv.includes('--self-test')) {
  const tmp = path.join(require('os').tmpdir(), 'cifra-recorrible-' + Date.now());
  fs.mkdirSync(tmp, { recursive: true });
  const escribir = (n, s) => { const p = path.join(tmp, n); fs.writeFileSync(p, s, 'utf8'); return p; };

  const malo = escribir('malo.ts', `class X { f() { this.svc.libro({ from: 'a', to: 'b' }).subscribe(); } }`);
  const conLimite = escribir('con-limite.ts', `class X { f() { this.svc.libro({ limit: 500, from: 'a' }).subscribe(); } }`);
  const conSenal = escribir('con-senal.ts', `class X { f() { this.svc.libro({ from: 'a' }).subscribe((r) => this.topado.set(!!r.has_more)); } }`);
  const sinLlamada = escribir('sin-llamada.ts', `class X { f() { return 1; } }`);
  /**
   * ⭐ El caso que el primer intento NO cubría y por eso dio 41 con falsos adentro: en Angular
   * con signals, `this.libro()` es una LECTURA, no una llamada a un servicio. Si este control
   * no estuviera, la compuerta marcaría medio repo y se apagaría en la primera corrida.
   */
  const signal = escribir('signal.ts', `class X { libro = signal([]); f() { return this.libro(); } }`);
  /**
   * ⭐ El caso de 2026-10-22: DOS servicios declaran `libro`, y sólo uno acepta `limit`. La
   * pantalla que usa el OTRO no puede mandar un tope que su método no tiene. Sin este control
   * la compuerta pedía lo imposible — y un rojo imposible se evade con `--no-verify`.
   */
  const otroServicio = escribir('otro-servicio.ts',
    `import { Otro } from './otro.service';\nclass X { f() { this.otro.libro({ from: 'a' }).subscribe(); } }`);
  const elDueno = escribir('el-dueno.ts',
    `import { Caos } from './caos.service';\nclass X { f() { this.caos.libro({ from: 'a' }).subscribe(); } }`);

  const metodos = new Map([['libro', new Set(['caos.service'])]]);
  const r = {
    malo: auditar(malo, metodos),
    conLimite: auditar(conLimite, metodos),
    conSenal: auditar(conSenal, metodos),
    sinLlamada: auditar(sinLlamada, metodos),
    signal: auditar(signal, metodos),
    otroServicio: auditar(otroServicio, metodos),
    elDueno: auditar(elDueno, metodos),
  };
  fs.rmSync(tmp, { recursive: true, force: true });

  const ok = r.malo && r.malo.length === 1 && !r.conLimite && !r.conSenal && !r.sinLlamada
    && !r.signal && !r.otroServicio && r.elDueno && r.elDueno.length === 1;
  console.log(`  topada en silencio       -> ${r.malo ? 'CAZADA' : 'se escapo'}`);
  console.log(`  manda limit a sabiendas  -> ${r.conLimite ? 'FALSO POSITIVO' : 'pasa'}`);
  console.log(`  mira has_more            -> ${r.conSenal ? 'FALSO POSITIVO' : 'pasa'}`);
  console.log(`  sin llamada              -> ${r.sinLlamada ? 'FALSO POSITIVO' : 'pasa'}`);
  console.log(`  lectura de signal        -> ${r.signal ? 'FALSO POSITIVO' : 'pasa'}`);
  console.log(`  mismo nombre, otro svc   -> ${r.otroServicio ? 'FALSO POSITIVO' : 'pasa'}`);
  console.log(`  el servicio que SI tiene -> ${r.elDueno ? 'CAZADA' : 'se escapo'}`);
  console.log(ok ? '\n  ✔ la compuerta ve el rojo y no inventa' : '\n  ✖ CONTROL fallido');
  process.exit(ok ? 0 : 1);
}

const metodos = metodosConLimite();
const pantallas = archivos((n) => /\.component\.ts$/.test(n) && !/\.spec\.ts$/.test(n));

// ── Sellar la deuda ──────────────────────────────────────────────────────────────────────────
if (process.argv.includes('--sellar-deuda')) {
  const mapa = {};
  for (const f of pantallas.sort()) {
    const h = auditar(f, metodos);
    if (h) mapa[rel(f)] = [...new Set(h.map((x) => x.metodo))].sort();
  }
  fs.writeFileSync(DEUDA_FILE, JSON.stringify(mapa, null, 2) + '\n', 'utf8');
  console.log(`\n  Sellado: ${Object.keys(mapa).length} pantalla(s) → ${rel(DEUDA_FILE)}`);
  console.log('  ⛔ Sellar NO es arreglar. Decí en el commit por qué sube el piso.\n');
  process.exit(0);
}

let DEUDA = {};
try { DEUDA = JSON.parse(fs.readFileSync(DEUDA_FILE, 'utf8')); } catch { /* sin deuda sellada */ }

const nuevas = [];
let enDeuda = 0;
for (const f of pantallas.sort()) {
  const h = auditar(f, metodos);
  if (!h) continue;
  const r = rel(f);
  const conocidos = DEUDA[r] || [];
  const frescos = h.filter((x) => !conocidos.includes(x.metodo));
  if (frescos.length) nuevas.push({ ruta: r, hallazgos: frescos });
  else enDeuda++;
}

console.log(`\n  ${pantallas.length} pantalla(s) · ${metodos.size} método(s) de servicio con tope · ` +
            `${enDeuda} en deuda declarada · ${nuevas.length} NUEVA(S)`);

if (nuevas.length) {
  console.error('\n❌ Lista(s) que se pueden topar EN SILENCIO:\n');
  for (const n of nuevas) {
    console.error(`   ${n.ruta}`);
    for (const h of n.hallazgos) console.error(`      línea ${h.linea}: .${h.metodo}(…) sin "limit" y la pantalla no mira si se topó`);
  }
  console.error('\n   El caso que esto evita: 248 movimientos publicados, 100 pintados, 148 filas');
  console.error('   invisibles por $1,943,998.57 — y nada lo decía (CG.127).');
  console.error('   Se arregla con UNA de las dos: mandá `limit` a sabiendas, o mirá `has_more`');
  console.error('   y decilo en pantalla. Ver docs/ESTANDAR_DE_INTERFACES.md §1.2.\n');
  process.exit(1);
}
process.exit(0);
