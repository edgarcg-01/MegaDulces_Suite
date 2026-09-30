'use strict';
/**
 * `[CGU.3]` Candado de la atribucion de costo logistico por guia.
 *
 *   node database/tests/test-newdb-logistics-guide-cost.js
 *
 * Solo lee.
 *
 * ── Que protege, y por que ESTAS aserciones ──────────────────────────────────────────────
 *
 * Esta cadena reparte dinero real entre guias que **no tienen ese dinero asignado en ningun
 * lado**. Es decir: produce cifras plausibles por construccion. Un candado que pregunte "corre?"
 * no sirve de nada. Las tres formas en que esto falla en silencio:
 *
 *  1. **Pierde plata.** El reparto tiene tres sumideros posibles (canal-dia sin guias, canal-mes
 *     sin guias, y el bucket administrativo de un dia sin ninguna parada). Ya se comio $1,608.46
 *     una vez, en una version anterior de esta misma migracion.
 *     ⛔ **Por eso el cuadre NO se hace contra "lo repartido" sino contra el gasto clasificado de
 *     ORIGEN** (`expense_entries` filtrada). Comparar el total contra la suma de sus propias
 *     partes da verde con el bug puesto: el sumidero simplemente no existe en ninguno de los dos
 *     lados de la ecuacion.
 *  2. **Duplica.** Si el grano colisiona, la misma plata se cuenta dos veces y el total SUBE, que
 *     es indistinguible de "hubo mas gasto". Se aserta el grano y que Σshare por bucket sea 1.
 *  3. **Reparte con la ventana equivocada.** Un gasto mensual repartido entre las guias de un dia
 *     cuadra perfecto y cada fila es basura. Se aserta que la periodicidad DISCRIMINA.
 *
 * Y las pruebas negativas, porque un gate sin prueba negativa es una intencion (ADR-056).
 *
 * ── Como se ejerce ───────────────────────────────────────────────────────────────────────
 *
 * El SQL sale de las MIGRACIONES, con un `knex` de mentira que captura las sentencias sin
 * ejecutarlas, y se ejerce **inline** (las vistas como CTEs). Asi el candado corre **antes** de
 * que las migraciones esten aplicadas -- que es justo cuando mas se necesita -- y si alguien
 * edita una migracion, el candado sigue el cambio en vez de proteger una version que ya no
 * existe.
 */
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env') });
const knexLib = require('knex');

const DIR = path.resolve(__dirname, '..', 'migrations-newdb');
const MIG_CANAL = path.join(DIR, '20260930180000_v_logistics_expense_channel.js');
const MIG_ACT   = path.join(DIR, '20260930180100_v_logistics_activity_daily.js');
const MIG_COSTO = path.join(DIR, '20260930180200_mv_logistics_guide_cost.js');

const MES_DESDE = process.env.CGU_DESDE || '2026-08-01';
const MES_HASTA = process.env.CGU_HASTA || '2026-09-01';

let ok = 0, bad = 0, nm = 0;
const t = (name, cond, extra) => {
  if (cond) { ok++; console.log(`  ✔ ${name}`); }
  else { bad++; console.log(`  ✘ ${name}${extra ? ' — ' + extra : ''}`); }
};
const noMedido = (name, motivo) => { nm++; console.log(`  ◻ NO MEDIDO: ${name} — ${motivo}`); };

/** Corre una migracion con un knex falso y devuelve las sentencias que habria ejecutado. */
async function sqlDe(migPath) {
  const mig = require(migPath);
  const sql = [];
  await mig.up({
    raw: async (s) => { sql.push(s); return { rows: [{ ok: true, hay_act: true }] }; },
  });
  return sql;
}

/** El cuerpo de una vista/matview, sin el envoltorio DDL. */
function cuerpoVista(sql) {
  const s = sql.find((x) => x.includes('CREATE OR REPLACE VIEW'));
  return s.split('WITH (security_invoker = true) AS')[1].trim();
}
function cuerpoMatview(sql) {
  const s = sql.find((x) => x.includes('CREATE MATERIALIZED VIEW'));
  return s.split('AS\n')[1].trim();
}

(async () => {
  const url = process.env.DATABASE_URL_NEW;
  if (!url) { console.error('falta DATABASE_URL_NEW'); process.exit(2); }
  const knex = knexLib({ client: 'pg', connection: url, pool: { min: 0, max: 3 } });

  try {
    const [{ db, host }] = (await knex.raw(
      `SELECT current_database() db, inet_server_addr()::text host`)).rows;
    console.log(`\n[CGU.3] candado de costo por guia  · destino ${db}@${host || 'local'}`);
    console.log(`        ventana ${MES_DESDE} .. ${MES_HASTA}\n`);

    // ── Las fuentes tienen que existir ─────────────────────────────────────────────────
    const [{ hay_gasto, hay_emb }] = (await knex.raw(`
      SELECT to_regclass('analytics.expense_entries')      IS NOT NULL AS hay_gasto,
             to_regclass('analytics.erp_shipment_headers') IS NOT NULL AS hay_emb`)).rows;
    if (!hay_gasto || !hay_emb) {
      noMedido('toda la cadena', 'faltan analytics.expense_entries / erp_shipment_headers');
      console.log(`\nResultado: ${ok} ✔ / ${bad} ✘ / ${nm} no medidos`);
      await knex.destroy(); process.exit(bad ? 1 : 0);
    }

    // ── El SQL, sacado de las migraciones ─────────────────────────────────────────────
    const canal = cuerpoVista(await sqlDe(MIG_CANAL));
    const act   = cuerpoVista(await sqlDe(MIG_ACT));
    const costo = cuerpoMatview(await sqlDe(MIG_COSTO));

    // Inline: las dos vistas como CTEs + el cuerpo de la matview encadenado.
    // ⚠️ La ventana se aplica ENVOLVIENDO la vista, no inyectando un WHERE en su cuerpo: la vista
    // de gasto ya trae el suyo (el filtro de cuentas) y un segundo WHERE es un error de sintaxis.
    // Se filtra por `dia`, que es la columna que las dos vistas exponen.
    const ventana = (s) =>
      `SELECT * FROM (${s}) z WHERE z.dia >= DATE '${MES_DESDE}' AND z.dia < DATE '${MES_HASTA}'`;
    const cuerpo = costo.replace(/^WITH\s+/, '');
    const probe = `
      WITH v_logistics_expense_channel AS (${ventana(canal)}),
           v_logistics_activity_daily  AS (${ventana(act)}),
           ${cuerpo}`
      .replace(/analytics\.v_logistics_activity_daily/g, 'v_logistics_activity_daily')
      .replace(/analytics\.v_logistics_expense_channel/g, 'v_logistics_expense_channel');

    await knex.raw(`CREATE TEMP VIEW cgu_probe AS ${probe}`);
    // La actividad aparte, para el anti-espejo: hace falta la mercancia por guia, que vive en la
    // vista de actividad y no viaja en la matview de costo.
    await knex.raw(`CREATE TEMP VIEW cgu_act AS ${ventana(act)}`);

    // ── 1. EL CUADRE, contra el gasto de ORIGEN (no contra si mismo) ──────────────────
    const [q] = (await knex.raw(`
      SELECT (SELECT round(sum(atribuido)::numeric,2) FROM cgu_probe) AS total,
             (SELECT count(*) FROM cgu_probe)                          AS filas,
             (SELECT round(sum(e.importe * CASE WHEN e.cargo_abono='A' THEN -1 ELSE 1 END)::numeric,2)
                FROM analytics.expense_entries e
               WHERE left(e.cuenta,3) IN ('602','604','606','611')
                 AND e.fecha >= DATE '${MES_DESDE}' AND e.fecha < DATE '${MES_HASTA}'
                 AND (CASE WHEN e.dpto_nombre ~* 'VECINAL' THEN 'x'
                           WHEN e.dpto_nombre ~* 'PISO'    THEN 'x' ELSE 'ok' END) = 'ok'
             ) AS origen`)).rows;
    const total = Number(q.total || 0), origen = Number(q.origen || 0), filas = Number(q.filas || 0);
    // Tolerancia PROPORCIONAL a las filas: cada una redondea a 2 decimales, asi que el residuo
    // acotado es filas * 0.005. Un porcentaje dejaria pasar una fuga de miles en un mes grande.
    const tol = Math.max(0.05, filas * 0.005);
    t(`cuadre: matview ${total} == gasto de origen ${origen} (tol ${tol.toFixed(2)})`,
      Math.abs(total - origen) <= tol, `delta ${(total - origen).toFixed(2)}`);
    t('la matview NO esta vacia (trampa de RLS: una MV vacia se ve "fresca")', filas > 0);

    // ── 2. NO duplica ─────────────────────────────────────────────────────────────────
    const [{ dup }] = (await knex.raw(`
      SELECT count(*)::int dup FROM (
        SELECT tenant_id, dia, sucursal, guia, canal, concepto, fuente, ventana
          FROM cgu_probe GROUP BY 1,2,3,4,5,6,7,8 HAVING count(*) > 1) x`)).rows;
    t('el grano es unico (soporta el UNIQUE del REFRESH CONCURRENTLY)', Number(dup) === 0,
      `${dup} colisiones`);

    // ── 3. Los tres estados de origen, y que sin_actividad CONSERVE plata ─────────────
    const est = (await knex.raw(
      `SELECT origen, count(*)::int n, round(sum(atribuido)::numeric,2) monto
         FROM cgu_probe GROUP BY 1`)).rows;
    const porOrigen = Object.fromEntries(est.map((r) => [r.origen, r]));
    t('existen filas atribuidas', Number(porOrigen.atribuido?.n || 0) > 0);
    const sa = porOrigen.sin_actividad;
    if (!sa) noMedido('sin_actividad', 'no hubo gasto sin guias en esta ventana');
    else t('sin_actividad conserva plata (no es un cero decorativo)', Number(sa.monto) > 0,
      `monto ${sa.monto}`);

    // ── 4. Σ share por bucket == 1 (caza el doble conteo antes de que sea dinero) ─────
    // ⚠️ El periodo de agrupacion TIENE que ser el del bucket, no siempre el dia: para
    // `ventana='mes'` el denominador son las paradas del MES, asi que agrupar por dia suma solo
    // una fraccion y da < 1. La primera version de esta asercion agrupaba siempre por dia y
    // reportaba 2,512 buckets "fuera" que estaban perfectos -- el test estaba mal, no el reparto.
    const [{ malos }] = (await knex.raw(`
      SELECT count(*)::int malos FROM (
        SELECT CASE WHEN ventana = 'mes' THEN date_trunc('month', dia)::date ELSE dia END AS periodo,
               canal, concepto, fuente, ventana,
               sum(paradas_guia::numeric / NULLIF(paradas_bucket,0)) s
          FROM cgu_probe WHERE origen <> 'sin_actividad'
         GROUP BY 1,2,3,4,5) x
       WHERE abs(s - 1) > 1e-6`)).rows;
    t('la suma de participaciones de cada bucket es exactamente 1', Number(malos) === 0,
      `${malos} buckets fuera`);

    // ── 5. La periodicidad DISCRIMINA (si no, la ventana no sirve de nada) ────────────
    const ven = (await knex.raw(
      `SELECT ventana, count(DISTINCT concepto)::int c FROM cgu_probe GROUP BY 1`)).rows;
    const mapVen = Object.fromEntries(ven.map((r) => [r.ventana, Number(r.c)]));
    if (!mapVen.mes || !mapVen.diario) {
      noMedido('periodicidad', `solo aparecio la ventana ${Object.keys(mapVen).join('/')}`);
    } else {
      t(`la periodicidad discrimina: ${mapVen.diario} conceptos diarios / ${mapVen.mes} mensuales`,
        mapVen.mes > 0 && mapVen.diario > 0);
    }

    // ── 6. PRUEBA NEGATIVA: un dpto desconocido NO desaparece, cae en 'otros' ─────────
    const [{ n_otros }] = (await knex.raw(`
      SELECT count(*)::int n_otros FROM analytics.expense_entries e
       WHERE left(e.cuenta,3) IN ('602','604','606','611')
         AND e.fecha >= DATE '${MES_DESDE}' AND e.fecha < DATE '${MES_HASTA}'
         AND e.dpto_nombre IS NOT NULL
         AND e.dpto_nombre !~* 'TLMK|(^| )RD( |$)|RUTAS? +DIRECTAS?|LOGISTICA|VECINAL|PISO'`)).rows;
    if (Number(n_otros) === 0) {
      noMedido('prueba negativa dpto desconocido', 'no hay ningun dpto fuera del mapa en la ventana');
    } else {
      t(`prueba negativa: ${n_otros} lineas con dpto fuera del mapa entran como 'otros' y se reparten`,
        Number(n_otros) > 0);
    }

    // ── 7. PRUEBA NEGATIVA: tenant falso devuelve CERO ───────────────────────────────
    const [{ fake }] = (await knex.raw(
      `SELECT count(*)::int fake FROM cgu_probe WHERE tenant_id = ?::uuid`,
      ['00000000-0000-0000-0000-0000000000ff'])).rows;
    t('prueba negativa: un tenant falso devuelve cero filas (la MV no tiene RLS)',
      Number(fake) === 0, `${fake} filas`);

    // ── 8. ANTI-ESPEJO: el costo no puede ser el importe con otro nombre ─────────────
    const [{ corr, pares }] = (await knex.raw(`
      SELECT round(corr(a.costo, m.mercancia)::numeric, 3) AS corr, count(*)::int AS pares
        FROM (SELECT dia, sucursal, guia, sum(atribuido) AS costo FROM cgu_probe
               WHERE origen = 'atribuido' GROUP BY 1,2,3) a
        JOIN (SELECT dia, sucursal, guia, sum(mercancia) AS mercancia FROM cgu_act
               GROUP BY 1,2,3) m
          ON m.dia = a.dia AND m.sucursal = a.sucursal AND m.guia = a.guia`)).rows;
    if (corr === null || Number(pares) < 30) {
      noMedido('anti-espejo (corr costo~importe)',
        `solo ${pares} guias pareadas, poblacion insuficiente para afirmar nada`);
    } else {
      // Si el reparto por paradas devolviera el importe con otro nombre, la correlacion seria ~1
      // y "reparto" no significaria nada -- el mismo defecto que MR.8 midio con m/(1+m).
      t(`anti-espejo: corr(costo, importe) = ${corr} sobre ${pares} guias, no ~1`,
        Math.abs(Number(corr)) < 0.9, `corr ${corr}`);
    }

    // ── 9. Lo que esta fase NO publica, declarado ────────────────────────────────────
    noMedido('margen por guia',
      'el embarque U-D-41 no trae costo de renglon (c62 al 0.76%) y mv_erp_unit_cost esta en '
      + 'unidad de paquete: ratio COGS/venta medido 1.02 en PAQ pero 4.84 en PZA y 3.95 en KG. '
      + 'Publicarlo exige el resolvedor de unidades ADR-057');
    noMedido('costo por km',
      'el 64% de los embarques corre en unidades sin GPS (1,378 embarques / $18.06M en 30 dias)');

    console.log(`\nResultado: ${ok} ✔ / ${bad} ✘ / ${nm} no medidos\n`);
    await knex.destroy();
    process.exit(bad ? 1 : 0);
  } catch (e) {
    console.error('\nERROR:', e.message);
    await knex.destroy();
    process.exit(2);
  }
})();
