import { Body, Controller, Get, Ip, Param, Post, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { CheckoutService, PRIVACIDAD_VERSION } from './checkout.service';
import { TiendaService } from './tienda.service';
import { PagosService } from './pagos.service';
import { cuandoSeAtiende, ABRE_HORA, CIERRA_HORA, CIERRA_MIN } from './horario';

/**
 * Checkout y comprobante del pedido. Rutas públicas.
 *
 * El paso de cobro con Mercado Pago NO está aquí todavía: falta habilitar la
 * captura manual en la cuenta. El checkout deja el pedido listo y marca en
 * `siguiente_paso` si hay que cobrar ahora o esperar a confirmar.
 */
@Controller('tienda')
export class CheckoutController {
  constructor(
    private readonly checkout: CheckoutService,
    private readonly tienda: TiendaService,
    private readonly pagos: PagosService,
  ) {}

  /**
   * Estado del cobro con Mercado Pago, para el tablero.
   *
   * Protegido con sesión: aunque no devuelve el token ni la Public Key, decir
   * en qué modo está y con qué cuenta es información de la operación, no del
   * público.
   * GET /api/tienda/pagos/estado
   */
  @Get('pagos/estado')
  @UseGuards(AuthGuard('jwt'))
  estadoPagos() { return this.pagos.estado(); }

  /**
   * Lo que la pantalla de pago necesita saber antes de pintarse: métodos
   * disponibles, reglas de envío, versión del aviso de privacidad y cuándo se
   * va a atender el pedido si se hace en este momento.
   * GET /api/tienda/checkout/opciones
   */
  @Get('checkout/opciones')
  opciones() {
    const atencion = cuandoSeAtiende();

    const catalogo: Record<string, { nombre: string; nota: string }> = {
      // Se explica el cargo en retención porque es lo que más dudas genera: el
      // cliente ve el monto apartado en su estado de cuenta antes de que se le
      // cobre, y sin aviso previo eso se convierte en una aclaración.
      TARJETA: { nombre: 'Tarjeta de crédito o débito',
                 nota: 'Se aparta el monto al comprar y se cobra al confirmar que hay existencia.' },
      OXXO:    { nombre: 'Efectivo en OXXO',
                 nota: 'Te enviamos la referencia cuando confirmemos existencia.' },
      SPEI:    { nombre: 'Transferencia bancaria (SPEI)',
                 nota: 'Te enviamos los datos cuando confirmemos existencia.' },
    };

    // Sólo se listan los métodos que de verdad se pueden cobrar hoy. Pintar
    // una opción que después va a fallar es peor que no ofrecerla.
    const metodos_pago = this.pagos.metodosDisponibles()
      .map(clave => ({ clave, ...catalogo[clave] }));

    return {
      envio: this.tienda.getConfig().envio,
      metodos_pago,
      privacidad: { version: PRIVACIDAD_VERSION },
      horario: {
        dias: 'Lunes a viernes',
        de: `${ABRE_HORA}:00`,
        a: `${CIERRA_HORA}:${String(CIERRA_MIN).padStart(2, '0')}`,
      },
      atencion: atencion.texto,
    };
  }

  /**
   * Convierte el carrito en pedido.
   * POST /api/tienda/carrito/:token/checkout
   *
   * Body: { metodo_pago, direccion, requiere_factura, datos_fiscales,
   *         acepta_privacidad }
   */
  @Post('carrito/:token/checkout')
  hacer(@Param('token') token: string, @Body() body: any, @Ip() ip: string) {
    return this.checkout.checkout(token, {
      metodo_pago:       body?.metodo_pago,
      direccion:         body?.direccion,
      requiere_factura:  body?.requiere_factura === true,
      datos_fiscales:    body?.datos_fiscales,
      acepta_privacidad: body?.acepta_privacidad === true,
      // La IP la pone el servidor, nunca el cliente: si viniera en el cuerpo,
      // como evidencia de consentimiento no valdría nada.
      ip,
    });
  }

  /** Comprobante del pedido. GET /api/tienda/pedido/:seguimiento */
  @Get('pedido/:seguimiento')
  ver(@Param('seguimiento') seguimiento: string) {
    return this.checkout.verPedido(seguimiento);
  }
}
