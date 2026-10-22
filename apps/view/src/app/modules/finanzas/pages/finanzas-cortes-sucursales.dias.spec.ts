import type { CorteRow } from '@megadulces/contracts';
import { agruparCortesPorDia } from './finanzas-cortes-sucursales.component';

/**
 * `[CSU.15]` La lista principal de Cortes/Sucursales engloba los cortes **por día de sucursal**,
 * con el total que hasta hoy se sumaba a mano.
 *
 * Medido en prod (octubre 2026): **595 cortes en 169 días-sucursal**, 3.5 cortes por renglón y
 * hasta 8 en el más cargado. Ésa es la lista que la persona recorre.
 *
 * ⛔ **Lo que este candado cuida es que el total del renglón sea el de los cortes que se
 * despliegan debajo.** Si el agrupado tomara el universo completo en vez de la lista ya filtrada,
 * el día diría «$205,597.68» y debajo se verían dos cortes que suman otra cosa — un número que no
 * cuadra con su propio detalle es peor que no tenerlo. Por eso `agruparCortesPorDia` recibe lo que
 * se ve, y el caso «suma exactamente lo que agrupó» es el que lo fija.
 */
function corte(p: Partial<CorteRow>): CorteRow {
  return {
    clave: `${p.sucursal ?? '05'}-UD2301-${p.folio ?? '0000012'}`, sucursal: '05', sucursal_nombre: 'Zamora Centro',
    documento: `UD2301-${p.folio ?? '0000012'}`, folio: '0000012', fecha: '2026-10-13', referencia: 'Caja 2-296',
    caja: '2', turno: '296', monto: 1000, cobrado: 0, saldo: 1000, estado_cobro: 'sin_cobro',
    cobros: [], cobros_cancelados: [], devoluciones: [], devoluciones_total: 0, arqueo: null, cuadre: 'sin_arqueo', diferencia: null,
    ...p,
  } as CorteRow;
}

describe('[CSU.15] los cortes se engloban por día de sucursal', () => {
  it('un día con varios cortes es UN renglón', () => {
    const dias = agruparCortesPorDia([
      corte({ folio: '0000001' }), corte({ folio: '0000002' }), corte({ folio: '0000003' }),
    ]);
    expect(dias).toHaveLength(1);
    expect(dias[0].cortes).toHaveLength(3);
  });

  it('⭐ el total del renglón es exactamente la suma de los cortes que lleva adentro', () => {
    const dias = agruparCortesPorDia([
      corte({ folio: '0000001', monto: 205_597.68, cobrado: 205_597.68, saldo: 0, estado_cobro: 'cobrado' }),
      corte({ folio: '0000002', monto: 79_302.11, cobrado: 0, saldo: 79_302.11 }),
    ]);
    const d = dias[0];
    expect(d.monto).toBeCloseTo(284_899.79, 2);
    expect(d.cobrado).toBeCloseTo(205_597.68, 2);
    expect(d.saldo).toBeCloseTo(79_302.11, 2);
    // …y lo mismo recalculado desde el detalle que se despliega: si divergen, el renglón miente.
    expect(d.cortes.reduce((t, c) => t + c.monto, 0)).toBeCloseTo(d.monto, 2);
    expect(d.cortes.reduce((t, c) => t + c.saldo, 0)).toBeCloseTo(d.saldo, 2);
  });

  it('⛔ el mismo día en dos sucursales son DOS renglones: un total mezclado no se cuadra contra nada', () => {
    const dias = agruparCortesPorDia([
      corte({ sucursal: '01', sucursal_nombre: 'Padre Hidalgo', folio: '0000001' }),
      corte({ sucursal: '02', sucursal_nombre: 'Ocho Esquinas', folio: '0000002' }),
    ]);
    expect(dias).toHaveLength(2);
    expect(dias.map((d) => d.sucursal)).toEqual(['02', '01']); // dentro del día, por nombre
  });

  it('la misma sucursal en dos días son dos renglones, el más reciente primero', () => {
    const dias = agruparCortesPorDia([
      corte({ fecha: '2026-10-13', folio: '0000001' }),
      corte({ fecha: '2026-10-14', folio: '0000002' }),
    ]);
    expect(dias.map((d) => d.fecha)).toEqual(['2026-10-14', '2026-10-13']);
  });

  it('cuenta los cortes por cobrar del día, y no cuenta los centavos de redondeo como pendiente', () => {
    const dias = agruparCortesPorDia([
      corte({ folio: '0000001', cobrado: 1000, saldo: 0, estado_cobro: 'cobrado' }),
      corte({ folio: '0000002', cobrado: 999.999, saldo: 0.001, estado_cobro: 'cobrado' }),
      corte({ folio: '0000003', cobrado: 0, saldo: 1000 }),
    ]);
    expect(dias[0].pendientes).toBe(1);
  });

  it('señala cuántos cortes del día no cuadran en el arqueo (y «sin arqueo» no es descuadre)', () => {
    const dias = agruparCortesPorDia([
      corte({ folio: '0000001', cuadre: 'faltante_arqueo', diferencia: -9000 }),
      corte({ folio: '0000002', cuadre: 'sobrante_arqueo', diferencia: 50 }),
      corte({ folio: '0000003', cuadre: 'sin_arqueo' }),
      corte({ folio: '0000004', cuadre: 'cuadra' }),
    ]);
    expect(dias[0].descuadrados).toBe(2);
  });

  it('la llave del renglón distingue día y sucursal (es la que abre y cierra el detalle)', () => {
    const dias = agruparCortesPorDia([corte({ fecha: '2026-10-13', sucursal: '07' })]);
    expect(dias[0].clave).toBe('2026-10-13|07');
  });

  it('sin cortes no inventa renglones', () => {
    expect(agruparCortesPorDia([])).toEqual([]);
  });

  it('PRUEBA NEGATIVA: agrupar sólo por fecha mezclaría sucursales — el renglón dejaría de cuadrar', () => {
    const cortes = [
      corte({ sucursal: '01', sucursal_nombre: 'Padre Hidalgo', folio: '0000001', monto: 205_597.68, saldo: 205_597.68 }),
      corte({ sucursal: '02', sucursal_nombre: 'Ocho Esquinas', folio: '0000002', monto: 79_302.11, saldo: 79_302.11 }),
    ];
    const dias = agruparCortesPorDia(cortes);
    // El grano correcto NO produce un renglón con la suma de las dos plazas.
    expect(dias.some((d) => Math.abs(d.monto - 284_899.79) < 0.01)).toBe(false);
    expect(dias.map((d) => d.monto).sort((a, b) => a - b)).toEqual([79_302.11, 205_597.68]);
  });
});
