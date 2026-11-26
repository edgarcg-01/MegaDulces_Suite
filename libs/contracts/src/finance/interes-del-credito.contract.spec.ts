import {
  TASA_IVA_DEL_INTERES, diasDelPeriodo, interesDelPeriodo, mesesEntre, periodoMas, type CobroDeInteres,
} from './interes-del-credito.contract';

// Un crédito sintético (el repo es público: nada de montos ni números de crédito reales). Día 5, capital fijo de
// $100,000, tasa 15 % base 360, inflación del mes 0.4 %: lo que cobraría el banco, con sus centavos.
const DIA = 5;
const C = 100_000;
const r2 = (n: number) => Math.round(n * 100) / 100;
function cobros(desde: string, n: number, saldo: number, tasa: (p: string) => number = () => 0.15, inflacion = 0.004): CobroDeInteres[] {
  const out: CobroDeInteres[] = [];
  for (let k = 0; k < n; k++, saldo -= C) {
    const p = periodoMas(desde, k);
    const i = r2(saldo * tasa(p) / 360 * diasDelPeriodo(p, DIA));
    const noReal = r2(saldo * inflacion);
    const real = r2(i - noReal);
    out.push({ periodo: p, real, no_real: noReal, iva: r2(real * TASA_IVA_DEL_INTERES) });
  }
  return out;
}
const esperado = (saldo: number, tasa: number, p: string) => r2(saldo * tasa / 360 * diasDelPeriodo(p, DIA));

describe('[PGP.219] el interés del crédito: saldo × tasa implícita × días', () => {
  it('los días van del día del contrato de un mes al del siguiente (no de cobro a cobro)', () => {
    expect(diasDelPeriodo('2026-10', 5)).toBe(30); // 5-sep → 5-oct
    expect(diasDelPeriodo('2026-03', 5)).toBe(28); // 5-feb → 5-mar
    expect(diasDelPeriodo('2026-03', 31)).toBe(31); // 28-feb → 31-mar (el 31 de febrero es el 28)
    expect(diasDelPeriodo('2026-01', 5)).toBe(31); // 5-dic → 5-ene, cruza el año
    expect(mesesEntre('2025-11', '2026-02')).toBe(3);
    expect(periodoMas('2026-11', 2)).toBe('2027-01');
  });

  it('con la historia de un crédito de tasa fija, el interés del mes siguiente sale al centavo', () => {
    const h = cobros('2026-06', 5, 1_500_000); // jun–oct; el saldo de noviembre es 1,000,000
    const r = interesDelPeriodo({ dia: DIA, capital: C, cobros: h }, '2026-11');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.saldo).toBeCloseTo(1_000_000, 0);
    expect(Math.abs(r.interes - esperado(1_000_000, 0.15, '2026-11'))).toBeLessThanOrEqual(0.02);
    expect(r.tasa_anual).toBeCloseTo(0.15, 5);
    expect(r).toMatchObject({ dias: 31, fecha: '2026-11-05', estimado: true, tasa_del_cobro: '2026-10' });
    // El reparto con la inflación del último cobro, y el IVA del real.
    expect(r.no_real).toBe(r2(1_000_000 * 0.004));
    expect(r.real).toBe(r2(r.interes - r.no_real));
    expect(r.iva).toBe(r2(r.real * 0.16));
  });

  it('dos meses adelante: el saldo baja un capital por periodo', () => {
    const r = interesDelPeriodo({ dia: DIA, capital: C, cobros: cobros('2026-06', 5, 1_500_000) }, '2026-12');
    expect(r.ok && r.saldo).toBeCloseTo(900_000, 0);
    expect(r.ok && Math.abs(r.interes - esperado(900_000, 0.15, '2026-12'))).toBeLessThanOrEqual(0.02);
  });

  it('si la tasa cambió DESPUÉS del tramo que fijó el saldo, la toma del último cobro (DCR10)', () => {
    const h = cobros('2026-04', 7, 1_700_000, (p) => (p >= '2026-10' ? 0.14 : 0.15)); // abr–oct; baja en octubre
    const r = interesDelPeriodo({ dia: DIA, capital: C, cobros: h }, '2026-11');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.tasa_anual).toBeCloseTo(0.14, 4);
    expect(Math.abs(r.interes - esperado(1_000_000, 0.14, '2026-11'))).toBeLessThanOrEqual(0.05);
    expect(r.saldo_fijado_en < '2026-10').toBe(true);
  });

  it('NEGATIVA: si la tasa cambia cada mes no hay tramo que fije el saldo → lo dice, no inventa', () => {
    const tasas: Record<string, number> = { '2026-07': 0.15, '2026-08': 0.14, '2026-09': 0.16, '2026-10': 0.13 };
    const r = interesDelPeriodo({ dia: DIA, capital: C, cobros: cobros('2026-07', 4, 1_400_000, (p) => tasas[p]) }, '2026-11');
    expect(r).toMatchObject({ ok: false });
    expect(!r.ok && r.motivo).toMatch(/misma tasa/);
  });

  it('NEGATIVA: con menos de 3 cobros no hay cálculo', () => {
    expect(interesDelPeriodo({ dia: DIA, capital: C, cobros: cobros('2026-09', 2, 1_200_000) }, '2026-11')).toMatchObject({ ok: false });
    expect(interesDelPeriodo({ dia: DIA, capital: 0, cobros: cobros('2026-06', 5, 1_500_000) }, '2026-11')).toMatchObject({ ok: false });
  });

  it('el capital sólo fija el SALDO que se muestra: el interés previsto no cambia con él (saldo y tasa se compensan)', () => {
    const h = cobros('2026-06', 5, 1_500_000);
    const bien = interesDelPeriodo({ dia: DIA, capital: C, cobros: h }, '2026-11');
    const mal = interesDelPeriodo({ dia: DIA, capital: C * 1.1, cobros: h }, '2026-11');
    expect(bien.ok && mal.ok && Math.abs(mal.interes - bien.interes)).toBeLessThanOrEqual(0.02);
    expect(mal.ok && mal.saldo).toBeCloseTo(1_100_000, 0);
  });

  it('NEGATIVA: el último cobro manda — si el banco cobró de más, el siguiente lo refleja (no se queda con la recta vieja)', () => {
    const h = cobros('2026-06', 5, 1_500_000);
    const oct = h[h.length - 1];
    const subido = [...h.slice(0, -1), { ...oct, real: r2(oct.real + 1_000) }];
    const a = interesDelPeriodo({ dia: DIA, capital: C, cobros: h }, '2026-11');
    const b = interesDelPeriodo({ dia: DIA, capital: C, cobros: subido }, '2026-11');
    expect(a.ok && b.ok && b.interes - a.interes).toBeGreaterThan(900);
  });

  it('un mes sin cobro en la historia (un estado que no se subió) no rompe el saldo', () => {
    const h = cobros('2026-01', 10, 2_000_000).filter((c) => c.periodo !== '2026-02' && c.periodo !== '2026-08');
    const r = interesDelPeriodo({ dia: DIA, capital: C, cobros: h }, '2026-11');
    expect(r.ok && r.saldo).toBeCloseTo(1_000_000, 0);
  });

  it('dos cobros del mismo periodo (el banco lo partió) se suman; lo de este periodo o después no cuenta', () => {
    const h = cobros('2026-06', 5, 1_500_000);
    const ago = h.find((c) => c.periodo === '2026-08')!;
    const partido = [...h.filter((c) => c !== ago), { ...ago, real: r2(ago.real - 1000), iva: null }, { periodo: '2026-08', real: 1000, no_real: 0, iva: ago.iva }];
    const conFuturo = [...partido, { periodo: '2026-11', real: 1, no_real: 0, iva: 0 }];
    const a = interesDelPeriodo({ dia: DIA, capital: C, cobros: h }, '2026-11');
    const b = interesDelPeriodo({ dia: DIA, capital: C, cobros: conFuturo }, '2026-11');
    expect(a.ok && b.ok && b.interes).toBe(a.ok && a.interes);
  });

  it('el crédito que ya se pagó no lleva interés: lo dice', () => {
    const r = interesDelPeriodo({ dia: DIA, capital: C, cobros: cobros('2026-06', 5, 600_000) }, '2026-12'); // saldo nov 100k, dic 0
    expect(r).toMatchObject({ ok: false });
  });

  it('sin IVA aparte, el IVA es null', () => {
    const h = cobros('2026-06', 5, 1_500_000).map((c) => ({ ...c, iva: null }));
    const r = interesDelPeriodo({ dia: DIA, capital: C, cobros: h }, '2026-11');
    expect(r.ok && r.iva).toBeNull();
  });
});
