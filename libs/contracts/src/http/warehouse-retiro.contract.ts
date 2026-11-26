/**
 * `[UB.PL.9]` **Quitar ubicaciones: retirar o borrar.** Son dos actos distintos y confundirlos es
 * lo que destruye datos.
 *
 * - **Retirar** es para el mueble que EXISTIÓ: se fue de la tienda, se dañó, se reacomodó el piso.
 *   Queda con `estado = 'baja'` y su motivo, y **nunca se borra** — es la regla de la fase UB §7:
 *   lo que tuvo mercancía o productos asignados tiene historia, y la historia no se tira.
 * - **Borrar** es para la captura EQUIVOCADA: se generó un rango de más, una letra que no existe,
 *   un pasillo de 25 racks donde hay 17. Sólo se puede **si nunca se usó**.
 *
 * ⛔ La regla dura: **lo que tiene uso no se borra, se retira.** Y se dice por qué, con el número,
 * en vez de fallar con un error de llave foránea que nadie entiende. Medido el 2026-11-26: tres
 * tablas apuntan a `warehouse_bins` (`stock_lot_locations` y `bin_assignments` con RESTRICT,
 * `cart_occupations`), así que un `DELETE` sobre algo usado revienta en la base de todos modos; esto
 * lo convierte en una frase.
 */

import type { LocationZone } from './warehouse-locations.contract';

/** Qué se quiere quitar. De lo más chico a lo más grande. */
export type AlcanceRetiro =
  | { que: 'nivel'; code: string }
  | { que: 'rack'; zona: LocationZone; pasillo: string; rack: number }
  | { que: 'pasillo'; zona: LocationZone; pasillo: string }
  | { que: 'pieza'; fixture_id: string };

export type AccionRetiro = 'retirar' | 'borrar';

/** El uso de una ubicación: lo que decide si se puede borrar o sólo retirar. */
export interface UsoUbicacion {
  id: string;
  code: string;
  estado: string;
  /** Productos con lugar asignado vivo. */
  productos: number;
  /** Renglones de stock, **con o sin cantidad**: que exista uno dice que el acomodo pasó por acá. */
  renglones: number;
  /** Ocupaciones de carreta que la nombran. */
  ocupaciones: number;
}

export interface VeredictoUbicacion {
  code: string;
  /** `true` sólo si no la usó nadie nunca. */
  borrable: boolean;
  /** Por qué no se puede borrar, en palabras de quien la usa. `null` si sí se puede. */
  motivo: string | null;
}

/**
 * Si una ubicación se puede **borrar**. Basta una señal de uso para que no: un producto asignado, un
 * renglón de stock —aunque esté en cero: significa que el acomodo pasó por ahí— o una carreta.
 */
export function veredictoDeBorrado(u: UsoUbicacion): VeredictoUbicacion {
  const razones: string[] = [];
  if (u.productos > 0) razones.push(`${u.productos} producto${u.productos === 1 ? '' : 's'} con lugar aquí`);
  // «renglón» pierde la tilde en plural: `renglón + es` daba «renglónes» y se leía en pantalla.
  if (u.renglones > 0) razones.push(`${u.renglones} ${u.renglones === 1 ? 'renglón' : 'renglones'} de mercancía`);
  if (u.ocupaciones > 0) razones.push(`${u.ocupaciones} carreta${u.ocupaciones === 1 ? '' : 's'}`);
  return {
    code: u.code,
    borrable: razones.length === 0,
    motivo: razones.length === 0 ? null : `${u.code} tiene ${unirY(razones)}: se retira, no se borra.`,
  };
}

export interface PlanDeRetiro {
  /** Lo que se va a quitar, con el veredicto de cada una. */
  ubicaciones: VeredictoUbicacion[];
  /** Cuántas se borrarían de verdad (sólo en `accion: 'borrar'`). */
  se_borran: number;
  /** Cuántas quedarían en baja. */
  se_retiran: number;
  /** Las que impiden borrar, con su motivo. Vacío no quiere decir que no haya nada: ver `total`. */
  bloqueadas: VeredictoUbicacion[];
  total: number;
}

/**
 * El plan antes de tocar nada: qué entra, qué se puede y qué no. Es lo que la pantalla enseña antes
 * de preguntar «¿seguro?», para que nadie confirme un número que no vio.
 *
 * ⭐ En `borrar`, una sola ubicación con uso **no cancela el resto**: se borra lo que se puede y se
 * dice lo que no, con su motivo. Un lote parcial se reporta como parcial, nunca como falla total.
 */
export function planDeRetiro(usos: readonly UsoUbicacion[], accion: AccionRetiro): PlanDeRetiro {
  const ubicaciones = usos.map(veredictoDeBorrado);
  const bloqueadas = ubicaciones.filter((v) => !v.borrable);
  if (accion === 'retirar') {
    // Retirar vale para todas: tener uso no impide dar de baja, impide BORRAR.
    const vivas = usos.filter((u) => u.estado !== 'baja').length;
    return { ubicaciones, se_borran: 0, se_retiran: vivas, bloqueadas: [], total: usos.length };
  }
  return {
    ubicaciones,
    se_borran: ubicaciones.length - bloqueadas.length,
    se_retiran: 0,
    bloqueadas,
    total: usos.length,
  };
}

export interface ResultadoRetiro {
  borradas: number;
  retiradas: number;
  /** Las que no se pudieron borrar, con su motivo. Siguen existiendo. */
  bloqueadas: VeredictoUbicacion[];
  /** La pieza del croquis quedó sin ubicaciones y se retiró con ellas. */
  pieza_retirada: boolean;
}

/** «a, b y c» — para que el motivo se lea como una frase y no como una lista de campos. */
export function unirY(xs: readonly string[]): string {
  if (xs.length <= 1) return xs[0] ?? '';
  return `${xs.slice(0, -1).join(', ')} y ${xs[xs.length - 1]}`;
}

/** Cómo se describe el alcance en la pregunta de confirmación, en palabras de la tienda. */
export function describeAlcance(a: AlcanceRetiro): string {
  switch (a.que) {
    case 'nivel':
      return `la ubicación ${a.code}`;
    case 'rack':
      return `el rack ${a.pasillo}${String(a.rack).padStart(2, '0')} completo`;
    case 'pasillo':
      return `el pasillo ${a.pasillo} completo`;
    case 'pieza':
      return 'esta pieza completa';
  }
}
