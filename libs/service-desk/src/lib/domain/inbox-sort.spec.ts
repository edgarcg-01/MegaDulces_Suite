import { describe, expect, it } from 'vitest';
import { clausulasOrden, COLUMNAS_ORDEN, direccionInicial, validarOrden } from './inbox-sort';

describe('`[MS.3.16]` validarOrden', () => {
  it('sin sort no hay orden elegido: manda el de siempre', () => {
    expect(validarOrden(undefined, undefined)).toEqual({ ok: true, columna: null, direccion: 'asc' });
    expect(validarOrden('', 'desc')).toEqual({ ok: true, columna: null, direccion: 'asc' });
  });
  it('acepta cada columna de la lista, con asc por omisión', () => {
    for (const c of COLUMNAS_ORDEN) expect(validarOrden(c, undefined)).toEqual({ ok: true, columna: c, direccion: 'asc' });
  });
  it('respeta desc (sin importar mayúsculas)', () => {
    expect(validarOrden('plazo', 'DESC')).toEqual({ ok: true, columna: 'plazo', direccion: 'desc' });
  });
  it('⛔ NEGATIVA — una columna que no está en la lista se rechaza, no se concatena', () => {
    for (const malo of ['r.id; DROP TABLE servicedesk.requests', 'password', 'title', 'folio desc', "folio'--"]) {
      const r = validarOrden(malo, 'asc');
      expect(r.ok).toBe(false);
    }
  });
  it('⛔ NEGATIVA — una dirección rara se rechaza', () => {
    expect(validarOrden('folio', 'asc; select 1').ok).toBe(false);
    expect(validarOrden('folio', 'up').ok).toBe(false);
  });
});

describe('`[MS.3.16]` clausulasOrden', () => {
  it('todas las columnas terminan con desempate fijo (antigüedad, id): la lista no baila', () => {
    for (const c of COLUMNAS_ORDEN) {
      const cl = clausulasOrden(c, 'desc');
      expect(cl.slice(-2)).toEqual(['r.created_at ASC', 'r.id ASC']);
    }
  });
  it('⭐ los vacíos van SIEMPRE al final, ascendente o descendente', () => {
    for (const c of ['ubicacion', 'atiende', 'plazo'] as const) {
      expect(clausulasOrden(c, 'asc')[0]).toMatch(/ASC NULLS LAST$/);
      expect(clausulasOrden(c, 'desc')[0]).toMatch(/DESC NULLS LAST$/);
    }
  });
  it('la prioridad ordena por gravedad, no por el texto (urgente > alta > media > baja)', () => {
    const [p] = clausulasOrden('prioridad', 'desc');
    expect(p).toContain("WHEN 'urgente' THEN 3");
    expect(p).toContain("WHEN 'alta' THEN 2");
    expect(p).toMatch(/DESC$/);
  });
  it('el estado ordena por el ciclo de vida, no alfabéticamente', () => {
    const [e] = clausulasOrden('estado', 'asc');
    expect(e.indexOf("'nuevo' THEN 0")).toBeGreaterThan(-1);
    expect(e.indexOf("'nuevo'")).toBeLessThan(e.indexOf("'cerrado'"));
  });
  it('⭐ la ubicación se ordena por el NOMBRE que se ve, no por su código (8 Esquinas antes que La Piedad antes que Oficinas)', () => {
    const [u] = clausulasOrden('ubicacion', 'asc', { '02': 'La Piedad Abastos', '03': '8 Esquinas', OF: 'Oficinas Corporativas' });
    expect(u).toContain("WHEN '03' THEN '8 esquinas'");
    expect(u).toContain("WHEN 'OF' THEN 'oficinas corporativas'");
    expect(u).toMatch(/ELSE lower\(r\.warehouse_code\) END ASC NULLS LAST$/);
  });
  it('⛔ un nombre con comilla no rompe la consulta (se escapa)', () => {
    const [u] = clausulasOrden('ubicacion', 'asc', { X: "O'Brien" });
    expect(u).toContain("'o''brien'");
  });
  it('sin nombres cae al código (no revienta)', () => {
    expect(clausulasOrden('ubicacion', 'desc')[0]).toBe('r.warehouse_code DESC NULLS LAST');
  });
  it('⛔ nada de lo que produce lleva puntuación peligrosa más allá de lo fijo', () => {
    for (const c of COLUMNAS_ORDEN) for (const d of ['asc', 'desc'] as const) for (const f of clausulasOrden(c, d)) expect(f).not.toMatch(/;|--|\$\{/);
  });
});

describe('`[MS.3.16]` direccionInicial', () => {
  it('prioridad y alta arrancan de lo más urgente / reciente; el resto de la A a la Z', () => {
    expect(direccionInicial('prioridad')).toBe('desc');
    expect(direccionInicial('alta')).toBe('desc');
    expect(direccionInicial('folio')).toBe('asc');
    expect(direccionInicial('plazo')).toBe('asc');
  });
});
