/**
 * `[PGP.232]` La cobertura del programa de pagos: cuánto de lo que Kepler pagó había pasado por el Calendario.
 *
 * Vectores SINTÉTICOS (el repo es público) con la FORMA de lo medido en prod el 2026-11-27: el pago por banco que
 * el Calendario programó, el que salió sin programarse, el pago en EFECTIVO desde la caja de la sucursal (que el
 * Calendario no programa y que, sumado a los de banco, hundía la cobertura del 94.9 % al 49 %), el anticipo sin
 * factura y el acreedor de gasto.
 */
import {
  PAGO_FUERA_GRANDE, coberturaDelPrograma,
  type PagoKeplerBanco, type PartidaDelPrograma,
} from './salida-proveedor.contract';

const pago = (o: Partial<PagoKeplerBanco> & { id: string }): PagoKeplerBanco => ({
  sucursal: '00', doc_tipo: 'X-D-26', folio: o.id, account_label: 'A1', banco_nombre: 'BANCO A1', tipo_cuenta: 'banco',
  fecha: '2030-03-10', fecha_captura: '2030-03-11', importe: 1000, acreedor: 'CP001',
  acreedor_nombre: 'DULCES PRUEBA SA DE CV', facturas: ['f1'], ...o,
});
const partida = (o: Partial<PartidaDelPrograma> & { id: string }): PartidaDelPrograma => ({
  estado: 'pending', dia: '2030-03-10', alta: '2030-03-08', baja: null, monto: 1000, facturas: ['f1'], ...o,
});
const entrada = (pagos: PagoKeplerBanco[], partidas: PartidaDelPrograma[] = []) =>
  ({ hoy: '2030-03-31', desde: '2030-03-01', hasta: '2030-03-31', pagos, partidas });

describe('[PGP.232] coberturaDelPrograma', () => {
  it('cuenta el pago por banco que estaba en el programa y el que no', () => {
    const r = coberturaDelPrograma(entrada(
      [pago({ id: 'p1' }), pago({ id: 'p2', importe: 3000, facturas: ['f9'] })],
      [partida({ id: 'a1' })],
    ));
    expect(r).toMatchObject({ pagos: 2, monto: 4000, pagos_en_programa: 1, monto_en_programa: 1000, pagos_fuera: 1, monto_fuera: 3000 });
  });

  it('⛔ el pago desde CAJA no se mezcla con el de banco: va aparte, aunque nunca pase por el Calendario', () => {
    const r = coberturaDelPrograma(entrada(
      [pago({ id: 'p1' }), pago({ id: 'caja1', tipo_cuenta: 'caja', importe: 50_000, facturas: ['f7'] })],
      [partida({ id: 'a1' })],
    ));
    // Si se mezclaran, la cobertura caería a 1 de 2 (50 %) por un dinero que el Calendario no programa.
    expect(r).toMatchObject({ pagos: 1, monto: 1000, pagos_en_programa: 1, pagos_fuera: 0 });
    expect(r.otros_universos).toEqual([
      { universo: 'caja', pagos: 1, monto: 50_000, pagos_en_programa: 0, monto_en_programa: 0 },
    ]);
  });

  it('la cuenta puente (factoraje, devoluciones) también se dice aparte', () => {
    const r = coberturaDelPrograma(entrada([pago({ id: 'x1', tipo_cuenta: 'puente', importe: 70 })]));
    expect(r.pagos).toBe(0);
    expect(r.otros_universos).toEqual([{ universo: 'otra', pagos: 1, monto: 70, pagos_en_programa: 0, monto_en_programa: 0 }]);
  });

  it('deja fuera del universo el gasto, el futuro, lo de otra ventana y el importe en cero', () => {
    const r = coberturaDelPrograma(entrada([
      pago({ id: 'gasto', acreedor: 'GA001', importe: 9999 }),
      pago({ id: 'futuro', fecha: '2030-04-02', importe: 8888 }),
      pago({ id: 'otroMes', fecha: '2030-02-02', importe: 7777 }),
      pago({ id: 'cero', importe: 0 }),
      pago({ id: 'bueno' }),
    ], [partida({ id: 'a1' })]));
    expect(r).toMatchObject({ pagos: 1, monto: 1000, pagos_en_programa: 1 });
  });

  it('nombra los pagos grandes que quedaron fuera, de mayor a menor, y parte el resto por tramo', () => {
    const r = coberturaDelPrograma(entrada([
      pago({ id: 'g1', importe: 600_000, facturas: ['z1'], acreedor_nombre: 'BOLSAS PRUEBA' }),
      pago({ id: 'g2', importe: 150_000, facturas: ['z2'] }),
      pago({ id: 'chico', importe: 9_000, facturas: ['z3'] }),
      pago({ id: 'medio', importe: 20_000, facturas: ['z4'] }),
    ]));
    expect(r.grandes.map((g) => g.id)).toEqual(['g1', 'g2']);
    expect(r.grandes[0]).toMatchObject({ importe: 600_000, acreedor_nombre: 'BOLSAS PRUEBA', estado: 'no_programada' });
    expect(r.umbral).toBe(PAGO_FUERA_GRANDE);
    expect(r.por_tramo).toEqual([
      { tramo: 'mayor_500k', pagos: 1, monto: 600_000 },
      { tramo: 'de_100k_a_500k', pagos: 1, monto: 150_000 },
      { tramo: 'de_10k_a_100k', pagos: 1, monto: 20_000 },
      { tramo: 'menor_10k', pagos: 1, monto: 9_000 },
    ]);
  });

  it('un umbral distinto cambia a quién se nombra, no la cuenta', () => {
    const pagos = [pago({ id: 'g1', importe: 20_000, facturas: ['z1'] })];
    expect(coberturaDelPrograma({ ...entrada(pagos), umbral: 10_000 }).grandes).toHaveLength(1);
    expect(coberturaDelPrograma(entrada(pagos)).grandes).toHaveLength(0);
    expect(coberturaDelPrograma(entrada(pagos)).pagos_fuera).toBe(1);
  });

  it('la partida dada de alta DESPUÉS de pagar no cuenta como programada (se regularizó)', () => {
    const r = coberturaDelPrograma(entrada(
      [pago({ id: 'p1' })],
      [partida({ id: 'a1', alta: '2030-03-20' })],
    ));
    expect(r.pagos_en_programa).toBe(0);
    expect(r.grandes).toHaveLength(0);
    expect(r.por_tramo).toEqual([{ tramo: 'menor_10k', pagos: 1, monto: 1000 }]);
  });

  it('sin pagos, todo en cero y sin inventar universos', () => {
    const r = coberturaDelPrograma(entrada([]));
    expect(r).toMatchObject({ pagos: 0, monto: 0, pagos_en_programa: 0, pagos_fuera: 0, grandes: [], por_tramo: [], otros_universos: [] });
  });
});
