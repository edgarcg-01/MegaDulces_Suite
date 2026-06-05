import { Inject, Injectable, Logger } from '@nestjs/common';
import { KNEX_NEW_DB, TenantKnexService } from '@megadulces/platform-core';
import { Knex } from 'knex';
import * as webpush from 'web-push';

const TABLE = 'commercial.push_subscriptions';

export interface PushSubscriptionDto {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

export interface PushPayload {
  title: string;
  body: string;
  url?: string;
  tag?: string;
}

/**
 * Web Push del Portal B2B (Fase 3). Guarda suscripciones y envía notificaciones
 * (estado de pedido, promos) vía VAPID.
 *
 * Config por env (NO hardcodear claves):
 *   VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT (mailto: o https URL).
 * Si faltan, el servicio queda inactivo (subscribe/send son no-op con warning) —
 * no rompe el arranque de la API.
 */
@Injectable()
export class CommercialPushService {
  private readonly logger = new Logger(CommercialPushService.name);
  private readonly enabled: boolean;
  readonly publicKey: string;

  constructor(
    @Inject(KNEX_NEW_DB) private readonly knex: Knex,
    private readonly tk: TenantKnexService,
  ) {
    this.publicKey = process.env.VAPID_PUBLIC_KEY || '';
    const priv = process.env.VAPID_PRIVATE_KEY || '';
    const subject = process.env.VAPID_SUBJECT || 'mailto:soporte@megadulces.com.mx';
    this.enabled = !!(this.publicKey && priv);
    if (this.enabled) {
      webpush.setVapidDetails(subject, this.publicKey, priv);
    } else {
      this.logger.warn('Web Push inactivo: faltan VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY en env.');
    }
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  /** Guarda (o refresca) la suscripción del navegador. Upsert por endpoint. */
  async subscribe(
    userId: string,
    tenantId: string | null,
    sub: PushSubscriptionDto,
    userAgent: string | null,
  ): Promise<void> {
    if (!sub?.endpoint || !sub?.keys?.p256dh || !sub?.keys?.auth) return;

    // customer_id del user (commercial.users tiene RLS → leer con tenant context).
    let customerId: string | null = null;
    try {
      const row = await this.tk.run(async (trx) =>
        trx('commercial.users').where({ id: userId }).select('customer_id').first(),
      );
      customerId = (row as { customer_id?: string })?.customer_id ?? null;
    } catch {
      customerId = null; // si no se puede resolver, queda sin customer (degradación)
    }

    await this.knex(TABLE)
      .insert({
        user_id: userId,
        tenant_id: tenantId,
        customer_id: customerId,
        endpoint: sub.endpoint,
        p256dh: sub.keys.p256dh,
        auth: sub.keys.auth,
        user_agent: userAgent ? userAgent.slice(0, 400) : null,
      })
      .onConflict('endpoint')
      .merge({
        user_id: userId,
        tenant_id: tenantId,
        customer_id: customerId,
        p256dh: sub.keys.p256dh,
        auth: sub.keys.auth,
      });
  }

  async unsubscribe(endpoint: string): Promise<void> {
    if (!endpoint) return;
    await this.knex(TABLE).where({ endpoint }).del();
  }

  /**
   * Envía a todas las suscripciones de un usuario. Limpia las muertas (404/410).
   * Devuelve cuántas se entregaron.
   */
  async sendToUser(userId: string, payload: PushPayload): Promise<{ sent: number; pruned: number }> {
    if (!this.enabled || !userId) return { sent: 0, pruned: 0 };
    const subs = await this.knex(TABLE).where({ user_id: userId }).select('*');
    return this.dispatch(subs, payload);
  }

  /** Envía a todas las suscripciones de un customer (todos sus usuarios portal). */
  async sendToCustomer(customerId: string, payload: PushPayload): Promise<{ sent: number; pruned: number }> {
    if (!this.enabled || !customerId) return { sent: 0, pruned: 0 };
    const subs = await this.knex(TABLE).where({ customer_id: customerId }).select('*');
    return this.dispatch(subs, payload);
  }

  private async dispatch(subs: any[], payload: PushPayload): Promise<{ sent: number; pruned: number }> {
    let sent = 0;
    let pruned = 0;
    // Forma que el service worker de Angular (ngsw) auto-muestra: requiere un
    // objeto `notification` en el top-level. `data.url` lo lee el click handler.
    const body = JSON.stringify({
      notification: {
        title: payload.title,
        body: payload.body,
        icon: '/assets/icons/icon-192.png',
        badge: '/assets/icons/icon-192.png',
        tag: payload.tag,
        data: { url: payload.url || '/portal/home' },
      },
    });

    for (const s of subs) {
      try {
        await webpush.sendNotification(
          { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
          body,
        );
        sent++;
        await this.knex(TABLE).where({ id: s.id }).update({ last_used_at: this.knex.fn.now() });
      } catch (err) {
        const status = (err as { statusCode?: number })?.statusCode;
        if (status === 404 || status === 410) {
          // Suscripción expirada/cancelada → limpiar.
          await this.knex(TABLE).where({ id: s.id }).del();
          pruned++;
        } else {
          this.logger.warn(`push send falló (${status ?? 'err'}): ${(err as Error)?.message}`);
        }
      }
    }
    return { sent, pruned };
  }
}
