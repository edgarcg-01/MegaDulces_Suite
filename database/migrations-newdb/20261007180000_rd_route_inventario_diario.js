'use strict';
/**
 * `[RD.44]` — **El inventario día por día, y el descuadre que SÍ se puede medir.**
 *
 * Lo pidió Edgar: *"hay que agregar un histórico de inventario día por día"*.
 *
 * ── Por qué es más que una pantalla ─────────────────────────────────────────────────────────
 *
 * Hasta hoy el descuadre de una ruta se calcula contra UNA sola foto, y por eso no es
 * publicable en ninguna de las once (`[RD.40]`): a la cuenta le falta uno de los dos lados del
 * periodo y el artefacto de medición ($413,464) es más grande que la cifra ($298,531).
 *
 * Con DOS fotos el problema desaparece, porque ya no hay que reconstruir nada desde el
 * arranque de la vida del camión:
 *
 *     foto(D) − foto(D_anterior)   debería ser   cargado − vendido  en ese tramo
 *
 * Las dos mitades existen en el tramo, no hay ventana ciega, y lo que sobre es descuadre de
 * verdad. Es la única forma de medirlo que no depende de la apertura.
 *
 * ── Lo que el dato aguanta, medido contra prod el 2026-10-07 ────────────────────────────────
 *
 * El runner guarda la foto por `(truck, fecha)` —su llave primaria— y `ingest.merge_route_stock`
 * borra e inserta sólo el día de hoy, así que **la fila de una fecha pasada ES el último push de
 * ese día**. La historia se acumula sola; lo que faltaba era exponerla: `v_rd_route_photo` la
 * recorta con `max(f.fecha)` para quedarse con la última.
 *
 * ⛔ **La historia arranca el 2026-10-06. No hay nada antes y no se puede reconstruir** — el
 *    runner no guardaba fotas viejas. Hoy existen 6-oct (cerrado) y 7-oct (abierto), así que
 *    **el primer par comparable es mañana**. Esta migración entrega la vista VACÍA de pares a
 *    propósito: es lo que hace que mañana haya medición.
 *
 * ⭐ **Sólo se comparan días CERRADOS**, y esto no es una precaución sino una necesidad medida:
 *    las fotos de hoy se tomaron entre las 07:11 y las 17:47, y **ninguna fuente tiene la hora
 *    del embarque** (los 860 documentos con hora están todos en la "hora 6", que es el artefacto
 *    de zona horaria de Kepler). O sea que contra una foto de media mañana no se puede saber si
 *    la carga del día ya estaba dentro. Contra la ÚLTIMA foto de un día terminado, sí: todo lo
 *    de ese día la precede.
 *
 * ⚠️ El par NO exige días consecutivos. Si un camión no pushea el martes, el miércoles se
 *    compara contra el lunes y se le cobran los flujos de los dos días. Exigir consecutivos
 *    dejaría sin medir justo a los camiones que fallan, que son los que hay que mirar.
 *
 * ⚠️ `security_invoker` queda APAGADO a propósito en las vistas que tocan el FDW, igual que
 *    `v_rd_route_photo`: el mapeo de usuario del servidor foráneo es para el dueño, y con
 *    `security_invoker` `app_runtime` necesitaría su propio mapeo (otra credencial que rotar).
 *
 * @param { import("knex").Knex } knex
 */

const DIARIO = 'analytics.v_rd_route_photo_daily';
const DIA = 'analytics.v_rd_route_day';
const MV = 'analytics.mv_rd_route_day';

exports.up = async function up(knex) {
  // ── 1. La foto de CADA día, no sólo la última ─────────────────────────────────────────────
  await knex.raw(`
    CREATE OR REPLACE VIEW ${DIARIO} AS
    SELECT i.tenant_id,
           i.route_no,
           i.warehouse_id,
           f.fecha                                   AS foto_fecha,
           count(*)::int                             AS renglones,
           round(sum(f.existencia), 3)               AS unidades,
           round(sum(f.importe), 2)                  AS importe,
           max(f._updated_at)                        AS pusheada_en,
           -- El día ya terminó, así que esta foto es la ÚLTIMA de ese día: el merge del runner
           -- borra e inserta por (truck, fecha) y nadie la va a volver a pisar.
           (f.fecha < (now() AT TIME ZONE 'America/Mexico_City')::date) AS dia_cerrado
      FROM analytics.mv_rd_route_identity i
      JOIN runner.existencias_ruta f
        ON f.truck = ('ruta_' || i.route_no)
     WHERE f.existencia > 0
       AND coalesce(btrim(f.sku), '') <> ''
       AND coalesce(btrim(f.unidad), '') <> ''
     GROUP BY i.tenant_id, i.route_no, i.warehouse_id, f.fecha
  `);
  await knex.raw(`GRANT SELECT ON ${DIARIO} TO app_runtime`);
  await knex.raw(`COMMENT ON VIEW ${DIARIO} IS
    'RD.44 - la existencia que cada camioneta declaro CADA dia, no solo la ultima. Sale de
     runner.existencias_ruta por FDW, cuya PK (truck, fecha, sku, unidad) hace que la fila de una
     fecha pasada sea el ultimo push de ese dia. La historia arranca el 2026-10-06 y no se puede
     reconstruir hacia atras. SIN security_invoker a proposito (el mapeo del FDW es del dueno).'`);

  // ── 2. El día por día: lo que movió contra lo que debió mover ─────────────────────────────
  await knex.raw(`
    CREATE OR REPLACE VIEW ${DIA} AS
    WITH foto AS (
      SELECT d.*,
             -- La foto ANTERIOR de ese mismo camion, sea de ayer o de hace una semana. No se
             -- exige consecutividad: exigirla dejaria sin medir al camion que falla un dia, que
             -- es justo el que hay que mirar.
             lag(d.foto_fecha) OVER (PARTITION BY d.tenant_id, d.route_no ORDER BY d.foto_fecha)
               AS foto_previa,
             lag(d.importe)    OVER (PARTITION BY d.tenant_id, d.route_no ORDER BY d.foto_fecha)
               AS importe_previo,
             lag(d.dia_cerrado) OVER (PARTITION BY d.tenant_id, d.route_no ORDER BY d.foto_fecha)
               AS previa_cerrada
        FROM ${DIARIO} d
    ), flujo AS (
      -- Los flujos ESTRICTAMENTE posteriores a la foto previa y hasta la foto de este dia,
      -- valuados con el mismo resolvedor que publica la pantalla: si el tramo se valuara con
      -- otro costo, la resta compararia dos monedas (la leccion de [RD.42]).
      SELECT f.tenant_id, f.route_no, f.foto_fecha,
             round(sum(l.qty * coalesce(u.costo_u, 0))
                     FILTER (WHERE l.clase = 'carga'), 2) AS cargado,
             round(sum(l.qty * coalesce(u.costo_u, 0))
                     FILTER (WHERE l.clase = 'venta'), 2) AS vendido,
             count(*) FILTER (WHERE u.costo_u IS NULL)::int AS celdas_sin_costo
        FROM foto f
        JOIN analytics.mv_rd_route_ledger l
          ON l.tenant_id = f.tenant_id AND l.route_no = f.route_no
         AND l.clase IN ('carga', 'venta')
         AND l.business_date >  f.foto_previa
         AND l.business_date <= f.foto_fecha
        LEFT JOIN analytics.mv_rd_route_unit_value u
          ON u.tenant_id = l.tenant_id AND u.route_no = l.route_no
         AND u.sku = l.sku AND u.unidad = l.unidad
       WHERE f.foto_previa IS NOT NULL
       GROUP BY f.tenant_id, f.route_no, f.foto_fecha
    )
    SELECT f.tenant_id,
           f.route_no,
           f.foto_fecha,
           f.foto_previa,
           (f.foto_fecha - f.foto_previa)              AS dias_del_tramo,
           f.renglones,
           f.unidades,
           f.importe                                   AS inventario,
           f.importe_previo                            AS inventario_previo,
           f.pusheada_en,
           f.dia_cerrado,
           round(f.importe - f.importe_previo, 2)      AS movio,
           x.cargado,
           x.vendido,
           round(coalesce(x.cargado, 0) - coalesce(x.vendido, 0), 2) AS debio_mover,
           round((f.importe - f.importe_previo)
                 - (coalesce(x.cargado, 0) - coalesce(x.vendido, 0)), 2) AS descuadre,
           coalesce(x.celdas_sin_costo, 0)             AS celdas_sin_costo,
           /**
            * ⭐ El tramo es medible sólo si las DOS fotos cierran su día. Contra una foto de
            * media mañana no se puede saber si la carga de ese día ya estaba dentro, y ninguna
            * fuente tiene la hora del embarque para desempatarlo.
            */
           (f.dia_cerrado AND coalesce(f.previa_cerrada, false)
              AND f.foto_previa IS NOT NULL)           AS medible,
           CASE
             WHEN f.foto_previa IS NULL
               THEN 'es la primera foto de este camion: no hay contra que compararla'
             WHEN NOT f.dia_cerrado
               THEN 'el dia no termino: esta foto todavia la va a pisar el proximo push'
             WHEN NOT coalesce(f.previa_cerrada, false)
               THEN 'la foto anterior es de un dia que no habia cerrado'
             ELSE NULL
           END                                         AS motivo
      FROM foto f
      LEFT JOIN flujo x
        ON x.tenant_id = f.tenant_id AND x.route_no = f.route_no AND x.foto_fecha = f.foto_fecha
  `);
  await knex.raw(`GRANT SELECT ON ${DIA} TO app_runtime`);
  await knex.raw(`COMMENT ON VIEW ${DIA} IS
    'RD.44 - el inventario dia por dia y el descuadre del tramo entre dos fotos. Es el UNICO
     descuadre que no depende de la apertura: las dos mitades existen dentro del tramo, asi que
     no hay ventana ciega. medible=false cuando alguna de las dos fotos no cierra su dia -- las
     fotos se toman a cualquier hora y ninguna fuente trae la hora del embarque.'`);

  // ── 3. La copia por costo: la vista pega contra el FDW ────────────────────────────────────
  const existe = (await knex.raw('SELECT to_regclass(?) AS t', [MV])).rows[0];
  if (!existe || !existe.t) {
    await knex.raw(`CREATE MATERIALIZED VIEW ${MV} AS SELECT * FROM ${DIA}`);
    await knex.raw(`CREATE UNIQUE INDEX ux_mv_rd_route_day ON ${MV} (tenant_id, route_no, foto_fecha)`);
    await knex.raw(`GRANT SELECT ON ${MV} TO app_runtime`);
    await knex.raw(`COMMENT ON MATERIALIZED VIEW ${MV} IS
      'RD.44 - copia POR COSTO de analytics.v_rd_route_day (SELECT *). La vista viva cruza el FDW
       al runner; la pantalla lee esta. Se refresca con las demas matvistas de RD.'`);
  }

  // ── 4. Frenos de PROPOSITO ────────────────────────────────────────────────────────────────
  const d = (await knex.raw(`SELECT * FROM ${DIA} ORDER BY route_no, foto_fecha`)).rows;
  if (!d.length) throw new Error('[RD.44] la vista no devuelve ni una foto: el FDW no esta llegando.');

  // La historia tiene que tener MAS de un dia para algun camion, o la vista no agrega nada.
  const conPrevia = d.filter((x) => x.foto_previa);
  if (!conPrevia.length) {
    throw new Error('[RD.44] ningun camion tiene dos fotos: sin eso esta vista no puede medir nada todavia.');
  }

  // ⭐ PRUEBA NEGATIVA del veredicto: una foto de HOY no puede salir medible, porque el proximo
  //    push la va a pisar. Sin esto el campo es decorativo.
  const hoy = (await knex.raw(
    `SELECT (now() AT TIME ZONE 'America/Mexico_City')::date AS h`)).rows[0].h;
  const deHoy = d.filter((x) => String(x.foto_fecha).slice(0, 10) === String(hoy).slice(0, 10));
  if (deHoy.length && deHoy.some((x) => x.medible)) {
    throw new Error(`[RD.44] ${deHoy.filter((x) => x.medible).length} foto(s) de hoy salen medibles: ` +
      'el dia no cerro y el proximo push las pisa.');
  }
  // Y al reves: toda foto no medible debe decir por que.
  const mudas = d.filter((x) => !x.medible && !x.motivo);
  if (mudas.length) throw new Error(`[RD.44] ${mudas.length} tramo(s) no medibles sin motivo declarado.`);

  // La identidad del tramo: movio = inventario - inventario_previo, siempre.
  const rotas = conPrevia.filter((x) =>
    Math.abs(Number(x.movio) - (Number(x.inventario) - Number(x.inventario_previo))) > 0.011);
  if (rotas.length) throw new Error(`[RD.44] en ${rotas.length} tramo(s) "movio" no es la resta de las dos fotos.`);

  const medibles = d.filter((x) => x.medible);
  console.log(`  · [RD.44] ${d.length} fotos de ${new Set(d.map((x) => x.route_no)).size} camiones · ` +
    `${conPrevia.length} tramos · ${medibles.length} medibles hoy` +
    (medibles.length ? '' : ' (el primer par de dias CERRADOS es manana: la historia arranco ayer)'));
};

exports.down = async function down(knex) {
  await knex.raw(`DROP MATERIALIZED VIEW IF EXISTS ${MV}`);
  await knex.raw(`DROP VIEW IF EXISTS ${DIA}`);
  await knex.raw(`DROP VIEW IF EXISTS ${DIARIO}`);
};
