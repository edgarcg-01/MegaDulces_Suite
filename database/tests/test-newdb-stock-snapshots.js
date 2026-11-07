/* eslint-disable no-console */
/**
 * AB.0b — Candado de la **foto de inventario**.
 *
 * ── Qué se prueba, y por qué así ─────────────────────────────────────────────
 * Ejercita el **servicio real** (`StockSnapshotService`), no una copia de su SQL. Un test que
 * reimplementa la consulta del servicio se comprueba a sí mismo: las dos copias pueden estar
 * igual de mal y el test sale verde. Por eso se carga la clase con `ts-node`.
 *
 * Si `ts-node` o la DB no están, la suite sale **NO MEDIDO** (exit 2), no verde: es la regla
 * de ADR-056 aplicada al harness. Un candado que se rinde en silencio pasa justo en el entorno
 * donde alguien lo correría.
 *
 * ── Las pruebas NEGATIVAS son la mitad del valor ─────────────────────────────
 * Un gate sin prueba negativa es una intención. Acá se rompe a propósito:
 *   · un par con saldo CERO **no** debe dejar fila (y su almacén SÍ debe quedar en coverage);
 *   · un producto **sin costo** debe dejar `valor` en NULL, **nunca 0** — un cero se sumaría
 *     al valorizado del cierre como si la mercancía no valiera nada;
 *   · re-correr el mismo día debe **reemplazarlo**: ni duplicar, ni dejar el saldo viejo de un
 *     par que quedó en cero.
 *
 * ── [EX.H0] Las fuentes son TABLAS TEMPORALES, el SQL es el del servicio ─────
 * Desde EX.H0 la foto lee la existencia de `analytics.v_erp_stock_on_hand` (la de la pantalla
 * Existencia) y guarda el costo del ERP (última entrada, `kdik.c16`) y el estándar del día. Esas
 * vistas derivan de `kepler_ods`, que en el entorno de prueba está vacío; por eso el servicio
 * recibe los NOMBRES de sus tres fuentes y la prueba le pasa tablas temporales con casos
 * controlados. El SQL que corre es el de producción — sólo cambia de dónde lee. Casos:
 *   · P0 casa con el ERP en el peldaño 2 (10.2 ≈ 10) → `erp_rung`. ⛔ Con la unidad base (0.5) el
 *     valor saldría 20× abajo: es el error que subvaluaba la sucursal 01 un 11 %.
 *   · P1 ningún peldaño casa (100 y 1000 contra 10) → `doubtful_unit`, costo NULL, nunca 0.
 *   · P2 sin costo del ERP → `base_unit_no_witness` (la unidad base que declara Kepler).
 *   · P3 sin estándar → `none`, costo NULL.
 *   · El umbral de 2× se fija POR LOS DOS LADOS (1.9× casa, 2.1× no) y por debajo del ERP.
 *   · DOS almacenes con costos distintos: un join que pierda el almacén se pone rojo.
 *   · La consulta tiene que correr DENTRO de `tk.run`: el servicio recibe como `knex` una
 *     conexión APARTE, sin tenant y sin las tablas temporales — si una sentencia se sale de
 *     `tk.run` (el bug de `[INV-FOTO.1]`), no encuentra sus fuentes y la prueba revienta.
 *   · La rama SIN la migración EX.H0 (esquema viejo) también se ejerce.
 *
 * ⚠️ Esta prueba estuvo MUERTA dos veces sin que nada lo dijera: desde `[INV-FOTO.1]` construía el
 * servicio sin `tk` (reventaba con `undefined.run`), y en el CI ni llegaba a eso — sin `JWT_SECRET`
 * la carga de `platform-core` fallaba y la suite salía NO MEDIDO (revisión de EX.H0, 2026-11-06).
 *
 * Todo corre en UNA transacción con ROLLBACK: no persiste nada.
 */
const path = require('path');
// Antes de cualquier import del monorepo: `platform-core` valida JWT_SECRET al CARGARSE
// (fail-fast de AUTHZ-HARD), así que sin el entorno cargado el require revienta.
require('dotenv').config({ path: path.join(__dirname, '../../.env'), quiet: true });
// En el CI no hay `.env`: sin esto la suite salía NO MEDIDO antes de su primera aserción. La
// prueba no firma ni verifica tokens; sólo necesita que el módulo cargue. Mismo patrón que
// `test-newdb-alc-alta-clientes.js` y `test-newdb-business-definitions-service.js`.
process.env.JWT_SECRET = process.env.JWT_SECRET || `prueba-local-exh0-${'x'.repeat(40)}`;
const { noMedido: salirNoMedido, esFaltaDeAcceso } = require('./_lib/no-medido.js');

const T = '00000000-0000-0000-0000-00000000d01c';
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m); } };

let knex, knexFuera;
(async () => {
  // El servicio es TypeScript con decoradores de Nest → ts-node con el tsconfig del repo.
  let StockSnapshotService;
  try {
    require('ts-node').register({
      transpileOnly: true,
      skipProject: true, // ignora el tsconfig del monorepo: su rootDir no aplica a un archivo suelto
      compilerOptions: { module: 'commonjs', moduleResolution: 'node', target: 'es2021', experimentalDecorators: true, emitDecoratorMetadata: true, ignoreDeprecations: '6.0' },
    });
    // Los imports del servicio usan alias del monorepo (@megadulces/platform-core); sin esto
    // ts-node no los resuelve y la suite saldría NO MEDIDO por una razón de plomería.
    // tsconfig.base.json lleva comentarios (JSONC) → JSON.parse revienta; el lector de
    // TypeScript sí los entiende.
    const tsc = require('typescript');
    const baseFile = path.join(__dirname, '../../tsconfig.base.json');
    const base = tsc.readConfigFile(baseFile, tsc.sys.readFile).config;
    require('tsconfig-paths').register({
      baseUrl: path.join(__dirname, '../..'),
      paths: base.compilerOptions.paths,
    });
    require('reflect-metadata');
    ({ StockSnapshotService } = require(
      path.join(__dirname, '../../libs/commercial/src/lib/commercial-inventory/stock-snapshot.service.ts'),
    ));
  } catch (e) {
    return salirNoMedido(`no se pudo cargar el servicio real con ts-node: ${e.message}`);
  }

  try {
    const cfg = require('../knexfile-newdb.js').development;
    knex = require('knex')(cfg);
    // Una conexión APARTE, sin tenant y sin las tablas temporales: es el `knex` del servicio.
    knexFuera = require('knex')(cfg);
    await knex.raw('select 1');
    await knexFuera.raw('select 1');
  } catch (e) {
    return salirNoMedido(`sin acceso a la base: ${e.message}`);
  }

  try {
    await knex.transaction(async (trx) => {
      await trx.raw(`SET LOCAL app.tenant_id = '${T}'`);

      // ── 1. Schema ──────────────────────────────────────────────────────────
      const reg = async (s, n) => (await trx.raw('select to_regclass(?) r', [`${s}.${n}`])).rows[0].r;
      ok(await reg('analytics', 'stock_snapshots'), 'tabla analytics.stock_snapshots');
      ok(await reg('analytics', 'stock_snapshot_coverage'), 'tabla analytics.stock_snapshot_coverage');
      const pk = (await trx.raw(
        `select pg_get_constraintdef(oid) d from pg_constraint
          where conrelid='analytics.stock_snapshots'::regclass and contype='p'`)).rows[0];
      ok(pk && /fecha_corte/.test(pk.d), 'la PK incluye fecha_corte (idempotencia por día)');

      // [EX.H0] Las columnas de la migración: sin ellas el servicio fotografía con el esquema viejo.
      const col = async (t, c) => (await trx.raw(
        `select 1 from information_schema.columns where table_schema='analytics' and table_name=? and column_name=?`,
        [t, c])).rows.length === 1;
      ok(await col('stock_snapshots', 'standard_unit_cost'), 'EX.H0: stock_snapshots.standard_unit_cost existe');
      ok(await col('stock_snapshots', 'erp_unit_cost'), 'EX.H0: stock_snapshots.erp_unit_cost existe');
      ok(await col('stock_snapshot_coverage', 'standard_doubtful_pairs'), 'EX.H0: coverage.standard_doubtful_pairs existe');

      // ── 2. El servicio REAL, sobre datos controlados ───────────────────────
      // `tk` corre sobre ESTA transacción (tenant puesto, tablas temporales visibles) y anota con
      // qué tenant lo llamaron. El `knex` del servicio es la OTRA conexión.
      let tenantVisto = null;
      const svc = new StockSnapshotService(knexFuera, { run: (t, fn) => { tenantVisto = t; return fn(trx); } });

      const whs = await trx('commercial.warehouses').where('tenant_id', T).orderBy('id').limit(2).select('id');
      const prods = await trx('catalog.products').where('tenant_id', T).orderBy('id').limit(4).select('id');
      if (whs.length < 2 || prods.length < 4) return salirNoMedido('faltan 2 almacenes o 4 productos base en este entorno');
      const [A, B] = whs;

      // Precondiciones PROPIAS, no heredadas del entorno: cada producto con su sku de prueba y su
      // costo de catálogo, y cada almacén con su sucursal de Kepler (el estándar se une por ella).
      const SKUS = ['ZT-EXH0-P0', 'ZT-EXH0-P1', 'ZT-EXH0-P2', 'ZT-EXH0-P3'];
      const CATALOGO = [[12.5, 10], [null, null], [3, 3], [2, 2]]; // P1 SIN costo de catálogo
      for (let i = 0; i < 4; i++) {
        await trx('catalog.products').where({ tenant_id: T, id: prods[i].id })
          .update({ sku: SKUS[i], cost_with_tax: CATALOGO[i][0], cost_base: CATALOGO[i][1] });
        prods[i].sku = SKUS[i];
      }
      const [P0, P1, P2, P3] = prods;
      await trx('commercial.warehouses').where({ tenant_id: T, id: A.id }).update({ kepler_code: 'ZT' });
      await trx('commercial.warehouses').where({ tenant_id: T, id: B.id }).update({ kepler_code: 'ZU' });

      // Las tres fuentes, como tablas temporales con la forma de las vistas canónicas.
      await trx.raw(`CREATE TEMP TABLE f_existencia (tenant_id uuid, warehouse_id uuid, product_id uuid,
                       sku text, qty_stock_units numeric) ON COMMIT DROP`);
      await trx.raw(`CREATE TEMP TABLE f_costo_erp (tenant_id uuid, warehouse_id uuid, product_id uuid,
                       costo_unitario numeric) ON COMMIT DROP`);
      await trx.raw(`CREATE TEMP TABLE f_estandar (sucursal text, sku text, costo_estandar numeric,
                       costo_estandar_u2 numeric, costo_estandar_u3 numeric) ON COMMIT DROP`);
      const FUENTES = { existencia: 'pg_temp.f_existencia', costoErp: 'pg_temp.f_costo_erp', costoEstandar: 'pg_temp.f_estandar' };

      const existencia = async (w, p, qty) => {
        await trx.raw('DELETE FROM pg_temp.f_existencia WHERE warehouse_id = ? AND product_id = ?', [w.id, p.id]);
        if (qty !== null) await trx.raw('INSERT INTO pg_temp.f_existencia VALUES (?, ?, ?, ?, ?)', [T, w.id, p.id, p.sku, qty]);
      };
      const costoErp = async (w, p, c) => {
        await trx.raw('DELETE FROM pg_temp.f_costo_erp WHERE warehouse_id = ? AND product_id = ?', [w.id, p.id]);
        await trx.raw('INSERT INTO pg_temp.f_costo_erp VALUES (?, ?, ?, ?)', [T, w.id, p.id, c]);
      };
      const estandar = async (suc, p, c1, c2, c3) => {
        await trx.raw('DELETE FROM pg_temp.f_estandar WHERE sucursal = ? AND sku = ?', [suc, p.sku]);
        await trx.raw('INSERT INTO pg_temp.f_estandar VALUES (?, ?, ?, ?, ?)', [suc, p.sku, c1, c2, c3]);
      };

      // Almacén A (sucursal ZT)
      await existencia(A, P0, 40); await costoErp(A, P0, 10); await estandar('ZT', P0, 0.5, 10.2, null); // casa en el peldaño 2
      await existencia(A, P1, 0);  await costoErp(A, P1, 10); await estandar('ZT', P1, 100, 1000, null); // ← el que NO deja fila
      await existencia(A, P2, 3);                             await estandar('ZT', P2, 4, 48, null);     // sin costo del ERP
      await existencia(A, P3, 2);  await costoErp(A, P3, 5);                                             // sin estándar
      // Almacén B (sucursal ZU): el MISMO producto con OTRO costo del ERP y OTRO estándar.
      await existencia(B, P0, 5);  await costoErp(B, P0, 20); await estandar('ZU', P0, 1, 19.8, null);

      const FECHA = '2026-03-31'; // último día de marzo → cierre de mes Y de trimestre
      const r1 = await svc.snapshotTenant(T, FECHA, FUENTES);
      ok(r1.fecha_corte === FECHA, `la fecha de corte respeta el parámetro (${r1.fecha_corte})`);
      ok(r1.esquema_ex_h0 === true, 'EX.H0: el servicio detecta el esquema nuevo');
      ok(tenantVisto === T, 'EX.H0: la foto corre DENTRO de tk.run con el tenant (la conexión de afuera no ve las fuentes)');
      ok(r1.warehouses === 2 && r1.pares === 4 && r1.pares_en_cero === 1 && r1.pares_retirados === 0,
        `lo que lleva el latido: 2 almacenes · 4 pares · 1 en cero · 0 retirados (${r1.warehouses} · ${r1.pares} · ${r1.pares_en_cero} · ${r1.pares_retirados})`);

      const fila = (w, p, f = FECHA) => trx('analytics.stock_snapshots')
        .where({ tenant_id: T, fecha_corte: f, warehouse_id: w.id, product_id: p.id }).first();
      const cobertura = (w, f = FECHA) => trx('analytics.stock_snapshot_coverage')
        .where({ tenant_id: T, fecha_corte: f, warehouse_id: w.id }).first();
      const filasDe = async (w, f = FECHA) => Number((await trx('analytics.stock_snapshots')
        .where({ tenant_id: T, fecha_corte: f, warehouse_id: w.id }).count('* as n'))[0].n);

      const a0 = await fila(A, P0);
      ok(!!a0, 'el par con saldo deja fila');
      ok(Number(a0.valor) === 40 * 12.5, `valor = unidades × cost_with_tax (${a0.valor})`);
      ok(a0.costo_fuente === 'cost_with_tax', 'declara de qué columna salió el costo');
      ok(Number(a0.erp_unit_cost) === 10, `EX.H0: guarda el costo del ERP del día (${a0.erp_unit_cost})`);
      ok(Number(a0.standard_unit_cost) === 10.2 && a0.standard_cost_rule === 'erp_rung',
        `EX.H0 NEGATIVA: el estándar es el PELDAÑO que casa con el ERP (10.2), no la unidad base 0.5 (${a0.standard_unit_cost}, ${a0.standard_cost_rule})`);
      ok(a0.reservadas === null && a0.disponibles === null,
        'EX.H0 NEGATIVA: la fuente no trae apartados → reservadas/disponibles NULL, no 0');
      const b0 = await fila(B, P0);
      ok(Number(b0.erp_unit_cost) === 20 && Number(b0.standard_unit_cost) === 19.8,
        `EX.H0: cada almacén con SU costo del ERP y SU estándar (B: ${b0.erp_unit_cost}, ${b0.standard_unit_cost})`);

      // NEGATIVA 1 — el cero no deja fila, pero su almacén sí queda cubierto.
      ok(!(await fila(A, P1)), 'NEGATIVA: el par en CERO no deja fila');
      const cov = await cobertura(A);
      ok(!!cov, 'el almacén SÍ queda en coverage → la ausencia se puede leer como cero, no como "no medido"');
      ok(Number(cov.pares_en_cero) === 1, `coverage cuenta los que quedaron en cero (${cov.pares_en_cero})`);
      ok(cov.stock_source === 'analytics.v_erp_stock_on_hand', `EX.H0: coverage declara la fuente (${cov.stock_source})`);
      ok(!!(await cobertura(B)), 'EX.H0: una fila de cobertura POR almacén (B también)');

      const a2 = await fila(A, P2);
      ok(Number(a2.standard_unit_cost) === 4 && a2.standard_cost_rule === 'base_unit_no_witness' && a2.erp_unit_cost === null,
        `EX.H0: sin costo del ERP se usa la unidad base y se dice (${a2.standard_unit_cost}, ${a2.standard_cost_rule})`);
      const a3 = await fila(A, P3);
      ok(a3.standard_unit_cost === null && a3.standard_cost_rule === 'none',
        `EX.H0 NEGATIVA: sin estándar el costo queda NULL, no 0 (${a3.standard_unit_cost}, ${a3.standard_cost_rule})`);

      // NEGATIVA 2 — sin costo NO se dibuja 0 (ADR-056). P1 vuelve con saldo y SIN costo de catálogo,
      // y además su estándar no casa con el ERP en ningún peldaño.
      await existencia(A, P1, 7);
      await svc.snapshotTenant(T, FECHA, FUENTES);
      const a1 = await fila(A, P1);
      ok(!!a1, 'el par sin costo con saldo sí deja fila');
      ok(a1.valor === null, 'NEGATIVA: sin costo el valor queda NULL, no 0');
      ok(a1.costo_fuente === null, 'NEGATIVA: la fuente de costo queda NULL, no inventada');
      ok(a1.standard_unit_cost === null && a1.standard_cost_rule === 'doubtful_unit',
        `EX.H0 NEGATIVA: si ningún peldaño casa con el ERP, unidad DUDOSA y SIN valor (${a1.standard_unit_cost}, ${a1.standard_cost_rule})`);
      const cov2 = await cobertura(A);
      ok(Number(cov2.pares_sin_costo) === 1, `coverage DECLARA cuántos pares no se pudieron costear (${cov2.pares_sin_costo})`);
      ok(cov2.valor_total === null, 'NEGATIVA: con un par sin costo, el total del almacén es NULL, no un total parcial');
      // Estándar conocido = P0 40×10.2 + P2 3×4 = 420; P1 (dudosa) y P3 (sin estándar) NO suman.
      ok(Number(cov2.standard_value_known) === 420, `EX.H0: el valor estándar suma SÓLO lo valuado (${cov2.standard_value_known})`);
      ok(cov2.standard_doubtful_pairs === 1 && cov2.standard_missing_pairs === 1,
        `EX.H0: declara 1 dudosa y 1 sin estándar (${cov2.standard_doubtful_pairs}, ${cov2.standard_missing_pairs})`);
      // ERP conocido = P0 40×10 + P1 7×10 + P3 2×5 = 480; P2 no tiene costo del ERP.
      ok(Number(cov2.erp_value_known) === 480 && cov2.erp_missing_pairs === 1,
        `EX.H0: el valor ERP suma lo valuado y declara el faltante (${cov2.erp_value_known}, ${cov2.erp_missing_pairs})`);
      const covB = await cobertura(B);
      ok(Number(covB.standard_value_known) === 99 && Number(covB.erp_value_known) === 100,
        `EX.H0: los totales de B son de B (5×19.8 = 99 · 5×20 = 100) (${covB.standard_value_known}, ${covB.erp_value_known})`);

      // ── 3. El umbral de 2×, fijado por los dos lados (P0 en A, costo del ERP 10) ──
      const peldano = async (c1, c2) => {
        await estandar('ZT', P0, c1, c2, null);
        await svc.snapshotTenant(T, FECHA, FUENTES);
        return fila(A, P0);
      };
      let u = await peldano(0.5, 19);
      ok(Number(u.standard_unit_cost) === 19 && u.standard_cost_rule === 'erp_rung', `EX.H0: a 1.9× del ERP todavía CASA (${u.standard_unit_cost}, ${u.standard_cost_rule})`);
      u = await peldano(0.5, 21);
      ok(u.standard_unit_cost === null && u.standard_cost_rule === 'doubtful_unit', `EX.H0 NEGATIVA: a 2.1× del ERP ya NO casa (${u.standard_unit_cost}, ${u.standard_cost_rule})`);
      u = await peldano(0.5, 5.5);
      ok(Number(u.standard_unit_cost) === 5.5 && u.standard_cost_rule === 'erp_rung', `EX.H0: un peldaño POR DEBAJO del ERP (0.55×) también casa (${u.standard_unit_cost}, ${u.standard_cost_rule})`);
      await estandar('ZT', P0, 0.5, 10.2, null);

      // NEGATIVA 3 — re-correr REEMPLAZA: corrige cantidades Y costos, no duplica.
      await existencia(A, P0, 99);
      await costoErp(A, P0, 12);
      await estandar('ZT', P0, 0.5, 12.3, null);
      await estandar('ZT', P3, 5.1, null, null);   // P3 ahora SÍ tiene estándar (5.1 ≈ 5)
      await svc.snapshotTenant(T, FECHA, FUENTES);
      const dup = await trx('analytics.stock_snapshots')
        .where({ tenant_id: T, fecha_corte: FECHA, warehouse_id: A.id, product_id: P0.id }).select('*');
      ok(dup.length === 1, 'NEGATIVA: re-correr el mismo día NO duplica la fila');
      ok(Number(dup[0].unidades) === 99, 'NEGATIVA: re-correr CORRIGE la cantidad (40 → 99)');
      ok(Number(dup[0].erp_unit_cost) === 12 && Number(dup[0].standard_unit_cost) === 12.3,
        `EX.H0 NEGATIVA: re-correr CORRIGE también los costos del día (${dup[0].erp_unit_cost}, ${dup[0].standard_unit_cost})`);
      const cov3 = await cobertura(A);
      // 99×12.3 + 3×4 + 2×5.1 = 1239.9 · 99×12 + 7×10 + 2×5 = 1268
      ok(Number(cov3.standard_value_known) === 1239.9 && cov3.standard_missing_pairs === 0 && Number(cov3.erp_value_known) === 1268,
        `EX.H0 NEGATIVA: re-correr CORRIGE los totales de la cobertura (${cov3.standard_value_known}, ${cov3.standard_missing_pairs}, ${cov3.erp_value_known})`);

      // NEGATIVA 4 — un par que quedó en CERO al re-tomar se BORRA (antes conservaba su saldo viejo
      // mientras la cobertura lo contaba en cero). Y un almacén que dejó de venir en la fuente
      // (el caso MD-32) conserva sus filas y su cobertura de ese día, coherentes entre sí.
      await existencia(A, P2, 0);
      await existencia(B, P0, null);
      const r4 = await svc.snapshotTenant(T, FECHA, FUENTES);
      ok(!(await fila(A, P2)), 'EX.H0 NEGATIVA: al re-tomar, el par que quedó en CERO pierde su fila');
      ok(r4.pares_retirados === 1, `EX.H0: el resultado cuenta lo retirado (${r4.pares_retirados})`);
      const cov4 = await cobertura(A);
      ok(Number(cov4.pares) === (await filasDe(A)), `EX.H0: filas y cobertura cuentan lo MISMO (${cov4.pares} vs ${await filasDe(A)})`);
      ok(!!(await fila(B, P0)) && !!(await cobertura(B)), 'EX.H0: un almacén que no vino en la fuente conserva su foto de ese día');

      // ── 4. Las banderas de cierre se derivan de la fecha ───────────────────
      ok(dup[0].cierre_mes === true, '31-mar marcado como cierre de MES');
      ok(dup[0].cierre_trimestre === true, '31-mar marcado como cierre de TRIMESTRE');
      ok(dup[0].cierre_anio === false, '31-mar NO es cierre de AÑO');
      await existencia(A, P0, 5);
      await svc.snapshotTenant(T, '2026-03-30', FUENTES); // lunes
      const lunes = await fila(A, P0, '2026-03-30');
      ok(lunes && lunes.cierre_mes === false && lunes.cierre_semana === false,
        'NEGATIVA: un día cualquiera no lleva ninguna bandera de cierre');

      // ── 5. La rama SIN la migración EX.H0 (esquema viejo) ──────────────────
      // Se fuerza la respuesta del detector: el SQL que corre es el de esa rama, con lo que el
      // esquema viejo exigía (reservadas 0 / disponibles = unidades) y sin las columnas nuevas.
      svc.tieneEsquemaExH0 = async () => false;
      const r5 = await svc.snapshotTenant(T, '2026-03-29', FUENTES);
      delete svc.tieneEsquemaExH0;
      const viejo = await fila(A, P0, '2026-03-29');
      ok(r5.esquema_ex_h0 === false, 'EX.H0: sin la migración, el resultado lo dice (el latido sale en error)');
      ok(!!viejo && Number(viejo.reservadas) === 0 && Number(viejo.disponibles) === Number(viejo.unidades),
        'EX.H0: la rama vieja fotografía igual (no se pierde el día) con lo que el esquema viejo exige');
      ok(viejo && viejo.standard_unit_cost === null && viejo.standard_cost_rule === null,
        'EX.H0: la rama vieja no inventa los costos del día');

      // ── 6. Un nombre de fuente se interpola en el SQL: sólo esquema.nombre ──
      let rechazada = false;
      try { await svc.snapshotTenant(T, FECHA, { ...FUENTES, existencia: 'pg_temp.x; drop table y' }); }
      catch (e) { rechazada = /fuente de la foto inválida/.test(e.message); }
      ok(rechazada, 'NEGATIVA: una fuente que no es esquema.nombre se rechaza antes de tocar la base');

      throw new Error('__ROLLBACK__'); // nada de esto persiste
    });
  } catch (e) {
    if (!/__ROLLBACK__/.test(e.message)) {
      if (esFaltaDeAcceso(e)) return salirNoMedido(`sin acceso: ${e.message}`);
      console.error('  ✗ excepción:', e.message);
      fail++;
    }
  } finally {
    if (knex) await knex.destroy();
    if (knexFuera) await knexFuera.destroy();
  }

  console.log(`\n  ${pass} ✓ / ${fail} ✗`);
  process.exit(fail ? 1 : 0);
})();
