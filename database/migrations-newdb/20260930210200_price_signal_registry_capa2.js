'use strict';
/**
 * `[PR.S1.2]` — **El registro cierra la capa 2: cero senales en `disponible`, y la cobertura
 * deja de escribirse a mano.**
 *
 * ── ⭐⭐ Lo primero, porque cambia numeros ya publicados ───────────────────────────────────
 * El registro nacio con la cobertura **tecleada por familia**. Esta migracion la **mide por
 * SENAL**, contra la columna que cada una declara, y cuatro de las dieciseis estaban infladas:
 *
 *   · **B6 rotacion ........ 100 %  →  23.2 %**  ⛔ `unidades_30d` es NULL donde no hubo venta
 *     en 30 dias, o sea en **tres de cada cuatro celdas**. Con 100 % declarado, la regla de oro
 *     habria dejado pesar la rotacion en **1.0** sobre un dato que casi nunca esta.
 *   · **A3 antiguedad del costo .. 38.2 %  →  17.7 %** -- la familia del costo cubre 38.2 %,
 *     pero la FECHA de la ultima compra, que es la senal, existe en menos de la mitad de eso.
 *   · **A9 dias regalados ......... 6.0 %  →   1.1 %** -- la cascada ve el 6 % de las celdas,
 *     pero restar pagado menos pactado exige las dos y solo el 1.1 % las tiene.
 *   · **D2 digito izquierdo ...... 100 %  →  90.5 %**
 *
 * ⭐ La coberturta de una FAMILIA es la de su ancla; cada senal puede tener menos. Declarar la
 * de la familia para todas es prometer evidencia que esa senal no tiene -- y como el techo del
 * peso sale de ahi, el error no se queda en la documentacion: llega al motor.
 *
 * ⭐⭐ Por eso, de aca en adelante **la migracion NO recibe la cobertura: la calcula** contra
 * `analytics.v_price_signals`. Un numero tecleado envejece en silencio; uno derivado de la
 * columna que la senal apunta no puede mentir sin que la columna cambie.
 *
 * ── El estado nuevo: `refutada` ───────────────────────────────────────────────────────────
 * Faltaba una diferencia que importa: **"todavia no se construyo"** no es lo mismo que **"se
 * midio y no aporta"**. Las dos vivian en `no_existe` o en `disponible`, y las dos mandan a la
 * proxima persona a caminar un camino distinto.
 *
 *   · **A5 escalera del proveedor** -- pasa de `disponible` a `refutada`. Medido contra un
 *     testigo independiente (el factor capturado en `kdii`, no la vista contra si misma): en
 *     **6,407 de 6,511 SKUs (98.4 %)** la razon de costos entre peldanos es **exactamente** el
 *     factor de unidades (razon media **0.99999**). El costo por unidad base es identico en
 *     todos los peldanos: **no hay descuento por volumen que leer**. Los 96 que "si traen
 *     descuento" dan razon media 0.072, que es una escalera **corrida**, no un descuento.
 *   · **F1 precio de competencia** -- ya decia "REFUTADO con medicion" dentro de un motivo de
 *     `no_existe`. El concepto existia y estaba metido en la gaveta equivocada.
 *
 * ⛔ Una senal refutada lleva **cobertura 0 y peso 0** aunque su fuente este poblada: lo que no
 * aporta informacion no puede pesar, por muchas filas que tenga.
 *
 * ── ⭐ La compuerta que define "capa 2 completa" ──────────────────────────────────────────
 * **Cero senales en `disponible`.** Una fuente que existe, esta poblada y nadie lee es la peor
 * de las tres: el motor decide sin ella creyendo que no hay mas. Al terminar esta capa, cada
 * fuente que existe o se lee, o se midio y se cerro con su numero escrito.
 *
 * @param { import("knex").Knex } knex
 */

const T = 'analytics.price_signal_registry';
const V = 'analytics.v_price_signals';

/**
 * ⭐ Cada senal declara QUE columna la lleva y con QUE expresion se mide su cobertura.
 * Casi siempre es "su columna no es NULL". Las tres excepciones estan marcadas, porque su
 * columna nunca es NULL por construccion y contar no-nulos daria 100 % falso.
 */
const CABLEADAS = [
  // ── ya cableadas: se RE-MIDEN, no se dan por buenas ──
  ['A1', 'a1_costo_hoy', 'a1_costo_hoy IS NOT NULL'],
  ['A2', 'a2_costo_ficha', 'a2_costo_ficha IS NOT NULL'],
  ['A3', 'a3_dias_sin_comprar', 'a3_dias_sin_comprar IS NOT NULL'],
  ['A6', 'a6_deriva_costo_pct', 'a6_deriva_costo_pct IS NOT NULL'],
  ['A9', 'a9_dias_exceso', 'a9_dias_exceso IS NOT NULL'],
  ['B6', 'unidades_30d', 'unidades_30d IS NOT NULL'],
  ['C2', 'c2_fuga_pct', 'c2_fuga_pct IS NOT NULL'],
  ['C3', 'c3_clientes', 'c3_clientes IS NOT NULL'],
  ['C4', 'c4_vendedores', 'c4_vendedores IS NOT NULL'],
  ['C5', 'c5_precio_cobrado_mediano', 'c5_precio_cobrado_mediano IS NOT NULL'],
  ['C6', 'c2_rango_precio_pct', 'c2_rango_precio_pct IS NOT NULL'],
  ['D1', 'd1_terminacion', 'd1_terminacion IS NOT NULL'],
  ['D2', 'd2_falta_decena', 'd2_falta_decena IS NOT NULL'],
  ['D3', 'd3_pegado_decena', 'd3_pegado_decena IS NOT NULL'],
  ['D4', 'd4_umbral_percepcion', 'd4_umbral_percepcion IS NOT NULL'],
  ['G3', 'm1_meta_margen', 'm1_meta_margen IS NOT NULL'],

  // ── las 12 que esta capa cablea ──
  ['A10', 'a10_no_explicado', `f9_cobertura <> 'sin_dato'`],
  ['B3', 'b3_z_estacional', 'b3_z_estacional IS NOT NULL'],
  ['B5', 'b5_iad', 'b5_iad IS NOT NULL'],
  ['B10', 'b10_lift_max', 'b10_lift_max IS NOT NULL'],
  ['D5', 'd5_cambios_90d', 'd5_cambios_90d IS NOT NULL'],
  ['D6', 'd6_dias_sin_cambio', 'd6_dias_sin_cambio IS NOT NULL'],
  // ⚠️ NULL donde el producto no tiene caja. Eso NO es falta de evidencia -- pero tampoco es
  //    una senal que el motor pueda usar: "es coherente la escalera?" no aplica sin escalera.
  //    La cobertura honesta es donde la pregunta tiene respuesta, no donde tiene veredicto.
  ['D8', 'd8_prima_caja_pct', 'd8_prima_caja_pct IS NOT NULL'],
  ['E1', 'e1_dias_cobertura', 'e1_dias_cobertura IS NOT NULL'],
  ['E3', 'e3_estado_inventario', 'e3_estado_inventario IS NOT NULL'],
  // ⛔⛔ LA UNICA EXCEPCION a "cobertura = su columna no es NULL", y va escrita porque el
  //    candado la nombra: `e4_reportes_faltante` viene con COALESCE(...,0), o sea que NUNCA es
  //    NULL, y contar no-nulos daria 100 % sobre siete plazas donde nadie ha reportado jamas.
  //    Su cobertura real es "en cuantas plazas alguien mira", que es lo que f12_cobertura dice.
  ['E4', 'e4_reportes_faltante', `f12_cobertura <> 'sin_dato'`],
  ['G2', 'g2_clase_abc', 'g2_clase_abc IS NOT NULL'],
  // g5_promo_vigente es booleano y nunca es NULL, y eso esta BIEN: el catalogo de reglas se lee
  // entero, asi que "no hay promo" es un hecho conocido. Cobertura 100 % de verdad.
  ['G5', 'g5_promo_vigente', 'g5_promo_vigente IS NOT NULL'],
];

const REFUTADAS = [
  ['A5', 'medido 2026-09-30 contra un testigo independiente (el factor de unidades capturado en '
    + 'kdii, NO la vista contra si misma): en 6,407 de 6,511 SKUs (98.4%) la razon de costos '
    + 'entre peldanos es EXACTAMENTE el factor de unidades, razon media 0.99999, o sea que el '
    + 'costo por unidad base es identico en todos los peldanos y no hay descuento por volumen '
    + 'que leer. Los 96 que aparentan descuento dan razon media 0.072: escalera corrida, no '
    + 'descuento. Cablearla publicaria una constante disfrazada de senal.'],
  ['F1', 'medido: el catalogo publico de PROFECO cubre 0% de nuestro catalogo. No existe fuente '
    + 'de precio de competencia, y la via real es F2 (el precio contra el que se perdio una '
    + 'cotizacion), que hay que capturar.'],
];

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);

  const [{ hay }] = (await knex.raw(`SELECT to_regclass('${V}') IS NOT NULL AS hay`)).rows;
  if (!hay) throw new Error('[PR.S1.2] falta analytics.v_price_signals ([PR.S2.3])');

  // ── 1 · El estado nuevo ─────────────────────────────────────────────────────────────
  await knex.raw(`ALTER TABLE ${T} DROP CONSTRAINT IF EXISTS psr_estado_valido`);
  await knex.raw(`ALTER TABLE ${T} ADD CONSTRAINT psr_estado_valido
    CHECK (estado IN ('cableada','disponible','refutada','no_existe'))`);

  // ⛔ Lo refutado no puede pesar: se midio y no aporta, por mas filas que tenga su fuente.
  await knex.raw(`ALTER TABLE ${T} DROP CONSTRAINT IF EXISTS psr_inexistente_sin_cobertura`);
  await knex.raw(`ALTER TABLE ${T} ADD CONSTRAINT psr_inexistente_sin_cobertura
    CHECK (estado NOT IN ('no_existe','refutada') OR cobertura_pct = 0)`);

  // ── 2 · ⭐ La cobertura se MIDE, no se teclea ───────────────────────────────────────
  const sel = CABLEADAS.map(([k, , expr]) =>
    `round((100.0 * count(*) FILTER (WHERE ${expr}) / count(*))::numeric, 1) AS "${k}"`).join(', ');
  const [med] = (await knex.raw(`SELECT ${sel} FROM ${V}`)).rows;

  const previo = Object.fromEntries((await knex(T).select('clave', 'cobertura_pct', 'estado'))
    .map((r) => [r.clave, r]));

  const HOY = new Date().toISOString().slice(0, 10);
  const movidas = [];
  let nuevas = 0;

  for (const [clave, columna, expr] of CABLEADAS) {
    const cob = Number(med[clave]);
    if (!Number.isFinite(cob)) throw new Error(`[PR.S1.2] no se pudo medir ${clave} (${expr})`);
    const antes = previo[clave];
    if (antes && antes.estado === 'cableada' && Math.abs(Number(antes.cobertura_pct) - cob) >= 0.15) {
      movidas.push(`${clave} ${Number(antes.cobertura_pct).toFixed(1)}% -> ${cob.toFixed(1)}%`);
    }
    if (antes && antes.estado !== 'cableada') nuevas += 1;

    await knex(T).where({ clave }).update({
      estado: 'cableada',
      cobertura_pct: cob,
      cobertura_medida_al: HOY,
      fuente_objeto: V,
      fuente_columna: columna,
      motivo_ausencia: null,
      // El techo arranca en la cobertura medida. La capa logica lo baja, nunca lo sube.
      peso_max: cob / 100,
      updated_at: knex.fn.now(),
    });
  }

  // ── 3 · Lo medido y cerrado ────────────────────────────────────────────────────────
  for (const [clave, motivo] of REFUTADAS) {
    await knex(T).where({ clave }).update({
      estado: 'refutada',
      cobertura_pct: 0,
      cobertura_medida_al: null,
      fuente_objeto: null,
      fuente_columna: null,
      motivo_ausencia: motivo,
      peso_max: 0,
      updated_at: knex.fn.now(),
    });
  }

  await knex.raw(`COMMENT ON TABLE ${T} IS
    $c$[PR.S1/S1.2] Capa 1 del motor de margen: el REGISTRO de las 46 senales, EJECUTABLE.
    ⭐⭐ La cobertura NO se teclea: la migracion la MIDE contra analytics.v_price_signals, por
    SENAL y no por familia. Se escribia por familia y cuatro de dieciseis estaban infladas -- la
    peor, rotacion al 100% cuando es 23.2%, que con la regla de oro habria dejado pesarla en 1.0
    sobre un dato ausente en tres de cada cuatro celdas. La cobertura de una familia es la de su
    ancla; cada senal puede tener menos, y como el techo del peso sale de ahi el error llega al
    motor, no se queda en la documentacion.
    ⭐⭐ La regla de oro: peso_max <= cobertura_pct/100. Sin ella el motor promediaria la fuga
    -6% de las celdas, 33% de la venta- con la terminacion -100%- y decidiria el precio del
    mostrador con evidencia que no lo incluye.
    Cuatro estados: cableada (el motor la lee) · disponible (la fuente existe y NADIE la lee: es
    el peor, porque el motor decide sin ella creyendo que no hay mas) · refutada (se midio y NO
    aporta; lleva cobertura 0 y peso 0 aunque su fuente este poblada) · no_existe (hay que
    construirla, con su motivo escrito). La capa 2 esta completa cuando disponible es CERO.$c$`);

  // ── 4 · Compuertas ─────────────────────────────────────────────────────────────────
  const [g] = (await knex.raw(`
    WITH r AS (SELECT * FROM ${T}),
    reales AS (
      SELECT a.attname FROM pg_attribute a
       WHERE a.attrelid = '${V}'::regclass AND a.attnum > 0 AND NOT a.attisdropped
    )
    SELECT (SELECT count(*)::int FROM r) AS total,
           (SELECT count(*)::int FROM r WHERE estado = 'cableada')   AS cableadas,
           (SELECT count(*)::int FROM r WHERE estado = 'disponible') AS disponibles,
           (SELECT count(*)::int FROM r WHERE estado = 'refutada')   AS refutadas,
           (SELECT count(*)::int FROM r WHERE estado = 'no_existe')  AS inexistentes,
           (SELECT count(*)::int FROM r WHERE nucleo)                AS nucleo,
           (SELECT count(*)::int FROM r
             WHERE estado = 'cableada'
               AND fuente_columna NOT IN (SELECT attname FROM reales)) AS mentirosas,
           (SELECT round(sum(peso_max), 2) FROM r) AS techo_total`)).rows;

  // eslint-disable-next-line no-console
  console.log(`  · [PR.S1.2] ${g.total} senales · cableadas ${g.cableadas} · `
    + `⭐ disponibles ${g.disponibles} · refutadas ${g.refutadas} · no existen ${g.inexistentes} `
    + `· nucleo ${g.nucleo} · techo de peso total ${g.techo_total}`);
  if (movidas.length) {
    // eslint-disable-next-line no-console
    console.log(`  · [PR.S1.2] ⚠️ coberturas CORREGIDAS al medirlas: ${movidas.join(' · ')}`);
  }
  // eslint-disable-next-line no-console
  console.log(`  · [PR.S1.2] senales que pasaron a cableada en esta capa: ${nuevas}`);

  if (g.mentirosas > 0) {
    throw new Error(`[PR.S1.2] ${g.mentirosas} senales declaradas CABLEADAS cuya columna no `
      + 'existe en la vista.');
  }
  /**
   * ⭐⭐ ESTA es la compuerta que define "capa 2 completa": ninguna fuente que existe puede
   *     quedarse sin leer y sin explicacion. O se cablea, o se mide y se cierra.
   */
  if (g.disponibles > 0) {
    throw new Error(`[PR.S1.2] quedan ${g.disponibles} senales en 'disponible': su fuente existe `
      + 'y nadie la lee. La capa 2 no esta completa.');
  }
  if (g.cableadas !== CABLEADAS.length) {
    throw new Error(`[PR.S1.2] ${g.cableadas} cableadas y se declararon ${CABLEADAS.length}.`);
  }
  if (g.refutadas !== REFUTADAS.length) {
    throw new Error(`[PR.S1.2] ${g.refutadas} refutadas y se declararon ${REFUTADAS.length}.`);
  }
  if (g.total !== 46) {
    throw new Error(`[PR.S1.2] el registro tiene ${g.total} senales y el conteo declarado es 46.`);
  }
};

exports.down = async function down(knex) {
  // No se revierte a coberturas tecleadas. Solo se afloja el estado nuevo.
  await knex.raw(`ALTER TABLE ${T} DROP CONSTRAINT IF EXISTS psr_estado_valido`);
  await knex.raw(`ALTER TABLE ${T} ADD CONSTRAINT psr_estado_valido
    CHECK (estado IN ('cableada','disponible','no_existe'))`);
};
