import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * `[IC.F24]` — **Lo que se guarda está en la unidad del teórico, y queda escrito en cuál contó
 * la persona.**
 *
 * ## Qué protege
 *
 * `expected_qty` está en la unidad NATIVA del almacén y la pantalla no la nombraba: el campo decía
 * «Cantidad física», a secas. Contar **cajas** donde el sistema espera **paquetes** equivoca la
 * varianza por el factor del producto, y el cierre escribe el ajuste de inventario con esa
 * diferencia. No es un error de dedo: es el inventario entero mal, en silencio.
 *
 * ## La medición que lo cierra (prod, 2026-11-27, sólo lectura)
 *
 * - `INV-2026-00010`: **2,596 de 3,364** artículos (**77 %**) con factor de caja ≥ 12, y 210 ≥ 100.
 * - La salida es `catalog.product_barcodes`: los **7,109** códigos `is_primary` son **TODOS**
 *   `kepler_base` y **TODOS** con `factor = 1` ⇒ el código que viene con el SKU **nombra la unidad
 *   nativa**. Sus unidades: PAQ 5,656 · PZA 1,294 · KG 128 · CJA 13.
 * - De los **55** productos con dos primarios, **0 difieren en unidad** ⇒ el desempate no es una
 *   moneda al aire.
 * - Cobertura en el folio: **2,849 de 3,364** con primario (85 %) y **556 con más de una unidad**.
 *
 * ⚠️ **Lo que este factor NO es:** el `display_box_factor` del ERP. Se cruzaron y coinciden en
 * **21 de 511** (4.1 %). Por eso la conversión usa SÓLO razones internas de `product_barcodes`.
 *
 * ## Alcance de lo que afirma
 *
 * ⛔ Lee el fuente: no ejerce el endpoint, que pide Postgres con `catalog.product_barcodes`
 * sembrado. Afirma que **ningún slot guarda la cantidad cruda**, que la unidad por defecto sale del
 * código primario y que viaja por la cola offline. NO afirma «el 77 % sigue teniendo factor ≥ 12»:
 * ése es un dato de prod y se vuelve a medir.
 *
 * ⚠️ Sin `import` de `vitest`: el runner del monorepo inyecta los globales.
 */

const DIR = __dirname;
const sinCR = (s: string) => s.split(String.fromCharCode(13)).join('');

const SERVICIO = sinCR(readFileSync(join(DIR, 'inventory-count.service.ts'), 'utf8'));
const COLA = sinCR(
  readFileSync(
    join(DIR, '../../../../../apps/view/src/app/core/services/inventory-offline.service.ts'),
    'utf8',
  ),
);

/** El cuerpo de un método del servicio. */
function metodo(src: string, nombre: string): string {
  const desde = src.indexOf(`async ${nombre}(`);
  if (desde < 0) return '';
  const hasta = src.indexOf('\n  async ', desde + 10);
  return src.slice(desde, hasta > desde ? hasta : undefined);
}

const SUBMIT = metodo(SERVICIO, 'submitCount');

describe('[IC.F24] el conteo se guarda en la unidad del teórico', () => {
  it('CONTROL — el instrumento encuentra submitCount y el resolvedor, y no trae medio archivo', () => {
    expect(SUBMIT, 'no se encontró submitCount()').not.toBe('');
    expect(SUBMIT).toContain('patch.count_1_unit');
    // `[ICR.M3]` El bloque creció al volverse la captura la unidad del conteo (la bitácora, el
    // rack y la recomposición viven acá). El tope sigue siendo un ancla: si duplica esto, el
    // `metodo()` se está trayendo medio archivo y las afirmaciones de abajo valdrían por azar.
    expect(SUBMIT.length, 'el ancla falló: el bloque es sospechosamente grande').toBeLessThan(30000);
    expect(SERVICIO).toContain('async unidadesDeConteo(');
    expect(COLA, 'no se leyó la cola offline').toContain('queueScan');
  });

  it('⛔ NINGÚN slot guarda la cantidad CRUDA: la que se escribe es la normalizada', () => {
    for (const slot of [1, 2, 3]) {
      expect(SUBMIT, `count_${slot} guarda dto.quantity sin normalizar`).not.toContain(
        `patch.count_${slot} = dto.quantity`,
      );
    }
    // `[ICR.M3]` El número del renglón ya no se teclea: es la SUMA de las capturas vivas de la
    // vuelta, y cada captura guarda la cantidad YA normalizada (`quantity_native: cantidad`).
    // Lo que protege esta prueba es lo mismo de siempre —que nadie escriba la cruda— sólo que
    // ahora el lugar donde entra al sistema es la bitácora.
    expect(SUBMIT).toContain('quantity_native: cantidad,');
    expect(SUBMIT, 'la captura guarda la cruda como si fuera nativa').not.toContain(
      'quantity_native: dto.quantity',
    );
    expect(SUBMIT).toContain('patch[slot] = this.sumaDeCapturas(vivasDespues);');
    expect(SUBMIT).toContain('dto.quantity * factorUsado');
  });

  it('cada slot deja el TESTIGO: en qué unidad se contó y con qué factor se convirtió', () => {
    for (const slot of [1, 2, 3]) {
      expect(SUBMIT).toContain(`patch.count_${slot}_unit = unidadUsada;`);
      expect(SUBMIT).toContain(`patch.count_${slot}_factor = factorUsado;`);
    }
  });

  it('la unidad por defecto sale del código PRIMARIO del SKU, no de una suposición', () => {
    expect(SERVICIO).toContain('catalog.product_barcodes');
    expect(SERVICIO).toContain('b.is_primary');
    // El desempate es determinista: primario primero, después el factor más chico.
    expect(SERVICIO).toContain('ORDER BY b.unit, b.is_primary DESC NULLS LAST, b.factor ASC');
    // Lo borrado no cuenta.
    expect(SERVICIO).toContain('b.deleted_at IS NULL');
  });

  it('sin unidad conocida NO se inventa una: factor 1 y unidad nula', () => {
    expect(SERVICIO).toContain("if (!productId && !sku) return { nativa: null, opciones: [] };");
    expect(SUBMIT).toContain('let unidadUsada: string | null = nativa?.unit ?? null;');
    expect(SUBMIT).toContain('let factorUsado = 1;');
  });

  it('una unidad que el producto NO tiene se rechaza, no se acepta en silencio', () => {
    expect(SUBMIT).toContain('throw new BadRequestException(');
    expect(SUBMIT).toContain('opciones.find((o) => o.unit.toUpperCase() === pedida)');
  });

  it('la unidad viaja por la cola OFFLINE: un conteo sin red llega con la suya', () => {
    expect(COLA).toContain('unit: scan.unit ?? null');
    expect(COLA).toContain('unit: s.unit ?? undefined');
  });

  it('PRUEBA NEGATIVA — si alguien devuelve la cantidad cruda, el candado se pone ROJO', () => {
    const mutante = SUBMIT.split('quantity_native: cantidad,').join(
      'quantity_native: dto.quantity,',
    );
    expect(mutante, 'la mutación no aplicó: el candado no probaría nada').not.toBe(SUBMIT);
    expect(mutante).toContain('quantity_native: dto.quantity');
    expect(mutante).not.toContain('quantity_native: cantidad,');
  });
});
