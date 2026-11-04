import { CatalogoDetalladoService } from './catalogo-detallado.service';

/**
 * `[NP.22]` «Productos nuevos» dentro de Productos: el servicio de Detallado con sus dependencias de mentira (sin base).
 * Se ejerce lo que la pantalla pide: `mostrar=nuevos` + `resultado`, el orden `lanzamiento` y el conteo de Sencillo.
 */
const TENANT = '00000000-0000-0000-0000-00000000d01c';

const fila = (id: string) => ({
  id, sku: id.toUpperCase(), nombre: 'PRODUCTO ' + id, description: null, barcode: null, proveedor_id: null, proveedor: null,
  n_codigos: 1, sin_precio: false, sin_proveedor: true,
});
const nuevo = (product_id: string, estado: string, veredicto: string | null, over: Record<string, unknown> = {}) => ({
  product_id, estado, etapa: estado === 'seguimiento' ? 'mes_2' : estado, dia: estado === 'sin_movimiento' ? null : 40,
  motivo: estado === 'seguimiento' ? null : 'Dado de alta, sin movimiento', posible_recodificacion: false, clasificacion: null,
  sin_venta_30: false, recomendacion: veredicto ? { veredicto, motivos: ['motivo de ' + product_id] } : null, ...over,
});

function servicio(opts: { calculado?: boolean } = {}) {
  // Productos nuevos llega en SU orden (lo que pide atención primero): c (sacar), a (se queda), d (sin movimiento).
  const nuevos = {
    list: vi.fn().mockResolvedValue({
      calculado: opts.calculado ?? true,
      filas: [nuevo('c', 'seguimiento', 'sacar'), nuevo('a', 'seguimiento', 'se_queda'), nuevo('d', 'sin_movimiento', null)],
    }),
  };
  const catalogo = {
    universo: vi.fn().mockResolvedValue({ sucursal: '01', texto: '', conPrecio: true, filas: ['a', 'b', 'c', 'd'].map(fila) }),
    filasDe: vi.fn(async (fs: Array<{ id: string; sku: string }>) => fs.map((f) => ({ id: f.id, sku: f.sku, nombre: 'X', proveedor: null, unidades: [], razon: null, nCodigos: 1 }))),
    filasDeConCosto: vi.fn(),
  };
  const tk = { run: vi.fn().mockRejectedValue(new Error('sin base en la prueba')) };
  const flow = { cuidar: vi.fn().mockRejectedValue(new Error('sin base')), list: vi.fn().mockResolvedValue({ productos: [] }) };
  const ctx = { requireTenantId: () => TENANT };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- dobles de prueba
  const s = new CatalogoDetalladoService(tk as any, ctx as any, catalogo as any, flow as any, nuevos as any);
  // Las recargas que fallan en segundo plano sólo avisan.
  (s as unknown as { logger: { warn: () => void } }).logger = { warn: () => undefined };
  return { s, nuevos };
}

describe('[NP.22] Detallado · mostrar=nuevos partido por el resultado del lanzamiento', () => {
  it('⭐ sin resultado: los EN SEGUIMIENTO (el universo del resumen), con su lanzamiento en el renglón', async () => {
    const { s } = servicio();
    const r = await s.lista({ mostrar: 'nuevos', orden: 'lanzamiento' });
    expect(r.mostrar).toBe('nuevos');
    expect(r.resultado).toBe('seguimiento');
    expect(r.filas.map((f) => f.id)).toEqual(['c', 'a']);
    expect(r.filas[0].lanzamiento).toMatchObject({ veredicto: 'sacar', motivo: 'motivo de c', dia: 40 });
    expect(r.conteos.nuevos).toBe(2);
    expect(r.conteos_lanzamiento).toMatchObject({ seguimiento: 2, sacar: 1, se_queda: 1, sin_movimiento: 1 });
    expect(r.orden).toBe('lanzamiento');
  });

  it('⭐ con resultado: sólo ése; y los fuera de seguimiento también se pueden ver', async () => {
    const { s } = servicio();
    expect((await s.lista({ mostrar: 'nuevos', resultado: 'sacar' })).filas.map((f) => f.id)).toEqual(['c']);
    const sm = await s.lista({ mostrar: 'nuevos', resultado: 'sin_movimiento' });
    expect(sm.filas.map((f) => f.id)).toEqual(['d']);
    expect(sm.resultado).toBe('sin_movimiento');
  });

  it('[negativa] con otro «Mostrar» el resultado se ignora (no recorta la lista) y no se declara', async () => {
    const { s } = servicio();
    const r = await s.lista({ mostrar: 'todos', resultado: 'sacar' });
    expect(r.resultado).toBeNull();
    expect(r.total).toBe(4);
  });

  it('⛔ Productos nuevos sin calcular: «nuevos» no se puede elegir (cae a todos), sin conteos y el orden cae a producto', async () => {
    const { s } = servicio({ calculado: false });
    const r = await s.lista({ mostrar: 'nuevos', resultado: 'sacar', orden: 'lanzamiento' });
    expect(r.mostrar).toBe('todos');
    expect(r.resultado).toBeNull();
    expect(r.conteos.nuevos).toBeNull();
    expect(r.conteos_lanzamiento).toBeNull();
    expect(r.orden).toBe('producto');
  });
});

describe('[NP.22] Sencillo · el conteo de «Productos nuevos» sin esperar', () => {
  it('⭐ la primera vez no espera (null = sin medir) y arranca el cálculo; la siguiente trae los ids en seguimiento', async () => {
    const { s, nuevos } = servicio();
    expect(s.idsNuevosSinEsperar()).toBeNull();
    expect(nuevos.list).toHaveBeenCalledTimes(1);
    await new Promise((r) => setTimeout(r, 0));
    expect(s.idsNuevosSinEsperar()?.sort()).toEqual(['a', 'c']);
    expect(nuevos.list).toHaveBeenCalledTimes(1);
  });
});
