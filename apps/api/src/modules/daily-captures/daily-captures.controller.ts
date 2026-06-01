import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Query,
  UploadedFiles,
  UseGuards,
  UseInterceptors,
  UsePipes,
  ValidationPipe,
} from '@nestjs/common';
import { AnyFilesInterceptor } from '@nestjs/platform-express';
import { DailyCapturesService } from './daily-captures.service';
import { CreateDailyCaptureDto } from './dto/create-daily-capture.dto';
import { RequireAuthGuard } from '../../shared/guards/require-auth.guard';
import { RolesGuard } from '../../shared/guards/roles.guard';
import { RequirePermissions } from '../../shared/decorators/permissions.decorator';
import { Permission } from '../../shared/constants/permissions';
import { ReqUser } from '../../shared/decorators/req-user.decorator';
import { SkipTenantTx } from '../../shared/decorators/skip-tenant-tx.decorator';
import {
  ApiTags,
  ApiBearerAuth,
  ApiQuery,
  ApiOperation,
  ApiConsumes,
} from '@nestjs/swagger';

@ApiTags('daily-captures')
@ApiBearerAuth()
@UseGuards(RequireAuthGuard, RolesGuard)
@Controller('daily-captures')
export class DailyCapturesController {
  constructor(private readonly dailyCapturesService: DailyCapturesService) {}

  /**
   * Registrar visita. Acepta DOS formatos en el body:
   *
   * 1. **multipart/form-data** (preferido, ~25% menos bytes en wire):
   *    - field `payload` con el JSON del DTO (sin `fotoBase64` en exhibiciones)
   *    - cada foto como file part `photo_<i>` donde `i` matchea
   *      `exhibiciones[i]._photoField` del payload.
   *
   * 2. **application/json** (legacy / offline cache):
   *    - body completo del DTO con `exhibiciones[].fotoBase64`.
   *    - Sigue funcionando para que visitas guardadas en IndexedDB con el
   *      formato viejo no se pierdan al desplegar.
   *
   * Multer límites: 10 MB por foto, máx 20 archivos por request.
   */
  @Post()
  @RequirePermissions(Permission.VISITAS_REGISTRAR)
  // SkipTenantTx (audit #3): Cloudinary upload puede tardar 30s+. Con el
  // auto-trx del interceptor, la conexión a DB queda idle todo ese tiempo →
  // Postgres mata la trx o agota el pool. Acá el service maneja su propia trx
  // corta SOLO alrededor del INSERT.
  @SkipTenantTx()
  @UseInterceptors(
    AnyFilesInterceptor({
      limits: { fileSize: 10 * 1024 * 1024, files: 20 },
    }),
  )
  @ApiConsumes('multipart/form-data', 'application/json')
  @ApiOperation({ summary: 'Registrar una auditoría completada en un PDV' })
  async create(
    @Body() body: any,
    @UploadedFiles() files: Express.Multer.File[] = [],
    @ReqUser() user: any,
  ) {
    let dto: CreateDailyCaptureDto;

    // Detectar multipart por presencia del campo `payload` (string JSON).
    // El multer interceptor expone los demás fields del FormData en `body`.
    if (typeof body?.payload === 'string') {
      try {
        dto = JSON.parse(body.payload);
      } catch {
        throw new BadRequestException(
          'El field `payload` no es JSON válido.',
        );
      }

      // Asociar cada file a su exhibición por `_photoField`.
      const fileByField = new Map<string, Express.Multer.File>(
        files.map((f) => [f.fieldname, f]),
      );
      for (const ex of dto.exhibiciones ?? []) {
        const field = (ex as any)._photoField as string | undefined;
        if (field) {
          const file = fileByField.get(field);
          if (file) {
            // El service detecta `_file` y usa cloudinary.uploadImage(buffer).
            (ex as any)._file = file;
          }
          delete (ex as any)._photoField;
        }
      }
    } else {
      // Legacy JSON path. ValidationPipe arriba ya hizo el cast, pero como
      // ahora el handler recibe `body: any` (para soportar multipart) lo
      // validamos a mano de forma básica.
      dto = body as CreateDailyCaptureDto;
    }

    // Validación mínima común a ambos paths.
    if (!dto?.folio || !dto?.exhibiciones?.length || !dto?.stats) {
      throw new BadRequestException(
        'Payload incompleto: se requieren folio, exhibiciones y stats.',
      );
    }

    return this.dailyCapturesService.create(
      dto,
      user.sub,
      user.username,
      user.zona,
    );
  }

  @Get()
  @RequirePermissions(Permission.VISITAS_VER)
  @UsePipes(new ValidationPipe({ transform: true, whitelist: false }))
  @ApiOperation({ summary: 'Consultar Cierres de Auditoría/Visitas' })
  @ApiQuery({ name: 'fecha', required: false })
  @ApiQuery({ name: 'zona', required: false })
  @ApiQuery({ name: 'ejecutivo', required: false })
  findAll(
    @Query('fecha') fecha?: string,
    @Query('zona') zona?: string,
    @Query('ejecutivo') ejecutivo?: string,
    @ReqUser() user?: any,
  ) {
    // /daily-captures es el workspace personal de cada capturista (página /captures).
    // SIEMPRE se filtra por el usuario autenticado, sin importar el rol — incluso
    // superadmin solo ve sus propias visitas en esta vista. Las vistas globales
    // (admin/reports) consumen otros endpoints en /reports.
    return this.dailyCapturesService.findAll(
      fecha,
      zona,
      ejecutivo,
      user.sub,
    );
  }

  @Get('frequent-products')
  @RequirePermissions(Permission.VISITAS_REGISTRAR)
  @ApiOperation({
    summary: 'Top productos marcados por el usuario (últ. 30d). Para "Frecuentes" en step 5 del wizard.',
  })
  @ApiQuery({ name: 'days', required: false, description: 'Default 30, max 90.' })
  @ApiQuery({ name: 'limit', required: false, description: 'Default 20, max 50.' })
  @ApiQuery({ name: 'storeId', required: false, description: 'Scope a una tienda específica.' })
  frequentProducts(
    @ReqUser() user: any,
    @Query('days') days?: string,
    @Query('limit') limit?: string,
    @Query('storeId') storeId?: string,
  ) {
    return this.dailyCapturesService.findFrequentProducts(user.sub, {
      days: days ? Math.min(Math.max(parseInt(days, 10) || 30, 1), 90) : 30,
      limit: limit ? Math.min(Math.max(parseInt(limit, 10) || 20, 1), 50) : 20,
      storeId: storeId || undefined,
    });
  }

  @Get(':id')
  @RequirePermissions(Permission.VISITAS_VER)
  @ApiOperation({ summary: 'Obtener visita por Folio o ID' })
  findOne(@Param('id') id: string) {
    return this.dailyCapturesService.findOne(id);
  }

  @Delete(':id')
  @RequirePermissions(Permission.REPORTES_GESTIONAR)
  @ApiOperation({
    summary: 'Eliminar una visita por ID o folio. Solo dueño o superadmin.',
  })
  async remove(@Param('id') id: string, @ReqUser() user: any) {
    return this.dailyCapturesService.remove(id, {
      sub: user.sub,
      username: user.username,
      role_name: user.role_name,
    });
  }
}
