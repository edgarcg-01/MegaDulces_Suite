/**
 * `[CP.8.10]` — Candado del PUENTE contra el esquema REAL.
 *
 * ⭐ **Por qué existe, y por qué no es otro test de lógica.** El motor del cuadre ya tiene su
 * candado (35 ✓) y el armador el suyo (33 ✓): ésos prueban la REGLA. Lo que ninguno puede probar
 * es que el SQL que el servicio ejecuta sea válido contra las tablas que existen de verdad —
 * nombres de columna, tipos, `jsonb ->>`, el `onConflict` del latido.
 *
 * Y las dos alternativas están documentadas en este repo como **no-pruebas**:
 *
 *   · un doble de Knex **no ejecuta SQL**, así que da verde con columnas inventadas;
 *   · un smoke por regex sobre el fuente no prueba nada del esquema.
 *
 * Así que esto corre las consultas REALES. Es de **sólo lectura**: no inserta, no actualiza y no
 * borra, así que es seguro contra prod (de hecho `edgar` sólo tiene SELECT en `contpaqi.*`).
 *
 * Lo que NO cubre, y queda declarado: el camino de ESCRITURA (`guardar()` y el latido). Para
 * ejercerlo hace falta un destino con permiso de escritura, y este candado prefiere decirlo a
 * fingir que lo cubre.
 */
'use strict';

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env'), quiet: true });

const knex = require('knex')(require('../knexfile-newdb.js').development);

const MEGA = '00000000-0000-0000-0000-00000000d01c';
let ok = 0;
let fail = 0;
let nomedido = 0;
const check = (cond, label) => {
  if (cond) { ok++; console.log(`  ✓ ${label}`); }
  else { fail++; console.log(`  ✗ ${label}`); }
};
const declarar = (label) => { nomedido++; console.log(`  ⚠ NO MEDIDO: ${label}`); };

(async () => {
  console.log('\n[1] El esquema que el puente necesita EXISTE y tiene la forma esperada');
  const cols = await knex.raw(`
    SELECT table_name, column_name FROM information_schema.columns
     WHERE table_schema = 'contpaqi' ORDER BY table_name, ordinal_position`);
  const por = {};
  for (const r of cols.rows) (por[r.table_name] = por[r.table_name] || []).push(r.column_name);
  check(!!por.account_rules, 'existe contpaqi.account_rules');
  check(!!por.poliza_exports, 'existe contpaqi.poliza_exports');
  // Las columnas que el servicio nombra. Si alguna falta, su SQL revienta en runtime.
  for (const c of ['evento_tipo', 'evento_id', 'periodo', 'total', 'asiento', 'estado',
    'verificada', 'verificada_en', 'contpaqi_folio', 'contpaqi_guid', 'motivo', 'updated_at']) {
    check((por.poliza_exports || []).includes(c), `poliza_exports.${c}`);
  }

  console.log('\n[2] RLS forzado y aislamiento por tenant — el puente guarda dinero');
  const rls = await knex.raw(`
    SELECT c.relname, c.relrowsecurity AS rls, c.relforcerowsecurity AS forzado
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'contpaqi' AND c.relkind = 'r' ORDER BY 1`);
  check(rls.rows.length === 2, `2 tablas reguladas (son ${rls.rows.length})`);
  check(rls.rows.every((r) => r.rls && r.forzado), 'RLS habilitado Y FORZADO en las dos');
  const pol = await knex.raw(`SELECT tablename FROM pg_policies WHERE schemaname='contpaqi'`);
  check(pol.rows.length === 2, 'las dos tienen política de aislamiento');

  console.log('\n[3] ⭐ La consulta de PENDIENTES del servicio, ejecutada de verdad');
  // Copia exacta de `cuadrarPendientes()`. Si una columna o un `->>` no existe, acá revienta.
  let pendientes = null;
  try {
    pendientes = await knex('contpaqi.poliza_exports')
      .where({ tenant_id: MEGA })
      .whereIn('estado', ['entregada', 'armada'])
      .whereNull('verificada')
      .select(
        'evento_tipo', 'evento_id', 'periodo', 'total', 'asiento',
        knex.raw(`asiento->>'fecha' as fecha`),
        knex.raw(`(asiento->>'tipo_poliza')::int as tipo_poliza`),
        knex.raw(`asiento->>'token' as token`),
        knex.raw(`to_char(updated_at, 'YYYY-MM-DD') as entregada_en`),
      );
    check(true, `la consulta de pendientes es SQL válido contra el esquema real (${pendientes.length} filas)`);
  } catch (e) {
    check(false, `la consulta de pendientes FALLA: ${e.message}`);
  }

  console.log('\n[4] ⭐ La consulta de CANDIDATOS contra `analytics.gl_polizas` (128 mil filas)');
  let ms = 0;
  try {
    const t0 = Date.now();
    const cand = await knex('analytics.gl_polizas')
      .where({ tenant_id: MEGA })
      // La consulta ACOTADA que el servicio hace hoy: token + (fecha Y total) de los pendientes.
      // Se simula con un pendiente realista para medir el costo que el cron va a pagar.
      .where((qb) => {
        qb.whereILike('concepto', 'MD:%');
        qb.orWhere((q) => q
          .whereIn(knex.raw("to_char(fecha, 'YYYY-MM-DD')"), ['2026-09-30'])
          .whereIn('cargos', [17097689.28]));
      })
      .select('ejercicio', 'periodo', 'tipo_pol', 'folio', 'guid', 'concepto',
        knex.raw(`to_char(fecha, 'YYYY-MM-DD') as fecha`),
        knex.raw('cargos::float8 as cargos'),
        knex.raw('abonos::float8 as abonos'));
    ms = Date.now() - t0;
    check(true, `la consulta de candidatos es SQL válido (${cand.length} filas en ${ms} ms)`);
    // ⭐ Regla dura del proyecto: una consulta de >500 ms "no funciona". Esto corre en un cron
    // cada 10 min, así que no es crítico, pero medirlo ahora evita descubrirlo cuando crezca.
    check(ms < 500, `tarda ${ms} ms (regla del proyecto: < 500 ms)`);
    // ⭐ El universo acotado es la mitad del arreglo: traer el periodo entero daba 17,596 filas.
    check(cand.length < 500, `trae ${cand.length} candidatos — acotado, no el mes entero (eran 17,596)`);
    // ⭐ Y lo que importa MAS que la velocidad: que siga ENCONTRANDO. Una consulta que devuelve
    // 0 siempre tambien es rapida. El par (fecha, total) existe en prod: la poliza 2/424.
    check(cand.length >= 1 && cand.some((c) => String(c.folio).trim() === '424'),
      '⭐ la consulta ACOTADA sigue encontrando la póliza real 2/424 — acotar no fue romper');
    check(cand.every((c) => typeof c.cargos === 'number'),
      '`cargos` llega como número, no como string de numeric (rompería el cuadre al centavo)');
    check(cand.every((c) => c.fecha === null || /^\d{4}-\d{2}-\d{2}$/.test(c.fecha)),
      '⭐ `fecha` llega como YYYY-MM-DD y no como Date (pg devuelve Date y correría el día)');
  } catch (e) {
    check(false, `la consulta de candidatos FALLA: ${e.message}`);
  }

  console.log('\n[5] El latido tiene umbral registrado — sin él, verde incondicional');
  const svc = require('fs').readFileSync(
    path.resolve(__dirname, '..', '..', 'apps/api/src/modules/db-health/db-health.service.ts'), 'utf8');
  const bloque = svc.match(/const CRON_JOBS[^=]*=\s*\[([\s\S]*?)\n\];/);
  check(!!bloque, 'se puede parsear el bloque CRON_JOBS');
  check(!!bloque && bloque[1].includes("'contpaqi_cuadre'"),
    'CRON_JOBS registra `contpaqi_cuadre` (si no, el sensor da verde incondicional)');
  const linea = bloque ? bloque[1].split('\n').find((l) => l.includes('contpaqi_cuadre')) : '';
  check(/warnH:\s*\d+/.test(linea || '') && /critH:\s*\d+/.test(linea || ''),
    'y trae sus dos umbrales');

  console.log('\n[6] Las reglas sembradas, contra la medición que las originó');
  const reglas = await knex('contpaqi.account_rules').where({ tenant_id: MEGA })
    .select('categoria_code', 'cuenta_gasto', 'confianza_pct', 'estado').orderBy('categoria_code');
  check(reglas.length === 6, `6 reglas sembradas (son ${reglas.length})`);
  const derivadas = reglas.filter((r) => r.estado === 'derivada');
  check(derivadas.length === 5, '5 derivadas');
  check(derivadas.every((r) => r.cuenta_gasto && Number(r.confianza_pct) >= 97),
    '⭐ toda regla derivada tiene cuenta Y concentra ≥97% — es lo que la hace usable');
  const sinRegla = reglas.filter((r) => r.estado === 'sin_regla');
  check(sinRegla.length === 1 && !sinRegla[0].cuenta_gasto,
    '⛔ `imss_sua` sigue DECLARADA sin cuenta (10.2% no concluye; forzarla sería inventar)');

  console.log('\n[7] Lo que este candado NO cubre');
  declarar('el camino de ESCRITURA (`guardar()` y el latido): `edgar` sólo tiene SELECT en contpaqi.*');
  declarar('el ciclo completo armar→entregar→cuadrar: necesita que el código esté desplegado');

  console.log(`\n${fail === 0 ? '✅' : '❌'} CP.8.10 el puente contra el esquema real: ${ok} ✓ / ${fail} ✗ · ${nomedido} NO MEDIDO\n`);
  await knex.destroy();
  process.exit(fail === 0 ? 0 : 1);
})().catch(async (e) => {
  console.log(`  ✗ excepción no esperada: ${e && e.message}`);
  console.log(`\n❌ CP.8.10 el puente contra el esquema real: ${ok} ✓ / ${fail + 1} ✗\n`);
  try { await knex.destroy(); } catch { /* ya cerrado */ }
  process.exit(1);
});
