import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { Knex } from 'knex';
import { ObjectStorageService, TenantContextService, TenantKnexService } from '@megadulces/platform-core';
import {
  MAX_ATTACHMENT_BYTES,
  describeChanges,
  formatFolio,
  kindFromMime,
  normalizeNoteInput,
  normalizeProjectInput,
  parseSource,
  sanitizeFileName,
  type AttachmentKind,
  type AttachmentSource,
  type DevProjectInput,
  type DevProjectPriority,
  type DevProjectStatus,
  type FieldChange,
  type NoteKind,
  type ProjectSnapshot,
} from './dev-projects.rules';

export interface DevTeamMember {
  user_id: string;
  display_name: string;
  username: string | null;
}

export interface DevProjectAttachment {
  id: string;
  kind: AttachmentKind;
  source: AttachmentSource;
  file_name: string;
  mime_type: string;
  size_bytes: number;
  created_at: string;
  created_by_username: string | null;
  /** `null` = evidencia del proyecto; con valor = adjunto de esa nota del seguimiento. */
  note_id: string | null;
  /** URL prefirmada temporal (10 min). `null` si el almacenamiento no está configurado. */
  url: string | null;
}

/** `[DEV.10]` Una entrada del seguimiento: nota, modificación pedida o cambio automático. */
export interface DevProjectNote {
  id: string;
  kind: NoteKind;
  body: string;
  changes: FieldChange[] | null;
  created_at: string;
  created_by_username: string | null;
  attachments: DevProjectAttachment[];
}

export interface DevProjectRow {
  id: string;
  folio: string;
  title: string;
  objective: string | null;
  priority: DevProjectPriority;
  status: DevProjectStatus;
  assignee_user_id: string | null;
  assignee_name: string | null;
  due_date: string | null;
  created_at: string;
  created_by_username: string | null;
  updated_at: string;
  attachments_count: number;
  /** Notas y modificaciones escritas por personas (sin contar el rastro automático). */
  notes_count: number;
}

export interface DevProjectDetail extends DevProjectRow {
  /** Evidencia del proyecto (los adjuntos que no cuelgan de una nota). */
  attachments: DevProjectAttachment[];
  /** Seguimiento, de la entrada más reciente a la más vieja. */
  notes: DevProjectNote[];
}

export interface UploadedFileLike {
  buffer: Buffer;
  originalname: string;
  mimetype: string;
  size: number;
}

/**
 * `[DEV.2]` Desarrolladores › Proyectos.
 *
 * Todas las lecturas y escrituras pasan por `TenantKnexService.run()`: las cuatro tablas de
 * `devtools.*` tienen RLS FORZADO y sin `app.tenant_id` en sesión devuelven cero filas — en
 * silencio, que es peor que un error (CLAUDE.md, lección de Fase E).
 */
@Injectable()
export class DevProjectsService {
  private readonly logger = new Logger(DevProjectsService.name);

  constructor(
    private readonly tk: TenantKnexService,
    private readonly tenantCtx: TenantContextService,
    private readonly storage: ObjectStorageService,
  ) {}

  /** A quién se le puede asignar un proyecto (los activos de `devtools.dev_team`). */
  async team(): Promise<DevTeamMember[]> {
    return this.tk.run(async (trx) => {
      const rows = await trx('devtools.dev_team as t')
        .leftJoin('identity.users as u', 'u.id', 't.user_id')
        .where('t.active', true)
        .orderBy([{ column: 't.sort_order' }, { column: 't.display_name' }])
        .select('t.user_id', 't.display_name', 'u.username');
      return rows.map((r: any) => ({ user_id: r.user_id, display_name: r.display_name, username: r.username ?? null }));
    });
  }

  async list(q: { status?: string; assignee?: string; search?: string } = {}): Promise<DevProjectRow[]> {
    return this.tk.run(async (trx) => {
      const b = this.baseQuery(trx).whereNull('p.deleted_at').orderBy('p.created_at', 'desc').limit(500);
      if (q.status) b.where('p.status', q.status);
      if (q.assignee === 'sin_asignar') b.whereNull('p.assignee_user_id');
      else if (q.assignee) b.where('p.assignee_user_id', q.assignee);
      const s = (q.search || '').trim();
      if (s) {
        const like = `%${s.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
        b.where((w) => w.whereILike('p.title', like).orWhereILike('p.folio', like).orWhereILike('p.objective', like));
      }
      return (await b).map(mapRow);
    });
  }

  async detail(id: string): Promise<DevProjectDetail> {
    const { row, attachments, notes } = await this.tk.run(async (trx) => {
      const r = await this.baseQuery(trx).where('p.id', id).whereNull('p.deleted_at').first();
      if (!r) throw new NotFoundException('Proyecto no encontrado.');
      const a = await trx('devtools.project_attachments')
        .where({ project_id: id })
        .whereNull('deleted_at')
        .orderBy('created_at', 'asc')
        .select('id', 'kind', 'source', 'file_name', 'mime_type', 'size_bytes', 'created_at', 'created_by_username', 'storage_key', 'note_id');
      const n = await trx('devtools.project_notes')
        .where({ project_id: id })
        .whereNull('deleted_at')
        .orderBy('created_at', 'desc')
        .select('id', 'kind', 'body', 'changes', 'created_at', 'created_by_username');
      return { row: mapRow(r), attachments: a, notes: n };
    });
    // La firma va FUERA de la transacción: es una llamada de red y no debe sostener la conexión.
    const signed: DevProjectAttachment[] = await Promise.all(
      attachments.map(async (a: any) => mapAttachment(a, (await this.storage.signedUrl(a.storage_key).catch(() => '')) || null)),
    );
    return {
      ...row,
      attachments: signed.filter((a) => !a.note_id),
      notes: notes.map((n: any) => ({
        id: n.id,
        kind: n.kind,
        body: n.body,
        changes: n.changes ?? null,
        created_at: iso(n.created_at),
        created_by_username: n.created_by_username ?? null,
        attachments: signed.filter((a) => a.note_id === n.id),
      })),
    };
  }

  async create(body: DevProjectInput): Promise<DevProjectDetail> {
    const data = normalizeProjectInput(body, true);
    const tenantId = this.tenantCtx.requireTenantId();
    const actor = this.tenantCtx.get();
    const id = await this.tk.run(async (trx) => {
      if (data.assignee_user_id) await this.assertTeamMember(trx, data.assignee_user_id);
      const year = mxYear(new Date());
      // UPSERT atómico: dos altas simultáneas reciben consecutivos distintos sin lock de tabla.
      const seq = await trx.raw(
        `INSERT INTO devtools.project_sequences (tenant_id, year, last_number) VALUES (?, ?, 1)
         ON CONFLICT (tenant_id, year) DO UPDATE SET last_number = devtools.project_sequences.last_number + 1
         RETURNING last_number`,
        [tenantId, year],
      );
      const folio = formatFolio(year, Number(seq.rows[0].last_number));
      const [r] = await trx('devtools.projects')
        .insert({
          tenant_id: tenantId,
          folio,
          title: data.title,
          objective: data.objective ?? null,
          priority: data.priority ?? 'media',
          status: data.status ?? 'nuevo',
          assignee_user_id: data.assignee_user_id ?? null,
          due_date: data.due_date ?? null,
          created_by: actor?.userId ?? null,
          created_by_username: actor?.username ?? null,
          updated_by: actor?.userId ?? null,
        })
        .returning('id');
      return r.id as string;
    });
    this.logger.log(`proyecto ${id} dado de alta por ${actor?.username ?? '?'}`);
    return this.detail(id);
  }

  async update(id: string, body: DevProjectInput): Promise<DevProjectDetail> {
    const data = normalizeProjectInput(body, false);
    const actor = this.tenantCtx.get();
    await this.tk.run(async (trx) => {
      if (data.assignee_user_id) await this.assertTeamMember(trx, data.assignee_user_id);
      // `FOR UPDATE`: el «antes» del rastro tiene que ser el que este UPDATE pisa, no uno que otra
      // edición simultánea ya cambió.
      const before = (await trx('devtools.projects')
        .where({ id })
        .whereNull('deleted_at')
        .forUpdate()
        .first(
          'tenant_id', 'title', 'objective', 'priority', 'status', 'assignee_user_id',
          trx.raw(`to_char(due_date, 'YYYY-MM-DD') as due_date`),
        )) as (ProjectSnapshot & { tenant_id: string }) | undefined;
      if (!before) throw new NotFoundException('Proyecto no encontrado.');
      const names = await this.teamNames(trx, [before.assignee_user_id, data.assignee_user_id ?? null]);
      const trail = describeChanges(before, data, (uid) => (uid ? names.get(uid) ?? 'otra persona' : 'Sin asignar'));
      if (!trail) return; // reenviar los mismos valores no es un cambio: ni UPDATE ni rastro
      await trx('devtools.projects')
        .where({ id })
        .update({ ...data, updated_at: trx.fn.now(), updated_by: actor?.userId ?? null });
      await trx('devtools.project_notes').insert({
        tenant_id: before.tenant_id,
        project_id: id,
        kind: 'cambio',
        body: trail.summary,
        changes: JSON.stringify(trail.changes),
        created_by: actor?.userId ?? null,
        created_by_username: actor?.username ?? null,
      });
    });
    return this.detail(id);
  }

  /** Baja lógica: el proyecto y sus archivos se conservan (`deleted_at`), sólo salen de la lista. */
  async remove(id: string): Promise<{ ok: true }> {
    const actor = this.tenantCtx.get();
    await this.tk.run(async (trx) => {
      const n = await trx('devtools.projects')
        .where({ id })
        .whereNull('deleted_at')
        .update({ deleted_at: trx.fn.now(), deleted_by: actor?.userId ?? null });
      if (!n) throw new NotFoundException('Proyecto no encontrado.');
    });
    return { ok: true };
  }

  /** `[DEV.10]` Agrega una nota o una modificación. Se puede en CUALQUIER estado, incluso terminado. */
  async addNote(projectId: string, body: { kind?: unknown; body?: unknown }): Promise<DevProjectNote> {
    const note = normalizeNoteInput(body);
    const tenantId = this.tenantCtx.requireTenantId();
    const actor = this.tenantCtx.get();
    const r = await this.tk.run(async (trx) => {
      const p = await trx('devtools.projects').where({ id: projectId }).whereNull('deleted_at').first('id');
      if (!p) throw new NotFoundException('Proyecto no encontrado.');
      const [row] = await trx('devtools.project_notes')
        .insert({
          tenant_id: tenantId,
          project_id: projectId,
          kind: note.kind,
          body: note.body,
          created_by: actor?.userId ?? null,
          created_by_username: actor?.username ?? null,
        })
        .returning(['id', 'kind', 'body', 'created_at', 'created_by_username']);
      await trx('devtools.projects').where({ id: projectId }).update({ updated_at: trx.fn.now(), updated_by: actor?.userId ?? null });
      return row;
    });
    return {
      id: r.id, kind: r.kind, body: r.body, changes: null,
      created_at: iso(r.created_at), created_by_username: r.created_by_username ?? null, attachments: [],
    };
  }

  /** Baja lógica de una nota. ⛔ El rastro automático (`cambio`) no se borra: es la historia. */
  async removeNote(projectId: string, noteId: string): Promise<{ ok: true }> {
    const actor = this.tenantCtx.get();
    await this.tk.run(async (trx) => {
      const n = await trx('devtools.project_notes')
        .where({ id: noteId, project_id: projectId })
        .whereNull('deleted_at')
        .first('kind');
      if (!n) throw new NotFoundException('Nota no encontrada.');
      if (n.kind === 'cambio') throw new BadRequestException('El registro automático de cambios no se puede borrar.');
      await trx('devtools.project_notes')
        .where({ id: noteId })
        .update({ deleted_at: trx.fn.now(), deleted_by: actor?.userId ?? null });
    });
    return { ok: true };
  }

  async addAttachment(
    projectId: string,
    file: UploadedFileLike | undefined,
    rawSource: unknown,
    noteId?: string | null,
  ): Promise<DevProjectAttachment> {
    if (!file?.buffer?.length) throw new BadRequestException('Archivo requerido.');
    if (file.size > MAX_ATTACHMENT_BYTES) {
      throw new BadRequestException(`El archivo pasa del tope de ${Math.round(MAX_ATTACHMENT_BYTES / 1024 / 1024)} MB.`);
    }
    const source = parseSource(rawSource);
    const tenantId = this.tenantCtx.requireTenantId();
    const actor = this.tenantCtx.get();
    const mime = file.mimetype || 'application/octet-stream';
    const fallback = source === 'camara' ? 'foto.jpg' : source === 'grabacion' ? 'video.webm' : 'archivo';
    const fileName = sanitizeFileName(file.originalname, fallback);

    const note = noteId ? String(noteId) : null;
    if (note && !UUID_RE.test(note)) throw new BadRequestException('Nota inválida.');

    // El proyecto (y la nota) se validan ANTES de subir: no dejar binarios huérfanos en el bucket.
    await this.tk.run(async (trx) => {
      const p = await trx('devtools.projects').where({ id: projectId }).whereNull('deleted_at').first('id');
      if (!p) throw new NotFoundException('Proyecto no encontrado.');
      if (note) {
        const n = await trx('devtools.project_notes').where({ id: note, project_id: projectId }).whereNull('deleted_at').first('kind');
        if (!n) throw new NotFoundException('Nota no encontrada.');
        if (n.kind === 'cambio') throw new BadRequestException('Al registro automático no se le adjuntan archivos.');
      }
    });

    const { key } = await this.storage.putBuffer(file.buffer, mime, `devtools/${tenantId}/projects/${projectId}`, fileName);

    let row: any;
    try {
      row = await this.tk.run(async (trx) => {
        const [r] = await trx('devtools.project_attachments')
          .insert({
            tenant_id: tenantId,
            project_id: projectId,
            kind: kindFromMime(mime),
            source,
            file_name: fileName,
            mime_type: mime,
            size_bytes: file.size,
            storage_key: key,
            note_id: note,
            created_by: actor?.userId ?? null,
            created_by_username: actor?.username ?? null,
          })
          .returning(['id', 'kind', 'source', 'file_name', 'mime_type', 'size_bytes', 'created_at', 'created_by_username', 'note_id']);
        await trx('devtools.projects').where({ id: projectId }).update({ updated_at: trx.fn.now(), updated_by: actor?.userId ?? null });
        return r;
      });
    } catch (e) {
      // Si el renglón no se pudo guardar, el binario no le sirve a nadie.
      await this.storage.remove(key);
      throw e;
    }
    return mapAttachment(row, (await this.storage.signedUrl(key).catch(() => '')) || null);
  }

  async removeAttachment(projectId: string, attachmentId: string): Promise<{ ok: true }> {
    const actor = this.tenantCtx.get();
    await this.tk.run(async (trx) => {
      const n = await trx('devtools.project_attachments')
        .where({ id: attachmentId, project_id: projectId })
        .whereNull('deleted_at')
        .update({ deleted_at: trx.fn.now(), deleted_by: actor?.userId ?? null });
      if (!n) throw new NotFoundException('Archivo no encontrado.');
    });
    return { ok: true };
  }

  private baseQuery(trx: Knex.Transaction) {
    return trx('devtools.projects as p')
      .leftJoin('devtools.dev_team as t', function () {
        this.on('t.user_id', '=', 'p.assignee_user_id').andOn('t.tenant_id', '=', 'p.tenant_id');
      })
      .leftJoin('identity.users as u', 'u.id', 'p.assignee_user_id')
      .select(
        'p.id', 'p.folio', 'p.title', 'p.objective', 'p.priority', 'p.status', 'p.assignee_user_id',
        trx.raw(`coalesce(t.display_name, u.nombre, u.username) as assignee_name`),
        trx.raw(`to_char(p.due_date, 'YYYY-MM-DD') as due_date`),
        'p.created_at', 'p.created_by_username', 'p.updated_at',
        trx.raw(
          `(select count(*)::int from devtools.project_attachments a
             where a.project_id = p.id and a.deleted_at is null) as attachments_count`,
        ),
        trx.raw(
          `(select count(*)::int from devtools.project_notes n
             where n.project_id = p.id and n.deleted_at is null and n.kind <> 'cambio') as notes_count`,
        ),
      );
  }

  /** Nombre visible de cada responsable: el del equipo si lo es, si no el de su usuario. */
  private async teamNames(trx: Knex.Transaction, ids: (string | null)[]): Promise<Map<string, string>> {
    const wanted = ids.filter((x): x is string => !!x);
    if (!wanted.length) return new Map();
    const rows = await trx('identity.users as u')
      .leftJoin('devtools.dev_team as t', 't.user_id', 'u.id')
      .whereIn('u.id', wanted)
      .select('u.id', trx.raw('coalesce(t.display_name, u.nombre, u.username) as name'));
    return new Map(rows.map((r: any) => [r.id as string, r.name as string]));
  }

  private async assertTeamMember(trx: Knex.Transaction, userId: string): Promise<void> {
    const m = await trx('devtools.dev_team').where({ user_id: userId, active: true }).first('user_id');
    if (!m) throw new BadRequestException('El responsable tiene que ser del equipo de desarrollo.');
  }
}

function mapRow(r: any): DevProjectRow {
  return {
    id: r.id,
    folio: r.folio,
    title: r.title,
    objective: r.objective ?? null,
    priority: r.priority,
    status: r.status,
    assignee_user_id: r.assignee_user_id ?? null,
    assignee_name: r.assignee_name ?? null,
    due_date: r.due_date ?? null,
    created_at: r.created_at instanceof Date ? r.created_at.toISOString() : r.created_at,
    created_by_username: r.created_by_username ?? null,
    updated_at: r.updated_at instanceof Date ? r.updated_at.toISOString() : r.updated_at,
    attachments_count: Number(r.attachments_count ?? 0),
    notes_count: Number(r.notes_count ?? 0),
  };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function iso(v: unknown): string {
  return v instanceof Date ? v.toISOString() : String(v);
}

function mapAttachment(a: any, url: string | null): DevProjectAttachment {
  return {
    id: a.id,
    kind: a.kind,
    source: a.source,
    file_name: a.file_name,
    mime_type: a.mime_type,
    size_bytes: Number(a.size_bytes),
    created_at: iso(a.created_at),
    created_by_username: a.created_by_username ?? null,
    note_id: a.note_id ?? null,
    url,
  };
}

/** Año calendario en hora de México: un alta del 31-dic a las 19:00 MX es de ESE año, no del siguiente. */
export function mxYear(d: Date): number {
  return Number(new Intl.DateTimeFormat('en-US', { timeZone: 'America/Mexico_City', year: 'numeric' }).format(d));
}
