/**
 * CG.19 Capa 0 — **La identidad ruta ↔ cliente, DECLARADA** (ADR-070).
 *
 * ── Por qué existe ───────────────────────────────────────────────────────────────────────────
 *
 * CG.19 cambia la fórmula del corte: el **esperado deja de ser la suma de lo que el capturista
 * tecleó** y pasa a ser el **saldo de la ruta en la cartera de Kepler**
 * (`analytics.customer_receivables.saldo_ajustado`, vista viva sobre `kepler_ods.kdue`).
 *
 * Para eso hace falta saber **qué cliente del ERP es qué ruta**. Y hoy esa identidad se resuelve
 * con una **expresión regular sobre el nombre**, en tres lugares y con **dos expresiones que no
 * son la misma**:
 *
 *   libs/commercial/.../commercial-movements.service.ts:26
 *       ^\s*(R\.[DV]|R[DV]|RUTA)
 *   database/migrations-newdb/20260819220000_payments_collections_live_views.js:73
 *   database/migrations-newdb/20260902170000_erp_views_exclude_cancelled_kepler.js:94
 *       ^(RUTA|R\.?[DV]\.?|R[DV][\s\-0-9])
 *
 * Mientras eso sólo pintaba una etiqueta ("este movimiento es de ruta") el costo de equivocarse
 * era cosmético. **En cuanto se usa para aplicar dinero contra un saldo, deja de serlo:** un
 * cliente mal resuelto le abona la entrega a la ruta equivocada, y las dos cuentas quedan mal.
 *
 * ⛔ **Regla M3 de la fase: no se liga por atributos débiles.** Un regex sobre un nombre es un
 * atributo débil. Sirve para PROPONER una vez; no para decidir para siempre.
 *
 * ── Qué hace esta tabla ──────────────────────────────────────────────────────────────────────
 *
 * Lo mismo que `finance.caja_kepler_concept_map` (CG.17) hace con los conceptos, y por la misma
 * razón: **se propone por derivación y lo confirma un humano.**
 *
 *   · El lado IZQUIERDO sale de `analytics.v_route_zone` — el registro operativo
 *     (`wincaja.branches` con `is_route`), no una lista escrita a mano. 18 rutas, y cuando la
 *     operación dé de alta otra, entra sola.
 *   · El lado DERECHO (`cliente_code`) es **NULLable**, y eso NO es un error: es el estado honesto
 *     "sin propuesta". Un mapa vacío y un mapa completo no pueden verse igual (ADR-056) — por eso
 *     hay vista de cobertura.
 *   · `match_regla` guarda **qué** regla lo propuso. Sin eso, una heurística mala es indistinguible
 *     de una buena, y no se puede retirar sin revisar a mano las 18.
 *
 * ⛔ **Una fila `derivado` sin `confirmed_at` NO alcanza para aplicar dinero.** Puede mostrarse
 * como sugerencia; la Capa 2 exige confirmación, y lo que no está confirmado manda la entrega a
 * CUSTODIA en vez de aplicarla. Esa es toda la diferencia entre proponer y decidir.
 *
 * ── Qué NO hace ──────────────────────────────────────────────────────────────────────────────
 *
 * No siembra nada. La propuesta la hace `seed-route-customer-map.js`, que **hace el match en
 * JavaScript, no en SQL** — a propósito: las regex de arriba traen `?`, y para `knex.raw` el `?`
 * es un marcador de parámetro. Ya se pagó (regla M1: knex se comió dos cuantificadores de un
 * regex y publicó una columna entera en NULL sin un solo error). Match en JS = función pura,
 * testeable, y sin esa trampa.
 *
 * RLS FORZADO + grants. Idempotente. Aditiva: no toca ninguna tabla existente.
 *
 * @param { import("knex").Knex } knex
 */

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

exports.up = async function (knex) {
  await knex.raw(`CREATE SCHEMA IF NOT EXISTS finance`);

  if (!(await knex.schema.withSchema('finance').hasTable('route_customer_map'))) {
    await knex.raw(`
      CREATE TABLE finance.route_customer_map (
        id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id       uuid NOT NULL,
        -- analytics.v_route_zone.route_code: '21','28','501','1V001'. El registro operativo.
        route_code      text NOT NULL,
        route_name      text,                       -- snapshot, ej 'RUTA 21'
        -- La sucursal Kepler donde vive la cuenta del cliente. Una misma ruta podria tener cuenta
        -- en mas de una plaza, por eso entra en la llave.
        sucursal        text,
        -- NULL = SIN PROPUESTA. Es el estado honesto, no un error.
        cliente_code    text,
        cliente_nombre  text,                       -- snapshot del ERP al proponer
        source          text NOT NULL DEFAULT 'derivado',
        -- QUE regla lo propuso. Sin esto una heuristica mala es indistinguible de una buena.
        match_regla     text,
        confirmed_by    text,
        confirmed_at    timestamptz,
        note            text,
        created_at      timestamptz NOT NULL DEFAULT now(),
        updated_at      timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT rcm_source_chk CHECK (source IN ('derivado','manual')),
        -- Media propuesta es peor que ninguna: o van los dos, o ninguno.
        CONSTRAINT rcm_par_chk    CHECK ((cliente_code IS NULL) = (cliente_nombre IS NULL)),
        -- Confirmar sin propuesta no significa nada: no se puede firmar el vacio.
        CONSTRAINT rcm_firma_chk  CHECK (confirmed_at IS NULL OR cliente_code IS NOT NULL)
      )`);
    await knex.raw(`
      CREATE UNIQUE INDEX ux_route_customer_map
        ON finance.route_customer_map (tenant_id, route_code, coalesce(sucursal, ''))`);
    // El consumidor pregunta al reves ("de quien es esta cuenta"), asi que tambien por cliente.
    await knex.raw(`
      CREATE INDEX ix_rcm_cliente
        ON finance.route_customer_map (tenant_id, cliente_code)
        WHERE cliente_code IS NOT NULL`);
    await tenantRls(knex, 'route_customer_map');
  }

  // --- Cobertura: un mapa sin confirmar NO puede verse igual que uno confirmado (ADR-056) ------
  //
  // `confirmadas` es la unica columna que habilita aplicar dinero. `por_confirmar` es trabajo
  // pendiente de un humano, y `sin_propuesta` es la pregunta que ni siquiera se pudo formular.
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
};

exports.down = async function (knex) {
  await knex.raw(`DROP VIEW IF EXISTS finance.v_route_customer_map_coverage`);
  await knex.schema.withSchema('finance').dropTableIfExists('route_customer_map');
};
