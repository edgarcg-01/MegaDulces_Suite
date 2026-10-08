'use strict';
/**
 * `[CG.67]` — **La firma de conformidad del movimiento de caja**, pedida por Edgar: *"necesito
 * que anejemos una firma digital… para que pueda firmar e imprimir su ticket digital"*.
 *
 * ── Lo medido antes (sólo lectura) ──────────────────────────────────────────────────────────
 *  · `finance.cash_ledger` tiene **2 movimientos en toda su historia** (medido esta sesión), así
 *    que el relleno retroactivo toca 2 filas. No es una columna que haya que poblar en masa.
 *  · El ticket térmico de esta pantalla YA imprime el renglón `"Recibi conforme (nombre y
 *    firma)"` (`ticket-comprobante.ts`): hoy la firma existe, en papel y con lapicera. Esto la
 *    vuelve dato.
 *  · El primitivo que dibuja la firma YA existe y es compartido (`[CG.66]`,
 *    `libs/ui-web/src/firma/`), extraído del componente del repartidor.
 *
 * ── ⭐⭐ CUATRO estados, y los cuatro son hechos distintos ───────────────────────────────────
 *
 * La tentación es un booleano `firmado`, y miente en tres de los cuatro casos. ADR-056: *las dos
 * ausencias no son la misma* — acá son **tres**:
 *
 *   `firmado`   la firma está, con nombre y hora.
 *   `sin_firma` es un movimiento que la PEDÍA y se guardó sin ella. Es el único que alguien
 *               tiene que ir a resolver, y por eso no se puede confundir con los otros dos.
 *   `no_aplica` nunca se pidió: un ingreso lo respalda el documento del ERP que tiene detrás, y
 *               un depósito lo respalda la ficha del banco (que Fase CC ya guarda aparte). Pedir
 *               una firma ahí sería pedir que el banco firme.
 *   `previo`    el movimiento es ANTERIOR al mecanismo. ⛔ Es el estado que casi no puse, y
 *               ponerlo es lo que mantiene a `sin_firma` significando algo: sin él, las filas
 *               viejas entrarían como «falta la firma» y acusarían retroactivamente a gente que
 *               no tenía dónde firmar. Un incumplimiento inventado por una migración.
 *
 * ⚠️ **El estado lo decide el SERVIDOR, nunca el cliente** (ADR-076). La pantalla manda la imagen
 * y el nombre; `firma_estado` se calcula del lado del servicio. Si el cliente pudiera mandarlo,
 * podría declarar `firmado` sin imagen — o sea firmar por otro.
 *
 * ── ⚠️ La imagen va EN LA FILA, y hay que decir por qué y hasta cuándo ───────────────────────
 *
 * Existe `ObjectStorageService.putBuffer()` (lo usa Mesa de Servicio para imágenes, probado
 * contra un S3 real) y sería el lugar "correcto". No se usa todavía por dos razones medidas:
 *   1. Las env `S3_*` **no están configuradas en producción** (es parte de lo pendiente de Fase
 *      MS). Con almacenamiento de objetos, la firma no tendría dónde ir el día uno.
 *   2. La firma del repartidor **ya vive en la fila** (`delivery_stops.signature_url`, un data
 *      URI) y está en producción. Un segundo patrón para el mismo dato cuesta más que el disco.
 *
 * ⛔ El techo queda escrito: un PNG de firma de un canvas chico pesa ~3-15 KB. La columna **no
 * debe entrar en ningún `SELECT *` de lista** — se lee sólo al abrir el comprobante. Si el libro
 * pasa a traerla por renglón, el día que haya 5,000 movimientos/mes la lista arrastra ~50 MB.
 * Cuando `S3_*` exista, esto se muda a `putBuffer` y la columna guarda la llave.
 *
 * Idempotente.
 *
 * @param { import("knex").Knex } knex
 */

const COLS = ['firma_png', 'firma_nombre', 'firma_at', 'firma_estado'];

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);

  const tiene = async (c) => knex.schema.withSchema('finance').hasColumn('cash_ledger', c);

  if (!(await tiene('firma_png'))) {
    await knex.raw(`
      ALTER TABLE finance.cash_ledger
        ADD COLUMN firma_png    text,
        ADD COLUMN firma_nombre text,
        ADD COLUMN firma_at     timestamptz,
        ADD COLUMN firma_estado text
    `);
  }

  // El relleno retroactivo: todo lo que ya existía es `previo`. NO se juzga por tipo — un gasto
  // viejo no es un gasto sin firmar, es un gasto de cuando no se firmaba.
  await knex.raw(`UPDATE finance.cash_ledger SET firma_estado = 'previo' WHERE firma_estado IS NULL`);

  // Recién DESPUÉS del relleno se puede exigir el valor: al revés, el ALTER fallaría con las
  // filas viejas en NULL y la migración quedaría a medias.
  await knex.raw(`
    ALTER TABLE finance.cash_ledger
      ALTER COLUMN firma_estado SET DEFAULT 'no_aplica',
      ALTER COLUMN firma_estado SET NOT NULL
  `);

  // ⭐ El CHECK no sólo encierra el vocabulario: ata el estado a la EVIDENCIA. `firmado` sin
  // imagen es una afirmación sin respaldo, y es exactamente la fila que un reporte de
  // cumplimiento contaría como cumplida.
  await knex.raw(`
    ALTER TABLE finance.cash_ledger
      DROP CONSTRAINT IF EXISTS cash_ledger_firma_estado_chk
  `);
  await knex.raw(`
    ALTER TABLE finance.cash_ledger
      ADD CONSTRAINT cash_ledger_firma_estado_chk CHECK (
        firma_estado IN ('firmado', 'sin_firma', 'no_aplica', 'previo')
        AND (firma_estado <> 'firmado' OR (firma_png IS NOT NULL AND firma_at IS NOT NULL))
      )
  `);

  // Para la pregunta operativa: «¿qué egresos quedaron sin firma?». Parcial, porque es la única
  // fila que a alguien le interesa buscar — un índice sobre los cuatro estados pesaría de más.
  await knex.raw(`
    CREATE INDEX IF NOT EXISTS ix_cash_ledger_sin_firma
      ON finance.cash_ledger (tenant_id, fecha DESC)
      WHERE firma_estado = 'sin_firma'
  `);

  const lit = (v) => `'` + String(v).replace(/'/g, `''`) + `'`;
  const comentar = async (col, txt) => {
    // ⚠️ `COMMENT ON` no acepta parámetros ligados: va interpolado, con escape propio.
    await knex.raw(`COMMENT ON COLUMN finance.cash_ledger.${col} IS ${lit(txt)}`);
  };
  await comentar('firma_png',
    'Evidencia de conformidad: el PNG de la firma como data URI. NO es una firma electronica con '
    + 'valor legal (la e.firma del SAT es otro mecanismo). [CG.67] Va en la fila y no en el '
    + 'almacenamiento de objetos porque las env S3_* no existen en prod todavia; cuando existan, '
    + 'esto guarda la llave de putBuffer(). NO incluirla en un SELECT * de lista.');
  await comentar('firma_nombre', 'Quien firmo, como lo escribio el capturista. [CG.67]');
  await comentar('firma_at', 'Cuando se firmo. Lo pone el servidor, no el cliente. [CG.67]');
  await comentar('firma_estado',
    'firmado | sin_firma | no_aplica | previo. Lo calcula el SERVIDOR (ADR-076), nunca el '
    + 'cliente. Los cuatro son hechos distintos: sin_firma es el UNICO que alguien tiene que ir '
    + 'a resolver; no_aplica es un ingreso (lo respalda el documento del ERP) o un deposito (lo '
    + 'respalda la ficha del banco, Fase CC); previo es anterior al mecanismo y existe para que '
    + 'las filas viejas no entren como incumplimiento inventado por una migracion. [CG.67]');
};

/** Deshace EXACTAMENTE lo que hizo el `up`, ni una fila más. */
exports.down = async function down(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  await knex.raw(`DROP INDEX IF EXISTS finance.ix_cash_ledger_sin_firma`);
  await knex.raw(`
    ALTER TABLE finance.cash_ledger DROP CONSTRAINT IF EXISTS cash_ledger_firma_estado_chk
  `);
  for (const c of COLS) {
    if (await knex.schema.withSchema('finance').hasColumn('cash_ledger', c)) {
      await knex.raw(`ALTER TABLE finance.cash_ledger DROP COLUMN ${c}`);
    }
  }
};
