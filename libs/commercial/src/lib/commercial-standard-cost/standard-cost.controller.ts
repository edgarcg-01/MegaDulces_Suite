import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { RolesGuard, RequirePermissions, Permission } from '@megadulces/platform-core';
import {
  StandardCostService,
  FilaCostoEstandar,
  ResumenCostoEstandar,
  VeredictoCostoEstandar,
  RespuestaEntreSucursales,
  RespuestaHistorial,
} from './standard-cost.service';
import { VeredictoEntreSucursales } from './entre-sucursales';

/**
 * `[CE.3]` — Costo estándar por producto.
 *
 * ── El permiso es PROPIO, no `COMPRAS_COSTO_NETO_VER` reusado ────────────────────────────────
 * El hermano `/compras/costo-neto` publica el *landed cost* agregado por proveedor — lo que
 * salió de la chequera. Esto publica el **dato maestro con el que Kepler pone precio**, que es
 * otra pregunta y otro dueño: quien corrige un costo estándar edita el catálogo, no la compra.
 * Colgarse del permiso vecino mezclaría las dos responsabilidades justo donde importa
 * distinguirlas (mismo criterio que TP.6 usó para separar preparar de autorizar).
 *
 * Es sólo lectura: no hay `GESTIONAR`. Corregir el costo estándar se hace **en Kepler**, que es
 * el sistema de registro del catálogo — escribirle desde acá violaría el principio de ADR-040.
 */
@ApiTags('commercial-standard-cost')
@ApiBearerAuth()
@UseGuards(RolesGuard)
@Controller('commercial/standard-cost')
export class StandardCostController {
  constructor(private readonly service: StandardCostService) {}

  @Get('resumen')
  @RequirePermissions(Permission.COMPRAS_COSTO_ESTANDAR_VER)
  @ApiOperation({
    summary: 'Reparto por veredicto, dinero en juego y cobertura declarada',
    description:
      '`filas_sin_valorar` acompaña obligatoriamente a los totales de dinero: hay filas cuyo ' +
      'testigo viene en otro peldaño y NO se pueden restar. `actividad_al` dice hasta qué día ' +
      'llega la ventana — si la matvista no se refrescó, "30 días" deja de ser cierto.',
  })
  resumen(
    @Query('sucursal') sucursal?: string,
    @Query('q') q?: string,
  ): Promise<ResumenCostoEstandar> {
    // `[CE.9]` `q` viaja acá también: si el tablero no ve el buscador, sus conteos contradicen
    // a la tabla que está debajo. El `veredicto` NO viaja, a propósito (ver el servicio).
    return this.service.resumen({ sucursal: sucursal?.trim() || undefined, q });
  }

  @Get()
  @RequirePermissions(Permission.COMPRAS_COSTO_ESTANDAR_VER)
  @ApiOperation({
    summary: 'Costo estándar por sucursal y SKU, ordenado por el dinero en juego',
    description:
      'Por defecto esconde `sin_operacion` (la ficha existe en las 9 plazas aunque el producto ' +
      'no se maneje ahí: 52,606 filas). No es un hueco, es el maestro replicado.',
  })
  listar(
    @Query('sucursal') sucursal?: string,
    @Query('veredicto') veredicto?: VeredictoCostoEstandar,
    @Query('q') q?: string,
    @Query('incluir_sin_operacion') incluirSinOperacion?: string,
    @Query('incluir_oficinas') incluirOficinas?: string,
    @Query('solo_bajo_costo') soloBajoCosto?: string,
    @Query('limite') limite?: string,
    @Query('desplazamiento') desplazamiento?: string,
  ): Promise<{ filas: FilaCostoEstandar[]; total: number }> {
    return this.service.listar({
      sucursal: sucursal?.trim() || undefined,
      veredicto: veredicto?.trim() as VeredictoCostoEstandar | undefined,
      q,
      incluir_sin_operacion: incluirSinOperacion === 'true',
      incluir_oficinas: incluirOficinas === 'true',
      solo_bajo_costo: soloBajoCosto === 'true',
      limite: Number(limite) || undefined,
      desplazamiento: Number(desplazamiento) || undefined,
    });
  }

  /** ⚠️ Va ANTES de `:sku`: si no, `entre-sucursales` se leería como un SKU. */
  @Get('entre-sucursales')
  @RequirePermissions(Permission.COMPRAS_COSTO_ESTANDAR_VER)
  @ApiOperation({
    summary: 'Productos con costo estándar distinto según la sucursal',
    description:
      'Se compara contra el costo de la mayoría de las plazas, con tolerancia de 0.5 %. ' +
      '`sin_mayoria` y `unidad_distinta` se declaran en vez de compararse. La plaza 00 no entra.',
  })
  entreSucursales(
    @Query('q') q?: string,
    @Query('proveedor_id') proveedorId?: string,
    @Query('sucursal') sucursal?: string,
    @Query('veredicto') veredicto?: VeredictoEntreSucursales,
    @Query('solo_diferencias') soloDiferencias?: string,
    @Query('solo_con_venta') soloConVenta?: string,
    @Query('limite') limite?: string,
    @Query('desplazamiento') desplazamiento?: string,
  ): Promise<RespuestaEntreSucursales> {
    return this.service.entreSucursales({
      q,
      proveedor_id: proveedorId?.trim() || undefined,
      sucursal: sucursal?.trim() || undefined,
      veredicto: veredicto?.trim() as VeredictoEntreSucursales | undefined,
      solo_diferencias: soloDiferencias === undefined ? true : soloDiferencias !== 'false',
      solo_con_venta: soloConVenta === 'true',
      limite: Number(limite) || undefined,
      desplazamiento: Number(desplazamiento) || undefined,
    });
  }

  @Get('historial/:sku')
  @RequirePermissions(Permission.COMPRAS_COSTO_ESTANDAR_VER)
  @ApiOperation({
    summary: 'Trazabilidad de un producto: cambios de costo estándar y de costo de entrada por sucursal',
    description:
      'El estándar se reconstruye de la venta (c62/c58): la fecha es la de la primera venta con el ' +
      'costo nuevo. Las entradas XA2001 se convierten a pieza y se comparan contra el estándar que ' +
      'tenía la plaza ese día. Por defecto, los últimos 365 días.',
  })
  historial(
    @Param('sku') sku: string,
    @Query('desde') desde?: string,
    @Query('hasta') hasta?: string,
  ): Promise<RespuestaHistorial> {
    return this.service.historial(sku, { desde, hasta });
  }

  @Get(':sku')
  @RequirePermissions(Permission.COMPRAS_COSTO_ESTANDAR_VER)
  @ApiOperation({
    summary: 'El mismo SKU en todas las plazas',
    description:
      'El ángulo que la pantalla de Kepler no da: 1,004 SKUs tienen costo estándar distinto ' +
      'entre plazas, y el peldaño del testigo puede cambiar de una sucursal a otra.',
  })
  porSku(@Param('sku') sku: string): Promise<FilaCostoEstandar[]> {
    return this.service.porSku(sku);
  }
}
