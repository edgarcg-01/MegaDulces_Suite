import { Body, Controller, Get, Ip, Param, Post, Request, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ErroresService } from './errores.service';

/**
 * Reporte de errores del navegador.
 *
 * La ruta de captura es PUBLICA a proposito: la llama el navegador del
 * cliente, que no tiene sesion. El servicio la protege con tope por IP y
 * recorte de todos los campos, porque un endpoint publico de escritura sin
 * limites es una forma comoda de llenar la base desde internet.
 *
 * Siempre responde ok, incluso si algo falla dentro: el visitante ya tuvo un
 * problema y no hay que sumarle otro.
 */
@Controller()
export class ErroresController {
  constructor(private readonly errores: ErroresService) {}

  /**
   * Reporta un error del navegador. POST /api/errores
   * Body: { mensaje, origen, rastro, pagina, navegador, folio }
   */
  @Post('errores')
  reportar(@Body() body: any, @Ip() ip: string) {
    return this.errores.registrar({
      mensaje:   body?.mensaje,
      origen:    body?.origen,
      rastro:    body?.rastro,
      pagina:    body?.pagina,
      navegador: body?.navegador,
      folio:     body?.folio,
    }, ip);
  }

  // ── Tablero ────────────────────────────────────────────────────────────────

  /** Errores sin resolver. GET /api/admin/errores */
  @Get('admin/errores')
  @UseGuards(AuthGuard('jwt'))
  activos() { return this.errores.activos(); }

  /** Detalle de uno, con sus ultimas ocurrencias. */
  @Get('admin/errores/:id')
  @UseGuards(AuthGuard('jwt'))
  detalle(@Param('id') id: string) { return this.errores.detalle(Number(id)); }

  /** Marca uno como atendido. Body opcional: { nota } */
  @Post('admin/errores/:id/resolver')
  @UseGuards(AuthGuard('jwt'))
  resolver(@Param('id') id: string, @Body() body: any, @Request() req: any) {
    return this.errores.resolver(
      Number(id), String(req?.user?.email || 'desconocido'), body?.nota);
  }
}
