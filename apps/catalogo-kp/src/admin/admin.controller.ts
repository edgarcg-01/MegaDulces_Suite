import { Body, Controller, Delete, Get, Param, Post, Put, Request, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { AdminService } from './admin.service';
import { Roles } from './roles.decorator';
import { RolesGuard } from './roles.guard';

/**
 * CV.1: sólo el CRUD de usuarios del tablero.
 *
 * El `AdminController` del proyecto origen también fronteaba
 * `pedidos/pagos/cola` — pero esas rutas dependen de `PagosService`,
 * `ColaService`, `PedidosService` y `AvisosService`, todos del módulo
 * `tienda`, que se porta hasta CV.5 (dinero real, motor de colas). Se
 * agregan a este mismo controller (mismas rutas `/api/admin/pedidos/*`,
 * `/api/admin/pagos`, `/api/admin/cola*`) cuando `tienda` aterrice — no es
 * un recorte de alcance, es secuenciar lo que ya depende de algo que no
 * existe todavía. Ver FASE_CV_CATALOGO_TIENDA_MAYOREO.md, CV.5.
 */
@UseGuards(AuthGuard('jwt'), RolesGuard)
@Controller('admin')
export class AdminController {
  constructor(private service: AdminService) {}

  @Roles('admin')
  @Get('usuarios')
  listar() {
    return this.service.listarUsuarios();
  }

  @Roles('admin')
  @Post('usuarios')
  crear(@Body() body: { email: string; nombre: string; password: string; rol?: string; sucursales?: string[] }) {
    return this.service.crearUsuario(body);
  }

  @Roles('admin')
  @Put('usuarios/:id')
  actualizar(@Param('id') id: string, @Body() body: any) {
    return this.service.actualizarUsuario(Number(id), body);
  }

  @Roles('admin')
  @Delete('usuarios/:id')
  desactivar(@Param('id') id: string, @Request() req: any) {
    if (req.user.sub === Number(id)) throw new Error('No puedes desactivarte a ti mismo');
    return this.service.desactivarUsuario(Number(id));
  }

  @Roles('admin')
  @Post('usuarios/:id/reset-password')
  resetPassword(@Param('id') id: string, @Body() body: { nueva: string }) {
    return this.service.resetPassword(Number(id), body.nueva);
  }
}
