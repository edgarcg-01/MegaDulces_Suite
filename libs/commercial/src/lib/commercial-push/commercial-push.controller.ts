import { Body, Controller, Get, Headers, Post, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import {
  Public,
  TenantContextService,
  RolesGuard,
  RequireAuthGuard,
  RequirePermissions,
  Permission,
} from '@megadulces/platform-core';
import {
  CommercialPushService,
  PushSubscriptionDto,
} from './commercial-push.service';
import { RouteTicketReminderService } from './route-ticket-reminder.service';

@ApiTags('push')
@Controller('push')
export class CommercialPushController {
  constructor(
    private readonly push: CommercialPushService,
    private readonly tenantCtx: TenantContextService,
    private readonly reminders: RouteTicketReminderService,
  ) {}

  /** Clave pública VAPID para que el cliente se suscriba. Público. */
  @Public()
  @Get('public-key')
  @ApiOperation({ summary: 'Clave pública VAPID para Web Push' })
  publicKey() {
    return { publicKey: this.push.publicKey, enabled: this.push.isEnabled() };
  }

  /**
   * Registra la suscripción del navegador del usuario autenticado.
   *
   * `[AUTHZ.5]` — Las tres de abajo son sólo-auth **a propósito**: el `userId`/`tenantId` sale del
   * contexto del JWT y nunca del body, así que un usuario sólo puede suscribir, dar de baja y
   * probar **lo suyo**. Cualquier rol con sesión puede recibir notificaciones; exigir un permiso
   * sería churn sin ganancia. Escrito para que la auditoría de cobertura lo lea como decisión.
   */
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
    // `[AUTHZ-HARD.1]` El `userId` del JWT ahora SÍ se pasa: antes `unsubscribe(endpoint)` borraba
    // la fila de cualquiera por su endpoint (tabla sin RLS) — contradecía el propio comentario de
    // arriba. Se acota a la suscripción del propio usuario.
    const ctx = this.tenantCtx.get();
    await this.push.unsubscribe(body?.endpoint, ctx?.userId ?? null);
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

  /** Dispara manualmente el recordatorio de cierre de ruta (pruebas/operación). */
  @ApiBearerAuth()
  @UseGuards(RequireAuthGuard, RolesGuard)
  @RequirePermissions(Permission.ROUTE_CONTROL_VER)
  @Post('ticket-reminders/run')
  @ApiOperation({ summary: 'Corre el recordatorio de cierre de ruta ahora (push a vendedores pendientes)' })
  runTicketReminders() {
    return this.reminders.run();
  }
}
