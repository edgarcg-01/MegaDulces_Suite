import { calcularCorte, type MovimientoDelCorte } from './cash-cut.engine';

/**
 * `[CGP-V.9]` Contar CERO con confirmación explícita.
 *
 * Con la caja en $0 el conteo no se podía sellar: una reja vacía se lee como «no se contó»
 * (`sin_contar`), y ese corte no se podía cerrar nunca. Pero «no se contó» y «se contó y no hay
 * efectivo» son dos hechos distintos (ADR-056): el segundo se DECLARA, y entonces es un conteo.
 */
const ingreso = (monto: number): MovimientoDelCorte => ({ tipo: 'ingreso', monto } as MovimientoDelCorte);

describe('[CGP-V.9] calcularCorte con cero declarado', () => {
  it('⛔ [negativa] la reja vacía SIN declarar sigue siendo «no se contó»', () => {
    const t = calcularCorte({ fondoInicial: 0, movimientos: [], conteo: [], morralla: 0 });
    expect(t.veredicto).toBe('sin_contar');
  });

  it('cero declarado con esperado cero: cuadra', () => {
    const t = calcularCorte({ fondoInicial: 0, movimientos: [], conteo: [], morralla: 0, ceroDeclarado: true });
    expect(t).toMatchObject({ contado: 0, esperado: 0, diferencia: 0, veredicto: 'cuadra' });
  });

  it('cero declarado con esperado de $500: falta $500 — se registra, no se esconde', () => {
    const t = calcularCorte({ fondoInicial: 0, movimientos: [ingreso(500)], conteo: [], morralla: 0, ceroDeclarado: true });
    expect(t).toMatchObject({ contado: 0, esperado: 500, diferencia: -500, veredicto: 'falta' });
  });

  it('⛔ declarar cero con piezas en la reja NO las borra: cuenta lo que hay', () => {
    // El servicio rechaza la contradicción antes; el motor no inventa un cero sobre piezas reales.
    const t = calcularCorte({
      fondoInicial: 0, movimientos: [], morralla: 0, ceroDeclarado: true,
      conteo: [{ denom_key: '100', denominacion: 100, piezas: 2 }],
    });
    expect(t.contado).toBe(200);
  });
});
