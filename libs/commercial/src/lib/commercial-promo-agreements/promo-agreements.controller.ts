import { Body, Controller, Delete, Get, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { RolesGuard, RequirePermissions, RequireAnyPermission, Permission } from '@megadulces/platform-core';
import {
  PromoAgreementsService,
  CrearAcuerdoDto,
  CanalDto,
  AgreementStatus,
  FileKind,
} from './promo-agreements.service';

/**
 * `[MKT.6]` La forma del request autenticado.
 *
 * NO es un tipo nuevo: es **exactamente** la que `verDinero()` ya declaraba inline unas
 * lineas mas abajo. Se le pone nombre para que los `@Req()` dejen de ser `any` -- un `any`
 * aca es el agujero por donde `req.user.permissions` se lee mal sin que nada se queje, y
 * de ese booleano depende que el MONTO negociado viaje o no en el JSON.
 */
interface AuthedRequest {
  user?: {
    permissions?: Record<string, boolean> | string[];
    // `crear`, `autorizar` y `subirEvidencia` firman con QUIEN lo hizo: el `any` tapaba
    // que estos dos campos se leen, y un typo en cualquiera de ellos habria guardado el
    // acuerdo a nombre de `undefined` sin que nada fallara.
    id?: string;
    username?: string;
  };
}

/**
 * `[MKT.1]` — Acuerdos con proveedor (formato MKTN001). **Dos módulos, un expediente.**
 *
 * ── Quién puede qué ──────────────────────────────────────────────────────────────────────────
 *  · **Mercadotecnia** — `MKT_AGREEMENTS_GESTIONAR` levanta, edita, autoriza y cierra. Es la
 *    única clave que ve el **dinero** de la negociación.
 *  · **Consulta** — `MKT_AGREEMENTS_VER` abre el tablero. El alcance decide qué plazas.
 *  · **Plaza** — `MKT_AGREEMENT_EVIDENCE_SUBIR` sube la foto de SU sucursal. No crea, no autoriza
 *    y no ve el monto.
 *
 * ── `verDinero` se decide acá, no en la pantalla ─────────────────────────────────────────────
 * El servicio recibe un booleano explícito y **omite las claves de dinero** cuando es `false`.
 * Filtrarlo con un `*ngIf` dejaría `monto` viajando en el JSON, y ese JSON se abre con F12. Por
 * eso el controller lee `req.user.permissions` y lo pasa: es el único lugar que conoce al usuario.
 *
 * ── El alcance NO se resuelve acá ────────────────────────────────────────────────────────────
 * Vive en el servicio (`ScopeService`, ADR-050) porque es una decisión sobre FILAS, no sobre
 * rutas. Un guard sólo sabe si la puerta se abre; no sabe qué hay del otro lado.
 */
@ApiTags('commercial-promo-agreements')
@ApiBearerAuth()
@UseGuards(RolesGuard)
@Controller('commercial/promo-agreements')
export class PromoAgreementsController {
  constructor(private readonly service: PromoAgreementsService) {}

  /** ¿Este usuario puede ver el dinero negociado? Sólo quien gestiona los acuerdos. */
  private verDinero(req: { user?: { permissions?: Record<string, boolean> | string[] } }): boolean {
    const p = req?.user?.permissions;
    if (!p) return false;
    // El mapa viaja como objeto (`{CLAVE: true}`) en el JWT; se acepta también la forma de lista
    // por si algún emisor viejo la manda, en vez de asumir una sola y fallar abierto.
    if (Array.isArray(p)) return p.includes(Permission.MKT_AGREEMENTS_GESTIONAR);
    return p[Permission.MKT_AGREEMENTS_GESTIONAR] === true;
  }

  // ── TABLERO (Mercadotecnia) ───────────────────────────────────────────────────────────────

  @Get()
  // `anyOf`: el encargado de plaza entra con la clave de evidencia. Si el gate fuera sólo VER,
  // vería el menú apagado y no podría trabajar su propio expediente.
  @RequireAnyPermission(Permission.MKT_AGREEMENTS_VER, Permission.MKT_AGREEMENT_EVIDENCE_SUBIR)
  @ApiOperation({
    summary: 'Acuerdos con proveedor, con la cobertura del expediente',
    description:
      'El alcance recorta las filas: Mercadotecnia ve las once plazas, la plaza ve sólo los ' +
      'acuerdos donde participa. El monto negociado sólo viaja con MKT_AGREEMENTS_GESTIONAR.',
  })
  listar(@Req() req: AuthedRequest, @Query('status') status?: AgreementStatus): ReturnType<PromoAgreementsService['listar']> {
    return this.service.listar({ status, verDinero: this.verDinero(req) });
  }

  @Get('resumen')
  @RequireAnyPermission(Permission.MKT_AGREEMENTS_VER, Permission.MKT_AGREEMENT_EVIDENCE_SUBIR)
  @ApiOperation({ summary: 'KPIs del tablero (cobertura de expedientes; el monto sólo si se puede ver)' })
  resumen(@Req() req: AuthedRequest): ReturnType<PromoAgreementsService['resumen']> {
    return this.service.resumen(this.verDinero(req));
  }

  // ── PLAZA ─────────────────────────────────────────────────────────────────────────────────

  @Get('sucursal/:code')
  @RequireAnyPermission(Permission.MKT_AGREEMENT_EVIDENCE_SUBIR, Permission.MKT_AGREEMENTS_VER)
  @ApiOperation({
    summary: 'Lo que corre en una plaza, con su expediente',
    description: 'La sucursal viaja explícita y se valida contra el alcance: pedir otra da 403.',
  })
  porSucursal(@Param('code') code: string): ReturnType<PromoAgreementsService['listarPorSucursal']> {
    return this.service.listarPorSucursal(code);
  }

  @Post('canales/:channelId/evidencia')
  @RequirePermissions(Permission.MKT_AGREEMENT_EVIDENCE_SUBIR)
  @ApiOperation({ summary: 'Subir evidencia de ejecución al expediente de esa plaza' })
  subirEvidencia(
    @Req() req: AuthedRequest,
    @Param('channelId') channelId: string,
    @Body() dto: { file_name: string; file_url: string; mime_type?: string; size_bytes?: number; nota?: string; kind?: FileKind },
  ): ReturnType<PromoAgreementsService['subirEvidencia']> {
    return this.service.subirEvidencia(channelId, dto, {
      id: req?.user?.id,
      username: req?.user?.username,
    });
  }

  @Delete('evidencia/:fileId')
  @RequirePermissions(Permission.MKT_AGREEMENT_EVIDENCE_SUBIR)
  @ApiOperation({ summary: 'Quitar una pieza de evidencia (baja lógica; recalcula la cobertura)' })
  quitarEvidencia(@Param('fileId') fileId: string): ReturnType<PromoAgreementsService['quitarEvidencia']> {
    return this.service.quitarEvidencia(fileId);
  }

  // ── EXPEDIENTE ────────────────────────────────────────────────────────────────────────────

  @Get(':id')
  @RequireAnyPermission(Permission.MKT_AGREEMENTS_VER, Permission.MKT_AGREEMENT_EVIDENCE_SUBIR)
  @ApiOperation({
    summary: 'Expediente completo: carátula, códigos, canales y archivos',
    description: 'La plaza recibe sólo su canal; si el acuerdo no toca ninguna de sus plazas, 404.',
  })
  obtener(@Req() req: AuthedRequest, @Param('id') id: string): ReturnType<PromoAgreementsService['obtener']> {
    return this.service.obtener(id, this.verDinero(req));
  }

  // ── ALTA Y CICLO DE VIDA (Mercadotecnia) ──────────────────────────────────────────────────

  @Post()
  @RequirePermissions(Permission.MKT_AGREEMENTS_GESTIONAR)
  @ApiOperation({ summary: 'Levantar el formato MKTN001 (nace en borrador, sin folio)' })
  crear(@Req() req: AuthedRequest, @Body() dto: CrearAcuerdoDto): ReturnType<PromoAgreementsService['crear']> {
    return this.service.crear(dto, { id: req?.user?.id, username: req?.user?.username });
  }

  @Patch(':id/canales')
  @RequirePermissions(Permission.MKT_AGREEMENTS_GESTIONAR)
  @ApiOperation({
    summary: 'Fijar los canales participantes (abre un expediente por cada uno)',
    description: 'Sólo en borrador, y nunca sobre un canal que ya subió evidencia.',
  })
  fijarCanales(@Param('id') id: string, @Body() dto: { canales: CanalDto[] }): ReturnType<PromoAgreementsService['fijarCanales']> {
    return this.service.fijarCanales(id, dto?.canales ?? []);
  }

  @Post(':id/autorizar')
  @RequirePermissions(Permission.MKT_AGREEMENTS_GESTIONAR)
  @ApiOperation({
    summary: 'Autorizar: asigna folio y lo vuelve un compromiso',
    description: 'Exige al menos un canal participante. El folio se genera SÓLO acá (patrón TP.8).',
  })
  autorizar(@Req() req: AuthedRequest, @Param('id') id: string): ReturnType<PromoAgreementsService['autorizar']> {
    return this.service.autorizar(id, { id: req?.user?.id, username: req?.user?.username });
  }

  @Patch(':id/estado')
  @RequirePermissions(Permission.MKT_AGREEMENTS_GESTIONAR)
  @ApiOperation({ summary: 'Mover el estado: vigente · cerrado · cancelado' })
  cambiarEstado(@Param('id') id: string, @Body() dto: { status: AgreementStatus }): ReturnType<PromoAgreementsService['cambiarEstado']> {
    return this.service.cambiarEstado(id, dto?.status);
  }
}
