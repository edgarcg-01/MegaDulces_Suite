// Sin `import ... from 'vitest'`: la config usa `globals: true`.
import { clasificarMovimiento, type DocumentoAClasificar } from './excepciones-movimientos.contract';

const c = (d: DocumentoAClasificar) => clasificarMovimiento(d);

describe('[MX.1.4] clasificarMovimiento — sólo lo que el motor no puede dar por bueno va a la bandeja', () => {
  it('⛔ un traspaso que cuadra NO va (es el 90.7 % de lo que hoy se audita a mano)', () => {
    expect(c({ doc_code: 'TrsfRcv', transfer_status: 'completado' })).toEqual({ estado: 'cuadrado', excepciones: [], a_bandeja: false });
  });

  it('en tránsito y «a ruta o cliente» todavía no son excepción', () => {
    expect(c({ doc_code: 'TrsfShip', transfer_status: 'en_transito' }).a_bandeja).toBe(false);
    expect(c({ doc_code: 'TrsfShip', transfer_status: 'sin_recepcion_esperada' }).a_bandeja).toBe(false);
  });

  it('diferencia, sin acuse y sin origen SÍ van', () => {
    expect(c({ doc_code: 'TrsfShip', transfer_status: 'diferencia' }).excepciones).toEqual(['diferencia']);
    expect(c({ doc_code: 'TrsfShip', transfer_status: 'sin_acuse' }).excepciones).toEqual(['sin_acuse']);
    expect(c({ doc_code: 'TrsfRcv', transfer_status: 'sin_origen' }).excepciones).toEqual(['sin_origen']);
  });

  it('un ajuste de inventario va SIEMPRE (D3)', () => {
    expect(c({ doc_code: 'InvOut1' })).toEqual({ estado: 'excepcion', excepciones: ['ajuste_inventario'], a_bandeja: true });
    expect(c({ doc_code: 'InvIn1' }).a_bandeja).toBe(true);
  });

  it('⛔ lo que el motor no compara es «sin comparación», nunca «cuadrado»', () => {
    for (const doc_code of ['EntryOr1', 'ApEntOr1', 'Sale2', 'PhysInvIn', 'RtrnPur1', 'WIN_V']) {
      expect(c({ doc_code })).toEqual({ estado: 'sin_comparacion', excepciones: [], a_bandeja: false });
    }
    // un traspaso sin veredicto tampoco se da por bueno
    expect(c({ doc_code: 'TrsfShip' }).estado).toBe('sin_comparacion');
  });

  it('el importe incompleto se SUMA a lo que ya sea: un traspaso que cuadra con dinero sin verificar sí va', () => {
    expect(c({ doc_code: 'TrsfShip', transfer_status: 'completado', lineas_sin_importe: 2 }))
      .toEqual({ estado: 'excepcion', excepciones: ['importe_incompleto'], a_bandeja: true });
    expect(c({ doc_code: 'TrsfShip', transfer_status: 'diferencia', lineas_sin_importe: 1 }).excepciones)
      .toEqual(['diferencia', 'importe_incompleto']);
    // en lo que no se compara, el importe incompleto no inventa una excepción
    expect(c({ doc_code: 'EntryOr1', lineas_sin_importe: 3 }).a_bandeja).toBe(false);
  });
});
