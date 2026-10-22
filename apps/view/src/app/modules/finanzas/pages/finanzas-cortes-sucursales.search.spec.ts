import { filtrarPorBusqueda } from '@megadulces/ui-web';
import type { CorteRow } from '@megadulces/contracts';
import { camposBuscablesDeCorte, consultaDeCortes, variantesDeFolio } from './finanzas-cortes-sucursales.component';

/**
 * `[CSU.13]` El buscador de Cortes/Sucursales encuentra un corte por lo que una persona trae en la mano.
 *
 * Se prueba la función de campos con el filtro REAL de la suite (`filtrarPorBusqueda`, la misma semántica
 * que `applySmartSearch` del servidor), no una copia: si cualquiera de los dos cambia, esto se entera.
 */
function corte(p: Partial<CorteRow>): CorteRow {
  return {
    clave: `${p.sucursal ?? '05'}-UD2301-${p.folio ?? '0000012'}`, sucursal: '05', sucursal_nombre: 'Zamora Centro',
    documento: `UD2301-${p.folio ?? '0000012'}`, folio: '0000012', fecha: '2026-10-04', referencia: 'Caja 2-296',
    caja: '2', turno: '296', monto: 1203.36, cobrado: 0, saldo: 1203.36, estado_cobro: 'sin_cobro',
    cobros: [], cobros_cancelados: [], devoluciones: [], devoluciones_total: 0, arqueo: null, cuadre: 'sin_arqueo', diferencia: null,
    ...p,
  } as CorteRow;
}

const CORTES: CorteRow[] = [
  corte({}),
  corte({
    sucursal: '06', sucursal_nombre: 'Canindo', folio: '0000033', documento: 'UD2301-0000033', referencia: 'Caja 1-40',
    caja: '1', turno: '40', monto: 12834, cobrado: 12834, saldo: 0, estado_cobro: 'cobrado', cuadre: 'faltante_arqueo', diferencia: -9000,
    cobros: [{ doc_prefix: 'UA0501', folio: '0000076', fecha: '2026-10-12', monto: 1867, forma_pago: 'tarjeta', concepto: 'VTA DEL 10-10-26',
      medio_cobro: 'banco', cuenta_tesoreria: 'BANORTE 1234' }],
    devoluciones: [{ doc_prefix: 'UA2101', folio: '0000071', fecha: '2026-10-12', monto: 179.92, cliente: 'PÚBLICO EN GENERAL', motivo: 'DEVOLUCIÓN', cajero: 'MARIA' }],
  } as Partial<CorteRow>),
];

// Igual que la pantalla: la consulta pasa por `consultaDeCortes` antes del filtro canónico.
const buscar = (q: string): string[] => filtrarPorBusqueda(CORTES, consultaDeCortes(q), camposBuscablesDeCorte).map((c) => c.documento);

describe('[CSU.13] buscador de cortes', () => {
  it('encuentra por folio completo y SIN ceros', () => {
    expect(buscar('UD2301-0000033')).toEqual(['UD2301-0000033']);
    expect(buscar('33')).toEqual(['UD2301-0000033']);
  });

  it('⚠️ declarado: un número corto también casa con MONTOS — cada palabra es un fragmento en todos los campos', () => {
    // «12» es el folio 0000012 y también está dentro de $12,834.00: salen los dos. Es la semántica de la
    // suite (la del servidor), no un defecto; para ir directo, el folio completo o «12 zamora».
    expect(buscar('12')).toEqual(['UD2301-0000012', 'UD2301-0000033']);
    expect(buscar('12 zamora')).toEqual(['UD2301-0000012']);
  });

  it('encuentra por caja-turno como se ve en la tabla', () => {
    expect(buscar('2-296')).toEqual(['UD2301-0000012']);
  });

  it('encuentra por monto como se ve («1,203» encuentra $1,203.36)', () => {
    expect(buscar('1,203')).toEqual(['UD2301-0000012']);
  });

  it('encuentra por lo que trae el COBRO aplicado: folio, forma de pago, cuenta', () => {
    expect(buscar('UA0501-0000076')).toEqual(['UD2301-0000033']);
    expect(buscar('76')).toEqual(['UD2301-0000033']);
    expect(buscar('tarjeta')).toEqual(['UD2301-0000033']);
    expect(buscar('banorte')).toEqual(['UD2301-0000033']);
  });

  it('encuentra por el estado y la diferencia del cuadre', () => {
    expect(buscar('faltante')).toEqual(['UD2301-0000033']);
    expect(buscar('sin cobro')).toEqual(['UD2301-0000012']);
  });

  it('sin acentos y con las palabras en cualquier orden, en campos distintos', () => {
    expect(buscar('devolucion publico')).toEqual(['UD2301-0000033']);
    expect(buscar('canindo tarjeta')).toEqual(['UD2301-0000033']);
    expect(buscar('tarjeta canindo')).toEqual(['UD2301-0000033']);
  });

  it('un folio se compara por NÚMERO: letras al revés, tipo sin ceros y otra cantidad de ceros', () => {
    // Como lo escribió el PM el 2026-10-21 para el cobro UA0501-0000076.
    expect(buscar('au501-00076')).toEqual(['UD2301-0000033']);
    expect(buscar('UA0501-0000076')).toEqual(['UD2301-0000033']);
    expect(buscar('ua501-76')).toEqual(['UD2301-0000033']);
    expect(buscar('ua51-76')).toEqual(['UD2301-0000033']);
    expect(buscar('du2301-33')).toEqual(['UD2301-0000033']);
    // ⚠️ El número es EXACTO: el folio 7 no trae el 76, ni el 761.
    expect(buscar('au501-7')).toEqual([]);
    expect(buscar('au501-761')).toEqual([]);
  });

  it('las variantes y la consulta llegan a la MISMA forma corta', () => {
    expect(variantesDeFolio('UA0501', '0000076')).toEqual(['UA0501-76#', 'UA501-76#', 'UA51-76#', 'AU0501-76#', 'AU501-76#', 'AU51-76#']);
    expect(consultaDeCortes('au501-00076 canindo')).toBe('au501-76# canindo');
    expect(variantesDeFolio(null, '1')).toEqual([]);
    expect(variantesDeFolio('UA0501', 'ABC')).toEqual([]);
  });

  it('vacío muestra todo; lo que no existe no trae nada', () => {
    expect(buscar('')).toHaveLength(2);
    expect(buscar('   ')).toHaveLength(2);
    expect(buscar('zzz-no-existe')).toEqual([]);
    // Las dos palabras tienen que estar en el MISMO corte: Zamora no tiene tarjeta.
    expect(buscar('zamora tarjeta')).toEqual([]);
  });
});

/**
 * El corte REAL de prod que motivó la normalización: 06/UD2301-0000033 (leído en sólo lectura el 2026-10-21),
 * con sus cuatro cobros VIVOS y, desde [CSU.13], el 0000075 que se canceló en Kepler: viene aparte y no suma.
 */
const REAL: CorteRow = corte({
  sucursal: '06', sucursal_nombre: 'Canindo', folio: '0000033', documento: 'UD2301-0000033', fecha: '2026-10-10',
  referencia: 'Caja 3-65', caja: '3', turno: '65', monto: 36407.84, cobrado: 36407.84, saldo: 0, estado_cobro: 'cobrado',
  cobros: [
    { doc_prefix: 'UA0501', folio: '0000072', fecha: '2026-10-14', monto: 23420, forma_pago: 'otro', concepto: 'VTA DEL 10-10-26', medio_cobro: 'banco', cuenta_tesoreria: 'BANORTE 7133' },
    { doc_prefix: 'UA0501', folio: '0000076', fecha: '2026-10-12', monto: 1867, forma_pago: 'otro', concepto: 'VTA DEL 10-10-26', medio_cobro: 'banco', cuenta_tesoreria: 'SANTANDER 2169' },
    { doc_prefix: 'UA0501', folio: '0000081', fecha: '2026-10-12', monto: 6746.82, forma_pago: 'tarjeta', concepto: 'VTA DEL 10-10-26 EN TARJETA', medio_cobro: 'banco', cuenta_tesoreria: 'BBVA  4885' },
    { doc_prefix: 'UA0501', folio: '0000088', fecha: '2026-10-15', monto: 4374.02, forma_pago: 'otro', concepto: 'VENTA DEL 10-10-26', medio_cobro: 'banco', cuenta_tesoreria: 'BAJIO 5854' },
  ],
  cobros_cancelados: [{ doc_prefix: 'UA0501', folio: '0000075', fecha: '2026-10-08', monto: 10962, concepto: 'VTA 10-10-26' }],
} as Partial<CorteRow>);

describe('[CSU.13] el caso reportado, con el corte real de prod', () => {
  const en = (q: string) => filtrarPorBusqueda([REAL], consultaDeCortes(q), camposBuscablesDeCorte).length;
  it('«au501-00076» encuentra el corte del cobro UA0501-0000076', () => {
    expect(en('au501-00076')).toBe(1);
    expect(en('santander 2169')).toBe(1);
  });
  it('[CSU.13] el cobro CANCELADO (0000075) SÍ se encuentra: por folio, por monto y por la palabra «cancelado»', () => {
    expect(en('au501-00075')).toBe(1);
    expect(en('10,962')).toBe(1);
    expect(en('cancelado')).toBe(1);
    expect(en('cancelado canindo')).toBe(1);
  });
  it('un corte SIN cancelados no sale al buscar «cancelado»', () => {
    expect(filtrarPorBusqueda(CORTES, consultaDeCortes('cancelado'), camposBuscablesDeCorte)).toEqual([]);
  });
});
