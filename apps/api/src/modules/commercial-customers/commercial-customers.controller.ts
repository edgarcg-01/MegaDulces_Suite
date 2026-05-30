import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import {
  CommercialCustomersService,
  CreateCustomerDto,
  UpdateCustomerDto,
} from './commercial-customers.service';

/**
 * CRUD de clientes B2B. Todos los endpoints respetan tenant context via
 * AsyncLocalStorage (poblado por TenantContextInterceptor en cada request).
 *
 * Guards de permisos: pendientes hasta que el cutover Multi-tenant complete
 * el wiring de JwtAuthGuard + PermissionsGuard para la nueva DB. Por ahora
 * la app no expone esto en prod (toggle ENABLE_MULTITENANT).
 */
@ApiTags('commercial-customers')
@Controller('commercial/customers')
export class CommercialCustomersController {
  constructor(private readonly service: CommercialCustomersService) {}

  @Post()
  @ApiOperation({ summary: 'Crear customer B2B' })
  create(@Body() body: CreateCustomerDto) {
    return this.service.create(body);
  }

  @Post('from-store')
  @ApiOperation({
    summary: 'J.6.2: promover una tienda de Trade Marketing a cliente comercial (idempotente)',
  })
  createFromStore(
    @Body() body: {
      store_id: string;
      code?: string;
      name?: string;
      default_price_list_id?: string;
      credit_limit?: number;
    },
  ) {
    return this.service.createFromStore(body);
  }

  @Get()
  @ApiOperation({ summary: 'Listar customers (paginado, búsqueda por name/code/rfc/email)' })
  list(
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @Query('search') search?: string,
    @Query('active') active?: string,
  ) {
    return this.service.list({
      page: page ? Number(page) : undefined,
      pageSize: pageSize ? Number(pageSize) : undefined,
      search,
      active: active === undefined ? undefined : active === 'true',
    });
  }

  @Get('me')
  @ApiOperation({
    summary:
      'Portal B2B: devuelve el customer linkeado al JWT (users.customer_id). Null si el user no es customer_b2b.',
  })
  findMine() {
    return this.service.findMine();
  }

  @Get(':id')
  @ApiOperation({ summary: 'Obtener customer por id' })
  findOne(@Param('id') id: string) {
    return this.service.findById(id);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Actualizar customer (parcial)' })
  update(@Param('id') id: string, @Body() body: UpdateCustomerDto) {
    return this.service.update(id, body);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Soft-delete customer (deleted_at + active=false)' })
  remove(@Param('id') id: string) {
    return this.service.softDelete(id);
  }

  @Post(':id/portal-access')
  @ApiOperation({
    summary:
      'J.6.3: crea user Portal B2B vinculado al customer. Devuelve password temporal una sola vez.',
  })
  createPortalAccess(
    @Param('id') customerId: string,
    @Body() body: { username?: string; password?: string },
  ) {
    return this.service.createPortalAccess(customerId, body || {});
  }
}
