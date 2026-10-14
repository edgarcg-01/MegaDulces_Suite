import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { AnthropicService, CloudinaryModule, SpeechToTextService, jwtVerifyOptions, requireJwtSecret } from '@megadulces/platform-core';
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
import { HrTalentController } from './talent/talent.controller';
import { HrTalentCandidatesService } from './talent/talent-candidates.service';
import { HrTalentJobsService } from './talent/talent-jobs.service';
import { HrTalentIntakeService } from './talent/talent-intake.service';
import { HrTalentPublicController } from './talent/talent-public.controller';
import { HrTalentLinksService } from './talent/talent-links.service';
import { HrRecruitmentBotService } from './talent/bot/recruitment-bot.service';
import { HrRecruitmentInterpreterService } from './talent/bot/interprete-registro.service';
import { HrCvValidatorService } from './talent/bot/validar-cv.service';

/**
 * Fase RH (ADR-084) — Recursos Humanos dentro de la Suite.
 *
 *   · `[RH.1.2]` la entrada de checadas de los relojes (máquina a máquina, por llave, también con
 *     las rutas del agente de Mega Talento) y la administración de los relojes y sus órdenes;
 *   · `[RH.1.5]` horarios deducidos, la asistencia por persona y el agente de alertas (`@Cron`
 *     en el worker, apagado hasta el corte: `ENABLE_HR_ATTENDANCE_AGENT`);
 *   · `[RH.1.6]` incidencias (6 estados, separación de funciones) y el cierre semanal;
 *   · `[RH.2.2]` reclutamiento: candidatos (etapas, eventos, marcas, papelera, fusión) y vacantes;
 *   · `[RH.2.4]` la bolsa de trabajo pública (vacantes y postulación, con las reglas de `logic/postulacion.ts`).
 *
 * Las pantallas son `[RH.1.7]`. Las claves `HR_*` gatean la API desde ya y se reparten con ellas.
 */
@Module({
  // `CloudinaryModule` exporta `ObjectStorageService`: el bucket PRIVADO de los expedientes de reclutamiento.
  // `JwtModule` local para las LIGAS de candidatos, con un secreto DERIVADO: una liga nunca vale como sesión de
  // usuario ni una sesión como liga, aunque las dos sean JWT (ver `talent-links.service.ts`).
  imports: [
    CloudinaryModule,
    JwtModule.register({
      secret: `${requireJwtSecret()}:talent-link`,
      signOptions: { algorithm: 'HS256' },
      verifyOptions: jwtVerifyOptions,
    }),
  ],
  controllers: [HrAttendanceIngestController, HrAttendanceMtCompatController, HrAttendanceController, HrAttendanceDevicesController, HrTalentController, HrTalentPublicController],
  providers: [
    HrAttendanceIngestService, HrIngestGuard,
    HrAttendanceAgentService, HrAttendanceAlertsService, HrAttendanceReportService,
    HrAttendanceIncidentsService, HrAttendanceClosuresService, HrAttendanceSchedulesService, HrAttendanceDevicesService,
    HrTalentCandidatesService, HrTalentJobsService, HrTalentIntakeService, HrTalentLinksService, HrRecruitmentBotService,
    // `[RH.3.2.1]` la IA del registro por WhatsApp, sobre el cliente compartido de Anthropic (infra leaf: cada módulo
    // que lo usa lo pone en sus providers). Sin `ANTHROPIC_API_KEY` no consulta nada y el registro sigue igual.
    AnthropicService, HrRecruitmentInterpreterService,
    // `[RH.3.3.1]` las notas de voz del registro (Groq Whisper compartido). Sin `GROQ_API_KEY` se le pide que escriba.
    SpeechToTextService,
    // `[RH.3.3.2]` revisa con visión que el CV lo sea (sin clave, acepta y marca para revisión).
    HrCvValidatorService,
  ],
  // `[RH.3.1]` HrRecruitmentBotService se exporta para el binding de RECRUITMENT_BOT_PORT (composition root).
  exports: [HrAttendanceIngestService, HrAttendanceReportService, HrRecruitmentBotService],
})
export class HrModule {}
