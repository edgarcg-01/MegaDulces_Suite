/**
 * `[GX.86]` **Horario para dar de alta un vale de gasto.**
 *
 * Decisión del usuario (2026-10-22): quienes dan de alta sus gastos sólo pueden hacerlo de
 * **8:30 a 10:00 y de 17:00 a 18:00, de lunes a viernes** (hora de México). Sábado y domingo
 * cerrado.
 *
 * Alcance decidido:
 *  · Bloquea **sólo el alta** de un vale. Subir la factura de un vale ya aprobado sigue
 *    abierto todo el día (no se frena el cierre de lo que ya está en curso).
 *  · **Los aprobadores no tienen horario** (`FINANCE_EXPENSES_COMPROBAR`, o rol de plataforma).
 *  · Aplica también al alta por link de captura: quien entra por link no tiene permisos.
 *
 * Medido antes de decidir (prod, 30 días al 2026-10-22): 972 vales de 46 personas, y **784
 * (81 %) se levantaron fuera de este horario**; la hora pico era las 10:00 (128 vales).
 *
 * Sin dependencias: lo leen el servidor (que es el que BLOQUEA) y la pantalla (que AVISA).
 * La hora sale de la zona de México, nunca de la del proceso ni del navegador.
 */
import { ZONA_NEGOCIO_MX } from './dia-negocio.contract';
import { Permission } from '../authz/permissions';

export interface VentanaAlta {
  /** `HH:MM`, inclusive. */
  desde: string;
  /** `HH:MM`, exclusiva: a las 10:00 en punto ya está cerrado. */
  hasta: string;
}

export const VENTANAS_ALTA_GASTOS: readonly VentanaAlta[] = [
  { desde: '08:30', hasta: '10:00' },
  { desde: '17:00', hasta: '18:00' },
];

/** Días ISO (1 = lunes … 7 = domingo) en que abre. */
export const DIAS_ALTA_GASTOS: readonly number[] = [1, 2, 3, 4, 5];

const NOMBRE_DIA = ['', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado', 'domingo'];

export interface EstadoHorarioAlta {
  abierto: boolean;
  /** Si está abierto, a qué hora cierra la ventana en curso (`HH:MM`). */
  cierra: string | null;
  /** Si está cerrado, cuándo abre: `hoy`/`mañana`/nombre del día + hora. */
  abre: { dia: string; hora: string } | null;
  /** Una frase para la persona. */
  mensaje: string;
}

/** El horario completo, dicho como se lee: «de lunes a viernes, de 8:30 a 10:00 y de 17:00 a 18:00». */
export const HORARIO_ALTA_GASTOS_TEXTO =
  'de lunes a viernes, de 8:30 a 10:00 y de 17:00 a 18:00';

const min = (hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
};
const sinCero = (hhmm: string) => hhmm.replace(/^0/, '');

/** Día ISO y minuto del día en México para un instante. */
function partesMx(ahora: Date): { dow: number; minuto: number } {
  const p = new Intl.DateTimeFormat('en-US', {
    timeZone: ZONA_NEGOCIO_MX, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(ahora);
  const v = (t: string) => p.find((x) => x.type === t)?.value ?? '';
  const dow = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(v('weekday')) + 1;
  return { dow, minuto: Number(v('hour')) * 60 + Number(v('minute')) };
}

/** ¿Se puede dar de alta un vale en este instante? Y si no, cuándo. */
export function horarioAltaGastos(ahora: Date = new Date()): EstadoHorarioAlta {
  const { dow, minuto } = partesMx(ahora);

  if (DIAS_ALTA_GASTOS.includes(dow)) {
    const en = VENTANAS_ALTA_GASTOS.find((w) => minuto >= min(w.desde) && minuto < min(w.hasta));
    if (en) {
      return { abierto: true, cierra: en.hasta, abre: null,
        mensaje: `Puedes dar de alta tus gastos hasta las ${sinCero(en.hasta)}.` };
    }
  }

  // Cerrado: la próxima ventana, buscando desde hoy hasta una semana adelante.
  for (let d = 0; d <= 7; d++) {
    const dia = ((dow - 1 + d) % 7) + 1;
    if (!DIAS_ALTA_GASTOS.includes(dia)) continue;
    const w = VENTANAS_ALTA_GASTOS.find((x) => d > 0 || min(x.desde) > minuto);
    if (!w) continue;
    const nombre = d === 0 ? 'hoy' : d === 1 ? 'mañana' : `el ${NOMBRE_DIA[dia]}`;
    return { abierto: false, cierra: null, abre: { dia: nombre, hora: w.desde },
      mensaje: `El alta de gastos está cerrada. Abre ${nombre} a las ${sinCero(w.desde)} (${HORARIO_ALTA_GASTOS_TEXTO}).` };
  }
  // Inalcanzable mientras haya al menos un día y una ventana; se declara en vez de inventar.
  return { abierto: false, cierra: null, abre: null, mensaje: 'El alta de gastos está cerrada.' };
}

/** Quién no tiene horario: el aprobador y el rol de plataforma. */
export function exentoDeHorarioAlta(permisos: Record<string, boolean> | null | undefined, esAdminPlataforma: boolean): boolean {
  return esAdminPlataforma || permisos?.[Permission.FINANCE_EXPENSES_COMPROBAR] === true;
}
