import {
  estadoDeProductos,
  lecturaDeSucursales,
  noSeManejaAlFinalSql,
  resolverFilaCatalogo,
  type FilaConHechos,
  type LecturaSucursal,
} from './stock-state';

/**
 * `[MCP.3.16]` El resolvedor único del estado de existencia. La base es un doble que responde a
 * las tres preguntas que hace el resolvedor (frescura, identidad/gemelo y existencia canónica), y
 * que puede FALLAR en cada una para probar que una lectura caída es «sin dato», nunca 0.
 */
const PH = 'w-01', LPA = 'w-02';
const SUC = [{ id: PH, code: '01' }, { id: LPA, code: '02' }];

interface Opts {
  checks?: Array<{ sucursal: string; al_dia: boolean; last_error?: string | null; last_check_at?: string }>;
  checksFalla?: boolean;
  existenciaFalla?: boolean;
  sinVista?: boolean;
  /** product_id → { con_sku, twin_id } */
  productos?: Record<string, { con_sku: boolean; twin_id?: string | null }>;
  /** `${warehouse}|${product}` → qty */
  existencia?: Record<string, number>;
}

function fakeDb(o: Opts) {
  const sql: string[] = [];
  let savepoints = 0;
  const raw = async (s: string, b: unknown[] = []) => {
    sql.push(s);
    if (s.includes('to_regclass')) return { rows: [{ ok: !o.sinVista }] };
    if (s.includes('analytics.ods_branch_checks')) {
      if (o.checksFalla) throw new Error('relation does not exist');
      const codes = b[2] as string[];
      return {
        rows: (o.checks ?? []).filter((c) => codes.includes(c.sucursal)).map((c) => ({
          sucursal: c.sucursal, al_dia: c.al_dia, last_error: c.last_error ?? null,
          last_check_at: c.last_check_at ?? '2026-10-27T19:00:00Z',
        })),
      };
    }
    if (s.includes('analytics.v_erp_stock_on_hand')) {
      if (o.existenciaFalla) throw new Error('statement timeout');
      const whs = b[0] as string[];
      const prods = b[1] as string[];
      const rows = Object.entries(o.existencia ?? {})
        .map(([k, qty]) => { const [warehouse_id, product_id] = k.split('|'); return { warehouse_id, product_id, qty }; })
        .filter((r) => whs.includes(r.warehouse_id) && (!prods || prods.includes(r.product_id)));
      return { rows };
    }
    if (s.includes('catalog.products')) {
      const ids = b[0] as string[];
      return {
        rows: ids.filter((id) => o.productos?.[id]).map((id) => ({
          id, con_sku: o.productos![id].con_sku, twin_id: o.productos![id].twin_id ?? null,
        })),
      };
    }
    return { rows: [] };
  };
  const db: any = { raw, transaction: async (cb: (sp: unknown) => unknown) => { savepoints++; return cb({ raw }); } };
  return { db, sql, savepoints: () => savepoints };
}

const FRESCAS = [{ sucursal: '01', al_dia: true }, { sucursal: '02', al_dia: true }];

describe('[MCP.3.16] lecturaDeSucursales', () => {
  it('al día, vieja, con error y sin fila', async () => {
    const { db, savepoints } = fakeDb({
      checks: [{ sucursal: '01', al_dia: true }, { sucursal: '02', al_dia: false, last_error: 'ECONNRESET' }],
    });
    const l = await lecturaDeSucursales(db, [...SUC, { id: 'w-04', code: '04' }]);
    expect(l.get(PH)).toEqual({ warehouse_id: PH, medido: true, checked_at: '2026-10-27T19:00:00.000Z', motivo: null });
    expect(l.get(LPA)?.medido).toBe(false);
    expect(l.get(LPA)?.motivo).toMatch(/falló/);
    expect(l.get('w-04')).toEqual({ warehouse_id: 'w-04', medido: false, checked_at: null, motivo: 'Esa sucursal nunca se revisó.' });
    expect(savepoints()).toBe(1);
  });

  it('⛔ la consulta falla dentro del SAVEPOINT: todas sin medir, sin lanzar', async () => {
    const { db } = fakeDb({ checksFalla: true });
    const l = await lecturaDeSucursales(db, SUC);
    expect([...l.values()].every((x) => !x.medido && x.checked_at === null)).toBe(true);
  });

  it('una sucursal sin clave no se consulta', async () => {
    const { db, sql } = fakeDb({ checks: FRESCAS });
    const l = await lecturaDeSucursales(db, [{ id: 'x', code: null }]);
    expect(l.get('x')?.medido).toBe(false);
    expect(sql).toEqual([]);
  });
});

describe('[MCP.3.16] estadoDeProductos — los cuatro estados', () => {
  const productos = {
    hay: { con_sku: true }, cero: { con_sku: true }, nomaneja: { con_sku: true },
    legado: { con_sku: false, twin_id: 'vivo' }, vivo: { con_sku: true }, ciego: { con_sku: false },
  };
  const existencia = { [`${PH}|hay`]: 14, [`${PH}|cero`]: 0, [`${PH}|vivo`]: 9, [`${LPA}|hay`]: 3 };

  it('⭐ con_existencia · agotado · no_se_maneja con lectura al día', async () => {
    const { db } = fakeDb({ checks: FRESCAS, productos, existencia });
    const { estado } = await estadoDeProductos(db, SUC, ['hay', 'cero', 'nomaneja']);
    expect(estado(PH, 'hay')).toMatchObject({ state: 'con_existencia', qty: 14 });
    expect(estado(PH, 'cero')).toMatchObject({ state: 'agotado', qty: 0 });
    expect(estado(PH, 'nomaneja')).toMatchObject({ state: 'no_se_maneja', qty: null });
    // Negativa: «no se maneja» es por sucursal; en LPA el mismo «hay» tiene 3.
    expect(estado(LPA, 'hay')).toMatchObject({ state: 'con_existencia', qty: 3 });
  });

  it('⭐ el legado usa la existencia de su GEMELO (no 0)', async () => {
    const { db } = fakeDb({ checks: FRESCAS, productos, existencia });
    const { estado } = await estadoDeProductos(db, SUC, ['legado']);
    expect(estado(PH, 'legado')).toMatchObject({ state: 'con_existencia', qty: 9, twin_product_id: 'vivo' });
    // Negativa: sin gemelo con registro en LPA es «no se maneja», no «hay».
    expect(estado(LPA, 'legado').state).toBe('no_se_maneja');
  });

  it('⛔ legado SIN gemelo: la vista no lo puede ver → sin_dato (nunca «no se maneja»)', async () => {
    const { db } = fakeDb({ checks: FRESCAS, productos, existencia });
    const { estado } = await estadoDeProductos(db, SUC, ['ciego']);
    expect(estado(PH, 'ciego')).toMatchObject({ state: 'sin_dato', qty: null });
  });

  it('⛔ lectura vieja de la sucursal → sin_dato aunque la vista tenga número', async () => {
    const { db } = fakeDb({ checks: [{ sucursal: '01', al_dia: false }, { sucursal: '02', al_dia: true }], productos, existencia });
    const { estado } = await estadoDeProductos(db, SUC, ['hay', 'nomaneja']);
    expect(estado(PH, 'hay')).toMatchObject({ state: 'sin_dato', qty: null });
    expect(estado(PH, 'nomaneja').state).toBe('sin_dato');
    // Control: la otra sucursal, al día, sí se afirma.
    expect(estado(LPA, 'nomaneja').state).toBe('no_se_maneja');
  });

  it('⛔ la frescura falla (SAVEPOINT) → todo sin_dato, y ni se consulta la existencia', async () => {
    const { db, sql } = fakeDb({ checksFalla: true, productos, existencia });
    const { estado } = await estadoDeProductos(db, SUC, ['hay', 'cero', 'nomaneja']);
    for (const p of ['hay', 'cero', 'nomaneja']) expect(estado(PH, p).state).toBe('sin_dato');
    expect(sql.some((s) => s.includes('v_erp_stock_on_hand'))).toBe(false);
  });

  it('⛔ la existencia falla (SAVEPOINT) → sin_dato, nunca agotado', async () => {
    const { db } = fakeDb({ checks: FRESCAS, existenciaFalla: true, productos, existencia });
    const { estado } = await estadoDeProductos(db, SUC, ['hay', 'cero']);
    expect(estado(PH, 'cero').state).toBe('sin_dato');
    expect(estado(PH, 'hay').state).toBe('sin_dato');
  });

  it('⛔ sin la vista canónica → sin_dato', async () => {
    const { db } = fakeDb({ checks: FRESCAS, sinVista: true, productos, existencia });
    const { estado } = await estadoDeProductos(db, SUC, ['hay']);
    expect(estado(PH, 'hay').state).toBe('sin_dato');
  });

  it('⭐ no lee commercial.stock (la copia deprecada)', async () => {
    const { db, sql } = fakeDb({ checks: FRESCAS, productos, existencia });
    await estadoDeProductos(db, SUC, ['hay']);
    expect(sql.some((s) => s.includes('commercial.stock'))).toBe(false);
  });
});

describe('[MCP.3.16] catálogo: hechos de SQL → estado con la MISMA regla', () => {
  const al: LecturaSucursal = { warehouse_id: PH, medido: true, checked_at: '2026-10-27T19:00:00.000Z', motivo: null };
  const viejo: LecturaSucursal = { ...al, medido: false };
  const fila = (f: FilaConHechos) => { const r = { ...f }; resolverFilaCatalogo(r, al); return r; };

  it('los cuatro estados y stock_available', () => {
    expect(fila({ stock_medible: true, stock_con_registro: true, stock_qty: '14' })).toEqual({
      stock_state: 'con_existencia', stock_available: 14, stock_checked_at: al.checked_at, stock_twin_product_id: null,
    });
    expect(fila({ stock_medible: true, stock_con_registro: true, stock_qty: 0 })).toMatchObject({ stock_state: 'agotado', stock_available: 0 });
    expect(fila({ stock_medible: true, stock_con_registro: false, stock_qty: null })).toMatchObject({ stock_state: 'no_se_maneja', stock_available: null });
    expect(fila({ stock_medible: false, stock_con_registro: false, stock_qty: null })).toMatchObject({ stock_state: 'sin_dato', stock_available: null });
  });

  it('⛔ lectura vieja: sin_dato y el número viejo NO se publica', () => {
    const r: FilaConHechos = { stock_medible: true, stock_con_registro: true, stock_qty: 14 };
    resolverFilaCatalogo(r, viejo);
    expect(r).toMatchObject({ stock_state: 'sin_dato', stock_available: null });
  });

  it('el gemelo viaja y las columnas auxiliares no', () => {
    const r = fila({ stock_medible: true, stock_con_registro: true, stock_qty: 5, stock_twin_product_id: 'vivo' });
    expect(r.stock_twin_product_id).toBe('vivo');
    expect(Object.keys(r).sort()).toEqual(['stock_available', 'stock_checked_at', 'stock_state', 'stock_twin_product_id']);
  });

  it('el orden: sólo con lectura al día se mandan al final los «no se maneja»', () => {
    expect(noSeManejaAlFinalSql(true)).toMatch(/ex\.product_id IS NULL THEN 1/);
    // Negativa: sin lectura al día no se reordena (y nada de un 0 constante, que PG lee como columna 0).
    expect(noSeManejaAlFinalSql(false)).toBeNull();
  });
});
