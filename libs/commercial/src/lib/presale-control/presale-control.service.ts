import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import type { Knex } from 'knex';
import { TenantKnexService, TenantContextService, ScopeService, branchKeySql } from '@megadulces/platform-core';
import type {
  PresaleCandidate,
  PresaleCandidatesResponse,
  PresaleDetail,
  PresaleLink,
  PresaleLinkBlock,
  PresaleLinkResponse,
  PresaleListResponse,
  PresaleOrderRow,
} from '@megadulces/contracts';
import { relojMx } from '../warehouse-orders/warehouse-orders.engine';
import {
  bloqueoDeLiga,
  claveCliente,
  compararRenglones,
  contarPorEtapa,
  etapaDe,
  estadoNotaCredito,
  MAX_REINTENTOS_ENTREGA,
  partesFolio,
  requiereDevolucion,
  semaforo,
  STATUS_EN_MESA,
  type RenglonDocumento,
  type RenglonPedido,
} from './presale-control.engine';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Ventana de lo YA cerrado que se sigue mostrando (entregado/cancelado), en días. */
const DIAS_CERRADOS_DEFAULT = 7;
/** Tope de filas de la lista. Si se alcanza, la respuesta lo DECLARA (`truncated`). */
const MAX_FILAS = 500;
/** Cuántos documentos candidatos se devuelven como máximo. */
const MAX_CANDIDATOS = 30;
/**
 * Cuántos documentos recientes se leen ANTES de ordenar por productos en común. Más que
 * `MAX_CANDIDATOS` a propósito: un cliente frecuente de mostrador puede tener muchos tickets desde
 * la captura, y cortar antes de ordenar dejaría fuera justo el que comparte los productos.
 */
const VENTANA_CANDIDATOS = 100;
/** Hasta cuántos días atrás se cuentan los documentos POSIBLES en la lista (no en la búsqueda). */
const DIAS_POSIBLES = 60;

type Partes = { sucursal: string; doc_prefix: string; folio: string };

/**
 * `[MCP.4.1]` Sucursal de KEPLER del almacén del pedido: `warehouses.kepler_code` (el crosswalk
 * canónico, mig 20260815130000) cuando es de 2 dígitos; si no, la llave canónica (`branchKeySql`).
 * Es la que se usa para buscar tickets: Morelia Madero corre Wincaja como `32` pero cobra en
 * Kepler como `07` (confirmado por Francisco, 2026-10-08).
 */
/** `[MCP.6]` Subconsulta: el pedido `o` tiene una entrega de conformidad registrada en una guía. */
const ENTREGADO_SQL = `SELECT 1 FROM commercial.load_guide_orders e0
                         WHERE e0.order_id = o.id AND e0.tenant_id = o.tenant_id AND e0.status = 'entregado'`;

/** `[MCP.7]` Veces que el pedido salió en una guía y volvió sin entregarse (cuenta para los reintentos). */
const FALLIDOS_SQL = `(SELECT count(*) FROM commercial.load_guide_orders f0
                          JOIN commercial.load_guides fg ON fg.id = f0.guide_id AND fg.tenant_id = f0.tenant_id
                         WHERE f0.order_id = o.id AND f0.tenant_id = o.tenant_id
                           AND f0.status IN ('regreso', 'no_entregado') AND fg.status <> 'cancelada')::int`;

const SUCURSAL_KEPLER_SQL =`CASE WHEN w.kepler_code ~ '^[0-9]{2}$' THEN w.kepler_code ELSE ${branchKeySql('w')} END`;

/**
 * `[MCP.1]` / `[MCP.4]` Mesa de Control de Preventa (Fase MCP, ADR-089).
 *
 * ── Qué es "preventa" (UNA definición) ───────────────────────────────────────────────────
 * `commercial.orders` con `requested_delivery_date` y `delivery_type = 'route'`: lo que levanta el
 * vendedor en `apps/vendor` (`place()` es quien decide "no aparta stock" por tener fecha). El
 * `is_preventa` de `list()` (autor `customer_b2b`, portal) es OTRA cosa y no entra aquí.
 *
 * ── El documento de Kepler NO se copia ──────────────────────────────────────────────────
 * Se lee en vivo de `analytics.erp_sale_tickets` / `_lines` (vistas sobre `kepler_ods`). Sólo la
 * liga es dato propio (`commercial.order_kepler_documents`).
 *
 * ⚠️ Esas vistas NO tienen RLS (su migración 20260918160000: "el consumidor filtra `tenant_id`
 * explícito"). Por eso TODA lectura de ellas lleva `tenant_id = ?`: sin eso, el pedido de otro
 * tenant con la misma clave de cliente vería y podría ligar tickets de Mega Dulces.
 *
 * ⚠️ Se filtran por las PARTES del folio (sucursal, prefijo, folio), nunca por `folio_digital`,
 * que es una concatenación y no usa índice (medido: 82/436 ms contra 10/9 ms).
 *
 * ── Alcance ──────────────────────────────────────────────────────────────────────────────
 * Por SUCURSAL, no por almacén: `ScopeService.readParam(query, 'warehouse')` da las llaves de 2
 * dígitos del alcance, y se comparan contra la sucursal Kepler del almacén del pedido Y contra su
 * llave canónica. `[MCP.4.1]` Filtrar por id de almacén vivo escondía los pedidos hechos contra un
 * almacén ya dado de baja (Morelia: `MD-32` se dio de baja el 2026-09-11 y lo reemplazó `07`).
 * `null` = sin recorte, `[]` = alcance vacío. Detalle, candidatos y liga validan el mismo alcance:
 * un pedido fuera de él responde 404, no 403, para no confirmar que existe.
 *
 * ── Declarado (ADR-056) ──────────────────────────────────────────────────────────────────
 * La CANCELACIÓN de un ticket de caja en Kepler no está decodificada: en `U-D-10`, `kdm1.c43` es el
 * estado de FACTURACIÓN (F/N/R/A, medido 2026-10-08: cero `C` en 30 días), no la cancelación de
 * los otros documentos. Hasta decodificarla, un ticket cancelado puede aparecer como candidato.
 */
@Injectable()
export class PresaleControlService {
  private readonly logger = new Logger(PresaleControlService.name);

  constructor(
    private readonly tk: TenantKnexService,
    private readonly tenantCtx: TenantContextService,
    private readonly scope: ScopeService,
  ) {}

  // ─────────────────────────────────────────────────────────────── lista ──

  async list(query: Record<string, unknown> | undefined): Promise<PresaleListResponse> {
    const hoy = relojMx(new Date()).fecha;
    const tenantId = this.tenantCtx.requireTenantId();
    const almacenes = await this.scope.readParam(query, 'warehouse', 'warehouse/presale');
    if (almacenes !== null && almacenes.length === 0) {
      return {
        data: [], count: 0, truncated: false, by_stage: contarPorEtapa([]), overdue: 0, scope: 'ninguno', today: hoy,
      };
    }
    const diasRaw = Number(query?.['closed_days']);
    const dias = Number.isFinite(diasRaw) && diasRaw >= 0 && diasRaw <= 90 ? Math.floor(diasRaw) : DIAS_CERRADOS_DEFAULT;

    return this.tk.run(async (trx) => {
      const filas = await this.leerPedidos(trx, { almacenes, diasCerrados: dias });
      const data = await this.completar(trx, tenantId, filas, hoy);
      return {
        data,
        count: data.length,
        truncated: filas.length >= MAX_FILAS,
        by_stage: contarPorEtapa(data.map((r) => r.stage)),
        overdue: data.filter((r) => r.due === 'vencido').length,
        scope: almacenes === null ? 'todos' : 'recortado',
        today: hoy,
      };
    });
  }

  // ───────────────────────────────────────────────────────────── detalle ──

  async detail(orderId: string, query?: Record<string, unknown>): Promise<PresaleDetail> {
    const hoy = relojMx(new Date()).fecha;
    const tenantId = this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx) => {
      const fila = await this.pedidoEnAlcance(trx, orderId, query);
      const [order] = await this.completar(trx, tenantId, [fila], hoy);

      const { rows: history } = await trx.raw(
        `SELECT h.from_status, h.to_status, h.changed_at, h.reason, h.changed_by_username
           FROM commercial.order_status_history h
          WHERE h.order_id = ?
          ORDER BY h.changed_at ASC`,
        [orderId],
      );

      const { rows: links } = await trx.raw(
        `SELECT d.sucursal, d.folio_digital, d.link_source, d.linked_at, d.unlinked_at, d.unlink_reason,
                u.nombre AS linked_by_name
           FROM commercial.order_kepler_documents d
           LEFT JOIN identity.users u ON u.id = d.linked_by AND u.tenant_id = d.tenant_id
          WHERE d.order_id = ?
          ORDER BY d.linked_at DESC`,
        [orderId],
      );
      // Los datos del documento (fecha, caja, total) se leen aparte y por partes del folio.
      const docs = await this.leerDocumentos(trx, tenantId, links.map((l: { folio_digital: string }) => l.folio_digital));

      const compare = order.link ? await this.comparar(trx, tenantId, orderId, order.link.folio_digital) : [];

      return {
        order,
        history: history.map((h: Record<string, unknown>) => ({
          from_status: (h['from_status'] as string) ?? null,
          to_status: h['to_status'] as string,
          changed_at: new Date(h['changed_at'] as string).toISOString(),
          reason: (h['reason'] as string) ?? null,
          changed_by_username: (h['changed_by_username'] as string) ?? null,
        })),
        compare,
        links: links.map((l: Record<string, unknown>) => ({
          ...this.mapLink({ ...l, ...(docs.get(l['folio_digital'] as string) ?? {}) }),
          unlinked_at: l['unlinked_at'] ? new Date(l['unlinked_at'] as string).toISOString() : null,
          unlink_reason: (l['unlink_reason'] as string) ?? null,
        })),
      };
    });
  }

  // ────────────────────────────────────────────────────────── candidatos ──

  /**
   * Documentos de Kepler del cliente que podrían ser el cobro del pedido: misma sucursal, misma
   * clave de cliente, desde el día de captura hasta hoy. Se ordenan por cuántos productos del
   * pedido traen (medido: el ticket correcto trae los mismos productos) y luego por fecha.
   * Los ya ligados a OTRO pedido vivo se devuelven marcados: se ven, no se eligen.
   */
  async candidates(orderId: string, query?: Record<string, unknown>): Promise<PresaleCandidatesResponse> {
    const hoy = relojMx(new Date()).fecha;
    const tenantId = this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx) => {
      const fila = await this.pedidoEnAlcance(trx, orderId, query);
      const desde = fila['created_date'] as string;
      const bloqueo = await this.bloqueo(trx, tenantId, fila);
      if (bloqueo) return { order_id: orderId, link_block: bloqueo, from: desde, to: hoy, data: [] };

      const data = await this.buscarCandidatos(trx, tenantId, fila, desde, hoy);
      return { order_id: orderId, link_block: null, from: desde, to: hoy, data };
    });
  }

  // ─────────────────────────────────────────────────────────── ligar ──

  async link(orderId: string, folioDigital: string, query?: Record<string, unknown>): Promise<PresaleLinkResponse> {
    const folio = String(folioDigital ?? '').trim();
    const partes = partesFolio(folio);
    if (!partes) throw new BadRequestException('folio_digital inválido (ej. 04UD1003-0002097)');
    const userId = this.tenantCtx.get()?.userId || null;
    if (!userId) throw new UnauthorizedException('Sin usuario en la sesión: la liga necesita autor.');
    const tenantId = this.tenantCtx.requireTenantId();
    const hoy = relojMx(new Date()).fecha;

    return this.tk.run(async (trx) => {
      const fila = await this.pedidoEnAlcance(trx, orderId, query, true);
      await this.sinEntregaEnGuia(trx, orderId);
      const viva = await this.ligaViva(trx, orderId);
      if (viva) {
        throw new ConflictException(`El pedido ya tiene el documento ${viva}. Corrígelo primero.`);
      }
      await this.ligarDocumento(trx, { fila, folio, partes, source: 'mesa', userId, tenantId, hoy });
      return { ok: true as const, order_id: orderId, folio_digital: folio };
    });
  }

  /**
   * `[MCP.6]` Liga el documento DESDE EL CELULAR, al entregar. El llamador ya validó que el pedido va
   * en una guía de quien entrega (no se usa el alcance de la mesa). Si el pedido ya tiene ESE
   * documento ligado (lo ligó la mesa) no hace nada; si tiene OTRO, se detiene: lo corrige la caja.
   */
  async ligarDesdeCampo(trx: Knex.Transaction, orderId: string, folioDigital: string, userId: string): Promise<string> {
    const folio = String(folioDigital ?? '').trim();
    const partes = partesFolio(folio);
    if (!partes) throw new BadRequestException('folio_digital inválido (ej. 04UD1003-0002097)');
    const [fila] = await this.leerPedidos(trx, { almacenes: null, orderId });
    if (!fila) throw new NotFoundException('Pedido de preventa no encontrado.');
    if (fila['status'] !== 'confirmed') {
      throw new ConflictException(`El pedido está ${fila['status'] as string}: no se entrega. Regrésalo a caja.`);
    }
    const viva = await this.ligaViva(trx, orderId);
    if (viva === folio) return folio;
    if (viva) {
      throw new ConflictException(`El pedido ya tiene ligado el documento ${viva}. Si no es el que entregas, pide en caja que lo corrijan.`);
    }
    await this.ligarDocumento(trx, {
      fila, folio, partes, source: 'celular', userId,
      tenantId: this.tenantCtx.requireTenantId(), hoy: relojMx(new Date()).fecha,
    });
    return folio;
  }

  /**
   * `[MCP.6]` Con el pedido ya entregado en su guía, la liga queda congelada: el cobro que registró
   * quien entregó es de ESE documento. Corregirla es devolución + NC en Kepler, no un cambio aquí.
   */
  private async sinEntregaEnGuia(trx: Knex.Transaction, orderId: string): Promise<void> {
    const e = await trx('commercial.load_guide_orders').where({ order_id: orderId, status: 'entregado' }).first('id');
    if (e) throw new ConflictException('El pedido ya se entregó con su documento: la liga ya no se cambia.');
  }

  private async ligaViva(trx: Knex.Transaction, orderId: string): Promise<string | null> {
    const viva = await trx('commercial.order_kepler_documents')
      .where({ order_id: orderId })
      .whereNull('unlinked_at')
      .first('folio_digital');
    return (viva?.folio_digital as string) ?? null;
  }

  /** Las validaciones de la liga, UNA sola vez para la mesa y el celular. */
  private async ligarDocumento(
    trx: Knex.Transaction,
    a: { fila: Record<string, unknown>; folio: string; partes: Partes; source: 'mesa' | 'celular'; userId: string; tenantId: string; hoy: string },
  ): Promise<void> {
    const { fila, folio, partes, source, userId, tenantId, hoy } = a;
    if (fila['status'] !== 'confirmed') {
      throw new ConflictException(`El pedido está ${fila['status'] as string}: sólo se liga un pedido confirmado.`);
    }
    const bloqueo = await this.bloqueo(trx, tenantId, fila);
    if (bloqueo) throw new ConflictException(`No se puede ligar: ${bloqueo}.`);

    // El documento tiene que ser UNO de los candidatos de este pedido: misma sucursal, mismo
    // cliente, desde la captura. Ligar un folio arbitrario cobraría el ticket de otra persona.
    const cands = await this.buscarCandidatos(trx, tenantId, fila, fila['created_date'] as string, hoy, partes);
    const c = cands.find((x) => x.folio_digital === folio);
    if (!c) {
      throw new BadRequestException('Ese documento no es de este cliente, de esta sucursal o es anterior al pedido.');
    }
    if (c.linked_to_order_code) {
      throw new ConflictException(`Ese documento ya está ligado al pedido ${c.linked_to_order_code}.`);
    }

    // Un documento que quedó ligado a un pedido CANCELADO se libera aquí, con autor y motivo.
    // Sin esto, una liga equivocada en un pedido que luego se canceló bloquearía el documento
    // para siempre (la llave única es sobre la liga viva, sin importar el estado del pedido).
    await trx('commercial.order_kepler_documents as d')
      .where('d.folio_digital', folio)
      .whereNull('d.unlinked_at')
      .whereExists(function () {
        this.select(trx.raw('1'))
          .from('commercial.orders as o')
          .whereRaw('o.id = d.order_id AND o.tenant_id = d.tenant_id')
          .andWhere('o.status', 'cancelled');
      })
      .update({
        unlinked_at: trx.fn.now(),
        unlinked_by: userId,
        unlink_reason: `Liberado al ligarlo a ${fila['code'] as string}: el pedido anterior está cancelado.`,
      });

    try {
      await trx('commercial.order_kepler_documents').insert({
        tenant_id: tenantId,
        order_id: fila['id'] as string,
        sucursal: c.sucursal,
        folio_digital: folio,
        link_source: source,
        linked_by: userId,
      });
    } catch (e) {
      // Carrera: otro usuario lo ligó entre la validación y el insert. La llave única lo frena.
      if (/ux_okd_|duplicate key/i.test((e as Error).message)) {
        throw new ConflictException('Ese documento o este pedido se acaban de ligar en otra pantalla.');
      }
      throw e;
    }
    this.logger.log(`[MCP.4] ${fila['code'] as string} ↔ ${folio} ligado desde ${source} por ${userId}`);
  }

  /** `[MCP.6]` Candidatos de Kepler de un pedido, para el celular (sin el alcance de la mesa). */
  async candidatosParaCampo(trx: Knex.Transaction, orderId: string): Promise<{ order: PresaleOrderRow; candidates: PresaleCandidate[] }> {
    const tenantId = this.tenantCtx.requireTenantId();
    const hoy = relojMx(new Date()).fecha;
    const [fila] = await this.leerPedidos(trx, { almacenes: null, orderId });
    if (!fila) throw new NotFoundException('Pedido de preventa no encontrado.');
    const [order] = await this.completar(trx, tenantId, [fila], hoy);
    const candidates = order.link_block ? [] : await this.buscarCandidatos(trx, tenantId, fila, fila['created_date'] as string, hoy);
    return { order, candidates };
  }

  /**
   * Corrige una liga equivocada. Se permite en `confirmed` y en `cancelled` (para liberar el
   * documento de un pedido que no se va a entregar); en `fulfilled` no, porque esa entrega ya se
   * cerró con ese documento.
   */
  async unlink(orderId: string, reason: string, query?: Record<string, unknown>): Promise<PresaleLinkResponse> {
    const motivo = String(reason ?? '').trim();
    if (motivo.length < 5) throw new BadRequestException('Escribe el motivo (mínimo 5 letras).');
    const userId = this.tenantCtx.get()?.userId || null;
    if (!userId) throw new UnauthorizedException('Sin usuario en la sesión: corregir la liga necesita autor.');

    return this.tk.run(async (trx) => {
      const fila = await this.pedidoEnAlcance(trx, orderId, query, true);
      await this.sinEntregaEnGuia(trx, orderId);
      if (fila['status'] !== 'confirmed' && fila['status'] !== 'cancelled') {
        throw new ConflictException(`El pedido está ${fila['status']}: su liga ya no se corrige aquí.`);
      }
      const n = await trx('commercial.order_kepler_documents')
        .where({ order_id: orderId })
        .whereNull('unlinked_at')
        .update({ unlinked_at: trx.fn.now(), unlinked_by: userId, unlink_reason: motivo });
      if (!n) throw new NotFoundException('El pedido no tiene documento ligado.');
      this.logger.log(`[MCP.4] ${fila['code'] as string} desligado por ${userId}: ${motivo}`);
      return { ok: true as const, order_id: orderId };
    });
  }

  // ─────────────────────────────────────────────────────────── internos ──

  /**
   * `[MCP.5]` Pedidos de preventa ya completos (etapa, documento, guía) para otros servicios del
   * mismo dominio — las guías de carga leen los pedidos por AQUÍ en vez de repetir la consulta.
   *
   *  · `soloAbiertos` — sólo `confirmed` (lo que todavía se puede cargar o entregar).
   *  · `autorId`      — sólo los que levantó ese vendedor (`orders.user_id`).
   *  · `orderIds`     — sólo esos pedidos.
   */
  async pedidosParaGuias(
    trx: Knex.Transaction,
    f: { almacenes: string[] | null; autorId?: string; orderIds?: string[]; soloAbiertos?: boolean; paraPescar?: boolean },
  ): Promise<PresaleOrderRow[]> {
    const tenantId = this.tenantCtx.requireTenantId();
    const hoy = relojMx(new Date()).fecha;
    const filas = await this.leerPedidos(trx, { ...f, diasCerrados: 0 });
    const pedidos = await this.completar(trx, tenantId, filas, hoy);
    // [MCP.7.1] Uno ya devuelto con NC en Kepler no se vuelve a llevar. (Se filtra aquí y no en el SQL:
    // la nota vive en el ODS y se lee por lote; los devueltos son pocos y no desplazan el tope de filas.)
    return f.paraPescar ? pedidos.filter((p) => p.stage !== 'devuelto') : pedidos;
  }

  /** Lee los pedidos de preventa con los hechos que necesita el motor. */
  private async leerPedidos(
    trx: Knex.Transaction,
    f: {
      almacenes: string[] | null;
      diasCerrados?: number;
      orderId?: string;
      autorId?: string;
      orderIds?: string[];
      soloAbiertos?: boolean;
      /**
       * `[MCP.5]` Sólo lo que se puede pescar: sin guía viva y con cliente dado de alta en Kepler.
       * Se filtra EN el SQL, antes del tope de filas: filtrarlo después dejaba que los pedidos ya
       * cargados o viejos ocuparan las 500 filas y escondieran los nuevos sin avisar.
       */
      paraPescar?: boolean;
    },
  ): Promise<Record<string, unknown>[]> {
    const params: Knex.RawBinding[] = [];
    let donde = '';
    if (f.orderId) {
      // Por id también se filtra el estado: un borrador no es un pedido de la mesa.
      donde += ' AND o.id = ? AND o.status = ANY(?::text[])';
      params.push(f.orderId, [...STATUS_EN_MESA]);
    } else if (f.soloAbiertos) {
      // `[MCP.6]` Abierto = confirmado y SIN entrega registrada (la entrega no toca `orders.status`).
      donde += ` AND o.status = 'confirmed' AND NOT EXISTS (${ENTREGADO_SQL})`;
    } else if (f.orderIds) {
      // Los pedidos de una guía se leen en cualquier estado de la mesa (uno ya entregado sigue en ella).
      donde += ' AND o.status = ANY(?::text[])';
      params.push([...STATUS_EN_MESA]);
    } else {
      // `[MCP.6]` Un pedido entregado en la guía sigue `confirmed`: cuenta como cerrado y sale de la
      // lista igual que un `fulfilled`, pasada la ventana de cerrados.
      donde += ` AND ((o.status = 'confirmed'
                       AND NOT EXISTS (${ENTREGADO_SQL} AND e0.delivered_at < now() - (? || ' days')::interval))
                 OR (o.status IN ('fulfilled', 'cancelled')
                     AND coalesce(o.fulfilled_at, o.cancelled_at, o.updated_at) >= now() - (? || ' days')::interval))`;
      const dias = String(f.diasCerrados ?? DIAS_CERRADOS_DEFAULT);
      params.push(dias, dias);
    }
    if (f.almacenes !== null) {
      // `f.almacenes` son llaves de sucursal (2 dígitos) del alcance, no ids de almacén.
      donde += ` AND ((${SUCURSAL_KEPLER_SQL}) = ANY(?::text[]) OR (${branchKeySql('w')}) = ANY(?::text[]))`;
      params.push(f.almacenes, f.almacenes);
    }
    if (f.autorId) {
      donde += ' AND o.user_id = ?';
      params.push(f.autorId);
    }
    if (f.orderIds) {
      donde += ' AND o.id = ANY(?::uuid[])';
      params.push(f.orderIds);
    }
    if (f.paraPescar) {
      donde += ` AND NULLIF(ltrim(btrim(c.erp_customer_code), '0'), '') IS NOT NULL
                 AND NOT EXISTS (SELECT 1 FROM commercial.load_guide_orders x
                                   JOIN commercial.load_guides xg ON xg.id = x.guide_id AND xg.tenant_id = x.tenant_id
                                  WHERE x.order_id = o.id AND x.tenant_id = o.tenant_id
                                    AND x.status = 'cargado' AND xg.status <> 'cancelada')
                 AND ${FALLIDOS_SQL} <= ?`;
      // [MCP.7] Agotó los reintentos (I2): ya no sale; va a devolución y NC en Kepler (D10).
      params.push(MAX_REINTENTOS_ENTREGA);
    }
    // Por ids no hay tope: son los de una guía (acotados por quien los pesca), y cortar ahí haría
    // que un pedido desapareciera de la guía y de su snapshot.
    params.push(f.orderIds ? 100000 : MAX_FILAS);

    const { rows } = await trx.raw(
      `SELECT o.id, o.code, o.status, o.customer_id, o.warehouse_id, o.total,
              o.created_at,
              to_char((o.created_at AT TIME ZONE 'America/Mexico_City')::date, 'YYYY-MM-DD') AS created_date,
              to_char(o.requested_delivery_date, 'YYYY-MM-DD') AS requested_delivery_date,
              c.name AS customer_name, c.erp_customer_code, c.erp_source_branch, c.sales_route,
              w.name AS warehouse_name, ${SUCURSAL_KEPLER_SQL} AS branch,
              u.nombre AS seller_name,
              (SELECT count(*) FROM commercial.order_lines ol WHERE ol.order_id = o.id)::int AS lines,
              (SELECT wo.stage FROM commercial.wave_orders wo
                WHERE wo.order_id = o.id ORDER BY wo.added_at DESC LIMIT 1) AS wave_stage,
              d.sucursal AS link_sucursal, d.folio_digital AS link_folio, d.link_source,
              d.linked_at, lu.nombre AS linked_by_name,
              lg.id AS guide_id, lg.folio AS guide_folio, lg.status AS guide_status, lg.rider_name AS guide_rider_name,
              en.delivered_at, en.delivery_outcome, en.delivery_note, en.cash_amount, en.transfer_amount,
              en.transfer_ref, en.guide_folio AS delivery_guide_folio, en.delivered_by_name,
              en.delivered_folio_digital,
              ${FALLIDOS_SQL} AS failed_attempts
         FROM commercial.orders o
         LEFT JOIN commercial.customers c ON c.id = o.customer_id AND c.tenant_id = o.tenant_id
         LEFT JOIN commercial.warehouses w ON w.id = o.warehouse_id AND w.tenant_id = o.tenant_id
         LEFT JOIN identity.users u ON u.id = o.user_id AND u.tenant_id = o.tenant_id
         LEFT JOIN commercial.order_kepler_documents d
           ON d.order_id = o.id AND d.tenant_id = o.tenant_id AND d.unlinked_at IS NULL
         LEFT JOIN identity.users lu ON lu.id = d.linked_by AND lu.tenant_id = d.tenant_id
         -- [MCP.5] La guía de carga en la que va cargado (a lo más una: llave ux_lgo_pedido_cargado).
         LEFT JOIN LATERAL (
           SELECT g.id, g.folio, g.status, ru.nombre AS rider_name
             FROM commercial.load_guide_orders lgo
             JOIN commercial.load_guides g ON g.id = lgo.guide_id AND g.tenant_id = lgo.tenant_id
             LEFT JOIN identity.users ru ON ru.id = g.rider_user_id AND ru.tenant_id = g.tenant_id
            WHERE lgo.order_id = o.id AND lgo.tenant_id = o.tenant_id AND lgo.status = 'cargado'
              AND g.status <> 'cancelada'
            LIMIT 1
         ) lg ON true
         -- [MCP.6] La entrega de conformidad (a lo más una: llave ux_lgo_pedido_entregado).
         LEFT JOIN LATERAL (
           SELECT e.delivered_at, e.delivery_outcome, e.delivery_note, e.cash_amount, e.transfer_amount,
                  e.transfer_ref, eg.folio AS guide_folio, eu.nombre AS delivered_by_name, e.delivered_folio_digital
             FROM commercial.load_guide_orders e
             JOIN commercial.load_guides eg ON eg.id = e.guide_id AND eg.tenant_id = e.tenant_id
             LEFT JOIN identity.users eu ON eu.id = e.delivered_by AND eu.tenant_id = e.tenant_id
            WHERE e.order_id = o.id AND e.tenant_id = o.tenant_id AND e.status = 'entregado'
            LIMIT 1
         ) en ON true
        WHERE o.requested_delivery_date IS NOT NULL
          AND o.delivery_type = 'route'
          AND o.deleted_at IS NULL
          ${donde}
        ORDER BY o.requested_delivery_date ASC, o.created_at ASC
        LIMIT ?`,
      params,
    );
    return rows;
  }

  /**
   * El pedido, sólo si es de preventa y está dentro del alcance. Si no, 404.
   *
   * Para escribir se valida PRIMERO el alcance y DESPUÉS se toma el candado: así quien no
   * alcanza el pedido no llega a bloquear la fila de otra sucursal.
   */
  private async pedidoEnAlcance(
    trx: Knex.Transaction,
    orderId: string,
    query: Record<string, unknown> | undefined,
    paraEscribir = false,
  ): Promise<Record<string, unknown>> {
    if (!UUID_RE.test(orderId)) throw new BadRequestException('id de pedido inválido');
    const almacenes = await this.scope.readParam(query, 'warehouse', 'warehouse/presale');
    if (almacenes !== null && almacenes.length === 0) throw new NotFoundException('Pedido no encontrado.');
    let [fila] = await this.leerPedidos(trx, { almacenes, orderId });
    if (!fila) throw new NotFoundException('Pedido de preventa no encontrado.');
    if (paraEscribir) {
      // Serializa ligar/desligar sobre el mismo pedido; se relee ya con el candado puesto.
      await trx.raw('SELECT 1 FROM commercial.orders WHERE id = ? FOR UPDATE', [orderId]);
      [fila] = await this.leerPedidos(trx, { almacenes, orderId });
      if (!fila) throw new NotFoundException('Pedido de preventa no encontrado.');
    }
    return fila;
  }

  /** Sucursales (llave de 2 dígitos) que publican tickets de Kepler en el ODS. Una consulta por sucursal. */
  private async sucursalesConDocumentos(trx: Knex.Transaction, tenantId: string, branches: string[]): Promise<Set<string>> {
    const out = new Set<string>();
    for (const b of branches) {
      const { rows } = await trx.raw(
        `SELECT 1 FROM analytics.erp_sale_tickets
          WHERE tenant_id = ? AND sucursal = ? AND fecha > current_date - 30 LIMIT 1`,
        [tenantId, b],
      );
      if (rows.length) out.add(b);
    }
    return out;
  }

  private async bloqueo(trx: Knex.Transaction, tenantId: string, fila: Record<string, unknown>): Promise<PresaleLinkBlock | null> {
    const branch = (fila['branch'] as string) ?? null;
    const conDocs = branch ? await this.sucursalesConDocumentos(trx, tenantId, [branch]) : new Set<string>();
    return bloqueoDeLiga({
      customer_erp_code: (fila['erp_customer_code'] as string) ?? null,
      customer_erp_branch: (fila['erp_source_branch'] as string) ?? null,
      branch,
      branch_has_documents: branch ? conDocs.has(branch) : false,
    });
  }

  /**
   * Lee fecha, caja y total de varios documentos, por las partes del folio (una consulta por
   * sucursal). Lo que no aparezca en el ODS simplemente no viene: el llamador lo deja en `null`.
   */
  private async leerDocumentos(
    trx: Knex.Transaction,
    tenantId: string,
    folios: string[],
  ): Promise<Map<string, { fecha: string; caja: number | null; total: string }>> {
    const out = new Map<string, { fecha: string; caja: number | null; total: string }>();
    const porSucursal = new Map<string, Partes[]>();
    for (const f of folios) {
      const p = partesFolio(f);
      if (p) porSucursal.set(p.sucursal, [...(porSucursal.get(p.sucursal) ?? []), p]);
    }
    for (const [suc, partes] of porSucursal) {
      const { rows } = await trx.raw(
        `SELECT t.folio_digital, to_char(t.fecha, 'YYYY-MM-DD') AS fecha, t.caja, t.total
           FROM analytics.erp_sale_tickets t
          WHERE t.tenant_id = ? AND t.sucursal = ?
            AND t.doc_prefix = ANY(?::text[]) AND t.folio = ANY(?::text[])`,
        [tenantId, suc, [...new Set(partes.map((p) => p.doc_prefix))], [...new Set(partes.map((p) => p.folio))]],
      );
      const pedidos = new Set(partes.map((p) => `${p.sucursal}${p.doc_prefix}-${p.folio}`));
      for (const r of rows as Array<{ folio_digital: string; fecha: string; caja: number | null; total: string }>) {
        if (pedidos.has(r.folio_digital)) out.set(r.folio_digital, r);
      }
    }
    return out;
  }

  /** Arma las filas del contrato: etapa, semáforo, bloqueo y conteo de documentos posibles. */
  private async completar(
    trx: Knex.Transaction,
    tenantId: string,
    filas: Record<string, unknown>[],
    hoy: string,
  ): Promise<PresaleOrderRow[]> {
    const branches = [...new Set(filas.map((f) => f['branch'] as string).filter(Boolean))];
    const conDocs = await this.sucursalesConDocumentos(trx, tenantId, branches);

    const base = filas.map((f) => {
      const ligado = !!f['link_folio'];
      const hechos = {
        status: f['status'] as string,
        wave_stage: (f['wave_stage'] as string) ?? null,
        ligado,
        customer_erp_code: claveCliente(f['erp_customer_code'] as string),
        en_guia_impresa: f['guide_status'] === 'impresa',
        entregado_en_guia: !!f['delivered_at'],
      };
      const stage = etapaDe(hechos);
      const sem = semaforo(f['requested_delivery_date'] as string, hoy, stage);
      const branch = (f['branch'] as string) ?? null;
      const link_block = bloqueoDeLiga({
        customer_erp_code: (f['erp_customer_code'] as string) ?? null,
        customer_erp_branch: (f['erp_source_branch'] as string) ?? null,
        branch,
        branch_has_documents: branch ? conDocs.has(branch) : false,
      });
      const link: PresaleLink | null = ligado
        ? this.mapLink({
            sucursal: f['link_sucursal'],
            folio_digital: f['link_folio'],
            link_source: f['link_source'],
            linked_at: f['linked_at'],
            linked_by_name: f['linked_by_name'],
          })
        : null;
      const row: PresaleOrderRow = {
        id: f['id'] as string,
        code: f['code'] as string,
        status: f['status'] as string,
        stage,
        customer_id: f['customer_id'] as string,
        customer_name: (f['customer_name'] as string) ?? null,
        customer_erp_code: claveCliente(f['erp_customer_code'] as string),
        warehouse_id: f['warehouse_id'] as string,
        warehouse_name: (f['warehouse_name'] as string) ?? null,
        branch,
        sales_route: (f['sales_route'] as string) ?? null,
        seller_name: (f['seller_name'] as string) ?? null,
        requested_delivery_date: f['requested_delivery_date'] as string,
        due: sem.due,
        days_late: sem.days_late,
        total: Number(f['total']),
        lines: Number(f['lines']),
        created_at: new Date(f['created_at'] as string).toISOString(),
        link,
        link_block,
        possible_documents: null,
        load_guide: f['guide_id']
          ? {
              id: f['guide_id'] as string,
              folio: f['guide_folio'] as string,
              status: f['guide_status'] as 'abierta' | 'impresa' | 'liquidada',
              rider_name: (f['guide_rider_name'] as string) ?? null,
            }
          : null,
        delivery: f['delivered_at']
          ? {
              delivered_at: new Date(f['delivered_at'] as string).toISOString(),
              delivered_by_name: (f['delivered_by_name'] as string) ?? null,
              outcome: f['delivery_outcome'] as 'completo' | 'con_diferencia',
              note: (f['delivery_note'] as string) ?? null,
              cash_amount: Number(f['cash_amount']),
              transfer_amount: Number(f['transfer_amount']),
              transfer_ref: (f['transfer_ref'] as string) ?? null,
              guide_folio: f['delivery_guide_folio'] as string,
              folio_digital: f['delivered_folio_digital'] as string,
            }
          : null,
        failed_attempts: Number(f['failed_attempts'] ?? 0),
        // Sólo un pedido abierto puede necesitar devolución: uno entregado o cancelado ya cerró.
        return_required: stage !== 'entregado' && stage !== 'cancelado' && requiereDevolucion(Number(f['failed_attempts'] ?? 0)),
        credit_note: null,
      };
      return { row, hechos, created_date: f['created_date'] as string };
    });

    // Documentos posibles: sólo para lo que sigue abierto, sin liga y sin bloqueo. Una consulta por
    // sucursal con todas las claves de cliente de esa sucursal. La ventana se acota a
    // `DIAS_POSIBLES`: un pedido olvidado hace meses no debe arrastrar todo el histórico de la
    // sucursal en cada carga de la lista (la búsqueda de candidatos sí mira desde la captura).
    const tope = (() => {
      const d = new Date(`${hoy}T12:00:00Z`);
      d.setUTCDate(d.getUTCDate() - DIAS_POSIBLES);
      return d.toISOString().slice(0, 10);
    })();
    const buscar = base.filter(
      (b) => !b.row.link && !b.row.link_block && b.row.status === 'confirmed' && b.row.customer_erp_code && b.row.branch,
    );
    const porBranch = new Map<string, typeof buscar>();
    for (const b of buscar) {
      const k = b.row.branch as string;
      porBranch.set(k, [...(porBranch.get(k) ?? []), b]);
    }
    for (const [branch, grupo] of porBranch) {
      const claves = [...new Set(grupo.map((g) => g.row.customer_erp_code as string))];
      const desdeGrupo = grupo.map((g) => g.created_date).sort()[0];
      const desde = desdeGrupo > tope ? desdeGrupo : tope;
      const { rows } = await trx.raw(
        `SELECT ltrim(btrim(t.cliente_code), '0') AS cliente, to_char(t.fecha, 'YYYY-MM-DD') AS fecha
           FROM analytics.erp_sale_tickets t
          WHERE t.tenant_id = ? AND t.sucursal = ?
            AND ltrim(btrim(t.cliente_code), '0') = ANY(?::text[])
            AND t.fecha >= ?::date
            AND NOT EXISTS (
                  SELECT 1 FROM commercial.order_kepler_documents d
                    JOIN commercial.orders o2 ON o2.id = d.order_id AND o2.tenant_id = d.tenant_id
                   WHERE d.tenant_id = t.tenant_id AND d.folio_digital = t.folio_digital
                     AND d.unlinked_at IS NULL AND o2.status <> 'cancelled')`,
        [tenantId, branch, claves, desde],
      );
      for (const g of grupo) {
        const desdePedido = g.created_date > tope ? g.created_date : tope;
        g.row.possible_documents = rows.filter(
          (r: { cliente: string; fecha: string }) => r.cliente === g.row.customer_erp_code && r.fecha >= desdePedido,
        ).length;
      }
    }

    // El documento ligado se lee en vivo (no se copió al ligar), por partes del folio.
    const ligados = base.filter((b) => b.row.link).map((b) => b.row.link as PresaleLink);
    const docs = await this.leerDocumentos(trx, tenantId, ligados.map((l) => l.folio_digital));
    for (const l of ligados) {
      const t = docs.get(l.folio_digital);
      if (t) {
        l.fecha = t.fecha;
        l.caja = t.caja == null ? null : Number(t.caja);
        l.total = Number(t.total);
      }
    }

    // [MCP.7.1] Notas de crédito / devoluciones que Kepler aplicó al ticket ligado (vía su factura).
    // Sólo cuentan las del MISMO cliente y posteriores al ticket. Si cubren todo el ticket el pedido
    // pasa a "devuelto" (cerrado); si cubren una parte se muestra y el pedido sigue abierto.
    const notas = await this.leerNotasCredito(trx, tenantId, ligados.map((l) => l.folio_digital));
    for (const b of base) {
      const l = b.row.link;
      if (!l || l.total == null) continue;
      const propias = (notas.get(l.folio_digital) ?? []).filter(
        (n) => claveCliente(n.cliente) === b.row.customer_erp_code && (!l.fecha || n.fecha >= l.fecha),
      );
      const acreditado = Math.round(propias.reduce((t, n) => t + n.importe, 0) * 100) / 100;
      const estado = estadoNotaCredito(acreditado, l.total);
      if (!estado) continue;
      b.row.credit_note = {
        status: estado,
        credited: acreditado,
        ticket_total: l.total,
        notes: propias.map((n) => ({ folio: n.nota_folio, factura: n.factura_folio, fecha: n.fecha, importe: n.importe, motivo: n.motivo })),
      };
      if (estado === 'saldado') {
        b.row.stage = etapaDe({ ...b.hechos, devuelto_nc: true });
        const sem = semaforo(b.row.requested_delivery_date, hoy, b.row.stage);
        b.row.due = sem.due;
        b.row.days_late = sem.days_late;
        if (b.row.stage === 'devuelto') b.row.return_required = false;
      }
    }
    return base.map((b) => b.row);
  }

  private async buscarCandidatos(
    trx: Knex.Transaction,
    tenantId: string,
    fila: Record<string, unknown>,
    desde: string,
    hasta: string,
    soloFolio?: Partes,
  ): Promise<PresaleCandidate[]> {
    const branch = fila['branch'] as string;
    const cliente = claveCliente(fila['erp_customer_code'] as string) as string;
    const params: Knex.RawBinding[] = [tenantId, branch, cliente, desde, hasta];
    let extra = '';
    if (soloFolio) {
      extra = ' AND t.doc_prefix = ? AND t.folio = ?';
      params.push(soloFolio.doc_prefix, soloFolio.folio);
    }
    params.push(VENTANA_CANDIDATOS);
    const { rows } = await trx.raw(
      `SELECT t.folio_digital, t.sucursal, t.doc_prefix, t.folio, to_char(t.fecha, 'YYYY-MM-DD') AS fecha,
              t.caja, t.total, t.cajero_nombre,
              (SELECT o2.code
                 FROM commercial.order_kepler_documents d
                 JOIN commercial.orders o2 ON o2.id = d.order_id AND o2.tenant_id = d.tenant_id
                WHERE d.tenant_id = t.tenant_id AND d.folio_digital = t.folio_digital
                  AND d.unlinked_at IS NULL AND o2.status <> 'cancelled'
                LIMIT 1) AS linked_to_order_code
         FROM analytics.erp_sale_tickets t
        WHERE t.tenant_id = ? AND t.sucursal = ?
          AND ltrim(btrim(t.cliente_code), '0') = ?
          AND t.fecha BETWEEN ?::date AND ?::date
          ${extra}
        ORDER BY t.fecha DESC, t.folio DESC
        LIMIT ?`,
      params,
    );
    if (!rows.length) return [];

    const { rows: prodPedido } = await trx.raw(
      `SELECT DISTINCT ol.product_id::text AS product_id FROM commercial.order_lines ol WHERE ol.order_id = ?`,
      [fila['id'] as string],
    );
    const enPedido = new Set(prodPedido.map((r: { product_id: string }) => r.product_id));
    const { rows: lineas } = await trx.raw(
      `SELECT l.folio_digital, l.product_id::text AS product_id
         FROM analytics.erp_sale_ticket_lines l
        WHERE l.tenant_id = ? AND l.sucursal = ?
          AND l.doc_prefix = ANY(?::text[]) AND l.folio = ANY(?::text[])`,
      [
        tenantId,
        branch,
        [...new Set(rows.map((r: { doc_prefix: string }) => r.doc_prefix))] as string[],
        [...new Set(rows.map((r: { folio: string }) => r.folio))] as string[],
      ],
    );
    const compartidos = new Map<string, Set<string>>();
    for (const l of lineas as Array<{ folio_digital: string; product_id: string | null }>) {
      if (l.product_id && enPedido.has(l.product_id)) {
        const s = compartidos.get(l.folio_digital) ?? new Set<string>();
        s.add(l.product_id);
        compartidos.set(l.folio_digital, s);
      }
    }

    return rows
      .map((r: Record<string, unknown>) => ({
        folio_digital: r['folio_digital'] as string,
        sucursal: r['sucursal'] as string,
        fecha: r['fecha'] as string,
        caja: r['caja'] == null ? null : Number(r['caja']),
        total: Number(r['total']),
        cashier_name: (r['cajero_nombre'] as string) ?? null,
        shared_products: compartidos.get(r['folio_digital'] as string)?.size ?? 0,
        order_products: enPedido.size,
        // El ya ligado a ESTE pedido no cuenta como "de otro".
        linked_to_order_code:
          r['linked_to_order_code'] && r['linked_to_order_code'] !== fila['code']
            ? (r['linked_to_order_code'] as string)
            : null,
      }))
      .sort(
        (a: PresaleCandidate, b: PresaleCandidate) =>
          b.shared_products - a.shared_products || (b.fecha ?? '').localeCompare(a.fecha ?? ''),
      )
      .slice(0, MAX_CANDIDATOS);
  }

  /**
   * Pedido contra documento por renglón.
   *
   * ⚠️ El precio del pedido sale de `line_subtotal / quantity` (neto de descuento de renglón, sin
   * impuesto), NO de `unit_price`, que es el precio de lista: Kepler cobra el precio ya
   * descontado, y comparar contra el de lista marcaría "precio" en cada renglón con promoción.
   * El descuento a nivel canasta (`basket_discount_amount`) no se reparte por renglón: queda fuera.
   */
  private async comparar(trx: Knex.Transaction, tenantId: string, orderId: string, folio: string) {
    const p = partesFolio(folio);
    if (!p) return [];
    const { rows: ped } = await trx.raw(
      `SELECT ol.product_id::text AS product_id, p.sku, p.nombre AS description,
              ol.quantity::float8 AS quantity,
              (CASE WHEN ol.quantity > 0 AND ol.line_subtotal IS NOT NULL
                    THEN ol.line_subtotal / ol.quantity ELSE ol.unit_price END)::float8 AS unit_price
         FROM commercial.order_lines ol
         LEFT JOIN catalog.products p ON p.id = ol.product_id
        WHERE ol.order_id = ?`,
      [orderId],
    );
    const { rows: doc } = await trx.raw(
      `SELECT l.product_id::text AS product_id, l.sku, l.descripcion AS description,
              l.cantidad::float8 AS cantidad, l.unidad, l.precio_unitario::float8 AS precio_unitario
         FROM analytics.erp_sale_ticket_lines l
        WHERE l.tenant_id = ? AND l.sucursal = ? AND l.doc_prefix = ? AND l.folio = ?`,
      [tenantId, p.sucursal, p.doc_prefix, p.folio],
    );
    return compararRenglones(ped as RenglonPedido[], doc as RenglonDocumento[]);
  }

  /**
   * `[MCP.7.1]` Notas de crédito de Kepler por ticket (folio digital), leídas en vivo del ODS con
   * `analytics.erp_ticket_credit_notes` (función: recibe el lote; ver su migración). El ODS es de
   * Mega Dulces: la función devuelve ese tenant y aquí se filtra por el que pregunta.
   */
  private async leerNotasCredito(
    trx: Knex.Transaction,
    tenantId: string,
    folios: string[],
  ): Promise<Map<string, Array<{ nota_folio: string; factura_folio: string; fecha: string; cliente: string; importe: number; motivo: string | null }>>> {
    const partes = [...new Set(folios)].map((f) => ({ f, p: partesFolio(f) })).filter((x) => !!x.p);
    const out = new Map<string, Array<{ nota_folio: string; factura_folio: string; fecha: string; cliente: string; importe: number; motivo: string | null }>>();
    if (!partes.length) return out;
    const { rows } = await trx.raw(
      `SELECT sucursal, ticket_caja, ticket_folio, nota_folio, factura_folio,
              to_char(fecha, 'YYYY-MM-DD') AS fecha, cliente, importe::float8 AS importe, motivo
         FROM analytics.erp_ticket_credit_notes(?::text[], ?::int[], ?::text[])
        WHERE tenant_id = ?`,
      [
        partes.map((x) => x.p!.sucursal),
        partes.map((x) => Number(x.p!.doc_prefix.slice(4))),
        partes.map((x) => x.p!.folio),
        tenantId,
      ],
    );
    for (const r of rows as Array<Record<string, unknown>>) {
      const folio = String(r['sucursal']) + 'UD10' + String(r['ticket_caja']).padStart(2, '0') + '-' + String(r['ticket_folio']);
      out.set(folio, [...(out.get(folio) ?? []), {
        nota_folio: r['nota_folio'] as string,
        factura_folio: r['factura_folio'] as string,
        fecha: r['fecha'] as string,
        cliente: r['cliente'] as string,
        importe: Number(r['importe']),
        motivo: (r['motivo'] as string) ?? null,
      }]);
    }
    return out;
  }

  private mapLink(l: Record<string, unknown>): PresaleLink {
    return {
      folio_digital: l['folio_digital'] as string,
      sucursal: l['sucursal'] as string,
      fecha: (l['fecha'] as string) ?? null,
      caja: l['caja'] == null ? null : Number(l['caja']),
      total: l['total'] == null ? null : Number(l['total']),
      link_source: l['link_source'] as 'mesa' | 'celular',
      linked_at: l['linked_at'] ? new Date(l['linked_at'] as string).toISOString() : '',
      linked_by_name: (l['linked_by_name'] as string) ?? null,
    };
  }
}

