/**
 * [OBS.3.2] `analytics.ods_branch_checks` — la prueba de que una sucursal fue **REVISADA**.
 *
 * ── LA DISTINCIÓN QUE ESTA TABLA EXISTE PARA SOSTENER ────────────────────────────────────
 * El carril prueba que se revisó. La tabla del ODS dice cuándo cambió. **Son preguntas distintas
 * y hacen falta las dos** — la fase entera nace de haber tenido sólo una.
 *
 * Lo que ya había no alcanzaba, y cada cosa por su propio motivo:
 *
 *   `kepler_ods._sync_status`      Se escribe SÓLO cuando llega un lote, y el carril hash **no
 *                                  empuja nada si no hay cambios** (`replicate-ods-live.js:382`
 *                                  corta antes del POST). Una llave vieja ahí puede significar
 *                                  "el carril murió" o "esa rama no cambió de precio en tres
 *                                  días". Ambiguo → inservible para alarmar.
 *   `kepler_ods_branch_stale`      Mira `kdm1` = **venta**, no catálogo. Por eso seis días de
 *                                  catálogo congelado no dispararon un solo sensor por rama.
 *   el latido del carril           Agrega: dice "7/7 ramas". Verde con 1/1 si alguien deja el
 *                                  contenedor con `--branch=03`, y verde también si una tabla
 *                                  se cae de `KP_ODS_TABLES`.
 *
 * Esta tabla la escribe el shipper al cerrar la pasada de CADA rama, haya o no filas que mandar.
 * Por eso `last_check_at` no es ambigua: si no avanzó, **nadie miró esa rama**. Punto.
 *
 * `tables_checked` está para cazar la deriva de configuración: si una rama pasa de revisar 19
 * tablas a 12 porque alguien editó una variable de entorno, el conteo cae y el sensor lo dice.
 * Sin esto, quitar `kdii` del carril es un cambio invisible — y es exactamente la clase de
 * cambio invisible que costó los seis días.
 *
 * ── POR QUÉ TABLA Y NO `cron_runs` ───────────────────────────────────────────────────────
 * Se evaluó meter llaves `ods_live_hot:03` en `analytics.cron_runs` (cero migración). Se descartó:
 * `checkCronRuns` clasifica con `cfg ? classify(...) : 'ok'`, así que catorce llaves sin registrar
 * en `CRON_JOBS` serían catorce filas en **verde incondicional** — precisamente el bug que esta
 * fase existe para cerrar. Una fila que reporta "ok" sin umbral detrás no se crea.
 *
 * Es dato OPERACIONAL propio (misma categoría que `cron_runs` o `db_health_alerts`), no una copia
 * de nada del ERP: no la alcanza la regla de derive-no-copy.
 */
exports.up = async function up(knex) {
  await knex.raw(`CREATE SCHEMA IF NOT EXISTS analytics`);

  const existe = await knex.schema.withSchema('analytics').hasTable('ods_branch_checks');
  if (!existe) {
    await knex.schema.withSchema('analytics').createTable('ods_branch_checks', (t) => {
      t.uuid('tenant_id').notNullable();
      /** Carril que revisó: `ods_live_hot`, `ods_live_mirror`. Mismo vocabulario que `cron_runs`. */
      t.text('lane').notNullable();
      /** Sucursal Kepler ('00'..'06'). Text, no int: '00' no es 0 y perder el cero rompe los joins. */
      t.text('sucursal').notNullable();
      /**
       * NULLABLE a propósito, y sólo avanza cuando la pasada de esa rama **cerró bien**. Si el
       * replica no conectó, la rama NO fue revisada: bumpear la marca ahí sería registrar como
       * hecho algo que falló. NULL = nunca se pudo revisar, y el sensor lo trata como lo peor,
       * no como "sin datos" — sin señal no es ok.
       */
      t.timestamp('last_check_at', { useTz: true });
      /** Cuántas tablas se revisaron en esa pasada. Cae si alguien recorta la config. */
      t.integer('tables_checked').defaultTo(0);
      /** Filas efectivamente shipeadas. Puede ser 0 legítimamente: no cambió nada. */
      t.integer('rows_shipped').defaultTo(0);
      /** Último error de esa rama, si lo hubo. NULL = la pasada cerró limpia. */
      t.text('last_error');
      t.primary(['tenant_id', 'lane', 'sucursal']);
    });
  }

  // El sensor barre por carril buscando la rama más atrasada.
  await knex.raw(`
    CREATE INDEX IF NOT EXISTS ix_ods_branch_checks_lane
      ON analytics.ods_branch_checks (tenant_id, lane, last_check_at)`);

  await knex.raw(`GRANT SELECT, INSERT, UPDATE ON analytics.ods_branch_checks TO app_runtime`);
  await knex.raw(`COMMENT ON TABLE analytics.ods_branch_checks IS
    'OBS.3.2 — prueba de que el carril REVISO cada sucursal (distinto de haberle empujado filas). La escribe replicate-ods-live al cerrar la pasada de cada rama, haya o no cambios; por eso last_check_at no es ambigua.'`);
};

exports.down = async function down(knex) {
  await knex.schema.withSchema('analytics').dropTableIfExists('ods_branch_checks');
};
