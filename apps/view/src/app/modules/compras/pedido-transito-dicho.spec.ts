// [CG.38.1] Sin `import ... from 'vitest'`: la config usa `globals: true`. Importarlo hace que el
// archivo NO CARGUE y entonces reporta **0 tests**, no sus casos fallando.
import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * `[RA.TR.2]` — **La pantalla de Pedido tiene que decir lo que el motor HACE con el tránsito.**
 *
 * ⛔ El defecto que esto cierra, encontrado auditando el camino del pedido el 2026-10-10: la
 * política vigente es `ignorar` (el sugerido **no** resta las OC abiertas) y la pantalla lo
 * afirmaba al revés en **cinco** lugares, incluida la fórmula del pie y el tooltip de la columna
 * que el comprador edita. La peor era un contraste —*"la requisición pendiente no se descuenta,
 * pero la OC sí"*— donde la segunda mitad llevaba un día siendo falsa.
 *
 * ⭐ Lo que vuelve esto digno de un candado y no de un arreglo: en el MISMO componente, el diálogo
 * de «En camino» ya toma el aviso del servidor justamente para no hard-codear la regla, y su
 * comentario explica por qué — *"si lo escribiera la pantalla, al cambiar la regla el texto
 * quedaría explicando algo que ya no ocurre"*. Alguien vio el riesgo, lo resolvió para el diálogo,
 * y dejó cinco cadenas fijas al lado diciendo lo contrario. El aviso no viaja a los tooltips ni al
 * pie (sólo llega al abrir el diálogo), así que acá no se puede derivar en tiempo de ejecución:
 * se ata en tiempo de PRUEBA.
 *
 * ⚠️ Por eso este archivo lee las DOS fuentes y las obliga a coincidir. Si mañana alguien pone la
 * política en `curva`, este test se pone rojo y hay que volver a escribir los textos — que es
 * exactamente lo que no pasó el 2026-10-09.
 *
 * ## Lo medido en prod (2026-10-10), que es el tamaño del error
 *
 * | | renglones | valor |
 * |---|---:|---:|
 * | tránsito abierto total | 8,504 | **$59,151,098** |
 * | …y además el motor sugiere comprar | **4,496** | **$22,994,527** en camino contra **$8,541,081** sugeridos |
 *
 * O sea: en 4,496 renglones el comprador leía que el sugerido ya había restado lo que viene, y no.
 */

const RAIZ = join(__dirname, '..', '..', '..', '..', '..', '..');
const PANT = readFileSync(join(__dirname, 'pages', 'compras-pedido-real.component.ts'), 'utf8');
const TRANSITO = readFileSync(
  join(RAIZ, 'libs', 'commercial', 'src', 'lib', 'commercial-replenishment', 'transito.ts'), 'utf8');

/** La política vigente, leída del único lugar donde se declara. */
function politicaVigente(): string {
  const m = TRANSITO.match(/export const POLITICA_TRANSITO: PoliticaTransito = '([a-z]+)'/);
  if (!m) throw new Error('No encontré POLITICA_TRANSITO en transito.ts');
  return m[1];
}

/** El texto que ve una persona: sin comentarios de TS ni de HTML. */
function textoVisible(s: string): string {
  return s
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/^[ \t]*\/\/.*$/gm, ' ');
}
const VISIBLE = textoVisible(PANT);

describe('[RA.TR.2] el arnés', () => {
  it('encuentra las dos fuentes', () => {
    expect(PANT.length).toBeGreaterThan(1000);
    expect(() => politicaVigente()).not.toThrow();
  });

  it('y falla fuerte si la política se renombra', () => {
    expect(() => {
      const m = 'const OTRA_COSA = 1'.match(/export const POLITICA_TRANSITO: PoliticaTransito = '([a-z]+)'/);
      if (!m) throw new Error('No encontré POLITICA_TRANSITO en transito.ts');
    }).toThrow(/No encontré/);
  });
});

describe('[RA.TR.2] ⛔ la pantalla no puede afirmar que el sugerido resta el tránsito', () => {
  it('⭐⭐ la política vigente es `ignorar` — si cambia, lo de abajo hay que reescribirlo', () => {
    // Este test NO defiende `ignorar`. Defiende que los textos y la política digan lo mismo.
    // Cambiar la política acá a mano sin tocar la pantalla es el defecto, no el arreglo.
    expect(politicaVigente()).toBe('ignorar');
  });

  it('⛔⛔ NEGATIVA: la fórmula visible NO resta "en camino"', () => {
    // Era: "venta × cobertura − existencia − en camino" en el pie Y en el tooltip de la columna
    // que se edita. Las dos decían la resta que el motor no hace.
    expect(VISIBLE).not.toMatch(/−\s*<strong>en camino<\/strong>/i);
    expect(VISIBLE).not.toMatch(/−\s*en camino\)/i);
  });

  it('⛔ NEGATIVA: no queda ninguna frase que diga que el Pedido lo descuenta', () => {
    // La forma vieja: "El Pedido la descuenta PESADA por la probabilidad de que llegue".
    expect(VISIBLE).not.toMatch(/El Pedido la descuenta/i);
    expect(VISIBLE).not.toMatch(/se descuenta pesado por la probabilidad/i);
    // Y el contraste con una mitad falsa: "Lo que el motor SÍ descuenta son las órdenes de compra".
    expect(VISIBLE).not.toMatch(/motor S[ÍI] descuenta son[\s\S]{0,40}[óo]rdenes de compra/i);
  });

  it('⭐ y lo dice al derecho, donde el comprador mira el número', () => {
    // El tooltip de la columna "En camino" y el pie: los dos tienen que negarlo explícitamente.
    expect(VISIBLE).toMatch(/El Pedido NO la descuenta/);
    expect(VISIBLE).toMatch(/El sugerido NO descuenta lo que viene en camino/);
  });
});

describe('[RA.TR.2] ⭐ el momento de confirmar dice cuánto ya viene', () => {
  it('⭐⭐ el diálogo del plan muestra el tránsito de esos productos', () => {
    // Es el único instante en que alguien decide gastar dinero, y no decía una palabra del tema.
    const i = VISIBLE.indexOf('pr-plan-tran');
    expect(i).toBeGreaterThan(0);
    expect(VISIBLE).toMatch(/ya vienen \{\{ p\.trCajas/);
    expect(VISIBLE).toMatch(/El sugerido no las descuenta/);
  });

  it('⛔ NO bloquea: comprar igual puede ser correcto', () => {
    // Un aviso que apaga el botón se convierte en un trámite que se aprende a saltear. El botón
    // sólo lo apagan los bloqueantes estructurales.
    expect(PANT).toMatch(/\[disabled\]="saving\(\) \|\| planBloqueos\(\)\.length > 0"/);
    const i = PANT.indexOf('private enCaminoDelPlan(');
    expect(i).toBeGreaterThan(0);
    expect(PANT.slice(i, i + 900)).not.toContain('planBloqueos');
  });

  it('⭐ y lo que no se pudo medir se DECLARA, no se dibuja como cero', () => {
    // Un producto del lote que no esté en las filas cargadas no tiene tránsito conocido; contarlo
    // como 0 diría "no viene nada" sobre algo que nadie miró (ADR-056).
    const i = PANT.indexOf('private enCaminoDelPlan(');
    const b = PANT.slice(i, i + 900);
    expect(b).toMatch(/trSinDato\+\+/);
    expect(VISIBLE).toMatch(/su tránsito no se midió/);
  });
});
