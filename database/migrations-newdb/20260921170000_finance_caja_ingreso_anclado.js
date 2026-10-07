/**
 * CG.19 Capa 1 — **El ingreso de la caja se ANCLA a un cobro de Kepler** (ADR-070).
 *
 * ── El invariante ────────────────────────────────────────────────────────────────────────────
 *
 * «El valor se TOMA de Kepler» y «el registro precede al movimiento del dinero». Aplicado al
 * ingreso de la caja general: el capturista deja de teclear un monto y pasa a **elegir un cobro
 * que Kepler YA registró**. El monto viaja del ERP, no del teclado; el documento existe antes de
 * que el efectivo se mueva.
 *
 * ── ⛔ Lo que este archivo NO hace, y por qué (refutación MEDIDA del plan aprobado) ───────────
 *
 * El plan decía que el `esperado` del corte debía salir de
 * `analytics.customer_receivables.saldo_ajustado`. **Está refutado:**
 *
 *   · Los 1,504 documentos con estatus `EFECTIVO` suman **$85,951,094.54 de importe** contra
 *     **$915.00 de saldo**. El saldo de cartera mide justamente lo que **NO** se volvió efectivo.
 *   · Para los clientes de ruta (`RD028`, `RV002`, …) `saldo_ajustado` viene **0 o NULL**.
 *   · Y las dos cifras se mueven en **direcciones opuestas**: mientras más cobra la ruta, más
 *     efectivo hay en el cajón y más BAJA el saldo. Como `esperado`, mediría al revés.
 *
 * La fuente correcta es el **COBRO**, no el saldo: `analytics.erp_collections` (vista viva sobre
 * `kepler_ods.kdm1`, doctype `U-A-5-1`). Su llave `(sucursal, folio)` está **medida** como
 * identidad real — **2,708 llaves para 2,708 filas** de `tipo_cuenta='ruta'` (regla M2: una
 * identidad se mide contra el corpus antes de declararse, no se asume).
 *
 * ── ⚠️ Cobertura: esto NO cubre todo el ingreso, y no se finge que sí ────────────────────────
 *
 * Medido contra la caja general viva, por mes de 2026:
 *
 *     mes        cobros de ruta (Kepler)     ingreso caja general
 *     2026-01    $5,381,509.60  (291)        $9,945,253.20  (282)
 *     2026-07    $6,069,314.86  (384)        $10,452,178.12 (320)
 *
 * O sea ~55-60%. El resto —préstamos, pagarés, directivos, venta de piso— sigue siendo captura
 * humana y **se declara** (`cobertura_ingreso` en `cash-cut.engine.ts`), en vez de dibujarse como
 * si el esperado ya viniera del ERP (ADR-056).
 *
 * ⚠️ En `platform_test` sep-2026 viene corto del lado Kepler ($361k/23 contra $4.49M/247): es
 * rezago del feed en la base de pruebas, NO un hallazgo de negocio. Se dice para que nadie lo lea
 * como una caída de cobranza.
 *
 * ── ⛔ Trampa M1 encontrada acá: declarada, NO arreglada en este commit ───────────────────────
 *
 * `analytics.erp_collections` calcula `tipo_cuenta` con este regex, **tal como está desplegado**
 * (leído con `pg_get_viewdef`):
 *
 *     ^(RUTA|R\.$1[DV]\.$2|R[DV][\s\-0-9])
 *
 * El autor escribió `R\.?[DV]\.?` y **knex se comió los dos signos de interrogación** (para
 * `knex.raw` ese carácter es un marcador de parámetro), dejando los literales `$1` y `$2` en
 * producción. Es exactamente el bug que ya costó una columna entera publicada en NULL.
 *
 * **Daño medido: CERO.** 24 clientes distintos caen en `ruta` con el regex roto y 24 con el
 * correcto; 0 códigos de diferencia, $0 en juego — las dos ramas comidas eran redundantes con
 * `R[DV][\s\-0-9]`, que ya atrapa `RD 501`, `RD028` y `RV002` (la forma con puntos vive en
 * `cliente_nombre`, no en `cliente_code`). Queda como **trampa latente**: el día que alguien dé
 * de alta `R.D.501` se pierde en silencio.
 *
 * No se arregla acá a propósito: vive en `20260819220000_payments_collections_live_views.js`, es
 * de otra fase, y mezclar otra vista en la migración de esta capa hace el diff imposible de
 * revisar. Va en su propio commit, junto con la compuerta M1 que lo habría atrapado (leer el SQL
 * de vuelta con `pg_get_viewdef` y compararlo contra el escrito).
 *
 * ⛔ **NI UN signo de interrogación en el SQL de este archivo.** Cuantificadores con `{0,1}`.
 *
 * Aditiva e idempotente: no toca ninguna columna ni ninguna fila existente.
 *
 * @param { import("knex").Knex } knex
 */

exports.up = async function (knex) {
  // ── 1. Un cobro de Kepler no se puede aplicar DOS VECES ────────────────────────────────────
  //
  // `ix_cash_ledger_origen` existía pero NO es único (verificado en `pg_indexes`), así que nada
  // impedía registrar el mismo cobro dos veces y sumarlo dos veces al esperado. La identidad es
  // `(origen_tipo, origen_ref)`; `origen_ref` lleva 'sucursal|folio'.
  //
  // ⚠️ Es PARCIAL, no `UNIQUE NULLS NOT DISTINCT`: la mayoría de las filas (gastos, depósitos,
  // captura manual) tienen `origen_tipo` NULL, y con `NULLS NOT DISTINCT` sólo cabría UNA fila
  // sin origen en toda la tabla. "Sin origen" no es una identidad — es la ausencia de una.
  //
  // ⚠️ Excluye lo cancelado y lo borrado A PROPÓSITO: cancelar tiene que LIBERAR el documento
  // para poder volver a aplicarlo. Sin esa cláusula, un error de dedo dejaría ese cobro
  // inutilizable para siempre.
  await knex.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS ux_cash_ledger_origen_vivo
      ON finance.cash_ledger (tenant_id, origen_tipo, origen_ref)
      WHERE origen_tipo IS NOT NULL
        AND origen_ref  IS NOT NULL
        AND deleted_at  IS NULL
        AND estado <> 'cancelado'`);

  // ── 2. Qué se puede entregar y arquear: los cobros de Kepler todavía no aplicados ───────────
  //
  // Derive-no-copy sobre `analytics.erp_collections` (que ya es vista viva sobre el ODS), así que
  // la frescura es la del CDC y no hay nada que mantener. `security_invoker` para que la RLS de
  // `finance.cash_ledger` aplique con el usuario que pregunta, y el filtro de tenant DENTRO de la
  // vista porque `analytics.*` no tiene RLS.
  //
  // `tipo_cuenta` NO se filtra acá: viaja como columna para que el servicio decida y la decisión
  // quede a la vista. Filtrarlo dentro escondería en la definición una regla de negocio que hay
  // que poder discutir — y ese balde se calcula con el regex de arriba, que ya sabemos que no es
  // lo que su autor escribió.
  await knex.raw(`DROP VIEW IF EXISTS finance.v_caja_ingresos_pendientes`);
  await knex.raw(`
    CREATE VIEW finance.v_caja_ingresos_pendientes
      WITH (security_invoker = true) AS
    SELECT c.tenant_id,
           c.sucursal,
           c.folio,
           c.sucursal || '|' || c.folio            AS origen_ref,
           c.cobro_date,
           c.cliente_code,
           c.cliente_nombre,
           c.concepto,
           c.monto,
           c.tipo_cuenta,
           c.forma_pago
      FROM analytics.erp_collections c
     WHERE c.tenant_id = current_tenant_id()
       AND c.monto > 0
       AND NOT EXISTS (
             SELECT 1
               FROM finance.cash_ledger l
              WHERE l.tenant_id   = c.tenant_id
                AND l.origen_tipo = 'cobro'
                AND l.origen_ref  = c.sucursal || '|' || c.folio
                AND l.deleted_at IS NULL
                AND l.estado <> 'cancelado')`);
  await knex.raw(`GRANT SELECT ON finance.v_caja_ingresos_pendientes TO app_runtime`);

  // ── 3. Lo ya aplicado, por mes: el otro lado de la misma pregunta ──────────────────────────
  //
  // Sin esto, "pendiente" sería la única vista y no se podría auditar lo aplicado sin recorrer el
  // libro entero. Una caja sin nada anclado y una caja anclada al 100% no pueden verse igual
  // (ADR-056).
  await knex.raw(`DROP VIEW IF EXISTS finance.v_caja_ingreso_cobertura`);
  await knex.raw(`
    CREATE VIEW finance.v_caja_ingreso_cobertura
      WITH (security_invoker = true) AS
    SELECT l.tenant_id,
           l.sucursal,
           date_trunc('month', l.fecha)::date                                   AS mes,
           count(*)::int                                                        AS ingresos,
           count(*) FILTER (WHERE l.origen_tipo = 'cobro')::int                 AS anclados,
           count(*) FILTER (WHERE l.origen_tipo IS NULL)::int                   AS capturados,
           coalesce(sum(l.monto), 0)                                            AS monto,
           coalesce(sum(l.monto) FILTER (WHERE l.origen_tipo = 'cobro'), 0)     AS monto_anclado
      FROM finance.cash_ledger l
     WHERE l.tenant_id = current_tenant_id()
       AND l.tipo = 'ingreso'
       AND l.deleted_at IS NULL
       AND l.estado <> 'cancelado'
     GROUP BY 1, 2, 3`);
  await knex.raw(`GRANT SELECT ON finance.v_caja_ingreso_cobertura TO app_runtime`);
};

exports.down = async function (knex) {
  await knex.raw(`DROP VIEW IF EXISTS finance.v_caja_ingreso_cobertura`);
  await knex.raw(`DROP VIEW IF EXISTS finance.v_caja_ingresos_pendientes`);
  await knex.raw(`DROP INDEX IF EXISTS finance.ux_cash_ledger_origen_vivo`);
};
