'use strict';
/**
 * ⭐⭐ `[VEC.10]` — **La venta vecinal se cierra contra el DINERO, y lo que no es venta se declara
 * al lado en vez de sumarse.**
 *
 * Edgar, 2026-10-13: *"tenemos problemas de conciliacion con las ventas de vecinal"* ·
 * *"hay que cuadrarla contra todo, contra lo que ingresa, lo que dice kepler para que no haya
 * desconciliacion"*.
 *
 * ── La premisa con la que arranque era FALSA, y medirla fue lo que destrabo la fase ─────────
 *
 * `[CG.117]` (de esta misma manana) dejo declarado que *"0 de 15 ingresos pegan con
 * `source='kepler_vecinal'`"* y que **caja general no ve la vecinal**. Eso es cierto, y yo lo lei
 * como *"falta ligar la vecinal a Caja General"*. Lo medi y es al reves:
 *
 *   · De los 29 ingresos del libro, **~24 casan con una ruta RD del push a +/-$0.50**.
 *   · Con vecinal no casa **ninguno** a esa distancia.
 *
 * ⭐ **Caja General no es el destino de la vecinal, y nunca lo fue.** `U-D-10` se llama *"Ticket
 * Contado Caja N"*: la vecinal se timbra en una **caja registradora de la sucursal** y su dinero
 * se cuenta en el **arqueo de esa caja**, no en el libro de Caja General. Buscarla en Caja
 * General es buscarla donde no pasa.
 *
 * ⚠️ *Un cruce que da cero puede significar "falta ligarlo" o "no va por ahi", y los dos se leen
 * igual.* Lo que los separa es preguntarle al OTRO lado: el arqueo.
 *
 * ── La cobertura, que es lo que vuelve esto un cierre y no una muestra ───────────────────────
 *
 * **568 de 569 (dia, caja) con venta vecinal tienen arqueo = 99.8%** (abril -> octubre 2026). El
 * unico que falta es del dia en curso. O sea que la cadena existe entera y nadie la habia
 * conectado.
 *
 *     mes      dia-caja   con arqueo
 *     2026-04        12           12
 *     2026-05        55           55
 *     2026-06        78           78
 *     2026-07       114          114
 *     2026-08       109          109
 *     2026-09       136          136
 *     2026-10        64           63
 *
 * ── ⭐⭐ Y el arqueo resulto ser el TERCER testigo de que `U-D-12` no es venta ───────────────
 *
 * El sell-out publica la vecinal de septiembre en **$3,150,428.68** y la pantalla en
 * **$1,943,014.72**: **+$1,207,414, 62%**. La diferencia es `U-D-12` *"Factura Cont No Fiscal"*,
 * que en estas rutas **re-emite el mismo ticket**. Ya habia dos testigos (el solape linea a linea
 * da **16,234 de 16,409 = 98.9%**, y `[VEC.8]` lo midio por cliente/dia/SKU). El arqueo es el
 * tercero, y es el mas fuerte porque **no deriva del mismo documento** — es una persona contando
 * billetes:
 *
 *     suc dia          U-D-10      U-D-12      arqueo
 *     01  2026-10-08  21,430.83   21,430.96   21,430.83   <- el arqueo IGNORA la re-factura
 *     07  2026-10-06  27,725.49   27,725.17   27,725.49
 *     07  2026-10-10  17,970.59   17,970.26   17,970.59
 *
 * Si `U-D-12` fuera venta adicional, la caja habria contado el doble. No lo conto.
 *
 * ⛔ Por eso esta vista **publica `refactura` y `telemarketing` pero NO los suma**. Un numero que
 * no se puede sumar tiene que verse igual: borrarlo deja a quien compara contra el sell-out sin
 * explicacion, y sumarlo repite el error de 62%.
 *
 * ── `U-D-8` "Factura Telemarketing": declarado, y es una DECISION pendiente, no un bug ───────
 *
 * Hay `U-D-8` etiquetado con codigo de ruta vecinal — **$404,607.09 en `1V001`** desde el 30-jun.
 * No es espejo: de sus **721 lineas, 0** tienen gemelo en `U-D-10` (y el mismo test encuentra el
 * 98.9% de espejos en `U-D-12`, o sea que el test SI detecta espejos cuando los hay). Tampoco
 * entra al arqueo: el 07-oct PH tiene $11,931.14 de `U-D-8` y la caja conto exactamente el
 * `U-D-10`.
 *
 * ⇒ Es venta real, facturada por telemarketing, que **no pasa por la caja de la ruta**. Si es de
 * la ruta o de telemarketing lo decide el negocio, no esta migracion. Se publica aparte.
 *
 * ⚠️ Y hay un codigo que lo vuelve explicito: `kduv` registra **`2V004` = "TELEMARKETING MORELIA"**,
 * que cae dentro del patron `^[0-9]V[0-9]` sin ser una ruta de reparto.
 *
 * ── El grano, que es lo que mas facil se publica mal ────────────────────────────────────────
 *
 * ⛔ **El dinero NO se puede atribuir por ruta.** Una caja mezcla rutas y mostrador:
 *
 *     01 caja 4 -> 1V001 + 1V002         (100% vecinal)
 *     05 caja 2 -> 1V002 + 2V001 + 3V001
 *     02 caja 4 -> 1V003 + mostrador
 *
 * El arqueo es por **(sucursal, caja, dia)** y ese es el grano de esta vista. Publicar un
 * "faltante de la ruta 1V003" cuando su caja tambien cobro mostrador seria inventar una
 * atribucion. Por eso viaja `vecinal_pct`: cuando vale 100 el descuadre ES de la vecinal, y
 * cuando no, el renglon dice de cuanto se esta hablando.
 *
 * ── Lo que esto encuentra apenas se enciende (sep-01 -> oct-13) ──────────────────────────────
 *
 *     02 Piedad Abastos   -$50,279.27 SOBRANTE   6 cortes
 *     05 Zamora           +$31,953.92 faltante   7 cortes
 *     07 Morelia Madero    +$2,641.97            1 corte
 *     01 Padre Hidalgo         +$0.79            0 cortes
 *
 * ⚠️ Un sobrante de $50k no es "bueno": es tan descuadre como el faltante. Y casi todo el de
 * Piedad es **un solo corte**: `02` caja 2 del 11-sep, que vendio $5,798.40 y declara
 * $57,798.40 contados — exactamente **+$52,000 redondos**. Se publica como lo que es (el
 * descuadre mas grande del periodo) y **no se afirma la causa**: parece tecleo, pero eso hay que
 * preguntarlo, no deducirlo.
 *
 * ⛔ **Hipotesis descartada POR MEDICION, y conviene que quede escrita para que nadie la
 * reconstruya:** iba a usar el desglose del arqueo (`arqueo_billetes + arqueo_monedas +
 * arqueo_otros + efectivo_retirado`) como testigo independiente de `efectivo_contado`, para
 * separar "error de captura" de "diferencia de dinero". **No cuadra en 3,537 de 4,420 cortes
 * (80%)**, con brechas de millones por sucursal. O sea que esas columnas no significan lo que
 * parece y **no son testigo de nada** hasta que alguien las decodifique. Un check montado ahi
 * habria marcado el 80% de los cortes.
 *
 * ── Por que VISTA y no matvista ─────────────────────────────────────────────────────────────
 *
 * Medido en prod, 43 dias: **38-41 ms** en tres corridas seguidas. La primera version costaba
 * **730 ms** porque calculaba el total de la caja escaneando `kdm1` entero por fecha; el total ya
 * lo declara `cash_cuts.venta_total`, asi que el resto de la caja se **deriva** y el unico escaneo
 * es el indice parcial `ix_kdm1_ruta_vecinal`. 18x mas barato y una fuente menos.
 *
 * Idempotente.
 *
 * @param { import("knex").Knex } knex
 */

const CONCIL = 'analytics.v_vecinal_conciliacion';
const NOSUMA = 'analytics.v_vecinal_no_suma';
const TENANT = '00000000-0000-0000-0000-00000000d01c';
/** El mismo patron que `VECINAL_RX` del servicio y que las vistas de `[VEC.0]`. Una sola forma. */
const RX = '^[0-9]V[0-9]';
/** Centavos de morralla: el arqueo redondea. Medido, los cortes que cuadran caen dentro de $1. */
const TOL = '1';

/**
 * `(sucursal, caja, dia)` — el grano en el que se CUENTA el dinero.
 *
 * ⚠️ `h.c9::date <= hoy MX` replica el corte de `v_kepler_vecinal_sales_docs`: `kdm1` trae
 * documentos con fecha futura y sin el tope un `max()` se veria fresco para siempre.
 */
const DEF_CONCIL = `
SELECT
  '${TENANT}'::uuid                                   AS tenant_id,
  v.warehouse_code,
  v.caja,
  v.business_date,
  v.vecinal,
  v.tickets,
  v.rutas,
  a.cortes,
  a.arqueo_venta,
  a.efectivo_esperado,
  a.efectivo_contado,
  a.efectivo_diff,
  a.tarjeta,
  a.transfer,
  a.cerrado,
  -- Lo que la caja cobro que NO es vecinal. Se DERIVA del arqueo: no hay segundo escaneo de kdm1.
  CASE WHEN a.arqueo_venta IS NULL THEN NULL
       ELSE round(a.arqueo_venta - v.vecinal, 2) END  AS otros_en_la_caja,
  -- 100 = la caja es solo de la vecinal, y entonces el descuadre ES de la vecinal.
  CASE WHEN a.arqueo_venta IS NULL OR a.arqueo_venta = 0 THEN NULL
       ELSE round(100 * v.vecinal / a.arqueo_venta, 1) END AS vecinal_pct,
  /**
   * ⛔ SIETE estados, y las ausencias NO comparten etiqueta (ADR-056). Con un booleano o con
   * "ok por defecto", un dia sin arqueo saldria verde — que es justo el modo de falla que la
   * Fase VP midio dando verde incondicional a tres matvistas del sell-out. Cada estado tiene un
   * DUEÑO distinto, que es el criterio para separarlos y no la estetica:
   *   dia_en_curso          -> el dia no termino. No se juzga: se espera.
   *   sin_arqueo            -> nadie cerro esa caja ese dia. Lo arregla la sucursal.
   *   arqueo_abierto        -> el turno existe y no cerro. Todavia no se puede juzgar.
   *   contado_en_cero       -> el arqueo declara CERO efectivo contado habiendo esperado. NO es
   *                            un faltante del tamaño del turno: es que nadie puso el numero, o
   *                            falto todo, y desde afuera **no se puede distinguir**. Medido:
   *                            43 cortes, $416,406.67. Llamarlo "faltante" inventa la causa.
   *   vecinal_excede_arqueo -> la caja declara menos venta que la vecinal sola. Anomalia.
   *   faltante / sobrante   -> el arqueo no cuadra. Los dos son descuadre.
   */
  CASE
    WHEN v.business_date >= (now() AT TIME ZONE 'America/Mexico_City')::date THEN 'dia_en_curso'
    WHEN a.cortes IS NULL                                   THEN 'sin_arqueo'
    WHEN NOT a.cerrado                                      THEN 'arqueo_abierto'
    WHEN a.efectivo_contado = 0 AND a.efectivo_esperado > 0 THEN 'contado_en_cero'
    WHEN v.vecinal > a.arqueo_venta + ${TOL}                THEN 'vecinal_excede_arqueo'
    WHEN a.efectivo_diff >  ${TOL}                          THEN 'faltante'
    WHEN a.efectivo_diff < -${TOL}                          THEN 'sobrante'
    ELSE 'cuadra'
  END                                                 AS veredicto
FROM (
  SELECT btrim(h.sucursal)                            AS warehouse_code,
         h.c5::int                                    AS caja,
         h.c9::date                                   AS business_date,
         round(sum(h.c16), 2)                         AS vecinal,
         count(*)::int                                AS tickets,
         string_agg(DISTINCT btrim(h.c12), ',' ORDER BY btrim(h.c12)) AS rutas
    FROM kepler_ods.kdm1 h
   WHERE h.c2 = 'U' AND h.c3 = 'D' AND h.c4::int = 10
     AND btrim(COALESCE(h.c12, '')) ~ '${RX}'
     AND btrim(COALESCE(h.c1, '')) = btrim(h.sucursal)
     AND COALESCE(NULLIF(btrim(h.c43), ''), '') <> 'C'
     AND h.c9::date <= (now() AT TIME ZONE 'America/Mexico_City')::date
   GROUP BY 1, 2, 3
  HAVING sum(h.c16) > 0
) v
LEFT JOIN LATERAL (
  SELECT count(*)::int                       AS cortes,
         round(sum(c.venta_total), 2)        AS arqueo_venta,
         round(sum(c.efectivo_esperado), 2)  AS efectivo_esperado,
         round(sum(c.efectivo_contado), 2)   AS efectivo_contado,
         round(sum(c.efectivo_diff), 2)      AS efectivo_diff,
         round(sum(COALESCE(c.tarjeta_contado, 0)), 2)  AS tarjeta,
         round(sum(COALESCE(c.transfer_contado, 0)), 2) AS transfer,
         bool_and(c.cerrado)                 AS cerrado
    FROM analytics.cash_cuts c
   WHERE c.tenant_id = '${TENANT}'::uuid
     AND c.warehouse_code = v.warehouse_code
     AND c.caja::int      = v.caja
     AND c.business_date::date = v.business_date
) a ON true`;

/**
 * `(sucursal, dia)` — lo que lleva codigo de ruta vecinal y **NO es venta de la caja**.
 *
 * ⛔ Grano distinto a proposito: la re-factura se emite en OTRA caja que el ticket que copia, asi
 * que al grano de caja no se puede juntar con lo que refleja. Juntarlas habria hecho que la
 * re-factura "desapareciera" de los renglones donde tiene sentido mirarla.
 */
const DEF_NOSUMA = `
SELECT
  '${TENANT}'::uuid                       AS tenant_id,
  btrim(h.sucursal)                       AS warehouse_code,
  h.c9::date                              AS business_date,
  round(sum(h.c16) FILTER (WHERE h.c4::int = 12), 2)::numeric AS refactura,
  count(*)         FILTER (WHERE h.c4::int = 12)::int         AS refactura_docs,
  round(sum(h.c16) FILTER (WHERE h.c4::int = 8), 2)::numeric  AS telemarketing,
  count(*)         FILTER (WHERE h.c4::int = 8)::int          AS telemarketing_docs,
  string_agg(DISTINCT btrim(h.c12), ',' ORDER BY btrim(h.c12)) AS rutas
FROM kepler_ods.kdm1 h
WHERE h.c2 = 'U' AND h.c3 = 'D' AND h.c4::int IN (8, 12)
  AND btrim(COALESCE(h.c12, '')) ~ '${RX}'
  AND btrim(COALESCE(h.c1, '')) = btrim(h.sucursal)
  AND COALESCE(NULLIF(btrim(h.c43), ''), '') <> 'C'
  AND h.c9::date <= (now() AT TIME ZONE 'America/Mexico_City')::date
GROUP BY 1, 2, 3`;

const COM_CONCIL = `[VEC.10] La venta vecinal (U-D-10) contra el dinero que se conto en SU caja (analytics.cash_cuts). `
  + `Grano (sucursal, caja, dia) porque ahi es donde se cuenta el efectivo; el dinero NO se puede atribuir por ruta `
  + `(una caja mezcla rutas y mostrador -> mirar vecinal_pct). Cobertura medida 2026-10-13: 568 de 569 dia-caja con `
  + `arqueo = 99.8%. veredicto tiene CINCO estados y las ausencias no comparten etiqueta: sin_arqueo e `
  + `arqueo_abierto NO son "cuadra".`;

const COM_NOSUMA = `[VEC.10] Lo que lleva codigo de ruta vecinal y NO es venta de la caja. refactura = U-D-12 `
  + `"Factura Cont No Fiscal", que re-emite el mismo ticket (98.9% de sus lineas tienen gemelo en U-D-10, y el arqueo `
  + `la IGNORA: 01 el 08-oct conto 21,430.83 teniendo 21,430.96 de U-D-12). telemarketing = U-D-8 "Factura `
  + `Telemarketing", que NO es espejo (0 de 721 lineas) y tampoco entra al arqueo: es venta real por otro canal, `
  + `$404,607.09 en 1V001 desde el 30-jun. NINGUNA DE LAS DOS SE SUMA a la venta de la ruta.`;

/** `COMMENT ON` no acepta parametros: el texto va interpolado con las comillas escapadas. */
const lit = (s) => `'${String(s).replace(/'/g, "''")}'`;

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);

  for (const [vista, def, com] of [[CONCIL, DEF_CONCIL, COM_CONCIL], [NOSUMA, DEF_NOSUMA, COM_NOSUMA]]) {
    await knex.raw(`CREATE OR REPLACE VIEW ${vista} AS ${def}`);
    await knex.raw(`ALTER VIEW ${vista} SET (security_invoker = true)`);
    // ⚠️ `security_invoker` y el GRANT NO se heredan en un CREATE OR REPLACE. Esta casa ya perdio
    //    uno asi y solo lo vio la asercion de metadata de un candado (ADR-057).
    await knex.raw(`GRANT SELECT ON ${vista} TO app_runtime`);
    await knex.raw(`GRANT SELECT ON ${vista} TO dev_ro`);
    await knex.raw(`COMMENT ON VIEW ${vista} IS ${lit(com)}`);
  }

  // ── Freno 1: la PREMISA del veredicto ─────────────────────────────────────────────────────
  //
  // `faltante`/`sobrante` cuelgan del signo de `efectivo_diff`, que es una columna de OTRA fase.
  // Si manana alguien invierte esa convencion, esta vista llamaria sobrante a un faltante y no se
  // notaria. Medido hoy: 4,417 de 4,417 filas cumplen diff = esperado - contado.
  const { rows: [signo] } = await knex.raw(`
    SELECT count(*)::int AS n,
           count(*) FILTER (WHERE round(efectivo_diff, 2) = round(efectivo_esperado - efectivo_contado, 2))::int AS ok
      FROM analytics.cash_cuts
     WHERE efectivo_esperado IS NOT NULL AND efectivo_contado IS NOT NULL`);
  if (signo.n === 0) throw new Error('[VEC.10] analytics.cash_cuts vacia: no hay con que cuadrar');
  if (signo.ok !== signo.n) {
    throw new Error(`[VEC.10] efectivo_diff NO es (esperado - contado) en ${signo.n - signo.ok} de ${signo.n} filas `
      + '-- el veredicto faltante/sobrante saldria invertido');
  }
  console.log(`  · [VEC.10] signo de efectivo_diff verificado: ${signo.ok}/${signo.n}`);

  // ── Freno 2: COBERTURA. Sin arqueo detras, la vista no cierra nada ────────────────────────
  const { rows: [cob] } = await knex.raw(`
    SELECT count(*)::int AS filas,
           count(*) FILTER (WHERE veredicto = 'sin_arqueo')::int AS sin_arqueo,
           count(DISTINCT warehouse_code)::int AS sucursales
      FROM ${CONCIL}`);
  if (cob.filas === 0) throw new Error(`[VEC.10] ${CONCIL} quedo VACIA`);
  const pct = ((cob.filas - cob.sin_arqueo) / cob.filas) * 100;
  if (pct < 90) {
    throw new Error(`[VEC.10] cobertura de arqueo ${pct.toFixed(1)}% (${cob.sin_arqueo} sin arqueo de ${cob.filas}) `
      + '-- medido el 2026-10-13 era 99.8%; por debajo de 90% la vista no cierra nada');
  }
  console.log(`  · [VEC.10] ${cob.filas} dia-caja · ${cob.sucursales} sucursales · cobertura ${pct.toFixed(1)}%`);

  // ── Freno 3: PROPOSITO. El arqueo tiene que IGNORAR la re-factura ─────────────────────────
  //
  // ⭐ Esta es la asercion que vuelve util a la vista: si algun dia el arqueo empezara a contar
  // `U-D-12`, la premisa de `[VEC.8]` (que es espejo, y por eso el sell-out sobra 62%) se cae y
  // hay que volver a medirla.
  //
  // ⛔ La primera version de este freno era CIRCULAR: definia "caja pura" como `vecinal_pct = 100`
  // — o sea, por la misma igualdad que despues afirmaba. Un test asi pasa siempre y no vigila
  // nada. Lo que se mide ahora es la hipotesis CONTRARIA: si el arqueo contara la re-factura,
  // `arqueo_venta` estaria cerca de `vecinal + refactura`. Se exige que NO lo este.
  const { rows: [esp] } = await knex.raw(`
    WITH con_refact AS (
      SELECT c.warehouse_code, c.business_date, c.vecinal, c.arqueo_venta, s.refactura
        FROM ${CONCIL} c
        JOIN ${NOSUMA} s ON s.warehouse_code = c.warehouse_code AND s.business_date = c.business_date
       WHERE c.arqueo_venta IS NOT NULL AND COALESCE(s.refactura, 0) > 0
         AND c.veredicto NOT IN ('dia_en_curso', 'sin_arqueo', 'arqueo_abierto')
         AND c.business_date >= current_date - 60
    )
    SELECT count(*)::int AS n,
           -- el arqueo se parece a U-D-10 solo (lo esperado)
           count(*) FILTER (WHERE abs(r.arqueo_venta - r.vecinal) < abs(r.arqueo_venta - (r.vecinal + r.refactura)))::int AS mas_cerca_de_ud10,
           -- el arqueo se parece a U-D-10 + re-factura (lo que refutaria la premisa)
           count(*) FILTER (WHERE abs(r.arqueo_venta - (r.vecinal + r.refactura)) <= ${TOL})::int AS igual_a_la_suma
      FROM con_refact r`);
  if (esp.n === 0) {
    console.log('  · [VEC.10] ⚠️ NO MEDIDO: no hay dia-caja con re-factura en los ultimos 60 dias');
  } else {
    if (esp.igual_a_la_suma > 0) {
      throw new Error(`[VEC.10] en ${esp.igual_a_la_suma} de ${esp.n} dia-caja el arqueo IGUALA vecinal + refactura `
        + '-- entonces U-D-12 SI seria dinero y la premisa de [VEC.8] hay que volver a medirla');
    }
    console.log(`  · [VEC.10] la re-factura NO esta en el arqueo: ${esp.mas_cerca_de_ud10}/${esp.n} dia-caja `
      + 'mas cerca de U-D-10 que de U-D-10+U-D-12, y 0 iguales a la suma');
  }

  // ── Freno 4: COSTO. Es vista, no matvista, y eso solo se sostiene si es barata ────────────
  const t = Date.now();
  await knex.raw(`SELECT count(*) FROM ${CONCIL} WHERE business_date >= current_date - 45`);
  const ms = Date.now() - t;
  console.log(`  · [VEC.10] 45 dias en ${ms} ms (medido el 2026-10-13: 38-41 ms)`);
  if (ms > 1000) {
    throw new Error(`[VEC.10] ${ms} ms para 45 dias -- por encima del gate de 1 s deja de ser vista`);
  }
};

exports.down = async function down(knex) {
  await knex.raw(`DROP VIEW IF EXISTS ${CONCIL}`);
  await knex.raw(`DROP VIEW IF EXISTS ${NOSUMA}`);
};
