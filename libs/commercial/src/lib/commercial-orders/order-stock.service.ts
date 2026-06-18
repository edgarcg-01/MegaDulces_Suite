import { Injectable, ConflictException } from '@nestjs/common';
import { TenantContextService } from '@megadulces/platform-core';

/**
 * Primitivas de stock del flujo de pedidos (CV.4 — extraído de CommercialOrdersService).
 *
 * Todas operan sobre la `trx` que les pasa el caller, de modo que participan en
 * la MISMA transacción del confirm/fulfill/cancel — la atomicidad y los locks
 * (`FOR UPDATE`) anti-race se mantienen idénticos al comportamiento previo.
 * Única dependencia: TenantContextService para los campos de auditoría.
 */
@Injectable()
export class OrderStockService {
  constructor(private readonly tenantCtx: TenantContextService) {}

  /**
   * Guard de congelamiento (Fase I): si el almacén tiene un folio de inventario
   * físico abierto con freeze_movements, bloquea el movimiento de stock — de lo
   * contrario el teórico derivaría durante el conteo y toda varianza sería falsa.
   */
  async assertNotFrozen(trx: any, warehouseId: string): Promise<void> {
    const frozen = await trx('commercial.inventory_counts')
      .where({ warehouse_id: warehouseId, freeze_movements: true })
      .whereIn('status', ['open', 'counting', 'review', 'ready_to_reconcile'])
      .first();
    if (frozen) {
      throw new ConflictException(
        `Almacén con inventario físico en curso (folio ${frozen.folio}); no se puede mover stock hasta cerrar o cancelar el conteo.`,
      );
    }
  }

  async reserve(
    trx: any,
    warehouseId: string,
    productId: string,
    quantity: number,
    orderId: string,
  ): Promise<void> {
    await this.assertNotFrozen(trx, warehouseId);
    const stockRow = await trx('commercial.stock')
      .where({ warehouse_id: warehouseId, product_id: productId })
      .forUpdate()
      .first();

    const qBefore = stockRow ? Number(stockRow.quantity) : 0;
    const rBefore = stockRow ? Number(stockRow.reserved_quantity) : 0;

    if (qBefore - rBefore < quantity) {
      throw new ConflictException(
        `Stock disponible insuficiente para producto ${productId}: ${qBefore - rBefore} < ${quantity}`,
      );
    }

    if (stockRow) {
      await trx('commercial.stock')
        .where({ id: stockRow.id })
        .update({
          reserved_quantity: rBefore + quantity,
          updated_at: trx.fn.now(),
          updated_by: this.tenantCtx.get()?.userId || null,
        });
    } else {
      // No row → no stock → ya rechazó arriba. Defensa por si llegamos acá.
      throw new ConflictException(
        `No existe registro de stock para producto ${productId} en almacén`,
      );
    }

    await trx('commercial.stock_movements').insert({
      tenant_id: trx.raw('public.current_tenant_id()'),
      warehouse_id: warehouseId,
      product_id: productId,
      movement_type: 'reserve',
      quantity,
      quantity_before: qBefore,
      quantity_after: qBefore,
      reference_type: 'order',
      reference_id: orderId,
      created_by: this.tenantCtx.get()?.userId || null,
    });
  }

  async consume(
    trx: any,
    warehouseId: string,
    productId: string,
    quantity: number,
    orderId: string,
  ): Promise<{ expiredConsumed: number }> {
    await this.assertNotFrozen(trx, warehouseId);
    const stockRow = await trx('commercial.stock')
      .where({ warehouse_id: warehouseId, product_id: productId })
      .forUpdate()
      .first();
    if (!stockRow) {
      throw new ConflictException(`Sin stock para producto ${productId}`);
    }
    const qBefore = Number(stockRow.quantity);
    const rBefore = Number(stockRow.reserved_quantity);
    // Una preventa NO reservó stock al confirmar → al entregar puede no alcanzar
    // el físico. Rebotar con 409 claro antes de violar el CHECK quantity>=0.
    if (qBefore < quantity) {
      throw new ConflictException(
        `Stock físico insuficiente para entregar producto ${productId}: ${qBefore} < ${quantity}`,
      );
    }
    // P2.2d (warn): si lo bueno (no-vencido) no cubre la cantidad, el trigger
    // (FEFO no-vencido primero) forzará despacho desde lotes vencidos por el sobrante.
    const goodRow = await trx('commercial.stock_lots')
      .where({ warehouse_id: warehouseId, product_id: productId })
      .whereRaw('(expiry_date IS NULL OR expiry_date >= CURRENT_DATE)')
      .sum({ good: 'quantity' })
      .first();
    const expiredConsumed = Math.max(0, quantity - Number(goodRow?.good || 0));
    // Una preventa NO reservó stock al confirmar → liberar solo lo que estaba
    // reservado para este order (puede ser 0) y consumir la cantidad física.
    // Para un pedido reservado, release === quantity (comportamiento previo).
    const release = Math.min(rBefore, quantity);

    await trx('commercial.stock')
      .where({ id: stockRow.id })
      .update({
        quantity: qBefore - quantity,
        reserved_quantity: rBefore - release,
        updated_at: trx.fn.now(),
        updated_by: this.tenantCtx.get()?.userId || null,
      });

    await trx('commercial.stock_movements').insert({
      tenant_id: trx.raw('public.current_tenant_id()'),
      warehouse_id: warehouseId,
      product_id: productId,
      movement_type: 'sale',
      quantity,
      quantity_before: qBefore,
      quantity_after: qBefore - quantity,
      reference_type: 'order',
      reference_id: orderId,
      created_by: this.tenantCtx.get()?.userId || null,
    });

    return { expiredConsumed };
  }

  async release(
    trx: any,
    warehouseId: string,
    productId: string,
    quantity: number,
    orderId: string,
  ): Promise<void> {
    await this.assertNotFrozen(trx, warehouseId);
    const stockRow = await trx('commercial.stock')
      .where({ warehouse_id: warehouseId, product_id: productId })
      .forUpdate()
      .first();
    if (!stockRow) return; // nada que liberar (defensivo)
    const rBefore = Number(stockRow.reserved_quantity);
    const releaseQty = Math.min(rBefore, quantity);

    await trx('commercial.stock')
      .where({ id: stockRow.id })
      .update({
        reserved_quantity: rBefore - releaseQty,
        updated_at: trx.fn.now(),
        updated_by: this.tenantCtx.get()?.userId || null,
      });

    await trx('commercial.stock_movements').insert({
      tenant_id: trx.raw('public.current_tenant_id()'),
      warehouse_id: warehouseId,
      product_id: productId,
      movement_type: 'release',
      quantity: releaseQty,
      quantity_before: Number(stockRow.quantity),
      quantity_after: Number(stockRow.quantity),
      reference_type: 'order',
      reference_id: orderId,
      created_by: this.tenantCtx.get()?.userId || null,
    });
  }
}
