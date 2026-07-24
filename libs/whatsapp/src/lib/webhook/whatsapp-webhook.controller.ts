import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  Headers,
  HttpCode,
  Inject,
  Logger,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { Public } from '@megadulces/platform-core';
import { WhatsAppIngestService } from './whatsapp-ingest.service';
import { WHATSAPP_PORT } from '../ports/whatsapp.port';
import type { WhatsAppPort } from '../ports/whatsapp.port';

/**
 * Fase F.1 (ADR-006/034) — Webhook público de WhatsApp.
 *
 * URL pública (detrás de nginx): `/api/webhooks/whatsapp`.
 *   - GET  → handshake de verificación de Meta (`hub.mode`/`hub.verify_token`/
 *            `hub.challenge`). Devuelve el challenge en texto plano si el token
 *            coincide con `WHATSAPP_VERIFY_TOKEN`.
 *   - POST → mensajes entrantes. La firma HMAC (`X-Hub-Signature-256`) se valida
 *            en el puerto contra el body CRUDO (capturado en main.ts). Responde
 *            200 de inmediato (encola y procesa async — Meta exige respuesta veloz).
 *   - POST /sim → SOLO con WHATSAPP_PROVIDER=simulator: inyecta un mensaje de
 *                 prueba `{ from, text }` sin firma (para dev/smoke sin Meta).
 *
 * `@Public()`: el JwtAuthGuard global exime estas rutas (Meta no manda Bearer).
 * El tenant se resuelve dentro del ingest (scope CLS sintético), no del JWT.
 */
@ApiExcludeController()
@Controller('webhooks/whatsapp')
export class WhatsAppWebhookController {
  private readonly logger = new Logger(WhatsAppWebhookController.name);

  constructor(
    private readonly ingest: WhatsAppIngestService,
    @Inject(WHATSAPP_PORT) private readonly port: WhatsAppPort,
  ) {}

  @Public()
  @Get()
  verify(
    @Query('hub.mode') mode?: string,
    @Query('hub.verify_token') token?: string,
    @Query('hub.challenge') challenge?: string,
  ): string {
    const ok = this.ingest.verify(mode, token, challenge);
    if (ok == null) {
      this.logger.warn('Handshake de webhook rechazado (token no coincide).');
      throw new ForbiddenException('verify_token inválido');
    }
    return ok;
  }

  @Public()
  @Post()
  @HttpCode(200)
  async inbound(
    @Req() req: any,
    @Body() body: unknown,
    @Headers('x-hub-signature-256') signature?: string,
  ): Promise<{ received: boolean; accepted: number }> {
    try {
      const accepted = await this.ingest.ingest(body, signature, req?.rawBody);
      return { received: true, accepted };
    } catch (e: any) {
      // Firma inválida u otro error de parseo: log + 200 igual para que Meta no
      // reintente en loop una firma que nunca va a validar (salvo que queramos
      // depurar). Devolvemos accepted:0.
      this.logger.error(`Webhook inbound rechazado: ${e?.message}`);
      return { received: true, accepted: 0 };
    }
  }

  @Public()
  @Post('sim')
  @HttpCode(200)
  async simulate(@Body() body: unknown): Promise<{ received: boolean; accepted: number }> {
    if (this.port.provider !== 'simulator') {
      throw new ForbiddenException('Endpoint de simulación deshabilitado (WHATSAPP_PROVIDER != simulator)');
    }
    if (!body || (typeof body === 'object' && !('from' in (body as object)) && !Array.isArray(body))) {
      throw new BadRequestException('Body esperado: { from, text } o [{ from, text }]');
    }
    const accepted = await this.ingest.ingestSimulator(body);
    return { received: true, accepted };
  }
}
