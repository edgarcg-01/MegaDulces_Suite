import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ANY_PERMISSIONS_KEY, PERMISSIONS_KEY, Permission } from '@megadulces/platform-core';
import { NewCustomersKeplerService } from './new-customers-kepler.service';
import { NewCustomersKeplerController, SimilarCustomersController } from './new-customers-kepler.controller';

/**
 * `[MCP.3.8]` Las decisiones del servicio con dobles (sin base): alcance por sucursal, clave que no
 * existe, clave ya ligada a otro (duplicado), ligar sobre la MISMA fila con los datos de Kepler, y
 * el «¿Es este?» del vendedor. Las reglas puras están en new-customers-kepler.engine.spec.ts.
 * Lo que NO prueba: el SQL contra una base real (no hay base de pruebas con escritura aquí).
 */
const T = '00000000-0000-0000-0000-00000000d01c';
const YO = '11111111-1111-1111-1111-111111111111';
const CLI = '33333333-3333-3333-3333-333333333333';

interface Mundo {
  almacenes?: string[] | null;
  cliente?: Record<string, unknown> | null;
  kepler?: Record<string, unknown> | null;
  ligado?: Record<string, unknown> | null;
  bandeja?: Array<Record<string, unknown>>;
  parecidos?: Array<Record<string, unknown>>;
  sucursalVendedor?: Record<string, unknown> | null;
  updateDevuelve?: Array<Record<string, unknown>>;
  updateFalla?: { code: string };
}

function armar(m: Mundo) {
  const llamadas: Array<{ sql: string; params: unknown[] }> = [];
  const raw = vi.fn(async (sql: string, params: unknown[] = []) => {
    llamadas.push({ sql, params });
    if (sql.includes('mcp38:cliente')) return { rows: m.cliente ? [m.cliente] : [] };
    if (sql.includes('mcp38:kepler')) return { rows: m.kepler ? [m.kepler] : [] };
    if (sql.includes('mcp38:ligado')) return { rows: m.ligado ? [m.ligado] : [] };
    if (sql.includes('mcp38:bandeja')) return { rows: m.bandeja ?? [] };
    if (sql.includes('mcp38:parecidos')) return { rows: m.parecidos ?? [] };
    if (sql.includes('mcp38:sucursal-vendedor')) return { rows: m.sucursalVendedor ? [m.sucursalVendedor] : [] };
    if (sql.includes('mcp38:ligar')) {
      if (m.updateFalla) throw m.updateFalla;
      return { rows: m.updateDevuelve ?? [{ id: CLI, name: 'ABARROTES LUPITA SA DE CV', code: 'K02-10281' }] };
    }
    if (sql.includes('mcp38:pendientes')) return { rows: [{ n: 2 }] };
    return { rows: [] };
  });
  const trx = { raw };
  const tk = { run: vi.fn(async (fn: (t: unknown) => unknown) => fn(trx)) };
  const tenantCtx = { get: () => ({ tenantId: T, userId: YO }), requireTenantId: () => T };
  const scope = { warehouseIds: vi.fn(async () => (m.almacenes === undefined ? ['wh-02'] : m.almacenes)) };
  const svc = new NewCustomersKeplerService(tk as any, tenantCtx as any, scope as any);
  const sqlDe = (marca: string) => llamadas.find((l) => l.sql.includes(marca));
  return { svc, llamadas, sqlDe };
}

const CLIENTE_02 = {
  id: CLI, name: 'Abarrotes Lupita', code: 'V-ABC123', erp_customer_code: null, erp_source_branch: null,
  warehouse_id: 'wh-02', branch: '02',
};
const KEPLER = {
  nombre: 'ABARROTES LUPITA SA DE CV', direccion: 'HIDALGO 12', ciudad: 'CENTRO, LA PIEDAD', estado: 'MICHOACAN',
  codigo_postal: '59300', limite_credito: '5000.00', plazo_dias: '15', es_interno: false,
};

describe('NewCustomersKeplerService · ligar con Kepler', () => {
  it('liga la MISMA fila con los datos de Kepler y conserva sus pedidos', async () => {
    const { svc, sqlDe } = armar({ cliente: CLIENTE_02, kepler: KEPLER });
    const r = await svc.link(CLI, ' 10281 ');
    expect(r).toMatchObject({
      id: CLI, name: 'ABARROTES LUPITA SA DE CV', previous_name: 'Abarrotes Lupita',
      code: 'K02-10281', branch: '02', erp_customer_code: '10281', pending_orders: 2,
    });
    const upd = sqlDe('mcp38:ligar')!;
    // UPDATE de la fila existente, nunca INSERT de otra (nada de copias).
    expect(upd.sql).toMatch(/UPDATE commercial\.customers c/);
    expect(upd.sql).not.toMatch(/INSERT/);
    expect(upd.params.slice(0, 5)).toEqual(['02', '10281', 'ABARROTES LUPITA SA DE CV', '5000.00', '15']);
    expect(JSON.parse(upd.params[5] as string)).toEqual({
      street: 'HIDALGO 12', neighborhood: 'CENTRO, LA PIEDAD', state: 'MICHOACAN', zip: '59300', source: 'kepler',
    });
    expect(upd.params).toContain(YO); // updated_by
    // La clave se buscó en el ODS de la sucursal del cliente.
    expect(sqlDe('mcp38:kepler')!.sql).toMatch(/analytics\.v_customer_master/);
    expect(sqlDe('mcp38:kepler')!.params).toEqual(['02', '10281']);
    // El cliente se bloquea mientras se liga.
    expect(sqlDe('mcp38:cliente')!.sql).toMatch(/FOR UPDATE OF c/);
  });

  it('clave que no existe en Kepler: no liga y lo dice', async () => {
    const { svc, sqlDe } = armar({ cliente: CLIENTE_02, kepler: null });
    await expect(svc.link(CLI, '99999')).rejects.toThrow(/no existe en Kepler de la sucursal 02/);
    expect(sqlDe('mcp38:ligar')).toBeUndefined();
  });

  it('clave ya ligada a OTRO cliente: 409 duplicado con su nombre, sin escribir', async () => {
    const { svc, sqlDe } = armar({ cliente: CLIENTE_02, kepler: KEPLER, ligado: { id: 'otro', name: 'LUPITA (ruta Kepler)' } });
    const e = await svc.link(CLI, '10281').catch((x) => x);
    expect(e).toBeInstanceOf(ConflictException);
    expect(e.message).toContain('LUPITA (ruta Kepler)');
    expect(sqlDe('mcp38:ligar')).toBeUndefined();
  });

  it('cliente de otra sucursal: 404 y ni siquiera se consulta Kepler', async () => {
    const { svc, sqlDe } = armar({ cliente: { ...CLIENTE_02, warehouse_id: 'wh-04', branch: '04' }, kepler: KEPLER });
    await expect(svc.link(CLI, '10281')).rejects.toBeInstanceOf(NotFoundException);
    expect(sqlDe('mcp38:kepler')).toBeUndefined();
    expect(sqlDe('mcp38:ligar')).toBeUndefined();
  });

  it('con alcance de todas las sucursales sí puede ligar uno de cualquier sucursal', async () => {
    const { svc } = armar({ almacenes: null, cliente: { ...CLIENTE_02, warehouse_id: 'wh-04', branch: '04' }, kepler: KEPLER });
    await expect(svc.link(CLI, '10281')).resolves.toMatchObject({ branch: '04' });
  });

  it('sin sucursal asignada no se liga nada', async () => {
    const { svc } = armar({ almacenes: [], cliente: CLIENTE_02, kepler: KEPLER });
    await expect(svc.link(CLI, '10281')).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('cuenta interna de Kepler: no liga', async () => {
    const { svc } = armar({ cliente: CLIENTE_02, kepler: { ...KEPLER, es_interno: true } });
    await expect(svc.link(CLI, '10-00')).rejects.toBeInstanceOf(BadRequestException);
  });

  it('carrera: el índice único decide y se reporta como duplicado', async () => {
    const { svc } = armar({ cliente: CLIENTE_02, kepler: KEPLER, updateFalla: { code: '23505' } });
    await expect(svc.link(CLI, '10281')).rejects.toThrow(/ya está ligada a otro cliente/);
  });

  it('carrera: otra persona lo ligó entre la lectura y la escritura', async () => {
    const { svc } = armar({ cliente: CLIENTE_02, kepler: KEPLER, updateDevuelve: [] });
    await expect(svc.link(CLI, '10281')).rejects.toThrow(/Alguien más acaba de ligar/);
  });
});

describe('NewCustomersKeplerService · buscar la clave (confirmar antes de ligar)', () => {
  it('existe: muestra el nombre que tiene en Kepler', async () => {
    const { svc } = armar({ cliente: CLIENTE_02, kepler: KEPLER });
    await expect(svc.lookup(CLI, '10281')).resolves.toMatchObject({
      branch: '02', code: '10281', found: true, name: 'ABARROTES LUPITA SA DE CV', internal: false, linked_to: null,
    });
  });

  it('no existe: lo dice como dato, no como error', async () => {
    const { svc } = armar({ cliente: CLIENTE_02, kepler: null });
    await expect(svc.lookup(CLI, '99999')).resolves.toMatchObject({ found: false, name: null });
  });

  it('ya ligada a otro: avisa con quién', async () => {
    const { svc } = armar({ cliente: CLIENTE_02, kepler: KEPLER, ligado: { id: 'otro', name: 'LUPITA' } });
    await expect(svc.lookup(CLI, '10281')).resolves.toMatchObject({ found: true, linked_to: { id: 'otro', name: 'LUPITA' } });
  });

  it('id que no es uuid', async () => {
    const { svc } = armar({});
    await expect(svc.lookup('x', '1')).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('NewCustomersKeplerService · bandeja y aviso', () => {
  const fila = {
    id: CLI, name: 'Abarrotes Lupita', phone: '3521112233', notes: 'frente a la iglesia', shipping_address: null,
    sales_route: 'R-02', created_at: '2026-10-20T15:00:00.000Z', created_by_name: 'Ana López',
    warehouse_id: 'wh-02', warehouse_name: 'La Piedad Abastos', branch: '02',
    orders: [{ order_id: 'o1', code: 'PD-1', status: 'confirmed', total: '1219.26', requested_delivery_date: '2026-10-21' }],
  };

  it('filtra por las sucursales del alcance y convierte el dinero a número', async () => {
    const { svc, sqlDe } = armar({ bandeja: [fila] });
    const r = await svc.inbox();
    expect(r.scope).toBe('propios');
    expect(sqlDe('mcp38:bandeja')!.params).toEqual([['wh-02']]);
    expect(sqlDe('mcp38:bandeja')!.sql).toMatch(/erp_customer_code IS NULL/);
    expect(r.data[0]).toMatchObject({ address: 'frente a la iglesia', created_by_name: 'Ana López', branch: '02' });
    expect(r.data[0].orders[0].total).toBe(1219.26);
  });

  it('alcance de todas: sin filtro de sucursal', async () => {
    const { svc, sqlDe } = armar({ almacenes: null, bandeja: [] });
    const r = await svc.inbox();
    expect(r.scope).toBe('todos');
    expect(sqlDe('mcp38:bandeja')!.params).toEqual([]);
    expect(sqlDe('mcp38:bandeja')!.sql).not.toMatch(/ANY\(\?\)/);
  });

  it('sin sucursal asignada: «ninguno», sin consultar', async () => {
    const { svc, sqlDe } = armar({ almacenes: [] });
    await expect(svc.inbox()).resolves.toEqual({ scope: 'ninguno', data: [], truncated: false });
    expect(sqlDe('mcp38:bandeja')).toBeUndefined();
  });

  it('el aviso cuenta clientes y junta los pedidos sin clave', async () => {
    const { svc } = armar({ bandeja: [fila, { ...fila, id: 'c2', orders: null }] });
    await expect(svc.summary()).resolves.toEqual({ scope: 'propios', customers: 2, order_ids: ['o1'] });
  });

  it('si la lista se topa, lo declara', async () => {
    const muchas = Array.from({ length: 501 }, (_, i) => ({ ...fila, id: `c${i}`, orders: [] }));
    const { svc } = armar({ bandeja: muchas });
    const r = await svc.inbox();
    expect(r.truncated).toBe(true);
    expect(r.data).toHaveLength(500);
  });
});

describe('NewCustomersKeplerService · «¿Es este?» del vendedor', () => {
  it('busca en la sucursal del vendedor y devuelve sólo los parecidos', async () => {
    const { svc, sqlDe } = armar({
      sucursalVendedor: { id: 'wh-02', name: 'La Piedad Abastos', branch: '02' },
      parecidos: [
        { id: 'a', name: 'Tienda Lupita', phone: null, notes: 'Hidalgo 3', shipping_address: null, sales_route: 'R-02', kepler: false },
        { id: 'b', name: 'Lupe Ramírez', phone: null, notes: null, shipping_address: null, sales_route: null, kepler: true },
      ],
    });
    const r = await svc.similar('Abarrotes Lupita');
    expect(r).toMatchObject({ scope: 'sucursal', warehouse_name: 'La Piedad Abastos' });
    expect(r.matches.map((x) => x.id)).toEqual(['a']);
    expect(r.matches[0]).toMatchObject({ address: 'Hidalgo 3', score: 1 });
    const q = sqlDe('mcp38:parecidos')!;
    expect(q.params).toEqual(['%lupi%', 'wh-02', '02']);
  });

  it('sin sucursal conocida busca en todo el catálogo y lo declara', async () => {
    const { svc, sqlDe } = armar({ sucursalVendedor: null, parecidos: [] });
    const r = await svc.similar('Lupita');
    expect(r.scope).toBe('todas');
    expect(sqlDe('mcp38:parecidos')!.params).toEqual(['%lupi%']);
  });

  it('un nombre sólo con palabras genéricas no busca', async () => {
    const { svc, sqlDe } = armar({ sucursalVendedor: { id: 'wh-02', name: 'X', branch: '02' } });
    await expect(svc.similar('Abarrotes')).resolves.toMatchObject({ matches: [] });
    expect(sqlDe('mcp38:parecidos')).toBeUndefined();
  });
});

describe('Permisos de los endpoints', () => {
  const r = new Reflector();
  const meta = (key: string, target: object, metodo: string): string[] | undefined =>
    r.get<string[]>(key, (target as Record<string, (...a: unknown[]) => unknown>)[metodo]);
  const perms = (t: object, m: string) => meta(PERMISSIONS_KEY, t, m);
  const alguno = (t: object, m: string) => meta(ANY_PERMISSIONS_KEY, t, m);
  it('ver = surtido (VER o GESTIONAR), ligar = sólo GESTIONAR, «¿Es este?» = COMMERCIAL_CARTERA_VER', () => {
    const p = NewCustomersKeplerController.prototype;
    const s = SimilarCustomersController.prototype;
    const ver = [Permission.COMMERCIAL_PICKING_VER, Permission.COMMERCIAL_PICKING_GESTIONAR];
    expect(alguno(p, 'inbox')).toEqual(ver);
    expect(alguno(p, 'summary')).toEqual(ver);
    expect(alguno(p, 'lookup')).toEqual(ver);
    // Ligar escribe: con sólo VER no se liga.
    expect(perms(p, 'link')).toEqual([Permission.COMMERCIAL_PICKING_GESTIONAR]);
    expect(alguno(p, 'link')).toBeUndefined();
    expect(perms(s, 'similar')).toEqual([Permission.COMMERCIAL_CARTERA_VER]);
  });
});
