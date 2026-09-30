'use strict';
/**
 * `[PR.D2]` — **El experimento de precio: no-inferioridad, estratificado, reproducible.**
 *
 * ── Por qué este experimento y no el que el plan decía ─────────────────────────────────────
 * El plan original preguntaba *"¿aterrizar el precio hace vender más?"*. **El experimento
 * natural cerró esa puerta**, medido tres veces sobre los cambios de precio que ya ocurrieron:
 *
 *   · DiD en medianas ............ 0.00 % contra 0.00 %
 *   · placebo de pre-tendencia ... −0.69 pp (las dos ramas venían iguales)
 *   · DiD en medias con IC ....... **−9.19 pp, IC 95 % [−48.20, +29.82]**, t = −0.46
 *
 * ⛔ Si el efecto psicológico sobre el volumen existe, es **más chico que lo que cualquier
 * diseño observacional puede detectar acá** (sd de 1,444 sobre medias de 109 %). Perseguirlo
 * costaría meses para terminar sin poder concluir.
 *
 * ⭐ **Pero la ganancia no depende de ese efecto.** El alza implícita de aterrizar es cierta:
 * **+$659,564/30 d** en el modo `.99`. Así que la pregunta se invierte:
 *
 *     de  "¿aterrizar hace vender MÁS?"   (superioridad, efecto desconocido)
 *     a   "¿el alza de aterrizar hace CAER el volumen?"   (NO-INFERIORIDAD)
 *
 * Es la diferencia entre perseguir una ganancia incierta y **confirmar que una ganancia cierta
 * no cuesta nada**. Y necesita mucha menos potencia.
 *
 * ── ⭐⭐ El δ sale de la aritmética del negocio, no de una convención ───────────────────────
 * Si el precio sube `a` y el volumen cae `q`, el margen total no empeora mientras
 * `(1−q) ≥ (P−C) / (P(1+a)−C)`. Con el margen real medido por rango:
 *
 *   | rango        | margen  | alza .99 | ⭐ δ tolerable | n por rama | celdas | viable |
 *   |--------------|---------|----------|---------------|------------|--------|--------|
 *   | < $10        | 26.72 % |  6.617 % |   **19.85 %** |      ~291  |  6,293 | ✅     |
 *   | $10 – $50    | 23.60 % |  1.802 % |     7.09 %    |    ~2,630  | 42,782 | ✅     |
 *   | $50 – $100   | 23.64 % |  0.740 % |     3.04 %    |   ~14,900  | 24,295 | ⚠️ justo |
 *   | > $100       | 23.48 % |  0.258 % |     1.09 %    | **~118,000** | 10,637 | ⛔ NO |
 *
 * (n con α 5 % una cola, potencia 80 %, sd de `ln(post/pre)` = **1.0722** medida sobre 26,562
 * eventos reales.)
 *
 * ⭐ **El tramo donde el experimento SÍ se puede hacer es justo donde está el dinero:** < $50
 * concentra **$539,169 de $659,564 = 81.7 % del upside** sobre apenas el 45.2 % de la venta.
 * El tramo imposible (> $100) aporta **2.6 %**. El experimento no necesita cubrir todo.
 *
 * ⛔ Y para > $100 se **declara que no se puede probar**. Esa es la respuesta honesta, no un
 * experimento sin potencia que devuelva "no concluyente" y se lea como "no funciona".
 *
 * ── Lo que estas tablas NO hacen ───────────────────────────────────────────────────────────
 * ⛔ **No aplican precios.** Kepler es read-only por decisión (ADR-040): el experimento genera
 *    la lista y una persona la captura. Por eso existe `aplicado_at` — sin él, un experimento
 *    cuyo tratamiento nunca se capturó se mediría igual y diría "no hubo efecto".
 * ⛔ **No deciden la política.** Producen la evidencia con la que Dirección decide.
 *
 * @param { import("knex").Knex } knex
 */

const EXP = 'commercial.price_experiments';
const UNI = 'commercial.price_experiment_units';

async function check(knex, tabla, nombre, expr) {
  const [{ hay }] = (await knex.raw(
    `SELECT count(*)::int AS hay FROM pg_constraint
      WHERE conrelid = ?::regclass AND conname = ?`, [tabla, nombre])).rows;
  if (!hay) await knex.raw(`ALTER TABLE ${tabla} ADD CONSTRAINT ${nombre} CHECK (${expr})`);
}

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);

  // ── 1 · LA CABECERA ─────────────────────────────────────────────────────────────────
  if (!(await knex.schema.withSchema('commercial').hasTable('price_experiments'))) {
    await knex.schema.withSchema('commercial').createTable('price_experiments', (t) => {
      t.uuid('id').notNullable().defaultTo(knex.raw('gen_random_uuid()'));
      t.uuid('tenant_id').notNullable();
      t.text('nombre').notNullable();

      // ⭐ La hipotesis se escribe ANTES de asignar. Un experimento cuya hipotesis se
      //    redacta despues de ver el resultado no es un experimento.
      t.text('hipotesis').notNullable();
      t.text('tipo').notNullable();            // no_inferioridad | superioridad
      t.text('metrica').notNullable();         // ln_volumen | margen_absoluto
      t.text('modo_aterrizaje').notNullable(); // 00 | 50 | 90 | 99

      t.decimal('alfa', 5, 4).notNullable().defaultTo(0.05);
      t.decimal('potencia', 5, 4).notNullable().defaultTo(0.80);
      t.integer('ventana_pre_dias').notNullable().defaultTo(28);
      t.integer('ventana_post_dias').notNullable().defaultTo(28);

      /**
       * ⭐ La SEMILLA. Sin ella la asignacion no se puede reproducir, y un experimento que no
       * se puede reproducir no se puede auditar: cualquiera podria sospechar que las ramas se
       * eligieron despues de ver quien ganaba.
       */
      t.bigInteger('semilla').notNullable();

      t.text('estado').notNullable().defaultTo('diseno');
      t.date('fecha_inicio');
      t.date('fecha_fin');

      // El resultado se escribe UNA vez, al concluir, con su motivo.
      t.text('resultado');        // no_inferior | inferior | no_concluyente | abortado
      t.text('resultado_motivo');
      t.jsonb('resultado_datos'); // el calculo completo, para poder rehacerlo

      t.text('creado_por');
      t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
      t.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());

      t.primary(['tenant_id', 'id']);
      t.unique(['tenant_id', 'nombre']);
    });
  }

  await check(knex, EXP, 'price_exp_tipo_valido',
    `tipo IN ('no_inferioridad', 'superioridad')`);
  await check(knex, EXP, 'price_exp_metrica_valida',
    `metrica IN ('ln_volumen', 'margen_absoluto')`);
  await check(knex, EXP, 'price_exp_modo_valido',
    `modo_aterrizaje IN ('00', '50', '90', '99')`);
  await check(knex, EXP, 'price_exp_estado_valido',
    `estado IN ('diseno', 'asignado', 'en_curso', 'concluido', 'abortado')`);
  await check(knex, EXP, 'price_exp_resultado_valido',
    `resultado IS NULL OR resultado IN ('no_inferior','inferior','no_concluyente','abortado')`);
  // ⛔ Un resultado sin motivo es un veredicto sin defensa.
  await check(knex, EXP, 'price_exp_resultado_con_motivo',
    `resultado IS NULL OR btrim(coalesce(resultado_motivo, '')) <> ''`);
  await check(knex, EXP, 'price_exp_ventanas_positivas',
    `ventana_pre_dias > 0 AND ventana_post_dias > 0`);
  await check(knex, EXP, 'price_exp_alfa_potencia',
    `alfa > 0 AND alfa < 1 AND potencia > 0 AND potencia < 1`);
  // ⛔ Concluido exige fechas: no se puede cerrar lo que no se sabe cuando corrio.
  await check(knex, EXP, 'price_exp_concluido_con_fechas',
    `estado <> 'concluido' OR (fecha_inicio IS NOT NULL AND fecha_fin IS NOT NULL)`);

  await knex.raw(`ALTER TABLE ${EXP} ENABLE ROW LEVEL SECURITY`);
  await knex.raw(`ALTER TABLE ${EXP} FORCE ROW LEVEL SECURITY`);
  await knex.raw(`DROP POLICY IF EXISTS tenant_isolation ON ${EXP}`);
  await knex.raw(`CREATE POLICY tenant_isolation ON ${EXP}
    USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id())`);
  await knex.raw(`GRANT SELECT, INSERT, UPDATE ON ${EXP} TO app_runtime`);

  // ── 2 · LA ASIGNACIÓN ───────────────────────────────────────────────────────────────
  if (!(await knex.schema.withSchema('commercial').hasTable('price_experiment_units'))) {
    await knex.schema.withSchema('commercial').createTable('price_experiment_units', (t) => {
      t.uuid('id').notNullable().defaultTo(knex.raw('gen_random_uuid()'));
      t.uuid('tenant_id').notNullable();
      t.uuid('experiment_id').notNullable();

      t.text('sucursal').notNullable();
      t.text('sku').notNullable();
      t.text('unit_kind');

      // ⭐ El estrato define el delta: en < $10 se tolera 19.85% de caida y en > $100 apenas
      //    1.09%. Un delta unico haria el experimento imposible en un tramo e inutil en otro.
      t.text('estrato').notNullable();
      t.decimal('delta_pct', 6, 3).notNullable();

      t.text('rama').notNullable();  // tratamiento | control

      t.decimal('precio_antes', 12, 4).notNullable();
      t.decimal('precio_propuesto', 12, 4).notNullable();

      /**
       * ⭐⭐ LO QUE SALVA AL EXPERIMENTO DE MENTIR. Kepler es read-only: la lista la captura
       * una persona. Si el tratamiento no se capturo, su volumen no se movio porque el precio
       * NO CAMBIO -- y medirlo igual devolveria "no hubo efecto", que es la conclusion opuesta
       * a la verdad. Sin aplicado_at, la unidad se excluye del analisis.
       */
      t.timestamp('aplicado_at', { useTz: true });
      t.text('aplicado_por');
      t.text('no_aplicado_motivo');

      t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());

      t.primary(['tenant_id', 'id']);
      t.foreign(['tenant_id', 'experiment_id']).references(['tenant_id', 'id']).inTable(EXP);
      // Una celda no puede estar dos veces en el mismo experimento.
      t.unique(['tenant_id', 'experiment_id', 'sucursal', 'sku', 'unit_kind']);
      t.index(['tenant_id', 'experiment_id', 'rama']);
    });
  }

  await check(knex, UNI, 'price_exp_unit_rama_valida',
    `rama IN ('tratamiento', 'control')`);
  await check(knex, UNI, 'price_exp_unit_precios_positivos',
    `precio_antes > 0 AND precio_propuesto > 0`);
  await check(knex, UNI, 'price_exp_unit_delta_positivo',
    `delta_pct > 0 AND delta_pct < 100`);
  /**
   * ⛔ EL CANDADO DEL CONTROL. Un control cuyo precio se mueve no es un control. Este CHECK
   * lo prohibe por construccion -- no depende de que el servicio se acuerde.
   */
  await check(knex, UNI, 'price_exp_unit_control_no_se_toca',
    `rama <> 'control' OR precio_propuesto = precio_antes`);
  // ⛔ Y el tratamiento TIENE que moverse: si no, es otro control disfrazado.
  await check(knex, UNI, 'price_exp_unit_tratamiento_se_mueve',
    `rama <> 'tratamiento' OR precio_propuesto <> precio_antes`);
  // ⛔ No aplicado exige motivo: el silencio se lee como "se aplico".
  await check(knex, UNI, 'price_exp_unit_no_aplicado_con_motivo',
    `aplicado_at IS NOT NULL OR rama = 'control' OR no_aplicado_motivo IS NULL
     OR btrim(no_aplicado_motivo) <> ''`);

  await knex.raw(`ALTER TABLE ${UNI} ENABLE ROW LEVEL SECURITY`);
  await knex.raw(`ALTER TABLE ${UNI} FORCE ROW LEVEL SECURITY`);
  await knex.raw(`DROP POLICY IF EXISTS tenant_isolation ON ${UNI}`);
  await knex.raw(`CREATE POLICY tenant_isolation ON ${UNI}
    USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id())`);
  await knex.raw(`GRANT SELECT, INSERT, UPDATE ON ${UNI} TO app_runtime`);

  await knex.raw(`COMMENT ON TABLE ${EXP} IS
    $c$[PR.D2] Experimentos de precio. El primero es de NO-INFERIORIDAD y no de superioridad,
    porque el experimento natural cerro la puerta a medir el efecto psicologico sobre el volumen:
    DiD en medianas 0.00 vs 0.00, placebo -0.69 pp, y DiD en medias con IC 95% [-48.20, +29.82]
    (t = -0.46). Si el efecto existe es mas chico que lo que un diseno observacional detecta aca.
    Pero la ganancia no depende de el: el alza implicita de aterrizar es cierta, +$659,564/30 d en
    modo .99. Por eso la pregunta se invierte a "el alza hace CAER el volumen?", que necesita
    mucha menos potencia. La hipotesis se escribe ANTES de asignar y la semilla queda guardada:
    un experimento que no se puede reproducir no se puede auditar.$c$`);

  await knex.raw(`COMMENT ON TABLE ${UNI} IS
    $c$[PR.D2] La asignacion, una fila por (sucursal, SKU, peldano). ESTRATIFICADA porque el
    margen de no-inferioridad cambia por orden de magnitud entre rangos: 19.85% bajo $10 contra
    1.09% arriba de $100, lo que hace falta n ~291 por rama en el primero y ~118,000 en el
    segundo -- o sea que arriba de $100 el experimento es IMPOSIBLE y eso se declara en vez de
    correrlo sin potencia. El tramo viable (< $50) concentra el 81.7% del upside sobre el 45.2%
    de la venta. aplicado_at es la columna que salva al experimento de mentir: Kepler es
    read-only (ADR-040), la lista la captura una persona, y un tratamiento que nunca se capturo
    mediria "no hubo efecto" -- la conclusion opuesta a la verdad.$c$`);

  // ── Compuerta ───────────────────────────────────────────────────────────────────────
  const [g] = (await knex.raw(`
    SELECT
      (SELECT count(*)::int FROM pg_constraint
        WHERE conrelid = '${EXP}'::regclass AND contype = 'c') AS checks_exp,
      (SELECT count(*)::int FROM pg_constraint
        WHERE conrelid = '${UNI}'::regclass AND contype = 'c') AS checks_uni,
      (SELECT c.relforcerowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'commercial' AND c.relname = 'price_experiments') AS rls_exp,
      (SELECT c.relforcerowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'commercial' AND c.relname = 'price_experiment_units') AS rls_uni`)).rows;

  // eslint-disable-next-line no-console
  console.log(`  · [PR.D2] experiments ${g.checks_exp} CHECKs · units ${g.checks_uni} CHECKs · `
    + `RLS forzada ${g.rls_exp}/${g.rls_uni}`);

  if (!g.rls_exp || !g.rls_uni) {
    throw new Error('[PR.D2] falta RLS FORZADA: sin ella el dueño de la tabla ve todos los tenants.');
  }
  if (g.checks_exp < 8 || g.checks_uni < 5) {
    throw new Error(`[PR.D2] faltan CHECKs: exp ${g.checks_exp} (min 8), units ${g.checks_uni} (min 5).`);
  }
};

exports.down = async function down(knex) {
  await knex.schema.withSchema('commercial').dropTableIfExists('price_experiment_units');
  await knex.schema.withSchema('commercial').dropTableIfExists('price_experiments');
};
