// [CG.38.1] Sin `import ... from 'vitest'`: la config usa `globals: true`. Importarlo hace que el
// archivo NO CARGUE y entonces reporta **0 tests**, no sus casos fallando.
import { readFileSync } from 'fs';
import { join } from 'path';
import { PROVEEDOR_NO_PEDIBLE_RX, proveedorEsPedible, proveedorPedibleSql } from './proveedor-no-pedible';

/**
 * `[PQ.145]` — **El candado de «no ofrecer un proveedor que Kepler marcó no usar».**
 *
 * Tres cosas distintas se prueban acá, y conviene no confundirlas:
 *
 * 1. **La regla** — qué nombre pasa y cuál no. Con su **control negativo**: el MISMO proveedor sin
 *    la marca tiene que pasar. Sin ese control, los casos de arriba probarían que «nada pasa», que
 *    es justo lo que no queremos.
 * 2. **El comodín que se queda** — `PRODUCTOS SIN PROVEEDOR ASIGNADO` pasa. Es la pieza que más
 *    fácil se rompe «limpiando» el filtro, y son 127 renglones de compra reales.
 * 3. **El reparto** — que la regla esté aplicada en los TRES lugares donde se ofrece un proveedor.
 *    ⚠️ Un escaneo por regex no prueba que el SQL corra; prueba que nadie la quitó de un sitio.
 *
 * ⛔ Lo que NO afirma: que el producto escondido del menú no haga falta. No lo hace — el SKU 10211
 * se sigue comprando a `CM036`, y por eso el filtro NO toca Existencia Crítica ni el workbook.
 */

describe('[PQ.145] qué proveedor se puede pedir', () => {
  it('las marcas de Kepler NO se pueden pedir', () => {
    expect(proveedorEsPedible('INHABILITADO')).toBe(false);
    expect(proveedorEsPedible('ROMPOPE DON AGUSTIN (NO USAR)')).toBe(false);
    expect(proveedorEsPedible('inhabilitado')).toBe(false);           // Kepler no es consistente con las mayúsculas
    expect(proveedorEsPedible('PROVEEDOR X NO UTILIZAR')).toBe(false);
  });

  // ❌ Control negativo: si esto diera `false`, la prueba de arriba no mediría la MARCA, mediría
  // que ningún nombre pasa nunca.
  it('el MISMO proveedor sin la marca sí se puede pedir', () => {
    expect(proveedorEsPedible('ROMPOPE DON AGUSTIN')).toBe(true);
    expect(proveedorEsPedible('BIMBO')).toBe(true);
    expect(proveedorEsPedible('MANTEQUERA SAMA')).toBe(true);
  });

  it('⭐ el comodín «sin proveedor asignado» SE QUEDA (606 productos, 127 con política)', () => {
    expect(proveedorEsPedible('PRODUCTOS SIN PROVEEDOR ASIGNADO')).toBe(true);
  });

  it('un nombre ausente o vacío NO es una marca de baja', () => {
    expect(proveedorEsPedible(null)).toBe(true);
    expect(proveedorEsPedible(undefined)).toBe(true);
    expect(proveedorEsPedible('')).toBe(true);
  });

  it('el SQL usa coalesce: sin él, un supplier_id huérfano desaparecería en silencio', () => {
    const sql = proveedorPedibleSql('sup');
    expect(sql).toContain("coalesce(sup.name, '')");
    expect(sql).toContain('!~*');
    expect(sql).toContain(PROVEEDOR_NO_PEDIBLE_RX);
    // El alias viaja: la agenda y el worklist lo nombran distinto si alguien renombra el join.
    expect(proveedorPedibleSql('s2')).toContain('s2.name');
  });
});

describe('[PQ.145] el reparto: los tres lugares que ofrecen un proveedor', () => {
  const fuente = readFileSync(join(__dirname, 'commercial-replenishment.service.ts'), 'utf8');

  it('la regla está aplicada tres veces en el servicio', () => {
    // Se cuentan las LLAMADAS (`proveedorPedibleSql(`), no el identificador: el `import` lo nombra
    // sin paréntesis y no cuenta. Son tres: filters, worklist y worklistProveedores.
    const veces = fuente.split('proveedorPedibleSql(').length - 1;
    expect(veces).toBe(3);
  });

  it('⛔ y NO se coló en Existencia Crítica ni en el workbook', () => {
    // `criticalFilters` y `workbook` anclan en el PRODUCTO: ahí esconder la fila esconde demanda.
    const critical = fuente.slice(fuente.indexOf('private criticalFilters('), fuente.indexOf('async criticalStock('));
    expect(critical).not.toContain('proveedorPedibleSql');
  });
});
