#!/usr/bin/env node
/*
 * RE.14 — **Backfill del apareo de gemelas**: la misma recepción capturada dos veces, una en el
 * Kepler de la sucursal y otra en el de **oficinas** (9.95, sucursal '00').
 *
 * La CANÓNICA es siempre la de sucursal: es la que trae los productos y la que movió inventario.
 * La de oficinas es una **captura contable**: casi siempre un solo renglón de concepto
 * ("VENTAS AL 0 %", SKU 0000x) con el total, sin detalle. Ese rasgo estructural es el que permite
 * ocultarla sin riesgo — un documento de puro concepto no puede ser una recepción por su cuenta.
 *
 * Por qué no alcanza un predicado de igualdad (medido sobre la data, 2026-08):
 *   - los dos servidores capturan por separado → el total no siempre casa al centavo
 *     (HERSHEY 2026-08-17: sucursal 06 $79,009.21 vs oficinas $79,007.79, $1.42) y la fecha se corre;
 *   - **el nombre del proveedor no es la misma llave**: cada servidor tiene su catálogo
 *     (`DIONICIO CALDERON` en sucursal = `BOTANAS CALDERON` en oficinas, mismo día y mismo importe).
 *
 * ⚠️ **Este script ya NO define cómo se aparea.** La cascada de reglas, el pareo 1:1 y las dos
 * puertas para aplicar sin humano viven en la DB (`analytics.fn_goods_receipt_twin_candidates` y
 * `analytics.fn_pair_goods_receipts`, migración `20260827170000`), porque hay tres consumidores
 * del mismo apareo —el cron de la API, este CLI y el smoke— y dos copias del SQL divergen tarde o
 * temprano justo en la pieza que decide qué dinero deja de contarse.
 *
 * **En operación normal no hace falta correrlo**: el cron de la API (`GoodsReceiptTwinsService`,
 * cada 5 min) aparea las gemelas nuevas con una ventana corta. Este CLI es para el **barrido
 * histórico** (~45 s con todo el histórico, contra ~3 s de la ventana del cron) y para revisar
 * qué encontraría antes de escribir.
 *
 * Uso:
 *   node database/importers/kepler/detect-goods-receipt-duplicates.js                 # DRY-RUN + reporte
 *   node database/importers/kepler/detect-goods-receipt-duplicates.js --apply
 *   node database/importers/kepler/detect-goods-receipt-duplicates.js --from=2026-06-01
 * Env: DATABASE_URL_NEW (o DATABASE_URL / MIG_DB_URL) → la DB nueva multi-tenant. TENANT_ID.
 */
const { Client } = require('pg');
const APPLY = process.argv.includes('--apply');
const T = process.env.TENANT_ID || '00000000-0000-0000-0000-00000000d01c';
const DB_URL = process.env.DATABASE_URL_NEW || process.env.MIG_DB_URL || process.env.DATABASE_URL;
if (!DB_URL) { console.error('Falta DATABASE_URL_NEW / DATABASE_URL'); process.exit(1); }

/* Ventana por default: antes de dic-2025 la doble captura no existe (medido: 0 pares en 2025-11
 * y anteriores; arranca en ene-2026 y viene subiendo — 55% de las recepciones de sucursal en
 * ago-2026 ya tienen copia en oficinas). Barrer más atrás es gastar sin encontrar. */
const FROM = (process.argv.find((a) => a.startsWith('--from=')) || '--from=2026-01-01').split('=')[1];

const money = (n) => '$' + Number(n || 0).toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const local = /localhost|127\.0\.0\.1|192\.168\./.test(DB_URL);
const db = new Client({ connectionString: DB_URL, ssl: local ? false : { rejectUnauthorized: false }, connectionTimeoutMillis: 15000 });

(async () => {
  await db.connect();

  const fn = await db.query(`SELECT to_regprocedure('analytics.fn_pair_goods_receipts(uuid,date)') r`);
  if (!fn.rows[0].r) {
    console.error('Falta la migración 20260827170000_fn_pair_goods_receipts (el apareo vive en la DB).');
    process.exit(1);
  }

  console.log(`\n${APPLY ? 'APLICANDO' : 'DRY-RUN'} — pares sucursal ↔ oficinas desde ${FROM}`);
  console.log('(el cron de la API ya aparea lo nuevo cada 5 min; esto es el barrido histórico)\n');

  // El candidato SÓLO LEE: el dry-run muestra exactamente lo que aplicaría el --apply.
  const t0 = Date.now();
  await db.query(
    `CREATE TEMP TABLE _par AS SELECT * FROM analytics.fn_goods_receipt_twin_candidates($1, $2::date)`,
    [T, FROM],
  );
  console.log(`Candidatos calculados en ${((Date.now() - t0) / 1000).toFixed(1)}s.`);

  console.log('\nPares encontrados por regla:');
  console.table((await db.query(
    `SELECT match_rule AS regla, status, count(*)::int pares, round(sum(cedis_monto)::numeric, 2) monto,
            round(avg(abs(delta_dias))::numeric, 1) dias_prom, round(max(abs(delta_monto))::numeric, 2) delta_max
       FROM _par GROUP BY 1, 2 ORDER BY 2, 1`)).rows);

  console.log('\nCobertura por sucursal (¿cuántas de sus recepciones están también en oficinas?):');
  console.table((await db.query(
    `SELECT s.sucursal, count(*)::int recepciones,
            count(*) FILTER (WHERE EXISTS (SELECT 1 FROM _par p WHERE p.sucursal = s.sucursal AND p.folio = s.folio))::int con_copia_oficinas
       FROM analytics.erp_goods_receipts s
      WHERE s.tenant_id = $1 AND s.sucursal <> '00' AND s.monto > 0 AND s.receipt_date >= $2::date
      GROUP BY 1 ORDER BY 1`, [T, FROM])).rows);

  const sinPar = (await db.query(
    `SELECT count(*)::int n, round(coalesce(sum(c.monto), 0)::numeric, 2) monto
       FROM analytics.erp_goods_receipts c
      WHERE c.tenant_id = $1 AND c.sucursal = '00' AND c.monto > 0 AND c.receipt_date >= $2::date
        AND NOT EXISTS (SELECT 1 FROM _par p WHERE p.cedis_folio = c.folio)`, [T, FROM])).rows[0];
  console.log(`\nCapturas de oficinas SIN par: ${sinPar.n} (${money(sinPar.monto)}).`);
  console.log('  Son compras propias del CEDIS o recepciones que la sucursal no capturó.');

  if (!APPLY) {
    console.log('\nPropuestas que necesitan una persona (muestra):');
    console.table((await db.query(
      `SELECT cedis_folio, sucursal, folio, cedis_date::text fecha_ofi, suc_date::text fecha_suc,
              cedis_monto, suc_monto, delta_monto, left(cedis_prov, 20) prov_ofi, left(suc_prov, 20) prov_suc, match_rule regla
         FROM _par WHERE status = 'propuesto' ORDER BY abs(cedis_monto) DESC LIMIT 12`)).rows);
    console.log('\nDry-run: no se escribió nada. Corré con --apply.');
    await db.end();
    return;
  }

  const t1 = Date.now();
  const r = (await db.query(`SELECT * FROM analytics.fn_pair_goods_receipts($1, $2::date)`, [T, FROM])).rows[0];
  console.log(`\n[APPLY] ${r.nuevas} par(es) nuevo(s) · ${r.marcadas} marca(s) escritas · ${r.propuestas} por dictaminar · ${r.obsoletas} obsoleta(s) eliminada(s) (${((Date.now() - t1) / 1000).toFixed(1)}s)`);

  const estado = (await db.query(
    `SELECT status, count(*)::int marcas, round(sum(cedis_monto)::numeric, 2) monto
       FROM analytics.erp_goods_receipt_dedup WHERE tenant_id = $1 GROUP BY 1 ORDER BY 1`, [T])).rows;
  console.log('Estado de la tabla de pares:');
  console.table(estado);
  const oculto = estado.filter((e) => e.status === 'auto' || e.status === 'confirmado')
    .reduce((a, e) => a + Number(e.monto || 0), 0);
  const dudoso = estado.filter((e) => e.status === 'propuesto').reduce((a, e) => a + Number(e.monto || 0), 0);
  console.log(`Dinero que deja de contarse dos veces: ${money(oculto)}.`);
  if (dudoso) console.log(`Dinero que SIGUE contándose dos veces por falta de dictamen: ${money(dudoso)} → /compras/entradas/gemelas`);
  await db.end();
})().catch(async (e) => {
  // Sin esto el proceso moría con la transacción abierta y el servidor lo registraba como
  // «SSL error: unexpected eof» + «connection reset by peer», que enmascara el error real.
  console.error('ERR', e.message);
  try { await db.query('ROLLBACK'); } catch { /* no había transacción */ }
  try { await db.end(); } catch { /* ya cerrada */ }
  process.exit(1);
});
