/**
 * `[COT.53]` El buscador del cotizador se cuenta ANÓNIMO y agregado (decisión 2026-11-22).
 * Lo que se vigila: qué se guarda de cada evento, que un evento sin sentido no escriba ni invente,
 * y que ni el SQL ni sus parámetros lleven quién buscó.
 */
import { BadRequestException } from '@nestjs/common';
// Sin `import ... from 'vitest'`: la config usa `globals: true`.
import { ScopeService, type ResolvedScope } from '@megadulces/platform-core';
import { CommercialQuotesService } from './commercial-quotes.service';
import { QuotePricingService } from './quote-pricing.service';

function alcanceTotal(): ResolvedScope {
  const dims = {} as ResolvedScope['dims'];
  for (const d of ['warehouse', 'zone', 'route', 'brand', 'expense_area', 'customer'] as const) {
    dims[d] = { mode: 'all', values: [], modeWrite: 'all', valuesWrite: [], source: 'role', resolvable: true };
  }
  return { tenantId: 't', userId: 'u1', roleName: 'r', dims };
}

function servicio() {
  const calls: Array<{ sql: string; binds: Record<string, unknown> }> = [];
  const knex: any = Object.assign(() => ({}), {
    raw: vi.fn(async (sql: string, binds: Record<string, unknown>) => {
      calls.push({ sql, binds });
      return { rows: [] };
    }),
  });
  const tk = { run: (fn: (k: any) => unknown) => fn(knex) } as any;
  const scopeSvc = new ScopeService(null as any, null as any);
  vi.spyOn(scopeSvc, 'current').mockResolvedValue(alcanceTotal());
  const ctx = { get: () => ({ userId: 'u1', tenantId: 't' }), requireTenantId: () => 't' } as any;
  const pricing = new QuotePricingService(tk, ctx, scopeSvc);
  const inserts = () => calls.filter((c) => c.sql.includes('quote_search_stats'));
  return { inserts, quotes: new CommercialQuotesService(tk, ctx, scopeSvc, pricing) };
}

describe('[COT.53] registrarBusqueda', () => {
  it('⭐ se eligió un artículo: cuenta término normalizado, SKU, posición y resultados — y suma si se repite', async () => {
    const { inserts, quotes } = servicio();
    const r = await quotes.registrarBusqueda({ branch: '01', term: '  Mazapan ', chosen_sku: '70056', position: 3, results: 12 });
    expect(r).toEqual({ registrada: true });
    expect(inserts()[0].binds).toEqual({ branch: '01', term: 'mazapan', sku: '70056', position: 3, results: 12 });
    expect(inserts()[0].sql).toMatch(/ON CONFLICT \(tenant_id, day, branch, term, chosen_sku, position\)/);
    expect(inserts()[0].sql).toContain('times = commercial.quote_search_stats.times + 1');
  });

  it('la búsqueda que no trajo nada: SKU vacío y posición 0', async () => {
    const { inserts, quotes } = servicio();
    await quotes.registrarBusqueda({ branch: '01', term: 'mazapam', results: 0 });
    expect(inserts()[0].binds).toMatchObject({ term: 'mazapam', sku: '', position: 0, results: 0 });
  });

  it('⭐ ANÓNIMO: ni el SQL ni sus parámetros llevan quién buscó', async () => {
    const { inserts, quotes } = servicio();
    await quotes.registrarBusqueda({ branch: '01', term: 'kinder', chosen_sku: '111', position: 1, results: 4 });
    expect(inserts()[0].sql).not.toMatch(/user|created_by|updated_by/i);
    expect(Object.values(inserts()[0].binds)).not.toContain('u1');
  });

  it('NEGATIVA: elegido sin posición no se guarda (ponerle «1» sería inventar dónde estaba)', async () => {
    const { inserts, quotes } = servicio();
    expect(await quotes.registrarBusqueda({ branch: '01', term: 'kinder', chosen_sku: '111', results: 4 })).toEqual({ registrada: false });
    expect(inserts()).toHaveLength(0);
  });

  it('término vacío no se guarda y no es error; sin sucursal sí es error', async () => {
    const { inserts, quotes } = servicio();
    expect(await quotes.registrarBusqueda({ branch: '01', term: '   ', results: 0 })).toEqual({ registrada: false });
    await expect(quotes.registrarBusqueda({ branch: '', term: 'kinder', results: 0 })).rejects.toBeInstanceOf(BadRequestException);
    expect(inserts()).toHaveLength(0);
  });
});
