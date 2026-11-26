'use strict';
/**
 * `[UB.NV.1]` — el nivel de una ubicación pasa de **1–6 a 1–9**, a pedido de Edgar (2026-11-26).
 *
 * ── Lo medido antes, en prod, sólo lectura (2026-11-26) ─────────────────────────────────────
 *  · `commercial.warehouse_bins`: 345 ubicaciones. Niveles en uso: 2 (70), 3 (71), 4 (70),
 *    5 (70), 6 (11).
 *  · **11 racks ya estaban topados en el nivel 6** y no había forma de dar de alta el entrepaño
 *    siguiente: el CHECK lo rechazaba.
 *  · Los dos CHECK que lo fijaban: `ck_wh_bins_nivel` (`nivel <= 6`) y `ck_wh_bins_formato`
 *    (la expresión del código, con `[1-6]` en el último carácter).
 *
 * ⛔ **Nueve es el techo, y no es un número redondo elegido al azar.** El código son 5
 *    caracteres y el nivel ocupa el último (`BA053`), así que un nivel de dos dígitos daría
 *    `BA0510`: otro formato de etiqueta, otro ancho de CODE128 y un escáner que ya no reconoce
 *    lo que lee. Y `defaultPickSequence` le reserva **un solo dígito** al nivel, de modo que un
 *    10 se le metería al rack vecino y el recorrido de surtido saldría mal. Pasar de 9 no es
 *    tocar un CHECK: es cambiar el código y, con él, cada etiqueta ya pegada en la tienda.
 *
 * ⭐ **Afloja, no aprieta**: toda fila que pasaba el CHECK viejo pasa el nuevo, así que no puede
 *    dejar datos fuera de regla ni necesita respaldo. Pero **va ANTES que el código**: la API
 *    nueva acepta el nivel 7 y la base lo rechazaría hasta que esto corra.
 *
 * Idempotente: los `DROP … IF EXISTS` y el `ADD` con el mismo nombre dejan el mismo estado final.
 *
 * @param { import("knex").Knex } knex
 */

const NIVEL_MAX = 9;
const CODE_RE = '^([TB])([A-Z])(0[1-9]|[1-9][0-9])([1-9])$';

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);

  // El control de arranque: ninguna fila puede estar fuera del CHECK NUEVO antes de ponerlo.
  // Si alguna lo estuviera, el ADD CONSTRAINT fallaría a medias y conviene saber por qué.
  const { rows: antes } = await knex.raw(
    `SELECT count(*)::int AS total,
            count(*) FILTER (WHERE nivel > ${NIVEL_MAX})::int AS fuera_de_regla,
            max(nivel)::int AS nivel_mas_alto
       FROM commercial.warehouse_bins`,
  );
  if (antes[0].fuera_de_regla > 0) {
    throw new Error(
      `[UB.NV.1] ${antes[0].fuera_de_regla} ubicaciones tienen un nivel mayor a ${NIVEL_MAX}: ` +
        'no se puede poner el CHECK. Revisá esas filas antes de correr esto.',
    );
  }
  console.log(
    `[UB.NV.1] antes: ${antes[0].total} ubicaciones, el nivel más alto es ${antes[0].nivel_mas_alto}.`,
  );

  await knex.raw(`
    ALTER TABLE commercial.warehouse_bins DROP CONSTRAINT IF EXISTS ck_wh_bins_nivel;
    ALTER TABLE commercial.warehouse_bins
      ADD CONSTRAINT ck_wh_bins_nivel CHECK (nivel IS NULL OR (nivel >= 1 AND nivel <= ${NIVEL_MAX}));
  `);

  await knex.raw(`
    ALTER TABLE commercial.warehouse_bins DROP CONSTRAINT IF EXISTS ck_wh_bins_formato;
    ALTER TABLE commercial.warehouse_bins
      ADD CONSTRAINT ck_wh_bins_formato CHECK (
        familia <> 'ubicacion' OR (
          zona IS NOT NULL AND pasillo IS NOT NULL AND rack IS NOT NULL AND nivel IS NOT NULL
          AND code = zona || pasillo || lpad(rack::text, 2, '0') || nivel::text
          AND code ~ '${CODE_RE}'
        )
      );
  `);

  // ⭐ El testigo: se pregunta a la base cómo quedó, no se supone. Un CHECK que quedó con el
  // texto viejo pasaría desapercibido y volvería a rechazar el nivel 7 en la pantalla.
  const { rows: despues } = await knex.raw(
    `SELECT conname, pg_get_constraintdef(oid) AS def
       FROM pg_constraint
      WHERE conrelid = 'commercial.warehouse_bins'::regclass
        AND conname IN ('ck_wh_bins_nivel', 'ck_wh_bins_formato')
      ORDER BY conname`,
  );
  if (despues.length !== 2) {
    throw new Error(`[UB.NV.1] quedaron ${despues.length} de 2 CHECK: ${JSON.stringify(despues)}`);
  }
  for (const c of despues) {
    const ok = c.conname === 'ck_wh_bins_nivel' ? c.def.includes(`<= ${NIVEL_MAX}`) : c.def.includes('[1-9])$');
    if (!ok) throw new Error(`[UB.NV.1] ${c.conname} quedó con el texto viejo: ${c.def}`);
    console.log(`[UB.NV.1] ${c.conname} OK`);
  }
};

/** Deshace EXACTAMENTE lo que hizo el `up`: vuelve a dejar el tope en 6. */
exports.down = async function down(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);

  // ⛔ Volver a 6 con ubicaciones de nivel 7–9 dadas de alta dejaría el CHECK sin poder ponerse.
  const { rows } = await knex.raw(
    `SELECT count(*)::int AS altas FROM commercial.warehouse_bins WHERE nivel > 6`,
  );
  if (rows[0].altas > 0) {
    throw new Error(
      `[UB.NV.1] hay ${rows[0].altas} ubicaciones de nivel 7 a 9: dalas de baja antes de volver al tope de 6.`,
    );
  }

  await knex.raw(`
    ALTER TABLE commercial.warehouse_bins DROP CONSTRAINT IF EXISTS ck_wh_bins_nivel;
    ALTER TABLE commercial.warehouse_bins
      ADD CONSTRAINT ck_wh_bins_nivel CHECK (nivel IS NULL OR (nivel >= 1 AND nivel <= 6));
    ALTER TABLE commercial.warehouse_bins DROP CONSTRAINT IF EXISTS ck_wh_bins_formato;
    ALTER TABLE commercial.warehouse_bins
      ADD CONSTRAINT ck_wh_bins_formato CHECK (
        familia <> 'ubicacion' OR (
          zona IS NOT NULL AND pasillo IS NOT NULL AND rack IS NOT NULL AND nivel IS NOT NULL
          AND code = zona || pasillo || lpad(rack::text, 2, '0') || nivel::text
          AND code ~ '^([TB])([A-Z])(0[1-9]|[1-9][0-9])([1-6])$'
        )
      );
  `);
};
