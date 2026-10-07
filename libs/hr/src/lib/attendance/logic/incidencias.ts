/**
 * Fase RH · `[RH.1.6]` — INCIDENCIAS DE PERSONAL: catálogo, flujo y banderas. Lógica PURA.
 *
 * Copia de las reglas de `mega-talento-90/api/src/incidencias.ts` @ 2c7d267, separadas de su
 * router: aquí sólo queda lo que se decide sin base (qué tipo excusa una falta, de qué estado a
 * cuál se puede pasar, quién puede dar cada paso, qué banderas ve la auditoría). La escritura
 * vive en `attendance-incidents.service.ts`.
 *
 * El catálogo vive en código y no en texto libre porque el cálculo de asistencia decide por el
 * TIPO si un día deja de contar como falta (`excusaFalta`). Con texto libre, "vacasiones"
 * escrito a mano no excusaba nada y "permiso sin goce" excusaba lo mismo que "con goce".
 *
 *   capturada ─calificar─▶ calificada ─cierre de semana─▶ cerrada ─auditar─▶ auditada
 *       └─rechazar─▶ rechazada        (capturada/calificada) ─anular─▶ anulada
 *
 * Seis estados, no cuatro como decía el plan: rechazada y anulada son salidas del flujo, y nada
 * se borra (anular deja la incidencia con quién, cuándo y por qué).
 *
 * ══ QUIÉN DA CADA PASO, EN LA SUITE ══
 * En Mega Talento "servicios al personal" y "contabilidad" eran el mismo rol (admin) y la
 * separación se sostenía comparando nombres. Aquí cada paso es una clave propia:
 *   · capturar  → `HR_INCIDENTS_CAPTURAR`
 *   · calificar / rechazar / anular lo calificado → `HR_INCIDENTS_CALIFICAR`
 *   · auditar   → `HR_INCIDENTS_AUDITAR`, y NUNCA sobre algo que uno capturó o calificó
 *     (además lo sostiene un CHECK de la tabla: no depende de que este archivo no se equivoque).
 * Quien califica y captura entra ya calificada (`autocalificada` queda como bandera), salvo que
 * la ENTREGUE a propósito para que la vea otra persona.
 */

export interface TipoIncidencia {
  tipo: string;
  etiqueta: string;
  /** Código de 2-3 letras que cabe en la celda del reporte. */
  codigo: string;
  excusaFalta: boolean;
}

export const TIPOS_INCIDENCIA: TipoIncidencia[] = [
  { tipo: 'vacaciones',          etiqueta: 'Vacaciones',                 codigo: 'VAC', excusaFalta: true },
  { tipo: 'permiso_sin_goce',    etiqueta: 'Permiso sin goce de sueldo', codigo: 'PSG', excusaFalta: true },
  { tipo: 'permiso_con_goce',    etiqueta: 'Permiso con goce de sueldo', codigo: 'PCG', excusaFalta: true },
  { tipo: 'falta_injustificada', etiqueta: 'Falta injustificada',        codigo: 'FI',  excusaFalta: false },
  { tipo: 'incapacidad',         etiqueta: 'Incapacidad',                codigo: 'INC', excusaFalta: true },
  { tipo: 'paternidad',          etiqueta: 'Paternidad',                 codigo: 'PAT', excusaFalta: true },
  { tipo: 'maternidad',          etiqueta: 'Maternidad',                 codigo: 'MAT', excusaFalta: true },
  { tipo: 'riesgo_trabajo',      etiqueta: 'Riesgo de trabajo',          codigo: 'RT',  excusaFalta: true },
  { tipo: 'amonestacion',        etiqueta: 'Amonestación',               codigo: 'AMO', excusaFalta: false },
  { tipo: 'semana_reducida',     etiqueta: 'Semana reducida',            codigo: 'SR',  excusaFalta: true },
  // Usó horas a favor: justifica el día y sus minutos SE SUMAN a las horas de ese día.
  { tipo: 'horas_extra',         etiqueta: 'Uso de horas extra',         codigo: 'HE',  excusaFalta: true },
  // "Otros" justifica desde el 29/09/2026: exige escribir el motivo.
  { tipo: 'otros',               etiqueta: 'Otros',                      codigo: 'OTR', excusaFalta: true },
  // Ese día entró en otro horario: NO justifica, su retardo de ESE día se mide contra la hora
  // nueva (en `minutes`, minuto del día: 600 = 10:00). Es de UN solo día. Desde el 01/10/2026
  // exige motivo y quién lo autorizó (63 usos en dos días, 40 corriendo la entrada 1 h o más).
  { tipo: 'horario_distinto',    etiqueta: 'Horario distinto',           codigo: 'HD',  excusaFalta: false },
];

const POR_TIPO = new Map(TIPOS_INCIDENCIA.map((t) => [t.tipo, t]));
export const tipoIncidencia = (tipo: string): TipoIncidencia | undefined => POR_TIPO.get(tipo);

export type EstadoIncidencia = 'capturada' | 'calificada' | 'rechazada' | 'cerrada' | 'auditada' | 'anulada';

export const TODOS_LOS_ESTADOS: EstadoIncidencia[] =
  ['capturada', 'calificada', 'rechazada', 'cerrada', 'auditada', 'anulada'];

/** Los estados que SÍ cambian el cálculo de asistencia. */
export const ESTADOS_VIGENTES: EstadoIncidencia[] = ['calificada', 'cerrada', 'auditada'];

export const NOMBRE_ESTADO: Record<EstadoIncidencia, string> = {
  capturada: 'por calificar', calificada: 'calificada', rechazada: 'rechazada',
  cerrada: 'cerrada en prenómina', auditada: 'auditada', anulada: 'anulada',
};

/** Las banderas que la auditoría ve sin abrir cada renglón. No bloquean nada: dicen dónde mirar. */
export type BanderaIncidencia =
  | 'corrimiento_60'   // Horario distinto que corre la entrada 60 min o más
  | 'hd_frecuente'     // 3 o más Horario distinto de la misma persona en 30 días
  | 'autocalificada'   // la calificó la misma persona que la capturó
  | 'sin_nota'         // no dice nada que la respalde (folio, motivo…)
  | 'retroactiva';     // se capturó más de 7 días después de pasar

export const HD_CORRIMIENTO_ALERTA_MIN = 60;
export const HD_FRECUENTE_30D = 3;
/** Un dedazo en el año (2062) no debe escribir un periodo de 36 años. */
export const TOPE_DIAS_INCIDENCIA = 366;

/** Lo mínimo de una fila para calcular sus banderas. */
export interface FilaParaBanderas {
  incident_type: string;
  minutes: number | null;
  base_schedule_minutes: number | null;
  created_by: string | null;
  created_by_name: string | null;
  rated_by: string | null;
  rated_by_name: string | null;
  note: string | null;
  created_at: string | Date | null;
  date_to: string;
  /** Cuántos Horario distinto tuvo la persona en los 30 días previos (incluida ésta). */
  hd_30d?: number | null;
}

/** ¿Es la misma persona? Por id cuando los dos lo tienen; si no, por nombre (lo histórico). */
export function mismaPersona(
  aId: string | null | undefined, aNombre: string | null | undefined,
  bId: string | null | undefined, bNombre: string | null | undefined,
): boolean {
  if (aId && bId) return aId === bId;
  return !!aNombre && !!bNombre && aNombre.trim().toLowerCase() === bNombre.trim().toLowerCase();
}

export function banderasDe(r: FilaParaBanderas): BanderaIncidencia[] {
  const b: BanderaIncidencia[] = [];
  if (r.incident_type === 'horario_distinto') {
    if (r.minutes != null && r.base_schedule_minutes != null
        && Number(r.minutes) - Number(r.base_schedule_minutes) >= HD_CORRIMIENTO_ALERTA_MIN) b.push('corrimiento_60');
    if (r.hd_30d != null && Number(r.hd_30d) >= HD_FRECUENTE_30D) b.push('hd_frecuente');
  }
  if ((r.rated_by || r.rated_by_name)
      && mismaPersona(r.rated_by, r.rated_by_name, r.created_by, r.created_by_name)) b.push('autocalificada');
  // El Horario distinto lleva su nota armada sola; "sin nota" es para lo demás.
  if (r.incident_type !== 'horario_distinto' && !String(r.note || '').trim()) b.push('sin_nota');
  if (r.created_at && r.date_to) {
    const creado = new Date(r.created_at).getTime();
    if (creado - Date.parse(`${r.date_to}T23:59:59-06:00`) > 7 * 86400000) b.push('retroactiva');
  }
  return b;
}

// ── Captura ─────────────────────────────────────────────────────────────────────────────────

export interface CapturaIncidencia {
  site_code?: unknown;
  person_code?: unknown;
  incident_type?: unknown;
  date_from?: unknown;
  date_to?: unknown;
  note?: unknown;
  minutes?: unknown;
  /** Horario distinto: por qué ese día entró a otra hora. */
  reason?: unknown;
  authorized_by_name?: unknown;
  /** Horario distinto: su entrada de siempre, minuto del día. */
  base_schedule_minutes?: unknown;
  /** Quien califica captura ya calificada, salvo que la entregue a propósito. */
  deliver?: unknown;
}

export interface CapturaValida {
  site_code: string;
  person_code: string;
  incident_type: string;
  date_from: string;
  date_to: string;
  note: string | null;
  minutes: number | null;
  authorized_by_name: string | null;
  base_schedule_minutes: number | null;
  deliver: boolean;
}

const RE_FECHA = /^\d{4}-\d{2}-\d{2}$/;

/** Valida una captura y la deja lista para escribir; o devuelve el error en palabras de RH. */
export function validarCaptura(b: CapturaIncidencia): { ok: true; valor: CapturaValida } | { ok: false; error: string } {
  const site = String(b.site_code ?? '').trim();
  const persona = String(b.person_code ?? '').trim();
  const tipo = String(b.incident_type ?? '').trim();
  const desde = String(b.date_from ?? '').trim();
  const hasta = String(b.date_to || desde).trim();
  let nota = String(b.note ?? '').trim();
  const autorizo = String(b.authorized_by_name ?? '').trim();
  let minutos: number | null = null;
  let base: number | null = null;

  if (!site || !persona || !tipo || !desde) {
    return { ok: false, error: 'Faltan el sitio, la persona, el tipo o la fecha.' };
  }
  if (!tipoIncidencia(tipo)) return { ok: false, error: `Tipo de incidencia desconocido: ${tipo}.` };
  if (!RE_FECHA.test(desde) || !RE_FECHA.test(hasta)) {
    return { ok: false, error: 'Las fechas deben venir como yyyy-MM-dd.' };
  }
  if (hasta < desde) return { ok: false, error: 'La fecha final no puede ser anterior a la inicial.' };
  const dias = Math.round((Date.parse(`${hasta}T12:00:00Z`) - Date.parse(`${desde}T12:00:00Z`)) / 86400000) + 1;
  if (dias > TOPE_DIAS_INCIDENCIA) {
    return { ok: false, error: `El periodo son ${dias} días y el tope es ${TOPE_DIAS_INCIDENCIA}. Revisa las fechas.` };
  }

  if (tipo === 'horas_extra') {
    minutos = Math.round(Number(b.minutes));
    if (!Number.isFinite(minutos) || minutos < 1 || minutos > 720) {
      return { ok: false, error: 'Indica cuántas horas extra usó (entre 1 minuto y 12 horas).' };
    }
  }
  if (tipo === 'horario_distinto') {
    minutos = Math.round(Number(b.minutes));
    if (b.minutes === null || b.minutes === undefined || b.minutes === '' || !Number.isFinite(minutos)
        || minutos < 0 || minutos > 1439) {
      return { ok: false, error: 'Falta la hora de entrada de ese día.' };
    }
    if (hasta !== desde) return { ok: false, error: 'El horario distinto es de un solo día.' };
    const motivo = String(b.reason ?? '').trim();
    if (!motivo) return { ok: false, error: 'Escribe por qué ese día entró en otro horario.' };
    if (!autorizo) return { ok: false, error: 'Escribe quién autorizó el cambio de horario.' };
    if (b.base_schedule_minutes != null && b.base_schedule_minutes !== '') {
      const v = Math.round(Number(b.base_schedule_minutes));
      base = Number.isFinite(v) && v >= 0 && v <= 1439 ? v : null;
    }
    // El motivo va primero; los hechos del reloj (que arma la pantalla) detrás.
    nota = nota ? `${motivo} — ${nota}` : motivo;
  }
  if (tipo === 'otros' && !nota) return { ok: false, error: 'Con "Otros" hay que escribir el motivo.' };

  return {
    ok: true,
    valor: {
      site_code: site, person_code: persona, incident_type: tipo, date_from: desde, date_to: hasta,
      note: nota || null, minutes: minutos, authorized_by_name: autorizo || null,
      base_schedule_minutes: base, deliver: b.deliver === true,
    },
  };
}

// ── Pasos sobre una incidencia ya guardada ──────────────────────────────────────────────────

export type Accion = 'calificar' | 'rechazar' | 'anular' | 'auditar';

export const PASOS: Record<Accion, { desde: EstadoIncidencia[]; hacia: EstadoIncidencia; motivo: boolean }> = {
  calificar: { desde: ['capturada'],               hacia: 'calificada', motivo: false },
  rechazar:  { desde: ['capturada'],               hacia: 'rechazada',  motivo: true },
  anular:    { desde: ['capturada', 'calificada'], hacia: 'anulada',    motivo: true },
  auditar:   { desde: ['cerrada'],                 hacia: 'auditada',   motivo: false },
};

export interface Actor {
  id: string | null;
  nombre: string | null;
  puedeCalificar: boolean;
  puedeAuditar: boolean;
}

/** Lo que el paso necesita saber de la incidencia. */
export interface EstadoActual {
  status: EstadoIncidencia;
  created_by: string | null;
  created_by_name: string | null;
  rated_by: string | null;
  rated_by_name: string | null;
}

/**
 * ¿Puede `actor` dar `accion` sobre esta incidencia? Devuelve el rechazo con su código HTTP, o
 * null si puede. No mira la semana cerrada: eso lo decide quien tiene la base.
 */
export function rechazoDelPaso(
  accion: Accion, actual: EstadoActual, actor: Actor, motivo: string,
): { status: number; error: string } | null {
  const paso = PASOS[accion];
  if (paso.motivo && !motivo.trim()) {
    return { status: 400, error: accion === 'rechazar' ? 'Escribe por qué se rechaza.' : 'Escribe por qué se quita.' };
  }
  if (!paso.desde.includes(actual.status)) {
    return { status: 409, error: `No se puede ${accion}: la incidencia está ${NOMBRE_ESTADO[actual.status]}.` };
  }
  const esSuya = mismaPersona(actual.created_by, actual.created_by_name, actor.id, actor.nombre);
  if (accion === 'anular' && !actor.puedeCalificar && !(esSuya && actual.status === 'capturada')) {
    return { status: 403, error: 'Sólo quien califica incidencias puede quitar una ya calificada.' };
  }
  if ((accion === 'calificar' || accion === 'rechazar') && !actor.puedeCalificar) {
    return { status: 403, error: 'Calificar o rechazar es de quien califica incidencias.' };
  }
  if (accion === 'auditar') {
    if (!actor.puedeAuditar) return { status: 403, error: 'Auditar es de quien audita incidencias.' };
    const calificoEl = mismaPersona(actual.rated_by, actual.rated_by_name, actor.id, actor.nombre);
    if (calificoEl || esSuya) {
      return { status: 409, error: 'No puedes auditar una incidencia que tú capturaste o calificaste: la tiene que ver otra persona.' };
    }
  }
  return null;
}

const fechaCorta = (iso: string): string => { const [a, m, d] = iso.split('-'); return `${d}/${m}/${a}`; };

export function textoSemanaCerrada(c: { period_start: string; period_end: string; closed_by_name: string | null }): string {
  return `La semana del ${fechaCorta(c.period_start)} al ${fechaCorta(c.period_end)} ya se cerró para prenómina` +
    `${c.closed_by_name ? ` (la cerró ${c.closed_by_name})` : ''}. Para cambiarla hay que reabrirla.`;
}
