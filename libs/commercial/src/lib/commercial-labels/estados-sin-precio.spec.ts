import { CommercialLabelsService } from './commercial-labels.service';

/**
 * `[ETQ-PROMO.1]` La clasificación de «por qué no hay precio» con una base SIMULADA: prueba la lógica de
 * decisión (qué consulta alimenta qué estado), no el SQL. El SQL se comprobó contra producción en solo
 * lectura (ver la descripción del PR): 206 códigos a $0.01 en las 9 plazas, 0.4 ms con 5 códigos.
 */
type Fila = Record<string, unknown>;

function montar(opts: { enPlaza: string[]; datos?: Fila[]; enOtra?: string[] }) {
  const sqls: string[] = [];
  const trx = {
    raw: vi.fn(async (sql: string) => {
      sqls.push(sql);
      if (sql.includes('btrim(sucursal::text) = ?')) return { rows: opts.enPlaza.map((sku) => ({ sku })) };
      if (sql.includes('bool_and')) return { rows: opts.datos ?? [] };
      if (sql.includes('SELECT DISTINCT')) return { rows: (opts.enOtra ?? []).map((sku) => ({ sku })) };
      return { rows: [] };
    }),
  };
  const svc = new CommercialLabelsService({} as never);
  return { run: (skus: string[]) => svc.estadosSinPrecio(trx as never, '02', skus), sqls };
}

describe('[ETQ-PROMO.1] estadosSinPrecio', () => {
  it('⭐ el 09089: existe en la plaza, es promoción a $0.01 → codigo_simbolico (no «sin precio»)', async () => {
    const { run } = montar({
      enPlaza: ['09089'],
      datos: [{ sku: '09089', nombre: '10 CJS OREO BASE 9 KG = GRATIS 1 CJ MAS', centavo_en_todas: true }],
    });
    expect((await run(['09089'])).get('09089')).toBe('codigo_simbolico');
  });

  it('⭐ un producto real sin precio en la plaza SIGUE siendo sin_precio: hay que ponérselo en Kepler', async () => {
    const { run } = montar({
      enPlaza: ['99807'],
      datos: [{ sku: '99807', nombre: 'JABON FOCA 250GR', centavo_en_todas: false }],
    });
    expect((await run(['99807'])).get('99807')).toBe('sin_precio');
  });

  it('una promoción que en otra tienda sí cotiza (78171) se detecta por el nombre', async () => {
    const { run } = montar({
      enPlaza: ['78171'],
      datos: [{ sku: '78171', nombre: '3 EXH PAL WINIS = GRATIS 1 EXH MAS', centavo_en_todas: false }],
    });
    expect((await run(['78171'])).get('78171')).toBe('codigo_simbolico');
  });

  it('«3X2 EN CH POOSH» (sin «= GRATIS») se detecta por el $0.01 en todas las plazas', async () => {
    const { run } = montar({ enPlaza: ['91041'], datos: [{ sku: '91041', nombre: '3X2 EN CAJAS DE POOSH', centavo_en_todas: true }] });
    expect((await run(['91041'])).get('91041')).toBe('codigo_simbolico');
  });

  it('⛔ [negativa] si no se pudo medir el $0.01 (null) y el nombre no es de promoción, NO se inventa promoción', async () => {
    const { run } = montar({ enPlaza: ['50001'], datos: [{ sku: '50001', nombre: 'PRODUCTO X', centavo_en_todas: null }] });
    expect((await run(['50001'])).get('50001')).toBe('sin_precio');
  });

  it('⛔ [negativa] sin fila de datos para el código existente cae a sin_precio (no a promoción)', async () => {
    const { run } = montar({ enPlaza: ['50002'], datos: [] });
    expect((await run(['50002'])).get('50002')).toBe('sin_precio');
  });

  it('lo que NO existe en la plaza conserva su lógica de siempre (ETQ-ESTADO.1)', async () => {
    const { run } = montar({ enPlaza: [], enOtra: ['78182'] });
    const r = await run(['78182', '78180']);
    expect(r.get('78182')).toBe('no_existe_en_plaza');
    expect(r.get('78180')).toBe('no_existe_en_erp');
  });

  it('no consulta la base si no hay códigos sin precio, y la consulta del $0.01 sólo corre si hay códigos que existen', async () => {
    const vacio = montar({ enPlaza: [] });
    expect((await vacio.run([])).size).toBe(0);
    expect(vacio.sqls).toHaveLength(0);
    const sinExistentes = montar({ enPlaza: [], enOtra: [] });
    await sinExistentes.run(['1']);
    expect(sinExistentes.sqls.some((s) => s.includes('bool_and'))).toBe(false);
  });

  it('la consulta del $0.01 mira pieza Y paquete/caja, y exactamente 0.01 (no ≤ 0.05 ni 0.00)', async () => {
    const { run, sqls } = montar({ enPlaza: ['09089'], datos: [] });
    await run(['09089']);
    const q = sqls.find((s) => s.includes('bool_and')) ?? '';
    expect(q).toContain('c90 = 0.01');
    expect(q).toContain('coalesce(c91, 0) <= 0.01');
  });
});
