import 'reflect-metadata';
import { LIMITADORES, SIN_LIMITE_DE_PETICIONES } from '@megadulces/platform-core';
import { HrAttendanceIngestController, HrAttendanceMtCompatController } from './attendance-ingest.controller';

/**
 * `[RH.1.3]` La entrada de checadas NO pasa por el limitador de peticiones. Medido el 2026-11-11 al encender el lector
 * en `md`: `@SkipThrottle()` sin argumentos sólo exentaba al limitador `default`, que la API no tiene, y el primer
 * respaldo de un reloj (60 mil checadas en lotes de 500) se topó con 429. Esto lee la MISMA marca que lee el
 * `ThrottlerGuard` (`THROTTLER:SKIP<nombre>`), por cada limitador que arma `app.module`.
 */
const SALTA = 'THROTTLER:SKIP';

describe('[RH.1.3] la entrada de checadas salta TODOS los limitadores de la API', () => {
  for (const Ctrl of [HrAttendanceIngestController, HrAttendanceMtCompatController]) {
    it(`${Ctrl.name}: exento en ${LIMITADORES.map((l) => l.name).join(', ')}`, () => {
      for (const { name } of LIMITADORES) expect(Reflect.getMetadata(SALTA + name, Ctrl), name).toBe(true);
    });
  }

  it('⛔ la trampa: el valor por omisión de @SkipThrottle() sólo cubre «default», que no es ninguno de la API', () => {
    expect(LIMITADORES.map((l) => l.name)).not.toContain('default');
    for (const { name } of LIMITADORES) expect(SIN_LIMITE_DE_PETICIONES[name]).toBe(true);
  });
});
