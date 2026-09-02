import { Body, Controller, Delete, Get, Param, Patch, Post } from '@nestjs/common';
import { CarritoService } from './carrito.service';

/**
 * Carrito de la tienda. Rutas públicas: el comprador no necesita cuenta.
 *
 * El carrito se identifica con el token que devuelve POST /carrito. El cliente
 * lo guarda y lo presenta en cada llamada; sin él no hay forma de tocar un
 * carrito ajeno, porque va firmado con CATALOGO_KP_JWT_SECRET.
 *
 * Todas las rutas devuelven el carrito completo y recalculado, para que el
 * frontend nunca tenga que llevar su propia cuenta de los totales. Ese es el
 * tipo de duplicación que termina mostrando un total distinto al que se cobra.
 */
@Controller('tienda/carrito')
export class CarritoController {
  constructor(private readonly carrito: CarritoService) {}

  /** Crea un carrito vacío. POST /api/tienda/carrito */
  @Post()
  crear() { return this.carrito.crear(); }

  /** Consulta el carrito, revalidando precios y existencia. */
  @Get(':token')
  ver(@Param('token') token: string) {
    return this.carrito.ver(token);
  }

  /** Agrega un producto. Body: { codigo, unidad, cantidad } */
  @Post(':token/items')
  agregar(@Param('token') token: string, @Body() body: any) {
    return this.carrito.agregar(
      token, body?.codigo, body?.unidad, Number(body?.cantidad ?? 1));
  }

  /** Cambia la cantidad de un renglón. Body: { cantidad }. Cero lo quita. */
  @Patch(':token/items/:itemId')
  cambiar(@Param('token') token: string,
          @Param('itemId') itemId: string,
          @Body() body: any) {
    return this.carrito.cambiar(token, Number(itemId), Number(body?.cantidad));
  }

  /** Quita un renglón. */
  @Delete(':token/items/:itemId')
  quitar(@Param('token') token: string, @Param('itemId') itemId: string) {
    return this.carrito.quitar(token, Number(itemId));
  }

  /**
   * Cancela el carrito completo. El token deja de servir.
   * DELETE /api/tienda/carrito/:token
   */
  @Delete(':token')
  cancelar(@Param('token') token: string) {
    return this.carrito.cancelar(token);
  }

  /** Datos de contacto. Body: { nombre, email, tel } */
  @Post(':token/cliente')
  cliente(@Param('token') token: string, @Body() body: any) {
    return this.carrito.datosCliente(token, {
      nombre: body?.nombre, email: body?.email, tel: body?.tel,
    });
  }
}
