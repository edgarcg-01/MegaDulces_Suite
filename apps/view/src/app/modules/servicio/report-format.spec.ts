import type { SdSlaCompliance } from '@megadulces/contracts';
import { fmtCumplimiento, fmtMin, fmtPct, fmtTiempo, notaCumplimiento } from './report-format';

/**
 * `[MS.3.5]` Lo que no se midió no se dibuja como cero: un tiempo sin muestras y un cumplimiento sin tickets que
 * juzgar salen como «—», nunca «0 min» ni «0 %».
 */
const c = (p: Partial<SdSlaCompliance>): SdSlaCompliance => ({ cumplidos: 0, incumplidos: 0, en_plazo: 0, sin_plazo: 0, cumplimiento_pct: null, ...p });

describe('MS.3.5 · fmtMin', () => {
  it('minutos, horas y horas con minutos', () => {
    expect(fmtMin(45)).toBe('45 min');
    expect(fmtMin(60)).toBe('1 h');
    expect(fmtMin(150)).toBe('2 h 30 min');
  });
  it('⛔ NEGATIVA — null/undefined es «—», no «0 min»', () => {
    expect(fmtMin(null)).toBe('—');
    expect(fmtMin(undefined)).toBe('—');
  });
  it('un cero REAL (se resolvió al instante) sí se escribe «0 min»', () => {
    expect(fmtMin(0)).toBe('0 min');
  });
});

describe('MS.3.5 · fmtPct', () => {
  it('con un decimal como máximo; null es «—»', () => {
    expect(fmtPct(66.7)).toBe('66.7 %');
    expect(fmtPct(100)).toBe('100 %');
    expect(fmtPct(null)).toBe('—');
  });
  it('un 0 % REAL (nadie cumplió, con tickets juzgados) sí se escribe', () => {
    expect(fmtPct(0)).toBe('0 %');
  });
});

describe('MS.3.5 · fmtCumplimiento', () => {
  it('trae el porcentaje y de cuántos', () => {
    expect(fmtCumplimiento(c({ cumplidos: 3, incumplidos: 1, cumplimiento_pct: 75 }))).toBe('75 % (3 de 4)');
  });
  it('⛔ NEGATIVA — sin nada que juzgar es «—» aunque haya tickets en plazo', () => {
    expect(fmtCumplimiento(c({ en_plazo: 5 }))).toBe('—');
    expect(fmtCumplimiento(c({}))).toBe('—');
  });
  it('⭐ un 0 % con tickets juzgados SÍ se muestra: es información, no ausencia', () => {
    expect(fmtCumplimiento(c({ cumplidos: 0, incumplidos: 4, cumplimiento_pct: 0 }))).toBe('0 % (0 de 4)');
  });
});

describe('MS.3.5 · notaCumplimiento', () => {
  it('dice lo que NO entró al porcentaje', () => {
    expect(notaCumplimiento(c({ en_plazo: 2, sin_plazo: 1 }))).toContain('2 todavía en plazo');
    expect(notaCumplimiento(c({ en_plazo: 2, sin_plazo: 1 }))).toContain('1 sin plazo');
  });
  it('si todo entró, lo dice', () => {
    expect(notaCumplimiento(c({ cumplidos: 1, cumplimiento_pct: 100 }))).toContain('Todos');
  });
});

describe('MS.3.5 · fmtTiempo', () => {
  it('sin muestras es «—»', () => {
    expect(fmtTiempo({ n: 0, p50: null, p90: null })).toBe('—');
    expect(fmtTiempo({ n: 3, p50: 90, p90: 120 })).toBe('1 h 30 min');
  });
});
