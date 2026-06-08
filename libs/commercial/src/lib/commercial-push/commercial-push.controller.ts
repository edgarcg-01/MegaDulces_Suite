import { Body, Controller, Get, Headers, Post } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { Public, TenantContextService } from '@megadulces/platform-core';
import {
  CommercialPushService,
  PushSubscriptionDto,
} from './commercial-push.service';

@ApiTags('push')
@Controller('push')
export class CommercialPushController {
  constructor(
    private readonly push: CommercialPushService,
    private readonly tenantCtx: TenantContextService,
  ) {}

  /** Clave pública VAPID para que el cliente se suscriba. Público. */
  @Public()
  @Get('public-key')
  @ApiOperation({ summary: 'Clave pública VAPID para Web Push' })
  publicKey() {
    return { publicKey: this.push.publicKey, enabled: this.push.isEnabled() };
  }

  /** Registra la suscripción del navegador del usuario autenticado. */
  @ApiBearerAuth()
  @Post('subscribe')
  @ApiOperation({ summary: 'Registrar suscripción Web Push del usuario' })
  async subscribe(
    @Body() body: { subscription: PushSubscriptionDto },
    @Headers('user-agent') userAgent: string,
  ) {
    const ctx = this.tenantCtx.get();
    if (!ctx?.userId) return { ok: false };
    await this.push.subscribe(ctx.userId, ctx.tenantId ?? null, body?.subscription, userAgent || null);
    return { ok: true };
  }

  /** Da de baja una suscripción (al revocar permiso o cerrar sesión). */
  @ApiBearerAuth()
  @Post('unsubscribe')
  @ApiOperation({ summary: 'Eliminar suscripción Web Push' })
  async unsubscribe(@Body() body: { endpoint: string }) {
    await this.push.unsubscribe(body?.endpoint);
    return { ok: true };
  }

  /** Envía una notificación de prueba al propio usuario (verificación). */
  @ApiBearerAuth()
  @Post('test')
  @ApiOperation({ summary: 'Enviar push de prueba al usuario actual' })
  async test() {
    const ctx = this.tenantCtx.get();
    if (!ctx?.userId) return { sent: 0 };
    return this.push.sendToUser(ctx.userId, {
      title: 'Mega Dulces',
      body: 'Notificaciones activadas ✓',
      url: '/portal/home',
      tag: 'test',
    });
  }
}
