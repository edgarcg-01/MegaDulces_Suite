/**
 * `[CG.38]` La caja cuenta monedas, y el cambio que se devuelve deja de perderse.
 *
 * ── El pedido
 *
 * Edgar, 2026-10-06: *"la morralla se cuenta por denominación, además, la persona encargada
 * normalmente da cambio. tenemos que agregar ese apartado y hacerlo que sea un proceso rápido
 * sin perder un dato en el arqueo"*.
 *
 * ── ⛔ El bloqueo que había que quitar primero, y no era obvio
 *
 * La tabla identifica cada renglón por el VALOR de la denominación:
 *
 *     PRIMARY KEY (tenant_id, cash_ledger_id, denominacion)   -- denominacion numeric(10,2)
 *
 * **México tiene billete de $20 Y moneda de $20.** Mientras la caja contaba sólo billetes eso
 * no mordía; en cuanto se cuentan monedas, las dos filas valen `20` y **colisionan en la llave
 * primaria**: la segunda no entra. O sea que no es que se confundan — es que una de las dos
 * pilas de dinero **no se puede guardar**.
 *
 * El catálogo compartido (`libs/contracts/src/money/denominations.ts`, SM.39) ya había resuelto
 * exactamente esto: la llave del billete es `'20'` y la de la moneda `'20m'`. Y
 * `caja-captura.util.ts` lo tenía escrito desde septiembre — *"acá no muerde porque la caja no
 * desglosa monedas, pero la forma equivocada invita al bug"*. Hoy muerde.
 *
 * ── Qué hace esta migración
 *
 * 1. `denom_key` — la identidad pasa a ser la LLAVE del catálogo, no el valor.
 * 2. `flujo` — `'recibido'` o `'devuelto'`. Un acto de caja tiene una pila que entra y otra que
 *    sale; el neto es la resta. El cobro de siempre es el caso en que no sale nada.
 * 3. La llave primaria pasa a `(tenant_id, cash_ledger_id, flujo, denom_key)`.
 * 4. Un CHECK de PARES reemplaza al de valores sueltos, para que la columna numérica —que es
 *    derivada de la llave— **no pueda mentir**.
 *
 * ── Por qué `denominacion` se queda
 *
 * Es derivada de `denom_key`, y normalmente eso sería materializar un valor inventado. Acá no:
 * es lo que permite **sumar en SQL** sin que la base tenga que conocer un catálogo que vive en
 * TypeScript, y el CHECK de pares la ata a su llave. Es el caso legítimo de materializar por
 * costo (GOTCHAS §19), no el de inventar un dato.
 *
 * ── Compatibilidad
 *
 * ⭐ El backfill NO cambia el significado de un solo arqueo viejo. Todo lo capturado hasta hoy
 * son BILLETES (la pantalla ofrecía cinco llaves, las cinco de familia billete) y la llave del
 * billete es el valor a secas — así que `denominacion = 20` se vuelve `denom_key = '20'`, que
 * es el billete, que es lo que se contó. `flujo` nace en `'recibido'` por la misma razón: todo
 * lo ya guardado es dinero que ENTRÓ.
 *
 * ⚠️ Los tres valores de menos de 50¢ (20¢, 10¢, 5¢) que el CHECK viejo admitía NO están en el
 * catálogo compartido. Si hubiera filas con ellos, se conservan con su llave y el lector las va
 * a reportar como desconocidas — que es declararlas, no perderlas (ADR-056). Lo que no se puede
 * es capturar nuevas: la pantalla sólo ofrece lo que el catálogo reconoce.
 *
 * ⛔ El backfill ABORTA si queda una sola fila sin llave. Un `denom_key` en NULL sería un
 * renglón de dinero sin identidad, y eso no se arregla después.
 */

/**
 * Los pares (llave, valor) que la tabla admite. Las 12 del catálogo compartido más las 3
 * fracciones legacy que el CHECK anterior permitía, para no invalidar historia.
 */
const PARES = [
  ['1000', 1000], ['500', 500], ['200', 200], ['100', 100], ['50', 50], ['20', 20],
  ['20m', 20], ['10', 10], ['5', 5], ['2', 2], ['1', 1], ['0.5', 0.5],
  ['0.2', 0.2], ['0.1', 0.1], ['0.05', 0.05],
];

exports.up = async function (knex) {
  const tiene = async (col) =>
    knex.schema.withSchema('finance').hasColumn('cash_ledger_denominations', col);

  if (!(await knex.schema.withSchema('finance').hasTable('cash_ledger_denominations'))) return;

  if (!(await tiene('denom_key'))) {
    await knex.raw(`ALTER TABLE finance.cash_ledger_denominations ADD COLUMN denom_key text`);
  }
  if (!(await tiene('flujo'))) {
    await knex.raw(
      `ALTER TABLE finance.cash_ledger_denominations ADD COLUMN flujo text NOT NULL DEFAULT 'recibido'`,
    );
  }

  // --- Backfill: valor -> llave. Todo lo viejo es billete y todo lo viejo entró. ---------------
  const casos = PARES
    // La moneda de $20 NO participa del backfill: nada capturado hasta hoy es una moneda de $20,
    // y mapear 20 a '20m' le cambiaría el significado a arqueos ya firmados.
    .filter(([k]) => k !== '20m')
    .map(([k, v]) => `WHEN denominacion = ${v} THEN '${k}'`)
    .join(' ');
  await knex.raw(`
    UPDATE finance.cash_ledger_denominations
       SET denom_key = CASE ${casos} ELSE NULL END
     WHERE denom_key IS NULL`);

  const [{ huerfanas }] = (await knex.raw(
    `SELECT count(*)::int AS huerfanas FROM finance.cash_ledger_denominations WHERE denom_key IS NULL`,
  )).rows;
  if (huerfanas > 0) {
    throw new Error(
      `[CG.38] ${huerfanas} renglon(es) de denominacion quedaron sin llave: hay un valor en la ` +
      `tabla que el catalogo no contempla. Resolverlo a mano ANTES de migrar -- un denom_key en ` +
      `NULL es dinero contado sin identidad.`,
    );
  }

  await knex.raw(`ALTER TABLE finance.cash_ledger_denominations ALTER COLUMN denom_key SET NOT NULL`);

  // --- La identidad pasa a ser (flujo, llave) --------------------------------------------------
  await knex.raw(`
    ALTER TABLE finance.cash_ledger_denominations
      DROP CONSTRAINT IF EXISTS cash_ledger_denominations_pkey`);
  await knex.raw(`
    ALTER TABLE finance.cash_ledger_denominations
      ADD PRIMARY KEY (tenant_id, cash_ledger_id, flujo, denom_key)`);

  // --- El valor numerico no puede contradecir a su llave ---------------------------------------
  await knex.raw(`
    ALTER TABLE finance.cash_ledger_denominations
      DROP CONSTRAINT IF EXISTS cash_denom_valor_chk`);
  const pares = PARES.map(([k, v]) => `('${k}',${v})`).join(',');
  await knex.raw(`
    ALTER TABLE finance.cash_ledger_denominations
      ADD CONSTRAINT cash_denom_par_chk CHECK ((denom_key, denominacion) IN (${pares}))`);

  await knex.raw(`
    ALTER TABLE finance.cash_ledger_denominations
      DROP CONSTRAINT IF EXISTS cash_denom_flujo_chk`);
  await knex.raw(`
    ALTER TABLE finance.cash_ledger_denominations
      ADD CONSTRAINT cash_denom_flujo_chk CHECK (flujo IN ('recibido','devuelto'))`);

  await knex.raw(`
    COMMENT ON COLUMN finance.cash_ledger_denominations.denom_key IS
      '[CG.38] La IDENTIDAD del renglon: llave del catalogo MXN de @megadulces/contracts. El billete y la moneda de $20 valen lo mismo y son cosas distintas (20 vs 20m).'`);
  await knex.raw(`
    COMMENT ON COLUMN finance.cash_ledger_denominations.denominacion IS
      '[CG.38] DERIVADA de denom_key, atada por cash_denom_par_chk. Existe para poder sumar en SQL sin que la base conozca el catalogo, que vive en TypeScript.'`);
  await knex.raw(`
    COMMENT ON COLUMN finance.cash_ledger_denominations.flujo IS
      '[CG.38] recibido = entro a la caja; devuelto = el cambio que se dio. El neto del movimiento es la resta. Default recibido: todo lo capturado antes de esta migracion es dinero que entro.'`);
};

/**
 * `down()` escrito a mano, no derivado del `up()`.
 *
 * ⛔ Deja caer las filas `devuelto` antes de volver a la llave vieja: con la primaria en
 * `(tenant_id, cash_ledger_id, denominacion)` una pila devuelta de $100 y una recibida de $100
 * del mismo movimiento colisionan. Es pérdida de dato, y por eso está dicho acá: revertir esta
 * migración con cambios ya capturados **borra los cambios devueltos**.
 */
exports.down = async function (knex) {
  if (!(await knex.schema.withSchema('finance').hasTable('cash_ledger_denominations'))) return;

  await knex.raw(`DELETE FROM finance.cash_ledger_denominations WHERE flujo = 'devuelto'`);
  // Y las monedas de $20, que en la forma vieja chocarian con el billete del mismo movimiento.
  await knex.raw(`DELETE FROM finance.cash_ledger_denominations WHERE denom_key = '20m'`);

  await knex.raw(`
    ALTER TABLE finance.cash_ledger_denominations
      DROP CONSTRAINT IF EXISTS cash_denom_flujo_chk`);
  await knex.raw(`
    ALTER TABLE finance.cash_ledger_denominations
      DROP CONSTRAINT IF EXISTS cash_denom_par_chk`);
  await knex.raw(`
    ALTER TABLE finance.cash_ledger_denominations
      DROP CONSTRAINT IF EXISTS cash_ledger_denominations_pkey`);
  await knex.raw(`
    ALTER TABLE finance.cash_ledger_denominations
      ADD PRIMARY KEY (tenant_id, cash_ledger_id, denominacion)`);
  await knex.raw(`
    ALTER TABLE finance.cash_ledger_denominations
      ADD CONSTRAINT cash_denom_valor_chk CHECK (denominacion IN
        (1000,500,200,100,50,20,10,5,2,1,0.50,0.20,0.10,0.05))`);

  await knex.raw(`ALTER TABLE finance.cash_ledger_denominations DROP COLUMN IF EXISTS flujo`);
  await knex.raw(`ALTER TABLE finance.cash_ledger_denominations DROP COLUMN IF EXISTS denom_key`);
};
