/* eslint-disable no-console */
/**
 * AB.0b — Candado de la **foto de inventario**.
 *
 * ── Qué se prueba, y por qué así ─────────────────────────────────────────────
 * Ejercita el **servicio real** (`StockSnapshotService`), no una copia de su SQL. Un test que
 * reimplementa la consulta del servicio se comprueba a sí mismo: las dos copias pueden estar
 * igual de mal y el test sale verde. Por eso se carga la clase con `ts-node` y se le pasa un
 * Knex — el constructor sólo pide eso.
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
 *   · re-correr el mismo día debe **corregir**, no duplicar (idempotencia por PK).
 *
 * Todo corre en UNA transacción con ROLLBACK: no persiste nada.
 */
const path = require('path');
// Antes de cualquier import del monorepo: `platform-core` valida JWT_SECRET al CARGARSE
// (fail-fast de AUTHZ-HARD), así que sin el entorno cargado el require revienta.
require('dotenv').config({ path: path.join(__dirname, '../../.env'), quiet: true });
const { noMedido: salirNoMedido, esFaltaDeAcceso } = require('./_lib/no-medido.js');

const T = '00000000-0000-0000-0000-00000000d01c';
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m); } };

let knex;
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
    knex = require('knex')(require('../knexfile-newdb.js').development);
    await knex.raw('select 1');
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

      // ── 2. El servicio REAL, sobre datos controlados ───────────────────────
      const svc = new StockSnapshotService(trx);
      const wh = await trx('commercial.warehouses').where('tenant_id', T).first('id');
      const prods = await trx('catalog.products').where('tenant_id', T).limit(2).select('id');
      if (!wh || prods.length < 2) return salirNoMedido('faltan almacén o productos base en este entorno');

      // Un producto CON costo y otro SIN costo, para las dos ramas del valorizado.
      await trx('catalog.products').where({ tenant_id: T, id: prods[0].id })
        .update({ cost_with_tax: 12.5, cost_base: 10 });
      await trx('catalog.products').where({ tenant_id: T, id: prods[1].id })
        .update({ cost_with_tax: null, cost_base: null });

      const FECHA = '2026-03-31'; // último día de marzo → cierre de mes Y de trimestre
      const upStock = (pid, qty) => trx('commercial.stock')
        .insert({ tenant_id: T, warehouse_id: wh.id, product_id: pid, quantity: qty, reserved_quantity: 0 })
        .onConflict(['tenant_id', 'warehouse_id', 'product_id']).merge(['quantity', 'reserved_quantity']);
      await upStock(prods[0].id, 40);
      await upStock(prods[1].id, 0); // ← el que NO debe dejar fila

      const r1 = await svc.snapshotTenant(T, FECHA);
      ok(r1.fecha_corte === FECHA, `la fecha de corte respeta el parámetro (${r1.fecha_corte})`);

      const filas = await trx('analytics.stock_snapshots')
        .where({ tenant_id: T, fecha_corte: FECHA, warehouse_id: wh.id })
        .whereIn('product_id', [prods[0].id, prods[1].id]).select('*');
      const conSaldo = filas.find((x) => x.product_id === prods[0].id);
      const enCero = filas.find((x) => x.product_id === prods[1].id);

      ok(!!conSaldo, 'el par con saldo deja fila');
      ok(Number(conSaldo.valor) === 40 * 12.5, `valor = unidades × cost_with_tax (${conSaldo.valor})`);
      ok(conSaldo.costo_fuente === 'cost_with_tax', 'declara de qué columna salió el costo');

      // NEGATIVA 1 — el cero no deja fila, pero su almacén sí queda cubierto.
      ok(!enCero, 'NEGATIVA: el par en CERO no deja fila');
      const cov = await trx('analytics.stock_snapshot_coverage')
        .where({ tenant_id: T, fecha_corte: FECHA, warehouse_id: wh.id }).first();
      ok(!!cov, 'el almacén SÍ queda en coverage → la ausencia se puede leer como cero, no como "no medido"');
      ok(Number(cov.pares_en_cero) >= 1, `coverage cuenta los que quedaron en cero (${cov.pares_en_cero})`);

      // NEGATIVA 2 — sin costo NO se dibuja 0 (ADR-056).
      await upStock(prods[1].id, 7);
      await svc.snapshotTenant(T, FECHA);
      const sinCosto = await trx('analytics.stock_snapshots')
        .where({ tenant_id: T, fecha_corte: FECHA, warehouse_id: wh.id, product_id: prods[1].id }).first();
      ok(!!sinCosto, 'el par sin costo con saldo sí deja fila');
      ok(sinCosto.valor === null, 'NEGATIVA: sin costo el valor queda NULL, no 0');
      ok(sinCosto.costo_fuente === null, 'NEGATIVA: la fuente de costo queda NULL, no inventada');
      const cov2 = await trx('analytics.stock_snapshot_coverage')
        .where({ tenant_id: T, fecha_corte: FECHA, warehouse_id: wh.id }).first();
      ok(Number(cov2.pares_sin_costo) >= 1, `coverage DECLARA cuántos pares no se pudieron costear (${cov2.pares_sin_costo})`);
      ok(cov2.valor_total === null, 'NEGATIVA: con un par sin costo, el total del almacén es NULL, no un total parcial');

      // NEGATIVA 3 — re-correr corrige, no duplica.
      await upStock(prods[0].id, 99);
      await svc.snapshotTenant(T, FECHA);
      const dup = await trx('analytics.stock_snapshots')
        .where({ tenant_id: T, fecha_corte: FECHA, warehouse_id: wh.id, product_id: prods[0].id }).select('*');
      ok(dup.length === 1, 'NEGATIVA: re-correr el mismo día NO duplica la fila');
      ok(Number(dup[0].unidades) === 99, 'NEGATIVA: re-correr CORRIGE la cantidad (40 → 99)');

      // ── 3. Las banderas de cierre se derivan de la fecha ───────────────────
      ok(dup[0].cierre_mes === true, '31-mar marcado como cierre de MES');
      ok(dup[0].cierre_trimestre === true, '31-mar marcado como cierre de TRIMESTRE');
      ok(dup[0].cierre_anio === false, '31-mar NO es cierre de AÑO');
      await upStock(prods[0].id, 5);
      await svc.snapshotTenant(T, '2026-03-30'); // lunes
      const lunes = await trx('analytics.stock_snapshots')
        .where({ tenant_id: T, fecha_corte: '2026-03-30', warehouse_id: wh.id, product_id: prods[0].id }).first();
      ok(lunes && lunes.cierre_mes === false && lunes.cierre_semana === false,
        'NEGATIVA: un día cualquiera no lleva ninguna bandera de cierre');

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
  }

  console.log(`\n  ${pass} ✓ / ${fail} ✗`);
  process.exit(fail ? 1 : 0);
})();
