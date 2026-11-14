/**
 * `[CB.69]` Los traspasos internos (TI/TE) que se quedaron con una sola pata, emparejados **1 a 1**.
 *
 * ⛔ El caso que lo trajo (medido en prod el 2026-11-13, periodo 2026-11): los traspasos no neteaban por
 * **$150,000** y el Cierre nombraba un solo huérfano, de **$55,000**. Faltaban $95,000 sin renglón. La consulta
 * vieja buscaba «¿existe en otra cuenta una salida del mismo importe a ±3 días?», sin gastar la pareja: el TE
 * `06/11 BB 854 −95,000` (pareja del TI `06/11 STDR 2169 +95,000 «DE BB 854»`) servía también de espejo del TI
 * `03/11 BB 4166 +95,000 «ENTRE CTAS 366»`, que en realidad venía de BB 3660, la cuenta que no entró al libro.
 * Además buscaba el espejo entre CUALQUIER movimiento, y la diferencia se mide sólo entre TI y TE: dos universos.
 *
 * Aquí, el mismo universo que la diferencia (los TI/TE del periodo) y cada movimiento se usa una sola vez:
 *   1. primero las parejas cuyo concepto nombra a la otra cuenta («TRASPASO A BB 4166» ↔ cuenta 4166);
 *   2. después, por importe y la fecha más cercana (±3 días), entre lo que quedó.
 * Lo que no encuentra pareja es lo que explica la diferencia: por construcción, entradas sueltas − salidas
 * sueltas = Σ TI − Σ TE (las parejas se cancelan), salvo centavos de redondeo.
 */
export interface MovimientoDeTraspaso {
  id: string;
  /** 'YYYY-MM-DD' */
  fecha: string;
  /** El número de la cuenta («4166»): es lo que nombran los conceptos del banco. */
  cuenta: string;
  /** Con lo que se muestra («BB 4166»). */
  alias: string;
  entra: number;
  sale: number;
  concepto: string | null;
}

export interface TraspasosSinPareja {
  sueltos: MovimientoDeTraspaso[];
  /** Σ entradas sueltas − Σ salidas sueltas. Debe ser igual a la diferencia TI − TE. */
  explicado: number;
  parejas: number;
}

const DIAS = 3;
const cent = (v: number) => Math.round(v * 100);
const dia = (f: string) => Date.UTC(+f.slice(0, 4), +f.slice(5, 7) - 1, +f.slice(8, 10)) / 86_400_000;

/** ¿El concepto de uno nombra la cuenta del otro? «TRASPASO ENTRE CTAS 2169» nombra a la 2169. */
function seNombran(a: MovimientoDeTraspaso, b: MovimientoDeTraspaso): boolean {
  const nombra = (concepto: string | null, cuenta: string) =>
    !!cuenta && new RegExp(`(^|\\D)${cuenta.replace(/\D/g, '')}(\\D|$)`).test(concepto ?? '');
  return nombra(a.concepto, b.cuenta) || nombra(b.concepto, a.cuenta);
}

export function traspasosSinPareja(movs: readonly MovimientoDeTraspaso[]): TraspasosSinPareja {
  const entradas = movs.filter((m) => m.entra > 0);
  const salidas = movs.filter((m) => m.sale > 0);
  const usadas = new Set<string>();
  const pareadas = new Set<string>();
  let parejas = 0;

  for (const exigeNombre of [true, false]) {
    for (const e of entradas) {
      if (pareadas.has(e.id)) continue;
      let mejor: MovimientoDeTraspaso | null = null;
      let mejorDist = Infinity;
      for (const s of salidas) {
        if (usadas.has(s.id) || s.cuenta === e.cuenta || cent(s.sale) !== cent(e.entra)) continue;
        const dist = Math.abs(dia(s.fecha) - dia(e.fecha));
        if (dist > DIAS || (exigeNombre && !seNombran(e, s))) continue;
        if (dist < mejorDist || (dist === mejorDist && mejor && s.id < mejor.id)) { mejor = s; mejorDist = dist; }
      }
      if (mejor) { usadas.add(mejor.id); pareadas.add(e.id); parejas++; }
    }
  }

  const sueltos = movs.filter((m) => (m.entra > 0 ? !pareadas.has(m.id) : m.sale > 0 && !usadas.has(m.id)))
    .sort((a, b) => (b.entra + b.sale) - (a.entra + a.sale) || a.fecha.localeCompare(b.fecha));
  const explicado = sueltos.reduce((t, m) => t + cent(m.entra) - cent(m.sale), 0) / 100;
  return { sueltos, explicado, parejas };
}
