/**
 * `[MCP.3.13]` Pedido agrupado: cobro con la clave del cliente EN la sucursal de la parte, reparto
 * (el repartidor recoge las partes de su grupo, juntas) y liquidación en UNA caja.
 *
 * Lo que es regla se prueba en el motor puro. Lo que es consulta (`leerPedidos`) se prueba con un
 * doble de knex que ANOTA el SQL y devuelve filas fijas: se afirma la forma de la consulta (cláusula
 * del alcance y que cada `?` tenga su valor) y lo que el servicio hace con las filas.
 * ⚠️ NO MEDIDO contra Postgres: el SQL no se ejecuta aquí (no hay base en este runner).
 */
import { PresaleControlService } from './presale-control.service';
import {
  bloqueoDeLiga,
  bloqueoSucursalesLiquidacion,
  claveDelPedido,
  completarGrupos,
  decidirClaveSucursal,
  normalizarClaveKepler,
  porSucursalLiquidacion,
  sucursalDeLiquidacion,
  type HechosClaveSucursal,
  type ParteDeGrupo,
} from './presale-control.engine';

describe('[MCP.3.13] claveDelPedido: la clave del cliente en la sucursal del pedido', () => {
  const cliente = { customer_code: '10465', customer_branch: '01', branch_key_code: null };

  it('con clave ligada para la sucursal del pedido, se usa ésa y el bloqueo de otra sucursal no aplica', () => {
    const k = claveDelPedido({ ...cliente, branch_key_code: '00777' }, '05');
    expect(k).toEqual({ code: '00777', branch: '05', de_sucursal: true });
    expect(bloqueoDeLiga({ customer_erp_code: k.code, customer_erp_branch: k.branch, branch: '05', branch_has_documents: true })).toBeNull();
  });

  it('negativa: sin clave ligada, la de origen sigue bloqueada en otra sucursal', () => {
    const k = claveDelPedido(cliente, '05');
    expect(k).toEqual({ code: '10465', branch: '01', de_sucursal: false });
    expect(bloqueoDeLiga({ customer_erp_code: k.code, customer_erp_branch: k.branch, branch: '05', branch_has_documents: true }))
      .toBe('cliente_de_otra_sucursal');
  });

  it('una clave ligada vacía (o sólo ceros) no cuenta', () => {
    expect(claveDelPedido({ ...cliente, branch_key_code: '000' }, '05').de_sucursal).toBe(false);
    expect(claveDelPedido({ ...cliente, branch_key_code: '777' }, null).de_sucursal).toBe(false);
  });
});

describe('[MCP.3.13] decidirClaveSucursal', () => {
  const base: HechosClaveSucursal = {
    branch: '05',
    branch_has_documents: true,
    customer: { erp_customer_code: '10465', erp_source_branch: '01' },
    customer_has_order_in_branch: true,
    code: '777',
    en_catalogo: { cliente_code: '00777', nombre: 'ABARROTES LUPITA' },
    sucursal_con_catalogo: true,
    en_tickets: false,
    otro_cliente: null,
  };

  it('en el catálogo de esa sucursal: se liga con la clave como la escribe Kepler', () => {
    expect(decidirClaveSucursal(base)).toEqual({ ok: true, code: '00777', verified_by: 'catalogo', kepler_name: 'ABARROTES LUPITA', warning: null });
  });
  it('fuera del catálogo pero con tickets en esa sucursal: se liga, verificada por tickets', () => {
    const d = decidirClaveSucursal({ ...base, en_catalogo: null, en_tickets: true });
    expect(d).toMatchObject({ ok: true, code: '777', verified_by: 'tickets' });
  });
  it('sucursal sin catálogo publicado: se liga SIN verificar y se declara', () => {
    const d = decidirClaveSucursal({ ...base, en_catalogo: null, sucursal_con_catalogo: false });
    expect(d).toMatchObject({ ok: true, verified_by: null });
    expect(d.ok && d.warning).toMatch(/No se pudo verificar/);
  });
  it('negativa: la clave no existe en ese Kepler (con catálogo publicado) → 400, no se liga', () => {
    expect(decidirClaveSucursal({ ...base, en_catalogo: null })).toMatchObject({ ok: false, status: 400 });
  });
  it('negativa: clave de otro cliente, sucursal de origen, sin pedido o sin tickets → no se liga', () => {
    expect(decidirClaveSucursal({ ...base, otro_cliente: 'OTRA PERSONA' })).toMatchObject({ ok: false, status: 409 });
    expect(decidirClaveSucursal({ ...base, branch: '01' })).toMatchObject({ ok: false, status: 409 });
    expect(decidirClaveSucursal({ ...base, customer_has_order_in_branch: false })).toMatchObject({ ok: false, status: 404 });
    expect(decidirClaveSucursal({ ...base, branch_has_documents: false })).toMatchObject({ ok: false, status: 409 });
    expect(decidirClaveSucursal({ ...base, customer: { erp_customer_code: null, erp_source_branch: null } })).toMatchObject({ ok: false, status: 409 });
    expect(decidirClaveSucursal({ ...base, branch: '5' })).toMatchObject({ ok: false, status: 400 });
    expect(decidirClaveSucursal({ ...base, code: null })).toMatchObject({ ok: false, status: 400 });
  });
  it('normaliza la clave tecleada; lo que no tiene forma de clave no pasa', () => {
    expect(normalizarClaveKepler(' 00777 ')).toBe('00777');
    expect(normalizarClaveKepler('k-12')).toBe('K-12');
    expect(normalizarClaveKepler('10 465')).toBeNull();
    expect(normalizarClaveKepler('')).toBeNull();
  });
});

describe('[MCP.3.13] completarGrupos: las partes se cargan juntas', () => {
  const parte = (id: string, extra: Partial<ParteDeGrupo> = {}): ParteDeGrupo => ({
    id, code: 'PD-' + id, group_id: 'G1', group_code: 'PD-1', visible: true, cargada_por_mi: null, cargada_por: null, ...extra,
  });

  it('elige una parte: se suman las demás que ve y no lleva', () => {
    const r = completarGrupos(['1'], [parte('1'), parte('2'), parte('3')]);
    expect(r.error).toBeNull();
    expect(r.ids).toEqual(['1', '2', '3']);
    expect(r.agregados).toEqual(['2', '3']);
  });
  it('una parte que ya lleva él en otra guía no se vuelve a cargar', () => {
    const r = completarGrupos(['1'], [parte('1'), parte('2', { cargada_por_mi: true })]);
    expect(r).toEqual({ ids: ['1'], agregados: [], error: null });
  });
  it('negativa: una parte la lleva otra persona → rechazo con su nombre', () => {
    const r = completarGrupos(['1'], [parte('1'), parte('2', { cargada_por_mi: false, cargada_por: 'Juan' })]);
    expect(r.error).toMatch(/PD-2 del pedido PD-1 ya la lleva Juan/);
  });
  it('negativa: una parte que no le toca (el principal es de otra sucursal) → rechazo, no carga a medias', () => {
    const r = completarGrupos(['2'], [parte('1', { visible: false }), parte('2')]);
    expect(r.error).toMatch(/no te toca/);
  });
  it('lo que no es de un grupo pasa tal cual', () => {
    expect(completarGrupos(['9'], [parte('1'), parte('2')])).toEqual({ ids: ['9'], agregados: [], error: null });
  });
});

describe('[MCP.3.13] liquidación en una sola caja', () => {
  const parte = (order_id: string, main: string | null) => ({ order_id, group_id: 'G1', group_main_branch: main });

  it('guía de recolección: todas partes de un grupo de 01 → se liquida en 01', () => {
    expect(sucursalDeLiquidacion({ branch: '05', orders: [parte('a', '01'), parte('b', '01')] })).toBe('01');
  });
  it('negativa: con UN pedido propio de la sucursal, o el principal mismo, es de su sucursal', () => {
    expect(sucursalDeLiquidacion({ branch: '05', orders: [parte('a', '01'), { order_id: 'x', group_id: null }] })).toBe('05');
    expect(sucursalDeLiquidacion({ branch: '05', orders: [{ order_id: 'G1', group_id: 'G1', group_main_branch: '05' }] })).toBe('05');
    expect(sucursalDeLiquidacion({ branch: '05', orders: [parte('a', '01'), parte('b', '02')] })).toBe('05');
    expect(sucursalDeLiquidacion({ branch: '05', orders: [] })).toBe('05');
  });

  it('la caja de 01 junta su guía con la de recolección de 05', () => {
    const guias = [
      { folio: 'GDC-1', branch: '01', liquidation_branch: '01' },
      { folio: 'GDC-2', branch: '05', liquidation_branch: '01' },
    ];
    expect(bloqueoSucursalesLiquidacion(guias, ['01'])).toBeNull();
    expect(bloqueoSucursalesLiquidacion(guias, null)).toBeNull();
  });
  it('negativa: cualquier otra mezcla se sigue bloqueando', () => {
    const mezcla = [
      { folio: 'GDC-1', branch: '01', liquidation_branch: '01' },
      { folio: 'GDC-3', branch: '05', liquidation_branch: '05' },
    ];
    expect(bloqueoSucursalesLiquidacion(mezcla, ['01', '05'])).toMatch(/distintas sucursales/);
  });
  it('negativa: la caja de 05 no liquida la recolección de un grupo de 01', () => {
    const r = bloqueoSucursalesLiquidacion([{ folio: 'GDC-2', branch: '05', liquidation_branch: '01' }], ['05']);
    expect(r).toMatch(/GDC-2 se liquida en la caja de la sucursal 01/);
  });

  it('by_branch: lo cobrado en el Kepler de cada sucursal, la de la caja primero; sin total se declara', () => {
    const r = porSucursalLiquidacion(
      [
        { branch: '05', orders: [{ status: 'entregado', document_total: 300, cash_amount: 300, transfer_amount: 0 }] },
        {
          branch: '01',
          orders: [
            { status: 'entregado', document_total: 1000.5, cash_amount: 500, transfer_amount: 500.5 },
            { status: 'entregado', document_total: null, cash_amount: 20, transfer_amount: 0 },
            { status: 'no_entregado', document_total: 99, cash_amount: null, transfer_amount: null },
          ],
        },
        { branch: '05', orders: [{ status: 'entregado', document_total: 200, cash_amount: 200, transfer_amount: 0 }] },
      ],
      '01',
    );
    expect(r).toEqual([
      { branch: '01', documents_total: 1000.5, documents_without_total: 1, delivered: 2, declared_cash: 520, declared_transfer: 500.5 },
      { branch: '05', documents_total: 500, documents_without_total: 0, delivered: 2, declared_cash: 500, declared_transfer: 0 },
    ]);
  });
});

// ─────────────────────────────────────────── servicio con doble de knex ──

type Llamada = { sql: string; params: unknown[] };

/** Doble de `trx` que anota cada `raw` y devuelve filas según la consulta. */
function trxDoble(pedidos: Record<string, unknown>[], llamadas: Llamada[]) {
  return {
    raw: async (sql: string, params: unknown[] = []) => {
      llamadas.push({ sql, params });
      if (sql.includes('FROM commercial.orders o') && sql.includes('LIMIT ?')) return { rows: pedidos };
      // `sucursalesConDocumentos`: todas publican tickets.
      if (sql.includes('FROM analytics.erp_sale_tickets') && sql.includes('LIMIT 1')) return { rows: [{ '?column?': 1 }] };
      return { rows: [] };
    },
  };
}

function servicio() {
  return new PresaleControlService(
    {} as never,
    { requireTenantId: () => '00000000-0000-0000-0000-00000000d01c', get: () => ({ userId: 'u1' }) } as never,
    {} as never,
  );
}

const fila = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'p-05', code: 'PD-2', status: 'confirmed', customer_id: 'c1', warehouse_id: 'w05', total: '300',
  created_at: '2026-10-23T15:00:00Z', created_date: '2026-10-23', requested_delivery_date: '2026-10-24',
  customer_name: 'ABARROTES LUPITA', erp_customer_code: '10465', erp_source_branch: '01', sales_route: 'R1',
  warehouse_name: 'Zamora', branch: '05', seller_name: 'Vendedor', lines: 3,
  wave_stage: null, pick_state: null, link_folio: null, guide_id: null, delivered_at: null, failed_attempts: 0,
  branch_key_code: null,
  group_id: 'p-01', group_code: 'PD-1', group_main_branch: '01', group_parts: 2, group_branches: ['05', '01', null],
  ...extra,
});

describe('[MCP.3.13] PresaleControlService.pedidosParaGuias (doble de knex)', () => {
  it('el alcance del repartidor suma las partes cuyo principal es de su sucursal, con un valor por cada ?', async () => {
    const llamadas: Llamada[] = [];
    await servicio().pedidosParaGuias(trxDoble([], llamadas) as never, { almacenes: ['01'], soloAbiertos: true, conPartesDeGrupo: true });
    const q = llamadas.find((l) => l.sql.includes('FROM commercial.orders o'));
    expect(q).toBeDefined();
    expect(q!.sql).toMatch(/o\.group_id <> o\.id AND EXISTS \(/);
    expect(q!.sql).toContain('gm.id = o.group_id');
    expect((q!.sql.match(/\?/g) ?? []).length).toBe(q!.params.length);
    expect(q!.params.filter((p) => Array.isArray(p) && p[0] === '01').length).toBe(4);
  });

  it('negativa: sin conPartesDeGrupo (la mesa) el alcance NO suma partes de otra sucursal', async () => {
    const llamadas: Llamada[] = [];
    await servicio().pedidosParaGuias(trxDoble([], llamadas) as never, { almacenes: ['01'], soloAbiertos: true });
    const q = llamadas.find((l) => l.sql.includes('FROM commercial.orders o'))!;
    expect(q.sql).not.toContain('gm.id = o.group_id');
    expect((q.sql.match(/\?/g) ?? []).length).toBe(q.params.length);
  });

  it('la parte de 05 sin clave ligada: bloqueada como cliente de otra sucursal, con su grupo', async () => {
    const [p] = await servicio().pedidosParaGuias(trxDoble([fila()], []) as never, { almacenes: null });
    expect(p.link_block).toBe('cliente_de_otra_sucursal');
    expect(p.customer_key_from_branch).toBe(false);
    expect(p).toMatchObject({ group_id: 'p-01', group_code: 'PD-1', group_main_branch: '01', group_parts: 2, group_branches: ['01', '05'] });
  });

  it('con la clave ligada en 05: se cobra con ésa y ya no se bloquea', async () => {
    const llamadas: Llamada[] = [];
    const [p] = await servicio().pedidosParaGuias(trxDoble([fila({ branch_key_code: '00777' })], llamadas) as never, { almacenes: null });
    expect(p.link_block).toBeNull();
    expect(p.customer_erp_code).toBe('777');
    expect(p.customer_key_from_branch).toBe(true);
    // Los documentos posibles se buscan en 05 con la clave de 05, no con la de origen.
    const posibles = llamadas.find((l) => l.sql.includes('ANY(?::text[])') && l.sql.includes('erp_sale_tickets t'));
    expect(posibles?.params).toContainEqual(['777']);
    expect(posibles?.params).toContain('05');
  });

  it('un pedido suelto no trae grupo', async () => {
    const [p] = await servicio().pedidosParaGuias(
      trxDoble([fila({ group_id: null, group_code: null, group_main_branch: null, group_parts: null, group_branches: null, branch: '01' })], []) as never,
      { almacenes: null },
    );
    expect(p).toMatchObject({ group_id: null, group_code: null, group_parts: null, group_branches: null, link_block: null });
  });
});
