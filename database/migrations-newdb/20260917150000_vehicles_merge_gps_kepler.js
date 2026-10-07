/**
 * EMB.5 — Una unidad física, UNA fila: fusiona el vehículo del GPS con el de Kepler.
 *
 * ── EL PROBLEMA, medido en prod 2026-09-17 ───────────────────────────────────────────────
 * `logistics.vehicles` tenía **la misma camioneta dos veces**, porque las dos fuentes escriben
 * la placa distinto y el único índice es `(tenant_id, plate)` literal:
 *
 *     'GA-2027-C'  ← alta desde Kepler (con guiones) · kepler_code 00019 · SIN tracker
 *     'GA2027C'    ← alta desde MagniTracking (Fase LT, bootstrap por nombre del GPS)
 *                    · 1 tracker · 16,202 posiciones · 760 paradas
 *
 * Son 8 pares. El efecto: de las **25 unidades que embarcan, sólo 3 tenían GPS alcanzable**,
 * porque el rastreo colgaba de una fila y la clave de Kepler de la otra. Es exactamente la
 * misma familia de defecto que los ceros a la izquierda de EMB.0.1 — *la misma llave escrita
 * de dos maneras* — y por eso el arreglo de fondo va en el importer, no sólo acá.
 *
 * ── POR QUÉ LA FUSIÓN ES SEGURA (medido, no supuesto) ────────────────────────────────────
 * Se listaron las **10 tablas** que referencian `logistics.vehicles` (shipments, usage_logs,
 * maintenance, fuel, positions, entitlements, assignments, trackers, stops, day_summary) y se
 * contó fila por fila: **el lado de Kepler no tiene NADA colgando en ninguna de las 10** — es
 * un cascarón que creó el importer de dimensiones. Todo el histórico vive del lado del GPS.
 * Así que no hay que repuntar ninguna FK: alcanza con mover la clave y dar de baja el
 * cascarón.
 *
 * ⛔ Y aun así el UPDATE **no fusiona a ciegas**: vuelve a contar las 10 dependencias en
 * tiempo de migración y sólo toca el par cuando el cascarón sigue vacío. Si alguien le colgó
 * algo entre que medí y esto corre, el par se salta y queda para revisión humana — perder un
 * viaje o un costo por una fusión automática no se recupera.
 *
 * La baja es **soft-delete** (`deleted_at`), no `DELETE`: el índice único de `kepler_code` y
 * el de placa son parciales sobre `deleted_at IS NULL`, así que el cascarón sale de circulación
 * sin borrar historia y la operación es reversible.
 *
 * ⚠️ Orden obligatorio: primero se da de baja el cascarón y recién después se pone su
 * `kepler_code` en la fila del GPS. Al revés choca contra `ux_logistics_vehicles_kepler_code`,
 * que es único y **no** es deferrable.
 *
 * ⚠️ Lo que esta migración NO arregla y se declara: **14 de las 25 unidades que embarcan no
 * tienen GPS en absoluto** — entre ellas la que más embarca (`00008`, placa 774H6V, 1,086
 * embarques en 90 días) y `00001` (55AB1M, 565). No es un defecto de datos que se pueda
 * derivar: o no traen rastreador, o el suyo está dado de alta con otra placa. Es una pregunta
 * para operaciones, no para una migración.
 *
 * @param { import("knex").Knex } knex
 */

const M = '00000000-0000-0000-0000-00000000d01c';

// Las 10 tablas que referencian logistics.vehicles (verificadas contra pg_constraint).
const DEPENDIENTES = [
  'logistics.shipments', 'logistics.vehicle_usage_logs', 'logistics.vehicle_maintenance',
  'logistics.fuel_transactions', 'logistics.vehicle_positions', 'logistics.vehicle_entitlements',
  'logistics.vehicle_assignments', 'logistics.trackers', 'logistics.vehicle_stops',
  'logistics.vehicle_day_summary',
];

const placaNorm = (col) => `regexp_replace(upper(btrim(${col})),'[^A-Z0-9]','','g')`;

exports.up = async function up(knex) {
  // Pares: misma placa normalizada, uno con kepler_code y otro con tracker.
  const { rows: pares } = await knex.raw(`
    WITH v AS (
      SELECT id, plate, kepler_code, ${placaNorm('plate')} AS pn,
             (SELECT count(*) FROM logistics.trackers t WHERE t.vehicle_id = x.id AND t.deleted_at IS NULL) AS trackers
        FROM logistics.vehicles x
       WHERE x.tenant_id = ?::uuid AND x.deleted_at IS NULL AND btrim(coalesce(x.plate,'')) <> ''
    )
    SELECT k.id AS cascaron_id, k.plate AS cascaron_plate, k.kepler_code,
           g.id AS gps_id, g.plate AS gps_plate
      FROM v k
      JOIN v g ON g.pn = k.pn AND g.id <> k.id
     WHERE k.kepler_code IS NOT NULL AND k.trackers = 0
       AND g.kepler_code IS NULL AND g.trackers > 0`, [M]);

  let fusionados = 0, saltados = 0;
  for (const p of pares) {
    // Re-contar las 10 dependencias AHORA: la medición de ayer no autoriza el UPDATE de hoy.
    let colgando = 0;
    for (const t of DEPENDIENTES) {
      const { rows } = await knex.raw(`SELECT count(*)::int AS n FROM ${t} WHERE vehicle_id = ?`, [p.cascaron_id]);
      colgando += rows[0].n;
    }
    if (colgando > 0) { saltados++; continue; }

    // 1) baja del cascarón (libera los índices únicos parciales), 2) la clave pasa al GPS.
    await knex.raw(`
      UPDATE logistics.vehicles
         SET deleted_at = now(), active = false, updated_at = now(),
             notes = coalesce(notes || ' · ', '') ||
                     'EMB.5: fusionada con la fila del GPS (placa ' || ? || '); la clave Kepler ' || ? || ' se movió allá'
       WHERE tenant_id = ?::uuid AND id = ?`, [p.gps_plate, p.kepler_code, M, p.cascaron_id]);
    await knex.raw(`
      UPDATE logistics.vehicles
         SET kepler_code = ?, updated_at = now(),
             notes = coalesce(notes || ' · ', '') || 'EMB.5: es la unidad ' || ? || ' de Kepler (placa ahí: ' || ? || ')'
       WHERE tenant_id = ?::uuid AND id = ?`, [p.kepler_code, p.kepler_code, p.cascaron_plate, M, p.gps_id]);
    fusionados++;
  }
  // eslint-disable-next-line no-console
  console.log(`[EMB.5] pares fusionados: ${fusionados}${saltados ? ` · saltados por tener dependencias: ${saltados}` : ''}`);
};

exports.down = async function down(knex) {
  // Revierte: devuelve la clave al cascarón y lo reactiva. Se reconoce por la nota que dejó up().
  const { rows } = await knex.raw(`
    SELECT id, kepler_code, notes FROM logistics.vehicles
     WHERE tenant_id = ?::uuid AND deleted_at IS NOT NULL AND notes LIKE '%EMB.5: fusionada%'`, [M]);
  for (const c of rows) {
    const m = /la clave Kepler (\S+) se movió/.exec(c.notes || '');
    const clave = m ? m[1] : c.kepler_code;
    if (!clave) continue;
    await knex.raw(`UPDATE logistics.vehicles SET kepler_code = NULL, updated_at = now()
                     WHERE tenant_id = ?::uuid AND kepler_code = ? AND deleted_at IS NULL`, [M, clave]);
    await knex.raw(`UPDATE logistics.vehicles SET deleted_at = NULL, active = true, kepler_code = ?, updated_at = now()
                     WHERE tenant_id = ?::uuid AND id = ?`, [clave, M, c.id]);
  }
};
