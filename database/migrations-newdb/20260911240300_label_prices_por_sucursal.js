/**
 * `[NORM.3]` `commercial.product_label_prices` pasa a grano **(tenant_id, product_id, sucursal)**.
 *
 * ── El defecto ───────────────────────────────────────────────────────────────────────────────
 * La tabla guardaba UNA fila por producto, con el precio elegido por `mode()` sobre las 8 plazas.
 * Pero en Kepler el precio **es** por sucursal. Medido en prod el 2026-09-11:
 *
 *   1,039 de 9,365 SKUs (11.1 %)  precio de pieza distinto entre plazas retail
 *                                  (brecha mediana 3.1 %, p90 37.3 %)
 *   1,729 de 69,711 pares (2.5 %)  publicaban un precio que NO era el de su plaza
 *   1,164 grupos PAQ (6.3 %)       mayoreo de paquete distinto entre plazas (961 CJA, 163 PZA)
 *
 * O sea: el mostrador y la etiqueta de anaquel de una tienda mostraban el número de otra. Y el
 * snapshot sin red, que se arma **por sucursal**, se alimentaba de esta tabla **sin filtrar por
 * sucursal** — el modo offline servía la moda a todas las plazas.
 *
 * ── Por qué la tabla y no una vista ──────────────────────────────────────────────────────────
 * Es la tabla principal normalizada del dato de etiqueta: PK, FK compuesta a `catalog.products`,
 * RLS forzado, alimentada al-momento desde el ODS por el hop-2. Lo que se deriva es la forma
 * CONSOLIDADA (`commercial.v_product_label_prices`), no al revés. El grano fino manda; lo agregado
 * se calcula.
 *
 * ── La trampa que esta migración existe para evitar ──────────────────────────────────────────
 * ⚠️ Seis lectores hacen `LEFT JOIN product_label_prices ON product_id` sin agregación: con 8
 * filas por producto **multiplicarían filas en silencio** (ventas, costos, planes de compra). Por
 * eso acá nace la vista consolidada y los lectores agregados se repuntan a ella: conservan
 * exactamente la semántica de hoy y no pueden multiplicar.
 *
 * ⚠️ Y el factor de unidad **sí** varía por plaza: 793 SKUs con `c81` (paquete) distinto y 795
 * con `c84` (caja). `analytics.v_product_box_factor` hace `MAX(box_size) GROUP BY product_id`:
 * con una sola fila eso era el valor; con ocho sería el máximo, y le cambiaría el factor canónico
 * a ~795 SKUs sin que nadie lo pidiera. Por eso se repunta a la vista consolidada (misma fila que
 * elegía la moda) y NO a la tabla.
 *
 * ── Lo que NO hace, y por qué ────────────────────────────────────────────────────────────────
 * ⛔ No retira `barcode`/`barcode_format` aunque `catalog.product_barcodes` los tenga. Con el
 * grano por plaza la columna de acá pasa a ser MÁS precisa que esa tabla, que no tiene sucursal
 * (184 SKUs tienen barcode de pieza distinto entre plazas). Primero la plaza tiene que llegar a
 * `product_barcodes`; recién entonces esta columna sobra. Queda declarado en el tracker.
 * ⛔ No retira `box_size`: no es copia del resolvedor canónico — es **entrada** suya
 * (`v_product_box_factor` la lee). Quitarla rompería los 33 objetos que cuelgan de esa vista.
 *
 * ── ⚠️ REQUIERE SEGUNDO PASO, NO ES OPCIONAL ─────────────────────────────────────────────────
 * Las 9,038 filas consolidadas de hoy **no son atribuibles a ninguna plaza** (son una moda), así
 * que se borran: la tabla es 100 % derivada del ODS y se re-deriva. Inmediatamente después hay
 * que correr el reconciliador, en la MISMA ventana:
 *
 *     node database/importers/kepler/import-label-data.js --apply   # → ~69,711 filas
 *
 * Entre el borrado y esa corrida la etiquetera y el mayoreo del verificador quedan vacíos. Por
 * eso va fuera de horario. El precio unitario del verificador NO se ve afectado (sale de `kdii`).
 *
 * @param { import("knex").Knex } knex
 */

exports.up = async function up(knex) {
  // ── Compuerta: ningún objeto vivo puede seguir leyendo la TABLA ────────────────────────────
  // Los cuatro que dependían de ella (`v_product_box_factor`, `v_sellout_daily`,
  // `mv_kepler_sales_daily`, `mv_wincaja_sales_daily`) hacen `max(box_size) GROUP BY product_id`.
  // Con una fila por producto eso ERA el valor; con ocho pasa a ser el máximo entre plazas, y el
  // factor de caja sí varía entre ellas (793 SKUs en `c81`, 795 en `c84`). No multiplicarían
  // filas — cambiarían de NÚMERO, que es peor porque no se nota. Se pregunta por dependencia real
  // (`pg_depend`), no por texto: un objeto renombrado sigue apuntando al mismo OID.
  //
  // Las dos matvistas del sell-out se DECLARAN, no se permiten en silencio: no existe
  // `CREATE OR REPLACE MATERIALIZED VIEW` y un `DROP CASCADE` se llevaría cinco objetos y 4.7 M de
  // filas. Medido cuánto compra ese riesgo: el `max(box_size)` entre plazas difiere del
  // consolidado en **6 SKUs de 9,366 (0.06 %)**, $868,071 de venta en 90 días sobre $156.8 M.
  // Se nombran una por una a propósito: una lista con nombres propios sigue frenando ante un
  // dependiente NUEVO, que es de lo que la compuerta tiene que proteger.
  const DECLARADAS = ['mv_kepler_sales_daily', 'mv_wincaja_sales_daily'];
  const { rows: deps } = await knex.raw(`
    SELECT DISTINCT n.nspname || '.' || c2.relname AS objeto, c2.relname AS corto
      FROM pg_depend d
      JOIN pg_rewrite rw ON rw.oid = d.objid
      JOIN pg_class c2   ON c2.oid = rw.ev_class
      JOIN pg_namespace n ON n.oid = c2.relnamespace
     WHERE d.refobjid = 'commercial.product_label_prices'::regclass
       AND c2.relname NOT IN ('product_label_prices', 'v_product_label_prices')`);
  const bloquean = deps.filter((d) => !DECLARADAS.includes(d.corto));
  if (bloquean.length) {
    throw new Error(
      '[NORM.3] ABORTA: estos objetos todavía leen la TABLA y cambiarían de valor al pasar a ' +
      `grano por sucursal — repuntalos a commercial.v_product_label_prices primero:\n  ${
        bloquean.map((d) => d.objeto).join('\n  ')}`,
    );
  }
  for (const d of deps) {
    console.warn(`[NORM.3] ⬜ DECLARADO: ${d.objeto} sigue leyendo la tabla (6 SKUs, $868,071/90d).`);
  }

  // ── Guarda: nada humano se pierde ──────────────────────────────────────────────────────────
  const { rows: manual } = await knex.raw(
    `SELECT count(*)::int AS n FROM commercial.product_label_prices WHERE source = 'manual'`,
  );
  if (manual[0].n > 0) {
    throw new Error(
      `[NORM.3] ABORTA: hay ${manual[0].n} fila(s) source='manual' (override humano). ` +
      'Esta migración borra lo derivado para re-derivarlo por plaza, y eso se las llevaría. ' +
      'Hay que decidir a qué sucursal pertenece cada una ANTES de correr esto.',
    );
  }

  const tiene = await knex.schema.withSchema('commercial').hasColumn('product_label_prices', 'sucursal');
  if (!tiene) {
    await knex.raw(`ALTER TABLE commercial.product_label_prices ADD COLUMN sucursal varchar(2)`);
  }

  // Lo derivado se va: una moda no pertenece a ninguna plaza y no se puede repartir sin inventar.
  const { rowCount: borradas } = await knex.raw(
    `DELETE FROM commercial.product_label_prices WHERE source <> 'manual'`,
  );

  await knex.raw(`ALTER TABLE commercial.product_label_prices ALTER COLUMN sucursal SET NOT NULL`);

  // La llave nueva. La vieja se va DESPUÉS de que exista la nueva, para no quedar sin ninguna.
  await knex.raw(`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'product_label_prices_tenant_product_suc_key') THEN
        ALTER TABLE commercial.product_label_prices
          ADD CONSTRAINT product_label_prices_tenant_product_suc_key UNIQUE (tenant_id, product_id, sucursal);
      END IF;
    END $$`);
  await knex.raw(`ALTER TABLE commercial.product_label_prices
                    DROP CONSTRAINT IF EXISTS product_label_prices_tenant_id_product_id_key`);

  await knex.raw(`CREATE INDEX IF NOT EXISTS ix_product_label_prices_suc
                    ON commercial.product_label_prices (tenant_id, sucursal, product_id)`);

  await knex.raw(`COMMENT ON COLUMN commercial.product_label_prices.sucursal IS
    'Plaza Kepler (kdii.sucursal). Parte de la llave: el precio y el mayoreo son POR TIENDA. La forma consolidada se deriva en commercial.v_product_label_prices.'`);

  // ── La vista consolidada deja de ser pasa-manos ─────────────────────────────────────────────
  // Nació en `20260911240000` como `SELECT * FROM la tabla`, para que los lectores se mudaran
  // ANTES del cambio de grano y se pudiera comprobar que devolvían lo mismo. Ahora que la tabla
  // tiene ocho filas por producto, la vista tiene que volver a elegir UNA — y elige exactamente la
  // que elegía `label-compute` antes de este cambio: moda del precio de pieza entre plazas retail,
  // y sólo si no hay retail, la de la 00. Así los consumidores agregados siguen viendo el mismo
  // número que hoy.
  //
  // ⚠️ `CREATE OR REPLACE VIEW` sólo admite AGREGAR columnas al final. Funciona porque `sucursal`
  // se agregó con `ALTER TABLE ADD COLUMN` (va última) y `l.*` la expande en ese mismo orden.
  await knex.raw(`
    CREATE OR REPLACE VIEW commercial.v_product_label_prices AS
    WITH moda AS (
      SELECT tenant_id, product_id,
             mode() WITHIN GROUP (ORDER BY piece_price DESC) FILTER (WHERE sucursal <> '00') AS m_retail,
             mode() WITHIN GROUP (ORDER BY piece_price DESC)                                 AS m_any
        FROM commercial.product_label_prices
       WHERE piece_price IS NOT NULL
       GROUP BY 1, 2)
    SELECT DISTINCT ON (l.tenant_id, l.product_id) l.*
      FROM commercial.product_label_prices l
      LEFT JOIN moda m ON m.tenant_id = l.tenant_id AND m.product_id = l.product_id
     ORDER BY l.tenant_id, l.product_id,
              (l.piece_price IS NOT DISTINCT FROM COALESCE(m.m_retail, m.m_any)) DESC,
              (l.sucursal = '00'), l.sucursal`);

  // ⚠️ `security_invoker` y el GRANT NO se heredan al recrear una vista sobre una tabla con RLS.
  await knex.raw(`ALTER VIEW commercial.v_product_label_prices SET (security_invoker = true)`);
  await knex.raw(`GRANT SELECT ON commercial.v_product_label_prices TO app_runtime`);
  await knex.raw(`COMMENT ON VIEW commercial.v_product_label_prices IS
    'Forma CONSOLIDADA (1 fila por producto) de commercial.product_label_prices, que tiene grano por sucursal. Reproduce la fila que elegía la moda antes de [NORM.3]. Los lectores que no distinguen plaza leen ACÁ — un LEFT JOIN a la tabla multiplicaría filas x8.'`);

  console.log(
    `[NORM.3] sucursal agregada · ${borradas} filas derivadas borradas (se re-derivan) · ` +
    'vista consolidada creada.\n' +
    '⚠️  PASO 2 OBLIGATORIO, en esta misma ventana:\n' +
    '    node database/importers/kepler/import-label-data.js --apply',
  );
};

/**
 * ⚠️ La columna `sucursal` NO se borra al revertir, y es a propósito.
 *
 * Borrarla obliga a recrear `commercial.v_product_label_prices` con una columna menos, y
 * `CREATE OR REPLACE VIEW` no permite quitar columnas → habría que hacer `DROP VIEW`. Pero a esta
 * altura del rollback `v_product_box_factor` y `v_sellout_daily` **todavía** cuelgan de esa vista
 * (sus `down` corren DESPUÉS, en orden inverso), así que el `DROP` exigiría `CASCADE` y se llevaría
 * dos vistas ajenas por delante — el mismo argumento que ya está escrito en
 * `20260829190000_v_product_box_factor_unit_aware.js`.
 *
 * Así que el rollback devuelve el GRANO (una fila por producto) y deja la columna en NULL, inerte.
 * Una columna de más no le rompe nada a nadie; un `CASCADE` sí.
 */
exports.down = async function down(knex) {
  await knex.raw(`DROP INDEX IF EXISTS commercial.ix_product_label_prices_suc`);
  await knex.raw(`DELETE FROM commercial.product_label_prices WHERE source <> 'manual'`);
  await knex.raw(`ALTER TABLE commercial.product_label_prices
                    DROP CONSTRAINT IF EXISTS product_label_prices_tenant_product_suc_key`);
  await knex.raw(`ALTER TABLE commercial.product_label_prices ALTER COLUMN sucursal DROP NOT NULL`);
  await knex.raw(`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'product_label_prices_tenant_id_product_id_key') THEN
        ALTER TABLE commercial.product_label_prices
          ADD CONSTRAINT product_label_prices_tenant_id_product_id_key UNIQUE (tenant_id, product_id);
      END IF;
    END $$`);
  // La vista vuelve a ser efectivamente pasa-manos (una fila por producto ⇒ el DISTINCT ON no
  // descarta nada), conservando su lista de columnas para no tener que dropearla.
  await knex.raw(`
    CREATE OR REPLACE VIEW commercial.v_product_label_prices AS
    SELECT DISTINCT ON (l.tenant_id, l.product_id) l.*
      FROM commercial.product_label_prices l
     ORDER BY l.tenant_id, l.product_id`);
  await knex.raw(`ALTER VIEW commercial.v_product_label_prices SET (security_invoker = true)`);
  await knex.raw(`GRANT SELECT ON commercial.v_product_label_prices TO app_runtime`);
  console.log(
    '[NORM.3] revertido el grano (la columna `sucursal` queda, inerte — ver el comentario). ' +
    'Volvé a correr import-label-data.js --apply para repoblar el consolidado.',
  );
};
