import { CommercialOrdersService } from './commercial-orders.service';

/**
 * `[MCP.3.16]` El BLOQUEO al agregar un producto que la sucursal de surtido no tiene, en el servicio
 * real del pedido y con el resolvedor REAL (`commercial-inventory/stock-state.ts`). La base es un
 * doble que contesta las preguntas que hacen los dos (pedido, rol, frescura, existencia canónica,
 * gemelos); el motor de precios se sustituye por un centinela: «llegó a tarificar» = pasó el
 * bloqueo.
 *
 * Cada caso que bloquea tiene su negativa (el vecino que NO debe bloquear).
 */
const LISTA = 'lista-base';
const PH = 'aaaaaaaa-0000-4000-8000-000000000001', LPA = 'aaaaaaaa-0000-4000-8000-000000000002', ES8 = 'aaaaaaaa-0000-4000-8000-000000000003';
const WHS = [
  { id: PH, code: '01', short_label: 'PH', name: 'Padre Hidalgo', purchase_zone: 'La Piedad', kind: 'central', active: true },
  { id: LPA, code: '02', short_label: 'LPA', name: 'La Piedad Abastos', purchase_zone: 'La Piedad', kind: 'central', active: true },
  { id: ES8, code: '03', short_label: '8ES', name: '8 Esquinas', purchase_zone: 'La Piedad', kind: 'central', active: true },
];
const PROD = '11111111-1111-4111-8111-111111111111';
const LEGADO = '22222222-2222-4222-8222-222222222222';
const VIVO = '33333333-3333-4333-8333-333333333333';
const ORDER = '44444444-4444-4444-8444-444444444444';
const LINE = '55555555-5555-4555-8555-555555555555';
const NOMBRES: Record<string, string> = { [PROD]: 'PULPARINDO 20 PZ', [LEGADO]: 'LA ROSA MAZAPAN', [VIVO]: 'LA ROSA MAZAPAN' };

interface Mundo {
  rol: string;
  /** Roles con VENDOR_APP_ACCESS = true. */
  conClave?: string[];
  /** `${warehouse}|${product}` → qty (sin llave = sin registro). */
  existencia?: Record<string, number>;
  /** Claves de sucursal con lectura al día. */
  alDia?: string[];
  /** Renglones que ya tiene el pedido. */
  lineas?: Array<{ id: string; order_id: string; product_id: string; source_warehouse_id: string | null; quantity: number }>;
  /** El legado tiene gemelo con precio en la lista (si el servicio volviera a preguntarlo, contestaría el gemelo). */
  gemeloConPrecio?: boolean;
}

function montar(m: Mundo) {
  const raws: string[] = [];
  const insertados: Array<Record<string, unknown>> = [];
  const raw = async (sql: string, b: unknown[] = []) => {
    raws.push(sql);
    if (sql.includes('FOR UPDATE')) return { rows: [] };
    if (sql.includes('identity.role_permissions')) return { rows: (m.conClave ?? ['vendedor_ruta']).includes(String(b[0])) ? [{ '?column?': 1 }] : [] };
    if (sql.includes('pp.price_list_id = ?')) return { rows: m.gemeloConPrecio && b[1] === LEGADO ? [{ id: VIVO }] : [] };
    if (sql.includes('analytics.ods_branch_checks')) {
      const codes = b[2] as string[];
      return { rows: (m.alDia ?? ['01', '02', '03']).filter((c) => codes.includes(c)).map((sucursal) => ({ sucursal, last_check_at: '2026-10-27T19:00:00Z', last_error: null, al_dia: true })) };
    }
    if (sql.includes('to_regclass')) return { rows: [{ ok: true }] };
    if (sql.includes('analytics.v_erp_stock_on_hand')) {
      const whs = b[0] as string[]; const prods = b[1] as string[];
      return {
        rows: Object.entries(m.existencia ?? {}).map(([k, qty]) => { const [warehouse_id, product_id] = k.split('|'); return { warehouse_id, product_id, qty }; })
          .filter((r) => whs.includes(r.warehouse_id) && prods.includes(r.product_id)),
      };
    }
    if (sql.includes('catalog.products')) {
      const ids = b[0] as string[];
      return { rows: ids.map((id) => ({ id, con_sku: id !== LEGADO, twin_id: id === LEGADO ? VIVO : null })) };
    }
    return { rows: [] };
  };
  const tabla = (nombre: string) => {
    const filtros: Record<string, unknown>[] = [];
    let enIds: string[] | null = null;
    const q: Record<string, unknown> = {};
    const fuera: string[] = [];
    let origen: { v: string | null } | null = null;
    for (const k of ['whereNull', 'select', 'orderBy', 'forUpdate', 'returning', 'andWhere']) q[k] = () => q;
    q['where'] = (o: Record<string, unknown>) => { if (o && typeof o === 'object') filtros.push(o); return q; };
    q['whereNot'] = (_c: string, id: string) => { fuera.push(id); return q; };
    q['whereRaw'] = (sql: string, b?: unknown[]) => {
      if (sql.includes('source_warehouse_id IS NOT DISTINCT FROM')) origen = { v: (b?.[0] as string | null) ?? null };
      return q;
    };
    q['whereIn'] = (_c: string, ids: string[]) => { enIds = ids; return q; };
    q['del'] = async () => 0;
    q['insert'] = (fila: Record<string, unknown>) => { insertados.push(fila); return q; };
    const filas = (): unknown[] => {
      const casa = (o: Record<string, unknown>) => filtros.every((f) => Object.entries(f).every(([k, v]) => o[k] === v));
      if (nombre === 'commercial.orders') return [{ id: ORDER, code: 'PED-1', status: 'draft', warehouse_id: LPA, price_list_id: LISTA, customer_id: 'cli-1' }];
      if (nombre === 'commercial.warehouses') return WHS.filter((w) => (!enIds || enIds.includes(w.id)) && casa(w as unknown as Record<string, unknown>));
      if (nombre === 'catalog.products') return (enIds ?? []).map((id) => ({ id, nombre: NOMBRES[id] ?? null }));
      if (nombre === 'commercial.order_lines') {
        return (m.lineas ?? []).filter((l) => casa(l as unknown as Record<string, unknown>)
          && !fuera.includes(l.id) && (!origen || l.source_warehouse_id === origen.v));
      }
      return [];
    };
    q['first'] = async () => filas()[0];
    q['then'] = (ok: (v: unknown) => unknown, ko?: (e: unknown) => unknown) => Promise.resolve(filas()).then(ok, ko);
    return q;
  };
  const trx: any = Object.assign(tabla, { raw, transaction: async (cb: (sp: unknown) => unknown) => cb({ raw }) });
  const tk = { run: (cb: (t: unknown) => unknown) => cb(trx) };
  const tenantCtx = { get: () => ({ tenantId: 't', userId: 'u', roleName: m.rol }), requireTenantId: () => 't' };
  const svc = new CommercialOrdersService(tk as never, tenantCtx as never, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never);
  const s = svc as unknown as Record<string, (...a: unknown[]) => unknown>;
  const tarifa = vi.spyOn(s, 'tarificarConMotor' as never).mockRejectedValue(new Error('PASO') as never);
  vi.spyOn(s, 'resolveCustomerIdFromUser' as never).mockResolvedValue('cli-1' as never);
  return { svc, tarifa, raws, insertados, s };
}

/** El error que lanzó, o null. */
const falla = async (p: Promise<unknown>): Promise<{ status?: number; body?: unknown; message?: string } | null> => {
  try { await p; return null; } catch (e) {
    const x = e as { getStatus?: () => number; getResponse?: () => unknown; message?: string };
    return { status: x.getStatus?.(), body: x.getResponse?.(), message: x.message };
  }
};
const PASO = { message: 'PASO' };

describe('[MCP.3.16] bloqueo al agregar · addLine', () => {
  it('⭐ agotado en su sucursal con otras de la zona que sí tienen: 409 con el cuerpo exacto', async () => {
    const { svc } = montar({ rol: 'vendedor_ruta', existencia: { [`${LPA}|${PROD}`]: 0, [`${PH}|${PROD}`]: 14, [`${ES8}|${PROD}`]: 1328 } });
    const r = await falla(svc.addLine(ORDER, { product_id: PROD, quantity: 2 }));
    expect(r?.status).toBe(409);
    expect(r?.body).toEqual({
      code: 'SIN_EXISTENCIA',
      message: 'No se puede agregar: no hay existencias en LPA · 8ES tiene 1,328 · PH tiene 14',
      product_id: PROD,
      product_name: 'PULPARINDO 20 PZ',
      warehouse_id: LPA,
      warehouse_short: 'LPA',
      state: 'agotado',
      alternatives: [{ warehouse_id: ES8, short: '8ES', qty: 1328 }, { warehouse_id: PH, short: 'PH', qty: 14 }],
    });
  });

  it('⭐ no se maneja y nadie de la zona tiene: «no hay en tu zona», sin alternativas', async () => {
    const { svc } = montar({ rol: 'vendedor_ruta', existencia: { [`${PH}|${PROD}`]: 0 } });
    const r = await falla(svc.addLine(ORDER, { product_id: PROD, quantity: 1 }));
    expect(r?.status).toBe(409);
    expect(r?.body).toMatchObject({
      state: 'no_se_maneja', alternatives: [], product_name: 'PULPARINDO 20 PZ',
      message: 'No se puede agregar un producto que no hay en tu zona',
    });
    // El mensaje nunca lleva el uuid.
    expect(JSON.stringify((r?.body as { message: string }).message)).not.toContain(PROD);
  });

  it('⭐ ADR-056: con otra sucursal de la zona SIN DATO no se afirma «no hay en tu zona»; se nombra la que falta', async () => {
    // LPA (la del pedido) al día y en 0; PH al día sin registro; 8ES con la lectura vieja.
    const { svc } = montar({ rol: 'vendedor_ruta', alDia: ['01', '02'], existencia: { [`${LPA}|${PROD}`]: 0, [`${ES8}|${PROD}`]: 50 } });
    const r = await falla(svc.addLine(ORDER, { product_id: PROD, quantity: 1 }));
    expect(r?.status).toBe(409);
    expect(r?.body).toMatchObject({ state: 'agotado', alternatives: [], message: 'No se puede agregar: no hay existencias en LPA · sin dato de 8ES' });
    expect((r?.body as { message: string }).message).not.toContain('tu zona');
  });

  it('⭐ ADR-056: sin zona resuelta (la sucursal no tiene purchase_zone) tampoco se afirma «no hay en tu zona»', async () => {
    const lpa = WHS.find((w) => w.id === LPA)!;
    const zonaOriginal = lpa.purchase_zone;
    lpa.purchase_zone = null as unknown as string;
    try {
      const { svc } = montar({ rol: 'vendedor_ruta', existencia: { [`${LPA}|${PROD}`]: 0 } });
      const r = await falla(svc.addLine(ORDER, { product_id: PROD, quantity: 1 }));
      expect(r?.body).toMatchObject({ state: 'agotado', alternatives: [], message: 'No se puede agregar: no hay existencias en LPA' });
    } finally {
      lpa.purchase_zone = zonaOriginal;
    }
  });

  it('negativa: sin_dato (lectura de su sucursal vieja) NO bloquea', async () => {
    const { svc } = montar({ rol: 'vendedor_ruta', alDia: ['01', '03'], existencia: { [`${LPA}|${PROD}`]: 0 } });
    expect(await falla(svc.addLine(ORDER, { product_id: PROD, quantity: 1 }))).toMatchObject(PASO);
  });

  it('negativa: pedir más de lo que hay (pero hay > 0) NO bloquea', async () => {
    const { svc } = montar({ rol: 'vendedor_ruta', existencia: { [`${LPA}|${PROD}`]: 2 } });
    expect(await falla(svc.addLine(ORDER, { product_id: PROD, quantity: 50 }))).toMatchObject(PASO);
  });

  it('negativa: el portal del cliente (customer_b2b) NO se bloquea, aunque esté agotado', async () => {
    const { svc, raws } = montar({ rol: 'customer_b2b', conClave: ['customer_b2b'], existencia: { [`${LPA}|${PROD}`]: 0 } });
    expect(await falla(svc.addLine(ORDER, { product_id: PROD, quantity: 1 }))).toMatchObject(PASO);
    expect(raws.some((s) => s.includes('v_erp_stock_on_hand'))).toBe(false);
  });

  it('negativa: televenta (rol sin VENDOR_APP_ACCESS) y el superadmin NO se bloquean', async () => {
    for (const rol of ['telemarketing', 'superadmin']) {
      const { svc, raws } = montar({ rol, existencia: { [`${LPA}|${PROD}`]: 0 } });
      expect(await falla(svc.addLine(ORDER, { product_id: PROD, quantity: 1 }))).toMatchObject(PASO);
      expect(raws.some((s) => s.includes('v_erp_stock_on_hand'))).toBe(false);
    }
  });

  it('control: el mismo rol de televenta SÍ se bloquearía si tuviera la clave (la señal es la clave)', async () => {
    const { svc } = montar({ rol: 'telemarketing', conClave: ['telemarketing'], existencia: { [`${LPA}|${PROD}`]: 0 } });
    expect((await falla(svc.addLine(ORDER, { product_id: PROD, quantity: 1 })))?.status).toBe(409);
  });

  it('⭐ de OTRA sucursal de la zona: se valida la sucursal de surtido del renglón', async () => {
    const { svc } = montar({ rol: 'vendedor_ruta', existencia: { [`${LPA}|${PROD}`]: 9, [`${PH}|${PROD}`]: 0 } });
    const r = await falla(svc.addLine(ORDER, { product_id: PROD, quantity: 1, source_warehouse_id: PH }));
    expect(r?.body).toMatchObject({ warehouse_id: PH, warehouse_short: 'PH', state: 'agotado', alternatives: [{ warehouse_id: LPA, short: 'LPA', qty: 9 }] });
    // Negativa: el mismo producto de SU sucursal (con 9) pasa.
    const { svc: svc2 } = montar({ rol: 'vendedor_ruta', existencia: { [`${LPA}|${PROD}`]: 9, [`${PH}|${PROD}`]: 0 } });
    expect(await falla(svc2.addLine(ORDER, { product_id: PROD, quantity: 1 }))).toMatchObject(PASO);
  });

  it('negativa: sumar a un renglón que YA existe no es «agregar» y no se frena', async () => {
    const { svc } = montar({
      rol: 'vendedor_ruta', existencia: { [`${LPA}|${PROD}`]: 0 },
      lineas: [{ id: LINE, order_id: ORDER, product_id: PROD, source_warehouse_id: null, quantity: 3 }],
    });
    expect(await falla(svc.addLine(ORDER, { product_id: PROD, quantity: 1 }))).toMatchObject(PASO);
  });

  it('⭐ el legado se guarda con SU product_id aunque su gemelo tenga precio (la pantalla casa la fila por ese id)', async () => {
    // Antes se cambiaba al gemelo: la fila del legado no encontraba su renglón, volvía a 0 y cada
    // «+» sumaba en silencio al renglón del gemelo. Este caso habría estado en rojo.
    for (const rol of ['vendedor_ruta', 'superadmin', 'telemarketing']) {
      const { svc, tarifa } = montar({ rol, gemeloConPrecio: true, existencia: { [`${LPA}|${VIVO}`]: 5 } });
      expect(await falla(svc.addLine(ORDER, { product_id: LEGADO, quantity: 1 }))).toMatchObject(PASO);
      expect(tarifa.mock.calls[0][2]).toBe(LEGADO);
    }
  });

  it('el legado usa la existencia de su gemelo para bloquear (no 0)', async () => {
    const { svc } = montar({ rol: 'vendedor_ruta', existencia: { [`${LPA}|${VIVO}`]: 0 } });
    expect(((await falla(svc.addLine(ORDER, { product_id: LEGADO, quantity: 1 })))?.body as { state: string }).state).toBe('agotado');
    // Negativa: con el gemelo en existencia, el legado pasa (no se lee como «no se maneja»).
    const { svc: svc2 } = montar({ rol: 'vendedor_ruta', existencia: { [`${LPA}|${VIVO}`]: 5 } });
    expect(await falla(svc2.addLine(ORDER, { product_id: LEGADO, quantity: 1 }))).toMatchObject(PASO);
  });
});

describe('[MCP.3.16] bloqueo al agregar · updateLine', () => {
  const lineas = [{ id: LINE, order_id: ORDER, product_id: PROD, source_warehouse_id: null, quantity: 3, requested_quantity: 3, discount_percent: 0, unit_price: 1, tax_rate: 0.16 }];

  it('⭐ cambiar el origen a una sucursal agotada: 409', async () => {
    const { svc } = montar({ rol: 'vendedor_ruta', lineas, existencia: { [`${LPA}|${PROD}`]: 9, [`${PH}|${PROD}`]: 0 } });
    const r = await falla(svc.updateLine(ORDER, LINE, { quantity: 3, source_warehouse_id: PH }));
    expect(r?.status).toBe(409);
    expect(r?.body).toMatchObject({ code: 'SIN_EXISTENCIA', warehouse_id: PH, state: 'agotado' });
  });

  it('negativa: ajustar la cantidad de un renglón que ya tenía algo NO se frena (aunque esté agotado)', async () => {
    const { svc } = montar({ rol: 'vendedor_ruta', lineas, existencia: { [`${LPA}|${PROD}`]: 0 } });
    expect(await falla(svc.updateLine(ORDER, LINE, { quantity: 5 }))).toMatchObject(PASO);
  });

  it('negativa: cambiar el origen a una sucursal con existencia pasa', async () => {
    const { svc } = montar({ rol: 'vendedor_ruta', lineas, existencia: { [`${PH}|${PROD}`]: 4 } });
    expect(await falla(svc.updateLine(ORDER, LINE, { quantity: 3, source_warehouse_id: PH }))).toMatchObject(PASO);
  });
});

describe('[MCP.3.16] replaceLines NO bloquea por existencia (lote de la sincronización offline)', () => {
  const OTRO = '66666666-6666-4666-8666-666666666666';
  NOMBRES[OTRO] = 'OTRO PRODUCTO';
  const motor = { unit_price: 1, tax_rate: 0.16, line_subtotal: 1, line_tax: 0.16, line_total: 1.16, erp_gross_total: 1.16, rung: 'base' };

  it('⭐ un renglón nuevo agotado del vendedor SE GUARDA: la sincronización coloca el pedido sin leer `skipped`', async () => {
    // Antes se omitía con `block` y el pedido offline quedaba colocado sin ese renglón, sin aviso.
    const { svc, s, insertados, raws } = montar({ rol: 'vendedor_ruta', existencia: { [`${LPA}|${PROD}`]: 0, [`${LPA}|${OTRO}`]: 5 } });
    vi.spyOn(s, 'tarificarConMotor' as never).mockResolvedValue(motor as never);
    vi.spyOn(s, 'recalcOrderTotals' as never).mockResolvedValue(undefined as never);
    const r = (await svc.replaceLines(ORDER, { lines: [{ product_id: PROD, quantity: 1 }, { product_id: OTRO, quantity: 2 }] })) as {
      added: number; skipped: unknown[];
    };
    expect(r).toMatchObject({ added: 2, skipped: [] });
    expect(insertados.map((f) => f['product_id'])).toEqual([PROD, OTRO]);
    // Ni siquiera se consulta la existencia en el lote.
    expect(raws.some((q) => q.includes('v_erp_stock_on_hand'))).toBe(false);
  });

  it('control: el MISMO producto por addLine del vendedor sí se bloquea (el bloqueo vive en el camino interactivo)', async () => {
    const { svc } = montar({ rol: 'vendedor_ruta', existencia: { [`${LPA}|${PROD}`]: 0 } });
    expect((await falla(svc.addLine(ORDER, { product_id: PROD, quantity: 1 })))?.status).toBe(409);
  });

  it('negativa: customer_b2b no se omite por existencia', async () => {
    const { svc, s } = montar({ rol: 'customer_b2b', conClave: [], existencia: { [`${LPA}|${PROD}`]: 0 } });
    vi.spyOn(s, 'tarificarConMotor' as never).mockResolvedValue(motor as never);
    vi.spyOn(s, 'recalcOrderTotals' as never).mockResolvedValue(undefined as never);
    const r = (await svc.replaceLines(ORDER, { lines: [{ product_id: PROD, quantity: 1 }] })) as { added: number; skipped: unknown[] };
    expect(r).toMatchObject({ added: 1, skipped: [] });
  });
});
