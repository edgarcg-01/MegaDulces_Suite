/**
 * `[LE.CU.2]` — Pruebas del balance físico. El caso central es la ventana medida en prod
 * (12-oct → 3-nov, §36.4): tiene que salir «faltan $48,047.70», con el bulto aparte.
 */
import { balanceFisico, separaBulto, MORRALLA_TOPE } from './caja-balance-fisico.engine';

describe('separaBulto', () => {
  it('la morralla de hasta 49¢ es efectivo contado', () => {
    expect(separaBulto({ piezas: 3340, morralla: 0.5 - 0.01 })).toEqual({ contado: 3340.49, bulto: 0 });
    expect(MORRALLA_TOPE).toBe(0.49);
  });

  it('NEGATIVA: un monto tecleado como morralla NO se cuenta como efectivo (corte del 3-nov)', () => {
    expect(separaBulto({ piezas: 116, morralla: 188560 })).toEqual({ contado: 116, bulto: 188560 });
  });
});

describe('balanceFisico', () => {
  const ventana = {
    inicial: { cajon: 3327.5, boveda: 342500 },
    ingresos: 5250595.4,
    gastos: 5548199.2,
    final: { conteo: { piezas: 116, morralla: 188560 }, boveda: 60 },
  };

  it('reproduce §36.4: esperado $48,223.70, contado $176, faltan $48,047.70', () => {
    expect(balanceFisico(ventana)).toEqual({
      esperado: 48223.7, contado: 176, diferencia: -48047.7, bulto: 188560, diferencia_si_bulto_es_efectivo: 140512.3, medible: true,
    });
  });

  it('el otro escenario se publica AL LADO: si el bulto fuera efectivo, sobran $140,512.30', () => {
    expect(balanceFisico(ventana).diferencia_si_bulto_es_efectivo).toBe(140512.3);
  });

  it('NEGATIVA: el error de §36.4 (sumar por fecha y perder $50,154.40 de ingresos) cambia el signo', () => {
    // Con los ingresos de la primera medición el balance «sobraba» $2,106.70: la prueba deja escrito
    // cuánto pesa un renglón fuera de su corte.
    expect(balanceFisico({ ...ventana, ingresos: 5200441 }).diferencia).toBe(2106.7);
  });

  it('NEGATIVA: sin la bóveda de un extremo no hay balance, y se dice', () => {
    expect(balanceFisico({ ...ventana, final: { ...ventana.final, boveda: null } })).toMatchObject({ medible: false, diferencia: null, bulto: 188560 });
  });
});
