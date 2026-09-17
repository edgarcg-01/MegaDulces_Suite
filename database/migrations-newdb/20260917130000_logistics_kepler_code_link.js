/**
 * EMB.1 — La LLAVE de cruce entre los catálogos de Kepler y los de la Suite.
 *
 * El problema, medido en prod el 2026-09-17: `import-logistics-dims.js` baja rutas, unidades
 * y choferes de Kepler a `logistics.*`, pero **dedupea por nombre/placa y tira la clave**: el
 * `R0001` / `00017` queda como texto libre dentro de `notes` ("Kepler ruta R0001"). Sin una
 * columna de cruce, resolver un embarque de Kepler a su unidad en la Suite obliga a parsear
 * una cadena — y un `notes` editado a mano rompe el vínculo en silencio.
 *
 * Con esto, `analytics.erp_shipment_headers.transporte_clave_kepler` (EMB.0) une directo
 * contra `logistics.vehicles.kepler_code`, que es lo que habilita colgar del embarque lo que
 * la Suite ya sabe de esa unidad: rastreo GPS, checklists, costos y mantenimiento.
 *
 * ── POR QUÉ LA CLAVE PUEDE SER GLOBAL AL TENANT — y dónde NO ────────────────────────────
 * Los tres catálogos están replicados en las 8 ramas y podrían contradecirse entre sucursales.
 * **Unidades y choferes no lo hacen**: de las 26 claves de unidad y 23 de chofer que aparecen,
 * 0 significan cosas distintas según la rama, y ninguna placa pertenece a dos claves. Por eso
 * el índice único es (tenant_id, kepler_code) sin sucursal.
 *
 * ⛔ **Las RUTAS sí se contradicen, y esa suposición ya se probó FALSA acá.** La primera
 * corrida contra prod reventó el índice único, que es exactamente para lo que está: 3 de las
 * 88 claves de ruta nombran cosas distintas según la sucursal —
 *   `R0001` = HUANIMARO en 7 ramas pero **ZIROSTO** en la 06
 *   `R7`    = MORELIA en la 00 pero **IRAPUATO** en 03/04/05
 *   `R0037` = "CANINDO ZAMORA" / "ZAMORA CANINDO" (mismo lugar, orden distinto)
 * → la clave de ruta **no** identifica a la ruta a nivel tenant. Se vincula sólo la biyección
 * comprobada (nombre ↔ clave, uno a uno globalmente) y las claves ambiguas quedan **NULL con
 * su motivo**, no forzadas a una rama elegida a dedo. Cuesta poco: el embarque U-D-41 no
 * referencia ninguna ruta (medido en EMB.0), así que este vínculo no lo necesita hoy.
 *
 * ── EL BACKFILL CRUZA POR EL ATRIBUTO FÍSICO, NO POR EL TEXTO DE `notes` ─────────────────
 * unidades por PLACA · choferes y rutas por NOMBRE. Medido antes de escribirlo: las 25 placas
 * de Kepler están las 25 en la Suite, 66 de los 70 nombres de ruta también, y no hay placas ni
 * nombres duplicados de ninguno de los dos lados. Las 4 rutas que faltan NO se crean acá —
 * eso es trabajo del importer, que además es el que tiene que quedar agendado.
 *
 * La clave que se guarda es la CANÓNICA de Kepler (`00017`, la que se ve en su pantalla), que
 * es exactamente lo que publica `analytics.v_kepler_transporte.clave_kepler`. No se guarda la
 * normalizada: sirve para cruzar pero no la reconoce nadie al leerla.
 *
 * Aditiva, idempotente, reversible.
 *
 * @param { import("knex").Knex } knex
 */

const M = '00000000-0000-0000-0000-00000000d01c';

// tabla → [columna del catálogo de la Suite, vista resolvedora, columna de la vista a cruzar]
const LINKS = [
  ['vehicles', 'plate',     'analytics.v_kepler_transporte', 'placas'],
  ['drivers',  'full_name', 'analytics.v_kepler_chofer',     'nombre'],
];

exports.up = async function up(knex) {
  for (const t of ['routes', 'vehicles', 'drivers']) {
    if (!(await knex.schema.withSchema('logistics').hasColumn(t, 'kepler_code'))) {
      await knex.schema.withSchema('logistics').alterTable(t, (tb) => tb.string('kepler_code', 20));
      await knex.raw(`COMMENT ON COLUMN logistics.${t}.kepler_code IS
        'EMB.1 — clave del catálogo de Kepler en su forma canónica (00017 / R0001). Es la llave de cruce con analytics.erp_shipment_headers y los resolvedores analytics.v_kepler_*. NULL = entidad propia de la Suite, sin equivalente en el ERP.'`);
    }
    // Parcial: convive con las filas propias de la Suite (kepler_code NULL) y con las bajas.
    await knex.raw(`
      CREATE UNIQUE INDEX IF NOT EXISTS ux_logistics_${t}_kepler_code
        ON logistics.${t} (tenant_id, kepler_code)
        WHERE kepler_code IS NOT NULL AND deleted_at IS NULL`);
  }

  // ── Backfill por atributo físico ────────────────────────────────────────────────────────
  for (const [tabla, col, vista, vcol] of LINKS) {
    await knex.raw(`
      UPDATE logistics.${tabla} d
         SET kepler_code = k.clave_kepler, updated_at = now()
        FROM (SELECT DISTINCT ON (upper(btrim(${vcol}))) upper(btrim(${vcol})) AS llave, clave_kepler
                FROM ${vista} WHERE ${vcol} IS NOT NULL
               ORDER BY upper(btrim(${vcol})), clave_kepler) k
       WHERE d.tenant_id = ?::uuid AND d.deleted_at IS NULL AND d.kepler_code IS NULL
         AND upper(btrim(d.${col})) = k.llave`, [M]);
  }

  // Rutas: sólo la BIYECCIÓN. Se exige que el nombre apunte a una única clave Y que esa clave
  // nombre una única cosa en las 8 ramas. Lo que no cumple las dos condiciones queda sin
  // vincular — ver el bloque ⛔ de la cabecera.
  await knex.raw(`
    WITH pares AS (
      SELECT DISTINCT upper(btrim(c2)) AS nombre, btrim(c1) AS clave
        FROM kepler_ods.kdm_rutas
       WHERE btrim(coalesce(c2,'')) <> '' AND btrim(coalesce(c1,'')) <> ''
    ), biyectivos AS (
      SELECT p.nombre, p.clave FROM pares p
       WHERE (SELECT count(*) FROM pares x WHERE x.nombre = p.nombre) = 1
         AND (SELECT count(*) FROM pares y WHERE y.clave  = p.clave ) = 1
    )
    UPDATE logistics.routes d
       SET kepler_code = b.clave, updated_at = now()
      FROM biyectivos b
     WHERE d.tenant_id = ?::uuid AND d.deleted_at IS NULL AND d.kepler_code IS NULL
       AND upper(btrim(d.name)) = b.nombre`, [M]);
};

exports.down = async function down(knex) {
  for (const t of ['routes', 'vehicles', 'drivers']) {
    await knex.raw(`DROP INDEX IF EXISTS logistics.ux_logistics_${t}_kepler_code`);
    if (await knex.schema.withSchema('logistics').hasColumn(t, 'kepler_code')) {
      await knex.schema.withSchema('logistics').alterTable(t, (tb) => tb.dropColumn('kepler_code'));
    }
  }
};
