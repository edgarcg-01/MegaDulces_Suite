/* eslint-disable no-console */
/**
 * `[VSO.6]` CANDADO — cuando una plaza cambia de ERP, sus VENDEDORES no se parten en dos columnas.
 *
 * ── POR QUÉ ──────────────────────────────────────────────────────────────────────────────────
 * Al cruzar el cutover, el mismo humano cambia de código: en Wincaja es `sucursal:numero` (`30:74`)
 * y en Kepler `sucursal:codigo` (`08:20003`). `analytics.vendor_identity` existe para colapsarlos a
 * UNA columna — y nadie la actualizó cuando Madero (`32`→`07`, 09-08) y Abastos (`30`→`08`, 09-19)
 * migraron. Medido en prod el 2026-09-28: **cinco personas con dos columnas**, la mayor de ellas un
 * vendedor de **$47.9M** cuya columna se corta el 18-sep y reaparece con otro nombre al día
 * siguiente. No falló ningún dato: faltó una fila de catálogo que nadie tenía por qué recordar.
 *
 * ── EL DETECTOR, Y POR QUÉ NO ES POR NOMBRE IGUAL ───────────────────────────────────────────
 * Agrupar por nombre idéntico encuentra 3 de 6. Está mal por construcción: **lo que cambia al
 * cruzar de ERP es justamente el nombre** (`MANUEL GARCIA ZURITA` → `MANUEL DI STEFANO GARCIA
 * ZURIT`, `GLORIA` → `GLORIA  CALDERON`, `Plasencia` → `PLACENCIA`). Acá se comparan **tokens** de
 * ≥5 letras, quitando las palabras de plaza, entre quien TERMINA del lado Wincaja y quien ARRANCA
 * del lado Kepler en el MISMO almacén. Un token compartido ya es candidato.
 *
 * ── LO QUE ESTE CANDADO NO VE, DECLARADO ────────────────────────────────────────────────────
 * ⛔ **Un par donde el lado Kepler se llama como la RUTA y no como la persona.** Candy Salgado es
 *    ese caso (`10:41` "CANDY SALGADO" contra `01:1V001` "RUTA VECINAL PH 01"): cero tokens en
 *    común, invisible para cualquier matcher de nombres. Sólo lo encuentra un humano.
 * ⛔ **Los pares por debajo del piso de dinero** (Wincaja $100k / Kepler $10k de por vida). El piso
 *    está para que el candado no grite por un vendedor de un día; su costo es que una partición
 *    chica pasa sin verse. Es una decisión, no un descuido.
 *
 *   DATABASE_URL_NEW=… node database/tests/test-newdb-vendor-identity-cutover.js
 */
const { Client } = require('pg');

const URL = process.env.DATABASE_URL_NEW || process.env.DST_URL || process.env.FLEET_DB_URL
  || (() => { throw new Error('falta la URL de la DB destino: exporta DATABASE_URL_NEW o FLEET_DB_URL'); })();

/** Piso de dinero, declarado arriba. */
const PISO_WIN = 100000;
const PISO_KEP = 10000;
/** Palabras que nombran una PLAZA o un genérico, no a una persona. */
const STOP = ['VENTA', 'VENTAS', 'PISO', 'SUCURSAL', 'MORELIA', 'ABASTOS', 'MADERO', 'RUTA',
  'VECINAL', 'HIDALGO', 'CANINDO', 'PIEDAD', 'CENTRO', 'ESQUINAS', 'YURECUARO', 'ZAMORA'];

let ok = 0; let fail = 0; let nm = 0;
const check = (label, cond, detail = '') => {
  if (cond) { ok++; console.log(`  ✔ ${label}`); }
  else { fail++; console.log(`  ✖ ${label}${detail ? ` — ${detail}` : ''}`); }
};
const noMedido = (label, motivo) => { nm++; console.log(`  ⓘ NO MEDIDO · ${label} — ${motivo}`); };
const money = (n) => `$${Number(n || 0).toLocaleString('en-US', { maximumFractionDigits: 0 })}`;

/** Los pares candidatos: misma plaza, uno termina y el otro arranca en el corte, tokens en común. */
const SQL_PARES = `
-- ⛔ kepler_code y NO warehouse_code (ojo: sin acentos graves acá, esto vive dentro de un
-- template literal). Medido en prod 2026-09-28: la columna warehouse_code de
-- analytics.v_branch_erp_cutover MEZCLA DOS CONVENCIONES — en las dos migraciones recientes
-- trae el código de Kepler ('07','08') y en las tres viejas trae el nombre del almacén Wincaja
-- ('MD-10','MD-42','MD-50'), que NO existe en ninguna de las dos matvistas. Con warehouse_code
-- este JOIN devolvía CERO para 3 de las 5 plazas con corte — las dos más grandes incluidas
-- (rama 10: 841,204 filas Wincaja · rama 50: 634,251) — y el test publicaba OK sobre las 2 que
-- sí matcheaban, sin decir que se saltó el 60 % del universo. kepler_code matchea las DOS
-- matvistas en las CINCO ramas.
WITH cut AS (SELECT kepler_code wc, cutover_date cd FROM analytics.v_branch_erp_cutover
              WHERE cutover_date > '-infinity'),
     w AS (SELECT warehouse_code wc, vendor_code vc, max(vendor_name) nm,
                  max(business_date) ult, sum(monto) m
             FROM analytics.mv_wincaja_sales_daily WHERE product_deleted = false
            GROUP BY 1,2 HAVING sum(monto) > $1),
     k AS (SELECT warehouse_code wc, vendor_code vc, max(vendor_name) nm,
                  min(business_date) pri, sum(monto) m
             FROM analytics.mv_kepler_sales_daily WHERE product_deleted = false
            GROUP BY 1,2 HAVING sum(monto) > $2),
     tw AS (SELECT w.*, ARRAY(SELECT t FROM unnest(string_to_array(upper(translate(w.nm,'ÁÉÍÓÚÑ','AEIOUN')),' ')) t
                               WHERE length(t) >= 5 AND t <> ALL($3::text[])) tt FROM w),
     tk AS (SELECT k.*, ARRAY(SELECT t FROM unnest(string_to_array(upper(translate(k.nm,'ÁÉÍÓÚÑ','AEIOUN')),' ')) t
                               WHERE length(t) >= 5 AND t <> ALL($3::text[])) tt FROM k)
SELECT c.wc AS plaza, c.cd AS corte,
       tw.vc AS win_code, tw.nm AS win_name, tw.m AS win_monto,
       tk.vc AS kep_code, tk.nm AS kep_name, tk.m AS kep_monto,
       cardinality(ARRAY(SELECT unnest(tw.tt) INTERSECT SELECT unnest(tk.tt))) AS tokens,
       COALESCE(vw.canonical_key, tw.vc) AS win_key,
       COALESCE(vk.canonical_key, tk.vc) AS kep_key
  FROM cut c
  JOIN tw ON tw.wc = c.wc AND tw.ult <  c.cd
  JOIN tk ON tk.wc = c.wc AND tk.pri >= c.cd
  LEFT JOIN analytics.vendor_identity vw
         ON vw.source_branch = split_part(tw.vc, ':', 1) AND vw.vendedor = split_part(tw.vc, ':', 2)
  LEFT JOIN analytics.vendor_identity vk
         ON vk.source_branch = split_part(tk.vc, ':', 1) AND vk.vendedor = split_part(tk.vc, ':', 2)
 WHERE cardinality(ARRAY(SELECT unnest(tw.tt) INTERSECT SELECT unnest(tk.tt))) > 0
 ORDER BY c.wc, tokens DESC`;

(async () => {
  const c = new Client({ connectionString: URL, ssl: /rlwy|railway|proxy/i.test(URL) ? { rejectUnauthorized: false } : false });
  await c.connect();
  const q = (s, p) => c.query(s, p).then((r) => r.rows);
  const dest = (await q(`SELECT current_database() d, (SELECT system_identifier FROM pg_control_system()) sid`))[0];
  console.log(`\n=== VENDEDOR · la identidad sobrevive al cambio de ERP (base "${dest.d}" · sysid ${dest.sid}) ===\n`);

  const hay = async (rel) => (await q(`SELECT to_regclass($1) r`, [rel]))[0].r !== null;
  console.log('0 · HAY CON QUÉ MEDIR');
  const listo = (await hay('analytics.vendor_identity'))
    && (await hay('analytics.v_branch_erp_cutover'))
    && (await hay('analytics.mv_wincaja_sales_daily'))
    && (await hay('analytics.mv_kepler_sales_daily'));
  check('existen vendor_identity, el resolvedor de corte y las dos matvistas', listo);
  if (!listo) {
    noMedido('la identidad sobrevive al corte', 'falta alguno de los cuatro objetos en este destino');
    await c.end(); process.exit(fail ? 1 : 0);
  }

  // ── 1. Cada par candidato resuelve a la MISMA clave ──────────────────────────────────────
  console.log('\n1 · PARES A TRAVÉS DEL CORTE (mismo almacén, apellido en común)');

  // ⭐ ANTES DE JUZGAR, DECLARAR CUÁNTO SE ALCANZA A VER. Este bloque nació midiendo 2 de 5
  // plazas y reportando ✔ igual, porque la llave del JOIN no existía en las otras 3. Un
  // universo recortado en silencio se lee idéntico a un universo sano (ADR-056).
  const cob = await q(
    `SELECT c.kepler_code kc, c.cutover_date::text cd,
            (SELECT count(*) FROM analytics.mv_wincaja_sales_daily x WHERE x.warehouse_code=c.kepler_code) w,
            (SELECT count(*) FROM analytics.mv_kepler_sales_daily  x WHERE x.warehouse_code=c.kepler_code) k
       FROM analytics.v_branch_erp_cutover c
      WHERE c.cutover_date > '-infinity' ORDER BY 1`);
  const ciegas = cob.filter((r) => Number(r.w) === 0 || Number(r.k) === 0);
  console.log(`  ⓘ ${cob.length} plaza(s) con corte real · alcanzables a los dos lados: ${cob.length - ciegas.length}`);
  check('toda plaza con corte tiene venta de los DOS ERPs bajo la misma llave', ciegas.length === 0,
    ciegas.map((r) => `${r.kc} (corte ${r.cd}): wincaja ${r.w} / kepler ${r.k}`).join(' · '));

  const pares = await q(SQL_PARES, [PISO_WIN, PISO_KEP, STOP]);
  if (!pares.length) {
    noMedido('cada par resuelve a una sola identidad',
      `no hay pares candidatos en este destino (pisos: Wincaja ${money(PISO_WIN)} / Kepler ${money(PISO_KEP)}). `
      + 'Sin pares, "cero partidos" es cierto y no prueba nada');
  } else {
    const partidos = pares.filter((p) => p.win_key !== p.kep_key);
    console.log(`  ⓘ ${pares.length} par(es) candidato(s) en ${new Set(pares.map((p) => p.plaza)).size} plaza(s) con corte`);
    check('todo par a través del corte resuelve a UNA sola identidad', partidos.length === 0,
      partidos.map((p) => `plaza ${p.plaza}: ${p.win_code} "${p.win_name.trim()}" (${money(p.win_monto)}, key ${p.win_key})`
        + ` ≠ ${p.kep_code} "${p.kep_name.trim()}" (${money(p.kep_monto)}, key ${p.kep_key})`).join(' · '));
    for (const p of pares.filter((x) => x.win_key === x.kep_key)) {
      console.log(`     ✓ ${p.plaza} · ${p.win_code} + ${p.kep_code} → ${p.win_key} (${p.tokens} token${p.tokens > 1 ? 's' : ''})`);
    }
  }

  // ── 2. NEGATIVA: romperlo a propósito ────────────────────────────────────────────────────
  // Sin esto el bloque 1 es una intención. Se rompe UNA fila dentro de una transacción que SIEMPRE
  // se revierte, y se comprueba que el detector real (no una copia de su lógica) la señala.
  console.log('\n2 · PRUEBA NEGATIVA (el detector tiene dientes)');
  if (!pares.length) {
    noMedido('romper una identidad pone el bloque 1 en rojo', 'no hay pares que romper en este destino');
  } else {
    const victima = pares.find((p) => p.win_key === p.kep_key);
    if (!victima) {
      noMedido('romper una identidad pone el bloque 1 en rojo', 'no hay ningún par SANO que romper');
    } else {
      let detecto = null;
      try {
        await c.query('BEGIN');
        await c.query(`SET LOCAL lock_timeout = '5s'`);
        await c.query(
          `UPDATE analytics.vendor_identity SET canonical_key = canonical_key || '-ROTO'
            WHERE source_branch = $1 AND vendedor = $2`,
          [victima.kep_code.split(':')[0], victima.kep_code.split(':')[1]]);
        const otra = await c.query(SQL_PARES, [PISO_WIN, PISO_KEP, STOP]);
        detecto = otra.rows.some((p) => p.kep_code === victima.kep_code && p.win_key !== p.kep_key);
      } finally {
        await c.query('ROLLBACK');
      }
      check(`al romper la identidad de ${victima.kep_code}, el bloque 1 lo señala`, detecto === true,
        'el detector NO lo vio: el bloque 1 no protege nada');
      const vuelta = await q(
        `SELECT canonical_key k FROM analytics.vendor_identity WHERE source_branch=$1 AND vendedor=$2`,
        [victima.kep_code.split(':')[0], victima.kep_code.split(':')[1]]);
      check('el ROLLBACK dejó la identidad intacta', vuelta.length > 0 && !vuelta[0].k.endsWith('-ROTO'),
        `quedó ${vuelta[0] ? vuelta[0].k : '(sin fila)'} — revisar a mano`);
    }
  }

  await c.end();
  const resumen = `${ok} OK · ${fail} falla(s)` + (nm ? ` · ${nm} NO MEDIDO(S)` : '');
  console.log(`\n  ${fail ? '✖' : '✅'} ${resumen}\n`);
  if (nm) console.log('  ⓘ "NO MEDIDO" no es "pasó": es que en este destino no había con qué comprobarlo.\n');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
