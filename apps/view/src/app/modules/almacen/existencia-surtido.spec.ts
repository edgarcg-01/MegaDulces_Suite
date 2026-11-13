import type { PresaleReviewStock } from '@megadulces/contracts';
import { avisoBuscarEnBodega, lecturaDeExistencia, sistemaSinProducto, textoSistema } from './existencia-surtido';

const S = (state: PresaleReviewStock['state'], qty: number | null, checked_at: string | null = '2026-11-13T15:50:00.000Z'): PresaleReviewStock =>
  ({ state, qty, checked_at });

describe('[MCP.23] existencia del sistema al surtir (las dos puertas dicen lo mismo)', () => {
  it('dice en palabras cada estado, en la unidad del renglón', () => {
    expect(textoSistema(S('con_existencia', 15), 'CJA')).toBe('Sistema: hay 15 CJA');
    expect(textoSistema(S('con_existencia', 0), 'CJA')).toBe('Sistema: menos de 1 CJA');
    expect(textoSistema(S('con_existencia', null), 'PAQ')).toBe('Sistema: sí hay');
    expect(textoSistema(S('agotado', 0), 'CJA')).toBe('Sistema: no hay');
    expect(textoSistema(S('no_se_maneja', null), 'CJA')).toBe('Sistema: no se maneja aquí');
    expect(textoSistema(S('sin_dato', null), 'CJA')).toBe('Sistema: sin dato');
  });

  it('prueba negativa: sin lectura se DECLARA «sin dato» (nunca cero); pedido cerrado no pinta nada', () => {
    expect(textoSistema(null, 'CJA')).toBe('Sistema: sin dato');
    expect(textoSistema(undefined, 'CJA')).toBeNull();
  });

  it('«no hay» y «no se maneja» van marcados; lo que hay y lo que no se sabe, no', () => {
    expect(sistemaSinProducto(S('agotado', 0))).toBe(true);
    expect(sistemaSinProducto(S('no_se_maneja', null))).toBe(true);
    expect(sistemaSinProducto(S('con_existencia', 3))).toBe(false);
    expect(sistemaSinProducto(null)).toBe(false);
  });

  it('pide buscar en bodega sólo si se marcó de menos y el sistema dice que hay', () => {
    expect(avisoBuscarEnBodega(S('con_existencia', 15), 'CJA', 0, 2)).toBe('El sistema dice que hay 15 CJA: búscalo en bodega antes de quitarlo.');
    expect(avisoBuscarEnBodega(S('con_existencia', null), 'CJA', 1, 2)).toBe('El sistema dice que sí hay: búscalo en bodega antes de quitarlo.');
    // Negativas: completo, sin marcar, el sistema dice que no hay, menos de una unidad o sin dato.
    expect(avisoBuscarEnBodega(S('con_existencia', 15), 'CJA', 2, 2)).toBeNull();
    expect(avisoBuscarEnBodega(S('con_existencia', 15), 'CJA', null, 2)).toBeNull();
    expect(avisoBuscarEnBodega(S('agotado', 0), 'CJA', 0, 2)).toBeNull();
    expect(avisoBuscarEnBodega(S('con_existencia', 0), 'CJA', 0, 2)).toBeNull();
    expect(avisoBuscarEnBodega(null, 'CJA', 0, 2)).toBeNull();
  });

  it('la hora de la lectura va una vez, la más vieja; sin lectura lo dice; sin stock no dice nada', () => {
    const hora = (iso: string): string => iso.slice(11, 16);
    expect(lecturaDeExistencia([S('con_existencia', 1, '2026-11-13T15:50:00.000Z'), S('agotado', 0, '2026-11-13T15:40:00.000Z')], hora))
      .toBe('«Sistema» es la existencia de Kepler al 15:40; lo que manda es lo que ves en el anaquel.');
    expect(lecturaDeExistencia([null, null], hora)).toBe('«Sistema» es la existencia de Kepler; no se pudo leer ahora. Lo que manda es lo que ves en el anaquel.');
    expect(lecturaDeExistencia([undefined, undefined], hora)).toBeNull();
  });
});
