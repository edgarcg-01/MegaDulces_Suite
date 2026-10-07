'use strict';
/**
 * `[RD.18]` — **La base de la comision: la venta con su procedencia, y el costo sin mezclar.**
 *
 * ── ⛔ LA HIPOTESIS CON LA QUE NACIO ESTA VISTA SE MIDIO Y QUEDO REFUTADA ────────────────────
 *
 * Se escribio para arreglar un defecto que **no existe**, y queda documentado aca para que nadie
 * lo vuelva a "arreglar".
 *
 * La sospecha era razonable por inspeccion: `analytics.v_route_sales_lines` es un `UNION ALL` de
 * tres tramos (el `.mdb` a bordo = `wincaja`, el runner de las camionetas = `push`, y la vecinal
 * del ODS = `kepler_vecinal`) **sin ninguna guarda de fecha entre ellos**, y
 * `CommercialCommissionsService` agrupaba solo por `route_code` y los **sumaba**. Como la venta
 * es a la vez la BASE de la comision y la COMPUERTA del escalon, un dia contado dos veces subiria
 * el porcentaje y el monto.
 *
 * **Medido en prod el 2026-10-07, y la respuesta es que no se cuenta dos veces:**
 *
 *     dias con DOS capturas, ultimos 120 d .......  3   (502 el 11-ago, 505 el 11-ago, 503 el 12-ago)
 *     folios compartidos entre fuentes, 200 d ....  0
 *
 * Los tres dias son el **corte de sistema**, no un duplicado: el push trae **un solo folio
 * `0000001` de $5.68** —el ticket de apertura del sistema nuevo— y Wincaja la venta real de ese
 * dia ($5,069.68 en la 502). Las dos capturas son **complementarias**: cero folios en comun.
 *
 * ⭐⭐ **Y el "arreglo" habria sido una regresion.** La primera version de estas vistas arbitraba
 * *"donde esten las dos, gana el push"*. Sobre esos tres dias eso publica **$5.68 donde hay
 * $5,075.36** y tira $5,069.68 de venta real. *Una correccion sin medir no es neutral: elige un
 * lado.* Por eso aca la venta se **SUMA**, que es lo que el motor ya hacia y estaba bien.
 *
 * Lo que si queda es la **vigilancia**: `fuentes` dice cuantas capturas alimentaron el dia, y el
 * candado `test-newdb-rd-commission-base.js` prueba a nivel **folio** que no se repiten.
 *
 * ── ⚠️ POR QUE SON DOS VISTAS Y NO UNA ──────────────────────────────────────────────────────
 *
 * Nacio como una sola vista que unia las dos piernas. **Medido contra prod, cada pierna por
 * separado es rapida y juntas no terminan:**
 *
 *     v_rd_route_daily, 14 dias ...................  6,946 ms
 *     mv_rd_route_ledger (venta), 14 dias .........     39 ms
 *     v_rd_route_unit_value (lifetime) ............  1,147 ms
 *     ledger x unit_value (la pierna del costo) ...  1,329 ms
 *     LAS DOS EN UNA VISTA, 14 dias ............... >500,000 ms  (lo mato el reaper de prod)
 *
 * El JOIN le quita al planner la posibilidad de empujar el filtro de fecha dentro de
 * `v_rd_route_daily` —que se materializa entera en cada consulta— y el costo se dispara dos
 * ordenes de magnitud. ⭐ *El agregado de dos consultas rapidas no es una consulta rapida.*
 * Se parten, y el servicio las une en memoria: ~8.5 s totales y predecibles.
 *
 * ── Lo que estas vistas agregan ──────────────────────────────────────────────────────────────
 *
 * **1. La procedencia de la venta por dia** (`fuentes_dia`), para reconocer una quincena que
 * cruza un corte de sistema sin tener que deducirlo.
 *
 * **2. El costo, con sus TRES candidatos rotulados y sin mezclar.**
 *   `cogs_ruta`     -- lo vendido valuado al costo del EMBARQUE (`U-D-41`), via
 *                      `v_rd_route_unit_value`. Es la cuenta real del camion (RD.26 / §2.2b).
 *   `cogs_erp`      -- el `c62` que el ERP escribe en la linea de venta. Mismo ERP, mismo grano:
 *                      el arbitro que pide ADR-059 regla 3.
 *   `costo_wincaja` -- el `valor_costo` del `.mdb`. ⛔ **Es el inestable**: el importer reescribe
 *                      las 357k lineas en cada corrida y Wincaja re-expresa el costo de ventas
 *                      pasadas, asi que el margen de un mes cerrado **cambia solo cada noche**
 *                      (FASE_RD §2.3). Ultimo en la precedencia, y rotulado.
 *
 * ⛔ **No se inventa una banda de concordancia.** La unica razon medida entre `cogs_ruta` y
 * `cogs_erp` es **1.1744**, de UNA ruta en UNA ventana (§2.2). `cogs_razon` se publica cruda.
 *
 * **3. ⭐ Markup y margen, dos columnas con su nombre.** El motor calculaba
 * `(subtotal / costo - 1) * 100` y lo llamaba `margen_pct`. Eso es **markup sobre costo**. El
 * numero es el correcto —`CONCENTRADO!G5` del workbook es literalmente `=E5/D5-1`, verificado en
 * el archivo— pero el nombre es una mina: "arreglarlo" a `(venta-costo)/venta` baja Canindo de
 * ~18% a ~15% y lo tumba bajo su umbral de bono de 14.5-16.5%.
 *
 * Vistas, no tablas: derive-no-copy.
 *
 * @param { import("knex").Knex } knex
 */

const V_SALES = 'analytics.v_rd_commission_sales';
const V_COGS = 'analytics.v_rd_commission_cogs';

const SQL_SALES = `
CREATE OR REPLACE VIEW ${V_SALES} WITH (security_invoker = true) AS
SELECT d.tenant_id, d.route_code, d.business_date,
       sum(d.subtotal)::numeric                                      AS subtotal,
       sum(d.venta)::numeric                                         AS venta,
       sum(d.subtotal) FILTER (WHERE d.source = 'push')              AS subtotal_push,
       sum(d.subtotal) FILTER (WHERE d.source = 'wincaja')           AS subtotal_wincaja,
       sum(d.subtotal) FILTER (WHERE d.source = 'kepler_vecinal')    AS subtotal_vecinal,
       sum(d.costo)    FILTER (WHERE d.source = 'wincaja')           AS costo_wincaja,
       count(DISTINCT d.source)::int                                 AS fuentes,
       string_agg(DISTINCT d.source, '+' ORDER BY d.source)          AS fuentes_dia,
       (count(DISTINCT d.source) > 1)                                AS dia_multifuente,
       sum(d.tickets)::int                                           AS tickets
  FROM analytics.v_rd_route_daily d
 GROUP BY 1, 2, 3
`;

const SQL_COGS = `
CREATE OR REPLACE VIEW ${V_COGS} WITH (security_invoker = true) AS
SELECT l.tenant_id, l.route_no AS route_code, l.business_date,
       sum(l.costo_erp)                                        AS cogs_erp,
       sum(l.qty * u.costo_u)                                  AS cogs_ruta,
       -- ⚠️ La suma de qty por costo_u IGNORA los SKU sin costo unitario, asi que un COGS
       -- incompleto se ve igual que uno completo y MAS CHICO -- o sea markup mas alto, o sea
       -- bono pagado. La cobertura se publica; el dato NO se suprime ni se rellena (ADR-056).
       -- (sin acentos graves en este bloque: es un template literal de JS)
       (count(*) FILTER (WHERE u.costo_u IS NULL) = 0)         AS cogs_ruta_completo,
       count(*) FILTER (WHERE u.costo_u IS NULL)::int          AS skus_sin_costo_unitario,
       count(*)::int                                           AS skus_vendidos,
       CASE WHEN sum(l.costo_erp) IS NOT NULL AND sum(l.costo_erp) <> 0
            THEN round((sum(l.qty * u.costo_u) / sum(l.costo_erp))::numeric, 4) END AS cogs_razon,
       CASE WHEN sum(l.qty * u.costo_u) IS NOT NULL AND sum(l.costo_erp) IS NOT NULL
                 THEN 'dos_fuentes'
            WHEN sum(l.qty * u.costo_u) IS NOT NULL THEN 'una_fuente_embarque'
            WHEN sum(l.costo_erp)       IS NOT NULL THEN 'una_fuente_erp'
            ELSE 'sin_costo'
       END                                                     AS costo_veredicto
  FROM analytics.mv_rd_route_ledger l
  LEFT JOIN analytics.v_rd_route_unit_value u
    ON  u.tenant_id = l.tenant_id AND u.route_no = l.route_no
    AND u.sku       = l.sku       AND u.unidad   = l.unidad
 WHERE l.clase = 'venta'
 GROUP BY 1, 2, 3
`;

exports.up = async function up(knex) {
  for (const [v, sql] of [[V_SALES, SQL_SALES], [V_COGS, SQL_COGS]]) {
    await knex.raw(sql);
    // ⚠️ `security_invoker` y el GRANT van EXPLICITOS despues de cada CREATE OR REPLACE: no se
    // heredan. ADR-057 los perdio una vez y solo lo vio la asercion de metadata del candado.
    await knex.raw(`ALTER VIEW ${v} SET (security_invoker = true)`);
    await knex.raw(`GRANT SELECT ON ${v} TO app_runtime`);
  }

  await knex.raw(`COMMENT ON VIEW ${V_SALES} IS $$[RD.18] La venta de Ruta Directa por ruta x dia,
SUMANDO sus tres capturas (wincaja / push / kepler_vecinal) -- NO se arbitra: la sospecha de doble
conteo se midio el 2026-10-07 y quedo REFUTADA (3 dias con dos capturas en 120 d, CERO folios
compartidos en 200 d; son el corte de sistema, donde el push trae el folio de apertura de $5.68 y
Wincaja la venta real). Arbitrar habria tirado $5,069.68 de venta real en la ruta 502. fuentes_dia
publica la procedencia y el candado vigila la duplicacion a nivel FOLIO. Va SEPARADA del costo
porque unirlas en una sola vista le quita al planner el empuje del filtro de fecha dentro de
v_rd_route_daily: medido, 6.9 s + 1.3 s por separado contra mas de 500 s juntas.$$`);

  await knex.raw(`COMMENT ON VIEW ${V_COGS} IS $$[RD.18] El costo de lo VENDIDO en ruta, por las
dos vias que Kepler publica y SIN mezclarlas: cogs_ruta (lo vendido valuado al costo del embarque
U-D-41 via v_rd_route_unit_value -- la cuenta real del camion) y cogs_erp (el c62 que el ERP
escribe en la propia linea de venta -- mismo ERP y mismo grano, el arbitro de ADR-059 regla 3).
cogs_razon va CRUDA: la unica razon medida es 1.1744, de UNA ruta en UNA ventana, y una banda de
concordancia escrita sin medir seria una premisa con forma de ley. cogs_ruta_completo declara si
hubo SKU vendidos sin costo unitario: su suma los ignora, asi que un COGS incompleto se ve igual
que uno completo y mas chico, que es el lado que paga bono.$$`);
};

exports.down = async function down(knex) {
  await knex.raw(`DROP VIEW IF EXISTS ${V_COGS}`);
  await knex.raw(`DROP VIEW IF EXISTS ${V_SALES}`);
};
