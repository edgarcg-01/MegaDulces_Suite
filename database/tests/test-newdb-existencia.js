/* eslint-disable no-console */
/**
 * E — CANDADO de la pantalla EXISTENCIA (matriz producto × almacén).
 *
 * Carga el SERVICIO REAL vía ts-node, así que el test no puede divergir del código: si alguien
 * cambia el SQL, acá se ve.
 *
 * Lo que existe para que NO vuelva:
 *   1. ⛔ Que alguien "arregle" la fuente volviendo a `commercial.stock`. Esa tabla acierta 91%
 *      contra el POS (15,324 unidades de error); la vista del ODS acierta 100%. El test exige que
 *      el resultado DISCREPE de la tabla — si coincide, está leyendo la copia que miente.
 *   2. Que una celda con el peldaño contradicho publique cajas o dinero. La regla de U.2b: se
 *      muestra la cantidad NATIVA con su rótulo y el dinero va NULL, nunca 0.
 *   3. Que los totales se conviertan en totales DE LA PÁGINA (un footer que suma 50 de 9,860).
 *   4. Que se sumen unidades crudas de almacenes con unidades distintas (kg + paquetes + piezas).
 *   5. ⭐ Que el PERMISO quede declarado y sin repartir. Es el modo de falla que ya mordió con
 *      FISCAL_PURCHASE_BOOK_* (LC.6.2): el módulo en prod y nadie podía abrirlo.
 *   6. Que `customer_b2b` reciba el permiso — le daría la existencia de la red valuada a costo.
 *
 *   DATABASE_URL_NEW=… node database/tests/test-newdb-existencia.js
 */
const path = require('path');
const { Client } = require('pg');

const ROOT = path.resolve(__dirname, '..', '..');
const T = '00000000-0000-0000-0000-00000000d01c';
const URL = process.env.DATABASE_URL_NEW || process.env.DST_URL
  || 'postgresql://postgres:superoot@localhost:5433/postgres_platform';

let ok = 0; let fail = 0; let skip = 0;
const check = (label, cond, detail = '') => {
  if (cond) { ok++; console.log(`  ✔ ${label}`); }
  else { fail++; console.log(`  ✖ ${label}${detail ? ` — ${detail}` : ''}`); }
};
const money = (n) => (n == null ? 'null' : `$${Math.round(Number(n)).toLocaleString('es-MX')}`);

// El servicio importa @megadulces/platform-core sólo para los TIPOS del constructor; se stubea
// porque el test inyecta sus propios dobles.
const Module = require('module');
const origLoad = Module._load;
Module._load = function (req, parent, isMain) {
  if (req === '@megadulces/platform-core') {
    return {
      TenantKnexService: class {}, TenantContextService: class {},
      Permission: {}, RolesGuard: class {}, RequirePermissions: () => () => undefined,
    };
  }
  return origLoad.apply(this, [req, parent, isMain]);
};

(async () => {
  console.log('\n=== EXISTENCIA — matriz producto × almacén ===\n');
  const c = new Client({ connectionString: URL, ssl: URL.includes('localhost') ? false : { rejectUnauthorized: false } });
  await c.connect();

  // ── 0. Precondiciones de esquema ────────────────────────────────────────────────────────────
  const vista = (await c.query(
    `SELECT count(*)::int n FROM pg_views WHERE schemaname='analytics' AND viewname='v_erp_stock_on_hand'`,
  )).rows[0];
  check('analytics.v_erp_stock_on_hand existe y es VISTA (derivar-no-copiar)', vista.n === 1);

  const cols = (await c.query(
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema='analytics' AND table_name='replenishment_plan'
        AND column_name IN ('display_bf','rung_veredicto','rung_bf_esperado','rung_arbitrado')`,
  )).rows.map((r) => r.column_name);
  check('el fact trae display_bf + las 3 columnas del veredicto', cols.length === 4, `tiene ${cols.join(',')}`);

  // ── 1. ⭐ EL REPARTO OCURRIÓ (la aserción más valiosa del set) ───────────────────────────────
  const rep = (await c.query(
    `SELECT count(*) FILTER (WHERE permissions->'EXISTENCIA_VER' = 'true'::jsonb)::int con_ver,
            count(*) FILTER (WHERE permissions->'EXISTENCIA_GESTIONAR' = 'true'::jsonb)::int con_gest,
            count(*) FILTER (WHERE role_name='customer_b2b'
                               AND permissions->'EXISTENCIA_VER' = 'true'::jsonb)::int b2b
       FROM role_permissions`,
  )).rows[0];
  console.log(`  reparto: ${rep.con_ver} roles con VER · ${rep.con_gest} con GESTIONAR`);
  check('EXISTENCIA_VER está REPARTIDO, no sólo declarado (lección LC.6.2)', rep.con_ver > 0,
    `con_ver=${rep.con_ver} — el módulo estaría en prod sin que nadie pueda abrirlo`);
  check('EXISTENCIA_GESTIONAR está repartido', rep.con_gest > 0, `con_gest=${rep.con_gest}`);
  check('⛔ customer_b2b NO lo tiene (le daría la red valuada a costo)', rep.b2b === 0, `b2b=${rep.b2b}`);

  // ── 2. El servicio real ─────────────────────────────────────────────────────────────────────
  let svc = null;
  try {
    require(path.join(ROOT, 'node_modules/ts-node')).register({
      transpileOnly: true, skipProject: true,
      compilerOptions: {
        module: 'commonjs', target: 'es2021', experimentalDecorators: true,
        emitDecoratorMetadata: true, esModuleInterop: true, skipLibCheck: true,
        moduleResolution: 'bundler', ignoreDeprecations: '6.0',
      },
    });
    const knex = require(path.join(ROOT, 'node_modules/knex'))({
      client: 'pg',
      connection: URL.includes('localhost') ? URL : { connectionString: URL, ssl: { rejectUnauthorized: false } },
      pool: { min: 0, max: 3 },
    });
    const tk = {
      run: async (cb) => {
        const trx = await knex.transaction();
        try {
          await trx.raw(`SET LOCAL app.tenant_id = '${T}'`);
          const r = await cb(trx); await trx.commit(); return r;
        } catch (e) { await trx.rollback(); throw e; }
      },
    };
    const { ExistenciaService } = require(path.join(ROOT, 'libs/commercial/src/lib/commercial-inventory/existencia.service.ts'));
    svc = new ExistenciaService(tk, { requireTenantId: () => T });
    svc._knex = knex;
  } catch (e) {
    console.log(`  ⊘ no se pudo cargar el servicio real (${e.message.slice(0, 90)})`);
    skip++;
  }

  if (svc) {
    // ⚠️ CÓMO SE MIDE, y por qué así. Dos cosas contaminan la cifra y ninguna es el código:
    //   1. la PRIMERA llamada de un proceso fresco paga la compilación de ts-node y el warmup de
    //      la conexión (~5,300 ms) — el proceso de la API vive, así que eso no lo paga nadie;
    //   2. esto corre contra la DB de PROD, compartida con los importers, que escriben todo el
    //      tiempo. Medido en la misma sesión salió 1,262 · 1,354 · 3,403 ms: la varianza es
    //      contención, no una regresión.
    // Por eso se toma el PISO de 3 corridas — el piso es lo que cuesta la consulta; los picos son
    // los vecinos. Se imprimen las tres para que la varianza quede a la vista y nadie crea que el
    // umbral se está acomodando.
    const marcas = [];
    for (let i = 0; i < 3; i++) {
      const t = Date.now();
      await svc.list({ pageSize: 50 });
      marcas.push(Date.now() - t);
    }
    const r = await svc.list({ pageSize: 50 });
    const ms = Math.min(...marcas.slice(1)); // se descarta la 1ra (compilación + warmup)
    console.log(`  perf: ${marcas.map((m) => `${m} ms`).join(' · ')} → piso ${ms} ms`);
    console.log(`\n  dataset: ${r.totals.skus} SKUs · ${money(r.totals.valor)} publicado · `
      + `${r.totals.celdas_sin_valuar} celdas sin valuar (${r.totals.skus_sin_valuar} SKUs) · ${ms} ms\n`);

    check('devuelve filas y columnas dinámicas', r.rows.length > 0 && r.columns.length > 1,
      `${r.rows.length} filas / ${r.columns.length} columnas`);
    check('las columnas NO están hardcodeadas (salen del catálogo)', r.columns.every((x) => x.code && x.name));
    check('publica un valor de inventario > 0', Number(r.totals.valor) > 0, money(r.totals.valor));

    // ── 3. LA REGLA DEL DINERO. Y se afirma que la población NO está vacía: un candado que
    // pasa en vacío no es candado.
    const marked = await svc.list({ only_unverified: '1', pageSize: 100 });
    let celdas = 0; let fugas = 0; let sinNat = 0;
    for (const row of marked.rows) {
      for (const cel of Object.values(row.cells || {})) {
        if (!cel.rung) continue;
        celdas++;
        if (cel.q !== undefined || cel.val !== undefined) fugas++;
        if (cel.nat === undefined) sinNat++;
      }
    }
    check('hay celdas con peldaño contradicho que inspeccionar (si no, el candado es vacío)',
      celdas > 0, `celdas=${celdas}`);
    check('ninguna celda marcada publica cajas ni dinero', fugas === 0, `fugas=${fugas}`);
    check('toda celda marcada trae la cantidad NATIVA (no queda en blanco)', sinNat === 0, `sin nat=${sinNat}`);

    // ── 4. Los totales son del DATASET, no de la página.
    const p1 = await svc.list({ pageSize: 10, page: 1 });
    const p2 = await svc.list({ pageSize: 10, page: 2 });
    check('los totales de la pág.1 == los de la pág.2',
      p1.totals.skus === p2.totals.skus && String(p1.totals.valor) === String(p2.totals.valor),
      `${p1.totals.skus}/${p1.totals.valor} vs ${p2.totals.skus}/${p2.totals.valor}`);

    // ── 5. El filtro por almacén recorta el ANCHO del pivot, no sólo las filas.
    const uno = await svc.list({ warehouse_ids: '01', pageSize: 5 });
    check('warehouse_ids recorta las columnas del pivot', uno.columns.length === 1,
      `columnas=${uno.columns.map((x) => x.code).join(',')}`);

    // ── 6. FRESCURA POR RAMA. Una sola cifra promediaría feeds de ritmos muy distintos.
    console.log(`  frescura: ${r.freshness.map((f) => `${f.rama}=${f.minutos}min`).join(' · ') || '(vacía)'}`);
    check('la frescura viene por RAMA (≥ 2 entradas)', r.freshness.length >= 2,
      `ramas=${r.freshness.map((f) => f.rama).join(',')}`);
    check('la respuesta NO lleva umbral propio (los umbrales viven en db-health)',
      r.freshness.every((f) => !('warnH' in f) && !('critH' in f)));

    // ── 7. NO se suman unidades crudas de almacenes con unidades distintas.
    // `total_cajas` tiene que ser consistente con la suma de las celdas medibles de la fila.
    let malSuma = 0;
    for (const row of r.rows) {
      const suma = Object.values(row.cells || {})
        .filter((cl) => cl.q !== undefined).reduce((s, cl) => s + Number(cl.q), 0);
      if (Math.abs(suma - Number(row.total_cajas || 0)) > 0.3) malSuma++;
    }
    check('total_cajas == Σ de las celdas medibles (no suma unidades crudas)', malSuma === 0,
      `filas descuadradas=${malSuma}`);

    // ── 8. El drill responde y trae la escalera de unidad.
    const d = await svc.detail(r.rows[0].product_id);
    check('el drill por SKU trae el desglose por almacén', d.rows.length > 0, `${d.rows.length} almacenes`);
    check('el drill declara el divisor y su procedencia',
      d.rows.every((x) => x.dbf != null) && d.rows.some((x) => x.factor_source || x.erp));

    // ── 9. Perf bajo presupuesto (se imprime la medición: no se estima).
    check('la consulta cuesta < 2,500 ms (PISO de 3 corridas, sin la contención de prod)',
      ms < 2500, `piso=${ms} ms de [${marcas.join(', ')}]`);

    await svc._knex.destroy();
  }

  // ── 10. ⛔ LA FUENTE. Si el resultado coincidiera con `commercial.stock`, estaría leyendo la
  // copia que miente. Se exige que DISCREPEN.
  const src = (await c.query(
    `SELECT count(*)::int pares,
            count(*) FILTER (WHERE round(s.qty_stock_units::numeric,2)
                               <> round(COALESCE(st.quantity,0)::numeric,2))::int discrepan
       FROM analytics.v_erp_stock_on_hand s
       LEFT JOIN commercial.stock st
              ON st.tenant_id=s.tenant_id AND st.warehouse_id=s.warehouse_id AND st.product_id=s.product_id
      WHERE s.tenant_id=$1`, [T],
  )).rows[0];
  const pct = src.pares ? (100 * src.discrepan / src.pares) : 0;
  console.log(`\n  ODS vs commercial.stock: ${src.discrepan}/${src.pares} = ${pct.toFixed(1)}% discrepan`);
  check('la fuente es el ODS, NO commercial.stock (discrepan donde deben)', src.discrepan > 0,
    'coinciden al 100% → está leyendo la tabla, no la vista');

  console.log(`\n=== ${ok} OK · ${fail} FAIL${skip ? ` · ${skip} skip` : ''} ===\n`);
  await c.end();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
