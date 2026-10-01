'use strict';
/**
 * `[PR.S3]` — **H1 · Margen por canal: medido, REFUTADO, y con su control negativo.**
 *
 * ── Por que existe esta fila ──────────────────────────────────────────────────────────────
 * El registro tenia 46 senales en 7 familias y ninguna miraba el CANAL. La omision parecia
 * barata de cerrar: `analytics.sales_daily.channel` tiene 6 valores, el costo esta poblado en
 * 98-100 % de las filas de los seis, y el **84.2 % de la venta de 90 dias** pasa por celdas
 * (almacen, SKU) que venden por **dos canales o mas**. O sea: dimension masiva, dato limpio,
 * cero fuentes nuevas. Era la candidata obvia.
 *
 * ── ⛔⛔ Lo que la medicion encontro ───────────────────────────────────────────────────────
 * El margen por canal **no se puede leer**, y no por culpa del canal:
 *
 *   | canal            | celdas con precio distinto entre almacenes | margen CONGELADO |
 *   |------------------|------------------------------------------:|-----------------:|
 *   | tienda           |                                      1,800 |        **100.0 %** |
 *   | mayoreo          |                                        204 |        **100.0 %** |
 *   | credito          |                                      1,255 |        **100.0 %** |
 *   | wincaja_ruta     |                                         27 |          **0.0 %** |
 *
 * En los tres canales de Kepler, en el **100.0 %** de las celdas donde el precio difiere mas de
 * 5 % entre almacenes, el spread de margen es **menor a 0.01 pp**. El margen no se mueve aunque
 * el precio se mueva: esta **congelado por construccion**, porque `sales_daily.cost` del lado
 * Kepler sale de `revenue / (1 + markup_pct)` — algebra ciega al precio (enmienda del ADR-051).
 *
 * ⭐⭐ **El control negativo es la mitad que da validez a la medicion**: `wincaja_ruta`, cuyo
 * costo es el `ValorCosto` real del POS, da **0.0 %** congelado — ahi el margen SI se mueve con
 * el precio, en el 100 % de los casos. Sin ese contraste, el 100.0 % de Kepler se podria haber
 * leido como "los precios estan bien alineados" en vez de "el numero no puede variar".
 *
 * ── El espejismo que esto desarma ─────────────────────────────────────────────────────────
 * Antes de mirar el control, la dispersion de margen entre canales daba **0.59 pp** de promedio
 * contra un placebo de particion al azar de **0.15 pp** — 4x el ruido, aparentemente una senal
 * de verdad — y en dinero **$846,040 de margen en juego en 90 dias** sobre 1,821 celdas, que es
 * **2.7x la accion mas grande que el motor publica hoy** (`subir_precio`, $105,096 / 30 d).
 * ⛔ Ese numero es el **metodo de costeo**, no el canal. Publicarlo habria sido repetir
 * exactamente lo de MR.5: una cifra de margen construida sobre un costo derivado.
 *
 * ── Lo que SI quedo en pie, y por que igual no es una accion ──────────────────────────────
 *   · El spread de **PRECIO** por canal es real y **observado** (no derivado): **86.2 %** de la
 *     venta se cobra distinto segun el canal, con mediana de **8 %** en la banda principal
 *     (2,426 celdas, $35.58 M). Pero eso **es la politica del negocio** — mayoreo vende mas
 *     barato que mostrador a proposito — asi que el spread por si mismo no acusa nada.
 *   · El unico defecto inequivoco seria la **inversion** (mayoreo mas caro que tienda, mismo
 *     almacen, mismo SKU, mismo peldano): son **60 celdas y $11,574**. Demasiado chico para
 *     justificar una accion propia en el triage.
 *   · ⛔ Y aparecio deuda de datos que NO es de precio: **158 celdas con $3.47 M** declaran un
 *     spread de precio entre canales con **mediana de 847 %**. Eso no es un precio distinto, es
 *     el peldano mezclado dentro de un mismo `unit_kind` (ADR-057). Queda anotado aca porque se
 *     encontro aca, pero se arregla en la unidad, no en el precio.
 *
 * ── ⭐ La leccion que vale mas que la senal ────────────────────────────────────────────────
 * **Agregar variables de MARGEN al motor no sirve mientras el costo del 84.8 % de la venta sea
 * algebraico.** Cualquier senal nueva que divida margen va a medir la tabla de markup. Lo que
 * se puede construir hoy sobre dato observado es lo que NO toca el costo: el precio, el plazo
 * de cobro, el impuesto. El arreglo de fondo es persistir el peldano cobrado y leer el costo
 * del renglon real (`kdm2.c62`/`c63`, presente en el 99.1 % de `U-D-10`/`U-D-6`).
 *
 * ── Forma ─────────────────────────────────────────────────────────────────────────────────
 * ⚠️ `familia` tiene CHECK cerrado a 7 valores y **`canal` no es uno**. Va en `cliente`, que es
 * donde vive la segmentacion (C1 es "segmento / grupo par"): el canal ES una segmentacion del
 * comprador. No se afloja el CHECK por una fila.
 * ⚠️ `estado='refutada'` obliga `cobertura_pct = 0` (`psr_inexistente_sin_cobertura`) y eso a su
 * vez obliga `peso_max = 0` (`psr_peso_no_excede_cobertura`, la regla de oro). Correcto: lo
 * refutado no pesa.
 *
 * Idempotente: `ON CONFLICT (clave) DO UPDATE`.
 */

const T = 'analytics.price_signal_registry';
const CLAVE = 'H1';

const MOTIVO = [
  'medido 2026-10-01 CON CONTROL NEGATIVO, y refutado:',
  'en los 3 canales de Kepler (tienda+mayoreo+credito = 84.8% de la venta 90d), el 100.0% de las',
  '3,259 celdas donde el precio difiere >5% entre almacenes tiene spread de margen <0.01 pp: el',
  'margen esta CONGELADO por construccion porque sales_daily.cost del lado Kepler sale de',
  'revenue/(1+markup_pct), algebra ciega al precio (enmienda ADR-051).',
  'EL CONTROL: wincaja_ruta, cuyo costo es el ValorCosto real del POS, da 0.0% congelado -- ahi el',
  'margen SI se mueve con el precio. Sin ese contraste el 100.0% se leeria como "precios alineados".',
  'El espejismo que esto desarma: la dispersion de margen entre canales daba 0.59 pp contra un',
  'placebo de 0.15 pp (4x el ruido) y $846,040 de margen en juego en 90d sobre 1,821 celdas, que es',
  '2.7x la accion mas grande del motor. Ese dinero es el METODO DE COSTEO, no el canal.',
  'Lo que si quedo en pie: el spread de PRECIO por canal es real y observado (86.2% de la venta,',
  'mediana 8%), pero es la politica del negocio (mayoreo < mostrador); su unico defecto inequivoco',
  'es la inversion mayoreo>tienda, que vale 60 celdas y $11,574 -- demasiado chico para una accion.',
  'Deuda de datos encontrada de paso: 158 celdas / $3.47M declaran spread de precio con mediana de',
  '847%, que es peldano mezclado dentro de un mismo unit_kind (ADR-057), no precio.',
  'NO RECONSTRUIR sobre el margen hasta que el costo de Kepler deje de ser algebraico.',
].join(' ');

const FILA = {
  clave: CLAVE,
  familia: 'cliente',
  nombre: 'Margen por canal',
  definicion:
    'Diferencia de margen de la misma celda (almacen, SKU) entre los canales por los que se vende '
    + '(tienda, mayoreo, credito, wincaja_mostrador, wincaja_credito, wincaja_ruta). El 84.2% de la '
    + 'venta pasa por celdas con dos canales o mas.',
  unidad: 'pct',
  direccion: 'ninguna',
  estado: 'refutada',
  cobertura_pct: 0,
  cobertura_medida_al: '2026-10-01',
  fuente_objeto: 'analytics.sales_daily',
  fuente_columna: 'channel',
  motivo_ausencia: MOTIVO,
  peso_max: 0,
  nucleo: false,
};

exports.up = async function up(knex) {
  await knex.raw("SET LOCAL lock_timeout = '5s'");

  const [{ hay }] = (await knex.raw(`SELECT to_regclass('${T}') IS NOT NULL AS hay`)).rows;
  if (!hay) throw new Error('[PR.S3] falta analytics.price_signal_registry');

  await knex(T)
    .insert({ ...FILA, updated_at: knex.fn.now() })
    .onConflict('clave')
    .merge(['familia', 'nombre', 'definicion', 'unidad', 'direccion', 'estado',
      'cobertura_pct', 'cobertura_medida_al', 'fuente_objeto', 'fuente_columna',
      'motivo_ausencia', 'peso_max', 'nucleo', 'updated_at']);

  // ⭐ Se verifica lo que se acaba de escribir: una migracion que no comprueba su efecto es una
  //   intencion. Si algun CHECK hubiera dejado pasar algo incoherente, se entera aca y no en el
  //   primer consumidor.
  const [fila] = await knex(T).select('estado', 'cobertura_pct', 'peso_max', 'familia')
    .where({ clave: CLAVE });
  if (!fila) throw new Error('[PR.S3] H1 no quedo escrita');
  if (fila.estado !== 'refutada') throw new Error(`[PR.S3] H1 quedo en estado ${fila.estado}`);
  if (Number(fila.cobertura_pct) !== 0 || Number(fila.peso_max) !== 0) {
    throw new Error('[PR.S3] lo refutado no puede tener cobertura ni peso');
  }

  const [{ n }] = (await knex.raw(
    `SELECT count(*)::int AS n FROM ${T} WHERE estado = 'refutada'`)).rows;
  // eslint-disable-next-line no-console
  console.log(`[PR.S3] H1 registrada como refutada. Senales refutadas con medicion: ${n}.`);
};

exports.down = async function down(knex) {
  await knex.raw("SET LOCAL lock_timeout = '5s'");
  await knex(T).where({ clave: CLAVE }).del();
};
