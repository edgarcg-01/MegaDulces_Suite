import { Controller, Get, Query } from '@nestjs/common';
import { Public, ZodValidationPipe } from '@megadulces/platform-core';
import {
  type SucursalVerificador, type VerificadorPrecioResponse, type VerificadorSnapshot,
  VerificadorPrecioQuery, VerificadorPreciosTodosQuery,
} from '@megadulces/contracts';

/**
 * ⛔ `[VAC.FIX]` Alias SOLO-TIPO, y no son cosmeticos: **sin ellos la API no arranca.**
 *
 * `VerificadorPrecioQuery` existe a la vez como VALOR (el esquema Zod) y como TIPO — la
 * convencion de `libs/contracts`, que usan 30 contratos y que esta bien en todos lados
 * MENOS en un parametro DECORADO. Ahi `emitDecoratorMetadata` resuelve el nombre, ve que
 * hay un valor con ese nombre y emite **el objeto Zod** en `design:paramtypes`. Swagger lo
 * introspecciona esperando una clase y revienta al arrancar:
 *
 *     TypeError: Cannot read properties of undefined (reading 'constructor')
 *         at ModelPropertiesAccessor.applyMetadataFactory (@nestjs/swagger)
 *     [start] API process died during boot.
 *
 * Medido en PRODUCCION el 2026-10-15: el pod entro en CrashLoopBackOff y el despliegue no
 * convergio. ⛔ Los CUATRO checks del CI estaban en VERDE — es un fallo de ARRANQUE, no de
 * tipos, y ningun job levanta la API (deuda VP.5). Las dos pruebas por regex que fijaban
 * esta misma linea tambien pasaban: afirmaban el TEXTO del renglon que mataba el arranque.
 *
 * Un alias local no tiene valor homonimo, asi que TypeScript emite `Object` y Swagger no
 * tiene nada que introspeccionar. La prueba negativa vive en `kp.controller.spec.ts`.
 */
type PrecioQuery = VerificadorPrecioQuery;
type PreciosTodosQuery = VerificadorPreciosTodosQuery;

import { KpService } from './kp.service';
import { SucursalesService } from './sucursales.service';

/**
 * Verificador de precios de mostrador. Todas las rutas son PÚBLICAS (`@Public()`,
 * sin sesión) a propósito: las consumen los verificadores de mostrador/kiosco,
 * que no tienen con quién autenticarse. Sólo devuelven precios de venta, nunca
 * costos ni márgenes.
 *
 * Absorbido a `apps/api` desde el app standalone `apps/catalogo-kp` (que tenía
 * su propio `main.ts`/bootstrap/CORS/Pool). Ahora hereda Helmet, Throttler, CORS
 * y la conexión `KNEX_NEW_DB` de la plataforma — un solo backend, no dos.
 */
@Controller('kp')
export class KpController {
  constructor(
    private readonly kpService: KpService,
    private readonly sucursalesService: SucursalesService,
  ) {}

  /**
   * Precio de UN producto por clave interna o código de barras.
   * GET /api/kp/precio?q=17083
   */
  /**
   * `[TDA.2]` `sucursal` es opcional pero **conviene mandarla siempre**: `kdii` trae una fila por
   * plaza y 385 códigos tienen precio distinto entre ellas. Sin sucursal la respuesta es
   * determinista (retail antes que CEDIS) y viene con `precio_ambiguo` declarado.
   */
  @Public()
  @Get('precio')
  getPrecio(@Query(new ZodValidationPipe(VerificadorPrecioQuery)) query: PrecioQuery): Promise<VerificadorPrecioResponse> {
    return this.kpService.getPrecio(query.q ?? '', query.sucursal);
  }

  /**
   * Todo el catálogo con precios por unidad (fuente del verificador offline).
   * GET /api/kp/precios-todos?sucursal=01
   */
  @Public()
  @Get('precios-todos')
  getPreciosTodos(@Query(new ZodValidationPipe(VerificadorPreciosTodosQuery)) query: PreciosTodosQuery): Promise<VerificadorSnapshot> {
    return this.kpService.getPreciosTodos(query.sucursal);
  }
}

/**
 * Catálogo de sucursales para el verificador (nombres, almacenes, frescura ODS).
 * Pública: la consume el generador del verificador para saber para qué plazas
 * armar el archivo, sin código quemado.
 */
@Controller('sucursales')
export class SucursalesController {
  constructor(private readonly sucursalesService: SucursalesService) {}

  /** GET /api/sucursales */
  @Public()
  @Get()
  getSucursales(): Promise<SucursalVerificador[]> { return this.sucursalesService.getSucursales(); }
}
