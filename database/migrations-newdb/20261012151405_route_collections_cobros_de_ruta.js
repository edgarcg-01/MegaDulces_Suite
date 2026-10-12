/**
 * `[RC.3]` — LOS COBROS PUE `UA0501` DE LAS CAMIONETAS ENTRAN A LA COLA DE CAJA GENERAL.
 *
 * Edgar: *"necesito que salga el cargo a las rutas, arquearlo y ya"* — y con el **PUE de ruta**,
 * no con el depósito suelto del cajero.
 *
 * ── Por qué hace falta ───────────────────────────────────────────────────────────────────────
 *
 * El cobro `UA0501` de una ruta se captura en el Kepler **local** de la camioneta
 * (`//127.0.0.1/cobro.kpl`, "Movil 005 de Suc 01") y NO sincroniza a la plaza. Medido en prod el
 * 2026-10-12, almacén `01-005`:
 *
 *     en el ODS ........  1 cobro   folio 0000001 · 02-oct · $25,167
 *     en la camioneta ..  7 cobros  folios 0000003–0000009 · hasta 10-oct · $135,879
 *
 * Ninguno de los 7 llegó. Por eso la cola mostraba **un solo** `U-A-5` para hoy —el de la plaza,
 * $28,204.50— y ninguna ruta. Y por eso la Fase CSU midió **1.5% cobrado** sobre $4.53M de cortes
 * de caja POS: los cortes `UD2301` están en la plaza y se ven; el cobro que los salda no viaja.
 *
 * El push de camioneta ya los trae al runner (`mart.cobros_ruta`, `[RC.1]`/`[RC.2]`). Esto es el
 * último tramo: la tabla donde aterrizan en prod y la vista que la pantalla ya lee.
 *
 * ⭐ **La pantalla NO necesita deploy.** La cola sale de esta vista; agregarle una rama hace que
 * los cobros de ruta aparezcan sin tocar una línea de código del front ni del API.
 *
 * ── Tres decisiones que no son obvias ────────────────────────────────────────────────────────
 *
 * 1. ⛔ **`sucursal` es el ALMACÉN (`01-005`), no la plaza (`01`).** El `origen_ref` de la cola se
 *    arma `sucursal|doc_tipo|folio|clave_banco`, y los folios de la camioneta **colisionan** con
 *    los de su plaza: la camioneta tiene `0000003..0000009` y la plaza también. Con `01` el
 *    de-duplicado contra `cash_ledger` marcaría como capturado un cobro que no lo está — o al
 *    revés. El almacén los separa.
 *
 * 2. ⭐ **Una fila por COBRO, no por aplicación.** `mart.cobros_ruta` guarda el par (cobro, corte)
 *    porque la aplicación es N:M —medido: el cobro `0000007` se parte en los cortes `0000006`
 *    ($15,664.33) y `0000007` ($4,342.67)—. Pero a la caja entra **un** billete por cobro, así que
 *    la cola agrega por cobro y suma. Mostrar las tres patas pediría arquear el mismo dinero tres
 *    veces.
 *
 * 3. ⚠️ **Sólo `cuenta='0011'` (CAJA GENERAL).** Los cobros que la camioneta manda a banco
 *    (`2169`, que saldan facturas `D-13-1`) **se guardan igual** en la tabla, pero no entran a la
 *    cola de caja: ese dinero no pasó por el cajón. Se filtra en la vista, no en la ingesta —
 *    filtrar en el origen es perder el dato sin poder revisarlo.
 *
 * ⚠️ Aditiva y reversible: la rama nueva se quita con el mismo `CREATE OR REPLACE` de `down`, y la
 * tabla se dropea. No toca `mv_caja_movimientos` ni el carril que la refresca cada minuto.
 */
exports.up = async function up(knex) {
  const existe = await knex.schema.withSchema('analytics').hasTable('route_collections');
  if (!existe) {
    await knex.schema.withSchema('analytics').createTable('route_collections', (t) => {
      t.uuid('tenant_id').notNullable();
      t.text('truck').notNullable();        // ruta_27
      t.text('almacen').notNullable();      // 01-005 (el de la camioneta, derivado del nombre de su base)
      t.text('cobro_folio').notNullable();  // UA0501-xxxxxxx
      t.date('fecha').notNullable();
      t.text('cuenta');                     // c45: 0011 = CAJA GENERAL; otra = banco
      t.text('doc_tipo');                   // el documento saldado: D-23-1 (corte de caja POS)
      t.text('folio_corte').notNullable();
      t.decimal('importe', 18, 2);
      t.text('referencia');                 // 'Caja 1-95'
      t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
      t.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
      // La llave natural: un cobro aplica UNA vez a un corte. Un re-push reescribe, no duplica dinero.
      t.primary(['tenant_id', 'truck', 'cobro_folio', 'folio_corte']);
    });
    await knex.raw('CREATE INDEX IF NOT EXISTS ix_route_collections_fecha ON analytics.route_collections (tenant_id, fecha)');
    await knex.raw('CREATE INDEX IF NOT EXISTS ix_route_collections_corte ON analytics.route_collections (tenant_id, folio_corte)');
  }

  // RLS forzado + política por tenant, igual que el resto de `analytics.*` propio.
  await knex.raw('ALTER TABLE analytics.route_collections ENABLE ROW LEVEL SECURITY');
  await knex.raw('ALTER TABLE analytics.route_collections FORCE ROW LEVEL SECURITY');
  await knex.raw(`DROP POLICY IF EXISTS route_collections_tenant ON analytics.route_collections`);
  await knex.raw(`CREATE POLICY route_collections_tenant ON analytics.route_collections
                    USING (tenant_id = current_tenant_id())
                    WITH CHECK (tenant_id = current_tenant_id())`);
  await knex.raw('GRANT SELECT, INSERT, UPDATE, DELETE ON analytics.route_collections TO app_runtime');

  // ── La vista: se reescribe ENTERA con la rama nueva al final ───────────────────────────────
  // ⚠️ `CREATE OR REPLACE VIEW` exige los MISMOS nombres, tipos y orden de columnas. La rama nueva
  // los calza uno a uno (16 columnas, `fecha_valor`/`fecha_captura` son `date` y `monto` `numeric`).
  await knex.raw(`
    CREATE OR REPLACE VIEW finance.v_caja_movimientos_pendientes AS
    SELECT tenant_id, clave_banco, banco_nombre AS caja_nombre, sucursal, doc_tipo, folio,
           sucursal || '|' || doc_tipo || '|' || folio || '|' || clave_banco AS origen_ref,
           CASE WHEN signo > 0 THEN 'ingreso' ELSE 'gasto' END AS tipo,
           CASE WHEN signo > 0 THEN 'cobro' ELSE 'pago_proveedor' END AS origen_tipo,
           fecha_valor, fecha_captura, entidad_code, beneficiario, concepto, metodo,
           importe AS monto
      FROM analytics.mv_caja_movimientos k
     WHERE tenant_id = current_tenant_id() AND signo <> 0 AND es_traspaso = false AND importe > 0::numeric
       AND NOT (EXISTS (SELECT 1 FROM finance.cash_ledger l
                 WHERE l.tenant_id = k.tenant_id
                   AND l.origen_tipo = CASE WHEN k.signo > 0 THEN 'cobro' ELSE 'pago_proveedor' END
                   AND l.origen_ref = k.sucursal || '|' || k.doc_tipo || '|' || k.folio || '|' || k.clave_banco
                   AND l.deleted_at IS NULL AND l.estado <> 'cancelado'))

    UNION ALL

    -- [RC.3] Los cobros PUE de las camionetas. Agregados POR COBRO (la aplicación es N:M contra
    -- los cortes, pero a la caja entra un solo billete por cobro).
    SELECT r.tenant_id,
           '0011'::text AS clave_banco,
           'CAJA GENERAL'::text AS caja_nombre,
           r.almacen AS sucursal,
           'U-A-5'::text AS doc_tipo,
           r.cobro_folio AS folio,
           r.almacen || '|U-A-5|' || r.cobro_folio || '|0011' AS origen_ref,
           'ingreso'::text AS tipo,
           'cobro'::text AS origen_tipo,
           r.fecha AS fecha_valor,
           r.fecha AS fecha_captura,
           'CONTADO'::text AS entidad_code,
           'CONTADO'::text AS beneficiario,
           -- Qué cortes salda, que es lo que la persona reconoce al arquear.
           string_agg(DISTINCT coalesce(r.referencia, r.folio_corte), ' · ') AS concepto,
           NULL::text AS metodo,
           sum(r.importe)::numeric AS monto
      FROM analytics.route_collections r
     WHERE r.tenant_id = current_tenant_id()
       AND r.cuenta = '0011'
       AND NOT EXISTS (SELECT 1 FROM finance.cash_ledger l
                 WHERE l.tenant_id = r.tenant_id AND l.origen_tipo = 'cobro'
                   AND l.origen_ref = r.almacen || '|U-A-5|' || r.cobro_folio || '|0011'
                   AND l.deleted_at IS NULL AND l.estado <> 'cancelado')
     GROUP BY r.tenant_id, r.almacen, r.cobro_folio, r.fecha
  `);
};

exports.down = async function down(knex) {
  // La vista vuelve a su forma anterior (sin la rama de rutas), y recién después cae la tabla.
  await knex.raw(`
    CREATE OR REPLACE VIEW finance.v_caja_movimientos_pendientes AS
    SELECT tenant_id, clave_banco, banco_nombre AS caja_nombre, sucursal, doc_tipo, folio,
           sucursal || '|' || doc_tipo || '|' || folio || '|' || clave_banco AS origen_ref,
           CASE WHEN signo > 0 THEN 'ingreso' ELSE 'gasto' END AS tipo,
           CASE WHEN signo > 0 THEN 'cobro' ELSE 'pago_proveedor' END AS origen_tipo,
           fecha_valor, fecha_captura, entidad_code, beneficiario, concepto, metodo,
           importe AS monto
      FROM analytics.mv_caja_movimientos k
     WHERE tenant_id = current_tenant_id() AND signo <> 0 AND es_traspaso = false AND importe > 0::numeric
       AND NOT (EXISTS (SELECT 1 FROM finance.cash_ledger l
                 WHERE l.tenant_id = k.tenant_id
                   AND l.origen_tipo = CASE WHEN k.signo > 0 THEN 'cobro' ELSE 'pago_proveedor' END
                   AND l.origen_ref = k.sucursal || '|' || k.doc_tipo || '|' || k.folio || '|' || k.clave_banco
                   AND l.deleted_at IS NULL AND l.estado <> 'cancelado'))
  `);
  await knex.schema.withSchema('analytics').dropTableIfExists('route_collections');
};
