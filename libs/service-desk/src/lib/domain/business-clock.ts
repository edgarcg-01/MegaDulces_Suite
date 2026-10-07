/**
 * `[MS.3.8]` El reloj hábil vive ahora en `libs/contracts` (`work/business-clock.ts`): la bandeja «sin asignar»
 * de Mi trabajo, en `libs/trade`, necesita medir la espera en horas hábiles y `trade` no puede importar esta
 * lib. Se re-exporta acá para que nada de lo que ya importaba `./business-clock` tenga que cambiar.
 */
export {
  MINUTE_MS,
  addBusinessMinutes,
  addClockMinutes,
  businessMinutesBetween,
  clockMinutesBetween,
  esHorarioHabil,
  instantFromLocal,
  localParts,
  parseHHMM,
  validarCalendario,
} from '@megadulces/contracts';
export type { BusinessCalendar, ClockKind } from '@megadulces/contracts';
