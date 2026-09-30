/**
 * `[BP]` — **El renglón que se quitó del ticket: lo que la tabla tiene que impedir.**
 *
 * `commercial.pos_line_voids` guarda lo que Kepler autentica y después no escribe. Medido el
 * 2026-09-28 contra las 9 ramas y en vivo en una caja: el POS EXIGE contraseña de supervisor
 * para quitar un renglón (`POS.k_passRow=1`) y luego la marca "ELIMINADO" vive sólo en la
 * memoria de la caja — el guardado rechaza cualquier renglón en cantidad 0, así que nunca toca
 * la base. Cero coincidencias de "ELIMINADO" en las 46 columnas de texto de `kdm2`.
 *
 * Por eso es tabla propia (dato HITL), y por eso lo que se afirma acá NO es "se puede insertar
 * una fila" —eso es lo fácil— sino **las cinco maneras de mentir que las compuertas bloquean**:
 *
 *  1. **Dibujar un cero donde no hubo medición.** Un retiro que no se pudo valorar no vale $0:
 *     vale "no sé". El CHECK de coherencia impide que `est_value` y `est_source` se contradigan
 *     en CUALQUIERA de las dos direcciones (ADR-056).
 *  2. **Registrar un retiro donde no se retiró nada.** Si la cantidad no bajó, no hubo hecho que
 *     registrar — y una fila así inflaría el conteo del supervisor sin haber pasado nada.
 *  3. **Elegir "otro" sin decir cuál.** Es el atajo cómodo que deja la fila muda. Se impide en el
 *     motor, no en el formulario: un formulario se puede saltar.
 *  4. **Registrar algo antes de que pasara.** `occurred_at` y `reported_at` son dos cosas
 *     distintas a propósito —la distancia mide cuán fresca es la captura— y el orden entre ellas
 *     no puede invertirse.
 *  5. **Un retiro sin firma.** `supervisor_code` es NOT NULL porque la autorización ES el hecho:
 *     sin quién la dio, el log no prueba nada.
 *
 * Más el aislamiento por tenant, que se prueba con un rol SIN superusuario y con el tenant ajeno
 * EXISTIENDO — si no existe, lo rechaza la llave foránea y la prueba pasa por el motivo
 * equivocado (pasó en el laboratorio de esta misma fase: daba 23503 en vez de 42501).
 *
 * Todas las compuertas se prueban **rompiéndolas a propósito**: un candado sin prueba negativa
 * es una intención, no un candado.
 *
 * Uso: DATABASE_URL_NEW=... node database/tests/test-newdb-pos-line-voids.js
 */
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env'), quiet: true });
const knex = require('knex')(require('../knexfile-newdb.js').development);
const T = process.env.TENANT_ID || '00000000-0000-0000-0000-00000000d01c';
let fail = 0;
const ok = (c, m) => { console.log(`${c ? '  ✅' : '  ❌'} ${m}`); if (!c) fail++; };

/** Marca propia para poder limpiar sin tocar lo que registró gente de verdad. */
const MARCA = `SMOKE-BP-${Date.now()}`;

/** Inserta rompiendo lo que se le pida; devuelve el error de Postgres o null si pasó. */
async function intentar(fila) {
  try { await knex('commercial.pos_line_voids').insert(fila); return null; }
  catch (e) { return e.message || String(e); }
}

(async () => {
  try {
    const existe = (await knex.raw(`SELECT to_regclass('commercial.pos_line_voids') AS t`)).rows[0]?.t;
    if (!existe) {
      console.log('  ⚠️  sin la tabla de retiros (¿migración 20260928190000 pendiente?) — NO MEDIDO');
      process.exit(2);
    }

    // Una sucursal cualquiera con la que armar filas válidas. Si no hay, no se inventa: se declara.
    const wh = await knex('commercial.warehouses')
      .select('id', 'code').where({ tenant_id: T }).whereNull('deleted_at').first();
    if (!wh) {
      console.log('  ⚠️  el tenant no tiene ninguna sucursal — NO MEDIDO');
      process.exit(2);
    }

    const base = {
      tenant_id: T,
      warehouse_id: wh.id,
      supervisor_code: MARCA,
      qty_original: 3,
      qty_final: 0,
      reason: 'error_captura',
      occurred_at: knex.fn.now(),
    };

    console.log('\n[1] La fila honesta entra');
    ok(await intentar({ ...base }) === null, 'retiro completo, sin valorar (est_source por default = sin_dato)');
    ok(await intentar({ ...base, qty_original: 5, qty_final: 2, reason: 'cantidad_incorrecta' }) === null,
      'reducción parcial: 5 -> 2 (la forma que estrenó Kepler el 2026-09-28)');
    ok(await intentar({ ...base, unit_price: 86, est_value: 258, est_source: 'precio_erp' }) === null,
      'retiro valorado: est_value con est_source=precio_erp');

    console.log('\n[2] Dibujar un cero donde no hubo medición — las DOS direcciones');
    ok(await intentar({ ...base, est_source: 'precio_erp' }) !== null,
      'RECHAZA precio_erp sin est_value (diría "medido" sobre algo que no se midió)');
    ok(await intentar({ ...base, est_value: 99, est_source: 'sin_dato' }) !== null,
      'RECHAZA sin_dato CON est_value (el monto quedaría sin fuente que lo respalde)');

    console.log('\n[3] Registrar un retiro donde no se retiró nada');
    ok(await intentar({ ...base, qty_original: 2, qty_final: 2 }) !== null,
      'RECHAZA qty_final = qty_original (no bajó: no hubo hecho)');
    ok(await intentar({ ...base, qty_original: 2, qty_final: 5 }) !== null,
      'RECHAZA qty_final > qty_original (eso es agregar, no retirar)');
    ok(await intentar({ ...base, qty_original: 0 }) !== null,
      'RECHAZA cantidad original 0');

    console.log('\n[4] "Otro" sin decir cuál');
    ok(await intentar({ ...base, reason: 'otro' }) !== null,
      'RECHAZA motivo otro sin nota');
    ok(await intentar({ ...base, reason: 'otro', reason_note: '   ' }) !== null,
      'RECHAZA motivo otro con nota en blanco (un espacio no es una explicación)');
    ok(await intentar({ ...base, reason: 'otro', reason_note: 'se fue la luz a media venta' }) === null,
      'ACEPTA motivo otro CON nota');
    ok(await intentar({ ...base, reason: 'porque_si' }) !== null,
      'RECHAZA un motivo que no está en el catálogo cerrado');

    console.log('\n[5] Registrar algo antes de que pasara');
    ok(await intentar({
      ...base,
      occurred_at: knex.raw(`now() + interval '1 hour'`),
      reported_at: knex.fn.now(),
    }) !== null, 'RECHAZA occurred_at posterior a reported_at');

    console.log('\n[6] Un retiro sin firma');
    const sinFirma = { ...base }; delete sinFirma.supervisor_code;
    ok(await intentar(sinFirma) !== null,
      'RECHAZA sin supervisor_code (la autorización ES el hecho: sin quién la dio no prueba nada)');

    console.log('\n[7] Aislamiento por tenant');
    const rls = (await knex.raw(`
      SELECT relrowsecurity AS on, relforcerowsecurity AS forced
        FROM pg_class WHERE oid = 'commercial.pos_line_voids'::regclass`)).rows[0];
    ok(rls?.on === true, 'RLS habilitado');
    ok(rls?.forced === true, 'RLS FORZADO (aplica también al dueño de la tabla)');
    const pol = (await knex.raw(`
      SELECT count(*)::int AS n FROM pg_policies
       WHERE schemaname='commercial' AND tablename='pos_line_voids' AND policyname='tenant_isolation'`)).rows[0];
    ok(pol?.n === 1, 'existe la política tenant_isolation');
    // ⚠️ El aislamiento EFECTIVO no se puede afirmar desde acá: esta conexión suele ser
    // superusuario y los superusuarios saltan RLS aunque esté forzado. Se DECLARA en vez de
    // dar un verde que no midió nada — se comprueba con un rol sin privilegios (ver la fase).
    const su = (await knex.raw(`SELECT rolsuper FROM pg_roles WHERE rolname = current_user`)).rows[0];
    if (su?.rolsuper) {
      console.log('  ⚠️  conexión con superusuario: el corte efectivo del RLS NO MEDIDO acá (los superusuarios lo saltan)');
    } else {
      const ajenas = (await knex.raw(`
        SELECT count(*)::int AS n FROM commercial.pos_line_voids WHERE tenant_id <> ?`, [T])).rows[0];
      ok(ajenas?.n === 0, 'no se ven filas de otro tenant');
    }

    console.log('\n[8] Los índices que sostienen las tres pantallas');
    const idx = (await knex.raw(`
      SELECT indexname FROM pg_indexes
       WHERE schemaname='commercial' AND tablename='pos_line_voids'`)).rows.map((r) => r.indexname);
    ok(idx.includes('ix_pos_line_voids_bitacora'), 'índice de la bitácora por fecha');
    ok(idx.includes('ix_pos_line_voids_supervisor'), 'índice por supervisor (el ángulo de auditoría)');

  } catch (e) {
    console.error('  ❌ error inesperado:', e.message);
    fail++;
  } finally {
    // Limpia SOLO lo propio: la marca va en supervisor_code, que es NOT NULL y nunca colisiona
    // con una clave real (lleva timestamp).
    try { await knex('commercial.pos_line_voids').where('supervisor_code', MARCA).del(); } catch { /* la tabla puede no existir */ }
    await knex.destroy();
  }
  console.log(fail === 0 ? '\n  TODO VERDE' : `\n  ${fail} FALLA(S)`);
  process.exit(fail === 0 ? 0 : 1);
})();
