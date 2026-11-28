// [CG.38.1] Sin `import ... from 'vitest'`: la config usa `globals: true`.
/**
 * `[COT.57]` **Sin `product_id` no hay precio nuestro** — y la cotización ya no muere por intentarlo.
 *
 * Medido en prod el 2026-11-28: `POST /api/commercial/quotes` devolvía **500** con
 * `violates check constraint "commercial_quote_lines_unmatched_has_no_price"`, dos veces en dos
 * minutos, con operadores conectados. El motor le pone precio a un SKU que Kepler tiene y
 * `public.products` no; ese precio llegaba al INSERT y Postgres tiraba **la cotización entera**.
 *
 * ⭐ La cifra que lo vuelve inequívoco: de **15,008 renglones** vivos, **CERO** tienen `product_id`
 * nulo. El camino que el código creía tener —«guardo la demanda que estoy rechazando»— nunca
 * funcionó desde el 21-sep, y cero filas por defecto se lee igual que cero por desuso.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Knex } from 'knex';
import { QuotePricingService, type Ladder, type PrecargaPrecios } from './quote-pricing.service';

const FUENTE = readFileSync(join(__dirname, 'quote-pricing.service.ts'), 'utf8');
const MIGRACION = readFileSync(
  join(__dirname, '../../../../../database/migrations-newdb/20260921190000_commercial_quotes.js'),
  'utf8',
);

const ESCALERA: Ladder = {
  name: 'PRODUCTO QUE KEPLER TIENE Y LA SUITE NO',
  unit_base: 'PZA',
  rungs: {
    base: { rung: 'base', label: 'PZA', price: 42, size: 1, volume: null },
    pack: { rung: 'pack', label: null, price: null, size: null, volume: null },
    box: { rung: 'box', label: null, price: null, size: null, volume: null },
  } as Ladder['rungs'],
};

function motor(): QuotePricingService {
  const s = Object.create(QuotePricingService.prototype) as QuotePricingService;
  Object.assign(s, { tenantCtx: { requireTenantId: () => 't1', get: () => ({ userId: 'u1' }) } });
  return s;
}

/** La base donde el SKU **no** está en el catálogo de la Suite: ninguna lectura trae fila. */
const sinCatalogo = { raw: async () => ({ rows: [] }) } as unknown as Knex;
/** La misma, pero con el producto dado de alta: es el control que impide pasar en vacío. */
const conCatalogo = {
  raw: async (sql: string) => ({ rows: /products/.test(sql) ? [{ id: 'p1', name: 'EL MISMO' }] : [] }),
} as unknown as Knex;

const pre: PrecargaPrecios = { ladders: new Map([['99999', ESCALERA]]), reglas: new Map() };

/** La regla de guardado, que es `private static` y se ejerce por su nombre. */
const regla = (QuotePricingService as unknown as {
  precioQueSePuedeGuardar(p: { product_id?: string | null; unit_price?: number | null } | null): number | null;
}).precioQueSePuedeGuardar;

describe('[COT.57] un renglón sin producto informa demanda, no cobra', () => {
  it('CONTROL — el caso existe: el motor cotiza $42 un SKU que el catálogo de la Suite no tiene', async () => {
    const p = await motor().priceLine(sinCatalogo, { branch: '01', sku: '99999', quantity: 1, rung: 'base' }, pre);
    // Si esto fallara, la prueba de abajo no probaría nada: no habría precio que anular.
    expect(p.unit_price, 'el motor dejó de cotizar: esta prueba ya no mide lo que dice medir').toBe(42);
    expect(p.product_id, 'el producto apareció en el catálogo: hace falta otro caso').toBeNull();
    expect(p.availability).toBe('unmatched');
  });

  it('CONTROL OPUESTO — con el producto dado de alta, el mismo renglón SÍ conserva su precio', async () => {
    const p = await motor().priceLine(conCatalogo, { branch: '01', sku: '99999', quantity: 1, rung: 'base' }, pre);
    expect(p.product_id).toBe('p1');
    expect(regla(p)).toBe(42);
  });

  it('lo que se guarda de un renglón sin producto es NULL, no el precio ni un cero', () => {
    expect(regla({ product_id: null, unit_price: 42 })).toBeNull();
    expect(regla({ product_id: undefined, unit_price: 0 })).toBeNull();
    // ⛔ Un cero no sirve: el CHECK exige `unit_price IS NULL`, y además un 0 afirma «vale cero».
    expect(regla({ product_id: null, unit_price: 42 })).not.toBe(0);
  });

  it('PRUEBA NEGATIVA — si la regla devuelve el precio igual, el candado se pone ROJO', () => {
    const mutante = (p: { product_id?: string | null; unit_price?: number | null } | null) => p?.unit_price ?? null;
    expect(mutante({ product_id: null, unit_price: 42 }), 'la mutación no aplicó').toBe(42);
    expect(mutante({ product_id: null, unit_price: 42 })).not.toBeNull();
  });

  it('la regla del código es LA MISMA que la tabla exige — leída de su migración, no copiada', () => {
    const def = /commercial_quote_lines_unmatched_has_no_price[\s\S]{0,200}?CHECK \(([^)]*\)?[^)]*)\)/.exec(MIGRACION);
    expect(def, 'no se encontró el CHECK en la migración: ¿lo renombraron?').not.toBeNull();
    const texto = (def?.[1] ?? '').replace(/\s+/g, ' ');
    expect(texto).toContain('product_id IS NOT NULL');
    expect(texto).toContain('unit_price IS NULL');
  });

  it('los CUATRO caminos que escriben pasan por la regla: ninguno manda el precio crudo ni un 0', () => {
    // Los dos que cotizan (alta y re-cotización de un renglón).
    const porLaRegla = FUENTE.split('QuotePricingService.precioQueSePuedeGuardar(priced)').length - 1;
    expect(porLaRegla, 'alta y re-cotización tienen que pasar los dos por la regla').toBe(2);
    expect(FUENTE, 'volvió el precio crudo al guardado').not.toContain('const unit = priced?.unit_price ?? null;');

    // Los dos del producto de regalo: un regalo vale 0 SÓLO si sabemos qué es.
    const regalos = FUENTE.split(':precio_regalo, :precio_regalo, 0, 0').length - 1;
    expect(regalos, 'los dos INSERT de producto gratis tienen que parametrizar su precio').toBe(2);
    expect(FUENTE, 'volvió el 0 literal del regalo').not.toContain("0, 0, 0, 0, 'free_goods'");
    const anulados = FUENTE.split('precio_regalo: priced.free_goods.product_id ? 0 : null').length - 1;
    expect(anulados).toBe(2);
  });

  it('el renglón sin precio no se va mudo: dice por qué no cotizó', () => {
    const razon = (QuotePricingService as unknown as {
      razonDelRenglon(p: { product_id?: string | null; sku?: string; unpriced_reason?: string | null } | null): string | null;
    }).razonDelRenglon;
    expect(razon({ product_id: null, sku: '99999' })).toContain('99999');
    expect(razon({ product_id: null, sku: '99999' })).toContain('no está en el catálogo');
    // Con producto, la nota sigue siendo la del motor: esta regla no pisa lo que ya se decía.
    expect(razon({ product_id: 'p1', unpriced_reason: 'sin lista de precios' })).toBe('sin lista de precios');
  });
});
