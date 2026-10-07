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
 * ## ⚠️ Este helper NO nació de un problema medido de rendimiento. La primera versión decía que sí
 *
 * La afirmación original era: «hoy corren dos instancias y se bloquean entre sí; un UPDATE de una
 * fila por PK cuesta 0.501 ms aislado y 197.8 ms en prod». **Era falsa**, y la corrección vale más
 * que el dato. Lo que la refutó, en orden:
 *
 *   1. El SELECT interno del scanner mide **1,804 llamadas/hora**, y 150 por corrida × 12
 *      corridas/hora = **1,800**. Eso es UN escáner. Con dos serían ~3,600.
 *   2. Railway reporta **una** réplica.
 *   3. Capturando una corrida real (296 muestras en 120 s): la consulta aparece **una vez y sin
 *      ninguna espera**.
 *   4. Y el error de método propio: la medición «aislada» se hizo como `postgres`, que es
 *      superusuario y **saltea la RLS** de una tabla con RLS forzada. Rehecha con
 *      `SET ROLE app_runtime` da 0.216 ms — la RLS tampoco era la causa.
 *
 * Lo que de verdad pasaba: la media de 197.8 ms es un **artefacto de saturación del contenedor**.
 * Mínimo 0.08 ms, máximo 3,884 ms, desviación 440 sobre media 198 (CV 2.22) → episódico. Y es
 * global: de 293 consultas con más de 500 llamadas, **234 tienen la desviación por encima de su
 * media** y **93 son normalmente sub-milisegundo con picos de segundos**.
 * `UPDATE pgboss.version SET flow_on = now()` va de **0.01 ms a 21,691 ms**.
 *
 * ⭐ **La lección, que aplica a cualquier medición futura:** en un servidor saturado,
 * `mean_exec_time` le atribuye la saturación a lo que estuviera corriendo. Leer la media como
 * «esta consulta es lenta» es confundir el síntoma con la causa. Lo que discrimina es
 * `min_exec_time` (el costo real, sin competencia) y el CV (si es parejo o episódico).
 *
 * ## Entonces, ¿para qué queda esto?
 *
 * Para el riesgo que el repo ya declara y que sigue vigente: **no hay leader election en ningún
 * lado**. Hoy hay una instancia y no duele; el día que haya dos, los 50 crons sin guard corren
 * duplicados — y ahí el problema no es el costo sino el **efecto duplicado** (borrar imágenes en
 * Cloudinary, llamar al SAT o al PAC, mandar avisos). Esto es una red para ese día, no una
 * optimización de hoy.
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
