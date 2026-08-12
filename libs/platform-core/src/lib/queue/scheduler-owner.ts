/**
 * ¿Este proceso debe correr los `@Cron` in-process? (INFRA.3, ADR-043)
 *
 * Regla del worker-tier — poner al inicio del cuerpo de cada `@Cron` que se
 * migra al worker:
 *
 *   @Cron('0 0 3 * * *')
 *   async run() {
 *     if (!shouldRunInProcessCron()) return;   // el worker lo corre, el API no
 *     ...
 *   }
 *
 * - Worker-tier OFF (default, `ENABLE_WORKER_QUEUE` != 'true'): devuelve true →
 *   el cron corre en el API como siempre. CERO cambio de conducta.
 * - Worker-tier ON: solo el proceso `WORKER=true` corre el cron; el API lo
 *   saltea → deja de duplicarse al escalar el API horizontal y sale del path web.
 */
export function shouldRunInProcessCron(): boolean {
  if (process.env.ENABLE_WORKER_QUEUE !== 'true') return true;
  return process.env.WORKER === 'true';
}
