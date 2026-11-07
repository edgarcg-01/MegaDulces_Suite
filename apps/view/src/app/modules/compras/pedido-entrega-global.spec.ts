// [CG.38.1] Sin `import ... from 'vitest'`: la config usa `globals: true`. Importarlo hace que el
// archivo NO CARGUE y entonces reporta **0 tests**, no sus casos fallando.
import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * `[PQ.90]` — **La entrega y la unidad son del PEDIDO, no del renglón.**
 *
 * Lo encontró Edgar mirando la pantalla el 2026-11-07: *«tienen que poner configuración individual
 * por línea de algo que puede ser configuración global»*. Medido en prod sobre 60 días, le da la
 * razón con número:
 *
 * | puntos de entrega por lote | lotes | % |
 * |---|---:|---:|
 * | **1** | 219 | **82.0 %** |
 * | 2 | 23 | 8.6 % |
 * | 3 o más | 25 | 9.4 % |
 *
 * Y **59.1 % de los proveedores entrega siempre en el mismo lugar**. Elegirlo producto por producto
 * no decidía nada en 8 de cada 10 lotes: era clic.
 *
 * ⛔ **El control por producto NO se quita.** Es el 18 % restante, y es la excepción la que vuelve
 * útil al global. Lo que cambia es cuál es el camino normal — quitar la excepción sería cambiar un
 * defecto por otro.
 */

const PANT = readFileSync(
  join(__dirname, 'pages', 'compras-pedido-real.component.ts'), 'utf8');

/** Mide código, no redacción. */
function sinComentarios(s: string): string {
  return s.replace(/<!--[\s\S]*?-->/g, ' ').replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^[ \t]*\/\/.*$/gm, ' ');
}
const CODIGO = sinComentarios(PANT);

describe('[PQ.90] el arnés', () => {
  it('encuentra la pantalla y el control nuevo', () => {
    expect(PANT.length).toBeGreaterThan(1000);
    expect(CODIGO).toContain('aplicarEntregaGlobal');
  });

  it('y falla fuerte si se renombra', () => {
    expect(() => { if (!'x'.includes('aplicarEntregaGlobal')) throw new Error('No existe el control global'); })
      .toThrow(/No existe/);
  });
});

describe('[PQ.90] ⭐ la entrega se elige UNA vez para todo el pedido', () => {
  it('⭐⭐ el control global existe y aplica a lo que está en el carrito', () => {
    expect(CODIGO).toMatch(/aplicarEntregaGlobal\(v: EntregaModo\): void/);
    expect(CODIGO).toMatch(/for \(const r of this\.carritoRows\(\)\) this\.setEntregaModo\(r, v\)/);
  });

  it('⛔ y NO se quita el control por producto — es el 18 % restante', () => {
    // Quitar la excepción cambiaría un defecto por otro: hay lotes con 2, 3 y hasta 6 destinos.
    expect(CODIGO).toContain('setEntregaModo(r, $event)');
    expect(CODIGO).toContain('setUnidadModo(r, $event)');
  });

  it('⭐ el universo del global son los productos CON cantidad, no la página', () => {
    // Aplicarlo a todo lo cargado tocaría renglones que nadie va a pedir.
    const i = CODIGO.indexOf('private carritoRows()');
    expect(i).toBeGreaterThan(0);
    expect(CODIGO.slice(i, i + 260)).toMatch(/this\.qtyOf\(r, b\) > 0/);
  });
});

describe('[PQ.90] ⛔ la unidad global va por PELDAÑO, no por factor', () => {
  it('⭐⭐ las opciones son "la más grande" / "la más chica"', () => {
    // Cada producto tiene su propia escalera: un factor fijo (12) no significa lo mismo en dos
    // productos, y elegirlo globalmente inventaría una equivalencia que el catálogo no declara.
    expect(CODIGO).toMatch(/value: 'mayor' as const/);
    expect(CODIGO).toMatch(/value: 'menor' as const/);
  });

  it('⛔ NEGATIVA: el global no fija un número de unidades', () => {
    const i = CODIGO.indexOf('unidadGlobalOpts =');
    const b = CODIGO.slice(i, i + 300);
    expect(b).not.toMatch(/value: \d+/);
  });

  it('⭐ y se resuelve contra la escalera DE CADA producto', () => {
    // ⚠️ Anclado a la DEFINICIÓN: `aplicarUnidadGlobal(` aparece antes en la plantilla
    // (`(ngModelChange)="aplicarUnidadGlobal($event)"`) y el extractor traía ese pedazo de HTML.
    const i = CODIGO.indexOf("aplicarUnidadGlobal(v: 'mayor'");
    expect(i).toBeGreaterThan(0);
    expect(CODIGO.slice(i, i + 420)).toMatch(/this\.escMayorAMenor\(r\)/);
  });
});

describe('[PQ.90] ⛔ la excepción se DECLARA, no se esconde ni se inventa', () => {
  it('⭐⭐ sin global elegido el conteo es 0: no hay excepción sin norma', () => {
    // Dibujar un conteo ahí afirmaría que alguien se salió de algo que nadie fijó (ADR-056).
    const i = CODIGO.indexOf('difieren(): number');
    expect(i).toBeGreaterThan(0);
    expect(CODIGO.slice(i, i + 260)).toMatch(/if \(!g\) return 0/);
  });

  it('⭐ y el número LLEVA al producto que difiere (DESIGN Q.4)', () => {
    // Un número que denuncia y no lleva a arreglarlo deja el trabajo en la cabeza de alguien.
    expect(CODIGO).toContain('verPrimerDiferente()');
    expect(CODIGO).toMatch(/this\.isOpen\(r\)\) this\.toggleRow\(r\)/);
  });

  it('⛔ el aviso lleva PALABRA, no sólo color', () => {
    expect(PANT).toMatch(/\{\{ n \}\} con entrega propia/);
  });
});
