'use strict';
/**
 * ⭐⭐ `[CG.126]` — **La posición de la caja se COMPONE: Control hasta el sábado, la Suite desde
 * ahí.** Y de Control queda el pasado, no la dependencia.
 *
 * Edgar: *"necesito tomemos el histórico de Control, lo traigamos, usemos su conciliación hasta el
 * sábado. Agreguemos el que se hizo ayer en Suite y conciliemos hasta lo que tenemos hoy. Ya no
 * debemos depender de Control pero sí sus datos anteriores para poder conciliar la actualidad"*.
 *
 * Es el mismo molde que `VERDAD_ABSOLUTA.md` §4.6 usó para la venta de una sucursal que cambió de
 * ERP: **la serie se compone en la frontera medida, no se toma el máximo entre las dos fuentes.**
 *
 * ── La frontera, medida ─────────────────────────────────────────────────────────────────────
 *
 * El ancla es el **último arqueo de custodia** de Control: `A23641`, 2026-10-10 12:58:46, con
 * **$3,327.50** de efectivo ($1,000 en billetes + $2,327.50 en moneda).
 *
 * ⚠️ Y «arqueo de custodia» se discrimina por **`dolares <> 0`**, no por «trae varias piernas»:
 * los cobros con tarjeta también traen dos (`A23634`: efectivo $866 + tarjeta $16,420) y no son
 * arqueos. Con el criterio correcto hay **901 arqueos en 616 días**.
 *
 * ── ⛔⛔ Por qué NO se suma Control después del ancla ────────────────────────────────────────
 *
 * Mi primera medición dijo que **ninguno** de los 5 movimientos que Control registró después del
 * ancla estaba en la Suite, y era **FALSA**. El pareo buscaba 1-a-1 por importe, y los dos lados
 * llevan **distinto grano**:
 *
 *     Control 12-oct:  NOM MORELIA $20,803  +  NOM 41 ZAM Y CAN $11,434  =  $32,237
 *     Suite   12-oct:  10 movimientos de nómina en las sucursales 05/06/07/08 = $32,237
 *                                                                              ↑ al peso
 *
 * Lo mismo el 13: Control agrega `BONOS CANINDO $5,450` + `BONOS MKT $4,350`, y la Suite los tiene
 * como `BONOS AUTORIZADO` repartidos en 01/05/06/08. ⭐ *El pareo fila a fila es el método
 * equivocado cuando los dos lados agregan distinto; la conciliación va por CONCEPTO y DÍA.*
 *
 * Y medido el total, la Suite **ya es superconjunto**: 12-oct **$58,710.05** contra $32,237 de
 * Control; 13-oct **$152,996.82** contra $12,947. Control sólo ve el efectivo que sale de la
 * bóveda; la Suite ve todos los gastos. **Por eso se puede dejar de depender de él.**
 *
 * ⛔ Sumar las dos series contaría el mismo dinero dos veces. Control viaja **al lado**, como
 * testigo que se puede mirar, nunca como sumando.
 *
 * Idempotente. Sólo lee; no copia nada (regla principal: cero importers).
 *
 * @param { import("knex").Knex } knex
 */

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);

  // --- 1) EL ANCLA: de dónde arranca la cuenta -----------------------------------------------
  await knex.raw(`
    CREATE OR REPLACE VIEW analytics.v_caja_ancla AS
    SELECT a.folio,
           a.movimientofecha::date                                   AS fecha,
           a.movimientohora                                          AS hora,
           coalesce(nullif(btrim(a.totalefectivo::text),'')::numeric, 0) AS efectivo,
           coalesce(nullif(btrim(a.totalbilletes::text),'')::numeric, 0) AS billetes,
           coalesce(nullif(btrim(a.totalmonedas::text),'')::numeric, 0)  AS monedas,
           coalesce(nullif(btrim(a.totalcheques::text),'')::numeric, 0)  AS cheques,
           coalesce(nullif(btrim(a.totaltarjeta::text),'')::numeric, 0)  AS tarjeta,
           coalesce(nullif(btrim(a.totalcredito::text),'')::numeric, 0)  AS credito,
           coalesce(nullif(btrim(a.dolares::text),'')::numeric, 0)       AS usd,
           coalesce(nullif(btrim(a.dolarestipocambio::text),'')::numeric, 0) AS usd_tc,
           coalesce(nullif(btrim(a.totaldolares::text),'')::numeric, 0)  AS usd_mxn
      FROM caja_general_ods.arqueo_movimientos a
     WHERE NOT a.cancelado
       AND coalesce(nullif(btrim(a.dolares::text),'')::numeric, 0) <> 0
     ORDER BY a.movimientofecha DESC, a.movimientohora DESC
     LIMIT 1`);
  await knex.raw(`GRANT SELECT ON analytics.v_caja_ancla TO app_runtime`);
  await knex.raw(`
    COMMENT ON VIEW analytics.v_caja_ancla IS
      '[CG.126] El ultimo ARQUEO DE CUSTODIA de Control: de ahi arranca la cuenta de la Suite. Se discrimina por dolares<>0, no por "varias piernas" (un cobro con tarjeta tambien trae dos). Hoy: A23641, 2026-10-10 12:58, $3,327.50.'`);

  // --- 2) LA SERIE: día por día desde el ancla ----------------------------------------------
  /**
   * ⭐ La aritmética del cajón es la MISMA que firma el corte (`cash-cut.engine.ts`), y eso es a
   * propósito: dos fórmulas para el mismo saldo divergen el día que alguien toque una.
   *
   *     movimiento = ingresos − gastos − depósitos  +  dispensado − depositado
   *
   * Las dos piernas del cajero están porque **el cajón y la bóveda son cajas distintas**: la ruta
   * cobra en efectivo, la máquina se traga los billetes y al cajón sólo llega la morralla. Sin
   * ellas el esperado pedía contar ~$90,000 que están dentro de la máquina (`[CG.96]`).
   *
   * ⚠️ `security_invoker` para que `cash_ledger` se lea con el RLS de quien pregunta.
   */
  await knex.raw(`
    CREATE OR REPLACE VIEW analytics.v_caja_posicion AS
    WITH ancla AS (SELECT * FROM analytics.v_caja_ancla),
    /**
     * ⛔⛔ LA SERIE ARRANCA AL DIA SIGUIENTE DEL ANCLA, y no es un off-by-one.
     *
     * El arqueo A23641 es de las **12:58:46**, no del cierre del dia. Lo que paso ese sabado
     * DESPUES de esa hora no esta en el, y lo que paso antes SI — asi que sumar el dia entero
     * cuenta doble. Medido: con el dia completo el saldo daba $181,004.50 contra $3,327.50 de
     * arqueo, o sea $177,677 de doble conteo.
     *
     * Y acotar por hora NO SE PUEDE del lado del libro: "cash_ledger.hora" esta **NULL en los 62
     * movimientos** (la columna existe y nadie la llena). "created_at" tiene hora pero es cuando
     * se CAPTURO, no cuando entro el efectivo — usarla seria ubicar un hecho por el reloj de otro.
     *
     * Entonces el dia del ancla se DECLARA, no se adivina: sus totales viajan aparte en
     * "ancla_dia_*" para que se vean y alguien los ubique. Es ADR-056: lo que no se puede medir
     * se declara, y el costo queda acotado a UN dia.
     */
    dias AS (
      SELECT generate_series(
               (SELECT fecha FROM ancla) + 1,
               (now() AT TIME ZONE 'America/Mexico_City')::date,
               interval '1 day')::date AS dia
    ),
    ancla_dia AS (
      SELECT coalesce(sum(l.monto) FILTER (WHERE l.tipo = 'ingreso'), 0) AS ingresos,
             coalesce(sum(l.monto) FILTER (WHERE l.tipo <> 'ingreso'), 0) AS egresos,
             count(*)::int AS movimientos
        FROM finance.cash_ledger l
       WHERE l.deleted_at IS NULL AND l.estado <> 'cancelado'
         AND l.fecha::date = (SELECT fecha FROM ancla)
    ),
    libro AS (
      SELECT l.fecha::date AS dia,
             sum(l.monto) FILTER (WHERE l.tipo = 'ingreso')  AS ingresos,
             sum(l.monto) FILTER (WHERE l.tipo = 'gasto')    AS gastos,
             sum(l.monto) FILTER (WHERE l.tipo = 'deposito') AS depositos,
             count(*)::int                                   AS movimientos
        FROM finance.cash_ledger l
       WHERE l.deleted_at IS NULL AND l.estado <> 'cancelado'
         AND l.fecha::date > (SELECT fecha FROM ancla)
       GROUP BY 1
    ),
    boveda AS (
      SELECT k.accounting_date::date AS dia,
             sum(abs(k.total)) FILTER (WHERE k.type_id = 0) AS depositado,
             sum(abs(k.total)) FILTER (WHERE k.type_id = 4) AS dispensado,
             count(*)::int                                   AS movimientos
        FROM analytics.caos_cash_movements k
       WHERE k.accounting_date::date > (SELECT fecha FROM ancla)
       GROUP BY 1
    ),
    /**
     * ⛔ Control va AL LADO, nunca sumado: después del ancla su dinero ya está en la Suite, con
     * otro grano. Sumarlo contaría dos veces la misma nómina.
     */
    control AS (
      SELECT a.movimientofecha::date AS dia,
             sum(coalesce(nullif(btrim(a.totalefectivo::text),'')::numeric, 0)) AS efectivo,
             count(*)::int AS movimientos
        FROM caja_general_ods.arqueo_movimientos a
       WHERE NOT a.cancelado AND a.movimientofecha::date > (SELECT fecha FROM ancla)
       GROUP BY 1
    ),
    serie AS (
      SELECT d.dia,
             coalesce(l.ingresos, 0)   AS ingresos,
             coalesce(l.gastos, 0)     AS gastos,
             coalesce(l.depositos, 0)  AS depositos,
             coalesce(l.movimientos,0) AS movs_libro,
             coalesce(b.depositado, 0) AS depositado,
             coalesce(b.dispensado, 0) AS dispensado,
             coalesce(b.movimientos,0) AS movs_boveda,
             coalesce(c.efectivo, 0)   AS control_efectivo,
             coalesce(c.movimientos,0) AS movs_control
        FROM dias d
        LEFT JOIN libro   l ON l.dia = d.dia
        LEFT JOIN boveda  b ON b.dia = d.dia
        LEFT JOIN control c ON c.dia = d.dia
    )
    SELECT (SELECT folio    FROM ancla) AS ancla_folio,
           (SELECT fecha    FROM ancla) AS ancla_fecha,
           (SELECT efectivo FROM ancla) AS ancla_efectivo,
           -- Lo del dia del ancla que no se puede ubicar antes o despues de las 12:58.
           (SELECT ingresos    FROM ancla_dia) AS ancla_dia_ingresos,
           (SELECT egresos     FROM ancla_dia) AS ancla_dia_egresos,
           (SELECT movimientos FROM ancla_dia) AS ancla_dia_movimientos,
           s.dia,
           s.ingresos, s.gastos, s.depositos, s.movs_libro,
           s.depositado, s.dispensado, s.movs_boveda,
           s.control_efectivo, s.movs_control,
           round(s.ingresos - s.gastos - s.depositos + s.dispensado - s.depositado, 2) AS movimiento,
           /**
            * ⚠️ El saldo del día del ancla NO vuelve a contar sus movimientos previos: el arqueo
            * ya los contenía. Lo que entra ese día es lo posterior, y la fuente sólo da el DÍA,
            * no la hora, así que se declara en vez de suponerse — ver "limites" abajo.
            */
           round((SELECT efectivo FROM ancla)
                 + sum(s.ingresos - s.gastos - s.depositos + s.dispensado - s.depositado)
                     OVER (ORDER BY s.dia ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW), 2)
             AS saldo_cajon
      FROM serie s
     ORDER BY s.dia`);

  await knex.raw(`ALTER VIEW analytics.v_caja_posicion SET (security_invoker = true)`);
  await knex.raw(`GRANT SELECT ON analytics.v_caja_posicion TO app_runtime`);
  await knex.raw(`
    COMMENT ON VIEW analytics.v_caja_posicion IS
      '[CG.126] El saldo del cajon compuesto: el arqueo de Control como ancla + los movimientos de la Suite y las dos piernas de CAOS. control_efectivo viaja AL LADO como testigo, NUNCA sumado: despues del ancla ese dinero ya esta en la Suite con otro grano (Control agrega "NOM MORELIA", la Suite detalla por sucursal).'`);
};

exports.down = async function down(knex) {
  await knex.raw(`DROP VIEW IF EXISTS analytics.v_caja_posicion`);
  await knex.raw(`DROP VIEW IF EXISTS analytics.v_caja_ancla`);
};
