/**
 * `[MS.2.3]` La Mesa de Servicio: el ciclo de vida del ticket. ADR-081.
 *
 * Todo lo que MUEVE un ticket pasa por `moverEstado`, que es la única función que escribe `status`. Ahí se
 * juntan las tres protecciones: la máquina de estados (`domain/request-state`: QUIÉN puede ir de dónde a
 * dónde), el reloj del SLA (`domain/sla`: pausar, reanudar, empujar plazos) y los CHECK de la base (el
 * último muro: un ticket «asignado» sin asignado se rechaza aunque este código se equivoque).
 *
 * Reglas de visibilidad (las que el solicitante NO puede romper desde la API):
 *   · Quien no atiende y no es el solicitante recibe 404, no 403: no se confirma que el folio existe.
 *   · El hilo se filtra en el servidor: las notas internas y los adjuntos colgados de ellas no salen.
 *   · `time_logged_minutes` sólo lo ve quien atiende.
 *   · La prioridad la cambia quien atiende; el solicitante no puede subirla para saltarse la fila.
 */
import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, Logger, NotFoundException, Optional } from '@nestjs/common';
import type { Knex } from 'knex';
import {
  BITACORA_PORT,
  SD_IMPACTS,
  SD_PRIORITIES,
  SD_STATUSES,
  type SdActor,
  type SdAssignDto,
  type SdAttachmentDto,
  type SdChangePriorityDto,
  type SdChangeStatusDto,
  type SdChannel,
  type SdCloseReason,
  type SdCreateRequestDto,
  type SdImpact,
  type SdListResponse,
  type SdLogTimeDto,
  type SdMessageDto,
  type SdMessageKind,
  type SdPostMessageDto,
  type SdPriority,
  type SdRequestDetail,
  type SdRequestRow,
  type SdSlaView,
  type SdStatsResponse,
  type SdStatus,
  type SdVisibility,
  type BitacoraPort,
  type BitacoraTicketEvent,
} from '@megadulces/contracts';
import { KEPLER_BRANCH_NAMES, TenantContextService, TenantKnexService, applySmartSearch, branchName, toMxDateKey } from '@megadulces/platform-core';
import { ServiceDeskAgentsService } from './agents.service';
import { ServiceDeskRoutingService } from './routing.service';
import { ServiceDeskAttachmentsService, type AdjuntoSubido } from './attachments.service';
import { efectosDe, motivoDeCierre, puedeTransicionar, TRANSICIONES } from './domain/request-state';
import { formatFolio } from './domain/folio';
import { puedeCambiarPrioridad, sugerirPrioridad } from './domain/priority';
import { evaluarSla, plazosIniciales, plazosTrasCambioDePrioridad, reanudarTrasPausa } from './domain/sla';
import type { SdEventoClave } from './domain/notice';
import { ServiceDeskNotificationsService, type SdEvento } from './notifications.service';
import { ServiceDeskConfigService, type SdConfig } from './service-desk-config.service';
import type { ActorCtx } from './service-desk.types';

/** La fila de `servicedesk.requests` (y lo que `base()` le junta). `pg` entrega `timestamptz` como `Date`. */
interface RequestRow {
  id: string;
  tenant_id: string;
  folio: string;
  queue_id: string;
  category_id: string;
  title: string;
  description: string;
  priority: SdPriority;
  priority_suggested: SdPriority | null;
  impact: SdImpact;
  blocks_work: boolean;
  status: SdStatus;
  requester_id: string;
  requester_name: string | null;
  requester_department_code: string | null;
  requester_position_code: string | null;
  warehouse_code: string | null;
  channel: SdChannel;
  created_by: string | null;
  assigned_to: string | null;
  assigned_by: string | null;
  assigned_at: Date | null;
  due_at: Date | null;
  first_response_due_at: Date | null;
  first_responded_at: Date | null;
  paused_at: Date | null;
  paused_minutes: number;
  sla_first_breached_at: Date | null;
  sla_resolution_breached_at: Date | null;
  resolved_at: Date | null;
  resolution_note: string | null;
  closed_at: Date | null;
  close_reason: SdCloseReason | null;
  reopened_count: number;
  created_at: Date;
  updated_at: Date;
  // Lo que agrega el JOIN de `base()`:
  queue_name?: string | null;
  category_name?: string | null;
  assigned_nombre?: string | null;
  assigned_username?: string | null;
}

interface MessageRow {
  id: string;
  kind: SdMessageKind;
  visibility: SdVisibility;
  author_id: string | null;
  author_label: string | null;
  body: string;
  meta: Record<string, unknown> | null;
  created_at: Date;
}

interface AttachmentRow {
  id: string;
  message_id: string | null;
  file_name: string;
  content_type: string;
  size_bytes: string | number;
  storage_key: string;
  created_at: Date;
}

type Patch = Record<string, unknown>;

/** Quien provoca un cambio. El SISTEMA (auto-cierre) no es una persona: no tiene `userId`. */
export interface Autor {
  userId: string | null;
  nombre: string;
}
export const SISTEMA: Autor = { userId: null, nombre: 'Sistema' };

/** Lo que una operación provoca FUERA de su transacción: avisos a personas y el espejo hacia la Bitácora. */
export interface Efectos {
  avisos: SdEvento[];
  bitacora: BitacoraTicketEvent[];
}
export const sinEfectos = (): Efectos => ({ avisos: [], bitacora: [] });
export const juntar = (a: Efectos, b: Efectos): Efectos => ({ avisos: [...a.avisos, ...b.avisos], bitacora: [...a.bitacora, ...b.bitacora] });

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ABIERTOS: SdStatus[] = ['nuevo', 'asignado', 'en_proceso', 'en_espera'];
const FINALES: SdStatus[] = ['cerrado', 'cancelado'];
const MAX_TITULO = 200;
const MAX_TEXTO = 5000;
const CARPETA = 'service-desk/requests';

const iso = (d: Date | string | null | undefined): string | null => (d ? new Date(d).toISOString() : null);
const esUuid = (v: unknown): v is string => typeof v === 'string' && UUID_RE.test(v);

@Injectable()
export class ServiceDeskRequestsService {
  private readonly logger = new Logger(ServiceDeskRequestsService.name);

  constructor(
    private readonly tk: TenantKnexService,
    private readonly tenantCtx: TenantContextService,
    private readonly cfg: ServiceDeskConfigService,
    private readonly att: ServiceDeskAttachmentsService,
    private readonly agents: ServiceDeskAgentsService,
    private readonly routing: ServiceDeskRoutingService,
    private readonly notifs: ServiceDeskNotificationsService,
    @Optional() @Inject(BITACORA_PORT) private readonly bitacora?: BitacoraPort,
  ) {}

  // ───────────────────────────── alta ─────────────────────────────

  async create(ctx: ActorCtx, dto: SdCreateRequestDto): Promise<SdRequestDetail> {
    const title = String(dto?.title ?? '').trim();
    const description = String(dto?.description ?? '').trim();
    if (!title) throw new BadRequestException('Escribe un título para la solicitud');
    if (title.length > MAX_TITULO) throw new BadRequestException(`El título admite hasta ${MAX_TITULO} caracteres`);
    if (description.length > MAX_TEXTO) throw new BadRequestException(`La descripción admite hasta ${MAX_TEXTO} caracteres`);
    if (!esUuid(dto?.category_id)) throw new BadRequestException('category_id inválido');
    const impact = dto.impact ?? 'yo';
    if (!SD_IMPACTS.includes(impact)) throw new BadRequestException(`impact debe ser uno de: ${SD_IMPACTS.join(', ')}`);
    if (dto.blocks_work !== undefined && typeof dto.blocks_work !== 'boolean') throw new BadRequestException('blocks_work debe ser verdadero o falso');
    const blocksWork = dto.blocks_work === true;
    const warehouse = this.normalizarSucursal(dto.warehouse_code);

    /*
     * `[MS.3.11]` Levantar a nombre de otra persona: sólo quien atiende. Se rechaza ANTES de subir adjuntos al
     * bucket, no después: un 403 que ya escribió objetos sería basura. Pedir `requester_id` propio equivale a no
     * pedirlo (lo de siempre); lo que no se permite a nadie más es poner a OTRA persona o cambiar el área.
     */
    const pidioOtro = typeof dto?.requester_id === 'string' && dto.requester_id !== '' && dto.requester_id !== ctx.userId;
    const pidioArea = typeof dto?.department_code === 'string' && dto.department_code.trim() !== '';
    if ((pidioOtro || pidioArea) && !ctx.esAgente) {
      throw new ForbiddenException('Sólo quien atiende puede levantar una solicitud a nombre de otra persona o indicar su área');
    }
    if (dto?.requester_id !== undefined && dto.requester_id !== null && dto.requester_id !== '' && !esUuid(dto.requester_id)) {
      throw new BadRequestException('requester_id inválido');
    }

    // 1) Lo que hace falta para validar adjuntos (tope de tamaño) — antes de tocar el bucket.
    const settings = (await this.tk.run((trx) => this.cfg.load(trx))).settings;
    const preparados = this.att.preparar(dto.attachments, settings.maxAttachmentBytes);
    const subidos: AdjuntoSubido[] = preparados.length ? await this.att.subir(preparados, CARPETA) : [];

    // 2) Un solo bloque transaccional: folio + ticket + hilo + adjuntos. Si algo falla, nada queda a medias.
    try {
      const { id, efectos } = await this.tk.run(async (trx) => {
        const config = await this.cfg.load(trx);
        const cat = await trx('servicedesk.categories as c')
          .join('servicedesk.queues as q', function () {
            this.on('q.tenant_id', 'c.tenant_id').andOn('q.id', 'c.queue_id');
          })
          .where('c.id', dto.category_id)
          .where({ 'c.active': true, 'q.active': true })
          .whereNull('c.deleted_at')
          .first('c.id', 'c.queue_id', 'c.default_priority', 'c.requires_branch');
        if (!cat) throw new BadRequestException('La categoría no existe o no está disponible');
        if (cat.requires_branch && !warehouse) throw new BadRequestException('Esta categoría exige indicar la sucursal');

        // El solicitante es quien llama, salvo que quien atiende haya indicado a otra persona.
        const solicitanteId = pidioOtro ? (dto.requester_id as string) : ctx.userId;
        const me = await trx('identity.users')
          .where({ id: solicitanteId })
          .whereNull('deleted_at')
          .modify((qb) => {
            if (pidioOtro) qb.whereRaw(`COALESCE(kind, 'interno') <> 'servicio'`).whereRaw(`role_name NOT LIKE 'retirado%'`);
          })
          .first('id', 'nombre', 'username', 'department_code', 'position_code');
        if (pidioOtro && !me) throw new BadRequestException('La persona indicada no existe o no puede figurar como solicitante');
        // El área: la que indicó quien atiende (validada contra el catálogo) o, si no, la de la ficha.
        let departamento: string | null = me?.department_code ?? null;
        if (pidioArea) {
          const d = await trx('identity.departments').where({ code: (dto.department_code as string).trim() }).whereNull('deleted_at').first('code');
          if (!d) throw new BadRequestException('El área indicada no existe');
          departamento = d.code;
        }
        const nombreSolicitante = me?.nombre || me?.username || ctx.nombre;
        const now = new Date();
        const priority = sugerirPrioridad({ defaultPriority: cat.default_priority, impact, blocksWork });
        const politica = config.policies[priority];
        if (!politica) throw new ConflictException(`No hay política de SLA configurada para la prioridad «${priority}»`);
        const plazos = plazosIniciales(now, politica, config.settings.calendar);

        const tenantId = this.tenantCtx.requireTenantId();
        const year = Number(toMxDateKey(now).slice(0, 4));
        const folio = await this.siguienteFolio(trx, tenantId, year);

        const [{ id }] = await trx('servicedesk.requests')
          .insert({
            tenant_id: tenantId,
            folio,
            queue_id: cat.queue_id,
            category_id: cat.id,
            title,
            description,
            priority,
            priority_suggested: priority,
            impact,
            blocks_work: blocksWork,
            status: 'nuevo',
            requester_id: solicitanteId,
            requester_name: nombreSolicitante,
            requester_department_code: departamento,
            requester_position_code: me?.position_code ?? null,
            warehouse_code: warehouse,
            channel: 'web',
            due_at: plazos.due_at,
            first_response_due_at: plazos.first_response_due_at,
            created_by: ctx.userId,
            updated_by: ctx.userId,
          })
          .returning('id');

        const msgId = await this.addMessage(trx, tenantId, id, {
          kind: 'system',
          authorId: ctx.userId,
          authorLabel: ctx.nombre,
          body: pidioOtro ? `Solicitud levantada por ${ctx.nombre} a nombre de ${nombreSolicitante}` : 'Solicitud creada',
          meta: { priority, impact, blocks_work: blocksWork, ...(pidioOtro ? { opened_on_behalf: true, opened_by: ctx.userId, requester_id: solicitanteId } : {}) },
        });
        await this.insertAdjuntos(trx, tenantId, id, msgId, ctx.userId, subidos);

        let efectos: Efectos = { avisos: [], bitacora: [{ tenantId, requestId: id, folio, event: 'created', status: 'nuevo', assignedTo: null }] };
        // A quien no la reportó se le avisa que existe (si no, le llegarían los «resuelto» de algo que no conocía).
        if (pidioOtro) efectos.avisos.push({ event: 'levantada', request_id: id, folio, title, priority, recipients: [solicitanteId], actor_id: ctx.userId, actor_name: ctx.nombre });

        /*
         * `[MS.3.10]` Asignación AUTOMÁTICA: la primera regla que aplica (por categoría o por una palabra clave de lo
         * que escribió la persona). Va DENTRO de la misma transacción del alta: el ticket nace ya asignado o no
         * nace — nunca queda «nuevo» un instante en que otra persona pueda tomarlo y pelearse con la regla.
         * Si la regla gana pero su destino no puede atender, el ticket queda SIN asignar y una nota interna lo dice.
         */
        const destino = await this.routing.resolver(trx, { title, description, categoryId: cat.id });
        let asignadoA: string | null = null;
        if (destino?.asignable) {
          const row = await this.bloquear(trx, id);
          if (row) {
            const m = destino.resultado.motivo;
            efectos = juntar(
              efectos,
              await this.asignarA(trx, row, destino.resultado.regla.assignee_id, SISTEMA, now, null, {
                automatico: true,
                meta: { auto: true, rule_id: destino.resultado.regla.id, rule_name: destino.resultado.regla.name, reason: m.tipo === 'categoria' ? 'category' : 'keyword', keyword: m.tipo === 'palabra' ? m.palabra : null },
              }),
            );
            asignadoA = destino.resultado.regla.assignee_id;
          }
        } else if (destino) {
          await this.addMessage(trx, tenantId, id, {
            kind: 'system',
            visibility: 'internal',
            authorId: null,
            authorLabel: 'Sistema',
            body: `Asignación automática omitida: la regla «${destino.resultado.regla.name}» apunta a ${destino.assigneeName ?? 'una persona que ya no existe'}, que hoy no puede atender solicitudes de la Mesa de Servicio. Queda sin asignar.`,
            meta: { auto: true, skipped: true, rule_id: destino.resultado.regla.id },
          });
        }

        // Lo urgente y lo alto no pueden esperar a que alguien abra la bandeja: se avisa a quien atiende
        // (menos a quien la regla ya le asignó el ticket, que recibe su propio aviso de asignación).
        if (priority === 'alta' || priority === 'urgente') {
          const agentes = (await this.agents.listIn(trx)).map((a) => a.user_id).filter((u) => u !== asignadoA);
          if (agentes.length) efectos.avisos.push({ event: 'nuevo_prioritario', request_id: id, folio, title, priority, recipients: agentes, actor_id: ctx.userId, actor_name: ctx.nombre });
        }
        return { id: id as string, efectos };
      });
      await this.despachar(efectos);
      return await this.detail(ctx, id);
    } catch (e) {
      await this.att.descartar(subidos);
      throw e;
    }
  }

  // ───────────────────────────── lecturas ─────────────────────────────

  /** «Mis solicitudes»: sólo las que reportó quien llama. */
  async listMine(ctx: ActorCtx, q: { scope?: string; limit?: number; offset?: number; search?: string }): Promise<SdListResponse> {
    return this.tk.run(async (trx) => {
      const config = await this.cfg.load(trx);
      const qb = this.base(trx).where('r.requester_id', ctx.userId);
      const scope = q.scope ?? 'open';
      if (scope === 'open') qb.whereNotIn('r.status', FINALES);
      else if (scope === 'closed') qb.whereIn('r.status', FINALES);
      else if (scope !== 'all') throw new BadRequestException('scope debe ser open, closed o all');
      this.buscar(qb, q.search);
      qb.orderBy('r.created_at', 'desc');
      return this.paginar(qb, config, q.limit, q.offset);
    });
  }

  /** La bandeja de quien atiende. Orden: prioridad → vencimiento → antigüedad. */
  async inbox(
    ctx: ActorCtx,
    q: { scope?: string; queue_id?: string; priority?: string; status?: string; warehouse_code?: string; search?: string; limit?: number; offset?: number },
  ): Promise<SdListResponse> {
    if (!ctx.esAgente) throw new ForbiddenException('La bandeja es para quien atiende solicitudes');
    return this.tk.run(async (trx) => {
      const config = await this.cfg.load(trx);
      const qb = this.base(trx);
      switch (q.scope ?? 'open') {
        case 'unassigned':
          qb.where('r.status', 'nuevo').whereNull('r.assigned_to');
          break;
        case 'mine':
          qb.where('r.assigned_to', ctx.userId).whereIn('r.status', ['asignado', 'en_proceso', 'en_espera']);
          break;
        case 'waiting':
          qb.where('r.status', 'en_espera');
          break;
        case 'resolved':
          qb.where('r.status', 'resuelto');
          break;
        case 'open':
          qb.whereIn('r.status', ABIERTOS);
          break;
        case 'all':
          break;
        default:
          throw new BadRequestException('scope debe ser unassigned, mine, waiting, resolved, open o all');
      }
      if (q.queue_id) {
        if (!esUuid(q.queue_id)) throw new BadRequestException('queue_id inválido');
        qb.where('r.queue_id', q.queue_id);
      }
      if (q.priority) {
        if (!SD_PRIORITIES.includes(q.priority as SdPriority)) throw new BadRequestException('priority inválida');
        qb.where('r.priority', q.priority);
      }
      if (q.status) {
        if (!SD_STATUSES.includes(q.status as SdStatus)) throw new BadRequestException('status inválido');
        qb.where('r.status', q.status);
      }
      if (q.warehouse_code) qb.where('r.warehouse_code', q.warehouse_code);
      this.buscar(qb, q.search);
      qb.orderByRaw(`CASE r.priority WHEN 'urgente' THEN 0 WHEN 'alta' THEN 1 WHEN 'media' THEN 2 ELSE 3 END`)
        .orderByRaw('r.due_at ASC NULLS LAST')
        .orderBy('r.created_at', 'asc');
      return this.paginar(qb, config, q.limit, q.offset);
    });
  }

  async detail(ctx: ActorCtx, id: string): Promise<SdRequestDetail> {
    if (!esUuid(id)) throw new NotFoundException('Solicitud no encontrada');
    return this.tk.run(async (trx) => {
      const config = await this.cfg.load(trx);
      const r = await this.base(trx).where('r.id', id).first();
      if (!r || !this.puedeVer(r, ctx)) throw new NotFoundException('Solicitud no encontrada');

      const msgs = await trx('servicedesk.request_messages')
        .where({ request_id: id })
        .modify((qb) => {
          if (!ctx.esAgente) qb.where('visibility', 'public');
        })
        .orderBy('created_at', 'asc')
        .select('id', 'kind', 'visibility', 'author_id', 'author_label', 'body', 'meta', 'created_at');

      const adj = await trx('servicedesk.request_attachments as a')
        .leftJoin('servicedesk.request_messages as m', function () {
          this.on('m.tenant_id', 'a.tenant_id').andOn('m.id', 'a.message_id');
        })
        .where('a.request_id', id)
        .modify((qb) => {
          if (!ctx.esAgente) qb.where((w) => w.whereNull('a.message_id').orWhere('m.visibility', 'public'));
        })
        .orderBy('a.created_at', 'asc')
        .select('a.id', 'a.message_id', 'a.file_name', 'a.content_type', 'a.size_bytes', 'a.storage_key', 'a.created_at');

      let logged: number | null = null;
      if (ctx.esAgente) {
        const t = await trx('servicedesk.work_log').where({ request_id: id }).sum({ m: 'minutes' }).first();
        logged = Number(t?.m ?? 0);
      }

      // `[MS.3.11]` El nombre del área y, si la abrió otra persona a nombre del solicitante, quién.
      const dep = r.requester_department_code ? await trx('identity.departments').where({ code: r.requester_department_code }).first('name') : null;
      const departamentoNombre: string | null = dep?.name ?? null;
      let abiertaPor: string | null = null;
      if (r.created_by && r.created_by !== r.requester_id) {
        const c = await trx('identity.users').where({ id: r.created_by }).first('nombre', 'username');
        abiertaPor = c ? c.nombre || c.username : null;
      }

      const attachments: SdAttachmentDto[] = await Promise.all(
        (adj as AttachmentRow[]).map(async (a) => ({
          id: a.id,
          message_id: a.message_id ?? null,
          file_name: a.file_name,
          content_type: a.content_type,
          size_bytes: Number(a.size_bytes),
          url: await this.att.firmar(a.storage_key),
          created_at: iso(a.created_at) as string,
        })),
      );

      return {
        ...this.mapRow(r, config),
        description: r.description,
        requester_department_code: r.requester_department_code ?? null,
        requester_department_name: departamentoNombre,
        opened_by_name: abiertaPor,
        requester_position_code: r.requester_position_code ?? null,
        channel: r.channel,
        resolved_at: iso(r.resolved_at),
        resolution_note: r.resolution_note ?? null,
        closed_at: iso(r.closed_at),
        close_reason: r.close_reason ?? null,
        reopened_count: Number(r.reopened_count),
        messages: (msgs as MessageRow[]).map((m): SdMessageDto => ({ id: m.id, kind: m.kind, visibility: m.visibility, author_id: m.author_id ?? null, author_label: m.author_label ?? null, body: m.body, meta: m.meta ?? {}, created_at: iso(m.created_at) as string })),
        attachments,
        time_logged_minutes: logged,
      };
    });
  }

  /** Tablero de la coordinación. */
  async stats(ctx: ActorCtx): Promise<SdStatsResponse> {
    if (!ctx.esAgente) throw new ForbiddenException('El tablero es para quien atiende solicitudes');
    return this.tk.run(async (trx) => {
      const rows: { status: SdStatus; priority: SdPriority; n: string | number }[] = await trx('servicedesk.requests')
        .whereNull('deleted_at')
        .whereNotIn('status', FINALES)
        .select('status', 'priority')
        .count({ n: '*' })
        .groupBy('status', 'priority');
      const by_status: SdStatsResponse['by_status'] = {};
      const by_priority: SdStatsResponse['by_priority'] = {};
      let open_total = 0;
      for (const r of rows) {
        const n = Number(r.n);
        open_total += n;
        by_status[r.status as SdStatus] = (by_status[r.status as SdStatus] ?? 0) + n;
        by_priority[r.priority as SdPriority] = (by_priority[r.priority as SdPriority] ?? 0) + n;
      }
      const un = await trx('servicedesk.requests').whereNull('deleted_at').where('status', 'nuevo').whereNull('assigned_to').count({ n: '*' }).first();
      // Los contadores salen de las marcas que deja el barrido del SLA (idempotentes), no de recalcular acá.
      const br = await trx('servicedesk.requests')
        .whereNull('deleted_at')
        .whereNotIn('status', FINALES)
        .select(
          trx.raw('count(*) FILTER (WHERE sla_first_breached_at IS NOT NULL)::int AS primera'),
          trx.raw('count(*) FILTER (WHERE sla_resolution_breached_at IS NOT NULL)::int AS resolucion'),
        )
        .first();
      return {
        open_total,
        unassigned: Number(un?.n ?? 0),
        first_response_breached: Number(br?.primera ?? 0),
        resolution_breached: Number(br?.resolucion ?? 0),
        by_status,
        by_priority,
      };
    });
  }

  // ───────────────────────────── el hilo ─────────────────────────────

  async postMessage(ctx: ActorCtx, id: string, dto: SdPostMessageDto): Promise<SdRequestDetail> {
    const body = String(dto?.body ?? '').trim();
    if (!body) throw new BadRequestException('Escribe el mensaje');
    if (body.length > MAX_TEXTO) throw new BadRequestException(`El mensaje admite hasta ${MAX_TEXTO} caracteres`);
    const visibility = dto.visibility ?? 'public';
    if (visibility !== 'public' && visibility !== 'internal') throw new BadRequestException('visibility debe ser public o internal');
    if (visibility === 'internal' && !ctx.esAgente) throw new ForbiddenException('Sólo quien atiende puede dejar notas internas');
    if (!esUuid(id)) throw new NotFoundException('Solicitud no encontrada');

    const settings = (await this.tk.run((trx) => this.cfg.load(trx))).settings;
    /*
     * `[MS.3.13]` Una nota INTERNA admite adjuntos (la evidencia que sube quien atiende no siempre es para quien
     * reportó: la foto de un equipo ajeno, una captura de un log, un documento del proveedor). Es seguro porque la
     * privacidad NO descansa en esta línea sino en la LECTURA: `detail` sólo entrega a quien reporta los adjuntos de
     * mensajes públicos o sin mensaje, así que el adjunto de una nota interna ni se lista ni recibe URL firmada para
     * él. Antes se rechazaba aquí por prudencia; una regla de «no se puede» que protege algo que otra capa ya protege
     * sólo le quita al agente su evidencia. Sigue siendo sólo para quien atiende (arriba: 403 al solicitante).
     */
    const preparados = this.att.preparar(dto.attachments, settings.maxAttachmentBytes);
    const subidos: AdjuntoSubido[] = preparados.length ? await this.att.subir(preparados, CARPETA) : [];

    let efectos = sinEfectos();
    try {
      efectos = await this.tk.run(async (trx) => {
        let fx = sinEfectos();
        const config = await this.cfg.load(trx);
        const r = await this.bloquear(trx, id);
        if (!r || !this.puedeVer(r, ctx)) throw new NotFoundException('Solicitud no encontrada');
        if (FINALES.includes(r.status)) throw new ConflictException('La solicitud ya está cerrada: no admite más mensajes');
        const tenantId = r.tenant_id as string;
        const now = new Date();
        const comoSolicitante = r.requester_id === ctx.userId;
        const atiende = ctx.esAgente && !comoSolicitante;

        const msgId = await this.addMessage(trx, tenantId, id, {
          kind: visibility === 'internal' ? 'internal_note' : 'comment',
          visibility,
          authorId: ctx.userId,
          authorLabel: ctx.nombre,
          body,
        });
        await this.insertAdjuntos(trx, tenantId, id, msgId, ctx.userId, subidos);

        // La primera respuesta PÚBLICA de quien atiende cuenta para el SLA; una nota interna no.
        if (atiende && visibility === 'public' && !r.first_responded_at) {
          await trx('servicedesk.requests').where({ id }).update({ first_responded_at: now, updated_at: now, updated_by: ctx.userId });
        }
        // El solicitante que contesta reanuda un ticket que estaba esperándolo a él.
        if (comoSolicitante && visibility === 'public' && r.status === 'en_espera') {
          fx = juntar(fx, await this.moverEstado(trx, config, r, 'en_proceso', ['requester'], ctx, now, 'El solicitante respondió'));
        }
        // Un mensaje PÚBLICO le avisa a la otra parte. Una nota interna no avisa a nadie: no sale del equipo.
        if (visibility === 'public') {
          const destino = comoSolicitante ? r.assigned_to : r.requester_id;
          if (destino) fx.avisos.push(this.evento(r, 'comentario', [destino], ctx, { extracto: body, discriminador: msgId }));
        }
        return fx;
      });
    } catch (e) {
      await this.att.descartar(subidos);
      throw e;
    }
    await this.despachar(efectos);
    return this.detail(ctx, id);
  }

  // ───────────────────────────── estado ─────────────────────────────

  async changeStatus(ctx: ActorCtx, id: string, dto: SdChangeStatusDto): Promise<SdRequestDetail> {
    const to = dto?.status;
    if (!SD_STATUSES.includes(to)) throw new BadRequestException(`status debe ser uno de: ${SD_STATUSES.join(', ')}`);
    // `asignado` lo fija una asignación, no un cambio de estado: sin asignado el CHECK lo rechazaría.
    if (to === 'asignado') throw new BadRequestException('Para asignar usa «tomar» o «asignar»');
    return this.moverPorId(ctx, id, to, dto.note);
  }

  confirm(ctx: ActorCtx, id: string, note?: string): Promise<SdRequestDetail> {
    return this.moverPorId(ctx, id, 'cerrado', note);
  }

  reopen(ctx: ActorCtx, id: string, note?: string): Promise<SdRequestDetail> {
    return this.moverPorId(ctx, id, 'en_proceso', note, { exigirNota: 'Cuéntanos qué sigue sin funcionar para reabrir la solicitud' });
  }

  cancel(ctx: ActorCtx, id: string, note?: string): Promise<SdRequestDetail> {
    return this.moverPorId(ctx, id, 'cancelado', note);
  }

  /** Quien atiende toma un ticket sin asignar. Sólo desde `nuevo`: no se le quita a otro. */
  async take(ctx: ActorCtx, id: string): Promise<SdRequestDetail> {
    if (!ctx.esAgente) throw new ForbiddenException('Sólo quien atiende puede tomar solicitudes');
    if (!esUuid(id)) throw new NotFoundException('Solicitud no encontrada');
    const efectos = await this.tk.run(async (trx) => {
      const r = await this.bloquear(trx, id);
      if (!r) throw new NotFoundException('Solicitud no encontrada');
      if (r.status !== 'nuevo' || r.assigned_to) throw new ConflictException('La solicitud ya fue tomada por alguien más');
      return this.asignarA(trx, r, ctx.userId, ctx, new Date(), null);
    });
    await this.despachar(efectos);
    return this.detail(ctx, id);
  }

  /** La coordinación asigna (o reasigna). `user_id` ausente equivale a `take`. */
  async assign(ctx: ActorCtx, id: string, dto: SdAssignDto): Promise<SdRequestDetail> {
    if (!dto?.user_id) return this.take(ctx, id);
    if (!ctx.esCoordinador) throw new ForbiddenException('Sólo la coordinación asigna solicitudes a otra persona');
    if (!esUuid(id)) throw new NotFoundException('Solicitud no encontrada');
    if (!esUuid(dto.user_id)) throw new BadRequestException('user_id inválido');
    const destino: string = dto.user_id;
    const efectos = await this.tk.run(async (trx) => {
      const r = await this.bloquear(trx, id);
      if (!r) throw new NotFoundException('Solicitud no encontrada');
      if (FINALES.includes(r.status) || r.status === 'resuelto') throw new ConflictException('La solicitud ya no admite reasignación');
      // El destino debe ser alguien que atiende; quien asigna puede asignarse a sí mismo aunque entre por god-mode.
      if (destino !== ctx.userId && !(await this.agents.esAsignable(trx, destino))) {
        throw new BadRequestException('Esa persona no atiende solicitudes de la Mesa de Servicio');
      }
      return this.asignarA(trx, r, destino, ctx, new Date(), r.assigned_to);
    });
    await this.despachar(efectos);
    return this.detail(ctx, id);
  }

  async changePriority(ctx: ActorCtx, id: string, dto: SdChangePriorityDto): Promise<SdRequestDetail> {
    if (!SD_PRIORITIES.includes(dto?.priority)) throw new BadRequestException(`priority debe ser una de: ${SD_PRIORITIES.join(', ')}`);
    const reason = String(dto.reason ?? '').trim();
    if (!esUuid(id)) throw new NotFoundException('Solicitud no encontrada');
    await this.tk.run(async (trx) => {
      const config = await this.cfg.load(trx);
      const r = await this.bloquear(trx, id);
      if (!r || !this.puedeVer(r, ctx)) throw new NotFoundException('Solicitud no encontrada');
      const actor: SdActor = ctx.esCoordinador ? 'coordinator' : ctx.esAgente ? 'agent' : 'requester';
      if (!puedeCambiarPrioridad(actor)) throw new ForbiddenException('La prioridad la define quien atiende la solicitud');
      if (FINALES.includes(r.status) || r.status === 'resuelto') throw new ConflictException('La solicitud ya no admite cambio de prioridad');
      if (r.priority === dto.priority) throw new BadRequestException('La solicitud ya tiene esa prioridad');
      const politica = config.policies[dto.priority];
      if (!politica) throw new ConflictException(`No hay política de SLA configurada para la prioridad «${dto.priority}»`);
      const now = new Date();
      const plazos = plazosTrasCambioDePrioridad(new Date(r.created_at), Number(r.paused_minutes), r.first_responded_at ? new Date(r.first_responded_at) : null, politica, config.settings.calendar);
      await trx('servicedesk.requests').where({ id }).update({
        priority: dto.priority,
        due_at: plazos.due_at,
        first_response_due_at: plazos.first_response_due_at,
        // Un plazo nuevo es una medición nueva: lo ya marcado como vencido bajo la política vieja deja de valer.
        sla_first_breached_at: null,
        sla_resolution_breached_at: null,
        updated_at: now,
        updated_by: ctx.userId,
      });
      await this.addMessage(trx, r.tenant_id, id, {
        kind: 'priority',
        authorId: ctx.userId,
        authorLabel: ctx.nombre,
        body: reason,
        meta: { from: r.priority, to: dto.priority },
      });
    });
    return this.detail(ctx, id);
  }

  async logTime(ctx: ActorCtx, id: string, dto: SdLogTimeDto): Promise<SdRequestDetail> {
    if (!ctx.esAgente) throw new ForbiddenException('Sólo quien atiende registra tiempo');
    const minutes = Number(dto?.minutes);
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > 1440) throw new BadRequestException('minutes debe ser un entero entre 1 y 1440');
    const started = dto.started_at ? new Date(dto.started_at) : null;
    const ended = dto.ended_at ? new Date(dto.ended_at) : null;
    if ((started && Number.isNaN(started.getTime())) || (ended && Number.isNaN(ended.getTime()))) throw new BadRequestException('Fechas inválidas');
    if (started && ended && ended < started) throw new BadRequestException('El fin no puede ser anterior al inicio');
    if (!esUuid(id)) throw new NotFoundException('Solicitud no encontrada');
    await this.tk.run(async (trx) => {
      const r = await this.bloquear(trx, id);
      if (!r) throw new NotFoundException('Solicitud no encontrada');
      if (r.status === 'cancelado') throw new ConflictException('La solicitud está cancelada');
      await trx('servicedesk.work_log').insert({
        tenant_id: r.tenant_id,
        request_id: id,
        user_id: ctx.userId,
        minutes,
        started_at: started,
        ended_at: ended,
        source: 'suite',
        note: String(dto.note ?? '').trim() || null,
      });
    });
    return this.detail(ctx, id);
  }

  // ───────────────────────────── internos ─────────────────────────────

  /** El camino común de confirmar / reabrir / cancelar / cambiar estado. */
  private async moverPorId(ctx: ActorCtx, id: string, to: SdStatus, note?: string, opc: { exigirNota?: string } = {}): Promise<SdRequestDetail> {
    if (!esUuid(id)) throw new NotFoundException('Solicitud no encontrada');
    const nota = String(note ?? '').trim();
    if (nota.length > MAX_TEXTO) throw new BadRequestException(`La nota admite hasta ${MAX_TEXTO} caracteres`);
    const efectos = await this.tk.run(async (trx) => {
      const config = await this.cfg.load(trx);
      const r = await this.bloquear(trx, id);
      if (!r || !this.puedeVer(r, ctx)) throw new NotFoundException('Solicitud no encontrada');
      const actores = this.actoresDe(r, ctx);
      if (!TRANSICIONES[r.status as SdStatus]?.[to]) {
        throw new ConflictException(`No se puede pasar una solicitud de «${r.status}» a «${to}»`);
      }
      if (opc.exigirNota && !nota) throw new BadRequestException(opc.exigirNota);
      if (to === 'resuelto' && !nota) throw new BadRequestException('Describe cómo se resolvió para poder marcarla como resuelta');
      return this.moverEstado(trx, config, r, to, actores, ctx, new Date(), nota);
    });
    await this.despachar(efectos);
    return this.detail(ctx, id);
  }

  /**
   * LA función que escribe `status`. Recibe la fila ya bloqueada (`FOR UPDATE`) y la deja coherente con el
   * reloj del SLA. Lanza 403 si ninguno de los roles que `ctx` tiene sobre el ticket puede hacer la transición.
   */
  private async moverEstado(trx: Knex.Transaction, config: SdConfig, r: RequestRow, to: SdStatus, actores: SdActor[], ctx: Autor, now: Date, nota: string | null): Promise<Efectos> {
    const from = r.status as SdStatus;
    const actor = actores.find((a) => puedeTransicionar(from, to, a));
    if (!actor) throw new ForbiddenException('No tienes permiso para hacer ese cambio en esta solicitud');
    const ef = efectosDe(from, to);
    const patch: Patch = { status: to, updated_at: now, updated_by: ctx.userId };

    if (ef.pausa) patch.paused_at = now;
    if (ef.reanuda) {
      const politica = config.policies[r.priority];
      if (!politica) throw new ConflictException(`No hay política de SLA para la prioridad «${r.priority}»`);
      // Un CHECK de la base garantiza `paused_at` mientras está en espera; si falta, el dato mintió: no se adivina.
      if (!r.paused_at) throw new ConflictException('La solicitud está en espera pero no tiene hora de pausa registrada');
      const rr = reanudarTrasPausa(
        {
          due_at: r.due_at ? new Date(r.due_at) : null,
          first_response_due_at: r.first_response_due_at ? new Date(r.first_response_due_at) : null,
          first_responded_at: r.first_responded_at ? new Date(r.first_responded_at) : null,
          paused_at: new Date(r.paused_at),
        },
        now,
        politica,
        config.settings.calendar,
      );
      patch.paused_at = null;
      patch.due_at = rr.due_at;
      patch.first_response_due_at = rr.first_response_due_at;
      patch.paused_minutes = Number(r.paused_minutes) + rr.paused_delta_minutes;
    }
    if (ef.resuelve) Object.assign(patch, { resolved_at: now, resolved_by: ctx.userId, resolution_note: nota || null });
    if (ef.reabre) Object.assign(patch, { resolved_at: null, resolved_by: null, resolution_note: null, reopened_count: Number(r.reopened_count) + 1 });
    if (ef.cierra) {
      Object.assign(patch, { closed_at: now, closed_by: ctx.userId, close_reason: motivoDeCierre(to as 'cerrado' | 'cancelado', actor) });
    }
    if (ef.desasigna) Object.assign(patch, { assigned_to: null, assigned_by: null, assigned_at: null });
    // La primera respuesta de quien atiende cuenta aunque no haya escrito un comentario: tomar o iniciar es responder.
    if ((actor === 'agent' || actor === 'coordinator') && !r.first_responded_at && to !== 'nuevo') patch.first_responded_at = now;

    await trx('servicedesk.requests').where({ id: r.id }).update(patch);
    await this.addMessage(trx, r.tenant_id, r.id, {
      kind: 'status',
      authorId: ctx.userId,
      authorLabel: ctx.nombre,
      body: nota ?? '',
      meta: { from, to },
    });

    const fx = sinEfectos();
    fx.bitacora.push({ tenantId: r.tenant_id, requestId: r.id, folio: r.folio, event: 'status', status: to, assignedTo: ef.desasigna ? null : r.assigned_to });
    if (to === 'resuelto') fx.avisos.push(this.evento(r, 'resuelto', [r.requester_id], ctx, { discriminador: Number(r.reopened_count) }));
    if (ef.reabre && r.assigned_to) fx.avisos.push(this.evento(r, 'reabierto', [r.assigned_to], ctx, { discriminador: Number(r.reopened_count) + 1 }));
    if (to === 'cancelado') {
      const otra = actor === 'requester' ? r.assigned_to : r.requester_id;
      if (otra) fx.avisos.push(this.evento(r, 'cancelado', [otra], ctx));
    }
    if (to === 'cerrado' && actor === 'system') fx.avisos.push(this.evento(r, 'autocerrado', [r.requester_id], ctx, { dias: config.settings.autoCloseDays }));
    return fx;
  }

  /**
   * Cierra solo lo que quedó RESUELTO y nadie objetó en `auto_close_days`. Lo llama el barrido del SLA dentro
   * de su transacción (con el candado de cron ya tomado). `FOR UPDATE SKIP LOCKED`: si una persona está
   * confirmando o reabriendo ese ticket en este instante, se le deja la prioridad y se reintenta en 5 minutos.
   */
  async autoCerrarEn(trx: Knex.Transaction, config: SdConfig, now: Date): Promise<{ cerrados: number; efectos: Efectos }> {
    const dias = config.settings.autoCloseDays;
    if (!(dias > 0)) return { cerrados: 0, efectos: sinEfectos() };
    const limite = new Date(now.getTime() - dias * 86_400_000);
    const rows: RequestRow[] = await trx('servicedesk.requests')
      .where('status', 'resuelto')
      .whereNull('deleted_at')
      .where('resolved_at', '<=', limite)
      .forUpdate()
      .skipLocked();
    let efectos = sinEfectos();
    for (const r of rows) {
      efectos = juntar(efectos, await this.moverEstado(trx, config, r, 'cerrado', ['system'], SISTEMA, now, `Cerrada automáticamente: pasaron ${dias} días desde que se resolvió y nadie la objetó.`));
    }
    return { cerrados: rows.length, efectos };
  }

  /** Dispara los avisos y el espejo a la Bitácora. Corre DESPUÉS de confirmar; nunca lanza ni bloquea. */
  async despachar(fx: Efectos, tenantId?: string): Promise<void> {
    try {
      if (fx.avisos.length) await this.notifs.dispatch(tenantId ?? this.tenantCtx.requireTenantId(), fx.avisos);
    } catch (e) {
      this.logger.warn(`avisos no despachados: ${e instanceof Error ? e.message : String(e)}`);
    }
    for (const b of fx.bitacora) {
      try {
        await this.bitacora?.onTicketChanged(b);
      } catch (e) {
        this.logger.warn(`Bitácora no notificada (${b.folio}): ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }

  private evento(r: RequestRow, event: SdEventoClave, recipients: string[], autor: Autor, extra: Partial<SdEvento> = {}): SdEvento {
    return { event, request_id: r.id, folio: r.folio, title: r.title, priority: r.priority, recipients, actor_id: autor.userId, actor_name: autor.userId ? autor.nombre : null, ...extra };
  }

  /** Fija el asignado y deja el estado en `asignado` si venía de `nuevo`. */
  private async asignarA(
    trx: Knex.Transaction,
    r: RequestRow,
    userId: string,
    ctx: Autor,
    now: Date,
    anterior: string | null,
    opc: { automatico?: boolean; meta?: Record<string, unknown> } = {},
  ): Promise<Efectos> {
    const patch: Patch = { assigned_to: userId, assigned_by: ctx.userId, assigned_at: now, updated_at: now, updated_by: ctx.userId };
    if (r.status === 'nuevo') patch.status = 'asignado';
    // Que una persona tome o asigne el ticket SÍ es responder. Que lo asigne el SISTEMA por una regla NO: el reloj
    // de primera respuesta tiene que seguir corriendo hasta que quien lo recibió haga algo, o la métrica mide a la regla.
    if (!r.first_responded_at && !opc.automatico) patch.first_responded_at = now;
    await trx('servicedesk.requests').where({ id: r.id }).update(patch);
    const destino = await trx('identity.users').where({ id: userId }).first('nombre', 'username');
    await this.addMessage(trx, r.tenant_id, r.id, {
      kind: 'assignment',
      authorId: ctx.userId,
      authorLabel: ctx.nombre,
      body: '',
      meta: { to: userId, to_name: destino?.nombre || destino?.username || null, from: anterior, ...(opc.meta ?? {}) },
    });
    const fx = sinEfectos();
    fx.bitacora.push({ tenantId: r.tenant_id, requestId: r.id, folio: r.folio, event: 'assigned', status: patch.status ? String(patch.status) : r.status, assignedTo: userId });
    // Se le avisa a quien recibe el ticket; quien se lo asignó a sí mismo no necesita aviso (lo filtra `actor_id`).
    fx.avisos.push(this.evento(r, 'asignado', [userId], ctx, { discriminador: now.getTime(), automatico: opc.automatico === true }));
    return fx;
  }

  /** Los roles que `ctx` tiene SOBRE este ticket, del más fuerte al más débil. */
  private actoresDe(r: RequestRow, ctx: ActorCtx): SdActor[] {
    const a: SdActor[] = [];
    if (ctx.esCoordinador) a.push('coordinator');
    if (ctx.esAgente) a.push('agent');
    if (r.requester_id === ctx.userId) a.push('requester');
    return a;
  }

  private puedeVer(r: RequestRow, ctx: ActorCtx): boolean {
    return ctx.esAgente || r.requester_id === ctx.userId;
  }

  private bloquear(trx: Knex.Transaction, id: string): Promise<RequestRow | undefined> {
    return trx('servicedesk.requests').where({ id }).whereNull('deleted_at').forUpdate().first();
  }

  private async siguienteFolio(trx: Knex.Transaction, tenantId: string, year: number): Promise<string> {
    // UPSERT atómico: dos altas simultáneas se serializan en la fila del año y nunca reciben el mismo número.
    const { rows } = await trx.raw(
      `INSERT INTO servicedesk.request_sequences (tenant_id, year, last_number) VALUES (?, ?, 1)
       ON CONFLICT (tenant_id, year) DO UPDATE SET last_number = servicedesk.request_sequences.last_number + 1
       RETURNING last_number`,
      [tenantId, year],
    );
    return formatFolio(year, Number(rows[0].last_number));
  }

  private async addMessage(
    trx: Knex.Transaction,
    tenantId: string,
    requestId: string,
    m: { kind: string; visibility?: 'public' | 'internal'; authorId: string | null; authorLabel: string | null; body?: string; meta?: Record<string, unknown> },
  ): Promise<string> {
    const [{ id }] = await trx('servicedesk.request_messages')
      .insert({
        tenant_id: tenantId,
        request_id: requestId,
        kind: m.kind,
        visibility: m.visibility ?? (m.kind === 'internal_note' ? 'internal' : 'public'),
        author_id: m.authorId,
        author_label: m.authorLabel,
        body: m.body ?? '',
        meta: JSON.stringify(m.meta ?? {}),
      })
      .returning('id');
    return id;
  }

  private async insertAdjuntos(trx: Knex.Transaction, tenantId: string, requestId: string, messageId: string, userId: string, subidos: AdjuntoSubido[]): Promise<void> {
    if (!subidos.length) return;
    await trx('servicedesk.request_attachments').insert(
      subidos.map((s) => ({
        tenant_id: tenantId,
        request_id: requestId,
        message_id: messageId,
        storage_key: s.storage_key,
        file_name: s.file_name,
        content_type: s.content_type,
        size_bytes: s.size_bytes,
        uploaded_by: userId,
      })),
    );
  }

  private normalizarSucursal(code: string | null | undefined): string | null {
    const c = String(code ?? '').trim();
    if (!c) return null;
    // Sólo el espacio de códigos vigente de Kepler (00–08): '30','32','50' son eras de Wincaja ya cerradas.
    if (!/^0[0-8]$/.test(c) || !(c in KEPLER_BRANCH_NAMES)) throw new BadRequestException('Sucursal desconocida');
    return c;
  }

  // ── consultas y mapeo ──

  private base(trx: Knex.Transaction): Knex.QueryBuilder {
    return trx('servicedesk.requests as r')
      .join('servicedesk.queues as q', function () {
        this.on('q.tenant_id', 'r.tenant_id').andOn('q.id', 'r.queue_id');
      })
      .join('servicedesk.categories as c', function () {
        this.on('c.tenant_id', 'r.tenant_id').andOn('c.id', 'r.category_id');
      })
      .leftJoin('identity.users as ua', function () {
        this.on('ua.tenant_id', 'r.tenant_id').andOn('ua.id', 'r.assigned_to');
      })
      .whereNull('r.deleted_at')
      .select('r.*', 'q.name as queue_name', 'c.name as category_name', 'ua.nombre as assigned_nombre', 'ua.username as assigned_username');
  }

  private buscar(qb: Knex.QueryBuilder, search: string | undefined): void {
    applySmartSearch(qb, search, { columns: ['r.folio', 'r.title', 'r.description', 'r.requester_name', 'c.name'] });
  }

  private async paginar(qb: Knex.QueryBuilder, config: SdConfig, limit?: number, offset?: number): Promise<SdListResponse> {
    const lim = Math.min(Math.max(Number(limit) || 50, 1), 200);
    const off = Math.max(Number(offset) || 0, 0);
    const total = await qb.clone().clearSelect().clearOrder().count({ n: 'r.id' }).first();
    const rows = await qb.limit(lim).offset(off);
    return { rows: (rows as RequestRow[]).map((r) => this.mapRow(r, config)), total: Number(total?.n ?? 0) };
  }

  private mapRow(r: RequestRow, config: SdConfig, now = new Date()): SdRequestRow {
    return {
      id: r.id,
      folio: r.folio,
      queue_id: r.queue_id,
      queue_name: r.queue_name ?? null,
      category_id: r.category_id,
      category_name: r.category_name ?? null,
      title: r.title,
      priority: r.priority,
      priority_suggested: r.priority_suggested ?? null,
      impact: r.impact,
      blocks_work: !!r.blocks_work,
      status: r.status,
      requester_id: r.requester_id,
      requester_name: r.requester_name ?? null,
      warehouse_code: r.warehouse_code ?? null,
      warehouse_name: r.warehouse_code ? branchName(r.warehouse_code) : null,
      assigned_to: r.assigned_to ?? null,
      assigned_to_name: r.assigned_to ? r.assigned_nombre || r.assigned_username || null : null,
      assigned_at: iso(r.assigned_at),
      created_at: iso(r.created_at) as string,
      updated_at: iso(r.updated_at) as string,
      sla: this.slaView(r, config, now),
    };
  }

  private slaView(r: RequestRow, config: SdConfig, now: Date): SdSlaView {
    const politica = config.policies[r.priority as SdPriority];
    const due = r.due_at ? new Date(r.due_at) : null;
    const firstDue = r.first_response_due_at ? new Date(r.first_response_due_at) : null;
    const v = politica
      ? evaluarSla(
          {
            status: r.status,
            due_at: due,
            first_response_due_at: firstDue,
            first_responded_at: r.first_responded_at ? new Date(r.first_responded_at) : null,
            paused_at: r.paused_at ? new Date(r.paused_at) : null,
            sla_first_breached_at: r.sla_first_breached_at ? new Date(r.sla_first_breached_at) : null,
            sla_resolution_breached_at: r.sla_resolution_breached_at ? new Date(r.sla_resolution_breached_at) : null,
          },
          now,
          politica,
          config.settings.calendar,
          config.settings.escalatePct,
        )
      : null;
    return {
      first_response_due_at: iso(r.first_response_due_at),
      due_at: iso(r.due_at),
      first_responded_at: iso(r.first_responded_at),
      paused: !!r.paused_at,
      first_breached: !!r.sla_first_breached_at || !!v?.primera_respuesta_vencida,
      resolution_breached: !!r.sla_resolution_breached_at || !!v?.resolucion_vencida,
      used_ratio: v?.usado ?? null,
    };
  }
}
