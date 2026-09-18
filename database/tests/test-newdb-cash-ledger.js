/* eslint-disable no-console */
/**
 * Fase CG — capa BD (ADR-070). Smoke DB-direct, rollback al final (cero efecto real).
 *
 * Esta suite existe para probar que los defectos MEDIDOS del Access `Control` mueren por
 * construcción, no por buena intención. Cada bloque cita el defecto que ataca:
 *
 *   §5.2  34 folios repetidos      → UNIQUE(tenant,folio) + secuencia atómica
 *   §5.3  2,387 movs sin concepto  → glosa NOT NULL + CHECK longitud, y el par contable NOT NULL
 *   §5.6  1,625 movs de "Auxiliar" → created_by uuid NOT NULL
 *   §5.4  concepto ⊕ sucursal      → sucursal y centro_costo son columnas propias
 *   §7.2  54 pares (c3,c1) con nombre distinto entre sucursales
 *                                  → la vista lleva `sucursal` en la llave y NO deduplica
 *
 * ⚠️ TODA aserción de constraint es una PRUEBA NEGATIVA: se rompe a propósito y se verifica
 * el SQLSTATE. Un gate sin prueba negativa es una intención (ADR-056).
 *
 * ⚠️ Lo que esta suite NO puede medir se DECLARA, no se pone verde: en `platform_test`
 * `analytics.expense_entries` está VACÍO, así que la capa "aprendido" del autorrelleno
 * (Nivel 2, §8.3) reporta NO MEDIDO.
 */
const knex = require('knex')(require('../knexfile-newdb.js').development);
require('./_lib/assert-safe-target').assertSafeTarget('test-newdb-cash-ledger');

const T = '00000000-0000-0000-0000-00000000d01c';
const OTRO = '00000000-0000-0000-0000-0000000000ff';

let pass = 0, fail = 0, nomedido = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m); } };
const skip = (m) => { nomedido++; console.log('  ⃝ NO MEDIDO —', m); };

/** Rompe a propósito dentro de un savepoint y devuelve el SQLSTATE. */
async function violation(trx, fn) {
  await trx.raw('SAVEPOINT sp');
  let code = null;
  try { await fn(); } catch (e) { code = e.code; }
  await trx.raw('ROLLBACK TO SAVEPOINT sp');
  return code;
}

const baseMov = (over = {}) => ({
  tenant_id: T,
  folio: `CG-TEST-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  tipo: 'gasto',
  fecha: '2026-09-18',
  sucursal: '00',
  kepler_cuenta: '601-001',
  kepler_concepto: '001',
  glosa: 'Compra de papeleria para oficina',
  monto: 1234.56,
  created_by: '00000000-0000-0000-0000-0000000000aa',
  ...over,
});

(async () => {
  try {
    console.log('\n── 1. Schema: existe, con RLS forzado y grants ──');
    for (const t of ['cash_ledger', 'cash_ledger_denominations', 'cash_ledger_sequences',
      'caja_kepler_concept_map', 'caja_classify_rules']) {
      const reg = await knex.raw(`SELECT to_regclass('finance.${t}') r`);
      ok(!!reg.rows[0].r, `finance.${t} existe`);
      const rls = await knex.raw(`SELECT relforcerowsecurity f FROM pg_class WHERE oid='finance.${t}'::regclass`);
      ok(rls.rows[0]?.f === true, `finance.${t} con RLS FORZADO`);
    }
    for (const v of ['analytics.v_kepler_conceptos', 'analytics.v_kepler_conceptos_coverage',
      'finance.v_caja_concept_map_coverage']) {
      const reg = await knex.raw(`SELECT to_regclass('${v}') r`);
      ok(!!reg.rows[0].r, `${v} existe`);
    }
    // La vista de finance lee tablas con RLS → sin security_invoker correría como su dueño.
    const si = await knex.raw(`SELECT reloptions FROM pg_class WHERE oid='finance.v_caja_concept_map_coverage'::regclass`);
    ok((si.rows[0]?.reloptions || []).some((o) => o === 'security_invoker=true'),
      'v_caja_concept_map_coverage con security_invoker=true');

    console.log('\n── 2. El concepto de Kepler: la vista respeta lo medido (§7.2) ──');
    const kdco = await knex.raw(`SELECT to_regclass('kepler_ods.kdco') r`);
    if (!kdco.rows[0].r) {
      skip('kepler_ods.kdco no existe en esta DB → la vista de conceptos no se puede medir');
    } else {
      const n = await knex.raw(`SELECT count(*)::int n FROM analytics.v_kepler_conceptos`);
      ok(n.rows[0].n > 0, `v_kepler_conceptos tiene filas (${n.rows[0].n})`);

      // La llave natural medida: (sucursal, cuenta, concepto) es única.
      const dup = await knex.raw(`
        SELECT count(*)::int d FROM (
          SELECT sucursal, cuenta, concepto FROM analytics.v_kepler_conceptos
          GROUP BY 1,2,3 HAVING count(*) > 1) t`);
      ok(dup.rows[0].d === 0, 'la llave (sucursal, cuenta, concepto) es única — 0 repetidas');

      // Lo que justifica que `sucursal` esté en la llave: hay pares que divergen entre plazas.
      const div = await knex.raw(`
        SELECT count(*)::int d FROM (
          SELECT cuenta, concepto FROM analytics.v_kepler_conceptos
          GROUP BY 1,2 HAVING count(DISTINCT concepto_nombre) > 1) t`);
      ok(div.rows[0].d > 0,
        `hay ${div.rows[0].d} pares (cuenta,concepto) con nombre distinto entre sucursales → colapsar por (cuenta,concepto) elegiría un nombre arbitrario`);

      // Nada vacío se cuela al catálogo usable.
      const vac = await knex.raw(`
        SELECT count(*)::int v FROM analytics.v_kepler_conceptos
         WHERE btrim(coalesce(cuenta,''))='' OR btrim(coalesce(concepto,''))='' OR btrim(coalesce(concepto_nombre,''))=''`);
      ok(vac.rows[0].v === 0, 'el catálogo usable no trae cuenta/concepto/nombre vacíos');

      // La cobertura CUADRA con el origen: lo descartado se declara, no desaparece.
      const cob = await knex.raw(`
        SELECT sum(filas_origen)::int origen, sum(usables)::int usables, sum(sin_subcuenta)::int sin_sub
          FROM analytics.v_kepler_conceptos_coverage`);
      const src = await knex.raw(`SELECT count(*)::int n FROM kepler_ods.kdco`);
      ok(cob.rows[0].origen === src.rows[0].n,
        `la cobertura cuadra con el origen (${cob.rows[0].origen} = ${src.rows[0].n})`);
      ok(cob.rows[0].usables === n.rows[0].n,
        `usables de la cobertura == filas de la vista (${cob.rows[0].usables})`);
      ok(cob.rows[0].sin_sub > 0,
        `las ${cob.rows[0].sin_sub} filas sin subcuenta se DECLARAN en la cobertura, no se pierden en silencio`);

      // El mayor se deriva bien de la subcuenta.
      const may = await knex.raw(`
        SELECT count(*)::int m FROM analytics.v_kepler_conceptos
         WHERE cuenta_mayor <> split_part(cuenta,'-',1)`);
      ok(may.rows[0].m === 0, 'cuenta_mayor == split_part(cuenta,"-",1) en todas las filas');
    }

    console.log('\n── 3. Los defectos del Access, muertos por construcción ──');
    await knex.transaction(async (trx) => {
      await trx.raw(`SELECT set_config('app.tenant_id', ?, true)`, [T]);

      // Un movimiento válido entra.
      const [mov] = await trx('finance.cash_ledger').insert(baseMov()).returning('*');
      ok(!!mov.id, 'un movimiento completo se inserta');
      ok(mov.estado === 'registrado', 'nace en estado registrado');

      // §5.2 — el folio no se repite. ÉSTE es el candado que Access no tenía.
      const c1 = await violation(trx, () => trx('finance.cash_ledger').insert(baseMov({ folio: mov.folio })));
      ok(c1 === '23505', `[negativa] folio duplicado → 23505 (unique_violation), got ${c1}`);

      // §5.3 — glosa vacía o de relleno NO pasa.
      const c2 = await violation(trx, () => trx('finance.cash_ledger').insert(baseMov({ glosa: 'x' })));
      ok(c2 === '23514', `[negativa] glosa de 1 carácter → 23514 (check_violation), got ${c2}`);
      const c3 = await violation(trx, () => trx('finance.cash_ledger').insert(baseMov({ glosa: '     ' })));
      ok(c3 === '23514', `[negativa] glosa de puros espacios → 23514, got ${c3}`);
      const c4 = await violation(trx, () => trx('finance.cash_ledger').insert(baseMov({ glosa: null })));
      ok(c4 === '23502', `[negativa] glosa NULL → 23502 (not_null_violation), got ${c4}`);

      // §7.5 — el par contable de Kepler es obligatorio.
      const c5 = await violation(trx, () => trx('finance.cash_ledger').insert(baseMov({ kepler_cuenta: null })));
      ok(c5 === '23502', `[negativa] sin kepler_cuenta → 23502, got ${c5}`);
      const c6 = await violation(trx, () => trx('finance.cash_ledger').insert(baseMov({ kepler_concepto: null })));
      ok(c6 === '23502', `[negativa] sin kepler_concepto → 23502, got ${c6}`);
      const c7 = await violation(trx, () => trx('finance.cash_ledger').insert(baseMov({ kepler_concepto: '  ' })));
      ok(c7 === '23514', `[negativa] kepler_concepto en blanco → 23514, got ${c7}`);

      // §5.6 — el autor es un usuario real, no un texto.
      const c8 = await violation(trx, () => trx('finance.cash_ledger').insert(baseMov({ created_by: null })));
      ok(c8 === '23502', `[negativa] sin created_by → 23502, got ${c8}`);

      // Dinero y dominios cerrados.
      const c9 = await violation(trx, () => trx('finance.cash_ledger').insert(baseMov({ monto: 0 })));
      ok(c9 === '23514', `[negativa] monto 0 → 23514, got ${c9}`);
      const c10 = await violation(trx, () => trx('finance.cash_ledger').insert(baseMov({ tipo: 'otro' })));
      ok(c10 === '23514', `[negativa] tipo fuera del dominio → 23514, got ${c10}`);
      const c11 = await violation(trx, () => trx('finance.cash_ledger').insert(baseMov({ origen_tipo: 'inventado' })));
      ok(c11 === '23514', `[negativa] origen_tipo fuera del dominio → 23514, got ${c11}`);

      // Idempotencia de la captura: el reintento del cliente no crea un segundo movimiento.
      const cu = '11111111-2222-3333-4444-555555555555';
      await trx('finance.cash_ledger').insert(baseMov({ client_uuid: cu }));
      const c12 = await violation(trx, () => trx('finance.cash_ledger').insert(baseMov({ client_uuid: cu })));
      ok(c12 === '23505', `[negativa] mismo client_uuid → 23505 (idempotencia), got ${c12}`);

      console.log('\n── 4. Arqueo: el desglose CUADRA, y es verificable en SQL ──');
      // 1 × $1000 + 2 × $100 + 3 × $10 + $4.56 de morralla = $1,234.56 = el monto.
      const [arq] = await trx('finance.cash_ledger')
        .insert(baseMov({ tipo: 'ingreso', monto: 1234.56, morralla: 4.56 })).returning('*');
      await trx('finance.cash_ledger_denominations').insert([
        { tenant_id: T, cash_ledger_id: arq.id, denominacion: 1000, piezas: 1 },
        { tenant_id: T, cash_ledger_id: arq.id, denominacion: 100, piezas: 2 },
        { tenant_id: T, cash_ledger_id: arq.id, denominacion: 10, piezas: 3 },
      ]);
      const cuadre = await trx.raw(`
        SELECT (l.monto - (coalesce(sum(d.denominacion*d.piezas),0) + l.morralla)) AS dif
          FROM finance.cash_ledger l
          LEFT JOIN finance.cash_ledger_denominations d ON d.cash_ledger_id = l.id
         WHERE l.id = ? GROUP BY l.monto, l.morralla`, [arq.id]);
      ok(Number(cuadre.rows[0].dif) === 0, `el arqueo cuadra al centavo (dif ${cuadre.rows[0].dif})`);

      const c13 = await violation(trx, () => trx('finance.cash_ledger_denominations')
        .insert({ tenant_id: T, cash_ledger_id: arq.id, denominacion: 37, piezas: 1 }));
      ok(c13 === '23514', `[negativa] denominación inexistente ($37) → 23514, got ${c13}`);
      const c14 = await violation(trx, () => trx('finance.cash_ledger_denominations')
        .insert({ tenant_id: T, cash_ledger_id: arq.id, denominacion: 50, piezas: 0 }));
      ok(c14 === '23514', `[negativa] 0 piezas → 23514, got ${c14}`);
      const c15 = await violation(trx, () => trx('finance.cash_ledger_denominations')
        .insert({ tenant_id: T, cash_ledger_id: arq.id, denominacion: 1000, piezas: 2 }));
      ok(c15 === '23505', `[negativa] misma denominación dos veces en el mismo movimiento → 23505, got ${c15}`);

      console.log('\n── 5. El folio se genera ATÓMICO (§5.2, patrón order_sequences) ──');
      const bump = async () => {
        const r = await trx.raw(`
          INSERT INTO finance.cash_ledger_sequences (tenant_id, year, tipo, current_value)
          VALUES (?, 2026, 'gasto', 1)
          ON CONFLICT (tenant_id, year, tipo) DO UPDATE
            SET current_value = finance.cash_ledger_sequences.current_value + 1, updated_at = now()
          RETURNING current_value`, [T]);
        return r.rows[0].current_value;
      };
      const seq = [await bump(), await bump(), await bump()];
      ok(JSON.stringify(seq) === JSON.stringify([1, 2, 3]),
        `la secuencia avanza sin repetir: ${seq.join(', ')}`);
      ok(new Set(seq).size === seq.length, 'ningún valor repetido — el DMax+1 de Access daba 34 duplicados');

      console.log('\n── 6. Autorrelleno: el mapa y las reglas se niegan a mentir ──');
      // Media propuesta es peor que ninguna.
      const c16 = await violation(trx, () => trx('finance.caja_kepler_concept_map')
        .insert({ tenant_id: T, legacy_cuenta: '1009', kepler_cuenta: '601-001', kepler_concepto: null }));
      ok(c16 === '23514', `[negativa] propuesta a medias (cuenta sin concepto) → 23514, got ${c16}`);

      // "Sin propuesta" es un estado VÁLIDO y explícito.
      const [sinProp] = await trx('finance.caja_kepler_concept_map')
        .insert({ tenant_id: T, legacy_cuenta: '9999', legacy_nombre: 'Cuenta sin historia', support: 0 })
        .returning('*');
      ok(sinProp.kepler_cuenta === null, 'una cuenta sin propuesta se guarda con el par en NULL (estado honesto)');

      const [conProp] = await trx('finance.caja_kepler_concept_map')
        .insert({ tenant_id: T, legacy_cuenta: '1009', legacy_nombre: 'Matriz Viaticos',
          kepler_cuenta: '601-001', kepler_concepto: '001', support: 47, support_ratio: 0.92 })
        .returning('*');
      ok(Number(conProp.support) === 47, 'la propuesta carga su soporte (n=47) — se muestra, no se esconde');

      const cov = await trx.raw(`SELECT * FROM finance.v_caja_concept_map_coverage WHERE source_caja='20'`);
      const row = cov.rows[0] || {};
      ok(row.cuentas === 2 && row.con_propuesta === 1 && row.sin_propuesta === 1,
        `la cobertura distingue propuesta de vacío (${row.cuentas} cuentas / ${row.con_propuesta} con / ${row.sin_propuesta} sin)`);
      ok(row.por_confirmar === 1, 'y separa lo que falta confirmar de lo ya confirmado');

      const c17 = await violation(trx, () => trx('finance.caja_classify_rules')
        .insert({ tenant_id: T, priority: 10, kepler_cuenta: '601-001', kepler_concepto: '001' }));
      ok(c17 === '23514', `[negativa] regla SIN matcher (aplicaría a todo = default disfrazado) → 23514, got ${c17}`);

      const [rule] = await trx('finance.caja_classify_rules')
        .insert({ tenant_id: T, priority: 10, match_glosa: 'PAPELERIA|PAPELERÍA',
          kepler_cuenta: '601-001', kepler_concepto: '001', note: 'smoke' }).returning('*');
      ok(rule.active === true && rule.suppressed_at === null, 'una regla con matcher nace activa y sin suprimir');
      ok(rule.applied_count === 0 && rule.corrected_count === 0,
        'la telemetría de corrección arranca en cero (regla 4 del §8.5)');

      throw new Error('__ROLLBACK__');
    }).catch((e) => { if (e.message !== '__ROLLBACK__') throw e; });
    console.log('  ✓ rollback aplicado — la DB queda como estaba');
    pass++;

    // ── 7. RLS ────────────────────────────────────────────────────────────────
    // ⚠️ ESTE BLOQUE NO PUEDE CORRER CON LA CONEXIÓN DE ARRIBA: el resto de la suite entra
    // como `postgres`, que tiene BYPASSRLS y hace que CUALQUIER aserción de aislamiento salga
    // verde sin probar nada. Se abre una conexión aparte con el rol de la app (miembro de
    // `app_runtime`, `rolbypassrls = false`), que es el que corre en producción.
    console.log('\n── 7. RLS: el tenant aísla de verdad (con el rol de la app, no postgres) ──');
    const runtimeUrl = process.env.DATABASE_URL_NEW_RUNTIME;
    if (!runtimeUrl) {
      skip('DATABASE_URL_NEW_RUNTIME no está definido → el aislamiento por RLS NO se probó. Como `postgres` saltaría RLS y saldría verde en falso.');
    } else {
      const rt = require('knex')({ client: 'pg', connection: runtimeUrl });
      try {
        const who = await rt.raw(`SELECT current_user u, (SELECT rolbypassrls FROM pg_roles WHERE rolname=current_user) b`);
        ok(who.rows[0].b === false, `el rol de prueba (${who.rows[0].u}) NO tiene BYPASSRLS — la prueba es válida`);

        await rt.transaction(async (trx) => {
          await trx.raw(`SELECT set_config('app.tenant_id', ?, true)`, [T]);
          const [mine] = await trx('finance.cash_ledger').insert(baseMov()).returning('*');
          ok(!!mine.id, 'el rol de la app puede escribir en su propio tenant');
          const mio = await trx.raw(`SELECT count(*)::int n FROM finance.cash_ledger`);
          ok(mio.rows[0].n === 1, `con mi tenant veo mi movimiento (${mio.rows[0].n})`);

          await trx.raw(`SELECT set_config('app.tenant_id', ?, true)`, [OTRO]);
          const ajeno = await trx.raw(`SELECT count(*)::int n FROM finance.cash_ledger`);
          ok(ajeno.rows[0].n === 0, '[negativa] con OTRO tenant no veo ni una fila');

          const cw = await violation(trx, () => trx('finance.cash_ledger').insert(baseMov({ tenant_id: T })));
          ok(cw === '42501', `[negativa] escribir filas de otro tenant → 42501 (RLS WITH CHECK), got ${cw}`);

          await trx.raw(`SELECT set_config('app.tenant_id', '', true)`);
          const sin = await trx.raw(`SELECT count(*)::int n FROM finance.cash_ledger`);
          ok(sin.rows[0].n === 0, '[negativa] sin tenant en la sesión no veo nada (fail-closed)');

          throw new Error('__ROLLBACK__');
        }).catch((e) => { if (e.message !== '__ROLLBACK__') throw e; });
        console.log('  ✓ rollback del bloque RLS aplicado');
        pass++;
      } finally { await rt.destroy(); }
    }

    console.log('\n── 8. Lo que NO se puede medir acá, declarado ──');
    const ee = await knex.raw(`SELECT count(*)::int n FROM analytics.expense_entries`);
    if (ee.rows[0].n === 0) {
      skip(`analytics.expense_entries está VACÍO en esta DB → la capa "aprendido" del autorrelleno (Nivel 2) no se puede probar con datos reales. NO es un ✓.`);
    } else {
      ok(true, `analytics.expense_entries con ${ee.rows[0].n} filas → la capa aprendido es medible acá`);
    }

    console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} ✓ / ${fail} ✗ / ${nomedido} NO MEDIDO\n`);
    process.exitCode = fail === 0 ? 0 : 1;
  } catch (e) {
    console.error('\n💥', e.message, '\n', e.stack);
    process.exitCode = 1;
  } finally {
    await knex.destroy();
  }
})();
