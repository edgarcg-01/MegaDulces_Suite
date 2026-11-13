// Sin `import ... from 'vitest'`: la config usa `globals: true` (ver transito.spec.ts).

import {
  decidirCancelacionOc, motivoValido, permisosNecesarios, sentenciasCancelacion,
  type EntradaDecision, type OcEnKepler,
} from './kepler-oc-cancelacion';

/** La OC de la Suite que `30APL` canceló a mano el 2026-11-13 (`08|0000362`), antes de cancelarla. */
const OC: OcEnKepler = {
  serie: '1', folio: '0000362', estado: 'N', total: 12560.76, capturista: 'SUITE',
  fecha_captura: '2026-11-09', hora_captura: '17:12', renglones: 4, origen_tipo: '30', origen_folio: '0000064',
};
const base = (o: Partial<EntradaDecision> = {}): EntradaDecision => ({
  oc: OC, coincidencias: 1, vales_vivos: [],
  requisicion: { serie: '1', folio: '0000064', estado: 'F', total: 12560.76, renglones: 4 },
  otras_oc_vivas: [], ...o,
});

describe('[PQ.110] decidirCancelacionOc — sólo lo medido en Kepler', () => {
  it('OC pendiente, sin vale, de una requisición convertida: se cancela y reabre la requisición', () => {
    expect(decidirCancelacionOc(base())).toEqual({ ok: true, reabre_requisicion: true });
  });

  it('OC capturada directo en Kepler (sin requisición): se cancela sola', () => {
    expect(decidirCancelacionOc(base({ oc: { ...OC, origen_tipo: null, origen_folio: null }, requisicion: null })))
      .toEqual({ ok: true, reabre_requisicion: false });
  });

  it.each([
    ['R', /deshacer lo recibido/], ['F', /surtida/], ['C', /cancelada/], ['A', /estado A/],
  ])('OC en %s: se rechaza', (estado, msg) => {
    const d = decidirCancelacionOc(base({ oc: { ...OC, estado } }));
    expect(d.ok).toBe(false);
    if (!d.ok) expect(d.motivo).toMatch(msg);
  });

  it('OC con vale vivo: se rechaza y nombra el vale', () => {
    const d = decidirCancelacionOc(base({ vales_vivos: ['0001234'] }));
    expect(d).toEqual({ ok: false, motivo: expect.stringContaining('0001234') });
  });

  it('no existe, o el folio casa dos series: se rechaza', () => {
    expect(decidirCancelacionOc(base({ oc: null, coincidencias: 0 })).ok).toBe(false);
    expect(decidirCancelacionOc(base({ coincidencias: 2 }))).toEqual({ ok: false, motivo: expect.stringContaining('2 órdenes') });
  });

  it('requisición ausente, no convertida o con otra OC viva: no medido ⇒ se rechaza', () => {
    expect(decidirCancelacionOc(base({ requisicion: null })).ok).toBe(false);
    expect(decidirCancelacionOc(base({ requisicion: { serie: '1', folio: '0000064', estado: 'A', total: 1, renglones: 1 } })).ok).toBe(false);
    expect(decidirCancelacionOc(base({ otras_oc_vivas: ['0000400'] }))).toEqual({ ok: false, motivo: expect.stringContaining('0000400') });
  });
});

describe('[PQ.110] motivoValido', () => {
  it('exige al menos 10 letras y normaliza espacios', () => {
    expect(motivoValido('  ya   no ').ok).toBe(false);
    expect(motivoValido(null).ok).toBe(false);
    expect(motivoValido('  El proveedor   no surtió ')).toEqual({ ok: true, valor: 'El proveedor no surtió' });
  });
});

describe('[PQ.110] sentenciasCancelacion — lo que Kepler escribe al cancelar (anexo §3c)', () => {
  const plan = {
    sucursal: '08', oc: { serie: '1', folio: '0000362', renglones: 4 },
    requisicion: { serie: '1', folio: '0000064', renglones: 4 },
    capturista: 'SUITE', fecha: '2026-11-13', hora: '12:30',
  };

  it('OC: estado C, importes y saldo en 0, quién y cuándo; sólo si sigue pendiente', () => {
    const [h, r] = sentenciasCancelacion(plan);
    expect(h.sql).toMatch(/SET c43 = 'C', c13 = 0, c14 = 0, c15 = 0, c16 = 0, c42 = 0, c67 = \$4, c68 = \$5, c69 = \$6/);
    expect(h.sql).toMatch(/btrim\(c4::text\) = '35'/);
    expect(h.sql).toMatch(/btrim\(c43\) = 'N'/);
    expect(h.params).toEqual(['08', '1', '0000362', 'SUITE', '2026-11-13', '12:30']);
    expect(h.esperadas).toBe(1);
    expect(r.sql).toMatch(/^DELETE FROM md\.kdm2/);
    expect(r.esperadas).toBe(4);
  });

  it('requisición: estado A, saldo = total, renglones pendientes = cantidad; sólo si estaba convertida', () => {
    const s = sentenciasCancelacion(plan);
    expect(s).toHaveLength(4);
    expect(s[2].sql).toMatch(/SET c43 = 'A', c42 = c16 WHERE .*'30'.*btrim\(c43\) = 'F'/s);
    expect(s[3].sql).toMatch(/UPDATE md\.kdm2 SET c24 = c9 WHERE .*'30'/s);
    expect(s[2].params).toEqual(['08', '1', '0000064']);
    // ⛔ La requisición NO cambia de capturista ni de fecha (medido): ninguna sentencia de ella toca c67–c69.
    expect(s[2].sql).not.toMatch(/c6[789]/);
  });

  it('sin requisición: sólo las dos de la OC; y las tablas se pueden cambiar (ensayo)', () => {
    const s = sentenciasCancelacion({ ...plan, requisicion: null }, { kdm1: '_k1', kdm2: '_k2' });
    expect(s.map((x) => x.sql.split(' ').slice(0, 3).join(' '))).toEqual(['UPDATE _k1 SET', 'DELETE FROM _k2']);
  });

  it('permisos: 9 columnas + DELETE, y c24 sólo si reabre la requisición', () => {
    expect(permisosNecesarios(false)).toHaveLength(10);
    expect(permisosNecesarios(true).at(-1)).toMatch(/'md\.kdm2', 'c24', 'UPDATE'/);
  });
});
