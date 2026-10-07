import { Injectable, Logger } from '@nestjs/common';
import { TenantKnexService } from '@megadulces/platform-core';

/** Palabras que el cliente usa para darse de baja (opt-out). */
const OPT_OUT_WORDS = ['baja', 'stop', 'cancelar promos', 'no promos', 'no quiero promociones', 'darme de baja'];

/**
 * F.8 (ADR-034) — Consentimiento de marketing por teléfono.
 *
 * Meta banea el número si mandás marketing sin opt-in → esta tabla es la fuente
 * de verdad de a quién se le puede mandar broadcast. Opt-out ("BAJA"/"STOP") es
 * obligatorio y siempre respetado (regla dura). RLS vía TenantKnexService.
 */
@Injectable()
export class WhatsAppOptinService {
  private readonly logger = new Logger(WhatsAppOptinService.name);

  constructor(private readonly tk: TenantKnexService) {}

  /** ¿El texto entrante es una baja? (se chequea antes del orquestador). */
  isOptOutMessage(text: string | null | undefined): boolean {
    const t = (text || '').trim().toLowerCase();
    if (!t) return false;
    return OPT_OUT_WORDS.some((w) => t === w || t.startsWith(w));
  }

  async isOptedIn(phone: string): Promise<boolean> {
    return this.tk.run(async (trx) => {
      const r = await trx('whatsapp.marketing_optin').where({ phone, status: 'opted_in' }).first();
      return !!r;
    });
  }

  async optIn(phone: string, source: 'bot' | 'manual' | 'import' = 'bot'): Promise<void> {
    await this.tk.run(async (trx) => {
      await trx.raw(
        `INSERT INTO whatsapp.marketing_optin (tenant_id, phone, status, source, opted_in_at)
         VALUES (public.current_tenant_id(), ?, 'opted_in', ?, now())
         ON CONFLICT (tenant_id, phone) DO UPDATE
           SET status='opted_in', source=EXCLUDED.source, opted_in_at=now(), opted_out_at=NULL, updated_at=now()`,
        [phone, source],
      );
    });
    this.logger.log(`opt-in ${phone} (${source})`);
  }

  async optOut(phone: string): Promise<void> {
    await this.tk.run(async (trx) => {
      await trx.raw(
        `INSERT INTO whatsapp.marketing_optin (tenant_id, phone, status, source, opted_out_at)
         VALUES (public.current_tenant_id(), ?, 'opted_out', 'bot', now())
         ON CONFLICT (tenant_id, phone) DO UPDATE
           SET status='opted_out', opted_out_at=now(), updated_at=now()`,
        [phone],
      );
    });
    this.logger.log(`opt-out ${phone}`);
  }

  /** Teléfonos con consentimiento vigente (destinatarios elegibles de broadcast). */
  async listOptedInPhones(): Promise<string[]> {
    return this.tk.run(async (trx) => {
      const rows = await trx('whatsapp.marketing_optin').where({ status: 'opted_in' }).select('phone');
      return rows.map((r: any) => r.phone);
    });
  }

  /** Resumen para el panel: cuántos opted_in / opted_out. */
  async stats(): Promise<{ opted_in: number; opted_out: number }> {
    return this.tk.run(async (trx) => {
      const rows = await trx('whatsapp.marketing_optin').select('status').count('* as n').groupBy('status');
      const out = { opted_in: 0, opted_out: 0 };
      for (const r of rows as any[]) out[r.status as 'opted_in' | 'opted_out'] = Number(r.n);
      return out;
    });
  }
}
