import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { PendingAuthGuard } from '../common/pending-auth.guard';
import { KpService } from './kp.service';

/**
 * Rutas de Kepler.
 *
 * PÚBLICAS (las consume el verificador de precios de mostrador, que no tiene
 * con quién autenticarse): `precio` y `precios-todos`. Sólo devuelven precios
 * de venta, nunca costos ni márgenes.
 *
 * INTERNAS (exigían sesión en el proyecto origen): el resto. Exponen costo,
 * margen y ventas. `auth` todavía no se porta (CV.1) — en vez de dejarlas
 * abiertas, `PendingAuthGuard` responde 503 explícito. Se cambia por
 * `@UseGuards(AuthGuard('jwt'))` de verdad en CV.1.
 */
@Controller('kp')
export class KpController {
  constructor(private readonly kpService: KpService) {}

  /**
   * Inspecciona kp.kdm2: columnas reales + mapeo automático + 3 filas de muestra.
   * GET /api/kp/schema
   */
  @UseGuards(PendingAuthGuard)
  @Get('schema')
  getSchema() { return this.kpService.getSchema(); }

  /** Ventas totales y documentos por sucursal. GET /api/kp/ventas-suc */
  @UseGuards(PendingAuthGuard)
  @Get('ventas-suc')
  getVentasSuc() { return this.kpService.getVentasSuc(); }

  /** Ventas mensuales por sucursal (trend). GET /api/kp/trend */
  @UseGuards(PendingAuthGuard)
  @Get('trend')
  getTrend() { return this.kpService.getTrend(); }

  /** Top 20 artículos por importe. GET /api/kp/articulos */
  @UseGuards(PendingAuthGuard)
  @Get('articulos')
  getArticulos() { return this.kpService.getArticulos(); }

  /**
   * Catálogo completo de productos desde kp.kdii.
   * Incluye costo, IVA, IEPS, margen y precio_final calculado.
   * GET /api/kp/productos
   */
  @UseGuards(PendingAuthGuard)
  @Get('productos')
  getProductos() { return this.kpService.getProductos(); }

  /**
   * Catálogo + existencia por sucursal + movimientos del año.
   * Se cachea 15 minutos porque tarda ~8 s y pesa 5.5 MB.
   * GET /api/kp/explorador          usa el cache si está vigente
   * GET /api/kp/explorador?refrescar=1   fuerza el recálculo
   */
  @UseGuards(PendingAuthGuard)
  @Get('explorador')
  getExplorador(@Query('refrescar') refrescar?: string) {
    return this.kpService.getExplorador(refrescar === '1' || refrescar === 'true');
  }

  /**
   * Precio de UN producto por clave interna o código de barras.
   * Lo consume el verificador de precios de mostrador.
   * GET /api/kp/precio?q=17083
   */
  @Get('precio')
  getPrecio(@Query('q') q: string) { return this.kpService.getPrecio(q); }

  /**
   * Todo el catálogo con precios por unidad.
   * Es la fuente del verificador OFFLINE: la tarea diaria
   * «MegaDulces - Actualizar verificador de precios» lo incrusta en
   * public/verificador.html.
   * GET /api/kp/precios-todos
   */
  @Get('precios-todos')
  getPreciosTodos(@Query('sucursal') sucursal?: string) {
    return this.kpService.getPreciosTodos(sucursal);
  }

  /**
   * KP Concentrada: merge PostgreSQL + Excel mensuales.
   * Incluye todas las sucursales, valida consistencia y elimina duplicados.
   * Fuente: 'postgresql' | 'excel' | 'ambos'
   * GET /api/kp/concentrada
   * Parámetros opcionales:
   *   ?soloDiscrepancias=true  → sólo artículos con diferencias PG vs Excel
   *   ?sucursal=03             → filtrar por sucursal
   */
  @UseGuards(PendingAuthGuard)
  @Get('concentrada')
  async getConcentrada(
    @Query('soloDiscrepancias') soloDiscrepancias?: string,
    @Query('sucursal') sucursal?: string,
  ) {
    let data = await this.kpService.getConcentrada();

    if (sucursal) {
      data = data.filter(d => d.sucursal === sucursal);
    }
    if (soloDiscrepancias === 'true') {
      data = data.filter(d => d.discrepancias && Object.keys(d.discrepancias).length > 0);
    }

    return {
      total:        data.length,
      generado:     new Date().toISOString(),
      articulos:    data,
    };
  }
}
