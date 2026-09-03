import { Body, Controller, Delete, Get, Param, Post, Put, Request, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { AdminService } from './admin.service';
import { Roles } from './roles.decorator';
import { RolesGuard } from './roles.guard';
import { PagosService } from '../tienda/pagos.service';
import { PedidosService } from '../tienda/pedidos.service';
import { AvisosService } from '../tienda/avisos.service';
import { ColaService } from '../tienda/cola.service';

/**
 * CV.5: las rutas de pedidos/pagos/cola vuelven aquí ahora que `tienda` está
 * portado (recortadas en CV.1 porque dependían de servicios que no existían
 * todavía — ver el historial de este archivo).
 */
@UseGuards(AuthGuard('jwt'), RolesGuard)
@Controller('admin')
export class AdminController {
  constructor(
    private service: AdminService,
    private pagos: PagosService,
    private cola: ColaService,
    private pedidos: PedidosService,
    private avisos: AvisosService,
  ) {}

  // ── Pantalla de confirmacion ───────────────────────────────────────────────
  //
  // Es la herramienta diaria del departamento de e-commerce. A diferencia de la
  // configuracion de pagos, aqui NO se exige rol 'admin': confirmar pedidos es
  // el trabajo de todos los dias del departamento, no administracion del
  // sistema. Basta con tener sesion valida.

  /** Pedidos esperando confirmacion. GET /api/admin/pedidos/por-confirmar */
  @Get('pedidos/por-confirmar')
  porConfirmar() { return this.pedidos.porConfirmar(); }

  /** Pedidos en efectivo con referencia enviada y sin pagar. */
  @Get('pedidos/sin-pagar')
  sinPagar() { return this.pedidos.sinPagar(); }

  /**
   * Confirma varios de un golpe. Body: { ids: [1,2,3] }
   *
   * Va ANTES que la ruta de un solo pedido: Nest resuelve por orden de
   * declaracion, y 'confirmar' encajaria en :id.
   */
  @Post('pedidos/confirmar')
  confirmarLote(@Body() body: any, @Request() req: any) {
    return this.pedidos.confirmarLote(body?.ids, this.actorDe(req));
  }

  /** Confirma uno. Body opcional: { forzar: true } para surtir incompleto. */
  @Post('pedidos/:id/confirmar')
  confirmarPedido(@Param('id') id: string, @Body() body: any, @Request() req: any) {
    return this.pedidos.confirmar(Number(id), this.actorDe(req),
                                  { forzar: body?.forzar === true });
  }

  /** Cancela un pedido. Body: { motivo } */
  @Post('pedidos/:id/cancelar')
  cancelarPedido(@Param('id') id: string, @Body() body: any, @Request() req: any) {
    return this.pedidos.cancelar(Number(id), this.actorDe(req), body?.motivo);
  }

  /** Liga el pedido con la clave del cliente en Kepler. Body: { clave } */
  @Post('pedidos/:id/cliente-kepler')
  ligarKepler(@Param('id') id: string, @Body() body: any, @Request() req: any) {
    return this.pedidos.ligarClienteKepler(Number(id), body?.clave, this.actorDe(req));
  }

  // ── Envio ──────────────────────────────────────────────────────────────────

  /** Pedidos confirmados esperando guia. GET /api/admin/pedidos/por-enviar */
  @Get('pedidos/por-enviar')
  porEnviar() { return this.pedidos.porEnviar(); }

  /**
   * Registra la guia y marca el pedido como enviado.
   * POST /api/admin/pedidos/:id/guia   Body: { paqueteria, guia }
   *
   * La guia se captura a mano por ahora. Cuando se integre la API de Estafeta
   * o DHL, lo que cambia es quien llama aqui, no la forma de los datos.
   */
  @Post('pedidos/:id/guia')
  registrarGuia(@Param('id') id: string, @Body() body: any, @Request() req: any) {
    return this.pedidos.registrarGuia(Number(id), this.actorDe(req), {
      paqueteria: body?.paqueteria,
      guia: body?.guia,
    });
  }

  // ── Vigilancia de autorizaciones y avisos ──────────────────────────────────

  /** Autorizaciones de tarjeta por vencer sin cobrar. */
  @Get('pedidos/autorizaciones')
  autorizaciones() { return this.pedidos.autorizacionesPorVencer(); }

  /** Avisos al cliente que quedaron sin enviar. */
  @Get('avisos/pendientes')
  avisosPendientes() { return this.avisos.pendientes(); }

  /**
   * Quien esta operando, sacado del token y NUNCA del cuerpo de la peticion: si
   * el cliente pudiera decir quien confirma, la bitacora no serviria como
   * registro de quien hizo que.
   */
  private actorDe(req: any) {
    return {
      email:  String(req?.user?.email || 'desconocido'),
      nombre: String(req?.user?.nombre || ''),
    };
  }

  // ── Cola de trabajos ───────────────────────────────────────────────────────
  //
  // Va detrás del guard de administrador a propósito. Encolar es una escritura,
  // y un endpoint abierto que mete filas en `tienda.trabajos` es un modo
  // cómodo de llenar la base desde internet.

  /**
   * Cómo va la cola. GET /api/admin/cola
   *
   * Es lo único que hoy delata una cola detenida o con trabajos fallidos: no
   * hay ningún error a la vista cuando eso pasa. Conviene engancharlo al
   * vigilante horario, como se hizo con la frescura de los verificadores.
   */
  @Roles('admin')
  @Get('cola')
  verCola() { return this.cola.estado(); }

  /**
   * Encola un trabajo de prueba. POST /api/admin/cola/prueba
   * Body opcional: { fallar_siempre, fallar_hasta, tardar_ms, max_intentos }
   *
   * El canario: comprueba que el trabajador está vivo sin mover un peso.
   */
  @Roles('admin')
  @Post('cola/prueba')
  async probarCola(@Body() body: any) {
    const carga: any = { prueba: true };
    if (body?.fallar_siempre) carga.fallar_siempre = true;
    if (Number(body?.fallar_hasta) > 0) carga.fallar_hasta = Number(body.fallar_hasta);
    if (Number(body?.tardar_ms)   > 0) carga.tardar_ms   = Number(body.tardar_ms);
    try {
      const id = await this.cola.encolar('prueba', carga, {
        maxIntentos: Number(body?.max_intentos) > 0 ? Number(body.max_intentos) : 1,
      });
      return { ok: true, id };
    } catch (e: any) {
      return { ok: false, error: e.message };
    }
  }

  // ── Cobro con Mercado Pago ─────────────────────────────────────────────────
  //
  // El Access Token se puede ESCRIBIR desde aquí pero NUNCA leer: el estado
  // sólo devuelve los últimos cuatro caracteres, lo justo para saber cuál está
  // cargado. Una sesión de administrador robada podría cambiar la
  // configuración —cosa que se nota enseguida, porque los cobros fallan— pero
  // no llevarse el token para cobrar a nombre de Mega Dulces desde otro lado.

  /** Estado del cobro. GET /api/admin/pagos */
  @Roles('admin')
  @Get('pagos')
  verPagos() { return this.pagos.estado(); }

  /**
   * Guarda las credenciales. POST /api/admin/pagos
   * Body: { modo, public_key, access_token, reserva_dias }
   *
   * Se verifica contra Mercado Pago antes de guardar: unas credenciales sin
   * comprobar dejan la tienda "configurada" y rota al mismo tiempo.
   */
  @Roles('admin')
  @Post('pagos')
  async guardarPagos(@Body() body: any) {
    const r = await this.pagos.guardar({
      modo:         body?.modo,
      public_key:   body?.public_key,
      access_token: body?.access_token,
      reserva_dias: Number(body?.reserva_dias),
    });
    // Se devuelve el estado ya actualizado para que el tablero no tenga que
    // volver a preguntarlo y pueda quedar desincronizado.
    return r.ok ? { ...r, estado: this.pagos.estado() } : r;
  }

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

  /**
   * Borrado real y definitivo. Va en una ruta aparte de la de arriba (no la
   * reemplaza): la pantalla exige desactivar primero, esto es el segundo
   * paso, irreversible, para cuando de verdad hay que quitar la fila.
   */
  @Roles('admin')
  @Delete('usuarios/:id/definitivo')
  eliminarDefinitivo(@Param('id') id: string, @Request() req: any) {
    if (req.user.sub === Number(id)) throw new Error('No puedes eliminarte a ti mismo');
    return this.service.eliminarUsuario(Number(id));
  }

  @Roles('admin')
  @Post('usuarios/:id/reset-password')
  resetPassword(@Param('id') id: string, @Body() body: { nueva: string }) {
    return this.service.resetPassword(Number(id), body.nueva);
  }
}
