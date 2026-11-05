/**
 * `[LE.CU.2]` — Pruebas de los huecos de Caja General. Los casos son movimientos reales de §36
 * (2026-11-04). Las negativas importan más: cada forma de contar mal un hueco es dinero que se
 * vuelve invisible o se cobra dos veces.
 */
import { armaHuecos, clasificaHueco, resumeHuecos, type HuecoEntrada } from './caja-huecos.engine';

const e = (p: Partial<HuecoEntrada> & Pick<HuecoEntrada, 'tipo' | 'ref' | 'monto'>): HuecoEntrada => ({ fecha: '2026-10-31', etiqueta: p.ref, ...p });

describe('clasificaHueco', () => {
  it('un cobro de Kepler sin captura es de caja, se captura y tiene certeza alta (casó por llave)', () => {
    const h = clasificaHueco(e({ tipo: 'kepler_sin_libro', ref: '07|U-A-5|0000224|0011', monto: 44097.07, via: 'llave', testigos: { corte: 'si', cobro: 'si', libro: 'no' } }));
    expect(h).toMatchObject({ dueno: 'caja', accion: 'capturar', certeza: 'alta', falta: true });
    expect(h?.testigos).toMatchObject({ venta: 'na', corte: 'si', cobro: 'si', libro: 'no' });
  });

  it('NEGATIVA: lo que casó sólo por importe es por confirmar, aunque cuadre al centavo', () => {
    expect(clasificaHueco(e({ tipo: 'kepler_sin_libro', ref: 'x', monto: 100, via: 'importe' }))?.certeza).toBe('por_confirmar');
  });

  it('la ruta 23 del 19-oct: corregir, alta, porque cobro y bóveda dicen lo mismo contra el libro', () => {
    const h = clasificaHueco(e({ tipo: 'captura_distinta', fecha: '2026-10-19', ref: 'CI-2026-00111', monto: 30360, testigos: { cobro: 'si', boveda: 'si', libro: 'difiere' } }));
    expect(h).toMatchObject({ dueno: 'caja', accion: 'corregir', certeza: 'alta' });
  });

  it('NEGATIVA: con un solo testigo contra el libro, corregir es certeza media', () => {
    expect(clasificaHueco(e({ tipo: 'captura_distinta', ref: 'y', monto: 50, testigos: { cobro: 'si', libro: 'difiere' } }))?.certeza).toBe('media');
  });

  it('una salida que sólo anota Control es alta si la bóveda la vio salir, y por confirmar si no', () => {
    expect(clasificaHueco(e({ tipo: 'salida_sin_documento', ref: 'A23718', monto: 119726, testigos: { control: 'si', boveda: 'si', libro: 'no' } }))?.certeza).toBe('alta');
    expect(clasificaHueco(e({ tipo: 'salida_sin_documento', ref: 'A23699', monto: 170000, testigos: { control: 'si', libro: 'no' } }))?.certeza).toBe('por_confirmar');
  });

  it('un corte sin cobro dentro del atraso normal de su sucursal todavía no es hueco', () => {
    expect(clasificaHueco(e({ tipo: 'corte_sin_cobro', ref: '08|0000163', monto: 54506.76, atraso_dias: 1, atraso_p90: 9 }))).toBeNull();
    expect(clasificaHueco(e({ tipo: 'corte_sin_cobro', ref: '07|0000091', monto: 81202.68, atraso_dias: 6, atraso_p90: 5 }))).toMatchObject({ dueno: 'sucursal', accion: 'pedir_sucursal' });
  });

  it('NEGATIVA: sin atraso medido, un corte sin cobro no se acusa', () => {
    expect(clasificaHueco(e({ tipo: 'corte_sin_cobro', ref: 'z', monto: 10 }))).toBeNull();
  });

  it('lo capturado sin liga y el bulto sin contar NO cuentan como dinero faltante', () => {
    expect(clasificaHueco(e({ tipo: 'libro_sin_ligar', ref: 'CI-2026-00024', monto: 18132, via: 'identidad' }))).toMatchObject({ falta: false, accion: 'ligar', certeza: 'alta' });
    expect(clasificaHueco(e({ tipo: 'bulto_sin_contar', ref: 'CC-2026-00020', monto: 188560 }))).toMatchObject({ falta: false, accion: 'contar', certeza: 'por_confirmar' });
  });
});

describe('armaHuecos / resumeHuecos', () => {
  it('NEGATIVA: la misma llave por dos caminos es UN hueco, el que primero puede cerrarlo', () => {
    // El depósito de ruta 23 del 13-oct: capturado dos veces Y sin pareja en Kepler. Es un error de
    // captura; contarlo además como «libro sin Kepler» lo cobraría dos veces.
    const hs = armaHuecos([
      e({ tipo: 'libro_sin_kepler', ref: 'CI-2026-00022', monto: 21101 }),
      e({ tipo: 'captura_doble', ref: 'CI-2026-00022', monto: 21101 }),
    ]);
    expect(hs.map((h) => h.tipo)).toEqual(['captura_doble']);
  });

  it('ordena lo más nuevo primero y, el mismo día, el más grande', () => {
    const hs = armaHuecos([
      e({ tipo: 'kepler_sin_libro', ref: 'a', monto: 10, fecha: '2026-10-28' }),
      e({ tipo: 'kepler_sin_libro', ref: 'b', monto: 5, fecha: '2026-10-31' }),
      e({ tipo: 'kepler_sin_libro', ref: 'c', monto: 50, fecha: '2026-10-31' }),
    ]);
    expect(hs.map((h) => h.ref)).toEqual(['c', 'b', 'a']);
  });

  it('el resumen separa lo que falta de lo que espera liga o conteo, y cuenta lo no seguro', () => {
    const r = resumeHuecos(armaHuecos([
      e({ tipo: 'kepler_sin_libro', ref: 'k', monto: 44097.07, via: 'llave' }),
      e({ tipo: 'venta_sin_cobro', ref: 'ruta 505|2026-10-19', monto: 13598 }),
      e({ tipo: 'salida_sin_documento', ref: 'A23699', monto: 170000, testigos: { control: 'si' } }),
      e({ tipo: 'libro_sin_ligar', ref: 'l', monto: 18132, via: 'identidad' }),
      e({ tipo: 'bulto_sin_contar', ref: 'b', monto: 188560 }),
    ]));
    expect(r.falta).toEqual({ n: 3, monto: 227695.07 });
    expect(r.por_dueno.caja).toEqual({ n: 1, monto: 44097.07 });
    expect(r.por_dueno.ruta).toEqual({ n: 1, monto: 13598 });
    expect(r.por_dueno.direccion).toEqual({ n: 1, monto: 170000 });
    expect(r.por_ligar).toEqual({ n: 1, monto: 18132 });
    expect(r.sin_contar).toEqual({ n: 1, monto: 188560 });
    expect(r.por_confirmar_n).toBe(1);
  });
});
