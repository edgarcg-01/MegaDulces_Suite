/**
 * `[COT.52]` Cerrar una cotización sin pedido, con motivo.
 *
 * Medido en prod (2026-11-22): 94 borradores de más de 7 días por $1.82M y ninguna cotización
 * cerrada con motivo — no había cómo. Lo que se vigila: el motivo decide el estado (rechazada =
 * el cliente no compró; cancelada = baja nuestra), sin motivo no se cierra, y lo que ya es pedido
 * en Kepler o ya estaba cerrado no se toca.
 */
import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
// Sin `import ... from 'vitest'`: la config usa `globals: true`.
import { ScopeService, type ResolvedScope } from '@megadulces/platform-core';
import { CommercialQuotesService } from './commercial-quotes.service';
import { QuotePricingService } from './quote-pricing.service';

const TELEMARKETING = { permissions: { COMMERCIAL_QUOTES_VER: true }, roles_frescos: ['vendedor_telemarketing'] };

function alcanceTotal(): ResolvedScope {
  const dims = {} as ResolvedScope['dims'];
  for (const d of ['warehouse', 'zone', 'route', 'brand', 'expense_area', 'customer'] as const) {
    dims[d] = { mode: 'all', values: [], modeWrite: 'all', valuesWrite: [], source: 'role', resolvable: true };
  }
  return { tenantId: 't', userId: 'u1', roleName: 'r', dims };
}

/** Knex falso: `first` devuelve la cotización; cada `raw` se anota y el UPDATE devuelve su fila. */
function servicios(cot: Record<string, unknown>) {
  const calls: Array<{ sql: string; binds: Record<string, unknown> }> = [];
  const builder: any = new Proxy(function noop() { return undefined; }, {
    get: (_t, prop) => (prop === 'then' ? undefined : prop === 'first' ? async () => cot : () => builder),
    apply: () => builder,
  });
  const knex: any = Object.assign(() => builder, {
    raw: vi.fn(async (sql: string, binds: Record<string, unknown>) => {
      calls.push({ sql, binds });
      return { rows: [{ id: 'q1', code: 'COT-2026-00001', status: binds['status'], close_reason: binds['reason'] }] };
    }),
  });
  const tk = { run: (fn: (k: any) => unknown) => fn(knex) } as any;
  const scopeSvc = new ScopeService(null as any, null as any);
  vi.spyOn(scopeSvc, 'current').mockResolvedValue(alcanceTotal());
  const ctx = { get: () => ({ userId: 'u1', tenantId: 't' }), requireTenantId: () => 't' } as any;
  const pricing = new QuotePricingService(tk, ctx, scopeSvc);
  const updates = () => calls.filter((c) => c.sql.includes('UPDATE commercial.quotes'));
  return { updates, quotes: new CommercialQuotesService(tk, ctx, scopeSvc, pricing) };
}

const BORRADOR = { user_id: 'u1', status: 'draft', source_branch: '01', kepler_folio: null };

describe('[COT.52] cerrar una cotización sin pedido', () => {
  it('⭐ «por el precio» = el cliente no compró: RECHAZADA, con su marca de tiempo y el motivo contable', async () => {
    const { updates, quotes } = servicios(BORRADOR);
    const r = await quotes.close('q1', { motivo: 'precio' }, TELEMARKETING);
    expect(r).toMatchObject({ status: 'rejected', close_reason: 'precio' });
    expect(updates()).toHaveLength(1);
    expect(updates()[0].sql).toContain('rejected_at = now()');
    expect(updates()[0].sql).not.toContain('cancelled_at');
  });

  it('«era una prueba» = baja nuestra: CANCELADA (no cuenta como venta perdida)', async () => {
    const { updates, quotes } = servicios(BORRADOR);
    const r = await quotes.close('q1', { motivo: 'prueba', nota: '  la capturé dos veces  ' }, TELEMARKETING);
    expect(r).toMatchObject({ status: 'cancelled', close_reason: 'prueba — la capturé dos veces' });
    expect(updates()[0].sql).toContain('cancelled_at = now()');
  });

  it('⭐ NEGATIVA: sin motivo, o con uno inventado, no se cierra nada', async () => {
    const { updates, quotes } = servicios(BORRADOR);
    await expect(quotes.close('q1', {} as never, TELEMARKETING)).rejects.toBeInstanceOf(BadRequestException);
    await expect(quotes.close('q1', { motivo: 'ya_no' as never }, TELEMARKETING)).rejects.toBeInstanceOf(BadRequestException);
    expect(updates()).toHaveLength(0);
  });

  it('«otro» exige escribir cuál', async () => {
    const { updates, quotes } = servicios(BORRADOR);
    await expect(quotes.close('q1', { motivo: 'otro', nota: '   ' }, TELEMARKETING)).rejects.toThrow('escribe cuál');
    expect(updates()).toHaveLength(0);
  });

  it('lo que ya es pedido en Kepler se cancela allá, no aquí', async () => {
    const { updates, quotes } = servicios({ ...BORRADOR, kepler_folio: '1234' });
    await expect(quotes.close('q1', { motivo: 'precio' }, TELEMARKETING)).rejects.toBeInstanceOf(ConflictException);
    expect(updates()).toHaveLength(0);
  });

  it('una ya cerrada (aceptada, rechazada, cancelada) no se vuelve a cerrar', async () => {
    for (const status of ['accepted', 'rejected', 'cancelled', 'expired']) {
      const { updates, quotes } = servicios({ ...BORRADOR, status });
      await expect(quotes.close('q1', { motivo: 'precio' }, TELEMARKETING)).rejects.toBeInstanceOf(ConflictException);
      expect(updates()).toHaveLength(0);
    }
  });

  it('la de otra persona no se cierra (la misma regla que abrirla, COT.21)', async () => {
    const { updates, quotes } = servicios({ ...BORRADOR, user_id: 'otra' });
    await expect(quotes.close('q1', { motivo: 'precio' }, TELEMARKETING)).rejects.toBeInstanceOf(ForbiddenException);
    expect(updates()).toHaveLength(0);
  });

  it('el UPDATE sólo pega si sigue abierta y fuera de Kepler (otra pestaña pudo cerrarla)', async () => {
    const { updates, quotes } = servicios(BORRADOR);
    await quotes.close('q1', { motivo: 'sin_existencia' }, TELEMARKETING);
    expect(updates()[0].sql).toMatch(/status IN \('draft', 'sent'\) AND kepler_folio IS NULL/);
  });
});
