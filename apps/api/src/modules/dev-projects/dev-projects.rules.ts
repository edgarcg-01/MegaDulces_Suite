import { BadRequestException } from '@nestjs/common';

/**
 * `[DEV.1]` Reglas puras de Desarrolladores › Proyectos — sin base ni red, para poder probarlas
 * en unitario. El servicio las usa antes de tocar Postgres; la base además las sostiene con
 * CHECKs (`20261001120000_devtools_projects.js`), así que una regla nueva va en LOS DOS lados.
 */

export const DEV_PROJECT_PRIORITIES = ['baja', 'media', 'alta', 'urgente'] as const;
export type DevProjectPriority = (typeof DEV_PROJECT_PRIORITIES)[number];

export const DEV_PROJECT_STATUSES = ['nuevo', 'en_progreso', 'en_pausa', 'terminado', 'cancelado'] as const;
export type DevProjectStatus = (typeof DEV_PROJECT_STATUSES)[number];

export const ATTACHMENT_KINDS = ['documento', 'imagen', 'video', 'audio'] as const;
export type AttachmentKind = (typeof ATTACHMENT_KINDS)[number];

export const ATTACHMENT_SOURCES = ['archivo', 'camara', 'grabacion'] as const;
export type AttachmentSource = (typeof ATTACHMENT_SOURCES)[number];

/** Tope por archivo. Un video corto de celular en 1080p ronda 15-60 MB por minuto. */
export const MAX_ATTACHMENT_BYTES = 200 * 1024 * 1024;

export const TITLE_MAX = 160;
export const OBJECTIVE_MAX = 20_000;

/** `DEV-2026-0007`. El consecutivo es por año y por tenant. */
export function formatFolio(year: number, n: number): string {
  if (!Number.isInteger(year) || year < 2000 || year > 9999) throw new Error(`año inválido: ${year}`);
  if (!Number.isInteger(n) || n < 1) throw new Error(`consecutivo inválido: ${n}`);
  return `DEV-${year}-${String(n).padStart(4, '0')}`;
}

/** Qué ES el archivo, por su MIME. Todo lo que no es imagen/video/audio se trata como documento. */
export function kindFromMime(mime: string | null | undefined): AttachmentKind {
  const m = String(mime || '').toLowerCase();
  if (m.startsWith('image/')) return 'imagen';
  if (m.startsWith('video/')) return 'video';
  if (m.startsWith('audio/')) return 'audio';
  return 'documento';
}

export function parseSource(raw: unknown): AttachmentSource {
  const s = String(raw ?? 'archivo').trim();
  if ((ATTACHMENT_SOURCES as readonly string[]).includes(s)) return s as AttachmentSource;
  throw new BadRequestException(`origen de archivo inválido: ${s}`);
}

/**
 * Nombre de archivo seguro para guardar y mostrar: sin rutas, sin caracteres de control. Un
 * nombre vacío (p. ej. la foto que sale de un canvas) recibe uno descriptivo.
 */
export function sanitizeFileName(raw: string | null | undefined, fallback = 'archivo'): string {
  // Multer entrega el nombre en latin1; si trae acentos UTF-8 llegan como mojibake («FotografÃ­a»).
  let name = String(raw || '');
  try {
    const recoded = Buffer.from(name, 'latin1').toString('utf8');
    if (!recoded.includes('�')) name = recoded;
  } catch {
    /* se queda el original */
  }
  name = name.split(/[\\/]/).pop() || '';
  // eslint-disable-next-line no-control-regex
  name = name.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  if (!name) name = fallback;
  return name.length > 200 ? name.slice(name.length - 200) : name;
}

export interface DevProjectInput {
  title?: unknown;
  objective?: unknown;
  priority?: unknown;
  status?: unknown;
  assignee_user_id?: unknown;
  due_date?: unknown;
}

export interface DevProjectPatch {
  title?: string;
  objective?: string | null;
  priority?: DevProjectPriority;
  status?: DevProjectStatus;
  assignee_user_id?: string | null;
  due_date?: string | null;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Valida y normaliza el cuerpo de alta (`creating=true`, el título es obligatorio) o de edición
 * (sólo lo que venga). Devuelve únicamente los campos presentes — un `undefined` NO borra nada.
 */
export function normalizeProjectInput(body: DevProjectInput | null | undefined, creating: boolean): DevProjectPatch {
  const b = body ?? {};
  const out: DevProjectPatch = {};

  if (b.title !== undefined || creating) {
    const t = typeof b.title === 'string' ? b.title.trim().replace(/\s+/g, ' ') : '';
    if (!t) throw new BadRequestException('El nombre del proyecto es obligatorio.');
    if (t.length > TITLE_MAX) throw new BadRequestException(`El nombre no puede pasar de ${TITLE_MAX} caracteres.`);
    out.title = t;
  }

  if (b.objective !== undefined) {
    if (b.objective !== null && typeof b.objective !== 'string') throw new BadRequestException('El objetivo debe ser texto.');
    const o = typeof b.objective === 'string' ? b.objective.trim() : '';
    if (o.length > OBJECTIVE_MAX) throw new BadRequestException(`El objetivo no puede pasar de ${OBJECTIVE_MAX} caracteres.`);
    // Vacío se guarda como NULL: «todavía no se documentó» no es lo mismo que un texto vacío.
    out.objective = o || null;
  }

  if (b.priority !== undefined) {
    if (!(DEV_PROJECT_PRIORITIES as readonly unknown[]).includes(b.priority)) {
      throw new BadRequestException(`Prioridad inválida. Opciones: ${DEV_PROJECT_PRIORITIES.join(', ')}.`);
    }
    out.priority = b.priority as DevProjectPriority;
  }

  if (b.status !== undefined) {
    if (!(DEV_PROJECT_STATUSES as readonly unknown[]).includes(b.status)) {
      throw new BadRequestException(`Estado inválido. Opciones: ${DEV_PROJECT_STATUSES.join(', ')}.`);
    }
    out.status = b.status as DevProjectStatus;
  }

  if (b.assignee_user_id !== undefined) {
    if (b.assignee_user_id === null || b.assignee_user_id === '') out.assignee_user_id = null;
    else if (typeof b.assignee_user_id === 'string' && UUID_RE.test(b.assignee_user_id)) out.assignee_user_id = b.assignee_user_id;
    else throw new BadRequestException('Responsable inválido.');
  }

  if (b.due_date !== undefined) {
    if (b.due_date === null || b.due_date === '') out.due_date = null;
    else if (typeof b.due_date === 'string' && isIsoDate(b.due_date)) out.due_date = b.due_date;
    else throw new BadRequestException('Fecha compromiso inválida (formato AAAA-MM-DD).');
  }

  return out;
}

// ── Seguimiento: notas, modificaciones y el rastro de cambios (`[DEV.10]`) ─────────────────────

/** Lo que una PERSONA puede escribir. `cambio` sólo lo escribe el servidor. */
export const NOTE_KINDS = ['nota', 'modificacion'] as const;
export type NoteKind = (typeof NOTE_KINDS)[number] | 'cambio';
export const NOTE_MAX = 10_000;

export function normalizeNoteInput(body: { kind?: unknown; body?: unknown } | null | undefined): { kind: NoteKind; body: string } {
  const kind = body?.kind ?? 'nota';
  if (!(NOTE_KINDS as readonly unknown[]).includes(kind)) {
    throw new BadRequestException(`Tipo inválido. Opciones: ${NOTE_KINDS.join(', ')}.`);
  }
  const text = typeof body?.body === 'string' ? body.body.trim() : '';
  if (!text) throw new BadRequestException('La nota no puede ir vacía.');
  if (text.length > NOTE_MAX) throw new BadRequestException(`La nota no puede pasar de ${NOTE_MAX} caracteres.`);
  return { kind: kind as NoteKind, body: text };
}

export const PRIORITY_LABEL: Record<DevProjectPriority, string> = { baja: 'Baja', media: 'Media', alta: 'Alta', urgente: 'Urgente' };
export const STATUS_LABEL: Record<DevProjectStatus, string> = {
  nuevo: 'Nuevo', en_progreso: 'En progreso', en_pausa: 'En pausa', terminado: 'Terminado', cancelado: 'Cancelado',
};

export interface ProjectSnapshot {
  title: string;
  objective: string | null;
  priority: DevProjectPriority;
  status: DevProjectStatus;
  assignee_user_id: string | null;
  due_date: string | null;
}

export interface FieldChange {
  field: keyof ProjectSnapshot;
  from: string | null;
  to: string | null;
}

const FIELD_LABEL: Record<keyof ProjectSnapshot, string> = {
  title: 'Nombre', objective: 'Objetivo', priority: 'Prioridad', status: 'Estado',
  assignee_user_id: 'Asignado a', due_date: 'Fecha compromiso',
};

/**
 * Qué cambió entre lo guardado y el parche, en forma estructurada (`changes`) y legible (`summary`).
 * `null` si el parche no cambia nada — un PATCH que reenvía los mismos valores no deja rastro.
 *
 * ⚠️ El objetivo NO se copia entero al resumen: puede tener miles de caracteres. Se dice que cambió
 * y se guarda el texto anterior en `changes`, que es lo que hace falta para recuperarlo.
 */
export function describeChanges(
  before: ProjectSnapshot,
  patch: DevProjectPatch,
  nameOf: (userId: string | null) => string,
): { changes: FieldChange[]; summary: string } | null {
  const changes: FieldChange[] = [];
  for (const field of Object.keys(FIELD_LABEL) as (keyof ProjectSnapshot)[]) {
    if (!(field in patch)) continue;
    const to = ((patch as Record<string, unknown>)[field] ?? null) as string | null;
    const from = (before[field] ?? null) as string | null;
    if (to !== from) changes.push({ field, from, to });
  }
  if (!changes.length) return null;

  const show = (c: FieldChange, v: string | null): string => {
    if (c.field === 'assignee_user_id') return nameOf(v);
    if (v === null || v === '') return '—';
    if (c.field === 'status') return STATUS_LABEL[v as DevProjectStatus] ?? v;
    if (c.field === 'priority') return PRIORITY_LABEL[v as DevProjectPriority] ?? v;
    return v;
  };
  const summary = changes
    .map((c) =>
      c.field === 'objective'
        ? `${FIELD_LABEL[c.field]}: ${!c.to ? 'se borró' : c.from ? 'se reescribió' : 'se agregó'}`
        : `${FIELD_LABEL[c.field]}: ${show(c, c.from)} → ${show(c, c.to)}`,
    )
    .join(' · ');
  return { changes, summary };
}

/** `AAAA-MM-DD` que además existe en el calendario (rechaza `2026-02-30`). */
export function isIsoDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}
