/**
 * `[NP.7.L.11d]` La configuración del lector: apagada por defecto, y un valor mal escrito nunca sale más caro.
 */
import {
  CONCURRENCIA_DEFECTO, CONCURRENCIA_MAX, EFFORT_DEFECTO, MAX_TOKENS_DEFECTO, MODELO_DEFECTO, TOPE_DIARIO_DEFECTO, leerConfigLector,
} from './lector.config';

describe('[NP.7.L.11d] leerConfigLector', () => {
  it('sin variables: APAGADA, con los defectos del plan', () => {
    const c = leerConfigLector({});
    expect(c).toEqual({
      habilitada: false, concurrencia: CONCURRENCIA_DEFECTO, topeDiario: TOPE_DIARIO_DEFECTO, modelo: MODELO_DEFECTO,
      effort: EFFORT_DEFECTO, maxTokens: MAX_TOKENS_DEFECTO, recorte: 'silueta', advertencias: [],
    });
    expect(c.concurrencia).toBe(2);
    expect(c.topeDiario).toBe(200);
    expect(c.maxTokens).toBe(8000);
  });

  it('sólo el texto exacto "true" la enciende (D6 sin firmar)', () => {
    expect(leerConfigLector({ NP7_AI_ENABLED: 'true' }).habilitada).toBe(true);
    for (const v of ['TRUE', '1', 'si', 'yes', ' true', 'false', '']) {
      expect(leerConfigLector({ NP7_AI_ENABLED: v }).habilitada).toBe(false);
    }
  });

  it('la concurrencia se acota a 1..8', () => {
    expect(leerConfigLector({ NP7_AI_CONCURRENCY: '0' }).concurrencia).toBe(1);
    expect(leerConfigLector({ NP7_AI_CONCURRENCY: '-3' }).concurrencia).toBe(1);
    expect(leerConfigLector({ NP7_AI_CONCURRENCY: '50' }).concurrencia).toBe(CONCURRENCIA_MAX);
    expect(leerConfigLector({ NP7_AI_CONCURRENCY: '5' }).concurrencia).toBe(5);
  });

  it('una concurrencia ilegible usa 1 (lo seguro), no el defecto, y lo avisa', () => {
    const c = leerConfigLector({ NP7_AI_CONCURRENCY: 'muchas' });
    expect(c.concurrencia).toBe(1);
    expect(c.advertencias.join(' ')).toMatch(/NP7_AI_CONCURRENCY/);
  });

  it('tope diario: 0 = ninguna lectura; ilegible o negativo = 0, nunca el defecto', () => {
    expect(leerConfigLector({ NP7_AI_DAILY_CAP: '0' }).topeDiario).toBe(0);
    expect(leerConfigLector({ NP7_AI_DAILY_CAP: '35' }).topeDiario).toBe(35);
    for (const v of ['doscientas', '-1', '2.5']) {
      const c = leerConfigLector({ NP7_AI_DAILY_CAP: v });
      expect(c.topeDiario).toBe(0);
      expect(c.advertencias.join(' ')).toMatch(/NP7_AI_DAILY_CAP/);
    }
  });

  it('modelo, effort y recorte', () => {
    expect(leerConfigLector({ NP7_AI_MODEL: ' claude-haiku-4-5 ' }).modelo).toBe('claude-haiku-4-5');
    expect(leerConfigLector({ NP7_AI_EFFORT: 'HIGH' }).effort).toBe('high');
    expect(leerConfigLector({ NP7_AI_EFFORT: 'none' }).effort).toBeNull();
    const raro = leerConfigLector({ NP7_AI_EFFORT: 'turbo' });
    expect(raro.effort).toBe(EFFORT_DEFECTO);
    expect(raro.advertencias.join(' ')).toMatch(/NP7_AI_EFFORT/);
    expect(leerConfigLector({ NP7_AI_RECORTE: 'ninguno' }).recorte).toBe('ninguno');
    const r = leerConfigLector({ NP7_AI_RECORTE: 'cuadrado' });
    expect(r.recorte).toBe('silueta');
    expect(r.advertencias.join(' ')).toMatch(/NP7_AI_RECORTE/);
  });
});
