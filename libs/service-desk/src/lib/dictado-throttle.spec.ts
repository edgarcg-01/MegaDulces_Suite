import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * `[MS.DICTADO]` El tope del dictado EXISTE de verdad.
 *
 * `ThrottlerModule.forRoot` (apps/api/src/app.module.ts) declara tres tiers con NOMBRE: `short`, `medium` y
 * `long`. El guard lee, por cada tier configurado, la metadata `THROTTLER:LIMIT<nombre>`: un `@Throttle({ default: … })`
 * guarda `THROTTLER:LIMITdefault`, que **ningún tier lee** — no da error, no avisa, y el tope no existe. Medido el
 * 2026-10-16: mi primera versión de `transcribe` decía «20 por minuto» y no limitaba nada (sólo valía el global de
 * 200/min por IP) sobre un servicio de pago por uso.
 *
 * Se lee el TEXTO del controlador y del módulo de la app (importar el controlador arrastra `platform-core`, que
 * exige `JWT_SECRET` al cargarse).
 */
const leer = (ruta: string): string => readFileSync(join(__dirname, ruta), 'utf8');
const CONTROLADOR = leer('service-desk.controller.ts');
const APP_MODULE = readFileSync(join(__dirname, '../../../../apps/api/src/app.module.ts'), 'utf8');

/** Los nombres de tier que usan los `@Throttle({ <nombre>: … })` de un texto. */
const nombresUsados = (texto: string): string[] => [...texto.matchAll(/@Throttle\(\{\s*(\w+)\s*:/g)].map((m) => m[1]);
/** Los tiers que el servidor realmente configura. */
const tiersConfigurados = (texto: string): string[] => [...texto.matchAll(/\{\s*name:\s*'(\w+)'\s*,\s*ttl:/g)].map((m) => m[1]);

describe('[MS.DICTADO] tope de /service-desk/transcribe', () => {
  it('los tiers configurados son los que se esperan (si cambian, hay que revisar los @Throttle)', () => {
    expect(tiersConfigurados(APP_MODULE)).toEqual(['short', 'medium', 'long']);
  });

  it('⭐ el endpoint de dictado limita en un tier que el servidor LEE, con 20 por minuto', () => {
    expect(CONTROLADOR).toMatch(/@Throttle\(\{ long: \{ limit: 20, ttl: 60_000 \} \}\)\s*\n\s*@ApiOperation\(\{ summary: 'Dictado/);
  });

  it('⛔ NEGATIVA — ningún @Throttle del controlador usa un nombre de tier que no existe', () => {
    const validos = tiersConfigurados(APP_MODULE);
    expect(nombresUsados(CONTROLADOR).length).toBeGreaterThan(0); // no es vacua
    for (const n of nombresUsados(CONTROLADOR)) expect(validos, `@Throttle usa el tier «${n}»`).toContain(n);
  });

  it('CONTROL — el detector SÍ marca la forma que no limitaba nada (`default`)', () => {
    const malo = "@Throttle({ default: { limit: 20, ttl: 60_000 } })";
    expect(nombresUsados(malo)).toEqual(['default']);
    expect(tiersConfigurados(APP_MODULE)).not.toContain('default');
  });
});
