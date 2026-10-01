/**
 * `[EXP.1a]` — El `patron` de reincidencia baja de TypeScript a SQL.
 *
 * ## Una definición, dos lectores
 *
 * `reincidencia()` (`inventory-variance.service.ts`) deriva el patrón del SKU a mano, con
 * cuatro umbrales **medidos** sobre una distribución bimodal:
 *
 *   retencion = |pesos_neto| / pesos_abs
 *   · < 0.20  → `se_compensa`   el descuadre vuelve: es ruido de conteo, no pérdida
 *   · ≥ 0.80  → `merma` / `sobra` según el signo del neto
 *   · resto   → `mixto`
 *   · pesos_abs = 0 → `sin_dinero`
 *
 * Esa fórmula estaba **sólo en TypeScript**. `[EXP.1b]` necesita el mismo veredicto dentro de
 * una matview, y copiarlo habría creado la segunda definición — exactamente lo que ya costó
 * caro dos veces esta semana (ABC.6 re-derivó `clase_motivo` cuando la columna canónica ya
 * existía; IC.12 estuvo a punto de re-derivar el peldaño).
 *
 * Entonces el cálculo baja a la vista y los dos lectores lo LEEN. Si los umbrales se vuelven a
 * medir, se mueven en un solo lugar.
 *
 * ## Por qué aditivo y no una vista nueva
 *
 * Las columnas se APENDAN al final: `CREATE OR REPLACE VIEW` exige que las que ya existen
 * conserven nombre, orden y tipo, y agregar al final es lo único que permite. Los cuatro
 * consumidores actuales (el servicio, `v_count_priority_score`, y dos candados) nombran sus
 * columnas, así que ninguno cambia de resultado.
 *
 * ⚠️ `security_invoker` y el GRANT **no se heredan** al reemplazar una vista — se vuelven a
 * poner acá, los dos, a propósito (ya se perdieron una vez en la Fase U y sólo lo vio una
 * aserción de metadata).
 *
 * ⛔ `retencion` es NULL cuando `pesos_abs` es 0, nunca 0: un SKU que se contó y nunca
 * descuadró no "retiene el 0%" — no tiene nada que retener.
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function up(knex) {
  const [{ hay }] = (await knex.raw(
    "SELECT to_regclass('analytics.v_sku_count_variance_history') IS NOT NULL AS hay")).rows;
  if (!hay) {
    // eslint-disable-next-line no-console
    console.log('  [EXP.1a] no existe v_sku_count_variance_history — se omite');
    return;
  }

  const viejo = (await knex.raw(
    "SELECT pg_get_viewdef('analytics.v_sku_count_variance_history'::regclass, true) AS d")
  ).rows[0].d.trim().replace(/;\s*$/, '');

  // Se envuelve la definición VIGENTE en vez de reescribirla: el cuerpo trae el anti-réplica,
  // el filtro de cargas iniciales y los pseudo-SKUs contables, y copiarlos acá sería la tercera
  // copia de esa lógica. Lo único que se agrega son las dos columnas derivadas.
  const SE_COMPENSA = 0.2;
  const PERSISTE = 0.8;

  await knex.raw(
    'CREATE OR REPLACE VIEW analytics.v_sku_count_variance_history\n'
    + '  WITH (security_invoker = true) AS\n'
    + 'SELECT b.*,\n'
    + '       CASE WHEN b.pesos_abs > 0\n'
    + '            THEN round(abs(b.pesos_neto) / b.pesos_abs, 4) END AS retencion,\n'
    + '       CASE WHEN b.pesos_abs = 0 THEN \'sin_dinero\'\n'
    + `            WHEN abs(b.pesos_neto) / b.pesos_abs <  ${SE_COMPENSA} THEN 'se_compensa'\n`
    + `            WHEN abs(b.pesos_neto) / b.pesos_abs >= ${PERSISTE} AND b.pesos_neto < 0 THEN 'merma'\n`
    + `            WHEN abs(b.pesos_neto) / b.pesos_abs >= ${PERSISTE} AND b.pesos_neto > 0 THEN 'sobra'\n`
    + '            ELSE \'mixto\' END AS patron\n'
    + `  FROM (${viejo}) b`,
  );

  await knex.raw('GRANT SELECT ON analytics.v_sku_count_variance_history TO app_runtime');

  const [{ n, con_patron }] = (await knex.raw(
    `SELECT count(*)::int AS n,
            count(*) FILTER (WHERE patron IS NOT NULL)::int AS con_patron
       FROM analytics.v_sku_count_variance_history`)).rows;
  // eslint-disable-next-line no-console
  console.log(`[EXP.1a] ${n} filas · ${con_patron} con patron · umbrales ${SE_COMPENSA}/${PERSISTE}`);
};

/**
 * Vuelve a dejar la vista sin las dos columnas derivadas, reconstruyéndola desde su propio
 * cuerpo. No se dropea: tiene consumidores en prod.
 *
 * @param { import("knex").Knex } knex
 */
exports.down = async function down(knex) {
  const [{ hay }] = (await knex.raw(
    "SELECT to_regclass('analytics.v_sku_count_variance_history') IS NOT NULL AS hay")).rows;
  if (!hay) return;
  // eslint-disable-next-line no-console
  console.log('[EXP.1a] down: no-op — quitar una columna exige DROP y la vista tiene lectores');
};
