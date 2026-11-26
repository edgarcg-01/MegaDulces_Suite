// [CG.38.1] Sin `import ... from 'vitest'`: la config usa `globals: true`.
/**
 * `[COT.58]` La pieza de un pieza · paquete · caja se vende sólo en piso: el MOTOR la rechaza cuando la
 * unidad se ELIGE (renglón nuevo o cambio de unidad) y la sigue preciando al re-cotizar un renglón ya
 * guardado. Los controles (granel, paquete, sin la bandera) evitan que la prueba pase en vacío.
 */
import { BadRequestException } from '@nestjs/common';
import type { Knex } from 'knex';
import { QuotePricingService, piezaSoloEnPisoDeEscalera, type Ladder, type PrecargaPrecios, type PriceLineInput } from './quote-pricing.service';

const r = (rung: 'base' | 'pack' | 'box', label: string | null, price: number | null, size: number | null) => ({ rung, label, price, size, volume: null });

// 06001 CHOC SNICKERS /6 en Morelia Abastos, medido en prod el 2026-11-24.
const SNICKERS: Ladder = {
  name: 'CHOC SNICKERS /6',
  unit_base: 'PZA',
  rungs: { base: r('base', 'PZA', 23.99, 1), pack: r('pack', 'PAQ', 102.98, 6), box: r('box', 'CJA', 2950.57, 192) } as Ladder['rungs'],
};
// 17252 POLIPRO: granel, la unidad menor es de 250 g y se queda.
const POLIPRO: Ladder = {
  name: 'POLIPRO 10X15 10KG ZAPIEN',
  unit_base: '250',
  rungs: { base: r('base', '250', 30, 1), pack: r('pack', 'KG', 115, 4), box: r('box', 'CJA', 1100, 40) } as Ladder['rungs'],
};

function motor(): QuotePricingService {
  const s = Object.create(QuotePricingService.prototype) as QuotePricingService;
  Object.assign(s, { tenantCtx: { requireTenantId: () => 't1', get: () => ({ userId: 'u1' }) } });
  return s;
}

const knex = {
  raw: async (sql: string) => ({ rows: /catalog\.products/.test(sql) ? [{ id: 'p1', name: 'X' }] : [] }),
} as unknown as Knex;

const pre: PrecargaPrecios = { ladders: new Map([['06001', SNICKERS], ['17252', POLIPRO]]), reglas: new Map() };

describe('[COT.58] la pieza de un pieza · paquete · caja no se cotiza', () => {
  it('al elegir la pieza, el motor la rechaza y dice por qué unidades sí va', async () => {
    const p = motor().priceLine(knex, { branch: '08', sku: '06001', quantity: 1, rung: 'base', check_sellable_unit: true }, pre);
    await expect(p).rejects.toBeInstanceOf(BadRequestException);
    await expect(motor().priceLine(knex, { branch: '08', sku: '06001', quantity: 1, rung: 'base', check_sellable_unit: true }, pre))
      .rejects.toThrow('La pieza de 06001 CHOC SNICKERS /6 se vende sólo en piso de ventas: en cotización va por paquete (6 PZA) o por caja (192 PZA).');
  });

  it('sin peldaño explícito también es la pieza (el default): se rechaza igual', async () => {
    await expect(motor().priceLine(knex, { branch: '08', sku: '06001', quantity: 1, check_sellable_unit: true }, pre)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('el paquete del mismo producto sí se cotiza (control)', async () => {
    const p = await motor().priceLine(knex, { branch: '08', sku: '06001', quantity: 1, rung: 'pack', check_sellable_unit: true }, pre);
    // Kepler redondea por pieza a centavos: $102.98 / 6 = $17.16 → 6 × $17.16.
    expect(p.unit_price).toBe(102.96);
  });

  it('re-preciar un renglón ya guardado en pieza (sin la bandera) lo sigue preciando', async () => {
    const p = await motor().priceLine(knex, { branch: '08', sku: '06001', quantity: 2, rung_label: 'PZA' }, pre);
    expect(p.rung).toBe('base');
    expect(p.unit_price).toBe(23.99);
  });

  it('el granel por peso conserva su unidad menor', async () => {
    const p = await motor().priceLine(knex, { branch: '01', sku: '17252', quantity: 1, rung: 'base', check_sellable_unit: true }, pre);
    expect(p.unit_price).toBe(30);
  });

  it('un paquete o una caja SIN precio no cuentan como ofrecidos: entonces la pieza se queda', () => {
    const sinCaja = { rungs: { ...SNICKERS.rungs, box: r('box', 'CJA', null, 192) } } as Ladder;
    expect(piezaSoloEnPisoDeEscalera(SNICKERS)).toBe(true);
    expect(piezaSoloEnPisoDeEscalera(sinCaja)).toBe(false);
  });
});

describe('[COT.58] quién pide la validación', () => {
  /** Un método privado del servicio, llamado sobre el motor espiado (no `Function`: lint lo prohíbe). */
  type Metodo = (this: unknown, ...args: unknown[]) => Promise<unknown>;
  /** Motor con `priceLine` espiado: guarda lo que recibe y corta ahí. */
  function espiado() {
    const s = motor() as unknown as Record<string, unknown>;
    const vistos: PriceLineInput[] = [];
    s['priceLine'] = async (_k: Knex, input: PriceLineInput) => { vistos.push(input); throw new Error('alto'); };
    s['skuDelRenglon'] = async () => '06001';
    s['assertEscribe'] = async () => undefined;
    return { s, vistos };
  }
  const borrador = { raw: async () => ({ rows: [{ id: 'q1', status: 'draft', source_branch: '08', list_price_only: false }] }) } as unknown as Knex;
  const linea = { id: 'l1', line_number: 1, product_id: 'p1', requested_text: null, qty_unit: 'PZA' };

  it('agregar un renglón: sí', async () => {
    const { s, vistos } = espiado();
    await expect((s['addLineTrx'] as Metodo).call(s, borrador, 'q1', { sku: '06001', quantity: 1, rung: 'base' }, 'u1')).rejects.toThrow('alto');
    expect(vistos[0].check_sellable_unit).toBe(true);
  });

  it('cambiar el renglón a otra unidad: sí', async () => {
    const { s, vistos } = espiado();
    await expect((s['retarificarRenglonTrx'] as Metodo).call(s, borrador, 'q1', '08', linea, 1, 'base', 'u1')).rejects.toThrow('alto');
    expect(vistos[0].check_sellable_unit).toBe(true);
  });

  it('cambiar sólo la cantidad o re-cotizar (sin unidad nueva): no', async () => {
    const { s, vistos } = espiado();
    await expect((s['retarificarRenglonTrx'] as Metodo).call(s, borrador, 'q1', '08', linea, 3, undefined, 'u1')).rejects.toThrow('alto');
    expect(vistos[0].check_sellable_unit).toBe(false);
  });
});
