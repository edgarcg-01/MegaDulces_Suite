import { Module } from '@nestjs/common';
import { HrAttendanceIngestController } from './attendance/attendance-ingest.controller';
import { HrAttendanceIngestService } from './attendance/attendance-ingest.service';
import { HrIngestGuard } from './attendance/hr-ingest.guard';

/**
 * Fase RH (ADR-084) — Recursos Humanos dentro de la Suite.
 *
 * Por ahora trae sólo la entrada de checadas de los relojes (`[RH.1.2]`). Las reglas de
 * asistencia, incidencias y cierres (`[RH.1.5]`/`[RH.1.6]`) y las pantallas (`[RH.1.7]`)
 * se suman aquí. No tiene permisos todavía: lo único expuesto es la entrada de máquina a
 * máquina, protegida por llave.
 */
@Module({
  controllers: [HrAttendanceIngestController],
  providers: [HrAttendanceIngestService, HrIngestGuard],
  exports: [HrAttendanceIngestService],
})
export class HrModule {}
