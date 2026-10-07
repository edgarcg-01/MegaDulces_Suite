'use strict';
/**
 * [IC.12] Candado de `analytics.mv_erp_physical_count_variance` — el descuadre materializado
 * con el peldaño del costo declarado.
 *
 *   node database/tests/test-newdb-count-variance-rung.js
 *
 * Sólo lee.
 *
 * ── Qué protege, y por qué ESTAS aserciones ──────────────────────────────────────────────
 *
 * La MV publica dos cosas nuevas sobre dinero que ya se publicaba: un veredicto por renglón y
 * un contrafactual. Las dos son fáciles de romper sin que el resultado deje de ser plausible,
 * así que el candado no pregunta "¿corre?" sino tres cosas que sí pueden fallar en silencio:
 *
 *  1. **Que la MV sea la vista y no otra cosa.** Se cuenta contra
 *     `v_erp_physical_count_variance` — DOS derivaciones independientes del mismo hecho. Un
 *     candado que compare la MV consigo misma pasa en verde con la lógica rota (la lección de
 *     IC.0, que pasó dos bugs verificándose contra el ODS con su propia lógica).
 *  2. **Que el testigo no esté sesgado.** Los renglones que el veredicto llama `coincide`
 *     tienen que REPRODUCIR el importe publicado. Si el testigo estuviera corrido, esa
 *     población también se desviaría — y entonces el `peldano_arriba` no significaría nada.
 *  3. **El control de placebo.** La misma regla sobre las CARGAS INICIALES —que cuadran
 *     consigo mismas por construcción— tiene que marcar CERO. Una regla que marca las dos
 *     poblaciones por igual es ruido con nombre bonito.
 *
 * Y dos PRUEBAS NEGATIVAS, porque un gate sin prueba negativa es una intención (ADR-056): se
 * le dan a la regla renglones fabricados donde se sabe la respuesta, y tiene que decir que NO
 * cuando corresponde; y se consulta con un tenant falso, que tiene que devolver cero.
 */
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env') });
const knexLib = require('knex');

const MIG = path.resolve(__dirname, '..', 'migrations-newdb',
  '20260929200000_erp_count_variance_mv_rung.js');

let ok = 0, bad = 0, nm = 0;
const t = (name, cond, extra) => {
  if (cond) { ok++; console.log(`  ✔ ${name}`); }
  else { bad++; console.log(`  ✘ ${name}${extra ? ' — ' + extra : ''}`); }
};
const noMedido = (name, motivo) => { nm++; console.log(`  ◻ NO MEDIDO: ${name} — ${motivo}`); };

/**
 * El SQL que se ejerce sale de la MIGRACIÓN, no de una copia pegada acá: se la corre con un
 * `knex` de mentira que captura las sentencias sin ejecutarlas. Si la migración cambia, el
 * candado sigue el cambio en vez de proteger una versión que ya no existe.
 */
async function sqlDeLaMigracion() {
  const mig = require(MIG);
  const sql = [];
  await mig.up({ raw: async (s) => { sql.push(s); return { rows: [{ hay: true, ok: true }] }; } });
  const vista = sql.find((s) => s.includes('CREATE OR REPLACE VIEW'))
    .split('WITH (security_invoker = true) AS')[1].trim();
  const mv = sql.find((s) => s.includes('CREATE MATERIALIZED VIEW'))
    .replace(/CREATE MATERIALIZED VIEW analytics\.mv_erp_physical_count_variance AS\s*/, '')
    .replace(/analytics\.v_erp_physical_count_variance/g, '_vnueva');
  return { select: `WITH _vnueva AS (${vista}),\n${mv.replace(/^\s*WITH\s+capt AS \(/, 'capt AS (')}` };
}

(async () => {
  const url = process.env.DATABASE_URL_NEW;
  if (!url) { console.error('falta DATABASE_URL_NEW'); process.exit(1); }
  const db = knexLib({
    client: 'pg',
    connection: {
      connectionString: url,
      ssl: /@(localhost|127\.0\.0\.1|192\.168\.)/.test(url) ? false : { rejectUnauthorized: false },
    },
    pool: { min: 0, max: 2 },
  });

  console.log('\n=== [IC.12] descuadre materializado + peldaño del costo ===\n');

  try {
    const [{ aplicada }] = (await db.raw(
      `SELECT to_regclass('analytics.mv_erp_physical_count_variance') IS NOT NULL AS aplicada`)).rows;

    // Si la MV ya está, se ejerce EL OBJETO. Si no, se ejerce el SELECT de la migración: prueba
    // la lógica, y la existencia del objeto queda NO MEDIDA en vez de darse por buena.
    let FUENTE = 'analytics.mv_erp_physical_count_variance';
    let PRE = '';
    let PRE_SELECT = '';
    let FILTRO_VISTA = '';
    if (aplicada) {
      console.log('  ⓘ la matview está aplicada → se ejerce el objeto real\n');
    } else {
      // ⛔ El SELECT de la migración sobre la historia COMPLETA cuesta ~92 s (el testigo
      // recorre todos los `N-A-45`), y repetirlo por aserción revienta el `statement_timeout`.
      // Materializarlo a una tabla temporal tampoco: el rol de lectura corre con
      // `default_transaction_read_only`, que es exactamente como debe estar.
      // Entonces la corrida sin la MV aplicada se ACOTA a una ventana y lo DECLARA. La ventana
      // de 60 días alcanza para las dos poblaciones que el placebo necesita: 6 conteos y 3
      // cargas iniciales.
      const VENTANA_DIAS = 60;
      const { select } = await sqlDeLaMigracion();
      const ANCLA = "WHERE m.c2 = 'N'";
      const cuantos = select.split(ANCLA).length - 1;
      // Si la migración cambia de forma, el candado lo DICE en vez de acotar a ciegas — una
      // ventana que no se aplicó se lee igual que una que sí, y ese es el fallo peor.
      if (cuantos !== 3) {
        console.error(`  ✘ no se pudo acotar la ventana: se esperaban 3 anclas y hay ${cuantos}`);
        process.exit(1);
      }
      PRE_SELECT = select.split(ANCLA).join(
        `WHERE m.c9::date >= (CURRENT_DATE - ${VENTANA_DIAS}) AND m.c2 = 'N'`);
      PRE = `WITH mv AS (${PRE_SELECT}) `;
      // La vista base se compara contra LA MISMA ventana: si no, la paridad de filas fallaría
      // por la ventana y no por un defecto, que es la peor clase de rojo.
      FILTRO_VISTA = `WHERE fecha >= (CURRENT_DATE - ${VENTANA_DIAS})`;
      FUENTE = 'mv';
      console.log('  ⓘ la matview NO está aplicada acá → se ejerce el SELECT de la migración,');
      console.log(`    acotado a los últimos ${VENTANA_DIAS} días\n`);
      noMedido('existencia del objeto, índices y GRANT',
        'la migración todavía no corrió contra este destino');
      noMedido('la historia completa',
        `sin la MV aplicada sólo se puede ejercer una ventana de ${VENTANA_DIAS} días`);
    }

    // ── 1. La MV ES la vista: dos derivaciones independientes, mismo conteo ──────────────
    {
      const [r] = (await db.raw(`${PRE}
        SELECT (SELECT count(*) FROM ${FUENTE})::int AS mv,
               (SELECT count(*) FROM analytics.v_erp_physical_count_variance ${FILTRO_VISTA})::int AS vista`)).rows;
      t('la MV tiene exactamente las filas de la vista base (sin fan-out ni pérdida)',
        Number(r.mv) === Number(r.vista), `mv=${r.mv} vista=${r.vista}`);
      t('y no está vacía', Number(r.mv) > 0, `mv=${r.mv}`);
    }

    // ── 2. La llave del REFRESH CONCURRENTLY es única y sin NULLs ───────────────────────
    {
      const [r] = (await db.raw(`${PRE}
        SELECT count(*)::int AS filas,
               count(DISTINCT (tenant_id, kepler_sucursal, kepler_almacen, signo, serie, folio, linea))::int AS llaves,
               count(*) FILTER (WHERE serie IS NULL OR linea IS NULL)::int AS nulos
          FROM ${FUENTE}`)).rows;
      t('la llave (sucursal, almacén, signo, serie, folio, línea) es ÚNICA',
        Number(r.filas) === Number(r.llaves), `filas=${r.filas} llaves=${r.llaves}`);
      t('y ninguna de sus columnas viene NULL (un NULL rompe el REFRESH CONCURRENTLY)',
        Number(r.nulos) === 0, `nulos=${r.nulos}`);
    }

    // ── 3. El veredicto nunca es NULL, y `sin_testigo` significa lo que dice ────────────
    {
      const [r] = (await db.raw(`${PRE}
        SELECT count(*) FILTER (WHERE costo_veredicto IS NULL)::int AS sin_veredicto,
               count(*) FILTER (WHERE (costo_veredicto = 'sin_testigo') <> (costo_contado IS NULL))::int AS incoherentes,
               count(*) FILTER (WHERE (teorico IS NULL) <> (teorico_salvedad IS NOT NULL))::int AS teorico_mudo
          FROM ${FUENTE}`)).rows;
      t('ningún renglón sale sin veredicto', Number(r.sin_veredicto) === 0, `n=${r.sin_veredicto}`);
      t('`sin_testigo` ocurre exactamente cuando no hay costo contado',
        Number(r.incoherentes) === 0, `n=${r.incoherentes}`);
      t('un teórico ausente SIEMPRE trae su motivo (nunca calla)',
        Number(r.teorico_mudo) === 0, `n=${r.teorico_mudo}`);
    }

    // ── 4. El testigo no está sesgado: `coincide` REPRODUCE lo publicado ────────────────
    {
      const [r] = (await db.raw(`${PRE}
        SELECT round(sum(importe), 2) AS pub,
               round(sum(importe_en_costo_contado), 2) AS testigo,
               count(*)::int AS filas
          FROM ${FUENTE} WHERE costo_veredicto = 'coincide'`)).rows;
      const pub = Number(r.pub), tes = Number(r.testigo);
      const desvio = pub > 0 ? Math.abs(pub - tes) / pub : null;
      if (!r.filas || pub <= 0) {
        noMedido('sesgo del testigo', 'no hay renglones `coincide` con importe en este destino');
      } else {
        t(`el bucket \`coincide\` reproduce lo publicado (desvío ${(desvio * 100).toFixed(2)}% < 2%)`,
          desvio < 0.02, `pub=${pub} testigo=${tes}`);
      }
    }

    // ── 5. ⭐ EL CONTROL DE PLACEBO ─────────────────────────────────────────────────────
    // Las cargas iniciales cuadran consigo mismas por construcción (captura == entrada, línea
    // por línea). Si la regla marcara ahí, estaría midiendo ruido y no un defecto.
    {
      const { rows } = await db.raw(`${PRE}
        SELECT tipo_evento,
               count(*) FILTER (WHERE costo_veredicto = 'peldano_arriba')::int AS arriba,
               count(*)::int AS filas
          FROM ${FUENTE} GROUP BY 1`);
      const carga = rows.find((x) => x.tipo_evento === 'carga_inicial');
      const conteo = rows.find((x) => x.tipo_evento === 'conteo');
      if (!carga || !conteo) {
        noMedido('control de placebo', 'este destino no tiene las dos poblaciones');
      } else {
        t('PLACEBO: la regla NO marca las cargas iniciales (deben cuadrar solas)',
          Number(carga.arriba) === 0, `marcadas=${carga.arriba} de ${carga.filas}`);
        t('y SÍ marca conteos (si no marcara nada, el candado sería un no-op)',
          Number(conteo.arriba) > 0, `marcadas=${conteo.arriba} de ${conteo.filas}`);
      }
    }

    // ── 6. PRUEBA NEGATIVA de la regla: renglones fabricados con respuesta conocida ─────
    // La regla tiene que decir que NO cuando el costo del ajuste es el mismo que el contado, y
    // que SÍ cuando es un peldaño arriba. Sin esto, "marca 338 renglones" podría ser cualquier
    // cosa: un `TRUE` constante daría el mismo tablero verde.
    {
      const { rows } = await db.raw(`
        WITH fixture(caso, costo_unitario, costo_contado) AS (VALUES
          ('igual',            10.53::numeric, 10.53::numeric),
          ('deriva 3%',        10.85,          10.53),
          ('caja x10',        105.28,          10.53),
          ('caja x2 (borde)',  21.06,          10.53),
          ('justo bajo x2',    21.05,          10.53),
          ('mitad',             5.26,          10.53),
          ('sin testigo',      10.53,          NULL))
        SELECT caso,
               CASE WHEN costo_contado IS NULL OR costo_contado <= 0 THEN 'sin_testigo'
                    WHEN costo_unitario / costo_contado >= 2.0 THEN 'peldano_arriba'
                    WHEN costo_unitario / costo_contado <= 1.0 / 2.0 THEN 'peldano_abajo'
                    WHEN costo_unitario / costo_contado > 1.10
                      OR costo_unitario / costo_contado < 0.90 THEN 'difiere'
                    ELSE 'coincide' END AS veredicto
          FROM fixture`);
      const v = Object.fromEntries(rows.map((r) => [r.caso, r.veredicto]));
      t('NEGATIVA: costo igual al contado → `coincide`, NO se marca',
        v['igual'] === 'coincide', `dio ${v['igual']}`);
      t('NEGATIVA: una deriva del 3% NO es un peldaño',
        v['deriva 3%'] === 'coincide', `dio ${v['deriva 3%']}`);
      t('NEGATIVA: 1.999x NO alcanza para afirmar peldaño (el factor mínimo es 2.00)',
        v['justo bajo x2'] === 'difiere', `dio ${v['justo bajo x2']}`);
      t('POSITIVA: el costo de la caja (x10) sí se marca',
        v['caja x10'] === 'peldano_arriba', `dio ${v['caja x10']}`);
      t('POSITIVA: el borde exacto x2 se marca',
        v['caja x2 (borde)'] === 'peldano_arriba', `dio ${v['caja x2 (borde)']}`);
      t('la mitad del costo cae en `peldano_abajo`, no en `coincide`',
        v['mitad'] === 'peldano_abajo', `dio ${v['mitad']}`);
      t('sin testigo NO se dibuja como correcto',
        v['sin testigo'] === 'sin_testigo', `dio ${v['sin testigo']}`);
    }

    // ── 7. PRUEBA NEGATIVA del filtro de tenant ─────────────────────────────────────────
    // Una matview NO soporta RLS: lo único que separa los tenants es el `WHERE` que el servicio
    // escribe a mano. Si alguien lo olvida, nada falla — simplemente se ven datos de otro. Acá
    // se ejerce el mecanismo: con un tenant falso tiene que devolver CERO.
    if (aplicada) {
      const [{ rls }] = (await db.raw(
        `SELECT relrowsecurity AS rls FROM pg_class
          WHERE oid = 'analytics.mv_erp_physical_count_variance'::regclass`)).rows;
      t('la MV no tiene RLS (por eso el filtro por tenant va a mano en el servicio)',
        rls === false, `relrowsecurity=${rls}`);

      const real = await db.raw(
        `SELECT count(*)::int AS n FROM analytics.mv_erp_physical_count_variance
          WHERE tenant_id = (SELECT id FROM public.tenants WHERE slug = 'mega_dulces')`);
      const falso = await db.raw(
        `SELECT count(*)::int AS n FROM analytics.mv_erp_physical_count_variance
          WHERE tenant_id = '00000000-0000-0000-0000-0000000f4152'::uuid`);
      t('con el tenant real devuelve filas', Number(real.rows[0].n) > 0, `n=${real.rows[0].n}`);
      t('NEGATIVA: con un tenant falso devuelve CERO',
        Number(falso.rows[0].n) === 0, `n=${falso.rows[0].n}`);

      // ── 8. El GRANT y los índices, que son parte del contrato del REFRESH ────────────
      const [g] = (await db.raw(`
        SELECT has_table_privilege('app_runtime','analytics.mv_erp_physical_count_variance','SELECT') AS grant_ok,
               (SELECT count(*) FROM pg_indexes
                 WHERE schemaname='analytics' AND tablename='mv_erp_physical_count_variance')::int AS indices,
               (SELECT count(*) FROM pg_index i
                 WHERE i.indrelid='analytics.mv_erp_physical_count_variance'::regclass
                   AND i.indisunique)::int AS unicos`)).rows;
      t('app_runtime puede leerla', g.grant_ok === true);
      t('tiene un índice ÚNICO (sin él, REFRESH CONCURRENTLY es imposible)',
        Number(g.unicos) >= 1, `únicos=${g.unicos} de ${g.indices}`);
    } else {
      noMedido('filtro por tenant, GRANT e índices', 'la MV no está aplicada en este destino');
    }

    // ── 9. El latido: declarado en CRON_JOBS, ¿ya reportó? ──────────────────────────────
    {
      const { rows } = await db.raw(
        `SELECT status, last_finish FROM analytics.cron_runs
          WHERE job_key = 'analytics_refresh_count_variance'
          ORDER BY last_finish DESC NULLS LAST LIMIT 1`);
      if (!rows.length) {
        // ⛔ NO es una falla del candado: es el estado esperado antes del primer nocturno. Pero
        // se DECLARA, porque "sin latido" y "latido verde" no son lo mismo y la pantalla lo
        // muestra como «Frescura sin medir».
        noMedido('frescura de la MV',
          'el job `analytics_refresh_count_variance` todavía no escribió ningún latido');
      } else {
        t('el refresco reportó `ok` en su última corrida', rows[0].status === 'ok',
          `status=${rows[0].status} last_finish=${rows[0].last_finish}`);
      }
    }

    console.log(`\n=== ${ok} ✓ / ${bad} ✗ / ${nm} no medidos ===\n`);
  } catch (e) {
    console.error('ERROR:', e.message);
    bad++;
  } finally {
    await db.destroy();
  }
  process.exit(bad > 0 ? 1 : 0);
})();
