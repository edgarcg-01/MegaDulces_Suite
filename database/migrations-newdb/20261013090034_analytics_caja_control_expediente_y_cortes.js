'use strict';
/**
 * `[CG.105]` — **El expediente diario de Caja General y el historial de cortes, derivados de
 * Control.** Dos vistas, cero tablas, cero importers.
 *
 * Edgar, 2026-10-13: *"necesito que generes un historial de cortes diario, y un expediente de
 * movimientos diario donde se muestre el ticket"* · *"lo revisan todas las mañanas que el corte
 * sí coincida con lo que existe en la caja"*.
 *
 * ── De dónde sale, y por qué no hay que construir nada ──────────────────────────────────────
 *
 * `caja_general_ods.arqueo_movimientos` ya está en prod: **30,199 renglones, 2013-09-13 →
 * 2026-10-12**, carril vivo (`_ship_watermark`). Es el back-end del Access `Control`, que no
 * tiene datos propios — sus tablas están VINCULADAS. O sea que la historia que se revisa cada
 * mañana lleva trece años acá y nadie la había mirado desde la plataforma.
 *
 * ── Lo medido antes de escribir una línea (sólo lectura, prod 2026-10-13) ───────────────────
 *
 * ⭐⭐ **El ticket reconstruye el efectivo declarado en 23,652 de 23,652 renglones. Cero
 * excepciones.** Por eso `cuadra_ticket` se publica como dato: cuando un renglón NO cuadre, será
 * un hecho nuevo y no el ruido de un decode flojo.
 *
 * ⚠️ Pero el límite de esa prueba se declara: el **placebo** (tratar `centavos` como importe en
 * vez de piezas de un centavo) acierta 23,648 de 23,652. O sea que la unidad de `centavos` la
 * deciden **4 renglones**, no 23,652. Las otras dieciséis denominaciones sí quedan probadas por
 * el conjunto entero. *Un total que cuadra no prueba todas sus partes por igual.*
 *
 * ⛔⛔ **LO QUE NO SE PUEDE SUMAR, Y ES LA RAZÓN DE `naturaleza`.** Medido sobre 2026:
 *
 *   · los dólares toman **9 valores en todo el año**, y el actual —12,059 USD a 19.101— se
 *     repite **205 veces del 2-abr al 10-oct**;
 *   · `totalcredito` vale **$20,782.00 exactos 383 veces**, desde el 2025-10-06.
 *
 * Eso no es flujo: es un **saldo PARADO que se vuelve a declarar en cada conteo**. Sumarlo por
 * día daba múltiplos exactos (1x, 2x, 3x) del mismo fajo — dinero que no existe. Por eso cada
 * renglón dice qué es, y quien consuma la vista no puede meterlos en el mismo `sum()` sin verlo.
 *
 * ⛔ **Control NO tiene una columna que marque un conteo** — se buscó: `arqueo` y `deposito`
 * vienen NULL siempre, `adeposito` es `false` siempre, `movimientoprincipal` vale 1 en 3,152 de
 * 3,153 renglones de 2026, `caja` siempre '00', e `id`=`id2`=consecutivo. La única señal medible
 * es que el renglón **declare el fajo de dólares**, y eso es lo que usa `naturaleza`.
 *
 * ⚠️ **Su límite, declarado:** un conteo hecho un día sin dólares en la caja quedaría rotulado
 * como movimiento. Por eso `v_caja_control_cortes` publica `tiene_corte` en vez de inventar un
 * cierre: un día sin conteo se DICE, no se dibuja en cero (ADR-056).
 *
 * ⛔ **Y una regla de clasificación anterior quedó REFUTADA**, se deja escrita para que nadie la
 * reconstruya: *"toda fila con algo distinto de efectivo es un conteo"* es falsa — `A23627` del
 * 8-oct, con observación `r21` y $17,490 de tarjeta, es la **liquidación de la ruta 21**.
 *
 * Idempotente: `CREATE OR REPLACE VIEW`.
 *
 * @param { import("knex").Knex } knex
 */

/** Una columna de texto de Control leída como número, sin reventar si llega sucia. */
const n = (c) => `coalesce(nullif(btrim(coalesce(a.${c},'')),'')::numeric, 0)`;

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  await knex.raw(`CREATE SCHEMA IF NOT EXISTS analytics`);

  // ── 1) EL EXPEDIENTE: un renglón por movimiento, con su ticket ────────────────────────────
  await knex.raw(`
    CREATE OR REPLACE VIEW analytics.v_caja_control_movimientos AS
    SELECT
      a.folio,
      (left(a.movimientofecha, 10))::date                   AS fecha,
      substr(a.movimientohora, 12, 8)                       AS hora,
      a.almacen,
      a.caja,
      a.capturo,
      nullif(btrim(coalesce(a.observaciones, '')), '')      AS observaciones,
      a.cancelado, a.impreso, a.finalizado, a.revisado,

      -- El TICKET: las piezas de cada denominacion, tal como se contaron.
      ${n('b1000')} AS b1000, ${n('b500')} AS b500, ${n('b200')} AS b200,
      ${n('b100')}  AS b100,  ${n('b50')}  AS b50,  ${n('b20')}  AS b20,
      ${n('m100')}  AS m100,  ${n('m20')}  AS m20,  ${n('m10')}  AS m10,
      ${n('m5')}    AS m5,    ${n('m2')}   AS m2,   ${n('m1')}   AS m1,
      ${n('m50c')}  AS m50c,  ${n('m20c')} AS m20c, ${n('m10c')} AS m10c,
      ${n('m5c')}   AS m5c,   ${n('centavos')} AS centavos,

      coalesce(a.totalbilletes, 0) AS total_billetes,
      coalesce(a.totalmonedas, 0)  AS total_monedas,
      coalesce(a.totalefectivo, 0) AS total_efectivo,

      -- Las cuatro piernas que NO son efectivo en pesos. Se publican aparte, nunca sumadas
      -- al efectivo: es el "apartado diferente" que pidio Edgar, y es lo correcto.
      coalesce(a.totalcheques, 0)  AS total_cheques,
      coalesce(a.totaltarjeta, 0)  AS total_tarjeta,
      coalesce(a.totalcredito, 0)  AS total_papeles,
      ${n('dolares')}              AS dolares_usd,
      nullif(coalesce(a.dolarestipocambio, 0), 0) AS tipo_cambio,
      coalesce(a.totaldolares, 0)  AS total_dolares,
      coalesce(a.movimientototal, 0) AS total_declarado,

      -- El renglon declara el fajo de dolares => alguien conto la caja completa.
      CASE WHEN ${n('dolares')} <> 0 THEN 'conteo' ELSE 'movimiento' END AS naturaleza,

      -- ⭐ El AUTO-CHEQUE: las piezas vuelven a dar el efectivo declarado? Medido: 23,652/23,652.
      -- Publicarlo cuesta nada y convierte un descuadre futuro en un hecho visible en vez de
      -- un numero que nadie vuelve a mirar.
      (abs(
        1000*${n('b1000')} + 500*${n('b500')} + 200*${n('b200')} + 100*${n('b100')}
        + 50*${n('b50')} + 20*${n('b20')} + 100*${n('m100')} + 20*${n('m20')} + 10*${n('m10')}
        + 5*${n('m5')} + 2*${n('m2')} + 1*${n('m1')} + 0.50*${n('m50c')} + 0.20*${n('m20c')}
        + 0.10*${n('m10c')} + 0.05*${n('m5c')} + 0.01*${n('centavos')}
        - coalesce(a.totalefectivo, 0)
      ) <= 0.005) AS cuadra_ticket
    FROM caja_general_ods.arqueo_movimientos a`);

  // ── 2) EL HISTORIAL: un renglon por dia, con el corte de ESE dia ──────────────────────────
  await knex.raw(`
    CREATE OR REPLACE VIEW analytics.v_caja_control_cortes AS
    WITH m AS (
      SELECT * FROM analytics.v_caja_control_movimientos WHERE NOT cancelado
    ),
    dia AS (
      SELECT
        fecha,
        count(*)::int                                          AS movimientos,
        count(*) FILTER (WHERE naturaleza = 'conteo')::int      AS conteos,
        count(*) FILTER (WHERE NOT cuadra_ticket)::int          AS tickets_que_no_cuadran,
        -- Solo los MOVIMIENTOS se suman. Los conteos son fotos del mismo dinero: sumarlos
        -- con los movimientos es contar el saldo tantas veces como alguien haya contado.
        coalesce(sum(total_efectivo) FILTER (WHERE naturaleza = 'movimiento'), 0) AS efectivo_movido,
        min(hora) AS primera_hora,
        max(hora) AS ultima_hora
      FROM m GROUP BY fecha
    ),
    cierre AS (
      -- El corte del dia = el ULTIMO conteo. Si hubo tres, el que vale es el de mas tarde.
      SELECT DISTINCT ON (fecha)
        fecha, folio, hora, capturo,
        total_billetes, total_monedas, total_efectivo,
        total_cheques, total_tarjeta, total_papeles,
        dolares_usd, tipo_cambio, total_dolares, total_declarado, cuadra_ticket,
        b1000, b500, b200, b100, b50, b20,
        m100, m20, m10, m5, m2, m1, m50c, m20c, m10c, m5c, centavos
      FROM m WHERE naturaleza = 'conteo'
      ORDER BY fecha, hora DESC
    )
    SELECT
      d.fecha, d.movimientos, d.conteos, d.tickets_que_no_cuadran,
      d.efectivo_movido, d.primera_hora, d.ultima_hora,
      -- ⚠️ NULL cuando ese dia nadie conto la caja. NO es cero: es "no se midio" (ADR-056),
      -- y la pantalla tiene que decir las dos cosas distinto.
      (c.folio IS NOT NULL) AS tiene_corte,
      c.folio AS corte_folio, c.hora AS corte_hora, c.capturo AS corte_capturo,
      c.cuadra_ticket AS corte_cuadra_ticket,
      c.total_billetes, c.total_monedas, c.total_efectivo,
      c.total_cheques, c.total_tarjeta, c.total_papeles,
      c.dolares_usd, c.tipo_cambio, c.total_dolares, c.total_declarado,
      c.b1000, c.b500, c.b200, c.b100, c.b50, c.b20,
      c.m100, c.m20, c.m10, c.m5, c.m2, c.m1, c.m50c, c.m20c, c.m10c, c.m5c, c.centavos
    FROM dia d
    LEFT JOIN cierre c USING (fecha)`);

  // ⚠️ `security_invoker` y el GRANT NO se heredan al recrear una vista: se re-aplican siempre.
  // Ya costo una vez (ADR-057) y solo lo vio la asercion de metadata de un candado.
  for (const v of ['v_caja_control_movimientos', 'v_caja_control_cortes']) {
    await knex.raw(`ALTER VIEW analytics.${v} SET (security_invoker = true)`);
    await knex.raw(`GRANT SELECT ON analytics.${v} TO app_runtime`);
  }
};

/** Deshace EXACTAMENTE lo que hizo el `up`, ni una fila más. */
exports.down = async function down(knex) {
  await knex.raw(`DROP VIEW IF EXISTS analytics.v_caja_control_cortes`);
  await knex.raw(`DROP VIEW IF EXISTS analytics.v_caja_control_movimientos`);
};
