/**
 * [PGP.30] `analytics.v_supplier_payment_habit` — con qué se le suele pagar a cada acreedor.
 *
 * ⭐ **Por qué existe.** El Calendario de Pagos pide a mano, pago por pago, el **método** y la
 * **cuenta de origen**. Medido contra prod el 2026-10-28 sobre `analytics.erp_supplier_payments`:
 *
 *   - el método es **transferencia en el 92.6 %** de los 4,881 pagos;
 *   - **248 de 316 acreedores (78.5 %)** tienen un método dominante >= 90 %, que cubre 4,139 pagos;
 *   - **250 de 282 (88.7 %)** repiten el método del pago anterior;
 *   - **146 de 316 (46.2 %)** tienen una cuenta de origen dominante >= 90 %, que cubre 2,726 pagos.
 *
 * ⛔ **Esta vista NO decide: propone.** Quien paga sigue eligiendo, y la propuesta viaja con su
 * evidencia (cuántas veces, de cuántas, cuándo fue la última) para que se pueda contradecir.
 *
 * ## Lo que esta vista NO puede proponer, y se declara
 *
 * Kepler sólo distingue tres métodos en `kdm1.c31` (`transferencia`, `cheque`, `anticipo`). La
 * pantalla ofrece cuatro (`transferencia`, `cheque`, `efectivo`, `cargo_automatico`). Entonces:
 *
 *   - ⛔ **`efectivo` y `cargo_automatico` NUNCA se proponen** — no porque no se usen, sino porque
 *     el ERP no los distingue. Ausencia de propuesta no es evidencia de que no se usen.
 *   - ⛔ **`anticipo` se excluye del cálculo**: no es un método de pago, es la naturaleza del
 *     documento. Proponerlo mandaría a la pantalla un valor que su selector no acepta.
 *
 * ## El puente de cuentas, y por qué no es el que parecía
 *
 * `finance.bank_accounts.kepler_link` existe **exactamente** para cruzar el nombre de cuenta que
 * trae Kepler con nuestro catálogo. Medido: **está vacía en las 20 filas.** Se deriva, entonces,
 * por dos reglas, y se mide:
 *
 *   1. el nombre de Kepler es igual a nuestro `alias` o `account_label` (CAJA GENERAL, FACTORAJE);
 *   2. el banco coincide y los dígitos de la cuenta son iguales (Kepler `BAJIO 4166` <-> `BBAJIO`
 *      + `4166`).
 *
 * Resultado: **16 de 20 cuentas, 4,716 de 4,876 pagos (96.7 %)**. Control negativo: con los
 * dígitos invertidos casan **0**, o sea la regla discrimina y no casa por azar.
 *
 * ⚠️ **Las 4 que no resuelven se DECLARAN, no se adivinan** (ADR-056):
 *   - `AJUSTE A SALDO` (3 pagos) y `DEVOLUCIONES` (2) son de tipo `puente`: no son cuentas
 *     nuestras y es correcto que no casen;
 *   - ⛔ `BAJIO 6506` (123 pagos) y `BAJIO 5854` (32) difieren en UN dígito de nuestras `BBAJIO
 *     506` y `BBAJIO 854`. Puede ser un cero comido de cualquiera de los dos lados, pero
 *     **adivinarlo elige de qué cuenta sale el dinero**, y eso lo confirma una persona. Hasta
 *     entonces salen como `no_resuelve` y la pantalla pide la cuenta a mano, como hoy.
 */

/** Los acreedores con esta concentración o más reciben propuesta; abajo se declara «variable». */
const PISO = 0.8;
/** Tope de costo de la vista. La lección de [PGP.27]: una vista cara se revierte sola en prod. */
const TOPE_MS = 1000;

const CUERPO = `
  CREATE OR REPLACE VIEW analytics.v_supplier_payment_habit AS
  WITH
  -- 1 · El puente Kepler -> nuestro catálogo de cuentas. Dos reglas, medidas arriba.
  puente AS (
    SELECT k.c AS nombre_kepler, b.id AS bank_account_id, b.alias AS cuenta_nombre
      FROM (SELECT DISTINCT cuenta_tesoreria AS c,
                   regexp_replace(upper(cuenta_tesoreria), '[^A-Z]', '', 'g') AS banco,
                   (regexp_match(cuenta_tesoreria, '([0-9]{3,})'))[1] AS dig
              FROM analytics.erp_supplier_payments
             WHERE cuenta_tesoreria IS NOT NULL) k
      JOIN LATERAL (
        SELECT a.id, a.alias
          FROM finance.bank_accounts a
         WHERE upper(btrim(coalesce(a.alias, ''))) = upper(btrim(k.c))
            OR upper(btrim(coalesce(a.account_label, ''))) = upper(btrim(k.c))
            OR ( regexp_replace(coalesce(a.account_label, ''), '[^0-9]', '', 'g') = k.dig
                 AND k.dig IS NOT NULL
                 AND ( regexp_replace(upper(coalesce(a.bank, '')), '[^A-Z]', '', 'g') = k.banco
                    OR regexp_replace(upper(coalesce(a.bank, '')), '[^A-Z]', '', 'g') LIKE '%' || k.banco
                    OR k.banco LIKE '%' || regexp_replace(upper(coalesce(a.bank, '')), '[^A-Z]', '', 'g') ) )
         LIMIT 1) b ON true),
  -- 2 · El método. 'anticipo' fuera: no es un método, es la naturaleza del documento.
  met AS (
    SELECT proveedor_code, metodo_pago, count(*) AS n, max(pago_date) AS ultima,
           sum(count(*)) OVER (PARTITION BY proveedor_code) AS tot
      FROM analytics.erp_supplier_payments
     WHERE metodo_pago IN ('transferencia', 'cheque')
     GROUP BY 1, 2),
  met1 AS (
    SELECT DISTINCT ON (proveedor_code) proveedor_code, metodo_pago, n, tot, ultima
      FROM met ORDER BY proveedor_code, n DESC, metodo_pago),
  -- 3 · La cuenta de origen, ya traducida a nuestro catálogo.
  cta AS (
    SELECT p.proveedor_code, p.cuenta_tesoreria, pu.bank_account_id, pu.cuenta_nombre,
           count(*) AS n, max(p.pago_date) AS ultima,
           sum(count(*)) OVER (PARTITION BY p.proveedor_code) AS tot
      FROM analytics.erp_supplier_payments p
      LEFT JOIN puente pu ON pu.nombre_kepler = p.cuenta_tesoreria
     WHERE p.cuenta_tesoreria IS NOT NULL
     GROUP BY 1, 2, 3, 4),
  cta1 AS (
    SELECT DISTINCT ON (proveedor_code) proveedor_code, cuenta_tesoreria, bank_account_id,
           cuenta_nombre, n, tot, ultima
      FROM cta ORDER BY proveedor_code, n DESC, cuenta_tesoreria)
  SELECT
    (nullif(current_setting('app.tenant_id', true), ''))::uuid AS tenant_id,
    coalesce(m.proveedor_code, c.proveedor_code) AS proveedor_code,

    -- Método
    CASE WHEN m.proveedor_code IS NULL THEN 'sin_historial'
         WHEN m.n::numeric / m.tot >= ${PISO} THEN 'estable'
         ELSE 'variable' END AS metodo_estado,
    CASE WHEN m.n::numeric / m.tot >= ${PISO} THEN m.metodo_pago END AS metodo_sugerido,
    m.n AS metodo_veces, m.tot AS metodo_de, m.ultima AS metodo_ultima_vez,

    -- Cuenta de origen
    CASE WHEN c.proveedor_code IS NULL THEN 'sin_historial'
         WHEN c.bank_account_id IS NULL THEN 'no_resuelve'
         WHEN c.n::numeric / c.tot >= ${PISO} THEN 'estable'
         ELSE 'variable' END AS cuenta_estado,
    CASE WHEN c.bank_account_id IS NOT NULL AND c.n::numeric / c.tot >= ${PISO}
         THEN c.bank_account_id END AS cuenta_origen_id,
    CASE WHEN c.bank_account_id IS NOT NULL AND c.n::numeric / c.tot >= ${PISO}
         THEN c.cuenta_nombre END AS cuenta_origen_nombre,
    c.cuenta_tesoreria AS cuenta_kepler,
    c.n AS cuenta_veces, c.tot AS cuenta_de, c.ultima AS cuenta_ultima_vez
  FROM met1 m
  FULL OUTER JOIN cta1 c ON c.proveedor_code = m.proveedor_code
`;

const COMENTARIO = `
  COMMENT ON VIEW analytics.v_supplier_payment_habit IS
    'PGP.30 - Con que se le suele pagar a cada acreedor, derivado de analytics.erp_supplier_payments. PROPONE, no decide: cada sugerencia viaja con veces/de/ultima_vez. No propone efectivo ni cargo_automatico porque Kepler (kdm1.c31) no los distingue, y excluye anticipo porque no es un metodo. La cuenta de origen se traduce al catalogo propio por alias o por banco+digitos: 16 de 20 cuentas, 96.7 % de los pagos; las que no resuelven salen como no_resuelve, nunca adivinadas.'
`;

exports.up = async function up(knex) {
  await knex.raw(CUERPO);
  await knex.raw(COMENTARIO);
  await knex.raw('GRANT SELECT ON analytics.v_supplier_payment_habit TO app_runtime');
  await knex.raw('GRANT SELECT ON analytics.v_supplier_payment_habit TO dev_ro');

  // ── La compuerta de costo. [PGP.27] se revirtio sola en prod por 5,349 ms contra un tope
  //    de 1,000: la medicion va ANTES de dar la migracion por buena, no despues.
  //    Se mide DOS veces y se cita la segunda: la primera paga el calentamiento de cache.
  const SONDA = `SELECT proveedor_code, metodo_sugerido, cuenta_origen_id, cuenta_origen_nombre,
                        metodo_veces, cuenta_veces FROM analytics.v_supplier_payment_habit`;
  await knex.raw(SONDA);
  const t0 = process.hrtime.bigint();
  const filas = await knex.raw(SONDA);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;

  const r = filas.rows || [];
  const conMetodo = r.filter((x) => x.metodo_sugerido).length;
  const conCuenta = r.filter((x) => x.cuenta_origen_id).length;
  console.log(`[PGP.30] ${r.length} acreedores · ${conMetodo} con metodo propuesto · ${conCuenta} con cuenta propuesta · ${ms.toFixed(0)} ms`);

  if (ms > TOPE_MS) {
    throw new Error(`[PGP.30] la vista cuesta ${ms.toFixed(0)} ms, tope ${TOPE_MS} ms. Se revierte: una propuesta no vale frenar la pantalla.`);
  }
  // Una vista que no propone nada no es barata: esta rota.
  if (conMetodo === 0) {
    throw new Error('[PGP.30] 0 acreedores con metodo propuesto. La vista no sirve; se revierte.');
  }
};

exports.down = async function down(knex) {
  await knex.raw('DROP VIEW IF EXISTS analytics.v_supplier_payment_habit');
};

exports.SQL = { CUERPO, PISO, TOPE_MS };
