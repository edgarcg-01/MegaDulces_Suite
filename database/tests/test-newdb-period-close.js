/* eslint-disable no-console */
/**
 * [VP.4.1] CANDADO — la cifra oficial de un mes, congelada (ADR-056).
 *
 * ── LO QUE ESTE TEST EXISTE PARA QUE NO VUELVA ───────────────────────────────────────────
 * Medido el 2026-09-05: grep de `period_close`/`cierre_mes`/`frozen` en 578 migraciones → **cero**.
 * No existía ninguna cifra oficial congelada: todo se recalculaba desde fuentes que se mueven hacia
 * atrás (UPSERT en `kepler_ods`, matvistas re-materializadas, literales de dedup editados). Cuando
 * el número de enero cambiaba, nadie podía decir cuánto valía antes ni por qué.
 *
 * ── LO QUE CANDADEA, Y POR QUÉ CADA UNO ──────────────────────────────────────────────────
 *  1. Sólo se cierran meses CUMPLIDOS. Congelar el mes en curso guarda una foto a medias que
 *     después "cambia" todos los días — el problema que se vino a resolver, reintroducido.
 *  2. Cerrar y verificar en seguida da `coincide`. Si no, el comparador es ruido desde el día uno.
 *  3. **Distingue las dos causas**: `difiere_definicion` (alguien editó la vista → revisar el
 *     cambio) vs `difiere_fuente` (llegó dato → probablemente correcto, re-cerrar). Sin el hash las
 *     dos se ven idénticas, y piden acciones opuestas. Es el corazón de VP.4.
 *  4. **El desglose por sucursal es carga, no adorno**: dos sucursales moviéndose al revés dejan el
 *     TOTAL idéntico. Si el testigo fuera sólo el total, eso pasaría como "coincide".
 *  5. `last_check_status IS NULL` ≠ "coincide" — nadie lo ha vuelto a mirar. Regla 3 de ADR-056
 *     aplicada al propio cierre.
 *  6. Re-cerrar LIMPIA el veredicto anterior: un `coincide` viejo hablaría de otra cifra.
 *  7. Una definición y dos consumidores: el cierre y el comparador llaman la MISMA función. Si cada
 *     uno calculara lo suyo, el comparador reportaría diferencias inventadas y nadie le creería.
 *  8. `app_runtime` no puede BORRAR un cierre: el número de enero no desaparece sin dejar rastro.
 *
 *   DATABASE_URL_NEW=… node database/tests/test-newdb-period-close.js
 */
const { Client } = require('pg');
const { esFaltaDeAcceso, noMedido } = require('./_lib/no-medido');

const URL = process.env.DATABASE_URL_NEW || process.env.DST_URL
  || 'postgresql://postgres:superoot@localhost:5433/postgres_platform';
const TEN = process.env.MEGADULCES_TENANT_ID || '00000000-0000-0000-0000-00000000d01c';
const SUP = '__test_vp4';   // superficie sintética: no toca los cierres reales

let ok = 0; let fail = 0;
const ck = (l, c, d = '') => {
  if (c) { ok++; console.log(`  ✔ ${l}`); } else { fail++; console.log(`  ✖ ${l}${d ? ` — ${d}` : ''}`); }
};

(async () => {
  const c = new Client({ connectionString: URL, ssl: /rlwy|railway|proxy/i.test(URL) ? { rejectUnauthorized: false } : false });
  await c.connect().catch((e) => {
    if (esFaltaDeAcceso(e)) noMedido(`no se pudo conectar a la base — ${e.message}`);
    throw e;
  });
  const q = async (s, p) => (await c.query(s, p)).rows;
  const uno = async (s, p) => (await q(s, p))[0];
  console.log('\n=== VP.4.1 · la cifra oficial de un mes, congelada ===\n');

  if (!(await uno(`SELECT to_regclass('analytics.period_close') IS NOT NULL AS ok`)).ok) {
    noMedido('falta la migración 20260907150000 en este destino');
  }
  ck('analytics.period_close existe', true);
  if (!(await uno(`SELECT to_regclass('analytics.v_sellout_daily') IS NOT NULL AS ok`)).ok) {
    noMedido('sin analytics.v_sellout_daily: no hay superficie que cerrar');
  }

  // Un mes CERRADO con datos. Sin él no hay nada que congelar y el test no mediría nada.
  const mes = await uno(`
    SELECT to_char(business_date,'YYYY-MM') AS m, sum(monto)::numeric(16,2) AS monto
      FROM analytics.v_sellout_daily
     WHERE tenant_id = $1
       AND to_char(business_date,'YYYY-MM') < to_char((now() AT TIME ZONE 'America/Mexico_City')::date,'YYYY-MM')
     GROUP BY 1 HAVING sum(monto) > 0 ORDER BY 1 DESC LIMIT 1`, [TEN]);
  if (!mes) noMedido('sin meses cerrados con venta en analytics.v_sellout_daily');
  console.log(`  ⓘ mes de prueba: ${mes.m} · $${mes.monto}\n`);

  try {
    await c.query(`DELETE FROM analytics.period_close WHERE superficie=$1`, [SUP]);

    // ── 1. Sólo meses cumplidos ──────────────────────────────────────────────────────────
    console.log('1 · SÓLO SE CIERRAN MESES CUMPLIDOS');
    const enCurso = (await uno(`SELECT to_char((now() AT TIME ZONE 'America/Mexico_City')::date,'YYYY-MM') AS m`)).m;
    let rechazo = false;
    try { await q(`SELECT analytics.cerrar_periodo($1,$2,$3)`, [TEN, 'sell_out', enCurso]); }
    catch { rechazo = true; }
    ck('cerrar el mes EN CURSO se rechaza (sería una foto a medias que cambia a diario)', rechazo);

    let sup = false;
    try { await q(`SELECT analytics.cerrar_periodo($1,$2,$3)`, [TEN, 'superficie_inexistente', mes.m]); }
    catch { sup = true; }
    ck('cerrar una superficie sin definición de cifra se rechaza', sup);

    // ── 2. Cerrar y verificar ────────────────────────────────────────────────────────────
    console.log('\n2 · CERRAR Y VERIFICAR');
    await q(`SELECT set_config('app.actor', 'candado:vp4', false)`);
    await q(`SELECT analytics.cerrar_periodo($1,$2,$3)`, [TEN, 'sell_out', mes.m]);
    // Se copia a la superficie sintética para no ensuciar los cierres reales de 'sell_out'.
    await q(`UPDATE analytics.period_close SET superficie=$1 WHERE superficie='sell_out' AND periodo=$2 AND tenant_id=$3`,
      [SUP, mes.m, TEN]);
    const r0 = await uno(`SELECT * FROM analytics.period_close WHERE superficie=$1 AND periodo=$2`, [SUP, mes.m]);
    ck('el cierre queda guardado', !!r0);
    ck('la cifra coincide con la vista', Number(r0.cifra.monto) === Number(mes.monto),
      `cierre=${r0.cifra.monto} vista=${mes.monto}`);
    ck('guarda el desglose POR SUCURSAL, no sólo el total',
      Object.keys(r0.cifra.por_sucursal || {}).length > 0,
      JSON.stringify(Object.keys(r0.cifra.por_sucursal || {})));
    ck('guarda el hash de la definición vigente', !!r0.definicion_hash && r0.definicion_hash.length === 32);
    ck('guarda los watermarks de las fuentes', typeof r0.watermarks === 'object');
    ck('registra quién cerró (app.actor)', r0.closed_by === 'candado:vp4', r0.closed_by);
    ck('recién cerrado, last_check_status es NULL — nadie lo ha vuelto a mirar (≠ "coincide")',
      r0.last_check_status === null);

    const v1 = (await uno(`SELECT analytics.verificar_periodo($1,$2,$3) AS r`, [TEN, SUP, mes.m])).r;
    ck('verificar en seguida da COINCIDE (si no, el comparador es ruido desde el día uno)',
      v1.estado === 'coincide', JSON.stringify(v1.estado));
    const r1 = await uno(`SELECT * FROM analytics.period_close WHERE superficie=$1 AND periodo=$2`, [SUP, mes.m]);
    ck('el veredicto queda escrito en la fila', r1.last_check_status === 'coincide' && !!r1.last_check_at);

    // ── 3. Las dos causas, distinguidas ──────────────────────────────────────────────────
    console.log('\n3 · DISTINGUE LAS DOS CAUSAS (el corazón de VP.4)');
    // (a) misma definición, otra cifra → se movió la FUENTE.
    await q(`UPDATE analytics.period_close
                SET cifra = jsonb_set(cifra,'{monto}', to_jsonb((cifra->>'monto')::numeric - 1000))
              WHERE superficie=$1 AND periodo=$2`, [SUP, mes.m]);
    const v2 = (await uno(`SELECT analytics.verificar_periodo($1,$2,$3) AS r`, [TEN, SUP, mes.m])).r;
    ck('cifra distinta con la MISMA definición → difiere_fuente', v2.estado === 'difiere_fuente', v2.estado);
    ck('el delta se calcula y se guarda', Math.abs(Number(v2.diff.delta_monto) - 1000) < 0.01,
      `delta=${v2.diff && v2.diff.delta_monto}`);
    ck('el diff trae los watermarks de ANTES y de AHORA (para saber cuál fuente avanzó)',
      !!v2.diff.watermarks_al_cerrar && !!v2.diff.watermarks_hoy);

    // (b) además cambió el hash → alguien editó la VISTA.
    await q(`UPDATE analytics.period_close SET definicion_hash='00000000000000000000000000000000'
              WHERE superficie=$1 AND periodo=$2`, [SUP, mes.m]);
    const v3 = (await uno(`SELECT analytics.verificar_periodo($1,$2,$3) AS r`, [TEN, SUP, mes.m])).r;
    ck('cifra distinta Y hash distinto → difiere_definicion (revisar el cambio, no el ERP)',
      v3.estado === 'difiere_definicion', v3.estado);
    ck('el diff conserva la definición de ambos momentos',
      !!v3.diff.definicion_al_cerrar && !!v3.diff.definicion_hoy);

    // ── 4. El desglose por sucursal es CARGA ─────────────────────────────────────────────
    console.log('\n4 · EL DESGLOSE ATRAPA LOS ERRORES QUE SE COMPENSAN');
    await q(`SELECT analytics.cerrar_periodo($1,'sell_out',$2)`, [TEN, mes.m]);
    await q(`DELETE FROM analytics.period_close WHERE superficie=$1 AND periodo=$2`, [SUP, mes.m]);
    await q(`UPDATE analytics.period_close SET superficie=$1 WHERE superficie='sell_out' AND periodo=$2 AND tenant_id=$3`,
      [SUP, mes.m, TEN]);
    const base = await uno(`SELECT cifra FROM analytics.period_close WHERE superficie=$1 AND periodo=$2`, [SUP, mes.m]);
    // La pierna de RUTAS numeradas viene con `source_branch = ''` (la vista le hace COALESCE para
    // que el índice único del rollup no lleve NULLs), así que el desglose trae una clave vacía. Es
    // fiel al dato y aquí estorba: el path de jsonb_set no admite un segmento vacío.
    const sucs = Object.keys(base.cifra.por_sucursal).filter((s) => s !== '');
    if (sucs.length < 2) {
      console.log('  ⓘ sólo una sucursal con venta en el mes — el caso compensado no se puede armar acá');
    } else {
      // Dos sucursales moviéndose al revés: el TOTAL queda idéntico al centavo.
      const [a, b] = sucs;
      const pa = Number(base.cifra.por_sucursal[a].monto);
      const pb = Number(base.cifra.por_sucursal[b].monto);
      await q(`UPDATE analytics.period_close SET cifra =
                 jsonb_set(jsonb_set(cifra,'{por_sucursal,${a},monto}', to_jsonb(${pa + 500}::numeric)),
                           '{por_sucursal,${b},monto}', to_jsonb(${pb - 500}::numeric))
               WHERE superficie=$1 AND periodo=$2`, [SUP, mes.m]);
      const tras = await uno(`SELECT cifra FROM analytics.period_close WHERE superficie=$1 AND periodo=$2`, [SUP, mes.m]);
      ck('el TOTAL quedó idéntico (el caso está bien armado)',
        Number(tras.cifra.monto) === Number(base.cifra.monto),
        `${base.cifra.monto} vs ${tras.cifra.monto}`);
      const v4 = (await uno(`SELECT analytics.verificar_periodo($1,$2,$3) AS r`, [TEN, SUP, mes.m])).r;
      ck('⭐ con el total idéntico, el desglose por sucursal IGUAL lo detecta',
        v4.estado !== 'coincide',
        'si el testigo fuera sólo el total, esto pasaría como "coincide"');
      ck('y el delta del total es cero (confirma que sólo lo salvó el desglose)',
        Math.abs(Number(v4.diff.delta_monto)) < 0.01, `delta=${v4.diff && v4.diff.delta_monto}`);
    }

    // ── 5. Re-cerrar limpia el veredicto viejo ───────────────────────────────────────────
    console.log('\n5 · RE-CERRAR');
    await q(`SELECT analytics.cerrar_periodo($1,'sell_out',$2)`, [TEN, mes.m]);
    await q(`DELETE FROM analytics.period_close WHERE superficie=$1 AND periodo=$2`, [SUP, mes.m]);
    await q(`UPDATE analytics.period_close SET superficie=$1 WHERE superficie='sell_out' AND periodo=$2 AND tenant_id=$3`,
      [SUP, mes.m, TEN]);
    const r5 = await uno(`SELECT * FROM analytics.period_close WHERE superficie=$1 AND periodo=$2`, [SUP, mes.m]);
    ck('re-cerrar LIMPIA el veredicto anterior (un "coincide" viejo hablaría de otra cifra)',
      r5.last_check_status === null && r5.last_check_diff === null);
    ck('y la cifra vuelve a cuadrar con la vista', Number(r5.cifra.monto) === Number(mes.monto));

    // ── 6. Una definición, dos consumidores ──────────────────────────────────────────────
    console.log('\n6 · UNA DEFINICIÓN, DOS CONSUMIDORES');
    const src = (await uno(`SELECT prosrc FROM pg_proc WHERE proname='cerrar_periodo'`)).prosrc;
    const src2 = (await uno(`SELECT prosrc FROM pg_proc WHERE proname='verificar_periodo'`)).prosrc;
    ck('el cierre y el comparador llaman la MISMA función de cifra',
      /sellout_period_snapshot/.test(src) && /sellout_period_snapshot/.test(src2),
      'si cada uno calculara lo suyo, el comparador reportaría diferencias inventadas');
  } finally {
    await c.query(`DELETE FROM analytics.period_close WHERE superficie=$1`, [SUP]).catch(() => {});
    await c.query(`SELECT set_config('app.actor','',false)`).catch(() => {});
  }

  // ── 7. No se puede borrar un cierre ─────────────────────────────────────────────────────
  console.log('\n7 · UN CIERRE NO DESAPARECE');
  const g = (await q(`SELECT privilege_type FROM information_schema.table_privileges
     WHERE table_schema='analytics' AND table_name='period_close' AND grantee='app_runtime'`))
    .map((r) => r.privilege_type).sort();
  ck('app_runtime puede INSERT/SELECT/UPDATE pero NO DELETE', g.join(',') === 'INSERT,SELECT,UPDATE', g.join(','));

  await c.end();
  console.log(`\n  ${ok} OK · ${fail} falla(s)\n`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
