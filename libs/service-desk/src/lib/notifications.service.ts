/**
 * `[MS.2.6]` Avisos de la Mesa de Servicio: a quién, por qué canal, y CON QUÉ RESULTADO.
 *
 * ── Qué mide ─────────────────────────────────────────────────────────────────────────────────
 * Cada intento deja una fila en `servicedesk.notification_log` con `sent` / `failed` / `skipped` y el
 * motivo. Mide ENTREGA, no intención (ADR-053): «SMTP no configurado» o «sin correo registrado» quedan
 * escritos como `skipped`, no como un envío fingido. Hoy `identity.users` no tenía ni correo ni teléfono
 * (se agregaron en MS.1.3) y el SMTP de prod no está configurado: este servicio lo DECLARA en vez de callar.
 *
 * ── Tres canales ─────────────────────────────────────────────────────────────────────────────
 *  · `app`      — SIEMPRE: la fila misma es la entrega (la campana la recoge por poll) y, si el proceso
 *                 tiene WebSocket, además se empuja en vivo. El worker —donde corren los crons— no tiene
 *                 WebSocket (ADR-080): por eso una alerta del SLA no puede depender sólo del push.
 *  · `email`    — si el usuario no lo apagó y tiene correo. Pasa por `MAILER_PORT`.
 *  · `whatsapp` — SÓLO con consentimiento explícito (`whatsapp_opt_in_at`, lo exige un CHECK) y teléfono.
 *                 Sin plantilla Meta aprobada (P5) no hay binding: queda `skipped` con su motivo.
 *
 * ── Anti-repetición ───────────────────────────────────────────────────────────────────────────
 * La fila `app` es la COMPUERTA: se inserta con `ON CONFLICT … DO NOTHING` sobre la llave de dedup. Si ya
 * existía, ese aviso ya salió y no se repite por NINGÚN canal. (El índice único sólo cuenta lo `sent`: un
 * intento fallido sí puede reintentarse.)
 *
 * ── Nunca bloquea ────────────────────────────────────────────────────────────────────────────
 * Un aviso que falla no puede tumbar la operación que lo originó: todo está envuelto y sólo deja rastro.
 */
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import type { Knex } from 'knex';
import {
  MAILER_PORT,
  SERVICE_DESK_CHANNEL_PORT,
  type MailerPort,
  type SdNotificationDto,
  type SdPriority,
  type ServiceDeskChannelPort,
} from '@megadulces/contracts';
import { TenantKnexService } from '@megadulces/platform-core';
import { armarAviso, llaveDeAviso, type SdEventoClave } from './domain/notice';

/** Lo que pasó y a quién le toca saberlo. Lo arma quien provoca el evento, DESPUÉS de confirmar su transacción. */
export interface SdEvento {
  event: SdEventoClave;
  request_id: string;
  folio: string;
  title: string;
  priority: SdPriority;
  /** Destinatarios (userId). Quien provocó el evento NO se avisa a sí mismo: se filtra con `actor_id`. */
  recipients: string[];
  actor_id?: string | null;
  actor_name?: string | null;
  extracto?: string | null;
  dias?: number | null;
  /** Distingue dos avisos legítimos del mismo tipo sobre el mismo ticket (p. ej. dos comentarios). */
  discriminador?: string | number | null;
}

interface Contacto {
  id: string;
  username: string;
  nombre: string | null;
  email: string | null;
  phone: string | null;
  email_enabled: boolean | null;
  whatsapp_enabled: boolean | null;
  whatsapp_opt_in_at: Date | null;
}

type Canal = 'app' | 'email' | 'whatsapp';

@Injectable()
export class ServiceDeskNotificationsService {
  private readonly logger = new Logger(ServiceDeskNotificationsService.name);

  constructor(
    private readonly tk: TenantKnexService,
    @Optional() @Inject(MAILER_PORT) private readonly mailer?: MailerPort,
    @Optional() @Inject(SERVICE_DESK_CHANNEL_PORT) private readonly channels?: ServiceDeskChannelPort,
  ) {}

  /** Entrega una lista de eventos. Best-effort: nunca lanza. */
  async dispatch(tenantId: string, eventos: SdEvento[]): Promise<void> {
    if (!eventos.length) return;
    try {
      await this.tk.run(tenantId, async (trx) => {
        for (const ev of eventos) await this.entregarEvento(trx, tenantId, ev);
      });
    } catch (e) {
      this.logger.warn(`Los avisos de ${eventos.length} evento(s) no se pudieron entregar: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /** Los avisos `app` de una persona, del más nuevo al más viejo. `since` evita releer lo que la campana ya mostró. */
  async listApp(userId: string, since?: string, limit = 30): Promise<SdNotificationDto[]> {
    const desde = since ? new Date(since) : null;
    const lim = Math.min(Math.max(Number(limit) || 30, 1), 100);
    return this.tk.run(async (trx) => {
      const q = trx('servicedesk.notification_log as n')
        .leftJoin('servicedesk.requests as r', function () {
          this.on('r.tenant_id', 'n.tenant_id').andOn('r.id', 'n.request_id');
        })
        .where({ 'n.recipient_id': userId, 'n.channel': 'app' })
        .orderBy('n.created_at', 'desc')
        .limit(lim)
        .select('n.id', 'n.event', 'n.request_id', 'n.payload', 'n.created_at', 'r.folio');
      if (desde && !Number.isNaN(desde.getTime())) q.where('n.created_at', '>', desde);
      const rows: { id: string; event: string; request_id: string | null; payload: Record<string, unknown> | null; created_at: Date; folio: string | null }[] = await q;
      return rows.map((r) => ({
        id: r.id,
        event: r.event,
        request_id: r.request_id,
        folio: r.folio ?? null,
        severity: (r.payload?.['severity'] as SdNotificationDto['severity']) ?? 'info',
        title: String(r.payload?.['title'] ?? ''),
        message: String(r.payload?.['message'] ?? ''),
        created_at: new Date(r.created_at).toISOString(),
      }));
    });
  }

  // ───────────────────────────── internos ─────────────────────────────

  private async entregarEvento(trx: Knex.Transaction, tenantId: string, ev: SdEvento): Promise<void> {
    const ids = [...new Set(ev.recipients)].filter((id) => id && id !== ev.actor_id);
    if (!ids.length) return;
    const aviso = armarAviso({ event: ev.event, folio: ev.folio, title: ev.title, priority: ev.priority, actor: ev.actor_name, extracto: ev.extracto, dias: ev.dias });

    const contactos: Contacto[] = await trx('identity.users as u')
      .leftJoin('servicedesk.notification_prefs as p', function () {
        this.on('p.tenant_id', 'u.tenant_id').andOn('p.user_id', 'u.id');
      })
      .whereIn('u.id', ids)
      .whereNull('u.deleted_at')
      .select('u.id', 'u.username', 'u.nombre', 'u.email', 'u.phone', 'p.email_enabled', 'p.whatsapp_enabled', 'p.whatsapp_opt_in_at');

    for (const c of contactos) {
      try {
        // La llave lleva al DESTINATARIO: el índice único de la base no lo menciona (ver `llaveDeAviso`).
        const dedup = llaveDeAviso(ev.event, ev.request_id, c.id, ev.discriminador);
        const payload = { title: aviso.title, message: aviso.message, severity: aviso.severity, folio: ev.folio, priority: ev.priority };
        // 1) La fila `app` es la compuerta anti-repetición Y la entrega más confiable.
        const nuevo = await this.registrar(trx, tenantId, ev, c.id, 'app', 'sent', null, dedup, payload);
        if (!nuevo) continue; // ya salió: no se repite por ningún canal
        try {
          this.channels?.pushToUser?.(tenantId, c.username, {
            type: 'service_desk',
            severity: aviso.severity,
            title: aviso.title,
            message: aviso.message,
            data: { source: 'service_desk', event: ev.event, request_id: ev.request_id, folio: ev.folio },
          });
        } catch (e) {
          this.logger.warn(`push en vivo a ${c.username} falló (la fila app ya quedó): ${e instanceof Error ? e.message : String(e)}`);
        }
        await this.correo(trx, tenantId, ev, c, aviso.title, aviso.message, dedup, payload);
        await this.whatsapp(trx, tenantId, ev, c, aviso.title, aviso.message, dedup, payload);
      } catch (e) {
        this.logger.warn(`aviso ${ev.event} a ${c.username} falló: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }

  private async correo(trx: Knex.Transaction, tenantId: string, ev: SdEvento, c: Contacto, title: string, message: string, dedup: string, payload: Record<string, unknown>): Promise<void> {
    // El correo está ENCENDIDO por defecto (sin fila de preferencias cuenta como sí); quien lo apagó no recibe nada.
    if (c.email_enabled === false) return;
    if (!c.email) return void (await this.registrar(trx, tenantId, ev, c.id, 'email', 'skipped', 'sin_correo_registrado', dedup, payload));
    if (!this.mailer || !this.mailer.isConfigured()) {
      return void (await this.registrar(trx, tenantId, ev, c.id, 'email', 'skipped', 'smtp_no_configurado', dedup, payload));
    }
    const r = await this.mailer.send({ to: [c.email], subject: `[${ev.folio}] ${title}`, text: `${message}\n\n— Mesa de Servicio · Mega Dulces` });
    await this.registrar(trx, tenantId, ev, c.id, 'email', r.ok ? 'sent' : 'failed', r.ok ? null : (r.error ?? 'error_desconocido'), dedup, payload);
  }

  private async whatsapp(trx: Knex.Transaction, tenantId: string, ev: SdEvento, c: Contacto, title: string, message: string, dedup: string, payload: Record<string, unknown>): Promise<void> {
    // Sin consentimiento NO se intenta ni se registra: nadie lo pidió.
    if (!c.whatsapp_enabled || !c.whatsapp_opt_in_at) return;
    if (!c.phone) return void (await this.registrar(trx, tenantId, ev, c.id, 'whatsapp', 'skipped', 'sin_telefono_registrado', dedup, payload));
    if (!this.channels?.sendWhatsApp) {
      return void (await this.registrar(trx, tenantId, ev, c.id, 'whatsapp', 'skipped', 'whatsapp_no_configurado', dedup, payload));
    }
    const r = await this.channels.sendWhatsApp(c.phone, `*${title}*\n${message}`);
    await this.registrar(trx, tenantId, ev, c.id, 'whatsapp', r.ok ? 'sent' : 'failed', r.ok ? null : (r.error ?? 'error_desconocido'), dedup, payload);
  }

  /** Devuelve `true` si INSERTÓ la fila; `false` si la llave de dedup ya tenía un envío (`sent`) para ese canal. */
  private async registrar(
    trx: Knex.Transaction,
    tenantId: string,
    ev: SdEvento,
    recipientId: string,
    channel: Canal,
    status: 'sent' | 'failed' | 'skipped',
    error: string | null,
    dedup: string,
    payload: Record<string, unknown>,
  ): Promise<boolean> {
    const { rows } = await trx.raw(
      `INSERT INTO servicedesk.notification_log
         (tenant_id, request_id, recipient_id, event, channel, status, error, dedup_key, payload, sent_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?::jsonb, ${status === 'sent' ? 'now()' : 'NULL'})
       ON CONFLICT (tenant_id, dedup_key, channel) WHERE dedup_key IS NOT NULL AND status = 'sent' DO NOTHING
       RETURNING id`,
      [tenantId, ev.request_id, recipientId, ev.event, channel, status, error, dedup, JSON.stringify(payload)],
    );
    return rows.length > 0;
  }
}
