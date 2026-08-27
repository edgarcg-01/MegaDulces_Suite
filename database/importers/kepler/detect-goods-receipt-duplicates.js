#!/usr/bin/env node
/*
 * RE.14.2 — **Caza los pares** de la misma recepción capturada dos veces: una en el Kepler de la
 * sucursal (servidor local) y otra en el de **oficinas** (9.95, sucursal '00').
 *
 * La CANÓNICA es siempre la de sucursal: es la que trae los productos y la que movió inventario.
 * La de oficinas es una **captura contable**: casi siempre un solo renglón de concepto
 * ("VENTAS AL 0 %", SKU 0000x) con el total, sin detalle. Ese es el rasgo estructural que
 * permite ocultarla sin riesgo: un documento de puro concepto no puede ser una recepción de
 * mercancía por su cuenta.
 *
 * Por qué no alcanza un predicado de igualdad (medido sobre la data, 2026-08):
 *   - los dos servidores capturan por separado → el total no siempre casa al centavo
 *     (HERSHEY 2026-08-17: sucursal 06 $79,009.21 vs oficinas $79,007.79, $1.42) y la fecha se corre;
 *   - **el nombre del proveedor no es la misma llave**: cada servidor tiene su catálogo
 *     (`DIONICIO CALDERON` en sucursal = `BOTANAS CALDERON` en oficinas, mismo día y mismo importe).
 *
 * Entonces el apareo es por **cascada de reglas con score**, y lo dudoso NO se aplica solo:
 *
 *   exacta       1.00  mismo día + mismo importe + mismo proveedor
 *   monto_fecha  0.90  mismo importe + ±7 días + mismo proveedor
 *   centavos     0.75  |Δimporte| ≤ max($5, 0.05%) + ±7 días + proveedor igual o parecido (trigram ≥ .45)
 *   sugerida     0.50  mismo importe + ±15 días, proveedor distinto  → SIEMPRE queda 'propuesto'
 *
 * Se aplica solo (`status='auto'`, oculta la copia) si score ≥ 0.75 **y** la copia de oficinas es
 * de puro concepto. Todo lo demás queda `'propuesto'`: no oculta nada y espera dictamen humano.
 * Los pares `'confirmado'`/`'rechazado'` por una persona **no se tocan** (ni se reproponen).
 *
 * El pareo es 1:1 y determinista: mejor candidato por folio de oficinas, y de esos, mejor
 * candidato por canónica (desempate por score → |Δdías| → |Δimporte| → folio).
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

/* Reglas y umbrales en un solo lugar: el SQL las usa para clasificar y el reporte para explicar. */
const REGLAS = `
  CASE
    WHEN c.monto = s.monto AND c.receipt_date = s.receipt_date
         AND c.prov = s.prov                                                THEN 'exacta'
    WHEN c.monto = s.monto AND abs(c.receipt_date - s.receipt_date) <= 7
         AND c.prov = s.prov                                                THEN 'monto_fecha'
    WHEN abs(c.monto - s.monto) <= greatest(5, s.monto * 0.0005)
         AND abs(c.receipt_date - s.receipt_date) <= 7
         AND (c.prov = s.prov OR similarity(c.prov, s.prov) >= 0.45)        THEN 'centavos'
    WHEN c.monto = s.monto AND abs(c.receipt_date - s.receipt_date) <= 15   THEN 'sugerida'
  END`;
const SCORE = `CASE regla WHEN 'exacta' THEN 1.000 WHEN 'monto_fecha' THEN 0.900 WHEN 'centavos' THEN 0.750 ELSE 0.500 END`;

(async () => {
  await db.connect();

  const tbl = await db.query(`SELECT to_regclass('analytics.erp_goods_receipt_dedup') r`);
  if (!tbl.rows[0].r) { console.error('Falta analytics.erp_goods_receipt_dedup — aplicá la migración 20260820120000 primero.'); process.exit(1); }
  const cols = await db.query(
    `SELECT count(*)::int n FROM information_schema.columns
      WHERE table_schema='analytics' AND table_name='erp_goods_receipt_dedup' AND column_name IN ('status','match_rule','match_score')`);
  if (cols.rows[0].n < 3) { console.error('Falta la migración 20260827160000_goods_receipt_twins (status/match_rule/match_score).'); process.exit(1); }

  console.log(`\n${APPLY ? 'APLICANDO' : 'DRY-RUN'} — pares sucursal ↔ oficinas desde ${FROM}`);

  // 1) Universo. `lump` = el documento es de puro concepto (sin productos) → candidato a espejo
  //    contable. Se evalúa la vista viva UNA sola vez.
  await db.query(
    `CREATE TEMP TABLE _g AS
       SELECT g.sucursal, g.folio, g.receipt_date, g.monto,
              coalesce(g.proveedor_nombre, '') AS prov, g.proveedor_rfc,
              coalesce(l.conc, false) AS lump, coalesce(l.nl, 0) AS nl
         FROM analytics.erp_goods_receipts g
         LEFT JOIN (
           SELECT sucursal, folio, count(*) AS nl, bool_and(sku ~ '^0000[0-9]$') AS conc
             FROM analytics.erp_goods_receipt_lines WHERE tenant_id = $1 GROUP BY 1, 2
         ) l ON l.sucursal = g.sucursal AND l.folio = g.folio
        WHERE g.tenant_id = $1 AND g.monto > 0 AND g.receipt_date >= $2::date`, [T, FROM]);
  await db.query('CREATE INDEX ON _g (receipt_date, monto)');
  await db.query('CREATE INDEX ON _g (sucursal)');

  // 2) Candidatos + regla. El JOIN usa el predicado MÁS FLOJO de las reglas (±15 días y el
  //    importe igual o dentro de la tolerancia); la clasificación fina la hace el CASE.
  await db.query(
    `CREATE TEMP TABLE _cand AS
       SELECT * FROM (
         SELECT c.folio AS cedis_folio, s.sucursal, s.folio,
                c.receipt_date AS cedis_date, c.monto AS cedis_monto, c.lump,
                s.receipt_date AS suc_date, s.monto AS suc_monto,
                c.prov AS cedis_prov, s.prov AS suc_prov,
                (c.receipt_date - s.receipt_date) AS delta_dias,
                round(c.monto - s.monto, 2) AS delta_monto,
                ${REGLAS} AS regla
           FROM _g c
           JOIN _g s
             ON s.sucursal <> '00'
            AND abs(c.receipt_date - s.receipt_date) <= 15
            AND (c.monto = s.monto OR abs(c.monto - s.monto) <= greatest(5, s.monto * 0.0005))
          WHERE c.sucursal = '00'
       ) x WHERE regla IS NOT NULL`);

  // 3) Pareo 1:1 determinista: mejor por folio de oficinas, y de esos el mejor por canónica.
  //    Los empates dejan filas sin aparear a propósito: preferimos no aparear a aparear mal.
  await db.query(
    `CREATE TEMP TABLE _par AS
       WITH puntuado AS (
         SELECT *, ${SCORE} AS score,
                count(*) OVER (PARTITION BY cedis_folio) AS nc_ofi,
                count(*) OVER (PARTITION BY sucursal, folio) AS nc_suc
           FROM _cand),
       por_cedis AS (
         SELECT DISTINCT ON (cedis_folio) * FROM puntuado
          ORDER BY cedis_folio, score DESC, abs(delta_dias), abs(delta_monto), sucursal, folio),
       por_canonica AS (
         SELECT DISTINCT ON (sucursal, folio) * FROM por_cedis
          ORDER BY sucursal, folio, score DESC, abs(delta_dias), abs(delta_monto), cedis_folio)
       SELECT p.*, (CASE
           -- Espejo por estructura: la copia de oficinas no tiene productos, así que no puede ser
           -- una recepción de mercancía por su cuenta. Ocultarla no puede perder una compra real.
           WHEN p.lump AND p.score >= 0.75 THEN 'auto'
           -- Espejo por coincidencia irrepetible: mismo día, mismo importe al centavo, mismo
           -- proveedor Y **un solo candidato de cada lado**. Es el caso de las recepciones grandes
           -- que oficinas sí capturó con detalle ($288,993.54 de BOLSAS DE LOS ALTOS el mismo día).
           -- La unicidad es la parte que importa: con dos candidatos iguales, apareamos mal la mitad
           -- de las veces, y ahí sí se puede esconder una compra que existe.
           WHEN p.regla = 'exacta' AND p.nc_ofi = 1 AND p.nc_suc = 1 THEN 'auto'
           ELSE 'propuesto' END) AS status
         FROM por_canonica p
        WHERE NOT EXISTS (
          SELECT 1 FROM analytics.erp_goods_receipt_dedup d
           WHERE d.tenant_id = $1 AND d.status IN ('confirmado', 'rechazado')
             AND (d.cedis_folio = p.cedis_folio
               OR (d.dup_of_sucursal = p.sucursal AND d.dup_of_folio = p.folio)))`, [T]);

  const resumen = (await db.query(
    `SELECT regla, status, count(*)::int pares, round(sum(cedis_monto)::numeric, 2) monto,
            round(avg(abs(delta_dias))::numeric, 1) dias_prom, round(max(abs(delta_monto))::numeric, 2) delta_max
       FROM _par GROUP BY 1, 2 ORDER BY 2, 1`)).rows;
  console.log('\nPares encontrados por regla:');
  console.table(resumen);

  const cobertura = (await db.query(
    `SELECT s.sucursal, count(*)::int recepciones,
            count(*) FILTER (WHERE EXISTS (SELECT 1 FROM _par p WHERE p.sucursal = s.sucursal AND p.folio = s.folio))::int con_copia_oficinas
       FROM _g s WHERE s.sucursal <> '00' GROUP BY 1 ORDER BY 1`)).rows;
  console.log('\nCobertura por sucursal (¿cuántas de sus recepciones están también en oficinas?):');
  console.table(cobertura);

  const sinPar = (await db.query(
    `SELECT count(*)::int lump_sin_par, round(sum(monto)::numeric, 2) monto
       FROM _g c WHERE c.sucursal = '00' AND c.lump
         AND NOT EXISTS (SELECT 1 FROM _par p WHERE p.cedis_folio = c.folio)`)).rows[0];
  console.log(`\nCapturas de oficinas de puro concepto SIN par: ${sinPar.lump_sin_par} (${money(sinPar.monto)}).`);
  console.log('  Son las que hay que mirar a mano: o la sucursal no la capturó, o el importe/proveedor');
  console.log('  se apartó más de lo que tolera la regla más floja.');

  if (!APPLY) {
    console.log('\nPropuestas que necesitan una persona (muestra):');
    console.table((await db.query(
      `SELECT cedis_folio, sucursal, folio, cedis_date::text fecha_ofi, suc_date::text fecha_suc,
              cedis_monto, suc_monto, delta_monto, left(cedis_prov, 20) prov_ofi, left(suc_prov, 20) prov_suc, regla
         FROM _par WHERE status = 'propuesto' ORDER BY abs(cedis_monto) DESC LIMIT 12`)).rows);
    console.log('\nDry-run: no se escribió nada. Corré con --apply.');
    await db.end();
    return;
  }

  await db.query('BEGIN');
  // UPSERT. El `WHERE` del DO UPDATE es el candado de la decisión humana: aunque el par entre
  // en la tanda, si alguien ya dictaminó ese folio no se sobreescribe.
  const up = await db.query(
    `INSERT INTO analytics.erp_goods_receipt_dedup
       (tenant_id, cedis_folio, dup_of_sucursal, dup_of_folio, match_rule, match_score,
        suc_date, suc_monto, suc_prov, cedis_date, cedis_monto, cedis_prov,
        delta_monto, delta_dias, status, computed_at)
     SELECT $1::uuid, cedis_folio, sucursal, folio, regla, score,
            suc_date, suc_monto, suc_prov, cedis_date, cedis_monto, cedis_prov,
            delta_monto, delta_dias, status, now()
       FROM _par
     ON CONFLICT (tenant_id, cedis_folio) DO UPDATE
       SET dup_of_sucursal = EXCLUDED.dup_of_sucursal, dup_of_folio = EXCLUDED.dup_of_folio,
           match_rule = EXCLUDED.match_rule, match_score = EXCLUDED.match_score,
           suc_date = EXCLUDED.suc_date, suc_monto = EXCLUDED.suc_monto, suc_prov = EXCLUDED.suc_prov,
           cedis_date = EXCLUDED.cedis_date, cedis_monto = EXCLUDED.cedis_monto, cedis_prov = EXCLUDED.cedis_prov,
           delta_monto = EXCLUDED.delta_monto, delta_dias = EXCLUDED.delta_dias,
           status = EXCLUDED.status, computed_at = now()
       WHERE analytics.erp_goods_receipt_dedup.status NOT IN ('confirmado', 'rechazado')`, [T]);
  // Limpia marcas del detector que ya no tienen candidato (cambió el importe, se canceló el
  // documento). Sólo dentro de la ventana procesada — si no, un `--from` angosto borraría el
  // histórico — y sólo las suyas: las dictaminadas por una persona se conservan.
  const del = await db.query(
    `DELETE FROM analytics.erp_goods_receipt_dedup d
      WHERE d.tenant_id = $1 AND d.status IN ('auto', 'propuesto')
        AND EXISTS (SELECT 1 FROM _g c WHERE c.sucursal = '00' AND c.folio = d.cedis_folio)
        AND NOT EXISTS (SELECT 1 FROM _par p WHERE p.cedis_folio = d.cedis_folio)`, [T]);
  await db.query('COMMIT');

  const estado = (await db.query(
    `SELECT status, count(*)::int marcas, round(sum(cedis_monto)::numeric, 2) monto
       FROM analytics.erp_goods_receipt_dedup WHERE tenant_id = $1 GROUP BY 1 ORDER BY 1`, [T])).rows;
  console.log(`\n[APPLY] ${up.rowCount} marca(s) escritas · ${del.rowCount} obsoleta(s) eliminadas.`);
  console.log('Estado de la tabla de pares:');
  console.table(estado);
  const oculto = estado.filter((e) => e.status === 'auto' || e.status === 'confirmado')
    .reduce((a, e) => a + Number(e.monto || 0), 0);
  console.log(`Dinero que deja de contarse dos veces: ${money(oculto)}.`);
  await db.end();
})().catch(async (e) => {
  // Sin esto el proceso moría con la transacción abierta y el servidor lo registraba como
  // «SSL error: unexpected eof» + «connection reset by peer», que enmascara el error real.
  console.error('ERR', e.message);
  try { await db.query('ROLLBACK'); } catch { /* no había transacción */ }
  try { await db.end(); } catch { /* ya cerrada */ }
  process.exit(1);
});
