import { filasDeVendedor, filasPromos, filasVendedores, notaDinero } from './mkt-venta-pdf';
import type { VentaSemana } from './mkt-ranking.service';

/** `[MKT.30]`/`[MKT.31]` Las filas del PDF de los dos rankings (el dibujo es jsPDF). */
const SALTO = String.fromCharCode(10);
const d = (over: Partial<VentaSemana> = {}): VentaSemana => ({
  semana: { lunes: '2026-11-09', domingo: '2026-11-15', numero: 46, hasta: '2026-11-15', en_curso: false },
  filtro: { canal: null, sucursal: null, zona: null },
  sucursales_lista: [], zonas_lista: [],
  totales: { paquetes: 186, objetivo: null, dinero: 100, promos: 2, promos_sin_dato: 1 },
  sucursal_top: null,
  promos: [
    { promo_id: 'k-1', code: '62253', nombre: '3 PROD LA ROSA', paquetes: 157, dinero: 27464.8, objetivo: 200, avance: 0.785, por_canal: [], por_sucursal: [],
      productos_nombres: [], productos_skus: [], proveedor: null, productos_metodo: 'ticket_y_nombre', objetivo_sucursal: { fijo: null, mixto: false, automatico: null, sucursales: [] } },
    { promo_id: 'k-2', code: '00126', nombre: 'KISSES', paquetes: 29, dinero: null, objetivo: null, avance: null, por_canal: [], por_sucursal: [],
      productos_nombres: [], productos_skus: [], proveedor: null, productos_metodo: 'sin_identificar', objetivo_sucursal: { fijo: null, mixto: false, automatico: null, sucursales: [] } },
  ],
  codigos_barras: {},
  vendedores: [{
    clave: 'x', canal: 'ruta', warehouse_code: '01', warehouse_name: 'Padre Hidalgo', vendedor: 'ruta:21', nombre: 'Ruta 21', detalle: 'Camioneta 21 · Padre Hidalgo',
    fuente: 'sin_dato', paquetes: 12, tickets: 4, total: 900, promos_sin_dato: 1,
    promos: [{ code: '62253', nombre: '3 PROD LA ROSA', paquetes: 10, precio: 90, total: 900 }, { code: '00126', nombre: 'KISSES', paquetes: 2, precio: null, total: null }],
  }],
  mostrador: null, dinero_contrastado: { mostrador: true, preventa: false, ruta: false, mayoreo: false }, criterio: '', consultado_at: '2026-11-19T06:00:00Z',
  ...over,
});

describe('[MKT.30] PDF de los rankings', () => {
  it('promociones: lugar, nombre con código, paquetes, objetivo, avance y dinero; sin producto = «sin dato»', () => {
    expect(filasPromos(d())).toEqual([
      ['1', `3 PROD LA ROSA${SALTO}Código 62253`, '157', '200', '79 %', '$27,464.80'],
      ['2', `KISSES${SALTO}Código 00126`, '29', '-', '-', 'sin dato'],
    ]);
  });

  it('vendedores: el canal con el nombre de Mercadotecnia y cuántas promos no tienen dato', () => {
    expect(filasVendedores(d())[0]).toEqual(['1', `Ruta 21${SALTO}Camioneta 21 · Padre Hidalgo`, 'Ruta directa', '12', '2', `$900.00${SALTO}+ 1 sin dato`]);
  });

  it('el detalle de un vendedor cierra con su total', () => {
    expect(filasDeVendedor(d().vendedores[0])).toEqual([
      [`3 PROD LA ROSA${SALTO}Código 62253`, '10', '$90.00', '$900.00'],
      [`KISSES${SALTO}Código 00126`, '2', 'sin dato', 'sin dato'],
      ['Total', '12', '', '$900.00'],
    ]);
  });

  it('[MKT.31] la nota del dinero dice qué canales no se han contrastado; sólo Sucursales, ninguno', () => {
    expect(notaDinero(d())).toContain('Ruta vecinal, Ruta directa, Telemarketing');
    expect(notaDinero(d({ filtro: { canal: 'mostrador', sucursal: null, zona: null } }))).toBe('Dinero contrastado contra el total de los documentos de Kepler.');
  });
});
