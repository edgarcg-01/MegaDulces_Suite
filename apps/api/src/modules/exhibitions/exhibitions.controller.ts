import {
  Controller,
  Post,
  Body,
  Param,
  UseGuards,
  UseInterceptors,
  UploadedFile,
  BadRequestException,
} from '@nestjs/common';
import { ExhibitionsService } from './exhibitions.service';
import { RequireAuthGuard } from '../../shared/guards/require-auth.guard';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import {
  ApiTags,
  ApiBearerAuth,
  ApiOperation,
  ApiConsumes,
  ApiBody,
} from '@nestjs/swagger';

@ApiTags('exhibitions')
@ApiBearerAuth()
@UseGuards(RequireAuthGuard)
@Controller('exhibitions')
export class ExhibitionsController {
  constructor(private readonly exhibitionsService: ExhibitionsService) {}

  @Post()
  @ApiOperation({
    summary:
      'Genera nodo jerárquico amarrado a `visit_id` reportando posicion y tipo, puntaje inicial: 0 PTS.',
  })
  create(@Body() body: any) {
    return this.exhibitionsService.create(body);
  }

  @Post(':id/photos')
  @ApiOperation({
    summary:
      'Recibe Buffer estático y lo sube a Cloudinary para actualizar score.',
  })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        file: {
          type: 'string',
          format: 'binary',
        },
      },
    },
  })
  @UseInterceptors(FileInterceptor('file', {
      storage: memoryStorage(),
    }),
  )
  async uploadPhoto(
    @Param('id') id: string,
    @UploadedFile() file: Express.Multer.File,
  ) {
    if (!file)
      throw new BadRequestException(
        'El campo multipart `file` está vacío o dañado.',
      );
    // Le pasamos el Buffer al servicio para que se encargue de Cloudinary
    return await this.exhibitionsService.uploadPhoto(id, file);
  }
}
