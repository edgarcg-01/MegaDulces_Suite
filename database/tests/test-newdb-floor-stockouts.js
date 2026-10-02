/**
 * `[FLT]` — **La venta que NO ocurrió: lo que la tabla tiene que impedir.**
 *
 * `commercial.floor_stockouts` guarda lo que el mostrador reporta que un cliente pidió y no había.
 * Es la ÚNICA señal de demanda de la suite que no sale de ningún feed: una venta que no pasó no
 * deja ticket, ni movimiento, ni renglón en `kepler_ods`. Por eso hay tabla propia (dato HITL) y
 * por eso lo que se afirma acá no es "se puede insertar una fila" —eso es lo fácil— sino **las
 * cuatro maneras de mentir que las compuertas tienen que bloquear**:
 *
 *  1. **Dibujar un cero donde no hubo medición.** Un faltante sin precio con qué valorarlo NO vale
 *     $0: vale "no sé". El CHECK de coherencia impide que `est_lost_revenue` y `est_source` se
 *     contradigan en cualquiera de las dos direcciones (ADR-056).
 *  2. **Decir "no lo trabajamos" de algo que sí está en el catálogo.** Ese motivo afirma
 *     exactamente que el producto NO es nuestro; con `product_id` lleno, la bandeja de Compras
 *     mostraría como "alta de producto nuevo" algo que ya se vende.
 *  3. **Cerrar una fila sin decir qué se decidió** (o dejar una decisión colgando de una fila
 *     abierta). El estado y la decisión son la misma afirmación vista dos veces.
 *  4. **Contar de más.** El grano es (sucursal, motivo, cosa, SEMANA) con contador: si el mismo
 *     producto lo piden nueve veces, la señal es el NUEVE, no nueve renglones. El UPSERT por
 *     `dedup_key` es lo que lo sostiene, y el texto escrito a mano se normaliza (sin acentos,
 *     mayúsculas, espacios colapsados) o "Chicle Rosa " y "chicle rosa" serían dos demandas.
 *
 * Todas las compuertas se prueban **rompiéndolas a propósito**: un candado sin prueba negativa es
 * una intención, no un candado.
 *
 * Uso: DATABASE_URL_NEW=... node database/tests/test-newdb-floor-stockouts.js
 */
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env'), quiet: true });
// `[FLT.26]` La guarda faltaba, y este test INSERTA. Medido el 2026-10-02: el `DATABASE_URL_NEW`
// del `.env` de esta máquina apunta a `192.168.0.222:5434` —`pg-prod`, producción— así que
// correrlo tal cual dejaba filas de prueba en el padrón real de faltantes. Es exactamente el
// accidente del 2026-08-29 que hizo nacer esta guarda, en un test que nunca la llamó.
require('./_lib/assert-safe-target').assertSafeTarget('test-newdb-floor-stockouts');
const knex = require('knex')(require('../knexfile-newdb.js').development);
const T = process.env.TENANT_ID || '00000000-0000-0000-0000-00000000d01c';
let fail = 0;
const ok = (c, m) => { console.log(`${c ? '  ✅' : '  ❌'} ${m}`); if (!c) fail++; };

/** Marca propia para poder limpiar sin tocar lo que reportó gente de verdad. */
const MARCA = `SMOKE-FLT-${Date.now()}`;

/** La misma normalización del service: sin acentos, mayúsculas, espacios colapsados. */
const normalizar = (s) => (s || '')
  .normalize('NFD').replace(/[̀-ͯ]/g, '')
  .toUpperCase().replace(/\s+/g, ' ').trim();

/** Inserta rompiendo lo que se le pida; devuelve el error de Postgres o null si pasó. */
async function intentar(fila) {
  try { await knex('commercial.floor_stockouts').insert(fila); return null; }
  catch (e) { return e.message || String(e); }
}

(async () => {
  try {
    const existe = (await knex.raw(`SELECT to_regclass('commercial.floor_stockouts') AS t`)).rows[0]?.t;
    if (!existe) {
      console.log('  ⚠️  sin la tabla de faltantes (¿migración 20260919150000 pendiente?) — NO MEDIDO');
      process.exit(2);
    }

    const wh = (await knex('commercial.warehouses')
      .select('id').where({ tenant_id: T }).whereNull('deleted_at').whereRaw("code = '03'").first());
    const prod = (await knex('catalog.products')
      .select('id', 'sku').where({ tenant_id: T }).whereNull('deleted_at').first());
    if (!wh || !prod) {
      console.log('  ⚠️  falta sucursal 03 o catálogo con qué probar — NO MEDIDO');
      process.exit(2);
    }

    const base = (extra = {}) => Object.assign({
      tenant_id: T, warehouse_id: wh.id, product_id: null,
      sku: null, scanned_code: null, product_name: MARCA,
      kind: 'agotado', week_start: '2026-09-14', times_reported: 1,
      source: 'verificador', est_source: 'sin_dato', est_lost_revenue: null,
      status: 'open', decision: null,
      dedup_key: `${MARCA}-${Math.random().toString(36).slice(2)}`,
    }, extra);

    // ── 1. El cero dibujado, en las dos direcciones ────────────────────────────────────────
    ok(/est_coherencia/.test(await intentar(base({ est_source: 'sin_dato', est_lost_revenue: 500 })) || ''),
      'RECHAZA un monto sin fuente: un valor sin con qué medirlo no se publica');
    ok(/est_coherencia/.test(await intentar(base({ est_source: 'precio_erp', est_lost_revenue: null })) || ''),
      'RECHAZA declarar fuente sin monto: la etiqueta no puede ir sola');
    ok((await intentar(base({ est_source: 'sin_dato', est_lost_revenue: null }))) === null,
      'ACEPTA "no se pudo valorar" como NULL declarado — nunca como $0');

    // ── 2. "No lo trabajamos" de algo que sí trabajamos ────────────────────────────────────
    ok(/sin_catalogo/.test(await intentar(base({ kind: 'no_en_catalogo', product_id: prod.id })) || ''),
      'RECHAZA `no_en_catalogo` CON producto: ese motivo afirma que el producto no es nuestro');
    ok((await intentar(base({ kind: 'no_en_catalogo', product_id: null }))) === null,
      'ACEPTA `no_en_catalogo` sin producto — el caso que ninguna fuente puede ver');

    // ── 3. Estado y decisión no pueden contradecirse ───────────────────────────────────────
    ok(/decision_coherencia/.test(await intentar(base({ status: 'resolved', decision: null })) || ''),
      'RECHAZA cerrar sin decir qué se decidió');
    ok(/decision_coherencia/.test(await intentar(base({ status: 'open', decision: 'alta_catalogo' })) || ''),
      'RECHAZA una decisión colgando de una fila todavía abierta');

    // ── 4. Motivo y contador ───────────────────────────────────────────────────────────────
    ok(/kind_chk/.test(await intentar(base({ kind: 'se_perdio' })) || ''),
      'RECHAZA un motivo inventado (los cinco son un vocabulario cerrado)');
    // `[FLT.21]` El motivo nuevo tiene que ENTRAR. Sin esta linea, el dia que alguien corra la
    // migracion a medias el INSERT revienta en produccion con un 23514 y nadie lo ata a este
    // archivo. Es la prueba POSITIVA del CHECK; la negativa de arriba no la cubre.
    ok((await intentar(base({ kind: 'no_en_anaquel' }))) === null,
      'ACEPTA no_en_anaquel: el CHECK de la migracion 20260926120000 esta aplicado');
    ok(/times_chk/.test(await intentar(base({ times_reported: 0 })) || ''),
      'RECHAZA un contador en 0: un reporte de cero veces no es un reporte');

    // ── 5. El grano semanal: el mismo reporte NO crea dos renglones ────────────────────────
    // ⚠️ La llave lleva la marca de ESTA corrida. Con el texto "real" que usa el service, el smoke
    // chocaba con reportes de verdad (o con los de una corrida anterior) y contaba desde donde
    // hubieran quedado: 3 → 4 → 5 en vez de 1 → 2 → 3. Una prueba que depende del ambiente no
    // prueba nada — ya pasó en la Fase D con el seed de demo.
    const dk = `03|no_en_catalogo|txt:${normalizar(`${MARCA} Chicle   Rosa  del Norte `)}|2026-09-14`;
    const upsert = async () => knex.raw(
      `INSERT INTO commercial.floor_stockouts
         (tenant_id, warehouse_id, product_name, kind, week_start, times_reported, source,
          est_source, dedup_key)
       VALUES (?, ?, ?, 'no_en_catalogo', '2026-09-14', 1, 'verificador', 'sin_dato', ?)
       ON CONFLICT (tenant_id, dedup_key) DO UPDATE
         SET times_reported = commercial.floor_stockouts.times_reported + 1
       RETURNING times_reported`, [T, wh.id, MARCA, dk]);
    const v1 = (await upsert()).rows[0].times_reported;
    const v2 = (await upsert()).rows[0].times_reported;
    const v3 = (await upsert()).rows[0].times_reported;
    ok(Number(v1) === 1 && Number(v2) === 2 && Number(v3) === 3,
      `el mismo reporte SUMA en vez de duplicar (${v1} → ${v2} → ${v3})`);
    const filas = Number((await knex('commercial.floor_stockouts')
      .where({ tenant_id: T, dedup_key: dk }).count('* as n').first()).n);
    ok(filas === 1, `los tres reportes viven en UNA fila, no en tres (${filas})`);

    // El texto escrito distinto tiene que caer en la MISMA demanda.
    ok(normalizar('  Chicle   Rosa  del Norte ') === normalizar('CHICLE ROSA DEL NORTE'),
      'el texto escrito a mano se normaliza: "Chicle Rosa " y "CHICLE ROSA" son la misma demanda');

    // ── 6. Aislamiento entre empresas ──────────────────────────────────────────────────────
    const rls = (await knex.raw(
      `SELECT relrowsecurity r, relforcerowsecurity f
         FROM pg_class WHERE oid = 'commercial.floor_stockouts'::regclass`)).rows[0];
    ok(rls.r && rls.f, 'RLS activo y FORZADO (el dueño de la tabla tampoco lo puede saltar)');

    // ── 7. Lo que la bandeja promete: lo no valorado NO encabeza la cola ───────────────────
    const orden = (await knex.raw(`
      SELECT est_lost_revenue FROM commercial.floor_stockouts
       WHERE tenant_id = ? AND product_name = ?
       ORDER BY est_lost_revenue DESC NULLS LAST LIMIT 5`, [T, MARCA])).rows;
    const nulosAlFinal = orden.every((r, i) =>
      r.est_lost_revenue !== null || orden.slice(i).every((x) => x.est_lost_revenue === null));
    ok(nulosAlFinal, 'en la bandeja lo no valorado va AL FINAL: no se premia la falta de dato');


    // ── 8. `[FLT.21]` El destino se DERIVA y no se guarda ─────────────────────────────────
    // La columna no existe a proposito: guardarla seria una segunda copia de algo calculable, y
    // el dia que cambie la regla quedarian filas viejas afirmando un destino que la regla nueva
    // no les daria. Aca se fija que NADIE la agrego por comodidad.
    const cols = (await knex.raw(`
      SELECT column_name FROM information_schema.columns
       WHERE table_schema='commercial' AND table_name='floor_stockouts'`)).rows.map((r) => r.column_name);
    ok(!cols.includes('destino'),
      'la tabla NO guarda el destino: se deriva al leer (regla en stockout-destino.ts)');

    // El caso que el motivo nuevo existe para capturar: hay existencia y no estaba en el anaquel.
    // Guarda la existencia que la persona vio, que es lo que despues decide a quien le toca.
    await knex('commercial.floor_stockouts').insert(base({
      kind: 'no_en_anaquel', dedup_key: `${MARCA}|anaquel`, on_hand_at_report: 12,
    }));
    const anaquel = await knex('commercial.floor_stockouts')
      .where({ tenant_id: T, dedup_key: `${MARCA}|anaquel` }).first();
    ok(anaquel && Number(anaquel.on_hand_at_report) === 12,
      'no_en_anaquel guarda la existencia del momento: es lo que lo manda a piso y no a Compras');


    // ── 9. `[FLT.26]` Deshacer lo que el verificador anotó SOLO ───────────────────────────
    // El buscador escribe el faltante sin preguntar cuando la existencia es 0. Eso abre un caso
    // nuevo: un reporte que nadie decidió. La salida tiene que ser del lado de la TIENDA, y las
    // dos formas de que se pudra en silencio son el contador y la ventana de tiempo.
    //
    // ⚠️ El SQL se copia VERBATIM del servicio a propósito. Reimplementarlo acá probaría que mi
    // reimplementación funciona, no que la del servicio funciona — que es el error que el candado
    // de IC.0 cobró caro.
    const DESHACER_SQL = `
      UPDATE commercial.floor_stockouts
         SET times_reported   = times_reported - 1,
             est_lost_revenue = CASE WHEN unit_price IS NOT NULL
                                     THEN ROUND(unit_price * (times_reported - 1), 2)
                                     ELSE NULL END,
             updated_at       = now()
       WHERE id = ?
      RETURNING times_reported, est_lost_revenue`;

    // 9a. Tres reportes en la semana: deshacer uno resta UNO y **revalúa**. Si la valoración se
    //     dejara quieta, restar un reporte no bajaría el dinero y la bandeja de Compras seguiría
    //     priorizando por una cifra que ya no corresponde.
    const [tres] = await knex('commercial.floor_stockouts')
      .insert(base({
        kind: 'agotado', dedup_key: `${MARCA}|deshacer3`, times_reported: 3,
        unit_price: 10, est_lost_revenue: 30, est_source: 'precio_erp',
      }))
      .returning('id');
    const idTres = tres.id ?? tres;
    const r9a = (await knex.raw(DESHACER_SQL, [idTres])).rows[0];
    ok(Number(r9a.times_reported) === 2, 'deshacer resta UN reporte de la semana, no borra la fila');
    ok(Number(r9a.est_lost_revenue) === 20,
      'y REVALÚA sobre el contador nuevo: 3×$10 → 2×$10 = $20');

    // 9b. Sin precio no hay nada que revaluar, y el CHECK de coherencia tiene que seguir contento.
    //     Es el camino donde un `ROUND(NULL*…)` descuidado metería un 0 dibujado (ADR-056).
    const [sinP] = await knex('commercial.floor_stockouts')
      .insert(base({
        kind: 'agotado', dedup_key: `${MARCA}|deshacerSinPrecio`, times_reported: 2,
        unit_price: null, est_lost_revenue: null, est_source: 'sin_dato',
      }))
      .returning('id');
    const r9b = (await knex.raw(DESHACER_SQL, [sinP.id ?? sinP])).rows[0];
    ok(r9b.est_lost_revenue === null,
      'sin precio la valoración sigue en NULL tras deshacer, NUNCA en $0');

    // 9c. La ventana. Es el único freno que impide que esto sea un borrado administrativo abierto
    //     a 30 personas en nueve plazas, y se prueba con el MISMO predicado del servicio.
    const VENTANA_MIN = 5;
    const dentroDeVentana = async (id) => (await knex.raw(
      `SELECT (last_reported_at > now() - (? || ' minutes')::interval) AS v
         FROM commercial.floor_stockouts WHERE id = ?`, [VENTANA_MIN, id])).rows[0].v;

    ok(await dentroDeVentana(idTres) === true,
      'lo recién anotado cae DENTRO de la ventana: se puede deshacer');

    // La prueba negativa: un reporte viejo NO se puede deshacer desde el mostrador. Sin esto, el
    // botón «Quitar» sería una puerta para borrar faltantes de la semana pasada sin dejar rastro.
    await knex('commercial.floor_stockouts').where({ id: idTres })
      .update({ last_reported_at: knex.raw(`now() - interval '${VENTANA_MIN + 1} minutes'`) });
    ok(await dentroDeVentana(idTres) === false,
      '⛔ pasada la ventana YA NO se puede deshacer: eso lo arregla Compras con era_error');

    // 9d. El reporte que sostenía la fila solo: el servicio la borra en vez de dejar un contador
    //     en 0, que el CHECK de la tabla ni siquiera admite.
    const [uno] = await knex('commercial.floor_stockouts')
      .insert(base({
        kind: 'agotado', dedup_key: `${MARCA}|deshacer1`, times_reported: 1,
        unit_price: 7, est_lost_revenue: 7, est_source: 'precio_erp',
      }))
      .returning('id');
    const idUno = uno.id ?? uno;
    await knex('commercial.floor_stockouts').where({ id: idUno }).del();
    const quedo = await knex('commercial.floor_stockouts').where({ id: idUno }).first();
    ok(!quedo, 'el último reporte se lleva la fila entera (lo que hace el servicio en ese caso)');

    // Y el porqué, afirmado en vez de supuesto: restar a 0 NO es una alternativa — la tabla lo
    // rechaza. Si algún día alguien "optimiza" el servicio quitando la rama del borrado, esto
    // es lo que lo detiene antes de que un UPDATE reviente en producción.
    const errCero = await intentar(base({
      kind: 'agotado', dedup_key: `${MARCA}|cero`, times_reported: 0,
      unit_price: null, est_lost_revenue: null, est_source: 'sin_dato',
    }));
    ok(!!errCero, '⛔ un contador en 0 lo rechaza la tabla: por eso se BORRA en vez de restar a 0');

  } catch (e) {
    console.log(`  ❌ error inesperado: ${e.message}`);
    fail++;
  } finally {
    // Limpieza: sólo lo que este smoke creó.
    try { await knex('commercial.floor_stockouts').where({ tenant_id: T, product_name: MARCA }).del(); }
    catch { /* si falló antes de crear nada, no hay qué limpiar */ }
    await knex.destroy();
  }

  console.log(fail ? `\n❌ ${fail} aserción(es) fallaron` : '\n✅ TODO VERDE');
  process.exit(fail ? 1 : 0);
})();
