import { estadoDeExistencia, mensajeExistencia, ODS_HOT_TOLERANCIA_H, sinExistenciaAfirmada, type StockState } from './stock-state.contract';

/**
 * `[MCP.3.16]` La regla del estado de existencia. Cada estado lleva su prueba negativa: el caso
 * vecino que NO debe caer en él, para que la regla no se valide contra sí misma.
 */
describe('[MCP.3.16] estadoDeExistencia', () => {
  it('con_existencia: medido, con registro y > 0', () => {
    expect(estadoDeExistencia({ medido: true, conRegistro: true, qty: 14 })).toBe('con_existencia');
    expect(estadoDeExistencia({ medido: true, conRegistro: true, qty: 0.5 })).toBe('con_existencia');
    // Negativa: la misma cantidad SIN medición no se afirma.
    expect(estadoDeExistencia({ medido: false, conRegistro: true, qty: 14 })).toBe('sin_dato');
  });

  it('agotado: medido, con registro y <= 0', () => {
    expect(estadoDeExistencia({ medido: true, conRegistro: true, qty: 0 })).toBe('agotado');
    expect(estadoDeExistencia({ medido: true, conRegistro: true, qty: -3 })).toBe('agotado');
    // Negativa: sin registro no es «agotado», es «no se maneja».
    expect(estadoDeExistencia({ medido: true, conRegistro: false, qty: 0 })).toBe('no_se_maneja');
  });

  it('no_se_maneja: medido y sin registro (la cantidad no importa)', () => {
    expect(estadoDeExistencia({ medido: true, conRegistro: false, qty: null })).toBe('no_se_maneja');
    // Negativa: con lectura vieja no se puede afirmar que la sucursal no lo maneja.
    expect(estadoDeExistencia({ medido: false, conRegistro: false, qty: null })).toBe('sin_dato');
  });

  it('sin_dato: sin medición gana a todo lo demás', () => {
    for (const conRegistro of [true, false]) for (const qty of [null, -1, 0, 5]) {
      expect(estadoDeExistencia({ medido: false, conRegistro, qty })).toBe('sin_dato');
    }
    // Un registro sin cantidad legible tampoco se dibuja como 0.
    expect(estadoDeExistencia({ medido: true, conRegistro: true, qty: null })).toBe('sin_dato');
    expect(estadoDeExistencia({ medido: true, conRegistro: true, qty: Number.NaN })).toBe('sin_dato');
    // Negativa: medido y con registro en 0 NO es sin_dato.
    expect(estadoDeExistencia({ medido: true, conRegistro: true, qty: 0 })).not.toBe('sin_dato');
  });
});

describe('[DN.7] sinExistenciaAfirmada (ya no bloquea: ADR-115)', () => {
  it('la lectura afirma que no hay: agotado y no_se_maneja', () => {
    expect(sinExistenciaAfirmada('agotado')).toBe(true);
    expect(sinExistenciaAfirmada('no_se_maneja')).toBe(true);
  });

  it('negativa: sin_dato, con_existencia y la ausencia de estado NO afirman nada', () => {
    const libres: Array<StockState | null | undefined> = ['sin_dato', 'con_existencia', null, undefined];
    for (const s of libres) expect(sinExistenciaAfirmada(s)).toBe(false);
  });
});

describe('[DN.7] mensajeExistencia (el mismo texto en servidor y pantalla)', () => {
  it('con alternativas: dónde puede no haber y quién sí tiene', () => {
    expect(mensajeExistencia({ state: 'agotado', surtido: 'PH', alternativas: [{ short: 'LPA', texto: '14' }, { short: '8ES', texto: '3' }], zonaCompleta: false, sinDato: ['YU'] }))
      .toBe('Puede estar agotado en PH · LPA tiene 14 · 8ES tiene 3');
  });

  it('⭐ ADR-115: nunca dice «No se puede agregar» (el renglón SÍ se guarda)', () => {
    const casos = [
      mensajeExistencia({ state: 'agotado', surtido: 'PH', alternativas: [], zonaCompleta: true, sinDato: [] }),
      mensajeExistencia({ state: 'no_se_maneja', surtido: 'PH', alternativas: [{ short: 'LPA', texto: '2' }], zonaCompleta: false, sinDato: [] }),
      mensajeExistencia({ state: 'agotado', surtido: 'PH', alternativas: [], zonaCompleta: false, sinDato: ['YU'] }),
    ];
    for (const m of casos) expect(m).not.toMatch(/no se puede/i);
  });

  it('«tampoco hay en tu zona» SÓLO con la zona entera medida', () => {
    expect(mensajeExistencia({ state: 'agotado', surtido: 'PH', alternativas: [], zonaCompleta: true, sinDato: [] }))
      .toBe('Puede estar agotado en PH · tampoco hay en tu zona');
    // Negativa: con una sucursal sin dato no se afirma que nadie tiene; se nombra la que falta.
    const m = mensajeExistencia({ state: 'agotado', surtido: 'PH', alternativas: [], zonaCompleta: false, sinDato: ['YU', 'LPA'] });
    expect(m).toBe('Puede estar agotado en PH · sin dato de YU, LPA');
    expect(m).not.toContain('tu zona');
    // Negativa: sin zona resuelta (y sin sucursales sin dato) sólo lo que se sabe.
    expect(mensajeExistencia({ state: 'agotado', surtido: 'PH', alternativas: [], zonaCompleta: false, sinDato: [] }))
      .toBe('Puede estar agotado en PH');
  });

  it('no_se_maneja se dice distinto de agotado (DA3: para Compras son decisiones distintas)', () => {
    expect(mensajeExistencia({ state: 'no_se_maneja', surtido: 'PH', alternativas: [{ short: 'LPA', texto: '14' }], zonaCompleta: false, sinDato: [] }))
      .toBe('PH no lo maneja · LPA tiene 14');
    // Negativa: el mismo caso en agotado no dice «no lo maneja».
    expect(mensajeExistencia({ state: 'agotado', surtido: 'PH', alternativas: [{ short: 'LPA', texto: '14' }], zonaCompleta: false, sinDato: [] }))
      .not.toContain('no lo maneja');
  });
});

describe('[MCP.3.16] tolerancia del carril', () => {
  it('6 h, la misma que usan store.service y route-promo para ods_live_hot', () => {
    expect(ODS_HOT_TOLERANCIA_H).toBe(6);
  });
});
