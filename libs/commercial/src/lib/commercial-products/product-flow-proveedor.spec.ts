import { BadRequestException } from '@nestjs/common';
import {
  DatosPlaza,
  armarProveedores,
  filaProveedor,
  juzgarPlaza,
  listaNombres,
  motivoCorto,
  periodos,
  resumirProducto,
  resumirProveedor,
} from './product-flow';
import { escaleraDeFicha } from './new-products';
import { ProductFlowService, SIN_PROVEEDOR } from './product-flow.service';

const HOY = '2026-10-09';
const P = periodos(HOY);
const ESC = escaleraDeFicha({ u1: 'PZA', u2: null, u3: 'CJA', f2: null, f3: '12', uxc: '12' });
const NOMBRES = new Map([['01', 'Padre Hidalgo'], ['02', 'La Piedad Abastos'], ['03', '8 Esquinas'], ['04', 'Zamora']]);

const plaza = (plazaCode: string, diaria: number, existencia: number | null, over: Partial<DatosPlaza> = {}) => juzgarPlaza(P, {
  plaza: plazaCode, nombre: NOMBRES.get(plazaCode) ?? null,
  mes: diaria * 10 * P.dias, mes_anterior_mismo: diaria * 10 * P.dias, mes_anterior_total: diaria * 10 * 30,
  monto30: diaria * 10 * 30, unidades30: diaria * 30, ultima: diaria > 0 ? HOY : null,
  existencia, duda: null, escalera: ESC, costo: null, ...over,
});

describe('[PF.9] listaNombres', () => {
  it('uno, dos y más de dos', () => {
    expect(listaNombres([{ plaza: '01', nombre: 'Padre Hidalgo' }])).toBe('Padre Hidalgo');
    expect(listaNombres([{ plaza: '01', nombre: 'A' }, { plaza: '02', nombre: 'B' }])).toBe('A y B');
    expect(listaNombres([{ plaza: '01', nombre: 'A' }, { plaza: '02', nombre: 'B' }, { plaza: '03', nombre: 'C' }, { plaza: '04', nombre: null }]))
      .toBe('A, B y 2 más');
  });
  it('sin nombre usa el código de la sucursal', () => {
    expect(listaNombres([{ plaza: '07', nombre: null }])).toBe('Sucursal 07');
  });
});

describe('[PF.9] motivoCorto — el porqué en una frase', () => {
  it('lo que pasa en sucursales va primero: agotado y estancado', () => {
    const r = resumirProducto('p', P, [plaza('01', 10, 500), plaza('02', 5, 0), plaza('03', 0, 50, { ultima: '2026-09-01' })]);
    expect(motivoCorto(r)).toBe('Agotado en La Piedad Abastos · estancado en 8 Esquinas');
  });

  it('comprar: se acaba en N días', () => {
    const r = resumirProducto('p', P, [plaza('01', 10, 30)]);
    expect(r.compra.veredicto).toBe('comprar');
    expect(motivoCorto(r)).toBe('Se acaba en 3 días');
  });

  it('⭐ líder con cobertura que a otro no lo haría comprar: lo dice', () => {
    const r = resumirProducto('p', P, [plaza('01', 10, 180)], { lider: { rank: 3, participacion: 0.01 } });
    expect(r.compra.veredicto).toBe('comprar');
    expect(motivoCorto(r)).toMatch(/^Es líder: se le compra antes de los \d+ días$/);
  });

  it('esperar, sobra y no se vende', () => {
    expect(motivoCorto(resumirProducto('p', P, [plaza('01', 10, 180)]))).toMatch(/^Revisar en unos \d+ días$/);
    const sobra = resumirProducto('p', P, [plaza('01', 1, 900)]);
    expect(sobra.compra.veredicto).toBe('sobra');
    expect(motivoCorto(sobra)).toBe('Hay para 900 días');
    const nada = resumirProducto('p', P, [plaza('01', 0, 0, { mes: 0, mes_anterior_mismo: 0, mes_anterior_total: 0, monto30: 0, unidades30: 0, ultima: null })]);
    expect(motivoCorto(nada)).toBe('Sin venta ni existencia');
  });

  it('agrega dónde se frenó', () => {
    const r = resumirProducto('p', P, [plaza('01', 10, 180, { mes: 300, mes_anterior_mismo: 900 })]);
    expect(motivoCorto(r)).toContain('se frenó en Padre Hidalgo');
  });
});

describe('[PF.9] fila y resumen del proveedor', () => {
  it('la fila trae sku, nombre y motivo; sin margen cuando no hay', () => {
    const r = resumirProducto('p1', P, [plaza('01', 10, 30)]);
    const f = filaProveedor(r, { sku: '70187', nombre: 'PALETA X' });
    expect(f).toMatchObject({ product_id: 'p1', sku: '70187', nombre: 'PALETA X', veredicto: 'comprar', motivo: 'Se acaba en 3 días', margen_real: null });
    expect(f.cobertura_dias).toBe(3);
  });

  it('el resumen cuenta por veredicto, líderes, agotados y estancados', () => {
    const rs = [
      resumirProducto('a', P, [plaza('01', 10, 30)], { lider: { rank: 1, participacion: 0.02 } }),
      resumirProducto('b', P, [plaza('01', 10, 500), plaza('02', 5, 0)]),
      resumirProducto('c', P, [plaza('01', 1, 900), plaza('03', 0, 50, { ultima: '2026-09-01' })]),
    ];
    const s = resumirProveedor(rs);
    expect(s.productos).toBe(3);
    expect(s.por_veredicto.comprar).toBeGreaterThanOrEqual(1);
    expect(Object.values(s.por_veredicto).reduce((a, n) => a + n, 0)).toBe(3);
    expect(s.lideres).toBe(1);
    expect(s.agotados).toBe(1);
    expect(s.estancados).toBe(1);
    expect(s.mes).toBe(rs.reduce((a, r) => a + r.mes, 0));
  });

  it('un proveedor sin productos no divide entre cero', () => {
    const s = resumirProveedor([]);
    expect(s).toMatchObject({ productos: 0, mes: 0, variacion: null });
  });
});

describe('[PF.9] armarProveedores', () => {
  const filas = [
    { supplier_id: 'b', nombre: ' DULCES LA ROSA SA DE CV ', productos: 269, mes: 900, ant: 800, con_venta: 200 },
    { supplier_id: 'a', nombre: 'BARCEL', productos: 50, mes: 1200, ant: 1000, con_venta: 40 },
    { supplier_id: null, nombre: null, productos: 500, mes: 10, ant: 5, con_venta: 3 },
    { supplier_id: 'z', nombre: 'PRODUCTOS SIN PROVEEDOR ASIGNADO', productos: 91, mes: 5, ant: 0, con_venta: 10 },
  ];

  it('⭐ junta los NULL y el comodín de Kepler en un solo grupo aparte', () => {
    const r = armarProveedores(P, filas);
    expect(r.proveedores.map((x) => x.supplier_id)).toEqual(['a', 'b']);
    expect(r.sin_proveedor).toMatchObject({ supplier_id: null, productos: 591, mes: 15, con_venta: 13 });
  });

  it('ordena por venta del mes y limpia el nombre', () => {
    const r = armarProveedores(P, filas);
    expect(r.proveedores[1].nombre).toBe('DULCES LA ROSA SA DE CV');
    expect(r.proveedores[0].variacion).toBeCloseTo(0.2);
  });

  it('sin productos sin proveedor, el grupo es NULL (no un cero)', () => {
    expect(armarProveedores(P, filas.slice(0, 2)).sin_proveedor).toBeNull();
  });
});

describe('[PF.9] productosProveedor — validación y memo', () => {
  const nuevo = () => new ProductFlowService({} as never, { requireTenantId: () => 't' } as never, {} as never);

  it('rechaza un id que no es uuid ni `sin`', async () => {
    await expect(nuevo().productosProveedor('1; drop', { puedeVerCosto: false })).rejects.toBeInstanceOf(BadRequestException);
    expect(SIN_PROVEEDOR).toBe('sin');
  });

  it('⭐ dentro del minuto no vuelve a calcular; con otro permiso sí (la respuesta cambia)', async () => {
    const svc = nuevo();
    let n = 0;
    (svc as unknown as { calcularProveedor: () => Promise<unknown> }).calcularProveedor = async () => ({ n: ++n });
    const id = '00000000-0000-0000-0000-000000000001';
    const a = await svc.productosProveedor(id, { puedeVerCosto: false });
    const b = await svc.productosProveedor(id, { puedeVerCosto: false });
    expect(b).toBe(a);
    expect(n).toBe(1);
    await svc.productosProveedor(id, { puedeVerCosto: true });
    expect(n).toBe(2);
  });

  it('dos pedidos simultáneos comparten el mismo cálculo', async () => {
    const svc = nuevo();
    let n = 0;
    (svc as unknown as { calcularProveedor: () => Promise<unknown> }).calcularProveedor = () =>
      new Promise((ok) => setTimeout(() => ok({ n: ++n }), 5));
    const [a, b] = await Promise.all([
      svc.productosProveedor(SIN_PROVEEDOR, { puedeVerCosto: false }),
      svc.productosProveedor(SIN_PROVEEDOR, { puedeVerCosto: false }),
    ]);
    expect(a).toBe(b);
    expect(n).toBe(1);
  });
});
