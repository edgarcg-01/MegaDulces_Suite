import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  defaultPickSequence,
  expandLocationRange,
  LOCATION_BULK_MAX,
  parseAssignmentRole,
  resolvePresentation,
  type ProductPresentation,
  describeLocationCode,
  formatLocationCode,
  LOCATION_CODE_RE,
  parseLocationCode,
  rackFace,
  rackOpuesto,
  CART_CODE_RE,
  describeCart,
  formatCartCode,
  parseCartCode,
} from './warehouse-locations.contract';

describe('[UB.1] código de ubicación', () => {
  it('BA053 = bodega · pasillo A · rack 05 · nivel 3', () => {
    const r = parseLocationCode('BA053');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.parts).toEqual({ zona: 'B', pasillo: 'A', rack: 5, nivel: 3 });
      expect(describeLocationCode(r.parts)).toBe('Bodega · pasillo A · frente de nones · rack 05 · nivel 3');
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

  // [UB.NV.1] De 1 a 9 desde el 2026-11-26: antes era 1 a 6 y 11 racks de Padre Hidalgo ya estaban topados.
  it('el nivel va de 1 a 9', () => {
    expect(parseLocationCode('BA016').ok).toBe(true);
    expect(parseLocationCode('BA019').ok).toBe(true);
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
    ['BA050', 'nivel'],
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
    expect(() => formatLocationCode({ zona: 'B', pasillo: 'A', rack: 1, nivel: 10 })).toThrow();
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

  /**
   * `[UB.RF.18]` Un pasillo es un corredor con dos frentes enfrentados (Edgar, 2026-11-25): los nones
   * de un lado y los pares del otro. El recorrido baja por los nones y vuelve por los pares; antes iba
   * 01, 02, 03…, que obliga a cruzar el corredor una vez por rack.
   */
  describe('[UB.RF.18] los dos frentes del pasillo', () => {
    const seq = (c: string) => {
      const r = parseLocationCode(c);
      if (!r.ok) throw new Error(c);
      return defaultPickSequence(r.parts);
    };

    it('⭐ el frente se DEDUCE del número: nones de un lado, pares del otro', () => {
      expect(rackFace(1)).toBe('nones');
      expect(rackFace(25)).toBe('nones');
      expect(rackFace(2)).toBe('pares');
      expect(rackFace(24)).toBe('pares');
    });

    it('⭐ enfrente del rack n está el n+1 (los dos frentes son parejos, Edgar 2026-11-25)', () => {
      expect(rackOpuesto(5)).toBe(6);
      expect(rackOpuesto(6)).toBe(5);
      expect(rackOpuesto(1)).toBe(2);
    });

    it('⭐ el recorrido baja por los nones y vuelve por los pares (pasillo de 6 racks)', () => {
      const codes = ['BA011', 'BA021', 'BA031', 'BA041', 'BA051', 'BA061'];
      expect([...codes].sort((a, b) => seq(a) - seq(b))).toEqual(['BA011', 'BA031', 'BA051', 'BA061', 'BA041', 'BA021']);
    });

    it('⛔ NEGATIVA: ya NO es el orden viejo 01, 02, 03… (si vuelve, son 24 cruces del corredor en un pasillo de 25)', () => {
      expect(seq('BA021')).toBeGreaterThan(seq('BA031'));
      expect(seq('BA021')).toBeGreaterThan(seq('BA251'));
    });

    it('NEGATIVA: la vuelta por los pares no se mete en el pasillo siguiente', () => {
      expect(seq('BA026')).toBeLessThan(seq('BB011'));
      expect(seq('BA986')).toBeLessThan(seq('BB011'));
    });

    it('dentro de un rack, el nivel sigue mandando al final', () => {
      expect(seq('BA051')).toBeLessThan(seq('BA052'));
      expect(seq('BA062')).toBeLessThan(seq('BA042'));
    });
  });

  it('la regla del CHECK de la base es la misma expresión (si cambia una, que se note)', () => {
    expect(LOCATION_CODE_RE.source).toBe('^([TB])([A-Z])(0[1-9]|[1-9][0-9])([1-9])$');
  });
});

/**
 * `[UB.NV.1]` El tope del nivel subió de 6 a 9 el 2026-11-26: 11 racks de Padre Hidalgo ya estaban
 * topados en el 6 y no se podía dar de alta el entrepaño siguiente. Nueve es el techo porque el
 * código son 5 caracteres y el nivel es el último.
 */
describe('[UB.NV.1] el nivel llega al 9', () => {
  const seq = (c: string) => {
    const r = parseLocationCode(c);
    if (!r.ok) throw new Error(c);
    return defaultPickSequence(r.parts);
  };

  it('⭐ el 7, el 8 y el 9 son niveles válidos', () => {
    for (const code of ['BA057', 'BA058', 'BA059']) {
      expect(parseLocationCode(code).ok).toBe(true);
    }
  });

  it('⛔ NEGATIVA: el 0 y el 10 siguen fuera — un nivel de dos dígitos haría un código de 6 caracteres', () => {
    expect(parseLocationCode('BA050').ok).toBe(false);
    expect(parseLocationCode('BA0510').ok).toBe(false);
  });

  it('⭐ el nivel 9 NO se le mete al rack siguiente en el recorrido de surtido', () => {
    // El rack 05 entero (hasta su nivel 9) va antes que el primer nivel del 07: por eso el nivel
    // sólo puede ocupar UN dígito — un 10 caería dentro del rack vecino.
    expect(seq('BA059')).toBeLessThan(seq('BA071'));
    expect(seq('BA031')).toBeLessThan(seq('BA059'));
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
    [{ nivel_hasta: 10 }, 'del 1 al 9'],
    [{ nivel_desde: 3, nivel_hasta: 1 }, 'del 1 al 9'],
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

describe('[UB.3] leer presentación y papel como los escribe la gente', () => {
  // La escalera real del 70243 en PH (medida en prod): PAQ base · peldaño 2 fantasma · CJA ×20.
  const mazapan: ProductPresentation[] = [
    { peldano: 1, rotulo: 'PAQ', factor: 1, fuente: 'base', codigos: ['724869008464'], es_caja: false },
    { peldano: 3, rotulo: 'CJA', factor: 20, fuente: 'capturado', codigos: ['C70243'], es_caja: true },
  ];

  it.each([
    ['caja', 3], ['CAJA', 3], ['cja', 3], ['3', 3],
    ['paquete', 1], ['Paquete', 1], ['PAQ', 1], ['1', 1],
  ])('%j → peldaño %i', (raw, peldano) => {
    const r = resolvePresentation(raw, mazapan);
    expect(r.ok && r.peldano).toBe(peldano);
  });

  it('una presentación que el producto no tiene se rechaza diciendo cuáles sí', () => {
    const r = resolvePresentation('pieza', mazapan);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.motivo).toContain('1 = PAQ, 3 = CJA');
  });

  it('el peldaño fantasma (2) no existe para elegirlo', () => {
    expect(resolvePresentation('2', mazapan).ok).toBe(false);
  });

  it('si dos peldaños comparten rótulo, pide el número (no adivina)', () => {
    const doble: ProductPresentation[] = [
      { peldano: 1, rotulo: 'PZA', factor: 1, fuente: 'base', codigos: [], es_caja: false },
      { peldano: 2, rotulo: 'CJA', factor: 12, fuente: 'capturado', codigos: [], es_caja: false },
      { peldano: 3, rotulo: 'CJA', factor: 48, fuente: 'capturado', codigos: [], es_caja: true },
    ];
    const r = resolvePresentation('caja', doble);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.motivo).toContain('Usa el número');
    expect(resolvePresentation('3', doble).ok).toBe(true);
  });

  it.each([
    ['Surtido', 'surtido_fijo'], ['lugar fijo', 'surtido_fijo'], ['exhibición', 'exhibicion_tienda'],
    ['Tienda', 'exhibicion_tienda'], ['RESERVA', 'reserva_preferida'], ['bodega', null], ['', null],
  ])('papel %j → %s', (raw, papel) => {
    expect(parseAssignmentRole(raw)).toBe(papel);
  });
});

describe('[GP.11.1] código de carreta', () => {
  it('⭐ lo que escanea la pistola y lo que se teclea en el celular terminan en el mismo código', () => {
    for (const raw of ['C07', 'c07', '7', '07', 'C7', ' c 7 ']) {
      const r = parseCartCode(raw);
      expect(r).toEqual({ ok: true, code: 'C07', numero: 7 });
    }
    expect(parseCartCode('C99')).toEqual({ ok: true, code: 'C99', numero: 99 });
  });

  it('NEGATIVA: fuera de C01–C99, o algo que no es número, se explica (no se adivina)', () => {
    for (const raw of ['C00', '0', 'C100', '100', 'BA053', 'CA1', '', null]) {
      const r = parseCartCode(raw);
      expect(r.ok).toBe(false);
    }
    const r = parseCartCode('C100');
    expect(r.ok === false && r.motivo).toContain('C01 a la C99');
  });

  it('la expresión del contrato es la del CHECK de la base, y no choca con una ubicación', () => {
    expect(CART_CODE_RE.source).toBe('^C(0[1-9]|[1-9][0-9])$');
    expect(CART_CODE_RE.test('BA053')).toBe(false);
    expect(LOCATION_CODE_RE.test('C07')).toBe(false);
    expect(formatCartCode(12)).toBe('C12');
    expect(() => formatCartCode(100)).toThrow();
    expect(describeCart('carrito', 12)).toBe('Carrito 12');
  });

  it('⭐ la migración usa la MISMA expresión que el contrato (una regla, tres compuertas)', () => {
    const mig = fs.readFileSync(path.resolve(__dirname, '../../../../database/migrations-newdb/20261120112959_gp11_1_carretas_en_catalogo.js'), 'utf8');
    expect(/const CART_RE = '([^']+)'/.exec(mig)?.[1]).toBe(CART_CODE_RE.source);
  });
});
