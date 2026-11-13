import { BadRequestException, Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post, Put, Query, Req, UseGuards } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { RolesGuard, RequirePermissions, Permission } from '@megadulces/platform-core';
import { MktRankingService, esIdPromo } from './mkt-ranking.service';
import type { PromoDto, ObjetivoDto, IncentivoDto, Quien } from './mkt-ranking.service';

interface AuthedRequest { user?: { id?: string; username?: string } }
const quien = (req: AuthedRequest): Quien => ({ id: req?.user?.id, username: req?.user?.username });
/** `[MKT.22]` El id de una promo: UUID de su renglón o `k-<código>` (promo de Kepler sin renglón todavía). */
const idPromo = (id: string | undefined): string => {
  const v = String(id ?? '').trim();
  if (!esIdPromo(v)) throw new BadRequestException('La promoción no es válida');
  return v;
};

/**
 * `[MKT.10]` — Ranking de promociones de Marketing (reemplaza el Excel «RANKING SEMANA NN»).
 *
 * ── Sin claves nuevas, a propósito ────────────────────────────────────────────────────────────
 * Las dos que usa ya están repartidas en prod (medido 2026-11-11): `marketing` (3 personas) y
 * `jefe_marketing` (1) tienen VER y GESTIONAR; `direccion`, `telemarketing` y
 * `credito_cobranza` tienen VER. Una clave nueva sin repartir dejaría el módulo invisible
 * (lección de `[LC.6.2]`).
 *   · `MKT_AGREEMENTS_VER` — ve el ranking y los incentivos.
 *   · `MKT_AGREEMENTS_GESTIONAR` — da de alta promociones, captura objetivos e incentivos.
 */
@ApiTags('mkt-ranking')
@ApiBearerAuth()
@UseGuards(RolesGuard)
@Controller('commercial/mkt-ranking')
export class MktRankingController {
  constructor(private readonly service: MktRankingService) {}

  // ─────────── ranking ───────────

  @Get()
  @RequirePermissions(Permission.MKT_AGREEMENTS_VER)
  @ApiOperation({ summary: 'Ranking de la semana por canal (mostrador · preventa · ruta · mayoreo), en vivo desde Kepler' })
  ranking(@Query('semana') semana?: string, @Query('canal') canal?: string, @Query('promo') promo?: string, @Query('sucursales') sucursales?: string): ReturnType<MktRankingService['ranking']> {
    // Un id que no es de promo no filtra nada: se rechaza en vez de devolver un ranking vacío que parezca real.
    if (promo) idPromo(promo);
    const whs = String(sucursales ?? '').split(',').map((x) => x.trim()).filter((x) => /^\d{2}$/.test(x));
    return this.service.ranking(semana, canal, promo || undefined, whs.length ? whs : undefined);
  }

  // ─────────── promociones ───────────

  @Get('promos')
  @RequirePermissions(Permission.MKT_AGREEMENTS_VER)
  @ApiOperation({ summary: 'Promociones dadas de alta (vigentes; `todas=1` incluye vencidas e inactivas)' })
  promos(@Query('todas') todas?: string): ReturnType<MktRankingService['listarPromos']> {
    return this.service.listarPromos({ todas: todas === '1' || todas === 'true' });
  }

  @Get('codigos-kepler')
  @RequirePermissions(Permission.MKT_AGREEMENTS_VER)
  @ApiOperation({ summary: 'Códigos de promoción de Kepler (simbólicos: «= GRATIS» o $0.01) para dar de alta' })
  codigos(@Query('q') q?: string): ReturnType<MktRankingService['codigosKepler']> {
    return this.service.codigosKepler(q);
  }

  @Post('promos')
  @RequirePermissions(Permission.MKT_AGREEMENTS_GESTIONAR)
  crearPromo(@Body() dto: PromoDto, @Req() req: AuthedRequest): ReturnType<MktRankingService['crearPromo']> {
    return this.service.crearPromo(dto, quien(req));
  }

  @Patch('promos/:id')
  @RequirePermissions(Permission.MKT_AGREEMENTS_GESTIONAR)
  editarPromo(@Param('id', ParseUUIDPipe) id: string, @Body() dto: PromoDto, @Req() req: AuthedRequest): ReturnType<MktRankingService['editarPromo']> {
    return this.service.editarPromo(id, dto, quien(req));
  }

  @Delete('promos/:id')
  @RequirePermissions(Permission.MKT_AGREEMENTS_GESTIONAR)
  borrarPromo(@Param('id', ParseUUIDPipe) id: string, @Req() req: AuthedRequest): ReturnType<MktRankingService['borrarPromo']> {
    return this.service.borrarPromo(id, quien(req));
  }

  // ─────────── objetivos ───────────

  @Get('promos/:id/objetivos')
  @RequirePermissions(Permission.MKT_AGREEMENTS_VER)
  objetivos(@Param('id') id: string): ReturnType<MktRankingService['objetivosDePromo']> {
    return this.service.objetivosDePromo(idPromo(id));
  }

  @Put('promos/:id/objetivos')
  @RequirePermissions(Permission.MKT_AGREEMENTS_GESTIONAR)
  guardarObjetivos(@Param('id') id: string, @Body() body: { items: ObjetivoDto[] }, @Req() req: AuthedRequest): ReturnType<MktRankingService['guardarObjetivos']> {
    return this.service.guardarObjetivos(idPromo(id), body?.items ?? [], quien(req));
  }

  @Post('objetivos/sugerir')
  @RequirePermissions(Permission.MKT_AGREEMENTS_GESTIONAR)
  @ApiOperation({ summary: 'Sugiere objetivos (promedio de las 4 semanas previas). `aplicar` los guarda SÓLO donde no hay objetivo' })
  sugerir(@Body() body: { semana?: string; canal?: string; aplicar?: boolean }, @Req() req: AuthedRequest): ReturnType<MktRankingService['sugerirObjetivos']> {
    return this.service.sugerirObjetivos(body?.semana, body?.canal, body?.aplicar === true, quien(req));
  }

  // ─────────── incentivos ───────────

  @Get('incentivos')
  @RequirePermissions(Permission.MKT_AGREEMENTS_VER)
  @ApiOperation({ summary: 'Incentivos vigentes en la semana, con lo que lleva cada vendedor (semana y acumulado)' })
  incentivos(@Query('semana') semana?: string, @Query('todos') todos?: string): ReturnType<MktRankingService['incentivos']> {
    return this.service.incentivos(semana, { todos: todos === '1' || todos === 'true' });
  }

  @Post('incentivos')
  @RequirePermissions(Permission.MKT_AGREEMENTS_GESTIONAR)
  crearIncentivo(@Body() dto: IncentivoDto, @Req() req: AuthedRequest): ReturnType<MktRankingService['crearIncentivo']> {
    return this.service.crearIncentivo(dto, quien(req));
  }

  @Patch('incentivos/:id')
  @RequirePermissions(Permission.MKT_AGREEMENTS_GESTIONAR)
  editarIncentivo(@Param('id', ParseUUIDPipe) id: string, @Body() dto: IncentivoDto, @Req() req: AuthedRequest): ReturnType<MktRankingService['editarIncentivo']> {
    return this.service.editarIncentivo(id, dto, quien(req));
  }

  @Delete('incentivos/:id')
  @RequirePermissions(Permission.MKT_AGREEMENTS_GESTIONAR)
  borrarIncentivo(@Param('id', ParseUUIDPipe) id: string, @Req() req: AuthedRequest): ReturnType<MktRankingService['borrarIncentivo']> {
    return this.service.borrarIncentivo(id, quien(req));
  }

  @Put('incentivos/:id/capturas')
  @RequirePermissions(Permission.MKT_AGREEMENTS_GESTIONAR)
  capturas(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: { semana: string; items: Array<{ warehouse_code: string; vendor_code: string; cantidad: number }> },
    @Req() req: AuthedRequest,
  ): ReturnType<MktRankingService['guardarCapturas']> {
    return this.service.guardarCapturas(id, body?.semana, body?.items ?? [], quien(req));
  }
}
