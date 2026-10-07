/**
 * RD.3 — `analytics.route_cost_snapshot`: congelar el costo de la venta en ruta, porque
 * hoy NO es estable.
 *
 * ── EL PROBLEMA, MEDIDO ─────────────────────────────────────────────────────────────────
 * El importer de Wincaja **reescribe todas las líneas en cada corrida**: las 357k líneas de
 * ruta, incluidas las de enero, tienen `imported_at` de hoy — un solo día distinto en toda
 * la tabla. Y Wincaja re-expresa el `valor_costo` de ventas pasadas cuando se mueve su costo
 * promedio. Consecuencia: **el margen de un mes cerrado cambia solo, cada noche**, sin que
 * nadie toque nada.
 *
 * Se vio al reconciliar el workbook: SUBTOTAL casa 98.0% exacto y VENTA 97.2%, pero COSTO
 * sólo 14.1%. No es un problema de fórmula — en la ruta 27 las TRES columnas casan al
 * centavo (141/150), así que el Excel copia las mismas expresiones que calculamos. Lo que
 * cambió es el VALOR. Ya se descartaron, con su número: `valor_costo`, `costo_promedio`,
 * `ultimo_costo`, `costo_existencia`, los tres despejes por impuesto, el costo de otro día
 * (0 de 150 con ±2 días), un factor constante (la razón varía 0.945–1.001 con el mix) y un
 * segundo `source_dataset` (sólo existe `actual`).
 *
 * ── POR QUÉ TABLA REAL Y NO VISTA ───────────────────────────────────────────────────────
 * Es el caso de **histórico / snapshot** que la regla #1 admite explícitamente: no se puede
 * derivar, porque justamente lo que se guarda es un valor que la fuente ya no tiene. Una
 * vista devolvería la re-expresión de hoy, que es el problema.
 *
 * ── APPEND-ONLY Y SÓLO CUANDO CAMBIA ────────────────────────────────────────────────────
 * Cada observación es una fila. No se pisa la anterior: así la **deriva se puede medir** en
 * vez de suponerla — hoy nadie sabe si el costo se asienta en 2 días o en 20. Para que no
 * explote (13 rutas × 250 días × una observación diaria = 800k filas/año), sólo se inserta
 * cuando el valor **cambió** respecto de la última observación de ese día. Es el patrón
 * hash-delta de los carriles del ODS.
 *
 * ── DOS ORÍGENES, Y NO SE ELIGE ENTRE ELLOS ─────────────────────────────────────────────
 *   `erp_observado`  — lo que `analytics.v_rd_route_daily` decía en ese momento.
 *   `excel_captura`  — lo que el workbook registró cuando la persona lo tecleó. Para
 *                      ene–ago 2026 es el ÚNICO registro contemporáneo que existe: lo que
 *                      la réplica tiene hoy ya está re-expresado.
 *
 * La vista `analytics.v_route_cost_resolved` devuelve **las dos** y su diferencia, y NO
 * elige. No hay forma de saber cuál es correcta sin un árbitro externo, así que elegir
 * sería inventar. Quien consuma decide con la diferencia a la vista (ADR-056).
 *
 * @param { import("knex").Knex } knex
 */

exports.up = async function up(knex) {
  if (await knex.schema.withSchema('analytics').hasTable('route_cost_snapshot')) return;

  await knex.schema.withSchema('analytics').createTable('route_cost_snapshot', (t) => {
    t.uuid('id').notNullable().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('tenant_id').notNullable();
    t.string('route_code', 24).notNullable();
    t.date('business_date').notNullable();
    t.string('origen', 24).notNullable();          // erp_observado | excel_captura
    t.timestamp('observed_at').notNullable().defaultTo(knex.fn.now());
    t.decimal('costo', 16, 2).nullable();
    t.decimal('subtotal', 16, 2).nullable();
    t.decimal('venta', 16, 2).nullable();
    t.integer('lineas').nullable();
    t.text('notes').nullable();
    t.timestamp('created_at').notNullable().defaultTo(knex.fn.now());

    t.primary('id');
    t.check(`?? in ('erp_observado','excel_captura')`, ['origen'], 'route_cost_snapshot_origen_valid');
    t.index(['tenant_id', 'route_code', 'business_date'], 'idx_route_cost_snapshot_ruta_dia');
    t.index(['tenant_id', 'origen', 'business_date'], 'idx_route_cost_snapshot_origen');
  });

  await knex.raw(`
    ALTER TABLE analytics.route_cost_snapshot
      ADD CONSTRAINT fk_route_cost_snapshot_tenant
      FOREIGN KEY (tenant_id) REFERENCES identity.tenants(id) ON DELETE RESTRICT`);

  // Una observación por (ruta, día, origen, instante). El "sólo cuando cambia" lo hace el
  // capturador; esto sólo evita que la misma corrida escriba dos veces.
  await knex.raw(`
    CREATE UNIQUE INDEX route_cost_snapshot_unique
      ON analytics.route_cost_snapshot (tenant_id, route_code, business_date, origen, observed_at)`);

  // `analytics.*` no lleva RLS por convención del schema; el filtro de tenant va explícito
  // en el consumidor. Se otorga lectura y escritura al runtime porque el capturador corre
  // dentro de la app (no es un importer externo).
  await knex.raw(`GRANT SELECT, INSERT ON analytics.route_cost_snapshot TO app_runtime`);

  // ── El resolvedor: devuelve las dos cifras y su diferencia, sin elegir ────────────────
  await knex.raw(`
    CREATE OR REPLACE VIEW analytics.v_route_cost_resolved WITH (security_invoker = true) AS
    WITH primera AS (
      SELECT DISTINCT ON (tenant_id, route_code, business_date, origen)
             tenant_id, route_code, business_date, origen,
             costo, subtotal, venta, observed_at
      FROM analytics.route_cost_snapshot
      ORDER BY tenant_id, route_code, business_date, origen, observed_at ASC
    ), ultima AS (
      SELECT DISTINCT ON (tenant_id, route_code, business_date, origen)
             tenant_id, route_code, business_date, origen, costo, observed_at
      FROM analytics.route_cost_snapshot
      ORDER BY tenant_id, route_code, business_date, origen, observed_at DESC
    )
    SELECT
      COALESCE(e.tenant_id, o.tenant_id)           AS tenant_id,
      COALESCE(e.route_code, o.route_code)         AS route_code,
      COALESCE(e.business_date, o.business_date)   AS business_date,
      e.costo                                      AS costo_capturado,
      e.observed_at                                AS capturado_at,
      o.costo                                      AS costo_erp_primero,
      o.observed_at                                AS erp_primera_obs,
      ou.costo                                     AS costo_erp_ultimo,
      ou.observed_at                               AS erp_ultima_obs,
      COALESCE(e.subtotal, o.subtotal)             AS subtotal,
      COALESCE(e.venta, o.venta)                   AS venta,
      -- Cuánto se movió el costo del ERP entre la primera y la última observación: es la
      -- DERIVA, el número que hoy nadie tiene.
      CASE WHEN o.costo IS NOT NULL AND o.costo <> 0 AND ou.costo IS NOT NULL
           THEN round(((ou.costo - o.costo) / o.costo * 100)::numeric, 4) END AS deriva_erp_pct,
      -- Cuánto difieren el registro contemporáneo y el del ERP. No se elige uno.
      CASE WHEN e.costo IS NOT NULL AND e.costo <> 0 AND ou.costo IS NOT NULL
           THEN round(((ou.costo - e.costo) / e.costo * 100)::numeric, 4) END AS brecha_vs_captura_pct,
      CASE
        WHEN e.costo IS NOT NULL AND ou.costo IS NOT NULL THEN 'dos_fuentes'
        WHEN e.costo IS NOT NULL                          THEN 'solo_captura'
        WHEN ou.costo IS NOT NULL                         THEN 'solo_erp'
        ELSE 'sin_costo'
      END                                          AS costo_cobertura
    FROM      (SELECT * FROM primera WHERE origen = 'excel_captura') e
    FULL JOIN (SELECT * FROM primera WHERE origen = 'erp_observado') o
           ON o.tenant_id = e.tenant_id AND o.route_code = e.route_code AND o.business_date = e.business_date
    LEFT JOIN (SELECT * FROM ultima WHERE origen = 'erp_observado') ou
           ON ou.tenant_id = COALESCE(e.tenant_id, o.tenant_id)
          AND ou.route_code = COALESCE(e.route_code, o.route_code)
          AND ou.business_date = COALESCE(e.business_date, o.business_date)
  `);
  await knex.raw(`GRANT SELECT ON analytics.v_route_cost_resolved TO app_runtime`);

  await knex.raw(`COMMENT ON TABLE analytics.route_cost_snapshot IS 'RD.3 — congela el costo de la venta en ruta, que hoy NO es estable: el importer de Wincaja reescribe TODAS las lineas en cada corrida (357k lineas de ruta con imported_at de hoy, enero incluido) y Wincaja re-expresa el costo de ventas pasadas, asi que el margen de un mes cerrado cambia solo cada noche. Caso de historico/snapshot que la regla #1 admite: no se puede derivar porque lo que se guarda es un valor que la fuente YA NO TIENE. Append-only y solo cuando cambia (patron hash-delta), para poder MEDIR la deriva en vez de suponerla.'`);
  await knex.raw(`COMMENT ON VIEW analytics.v_route_cost_resolved IS 'RD.3 — devuelve el costo capturado (workbook, registro contemporaneo) y el del ERP (primera y ultima observacion) con su deriva y su brecha, y NO ELIGE entre ellos: no hay arbitro externo para decidir cual es correcto, asi que elegir seria inventar. costo_cobertura dice con que se cuenta en cada fila.'`);
};

exports.down = async function down(knex) {
  await knex.raw(`DROP VIEW IF EXISTS analytics.v_route_cost_resolved`);
  await knex.schema.withSchema('analytics').dropTableIfExists('route_cost_snapshot');
};
