/**
 * `[MDT.1.3]` `[MDT.1.4]` — El contrato del motor de checklist (Fase MDT, D5).
 *
 * Un solo vocabulario para la norma (plantilla + versión de puntos), la entrega de una persona y la
 * evidencia de cada punto. La pantalla y el servidor juzgan con ESTAS funciones: si cada lado
 * tuviera su copia de «¿está hecho?», dos pantallas medirían distinto (lección de MDTask, que llegó
 * a tener la regla en 9 archivos).
 *
 * ── Las reglas que se portan de MDTask (`item-completado.util.ts`, `emision-manual.util.ts`) ───────
 *  1. **Hecho = con evidencia.** Marcar no basta. Un punto `photos` está hecho con al menos UNA
 *     foto SUBIDA (una foto que se quedó en el teléfono no es prueba: nadie más puede verla).
 *     Un punto `text` con texto no vacío; uno `list` con al menos un renglón no vacío. Sólo un
 *     punto `none` (no lo usa el manual: es para checklists sin evidencia) se cierra con la marca.
 *  2. **Justificado NO es hecho.** Es la constancia de que alguien explicó por qué no se pudo
 *     (la nota de la entrega o la entrega tarde). Cuenta aparte: el porcentaje de cumplimiento
 *     sólo suma lo hecho (MDTask Fase 2.1, 13-sep-2026).
 *  3. **La tarea del día se DERIVA** de la norma (frecuencia × día) al leer. Nadie la emite (D3).
 *
 * ── Lo que NO se porta, y se declara ─────────────────────────────────────────────────────────
 *  · Los descansos semanales por persona (`mdtask_descansos_semanales`): son de RH (D12). Mientras
 *    no existan en la Suite, un día de descanso muestra las tareas como pendientes.
 *  · Monto, folio y comentario extra (`requires_*`): se piden y se guardan, pero NO deciden si el
 *    punto está hecho — tampoco en MDTask (`tieneEvidencia` no los mira).
 *  · Excel como documento: la validación por firma acepta PDF e imágenes, no hojas de cálculo.
 */

/** Qué prueba un punto. */
export const EVIDENCIAS_PUNTO = ['photos', 'text', 'list', 'none'] as const;
export type EvidenciaPunto = (typeof EVIDENCIAS_PUNTO)[number];

export const MOMENTOS_TAREA = ['apertura', 'operacion', 'cierre', 'supervision', 'administrativo'] as const;
export type MomentoTarea = (typeof MOMENTOS_TAREA)[number];

export const FRECUENCIAS_TAREA = ['daily', 'weekly', 'biweekly', 'monthly', 'event'] as const;
export type FrecuenciaTarea = (typeof FRECUENCIAS_TAREA)[number];

/**
 * Días hacia atrás en los que todavía se puede abrir y entregar (tarde) una tarea. Una sola constante
 * para el servidor (que lo exige) y la pantalla (que ofrece hasta ahí): `[MDT.UI.7]`.
 */
export const DIAS_ENTREGA_TARDIA = 7;

/** Orden del día en que se recorren los momentos: la lista de tareas se ordena así (`[MDT.UI.8]`). */
export const ORDEN_MOMENTO: Record<MomentoTarea, number> = {
  apertura: 0, operacion: 1, supervision: 2, administrativo: 3, cierre: 4,
};

export const ESTADOS_ENTREGA = ['in_progress', 'submitted', 'cancelled'] as const;
export type EstadoEntrega = (typeof ESTADOS_ENTREGA)[number];

/** Un punto de control, tal como vive en `checklist_template_versions.items`. */
export interface PuntoChecklist {
  /** Estable dentro de la versión (`p0`, `p1`…). */
  id: string;
  label: string;
  /** Bloque de la jornada al que el anexo lo adscribe (Inicio, Surtido…), si lo dice. */
  block: string | null;
  evidence: EvidenciaPunto;
  /** El punto se prueba con un archivo que YA existe (factura, póliza): acepta PDF, no sólo cámara. */
  accepts_documents: boolean;
  requires_amount: boolean;
  requires_folio: boolean;
  requires_comment: boolean;
}

/** Lo que la persona capturó en un punto (sin los archivos: viven en su tabla). */
export interface RespuestaPunto {
  checked?: boolean;
  text?: string;
  list?: string[];
  amount?: number | null;
  folio?: string | null;
  comment?: string | null;
  /** Cuándo lo dejó listo (ISO). Lo sella el servidor. */
  done_at?: string | null;
}

/** Los tres estados de un punto. Excluyentes: un punto está en uno y sólo uno. */
export type EstadoPunto = 'hecho' | 'justificado' | 'no_ejecutado';

const texto = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

/**
 * ¿El punto, por sí solo, tiene evidencia válida? `archivos` = cuántos archivos VIVOS (subidos y no
 * retirados) tiene ese punto.
 */
export function tieneEvidencia(punto: Pick<PuntoChecklist, 'evidence'>, respuesta: RespuestaPunto | null | undefined, archivos: number): boolean {
  switch (punto.evidence) {
    case 'photos':
      return archivos > 0;
    case 'text':
      return texto(respuesta?.text).length > 0;
    case 'list':
      return Array.isArray(respuesta?.list) && respuesta!.list!.some((r) => texto(r).length > 0);
    case 'none':
      return respuesta?.checked === true;
    default:
      // Una evidencia que el contrato no conoce NO cae a «hecho»: un default disfrazado convertiría lo
      // desconocido en cumplimiento.
      return false;
  }
}

/** ¿La entrega trae una justificación que explique lo que falta? */
export function tieneJustificacion(entrega: { employee_note?: string | null; submitted_late?: boolean | null }): boolean {
  return texto(entrega.employee_note).length > 0 || entrega.submitted_late === true;
}

export function estadoPunto(
  punto: Pick<PuntoChecklist, 'evidence'>,
  respuesta: RespuestaPunto | null | undefined,
  archivos: number,
  entrega: { employee_note?: string | null; submitted_late?: boolean | null },
): EstadoPunto {
  if (tieneEvidencia(punto, respuesta, archivos)) return 'hecho';
  if (tieneJustificacion(entrega)) return 'justificado';
  return 'no_ejecutado';
}

/**
 * ¿Se puede entregar? Con todos los puntos hechos, sí. Con alguno sin evidencia, sólo con una nota
 * que lo explique — y esos puntos quedan `justificado`, nunca `hecho`.
 */
export function motivoNoEntregable(
  puntos: readonly Pick<PuntoChecklist, 'id' | 'evidence'>[],
  respuestas: Readonly<Record<string, RespuestaPunto>>,
  archivosPorPunto: Readonly<Record<string, number>>,
  nota: string | null | undefined,
): string | null {
  const faltan = puntos.filter((p) => !tieneEvidencia(p, respuestas[p.id], archivosPorPunto[p.id] ?? 0));
  if (!faltan.length) return null;
  if (texto(nota).length > 0) return null;
  return `Faltan ${faltan.length} de ${puntos.length} punto(s) con evidencia. Agrega la evidencia o escribe por qué no se pudo.`;
}

/** Día de la semana ISO (1 = lunes … 7 = domingo) de una fecha `AAAA-MM-DD`, sin zona horaria. */
export function diaSemanaIso(fechaYmd: string): number {
  const [y, m, d] = fechaYmd.split('-').map(Number);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0 = domingo
  return dow === 0 ? 7 : dow;
}

function ultimoDiaDelMes(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/**
 * ¿La norma pide esta tarea en esta fecha? La tarea del día se DERIVA de aquí (D3).
 *  · `monthly` con un día que el mes no tiene (31 en abril) cae en el último día del mes: si no,
 *    ese mes la tarea no existiría.
 *  · `biweekly` (ningún manual la usa hoy): el 15 y el último día del mes.
 *  · `event` nunca: la dispara algo que la app no puede anticipar (cambio de custodia, siniestro).
 */
export function tocaEnFecha(
  norma: { frequency: FrecuenciaTarea; weekday: number | null; month_day: number | null },
  fechaYmd: string,
): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fechaYmd)) return false;
  const [y, m, d] = fechaYmd.split('-').map(Number);
  switch (norma.frequency) {
    case 'daily':
      return true;
    case 'weekly':
      return norma.weekday != null && diaSemanaIso(fechaYmd) === norma.weekday;
    case 'monthly': {
      if (norma.month_day == null) return false;
      return d === Math.min(norma.month_day, ultimoDiaDelMes(y, m));
    }
    case 'biweekly':
      return d === 15 || d === ultimoDiaDelMes(y, m);
    case 'event':
    default:
      return false;
  }
}

/** Resumen de una entrega: cuántos puntos hay y en qué estado. */
export interface AvancePuntos {
  total: number;
  hechos: number;
  justificados: number;
  sin_ejecutar: number;
}

export function avanceDe(
  puntos: readonly Pick<PuntoChecklist, 'id' | 'evidence'>[],
  respuestas: Readonly<Record<string, RespuestaPunto>>,
  archivosPorPunto: Readonly<Record<string, number>>,
  entrega: { employee_note?: string | null; submitted_late?: boolean | null },
): AvancePuntos {
  const r: AvancePuntos = { total: puntos.length, hechos: 0, justificados: 0, sin_ejecutar: 0 };
  for (const p of puntos) {
    const e = estadoPunto(p, respuestas[p.id], archivosPorPunto[p.id] ?? 0, entrega);
    if (e === 'hecho') r.hechos++;
    else if (e === 'justificado') r.justificados++;
    else r.sin_ejecutar++;
  }
  return r;
}

// ── Formas HTTP (`/checklists/*`) ──────────────────────────────────────────────────────────────

/** Estado de una tarea del día para quien la tiene que hacer. */
export type EstadoTareaDelDia = 'pendiente' | 'en_proceso' | 'entregada' | 'cancelada';

/** Una tarea que la norma le pide a la persona en una fecha: exista o no su entrega. */
export interface TareaDelDia {
  template_id: string;
  key: string;
  name: string;
  moment: MomentoTarea | null;
  frequency: FrecuenciaTarea;
  period_date: string;
  /** Vencimiento (hora límite del día, en hora de México) como ISO. */
  due_at: string;
  vencida: boolean;
  document_title: string | null;
  /**
   * El manual la llena por CADA evento (recepción, pedido, ruta) y aquí se entrega una vez al día,
   * consolidada. La lista lo tiene que decir (`[MDT.UI.9]`).
   */
  per_event: boolean;
  run_id: string | null;
  estado: EstadoTareaDelDia;
  avance: AvancePuntos;
  submitted_late: boolean | null;
}

export interface MisTareas {
  fecha: string;
  /** El puesto con el que se derivó. `null` = la persona no tiene puesto: no hay norma que aplicar. */
  position_code: string | null;
  position_name: string | null;
  tareas: TareaDelDia[];
  /** Lo que esta lista NO puede contestar (ADR-056). */
  no_responde: string[];
}

export interface ArchivoEvidencia {
  id: string;
  item_id: string;
  mime: string;
  size_bytes: number;
  original_name: string | null;
  captured_at: string | null;
  created_at: string;
  /** URL prefirmada de corta vida. Vacía si el bucket no está configurado. */
  url: string;
}

export interface PuntoDeEntrega extends PuntoChecklist {
  respuesta: RespuestaPunto;
  archivos: ArchivoEvidencia[];
  estado: EstadoPunto;
}

export interface DetalleEntrega {
  id: string;
  template_id: string;
  name: string;
  document_title: string | null;
  document_version: string | null;
  format_code: string | null;
  note: string | null;
  version: number;
  period_date: string;
  due_at: string;
  status: EstadoEntrega;
  employee_note: string | null;
  submitted_at: string | null;
  submitted_late: boolean | null;
  assigned_to: string;
  assigned_name: string | null;
  /** Quien pide puede escribir en ella (es suya y está abierta). */
  editable: boolean;
  puntos: PuntoDeEntrega[];
  avance: AvancePuntos;
}

export interface AbrirEntrega {
  template_id: string;
  period_date: string;
}

export interface GuardarPunto {
  checked?: boolean;
  text?: string;
  list?: string[];
  amount?: number | null;
  folio?: string | null;
  comment?: string | null;
}

export interface SubirEvidencia {
  /** Data URI (`data:image/jpeg;base64,…`). El tipo se valida por la FIRMA del archivo. */
  file_base64: string;
  file_name?: string;
  /** Cuándo se tomó la foto, según el teléfono (ISO). Informativo. */
  captured_at?: string | null;
}

export interface EntregarChecklist {
  employee_note?: string | null;
}

/** Una persona del equipo de quien pregunta, con su avance del día. */
export interface AvanceDePersona {
  user_id: string;
  nombre: string;
  position_code: string | null;
  position_name: string | null;
  warehouse_code: string | null;
  tareas: number;
  entregadas: number;
  en_proceso: number;
  pendientes: number;
  vencidas: number;
  puntos: AvancePuntos;
  /** Sus tareas del día, para abrir cada entrega desde el panel. */
  detalle: TareaDelDia[];
}

export interface AvanceDelEquipo {
  fecha: string;
  personas: AvanceDePersona[];
  no_responde: string[];
}

/** La norma de un puesto, para leerla o editarla. */
export interface NormaTarea {
  template_id: string;
  key: string;
  name: string;
  moment: MomentoTarea | null;
  frequency: FrecuenciaTarea;
  weekday: number | null;
  month_day: number | null;
  due_time: string;
  document_title: string | null;
  document_version: string | null;
  format_code: string | null;
  note: string | null;
  active: boolean;
  positions: { code: string; name: string }[];
  version: number;
  valid_from: string;
  /** El motivo de la versión que rige. */
  change_note: string | null;
  /** La hora de inicio del día de la tarea (`HH:MM`): la hora límite tiene que ser posterior. */
  start_time: string;
  puntos: PuntoChecklist[];
}

export interface NuevaVersionNorma {
  items: PuntoChecklist[];
  change_note: string;
  /** Desde cuándo rige (AAAA-MM-DD). Por omisión, hoy. */
  valid_from?: string;
  /**
   * Hora límite `HH:MM` (hora de México) desde esta versión. Sin ella, la versión CONSERVA la que regía:
   * cambiar los puntos no regresa la hora a la de la plantilla (`[MDT.3.2b]`).
   */
  due_time?: string;
}

/** `HH:MM` de 24 horas, de 00:01 a 23:59. Devuelve el motivo del error o `null`. */
export function validarHora(h: unknown): string | null {
  if (typeof h !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(h)) return 'La hora límite va como HH:MM, de 00:01 a 23:59';
  if (h === '00:00') return 'La hora límite va como HH:MM, de 00:01 a 23:59';
  return null;
}

/**
 * Valida los puntos de una versión nueva. Devuelve el motivo del primer error, o `null`.
 * Ids únicos, texto no vacío, evidencia conocida, tope de 200.
 */
export function validarPuntos(items: unknown): string | null {
  if (!Array.isArray(items) || !items.length) return 'La norma necesita al menos un punto';
  if (items.length > 200) return 'Máximo 200 puntos por tarea';
  const ids: string[] = [];
  for (let i = 0; i < items.length; i++) {
    const p = items[i] as Partial<PuntoChecklist>;
    if (!p || typeof p !== 'object') return `Punto ${i + 1}: forma inválida`;
    if (typeof p.id !== 'string' || !/^[a-z0-9_-]{1,40}$/i.test(p.id)) return `Punto ${i + 1}: id inválido`;
    if (ids.indexOf(p.id) >= 0) return `Punto ${i + 1}: id repetido (${p.id})`;
    ids.push(p.id);
    if (!texto(p.label) || texto(p.label).length > 500) return `Punto ${i + 1}: el texto es obligatorio (máx. 500)`;
    if (!EVIDENCIAS_PUNTO.includes(p.evidence as EvidenciaPunto)) return `Punto ${i + 1}: evidencia desconocida`;
  }
  return null;
}
