'use strict';
/**
 * [DM.20] Candado del PAREO salida↔recepción de traspasos.
 *
 *   node database/tests/test-newdb-transfer-pairing.js
 *
 * Sólo lee.
 *
 * ── QUÉ PASÓ ─────────────────────────────────────────────────────────────────────────────
 *
 * `/almacen/movimientos` decía **"Sin recepción registrada (en tránsito o no recibido)"** sobre
 * un embarque que Kepler tenía recibido y firmado: salida CEDIS `UD4102-0000748` del 2026-09-28,
 * recepción 8ESQ `UA5001-0000377` del 2026-09-26, 301.34 piezas idénticas, y el propio embarque
 * declaraba "SUCURSAL 8 ESQUINAS" como destino. La pantalla tenía las dos mitades a la vista y
 * no las unía.
 *
 * La causa no era el back-pointer de Kepler (`parent_group=41` + `parent_serie` + `parent_folio`),
 * que es explícito y estaba bien. Era el DESEMPATE. Los folios son secuencias **por sucursal**,
 * así que el mismo `(serie, folio)` existe en varias plazas y hay que elegir. Se desempataba por
 * fecha, con una premisa escrita como ley física: *"la recepción nunca es anterior a la salida,
 * tope 15 días"*.
 *
 * ⛔ **Esa premisa es falsa.** Las dos plazas fechan el mismo movimiento por su cuenta. Medido
 * sobre los 1,720 pares donde dos testigos independientes coinciden —el destino declarado apunta
 * al almacén que recibe **y** la cantidad cuadra al 0.01— el desfase va de **−2 a +63 días**,
 * mediana 0, y **24 son negativos**.
 *
 * El desempate correcto es el que el documento declara: `dest_code` del embarque (vía
 * `analytics.transfer_dest_map`, almacén vivo) contra el almacén que recibe.
 *
 * ⭐ Y el error vivía en los DOS sentidos. Al mismo tiempo que inventaba tránsitos, la fecha
 * emparejaba embarques dirigidos a una **RUTA** (`RD 501`…`RD028`) con la recepción de una
 * **SUCURSAL** —desfases de cientos a miles de piezas, ninguno con cantidad exacta— y los
 * publicaba como recibidos y conciliados.
 *
 * ── QUÉ VERIFICA, Y POR QUÉ ESTAS Y NO OTRAS ─────────────────────────────────────────────
 *
 *  1. **Las constantes son UNAS.** Se leen del fuente, no se copian acá: si alguien ensancha la
 *     ventana en el servicio, este candado mide con la ventana nueva y no con una de hace meses.
 *     Y ningún punto del servicio puede volver a escribir su propia ventana a mano — eran cuatro
 *     copias y por eso el arreglo tenía que tocarlas todas.
 *  2. **El caso que lo destapó se parea.** Anclado al documento real. Si el dato ya no está, se
 *     declara NO MEDIDO: un candado que no encuentra su sujeto no está verde, está mudo.
 *  3. **La PREMISA de la regla nueva sigue viva.** Si dejaran de existir pares de alta confianza
 *     con desfase negativo, la regla vieja habría sido cierta y ésta sobraría. Se vigila la
 *     premisa, no sólo el resultado (patrón `[CE.8]`).
 *  4. **PRUEBA NEGATIVA con CONTROL POSITIVO.** Embarques a RUTA pareados con recepción de
 *     SUCURSAL: la regla nueva da 0 **y** la vieja da >0. Sin el control, una regla que no
 *     parea nada se ve igual de verde que una que parea bien.
 *  5. **Los dos testigos son independientes y coinciden.** De los pares con cantidad exacta, el
 *     destino declarado confirma en ≥99 %. Si coincidieran al 100 % habría que sospechar que uno
 *     deriva del otro; si cayera, el desempate estaría fabricando pares.
 *  6. **La calidad del pareo no baja.** La proporción con cantidad exacta tiene que ser ≥ que la
 *     de la regla vieja. Es la medición antes/después, dentro del candado.
 *  7. **No fabrica pares.** Casi 1:1 — una recepción no puede ser reclamada por varias salidas.
 *
 * ── LO QUE NO MIDE (declarado, no tapado) ────────────────────────────────────────────────
 *
 * ⚠️ El **borde de rango** del Cuadre sigue abierto. `transfersPhysical` busca la recepción sólo
 * dentro del rango que se está mirando, así que un embarque del 28 de septiembre recibido el 2
 * de octubre se publica como `sin_recepcion` en el cuadre de septiembre. Medido en prod el
 * 2026-10-06: **41 documentos / $489,358.13** sólo en septiembre. No se arregló acá porque la
 * respuesta honesta no es pegarlo igual sino un estado que no existe —"recibido FUERA del
 * periodo"—, y eso toca la pantalla, los contadores y los filtros. El bloque 8 lo MIDE y lo
 * reporta; no falla.
 */

const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env') });
const knexLib = require('knex');

const SRC = path.resolve(__dirname, '..', '..', 'libs', 'commercial', 'src', 'lib',
  'commercial-movements', 'commercial-movements.service.ts');

let ok = 0, bad = 0, nm = 0;
const t = (name, cond, extra) => {
  if (cond) { ok++; console.log(`  ✔ ${name}`); }
  else { bad++; console.log(`  ✘ ${name}${extra ? ' — ' + extra : ''}`); }
};
const declarar = (name, motivo) => { nm++; console.log(`  ◻ NO MEDIDO: ${name} — ${motivo}`); };
const n = (v) => Number(v || 0);
const money = (v) => '$' + n(v).toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** Lee las ventanas del fuente para medir con las de HOY, no con una copia que envejece. */
function ventanasDelFuente(src) {
  const g = (k) => {
    const m = src.match(new RegExp(`const\\s+${k}\\s*=\\s*(\\d+)\\s*;`));
    return m ? Number(m[1]) : null;
  };
  return { early: g('PAIR_EARLY_DAYS'), late: g('PAIR_LATE_DAYS'), blind: g('PAIR_BLIND_DAYS') };
}

(async () => {
  const url = process.env.DATABASE_URL_NEW;
  if (!url) { console.error('falta DATABASE_URL_NEW'); process.exit(1); }
  const db = knexLib({ client: 'pg', connection: { connectionString: url, ssl: { rejectUnauthorized: false } }, pool: { min: 0, max: 3 } });

  const src = fs.readFileSync(SRC, 'utf8');
  const W = ventanasDelFuente(src);

  console.log('\n[DM.20] Candado del pareo salida↔recepción de traspasos');
  console.log(`         ventanas leídas del fuente: early=${W.early} late=${W.late} blind=${W.blind}\n`);

  try {
    // ── 1. una sola definición de la regla ──────────────────────────────────────────────
    console.log('1) La regla del pareo vive en UN solo lugar');
    t('las tres ventanas están declaradas en el servicio',
      W.early !== null && W.late !== null && W.blind !== null,
      `early=${W.early} late=${W.late} blind=${W.blind}`);
    t('existe el predicado compartido TRANSFER_PAIR_MATCH', /const TRANSFER_PAIR_MATCH\s*=/.test(src));
    t('existe su gemelo en JS pairMatchJs', /const pairMatchJs\s*=/.test(src));
    // ⚠️ Esto es un lint, no una prueba de comportamiento: sólo impide que vuelva a aparecer
    // una QUINTA ventana escrita a mano, que es exactamente como nació este bug.
    const ventanaAMano = (src.match(/doc_date\s*[-+]\s*15\b/g) || [])
      .filter(() => true).length;
    t('ningún punto escribe su propia ventana de días a mano (lint)', ventanaAMano === 0,
      `${ventanaAMano} ocurrencias de "doc_date ± 15" fuera del predicado compartido`);

    const COMUN = `
      WITH shp AS (
        SELECT m.warehouse_id, m.doc_serie, m.folio, min(m.doc_date) d,
               sum(m.qty) qty, sum(m.amount) amt, max(m.dest_code) dest_code
        FROM analytics.stock_movements m WHERE m.doc_code='TrsfShip' GROUP BY 1,2,3
      ), shpd AS (
        SELECT s.*, dw.id dest_wh_id FROM shp s
        LEFT JOIN analytics.transfer_dest_map dm ON dm.dest_code = s.dest_code
        LEFT JOIN commercial.warehouses dw ON dw.id = dm.warehouse_id AND dw.deleted_at IS NULL
      ), rcv AS (
        SELECT m.warehouse_id, m.doc_serie, m.folio, m.parent_serie, m.parent_folio,
               min(m.doc_date) d, sum(m.qty) qty
        FROM analytics.stock_movements m
        WHERE m.doc_code='TrsfRcv' AND m.parent_group='41' GROUP BY 1,2,3,4,5
      ), cand AS (
        SELECT s.warehouse_id sw, s.doc_serie sserie, s.folio sfolio, s.d sd, s.qty sqty, s.amt,
               s.dest_code, s.dest_wh_id,
               r.warehouse_id rw, r.doc_serie rserie, r.folio rfolio, r.d rd, r.qty rqty,
               (s.dest_wh_id IS NOT NULL AND s.dest_wh_id = r.warehouse_id) dest_ok,
               (abs(r.qty - s.qty) < 0.01) qty_ok
        FROM shpd s JOIN rcv r
          ON r.parent_folio = s.folio
         AND coalesce(r.parent_serie,'') = coalesce(s.doc_serie,'')
         AND r.warehouse_id <> s.warehouse_id
      ), nuevo AS (
        SELECT DISTINCT ON (sw,sserie,sfolio) * FROM cand
        WHERE (dest_wh_id IS NOT NULL AND dest_wh_id = rw AND rd BETWEEN sd - ${W.early} AND sd + ${W.late})
           OR (dest_wh_id IS NULL AND rd BETWEEN sd AND sd + ${W.blind})
        ORDER BY sw,sserie,sfolio, abs(rqty-sqty), abs(rd-sd)
      ), viejo AS (
        SELECT DISTINCT ON (sw,sserie,sfolio) * FROM cand
        WHERE rd >= sd AND rd <= sd + 15
        ORDER BY sw,sserie,sfolio, abs(rqty-sqty), abs(rd-sd)
      )`;

    // ── 2. el caso que lo destapó ───────────────────────────────────────────────────────
    console.log('\n2) El documento que destapó el bug');
    const caso = (await db.raw(`${COMUN}
      SELECT rfolio, rd, rqty, sqty, dest_ok, (rd - sd) delta
      FROM nuevo WHERE sfolio='0000748' AND sserie='2' AND sd='2026-09-28'`)).rows[0];
    const existe = (await db.raw(`
      SELECT count(*)::int c FROM analytics.stock_movements
      WHERE doc_code='TrsfShip' AND folio='0000748' AND doc_serie='2' AND doc_date='2026-09-28'`)).rows[0].c;
    if (!existe) {
      declarar('salida CEDIS 0000748 del 2026-09-28', 'el documento ya no está en stock_movements');
    } else {
      t('la salida CEDIS 0000748 encuentra su recepción', !!caso,
        'sigue sin parear: es exactamente el bug reportado');
      if (caso) {
        t('pareó con la recepción 0000377', caso.rfolio === '0000377', `pareó con ${caso.rfolio}`);
        t('la cantidad cuadra al 0.01', Math.abs(n(caso.rqty) - n(caso.sqty)) < 0.01,
          `enviadas ${caso.sqty} / recibidas ${caso.rqty}`);
        t('el destino declarado lo respalda', caso.dest_ok === true);
        t('y la recepción está fechada ANTES que la salida (el caso que la regla vieja no podía ver)',
          Number(caso.delta) < 0, `delta = ${caso.delta} días`);
      }
    }

    // ── 3. la premisa de la regla nueva ─────────────────────────────────────────────────
    console.log('\n3) La PREMISA: la recepción puede fecharse antes que la salida');
    const prem = (await db.raw(`${COMUN}
      SELECT count(*)::int total, count(*) FILTER (WHERE rd < sd)::int negativos,
             min(rd - sd) peor, max(rd - sd) mayor
      FROM cand WHERE dest_ok AND qty_ok`)).rows[0];
    t('hay pares de alta confianza con desfase NEGATIVO', n(prem.negativos) > 0,
      'si esto llega a 0, la regla vieja era cierta y ésta sobra: revisar');
    t(`el desfase observado cabe en la ventana [-${W.early}, +${W.late}]`,
      n(prem.peor) >= -W.early && n(prem.mayor) <= W.late,
      `observado [${prem.peor}, ${prem.mayor}] sobre ${prem.total} pares de alta confianza`);
    console.log(`     ${prem.total} pares con los dos testigos · ${prem.negativos} negativos · rango [${prem.peor}, ${prem.mayor}] días`);

    // ── 4. prueba negativa con control positivo ─────────────────────────────────────────
    console.log('\n4) PRUEBA NEGATIVA: un embarque a RUTA no lo recibe una SUCURSAL');
    const neg = (await db.raw(`${COMUN}
      SELECT (SELECT count(*)::int FROM nuevo WHERE dest_code ~ '^RD') nuevo_rutas,
             (SELECT count(*)::int FROM viejo WHERE dest_code ~ '^RD') viejo_rutas,
             (SELECT round(sum(amt)::numeric,2) FROM viejo WHERE dest_code ~ '^RD') viejo_dinero,
             (SELECT count(*)::int FROM viejo WHERE dest_code ~ '^RD' AND qty_ok) viejo_rutas_qty_ok`)).rows[0];
    t('la regla nueva no parea ningún embarque a ruta con una recepción de sucursal',
      n(neg.nuevo_rutas) === 0, `${neg.nuevo_rutas} pareos`);
    t('CONTROL POSITIVO: la regla vieja sí los pareaba (si no, el detector no prueba nada)',
      n(neg.viejo_rutas) > 0, `la vieja pareaba ${neg.viejo_rutas}`);
    t('y ninguno de esos pareos viejos tenía cantidad exacta (eran falsos, no diferencias)',
      n(neg.viejo_rutas_qty_ok) === 0, `${neg.viejo_rutas_qty_ok} con cantidad exacta`);
    console.log(`     la regla vieja publicaba ${neg.viejo_rutas} embarques a ruta como recibidos en sucursal (${money(neg.viejo_dinero)})`);

    // ── 5. dos testigos independientes ──────────────────────────────────────────────────
    console.log('\n5) Los dos testigos (destino declarado / cantidad) son independientes y coinciden');
    const tst = (await db.raw(`${COMUN}
      SELECT count(*)::int qty_exacta,
             count(*) FILTER (WHERE dest_ok)::int tambien_destino,
             count(*) FILTER (WHERE dest_ok AND NOT qty_ok)::int destino_sin_qty
      FROM cand WHERE qty_ok`)).rows[0];
    const pct = n(tst.qty_exacta) ? (100 * n(tst.tambien_destino) / n(tst.qty_exacta)) : 0;
    t('≥99 % de los pares con cantidad exacta también coinciden en destino', pct >= 99,
      `${pct.toFixed(2)} % (${tst.tambien_destino}/${tst.qty_exacta})`);
    t('pero NO al 100 %: si coincidieran siempre, uno derivaría del otro y no sería un 2º testigo',
      pct < 100, `${pct.toFixed(2)} % — revisar que el destino no se esté infiriendo del pareo`);

    // ── 6. la calidad del pareo sube ────────────────────────────────────────────────────
    console.log('\n6) Antes/después: el pareo no empeora');
    const ad = (await db.raw(`${COMUN}
      SELECT (SELECT count(*)::int FROM viejo) v_total, (SELECT count(*)::int FROM nuevo) n_total,
             (SELECT count(*)::int FROM viejo WHERE qty_ok) v_exact,
             (SELECT count(*)::int FROM nuevo WHERE qty_ok) n_exact,
             (SELECT count(*)::int FROM nuevo x WHERE NOT EXISTS
                (SELECT 1 FROM viejo y WHERE (y.sw,y.sserie,y.sfolio)=(x.sw,x.sserie,x.sfolio))) rescatados,
             (SELECT round(sum(amt)::numeric,2) FROM nuevo x WHERE NOT EXISTS
                (SELECT 1 FROM viejo y WHERE (y.sw,y.sserie,y.sfolio)=(x.sw,x.sserie,x.sfolio))) rescatado_dinero,
             (SELECT count(*)::int FROM viejo y WHERE NOT EXISTS
                (SELECT 1 FROM nuevo x WHERE (y.sw,y.sserie,y.sfolio)=(x.sw,x.sserie,x.sfolio)) AND y.qty_ok) soltados_con_qty`)).rows[0];
    t('los pareos con cantidad exacta no bajan', n(ad.n_exact) >= n(ad.v_exact),
      `antes ${ad.v_exact}, ahora ${ad.n_exact}`);
    t('no se suelta NINGÚN pareo que tuviera cantidad exacta', n(ad.soltados_con_qty) === 0,
      `${ad.soltados_con_qty} soltados con cantidad exacta: eso sí sería una pérdida`);
    console.log(`     pareos ${ad.v_total} → ${ad.n_total} · con cantidad exacta ${ad.v_exact} → ${ad.n_exact} · rescatados ${ad.rescatados} (${money(ad.rescatado_dinero)})`);

    // ── 7. no fabrica pares ─────────────────────────────────────────────────────────────
    console.log('\n7) El desempate no fabrica pares (casi 1:1)');
    const uni = (await db.raw(`${COMUN}
      SELECT count(*)::int recepciones, count(*) FILTER (WHERE k > 1)::int reclamadas_por_varias
      FROM (SELECT count(*) k FROM nuevo GROUP BY rw, rserie, rfolio) z`)).rows[0];
    const pctDup = n(uni.recepciones) ? (100 * n(uni.reclamadas_por_varias) / n(uni.recepciones)) : 0;
    t('menos del 1 % de las recepciones es reclamada por más de una salida', pctDup < 1,
      `${uni.reclamadas_por_varias}/${uni.recepciones} = ${pctDup.toFixed(2)} %`);

    // ── 8. lo que NO se arregló, medido ─────────────────────────────────────────────────
    console.log('\n8) Borde de rango del Cuadre (abierto, se MIDE y se declara)');
    const borde = (await db.raw(`
      WITH shp AS (
        SELECT m.warehouse_id, m.doc_serie, m.folio, min(m.doc_date) d, sum(m.amount) amt, max(m.dest_code) dest_code
        FROM analytics.stock_movements m
        WHERE m.doc_code='TrsfShip' AND m.doc_date >= date_trunc('month', now() - interval '1 month')::date
          AND m.doc_date < date_trunc('month', now())::date GROUP BY 1,2,3
      ), shpd AS (
        SELECT s.*, dw.id dest_wh_id FROM shp s
        LEFT JOIN analytics.transfer_dest_map dm ON dm.dest_code=s.dest_code
        LEFT JOIN commercial.warehouses dw ON dw.id=dm.warehouse_id AND dw.deleted_at IS NULL
      ), rcv AS (
        SELECT m.warehouse_id, m.parent_serie, m.parent_folio, min(m.doc_date) d
        FROM analytics.stock_movements m WHERE m.doc_code='TrsfRcv' AND m.parent_group='41' GROUP BY 1,2,3
      ), e AS (
        SELECT s.amt,
               bool_or(r.d >= date_trunc('month', now() - interval '1 month')::date
                   AND r.d <  date_trunc('month', now())::date) en_rango
        FROM shpd s JOIN rcv r
          ON r.parent_folio=s.folio AND coalesce(r.parent_serie,'')=coalesce(s.doc_serie,'')
         AND r.warehouse_id <> s.warehouse_id
         AND ((s.dest_wh_id IS NOT NULL AND s.dest_wh_id=r.warehouse_id AND r.d BETWEEN s.d - ${W.early} AND s.d + ${W.late})
           OR (s.dest_wh_id IS NULL AND r.d BETWEEN s.d AND s.d + ${W.blind}))
        GROUP BY s.warehouse_id, s.doc_serie, s.folio, s.amt
      )
      SELECT count(*) FILTER (WHERE NOT en_rango)::int docs,
             round(sum(amt) FILTER (WHERE NOT en_rango)::numeric,2) dinero FROM e`)).rows[0];
    declarar('falsos "sin recepción" por el borde del rango (mes anterior completo)',
      `${borde.docs} documentos · ${money(borde.dinero)} · recibidos, pero su recepción cae fuera del rango que se mira`);

    console.log(`\n── ${ok} ✓ · ${bad} ✗ · ${nm} no medidos ──\n`);
  } catch (e) {
    console.error('ERROR:', e.message);
    bad++;
  } finally {
    await db.destroy();
  }
  process.exit(bad ? 1 : 0);
})();
