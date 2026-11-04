import { clasificarCobro, eventoDeCobro, parDelCobro, type FilaCobroRuta, type FilaCobroSucursal } from './cobro-en-ventanilla';

/**
 * `[LE.6.7]` Qué se recibe y cómo. Los casos salen de la sonda contra prod del 2026-11-04 (138 cobros
 * de 14 días: 102 de ruta, 36 de sucursal) y de lo que la fuente PERMITE aunque no haya pasado.
 */
const ruta = (o: Partial<FilaCobroRuta> = {}): FilaCobroRuta =>
  ({ almacen: '01-002', folio: '0000029', importe: '18250.00', rutas: '22', n_rutas: 1, n_fechas: 1, ...o });
const suc = (o: Partial<FilaCobroSucursal> = {}): FilaCobroSucursal =>
  ({ sucursal: '07', folio: '0000169', importe: '31810.24', n: 1, ...o });

describe('[LE.6.7] recibir un cobro: de ruta, de sucursal o detenido', () => {
  it('la llave es la de la cola de Kepler (almacén|U-A-5|folio|0011)', () => {
    expect(parDelCobro('01-002|U-A-5|0000029|0011')).toEqual(['01-002', '0000029']);
    expect(parDelCobro(' 07|U-A-5|0000169|0011 ')).toEqual(['07', '0000169']);
    expect(parDelCobro('00|X-D-26|0023782|0011')).toBeNull();   // un pago no es un cobro
    expect(parDelCobro('07|U-A-5|0000169|0099')).toBeNull();    // otra caja
    expect(parDelCobro(undefined)).toBeNull();
    expect(eventoDeCobro('07|U-A-5|0000169|0011')).toBe('cobro:07|U-A-5|0000169|0011');
  });

  it('de ruta: contra lo que esa ruta debe rendir, con lo que Kepler espera en centavos', () => {
    expect(clasificarCobro(ruta(), undefined)).toEqual({ tipo: 'ruta', ruta: '22', esperado: 1825000n });
  });

  it('de sucursal: otro ingreso (D17), con sus centavos', () => {
    expect(clasificarCobro(undefined, suc())).toEqual({ tipo: 'sucursal', sucursal: '07', esperado: 3181024n });
  });

  it('NEGATIVAS: lo que no se sabe no se elige', () => {
    const varias = clasificarCobro(ruta({ rutas: '22 · 26', n_rutas: 2 }), undefined);
    expect(varias).toMatchObject({ tipo: 'detenido', esperado: 1825000n });
    expect(clasificarCobro(ruta({ n_fechas: 2 }), undefined).tipo).toBe('detenido');
    expect(clasificarCobro(ruta({ rutas: 'CAMIONETA', n_rutas: 1 }), undefined).tipo).toBe('detenido');
    expect(clasificarCobro(ruta(), suc()).tipo).toBe('detenido');
    expect(clasificarCobro(undefined, suc({ n: 2 })).tipo).toBe('detenido');
    expect(clasificarCobro(undefined, undefined)).toMatchObject({ tipo: 'detenido', esperado: null });
  });
});
