// Sin `import ... from 'vitest'`: la config usa `globals: true`.
import { diaMxDe } from './mx-date';

/**
 * `[GX.106]` El día de México de lo que manda el servidor. Lo que cuida: que una marca de tiempo de
 * la noche no se lea del día siguiente (cortar en la `T` toma el día de Greenwich).
 */
describe('diaMxDe — el día de México', () => {
  it('un día ya dado se queda igual', () => {
    expect(diaMxDe('2026-11-05')).toBe('2026-11-05');
  });

  it('⛔ una marca de la noche (UTC del día siguiente) es del día de México', () => {
    // 2026-11-06 02:30 UTC = 2026-11-05 20:30 en México.
    expect(diaMxDe('2026-11-06T02:30:00.000Z')).toBe('2026-11-05');
  });

  it('una marca del día es del mismo día', () => {
    expect(diaMxDe('2026-11-05T15:00:00.000Z')).toBe('2026-11-05');
  });

  it('vacío o ilegible: nada, no un día inventado', () => {
    expect(diaMxDe(null)).toBe('');
    expect(diaMxDe(undefined)).toBe('');
    expect(diaMxDe('')).toBe('');
    expect(diaMxDe('mañana')).toBe('');
    expect(diaMxDe('2026-99-99T99:00:00Z')).toBe('');
  });
});
