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
} from '@megadulces/platform-core';
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
  constructor(private readonly service: CommercialTelemetryService) {}

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
    @Query('tenant_id') tenantId?: string,
  ) {
    const now = Date.now();
    const toDate = to ? new Date(to) : new Date(now);
    const fromDate = from ? new Date(from) : new Date(now - 24 * 60 * 60 * 1000);
    return this.service.summary({
      from: isNaN(fromDate.getTime()) ? new Date(now - 24 * 60 * 60 * 1000) : fromDate,
      to: isNaN(toDate.getTime()) ? new Date(now) : toDate,
      tenantId: tenantId || null,
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
