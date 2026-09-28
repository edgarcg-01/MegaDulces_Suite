/**
 * `[GX.29]` — **Las reglas de la reapertura de un vale.** Funciones puras, sin knex.
 *
 * Viven aparte porque deciden **quién puede tocar dinero ya aprobado**, y eso se prueba sin
 * levantar una base. El servicio las llama; la base sólo guarda lo que estas funciones
 * dejaron pasar.
 *
 * Las cuatro decisiones son del usuario (2026-09-26), no inventadas acá:
 *   1. Autoriza la reapertura **sólo quien aprobó ese vale**.
 *   2. Al reabrirse el vale vuelve a la bandeja del día y **hay que autorizarlo de nuevo**.
 *   3. Un vale **rechazado no se reabre** — y deja de verse a las 24 h.
 *   4. Un vale **ya aplicado en Kepler no se toca**.
 */

/** Horas que un rechazo sigue a la vista antes de ocultarse. */
export const HORAS_VISIBLE_TRAS_RECHAZO = 24;

/** El `kind` con el que la solicitud vive en `finance.proposed_actions`. */
export const KIND_REAPERTURA = 'reapertura_vale';

/** Lo que la regla necesita saber del expediente. Nada más. */
export interface ValeParaReabrir {
  id: string;
  status: string | null;
  /** Quien aprobó/validó. Es el ÚNICO que puede autorizar la reapertura. */
  validated_by: string | null;
  /** Quien lo levantó: el único que puede pedirla. */
  created_by: string | null;
  /** Estado del documento en Kepler (`c43`): `F` = aplicada, ya tiene póliza. */
  estado_kepler?: string | null;
}

export type MotivoNegativa =
  | 'no_existe'
  | 'rechazado'
  | 'aplicado_en_kepler'
  | 'todavia_no_decidido'
  | 'ya_abierto'
  | 'no_es_tuyo';

export interface Veredicto {
  puede: boolean;
  motivo?: MotivoNegativa;
  /** Frase para la persona. Nunca un código pelado: quien lo lee no depura, trabaja. */
  explicacion?: string;
}

const EXPLICA: Record<MotivoNegativa, string> = {
  no_existe: 'No encuentro ese vale.',
  rechazado: 'Un vale rechazado no se reabre: hay que capturarlo de nuevo.',
  aplicado_en_kepler:
    'Este gasto ya se aplicó en Kepler, así que ya tiene póliza. Cambiarle la evidencia haría que el expediente deje de coincidir con la contabilidad: la corrección va en un documento aparte.',
  todavia_no_decidido: 'Este vale todavía está esperando decisión — no hace falta reabrirlo, todavía se le puede agregar.',
  ya_abierto: 'Este vale ya está abierto: agregá la evidencia y mandalo otra vez.',
  no_es_tuyo: 'Sólo quien levantó el vale puede pedir que se reabra.',
};

function no(motivo: MotivoNegativa): Veredicto {
  return { puede: false, motivo, explicacion: EXPLICA[motivo] };
}

/**
 * ¿Se puede PEDIR la reapertura de este vale, y lo pide quien corresponde?
 *
 * ⚠️ Un vale en `recibida` NO necesita reapertura: ya está abierto. Devolver «sí» ahí
 * mandaría a la persona a un trámite para hacer algo que ya puede hacer sola, y le
 * enseñaría a pedir permiso por reflejo.
 */
export function puedePedirReapertura(vale: ValeParaReabrir | null | undefined, quienPide: string): Veredicto {
  if (!vale) return no('no_existe');
  const status = String(vale.status || '').trim();
  const kepler = String(vale.estado_kepler || '').trim().toUpperCase();

  // El orden importa: lo que CIERRA el caso va primero. Decirle «no es tuyo» a alguien
  // cuyo vale ya se aplicó en Kepler lo manda a buscar al dueño para nada.
  if (kepler === 'F') return no('aplicado_en_kepler');
  if (status === 'rechazada') return no('rechazado');
  if (status === 'recibida') return no('ya_abierto');
  if (status === 'revision') return no('todavia_no_decidido');

  const mio = String(vale.created_by || '').trim();
  if (!mio || mio !== String(quienPide || '').trim()) return no('no_es_tuyo');

  return { puede: true };
}

/**
 * ¿Puede ESTA persona autorizar la reapertura?
 *
 * Sólo quien aprobó el vale. No su jefe, no otro aprobador, no un superadmin: lo pidió así
 * el usuario, y tiene sentido — quien firmó es el único que sabe qué revisó cuando firmó.
 *
 * ⚠️ El costo está dicho: si esa persona no está, el vale espera. La alternativa (un
 * suplente) es una decisión de negocio que no se toma acá de contrabando.
 */
export function puedeAutorizarReapertura(vale: ValeParaReabrir | null | undefined, quienDecide: string): Veredicto {
  if (!vale) return no('no_existe');
  const aprobador = String(vale.validated_by || '').trim();
  const quien = String(quienDecide || '').trim();
  if (!aprobador || !quien || aprobador !== quien) {
    return {
      puede: false,
      motivo: 'no_es_tuyo',
      explicacion: 'Sólo quien aprobó este vale puede autorizar que se reabra.',
    };
  }
  return { puede: true };
}

/**
 * ¿Este vale rechazado todavía se ve?
 *
 * Se DERIVA de la hora del rechazo, no de un flag: un flag necesita un proceso que lo
 * prenda, y un proceso que falla en silencio deja vales visibles creyendo que se ocultaron.
 *
 * ⚠️ Ocultar no es borrar. La fila queda: un vale rechazado es la evidencia de que alguien
 * intentó cobrar algo que no correspondía.
 */
export function siguemVisible(status: string | null | undefined, validatedAt: string | Date | null | undefined,
  ahora: Date = new Date()): boolean {
  if (String(status || '').trim() !== 'rechazada') return true;
  if (!validatedAt) return true; // sin hora de rechazo no se puede medir: se DECLARA visible
  const t = validatedAt instanceof Date ? validatedAt.getTime() : Date.parse(String(validatedAt));
  if (!Number.isFinite(t)) return true;
  return (ahora.getTime() - t) < HORAS_VISIBLE_TRAS_RECHAZO * 3600_000;
}

/** El `WHERE` que esconde los rechazos viejos. Uno solo, para que las pantallas no se separen. */
export const SQL_OCULTA_RECHAZOS_VIEJOS =
  `(status <> 'rechazada' OR validated_at IS NULL OR validated_at > now() - interval '${HORAS_VISIBLE_TRAS_RECHAZO} hours')`;
