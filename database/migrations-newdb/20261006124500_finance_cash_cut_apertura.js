/**
 * `[CG.39]` El estado INICIAL de la caja: que se sepa con qué arrancó, y que no sea un cero.
 *
 * ── El pedido
 *
 * Edgar, 2026-10-06: *"necesitamos saber el estado inicial de la caja chica general"*.
 *
 * ── ⛔ Lo que se encontró al medirlo: el campo existe y miente
 *
 * `finance.cash_ledger_cuts.fondo_inicial` está desde `[CG.26]`, y el cálculo del corte lo usa:
 * `esperado = fondo_inicial + ingresos − gastos − depósitos`. Pero:
 *
 *   1. Se **teclea a mano** y el servicio hace `input.fondo_inicial ?? 0`.
 *   2. La columna es `NOT NULL DEFAULT 0`.
 *   3. **No tiene NINGUNA liga con el cierre anterior.**
 *
 * O sea que el arranque de hoy no es el cierre de ayer: es lo que alguien escriba, o **cero**.
 *
 * ⭐ Y ese cero no es neutro, es una afirmación FALSA: dice *"la caja arrancó vacía"*. Con el
 * fondo de cambio que Edgar confirmó que existe —*"la persona encargada normalmente da cambio"*,
 * y para dar cambio hay que tener morralla desde antes de abrir— arrancar en cero es
 * imposible. Cada peso de ese fondo sale del `esperado` y reaparece como sobrante en el arqueo.
 * Es exactamente lo que ADR-056 prohíbe: **dibujar como cero lo que no se midió**.
 *
 * ── Qué hace esta migración
 *
 * 1. `fondo_inicial` pasa a **nullable**. `NULL` = *no se midió con qué arrancó*; `0` = *se contó
 *    y estaba vacía*. Son dos hechos distintos y hasta hoy se escribían igual.
 * 2. `momento` en el desglose del corte: `'apertura'` o `'cierre'`. El cierre ya se contaba por
 *    denominación; **la apertura no se contaba de ninguna forma**. Ahora las dos viven en la
 *    misma tabla, que es lo que permite decir *"tenés 40 monedas de $10 para dar cambio"*.
 * 3. `denom_key`, por el mismo motivo que `[CG.38]` lo puso en el otro desglose: la llave
 *    primaria estaba en el VALOR, y el billete y la moneda de $20 **colisionan**. El corte tiene
 *    el defecto idéntico, así que se corrige igual o su reja de monedas nace rota.
 * 4. `fondo_origen`: de dónde salió el arranque — `'cierre_anterior'`, `'contado'` o
 *    `'sin_medir'`. Un número sin su procedencia es el problema que ADR-056 vino a cerrar.
 *
 * ⚠️ El default de la columna se RETIRA junto con el `NOT NULL`. Si se dejara el `DEFAULT 0`,
 * una fila nueva que no lo mande seguiría naciendo en cero — el mismo cero, ahora disfrazado.
 */

const PARES = [
  ['1000', 1000], ['500', 500], ['200', 200], ['100', 100], ['50', 50], ['20', 20],
  ['20m', 20], ['10', 10], ['5', 5], ['2', 2], ['1', 1], ['0.5', 0.5],
  ['0.2', 0.2], ['0.1', 0.1], ['0.05', 0.05],
];

exports.up = async function (knex) {
  const hasT = (t) => knex.schema.withSchema('finance').hasTable(t);
  const hasC = (t, c) => knex.schema.withSchema('finance').hasColumn(t, c);

  // --- 1 y 4: el arranque deja de ser un cero obligatorio y declara su procedencia -----------
  if (await hasT('cash_ledger_cuts')) {
    await knex.raw(`ALTER TABLE finance.cash_ledger_cuts ALTER COLUMN fondo_inicial DROP NOT NULL`);
    await knex.raw(`ALTER TABLE finance.cash_ledger_cuts ALTER COLUMN fondo_inicial DROP DEFAULT`);

    if (!(await hasC('cash_ledger_cuts', 'fondo_origen'))) {
      await knex.raw(`ALTER TABLE finance.cash_ledger_cuts ADD COLUMN fondo_origen text`);
    }
    await knex.raw(`
      ALTER TABLE finance.cash_ledger_cuts DROP CONSTRAINT IF EXISTS cash_cut_fondo_origen_chk`);
    await knex.raw(`
      ALTER TABLE finance.cash_ledger_cuts ADD CONSTRAINT cash_cut_fondo_origen_chk CHECK (
        fondo_origen IS NULL OR fondo_origen IN ('cierre_anterior','contado','sin_medir'))`);
    // ⭐ El candado que ata las dos columnas: un monto sin procedencia, o una procedencia de
    //    "sin medir" con un monto, son las dos formas de volver al cero mudo.
    await knex.raw(`
      ALTER TABLE finance.cash_ledger_cuts DROP CONSTRAINT IF EXISTS cash_cut_fondo_coherente_chk`);
    await knex.raw(`
      ALTER TABLE finance.cash_ledger_cuts ADD CONSTRAINT cash_cut_fondo_coherente_chk CHECK (
        (fondo_inicial IS NULL  AND (fondo_origen IS NULL OR fondo_origen = 'sin_medir')) OR
        (fondo_inicial IS NOT NULL AND fondo_origen IN ('cierre_anterior','contado')))`);

    await knex.raw(`
      COMMENT ON COLUMN finance.cash_ledger_cuts.fondo_inicial IS
        '[CG.39] Con cuanto arranco la caja. NULL = NO SE MIDIO; 0 = se conto y estaba vacia. Son dos hechos distintos: hasta esta migracion se escribian igual, y el cero decia que la caja arranco vacia -- imposible si hay fondo para dar cambio.'`);
    await knex.raw(`
      COMMENT ON COLUMN finance.cash_ledger_cuts.fondo_origen IS
        '[CG.39] De donde salio el arranque: cierre_anterior (encadenado), contado (lo conto una persona) o sin_medir. Un numero sin procedencia es el problema que ADR-056 vino a cerrar.'`);
  }

  // --- 2 y 3: el desglose del corte, con identidad por llave y los dos momentos --------------
  if (await hasT('cash_ledger_cut_denominations')) {
    if (!(await hasC('cash_ledger_cut_denominations', 'denom_key'))) {
      await knex.raw(`ALTER TABLE finance.cash_ledger_cut_denominations ADD COLUMN denom_key text`);
    }
    if (!(await hasC('cash_ledger_cut_denominations', 'momento'))) {
      await knex.raw(
        `ALTER TABLE finance.cash_ledger_cut_denominations ADD COLUMN momento text NOT NULL DEFAULT 'cierre'`);
    }

    // Todo lo capturado hasta hoy es el CIERRE y son BILLETES: la pantalla no ofrecia monedas.
    const casos = PARES.filter(([k]) => k !== '20m')
      .map(([k, v]) => `WHEN denominacion = ${v} THEN '${k}'`).join(' ');
    await knex.raw(`
      UPDATE finance.cash_ledger_cut_denominations
         SET denom_key = CASE ${casos} ELSE NULL END
       WHERE denom_key IS NULL`);

    const [{ huerfanas }] = (await knex.raw(
      `SELECT count(*)::int AS huerfanas FROM finance.cash_ledger_cut_denominations WHERE denom_key IS NULL`,
    )).rows;
    if (huerfanas > 0) {
      throw new Error(
        `[CG.39] ${huerfanas} renglon(es) del desglose del corte quedaron sin llave. Resolverlo a ` +
        `mano ANTES de migrar: un denom_key en NULL es dinero contado sin identidad.`,
      );
    }

    await knex.raw(`ALTER TABLE finance.cash_ledger_cut_denominations ALTER COLUMN denom_key SET NOT NULL`);
    await knex.raw(`
      ALTER TABLE finance.cash_ledger_cut_denominations
        DROP CONSTRAINT IF EXISTS cash_ledger_cut_denominations_pkey`);
    await knex.raw(`
      ALTER TABLE finance.cash_ledger_cut_denominations
        ADD PRIMARY KEY (tenant_id, cut_id, momento, denom_key)`);

    await knex.raw(`
      ALTER TABLE finance.cash_ledger_cut_denominations DROP CONSTRAINT IF EXISTS cut_denom_valor_chk`);
    const pares = PARES.map(([k, v]) => `('${k}',${v})`).join(',');
    await knex.raw(`
      ALTER TABLE finance.cash_ledger_cut_denominations
        ADD CONSTRAINT cut_denom_par_chk CHECK ((denom_key, denominacion) IN (${pares}))`);
    await knex.raw(`
      ALTER TABLE finance.cash_ledger_cut_denominations DROP CONSTRAINT IF EXISTS cut_denom_momento_chk`);
    await knex.raw(`
      ALTER TABLE finance.cash_ledger_cut_denominations
        ADD CONSTRAINT cut_denom_momento_chk CHECK (momento IN ('apertura','cierre'))`);

    await knex.raw(`
      COMMENT ON COLUMN finance.cash_ledger_cut_denominations.momento IS
        '[CG.39] apertura = con que arranco la caja; cierre = con que termino. El cierre ya se contaba por denominacion; la apertura no se contaba de ninguna forma. Default cierre: todo lo capturado antes de esta migracion es un conteo de cierre.'`);
  }
};

/**
 * `down()` escrito a mano.
 *
 * ⛔ Borra el desglose de APERTURA antes de volver a la llave vieja: con la primaria en
 * `(tenant, corte, denominacion)` la apertura y el cierre del mismo corte colisionan. Revertir
 * con aperturas ya contadas **las pierde**, y por eso está dicho acá y no en un comentario suelto.
 *
 * ⚠️ `fondo_inicial` vuelve a `NOT NULL DEFAULT 0`, así que los `NULL` —que significan *no se
 * midió*— se vuelven ceros que afirman *arrancó vacía*. Es pérdida de significado, no de filas.
 */
exports.down = async function (knex) {
  const hasT = (t) => knex.schema.withSchema('finance').hasTable(t);

  if (await hasT('cash_ledger_cut_denominations')) {
    await knex.raw(`DELETE FROM finance.cash_ledger_cut_denominations WHERE momento = 'apertura'`);
    await knex.raw(`DELETE FROM finance.cash_ledger_cut_denominations WHERE denom_key = '20m'`);
    await knex.raw(`
      ALTER TABLE finance.cash_ledger_cut_denominations DROP CONSTRAINT IF EXISTS cut_denom_momento_chk`);
    await knex.raw(`
      ALTER TABLE finance.cash_ledger_cut_denominations DROP CONSTRAINT IF EXISTS cut_denom_par_chk`);
    await knex.raw(`
      ALTER TABLE finance.cash_ledger_cut_denominations
        DROP CONSTRAINT IF EXISTS cash_ledger_cut_denominations_pkey`);
    await knex.raw(`
      ALTER TABLE finance.cash_ledger_cut_denominations
        ADD PRIMARY KEY (tenant_id, cut_id, denominacion)`);
    await knex.raw(`
      ALTER TABLE finance.cash_ledger_cut_denominations
        ADD CONSTRAINT cut_denom_valor_chk CHECK (denominacion IN
          (1000,500,200,100,50,20,10,5,2,1,0.50,0.20,0.10,0.05))`);
    await knex.raw(`ALTER TABLE finance.cash_ledger_cut_denominations DROP COLUMN IF EXISTS momento`);
    await knex.raw(`ALTER TABLE finance.cash_ledger_cut_denominations DROP COLUMN IF EXISTS denom_key`);
  }

  if (await hasT('cash_ledger_cuts')) {
    await knex.raw(`
      ALTER TABLE finance.cash_ledger_cuts DROP CONSTRAINT IF EXISTS cash_cut_fondo_coherente_chk`);
    await knex.raw(`
      ALTER TABLE finance.cash_ledger_cuts DROP CONSTRAINT IF EXISTS cash_cut_fondo_origen_chk`);
    await knex.raw(`ALTER TABLE finance.cash_ledger_cuts DROP COLUMN IF EXISTS fondo_origen`);
    await knex.raw(`UPDATE finance.cash_ledger_cuts SET fondo_inicial = 0 WHERE fondo_inicial IS NULL`);
    await knex.raw(`ALTER TABLE finance.cash_ledger_cuts ALTER COLUMN fondo_inicial SET DEFAULT 0`);
    await knex.raw(`ALTER TABLE finance.cash_ledger_cuts ALTER COLUMN fondo_inicial SET NOT NULL`);
  }
};
