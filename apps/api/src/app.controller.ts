import { Controller, Get } from '@nestjs/common';
import { AppService } from './app.service';
import { Public } from '@megadulces/platform-core';

@Controller()
export class AppController {
  constructor(private readonly appService: AppService) {}

  @Public()
  @Get()
  getHello(): string {
    return this.appService.getHello();
  }

  @Public()
  @Get('api/data/version')
  getDataVersion() {
    // Este endpoint permite al frontend verificar si hay cambios en los datos
    // Devuelve la fecha de última modificación y versión de los datos
    // El frontend compara esto con su timestamp local para detectar actualizaciones
    return {
      lastModified: new Date().toISOString(),
      version: '1.0.0',
      timestamp: Date.now()
    };
  }
}
