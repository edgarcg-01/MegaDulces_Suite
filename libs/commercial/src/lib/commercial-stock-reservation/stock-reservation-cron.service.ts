import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { Knex } from 'knex';
import { KNEX_NEW_DB_ADMIN } from '@megadulces/platform-core';
import { apartadoDeReferencia, bloquearExistencia } from '../commercial-inventory/stock-state';

/**
 * FIQ.6 (ADR-038) — Cron de auto-liberación de apartados vencidos.
 *
 * Cada 5 min libera las reservas con `expires_at < NOW()` que sigan activas
 * (released_at IS NULL): escribe un movimiento 'release' (reference_type='reservation')
 * por lo que cada línea tenía apartado y marca la reserva `released_reason='expired'`.
 * Desde `[CANON.7.4b]` no toca la copia `commercial.stock`: el apartado se deriva del
 * libro de movimientos (`APARTADO_VIVO_SQL`).
 *
 * Cross-tenant: el cron es un job global del API sin tenant context. Usa
 * `KNEX_NEW_DB_ADMIN` (rol postgres, BYPASSRLS) y opera keyed por el `tenant_id`
 * propio de cada reserva (nunca `current_tenant_id()`, que aquí sería NULL).
 * No liberar reservas de un tenant con las de otro: cada UPDATE lleva su tenant.
 *
 * Riesgo aceptado: no exponer por HTTP. Solo lo invoca @Cron. Offset a segundo 30
 * para no colisionar con el cron de televenta (segundo 0).
 */
@Injectable()
export class StockReservationCronService {
  private readonly logger = new Logger(StockReservationCronService.name);
  private isRunning = false;

  constructor(@Inject(KNEX_NEW_DB_ADMIN) private readonly knex: Knex) {}

  @Cron('30 */5 * * * *') // cada 5 min, segundo 30
  async releaseExpired(): Promise<void> {
    if (this.isRunning) {
      this.logger.warn('releaseExpired(reservations): corrida previa en curso, skip');
      return;
    }
    this.isRunning = true;
    try {
      const expired = await this.knex('commercial.stock_reservations')
        .whereNull('released_at')
        .where('expires_at', '<', this.knex.fn.now())
        .select('id', 'tenant_id');

      let released = 0;
      for (const r of expired) {
        await this.knex.transaction(async (trx) => {
          const lines = await trx('commercial.stock_reservation_lines')
            .where({ tenant_id: r.tenant_id, reservation_id: r.id })
            .select('product_id', 'warehouse_id', 'quantity');

          // `[CANON.7.4b]` El apartado vive en el libro de movimientos, no en la copia: se escribe la liberación
          // de lo que ESTA reserva tiene apartado y nada más (marcarla `released_at` ya la saca del apartado vivo).
          for (const l of lines) {
            await bloquearExistencia(trx, l.warehouse_id, l.product_id);
            const propio = await apartadoDeReferencia(trx, 'reservation', r.id, l.warehouse_id, l.product_id);
            const rel = Math.min(propio, Number(l.quantity));
            if (rel <= 0) continue;
            await trx('commercial.stock_movements').insert({
              tenant_id: r.tenant_id,
              warehouse_id: l.warehouse_id,
              product_id: l.product_id,
              movement_type: 'release',
              quantity: rel,
              quantity_before: null,
              quantity_after: null,
              reference_type: 'reservation',
              reference_id: r.id,
            });
          }

          const n = await trx('commercial.stock_reservations')
            .where({ id: r.id, tenant_id: r.tenant_id })
            .whereNull('released_at')
            .update({ released_at: trx.fn.now(), released_reason: 'expired', updated_at: trx.fn.now() });
          released += n;
        });
      }

      if (released > 0) this.logger.log(`releaseExpired(reservations): ${released} apartados vencidos liberados`);
    } catch (e: any) {
      this.logger.error(`releaseExpired(reservations) falló: ${e.message}`);
    } finally {
      this.isRunning = false;
    }
  }
}
