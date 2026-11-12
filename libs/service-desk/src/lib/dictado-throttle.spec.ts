import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * `[MS.DICTADO]` El tope del dictado EXISTE de verdad.
 *
 * `ThrottlerModule.forRoot` (apps/api/src/app.module.ts) arma sus tiers con `LIMITADORES` (platform-core, desde
 * RH.1.3 el 2026-11-11): tres con NOMBRE, `short`, `medium` y `long`. El guard lee, por cada tier configurado, la
 * metadata `THROTTLER:LIMIT<nombre>`: un `@Throttle({ default: … })` guarda `THROTTLER:LIMITdefault`, que **ningún tier lee** — no da error, no avisa, y el tope no existe. Medido el
 * 2026-10-16: mi primera versión de `transcribe` decía «20 por minuto» y no limitaba nada (sólo valía el global de
 * 200/min por IP) sobre un servicio de pago por uso.
 *
 * Se lee el TEXTO del controlador, del módulo de la app y de `LIMITADORES` (importar el controlador arrastra
 * `platform-core`, que exige `JWT_SECRET` al cargarse; y un import relativo entre libs lo prohíbe la frontera de Nx).
 */
const leer = (ruta: string): string => readFileSync(join(__dirname, ruta), 'utf8');
const CONTROLADOR = leer('service-desk.controller.ts');
const APP_MODULE = leer('../../../../apps/api/src/app.module.ts');
const LIMITADORES_TS = leer('../../../platform-core/src/lib/decorators/limites-de-peticiones.ts');

/** Los nombres de tier que usan los `@Throttle({ <nombre>: … })` de un texto. */
const nombresUsados = (texto: string): string[] => [...texto.matchAll(/@Throttle\(\{\s*(\w+)\s*:/g)].map((m) => m[1]);
/** ¿`app.module` arma el ThrottlerModule con `LIMITADORES`? Sólo entonces sus nombres son los que lee el guard. */
const armaConLimitadores = (texto: string): boolean => /ThrottlerModule\.forRoot\(\{[\s\S]*?throttlers:\s*LIMITADORES\b/.test(texto);
/** Los nombres que declara `export const LIMITADORES = [ { name: '…', ttl: … }, … ]`. */
const nombresDeLimitadores = (texto: string): string[] => {
  const bloque = /export const LIMITADORES = \[([\s\S]*?)\] as const;/.exec(texto)?.[1] ?? '';
  return [...bloque.matchAll(/\{\s*name:\s*'(\w+)'\s*,\s*ttl:/g)].map((m) => m[1]);
};
/** Los tiers que el servidor realmente configura (vacío si el módulo dejó de armarse con `LIMITADORES`). */
const tiersConfigurados = (appModule: string): string[] => (armaConLimitadores(appModule) ? nombresDeLimitadores(LIMITADORES_TS) : []);

describe('[MS.DICTADO] tope de /service-desk/transcribe', () => {
  it('app.module arma el ThrottlerModule con LIMITADORES (si deja de hacerlo, este spec ya no sabe qué tiers lee el guard)', () => {
    expect(armaConLimitadores(APP_MODULE)).toBe(true);
    // CONTROL: con los tiers escritos a mano en el módulo, el detector dice que no.
    expect(armaConLimitadores(APP_MODULE.replace(/throttlers:\s*LIMITADORES/, "throttlers: [{ name: 'otro', ttl: 1, limit: 1 }]"))).toBe(false);
  });

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
