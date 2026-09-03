/**
 * LC.14 (Fase LC, ADR-052) — **La tercera puerta del anti-duplicado: por UUID, exacta.**
 *
 * Las dos puertas que existen son heurísticas POR IMPORTE: si un abono a `212` por el total
 * de la factura, o un cargo a `501/502` por su neto, ya aparecen en alguna póliza del mes,
 * la factura se marca como posteada. Funciona, pero dos facturas del mismo monto casan
 * igual, y la puerta del neto tiene un falso negativo estructural (nuestro propio asiento
 * parte el neto en DOS patas, así que una factura de base mixta no tiene ninguna pata igual
 * al neto completo).
 *
 * Existe una fuente EXACTA que no se estaba usando: la hoja `XML` del workbook manual
 * `LIBRO DE COMPRAS 2026-.xlsx`, 15,417 renglones con **UUID por renglón del libro**,
 * 15,120 UUID distintos de 2022-01 a jul-2026 por $2,015,523,051. Es la lista precisa de lo
 * que SÍ entró al libro histórico.
 *
 * ── Por qué una tabla y no filas en `purchase_book_runs` ──────────────────────────────────
 *
 * La alternativa era reconstruir corridas sintéticas (una por mes histórico) + sus
 * `run_items`. Se descartó, y la objeción decisiva NO es que mienta (que también):
 * `run_items` significa *"la decisión humana de inclusión para ESTA corrida"*, y `getMes()`
 * la lee para **pisar el default**. Filas históricas con `incluida = true` harían que abrir
 * 2022-01 muestre todas las facturas históricas **pre-marcadas para entrar al TXT** — la
 * respuesta contraria a la que la pantalla pregunta. Además colisiona con el
 * `UNIQUE (tenant_id, anio_mes, folio_poliza)` justo en jul y ago-2026, `ensureRun()`
 * devolvería la sintética y `generar()` lanzaría "el mes ya está aplicado" para 55 meses sin
 * endpoint que revierta, y `listMeses()` mostraría meses en verde SIN evidencia — que es el
 * modo de falla que el módulo existe para evitar.
 *
 * La regla dura del proyecto (GOTCHAS §32) permite tabla real para **datos propios o
 * histórico/snapshots**, y esto es las dos cosas: no es derivable de nada. El ODS no lo
 * tiene, ContPAQi tampoco (`gl_poliza_lines.cfdi_uuid` cubre 3.8%), sólo existe en un
 * `.xlsx`. Precedente exacto: `finance.gl_supplier_accounts`, sembrada de la hoja `DATOS`
 * del MISMO archivo por `import-supplier-accounts.js`.
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  await knex.raw(`CREATE SCHEMA IF NOT EXISTS finance`);

  if (!(await knex.schema.withSchema('finance').hasTable('purchase_book_history'))) {
    await knex.raw(`
      CREATE TABLE finance.purchase_book_history (
        tenant_id     uuid NOT NULL,
        -- De dónde viene la prueba. No es metadato: es lo que decide su FUERZA, y por eso
        -- va en la PK. Hoy sólo se siembra 'historico_xlsx'; los otros dos quedan
        -- declarados porque son el camino de LC.15 (leer de vuelta el UUID que nosotros
        -- mismos ponemos en el Concepto del movimiento).
        source        text NOT NULL,
        -- La llave del renglón en su fuente. En la hoja XML es '# COMPRA' = 'JUL26.153'.
        source_key    text NOT NULL,
        cfdi_uuid     varchar(36) NOT NULL,
        -- El mes DEL LIBRO (el de la hoja), NO la fecha del CFDI. La divergencia entre los
        -- dos es real y medible — el corte del libro es por captura: abril cerró en
        -- $35,034,209.66 contra $34,393,426.36 de CFDIs fechados en abril. Guardarlo así la
        -- vuelve consultable en vez de folklore.
        anio_mes      text NOT NULL,
        importe       numeric(16,2),
        emisor_rfc    varchar(13),
        folio         text,
        -- Cuándo se observó esta fila. El workbook es MUTABLE: si la contadora agrega un
        -- mes, nuestro histórico queda corto y sub-protege EN SILENCIO. Esta columna, más
        -- el renglón de cobertura en pantalla, es lo que hace visible ese límite.
        observado_at  timestamptz NOT NULL DEFAULT now(),

        created_at    timestamptz NOT NULL DEFAULT now(),
        created_by    uuid,
        updated_at    timestamptz NOT NULL DEFAULT now(),
        updated_by    uuid,
        deleted_at    timestamptz,
        deleted_by    uuid,

        -- PK por (source, source_key) y NO por UUID: la hoja tiene 15,417 filas y 15,120
        -- UUID distintos, o sea ~297 repetidas. Con PK por UUID se pierden; así SOBREVIVEN
        -- como evidencia de que el libro manual registró la misma factura dos veces —
        -- dinero real. El gate deduplica en la consulta.
        PRIMARY KEY (tenant_id, source, source_key),

        -- Estructural, no por convención: la normalización a mayúsculas hoy está repartida
        -- en seis lugares del código y basta que uno se olvide para que el join falle en
        -- silencio (que es el peor modo de falla acá: parece "no hay duplicados").
        CONSTRAINT purchase_book_history_uuid_upper CHECK (cfdi_uuid = upper(cfdi_uuid)),
        CONSTRAINT purchase_book_history_mes_valido CHECK (anio_mes ~ '^[0-9]{4}-[0-9]{2}$'),
        CONSTRAINT purchase_book_history_source_valido
          CHECK (source IN ('historico_xlsx','contpaqi_concepto','contpaqi_asoccfdi'))
      )`);

    // SIN FK a fiscal.cfdis, a propósito: 149 de los 15,120 UUID del libro NO están en el
    // ADD (¿otro RFC receptor? ¿cancelados? ¿anteriores al ADD?). Con FK no se pueden
    // sembrar. Va dicho acá para que nadie "arregle" el olvido y rompa la carga.
    await knex.raw(`
      COMMENT ON COLUMN finance.purchase_book_history.cfdi_uuid IS
        'Sin FK a fiscal.cfdis a propósito: 149 UUID del libro histórico no están en el ADD.'`);

    await knex.raw(`
      CREATE INDEX ix_pbh_uuid ON finance.purchase_book_history (tenant_id, cfdi_uuid)
        WHERE deleted_at IS NULL`);
    await knex.raw(`CREATE INDEX ix_pbh_mes ON finance.purchase_book_history (tenant_id, anio_mes)`);

    await knex.raw(`ALTER TABLE finance.purchase_book_history ENABLE ROW LEVEL SECURITY`);
    await knex.raw(`ALTER TABLE finance.purchase_book_history FORCE ROW LEVEL SECURITY`);
    await knex.raw(`
      CREATE POLICY purchase_book_history_tenant ON finance.purchase_book_history
        USING (tenant_id = public.current_tenant_id())
        WITH CHECK (tenant_id = public.current_tenant_id())`);
    // Sin DELETE: el histórico no se borra, se marca con deleted_at.
    await knex.raw(`GRANT SELECT, INSERT, UPDATE ON finance.purchase_book_history TO app_runtime`);
  }

  /**
   * La uniformidad que la opción descartada prometía, pero en el lugar correcto: una vista.
   * Junta el histórico del workbook con lo que NOSOTROS ya entregamos.
   *
   * `entregado` cuenta como prueba y `generado` no, por costos asimétricos: un falso "ya
   * está en el libro" cuesta una exclusión que un humano revierte en un clic; un falso "no
   * está" cuesta un asiento DUPLICADO del lado de ContPAQi que nadie nota hasta cuadrar la
   * balanza. Una vez que el archivo salió de nuestras manos hay que asumir que puede estar
   * posteado.
   *
   * ⚠️ `security_invoker = true` es OBLIGATORIO: las tablas base tienen FORCE ROW LEVEL
   * SECURITY y sin él la vista corre como su owner y SALTA la RLS.
   */
  await knex.raw(`
    CREATE OR REPLACE VIEW finance.v_purchase_book_uuids WITH (security_invoker = true) AS
      SELECT h.tenant_id, upper(h.cfdi_uuid) AS cfdi_uuid, h.anio_mes,
             h.source, h.source_key AS referencia
        FROM finance.purchase_book_history h
       WHERE h.tenant_id = public.current_tenant_id() AND h.deleted_at IS NULL
      UNION ALL
      SELECT i.tenant_id, upper(i.cfdi_uuid), r.anio_mes,
             'run_' || r.estado,
             r.tipo || ' folio ' || r.folio_poliza::text
        FROM finance.purchase_book_run_items i
        JOIN finance.purchase_book_runs r
          ON r.tenant_id = i.tenant_id AND r.id = i.run_id AND r.deleted_at IS NULL
       WHERE i.tenant_id = public.current_tenant_id()
         AND i.incluida AND r.estado IN ('entregado','aplicado')`);

  /**
   * Una fila por UUID, con la prueba MÁS FUERTE que exista para él. El `DISTINCT ON`
   * garantiza unicidad, así que un LEFT JOIN contra esta vista no puede multiplicar filas —
   * que es justo el problema que obligó a pre-agregar las otras dos puertas.
   */
  await knex.raw(`
    CREATE OR REPLACE VIEW finance.v_purchase_book_uuid_prueba WITH (security_invoker = true) AS
      SELECT DISTINCT ON (tenant_id, cfdi_uuid)
             tenant_id, cfdi_uuid, source, anio_mes, referencia
        FROM finance.v_purchase_book_uuids
       ORDER BY tenant_id, cfdi_uuid,
                CASE source
                  WHEN 'contpaqi_asoccfdi'  THEN 1
                  WHEN 'contpaqi_concepto'  THEN 2
                  WHEN 'run_aplicado'       THEN 3
                  WHEN 'historico_xlsx'     THEN 4
                  WHEN 'run_entregado'      THEN 5
                  ELSE 9
                END,
                anio_mes`);

  await knex.raw(`GRANT SELECT ON finance.v_purchase_book_uuids TO app_runtime`);
  await knex.raw(`GRANT SELECT ON finance.v_purchase_book_uuid_prueba TO app_runtime`);
};

exports.down = async function (knex) {
  await knex.raw(`DROP VIEW IF EXISTS finance.v_purchase_book_uuid_prueba`);
  await knex.raw(`DROP VIEW IF EXISTS finance.v_purchase_book_uuids`);
  await knex.schema.withSchema('finance').dropTableIfExists('purchase_book_history');
};
