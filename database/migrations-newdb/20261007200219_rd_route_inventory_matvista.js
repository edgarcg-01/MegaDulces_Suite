'use strict';
/**
 * [RD.47] -- **Inventario de ruta tardaba 414 ms de servidor (729 ms en frio) para 11 filas.**
 *
 * -- Lo medido (prod, 2026-10-07) --------------------------------------------------------
 *  . La consulta que la pantalla hace al abrir: **414 ms de servidor, 729 ms de cliente en
 *    frio, 480 ms el mejor caso**. El gate del proyecto es 500 ms, asi que la cruza siempre
 *    en frio y la roza siempre en caliente.
 *  . Agrega **9,103 filas** del ledger para devolver **11**, una por ruta.
 *  . El tiempo no tiene un solo culpable: ~167 ms hasta el CTE win, ~287 ms en la cadena de
 *    hash joins, 390 ms al sort final. No hay un indice que lo arregle.
 *
 * -- Que se materializa, y por que asi ---------------------------------------------------
 *
 * La consulta del servicio toma 9 parametros: tenant, el rango (desde/hasta) y "ayer". La
 * pantalla al abrir usa el rango por DEFAULT -- toda la ventana --, que es justo lo que se
 * puede precomputar. Con rango explicito el servicio sigue yendo en vivo (patron de Fase C.1:
 * la copia sirve el caso de siempre, el caso raro paga).
 *
 * El multi-tenant se resuelve con un LATERAL sobre identity.tenants en vez de reescribir los
 * GROUP BY: asi la logica de adentro queda **identica, caracter por caracter**, a la del
 * servicio. Reescribirla a mano para "quitarle el tenant" era la via rapida y la unica forma
 * segura de introducir un bug sutil en 13,000 caracteres de SQL.
 *
 * -- La deuda, declarada con nombre ------------------------------------------------------
 *
 * ! **Esta migracion tiene una COPIA del SQL del servicio.** Si alguien cambia uno y no el
 * otro, la pantalla publica una cifra y la copia otra. No se puede evitar (la del servicio es
 * parametrizada y esta no), asi que se compensa: el candado
 * database/tests/test-newdb-rd-route-inventory.js compara **fila por fila** la copia contra la
 * consulta viva y se pone ROJO en cuanto divergen. Una copia con candado de paridad no es una
 * segunda verdad; una copia sin el, si.
 *
 * ! Lo que la copia cuesta: hasta 30 min de rezago (se refresca con las demas). Para un
 * inventario que se mide por dia es tolerable, y el dato de frescura ya viaja en la respuesta.
 *
 * Idempotente.
 *
 * @param { import("knex").Knex } knex
 */

const MAT = 'analytics.mv_rd_route_inventory';
const GATE_MS = 500;

/**
 * La consulta del servicio con sus 9 parametros resueltos al caso por DEFAULT:
 *   tenant -> t.id (del LATERAL) . desde -> 2000-01-01 . hasta -> hoy MX . ayer -> ayer MX
 * Generada desde el fuente, no transcrita.
 */
const CUERPO = `
WITH win AS (
           SELECT l.route_no, l.sku, l.unidad,
                  sum(l.qty)       FILTER (WHERE l.clase='carga') AS cq,
                  sum(l.costo_doc) FILTER (WHERE l.clase='carga') AS cv,
                  -- [RD.31] El conteo fisico es el ARRANQUE del saldo, no una carga. Viaja en su
                  -- propia clase para que carga_costo siga diciendo lo que se le SUBIO al camion:
                  -- sumarlo ahi inflaria el cargado del periodo con mercancia que ya estaba arriba.
                  sum(l.qty)       FILTER (WHERE l.clase='conteo') AS kq,
                  sum(l.costo_doc) FILTER (WHERE l.clase='conteo') AS kv,
                  sum(l.qty)       FILTER (WHERE l.clase='venta') AS vq,
                  sum(l.venta_doc) FILTER (WHERE l.clase='venta') AS vi,
                  sum(l.costo_erp) FILTER (WHERE l.clase='venta') AS ce,
                  -- La venta que el contraste del ERP NO alcanza a explicar, EN DINERO.
                  --
                  -- Tiene que medirse acá, a nivel línea, y no contando pares afuera: medido
                  -- contra prod, por pares el contraste "cubre" el 77.7% y en dinero cubre el
                  -- 38%. Un par con una sola línea con costo cuenta como cubierto entero. La
                  -- cobertura se declara en la unidad en la que se publica la cifra.
                  sum(l.venta_doc) FILTER (WHERE l.clase='venta' AND l.costo_erp IS NULL) AS vi_sin_ce,
                  max(l.business_date)                            AS ultimo
             FROM analytics.mv_rd_route_ledger l
            WHERE l.tenant_id = t.id AND l.business_date >= DATE '2000-01-01' AND l.business_date <= (now() AT TIME ZONE 'America/Mexico_City')::date
            GROUP BY 1,2,3
         ), val AS (
           /**
            * ⛔ El unitario NO se calcula acá. Se LEE del resolvedor, y la diferencia no es de
            * estilo: calcularlo por columna hacia que las dos sumaran UNIVERSOS DISTINTOS.
            * Un par con carga y sin venta tenia costo y no precio, asi que entraba al COSTO y
            * se caia del PRECIO; con los negativos pasaba al reves. Resultado medido el
            * 2026-10-05: 10 de 11 rutas publicaban un inventario que costaba MAS de lo que
            * vale al cliente. Con el resolvedor quedan 5, y son exactamente las de saldo
            * negativo -- donde invertirse es lo correcto.
            */
           SELECT w.*, u.costo_u, u.precio_u, u.origen_costo, u.origen_precio,
                  -- [RD.31] saldo = lo contado + lo cargado despues - lo vendido despues. Sin
                  -- conteo, kq es NULL y la cuenta es la de siempre: la columna no cambia de
                  -- significado, gana un sumando que hasta hoy no existia.
                  coalesce(w.cq,0) + coalesce(w.kq,0) - coalesce(w.vq,0) AS saldo
             FROM win w
             LEFT JOIN analytics.mv_rd_route_unit_value u
               ON u.tenant_id = t.id AND u.route_no = w.route_no
              AND u.sku = w.sku AND u.unidad = w.unidad
         ), carga_dia AS (
           -- Lo que se le subio al camion AYER, y cuando fue la ultima vez que se le subio algo.
           -- Va al margen de la ventana elegida: es senal del dia, no del periodo.
           --
           -- Las dos salen de UN solo barrido. La version con un CTE por pregunta recorria la
           -- matvista dos veces y el presupuesto de esta pantalla es de 500 ms.
           --
           -- NULL cuando no hubo embarque, nunca 0: "no le cargamos" y "le cargamos nada" son
           -- cosas distintas, y un 0 diria que le mandamos el camion vacio (ADR-056). Medido el
           -- 2026-10-02: cargaron 6 de 11 rutas, asi que cinco filas caen aca todos los dias.
           SELECT l.route_no,
                  sum(l.qty)       FILTER (WHERE l.business_date = ((now() AT TIME ZONE 'America/Mexico_City')::date - 1)::date) AS ayer_q,
                  sum(l.costo_doc) FILTER (WHERE l.business_date = ((now() AT TIME ZONE 'America/Mexico_City')::date - 1)::date) AS ayer_costo,
                  max(l.business_date) FILTER (WHERE l.clase='carga')        AS ultima_carga,
                  max(l.business_date) FILTER (WHERE l.clase='venta')        AS ultima_venta
             FROM analytics.mv_rd_route_ledger l
            WHERE l.tenant_id = t.id
            GROUP BY 1
         ), ultimo_dia AS (
           /**
            * Lo que movio la ULTIMA VEZ, no "ayer". El domingo es inhabil y el sabado tampoco
            * cargan: medido el 2026-10-05, "ayer" daba 0 de 11 camiones y la columna no decia
            * nada util. La pregunta del negocio no es que paso ayer sino **cuando fue la ultima
            * vez y cuanto**, que ademas funciona igual en lunes que en domingo.
            */
           SELECT l.route_no, l.clase,
                  sum(l.qty)                                     AS qty,
                  sum(coalesce(l.costo_doc, l.venta_doc))        AS imp
             FROM analytics.mv_rd_route_ledger l
             JOIN carga_dia cd ON cd.route_no = l.route_no
            WHERE l.tenant_id = t.id
              AND l.business_date = CASE WHEN l.clase='carga' THEN cd.ultima_carga
                                         ELSE cd.ultima_venta END
            GROUP BY 1,2
         )
         SELECT i.route_no, i.plaza, to_char(i.carga_desde,'YYYY-MM-DD') AS carga_desde,
                round(max(cd.ayer_costo),2)::float                        AS cargado_ayer_costo,
                round(max(cd.ayer_q),2)::float                            AS cargado_ayer_qty,
                to_char(max(cd.ultima_carga),'YYYY-MM-DD')                AS ultima_carga,
                to_char(max(cd.ultima_venta),'YYYY-MM-DD')                AS ultima_venta,
                round(max(uc.imp),2)::float                               AS ultima_carga_imp,
                round(max(uv.imp),2)::float                               AS ultima_venta_imp,
                -- El tope lo lleva el camion (commercial.warehouses). NULL = sin tope declarado.
                round(max(w.inventory_max_mxn),2)::float                  AS tope_inventario,
                -- La última actividad de la ruta, del MISMO barrido que todo lo demás. Es lo que
                -- delata a una ruta parada: medido, la 505 no mueve nada desde el 10-sep y se veía
                -- igual que las diez vivas.
                to_char(max(v.ultimo),'YYYY-MM-DD')                           AS ultimo_movimiento,
                round(sum(v.cq * v.costo_u),2)::float                          AS carga_costo,
                round(sum(coalesce(v.vq,0) * v.costo_u),2)::float              AS cogs_costo,
                round(sum(v.saldo * v.costo_u),2)::float                       AS inventario_costo,
                round(sum(v.saldo * v.costo_u) FILTER (WHERE v.saldo > 0),2)::float AS inventario_costo_pos,
                round(sum(v.saldo * v.costo_u) FILTER (WHERE v.saldo < 0),2)::float AS inventario_costo_neg,
                round(sum(v.cq * v.costo_u) - sum(coalesce(v.vq,0) * v.costo_u)
                      - sum(v.saldo * v.costo_u),2)::float                     AS delta_costo,
                round(sum(coalesce(v.cq,0) * v.precio_u),2)::float             AS carga_venta,
                /**
                 * ⛔ El vendido de la columna VENTA se valua con el precio RESUELTO, no con el
                 * dinero crudo del periodo. Medido el 2026-10-05: con el dinero crudo la
                 * identidad se rompia en cuanto la ventana era corta -- en un solo dia daba
                 * -$1,636 en 9 de 11 rutas y la pantalla gritaba "la cuenta no cierra" mientras
                 * la columna de descuadre mostraba 0, porque esa columna solo mira el costo.
                 * Sobre toda la historia cerraba, asi que el defecto solo salia al filtrar.
                 *
                 * La causa: precio_u sale del resolvedor (toda la historia) y vi es el
                 * dinero de la ventana; cuando el precio del periodo difiere del historico,
                 * qty x precio_u deja de ser vi y la resta no cuadra.
                 */
                round(sum(coalesce(v.vq,0) * v.precio_u),2)::float             AS venta_cliente,
                /** Lo que el cliente pago DE VERDAD en la ventana. Es un hecho y viaja aparte. */
                round(sum(v.vi),2)::float                                      AS cobrado_real,
                round(sum(v.saldo * v.precio_u),2)::float                      AS inventario_venta,
                round(sum(v.saldo * v.precio_u) FILTER (WHERE v.saldo > 0),2)::float AS inventario_venta_pos,
                round(sum(v.saldo * v.precio_u) FILTER (WHERE v.saldo < 0),2)::float AS inventario_venta_neg,
                round(sum(coalesce(v.cq,0) * v.precio_u) - sum(v.vi)
                      - sum(v.saldo * v.precio_u),2)::float                    AS delta_venta,
                round(sum(v.ce),2)::float                                      AS cogs_erp,
                count(v.sku)::int                                             AS pares,
                count(*) FILTER (WHERE v.saldo > 0)::int                       AS pares_pos,
                count(*) FILTER (WHERE v.saldo < 0)::int                       AS pares_neg,
                count(*) FILTER (WHERE coalesce(v.vq,0) > 0 AND v.costo_u IS NULL)::int AS pares_sin_costo,
                round(sum(v.vi) FILTER (WHERE coalesce(v.vq,0) > 0 AND v.costo_u IS NULL),2)::float AS venta_sin_costo,
                count(*) FILTER (WHERE coalesce(v.cq,0) > 0 AND v.precio_u IS NULL)::int AS pares_sin_precio,
                round(sum(v.cv) FILTER (WHERE coalesce(v.cq,0) > 0 AND v.precio_u IS NULL),2)::float AS carga_sin_precio,
                -- La COBERTURA del contraste, no solo su suma. Medido contra prod el 2026-10-03:
                -- el c62 que el ERP escribe en la linea de venta falta en el 69.93% de los pares
                -- y en el 100% de las cinco rutas de Canindo, porque el U-D-10 de la sucursal ve
                -- menos de la mitad de la venta de ruta. Publicar esa suma sin su cobertura hace
                -- creer que el margen es del 79%; con la cobertura al lado se lee como lo que es.
                count(*) FILTER (WHERE coalesce(v.vq,0) > 0)::int                 AS pares_vendidos,
                count(*) FILTER (WHERE coalesce(v.vq,0) > 0 AND v.ce IS NULL)::int AS pares_sin_cogs_erp,
                round(sum(v.vi_sin_ce),2)::float                                  AS venta_sin_cogs_erp,
                -- De donde salio el unitario. Un valor tomado de la ficha es un hecho de Kepler,
                -- no un relleno -- pero el que lo lee tiene derecho a saber cual uso (ADR-056).
                count(*) FILTER (WHERE v.origen_costo  = 'kepler')::int             AS costo_de_ficha,
                count(*) FILTER (WHERE v.origen_precio = 'kepler')::int             AS precio_de_ficha,
                count(*) FILTER (WHERE v.costo_u  IS NULL AND v.sku IS NOT NULL)::int AS sin_costo_resuelto,
                count(*) FILTER (WHERE v.precio_u IS NULL AND v.sku IS NOT NULL)::int AS sin_precio_resuelto,
                -- ⛔ [RD.40] Hasta donde se puede creer delta_costo. NO es una suma mas: es la
                -- cota del ARTEFACTO, en la misma moneda que el descuadre. Sale de
                -- analytics.v_rd_route_opening, que es donde ya vivia la mitad de esta
                -- declaracion desde [RD.30] -- no se materializa una segunda.
                round(max(o.exposicion_costo),2)::float                       AS sin_medir_costo,
                round(max(o.carga_sin_medir),2)::float                        AS carga_sin_medir,
                round(max(o.venta_sin_medir),2)::float                        AS venta_sin_medir,
                bool_and(coalesce(o.medible,false))                           AS descuadre_medible,
                max(o.motivo)                                                 AS sin_medir_motivo
           FROM analytics.mv_rd_route_identity i
           -- [RD.41] La COPIA, no la vista: medido, la vista le sumaba 297 ms a una pantalla
           -- con liston de 500 ms (130 -> 427 en una version recortada de esta misma consulta).
           LEFT JOIN analytics.mv_rd_route_opening o
             ON o.tenant_id = i.tenant_id AND o.route_no = i.route_no
           LEFT JOIN val v ON v.route_no = i.route_no
           LEFT JOIN carga_dia cd ON cd.route_no = i.route_no
           LEFT JOIN ultimo_dia uc ON uc.route_no = i.route_no AND uc.clase = 'carga'
           LEFT JOIN ultimo_dia uv ON uv.route_no = i.route_no AND uv.clase = 'venta'
           LEFT JOIN commercial.warehouses w
             ON w.id = i.warehouse_id AND w.deleted_at IS NULL
          WHERE i.tenant_id = t.id
          GROUP BY i.route_no, i.plaza, i.carga_desde
          ORDER BY i.plaza, i.route_no
`;

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);

  await knex.raw(`DROP MATERIALIZED VIEW IF EXISTS ${MAT}`);
  await knex.raw(`
    CREATE MATERIALIZED VIEW ${MAT} AS
    SELECT t.id AS tenant_id, q.*
      FROM identity.tenants t
      LEFT JOIN LATERAL (${CUERPO}) q ON true
     WHERE t.deleted_at IS NULL AND q.route_no IS NOT NULL`);

  await knex.raw(`CREATE UNIQUE INDEX mv_rd_route_inventory_pk ON ${MAT} (tenant_id, route_no)`);
  await knex.raw(`ANALYZE ${MAT}`);
  await knex.raw(`COMMENT ON MATERIALIZED VIEW ${MAT} IS
    'RD.47 - el tablero de Inventario de ruta, precomputado para el rango por DEFAULT (toda la ventana). La consulta viva costaba 414 ms de servidor para 11 filas, agregando 9,103 del ledger. Con rango explicito el servicio NO lee esto: va en vivo. Trae una COPIA del SQL del servicio, vigilada por el candado de paridad de test-newdb-rd-route-inventory.js.'`);
  await knex.raw(`GRANT SELECT ON ${MAT} TO app_runtime`);
  await knex.raw(`GRANT SELECT ON ${MAT} TO dev_ro`);

  // -- Freno 1: tiene las rutas que tiene que tener --------------------------------------
  const { rows: [res] } = await knex.raw(
    `SELECT count(*)::int AS filas, count(DISTINCT tenant_id)::int AS tenants FROM ${MAT}`);
  const { rows: [esp] } = await knex.raw(
    `SELECT count(*)::int AS n FROM analytics.mv_rd_route_identity`);
  if (Number(res.filas) !== Number(esp.n)) {
    throw new Error(`[RD.47] la copia trae ${res.filas} rutas y la identidad dice ${esp.n}: el LATERAL esta perdiendo o duplicando`);
  }
  console.log(`  . [RD.47] ${res.filas} rutas en ${res.tenants} tenant(s)`);

  // -- Freno 2: PROPOSITO. La pantalla entra en el gate -----------------------------------
  const SEL = `SELECT * FROM ${MAT} ORDER BY plaza, route_no`;
  const t0 = Date.now();
  const { rows: pant } = await knex.raw(SEL);
  const ms = Date.now() - t0;
  const { rows: plan } = await knex.raw(`EXPLAIN (ANALYZE) ${SEL}`);
  const texto = plan.map((r) => r['QUERY PLAN']).join(String.fromCharCode(10));
  const exec = /Execution Time: ([0-9.]+) ms/.exec(texto);
  console.log(`  . [RD.47] la pantalla: ${pant.length} filas . cliente ${ms} ms . servidor ${exec ? exec[1] : '?'} ms (antes 414 ms de servidor)`);
  if (ms > GATE_MS) throw new Error(`[RD.47] sigue en ${ms} ms: no alcanza el gate de ${GATE_MS} ms`);
};

/** Deshace EXACTAMENTE lo que hizo el up. */
exports.down = async function down(knex) {
  await knex.raw(`DROP MATERIALIZED VIEW IF EXISTS ${MAT}`);
};
