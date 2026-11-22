import { TOPE_SEGUNDOS_CAPTURA, capturaLimpia } from './quote-capture.contract';

describe('[COT.54] la captura que se guarda', () => {
  it('una captura normal pasa igual', () => {
    expect(capturaLimpia({ segundos: 312, busquedas: 14, recuperada: false })).toEqual({ segundos: 312, busquedas: 14, recuperada: false });
  });

  it('⭐ lo imposible se declara NO MEDIDO (null), no se recorta a algo creíble', () => {
    expect(capturaLimpia({ segundos: TOPE_SEGUNDOS_CAPTURA + 1, busquedas: 3, recuperada: false })).toBeNull(); // pestaña olvidada
    expect(capturaLimpia({ segundos: -5, busquedas: 3, recuperada: false })).toBeNull();
    expect(capturaLimpia({ segundos: 12.5, busquedas: 3, recuperada: false })).toBeNull();
    expect(capturaLimpia({ segundos: 60, busquedas: 3 })).toBeNull();
    expect(capturaLimpia({ segundos: '60', busquedas: 3, recuperada: false })).toBeNull();
  });

  it('sin captura (otro canal, cabecera sola): null', () => {
    expect(capturaLimpia(undefined)).toBeNull();
    expect(capturaLimpia(null)).toBeNull();
  });
});
