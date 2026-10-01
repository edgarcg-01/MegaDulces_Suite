/* eslint-disable no-console */
/**
 * `[DM.19]` CANDADO del ORIGEN de una orden de entrada.
 *
 * ── QUÉ PROTEGE ─────────────────────────────────────────────────────────────────────────────
 * Que no se le carguen al CEDIS compras que fueron de otra plaza. Reportado por Edgar el
 * 2026-10-01: *"antes Morelia Abastos y CEDIS subían sus órdenes de entrada a Kepler ... para
 * que no se le cargue información a CEDIS que no le corresponde"*.
 *
 * ── LAS TRES COSAS QUE PUEDEN ROMPERSE EN SILENCIO ──────────────────────────────────────────
 *  1. **El join por código solo.** `C-010` es "MORELIA ABAST" en la rama `00` y "PADRE HIDALGO"
 *     en la `01`. Un join sin `sucursal` mezcla las dos y nadie se entera.
 *  2. **El umbral de evidencia.** Si se afloja, vuelve el bug de `[DM.11e]`: una plaza elegida
 *     con 13% de evidencia. El candado lo prueba con filas REALES que están de los dos lados.
 *  3. **El camino autoritativo contra el testigo.** Un centro que no es de compra (COMISIONES
 *     VENTAS) tiene evidencia alta y NO debe publicar origen.
 *
 * Y lo que no se puede medir se declara: la cobertura va SIEMPRE en pantalla (ADR-056).
 *
 *   DATABASE_URL_NEW=<prod> node database/tests/test-newdb-goods-receipt-origin.js
 */
const { Client } = require('pg');

const URL = process.env.DATABASE_URL_NEW || process.env.PROD_DB_URL || process.env.DST_URL
  || (() => { throw new Error('falta la URL de la DB destino: exporta DATABASE_URL_NEW'); })();

let ok = 0, fail = 0, nomedido = 0;
const pass = (m) => { ok++; console.log('  ✔', m); };
const bad = (m) => { fail++; console.log('  x FALLA:', m); };
const skip = (m) => { nomedido++; console.log('  ~ NO MEDIDO:', m); };
const money = (n) => '$' + Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

(async () => {
  const db = new Client({ connectionString: URL, ssl: /rlwy|railway\.app|proxy\.rlwy/i.test(URL) ? { rejectUnauthorized: false } : false });
  await db.connect();
  const q = async (sql, p = []) => (await db.query(sql, p)).rows;
  try {
    await db.query(`SET statement_timeout = '180s'`);
    console.log(`\n[DM.19] Origen de una orden de entrada · ${(await q('SELECT current_database() d'))[0].d}`);

    // ── 1. Las dos vistas, con security_invoker y GRANT ───────────────────────────────────
    console.log('\n[1] Las vistas existen, son security_invoker y app_runtime las puede leer');
    const meta = await q(
      `SELECT c.relname,
              EXISTS (SELECT 1 FROM pg_options_to_table(c.reloptions) o
                       WHERE o.option_name='security_invoker' AND o.option_value='true') AS inv,
              has_table_privilege('app_runtime', c.oid, 'SELECT') AS grant_ok
         FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname='analytics'
          AND c.relname IN ('v_erp_purchase_center','v_erp_goods_receipt_origin')`);
    for (const nombre of ['v_erp_purchase_center', 'v_erp_goods_receipt_origin']) {
      const m = meta.find((x) => x.relname === nombre);
      // Los dos juntos: un CREATE OR REPLACE VIEW no hereda ni la opcion ni el permiso, y la
      // omision no se nota hasta que alguien abre la pantalla con el rol de la app.
      if (!m) bad(`analytics.${nombre} NO existe: falta la migración 20261001260000.`);
      else if (m.inv && m.grant_ok) pass(`${nombre}: security_invoker = true y GRANT a app_runtime.`);
      else bad(`${nombre}: security_invoker=${m.inv} · grant=${m.grant_ok} (los dos se pierden en un CREATE OR REPLACE).`);
    }

    // ── 2. El catálogo de centros de compra de la rama 00 ─────────────────────────────────
    console.log('\n[2] Los centros de compra de la sucursal 00, como los nombra el ERP');
    const centros = await q(
      `SELECT centro_code, centro_desc, plaza_dominante, evidencia_total, evidencia_pct,
              plaza_warehouse_name, es_centro_propio
         FROM analytics.v_erp_purchase_center
        WHERE sucursal='00' AND es_centro_de_plaza ORDER BY centro_code`);
    if (!centros.length) {
      bad('la sucursal 00 no declara ningún centro de compra de plaza: el decode se rompió.');
    } else {
      centros.forEach((c) => console.log(
        `     ${c.centro_code.padEnd(6)} ${String(c.centro_desc).padEnd(32)}`
        + ` plaza ${String(c.plaza_dominante ?? '-').padStart(2)} · ${String(c.evidencia_pct ?? '-').padStart(5)}%`
        + ` n=${String(c.evidencia_total ?? 0).padStart(4)} → ${c.plaza_warehouse_name || '(sin nombre: evidencia corta)'}`
        + (c.es_centro_propio ? '  ⬅ PROPIO' : '')));
      const propios = centros.filter((c) => c.es_centro_propio);
      if (propios.length === 1 && propios[0].centro_code === 'C-001') {
        pass('exactamente UN centro propio y es C-001 "COMPRA PROVEEDOR CEDIS".');
      } else if (propios.length !== 1) {
        bad(`la sucursal 00 tiene ${propios.length} centros propios (esperado 1): sin un propio único`
          + ' no se puede decir qué es "de otra plaza".');
      } else {
        bad(`el centro propio salió ${propios[0].centro_code} "${propios[0].centro_desc}", no C-001.`);
      }
    }

    // ── 3. NEGATIVO: el catálogo COLISIONA entre ramas ────────────────────────────────────
    console.log('\n[3] Prueba negativa · el mismo código significa cosas distintas según la rama');
    const colision = await q(
      `SELECT sucursal, centro_code, centro_desc FROM analytics.v_erp_purchase_center
        WHERE centro_code='C-010' ORDER BY sucursal`);
    colision.forEach((r) => console.log(`     rama ${r.sucursal} · ${r.centro_code} = ${r.centro_desc}`));
    if (colision.length < 2) {
      skip(`sólo ${colision.length} rama(s) declaran C-010: hoy no hay colisión que comprobar`
        + ' — el join por sucursal sigue siendo obligatorio, pero esta prueba no lo demuestra.');
    } else if (new Set(colision.map((r) => r.centro_desc)).size > 1) {
      pass(`${colision.length} ramas declaran C-010 con ${new Set(colision.map((r) => r.centro_desc)).size}`
        + ' descripciones distintas: un join por código solo las mezclaría.');
    } else {
      bad('las ramas coinciden en C-010: esta prueba dejó de demostrar la colisión, revisar el decode.');
    }

    // ── 4. NEGATIVO: el umbral de evidencia tiene dientes, con filas REALES ───────────────
    console.log('\n[4] Prueba negativa · el umbral (n ≥ 20 y ≥ 90%) frena de los dos lados');
    const porPct = centros.find((c) => Number(c.evidencia_pct) < 90 && Number(c.evidencia_total) > 0);
    const porN = centros.find((c) => Number(c.evidencia_pct) >= 90 && Number(c.evidencia_total) < 20);
    const resuelto = centros.find((c) => c.plaza_warehouse_name);
    if (!porPct && !porN) {
      skip('hoy no hay ningún centro por debajo del umbral: no se puede demostrar que frene'
        + ' — si todos pasan, un umbral flojo se vería igual de verde.');
    } else {
      let bien = true;
      if (porPct) {
        const txt = `${porPct.centro_code} (${porPct.evidencia_pct}% sobre ${porPct.evidencia_total})`;
        if (porPct.plaza_warehouse_name) { bad(`${txt} resolvió a "${porPct.plaza_warehouse_name}" con menos del 90%: es el bug de [DM.11e].`); bien = false; }
        else console.log(`     ${txt} → no resuelve, por porcentaje. Correcto.`);
      }
      if (porN) {
        const txt = `${porN.centro_code} (${porN.evidencia_pct}% pero sólo ${porN.evidencia_total} filas)`;
        if (porN.plaza_warehouse_name) { bad(`${txt} resolvió con muestra insuficiente: 10 de 11 no es evidencia.`); bien = false; }
        else console.log(`     ${txt} → no resuelve, por tamaño de muestra. Correcto.`);
      }
      if (!resuelto) { bad('ningún centro resuelve: el umbral está tan duro que la vista no sirve.'); bien = false; }
      else console.log(`     ${resuelto.centro_code} (${resuelto.evidencia_pct}% sobre ${resuelto.evidencia_total}) → "${resuelto.plaza_warehouse_name}". Correcto.`);
      if (bien) pass('el umbral frena por porcentaje y por tamaño de muestra, y deja pasar lo que sí tiene evidencia.');
    }

    // ── 5. NEGATIVO: un centro que no es de compra NO publica origen ──────────────────────
    console.log('\n[5] Prueba negativa · evidencia alta no basta: el centro tiene que ser de compra');
    const [noCompra] = await q(
      `SELECT pc.centro_code, pc.centro_desc, pc.evidencia_pct, pc.plaza_warehouse_name,
              count(*)::int docs,
              count(o.origen_warehouse_id)::int con_origen
         FROM analytics.v_erp_purchase_center pc
         JOIN analytics.v_erp_goods_receipt_origin o
           ON o.sucursal=pc.sucursal AND o.centro_code=pc.centro_code
        WHERE pc.sucursal='00' AND NOT pc.es_centro_de_plaza
          AND pc.evidencia_pct >= 90 AND pc.evidencia_total >= 20
        GROUP BY 1,2,3,4 ORDER BY 5 DESC LIMIT 1`);
    if (!noCompra) {
      skip('no hay ningún centro "no de compra" con evidencia alta: no se puede comprobar la separación.');
    } else if (noCompra.con_origen === 0) {
      pass(`"${noCompra.centro_desc}" tiene ${noCompra.evidencia_pct}% de evidencia hacia`
        + ` ${noCompra.plaza_warehouse_name || 'una plaza'} y sus ${noCompra.docs} documentos`
        + ' NO publican origen: la evidencia se ve, pero no se cobra como compra.');
    } else {
      bad(`"${noCompra.centro_desc}" publica origen en ${noCompra.con_origen} de ${noCompra.docs} documentos:`
        + ' un consumidor le cargaría comisiones a esa plaza como si fueran compras.');
    }

    // ── 6. El testigo independiente, con PLACEBO ──────────────────────────────────────────
    console.log('\n[6] Testigo fuera de Kepler (Wincaja) · con su placebo');
    const cruce = await q(
      `WITH wv AS (
         SELECT source_branch AS rama, fecha::date AS f,
                (valor+COALESCE(iva,0)+COALESCE(ieps,0))::numeric AS v
           FROM wincaja.movimiento_proveedores WHERE tipo='CR'),
       k AS (
         SELECT o.centro_code, o.origen_warehouse_code, o.receipt_date AS f, o.importe AS imp
           FROM analytics.v_erp_goods_receipt_origin o
          WHERE o.sucursal='00' AND o.centro_code IN ('C-010','C-001')
            AND o.receipt_date BETWEEN '2026-01-01' AND '2026-09-17')
       SELECT k.centro_code, count(*)::int docs,
              count(*) FILTER (WHERE EXISTS (
                SELECT 1 FROM wv x WHERE x.rama='30' AND abs(x.v-k.imp)<1 AND abs(x.f-k.f)<=3))::int casan_rama30
         FROM k GROUP BY 1`);
    const abastos = cruce.find((r) => r.centro_code === 'C-010');
    const cedis = cruce.find((r) => r.centro_code === 'C-001');
    if (!abastos || !cedis || !abastos.docs || !cedis.docs) {
      skip('no hay documentos de C-010 y C-001 en la ventana con réplica Wincaja: sin par control no se mide.');
    } else {
      const pA = 100 * abastos.casan_rama30 / abastos.docs;
      const pC = 100 * cedis.casan_rama30 / cedis.docs;
      console.log(`     C-010 (Morelia Abastos) casa con la rama 30 de Wincaja: ${pA.toFixed(1)}% (${abastos.casan_rama30}/${abastos.docs})`);
      console.log(`     C-001 (CEDIS) contra esa MISMA rama, el placebo:        ${pC.toFixed(1)}% (${cedis.casan_rama30}/${cedis.docs})`);
      // Sin el placebo, un 62% no significa nada: podria ser el piso de ruido del cruce por importe.
      if (pA >= 20 && pA >= pC * 5) {
        pass(`la señal es ${(pA / Math.max(pC, 0.01)).toFixed(0)}× el piso de ruido: el centro del ERP y el otro ERP coinciden.`);
      } else if (pA < 20) {
        bad(`sólo ${pA.toFixed(1)}% de los documentos de Morelia Abastos aparecen en su propia rama Wincaja:`
          + ' el decode de c12 perdió respaldo externo.');
      } else {
        bad(`el placebo subió a ${pC.toFixed(1)}% contra ${pA.toFixed(1)}% de la señal: el cruce por importe`
          + ' dejó de discriminar y esta verificación ya no prueba nada.');
      }
    }

    // ── 7. Los dos testigos concuerdan donde los dos hablan ───────────────────────────────
    console.log('\n[7] El centro del ERP contra la referencia del proveedor, fila por fila');
    const [conc] = await q(
      `SELECT count(*)::int ambos,
              count(*) FILTER (WHERE testigos_concuerdan)::int de_acuerdo
         FROM analytics.v_erp_goods_receipt_origin
        WHERE sucursal='00' AND testigos_concuerdan IS NOT NULL`);
    if (!conc || !conc.ambos) {
      skip('no hay documentos donde hablen los dos testigos.');
    } else {
      const pct = 100 * conc.de_acuerdo / conc.ambos;
      console.log(`     ${conc.de_acuerdo} de ${conc.ambos} coinciden (${pct.toFixed(1)}%).`);
      if (pct >= 95) pass(`los dos testigos coinciden en ${pct.toFixed(1)}%: el centro del ERP no es una etiqueta suelta.`);
      else bad(`sólo coinciden en ${pct.toFixed(1)}%: uno de los dos dejó de medir lo que creemos.`);
    }

    // ── 8. La cobertura, SIEMPRE declarada ────────────────────────────────────────────────
    console.log('\n[8] Cobertura declarada (lo que no se puede atribuir no se da por CEDIS)');
    const cob = await q(
      `SELECT origen_veredicto, count(*)::int n, sum(importe) imp
         FROM analytics.v_erp_goods_receipt_origin WHERE sucursal='00'
        GROUP BY 1 ORDER BY 3 DESC NULLS LAST`);
    if (!cob.length) { skip('la vista no devolvió filas para la sucursal 00.'); }
    else {
      const tot = cob.reduce((s, r) => s + r.n, 0);
      const dinero = cob.reduce((s, r) => s + Number(r.imp || 0), 0);
      cob.forEach((r) => console.log(`     ${String(r.origen_veredicto).padEnd(28)} ${String(r.n).padStart(5)}  ${money(r.imp)}`));
      const noCedis = cob.filter((r) => r.origen_veredicto.startsWith('otra_plaza'));
      const sinDecir = cob.filter((r) => ['sin_centro', 'centro_no_dice_plaza', 'centro_fuera_de_catalogo'].includes(r.origen_veredicto));
      const sumN = (a) => a.reduce((s, r) => s + r.n, 0);
      const sumI = (a) => a.reduce((s, r) => s + Number(r.imp || 0), 0);
      console.log(`     → ${sumN(noCedis)} documentos por ${money(sumI(noCedis))} NO son del CEDIS.`);
      console.log(`     → ${sumN(sinDecir)} documentos por ${money(sumI(sinDecir))} NO se pueden atribuir`
        + ` (${(100 * sumN(sinDecir) / tot).toFixed(1)}% de los documentos, ${(100 * sumI(sinDecir) / dinero).toFixed(1)}% del dinero).`);
      console.log('       Eso es un hueco de DATOS, no un veredicto de que sean del CEDIS.');
      // No se exige umbral de cobertura: hoy es la que es, y ponerle un numero "aceptable" seria
      // inventar. Lo que se exige es que el bucket EXISTA y se publique.
      if (cob.some((r) => r.origen_veredicto === 'sin_centro' || r.origen_veredicto === 'centro_no_dice_plaza')) {
        pass(`los ${tot} documentos están clasificados y el hueco se publica aparte, con su monto.`);
      } else {
        bad('no existe ningún bucket de "no se puede atribuir": el hueco se está escondiendo en otro veredicto.');
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
