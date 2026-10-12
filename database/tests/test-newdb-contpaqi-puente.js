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
  // `[CP.8.20]` sumó `supplier_accounts` (el mapa proveedor→cuenta). Se nombra el conjunto
  // esperado en vez de contar: un número solo no dice CUÁL falta si algún día falta una.
  const ESPERADAS = ['account_rules', 'poliza_exports', 'supplier_accounts'];
  const nombres = rls.rows.map((r) => r.relname).sort();
  check(nombres.join(',') === ESPERADAS.join(','),
    `las 3 tablas de contpaqi reguladas: ${nombres.join(', ') || '(ninguna)'}`);
  check(rls.rows.every((r) => r.rls && r.forzado), 'RLS habilitado Y FORZADO en las tres');
  const pol = await knex.raw(`SELECT tablename FROM pg_policies WHERE schemaname='contpaqi'`);
  check(pol.rows.length === ESPERADAS.length, `las ${ESPERADAS.length} tienen política de aislamiento (hay ${pol.rows.length})`);

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

  console.log('\n[6] ⭐ Las reglas están claveadas a categorías que EXISTEN, y ninguna es usable todavía');
  const reglas = await knex('contpaqi.account_rules').where({ tenant_id: MEGA })
    .select('categoria_code', 'cuenta_gasto', 'confianza_pct', 'estado', 'concepto_medido', 'tipo_regla')
    .orderBy('categoria_code');
  check(reglas.length >= 19, `las 19 categorías de salida de CB (son ${reglas.length})`);

  // ⛔⛔ LA aserción que justifica esta migración. La semilla anterior tenía 3 reglas claveadas a
  // `combustible`, `mant_reparto` y `renta_muebles` — códigos que NO EXISTEN en CB, inventados al
  // bautizar las reglas con los CONCEPTOS de ContPAQi. Cubrían 17 movimientos de 55,648.
  const codes = reglas.map((r) => r.categoria_code);
  const enCb = await knex('finance.movement_categories').whereIn('code', codes).select('code');
  const existe = new Set(enCb.map((c) => c.code));
  const huerfanas = codes.filter((c) => !existe.has(c));
  check(huerfanas.length === 0,
    `⭐ ninguna regla apunta a una categoría inexistente${huerfanas.length ? ` — huérfanas: ${huerfanas.join(', ')}` : ''}`);

  // Cobertura real: qué porción de los egresos de CB cae en una categoría que el puente conoce.
  const cov = await knex.raw(
    `SELECT count(*)::int total,
            sum(CASE WHEN c.code = ANY(?::text[]) THEN 1 ELSE 0 END)::int cubiertos
       FROM finance.bank_movements m
       JOIN finance.movement_categories c ON c.id = m.category_id
      WHERE m.tenant_id = ? AND m.deleted_at IS NULL AND m.amount_out > 0`, [codes, MEGA]);
  const { total, cubiertos } = cov.rows[0];
  const pct = total ? (100 * cubiertos / total) : 0;
  check(pct > 95, `cubre ${pct.toFixed(1)}% de los egresos de CB (${cubiertos}/${total}) — antes era 0.03%`);

  /**
   * ⭐ Y lo que parece un defecto y es el punto: **ninguna regla ASIENTA todavía**.
   *
   * ⚠️ `[CP.8.19]` puso 2 filas en `estado='derivada'`, y la tentación acá fue cambiar el `0` por
   * un `2`. Sería aflojar el candado: *"hay 2 que no son `sin_regla`"* no dice nada. Lo que
   * importa es **por qué** no lo son, y son dos cosas distintas:
   *
   *  · `tipo_regla = 'no_aplica'` → **veredicto derivado**: esa categoría NO genera póliza.
   *    Está decidido, no pendiente. Que no sea `sin_regla` es correcto.
   *  · cualquier otra con `estado <> 'sin_regla'` → una regla que **asentaría**, y eso sólo puede
   *    pasar cuando el contador firme.
   */
  const noAplica = reglas.filter((r) => r.tipo_regla === 'no_aplica');
  const asentarian = reglas.filter((r) => r.estado !== 'sin_regla' && r.tipo_regla !== 'no_aplica');
  check(asentarian.length === 0,
    `⛔ CERO reglas que ASIENTEN: el mapa categoría→cuenta NO es derivable y lo firma el contador `
    + `(hay ${asentarian.length})`);
  check(noAplica.length > 0 && noAplica.every((r) => r.estado === 'derivada' && !r.cuenta_gasto),
    `⭐ las ${noAplica.length} \`no_aplica\` son veredicto DERIVADO y sin cuenta — "ya se decidió" ≠ "falta decidir"`);
  check(reglas.every((r) => !r.cuenta_gasto && r.confianza_pct === null),
    '⭐ ni cuenta ni confianza: un % al lado de una cuenta vacía se leería como "ya está confirmada"');
  check(reglas.every((r) => (r.concepto_medido || '').length > 40),
    'cada una lleva su evidencia escrita, para que el contador no reciba una hoja en blanco');

  console.log('\n[8] ⭐ El ARMADOR ejercitado contra prod (simulación: no escribe nada)');
  require('ts-node').register({
    transpileOnly: true, skipProject: true,
    compilerOptions: {
      module: 'commonjs', target: 'es2020', esModuleInterop: true, moduleResolution: 'node',
      ignoreDeprecations: '6.0', experimentalDecorators: true, emitDecoratorMetadata: true,
      baseUrl: path.resolve(__dirname, '..', '..'),
      paths: { '@megadulces/contracts': ['libs/contracts/src/index.ts'] },
    },
  });
  require('tsconfig-paths').register({
    baseUrl: path.resolve(__dirname, '..', '..'),
    paths: { '@megadulces/contracts': ['libs/contracts/src/index.ts'] },
  });
  require('reflect-metadata');
  const { ContpaqiArmadoService } = require(path.resolve(__dirname, '..', '..',
    'libs/finance/src/lib/contpaqi/contpaqi-armado.service.ts'));

  // Sin sink: simulación pura. El servicio lee prod de verdad y no escribe una sola fila.
  const armador = new ContpaqiArmadoService(knex, undefined);
  const res = await armador.armarPeriodo('2026-01', true);
  check(res.length > 1000, `procesa los egresos reales de 2026-01 (${res.length})`);
  check(res.every((r) => r.motivo && r.motivo.length > 5), 'cada uno sale con motivo escrito');

  // ⭐ HOY el comportamiento correcto es rechazar TODO: las 21 reglas están en `sin_regla`.
  // No es una falla a medias — es la única conducta honesta mientras el mapa no esté firmado. Y
  // el día que se firme una regla este candado se pone rojo, que es exactamente cuando hay que
  // volver a mirarlo.
  const entregadas = res.filter((r) => r.estado === 'entregada');
  check(entregadas.length === 0,
    `⛔ CERO armables mientras ninguna regla esté firmada (hay ${entregadas.length})`);

  // Los motivos tienen que ser los que la medición encontró, nunca uno genérico.
  // ⚠️ Se evalúa el motivo COMPLETO. La primera versión cortaba a 40 caracteres y eso partía
  // `contpaqi_cuenta` por la mitad (`…no tiene contpaq`), así que la aserción fallaba por el
  // recorte y no por el dato — un falso rojo que parecía un hallazgo.
  /**
   * ⭐ `[CP.8.21]` partió el rechazo genérico en motivos **con dueño**, y el candado los enumera
   * a propósito: si aparece uno fuera de esta lista es un camino nuevo que nadie midió.
   *
   *  `sin_regla`            → el contador
   *  `proveedor_sin_cuenta` → falta el enlace pago→proveedor (`supplier_accounts` en disputa)
   *  `sin_centro_costo`     → ⚠️ falta el DATO de entrada (CB no trae centro de costo), no la regla
   *  `no_aplica` / `sin_medir` → ya decidido · nunca medido
   *  `contpaqi_cuenta`      → el crosswalk de `[CP.2]` (CAJA CG y FACTORAJE no son bancos)
   */
  const MOTIVOS = /sin_regla|contpaqi_cuenta|no tiene fila|proveedor_sin_cuenta|sin_centro_costo|no_aplica|sin_medir/;
  const desconocidos = res.filter((r) => !MOTIVOS.test(r.motivo));
  check(desconocidos.length === 0,
    `sólo motivos conocidos${desconocidos.length ? ` — apareció: "${desconocidos[0].motivo.slice(0, 70)}"` : ''}`);

  const sinCuentaBanco = res.filter((r) => /contpaqi_cuenta/.test(r.motivo));
  check(sinCuentaBanco.length > 0,
    `⚠️ ${sinCuentaBanco.length} cuelgan de CAJA CG / FACTORAJE — no son bancos y no tienen enlace`);

  // [CP.8.1d] Este arrancó en 2 (cobranza, ingreso_devolucion) y la migración lo cerró.
  const sinFila = res.filter((r) => /no tiene fila/.test(r.motivo));
  check(sinFila.length === 0,
    '⭐ ninguna categoría quedó sin fila de regla (eran 2: cobranza e ingreso_devolucion)');

  console.log('\n[9] Lo que este candado NO cubre');
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
