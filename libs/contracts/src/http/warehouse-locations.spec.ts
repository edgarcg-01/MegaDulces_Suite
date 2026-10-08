import { describe, expect, it } from 'vitest';
import {
  defaultPickSequence,
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

  it('acepta más de 4 pasillos (cualquier letra) y la Ñ', () => {
    expect(parseLocationCode('TZ991').ok).toBe(true);
    expect(parseLocationCode('BÑ016').ok).toBe(true);
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

  it('orden de recorrido: tienda antes que bodega, la Ñ entre la N y la O', () => {
    const seq = (c: string) => {
      const r = parseLocationCode(c);
      if (!r.ok) throw new Error(c);
      return defaultPickSequence(r.parts);
    };
    const codes = ['BO011', 'BÑ011', 'TZ991', 'BN011', 'BA052', 'BA053', 'BA061'];
    const ordenados = [...codes].sort((a, b) => seq(a) - seq(b));
    expect(ordenados).toEqual(['TZ991', 'BA052', 'BA053', 'BA061', 'BN011', 'BÑ011', 'BO011']);
  });

  it('la regla del CHECK de la base es la misma expresión (si cambia una, que se note)', () => {
    expect(LOCATION_CODE_RE.source).toBe('^([TB])([A-ZÑ])(0[1-9]|[1-9][0-9])([1-6])$');
  });
});
