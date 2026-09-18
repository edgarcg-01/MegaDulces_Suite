/**
 * CG.10b — El CONCEPTO de Kepler, derivado del ODS (ADR-070).
 *
 * Tercer nivel de la jerarquía contable de Kepler, el que faltaba para que un movimiento de
 * efectivo sea posteable (GX.5, mig 20260707130000):
 *   Mayor     split_part(c3,'-',1)   601      SUELDOS Y SALARIOS   ← kdc126
 *   Subcuenta c3 completo            601-001  SUELDOS              ← kdc126 / finance.kepler_accounts
 *   Concepto  kdc.c20 → kdco(c3,c1)  001      NÓMINA BANCOS        ← ESTA vista
 *
 * DERIVE-NO-COPY: `kepler_ods.kdco` ya viaja por el carril hash del ODS
 * (ops/vl/docker-compose.yml ODS_HASH_TABLES) y NINGÚN consumidor lo leía. Cero importer,
 * cero tabla: se refresca solo con el CDC. `analytics.*` no lleva RLS → tenant explícito,
 * mismo patrón que analytics.erp_shipment_trips (mig 20260917160000).
 *
 * MEDIDO contra el ODS antes de escribir esta vista (2026-09-18, platform_test):
 *   · 2,320 filas · 7 sucursales · 173 subcuentas distintas.
 *   · `(sucursal, c3, c1)` es ÚNICA → 0 llaves repetidas. Ésa es la PK natural.
 *   · ⚠️ **54 pares `(c3,c1)` tienen NOMBRE DISTINTO entre sucursales** → el concepto NO es
 *     global, es POR SUCURSAL. Colapsar por `(c3,c1)` elegiría un nombre arbitrario para esos
 *     54; por eso `sucursal` va en la llave de la vista y NO se deduplica.
 *   · ⚠️ 61 filas traen `c3` VACÍO (cadena '', no NULL — `IS NOT NULL` no las filtra). Un
 *     concepto sin subcuenta no puede postear, así que queda FUERA del catálogo usable… pero
 *     se CUENTA en la vista de cobertura: una fila ausente en un LEFT JOIN se lee como cero
 *     (ADR-056), y "no hay conceptos" es indistinguible de "el carril se cayó".
 *
 * @param { import("knex").Knex } knex
 */

const M = '00000000-0000-0000-0000-00000000d01c';

exports.up = async function (knex) {
  await knex.raw(`CREATE SCHEMA IF NOT EXISTS analytics`);

  // Sin kdco en el ODS la vista no compila: se declara y se sale (idempotente, no revienta
  // un `migrate:latest` en un entorno sin el carril del ODS).
  const kdco = await knex.raw(`SELECT to_regclass('kepler_ods.kdco') AS t`);
  if (!kdco.rows[0].t) {
    // eslint-disable-next-line no-console
    console.warn('[CG.10b] kepler_ods.kdco no existe en esta DB → vista NO creada (declarado).');
    return;
  }

  await knex.raw(`DROP VIEW IF EXISTS analytics.v_kepler_conceptos_coverage`);
  await knex.raw(`DROP VIEW IF EXISTS analytics.v_kepler_conceptos`);

  // Catálogo USABLE: lo que sí puede postear un movimiento.
  await knex.raw(`
    CREATE VIEW analytics.v_kepler_conceptos AS
    SELECT '${M}'::uuid                      AS tenant_id,
           btrim(k.sucursal)                 AS sucursal,
           btrim(k.c3)                       AS cuenta,      -- subcuenta, ej '601-001'
           btrim(k.c1)                       AS concepto,    -- código,    ej '001'
           btrim(k.c2)                       AS concepto_nombre,
           split_part(btrim(k.c3), '-', 1)   AS cuenta_mayor
      FROM kepler_ods.kdco k
     WHERE btrim(coalesce(k.c3, '')) <> ''
       AND btrim(coalesce(k.c1, '')) <> ''
       AND btrim(coalesce(k.c2, '')) <> ''`);
  await knex.raw(`GRANT SELECT ON analytics.v_kepler_conceptos TO app_runtime`);

  // COBERTURA: lo que quedó fuera, con motivo. Sin esto, un catálogo vacío se ve igual que
  // uno sano desde el consumidor.
  await knex.raw(`
    CREATE VIEW analytics.v_kepler_conceptos_coverage AS
    SELECT '${M}'::uuid                                            AS tenant_id,
           btrim(k.sucursal)                                       AS sucursal,
           count(*)::int                                           AS filas_origen,
           count(*) FILTER (WHERE btrim(coalesce(k.c3,'')) <> ''
                              AND btrim(coalesce(k.c1,'')) <> ''
                              AND btrim(coalesce(k.c2,'')) <> '')::int  AS usables,
           count(*) FILTER (WHERE btrim(coalesce(k.c3,'')) = '')::int   AS sin_subcuenta,
           count(*) FILTER (WHERE btrim(coalesce(k.c1,'')) = '')::int   AS sin_codigo,
           count(*) FILTER (WHERE btrim(coalesce(k.c2,'')) = '')::int   AS sin_nombre
      FROM kepler_ods.kdco k
     GROUP BY 2`);
  await knex.raw(`GRANT SELECT ON analytics.v_kepler_conceptos_coverage TO app_runtime`);
};

exports.down = async function (knex) {
  await knex.raw(`DROP VIEW IF EXISTS analytics.v_kepler_conceptos_coverage`);
  await knex.raw(`DROP VIEW IF EXISTS analytics.v_kepler_conceptos`);
};
