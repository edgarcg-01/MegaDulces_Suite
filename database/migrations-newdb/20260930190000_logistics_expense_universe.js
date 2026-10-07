'use strict';
/**
 * `[CGU.8]` — **El universo del costo estaba a la mitad: entra TODO el gasto del departamento,
 * no sólo las cuentas con nombre de transporte.**
 *
 * ── Qué se midió, y por qué esto es grave ─────────────────────────────────────────────
 *
 * `[CGU.0]` filtraba por cuenta mayor `602/604/606/611` —las que se *llaman* logísticas—. Contra
 * prod, 12 meses, sumando **todo** lo que gastan los departamentos que mueven guías
 * (`TLMKT*`, `*RD*`, `LOGISTICA*`):
 *
 *     lo que contaba  (602/604/606/611)   $11,764,551.95
 *     lo real del departamento (6xx+762)  $22,807,307.78
 *     ──────────────────────────────────────────────────
 *     quedaba FUERA                       $11,042,755.83  = 48.4 %
 *
 * ⭐ **El renglón que faltaba es el más obvio en cuanto se nombra: `601 SUELDOS Y SALARIOS,
 * $8,710,226`.** El chofer, el repartidor y el de telemarketing cobran sueldo, y ese sueldo es
 * costo del viaje tanto como su combustible. Le siguen `603` local ($1,349,776), `762` impuesto
 * sobre nómina ($478,317), `608` administrativos ($212,204) y `613`/`605` tecnología.
 *
 * ⛔ **La lección: la cuenta contable dice en qué se gastó, el DEPARTAMENTO dice para qué canal.**
 * Filtrar por el nombre de la cuenta parecía prudente y subdeclaraba la mitad. El centro de costo
 * ya estaba resolviendo el canal desde `[CGU.0]`; lo que faltaba era confiar en él también para
 * decidir qué entra.
 *
 * ── Qué entra y qué NO, con motivo ────────────────────────────────────────────────────
 *
 * **Entra**: toda la familia `6xx` del departamento (601 sueldos, 602 logísticos, 603 local, 604
 * mobiliario, 605/613 tecnología, 606 publicidad y acarreo, 607 contables, 608 administrativos,
 * 609 dirección, 610 papelería, 611 ventas, 612 otros) **más `762` impuesto sobre nómina**, que
 * es inseparable del sueldo: pagarle al chofer cuesta el sueldo Y su impuesto.
 *
 * **NO entra, y se declara:**
 * - `150` **activo no circulante** ($562,611): comprar una camioneta no es gasto del viaje, se
 *   capitaliza y se deprecia. Cargarla al mes de la compra pondría un viaje en rojo y regalaría
 *   los 59 siguientes.
 * - `761` / `763` **ISR e impuesto cedular** ($118,471): impuestos corporativos sobre resultado,
 *   no costo de servir.
 * - `702` **gastos financieros**: costo del dinero, no de la entrega.
 * - `511` **compra de mercancía**: es el costo de lo que se mueve, no de moverlo. Va en su propio
 *   bloque, separado de los operativos, por pedido explícito. Medido: en los departamentos
 *   logísticos el `511` es **cero** — la compra no se carga a estos centros de costo, así que no
 *   había riesgo de doble conteo, pero el filtro lo deja explícito igual.
 *
 * ⚠️ **Esto multiplica por ~1.94 el costo publicado por guía.** No es un ajuste cosmético: la
 * pantalla venía diciendo que mover mercancía cuesta la mitad de lo que cuesta.
 *
 * @param { import("knex").Knex } knex
 */

exports.up = async function up(knex) {
  const [{ ok }] = (await knex.raw(
    `SELECT to_regclass('analytics.v_logistics_expense_channel') IS NOT NULL AS ok`)).rows;
  if (!ok) throw new Error('[CGU.8] falta analytics.v_logistics_expense_channel ([CGU.0])');

  await knex.raw(`
    CREATE OR REPLACE VIEW analytics.v_logistics_expense_channel
      WITH (security_invoker = true) AS
    SELECT
      e.tenant_id,
      e.fecha::date AS dia,
      CASE
        WHEN e.dpto_nombre ~* 'TLMK'                           THEN 'cliente'
        WHEN e.dpto_nombre ~* '(^| )RD( |$)|RUTAS? +DIRECTAS?' THEN 'carga_ruta'
        WHEN e.dpto_nombre ~* 'LOGISTICA'                      THEN 'traspaso'
        WHEN e.dpto_nombre ~* 'VECINAL'                        THEN 'vecinal'
        WHEN e.dpto_nombre ~* 'PISO'                           THEN 'piso_venta'
        ELSE 'otros'
      END AS canal,
      COALESCE(NULLIF(btrim(e.concepto_nombre), ''), '(sin concepto)') AS concepto,
      left(e.cuenta, 3) AS cuenta_mayor,
      (e.dpto_nombre IS NULL OR btrim(e.dpto_nombre) = '') AS sin_dpto,
      count(*)::int AS lineas,
      round(sum(e.importe * CASE WHEN e.cargo_abono = 'A' THEN -1 ELSE 1 END)::numeric, 2) AS gasto,
      -- ⚠️ familia_costo va AL FINAL y no donde se leeria mejor: CREATE OR REPLACE VIEW solo
      -- permite APENDAR columnas -- insertarla en el medio da "cannot change name of view
      -- column". Y un DROP no es opcion: la matview del costo cuelga de esta vista.
      -- Separa el sueldo del fierro sin perder ninguno de los dos.
      CASE
        WHEN left(e.cuenta, 3) IN ('601', '762') THEN 'personal'
        WHEN left(e.cuenta, 3) = '602'           THEN 'transporte'
        WHEN left(e.cuenta, 3) = '611'           THEN 'venta'
        WHEN left(e.cuenta, 3) = '603'           THEN 'local'
        WHEN left(e.cuenta, 3) IN ('605', '613') THEN 'tecnologia'
        WHEN left(e.cuenta, 3) = '606'           THEN 'promocion'
        ELSE 'otros_operativos'
      END AS familia_costo
    FROM analytics.expense_entries e
    -- ⭐ TODO el gasto operativo: la familia 6xx completa + el impuesto sobre nomina, que viaja
    -- con el sueldo. Antes eran solo 602/604/606/611 y eso dejaba fuera el 48.4%.
    WHERE (left(e.cuenta, 1) = '6' OR left(e.cuenta, 3) = '762')
      -- ⛔ Lo que NO es costo de servir, excluido a proposito (ver el docblock):
      --    150 activo (se deprecia) · 761/763 impuestos corporativos · 702 financieros
      --    · 511 mercancia (su propio bloque, pedido explicito)
      AND left(e.cuenta, 3) NOT IN ('150', '511', '702', '761', '763')
    GROUP BY 1, 2, 3, 4, 5, 6, 9
  `);

  await knex.raw(`GRANT SELECT ON analytics.v_logistics_expense_channel TO app_runtime`);

  await knex.raw(`
    COMMENT ON VIEW analytics.v_logistics_expense_channel IS
    $$[CGU.8] Gasto OPERATIVO de logistica por canal x dia x concepto. El universo es toda la
    familia 6xx del departamento + 762 (impuesto sobre nomina, inseparable del sueldo), NO solo
    las cuentas que se llaman logisticas: filtrar por 602/604/606/611 dejaba fuera 11,042,755.83
    de 22,807,307.78 = 48.4%, y el renglon que faltaba era 601 SUELDOS (8,710,226) -- el chofer
    cobra sueldo y eso es costo del viaje. La cuenta dice en que se gasto, el DEPARTAMENTO dice
    para que canal. Excluidos con motivo: 150 activo (se capitaliza y deprecia), 761/763 impuestos
    corporativos, 702 financieros, 511 mercancia (bloque aparte; medido CERO en estos
    departamentos, asi que no habia doble conteo). familia_costo separa personal de fierro sin
    perder ninguno.$$
  `);
};

exports.down = async function down(knex) {
  // Vuelve al universo angosto de [CGU.0]. Se deja explicito que eso SUBDECLARA.
  await knex.raw(`
    CREATE OR REPLACE VIEW analytics.v_logistics_expense_channel
      WITH (security_invoker = true) AS
    SELECT e.tenant_id, e.fecha::date AS dia,
      CASE
        WHEN e.dpto_nombre ~* 'TLMK'                           THEN 'cliente'
        WHEN e.dpto_nombre ~* '(^| )RD( |$)|RUTAS? +DIRECTAS?' THEN 'carga_ruta'
        WHEN e.dpto_nombre ~* 'LOGISTICA'                      THEN 'traspaso'
        WHEN e.dpto_nombre ~* 'VECINAL'                        THEN 'vecinal'
        WHEN e.dpto_nombre ~* 'PISO'                           THEN 'piso_venta'
        ELSE 'otros' END AS canal,
      COALESCE(NULLIF(btrim(e.concepto_nombre), ''), '(sin concepto)') AS concepto,
      left(e.cuenta, 3) AS cuenta_mayor,
      (e.dpto_nombre IS NULL OR btrim(e.dpto_nombre) = '') AS sin_dpto,
      count(*)::int AS lineas,
      round(sum(e.importe * CASE WHEN e.cargo_abono = 'A' THEN -1 ELSE 1 END)::numeric, 2) AS gasto,
      'otros_operativos'::text AS familia_costo
    FROM analytics.expense_entries e
    WHERE left(e.cuenta, 3) IN ('602', '604', '606', '611')
    GROUP BY 1, 2, 3, 4, 5, 6
  `);
  await knex.raw(`GRANT SELECT ON analytics.v_logistics_expense_channel TO app_runtime`);
};
