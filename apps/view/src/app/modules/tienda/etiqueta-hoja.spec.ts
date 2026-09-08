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
    // Un EAN-13 necesita ~29.83 mm de ancho al 80% de magnificación. El ANCHO es el mínimo
    // duro; el ALTO pasó a ser dinámico (`fitBarcode` le pasa el aire que sobra), así que acá
    // se verifica su piso y que el techo sea mayor.
    const anchoCol = Number(/\.etq-right\{\s*width:([\d.]+)mm/.exec(LABEL)![1]);
    const pctBarcode = Number(/\.etq-barcode svg\{[^}]*width:([\d.]+)%/.exec(LABEL)![1]);
    const arranque = Number(/\.etq-barcode svg\{[^}]*height:([\d.]+)mm/.exec(LABEL)![1]);
    const min = Number(/const BARCODE_MIN_MM = ([\d.]+)/.exec(LABEL)![1]);
    const max = Number(/const BARCODE_MAX_MM = ([\d.]+)/.exec(LABEL)![1]);
    expect(anchoCol * pctBarcode / 100).toBeGreaterThanOrEqual(29.83);
    expect(arranque).toBe(min);
    expect(min).toBeGreaterThanOrEqual(5);
    expect(max).toBeGreaterThan(min);
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
    // El realce es CONDICIONAL: dos bindings, y ninguna clase estática que se lo salte.
    expect((LABEL.match(/\[class\.is-mayoreo\]/g) || []).length).toBe(2);
    expect((LABEL.match(/class="etq-tier is-mayoreo"/g) || []).length).toBe(0);
  });

  it('los ajustes son BIDIRECCIONALES y con techo acotado', () => {
    const P = Number(/const PRECIO_MM = ([\d.]+)/.exec(LABEL)![1]);
    const PMAX = Number(/const PRECIO_MAX_MM = ([\d.]+)/.exec(LABEL)![1]);
    const M = Number(/const MONTO_MM = ([\d.]+)/.exec(LABEL)![1]);
    const MMAX = Number(/const MONTO_MAX_MM = ([\d.]+)/.exec(LABEL)![1]);
    expect(PMAX).toBeGreaterThan(P);
    expect(MMAX).toBeGreaterThan(M);
    // ⭐ JERARQUÍA: el monto de un renglón no puede acercarse al precio grande. 7.5 mm sería el
    // llenado perfecto de 2 renglones, pero contra un hero de 10.25 da 1.37:1 y no lee como dos
    // niveles distintos.
    expect(MMAX).toBeLessThanOrEqual(P * 0.7);
  });

  it('el techo del monto se clampea contra el precio MEDIDO, no sólo contra la constante', () => {
    // Con un precio de 4 cifras el hero baja de 10 mm y un monto de 7 sería más grande que el
    // precio grande. Sin este clamp, "el precio grande es el número más grande" deja de ser cierto.
    const fit = /private fitTiers\(\): void \{[\s\S]*?\n  \}/.exec(LABEL)![0];
    expect(fit).toContain('Math.min(MONTO_MAX_MM');
    expect(fit).toContain('* 0.7');
  });

  it('ANTI-TRINQUETE: los dos ajustes arrancan de su constante, no del tamaño actual', () => {
    // `layout()` corre 2-4 veces por etiqueta (dos hooks + render + el pase de fuentes). Crecer
    // desde el tamaño ACTUAL subiría en cada pasada. El defecto no existía cuando todo encogía.
    expect(/private fitPrice\(\): void \{[\s\S]*?let size = PRECIO_MM;/.test(LABEL)).toBe(true);
    expect(/private fitTiers\(\): void \{[\s\S]*?let size = MONTO_MM;/.test(LABEL)).toBe(true);
  });

  it('sólo se CRECE con las fuentes usables', () => {
    // Encoger midiendo la fuente equivocada era seguro (quedaba chico pero cabía). Crecer con
    // una fallback más ANGOSTA deja el número más grande de lo que Anton aguanta → se recorta.
    expect(LABEL).toContain('let FUENTES_OK = false;');
    expect(LABEL).toMatch(/FUENTES_USABLES\.then\(\(\) => \{ FUENTES_OK = true; \}\)/);
    for (const m of ['fitPrice', 'fitTiers']) {
      const fn = new RegExp(`private ${m}\\(\\): void \\{[\\s\\S]*?\\n  \\}`).exec(LABEL)![0];
      expect(fn).toContain('FUENTES_OK ?');
    }
  });

  it('la guarda del precio se MIDE, no se escribe', () => {
    // Hoy no hay obstáculo en la caja (el brote se mudó a la banda del nombre) y la guarda sale
    // 0 sola. Si mañana alguien mete una insignia ahí, el número tiene que protegerse solo.
    const fit = /private fitPrice\(\): void \{[\s\S]*?\n  \}/.exec(LABEL)![0];
    expect(fit).toContain("querySelector<HTMLElement>('.etq-sprout')");
    expect(fit).not.toMatch(/const guarda = [\d.]+/);
  });

  it('el aire NO se mide con scrollHeight', () => {
    // Con `justify-content:center`, scrollHeight nunca baja de clientHeight: reporta 0 de aire
    // donde hay 6 mm, y no ve el desborde por arriba. Para encoger era tolerable; para crecer
    // y para repartirle el sobrante al código de barras es un recorte.
    expect(LABEL).toContain('private altoTiers(');
    for (const m of ['fitTiers', 'fitBarcode']) {
      const fn = new RegExp(`private ${m}\\(\\): void \\{[\\s\\S]*?\\n  \\}`).exec(LABEL)![0];
      expect(fn).not.toContain('scrollHeight');
      expect(fn).toContain('this.altoTiers(');
    }
  });

  it('el orden de los ajustes es el que las dependencias exigen', () => {
    const orden = /private layout\(\): void \{([^}]*)\}/.exec(LABEL)![1];
    const i = (m: string) => orden.indexOf(m);
    expect(i('fitUnit')).toBeGreaterThan(-1);
    expect(i('fitUnit')).toBeLessThan(i('fitPrice'));   // la franja define el alto disponible
    expect(i('fitPrice')).toBeLessThan(i('fitTiers'));  // el techo del monto lee el hero
    expect(i('fitTiers')).toBeLessThan(i('fitAmts'));   // uniforme antes que individual
    expect(i('fitAmts')).toBeLessThan(i('fitBarcode')); // el aire se mide al final
  });

  it('la reserva de la franja está en lockstep con el punteado interior', () => {
    // Son dos declaraciones del MISMO número; si se mueve una sola, el borde punteado se mete
    // debajo de la franja verde y nadie lo nota hasta imprimir.
    const pad = Number(/\.etq-pricebox\{[^}]*padding:[\d.]+mm [\d.]+mm ([\d.]+)mm/.exec(LABEL)![1]);
    const inset = Number(/\.etq-pricebox::before\{[^}]*inset:[\d.]+mm [\d.]+mm ([\d.]+)mm/.exec(LABEL)![1]);
    const franja = Number(/\.etq-pieza\{[^}]*height:([\d.]+)mm/.exec(LABEL)![1]);
    expect(pad).toBe(inset);
    expect(pad).toBeGreaterThanOrEqual(franja);
  });

  it('⭐ la UNIDAD del precio tiene jerarquía propia', () => {
    // 73.5% de las etiquetas muestran un precio de PAQUETE y el cliente compra esa unidad en el
    // 92.8% de los renglones: leer el número sin su unidad es el error más caro del proyecto.
    const unidad = Number(/const UNIDAD_MM = ([\d.]+)/.exec(LABEL)![1]);
    const rotulo = Number(/\.etq-tier \.txt\{[^}]*font-size:([\d.]+)mm/.exec(LABEL)![1]);
    expect(unidad).toBeGreaterThan(2.7);              // era 2.7 mm, lo más chico del bloque
    expect(unidad).toBeGreaterThanOrEqual(rotulo * 1.5);
    // Y sin mayúsculas forzadas: `bigUnit.word` puede ser "500 g" y saldría "500 G".
    expect(/\.etq-pieza\{[^}]*text-transform/.test(LABEL)).toBe(false);
  });

  it('⭐ ningún umbral de mayoreo se inventa', () => {
    // Era `wholesale_piece_min_qty || 3`: la etiqueta AFIRMABA "Mayoreo 3+" sin dato. Es el
    // linaje directo de ADR-055 — no imprimir como hecho lo que es un hueco.
    // Se mira el CUERPO del getter, no el archivo: el docstring cita el código viejo a
    // propósito, para que quien lea entienda qué se corrigió.
    const min = /get mayoreoMin\(\)[^\n]*\n?[^\n]*/.exec(LABEL)![0];
    expect(min).not.toContain('|| 3');
    expect(min).toContain('m > 1 ? m : null');
    expect(LABEL).toMatch(/get mayoreoMin\(\): number \| null/);
    // y sin umbral el renglón no se imprime, en las DOS variantes
    const pza = /get hasMayoreoPza\(\): boolean \{[\s\S]*?\n  \}/.exec(LABEL)![0];
    const paq = /get hasMayoreoPaq\(\): boolean \{[\s\S]*?\n  \}/.exec(LABEL)![0];
    expect(pza).toContain('this.mayoreoMin === null');
    expect(paq).toContain('this.mayoreoPaqMin === null');
  });

  it('⭐ el realce de oferta exige que haya descuento', () => {
    // 265 productos imprimían chip amarillo + trazo grueso sobre un precio materialmente igual.
    const min = Number(/const MAYOREO_MIN_DESC = ([\d.]+)/.exec(LABEL)![1]);
    expect(min).toBeGreaterThan(0);
    expect(min).toBeLessThanOrEqual(0.05);
    expect(LABEL).toMatch(/get realceMayoreoPza\(\): boolean/);
    expect(LABEL).toMatch(/get realceMayoreoPaq\(\): boolean/);
    for (const g of ['realceMayoreoPza', 'realceMayoreoPaq']) {
      const fn = new RegExp(`get ${g}\\(\\): boolean \\{[\\s\\S]*?\\n  \\}`).exec(LABEL)![0];
      expect(fn).toContain('MAYOREO_MIN_DESC');
    }
  });

  it('el brote salió de la caja del precio', () => {
    // Era el techo del crecimiento: medido, con la franja de unidad más alta, dejarlo adentro
    // anulaba el trabajo (−0.1% contra +17.4%).
    expect(LABEL).toMatch(/\.etq-head \.etq-sprout\{/);
    expect(/\.etq-sprout\{\s*position:absolute/.test(LABEL)).toBe(false);
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

/**
 * Revisión del 2026-09-08 — ocho hallazgos leídos en el código, ninguno cubierto por los
 * candados de arriba. Cada uno se escribió ANTES del fix y se vio en rojo una vez: un gate sin
 * prueba negativa es una intención (ADR-056). Lo que se RENDERIZA se prueba aparte, en
 * `components/label.component.spec.ts` y `pages/tienda-etiquetas.component.spec.ts`.
 */
describe('etiquetera · lo que la revisión del 2026-09-08 encontró', () => {
  /** Cuerpo de un método de la página: desde su FIRMA (para no chocar con el template) hasta el cierre con sangría de clase. */
  const metodo = (src: string, firma: string): string => {
    const ini = src.indexOf(firma);
    expect(ini).toBeGreaterThan(-1);
    return src.slice(ini, src.indexOf('\n  }', ini));
  };
  /** Luminancia relativa (WCAG) de un #rrggbb. */
  const lum = (hex: string): number => {
    const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
      .map((v) => (v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)));
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  };
  const contraste = (a: string, b: string): number => {
    const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
  };

  it('⭐ el texto CHICO en naranja contrasta al menos 4.5:1 contra la crema', () => {
    // `.etq-red` va en el SKU (3.2 mm) y en las cantidades de los renglones (2.6 mm): el texto
    // más chico de la etiqueta. El brand-700 (#F05A28) daba 3.1:1 sobre la crema — pasa en un
    // titular, no en letra de 3 mm en una impresora gastada. Es papel, así que WCAG no aplica
    // literal, pero es la única vara medible que hay y 4.5 es la del texto pequeño.
    const cream = /--cream:(#[0-9a-fA-F]{6})/.exec(LABEL)![1];
    const red = /--red:(#[0-9a-fA-F]{6})/.exec(LABEL)![1];
    expect(contraste(red, cream)).toBeGreaterThanOrEqual(4.5);
    // …y sigue siendo un tono de la escala de marca, no uno inventado.
    const TOKENS = readFileSync(join(__dirname, '..', '..', '..', '..', '..', '..', 'libs', 'design-tokens', 'tokens.css'), 'utf8');
    expect(TOKENS.toLowerCase()).toContain(red.toLowerCase());
  });

  it('el bloque de renglones encoge también por ANCHO, no sólo por alto', () => {
    // `fitTiers` sólo miraba el alto; el ancho lo revisaba después `fitAmts`, renglón por
    // renglón. Un monto de 4 cifras que ya no cabía en su celda al arranque bajaba SOLO, y un
    // monto más chico que su vecino se lee como error de dato, no como diseño.
    const fit = /private fitTiers\(\): void \{[\s\S]*?\n  \}/.exec(LABEL)![0];
    const anchoOk = fit.indexOf('const anchoOk');
    expect(anchoOk).toBeGreaterThan(-1);
    expect(anchoOk).toBeLessThan(fit.indexOf('if (noCabe()'));
    expect(fit).toMatch(/while \(\(noCabe\(\) \|\| !anchoOk\(\)\)/);
  });

  it('el símbolo lleva su zona muda ADENTRO y conserva la magnificación mínima', () => {
    // Con `margin: 0` la zona muda quedaba a merced del layout: la franja verde de la unidad
    // estaba a 1.6 mm de la primera barra, donde un EAN-13 pide 11 módulos (~5 mm). Ahora la
    // lleva el propio SVG, así que se estira con las barras y nadie la puede pisar.
    expect(LABEL).not.toMatch(/JsBarcode\([^)]*margin: 0/);
    const tabla = /const ZONA_MUDA[^=]*=\s*\{([\s\S]*?)\};/.exec(LABEL)![1];
    const mod = (f: string): [number, number] => {
      const m = new RegExp(`${f}:\\s*\\[(\\d+),\\s*(\\d+)\\]`).exec(tabla)!;
      return [Number(m[1]), Number(m[2])];
    };
    expect(mod('EAN13')).toEqual([11, 7]);
    expect(mod('UPC')).toEqual([9, 9]);
    expect(mod('EAN8')).toEqual([7, 7]);
    expect(mod('CODE128')).toEqual([10, 10]);
    // El ancho de la columna se reparte entre 95 módulos + la zona muda: el módulo resultante
    // no baja del 80% de magnificación (0.264 mm), que es el mínimo que el candado de arriba
    // ya defendía para el símbolo pelado.
    const anchoCol = Number(/\.etq-right\{\s*width:([\d.]+)mm/.exec(LABEL)![1]);
    const [l, r] = mod('EAN13');
    expect(anchoCol / (95 + l + r)).toBeGreaterThanOrEqual(0.264);
  });

  it('el número del EAN se imprime debajo de las barras, legible, y sin duplicar el SKU', () => {
    // `displayValue:false` dejaba el símbolo sin dígitos: si el lector falla, no hay qué
    // teclear. Los dibuja el componente (no JsBarcode: con preserveAspectRatio:none el texto se
    // estiraría con las barras) y sólo para EAN/UPC — el CODE128 de respaldo codifica el SKU,
    // que ya está impreso arriba en "Código:".
    expect(LABEL).toMatch(/get barcodeDigits\(\): string \| null/);
    expect(LABEL).toMatch(/class="etq-bc-digits"/);
    expect(LABEL).toMatch(/displayValue: false/);
    const digitos = Number(/\.etq-bc-digits\{[^}]*font-size:([\d.]+)mm/.exec(LABEL)![1]);
    const masChico = Number(/\.etq-tier \.unit\{[^}]*font-size:([\d.]+)mm/.exec(LABEL)![1]);
    expect(digitos).toBeGreaterThanOrEqual(masChico);
    expect(LABEL).toMatch(/\.etq-bc-digits\{[^}]*tabular-nums/);
  });

  it('la impresión espera a que cada etiqueta se haya AJUSTADO, no 500 ms fijos', () => {
    // `FUENTES_USABLES` tarda hasta 3 s en resolver; el `setTimeout(..., 500)` clonaba al
    // iframe los tamaños medidos con la fallback: el número chico, por la única puerta que los
    // candados de arriba no cerraban.
    expect(PAGE).not.toMatch(/setTimeout\(\(\) => this\.printIsolated\(\), \d+\)/);
    expect(LABEL).toMatch(/^export const FUENTES_USABLES/m);
    expect(PAGE).toContain('await FUENTES_USABLES');
    // La etiqueta MARCA cuándo terminó y la impresión espera esa marca — con tope, y si el tope
    // gana se DECLARA, no se calla.
    expect(LABEL).toContain("'data-etq-settled'");
    expect(PAGE).toContain('[data-etq-settled]');
    expect(PAGE).toMatch(/no terminaron de ajustarse/);
  });

  it('la cola tiene tope, es un número entero de hojas y se muestra antes de chocar con él', () => {
    // `resolve` acepta 1,000 códigos y `printLabels` renderizaba TODAS las etiquetas de golpe en
    // el DOM oculto; `PER_SHEET` sólo acotaba la vista previa. El tope es una decisión de lote
    // de papel (N hojas), no un límite medido de rendimiento — lo que mantiene viva la pantalla
    // es que el render de impresión se hace por hojas, cediendo el hilo entre una y otra.
    const hojas = Number(/readonly MAX_SHEETS = (\d+);/.exec(PAGE)![1]);
    expect(hojas).toBeGreaterThanOrEqual(5);
    expect(PAGE).toContain('readonly MAX_LABELS = this.MAX_SHEETS * this.PER_SHEET;');
    // Se aplica donde entran etiquetas y donde se multiplican…
    expect(metodo(PAGE, 'private pushLabels(')).toContain('MAX_LABELS');
    expect(metodo(PAGE, 'maxCopies(i: number): number')).toContain('MAX_LABELS');
    expect(metodo(PAGE, 'setCopies(i: number, val: number)')).toContain('this.maxCopies(');
    // …el operador lo ve en el contador de la cola…
    const caption = /<div class="etqp-tcap">([\s\S]*?)<\/div>/.exec(PAGE)![1];
    expect(caption).toContain('MAX_LABELS');
    // …y lo que no entró vuelve al textarea, no se pierde.
    expect(metodo(PAGE, 'addBulk(): void')).toContain('leftover');
    // …y la hoja oculta se arma por hojas, cediendo el hilo entre una y otra.
    expect(metodo(PAGE, 'async print(): Promise<void>')).toContain('this.PER_SHEET');
  });

  it('el renglón alterno del granel obedece al multiselect como los otros cuatro', () => {
    const g = /get granelAltTier\(\)[\s\S]*?\n  \}/.exec(LABEL)![0];
    expect(g).toContain('this.show.granel');
    expect(LABEL).toMatch(/granel: boolean;/);
    expect(LABEL).toMatch(/ALL_SECTIONS: LabelSections = \{[^}]*granel: true/);
    expect(PAGE).toMatch(/value: 'granel'/);
  });

  it('la frescura que se pinta es la PEOR de la cola, no la del último escaneo', () => {
    // `freshness.set(r.freshness)` en cada resolve: un lote agregado con rezago seguía en la
    // cola después de que un escaneo fresco apagaba el banner. La edad viaja con cada ítem y el
    // banner muestra la peor; stale > unknown > fresh.
    expect(PAGE).not.toMatch(/this\.freshness\.set\(/);
    expect(PAGE).toMatch(/readonly freshness = computed\(/);
    expect(PAGE).toMatch(/interface QueueItem \{[^}]*freshness: Freshness \| null/);
    expect(PAGE).toMatch(/const RANGO_FRESCURA[^=]*=\s*\{\s*stale: 2,\s*unknown: 1,\s*fresh: 0\s*\}/);
  });

  it('la vista de hoja se puede pasar de página, y la página se clampea si la cola se achica', () => {
    expect(PAGE).toMatch(/sheetPage = signal\(1\)/);
    expect(PAGE).toContain('pi-chevron-left');
    expect(PAGE).toContain('pi-chevron-right');
    expect(PAGE).toMatch(/Math\.min\(this\.sheetPage\(\), this\.totalSheets\(\)\)/);
  });
});
