/**
 * `[AB.37]` EL SELL-OUT CUENTA CADA VENTA DE RUTA UNA SOLA VEZ — SÓLO LECTURA.
 *
 * `v_sellout_daily` sumaba las rutas dos veces (el tramo de `sales_daily`, que ya las trae al doble, y
 * el envío de Canindo). La migración `20261026104753_sellout_rutas_sin_doble_conteo.js` deja las rutas
 * = el envío de cada camioneta (`route_push_lines`). Esta prueba toma el SQL EXACTO del archivo (`up`
 * y `down`) y lo ejecuta como subconsulta, así que corre antes y después de aplicarla:
 *
 *   1. Con el `up`: por almacén RUTA-% × mes, el sell-out = el envío al peso (±$1), desde el corte de
 *      su plaza (Padre Hidalgo 1-jul, Canindo 13-ago; antes manda Wincaja y no se compara). Las filas
 *      de Wincaja (p. ej. Ruta 322) no son envío y quedan fuera.
 *   2. Con el `up`: la venta que NO es de ruta es idéntica a la vista viva (últimos 14 días cerrados).
 *   3. CONTROL NEGATIVO: con el `down` (la definición vieja) la comprobación 1 FALLA — si no fallara,
 *      la prueba no sabría ver el doble conteo.
 *   4. Si la migración ya está aplicada, la vista viva cumple la 1. Si no: NO MEDIDO.
 * Sin envío en la base: NO MEDIDO, nunca ✔.
 *
 * Uso: node database/tests/test-newdb-sellout-rutas-una-vez.js
 */
const path = require('path');
try { require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env'), quiet: true }); } catch { /* opcional */ }

const T = '00000000-0000-0000-0000-00000000d01c';
const MIG = path.join(__dirname, '..', 'migrations-newdb', '20261026104753_sellout_rutas_sin_doble_conteo.js');
let pass = 0, fail = 0, nm = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m); } };
const noMedido = (m) => { nm++; console.log('  ·  NO MEDIDO —', m); };

/** El SELECT que `up`/`down` mandarían, capturado con un doble que sólo anota (no ejecuta nada). */
async function selectDe(fn) {
  const sqls = [];
  await fn({ raw: async (s) => { sqls.push(s); return { rows: [] }; } });
  const v = sqls.find((s) => /CREATE OR REPLACE VIEW analytics\.v_sellout_daily AS/.test(s));
  if (!v) throw new Error('la migración ya no crea analytics.v_sellout_daily');
  return v.replace(/^CREATE OR REPLACE VIEW analytics\.v_sellout_daily AS\s*/, '');
}

const DESDE = `CASE WHEN warehouse_code ~ '^RUTA-50[0-9]$' THEN DATE '2026-08-13' ELSE DATE '2026-07-01' END`;
const HOY = `(now() AT TIME ZONE 'America/Mexico_City')::date`;

/** Por almacén RUTA-% × mes: sell-out (de `src`) contra el envío. Devuelve los pares que difieren. */
async function rutasContraEnvio(trx, src) {
  const r = (await trx.raw(`
    WITH so AS (SELECT warehouse_code wc, to_char(business_date, 'YYYY-MM') mes, sum(monto) v
                  FROM (${src}) s
                 WHERE tenant_id = :t AND warehouse_code ~~ 'RUTA-%' AND source <> 'wincaja' AND business_date >= DATE '2026-07-01'
                   AND business_date >= ${DESDE} AND business_date < ${HOY}
                 GROUP BY 1, 2),
         env AS (SELECT w.code wc, to_char(rpl.business_date, 'YYYY-MM') mes, sum(rpl.importe) v
                   FROM analytics.route_push_lines rpl
                   JOIN commercial.warehouses w ON w.tenant_id = rpl.tenant_id AND w.deleted_at IS NULL AND w.code = 'RUTA-' || rpl.route_no
                   JOIN catalog.products p ON p.tenant_id = rpl.tenant_id AND btrim(p.sku::text) = btrim(rpl.sku) AND p.deleted_at IS NULL
                  WHERE rpl.tenant_id = :t AND rpl.business_date >= CASE WHEN rpl.route_no ~ '^50[0-9]$' THEN DATE '2026-08-13' ELSE DATE '2026-07-01' END
                    AND rpl.business_date < ${HOY}
                  GROUP BY 1, 2)
    SELECT COALESCE(so.wc, env.wc) wc, COALESCE(so.mes, env.mes) mes, round(so.v, 2) sellout, round(env.v, 2) envio
      FROM so FULL JOIN env ON env.wc = so.wc AND env.mes = so.mes
     ORDER BY 1, 2`, { t: T })).rows;
  return { pares: r.length, malos: r.filter((x) => Math.abs(Number(x.sellout || 0) - Number(x.envio || 0)) > 1) };
}

let knex;
(async () => {
  knex = require('knex')(require(path.join(__dirname, '..', 'knexfile-newdb.js')).development);
  const mig = require(MIG);
  const [up, down] = [await selectDe(mig.up), await selectDe(mig.down)];
  await knex.transaction(async (trx) => {
    await trx.raw('SET TRANSACTION READ ONLY');
    await trx.raw('SET LOCAL statement_timeout = 600000');
    await trx.raw("SELECT set_config('app.tenant_id', ?, true)", [T]);
    console.log('  base', (await trx.raw('SELECT system_identifier::text s FROM pg_control_system()')).rows[0].s);

    const hay = (await trx.raw(`SELECT count(*)::int n FROM analytics.route_push_lines WHERE tenant_id = :t AND business_date >= DATE '2026-07-01'`, { t: T })).rows[0].n;
    if (!hay) { noMedido('la base no tiene envío de camionetas desde el 1-jul'); return; }

    console.log('\n  1 · con la definición nueva, rutas = envío');
    const nueva = await rutasContraEnvio(trx, up);
    ok(nueva.pares > 0 && nueva.malos.length === 0, `${nueva.pares} pares almacén×mes; difieren ${nueva.malos.length}`);
    for (const m of nueva.malos.slice(0, 8)) console.log('     ', m);

    console.log('\n  2 · lo que no es de ruta no se mueve (14 días cerrados)');
    const fuera = async (src) => (await trx.raw(`SELECT round(sum(monto), 2) v, round(sum(units), 3) u, count(*)::int n FROM (${src}) s
      WHERE tenant_id = :t AND warehouse_code !~~ 'RUTA-%' AND business_date >= current_date - 14 AND business_date < current_date`, { t: T })).rows[0];
    const [viva, conUp] = [await fuera('SELECT * FROM analytics.v_sellout_daily'), await fuera(up)];
    if (!viva.n) noMedido('sin venta de sucursales en 14 días');
    else ok(viva.v === conUp.v && viva.u === conUp.u && viva.n === conUp.n, `viva $${viva.v} (${viva.n} filas) = nueva $${conUp.v} (${conUp.n} filas)`);

    console.log('\n  3 · control negativo: la definición vieja SÍ falla');
    const vieja = await rutasContraEnvio(trx, down);
    ok(vieja.malos.length > 0, `con el down difieren ${vieja.malos.length} de ${vieja.pares} pares (debe ser > 0)`);

    console.log('\n  4 · la vista viva');
    const aplicada = (await trx.raw(`SELECT coalesce(obj_description('analytics.v_sellout_daily'::regclass), '') ~ 'AB\\.37' a`)).rows[0].a;
    if (!aplicada) noMedido('la migración 20261026104753 no está aplicada en esta base');
    else {
      const v = await rutasContraEnvio(trx, 'SELECT * FROM analytics.v_sellout_daily');
      ok(v.malos.length === 0, `vista viva: ${v.pares} pares; difieren ${v.malos.length}`);
    }
  });
})().catch((e) => { fail++; console.log('  ✗ error:', e.message); })
  .finally(async () => {
    if (knex) await knex.destroy();
    console.log(`\n  ${pass} ✓ · ${fail} ✗ · ${nm} no medido`);
    process.exit(fail ? 1 : (pass ? 0 : 2));
  });
