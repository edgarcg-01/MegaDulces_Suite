import { Controller, Get } from '@nestjs/common';
import { AppService } from './app.service';
import { Public } from '@megadulces/platform-core';
import { commitDelBuild } from './build-info';

@Controller()
export class AppController {
  constructor(private readonly appService: AppService) {}

  @Public()
  @Get()
  getHello(): string {
    return this.appService.getHello();
  }

  /**
   * Healthcheck para Railway (deploy.healthcheckPath = /api/health). Si esto no
   * responde 200 dentro del timeout, el deploy nuevo se marca unhealthy y el
   * anterior sigue sirviendo. Liviano a propósito: solo confirma que el proceso
   * NestJS bindeó y responde (no toca DB — un check de DB haría fallar el deploy
   * por un blip transitorio de red).
   */
  @Public()
  @Get('health')
  getHealth() {
    // `commit` (RAILWAY_GIT_COMMIT_SHA lo inyecta Railway por deploy) = marcador de
    // qué build está sirviendo realmente. Si /health trae el SHA esperado pero el
    // comportamiento sigue viejo → el problema es de datos, no de deploy; si el SHA
    // no cambia tras un redeploy → el build viene del caché (bundle viejo).
    return {
      status: 'ok',
      uptime: process.uptime(),
      // ⛔ NO inlinear esto como `env.A ?? env.B ?? 'unknown'`: `??` es nullish y deja pasar
      // la cadena VACÍA, que es justo lo que produce Compose con una variable sin definir.
      // El porqué completo, con la medición, está en `build-info.ts`.
      commit: commitDelBuild(),
    };
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
