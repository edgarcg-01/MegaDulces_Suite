import { Knex } from 'knex';

/**
 * Ejecuta SQL con placeholders NATIVOS de Postgres ($1, $2, ...) a través de
 * `knex.raw()` — que en realidad sólo entiende su propia convención `?` para
 * bindings posicionales (ver `node_modules/knex/lib/formatter/rawFormatter.js`,
 * `replaceRawArrBindings`: cuenta cada `?` literal del SQL y exige que
 * coincida con `bindings.length`, sin distinguir un placeholder de un `?`
 * que aparezca por cualquier otra razón).
 *
 * Encontrado en producción (CV.6, 2026-09-02): el proyecto origen usa
 * `pg.Pool` puro, donde `$1` es la sintaxis nativa del protocolo y un mismo
 * `$1` se puede repetir tantas veces como haga falta. Al portar esas mismas
 * consultas tal cual a `knex.raw(sql, params)`, dos cosas rompían la cuenta
 * sin que ninguna prueba con DB inalcanzable lo detectara (la conexión
 * fallaba antes de llegar a formatear el SQL):
 *   1. Cualquier `$N` nativo con bindings reales: knex busca `?`, no
 *      encuentra ninguno, y truena "Expected N bindings, saw 0".
 *   2. Los guardas numéricos (`RE_NUM`/`COSTO`/`NUM`) meten `?` LITERALES en
 *      el SQL como cuantificador POSIX ("-?", "(...)?") — knex los cuenta
 *      como placeholders propios. `getPrecio` truena "Expected 1, saw 18"
 *      porque `COLS_PRECIO` llama 9 veces a `NUMC_NULL`, cada una con 2 `?`.
 *
 * La solución NO es escapar esos `?` con `\?`: knex los deja como `\?`
 * literales en el SQL final, y Postgres interpreta eso como "el caracter
 * `?` literal" en vez de "el atomo anterior es opcional" — cambia el
 * significado de la regex. La solución real, en las constantes de guarda,
 * es no usar `?` para nada: `{0,1}` es equivalente en POSIX/Postgres y no
 * colisiona con nada (ver kp.service.ts, catalogo.service.ts,
 * tienda.service.ts, pedidos.service.ts).
 *
 * Esta función traduce el `$N` nativo a `?`, EXPANDIENDO cada repetición:
 * si `$1` aparece 7 veces, produce 7 `?` con el mismo valor duplicado 7
 * veces en el arreglo de bindings — mismo efecto que pg nativo, sin tocar
 * el texto de las consultas portadas.
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
