import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiQuery, ApiBearerAuth } from '@nestjs/swagger';
import { RolesGuard, RequirePermissions, Permission } from '@megadulces/platform-core';
import {
  CommercialQuotesService,
  ListQuotesQuery,
  QuoteOrigin,
} from './commercial-quotes.service';

/**
 * `[E.12]` — Cotizaciones de mayoreo.
 *
 * Autorización: leer exige `COMMERCIAL_QUOTES_VER`; crear/cerrar exige
 * `COMMERCIAL_QUOTES_GESTIONAR`. Son un par PROPIO, no derivado de
 * `COMMERCIAL_TELEVENTA_*`: trabajar la cola de llamadas y tener autorizado mover precio son
 * dos permisos distintos, y el `RolesGuard` es exact-key (no hay herencia entre hermanos).
 */
@ApiTags('commercial-quotes')
@ApiBearerAuth()
@UseGuards(RolesGuard)
@Controller('commercial/quotes')
export class CommercialQuotesController {
  constructor(private readonly service: CommercialQuotesService) {}

  @Get()
  @RequirePermissions(Permission.COMMERCIAL_QUOTES_VER)
  @ApiOperation({
    summary:
      'Mesa de cotizaciones: folio, destinatario, vigencia, total y cuántos renglones quedaron sin casar con el catálogo.',
  })
  @ApiQuery({ name: 'status', required: false, description: 'Uno o varios separados por coma.' })
  @ApiQuery({ name: 'origin', required: false })
  @ApiQuery({ name: 'customer_id', required: false })
  @ApiQuery({ name: 'mine', required: false, type: Boolean })
  @ApiQuery({ name: 'search', required: false })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiQuery({ name: 'offset', required: false, type: Number })
  list(@Query() q: Record<string, string>) {
    const query: ListQuotesQuery = {
      status: q['status'],
      origin: q['origin'],
      customer_id: q['customer_id'],
      mine: q['mine'] === 'true' || q['mine'] === '1',
      search: q['search'],
      limit: q['limit'] ? Number(q['limit']) : undefined,
      offset: q['offset'] ? Number(q['offset']) : undefined,
    };
    return this.service.list(query);
  }

  @Get('summary')
  @RequirePermissions(Permission.COMMERCIAL_QUOTES_VER)
  @ApiOperation({
    summary:
      'Conteos por estado + monto abierto + las que vencen pronto y las que ya vencieron sin cerrarse.',
  })
  @ApiQuery({ name: 'mine', required: false, type: Boolean })
  summary(@Query('mine') mine?: string) {
    return this.service.summary(mine === 'true' || mine === '1');
  }

  @Get(':id')
  @RequirePermissions(Permission.COMMERCIAL_QUOTES_VER)
  @ApiOperation({ summary: 'Cabecera + renglones de una cotización (descuento derivado por renglón).' })
  getOne(@Param('id') id: string) {
    return this.service.getOne(id);
  }

  @Post()
  @RequirePermissions(Permission.COMMERCIAL_QUOTES_GESTIONAR)
  @ApiOperation({
    summary:
      'Crea la cotización en borrador con su folio COT-YYYY-NNNNN. Los renglones se cargan después.',
  })
  create(
    @Body()
    body: {
      customer_id?: string;
      contact_name?: string;
      contact_phone?: string;
      contact_email?: string;
      origin?: QuoteOrigin;
      warehouse_id: string;
      price_list_id?: string;
      valid_until?: string;
      customer_request?: string;
      notes?: string;
      internal_notes?: string;
    },
  ) {
    return this.service.create(body);
  }

  @Post(':id/cancel')
  @RequirePermissions(Permission.COMMERCIAL_QUOTES_GESTIONAR)
  @ApiOperation({
    summary:
      'Cancela la cotización (baja nuestra). NO es lo mismo que rechazada, que es el no del cliente.',
  })
  cancel(@Param('id') id: string, @Body() body: { reason: string }) {
    return this.service.cancel(id, body?.reason);
  }
}
