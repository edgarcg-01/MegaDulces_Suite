/**
 * EMB.6 — Del embarque a la UNIDAD de la Suite (y de ahí a su GPS), en un solo salto.
 *
 * Pedido: *«hay que ligar los vehículos de MagniTracking con las unidades, hay que saber qué
 * embarques tiene asignada cada unidad»*. Con EMB.1 (la clave) y EMB.5 (la fusión) la cadena
 * ya existe; lo que falta es que no haya que rearmarla a mano en cada consumidor:
 *
 *     analytics.erp_shipment_headers.transporte_clave_kepler
 *        → logistics.vehicles.kepler_code   (EMB.1)
 *        → logistics.trackers.vehicle_id    (Fase LT: posición, velocidad, último visto)
 *
 * Se agregan `vehicle_id` y `vehicle_plate` a la parada y al viaje. Con eso:
 *   · «qué embarques trae hoy la unidad X» → filtrar `erp_shipment_headers` por `vehicle_id`;
 *   · «dónde está la unidad de este embarque» → join a `logistics.trackers`;
 *   · «qué viajes hizo esta unidad» → `erp_shipment_trips` por `vehicle_id`.
 *
 * El join va por `kepler_code`, NO por placa: la placa es justo lo que estaba escrito de dos
 * maneras (`GA-2027-C` contra `GA2027C`) y provocó las 8 filas duplicadas que EMB.5 fusionó.
 * `vehicle_plate` sale de la fila de la Suite (la del GPS tras la fusión), mientras que
 * `transporte_placas` sigue siendo la que dice Kepler — se conservan las dos a propósito:
 * cuando difieren, la diferencia es el dato.
 *
 * ⚠️ `vehicle_id` llega **NULL** cuando la unidad de Kepler no tiene fila viva en la Suite, y
 * eso NO es un error a tapar: medido 2026-09-17, **14 de las 25 unidades que embarcan no
 * tienen GPS** — la que más embarca entre ellas (`00008`, placa 774H6V, 1,086 embarques en 90
 * días). Un consumidor que pinte "sin ubicación" tiene que poder distinguir *no tiene
 * rastreador* de *no se pudo resolver*; por eso el NULL viaja crudo y no como cero.
 *
 * @param { import("knex").Knex } knex
 */

const M = '00000000-0000-0000-0000-00000000d01c';

exports.up = async function up(knex) {
  // ⚠️ Guarda de idempotencia: esta migración ENVUELVE la definición vigente. Sin este freno,
  // una segunda corrida envolvería lo ya envuelto y el join a la flota quedaría duplicado.
  //
  // ⛔ Y exige las DOS vistas, no sólo la primera. Mirando sólo `headers` la guarda mentía: una
  // corrida que murió creando `trips` (Postgres no tiene `min(uuid)`) dejaba headers ya
  // envuelta y trips SIN EXISTIR, y el reintento se daba por hecho y salía — la base quedaba a
  // medias y en verde. Pasó en dev. Una guarda de idempotencia tiene que describir el estado
  // FINAL completo, no el primer paso.
  const { rows: ya } = await knex.raw(`
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='analytics' AND table_name='erp_shipment_headers' AND column_name='vehicle_id'`);
  const { rows: trips } = await knex.raw(`SELECT to_regclass('analytics.erp_shipment_trips') AS t`);
  if (ya.length && trips[0].t) return;

  // Se parte SIEMPRE de la forma base, reconstruyéndola con la migración anterior. Leer la
  // definición "que haya" era frágil: si la base quedó a medio migrar, se envolvería lo ya
  // envuelto y el join a la flota saldría duplicado. Así el resultado no depende del estado
  // previo.
  await require('./20260917140000_erp_shipment_headers_match_exacto.js').up(knex);

  const { rows: [def] } = await knex.raw(
    `SELECT pg_get_viewdef('analytics.erp_shipment_headers'::regclass, true) AS v`);
  if (!def || !def.v) throw new Error('falta analytics.erp_shipment_headers (mig 20260917140000 sin aplicar)');

  await knex.raw('DROP VIEW IF EXISTS analytics.erp_shipment_trips');
  await knex.raw('DROP VIEW IF EXISTS analytics.erp_shipment_headers');

  // Se reconstruye headers a partir de la definición vigente, envolviéndola: así esta
  // migración NO duplica los ~120 renglones del decode (que seguirían su propio camino y se
  // desincronizarían), sólo le cuelga el vínculo con la flota.
  await knex.raw(`
    CREATE VIEW analytics.erp_shipment_headers AS
    SELECT b.*, v.id AS vehicle_id, v.plate AS vehicle_plate
      FROM (${def.v.replace(/;\s*$/, '')}) b
      LEFT JOIN logistics.vehicles v
        ON v.tenant_id = '${M}'::uuid AND v.deleted_at IS NULL
       AND v.kepler_code = b.transporte_clave_kepler`);
  await knex.raw(`GRANT SELECT ON analytics.erp_shipment_headers TO app_runtime`);

  await knex.raw(`
    CREATE VIEW analytics.erp_shipment_trips AS
    SELECT
      '${M}'::uuid                                   AS tenant_id,
      h.sucursal,
      h.guia_embarque,
      h.sucursal||'-G'||h.guia_embarque              AS guia_digital,
      min(h.fecha)                                   AS fecha,
      count(*)::int                                  AS paradas,
      count(DISTINCT h.cliente_code)::int            AS destinos,
      count(DISTINCT h.serie)::int                   AS series,
      min(h.transporte_code)                         AS transporte_code,
      min(h.transporte_descripcion)                  AS transporte_descripcion,
      min(h.transporte_placas)                       AS transporte_placas,
      min(h.chofer_code)                             AS chofer_code,
      min(h.chofer_nombre)                           AS chofer_nombre,
      (count(DISTINCT h.transporte_code) > 1)        AS multi_transporte,
      (count(DISTINCT h.chofer_code)     > 1)        AS multi_chofer,
      (count(DISTINCT h.fecha)           > 1)        AS multi_fecha,
      sum(h.total)                                   AS total,
      min(h.fecha)                                   AS fecha_min,
      max(h.fecha)                                   AS fecha_max,
      -- Una sola unidad por viaje está medido (386/388 de las guías multiparada) y la columna
      -- multi_transporte denuncia la excepción. ⚠️ Postgres no tiene min(uuid): va por texto.
      min(h.vehicle_id::text)::uuid                  AS vehicle_id,
      min(h.vehicle_plate)                           AS vehicle_plate,
      now()                                          AS computed_at
    FROM analytics.erp_shipment_headers h
    WHERE h.guia_embarque IS NOT NULL
    GROUP BY h.sucursal, h.guia_embarque`);
  await knex.raw(`GRANT SELECT ON analytics.erp_shipment_trips TO app_runtime`);

  await knex.raw(`COMMENT ON VIEW analytics.erp_shipment_headers IS
    'EMB.0 — Cabecera logística del embarque Kepler U-D-41 EN VIVO (derive-no-copy sobre kepler_ods.kdm1): transporte (c83), chofer (c84), guía (c86), responsables (c80/c81/c82), destino, vendedor y pedido padre. EMB.0.1: unidad y chofer se resuelven por código EXACTO y sólo si no existe se cae al normalizado (ver transporte_metodo/chofer_metodo). EMB.6: vehicle_id/vehicle_plate atan el embarque a logistics.vehicles por kepler_code — y de ahí a su GPS en logistics.trackers; NULL = esa unidad no tiene fila viva en la Suite (14 de 25 no tienen rastreador). Grano = la PARADA; el viaje es erp_shipment_trips. NO es cartera: la deuda la manda kdue.'`);
  await knex.raw(`COMMENT ON VIEW analytics.erp_shipment_trips IS
    'EMB.0 — El VIAJE: agrupa las paradas por guía de embarque (kdm1.c86); ~2,500 guías para ~5,700 embarques, hasta 32 paradas en una. EMB.6: trae vehicle_id para cruzar con la flota y el GPS. Éste es el grano que corresponde a logistics.shipments, no el documento suelto.'`);
};

exports.down = async function down(knex) {
  await knex.raw('DROP VIEW IF EXISTS analytics.erp_shipment_trips');
  await knex.raw('DROP VIEW IF EXISTS analytics.erp_shipment_headers');
  await require('./20260917140000_erp_shipment_headers_match_exacto.js').up(knex);
};
