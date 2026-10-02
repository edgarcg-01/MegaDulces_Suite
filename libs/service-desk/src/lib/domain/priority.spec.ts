/**
 * La prioridad SUGERIDA: impacto × «me bloquea», contra la prioridad por defecto de la categoría.
 * Objetivo de diseño: que TODOS puedan reportar sin que todo llegue como urgente.
 */
import { SD_IMPACTS, SD_PRIORITIES, type SdActor, type SdImpact, type SdPriority } from '@megadulces/contracts';
import { compararPrioridad, esPrioridad, maxPrioridad, prioridadPorImpacto, puedeCambiarPrioridad, sugerirPrioridad } from './priority';

describe('la matriz impacto × bloqueo', () => {
  it.each<[SdImpact, boolean, SdPriority]>([
    ['yo', true, 'media'], ['varios', true, 'alta'], ['sucursal', true, 'urgente'], ['red', true, 'urgente'],
    ['yo', false, 'baja'], ['varios', false, 'baja'], ['sucursal', false, 'media'], ['red', false, 'alta'],
  ])('impacto %s, bloquea=%s → %s', (impact, blocks, esperado) => {
    expect(prioridadPorImpacto(impact, blocks)).toBe(esperado);
  });

  it('⭐ «urgente» sale SÓLO de «me bloquea + afecta a la sucursal o a la red», con cualquier categoría', () => {
    for (const def of SD_PRIORITIES.filter((p) => p !== 'urgente')) {
      for (const impact of SD_IMPACTS) {
        for (const blocksWork of [true, false]) {
          const sug = sugerirPrioridad({ defaultPriority: def, impact, blocksWork });
          const esperaUrgente = blocksWork && (impact === 'sucursal' || impact === 'red');
          expect(sug === 'urgente').toBe(esperaUrgente);
        }
      }
    }
  });
});

describe('sugerirPrioridad: el máximo entre la categoría y la matriz', () => {
  it('una categoría «alta» (ERP Kepler) NO baja a «baja» aunque sólo le afecte a una persona', () => {
    expect(sugerirPrioridad({ defaultPriority: 'alta', impact: 'yo', blocksWork: false })).toBe('alta');
  });
  it('una categoría «baja» (Reportes) sube a «alta» si bloquea a varios', () => {
    expect(sugerirPrioridad({ defaultPriority: 'baja', impact: 'varios', blocksWork: true })).toBe('alta');
  });
  it('una categoría «media» sin impacto grande se queda en «media»', () => {
    expect(sugerirPrioridad({ defaultPriority: 'media', impact: 'yo', blocksWork: false })).toBe('media');
  });
  it('NEGATIVA: la sugerencia NUNCA es menor que la prioridad por defecto de la categoría', () => {
    for (const def of SD_PRIORITIES) {
      for (const impact of SD_IMPACTS) {
        for (const blocksWork of [true, false]) {
          expect(compararPrioridad(sugerirPrioridad({ defaultPriority: def, impact, blocksWork }), def)).toBeGreaterThanOrEqual(0);
        }
      }
    }
  });
});

describe('orden y utilidades', () => {
  it('baja < media < alta < urgente', () => {
    expect(compararPrioridad('baja', 'media')).toBeLessThan(0);
    expect(compararPrioridad('urgente', 'alta')).toBeGreaterThan(0);
    expect(compararPrioridad('alta', 'alta')).toBe(0);
    expect(maxPrioridad('media', 'alta')).toBe('alta');
    expect(maxPrioridad('urgente', 'baja')).toBe('urgente');
  });
  it('esPrioridad rechaza lo que la base rechazaría', () => {
    expect(esPrioridad('media')).toBe(true);
    expect(esPrioridad('critica')).toBe(false);
    expect(esPrioridad(null)).toBe(false);
    expect(esPrioridad(2)).toBe(false);
  });
});

describe('quién puede CAMBIAR la prioridad de un ticket ya creado', () => {
  it('⭐ el solicitante NUNCA: no puede subirla para saltarse la fila', () => {
    expect(puedeCambiarPrioridad('requester')).toBe(false);
  });
  it('quien atiende, coordinación y el sistema sí', () => {
    for (const a of ['agent', 'coordinator', 'system'] as SdActor[]) expect(puedeCambiarPrioridad(a)).toBe(true);
  });
});
