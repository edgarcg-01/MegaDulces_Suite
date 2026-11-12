import { agruparPorSemana, DiaDeVenta, etiquetaSemana, lunesDe, numeroSemana } from './ventas-por-semana';

/**
 * `[VEC.42]` «Por semana» del desglose de ruta. Cifras de EJEMPLO (el repo es público).
 *
 * ── Qué se vigila ────────────────────────────────────────────────────────────────────────────
 *  1. La semana es ISO: lunes a domingo, numerada por su jueves (también en el cambio de año).
 *  2. Las semanas suman EXACTAMENTE los días: nada se pierde ni se cuenta dos veces.
 *  3. Lo que no es comparable se marca: la semana en curso y la que el periodo corta.
 *  4. Una semana sin venta entre otras dos sale como renglón, no desaparece.
 */

const dia = (date: string, revenue: number, tickets = 1, units = 10): DiaDeVenta => ({ date, revenue, tickets, units });
const NOVIEMBRE = { desde: '2026-11-01', hasta: '2026-12-01' };

describe('VEC.42 · semana ISO', () => {
  it('el domingo cierra la semana y el lunes la abre', () => {
    expect(lunesDe('2026-11-08')).toBe('2026-11-02'); // domingo
    expect(lunesDe('2026-11-02')).toBe('2026-11-02'); // lunes
    expect(lunesDe('2026-11-09')).toBe('2026-11-09');
  });

  it('se numera por el jueves: el 1-ene-2026 (jueves) es la S01 y empieza el 29-dic', () => {
    expect(lunesDe('2026-01-01')).toBe('2025-12-29');
    expect(numeroSemana('2025-12-29')).toBe(1);
    expect(numeroSemana('2026-11-02')).toBe(45);
    // 2026 arranca en jueves: tiene 53 semanas ISO.
    expect(numeroSemana('2026-12-28')).toBe(53);
  });

  it('la etiqueta dice la semana completa, también si cruza de mes o de año', () => {
    expect(etiquetaSemana('2026-11-02')).toBe('S45 · 2–8 nov');
    expect(etiquetaSemana('2026-10-26')).toBe('S44 · 26 oct–1 nov');
    expect(etiquetaSemana('2025-12-29')).toBe('S01 · 29 dic–4 ene');
  });
});

describe('VEC.42 · agruparPorSemana', () => {
  const DIAS = [
    dia('2026-11-02', 1000, 2), dia('2026-11-03', 2000, 3), dia('2026-11-07', 3000, 4),
    dia('2026-11-09', 500, 1), dia('2026-11-11', 700, 2),
  ];

  it('agrupa de la semana más reciente a la más vieja, con días, tickets y promedio por día', () => {
    const { semanas, sinFecha } = agruparPorSemana(DIAS, NOVIEMBRE, '2026-11-11');
    expect(sinFecha).toBe(0);
    expect(semanas.map((s) => s.lunes)).toEqual(['2026-11-09', '2026-11-02']);
    const [s46, s45] = semanas;
    expect(s45).toMatchObject({ dias: 3, tickets: 9, revenue: 6000, promedioDia: 2000, estado: 'completa' });
    expect(s46).toMatchObject({ dias: 2, tickets: 3, revenue: 1200, promedioDia: 600, estado: 'en_curso' });
  });

  it('⛔ las semanas suman exactamente los días (control contra pérdida o doble conteo)', () => {
    const { semanas } = agruparPorSemana(DIAS, NOVIEMBRE, '2026-11-11');
    const suma = (k: 'revenue' | 'tickets' | 'units', xs: { revenue: number; tickets: number; units: number }[]) =>
      xs.reduce((a, x) => a + x[k], 0);
    for (const k of ['revenue', 'tickets', 'units'] as const) {
      expect(suma(k, semanas)).toBe(suma(k, DIAS));
    }
  });

  it('la semana que el periodo corta se marca, con los días que sí cubre', () => {
    // El 1-nov es domingo: su semana (26 oct–1 nov) queda cortada por el periodo de noviembre.
    const { semanas } = agruparPorSemana([dia('2026-11-01', 400), dia('2026-11-02', 900)], NOVIEMBRE, '2026-11-20');
    const s44 = semanas.find((s) => s.lunes === '2026-10-26');
    expect(s44).toMatchObject({ estado: 'incompleta', cubre: '1 nov', dias: 1, revenue: 400 });
    expect(semanas.find((s) => s.lunes === '2026-11-02')?.estado).toBe('completa');
  });

  it('⛔ el corte del periodo manda sobre «en curso»', () => {
    // Lunes 30-nov y hoy es ese día: la semana no termina, pero además diciembre queda fuera.
    const { semanas } = agruparPorSemana([dia('2026-11-30', 100)], NOVIEMBRE, '2026-11-30');
    expect(semanas[0]).toMatchObject({ estado: 'incompleta', cubre: '30 nov' });
  });

  it('una semana sin venta entre otras dos sale como renglón vacío, sin promedio inventado', () => {
    const { semanas } = agruparPorSemana([dia('2026-10-19', 100), dia('2026-11-02', 300)], { desde: '2026-10-01', hasta: '2026-12-01' }, '2026-11-20');
    expect(semanas.map((s) => s.lunes)).toEqual(['2026-11-02', '2026-10-26', '2026-10-19']);
    expect(semanas[1]).toMatchObject({ dias: 0, revenue: 0, tickets: 0, promedioDia: null });
  });

  it('sin días no inventa semanas', () => {
    expect(agruparPorSemana([], NOVIEMBRE, '2026-11-11')).toEqual({ semanas: [], sinFecha: 0 });
  });

  it('una fecha ilegible se CUENTA para declararla y no tumba a las demás', () => {
    const { semanas, sinFecha } = agruparPorSemana([dia('basura', 50), dia('2026-11-02', 900)], NOVIEMBRE, '2026-11-20');
    expect(sinFecha).toBe(1);
    expect(semanas).toHaveLength(1);
    expect(semanas[0].revenue).toBe(900);
  });

  it('montos como texto (numeric de Postgres) se suman como números', () => {
    const crudo = [{ date: '2026-11-02', revenue: '100.50', tickets: '2', units: '3' }] as unknown as DiaDeVenta[];
    expect(agruparPorSemana(crudo, NOVIEMBRE, '2026-11-20').semanas[0]).toMatchObject({ revenue: 100.5, tickets: 2, units: 3 });
  });
});
