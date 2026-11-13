import { agruparPorSemana, DiaDeVenta, etiquetaSemana, lunesDe, numeroSemana } from './ventas-por-semana';

/**
 * `[VEC.42]`/`[VEC.43]` Calendario de venta del desglose de ruta. Cifras de EJEMPLO (el repo es público).
 *
 * ── Qué se vigila ────────────────────────────────────────────────────────────────────────────
 *  1. La semana es ISO: lunes a domingo, numerada por su jueves (también en el cambio de año).
 *  2. Las semanas suman EXACTAMENTE los días: nada se pierde ni se cuenta dos veces.
 *  3. Lo que no es comparable se marca: la semana en curso y la que el periodo corta.
 *  4. Salen todas las semanas del periodo hasta hoy: una sin venta es renglón, no desaparece.
 *  5. Cada día dice lo que es: con venta, sin venta, fuera del periodo o todavía no llega.
 *     Ninguno de los dos últimos se dibuja como cero.
 *  6. El tono es relativo al mejor día del periodo, y ese día se nombra.
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

describe('VEC.42 · agruparPorSemana: las semanas', () => {
  const DIAS = [
    dia('2026-11-02', 1000, 2), dia('2026-11-03', 2000, 3), dia('2026-11-07', 3000, 4),
    dia('2026-11-09', 500, 1), dia('2026-11-11', 700, 2),
  ];

  it('va de la semana del primer día del periodo a la de hoy, de la más vieja a la más reciente (como «Por día»)', () => {
    const { semanas, sinFecha } = agruparPorSemana(DIAS, NOVIEMBRE, '2026-11-11');
    expect(sinFecha).toBe(0);
    // El 1-nov es domingo: su semana (S44) es la primera, aunque ese día no hubo venta.
    expect(semanas.map((s) => s.lunes)).toEqual(['2026-10-26', '2026-11-02', '2026-11-09']);
    const [s44, s45, s46] = semanas;
    expect(s44).toMatchObject({ dias: 0, revenue: 0, promedioDia: null, estado: 'incompleta', cubre: '1 nov' });
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

  it('no salen las semanas que todavía no empiezan', () => {
    const { semanas } = agruparPorSemana(DIAS, NOVIEMBRE, '2026-11-11');
    expect(semanas[semanas.length - 1].lunes).toBe('2026-11-09');
  });

  it('un periodo que ya terminó llega hasta su último día', () => {
    const { semanas } = agruparPorSemana(DIAS, NOVIEMBRE, '2027-01-10');
    expect(semanas.map((s) => s.lunes)).toEqual(['2026-10-26', '2026-11-02', '2026-11-09', '2026-11-16', '2026-11-23', '2026-11-30']);
  });

  it('la semana que el periodo corta se marca, con los días que sí cubre', () => {
    const { semanas } = agruparPorSemana([dia('2026-11-01', 400), dia('2026-11-02', 900)], NOVIEMBRE, '2026-11-20');
    const s44 = semanas.find((s) => s.lunes === '2026-10-26');
    expect(s44).toMatchObject({ estado: 'incompleta', cubre: '1 nov', dias: 1, revenue: 400 });
    expect(semanas.find((s) => s.lunes === '2026-11-02')?.estado).toBe('completa');
  });

  it('⛔ el corte del periodo manda sobre «en curso»', () => {
    // Lunes 30-nov y hoy es ese día: la semana no termina, pero además diciembre queda fuera.
    const { semanas } = agruparPorSemana([dia('2026-11-30', 100)], NOVIEMBRE, '2026-11-30');
    expect(semanas.find((s) => s.lunes === '2026-11-30')).toMatchObject({ estado: 'incompleta', cubre: '30 nov' });
  });

  it('una semana sin venta sale como renglón vacío, sin promedio inventado', () => {
    const { semanas } = agruparPorSemana([dia('2026-10-19', 100), dia('2026-11-02', 300)], { desde: '2026-10-01', hasta: '2026-12-01' }, '2026-11-20');
    expect(semanas.map((s) => s.lunes)).toEqual([
      '2026-09-28', '2026-10-05', '2026-10-12', '2026-10-19', '2026-10-26', '2026-11-02', '2026-11-09', '2026-11-16',
    ]);
    expect(semanas.find((s) => s.lunes === '2026-10-26')).toMatchObject({ dias: 0, revenue: 0, tickets: 0, promedioDia: null });
  });

  it('sin días no inventa semanas', () => {
    expect(agruparPorSemana([], NOVIEMBRE, '2026-11-11')).toEqual({ semanas: [], mejorDia: null, sinFecha: 0 });
  });

  it('una fecha ilegible se CUENTA para declararla y no tumba a las demás', () => {
    const { semanas, sinFecha } = agruparPorSemana([dia('basura', 50), dia('2026-11-02', 900)], NOVIEMBRE, '2026-11-20');
    expect(sinFecha).toBe(1);
    expect(semanas.reduce((a, s) => a + s.revenue, 0)).toBe(900);
  });

  it('montos como texto (numeric de Postgres) se suman como números', () => {
    const crudo = [{ date: '2026-11-02', revenue: '100.50', tickets: '2', units: '3' }] as unknown as DiaDeVenta[];
    const s45 = agruparPorSemana(crudo, NOVIEMBRE, '2026-11-20').semanas.find((s) => s.lunes === '2026-11-02');
    expect(s45).toMatchObject({ revenue: 100.5, tickets: 2, units: 3 });
  });
});

describe('VEC.43 · agruparPorSemana: los días del calendario', () => {
  const DIAS = [
    dia('2026-11-02', 1000, 2), dia('2026-11-03', 2000, 3), dia('2026-11-07', 3000, 4),
    dia('2026-11-09', 500, 1), dia('2026-11-11', 700, 2),
  ];
  const estados = (lunes: string, hoy = '2026-11-11') =>
    agruparPorSemana(DIAS, NOVIEMBRE, hoy).semanas.find((s) => s.lunes === lunes)!.celdas.map((c) => c.estado);

  it('cada semana trae sus 7 días, de lunes a domingo', () => {
    const { semanas } = agruparPorSemana(DIAS, NOVIEMBRE, '2026-11-11');
    for (const s of semanas) expect(s.celdas).toHaveLength(7);
    const s45 = semanas.find((s) => s.lunes === '2026-11-02')!;
    expect(s45.celdas.map((c) => c.dia)).toEqual([2, 3, 4, 5, 6, 7, 8]);
    expect(s45.celdas[0]).toMatchObject({ fecha: '2026-11-02', nombre: 'lunes 2 nov', revenue: 1000, tickets: 2 });
  });

  it('⛔ fuera del periodo y «todavía no llega» NO son «sin venta» (y ninguno es un cero)', () => {
    // 26–31 oct fuera de noviembre; el 1-nov ya pasó y no vendió.
    expect(estados('2026-10-26')).toEqual(['fuera', 'fuera', 'fuera', 'fuera', 'fuera', 'fuera', 'sin_venta']);
    expect(estados('2026-11-02')).toEqual(['venta', 'venta', 'sin_venta', 'sin_venta', 'sin_venta', 'venta', 'sin_venta']);
    // Hoy es miércoles 11: del jueves 12 en adelante todavía no llega.
    expect(estados('2026-11-09')).toEqual(['venta', 'sin_venta', 'venta', 'futuro', 'futuro', 'futuro', 'futuro']);
  });

  it('⛔ HOY sin renglón es «todavía no llega», no «sin venta» (la venta de ruta llega D+1)', () => {
    // Hoy es martes 10 y no tiene renglón; el miércoles 11 sí trae venta y se muestra.
    expect(estados('2026-11-09', '2026-11-10')).toEqual(['venta', 'futuro', 'venta', 'futuro', 'futuro', 'futuro', 'futuro']);
  });

  it('el tono es relativo al mejor día del periodo, y ese día se nombra', () => {
    const r = agruparPorSemana(DIAS, NOVIEMBRE, '2026-11-11');
    expect(r.mejorDia).toEqual({ fecha: '2026-11-07', nombre: 'sábado 7 nov', revenue: 3000 });
    const nivel = (fecha: string) => r.semanas.flatMap((s) => s.celdas).find((c) => c.fecha === fecha)!.nivel;
    expect(nivel('2026-11-07')).toBe(4); // el mejor
    expect(nivel('2026-11-03')).toBe(3); // 2000 de 3000
    expect(nivel('2026-11-02')).toBe(2); // 1000 de 3000
    expect(nivel('2026-11-11')).toBe(1); // 700 de 3000
    expect(nivel('2026-11-04')).toBe(0); // sin venta: sin tono
  });

  it('un día con venta en cero o negativa (devolución) tiene su cuadro pero no lleva tono', () => {
    const r = agruparPorSemana([dia('2026-11-02', -200, 1), dia('2026-11-03', 1000, 2)], NOVIEMBRE, '2026-11-20');
    const celdas = r.semanas.find((s) => s.lunes === '2026-11-02')!.celdas;
    expect(celdas[0]).toMatchObject({ estado: 'venta', revenue: -200, nivel: 0 });
    expect(celdas[1]).toMatchObject({ estado: 'venta', nivel: 4 });
    expect(r.mejorDia?.fecha).toBe('2026-11-03');
  });

  it('un día repetido por la fuente se suma, no se pisa ni cuenta dos días', () => {
    const r = agruparPorSemana([dia('2026-11-02', 100, 1), dia('2026-11-02', 50, 1)], NOVIEMBRE, '2026-11-20');
    const s45 = r.semanas.find((s) => s.lunes === '2026-11-02')!;
    expect(s45.celdas[0]).toMatchObject({ revenue: 150, tickets: 2 });
    expect(s45.dias).toBe(1);
  });
});
