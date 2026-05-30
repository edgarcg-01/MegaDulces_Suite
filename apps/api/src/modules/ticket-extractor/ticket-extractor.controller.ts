import {
  Controller,
  Post,
  Req,
  UnauthorizedException,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { FileInterceptor } from '@nestjs/platform-express';
import { Throttle } from '@nestjs/throttler';
import { TicketExtractorService } from './ticket-extractor.service';

@ApiTags('ticket-extractor')
@Controller('ai/ticket')
export class TicketExtractorController {
  constructor(private readonly service: TicketExtractorService) {}

  /**
   * Fase V — Foto de ticket → líneas de producto matcheadas contra catálogo.
   * Subido como multipart (campo `file`). Cloudinary, Claude vision y el
   * matcher corren en serie en este endpoint.
   *
   * Throttle agresivo (`long`: 10/min) — vision en Anthropic cuesta ~$0.004
   * por imagen, no queremos que un cliente bucle.
   */
  @Post('extract')
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
