/**
 * CS.3.3 — Pruebas del motor de propuesta caja⇄CAOS. Puras, sin DB (patrón caja-autofill.engine).
 *
 * El eje: que la señal MEDIDA mande (mismo día > ±días; ref que coincide; monto exacto) y que
 * NUNCA premie lo improbable (un retiro mayor que el gasto no es parte de ese gasto).
 */
import {
  norm, tokensRef, diasEntre, rutaDe, puntuarCaos, rankearCaos,
  type CaosCandidato, type GastoCtx, type PatronAprendido,
} from './caja-caos-match.engine';

const cand = (o: Partial<CaosCandidato> = {}): CaosCandidato => ({
  origen_ref: 'AST700-19758|1420', external_id: 1420, device: 'AST700-19758', type_label: 'Dispensar',
  fecha_valor: '2026-09-24', sucursal: '00', user_external: '003', ref: 'cueritos', monto: 20000,
  denominaciones: [{ denominacion: 500, piezas: 40 }], ...o,
});

describe('norm / tokensRef', () => {
  it('norm quita acentos, mayúsculas y puntuación', () => {
    expect(norm('Nómina, Canindo!')).toBe('nomina canindo');
  });
  it('tokensRef deja tokens >=4 y descarta palabras vacías', () => {
    expect(tokensRef('pagos cueritos')).toEqual(['cueritos']); // "pagos" es stopword
    expect(tokensRef('gnf ma')).toEqual([]);                    // ambos <4
    expect(tokensRef('lic omar')).toEqual(['omar']);            // "lic" <4, "omar" ok
  });
});

describe('diasEntre', () => {
  it('mismo día = 0, consecutivo = 1', () => {
    expect(diasEntre('2026-09-24', '2026-09-24')).toBe(0);
    expect(diasEntre('2026-09-24', '2026-09-25')).toBe(1);
  });
});

describe('puntuarCaos — la señal medida manda', () => {
  it('mismo día + monto exacto + ref que coincide = confianza ALTA', () => {
    const g: GastoCtx = { monto: 20000, fecha: '2026-09-24', beneficiario: 'CUERITOS LUPITA', concepto: 'compra' };
    const r = puntuarCaos(g, cand());
    expect(r.confianza).toBe('alta');           // 50 + 40 + 30 = 120
    expect(r.motivos).toContain('mismo día');
    expect(r.motivos).toContain('monto exacto');
    expect(r.motivos.some((m) => m.includes('cueritos'))).toBe(true);
  });

  it('[parcial] retiro MENOR que el gasto suma como "financia una parte" (el caso 20k de 25k)', () => {
    const g: GastoCtx = { monto: 25000, fecha: '2026-09-24', beneficiario: 'CUERITOS LUPITA' };
    const r = puntuarCaos(g, cand({ monto: 20000 }));
    expect(r.motivos).toContain('financia una parte');
    expect(r.score).toBeGreaterThan(0);
  });

  it('[negativa] un retiro MAYOR que el gasto se penaliza (no es parte de ese gasto)', () => {
    const g: GastoCtx = { monto: 5000, fecha: '2026-09-24', beneficiario: 'otro' };
    const chico = puntuarCaos(g, cand({ monto: 20000, ref: 'zzz' }));
    expect(chico.motivos).toContain('monto mayor que el objetivo');
  });

  it('[negativa] lejos en el tiempo y sin ninguna otra señal no llega a confianza', () => {
    const g: GastoCtx = { monto: null, fecha: '2026-09-24', beneficiario: 'nada que ver' };
    const r = puntuarCaos(g, cand({ fecha_valor: '2026-08-01', ref: 'zzz' }));
    expect(r.confianza).toBe('baja');
  });

  it('lo APRENDIDO sube la confianza del mismo ref', () => {
    const g: GastoCtx = { monto: null, fecha: '2026-09-25', beneficiario: '' };
    const base = puntuarCaos(g, cand({ fecha_valor: '2026-09-24' })); // ±1, sin ref-hit ni monto
    const aprendido = new Map<string, PatronAprendido>([
      ['cueritos', { ref_norm: 'cueritos', casos: 3, cuenta_tipica: '201', concepto_tipico: '001', beneficiario_tipico: 'CUERITOS' }],
    ]);
    const conApr = puntuarCaos(g, cand({ fecha_valor: '2026-09-24' }), aprendido);
    expect(conApr.score).toBeGreaterThan(base.score);
    expect(conApr.motivos.some((m) => m.includes('confirmado antes'))).toBe(true);
  });
});

describe('rutaDe — la ruta como llave (depósitos↔cobros)', () => {
  it('extrae la ruta de las formas de CAOS y de Kepler; null si no hay', () => {
    expect(rutaDe('rd28')).toBe(28);
    expect(rutaDe('ruta 21 09 26')).toBe(21);         // la ruta, no la fecha
    expect(rutaDe('r23')).toBe(23);
    expect(rutaDe('R.D. 28 PH Valadez')).toBe(28);    // norm "r d 28 ph"
    expect(rutaDe('VENTA RD 28 23-09-2026')).toBe(28);
    expect(rutaDe('RUTA 22')).toBe(22);
    expect(rutaDe('cueritos')).toBeNull();
    expect(rutaDe(null)).toBeNull();
  });
});

describe('puntuarCaos — el lado DEPÓSITO (ruta como llave)', () => {
  it('CS.3.5 — depósito ↔ cobro por RUTA + mismo día + monto ≈5% = confianza ALTA', () => {
    const g: GastoCtx = { monto: 14294, fecha: '2026-09-23', beneficiario: 'R.D. 28 PH Valadez', concepto: 'VENTA RD 28 23-09-2026' };
    const dep = cand({ type_label: 'Deposito', ref: 'rd28', monto: 14300, fecha_valor: '2026-09-23', denominaciones: [] });
    const r = puntuarCaos(g, dep);
    expect(r.motivos).toContain('ruta 28');
    expect(r.motivos.some((m) => m.includes('±5%') || m === 'monto exacto')).toBe(true);
    expect(r.confianza).toBe('alta');   // 50 mismo día + 45 ruta + 22 ≈5% = 117
  });

  it('[negativa] rutas DISTINTAS no dan el bono de ruta', () => {
    const g: GastoCtx = { monto: 14294, fecha: '2026-09-23', beneficiario: 'R.D. 21 PH Urbano', concepto: 'VENTA RD 21' };
    const dep = cand({ ref: 'rd28', monto: 99999, fecha_valor: '2026-09-23', denominaciones: [] });
    const r = puntuarCaos(g, dep);
    expect(r.motivos.some((m) => m.startsWith('ruta'))).toBe(false);
  });
});

describe('rankearCaos', () => {
  it('ordena por score y descarta los negativos', () => {
    const g: GastoCtx = { monto: 20000, fecha: '2026-09-24', beneficiario: 'CUERITOS LUPITA' };
    const lista = [
      cand({ external_id: 1, ref: 'cueritos', fecha_valor: '2026-09-24', monto: 20000 }),  // fuerte
      cand({ external_id: 2, ref: 'nomina', fecha_valor: '2026-07-01', monto: 999999 }),    // lejano + mayor => negativo
      cand({ external_id: 3, ref: 'zzz', fecha_valor: '2026-09-25', monto: 5000 }),         // ±1 + parcial
    ];
    const r = rankearCaos(g, lista);
    expect(r[0].external_id).toBe(1);                       // el más fuerte primero
    expect(r.some((c) => c.external_id === 2)).toBe(false); // el negativo se descarta
  });
});
