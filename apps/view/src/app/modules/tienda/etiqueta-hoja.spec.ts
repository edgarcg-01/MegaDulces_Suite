import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Candado de la geometría de la etiquetera (`/tienda/etiquetas`).
 *
 * La etiqueta se imprime; su tamaño vive en el CSS de `label.component`, cuántas caben por hoja
 * en una constante de `tienda-etiquetas.component`, y el tamaño ROTULADO en el texto de la
 * pantalla. Los tres pueden desincronizarse sin que nada falle — y lo estaban: la pantalla
 * afirmaba **100×40 mm** mientras el CSS imprimía **115×40**, quince milímetros más ancho que el
 * material que declaraba usar. Nadie lo iba a ver en código; sólo al medir un rollo.
 *
 * Acá se comprueba la aritmética completa: medida → huella con margen de recorte → columnas ×
 * filas → `PER_SHEET`, más que el rótulo diga la verdad y que el código de barras conserve su
 * mínimo físico.
 */

const LABEL = readFileSync(join(__dirname, 'components', 'label.component.ts'), 'utf8');
const PAGE = readFileSync(join(__dirname, 'pages', 'tienda-etiquetas.component.ts'), 'utf8');

/** Carta horizontal (279.4×215.9 mm) con el margen de `@page`, redondeado a mm enteros. */
const MARGEN_PAGE = Number(/@page\s*\{\s*size:\s*letter landscape;\s*margin:\s*([\d.]+)mm/.exec(PAGE)![1]);
const HOJA_W = Math.floor(279.4 - 2 * MARGEN_PAGE);
const HOJA_H = Math.floor(215.9 - 2 * MARGEN_PAGE);

const W = Number(/\.etq-label\{[\s\S]*?width:([\d.]+)mm/.exec(LABEL)![1]);
const H = Number(/\.etq-label\{[\s\S]*?height:([\d.]+)mm/.exec(LABEL)![1]);
/** Margen de recorte de cada etiqueta en la hoja (los tres lugares tienen que coincidir). */
const MARGENES = [...PAGE.matchAll(/app-label\{[^}]*margin:([\d.]+)mm/g)].map((m) => Number(m[1]));
const M = MARGENES[0];
const PER_SHEET = Number(/PER_SHEET = (\d+)/.exec(PAGE)![1]);

const cols = Math.floor(HOJA_W / (W + 2 * M));
const rows = Math.floor(HOJA_H / (H + 2 * M));

describe('etiquetera · la etiqueta, la hoja y el rótulo dicen lo mismo', () => {
  it('la etiqueta mide 82×35 mm', () => {
    expect({ W, H }).toEqual({ W: 82, H: 35 });
  });

  it('el margen de recorte es el MISMO en la simulación y en las dos rutas de impresión', () => {
    // Si divergen, la pantalla muestra una hoja que no es la que sale de la impresora.
    expect(MARGENES).toHaveLength(3);
    expect(new Set(MARGENES).size).toBe(1);
  });

  it('columnas × filas == PER_SHEET (la constante no puede quedarse atrás del tamaño)', () => {
    expect(cols * rows).toBe(PER_SHEET);
    expect(PER_SHEET).toBe(15);
  });

  it('la última fila y la última columna entran con holgura, no al ras', () => {
    // A 2.5 mm de margen la huella medía 87×40 y cinco filas daban 200 mm contra 200 mm
    // disponibles: cero tolerancia, y cualquier redondeo de subpíxel manda la 5ª fila a la
    // hoja siguiente — 12 aquí y 3 allá, gastando MÁS papel que antes.
    expect(HOJA_W - cols * (W + 2 * M)).toBeGreaterThanOrEqual(3);
    expect(HOJA_H - rows * (H + 2 * M)).toBeGreaterThanOrEqual(3);
  });

  it('el rótulo de la pantalla dice la medida REAL', () => {
    // Éste es el bug que existió: el texto decía 100×40 y el CSS imprimía 115×40.
    const rotulos = [...PAGE.matchAll(/etiqueta\s+(\d+)×(\d+)&nbsp;mm/g)].map((m) => [Number(m[1]), Number(m[2])]);
    expect(rotulos.length).toBeGreaterThan(0);
    for (const [w, h] of rotulos) expect([w, h]).toEqual([W, H]);
  });

  it('el rótulo dice cuántas caben, y coincide con PER_SHEET', () => {
    const n = Number(/(\d+) por hoja/.exec(PAGE)![1]);
    expect(n).toBe(PER_SHEET);
  });

  it('el código de barras conserva su mínimo físico', () => {
    // Un EAN-13 necesita ~29.83 mm de ancho al 80% de magnificación, y altura para engancharlo.
    const anchoCol = Number(/\.etq-right\{\s*width:([\d.]+)mm/.exec(LABEL)![1]);
    const pctBarcode = Number(/\.etq-barcode svg\{[^}]*width:([\d.]+)%/.exec(LABEL)![1]);
    const altoBarcode = Number(/\.etq-barcode svg\{[^}]*height:([\d.]+)mm/.exec(LABEL)![1]);
    expect(anchoCol * pctBarcode / 100).toBeGreaterThanOrEqual(29.83);
    expect(altoBarcode).toBeGreaterThanOrEqual(5);
  });

  it('las dos columnas más el padding suman el ancho de la etiqueta', () => {
    // Si no cuadran, o sobra papel a la derecha o la columna derecha se sale (invisible en
    // pantalla por el overflow:hidden, visible en el rollo impreso).
    const izq = Number(/\.etq-left\{\s*width:([\d.]+)mm/.exec(LABEL)![1]);
    const der = Number(/\.etq-right\{\s*width:([\d.]+)mm/.exec(LABEL)![1]);
    const body = /\.etq-body\{[^}]*padding:([\d.]+)mm ([\d.]+)mm ([\d.]+)mm ([\d.]+)mm[^}]*gap:([\d.]+)mm/.exec(LABEL)!;
    const padX = Number(body[2]) + Number(body[4]);
    const gap = Number(body[5]);
    expect(izq + gap + der + padX).toBeCloseTo(W, 5);
  });

  it('el alto de la banda del nombre más el cuerpo no exceden el alto de la etiqueta', () => {
    const head = Number(/\.etq-head\{[^}]*height:([\d.]+)mm/.exec(LABEL)![1]);
    expect(head).toBeLessThan(H * 0.25); // la banda no puede comerse un cuarto de la etiqueta
  });
});

/**
 * El número que "a veces se ve más chico" y el mayoreo ilegible. Dos defectos distintos con
 * la misma raíz: el tamaño de un número lo decide una MEDICIÓN, y una medición puede hacerse
 * en el momento equivocado (fuente no cargada, caja sin ancho) o contra una caja demasiado
 * chica. Ninguno de los dos rompía nada visible en código.
 */
describe('etiquetera · el tamaño de los números no se decide por accidente', () => {
  it('el arranque del CSS y el del TS son el MISMO número', () => {
    // Si divergen, el número arranca de un tamaño y se mide contra otro. Están duplicados
    // porque el CSS lo necesita antes de que corra el TS (primer render y clon de impresión).
    const precioCss = Number(/\.etq-price\{[^}]*font-size:([\d.]+)mm/.exec(LABEL)![1]);
    const montoCss = Number(/\.etq-tier \.amt\{[^}]*font-size:([\d.]+)mm/.exec(LABEL)![1]);
    expect(precioCss).toBe(Number(/const PRECIO_MM = ([\d.]+)/.exec(LABEL)![1]));
    expect(montoCss).toBe(Number(/const MONTO_MM = ([\d.]+)/.exec(LABEL)![1]));
  });

  it('no se mide antes de que la tipografía esté usable', () => {
    // NEGATIVA del bug: `document.fonts.ready` resuelve ANTES de que exista el @font-face
    // (las familias llegan por un @import), así que medir ahí da la fallback — hasta 21% más
    // ancha → el precio quedaba 17% más chico. Tiene que esperar `check`, no `ready`.
    expect(LABEL).toContain('FUENTES_USABLES');
    // Nadie vuelve a colgar el re-layout de `fonts.ready` a secas.
    expect(/ngAfterViewInit\(\)[^\n]*fonts\??\.ready/.test(LABEL)).toBe(false);
    expect(LABEL).toContain('f.check(s)');
    // …y el re-ajuste tiene que colgar de los DOS hooks: las etiquetas de la cola nacen de un
    // cambio de input, no de un primer render.
    expect(/ngAfterViewInit\(\): void \{[^\n]*FUENTES_USABLES/.test(LABEL)).toBe(true);
    expect(/ngOnChanges\(\): void \{[^\n]*FUENTES_USABLES/.test(LABEL)).toBe(true);
  });

  it('una caja sin ancho NO encoge el número hasta el piso', () => {
    // La otra mitad del bug: clientWidth 0 → avail negativo → el bucle llegaba al mínimo.
    expect(LABEL).toContain('if (!(avail > 0)) return;');
    expect(LABEL).toContain('if (!(box.clientHeight > 0)) return;');
  });

  it('el bloque de tiers se ajusta a lo ALTO antes de encoger cada monto', () => {
    // Sin esto el 4º renglón se recortaba en silencio (lo tapa el overflow:hidden) — ya pasaba
    // en la etiqueta de 115×40: 100 px de contenido contra 92 de caja.
    expect(LABEL).toContain('private fitTiers()');
    const orden = /private layout\(\): void \{([^}]*)\}/.exec(LABEL)![1];
    expect(orden.indexOf('fitTiers')).toBeLessThan(orden.indexOf('fitAmts'));
    expect(orden.indexOf('fitTiers')).toBeGreaterThan(-1);
  });

  it('el monto de mayoreo es el más visible del renglonaje', () => {
    const trazoNormal = Number(/\.etq-tier \.amt\{[^}]*-webkit-text-stroke:([\d.]+)mm/.exec(LABEL)![1]);
    const trazoMayoreo = Number(/\.etq-tier\.is-mayoreo \.amt\{[^}]*-webkit-text-stroke:([\d.]+)mm/.exec(LABEL)![1]);
    // El peso va por TRAZO porque Bebas Neue no tiene bold real: medido, `font-weight:700`
    // daba el mismo ancho al píxel, o sea ningún cambio visible.
    expect(trazoMayoreo).toBeGreaterThan(trazoNormal);
    expect(LABEL).toMatch(/\.etq-tier\.is-mayoreo\{[^}]*background:/);
    // y los dos renglones de mayoreo del template tienen que llevar la clase
    expect((LABEL.match(/class="etq-tier is-mayoreo"/g) || []).length).toBe(2);
  });

  it('el bloque de estilos no tiene acentos graves (parten el template literal)', () => {
    // Pasó otra vez al documentar el CSS: un acento grave dentro de un comentario CSS cierra
    // el template literal y el compilador de Angular tira "Failed to resolve styles at
    // position 1 to a string". ⚠️ ts-jest NO lo detecta (no hace el análisis estático de
    // Angular), así que los tests salían verdes con el build roto.
    const bloque = /styles:\s*\[`([\s\S]*?)`\],/.exec(LABEL)![1];
    expect(bloque).not.toContain('`');
  });

  it('la celda del monto es más ancha que la mitad del precio unitario', () => {
    // El reparto se movió a propósito: el mayoreo es donde el cliente compara.
    const izq = Number(/\.etq-left\{\s*width:([\d.]+)mm/.exec(LABEL)![1]);
    const cell = Number(/\.etq-tier \.pricecell\{\s*width:([\d.]+)mm/.exec(LABEL)![1]);
    expect(cell).toBeGreaterThan(izq / 2);
  });
});
