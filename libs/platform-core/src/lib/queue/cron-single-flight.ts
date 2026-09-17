/**
 * [DB-MEM.17] Candado de UNA corrida entre PROCESOS, no dentro de uno.
 *
 * ## Por qué existe
 *
 * Los `@Cron` de este repo se protegen con un `private running = false`. Eso evita que el mismo
 * proceso se pise a sí mismo, y no sirve para nada cuando hay dos instancias del API: cada una
 * tiene su propia variable. `app.module.ts` ya lo dice con todas las letras — *"cada cron tiene
 * su `isRunning` en memoria, que no sirve entre procesos: no hay leader election en ningún lado"*.
 *
 * Y `shouldRunInProcessCron()` no cubre esto: devuelve `true` salvo que `ENABLE_WORKER_QUEUE`
 * valga exactamente `'true'`, así que con la configuración de hoy es un no-op.
 *
 * ## Lo que costaba, medido en prod (2026-09-17)
 *
 * `FleetAlertsScannerService` corre cada 5 min en **las dos** instancias, recorre los mismos 50
 * rastreadores en el mismo orden y escribe las mismas filas, todo dentro de UNA transacción —
 * o sea que cada fila queda bloqueada hasta que esa transacción entera termina. La segunda
 * instancia se queda esperando:
 *
 *   UPDATE de una fila por PK, sin competencia .....   0.501 ms
 *   la MISMA forma, en produccion .................. 197.800 ms   (395x)
 *   INSERT ......................................... 429.800 ms
 *
 * Total: 94,789 llamadas en 49.8 h = **0.587 % del tiempo de ejecución de toda la base**, para
 * 50 rastreadores y una tabla de 4 MB. No estaba trabajando: estaba esperándose a sí mismo.
 *
 * ## Por qué un candado de TRANSACCIÓN y no de sesión
 *
 * `pg_try_advisory_xact_lock` se suelta solo al terminar la transacción — commit, rollback, o el
 * proceso muriéndose. Un `pg_advisory_lock` de sesión hay que soltarlo a mano, y si el proceso
 * se cae con el candado tomado, el cron queda **apagado hasta que esa conexión se recicle**. Un
 * candado que puede quedarse trabado es peor que no tener candado: falla en silencio y hacia el
 * lado inseguro.
 *
 * ⚠️ Esto NO reemplaza al `running` en memoria: aquél ahorra el viaje a la base. Van juntos.
 *
 * ⚠️ Y NO es una cola: el que no toma el candado **se saltea esta corrida**, no la encola. Para
 * un cron periódico eso es lo correcto (en 5 minutos vuelve); para trabajo que no puede perderse,
 * esto no alcanza.
 */

import { Knex } from 'knex';

/**
 * Intenta tomar el candado de `clave` dentro de la transacción `trx`.
 *
 * @returns `true` si lo tomó (hay que seguir), `false` si otra instancia lo tiene (hay que salir).
 *
 * @example
 *   return this.tk.run(tenantId, async (trx) => {
 *     if (!(await tomarCandadoDeCron(trx, 'fleet_alerts_scan'))) return SIN_HACER_NADA;
 *     ...
 *   });
 */
export async function tomarCandadoDeCron(trx: Knex.Transaction | Knex, clave: string): Promise<boolean> {
  // `hashtext` es estable dentro de una misma versión mayor de Postgres, que es todo lo que hace
  // falta: las dos instancias que compiten corren contra la MISMA base. No se persiste en ningún
  // lado, así que un cambio de hash entre versiones no rompe datos — a lo sumo, durante un upgrade
  // con versiones mixtas, dos procesos podrían tomar candados distintos y correr los dos. Es
  // exactamente lo que pasa hoy, todo el tiempo.
  const r = await trx.raw(`SELECT pg_try_advisory_xact_lock(hashtext(?)) AS tomado`, [clave]);
  return r.rows?.[0]?.tomado === true;
}
