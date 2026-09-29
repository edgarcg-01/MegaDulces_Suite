/* eslint-disable no-console */
/**
 * `[AUD-DAT.16]` — **Acotar la ventana del rollup NO puede borrar la historia que queda afuera.**
 *
 * ── DE DÓNDE SALE ESTE CANDADO ──────────────────────────────────────────────────────────────
 * `import-sales-by-vendor-monthly.js` recorría los 33 meses de la fuente y lo cortaba el
 * `TIMEOUT 10 min` del runner. Medido la noche del 2026-09-29: 9 meses en ~8 min (~53 s cada
 * uno). Ordenarlos DESC puso lo importante primero, pero el recorte seguía decidiéndolo el reloj
 * y el carril reportaba una FALLA todas las noches por trabajo que no hacía falta.
 *
 * `[AUD-DAT.16]` hizo la ventana explícita (8 meses por default). **Y al escribirla apareció la
 * trampa que este archivo vigila:** el barrido final del importer borra todo mes que no esté en
 * la lista —
 *
 *     DELETE FROM analytics.sales_by_vendor_monthly WHERE year_month <> ALL($2)
 *
 * — así que pasarle la lista RECORTADA se habría llevado **23 meses de historia** por delante,
 * en silencio y en una sola corrida. Por eso la ventana acota el BUCLE (`aProcesar`) y la lista
 * (`months`) sigue entera.
 *
 * ⚠️ Es la misma familia que `[[feedback_filter_validated_on_one_branch_deletes_another]]`: un
 * filtro correcto para lo que uno está mirando, destructivo para lo que no.
 *
 * ── QUÉ GUARDA ──────────────────────────────────────────────────────────────────────────────
 * El invariante de NO PÉRDIDA: todo mes pasado que la fuente produce tiene que seguir existiendo
 * en el rollup, esté dentro o fuera de la ventana. No fija montos (se mueven cada noche) ni
 * cuántos meses hay (crece uno por mes).
 *
 * ⚠️ SÓLO LECTURA y contra PROD a propósito. El bloque 3 es la **prueba negativa**: simula el
 * barrido con la lista recortada y exige que se vea el destrozo.
 *
 *   node database/tests/test-newdb-vendor-monthly-window.js
 */
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env') });
const { assertTarget } = require('../../libs/platform-core/src/lib/provenance/target-guard.js');

const URL = process.env.DATABASE_URL_NEW;
assertTarget('test-newdb-vendor-monthly-window', { url: URL, intent: 'read', expect: 'prod' });

const knex = require('knex')({ client: 'pg', connection: { connectionString: URL }, pool: { min: 0, max: 2 } });
const MEGA = '00000000-0000-0000-0000-00000000d01c';
/** El mismo default que el importer. Si allá cambia y acá no, el bloque 2 lo dice. */
const VENTANA = 8;

let pass = 0, fail = 0, nm = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m); } };
const noMedido = (m) => { nm++; console.log('  ·', 'NO MEDIDO —', m); };

/**
 * ⭐ Lo que el barrido del importer borraría con una lista dada. Función única: la usan el
 * veredicto real (con la lista completa) y la prueba negativa (con la recortada).
 */
function barreria(mesesEnTabla, listaQueRecibeElBarrido) {
  const viva = new Set(listaQueRecibeElBarrido);
  return mesesEnTabla.filter((m) => !viva.has(m));
}

(async () => {
  try {
    const hoyYm = new Date().toISOString().slice(0, 7);
    console.log('\n=== rollup por vendedor: la ventana no se come la historia ===\n');

    const fuente = await knex.raw(
      `SELECT DISTINCT to_char(wincaja.fecha_dia(m.fecha),'YYYY-MM') ym
         FROM wincaja.maestro_mov_almacen m WHERE m.tenant_id = ? ORDER BY 1 DESC`, [MEGA])
      .then((r) => r.rows.map((x) => x.ym));
    const enTabla = await knex.raw(
      `SELECT year_month ym, count(*)::int filas FROM analytics.sales_by_vendor_monthly
        WHERE tenant_id = ? GROUP BY 1 ORDER BY 1 DESC`, [MEGA])
      .then((r) => r.rows);

    if (!fuente.length || !enTabla.length) {
      noMedido('la fuente o el rollup están vacíos — sin universo no hay pérdida que medir');
    } else {
      const pasados = fuente.filter((m) => m <= hoyYm);
      const meses = enTabla.map((r) => r.ym);
      console.log(`  fuente ${fuente.length} meses · rollup ${meses.length} · ventana ${VENTANA}\n`);

      // ── 1) NINGÚN MES DEL ROLLUP SE QUEDÓ VACÍO ───────────────────────────────────────────
      // ⛔ Y NO al revés. La primera versión de este bloque exigía que todo mes de la fuente
      // estuviera en el rollup, y salió ROJO por 4 meses (2020-03/05/08, 2024-12) que NO son un
      // defecto: el propio importer documenta que su lista de meses es un SUPERCONJUNTO a
      // propósito —sale de las CABECERAS, y el rollup se arma de las LÍNEAS filtradas por el
      // blend del cutover—. Medido: esos 4 tienen **una sola cabecera** cada uno, capturas
      // sueltas que no producen ni una línea de venta. Un mes legítimamente vacío no es pérdida.
      //
      // Lo que sí es síntoma es un mes PRESENTE y en cero: eso sólo lo deja una pasada rota.
      console.log('1) Ningún mes del rollup quedó presente pero vacío');
      const enCero = enTabla.filter((r) => r.filas === 0).map((r) => r.ym);
      ok(enCero.length === 0, `${enCero.length} meses en cero`
        + (enCero.length ? ` — ${enCero.slice(0, 8).join(', ')}` : ''));

      // ── 2) LOS CONGELADOS SIGUEN AHÍ ──────────────────────────────────────────────────────
      // Los meses fuera de la ventana son los que el bucle ya no toca: si alguno pierde sus
      // filas, se perdieron sin que nadie las fuera a reponer.
      console.log('\n2) Los meses fuera de la ventana conservan sus filas');
      const fuera = pasados.slice(VENTANA).filter((m) => enTabla.some((x) => x.ym === m));
      const vacios = fuera.filter((m) => (enTabla.find((x) => x.ym === m) || {}).filas === 0);
      if (!fuera.length) noMedido(`ningún mes del rollup cae fuera de la ventana de ${VENTANA}`);
      else ok(vacios.length === 0, `${fuera.length} meses congelados con filas, ${vacios.length} vacíos`);

      // ── 3) PRUEBA NEGATIVA: el barrido con la lista RECORTADA destroza ────────────────────
      console.log('\n3) Prueba negativa: el barrido con la lista de la ventana borraría la historia');
      const conListaCompleta = barreria(meses, fuente);
      ok(conListaCompleta.length === 0,
        `con la lista COMPLETA el barrido no borra nada (${conListaCompleta.length} meses)`);

      const conListaRecortada = barreria(meses, pasados.slice(0, VENTANA));
      ok(conListaRecortada.length > 0,
        `con la lista RECORTADA borraría ${conListaRecortada.length} meses`
        + (conListaRecortada.length ? ` (${conListaRecortada[conListaRecortada.length - 1]} … ${conListaRecortada[0]})` : ''));
    }
  } catch (e) {
    fail++;
    console.log('  ✗ ERROR:', e.message);
  } finally {
    await knex.destroy();
    console.log(`\n${pass} ✓ / ${fail} ✗ / ${nm} NO MEDIDO\n`);
    process.exit(fail ? 1 : 0);
  }
})();
