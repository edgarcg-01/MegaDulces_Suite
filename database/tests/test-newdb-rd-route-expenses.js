/* eslint-disable no-console */
/**
 * [RD.4] CANDADO del gasto de flota de Ruta Directa.
 *
 * ── POR QUÉ ──────────────────────────────────────────────────────────────────────────────
 * `logistics.route_expenses` es **dato propio**: no existe en ningún ERP, sólo en la hoja
 * `CONTROL DE GASTOS RD` del workbook. Si se pierde o se duplica, no hay de dónde
 * reconstruirlo. Y las tres tablas que el proyecto ya tenía para esto estaban vacías
 * (`fuel_transactions` 0, `vehicle_usage_logs` 0, `route_tickets` 5), así que esta es la
 * única copia.
 *
 * ── EL ÁRBITRO NO ES EL TOTAL DEL EXCEL ──────────────────────────────────────────────────
 * El parse se cuadró contra la **columna cruda** `J3:J2057` (782 celdas, $848,610.04,
 * 34,718.24 lts) y empata al centavo. NO contra el "TOTAL POR TIPO DE GASTO" de la hoja:
 * ese está roto — `Z7 = SUM(O7,O23,O38,O47,O60,R7,R23,R38,R47,V7,V23,)` (con coma colgando)
 * apunta a bloques rotulados con rutas **24, 25, 300 y 301** que no existen en los datos, y
 * subdeclara el combustible en ~$332,000. Es el mismo error de clase que el resto del libro.
 *
 *   DATABASE_URL_NEW=… node database/tests/test-newdb-rd-route-expenses.js
 */
const { Client } = require('pg');

const URL = process.env.DATABASE_URL_NEW || process.env.DST_URL
  || 'postgresql://postgres:superoot@localhost:5433/postgres_platform';
const TENANT = process.env.WINCAJA_TENANT_ID || '00000000-0000-0000-0000-00000000d01c';

// Lo que el workbook trae, medido. Si el importer cambia y esto se mueve, hay que saberlo.
const ESPERADO = { filas: 782, total: 848610.04, litros: 34718.24, rutas: 13, sin_clasificar: 5, litros_mal_tipados: 1 };

let ok = 0; let fail = 0; let nm = 0;
const check = (label, cond, detail = '') => {
  if (cond) { ok++; console.log(`  ✔ ${label}`); }
  else { fail++; console.log(`  ✖ ${label}${detail ? ` — ${detail}` : ''}`); }
};
const noMedido = (label, motivo) => { nm++; console.log(`  ⓘ NO MEDIDO · ${label} — ${motivo}`); };

(async () => {
  const db = new Client({
    connectionString: URL, statement_timeout: 60000,
    ssl: /rlwy|railway|proxy/i.test(URL) ? { rejectUnauthorized: false } : false,
  });
  await db.connect();
  await db.query('SET default_transaction_read_only = on');
  await db.query(`SET app.tenant_id = '${TENANT}'`);
  console.log(`\n=== [RD.4] gasto de flota · ${URL.replace(/:\/\/[^@]*@/, '://***@')} ===`);

  if (!(await db.query(`SELECT to_regclass('logistics.route_expenses') t`)).rows[0].t) {
    noMedido('logistics.route_expenses', 'la tabla no existe en este destino (falta 20260908130000)');
    console.log(`\n=== ${ok} OK · ${fail} fallas · ${nm} NO MEDIDOS ===\n`);
    await db.end(); process.exit(fail ? 1 : 0);
  }

  // ── 1. El catálogo ───────────────────────────────────────────────────────────────────
  console.log('\n1) El catálogo de tipos');
  const { rows: tipos } = await db.query(
    `SELECT code, nombre, lleva_litros FROM logistics.route_expense_types
      WHERE tenant_id = $1 ORDER BY code`, [TENANT]);
  check(`están los 7 tipos, 6 del Excel + SIN CLASIFICAR (${tipos.length})`, tipos.length === 7);
  check('el 0 es SIN CLASIFICAR', tipos.some((t) => t.code === 0 && /SIN CLASIFICAR/i.test(t.nombre)),
    'sin ese tipo, una fila sin categoría obliga a adivinarla o a perderla');
  check('COMBUSTIBLES (4) es el único que lleva litros',
    tipos.filter((t) => t.lleva_litros).map((t) => t.code).join(',') === '4');

  // ── 2. La carga ──────────────────────────────────────────────────────────────────────
  console.log('\n2) La carga del workbook');
  const { rows: [g] } = await db.query(
    `SELECT count(*)::int filas,
            round(sum(total)::numeric,2)::float8   AS total,
            round(sum(liters)::numeric,2)::float8  AS litros,
            count(DISTINCT route_code)::int        AS rutas,
            count(*) FILTER (WHERE expense_type = 0)::int AS sin_clasificar,
            min(expense_date)::text d0, max(expense_date)::text d1
       FROM logistics.route_expenses
      WHERE tenant_id = $1 AND deleted_at IS NULL AND source = 'excel_import'`, [TENANT]);

  if (!g.filas) {
    noMedido('la carga del workbook', 'no hay filas source=excel_import (falta correr el importer)');
  } else {
    check(`${ESPERADO.filas} filas cargadas (${g.filas})`, g.filas === ESPERADO.filas);
    check(`el importe cuadra al centavo con la columna cruda ($${g.total})`,
      Math.abs(g.total - ESPERADO.total) < 0.01, `esperado $${ESPERADO.total}`);
    check(`los litros cuadran (${g.litros})`, Math.abs(g.litros - ESPERADO.litros) < 0.01,
      `esperado ${ESPERADO.litros}`);
    check(`están las 13 rutas (${g.rutas})`, g.rutas === ESPERADO.rutas);
    // No se adivina el tipo: las 5 sin categoría tienen que seguir VISIBLES como tales.
    check(`las ${ESPERADO.sin_clasificar} filas sin tipo siguen marcadas, no adivinadas (${g.sin_clasificar})`,
      g.sin_clasificar === ESPERADO.sin_clasificar,
      'si bajó a 0 sin que nadie las reclasificara, alguien las clasificó por descripción');
    console.log(`     rango ${g.d0} → ${g.d1}`);
  }

  // ── 3. Idempotencia ──────────────────────────────────────────────────────────────────
  // La llave natural incluye el IMPORTE porque el folio se repite con montos distintos
  // (medido: 501 · 2026-04-06 · folio 38438 con $105 y $859.73). Sin el importe, el
  // re-import perdería una de las dos.
  console.log('\n3) La llave natural aguanta el re-import');
  const { rows: [idx] } = await db.query(`
    SELECT count(*)::int n FROM pg_indexes
     WHERE schemaname='logistics' AND tablename='route_expenses'
       AND indexname='route_expenses_natural_unique'
       AND indexdef LIKE '%total%' AND indexdef LIKE '%deleted_at IS NULL%'`);
  check('el índice único incluye el importe y excluye lo borrado', idx.n === 1,
    'sin el importe, dos cargos en el mismo vale colapsan en uno');
  const { rows: [dup] } = await db.query(`
    SELECT count(*)::int n FROM (
      SELECT 1 FROM logistics.route_expenses WHERE tenant_id = $1 AND deleted_at IS NULL
       GROUP BY route_code, expense_date, folio, expense_type, total HAVING count(*) > 1) x`, [TENANT]);
  check('cero duplicados en la llave natural', dup.n === 0, `${dup.n} grupos repetidos`);

  // ── 4. Coherencia del dato ───────────────────────────────────────────────────────────
  console.log('\n4) Coherencia');
  const { rows: [inc] } = await db.query(`
    SELECT count(*) FILTER (WHERE total < 0)::int neg,
           count(*) FILTER (WHERE liters IS NOT NULL AND liters < 0)::int lt_neg,
           count(*) FILTER (WHERE liters > 0 AND expense_type NOT IN (0,4))::int litros_sin_combustible
      FROM logistics.route_expenses WHERE tenant_id = $1 AND deleted_at IS NULL`, [TENANT]);
  check('ningún importe negativo', inc.neg === 0, `${inc.neg}`);
  check('ningún litraje negativo', inc.lt_neg === 0, `${inc.lt_neg}`);
  // El workbook trae UNA fila incoherente: tipo 1 (PLACAS/ARRENDAMIENTOS/VERIFICACION),
  // $400.00 y 16.74 litros. O es gasolina mal tipada, o un litraje pegado por error. Es un
  // defecto del ORIGEN, no del importer, así que no se corrige por nuestra cuenta ni se
  // esconde: se declara y la compuerta atrapa la SEGUNDA. La primera versión de esta
  // aserción exigía cero y fallaba, dando por sentado que el Excel era coherente.
  check(`litros fuera de COMBUSTIBLES: sólo el caso conocido del origen (${inc.litros_sin_combustible} de 1 tolerado)`,
    inc.litros_sin_combustible <= ESPERADO.litros_mal_tipados,
    `apareció otra fila con litros en un tipo que no los lleva — revisar la captura, no el importer`);

  // ── 5. RLS ───────────────────────────────────────────────────────────────────────────
  console.log('\n5) Aislamiento por tenant');
  const { rows: rls } = await db.query(`
    SELECT c.relname, c.relrowsecurity en, c.relforcerowsecurity forced,
           (SELECT count(*) FROM pg_policies p WHERE p.schemaname='logistics' AND p.tablename=c.relname)::int pol
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
     WHERE n.nspname='logistics' AND c.relkind='r' AND c.relname IN ('route_expenses','route_expense_types')`);
  check('las 2 tablas con RLS FORZADO y su política',
    rls.length === 2 && rls.every((r) => r.en && r.forced && r.pol >= 1),
    rls.filter((r) => !(r.en && r.forced && r.pol >= 1)).map((r) => r.relname).join(', '));

  // ── 6. El permiso repartido ──────────────────────────────────────────────────────────
  console.log('\n6) El permiso llegó a alguien (lección LC.6.2)');
  const { rows: [perm] } = await db.query(`
    SELECT count(*) FILTER (WHERE permissions->'LOGISTICS_ROUTE_EXPENSES_VER' = 'true'::jsonb)::int ven,
           count(*) FILTER (WHERE permissions->'LOGISTICS_ROUTE_EXPENSES_GESTIONAR' = 'true'::jsonb)::int gestionan
      FROM role_permissions`);
  check(`algún rol VE el gasto de flota (${perm.ven})`, perm.ven >= 1,
    'el módulo nacería inaccesible salvo para ALL_PERMS');
  check(`algún rol lo GESTIONA (${perm.gestionan})`, perm.gestionan >= 1);

  await db.end();
  console.log(`\n=== ${ok} OK · ${fail} fallas · ${nm} NO MEDIDOS ===\n`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('\nFATAL:', e.message); process.exit(1); });
