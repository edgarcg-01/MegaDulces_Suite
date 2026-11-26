import {
  AREAS_PARTICIPANTE, LIMITES_REUNION, MODALIDADES_REUNION, sumarDias, TIPOS_REUNION,
  type AccionReunion, type AgendarReunionDto, type AreaParticipante, type ChoqueReunion, type EstadoReunion, type LadoParticipante,
  type ModalidadReunion, type ParticipanteDto, type SituacionReunion, type TipoReunion,
} from '@megadulces/contracts';

/**
 * `[PQ.3.8]` Compras › Proveedores › Citas — el dominio, sin base de datos (C1).
 *
 * Plan: `docs/IMPLEMENTACION/FASES/FASE_PQ_ANEXO_CALENDARIO_COMPRAS.md` §9.1 y §10.15 (DC9, DC12, DC34, DC41).
 * Lo que aquí se decide, la base lo vuelve a exigir con sus CHECK (migración 20261125203927): el dominio da el
 * mensaje en español ANTES de llegar a la base; la base es la última palabra.
 *
 * Puras: no leen el reloj (`hoy` y `ahora` llegan como argumento) ni la base.
 */

export class CitasError extends Error {
  constructor(readonly tipo: 'no_encontrada' | 'invalida' | 'conflicto', mensaje: string) {
    super(mensaje);
  }
}

const invalida = (m: string) => new CitasError('invalida', m);
const conflicto = (m: string) => new CitasError('conflicto', m);

const FECHA = /^\d{4}-\d{2}-\d{2}$/;
const HORA = /^([01]\d|2[0-3]):[0-5]\d$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `AAAA-MM-DD` que existe en el calendario (no `2026-02-30`). */
export function esFecha(s: unknown): s is string {
  if (typeof s !== 'string' || !FECHA.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

const minutosDelDia = (h: string) => Number(h.slice(0, 2)) * 60 + Number(h.slice(3, 5));

const texto = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

/** Texto opcional: vacío = `null`; más largo que el tope, rechazado con su nombre. */
function opcional(v: unknown, tope: number, que: string): string | null {
  if (v == null) return null;
  if (typeof v !== 'string') throw invalida(`${que} debe ser texto.`);
  const t = v.trim();
  if (!t) return null;
  if (t.length > tope) throw invalida(`${que}: máximo ${tope} caracteres (tiene ${t.length}).`);
  return t;
}

export interface ParticipanteNormalizado {
  /** El que ya estaba (al editar); `null`, uno nuevo. */
  readonly id: string | null;
  readonly side: LadoParticipante;
  readonly user_id: string | null;
  readonly area: AreaParticipante | null;
  readonly name: string | null;
  readonly job_title: string | null;
}

export interface ReunionNormalizada {
  readonly supplier_code: string;
  readonly kind: TipoReunion;
  readonly status: 'scheduled' | 'to_confirm';
  readonly date: string;
  readonly start_time: string;
  readonly end_time: string;
  readonly mode: ModalidadReunion;
  readonly location: string | null;
  readonly topics: string[];
  readonly work_plan_year: number | null;
  readonly participants: ParticipanteNormalizado[];
}

/**
 * Quién va. Por Mega Dulces: un usuario con su área, una sola vez. Por el proveedor: nombre (y puesto, si se sabe).
 * ⛔ Al menos una persona de Mega Dulces: una reunión con el proveedor a la que no va nadie de la casa no es agenda.
 */
export function validarParticipantes(xs: unknown): ParticipanteNormalizado[] {
  if (!Array.isArray(xs)) throw invalida('Faltan los participantes.');
  if (xs.length > LIMITES_REUNION.participantes) throw invalida(`Máximo ${LIMITES_REUNION.participantes} participantes por reunión.`);
  const usuarios = new Set<string>();
  const ids = new Set<string>();
  const out = xs.map((x): ParticipanteNormalizado => {
    if (!x || typeof x !== 'object') throw invalida('Un participante no es válido.');
    const p = x as ParticipanteDto;
    const id = p.id == null || p.id === '' ? null : String(p.id).toLowerCase();
    if (id !== null) {
      if (!UUID.test(id)) throw invalida('Un participante no es válido.');
      if (ids.has(id)) throw invalida('Un participante viene dos veces.');
      ids.add(id);
    }
    if (p.side === 'internal') {
      const user_id = texto(p.user_id).toLowerCase();
      if (!UUID.test(user_id)) throw invalida('Elige a la persona de Mega Dulces.');
      if (!AREAS_PARTICIPANTE.includes(p.area as AreaParticipante)) throw invalida('Elige el área de cada persona de Mega Dulces.');
      if (usuarios.has(user_id)) throw invalida('Una persona está dos veces en la reunión.');
      usuarios.add(user_id);
      return { id, side: 'internal', user_id, area: p.area as AreaParticipante, name: null, job_title: null };
    }
    if (p.side === 'supplier') {
      const name = opcional(p.name, LIMITES_REUNION.nombre, 'El nombre de quien va por el proveedor');
      if (!name) throw invalida('Escribe el nombre de quien va por el proveedor.');
      const job_title = opcional(p.job_title, LIMITES_REUNION.puesto, 'El puesto');
      return { id, side: 'supplier', user_id: null, area: null, name, job_title };
    }
    throw invalida('Cada participante es de Mega Dulces o del proveedor.');
  });
  if (!out.some((p) => p.side === 'internal')) throw invalida('Al menos una persona de Mega Dulces va a la reunión.');
  return out;
}

/**
 * Agendar o editar (`edicion = true`: el estado no se toca aquí). `hoy` es la fecha de la Ciudad de México.
 * Una reunión que ya pasó se puede registrar (para escribir su minuta) hasta `dias_atras`.
 */
export function validarReunion(dto: AgendarReunionDto, hoy: string, edicion = false): ReunionNormalizada {
  if (!dto || typeof dto !== 'object') throw invalida('Faltan los datos de la reunión.');
  const supplier_code = texto(dto.supplier_code);
  if (!supplier_code) throw invalida('Elige el proveedor.');
  if (supplier_code.length > 20) throw invalida('La clave del proveedor no es válida.');
  if (!TIPOS_REUNION.includes(dto.kind)) throw invalida('Elige el tipo de reunión.');

  const status = edicion ? 'scheduled' : (dto.status ?? 'scheduled');
  if (status !== 'scheduled' && status !== 'to_confirm') {
    throw invalida('Una reunión nueva queda agendada o por confirmar; la minuta y la cancelación van después.');
  }

  const date = texto(dto.date);
  if (!esFecha(date)) throw invalida('La fecha no es válida (AAAA-MM-DD).');
  if (date < sumarDias(hoy, -LIMITES_REUNION.dias_atras)) {
    throw invalida(`La fecha es de hace más de ${LIMITES_REUNION.dias_atras} días.`);
  }
  if (date > sumarDias(hoy, LIMITES_REUNION.dias_adelante)) throw invalida('La fecha está a más de dos años.');

  const start_time = texto(dto.start_time);
  const end_time = texto(dto.end_time);
  if (!HORA.test(start_time) || !HORA.test(end_time)) throw invalida('Las horas no son válidas (HH:MM).');
  const duracion = minutosDelDia(end_time) - minutosDelDia(start_time);
  if (duracion <= 0) throw invalida('La hora de fin va después de la de inicio, el mismo día.');
  if (duracion > LIMITES_REUNION.duracion_max_min) throw invalida('Una reunión de más de 12 horas parece un error de captura.');

  if (!MODALIDADES_REUNION.includes(dto.mode)) throw invalida('Elige cómo se reúnen: en persona, llamada o videollamada.');
  const location = opcional(dto.location, LIMITES_REUNION.lugar, 'El lugar');

  if (dto.topics != null && !Array.isArray(dto.topics)) throw invalida('Los temas van en una lista.');
  const topics = (dto.topics ?? []).map((t) => {
    if (typeof t !== 'string') throw invalida('Cada tema es texto.');
    return t.trim();
  }).filter(Boolean);
  if (topics.length > LIMITES_REUNION.temas) throw invalida(`Máximo ${LIMITES_REUNION.temas} temas.`);
  const largo = topics.find((t) => t.length > LIMITES_REUNION.tema);
  if (largo) throw invalida(`Cada tema, máximo ${LIMITES_REUNION.tema} caracteres (uno tiene ${largo.length}).`);

  let work_plan_year: number | null = null;
  if (dto.kind === 'work_plan') {
    const y = dto.work_plan_year;
    if (typeof y !== 'number' || !Number.isInteger(y) || y < 2025 || y > 2100) throw invalida('El plan de trabajo es de un año: elige cuál.');
    work_plan_year = y;
  } else if (dto.work_plan_year != null) {
    throw invalida('Sólo el plan de trabajo lleva año.');
  }

  return {
    supplier_code, kind: dto.kind, status, date, start_time, end_time, mode: dto.mode, location, topics, work_plan_year,
    participants: validarParticipantes(dto.participants),
  };
}

export function validarMinuta(dto: unknown): string {
  const t = texto((dto as { minutes?: unknown } | null)?.minutes);
  if (!t) throw invalida('Escribe la minuta: qué se habló y qué se acordó.');
  if (t.length > LIMITES_REUNION.minuta) throw invalida(`La minuta, máximo ${LIMITES_REUNION.minuta} caracteres (tiene ${t.length}).`);
  return t;
}

export function validarMotivo(dto: unknown): string {
  const t = texto((dto as { reason?: unknown } | null)?.reason);
  if (!t) throw invalida('Escribe por qué se cancela.');
  if (t.length > LIMITES_REUNION.motivo) throw invalida(`El motivo, máximo ${LIMITES_REUNION.motivo} caracteres (tiene ${t.length}).`);
  return t;
}

interface Momento {
  readonly status: EstadoReunion;
  readonly starts_at: string;
  readonly ends_at: string;
}

/** Lo que ve la persona. Una reunión abierta que ya terminó es `sin_minuta`, nunca `realizada` (§9.1). */
export function situacion(r: Momento, ahora: string): SituacionReunion {
  if (r.status === 'cancelled') return 'cancelada';
  if (r.status === 'held') return 'realizada';
  const a = Date.parse(ahora);
  if (Date.parse(r.ends_at) <= a) return 'sin_minuta';
  if (Date.parse(r.starts_at) <= a) return 'en_curso';
  return r.status === 'to_confirm' ? 'por_confirmar' : 'agendada';
}

/**
 * Por qué NO se puede hacer `accion` (o `null` si sí). La misma regla arma los botones (`acciones`) y frena la
 * escritura, para que la pantalla no ofrezca lo que la API rechaza.
 *  - Realizada y cancelada son finales: la minuta no se reescribe y una cancelada no revive (se agenda otra).
 *  - La minuta, sólo cuando la reunión ya empezó.
 */
export function porQueNo(accion: AccionReunion, r: Momento, ahora: string): string | null {
  if (r.status === 'held') return 'La reunión ya se realizó: su minuta no se cambia.';
  if (r.status === 'cancelled') return 'La reunión está cancelada: si se va a hacer, agenda otra.';
  if (accion === 'confirmar' && r.status !== 'to_confirm') return 'La reunión ya estaba confirmada.';
  if (accion === 'minuta' && Date.parse(r.starts_at) > Date.parse(ahora)) {
    return 'La reunión todavía no empieza: la minuta se escribe cuando ya se reunieron.';
  }
  return null;
}

export function exigir(accion: AccionReunion, r: Momento, ahora: string): void {
  const motivo = porQueNo(accion, r, ahora);
  if (motivo) throw conflicto(motivo);
}

const ACCIONES: readonly AccionReunion[] = ['confirmar', 'minuta', 'editar', 'cancelar'];

export function acciones(r: Momento, ahora: string): AccionReunion[] {
  return ACCIONES.filter((a) => porQueNo(a, r, ahora) === null);
}

/** La semana (lunes a domingo) que contiene `fecha`. */
export function semanaDe(fecha: string): { desde: string; hasta: string } {
  if (!esFecha(fecha)) throw invalida('La semana se pide con una fecha AAAA-MM-DD.');
  const diaSemana = new Date(`${fecha}T00:00:00Z`).getUTCDay(); // 0 = domingo
  const desde = sumarDias(fecha, -((diaSemana + 6) % 7));
  return { desde, hasta: sumarDias(desde, 6) };
}

/** Un participante vivo, como lo guarda la base. */
export interface ParticipanteGuardado {
  readonly id: string;
  readonly side: LadoParticipante;
  readonly user_id: string | null;
  readonly area: AreaParticipante | null;
  readonly name: string | null;
  readonly job_title: string | null;
}

const mismo = (g: ParticipanteGuardado, p: ParticipanteNormalizado) =>
  g.side === p.side && (g.user_id ?? null) === p.user_id && (g.area ?? null) === p.area
  && (g.name ?? null) === p.name && (g.job_title ?? null) === p.job_title;

/**
 * Al editar, la lista que llega es la COMPLETA. Un renglón de participante no se cambia: el que falta se quita (con
 * fecha) y el que cambió se quita y se agrega otro. ⚠️ Primero se quita y después se agrega: el índice único
 * («un usuario una vez») sólo cuenta a los vivos, y cambiar el área de alguien es quitarlo y volverlo a poner.
 */
export function cambiosDeParticipantes(
  guardados: readonly ParticipanteGuardado[], pedidos: readonly ParticipanteNormalizado[],
): { quitar: string[]; agregar: ParticipanteNormalizado[] } {
  const porId = new Map(guardados.map((g) => [g.id.toLowerCase(), g]));
  const conservados = new Set<string>();
  const agregar: ParticipanteNormalizado[] = [];
  for (const p of pedidos) {
    if (p.id === null) { agregar.push(p); continue; }
    const g = porId.get(p.id);
    if (!g) throw conflicto('Alguien ya no está en la reunión (otra persona la cambió): vuelve a abrirla.');
    if (mismo(g, p)) conservados.add(p.id);
    else agregar.push({ ...p, id: null });
  }
  const quitar = guardados.map((g) => g.id).filter((id) => !conservados.has(id.toLowerCase()));
  return { quitar, agregar };
}

/** Una reunión con su gente de Mega Dulces, para buscar choques de horario. */
export interface ReunionParaChoque extends Momento {
  readonly id: string;
  readonly supplier_code: string;
  readonly supplier_name: string | null;
  readonly start_time: string;
  readonly end_time: string;
  readonly internos: readonly { readonly user_id: string; readonly nombre: string }[];
}

/**
 * Las personas de Mega Dulces que tienen OTRA reunión abierta a la misma hora. Sólo entre reuniones abiertas (por
 * confirmar o agendadas) que todavía no terminan: una realizada, cancelada o ya pasada no ocupa a nadie (la que pasó
 * sin minuta pide su minuta, no un aviso de horario). Se tocan si una empieza antes de que la otra termine; la que
 * empieza justo cuando la otra acaba no choca.
 */
export function choquesDe(reuniones: readonly ReunionParaChoque[], ahora: string): Map<string, ChoqueReunion[]> {
  const a0 = Date.parse(ahora);
  const abiertas = reuniones.filter((r) => (r.status === 'scheduled' || r.status === 'to_confirm') && Date.parse(r.ends_at) > a0);
  const out = new Map<string, ChoqueReunion[]>();
  const anotar = (a: ReunionParaChoque, b: ReunionParaChoque, persona: { user_id: string; nombre: string }) => {
    const lista = out.get(a.id) ?? [];
    lista.push({
      user_id: persona.user_id, nombre: persona.nombre, meeting_id: b.id, supplier_code: b.supplier_code,
      supplier_name: b.supplier_name, start_time: b.start_time, end_time: b.end_time,
    });
    out.set(a.id, lista);
  };
  for (let i = 0; i < abiertas.length; i++) {
    for (let j = i + 1; j < abiertas.length; j++) {
      const a = abiertas[i];
      const b = abiertas[j];
      if (!(Date.parse(a.starts_at) < Date.parse(b.ends_at) && Date.parse(b.starts_at) < Date.parse(a.ends_at))) continue;
      const enB = new Set(b.internos.map((p) => p.user_id));
      for (const p of a.internos) {
        if (!enB.has(p.user_id)) continue;
        anotar(a, b, p);
        anotar(b, a, p);
      }
    }
  }
  return out;
}

/**
 * El área que se propone por el puesto (DC9, DC16, DC41). La pantalla la deja cambiar: quien va por Dirección a una
 * revisión de negocio puede ir como Compras. `null` = sin propuesta.
 */
const AREA_POR_PUESTO: Readonly<Record<string, AreaParticipante>> = {
  gerente_compras: 'compras',
  compras: 'compras',
  compras_operaciones: 'compras',
  auxiliar_compras: 'compras',
  jefe_marketing: 'marketing',
  marketing: 'marketing',
  tesoreria: 'finanzas',
  finanzas: 'finanzas',
  direccion: 'direccion',
};

export function areaDelPuesto(puesto: string | null | undefined): AreaParticipante | null {
  return AREA_POR_PUESTO[(puesto ?? '').toLowerCase()] ?? null;
}
