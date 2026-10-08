import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * `[IC.25]` — **Una lectura caída no puede publicarse como un cero medido.**
 *
 * Nace de una captura del 2026-10-08: la pantalla de conteo cíclico mostraba
 * *«Valor clasificado $0 · 0 SKUs»* y *«A 0 · B 0 · C 0»* mientras
 * `commercial.abc_classification` tenía **30,222 filas clasificadas** en prod. La causa era un
 * `?? 0` sobre un `summary` que había quedado en `null` porque la llamada falló.
 *
 * ⛔ **El toast de error no alcanza y por eso no se vigila acá.** Dura unos segundos; la cifra
 * se queda en pantalla indefinidamente. Quien llegue un minuto tarde lee que el inventario
 * clasificado vale cero, y no tiene forma de saber que está mirando un error de red.
 *
 * ⭐ El invariante: **las dos ausencias no son la misma** (ADR-056). «Todavía no llegó» y «falló»
 * se veían idénticas porque las dos dejan `summary` en `null`; `fallo` las separa.
 *
 * ⚠️ **Qué NO afirma este archivo.** Lee el FUENTE del componente: comprueba que el formato
 * condicional esté escrito, no que Angular lo renderice. Mismo alcance —y misma limitación— que
 * `almacen-rutas-contar.freno.spec.ts`.
 */

const RUTA = join(__dirname, 'comercial-inventory-abc.component.ts');
const SRC = readFileSync(RUTA, 'utf8');

/**
 * ¿La tarjeta `label` cambia a texto cuando la lectura falló, en vez de formatear un número?
 *
 * Se busca el patrón completo —`[format]` atado a `fallo()` y un `valueText`— y no sólo la
 * palabra `fallo`: una mención en un comentario pondría el candado en verde sin que exista el
 * arreglo.
 */
function declaraSinMedir(fuente: string, label: string): boolean {
  const i = fuente.indexOf(`label="${label}"`);
  if (i < 0) throw new Error(`No existe la tarjeta "${label}"`);
  // El bloque de ESA tarjeta: hasta el cierre de su elemento.
  const fin = fuente.indexOf('</app-metric-card>', i);
  const bloque = fuente.slice(i, fin < 0 ? i + 700 : fin);
  return /\[format\]="fallo\(\)\s*\?\s*'text'/.test(bloque) && /valueText="sin medir"/.test(bloque);
}

describe('[IC.25] conteo cíclico · el arnés del candado', () => {
  /**
   * Sin esto, un extractor que devolviera cadena vacía pondría en verde TODAS las aserciones de
   * abajo — que son justamente las que impiden publicar un cero inventado.
   */
  it('el extractor encuentra las dos tarjetas que vigila', () => {
    expect(() => declaraSinMedir(SRC, 'Valor clasificado (costo/año)')).not.toThrow();
    expect(() => declaraSinMedir(SRC, 'Por contar ahora')).not.toThrow();
  });
});

describe('[IC.25] con la lectura caída, la pantalla DECLARA en vez de dibujar cero', () => {
  it('«Valor clasificado» dice «sin medir», no $0', () => {
    expect(declaraSinMedir(SRC, 'Valor clasificado (costo/año)')).toBe(true);
  });

  it('«Por contar ahora» dice «sin medir», no 0', () => {
    expect(declaraSinMedir(SRC, 'Por contar ahora')).toBe(true);
  });

  it('la distribución ABC no pinta «A 0 · B 0 · C 0» cuando falló', () => {
    expect(SRC).toMatch(/@if \(fallo\(\)\)[\s\S]{0,260}abc-sinmedir/);
  });

  /**
   * ⭐ PRUEBA NEGATIVA. Un gate sin ella es una intención: si el detector diera `true` con el
   * arreglo quitado, estaría midiendo cualquier otra cosa del archivo.
   */
  it('NEGATIVA: volver al `?? 0` de siempre pone el candado en rojo', () => {
    const saboteado = SRC.replace(/\[format\]="fallo\(\) \? 'text' : 'currency'" valueText="sin medir"/, 'format="currency"');
    expect(saboteado).not.toBe(SRC); // el sabotaje se aplicó de verdad
    expect(declaraSinMedir(saboteado, 'Valor clasificado (costo/año)')).toBe(false);
  });
});

describe('[IC.25] el estado vacío no manda a tocar lo que no arregla nada', () => {
  /**
   * El vacío decía SIEMPRE «Elegí un almacén», aun con el selector en «Todos los almacenes» y
   * aun cuando lo que había fallado era la lectura. Ahora distingue los tres casos.
   */
  it('separa «falló» de «no hay filas»', () => {
    expect(SRC).toMatch(/@if \(fallo\(\)\)[\s\S]{0,200}No se pudo leer/);
  });

  /**
   * ⚠️ La aserción mira el MARKUP, no el archivo entero. La primera versión buscaba la frase
   * suelta y se ponía roja por el comentario que explica el arreglo — el mismo descuido de
   * buscar un nombre en vez de buscar dónde se usa. Lo que no puede volver es el texto en
   * pantalla, no la palabra en el código.
   */
  it('ya no afirma que haya que elegir un almacén cuando están todos', () => {
    const enMarkup = (frase: string) =>
      new RegExp(`<(p|h3)>[^<]*${frase}`, 'i').test(SRC);
    expect(enMarkup('Elegi un almacen')).toBe(false);
    expect(enMarkup('Elegí un almacén')).toBe(false);
  });

  it('dice que el vacío NO prueba que no haya clasificados', () => {
    expect(SRC).toMatch(/no<\/strong> quiere decir que no haya productos clasificados/);
  });
});

describe('[IC.25] español de México', () => {
  // Iban seis sin tilde, justo después del barrido de `[PU.VA]` en 18 archivos.
  it('no quedan textos visibles sin tilde', () => {
    for (const malo of ['>Dias cob.<', '>Ultimo conteo<', 'Elegi un producto', 'Sin seleccion']) {
      expect(SRC).not.toContain(malo);
    }
  });
});
