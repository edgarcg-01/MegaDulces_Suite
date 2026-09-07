import { Body, Controller, Headers, Ip, Post, Req } from '@nestjs/common';
import { Request } from 'express';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { AuthMtService, LoginDto } from './auth-mt.service';
import { Public } from '@megadulces/platform-core';

@ApiTags('auth-mt')
@Controller('auth-mt')
export class AuthMtController {
  constructor(private readonly authService: AuthMtService) {}

  @Public()
  // `[AUTHZ-HARD.5]` Rate-limit propio del login: 5 intentos/min/IP. El global (200/min) deja
  // ~288k adivinanzas/día por IP sin lockout. Esto acota el fuerza-bruta sin molestar a un humano.
  @Throttle({ short: { limit: 5, ttl: 60_000 } })
  @Post('login')
  @ApiOperation({ summary: 'Login multi-tenant: requiere tenant_slug + username + password' })
  login(
    @Body() body: LoginDto,
    @Ip() ip: string,
    @Headers('user-agent') userAgent: string,
    @Req() req: Request,
  ) {
    // Detrás de Railway/nginx el `req.ip` directo puede ser la IP del proxy.
    // `x-forwarded-for` (configurado por `app.set('trust proxy', ...)`) trae
    // la IP real del cliente — primer valor de la lista. Fallback al `@Ip()`.
    const fwd = (req.headers['x-forwarded-for'] as string | undefined)?.split(',')[0]?.trim();
    const clientIp = fwd || ip || null;
    return this.authService.login(body, {
      ip: clientIp,
      userAgent: userAgent || null,
    });
  }
}
