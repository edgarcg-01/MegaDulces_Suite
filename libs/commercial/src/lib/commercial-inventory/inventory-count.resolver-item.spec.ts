import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * `[IC.F3]` — **Una cantidad final no se fija a mano antes de que alguien cuente.**
 *
 * ## Qué protege
 *
 * `resolveItem()` escribe `final_qty` y marca el artículo `resolved`. Hasta el 2026-11-26 no tenía
 * **ninguna** condición: aceptaba cualquier artículo, en cualquier estado, en cualquier momento —
 * incluso en un folio ya reconciliado, después de haber movido la existencia. En un folio de doble
 * conteo **CIEGO** eso es una puerta que anula el control que define al módulo, y el diálogo que la
 * abre imprime el teórico justo encima del campo.
 *
 * Medido en prod el 2026-11-25: la pueden abrir **21** personas (`SUPERVISAR`) y sólo **17** pueden
 * reconciliar. *Había más gente capaz de anular el control que de cerrar el inventario.*
 *
 * Las cuatro condiciones las decidió Edgar el 2026-11-26 sobre la auditoría §9d (F3/F4).
 *
 * ## Por qué hace falta el candado si la pantalla ya no muestra el botón
 *
 * Porque esconder el botón **no es un control**: es exactamente el defecto **F11** de esta misma
 * auditoría —la pantalla decidiendo lo que le toca al servidor— y ahí quedó demostrado que una
 * cuenta sin permiso igual mandaba el `POST`. El freno vive en el servicio, que es el único camino
 * por el que pasan todos los clientes.
 *
 * ## Alcance de lo que afirma
 *
 * ⛔ Lee el fuente: no ejerce el endpoint. Afirma que **los cuatro frenos están y que van ANTES de
 * la escritura**. No afirma «resolver funciona».
 *
 * ⚠️ Sin `import` de `vitest`: el runner del monorepo inyecta los globales.
 */

const FUENTE = readFileSync(join(__dirname, 'inventory-count.service.ts'), 'utf8')
  .split(String.fromCharCode(13))
  .join('');

/** El cuerpo de `resolveItem()`, hasta donde empieza a escribir. */
function cuerpoDeResolver(src: string): string {
  const desde = src.indexOf('async resolveItem(');
  if (desde < 0) return '';
  const hasta = src.indexOf('const variance = +(dto.final_qty', desde);
  if (hasta <= desde) return '';
  return src.slice(desde, hasta);
}

describe('[IC.F3] resolveItem no acepta cualquier artículo en cualquier momento', () => {
  const cuerpo = cuerpoDeResolver(FUENTE);

  it('CONTROL — el método existe, no viene vacío y es UN método, no medio archivo', () => {
    expect(cuerpo, 'no se encontró resolveItem()').not.toBe('');
    expect(cuerpo).toContain("throw new NotFoundException('Item no encontrado')");
    expect(cuerpo.length, 'el bloque es sospechosamente grande: el ancla falló').toBeLessThan(4000);
  });

  it('⛔ un artículo que NADIE contó no se puede resolver', () => {
    expect(cuerpo).toMatch(/if\s*\(\s*item\.count_1\s*==\s*null\s*\)/);
    // `==` y no `===`: un `undefined` también es un no-contado.
    expect(cuerpo).not.toMatch(/item\.count_1\s*===\s*null/);
  });

  it('⛔ en conteo ciego, tampoco antes del segundo conteo', () => {
    expect(cuerpo).toMatch(/count\.blind_double_count\s*&&\s*item\.count_2\s*==\s*null/);
  });

  it('⛔ sólo discrepancias (y lo ya resuelto, para poder corregirlo)', () => {
    expect(cuerpo).toContain("item.status !== 'discrepancy' && item.status !== 'resolved'");
  });

  it('⛔ y nunca sobre un folio ya reconciliado o cancelado', () => {
    expect(cuerpo).toContain("['reconciled', 'cancelled'].includes(count.status)");
  });

  it('los cuatro frenos van ANTES de escribir el valor final', () => {
    const posEscritura = FUENTE.indexOf('const variance = +(dto.final_qty');
    for (const freno of [
      'item.count_1 == null',
      'count.blind_double_count && item.count_2 == null',
      "item.status !== 'discrepancy'",
      "['reconciled', 'cancelled'].includes(count.status)",
    ]) {
      const pos = FUENTE.indexOf(freno);
      expect(pos, `falta el freno: ${freno}`).toBeGreaterThan(-1);
      expect(pos, `el freno va después de escribir: ${freno}`).toBeLessThan(posEscritura);
    }
  });

  it('PRUEBA NEGATIVA — sin el freno del no-contado, el candado se pone ROJO', () => {
    const mutante = cuerpo.split('if (item.count_1 == null)').join('if (false)');
    expect(mutante, 'la mutación no aplicó: el candado no probaría nada').not.toBe(cuerpo);
    expect(mutante).not.toMatch(/if\s*\(\s*item\.count_1\s*==\s*null\s*\)/);
  });
});
