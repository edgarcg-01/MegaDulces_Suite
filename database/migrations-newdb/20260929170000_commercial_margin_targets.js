'use strict';
/**
 * `[PR.E0b]` — **La meta de margen deja de ser una constante en el código.**
 *
 * ── Por qué existe ──────────────────────────────────────────────────────────────────────────
 * `FASE_MR_MOTOR_RENTABILIDAD.md:199` diseñó y firmó esta tabla en el sprint **MR.4**
 * (*"la meta es dato capturado, no constante en el código"*). **Nunca se construyó**: un
 * `grep margin_targets` sobre `migrations-newdb/` devuelve **cero**.
 *
 * Mientras tanto el 15 % vive clavado en **tres** lugares, y **ninguno persiste**:
 *   · `commercial-actions.service.ts:9`        → `const MARGIN_TARGET_PCT = 15`
 *   · `commercial-profitability.service.ts:190` → `: 15` (fallback de `private target()`)
 *   · `comercial-rentabilidad.component.ts:1014` → `readonly target = signal(15)`
 * El input de la pantalla es **query param**: dos usuarios ven metas distintas y recargar con
 * otra URL la cambia. Esta tabla mata las tres y cierra la decisión abierta de
 * `FASE_MR_DICCIONARIO_MARGEN.md:251`.
 *
 * ── ⛔ La decisión que NO se toma acá, y por qué ─────────────────────────────────────────────
 * `margen_minimo` (el PISO, `P3` del plan de precios) **nace NULL a propósito**. Medido el
 * 2026-09-29: el gasto de operación sobre tres denominadores distintos da **9.62 % / 12.57 % /
 * 15.53 %**, y **ninguno es defendible** mientras `401-002 VENTA FLETES A TERCEROS` tenga
 * **$352,070,966** de venta de mercancía mal clasificada (54.5 % del ingreso 2026, sucursal `00`,
 * desde ene-2026; el hecho de venta del ERP no se movió y lo delató).
 * **Un piso inventado decide precios.** Va NULL con motivo hasta que Contabilidad resuelva (D13).
 * Ver `docs/IMPLEMENTACION/FASES/FASE_PR_ANALISIS_DIMENSIONAL.md` §13.
 *
 * ── La forma, copiada de dos moldes probados (ADR-059 R6: no se inventa un primitivo) ────────
 *   · **Cascada de ámbito** `producto > categoría > proveedor > default` con índice único
 *     `NULLS NOT DISTINCT` → de `commercial.expiry_receiving_policy` (mig 20260815120000).
 *   · **`source` + `manual_lock` + `auto_tuned_at`** → de `analytics.kpi_thresholds`
 *     (mig 20260921120000, ADR-076/021): el recalculador automático NO pisa lo que un humano fijó.
 *
 * ⭐ **La distinción que no se puede perder:** un default **medido** no es un default
 * **autorizado**. `source='default_medido'` significa *"así se opera hoy, nadie lo firmó"*.
 * La pantalla tiene que distinguirlo de `source='manual'` o en un mes nadie sabrá cuál es cuál.
 *
 * Aditiva e idempotente. **No toca ningún objeto existente.**
 *
 * @param { import("knex").Knex } knex
 */

const TENANT = '00000000-0000-0000-0000-00000000d01c'; // mega_dulces

const MT = 'commercial.margin_targets';
const PS = 'commercial.pricing_settings';

/** Helper: agrega un CHECK sólo si no existe (idempotente). */
async function check(knex, tabla, nombre, expr) {
  const { rows } = await knex.raw(
    `SELECT 1 FROM pg_constraint WHERE conname = ? AND conrelid = ?::regclass`, [nombre, tabla],
  );
  if (rows.length) return;
  await knex.raw(`ALTER TABLE ${tabla} ADD CONSTRAINT ${nombre} CHECK (${expr})`);
  // eslint-disable-next-line no-console
  console.log(`  · [PR.E0b] +CHECK ${nombre}`);
}

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);

  // ═══ 1. commercial.margin_targets ═════════════════════════════════════════════════════════
  if (!(await knex.schema.withSchema('commercial').hasTable('margin_targets'))) {
    await knex.schema.withSchema('commercial').createTable('margin_targets', (t) => {
      t.uuid('id').notNullable().defaultTo(knex.raw('gen_random_uuid()'));
      t.uuid('tenant_id').notNullable();

      // ── Ámbito. A lo sumo UNO seteado; los tres NULL = la fila DEFAULT del tenant.
      t.uuid('product_id');            // meta por SKU (la excepción)
      t.string('categoria', 120);      // meta por categoría — matchea catalog.categories.name
      t.string('supplier_code', 60);   // meta por proveedor — matchea catalog.suppliers.code

      // ── Los números.
      t.decimal('margen_objetivo', 6, 3).notNullable();  // % de margen bruto sobre la venta
      // ⛔ NULL A PROPÓSITO. Ver el encabezado: el piso no es determinable hoy (D13).
      t.decimal('margen_minimo', 6, 3).nullable();
      t.text('minimo_motivo');         // por qué el piso está vacío — se lee en pantalla

      // ── Procedencia (ADR-056: el número carga con qué se calculó).
      t.text('source').notNullable();  // default_medido | manual | auto
      t.boolean('manual_lock').notNullable().defaultTo(false);
      t.timestamp('auto_tuned_at', { useTz: true }).nullable();
      t.text('evidencia');             // de dónde salió el número, con su medición

      // ── Vigencia. Sin precedente en el repo: se inventa acá y queda dicho.
      t.date('vigencia_desde').notNullable().defaultTo(knex.raw('CURRENT_DATE'));
      t.date('vigencia_hasta').nullable();

      t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
      t.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
      t.uuid('updated_by');

      t.primary('id');
      t.unique(['tenant_id', 'id'], { indexName: 'commercial_margin_targets_tenant_id_composite' });
      t.index(['tenant_id', 'product_id'], 'idx_commercial_margin_targets_product');
      t.index(['tenant_id', 'categoria'], 'idx_commercial_margin_targets_categoria');
      t.index(['tenant_id', 'supplier_code'], 'idx_commercial_margin_targets_supplier');
    });
    // eslint-disable-next-line no-console
    console.log(`  · [PR.E0b] ${MT} creada.`);
  }

  // ⭐ Una meta por ámbito exacto y vigencia. NULLS NOT DISTINCT (PG15+) — molde expiry_receiving_policy.
  await knex.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS commercial_margin_targets_scope_unique
      ON ${MT} (tenant_id, product_id, categoria, supplier_code, vigencia_desde)
      NULLS NOT DISTINCT
  `);

  // ── Los CHECK. Cada uno convierte un descuido en un error RUIDOSO.
  await check(knex, MT, 'margin_targets_objetivo_rango',
    `margen_objetivo > 0 AND margen_objetivo < 100`);
  await check(knex, MT, 'margin_targets_minimo_rango',
    `margen_minimo IS NULL OR (margen_minimo >= 0 AND margen_minimo < 100)`);
  /**
   * ⛔ COHERENCIA. Un piso POR ENCIMA del objetivo deja el objetivo inalcanzable y todo cae en
   * rojo sin etapa intermedia — el mismo descuido que `kpi_thresholds` frena con su CHECK.
   */
  await check(knex, MT, 'margin_targets_minimo_bajo_objetivo',
    `margen_minimo IS NULL OR margen_minimo < margen_objetivo`);
  await check(knex, MT, 'margin_targets_source_no_vacia', `btrim(source) <> ''`);
  /**
   * ⛔ EL CHECK QUE DEFINE LA CASCADA. Con dos ejes seteados la fila es ambigua: ¿manda la
   * categoría o el proveedor? El resolvedor tendría que adivinar, y adivinaría distinto según
   * el orden del ORDER BY. Se prohíbe en la tabla, no en el servicio.
   */
  await check(knex, MT, 'margin_targets_un_solo_ambito',
    `(CASE WHEN product_id IS NOT NULL THEN 1 ELSE 0 END
      + CASE WHEN categoria   IS NOT NULL THEN 1 ELSE 0 END
      + CASE WHEN supplier_code IS NOT NULL THEN 1 ELSE 0 END) <= 1`);
  await check(knex, MT, 'margin_targets_vigencia_coherente',
    `vigencia_hasta IS NULL OR vigencia_hasta > vigencia_desde`);

  await knex.raw(`
    ALTER TABLE ${MT} DROP CONSTRAINT IF EXISTS fk_commercial_margin_targets_tenant;
    ALTER TABLE ${MT} ADD CONSTRAINT fk_commercial_margin_targets_tenant
      FOREIGN KEY (tenant_id) REFERENCES identity.tenants(id) ON DELETE RESTRICT;
  `);
  await knex.raw(`
    ALTER TABLE ${MT} DROP CONSTRAINT IF EXISTS fk_commercial_margin_targets_product;
    ALTER TABLE ${MT} ADD CONSTRAINT fk_commercial_margin_targets_product
      FOREIGN KEY (tenant_id, product_id)
      REFERENCES catalog.products(tenant_id, id) ON DELETE CASCADE;
  `);

  await knex.raw(`ALTER TABLE ${MT} ENABLE ROW LEVEL SECURITY`);
  await knex.raw(`ALTER TABLE ${MT} FORCE ROW LEVEL SECURITY`);
  await knex.raw(`DROP POLICY IF EXISTS tenant_isolation ON ${MT}`);
  await knex.raw(`
    CREATE POLICY tenant_isolation ON ${MT}
      USING (tenant_id = public.current_tenant_id())
      WITH CHECK (tenant_id = public.current_tenant_id())
  `);
  await knex.raw(`GRANT SELECT, INSERT, UPDATE, DELETE ON ${MT} TO app_runtime`);

  await knex.raw(`COMMENT ON TABLE ${MT} IS
    $$[PR.E0b] La meta de margen como DATO CAPTURADO, no constante (MR.4, diseñada 2026-08 y nunca
    construida). Cascada producto > categoria > proveedor > default, con indice unico
    NULLS NOT DISTINCT (molde commercial.expiry_receiving_policy) y source/manual_lock/auto_tuned_at
    (molde analytics.kpi_thresholds, ADR-076/021: el recalculo automatico NO pisa lo que fijo un
    humano). Mata las 3 constantes 15 de commercial-actions, commercial-profitability y
    comercial-rentabilidad. margen_minimo nace NULL: el piso NO es determinable hasta que se
    resuelva la reclasificacion de 401-002 (D13, $352M). Un default MEDIDO no es un default
    AUTORIZADO: source='default_medido' significa "asi se opera hoy, nadie lo firmo".$$`);

  // ═══ 2. commercial.pricing_settings — lo global por tenant ════════════════════════════════
  // Molde: finance.receipt_settings (mig 20260827130000) — PK = tenant_id, una fila por tenant.
  if (!(await knex.schema.withSchema('commercial').hasTable('pricing_settings'))) {
    await knex.schema.withSchema('commercial').createTable('pricing_settings', (t) => {
      t.uuid('tenant_id').primary();

      // ── Medidos contra prod el 2026-09-29. Ver `evidencia_*`.
      t.integer('cola_max_dia').nullable();          // capacidad real de cambios/día
      t.decimal('escalon_minimo_pct', 6, 3).nullable(); // Δ mínimo que justifica molestar a alguien
      t.decimal('tope_cambio_pct', 6, 3).nullable();  // cuánto es "mucho" de un solo golpe
      t.integer('frecuencia_max_anual').nullable();   // OBJ-5, estabilidad para el mayorista

      // ⛔ NULL con motivo, nunca un cero: no hay política de redondeo medida (sólo 3.6 % de los
      //    precios nuevos termina en `.00`; las terminaciones son casi uniformes).
      t.string('redondeo_modo', 20).nullable();       // null | '00' | '50' | '90' | '99'
      t.text('redondeo_motivo');

      t.text('source').notNullable().defaultTo('default_medido');
      t.boolean('manual_lock').notNullable().defaultTo(false);
      t.text('evidencia');

      t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
      t.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
      t.uuid('updated_by');
    });
    // eslint-disable-next-line no-console
    console.log(`  · [PR.E0b] ${PS} creada.`);
  }
  await check(knex, PS, 'pricing_settings_cola_positiva',
    `cola_max_dia IS NULL OR cola_max_dia > 0`);
  await check(knex, PS, 'pricing_settings_escalon_menor_tope',
    `escalon_minimo_pct IS NULL OR tope_cambio_pct IS NULL OR escalon_minimo_pct < tope_cambio_pct`);
  await check(knex, PS, 'pricing_settings_redondeo_valido',
    `redondeo_modo IS NULL OR redondeo_modo IN ('00','50','90','99')`);

  await knex.raw(`
    ALTER TABLE ${PS} DROP CONSTRAINT IF EXISTS fk_commercial_pricing_settings_tenant;
    ALTER TABLE ${PS} ADD CONSTRAINT fk_commercial_pricing_settings_tenant
      FOREIGN KEY (tenant_id) REFERENCES identity.tenants(id) ON DELETE RESTRICT;
  `);
  await knex.raw(`ALTER TABLE ${PS} ENABLE ROW LEVEL SECURITY`);
  await knex.raw(`ALTER TABLE ${PS} FORCE ROW LEVEL SECURITY`);
  await knex.raw(`DROP POLICY IF EXISTS tenant_isolation ON ${PS}`);
  await knex.raw(`
    CREATE POLICY tenant_isolation ON ${PS}
      USING (tenant_id = public.current_tenant_id())
      WITH CHECK (tenant_id = public.current_tenant_id())
  `);
  await knex.raw(`GRANT SELECT, INSERT, UPDATE, DELETE ON ${PS} TO app_runtime`);

  await knex.raw(`COMMENT ON TABLE ${PS} IS
    $$[PR.E0b] Parametros GLOBALES de precio por tenant (molde finance.receipt_settings).
    Los valores nacen MEDIDOS contra prod 2026-09-29, con source='default_medido' = "asi se opera
    hoy, nadie lo firmo". redondeo_modo nace NULL con motivo: se midio que NO existe politica de
    redondeo (3.6% de los precios nuevos termina en .00, terminaciones casi uniformes) — declarar
    la ausencia, no inventar una regla.$$`);

  // ═══ 3. Los defaults MEDIDOS ══════════════════════════════════════════════════════════════
  /**
   * ⭐ La fila DEFAULT del tenant (los tres ejes de ámbito en NULL).
   * `margen_objetivo = 15` NO es un número inventado: es exactamente el que hoy está clavado en
   * los tres archivos. Se persiste tal cual para que el cambio sea **cero-diff de comportamiento**
   * y lo único que cambie sea DÓNDE vive. Cuando Dirección lo corrija, `source` pasa a 'manual'.
   */
  await knex.raw(`
    INSERT INTO ${MT} (tenant_id, margen_objetivo, margen_minimo, minimo_motivo, source, evidencia)
    SELECT ?::uuid, 15.000, NULL,
      'NO DETERMINABLE: el gasto de operacion sobre tres denominadores da 9.62 / 12.57 / 15.53 %, '
      'y ninguno es defendible mientras 401-002 VENTA FLETES A TERCEROS tenga $352,070,966 de venta '
      'de mercancia mal clasificada (medido 2026-09-29, D13). Un piso inventado decide precios.',
      'default_medido',
      'Es el 15 % que ya estaba clavado en commercial-actions.service.ts:9, '
      'commercial-profitability.service.ts:190 y comercial-rentabilidad.component.ts:1014. '
      'Se persiste SIN cambiarlo para que esta migracion sea cero-diff de comportamiento. '
      'Margen bruto realmente medido a 2026-09-29: hecho 12.18 %, arbitro del ERP 14.95 %.'
    WHERE NOT EXISTS (
      SELECT 1 FROM ${MT} WHERE tenant_id = ?::uuid
        AND product_id IS NULL AND categoria IS NULL AND supplier_code IS NULL)
  `, [TENANT, TENANT]);

  await knex.raw(`
    INSERT INTO ${PS} (tenant_id, cola_max_dia, escalon_minimo_pct, tope_cambio_pct,
                       frecuencia_max_anual, redondeo_modo, redondeo_motivo, source, evidencia)
    VALUES (?::uuid, 106, 1.000, 20.000, 8, NULL,
      'NO HAY POLITICA DE REDONDEO. Medido 2026-09-29: solo el 3.6 % de los precios nuevos termina '
      'en .00 y el 4.8 % en .00/.50; las terminaciones son casi uniformes (.63, .21, .41). '
      'Instaurar una es DECISION de Direccion (D9), no un descubrimiento.',
      'default_medido',
      'cola_max_dia=106: mediana real de SKUs con cambio de precio por dia (p90=209). '
      'frecuencia_max_anual=8: 2x la base medida de 4 cambios/anio por (SKU, plaza). '
      'escalon_minimo_pct=1.0 y tope_cambio_pct=20: NO medidos, son topes de arranque '
      'conservadores contra la magnitud mediana real de 3.82 % por cambio. Direccion los corrige (P4, P5).')
    ON CONFLICT (tenant_id) DO NOTHING
  `, [TENANT]);

  // ═══ 4. El rastro de auditoría — se engancha al primitivo que YA existe ═══════════════════
  /**
   * ⭐ `analytics.log_master_data_change()` (VP.3.1, mig 20260907130000) ya vigila precio, etiqueta
   * y reorden. Una META DE MARGEN mueve dinero igual que un precio: quién la cambió y desde qué
   * valor es exactamente lo que `master_data_history` existe para guardar. Se **engancha**, no se
   * reimplementa (ADR-056: un primitivo no se inventa dos veces).
   *
   * ⚠️ El array `VIGILADAS` de aquella migración corre una sola vez, así que las tablas nuevas se
   * enganchan acá. **Su espejo en `database/tests/test-newdb-master-data-history.js` viaja en el
   * mismo commit** — si divergen, la historia miente por omisión (lo dice el propio test).
   */
  const AUDITADAS = {
    [MT]: ['margen_objetivo', 'margen_minimo', 'source', 'manual_lock', 'vigencia_hasta'],
    [PS]: ['cola_max_dia', 'escalon_minimo_pct', 'tope_cambio_pct', 'frecuencia_max_anual',
      'redondeo_modo', 'manual_lock'],
  };
  const { rows: fn } = await knex.raw(
    `SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'analytics' AND p.proname = 'log_master_data_change'`,
  );
  if (!fn.length) {
    // eslint-disable-next-line no-console
    console.log('  · [PR.E0b] ⚠️ falta analytics.log_master_data_change (mig 20260907130000): sin auditoría.');
  } else {
    for (const [tabla, cols] of Object.entries(AUDITADAS)) {
      const [schema, name] = tabla.split('.');
      // Una columna mal escrita sería un hueco MUDO: el trigger no la vería y nada fallaría.
      const { rows: existentes } = await knex.raw(
        `SELECT column_name FROM information_schema.columns WHERE table_schema=? AND table_name=?`,
        [schema, name],
      );
      const set = new Set(existentes.map((r) => r.column_name));
      const faltantes = cols.filter((c) => !set.has(c));
      if (faltantes.length) {
        throw new Error(`[PR.E0b] ${tabla}: columnas auditadas inexistentes → ${faltantes.join(', ')}`);
      }
      const args = cols.map((c) => `'${c}'`).join(', ');
      await knex.raw(`
        DROP TRIGGER IF EXISTS trg_master_data_history ON ${tabla};
        CREATE TRIGGER trg_master_data_history
          AFTER UPDATE OR DELETE ON ${tabla}
          FOR EACH ROW EXECUTE FUNCTION analytics.log_master_data_change(${args});
      `);
      // eslint-disable-next-line no-console
      console.log(`  · [PR.E0b] auditoría enganchada en ${tabla} (${cols.length} columnas).`);
    }
  }

  const { rows: n } = await knex.raw(
    `SELECT (SELECT count(*) FROM ${MT} WHERE tenant_id = ?::uuid)::int AS metas,
            (SELECT count(*) FROM ${PS} WHERE tenant_id = ?::uuid)::int AS settings`,
    [TENANT, TENANT],
  );
  // eslint-disable-next-line no-console
  console.log(`  · [PR.E0b] metas: ${n[0].metas} · settings: ${n[0].settings}`);

  /**
   * ⛔ COMPUERTA. Sin la fila default, `resolveTarget()` no tiene a qué caer y el servicio
   * volvería al 15 hardcodeado en silencio — o sea, esta migración no habría servido de nada.
   */
  if (n[0].metas < 1 || n[0].settings < 1) {
    throw new Error('[PR.E0b] el seed no dejó la fila default: el resolvedor no tendría base.');
  }
};

exports.down = async function down(knex) {
  await knex.raw(`DROP TABLE IF EXISTS ${PS}`);
  await knex.raw(`DROP TABLE IF EXISTS ${MT}`);
};
