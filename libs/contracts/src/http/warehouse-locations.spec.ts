import {
  defaultPickSequence,
  expandLocationRange,
  LOCATION_BULK_MAX,
  describeLocationCode,
  formatLocationCode,
  LOCATION_CODE_RE,
  parseLocationCode,
} from './warehouse-locations.contract';

describe('[UB.1] código de ubicación', () => {
  it('BA053 = bodega · pasillo A · rack 05 · nivel 3', () => {
    const r = parseLocationCode('BA053');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.parts).toEqual({ zona: 'B', pasillo: 'A', rack: 5, nivel: 3 });
      expect(describeLocationCode(r.parts)).toBe('Bodega · pasillo A · rack 05 · nivel 3');
    }
  });

  it('normaliza lo que se teclea: minúsculas, espacios y guiones', () => {
    for (const raw of ['ba053', ' BA053 ', 'B-A-05-3', 'b a 05 3']) {
      const r = parseLocationCode(raw);
      expect(r.ok).toBe(true);
      expect(r.code).toBe('BA053');
    }
  });

  it('acepta más de 4 pasillos (cualquier letra A–Z)', () => {
    expect(parseLocationCode('TZ991').ok).toBe(true);
  });

  // Prueba negativa de la decisión de la revisión: la Ñ no la lee el escáner ni el código de barras.
  it('rechaza la Ñ, con su motivo', () => {
    const r = parseLocationCode('BÑ016');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.motivo).toContain('sin Ñ');
  });

  it('el nivel va de 1 a 6', () => {
    expect(parseLocationCode('BA016').ok).toBe(true);
    expect(parseLocationCode('BA017').ok).toBe(false);
    expect(parseLocationCode('BA010').ok).toBe(false);
  });

  // Prueba negativa: cada regla rechaza su caso, con su motivo.
  it.each([
    ['', 'Escribe el código'],
    ['BA53', '5 caracteres'],
    ['XA053', 'T (tienda) o B (bodega)'],
    ['B1053', 'pasillo'],
    ['BA003', 'del 01 al 99'],
    ['BAA53', 'del 01 al 99'],
    ['BA059', 'nivel'],
  ])('rechaza %j', (raw, motivo) => {
    const r = parseLocationCode(raw);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.motivo).toContain(motivo);
  });

  it('formatear y leer son inversos', () => {
    const p = { zona: 'T' as const, pasillo: 'C', rack: 12, nivel: 1 };
    expect(formatLocationCode(p)).toBe('TC121');
    const r = parseLocationCode(formatLocationCode(p));
    expect(r.ok && r.parts).toEqual(p);
  });

  it('formatear rechaza partes imposibles', () => {
    expect(() => formatLocationCode({ zona: 'B', pasillo: 'A', rack: 100, nivel: 1 })).toThrow();
    expect(() => formatLocationCode({ zona: 'B', pasillo: 'A', rack: 1, nivel: 7 })).toThrow();
  });

  it('orden de recorrido: tienda antes que bodega, luego pasillo, rack y nivel', () => {
    const seq = (c: string) => {
      const r = parseLocationCode(c);
      if (!r.ok) throw new Error(c);
      return defaultPickSequence(r.parts);
    };
    const codes = ['BO011', 'BB011', 'TZ991', 'BN011', 'BA052', 'BA053', 'BA061'];
    const ordenados = [...codes].sort((a, b) => seq(a) - seq(b));
    expect(ordenados).toEqual(['TZ991', 'BA052', 'BA053', 'BA061', 'BB011', 'BN011', 'BO011']);
  });

  it('la regla del CHECK de la base es la misma expresión (si cambia una, que se note)', () => {
    expect(LOCATION_CODE_RE.source).toBe('^([TB])([A-Z])(0[1-9]|[1-9][0-9])([1-6])$');
  });
});

describe('[UB.2] expandir un rango', () => {
  const base = { zona: 'B' as const, pasillo_desde: 'A', pasillo_hasta: 'D', rack_desde: 1, rack_hasta: 15, nivel_desde: 1, nivel_hasta: 3 };

  it('B · A–D · 01–15 · 1–3 = 180, en orden de recorrido', () => {
    const r = expandLocationRange(base);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.total).toBe(180);
    expect(r.partes).toHaveLength(180);
    expect(r.partes[0]).toEqual({ zona: 'B', pasillo: 'A', rack: 1, nivel: 1 });
    expect(r.partes[179]).toEqual({ zona: 'B', pasillo: 'D', rack: 15, nivel: 3 });
  });

  it('un solo rack de un solo nivel = 1', () => {
    const r = expandLocationRange({ ...base, pasillo_hasta: 'A', rack_hasta: 1, nivel_hasta: 1 });
    expect(r.ok && r.total).toBe(1);
  });

  it.each([
    [{ pasillo_desde: 'D', pasillo_hasta: 'A' }, 'va antes'],
    [{ pasillo_hasta: 'Ñ' }, 'sin Ñ'],
    [{ rack_desde: 0 }, 'del 01 al 99'],
    [{ rack_hasta: 100 }, 'del 01 al 99'],
    [{ nivel_hasta: 7 }, 'del 1 al 6'],
    [{ nivel_desde: 3, nivel_hasta: 1 }, 'del 1 al 6'],
    [{ zona: 'X' }, 'T (tienda) o B (bodega)'],
  ])('rechaza %j', (cambio, motivo) => {
    const r = expandLocationRange({ ...base, ...(cambio as object) } as typeof base);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.motivo).toContain(motivo);
  });

  it(`frena arriba de ${LOCATION_BULK_MAX} (un error de rango, no una bodega)`, () => {
    const r = expandLocationRange({ ...base, pasillo_hasta: 'Z', rack_hasta: 99, nivel_hasta: 6 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.motivo).toContain('tope');
  });
});
