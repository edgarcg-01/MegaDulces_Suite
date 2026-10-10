import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import type { Knex } from 'knex';
import { TenantKnexService, TenantContextService, ScopeService, branchName, branchKeySql } from '@megadulces/platform-core';
import { DENOMINACIONES_MXN, denomDe, totalDenominaciones } from '@megadulces/contracts';
import type {
  LoadGuide,
  LoadGuideLiquidation,
  LoadGuideLiquidationPreview,
  LoadGuideLiquidationsResponse,
  LoadGuideOrderRow,
  LoadGuidesResponse,
  PresaleLiquidateRequest,
  PresaleLiquidationPreviewRequest,
  PresaleDeliverRequest,
  PresaleFieldOrderDetail,
  PresaleFieldResponse,
  PresaleNotDeliveredRequest,
  PresaleOrderRow,
} from '@megadulces/contracts';
import { relojMx } from '../warehouse-orders/warehouse-orders.engine';
import { AnexoVentaService } from '../commercial-sales-documents/anexo-venta.service';
import { PresaleControlService } from './presale-control.service';
import { htmlGuiaCarga, pieGuiaCarga, type LoadGuideSnapshot } from './load-guide.pdf';
import { htmlLiquidacion, pieLiquidacion, type LiquidationSnapshot } from './load-guide-liquidation.pdf';
import { partesFolio, resumenLiquidacion } from './presale-control.engine';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
/** Tope de pedidos por petición de "pescar": una camioneta no lleva más en una vuelta. */
const MAX_POR_CARGA = 80;
const SIN_RUTA = 'SIN RUTA';
/** `[MCP.6]` Topes que la base aguanta: sin ellos un texto largo o un importe enorme dan error 500. */
const MAX_TEXTO = 500;
const MAX_REF = 60;
const MAX_IMPORTE = 9_999_999.99;
/** `[MCP.7]` Guías de un mismo regreso (una por ruta): un repartidor no trae más en una vuelta. */
const MAX_GUIAS_LIQUIDACION = 30;
/** `[MCP.7]` Tope de piezas por denominación en el arqueo. */
const MAX_PIEZAS = 100_000;
const c2 = (n: number) => Math.round(n * 100) / 100;

/** Quién pide, según `RolesGuard` (permisos y roles FRESCOS, no los del token). */
export interface QuienPide {
  /** Trae `REPARTO_ENTREGAR` (o es god): ve por sucursal. Si no, es vendedor y ve sólo lo suyo. */
  repartidor: boolean;
  /**
   * Modo god (también por rol complementario). Se resuelve AQUÍ y no con `ScopeService`, que sólo
   * mira el rol principal: `superuser` y `guillermo_lopez` son god por complemento y su rol
   * principal (`direccion`) les recortaría la escritura.
   */
  god: boolean;
}

type GuideRow = {
  id: string;
  folio: string;
  status: 'abierta' | 'impresa' | 'liquidada' | 'cancelada';
  rider_user_id: string;
  rider_name: string | null;
  branch: string;
  sales_route: string;
  business_date: string;
  printed_at: string | null;
  printed_by_name: string | null;
  print_count: number;
  liquidation_id: string | null;
  liquidation_folio: string | null;
};

/**
 * `[MCP.5]` Guías de carga de preventa (Fase MCP, ADR-089).
 *
 * El repartidor (o el vendedor) PESCA en su celular los pedidos que se lleva; la cajera imprime la
 * GUÍA DE CARGA por ruta que él firma (D8). Una guía ABIERTA por (repartidor, sucursal, ruta, día)
 * (D12, llave `ux_load_guides_abierta`). Al imprimirse se congela en `snapshot` y se reimprime
 * igual; lo que se pesque después de imprimirla va en una guía nueva.
 *
 * Los pedidos se leen con `PresaleControlService.pedidosParaGuias` (la misma consulta de la mesa),
 * para que etapa, documento y guía digan lo mismo en las dos pantallas.
 *
 * ── Candados ──────────────────────────────────────────────────────────────────────────────────
 * Primero se valida el ALCANCE con una lectura sin candado, y sólo después se toma el candado (así
 * nadie bloquea filas de otra sucursal). Orden fijo: pedidos → guía. Quitar e imprimir toman el
 * MISMO candado de la guía: si no, un pedido quitado mientras la caja imprime quedaba en el papel
 * firmado y libre a la vez (revisión independiente, 2026-10-08).
 *
 * ⚠️ Pescar NO entrega, NO factura y NO mueve inventario: sólo registra quién se lleva qué.
 */
@Injectable()
export class LoadGuideService {
  private readonly logger = new Logger(LoadGuideService.name);

  constructor(
    private readonly tk: TenantKnexService,
    private readonly tenantCtx: TenantContextService,
    private readonly scope: ScopeService,
    private readonly presale: PresaleControlService,
    private readonly pdf: AnexoVentaService,
  ) {}

  // ───────────────────────────────────────────────────────────── celular ──

  async campo(query: Record<string, unknown> | undefined, quien: QuienPide): Promise<PresaleFieldResponse> {
    const userId = this.usuario();
    const hoy = relojMx(new Date()).fecha;
    const filtro = await this.filtroCampo(query, quien, userId);
    return this.tk.run(async (trx) => {
      const available =
        filtro.almacenes !== null && filtro.almacenes.length === 0
          ? []
          : await this.presale.pedidosParaGuias(trx, { ...filtro, soloAbiertos: true, paraPescar: true });
      // Sus guías abiertas de CUALQUIER día (si la caja no imprimió ayer, siguen siendo suyas), las
      // impresas de hoy y las impresas de otro día que todavía tienen pedidos por entregar.
      const mine = await this.guias(trx, { riderId: userId, fecha: hoy, conAbiertas: true, conPendientes: true, branches: null });
      return { available, mine, source: quien.repartidor ? 'sucursal' : 'propios', today: hoy };
    });
  }

  /** Pesca pedidos: los agrega a su guía abierta de hoy de esa sucursal y ruta (la crea si no hay). */
  async cargar(orderIds: string[] | undefined, query: Record<string, unknown> | undefined, quien: QuienPide): Promise<PresaleFieldResponse> {
    const ids = [...new Set((orderIds ?? []).map((x) => String(x).trim()))];
    if (!ids.length) throw new BadRequestException('Elige al menos un pedido.');
    if (ids.length > MAX_POR_CARGA) throw new BadRequestException(`Máximo ${MAX_POR_CARGA} pedidos por vez.`);
    if (ids.some((x) => !UUID_RE.test(x))) throw new BadRequestException('Hay un id de pedido inválido.');
    const userId = this.usuario();
    const tenantId = this.tenantCtx.requireTenantId();
    const hoy = relojMx(new Date()).fecha;
    const filtro = await this.filtroCampo(query, quien, userId);

    await this.tk.run(async (trx) => {
      const leer = () =>
        filtro.almacenes !== null && filtro.almacenes.length === 0
          ? Promise.resolve([] as PresaleOrderRow[])
          : this.presale.pedidosParaGuias(trx, { ...filtro, orderIds: ids, soloAbiertos: true });

      // 1) Alcance, sin candado: sólo se bloquea lo que de verdad le toca.
      const visibles = await leer();
      const faltan = ids.filter((x) => !visibles.some((p) => p.id === x));
      if (faltan.length) {
        throw new NotFoundException(`${faltan.length} pedido(s) no están disponibles para ti (no existen, no son tuyos o ya se cerraron).`);
      }
      // 2) Candado sobre los pedidos (dos celulares no pescan el mismo) y relectura con el candado puesto.
      await trx.raw('SELECT 1 FROM commercial.orders WHERE id = ANY(?::uuid[]) FOR UPDATE', [ids]);
      const pedidos = await leer();
      if (pedidos.length !== ids.length) throw new ConflictException('Uno de esos pedidos cambió mientras lo pescabas: actualiza la lista.');

      const yaCargados = pedidos.filter((p) => p.load_guide);
      if (yaCargados.length) {
        throw new ConflictException(`Ya van en una guía: ${yaCargados.map((p) => `${p.code} (${p.load_guide?.folio})`).join(', ')}.`);
      }
      // [MCP.7] Agotó los reintentos (I2): no sale otra vez, va a devolución y NC en Kepler (D10).
      const agotados = pedidos.filter((p) => p.return_required);
      if (agotados.length) {
        throw new ConflictException(`Ya no salen: agotaron sus reintentos y van a devolución en Kepler: ${agotados.map((p) => p.code).join(', ')}.`);
      }
      const sinAlta = pedidos.filter((p) => p.stage === 'esperando_alta');
      if (sinAlta.length) {
        throw new ConflictException(`Cliente sin alta en Kepler, no se puede cargar: ${sinAlta.map((p) => p.code).join(', ')}.`);
      }
      const sinSucursal = pedidos.filter((p) => !p.branch);
      if (sinSucursal.length) {
        throw new ConflictException(`Pedido sin sucursal: ${sinSucursal.map((p) => p.code).join(', ')}.`);
      }

      // Una guía por sucursal y ruta (D12).
      const grupos = new Map<string, PresaleOrderRow[]>();
      for (const p of pedidos) {
        const k = `${p.branch}|${p.sales_route || SIN_RUTA}`;
        grupos.set(k, [...(grupos.get(k) ?? []), p]);
      }
      for (const [k, grupo] of grupos) {
        const [branch, ruta] = k.split('|');
        const guiaId = await this.guiaAbierta(trx, tenantId, userId, branch, ruta, hoy);
        try {
          await trx('commercial.load_guide_orders').insert(
            grupo.map((p) => ({ tenant_id: tenantId, guide_id: guiaId, order_id: p.id, added_by: userId })),
          );
        } catch (e) {
          if (/ux_lgo_pedido_cargado|duplicate key/i.test((e as Error).message)) {
            throw new ConflictException('Uno de esos pedidos se acaba de cargar en otra guía.');
          }
          throw e;
        }
        await trx('commercial.load_guides').where({ id: guiaId }).update({ updated_at: trx.fn.now(), updated_by: userId });
      }
      this.logger.log(`[MCP.5] ${userId} pescó ${pedidos.length} pedido(s) en ${grupos.size} guía(s)`);
    });
    return this.campo(query, quien);
  }

  /** Quita un pedido de su guía, sólo mientras la guía siga abierta (no impresa). */
  async descargar(orderId: string | undefined, query: Record<string, unknown> | undefined, quien: QuienPide): Promise<PresaleFieldResponse> {
    if (!orderId || !UUID_RE.test(orderId)) throw new BadRequestException('id de pedido inválido');
    const userId = this.usuario();
    await this.tk.run(async (trx) => {
      const fila = await this.renglonCargado(trx, orderId);
      if (!fila || fila.rider_user_id !== userId) throw new NotFoundException('Ese pedido no va en una guía tuya.');
      // Mismo candado que `imprimir`: o se quita antes de imprimir, o la impresión lo ve y no se quita.
      await trx.raw('SELECT 1 FROM commercial.load_guides WHERE id = ? FOR UPDATE', [fila.guide_id]);
      const ahora = await this.renglonCargado(trx, orderId);
      if (!ahora || ahora.guide_id !== fila.guide_id) throw new NotFoundException('Ese pedido ya no va en tu guía.');
      if (ahora.guide_status !== 'abierta') {
        throw new ConflictException(`La guía ${ahora.folio} ya se imprimió y firmaste. Si no lo entregas, avisa en caja al regresar para que lo registren.`);
      }
      await trx('commercial.load_guide_orders')
        .where({ id: ahora.id, status: 'cargado' })
        .update({ status: 'quitado', removed_at: trx.fn.now(), removed_by: userId });
    });
    return this.campo(query, quien);
  }

  // ──────────────────────────────────────────────────────────────── caja ──

  async listar(query: Record<string, unknown> | undefined, quien: QuienPide): Promise<LoadGuidesResponse> {
    const raw = String(query?.['date'] ?? '').trim();
    const fecha = DATE_RE.test(raw) ? raw : relojMx(new Date()).fecha;
    const branches = await this.sucursalesCaja(query, quien);
    if (branches !== null && branches.length === 0) return { data: [], date: fecha, scope: 'ninguno' };
    // Lo pendiente de liquidar (impresas de días anteriores) se suma sólo a la vista de HOY: al
    // consultar un día pasado se ve ese día, no lo que quedó pendiente después.
    const esHoy = fecha === relojMx(new Date()).fecha;
    const data = await this.tk.run((trx) => this.guias(trx, { fecha, conAbiertas: true, conSinLiquidar: esHoy, branches }));
    return { data, date: fecha, scope: branches === null ? 'todos' : 'recortado' };
  }

  /**
   * Imprime la guía. La primera vez la congela (`snapshot`, `impresa`); después reimprime desde esa
   * foto con la marca REIMPRESIÓN, para que la copia diga lo mismo que el papel que se firmó.
   *
   * El PDF se genera DENTRO de la transacción: si Chromium falla, la guía no queda como impresa y
   * el primer papel que de verdad se firma no sale marcado como reimpresión.
   */
  async imprimir(id: string, query: Record<string, unknown> | undefined, quien: QuienPide): Promise<{ pdf: Buffer; guia: LoadGuide }> {
    if (!UUID_RE.test(id)) throw new BadRequestException('id de guía inválido');
    const userId = this.usuario();
    const branches = await this.sucursalesCaja(query, quien);
    if (branches !== null && branches.length === 0) throw new NotFoundException('Guía no encontrada.');

    return this.tk.run(async (trx) => {
      // Alcance primero, sin candado; luego el candado y la relectura.
      const [visible] = await this.guias(trx, { id, branches });
      if (!visible) throw new NotFoundException('Guía no encontrada.');
      await trx.raw('SELECT 1 FROM commercial.load_guides WHERE id = ? FOR UPDATE', [id]);
      const sello = new Date().toLocaleString('es-MX', { timeZone: 'America/Mexico_City' });

      const estado = (await trx('commercial.load_guides').where({ id }).first('status', 'snapshot')) as
        | { status: string; snapshot: LoadGuideSnapshot | null }
        | undefined;
      if (!estado || estado.status === 'cancelada') throw new ConflictException('La guía está cancelada.');

      // Impresa o ya liquidada: se reimprime la misma foto que se firmó.
      if (estado.status === 'impresa' || estado.status === 'liquidada') {
        const snap = estado.snapshot as LoadGuideSnapshot;
        const pdf = await this.renderizar(snap, true, sello);
        await trx('commercial.load_guides').where({ id }).update({ print_count: trx.raw('print_count + 1'), updated_at: trx.fn.now() });
        const [reimpresa] = await this.guias(trx, { id, branches: null });
        return { pdf, guia: reimpresa };
      }

      // Un pedido que se canceló después de pescarlo sale de la guía: no se imprime ni se cobra.
      const cancelados = await trx('commercial.load_guide_orders as lgo')
        .join('commercial.orders as o', function () {
          this.on('o.id', '=', 'lgo.order_id').andOn('o.tenant_id', '=', 'lgo.tenant_id');
        })
        .where({ 'lgo.guide_id': id, 'lgo.status': 'cargado', 'o.status': 'cancelled' })
        .select('lgo.id', 'o.code');
      if (cancelados.length) {
        await trx('commercial.load_guide_orders')
          .whereIn('id', cancelados.map((c: { id: string }) => c.id))
          .update({ status: 'quitado', removed_at: trx.fn.now(), removed_by: userId, removed_reason: 'Pedido cancelado antes de imprimir la guía' });
        this.logger.log(`[MCP.5] guía ${id}: ${cancelados.length} pedido(s) cancelado(s) salieron antes de imprimir`);
      }

      const [g] = await this.guias(trx, { id, branches: null });
      const carga = g.orders.filter((o) => o.status === 'cargado');
      if (!carga.length) throw new ConflictException('La guía no tiene pedidos: no hay nada que imprimir.');
      const quienImprime = await trx('identity.users').where({ id: userId }).first('nombre');
      const snap: LoadGuideSnapshot = {
        version: 1,
        empresa: 'Mega Dulces',
        folio: g.folio,
        sucursal: g.branch,
        sucursal_nombre: g.branch_name,
        ruta: g.sales_route,
        repartidor: g.rider_name,
        fecha: g.business_date,
        impresa_en: new Date().toISOString(),
        impresa_por: quienImprime?.nombre ?? null,
        pedidos: carga.map((o) => ({
          code: o.code,
          cliente: o.customer_name,
          cliente_code: o.customer_erp_code,
          entrega: o.requested_delivery_date,
          folio_digital: o.folio_digital,
          document_total: o.document_total,
          total: o.total,
        })),
        total: g.total,
      };
      const pdf = await this.renderizar(snap, false, sello);
      await trx('commercial.load_guides').where({ id, status: 'abierta' }).update({
        status: 'impresa',
        snapshot: JSON.stringify(snap),
        printed_at: trx.fn.now(),
        printed_by: userId,
        print_count: 1,
        updated_at: trx.fn.now(),
        updated_by: userId,
      });
      const [impresa] = await this.guias(trx, { id, branches: null });
      this.logger.log(`[MCP.5] guía ${g.folio} impresa por ${userId} (${carga.length} pedidos)`);
      return { pdf, guia: impresa };
    });
  }

  /**
   * La caja registra que un pedido de una guía YA IMPRESA regresó sin entregarse (D10): el renglón
   * pasa a `regreso` con motivo y el pedido queda libre para salir otro día en otra guía. El papel
   * firmado no cambia (es lo que se llevó); la liquidación (MCP.7) lo descuenta.
   */
  async regreso(id: string, orderId: string | undefined, reason: string | undefined, query: Record<string, unknown> | undefined, quien: QuienPide): Promise<LoadGuidesResponse> {
    if (!UUID_RE.test(id) || !orderId || !UUID_RE.test(orderId)) throw new BadRequestException('id inválido');
    const motivo = String(reason ?? '').trim();
    if (motivo.length < 5) throw new BadRequestException('Escribe por qué no se entregó (mínimo 5 letras).');
    if (motivo.length > MAX_TEXTO) throw new BadRequestException(`El motivo es muy largo (máximo ${MAX_TEXTO} letras).`);
    const userId = this.usuario();
    const branches = await this.sucursalesCaja(query, quien);
    if (branches !== null && branches.length === 0) throw new NotFoundException('Guía no encontrada.');

    await this.tk.run(async (trx) => {
      const [visible] = await this.guias(trx, { id, branches });
      if (!visible) throw new NotFoundException('Guía no encontrada.');
      await trx.raw('SELECT 1 FROM commercial.load_guides WHERE id = ? FOR UPDATE', [id]);
      const g = await trx('commercial.load_guides').where({ id }).first('status', 'folio');
      if (g?.status !== 'impresa') throw new ConflictException('Sólo se registra el regreso en una guía impresa; si no se ha impreso, el repartidor lo quita desde su celular.');
      const n = await trx('commercial.load_guide_orders')
        .where({ guide_id: id, order_id: orderId, status: 'cargado' })
        .update({ status: 'regreso', removed_at: trx.fn.now(), removed_by: userId, removed_reason: motivo });
      if (!n) throw new NotFoundException('Ese pedido no va cargado en esta guía.');
      this.logger.log(`[MCP.5] guía ${g.folio as string}: pedido ${orderId} regresó sin entregar (${motivo})`);
    });
    return this.listar(query, quien);
  }

  // ──────────────────────────────────────────────────── entrega (MCP.6) ──

  /**
   * `[MCP.6]` Lo que ve el celular al abrir un pedido para entregarlo: el pedido, sus renglones y los
   * documentos de Kepler del cliente (el que comparte más productos primero). Sólo de un pedido que
   * va cargado en una guía de quien pregunta.
   */
  async detalleCampo(orderId: string, quien: QuienPide): Promise<PresaleFieldOrderDetail> {
    if (!UUID_RE.test(orderId)) throw new BadRequestException('id de pedido inválido');
    const userId = this.usuario();
    return this.tk.run(async (trx) => {
      const r = await this.renglonCargado(trx, orderId);
      if (!r || (!quien.god && r.rider_user_id !== userId)) throw new NotFoundException('Ese pedido no va en una guía tuya.');
      const { order, candidates } = await this.presale.candidatosParaCampo(trx, orderId);
      const { rows: lines } = await trx.raw(
        `SELECT p.sku, p.nombre AS description, ol.quantity::float8 AS quantity, ol.qty_unit AS unit
           FROM commercial.order_lines ol
           LEFT JOIN catalog.products p ON p.id = ol.product_id
          WHERE ol.order_id = ?
          ORDER BY ol.line_number`,
        [orderId],
      );
      return {
        order,
        guide: { id: r.guide_id, folio: r.folio, status: r.guide_status as 'abierta' | 'impresa' },
        lines: lines as PresaleFieldOrderDetail['lines'],
        candidates,
      };
    });
  }

  /**
   * `[MCP.6]` Entrega de conformidad. Liga el documento de Kepler que se entrega (origen `celular`)
   * y registra el resultado, el documento y lo cobrado en el renglón de la guía.
   *
   * ⛔ NO toca `orders.status`: `fulfilled` haría que el reintento de CFDI (FE.5) facturara otra vez
   * una venta que ya se cobró en Kepler, y `fulfill()` descontaría `commercial.stock`.
   *
   * Reintento seguro: si la red falló pero la entrega SÍ se guardó, repetirla responde bien.
   */
  async entregar(body: PresaleDeliverRequest | undefined, query: Record<string, unknown> | undefined, quien: QuienPide): Promise<PresaleFieldResponse> {
    const orderId = String(body?.order_id ?? '');
    if (!UUID_RE.test(orderId)) throw new BadRequestException('id de pedido inválido');
    const outcome = body?.outcome;
    if (outcome !== 'completo' && outcome !== 'con_diferencia') throw new BadRequestException('Indica si se entregó completo o con diferencia.');
    const nota = this.texto(body?.note, 'La nota');
    if (outcome === 'con_diferencia' && nota.length < 5) throw new BadRequestException('Escribe qué fue diferente (mínimo 5 letras).');
    const cash = this.importe(body?.cash_amount, 'efectivo');
    const transfer = this.importe(body?.transfer_amount, 'transferencia');
    const ref = String(body?.transfer_ref ?? '').trim();
    if (transfer > 0 && !ref) throw new BadRequestException('Una transferencia lleva su referencia.');
    if (ref.length > MAX_REF) throw new BadRequestException(`La referencia es muy larga (máximo ${MAX_REF} caracteres).`);
    const folioPedido = String(body?.folio_digital ?? '').trim();
    const userId = this.usuario();

    await this.tk.run(async (trx) => {
      const r = await this.tomarParaEntrega(trx, orderId, userId, quien, 'entregado');
      if (!r) return; // ya estaba entregado por quien pregunta: reintento
      if (r.order_status !== 'confirmed') {
        throw new ConflictException(`El pedido ${r.order_code} está ${r.order_status === 'cancelled' ? 'cancelado' : r.order_status}: no lo entregues, regrésalo a caja.`);
      }
      if (r.guide_status !== 'impresa') {
        throw new ConflictException(`Tu guía ${r.folio} no se ha impreso: pide en caja que la impriman y la firmas antes de entregar.`);
      }
      const folio = await this.presale.ligarDesdeCampo(trx, orderId, folioPedido, userId);
      const n = await trx('commercial.load_guide_orders')
        .where({ id: r.id, status: 'cargado' })
        .update({
          status: 'entregado',
          delivered_at: trx.fn.now(),
          delivered_by: userId,
          delivered_folio_digital: folio,
          delivery_outcome: outcome,
          delivery_note: nota || null,
          cash_amount: cash,
          transfer_amount: transfer,
          transfer_ref: transfer > 0 ? ref : null,
        });
      if (n !== 1) throw new ConflictException('Ese pedido cambió mientras lo entregabas: actualiza.');
      await trx('commercial.load_guides').where({ id: r.guide_id }).update({ updated_at: trx.fn.now(), updated_by: userId });
      this.logger.log(`[MCP.6] ${r.order_code} entregado (${outcome}) con ${folio} por ${userId}: efectivo ${cash}, transferencia ${transfer}`);
    });
    return this.campo(query, quien);
  }

  /** `[MCP.6]` No se pudo entregar (con motivo): el pedido queda libre para salir otro día (D10). */
  async noEntregado(body: PresaleNotDeliveredRequest | undefined, query: Record<string, unknown> | undefined, quien: QuienPide): Promise<PresaleFieldResponse> {
    const orderId = String(body?.order_id ?? '');
    if (!UUID_RE.test(orderId)) throw new BadRequestException('id de pedido inválido');
    const motivo = this.texto(body?.reason, 'El motivo');
    if (motivo.length < 5) throw new BadRequestException('Escribe por qué no se entregó (mínimo 5 letras).');
    const userId = this.usuario();

    await this.tk.run(async (trx) => {
      const r = await this.tomarParaEntrega(trx, orderId, userId, quien, 'no_entregado');
      if (!r) return; // reintento de lo mismo
      if (r.guide_status !== 'impresa') {
        throw new ConflictException('Tu guía no se ha impreso todavía: si no lo vas a llevar, quítalo de la guía.');
      }
      const n = await trx('commercial.load_guide_orders')
        .where({ id: r.id, status: 'cargado' })
        .update({ status: 'no_entregado', removed_at: trx.fn.now(), removed_by: userId, removed_reason: motivo });
      if (n !== 1) throw new ConflictException('Ese pedido cambió mientras lo registrabas: actualiza.');
      await trx('commercial.load_guides').where({ id: r.guide_id }).update({ updated_at: trx.fn.now(), updated_by: userId });
      this.logger.log(`[MCP.6] ${r.order_code} no se entregó: ${motivo}`);
    });
    return this.campo(query, quien);
  }

  /**
   * `[MCP.6]` Candados de la entrega, en el MISMO orden que pescar (pedido → guía), para no cruzarse
   * con la mesa (`link`/`unlink` bloquean el pedido) ni con quitar/imprimir/regreso (la guía).
   * Devuelve el renglón cargado ya con los candados puestos y releído, o `null` si quien pregunta
   * ya había registrado ESTO mismo (reintento después de una falla de red).
   */
  private async tomarParaEntrega(
    trx: Knex.Transaction,
    orderId: string,
    userId: string,
    quien: QuienPide,
    destino: 'entregado' | 'no_entregado',
  ) {
    const mio = (rider: string) => quien.god || rider === userId;
    const r = await this.renglonCargado(trx, orderId);
    if (!r || !mio(r.rider_user_id)) {
      const hecho = (await trx('commercial.load_guide_orders as lgo')
        .join('commercial.load_guides as g', function () {
          this.on('g.id', '=', 'lgo.guide_id').andOn('g.tenant_id', '=', 'lgo.tenant_id');
        })
        .where('lgo.order_id', orderId)
        .whereIn('lgo.status', ['entregado', 'no_entregado'])
        .orderBy('lgo.added_at', 'desc')
        .first('lgo.status', 'g.rider_user_id')) as { status: string; rider_user_id: string } | undefined;
      if (hecho && mio(hecho.rider_user_id)) {
        if (hecho.status === destino) return null;
        throw new ConflictException(hecho.status === 'entregado' ? 'Ya registraste la entrega de este pedido.' : 'Ya registraste que este pedido no se entregó.');
      }
      throw new NotFoundException('Ese pedido no va en una guía tuya.');
    }
    await trx.raw('SELECT 1 FROM commercial.orders WHERE id = ? FOR UPDATE', [orderId]);
    await trx.raw('SELECT 1 FROM commercial.load_guides WHERE id = ? FOR UPDATE', [r.guide_id]);
    const ahora = await this.renglonCargado(trx, orderId);
    if (!ahora || ahora.guide_id !== r.guide_id) throw new ConflictException('Ese pedido ya no va cargado en tu guía: actualiza.');
    const o = (await trx('commercial.orders').where({ id: orderId }).first('status', 'code')) as { status: string; code: string };
    return { ...ahora, order_status: o.status, order_code: o.code };
  }

  /** Un importe cobrado: número finito, no negativo, a centavos y que la columna aguante. Vacío = 0. */
  private importe(v: unknown, que: string): number {
    const n = v == null || v === '' ? 0 : Number(v);
    if (!Number.isFinite(n) || n < 0) throw new BadRequestException(`El importe en ${que} no es válido.`);
    if (n > MAX_IMPORTE) throw new BadRequestException(`El importe en ${que} es demasiado grande.`);
    return Math.round(n * 100) / 100;
  }

  private texto(v: unknown, que: string): string {
    const t = String(v ?? '').trim();
    if (t.length > MAX_TEXTO) throw new BadRequestException(`${que} pasa del máximo de ${MAX_TEXTO} letras.`);
    return t;
  }

  // ──────────────────────────────────────────────── liquidación (MCP.7) ──

  /**
   * `[MCP.7]` Lo que la caja revisa antes de contar: las guías de un regreso, lo entregado y lo
   * declarado. Dice por qué no se puede liquidar, en vez de dejarlo descubrir al confirmar.
   */
  async previewLiquidacion(
    body: PresaleLiquidationPreviewRequest | undefined,
    query: Record<string, unknown> | undefined,
    quien: QuienPide,
  ): Promise<LoadGuideLiquidationPreview> {
    const ids = this.idsGuias(body?.guide_ids);
    const branches = await this.sucursalesCaja(query, quien);
    if (branches !== null && branches.length === 0) throw new NotFoundException('Guía no encontrada.');
    return this.tk.run((trx) => this.armarPreview(trx, ids, branches));
  }

  /**
   * `[MCP.7]` Liquida un regreso (D9/D11): cuenta el efectivo por denominación contra lo que quien
   * entregó declaró, registra la diferencia (con nota si no cuadra), cierra las guías y devuelve el
   * comprobante en PDF para firmar. El PDF se hace DENTRO de la transacción: si falla, no se liquida.
   */
  async liquidar(
    body: PresaleLiquidateRequest | undefined,
    query: Record<string, unknown> | undefined,
    quien: QuienPide,
  ): Promise<{ pdf: Buffer; liquidacion: LoadGuideLiquidation }> {
    const ids = this.idsGuias(body?.guide_ids);
    const conteo = this.conteo(body?.cash_breakdown);
    const notas = this.texto(body?.notes, 'La nota');
    const userId = this.usuario();
    const tenantId = this.tenantCtx.requireTenantId();
    const hoy = relojMx(new Date()).fecha;
    const branches = await this.sucursalesCaja(query, quien);
    if (branches !== null && branches.length === 0) throw new NotFoundException('Guía no encontrada.');

    return this.tk.run(async (trx) => {
      // Alcance sin candado; luego el candado de las guías, en orden fijo (dos cajas a la vez no
      // se bloquean cruzado), y la relectura con el candado puesto.
      const visibles = await this.guias(trx, { ids, branches });
      if (visibles.length !== ids.length) throw new NotFoundException('Alguna guía no existe o no es de tu sucursal.');
      await trx.raw('SELECT 1 FROM commercial.load_guides WHERE id = ANY(?::uuid[]) ORDER BY id FOR UPDATE', [ids]);
      const p = await this.armarPreview(trx, ids, null);
      if (p.blocked_reason) throw new ConflictException(p.blocked_reason);
      // Separación de funciones: quien entregó no recibe su propio dinero (salvo modo god).
      if (!quien.god && p.rider_user_id === userId) {
        throw new ForbiddenException('No puedes liquidar tu propia vuelta: la recibe otra persona de caja.');
      }
      // Lo que la caja vio al contar tiene que ser lo que se cierra: si alguien registró una entrega
      // mientras tanto, se revisa antes de firmar.
      if (c2(Number(body?.expected_declared_cash)) !== p.declared_cash || c2(Number(body?.expected_declared_transfer)) !== p.declared_transfer) {
        throw new ConflictException('Lo declarado cambió mientras contabas (se registró otra entrega). Revisa las cifras y vuelve a confirmar.');
      }

      const contado = c2(conteo.total);
      const diferencia = c2(contado - p.declared_cash);
      if ((diferencia !== 0 || p.unexplained_difference !== 0) && notas.length < 5) {
        const partes: string[] = [];
        if (diferencia !== 0) partes.push(`el efectivo ${diferencia < 0 ? 'falta' : 'sobra'} $${Math.abs(diferencia).toFixed(2)}`);
        if (p.unexplained_difference !== 0) partes.push(`hay $${Math.abs(p.unexplained_difference).toFixed(2)} entre lo que cobró Kepler y lo declarado sin explicar`);
        throw new BadRequestException(`No cuadra: ${partes.join(' y ')}. Escribe la nota (mínimo 5 letras).`);
      }

      const year = Number(hoy.slice(0, 4));
      const { rows: seq } = await trx.raw(
        `INSERT INTO commercial.load_guide_liquidation_sequences (tenant_id, year, current_value)
         VALUES (?, ?, 1)
         ON CONFLICT (tenant_id, year)
         DO UPDATE SET current_value = commercial.load_guide_liquidation_sequences.current_value + 1, updated_at = now()
         RETURNING current_value`,
        [tenantId, year],
      );
      const folio = `LQP-${year}-${String(seq[0].current_value).padStart(5, '0')}`;
      const quienLiquida = await trx('identity.users').where({ id: userId }).first('nombre');

      const snap: LiquidationSnapshot = {
        version: 1,
        empresa: 'Mega Dulces',
        folio,
        sucursal: p.branch,
        sucursal_nombre: branchName(p.branch) || null,
        repartidor: p.rider_name,
        liquidada_por: quienLiquida?.nombre ?? null,
        liquidada_en: new Date().toISOString(),
        fecha: hoy,
        guias: p.guides.map((g) => ({ folio: g.folio, ruta: g.sales_route })),
        pedidos: p.guides.flatMap((g) =>
          g.orders
            .filter((o) => o.status !== 'cargado')
            .map((o) => ({
              guia: g.folio,
              code: o.code,
              cliente: o.customer_name,
              folio_digital: o.folio_digital,
              estado: o.status as 'entregado' | 'no_entregado' | 'regreso',
              resultado: o.delivery_outcome,
              document_total: o.document_total,
              pedido_total: o.total,
              efectivo: o.cash_amount,
              transferencia: o.transfer_amount,
              referencia: o.transfer_ref,
              nota: o.status === 'entregado' ? o.delivery_note : o.removed_reason,
            })),
        ),
        documents_total: p.documents_total,
        documentos_sin_total: p.documents_without_total,
        declared_cash: p.declared_cash,
        declared_transfer: p.declared_transfer,
        counted_cash: contado,
        cash_difference: diferencia,
        por_cobrar: p.pending_collection,
        sin_explicar: p.unexplained_difference,
        conteo: DENOMINACIONES_MXN.map((d) => ({
          label: `${d.label}${d.familia === 'moneda' ? ' moneda' : ''}`,
          piezas: conteo.piezas[d.key] ?? 0,
          importe: c2((conteo.piezas[d.key] ?? 0) * d.valor),
        })),
        notas: notas || null,
      };

      const [liq] = await trx('commercial.load_guide_liquidations')
        .insert({
          tenant_id: tenantId,
          folio,
          rider_user_id: p.rider_user_id,
          branch: p.branch,
          business_date: hoy,
          documents_total: p.documents_total,
          declared_cash: p.declared_cash,
          declared_transfer: p.declared_transfer,
          counted_cash: contado,
          cash_breakdown: JSON.stringify(conteo.piezas),
          cash_difference: diferencia,
          unexplained_difference: p.unexplained_difference,
          notes: notas || null,
          snapshot: JSON.stringify(snap),
          liquidated_by: userId,
        })
        .returning('id');
      const liqId = (liq as { id: string }).id;
      const n = await trx('commercial.load_guides')
        .whereIn('id', ids)
        .andWhere('status', 'impresa')
        .update({ status: 'liquidada', liquidation_id: liqId, updated_at: trx.fn.now(), updated_by: userId });
      if (n !== ids.length) throw new ConflictException('Una de las guías cambió mientras se liquidaba: actualiza.');

      const sello = new Date().toLocaleString('es-MX', { timeZone: 'America/Mexico_City' });
      const pdf = await this.pdf.renderPdf(htmlLiquidacion(snap, { reimpresion: false }), pieLiquidacion(folio, 'liquidada ' + sello));
      const [liquidacion] = await this.leerLiquidaciones(trx, { id: liqId, branches: null });
      this.logger.log(`[MCP.7] ${folio}: ${ids.length} guía(s) de ${p.rider_user_id}, contado ${contado} vs declarado ${p.declared_cash} (dif ${diferencia})`);
      return { pdf, liquidacion };
    });
  }

  /** `[MCP.7]` Las liquidaciones de un día (default hoy) de las sucursales de mi alcance. */
  async liquidaciones(query: Record<string, unknown> | undefined, quien: QuienPide): Promise<LoadGuideLiquidationsResponse> {
    const raw = String(query?.['date'] ?? '').trim();
    const fecha = DATE_RE.test(raw) ? raw : relojMx(new Date()).fecha;
    const branches = await this.sucursalesCaja(query, quien);
    if (branches !== null && branches.length === 0) return { data: [], date: fecha };
    const data = await this.tk.run((trx) => this.leerLiquidaciones(trx, { fecha, branches }));
    return { data, date: fecha };
  }

  /** `[MCP.7]` Reimprime el comprobante desde su foto, marcado REIMPRESIÓN. */
  async reimprimirLiquidacion(id: string, query: Record<string, unknown> | undefined, quien: QuienPide): Promise<{ pdf: Buffer; liquidacion: LoadGuideLiquidation }> {
    if (!UUID_RE.test(id)) throw new BadRequestException('id de liquidación inválido');
    const branches = await this.sucursalesCaja(query, quien);
    if (branches !== null && branches.length === 0) throw new NotFoundException('Liquidación no encontrada.');
    return this.tk.run(async (trx) => {
      const [visible] = await this.leerLiquidaciones(trx, { id, branches });
      if (!visible) throw new NotFoundException('Liquidación no encontrada.');
      const fila = (await trx('commercial.load_guide_liquidations').where({ id }).first('snapshot')) as { snapshot: LiquidationSnapshot };
      const sello = new Date().toLocaleString('es-MX', { timeZone: 'America/Mexico_City' });
      const pdf = await this.pdf.renderPdf(
        htmlLiquidacion(fila.snapshot, { reimpresion: true, reimpresa_en: sello }),
        pieLiquidacion(visible.folio, 'reimpresa ' + sello),
      );
      await trx('commercial.load_guide_liquidations').where({ id }).update({ print_count: trx.raw('print_count + 1') });
      const [liquidacion] = await this.leerLiquidaciones(trx, { id, branches: null });
      return { pdf, liquidacion };
    });
  }

  private async armarPreview(trx: Knex.Transaction, ids: string[], branches: string[] | null): Promise<LoadGuideLiquidationPreview> {
    const guides = await this.guias(trx, { ids, branches });
    if (guides.length !== ids.length) throw new NotFoundException('Alguna guía no existe o no es de tu sucursal.');
    const renglones = guides.flatMap((g) => g.orders);
    const r = resumenLiquidacion(renglones);
    // La AUTORIDAD son los renglones crudos de las guías: la lista de arriba pasa por la consulta
    // de la mesa, que deja fuera un pedido borrado o que ya no es de preventa. Si no coinciden, no
    // se liquida a ciegas (revisión independiente, 2026-10-10).
    const { rows: crudo } = await trx.raw(
      `SELECT count(*) FILTER (WHERE status = 'cargado')::int AS cargados,
              count(*) FILTER (WHERE status = 'entregado')::int AS entregados,
              coalesce(sum(cash_amount) FILTER (WHERE status = 'entregado'), 0)::float8 AS efectivo,
              coalesce(sum(transfer_amount) FILTER (WHERE status = 'entregado'), 0)::float8 AS transferencia
         FROM commercial.load_guide_orders
        WHERE guide_id = ANY(?::uuid[])`,
      [ids],
    );
    const c = crudo[0] as { cargados: number; entregados: number; efectivo: number; transferencia: number };
    const cancelados = renglones.filter((o) => o.status === 'cargado' && o.order_cancelled);

    let blocked: string | null = null;
    if (new Set(guides.map((g) => g.rider_user_id)).size > 1) {
      blocked = 'Las guías son de distintas personas: se liquida el regreso de una persona a la vez.';
    } else if (new Set(guides.map((g) => g.branch)).size > 1) {
      blocked = 'Las guías son de distintas sucursales.';
    } else {
      const noLista = guides.filter((g) => g.status !== 'impresa');
      if (noLista.length) {
        blocked = noLista
          .map((g) => (g.status === 'liquidada' ? `La guía ${g.folio} ya se liquidó (${g.liquidation?.folio ?? '—'}).` : `La guía ${g.folio} no se ha impreso.`))
          .join(' ');
      } else if (c.cargados !== r.pendientes || c.entregados !== r.entregados) {
        blocked = 'Hay pedidos en estas guías que la mesa ya no muestra (borrados o modificados). No se puede liquidar a ciegas: avisa a sistemas.';
      } else if (cancelados.length) {
        blocked = `${cancelados.map((o) => o.code).join(', ')} se ${cancelados.length === 1 ? 'canceló' : 'cancelaron'} después de imprimir la guía: registra su regreso antes de liquidar.`;
      } else if (r.pendientes) {
        blocked = `${r.pendientes} ${r.pendientes === 1 ? 'pedido sigue' : 'pedidos siguen'} en camino: registra si se entregó o su regreso antes de liquidar.`;
      }
    }

    return {
      rider_user_id: guides[0].rider_user_id,
      rider_name: guides[0].rider_name,
      branch: guides[0].branch,
      guides,
      documents_total: r.documents_total,
      documents_without_total: r.documentos_sin_total,
      delivered: r.entregados,
      not_delivered: r.no_entregados,
      pending: c.cargados,
      declared_cash: c2(c.efectivo),
      declared_transfer: c2(c.transferencia),
      pending_collection: r.por_cobrar,
      unexplained_difference: r.sin_explicar,
      transfers: renglones
        .filter((o) => o.status === 'entregado' && Number(o.transfer_amount ?? 0) > 0)
        .map((o) => ({
          order_code: o.code,
          customer_name: o.customer_name,
          folio_digital: o.folio_digital,
          amount: Number(o.transfer_amount),
          ref: o.transfer_ref,
        })),
      blocked_reason: blocked,
    };
  }

  private async leerLiquidaciones(
    trx: Knex.Transaction,
    f: { id?: string; fecha?: string; branches: string[] | null },
  ): Promise<LoadGuideLiquidation[]> {
    let qb = trx('commercial.load_guide_liquidations as l')
      .leftJoin('identity.users as ru', function () {
        this.on('ru.id', '=', 'l.rider_user_id').andOn('ru.tenant_id', '=', 'l.tenant_id');
      })
      .leftJoin('identity.users as lu', function () {
        this.on('lu.id', '=', 'l.liquidated_by').andOn('lu.tenant_id', '=', 'l.tenant_id');
      });
    if (f.id) qb = qb.where('l.id', f.id);
    if (f.fecha) qb = qb.where('l.business_date', f.fecha);
    if (f.branches !== null) qb = qb.whereIn('l.branch', f.branches);
    const rows = (await qb
      .select(
        'l.id', 'l.folio', 'l.rider_user_id', 'ru.nombre as rider_name', 'l.branch',
        trx.raw(`to_char(l.business_date, 'YYYY-MM-DD') AS business_date`),
        'l.documents_total', 'l.declared_cash', 'l.declared_transfer', 'l.counted_cash', 'l.cash_difference', 'l.unexplained_difference',
        'l.notes', 'l.liquidated_at', 'lu.nombre as liquidated_by_name', 'l.print_count',
        trx.raw(`(SELECT coalesce(array_agg(g.folio ORDER BY g.folio), '{}') FROM commercial.load_guides g
                   WHERE g.liquidation_id = l.id AND g.tenant_id = l.tenant_id) AS guide_folios`),
      )
      .orderBy('l.liquidated_at', 'desc')
      .limit(300)) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      id: r['id'] as string,
      folio: r['folio'] as string,
      rider_user_id: r['rider_user_id'] as string,
      rider_name: (r['rider_name'] as string) ?? null,
      branch: r['branch'] as string,
      business_date: r['business_date'] as string,
      guide_folios: (r['guide_folios'] as string[]) ?? [],
      documents_total: Number(r['documents_total']),
      declared_cash: Number(r['declared_cash']),
      declared_transfer: Number(r['declared_transfer']),
      counted_cash: Number(r['counted_cash']),
      cash_difference: Number(r['cash_difference']),
      unexplained_difference: Number(r['unexplained_difference']),
      notes: (r['notes'] as string) ?? null,
      liquidated_at: new Date(r['liquidated_at'] as string).toISOString(),
      liquidated_by_name: (r['liquidated_by_name'] as string) ?? null,
      print_count: Number(r['print_count']) || 0,
    }));
  }

  /**
   * `[MCP.7]` Total (con impuestos) de documentos de Kepler por folio digital, leído en vivo del ODS.
   * La vista no tiene RLS: se filtra el tenant aquí. Se busca por las partes del folio (sucursal,
   * prefijo, folio), que es lo que usa el índice; por `folio_digital` costaba 40× más (MCP.4).
   */
  private async totalesDocumentos(trx: Knex.Transaction, folios: string[]): Promise<Map<string, number | null>> {
    const partes = [...new Set(folios)].map((f) => partesFolio(f)).filter((p): p is NonNullable<typeof p> => !!p);
    if (!partes.length) return new Map();
    const { rows } = await trx.raw(
      `SELECT t.folio_digital, t.total::float8 AS total
         FROM analytics.erp_sale_tickets t
         JOIN unnest(?::text[], ?::text[], ?::text[]) AS k(s, p, f)
           ON t.sucursal = k.s AND t.doc_prefix = k.p AND t.folio = k.f
        WHERE t.tenant_id = ?`,
      [partes.map((p) => p.sucursal), partes.map((p) => p.doc_prefix), partes.map((p) => p.folio), this.tenantCtx.requireTenantId()],
    );
    return new Map((rows as Array<{ folio_digital: string; total: number | null }>).map((r) => [r.folio_digital, r.total]));
  }

  private idsGuias(v: unknown): string[] {
    const ids = [...new Set((Array.isArray(v) ? v : []).map((x) => String(x).trim()))];
    if (!ids.length) throw new BadRequestException('Elige al menos una guía.');
    if (ids.length > MAX_GUIAS_LIQUIDACION) throw new BadRequestException(`Máximo ${MAX_GUIAS_LIQUIDACION} guías por liquidación.`);
    if (ids.some((x) => !UUID_RE.test(x))) throw new BadRequestException('Hay un id de guía inválido.');
    return ids;
  }

  /** El arqueo: sólo denominaciones del catálogo compartido, piezas enteras y no negativas. */
  private conteo(v: unknown): { piezas: Record<string, number>; total: number } {
    if (!v || typeof v !== 'object' || Array.isArray(v)) throw new BadRequestException('Falta el conteo del efectivo.');
    const piezas: Record<string, number> = {};
    for (const [key, cant] of Object.entries(v as Record<string, unknown>)) {
      const d = denomDe(key);
      if (!d) throw new BadRequestException(`La denominación "${key}" no existe.`);
      const n = cant === '' || cant == null ? 0 : Number(cant);
      if (!Number.isInteger(n) || n < 0 || n > MAX_PIEZAS) throw new BadRequestException(`Las piezas de ${d.label} no son válidas.`);
      if (n > 0) piezas[d.key] = n;
    }
    const t = totalDenominaciones(piezas);
    if (t.total > MAX_IMPORTE) throw new BadRequestException('El efectivo contado es demasiado grande.');
    return { piezas, total: t.total };
  }

  // ─────────────────────────────────────────────────────────── internos ──

  private usuario(): string {
    const userId = this.tenantCtx.get()?.userId || null;
    if (!userId) throw new UnauthorizedException('Sin usuario en la sesión.');
    return userId;
  }

  private async renderizar(snap: LoadGuideSnapshot, reimpresion: boolean, sello: string): Promise<Buffer> {
    return this.pdf.renderPdf(
      htmlGuiaCarga(snap, { reimpresion, reimpresa_en: reimpresion ? sello : undefined }),
      pieGuiaCarga(snap.folio, (reimpresion ? 'reimpresa ' : 'impresa ') + sello),
    );
  }

  private async renglonCargado(trx: Knex.Transaction, orderId: string) {
    return (await trx('commercial.load_guide_orders as lgo')
      .join('commercial.load_guides as g', function () {
        this.on('g.id', '=', 'lgo.guide_id').andOn('g.tenant_id', '=', 'lgo.tenant_id');
      })
      .where('lgo.order_id', orderId)
      .andWhere('lgo.status', 'cargado')
      .whereNot('g.status', 'cancelada')
      .first('lgo.id', 'lgo.guide_id', 'g.status as guide_status', 'g.rider_user_id', 'g.folio')) as
      | { id: string; guide_id: string; guide_status: string; rider_user_id: string; folio: string }
      | undefined;
  }

  private async filtroCampo(
    query: Record<string, unknown> | undefined,
    quien: QuienPide,
    userId: string,
  ): Promise<{ almacenes: string[] | null; autorId?: string }> {
    if (quien.god) return { almacenes: null };
    if (quien.repartidor) return { almacenes: await this.scope.readParam(query, 'warehouse', 'field/presale') };
    return { almacenes: null, autorId: userId };
  }

  /**
   * Sucursales KEPLER que ve la caja. El alcance da llaves canónicas (las de Morelia pueden venir
   * como `32`, la llave Wincaja), y las guías se guardan con la sucursal Kepler (`07`): se traduce
   * con `commercial.warehouses`, incluidos los almacenes dados de baja (MD-32). Así la caja ve lo
   * mismo que la mesa, que compara contra las dos llaves.
   */
  private async sucursalesCaja(query: Record<string, unknown> | undefined, quien: QuienPide): Promise<string[] | null> {
    if (quien.god) return null;
    const codigos = await this.scope.readParam(query, 'warehouse', 'warehouse/presale-guides');
    if (codigos === null || codigos.length === 0) return codigos;
    const tenantId = this.tenantCtx.requireTenantId();
    const { rows } = await this.tk.run((trx) =>
      trx.raw(
        `SELECT DISTINCT CASE WHEN w.kepler_code ~ '^[0-9]{2}$' THEN w.kepler_code ELSE ${branchKeySql('w')} END AS k
           FROM commercial.warehouses w
          WHERE w.tenant_id = ?
            AND ((${branchKeySql('w')}) = ANY(?::text[]) OR w.kepler_code = ANY(?::text[]))`,
        [tenantId, codigos, codigos],
      ),
    );
    return [...new Set([...codigos, ...rows.map((r: { k: string | null }) => r.k).filter((k: string | null): k is string => !!k)])];
  }

  /** La guía abierta de hoy de (quien la lleva, sucursal, ruta); la crea con folio nuevo si no hay. */
  private async guiaAbierta(
    trx: Knex.Transaction,
    tenantId: string,
    userId: string,
    branch: string,
    ruta: string,
    hoy: string,
  ): Promise<string> {
    const existente = await trx('commercial.load_guides')
      .where({ rider_user_id: userId, branch, sales_route: ruta, business_date: hoy, status: 'abierta' })
      .forUpdate()
      .first('id');
    if (existente) return existente.id as string;

    const year = Number(hoy.slice(0, 4));
    const { rows } = await trx.raw(
      `INSERT INTO commercial.load_guide_sequences (tenant_id, year, current_value)
       VALUES (?, ?, 1)
       ON CONFLICT (tenant_id, year)
       DO UPDATE SET current_value = commercial.load_guide_sequences.current_value + 1, updated_at = now()
       RETURNING current_value`,
      [tenantId, year],
    );
    const folio = `GDC-${year}-${String(rows[0].current_value).padStart(5, '0')}`;
    try {
      const [g] = await trx('commercial.load_guides')
        .insert({
          tenant_id: tenantId,
          folio,
          rider_user_id: userId,
          branch,
          sales_route: ruta,
          business_date: hoy,
          created_by: userId,
          updated_by: userId,
        })
        .returning('id');
      return (g as { id: string }).id;
    } catch (e) {
      if (/ux_load_guides_abierta|duplicate key/i.test((e as Error).message)) {
        throw new ConflictException('Se acaba de abrir otra guía para esa ruta: vuelve a intentarlo.');
      }
      throw e;
    }
  }

  /**
   * Guías con sus pedidos cargados. Los pedidos se leen con la consulta de la mesa.
   * `conAbiertas` suma las guías ABIERTAS de días anteriores a las del día pedido: siguen esperando
   * impresión y, si no aparecieran, sus pedidos quedarían atrapados sin que nadie los viera.
   */
  private async guias(
    trx: Knex.Transaction,
    f: {
      id?: string; ids?: string[]; riderId?: string; fecha?: string; conAbiertas?: boolean; conPendientes?: boolean;
      /** `[MCP.7]` Suma las IMPRESAS de cualquier día: siguen esperando su liquidación en caja. */
      conSinLiquidar?: boolean; branches: string[] | null;
    },
  ): Promise<LoadGuide[]> {
    let qb = trx('commercial.load_guides as g')
      .leftJoin('identity.users as ru', function () {
        this.on('ru.id', '=', 'g.rider_user_id').andOn('ru.tenant_id', '=', 'g.tenant_id');
      })
      .leftJoin('identity.users as pu', function () {
        this.on('pu.id', '=', 'g.printed_by').andOn('pu.tenant_id', '=', 'g.tenant_id');
      })
      .leftJoin('commercial.load_guide_liquidations as lq', function () {
        this.on('lq.id', '=', 'g.liquidation_id').andOn('lq.tenant_id', '=', 'g.tenant_id');
      })
      .whereNot('g.status', 'cancelada');
    if (f.id) qb = qb.where('g.id', f.id);
    if (f.ids) qb = qb.whereIn('g.id', f.ids);
    if (f.riderId) qb = qb.where('g.rider_user_id', f.riderId);
    if (f.fecha) {
      const fecha = f.fecha;
      qb = qb.where((w) => {
        w.where('g.business_date', fecha);
        if (f.conAbiertas) w.orWhere('g.status', 'abierta');
        if (f.conSinLiquidar) w.orWhere('g.status', 'impresa');
        // `[MCP.6]` Una guía impresa de otro día con pedidos sin entregar sigue en el celular: si no,
        // el repartidor que entrega al día siguiente no tendría dónde registrar la entrega.
        if (f.conPendientes) {
          w.orWhere((p) =>
            p.where('g.status', 'impresa').whereExists(function () {
              this.select(trx.raw('1'))
                .from('commercial.load_guide_orders as pc')
                .whereRaw('pc.guide_id = g.id AND pc.tenant_id = g.tenant_id')
                .andWhere('pc.status', 'cargado');
            }),
          );
        }
      });
    }
    if (f.branches !== null) qb = qb.whereIn('g.branch', f.branches);

    const rows = (await qb
      .select(
        'g.id', 'g.folio', 'g.status', 'g.rider_user_id', 'ru.nombre as rider_name', 'g.branch',
        'g.sales_route', trx.raw(`to_char(g.business_date, 'YYYY-MM-DD') AS business_date`),
        'g.printed_at', 'pu.nombre as printed_by_name', 'g.print_count',
        'g.liquidation_id', 'lq.folio as liquidation_folio',
      )
      // Lo más reciente primero: si se acumulara rezago, el tope de filas corta lo VIEJO, nunca lo de hoy.
      .orderBy([{ column: 'g.business_date', order: 'desc' }, { column: 'g.branch' }, { column: 'g.sales_route' }, { column: 'g.created_at' }])
      .limit(300)) as GuideRow[];
    if (!rows.length) return [];

    // `[MCP.6]` Todo lo que se llevó en la guía: en camino, entregado y lo que volvió sin entregarse
    // (con su motivo). Sólo `quitado` (antes de imprimir) no forma parte de la carga.
    type Renglon = {
      guide_id: string; order_id: string; status: LoadGuideOrderRow['status'];
      cash_amount: string | null; transfer_amount: string | null; transfer_ref: string | null;
      delivery_outcome: 'completo' | 'con_diferencia' | null; delivery_note: string | null; removed_reason: string | null;
      delivered_folio_digital: string | null;
    };
    const lgo = (await trx('commercial.load_guide_orders')
      .whereIn('guide_id', rows.map((r) => r.id))
      .whereIn('status', ['cargado', 'entregado', 'no_entregado', 'regreso'])
      .orderBy('added_at')
      .select('guide_id', 'order_id', 'status', 'cash_amount', 'transfer_amount', 'transfer_ref',
        'delivery_outcome', 'delivery_note', 'removed_reason', 'delivered_folio_digital')) as Renglon[];
    const pedidos = lgo.length
      ? await this.presale.pedidosParaGuias(trx, { almacenes: null, orderIds: lgo.map((x) => x.order_id) })
      : [];
    const porId = new Map(pedidos.map((p) => [p.id, p]));
    // `[MCP.7]` El total del documento ENTREGADO (no el de la liga actual: si la mesa la corrigiera
    // después, el comprobante mostraría el folio entregado con el total de otro documento).
    const totalEntregado = await this.totalesDocumentos(trx, lgo.map((x) => x.delivered_folio_digital).filter((f): f is string => !!f));

    return rows.map((r) => {
      const orders: LoadGuideOrderRow[] = lgo
        .filter((x) => x.guide_id === r.id)
        .map((x) => ({ x, p: porId.get(x.order_id) }))
        .filter((v): v is { x: Renglon; p: PresaleOrderRow } => !!v.p)
        // Un pedido cancelado NO se esconde: si va cargado en una guía impresa, la caja tiene que
        // registrar su regreso (y la liquidación no se cierra mientras siga en camino).
        .map(({ x, p }) => ({
          order_id: p.id,
          code: p.code,
          customer_name: p.customer_name,
          customer_erp_code: p.customer_erp_code,
          requested_delivery_date: p.requested_delivery_date,
          total: p.total,
          folio_digital: x.delivered_folio_digital ?? p.link?.folio_digital ?? null,
          document_total: x.delivered_folio_digital
            ? totalEntregado.get(x.delivered_folio_digital) ?? null
            : p.link?.total ?? null,
          status: x.status,
          cash_amount: x.cash_amount == null ? null : Number(x.cash_amount),
          transfer_amount: x.transfer_amount == null ? null : Number(x.transfer_amount),
          transfer_ref: x.transfer_ref,
          delivery_outcome: x.delivery_outcome,
          delivery_note: x.delivery_note,
          removed_reason: x.removed_reason,
          order_cancelled: p.status === 'cancelled',
        }));
      // Lo que suma: lo entregado y lo que va en camino, menos un cancelado que todavía no regresa.
      const llevados = orders.filter((o) => o.status === 'entregado' || (o.status === 'cargado' && !o.order_cancelled));
      return {
        id: r.id,
        folio: r.folio,
        status: r.status,
        rider_user_id: r.rider_user_id,
        rider_name: r.rider_name,
        branch: r.branch,
        branch_name: branchName(r.branch) || null,
        sales_route: r.sales_route,
        business_date: r.business_date,
        printed_at: r.printed_at ? new Date(r.printed_at).toISOString() : null,
        printed_by_name: r.printed_by_name,
        print_count: Number(r.print_count) || 0,
        liquidation: r.liquidation_id ? { id: r.liquidation_id, folio: r.liquidation_folio as string } : null,
        orders,
        // Mismo criterio del PDF: el documento cuando ya está ligado, si no el pedido.
        // Lo que volvió sin entregarse no suma.
        total: Math.round(llevados.reduce((t, o) => t + (o.document_total ?? o.total), 0) * 100) / 100,
      };
    });
  }
}
