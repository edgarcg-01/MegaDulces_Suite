import { veredictoArbitro } from './arbitro-por-cambio.engine';

describe('[OPS-AUD.11.6] veredicto del árbitro por cambio', () => {
  it('todo en cero y sin errores: sin fallas', () => {
    const v = veredictoArbitro(
      [{ objeto: 'tesoreria', faltan: 0, sobran: 0 }, { objeto: 'polizas:kdc22610', faltan: 0, sobran: 0 }],
      { 'analytics.bank_movement_legs_errors': 0 },
    );
    expect(v.fallas).toEqual([]);
    expect(v.limpios).toBe(2);
    expect(v.nota).toBe('2 de 2 sin diferencias');
  });

  it('⛔ una diferencia REPARADA sigue siendo falla: el trigger tiene un hueco', () => {
    const v = veredictoArbitro(
      [{ objeto: 'tesoreria', faltan: 1, sobran: 0, tras_reparar: { faltan: 0, sobran: 0 } }], {},
    );
    expect(v.fallas).toHaveLength(1);
    expect(v.fallas[0]).toContain('reparado');
    expect(v.limpios).toBe(0);
  });

  it('una diferencia que la reparación no cierra lo dice', () => {
    const v = veredictoArbitro(
      [{ objeto: 'polizas:kdc22607', faltan: 3, sobran: 2, tras_reparar: { faltan: 0, sobran: 2 } }], {},
    );
    expect(v.fallas[0]).toContain('NO se reparó');
  });

  it('⛔ lo que no se pudo medir se DECLARA, no cuenta como limpio', () => {
    const v = veredictoArbitro([{ objeto: 'tesoreria', faltan: null, sobran: null, error: 'timeout' }], {});
    expect(v.sin_medir).toBe(1);
    expect(v.limpios).toBe(0);
    expect(v.fallas[0]).toContain('NO MEDIDO');
  });

  it('[OPS-AUD.13.2] una póliza fuera de las 00:00 es falla, y nombra la tabla', () => {
    const v = veredictoArbitro([{ objeto: 'tesoreria', faltan: 0, sobran: 0 }], {}, { kdc22610: 8, kdc22609: 0 });
    expect(v.fallas).toHaveLength(1);
    expect(v.fallas[0]).toContain('kdc22610 8');
    expect(v.fallas[0]).not.toContain('kdc22609');
  });

  it('un error del trigger en la ventana es falla aunque las tablas den cero', () => {
    const v = veredictoArbitro([{ objeto: 'tesoreria', faltan: 0, sobran: 0 }], { 'analytics.gl_polizas_kepler_errors': 2 });
    expect(v.fallas).toEqual(['analytics.gl_polizas_kepler_errors: 2 error(es) del trigger en las últimas 25 h']);
  });
});
