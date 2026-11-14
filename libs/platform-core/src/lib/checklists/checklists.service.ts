import {
  BadRequestException, ConflictException, ForbiddenException, Injectable, Logger, NotFoundException,
} from '@nestjs/common';
import type { Knex } from 'knex';
import {
  DIAS_ENTREGA_TARDIA, avanceDe, validarHora, estadoPunto, motivoNoEntregable, tieneEvidencia, tocaEnFecha, validarPuntos,
  type AbrirEntrega, type ArchivoEvidencia, type AvanceDelEquipo, type AvanceDePersona, type AvancePuntos,
  type DetalleEntrega, type EntregarChecklist, type EstadoEntrega, type EstadoTareaDelDia,
  type FrecuenciaTarea, type GuardarPunto, type MisTareas, type MomentoTarea, type NormaTarea,
  type NuevaVersionNorma, type PuntoChecklist, type RespuestaPunto, type SubirEvidencia, type TareaDelDia,
} from '@megadulces/contracts';
import { TenantKnexService } from '../database/tenant-knex.service';
import { TenantContextService } from '../tenant/tenant-context.service';
import { ObjectStorageService } from '../storage/object-storage.service';
import { sanitizarNombre, validarAdjunto } from '../storage/attachment-signature';

/**
 * `[MDT.1.3]` `[MDT.2.*]` — El motor de checklist (Fase MDT): el manual de cada puesto, entregado con
 * evidencia. Es el ÚNICO camino que escribe en `platform.checklist_*` (migración `20261113175536`).
 *
 * ── Las reglas que hace cumplir ──────────────────────────────────────────────────────────────
 *  1. **Nadie emite la tarea del día** (D3). Lo que le toca a una persona se DERIVA al leer:
 *     norma de su puesto × versión vigente × `tocaEnFecha`. La fila de entrega nace cuando la
 *     persona la abre. Sin cron, sin «robot en el navegador».
 *  2. **Hecho = con evidencia** y **justificado no es hecho**: lo juzgan las funciones del contrato
 *     (`@megadulces/contracts/work/checklist.contract`), las mismas que usa la pantalla.
 *  3. **Cada entrega guarda la versión** de la norma con la que se juzga. Cambiar el manual agrega
 *     una versión; no mueve lo ya entregado.
 *  4. **Sólo su dueño escribe** su entrega, y sólo mientras está abierta. Un jefe la LEE si la
 *     persona está en su cadena de mando (y en su sucursal, si él tiene una).
 *  5. La evidencia se valida por FIRMA (lo que el archivo ES, no lo que dice el cliente), se sube
 *     fuera de la transacción y se borra del bucket si la base no confirma.
 *
 * El «hoy» sale de la base, en hora de México: `new Date()` es UTC y adelanta el día de noche.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FECHA = /^\d{4}-\d{2}-\d{2}$/;
const ITEM = /^[a-z0-9_-]{1,40}$/i;
const TZ = 'America/Mexico_City';
const MAX_ARCHIVOS_POR_PUNTO = 10;
const MAX_BYTES_ARCHIVO = 10 * 1048576;
const MAX_TEXTO = 2000;
const MAX_RENGLONES = 50;

interface Persona {
  id: string; nombre: string; position_code: string | null; position_name: string | null; warehouse_code: string | null;
}
interface FilaPlantilla {
  id: string; key: string; name: string; moment: MomentoTarea | null; frequency: FrecuenciaTarea;
  weekday: number | null; month_day: number | null; due_time: string; start_time: string;
  document_title: string | null; document_version: string | null; format_code: string | null;
  note: string | null; active: boolean; per_event?: boolean;
}
/** `due_time` (HH:MM) NULL = la de la plantilla. */
interface FilaVersion {
  id: string; template_id: string; version: number; valid_from: string; items: PuntoChecklist[];
  due_time: string | null; change_note: string | null;
}
interface FilaEntrega {
  id: string; template_id: string; version_id: string; period_date: string; assigned_to: string;
  due_at: Date | string; status: EstadoEntrega; responses: Record<string, RespuestaPunto>;
  employee_note: string | null; submitted_at: Date | string | null; submitted_late: boolean | null;
  position_code: string | null; warehouse_code: string | null;
}

const iso = (v: Date | string | null | undefined): string | null => (v == null ? null : new Date(v).toISOString());
const unicos = <T>(xs: T[]): T[] => xs.filter((x, i) => xs.indexOf(x) === i);
const limpio = (v: unknown, max: number): string => (typeof v === 'string' ? v.trim().slice(0, max) : '');

@Injectable()
export class ChecklistsService {
  private readonly logger = new Logger(ChecklistsService.name);

  constructor(
    private readonly tk: TenantKnexService,
    private readonly tenantCtx: TenantContextService,
    private readonly storage: ObjectStorageService,
  ) {}

  // ── Mis tareas ───────────────────────────────────────────────────────────────────────────

  /** Lo que la norma de mi puesto me pide en una fecha (hoy por omisión), exista o no la entrega. */
  async misTareas(fecha?: string): Promise<MisTareas> {
    const userId = this.requireUser();
    return this.tk.run(async (trx) => {
      const hoy = await this.hoy(trx);
      const dia = this.fechaValida(fecha ?? hoy, hoy, 31);
      const yo = await this.persona(trx, userId);
      const no_responde = [
        'los descansos por persona no existen en la Suite (son de RH): un día de descanso muestra sus tareas como pendientes',
        'las tareas que se disparan por evento (cambio de custodia, siniestro) no se derivan: no hay forma de anticiparlas',
      ];
      if (!yo.position_code) {
        return { fecha: dia, position_code: null, position_name: null, tareas: [], no_responde: ['no tienes puesto asignado: no hay norma que aplicarte', ...no_responde] };
      }
      const tareas = await this.tareasDe(trx, [yo], dia);
      return { fecha: dia, position_code: yo.position_code, position_name: yo.position_name, tareas: tareas.get(yo.id) ?? [], no_responde };
    });
  }

  /** Abre (o devuelve, si ya existe) mi entrega de una tarea para un día. Idempotente. */
  async abrir(body: AbrirEntrega): Promise<DetalleEntrega> {
    const userId = this.requireUser();
    if (!UUID.test(body?.template_id ?? '')) throw new BadRequestException('template_id inválido');
    return this.tk.run(async (trx) => {
      const hoy = await this.hoy(trx);
      const dia = this.fechaValida(body.period_date, hoy, DIAS_ENTREGA_TARDIA);
      const yo = await this.persona(trx, userId);
      if (!yo.position_code) throw new ForbiddenException('No tienes puesto asignado: no hay tareas del manual para ti.');
      const tpl = (await trx('platform.checklist_templates as t')
        .join('platform.checklist_template_positions as tp', function (this: Knex.JoinClause) {
          this.on('tp.template_id', '=', 't.id').andOn('tp.tenant_id', '=', 't.tenant_id');
        })
        .where({ 't.id': body.template_id, 'tp.position_code': yo.position_code, 't.active': true })
        .whereNull('t.deleted_at')
        .first('t.id', 't.frequency', 't.weekday', 't.month_day')) as Pick<FilaPlantilla, 'id' | 'frequency' | 'weekday' | 'month_day'> | undefined;
      if (!tpl) throw new NotFoundException('Esa tarea no es de la norma de tu puesto.');
      if (!tocaEnFecha(tpl, dia)) throw new BadRequestException(`Esa tarea no toca el ${dia}.`);
      const ver = await this.versionVigente(trx, [tpl.id], dia);
      const v = ver.get(tpl.id);
      if (!v) throw new BadRequestException(`La norma de esa tarea todavía no regía el ${dia}.`);

      const { rows: [nueva] } = await trx.raw(`
        INSERT INTO platform.checklist_runs
          (tenant_id, template_id, version_id, period_date, assigned_to, assigned_at, due_at,
           position_code, warehouse_code, created_by, updated_by)
        SELECT t.tenant_id, t.id, ?, ?::date, ?,
               ((?::date + t.start_time) AT TIME ZONE '${TZ}'),
               ((?::date + COALESCE(?::time, t.due_time)) AT TIME ZONE '${TZ}'),
               ?, ?, ?, ?
          FROM platform.checklist_templates t WHERE t.id = ?
        ON CONFLICT (tenant_id, template_id, assigned_to, period_date) DO NOTHING
        RETURNING id`,
      [v.id, dia, userId, dia, dia, v.due_time, yo.position_code, yo.warehouse_code, userId, userId, tpl.id]);
      const id = nueva?.id ?? (await trx('platform.checklist_runs')
        .where({ template_id: tpl.id, assigned_to: userId, period_date: dia }).whereNull('deleted_at').first('id'))?.id;
      if (!id) throw new ConflictException('No se pudo abrir la entrega; vuelve a intentar.');
      return this.detalleEn(trx, id, userId, false);
    });
  }

  /** Una entrega: la mía, o la de alguien de mi equipo si puedo verlo. */
  async detalle(runId: string, puedeVerEquipo: boolean): Promise<DetalleEntrega> {
    const userId = this.requireUser();
    if (!UUID.test(runId ?? '')) throw new BadRequestException('id inválido');
    return this.tk.run(async (trx) => this.detalleEn(trx, runId, userId, puedeVerEquipo));
  }

  /** Guarda lo capturado en un punto (marca, texto, renglones, monto, folio, comentario). */
  async guardarPunto(runId: string, itemId: string, body: GuardarPunto): Promise<DetalleEntrega> {
    const userId = this.requireUser();
    this.idsValidos(runId, itemId);
    return this.tk.run(async (trx) => {
      const { run, punto } = await this.miEntregaAbierta(trx, runId, userId, itemId);
      const previa: RespuestaPunto = run.responses?.[itemId] ?? {};
      const nueva: RespuestaPunto = { ...previa };
      if (body?.checked !== undefined) nueva.checked = body.checked === true;
      if (body?.text !== undefined) nueva.text = limpio(body.text, MAX_TEXTO);
      if (body?.list !== undefined) {
        if (!Array.isArray(body.list)) throw new BadRequestException('list debe ser una lista de renglones');
        if (body.list.length > MAX_RENGLONES) throw new BadRequestException(`Máximo ${MAX_RENGLONES} renglones`);
        nueva.list = body.list.map((r) => limpio(r, 300));
      }
      if (body?.amount !== undefined) {
        if (body.amount !== null && (typeof body.amount !== 'number' || !Number.isFinite(body.amount))) {
          throw new BadRequestException('amount debe ser un número');
        }
        nueva.amount = body.amount;
      }
      if (body?.folio !== undefined) nueva.folio = body.folio === null ? null : limpio(body.folio, 60);
      if (body?.comment !== undefined) nueva.comment = body.comment === null ? null : limpio(body.comment, 1000);
      const archivos = await this.archivosVivos(trx, runId, itemId);
      // El sello de «listo» lo pone el servidor, la primera vez que el punto queda con evidencia.
      nueva.done_at = tieneEvidencia(punto, nueva, archivos) ? (previa.done_at ?? new Date().toISOString()) : null;
      await trx('platform.checklist_runs').where({ id: runId })
        .update({
          responses: trx.raw(`jsonb_set(responses, ?::text[], ?::jsonb, true)`, [`{${itemId}}`, JSON.stringify(nueva)]),
          updated_at: trx.fn.now(), updated_by: userId,
        });
      return this.detalleEn(trx, runId, userId, false);
    });
  }

  /** Sube una foto o documento a un punto. Valida por firma; sube fuera de la transacción. */
  async subirEvidencia(runId: string, itemId: string, body: SubirEvidencia): Promise<DetalleEntrega> {
    const userId = this.requireUser();
    this.idsValidos(runId, itemId);
    // 1. Validar todo antes de tocar el bucket.
    const r = validarAdjunto(body?.file_base64, MAX_BYTES_ARCHIVO);
    if (!r.ok) throw new BadRequestException(r.detalle);
    const capturada = body?.captured_at && !Number.isNaN(Date.parse(body.captured_at)) ? new Date(body.captured_at).toISOString() : null;
    await this.tk.run(async (trx) => {
      const { punto } = await this.miEntregaAbierta(trx, runId, userId, itemId);
      if (punto.evidence !== 'photos') {
        throw new BadRequestException('Este punto se prueba con lo escrito, no con archivos.');
      }
      if (r.adjunto.contentType === 'application/pdf' && !punto.accepts_documents) {
        throw new BadRequestException('Este punto pide foto, no documento.');
      }
      if ((await this.archivosVivos(trx, runId, itemId)) >= MAX_ARCHIVOS_POR_PUNTO) {
        throw new BadRequestException(`Máximo ${MAX_ARCHIVOS_POR_PUNTO} archivos por punto`);
      }
    });
    // 2. Subir fuera de la transacción.
    const nombre = sanitizarNombre(body?.file_name, r.adjunto.contentType);
    const { key } = await this.storage.putBuffer(r.adjunto.buffer, r.adjunto.contentType, `checklists/${runId}`, nombre);
    // 3. Registrar; si la base no confirma, se borra del bucket.
    try {
      return await this.tk.run(async (trx) => {
        const { run, punto } = await this.miEntregaAbierta(trx, runId, userId, itemId);
        await trx('platform.checklist_run_files').insert({
          tenant_id: trx.raw('public.current_tenant_id()'), run_id: runId, item_id: itemId, storage_key: key,
          mime: r.adjunto.contentType, size_bytes: r.adjunto.sizeBytes, original_name: nombre,
          captured_at: capturada, uploaded_by: userId,
        });
        const previa: RespuestaPunto = run.responses?.[itemId] ?? {};
        if (!previa.done_at) {
          const done: RespuestaPunto = { ...previa, done_at: tieneEvidencia(punto, previa, 1) ? new Date().toISOString() : null };
          await trx('platform.checklist_runs').where({ id: runId }).update({
            responses: trx.raw(`jsonb_set(responses, ?::text[], ?::jsonb, true)`, [`{${itemId}}`, JSON.stringify(done)]),
            updated_at: trx.fn.now(), updated_by: userId,
          });
        } else {
          await trx('platform.checklist_runs').where({ id: runId }).update({ updated_at: trx.fn.now(), updated_by: userId });
        }
        return this.detalleEn(trx, runId, userId, false);
      });
    } catch (e) {
      await this.storage.remove(key).catch((err) => this.logger.warn(`No se pudo borrar ${key}: ${String(err)}`));
      throw e;
    }
  }

  /** Retira un archivo propio de una entrega abierta (soft delete: el archivo queda como rastro). */
  async retirarArchivo(runId: string, fileId: string): Promise<DetalleEntrega> {
    const userId = this.requireUser();
    if (!UUID.test(runId ?? '') || !UUID.test(fileId ?? '')) throw new BadRequestException('id inválido');
    return this.tk.run(async (trx) => {
      const f = await trx('platform.checklist_run_files').where({ id: fileId, run_id: runId }).whereNull('deleted_at').first('item_id');
      if (!f) throw new NotFoundException('Archivo no encontrado');
      const { run, punto } = await this.miEntregaAbierta(trx, runId, userId, f.item_id);
      await trx('platform.checklist_run_files').where({ id: fileId })
        .update({ deleted_at: trx.fn.now(), deleted_by: userId });
      const previa: RespuestaPunto = run.responses?.[f.item_id] ?? {};
      const quedan = await this.archivosVivos(trx, runId, f.item_id);
      if (previa.done_at && !tieneEvidencia(punto, previa, quedan)) {
        await trx('platform.checklist_runs').where({ id: runId }).update({
          responses: trx.raw(`jsonb_set(responses, ?::text[], ?::jsonb, true)`, [`{${f.item_id}}`, JSON.stringify({ ...previa, done_at: null })]),
          updated_at: trx.fn.now(), updated_by: userId,
        });
      }
      return this.detalleEn(trx, runId, userId, false);
    });
  }

  /** Entrega. Con todo hecho, o con una nota que explique lo que falta (eso queda justificado). */
  async entregar(runId: string, body: EntregarChecklist): Promise<DetalleEntrega> {
    const userId = this.requireUser();
    if (!UUID.test(runId ?? '')) throw new BadRequestException('id inválido');
    return this.tk.run(async (trx) => {
      const { run, version } = await this.miEntregaAbierta(trx, runId, userId, null);
      const nota = limpio(body?.employee_note, MAX_TEXTO) || null;
      const archivos = await this.archivosPorPunto(trx, [runId]);
      const motivo = motivoNoEntregable(version.items, run.responses ?? {}, archivos.get(runId) ?? {}, nota);
      if (motivo) throw new BadRequestException(motivo);
      await trx('platform.checklist_runs').where({ id: runId }).update({
        status: 'submitted', employee_note: nota, submitted_at: trx.fn.now(),
        submitted_late: trx.raw('now() > due_at'), updated_at: trx.fn.now(), updated_by: userId,
      });
      return this.detalleEn(trx, runId, userId, false);
    });
  }

  // ── Mi equipo ────────────────────────────────────────────────────────────────────────────

  /** El avance del día de la gente a mi cargo (cadena de mando, y mi sucursal si tengo una). */
  async equipo(fecha?: string): Promise<AvanceDelEquipo> {
    const userId = this.requireUser();
    return this.tk.run(async (trx) => {
      const hoy = await this.hoy(trx);
      const dia = this.fechaValida(fecha ?? hoy, hoy, 62);
      const yo = await this.persona(trx, userId);
      const no_responde = [
        'los descansos por persona no existen en la Suite (son de RH): quien descansa aparece con sus tareas pendientes',
        'sólo personas ACTIVAS con puesto: las invitadas sin acceso no entregan',
      ];
      if (!yo.position_code) return { fecha: dia, personas: [], no_responde: ['no tienes puesto asignado: no hay cadena de mando que recorrer', ...no_responde] };
      const gente = await this.miGente(trx, yo);
      if (!gente.length) return { fecha: dia, personas: [], no_responde };
      const tareas = await this.tareasDe(trx, gente, dia);
      const personas: AvanceDePersona[] = gente.map((p) => {
        const ts = tareas.get(p.id) ?? [];
        const puntos: AvancePuntos = { total: 0, hechos: 0, justificados: 0, sin_ejecutar: 0 };
        for (const t of ts) {
          puntos.total += t.avance.total; puntos.hechos += t.avance.hechos;
          puntos.justificados += t.avance.justificados; puntos.sin_ejecutar += t.avance.sin_ejecutar;
        }
        return {
          user_id: p.id, nombre: p.nombre, position_code: p.position_code, position_name: p.position_name,
          warehouse_code: p.warehouse_code, tareas: ts.length,
          entregadas: ts.filter((t) => t.estado === 'entregada').length,
          en_proceso: ts.filter((t) => t.estado === 'en_proceso').length,
          pendientes: ts.filter((t) => t.estado === 'pendiente').length,
          vencidas: ts.filter((t) => t.vencida).length,
          puntos,
          detalle: ts,
        };
      });
      personas.sort((a, b) => (b.vencidas - a.vencidas) || (b.pendientes - a.pendientes) || a.nombre.localeCompare(b.nombre, 'es'));
      return { fecha: dia, personas, no_responde };
    });
  }

  // ── La norma ─────────────────────────────────────────────────────────────────────────────

  /** El manual: las tareas de un puesto (o todas), con su versión vigente hoy. */
  async normas(positionCode?: string): Promise<NormaTarea[]> {
    this.requireUser();
    return this.tk.run(async (trx) => {
      const hoy = await this.hoy(trx);
      const q = trx('platform.checklist_templates as t').whereNull('t.deleted_at')
        .select('t.id', 't.key', 't.name', 't.moment', 't.frequency', 't.weekday', 't.month_day',
          trx.raw(`to_char(t.due_time, 'HH24:MI') AS due_time`), trx.raw(`to_char(t.start_time, 'HH24:MI') AS start_time`),
          't.document_title', 't.document_version',
          't.format_code', 't.note', 't.active',
          trx.raw(`COALESCE((SELECT json_agg(json_build_object('code', tp.position_code, 'name', COALESCE(p.name, tp.position_code))
                                      ORDER BY p.name)
                               FROM platform.checklist_template_positions tp
                               LEFT JOIN identity.positions p ON p.tenant_id = tp.tenant_id AND p.code = tp.position_code
                              WHERE tp.template_id = t.id), '[]'::json) AS positions`))
        .orderBy('t.key');
      if (positionCode) {
        q.whereExists(function (this: Knex.QueryBuilder) {
          this.select(trx.raw('1')).from('platform.checklist_template_positions as tp')
            .whereRaw('tp.template_id = t.id').andWhere('tp.position_code', positionCode);
        });
      }
      const filas = (await q) as (FilaPlantilla & { positions: { code: string; name: string }[] })[];
      const ver = await this.versionVigente(trx, filas.map((f) => f.id), hoy);
      return filas.filter((f) => ver.has(f.id)).map((f) => {
        const v = ver.get(f.id)!;
        return {
          template_id: f.id, key: f.key, name: f.name, moment: f.moment, frequency: f.frequency,
          weekday: f.weekday, month_day: f.month_day, due_time: v.due_time ?? f.due_time, document_title: f.document_title,
          document_version: f.document_version, format_code: f.format_code, note: f.note, active: f.active,
          positions: f.positions, version: v.version, valid_from: v.valid_from, change_note: v.change_note,
          start_time: f.start_time, puntos: v.items,
        };
      });
    });
  }

  /** Cambia los puntos de una tarea: agrega una versión, no pisa. */
  async nuevaVersion(templateId: string, body: NuevaVersionNorma): Promise<NormaTarea> {
    const userId = this.requireUser();
    if (!UUID.test(templateId ?? '')) throw new BadRequestException('id inválido');
    const error = validarPuntos(body?.items);
    if (error) throw new BadRequestException(error);
    const nota = limpio(body?.change_note, 500);
    if (!nota) throw new BadRequestException('Escribe el motivo del cambio');
    const horaPedida = body?.due_time == null || body.due_time === '' ? null : body.due_time;
    if (horaPedida !== null) {
      const e = validarHora(horaPedida);
      if (e) throw new BadRequestException(e);
    }
    const normalizados: PuntoChecklist[] = body.items.map((p) => ({
      id: p.id, label: limpio(p.label, 500), block: p.block ? limpio(p.block, 80) : null, evidence: p.evidence,
      accepts_documents: p.accepts_documents === true, requires_amount: p.requires_amount === true,
      requires_folio: p.requires_folio === true, requires_comment: p.requires_comment === true,
    }));
    await this.tk.run(async (trx) => {
      const hoy = await this.hoy(trx);
      const desde = body.valid_from ?? hoy;
      if (!FECHA.test(desde) || desde < hoy) {
        throw new BadRequestException('valid_from tiene que ser hoy o después: un cambio hacia atrás movería lo ya juzgado');
      }
      const t = (await trx('platform.checklist_templates').where({ id: templateId }).whereNull('deleted_at').forUpdate()
        .first('id', trx.raw("to_char(start_time, 'HH24:MI') AS start_time"))) as { id: string; start_time: string } | undefined;
      if (!t) throw new NotFoundException('Tarea no encontrada');
      // Sin hora pedida, la versión CONSERVA la que regía: cambiar los puntos no regresa la hora a 23:00.
      const hora = horaPedida ?? (await this.versionVigente(trx, [templateId], desde)).get(templateId)?.due_time ?? null;
      if (horaPedida !== null && horaPedida <= t.start_time) {
        throw new BadRequestException(`La hora límite tiene que ser después de las ${t.start_time}, cuando empieza el día de la tarea`);
      }
      const { rows: [m] } = await trx.raw(
        `SELECT COALESCE(max(version), 0) + 1 AS n FROM platform.checklist_template_versions WHERE template_id = ?`, [templateId]);
      await trx('platform.checklist_template_versions').insert({
        tenant_id: trx.raw('public.current_tenant_id()'), template_id: templateId, version: m.n, valid_from: desde,
        items: JSON.stringify(normalizados), change_note: nota, due_time: hora, created_by: userId,
      });
      await trx('platform.checklist_templates').where({ id: templateId }).update({ updated_at: trx.fn.now(), updated_by: userId });
    });
    const [n] = (await this.normas()).filter((x) => x.template_id === templateId);
    if (!n) throw new NotFoundException('Tarea no encontrada');
    return n;
  }

  // ── Internos ─────────────────────────────────────────────────────────────────────────────

  private requireUser(): string {
    const userId = this.tenantCtx.get()?.userId;
    if (!userId) throw new ForbiddenException('Hace falta una sesión con persona.');
    return userId;
  }

  private idsValidos(runId: string, itemId: string): void {
    if (!UUID.test(runId ?? '')) throw new BadRequestException('id inválido');
    if (!ITEM.test(itemId ?? '')) throw new BadRequestException('punto inválido');
  }

  private async hoy(trx: Knex.Transaction): Promise<string> {
    const { rows: [h] } = await trx.raw(`SELECT to_char((now() AT TIME ZONE '${TZ}')::date, 'YYYY-MM-DD') AS hoy`);
    return h.hoy as string;
  }

  /** Una fecha `AAAA-MM-DD` que no es futura ni más vieja que `maxDias`. */
  private fechaValida(fecha: string | undefined, hoy: string, maxDias: number): string {
    if (!fecha || !FECHA.test(fecha) || Number.isNaN(Date.parse(fecha))) throw new BadRequestException('fecha tiene que ser AAAA-MM-DD');
    if (fecha > hoy) throw new BadRequestException('No se adelantan tareas: la fecha no puede ser futura.');
    const dias = (Date.parse(hoy) - Date.parse(fecha)) / 86_400_000;
    if (dias > maxDias) throw new BadRequestException(`Sólo se pueden consultar o entregar los últimos ${maxDias} días.`);
    return fecha;
  }

  private async persona(trx: Knex.Transaction, userId: string): Promise<Persona> {
    const p = await trx('identity.users as u')
      .leftJoin('identity.positions as p', function (this: Knex.JoinClause) {
        this.on('p.code', '=', 'u.position_code').andOn('p.tenant_id', '=', 'u.tenant_id');
      })
      .where('u.id', userId).whereNull('u.deleted_at')
      .first('u.id', trx.raw(`COALESCE(NULLIF(btrim(u.nombre), ''), u.username) AS nombre`),
        'u.position_code', 'p.name as position_name', 'u.warehouse_code');
    if (!p) throw new ForbiddenException('Tu usuario no está en el padrón.');
    return p as Persona;
  }

  /**
   * Mi gente: personas activas cuyo puesto depende del mío en la cadena de mando
   * (`reports_to_position_code`, recursivo), y de mi sucursal si yo tengo una.
   */
  private async miGente(trx: Knex.Transaction, yo: Persona): Promise<Persona[]> {
    const { rows } = await trx.raw(`
      WITH RECURSIVE abajo AS (
        SELECT p.code FROM identity.positions p
         WHERE p.reports_to_position_code = ? AND p.deleted_at IS NULL
        UNION
        SELECT p.code FROM identity.positions p JOIN abajo a ON p.reports_to_position_code = a.code
         WHERE p.deleted_at IS NULL
      )
      SELECT u.id, COALESCE(NULLIF(btrim(u.nombre), ''), u.username) AS nombre, u.position_code,
             p.name AS position_name, u.warehouse_code
        FROM identity.users u
        JOIN abajo a ON a.code = u.position_code
        LEFT JOIN identity.positions p ON p.code = u.position_code AND p.tenant_id = u.tenant_id
       WHERE u.deleted_at IS NULL AND u.status = 'active' AND u.kind = 'interno' AND u.id <> ?
         AND (?::text IS NULL OR u.warehouse_code = ?::text)
       ORDER BY 2`, [yo.position_code, yo.id, yo.warehouse_code, yo.warehouse_code]);
    return rows as Persona[];
  }

  /** La versión que rige a una fecha, por plantilla: la de `valid_from` más reciente ≤ fecha. */
  private async versionVigente(trx: Knex.Transaction, templateIds: string[], fecha: string): Promise<Map<string, FilaVersion>> {
    if (!templateIds.length) return new Map();
    const { rows } = await trx.raw(`
      SELECT DISTINCT ON (template_id) id, template_id, version, to_char(valid_from, 'YYYY-MM-DD') AS valid_from, items,
             to_char(due_time, 'HH24:MI') AS due_time, change_note
        FROM platform.checklist_template_versions
       WHERE template_id = ANY(?::uuid[]) AND valid_from <= ?::date
       ORDER BY template_id, valid_from DESC, version DESC`, [templateIds, fecha]);
    return new Map((rows as FilaVersion[]).map((r) => [r.template_id, r]));
  }

  private async archivosVivos(trx: Knex.Transaction, runId: string, itemId: string): Promise<number> {
    const { rows: [r] } = await trx.raw(
      `SELECT count(*)::int AS n FROM platform.checklist_run_files WHERE run_id = ? AND item_id = ? AND deleted_at IS NULL`,
      [runId, itemId]);
    return r.n as number;
  }

  /** `run_id → item_id → archivos vivos`. */
  private async archivosPorPunto(trx: Knex.Transaction, runIds: string[]): Promise<Map<string, Record<string, number>>> {
    const out = new Map<string, Record<string, number>>();
    if (!runIds.length) return out;
    const { rows } = await trx.raw(`
      SELECT run_id, item_id, count(*)::int AS n FROM platform.checklist_run_files
       WHERE run_id = ANY(?::uuid[]) AND deleted_at IS NULL GROUP BY 1, 2`, [runIds]);
    for (const r of rows as { run_id: string; item_id: string; n: number }[]) {
      const m = out.get(r.run_id) ?? {};
      m[r.item_id] = r.n;
      out.set(r.run_id, m);
    }
    return out;
  }

  /**
   * Las tareas del día de varias personas, DERIVADAS: plantillas de su puesto que tocan ese día y
   * cuya norma ya regía, cruzadas con sus entregas (si las abrieron).
   */
  private async tareasDe(trx: Knex.Transaction, personas: Persona[], dia: string): Promise<Map<string, TareaDelDia[]>> {
    const out = new Map<string, TareaDelDia[]>();
    // Dedup con filter+indexOf, NO `[...new Set()]`: el bundle de la API downlevelea mal el spread de
    // un Set y el arreglo sale como `[Set]` (bc6799da, RA-PRO.38).
    const puestos = unicos(personas.map((p) => p.position_code).filter((x): x is string => !!x));
    if (!puestos.length) return out;
    const { rows: plantillas } = await trx.raw(`
      SELECT t.id, t.key, t.name, t.moment, t.frequency, t.weekday, t.month_day, t.document_title,
             t.per_event, tp.position_code,
             ((?::date + COALESCE(vv.due_time, t.due_time)) AT TIME ZONE '${TZ}') AS due_at
        FROM platform.checklist_templates t
        JOIN platform.checklist_template_positions tp ON tp.template_id = t.id AND tp.tenant_id = t.tenant_id
        -- La hora límite de la versión que rige ESE día (MDT.3.2b); sin versión, la tarea se descarta abajo.
        LEFT JOIN LATERAL (
          SELECT v.due_time FROM platform.checklist_template_versions v
           WHERE v.tenant_id = t.tenant_id AND v.template_id = t.id AND v.valid_from <= ?::date
           ORDER BY v.valid_from DESC, v.version DESC LIMIT 1) vv ON true
       WHERE tp.position_code = ANY(?::text[]) AND t.active AND t.deleted_at IS NULL
       ORDER BY due_at, t.key`, [dia, dia, puestos]);
    const aplican = (plantillas as (FilaPlantilla & { position_code: string; due_at: Date })[]).filter((t) => tocaEnFecha(t, dia));
    if (!aplican.length) return out;
    const ver = await this.versionVigente(trx, unicos(aplican.map((t) => t.id)), dia);
    const { rows: entregas } = await trx.raw(`
      SELECT r.id, r.template_id, r.version_id, r.assigned_to, r.status, r.responses, r.employee_note,
             r.submitted_late, r.due_at, v.items
        FROM platform.checklist_runs r
        JOIN platform.checklist_template_versions v ON v.id = r.version_id
       WHERE r.period_date = ?::date AND r.assigned_to = ANY(?::uuid[]) AND r.deleted_at IS NULL`,
    [dia, personas.map((p) => p.id)]);
    const porClave = new Map<string, FilaEntrega & { items: PuntoChecklist[] }>();
    for (const e of entregas as (FilaEntrega & { items: PuntoChecklist[] })[]) porClave.set(`${e.assigned_to}|${e.template_id}`, e);
    const archivos = await this.archivosPorPunto(trx, (entregas as { id: string }[]).map((e) => e.id));
    const ahora = Date.now();

    for (const p of personas) {
      const lista: TareaDelDia[] = [];
      for (const t of aplican) {
        if (t.position_code !== p.position_code) continue;
        const e = porClave.get(`${p.id}|${t.id}`);
        const v = ver.get(t.id);
        // Sin versión vigente ese día la norma no existía: no se le pide (y no se inventa un pendiente).
        if (!e && !v) continue;
        const puntos = e ? e.items : v!.items;
        const avance = avanceDe(puntos, e?.responses ?? {}, e ? archivos.get(e.id) ?? {} : {}, e ?? {});
        const estado: EstadoTareaDelDia = !e ? 'pendiente'
          : e.status === 'submitted' ? 'entregada' : e.status === 'cancelled' ? 'cancelada' : 'en_proceso';
        const dueAt = new Date(e ? e.due_at : t.due_at);
        lista.push({
          template_id: t.id, key: t.key, name: t.name, moment: t.moment, frequency: t.frequency, period_date: dia,
          due_at: dueAt.toISOString(), vencida: (estado === 'pendiente' || estado === 'en_proceso') && ahora > dueAt.getTime(),
          document_title: t.document_title, per_event: t.per_event === true, run_id: e?.id ?? null, estado, avance,
          submitted_late: e?.submitted_late ?? null,
        });
      }
      out.set(p.id, lista);
    }
    return out;
  }

  /** Mi entrega, abierta, con su versión; y el punto pedido si se nombra. 404/403/409 si no aplica. */
  private async miEntregaAbierta(trx: Knex.Transaction, runId: string, userId: string, itemId: string | null): Promise<{
    run: FilaEntrega; version: FilaVersion; punto: PuntoChecklist;
  }> {
    const run = (await trx('platform.checklist_runs').where({ id: runId }).whereNull('deleted_at').forUpdate().first()) as FilaEntrega | undefined;
    if (!run) throw new NotFoundException('Entrega no encontrada');
    if (run.assigned_to !== userId) throw new ForbiddenException('Sólo su dueño puede escribir en esta entrega.');
    if (run.status !== 'in_progress') throw new ConflictException('La entrega ya se cerró: no se puede cambiar.');
    const version = (await trx('platform.checklist_template_versions').where({ id: run.version_id })
      .first('id', 'template_id', 'version', 'items')) as FilaVersion;
    const punto = itemId ? version.items.find((p) => p.id === itemId) : version.items[0];
    if (!punto) throw new NotFoundException('Ese punto no está en la norma de esta entrega.');
    return { run, version, punto };
  }

  private async detalleEn(trx: Knex.Transaction, runId: string, userId: string, puedeVerEquipo: boolean): Promise<DetalleEntrega> {
    const { rows: [r] } = await trx.raw(`
      SELECT r.id, r.template_id, r.version_id, to_char(r.period_date, 'YYYY-MM-DD') AS period_date, r.assigned_to,
             r.due_at, r.status, r.responses, r.employee_note, r.submitted_at, r.submitted_late,
             t.name, t.document_title, t.document_version, t.format_code, t.note,
             v.version, v.items,
             COALESCE(NULLIF(btrim(u.nombre), ''), u.username) AS assigned_name
        FROM platform.checklist_runs r
        JOIN platform.checklist_templates t ON t.id = r.template_id
        JOIN platform.checklist_template_versions v ON v.id = r.version_id
        LEFT JOIN identity.users u ON u.id = r.assigned_to AND u.tenant_id = r.tenant_id
       WHERE r.id = ? AND r.deleted_at IS NULL`, [runId]);
    if (!r) throw new NotFoundException('Entrega no encontrada');
    if (r.assigned_to !== userId) {
      const yo = await this.persona(trx, userId);
      const mia = puedeVerEquipo && yo.position_code
        ? (await this.miGente(trx, yo)).some((p) => p.id === r.assigned_to)
        : false;
      // 404 y no 403: no se confirma que exista la entrega de alguien fuera de tu cadena.
      if (!mia) throw new NotFoundException('Entrega no encontrada');
    }
    const { rows: archivos } = await trx.raw(`
      SELECT id, item_id, storage_key, mime, size_bytes, original_name, captured_at, created_at
        FROM platform.checklist_run_files WHERE run_id = ? AND deleted_at IS NULL ORDER BY created_at`, [runId]);
    const porPunto = new Map<string, ArchivoEvidencia[]>();
    for (const a of archivos as (ArchivoEvidencia & { storage_key: string })[]) {
      const lista = porPunto.get(a.item_id) ?? [];
      lista.push({
        id: a.id, item_id: a.item_id, mime: a.mime, size_bytes: a.size_bytes, original_name: a.original_name,
        captured_at: iso(a.captured_at), created_at: iso(a.created_at) as string,
        url: await this.storage.signedUrl(a.storage_key, 600),
      });
      porPunto.set(a.item_id, lista);
    }
    const items = r.items as PuntoChecklist[];
    const responses = (r.responses ?? {}) as Record<string, RespuestaPunto>;
    const cuenta: Record<string, number> = {};
    porPunto.forEach((v, k) => { cuenta[k] = v.length; });
    return {
      id: r.id, template_id: r.template_id, name: r.name, document_title: r.document_title,
      document_version: r.document_version, format_code: r.format_code, note: r.note, version: r.version,
      period_date: r.period_date, due_at: iso(r.due_at) as string, status: r.status, employee_note: r.employee_note,
      submitted_at: iso(r.submitted_at), submitted_late: r.submitted_late, assigned_to: r.assigned_to,
      assigned_name: r.assigned_name, editable: r.assigned_to === userId && r.status === 'in_progress',
      puntos: items.map((p) => ({
        ...p, respuesta: responses[p.id] ?? {}, archivos: porPunto.get(p.id) ?? [],
        estado: estadoPunto(p, responses[p.id], porPunto.get(p.id)?.length ?? 0, r),
      })),
      avance: avanceDe(items, responses, cuenta, r),
    };
  }
}
