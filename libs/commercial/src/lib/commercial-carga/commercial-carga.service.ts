import { Injectable, BadRequestException } from '@nestjs/common';
import { TenantKnexService, TenantContextService } from '@megadulces/platform-core';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type LoadStatus = 'loaded' | 'not_loaded' | 'pending';

export interface SetLoadStatusDto {
  order_id: string;
  product_id: string;
  status: LoadStatus;
  /** Motivo del 'not_loaded' (sin_stock, dañado, no_cabe, otro…). Ignorado si no es not_loaded. */
  reason?: string | null;
  /** Snapshot de la cantidad de la línea (para reporte de unidades no cargadas). */
  quantity?: number | null;
  /** Snapshot del nombre del producto (reporte sin join). */
  product_name?: string | null;
  /** Fecha de carga (YYYY-MM-DD). */
  delivery_date?: string | null;
}

/**
 * Checklist de carga del vendedor (commercial.carga_load_items). Registra qué
 * líneas se cargaron al camión y cuáles NO (+ motivo). Es un log AUDITABLE: no
 * toca el pedido ni el stock. RLS por tenant vía TenantKnexService.
 */
@Injectable()
export class CommercialCargaService {
  constructor(
    private readonly tk: TenantKnexService,
    private readonly ctx: TenantContextService,
  ) {}

  /** Estados de carga de las líneas de los pedidos dados (los que tengan fila). */
  async getStatuses(orderIds: string[]) {
    const ids = (orderIds || []).filter((id) => UUID.test(id));
    if (!ids.length) return [];
    return this.tk.run((trx) =>
      trx('commercial.carga_load_items')
        .whereIn('order_id', ids)
        .select('order_id', 'product_id', 'status', 'reason', 'quantity', 'product_name', 'delivery_date'),
    );
  }

  /** Marca una línea: loaded / not_loaded (+motivo) / pending (borra la fila). */
  async setStatus(dto: SetLoadStatusDto) {
    this.validate(dto);
    return this.tk.run((trx) => this.applyOne(trx, dto));
  }

  /** Marca varias líneas de una (toggle por pedido o por producto). */
  async setStatusBulk(items: SetLoadStatusDto[]) {
    if (!Array.isArray(items) || !items.length) {
      throw new BadRequestException('items requerido (array no vacío)');
    }
    if (items.length > 500) throw new BadRequestException('máximo 500 items por bulk');
    items.forEach((i) => this.validate(i));
    return this.tk.run(async (trx) => {
      for (const dto of items) await this.applyOne(trx, dto);
      return { ok: true, count: items.length };
    });
  }

  private async applyOne(trx: any, dto: SetLoadStatusDto) {
    const userId = this.ctx.get()?.userId || null;

    if (dto.status === 'pending') {
      await trx('commercial.carga_load_items')
        .where({ order_id: dto.order_id, product_id: dto.product_id })
        .del();
      return { order_id: dto.order_id, product_id: dto.product_id, status: 'pending' as const };
    }

    const row = {
      tenant_id: trx.raw('public.current_tenant_id()'),
      order_id: dto.order_id,
      product_id: dto.product_id,
      product_name: dto.product_name?.trim().slice(0, 200) || null,
      delivery_date: dto.delivery_date || null,
      status: dto.status,
      reason: dto.status === 'not_loaded' ? dto.reason?.trim().slice(0, 200) || null : null,
      quantity: dto.quantity != null ? Number(dto.quantity) : null,
      created_by: userId,
      updated_by: userId,
    };

    await trx('commercial.carga_load_items')
      .insert(row)
      .onConflict(['tenant_id', 'order_id', 'product_id'])
      .merge({
        status: row.status,
        reason: row.reason,
        quantity: row.quantity,
        product_name: row.product_name,
        delivery_date: row.delivery_date,
        updated_by: userId,
        updated_at: trx.fn.now(),
      });

    return { order_id: dto.order_id, product_id: dto.product_id, status: dto.status };
  }

  private validate(dto: SetLoadStatusDto): void {
    if (!dto || !UUID.test(dto.order_id)) throw new BadRequestException('order_id inválido');
    if (!UUID.test(dto.product_id)) throw new BadRequestException('product_id inválido');
    if (!['loaded', 'not_loaded', 'pending'].includes(dto.status)) {
      throw new BadRequestException("status inválido (loaded | not_loaded | pending)");
    }
  }
}
