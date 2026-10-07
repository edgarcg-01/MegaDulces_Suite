'use strict';
/**
 * `[AUD-DAT.2]` — **El hecho de venta acepta cualquier fecha, y ya fabricó períodos fantasma.**
 *
 * ── Qué se midió (prod, 2026-09-28) ─────────────────────────────────────────
 * `analytics.sales_daily` tiene un solo `CHECK`, y es sobre `unit_kind`. Nada
 * mira la fecha. Resultado, por año:
 *
 *     2000    196 filas   $238,071      2024     23 filas   $14,795
 *     2014     24 filas     $5,736      2025  1,542,881     real
 *     2020      6 filas    $19,466      2026  1,538,539     real
 *
 * Más 4 filas fechadas **2026-12-06**, tres meses en el futuro. El dinero es
 * chico ($278,068 de $679M = 0.04%), pero el daño no es el dinero: esas 4 filas
 * ya fabricaron un bucket **«diciembre 2026»** en `sales_boxes_monthly` y en
 * `sales_by_vendor_monthly`, así que cualquier gráfica de «últimos 12 meses»
 * pinta una barra de diciembre. Un renglón mal capturado se propaga a todos los
 * rollups de aguas abajo y nadie lo frena.
 *
 * ── De dónde vienen, medido ─────────────────────────────────────────────────
 * Las 230 filas anteriores a 2024 son **todas** de canales `wincaja_*` y se
 * escribieron **en el mismo microsegundo** (`2026-09-12 06:17:29.064608`): una
 * carga única, no un feed recurrente. Y el origen coincide:
 *
 *     mv_kepler_sales_daily    arranca 2025-01-01 ·   0 filas antes de 2024
 *     mv_wincaja_sales_daily   arranca 2000-01-01 · 394 filas antes de 2024
 *
 * La basura nace en el `.mdb` de Wincaja. El carril Kepler está limpio.
 *
 * ── Por qué el piso es 2024-01-01 y no 2025-01-01 ───────────────────────────
 * El dato legítimo arranca el **2025-01-01** en las DOS fuentes limpias. El piso
 * se pone un año ANTES a propósito: así no puede bloquear un backfill histórico
 * plausible desde la réplica de Wincaja, y aun así ataja la clase catastrófica
 * (el año 2000, 2014). Cubre 230 de las 249 filas malas ($263,504 de $278,068).
 * Las 23 filas de 2024 que quedan **se declaran acá**, no se barren en silencio.
 *
 * ── Por qué NO hay tope superior ────────────────────────────────────────────
 * ⛔ `current_date` es STABLE, no IMMUTABLE: Postgres lo rechaza dentro de un
 * `CHECK`. Y un tope fijo (`< '2027-01-01'`) atajaría la fila de hoy y en enero
 * empezaría a rechazar venta legítima — un candado que caduca es peor que
 * ninguno. Las fechas futuras se DECLARAN desde
 * `test-newdb-sales-source-coverage.js`, que ya corre contra prod.
 *
 * ── NOT VALID, y con motivo ─────────────────────────────────────────────────
 * `NOT VALID` hace dos cosas que acá importan: (1) **no valida las filas que ya
 * están**, o sea que no hay que borrar datos de producción para poder poner el
 * candado — y `CLAUDE.md` prohíbe borrar en prod sin autorización explícita; y
 * (2) **no escanea la tabla**, que pesa 1.6 GB y recibe escrituras cada 60 s
 * (carril `livefast`). Las filas NUEVAS y las ACTUALIZADAS sí se validan, que es
 * exactamente lo que se quiere.
 *
 * ⚠️ Toma `ACCESS EXCLUSIVE` un instante. Con `lock_timeout` corto: o lo agarra
 * rápido o falla limpio, nunca hace cola delante del feed.
 *
 * Aditiva e idempotente.
 *
 * @param { import("knex").Knex } knex
 */
const CONSTRAINT = 'sales_daily_sale_date_piso_check';
const PISO = '2024-01-01';

exports.up = async function up(knex) {
  const { rows } = await knex.raw(
    `SELECT 1 FROM pg_constraint WHERE conname = ? AND conrelid = 'analytics.sales_daily'::regclass`,
    [CONSTRAINT],
  );
  if (rows.length) {
    console.log(`  · ${CONSTRAINT} ya existe — nada que hacer`);
    return;
  }

  // El lock_timeout protege al carril `livefast`, que escribe cada 60 s.
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  await knex.raw(
    `ALTER TABLE analytics.sales_daily
       ADD CONSTRAINT ${CONSTRAINT} CHECK (sale_date >= DATE '${PISO}') NOT VALID`,
  );

  // Se imprime lo que el candado NO cubre, para que quede en el log de la corrida
  // y no sólo en este comentario (un comentario no avisa cuando deja de ser cierto).
  const [r] = await knex.raw(
    `SELECT count(*) FILTER (WHERE sale_date < DATE '${PISO}')::int AS bajo_piso,
            count(*) FILTER (WHERE sale_date > current_date)::int  AS futuras
       FROM analytics.sales_daily`,
  ).then((x) => x.rows);
  console.log(`  · ${CONSTRAINT} puesto (NOT VALID, piso ${PISO})`);
  console.log(`  · quedan declaradas, no borradas: ${r.bajo_piso} filas bajo el piso · ${r.futuras} con fecha futura`);
};

exports.down = async function down(knex) {
  await knex.raw(`ALTER TABLE analytics.sales_daily DROP CONSTRAINT IF EXISTS ${CONSTRAINT}`);
};
