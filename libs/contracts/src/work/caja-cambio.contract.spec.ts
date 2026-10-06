import { evaluarCambio, aFilasDenominacion, CAMBIO_EPSILON } from './caja-cambio.contract';
import { valorDe } from '../money/denominations';

/**
 * `[CG.38]` Lo que se prueba acá no es la aritmética: es que **ningún peso se vaya sin nombre**.
 * Por eso casi todas las pruebas son negativas — el motor vale por lo que se niega a aceptar.
 */
describe('[CG.38] el cambio de Caja General', () => {
  it('un cobro normal sin cambio: lo que entra es el neto', () => {
    const r = evaluarCambio({ '500': 9, '100': 3, '20': 1 }, null, 10);
    expect(r.entra).toBe(4830);        // 4500 + 300 + 20 + 10 de morralla suelta
    expect(r.sale).toBe(0);
    expect(r.neto).toBe(4830);
    expect(r.problema).toBeNull();
  });

  it('devuelve cambio al que paga: el neto baja y las DOS pilas quedan guardadas', () => {
    //  Le dan 10 billetes de $500 por un documento de $4,830 y regresa $170.
    const r = evaluarCambio({ '500': 10 }, { '100': 1, '50': 1, '20': 1 });
    expect(r.entra).toBe(5000);
    expect(r.sale).toBe(170);
    expect(r.neto).toBe(4830);
    expect(r.problema).toBeNull();
  });

  it('canje: un billete de $500 por morralla, neto cero y cuadra', () => {
    const r = evaluarCambio({ '500': 1 }, { '10': 30, '5': 40 }, 0, true);
    expect(r.entra).toBe(500);
    expect(r.sale).toBe(500);
    expect(r.neto).toBe(0);
    expect(r.problema).toBeNull();
  });

  /**
   * ⭐ La prueba que da sentido a la fase. Un canje que no cuadra no es un canje: es dinero
   * que se fue de la caja. El motor tiene que NOMBRARLO con su monto.
   */
  it('⛔ [negativa] un canje que NO cuadra se nombra con su monto, no se acepta callado', () => {
    //  Entra un billete de $500, salen $480 en monedas. Faltan $20 que nadie va a ver.
    const r = evaluarCambio({ '500': 1 }, { '10': 30, '5': 36 }, 0, true);
    expect(r.entra).toBe(500);
    expect(r.sale).toBe(480);
    expect(r.problema).toContain('20.00');
    expect(r.problema).toContain('de más');
  });

  it('⛔ [negativa] el canje al revés también: salió más de lo que entró', () => {
    const r = evaluarCambio({ '100': 1 }, { '50': 3 }, 0, true);
    expect(r.problema).toContain('50.00');
    expect(r.problema).toContain('se fue de la caja');
  });

  it('⛔ [negativa] devolver más de lo que entró no se guarda como monto negativo', () => {
    const r = evaluarCambio({ '100': 1 }, { '500': 1 });
    expect(r.neto).toBe(-400);
    expect(r.problema).toContain('400.00');
    expect(r.problema).toContain('canje');   // y se le dice qué hacer, no sólo que está mal
  });

  /**
   * Un movimiento normal con neto cero se vería como "no pasó nada" en todo cuadre: el monto
   * sería 0 y la fila quedaría fuera de cualquier suma. Es un canje sin marcar.
   */
  it('⛔ [negativa] entró y salió lo mismo sin marcar canje: se dice, no se guarda en 0', () => {
    const r = evaluarCambio({ '500': 1 }, { '100': 5 });
    expect(r.neto).toBe(0);
    expect(r.problema).toContain('canje');
  });

  it('⛔ [negativa] una llave que el catálogo no conoce se ENUMERA, no se suma como cero', () => {
    const r = evaluarCambio({ '500': 1, '3': 7 }, null);
    expect(r.desconocidas).toContain('3');
    expect(r.problema).toContain('3');
    expect(r.problema).toContain('no se pudieron contar');
  });

  it('⛔ [negativa] un canje vacío de los dos lados no es un canje', () => {
    const r = evaluarCambio(null, null, 0, true);
    expect(r.problema).toContain('no es un canje');
  });

  /**
   * ⚠️ La moneda y el billete de $20 valen lo mismo y son cosas distintas. Es el defecto que
   * SM.39 arregló en el catálogo y que la caja todavía arrastraba con su llave numérica.
   */
  it('⭐ la moneda de $20 y el billete de $20 conviven y suman por separado', () => {
    const r = evaluarCambio({ '20': 3, '20m': 4 }, null);
    expect(r.entra).toBe(140);
    expect(r.desconocidas).toEqual([]);

    const filas = aFilasDenominacion({ '20': 3, '20m': 4 }, valorDe);
    expect(filas).toHaveLength(2);                                  // DOS filas, no una
    expect(filas.every((f) => f.denominacion === 20)).toBe(true);   // mismo valor
    expect(filas.map((f) => f.denom_key).sort()).toEqual(['20', '20m']);
  });

  it('las piezas en cero no son una fila: teclear 0 es no haberlo capturado', () => {
    expect(aFilasDenominacion({ '500': 0, '100': 2 }, valorDe)).toEqual([
      { denom_key: '100', denominacion: 100, piezas: 2 },
    ]);
  });

  it('la tolerancia es de un CENTAVO, y es redondeo — no una diferencia de negocio', () => {
    expect(CAMBIO_EPSILON).toBeLessThan(0.01);
    // 50¢ × 3 contra $1 × 1 + 50¢ × 1 = 1.50 de los dos lados, sin residuo de punto flotante.
    const r = evaluarCambio({ '0.5': 3 }, { '1': 1, '0.5': 1 }, 0, true);
    expect(r.problema).toBeNull();
  });
});
