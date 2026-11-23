/**
 * Fase RH · Capturar una incidencia: el formulario, lo que se manda al servidor y qué se propone para un día.
 *
 * Vivía dentro del panel de Incidencias (`[RH.1.7]`…`[RH.17.2]`). `[RH.18.1]` (E1, 2026-11-23) la saca para que la
 * misma captura se use desde el renglón del día en la ficha de la persona, sin salir de ella (como en Mega Talento):
 * una sola regla de qué pide cada tipo, no dos copias.
 *
 * Lo que se propone por día (`sugerenciasDelDia`) es un ORDEN de opciones, no una regla: el servidor valida igual y la
 * persona elige. `[RH.18.3]` Lo contestó RH (D1, 2026-11-23): qué tipo usan para lo que en Mega Talento era «Tráfico»,
 * «Cita médica», «Personal» y «No registrada» (lo más frecuente; según el caso puede cambiar), y que el tipo NO venga
 * elegido: lo eligen ellas.
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

/** Un formulario vacío: la persona y el día, si se saben. `[RH.18.3]` Sin tipo: lo elige RH (antes arrancaba en Vacaciones). */
export function formNuevo(persona = '', desde = '', tipo = ''): FormCaptura {
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

/**
 * `[RH.18.3]` Cómo le dicen RH a cada tipo en Mega Talento (D1, 2026-11-23): se muestra junto al tipo y se encuentra
 * tecleándolo. «Tráfico» → Horario distinto · «Cita médica» → Incapacidad · «Personal» → Permiso sin goce · «No
 * registrada» (vino y no checó) → Otros.
 */
export const COMO_LE_DICEN: Readonly<Record<string, string>> = {
  horario_distinto: 'tráfico', incapacidad: 'cita médica', permiso_sin_goce: 'personal', otros: 'no registrada',
};
/** La etiqueta con su nombre de Mega Talento, si tiene: «Incapacidad · cita médica». */
export const etiquetaConAlias = (tipo: string, etiqueta: string): string => (COMO_LE_DICEN[tipo] ? `${etiqueta} · ${COMO_LE_DICEN[tipo]}` : etiqueta);

const AUSENCIA = ['permiso_sin_goce', 'incapacidad', 'otros', 'vacaciones', 'permiso_con_goce', 'falta_injustificada'];
const POR_VENIR = ['vacaciones', 'permiso_sin_goce', 'permiso_con_goce', 'descanso', 'cambio_descanso'];

/**
 * `[RH.18.1]` Los tipos que tienen sentido para ESE día, el más usado primero. Sólo ordena: los 19 siguen a un clic.
 * `[RH.18.3]` Con lo que contestó RH (D1):
 *  · no vino (falta, sin dato, sin checadas que medir) → permiso sin goce («personal»), incapacidad («cita médica»),
 *    otros («no registrada»: vino y no checó), vacaciones, permiso con goce, falta injustificada;
 *  · un día que no ha llegado → vacaciones, permisos, descanso;
 *  · una sola checada → otros («no registrada»), horario distinto;
 *  · se pasó de la comida o del desayuno → comida / desayuno distintos;
 *  · llegó tarde o salió antes → horario distinto («tráfico»), otros, permiso sin goce;
 *  · descanso → cambio de descanso, visita fuera;
 *  · un día normal → horario distinto, visita fuera, uso de horas extra.
 */
export function sugerenciasDelDia(d: HrDiaAsistencia | undefined, fecha: string, hoy: string): string[] {
  if (!d) return fecha > hoy ? POR_VENIR : AUSENCIA;
  switch (d.estado) {
    case 'falta': case 'sin_dato': return AUSENCIA;
    case 'marca_faltante': return ['otros', 'horario_distinto'];
    case 'descanso': return ['cambio_descanso', 'visita_fuera', 'otros'];
    case 'justificado': return ['otros', 'horario_distinto'];
    default: {
      if ((d.comidaExcesoMin ?? 0) > 0) return ['comida_distinta', 'horario_distinto', 'horas_extra'];
      if ((d.desayunoExcesoMin ?? 0) > 0) return ['desayuno_distinto', 'horario_distinto', 'horas_extra'];
      if ((d.atrasoMin ?? 0) > 0 || (d.salidaAntesMin ?? 0) > 0) return ['horario_distinto', 'otros', 'permiso_sin_goce'];
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
 * `[RH.18.1]` El formulario de un día: la persona y la fecha puestas y, para corregir en vez de teclear, lo que checó ese
 * día: entrada, salida y comida para «Horario distinto», y los minutos que tomó para «Comida / Desayuno distintos».
 * `[RH.18.3]` El tipo NO viene elegido (lo eligen ellas, D1). ⛔ Con una sola checada no se adivina si fue entrada o
 * salida: se deja vacío.
 */
export function formDelDia(persona: string, fecha: string, d: HrDiaAsistencia | undefined): FormCaptura {
  const f = formNuevo(persona, fecha);
  if (!d || d.estado === 'marca_faltante') return f;
  f.entrada = hhmm(d.entrada);
  f.salida = hhmm(d.salida);
  if (d.comidaMin != null) f.comidaDia = String(d.comidaMin);
  // Los minutos de la pausa que se pasó (la comida antes que el desayuno): sirven si eligen «Comida / Desayuno distintos».
  if ((d.comidaExcesoMin ?? 0) > 0 && d.comidaMin != null) f.minutos = String(d.comidaMin);
  else if ((d.desayunoExcesoMin ?? 0) > 0 && d.desayunoMin != null) f.minutos = String(d.desayunoMin);
  return f;
}

/**
 * `[RH.18.7]` Lo que pasó ese día, en una línea, arriba del globo: la razón por la que se abre. Lo dice el cálculo del
 * servidor tal cual (no se recalcula): «No checó en todo el día.», «Llegó 08:25 (+25 min), salió 18:00.».
 */
export function contextoDelDia(d: HrDiaAsistencia | undefined, fecha: string, hoy: string): string {
  if (!d) return fecha > hoy ? 'Un día que todavía no llega.' : 'Sin checadas que medir ese día.';
  switch (d.estado) {
    case 'falta': return fecha === hoy ? 'Todavía no checa hoy.' : 'No checó en todo el día.';
    case 'sin_dato': return 'Sin dato: nadie de la plaza checó ese día.';
    case 'marca_faltante': return `Una sola checada (${hhmm(d.hora || d.entrada) || '?'}): no se sabe si fue entrada o salida.`;
    case 'descanso': return 'Su día de descanso.';
    case 'justificado': return `Ya justificado${d.justificacion ? `: ${d.justificacion}` : ''}.`;
    default: {
      const ent = hhmm(d.entrada), sal = hhmm(d.salida);
      const tarde = (d.atrasoMin ?? 0) > 0 ? ` (+${d.atrasoMin} min)` : '';
      if (!sal) return `Entró ${ent || '?'}${tarde}.`;
      return tarde ? `Llegó ${ent}${tarde}, salió ${sal}.` : `Checó de ${ent} a ${sal}.`;
    }
  }
}
