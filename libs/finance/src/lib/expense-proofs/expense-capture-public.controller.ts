import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { ApiOperation, ApiTags, ApiExcludeEndpoint } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Public } from '@megadulces/platform-core';
import { ExpenseCaptureLinksService, CaptureSubmitDto } from './expense-capture-links.service';

/**
 * GX.9 — la superficie PÚBLICA: el celular del trabajador, sin cuenta ni sesión.
 *
 * Todo acá es `@Public()` y se autoriza con el token del link, que va en la URL. Las reglas
 * de esta superficie, que hay que sostener si alguien agrega un endpoint:
 *
 *   · **Sólo escribe, y sólo lee lo suyo.** Nada de Kepler, nada de gastos ajenos, ningún
 *     listado de la empresa. `context` devuelve la persona del link, el catálogo de
 *     sucursales y las capturas de ESE link — nada más.
 *   · **Nunca cierra un expediente.** Aunque el OCR cuadre al centavo, entra a revisión
 *     humana (decisión del PM). No hay endpoint de validar acá, y no debe haberlo.
 *   · **Rate limit propio**, más apretado que el global: es la única puerta sin sesión del
 *     módulo, y subir fotos es caro (bucket + una llamada a visión por ticket).
 *
 * Si el link se filtra, lo peor que puede pasar es que entre basura a una bandeja que un
 * humano ya iba a revisar. No se mueve dinero y no se lee nada de la empresa.
 */
@ApiTags('finance-expense-capture-public')
@Controller('finance/captura')
export class ExpenseCapturePublicController {
  constructor(private readonly svc: ExpenseCaptureLinksService) {}

  /** Quién soy según el link, a dónde tiro por default, y qué subí antes (con su estado). */
  @Public()
  @Throttle({ medium: { limit: 30, ttl: 60_000 } })
  @Get(':token')
  @ApiOperation({ summary: 'Contexto del link: persona, sucursal por default, catálogo de sucursales y las capturas de ESE link.' })
  context(@Param('token') token: string) {
    return this.svc.context(token);
  }

  /**
   * Sube una foto. Va de a un archivo para que una falla de red no tire las demás —
   * exactamente el mismo criterio que la captura interna, y acá pesa más: es un celular
   * con datos móviles.
   */
  @Public()
  @Throttle({ medium: { limit: 12, ttl: 60_000 } })
  @Post(':token/upload')
  @ApiExcludeEndpoint()
  upload(@Param('token') token: string, @Body() body: { file_base64?: string; role?: string }) {
    return this.svc.uploadFile(token, body?.file_base64 || '', body?.role || '');
  }

  /** Envía el gasto. Queda SIN folio hasta que en oficina lo casen con su solicitud. */
  @Public()
  @Throttle({ medium: { limit: 6, ttl: 60_000 } })
  @Post(':token')
  @ApiOperation({ summary: 'Alta del gasto desde el link. Queda con folio_solicitud NULL y status recibida; nunca se auto-valida.' })
  submit(@Param('token') token: string, @Body() body: CaptureSubmitDto) {
    return this.svc.submit(token, body);
  }
}
