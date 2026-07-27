import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { TenantContextService, TenantKnexService } from '@megadulces/platform-core';
import type { WhatsAppPort } from '../ports/whatsapp.port';
import { WHATSAPP_PORT } from '../ports/whatsapp.port';
import { WhatsAppOptinService } from './whatsapp-optin.service';

export interface CreateCampaignDto {
  name: string;
  template_name: string;
  language?: string;
  image_url?: string;
  body_params?: string[];
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * F.8 (ADR-034) — Campañas de broadcast de promos.
 *
 * `create` arma la campaña (plantilla + imagen) y CONGELA los destinatarios =
 * teléfonos con opt-in vigente. `send` hace el fan-out en segundo plano por la
 * plantilla aprobada, con rate-limit (pausa entre envíos, muy por debajo del tier
 * de Meta) y tracking por destinatario. Respeta el opt-in (fuente: marketing_optin).
 *
 * El fan-out corre detached (el endpoint responde ya); re-establece el scope de
 * tenant con tenantCtx.run porque corre fuera del request.
 */
@Injectable()
export class WhatsAppCampaignService {
  private readonly logger = new Logger(WhatsAppCampaignService.name);
  private readonly rateDelayMs = Number(process.env.WHATSAPP_BROADCAST_DELAY_MS) || 350;

  constructor(
    private readonly tk: TenantKnexService,
    private readonly tenantCtx: TenantContextService,
    private readonly optin: WhatsAppOptinService,
    @Inject(WHATSAPP_PORT) private readonly port: WhatsAppPort,
  ) {}

  /** Crea la campaña en draft y congela destinatarios (opted-in vigentes). */
  async create(dto: CreateCampaignDto) {
    if (!dto?.name?.trim()) throw new BadRequestException('name requerido');
    if (!dto?.template_name?.trim()) throw new BadRequestException('template_name requerido (plantilla aprobada en Meta)');

    const phones = await this.optin.listOptedInPhones();
    return this.tk.run(async (trx) => {
      const [c] = await trx('whatsapp.campaigns')
        .insert({
          tenant_id: trx.raw('public.current_tenant_id()'),
          name: dto.name.trim(),
          template_name: dto.template_name.trim(),
          language: dto.language || 'es_MX',
          image_url: dto.image_url || null,
          body_params: JSON.stringify(dto.body_params || []),
          status: 'draft',
          total: phones.length,
          created_by: this.tenantCtx.get()?.userId || null,
        })
        .returning(['id', 'name', 'total']);

      if (phones.length) {
        await trx('whatsapp.campaign_recipients')
          .insert(phones.map((phone) => ({ tenant_id: trx.raw('public.current_tenant_id()'), campaign_id: c.id, phone, status: 'pending' })))
          .onConflict(['tenant_id', 'campaign_id', 'phone'])
          .ignore();
      }
      return { campaign_id: c.id, name: c.name, recipients: c.total };
    });
  }

  /**
   * FIQ.10 — Como create() pero con destinatarios EXPLÍCITOS (subconjunto dirigido,
   * p. ej. clientes debidos para reorden). Se intersecta con opted-in por seguridad
   * (Meta banea el número si mandás marketing sin consentimiento).
   */
  async createTargeted(dto: CreateCampaignDto, phones: string[]) {
    if (!dto?.name?.trim()) throw new BadRequestException('name requerido');
    if (!dto?.template_name?.trim()) throw new BadRequestException('template_name requerido (plantilla aprobada en Meta)');
    const optedIn = new Set(await this.optin.listOptedInPhones());
    const targets = [...new Set(phones)].filter((p) => optedIn.has(p));
    return this.tk.run(async (trx) => {
      const [c] = await trx('whatsapp.campaigns')
        .insert({
          tenant_id: trx.raw('public.current_tenant_id()'),
          name: dto.name.trim(),
          template_name: dto.template_name.trim(),
          language: dto.language || 'es_MX',
          image_url: dto.image_url || null,
          body_params: JSON.stringify(dto.body_params || []),
          status: 'draft',
          total: targets.length,
          created_by: this.tenantCtx.get()?.userId || null,
        })
        .returning(['id', 'name', 'total']);
      if (targets.length) {
        await trx('whatsapp.campaign_recipients')
          .insert(targets.map((phone) => ({ tenant_id: trx.raw('public.current_tenant_id()'), campaign_id: c.id, phone, status: 'pending' })))
          .onConflict(['tenant_id', 'campaign_id', 'phone'])
          .ignore();
      }
      return { campaign_id: c.id, name: c.name, recipients: c.total };
    });
  }

  /** Dispara el envío (fan-out en segundo plano). Devuelve de inmediato. */
  async send(campaignId: string) {
    const tenantId = this.tenantCtx.requireTenantId();
    const camp = await this.tk.run((trx) => trx('whatsapp.campaigns').where({ id: campaignId }).first());
    if (!camp) throw new NotFoundException('Campaña no encontrada');
    if (camp.status === 'sending') throw new BadRequestException('La campaña ya se está enviando');
    if (camp.status === 'done') throw new BadRequestException('La campaña ya se envió');

    await this.tk.run((trx) =>
      trx('whatsapp.campaigns').where({ id: campaignId }).update({ status: 'sending', started_at: trx.fn.now(), updated_at: trx.fn.now() }),
    );

    // Fan-out detached (no bloquea la respuesta). Re-establece scope de tenant.
    void this.tenantCtx
      .run({ tenantId }, () => this.runFanout(campaignId, camp))
      .catch((e: any) => this.logger.error(`fan-out campaña ${campaignId} falló: ${e?.message}`));

    return { campaign_id: campaignId, status: 'sending', total: camp.total };
  }

  private async runFanout(campaignId: string, camp: any): Promise<void> {
    const bodyParams = typeof camp.body_params === 'string' ? JSON.parse(camp.body_params) : camp.body_params || [];
    let sent = 0;
    let failed = 0;

    // Paginado simple: procesa los pending de a lotes.
    for (;;) {
      const batch = await this.tk.run((trx) =>
        trx('whatsapp.campaign_recipients').where({ campaign_id: campaignId, status: 'pending' }).limit(50).select('id', 'phone'),
      );
      if (!batch.length) break;

      for (const r of batch) {
        try {
          const res = await this.port.sendTemplate(r.phone, {
            name: camp.template_name,
            language: camp.language || 'es_MX',
            imageLink: camp.image_url || undefined,
            bodyParams,
          });
          await this.tk.run((trx) =>
            trx('whatsapp.campaign_recipients').where({ id: r.id }).update({ status: 'sent', wa_message_id: res.message_id, sent_at: trx.fn.now() }),
          );
          sent++;
        } catch (e: any) {
          await this.tk.run((trx) =>
            trx('whatsapp.campaign_recipients').where({ id: r.id }).update({ status: 'failed', error: (e?.message || 'error').slice(0, 500) }),
          );
          failed++;
        }
        await sleep(this.rateDelayMs); // rate-limit (muy por debajo del tier de Meta)
      }

      await this.tk.run((trx) =>
        trx('whatsapp.campaigns').where({ id: campaignId }).update({ sent, failed, updated_at: trx.fn.now() }),
      );
    }

    await this.tk.run((trx) =>
      trx('whatsapp.campaigns').where({ id: campaignId }).update({ status: 'done', sent, failed, finished_at: trx.fn.now(), updated_at: trx.fn.now() }),
    );
    this.logger.log(`campaña ${campaignId} terminada: ${sent} enviados, ${failed} fallidos`);
  }

  /** Estado de una campaña (para el panel / polling). */
  async status(campaignId: string) {
    return this.tk.run(async (trx) => {
      const c = await trx('whatsapp.campaigns').where({ id: campaignId }).first();
      if (!c) throw new NotFoundException('Campaña no encontrada');
      return {
        campaign_id: c.id, name: c.name, status: c.status, template: c.template_name,
        total: c.total, sent: c.sent, failed: c.failed, started_at: c.started_at, finished_at: c.finished_at,
      };
    });
  }

  /** Lista de campañas (recientes primero). */
  async list() {
    return this.tk.run((trx) =>
      trx('whatsapp.campaigns').orderBy('created_at', 'desc').limit(50)
        .select('id as campaign_id', 'name', 'status', 'template_name as template', 'total', 'sent', 'failed', 'created_at'),
    );
  }
}
