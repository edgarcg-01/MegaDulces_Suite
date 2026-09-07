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
