/**
 * `[BFU.7.5]` **El pase 1 de la conciliación de tesorería: el candidato de la misma semana.**
 *
 * Regla de siempre: monto exacto dentro de ±7 días, el más cercano; si NO hay ningún documento con el monto exacto,
 * uno de ±$1 dentro de ±7 días.
 *
 * ⛔ El hueco: si existía un exacto, pero a más de 7 días, el pase no miraba a nadie más — ni al documento del mismo
 * día que difiere por redondeo — y el movimiento caía al pase entre meses, donde gana el exacto aunque esté a 37 días.
 * Caso medido en prod (2026-11-23, CG, 1-oct): «rem piñatas» $2,400.00 casaba con PIÑATAS $2,400.01 del mismo día;
 * al liberarse un exacto de otro mes («COMISIONES RUTAS DE VENTAS», 7-nov) se fue con él.
 *
 * Arreglo, angosto a propósito: cuando hay exacto pero lejos, sólo se acepta una diferencia de REDONDEO (≤ 5 centavos)
 * del mismo día o el siguiente. Diez centavos ya pueden ser otro documento (cheques de nómina de dos empleados).
 */

export const TOPE_DIAS_SEMANA = 7;
export const REDONDEO_CENTAVOS = 5;
export const REDONDEO_DIAS = 1;

export interface CandidatoSemana { importe: number }

export interface Elegido<T> { elegido: T; exacto: boolean; dias: number }

const centavos = (v: number) => Math.round(Number(v || 0) * 100);

function masCercano<T>(lista: readonly T[], distancia: (p: T) => number, tope: number): { p: T; d: number } | null {
  let p: T | null = null, d = tope + 1;
  for (const c of lista) { const x = distancia(c); if (x < d) { p = c; d = x; } }
  return p === null ? null : { p, d };
}

/**
 * @param exactos    candidatos libres con el monto EXACTO del movimiento
 * @param tolerancia candidatos libres a ±$1 (sin los exactos)
 * @param distancia  días entre el movimiento y el documento
 * @param importe    el monto del movimiento
 */
export function elegirEnLaSemana<T extends CandidatoSemana>(
  exactos: readonly T[], tolerancia: readonly T[], distancia: (p: T) => number, importe: number,
): Elegido<T> | null {
  const e = masCercano(exactos, distancia, TOPE_DIAS_SEMANA);
  if (e) return { elegido: e.p, exacto: true, dias: e.d };
  if (!exactos.length) {
    const t = masCercano(tolerancia, distancia, TOPE_DIAS_SEMANA);
    return t ? { elegido: t.p, exacto: false, dias: t.d } : null;
  }
  // Hay exacto, pero lejos: sólo el redondeo del mismo día o el siguiente.
  const tc = centavos(importe);
  const redondeo = tolerancia.filter((p) => Math.abs(centavos(p.importe) - tc) <= REDONDEO_CENTAVOS);
  const r = masCercano(redondeo, distancia, REDONDEO_DIAS);
  return r ? { elegido: r.p, exacto: false, dias: r.d } : null;
}
