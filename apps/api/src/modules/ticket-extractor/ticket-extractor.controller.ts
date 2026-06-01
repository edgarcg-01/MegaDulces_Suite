import {
  Controller,
  Post,
  Req,
  UnauthorizedException,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { FileInterceptor } from '@nestjs/platform-express';
import { Throttle } from '@nestjs/throttler';
import { TicketExtractorService } from './ticket-extractor.service';
import { RequireAuthGuard } from '../../shared/guards/require-auth.guard';
import { RolesGuard } from '../../shared/guards/roles.guard';
import { RequirePermissions } from '../../shared/decorators/permissions.decorator';
import { Permission } from '../../shared/constants/permissions';

@ApiTags('ticket-extractor')
@ApiBearerAuth()
@UseGuards(RequireAuthGuard, RolesGuard)
@Controller('ai/ticket')
export class TicketExtractorController {
  constructor(private readonly service: TicketExtractorService) {}

  /**
   * Fase V — Foto de ticket → líneas de producto matcheadas contra catálogo.
   * Subido como multipart (campo `file`). Cloudinary, Claude vision y el
   * matcher corren en serie en este endpoint.
   *
   * Gate doble:
   *  - `CAPTURE_TICKET_USE` permission: solo vendedor (y admins) la tienen.
   *    Antes de este gate, cualquier usuario logueado (incluido customer_b2b
   *    y tele_operator) podía quemar créditos de Claude vision.
   *  - Throttle (`long`: 10/min) por si un caller compromise abusa del cap.
   *    Vision en Anthropic cuesta ~$0.004 por imagen.
   */
  @Post('extract')
  @RequirePermissions(Permission.CAPTURE_TICKET_USE)
  @Throttle({ long: { ttl: 60_000, limit: 10 } })
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: 10 * 1024 * 1024 }, // 10MB hard limit
    }),
  )
  @ApiOperation({
    summary:
      'Sube foto de ticket. Devuelve la URL en Cloudinary + items matcheados al catálogo.',
  })
  async extract(@Req() req: any, @UploadedFile() file: Express.Multer.File) {
    const user = req.user;
    if (!user) throw new UnauthorizedException('JWT inválido');
    return this.service.extractAndMatch(file, user.tenant_id, user.sub || user.id);
  }
}
