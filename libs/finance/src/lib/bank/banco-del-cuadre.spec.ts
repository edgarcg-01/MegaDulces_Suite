import { describe, expect, it } from 'vitest';
import { bancoCubreElMes, componerBanco, contpaqiEnCuadre, parearPorImporte, type RenglonDelBanco } from './banco-del-cuadre';

const r = (id: string, fecha: string, dir: 'in' | 'out', importe: number, origen: 'libro' | 'descarga' = 'libro'): RenglonDelBanco =>
  ({ id, fecha, dir, importe, origen, concepto: null });

describe('[CB.85] parearPorImporte', () => {
  it('exacto antes que cercano, y 1:1', () => {
    const par = parearPorImporte([{ dir: 'in', importe: 100 }, { dir: 'in', importe: 100 }], [{ dir: 'in', importe: 100.5 }, { dir: 'in', importe: 100 }]);
    expect(Array.from(par.entries())).toEqual([[0, 1], [1, 0]]);
  });
  it('respeta la dirección y la tolerancia', () => {
    expect(parearPorImporte([{ dir: 'in', importe: 100 }], [{ dir: 'out', importe: 100 }]).size).toBe(0);
    expect(parearPorImporte([{ dir: 'in', importe: 100 }], [{ dir: 'in', importe: 101.01 }]).size).toBe(0);
    expect(parearPorImporte([{ dir: 'in', importe: 100 }], [{ dir: 'in', importe: 101 }]).size).toBe(1);
  });
});

/** La implementación original (probar los 2·tol importes vecinos uno por uno): la referencia de la rápida. */
function parearIngenuo(banco: { dir: 'in' | 'out'; importe: number }[], otros: { dir: 'in' | 'out'; importe: number }[], tol = 100): Map<number, number> {
  const c = (v: number) => Math.round(v * 100);
  const idx = new Map<string, number[]>();
  otros.forEach((o, i) => { const k = `${o.dir}|${c(o.importe)}`; (idx.get(k) || idx.set(k, []).get(k)!).push(i); });
  const usado = new Set<number>();
  const par = new Map<number, number>();
  banco.forEach((b, bi) => {
    const t = c(b.importe);
    for (let d = 0; d <= tol; d++) {
      for (const x of d === 0 ? [t] : [t - d, t + d]) {
        const arr = idx.get(`${b.dir}|${x}`);
        const hit = arr?.find((i) => !usado.has(i));
        if (hit !== undefined) { usado.add(hit); par.set(bi, hit); return; }
      }
    }
  });
  return par;
}

describe('[CB.85] parearPorImporte es la misma que la original', () => {
  it('3,000 casos aleatorios con importes repetidos y vecinos dentro y fuera de ±$1', () => {
    let semilla = 7;
    const azar = () => { semilla = (semilla * 1103515245 + 12345) % 2147483648; return semilla / 2147483648; };
    for (let caso = 0; caso < 3000; caso++) {
      const base = [100, 100.5, 101, 101.01, 99, 98.99, 250, 250.25, 1000];
      const gen = (n: number) => Array.from({ length: n }, () => ({ dir: (azar() < 0.5 ? 'in' : 'out') as 'in' | 'out',
        importe: Math.round((base[Math.floor(azar() * base.length)] + (azar() < 0.3 ? Math.round(azar() * 300 - 150) / 100 : 0)) * 100) / 100 }));
      const b = gen(1 + Math.floor(azar() * 12)), o = gen(Math.floor(azar() * 12));
      expect(Array.from(parearPorImporte(b, o).entries())).toEqual(Array.from(parearIngenuo(b, o).entries()));
    }
  });
});

describe('[CB.85] componerBanco', () => {
  it('libro menos lo que la descarga no trae, más lo que sólo trae la descarga', () => {
    const libro = [r('l1', '2026-11-02', 'in', 10), r('l2', '2026-11-05', 'out', 20), r('l3', '2026-11-05', 'in', 30)];
    const out = componerBanco(libro, new Set(['l2']), [r('d1', '2026-11-04', 'in', 40, 'descarga')]);
    expect(out.map((x) => x.id)).toEqual(['l1', 'd1', 'l3']);
  });
});

describe('[CB.85] contpaqiEnCuadre', () => {
  const banco = [{ dir: 'in' as const, importe: 500 }, { dir: 'out' as const, importe: 70 }];
  const polizas = [{ dir: 'in' as const, importe: 500, k: 'a' }, { dir: 'in' as const, importe: 900, k: 'b' }, { dir: 'out' as const, importe: 70, k: 'c' }];

  it('banco que no cubre el mes: entra sólo lo que casa, lo demás va aparte (no se esconde)', () => {
    const c = contpaqiEnCuadre(false, polizas, banco);
    expect(c.dentro.map((p) => p.k)).toEqual(['a', 'c']);
    expect(c.sin_pareja.map((p) => p.k)).toEqual(['b']);
  });

  it('control: banco que cubre el mes cerrado → entra el mes contable entero, aunque no case', () => {
    const c = contpaqiEnCuadre(true, polizas, banco);
    expect(c.dentro.map((p) => p.k)).toEqual(['a', 'b', 'c']);
    expect(c.sin_pareja).toEqual([]);
  });

  it('el mes en curso nunca cubre; un mes cerrado sólo si su banco no va atrasado', () => {
    expect(bancoCubreElMes(false, false)).toBe(false);
    expect(bancoCubreElMes(true, true)).toBe(false);
    expect(bancoCubreElMes(true, false)).toBe(true);
  });
});
