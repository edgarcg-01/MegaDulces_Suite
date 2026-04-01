import { Controller, Post, Body, Param, UseGuards, UseInterceptors, UploadedFile, BadRequestException } from '@nestjs/common';
import { ExhibitionsService } from './exhibitions.service';
import { RequireAuthGuard } from '../../shared/guards/require-auth.guard';
import { FileInterceptor } from '@nestjs/platform-express';
import { diskStorage } from 'multer';
import { extname } from 'path';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiConsumes, ApiBody } from '@nestjs/swagger';

@ApiTags('exhibitions')
@ApiBearerAuth()
@UseGuards(RequireAuthGuard)
@Controller('exhibitions')
export class ExhibitionsController {
  constructor(private readonly exhibitionsService: ExhibitionsService) {}

  @Post()
  @ApiOperation({ summary: 'Genera nodo jerárquico amarrado a `visit_id` reportando posicion y tipo, puntaje inicial: 0 PTS.' })
  create(@Body() body: any) {
    return this.exhibitionsService.create(body);
  }

  @Post(':id/photos')
  @ApiOperation({ summary: 'Recibe Buffer estático .JPG y recalcula la Fórmula con Pesos DB al comprobar existencia de foto' })
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
    storage: diskStorage({
      destination: './uploads',
      filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, uniqueSuffix + extname(file.originalname));
      }
    })
  }))
  uploadPhoto(
    @Param('id') id: string,
    @UploadedFile() file: Express.Multer.File
  ) {
    if (!file) throw new BadRequestException('El campo multipart `file` está vacío o dañado.');
    
    // Asignar el prefijo localhost expuesto por app.useStaticAssets en main.ts
    const photoUrl = `http://localhost:${process.env.PORT || 3000}/uploads/${file.filename}`;
    
    // Esto llamará a ScoringService detrás de cortina
    return this.exhibitionsService.uploadPhoto(id, photoUrl);
  }
}
