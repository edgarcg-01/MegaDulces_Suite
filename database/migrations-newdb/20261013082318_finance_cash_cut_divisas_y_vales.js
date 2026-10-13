'use strict';
/**
 * `[CG.100]` — **En la caja hay dinero que no es efectivo en pesos, y hoy no tiene dónde entrar:
 * dólares, papeles por pagar, cheques y tarjeta.**
 *
 * Edgar, 2026-10-13: *"existen dolares y papeles sin pagar que se consideran como dinero. debes
 * tomarlos en cuenta pero en un apartado diferente"* · *"necesito que agregues el saldo completo,
 * de corte de control"*.
 *
 * ── ⛔ La primera versión de este archivo se escribió MAL, y la midió la fuente ────────────────
 *
 * Arranqué inventando una tabla de dólares **por denominación** (cuántos billetes de 100, de 50…)
 * porque parecía lo correcto. Después medí lo que Control lleva haciendo desde 2013 y resultó que
 * nadie cuenta los dólares así: los lleva como **un monto en USD por un tipo de cambio**
 * (`arqueo_movimientos.dolares` × `dolarestipocambio`). Contar por denominación habría inventado
 * un procedimiento que nadie sigue y, peor, habría vuelto el arqueo nuevo **incomparable con los
 * 30,199 arqueos históricos** que ya están en `caja_general_ods`. *La forma del dato la decide la
 * fuente, no mi idea de prolijidad.*
 *
 * ── Lo medido antes (sólo lectura, prod 2026-10-13) ─────────────────────────────────────────
 *
 * `caja_general_ods.arqueo_movimientos` (30,199 filas, 2013-09-13 → 2026-10-12) ya trae las cinco
 * piernas. El arqueo `A23641` del 10-oct cuadra **al centavo** y es el que Edgar pidió traer:
 *
 *     efectivo    3,327.50   (1 billete de 500 + 5 de 100 + 160 monedas de 10 + ...)
 *     cheques    25,840.00
 *     tarjeta   337,500.00
 *     papeles    20,782.00
 *     dólares   230,338.959 = 12,059 USD x 19.101
 *     --------------------
 *     TOTAL     617,788.459   (suma de las partes - declarado = 0.00)
 *
 * ⭐⭐ Y ESE total explica el defecto que tenía trabado el cierre: el corte `CC-2026-00001` nació
 * con `fondo_inicial = 617,505.50`. **No era un typo** — es el total COMPLETO de Control metido
 * donde va el efectivo. El fondo de un cajón es `totalefectivo` ($3,327.50), no `movimientototal`.
 * Sin un lugar para las otras cuatro piernas, el número correcto entra por la única casilla que
 * hay, que es la equivocada. *Esta migración existe para que esa casilla deje de ser la única.*
 *
 * ── ⛔⛔ LO QUE NO SE PUEDE SUMAR, Y POR QUÉ ────────────────────────────────────────────────
 *
 * Medido sobre 2026 en `arqueo_movimientos`: los dólares toman **9 valores distintos en todo el
 * año**, y el actual —**12,059 USD a 19.101**— se repite **205 veces del 2-abr al 10-oct**. El
 * crédito es peor: **$20,782.00 exactos, 383 veces, del 2025-10-06 al 2026-10-10**.
 *
 * Eso no es un flujo: es un **saldo PARADO que se vuelve a declarar en cada conteo**. Por eso los
 * totales por día salían en múltiplos exactos (1x, 2x, 3x) del mismo número — eran 1, 2 o 3
 * conteos del mismo fajo. ⛔ `sum()` sobre estas columnas publica dinero que no existe.
 *
 * ⚠️ Y `totalcredito` **mezcla dos poblaciones en una sola columna**: ese saldo parado de $20,782
 * y ~60 importes con centavos que aparecen **una sola vez cada uno** (8,989.28 · 9,423.60 · …),
 * que sí son flujo. ⚠️ `totaltarjeta` tampoco es siempre saldo: `A23627` con observación `r21` y
 * $17,490 de tarjeta es la **liquidación de la ruta 21** — refutó mi primera regla de
 * clasificación, que daba por conteo a toda fila con algo distinto de efectivo.
 *
 * Por eso acá cada fila dice **qué es** (`naturaleza`): un saldo en custodia que se re-declara, o
 * un movimiento del día. Sin esa columna las dos cosas vuelven a vivir en el mismo `sum()`.
 *
 * ── Las decisiones que esto encierra ────────────────────────────────────────────────────────
 *
 * ⭐ **El dólar se guarda en dólares y el tipo de cambio lleva FUENTE obligatoria.** Un tipo de
 * cambio sin fuente es un número inventado del que termina colgando un faltante. Y hace falta
 * decirlo: el `19.101` de Control está **congelado desde el 2-abr-2026** — seis meses valuando
 * $230,338.96 con el precio de abril.
 *
 * ⭐ **Los papeles llevan DETALLE, que es lo único que Control no tiene.** Control guarda
 * `totalcredito` como un número suelto; por eso nadie puede ver que esos $20,782 llevan **doce
 * meses sin moverse**. Una fila por papel, con su concepto y a quién, es lo que vuelve esa cifra
 * revisable en vez de heredable.
 *
 * ⭐ **Un papel respalda efectivo sólo si todavía NO está en el libro.** Si ya se capturó como
 * movimiento (`ledger_folio` lleno), su dinero ya salió en la aritmética del corte y contarlo otra
 * vez sería un sobrante del tamaño del papel. Se DERIVA de `ledger_folio`, no de un segundo campo
 * que pueda contradecirlo.
 *
 * Idempotente.
 *
 * @param { import("knex").Knex } knex
 */

/** Mismo molde que `cash_ledger_cuts`: RLS forzado + política por tenant + grant al runtime. */
async function tenantRls(knex, table) {
  await knex.raw(`ALTER TABLE finance.${table} ENABLE ROW LEVEL SECURITY`);
  await knex.raw(`ALTER TABLE finance.${table} FORCE ROW LEVEL SECURITY`);
  await knex.raw(`
    DO $$ BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_policies WHERE schemaname='finance' AND tablename='${table}' AND policyname='tenant_isolation'
      ) THEN
        CREATE POLICY tenant_isolation ON finance.${table}
          USING (tenant_id = current_tenant_id())
          WITH CHECK (tenant_id = current_tenant_id());
      END IF;
    END $$`);
  await knex.raw(`GRANT SELECT, INSERT, UPDATE, DELETE ON finance.${table} TO app_runtime`);
}

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);

  // --- 1) Las cuatro piernas que no son efectivo en pesos ------------------------------------
  if (!(await knex.schema.withSchema('finance').hasTable('cash_ledger_cut_custody'))) {
    await knex.raw(`
      CREATE TABLE finance.cash_ledger_cut_custody (
        id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id          uuid NOT NULL,
        cut_id             uuid NOT NULL REFERENCES finance.cash_ledger_cuts(id) ON DELETE CASCADE,
        momento            text NOT NULL,
        concepto           text NOT NULL,
        -- custodia = saldo parado que se vuelve a declarar en cada conteo (los 12,059 USD, los
        -- 20,782 de papeles). movimiento = algo que pasO ese dia (la tarjeta de una ruta).
        -- Sin esta columna las dos cosas caen en el mismo sum() y el dia publica dinero que no hay.
        naturaleza         text NOT NULL,
        moneda             text NOT NULL DEFAULT 'MXN',
        monto              numeric(14,2) NOT NULL,
        tipo_cambio        numeric(12,4),
        tipo_cambio_fuente text,
        nota               text,
        created_by          uuid,
        created_by_username text,
        created_at         timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT cut_cust_momento_chk    CHECK (momento    IN ('apertura','cierre')),
        CONSTRAINT cut_cust_concepto_chk   CHECK (concepto   IN ('dolares','cheques','tarjeta','papeles')),
        CONSTRAINT cut_cust_naturaleza_chk CHECK (naturaleza IN ('custodia','movimiento')),
        CONSTRAINT cut_cust_moneda_chk     CHECK (moneda     IN ('MXN','USD')),
        CONSTRAINT cut_cust_monto_chk      CHECK (monto > 0),
        -- Moneda extranjera EXIGE tipo de cambio con fuente; en pesos no puede haberlo.
        CONSTRAINT cut_cust_tc_chk CHECK (
          (moneda = 'MXN' AND tipo_cambio IS NULL AND tipo_cambio_fuente IS NULL)
          OR (moneda <> 'MXN' AND tipo_cambio > 0
              AND length(btrim(coalesce(tipo_cambio_fuente,''))) >= 3)),
        -- Solo los dolares pueden venir en otra moneda: cheque, tarjeta y papeles son en pesos.
        CONSTRAINT cut_cust_concepto_moneda_chk CHECK (moneda = 'MXN' OR concepto = 'dolares')
      )`);
    await knex.raw(`CREATE UNIQUE INDEX IF NOT EXISTS cut_cust_una_por_concepto_uq
                      ON finance.cash_ledger_cut_custody (tenant_id, cut_id, momento, concepto, moneda)`);
    await tenantRls(knex, 'cash_ledger_cut_custody');
  }

  // --- 2) El detalle de los papeles: lo unico que Control NO tiene ----------------------------
  if (!(await knex.schema.withSchema('finance').hasTable('cash_ledger_cut_vouchers'))) {
    await knex.raw(`
      CREATE TABLE finance.cash_ledger_cut_vouchers (
        id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id           uuid NOT NULL,
        cut_id              uuid NOT NULL REFERENCES finance.cash_ledger_cuts(id) ON DELETE CASCADE,
        momento             text NOT NULL,
        concepto            text NOT NULL,
        beneficiario        text,
        monto               numeric(14,2) NOT NULL,
        fecha               date,
        referencia          text,
        -- NULL = el papel es el unico registro y RESPALDA el efectivo que no esta.
        -- Lleno = ya se capturo en el libro, su dinero ya salio en la aritmetica del corte,
        -- y volver a contarlo seria un sobrante del tamano del papel.
        ledger_folio        text,
        created_by          uuid,
        created_by_username text,
        created_at          timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT cut_vale_momento_chk  CHECK (momento IN ('apertura','cierre')),
        CONSTRAINT cut_vale_monto_chk    CHECK (monto > 0),
        CONSTRAINT cut_vale_concepto_chk CHECK (length(btrim(concepto)) >= 3)
      )`);
    await knex.raw(`CREATE INDEX IF NOT EXISTS cut_vale_corte_idx
                      ON finance.cash_ledger_cut_vouchers (tenant_id, cut_id, momento)`);
    await tenantRls(knex, 'cash_ledger_cut_vouchers');
  }
};

/** Deshace EXACTAMENTE lo que hizo el `up`, ni una fila más. */
exports.down = async function down(knex) {
  await knex.schema.withSchema('finance').dropTableIfExists('cash_ledger_cut_vouchers');
  await knex.schema.withSchema('finance').dropTableIfExists('cash_ledger_cut_custody');
};
