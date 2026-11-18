import { describe, expect, it } from 'vitest';
import { lectorColumnaOpcional, RQ_COLUMNAS_OPCIONALES, type RqColumnaOpcional } from './rq-columnas-opcionales';

describe('[PQ.130] lectorColumnaOpcional — la columna sola, no la fila entera', () => {
  it('si la columna existe, lee SÓLO esa columna con el mismo texto que daba to_jsonb(r) ->> col', () => {
    const opc = lectorColumnaOpcional(new Set(['kepler_folio', 'rejected_at']));
    expect(opc('kepler_folio')).toBe(`to_jsonb(r.kepler_folio) #>> '{}'`);
    expect(opc('rejected_at')).toBe(`to_jsonb(r.rejected_at) #>> '{}'`);
  });

  it('⛔ nunca vuelve a armar la fila completa (el costo que se quitó)', () => {
    const opc = lectorColumnaOpcional(new Set(RQ_COLUMNAS_OPCIONALES));
    for (const c of RQ_COLUMNAS_OPCIONALES) expect(opc(c)).not.toMatch(/to_jsonb\(r\)/);
  });

  it('si falta (el código llegó antes que su migración), NULL::text y no un 42703', () => {
    const opc = lectorColumnaOpcional(new Set(['kepler_folio']));
    expect(opc('kepler_error')).toBe('NULL::text');
    expect(opc('requested_by_branch')).toBe('NULL::text');
  });

  it('respeta el alias de la tabla', () => {
    expect(lectorColumnaOpcional(new Set(['oc_folio']), 'r2')('oc_folio')).toBe(`to_jsonb(r2.oc_folio) #>> '{}'`);
  });

  it('⛔ un nombre fuera de la lista truena: se interpola en SQL', () => {
    const opc = lectorColumnaOpcional(new Set(['x; DROP TABLE y']));
    expect(() => opc('x; DROP TABLE y' as RqColumnaOpcional)).toThrow(/desconocida/);
  });
});
