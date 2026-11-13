import { avisoCaja, cambioDeLaUnidad, ultimoCambioDe, type CambioFicha } from './aviso-caja';

/** `[GP.9.2]` Anclado al caso Canindo (06, SKU 95644: capturado 10 CJA de 40, la ficha hoy dice 25)
 *  y a filas reales de `kepler_ficha_history` de la 06 (2026-11-12). */
const cambio = (o: Partial<CambioFicha> = {}): CambioFicha => ({
  sku: '95644', u2: 'CJA', f2: 25, u3: null, f3: 0, pu2: 'CJA', pf2: 40, pu3: null, pf3: 0,
  observado_at: '2026-11-10T16:00:00.000Z', ...o,
});
/** SKU 20128 (06, 07-nov): la CJA pasó de la 2ª a la 3ª presentación con el MISMO factor. 150 de 178 eran así. */
const reacomodo = (o: Partial<CambioFicha> = {}): CambioFicha => ({
  sku: '20128', pu2: 'CJA', pf2: 12, u2: 'PAQ', f2: 1, pu3: null, pf3: 0, u3: 'CJA', f3: 12,
  observado_at: '2026-11-07T15:31:39.000Z', ...o,
});

describe('avisoCaja', () => {
  it('capturada con otra caja → cuenta en la BASE, con el texto que lee el surtidor', () => {
    const a = avisoCaja([{ sku: '95644', captured_unit: 'CJA', captured_factor: 40, current_factor: 25 }], [], 'CJA', 400, 'PAQ');
    expect(a).toEqual({
      tipo: 'capturada_con_otra', unidad: 'CJA', factor_antes: 40, factor_hoy: 25, desde: null,
      texto: 'El pedido se capturó con CJA de 40 y hoy la CJA es de 25. Cuenta 400 PAQ, no cajas.',
    });
  });

  it('la capturada gana sobre la transición, y toma la fecha del cambio de esa misma caja', () => {
    const a = avisoCaja([{ sku: '95644', captured_unit: 'CJA', captured_factor: 40, current_factor: 25 }], [cambio()], 'CJA', 400, 'PAQ');
    expect(a?.tipo).toBe('capturada_con_otra');
    expect(a?.desde).toBe('2026-11-10T16:00:00.000Z');
  });

  it('factor capturado igual al de hoy NO avisa como capturada (prueba negativa)', () => {
    expect(avisoCaja([{ sku: 'x', captured_unit: 'CJA', captured_factor: 25, current_factor: 25 }], [], 'CJA', 250, 'PAQ')).toBeNull();
  });

  it('transición de la caja de la hoja → avisa con la fecha, en español', () => {
    const a = avisoCaja([], [cambio()], 'CJA', 250, 'PAQ');
    expect(a?.tipo).toBe('transicion');
    expect(a?.texto).toBe('La CJA cambió de 40 a 25 el 10 nov: revisa cuántas piezas trae antes de contarla por caja.');
  });

  it('⭐ la CJA cambia de casilla con el MISMO factor (20128) → NO es transición', () => {
    expect(avisoCaja([], [reacomodo()], 'CJA', 24, 'PAQ')).toBeNull();
  });

  it('un reacomodo reciente no tapa un cambio real anterior en los 30 días', () => {
    const real = cambio({ sku: '20128', pu2: 'CJA', pf2: 10, u2: 'CJA', f2: 12, observado_at: '2026-11-05T12:00:00.000Z' });
    const a = avisoCaja([], [reacomodo(), real], 'CJA', 24, 'PAQ');
    expect(a).toMatchObject({ tipo: 'transicion', factor_antes: 10, factor_hoy: 12, desde: '2026-11-05T12:00:00.000Z' });
  });

  it('cambió OTRA presentación (la BTO) y la hoja pide CJA → sin aviso', () => {
    const c = cambio({ u2: 'CJA', f2: 25, pu2: 'CJA', pf2: 25, u3: 'BTO', f3: 100, pu3: 'BTO', pf3: 80 });
    expect(avisoCaja([], [c], 'CJA', 250, 'PAQ')).toBeNull();
    expect(avisoCaja([], [c], 'BTO', 100, 'PAQ')?.factor_antes).toBe(80);
  });

  it('se cuenta en la base (sin presentación) → la transición no aplica', () => {
    expect(avisoCaja([], [cambio()], null, 400, 'PAQ')).toBeNull();
  });

  it('factores con decimales se escriben sin ceros de más', () => {
    const a = avisoCaja([{ sku: 'x', captured_unit: 'BTO', captured_factor: 2, current_factor: 2.5 }], [], 'BTO', 10, 'KG');
    expect(a?.texto).toBe('El pedido se capturó con BTO de 2 y hoy la BTO es de 2.5. Cuenta 10 KG, no cajas.');
  });
});

describe('cambioDeLaUnidad (por nombre de unidad, no por casilla)', () => {
  it('detecta el cambio de factor de la unidad pedida, sin importar mayúsculas', () => {
    expect(cambioDeLaUnidad(cambio(), 'cja')).toEqual({ antes: 40, hoy: 25 });
  });
  it('CJA de 40 a 4 con la unidad en la 3ª casilla (87313, 09-nov) → sí es cambio', () => {
    expect(cambioDeLaUnidad(cambio({ pu2: 'PAQ', pf2: 1, u2: 'PAQ', f2: 1, pu3: 'CJA', pf3: 40, u3: 'CJA', f3: 4 }), 'CJA')).toEqual({ antes: 40, hoy: 4 });
  });
  it('antes sin declarar (CJA con factor 0) y hoy 40 (85980) → no hay «de X a Y»', () => {
    expect(cambioDeLaUnidad(cambio({ pu2: 'PAQ', pf2: 1, u2: 'PAQ', f2: 1, pu3: 'CJA', pf3: 0, u3: 'CJA', f3: 40 }), 'CJA')).toBeNull();
  });
  it('la unidad desaparece (renombrada) → null, no se adivina', () => {
    expect(cambioDeLaUnidad(cambio({ u2: 'CJ2' }), 'CJA')).toBeNull();
  });
  it('sin cambio en esa unidad → null', () => {
    expect(cambioDeLaUnidad(cambio({ f2: 40 }), 'CJA')).toBeNull();
  });
  it('ultimoCambioDe sin unidad → null', () => {
    expect(ultimoCambioDe([cambio()], null)).toBeNull();
  });
});
