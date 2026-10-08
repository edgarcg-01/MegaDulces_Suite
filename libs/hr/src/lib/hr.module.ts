import { Module } from '@nestjs/common';
import { HrAttendanceIngestController, HrAttendanceMtCompatController } from './attendance/attendance-ingest.controller';
import { HrAttendanceDevicesController } from './attendance/attendance-devices.controller';
import { HrAttendanceDevicesService } from './attendance/attendance-devices.service';
import { HrAttendanceIngestService } from './attendance/attendance-ingest.service';
import { HrIngestGuard } from './attendance/hr-ingest.guard';
import { HrAttendanceController } from './attendance/attendance.controller';
import { HrAttendanceAgentService } from './attendance/attendance-agent.service';
import { HrAttendanceAlertsService } from './attendance/attendance-alerts.service';
import { HrAttendanceReportService } from './attendance/attendance-report.service';
import { HrAttendanceIncidentsService } from './attendance/attendance-incidents.service';
import { HrAttendanceClosuresService } from './attendance/attendance-closures.service';
import { HrAttendanceSchedulesService } from './attendance/attendance-schedules.service';

/**
 * Fase RH (ADR-084) — Recursos Humanos dentro de la Suite.
 *
 *   · `[RH.1.2]` la entrada de checadas de los relojes (máquina a máquina, por llave, también con
 *     las rutas del agente de Mega Talento) y la administración de los relojes y sus órdenes;
 *   · `[RH.1.5]` horarios deducidos, la asistencia por persona y el agente de alertas (`@Cron`
 *     en el worker, apagado hasta el corte: `ENABLE_HR_ATTENDANCE_AGENT`);
 *   · `[RH.1.6]` incidencias (6 estados, separación de funciones) y el cierre semanal.
 *
 * Las pantallas son `[RH.1.7]`. Las claves `HR_*` gatean la API desde ya y se reparten con ellas.
 */
@Module({
  controllers: [HrAttendanceIngestController, HrAttendanceMtCompatController, HrAttendanceController, HrAttendanceDevicesController],
  providers: [
    HrAttendanceIngestService, HrIngestGuard,
    HrAttendanceAgentService, HrAttendanceAlertsService, HrAttendanceReportService,
    HrAttendanceIncidentsService, HrAttendanceClosuresService, HrAttendanceSchedulesService, HrAttendanceDevicesService,
  ],
  exports: [HrAttendanceIngestService, HrAttendanceReportService],
})
export class HrModule {}
