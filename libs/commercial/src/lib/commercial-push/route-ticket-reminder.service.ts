import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { Knex } from 'knex';
import { KNEX_NEW_DB } from '@megadulces/platform-core';
import { CommercialPushService } from './commercial-push.service';

/**
 * Recordatorio push de cierre de ruta. A las 15:00 y 16:00 (MX) busca vendedores
 * que AÚN no subieron su corte de venta y/o su carga del día y les manda un push.
 *
 * Hoy el set de "quién debería haber subido" = todos los `vendedor` activos del
 * tenant. Más adelante se afina con la ruta del día / tracking (entonces solo se
 * avisa a quienes efectivamente salieron a ruta).
 *
 * No-op si Web Push está inactivo (sin VAPID) o si TICKET_REMINDERS_ENABLED='false'.
 */
@Injectable()
export class RouteTicketReminderService {
  private readonly logger = new Logger(RouteTicketReminderService.name);
  private running = false;

  constructor(
    @Inject(KNEX_NEW_DB) private readonly knex: Knex,
    private readonly push: CommercialPushService,
  ) {}

  @Cron('0 0 15,16 * * *', { timeZone: 'America/Mexico_City' })
  async scheduled(): Promise<void> {
    if (process.env.TICKET_REMINDERS_ENABLED === 'false') return;
    if (!this.push.isEnabled()) {
      this.logger.warn('Recordatorios skip: Web Push inactivo (faltan VAPID).');
      return;
    }
    if (this.running) {
      this.logger.warn('Recordatorios skip: ejecución previa aún en curso.');
      return;
    }
    await this.run();
  }

  /** Corre el barrido (también invocable manualmente para pruebas). */
  async run(): Promise<{ vendors: number; reminded: number }> {
    this.running = true;
    let vendorsTotal = 0;
    let reminded = 0;
    try {
      const today = this.mxToday();
      const tenants = await this.knex('public.tenants').where({ activo: true }).select('id');
      for (const t of tenants) {
        const r = await this.remindTenant(t.id, today);
        vendorsTotal += r.vendors;
        reminded += r.reminded;
      }
      this.logger.log(
        `Recordatorio cierre de ruta (${today}): ${reminded}/${vendorsTotal} vendedor(es) avisado(s).`,
      );
      return { vendors: vendorsTotal, reminded };
    } finally {
      this.running = false;
    }
  }

  private async remindTenant(
    tenantId: string,
    today: string,
  ): Promise<{ vendors: number; reminded: number }> {
    return this.knex.transaction(async (trx) => {
      await trx.raw(`SET LOCAL app.tenant_id = '${tenantId}'`);

      const vendors = await trx('public.users')
        .where({ role_name: 'vendedor', tenant_id: tenantId })
        .whereNull('deleted_at')
        .select('id');
      if (!vendors.length) return { vendors: 0, reminded: 0 };

      // Tickets requeridos de HOY (venta + carga). Combustible es opcional.
      const tickets = await trx('commercial.route_tickets')
        .where('ticket_date', today)
        .whereIn('ticket_type', ['venta', 'carga'])
        .whereNull('deleted_at')
        .select('vendor_user_id', 'ticket_type');

      const have = new Map<string, Set<string>>();
      for (const t of tickets) {
        const set = have.get(t.vendor_user_id) ?? new Set<string>();
        set.add(t.ticket_type);
        have.set(t.vendor_user_id, set);
      }

      let reminded = 0;
      for (const v of vendors) {
        const got = have.get(v.id) ?? new Set<string>();
        const missing: string[] = [];
        if (!got.has('venta')) missing.push('corte de venta');
        if (!got.has('carga')) missing.push('carga');
        if (!missing.length) continue; // ya subió lo obligatorio

        const res = await this.push.sendToUser(v.id, {
          title: 'Cierre de ruta pendiente',
          body: `Aún no subís tu ${missing.join(' y ')} de hoy. Tocá para subirlo.`,
          url: '/vendor/close-route',
          tag: 'ticket-reminder',
        });
        if (res.sent > 0) reminded++;
      }
      return { vendors: vendors.length, reminded };
    });
  }

  /** Fecha de hoy en zona MX (YYYY-MM-DD) — coincide con route_tickets.ticket_date. */
  private mxToday(): string {
    return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Mexico_City' });
  }
}
