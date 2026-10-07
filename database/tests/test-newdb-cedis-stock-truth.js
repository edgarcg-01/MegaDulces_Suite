/* eslint-disable no-console */
/**
 * `[IC.CEDIS.7]` — **El candado de la existencia del CEDIS** (ADR-059).
 *
 * ── QUÉ VINO A CERRAR ───────────────────────────────────────────────────────────────────────────
 * El 2026-09-30 la mig `20260930140000` le puso `kepler_code='00'` al CEDIS para cerrar la
 * compuerta de su feed Wincaja. Efecto no previsto: `analytics.v_erp_stock_on_hand` lo excluía a
 * mano de la pierna Kepler (`w.kepler_code <> '00'`, escrito cuando se creía que esa sucursal era
 * OFICINAS) y lo aceptaba en la de Wincaja sólo si `kepler_code IS NULL`. **Se cayó de las dos y
 * quedó invisible un día entero**, en el nodo que SURTE A LA RED. Lo reportó un humano, no un test.
 *
 * ── EL ÁRBITRO, Y POR QUÉ ÉSTE ─────────────────────────────────────────────────────────────────
 * El testigo del CEDIS es su **conteo físico del corte** (`N-A-45` del 2026-09-30, 127 líneas):
 * mismo ERP, mismo grano (almacén x SKU), e independiente del ledger en el sentido que importa —
 * alguien contó cajas. El bloque 3 compara SKU por SKU contra `kdil` y exige **1.00x**.
 *
 * ⚠️ Y se declara su LÍMITE, que es real: a partir del corte el conteo deja de ser independiente
 * (la entrada `N-A-30` posteó justamente lo contado) y el CEDIS se mueve. Este candado arbitra la
 * **identidad del corte**, no la existencia de hoy. Decir que arbitra más sería un espejo (R5).
 *
 * ── EL HUECO, DECLARADO CON NÚMERO (nunca dibujado en verde) ───────────────────────────────────
 * Kepler tiene DOS columnas de existencia y **se contradicen en las OCHO sucursales**: `kdil`
 * (`c4+c8-c9`, la que publicamos en todos lados) contra `kdik.c6` (que no consume nadie). Razones
 * medidas el 2026-10-01: 0.09x a 5.45x, ~99% de los SKUs distintos en cada rama. El bloque 5 lo
 * mide y reporta **NO MEDIDO**, no un tache: no es una regresión de esta fase y no se puede
 * arbitrar sin decidir primero qué significa `kdik.c6`. Un hueco con nombre y monto le gana a un
 * rojo permanente que nadie atiende.
 */
'use strict';
const { Client } = require('pg');
const { noMedido, esFaltaDeAcceso } = require('./_lib/no-medido');

const URL = process.env.DATABASE_URL_NEW || process.env.DST_URL
  || (() => { throw new Error('falta DATABASE_URL_NEW'); })();
const CORTE = process.env.CEDIS_CUTOVER || '2026-09-30';
const SUC = '00';

let ok = 0; let fail = 0; let skip = 0;
const chk = (c, m) => { if (c) { ok++; console.log(`  ✔ ${m}`); } else { fail++; console.log(`  ✖ ${m}`); } };
const nm = (m) => { skip++; console.log(`  ◻ NO MEDIDO — ${m}`); };
const n = (x) => Number(x ?? 0).toLocaleString('es-MX');

(async () => {
  const c = new Client({
    connectionString: URL,
    ssl: /rlwy\.net|railway|amazonaws/i.test(URL) ? { rejectUnauthorized: false } : false,
    connectionTimeoutMillis: 20000, statement_timeout: 180000,
  });
  try { await c.connect(); } catch (e) {
    if (esFaltaDeAcceso(e)) return noMedido(`no se pudo conectar (${e.code || e.message})`);
    throw e;
  }
  const q = async (sql, p = []) => (await c.query(sql, p)).rows;

  try {
    // ── 1. EL CEDIS SE PUBLICA, PERO SÓLO LO ARBITRADO ──────────────────────────────────────
    // ⛔ ESTE BLOQUE SE DIO VUELTA DOS VECES EN DOS DÍAS, y las dos vueltas son la lección.
    //
    // 01-oct 09:11 — se publica el CEDIS (batch 647) con el argumento de que su volumen «está
    //   repartido entre miles de SKUs, así que es un almacén y no un artefacto».
    // 01-oct 09:55 — se retira (batch 653): Edgar saca del propio Kepler el reporte de existencia
    //   del ALMACÉN Cedis y da 0.00 donde la vista publicaba miles. *Estar repartido no lo hace
    //   real — eso era una corazonada con forma de medición.*
    // 01-oct       — llega el reporte COMPLETO (123 págs, 9,496 SKUs, sin omitir ceros) y arbitra:
    //   el CEDIS tiene existencia en 148 SKUs / 357,471 u, y `c4+c8-c9` los reproduce 148 de 148.
    //   La fórmula estaba bien; la TABLA arrastra el residuo de cuando md_00 era base de PRUEBA.
    //   Se republica filtrado por actividad posterior al corte (batch 655).
    //
    // Ahora el candado exige las DOS cosas a la vez, porque cada una sola se puede satisfacer
    // haciendo trampa: que el CEDIS **esté** en la vista (si desaparece, volvimos a dejar al
    // comprador a ciegas sobre el nodo que surte a la red) y que lo publicado **no** sea la cifra
    // cruda (si reaparecen los millones, se cayó el filtro de corte). El valor exacto y el
    // residuo los vigila [4c]; acá sólo se fija que no se pueda volver a ninguno de los dos
    // extremos sin que esto se ponga rojo.
    console.log('\n[1] El CEDIS se publica, y sólo lo arbitrado');
    const [cedis] = await q(
      `SELECT count(*)::int skus, COALESCE(sum(qty_stock_units),0)::numeric u
         FROM analytics.v_erp_stock_on_hand WHERE warehouse_code = $1`, [SUC]);
    const TECHO = 2000000; // la cifra cruda era 12.18 M; lo arbitrado, 0.34 M
    chk(cedis.skus > 0 && Number(cedis.u) < TECHO,
      cedis.skus === 0
        ? `⛔ el almacén ${SUC} volvió a quedar FUERA de la vista — el comprador decide a ciegas `
          + 'sobre el nodo que surte a la red, y el reporte del ERP ya lo arbitró'
        : Number(cedis.u) >= TECHO
          ? `⛔ el CEDIS publica ${n(cedis.skus)} SKUs / ${n(Math.round(cedis.u))} u: se cayó el `
            + 'filtro de corte y volvió el residuo de la base de prueba'
          : `el CEDIS publica ${n(cedis.skus)} SKUs / ${n(Math.round(cedis.u))} u — presente y `
            + `por debajo del techo de ${n(TECHO)} u que separa lo arbitrado de la cifra cruda`);

    const ramas = await q(
      `SELECT warehouse_code FROM analytics.v_erp_stock_on_hand
        GROUP BY 1 HAVING count(*) > 0 ORDER BY 1`);
    // Guarda anti-no-op: si la vista se vacía entera, el bloque 1 pasaría igual de "verde" mirando
    // sólo al CEDIS. Las 8 hermanas son el control.
    // Guarda anti-no-op: con el CEDIS retirado, el bloque de arriba pasaría igual si la vista se
    // vaciara ENTERA. Las 8 hermanas son el control de que sigue viva.
    chk(ramas.length >= 8,
      `la vista publica ${ramas.length} almacenes (${ramas.map((r) => r.warehouse_code).join(',')}) — se esperan >= 8`);

    // ── 2. SIN DOBLE CONTEO entre las dos piernas ───────────────────────────────────────────
    console.log('\n[2] Las dos piernas no se solapan');
    const [dup] = await q(
      `SELECT count(*)::int pares FROM (
         SELECT warehouse_code, sku FROM analytics.v_erp_stock_on_hand
          GROUP BY 1,2 HAVING count(DISTINCT source) > 1) t`);
    chk(dup.pares === 0,
      dup.pares === 0 ? 'ningún (almacén, SKU) sale por Kepler Y por Wincaja a la vez'
        : `⛔ ${n(dup.pares)} pares (almacén,SKU) duplicados entre piernas — el total está inflado`);

    // ── 3. EL ÁRBITRO: el conteo del corte contra el ledger ─────────────────────────────────
    console.log('\n[3] Árbitro — conteo físico N-A-45 del corte vs kdil, SKU por SKU');
    const [arb] = await q(
      `WITH cap AS (
         SELECT btrim(l.c8) sku, sum(l.c9::numeric) u
           FROM kepler_ods.kdm1 m JOIN kepler_ods.kdm2 l
             ON l.sucursal=m.sucursal AND l.c1=m.c1 AND l.c2=m.c2 AND l.c3=m.c3
            AND l.c4=m.c4 AND l.c5=m.c5 AND l.c6=m.c6
          WHERE m.sucursal=$1 AND m.c1=$1 AND m.c2='N' AND m.c3='A' AND m.c4='45'
            AND m.c9::date BETWEEN $2::date - 3 AND $2::date + 1
          GROUP BY 1),
       kd AS (
         SELECT btrim(c3) sku, GREATEST(sum(c4+c8-c9),0)::numeric u
           FROM kepler_ods.kdil WHERE sucursal=$1 AND c1=$1
            AND btrim(c3) <> ALL(ARRAY['00001','00002','00022'])
          GROUP BY 1)
       SELECT (SELECT count(*) FROM cap)::int contados,
              (SELECT COALESCE(sum(u),0) FROM cap)::numeric u_contadas,
              count(*)::int cruzan,
              COALESCE(sum(kd.u),0)::numeric u_kdil,
              count(*) FILTER (WHERE abs(kd.u - cap.u) > 0.01)::int difieren
         FROM cap JOIN kd USING (sku)`, [SUC, CORTE]);

    if (!arb.contados || Number(arb.contados) === 0) {
      // ⛔ Sin captura NO se pone verde: no hay con qué arbitrar (ADR-056).
      nm(`no hay captura N-A-45 en la sucursal ${SUC} alrededor de ${CORTE} — sin árbitro`);
    } else {
      // Guarda anti-no-op: un árbitro de 3 filas "cuadra" trivialmente.
      chk(Number(arb.contados) >= 100,
        `el conteo del corte trae ${n(arb.contados)} SKUs (>= 100: un árbitro chico cuadra solo)`);
      chk(Number(arb.cruzan) === Number(arb.contados),
        `los ${n(arb.contados)} SKUs contados TODOS tienen saldo en kdil (cruzan ${n(arb.cruzan)})`);
      chk(Number(arb.difieren) === 0,
        Number(arb.difieren) === 0
          ? `el ledger reproduce el conteo al grano SKU: ${n(arb.u_contadas)} u contra ${n(arb.u_kdil)} u`
          : `⛔ ${n(arb.difieren)} SKUs donde kdil NO reproduce lo contado`);
    }

    // ── 4. PRUEBA NEGATIVA: el árbitro sabe decir que NO ────────────────────────────────────
    console.log('\n[4] Prueba negativa — el bloque 3 no es un sello de goma');
    const [neg] = await q(
      `SELECT count(*)::int filas FROM kepler_ods.kdm1
        WHERE sucursal=$1 AND c2='N' AND c3='A' AND c4='99'`, [SUC]);
    chk(neg.filas === 0,
      'un doctype inexistente (N-A-99) devuelve 0 filas → el bloque 3 caería en NO MEDIDO, no en ✔');

    // ── 4b. LA MAGNITUD CONTRA LOS PARES — la medición que me faltó ────────────────────────
    // ⭐ El argumento con el que publiqué el CEDIS fue «los 10 SKUs más grandes son el 9.0% del
    // total, o sea que está repartido entre miles, y un almacén repartido es un almacén». Está
    // REFUTADO: estar repartido NO distingue un almacén de una tabla sin purgar —una corrida de
    // residuo también se reparte—. Era una corazonada con forma de medición. La que sí distinguía
    // estaba a una consulta: **comparar el nodo contra sus hermanos**.
    //   Esta regla es general y barata, y atrapa justo lo que el análisis interno no ve: cuando la
    // FÓRMULA está bien y **la TABLA está sucia**. Lleva su propio control negativo: el CEDIS tiene
    // que seguir disparándola, o el umbral se aflojó hasta volver el candado decorativo.
    console.log('\n[4b] Magnitud contra los pares — ningún nodo publica un orden de magnitud más');
    const UMBRAL = 5;
    const mag = await q(
      `WITH k AS (
         SELECT sucursal, sum(GREATEST(c4+c8-c9,0))::numeric u
           FROM kepler_ods.kdil
          WHERE sucursal = c1 AND btrim(c3) <> ALL(ARRAY['00001','00002','00022'])
          GROUP BY 1)
       SELECT sucursal, u,
              (SELECT max(o.u) FROM k o WHERE o.sucursal <> k.sucursal) AS max_pares
         FROM k ORDER BY 1`);
    const nodo = mag.find((r) => r.sucursal === SUC);
    const pares = mag.filter((r) => r.sucursal !== SUC);
    if (!nodo || pares.length < 5) {
      nm(`sólo ${mag.length} sucursales en kdil — sin pares con qué comparar`);
    } else {
      // Control negativo: la regla TIENE que marcar al CEDIS. Si deja de hacerlo, es un no-op.
      const rCedis = Number(nodo.u) / Number(nodo.max_pares);
      chk(rCedis > UMBRAL,
        `control negativo: el CEDIS dispara la regla — ${n(nodo.u)} u = ${rCedis.toFixed(1)}× ` +
        `la mayor de sus pares (${n(nodo.max_pares)} u), umbral ${UMBRAL}×`);
      // Y la regla sobre las que SÍ se publican: ninguna puede ser un outlier sin testigo.
      const fuera = pares.filter((r) => Number(r.u) / Number(r.max_pares) > UMBRAL);
      chk(fuera.length === 0,
        fuera.length === 0
          ? `las ${pares.length} sucursales publicadas están dentro de ${UMBRAL}× de su mayor par`
          : `⛔ ${fuera.map((r) => `${r.sucursal} (${(Number(r.u)/Number(r.max_pares)).toFixed(1)}×)`)
               .join(', ')} publica(n) fuera de escala — en disputa hasta tener testigo externo`);
    }

    // ── 4c. LO QUE SE PUBLICA DEL CEDIS, ARBITRADO (IC.CEDIS.12) ──────────────────────────
    // [4b] mide la tabla CRUDA y tiene que seguir marcando el 17× — kdil sigue sucia, no la
    // arreglamos nosotros (ADR-040). Lo que cambia es lo que PUBLICAMOS: sólo las filas con
    // actividad posterior al corte de la rama. Este bloque vigila esa cifra, y lo hace
    // CRUZANDO DOS IMPLEMENTACIONES — verificar una vista contra sí misma pasa bugs en verde.
    console.log('\n[4c] El CEDIS publicado: snapshot filtrado == movimientos desde el corte');
    const [cut] = await q(
      `SELECT min(cutover_date)::date::text AS d FROM analytics.v_branch_erp_cutover
        WHERE kepler_code = $1`, [SUC]);
    const corte = (cut && cut.d) || CORTE;
    // (a) lo que la vista publica hoy
    const [vis] = await q(
      `SELECT count(*)::int skus, COALESCE(round(sum(s.qty_stock_units)),0)::bigint u
         FROM analytics.v_erp_stock_on_hand s
         JOIN commercial.warehouses w ON w.id = s.warehouse_id
        WHERE s.source = 'kepler_ods' AND w.kepler_code = $1`, [SUC]);
    // (b) reconstrucción INDEPENDIENTE: suma de los movimientos que afectan inventario desde
    //     el corte. ⚠️ kdmm se une CON sucursal: el catálogo está replicado en las nueve ramas
    //     y sin esa columna el resultado sale multiplicado por 9 (pasó al construir esto).
    const [mov] = await q(
      `SELECT COALESCE(round(sum(CASE WHEN m.c3='A' THEN l.c9::numeric ELSE -l.c9::numeric END)),0)::bigint u
         FROM kepler_ods.kdm1 m
         JOIN kepler_ods.kdm2 l
           ON l.sucursal=m.sucursal AND l.c1=m.c1 AND l.c2=m.c2 AND l.c3=m.c3
          AND l.c4=m.c4 AND l.c5=m.c5 AND l.c6=m.c6
         JOIN kepler_ods.kdmm mm
           ON mm.sucursal=m.sucursal AND mm.c1=m.c2 AND mm.c2=m.c3 AND mm.c3=m.c4 AND mm.c4=m.c5
        WHERE m.sucursal=$1 AND m.c1=m.sucursal AND mm.c8='S' AND m.c9::date >= $2::date`,
      [SUC, corte]);
    if (!vis || Number(vis.skus) === 0) {
      nm(`la vista no publica nada para la sucursal ${SUC} — nada que cruzar`);
    } else {
      // El SKU fuera de catalog.products explica la diferencia residual; se tolera 1%.
      const dv = Math.abs(Number(vis.u) - Number(mov.u));
      chk(dv / Math.max(Number(mov.u), 1) < 0.01,
        `dos implementaciones coinciden: vista ${n(vis.u)} u vs movimientos desde ${corte} ` +
        `${n(mov.u)} u (Δ ${n(dv)}, tope 1%)`);
      // Y ya no es el outlier: lo publicado tiene que caber contra sus pares.
      const nodoPub = Number(vis.u);
      const maxPar = Math.max(...mag.filter((r) => r.sucursal !== SUC).map((r) => Number(r.u)));
      chk(nodoPub / maxPar <= UMBRAL,
        `lo publicado del CEDIS entra en escala: ${n(nodoPub)} u = ` +
        `${(nodoPub / maxPar).toFixed(2)}× su mayor par (umbral ${UMBRAL}×)`);
    }
    // ⭐ CENTINELA DEL RESIDUO: ninguna fila publicada puede venir de un renglón cuya última
    // ENTRADA es anterior al corte. Hoy son 0 de 127; si Kepler reactiva una fila vieja, entra
    // con sus acumuladores sucios (hay 2,890 filas / 10.36 M u esperando) y esto se pone rojo.
    const [res] = await q(
      `SELECT count(*)::int n, COALESCE(round(sum(c4+c8-c9)),0)::bigint u
         FROM kepler_ods.kdil
        WHERE sucursal=$1 AND sucursal=c1 AND (c4+c8-c9) > 0
          AND btrim(c3) <> ALL(ARRAY['00001','00002','00022'])
          AND GREATEST(c6,c7)::date >= $2::date AND c6::date < $2::date`, [SUC, corte]);
    chk(Number(res.n) === 0,
      Number(res.n) === 0
        ? 'ninguna fila publicada arrastra acumuladores previos al corte (0 revividas)'
        : `⛔ ${res.n} fila(s) de residuo revivieron y publican ${n(res.u)} u con acumulador sucio`);
    // Prueba negativa: sin el filtro de corte el residuo TIENE que aparecer, o el centinela
    // está midiendo un conjunto vacío y se pondría verde por construcción.
    const [resNeg] = await q(
      `SELECT count(*)::int n FROM kepler_ods.kdil
        WHERE sucursal=$1 AND sucursal=c1 AND (c4+c8-c9) > 0
          AND btrim(c3) <> ALL(ARRAY['00001','00002','00022'])
          AND GREATEST(c6,c7)::date < $2::date`, [SUC, corte]);
    chk(Number(resNeg.n) > 0,
      `prueba negativa: sin el filtro de corte quedan ${n(resNeg.n)} filas de residuo — ` +
      'el centinela mira un conjunto no vacío, no es un no-op');

    // ── 5. EL HUECO DECLARADO: kdil vs kdik en TODAS las sucursales ─────────────────────────
    console.log('\n[5] Hueco declarado — Kepler tiene DOS existencias y no coinciden');
    const div = await q(
      `WITH kl AS (
         SELECT sucursal, btrim(c3) sku, GREATEST(sum(c4+c8-c9),0)::numeric u
           FROM kepler_ods.kdil WHERE sucursal=c1
            AND btrim(c3) <> ALL(ARRAY['00001','00002','00022']) GROUP BY 1,2),
       kk AS (
         SELECT sucursal, btrim(c2) sku, max(c6::numeric) u
           FROM kepler_ods.kdik WHERE sucursal=c1 GROUP BY 1,2)
       SELECT COALESCE(kl.sucursal,kk.sucursal) suc,
              round((sum(GREATEST(kl.u,0))/NULLIF(sum(GREATEST(kk.u,0)),0))::numeric,2) razon
         FROM kl FULL JOIN kk ON kk.sucursal=kl.sucursal AND kk.sku=kl.sku
        GROUP BY 1 ORDER BY 1`);
    const fuera = div.filter((r) => r.razon == null || Math.abs(Number(r.razon) - 1) > 0.02);
    if (fuera.length) {
      // ⛔ RETRACTADO (IC.CEDIS.12): acá decía «un testigo que contradice SIEMPRE no arbitra»,
      // dando a entender que kdik era un segundo candidato a existencia. Ya se midió contra el
      // censo del ERP y NO lo es: de los 148 SKUs con saldo real en el CEDIS, `kdik.c6`
      // reproduce **0**. No contradice: mide otra cosa. El que sí cuadró 148 de 148 fue
      // `kdil.c4+c8-c9`. Esta discrepancia deja de ser un hueco de existencia y pasa a ser una
      // columna sin decodificar — por eso sigue en NO MEDIDO, pero por otra razón.
      nm(`kdil vs kdik discrepan en ${fuera.length} de ${div.length} sucursales `
        + `(${fuera.map((r) => `${r.suc}=${r.razon}x`).join(' ')}) — `
        + 'kdik.c6 NO es existencia (reproduce 0 de los 148 que el ERP confirma en el CEDIS): '
        + 'queda como columna sin decodificar, no como testigo en disputa');
    } else {
      chk(true, 'kdil y kdik coinciden en todas las sucursales — el hueco se cerró, actualizá el doc');
    }

    // ── 6. Metadata que un CREATE OR REPLACE se lleva puesta ───────────────────────────────
    console.log('\n[6] security_invoker y grants sobrevivieron');
    const [meta] = await q(
      `SELECT COALESCE((SELECT option_value FROM pg_options_to_table(cl.reloptions)
                         WHERE option_name='security_invoker'),'(no)') si
         FROM pg_class cl WHERE cl.oid='analytics.v_erp_stock_on_hand'::regclass`);
    chk(meta.si === 'true', `security_invoker = ${meta.si} (un CREATE OR REPLACE NO lo hereda)`);
    // ⛔ NO se pregunta por `information_schema.role_table_grants`: esa vista sólo muestra los
    // grants donde el rol CONECTADO es otorgante o beneficiario, así que corriendo como `dev_ro`
    // devolvía 1 de 2 y marcaba en ROJO una vista sana. `has_table_privilege` no depende de quién
    // pregunta. *Un candado que falla según quién lo corre enseña a ignorarlo.*
    const [gr] = await q(
      `SELECT has_table_privilege('app_runtime','analytics.v_erp_stock_on_hand','SELECT') AS app,
              has_table_privilege('dev_ro','analytics.v_erp_stock_on_hand','SELECT')      AS dev`);
    chk(gr.app === true && gr.dev === true,
      `SELECT concedido a app_runtime (${gr.app}) y dev_ro (${gr.dev})`);

    // ── 7. ¿El CEDIS llegó al PROGRAMA DE CONTEO? ──────────────────────────────────────────
    //
    // Es el único camino a una existencia con testigo independiente: el conteo del corte es un
    // ESPEJO (la entrada `N-A-30` posteó justo lo contado), así que hoy la cobertura arbitrada de
    // verdad es 0%. Y el CEDIS tiene UN conteo físico en toda su historia -- el de la migración --
    // contra 217 de la sucursal 02. Es el nodo menos contado de la red y el que surte a todos.
    //
    // La cadena es `v_erp_stock_on_hand` → `analytics.inventory_health` (nocturno 03:30) →
    // `v_abc_class` → `commercial.abc_classification` → `v_count_priority_score` → el plan. O sea
    // que el almacén `00` estaba fuera del programa **por la misma exclusión** que lo hacía
    // invisible: nadie lo sacó del conteo a propósito.
    //
    // ⭐ Este bloque distingue DOS cosas que se ven igual y piden lo contrario:
    //   · el nocturno todavía no corrió desde que se arregló la vista  → NO MEDIDO
    //   · corrió DESPUÉS y el CEDIS igual no está                      → FALLA (algo lo tira)
    // Sin esa distinción, el día del arreglo daría rojo y enseñaría a ignorar el candado.
    console.log('\n[7] El CEDIS entró al programa de conteo rotativo');
    const [prog] = await q(
      `SELECT (SELECT max(computed_at) FROM commercial.abc_classification)            AS abc_al,
              (SELECT migration_time FROM public.knex_migrations
                WHERE name = '20261001130000_stock_on_hand_incluye_cedis.js')          AS fix_al,
              (SELECT count(*) FROM commercial.abc_classification a
                 JOIN commercial.warehouses w ON w.id = a.warehouse_id
                WHERE w.code = $1)::int                                                AS abc_cedis,
              (SELECT count(*) FROM analytics.v_count_priority_score s
                 JOIN commercial.warehouses w ON w.id = s.warehouse_id
                WHERE w.code = $1
                  AND s.score_salvedad IS DISTINCT FROM 'sin_datos')::int              AS contables`,
      [SUC]);

    // ⛔ Mientras el CEDIS esté retirado de la vista NO puede entrar al programa de conteo: la
    // cadena entera cuelga de `v_erp_stock_on_hand`. Se DECLARA en vez de fallar -- no es una
    // regresión, es la consecuencia buscada de retirarlo, y vuelve sola cuando se arbitre.
    const [enVista] = await q(
      `SELECT count(*)::int n FROM analytics.v_erp_stock_on_hand WHERE warehouse_code = $1`, [SUC]);
    if (enVista.n === 0) {
      nm('el CEDIS está retirado de la existencia publicada (IC.CEDIS.9), así que no puede entrar '
        + 'al conteo rotativo: la cadena cuelga de v_erp_stock_on_hand. Se destraba al arbitrar '
        + 'la contradicción con el reporte del ERP');
    } else if (prog.abc_cedis > 0) {
      chk(prog.contables > 0,
        `el CEDIS aporta ${n(prog.contables)} SKUs CONTABLES al plan `
        + `(${n(prog.abc_cedis)} clasificados) — ya está en la ola rotativa`);
    } else if (!(prog.abc_al && prog.fix_al && new Date(prog.abc_al) > new Date(prog.fix_al))) {
      nm('el nocturno de ABC (03:30) todavía no corrió desde que se arregló la vista — '
        + `último cómputo ${prog.abc_al ? new Date(prog.abc_al).toISOString().slice(0, 16) : '(nunca)'}`
        + '; el CEDIS entra en la próxima corrida');
    } else {
      chk(false,
        '⛔ el ABC corrió DESPUÉS del arreglo y el CEDIS sigue sin clasificar — '
        + 'algo más lo está sacando del programa de conteo');
    }

    console.log(`\n=== ${ok} OK · ${fail} FALLA · ${skip} NO MEDIDO ===`);
    if (fail) process.exit(1);
    if (skip && ok === 0) return noMedido('no hubo con qué comprobar nada');
  } finally {
    await c.end();
  }
})().catch((e) => { console.error(e); process.exit(1); });
