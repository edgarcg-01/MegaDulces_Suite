import { Body, Controller, Get, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Permission, RequireAnyPermission, RequirePermissions, RolesGuard } from '@megadulces/platform-core';
import type {
  HrCandidatoEdicion, HrCandidatoEventoDto, HrCasilleroDto, HrDocumentoNuevo, HrLigaCreadaDto, HrCandidatoEventoNuevo, HrCandidatoFichaDto, HrCandidatosListaDto,
  HrDuplicadoGrupoDto, HrFusionResultadoDto, HrReingresoAlertaDto, HrTiempoPorEtapaDto, HrVacanteDto, HrVacanteEdicion,
  HrPedirDocumentos, HrPedirDocumentosResultadoDto,
} from '@megadulces/contracts';
import { HrTalentCandidatesService } from './talent-candidates.service';
import { HrTalentJobsService } from './talent-jobs.service';
import { HrTalentLinksService } from './talent-links.service';
import { HrDocumentRequestService } from './bot/pedir-documentos.service';

/**
 * Fase RH · `[RH.2.2]` — la API de reclutamiento para RH (con sesión). Lo público —el formulario
 * de postulación y las evaluaciones que se le mandan al candidato— es `[RH.2.4]`, con token firmado.
 *
 * Dos claves: VER (leer candidatos y vacantes) y GESTIONAR (mover, marcar, fusionar, papelera,
 * vacantes). GESTIONAR también lee: quien mueve a alguien de etapa necesita verlo. Se reparten
 * con las pantallas (`[RH.2.3]`); mientras, `SIN_REPARTIR` del candado de reparto.
 *
 * ⚠️ El orden importa: las rutas fijas (`duplicates`, `rehire-alerts`, `stage-times`) van ANTES de
 * `:id` — la trampa que Mega Talento ya vivió dos veces.
 */
const VER = [Permission.HR_RECRUITMENT_VER, Permission.HR_RECRUITMENT_GESTIONAR];

@ApiTags('hr')
@ApiBearerAuth()
@UseGuards(RolesGuard)
@Controller('hr/talent')
export class HrTalentController {
  constructor(
    private readonly candidates: HrTalentCandidatesService,
    private readonly jobs: HrTalentJobsService,
    private readonly links: HrTalentLinksService,
    private readonly documentos: HrDocumentRequestService,
  ) {}

  // ── Candidatos: lectura ──────────────────────────────────────────────────────────────────

  @Get('candidates')
  @RequireAnyPermission(...VER)
  @ApiOperation({ summary: 'RH — candidatos de un apartado (postulados, en_proceso, spam, no_recontratables, papelera).' })
  listar(@Query() q: { view?: string; stage?: string; branch?: string; q?: string; limit?: string; offset?: string }): Promise<HrCandidatosListaDto> {
    return this.candidates.listar({ ...q, limit: Number(q.limit) || undefined, offset: Number(q.offset) || undefined });
  }

  @Get('candidates/duplicates')
  @RequireAnyPermission(...VER)
  @ApiOperation({ summary: 'RH — registros vivos con el mismo teléfono (para fusionar).' })
  duplicados(): Promise<HrDuplicadoGrupoDto[]> {
    return this.candidates.duplicados();
  }

  @Get('candidates/rehire-alerts')
  @RequireAnyPermission(...VER)
  @ApiOperation({ summary: 'RH — quién se volvió a postular teniendo el teléfono de alguien no recontratable.' })
  reingresos(): Promise<HrReingresoAlertaDto[]> {
    return this.candidates.reingresos();
  }

  @Get('candidates/stage-times')
  @RequireAnyPermission(...VER)
  @ApiOperation({ summary: 'RH — tiempo promedio por etapa (desde la bitácora de etapas).' })
  tiempoPorEtapa(): Promise<{ fases: HrTiempoPorEtapaDto[]; total: number }> {
    return this.candidates.tiempoPorEtapa();
  }

  @Get('candidates/document-slots')
  @RequireAnyPermission(...VER)
  @ApiOperation({ summary: 'RH — los casilleros del expediente (los mismos del bot).' })
  casilleros(): readonly HrCasilleroDto[] {
    return this.candidates.casilleros();
  }

  @Get('candidates/:id')
  @RequireAnyPermission(...VER)
  @ApiOperation({ summary: 'RH — la ficha de un candidato con su historia (y la de los registros que absorbió).' })
  ficha(@Param('id') id: string): Promise<HrCandidatoFichaDto> {
    return this.candidates.ficha(id);
  }

  // ── Candidatos: escritura ────────────────────────────────────────────────────────────────

  @Patch('candidates/:id')
  @RequirePermissions(Permission.HR_RECRUITMENT_GESTIONAR)
  @ApiOperation({ summary: 'RH — corregir nombre, teléfono, correo, plaza, puesto o vacante.' })
  editar(@Param('id') id: string, @Body() b: HrCandidatoEdicion): Promise<HrCandidatoFichaDto> {
    return this.candidates.editar(id, b);
  }

  @Post('candidates/:id/stage')
  @RequirePermissions(Permission.HR_RECRUITMENT_GESTIONAR)
  @ApiOperation({ summary: 'RH — mover de etapa (deja el paso con las horas en la etapa anterior).' })
  moverEtapa(@Param('id') id: string, @Body() b: { stage?: string }): Promise<HrCandidatoFichaDto> {
    return this.candidates.moverEtapa(id, b?.stage);
  }

  @Post('candidates/:id/events')
  @RequirePermissions(Permission.HR_RECRUITMENT_GESTIONAR)
  @ApiOperation({ summary: 'RH — registrar contacto, entrevista, contratación o nota.' })
  evento(@Param('id') id: string, @Body() b: HrCandidatoEventoNuevo): Promise<HrCandidatoEventoDto> {
    return this.candidates.registrarEvento(id, b);
  }

  @Post('candidates/:id/no-rehire')
  @RequirePermissions(Permission.HR_RECRUITMENT_GESTIONAR)
  @ApiOperation({ summary: 'RH — marcar (motivo obligatorio) o desmarcar como no recontratable.' })
  noRecontratable(@Param('id') id: string, @Body() b: { mark?: boolean; reason?: string }): Promise<HrCandidatoFichaDto> {
    return this.candidates.marcarNoRecontratable(id, b);
  }

  @Post('candidates/:id/spam')
  @RequirePermissions(Permission.HR_RECRUITMENT_GESTIONAR)
  @ApiOperation({ summary: 'RH — marcar o desmarcar como spam.' })
  spam(@Param('id') id: string, @Body() b: { mark?: boolean; reason?: string }): Promise<HrCandidatoFichaDto> {
    return this.candidates.marcarSpam(id, b);
  }

  @Post('candidates/:id/trash')
  @RequirePermissions(Permission.HR_RECRUITMENT_GESTIONAR)
  @ApiOperation({ summary: 'RH — a la papelera (manual o cierre de seguimiento). Nada se borra.' })
  papelera(@Param('id') id: string, @Body() b: { reason?: string }): Promise<HrCandidatoFichaDto> {
    return this.candidates.aPapelera(id, b);
  }

  @Post('candidates/:id/restore')
  @RequirePermissions(Permission.HR_RECRUITMENT_GESTIONAR)
  @ApiOperation({ summary: 'RH — sacar de la papelera (si estaba fusionado, deshace la fusión).' })
  restaurar(@Param('id') id: string): Promise<HrCandidatoFichaDto> {
    return this.candidates.restaurar(id);
  }

  @Post('candidates/:id/documents')
  @RequirePermissions(Permission.HR_RECRUITMENT_GESTIONAR)
  @ApiOperation({ summary: 'RH — subir un documento al expediente (bucket privado; PDF o imagen, máx. 10 MB).' })
  subirDocumento(@Param('id') id: string, @Body() b: HrDocumentoNuevo): Promise<HrCandidatoFichaDto> {
    return this.candidates.subirDocumento(id, b);
  }

  @Post('candidates/:id/documents/retire')
  @RequirePermissions(Permission.HR_RECRUITMENT_GESTIONAR)
  @ApiOperation({ summary: 'RH — retirar un documento (con motivo). No se borra.' })
  retirarDocumento(@Param('id') id: string, @Body() b: { llave?: string; reason?: string }): Promise<HrCandidatoFichaDto> {
    return this.candidates.retirarDocumento(id, b);
  }

  @Post('candidates/:id/documents/request')
  @RequirePermissions(Permission.HR_RECRUITMENT_GESTIONAR)
  @ApiOperation({ summary: 'RH — pedirle sus documentos por WhatsApp (la lista queda registrada; el mensaje sale sólo dentro de la ventana de 24 h).' })
  pedirDocumentos(@Param('id') id: string, @Body() b: HrPedirDocumentos): Promise<HrPedirDocumentosResultadoDto> {
    const slots = Array.isArray(b?.slots) ? b.slots.filter((s): s is string => typeof s === 'string') : null;
    return this.documentos.pedir(id, slots);
  }

  @Post('candidates/:id/links')
  @RequirePermissions(Permission.HR_RECRUITMENT_GESTIONAR)
  @ApiOperation({ summary: 'RH — generar una liga personal (subir el CV o el cuestionario de liderazgo) que vence en 7 días.' })
  crearLiga(@Param('id') id: string, @Body() b: { form?: string }, @Req() req: { headers?: Record<string, string | undefined> }): Promise<HrLigaCreadaDto> {
    return this.links.crear(id, b?.form ?? 'cv', req?.headers?.['origin']);
  }

  @Post('candidates/:id/merge')
  @RequirePermissions(Permission.HR_RECRUITMENT_GESTIONAR)
  @ApiOperation({ summary: 'RH — fusionar otro registro de la misma persona en éste (rellena huecos, no pisa).' })
  fusionar(@Param('id') id: string, @Body() b: { absorb_id?: string }): Promise<HrFusionResultadoDto> {
    return this.candidates.fusionar(id, String(b?.absorb_id ?? ''));
  }

  // ── Vacantes ─────────────────────────────────────────────────────────────────────────────

  @Get('jobs')
  @RequireAnyPermission(...VER)
  @ApiOperation({ summary: 'RH — vacantes (`?active=true|false`).' })
  vacantes(@Query('active') active?: string): Promise<HrVacanteDto[]> {
    return this.jobs.listar({ active });
  }

  @Post('jobs')
  @RequirePermissions(Permission.HR_RECRUITMENT_GESTIONAR)
  @ApiOperation({ summary: 'RH — publicar una vacante.' })
  crearVacante(@Body() b: HrVacanteEdicion): Promise<HrVacanteDto> {
    return this.jobs.crear(b);
  }

  @Patch('jobs/:id')
  @RequirePermissions(Permission.HR_RECRUITMENT_GESTIONAR)
  @ApiOperation({ summary: 'RH — editar o desactivar una vacante (no se borran).' })
  editarVacante(@Param('id') id: string, @Body() b: HrVacanteEdicion): Promise<HrVacanteDto> {
    return this.jobs.editar(id, b);
  }
}
