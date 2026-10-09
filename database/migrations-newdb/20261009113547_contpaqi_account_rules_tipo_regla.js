'use strict';
/**
 * `[CP.8.19]` — **El discriminante: `account_rules` no tiene UN tipo de regla, tiene cuatro.**
 *
 * ── Lo que obligó este cambio ───────────────────────────────────────────────────────────────
 * `[CP.8.18]` derivó el mapa categoría→cuenta cruzando los egresos de CB contra los abonos a
 * `102*` de ContPAQi por **(cuenta de banco, fecha, importe)**: 737 pareos exactos contra 2 del
 * placebo (+43 días) = **369× el piso de ruido**. Y la derivación mostró que la tabla que
 * `[CP.8.1]` creó —**una cuenta de gasto por categoría**— sólo sirve para una minoría:
 *
 *     compra_mercancia   361 pareados   65.1% toca 2120*     -> la cuenta la decide el PROVEEDOR
 *     nomina             159 pareados   74.2% toca 215011*   -> la decide la SUCURSAL
 *     compra_tarjeta     126 pareados   83.3% toca 52*       -> la decide la CATEGORIA
 *     traspaso_*          25 pareados    4.0% toca 52*       -> no es un gasto: banco<->banco
 *
 * ⭐ **Por qué el mapa no se podía derivar mirando un solo lado, ahora medido: CB clasifica por
 * INSTRUMENTO y ContPAQi por NATURALEZA.** `compra_tarjeta` (instrumento) es en 74 %
 * *GASOLINA Y LUBRICANTES* (naturaleza). Son dos vocabularios ciertos; faltaba el puente.
 *
 * ⛔ **`traspaso_entre_cuentas` se confirmó solo**: sus cuentas candidatas son **otras cuentas de
 * banco** (`1020020000` BBVA, `1020070000` Bajío). El cargo va a otro banco. Evidencia
 * independiente del umbral que lo clasificó — no es el mismo testigo dos veces.
 *
 * ── Qué agrega ──────────────────────────────────────────────────────────────────────────────
 *  · `tipo_regla`     — `por_categoria | por_proveedor | por_sucursal | no_aplica | sin_medir`
 *  · `cuenta_prefijo` — la familia donde la regla RESUELVE en tiempo de armado (`2120`, `215011`)
 *  · `lleva_iva`      — ⚠️ `boolean NULL`, y **NULL significa SIN MEDIR, no `false`**
 *  · `forma_medida`   — `jsonb` con la evidencia cruda del derivador, para poder re-auditarla
 *
 * ── ⚠️ Por qué `lleva_iva` queda en NULL en casi todas, a propósito ─────────────────────────
 * La medición de IVA es **a nivel de PÓLIZA**, y ContPAQi **agrupa**: 7.3 renglones por póliza en
 * mercancía, 14.6 en tarjeta, 278 en comisiones. Que el 90.9 % de las pólizas de
 * `compra_mercancia` tengan un renglón de IVA **no dice** que el pago a proveedor lo lleve —
 * puede venir de cualquiera de los otros movimientos que esa misma póliza agrupa.
 *
 * ⭐ La única categoría donde se puede concluir es `impuestos`: promedia **2.1 renglones** (o sea
 * la póliza es prácticamente 1:1 = cargo + abono) y el **94.1 % NO lleva renglón de IVA**. Ésa
 * se siembra `false`. Las demás se declaran NULL. *Una medición sobre otro grano es otra
 * afirmación* — concluir de más acá sería inventar con cara de dato.
 *
 * ── ⛔ Lo que esta migración NO hace ────────────────────────────────────────────────────────
 * **No habilita a nadie a asentar.** Las 21 filas siguen en `estado='sin_regla'` salvo las dos
 * `no_aplica`, que pasan a `derivada` porque su veredicto **sí** está derivado: no generan
 * póliza. Lo que esta migración cambia es que el armador va a poder distinguir *"falta decidir"*
 * de *"ya se decidió que no aplica"*, que son dos cosas distintas y hoy se ven iguales
 * (`[CP.8.1d]`, misma lección).
 *
 * ⛔ **No se edita la migración aplicada** (batch 856): va aparte, como manda la regla del repo.
 *
 * Idempotente.
 *
 * @param { import("knex").Knex } knex
 */

const TENANT = '00000000-0000-0000-0000-00000000d01c';
const RULES = 'contpaqi.account_rules';

/**
 * Lo medido por `database/scripts/derivar-reglas-contpaqi.js`, ventana 2026-01-01 → 2026-03-01,
 * sobre $144,093,601.04 en 2,650 egresos. Re-correr el script reproduce estas cifras.
 *
 * `null` en `lleva_iva` = SIN MEDIR. `muestra_chica` marca lo que NO alcanza para concluir: el
 * umbral es 6 pareos, y debajo de eso la fila queda en `sin_medir` aunque el porcentaje se vea
 * contundente — *un 100 % sobre un caso es un caso, no una regla*.
 */
const MEDIDO = [
  // categoria, tipo_regla, prefijo, lleva_iva, forma_medida
  ['compra_mercancia', 'por_proveedor', '2120', null,
    { pareados: 361, rengl_prom: 7.3, pct_2120: 65.1, pct_52: 9.4, pct_iva_poliza: 90.9 }],
  ['nomina', 'por_sucursal', '215011', null,
    { pareados: 159, rengl_prom: 2.9, pct_215011: 74.2, pct_52: 23.3, pct_iva_poliza: 22.6 }],
  ['compra_tarjeta', 'por_categoria', null, null,
    { pareados: 126, rengl_prom: 14.6, pct_52: 83.3, pct_iva_poliza: 82.5,
      candidata: '5200600000 GASOLINA Y LUBRICANTES (73.8%)' }],
  ['traspaso_entre_cuentas', 'no_aplica', null, false,
    { pareados: 25, rengl_prom: 16.0, pct_52: 4.0,
      por_que: 'las cuentas candidatas son OTRAS cuentas de banco (1020020000, 1020070000): banco<->banco' }],
  ['comision_bancaria', 'por_categoria', null, null,
    { pareados: 18, rengl_prom: 278.3, pct_52: 100,
      candidata: '5200650000 COMISIONES Y SITUACIONES (94.4%)',
      salvedad: 'la poliza promedia 278 renglones: la cuenta candidata sale del cargo mayor y es INDICIO, no regla' }],
  ['impuestos', 'por_categoria', null, false,
    { pareados: 17, rengl_prom: 2.1, pct_52: 88.2, pct_iva_poliza: 5.9,
      por_que: 'unica categoria con poliza ~1:1 (2.1 renglones): el 94.1% NO lleva renglon de IVA' }],
  ['servicios', 'por_categoria', null, null,
    { pareados: 12, rengl_prom: 3.9, pct_52: 75.0, pct_iva_poliza: 66.7 }],
  ['gasto_admin', 'por_categoria', null, null,
    { pareados: 9, rengl_prom: 4.0, pct_52: 77.8, pct_iva_poliza: 77.8 }],
  ['imss_sua', 'por_categoria', null, null,
    { pareados: 6, rengl_prom: 8.7, pct_52: 100, pct_iva_poliza: 16.7 }],

  // ⛔ El IVA no es un asiento: es el renglon 2 del asiento de su hermano (`[CP.8.7]` §16.1).
  ['iva_acreditable', 'no_aplica', null, null,
    { por_que: 'no es un evento contable propio: es el segundo renglon del asiento de su hermano' }],

  // ⚠️ Muestra insuficiente — se DECLARA, no se concluye.
  ['cobranza', 'sin_medir', null, null, { pareados: 2, muestra_chica: true }],
  ['pension_alimenticia', 'sin_medir', null, null, { pareados: 1, muestra_chica: true }],
  ['caja_ahorro', 'sin_medir', null, null, { pareados: 1, muestra_chica: true }],

  // ⚠️ Cero pareos en la ventana. NO es que no tengan regla: es que no se midieron.
  ['renta', 'sin_medir', null, null, { pareados: 0, por_que: 'cero pareos exactos en ene-feb 2026' }],
  ['pago_factoraje', 'sin_medir', null, null, { pareados: 0, por_que: 'cero pareos exactos en ene-feb 2026' }],
  ['pago_credito', 'sin_medir', null, null, { pareados: 0, por_que: 'cero pareos exactos en ene-feb 2026' }],
  ['traslado_valores', 'sin_medir', null, null, { pareados: 0, por_que: 'cero pareos exactos en ene-feb 2026' }],
];

exports.up = async function up(knex) {
  const tiene = async (col) => knex.schema.hasColumn('contpaqi.account_rules', col);

  if (!(await tiene('tipo_regla'))) {
    // ⭐ El default es `sin_medir`, NO `por_categoria`: una fila que nadie midió no debe nacer
    // afirmando de qué tipo es. Lo que no se midió se declara (ADR-056).
    await knex.raw(`ALTER TABLE ${RULES} ADD COLUMN tipo_regla text NOT NULL DEFAULT 'sin_medir'`);
  }
  if (!(await tiene('cuenta_prefijo'))) {
    await knex.raw(`ALTER TABLE ${RULES} ADD COLUMN cuenta_prefijo text`);
  }
  if (!(await tiene('lleva_iva'))) {
    await knex.raw(`ALTER TABLE ${RULES} ADD COLUMN lleva_iva boolean`);
  }
  if (!(await tiene('forma_medida'))) {
    await knex.raw(`ALTER TABLE ${RULES} ADD COLUMN forma_medida jsonb`);
  }

  await knex.raw(`ALTER TABLE ${RULES} DROP CONSTRAINT IF EXISTS account_rules_tipo_regla_chk`);
  await knex.raw(`
    ALTER TABLE ${RULES} ADD CONSTRAINT account_rules_tipo_regla_chk
      CHECK (tipo_regla IN ('por_categoria','por_proveedor','por_sucursal','no_aplica','sin_medir'))`);

  /**
   * ⭐ La coherencia entre `tipo_regla` y las columnas de cuenta se vuelve una REGLA DE LA BASE,
   * no una convención. Sin esto, una regla `por_proveedor` con `cuenta_gasto` puesta cargaría
   * todos los pagos a proveedor a una sola cuenta de gasto — y eso **cuadra**, así que ningún
   * cuadre lo atraparía. Un asiento que cuadra y está mal es el peor de los dos.
   */
  await knex.raw(`ALTER TABLE ${RULES} DROP CONSTRAINT IF EXISTS account_rules_cuenta_chk`);
  await knex.raw(`ALTER TABLE ${RULES} DROP CONSTRAINT IF EXISTS account_rules_coherencia_chk`);
  await knex.raw(`
    ALTER TABLE ${RULES} ADD CONSTRAINT account_rules_coherencia_chk CHECK (
      CASE tipo_regla
        WHEN 'por_categoria' THEN
          (estado = 'sin_regla' OR cuenta_gasto IS NOT NULL) AND cuenta_prefijo IS NULL
        WHEN 'por_proveedor' THEN cuenta_gasto IS NULL AND cuenta_prefijo IS NOT NULL
        WHEN 'por_sucursal'  THEN cuenta_gasto IS NULL AND cuenta_prefijo IS NOT NULL
        WHEN 'no_aplica'     THEN cuenta_gasto IS NULL AND cuenta_prefijo IS NULL
        WHEN 'sin_medir'     THEN cuenta_gasto IS NULL AND cuenta_prefijo IS NULL
      END)`);

  for (const [cat, tipo, prefijo, iva, forma] of MEDIDO) {
    // `no_aplica` pasa a `derivada` porque su veredicto SI esta derivado: no genera poliza.
    // El resto sigue en `sin_regla` -- esta migracion no habilita a nadie a asentar.
    const estado = tipo === 'no_aplica' ? 'derivada' : 'sin_regla';
    await knex.raw(
      `UPDATE ${RULES}
          SET tipo_regla     = ?,
              cuenta_prefijo = ?,
              lleva_iva      = ?,
              forma_medida   = ?::jsonb,
              estado         = ?,
              medido_en      = DATE '2026-10-09',
              updated_at     = now()
        WHERE tenant_id = ? AND categoria_code = ?`,
      [tipo, prefijo, iva, JSON.stringify(forma), estado, TENANT, cat],
    );
  }

  // Sin acentos graves en este literal: ya rompieron el build de este repo siete veces.
  const NOTA = 'NULL = SIN MEDIR, nunca false por omision. Solo la categoria impuestos pudo '
    + 'concluirse (su poliza es ~1:1, 2.1 renglones, y el 94.1% no lleva renglon de IVA). En el '
    + 'resto ContPAQi agrupa 7 a 278 movimientos por poliza, asi que el IVA observado puede venir '
    + 'de cualquiera de ellos: es otro grano, o sea otra afirmacion. Ver [CP.8.19].';
  // ⚠️ `COMMENT ON` no acepta parámetros en Postgres: exige literal. Se escapa a mano.
  await knex.raw(`COMMENT ON COLUMN ${RULES}.lleva_iva IS '${NOTA.replace(/'/g, "''")}'`);
};

exports.down = async function down(knex) {
  await knex.raw(`ALTER TABLE ${RULES} DROP CONSTRAINT IF EXISTS account_rules_coherencia_chk`);
  await knex.raw(`ALTER TABLE ${RULES} DROP CONSTRAINT IF EXISTS account_rules_tipo_regla_chk`);
  await knex.raw(`
    ALTER TABLE ${RULES} ADD CONSTRAINT account_rules_cuenta_chk
      CHECK (estado = 'sin_regla' OR cuenta_gasto IS NOT NULL)`);
  for (const col of ['tipo_regla', 'cuenta_prefijo', 'lleva_iva', 'forma_medida']) {
    await knex.raw(`ALTER TABLE ${RULES} DROP COLUMN IF EXISTS ${col}`);
  }
};
