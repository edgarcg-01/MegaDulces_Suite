// [CG.38.1] Sin `import ... from 'vitest'`: la config usa `globals: true`.
/**
 * `[COT.57]` Precio PACTADO a mano (`price_source = 'manual'`): lo decidió una persona. Caso real:
 * COT-2026-00650 (2026-11-24) con los precios de un pedido en línea; la revisión los marcaba «cambió en
 * Kepler», frenaba el pedido y empujaba a re-cotizar, que los borraba.
 */
import { QuotePricingService, esPrecioPactado } from './quote-pricing.service';

describe('[COT.57] esPrecioPactado', () => {
  it('sólo «manual» es pactado', () => {
    expect(esPrecioPactado('manual')).toBe(true);
    for (const s of ['list', 'volume_qty', 'promo_qty', 'unknown', null, undefined]) expect(esPrecioPactado(s)).toBe(false);
  });
});

describe('[COT.57] cambiar la cantidad de un renglón pactado', () => {
  function armar(linea: Record<string, unknown>) {
    const sql: Array<{ s: string; b?: Record<string, unknown> }> = [];
    const k = {
      raw: async (s: string, b?: Record<string, unknown>) => {
        sql.push({ s, b });
        if (s.includes('FROM commercial.quotes') && s.includes('FOR UPDATE')) return { rows: [{ id: 'q1', status: 'draft', source_branch: '01', list_price_only: false }] };
        if (s.includes('FROM commercial.quote_lines') && s.includes('WHERE id = :lid')) return { rows: [linea] };
        if (s.includes('SELECT line_total, iva_rate, ieps_rate')) return { rows: [{ line_total: 419.88, iva_rate: 0, ieps_rate: 0.08 }] };
        if (s.includes('SELECT terms_discount_pct')) return { rows: [{ terms_discount_pct: null }] };
        if (s.includes('count(*)::int')) return { rows: [{ n: 1 }] };
        return { rows: [] };
      },
    };
    const s = Object.create(QuotePricingService.prototype) as QuotePricingService;
    Object.assign(s, {
      tk: { run: (fn: (x: unknown) => unknown) => fn(k) },
      tenantCtx: { requireTenantId: () => 't1', get: () => ({ userId: 'u1' }) },
      assertEscribe: async () => undefined,
    });
    return { s, sql };
  }
  const PACTADO = { id: 'l1', line_number: 1, product_id: 'p1', requested_text: null, parent_line_number: null, qty_unit: 'PAQ',
    price_source: 'manual', unit_price: '69.98', iva_rate: '0', ieps_rate: '0.08' };

  it('la cantidad cambia y el precio pactado se queda (importe y subtotal sin impuestos recalculados)', async () => {
    const { s, sql } = armar(PACTADO);
    await expect(s.updateLine('q1', 'l1', { quantity: 6 })).resolves.toMatchObject({ priced: null });
    const upd = sql.find((x) => x.s.includes('UPDATE commercial.quote_lines') && x.s.includes('SET quantity = :q'));
    expect(upd?.b).toMatchObject({ q: 6, t: 419.88, s: 388.78 });
    // No se volvió a preciar: no se leyó la escalera ni se tocó unit_price.
    expect(sql.some((x) => x.s.includes('unit_price = :unit_price'))).toBe(false);
  });

  it('con otra presentación el precio pactado ya no aplica: va al motor (no al atajo)', async () => {
    const { s, sql } = armar(PACTADO);
    await s.updateLine('q1', 'l1', { quantity: 1, rung: 'box' }).catch(() => undefined);
    expect(sql.some((x) => x.s.includes('SET quantity = :q, line_total = :t'))).toBe(false);
  });
});
