import { BadRequestException, Body, Controller, Get, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { RolesGuard, RequirePermissions, Permission } from '@megadulces/platform-core';
import {
  MiCierreService, esMes, RESULTADOS,
  type RespuestaMiCierre, type RegistrarResultadoDto, type PolizasMiCierre,
} from './mi-cierre.service';

/**
 * `[CPA.10]` — **La bandeja «Mi cierre»**, la portada nueva de `/contabilidad`.
 *
 * ── Qué permiso, y por qué NO uno nuevo ───────────────────────────────────────────────────────
 * `FISCAL_CONTAB_VER` / `FISCAL_CONTAB_GESTIONAR`, los mismos que `[CPA.0]`. Están **repartidos
 * en prod** (verificado el 2026-10-12: el rol `contabilidad` los tiene en `true`), así que esta
 * pantalla **no necesita migración de permisos ni que nadie vuelva a entrar**. Un módulo nuevo no
 * está entregado hasta que su permiso está repartido (`[LC.6.2]`); éste nace con esa condición
 * cumplida porque no inventa permiso.
 *
 * ⛔ Y **no** se reusa `FISCAL_CONTPAQI_BRIDGE_*`: ése es el flujo de egresos que la Suite emite.
 * Esto lo mira quien lleva los libros. Gates mal partidos ya costaron dos veces (`[IC.13]`,
 * `[CP.8.32]`): el que puede ver la bandeja tiene que poder leerla entera.
 *
 * ⚠️ El único `POST` **no escribe a ContPAQi** (ADR-040 intacto): registra lo que la contadora
 * dice que pasó allá. Y nunca marca `verificada = true` por su cuenta.
 */
@ApiTags('contabilidad-mi-cierre')
@ApiBearerAuth()
@UseGuards(RolesGuard)
@Controller('contabilidad/mi-cierre')
export class MiCierreController {
  constructor(private readonly svc: MiCierreService) {}

  /**
   * Qué le toca a contabilidad este mes: el tecleo por familia, qué se puede armar, en qué parte
   * del camino va cada entrega, y qué queda declarado con dueño.
   */
  @Get()
  @RequirePermissions(Permission.FISCAL_CONTAB_VER)
  @ApiOperation({ summary: 'Bandeja «Mi cierre»: lo que ContPAQi espera este mes y qué se arma solo' })
  @ApiQuery({ name: 'mes', required: false, description: 'YYYY-MM. Por omisión, el mes en curso.' })
  async bandeja(@Query('mes') mes?: string): Promise<RespuestaMiCierre> {
    return this.svc.bandeja(esMes(mes) ? mes : undefined);
  }

  /** `[LC.21]` El desglose de un renglón de la bandeja: las pólizas de una familia en un mes. */
  @Get('polizas')
  @RequirePermissions(Permission.FISCAL_CONTAB_VER)
  @ApiOperation({ summary: 'Pólizas de una familia de la bandeja en un mes, con sus renglones y cargos' })
  @ApiQuery({ name: 'mes', required: true, description: 'YYYY-MM' })
  @ApiQuery({ name: 'familia', required: true })
  @ApiQuery({ name: 'page', required: false })
  async polizas(
    @Query('mes') mes: string,
    @Query('familia') familia: string,
    @Query('page') page?: string,
  ): Promise<PolizasMiCierre> {
    return this.svc.polizas({ mes, familia, page: page ? Number(page) : 1 });
  }

  /**
   * Cierra el lazo de una entrega: `aplicada` | `sin_afectar` | `rechazada`.
   *
   * ⭐ `verificada` es **ternario** y llega del cliente sólo como `true` cuando hay bitácora de
   * ContPAQi que lo respalde. Sin ella se guarda `null` y la bandeja lo pinta
   * `aplicada_sin_verificar` — con nombre y hora. Es la diferencia entre *no sé* y *listo*.
   */
  @Post(':eventoTipo/:periodo/resultado')
  @RequirePermissions(Permission.FISCAL_CONTAB_GESTIONAR)
  @ApiOperation({ summary: 'Registra qué pasó al cargar el archivo en ContPAQi' })
  async registrarResultado(
    @Param('eventoTipo') eventoTipo: string,
    @Param('periodo') periodo: string,
    @Body() body: RegistrarResultadoDto,
    @Req() req: { user?: { username?: string; sub?: string } },
  ) {
    const quien = req?.user?.username || req?.user?.sub;
    if (!quien) throw new BadRequestException('no se pudo identificar quién declara el resultado');
    if (!body?.resultado || !RESULTADOS.includes(body.resultado)) {
      throw new BadRequestException(`\`resultado\` debe ser uno de: ${RESULTADOS.join(', ')}`);
    }
    return this.svc.registrarResultado(eventoTipo, periodo, body, quien);
  }
}
