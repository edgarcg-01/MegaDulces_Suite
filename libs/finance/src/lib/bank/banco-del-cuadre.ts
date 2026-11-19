/**
 * `[CB.85]` El lado «Banco» del Cuadre 3 vías y cómo entra ContPAQi cuando el banco no cubre el mes.
 *
 * Por qué (VERDAD_ABSOLUTA §38, medido en prod el 2026-11-18):
 *  - La columna «Banco» leía el libro CUENTAS de Tesorería (un Excel llenado a mano), no el banco. El banco de verdad
 *    es la descarga (`bank_statement_lines`), y se puede usar donde su cuadre por saldos va de punta a punta
 *    (`[CB.73]`, `cuadre-de-la-descarga.ts`).
 *  - ContPAQi no tiene fecha de banco (la de sus depósitos coincide con el día del banco en 3.9 %), pero sí MES (100 %
 *    de 12,643 parejas inequívocas). Mientras el banco no cubre el mes —el mes en curso, o uno cerrado cuyo banco va
 *    atrasado— la única comparación válida es por PAREJA: entra lo que casa con el banco cargado y lo demás se publica
 *    aparte. Cortarlo por fecha, o por fecha más lo posterior que case (la regla de `[CB.82]`), quedó refutado contra
 *    una respuesta conocida (§38.5).
 */

/** Un renglón que se puede parear: dirección e importe. */
export interface Pareable { dir: 'in' | 'out'; importe: number }

const centavos = (v: number) => Math.round(Number(v) * 100);

/**
 * Pareo 1:1 por dirección e importe: exacto primero y, si no, el más cercano dentro de `tolCentavos` (los centavos de
 * captura, `[CB.36]`). Recorre `banco` en el orden dado y toma de `otros` el primero libre en su orden: con las dos
 * listas ordenadas igual, los totales y el detalle parean exactamente lo mismo.
 *
 * Devuelve, por índice de `banco`, el índice de `otros` que le tocó.
 */
export function parearPorImporte(banco: readonly Pareable[], otros: readonly Pareable[], tolCentavos = 100): Map<number, number> {
  // Por dirección: importe (centavos) → cola de índices libres, y los importes con algo libre, ORDENADOS. Buscar el
  // vecino por búsqueda binaria en vez de probar los 2·tol importes uno por uno (medido 2026-11-18: ~100 ms de JS en el
  // cuadre de noviembre, donde la mitad del banco no tiene póliza y agotaba los 200 intentos).
  const cola = { in: new Map<number, number[]>(), out: new Map<number, number[]>() };
  otros.forEach((o, i) => { const m = cola[o.dir]; const c = centavos(o.importe); (m.get(c) || m.set(c, []).get(c)!).push(i); });
  const claves = { in: Array.from(cola.in.keys()).sort((a, b) => a - b), out: Array.from(cola.out.keys()).sort((a, b) => a - b) };
  /** Primer índice de `arr` con valor ≥ t. */
  const piso = (arr: number[], t: number) => { let lo = 0, hi = arr.length; while (lo < hi) { const mid = (lo + hi) >> 1; if (arr[mid] < t) lo = mid + 1; else hi = mid; } return lo; };
  const par = new Map<number, number>();
  banco.forEach((b, bi) => {
    const t = centavos(b.importe);
    const ks = claves[b.dir];
    const j = piso(ks, t);
    // Candidatos: el menor ≥ t y el mayor < t. Gana el más cercano; a igual distancia, el de abajo (t−d antes que t+d).
    const arriba = j < ks.length ? ks[j] : null;
    const abajo = j > 0 ? ks[j - 1] : null;
    let elegido: number | null = null, pos = -1;
    if (arriba !== null && arriba === t) { elegido = arriba; pos = j; }
    else {
      const da = arriba === null ? Infinity : arriba - t, db = abajo === null ? Infinity : t - abajo;
      if (db <= da && db <= tolCentavos) { elegido = abajo; pos = j - 1; }
      else if (da <= tolCentavos) { elegido = arriba; pos = j; }
    }
    if (elegido === null) return;
    const q = cola[b.dir].get(elegido)!;
    par.set(bi, q.shift()!);
    if (!q.length) ks.splice(pos, 1); // el importe se agotó: deja de ser candidato
  });
  return par;
}

/** Un renglón del lado «Banco», venga del libro o de la descarga. */
export interface RenglonDelBanco extends Pareable {
  /** id de `bank_movements` (libro) o de `bank_statement_lines` (descarga). */
  id: string;
  origen: 'libro' | 'descarga';
  fecha: string;
  concepto: string | null;
  /** Sólo los de la descarga: el código de categoría del clasificador (`[CB.61]`/`[CB.65]`). */
  categoria?: string | null;
}

/**
 * El «Banco» de una cuenta cuya descarga cuadra: el libro del mes MENOS lo que la descarga no trae (dentro de lo que
 * cubre un archivo), MÁS lo que sólo trae la descarga. Es la partición de `[CB.64]` (`descargaEnMovimientos`): lo que
 * el libro tiene y el banco confirma conserva su id (y con él su categoría y su conciliación).
 */
export function componerBanco(libro: readonly RenglonDelBanco[], noTrae: ReadonlySet<string>, soloDescarga: readonly RenglonDelBanco[]): RenglonDelBanco[] {
  return [...libro.filter((l) => !noTrae.has(l.id)), ...soloDescarga]
    .sort((a, b) => a.fecha.localeCompare(b.fecha) || a.id.localeCompare(b.id));
}

/**
 * ¿El banco de la cuenta cubre el mes? Sólo un mes ya cerrado cuyo banco llega a menos de `atrasoDias` del último día.
 * El mes en curso nunca: ContPAQi fecha un depósito hasta ~9 días antes que el abono, así que sus pólizas de los
 * últimos días pueden tener el abono todavía por venir.
 */
export function bancoCubreElMes(mesCerrado: boolean, cortadaPorAtraso: boolean): boolean {
  return mesCerrado && !cortadaPorAtraso;
}

/** ContPAQi de una cuenta, partido en lo que entra al cuadre y lo que no tiene pareja en el banco cargado. */
export interface ContpaqiEnCuadre<P> { dentro: P[]; sin_pareja: P[] }

/**
 * Si el banco cubre el mes, entra todo el mes contable de ContPAQi (su mes sí es el del banco). Si no, sólo lo que casa
 * 1:1 con un renglón del banco cargado; lo demás va a `sin_pareja` —no se esconde: es lo que el árbitro-espejo (R5)
 * obliga a publicar, porque si no la diferencia nunca podría salir en contra—.
 */
export function contpaqiEnCuadre<P extends Pareable>(cubre: boolean, polizas: readonly P[], banco: readonly Pareable[], tolCentavos = 100): ContpaqiEnCuadre<P> {
  if (cubre) return { dentro: [...polizas], sin_pareja: [] };
  const par = parearPorImporte(banco, polizas, tolCentavos);
  const tomadas = new Set(par.values());
  return { dentro: polizas.filter((_, i) => tomadas.has(i)), sin_pareja: polizas.filter((_, i) => !tomadas.has(i)) };
}
