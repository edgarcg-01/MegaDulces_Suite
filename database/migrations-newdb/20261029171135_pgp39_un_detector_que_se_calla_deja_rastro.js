/**
 * [PGP.39] Un detector que se calla tiene que dejar RASTRO, no un `logger.warn`.
 *
 * ## El caso
 *
 * Buscando por que el pronto pago no se aprovecha aparecio que `finance.findings` tiene la regla
 * `descuento_no_capturado` con **98 hallazgos por $5,363,294, los 98 sin triar**, y que **no
 * produce desde el 2026-08-29** -- 61 dias al 2026-10-29.
 *
 * ⚠️ La primera lectura fue equivocada y queda escrita para que nadie la repita: *"el motor de
 * hallazgos esta muerto"*. **No lo esta.** Medido contra prod (sid 7688376744939610156):
 * `finance.findings` tiene **163,420 filas**, el feed nocturno reescribio **6,028 anoche**, y
 * **13 reglas tienen `last_seen` de HOY**. El error fue ordenar por antiguedad y leer el peor
 * tramo como si fuera el todo.
 *
 * Lo que SI pasa, medido regla por regla:
 *
 *   | estado                | reglas | hallazgos |
 *   |-----------------------|-------:|----------:|
 *   | VIVO (<= 2 dias)      |     13 |   160,834 |
 *   | tibio (3-30 dias)     |      7 |       539 |
 *   | **MUDO (> 30 dias)**  | **24** | **2,047** |
 *
 * Y **21 de las 24 se callaron el MISMO dia (2026-09-15)**: no son 21 fallas independientes, es
 * un corte unico que nadie vio.
 *
 * ## Por que fue invisible
 *
 * `maat-detector.service.ts` saltea el detector que falla con un `logger.warn` y un `continue`.
 * Como `finance.findings` **conserva los hallazgos viejos**, la bandeja se ve igual de llena: un
 * detector parado es indistinguible de un detector sin hallazgos nuevos. Es el mismo patron que
 * el repo ya tiene nombrado para las matvistas -- *"una MV parada se ve VERDE (OBS.1)"*- y la
 * misma ley del proyecto: **lo que no se pudo medir se DECLARA, nunca se dibuja como verde**
 * (ADR-056).
 *
 * ## Que hace esta migracion
 *
 * Le da a `finance.rule_registry` las cuatro columnas que convierten el silencio en un dato
 * consultable. **No cambia ningun detector ni ningun hallazgo**: solo abre el lugar donde el
 * scanner va a dejar su rastro.
 *
 *   - `last_run_at`   cuando se INTENTO por ultima vez (aunque fallara)
 *   - `last_ok_at`    cuando termino bien por ultima vez
 *   - `last_error`    el mensaje del ultimo fallo (NULL si el ultimo intento salio bien)
 *   - `last_error_at` cuando fue ese fallo
 *
 * ⛔ Nacen en NULL a proposito, y NULL significa **"nunca se midio"**, no "nunca corrio". Ponerles
 * `now()` al crearlas dibujaria 75 reglas como recien ejecutadas, que es exactamente la mentira
 * que esto viene a cerrar.
 *
 * Idempotente (`hasColumn` antes de `addColumn`), sin tablas nuevas y sin copiar nada.
 */

const TABLA = 'finance.rule_registry';

/** Las cuatro columnas, con su tipo. Una sola lista: el `up` y el `down` leen de aca. */
const COLUMNAS = [
  ['last_run_at', 'timestamptz'],
  ['last_ok_at', 'timestamptz'],
  ['last_error', 'text'],
  ['last_error_at', 'timestamptz'],
];

const COMENTARIOS = [
  [`${TABLA}.last_run_at`,
    'PGP.39 - Cuando se INTENTO correr este detector por ultima vez, haya salido bien o mal. NULL = nunca se midio, que NO es lo mismo que nunca corrio.'],
  [`${TABLA}.last_ok_at`,
    'PGP.39 - Cuando este detector termino bien por ultima vez. Si esta muy atras de last_run_at, el detector viene fallando: su bandeja se ve llena con hallazgos viejos y no produce nuevos.'],
  [`${TABLA}.last_error`,
    'PGP.39 - Mensaje del ultimo fallo. NULL si el ultimo intento salio bien. Antes esto era un logger.warn que no dejaba rastro consultable y por eso 24 de 44 reglas llevaban 44-98 dias mudas sin que nadie lo supiera.'],
  [`${TABLA}.last_error_at`, 'PGP.39 - Cuando ocurrio el fallo que describe last_error.'],
];

exports.up = async function up(knex) {
  const antes = (await knex(TABLA).count('* as n'))[0];

  for (const [col, tipo] of COLUMNAS) {
    if (!(await knex.schema.withSchema('finance').hasColumn('rule_registry', col))) {
      await knex.raw(`ALTER TABLE ${TABLA} ADD COLUMN ${col} ${tipo}`);
    }
  }
  for (const [obj, txt] of COMENTARIOS) {
    await knex.raw(`COMMENT ON COLUMN ${obj} IS ?`, [txt]);
  }

  // ── Controles ───────────────────────────────────────────────────────────────────────────
  // 1 · Las cuatro tienen que existir. (Sin aplicar: 0.)
  const { rows: cols } = await knex.raw(
    `SELECT count(*)::int AS n FROM information_schema.columns
      WHERE table_schema = 'finance' AND table_name = 'rule_registry'
        AND column_name = ANY(?)`,
    [COLUMNAS.map(([c]) => c)],
  );
  if (Number(cols[0].n) !== COLUMNAS.length) {
    throw new Error(`[PGP.39] se esperaban ${COLUMNAS.length} columnas nuevas y hay ${cols[0].n}. Se revierte.`);
  }

  // 2 · No se toca ninguna regla: el universo tiene que ser el mismo.
  const despues = (await knex(TABLA).count('* as n'))[0];
  if (Number(antes.n) !== Number(despues.n)) {
    throw new Error(`[PGP.39] las reglas pasaron de ${antes.n} a ${despues.n}. Esta migracion no debe tocar ninguna; se revierte.`);
  }

  // 3 · Y nacen en NULL: una sola con fecha seria una regla dibujada como medida.
  const { rows: sembradas } = await knex.raw(
    `SELECT count(*)::int AS n FROM ${TABLA}
      WHERE last_run_at IS NOT NULL OR last_ok_at IS NOT NULL OR last_error_at IS NOT NULL`,
  );
  if (Number(sembradas[0].n) > 0) {
    throw new Error(`[PGP.39] ${sembradas[0].n} reglas nacieron con fecha. NULL significa "nunca se midio"; se revierte.`);
  }

  console.log(`[PGP.39] ${despues.n} reglas con rastro de ejecucion (last_run_at · last_ok_at · last_error · last_error_at), todas en NULL = sin medir.`);
};

exports.down = async function down(knex) {
  for (const [col] of COLUMNAS) {
    if (await knex.schema.withSchema('finance').hasColumn('rule_registry', col)) {
      await knex.raw(`ALTER TABLE ${TABLA} DROP COLUMN ${col}`);
    }
  }
};

exports.SQL = { TABLA, COLUMNAS };
