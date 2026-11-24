import { Body, Controller, Get, HttpCode, Ip, Param, Post, Req } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Public } from '@megadulces/platform-core';
import type { HrFirmaPublicaDto, HrFirmaPublicaFirmarBody, HrFirmaPublicaResultadoDto } from '@megadulces/contracts';
import { HrAttendanceFirmaDigitalService } from './attendance-firma-digital.service';

/**
 * Fase RH · `[RH.15.11]` — La página PÚBLICA donde la persona firma su semana desde su celular. Sin sesión: la autoriza
 * SÓLO el token del QR (144 bits al azar, un uso, 72 h). Decisión de RH: la firma es la autorización, sin número de reloj.
 * ⚠️ Por eso el token es la única llave: no se adivina, pero quien tenga la liga ve esa semana y puede firmarla.
 * Límite de peticiones por IP, holgado A PROPÓSITO: un departamento entero firma junto desde el Wi-Fi de la tienda (una
 * sola IP pública). La pantalla (`/mi-semana/:token`) está en `RUTAS_PUBLICAS`: el `authInterceptor` no le pega sesión.
 */
@ApiTags('hr-attendance-public')
@Controller('hr/attendance/firma')
export class HrAttendanceFirmaPublicaController {
  constructor(private readonly firma: HrAttendanceFirmaDigitalService) {}

  @Public()
  @Throttle({ medium: { limit: 30, ttl: 10_000 }, long: { limit: 300, ttl: 600_000 } })
  @Get(':token')
  @ApiOperation({ summary: 'Firma de la semana — su semana tal como quedó cerrada.' })
  publica(@Param('token') token: string): Promise<HrFirmaPublicaDto> {
    return this.firma.publica(token);
  }

  @Public()
  @Throttle({ medium: { limit: 10, ttl: 10_000 }, long: { limit: 100, ttl: 600_000 } })
  @Post(':token')
  @HttpCode(200)
  @ApiOperation({ summary: 'Firma de la semana — guarda el trazo y gasta la liga.' })
  firmar(
    @Param('token') token: string,
    @Body() b: HrFirmaPublicaFirmarBody,
    @Ip() ip: string,
    @Req() req: { headers: Record<string, string | string[] | undefined> },
  ): Promise<HrFirmaPublicaResultadoDto> {
    const ua = req.headers['user-agent'];
    return this.firma.firmar(token, b, { ip, userAgent: Array.isArray(ua) ? ua[0] : ua });
  }
}
