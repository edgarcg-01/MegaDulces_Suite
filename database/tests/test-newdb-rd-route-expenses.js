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
  || (() => { throw new Error('falta la URL de la DB destino: exporta DATABASE_URL_NEW — la copia local :5433/postgres_platform fue PURGADA 2026-09-08 (ver reference_prod_db_connection_topology)'); })();
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

  // ── 5b. RD.5 — la operación (odómetro y $/km) que la pantalla edita ──────────────────
  // Añadido 2026-09-09 con la pantalla `/logistica/gasto-ruta`: hasta entonces la migración
  // había creado la tabla y la vista y **nadie las leía**. Lo que se comprueba es lo que la
  // pantalla promete: que declara en vez de dibujar cero, y que corregir no duplica.
  console.log('\n5b) RD.5 — operación: el odómetro se declara, no se rellena');
  const { rows: [op] } = await db.query(`
    SELECT count(*)::int filas,
           count(*) FILTER (WHERE km_recorridos IS NOT NULL)::int utilizables,
           count(*) FILTER (WHERE km_status IN ('retroceso','salto_implausible','sin_movimiento'))::int mal_tecleadas,
           count(*) FILTER (WHERE costo_status = 'sin_ficha_de_costo')::int sin_ficha,
           count(*) FILTER (WHERE costo_por_km = 0)::int km_en_cero
      FROM analytics.v_route_operation_period WHERE anio = 2026`);
  if (!op.filas) {
    noMedido('la vista de operación', 'no hay filas de 2026 — sin odómetro ni gasto no hay qué comprobar');
  } else {
    check(`la vista responde (${op.filas} ruta×quincena, ${op.utilizables} con km utilizable)`, op.utilizables > 0);
    // El corazón de §9.7: las lecturas rotas se ROTULAN, no se corrigen solas ni se descartan.
    check(`las ${op.mal_tecleadas} lecturas mal tecleadas siguen ahí, rotuladas`, op.mal_tecleadas > 0,
      'si llegan a 0 sin que nadie las corrigiera, alguien las está descartando en silencio');
    // El corazón de §9.6 y de ADR-056: sin ficha, NULL con motivo — jamás cero.
    check('el $/km nunca vale 0: o tiene valor o es NULL con su motivo', op.km_en_cero === 0,
      `${op.km_en_cero} filas con costo_por_km = 0`);
    check(`las rutas sin ficha se declaran (${op.sin_ficha} periodos con sin_ficha_de_costo)`, op.sin_ficha > 0);
  }

  // Que el UPSERT de la pantalla acierte el índice único **PARCIAL** sólo se puede comprobar
  // escribiendo, y esta suite corre en `default_transaction_read_only = on` a propósito (§43).
  // No se levanta la guarda: se DECLARA como NO MEDIDO y se comprueba por estructura lo que sí
  // se puede leer — que el índice existe con su `WHERE`, que es lo que el ON CONFLICT nombra.
  // La prueba de escritura vive fuera de la suite (`--allow-writes`), con ROLLBACK.
  const { rows: [ix] } = await db.query(`
    SELECT count(*)::int n FROM pg_indexes
     WHERE schemaname='logistics' AND tablename='route_odometer'
       AND indexdef ILIKE '%UNIQUE%' AND indexdef ILIKE '%deleted_at IS NULL%'
       AND indexdef ILIKE '%route_code%' AND indexdef ILIKE '%period_no%'`);
  check('existe el índice único parcial que el ON CONFLICT de la pantalla nombra', ix.n === 1,
    'sin el WHERE deleted_at IS NULL, corregir una lectura crearía una segunda en vez de actualizarla');
  if (process.argv.includes('--allow-writes')) {
    await db.query('SET default_transaction_read_only = off');
    await db.query('BEGIN');
    try {
      const up = (ki, kf) => db.query(`
        INSERT INTO logistics.route_odometer (tenant_id, route_code, anio, period_no, km_inicial, km_final, source)
        VALUES ($1,'__candado__',2026,99,$2,$3,'captura_web')
        ON CONFLICT (tenant_id, route_code, anio, period_no) WHERE deleted_at IS NULL
        DO UPDATE SET km_inicial=EXCLUDED.km_inicial, km_final=EXCLUDED.km_final, updated_at=now()
        RETURNING id, km_final`, [TENANT, ki, kf]);
      const a = await up(1000, 1500);
      const b = await up(1000, 1800);
      check('corregir una lectura la ACTUALIZA (el ON CONFLICT acierta el índice parcial)',
        a.rows[0].id === b.rows[0].id && Number(b.rows[0].km_final) === 1800);
      let rompio = false;
      await db.query('SAVEPOINT sp');
      try { await up(-5, 100); } catch { rompio = true; await db.query('ROLLBACK TO SAVEPOINT sp'); }
      check('PRUEBA NEGATIVA: un km negativo lo rechaza el CHECK', rompio);
    } finally { await db.query('ROLLBACK'); await db.query('SET default_transaction_read_only = on'); }
  } else {
    noMedido('el UPSERT del odómetro end-to-end',
      'la suite corre read-only; para ejercerlo: node <este archivo> --allow-writes (escribe y hace ROLLBACK)');
  }

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
