/**
 * `[NP.7.L.11d]` El costo de una llamada, a mano y contra la tabla (USD por 1M de tokens, al 2026-10-06).
 * Lo que importa más que el número: modelo sin precio o respuesta sin usage → `null`, nunca 0.
 */
import { costoDeLlamada, PRECIOS_AL } from './lector-costos';

describe('[NP.7.L.11d] costoDeLlamada', () => {
  it('Opus 5.5: entrada 4, salida 20, lectura de caché 0.20 explícita, escritura 1.25 × entrada', () => {
    const u = costoDeLlamada('claude-opus-5-5', { input_tokens: 1000, output_tokens: 500, cache_read_input_tokens: 2000, cache_creation_input_tokens: 1500 });
    // 1000×4 + 1500×5 + 2000×0.20 + 500×20 = 4000 + 7500 + 400 + 10000 = 21,900 por 1M
    expect(u.costo_usd).toBe(0.0219);
    expect(u).toMatchObject({ modelo: 'claude-opus-5-5', input_tokens: 1000, output_tokens: 500, cache_read_input_tokens: 2000, cache_creation_input_tokens: 1500 });
    expect(u.precio_fuente).toContain(`tabla al ${PRECIOS_AL}`);
    expect(u.precio_fuente).not.toContain('0.1 × entrada'); // Opus trae su precio de lectura
  });

  it('Sonnet 5.5: 2 / 10', () => {
    expect(costoDeLlamada('claude-sonnet-5-5', { input_tokens: 1000, output_tokens: 1000 }).costo_usd).toBe(0.012);
  });

  it('Haiku 4.5 con fecha en el id: 1 / 5, lectura de caché 0.1 × entrada (y lo dice)', () => {
    const u = costoDeLlamada('claude-haiku-4-5-20251001', { input_tokens: 1000, output_tokens: 100, cache_read_input_tokens: 10_000, cache_creation_input_tokens: null });
    // 1000×1 + 10000×0.1 + 100×5 = 2,500 por 1M
    expect(u.costo_usd).toBe(0.0025);
    expect(u.cache_creation_input_tokens).toBe(0);
    expect(u.modelo).toBe('claude-haiku-4-5-20251001');
    expect(u.precio_fuente).toContain('claude-haiku-4-5:');
    expect(u.precio_fuente).toContain('0.1 × entrada');
  });

  it('Haiku 5.5: hasta 100K tokens de prompt 0.10 / 0.50; arriba, 0.50 / 2.50 (el prompt cuenta la caché)', () => {
    expect(costoDeLlamada('claude-haiku-5-5', { input_tokens: 50_000, output_tokens: 1000 }).costo_usd).toBe(0.0055);
    // Exactamente 100K sigue en el tramo corto.
    expect(costoDeLlamada('claude-haiku-5-5', { input_tokens: 100_000, output_tokens: 0 }).costo_usd).toBe(0.01);
    const largo = costoDeLlamada('claude-haiku-5-5', { input_tokens: 90_000, output_tokens: 1000, cache_read_input_tokens: 20_000 });
    // 90000×0.5 + 20000×0.05 + 1000×2.5 = 45000 + 1000 + 2500 = 48,500 por 1M
    expect(largo.costo_usd).toBe(0.0485);
    expect(largo.precio_fuente).toContain('tramo de prompt > 100,000 tokens');
  });

  it('modelo sin precio en la tabla → costo null (no 0) y sin fuente; los tokens se guardan igual', () => {
    for (const modelo of ['claude-opus-4-8', 'claude-opus-5-5-preview', 'otro-modelo']) {
      const u = costoDeLlamada(modelo, { input_tokens: 10, output_tokens: 5 });
      expect(u.costo_usd, modelo).toBeNull();
      expect(u.precio_fuente).toBeNull();
      expect(u.input_tokens).toBe(10);
    }
  });

  it('respuesta sin usage (o con tokens que no son número) → costo NO MEDIDO, declarado', () => {
    for (const usage of [undefined, null, {}, { input_tokens: '1000', output_tokens: 5 }, { input_tokens: 10 }]) {
      const u = costoDeLlamada('claude-opus-5-5', usage);
      expect(u.costo_usd).toBeNull();
      expect(u.precio_fuente).toContain('NO MEDIDO');
    }
  });

  it('cero tokens con modelo conocido sí es cero medido (no es lo mismo que null)', () => {
    expect(costoDeLlamada('claude-opus-5-5', { input_tokens: 0, output_tokens: 0 }).costo_usd).toBe(0);
  });
});
