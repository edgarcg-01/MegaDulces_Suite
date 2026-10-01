'use strict';
/**
 * `[PR.X3]` — **El umbral de equilibrio y la demanda perdida.**
 *
 * ── ⭐⭐ 1 · La respuesta a la elasticidad es darle la vuelta a la pregunta ───────────────
 * No hay elasticidad usable -región Anderson-Rubin de **[−1.415, −0.045]**, factor 31× de ancho-
 * y `DESIGN.md` prohíbe inventar la curva. Pero la decisión **no necesita** la elasticidad.
 *
 * En vez de predecir cuánto cae el volumen, se calcula **cuánto tendría que caer para que el
 * cambio salga mal**:
 *
 *     q_nuevo × (P_nuevo − C)  >=  q_viejo × (P_viejo − C)
 *     caida_tolerable = 1 − (P_viejo − C) / (P_nuevo − C)
 *
 * > *"A este precio tendrías que perder más del **X %** del volumen para quedar peor que como
 * > estás."* Eso es **aritmética**, no predicción. Y convierte un hueco en un instrumento: la
 * decisión ya no pide acertar la elasticidad, pide saber si el efecto real es mayor o menor que
 * ese umbral.
 *
 * ⛔ Casos que devuelven NULL en vez de un número, cada uno por su razón:
 * · `P_nuevo <= C` — se vendería **bajo costo**: no hay volumen que lo arregle.
 * · `P_viejo <= C` — ya se vende bajo costo: el punto de partida no es comparable.
 * · falta el costo — **38.2 %** de las celdas no lo tienen, y un umbral sin costo es un invento.
 *
 * ⭐ Cuando el precio **baja**, el número sale **negativo**: no es una caída tolerable, es el
 * volumen que hay que **ganar**. La función lo devuelve con su signo y quien la lee lo rotula.
 *
 * Es IMMUTABLE y se prueba **aislada con valores elegidos**, sin datos ni ambiente — igual que
 * las tres de `v_price_psychology`.
 *
 * ── 2 · La demanda perdida, con su fecha de caducidad ────────────────────────────────────
 * `wincaja.v_lost_demand` trae **32,252** registros de venta que no se pudo surtir,
 * **$47,069,169** entre enero y septiembre. Es lo más cercano que existe a presión competitiva.
 *
 * ⛔ **Lo que NO es**, y va escrito: registra *cuánto* se perdió valuado a **nuestro** precio.
 * **No trae el precio del competidor** — esa fuente no existe (F1 refutada: PROFECO cubre 0 %).
 *
 * ⛔⛔ **Y lo que casi se publica mal.** Los datos **se cortan exactamente el día en que cada
 * plaza migró a Kepler**, porque quien los registraba era Wincaja. Medido, sin una sola excepción:
 *
 * ```
 *   MD-10 → sucursal 01 : último 25-jun   corte 27-jun   ⇒ 3 MESES de atraso
 *   MD-50 → sucursal 06 : último 13-ago   corte 15-ago
 *   07    → sucursal 07 : último 06-sep   corte 08-sep
 *   08    → sucursal 08 : último 17-sep   corte 19-sep
 * ```
 *
 * Publicar "$47 M perdidos" al lado de una decisión de precio de hoy insinuaría que es actual.
 * Por eso cada fila lleva `ultimo_dato` y `dias_de_atraso`, y la pantalla lo declara.
 *
 * ⚠️ Y el hallazgo operativo que esto destapa: **desde que las plazas migraron, nadie registra
 * la demanda perdida.** El módulo que la reemplaza (`commercial.floor_stockouts`) tiene **13
 * filas en 2 plazas**. Se perdió una señal de $47 M al año.
 *
 * ⚠️ El **35 %** del importe ($16.4 M) es `MD-00` -el CEDIS- que no tiene sucursal de Kepler y
 * por eso **no se puede atribuir a ninguna celda** del motor. Queda fuera, declarado.
 *
 * @param { import("knex").Knex } knex
 */

const FN = 'analytics.fn_umbral_equilibrio';
const VIEW = 'analytics.v_sku_lost_demand';

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);

  // ── 1 · El umbral de equilibrio ─────────────────────────────────────────────────────
  await knex.raw(`
    CREATE OR REPLACE FUNCTION ${FN}(
      precio_actual numeric, costo numeric, precio_nuevo numeric
    ) RETURNS numeric LANGUAGE sql IMMUTABLE AS $func$
      SELECT CASE
        -- Sin costo no hay umbral. El 38.2% de las celdas esta asi, y un numero inventado
        -- ahi seria peor que la ausencia.
        WHEN costo IS NULL OR costo <= 0                       THEN NULL
        WHEN precio_actual IS NULL OR precio_actual <= costo   THEN NULL
        WHEN precio_nuevo  IS NULL OR precio_nuevo  <= costo   THEN NULL
        -- 1 - (P_viejo - C)/(P_nuevo - C). Positivo = caida tolerable. Negativo = volumen
        -- que hay que GANAR (el precio bajo).
        ELSE round((100.0 * (1.0 - (precio_actual - costo) / (precio_nuevo - costo)))::numeric, 2)
      END
    $func$
  `);

  await knex.raw(`COMMENT ON FUNCTION ${FN}(numeric, numeric, numeric) IS
    $c$[PR.X3] El UMBRAL DE EQUILIBRIO: cuanto volumen se puede perder antes de que un cambio de
    precio deje al negocio peor que como estaba. Es la respuesta a que NO existe elasticidad
    usable -region Anderson-Rubin de [-1.415, -0.045], factor 31x de ancho- sin inventar la curva
    que DESIGN.md prohibe. En vez de predecir cuanto cae el volumen, dice cuanto TENDRIA que caer.
    Sale de q_nuevo x (P_nuevo - C) >= q_viejo x (P_viejo - C).
    Devuelve NULL -no un cero- cuando el precio nuevo o el actual quedan bajo el costo, o cuando
    falta el costo (38.2% de las celdas). Negativo significa que el precio BAJO y lo que devuelve
    es el volumen que hay que GANAR, no el que se puede perder.$c$`);

  // ── 2 · La demanda perdida ──────────────────────────────────────────────────────────
  const [{ hay }] = (await knex.raw(
    `SELECT to_regclass('wincaja.v_lost_demand') IS NOT NULL AS hay`)).rows;
  if (!hay) throw new Error('[PR.X3] falta wincaja.v_lost_demand');

  await knex.raw(`DROP VIEW IF EXISTS ${VIEW}`);
  await knex.raw(`
    CREATE VIEW ${VIEW}
      WITH (security_invoker = true) AS
    WITH corte AS (
      -- ⛔ El resolvedor CANONICO del corte Wincaja->Kepler. Vivio copiado en 3 lugares y
      --    divergio; no se vuelve a escribir como literal.
      SELECT warehouse_code, kepler_code, cutover_date
        FROM analytics.v_branch_erp_cutover
       WHERE kepler_code IS NOT NULL
    ),
    agg AS (
      SELECT l.tenant_id,
             co.kepler_code                                   AS sucursal,
             l.sku,
             date_trunc('month', l.business_date)::date       AS mes,
             round(sum(l.qty_faltante)::numeric, 3)           AS unidades_perdidas,
             round(sum(l.importe_perdido)::numeric, 2)        AS importe_perdido,
             count(*)::int                                    AS reportes,
             count(DISTINCT l.cliente)::int                   AS clientes,
             max(l.business_date)                             AS ultimo_dato,
             max(co.cutover_date)                             AS corte_a_kepler
        FROM wincaja.v_lost_demand l
        JOIN corte co ON co.warehouse_code = l.warehouse_code
       GROUP BY 1, 2, 3, 4
    )
    SELECT a.*,
           /**
            * ⭐ LA FECHA DE CADUCIDAD, en la fila. Wincaja dejo de registrar faltantes el dia
            *    que la plaza paso a Kepler; sin esto, "$47M perdidos" se leeria como actual.
            */
           (CURRENT_DATE - a.ultimo_dato)::int                AS dias_de_atraso,
           (a.corte_a_kepler IS NOT NULL
            AND a.corte_a_kepler > '-infinity'::date)         AS plaza_migrada,
           CASE
             WHEN (CURRENT_DATE - a.ultimo_dato) > 45
               THEN 'esta plaza paso a Kepler y Wincaja dejo de registrar faltantes: el dato se detiene ahi, no es que hayan dejado de faltar productos'
           END                                                AS motivo_atraso
    FROM agg a
  `);

  await knex.raw(`GRANT SELECT ON ${VIEW} TO app_runtime`);

  await knex.raw(`COMMENT ON VIEW ${VIEW} IS
    $c$[PR.X3] La demanda que NO se pudo surtir, por (sucursal, sku, mes), desde
    wincaja.v_lost_demand -- 32,252 registros, $47,069,169 entre enero y septiembre de 2026.
    Es lo mas cercano que existe a presion competitiva.
    ⛔ Lo que NO es: registra cuanto se perdio valuado a NUESTRO precio. NO trae el precio del
    competidor; esa fuente no existe (F1 refutada, PROFECO cubre 0% del catalogo).
    ⛔⛔ Y se corta exactamente el dia en que cada plaza migro a Kepler, porque quien registraba
    era Wincaja: MD-10 -> sucursal 01 termina el 25-jun con corte el 27-jun, o sea TRES MESES de
    atraso. Por eso cada fila lleva ultimo_dato, dias_de_atraso y su motivo: publicar el importe
    sin eso insinuaria que es actual.
    ⚠️ El 35% del importe ($16.4M) es MD-00, el CEDIS, que no tiene sucursal de Kepler y queda
    fuera -- no se puede atribuir a ninguna celda del motor.
    ⚠️ Hallazgo operativo: desde la migracion NADIE registra la demanda perdida. El modulo que la
    reemplaza, commercial.floor_stockouts, tiene 13 filas en 2 plazas.$c$`);

  // ── Compuertas ──────────────────────────────────────────────────────────────────────
  /**
   * ⭐ La funcion se prueba AISLADA con valores elegidos, sin datos ni ambiente. Es lo que
   *    hace que un error de signo o un divisor mal puesto se vea en la migracion y no seis
   *    semanas despues en una decision de precio.
   */
  const CASOS = [
    // [precio_actual, costo, precio_nuevo, esperado, por que]
    [100, 80, 110, 33.33, 'sube 10%: el margen unitario pasa de 20 a 30, se tolera perder 1/3'],
    [100, 80, 120, 50.00, 'sube 20%: margen 20 -> 40, se tolera perder la mitad'],
    [100, 80, 90, -100.00, 'BAJA 10%: margen 20 -> 10, hay que DUPLICAR el volumen'],
    [100, 90, 101, 9.09, 'margen flaco: un alza de 1% ya tolera 9% de caida'],
    [100, 80, 80, null, 'el precio nuevo queda EN el costo: no hay volumen que lo arregle'],
    [100, 80, 70, null, 'el precio nuevo queda BAJO el costo'],
    [100, 120, 130, null, 'ya se vende bajo costo: el punto de partida no es comparable'],
    [100, null, 110, null, 'sin costo no hay umbral, y un numero inventado seria peor'],
    [100, 0, 110, null, 'costo cero no es un costo'],
  ];
  let malos = 0;
  for (const [pa, co, pn, esp, por] of CASOS) {
    const [{ r }] = (await knex.raw(`SELECT ${FN}(?::numeric, ?::numeric, ?::numeric) AS r`,
      [pa, co, pn])).rows;
    const ok = esp === null ? r === null : (r !== null && Math.abs(Number(r) - esp) < 0.01);
    if (!ok) {
      malos += 1;
      // eslint-disable-next-line no-console
      console.log(`  ⛔ [PR.X3] umbral(${pa}, ${co}, ${pn}) = ${r} y se esperaba ${esp} — ${por}`);
    }
  }
  if (malos > 0) throw new Error(`[PR.X3] ${malos} de ${CASOS.length} casos del umbral fallan.`);

  const [g] = (await knex.raw(`
    SELECT count(*)::int filas, count(DISTINCT sucursal)::int plazas,
           count(DISTINCT sku)::int skus,
           round(sum(importe_perdido)::numeric, 0) importe,
           max(dias_de_atraso)::int atraso_max,
           min(dias_de_atraso)::int atraso_min,
           count(*) FILTER (WHERE dias_de_atraso > 45 AND motivo_atraso IS NULL)::int mudas
      FROM ${VIEW}`)).rows;

  // eslint-disable-next-line no-console
  console.log(`  · [PR.X3] umbral de equilibrio: ${CASOS.length}/${CASOS.length} casos · `
    + `demanda perdida ${g.filas.toLocaleString()} filas · ${g.plazas} plazas · `
    + `${g.skus.toLocaleString()} SKUs · $${Number(g.importe).toLocaleString()} · `
    + `atraso ${g.atraso_min}-${g.atraso_max} dias`);

  if (g.mudas > 0) throw new Error(`[PR.X3] ${g.mudas} filas con atraso y sin motivo.`);
  if (g.filas === 0) throw new Error('[PR.X3] la demanda perdida quedo vacia: el puente no pego.');
  /**
   * ⛔ El atraso TIENE que existir. Si diera cero, el corte a Kepler no se estaria reflejando y
   *    la pantalla publicaria como actual un dato que se detuvo hace meses.
   */
  if (g.atraso_max < 30) {
    throw new Error(`[PR.X3] el atraso maximo es de ${g.atraso_max} dias: el corte a Kepler no `
      + 'se esta reflejando y el dato se publicaria como si fuera de hoy.');
  }
};

exports.down = async function down(knex) {
  await knex.raw(`DROP VIEW IF EXISTS ${VIEW}`);
  await knex.raw(`DROP FUNCTION IF EXISTS ${FN}(numeric, numeric, numeric)`);
};
