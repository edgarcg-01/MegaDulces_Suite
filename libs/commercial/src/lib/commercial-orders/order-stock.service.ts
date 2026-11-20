import { Injectable, ConflictException } from '@nestjs/common';
import { TenantContextService } from '@megadulces/platform-core';
import type { Knex } from 'knex';
import {
  apartadoDeReferencia,
  bloquearExistencia,
  existenciaYApartado,
} from '../commercial-inventory/stock-state';

/**
 * Primitivas de stock del flujo de pedidos (CV.4 — extraído de CommercialOrdersService).
 *
 * Todas operan sobre la `trx` que les pasa el caller, de modo que participan en
 * la MISMA transacción del confirm/fulfill/cancel. Única dependencia:
 * TenantContextService para los campos de auditoría.
 *
 * ── `[CANON.7.4b]` La existencia es la de Kepler; el apartado, el libro de la Suite ──────────────
 * Hasta el 2026-11-20 apartaban, entregaban y liberaban contra la COPIA `commercial.stock`: validaban con su
 * `quantity` y escribían `quantity` y `reserved_quantity`. Desde 7.4b NO la tocan:
 *  - **Existencia** = la del ODS (`analytics.v_erp_stock_on_hand`), la misma que leen la portada de Almacén y el
 *    catálogo. Sin renglón en la vista se lee 0, la misma regla que con la copia sin fila.
 *  - **Apartado** = derivado de `commercial.stock_movements` (`APARTADO_VIVO_SQL`): lo apartado menos lo liberado
 *    de los pedidos y reservas vivos. Apartar y liberar sólo ESCRIBEN el movimiento; entregar o cancelar sacan al
 *    pedido del apartado solos, por su estado.
 *  - **Entregar ya no resta** la cantidad: la venta la descuenta Kepler, y la copia la reescribía la ingesta en la
 *    siguiente pasada. La traza por lote que dejaba el disparador de la copia (`stock_lot_movements`) registraba
 *    siempre el lote `NA` (8 de 8 en 90 días, medido 2026-11-20): no decía de qué lote salió nada. Los lotes son
 *    `[CANON.7.4c]`.
 *  - **El candado** pasa del `FOR UPDATE` sobre el renglón de la copia a `pg_advisory_xact_lock` por
 *    (almacén, producto): dos pedidos no apartan la misma pieza a la vez.
 *  - En el movimiento, `quantity_before`/`quantity_after` guardan la existencia del ODS al momento (iguales: la
 *    Suite no mueve físico); al liberar van en NULL (no se lee la existencia).
 */
@Injectable()
export class OrderStockService {
  constructor(private readonly tenantCtx: TenantContextService) {}

  /**
   * Guard de congelamiento (Fase I): si el almacén tiene un folio de inventario
   * físico abierto con freeze_movements, bloquea el movimiento de stock — de lo
   * contrario el teórico derivaría durante el conteo y toda varianza sería falsa.
   */
  async assertNotFrozen(trx: Knex.Transaction, warehouseId: string): Promise<void> {
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

  private movimiento(
    trx: Knex.Transaction,
    m: {
      warehouseId: string;
      productId: string;
      tipo: 'reserve' | 'release' | 'sale';
      quantity: number;
      existencia: number | null;
      referenceType: string;
      referenceId: string;
    },
  ) {
    return trx('commercial.stock_movements').insert({
      tenant_id: trx.raw('public.current_tenant_id()'),
      warehouse_id: m.warehouseId,
      product_id: m.productId,
      movement_type: m.tipo,
      quantity: m.quantity,
      quantity_before: m.existencia,
      quantity_after: m.existencia,
      reference_type: m.referenceType,
      reference_id: m.referenceId,
      created_by: this.tenantCtx.get()?.userId || null,
    });
  }

  async reserve(
    trx: Knex.Transaction,
    warehouseId: string,
    productId: string,
    quantity: number,
    orderId: string,
    referenceType = 'order',
  ): Promise<void> {
    await this.assertNotFrozen(trx, warehouseId);
    await bloquearExistencia(trx, warehouseId, productId);
    const { existencia, apartado } = await existenciaYApartado(trx, warehouseId, productId);

    if (existencia - apartado < quantity) {
      throw new ConflictException(
        `Stock disponible insuficiente para producto ${productId}: ${existencia - apartado} < ${quantity}`,
      );
    }

    await this.movimiento(trx, { warehouseId, productId, tipo: 'reserve', quantity, existencia, referenceType, referenceId: orderId });
  }

  async consume(
    trx: Knex.Transaction,
    warehouseId: string,
    productId: string,
    quantity: number,
    orderId: string,
  ): Promise<{ expiredConsumed: number }> {
    await this.assertNotFrozen(trx, warehouseId);
    await bloquearExistencia(trx, warehouseId, productId);
    const { existencia } = await existenciaYApartado(trx, warehouseId, productId);
    // Una preventa NO reservó stock al confirmar → al entregar puede no alcanzar
    // el físico. Rebotar con 409 claro (misma regla que con la copia; cambia la fuente).
    if (existencia < quantity) {
      throw new ConflictException(
        `Stock físico insuficiente para entregar producto ${productId}: ${existencia} < ${quantity}`,
      );
    }
    // P2.2d (warn): si lo bueno (no vencido) no cubre la cantidad, el sobrante saldría de vencidos. Sólo se LEE:
    // los lotes son `[CANON.7.4c]` (hoy el lote NA de `stock_lots` lo mantiene la copia).
    const lots = (await trx('commercial.stock_lots')
      .where({ warehouse_id: warehouseId, product_id: productId })
      .select('quantity')
      .select(trx.raw('(expiry_date IS NULL OR expiry_date >= CURRENT_DATE) as is_good'))) as Array<{ quantity: string; is_good: boolean }>;
    const goodAvail = lots.reduce((s, l) => s + (l.is_good ? Number(l.quantity) : 0), 0);
    const expiredAvail = lots.reduce((s, l) => s + (l.is_good ? 0 : Number(l.quantity)), 0);
    // Tope en lo vencido que HAY: con la copia cuadrando (suma de lotes = existencia ≥ cantidad) el tope no cambia
    // nada; sin ella (producto sin renglón en la copia, o la copia rezagada) evita avisar «se vendió vencido» de un
    // producto que no tiene ningún lote vencido.
    const expiredConsumed = Math.min(expiredAvail, Math.max(0, quantity - goodAvail));

    await this.movimiento(trx, { warehouseId, productId, tipo: 'sale', quantity, existencia, referenceType: 'order', referenceId: orderId });
    return { expiredConsumed };
  }

  async release(
    trx: Knex.Transaction,
    warehouseId: string,
    productId: string,
    quantity: number,
    orderId: string,
    referenceType = 'order',
  ): Promise<void> {
    await this.assertNotFrozen(trx, warehouseId);
    await bloquearExistencia(trx, warehouseId, productId);
    // Se libera a lo sumo lo que ESTA referencia tiene apartado (antes: lo apartado en todo el almacén, así que un
    // pedido podía liberar el apartado de otro). Una preventa no apartó: libera 0 y lo deja escrito, como antes.
    // Sin leer la existencia: liberar no la necesita, y cancelar un pedido de muchos renglones haría una lectura de
    // la vista por renglón. El movimiento la deja en NULL (las columnas lo admiten y quien las lee lo maneja).
    const propio = await apartadoDeReferencia(trx, referenceType, orderId, warehouseId, productId);
    await this.movimiento(trx, {
      warehouseId,
      productId,
      tipo: 'release',
      quantity: Math.min(propio, quantity),
      existencia: null,
      referenceType,
      referenceId: orderId,
    });
  }
}
