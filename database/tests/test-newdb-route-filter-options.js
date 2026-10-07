/* eslint-disable no-console */
/**
 * [AUD-DAT.17] CANDADO del catálogo de los combos de `/dashboard/ventas-detalle`.
 *
 * ⚠️ ESTE ARCHIVO EXISTE PORQUE SU AUSENCIA ERA UNA MENTIRA PUBLICADA. La migración
 * `20260929170000_mv_route_filter_options.js` afirmaba —en su cabecera **y en el `COMMENT ON`
 * que quedó grabado en prod**— que "el candado test-newdb-route-filter-options.js compara las
 * dos y truena si divergen". No existía. Es exactamente el defecto que la Fase VP.1 ya había
 * medido y nombrado: *un candado que la migración afirma que existe y no existe*. Corregir el
 * archivo no alcanzaba: el comentario vive en el catálogo de producción, así que el arreglo es
 * escribir el candado CON EL NOMBRE QUE PROD YA DECLARA.
 *
 * ── QUÉ PROTEGE ─────────────────────────────────────────────────────────────────────────────
 * `analytics.mv_route_filter_options` reemplazó una consulta de **96,303 ms** (el combo de
 * clientes leía `analytics.v_route_sales_lines`, el contrato ENRIQUECIDO, y pagaba dos LATERAL
 * por línea sobre 1,194,719 líneas para llenar una lista desplegable). La matvista se llena con
 * la unión LEAN. La afirmación que sostiene todo el cambio es: **lean y enriquecida dan lo
 * mismo**. Si un día dejan de darlo, el combo empieza a esconder clientes en silencio.
 *
 *  1. La matvista existe, tiene índice ÚNICO (sin él no hay `REFRESH CONCURRENTLY` y el refresco
 *     bloquearía a los lectores) y declara `computed_at`.
 *  2. La matvista cuadra con su propia definición LEAN, al centavo, en el universo completo.
 *  3. LEAN == ENRIQUECIDA en una ventana acotada. Acotada a propósito: sobre los 2 años la
 *     enriquecida tarda 69 s y no entra en el `statement_timeout` de 1 min — medirla ahí sería
 *     un test que muere por tiempo y se lee como falla.
 *  4. FRESCURA: se mide la edad y el veredicto se **DECLARA NO MEDIDO**, porque no hay carril de
 *     refresco registrado en `CRON_JOBS`. Poner verde un umbral que nadie registró es el
 *     `cfg ? classify : 'ok'` que la Fase VP ya midió dando verde incondicional.
 *
 *   DATABASE_URL_NEW=<prod o destino> node database/tests/test-newdb-route-filter-options.js
 */
const { Client } = require('pg');

const URL = process.env.DATABASE_URL_NEW || process.env.DST_URL
  || (() => { throw new Error('falta la URL de la DB destino: exporta DATABASE_URL_NEW'); })();

let ok = 0, fail = 0, nomedido = 0;
const pass = (m) => { ok++; console.log('  ✔', m); };
const bad = (m) => { fail++; console.log('  x FALLA:', m); };
const skip = (m) => { nomedido++; console.log('  ~ NO MEDIDO:', m); };
const money = (n) => Number(n || 0).toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** La unión LEAN, con la ventana como parámetro para poder acotarla en el bloque 3. */
const lean = (desde) => `
  SELECT vl.tenant_id, vl.cliente, vl.sku, vl.importe
    FROM wincaja.v_sales_lines vl
   WHERE vl.sale_channel = 'ruta_venta' AND vl.business_date >= ${desde}
  UNION ALL
  SELECT rpl.tenant_id, rpl.cliente, rpl.sku, rpl.importe
    FROM analytics.route_push_lines rpl
   WHERE rpl.business_date >= ${desde}
  UNION ALL
  SELECT vl.tenant_id, vl.cliente, vl.sku, vl.importe
    FROM wincaja.v_sales_lines vl
   WHERE vl.sale_channel = 'preventa_vecinal' AND vl.source_branch = '10'
     AND vl.business_date < '2026-06-28'::date AND vl.business_date >= ${desde}`;

/** El MISMO universo leído por la vista enriquecida (la que costaba 96 s). */
const enriquecida = (desde) => `
  SELECT sl.tenant_id, sl.cliente, sl.sku, sl.importe
    FROM analytics.v_route_sales_lines sl
   WHERE sl.business_date >= ${desde}`;

const agregado = (fuente) => `
  WITH l AS (${fuente})
  SELECT count(DISTINCT l.cliente) FILTER (
           WHERE l.cliente IS NOT NULL AND btrim(l.cliente) <> '' AND l.cliente <> '0001') AS clientes,
         count(DISTINCT l.sku) FILTER (WHERE l.sku IS NOT NULL) AS skus,
         round(sum(l.importe) FILTER (
           WHERE l.cliente IS NOT NULL AND btrim(l.cliente) <> '' AND l.cliente <> '0001'),2) AS rev_cli
    FROM l WHERE l.tenant_id = $1`;

(async () => {
  const db = new Client({ connectionString: URL, ssl: /rlwy|railway|proxy/i.test(URL) ? { rejectUnauthorized: false } : false });
  await db.connect();
  try {
    const t = (await db.query(`SELECT id FROM public.tenants WHERE slug = 'mega_dulces' LIMIT 1`)).rows[0];
    if (!t) { console.log('sin tenant mega_dulces: nada que medir'); process.exitCode = 0; return; }
    const T = t.id;
    // Sin esto `wincaja.v_sales_lines` devuelve 0 filas y el candado se pondría verde midiendo el vacío.
    await db.query('SELECT set_config($1,$2,false)', ['app.tenant_id', T]);

    // ── 1. Forma ────────────────────────────────────────────────────────────────────────────
    console.log('\n[1] La matvista existe y puede refrescarse sin bloquear');
    const existe = (await db.query(
      `SELECT 1 FROM pg_matviews WHERE schemaname='analytics' AND matviewname='mv_route_filter_options'`)).rowCount;
    if (!existe) { bad('analytics.mv_route_filter_options no existe: el combo está cayendo a la consulta viva.'); }
    else {
      const uq = (await db.query(
        `SELECT indexname FROM pg_indexes
          WHERE schemaname='analytics' AND tablename='mv_route_filter_options' AND indexdef ILIKE '%UNIQUE%'`)).rows;
      if (uq.length) pass(`índice único presente (${uq[0].indexname}): REFRESH CONCURRENTLY es posible.`);
      else bad('sin índice único: el REFRESH tomaría lock exclusivo y bloquearía a los lectores.');
    }

    if (existe) {
      // ── 2. La matvista sirve de catálogo ──────────────────────────────────────────────────
      console.log('\n[2] El catálogo es usable (no vacío, sin códigos en blanco, con rótulo)');
      const mv = (await db.query(
        `SELECT count(*) FILTER (WHERE kind='cliente')::int AS clientes,
                count(*) FILTER (WHERE kind='sku')::int     AS skus,
                count(*) FILTER (WHERE value IS NULL OR btrim(value) = '')::int AS vacios,
                count(*) FILTER (WHERE label IS NULL OR btrim(label) = '')::int AS sin_rotulo,
                count(*) FILTER (WHERE label = value)::int  AS rotulo_es_codigo,
                round(sum(rev) FILTER (WHERE kind='cliente'),2) AS rev_cli
           FROM analytics.mv_route_filter_options WHERE tenant_id = $1`, [T])).rows[0];
      console.log(`     ${mv.clientes} clientes · ${mv.skus} skus · $${money(mv.rev_cli)}`);
      if (!Number(mv.clientes) && !Number(mv.skus)) {
        bad('la matvista está VACÍA: el servicio está cayendo al respaldo vivo en cada carga.');
      } else if (Number(mv.vacios) || Number(mv.sin_rotulo)) {
        bad(`${mv.vacios} opción(es) con código vacío y ${mv.sin_rotulo} sin rótulo: el combo mostraría filas mudas.`);
      } else {
        pass(`${Number(mv.clientes) + Number(mv.skus)} opciones, todas con código y rótulo.`);
        // El rótulo cae al código cuando el nombre no existe en la fuente: eso está DECLARADO en
        // el diseño (1,032 de 6,298 códigos de cliente no tienen nombre). Se reporta, no se juzga.
        console.log(`     ${mv.rotulo_es_codigo} sin nombre en la fuente: su rótulo ES el código (declarado, no inventado).`);
      }

      // ── 2b. La re-derivación COMPLETA: existe, pero no corre en la suite rápida ────────────
      if (process.env.DEEP === '1') {
        console.log('\n[2b] Re-derivación completa contra la unión LEAN (2 años)');
        await db.query(`SET statement_timeout = '5min'`);
        const vivo = (await db.query(agregado(lean(`(CURRENT_DATE - INTERVAL '2 years')`)), [T])).rows[0];
        const dCli = Number(mv.clientes) - Number(vivo.clientes);
        const dSku = Number(mv.skus) - Number(vivo.skus);
        const dRev = Number(mv.rev_cli || 0) - Number(vivo.rev_cli || 0);
        console.log(`     vivo: ${vivo.clientes} clientes · ${vivo.skus} skus · $${money(vivo.rev_cli)}`);
        // ⚠️ El conteo puede moverse por venta NUEVA desde el último refresco; lo que no puede
        // moverse es el signo: la matvista jamás debe tener MÁS de lo que la fuente tiene.
        if (dCli > 0 || dSku > 0) bad(`residuo: la matvista tiene filas que la fuente ya no tiene (Δ ${dCli} clientes, ${dSku} skus).`);
        else if (dCli === 0 && dSku === 0 && Math.abs(dRev) < 0.01) pass('idéntica al centavo: mismo padrón y misma venta.');
        else skip(`va ${-dCli} clientes / ${-dSku} skus / $${money(-dRev)} DETRÁS del vivo — rezago sin carril de refresco (bloque 4).`);
        await db.query(`SET statement_timeout = '1min'`);
      } else {
        skip('la re-derivación de los 2 años EXCEDE el statement_timeout de 1 min y dejaría la suite '
          + 'colgada. Se corre aparte con DEEP=1. No se omite por conveniencia: la afirmación que '
          + 'sostiene el cambio (lean == enriquecida) se prueba acotada en el bloque 3.');
      }
    }

    // ── 3. LEAN == ENRIQUECIDA (la afirmación que sostiene el cambio) ───────────────────────
    console.log('\n[3] Quitar el enriquecimiento por línea NO cambia el universo');
    const VENT = `(CURRENT_DATE - INTERVAL '30 days')`;
    const a = (await db.query(agregado(lean(VENT)), [T])).rows[0];
    const b = (await db.query(agregado(enriquecida(VENT)), [T])).rows[0];
    if (!Number(a.clientes) && !Number(b.clientes)) {
      skip('no hay venta de ruta en los últimos 30 días: nada con qué comparar.');
    } else if (Number(a.clientes) === Number(b.clientes) && Number(a.skus) === Number(b.skus)
      && Math.abs(Number(a.rev_cli || 0) - Number(b.rev_cli || 0)) < 0.01) {
      pass(`30 días: ${a.clientes} clientes · ${a.skus} skus · $${money(a.rev_cli)} — lean y enriquecida coinciden.`);
    } else {
      bad(`lean y enriquecida DIVERGEN en 30 días: lean ${a.clientes}/${a.skus}/$${money(a.rev_cli)} vs `
        + `enriquecida ${b.clientes}/${b.skus}/$${money(b.rev_cli)}. El combo estaría escondiendo filas.`);
    }

    // ── 4. Frescura: se mide, no se juzga ───────────────────────────────────────────────────
    console.log('\n[4] Frescura del catálogo');
    if (!existe) { skip('sin matvista no hay frescura que medir.'); }
    else {
      const f = (await db.query(
        `SELECT to_char(max(computed_at),'YYYY-MM-DD HH24:MI') AS al,
                round(extract(epoch FROM (now() - max(computed_at))) / 3600)::int AS horas
           FROM analytics.mv_route_filter_options WHERE tenant_id = $1`, [T])).rows[0];
      const carril = (await db.query(
        `SELECT count(*)::int n FROM analytics.cron_run_log
          WHERE job_key ILIKE '%route_filter%' OR job_key ILIKE '%filter_options%'`)).rows[0];
      console.log(`     calculada el ${f.al} (hace ${f.horas} h)`);
      if (Number(carril.n) > 0) {
        pass(`hay carril de refresco registrado (${carril.n} corridas): la edad se puede juzgar.`);
      } else {
        skip('NO hay carril de refresco ni umbral registrado en CRON_JOBS: la edad se mide pero no se '
          + 'puede juzgar. Declararlo verde sería el `cfg ? classify : "ok"` que la Fase VP ya midió. '
          + 'DEUDA CON NOMBRE: cablear el REFRESH (216 s medidos) al carril nocturno + su umbral.');
      }
    }

    console.log(`\n=== ${ok} OK · ${fail} FALLAS · ${nomedido} NO MEDIDOS ===`);
    process.exitCode = fail ? 1 : 0;
  } catch (e) {
    console.error('ERROR:', e.message);
    process.exitCode = 1;
  } finally {
    await db.end().catch(() => {});
  }
})();
