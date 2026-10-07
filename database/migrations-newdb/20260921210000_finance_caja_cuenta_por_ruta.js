/**
 * CG.20 — **La cuenta contable de una entrega de ruta se DECLARA, para que nadie la elija** (ADR-070).
 *
 * ── Por qué ──────────────────────────────────────────────────────────────────────────────────
 *
 * El capturista teclea hoy campo por campo. Se midió contra la réplica cruda del Control
 * (`md:5433/caja_general`, 30 días): **338 de 374 ingresos (90 %) ya existen como cobro en
 * Kepler** — $5,336,935 de $6,508,337, el **82 % del dinero**. O sea que casi todo lo que la
 * persona escribe, el sistema ya lo sabe.
 *
 * `finance.v_caja_ingresos_pendientes` (CG.19.1) ya trae fecha, cliente, concepto y monto del ERP.
 * **Lo único que quedaba por elegir a mano es la cuenta contable** — y mientras haya que elegirla,
 * no se puede confirmar en lote. Estas dos columnas cierran ese hueco.
 *
 * ── Por qué DECLARADA y no derivada de un texto ──────────────────────────────────────────────
 *
 * El ingreso se concentra en 7 cuentas (medido, 30 días):
 *
 *     41000001  VENTAS RD LA PIEDAD              $2,348,794.26
 *     41000002  VENTAS RD ZAMORA                 $1,780,493.19
 *     41000003  PRESTAMO VENTAS PADRE HIDALGO      $991,027.00
 *     41000006  Nomina / Pagares                   $642,269.79
 *     41000007  Ventas Ruta Vecinal                $353,479.41
 *     41000000  Ventas De Vendedor                 $281,120.00
 *     10013     PHidalgo Ventas Vendedores         $110,403.00
 *
 * Sería fácil sacarlas de un regex sobre `NombreCliente`. **No se hace** (regla M3: no se liga por
 * atributos débiles). Ese texto llega en dos formas para la misma ruta — `26 Ruta 26`, `RUTA 21`,
 * `Ventas PH 26/08 RD 21` — y ya existe una tabla para esto, poblada por un humano.
 *
 * ⛔ **`41000003 PRESTAMO VENTAS PADRE HIDALGO` no se siembra como ruta.** El nombre dice préstamo,
 * son $991,027 (15 % del ingreso) y nadie confirmó que sea venta entregada. Sale **sin propuesta**,
 * que es el estado honesto (ADR-056).
 *
 * ── El candado que hace que esto valga ───────────────────────────────────────────────────────
 *
 * Una fila `derivado` sin `confirmed_at` **no alcanza** para confirmar en lote: cae a captura
 * manual. El `CHECK` de abajo lo vuelve mecánico — no se puede firmar una cuenta a medias, igual
 * que `rcm_par_chk` ya impedía firmar medio cliente.
 *
 * Aditiva e idempotente. No toca ninguna fila existente.
 *
 * @param { import("knex").Knex } knex
 */

exports.up = async function (knex) {
  const tiene = (col) => knex.schema.withSchema('finance').hasColumn('route_customer_map', col);

  if (!(await tiene('kepler_cuenta'))) {
    await knex.raw(`ALTER TABLE finance.route_customer_map ADD COLUMN kepler_cuenta text`);
  }
  if (!(await tiene('kepler_concepto'))) {
    await knex.raw(`ALTER TABLE finance.route_customer_map ADD COLUMN kepler_concepto text`);
  }

  // El par va COMPLETO o no va: media cuenta no contabiliza nada. Es el mismo criterio que
  // `cash_ledger_cuenta_chk`/`_concepto_chk` ya imponen en el libro, traído al mapa para que la
  // fila no pueda proponer algo que el libro va a rechazar después.
  await knex.raw(`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'rcm_cuenta_par_chk') THEN
        ALTER TABLE finance.route_customer_map
          ADD CONSTRAINT rcm_cuenta_par_chk CHECK (
            (kepler_cuenta IS NULL) = (kepler_concepto IS NULL)
          );
      END IF;
    END $$`);

  await knex.raw(`
    COMMENT ON COLUMN finance.route_customer_map.kepler_cuenta IS
      'CG.20 - Cuenta contable con la que entra la entrega de esta ruta. Declarada y confirmada por un humano: sin ella la entrega NO se puede confirmar en lote y cae a captura manual.'`);

  // ── La cobertura, extendida: sin esto no se puede decir cuánto del lote es confirmable ──────
  //
  // `confirmadas` ya existía y mide la identidad ruta↔cliente. Se agrega el otro eje: de las
  // confirmadas, cuántas además saben con qué cuenta entran. Una ruta puede tener cliente firmado
  // y cuenta en blanco — y eso NO se puede leer igual que "lista".
  await knex.raw(`DROP VIEW IF EXISTS finance.v_route_customer_map_coverage`);
  await knex.raw(`
    CREATE VIEW finance.v_route_customer_map_coverage
      WITH (security_invoker = true) AS
    SELECT tenant_id,
           count(*)::int                                                      AS rutas,
           count(*) FILTER (WHERE cliente_code IS NOT NULL)::int              AS con_propuesta,
           count(*) FILTER (WHERE cliente_code IS NULL)::int                  AS sin_propuesta,
           count(*) FILTER (WHERE confirmed_at IS NOT NULL)::int              AS confirmadas,
           count(*) FILTER (WHERE cliente_code IS NOT NULL
                              AND confirmed_at IS NULL)::int                  AS por_confirmar,
           count(*) FILTER (WHERE kepler_cuenta IS NOT NULL)::int             AS con_cuenta,
           count(*) FILTER (WHERE confirmed_at IS NOT NULL
                              AND kepler_cuenta IS NOT NULL)::int             AS listas_para_lote
      FROM finance.route_customer_map
     WHERE tenant_id = current_tenant_id()
     GROUP BY 1`);
  await knex.raw(`GRANT SELECT ON finance.v_route_customer_map_coverage TO app_runtime`);
};

exports.down = async function (knex) {
  await knex.raw(`DROP VIEW IF EXISTS finance.v_route_customer_map_coverage`);
  await knex.raw(`
    CREATE VIEW finance.v_route_customer_map_coverage
      WITH (security_invoker = true) AS
    SELECT tenant_id,
           count(*)::int                                                  AS rutas,
           count(*) FILTER (WHERE cliente_code IS NOT NULL)::int          AS con_propuesta,
           count(*) FILTER (WHERE cliente_code IS NULL)::int              AS sin_propuesta,
           count(*) FILTER (WHERE confirmed_at IS NOT NULL)::int          AS confirmadas,
           count(*) FILTER (WHERE cliente_code IS NOT NULL
                              AND confirmed_at IS NULL)::int              AS por_confirmar
      FROM finance.route_customer_map
     WHERE tenant_id = current_tenant_id()
     GROUP BY 1`);
  await knex.raw(`GRANT SELECT ON finance.v_route_customer_map_coverage TO app_runtime`);
  await knex.raw(`ALTER TABLE finance.route_customer_map DROP CONSTRAINT IF EXISTS rcm_cuenta_par_chk`);
  await knex.raw(`ALTER TABLE finance.route_customer_map DROP COLUMN IF EXISTS kepler_concepto`);
  await knex.raw(`ALTER TABLE finance.route_customer_map DROP COLUMN IF EXISTS kepler_cuenta`);
};
