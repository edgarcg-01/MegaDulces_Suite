import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * `[IC.F1]` — **Un escaneo resuelve contra el FOLIO, no contra el catálogo global.**
 *
 * ## Qué protege, y por qué existe
 *
 * El catálogo tiene el mismo producto más de una vez. Medido en prod el **2026-11-26** sobre
 * `public.products` (14,986 filas): **1,162 sin SKU**, **887 SKUs repetidos**, **1,017 nombres
 * con más de un `product_id`**.
 *
 * Mientras `registerCount` buscó el código **directo en `public.products`**, se quedaba con la
 * fila duplicada —la que no tiene SKU—, su `product_id` no coincidía con el que el folio sembró,
 * y el `if (!item)` de más abajo **daba de alta un renglón nuevo con `expected_qty: 0`**.
 *
 * El daño medido en `INV-2026-00010` (Padre Hidalgo, 3,363 artículos):
 *
 * | | online (roto) | sin conexión (correcto) |
 * |---|---|---|
 * | SKU resuelto | *(vacío)* | `00182` |
 * | teórico | **0** | **19** |
 * | efecto | **renglón nuevo** | llena el correcto |
 *
 * El artículo original quedaba `pending` para siempre → **el folio no podía cerrarse jamás**, el
 * total crecía con cada escaneo, y lo contado entraba como **sobrante puro**. Es lo que explica
 * los **6 folios cancelados y 0 reconciliados** de toda la historia del módulo.
 *
 * ⭐ El testigo de cuál es la resolución correcta ya existía: el camino **sin conexión** nunca
 * tuvo el defecto, porque resuelve contra la caché de `/counts/:id/catalog`, que son los
 * productos **del folio**. Este candado exige que el servidor haga lo mismo.
 *
 * ## Por qué se lee el fuente y no se ejerce la consulta
 *
 * Ejercer `registerCount` pide Postgres con el esquema `commercial` **y** el tenant sembrado.
 * Eso vive en `database/run-all-tests.js` (job `pruebas-db`, informativo). Acá se protege lo que
 * una prueba de unidad SÍ puede afirmar sin base: **que el orden de resolución no se invierta de
 * nuevo**. ⚠️ Por eso no declara «el conteo liga bien»: declara «la consulta del folio está, y
 * va antes». Lo otro se midió a mano contra prod y está en
 * `docs/MODULOS/inventario-fisico.md` §9d.
 */

const FUENTE = readFileSync(
  join(__dirname, 'inventory-count.service.ts'),
  'utf8',
);

/**
 * El bloque de `registerCount` que resuelve el código cuando no viene `product_id`.
 *
 * ⚠️ **Sin `expect()` acá dentro, a propósito.** Esta función se evalúa en el cuerpo del
 * `describe`, o sea **fuera de todo test**, y ahí `expect` no tiene contexto: bajo el runner del
 * monorepo revienta con `Cannot read properties of undefined (reading 'config')` y el archivo
 * entero queda en rojo sin ejecutar una sola prueba. Devuelve `''` cuando no encuentra el bloque
 * y es el CONTROL el que lo declara en rojo, dentro de un test.
 */
function bloqueDeResolucion(src: string): string {
  const desde = src.indexOf('if (!productId && dto.barcode)');
  if (desde < 0) return '';
  const hasta = src.indexOf('if (!UUID.test(productId!))', desde);
  if (hasta <= desde) return '';
  return src.slice(desde, hasta);
}

describe('[IC.F1] el escaneo resuelve contra los artículos del folio', () => {
  const bloque = bloqueDeResolucion(FUENTE);

  it('CONTROL — el bloque existe y no viene vacío', () => {
    // Si este control falla, los demás no significan nada: estarían midiendo un string vacío.
    expect(bloque, 'no se encontró la rama que resuelve el barcode en registerCount').not.toBe('');
    expect(bloque.length).toBeGreaterThan(200);
    expect(bloque).toContain('dto.barcode');
  });

  it('busca primero en inventory_count_items del folio', () => {
    expect(bloque).toContain('commercial.inventory_count_items');
    expect(bloque).toMatch(/where\(\s*'i\.count_id'\s*,\s*countId\s*\)/);
  });

  it('empareja por barcode O por sku (el duplicado puede tener sólo uno)', () => {
    expect(bloque).toContain("'p.barcode'");
    expect(bloque).toContain("'p.sku'");
    expect(bloque).toContain('orWhere');
  });

  it('⛔ el folio se consulta ANTES que el catálogo global', () => {
    const posFolio = bloque.indexOf('commercial.inventory_count_items');
    const posCatalogo = bloque.indexOf("trx('public.products')");
    expect(posFolio, 'falta la consulta al folio').toBeGreaterThan(-1);
    expect(posCatalogo, 'falta el fallback al catálogo').toBeGreaterThan(-1);
    // ⭐ Éste es el corazón del candado: invertir el orden reintroduce el defecto.
    expect(posFolio).toBeLessThan(posCatalogo);
  });

  it('conserva el fallback: un sobrante legítimo se sigue dando de alta', () => {
    // Quitar el `else` convertiría todo código ausente del folio en un 404, y un producto que
    // de verdad no estaba en el snapshot ES un sobrante válido que el conteo debe registrar.
    expect(bloque).toContain("trx('public.products')");
    expect(bloque).toContain('Sin producto para el código');
  });

  it('PRUEBA NEGATIVA — con el orden invertido, el candado se pone ROJO', () => {
    // Se reconstruye el defecto: el catálogo global primero, el folio después.
    const mutante = bloque
      .replace(/const delFolio = await trx\('commercial\.inventory_count_items as i'\)/,
               "const delFolio = await trx('public.products')");
    expect(mutante, 'la mutación no aplicó: el candado no estaría probando nada').not.toBe(bloque);

    const posFolio = mutante.indexOf('commercial.inventory_count_items');
    const posCatalogo = mutante.indexOf("trx('public.products')");
    // Con la mutación ya no queda consulta al folio → el candado de orden falla, que es lo
    // que tiene que pasar.
    const sigueProtegido = posFolio > -1 && posFolio < posCatalogo;
    expect(sigueProtegido).toBe(false);
  });
});
