/**
 * `[CG.41]` La pestaña Conciliación tardaba **825 ms**, y la culpa era de una sola pierna.
 *
 * ── El gate
 *
 * Edgar, 2026-10-06: *«una consulta de más de 500 milisegundos no funciona»*. El umbral venía de
 * 1 s y baja a **500 ms**.
 *
 * ── Lo medido, contra prod, con la ventana real de cada pantalla
 *
 * De las **14 consultas** que respaldan `/finanzas/caja-general` (las 10 del `ngOnInit` más las
 * pestañas), **12 pasan holgadas**: la bandeja de pendientes 6 ms, el saldo 1 ms, los cortes 1 ms,
 * las cajas 1 ms, el arqueo del día 111 ms, el libro del mes 120 ms. El `ngOnInit` entero cabe en
 * el presupuesto.
 *
 * La que no: **la pestaña Conciliación, 825 ms**, que son cuatro consultas `await` seguidas dentro
 * de la misma transacción de tenant — caja 1 ms, workbook 2 ms, ContPAQi 43 ms y **Kepler 663 ms**.
 * O sea: **el 80 % del tiempo de la pestaña es una sola pierna**, y las otras tres juntas no llegan
 * a 50 ms. No se puede paralelizar: las cuatro comparten la conexión de `tk.run()`.
 *
 * ⚠️ **Y una retractación, porque la primera medición fue mía y estaba mal.** También marqué
 * `analytics.v_caja_doc_contracuenta` en 663 ms — con un `SELECT * ... LIMIT 200` **que nadie
 * corre**. El servicio la usa con `whereIn(['sucursal','tipo_pol','folio'], ...)` sobre una página
 * de ~100 documentos: **32 ms**, que es justo lo que su propio comentario ya decía. *Medir una
 * consulta parecida no mide nada.*
 *
 * ── La causa, leída en el plan y no supuesta
 *
 * `analytics.kepler_bank_movements` es una **vista viva**. Su CTE `flj` se referencia **dos veces**
 * (el `UNION ALL` que arma las dos piernas del traspaso), y un CTE usado más de una vez Postgres lo
 * **MATERIALIZA**. Materializado = el filtro de fecha del consumidor **no puede bajar** al scan.
 *
 * El plan lo dice con todas sus letras: `Seq Scan on kdm1` leyendo **666,026 filas** (1,772 ms,
 * 61,200 buffers) para que, arriba, el `CTE Scan on flj` tire 50,561 por el filtro de fecha y
 * entregue **103**. Se lee media tabla de 552 MB para devolver cien renglones.
 *
 * Y no hay índice que la salve hoy: `ix_kdm1_venta_fecha` existe sobre `((c9)::date)` pero es
 * **parcial a ventas** (`c2='U' AND c3='D'`), y tesorería es `U-A-5`, `X-D-26`, `X-D-25`, `X-D-60`,
 * `X-D-10`, `X-A-45`, `U-A-25`, `N-A-26` — ninguna cae ahí.
 *
 * ── Por qué DOS cambios y no uno (los dos se midieron por separado)
 *
 *   · **Sólo reescribir la forma** (bajar el filtro al scan, a mano): 697 → **475 ms**. Pasa el
 *     gate raspando y sigue siendo un seq scan. No alcanza.
 *   · **Sólo el índice**, sin tocar el CTE: **no sirve de nada**, porque con `flj` materializado
 *     el scan no tiene predicado de fecha que buscar.
 *
 * Hacen falta los dos, y en este orden de razonamiento: `NOT MATERIALIZED` abre la puerta para que
 * el predicado baje, y el índice es lo que lo vuelve barato.
 *
 * ── El índice, y por qué LIDERA CON LA FECHA (la primera versión de esto estaba mal)
 *
 * El índice obvio sería `(btrim(c45), (c9::date))`. **Se probó y el planner no lo habría tocado**:
 * las claves de banco salen de una **subconsulta** sobre `kdb1`, así que el `IN` se resuelve como
 * *hash semi join*, y un hash semi join necesita escanear la relación externa. Medido forzando
 * `enable_seqscan = off`: sigue en **Parallel Seq Scan, 61,206 buffers, 513 ms**. Un índice que el
 * planner no elige es un índice que no existe — con el costo de mantenerlo en cada INSERT.
 *
 * Lo que sí puede usar es un índice **sobre la fecha**, porque ahí el predicado es un rango de
 * literales, con la condición de banco movida al **WHERE parcial**:
 *
 *     ON kepler_ods.kdm1 (((c9)::date))  WHERE btrim(COALESCE(c45,'')) <> ''
 *
 * El rango de fechas entra por el índice y deja ~200 filas; sobre ésas se evalúan el semijoin de
 * `c45` y el `btrim(c1) = sucursal` —que es **columna contra columna** y por eso ningún índice
 * puede resolverlo, sólo filtrarlo barato una vez que el universo ya es chico—.
 *
 * Dimensionado: de las **725,871** filas de `kdm1`, sólo **58,210 (8.0 %)** traen clave de banco →
 * el índice parcial guarda eso, no la tabla entera; y del mes en curso son **210**.
 *
 * ⭐ Que esta forma funciona en ESTA tabla está **comprobado, no supuesto**: `ix_kdm1_venta_fecha`
 * es exactamente esta forma (`((c9)::date)` + WHERE parcial) y el planner la elige — **Index Scan,
 * 2,825 buffers, 87 ms para 19,516 filas**, contra los 61,200 buffers del seq scan.
 *
 * ⚠️ **Lo que NO se pudo medir, y se declara:** el efecto exacto de este índice. Crearlo exige DDL
 * sobre prod y desde la máquina donde se escribió esto el rol es de sólo lectura. La proyección se
 * apoya en el índice de ventas de arriba, que resuelve **19,516 filas en 87 ms**; acá el objetivo
 * es **210**, dos órdenes de magnitud menos. El candado de `[CG.40]` mide el resultado real cuando
 * esto se aplique: si no baja de 500 ms, se pone rojo.
 *
 * ⚠️ `CONCURRENTLY` y por eso `transaction: false`: son 552 MB y no se le corta la escritura al
 * CDC, que entra cada minuto. Tarda más que un `CREATE INDEX` normal — es el precio de no bloquear.
 *
 * ── Alcance: esto NO es sólo de Caja General
 *
 * `analytics.kepler_bank_movements` la leen **9 archivos** (Bancos, Caja, CAOS, comprobantes de
 * pago, el escáner de feeds, `db-health`) y encima **`analytics.mv_caja_movimientos` se reconstruye
 * desde ella**. Abaratarla abarata también ese refresco.
 *
 * ⛔ `NOT MATERIALIZED` **no cambia ningún resultado**: es una instrucción de PLAN, no de
 * semántica. Lo que sí hay que cuidar es que `flj` ahora se evalúa dos veces en vez de una — con
 * el índice, dos accesos baratos salen mucho más a cuenta que un escaneo completo.
 */

// `CREATE INDEX CONCURRENTLY` no corre dentro de una transacción.
exports.config = { transaction: false };

const IDX = 'ix_kdm1_tesoreria_fecha';
const VISTA = 'analytics.kepler_bank_movements';

/** El marcador que se reescribe. Si cambia de forma, la migración DEBE fallar, no pasar de largo. */
const MARCA = ', flj AS (';
const MARCA_NUEVA = ', flj AS NOT MATERIALIZED (';

/**
 * Reescribe la vista a partir de su definición VIVA en vez de transcribir 140 líneas a mano.
 * Transcribirlas es como se cuela un typo en una vista que leen nueve archivos.
 */
async function reescribirFlj(knex, desde, hacia) {
  const { rows } = await knex.raw(`SELECT pg_get_viewdef(?::regclass, true) AS d`, [VISTA]);
  const def = rows[0].d;

  // ⛔ Falla RUIDOSA. Un `replace` que no encuentra su marca devuelve el texto igual y el
  // `CREATE OR REPLACE` queda en no-op: la migración diría "listo" sin haber cambiado nada, y el
  // candado de rendimiento se pondría rojo sin que nadie supiera por qué.
  if (!def.includes(desde)) {
    throw new Error(
      `[CG.41] No encontré "${desde.trim()}" en la definición viva de ${VISTA}. `
      + 'La vista cambió de forma desde que se escribió esta migración: revisá el CTE flj a mano '
      + 'antes de seguir. NO se tocó nada.');
  }
  if (def.includes(hacia)) return false; // ya estaba

  await knex.raw(`CREATE OR REPLACE VIEW ${VISTA} AS ${def.replace(desde, hacia)}`);
  // El GRANT se re-aplica explícito: esta casa ya perdió uno en un `CREATE OR REPLACE` y sólo lo
  // vio una aserción de metadata.
  await knex.raw(`GRANT SELECT ON ${VISTA} TO app_runtime`);
  return true;
}

exports.up = async function up(knex) {
  // 1 · El índice. `IF NOT EXISTS` para que re-correr la migración no truene.
  // ⛔ La FECHA va primero y la condición de banco va al WHERE parcial. Al revés el planner no lo
  // usa: las claves de `c45` vienen de una subconsulta (hash semi join) y eso obliga a escanear.
  await knex.raw(`
    CREATE INDEX CONCURRENTLY IF NOT EXISTS ${IDX}
        ON kepler_ods.kdm1 (((c9)::date))
     WHERE btrim(COALESCE(c45, '')) <> ''`);

  // ⚠️ `CONCURRENTLY` puede dejar el índice INVÁLIDO si falla a la mitad, y un índice inválido no
  // se usa — o sea, la pantalla seguiría lenta y la migración habría dicho que todo bien.
  const { rows } = await knex.raw(
    `SELECT i.indisvalid FROM pg_class c JOIN pg_index i ON i.indexrelid = c.oid
      WHERE c.relname = ?`, [IDX]);
  if (!rows.length || !rows[0].indisvalid) {
    throw new Error(`[CG.41] ${IDX} quedó INVÁLIDO (CONCURRENTLY falló a la mitad). `
      + `Hay que hacer DROP INDEX CONCURRENTLY ${IDX} y volver a correr esta migración.`);
  }

  await knex.raw(`COMMENT ON INDEX kepler_ods.${IDX} IS ?`, [
    '[CG.41] Fecha de los movimientos de TESORERIA (parcial: solo los que traen clave de banco en '
    + 'c45 = 58,210 de 725,871 filas). Sin el, analytics.kepler_bank_movements hace seq scan de '
    + '666k filas para devolver ~100 y la pestana Conciliacion tarda 825 ms. LIDERA CON LA FECHA a '
    + 'proposito: un indice que empiece por c45 el planner NO lo usa, porque las claves vienen de '
    + 'una subconsulta sobre kdb1 y eso se resuelve como hash semi join (medido: sigue en seq scan '
    + 'aun con enable_seqscan=off). Va junto con el CTE flj en NOT MATERIALIZED: con flj '
    + 'materializado el predicado de fecha no baja al scan y este indice no se usa.',
  ]);

  // 2 · Que el predicado pueda bajar al scan.
  await reescribirFlj(knex, MARCA, MARCA_NUEVA);
};

exports.down = async function down(knex) {
  await reescribirFlj(knex, MARCA_NUEVA, MARCA);
  await knex.raw(`DROP INDEX CONCURRENTLY IF EXISTS kepler_ods.${IDX}`);
};
