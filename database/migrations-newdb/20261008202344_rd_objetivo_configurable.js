'use strict';
/**
 * `[RD.59]` — **El bono por objetivo mensual, configurable: criterios, pesos y umbrales en tabla.**
 *
 * Edgar confirmó el 2026-10-08 que el bono **sigue vigente** y que tiene que ser configurable.
 * La hoja `OBJETIVO MENSUAL RD` del libro quedó parada en 2021 (periodos del `01-ENE-2021` al
 * `25-MAR-2021`, calendario de 28 días, **todas las celdas en `NO CUMPLIDO`**) y sus tres
 * criterios se marcan a mano con la fórmula literal `IF(celda="CUMPLIDO", 50%, 0%)`:
 * visitas **50%**, desarrollo de marcas **25%**, volumen **25%**.
 *
 * ── ⭐ No se crea una máquina de bonos: ya existe y está en uso ───────────────────────────
 * `commercial.commission_bonuses` tiene **14 filas vivas**, editadas el 2026-10-07, con
 * `metrica` + `umbral` + `comparador` + `monto` + `route_code` + `gate_venta_min`, versionadas
 * por `scale_id` (`RD-2026`, `valid_from` 2026-01-01). Ahí viven *Lavadas* ($200 sobre
 * $215,999.99), *Lonche* ($800) , *Chalán* ($1,000) y el *Alcance de margen* del supervisor, este
 * último **con umbral distinto por ruta** (25.0 / 16.499 / 15.299 / 14.499). O sea: el negocio ya
 * configura bonos desde datos, no desde código. Crear una tabla paralela sería la copia que
 * `GOTCHAS §32` prohíbe.
 *
 * ── Lo que le FALTABA para expresar el objetivo, medido ──────────────────────────────────
 *   1. `CHECK metrica IN ('venta','markup_pct')` — no admite ni las visitas ni un criterio que
 *      sólo una persona puede juzgar.
 *   2. **No tiene periodo.** Todo bono es quincenal; el objetivo es mensual.
 *   3. **No tiene grupo ni peso.** Cada bono es todo-o-nada e independiente; el objetivo paga
 *      una FRACCIÓN según qué criterios se cumplieron.
 *   4. **No tiene `activo`.** Por eso el objetivo *quedó parado* en vez de apagarse: no había
 *      forma de decir "esto existe y hoy no se paga" salvo borrarlo.
 *
 * ── ⛔⛔ La guarda que va PRIMERO, porque sin ella esto paga de más ────────────────────────
 * `computeRun` lee **todos** los bonos de la escala sin filtrar nada
 * (`.where({ scale_id }).whereNull('deleted_at')`). Una fila mensual nueva entraría al cálculo
 * **quincenal** y se pagaría dos veces por mes, en silencio. Por eso `periodo` nace
 * `NOT NULL DEFAULT 'quincena'` —las 14 filas existentes no cambian de comportamiento— y el
 * motor pasa a filtrar `periodo = 'quincena'` **en el commit que acompaña a esta migración**.
 * La migración va antes que el código, que es el orden que exige el protocolo para una aditiva
 * que el código nuevo lee.
 *
 * ── Las tres métricas nuevas, y por qué una de ellas es `manual` ─────────────────────────
 *   `visitas`  ✅ medible: `tickets` por ruta (la 26 hizo 444 en la quincena 20, la 23 338).
 *              ⚠️ Son visitas **con venta**: la que no vendió no deja ticket. Se declara.
 *   `volumen`  ✅ medible: es la venta, que el motor ya calcula.
 *   `manual`   ⛔ **desarrollo de marcas NO es derivable**: `analytics.v_sellout_daily` con el
 *              `vendor_code` de las rutas de RD devuelve **0 filas**. En vez de inventar una
 *              fórmula, el criterio se declara `manual` y su marca se guarda **con fecha y con
 *              responsable** en `commercial.objective_marks`. Hoy el Excel marca los TRES a
 *              mano y sin rastro; acá dos se miden y el tercero deja huella.
 *
 * ── Nace APAGADO, y con los pesos del libro, no inventados ───────────────────────────────
 * Se siembran los tres criterios con `activo = false`, `monto = 0` y `umbral = 0`. Los pesos
 * 50/25/25 **salen de la fórmula del workbook**, no del pulgar. El monto y los umbrales **no se
 * inventan**: los fija el negocio desde la pantalla. Mismo criterio que `[CDRP.2]` (la tabla de
 * umbrales nace vacía con candado) y `[MS.7.14]` (la cola nace apagada y se activa desde la UI).
 * Tres guardas para que esto no pague solo: `activo=false`, `monto=0` y el filtro de periodo.
 *
 * @param { import("knex").Knex } knex
 */

const T = 'commercial.commission_bonuses';
const MARKS = 'commercial.objective_marks';
const GRUPO = 'objetivo_mensual';

exports.up = async function up(knex) {
  // ── 1. Las cuatro columnas que faltaban ────────────────────────────────────────────────
  const has = async (col) => knex.schema.withSchema('commercial').hasColumn('commission_bonuses', col);

  if (!(await has('periodo'))) {
    await knex.raw(`ALTER TABLE ${T} ADD COLUMN periodo varchar(16) NOT NULL DEFAULT 'quincena'`);
    await knex.raw(
      `ALTER TABLE ${T} ADD CONSTRAINT commission_bonuses_periodo_valid
         CHECK (periodo IN ('quincena','mes'))`,
    );
  }
  if (!(await has('grupo'))) {
    await knex.raw(`ALTER TABLE ${T} ADD COLUMN grupo varchar(48)`);
  }
  if (!(await has('peso_pct'))) {
    await knex.raw(`ALTER TABLE ${T} ADD COLUMN peso_pct numeric(7,4)`);
    // El peso sólo tiene sentido dentro de un grupo, y al revés: un grupo sin pesos no sabe
    // repartir. Que la base lo exija evita una configuración a medias que sólo se nota al pagar.
    await knex.raw(
      `ALTER TABLE ${T} ADD CONSTRAINT commission_bonuses_peso_con_grupo
         CHECK ((grupo IS NULL AND peso_pct IS NULL) OR (grupo IS NOT NULL AND peso_pct IS NOT NULL))`,
    );
    await knex.raw(
      `ALTER TABLE ${T} ADD CONSTRAINT commission_bonuses_peso_rango
         CHECK (peso_pct IS NULL OR (peso_pct > 0 AND peso_pct <= 100))`,
    );
  }
  if (!(await has('activo'))) {
    await knex.raw(`ALTER TABLE ${T} ADD COLUMN activo boolean NOT NULL DEFAULT true`);
  }

  // ── 2. Las métricas nuevas ─────────────────────────────────────────────────────────────
  await knex.raw(`ALTER TABLE ${T} DROP CONSTRAINT IF EXISTS commission_bonuses_metrica_valid`);
  await knex.raw(
    `ALTER TABLE ${T} ADD CONSTRAINT commission_bonuses_metrica_valid
       CHECK (metrica IN ('venta','markup_pct','visitas','volumen','manual'))`,
  );

  await knex.raw(`COMMENT ON COLUMN ${T}.periodo IS 'RD.59 - quincena (lo que paga computeRun) o mes (el objetivo). El motor quincenal FILTRA por esta columna: sin eso un bono mensual se pagaria dos veces por mes.'`);
  await knex.raw(`COMMENT ON COLUMN ${T}.grupo IS 'RD.59 - los bonos del mismo grupo forman UN bono compuesto que paga una fraccion segun los criterios cumplidos. NULL = bono independiente, todo o nada.'`);
  await knex.raw(`COMMENT ON COLUMN ${T}.peso_pct IS 'RD.59 - peso del criterio dentro de su grupo. Los del objetivo mensual salen de la formula del workbook: visitas 50, desarrollo de marcas 25, volumen 25.'`);
  await knex.raw(`COMMENT ON COLUMN ${T}.activo IS 'RD.59 - apagar un bono sin borrar su configuracion. El objetivo mensual estuvo parado cinco anios y no habia forma de decirlo salvo borrandolo.'`);
  await knex.raw(`COMMENT ON COLUMN ${T}.metrica IS 'RD.59 - venta | markup_pct | visitas (tickets por ruta, OJO: visitas CON venta) | volumen | manual (nadie puede derivarlo: la marca vive en commercial.objective_marks con fecha y responsable).'`);

  // ── 3. La marca humana, con fecha y con responsable ────────────────────────────────────
  const existe = await knex.schema.withSchema('commercial').hasTable('objective_marks');
  if (!existe) {
    await knex.schema.withSchema('commercial').createTable('objective_marks', (t) => {
      t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
      t.uuid('tenant_id').notNullable();
      t.uuid('bonus_id').notNullable();
      t.string('route_code', 24).notNullable();
      t.integer('anio').notNullable();
      // Con `periodo='mes'` es 1..12. Se guarda el numero y no una fecha para que la llave
      // natural sea estable aunque el calendario cambie de grano.
      t.integer('periodo_no').notNullable();
      t.boolean('cumplido').notNullable();
      // ⛔ El motivo es obligatorio: una marca que decide dinero y no dice por que es la casilla
      // que cualquiera puede mover despues, que es justo lo que el Excel permitia.
      t.text('motivo').notNullable();
      t.uuid('marked_by');
      t.string('marked_by_nombre', 160);
      t.timestamp('marked_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
      t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
      t.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
      t.uuid('created_by');
      t.uuid('updated_by');
      t.timestamp('deleted_at', { useTz: true });
      t.uuid('deleted_by');

      t.foreign('tenant_id').references('id').inTable('tenants').onDelete('RESTRICT');
      t.foreign('bonus_id').references('id').inTable('commercial.commission_bonuses').onDelete('CASCADE');
      t.unique(['tenant_id', 'bonus_id', 'route_code', 'anio', 'periodo_no'],
        { indexName: 'objective_marks_natural_unique' });
      t.check('periodo_no >= 1', [], 'objective_marks_periodo_positivo');
      t.check("btrim(motivo) <> ''", [], 'objective_marks_motivo_no_vacio');
      t.index(['tenant_id', 'anio', 'periodo_no'], 'idx_objective_marks_periodo');
    });

    await knex.raw(`ALTER TABLE ${MARKS} ENABLE ROW LEVEL SECURITY`);
    await knex.raw(`ALTER TABLE ${MARKS} FORCE ROW LEVEL SECURITY`);
    await knex.raw(
      `CREATE POLICY objective_marks_tenant_isolation ON ${MARKS}
         USING (tenant_id = current_tenant_id())
         WITH CHECK (tenant_id = current_tenant_id())`,
    );
    await knex.raw(`GRANT SELECT, INSERT, UPDATE ON ${MARKS} TO app_runtime`);
    await knex.raw(`COMMENT ON TABLE ${MARKS} IS 'RD.59 - la marca humana de un criterio que NADIE puede derivar (hoy: desarrollo de marcas, porque v_sellout_daily con el vendor_code de RD devuelve 0 filas). Lleva fecha, responsable y motivo obligatorio: en el Excel la misma casilla no dejaba rastro.'`);
  }

  // ── 4. Los tres criterios del libro, APAGADOS ──────────────────────────────────────────
  // ⛔ Pesos del workbook (IF(celda="CUMPLIDO", 50%, 0%)), NO inventados. Monto y umbral en 0
  // porque nadie los ha fijado: los pone el negocio desde la pantalla. Nace `activo=false`.
  const { rows: escalas } = await knex.raw(
    `SELECT id, tenant_id FROM commercial.commission_scales
      WHERE code = 'RD-2026' AND deleted_at IS NULL LIMIT 1`,
  );
  if (escalas.length) {
    const { id: scaleId, tenant_id: tenantId } = escalas[0];
    const criterios = [
      ['Visitas', 'visitas', 50],
      ['Desarrollo de marcas', 'manual', 25],
      ['Volumen', 'volumen', 25],
    ];
    for (const [nombre, metrica, peso] of criterios) {
      await knex.raw(
        `INSERT INTO ${T}
           (id, tenant_id, scale_id, beneficiario, nombre, metrica, comparador, umbral, monto,
            route_code, periodo, grupo, peso_pct, activo, created_at, updated_at)
         VALUES (gen_random_uuid(), ?, ?, 'chofer', ?, ?, 'gte', 0, 0,
                 NULL, 'mes', ?, ?, false, now(), now())
         ON CONFLICT ON CONSTRAINT commission_bonuses_natural_unique DO NOTHING`,
        [tenantId, scaleId, nombre, metrica, GRUPO, peso],
      );
    }
    const { rows: [n] } = await knex.raw(
      `SELECT count(*)::int n, coalesce(sum(peso_pct),0)::numeric suma
         FROM ${T} WHERE grupo = ? AND deleted_at IS NULL`, [GRUPO],
    );
    // eslint-disable-next-line no-console
    console.log(`  [RD.59] criterios del objetivo: ${n.n} · pesos suman ${n.suma}% · apagados`);
  } else {
    // eslint-disable-next-line no-console
    console.log('  [RD.59] no existe la escala RD-2026: no se sembró ningún criterio');
  }
};

exports.down = async function down(knex) {
  await knex.raw(`DELETE FROM ${T} WHERE grupo = ?`, [GRUPO]);
  await knex.raw(`DROP TABLE IF EXISTS ${MARKS}`);
  await knex.raw(`ALTER TABLE ${T} DROP CONSTRAINT IF EXISTS commission_bonuses_peso_rango`);
  await knex.raw(`ALTER TABLE ${T} DROP CONSTRAINT IF EXISTS commission_bonuses_peso_con_grupo`);
  await knex.raw(`ALTER TABLE ${T} DROP CONSTRAINT IF EXISTS commission_bonuses_periodo_valid`);
  await knex.raw(`ALTER TABLE ${T} DROP COLUMN IF EXISTS activo`);
  await knex.raw(`ALTER TABLE ${T} DROP COLUMN IF EXISTS peso_pct`);
  await knex.raw(`ALTER TABLE ${T} DROP COLUMN IF EXISTS grupo`);
  await knex.raw(`ALTER TABLE ${T} DROP COLUMN IF EXISTS periodo`);
  await knex.raw(`ALTER TABLE ${T} DROP CONSTRAINT IF EXISTS commission_bonuses_metrica_valid`);
  await knex.raw(
    `ALTER TABLE ${T} ADD CONSTRAINT commission_bonuses_metrica_valid
       CHECK (metrica IN ('venta','markup_pct'))`,
  );
};
