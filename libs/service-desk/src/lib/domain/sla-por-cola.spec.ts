// [CG.38.1] Sin `import ... from 'vitest'`: la config usa `globals: true`. Importarlo hace que el archivo NO CARGUE.
import { politicaEfectiva, type PoliticaSla } from './sla';

/**
 * `[MS.7.2]` La política que rige un ticket: la de SU cola para esa prioridad y, si la cola no la cambió, la general.
 * Lo que se defiende: una cola nueva hereda todo sin sembrar nada; una cola puede cambiar sólo algunas prioridades; y lo que
 * una cola cambia NO se filtra a otra ni a la general.
 */
const pol = (priority: PoliticaSla['priority'], first: number, res: number, clock: PoliticaSla['clock'] = 'business'): PoliticaSla => ({
  priority, first_response_minutes: first, resolution_minutes: res, clock,
});
const GENERAL = {
  urgente: pol('urgente', 30, 240, 'calendar'),
  alta: pol('alta', 120, 480),
  media: pol('media', 240, 1440),
  baja: pol('baja', 480, 3360),
};
const MANTENIMIENTO = { urgente: pol('urgente', 60, 240), media: pol('media', 480, 1440) };

describe('`[MS.7.2]` politicaEfectiva', () => {
  it('⭐ una cola SIN plazos propios hereda la general en todas las prioridades', () => {
    for (const p of ['urgente', 'alta', 'media', 'baja'] as const) expect(politicaEfectiva(GENERAL, undefined, p)).toBe(GENERAL[p]);
    expect(politicaEfectiva(GENERAL, {}, 'alta')).toBe(GENERAL.alta);
  });

  it('⭐ la cola manda en lo que cambió…', () => {
    expect(politicaEfectiva(GENERAL, MANTENIMIENTO, 'urgente')).toBe(MANTENIMIENTO.urgente);
    expect(politicaEfectiva(GENERAL, MANTENIMIENTO, 'urgente')?.clock).toBe('business'); // la urgente de TI corre corrida; la de Mantenimiento, hábil
  });

  it('⭐ …y hereda el resto (herencia PARCIAL)', () => {
    expect(politicaEfectiva(GENERAL, MANTENIMIENTO, 'alta')).toBe(GENERAL.alta);
    expect(politicaEfectiva(GENERAL, MANTENIMIENTO, 'baja')).toBe(GENERAL.baja);
  });

  it('⛔ NEGATIVA — lo que una cola cambia NO altera la general (ni la de otra cola)', () => {
    politicaEfectiva(GENERAL, MANTENIMIENTO, 'urgente');
    expect(GENERAL.urgente.clock).toBe('calendar');
    expect(politicaEfectiva(GENERAL, undefined, 'urgente')?.clock).toBe('calendar');
    const otra = { alta: pol('alta', 10, 20) };
    expect(politicaEfectiva(GENERAL, otra, 'urgente')).toBe(GENERAL.urgente);
  });

  it('⛔ si ni la cola ni la general la tienen: undefined (quien llama DECLARA el hueco, no inventa un plazo)', () => {
    expect(politicaEfectiva({ media: GENERAL.media }, MANTENIMIENTO, 'baja')).toBeUndefined();
    expect(politicaEfectiva({}, undefined, 'urgente')).toBeUndefined();
  });
});
