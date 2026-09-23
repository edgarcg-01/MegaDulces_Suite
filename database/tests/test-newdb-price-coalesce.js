/* eslint-disable no-console */
'use strict';
/**
 * `[DB-MEM.20]` — El normalizador de precio se JUNTA, no se saca.
 *
 * ── Qué se está protegiendo ──────────────────────────────────────────────────
 * `normalizeSalePrice` recalcula una moda de precios sobre 90 días. Corría en CADA embarque de
 * `kdm2` (la tabla de líneas de venta) dentro del carril de @15 s. Medido en prod el 2026-09-23:
 *
 *     92.8% de TODO el tiempo de consulta de la base
 *     38 ejecuciones → 4,850,000 bloques (~37 GB) movidos para devolver 124 filas
 *     costo cronometrado: 1 SKU = 924 ms · 4 SKUs = 2,433 ms  ⇒  ~600 ms POR SKU
 *
 * El ciclo del carril dejó de cerrar dentro de su umbral de salud y `autoheal` lo reinició 39
 * veces en un día. La decisión (del usuario, 2026-09-23) fue **no sacar `kdm2` de la ecuación**:
 * el precio sigue saliendo de la venta, con un rezago de minutos.
 *
 * ── Por qué este archivo existe ──────────────────────────────────────────────
 * Porque un coalescedor puede fallar de tres formas que se leen igual que "funciona":
 *   1. no juntar nada y correr igual que antes (no ahorra),
 *   2. juntar y NUNCA vaciar (el precio se congela — peor que el problema original),
 *   3. perder SKUs cuando un lote falla (el precio de ESE SKU queda viejo, en silencio).
 * Las tres tienen su negativa acá. La 3 es la que más importa y es la razón de que el módulo
 * exponga `__coalesce`: comprobarla a través de Postgres exigiría romper la base a propósito.
 *
 * ── Sin DB y sin API ─────────────────────────────────────────────────────────
 * Carga el módulo REAL y le pasa un normalizador de mentira que cuenta sus llamadas.
 */

const path = require('path');

const RUTA = path.resolve(__dirname, '../../services/feeds-ingest/apply-handlers.js');

let ok = 0; let fail = 0;
const bien = (m) => { ok++; console.log(`  ✓ ${m}`); };
const mal = (m, d) => { fail++; console.log(`  ✗ ${m}${d ? ` → ${d}` : ''}`); };
const chk = (cond, m, d) => (cond ? bien(m) : mal(m, d));

/** Recarga el módulo con el entorno pedido (las constantes se leen al cargar). */
function cargar(env) {
  for (const k of Object.keys(env)) {
    if (env[k] === undefined) delete process.env[k]; else process.env[k] = String(env[k]);
  }
  delete require.cache[require.resolve(RUTA)];
  return require(RUTA).__coalesce;
}

/** Normalizador de mentira: registra los lotes que recibió y puede fallar a pedido. */
function espia({ fallarEn = -1, tardarMs = 0 } = {}) {
  const lotes = [];
  const fn = async (_c, _t, skus) => {
    lotes.push([...skus]);
    if (lotes.length === fallarEn) throw new Error('fallo simulado del lote');
    if (tardarMs) await new Promise((r) => setTimeout(r, tardarMs));
    return skus.length;
  };
  Object.defineProperty(fn, 'name', { value: 'normalizeSalePrice' });
  return { fn, lotes };
}

/** Empuja el reloj hacia atrás para simular que la ventana ya venció. */
const vencer = (st) => { st.ultimoVaciado = 0; };

(async () => {
  console.log('\n╔══════════════════════════════════════════════════════════════╗');
  console.log('║  [DB-MEM.20] el precio se JUNTA, no se saca de la ecuación   ║');
  console.log('╚══════════════════════════════════════════════════════════════╝');

  // ── 1. EL INTERRUPTOR DE APAGADO (la negativa que permite revertir sin deploy) ──
  console.log('\n1) Interruptor: ODS_PRICE_COALESCE_SEC=0 ⇒ comportamiento de antes');
  {
    const c = cargar({ ODS_PRICE_COALESCE_SEC: 0 });
    chk(c.COALESCIBLES.size === 0, 'con 0 NO se coalesce nada (vuelve a correr al momento)',
      `size=${c.COALESCIBLES.size}`);
    chk(!c.COALESCIBLES.has('kdm2:normalizeSalePrice'), 'y kdm2 tampoco está en la lista');
  }

  // ── 2. QUÉ se junta y qué NO ──
  console.log('\n2) Sólo el camino caro. `kdii` sigue AL MOMENTO (lo exige [TDA.1])');
  {
    const c = cargar({ ODS_PRICE_COALESCE_SEC: 300 });
    chk(c.COALESCIBLES.has('kdm2:normalizeSalePrice'),
      'kdm2:normalizeSalePrice SÍ se junta (es el de ~600 ms por SKU)');
    chk(!c.COALESCIBLES.has('kdii:normalizeSalePrice'),
      'kdii:normalizeSalePrice NO se junta — un cambio de precio en Kepler llega en vivo');
    chk(!c.COALESCIBLES.has('kdpv_prod_util:normalizeSalePrice'),
      'kdpv_prod_util:normalizeSalePrice tampoco');
  }

  // ── 3. Junta, deduplica, y NO corre antes de tiempo ──
  console.log('\n3) Junta y deduplica entre embarques; nada corre antes de la ventana');
  {
    const c = cargar({ ODS_PRICE_COALESCE_SEC: 300 });
    c.pendientes.clear();
    const { fn, lotes } = espia();
    c.acumular('kdm2:normalizeSalePrice', fn, ['A', 'B']);
    c.acumular('kdm2:normalizeSalePrice', fn, ['B', 'C']);   // B repetido a propósito
    c.acumular('kdm2:normalizeSalePrice', fn, ['A']);        // A otra vez
    const st = c.pendientes.get('kdm2:normalizeSalePrice');
    chk(st.skus.size === 3, 'tres SKUs distintos de seis llegadas (deduplica)', `size=${st.skus.size}`);
    await c.vaciarCoalescidos({}, 'tnt');
    chk(lotes.length === 0, 'NEGATIVA: antes de la ventana el normalizador NO se llamó',
      `llamadas=${lotes.length}`);
    chk(st.skus.size === 3, 'y lo juntado sigue ahí, sin perderse');
  }

  // ── 4. Vacía al vencer la ventana, con la unión deduplicada ──
  console.log('\n4) Al vencer la ventana vacía, en lotes del tamaño configurado');
  {
    const c = cargar({ ODS_PRICE_COALESCE_SEC: 300, ODS_PRICE_COALESCE_CHUNK: 2 });
    c.pendientes.clear();
    const { fn, lotes } = espia();
    c.acumular('kdm2:normalizeSalePrice', fn, ['A', 'B', 'C', 'D', 'E']);
    vencer(c.pendientes.get('kdm2:normalizeSalePrice'));
    await c.vaciarCoalescidos({}, 'tnt');
    const vistos = lotes.flat().sort();
    chk(lotes.length === 3, 'cinco SKUs en lotes de 2 ⇒ 3 statements', `lotes=${lotes.length}`);
    chk(lotes.every((l) => l.length <= 2), 'ningún lote se pasa del tamaño configurado',
      JSON.stringify(lotes));
    chk(vistos.join(',') === 'A,B,C,D,E', 'se procesaron los 5, sin repetir ni perder', vistos.join(','));
    chk(c.pendientes.get('kdm2:normalizeSalePrice').skus.size === 0, 'la bolsa quedó vacía');
  }

  // ── 5. El presupuesto acota el ciclo; lo que sobra ESPERA (no se tira) ──
  //
  // ⛔ ESTE BLOQUE AFIRMABA LO CONTRARIO Y ESTABA MAL. La primera versión reiniciaba el reloj
  // SÓLO al vaciar del todo ("si quedó algo, seguí"), y el test lo daba por bueno. Se midió en
  // prod a los 20 minutos de desplegarlo: `vaciarCoalescidos` se llama una vez por (rama, tabla)
  // —hasta ~170 veces por ciclo— así que con rezago el presupuesto NO acotaba NADA; se gastaba
  // entero en cada llamada (`20948ms · quedan 3682`, `20619ms · quedan 3582`, seguidas).
  // Un presupuesto que sólo limita UNA llamada, en un lazo que llama muchas veces, no es un
  // presupuesto. El reloj se reinicia SIEMPRE, y eso es lo que se prueba acá.
  console.log('\n5) El presupuesto acota el gasto POR VENTANA (no por llamada), y el sobrante NO se pierde');
  {
    const c = cargar({ ODS_PRICE_COALESCE_SEC: 300, ODS_PRICE_COALESCE_CHUNK: 1, ODS_PRICE_COALESCE_BUDGET_MS: 1000 });
    c.pendientes.clear();
    const { fn, lotes } = espia({ tardarMs: 400 });   // 400 ms por lote ⇒ ~2-3 entran en 1000 ms
    c.acumular('kdm2:normalizeSalePrice', fn, ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H']);
    const st = c.pendientes.get('kdm2:normalizeSalePrice');
    vencer(st);
    await c.vaciarCoalescidos({}, 'tnt');
    const tras1 = lotes.length;
    chk(tras1 > 0 && tras1 < 8, 'se cortó por presupuesto antes de procesar los 8', `lotes=${tras1}`);
    chk(st.skus.size === 8 - tras1, 'el resto quedó en la bolsa para la próxima ventana',
      `quedan=${st.skus.size} procesados=${tras1}`);
    chk(st.ultimoVaciado > 0, 'el reloj SÍ se reinicia aunque haya sobrante (así el gasto queda acotado)',
      `ultimoVaciado=${st.ultimoVaciado}`);
    // ⭐ La negativa que prueba que el presupuesto es REAL: una segunda llamada dentro de la misma
    // ventana no puede gastar otro presupuesto entero. Sin esto, el defecto medido en prod pasaba
    // el test sin despeinarse.
    await c.vaciarCoalescidos({}, 'tnt');
    chk(lotes.length === tras1,
      'NEGATIVA: una 2ª llamada DENTRO de la ventana no procesa nada más (el lazo llama ~170 veces por ciclo)',
      `antes=${tras1} después=${lotes.length}`);
  }

  // ── 6. ⭐ LA QUE MÁS IMPORTA: un lote que falla DEVUELVE sus SKUs ──
  console.log('\n6) ⭐ Un lote que falla devuelve sus SKUs a la bolsa (el precio no queda viejo en silencio)');
  {
    const c = cargar({ ODS_PRICE_COALESCE_SEC: 300, ODS_PRICE_COALESCE_CHUNK: 2 });
    c.pendientes.clear();
    const { fn, lotes } = espia({ fallarEn: 2 });   // el 2º lote revienta
    c.acumular('kdm2:normalizeSalePrice', fn, ['A', 'B', 'C', 'D', 'E', 'F']);
    const st = c.pendientes.get('kdm2:normalizeSalePrice');
    vencer(st);
    let tiro = false;
    try { await c.vaciarCoalescidos({}, 'tnt'); } catch { tiro = true; }
    chk(!tiro, 'NEGATIVA: un lote fallado NO tumba el vaciado (ni, por lo tanto, el carril)');
    chk(st.skus.size === 4, 'los 2 del lote fallado + los 2 nunca intentados siguen en la bolsa',
      `quedan=${st.skus.size} lotes=${lotes.length}`);
    const confirmados = lotes[0];
    chk(confirmados.every((s) => !st.skus.has(s)), 'el lote que SÍ confirmó salió de la bolsa',
      JSON.stringify([...st.skus]));
  }

  // ── 7. Sin nada juntado, vaciar es no-op (no puede inventar trabajo) ──
  console.log('\n7) Sin nada juntado no hace nada');
  {
    const c = cargar({ ODS_PRICE_COALESCE_SEC: 300 });
    c.pendientes.clear();
    const { fn, lotes } = espia();
    c.acumular('kdm2:normalizeSalePrice', fn, []);
    const st = c.pendientes.get('kdm2:normalizeSalePrice');
    vencer(st);
    await c.vaciarCoalescidos({}, 'tnt');
    chk(lotes.length === 0, 'NEGATIVA: bolsa vacía ⇒ cero llamadas', `llamadas=${lotes.length}`);
    chk(st.ultimoVaciado > 0, 'y el reloj se reinicia igual (no queda reintentando en vacío)');
  }

  console.log(`\n${'─'.repeat(64)}`);
  console.log(`  ${ok} ✓   ${fail} ✗`);
  if (fail) { console.log('  RESULTADO: FALLÓ\n'); process.exit(1); }
  console.log('  RESULTADO: OK\n');
})().catch((e) => { console.error('\nERROR:', e); process.exit(1); });
