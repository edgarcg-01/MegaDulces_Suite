/**
 * [IG.12] La pestana "Cuadra" tardaba 93 SEGUNDOS, y el culpable era un seq scan por fila.
 *
 * Edgar: *"cuadra ahora tarda demasiado"*. Medido contra prod el 2026-10-02, consulta por
 * consulta, con el rango por defecto de la pantalla (90 dias):
 *
 *     contable / bruta / devoluciones (income_entries_src) .....    198 ms
 *     hecho de venta (mv_sales_blended) ........................    145 ms
 *     fuera de alcance (income_out_of_scope) ...................     51 ms
 *     cobranza (analytics.erp_collections) ..................... 93,348 ms   <--
 *
 * ── EL MECANISMO, LEIDO DEL PLAN (no supuesto) ────────────────────────────────────────────
 * analytics.erp_collections es una VISTA sobre kepler_ods.kdm1 que, para los cobros con
 * complemento de pago (c4 = 7), sale a buscar la fecha REAL del cobro en kdfe33pagm1. El plan:
 *
 *     Nested Loop Left Join  (cost=2485.80..38721.42 rows=1)
 *       Join Filter: ((m.c4 = 7) AND (btrim(p.c1) = btrim(m.sucursal))
 *                                 AND (btrim(p.c3) = btrim(m.c6)))
 *       ->  Bitmap Heap Scan on kdm1 m   (rows=1)      <-- son 27,410
 *       ->  Seq Scan on kdfe33pagm1 p                  <-- 3,613 filas, POR CADA UNA
 *
 * Dos cosas se juntan: (1) los predicados de la vista van sobre expresiones (btrim(c2)='U',
 * btrim(c3)='A', btrim(c1)=btrim(sucursal)), asi que el planner los estima al 0.5% cada uno y
 * multiplica hasta rows=1; con rows=1 un Nested Loop con seq scan adentro parece gratis.
 * (2) El join es por btrim(), que NINGUN indice existente puede servir -- la PK es
 * (sucursal, c1, c2, c3, c4) y btrim() la anula. Resultado: 27,410 x 3,613 = 99 millones de
 * comparaciones con btrim en los dos lados.
 *
 * ⭐ Es el MISMO cuadro que [IG.11] acaba de pagar en la Conciliacion y que [PERF.1] y
 * [RA-DYN.U3] pagaron antes: una estimacion de rows=1 vuelve barato re-evaluar lo de adentro
 * por cada fila de afuera. Alla se arreglo con MATERIALIZED porque el lado interno era un CTE;
 * aca el lado interno es una TABLA, asi que lo que corresponde es darle un indice.
 *
 * ── LA PRUEBA DE QUE ES ESTO, Y NO OTRA COSA ──────────────────────────────────────────────
 * La misma consulta, misma sesion, con SET LOCAL enable_nestloop = off:
 *
 *     93,348 ms  ->  411 ms      ($141,865,179.26 en los dos casos, al centavo)
 *
 * O sea: no sobra trabajo que hacer, sobra la FORMA de hacerlo.
 *
 * ── QUE HACE ESTA MIGRACION ───────────────────────────────────────────────────────────────
 * Un indice de expresion sobre el prefijo exacto del join. Es aditivo: no cambia ni una cifra,
 * no toca la vista, no toca la tabla primaria. Sobre 3,613 filas / 704 kB el indice es de
 * kilobytes, y kdfe33pagm1 se escribe por UPSERT del CDC: el costo de mantenerlo es despreciable.
 *
 * ── ⛔ POR QUE **NO** VA CON CONCURRENTLY, aunque el repo use ese patron en otras 3 migraciones ─
 * Se intento primero con CONCURRENTLY, como manda la costumbre de este repo para no bloquear, y
 * **fallo a los 15 s con `canceling statement due to lock timeout`** dejando el indice INVALIDO
 * (indisvalid = false), que el planificador ignora: lento y en silencio, el peor estado posible.
 *
 * La causa no es que la tabla estuviera ocupada. CONCURRENTLY no espera a quien toca ESTA tabla:
 * espera a que terminen **todas las transacciones concurrentes de la base**, dos veces. En prod
 * siempre hay alguna corriendo -- cuando esto fallo habia una consulta viva sobre kepler_ods.kdm2,
 * otra tabla, que igual lo bloqueaba. O sea: en esta base CONCURRENTLY no se completa salvo por
 * casualidad.
 *
 * ⭐ Y para esta tabla no hace falta: son **3,613 filas / 704 kB**. Un CREATE INDEX comun toma
 * ACCESS EXCLUSIVE sobre kdfe33pagm1 durante milisegundos -- lo unico que escribe ahi es el UPSERT
 * del CDC cada 15 s, y el applier tiene `lock_timeout` de 15 s, asi que si no consigue el lock
 * falla ELLA en vez de hacer cola delante del trafico de prod.
 *
 * *La herramienta que no bloquea no es gratis: paga con no terminar nunca.*
 *
 * @param { import("knex").Knex } knex
 */

exports.up = async function up(knex) {
  // Limpieza del intento anterior: con IF NOT EXISTS un indice INVALIDO cuenta como existente,
  // asi que el CREATE se saltaria y la migracion se daria por buena dejando el indice muerto.
  const { rows: [malo] } = await knex.raw(`
    SELECT 1 FROM pg_class c JOIN pg_index i ON i.indexrelid = c.oid
     WHERE c.relname = 'ix_kdfe33pagm1_cobro' AND NOT i.indisvalid`);
  if (malo) {
    console.log('  · habia un ix_kdfe33pagm1_cobro INVALIDO de un intento con CONCURRENTLY: se dropea');
    await knex.raw('DROP INDEX IF EXISTS kepler_ods.ix_kdfe33pagm1_cobro');
  }

  await knex.raw(`
    CREATE INDEX IF NOT EXISTS ix_kdfe33pagm1_cobro
      ON kepler_ods.kdfe33pagm1 (btrim(c1), btrim(c3))`);

  // Se comprueba, no se supone: un indice invalido se ve igual de presente que uno sano.
  const { rows: [i] } = await knex.raw(`
    SELECT i.indisvalid, i.indisready, pg_size_pretty(pg_relation_size(c.oid)) AS tam
      FROM pg_class c JOIN pg_index i ON i.indexrelid = c.oid
     WHERE c.relname = 'ix_kdfe33pagm1_cobro'`);
  if (!i) throw new Error('ix_kdfe33pagm1_cobro no quedo creado.');
  if (!i.indisvalid || !i.indisready) {
    throw new Error(
      'ix_kdfe33pagm1_cobro quedo INVALIDO. El planificador no lo va a usar y la pestana Cuadra ' +
      'sigue en 93 s. Hay que hacerle DROP y volver a correr esta migracion.');
  }
  console.log(`  ✓ ix_kdfe33pagm1_cobro valido · ${i.tam}`);
};

/** Reversible y barato: el indice es aditivo, no cambia ningun resultado. */
exports.down = async function down(knex) {
  await knex.raw('DROP INDEX IF EXISTS kepler_ods.ix_kdfe33pagm1_cobro');
};
