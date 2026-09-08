import { Knex } from 'knex';

/**
 * Ejecuta SQL con placeholders NATIVOS de Postgres ($1, $2, ...) a través de
 * `knex.raw()` — que en realidad sólo entiende su propia convención `?` para
 * bindings posicionales (`replaceRawArrBindings`: cuenta cada `?` literal del
 * SQL y exige que coincida con `bindings.length`, sin distinguir un placeholder
 * de un `?` que aparezca por cualquier otra razón).
 *
 * El proyecto origen (`megadulces-api-ready`) usaba `pg.Pool` puro, donde `$1`
 * es la sintaxis nativa del protocolo y un mismo `$1` se puede repetir tantas
 * veces como haga falta. Al portar esas consultas a `knex.raw(sql, params)` dos
 * cosas rompían la cuenta: (1) cualquier `$N` nativo con bindings reales —knex
 * busca `?`, no encuentra ninguno—; (2) los guardas numéricos usan `?` como
 * cuantificador POSIX, que knex cuenta como placeholder. Por eso los guardas de
 * `kp.service.ts` usan `{0,1}` en vez de `?`.
 *
 * Esta función traduce el `$N` nativo a `?`, EXPANDIENDO cada repetición: si
 * `$1` aparece 7 veces, produce 7 `?` con el mismo valor duplicado — mismo
 * efecto que pg nativo, sin tocar el texto de las consultas portadas.
 */
export async function pgRaw<T = any>(
  db: Knex,
  sql: string,
  params?: any[],
): Promise<T[]> {
  const valores = params ?? [];
  const bindings: any[] = [];
  const traducido = sql.replace(/\$(\d+)\b/g, (_match, n) => {
    bindings.push(valores[Number(n) - 1]);
    return '?';
  });
  const r = await db.raw(traducido, bindings);
  return r.rows as T[];
}
