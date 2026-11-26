import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * `[IC.F20]` — **Un no-contado NUNCA se trata como cero, tampoco donde se escribe.**
 *
 * ## Qué protege
 *
 * El bucle de `reconcile()` que aplica los ajustes hace `Number(it.final_qty)`, y **`Number(null)`
 * es `0`**. Sin un freno explícito, un artículo **sin valor final** entra como cero, produce
 * `delta = −expected`, **no** cae en el `if (delta === 0) continue` y **se aplica**: deja la
 * existencia de ese SKU en cero. En un conteo total, eso es **el almacén entero a cero**.
 *
 * ## Por qué hace falta si ya hay un guard
 *
 * `bloqueosParaReconciliar` frena antes por `count_1 == null` y por `final_qty == null`, y está
 * bien hecho: es lo que cumple la promesa que la pantalla le hace al usuario —*«un no-contado NO
 * se trata como cero»*—. ⚠️ Pero era **una sola capa**. Un camino nuevo, un «reconciliar parcial»
 * o un filtro distinto entre el guard y el bucle reintroducen el desastre **sin que nada avise**,
 * y el daño no es recuperable desde la pantalla. Este candado exige que la promesa también se
 * cumpla **donde se escribe**.
 *
 * Nace de la auditoría del 2026-11-26 (`docs/MODULOS/inventario-fisico.md` §9d, hallazgo **F20**).
 *
 * ## Alcance de lo que afirma
 *
 * ⛔ Lee el fuente: **no** ejerce `reconcile()`, que pide Postgres con el esquema `commercial` y el
 * tenant sembrado (eso vive en `database/run-all-tests.js`). Afirma lo que una prueba de unidad sí
 * puede afirmar sin base: **que el freno está, y que está ANTES de la aritmética**. No afirma «la
 * reconciliación es correcta».
 *
 * ⚠️ Sin `import` de `vitest`: el runner del monorepo inyecta los globales, y el import explícito
 * deja el archivo sin cargar — pasó con `inventory-count.resolver-folio.spec.ts`, y un candado que
 * no corre en el CI es peor que ninguno.
 */

const FUENTE = readFileSync(
  join(__dirname, 'inventory-count.service.ts'),
  'utf8',
);

/**
 * El cuerpo del bucle que aplica los ajustes dentro de `reconcile()`.
 *
 * ⚠️ **Se ancla en `async reconcile(` primero.** El archivo tiene VARIOS
 * `for (const it of items) {` —el de «calcular discrepancias» aparece antes—, y buscar el
 * primero devolvía **48,285 caracteres**: medio servicio. El candado entonces no medía el bucle
 * que dice medir. Lo atrapó la prueba de orden, no el control; por eso el control de abajo ahora
 * también acota el TAMAÑO.
 *
 * ⚠️ Sin `expect()` acá: esto corre en el cuerpo del `describe`, fuera de todo test, donde
 * `expect` no tiene contexto. Devuelve `''` y el CONTROL lo declara en rojo dentro de un test.
 */
function bucleDeAjustes(src: string): string {
  const reconcile = src.indexOf('async reconcile(');
  if (reconcile < 0) return '';
  const desde = src.indexOf('for (const it of items) {', reconcile);
  if (desde < 0) return '';
  const hasta = src.indexOf('const expected = Number(it.expected_qty);', desde);
  if (hasta <= desde) return '';
  return src.slice(desde, hasta);
}

describe('[IC.F20] el no-contado no llega a la aritmética de reconcile', () => {
  const bucle = bucleDeAjustes(FUENTE);

  it('CONTROL — el bucle existe, no viene vacío y es UN bucle, no medio archivo', () => {
    // Sin esto, los demás medirían un string vacío y saldrían verdes por nada.
    expect(bucle, 'no se encontró el bucle de ajustes de reconcile()').not.toBe('');
    expect(bucle).toContain('Number(it.final_qty)');
    // ⭐ La primera versión del candado agarraba el `for` de «calcular discrepancias» y se
    // llevaba 48,285 caracteres. Un bloque enorme significa que el ancla falló y que lo que
    // se mide no es lo que se dice medir.
    expect(bucle.length, 'el bloque es sospechosamente grande: el ancla falló').toBeLessThan(2000);
  });

  it('el freno por final_qty nulo está presente', () => {
    expect(bucle).toMatch(/if\s*\(\s*it\.final_qty\s*==\s*null\s*\)\s*continue\s*;/);
  });

  it('⛔ el freno va ANTES de convertir a número', () => {
    const posFreno = bucle.search(/if\s*\(\s*it\.final_qty\s*==\s*null\s*\)\s*continue/);
    const posNumber = bucle.indexOf('Number(it.final_qty)');
    expect(posFreno, 'falta el freno').toBeGreaterThan(-1);
    expect(posNumber, 'falta la conversión').toBeGreaterThan(-1);
    // ⭐ El corazón: después de `Number(null) === 0` ya es tarde.
    expect(posFreno).toBeLessThan(posNumber);
  });

  it('usa == y no ===, para atrapar null Y undefined', () => {
    // `it.final_qty === null` dejaría pasar un `undefined`, que `Number()` vuelve NaN y
    // contamina la aritmética de otra forma.
    expect(bucle).not.toMatch(/it\.final_qty\s*===\s*null/);
  });

  it('PRUEBA NEGATIVA — sin el freno, el candado se pone ROJO', () => {
    const mutante = bucle.replace(/if\s*\(\s*it\.final_qty\s*==\s*null\s*\)\s*continue\s*;/, '');
    expect(mutante, 'la mutación no aplicó: el candado no probaría nada').not.toBe(bucle);
    expect(mutante).not.toMatch(/if\s*\(\s*it\.final_qty\s*==\s*null\s*\)\s*continue/);
  });
});
