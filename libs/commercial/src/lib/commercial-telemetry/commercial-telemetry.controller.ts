import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Ip,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Request } from 'express';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import {
  Public,
  RolesGuard,
  RequirePermissions,
  Permission,
  ReqUser,
  TenantContextService,
} from '@megadulces/platform-core';
import { VENTANA_ACCESOS_DIAS, type MisAccesos } from '@megadulces/contracts';
import {
  CommercialTelemetryService,
  RawTelemetryEvent,
} from './commercial-telemetry.service';

interface IngestBody {
  events?: RawTelemetryEvent[];
  // Atribución opcional embebida por el cliente (forward-compat): el beacon
  // de sendBeacon NO puede mandar header Authorization, así que un cliente
  // futuro puede meter estos campos en el payload para atribuir tenant/user.
  tenant_id?: string;
  user_id?: string;
}

@ApiTags('telemetry')
@Controller('telemetry')
export class CommercialTelemetryController {
  constructor(
    private readonly service: CommercialTelemetryService,
    private readonly tenantCtx: TenantContextService,
  ) {}

  /**
   * Ingesta del portal B2B. PÚBLICO a propósito (review CEO): el beacon llega
   * sin sesión desde la página de login o al cerrar el tab tras logout.
   * Responde 202 siempre — la telemetría nunca debe romper al cliente.
   */
  @Public()
  @Post('portal')
  @HttpCode(202)
  @ApiOperation({ summary: 'Ingesta de telemetría del Portal B2B (Web Vitals, errores, funnel)' })
  async ingestPortal(
    @Body() body: IngestBody,
    @Ip() ip: string,
    @Headers('user-agent') userAgent: string,
    @Headers('authorization') authorization: string,
    @Req() req: Request,
  ): Promise<{ inserted: number }> {
    const fwd = (req.headers['x-forwarded-for'] as string | undefined)?.split(',')[0]?.trim();
    const clientIp = fwd || ip || null;

    // Atribución best-effort: 1) header Authorization (si algún día llega por
    // fetch en vez de beacon), 2) campos del payload. Decode SIN verificar
    // firma — es solo para atribuir, no para autorizar.
    const fromHeader = decodeJwtClaims(authorization);
    const tenantId = fromHeader.tenantId ?? body?.tenant_id ?? null;
    const userId = fromHeader.userId ?? body?.user_id ?? null;

    return this.service.ingestPortal(body?.events ?? [], {
      ip: clientIp,
      userAgent: userAgent || null,
      tenantId,
      userId,
    });
  }

  /**
   * `[SN.12]` Ingesta de la SUITE interna (`apps/view`). Hermano de `portal`, con dos diferencias
   * que importan:
   *
   *  1. **No es `@Public()`.** Adentro siempre hay sesión, así que la atribución no es
   *     "best-effort decodificando un JWT sin verificar": el `user_id` y el `tenant_id` salen del
   *     request ya autenticado. Un registro de uso que no sabe de quién es no sirve para
   *     personalizar, que es justo para lo que se pidió.
   *  2. **Sin `@RequirePermissions`.** Cada quien registra lo suyo, como `me/work` o `me/context`.
   *
   * Responde 202 siempre y traga el error: la telemetría jamás debe romper una pantalla.
   */
  @Post('suite')
  @HttpCode(202)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Ingesta de uso de la suite interna (qué abre cada persona)' })
  async ingestSuite(
    @Body() body: IngestBody,
    @Ip() ip: string,
    @Headers('user-agent') userAgent: string,
    @ReqUser() user: { sub?: string },
    @Req() req: Request,
  ): Promise<{ inserted: number }> {
    const fwd = (req.headers['x-forwarded-for'] as string | undefined)?.split(',')[0]?.trim();
    return this.service.ingestPortal(body?.events ?? [], {
      ip: fwd || ip || null,
      userAgent: userAgent || null,
      // `get()` y no `requireTenantId()`: si falta el contexto la telemetría se atribuye a nadie,
      // pero NO revienta la pantalla que la manda.
      tenantId: this.tenantCtx.get()?.tenantId ?? null,
      userId: user?.sub ?? null,
    });
  }

  /**
   * `[SN.40]` **Lo que ESTA persona abre.** El primer lector del registro de clics, que llevaba
   * desde el 2026-09-11 escribiendo sin que nadie lo consumiera (medido: 3,677 aperturas de 84
   * personas, cero lectores).
   *
   * Self-scoped y **sin `@RequirePermissions`**, igual que `me/work` y `me/context`: el `user_id`
   * sale del token, nunca de un parámetro. Preguntar por los clics de otra persona no es que esté
   * prohibido — es que no hay cómo pedirlo.
   *
   * ⚠️ Lo que devuelve NO es sólo tuyo: cuando tu historia no alcanza, completa con tu puesto y
   * tu área, y cada elemento trae `origen` diciendo de cuál de los tres salió. La pantalla tiene
   * que mostrarlo; un atajo prestado que se presenta como propio es el «laberinto» del que
   * advierte la crítica a la App Library.
   *
   * ⛔ **Nunca rompe la landing.** Ante cualquier falla devuelve la forma vacía con `propias: 0`,
   * que el front ya sabe leer como arranque en frío: la fila no se dibuja y el resto de la
   * pantalla no se entera. Es el mismo contrato que la ingesta de arriba.
   */
  @Get('suite/mios')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Las puertas que esta persona abre (con relleno por puesto y área)' })
  async misAccesos(@ReqUser() user: { sub?: string }): Promise<MisAccesos> {
    const vacio: MisAccesos = {
      medido_at: new Date().toISOString(),
      ventana_dias: VENTANA_ACCESOS_DIAS,
      propias: 0,
      accesos: [],
    };
    const tenantId = this.tenantCtx.get()?.tenantId ?? null;
    if (!user?.sub || !tenantId) return vacio;
    try {
      return await this.service.misAccesos(user.sub, tenantId);
    } catch {
      // Un atajo que no se pudo calcular es una fila que no se dibuja, jamás una landing en 500.
      return vacio;
    }
  }

  /**
   * Resumen agregado para el dashboard: p75/p95/p99 de cada Web Vital, tasa de
   * error y funnel. Analítica interna del Portal → COMMERCIAL_ANALYTICS_VER (antes
   * pedía REPORTES_VER_GLOBAL, que concede god-mode manage:all — sobre-privilegio).
   */
  @ApiBearerAuth()
  @UseGuards(RolesGuard)
  @RequirePermissions(Permission.COMMERCIAL_ANALYTICS_VER)
  @Get('portal/summary')
  @ApiOperation({ summary: 'Resumen de métricas del Portal B2B (p75/p99, error rate, funnel)' })
  async summary(
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    // `[AUTHZ-HARD.1]` El tenant sale del JWT autenticado, NUNCA del `?tenant_id`. La tabla
    // `portal_telemetry_events` no tiene RLS: antes, omitir el query agregaba TODOS los tenants y
    // pasar uno ajeno lo apuntaba. Con COMMERCIAL_ANALYTICS_VER en el tenant A sólo se ve el A.
    const tenantId = this.tenantCtx.get()?.tenantId ?? null;
    const now = Date.now();
    const toDate = to ? new Date(to) : new Date(now);
    const fromDate = from ? new Date(from) : new Date(now - 24 * 60 * 60 * 1000);
    return this.service.summary({
      from: isNaN(fromDate.getTime()) ? new Date(now - 24 * 60 * 60 * 1000) : fromDate,
      to: isNaN(toDate.getTime()) ? new Date(now) : toDate,
      tenantId,
    });
  }
}

/** Decode best-effort de claims del JWT (sin verificar firma). Solo atribución. */
function decodeJwtClaims(authorization?: string): { tenantId: string | null; userId: string | null } {
  try {
    if (!authorization) return { tenantId: null, userId: null };
    const token = authorization.replace(/^Bearer\s+/i, '').trim();
    const part = token.split('.')[1];
    if (!part) return { tenantId: null, userId: null };
    const json = Buffer.from(part, 'base64').toString('utf8');
    const claims = JSON.parse(json);
    return {
      tenantId: typeof claims?.tenant_id === 'string' ? claims.tenant_id : null,
      userId: typeof claims?.sub === 'string' ? claims.sub : null,
    };
  } catch {
    return { tenantId: null, userId: null };
  }
}
