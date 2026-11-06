import { describe, expect, it } from 'vitest';
import { DATE_PRESET_OPTIONS, datePresetRange, isoLocalDate } from './date-presets.util';

const rango = (k: string, hoy: Date) => {
  const r = datePresetRange(k, hoy);
  return r ? { desde: isoLocalDate(r.from), hasta: isoLocalDate(r.to) } : null;
};

describe('datePresetRange', () => {
  const HOY = new Date(2026, 10, 4); // 4 nov 2026, hora local

  it('los de siempre no cambian', () => {
    expect(rango('mes', HOY)).toEqual({ desde: '2026-11-01', hasta: '2026-11-04' });
    expect(rango('mes_prev', HOY)).toEqual({ desde: '2026-10-01', hasta: '2026-10-31' });
    expect(rango('anio', HOY)).toEqual({ desde: '2026-01-01', hasta: '2026-11-04' });
  });

  it('⭐ [PF.23] los nuevos: últimos 90 días (hoy incluido) y el año pasado completo', () => {
    expect(rango('d90', HOY)).toEqual({ desde: '2026-08-07', hasta: '2026-11-04' });
    expect(rango('anio_prev', HOY)).toEqual({ desde: '2025-01-01', hasta: '2025-12-31' });
  });

  it('⛔ [negativa] los nuevos NO aparecen en la lista compartida: ningún menú existente cambia', () => {
    const valores = DATE_PRESET_OPTIONS.map((o) => o.value);
    expect(valores).not.toContain('d90');
    expect(valores).not.toContain('anio_prev');
    expect(datePresetRange('desconocido', HOY)).toBeNull();
  });
});
