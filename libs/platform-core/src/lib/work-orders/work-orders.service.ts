import {
  BadRequestException, ConflictException, ForbiddenException, Injectable, Logger, NotFoundException,
} from '@nestjs/common';
import type { Knex } from 'knex';
import {
  PAPELES_FIRMA, motivoNoPuede, puedeEditarTrabajo, validarNuevoVale,
  type AccionVale, type CambiosTrabajoVale, type EstadoVale, type EventoVale, type FirmarVale, type FirmaVale,
  type ListaVales, type NuevoVale, type QuienActua, type ValeDetalle, type ValeParaReglas, type ValeResumen,
} from '@megadulces/contracts';
import { TenantKnexService } from '../database/tenant-knex.service';
import { TenantContextService } from '../tenant/tenant-context.service';
import { ObjectStorageService } from '../storage/object-storage.service';
import { validarAdjunto } from '../storage/attachment-signature';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TOPE_LISTA = 200;
const MAX_BYTES_FIRMA = 1048576;
const MAX_TEXTO = 4000;
const CAMPOS_TRABAJO = ['work_detail', 'materials_used', 'outcome', 'follow_up_notes', 'general_notes'] as const;
const ACCIONES: AccionVale[] = ['take', 'assign', 'complete', 'cancel', 'reopen'];
const LLAVES_VALE = ['VALE_SERVICIO_LEVANTAR', 'VALE_SERVICIO_ATENDER', 'VALE_SERVICIO_GESTIONAR'];

const iso = (v: Date | string | null | undefined): string | null => (v == null ? null : new Date(v).toISOString());
const limpio = (v: unknown, max: number): string => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const NOMBRE = (alias: string) => `COALESCE(NULLIF(btrim(${alias}.nombre), ''), ${alias}.username)`;

/** La llave y el puesto de quien pide, resueltos por el controlador desde el JWT. */
export interface Llaves { atender: boolean; gestionar: boolean }

interface FilaVale {
  id: string; folio: number; status: EstadoVale; service_date: string; requesting_area: string;
  warehouse_code: string | null; location_detail: string | null; requested_by: string | null; requester_name: string;
  assigned_to: string | null; assignee_name: string | null; supervisor_id: string | null; supervisor_name: string | null;
  activity: string; work_detail: string | null; materials_used: string | null; outcome: string | null;
  follow_up_notes: string | null; general_notes: string | null; needs_follow_up: boolean | null;
  started_at: Date | null; completed_at: Date | null; cancelled_at: Date | null; cancel_reason: string | null;
  created_at: Date; source: 'suite' | 'mdtask'; firmas: number;
}

/**
 * `[MDT.2.3]` Vale de servicio (Fase MDT, D8/D8b): levantar → tomar o asignar → capturar el trabajo →
 * completar (o cancelar), con firmas opcionales y un historial que sólo crece. Las reglas de quién hace
 * qué son las del contrato (`motivoNoPuede`), aplicadas aquí con la fila BLOQUEADA; la base además cobra
 * las invariantes (CHECK, triggers). Un vale no se borra: se cancela.
 */
@Injectable()
export class WorkOrdersService {
  private readonly logger = new Logger(WorkOrdersService.name);

  constructor(
    private readonly tk: TenantKnexService,
    private readonly tenantCtx: TenantContextService,
    private readonly storage: ObjectStorageService,
  ) {}

  // ── Lectura ──────────────────────────────────────────────────────────────────────────────

  /** La lista: `mine` (los que pedí o me asignaron) · `queue` (abiertos) · `all` (quien coordina). */
  async lista(llaves: Llaves, scopePedido?: string, q?: string): Promise<ListaVales> {
    const userId = this.requireUser();
    const permitidos: ListaVales['scope'][] = ['mine'];
    if (llaves.atender || llaves.gestionar) permitidos.push('queue');
    if (llaves.gestionar) permitidos.push('all');
    const scope = (permitidos as string[]).includes(scopePedido ?? '') ? (scopePedido as ListaVales['scope'])
      : llaves.gestionar ? 'all' : llaves.atender ? 'queue' : 'mine';
    return this.tk.run(async (trx) => {
      const base = () => {
        const b = this.consulta(trx);
        if (scope === 'mine') b.where((w) => w.where('w.requested_by', userId).orWhere('w.assigned_to', userId));
        if (scope === 'queue') b.where('w.status', 'open');
        const t = limpio(q, 80);
        if (t) {
          const n = Number(t.replace(/^0+/, ''));
          b.where((w) => {
            w.whereRaw('w.activity ILIKE ?', [`%${t}%`]).orWhereRaw('w.requesting_area ILIKE ?', [`%${t}%`])
              .orWhereRaw('w.requester_name ILIKE ?', [`%${t}%`]);
            if (Number.isInteger(n) && n > 0) w.orWhere('w.folio', n);
          });
        }
        return b;
      };
      const c = (await base().clearSelect().count({ n: 'w.id' }).first()) as { n: string | number };
      const total = Number(c?.n ?? 0);
      const filas = (await base()
        .orderByRaw(`CASE w.status WHEN 'in_progress' THEN 0 WHEN 'open' THEN 1 ELSE 2 END, w.folio DESC`)
        .limit(TOPE_LISTA)) as FilaVale[];
      return { scope, scopes_permitidos: permitidos, vales: filas.map((f) => this.resumen(f)), total, has_more: total > filas.length };
    });
  }

  async detalle(id: string, llaves: Llaves): Promise<ValeDetalle> {
    const userId = this.requireUser();
    this.idValido(id);
    return this.tk.run((trx) => this.detalleEn(trx, id, userId, llaves));
  }

  /** Quién puede recibir un vale: personas activas con alguna llave de vales (así lo pueden abrir). */
  async responsables(q?: string): Promise<{ id: string; nombre: string; puesto: string | null }[]> {
    this.requireUser();
    return this.tk.run(async (trx) => {
      const b = trx('identity.users as u')
        .join('identity.role_permissions as rp', function (this: Knex.JoinClause) {
          this.on('rp.role_name', '=', 'u.role_name').andOn('rp.tenant_id', '=', 'u.tenant_id');
        })
        .leftJoin('identity.positions as p', function (this: Knex.JoinClause) {
          this.on('p.code', '=', 'u.position_code').andOn('p.tenant_id', '=', 'u.tenant_id');
        })
        .where('u.activo', true).whereNull('u.deleted_at').whereNull('rp.deleted_at')
        .where((w) => { for (const k of LLAVES_VALE) w.orWhereRaw(`rp.permissions -> ?::text = 'true'::jsonb`, [k]); })
        .select('u.id', trx.raw(`${NOMBRE('u')} AS nombre`), 'p.name as puesto')
        .orderByRaw(`${NOMBRE('u')}`)
        .limit(50);
      const t = limpio(q, 60);
      if (t) b.whereRaw(`${NOMBRE('u')} ILIKE ?`, [`%${t}%`]);
      return (await b) as { id: string; nombre: string; puesto: string | null }[];
    });
  }

  // ── Escritura ────────────────────────────────────────────────────────────────────────────

  /** Levanta un vale. El folio sale del consecutivo DENTRO de la transacción: dos altas nunca chocan. */
  async crear(body: NuevoVale, llaves: Llaves): Promise<ValeDetalle> {
    const userId = this.requireUser();
    const error = validarNuevoVale(body);
    if (error) throw new BadRequestException(error);
    if (body.supervisor_id && !UUID.test(body.supervisor_id)) throw new BadRequestException('supervisor_id inválido');
    return this.tk.run(async (trx) => {
      const yo = await this.nombreDe(trx, userId);
      const { rows: [s] } = await trx.raw(`
        INSERT INTO platform.work_order_sequences (tenant_id, last_number) VALUES (public.current_tenant_id(), 1)
        ON CONFLICT (tenant_id) DO UPDATE SET last_number = platform.work_order_sequences.last_number + 1
        RETURNING last_number`);
      const supervisor = body.supervisor_id ? await this.nombreDe(trx, body.supervisor_id) : null;
      if (body.supervisor_id && !supervisor) throw new BadRequestException('Esa persona no existe o no está activa.');
      const [{ id }] = await trx('platform.work_orders').insert({
        tenant_id: trx.raw('public.current_tenant_id()'), folio: Number(s.last_number), status: 'open',
        requesting_area: limpio(body.requesting_area, 120), activity: limpio(body.activity, 300),
        warehouse_code: limpio(body.warehouse_code, 20) || null, location_detail: limpio(body.location_detail, 200) || null,
        requested_by: userId, requester_name: limpio(body.requester_name, 120) || yo || 'Sin nombre',
        supervisor_id: body.supervisor_id || null, supervisor_name: supervisor,
        created_by: userId, updated_by: userId,
      }).returning('id');
      await this.evento(trx, id, 'created', null, 'open', null, userId);
      return this.detalleEn(trx, id, userId, llaves);
    });
  }

  async tomar(id: string, llaves: Llaves): Promise<ValeDetalle> {
    return this.accion(id, 'take', llaves, async (trx, v, userId) => {
      await trx('platform.work_orders').where({ id }).update({
        status: 'in_progress', assigned_to: userId, assigned_by: userId, assigned_at: trx.fn.now(),
        assignee_name: await this.nombreDe(trx, userId), started_at: trx.fn.now(), updated_at: trx.fn.now(), updated_by: userId,
      });
      await this.evento(trx, id, 'taken', v.status, 'in_progress', null, userId);
    });
  }

  async asignar(id: string, body: { user_id?: string }, llaves: Llaves): Promise<ValeDetalle> {
    const destino = body?.user_id ?? '';
    if (!UUID.test(destino)) throw new BadRequestException('Elige a quién se asigna.');
    return this.accion(id, 'assign', llaves, async (trx, v, userId) => {
      const nombre = await this.nombreConLlave(trx, destino);
      if (!nombre) throw new BadRequestException('Esa persona no puede abrir los vales: no tiene ninguna llave de vales de servicio.');
      if (v.assigned_to === destino) return;
      await trx('platform.work_orders').where({ id }).update({
        status: 'in_progress', assigned_to: destino, assigned_by: userId, assigned_at: trx.fn.now(), assignee_name: nombre,
        started_at: trx.raw('COALESCE(started_at, now())'), updated_at: trx.fn.now(), updated_by: userId,
      });
      await this.evento(trx, id, 'assigned', v.status, 'in_progress', nombre, userId);
    });
  }

  /** Captura del trabajo (detalle, materiales, resultado, notas, seguimiento). El asignado o quien coordina. */
  async guardarTrabajo(id: string, body: CambiosTrabajoVale, llaves: Llaves): Promise<ValeDetalle> {
    const userId = this.requireUser();
    this.idValido(id);
    return this.tk.run(async (trx) => {
      const v = await this.bloquear(trx, id, userId, llaves);
      if (!puedeEditarTrabajo(v, this.quien(userId, llaves))) {
        throw new ForbiddenException('Captura el trabajo quien tiene el vale asignado, o quien coordina.');
      }
      const cambios = this.cambiosTrabajo(body);
      if (!Object.keys(cambios).length) return this.detalleEn(trx, id, userId, llaves);
      await trx('platform.work_orders').where({ id }).update({ ...cambios, updated_at: trx.fn.now(), updated_by: userId });
      await this.evento(trx, id, 'updated', v.status, v.status, null, userId);
      return this.detalleEn(trx, id, userId, llaves);
    });
  }

  /** Cierra el vale. Exige el trabajo escrito (puede venir en el mismo cuerpo); ninguna firma (D8b). */
  async completar(id: string, body: CambiosTrabajoVale, llaves: Llaves): Promise<ValeDetalle> {
    const cambios = this.cambiosTrabajo(body ?? {});
    return this.accion(id, 'complete', llaves, async (trx, v, userId) => {
      // Quien cierra un vale ABIERTO (atiende sin tomarlo antes) queda como responsable: la base exige uno.
      const sinDueno = !v.assigned_to;
      await trx('platform.work_orders').where({ id }).update({
        ...cambios,
        ...(sinDueno ? {
          assigned_to: userId, assigned_by: userId, assigned_at: trx.fn.now(),
          assignee_name: await this.nombreDe(trx, userId), started_at: trx.raw('COALESCE(started_at, now())'),
        } : {}),
        status: 'completed', completed_at: trx.fn.now(), updated_at: trx.fn.now(), updated_by: userId,
      });
      await this.evento(trx, id, 'completed', v.status, 'completed', null, userId);
    }, (v) => ({ ...v, work_detail: 'work_detail' in cambios ? (cambios['work_detail'] as string | null) : v.work_detail }));
  }

  async cancelar(id: string, body: { reason?: string }, llaves: Llaves): Promise<ValeDetalle> {
    const motivo = limpio(body?.reason, 500);
    if (!motivo) throw new BadRequestException('Escribe por qué se cancela.');
    return this.accion(id, 'cancel', llaves, async (trx, v, userId) => {
      await trx('platform.work_orders').where({ id }).update({
        status: 'cancelled', cancelled_at: trx.fn.now(), cancelled_by: userId, cancel_reason: motivo,
        updated_at: trx.fn.now(), updated_by: userId,
      });
      await this.evento(trx, id, 'cancelled', v.status, 'cancelled', motivo, userId);
    });
  }

  /** Reabre un vale cerrado: con responsable vuelve EN PROCESO; sin él, ABIERTO. El cierre anterior queda en el historial. */
  async reabrir(id: string, body: { reason?: string }, llaves: Llaves): Promise<ValeDetalle> {
    const motivo = limpio(body?.reason, 500);
    if (!motivo) throw new BadRequestException('Escribe por qué se reabre.');
    return this.accion(id, 'reopen', llaves, async (trx, v, userId) => {
      const a = v.assigned_to ? 'in_progress' : 'open';
      await trx('platform.work_orders').where({ id }).update({
        status: a, completed_at: null, cancelled_at: null, cancelled_by: null, cancel_reason: null,
        updated_at: trx.fn.now(), updated_by: userId,
      });
      await this.evento(trx, id, 'reopened', v.status, a, motivo, userId);
    });
  }

  /** Una firma (realizado · revisado · recibido): trazo PNG/JPEG validado por sus bytes, al bucket. */
  async firmar(id: string, body: FirmarVale, llaves: Llaves): Promise<ValeDetalle> {
    const userId = this.requireUser();
    this.idValido(id);
    if (!(PAPELES_FIRMA as readonly string[]).includes(body?.role)) throw new BadRequestException('Papel de firma inválido.');
    const nombre = limpio(body?.signer_name, 120);
    if (!nombre) throw new BadRequestException('Escribe el nombre de quien firma.');
    const r = validarAdjunto(body?.image_base64, MAX_BYTES_FIRMA);
    if (!r.ok) throw new BadRequestException(r.detalle);
    if (r.adjunto.contentType !== 'image/png' && r.adjunto.contentType !== 'image/jpeg') {
      throw new BadRequestException('La firma va como imagen PNG o JPEG.');
    }
    // 1. Validar contra la fila antes de tocar el bucket.
    await this.tk.run(async (trx) => {
      const v = await this.bloquear(trx, id, userId, llaves);
      this.exigirFirma(v, body.role, userId, llaves);
    });
    // 2. Subir fuera de la transacción. 3. Registrar; si la base no confirma, se borra del bucket.
    const { key } = await this.storage.putBuffer(r.adjunto.buffer, r.adjunto.contentType, `vales/${id}`, `firma-${body.role}.png`);
    try {
      return await this.tk.run(async (trx) => {
        const v = await this.bloquear(trx, id, userId, llaves);
        this.exigirFirma(v, body.role, userId, llaves);
        const viva = await trx('platform.work_order_signatures').where({ work_order_id: id, role: body.role }).whereNull('deleted_at').first('id');
        if (viva) throw new ConflictException('Ese papel ya tiene firma: quítala primero si hay que repetirla.');
        await trx('platform.work_order_signatures').insert({
          tenant_id: trx.raw('public.current_tenant_id()'), work_order_id: id, role: body.role, signer_name: nombre,
          storage_key: key, mime: r.adjunto.contentType, size_bytes: r.adjunto.sizeBytes, captured_by: userId,
        });
        await this.evento(trx, id, 'signed', v.status, v.status, `${body.role}: ${nombre}`, userId);
        return this.detalleEn(trx, id, userId, llaves);
      });
    } catch (e) {
      await this.storage.remove(key).catch((err) => this.logger.warn(`No se pudo borrar ${key}: ${String(err)}`));
      throw e;
    }
  }

  /** Quita (aparta) una firma. Nunca de un vale completado: lo cobra un trigger (D8b). */
  async quitarFirma(id: string, firmaId: string, llaves: Llaves): Promise<ValeDetalle> {
    const userId = this.requireUser();
    this.idValido(id);
    this.idValido(firmaId);
    return this.tk.run(async (trx) => {
      const v = await this.bloquear(trx, id, userId, llaves);
      if (v.status === 'completed') throw new ConflictException('Una firma no se quita de un vale completado.');
      if (!(v.assigned_to === userId || llaves.gestionar)) throw new ForbiddenException('Quita una firma quien atiende el vale o quien coordina.');
      const n = await trx('platform.work_order_signatures').where({ id: firmaId, work_order_id: id }).whereNull('deleted_at')
        .update({ deleted_at: trx.fn.now(), deleted_by: userId });
      if (!n) throw new NotFoundException('Firma no encontrada.');
      await this.evento(trx, id, 'signature_removed', v.status, v.status, null, userId);
      return this.detalleEn(trx, id, userId, llaves);
    });
  }

  // ── Piezas ───────────────────────────────────────────────────────────────────────────────

  /** Una transición: bloquea la fila, aplica la regla del contrato y, si pasa, escribe. */
  private async accion(
    id: string, accion: AccionVale, llaves: Llaves,
    escribir: (trx: Knex.Transaction, v: FilaVale, userId: string) => Promise<void>,
    conCambios?: (v: FilaVale) => ValeParaReglas,
  ): Promise<ValeDetalle> {
    const userId = this.requireUser();
    this.idValido(id);
    return this.tk.run(async (trx) => {
      const v = await this.bloquear(trx, id, userId, llaves);
      const motivo = motivoNoPuede(accion, conCambios ? conCambios(v) : v, this.quien(userId, llaves));
      if (motivo) {
        // El estado del vale → 409 · falta el trabajo escrito → 400 · no le toca a esta persona → 403.
        if (/^(Sólo se|Este vale ya está cerrado)/.test(motivo)) throw new ConflictException(motivo);
        if (/^Escribe /.test(motivo)) throw new BadRequestException(motivo);
        throw new ForbiddenException(motivo);
      }
      await escribir(trx, v, userId);
      return this.detalleEn(trx, id, userId, llaves);
    });
  }

  /** La fila, BLOQUEADA, si esta persona la puede ver (404 si no: no se confirma que exista). */
  private async bloquear(trx: Knex.Transaction, id: string, userId: string, llaves: Llaves): Promise<FilaVale> {
    const v = (await trx('platform.work_orders as w').where('w.id', id).whereNull('w.deleted_at').forUpdate()
      .first('w.*', trx.raw(`0 AS firmas`))) as FilaVale | undefined;
    if (!v || !this.puedeVer(v, userId, llaves)) throw new NotFoundException('Vale no encontrado.');
    return v;
  }

  private puedeVer(v: Pick<FilaVale, 'requested_by' | 'assigned_to'>, userId: string, llaves: Llaves): boolean {
    return llaves.atender || llaves.gestionar || v.requested_by === userId || v.assigned_to === userId;
  }

  private exigirFirma(v: FilaVale, role: string, userId: string, llaves: Llaves): void {
    if (v.status === 'cancelled') throw new ConflictException('Un vale cancelado no se firma.');
    const ok = v.assigned_to === userId || llaves.gestionar || (role === 'received' && v.requested_by === userId);
    if (!ok) throw new ForbiddenException('Recoge la firma quien atiende el vale o quien coordina; quien lo pidió firma «recibido».');
  }

  private quien(userId: string, llaves: Llaves): QuienActua {
    return { user_id: userId, puede_atender: llaves.atender, puede_gestionar: llaves.gestionar };
  }

  private cambiosTrabajo(body: CambiosTrabajoVale): Record<string, string | boolean | null> {
    const out: Record<string, string | boolean | null> = {};
    for (const c of CAMPOS_TRABAJO) {
      if (body?.[c] !== undefined) out[c] = body[c] === null ? null : limpio(body[c], MAX_TEXTO) || null;
    }
    if (body?.needs_follow_up !== undefined) out['needs_follow_up'] = body.needs_follow_up === null ? null : body.needs_follow_up === true;
    return out;
  }

  private consulta(trx: Knex.Transaction): Knex.QueryBuilder {
    return trx('platform.work_orders as w').whereNull('w.deleted_at').select(
      'w.*',
      trx.raw(`(SELECT count(*)::int FROM platform.work_order_signatures s WHERE s.work_order_id = w.id AND s.deleted_at IS NULL) AS firmas`),
      trx.raw(`to_char(w.service_date, 'YYYY-MM-DD') AS service_date`),
    );
  }

  private resumen(f: FilaVale): ValeResumen {
    return {
      id: f.id, folio: f.folio, status: f.status, service_date: f.service_date, requesting_area: f.requesting_area,
      warehouse_code: f.warehouse_code, activity: f.activity, requester_name: f.requester_name,
      assignee_name: f.assignee_name, assigned_to: f.assigned_to, created_at: iso(f.created_at) as string,
      firmas: Number(f.firmas ?? 0), source: f.source,
    };
  }

  private async detalleEn(trx: Knex.Transaction, id: string, userId: string, llaves: Llaves): Promise<ValeDetalle> {
    const f = (await this.consulta(trx).where('w.id', id).first()) as FilaVale | undefined;
    if (!f || !this.puedeVer(f, userId, llaves)) throw new NotFoundException('Vale no encontrado.');
    const firmas = await trx('platform.work_order_signatures').where({ work_order_id: id }).whereNull('deleted_at')
      .orderBy('created_at').select('id', 'role', 'signer_name', 'storage_key', trx.raw(`to_char(signed_on, 'YYYY-MM-DD') AS signed_on`), 'signed_at');
    const firmasDetalle: FirmaVale[] = [];
    for (const s of firmas as { id: string; role: FirmaVale['role']; signer_name: string; storage_key: string; signed_on: string; signed_at: Date | null }[]) {
      firmasDetalle.push({
        id: s.id, role: s.role, signer_name: s.signer_name, signed_on: s.signed_on, signed_at: iso(s.signed_at),
        url: await this.storage.signedUrl(s.storage_key, 600).catch(() => null),
      });
    }
    const eventos = (await trx('platform.work_order_events as e')
      .leftJoin('identity.users as u', function (this: Knex.JoinClause) {
        this.on('u.id', '=', 'e.actor').andOn('u.tenant_id', '=', 'e.tenant_id');
      })
      .where('e.work_order_id', id).orderBy('e.at')
      .select('e.kind', 'e.from_status', 'e.to_status', 'e.note', trx.raw(`${NOMBRE('u')} AS actor_name`), 'e.at')) as
      (Omit<EventoVale, 'at'> & { at: Date })[];
    const q = this.quien(userId, llaves);
    const acciones = {} as Record<AccionVale, string | null>;
    for (const a of ACCIONES) acciones[a] = motivoNoPuede(a, f, q);
    // «Completar» desde la pantalla manda el trabajo en el mismo cuerpo: el botón no se apaga por falta de detalle.
    if (acciones.complete && /trabajo/.test(acciones.complete)) acciones.complete = null;
    return {
      ...this.resumen(f),
      location_detail: f.location_detail, requested_by: f.requested_by, supervisor_id: f.supervisor_id,
      supervisor_name: f.supervisor_name, work_detail: f.work_detail, materials_used: f.materials_used, outcome: f.outcome,
      follow_up_notes: f.follow_up_notes, general_notes: f.general_notes, needs_follow_up: f.needs_follow_up,
      started_at: iso(f.started_at), completed_at: iso(f.completed_at), cancelled_at: iso(f.cancelled_at),
      cancel_reason: f.cancel_reason, firmas_detalle: firmasDetalle,
      eventos: eventos.map((e) => ({ ...e, at: iso(e.at) as string })),
      acciones, puede_editar_trabajo: puedeEditarTrabajo(f, q),
      puede_firmar: f.status !== 'cancelled' && (f.assigned_to === userId || llaves.gestionar || f.requested_by === userId),
    };
  }

  private async evento(
    trx: Knex.Transaction, id: string, kind: string, from: EstadoVale | null, to: EstadoVale | null, note: string | null, actor: string,
  ): Promise<void> {
    await trx('platform.work_order_events').insert({
      tenant_id: trx.raw('public.current_tenant_id()'), work_order_id: id, kind, from_status: from, to_status: to, note, actor,
    });
  }

  private async nombreDe(trx: Knex.Transaction, userId: string): Promise<string | null> {
    const u = await trx('identity.users as u').where('u.id', userId).where('u.activo', true).whereNull('u.deleted_at')
      .first(trx.raw(`${NOMBRE('u')} AS nombre`));
    return (u as { nombre?: string } | undefined)?.nombre ?? null;
  }

  /** El nombre de una persona activa que tiene ALGUNA llave de vales (si no, no podría abrir lo que se le asigna). */
  private async nombreConLlave(trx: Knex.Transaction, userId: string): Promise<string | null> {
    const u = await trx('identity.users as u')
      .join('identity.role_permissions as rp', function (this: Knex.JoinClause) {
        this.on('rp.role_name', '=', 'u.role_name').andOn('rp.tenant_id', '=', 'u.tenant_id');
      })
      .where('u.id', userId).where('u.activo', true).whereNull('u.deleted_at').whereNull('rp.deleted_at')
      .where((w) => { for (const k of LLAVES_VALE) w.orWhereRaw(`rp.permissions -> ?::text = 'true'::jsonb`, [k]); })
      .first(trx.raw(`${NOMBRE('u')} AS nombre`));
    return (u as { nombre?: string } | undefined)?.nombre ?? null;
  }

  private requireUser(): string {
    const userId = this.tenantCtx.get()?.userId;
    if (!userId) throw new ForbiddenException('Hace falta una sesión con persona.');
    return userId;
  }

  private idValido(id: string): void {
    if (!UUID.test(id ?? '')) throw new BadRequestException('id inválido');
  }
}
