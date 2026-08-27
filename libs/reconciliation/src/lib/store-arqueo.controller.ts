import { BadRequestException, Body, Controller, Get, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import {
  RolesGuard, RequirePermissions, Permission, ReqUser,
  ScopeService, CANONICAL_PARAM, isPlatformAdminRole,
} from '@megadulces/platform-core';
import { BlindCountService } from './blind-count.service';
import type { BlindCountDto } from './blind-count.service';

/**
 * SM.8/P1 — Superficie de arqueo ciego para CAJERAS (proyecto Tienda, /tienda/arqueo).
 *
 * Reusa `BlindCountService` (misma tabla `reconciliation.blind_counts` que el
 * Supervisor de Movimientos), pero acotada en los dos ejes:
 *
 *  - **QUÉ FILAS** (`[ID.4]`, ADR-050): el alcance sale de `ScopeService`, no del
 *    viejo `user?.warehouse_code || query.warehouse_code` (fail-OPEN: quien no
 *    tenía sucursal asignada veía la red completa). Ahora la cajera ve y captura
 *    exactamente las sucursales que tiene asignadas — una, varias (`listed`) o
 *    ninguna. Escribir en otra es 403 explícito, no un filtro que se puede saltar.
 *
 *  - **QUÉ CAMPOS**: la cajera **no ve el esperado ni su diferencia**. Contar a
 *    ciegas y después ver el hueco es lo mismo que saber el esperado (esperado =
 *    contado + diferencia): con eso puede "ajustar" el conteo en una recaptura, o
 *    saber cuánto puede faltar sin que se note. Solo el supervisor
 *    (`RECONCILIATION_VER`, /almacen/cuadre) revela — y ahí ya se ve además el
 *    flag de enmascaramiento de Kepler. El descuadre igual se levanta al instante
 *    en la bandeja del supervisor (autolineado SM.9): la cajera no lo ve, pero pasa.
 */
type AuthUser = {
  username?: string;
  warehouse_code?: string;
  role_name?: string;
  permissions?: Record<string, boolean>;
} | undefined;

const WH = CANONICAL_PARAM.warehouse; // 'warehouse_codes'

@ApiTags('store')
@ApiBearerAuth()
@UseGuards(RolesGuard)
@Controller('store/arqueo')
export class StoreArqueoController {
  constructor(
    private readonly blind: BlindCountService,
    private readonly scope: ScopeService,
  ) {}

  /**
   * ¿Este usuario puede ver el esperado? Solo el supervisor del motor de cuadre
   * (o un admin de plataforma). Todo lo demás es "cajera" a estos efectos: se le
   * devuelve SU conteo y nada más.
   */
  private revela(user: AuthUser): boolean {
    return isPlatformAdminRole(user?.role_name)
      || user?.permissions?.[Permission.RECONCILIATION_VER] === true;
  }

  /**
   * Quita todo lo que permita deducir el esperado. `diff_real` se va junto con
   * `esperado` a propósito: publicar uno de los dos es publicar los dos.
   */
  private proyectar<T extends Record<string, any>>(r: T, revela: boolean) {
    const { kepler_enmascaro, kepler_contado, kepler_diff, esperado, diff_real, ...ciego } = r;
    return revela ? { ...ciego, esperado, diff_real } : ciego;
  }

  /**
   * Sucursal sobre la que se captura: la pedida (validada contra el alcance de
   * ESCRITURA) o, si no se pidió, la suya cuando tiene exactamente una. Con
   * varias asignadas hay que elegir — adivinar sería sellar dinero en la caja
   * equivocada.
   */
  private async resolverSucursal(pedida: string | undefined): Promise<string> {
    const code = (pedida || '').trim();
    if (code) {
      await this.scope.assertCanWrite('warehouse', code);
      return code;
    }
    const dim = (await this.scope.current()).dims.warehouse;
    if (dim.modeWrite !== 'all' && dim.valuesWrite.length === 1) return dim.valuesWrite[0];
    throw new BadRequestException(
      dim.valuesWrite.length > 1
        ? `Elegí la sucursal: tenés ${dim.valuesWrite.length} asignadas (${dim.valuesWrite.join(', ')}).`
        : 'Tu usuario no tiene sucursal asignada para capturar arqueos. Pedile al administrador que te asigne una.',
    );
  }

  @Post()
  @RequirePermissions(Permission.STORE_ARQUEO_CAPTURAR)
  @ApiOperation({ summary: 'Tienda — la cajera captura su arqueo CIEGO. Devuelve solo su total contado (el esperado y la diferencia son del supervisor).' })
  async submit(@Body() body: BlindCountDto, @ReqUser() user: AuthUser) {
    const warehouse_code = await this.resolverSucursal(body?.warehouse_code);
    const res = await this.blind.submit({ ...body, warehouse_code }, user?.username);
    const revela = this.revela(user);
    // Sin revelación, `matched`/`ambiguous` tampoco tienen sentido (no hay nada
    // que comparar del lado de la cajera) y `ambiguous` filtraría que hay más de
    // un corte en su caja. Respuesta mínima: se guardó y cuánto contó.
    return revela
      ? { ...this.proyectar(res, true), reveal: true }
      : { tipo: res.tipo, total_contado: res.total_contado, reveal: false };
  }

  @Get()
  @RequirePermissions(Permission.STORE_ARQUEO_VER)
  @ApiQuery({ name: WH, required: false, description: 'Sucursal o CSV de sucursales. Se recorta a tu alcance. Acepta los nombres viejos (warehouse_code, sucursal…) y valores en código o uuid.' })
  @ApiQuery({ name: 'from', required: false })
  @ApiQuery({ name: 'to', required: false })
  @ApiQuery({ name: 'limit', required: false })
  @ApiOperation({ summary: 'Tienda — historial de arqueos de las sucursales asignadas al usuario (sin esperado ni diferencia salvo supervisor).' })
  async list(@ReqUser() user: AuthUser, @Query() query: Record<string, unknown>) {
    const warehouse_codes = await this.scope.readParam(query, 'warehouse', 'store/arqueo');
    const limit = query['limit'];
    const rows = await this.blind.list({
      from: query['from'] as string | undefined,
      to: query['to'] as string | undefined,
      warehouse_codes,
      limit: limit ? Number(limit) : undefined,
    });
    const revela = this.revela(user);
    return rows.map((r) => this.proyectar(r, revela));
  }
}
