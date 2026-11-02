/**
 * `[LE.2.8]` — **La regla del código** (V2, ADR-112): ningún peso sale de la máquina sin una orden.
 *
 * Cada orden vigente (pago de un X-D-26, custodia, reposición, fondo del cajón) lleva un código corto
 * que la cajera teclea al INICIO de la referencia de CAOS. El código es la clasificación del retiro,
 * puesta ANTES del dinero: con él, `movimientoCaos` sabe contra qué asentar sin que nadie lo explique
 * después; sin él, el retiro cae a Suspenso a nombre de quien lo sacó (B4, B19).
 *
 * ── Medido antes de fijar el formato (prod, sólo lectura, 2026-11-02) ────────────────────────
 *  · 148 retiros desde el 1-oct, ninguno con referencia vacía; largo 10–42 (mediana 11). El código
 *    ocupa 6: cabe.
 *  · Empiezan con «gnf», «nom», «nomina», «gastos», nombres de producto o de persona. El formato
 *    estricto `XXXX-D` al inicio aparece **0 veces en toda la historia** de la máquina: no choca.
 *
 * ── Formato ──────────────────────────────────────────────────────────────────────────────────
 *  4 caracteres de un alfabeto sin confusiones (sin I, O, 0, 1) + guion + dígito verificador. El
 *  verificador caza el error de dedo (una letra cambiada, dos letras volteadas); que el código exista
 *  como orden vigente es lo que de verdad autoriza.
 *  Liberal al leer (Postel): minúsculas y espacios alrededor del guion se aceptan. Estricto en lo
 *  demás: un código mal verificado NO se adivina, es Suspenso.
 */

import { pesosACentavos } from '@megadulces/contracts';
import type { ClasificacionCaos } from './reglas';

import { leerCodigo } from './codigo-formato';
export { ALFABETO, armarCodigo, digitoVerificador, leerCodigo, type LecturaDeCodigo } from './codigo-formato';

/** Una orden vigente, como la lee el carril de la máquina. Montos en centavos. */
export interface OrdenConCodigo {
  codigo: string;
  requestId: string;
  /** Lo que la orden autoriza a sacar de la máquina. */
  montoCentavos: bigint;
  /** Lo que ya salió con este código (una orden se puede entregar en varias dispensaciones). */
  usadoCentavos: bigint;
  /** Vigencia: hasta el cierre de la jornada (V2). */
  venceEn: string;
  /** Qué es el dinero que sale: lo que antes tenía que decir una persona después. */
  clasificacion: ClasificacionCaos;
}

export type DecisionDeRetiro =
  | { tipo: 'orden'; orden: OrdenConCodigo; clasificacion: ClasificacionCaos; restanteCentavos: bigint }
  | { tipo: 'suspenso'; motivo: 'sin_codigo' | 'verificador' | 'desconocido' | 'vencido' | 'usado' | 'de_mas'; codigo?: string };

/**
 * Qué es un retiro (Dispensar) de la máquina, según su código. Nunca adivina: todo lo que no es
 * una orden vigente, con saldo suficiente, es Suspenso con su motivo.
 */
export function decidirRetiro(
  mov: { ref: string | null; total: string | number; occurred_at: string | Date },
  ordenes: readonly OrdenConCodigo[],
): DecisionDeRetiro {
  const l = leerCodigo(mov.ref);
  if (!l.ok) return l.motivo === 'verificador' ? { tipo: 'suspenso', motivo: 'verificador', codigo: l.leido } : { tipo: 'suspenso', motivo: 'sin_codigo' };
  const orden = ordenes.find((o) => o.codigo === l.codigo);
  if (!orden) return { tipo: 'suspenso', motivo: 'desconocido', codigo: l.codigo };
  if (new Date(mov.occurred_at).getTime() > new Date(orden.venceEn).getTime()) return { tipo: 'suspenso', motivo: 'vencido', codigo: l.codigo };
  const restante = orden.montoCentavos - orden.usadoCentavos;
  if (restante <= 0n) return { tipo: 'suspenso', motivo: 'usado', codigo: l.codigo };
  const sale = pesosACentavos(String(mov.total).replace(/^-/, ''));
  if (sale > restante) return { tipo: 'suspenso', motivo: 'de_mas', codigo: l.codigo };
  return { tipo: 'orden', orden, clasificacion: orden.clasificacion, restanteCentavos: restante - sale };
}

/** La frase para la pantalla y el aviso a Tesorería: qué pasó, sin jerga. */
export const MOTIVO_SUSPENSO: Readonly<Record<Exclude<DecisionDeRetiro, { tipo: 'orden' }>['motivo'], string>> = {
  sin_codigo: 'Salió de la máquina sin código de orden.',
  verificador: 'El código tecleado en la máquina no es válido (error de dedo): no se adivina cuál era.',
  desconocido: 'El código tecleado no corresponde a ninguna orden.',
  vencido: 'El código era de una orden que ya venció.',
  usado: 'El código ya se había usado completo.',
  de_mas: 'Salió más de lo que la orden autorizaba.',
};
