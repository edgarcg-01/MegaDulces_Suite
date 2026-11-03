/* eslint-disable no-console */
/**
 * `[PGP.45]` CANDADO — **la condición PACTADA gana sobre la observada, y «no da descuento» deja
 * de pintarse igual que «no preguntamos».**
 *
 * ⛔ **Esta suite ejerce el `up()` de la migración, no su SQL copiado.** Es a propósito: el
 * defecto vive en el `up()` que envuelve al SQL —un `hasColumn` que no cubre, un CHECK que se
 * agrega antes de la columna, un control que compara contra la vista de otra migración— y un
 * `SELECT` retipeado a mano mide una consulta que nadie va a correr en producción.
 *
 * ── Lo que vigila ────────────────────────────────────────────────────────────────────────────
 *
 *  **(A) Los tres CHECK, cada uno con su prueba negativa.** Un gate sin prueba negativa es una
 *      intención: acá cada constraint se rompe a propósito una vez y se verifica el rojo.
 *      · `source='pactado'` sin `agreed_on` → rechazado (un acuerdo sin fecha no se contrasta).
 *      · `source='pactado'` con tasa > 0 y sin `discount_days` → rechazado. Es el defecto exacto
 *        que `[PP.0]` midió en las 147 filas viejas: tasa sin ventana no sirve para decidir hoy.
 *      · `source` fuera del enum → rechazado (que el CHECK se haya ensanchado, no borrado).
 *
 *  **(B) ⭐ La resolución, que es LA decisión de diseño de la ficha.** Se siembra un proveedor
 *      con historia observable (3 pagos con descuento a 20 días) y después se le pacta una
 *      condición distinta (10 días). La vista tiene que publicar **la pactada**, seguir
 *      publicando la observada al lado, y decir `cumplimos = false` — o sea: *pactamos a 10 y de
 *      hecho pagamos a 20*. Ésa es la pregunta que `[PP.0]` dejó escrita y nunca se pudo hacer.
 *
 *  **(C) ⭐⭐ Los TRES valores de `da_descuento`.** `true` / `false` (preguntamos y no da) /
 *      `null` (no sabemos). Hoy los dos últimos se pintan iguales y no son lo mismo (ADR-056):
 *      «no da» es una medición y «no preguntamos» es el hueco que cuesta dinero. Si esta
 *      distinción se colapsa, la ficha entera deja de valer y nadie se entera.
 *
 *  **(D) `security_invoker`.** La vista toca una tabla con FORCE RLS y las vistas de `analytics`
 *      son de `postgres`, que tiene BYPASSRLS. Sin la opción, la condición pactada de un tenant
 *      se vería desde otro. Es una propiedad del catálogo, así que se comprueba ahí.
 *
 *  **(E) Idempotencia.** El `up()` corre dos veces seguidas y la segunda no rompe nada.
 *
 * ⛔ **ESCRIBE**: siembra `kepler_ods.*` y `commercial.supplier_discount_policy`, y refresca una
 * matvista. Por eso arranca con `assertSafeTarget` y se niega a correr contra producción. Todo lo
 * que siembra usa el prefijo `CZZ`/`ZZ` y se borra al final, pase o falle.
 *
 *   node database/tests/test-newdb-pgp45-condicion-pactada.js
 */
'use strict';
require('dotenv').config();
const path = require('path');
const { Client } = require('pg');
const { assertSafeTarget } = require('./_lib/assert-safe-target');
const { noMedido } = require('./_lib/no-medido');

const MIG = path.join(__dirname, '..', 'migrations-newdb',
  '20261103085036_pgp45_condicion_pactada_del_proveedor.js');

const TENANT = '00000000-0000-0000-0000-00000000d01c';
/** Todo lo sembrado lleva estos códigos. El filtro de la matvista exige que el proveedor
 *  empiece con `C` (`btrim(c10) LIKE 'C%'` acota al universo de compra), así que no son
 *  decorativos: con otro prefijo la siembra no produciría ni una observación. */
const OBS = 'CZZOBS1';   // tiene historia observable
const NODA = 'CZZNODA1'; // pactado: preguntamos y NO da descuento
const MUDO = 'CZZMUDO1'; // ni pacto ni observaciones: no debe figurar en la vista

/** Un knex de juguete sobre `pg`: lo mínimo que la migración usa. No simula knex — le da a la
 *  migración REAL las dos puertas que toca, para que lo que corre acá sea su `up()` de verdad. */
function knexDe(client) {
  return {
    raw: async (sql, binds) => client.query(sql, binds),
    schema: {
      withSchema: (esquema) => ({
        hasColumn: async (tabla, col) => {
          const { rows } = await client.query(
            `SELECT 1 FROM information_schema.columns
              WHERE table_schema=$1 AND table_name=$2 AND column_name=$3`, [esquema, tabla, col]);
          return rows.length > 0;
        },
      }),
    },
  };
}

(async () => {
  console.log('\n=== [PGP.45] Candado: la condicion pactada gana, y "no da" no es "no sabemos" ===\n');
  assertSafeTarget('test-newdb-pgp45-condicion-pactada');

  const url = process.env.DATABASE_URL_NEW;
  if (!url) return noMedido('falta DATABASE_URL_NEW');
  const c = new Client({ connectionString: url });
  try { await c.connect(); } catch (e) { return noMedido('no pude conectar: ' + e.message); }

  let ok = 0, fail = 0;
  const pass = (m) => { ok++; console.log('  ✔ ' + m); };
  const bad = (m) => { fail++; console.log('  ✖ ' + m); };

  /** Corre algo que DEBE fallar. Devuelve true si falló como se esperaba. */
  const debeFallar = async (sql, binds, que) => {
    try { await c.query(sql, binds); bad(`${que}: la base lo ACEPTO, y el CHECK existe para rechazarlo`); return false; }
    catch (e) {
      if (e.code === '23514' || e.code === '23502') { pass(`${que}: rechazado (${e.code})`); return true; }
      bad(`${que}: fallo por otra razon (${e.code}) — ${String(e.message).slice(0, 90)}`);
      return false;
    }
  };

  const limpiar = async () => {
    await c.query(`DELETE FROM commercial.supplier_discount_policy WHERE proveedor_code LIKE 'CZZ%'`);
    await c.query(`DELETE FROM kepler_ods.kdm1 WHERE btrim(c10) LIKE 'CZZ%'`);
    await c.query(`DELETE FROM kepler_ods.kdxf WHERE btrim(c6) LIKE 'PZZ%'`);
    await c.query(`DELETE FROM kepler_ods.kdxe WHERE btrim(c2) LIKE 'CZZ%'`);
  };

  try {
    // ── prerrequisitos: sin esto no hay nada que medir, y se DECLARA ────────────────────────
    const { rows: pre } = await c.query(`
      SELECT to_regclass('commercial.supplier_discount_policy')      IS NOT NULL AS tabla,
             to_regclass('analytics.mv_supplier_prompt_discount')    IS NOT NULL AS matvista,
             to_regclass('kepler_ods.kdm1')                          IS NOT NULL AS ods`);
    if (!pre[0].tabla || !pre[0].matvista || !pre[0].ods) {
      return noMedido(`falta estructura en esta base: tabla=${pre[0].tabla} matvista=${pre[0].matvista} ods=${pre[0].ods}`);
    }

    await limpiar();

    // ⛔ La matvista se refresca ANTES del up(). No es cosmético: una matvista creada
    // `WITH NO DATA` no se puede consultar (Postgres rechaza el SELECT con 55000), y entonces el
    // up() se saltaría sus propios controles declarando NO MEDIDO — pasaría en verde sin haber
    // comprobado nada, que es justo el patrón "skip-graceful" que [VP.5.1] vino a cerrar.
    await c.query(`REFRESH MATERIALIZED VIEW analytics.mv_supplier_prompt_discount`);

    // ── (E) el up() REAL, dos veces: idempotencia ───────────────────────────────────────────
    delete require.cache[require.resolve(MIG)];
    const mig = require(MIG);
    await mig.up(knexDe(c));
    pass('el up() de la migracion corre contra una base real');
    await mig.up(knexDe(c));
    pass('el up() corre DOS veces seguidas sin romperse (idempotente)');

    // ── (D) security_invoker, que es lo que hace que RLS siga filtrando ─────────────────────
    const { rows: si } = await c.query(`
      SELECT coalesce((SELECT option_value FROM pg_options_to_table(cl.reloptions)
                        WHERE option_name='security_invoker'), 'no') AS v
        FROM pg_class cl JOIN pg_namespace n ON n.oid = cl.relnamespace
       WHERE n.nspname='analytics' AND cl.relname='v_supplier_payment_terms'`);
    if (si[0] && si[0].v === 'true') pass('la vista lleva security_invoker=true (RLS sigue filtrando por tenant)');
    else bad(`la vista NO lleva security_invoker (vale "${si[0] ? si[0].v : 'no existe'}"): la condicion pactada de un tenant se veria desde otro`);

    // ── (A) los tres CHECK, cada uno roto a proposito ───────────────────────────────────────
    const base = `INSERT INTO commercial.supplier_discount_policy
      (tenant_id, proveedor_code, expected_discount_rate, discount_days, source, agreed_on)`;
    await debeFallar(`${base} VALUES ($1,'CZZBAD1', 0.05, 10, 'pactado', NULL)`, [TENANT],
      'A1 pactado SIN fecha de acuerdo');
    await debeFallar(`${base} VALUES ($1,'CZZBAD2', 0.05, NULL, 'pactado', CURRENT_DATE)`, [TENANT],
      'A2 pactado CON descuento y SIN dias de ventana');
    await debeFallar(`${base} VALUES ($1,'CZZBAD3', 0.05, 10, 'inventado', CURRENT_DATE)`, [TENANT],
      'A3 source fuera del enum (el CHECK se ensancho, no se borro)');

    // El caso legitimo que los dos primeros NO deben estorbar: pactado SIN descuento.
    await c.query(`${base} VALUES ($1,$2, 0, NULL, 'pactado', CURRENT_DATE)`, [TENANT, NODA]);
    pass('A4 pactado con tasa 0 y sin dias SI se acepta: es "preguntamos y no da", una medicion');

    // ── (B) la siembra: 3 pagos con descuento a 20 dias ─────────────────────────────────────
    for (let i = 1; i <= 3; i++) {
      const fFac = `CURRENT_DATE - ${60 - i}`;
      await c.query(`INSERT INTO kepler_ods.kdxe (sucursal,c1,c2,c3,c4,c5,c6,c7)
        VALUES ('00','00',$1,'A',26,0,$2, (${fFac})::timestamp)`, [OBS, 'FZZ' + i]);
      await c.query(`INSERT INTO kepler_ods.kdm1 (sucursal,c1,c2,c3,c4,c5,c6,c9,c10,c16,c84)
        VALUES ('00','00','X','D',26,0,$1, (${fFac} + 20)::timestamp, $2, 1000, '100')`,
      ['PZZ' + i, OBS]);
      await c.query(`INSERT INTO kepler_ods.kdxf (sucursal,c1,c2,c3,c4,c5,c6,c7,c8,c9)
        VALUES ('00','00','x', (${fFac} + 20)::timestamp, 26,0,$1, 26, 0, $2)`,
      ['PZZ' + i, 'FZZ' + i]);
    }
    await c.query(`REFRESH MATERIALIZED VIEW analytics.mv_supplier_prompt_discount`);
    const { rows: mv } = await c.query(
      `SELECT n_observaciones, dias_mediana FROM analytics.mv_supplier_prompt_discount
        WHERE proveedor_code = $1`, [OBS]);
    if (mv.length && Number(mv[0].n_observaciones) === 3 && Number(mv[0].dias_mediana) === 20) {
      pass('B0 la siembra produce la observacion esperada: n=3, mediana 20 dias');
    } else {
      bad(`B0 la siembra NO produjo la observacion (${mv.length ? `n=${mv[0].n_observaciones} dias=${mv[0].dias_mediana}` : 'sin fila'}): el resto de (B) no mide lo que cree`);
    }

    const ver = async (code) => {
      const { rows } = await c.query(
        `SELECT * FROM analytics.v_supplier_payment_terms WHERE proveedor_code = $1`, [code]);
      return rows[0] || null;
    };

    // Sin pacto todavia: tiene que regir lo OBSERVADO.
    let v = await ver(OBS);
    if (v && v.origen === 'observado' && Number(v.dias) === 20 && v.da_descuento === true) {
      pass('B1 sin pacto, rige lo observado (origen=observado, 20 dias, da_descuento=true)');
    } else {
      bad(`B1 sin pacto deberia regir lo observado y dio ${v ? `origen=${v.origen} dias=${v.dias} da=${v.da_descuento}` : 'nada'}`);
    }

    // ⭐ Ahora se pacta OTRA condicion. Lo pactado tiene que ganar.
    await c.query(`${base} VALUES ($1,$2, 0.05, 10, 'pactado', CURRENT_DATE)`, [TENANT, OBS]);
    v = await ver(OBS);
    if (v && v.origen === 'pactado' && Number(v.dias) === 10 && Number(v.tasa) === 0.05) {
      pass('B2 ⭐ con pacto, lo PACTADO gana sobre lo observado (10 dias al 5 %, no 20 al 9 %)');
    } else {
      bad(`B2 lo pactado NO gano: ${v ? `origen=${v.origen} dias=${v.dias} tasa=${v.tasa}` : 'la fila desaparecio'}`);
    }
    if (v && Number(v.dias_observados) === 20 && Number(v.n_observaciones) === 3) {
      pass('B3 lo observado sigue viajando al lado del pacto (20 dias, n=3): el contraste es posible');
    } else {
      bad(`B3 lo observado se perdio al pactar: dias_observados=${v && v.dias_observados} n=${v && v.n_observaciones}`);
    }
    if (v && v.cumplimos === false) {
      pass('B4 ⭐ cumplimos=false: pactamos a 10 dias y de hecho pagamos a 20 — la pregunta que [PP.0] dejo pedida');
    } else {
      bad(`B4 cumplimos deberia ser false (20 > 10) y vale ${v && v.cumplimos}`);
    }

    // ── (C) los TRES valores de da_descuento ────────────────────────────────────────────────
    const vNoda = await ver(NODA);
    if (vNoda && vNoda.da_descuento === false && vNoda.tasa === null && vNoda.dias === null
        && vNoda.origen === 'pactado') {
      pass('C1 ⭐⭐ "preguntamos y NO da": da_descuento=false con tasa y dias en NULL');
    } else {
      bad(`C1 el "no da" no se publica como medicion: ${vNoda ? `da=${vNoda.da_descuento} tasa=${vNoda.tasa} dias=${vNoda.dias} origen=${vNoda.origen}` : 'no figura en la vista'}`);
    }
    const vMudo = await ver(MUDO);
    if (vMudo === null) {
      pass('C2 un proveedor sin pacto NI observaciones NO figura en la vista (el consumidor lo lee por LEFT JOIN como "no sabemos")');
    } else {
      bad(`C2 un proveedor del que no sabemos nada aparece en la vista con origen=${vMudo.origen}: eso afirma algo que nadie midio`);
    }
    // Y el control que separa C1 de C2: los dos tienen que dar DISTINTO.
    if (vNoda && vMudo === null && vNoda.da_descuento === false) {
      pass('C3 ⭐⭐ "no da" y "no sabemos" se distinguen: false contra ausencia, no los dos en blanco');
    } else {
      bad('C3 "no da" y "no sabemos" se pintan iguales: la ficha entera deja de valer');
    }

    // ── (F) el control de la PROPIA migracion, ejercido con datos ───────────────────────────
    //
    // ⛔ En (E) el up() corrio sobre una base vacia: su control comparo 0 contra 0 y paso sin
    // comprobar nada. Un control que solo se ejerce en el caso trivial no es un control. Aca
    // vuelve a correr con un pacto que TAPA a un observado (CZZOBS1 tiene las dos cosas), que es
    // justo donde su aritmetica puede equivocarse: si restara mal los tapados, revienta.
    try {
      await mig.up(knexDe(c));
      pass('F1 el control de la migracion aguanta con datos reales (1 pacto tapando 1 observado)');
    } catch (e) {
      bad('F1 el control de la migracion se rompe con datos: ' + String(e.message).slice(0, 140));
    }
    // ⛔ El control de la migración NO se puede falsificar desde afuera, y conviene decirlo en
    // vez de simular una prueba negativa: el `up()` **recrea la vista** antes de leerla, así que
    // cualquier sabotaje a la vista lo borra ella misma, y los dos lados que compara son suyos.
    // Lo que sí es falsificable es un ESPEJO calculado acá, sin tocar su código: si la vista se
    // desvía de las dos fuentes, esto se pone rojo aunque el control de la migración no. Es el
    // mismo patrón de cruzar dos implementaciones que cazó los CHECK de arriba.
    const { rows: esp } = await c.query(`
      SELECT (SELECT count(*) FROM analytics.v_supplier_payment_terms WHERE origen='pactado')::int   AS vista_pactados,
             (SELECT count(*) FROM commercial.supplier_discount_policy
               WHERE source='pactado' AND active)::int                                               AS tabla_pactados,
             (SELECT count(*) FROM analytics.v_supplier_payment_terms WHERE origen='observado')::int AS vista_observados,
             (SELECT count(*) FROM analytics.mv_supplier_prompt_discount d
               WHERE d.n_observaciones >= 3
                 AND NOT EXISTS (SELECT 1 FROM commercial.supplier_discount_policy p
                                  WHERE p.proveedor_code = d.proveedor_code
                                    AND p.source='pactado' AND p.active))::int                       AS matvista_libres`);
    const e = esp[0];
    if (e.vista_pactados === e.tabla_pactados && e.vista_observados === e.matvista_libres
        && e.tabla_pactados > 0) {
      pass(`F2 espejo independiente: ${e.vista_pactados} pactados y ${e.vista_observados} observados, calculados sin usar el codigo de la vista`);
    } else {
      bad(`F2 la vista se desvia de sus fuentes: pactados ${e.vista_pactados} vs ${e.tabla_pactados}, observados ${e.vista_observados} vs ${e.matvista_libres}`);
    }
  } catch (e) {
    bad('excepcion: ' + e.message);
  } finally {
    try {
      await limpiar();
      await c.query(`REFRESH MATERIALIZED VIEW analytics.mv_supplier_prompt_discount`);
    } catch (e) { console.log('  ⚠️ no pude limpiar del todo: ' + e.message); }
    await c.end();
  }

  console.log(`\n── ${ok} verdes · ${fail} rojas ──\n`);
  process.exit(fail ? 1 : 0);
})();
