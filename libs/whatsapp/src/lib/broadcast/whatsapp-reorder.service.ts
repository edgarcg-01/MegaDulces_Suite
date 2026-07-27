import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { TenantKnexService } from '@megadulces/platform-core';
import type { CommerceConversationPort, ConversationReorderCandidate } from '@megadulces/contracts';
import { COMMERCE_CONVERSATION_PORT } from '@megadulces/contracts';
import { WhatsAppOptinService } from './whatsapp-optin.service';
import { WhatsAppCampaignService } from './whatsapp-campaign.service';

/**
 * FIQ.10 — Outbound proactivo de REORDEN (NBA).
 *
 * El MOTOR decide a QUIÉN nudgear (clientes atrasados vs su cadencia, vía el
 * puerto → customer_360 + recommended_baskets) y con QUÉ producto; este servicio
 * (dominio whatsapp) COMPONE el mensaje, respeta opt-in (Meta) + anti-spam
 * (cooldown), registra en whatsapp.reorder_nudges (idempotencia + atribución) y
 * ENVÍA por la campaña de plantilla aprobada (WhatsAppCampaignService).
 *
 * El ENVÍO fuera de la ventana 24h EXIGE una plantilla Meta aprobada
 * (WHATSAPP_REORDER_TEMPLATE). Sin ella, `run` deja los nudges 'skipped'
 * reason='no_template' (el targeting/plan sí funciona → validable sin Meta).
 * Nunca auto-enviamos por cron: se dispara explícito (endpoint admin).
 */

export interface ReorderPlanItem {
  customer_id: string;
  name: string;
  phone: string;
  days_overdue: number;
  top_product: string | null;
  message: string;
}

const COOLDOWN_DAYS = Number(process.env.WHATSAPP_REORDER_COOLDOWN_DAYS) || 14;

@Injectable()
export class WhatsAppReorderService {
  private readonly logger = new Logger(WhatsAppReorderService.name);

  constructor(
    private readonly tk: TenantKnexService,
    private readonly optin: WhatsAppOptinService,
    private readonly campaigns: WhatsAppCampaignService,
    @Optional() @Inject(COMMERCE_CONVERSATION_PORT) private readonly commerce?: CommerceConversationPort,
  ) {}

  /** Mensaje determinista de reorden (el motor puso el producto; el LLM no interviene). */
  composeReorderMessage(c: ConversationReorderCandidate): string {
    const first = (c.name || '').trim().split(/\s+/)[0] || '';
    const hi = first ? `Hola ${first} 👋` : 'Hola 👋';
    const prod = c.top_product ? ` tu ${c.top_product}` : ' tu pedido habitual';
    return `${hi} Somos de Mega Dulces 🍬 Notamos que quizá ya se te está acabando${prod}. ¿Te reabastecemos? Respondé este mensaje y armamos tu pedido a domicilio.`;
  }

  /**
   * Plan de reorden (SIN escribir ni enviar): clientes debidos ∩ opted-in ∩ no
   * nudgeados en el cooldown, con su mensaje compuesto. Es el deliverable validable.
   */
  async preview(opts: { limit?: number; minOverdueDays?: number } = {}): Promise<{
    total_due: number;
    eligible: ReorderPlanItem[];
    skipped: { not_opted_in: number; recently_nudged: number };
  }> {
    if (!this.commerce) return { total_due: 0, eligible: [], skipped: { not_opted_in: 0, recently_nudged: 0 } };
    const due = await this.commerce.listDueForReorder({ limit: opts.limit ?? 50, minOverdueDays: opts.minOverdueDays });

    const optedIn = new Set(await this.optin.listOptedInPhones());
    const recentlyNudged = await this.recentlyNudgedCustomerIds();

    let notOptedIn = 0;
    let recent = 0;
    const eligible: ReorderPlanItem[] = [];
    for (const c of due) {
      if (!optedIn.has(c.phone)) { notOptedIn++; continue; }
      if (recentlyNudged.has(c.customer_id)) { recent++; continue; }
      eligible.push({
        customer_id: c.customer_id,
        name: c.name,
        phone: c.phone,
        days_overdue: c.days_overdue,
        top_product: c.top_product,
        message: this.composeReorderMessage(c),
      });
    }
    return { total_due: due.length, eligible, skipped: { not_opted_in: notOptedIn, recently_nudged: recent } };
  }

  /**
   * Ejecuta el nudge: registra en reorder_nudges y, si hay plantilla aprobada,
   * crea+envía la campaña dirigida. `dryRun` devuelve el plan sin escribir.
   */
  async run(opts: { limit?: number; minOverdueDays?: number; dryRun?: boolean } = {}): Promise<any> {
    const plan = await this.preview(opts);
    if (opts.dryRun) return { dry_run: true, ...plan };
    if (plan.eligible.length === 0) return { dry_run: false, sent: 0, skipped: plan.skipped, ...plan };

    const template = process.env.WHATSAPP_REORDER_TEMPLATE;

    // 1) Registrar los nudges (idempotencia + atribución). status inicial 'planned'.
    const inserted = await this.tk.run(async (trx) =>
      trx('whatsapp.reorder_nudges')
        .insert(
          plan.eligible.map((e) => ({
            tenant_id: trx.raw('public.current_tenant_id()'),
            customer_id: e.customer_id,
            phone: e.phone,
            days_overdue: e.days_overdue,
            top_product: e.top_product,
            message: e.message,
            status: 'planned',
          })),
        )
        .returning(['id', 'customer_id']),
    );

    // 2) Enviar SOLO si hay plantilla aprobada (Meta exige plantilla fuera de 24h).
    if (!template) {
      await this.tk.run((trx) =>
        trx('whatsapp.reorder_nudges')
          .whereIn('id', inserted.map((r: any) => r.id))
          .update({ status: 'skipped', reason: 'no_template' }),
      );
      this.logger.warn(`Reorden: ${inserted.length} nudges planeados pero WHATSAPP_REORDER_TEMPLATE no configurada → skipped.`);
      return { dry_run: false, planned: inserted.length, sent: 0, reason: 'no_template', skipped: plan.skipped };
    }

    const campaign = await this.campaigns.createTargeted(
      { name: `Reorden ${new Date().toISOString().slice(0, 10)}`, template_name: template },
      plan.eligible.map((e) => e.phone),
    );
    await this.campaigns.send(campaign.campaign_id);
    await this.tk.run((trx) =>
      trx('whatsapp.reorder_nudges')
        .whereIn('id', inserted.map((r: any) => r.id))
        .update({ status: 'sent', reason: 'sent', campaign_id: campaign.campaign_id, sent_at: trx.fn.now() }),
    );
    this.logger.log(`Reorden: campaña ${campaign.campaign_id} con ${campaign.recipients} destinatarios.`);
    return { dry_run: false, planned: inserted.length, campaign_id: campaign.campaign_id, recipients: campaign.recipients, skipped: plan.skipped };
  }

  /** customer_ids nudgeados dentro del cooldown (anti-spam). */
  private async recentlyNudgedCustomerIds(): Promise<Set<string>> {
    const rows = await this.tk.run((trx) =>
      trx('whatsapp.reorder_nudges')
        .where('created_at', '>', trx.raw(`now() - (? || ' days')::interval`, [COOLDOWN_DAYS]))
        .distinct('customer_id'),
    );
    return new Set(rows.map((r: any) => r.customer_id));
  }
}
