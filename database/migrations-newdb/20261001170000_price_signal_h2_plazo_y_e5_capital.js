'use strict';
/**
 * `[PR.S4]` — **H2 · Prima por plazo de cobro: medida, REFUTADA por el control de volumen.**
 * **Y E5 · Tasa de costo de capital: la ausencia que el registro nunca declaro.**
 *
 * ── H2 · Por que se midio ─────────────────────────────────────────────────────────────────
 * Tras refutar H1 (margen por canal), el plazo era la unica de las cuatro candidatas que **no
 * toca el costo**: no divide margen, mide cuando llega el peso. Y los numeros de arranque eran
 * fuertes — cartera **$67.58 M**, **90.7 %** de los documentos vencidos, y **890 clientes
 * marcados "contado" con $37.31 M de saldo**.
 *
 * ── ⭐⭐ Lo que la primera medicion mostro, y por que NO alcanzaba ──────────────────────
 * Mismo SKU, misma unidad, factura a credito contra factura de contado, 45 dias:
 *
 *   | medicion                    | promedio | mediana |  p10  |  p90  |
 *   |-----------------------------|---------:|--------:|------:|------:|
 *   | REAL (credito vs contado)   | **-4.80 %** | -4.69 % | -8.16 | -0.94 |
 *   | PLACEBO (mitad al azar)     |   +0.06 % |  0.00 % | -2.45 | +2.79 |
 *
 * El placebo centrado en cero: no era ruido. **El cliente a credito pagaba 4.80 % MENOS**, en el
 * **93.1 %** de los 608 SKU comparables ($13.28 M de $14.01 M). Leido asi, parecia un error de
 * precio grande y en la direccion contraria a la sana: se financia al cliente Y se le descuenta.
 *
 * ── ⛔⛔ El control de volumen lo desarmo ─────────────────────────────────────────────────
 * La linea a credito tiene **cantidad mediana 12.00** contra **2.00** la de contado: compran
 * **6x mas por renglon**. Repitiendo el mismo test DENTRO de tramos de cantidad comparable:
 *
 *   | tramo cantidad | SKUs | dif. precio |
 *   |----------------|-----:|------------:|
 *   | 1              |    7 |     -1.01 % |
 *   | 2-3            |   21 |     -2.44 % |
 *   | 4-10           |  108 |     **-0.00 %** |
 *   | 11-30          |   61 |     **+0.23 %** |
 *   | 30+            |   34 |     -0.46 % |
 *
 * Ponderado por venta: **-0.14 %** sobre $3.56 M. **El -4.80 % era el descuento por volumen.**
 * El precio SI esta bien puesto para el plazo pactado. La senal no existe.
 *
 * ⭐ Es el segundo control que desarma una senal en la misma sesion (el primero fue H1). La
 * diferencia entre las dos: a H1 la mato un control NEGATIVO (un caso donde el efecto debia
 * desaparecer y desaparecio); a H2 la mato un control de CONFUSION (una tercera variable que
 * explica el efecto entero). No son el mismo instrumento y las dos hacian falta.
 *
 * ── Lo que queda, y NO es de precio ───────────────────────────────────────────────────────
 * El precio es correcto **para el plazo pactado**. El problema es que el plazo pactado no es el
 * real: **pactado 5.1 dias contra 21.2 reales** (4x), y las facturas marcadas **"0 contado" se
 * cobran a 14.3 dias** de promedio, mediana 11, p90 30. Eso es un hallazgo de **cobranza**, no
 * de precio, y el motor de margen no es el lugar donde se arregla.
 * ⚠️ Medido sobre el **14.9 %** de las facturas (788 de 5,276 en 180 dias): es el unico subconjunto
 *    con `dias_pago` poblado. NO se extrapola.
 *
 * ── E5 · La ausencia que nadie habia declarado ────────────────────────────────────────────
 * Para convertir "16 dias de financiamiento no cobrado" en pesos hace falta una **tasa de costo
 * de capital**, y ⛔ **no existe en el registro, en ninguna familia** — se busco por nombre y por
 * motivo y no hay una sola fila. La accion `liberar_capital` del triage publica **$60.46 M** de
 * saldo inmovilizado que por eso mismo **no se puede ordenar contra los flujos**, y ahora el
 * plazo necesita la misma tasa.
 *
 * ⚠️ Y de paso corrige un error que venia propagandose: el doc de fase llamaba a esta ausencia
 *    "D5", pero **D5 es "Frecuencia de cambio" y esta CABLEADA**. La tasa de capital nunca tuvo
 *    clave. Ahora la tiene: **E5**, en `inventario`, que es donde se declaro la necesidad.
 *
 * Idempotente: `ON CONFLICT (clave) DO UPDATE`.
 */

const T = 'analytics.price_signal_registry';

const H2 = {
  clave: 'H2',
  familia: 'cliente',
  nombre: 'Prima por plazo de cobro',
  definicion:
    'Sobreprecio que paga el cliente a credito frente al de contado, por el mismo SKU y la misma '
    + 'unidad. Mide si el precio compensa el financiamiento que se le da al comprador.',
  unidad: 'pct',
  direccion: 'ninguna',
  estado: 'refutada',
  cobertura_pct: 0,
  cobertura_medida_al: '2026-10-01',
  fuente_objeto: 'analytics.erp_sales_invoices',
  fuente_columna: 'dias_credito',
  motivo_ausencia: [
    'medido 2026-10-01 CON DOS CONTROLES, y refutado.',
    'Primera lectura (45 d, mismo SKU y misma unidad): el cliente a credito paga 4.80% MENOS que el',
    'de contado (mediana -4.69%), en el 93.1% de los 608 SKU comparables ($13.28M de $14.01M), con un',
    'placebo de particion al azar centrado en cero (+0.06%). Parecia un error de precio grande y en',
    'la direccion contraria a la sana.',
    'EL CONTROL DE CONFUSION lo desarma: la linea a credito tiene cantidad mediana 12.00 contra 2.00',
    'la de contado -- compran 6x mas por renglon. Dentro de tramos de cantidad comparable la',
    'diferencia se desploma a -1.01 / -2.44 / -0.00 / +0.23 / -0.46 % y PONDERADA POR VENTA queda en',
    '-0.14% sobre $3.56M. El -4.80% era el descuento por volumen, no una prima de plazo ausente.',
    'El precio SI esta bien puesto para el plazo PACTADO.',
    'LO QUE QUEDA NO ES DE PRECIO: el plazo pactado promedio es 5.1 dias y el real 21.2 (4x), y las',
    'facturas marcadas "0 contado" se cobran a 14.3 dias (mediana 11, p90 30). Es cobranza, no',
    'precio. Medido sobre el 14.9% de las facturas (788 de 5,276 en 180 d), el unico subconjunto con',
    'dias_pago poblado: NO se extrapola.',
    'NO reconstruir como senal de precio sin rehacer antes el control de cantidad.',
  ].join(' '),
  peso_max: 0,
  nucleo: false,
};

const E5 = {
  clave: 'E5',
  familia: 'inventario',
  nombre: 'Tasa de costo de capital',
  definicion:
    'Costo anual del dinero inmovilizado, en por ciento. Es lo que convierte un SALDO (inventario '
    + 'parado, cartera sin cobrar) en un FLUJO comparable contra las demas acciones del triage.',
  unidad: 'pct',
  direccion: 'menos_es_mejor',
  estado: 'no_existe',
  cobertura_pct: 0,
  cobertura_medida_al: null,
  fuente_objeto: null,
  fuente_columna: null,
  motivo_ausencia: [
    'declarada 2026-10-01: no existe en el registro en NINGUNA familia -- se busco por nombre y por',
    'motivo y no habia una sola fila, pese a que dos cosas ya dependen de ella.',
    'La accion liberar_capital publica $60.46M de saldo inmovilizado que SIN esta tasa no se puede',
    'ordenar contra los flujos de las otras acciones (por eso sale sin barra en la pantalla), y el',
    'plazo de cobro (H2) necesita la misma tasa para convertir 16 dias de financiamiento no cobrado',
    'en pesos.',
    'CORRIGE UN ERROR QUE SE PROPAGABA: el doc de fase llamaba a esta ausencia "D5", pero D5 es',
    '"Frecuencia de cambio" y esta CABLEADA. La tasa de capital nunca tuvo clave propia.',
    'Es una DECISION de la direccion financiera, no un dato derivable: hay que fijarla, no medirla.',
  ].join(' '),
  peso_max: 0,
  nucleo: false,
};

const COLS = ['familia', 'nombre', 'definicion', 'unidad', 'direccion', 'estado',
  'cobertura_pct', 'cobertura_medida_al', 'fuente_objeto', 'fuente_columna',
  'motivo_ausencia', 'peso_max', 'nucleo', 'updated_at'];

exports.up = async function up(knex) {
  await knex.raw("SET LOCAL lock_timeout = '5s'");

  const [{ hay }] = (await knex.raw(`SELECT to_regclass('${T}') IS NOT NULL AS hay`)).rows;
  if (!hay) throw new Error('[PR.S4] falta analytics.price_signal_registry');

  // ⚠️ D5 existe y esta cableada: si algun dia alguien "arregla" el doc moviendo la tasa de
  //    capital a D5, pisaria una senal viva. Se comprueba antes de escribir.
  const d5 = await knex(T).select('nombre', 'estado').where({ clave: 'D5' }).first();
  if (d5 && d5.estado === 'cableada' && /capital/i.test(d5.nombre || '')) {
    throw new Error('[PR.S4] D5 cambio de significado: revisar antes de crear E5');
  }

  for (const fila of [H2, E5]) {
    await knex(T).insert({ ...fila, updated_at: knex.fn.now() })
      .onConflict('clave').merge(COLS);
  }

  // ⭐ Se comprueba lo escrito: una migracion que no verifica su efecto es una intencion.
  for (const esperado of [H2, E5]) {
    const f = await knex(T).select('estado', 'cobertura_pct', 'peso_max')
      .where({ clave: esperado.clave }).first();
    if (!f) throw new Error(`[PR.S4] ${esperado.clave} no quedo escrita`);
    if (f.estado !== esperado.estado) {
      throw new Error(`[PR.S4] ${esperado.clave} quedo en ${f.estado}, se esperaba ${esperado.estado}`);
    }
    if (Number(f.cobertura_pct) !== 0 || Number(f.peso_max) !== 0) {
      throw new Error(`[PR.S4] ${esperado.clave}: lo que no se midio no puede pesar`);
    }
  }

  const [{ r, n }] = (await knex.raw(
    `SELECT count(*) FILTER (WHERE estado='refutada')::int AS r,
            count(*) FILTER (WHERE estado='no_existe')::int AS n FROM ${T}`)).rows;
  // eslint-disable-next-line no-console
  console.log(`[PR.S4] H2 refutada con control de volumen · E5 declarada. refutadas=${r} no_existe=${n}`);
};

exports.down = async function down(knex) {
  await knex.raw("SET LOCAL lock_timeout = '5s'");
  await knex(T).whereIn('clave', ['H2', 'E5']).del();
};
