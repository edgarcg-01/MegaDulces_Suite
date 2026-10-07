'use strict';
/**
 * `[CGU.0]` — **`analytics.v_logistics_expense_channel`: el gasto logistico, clasificado por el
 * CANAL que lo consumio, por dia y por tipo de gasto.**
 *
 * ── Por que existe ────────────────────────────────────────────────────────────────────
 *
 * Pedido: *"tenemos costos operativos demasiado altos; necesito cazar estos costos por cada guia
 * o traspaso"*. Para eso primero hay que saber a QUE canal pertenece cada peso. Esta vista es el
 * primer eslabon: NO atribuye a la guia todavia (eso es `[CGU.2]`), solo clasifica.
 *
 * ── La columna que resuelve el problema, y la que NO ──────────────────────────────────
 *
 * ⭐ **`expense_entries.dpto_nombre` es el centro de costo**, y sus valores calcan los canales
 * operativos de la empresa. Medido contra prod (12 meses, cuentas 602+611): cobertura **97.2 %**
 * (10,791 de 11,100 filas).
 *
 *     RD PADRE HIDALGO / CANINDO RD              -> carga_ruta   (surtido a camioneta de reparto)
 *     TLMKT PH / MORELIA TLMK / TLMKT CANINDO    -> cliente      (telemarketing, el que factura)
 *     LOGISTICA GENERAL                          -> traspaso     (entre almacenes propios)
 *     *VECINAL*                                  -> vecinal
 *     *PISO*                                     -> piso_venta   (mostrador, NO es logistica)
 *     resto                                      -> otros
 *
 * ⛔ **`beneficiario` NO sirve de llave, probado y descartado.** En 12 meses trae agrupadores que
 * parecen calcar los canales (`TLMK PH` $328,660, `RD PH` $347,349, `RUTAS DIRECTAS PH` $311,667),
 * pero medido sobre 30 dias etiquetan **$121,564 de $1,595,918 = 7.6 %**; el 92.4 % cae en "sin
 * canal". Y solo **62 de 4,303 filas (1.4 %)** traen algo con forma de placa, unidad o ruta.
 * *Un agrupador que existe en el acumulado no es un agrupador que exista en el mes.*
 *
 * ── Que es una fila de la fuente ──────────────────────────────────────────────────────
 *
 * `analytics.expense_entries` tiene como grano **un RENGLON DE POLIZA** (el lado cargo, `c4='C'`),
 * no el documento: un XA2001 con 5 cuentas de costo produce 5 filas. Es el grano atomico del gasto
 * contable y por eso es la fuente correcta para "desglosar hasta el minimo gasto".
 *
 * ── El universo: que cuentas son logistica ────────────────────────────────────────────
 *
 * Mayores `602` (transporte y vehiculos) + `604` (carretas, diablos, montacargas) + `606` (bolsa e
 * insumos de acarreo) + `611` (combustible y viaticos de ventas). Medido: **$20.6 M / 12 meses**
 * y **$1,728,274 en 30 dias**.
 *
 * ⚠️ **NO se incluye la cuenta de fletes `401-002`** aunque el nombre invite: tiene **$352 M de
 * venta de mercancia reclasificada** ahi desde ene-2026 (ver `project_ledger_monthly_no_sirve_para
 * _margen` y `docs/VERDAD_ABSOLUTA.md`). Costear transporte con esa cuenta seria costear con venta.
 *
 * ── Lo que esta vista NO hace ─────────────────────────────────────────────────────────
 *
 * No reparte `otros` entre canales (eso es `[CGU.2]`, y ahi se marca como atribuido), no toca la
 * guia, y no decide si el canal es "logistico": publica `piso_venta` y `vecinal` tambien, para que
 * el consumidor los excluya con criterio propio y el total siga cuadrando contra la contabilidad.
 *
 * @param { import("knex").Knex } knex
 */

exports.up = async function up(knex) {
  const [{ ok }] = (await knex.raw(
    `SELECT to_regclass('analytics.expense_entries') IS NOT NULL AS ok`
  )).rows;
  if (!ok) {
    // eslint-disable-next-line no-console
    console.log('  falta analytics.expense_entries - vista omitida');
    return;
  }

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
      -- La cuenta contable viaja para que el drill pueda bajar sin re-derivar el universo.
      left(e.cuenta, 3) AS cuenta_mayor,
      -- dpto_nombre NULL no es lo mismo que un dpto que no reconocemos: el consumidor necesita
      -- poder medir la cobertura y no puede si los dos llegan como 'otros' a secas.
      (e.dpto_nombre IS NULL OR btrim(e.dpto_nombre) = '') AS sin_dpto,
      count(*)::int AS lineas,
      -- ⚠️ El signo va explicito aunque HOY no cambie nada: medido sobre 12 meses, las cuentas
      -- logisticas traen **12,415 lineas y las 12,415 son cargo** ('C'), cero abonos -- el importer
      -- de polizas solo guarda el lado cargo. Pero si algun dia entra una nota de credito del
      -- proveedor, sumarla a ciegas la contaria como GASTO en vez de restarla, y el error seria
      -- invisible: el total simplemente saldria mas alto. Es una linea, y cierra la puerta.
      round(sum(e.importe * CASE WHEN e.cargo_abono = 'A' THEN -1 ELSE 1 END)::numeric, 2) AS gasto
    FROM analytics.expense_entries e
    WHERE left(e.cuenta, 3) IN ('602', '604', '606', '611')
    GROUP BY 1, 2, 3, 4, 5, 6
  `);

  await knex.raw(`GRANT SELECT ON analytics.v_logistics_expense_channel TO app_runtime`);

  await knex.raw(`
    COMMENT ON VIEW analytics.v_logistics_expense_channel IS
    $$[CGU.0] Gasto logistico (cuentas mayor 602/604/606/611) clasificado por CANAL x dia x
    concepto. El canal sale de expense_entries.dpto_nombre, el centro de costo, con 97.2% de
    cobertura medida. NO usar beneficiario para esto: etiqueta solo el 7.6% (medido, 30 dias).
    El grano de la fuente es el RENGLON DE POLIZA, no el documento. sin_dpto separa "no tiene
    departamento" de "tiene uno que no reconocemos" -- los dos caen en canal=otros y sin esa
    bandera no se puede medir la cobertura. NO incluye la cuenta de fletes 401-002: tiene 352 MDP
    de venta de mercancia reclasificada (ver docs/VERDAD_ABSOLUTA.md). El reparto de otros entre
    canales NO se hace aqui, se hace en CGU.2 y se marca como atribuido.$$
  `);
};

exports.down = async function down(knex) {
  await knex.raw(`DROP VIEW IF EXISTS analytics.v_logistics_expense_channel`);
};
