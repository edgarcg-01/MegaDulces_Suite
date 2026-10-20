/**
 * ⭐ `[CGA-A.48]` — **Lo que Control contó y está en la caja fuerte, no en el cajón.**
 *
 * Edgar, 2026-10-20: *«debemos separar lo que existe en el cajón de CAOS y lo que hay en caja
 * general»*. El caso que lo destapó, medido en prod ese día:
 *
 *     libro  CC-2026-00007 (cierre 19-oct)        $88,272.50   1 × $500
 *     Control A23678 (20-oct 09:56, «CORTE 19/10») $288,972.50  401 × $500 · +1 × $1,000 · +1 × $200
 *     CAOS #1646 (19-oct 14:12) Depósito «caja ahorro» $200,000.00 = 400 × $500 exactos
 *
 * Ningún movimiento de CAOS sacó esos 400 billetes de vuelta. Control sumó al cajón la caja de
 * ahorro que está dentro de la caja fuerte, y la pantalla lo publicaba como «uno de los dos
 * conteos está mal». Los dos estaban bien: contaban cajas distintas.
 *
 * ── La regla ─────────────────────────────────────────────────────────────────────────────────
 *
 * Los billetes que Control contó DE MÁS sobre el último conteo del libro (`excesoDeBilletes`) se
 * explican con depósitos a CAOS hechos ANTES de que Control contara: un depósito se atribuye sólo
 * si TODOS sus billetes caben, denominación por denominación, en lo que sobra. Lo que no cabe se
 * publica como «sin explicar», nunca se reparte por parecido.
 *
 * ⚠️ Es una coincidencia por denominación, no una prueba física: la pantalla dice «coincide», no
 * «es». Control del instrumento (2026-10-20): sobre los 5 cortes con Control, la regla con los
 * depósitos del MISMO tramo atribuye 0 donde no hay exceso, y con los depósitos de ±2, ±3, ±5 y
 * ±7 días (placebo, 40 corridas) no atribuyó ninguno.
 *
 * ⛔ Sólo billetes. Las monedas no entran a la bóveda por denominación en este feed, así que un
 * depósito con monedas no se puede explicar entero y no se atribuye.
 */

/** Piezas de billete por denominación (`'1000'`, `'500'`, …). */
export type BilletesPorDenominacion = Record<string, number>;

export interface DepositoCaos {
  id: string;
  /** Jornada de CAOS (`accounting_date`). */
  dia: string;
  /** `HH:MM` en hora de México. */
  hora: string | null;
  total: number;
  ref: string | null;
  billetes: BilletesPorDenominacion;
  /** `true` si el depósito trae monedas: no se puede explicar sólo con billetes. */
  con_monedas: boolean;
}

/** Lo que Control contó de más, billete por billete. Sólo diferencias POSITIVAS. */
export function excesoDeBilletes(control: BilletesPorDenominacion, libro: BilletesPorDenominacion): BilletesPorDenominacion {
  const out: BilletesPorDenominacion = {};
  for (const [d, n] of Object.entries(control)) {
    const x = (Number(n) || 0) - (Number(libro[d]) || 0);
    if (x > 0) out[d] = x;
  }
  return out;
}

/**
 * Qué depósitos a CAOS caben enteros en el exceso. Del más grande al más chico, para que un
 * depósito chico no se coma los billetes de uno grande que sí explica el exceso entero.
 */
export function depositosEnElExceso(
  exceso: BilletesPorDenominacion, depositos: DepositoCaos[],
): { en_caos: DepositoCaos[]; resto: BilletesPorDenominacion } {
  const resto: BilletesPorDenominacion = { ...exceso };
  const en_caos: DepositoCaos[] = [];
  const orden = [...depositos].sort((a, b) => b.total - a.total || a.id.localeCompare(b.id));
  for (const d of orden) {
    const piezas = Object.entries(d.billetes).filter(([, n]) => n > 0);
    if (d.con_monedas || !piezas.length) continue;
    if (!piezas.every(([den, n]) => (resto[den] ?? 0) >= n)) continue;
    for (const [den, n] of piezas) resto[den] -= n;
    en_caos.push(d);
  }
  for (const k of Object.keys(resto)) if (!resto[k]) delete resto[k];
  return { en_caos, resto };
}
