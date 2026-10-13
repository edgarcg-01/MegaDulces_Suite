'use strict';
/**
 * ⭐⭐ `[CG.117]` — **Un ingreso de caja general queda ATADO a la venta de ruta que lo originó, y
 * de ahí sale su cuenta contable.**
 *
 * Edgar, 2026-10-13: *"analiza los ultimos ingresos registrados y vinculalos a ventas de ruta y
 * vecinal"* · *"actualmente se estan llenando manual por el mal funcionamiento de la app, hay que
 * vincularlos"*.
 *
 * ── Lo medido antes de escribir una línea (sólo lectura, prod 2026-10-13) ────────────────────
 *
 * Los 15 ingresos que hay en el libro son cobranza de ruta, y **12 ($191,978) cuadran al centavo**
 * contra `analytics.v_rd_route_daily` (`source='push'`):
 *
 *     CI-00008 $15,542 -> ruta 21 del 12-oct, venta $15,541.90   (delta +0.10)
 *     CI-00012 $10,755 -> ruta 28 del 10-oct, venta $10,755.48   (delta -0.48)
 *     ... 10 más, todas dentro de ±$0.50
 *
 * Los centavos no son error: **el depósito se redondea al peso** y las monedas quedan de morralla.
 *
 * ⭐ **Control de placebo** (un cruce por importe sin placebo no es evidencia): corriendo los
 * MISMOS importes +$500 / −$500 / ×1.01 contra el mismo universo, pegan **2–3 de 15**. El piso de
 * ruido es 13–20% y el pareo real es **80%**.
 *
 * ⭐⭐ Y hay un **segundo testigo independiente** en 10 de los 12: el texto que teclea la cajera
 * (`"rd 28 12 10 26"`, `"ruta22121026"`, `"RD 21 VICTORINO"`) nombra la MISMA ruta que señala el
 * importe. Dos derivaciones distintas del mismo hecho — que es lo que separa un cruce defendible
 * de un espejo.
 *
 * ── ⛔ El defecto que esto viene a cerrar: la cuenta está mal en las 15 ──────────────────────
 *
 * El árbitro es la póliza del propio Kepler. Un cobro `UA0501` tiene **exactamente dos renglones**:
 *
 *     cargo  102  (la caja / el banco)
 *     abono  115  ABONO A CLIENTES
 *
 * O sea que la contrapartida de un cobro de ruta es **`115/071`**. Lo que hay en el libro:
 *
 *     102 / 011  CAJA GENERAL            7 movs  $111,845   <- la caja contra SI MISMA
 *     201 / 201  PASIVO A PROVEEDORES    5 movs   $59,812   <- un cobro como deuda con proveedor
 *     607-002/089 HONORARIOS CONTADOR    3 movs   $56,668
 *     115 / 071                          0 movs        $0
 *
 * ⚠️ Y `115/071` **ya existía** en el catálogo de la sucursal `00` que la pantalla ofrece. No era
 * un hueco de catálogo: era que **nada lo proponía**, así que la persona elegía de una lista de
 * 2,840 conceptos la que sonara. *El autollenado no fallaba en los ingresos: no existía para ellos.*
 *
 * ── Por qué una TABLA y no otra vista ───────────────────────────────────────────────────────
 *
 * El vínculo es **dato propio** (HITL): lo decide una persona y no se puede derivar sin ambigüedad
 * — hay días con dos rutas del mismo importe. La VENTA sigue viviendo en el ODS y acá sólo se
 * guarda la llave (`route_code`, `business_date`) más una **foto** del importe pareado, para poder
 * auditar después si la venta cambió. Eso NO es copiar la tabla (regla principal del proyecto): es
 * la constancia de contra qué se ató, que es justamente lo que un re-cálculo no puede reconstruir.
 *
 * ⛔ **Un ingreso se ata a UNA venta** (`UNIQUE` parcial). Un día-ruta, en cambio, puede recibir
 * VARIOS ingresos: la cobranza se deposita en partes. Poner el único del lado equivocado habría
 * prohibido el caso normal.
 *
 * ⚠️ `monto_pareado` y `delta` se guardan AMBOS aunque uno se derive del otro. No es redundancia:
 * si la venta del ODS se corrige mañana, el delta guardado dice con qué cuadraba el día que se
 * ató, y el recalculado dice con qué cuadra hoy. Un solo campo no puede responder las dos.
 *
 * ── Vecinal: se DECLARA que no entra ────────────────────────────────────────────────────────
 *
 * **0 de 15** ingresos pegan con `source='kepler_vecinal'`, y en los mismos 5 días la vecinal
 * vendió **$324,677.73** (contra $462,192 de ruta). No se afirma que falte dinero —puede
 * depositarse en sucursal— pero sí que **caja general no lo ve**. La vista publica el canal para
 * que la ausencia sea visible en vez de pasar por "no hay".
 *
 * Idempotente.
 *
 * @param { import("knex").Knex } knex
 */

const TABLA = 'cash_ledger_route_links';

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

  // --- 1) El vínculo ------------------------------------------------------------------------
  if (!(await knex.schema.withSchema('finance').hasTable(TABLA))) {
    await knex.raw(`
      CREATE TABLE finance.${TABLA} (
        id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id       uuid NOT NULL,
        cash_ledger_id  uuid NOT NULL REFERENCES finance.cash_ledger(id) ON DELETE CASCADE,

        -- La llave de la venta en el ODS. No se copia la venta: se guarda con qué se ató.
        canal           text NOT NULL,
        route_code      text NOT NULL,
        business_date   date NOT NULL,

        -- La FOTO del día que se ató. Si el ODS se corrige, esto dice con qué cuadraba entonces.
        monto_pareado   numeric(14,2) NOT NULL,
        delta           numeric(14,2) NOT NULL,

        /**
         * ⭐ CÓMO se ató, y no es decoración: "importe_y_texto" tiene DOS testigos independientes
         * y "importe" tiene uno solo. El placebo midió que el importe solo acierta 80% con un
         * piso de ruido de 13–20%, así que los dos niveles no merecen la misma confianza y la
         * pantalla tiene que poder decirlo.
         */
        metodo          text NOT NULL,
        confianza       numeric(4,3),

        creado_por      uuid,
        creado_por_username text,
        created_at      timestamptz NOT NULL DEFAULT now(),
        deleted_at      timestamptz,

        CONSTRAINT cg_rl_canal_chk  CHECK (canal IN ('ruta','vecinal')),
        CONSTRAINT cg_rl_metodo_chk CHECK (metodo IN ('importe','importe_y_texto','manual')),
        -- Un método automático sin confianza es un veredicto sin medida; el manual no la necesita.
        CONSTRAINT cg_rl_conf_chk   CHECK (
          (metodo = 'manual' AND confianza IS NULL)
          OR (metodo <> 'manual' AND confianza > 0 AND confianza <= 1))
      )`);
  }

  // ⛔ El único va del lado del INGRESO, no del día-ruta: la cobranza se deposita en partes, así
  //    que un día-ruta recibe varios ingresos y prohibirlo habría roto el caso normal.
  await knex.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS cg_rl_un_ingreso
      ON finance.${TABLA} (tenant_id, cash_ledger_id) WHERE deleted_at IS NULL`);
  await knex.raw(`
    CREATE INDEX IF NOT EXISTS cg_rl_por_ruta
      ON finance.${TABLA} (tenant_id, business_date, route_code) WHERE deleted_at IS NULL`);

  await tenantRls(knex, TABLA);

  // --- 2) Los candidatos, DERIVADOS del ODS (cero importers) ---------------------------------
  /**
   * ⚠️ La tolerancia es **$3**, no $0: el depósito se redondea al peso y las monedas quedan de
   * morralla. Medido, los 12 pareos reales caen dentro de ±$0.50 — $3 deja margen sin abrir la
   * puerta a que cualquier cosa pegue (el placebo con ±$500 bajó a 2–3 de 15).
   *
   * ⭐ `n_candidatos` viaja en la fila. Un candidato único es una respuesta; tres candidatos del
   * mismo importe son una PREGUNTA, y la pantalla tiene que poder distinguirlas en vez de
   * quedarse con el primero que ordenó el motor.
   */
  await knex.raw(`
    CREATE OR REPLACE VIEW analytics.v_caja_ingreso_ruta_candidatos AS
    WITH ing AS (
      SELECT l.tenant_id, l.id AS cash_ledger_id, l.folio, l.fecha, l.monto,
             lower(coalesce(l.beneficiario,'') || ' ' || coalesce(l.glosa,'')) AS texto
        FROM finance.cash_ledger l
       WHERE l.tipo = 'ingreso' AND l.deleted_at IS NULL AND l.estado <> 'cancelado'
    ), v AS (
      /**
       * ⛔⛔ **ACÁ DECÍA "analytics.v_rd_route_daily" Y NO SE PUEDE USAR EN VIVO.** Medido contra
       * prod: acotada a 60 días tarda **13,450 ms** y sin acotar **se pasa de 120 s**. El gate de
       * la suite es <1 s, así que la pantalla habría quedado colgada o en blanco.
       *
       * ⭐ La matvista hermana ya existía: "mv_rd_route_daily_200d", 896 kB, **43 ms la tabla
       * entera** (2,596 filas, 27-mar → 06-dic). La refresca "AnalyticsRefreshService" cada 30
       * min. Cruzada contra la vista para el 12-oct da los mismos valores renglón por renglón
       * (ruta 21 $15,541.90, 22 $16,647.62, 23 $17,574.46, 26 $15,335.81, 27 $13,622.97, 28
       * $12,361.15) — dos derivaciones del mismo hecho, no una comparándose consigo misma.
       *
       * ⚠️ **No tiene latido**: ningún "analytics.cron_runs" la menciona (medido). Si el refresco
       * se para, los candidatos desaparecen y la pantalla leería "no hay venta que ligar" cuando
       * lo cierto es "no sé". Por eso la vista publica "datos_hasta" y la pantalla lo declara.
       */
      SELECT d.tenant_id, d.route_code, d.business_date::date AS business_date, d.venta, d.tickets,
             CASE WHEN d.source = 'kepler_vecinal' THEN 'vecinal' ELSE 'ruta' END AS canal,
             /**
              * ⛔ **El "max()" a secas dice "2026-12-06" y eso NO es frescura**: la venta trae
              * filas con fecha FUTURA, así que un "max()" sin tope se vería fresco para siempre
              * aunque el refresco llevara una semana parado. Se mide hasta HOY.
              */
             max(CASE WHEN d.business_date::date <= current_date THEN d.business_date::date END)
               OVER (PARTITION BY d.tenant_id) AS datos_hasta
        FROM analytics.mv_rd_route_daily_200d d
       WHERE d.venta > 0
    )
    SELECT i.tenant_id, i.cash_ledger_id, i.folio, i.fecha, i.monto,
           v.canal, v.route_code, v.business_date, v.venta, v.tickets, v.datos_hasta,
           round(i.monto - v.venta, 2) AS delta,
           /**
            * ⛔ **El segundo testigo —leer la ruta y el día de la prosa— NO se escribe acá.**
            * Ya existe desde "[CG.20]": "caja-ruta.engine.ts" ("leerVentaDeRuta"), con su suite y
            * con el corpus real adentro ("'Ventas 06//10 RD 21'", "'Ventas Canindo 02/10 RD504'",
            * la vecinal que entra por nombre de persona y devuelve "null"). Reescribirlo en un
            * regex de SQL habría dejado **dos** lectores del mismo texto que se contradicen en
            * cuanto alguien toque uno — y el de acá nacía peor: mi primera versión daba falso
            * negativo en ""ruta22121026"" (la fecha pegada al número).
            *
            * La vista hace lo que SÓLO se puede hacer en SQL —el pareo por importe contra la
            * venta— y el motor de TS pone el segundo testigo encima. El "texto" viaja para que el
            * servicio no tenga que volver a leer el movimiento.
            */
           i.texto,
           count(*) OVER (PARTITION BY i.cash_ledger_id) AS n_candidatos
      FROM ing i
      JOIN v ON v.tenant_id = i.tenant_id
            AND abs(i.monto - v.venta) <= 3
            -- La cobranza llega días después de la venta, nunca antes: medido, hasta 3 días.
            AND v.business_date BETWEEN i.fecha - 10 AND i.fecha`);

  // ⚠️ `security_invoker` y el GRANT NO sobreviven a un CREATE OR REPLACE: se re-aplican siempre
  //    (ADR-057). Sin el invoker la vista leería `cash_ledger` saltándose el RLS del tenant.
  await knex.raw(`ALTER VIEW analytics.v_caja_ingreso_ruta_candidatos SET (security_invoker = true)`);
  await knex.raw(`GRANT SELECT ON analytics.v_caja_ingreso_ruta_candidatos TO app_runtime`);

  // --- 3) La CONTRACUENTA del cobro, derivada de la póliza (nunca cableada) -------------------
  /**
   * ⭐⭐ **De acá sale la cuenta que los 15 ingresos no tienen.** El árbitro es la póliza del
   * propio Kepler (ADR-040/059): un cobro `UA0501` lleva **cargo a 102** (la caja) y **abono a
   * 115**. La contrapartida de un ingreso de cobranza es el abono.
   *
   * ⛔ No se escribe `'115'` en el código. Se **deriva**, por dos razones medidas: el catálogo
   * difiere por sucursal y el concepto (`071`) no está en la póliza —sólo el nombre—, así que se
   * resuelve contra `v_kepler_conceptos` **por nombre**. Medido: cuadra en **9 de 9** sucursales
   * (`00` con 16,700 renglones de respaldo) y devuelve `115/071 ABONO A CLIENTES` en todas.
   *
   * ⚠️ Si mañana la contabilidad cambia la cuenta, esto la sigue sola. Un `'115'` cableado habría
   * quedado mintiendo con la misma cara de siempre.
   *
   * ⚠️ `concepto` puede venir NULL si el nombre de la póliza no existe en el catálogo de esa
   * plaza. Eso se **declara** y el autollenado no propone — nunca se inventa un concepto.
   */
  await knex.raw(`
    CREATE OR REPLACE VIEW analytics.v_caja_contracuenta_cobro AS
    WITH poliza AS (
      SELECT p.tenant_id, btrim(p.sucursal) AS sucursal, btrim(p.cuenta) AS cuenta,
             btrim(p.cuenta_nombre) AS nombre, count(*)::int AS renglones
        FROM analytics.gl_poliza_lines p
       WHERE p.tipo_pol = 'UA0501' AND p.cargo_abono = 'A'
         AND p.anio_mes >= to_char(current_date - 180, 'YYYY-MM')
       GROUP BY 1,2,3,4
    ), dom AS (
      -- La dominante de cada plaza. Si hubiera dos, gana la que sostiene más renglones y
      -- "alternativas" lo dice: una mayoría de 51% no es lo mismo que una de 99%.
      SELECT DISTINCT ON (tenant_id, sucursal)
             tenant_id, sucursal, cuenta, nombre, renglones,
             count(*) OVER (PARTITION BY tenant_id, sucursal) AS alternativas
        FROM poliza ORDER BY tenant_id, sucursal, renglones DESC
    )
    SELECT d.tenant_id, d.sucursal, d.cuenta, d.nombre AS cuenta_nombre,
           k.concepto, k.concepto_nombre, d.renglones, d.alternativas
      FROM dom d
      LEFT JOIN analytics.v_kepler_conceptos k
             ON k.tenant_id = d.tenant_id AND k.sucursal = d.sucursal AND k.cuenta = d.cuenta
            AND upper(btrim(k.concepto_nombre)) = upper(d.nombre)`);

  await knex.raw(`ALTER VIEW analytics.v_caja_contracuenta_cobro SET (security_invoker = true)`);
  await knex.raw(`GRANT SELECT ON analytics.v_caja_contracuenta_cobro TO app_runtime`);
  await knex.raw(`
    COMMENT ON VIEW analytics.v_caja_contracuenta_cobro IS
      '[CG.117] La contracuenta de un cobro, DERIVADA del abono de la poliza UA0501 del propio Kepler (ADR-040). Hoy 115/071 ABONO A CLIENTES en las 9 sucursales. concepto NULL = el nombre de la poliza no esta en el catalogo de esa plaza: se declara, no se inventa.'`);

  await knex.raw(`
    COMMENT ON VIEW analytics.v_caja_ingreso_ruta_candidatos IS
      '[CG.117] Candidatos de venta (ruta/vecinal) para cada ingreso de caja general, por importe ±$3 y hasta 10 dias antes. n_candidatos>1 = ambiguo, la pantalla debe preguntar. Derivada del ODS, sin importer.'`);
};

exports.down = async function down(knex) {
  await knex.raw(`DROP VIEW IF EXISTS analytics.v_caja_ingreso_ruta_candidatos`);
  await knex.raw(`DROP VIEW IF EXISTS analytics.v_caja_contracuenta_cobro`);
  await knex.raw(`DROP TABLE IF EXISTS finance.${TABLA}`);
};
