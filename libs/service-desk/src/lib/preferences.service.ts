/**
 * `[MS.2.6]` Datos de contacto y preferencias de aviso de CADA persona sobre sí misma.
 *
 * Cada quien edita lo suyo (el `userId` sale del token, nunca del cuerpo): nadie puede apuntar el WhatsApp
 * de otra persona a su propio número. `identity.users` no tenía correo ni teléfono antes de MS.1.3.
 *
 * Consentimiento de WhatsApp: activarlo exige TELÉFONO y deja escrita la fecha de aceptación
 * (`whatsapp_opt_in_at`); la base lo vuelve imposible de saltar con un CHECK. Volver a activarlo después
 * de haberlo apagado cuenta como un consentimiento NUEVO y renueva la fecha.
 */
import { BadRequestException, Injectable } from '@nestjs/common';
import type { SdPreferencesDto, SdUpdatePreferencesDto } from '@megadulces/contracts';
import { TenantContextService, TenantKnexService, normalizeMxPhone } from '@megadulces/platform-core';
import type { ActorCtx } from './service-desk.types';

// El mismo patrón que `users_email_fmt_ck`: la base lo exigiría igual, pero acá el error sale en español.
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/i;
const PHONE_CANON_RE = /^52[0-9]{10}$/;

@Injectable()
export class ServiceDeskPreferencesService {
  constructor(
    private readonly tk: TenantKnexService,
    private readonly tenantCtx: TenantContextService,
  ) {}

  async get(userId: string): Promise<SdPreferencesDto> {
    return this.tk.run(async (trx) => {
      const u = await trx('identity.users').where({ id: userId }).first('email', 'phone');
      const p = await trx('servicedesk.notification_prefs').where({ user_id: userId }).first();
      return {
        email: u?.email ?? null,
        phone: u?.phone ?? null,
        email_enabled: p ? !!p.email_enabled : true, // sin fila, el correo cuenta como encendido
        whatsapp_enabled: p ? !!p.whatsapp_enabled : false,
        whatsapp_opt_in_at: p?.whatsapp_opt_in_at ? new Date(p.whatsapp_opt_in_at).toISOString() : null,
      };
    });
  }

  async update(ctx: ActorCtx, dto: SdUpdatePreferencesDto): Promise<SdPreferencesDto> {
    const cambios: { email?: string | null; phone?: string | null } = {};
    if (dto.email !== undefined) {
      const e = dto.email === null ? '' : String(dto.email).trim();
      if (e && (e.length > 200 || !EMAIL_RE.test(e))) throw new BadRequestException('El correo no tiene un formato válido');
      cambios.email = e || null;
    }
    if (dto.phone !== undefined) {
      const raw = dto.phone === null ? '' : String(dto.phone).trim();
      const canon = raw ? normalizeMxPhone(raw) : null;
      if (raw && (!canon || !PHONE_CANON_RE.test(canon))) throw new BadRequestException('El teléfono debe ser un celular de México de 10 dígitos');
      cambios.phone = canon;
    }
    for (const k of ['email_enabled', 'whatsapp_enabled'] as const) {
      if (dto[k] !== undefined && typeof dto[k] !== 'boolean') throw new BadRequestException(`${k} debe ser verdadero o falso`);
    }

    await this.tk.run(async (trx) => {
      if (Object.keys(cambios).length) await trx('identity.users').where({ id: ctx.userId }).update(cambios);

      const u = await trx('identity.users').where({ id: ctx.userId }).first('phone');
      const p = await trx('servicedesk.notification_prefs').where({ user_id: ctx.userId }).first();
      const quiereWhatsapp = dto.whatsapp_enabled ?? (p ? !!p.whatsapp_enabled : false);
      if (quiereWhatsapp && !u?.phone) throw new BadRequestException('Para recibir WhatsApp primero registra tu teléfono');
      // Una baja de teléfono con WhatsApp encendido dejaría un canal sin destino: se apaga junto con el número.
      const apagarPorFaltaDeTelefono = !u?.phone && !!p?.whatsapp_enabled;
      const enabled = apagarPorFaltaDeTelefono ? false : quiereWhatsapp;

      const activaAhora = enabled && !(p && p.whatsapp_enabled);
      const optIn = activaAhora ? new Date() : (p?.whatsapp_opt_in_at ?? null);

      await trx.raw(
        `INSERT INTO servicedesk.notification_prefs (tenant_id, user_id, email_enabled, whatsapp_enabled, whatsapp_opt_in_at, updated_by)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (tenant_id, user_id) DO UPDATE
           SET email_enabled = EXCLUDED.email_enabled, whatsapp_enabled = EXCLUDED.whatsapp_enabled,
               whatsapp_opt_in_at = EXCLUDED.whatsapp_opt_in_at, updated_at = now(), updated_by = EXCLUDED.updated_by`,
        [this.tenantCtx.requireTenantId(), ctx.userId, dto.email_enabled ?? (p ? !!p.email_enabled : true), enabled, optIn, ctx.userId],
      );
    });
    return this.get(ctx.userId);
  }
}
