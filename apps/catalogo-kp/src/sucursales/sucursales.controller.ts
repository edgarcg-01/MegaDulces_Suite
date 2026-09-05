import { Controller, Get } from '@nestjs/common';
import { SucursalesService } from './sucursales.service';

/**
 * Pública a propósito: `Actualizar_Verificador.ps1` la consulta para saber
 * para qué sucursales generar `verificador-NN.html`, sin tener el código
 * quemado en el script.
 */
@Controller('sucursales')
export class SucursalesController {
  constructor(private readonly service: SucursalesService) {}

  /** GET /api/sucursales */
  @Get()
  getSucursales() { return this.service.getSucursales(); }
}
