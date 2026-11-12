import { Controller, Get, Param, Req, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { RolesGuard, RequirePermissions, Permission } from '@megadulces/platform-core';

import { QuoteTrackingService } from './quote-tracking.service';
import type { SeguimientoCotizacion } from './quote-tracking.reglas';
import type { QuienCotiza } from './quote-scope';

type ConQuien = { user?: QuienCotiza };

/**
 * `[GP.9.1]` Seguimiento de la cotización después de «Pedido en Kepler».
 *
 * Controlador propio (mismo patrón que `QuoteKeplerController`): no cambia la firma inyectada de
 * los dos que ya están en producción. `GET :id/tracking` tiene dos segmentos y no choca con `GET :id`.
 * Lee con el permiso de ver cotizaciones; el servicio aplica de quién es (COT.21).
 */
@ApiTags('commercial-quotes')
@ApiBearerAuth()
@UseGuards(RolesGuard)
@Controller('commercial/quotes')
export class QuoteTrackingController {
  constructor(private readonly service: QuoteTrackingService) {}

  @Get(':id/tracking')
  @RequirePermissions(Permission.COMMERCIAL_QUOTES_VER)
  @ApiOperation({
    summary:
      '[GP.9.1] Pasos del pedido de la cotización en Kepler: pedido, autorizado, surtido, checado, embarque (U-D-41) y factura (U-D-8), '
      + 'con quién (clave de Kepler o usuario de la Suite si lo marcó el piso) y los hallazgos abiertos de la revisión TM. Sólo lectura.',
  })
  seguimiento(@Param('id') id: string, @Req() req: ConQuien): Promise<SeguimientoCotizacion> {
    return this.service.seguimiento(id, req?.user);
  }
}
