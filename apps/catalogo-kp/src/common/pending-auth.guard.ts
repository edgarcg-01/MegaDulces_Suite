import { CanActivate, Injectable, ServiceUnavailableException } from '@nestjs/common';

/**
 * Stub para endpoints que en el proyecto origen exigían
 * `@UseGuards(AuthGuard('jwt'))` pero cuyo módulo `auth` todavía no se porta
 * (CV.1). Responde 503 en vez de dejarlos abiertos — algunos exponen costo y
 * margen, y un despliegue accidental de CV.0 no debe filtrarlos.
 *
 * Se retira cuando CV.1 porte `auth` y estos endpoints vuelvan a
 * `@UseGuards(AuthGuard('jwt'))` de verdad.
 */
@Injectable()
export class PendingAuthGuard implements CanActivate {
  canActivate(): boolean {
    throw new ServiceUnavailableException(
      'auth no portado aún — ver CV.1 en FASE_CV_CATALOGO_TIENDA_MAYOREO.md',
    );
  }
}
