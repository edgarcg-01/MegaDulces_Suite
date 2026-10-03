import type { SdPriority } from '@megadulces/contracts';
import type { BusinessCalendar } from './business-clock';
import { armarReporte, juzgarPlazo, MIN_RECURRENTE, percentil, tiempos, type ConfigReporte, type FilaReporte } from './report';

/**
 * `[MS.3.5]` El reporte de la Mesa de Servicio. Lo que se defiende:
 *  · un cumplimiento sin tickets que juzgar es `null`, nunca 0 %; lo que aún no vence y lo que no trae plazo se
 *    cuentan APARTE del cumplimiento;
 *  · un ticket auto-asignado que nadie tocó NO tiene primera respuesta: incumple en cuanto vence;
 *  · los cancelados no «incumplen» pero sí son demanda (cuentan en categoría, sucursal y recurrentes);
 *  · los tiempos usan el reloj de la política de SU prioridad y la resolución descuenta la espera del solicitante;
 *  · no hay ranking por persona.
 *
 * Fechas reales de octubre de 2026 (México sin horario de verano: UTC-6). Lunes 5 · martes 6. Calendario por
 * defecto del tenant: lunes a sábado, 08:00–19:00.
 */
const MX: BusinessCalendar = { tz: 'America/Mexico_City', days: [1, 2, 3, 4, 5, 6], startMin: 480, endMin: 1140 };
const CFG: ConfigReporte = {
  calendar: MX,
  policies: {
    urgente: { priority: 'urgente', first_response_minutes: 30, resolution_minutes: 240, clock: 'calendar' },
    alta: { priority: 'alta', first_response_minutes: 120, resolution_minutes: 480, clock: 'business' },
    media: { priority: 'media', first_response_minutes: 240, resolution_minutes: 1440, clock: 'business' },
    baja: { priority: 'baja', first_response_minutes: 480, resolution_minutes: 3360, clock: 'business' },
  },
};
/** Instante a partir de hora LOCAL de México (UTC-6). */
const mx = (dia: number, h: number, m = 0): string => new Date(Date.UTC(2026, 9, dia, h + 6, m)).toISOString();
const AHORA = Date.parse(mx(6, 18)); // martes 6 de octubre, 18:00 local

const fila = (p: Partial<FilaReporte> & { priority?: SdPriority }): FilaReporte => ({
  priority: 'media',
  category_id: 'cat-a',
  category_name: 'Soporte',
  warehouse_code: null,
  status: 'nuevo',
  created_at: mx(5, 10),
  first_responded_at: null,
  first_response_due_at: mx(5, 14),
  resolved_at: null,
  due_at: mx(6, 18),
  paused_minutes: 0,
  reopened_count: 0,
  ...p,
});
const reporte = (filas: FilaReporte[], truncado = false) =>
  armarReporte(filas, CFG, { desde: '2026-10-01', hasta: '2026-10-06', ahora: AHORA, truncado, nombreSucursal: (c) => (c === '02' ? 'Piedad' : null) });

describe('MS.3.5 · juzgarPlazo', () => {
  const plazo = Date.parse(mx(5, 12));
  it('cumplido: se hizo a tiempo; incumplido: tarde', () => {
    expect(juzgarPlazo(plazo - 1, plazo, AHORA)).toBe('cumplido');
    expect(juzgarPlazo(plazo, plazo, AHORA)).toBe('cumplido');
    expect(juzgarPlazo(plazo + 1, plazo, AHORA)).toBe('incumplido');
  });
  it('sin hacer: incumplido si ya venció, en plazo si no', () => {
    expect(juzgarPlazo(null, plazo, AHORA)).toBe('incumplido');
    expect(juzgarPlazo(null, AHORA + 1, AHORA)).toBe('en_plazo');
  });
  it('⛔ sin plazo no se juzga: `sin_plazo`, ni cumplido ni incumplido', () => {
    expect(juzgarPlazo(plazo, null, AHORA)).toBe('sin_plazo');
    expect(juzgarPlazo(null, null, AHORA)).toBe('sin_plazo');
  });
});

describe('MS.3.5 · percentil y tiempos', () => {
  it('rango más cercano', () => {
    expect(percentil([10, 20, 30, 40, 50], 50)).toBe(30);
    expect(percentil([10, 20, 30, 40, 50], 90)).toBe(50);
    expect(percentil([7], 90)).toBe(7);
  });
  it('⛔ sin muestra es null, NUNCA 0 minutos', () => {
    expect(percentil([], 50)).toBeNull();
    expect(tiempos([])).toEqual({ n: 0, p50: null, p90: null });
  });
  it('no depende del orden de entrada', () => {
    expect(tiempos([50, 10, 30])).toEqual(tiempos([10, 30, 50]));
  });
});

describe('MS.3.5 · cumplimiento', () => {
  it('⭐ lo que aún no vence NO entra al porcentaje: se cuenta aparte', () => {
    const r = reporte([
      fila({ first_responded_at: mx(5, 11), first_response_due_at: mx(5, 14) }), // cumplida
      fila({ first_responded_at: mx(5, 16), first_response_due_at: mx(5, 14) }), // tarde
      fila({ first_response_due_at: mx(6, 19) }), // sin responder pero aún en plazo (vence después de AHORA)
    ]);
    expect(r.primera_respuesta).toMatchObject({ cumplidos: 1, incumplidos: 1, en_plazo: 1, cumplimiento_pct: 50 });
  });

  it('⛔ NEGATIVA — sin nada que juzgar el porcentaje es null, no 0', () => {
    const r = reporte([fila({ first_response_due_at: mx(6, 19), due_at: mx(6, 19) })]);
    expect(r.primera_respuesta.cumplimiento_pct).toBeNull();
    expect(r.resolucion.cumplimiento_pct).toBeNull();
    expect(reporte([]).primera_respuesta.cumplimiento_pct).toBeNull();
  });

  it('⭐ un ticket auto-asignado que nadie tocó (sin primera respuesta) incumple en cuanto vence', () => {
    const r = reporte([fila({ status: 'asignado', first_responded_at: null, first_response_due_at: mx(5, 14) })]);
    expect(r.primera_respuesta).toMatchObject({ cumplidos: 0, incumplidos: 1 });
  });

  it('resolución: a tiempo, tarde y vencida sin resolver', () => {
    const r = reporte([
      fila({ status: 'resuelto', resolved_at: mx(5, 15), due_at: mx(5, 18) }),
      fila({ status: 'resuelto', resolved_at: mx(6, 12), due_at: mx(5, 18) }),
      fila({ status: 'en_proceso', due_at: mx(5, 18) }),
    ]);
    expect(r.resolucion).toMatchObject({ cumplidos: 1, incumplidos: 2, cumplimiento_pct: 33.3 });
  });

  it('⭐ los CANCELADOS no incumplen, pero sí son demanda (cuentan en categoría y totales)', () => {
    const r = reporte([fila({ status: 'cancelado', first_response_due_at: mx(5, 11), due_at: mx(5, 11) })]);
    expect(r.primera_respuesta).toMatchObject({ cumplidos: 0, incumplidos: 0 });
    expect(r.resolucion).toMatchObject({ cumplidos: 0, incumplidos: 0 });
    expect(r.totales).toMatchObject({ creados: 1, cancelados: 1, abiertos: 0, resueltos: 0 });
    expect(r.por_categoria[0].creados).toBe(1);
  });

  it('un ticket sin plazo se cuenta en `sin_plazo`, no en el porcentaje', () => {
    const r = reporte([fila({ first_response_due_at: null, due_at: null })]);
    expect(r.primera_respuesta.sin_plazo).toBe(1);
    expect(r.primera_respuesta.cumplimiento_pct).toBeNull();
  });
});

describe('MS.3.5 · tiempos por prioridad', () => {
  it('⭐ usa el reloj de SU prioridad: hábil para media, corrido para urgente', () => {
    // Creado lunes 18:00, respondido martes 09:00: 15 h corridas, pero sólo 60 min hábiles (18:00–19:00) + 60 (08:00–09:00).
    const creado = mx(5, 18);
    const respondido = mx(6, 9);
    const r = reporte([
      fila({ priority: 'media', created_at: creado, first_responded_at: respondido, first_response_due_at: mx(6, 12) }),
      fila({ priority: 'urgente', created_at: creado, first_responded_at: respondido, first_response_due_at: mx(5, 19) }),
    ]);
    const media = r.por_prioridad.find((p) => p.priority === 'media');
    const urgente = r.por_prioridad.find((p) => p.priority === 'urgente');
    expect(media?.t_primera_respuesta.p50).toBe(120);
    expect(urgente?.t_primera_respuesta.p50).toBe(900);
  });

  it('⭐ la resolución DESCUENTA lo que estuvo en espera del solicitante, y nunca sale negativa', () => {
    const r = reporte([
      fila({ priority: 'alta', status: 'resuelto', created_at: mx(5, 9), resolved_at: mx(5, 13), due_at: mx(5, 18), paused_minutes: 60 }),
      fila({ priority: 'alta', status: 'resuelto', created_at: mx(5, 9), resolved_at: mx(5, 10), due_at: mx(5, 18), paused_minutes: 500 }),
    ]);
    const alta = r.por_prioridad.find((p) => p.priority === 'alta');
    expect(alta?.t_resolucion.n).toBe(2);
    expect(alta?.t_resolucion.p50).toBe(0); // el segundo: 60 − 500 → 0, no negativo
    expect(alta?.t_resolucion.p90).toBe(180); // el primero: 240 − 60
  });

  it('la lista sale urgente primero y trae las cuatro prioridades aunque no haya tickets', () => {
    const r = reporte([]);
    expect(r.por_prioridad.map((p) => p.priority)).toEqual(['urgente', 'alta', 'media', 'baja']);
    expect(r.por_prioridad[0].t_resolucion).toEqual({ n: 0, p50: null, p90: null });
  });
});

describe('MS.3.5 · categorías, sucursales y recurrentes', () => {
  it('⭐ recurrente = la misma categoría en la misma sucursal, al menos 3 veces', () => {
    const tres = Array.from({ length: MIN_RECURRENTE }, () => fila({ category_id: 'cat-caja', category_name: 'Sistema de caja', warehouse_code: '02' }));
    const dos = Array.from({ length: MIN_RECURRENTE - 1 }, () => fila({ category_id: 'cat-red', category_name: 'Redes', warehouse_code: '02' }));
    const r = reporte([...tres, ...dos]);
    expect(r.recurrentes).toEqual([{ category_id: 'cat-caja', category_name: 'Sistema de caja', warehouse_code: '02', warehouse_name: 'Piedad', n: 3 }]);
  });

  it('el mismo problema en sucursales distintas NO es recurrente en ninguna', () => {
    const r = reporte(['02', '03', '04'].map((w) => fila({ category_id: 'cat-caja', warehouse_code: w })));
    expect(r.recurrentes).toEqual([]);
  });

  it('los tickets sin sucursal se agrupan aparte y se dice que no la tienen', () => {
    const r = reporte([fila({ warehouse_code: null }), fila({ warehouse_code: '02' })]);
    const sin = r.por_sucursal.find((s) => s.warehouse_code === null);
    expect(sin).toMatchObject({ creados: 1, warehouse_name: null });
    expect(r.por_sucursal.find((s) => s.warehouse_code === '02')?.warehouse_name).toBe('Piedad');
  });

  it('las categorías salen por volumen y cuentan reabiertos e incumplimientos de resolución', () => {
    const r = reporte([
      fila({ category_id: 'a', category_name: 'A', reopened_count: 1 }),
      fila({ category_id: 'b', category_name: 'B', due_at: mx(5, 11) }),
      fila({ category_id: 'b', category_name: 'B' }),
    ]);
    expect(r.por_categoria.map((c) => c.name)).toEqual(['B', 'A']);
    expect(r.por_categoria[0]).toMatchObject({ creados: 2, resolucion_incumplidos: 1 });
    expect(r.por_categoria[1].reabiertos).toBe(1);
    expect(r.totales).toMatchObject({ reabiertos: 1, reabiertos_pct: 33.3 });
  });
});

describe('MS.3.5 · lo que el reporte declara', () => {
  it('⛔ NO mide personas: el reporte no trae nada por asignado', () => {
    const r = reporte([fila({})]);
    // Se revisan las LLAVES del resultado (el texto de `no_medido` sí dice «personas», justamente para declararlo).
    expect(JSON.stringify(r)).not.toMatch(/"(assign[a-z_]*|resolved_by|asignado[a-z_]*|requester[a-z_]*)":/i);
    expect(r.no_medido.join(' ')).toContain('no a las personas');
  });
  it('un periodo truncado se declara y NO se presenta como completo', () => {
    expect(reporte([fila({})], true).truncado).toBe(true);
    expect(reporte([fila({})], true).no_medido.join(' ')).toContain('más tickets de los que el reporte calcula');
    expect(reporte([fila({})], false).no_medido.join(' ')).not.toContain('más tickets de los que el reporte calcula');
  });
  it('una prioridad sin política queda fuera de los plazos y se dice, no se cuenta como cumplida', () => {
    const sinPolitica: ConfigReporte = { ...CFG, policies: { ...CFG.policies, baja: undefined as never } };
    const r = armarReporte([fila({ priority: 'baja' })], sinPolitica, { desde: 'a', hasta: 'b', ahora: AHORA, truncado: false, nombreSucursal: () => null });
    expect(r.primera_respuesta).toMatchObject({ cumplidos: 0, incumplidos: 0, en_plazo: 0 });
    expect(r.no_medido.join(' ')).toContain('sin política de SLA');
    expect(r.totales.creados).toBe(1);
  });
  it('trae cuándo se midió y el periodo', () => {
    const r = reporte([]);
    expect(r.medido_at).toBe(new Date(AHORA).toISOString());
    expect(r.periodo).toEqual({ desde: '2026-10-01', hasta: '2026-10-06' });
  });
});
