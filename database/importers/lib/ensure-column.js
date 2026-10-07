/**
 * [VP.2.2] `ADD COLUMN IF NOT EXISTS` sin pedir un lock que no hace falta.
 *
 * ── EL INCIDENTE QUE ESTE HELPER EXISTE PARA QUE NO VUELVA ───────────────────────────────
 * El 2026-09-08, con un `pg_dump` corriendo 53 minutos sobre prod, **8 de 10 sesiones activas
 * estaban esperando un lock** y un feed llevaba **18 minutos bloqueado** en su propia consulta
 * (`SELECT max(computed_at) FROM analytics.contpaqi_bank_movements`).
 *
 * La causa raíz era el dump —sostiene un snapshot y congela todo el DDL— pero el **amplificador**
 * eran dos importers de ContPAQi que arrancaban cada pasada con:
 *
 *     ALTER TABLE analytics.contpaqi_bank_movements ADD COLUMN IF NOT EXISTS src_row_version bigint
 *     ALTER TABLE analytics.gl_polizas              ADD COLUMN IF NOT EXISTS src_sig         bigint
 *
 * ⚠️ **`ADD COLUMN IF NOT EXISTS` toma ACCESS EXCLUSIVE ANTES de descubrir que no hay nada que
 * hacer.** El `IF NOT EXISTS` evita el error, no el lock. Con la base libre eso es invisible: el
 * no-op dura microsegundos. Detrás de una transacción larga, cada pasada del cron encola otro
 * ACCESS EXCLUSIVE — y en Postgres un lock exclusivo EN ESPERA bloquea a **todo lector posterior**
 * de esa tabla. Seis pasadas después, el importer estaba bloqueando su propio feed.
 *
 * ── LA CORRECCIÓN ────────────────────────────────────────────────────────────────────────
 * Preguntar primero. `information_schema.columns` es un SELECT sobre el catálogo: no toma ningún
 * lock sobre la tabla. Si la columna está —el 100% de las pasadas después de la primera— el
 * importer no pide nada. Si falta, se hace el `ALTER` igual, así que la auto-curación se conserva
 * intacta: es estrictamente MENOS trabajo, nunca menos capacidad.
 *
 * No es una carrera que importe: si dos procesos entran a la vez y la columna falta, los dos
 * corren el `ALTER … IF NOT EXISTS` y el segundo es un no-op. Lo que se evita es el caso normal,
 * que es el que se repite miles de veces.
 */

/**
 * Se asegura de que `schema.tabla.columna` exista, **sin pedir ACCESS EXCLUSIVE si ya está**.
 *
 * @param {{query: Function}} cli  cliente `pg` ya conectado
 * @param {string} tabla           nombre de la tabla (sin schema)
 * @param {string} columna         nombre de la columna
 * @param {string} tipo            tipo SQL, p. ej. `'bigint'`
 * @param {string} [schema]        schema, por defecto `analytics`
 * @returns {Promise<boolean>}     `true` si la creó, `false` si ya estaba
 */
async function asegurarColumna(cli, tabla, columna, tipo, schema = 'analytics') {
  // Identificadores de código, nunca de entrada de usuario — pero se validan igual: interpolar es
  // la única forma de escribir un DDL, y la validación que se da por obvia es la que no está.
  for (const [k, v] of Object.entries({ schema, tabla, columna })) {
    if (!/^[a-z_][a-z0-9_]*$/.test(v)) throw new Error(`asegurarColumna: ${k} inválido (${v})`);
  }
  if (!/^[a-z0-9 _()]+$/i.test(tipo)) throw new Error(`asegurarColumna: tipo inválido (${tipo})`);

  const { rows } = await cli.query(
    `SELECT 1 FROM information_schema.columns
      WHERE table_schema = $1 AND table_name = $2 AND column_name = $3`,
    [schema, tabla, columna],
  );
  if (rows.length) return false; // el caso normal: cero locks

  // eslint-disable-next-line no-console
  console.log(`  [ensure-column] falta ${schema}.${tabla}.${columna} — se agrega (${tipo}).`);
  await cli.query(`ALTER TABLE ${schema}.${tabla} ADD COLUMN IF NOT EXISTS ${columna} ${tipo}`);
  return true;
}

module.exports = { asegurarColumna };
