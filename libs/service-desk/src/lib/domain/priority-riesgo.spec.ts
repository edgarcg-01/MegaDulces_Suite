// [CG.38.1] Sin `import ... from 'vitest'`: la config usa `globals: true`. Importarlo hace que el archivo NO CARGUE.
import { SD_IMPACTS } from '@megadulces/contracts';
import { prioridadPorRiesgo, sugerirPrioridad, sugerirPrioridadPorModelo } from './priority';

/**
 * `[MS.7.7]` La matriz de Mantenimiento (riesgo para personas × detiene la operación) y el modelo por cola. Lo que se defiende:
 *  · las 4 combinaciones, exactas;
 *  · el modelo `impacto` es EXACTAMENTE lo de siempre (TI no cambia), para todas las combinaciones;
 *  · la categoría pone un piso también en el modelo de riesgo;
 *  · el riesgo es obligatorio: nunca se adivina «no hay riesgo» por omisión.
 */
describe('`[MS.7.7]` prioridadPorRiesgo — la matriz de Mantenimiento', () => {
  it('⭐ las 4 combinaciones, exactas', () => {
    expect(prioridadPorRiesgo(true, true)).toBe('urgente');
    expect(prioridadPorRiesgo(true, false)).toBe('alta');
    expect(prioridadPorRiesgo(false, true)).toBe('alta');
    expect(prioridadPorRiesgo(false, false)).toBe('media');
  });

  it('⛔ NEGATIVA — nunca baja de «media»: un problema físico del local no es «puede esperar» por lo que diga quien reporta', () => {
    for (const r of [true, false]) for (const d of [true, false]) expect(prioridadPorRiesgo(r, d)).not.toBe('baja');
  });

  it('el riesgo pesa lo mismo que detener la operación: ninguno solo llega a «urgente»', () => {
    expect(prioridadPorRiesgo(true, false)).not.toBe('urgente');
    expect(prioridadPorRiesgo(false, true)).not.toBe('urgente');
  });
});

describe('`[MS.7.7]` sugerirPrioridadPorModelo', () => {
  const base = { defaultPriority: 'media' as const, impact: 'yo' as const, blocksWork: false };

  it('⭐ el modelo «impacto» es EXACTAMENTE la matriz de siempre, para toda combinación (TI no cambia)', () => {
    for (const impact of SD_IMPACTS) {
      for (const blocksWork of [true, false]) {
        for (const defaultPriority of ['baja', 'media', 'alta', 'urgente'] as const) {
          const e = { defaultPriority, impact, blocksWork };
          expect(sugerirPrioridadPorModelo({ ...e, modelo: 'impacto' })).toBe(sugerirPrioridad(e));
        }
      }
    }
  });

  it('⛔ en el modelo de impacto el riesgo se IGNORA (aunque venga): no cambia la prioridad de TI', () => {
    expect(sugerirPrioridadPorModelo({ ...base, modelo: 'impacto', safetyRisk: true })).toBe(sugerirPrioridad(base));
  });

  it('⭐ en el modelo de riesgo manda la matriz de Mantenimiento, con «detiene la operación» = blocks_work', () => {
    expect(sugerirPrioridadPorModelo({ ...base, modelo: 'riesgo_operacion', safetyRisk: true, blocksWork: true })).toBe('urgente');
    expect(sugerirPrioridadPorModelo({ ...base, modelo: 'riesgo_operacion', safetyRisk: true, blocksWork: false })).toBe('alta');
    expect(sugerirPrioridadPorModelo({ ...base, modelo: 'riesgo_operacion', safetyRisk: false, blocksWork: true })).toBe('alta');
    expect(sugerirPrioridadPorModelo({ ...base, modelo: 'riesgo_operacion', safetyRisk: false, blocksWork: false })).toBe('media');
  });

  it('⭐ y en el modelo de riesgo el IMPACTO ya no cuenta (esa pregunta no se hace en Mantenimiento)', () => {
    const sinRiesgoNiParo = { ...base, modelo: 'riesgo_operacion', safetyRisk: false, blocksWork: false };
    for (const impact of SD_IMPACTS) expect(sugerirPrioridadPorModelo({ ...sinRiesgoNiParo, impact })).toBe('media');
  });

  it('la categoría pone un PISO también en el modelo de riesgo (una categoría «alta» no baja a «media»)', () => {
    expect(sugerirPrioridadPorModelo({ ...base, modelo: 'riesgo_operacion', safetyRisk: false, defaultPriority: 'alta' })).toBe('alta');
    expect(sugerirPrioridadPorModelo({ ...base, modelo: 'riesgo_operacion', safetyRisk: false, defaultPriority: 'baja' })).toBe('media'); // el piso no sube lo que la matriz ya pone más alto
  });

  it('⛔ NEGATIVA — el modelo de riesgo SIN respuesta de riesgo no se adivina: lanza (el peligro nunca se infiere por omisión)', () => {
    expect(() => sugerirPrioridadPorModelo({ ...base, modelo: 'riesgo_operacion' })).toThrow(/safetyRisk/);
    expect(() => sugerirPrioridadPorModelo({ ...base, modelo: 'riesgo_operacion', safetyRisk: null })).toThrow();
  });

  it('un modelo desconocido cae a «impacto» (nunca revienta un alta)', () => {
    expect(sugerirPrioridadPorModelo({ ...base, modelo: 'inventado', blocksWork: true, impact: 'red' })).toBe('urgente');
  });
});
