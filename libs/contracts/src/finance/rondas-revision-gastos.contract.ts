/**
 * `[GX.86]` **Las rondas de revisión de gastos — se informan, no se imponen.**
 *
 * Decisión del usuario (2026-10-26), después de probar un bloqueo: *«hay que quitar la regla (…)
 * solamente hay que agregar un aviso»* y *«recuerda que pueden estar subiéndolos sin problema
 * durante el día»*. O sea: **subir un gasto es libre a cualquier hora**; lo que se informa es en
 * qué ronda se va a revisar.
 *
 * Rondas: **8:30–10:00 am y 5:00–6:00 pm, de lunes a viernes** (hora de México).
 * ⚠️ Supuesto declarado, sin confirmar todavía: que en esas horas de verdad se revisa, y que el
 * fin de semana no hay ronda. Si no es así, este archivo es el único lugar que cambia.
 *
 * Por qué el aviso cambia con la hora en vez de ser un cartel fijo: un cartel que siempre dice lo
 * mismo deja de leerse; uno que dice «el tuyo se revisa hoy a las 5:00 pm» habla del gasto de esa
 * persona y contesta su pregunta real («¿cuándo me lo revisan?»).
 *
 * Sin dependencias: lo leen las pantallas de alta y el acuse. La hora sale de la zona de México,
 * nunca de la del navegador.
 */
import { ZONA_NEGOCIO_MX } from './dia-negocio.contract';

export interface RondaRevision {
  /** `HH:MM` 24 h, inclusive. */
  desde: string;
  /** `HH:MM` 24 h, exclusiva: a las 10:00 en punto la ronda ya terminó. */
  hasta: string;
}

export const RONDAS_REVISION_GASTOS: readonly RondaRevision[] = [
  { desde: '08:30', hasta: '10:00' },
  { desde: '17:00', hasta: '18:00' },
];

/** Días ISO (1 = lunes … 7 = domingo) con ronda. */
export const DIAS_RONDA_GASTOS: readonly number[] = [1, 2, 3, 4, 5];

/** Lo primero que se lee, siempre igual: subir es libre. */
export const AVISO_RONDA_TITULO = 'Puedes subir tus gastos a cualquier hora del día, sin problema';

/** El horario completo, para quien lo quiera. */
export const AVISO_RONDA_PIE = 'Los gastos se revisan en dos rondas al día, de lunes a viernes: 8:30–10:00 am y 5:00–6:00 pm.';

export interface EstadoRonda {
  /** ¿Ahorita hay ronda? */
  en_ronda: boolean;
  /** Si hay ronda, a qué hora termina (`HH:MM` 24 h). */
  termina: string | null;
  /** Si no hay ronda, cuándo es la próxima: `hoy` / `mañana` / `el lunes`… + hora `HH:MM` 24 h. */
  proxima: { dia: string; hora: string } | null;
  /** La línea del aviso en la pantalla de alta. */
  linea: string;
  /** La línea del acuse al mandar el gasto. */
  acuse: string;
}

const NOMBRE_DIA = ['', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado', 'domingo'];

const min = (hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
};

/** `17:00` → `5:00 pm`; `08:30` → `8:30 am`. Así se dice la hora en la tienda. */
export function horaAmPm(hhmm: string): string {
  const [h, m] = hhmm.split(':').map(Number);
  const sufijo = h < 12 ? 'am' : 'pm';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(m).padStart(2, '0')} ${sufijo}`;
}

/** Día ISO y minuto del día en México para un instante. */
function partesMx(ahora: Date): { dow: number; minuto: number } {
  const p = new Intl.DateTimeFormat('en-US', {
    timeZone: ZONA_NEGOCIO_MX, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(ahora);
  const v = (t: string) => p.find((x) => x.type === t)?.value ?? '';
  const dow = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(v('weekday')) + 1;
  return { dow, minuto: Number(v('hour')) * 60 + Number(v('minute')) };
}

/** ¿En qué ronda se revisa lo que se sube en este instante? */
export function rondaDeRevision(ahora: Date = new Date()): EstadoRonda {
  const { dow, minuto } = partesMx(ahora);

  if (DIAS_RONDA_GASTOS.includes(dow)) {
    const en = RONDAS_REVISION_GASTOS.find((r) => minuto >= min(r.desde) && minuto < min(r.hasta));
    if (en) {
      const t = horaAmPm(en.hasta);
      return {
        en_ronda: true, termina: en.hasta, proxima: null,
        linea: `Ahorita estamos revisando: el tuyo entra en esta ronda, que termina a las ${t}.`,
        acuse: `Lo revisamos en esta ronda, que termina a las ${t}.`,
      };
    }
  }

  for (let d = 0; d <= 7; d++) {
    const dia = ((dow - 1 + d) % 7) + 1;
    if (!DIAS_RONDA_GASTOS.includes(dia)) continue;
    const r = RONDAS_REVISION_GASTOS.find((x) => d > 0 || min(x.desde) > minuto);
    if (!r) continue;
    const cuando = d === 0 ? 'de hoy' : d === 1 ? 'de mañana' : `del ${NOMBRE_DIA[dia]}`;
    const nombre = d === 0 ? 'hoy' : d === 1 ? 'mañana' : `el ${NOMBRE_DIA[dia]}`;
    const h = horaAmPm(r.desde);
    return {
      en_ronda: false, termina: null, proxima: { dia: nombre, hora: r.desde },
      linea: `Lo que subas ahora se revisa en la ronda ${cuando} a las ${h}.`,
      acuse: `Lo revisamos en la ronda ${cuando} a las ${h}.`,
    };
  }
  // Inalcanzable mientras haya al menos un día y una ronda; se declara en vez de inventar.
  return { en_ronda: false, termina: null, proxima: null, linea: AVISO_RONDA_PIE, acuse: '' };
}
