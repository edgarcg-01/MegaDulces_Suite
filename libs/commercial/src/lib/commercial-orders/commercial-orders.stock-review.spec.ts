import { CommercialOrdersService } from './commercial-orders.service';

/**
 * `[DN.7]` (ADR-115) La REVISIÓN de existencia al agregar un renglón, en el servicio real del pedido y
 * con el resolvedor REAL (`commercial-inventory/stock-state.ts`).
 *
 * Hasta el 2026-11-07 este archivo era `commercial-orders.stock-block.spec.ts` y probaba el BLOQUEO de
 * `[MCP.3.16]`: un renglón agotado del vendedor era un 409 `SIN_EXISTENCIA` y lo que el cliente pidió se
 * perdía sin rastro. ADR-115 lo quitó: el renglón se GUARDA siempre y su estado viaja en la respuesta
 * (`stock_state` + `stock_review`). Las mismas situaciones de antes se recorren ahora afirmando eso, y
 * la negativa central es que ningún rol recibe ya el 409.
 *
 * La base es un doble que contesta las preguntas que hacen los dos (pedido, rol, frescura, existencia
 * canónica, gemelos); el motor de precios devuelve un precio fijo y el renglón «guardado» es el que se
 * insertó.
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
const CHECKED = '2026-10-27T19:00:00Z';
const MOTOR = { unit_price: 1, tax_rate: 0.16, line_subtotal: 1, line_tax: 0.16, line_total: 1.16, erp_gross_total: 1.16, rung: 'base' };

interface Mundo {
  rol: string;
  /** Roles con VENDOR_APP_ACCESS = true. */
  conClave?: string[];
  /** `${warehouse}|${product}` → qty (sin llave = sin registro). */
  existencia?: Record<string, number>;
  /** Claves de sucursal con lectura al día. */
  alDia?: string[];
  /** Renglones que ya tiene el pedido. */
  lineas?: Array<Record<string, unknown> & { id: string; order_id: string; product_id: string; source_warehouse_id: string | null; quantity: number }>;
  /** La lectura de sucursales truena (la revisión no puede hacer fallar el renglón). */
  revisionCaida?: boolean;
}

function montar(m: Mundo) {
  const raws: string[] = [];
  const insertados: Array<Record<string, unknown>> = [];
  const raw = async (sql: string, b: unknown[] = []) => {
    raws.push(sql);
    if (sql.includes('FOR UPDATE')) return { rows: [] };
    if (sql.includes('identity.role_permissions')) return { rows: (m.conClave ?? ['vendedor_ruta']).includes(String(b[0])) ? [{ '?column?': 1 }] : [] };
    if (sql.includes('analytics.ods_branch_checks')) {
      const codes = b[2] as string[];
      return { rows: (m.alDia ?? ['01', '02', '03']).filter((c) => codes.includes(c)).map((sucursal) => ({ sucursal, last_check_at: CHECKED, last_error: null, al_dia: true })) };
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
    let insertado: Record<string, unknown> | null = null;
    let parche: Record<string, unknown> | null = null;
    let esMax = false;
    for (const k of ['whereNull', 'select', 'orderBy', 'forUpdate', 'returning', 'andWhere']) q[k] = () => q;
    q['max'] = () => { esMax = true; return q; };
    q['where'] = (o: Record<string, unknown>) => { if (o && typeof o === 'object') filtros.push(o); return q; };
    q['whereNot'] = (_c: string, id: string) => { fuera.push(id); return q; };
    q['whereRaw'] = (sql: string, b?: unknown[]) => {
      if (sql.includes('source_warehouse_id IS NOT DISTINCT FROM')) origen = { v: (b?.[0] as string | null) ?? null };
      return q;
    };
    q['whereIn'] = (_c: string, ids: string[]) => {
      if (m.revisionCaida && nombre === 'commercial.warehouses') throw new Error('lectura de sucursales caída');
      enIds = ids;
      return q;
    };
    q['del'] = async () => 0;
    q['insert'] = (fila: Record<string, unknown>) => { insertados.push(fila); insertado = fila; return q; };
    q['update'] = (p: Record<string, unknown>) => { parche = p; return q; };
    const filas = (): unknown[] => {
      const casa = (o: Record<string, unknown>) => filtros.every((f) => Object.entries(f).every(([k, v]) => o[k] === v));
      if (insertado) return [{ id: 'renglon-nuevo', ...insertado }];
      if (esMax) return [{ next_line: (m.lineas ?? []).length }];
      if (nombre === 'commercial.orders') return [{ id: ORDER, code: 'PED-1', status: 'draft', warehouse_id: LPA, price_list_id: LISTA, customer_id: 'cli-1' }];
      if (nombre === 'commercial.warehouses') return WHS.filter((w) => (!enIds || enIds.includes(w.id)) && casa(w as unknown as Record<string, unknown>));
      if (nombre === 'catalog.products') return (enIds ?? []).map((id) => ({ id, nombre: NOMBRES[id] ?? null }));
      if (nombre === 'commercial.order_lines') {
        const base = (m.lineas ?? []).filter((l) => casa(l as unknown as Record<string, unknown>)
          && !fuera.includes(l.id) && (!origen || l.source_warehouse_id === origen.v));
        return parche ? base.map((l) => ({ ...l, ...parche })) : base;
      }
      return [];
    };
    q['first'] = async () => filas()[0];
    q['then'] = (ok: (v: unknown) => unknown, ko?: (e: unknown) => unknown) => Promise.resolve(filas()).then(ok, ko);
    return q;
  };
  const trx: any = Object.assign(tabla, { raw, transaction: async (cb: (sp: unknown) => unknown) => cb(trx) });
  const tk = { run: (a: unknown, b?: unknown) => (typeof a === 'function' ? a : b as (t: unknown) => unknown)(trx) };
  const tenantCtx = { get: () => ({ tenantId: 't', userId: 'u', roleName: m.rol }), requireTenantId: () => 't' };
  const svc = new CommercialOrdersService(tk as never, tenantCtx as never, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never);
  const s = svc as unknown as Record<string, (...a: unknown[]) => unknown>;
  const tarifa = vi.spyOn(s, 'tarificarConMotor' as never).mockResolvedValue(MOTOR as never);
  vi.spyOn(s, 'recalcOrderTotals' as never).mockResolvedValue(undefined as never);
  vi.spyOn(s, 'resolveCustomerIdFromUser' as never).mockResolvedValue('cli-1' as never);
  return { svc, tarifa, raws, insertados, s };
}

type ConRevision = { stock_state: string | null; stock_review: Record<string, unknown> | null; product_id?: string };
/** El error que lanzó, o null. */
const falla = async (p: Promise<unknown>): Promise<{ status?: number; body?: unknown; message?: string } | null> => {
  try { await p; return null; } catch (e) {
    const x = e as { getStatus?: () => number; getResponse?: () => unknown; message?: string };
    return { status: x.getStatus?.(), body: x.getResponse?.(), message: x.message };
  }
};
const leyoExistencia = (raws: string[]) => raws.some((q) => q.includes('v_erp_stock_on_hand'));

describe('[DN.7] addLine del vendedor: se GUARDA y la respuesta dice el estado (ADR-115)', () => {
  it('⭐ agotado en su sucursal con otras de la zona que sí tienen: el renglón se guarda y trae la revisión exacta', async () => {
    const { svc, insertados } = montar({ rol: 'vendedor_ruta', existencia: { [`${LPA}|${PROD}`]: 0, [`${PH}|${PROD}`]: 14, [`${ES8}|${PROD}`]: 1328 } });
    const r = (await svc.addLine(ORDER, { product_id: PROD, quantity: 2 })) as unknown as ConRevision;
    expect(insertados.map((f) => f['product_id'])).toEqual([PROD]);
    expect(r.stock_state).toBe('agotado');
    expect(r.stock_review).toEqual({
      state: 'agotado',
      qty: 0,
      insuficiente: false,
      product_id: PROD,
      product_name: 'PULPARINDO 20 PZ',
      warehouse_id: LPA,
      warehouse_short: 'LPA',
      checked_at: new Date(CHECKED).toISOString(),
      alternatives: [{ warehouse_id: ES8, short: '8ES', qty: 1328 }, { warehouse_id: PH, short: 'PH', qty: 14 }],
      message: 'Puede estar agotado en LPA · 8ES tiene 1,328 · PH tiene 14',
    });
  });

  it('⭐ no se maneja y nadie de la zona tiene: «tampoco hay en tu zona», sin alternativas, y se guarda', async () => {
    const { svc, insertados } = montar({ rol: 'vendedor_ruta', existencia: { [`${PH}|${PROD}`]: 0 } });
    const r = (await svc.addLine(ORDER, { product_id: PROD, quantity: 1 })) as unknown as ConRevision;
    expect(insertados).toHaveLength(1);
    expect(r.stock_review).toMatchObject({ state: 'no_se_maneja', alternatives: [], product_name: 'PULPARINDO 20 PZ', message: 'LPA no lo maneja · tampoco hay en tu zona' });
    expect(String(r.stock_review?.['message'])).not.toContain(PROD);
  });

  it('⭐ ADR-056: con otra sucursal de la zona SIN DATO no se afirma nada de la zona; se nombra la que falta', async () => {
    const { svc } = montar({ rol: 'vendedor_ruta', alDia: ['01', '02'], existencia: { [`${LPA}|${PROD}`]: 0, [`${ES8}|${PROD}`]: 50 } });
    const r = (await svc.addLine(ORDER, { product_id: PROD, quantity: 1 })) as unknown as ConRevision;
    expect(r.stock_review).toMatchObject({ state: 'agotado', alternatives: [], message: 'Puede estar agotado en LPA · sin dato de 8ES' });
    expect(String(r.stock_review?.['message'])).not.toContain('tu zona');
  });

  it('⭐ ADR-056: sin zona resuelta (la sucursal no tiene purchase_zone) tampoco se afirma nada de la zona', async () => {
    const lpa = WHS.find((w) => w.id === LPA)!;
    const zonaOriginal = lpa.purchase_zone;
    lpa.purchase_zone = null as unknown as string;
    try {
      const { svc } = montar({ rol: 'vendedor_ruta', existencia: { [`${LPA}|${PROD}`]: 0 } });
      const r = (await svc.addLine(ORDER, { product_id: PROD, quantity: 1 })) as unknown as ConRevision;
      expect(r.stock_review).toMatchObject({ state: 'agotado', alternatives: [], message: 'Puede estar agotado en LPA' });
    } finally {
      lpa.purchase_zone = zonaOriginal;
    }
  });

  it('sin_dato (lectura de su sucursal vieja): se guarda y se dice sin_dato, nunca «con existencia»', async () => {
    const { svc, insertados } = montar({ rol: 'vendedor_ruta', alDia: ['01', '03'], existencia: { [`${LPA}|${PROD}`]: 0 } });
    const r = (await svc.addLine(ORDER, { product_id: PROD, quantity: 1 })) as unknown as ConRevision;
    expect(insertados).toHaveLength(1);
    expect(r.stock_state).toBe('sin_dato');
    expect(r.stock_review).toMatchObject({ state: 'sin_dato', qty: null });
    expect(String(r.stock_review?.['message'])).toMatch(/^Sin dato de existencia en LPA/);
  });

  it('pedir más de lo que hay (pero hay > 0): con_existencia e «insuficiente», sin texto de aviso', async () => {
    const { svc } = montar({ rol: 'vendedor_ruta', existencia: { [`${LPA}|${PROD}`]: 2 } });
    const r = (await svc.addLine(ORDER, { product_id: PROD, quantity: 50 })) as unknown as ConRevision;
    expect(r.stock_review).toMatchObject({ state: 'con_existencia', qty: 2, insuficiente: true, message: null });
    // Negativa: lo que alcanza no es «insuficiente».
    const { svc: svc2 } = montar({ rol: 'vendedor_ruta', existencia: { [`${LPA}|${PROD}`]: 2 } });
    expect(((await svc2.addLine(ORDER, { product_id: PROD, quantity: 2 })) as unknown as ConRevision).stock_review).toMatchObject({ insuficiente: false });
  });

  it('negativa: el portal del cliente (customer_b2b) no se revisa: stock_state null y sin leer existencia', async () => {
    const { svc, raws } = montar({ rol: 'customer_b2b', conClave: ['customer_b2b'], existencia: { [`${LPA}|${PROD}`]: 0 } });
    const r = (await svc.addLine(ORDER, { product_id: PROD, quantity: 1 })) as unknown as ConRevision;
    expect(r).toMatchObject({ stock_state: null, stock_review: null });
    expect(leyoExistencia(raws)).toBe(false);
  });

  it('negativa: televenta (rol sin VENDOR_APP_ACCESS) no se revisa', async () => {
    const { svc, raws } = montar({ rol: 'telemarketing', existencia: { [`${LPA}|${PROD}`]: 0 } });
    const r = (await svc.addLine(ORDER, { product_id: PROD, quantity: 1 })) as unknown as ConRevision;
    expect(r).toMatchObject({ stock_state: null, stock_review: null });
    expect(leyoExistencia(raws)).toBe(false);
  });

  it('negativa: los admins de plataforma no se revisan AUNQUE su rol tuviera la clave (los excluye isPlatformAdminRole)', async () => {
    for (const rol of ['superadmin', 'admin']) {
      const { svc, raws } = montar({ rol, conClave: [rol, 'vendedor_ruta'], existencia: { [`${LPA}|${PROD}`]: 0 } });
      const r = (await svc.addLine(ORDER, { product_id: PROD, quantity: 1 })) as unknown as ConRevision;
      expect(r, rol).toMatchObject({ stock_state: null, stock_review: null });
      expect(leyoExistencia(raws)).toBe(false);
    }
  });

  it('control: el mismo rol de televenta SÍ se revisa si tuviera la clave (la señal es la clave)', async () => {
    const { svc } = montar({ rol: 'telemarketing', conClave: ['telemarketing'], existencia: { [`${LPA}|${PROD}`]: 0 } });
    expect(((await svc.addLine(ORDER, { product_id: PROD, quantity: 1 })) as unknown as ConRevision).stock_state).toBe('agotado');
  });

  it('⭐ de OTRA sucursal de la zona: se revisa la sucursal de surtido del renglón', async () => {
    const { svc } = montar({ rol: 'vendedor_ruta', existencia: { [`${LPA}|${PROD}`]: 9, [`${PH}|${PROD}`]: 0 } });
    const r = (await svc.addLine(ORDER, { product_id: PROD, quantity: 1, source_warehouse_id: PH })) as unknown as ConRevision;
    expect(r.stock_review).toMatchObject({ warehouse_id: PH, warehouse_short: 'PH', state: 'agotado', alternatives: [{ warehouse_id: LPA, short: 'LPA', qty: 9 }] });
    // Control: el mismo producto de SU sucursal (con 9) tiene existencia.
    const { svc: svc2 } = montar({ rol: 'vendedor_ruta', existencia: { [`${LPA}|${PROD}`]: 9, [`${PH}|${PROD}`]: 0 } });
    expect(((await svc2.addLine(ORDER, { product_id: PROD, quantity: 1 })) as unknown as ConRevision).stock_state).toBe('con_existencia');
  });

  it('sumar a un renglón que YA existe no es «agregar»: no se revisa (y no se lee existencia)', async () => {
    const { svc, raws } = montar({
      rol: 'vendedor_ruta', existencia: { [`${LPA}|${PROD}`]: 0 },
      lineas: [{ id: LINE, order_id: ORDER, product_id: PROD, source_warehouse_id: null, quantity: 3, discount_percent: 0, unit_price: 1, tax_rate: 0.16 }],
    });
    const r = (await svc.addLine(ORDER, { product_id: PROD, quantity: 1 })) as unknown as ConRevision;
    expect(r).toMatchObject({ stock_state: null, stock_review: null });
    expect(leyoExistencia(raws)).toBe(false);
  });

  it('⭐ el legado se guarda con SU product_id y se revisa con la existencia de su gemelo', async () => {
    for (const rol of ['vendedor_ruta', 'superadmin', 'telemarketing']) {
      const { svc, tarifa } = montar({ rol, existencia: { [`${LPA}|${VIVO}`]: 5 } });
      await svc.addLine(ORDER, { product_id: LEGADO, quantity: 1 });
      expect(tarifa.mock.calls[0][2]).toBe(LEGADO);
    }
    const { svc } = montar({ rol: 'vendedor_ruta', existencia: { [`${LPA}|${VIVO}`]: 0 } });
    expect(((await svc.addLine(ORDER, { product_id: LEGADO, quantity: 1 })) as unknown as ConRevision).stock_state).toBe('agotado');
    // Negativa: con el gemelo en existencia, el legado no se lee como «no se maneja».
    const { svc: svc2 } = montar({ rol: 'vendedor_ruta', existencia: { [`${LPA}|${VIVO}`]: 5 } });
    expect(((await svc2.addLine(ORDER, { product_id: LEGADO, quantity: 1 })) as unknown as ConRevision).stock_state).toBe('con_existencia');
  });

  it('⭐ si la revisión truena, el renglón se guarda igual y dice sin_dato (nunca «con existencia»)', async () => {
    const { svc, insertados } = montar({ rol: 'vendedor_ruta', revisionCaida: true, existencia: { [`${LPA}|${PROD}`]: 9 } });
    const r = (await svc.addLine(ORDER, { product_id: PROD, quantity: 1 })) as unknown as ConRevision;
    expect(insertados).toHaveLength(1);
    expect(r.stock_review).toMatchObject({ state: 'sin_dato', message: 'No se pudo revisar la existencia.' });
  });

  it('❌ NEGATIVA CENTRAL: ningún rol recibe ya el 409 SIN_EXISTENCIA (volver a poner el throw pone esto en rojo)', async () => {
    const casos: Mundo[] = [
      { rol: 'vendedor_ruta', existencia: { [`${LPA}|${PROD}`]: 0 } },
      { rol: 'vendedor_ruta', existencia: { [`${PH}|${PROD}`]: 0 } },
      { rol: 'telemarketing', conClave: ['telemarketing'], existencia: { [`${LPA}|${PROD}`]: 0 } },
      { rol: 'customer_b2b', conClave: [], existencia: { [`${LPA}|${PROD}`]: 0 } },
      { rol: 'superadmin', existencia: { [`${LPA}|${PROD}`]: 0 } },
    ];
    for (const m of casos) {
      const { svc } = montar(m);
      const e = await falla(svc.addLine(ORDER, { product_id: PROD, quantity: 1 }));
      expect(e, `rol ${m.rol}`).toBeNull();
    }
  });
});

describe('[DN.7] updateLine: cambiar de sucursal a una en 0 se hace y lo dice', () => {
  const lineas = [{ id: LINE, order_id: ORDER, product_id: PROD, source_warehouse_id: null, quantity: 3, requested_quantity: 3, discount_percent: 0, unit_price: 1, tax_rate: 0.16 }];

  it('⭐ cambiar el origen a una sucursal agotada: se hace (antes 409) y responde agotado en esa sucursal', async () => {
    const { svc } = montar({ rol: 'vendedor_ruta', lineas, existencia: { [`${LPA}|${PROD}`]: 9, [`${PH}|${PROD}`]: 0 } });
    const r = (await svc.updateLine(ORDER, LINE, { quantity: 3, source_warehouse_id: PH })) as unknown as ConRevision & { source_warehouse_id: string };
    expect(r.source_warehouse_id).toBe(PH);
    expect(r.stock_review).toMatchObject({ warehouse_id: PH, state: 'agotado', alternatives: [{ warehouse_id: LPA, short: 'LPA', qty: 9 }] });
  });

  it('ajustar la cantidad de un renglón que ya tenía algo no se revisa (aunque esté agotado)', async () => {
    const { svc, raws } = montar({ rol: 'vendedor_ruta', lineas, existencia: { [`${LPA}|${PROD}`]: 0 } });
    const r = (await svc.updateLine(ORDER, LINE, { quantity: 5 })) as unknown as ConRevision;
    expect(r).toMatchObject({ stock_state: null, stock_review: null });
    expect(leyoExistencia(raws)).toBe(false);
  });

  it('control: cambiar el origen a una sucursal con existencia responde con_existencia', async () => {
    const { svc } = montar({ rol: 'vendedor_ruta', lineas, existencia: { [`${PH}|${PROD}`]: 4 } });
    expect(((await svc.updateLine(ORDER, LINE, { quantity: 3, source_warehouse_id: PH })) as unknown as ConRevision).stock_state).toBe('con_existencia');
  });
});

describe('[MCP.3.16] replaceLines NO revisa existencia (lote de la sincronización offline)', () => {
  const OTRO = '66666666-6666-4666-8666-666666666666';
  NOMBRES[OTRO] = 'OTRO PRODUCTO';

  it('⭐ un renglón nuevo agotado del vendedor SE GUARDA: la sincronización coloca el pedido sin leer `skipped`', async () => {
    const { svc, insertados, raws } = montar({ rol: 'vendedor_ruta', existencia: { [`${LPA}|${PROD}`]: 0, [`${LPA}|${OTRO}`]: 5 } });
    const r = (await svc.replaceLines(ORDER, { lines: [{ product_id: PROD, quantity: 1 }, { product_id: OTRO, quantity: 2 }] })) as {
      added: number; skipped: unknown[];
    };
    expect(r).toMatchObject({ added: 2, skipped: [] });
    expect(insertados.map((f) => f['product_id'])).toEqual([PROD, OTRO]);
    // Ni siquiera se consulta la existencia en el lote: lo agotado lo registra `place()` (DN.8).
    expect(leyoExistencia(raws)).toBe(false);
  });

  it('control: el MISMO producto por addLine del vendedor también se guarda (ADR-115), con su estado', async () => {
    const { svc, insertados } = montar({ rol: 'vendedor_ruta', existencia: { [`${LPA}|${PROD}`]: 0 } });
    const r = (await svc.addLine(ORDER, { product_id: PROD, quantity: 1 })) as unknown as ConRevision;
    expect(insertados).toHaveLength(1);
    expect(r.stock_state).toBe('agotado');
  });

  it('negativa: customer_b2b no se omite por existencia', async () => {
    const { svc } = montar({ rol: 'customer_b2b', conClave: [], existencia: { [`${LPA}|${PROD}`]: 0 } });
    const r = (await svc.replaceLines(ORDER, { lines: [{ product_id: PROD, quantity: 1 }] })) as { added: number; skipped: unknown[] };
    expect(r).toMatchObject({ added: 1, skipped: [] });
  });
});
