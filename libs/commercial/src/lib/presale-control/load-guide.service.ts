import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import type { Knex } from 'knex';
import { TenantKnexService, TenantContextService, ScopeService, branchName } from '@megadulces/platform-core';
import type {
  LoadGuide,
  LoadGuideOrderRow,
  LoadGuidesResponse,
  PresaleFieldResponse,
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
  snapshot: LoadGuideSnapshot | null;
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
 * ── Quién ve qué en el celular ──────────────────────────────────────────────────────────────
 *  · Repartidor (`REPARTO_ENTREGAR`) o modo god: los pedidos de las sucursales de su alcance
 *    (el rol `repartidor` tiene alcance "todas").
 *  · Vendedor: SÓLO los que él levantó. No se usa su alcance por sucursal porque, medido el
 *    2026-10-08, 13 de 19 `vendedor_ruta` no tienen sucursal en su ficha y no verían nada.
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

  async campo(query: Record<string, unknown> | undefined, esRepartidor: boolean): Promise<PresaleFieldResponse> {
    const userId = this.usuario();
    const hoy = relojMx(new Date()).fecha;
    const filtro = await this.filtroCampo(query, esRepartidor, userId);
    return this.tk.run(async (trx) => {
      const pedidos =
        filtro.almacenes !== null && filtro.almacenes.length === 0
          ? []
          : await this.presale.pedidosParaGuias(trx, { ...filtro, soloAbiertos: true });
      // Se pueden pescar los confirmados sin guía. Un cliente sin alta en Kepler no se surte (D7).
      const available = pedidos.filter((p) => !p.load_guide && p.stage !== 'esperando_alta');
      const mine = await this.guias(trx, { riderId: userId, fecha: hoy, almacenes: null });
      return { available, mine, source: esRepartidor ? 'sucursal' : 'propios', today: hoy };
    });
  }

  /** Pesca pedidos: los agrega a su guía abierta de hoy de esa sucursal y ruta (la crea si no hay). */
  async cargar(orderIds: string[] | undefined, query: Record<string, unknown> | undefined, esRepartidor: boolean): Promise<PresaleFieldResponse> {
    const ids = [...new Set((orderIds ?? []).map((x) => String(x).trim()))];
    if (!ids.length) throw new BadRequestException('Elige al menos un pedido.');
    if (ids.length > MAX_POR_CARGA) throw new BadRequestException(`Máximo ${MAX_POR_CARGA} pedidos por vez.`);
    if (ids.some((x) => !UUID_RE.test(x))) throw new BadRequestException('Hay un id de pedido inválido.');
    const userId = this.usuario();
    const tenantId = this.tenantCtx.requireTenantId();
    const hoy = relojMx(new Date()).fecha;
    const filtro = await this.filtroCampo(query, esRepartidor, userId);

    await this.tk.run(async (trx) => {
      // Candado sobre los pedidos, para que dos celulares no pesquen el mismo a la vez.
      await trx.raw('SELECT 1 FROM commercial.orders WHERE id = ANY(?::uuid[]) FOR UPDATE', [ids]);
      const pedidos =
        filtro.almacenes !== null && filtro.almacenes.length === 0
          ? []
          : await this.presale.pedidosParaGuias(trx, { ...filtro, orderIds: ids, soloAbiertos: true });
      const porId = new Map(pedidos.map((p) => [p.id, p]));
      const faltan = ids.filter((x) => !porId.has(x));
      if (faltan.length) {
        throw new NotFoundException(`${faltan.length} pedido(s) no están disponibles para ti (no existen, no son tuyos o ya se cerraron).`);
      }
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
    return this.campo(query, esRepartidor);
  }

  /** Quita un pedido de su guía, sólo mientras la guía siga abierta (no impresa). */
  async descargar(orderId: string | undefined, query: Record<string, unknown> | undefined, esRepartidor: boolean): Promise<PresaleFieldResponse> {
    if (!orderId || !UUID_RE.test(orderId)) throw new BadRequestException('id de pedido inválido');
    const userId = this.usuario();
    await this.tk.run(async (trx) => {
      const fila = await trx('commercial.load_guide_orders as lgo')
        .join('commercial.load_guides as g', function () {
          this.on('g.id', '=', 'lgo.guide_id').andOn('g.tenant_id', '=', 'lgo.tenant_id');
        })
        .where('lgo.order_id', orderId)
        .andWhere('lgo.status', 'cargado')
        .first('lgo.id', 'g.status', 'g.rider_user_id', 'g.folio');
      if (!fila || fila.rider_user_id !== userId) throw new NotFoundException('Ese pedido no va en una guía tuya.');
      if (fila.status !== 'abierta') {
        throw new ConflictException(`La guía ${fila.folio} ya se imprimió y firmó: lo que no entregues se registra al entregar.`);
      }
      await trx('commercial.load_guide_orders')
        .where({ id: fila.id, status: 'cargado' })
        .update({ status: 'quitado', removed_at: trx.fn.now(), removed_by: userId });
    });
    return this.campo(query, esRepartidor);
  }

  // ──────────────────────────────────────────────────────────────── caja ──

  async listar(query: Record<string, unknown> | undefined): Promise<LoadGuidesResponse> {
    const raw = String(query?.['date'] ?? '').trim();
    const fecha = DATE_RE.test(raw) ? raw : relojMx(new Date()).fecha;
    const almacenes = await this.scope.readParam(query, 'warehouse', 'warehouse/presale/guides');
    if (almacenes !== null && almacenes.length === 0) return { data: [], date: fecha };
    const data = await this.tk.run((trx) => this.guias(trx, { fecha, almacenes }));
    return { data, date: fecha };
  }

  /**
   * Imprime la guía. La primera vez la congela (`snapshot`, `impresa`); después reimprime desde esa
   * foto con la marca REIMPRESIÓN, para que la copia diga lo mismo que el papel que se firmó.
   */
  async imprimir(id: string, query: Record<string, unknown> | undefined): Promise<{ pdf: Buffer; guia: LoadGuide }> {
    if (!UUID_RE.test(id)) throw new BadRequestException('id de guía inválido');
    const userId = this.usuario();
    const almacenes = await this.scope.readParam(query, 'warehouse', 'warehouse/presale/guides');
    if (almacenes !== null && almacenes.length === 0) throw new NotFoundException('Guía no encontrada.');

    const { snapshot, reimpresion, guia } = await this.tk.run(async (trx) => {
      await trx.raw('SELECT 1 FROM commercial.load_guides WHERE id = ? FOR UPDATE', [id]);
      const [g] = await this.guias(trx, { id, almacenes });
      if (!g) throw new NotFoundException('Guía no encontrada.');
      if (g.status === 'cancelada') throw new ConflictException('La guía está cancelada.');

      if (g.status === 'impresa') {
        const row = await trx('commercial.load_guides').where({ id }).first('snapshot');
        await trx('commercial.load_guides').where({ id }).update({ print_count: trx.raw('print_count + 1'), updated_at: trx.fn.now() });
        // Se relee: la guía leída arriba trae el contador de ANTES de esta reimpresión.
        const [reimpresa] = await this.guias(trx, { id, almacenes });
        return { snapshot: row.snapshot as LoadGuideSnapshot, reimpresion: true, guia: reimpresa };
      }

      if (!g.orders.length) throw new ConflictException('La guía no tiene pedidos: no hay nada que imprimir.');
      const quien = await trx('identity.users').where({ id: userId }).first('nombre');
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
        impresa_por: quien?.nombre ?? null,
        pedidos: g.orders.map((o) => ({
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
      await trx('commercial.load_guides').where({ id, status: 'abierta' }).update({
        status: 'impresa',
        snapshot: JSON.stringify(snap),
        printed_at: trx.fn.now(),
        printed_by: userId,
        print_count: 1,
        updated_at: trx.fn.now(),
        updated_by: userId,
      });
      const [impresa] = await this.guias(trx, { id, almacenes });
      this.logger.log(`[MCP.5] guía ${g.folio} impresa por ${userId} (${g.orders.length} pedidos)`);
      return { snapshot: snap, reimpresion: false, guia: impresa };
    });

    const sello = new Date().toLocaleString('es-MX', { timeZone: 'America/Mexico_City' });
    const pdf = await this.pdf.renderPdf(
      htmlGuiaCarga(snapshot, { reimpresion, reimpresa_en: reimpresion ? sello : undefined }),
      pieGuiaCarga(snapshot.folio, (reimpresion ? 'reimpresa ' : 'impresa ') + sello),
    );
    return { pdf, guia };
  }

  // ─────────────────────────────────────────────────────────── internos ──

  private usuario(): string {
    const userId = this.tenantCtx.get()?.userId || null;
    if (!userId) throw new UnauthorizedException('Sin usuario en la sesión.');
    return userId;
  }

  private async filtroCampo(
    query: Record<string, unknown> | undefined,
    esRepartidor: boolean,
    userId: string,
  ): Promise<{ almacenes: string[] | null; autorId?: string }> {
    if (esRepartidor) return { almacenes: await this.scope.readParam(query, 'warehouse', 'field/presale') };
    return { almacenes: null, autorId: userId };
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

  /** Guías con sus pedidos cargados. Los pedidos se leen con la consulta de la mesa. */
  private async guias(
    trx: Knex.Transaction,
    f: { id?: string; riderId?: string; fecha?: string; almacenes: string[] | null },
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
    if (f.fecha) qb = qb.where('g.business_date', f.fecha);
    if (f.almacenes !== null) qb = qb.whereIn('g.branch', f.almacenes);

    const rows = (await qb
      .select(
        'g.id', 'g.folio', 'g.status', 'g.rider_user_id', 'ru.nombre as rider_name', 'g.branch',
        'g.sales_route', trx.raw(`to_char(g.business_date, 'YYYY-MM-DD') AS business_date`),
        'g.printed_at', 'pu.nombre as printed_by_name', 'g.print_count',
      )
      .orderBy([{ column: 'g.branch' }, { column: 'g.sales_route' }, { column: 'g.created_at' }])
      .limit(300)) as GuideRow[];
    if (!rows.length) return [];

    const lgo = (await trx('commercial.load_guide_orders')
      .whereIn('guide_id', rows.map((r) => r.id))
      .andWhere('status', 'cargado')
      .orderBy('added_at')
      .select('guide_id', 'order_id')) as Array<{ guide_id: string; order_id: string }>;
    const pedidos = lgo.length
      ? await this.presale.pedidosParaGuias(trx, { almacenes: null, orderIds: lgo.map((x) => x.order_id) })
      : [];
    const porId = new Map(pedidos.map((p) => [p.id, p]));

    return rows.map((r) => {
      const orders: LoadGuideOrderRow[] = lgo
        .filter((x) => x.guide_id === r.id)
        .map((x) => porId.get(x.order_id))
        .filter((p): p is PresaleOrderRow => !!p)
        .map((p) => ({
          order_id: p.id,
          code: p.code,
          customer_name: p.customer_name,
          customer_erp_code: p.customer_erp_code,
          requested_delivery_date: p.requested_delivery_date,
          total: p.total,
          folio_digital: p.link?.folio_digital ?? null,
          document_total: p.link?.total ?? null,
        }));
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
        total: Math.round(orders.reduce((t, o) => t + (o.document_total ?? o.total), 0) * 100) / 100,
      };
    });
  }
}
