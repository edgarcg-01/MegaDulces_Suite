/**
 * `[CG.58]` — **El ingreso a la caja fuerte (CAOS) se casa con sus cobros de Kepler. Al 100%.**
 *
 * ── El pedido, y por qué éste SÍ se puede y el egreso no ─────────────────────────────────────
 *
 * Edgar, 2026-10-07: *"un ingreso a CAOS conciliarlo con el movimiento de Kepler. primero se debe
 * tomar el ingreso en Kepler y luego en CAOS, todos estos ingresos a CAOS deben estar vinculados
 * automáticamente a la hora de generar el arqueo"* · *"necesito el 100% de los ingresos, el egreso
 * no se puede cazar como tal pero el ingreso sí"*.
 *
 * Tiene razón, y la diferencia es estructural:
 *
 *   · **El egreso** (una dispensación que paga un gasto) se casa por PARECIDO — monto, día, tokens
 *     del `ref`. `caja-caos-match.engine` lo puntúa y un humano confirma, porque 1 de cada 3
 *     matches por monto es falso por azar. Nunca va a ser 100%.
 *   · **El ingreso** tiene una LEY detrás: el cobro se registra en Kepler **antes** de que el
 *     efectivo entre al equipo. Eso no es una pista, es un orden — y convierte el problema de
 *     «adivinar cuál» en «consumir en orden», que sí cierra al 100%.
 *
 * ── La medición que lo prueba (prod, 2026-10-07) ─────────────────────────────────────────────
 *
 * Saldo corrido de (cobros +) y (depósitos −) en orden cronológico, desde el primer depósito:
 *
 *     eventos 2,548 · depósitos 708 · **depósitos sin respaldo: 0** · peor saldo **+$7,776.41**
 *
 * El saldo **nunca se va a negativo**: en todo momento hubo cobros anteriores suficientes para
 * respaldar el depósito que entraba. Por eso una asignación FIFO cubre el 100% — no por suerte,
 * sino porque la ley del proceso se cumple en los 708 casos.
 *
 * ⛔ **Lo que NO se puede hacer, y se midió antes de intentarlo:** casar 1:1 por importe. Los 708
 * depósitos son múltiplos de 10 (es efectivo contado) y el **57%** de los cobros de Kepler traen
 * centavos. Sólo **25 de 708 (3.5%)** tendrían un cobro anterior de monto exacto. El vínculo es
 * **N:1** — varios cobros forman un depósito — y el último de cada depósito queda **parcial**.
 *
 * ── El otro lado del saldo, que es el hallazgo ───────────────────────────────────────────────
 *
 * El mismo saldo corrido, leído al cierre de cada mes, es **el efectivo cobrado que todavía no
 * entró a la caja fuerte**: $384k (may) → $4.6M (jun) → $12.0M (jul) → $14.9M (ago) → **$19.3M
 * (sep)**. No es una cifra que este motor explique — es la que **publica**, y hoy no la mira nadie.
 */

/** Un cobro de Kepler disponible para respaldar depósitos. Ya ordenado NO: ordena el motor. */
export interface CobroDisponible {
  origen_ref: string;
  /** Fecha del cobro (YYYY-MM-DD). La ley es que ésta sea <= la del depósito. */
  fecha: string;
  monto: number;
  /** Lo ya consumido por depósitos anteriores. 0 si está intacto. */
  consumido?: number;
}

/** Un ingreso de la caja fuerte que hay que respaldar. */
export interface DepositoCaos {
  device: string;
  external_id: number;
  /** Fecha-hora del depósito (ISO). Se compara por DÍA contra la del cobro. */
  occurred_at: string;
  total: number;
}

/** Un tramo de cobro aplicado a un depósito. Varios por depósito: el vínculo es N:1. */
export interface Aplicacion {
  origen_ref: string;
  fecha: string;
  /** Cuánto de ESE cobro entró a ESTE depósito. Puede ser parcial. */
  monto: number;
  /** El último tramo de un depósito casi siempre lo es: los centavos no cuadran con billetes. */
  parcial: boolean;
}

export type VeredictoDeposito =
  /** Los cobros anteriores cubren el depósito entero. Es el caso de los 708 medidos. */
  | { estado: 'cubierto'; aplicaciones: Aplicacion[]; cubierto: number }
  /**
   * No hubo cobros anteriores suficientes. ⛔ NO se fuerza con cobros POSTERIORES: eso rompería
   * la ley del proceso y fabricaría un respaldo que no existe. Se declara y se cubre lo que haya.
   */
  | { estado: 'sin_respaldo'; aplicaciones: Aplicacion[]; cubierto: number; faltante: number };

/** Un centavo: el redondeo de `numeric` no puede dejar un tramo vivo de $0.004. */
export const CAOS_EPSILON = 0.005;

const r2 = (v: number): number => Math.round((Number(v) || 0) * 100) / 100;
const dia = (iso: string): string => String(iso).slice(0, 10);

/**
 * Reparte los cobros disponibles entre los depósitos, **en orden cronológico y sin reusar nada**.
 *
 * ⚠️ **El orden es el algoritmo.** Los depósitos se procesan del más viejo al más nuevo, y cada uno
 * consume los cobros más viejos que le quedan disponibles. Procesarlos en otro orden daría otro
 * reparto con el mismo total — y un reparto que cambia según cómo llegaron las filas no se puede
 * auditar. Es la misma lección que `caja-cuadre.engine` aprendió con el greedy sin `ORDER BY`.
 *
 * ⚠️ **Sólo cobros ANTERIORES o del mismo día.** Es la ley que el pedido declara y que la medición
 * confirmó en los 708 casos. Un cobro posterior no pudo haber entrado a ese depósito.
 *
 * `cobros` se consume: la función devuelve el estado final para que el llamador sepa qué quedó
 * libre (= el efectivo cobrado y no depositado).
 */
export function repartirIngresosCaos(
  depositos: readonly DepositoCaos[],
  cobros: readonly CobroDisponible[],
): {
  resultados: Array<{ deposito: DepositoCaos; veredicto: VeredictoDeposito }>;
  /** Lo que quedó sin aplicar: efectivo cobrado que todavía no entró a la caja fuerte. */
  sinDepositar: Array<{ origen_ref: string; fecha: string; disponible: number }>;
} {
  // Copia mutable y ORDENADA. El `origen_ref` desempata para que dos cobros del mismo día no
  // dependan del orden en que los devolvió la base.
  const pool = cobros
    .map((c) => ({ ...c, disponible: r2(c.monto - (c.consumido ?? 0)) }))
    .filter((c) => c.disponible > CAOS_EPSILON)
    .sort((a, b) => (a.fecha < b.fecha ? -1 : a.fecha > b.fecha ? 1
      : a.origen_ref < b.origen_ref ? -1 : a.origen_ref > b.origen_ref ? 1 : 0));

  const ordenados = [...depositos].sort((a, b) => (
    a.occurred_at < b.occurred_at ? -1 : a.occurred_at > b.occurred_at ? 1
      : a.external_id - b.external_id));

  const resultados = ordenados.map((deposito) => {
    const corte = dia(deposito.occurred_at);
    let falta = r2(deposito.total);
    const aplicaciones: Aplicacion[] = [];

    for (const c of pool) {
      if (falta <= CAOS_EPSILON) break;
      if (c.disponible <= CAOS_EPSILON) continue;
      if (c.fecha > corte) break;            // el pool está ordenado: de acá en más, todos posteriores

      const monto = r2(Math.min(c.disponible, falta));
      c.disponible = r2(c.disponible - monto);
      falta = r2(falta - monto);
      aplicaciones.push({ origen_ref: c.origen_ref, fecha: c.fecha, monto, parcial: c.disponible > CAOS_EPSILON });
    }

    const cubierto = r2(aplicaciones.reduce((a, x) => a + x.monto, 0));
    const veredicto: VeredictoDeposito = falta > CAOS_EPSILON
      ? { estado: 'sin_respaldo', aplicaciones, cubierto, faltante: r2(falta) }
      : { estado: 'cubierto', aplicaciones, cubierto };
    return { deposito, veredicto };
  });

  const sinDepositar = pool
    .filter((c) => c.disponible > CAOS_EPSILON)
    .map((c) => ({ origen_ref: c.origen_ref, fecha: c.fecha, disponible: c.disponible }));

  return { resultados, sinDepositar };
}

/** Lo que el reparto deja dicho, para publicarlo sin recalcularlo. */
export interface ResumenReparto {
  depositos: number;
  cubiertos: number;
  sin_respaldo: number;
  monto_depositado: number;
  monto_respaldado: number;
  monto_faltante: number;
  /** Efectivo cobrado y NO depositado. El número que hoy no mira nadie. */
  monto_sin_depositar: number;
}

export function resumirReparto(
  r: ReturnType<typeof repartirIngresosCaos>,
): ResumenReparto {
  let monto_depositado = 0; let monto_respaldado = 0; let monto_faltante = 0;
  let cubiertos = 0; let sin_respaldo = 0;
  for (const { deposito, veredicto } of r.resultados) {
    monto_depositado = r2(monto_depositado + deposito.total);
    monto_respaldado = r2(monto_respaldado + veredicto.cubierto);
    if (veredicto.estado === 'sin_respaldo') { sin_respaldo++; monto_faltante = r2(monto_faltante + veredicto.faltante); }
    else cubiertos++;
  }
  return {
    depositos: r.resultados.length,
    cubiertos,
    sin_respaldo,
    monto_depositado,
    monto_respaldado,
    monto_faltante,
    monto_sin_depositar: r2(r.sinDepositar.reduce((a, x) => a + x.disponible, 0)),
  };
}
