import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  Permission,
  RequireAuthGuard,
  RequirePermissions,
  RolesGuard,
} from '@megadulces/platform-core';
import { CreateCampaignDto, WhatsAppCampaignService } from './whatsapp-campaign.service';
import { WhatsAppOptinService } from './whatsapp-optin.service';

/**
 * F.8 — Broadcast de promos + opt-in. VER = ver campañas/opt-in; GESTIONAR =
 * crear/enviar campañas y marcar opt-in/out manual. Las promos masivas exigen
 * plantilla aprobada en Meta + opt-in de los destinatarios (política Meta).
 */
@ApiTags('whatsapp-broadcast')
@ApiBearerAuth()
@UseGuards(RequireAuthGuard, RolesGuard)
@Controller('whatsapp')
export class WhatsAppBroadcastController {
  constructor(
    private readonly campaigns: WhatsAppCampaignService,
    private readonly optin: WhatsAppOptinService,
  ) {}

  // ── Campañas ──
  @Post('campaigns')
  @RequirePermissions(Permission.WHATSAPP_BOT_GESTIONAR)
  @ApiOperation({ summary: 'Crea una campaña (plantilla + imagen) y congela destinatarios opted-in.' })
  create(@Body() dto: CreateCampaignDto) {
    return this.campaigns.create(dto);
  }

  @Post('campaigns/:id/send')
  @RequirePermissions(Permission.WHATSAPP_BOT_GESTIONAR)
  @ApiOperation({ summary: 'Dispara el envío del broadcast (fan-out rate-limited en segundo plano).' })
  send(@Param('id') id: string) {
    return this.campaigns.send(id);
  }

  @Get('campaigns')
  @RequirePermissions(Permission.WHATSAPP_BOT_VER)
  @ApiOperation({ summary: 'Lista de campañas (recientes primero).' })
  list() {
    return this.campaigns.list();
  }

  @Get('campaigns/:id')
  @RequirePermissions(Permission.WHATSAPP_BOT_VER)
  @ApiOperation({ summary: 'Estado de una campaña (enviados/fallidos/total).' })
  status(@Param('id') id: string) {
    return this.campaigns.status(id);
  }

  // ── Opt-in ──
  @Get('optin/stats')
  @RequirePermissions(Permission.WHATSAPP_BOT_VER)
  @ApiOperation({ summary: 'Resumen de consentimiento de marketing (opted_in / opted_out).' })
  optinStats() {
    return this.optin.stats();
  }

  @Post('optin')
  @RequirePermissions(Permission.WHATSAPP_BOT_GESTIONAR)
  @ApiOperation({ summary: 'Marca opt-in/out manual de un teléfono (source=manual).' })
  async setOptin(@Body() body: { phone: string; opted_in: boolean }) {
    if (body?.opted_in === false) await this.optin.optOut(body.phone);
    else await this.optin.optIn(body.phone, 'manual');
    return { phone: body.phone, status: body?.opted_in === false ? 'opted_out' : 'opted_in' };
  }
}
