/**
 * `[COT.19]` — El cotizador respeta las sucursales del usuario (ADR-050).
 *
 * Caso real que lo disparó (prod, 2026-10-03): `alberto_ayala`, rol `vendedor_telemarketing`
 * (alcance `own`), perfil en `08` Morelia Abastos, abrió el cotizador y le arrancó en la `01`
 * Padre Hidalgo — y el servidor aceptaba cotizar ahí porque ningún endpoint preguntaba.
 *
 * Se usa el `ScopeService` REAL (sus reglas `intersect` / `canRead` / `canWrite` son puras); sólo
 * se fija `current()` con el alcance ya resuelto de cada tipo de usuario.
 */
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { ScopeService, type ResolvedScope, type ScopeMode } from '@megadulces/platform-core';
import { CommercialQuotesService } from './commercial-quotes.service';
import { QuotePricingService } from './quote-pricing.service';

const DIMS = ['warehouse', 'zone', 'route', 'brand', 'expense_area', 'customer'] as const;

function alcance(mode: ScopeMode, values: string[] = [], modeWrite?: ScopeMode, valuesWrite?: string[]): ResolvedScope {
  const dims = {} as ResolvedScope['dims'];
  for (const d of DIMS) {
    dims[d] = { mode: 'all', values: [], modeWrite: 'all', valuesWrite: [], source: 'role', resolvable: true };
  }
  dims.warehouse = {
    mode,
    values,
    modeWrite: modeWrite ?? mode,
    valuesWrite: valuesWrite ?? values,
    source: 'role',
    resolvable: mode !== 'own' || values.length > 0,
  };
  return { tenantId: 't', userId: 'u', roleName: 'r', dims };
}

const VENDEDOR_08 = alcance('own', ['08']); // alberto_ayala
const GERENTE_01_06 = alcance('listed', ['01', '06']); // maria_garcia
const DIRECCION = alcance('all');
const SIN_SUCURSAL = alcance('own', []); // juan_espinoza: own sin warehouse_code
const VE_TRES_EDITA_UNA = alcance('listed', ['01', '02', '03'], 'listed', ['01']);

/**
 * Un knex falso que anota cada `raw` (SQL y valores) y responde vacío. También es llamable,
 * con un builder que se encadena a sí mismo, porque la búsqueda de clientes arma su `hit`
 * con el query builder antes del `raw`.
 */
function fakeTk(perfil: string | null = null) {
  const calls: Array<{ sql: string; binds: Record<string, unknown> }> = [];
  const builder: any = new Proxy(function noop() { return undefined; }, {
    get: (_t, prop) =>
      prop === 'then' ? undefined : prop === 'first' ? async () => ({ warehouse_code: perfil }) : () => builder,
    apply: () => builder,
  });
  const knex: any = Object.assign(() => builder, {
    raw: vi.fn(async (sql: string, binds: Record<string, unknown>) => {
      calls.push({ sql, binds });
      return { rows: [] };
    }),
  });
  return { calls, tk: { run: (fn: (k: any) => unknown) => fn(knex) } as any };
}

function servicios(scope: ResolvedScope, perfil: string | null = null) {
  const { calls, tk } = fakeTk(perfil);
  const scopeSvc = new ScopeService(null as any, null as any);
  vi.spyOn(scopeSvc, 'current').mockResolvedValue(scope);
  const ctx = { get: () => ({ userId: 'u', tenantId: 't' }), requireTenantId: () => 't' } as any;
  return {
    calls,
    quotes: new CommercialQuotesService(tk, ctx, scopeSvc),
    pricing: new QuotePricingService(tk, ctx, scopeSvc),
  };
}

describe('Lista y resumen: cada quien ve las cotizaciones de SUS sucursales', () => {
  it('vendedor (own 08): filtra a la 08', async () => {
    const { calls, quotes } = servicios(VENDEDOR_08);
    await quotes.list({});
    expect(calls[0].sql).toContain('q.source_branch = ANY(:scope_branches)');
    expect(calls[0].binds['scope_branches']).toEqual(['08']);
  });

  it('gerente (listed 01, 06): filtra a esas dos', async () => {
    const { calls, quotes } = servicios(GERENTE_01_06);
    await quotes.summary();
    expect(calls[0].binds['scope_branches']).toEqual(['01', '06']);
  });

  it('dirección (all): NO filtra', async () => {
    const { calls, quotes } = servicios(DIRECCION);
    await quotes.list({});
    expect(calls[0].sql).not.toContain('scope_branches');
  });

  it('own sin sucursal en el perfil: ve CERO (fail-closed), no todo', async () => {
    const { calls, quotes } = servicios(SIN_SUCURSAL);
    await quotes.list({});
    expect(calls[0].binds['scope_branches']).toEqual([]);
  });
});

describe('Catálogo, vendedores y precio: una sucursal que no te toca es 403', () => {
  it('el vendedor de Morelia (08) NO puede pedir el catálogo de Padre Hidalgo (01)', async () => {
    const { quotes } = servicios(VENDEDOR_08);
    await expect(quotes.searchCatalog('01', 'kinder')).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('...ni los vendedores ni el precio de la 01', async () => {
    const { quotes, pricing } = servicios(VENDEDOR_08);
    await expect(quotes.listSalespersons('01')).rejects.toBeInstanceOf(ForbiddenException);
    await expect(pricing.previewLine({ branch: '01', sku: '42029', quantity: 1 } as any)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('su propia sucursal sí pasa la compuerta', async () => {
    const { calls, quotes } = servicios(VENDEDOR_08);
    await quotes.listSalespersons('08');
    expect(calls[0].binds['branch']).toBe('08');
  });

  it('dirección puede cualquiera', async () => {
    const { quotes } = servicios(DIRECCION);
    await expect(quotes.listSalespersons('01')).resolves.toEqual([]);
  });
});

describe('Crear: la sucursal es obligatoria y tiene que ser de escritura', () => {
  const base = { contact_name: 'Prospecto', origin: 'telemarketing' as const };

  it('sin sucursal → 400 (antes un prospecto caía en la 01 en silencio)', async () => {
    const { quotes } = servicios(DIRECCION);
    await expect(quotes.create({ ...base })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('el vendedor de la 08 no puede crear en la 01', async () => {
    const { quotes } = servicios(VENDEDOR_08);
    await expect(quotes.create({ ...base, source_branch: '01' })).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('leer no es escribir: ve 01-02-03, crea sólo en 01', async () => {
    const { quotes } = servicios(VE_TRES_EDITA_UNA);
    await expect(quotes.create({ ...base, source_branch: '02' })).rejects.toBeInstanceOf(ForbiddenException);
  });
});

describe('Clientes de mayoreo: sólo las condiciones de sus sucursales', () => {
  it('vendedor 08: el armado filtra las condiciones a la 08', async () => {
    const { calls, quotes } = servicios(VENDEDOR_08);
    await quotes.searchWholesaleCustomers('ortiz');
    expect(calls[0].sql).toContain('v.sucursal = ANY(:scope_branches)');
    expect(calls[0].binds['scope_branches']).toEqual(['08']);
  });

  it('dirección: todas las sucursales del cliente', async () => {
    const { calls, quotes } = servicios(DIRECCION);
    await quotes.searchWholesaleCustomers('ortiz');
    expect(calls[0].sql).not.toContain('scope_branches');
  });
});

describe('myBranches: con qué sucursales cotiza y en cuál arranca', () => {
  it('Alberto (own 08, perfil 08): sólo la 08 y arranca en la 08 — no en la 01', async () => {
    const r = await servicios(VENDEDOR_08, '08').quotes.myBranches();
    expect(r).toMatchObject({ mode: 'own', branches: ['08'], writable: ['08'], default_branch: '08' });
  });

  it('gerente con dos: arranca en la de su perfil si es una de las suyas', async () => {
    const r = await servicios(GERENTE_01_06, '06').quotes.myBranches();
    expect(r.branches).toEqual(['01', '06']);
    expect(r.default_branch).toBe('06');
  });

  it('gerente con dos y sin perfil: NO elige por él (default null)', async () => {
    const r = await servicios(GERENTE_01_06, null).quotes.myBranches();
    expect(r.default_branch).toBeNull();
  });

  it('dirección sin perfil: todas (null) y tiene que elegir — nunca 01 por omisión', async () => {
    const r = await servicios(DIRECCION, null).quotes.myBranches();
    expect(r.branches).toBeNull();
    expect(r.default_branch).toBeNull();
  });

  it('own sin sucursal en el perfil: ninguna, y lo DECLARA (resolvable false)', async () => {
    const r = await servicios(SIN_SUCURSAL, null).quotes.myBranches();
    expect(r).toMatchObject({ branches: [], default_branch: null, resolvable: false });
  });

  it('ve tres y edita una: arranca en la que puede escribir', async () => {
    const r = await servicios(VE_TRES_EDITA_UNA, '02').quotes.myBranches();
    expect(r.writable).toEqual(['01']);
    expect(r.default_branch).toBe('01');
  });
});
