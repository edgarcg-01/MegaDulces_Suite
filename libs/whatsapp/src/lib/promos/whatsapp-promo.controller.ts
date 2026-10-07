import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  Permission,
  RequireAuthGuard,
  RequirePermissions,
  RolesGuard,
} from '@megadulces/platform-core';
import { WhatsAppPromoService } from './whatsapp-promo.service';

/**
 * Fase F.7 — Envío de promociones con imagen (un destinatario; base para F.8).
 * `image` = imagen libre (solo dentro de ventana 24h). `template` = plantilla
 * aprobada (para iniciar fuera de ventana). Ambos requieren WHATSAPP_BOT_GESTIONAR.
 */
@ApiTags('whatsapp-promos')
@ApiBearerAuth()
@UseGuards(RequireAuthGuard, RolesGuard)
@Controller('whatsapp/promos')
export class WhatsAppPromoController {
  constructor(private readonly promos: WhatsAppPromoService) {}

  @Post('image')
  @RequirePermissions(Permission.WHATSAPP_BOT_GESTIONAR)
  @ApiOperation({ summary: 'Envía una imagen con caption (solo dentro de la ventana 24h del cliente).' })
  sendImage(@Body() body: { phone: string; image_url: string; caption?: string }) {
    return this.promos.sendImageInWindow(body.phone, body.image_url, body.caption);
  }

  @Post('template')
  @RequirePermissions(Permission.WHATSAPP_BOT_GESTIONAR)
  @ApiOperation({ summary: 'Envía una plantilla de marketing aprobada (con imagen opcional; inicia fuera de ventana 24h).' })
  sendTemplate(
    @Body() body: { phone: string; template_name: string; language?: string; image_url?: string; body_params?: string[] },
  ) {
    return this.promos.sendTemplate(body.phone, body.template_name, body.language || 'es_MX', body.image_url, body.body_params);
  }
}
