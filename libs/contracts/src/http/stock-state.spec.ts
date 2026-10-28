import { bloqueaAgregar, estadoDeExistencia, mensajeSinExistencia, ODS_HOT_TOLERANCIA_H, type StockState } from './stock-state.contract';

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

describe('[MCP.3.16] bloqueaAgregar', () => {
  it('bloquean agotado y no_se_maneja', () => {
    expect(bloqueaAgregar('agotado')).toBe(true);
    expect(bloqueaAgregar('no_se_maneja')).toBe(true);
  });

  it('NO bloquean sin_dato, con_existencia ni la ausencia de estado', () => {
    const libres: Array<StockState | null | undefined> = ['sin_dato', 'con_existencia', null, undefined];
    for (const s of libres) expect(bloqueaAgregar(s)).toBe(false);
  });
});

describe('[MCP.3.16] mensajeSinExistencia (el mismo texto en servidor y pantalla)', () => {
  it('con alternativas: dónde no hay y quién sí tiene', () => {
    expect(mensajeSinExistencia({ surtido: 'PH', alternativas: [{ short: 'LPA', texto: '14' }, { short: '8ES', texto: '3' }], zonaCompleta: false, sinDato: ['YU'] }))
      .toBe('No se puede agregar: no hay existencias en PH · LPA tiene 14 · 8ES tiene 3');
  });

  it('«no hay en tu zona» SÓLO con la zona entera medida', () => {
    expect(mensajeSinExistencia({ surtido: 'PH', alternativas: [], zonaCompleta: true, sinDato: [] }))
      .toBe('No se puede agregar un producto que no hay en tu zona');
    // Negativa: con una sucursal sin dato no se afirma que nadie tiene; se nombra la que falta.
    const m = mensajeSinExistencia({ surtido: 'PH', alternativas: [], zonaCompleta: false, sinDato: ['YU', 'LPA'] });
    expect(m).toBe('No se puede agregar: no hay existencias en PH · sin dato de YU, LPA');
    expect(m).not.toContain('tu zona');
    // Negativa: sin zona resuelta (y sin sucursales sin dato) sólo lo que se sabe.
    expect(mensajeSinExistencia({ surtido: 'PH', alternativas: [], zonaCompleta: false, sinDato: [] }))
      .toBe('No se puede agregar: no hay existencias en PH');
  });
});

describe('[MCP.3.16] tolerancia del carril', () => {
  it('6 h, la misma que usan store.service y route-promo para ods_live_hot', () => {
    expect(ODS_HOT_TOLERANCIA_H).toBe(6);
  });
});
