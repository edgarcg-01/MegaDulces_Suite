/**
 * Fase RH · Capturar una incidencia: el formulario, lo que se manda al servidor y qué se propone para un día.
 *
 * Vivía dentro del panel de Incidencias (`[RH.1.7]`…`[RH.17.2]`). `[RH.18.1]` (E1, 2026-11-23) la saca para que la
 * misma captura se use desde el renglón del día en la ficha de la persona, sin salir de ella (como en Mega Talento):
 * una sola regla de qué pide cada tipo, no dos copias.
 *
 * ⚠️ Lo que se propone por día (`sugerenciasDelDia`) es un ORDEN de opciones, no una regla: el servidor valida igual y la
 * persona elige. Es una propuesta de desarrollo para probarla con RH; la equivalencia con los nombres de Mega Talento
 * («Tráfico», «Cita médica», «Personal», «No registrada») está pendiente con RH (D1).
 */
import type { HrCapturaIncidenciaBody, HrDiaAsistencia } from '@megadulces/contracts';
import { hoyEnMexico } from './rh.service';

export interface FormCaptura {
  person_code: string; incident_type: string; date_from: string; date_to: string; note: string;
  horas: string; entrada: string; reason: string; authorized_by_name: string; deliver: boolean;
  /** `[RH.1.10]` Desayuno o comida distintos: los minutos que RH autorizó ese día. */
  minutos: string;
  /** `[RH.17.2]` Horario distinto: a qué hora salió ese día y su comida en minutos (opcionales). */
  salida?: string;
  comidaDia?: string;
  /** `[RH.6.6]` Visita fuera: a qué hora lo recogieron y a qué hora lo dejaron en su casa. */
  recogida?: string;
  entrega?: string;
  /** `[RH.6.7]` Pago de horas extras: el total pagado, en horas (12.5 = 12 h 30). */
  horasPagadas?: string;
}

/** `[RH.1.10]` Los tipos de UN solo día (no llevan «Hasta»), como `TIPOS_DE_AJUSTE` del servidor. */
export const DE_UN_DIA = new Set(['horario_distinto', 'desayuno_distinto', 'comida_distinta', 'cambio_descanso', 'pago_horas_extra']);
/** Los que exigen la nota (y qué se escribe en ella). */
export const NOTA_OBLIGATORIA: Record<string, string> = {
  otros: 'Motivo', visita_fuera: 'A dónde fue y por qué', pago_horas_extra: 'Referencia del pago (p. ej. nómina del 15)',
};
/** Los que piden motivo y quién lo autorizó. */
export const CON_AUTORIZACION = new Set(['horario_distinto', 'desayuno_distinto', 'comida_distinta']);

export const deUnDia = (tipo: string): boolean => DE_UN_DIA.has(tipo);
export const notaObligatoria = (tipo: string): boolean => tipo in NOTA_OBLIGATORIA;
export const etiquetaNota = (tipo: string): string => NOTA_OBLIGATORIA[tipo] ?? 'Nota (folio, motivo)';
export const conAutorizacion = (tipo: string): boolean => CON_AUTORIZACION.has(tipo);

/** Un formulario vacío: la persona y el día, si se saben; el tipo, el que se pida (Vacaciones, el de siempre). */
export function formNuevo(persona = '', desde = '', tipo = 'vacaciones'): FormCaptura {
  return {
    person_code: persona, incident_type: tipo, date_from: desde || hoyEnMexico(), date_to: '',
    note: '', horas: '', entrada: '', reason: '', authorized_by_name: '', deliver: false, minutos: '',
  };
}

/** Lo que se manda al servidor. Sólo viaja lo que pide el tipo, aunque el formulario conserve otros campos. */
export function cuerpoCaptura(f: FormCaptura, site: string): HrCapturaIncidenciaBody {
  const aMin = (t: string): number | undefined => {
    const m = /^(\d{1,2}):(\d{2})$/.exec(t || '');
    return m ? Number(m[1]) * 60 + Number(m[2]) : undefined;
  };
  const t = f.incident_type;
  const pausa = t === 'desayuno_distinto' || t === 'comida_distinta';
  const autoriza = CON_AUTORIZACION.has(t);
  const minPausa = String(f.minutos ?? '').trim() === '' ? undefined : Math.round(Number(f.minutos));
  // `[RH.6.6]` La recogida va como horario base y el lapso hasta la entrega, como minutos (lo valida el servidor).
  const recogida = t === 'visita_fuera' ? aMin(f.recogida ?? '') : undefined;
  const entrega = t === 'visita_fuera' ? aMin(f.entrega ?? '') : undefined;
  const lapsoVf = recogida !== undefined && entrega !== undefined ? entrega - recogida : undefined;
  // `[RH.6.7]` Las horas pagadas, a minutos («1,5» también se entiende).
  const hp = Number(String(f.horasPagadas ?? '').replace(',', '.'));
  const minPagados = t === 'pago_horas_extra' && String(f.horasPagadas ?? '').trim() !== '' && Number.isFinite(hp) ? Math.round(hp * 60) : undefined;
  // `[RH.17.2]` Horario distinto con el horario completo de ese día: salida y comida, si se llenaron.
  const hdDia = t === 'horario_distinto';
  const comidaDia = hdDia && String(f.comidaDia ?? '').trim() !== '' ? Math.round(Number(f.comidaDia)) : undefined;
  return {
    site_code: site, person_code: f.person_code.trim(), incident_type: t, date_from: f.date_from,
    date_to: DE_UN_DIA.has(t) ? undefined : f.date_to || undefined, note: f.note.trim() || undefined,
    minutes: t === 'horas_extra' ? aMin(f.horas) : t === 'horario_distinto' ? aMin(f.entrada) : pausa ? minPausa
      : t === 'visita_fuera' ? lapsoVf : t === 'pago_horas_extra' ? minPagados : undefined,
    reason: autoriza ? f.reason.trim() : undefined,
    authorized_by_name: autoriza || t === 'visita_fuera' ? f.authorized_by_name.trim() : undefined,
    base_schedule_minutes: recogida,
    end_minutes: hdDia ? aMin(f.salida ?? '') : undefined,
    break_minutes: comidaDia,
    deliver: f.deliver || undefined,
  };
}

const AUSENCIA = ['permiso_con_goce', 'permiso_sin_goce', 'vacaciones', 'incapacidad', 'falta_injustificada'];
const POR_VENIR = ['vacaciones', 'permiso_con_goce', 'permiso_sin_goce', 'descanso', 'cambio_descanso'];

/**
 * `[RH.18.1]` Los tipos que tienen sentido para ESE día, el más probable primero. Sólo ordena: los 19 siguen a un clic.
 *  · no vino (falta, sin dato, sin checadas que medir) → permisos, vacaciones, incapacidad, falta injustificada;
 *  · un día que no ha llegado → vacaciones, permisos, descanso;
 *  · una sola checada → horario distinto (la otra hora la pone RH);
 *  · se pasó de la comida o del desayuno → comida / desayuno distintos;
 *  · llegó tarde o salió antes → horario distinto, uso de horas extra, permiso;
 *  · descanso → cambio de descanso, visita fuera;
 *  · un día normal → horario distinto, visita fuera, uso de horas extra.
 */
export function sugerenciasDelDia(d: HrDiaAsistencia | undefined, fecha: string, hoy: string): string[] {
  if (!d) return fecha > hoy ? POR_VENIR : AUSENCIA;
  switch (d.estado) {
    case 'falta': case 'sin_dato': return AUSENCIA;
    case 'marca_faltante': return ['horario_distinto', 'permiso_con_goce', 'otros'];
    case 'descanso': return ['cambio_descanso', 'visita_fuera', 'otros'];
    case 'justificado': return ['otros', 'horario_distinto'];
    default: {
      if ((d.comidaExcesoMin ?? 0) > 0) return ['comida_distinta', 'horario_distinto', 'horas_extra'];
      if ((d.desayunoExcesoMin ?? 0) > 0) return ['desayuno_distinto', 'horario_distinto', 'horas_extra'];
      if ((d.atrasoMin ?? 0) > 0 || (d.salidaAntesMin ?? 0) > 0) return ['horario_distinto', 'horas_extra', 'permiso_con_goce'];
      return ['horario_distinto', 'visita_fuera', 'horas_extra'];
    }
  }
}

/** Una hora «08:05» (o «8:05») tal cual; otra cosa, vacío. */
const hhmm = (h: string | null | undefined): string => {
  const m = /^(\d{1,2}):(\d{2})/.exec(h ?? '');
  return m ? `${m[1].padStart(2, '0')}:${m[2]}` : '';
};

/**
 * `[RH.18.1]` El formulario de un día: la persona y la fecha puestas, el tipo más probable ya elegido y, para corregir en
 * vez de teclear, lo que checó ese día: entrada, salida y comida para «Horario distinto», y los minutos que tomó para
 * «Comida / Desayuno distintos». ⛔ Con una sola checada no se adivina si fue entrada o salida: se deja vacío.
 */
export function formDelDia(persona: string, fecha: string, d: HrDiaAsistencia | undefined, hoy: string, tipos: string[]): FormCaptura {
  const sug = sugerenciasDelDia(d, fecha, hoy).filter((t) => !tipos.length || tipos.includes(t));
  const f = formNuevo(persona, fecha, sug[0] ?? 'vacaciones');
  if (!d || d.estado === 'marca_faltante') return f;
  f.entrada = hhmm(d.entrada);
  f.salida = hhmm(d.salida);
  if (d.comidaMin != null) f.comidaDia = String(d.comidaMin);
  if (f.incident_type === 'comida_distinta' && d.comidaMin != null) f.minutos = String(d.comidaMin);
  if (f.incident_type === 'desayuno_distinto' && d.desayunoMin != null) f.minutos = String(d.desayunoMin);
  return f;
}
