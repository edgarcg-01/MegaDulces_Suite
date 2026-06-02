import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import {
  CommercialCustomersService,
  CreateCustomerDto,
  UpdateCustomerDto,
} from './commercial-customers.service';
import { RolesGuard } from '../../shared/guards/roles.guard';
import { RequirePermissions } from '../../shared/decorators/permissions.decorator';
import { Permission } from '../../shared/constants/permissions';

/**
 * CRUD de clientes B2B. Todos los endpoints respetan tenant context via
 * AsyncLocalStorage (poblado por TenantContextInterceptor en cada request).
 * Reads gateados por COMMERCIAL_CUSTOMERS_VER; mutaciones por COMMERCIAL_CUSTOMERS_GESTIONAR.
 * Ownership scoping para customer_b2b vive en el service (list y findById).
 */
@ApiTags('commercial-customers')
@ApiBearerAuth()
@UseGuards(RolesGuard)
@Controller('commercial/customers')
export class CommercialCustomersController {
  constructor(private readonly service: CommercialCustomersService) {}

  @Post()
  @RequirePermissions(Permission.COMMERCIAL_CUSTOMERS_GESTIONAR)
  @ApiOperation({ summary: 'Crear customer B2B' })
  create(@Body() body: CreateCustomerDto) {
    return this.service.create(body);
  }

  @Post('from-store')
  @RequirePermissions(Permission.COMMERCIAL_CUSTOMERS_GESTIONAR)
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
  @RequirePermissions(Permission.COMMERCIAL_CUSTOMERS_VER)
  @ApiOperation({
    summary:
      'Listar customers (paginado, búsqueda por name/code/rfc/email). customer_b2b solo ve su propio customer (scoping forzado en service).',
  })
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
  @RequirePermissions(Permission.COMMERCIAL_CUSTOMERS_VER)
  @ApiOperation({
    summary:
      'Portal B2B: devuelve el customer linkeado al JWT (users.customer_id). Null si el user no es customer_b2b.',
  })
  findMine() {
    return this.service.findMine();
  }

  @Get(':id')
  @RequirePermissions(Permission.COMMERCIAL_CUSTOMERS_VER)
  @ApiOperation({
    summary:
      'Obtener customer por id. customer_b2b solo puede leer SU propio customer (ownership check en service).',
  })
  findOne(@Param('id') id: string) {
    return this.service.findById(id);
  }

  @Patch(':id')
  @RequirePermissions(Permission.COMMERCIAL_CUSTOMERS_GESTIONAR)
  @ApiOperation({ summary: 'Actualizar customer (parcial)' })
  update(@Param('id') id: string, @Body() body: UpdateCustomerDto) {
    return this.service.update(id, body);
  }

  @Delete(':id')
  @RequirePermissions(Permission.COMMERCIAL_CUSTOMERS_GESTIONAR)
  @ApiOperation({ summary: 'Soft-delete customer (deleted_at + active=false)' })
  remove(@Param('id') id: string) {
    return this.service.softDelete(id);
  }

  @Post(':id/portal-access')
  @RequirePermissions(Permission.COMMERCIAL_CUSTOMERS_GESTIONAR)
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
