import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * `[IC.F13]` — **Lo que viaja como marca tiene que SER la marca.**
 *
 * ## Qué protege
 *
 * `GET /counts/resolve` mandaba `brand_name: inv.categoria`, y la pantalla del contador lo pintaba
 * junto al SKU como un dato del producto: **«00203 · 341»**. No es una marca ni es un nombre: es el
 * CÓDIGO de la categoría.
 *
 * ## La medición que lo cierra (prod, 2026-11-26)
 *
 * De **10,266** productos de `inventory.products`, **9,321** traen categoría y los **9,321 son
 * numéricos** —492 códigos distintos—: *nunca* fue un nombre de marca, en ninguna fila. El **97.1 %**
 * casa con `catalog.categories.code`, y ahí `341` es **«PROMOCIONES»** — que es exactamente lo que
 * era el producto del hallazgo (`$330 NESTLE = GRATIS 1 LONCHERA`).
 *
 * Por eso el arreglo no es borrar el dato: es mandar el **nombre**, en un campo que dice qué trae.
 * Y si el código no casa (2.9 %), no se manda nada — un «341» suelto no le dice nada a quien cuenta.
 *
 * ## Alcance de lo que afirma
 *
 * ⛔ Lee el fuente: no ejerce el endpoint, que pide Postgres con `inventory.products` y
 * `catalog.categories` sembrados. Afirma que **el campo equivocado ya no se llena con la categoría**
 * y que el nombre sale de la tabla de categorías. No afirma «el 97.1 % sigue casando»: eso es un
 * dato de prod y se vuelve a medir, no se congela acá.
 *
 * ⚠️ Sin `import` de `vitest`: el runner del monorepo inyecta los globales y el import explícito
 * deja el archivo sin cargar.
 */

const FUENTE = readFileSync(join(__dirname, 'inventory-count.service.ts'), 'utf8')
  .split(String.fromCharCode(13))
  .join('');

/** La rama de `resolveProduct()` que contesta desde `inventory.products`. */
function ramaInventario(src: string): string {
  const desde = src.indexOf('async resolveProduct(');
  if (desde < 0) return '';
  const hasta = src.indexOf('// 2) Fallback', desde);
  if (hasta <= desde) return '';
  return src.slice(desde, hasta);
}

describe('[IC.F13] la categoría no se manda como marca', () => {
  const rama = ramaInventario(FUENTE);

  it('CONTROL — la rama existe, no viene vacía y es UNA rama, no medio archivo', () => {
    expect(rama, 'no se encontró resolveProduct()').not.toBe('');
    expect(rama).toContain('product_id: null');
    expect(rama.length, 'el bloque es sospechosamente grande: el ancla falló').toBeLessThan(3000);
  });

  it('⛔ en NINGUNA parte del servicio se llena brand_name con la categoría', () => {
    expect(FUENTE).not.toMatch(/brand_name\s*:\s*inv\.categoria/);
    expect(FUENTE).not.toMatch(/brand_name\s*:\s*\w+\.categoria/);
  });

  it('el nombre sale de catalog.categories por su código, y va en su propio campo', () => {
    expect(rama).toContain("trx('catalog.categories')");
    expect(rama).toContain('code: inv.categoria');
    expect(rama).toContain('category_name:');
  });

  it('las dos ramas tienen la misma forma: nadie recibe el campo como undefined', () => {
    const ramas = FUENTE.split('category_name:').length - 1;
    expect(ramas, 'una de las dos ramas de resolveProduct no manda category_name').toBe(2);
  });

  it('PRUEBA NEGATIVA — con la vieja asignación, el candado se pone ROJO', () => {
    const mutante = rama.split('brand_name: null,').join('brand_name: inv.categoria ?? null,');
    expect(mutante, 'la mutación no aplicó: el candado no probaría nada').not.toBe(rama);
    expect(mutante).toMatch(/brand_name\s*:\s*inv\.categoria/);
  });
});
