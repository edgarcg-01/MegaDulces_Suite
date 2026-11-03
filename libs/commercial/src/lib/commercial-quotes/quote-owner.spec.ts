/**
 * `[COT.21]` — Cada quien ve sólo sus cotizaciones; Dirección ve las de todos.
 *
 * Caso real (prod, 2026-11-03): las cuatro que cotizan en Padre Hidalgo veían y podían cancelar
 * las cotizaciones de las otras tres, porque el único filtro era la sucursal (COT.19).
 */
import { ForbiddenException } from '@nestjs/common';
// Sin `import ... from 'vitest'`: la config usa `globals: true` (ver quote-scope.spec.ts).
import { ScopeService, isPlatformAdminRole, type ResolvedScope } from '@megadulces/platform-core';
import { CommercialQuotesService } from './commercial-quotes.service';
import { QuotePricingService } from './quote-pricing.service';
import { autorVisible, MENSAJE_COTIZACION_AJENA, PERMISO_VER_TODAS_COTIZACIONES } from './quote-scope';

const TELEMARKETING = { permissions: { COMMERCIAL_QUOTES_VER: true }, roles_frescos: ['vendedor_telemarketing'] };
const DIRECCION = {
  permissions: { COMMERCIAL_QUOTES_VER: true, [PERMISO_VER_TODAS_COTIZACIONES]: true },
  roles_frescos: ['direccion'],
};
const SUPERADMIN = { permissions: {}, roles_frescos: ['superadmin'] };
// Una clave nueva queda en `false` al guardar el mapa desde /admin/roles: no abre nada.
const LLAVE_EN_FALSE = { permissions: { [PERMISO_VER_TODAS_COTIZACIONES]: false }, roles_frescos: ['supervisor'] };

describe('autorVisible: ¿las de todos o sólo las suyas?', () => {
  it('telemarketing → sólo las suyas', () => {
    expect(autorVisible(TELEMARKETING, 'u1', isPlatformAdminRole)).toBe('u1');
  });

  it('con la llave (Dirección) → las de todos', () => {
    expect(autorVisible(DIRECCION, 'u1', isPlatformAdminRole)).toBeNull();
  });

  it('rol de plataforma → las de todos, como en RolesGuard', () => {
    expect(autorVisible(SUPERADMIN, 'u1', isPlatformAdminRole)).toBeNull();
  });

  it('la llave en `false` NO abre', () => {
    expect(autorVisible(LLAVE_EN_FALSE, 'u1', isPlatformAdminRole)).toBe('u1');
  });

  it('sin datos de quién pide → sólo las suyas (nunca «todas» por omisión)', () => {
    expect(autorVisible(undefined, 'u1', isPlatformAdminRole)).toBe('u1');
  });

  it('sin usuario → no casa con ninguna', () => {
    expect(autorVisible(TELEMARKETING, undefined, isPlatformAdminRole)).toBe('');
  });
});

/** Alcance `all` en todo: aísla la regla de autor del filtro por sucursal. */
function alcanceTotal(): ResolvedScope {
  const dims = {} as ResolvedScope['dims'];
  for (const d of ['warehouse', 'zone', 'route', 'brand', 'expense_area', 'customer'] as const) {
    dims[d] = { mode: 'all', values: [], modeWrite: 'all', valuesWrite: [], source: 'role', resolvable: true };
  }
  return { tenantId: 't', userId: 'u1', roleName: 'r', dims };
}

/** Knex falso: anota cada `raw`; el builder devuelve en `first` la fila que se le dé. */
function servicios(filaDeLaCotizacion: Record<string, unknown> | undefined = undefined) {
  const calls: Array<{ sql: string; binds: Record<string, unknown> }> = [];
  const builder: any = new Proxy(function noop() { return undefined; }, {
    get: (_t, prop) => (prop === 'then' ? undefined : prop === 'first' ? async () => filaDeLaCotizacion : () => builder),
    apply: () => builder,
  });
  const knex: any = Object.assign(() => builder, {
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
  return { calls, quotes: new CommercialQuotesService(tk, ctx, scopeSvc, pricing) };
}

describe('Lista y resumen: el filtro por autor lo pone el servidor, no la pantalla', () => {
  it('telemarketing: la lista filtra por su usuario aunque no mande `mine`', async () => {
    const { calls, quotes } = servicios();
    await quotes.list({}, TELEMARKETING);
    expect(calls[0].sql).toContain('q.user_id = :author_id');
    expect(calls[0].binds['author_id']).toBe('u1');
  });

  it('telemarketing: el resumen cuenta lo mismo que la lista', async () => {
    const { calls, quotes } = servicios();
    await quotes.summary(false, TELEMARKETING);
    expect(calls[0].sql).toContain('q.user_id = :author_id');
    expect(calls[0].binds['author_id']).toBe('u1');
  });

  it('Dirección: ni la lista ni el resumen filtran por autor', async () => {
    const { calls, quotes } = servicios();
    await quotes.list({}, DIRECCION);
    await quotes.summary(false, DIRECCION);
    expect(calls.every((c) => !c.sql.includes(':author_id'))).toBe(true);
  });

  it('sin usuario en sesión: `false`, no un uuid vacío que truene en Postgres', async () => {
    const { calls, quotes } = servicios();
    (quotes as any).tenantCtx = { get: () => ({ tenantId: 't' }) };
    await quotes.list({}, TELEMARKETING);
    expect(calls[0].sql).toMatch(/AND false/);
    expect(calls[0].binds['author_id']).toBeUndefined();
  });
});

describe('Abrir por id: la de otra persona es 403 con su porqué', () => {
  it('telemarketing NO abre la de otra', async () => {
    const { quotes } = servicios({ user_id: 'otra' });
    await expect(quotes.getOne('q1', TELEMARKETING)).rejects.toThrow(MENSAJE_COTIZACION_AJENA);
  });

  it('...ni la cancela', async () => {
    const { calls, quotes } = servicios({ user_id: 'otra' });
    await expect(quotes.cancel('q1', 'duplicada', TELEMARKETING)).rejects.toBeInstanceOf(ForbiddenException);
    expect(calls.some((c) => c.sql.includes('UPDATE commercial.quotes'))).toBe(false);
  });

  it('...ni le toca renglones (la compuerta que usa el controlador)', async () => {
    const { quotes } = servicios({ user_id: 'otra' });
    await expect(quotes.assertPuedeAbrir('q1', TELEMARKETING)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('la suya sí pasa', async () => {
    const { quotes } = servicios({ user_id: 'u1' });
    await expect(quotes.assertPuedeAbrir('q1', TELEMARKETING)).resolves.toBeUndefined();
  });

  it('Dirección abre la de cualquiera', async () => {
    const { quotes } = servicios({ user_id: 'otra' });
    await expect(quotes.assertPuedeAbrir('q1', DIRECCION)).resolves.toBeUndefined();
  });
});
