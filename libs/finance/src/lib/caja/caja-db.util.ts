import type { Knex } from 'knex';

/**
 * `[CGP-L.6]` ¿Existe esta tabla o vista? Se PREGUNTA antes de leer algo que puede no estar todavía
 * (código desplegado antes que su migración).
 *
 * ⛔ El atajo era leer dentro de un `try { … } catch {}`. Dentro de una transacción eso no sirve: el
 * error deja la transacción ABORTADA (`25P02`) y la consulta siguiente revienta igual — en la bandeja
 * de caja, la que medía la frescura de CAOS. Además el `catch` vacío se tragaba también un permiso
 * negado o una columna mal escrita, que deben verse. `to_regclass` no falla: devuelve `null`.
 */
export async function relacionExiste(trx: Knex | Knex.Transaction, nombreCalificado: string): Promise<boolean> {
  const r = await trx.raw('SELECT to_regclass(?) AS t', [nombreCalificado]);
  return Boolean(r.rows?.[0]?.t);
}
