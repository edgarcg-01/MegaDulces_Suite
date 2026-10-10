import { Body, Controller, Get, Post, Query, UseGuards, BadRequestException } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { RolesGuard, RequirePermissions, Permission, ReqUser, ScopeService } from '@megadulces/platform-core';
import type { PriceChangeNoticeDto, PriceNoticeRecipientsDto, PriceNoticeShareRequestDto, PriceNoticeShareResultDto } from '@megadulces/contracts';
import { CommercialLabelsService } from './commercial-labels.service';
import { PriceChangeNoticesService, PriceNoticeRunResult } from './price-change-notices.service';

/**
 * Etiquetera (proyecto Tienda). Ruta bajo /store/* para mantener Tienda cohesivo,
 * aunque el código viva en libs/commercial (donde ya está wireado TenantKnexService/RLS).
 * Gateado con STORE_LIVE_VER (mismo permiso del proyecto Tienda).
 */
@ApiTags('store-labels')
@ApiBearerAuth()
@UseGuards(RolesGuard)
@Controller('store/labels')
export class CommercialLabelsController {
  constructor(
    private readonly svc: CommercialLabelsService,
    private readonly notices: PriceChangeNoticesService,
    private readonly scope: ScopeService,
  ) {}

  @Get('search')
  @RequirePermissions(Permission.STORE_LABELS_VER)
  @ApiQuery({ name: 'q', required: true, description: 'Texto: nombre / SKU / barcode (mín 2 chars).' })
  @ApiOperation({ summary: 'Etiquetera — búsqueda de catálogo para agregar productos a la cola de impresión.' })
  search(@Query('q') q: string) {
    return this.svc.search(q);
  }

  @Get('price-changes')
  @RequirePermissions(Permission.STORE_LABELS_VER)
  @ApiQuery({ name: 'sucursal', required: true, description: 'Plaza de dos dígitos. Sin ella la lista va vacía: la bitácora es POR tienda.' })
  @ApiQuery({ name: 'fecha', required: false, description: 'Día a revisar (YYYY-MM-DD). Default: AYER en hora de México.' })
  @ApiOperation({
    summary: 'Etiquetera — cambios de precio de un día, con precio anterior y nuevo.',
    description:
      'Deriva de `analytics.v_label_price_changes` sobre la bitácora nativa de Kepler — la única ' +
      'fuente que guarda el precio ANTERIOR. Filtra a los cambios que mueven el precio IMPRESO: ' +
      'Kepler escribe una fila por recálculo y el 99.8% son deltas de menos de un centavo. ' +
      '`fuente_al` dice hasta qué día llegó la bitácora, para que "no cambió nada" y "todavía no ' +
      'llegó" no se vean iguales. `es_baja` marca el precio nuevo en cero: no es rebaja, es que el ' +
      'ERP le quitó el precio.',
  })
  priceChanges(@Query('sucursal') sucursal?: string, @Query('fecha') fecha?: string) {
    return this.svc.priceChanges(sucursal ?? null, fecha ?? null);
  }

  @Get('price-changes/branches')
  @RequirePermissions(Permission.STORE_LABELS_VER)
  @ApiOperation({
    summary: 'Etiquetera — plazas que la bitácora puede servir, para quien no tiene tienda propia.',
    description:
      'La pantalla de cambios toma la plaza del `warehouse_code` del usuario. 13 de las 33 personas ' +
      'con este permiso no tienen ninguna (Compras, Dirección, Supervisión, superadmin): para ellas ' +
      'la lista es la única forma de entrar. Se DERIVA de `analytics.v_label_price_changes`, así que ' +
      'no puede ofrecer una plaza sin datos. `ultimo_dia` deja ver de una si alguna se quedó atrás. ' +
      'Acotada a 60 días por costo (3,738 ms → 173 ms); hoy las 9 plazas están activas.',
  })
  priceChangeBranches() {
    return this.svc.priceChangeBranches();
  }

  // ── `[ETQ-AVISOS]` Avisos de cambios de precio ─────────────────────────────────────────────

  @Get('notices')
  @RequirePermissions(Permission.STORE_LABELS_VER)
  @ApiQuery({ name: 'since', required: false, description: 'ISO. Sólo avisos posteriores (la campana lo avanza). Sin él, los últimos 3 días.' })
  @ApiOperation({
    summary: 'Etiquetera — avisos de cambios de precio que le tocan a quien pregunta.',
    description:
      'Recortado a las plazas de su alcance (`ScopeService`): quien no tiene alcance declarado ve todas. ' +
      'Los genera el cron (07:30 resume AYER, 14:00 lo que va de HOY) o los manda Compras. Nunca hay un aviso ' +
      'vacío: un día sin cambios no genera fila.',
  })
  async listNotices(@Query('since') since?: string): Promise<PriceChangeNoticeDto[]> {
    // `ScopeService.readParam(undefined, …)` = el alcance del usuario sin filtro pedido: `null` = todas.
    const plazas = await this.scope.readParam(undefined, 'warehouse', 'store/labels/notices');
    return this.notices.list(plazas, since);
  }

  @Get('notices/recipients')
  @RequirePermissions(Permission.STORE_LABELS_COMPARTIR)
  @ApiOperation({
    summary: 'Etiquetera — por plaza: cuántas personas con tienda asignada ven el aviso y hasta qué día llega su bitácora.',
    description: 'Para el diálogo de compartir. `destinatarios = 0` no apaga el aviso (quien tiene alcance total lo ve): lo DECLARA.',
  })
  recipients(): Promise<PriceNoticeRecipientsDto[]> {
    return this.notices.recipients();
  }

  @Post('notices/share')
  @RequirePermissions(Permission.STORE_LABELS_COMPARTIR)
  @ApiOperation({
    summary: 'Etiquetera — Compras manda el aviso de cambios de precio a una o varias sucursales.',
    description:
      'Cada plaza devuelve SU estado con el motivo: `enviado`, `sin_cambios` (no se manda un aviso vacío), ' +
      '`sin_dato` (la bitácora no llega a ese día: no es lo mismo que «no hubo»), `repetido` (la misma persona, ' +
      'misma plaza y día en 10 min) o `plaza_invalida` (no existe o está fuera de tu alcance).',
  })
  async shareNotices(@Body() body: PriceNoticeShareRequestDto, @ReqUser() user: { sub?: string }): Promise<PriceNoticeShareResultDto[]> {
    if (!user?.sub) throw new BadRequestException('Sin usuario en la sesión.');
    const alcance = await this.scope.readParam(undefined, 'warehouse', 'store/labels/notices/share');
    return this.notices.share(body, user.sub, alcance);
  }

  @Post('notices/generate')
  @RequirePermissions(Permission.STORE_LABELS_COMPARTIR)
  @ApiOperation({
    summary: 'Etiquetera — dispara a mano el corte de avisos (`manana` resume AYER, `tarde` HOY).',
    description:
      'Para probar sin esperar a las 07:30 / 14:00. Es idempotente (un aviso automático por plaza, día y corte: ' +
      'repetirlo actualiza los conteos, no duplica) y la fecha la fija el corte, no el que llama.',
  })
  async generateNotices(@Body() body: { corte?: string }): Promise<PriceNoticeRunResult> {
    const corte = body?.corte;
    if (corte !== 'manana' && corte !== 'tarde') throw new BadRequestException('corte debe ser «manana» o «tarde».');
    return this.notices.generarTodos(corte);
  }

  @Post('resolve')
  @RequirePermissions(Permission.STORE_LABELS_VER)
  @ApiOperation({
    summary: 'Etiquetera — resuelve una lista de códigos (SKU o barcode) al modelo de la etiqueta de anaquel.',
    description:
      '`sucursal` (dos dígitos) imprime el precio DE ESA TIENDA. `[NORM.3]`: el precio de Kepler es por ' +
      'plaza (1,039 SKUs con precio de pieza distinto entre plazas, 1,164 grupos de mayoreo de paquete), ' +
      'y hasta ahora la etiqueta salía con la moda entre tiendas. Sin `sucursal` se responde esa misma ' +
      'forma consolidada — igual que hoy — para no romper a quien todavía no la manda.',
  })
  resolve(@Body() body: { codes: string[]; sucursal?: string }) {
    return this.svc.resolveForLabels(body?.codes || [], body?.sucursal ?? null);
  }
}
