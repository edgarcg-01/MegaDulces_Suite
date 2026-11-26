/**
 * `[PGP.219]` **El interés del crédito, calculado** (anexo CR §3.3, DCR8 y DCR10 de Francisco): saldo insoluto × tasa ×
 * días del periodo ÷ base. Mientras no se verifique una fuente de la tasa contra lo que cobra el banco, la tasa es **la
 * implícita del último cargo** (interés ÷ saldo ÷ días) y el resultado va rotulado «estimado».
 *
 * ── Lo medido (pg-prod, sólo lectura, 2026-11-26; los dos créditos de Banorte, enero–noviembre) ───────────────────
 *  · El periodo va **del día del contrato de un mes al del siguiente**, no de cobro a cobro: el banco cobró el 6 de
 *    abril, el 6 de julio y el 7 de septiembre, y el interés por día sólo es una recta con el día 5 de cada mes.
 *  · El interés por día baja lo MISMO cada mes (tasa × capital), al centavo, de enero a noviembre. De ahí salen el
 *    saldo y la tasa sin el contrato: el saldo, un múltiplo exacto del capital; la tasa, constante en cada crédito
 *    (base 360). Las cifras de cada crédito no van aquí: el repo es público.
 *  · El banco parte el interés en «pago de intereses» (el real, con IVA) e «intereses no reales» (saldo × la inflación
 *    del mes, sin IVA: la MISMA en los dos créditos, 6 de 6 meses); el IVA es el 16 % del real (al centavo en 14 de 20
 *    meses; en enero, agosto y septiembre difiere hasta $20).
 *  · Predecir cada mes (mayo–noviembre) con los anteriores: el interés casa ±$0.02 en 14 de 14; «lo último que cobró el
 *    banco» (lo de `[PGP.211]`) fallaba entre $307 y $2,662, porque el interés baja cada mes. El IVA, con la inflación del
 *    mes anterior (la del mes se publica después), yerra hasta $1,450 un mes; en la suma de 7 meses el cargo de interés +
 *    IVA yerra $3.6 mil y $3.1 mil, contra $8.3 mil y $12.9 mil de «lo último cobrado».
 *
 * ⛔ Si la tasa cambió (o faltan cobros) y no hay tabla del contrato, el saldo no se puede derivar: la función lo DICE
 * (`ok: false` con su motivo) y quien la llama se queda con lo último cobrado. Nunca un número inventado (regla 10).
 * La inflación del mes siguiente no se conoce el día del cálculo (la publica el INEGI): el reparto real / no real y el
 * IVA usan la del último cobro, y por eso también son estimados.
 */

import { fechaEsperadaDelPeriodo } from './contratos-de-cargo.contract';

/** El IVA que el banco cobra sobre el interés real (medido: 16 % del «pago de intereses», al centavo en 14 de 20 meses). */
export const TASA_IVA_DEL_INTERES = 0.16;
/**
 * Dos tramos seguidos de la recta deben dar la misma tasa para fijar el saldo: 0.2 % de diferencia. El redondeo a centavos
 * mueve la tasa ~0.001 %; un cambio de un cuarto de punto en una tasa de 15 % la mueve 1.7 %.
 */
export const TOLERANCIA_TASA_CONSTANTE = 0.002;

/** Lo que el banco cobró de interés en un periodo (YYYY-MM): la suma de sus renglones de ese mes. */
export interface CobroDeInteres {
  periodo: string;
  /** «Pago de intereses»: el interés real (lleva IVA). */
  real: number;
  /** «Intereses no reales»: la parte de inflación (sin IVA). 0 si el crédito no la separa. */
  no_real: number;
  /** El IVA del interés, si el crédito lo cobra aparte. */
  iva: number | null;
}

export interface EntradaInteresDelCredito {
  /** El día del contrato (`day_from`): el periodo va de ese día de un mes al del siguiente. */
  dia: number;
  /** El capital que se paga cada periodo (fijo). */
  capital: number;
  cobros: readonly CobroDeInteres[];
  /** Sólo para mostrar la tasa anual; con la tasa implícita, el resultado no depende de la base. */
  base_dias?: 360 | 365;
}

export type InteresDelPeriodo =
  | {
    ok: true;
    periodo: string;
    /** El día del contrato en ese periodo. */
    fecha: string;
    dias: number;
    /** El saldo insoluto durante el periodo. */
    saldo: number;
    /** La tasa anual implícita del último cobro, en la base indicada. */
    tasa_anual: number;
    base_dias: 360 | 365;
    /** real + no_real. */
    interes: number;
    real: number;
    no_real: number;
    /** `null` si el crédito no cobra el IVA aparte. */
    iva: number | null;
    /** El periodo del último cobro (la tasa) y el tramo de la historia que fijó el saldo. */
    tasa_del_cobro: string;
    saldo_fijado_en: string;
    /** Siempre: la tasa es implícita (DCR10). */
    estimado: true;
  }
  | { ok: false; motivo: string };

const c2 = (n: number) => Math.round(n * 100) / 100;

/** Meses de `a` a `b` (YYYY-MM); negativo si `b` es antes. */
export function mesesEntre(a: string, b: string): number {
  const [ya, ma] = a.split('-').map(Number);
  const [yb, mb] = b.split('-').map(Number);
  return (yb - ya) * 12 + (mb - ma);
}

/** El periodo `n` meses después de `p` (YYYY-MM). */
export function periodoMas(p: string, n: number): string {
  const [y, m] = p.split('-').map(Number);
  const k = y * 12 + (m - 1) + n;
  return `${Math.floor(k / 12)}-${String((k % 12) + 1).padStart(2, '0')}`;
}

/** Los días del periodo que termina en `periodo`: del día del contrato del mes anterior al de este mes. */
export function diasDelPeriodo(periodo: string, dia: number): number {
  const desde = Date.parse(`${fechaEsperadaDelPeriodo(periodoMas(periodo, -1), dia)}T00:00:00Z`);
  const hasta = Date.parse(`${fechaEsperadaDelPeriodo(periodo, dia)}T00:00:00Z`);
  return Math.round((hasta - desde) / 86_400_000);
}

/**
 * El interés del periodo `periodo` (posterior al último cobro), calculado con saldo × tasa implícita × días.
 *
 * 1. El saldo se fija en el tramo MÁS RECIENTE de la historia donde la tasa no cambió: tres cobros cuyo interés por día
 *    baja lo mismo por cada pago de capital (dentro de `TOLERANCIA_TASA_CONSTANTE`). Ahí, saldo = interés por día ÷ tasa
 *    por día. De ese punto en adelante el saldo baja un capital por periodo (es un hecho, no depende de la tasa).
 * 2. La tasa es la implícita del ÚLTIMO cobro: su interés por día ÷ su saldo (DCR10). Si cambió después del tramo que
 *    fijó el saldo, ya la trae.
 * 3. Interés = saldo del periodo × tasa por día × días. Real / no real: con la inflación del último cobro; IVA: 16 %
 *    del real.
 *
 * El capital sólo fija el SALDO que se muestra: el interés previsto es la recta del interés por día (un capital distinto
 * escala saldo y tasa en sentidos contrarios y el producto no cambia). Lo que sí lo mueve es el día del contrato.
 */
export function interesDelPeriodo(e: EntradaInteresDelCredito, periodo: string): InteresDelPeriodo {
  const base = e.base_dias ?? 360;
  if (!(e.capital > 0)) return { ok: false, motivo: 'El crédito no tiene un capital fijo por periodo: sin él no se puede derivar el saldo.' };
  const porPeriodo = new Map<string, CobroDeInteres>();
  for (const c of e.cobros) {
    if (c.periodo >= periodo) continue;
    const ya = porPeriodo.get(c.periodo);
    porPeriodo.set(c.periodo, ya
      ? { periodo: c.periodo, real: ya.real + c.real, no_real: ya.no_real + c.no_real, iva: ya.iva === null && c.iva === null ? null : (ya.iva ?? 0) + (c.iva ?? 0) }
      : { ...c });
  }
  const h = [...porPeriodo.values()].filter((c) => c.real + c.no_real > 0).sort((a, b) => (a.periodo < b.periodo ? -1 : 1));
  if (h.length < 3) return { ok: false, motivo: `Hacen falta 3 cobros de interés anteriores para derivar el saldo; hay ${h.length}.` };
  const porDia = (c: CobroDeInteres) => (c.real + c.no_real) / diasDelPeriodo(c.periodo, e.dia);

  let fijo: { periodo: string; saldo: number } | null = null;
  for (let i = h.length - 1; i >= 2 && !fijo; i--) {
    const [a, b, c] = [h[i - 2], h[i - 1], h[i]];
    const t1 = (porDia(a) - porDia(b)) / (e.capital * mesesEntre(a.periodo, b.periodo));
    const t2 = (porDia(b) - porDia(c)) / (e.capital * mesesEntre(b.periodo, c.periodo));
    if (t1 > 0 && t2 > 0 && Math.abs(t1 - t2) <= TOLERANCIA_TASA_CONSTANTE * t2) fijo = { periodo: c.periodo, saldo: porDia(c) / t2 };
  }
  if (!fijo) {
    return { ok: false, motivo: 'En la historia no hay tres cobros seguidos con la misma tasa: sin la tabla del contrato no se puede derivar el saldo.' };
  }

  const ultimo = h[h.length - 1];
  const saldoUltimo = fijo.saldo - e.capital * mesesEntre(fijo.periodo, ultimo.periodo);
  if (!(saldoUltimo > 0)) return { ok: false, motivo: 'El saldo derivado del último cobro ya es cero: el crédito parece pagado.' };
  const tasaDia = porDia(ultimo) / saldoUltimo;
  const saldo = saldoUltimo - e.capital * mesesEntre(ultimo.periodo, periodo);
  if (!(saldo > 0.005)) return { ok: false, motivo: 'Con los pagos de capital, el crédito ya quedó pagado antes de este periodo.' };
  const dias = diasDelPeriodo(periodo, e.dia);
  const interes = c2(saldo * tasaDia * dias);
  const inflacion = ultimo.no_real / saldoUltimo;
  const noReal = Math.min(interes, Math.max(0, c2(saldo * inflacion)));
  const real = c2(interes - noReal);
  return {
    ok: true, periodo, fecha: fechaEsperadaDelPeriodo(periodo, e.dia), dias, saldo: c2(saldo),
    tasa_anual: Math.round(tasaDia * base * 1e6) / 1e6, base_dias: base,
    interes, real, no_real: noReal, iva: ultimo.iva === null ? null : c2(real * TASA_IVA_DEL_INTERES),
    tasa_del_cobro: ultimo.periodo, saldo_fijado_en: fijo.periodo, estimado: true,
  };
}
