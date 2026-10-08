import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import type { Knex } from 'knex';
import { TenantKnexService, TenantContextService, ScopeService, branchName, branchKeySql } from '@megadulces/platform-core';
import type {
  LoadGuide,
  LoadGuideOrderRow,
  LoadGuidesResponse,
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

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
/** Tope de pedidos por petición de "pescar": una camioneta no lleva más en una vuelta. */
const MAX_POR_CARGA = 80;
const SIN_RUTA = 'SIN RUTA';
/** `[MCP.6]` Topes que la base aguanta: sin ellos un texto largo o un importe enorme dan error 500. */
const MAX_TEXTO = 500;
const MAX_REF = 60;
const MAX_IMPORTE = 9_999_999.99;

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
  status: 'abierta' | 'impresa' | 'cancelada';
  rider_user_id: string;
  rider_name: string | null;
  branch: string;
  sales_route: string;
  business_date: string;
  printed_at: string | null;
  printed_by_name: string | null;
  print_count: number;
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
    const data = await this.tk.run((trx) => this.guias(trx, { fecha, conAbiertas: true, branches }));
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

      if (estado.status === 'impresa') {
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
        `SELECT p.sku, p.name AS description, ol.quantity::float8 AS quantity, ol.qty_unit AS unit
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
    f: { id?: string; riderId?: string; fecha?: string; conAbiertas?: boolean; conPendientes?: boolean; branches: string[] | null },
  ): Promise<LoadGuide[]> {
    let qb = trx('commercial.load_guides as g')
      .leftJoin('identity.users as ru', function () {
        this.on('ru.id', '=', 'g.rider_user_id').andOn('ru.tenant_id', '=', 'g.tenant_id');
      })
      .leftJoin('identity.users as pu', function () {
        this.on('pu.id', '=', 'g.printed_by').andOn('pu.tenant_id', '=', 'g.tenant_id');
      })
      .whereNot('g.status', 'cancelada');
    if (f.id) qb = qb.where('g.id', f.id);
    if (f.riderId) qb = qb.where('g.rider_user_id', f.riderId);
    if (f.fecha) {
      const fecha = f.fecha;
      qb = qb.where((w) => {
        w.where('g.business_date', fecha);
        if (f.conAbiertas) w.orWhere('g.status', 'abierta');
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
      )
      .orderBy([{ column: 'g.business_date' }, { column: 'g.branch' }, { column: 'g.sales_route' }, { column: 'g.created_at' }])
      .limit(300)) as GuideRow[];
    if (!rows.length) return [];

    // `[MCP.6]` Todo lo que se llevó en la guía: en camino, entregado y lo que volvió sin entregarse
    // (con su motivo). Sólo `quitado` (antes de imprimir) no forma parte de la carga.
    type Renglon = {
      guide_id: string; order_id: string; status: LoadGuideOrderRow['status'];
      cash_amount: string | null; transfer_amount: string | null; transfer_ref: string | null;
      delivery_outcome: 'completo' | 'con_diferencia' | null; removed_reason: string | null;
      delivered_folio_digital: string | null;
    };
    const lgo = (await trx('commercial.load_guide_orders')
      .whereIn('guide_id', rows.map((r) => r.id))
      .whereIn('status', ['cargado', 'entregado', 'no_entregado', 'regreso'])
      .orderBy('added_at')
      .select('guide_id', 'order_id', 'status', 'cash_amount', 'transfer_amount', 'transfer_ref',
        'delivery_outcome', 'removed_reason', 'delivered_folio_digital')) as Renglon[];
    const pedidos = lgo.length
      ? await this.presale.pedidosParaGuias(trx, { almacenes: null, orderIds: lgo.map((x) => x.order_id) })
      : [];
    const porId = new Map(pedidos.map((p) => [p.id, p]));

    return rows.map((r) => {
      const orders: LoadGuideOrderRow[] = lgo
        .filter((x) => x.guide_id === r.id)
        .map((x) => ({ x, p: porId.get(x.order_id) }))
        .filter((v): v is { x: Renglon; p: PresaleOrderRow } => !!v.p)
        // Un cancelado no se cobra: no aparece (al imprimir sale de la guía). Lo ENTREGADO se queda
        // siempre: su cobro es real aunque el pedido se tocara después.
        .filter(({ x, p }) => p.status !== 'cancelled' || x.status === 'entregado')
        .map(({ x, p }) => ({
          order_id: p.id,
          code: p.code,
          customer_name: p.customer_name,
          customer_erp_code: p.customer_erp_code,
          requested_delivery_date: p.requested_delivery_date,
          total: p.total,
          folio_digital: x.delivered_folio_digital ?? p.link?.folio_digital ?? null,
          document_total: p.link?.total ?? null,
          status: x.status,
          cash_amount: x.cash_amount == null ? null : Number(x.cash_amount),
          transfer_amount: x.transfer_amount == null ? null : Number(x.transfer_amount),
          transfer_ref: x.transfer_ref,
          delivery_outcome: x.delivery_outcome,
          removed_reason: x.removed_reason,
        }));
      const llevados = orders.filter((o) => o.status === 'cargado' || o.status === 'entregado');
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
        orders,
        // Mismo criterio del PDF: el documento cuando ya está ligado, si no el pedido.
        // Lo que volvió sin entregarse no suma.
        total: Math.round(llevados.reduce((t, o) => t + (o.document_total ?? o.total), 0) * 100) / 100,
      };
    });
  }
}
