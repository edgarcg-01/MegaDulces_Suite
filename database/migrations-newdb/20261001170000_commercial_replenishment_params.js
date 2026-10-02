'use strict';
/**
 * `[RA-DYN.P4]` — **EL VECTOR DE PARÁMETROS DEL MOTOR DE PEDIDO, EN DATOS Y NO EN `.env`.**
 *
 * ── Por qué es lo PRIMERO de la fase ────────────────────────────────────────────────────────
 * Hoy los números que gobiernan el reorden viven en variables de entorno leídas por los
 * importers (`import-computed-reorder.js:38-46`, `import-network-reorder.js:28-30`):
 * `REORDER_LEAD_DEFAULT`, `REORDER_CYCLE_DAYS`, `RA_SERVICE_A/B/C`, `RA_SAFETY_FLOOR_DAYS`,
 * `RA_CEDIS_SERVICE`. Eso tiene dos consecuencias medidas:
 *
 *   1. **Cambiar un número exige un despliegue**, así que nadie los ajusta y quedan donde
 *      nacieron.
 *   2. **Una sugerencia vieja no se puede explicar.** No hay forma de saber con qué nivel de
 *      servicio se calculó el pedido de hace dos meses, porque el valor no quedó en ningún lado.
 *      Sin esto, el log de sugerencias (`[RA-DYN.P2]`) guardaría el QUÉ sin el CON QUÉ, y el
 *      cruce de precisión no podría distinguir «el motor falló» de «le cambiaron los parámetros».
 *
 * ── ⛔ ESTE COMMIT NO MUEVE NINGÚN NÚMERO, A PROPÓSITO ──────────────────────────────────────
 * El seed transcribe **exactamente** los defaults vigentes (0.98 / 0.95 / 0.90, lead 7, ciclo 14,
 * piso 2, CEDIS 0.98, ABC 0.80/0.95, XYZ 0.5/1.0). Es una traducción de sede, no un ajuste: el
 * sugerido tiene que quedar idéntico al centavo. El antes/después de esta migración debe dar
 * **cero diferencia**; si da distinto, la transcripción está mal y hay que parar.
 * Cambiar un parámetro es un commit APARTE, con su propia medición.
 *
 * ── Modelo temporal: append-only, sólo `valid_from` ─────────────────────────────────────────
 * Sin `valid_to`. Una versión nueva es **un solo INSERT**, así que el solape de intervalos es
 * imposible por construcción — un modelo `[valid_from, valid_to)` exigiría UPDATE de la fila
 * anterior + INSERT, dos escrituras que en carrera dejan solapes o huecos.
 *
 * Y más importante: cerrar un intervalo **mutaría una fila que una sugerencia pasada ya
 * referenció**. Acá la fila es evidencia, y la evidencia no se edita. Por eso los GRANT de abajo
 * dan SELECT e INSERT y **niegan UPDATE y DELETE** a `app_runtime`: la inmutabilidad es una
 * garantía del motor de la base, no una buena intención del código que la usa.
 *
 * El intervalo, si alguna vez se necesita, se DERIVA con `lead(valid_from) OVER (...)` en una
 * vista — derivar, no materializar.
 *
 * ⚠️ La lectura por corrida compara contra `now()`, **NUNCA contra `CURRENT_DATE`**: el
 * precedente de `identity.user_responsibilities` ya cobró ese silencio (un `timestamptz` de
 * `now()` contra `<= CURRENT_DATE` da false y la fila no llega, sin error).
 *
 * ── ⛔ EL CHECK QUE ATRAPA UN DESASTRE SILENCIOSO ───────────────────────────────────────────
 * `invNorm` (Acklam) abre con `if (p <= 0 || p >= 1) return 0;`. O sea un nivel de servicio de
 * **1.0 devuelve Z = 0**, y `ceil(0 * sigma * sqrt(lead))` es **colchón CERO** — el valor que
 * parece «servicio perfecto» produce el inventario de seguridad más bajo posible, sin error ni
 * aviso. Por eso el rango es `> 0.5 AND < 1` y no `BETWEEN 0 AND 1`: por debajo de 0.5 la Z es
 * negativa (el modelo queda invertido) y en 1 exacto se apaga el colchón.
 *
 * ⚠️ Límite honesto de lo que un CHECK puede hacer: **ordena y acota, no acuerda.**
 * `service_a = 0.999` pasa todas las restricciones y da Z ≈ 3.09, que infla el colchón de toda
 * la clase A. Eso no lo atrapa una constraint — lo atrapa la medición antes/después. No se
 * vende esta restricción como si cubriera más de lo que cubre.
 *
 * Calca el patrón de `analytics.kpi_thresholds` (`20260921120000`, `kpi_thr_umbrales_coherentes`):
 * el CHECK convierte un descuido en un error ruidoso. Y va en la **base de datos**, no sólo en la
 * app, porque en este repo **los importers escriben directo, sin pasar por NestJS** — una
 * validación sólo en la capa de aplicación sería un no-op para quien de verdad consume esto.
 */

const SCHEMA = 'commercial';
const TABLA = 'replenishment_params';
const FULL = `${SCHEMA}.${TABLA}`;
const MEGA = '00000000-0000-0000-0000-00000000d01c';

exports.up = async function up(knex) {
  const existe = await knex.schema.withSchema(SCHEMA).hasTable(TABLA);
  if (!existe) {
    await knex.schema.withSchema(SCHEMA).createTable(TABLA, (t) => {
      t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
      t.uuid('tenant_id').notNullable();
      // El instante desde el que esta versión manda. No hay valid_to: ver cabecera.
      t.timestamp('valid_from', { useTz: true }).notNullable().defaultTo(knex.fn.now());

      // ── Nivel de servicio por clase ABC → Z de Acklam → colchón ──
      t.decimal('service_a', 6, 4).notNullable();
      t.decimal('service_b', 6, 4).notNullable();
      t.decimal('service_c', 6, 4).notNullable();
      // El CEDIS protege a toda la red aguas abajo, por eso tiene el suyo (import-network-reorder).
      t.decimal('service_cedis', 6, 4).notNullable();

      // ── Tiempos ──
      // Lead por default cuando el proveedor no lo tiene capturado. ⚠️ Medido 2026-10-01: 0 de
      // 1,318 proveedores tienen lead_time_days, así que HOY este default aplica a TODOS.
      t.integer('lead_default_days').notNullable();
      t.integer('cycle_days').notNullable();
      t.integer('safety_floor_days').notNullable();

      // ── Cortes de clasificación ──
      t.decimal('abc_a_cut', 5, 4).notNullable();   // Pareto acumulado: < a_cut → 'A'
      t.decimal('abc_b_cut', 5, 4).notNullable();   // < b_cut → 'B'; resto → 'C'
      t.decimal('xyz_x_max', 6, 4).notNullable();   // CV <= x_max → 'X'
      t.decimal('xyz_y_max', 6, 4).notNullable();   // CV <= y_max → 'Y'; resto → 'Z'

      // Obligatoria: un parámetro sin procedencia es el mismo problema que una cifra sin
      // procedencia. Dice de dónde salió este juego de valores y por qué.
      t.text('source').notNullable();
      t.text('note').nullable();

      t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
      t.uuid('created_by').nullable();
    });
    console.log(`  [RA-DYN.P4] ${FULL} creada`);
  } else {
    console.log(`  [RA-DYN.P4] ${FULL} ya existe`);
  }

  const check = async (nombre, expr) => {
    const ya = await knex.raw(
      `SELECT 1 FROM pg_constraint WHERE conname = ? AND conrelid = ?::regclass`,
      [nombre, FULL],
    );
    if (ya.rowCount === 0) {
      await knex.raw(`ALTER TABLE ${FULL} ADD CONSTRAINT ${nombre} CHECK (${expr})`);
      console.log(`  [RA-DYN.P4] +CHECK ${nombre}`);
    }
  };

  // RANGO — el que atrapa el Z=0 silencioso de invNorm (ver cabecera).
  await check(
    'rp_service_rango',
    `service_a > 0.5 AND service_a < 1
     AND service_b > 0.5 AND service_b < 1
     AND service_c > 0.5 AND service_c < 1
     AND service_cedis > 0.5 AND service_cedis < 1`,
  );

  /*
   * ORDEN — el descuido que de verdad ocurre: dejar a la clase C con MÁS nivel de servicio que a
   * la A. El motor no falla: le da más colchón a lo que menos vale y menos a lo que sostiene la
   * venta, en silencio y para siempre. Con el CHECK, ese INSERT se rechaza.
   */
  await check('rp_service_orden', `service_a >= service_b AND service_b >= service_c`);

  // ORDEN de los cortes de clasificación. Es el caso exacto que motivó esta tabla: si X=0.5 e
  // Y=0.3, el CASE del clasificador nunca puede devolver 'Y' y la clase desaparece sin ruido.
  await check('rp_xyz_orden', `xyz_x_max > 0 AND xyz_x_max < xyz_y_max`);
  await check(
    'rp_abc_orden',
    `abc_a_cut > 0 AND abc_a_cut < abc_b_cut AND abc_b_cut < 1`,
  );

  // Tiempos: un lead o un ciclo en 0 divide por cero aguas abajo o apaga el término por completo.
  await check(
    'rp_tiempos_positivos',
    `lead_default_days > 0 AND cycle_days > 0 AND safety_floor_days >= 0`,
  );
  await check('rp_source_no_vacia', `btrim(source) <> ''`);

  /*
   * Una sola versión por instante y tenant. Sin esto se pueden insertar dos filas con el mismo
   * `valid_from` y el `ORDER BY valid_from DESC LIMIT 1` de la carga por corrida tomaría
   * cualquiera de las dos — un motor que cambia de parámetros entre corridas idénticas.
   */
  await knex.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS rp_tenant_valid_from_uniq
    ON ${FULL} (tenant_id, valid_from)`);
  // El índice de la lectura caliente: una vez por corrida, O(1).
  await knex.raw(`
    CREATE INDEX IF NOT EXISTS rp_lookup
    ON ${FULL} (tenant_id, valid_from DESC)`);

  await knex.raw(`ALTER TABLE ${FULL} ENABLE ROW LEVEL SECURITY`);
  await knex.raw(`ALTER TABLE ${FULL} FORCE ROW LEVEL SECURITY`);
  await knex.raw(`
    DO $$ BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_policies
        WHERE schemaname='${SCHEMA}' AND tablename='${TABLA}' AND policyname='tenant_isolation'
      ) THEN
        CREATE POLICY tenant_isolation ON ${FULL}
          USING (tenant_id = public.current_tenant_id())
          WITH CHECK (tenant_id = public.current_tenant_id());
      END IF;
    END $$`);

  /*
   * ⛔ SELECT e INSERT, SIN UPDATE NI DELETE — a propósito.
   * El modelo append-only deja de ser una convención que alguien puede olvidar y pasa a ser una
   * garantía del motor: una fila que una sugerencia ya referenció no se puede editar ni borrar.
   * Corregir un valor = insertar una versión nueva, que es justamente el historial que queremos.
   */
  await knex.raw(`GRANT SELECT, INSERT ON ${FULL} TO app_runtime`);

  await knex.raw(`
    COMMENT ON TABLE ${FULL} IS
    '[RA-DYN.P4] Vector de parametros del motor de pedido, versionado. APPEND-ONLY: solo '
    'valid_from, sin valid_to, y app_runtime no tiene UPDATE ni DELETE -- una version nueva es un '
    'INSERT, y la fila que una sugerencia ya referencio no se edita. La lectura es una vez por '
    'corrida (ORDER BY valid_from DESC LIMIT 1 contra now(), NUNCA contra CURRENT_DATE) y sus '
    'valores entran al SQL set-based como binds nombrados, nunca interpolados. '
    'Reemplaza las env REORDER_LEAD_DEFAULT / REORDER_CYCLE_DAYS / RA_SERVICE_A,B,C / '
    'RA_SAFETY_FLOOR_DAYS / RA_CEDIS_SERVICE que leian import-computed-reorder.js e '
    'import-network-reorder.js. El seed transcribe los defaults vigentes al 2026-10-01: NO mueve '
    'ningun numero, el sugerido debe quedar identico. '
    'CHECK rp_service_rango acota a (0.5, 1) porque invNorm devuelve 0 en p>=1, o sea un nivel de '
    'servicio de 1.0 daria COLCHON CERO en silencio.'
  `);

  /*
   * ── SEED: la transcripción, no una propuesta ──
   * Son los defaults que hoy están corriendo. Idempotente: si el tenant ya tiene una versión, no
   * se agrega otra (esta migración no debe fabricar historial cada vez que corre).
   */
  const ya = await knex(FULL).where({ tenant_id: MEGA }).first();
  if (!ya) {
    await knex(FULL).insert({
      tenant_id: MEGA,
      service_a: 0.98,
      service_b: 0.95,
      service_c: 0.90,
      service_cedis: 0.98,
      lead_default_days: 7,
      cycle_days: 14,
      safety_floor_days: 2,
      abc_a_cut: 0.80,
      abc_b_cut: 0.95,
      xyz_x_max: 0.5,
      xyz_y_max: 1.0,
      source: 'transcripcion-env-2026-10-01',
      note:
        'Defaults vigentes al 2026-10-01, copiados de import-computed-reorder.js:38-46, '
        + 'import-network-reorder.js:28-30 e import-inventory-health.js:89-95 (cortes XYZ) y '
        + 'migracion 20260910190000_v_abc_class.js:100-103 (cortes ABC). No es un ajuste: el '
        + 'sugerido debe quedar identico al centavo.',
    });
    console.log('  [RA-DYN.P4] seed: version inicial (transcripcion de los defaults vigentes)');
  } else {
    console.log('  [RA-DYN.P4] seed omitido: el tenant ya tiene una version');
  }

  const n = await knex(FULL).count({ n: '*' }).first();
  console.log(`  [RA-DYN.P4] ${FULL}: ${n.n} version(es)`);
};

exports.down = async function down(knex) {
  await knex.schema.withSchema(SCHEMA).dropTableIfExists(TABLA);
  console.log(`  [RA-DYN.P4] ${FULL} eliminada`);
};
