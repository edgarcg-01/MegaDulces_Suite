import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { RolesGuard, RequirePermissions, Permission } from '@megadulces/platform-core';
import { ContpaqiCierreService, type RespuestaCierre } from './contpaqi-cierre.service';

/**
 * `[CPA.0]` — **El semáforo de cierre contable.**
 *
 * ── Por qué cuelga de `contabilidad/contpaqi` y no del puente ───────────────────────────────
 * ⛔ El permiso es `FISCAL_CONTAB_VER`, **no** `FISCAL_CONTPAQI_BRIDGE_VER`, y la diferencia no es
 * cosmética. El puente es el flujo de egresos que la Suite **emite**; esto es la vigilancia de lo
 * que la contadora **ya asentó**, y lo mira gente que no tiene nada que ver con emitir pólizas.
 * Darle el permiso del puente habría mandado a quien sólo revisa los libros a una pantalla que lo
 * rebota — el mismo defecto de gates mal partidos que `[IC.13]` y `[CP.8.32]` ya pagaron.
 *
 * ⭐ Y como `FISCAL_CONTAB_VER` **ya está repartido** (es el de Contabilidad electrónica y el de
 * los libros fiscales de CP.1–CP.4), esta pantalla **no necesita migración de permisos ni que
 * nadie vuelva a entrar**. Un módulo nuevo no está entregado hasta que su permiso está repartido
 * en prod (`[LC.6.2]`); éste nace con esa condición cumplida porque no inventa permiso.
 *
 * ⛔ **Sólo lectura, y a propósito.** No hay `POST`: este tablero no asienta, no genera TXT y no
 * corrige nada. Señala. Quien arregla el mes que falta es el módulo del Libro de Compras o la
 * contadora — ADR-040 intacto.
 */
@ApiTags('contabilidad-cierre')
@ApiBearerAuth()
@UseGuards(RolesGuard)
@Controller('contabilidad/contpaqi')
export class ContpaqiCierreController {
  constructor(private readonly cierre: ContpaqiCierreService) {}

  /**
   * Qué mes está asentado y cuál no, por familia contable.
   *
   * ⚠️ Por omisión devuelve **13 meses**: doce para poder comparar y el que corre. El mes en curso
   * viene marcado `en_curso` y **sin juzgar** — está incompleto por definición, y un tablero que
   * se pone rojo todos los días 1 enseña a ignorarlo.
   */
  @Get('cierre')
  @RequirePermissions(Permission.FISCAL_CONTAB_VER)
  @ApiOperation({ summary: 'Semáforo de cierre contable: qué mes está asentado en ContPAQi y cuál no' })
  @ApiQuery({ name: 'desde', required: false, description: 'YYYY-MM (inclusive)' })
  @ApiQuery({ name: 'hasta', required: false, description: 'YYYY-MM (inclusive)' })
  async getCierre(
    @Query('desde') desde?: string,
    @Query('hasta') hasta?: string,
  ): Promise<RespuestaCierre> {
    return this.cierre.cierre({
      desde: esMes(desde) ? desde : undefined,
      hasta: esMes(hasta) ? hasta : undefined,
    });
  }
}

/**
 * ⚠️ Se valida la FORMA antes de pasarla al `whereBetween`. Knex parametriza, así que esto no es
 * contra inyección: es contra un `?desde=2026` que compara texto contra texto y devuelve una
 * ventana silenciosamente equivocada.
 */
function esMes(v: string | undefined): v is string {
  return typeof v === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(v);
}
