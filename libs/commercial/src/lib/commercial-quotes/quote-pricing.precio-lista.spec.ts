// [CG.38.1] Sin `import ... from 'vitest'`: la config usa `globals: true`.
/**
 * `[COT.55]` «Solo precio 1 (sin mayoreo)»: el MOTOR (no un objeto armado a mano) deja el renglón en
 * el precio de lista aunque la cantidad alcance el tramo de volumen, y dice por qué. Con el mismo
 * renglón sin la bandera, el volumen se cobra: así la prueba no pasa en vacío.
 */
import type { Knex } from 'knex';
import { MOTIVO_SIN_MAYOREO, QuotePricingService, type Ladder, type PrecargaPrecios } from './quote-pricing.service';

const CAJA: Ladder = {
  name: 'PAL JUMBO CEREZA',
  unit_base: 'PZA',
  rungs: {
    base: { rung: 'base', label: 'PZA', price: 60, size: 1, volume: null },
    pack: { rung: 'pack', label: null, price: null, size: null, volume: null },
    box: { rung: 'box', label: 'CJA', price: 810, size: 15, volume: { min_qty: 3, price: 795 } },
  } as Ladder['rungs'],
};

function motor(): QuotePricingService {
  const s = Object.create(QuotePricingService.prototype) as QuotePricingService;
  Object.assign(s, { tenantCtx: { requireTenantId: () => 't1', get: () => ({ userId: 'u1' }) } });
  return s;
}

/** Base falsa: el producto existe; cualquier otra lectura (impuestos) no trae filas. */
const knex = {
  raw: async (sql: string) => ({ rows: /catalog\.products/.test(sql) ? [{ id: 'p1', name: 'PAL JUMBO CEREZA' }] : [] }),
} as unknown as Knex;

const pre: PrecargaPrecios = { ladders: new Map([['70068', CAJA]]), reglas: new Map() };

describe('[COT.55] solo precio 1 (sin mayoreo)', () => {
  it('sin la bandera, 3 CJA cobran el precio por volumen (control)', async () => {
    const p = await motor().priceLine(knex, { branch: '01', sku: '70068', quantity: 3, rung: 'box' }, pre);
    expect(p.unit_price).toBe(795);
    expect(p.price_source).toBe('volume_qty');
  });

  it('con la bandera, 3 CJA se quedan en la lista y se dice por qué', async () => {
    const p = await motor().priceLine(knex, { branch: '01', sku: '70068', quantity: 3, rung: 'box', list_price_only: true }, pre);
    expect(p.unit_price).toBe(810);
    expect(p.price_source).toBe('list');
    expect(p.applied.some((a) => a.step === 'volumen')).toBe(false);
    expect(p.not_applied.find((n) => n.mechanism === 'volumen')?.reason).toContain(MOTIVO_SIN_MAYOREO);
    // No se ofrece el tramo («desde 3 baja a…»): no se va a cobrar.
    expect(p.volume_tier).toBeNull();
  });

  it('con la bandera y una cantidad abajo del tramo, también lista (no cambia nada)', async () => {
    const p = await motor().priceLine(knex, { branch: '01', sku: '70068', quantity: 1, rung: 'box', list_price_only: true }, pre);
    expect(p.unit_price).toBe(810);
    expect(p.price_source).toBe('list');
  });
});
