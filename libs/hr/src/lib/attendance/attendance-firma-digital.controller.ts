import { Body, Controller, Get, Headers, HttpCode, Param, ParseUUIDPipe, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Permission, RequireAnyPermission, RequirePermissions, RolesGuard } from '@megadulces/platform-core';
import type {
  HrAnularFirmaDigitalBody, HrExpedienteFirmasDto, HrGenerarLigasFirmaBody, HrHojaFirmasDto, HrLigasFirmaDto,
} from '@megadulces/contracts';
import { HrAttendanceFirmaDigitalService } from './attendance-firma-digital.service';

/** Mismo conjunto que `VER_FIRMAS` del controlador de firmas: quien ve los cierres ve las firmas. */
const VER_FIRMAS = [
  Permission.HR_ATTENDANCE_VER, Permission.HR_INCIDENTS_CAPTURAR, Permission.HR_INCIDENTS_CALIFICAR,
  Permission.HR_INCIDENTS_AUDITAR, Permission.HR_PERIOD_CLOSE,
];

/**
 * Fase RH · `[RH.15.11]` — La firma desde el celular, lado de RH: generar los QR, la hoja del departamento (PDF), el
 * comprobante de cada firma, el expediente de la persona y anular. Controlador propio (no un parámetro más en uno que ya
 * corre: #414). Con las llaves de los cierres; sin permiso nuevo.
 */
@ApiTags('hr')
@ApiBearerAuth()
@UseGuards(RolesGuard)
@Controller('hr/attendance/signoffs/digital')
export class HrAttendanceFirmaDigitalController {
  constructor(private readonly firma: HrAttendanceFirmaDigitalService) {}

  @Post('links')
  @HttpCode(200)
  @RequirePermissions(Permission.HR_PERIOD_CLOSE)
  @ApiOperation({ summary: 'RH — genera los QR de un departamento para firmar la semana en el celular (72 h, un uso).' })
  generar(@Body() b: HrGenerarLigasFirmaBody, @Headers('origin') origin?: string): Promise<HrLigasFirmaDto> {
    return this.firma.generar(b, origin);
  }

  @Get('sheet')
  @RequireAnyPermission(...VER_FIRMAS)
  @ApiOperation({ summary: 'RH — la hoja de un departamento con todas sus firmas de la versión vigente (para el PDF).' })
  hoja(@Query() q: { site_code?: string; period_start?: string; department?: string }): Promise<HrHojaFirmasDto> {
    return this.firma.hoja(q);
  }

  @Get('person')
  @RequireAnyPermission(...VER_FIRMAS)
  @ApiOperation({ summary: 'RH — las semanas que firmó una persona (celular o papel): por user_id (todas sus plazas) o por plaza + número.' })
  expediente(@Query() q: { site_code?: string; person_code?: string; user_id?: string }): Promise<HrExpedienteFirmasDto> {
    return this.firma.expediente(q);
  }

  @Get('signatures/:id/file')
  @RequireAnyPermission(...VER_FIRMAS)
  @ApiOperation({ summary: 'RH — liga temporal para ver el trazo de una persona.' })
  archivo(@Param('id', new ParseUUIDPipe()) id: string): Promise<{ url: string }> {
    return this.firma.archivoFirma(id);
  }

  @Get('signatures/:id/receipt')
  @RequireAnyPermission(...VER_FIRMAS)
  @ApiOperation({ summary: 'RH — el comprobante de una firma: la semana exacta que se firmó, el trazo, hora, IP y navegador.' })
  comprobante(@Param('id', new ParseUUIDPipe()) id: string): Promise<HrHojaFirmasDto> {
    return this.firma.comprobante(id);
  }

  @Post('signatures/:id/void')
  @HttpCode(200)
  @RequirePermissions(Permission.HR_PERIOD_CLOSE)
  @ApiOperation({ summary: 'RH — anula una firma del celular con motivo (no se borra). La persona puede volver a firmar con otro QR.' })
  anular(@Param('id', new ParseUUIDPipe()) id: string, @Body() b: HrAnularFirmaDigitalBody): Promise<{ ok: true }> {
    return this.firma.anular(id, b?.motivo);
  }
}
