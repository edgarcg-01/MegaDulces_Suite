import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { TenantKnexService } from '@megadulces/platform-core';
import { TenantContextService } from '@megadulces/platform-core';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export interface PoolQuery {
  warehouse_id?: string;
  delivery_date?: string;
  limit?: number;
}

export interface CreateWaveDto {
  warehouse_id: string;
  delivery_date?: string;
  order_ids: string[];
  assigned_to?: string;
  notes?: string;
}

/**
 * SU.2 — El pool de pedidos por surtir y las olas (ADR-067).
 *
 * ⭐ El pool es una LECTURA derivada, no una tabla: un pedido está "por surtir" cuando su estado
 * COMERCIAL dice que el cliente ya se comprometió (`confirmed`) y no está en ninguna ola viva.
 * Materializarlo sería una segunda verdad que habría que mantener sincronizada con
 * `commercial.orders` — y la regla del proyecto es derivar, no copiar.
 *
 * ⛔ **No aparta stock** (decisión de Edgar, 2026-09-17). La existencia que se vea al armar la ola
 * es informativa; el reparto de lo escaso se resuelve sobre lo que el surtidor levantó (SU.6/SU.8).
 * Por eso acá no hay nada que reservar ni que liberar: dos olas pueden pedir el mismo producto y
 * eso se resuelve por excepción, no se previene.
 */
@Injectable()
export class PickingService {
  private readonly logger = new Logger(PickingService.name);

  constructor(
    private readonly tk: TenantKnexService,
    private readonly tenantCtx: TenantContextService,
  ) {}

  /**
   * Pedidos listos para surtir y todavía sin ola.
   *
   * ⚠️ `pendiente_offline` NO se puede medir desde acá y se DECLARA (ADR-056): el vendedor arma
   * pedidos sin señal (Dexie + cola de sync en `apps/vendor`) y esos pedidos **no existen para el
   * servidor** hasta que sincronizan. El pool no puede prometer que muestra todo lo del día; lo
   * que muestra es todo lo que YA LLEGÓ. La pantalla tiene que decirlo — si no, un pedido que
   * nunca sincronizó se ve igual que un pedido que no existe.
   */
  async pool(q: PoolQuery = {}) {
    if (q.warehouse_id && !UUID_RE.test(q.warehouse_id))
      throw new BadRequestException('warehouse_id inválido');
    if (q.delivery_date && !DATE_RE.test(q.delivery_date))
      throw new BadRequestException('delivery_date debe ser YYYY-MM-DD');
    const limit = Math.min(Math.max(Number(q.limit) || 200, 1), 500);

    return this.tk.run(async (trx) => {
      let qb = trx('commercial.orders as o')
        .leftJoin('commercial.customers as c', function () {
          this.on('c.id', '=', 'o.customer_id').andOn('c.tenant_id', '=', 'o.tenant_id');
        })
        .leftJoin('commercial.warehouses as w', function () {
          this.on('w.id', '=', 'o.warehouse_id').andOn('w.tenant_id', '=', 'o.tenant_id');
        })
        .where('o.status', 'confirmed')
        // Sin ola viva. `listo_embarque` ya salió del almacén, así que no bloquea.
        .whereNotExists(function () {
          this.select(trx.raw('1'))
            .from('commercial.wave_orders as wo')
            .whereRaw('wo.order_id = o.id')
            .andWhere('wo.stage', '<>', 'listo_embarque');
        });

      if (q.warehouse_id) qb = qb.where('o.warehouse_id', q.warehouse_id);
      if (q.delivery_date) qb = qb.where('o.requested_delivery_date', q.delivery_date);

      const rows = await qb
        .select(
          'o.id',
          'o.code',
          'o.customer_id',
          'c.name as customer_name',
          'o.warehouse_id',
          'w.name as warehouse_name',
          'o.requested_delivery_date',
          'o.total',
          'o.confirmed_at',
          'o.created_at',
          trx.raw('(SELECT count(*) FROM commercial.order_lines ol WHERE ol.order_id = o.id)::int AS lines'),
          trx.raw('(SELECT coalesce(sum(ol.quantity),0) FROM commercial.order_lines ol WHERE ol.order_id = o.id)::numeric AS units'),
        )
        // Primero lo que se entrega antes; a igual fecha, lo que se confirmó antes.
        .orderByRaw('o.requested_delivery_date ASC NULLS LAST, o.confirmed_at ASC NULLS LAST, o.code ASC')
        .limit(limit);

      return {
        data: rows,
        count: rows.length,
        capped: rows.length === limit,
        // ⚠️ Frescura del pool: lo creado sin señal todavía no llegó. No es un contador que
        // podamos calcular — es una ausencia, y se declara como tal.
        pendiente_offline: 'no_medible_desde_el_servidor',
      };
    });
  }

  /** Detalle de una ola: cabecera, sus pedidos y el consolidado por SKU. */
  async byId(waveId: string) {
    if (!UUID_RE.test(waveId)) throw new BadRequestException('waveId inválido');
    return this.tk.run(async (trx) => {
      const wave = await trx('commercial.picking_waves').where({ id: waveId }).first();
      if (!wave) throw new NotFoundException(`Ola ${waveId} no encontrada`);

      const orders = await trx('commercial.wave_orders as wo')
        .join('commercial.orders as o', function () {
          this.on('o.id', '=', 'wo.order_id').andOn('o.tenant_id', '=', 'wo.tenant_id');
        })
        .leftJoin('commercial.customers as c', function () {
          this.on('c.id', '=', 'o.customer_id').andOn('c.tenant_id', '=', 'o.tenant_id');
        })
        .where('wo.wave_id', waveId)
        .select('wo.id as wave_order_id', 'wo.stage', 'o.id as order_id', 'o.code', 'o.total', 'c.name as customer_name')
        .orderBy('o.code');

      return { ...wave, orders, consolidated: await this.consolidado(trx, waveId) };
    });
  }

  /**
   * §11 del documento — el consolidado por SKU que recorre el surtidor.
   *
   * ⭐ Va SIEMPRE con la unidad al lado, y el desglose por pedido debajo. Dos razones, las dos
   * medidas:
   *
   *  1. Un número sin unidad es el defecto de ADR-055, que ya costó $866,805 de sobre-pedido. El
   *     catálogo no tiene una unidad uniforme: la base es PAQ en 6,586 SKUs, PZA en 1,906, KG en
   *     232, y 69% de los productos tienen más de una presentación. "Carlos V = 23" no le dice
   *     nada a quien tiene que agarrarlo del anaquel.
   *  2. El desglose por pedido es lo que hace posible la desconsolidación (SU.6). Si se pierde al
   *     consolidar, hay que reconstruirlo adivinando.
   *
   * ⚠️ `qty_unit` sale del sello que puso la captura (VU.2/VU.4). Cuando la línea no lo trae, la
   * cantidad está en unidad base y se declara `sin_unidad_declarada` — nunca se asume "pieza".
   */
  private async consolidado(trx: any, waveId: string) {
    const rows = await trx('commercial.wave_orders as wo')
      .join('commercial.order_lines as ol', function (this: any) {
        this.on('ol.order_id', '=', 'wo.order_id').andOn('ol.tenant_id', '=', 'wo.tenant_id');
      })
      .leftJoin('catalog.products as p', function (this: any) {
        this.on('p.id', '=', 'ol.product_id').andOn('p.tenant_id', '=', 'ol.tenant_id');
      })
      .join('commercial.orders as o', function (this: any) {
        this.on('o.id', '=', 'wo.order_id').andOn('o.tenant_id', '=', 'wo.tenant_id');
      })
      .where('wo.wave_id', waveId)
      .select(
        'ol.product_id',
        // ⚠️ `nombre`, no `name`: el catálogo conserva el español legacy (mismo nombre que usa
        // `commercial-orders` al leer sus líneas). Es la clase de columna que NO se adivina.
        'p.nombre as product_name',
        'p.sku',
        'ol.qty_unit',
        'ol.quantity',
        'o.code as order_code',
        'wo.order_id',
      )
      .orderBy(['p.nombre', 'o.code']);

    const porSku = new Map<string, any>();
    for (const r of rows as any[]) {
      let g = porSku.get(r.product_id);
      if (!g) {
        g = {
          product_id: r.product_id,
          product_name: r.product_name,
          sku: r.sku,
          total_base: 0,
          // ⚠️ Si dos pedidos capturaron el MISMO producto en unidades distintas, el total en la
          // unidad de captura no existe: se declara mixto y el surtidor cuenta en unidad base.
          unidades_capturadas: new Set<string>(),
          por_pedido: [] as any[],
        };
        porSku.set(r.product_id, g);
      }
      g.total_base += Number(r.quantity);
      g.unidades_capturadas.add(r.qty_unit || 'sin_unidad_declarada');
      g.por_pedido.push({ order_id: r.order_id, order_code: r.order_code, quantity: Number(r.quantity) });
    }

    return Array.from(porSku.values()).map((g) => {
      const us = Array.from(g.unidades_capturadas);
      return {
        product_id: g.product_id,
        product_name: g.product_name,
        sku: g.sku,
        total_base: g.total_base,
        // Una sola unidad de captura → se puede nombrar. Varias → NO se inventa un total común.
        qty_unit: us.length === 1 ? us[0] : null,
        unidad_mixta: us.length > 1,
        unidades_capturadas: us,
        por_pedido: g.por_pedido,
      };
    });
  }

  /** Lista de olas (bandeja del jefe de almacén). */
  async list(status?: string) {
    return this.tk.run(async (trx) => {
      let qb = trx('commercial.picking_waves as pw')
        .leftJoin('commercial.warehouses as w', function () {
          this.on('w.id', '=', 'pw.warehouse_id').andOn('w.tenant_id', '=', 'pw.tenant_id');
        });
      if (status) qb = qb.where('pw.status', status);
      return qb
        .select(
          'pw.*',
          'w.name as warehouse_name',
          trx.raw('(SELECT count(*) FROM commercial.wave_orders wo WHERE wo.wave_id = pw.id)::int AS orders_count'),
        )
        .orderBy('pw.created_at', 'desc')
        .limit(100);
    });
  }

  /**
   * Arma una ola con los pedidos dados.
   *
   * ⚠️ Un pedido que ya está en otra ola viva **no se roba en silencio**: se rechaza la operación
   * entera y se dice cuáles. El índice único parcial `ux_wo_order_viva` lo garantiza también en la
   * base, pero un 23505 crudo no le dice al jefe de almacén cuál pedido fue.
   */
  async createWave(dto: CreateWaveDto) {
    if (!UUID_RE.test(dto?.warehouse_id || '')) throw new BadRequestException('warehouse_id inválido');
    const ids = Array.from(new Set((dto?.order_ids || []).filter((x) => UUID_RE.test(x))));
    if (!ids.length) throw new BadRequestException('order_ids vacío o inválido');
    if (dto.delivery_date && !DATE_RE.test(dto.delivery_date))
      throw new BadRequestException('delivery_date debe ser YYYY-MM-DD');
    if (dto.assigned_to && !UUID_RE.test(dto.assigned_to))
      throw new BadRequestException('assigned_to inválido');

    const userId = this.tenantCtx.get()?.userId || null;

    return this.tk.run(async (trx) => {
      const orders = await trx('commercial.orders').whereIn('id', ids).select('id', 'code', 'status', 'warehouse_id');
      if (orders.length !== ids.length) {
        const vistos = new Set(orders.map((o: any) => o.id));
        throw new NotFoundException(`Pedidos no encontrados: ${ids.filter((i) => !vistos.has(i)).join(', ')}`);
      }

      const noConfirmados = orders.filter((o: any) => o.status !== 'confirmed');
      if (noConfirmados.length)
        throw new ConflictException(
          `Solo entran pedidos confirmados. Fuera: ${noConfirmados.map((o: any) => `${o.code} (${o.status})`).join(', ')}`,
        );

      // Una ola recorre UN almacén: mezclar dos es un recorrido imposible.
      const otroAlmacen = orders.filter((o: any) => o.warehouse_id !== dto.warehouse_id);
      if (otroAlmacen.length)
        throw new ConflictException(
          `Estos pedidos se surten de otro almacén: ${otroAlmacen.map((o: any) => o.code).join(', ')}`,
        );

      const yaEnOla = await trx('commercial.wave_orders as wo')
        .join('commercial.orders as o', function (this: any) {
          this.on('o.id', '=', 'wo.order_id').andOn('o.tenant_id', '=', 'wo.tenant_id');
        })
        .whereIn('wo.order_id', ids)
        .andWhere('wo.stage', '<>', 'listo_embarque')
        .select('o.code');
      if (yaEnOla.length)
        throw new ConflictException(
          `Ya están en otra ola: ${yaEnOla.map((r: any) => r.code).join(', ')}`,
        );

      const code = await this.nextCode(trx);
      const [wave] = await trx('commercial.picking_waves')
        .insert({
          code,
          warehouse_id: dto.warehouse_id,
          delivery_date: dto.delivery_date || null,
          assigned_to: dto.assigned_to || null,
          notes: dto.notes || null,
          created_by: userId,
          updated_by: userId,
        })
        .returning('*');

      await trx('commercial.wave_orders').insert(
        ids.map((order_id) => ({ wave_id: wave.id, order_id, added_by: userId })),
      );

      this.logger.log(`Ola ${code} creada con ${ids.length} pedido(s)`);
      return { ...wave, orders_count: ids.length };
    });
  }

  /** Asigna (o reasigna) la ola a un surtidor. */
  async assign(waveId: string, assignedTo: string) {
    if (!UUID_RE.test(waveId)) throw new BadRequestException('waveId inválido');
    if (!UUID_RE.test(assignedTo)) throw new BadRequestException('assigned_to inválido');
    const userId = this.tenantCtx.get()?.userId || null;

    return this.tk.run(async (trx) => {
      const wave = await trx('commercial.picking_waves').where({ id: waveId }).forUpdate().first();
      if (!wave) throw new NotFoundException(`Ola ${waveId} no encontrada`);
      if (wave.status === 'cancelada') throw new ConflictException('La ola está cancelada');
      if (wave.status === 'surtida') throw new ConflictException('La ola ya se surtió');

      const [upd] = await trx('commercial.picking_waves')
        .where({ id: waveId })
        .update({ assigned_to: assignedTo, updated_at: trx.fn.now(), updated_by: userId })
        .returning('*');
      return upd;
    });
  }

  /**
   * Cancela la ola. Los pedidos vuelven al pool solos: el pool los encuentra porque el índice
   * `ux_wo_order_viva` deja de aplicar cuando se borran sus renglones.
   *
   * ⚠️ Se BORRAN los `wave_orders` en vez de marcarlos: si se conservaran con su `stage`, el
   * índice único parcial seguiría reservando al pedido y no podría entrar a otra ola — el pedido
   * quedaría preso por una ola que ya no existe.
   */
  async cancelWave(waveId: string, reason?: string) {
    if (!UUID_RE.test(waveId)) throw new BadRequestException('waveId inválido');
    const userId = this.tenantCtx.get()?.userId || null;

    return this.tk.run(async (trx) => {
      const wave = await trx('commercial.picking_waves').where({ id: waveId }).forUpdate().first();
      if (!wave) throw new NotFoundException(`Ola ${waveId} no encontrada`);
      if (wave.status === 'surtida') throw new ConflictException('Una ola ya surtida no se cancela');
      if (wave.status === 'cancelada') return wave; // idempotente

      await trx('commercial.wave_orders').where({ wave_id: waveId }).del();
      const [upd] = await trx('commercial.picking_waves')
        .where({ id: waveId })
        .update({
          status: 'cancelada',
          notes: reason ? `${wave.notes ? wave.notes + ' · ' : ''}Cancelada: ${reason}` : wave.notes,
          updated_at: trx.fn.now(),
          updated_by: userId,
        })
        .returning('*');
      return upd;
    });
  }

  /** Folio `W-YYYY-NNNNN`, con el mismo UPSERT atómico de `commercial.order_sequences`. */
  private async nextCode(trx: any): Promise<string> {
    const tenantId = this.tenantCtx.requireTenantId();
    const year = new Date().getFullYear();
    const [{ current_value }] = await trx
      .raw(
        `INSERT INTO commercial.wave_sequences (tenant_id, year, current_value)
         VALUES (?, ?, 1)
         ON CONFLICT (tenant_id, year) DO UPDATE
           SET current_value = commercial.wave_sequences.current_value + 1,
               updated_at = now()
         RETURNING current_value`,
        [tenantId, year],
      )
      .then((r: any) => r.rows);
    return `W-${year}-${String(current_value).padStart(5, '0')}`;
  }
}
