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
  SD_PAUSE_REASONS,
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
  type SdExtraValueDto,
  type SdImpact,
  type SdListResponse,
  type SdMarkTestDto,
  type SdLogTimeDto,
  type SdMessageDto,
  type SdMessageKind,
  type SdPauseReason,
  type SdPostMessageDto,
  type SdPriority,
  type SdRequestDetail,
  type SdRequestRow,
  type SdSlaView,
  type SdStatsResponse,
  type SdTransferDto,
  type SdTransferResult,
  type SdWorkLogEntryDto,
  type SdStatus,
  type SdVisibility,
  type BitacoraPort,
  type BitacoraTicketEvent,
  SD_UBICACIONES_EXTRA,
} from '@megadulces/contracts';
import { KEPLER_BRANCH_NAMES, TenantContextService, TenantKnexService, applySmartSearch, branchName, toMxDateKey } from '@megadulces/platform-core';
import { ServiceDeskAgentsService } from './agents.service';
import { ServiceDeskRoutingService } from './routing.service';
import { nombreUbicacionExtra, ubicacionExtra } from './domain/ubicaciones';
import { ServiceDeskAttachmentsService, type AdjuntoSubido } from './attachments.service';
import { efectosDe, motivoDeCierre, puedeTransicionar, respuestaReanuda, TRANSICIONES } from './domain/request-state';
import { formatFolio } from './domain/folio';
import { estadoTrasTraslado, terminaEspera, validarTraslado } from './domain/traslado';
import { normalizarUbicacion } from './ubicacion.util';
import { validarCamposExtra, type CampoDef } from './domain/campos-extra';
import { clausulasOrden, validarOrden } from './domain/inbox-sort';
import { accesoATicket, colasDeLectura, puedeAtenderCola, puedeCoordinarCola } from './domain/queue-access';
import { fechaValida } from './domain/report-period';
import { puedeCambiarPrioridad, sugerirPrioridadPorModelo } from './domain/priority';
import { evaluarSla, plazosIniciales, plazosTrasCambioDePrioridad, reanudarTrasPausa } from './domain/sla';
import type { SdEventoClave } from './domain/notice';
import { ServiceDeskNotificationsService, type SdEvento } from './notifications.service';
import { ServiceDeskConfigService, politicaDe, type SdConfig } from './service-desk-config.service';
import type { ActorCtx } from './service-desk.types';

/** La fila de `servicedesk.requests` (y lo que `base()` le junta). `pg` entrega `timestamptz` como `Date`. */
interface RequestRow {
  id: string;
  tenant_id: string;
  folio: string;
  queue_id: string;
  /** `[MSH.1]` La FIJA la base desde la cola al crear el ticket (trigger). */
  confidential?: boolean;
  /** `[MSH.2]` Banderas de SU cola (las trae el JOIN de `base()` y de `bloquear()`). `false` = no usa prioridad / no mide SLA. */
  queue_uses_priority?: boolean;
  queue_sla_enabled?: boolean;
  category_id: string;
  title: string;
  description: string;
  priority: SdPriority;
  priority_suggested: SdPriority | null;
  impact: SdImpact;
  blocks_work: boolean;
  safety_risk?: boolean | null;
  zone_code?: string | null;
  zone_name?: string | null;
  pause_reason?: string | null;
  is_test?: boolean;
  extra?: Record<string, unknown> | null;
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
/** `[MS.3.16]` Nombre que la pantalla muestra por código de ubicación: es por lo que se ordena la columna. */
const NOMBRES_UBICACION: Readonly<Record<string, string>> = Object.freeze({ ...KEPLER_BRANCH_NAMES, ...SD_UBICACIONES_EXTRA });
const FINALES: SdStatus[] = ['cerrado', 'cancelado'];
const MAX_TITULO = 200;
/** `[MSH.2]` El valor interno de una cola que NO usa prioridad: la columna es NOT NULL, pero esto NUNCA se publica (`mapRow` lo vuelve `null`). */
const PRIORIDAD_NEUTRA: SdPriority = 'media';
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
          .first('c.id', 'c.queue_id', 'c.default_priority', 'c.requires_branch', 'q.priority_model', 'q.asks_zone', 'q.uses_priority', 'q.sla_enabled', 'q.confidential');
        if (!cat) throw new BadRequestException('La categoría no existe o no está disponible');
        if (cat.requires_branch && !warehouse) throw new BadRequestException('Esta categoría exige indicar la ubicación');
        /*
         * `[MS.7.7]` El modelo de prioridad lo dicta la COLA (su `priority_model`), no su nombre. En `riesgo_operacion` «¿hay riesgo
         * para personas?» es OBLIGATORIA y debe ser verdadero o falso: un faltante NO se toma como «no hay riesgo» (el peligro nunca
         * se infiere por omisión). En `impacto` la respuesta se ignora y se guarda NULL («no se preguntó»), no un `false` inventado.
         */
        /*
         * `[MSH.2]` R5: una cola que NO usa prioridad (RH) no hace ninguna de las preguntas de prioridad —ni impacto, ni «me impide
         * trabajar», ni riesgo— y lo que llegue de ellas se IGNORA: la base guarda el valor neutro interno (`PRIORIDAD_NEUTRA`), nunca
         * se publica y nadie lo ve. Una cola que no mide SLA no tiene plazos (`due_at` NULL): «—», nunca un 0 inventado.
         */
        const usaPrioridad = cat.uses_priority !== false;
        const midePlazos = cat.sla_enabled !== false;
        const impactoEf = usaPrioridad ? impact : 'yo';
        const bloqueaEf = usaPrioridad ? blocksWork : false;
        /*
         * `[MSH.2]` H7 — levantar a nombre de OTRA persona hacia una cola confidencial: sólo quien es de ESA cola. Si no, un agente de TI
         * podría mandar un ticket a RH a nombre de alguien y quedar él como quien lo abrió. Lo ven sólo el solicitante y los miembros.
         */
        if (cat.confidential === true && (pidioOtro || pidioArea) && !puedeAtenderCola(ctx.colas, cat.queue_id)) {
          throw new ForbiddenException('Sólo quien atiende esa área puede levantar una solicitud confidencial a nombre de otra persona');
        }
        const modelo: string = usaPrioridad ? (cat.priority_model ?? 'impacto') : 'impacto';
        if (modelo === 'riesgo_operacion' && typeof dto.safety_risk !== 'boolean') {
          throw new BadRequestException('Indica si hay riesgo para personas (sí o no): sin eso no se puede sugerir la prioridad de esta área');
        }
        const riesgo: boolean | null = modelo === 'riesgo_operacion' ? (dto.safety_risk as boolean) : null;
        /*
         * `[MS.7.3]` La zona es el LUGAR dentro de la ubicación y sólo la pregunta una cola que lo declara (`asks_zone`, por
         * valor, no por nombre). Si la cola no la pregunta se IGNORA y queda NULL; si la pregunta y llega, debe ser una zona
         * ACTIVA del catálogo (no hay zonas inventadas). Es opcional: sin zona se levanta igual.
         */
        let zona: string | null = null;
        if (cat.asks_zone && typeof dto.zone_code === 'string' && dto.zone_code.trim() !== '') {
          const z = await trx('servicedesk.zones').where({ code: dto.zone_code.trim(), active: true }).first('code');
          if (!z) throw new BadRequestException('La zona indicada no existe o está apagada');
          zona = z.code as string;
        }
        /*
         * `[MS.7.4]` + `[MS.7.8]` Los campos propios de la cola: se validan contra sus definiciones ACTIVAS. Una clave que la cola no
         * declara se RECHAZA (no se ignora); un requerido sin contestar, un tipo equivocado o una opción fuera de la lista → 400; una
         * foto requerida exige al menos un adjunto. Una cola sin campos ni `extra` guarda `{}` (TI no cambia).
         */
        const defs = (await trx('servicedesk.queue_fields')
          .where({ queue_id: cat.queue_id, active: true })
          .orderBy([{ column: 'sort_order' }, { column: 'label' }])
          .select('code', 'label', 'type', 'required', 'options')) as { code: string; label: string; type: CampoDef['type']; required: boolean; options: string[] }[];
        const extraValidado = validarCamposExtra(defs, dto.extra, preparados.length);
        if (extraValidado.errores.length) throw new BadRequestException(extraValidado.errores.join('. '));

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
        const priority: SdPriority = usaPrioridad ? sugerirPrioridadPorModelo({ defaultPriority: cat.default_priority, impact: impactoEf, blocksWork: bloqueaEf, modelo, safetyRisk: riesgo }) : PRIORIDAD_NEUTRA;
        const politica = politicaDe(config, cat.queue_id, priority);
        if (midePlazos && !politica) throw new ConflictException(`No hay política de SLA configurada para la prioridad «${priority}»`);
        const plazos = midePlazos && politica ? plazosIniciales(now, politica, config.settings.calendar) : { due_at: null, first_response_due_at: null };

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
            priority_suggested: usaPrioridad ? priority : null,
            impact: impactoEf,
            blocks_work: bloqueaEf,
            safety_risk: riesgo,
            zone_code: zona,
            extra: JSON.stringify(extraValidado.valores),
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
          meta: { ...(usaPrioridad ? { priority, impact: impactoEf, blocks_work: bloqueaEf } : {}), ...(riesgo !== null ? { safety_risk: riesgo } : {}), ...(pidioOtro ? { opened_on_behalf: true, opened_by: ctx.userId, requester_id: solicitanteId } : {}) },
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
        const destino = await this.routing.resolver(trx, { title, description, categoryId: cat.id, warehouseCode: warehouse }, cat.queue_id);
        let asignadoA: string | null = null;
        if (destino?.asignable) {
          const row = await this.bloquear(trx, id);
          if (row) {
            const o = destino.origen;
            // `[MS.7.10]` Por qué le tocó se guarda en el hilo, para que se vea: una regla (por categoría, palabra o ubicación) o el
            // responsable por omisión del área cuando ninguna regla aplicó.
            const meta =
              o.tipo === 'default'
                ? { auto: true, rule_id: null, rule_name: null, reason: 'default', keyword: null }
                : { auto: true, rule_id: o.regla.id, rule_name: o.regla.name, reason: o.motivo.tipo === 'categoria' ? 'category' : o.motivo.tipo === 'ubicacion' ? 'location' : 'keyword', keyword: o.motivo.tipo === 'palabra' ? o.motivo.palabra : null };
            efectos = juntar(efectos, await this.asignarA(trx, row, destino.assigneeId, SISTEMA, now, null, { automatico: true, meta }));
            asignadoA = destino.assigneeId;
          }
        } else if (destino) {
          await this.addMessage(trx, tenantId, id, {
            kind: 'system',
            visibility: 'internal',
            authorId: null,
            authorLabel: 'Sistema',
            body:
              destino.origen.tipo === 'default'
                ? `Asignación automática omitida: el responsable por omisión del área es ${destino.assigneeName ?? 'una persona que ya no existe'}, que hoy no puede atender solicitudes de esta cola. Queda sin asignar.`
                : `Asignación automática omitida: la regla «${destino.origen.regla.name}» apunta a ${destino.assigneeName ?? 'una persona que ya no existe'}, que hoy no puede atender solicitudes de la Mesa de Servicio. Queda sin asignar.`,
            meta: { auto: true, skipped: true, rule_id: destino.origen.tipo === 'default' ? null : destino.origen.regla.id, ...(destino.origen.tipo === 'default' ? { reason: 'default' } : {}) },
          });
        }

        // Lo urgente y lo alto no pueden esperar a que alguien abra la bandeja: se avisa a quien atiende
        // (menos a quien la regla ya le asignó el ticket, que recibe su propio aviso de asignación).
        if (usaPrioridad && (priority === 'alta' || priority === 'urgente')) {
          // `[MS.7.6]` Sólo a quien atiende ESA cola: un ticket de Mantenimiento no despierta a TI.
          const agentes = (await this.agents.listIn(trx, cat.queue_id)).map((a) => a.user_id).filter((u) => u !== asignadoA);
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
    q: {
      scope?: string;
      queue_id?: string;
      priority?: string;
      status?: string;
      warehouse_code?: string;
      category_id?: string;
      /** Un usuario, o `none` para «sin asignar». */
      assigned_to?: string;
      /** Fecha de alta, AAAA-MM-DD, en la zona de la mesa. */
      from?: string;
      to?: string;
      sort?: string;
      dir?: string;
      search?: string;
      limit?: number;
      offset?: number;
    },
  ): Promise<SdListResponse> {
    if (!ctx.esAgente) throw new ForbiddenException('La bandeja es para quien atiende solicitudes');
    const orden = validarOrden(q.sort, q.dir);
    if (!orden.ok) throw new BadRequestException(orden.motivo);
    if (q.from !== undefined && q.from !== '' && !fechaValida(q.from)) throw new BadRequestException('from debe ser una fecha AAAA-MM-DD válida');
    if (q.to !== undefined && q.to !== '' && !fechaValida(q.to)) throw new BadRequestException('to debe ser una fecha AAAA-MM-DD válida');
    if (q.from && q.to && q.from > q.to) throw new BadRequestException('from no puede ser posterior a to');
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
      // `[MS.7.6]` Sólo las colas que esta persona atiende (clave ∩ pertenencia). `[]` = ninguna: no devuelve nada, no TODO.
      const colas = colasDeLectura(ctx.colas);
      if (colas) qb.whereIn('r.queue_id', colas);
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
      if (q.category_id) {
        if (!esUuid(q.category_id)) throw new BadRequestException('category_id inválido');
        qb.where('r.category_id', q.category_id);
      }
      if (q.assigned_to) {
        if (q.assigned_to === 'none') qb.whereNull('r.assigned_to');
        else if (esUuid(q.assigned_to)) qb.where('r.assigned_to', q.assigned_to);
        else throw new BadRequestException('assigned_to debe ser un usuario o none');
      }
      const tz = config.settings.calendar.tz;
      if (q.from) qb.whereRaw('r.created_at >= (?::date)::timestamp AT TIME ZONE ?', [q.from, tz]);
      if (q.to) qb.whereRaw('r.created_at < ((?::date + 1))::timestamp AT TIME ZONE ?', [q.to, tz]);
      this.buscar(qb, q.search);
      if (orden.columna) {
        for (const c of clausulasOrden(orden.columna, orden.direccion, NOMBRES_UBICACION)) qb.orderByRaw(c);
      } else {
        qb.orderByRaw(`CASE r.priority WHEN 'urgente' THEN 0 WHEN 'alta' THEN 1 WHEN 'media' THEN 2 ELSE 3 END`)
          .orderByRaw('r.due_at ASC NULLS LAST')
          .orderBy('r.created_at', 'asc');
      }
      return this.paginar(qb, config, q.limit, q.offset);
    });
  }

  async detail(ctx: ActorCtx, id: string): Promise<SdRequestDetail> {
    if (!esUuid(id)) throw new NotFoundException('Solicitud no encontrada');
    return this.tk.run(async (trx) => {
      const config = await this.cfg.load(trx);
      const r = await this.base(trx).where('r.id', id).first();
      if (!r || !this.puedeVer(r, ctx)) throw new NotFoundException('Solicitud no encontrada');
      // `[MS.7.6]` «Quien atiende» es POR TICKET: la capacidad de atender y ser de la cola de ESTE ticket.
      const atiendeAqui = ctx.esAgente && puedeAtenderCola(ctx.colas, r.queue_id);

      const msgs = await trx('servicedesk.request_messages')
        .where({ request_id: id })
        .modify((qb) => {
          if (!atiendeAqui) qb.where('visibility', 'public');
        })
        .orderBy('created_at', 'asc')
        .select('id', 'kind', 'visibility', 'author_id', 'author_label', 'body', 'meta', 'created_at');

      const adj = await trx('servicedesk.request_attachments as a')
        .leftJoin('servicedesk.request_messages as m', function () {
          this.on('m.tenant_id', 'a.tenant_id').andOn('m.id', 'a.message_id');
        })
        .where('a.request_id', id)
        .modify((qb) => {
          if (!atiendeAqui) qb.where((w) => w.whereNull('a.message_id').orWhere('m.visibility', 'public'));
        })
        .orderBy('a.created_at', 'asc')
        .select('a.id', 'a.message_id', 'a.file_name', 'a.content_type', 'a.size_bytes', 'a.storage_key', 'a.created_at');

      // `[MS.3.15]` El tiempo: la lista (quién, cuándo, cuánto, qué hizo) y su suma. Sólo quien atiende; para quien reportó
      // es `null` (no «vacío»: no tiene acceso).
      let logged: number | null = null;
      let entradasTiempo: SdWorkLogEntryDto[] | null = null;
      if (atiendeAqui) {
        const filas = await trx('servicedesk.work_log as w')
          .leftJoin('identity.users as uw', function () {
            this.on('uw.tenant_id', 'w.tenant_id').andOn('uw.id', 'w.user_id');
          })
          .where('w.request_id', id)
          .orderBy('w.created_at', 'asc')
          .select('w.id', 'w.minutes', 'w.note', 'w.started_at', 'w.ended_at', 'w.source', 'w.created_at', 'uw.nombre as user_nombre', 'uw.username as user_username');
        entradasTiempo = (filas as Array<Record<string, unknown>>).map((w) => ({
          id: String(w['id']),
          user_name: ((w['user_nombre'] as string | null) || (w['user_username'] as string | null)) ?? null,
          minutes: Number(w['minutes']),
          note: (w['note'] as string | null) ?? null,
          started_at: iso(w['started_at'] as Date | null),
          ended_at: iso(w['ended_at'] as Date | null),
          source: w['source'] as 'suite' | 'bitacora',
          created_at: iso(w['created_at'] as Date) as string,
        }));
        logged = entradasTiempo.reduce((s, e) => s + e.minutes, 0);
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

      // `[MS.7.4]` Lo contestado en los campos propios, con la pregunta tal como se llamaba. Se leen TAMBIÉN los apagados: apagar
      // un campo no borra la respuesta de los tickets viejos ni su pregunta.
      const camposDeLaCola = (await trx('servicedesk.queue_fields')
        .where({ queue_id: r.queue_id })
        .orderBy([{ column: 'sort_order' }, { column: 'label' }])
        .select('code', 'label', 'type')) as { code: string; label: string; type: SdExtraValueDto['type'] }[];
      const guardado = r.extra ?? {};
      const extra: SdExtraValueDto[] = camposDeLaCola
        .filter((f) => f.type !== 'photo' && (typeof guardado[f.code] === 'boolean' || typeof guardado[f.code] === 'string'))
        .map((f) => ({ code: f.code, label: f.label, type: f.type, value: guardado[f.code] as boolean | string }));

      return {
        ...this.mapRow(r, config),
        extra,
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
        time_entries: entradasTiempo,
      };
    });
  }

  /** Tablero de la coordinación. */
  async stats(ctx: ActorCtx): Promise<SdStatsResponse> {
    if (!ctx.esAgente) throw new ForbiddenException('El tablero es para quien atiende solicitudes');
    // `[MS.7.6]` Los números son sólo de las colas de esta persona (`[]` = ninguna → todo en 0, no el total de la empresa).
    const colas = colasDeLectura(ctx.colas);
    const deMisColas = (qb: Knex.QueryBuilder): Knex.QueryBuilder => (colas ? qb.whereIn('queue_id', colas) : qb);
    return this.tk.run(async (trx) => {
      // `[MS.7.12]` Los tickets de prueba no cuentan en el tablero.
      const rows: { status: SdStatus; priority: SdPriority; n: string | number }[] = await trx('servicedesk.requests')
        .modify(deMisColas)
        .whereNull('deleted_at')
        .where({ is_test: false })
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
      const un = await trx('servicedesk.requests').modify(deMisColas).whereNull('deleted_at').where({ is_test: false }).where('status', 'nuevo').whereNull('assigned_to').count({ n: '*' }).first();
      // Los contadores salen de las marcas que deja el barrido del SLA (idempotentes), no de recalcular acá.
      const br = await trx('servicedesk.requests')
        .modify(deMisColas)
        .whereNull('deleted_at')
        .where({ is_test: false })
        .whereNotIn('status', FINALES)
        .select(
          trx.raw('count(*) FILTER (WHERE sla_first_breached_at IS NOT NULL)::int AS primera'),
          trx.raw('count(*) FILTER (WHERE sla_resolution_breached_at IS NOT NULL)::int AS resolucion'),
        )
        .first();
      // `[MS.7.16]` El selector de cola de la bandeja ofrece SÓLO las colas que esta persona lee (`[]` = ninguna).
      const colasLeidas = (await trx('servicedesk.queues')
        .whereNull('deleted_at')
        .modify((qb) => { if (colas) qb.whereIn('id', colas); })
        .orderBy([{ column: 'sort_order' }, { column: 'name' }])
        .select('id', 'name')) as { id: string; name: string }[];
      return {
        queues: colasLeidas,
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
        const atiendeAqui = ctx.esAgente && puedeAtenderCola(ctx.colas, r.queue_id);
        if (visibility === 'internal' && !atiendeAqui) throw new ForbiddenException('Sólo quien atiende puede dejar notas internas');
        const atiende = atiendeAqui && !comoSolicitante;

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
        // `[MS.7.9]` …pero sólo si lo que se esperaba era a esa persona: si se espera a un proveedor o una refacción, su comentario es
        // un comentario y la pausa del SLA sigue hasta que quien atiende la levante.
        if (comoSolicitante && visibility === 'public' && r.status === 'en_espera' && respuestaReanuda(r.pause_reason)) {
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
    /*
     * `[MS.7.9]` Poner en espera EXIGE el motivo (qué se espera): sin él «en espera» no dice nada y no se puede saber si la respuesta de
     * quien reportó debe reanudarlo. Un motivo con cualquier otro estado es un error de quien llama, no algo que se ignore.
     */
    let motivo: SdPauseReason | undefined;
    if (to === 'en_espera') {
      if (!SD_PAUSE_REASONS.includes(dto.pause_reason as SdPauseReason)) {
        throw new BadRequestException(`Indica por qué queda en espera (pause_reason: ${SD_PAUSE_REASONS.join(', ')})`);
      }
      motivo = dto.pause_reason;
    } else if (dto.pause_reason !== undefined && dto.pause_reason !== null) {
      throw new BadRequestException('El motivo de pausa sólo aplica al poner la solicitud en espera');
    }
    return this.moverPorId(ctx, id, to, dto.note, { motivoPausa: motivo });
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
      // `[MS.7.6]` Una solicitud de otra cola no existe para quien no la atiende (404, no 403: no se revela que existe).
      if (!r || !puedeAtenderCola(ctx.colas, r.queue_id)) throw new NotFoundException('Solicitud no encontrada');
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
      if (!r || !this.puedeVer(r, ctx)) throw new NotFoundException('Solicitud no encontrada');
      // `[MS.7.6]` Reparte la coordinación DE ESA COLA (rol coordinador + clave), no cualquier coordinador de otra área.
      if (!puedeCoordinarCola(ctx.colas, r.queue_id)) throw new ForbiddenException('Sólo la coordinación de esta área asigna solicitudes a otra persona');
      if (FINALES.includes(r.status) || r.status === 'resuelto') throw new ConflictException('La solicitud ya no admite reasignación');
      // El destino debe ser alguien que atiende ESA cola; quien asigna puede asignarse a sí mismo aunque entre por god-mode.
      if (destino !== ctx.userId && !(await this.agents.esAsignable(trx, destino, r.queue_id))) {
        throw new BadRequestException('Esa persona no atiende solicitudes de la Mesa de Servicio');
      }
      return this.asignarA(trx, r, destino, ctx, new Date(), r.assigned_to);
    });
    await this.despachar(efectos);
    return this.detail(ctx, id);
  }

  /**
   * `[MS.7.11]` Traslada el MISMO ticket a otra cola (M6): mismo folio, hilo y adjuntos. Sólo la coordinación del área de ORIGEN.
   * Qué se puede y qué estado queda lo decide `domain/traslado` (puro); acá se leen los datos y se escribe en UNA transacción:
   * cola + categoría + asignación + plazos + el mensaje del hilo, o nada.
   *
   * La prioridad que una persona ya confirmó se conserva (el modelo de la cola nueva pide datos que el ticket quizá no tiene);
   * se recalculan los PLAZOS con la política de la cola destino para esa prioridad.
   */
  async transfer(ctx: ActorCtx, id: string, dto: SdTransferDto): Promise<SdTransferResult> {
    if (!esUuid(id)) throw new NotFoundException('Solicitud no encontrada');
    if (!esUuid(dto?.queue_id)) throw new BadRequestException('queue_id inválido');
    if (!esUuid(dto?.category_id)) throw new BadRequestException('category_id inválido');
    const motivo = String(dto?.reason ?? '').trim();
    if (motivo.length > MAX_TEXTO) throw new BadRequestException(`El motivo admite hasta ${MAX_TEXTO} caracteres`);
    const { efectos, resultado } = await this.tk.run(async (trx) => {
      const config = await this.cfg.load(trx);
      const r = await this.bloquear(trx, id);
      if (!r || !this.puedeVer(r, ctx)) throw new NotFoundException('Solicitud no encontrada');
      if (!ctx.esCoordinador || !puedeCoordinarCola(ctx.colas, r.queue_id)) throw new ForbiddenException('Sólo la coordinación del área donde está la solicitud puede trasladarla');

      const destino = await trx('servicedesk.queues').where({ id: dto.queue_id, active: true }).whereNull('deleted_at').first('id', 'name', 'confidential', 'sla_enabled');
      const categoria = destino
        ? await trx('servicedesk.categories').where({ id: dto.category_id, queue_id: dto.queue_id, active: true }).whereNull('deleted_at').first('id', 'name')
        : null;
      const miembros = destino ? (await this.agents.listIn(trx, dto.queue_id)).map((a) => a.user_id) : [];
      const veto = validarTraslado({
        status: r.status as SdStatus,
        origenId: r.queue_id,
        destinoId: dto.queue_id,
        destinoActiva: !!destino,
        categoriaEsDelDestino: !!categoria,
        miembrosDestino: miembros.length,
        motivo,
        origenConfidencial: r.confidential === true,
        destinoConfidencial: destino?.confidential === true,
      });
      if (veto) throw veto.http === 400 ? new BadRequestException(veto.mensaje) : new ConflictException(veto.mensaje);

      // `[MSH.2]` Un área destino que no mide SLA no tiene política que pedir: el ticket llega sin plazos.
      const destinoMide = destino.sla_enabled !== false;
      const politica = destinoMide ? politicaDe(config, dto.queue_id, r.priority as SdPriority) : null;
      if (destinoMide && !politica) throw new ConflictException(`El área destino no tiene política de SLA para la prioridad «${r.priority}»`);
      const now = new Date();
      /*
       * Un ticket EN ESPERA termina su espera al trasladarse (ver `estadoTrasTraslado`): se acredita lo que ya estuvo en pausa
       * —con el calendario, igual que al reanudar— y los plazos se calculan sobre ese total, con la política del área destino.
       */
      let pausado = Number(r.paused_minutes);
      let liberaPausa = false;
      if (terminaEspera(r.status as SdStatus)) {
        if (!r.paused_at) throw new ConflictException('La solicitud está en espera pero no tiene hora de pausa registrada');
        if (politica) {
          const rr = reanudarTrasPausa(
            { due_at: r.due_at ? new Date(r.due_at) : null, first_response_due_at: r.first_response_due_at ? new Date(r.first_response_due_at) : null, first_responded_at: r.first_responded_at ? new Date(r.first_responded_at) : null, paused_at: new Date(r.paused_at) },
            now,
            politica,
            config.settings.calendar,
          );
          pausado += rr.paused_delta_minutes;
        }
        liberaPausa = true;
      }
      const plazos = politica ? plazosTrasCambioDePrioridad(new Date(r.created_at), pausado, r.first_responded_at ? new Date(r.first_responded_at) : null, politica, config.settings.calendar) : { due_at: null, first_response_due_at: null };
      const origen = await trx('servicedesk.queues').where({ id: r.queue_id }).first('name');
      const catOrigen = await trx('servicedesk.categories').where({ id: r.category_id }).first('name');
      const nuevoEstado = estadoTrasTraslado(r.status as SdStatus);
      await trx('servicedesk.requests').where({ id }).update({
        queue_id: dto.queue_id,
        category_id: dto.category_id,
        status: nuevoEstado,
        assigned_to: null,
        assigned_by: null,
        assigned_at: null,
        due_at: plazos.due_at,
        first_response_due_at: plazos.first_response_due_at,
        ...(liberaPausa ? { paused_at: null, pause_reason: null, paused_minutes: pausado } : {}),
        // Un plazo nuevo es una medición nueva: lo ya marcado como vencido bajo la política de la otra área deja de valer.
        sla_first_breached_at: null,
        sla_resolution_breached_at: null,
        updated_at: now,
        updated_by: ctx.userId,
      });
      // El hilo es el registro del traslado (no hay tabla aparte): de→a, quién y por qué. Es público: quien reportó ve que su solicitud
      // cambió de área. Las respuestas de los campos propios del área de origen se conservan en la base y se anotan aquí.
      await this.addMessage(trx, r.tenant_id, id, {
        kind: 'transfer',
        visibility: 'public',
        authorId: ctx.userId,
        authorLabel: ctx.nombre,
        body: motivo,
        meta: {
          from_queue_id: r.queue_id,
          from_queue: origen?.name ?? null,
          to_queue_id: dto.queue_id,
          to_queue: destino.name,
          from_category: catOrigen?.name ?? null,
          to_category: categoria?.name ?? null,
          from_assignee: r.assigned_to ?? null,
          ...(r.extra && Object.keys(r.extra).length ? { extra_origen: r.extra } : {}),
        },
      });
      const fx = sinEfectos();
      fx.bitacora.push({ tenantId: r.tenant_id, requestId: id, folio: r.folio, event: 'assigned', status: nuevoEstado, assignedTo: null });
      // Le avisa a quien atiende el área DESTINO (menos a quien traslada).
      fx.avisos.push(this.evento(r, 'transferido', miembros, ctx, { extracto: destino.name, discriminador: now.getTime() }));
      const resultado: SdTransferResult = { id, folio: r.folio, queue_id: dto.queue_id, queue_name: destino.name, category_name: categoria?.name ?? '', status: nuevoEstado };
      return { efectos: fx, resultado };
    });
    await this.despachar(efectos);
    return resultado;
  }

  /**
   * `[MS.7.12]` Marca un ticket como de PRUEBA (o le quita la marca). Sólo la coordinación del área donde está. Sirve en cualquier
   * estado —un ticket de prueba ya cerrado también se saca de los reportes—. Queda en el hilo (nota INTERNA: quien reportó no necesita
   * verla) para que se sepa quién y cuándo. Repetir el mismo valor es un 409, no un cambio silencioso.
   */
  async markTest(ctx: ActorCtx, id: string, dto: SdMarkTestDto): Promise<SdRequestDetail> {
    if (!esUuid(id)) throw new NotFoundException('Solicitud no encontrada');
    if (typeof dto?.is_test !== 'boolean') throw new BadRequestException('is_test debe ser verdadero o falso');
    const motivo = String(dto?.reason ?? '').trim();
    if (motivo.length > MAX_TEXTO) throw new BadRequestException(`El motivo admite hasta ${MAX_TEXTO} caracteres`);
    await this.tk.run(async (trx) => {
      const r = await this.bloquear(trx, id);
      if (!r || !this.puedeVer(r, ctx)) throw new NotFoundException('Solicitud no encontrada');
      if (!ctx.esCoordinador || !puedeCoordinarCola(ctx.colas, r.queue_id)) throw new ForbiddenException('Sólo la coordinación del área donde está la solicitud puede marcarla como de prueba');
      if (!!r.is_test === dto.is_test) throw new ConflictException(dto.is_test ? 'La solicitud ya está marcada como de prueba' : 'La solicitud no está marcada como de prueba');
      await trx('servicedesk.requests').where({ id }).update({ is_test: dto.is_test, updated_at: new Date(), updated_by: ctx.userId });
      await this.addMessage(trx, r.tenant_id, id, {
        kind: 'system',
        visibility: 'internal',
        authorId: ctx.userId,
        authorLabel: ctx.nombre,
        body: `${dto.is_test ? 'Marcada como solicitud de prueba: ya no cuenta en reportes, tablero ni avisos.' : 'Se quitó la marca de prueba: vuelve a contar en reportes, tablero y avisos.'}${motivo ? ` ${motivo}` : ''}`,
        meta: { is_test: dto.is_test },
      });
    });
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
      const actor: SdActor = ctx.esCoordinador && puedeCoordinarCola(ctx.colas, r.queue_id) ? 'coordinator' : ctx.esAgente && puedeAtenderCola(ctx.colas, r.queue_id) ? 'agent' : 'requester';
      if (!puedeCambiarPrioridad(actor)) throw new ForbiddenException('La prioridad la define quien atiende la solicitud');
      if (r.queue_uses_priority === false) throw new ConflictException('Esta área no usa prioridad');
      if (FINALES.includes(r.status) || r.status === 'resuelto') throw new ConflictException('La solicitud ya no admite cambio de prioridad');
      if (r.priority === dto.priority) throw new BadRequestException('La solicitud ya tiene esa prioridad');
      const politica = politicaDe(config, r.queue_id, dto.priority);
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
      if (!r || !puedeAtenderCola(ctx.colas, r.queue_id)) throw new NotFoundException('Solicitud no encontrada');
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
  private async moverPorId(ctx: ActorCtx, id: string, to: SdStatus, note?: string, opc: { exigirNota?: string; motivoPausa?: SdPauseReason } = {}): Promise<SdRequestDetail> {
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
      return this.moverEstado(trx, config, r, to, actores, ctx, new Date(), nota, opc.motivoPausa);
    });
    await this.despachar(efectos);
    return this.detail(ctx, id);
  }

  /**
   * LA función que escribe `status`. Recibe la fila ya bloqueada (`FOR UPDATE`) y la deja coherente con el
   * reloj del SLA. Lanza 403 si ninguno de los roles que `ctx` tiene sobre el ticket puede hacer la transición.
   */
  private async moverEstado(trx: Knex.Transaction, config: SdConfig, r: RequestRow, to: SdStatus, actores: SdActor[], ctx: Autor, now: Date, nota: string | null, motivoPausa?: SdPauseReason): Promise<Efectos> {
    const from = r.status as SdStatus;
    const actor = actores.find((a) => puedeTransicionar(from, to, a));
    if (!actor) throw new ForbiddenException('No tienes permiso para hacer ese cambio en esta solicitud');
    const ef = efectosDe(from, to);
    const patch: Patch = { status: to, updated_at: now, updated_by: ctx.userId };

    if (ef.pausa) {
      patch.paused_at = now;
      patch.pause_reason = motivoPausa ?? null;
    }
    if (ef.reanuda) {
      // La base exige que el motivo sólo exista MIENTRAS está en espera: se va con la pausa, en la misma operación.
      patch.pause_reason = null;
      // Un CHECK de la base garantiza `paused_at` mientras está en espera; si falta, el dato mintió: no se adivina.
      if (!r.paused_at) throw new ConflictException('La solicitud está en espera pero no tiene hora de pausa registrada');
      if (r.queue_sla_enabled === false) {
        // `[MSH.2]` Sin SLA no hay plazos que empujar: sólo se suelta la pausa.
        patch.paused_at = null;
      } else {
      const politica = politicaDe(config, r.queue_id, r.priority as SdPriority);
      if (!politica) throw new ConflictException(`No hay política de SLA para la prioridad «${r.priority}»`);
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
      meta: { from, to, ...(ef.pausa && motivoPausa ? { pause_reason: motivoPausa } : {}) },
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
    // `[MS.7.6]` Los roles son POR COLA del ticket: ser coordinador de TI no te hace coordinador de Mantenimiento.
    if (ctx.esCoordinador && puedeCoordinarCola(ctx.colas, r.queue_id)) a.push('coordinator');
    if (ctx.esAgente && puedeAtenderCola(ctx.colas, r.queue_id)) a.push('agent');
    if (r.requester_id === ctx.userId) a.push('requester');
    return a;
  }

  /**
   * `[MS.7.6]` Ver un ticket = acceso COMPLETO, por la función única de acceso. El acceso `basico` (el god-mode ante un
   * ticket confidencial, Fase MSH) NO abre la ficha: la vista limitada la arma MSH.2 con su propio DTO; mientras tanto
   * `basico` cae del lado seguro (no se ve).
   */
  private puedeVer(r: RequestRow, ctx: ActorCtx): boolean {
    return accesoATicket(ctx, { requester_id: r.requester_id, queue_id: r.queue_id, confidential: r.confidential }) === 'completo';
  }

  private bloquear(trx: Knex.Transaction, id: string): Promise<RequestRow | undefined> {
    // `[MSH.2]` Con las banderas de su cola (¿usa prioridad? ¿mide SLA?). `FOR UPDATE OF r`: se bloquea el ticket, no la cola.
    return trx('servicedesk.requests as r')
      .join('servicedesk.queues as q', function () {
        this.on('q.tenant_id', 'r.tenant_id').andOn('q.id', 'r.queue_id');
      })
      .where('r.id', id)
      .whereNull('r.deleted_at')
      .select('r.*', 'q.uses_priority as queue_uses_priority', 'q.sla_enabled as queue_sla_enabled')
      .forUpdate('r')
      .first();
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
    return normalizarUbicacion(code);
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
      .leftJoin('servicedesk.zones as z', function () {
        this.on('z.tenant_id', 'r.tenant_id').andOn('z.code', 'r.zone_code');
      })
      .whereNull('r.deleted_at')
      .select('r.*', 'q.name as queue_name', 'q.uses_priority as queue_uses_priority', 'q.sla_enabled as queue_sla_enabled', 'c.name as category_name', 'ua.nombre as assigned_nombre', 'ua.username as assigned_username', 'z.name as zone_name');
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
      // `[MSH.2]` Una cola sin prioridad NO publica la que guarda la base (valor neutro interno): `null`.
      priority: r.queue_uses_priority === false ? null : r.priority,
      priority_suggested: r.queue_uses_priority === false ? null : r.priority_suggested ?? null,
      impact: r.impact,
      blocks_work: !!r.blocks_work,
      safety_risk: r.safety_risk ?? null,
      status: r.status,
      requester_id: r.requester_id,
      requester_name: r.requester_name ?? null,
      warehouse_code: r.warehouse_code ?? null,
      warehouse_name: r.warehouse_code ? nombreUbicacionExtra(r.warehouse_code) ?? branchName(r.warehouse_code) : null,
      zone_code: r.zone_code ?? null,
      zone_name: r.zone_name ?? null,
      pause_reason: (r.pause_reason ?? null) as SdPauseReason | null,
      is_test: !!r.is_test,
      assigned_to: r.assigned_to ?? null,
      assigned_to_name: r.assigned_to ? r.assigned_nombre || r.assigned_username || null : null,
      assigned_at: iso(r.assigned_at),
      created_at: iso(r.created_at) as string,
      updated_at: iso(r.updated_at) as string,
      sla: this.slaView(r, config, now),
    };
  }

  private slaView(r: RequestRow, config: SdConfig, now: Date): SdSlaView {
    // `[MSH.2]` Una cola que no mide SLA no tiene plazos: «—» (nunca un 0 ni un «a tiempo» inventados).
    if (r.queue_sla_enabled === false) {
      return { first_response_due_at: null, due_at: null, first_responded_at: iso(r.first_responded_at), paused: !!r.paused_at, first_breached: false, resolution_breached: false, used_ratio: null };
    }
    const politica = politicaDe(config, r.queue_id, r.priority as SdPriority);
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
