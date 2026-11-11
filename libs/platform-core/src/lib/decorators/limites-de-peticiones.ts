/**
 * Los limitadores de peticiones de la API (`ThrottlerModule`, por IP) y la exención que los cubre a TODOS.
 *
 * ⛔ `@SkipThrottle()` SIN argumentos exenta sólo al limitador llamado `default` (`{ default: true }`), y la API no tiene
 * ninguno con ese nombre: sus tres se llaman `short`, `medium` y `long`. Medido el 2026-11-11 al encender el lector de
 * relojes en `md`: las dos entradas de checadas llevaban `@SkipThrottle()` y aun así contestaban **429** al primer
 * respaldo (60 mil checadas de un reloj, en lotes de 500). La exención nunca había funcionado; en la laptop no se notaba
 * porque el lector mandaba a Mega Talento, no a la Suite.
 *
 * Por eso los nombres viven aquí, UNA vez: `app.module` arma el `ThrottlerModule` con `LIMITADORES` y quien necesite
 * saltarlos usa `@SkipThrottle(SIN_LIMITE_DE_PETICIONES)`. Un limitador nuevo entra solo en la exención.
 */
export const LIMITADORES = [
  { name: 'short', ttl: 1000, limit: 10 },     // 10 req/seg
  { name: 'medium', ttl: 10_000, limit: 60 },  // 60 req/10 seg
  { name: 'long', ttl: 60_000, limit: 200 },   // 200 req/min
] as const;

/** Para `@SkipThrottle(...)`: todos los limitadores de `LIMITADORES` (y `default`, por si alguno lo usa). */
export const SIN_LIMITE_DE_PETICIONES: Record<string, boolean> = Object.fromEntries([
  ['default', true],
  ...LIMITADORES.map((l) => [l.name, true] as const),
]);
