/**
 * `[LE.CU.2]` — **El contenido de la bóveda, medido**, en funciones PURAS (ADR-070).
 *
 * ── Lo que corrige ────────────────────────────────────────────────────────────────────────────
 * §28.7 de `VERDAD_ABSOLUTA.md` declaraba la bóveda «no medida: la máquina publica flujo, nunca
 * contenido». Desde el 27-oct la máquina publica su **inventario tras cada evento**
 * (`analytics.caos_cash_counts`), y con él se valida el replay de los flujos: conteo anterior +
 * depósitos − dispensado − vaciado + dotación = conteo siguiente. Medido el 2026-11-04 (§36.4):
 * **109 de 111** pares consecutivos cierran al peso, y los 2 restantes son un mismo evento (`#1820`)
 * contado dos veces (−$2,000 y +$2,000, neto $0).
 *
 * Con el replay validado, la bóveda se puede conocer **antes** del primer inventario: hacia atrás
 * desde él. Así se obtuvo el contenido al arqueo `A23641` (10-oct 12:58:46): **$342,500**, y el
 * mismo camino reproduce los $360,020 que §28.8 midió el 20-oct por otro lado.
 *
 * ⛔ **Lo que NO hace:** decir de dónde vino el efectivo. La bóveda es testigo de que el dinero
 * ESTÁ, no de que ENTRÓ: un depósito sólo existe si alguien decidió hacerlo (§36.1).
 */
import { redondea2 } from './caja-cuadre.engine';

/** Un evento de la bóveda (`analytics.caos_cash_movements`), reducido a lo que el replay necesita. */
export interface MovBoveda {
  /** `external_id`: consecutivo de la máquina. Ordena los eventos. */
  id: number;
  tipo: string;
  total: number;
  /** Instante ISO del evento. */
  at: string;
}

/** Un inventario publicado por la máquina (`analytics.caos_cash_counts`). */
export interface ConteoBoveda {
  /** `after_external_id`: el último evento que ya incluye. */
  tras_id: number;
  total: number;
  /** Instante ISO de la lectura. */
  at: string;
}

/**
 * El efecto de un evento sobre el contenido. `Fin de Dia` es una foto (no mueve dinero) y `Cambio`
 * cambia denominaciones sin cambiar el total: los dos valen 0.
 */
export function signoBoveda(tipo: string): 1 | -1 | 0 {
  switch (tipo) {
    case 'Deposito':
    case 'Dotar':
      return 1;
    case 'Dispensar':
    case 'Vaciar Stocks':
      return -1;
    default:
      return 0;
  }
}

/** La suma con signo de los eventos con `id` en `(desde, hasta]`. */
function flujoEntre(movs: MovBoveda[], desde: number, hasta: number): number {
  let s = 0;
  for (const m of movs) if (m.id > desde && m.id <= hasta) s += signoBoveda(m.tipo) * (Number(m.total) || 0);
  return s;
}

export interface FallaReplay {
  de: number;
  a: number;
  /** conteo anterior + flujo − conteo siguiente. */
  diferencia: number;
  /** Dos lecturas tras el MISMO evento: no es un hueco del flujo, es la máquina contando dos veces. */
  mismo_evento: boolean;
}

/**
 * ¿El replay de los flujos reproduce cada inventario? Sin esta validación, `bovedaEn` hacia atrás
 * no vale nada: es la prueba de que los cuatro tipos de evento y sus signos son los correctos.
 */
export function validaReplay(conteos: ConteoBoveda[], movs: MovBoveda[]): { pares: number; cierran: number; fallas: FallaReplay[] } {
  const cs = [...conteos].sort((a, b) => a.at.localeCompare(b.at) || a.tras_id - b.tras_id);
  const fallas: FallaReplay[] = [];
  let cierran = 0;
  for (let i = 1; i < cs.length; i++) {
    const a = cs[i - 1], b = cs[i];
    const d = redondea2(Number(a.total) + flujoEntre(movs, a.tras_id, b.tras_id) - Number(b.total));
    if (Math.abs(d) < 0.01) cierran++;
    // Una lectura doble tras el mismo evento falla dos veces con signos opuestos: el par donde se
    // repite (`a` = `b`) y el siguiente, que parte de la segunda lectura.
    else fallas.push({ de: a.tras_id, a: b.tras_id, diferencia: d, mismo_evento: a.tras_id === b.tras_id || (i >= 2 && cs[i - 2].tras_id === a.tras_id) });
  }
  return { pares: Math.max(0, cs.length - 1), cierran, fallas };
}

/**
 * El contenido de la bóveda en un instante: el último inventario a esa hora o antes; si el instante
 * es anterior al primer inventario, el replay HACIA ATRÁS desde él. `sin_dato` = no hay ningún
 * inventario, y entonces se declara, nunca se dibuja en cero (ADR-056).
 */
export function bovedaEn(t: string, conteos: ConteoBoveda[], movs: MovBoveda[]): { monto: number | null; fuente: 'conteo' | 'replay' | 'sin_dato' } {
  const cs = [...conteos].sort((a, b) => a.at.localeCompare(b.at) || a.tras_id - b.tras_id);
  if (!cs.length) return { monto: null, fuente: 'sin_dato' };
  const tt = Date.parse(t);
  let previo: ConteoBoveda | null = null;
  for (const c of cs) if (Date.parse(c.at) <= tt) previo = c;
  if (previo) return { monto: redondea2(Number(previo.total)), fuente: 'conteo' };
  const primero = cs[0];
  let s = 0;
  for (const m of movs) if (Date.parse(m.at) > tt && m.id <= primero.tras_id) s += signoBoveda(m.tipo) * (Number(m.total) || 0);
  return { monto: redondea2(Number(primero.total) - s), fuente: 'replay' };
}
