/**
 * CG.19 Capa 4 — Pruebas del casamiento del Cuadre de `/finanzas/caja` (ADR-070).
 *
 * La prueba que define el éxito es la primera: **el mismo día, cargado dos veces, tiene que
 * publicar el mismo descuadre.** Suena obvio y no lo era: el casamiento anterior dependía del
 * orden en que Postgres devolviera las filas, y ninguno de los tres `SELECT` tenía `ORDER BY`.
 *
 * Por eso hay una **prueba negativa que reconstruye el algoritmo viejo** y demuestra que con los
 * mismos datos, sólo cambiando el orden de entrada, el huérfano cambiaba de $100.03 a $100.00.
 * Sin esa prueba, el arreglo sería una afirmación (ADR-056: un gate sin prueba negativa es una
 * intención).
 */
import {
  casarPorImporte, ordenCanonico, canonBank, escapaLike, redondea2, type MovCuadre,
} from './caja-cuadre.engine';

const m = (key: string, importe: number, fecha = '2026-09-01'): MovCuadre => ({ key, importe, fecha });

/** Baraja determinista (sin `Math.random`): una prueba que falla a veces no sirve de nada. */
function permuta<T>(rows: T[], semilla: number): T[] {
  const out = [...rows];
  let s = semilla;
  for (let i = out.length - 1; i > 0; i--) {
    s = (s * 1103515245 + 12345) % 2147483648;
    const j = s % (i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

describe('casarPorImporte — determinismo', () => {
  const caja = [m('c1', 100.0), m('c2', 100.03), m('c3', 5000), m('c4', 5000), m('c5', 12.5)];
  const otro = [m('o1', 100.0), m('o2', 5000), m('o3', 5000, '2026-09-02'), m('o4', 12.5)];

  it('⭐ el mismo conjunto en CUALQUIER orden da EXACTAMENTE el mismo resultado', () => {
    const base = casarPorImporte(caja, otro, 5);
    for (let s = 1; s <= 25; s++) {
      const r = casarPorImporte(permuta(caja, s), permuta(otro, s * 7), 5);
      expect(r.casados_n).toBe(base.casados_n);
      expect(r.caja_solos_monto).toBe(base.caja_solos_monto);
      expect(r.otro_solos_monto).toBe(base.otro_solos_monto);
      // No alcanza con que cuadren los totales: los PARES tienen que ser los mismos, porque el
      // usuario hace clic en el renglón y espera ver siempre el mismo movimiento del otro lado.
      expect(r.pares.map((p) => `${p.caja.key}->${p.otro.key}`).sort())
        .toEqual(base.pares.map((p) => `${p.caja.key}->${p.otro.key}`).sort());
      expect(r.caja_solos.map((x) => x.key).sort()).toEqual(base.caja_solos.map((x) => x.key).sort());
    }
  });

  it('[negativa] el greedy VIEJO (sin orden) cambiaba el huérfano con los mismos datos', () => {
    // Reconstrucción del algoritmo anterior: recorre `caja` tal como llega y consume del balde.
    const viejo = (cj: MovCuadre[], ot: MovCuadre[], tolPesos: number) => {
      const cents = (v: number) => Math.round(v * 100);
      const tol = tolPesos * 100;
      const byAmt = new Map<number, MovCuadre[]>();
      for (const o of ot) { const k = cents(o.importe); (byAmt.get(k) ?? byAmt.set(k, []).get(k)!).push(o); }
      const solos: MovCuadre[] = [];
      for (const c of cj) {
        const t = cents(c.importe); let hit: MovCuadre | null = null;
        for (let d = 0; d <= tol && !hit; d++) {
          for (const cand of d === 0 ? [t] : [t - d, t + d]) {
            const b = byAmt.get(cand);
            if (b && b.length) { hit = b.shift()!; break; }
          }
        }
        if (!hit) solos.push(c);
      }
      return solos;
    };

    const A = m('A', 100.0), B = m('B', 100.03), X = m('X', 100.0);
    const huerfanoAB = viejo([A, B], [X], 5).map((x) => x.importe);
    const huerfanoBA = viejo([B, A], [X], 5).map((x) => x.importe);

    // El defecto, escrito: mismos datos, distinto orden, distinto monto reportado como faltante.
    expect(huerfanoAB).toEqual([100.03]);
    expect(huerfanoBA).toEqual([100.0]);
    expect(huerfanoAB).not.toEqual(huerfanoBA);

    // Y el motor nuevo contesta lo mismo en los dos órdenes.
    const n1 = casarPorImporte([A, B], [X], 5).caja_solos.map((x) => x.importe);
    const n2 = casarPorImporte([B, A], [X], 5).caja_solos.map((x) => x.importe);
    expect(n1).toEqual(n2);
  });

  it('ordenCanonico es un orden TOTAL: nada queda librado al orden de llegada', () => {
    const rows = [m('b', 10, '2026-01-02'), m('a', 10, '2026-01-02'), m('c', 99)];
    expect(ordenCanonico(permuta(rows, 3)).map((r) => r.key)).toEqual(['c', 'a', 'b']);
    expect(ordenCanonico(permuta(rows, 11)).map((r) => r.key)).toEqual(['c', 'a', 'b']);
  });
});

describe('casarPorImporte — lo que el casamiento NO sabe, lo declara', () => {
  it('⭐ un par que pudo haber casado con otro sale marcado `ambiguo`', () => {
    const r = casarPorImporte([m('c1', 500)], [m('o1', 500), m('o2', 500, '2026-09-05')], 5);
    expect(r.pares).toHaveLength(1);
    expect(r.pares[0].candidatos).toBe(2);
    expect(r.pares[0].ambiguo).toBe(true);
    expect(r.ambiguos_n).toBe(1);
  });

  it('un casamiento forzado (único candidato) NO es ambiguo', () => {
    const r = casarPorImporte([m('c1', 500)], [m('o1', 500)], 5);
    expect(r.pares[0].candidatos).toBe(1);
    expect(r.pares[0].ambiguo).toBe(false);
  });

  it('⭐ el par declara su `delta`: casar al peso y casar por tolerancia NO se ven igual', () => {
    const exacto = casarPorImporte([m('c1', 100)], [m('o1', 100)], 5);
    expect(exacto.pares[0].delta).toBe(0);
    expect(exacto.inexactos_n).toBe(0);

    const porTol = casarPorImporte([m('c1', 100)], [m('o1', 95.01)], 5);
    expect(porTol.pares[0].delta).toBe(4.99);
    expect(porTol.inexactos_n).toBe(1);
  });

  it('la tolerancia viaja CON el resultado (ampliarla siempre baja el descuadre)', () => {
    const conUno = casarPorImporte([m('c1', 100)], [m('o1', 96)], 1);
    const conCinco = casarPorImporte([m('c1', 100)], [m('o1', 96)], 5);
    expect(conUno.tolerancia).toBe(1);
    expect(conUno.caja_solos_monto).toBe(100); // fuera de tolerancia → huérfano
    expect(conCinco.tolerancia).toBe(5);
    expect(conCinco.caja_solos_monto).toBe(0); // la MISMA realidad, otro número publicado
  });

  it('gana el importe MÁS CERCANO, no el primero que aparece', () => {
    const r = casarPorImporte([m('c1', 100)], [m('o_lejos', 96), m('o_cerca', 99.5)], 5);
    expect(r.pares[0].otro.key).toBe('o_cerca');
  });

  it('a igual distancia de importe desempata la fecha más cercana', () => {
    const r = casarPorImporte(
      [m('c1', 100, '2026-09-10')],
      [m('o_lejos', 102, '2026-09-01'), m('o_cerca', 102, '2026-09-09')],
      5,
    );
    expect(r.pares[0].otro.key).toBe('o_cerca');
    expect(r.pares[0].ambiguo).toBe(true); // hubo dos: se casó uno y se DICE que pudo ser el otro
  });

  it('un candidato no se usa dos veces, y lo que sobra de cada lado queda huérfano', () => {
    const r = casarPorImporte([m('c1', 50), m('c2', 50)], [m('o1', 50)], 5);
    expect(r.casados_n).toBe(1);
    expect(r.caja_solos.map((x) => x.key)).toEqual(['c2']);
    expect(r.otro_solos).toHaveLength(0);
  });

  it('con tolerancia 0 sólo casa lo idéntico al centavo', () => {
    const r = casarPorImporte([m('c1', 100.01)], [m('o1', 100.0)], 0);
    expect(r.casados_n).toBe(0);
    expect(r.caja_solos_monto).toBe(100.01);
    expect(r.otro_solos_monto).toBe(100);
  });

  it('los totales de cada lado no dependen del casamiento', () => {
    const r = casarPorImporte([m('c1', 10), m('c2', 20)], [m('o1', 999)], 5);
    expect(r.caja_total).toBe(30);
    expect(r.otro_total).toBe(999);
    expect(r.delta).toBe(redondea2(30 - 999));
  });

  it('lados vacíos no rompen nada (un día sin movimientos no es un error)', () => {
    const r = casarPorImporte([], [], 5);
    expect(r.casados_n).toBe(0);
    expect(r.delta).toBe(0);
  });
});

describe('canonBank — una sola definición', () => {
  it('⭐ SCOTIABANK y BANREGIO se agrupan: eran los dos que la copia de clase NO conocía', () => {
    expect(canonBank('SCOTIABANK INVERLAT')).toBe('SCOTIABANK');
    expect(canonBank('Scotia Bank')).toBe('SCOTIABANK');
    expect(canonBank('BANREGIO 1234')).toBe('BANREGIO');
    expect(canonBank('Banco Regional')).toBe('BANREGIO');
  });

  it('el mismo banco escrito de varias formas cae en la misma clave', () => {
    expect(canonBank('BBVA BANCOMER')).toBe('BBVA');
    expect(canonBank('bancomer')).toBe('BBVA');
    expect(canonBank('BanBajío')).toBe('BAJIO');
    expect(canonBank('BANAMEX')).toBe(canonBank('CITIBANAMEX'));
  });

  it('lo que no está en la lista se agrupa por su primera palabra — heurística, no catálogo', () => {
    expect(canonBank('MIFEL S.A.')).toBe('MIFEL');
    expect(canonBank('')).toBe('OTRO');
    expect(canonBank(null as never)).toBe('OTRO');
  });
});

describe('escapaLike', () => {
  it('⭐ buscar "%" deja de traer el universo entero', () => {
    expect(escapaLike('100%')).toBe('100\\%');
    expect(escapaLike('a_b')).toBe('a\\_b');
    expect(escapaLike('C:\\ruta')).toBe('C:\\\\ruta');
  });

  it('el texto normal no se toca', () => {
    expect(escapaLike('DEPOSITO BBVA')).toBe('DEPOSITO BBVA');
  });
});
