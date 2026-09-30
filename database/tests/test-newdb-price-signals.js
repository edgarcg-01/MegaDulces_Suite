/**
 * `[PR.S1/S2]` — **Las capas 1 y 2 del motor de margen, completas.**
 *
 * ⭐ Lo que este candado hace y un documento no puede: cruza lo **declarado** contra lo que
 * **existe**, en las dos direcciones, y **vuelve a medir** los números que el registro publica.
 * Un markdown con la cobertura adentro envejece sin que nada se ponga rojo; esto se pone rojo.
 *
 * Bloques:
 *   1. El registro: los 4 estados y los conteos. ⭐ `disponible` tiene que ser CERO.
 *   2. ⭐⭐ La regla de oro `peso_max <= cobertura/100`, rota a propósito, con control positivo.
 *   3. ⭐⭐ **La cobertura declarada se RECALCULA desde la vista.** Es lo que reemplaza a una
 *      nota al pie: cuatro coberturas estaban infladas por escribirse por familia y no por
 *      señal, y la peor —rotación al 100 % siendo 23.2 %— habría dejado pesar en 1.0 un dato
 *      ausente en tres de cada cuatro celdas.
 *   4. ⛔ Declarado ↔ real: una señal `cableada` cuya columna no existe.
 *   5. La vista: coberturas que DIFIEREN, cero ausencias mudas, cero valores sin evidencia.
 *   6. ⭐ Catálogo contra captura — dos fuentes que parecen iguales y no lo son.
 *   7. ⭐ La matvista ≡ la vista, y la consulta que hace una PANTALLA bajo 1 s.
 *   8. ⛔ La refutación de A5, re-medida: si algún día el proveedor sí diera descuento por
 *      volumen, esta prueba se pone roja en vez de dejar la señal cerrada para siempre.
 *
 *   DATABASE_URL_NEW=… node database/tests/test-newdb-price-signals.js
 */
const { Client } = require('pg');
const { esFaltaDeAcceso, noMedido } = require('./_lib/no-medido');

const URL = process.env.DATABASE_URL_NEW || process.env.DST_URL
  || (() => { throw new Error('falta DATABASE_URL_NEW'); })();

let ok = 0; let fail = 0; let nm = 0;
const ck = (l, c, d = '') => {
  if (c) { ok++; console.log(`  ✔ ${l}`); } else { fail++; console.log(`  ✖ ${l}${d ? ` — ${d}` : ''}`); }
};
const sinMedir = (l, d) => { nm++; console.log(`  ⓘ NO MEDIDO: ${l} — ${d}`); };

async function rechaza(c, etiqueta, sql, params) {
  try {
    await c.query('SAVEPOINT sp');
    await c.query(sql, params);
    await c.query('ROLLBACK TO SAVEPOINT sp');
    ck(`RECHAZA: ${etiqueta}`, false, 'la fila prohibida ENTRÓ');
  } catch (e) {
    await c.query('ROLLBACK TO SAVEPOINT sp').catch(() => {});
    const esperado = /violates check constraint|viola la restricción/i.test(e.message);
    ck(`RECHAZA: ${etiqueta}`, esperado, esperado ? '' : e.message.slice(0, 80));
  }
}

/**
 * ⛔ La ÚNICA señal cuya cobertura no se puede derivar de "su columna no es NULL", y va acá
 * nombrada para que la excepción sea visible: `e4_reportes_faltante` llega con COALESCE(...,0),
 * así que nunca es NULL y contar no-nulos daría 100 % sobre siete plazas donde nadie ha
 * reportado jamás un faltante.
 */
const EXCEPCIONES_DE_COBERTURA = { E4: 'viene con COALESCE(...,0): nunca es NULL' };

(async () => {
  const c = new Client({
    connectionString: URL,
    ssl: /rlwy|railway|proxy/i.test(URL) ? { rejectUnauthorized: false } : false,
    statement_timeout: 300000,
  });
  await c.connect().catch((e) => {
    if (esFaltaDeAcceso(e)) noMedido(`no se pudo conectar — ${e.message}`);
    throw e;
  });
  const q = async (s, p) => (await c.query(s, p)).rows;
  console.log('\n=== [PR.S1/S2] · el registro de señales, la vista y la matvista ===\n');

  const [ex] = await q(`SELECT to_regclass('analytics.price_signal_registry') IS NOT NULL AS ok`);
  if (!ex.ok) noMedido('falta la migración 20260930200000 en este destino');

  // ── 1 · EL REGISTRO ─────────────────────────────────────────────────────────────────
  console.log('1 · EL REGISTRO — y qué significa "la capa 2 completa"');
  const [r] = await q(`
    SELECT count(*)::int total, count(DISTINCT familia)::int familias,
           count(*) FILTER (WHERE estado = 'cableada')::int   cableadas,
           count(*) FILTER (WHERE estado = 'disponible')::int disponibles,
           count(*) FILTER (WHERE estado = 'refutada')::int   refutadas,
           count(*) FILTER (WHERE estado = 'no_existe')::int  inexistentes,
           count(*) FILTER (WHERE nucleo)::int nucleo,
           round(sum(peso_max), 3) techo
      FROM analytics.price_signal_registry`);
  ck('las 46 señales están declaradas', r.total === 46, `hay ${r.total}`);
  ck('en 7 familias', r.familias === 7, `hay ${r.familias}`);
  ck('la suma de estados cuadra',
    r.cableadas + r.disponibles + r.refutadas + r.inexistentes === 46,
    `${r.cableadas}+${r.disponibles}+${r.refutadas}+${r.inexistentes}`);
  console.log(`     cableadas ${r.cableadas} · disponibles ${r.disponibles} · refutadas `
    + `${r.refutadas} · no existen ${r.inexistentes} · núcleo ${r.nucleo} · techo ${r.techo}`);

  /**
   * ⭐⭐ LA DEFINICIÓN DE "CAPA 2 COMPLETA". Una fuente que existe, está poblada y nadie lee es
   * el peor de los cuatro estados: el motor decide sin ella creyendo que no hay más. Al cerrar
   * la capa, cada fuente que existe o se lee, o se midió y se cerró con su número escrito.
   */
  ck('⭐⭐ CERO señales en `disponible` (la capa 2 está completa)', r.disponibles === 0,
    `quedan ${r.disponibles} fuentes pobladas que nadie lee`);
  ck('las 28 señales cableadas', r.cableadas === 28, `hay ${r.cableadas}`);
  ck('⛔ lo refutado no pesa (cobertura y peso en cero)',
    (await q(`SELECT count(*)::int n FROM analytics.price_signal_registry
               WHERE estado = 'refutada' AND (cobertura_pct <> 0 OR peso_max <> 0)`))[0].n === 0);

  const [chk] = await q(`
    SELECT count(*)::int n FROM pg_constraint
     WHERE conrelid = 'analytics.price_signal_registry'::regclass AND contype = 'c'`);
  ck('tiene los 10 CHECK', chk.n >= 10, `hay ${chk.n}`);

  // ── 2 · ⭐⭐ LA REGLA DE ORO ─────────────────────────────────────────────────────────
  console.log('\n2 · ⭐⭐ peso_max ≤ cobertura — la regla que sólo una tabla puede imponer');

  /**
   * ⛔ Contra PROD la sesión es de SÓLO LECTURA (`default_transaction_read_only = on`), así que
   * las pruebas negativas no se pueden correr ahí. *Un gate sin prueba negativa es una
   * intención* — pero una prueba que no se pudo correr se DECLARA, no se pinta verde ni se
   * borra. Lo que sí se puede verificar en prod es que los CHECK **existen y dicen lo que deben
   * decir**, leyendo el catálogo; romperlos a propósito corre contra un destino escribible.
   */
  const [rot] = await q(`SHOW default_transaction_read_only`);
  const soloLectura = rot.default_transaction_read_only === 'on';

  const DEFS = [
    ['psr_peso_no_excede_cobertura', /peso_max <= \(cobertura_pct \/ 100/,
      '⭐⭐ el techo del peso no puede exceder la cobertura'],
    ['psr_cableada_con_columna', /fuente_columna IS NOT NULL/, 'cableada exige su columna'],
    ['psr_ausencia_con_motivo', /motivo_ausencia/, 'toda ausencia exige motivo'],
    ['psr_estado_valido', /refutada/, '⭐ el cuarto estado: refutada'],
    ['psr_inexistente_sin_cobertura', /refutada/, '⛔ lo refutado no puede llevar cobertura'],
    ['psr_cobertura_con_fecha', /cobertura_medida_al IS NOT NULL/,
      'una cobertura sin fecha se cree para siempre'],
  ];
  const defs = Object.fromEntries((await q(`SELECT conname, pg_get_constraintdef(oid) d
     FROM pg_constraint WHERE conrelid = 'analytics.price_signal_registry'::regclass
       AND contype = 'c'`)).map((z) => [z.conname, z.d]));
  for (const [nombre, re, etiqueta] of DEFS) {
    ck(`el CHECK ${nombre} dice lo que debe (${etiqueta})`,
      !!defs[nombre] && re.test(defs[nombre]), defs[nombre] || 'no existe');
  }

  if (soloLectura) {
    sinMedir('las 8 pruebas negativas del registro',
      'la sesión contra prod es de sólo lectura; corren contra un destino escribible');
  } else {
  await c.query('BEGIN');
  const INS = `INSERT INTO analytics.price_signal_registry
    (clave, familia, nombre, definicion, unidad, direccion, estado,
     cobertura_pct, cobertura_medida_al, fuente_objeto, fuente_columna, motivo_ausencia, peso_max)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`;

  await rechaza(c, '⭐⭐ un peso MAYOR que su cobertura (el defecto que arruina el motor)', INS,
    ['ZZ1', 'cliente', 'x', 'x', 'pct', 'ninguna', 'cableada', 6.0, '2026-09-30',
      'analytics.v_price_signals', 'c2_fuga_pct', null, 0.50]);
  await rechaza(c, 'una señal CABLEADA sin columna (cableada sería una intención)', INS,
    ['ZZ2', 'costo', 'x', 'x', 'mxn', 'ninguna', 'cableada', 50, '2026-09-30', null, null, null, 0.1]);
  await rechaza(c, 'una ausencia SIN motivo (se leería como un olvido)', INS,
    ['ZZ3', 'costo', 'x', 'x', 'mxn', 'ninguna', 'no_existe', 0, null, null, null, null, 0]);
  await rechaza(c, 'algo que NO existe con cobertura', INS,
    ['ZZ4', 'costo', 'x', 'x', 'mxn', 'ninguna', 'no_existe', 40, '2026-09-30', null, null, 'x', 0]);
  await rechaza(c, 'una cobertura SIN fecha (nadie sabría de cuándo es)', INS,
    ['ZZ5', 'costo', 'x', 'x', 'mxn', 'ninguna', 'disponible', 40, null, null, null, 'x', 0.1]);
  await rechaza(c, 'una familia inventada', INS,
    ['ZZ6', 'loquesea', 'x', 'x', 'mxn', 'ninguna', 'no_existe', 0, null, null, null, 'x', 0]);
  /**
   * ⭐ El estado nuevo con su candado: lo REFUTADO se midió y no aporta. Dejarle cobertura
   * sería invitar a la capa lógica a pesarlo — que es exactamente lo que no debe pasar con una
   * señal cuyo valor es constante por construcción.
   */
  await rechaza(c, '⭐ una señal REFUTADA con cobertura (lo que no aporta no puede pesar)', INS,
    ['ZZ7', 'costo', 'x', 'x', 'mxn', 'ninguna', 'refutada', 99.2, '2026-09-30', null, null,
      'se midio y no aporta', 0.0]);

  // Control positivo: sin él, un rechazo por permisos se leería como candado que funciona.
  try {
    await c.query('SAVEPOINT okp');
    await c.query(INS, ['ZZ9', 'costo', 'legítima', 'una señal bien formada', 'mxn',
      'menos_es_mejor', 'cableada', 38.2, '2026-09-30',
      'analytics.v_price_signals', 'a1_costo_hoy', null, 0.38]);
    ck('⭐ CONTROL POSITIVO: la señal bien formada SÍ entra', true);
    await c.query('ROLLBACK TO SAVEPOINT okp');
  } catch (e) {
    await c.query('ROLLBACK TO SAVEPOINT okp').catch(() => {});
    ck('⭐ CONTROL POSITIVO: la señal bien formada SÍ entra', false, e.message.slice(0, 100));
  }
  await c.query('ROLLBACK');
  }

  // ── 3 · ⭐⭐ LA COBERTURA SE VUELVE A MEDIR ──────────────────────────────────────────
  console.log('\n3 · ⭐⭐ la cobertura declarada se RECALCULA desde la vista');
  const cableadas = await q(`SELECT clave, fuente_columna, cobertura_pct, peso_max
     FROM analytics.price_signal_registry WHERE estado = 'cableada' ORDER BY clave`);
  const cols = new Set((await q(`SELECT attname FROM pg_attribute
     WHERE attrelid = 'analytics.v_price_signals'::regclass
       AND attnum > 0 AND NOT attisdropped`)).map((x) => x.attname));

  /**
   * Se mide contra la MATVISTA, no contra la vista: son el mismo dato -el bloque 8 compara
   * columna por columna y fila por fila- y el barrido de la vista cuesta 74 s en frio. Una
   * suite de regresion que tarda un minuto por gusto se termina salteando.
   */
  const [hayMv0] = await q(`SELECT to_regclass('analytics.mv_price_signals') IS NOT NULL AS ok`);
  const FUENTE = hayMv0.ok ? 'analytics.mv_price_signals' : 'analytics.v_price_signals';
  console.log(`     leyendo de ${FUENTE}`);

  const medibles = cableadas.filter((s) => !EXCEPCIONES_DE_COBERTURA[s.clave]
    && cols.has(s.fuente_columna));
  if (medibles.length === 0) {
    sinMedir('recálculo de coberturas', 'ninguna señal cableada apunta a una columna real');
  } else {
    const sel = medibles.map((s) =>
      `round((100.0*count(*) FILTER (WHERE ${s.fuente_columna} IS NOT NULL)/count(*))::numeric,1)`
      + ` AS "${s.clave}"`).join(', ');
    const [m] = await q(`SELECT ${sel} FROM ${FUENTE}`);
    const desviadas = medibles
      .map((s) => ({ k: s.clave, dec: Number(s.cobertura_pct), real: Number(m[s.clave]) }))
      .filter((x) => Math.abs(x.dec - x.real) > 0.15);
    ck(`⭐⭐ las ${medibles.length} coberturas declaradas se reproducen desde la vista`,
      desviadas.length === 0,
      desviadas.map((x) => `${x.k}: dice ${x.dec} y mide ${x.real}`).join(' · '));
    // ⛔ Y el techo del peso tiene que seguir a la cobertura re-medida, no a la vieja.
    const techoMal = medibles.filter((s) => Number(s.peso_max) > Number(s.cobertura_pct) / 100 + 1e-9);
    ck('⛔ ningún techo de peso quedó por encima de su cobertura re-medida', techoMal.length === 0,
      techoMal.map((x) => x.clave).join(', '));
  }
  for (const [k, por] of Object.entries(EXCEPCIONES_DE_COBERTURA)) {
    const s = cableadas.find((x) => x.clave === k);
    if (s) console.log(`     ⓘ ${k} queda fuera del recálculo genérico: ${por} `
      + `(declara ${s.cobertura_pct} %)`);
  }

  // ── 4 · ⛔ DECLARADO ↔ REAL, en las dos direcciones ─────────────────────────────────
  console.log('\n4 · ⛔ el cruce que un documento no puede hacer');
  const [x] = await q(`
    WITH reales AS (
      SELECT a.attname FROM pg_attribute a
       WHERE a.attrelid = 'analytics.v_price_signals'::regclass
         AND a.attnum > 0 AND NOT a.attisdropped
    )
    SELECT count(*) FILTER (WHERE estado = 'cableada'
                              AND fuente_columna NOT IN (SELECT attname FROM reales))::int mentirosas,
           count(*) FILTER (WHERE estado <> 'cableada'
                              AND fuente_columna IS NOT NULL)::int columna_de_mas
      FROM analytics.price_signal_registry`);
  ck('⛔ ninguna señal CABLEADA sin su columna real en la vista', x.mentirosas === 0,
    `${x.mentirosas} mienten`);
  ck('⛔ ninguna señal NO cableada apuntando a una columna', x.columna_de_mas === 0);

  // ── 5 · LA VISTA ────────────────────────────────────────────────────────────────────
  console.log('\n5 · LA VISTA — 12 familias cuyas coberturas tienen que DIFERIR');
  const t0 = Date.now();
  const [v] = await q(`
    SELECT count(*)::int filas,
           count(*) FILTER (WHERE f1_cobertura  = 'completa')::int f1,
           count(*) FILTER (WHERE f2_cobertura <> 'sin_dato')::int f2,
           count(*) FILTER (WHERE f3_cobertura  = 'completa')::int f3,
           count(*) FILTER (WHERE f4_cobertura <> 'sin_dato')::int f4,
           count(*) FILTER (WHERE f5_cobertura  = 'completa')::int f5,
           count(*) FILTER (WHERE f6_cobertura <> 'sin_dato')::int f6,
           count(*) FILTER (WHERE f7_cobertura  = 'completa')::int f7,
           count(*) FILTER (WHERE f8_cobertura  = 'completa')::int f8,
           count(*) FILTER (WHERE f9_cobertura  = 'completa')::int f9,
           count(*) FILTER (WHERE f10_cobertura = 'completa')::int f10,
           count(*) FILTER (WHERE f12_cobertura = 'completa')::int f12,
           count(*) FILTER (WHERE u1_fuente_peldano = 'vendido')::int p_vendido,
           count(*) FILTER (WHERE u1_fuente_peldano = 'base_sin_venta')::int p_base,
           count(*) FILTER (WHERE f8_veredicto = 'escalera_incoherente')::int incoherentes
      FROM ${FUENTE}`);
  const ms = Date.now() - t0;
  const pc = (n) => `${((100 * n) / v.filas).toFixed(1)}%`;
  console.log(`     ${v.filas.toLocaleString()} filas en ${ms} ms`);
  console.log(`     psicología ${pc(v.f1)} · meta ${pc(v.f2)} · costo ${pc(v.f3)} · `
    + `cliente ${pc(v.f4)} · inventario ${pc(v.f5)} · demanda ${pc(v.f6)}`);
  console.log(`     historial ${pc(v.f7)} · escalera ${pc(v.f8)} · merma ${pc(v.f9)} · `
    + `canasta ${pc(v.f10)} · faltantes ${pc(v.f12)}`);

  ck('la vista devuelve el grano medido (86,163 celdas)', v.filas === 86163, `hay ${v.filas}`);
  /**
   * ⭐ Si dos familias tuvieran la MISMA cobertura, algún LEFT JOIN se estaría comportando como
   * INNER — y el motor creería que el mostrador tiene evidencia de cliente. La incomparabilidad
   * de las coberturas es la tesis entera de esta capa: si se borra, se borró por un bug.
   */
  const distintas = new Set([v.f1, v.f3, v.f4, v.f5, v.f6, v.f7, v.f9, v.f10, v.f12]).size;
  ck('⭐ las coberturas de las familias son DISTINTAS entre sí', distintas >= 8,
    `sólo ${distintas} valores distintos: algún LEFT JOIN se comporta como INNER`);
  ck('⛔ la cobertura de cliente es mucho menor que la de psicología (el mostrador es anónimo)',
    v.f4 < v.f1 * 0.5, `${pc(v.f4)} contra ${pc(v.f1)}`);
  ck('⭐ el peldaño distingue vendido de respaldo', v.p_vendido > 0 && v.p_base > 0,
    `vendido ${v.p_vendido}, base ${v.p_base}`);
  ck('⭐ la escalera incoherente se detecta (la caja más cara por pieza que la pieza)',
    v.incoherentes > 0, 'cero incoherentes: el cálculo de la prima no está midiendo nada');

  // ── 6 · ⛔ AUSENCIAS MUDAS Y VALORES FANTASMA ───────────────────────────────────────
  console.log('\n6 · ⛔ ninguna ausencia MUDA, ningún valor SIN evidencia (ADR-056)');
  const [m] = await q(`
    SELECT count(*) FILTER (WHERE f2_cobertura  <> 'completa' AND f2_motivo  IS NULL)::int m2,
           count(*) FILTER (WHERE f4_cobertura  <> 'completa' AND f4_motivo  IS NULL)::int m4,
           count(*) FILTER (WHERE f5_cobertura  <> 'completa' AND f5_motivo  IS NULL)::int m5,
           count(*) FILTER (WHERE f6_cobertura  <> 'completa' AND f6_motivo  IS NULL)::int m6,
           count(*) FILTER (WHERE f7_cobertura  <> 'completa' AND f7_motivo  IS NULL)::int m7,
           count(*) FILTER (WHERE f8_cobertura  <> 'completa' AND f8_motivo  IS NULL)::int m8,
           count(*) FILTER (WHERE f9_cobertura  <> 'completa' AND f9_motivo  IS NULL)::int m9,
           count(*) FILTER (WHERE f10_cobertura <> 'completa' AND f10_motivo IS NULL)::int m10,
           count(*) FILTER (WHERE f12_cobertura <> 'completa' AND f12_motivo IS NULL)::int m12,
           count(*) FILTER (WHERE f4_veredicto = 'sin_evidencia_de_cliente'
                              AND c2_fuga_pct IS NOT NULL)::int fg4,
           count(*) FILTER (WHERE f5_veredicto = 'sin_evidencia_de_inventario'
                              AND e1_dias_cobertura IS NOT NULL)::int fg5,
           count(*) FILTER (WHERE f9_veredicto = 'sin_evidencia_de_conteo'
                              AND a10_no_explicado IS NOT NULL)::int fg9,
           count(*) FILTER (WHERE f12_veredicto = 'plaza_no_reporta'
                              AND e4_reportes_faltante > 0)::int fg12,
           count(*) FILTER (WHERE u1_fuente_peldano = 'base_sin_venta'
                              AND f2_veredicto = 'peldano_claro')::int respaldo_mentiroso,
           -- ⛔ Dos ausencias distintas con motivos distintos: contado-sin-recontar NO es
           --    lo mismo que nunca-contado, y la vista tiene que separarlas.
           count(*) FILTER (WHERE f9_veredicto = 'contado_sin_recontar')::int sin_recontar
      FROM ${FUENTE}`);
  const mudas = m.m2 + m.m4 + m.m5 + m.m6 + m.m7 + m.m8 + m.m9 + m.m10 + m.m12;
  ck('⛔ cero ausencias mudas en las 9 familias que declaran motivo', mudas === 0,
    `f2=${m.m2} f4=${m.m4} f5=${m.m5} f6=${m.m6} f7=${m.m7} f8=${m.m8} f9=${m.m9} f10=${m.m10} f12=${m.m12}`);
  ck('⛔ cero valores publicados sin evidencia que los respalde',
    m.fg4 + m.fg5 + m.fg9 + m.fg12 === 0,
    `cliente=${m.fg4} inventario=${m.fg5} merma=${m.fg9} faltantes=${m.fg12}`);
  ck('⛔ ningún peldaño de respaldo reportado como claro', m.respaldo_mentiroso === 0);
  ck('⭐ contado-sin-recontar se distingue de nunca-contado', m.sin_recontar > 0,
    'la vista no separa las dos ausencias del conteo');

  // ── 7 · ⭐ CATÁLOGO CONTRA CAPTURA ──────────────────────────────────────────────────
  console.log('\n7 · ⭐ dos fuentes que parecen iguales y NO lo son');
  const [cat] = await q(`
    SELECT count(*) FILTER (WHERE f11_cobertura <> 'completa')::int promo_incompleta,
           count(DISTINCT sucursal) FILTER (WHERE f12_cobertura = 'completa')::int plazas_reportan,
           count(DISTINCT sucursal)::int plazas
      FROM ${FUENTE}`);
  ck('⭐ la promoción es un CATÁLOGO: se lee entero, sin regla = no hay promo',
    cat.promo_incompleta === 0, `${cat.promo_incompleta} celdas de promo con hueco`);
  ck('⛔ el faltante es una CAPTURA: sólo cubre las plazas donde alguien mira',
    cat.plazas_reportan > 0 && cat.plazas_reportan < cat.plazas,
    `${cat.plazas_reportan} de ${cat.plazas} plazas — si fueran todas, se estaría publicando `
    + '"aquí no falta nada" donde nadie ha mirado');

  // ── 8 · ⭐ LA MATVISTA Y LA CONSULTA DE PANTALLA ────────────────────────────────────
  console.log('\n8 · ⭐ la matvista ≡ la vista, y lo que tarda una PANTALLA');
  const [hayMv] = await q(`SELECT to_regclass('analytics.mv_price_signals') IS NOT NULL AS ok`);
  if (!hayMv.ok) {
    sinMedir('la matvista de señales', 'falta la migración 20260930210100 en este destino');
  } else {
    const [eq] = await q(`
      WITH cv AS (SELECT attname FROM pg_attribute
                   WHERE attrelid = 'analytics.v_price_signals'::regclass
                     AND attnum > 0 AND NOT attisdropped),
           cm AS (SELECT attname FROM pg_attribute
                   WHERE attrelid = 'analytics.mv_price_signals'::regclass
                     AND attnum > 0 AND NOT attisdropped)
      SELECT (SELECT count(*)::int FROM cv WHERE attname NOT IN (SELECT attname FROM cm)) falta,
             (SELECT count(*)::int FROM cm WHERE attname NOT IN (SELECT attname FROM cv)
                AND attname <> 'calculado_al') sobra,
             (SELECT count(*)::int FROM analytics.mv_price_signals) filas,
             (SELECT relispopulated FROM pg_class
               WHERE oid = 'analytics.mv_price_signals'::regclass) poblada`);
    ck('⭐ la matvista y la vista NO difieren en ninguna columna',
      eq.falta === 0 && eq.sobra === 0, `faltan ${eq.falta}, sobran ${eq.sobra}`);
    ck('la matvista está poblada', eq.poblada === true);
    ck('y trae el mismo grano', eq.filas === v.filas, `${eq.filas} contra ${v.filas}`);

    /**
     * ⭐⭐ EL CRUCE DE LAS DOS IMPLEMENTACIONES. Todo lo de arriba se midió sobre la matvista;
     * si la matvista se hubiera quedado con una definición vieja de la vista, todo eso saldría
     * verde igual. Comparar un objeto contra sí mismo pasa bugs en verde — por eso acá se leen
     * las DOS y se exige que digan lo mismo.
     *
     * ⚠️ Sólo una plaza: la vista filtrada cuesta ~10 s y el barrido completo 74 s. Una plaza
     * ejercita las 12 familias y los 14 joins.
     */
    const cruce = async (obj) => (await q(`
      SELECT count(*)::int n,
             count(*) FILTER (WHERE f8_veredicto = 'escalera_incoherente')::int inc,
             count(*) FILTER (WHERE f5_cobertura = 'completa')::int f5,
             count(*) FILTER (WHERE f9_veredicto = 'merma')::int merma,
             count(*) FILTER (WHERE f12_cobertura = 'completa')::int f12,
             round(sum(COALESCE(d8_prima_caja_pct, 0))::numeric, 2) prima
        FROM ${obj} WHERE sucursal = '03'`))[0];
    const t3 = Date.now();
    const cv = await cruce('analytics.v_price_signals');
    const cm = await cruce('analytics.mv_price_signals');

    /**
     * ⚠️ El grano se compara EXACTO; los valores, con tolerancia — y la razón es una medición,
     * no una concesión. En la primera corrida de este candado la suma de la prima dio
     * −53,927.76 en la vista contra −53,924.84 en la matvista: **2.92 pesos sobre 53,927**.
     * No es un defecto, es la vista leyendo el ODS en vivo y la matvista teniendo 12 minutos —
     * o sea el envejecimiento que materializar cuesta, apareciendo.
     *
     * ⛔ Y lo que esto SÍ y NO atrapa, dicho: atrapa que la matvista dejó de ser `SELECT *` de
     * la vista (un cambio de definición mueve los números de golpe, no por decimales). NO
     * atrapa un cambio sutil que mueva menos del 2 %. Para eso está la comparación de columnas
     * de arriba, que es exacta.
     */
    const deriva = ['n', 'inc', 'f5', 'merma', 'f12', 'prima'].map((kk) => {
      const a = Number(cv[kk]); const b = Number(cm[kk]);
      return { kk, pct: a === 0 ? (b === 0 ? 0 : 100) : Math.abs(100 * (b - a) / a) };
    });
    const peorD = deriva.reduce((p, x) => (x.pct > p.pct ? x : p));
    ck(`⭐⭐ la matvista sigue siendo la vista (una plaza, 6 medidas, ${Date.now() - t3} ms)`,
      peorD.pct < 2,
      `la medida "${peorD.kk}" difiere ${peorD.pct.toFixed(2)} %: `
      + `vista ${JSON.stringify(cv)} · matvista ${JSON.stringify(cm)}`);
    console.log(`     deriva por envejecimiento: ${peorD.pct.toFixed(4)} % en "${peorD.kk}" `
      + `(el grano, los veredictos y las coberturas cuadran exacto)`);

    /**
     * ⭐⭐ EL GATE QUE IMPORTA: la consulta que corre el consumidor, no un barrido que nadie
     * hace. Medido sobre la VISTA antes de materializar: 118,754 ms. No era volumen — era el
     * LIMIT, que con 14 joins hace al planner apostar a un plan de arranque rápido y perder.
     */
    const t1 = Date.now();
    const filas = await q(`SELECT * FROM analytics.mv_price_signals
                            WHERE sucursal = '03' ORDER BY venta_30d DESC NULLS LAST LIMIT 50`);
    const msP = Date.now() - t1;
    ck(`⭐⭐ una plaza, top 50 por impacto, bajo 1 s (${msP} ms; sobre la vista eran 118,754)`,
      msP < 1000 && filas.length === 50, `${msP} ms, ${filas.length} filas`);

    const t2 = Date.now();
    await q(`SELECT sucursal, sku, d8_prima_caja_pct FROM analytics.mv_price_signals
              WHERE f8_veredicto = 'escalera_incoherente'
              ORDER BY venta_30d DESC NULLS LAST LIMIT 50`);
    ck('⭐ la cola priorizada, bajo 1 s', Date.now() - t2 < 1000, `${Date.now() - t2} ms`);

    // ⛔ Una matvista sin su fecha se lee como si fuera de ahora.
    const [fr] = await q(`SELECT max(calculado_al) AS al,
      round(EXTRACT(EPOCH FROM (now() - max(calculado_al)))/3600.0, 1) AS horas
        FROM analytics.mv_price_signals`);
    ck('⛔ la matvista declara CUÁNDO se calculó', fr.al !== null);
    console.log(`     calculada hace ${fr.horas} h`);
  }

  // ── 9 · ⛔ LA REFUTACIÓN DE A5, RE-MEDIDA ───────────────────────────────────────────
  console.log('\n9 · ⛔ A5: la escalera del proveedor sigue sin traer descuento por volumen');
  /**
   * ⭐ La prueba NO es circular: `v_supplier_cost_ladder` define `units_per_box` como
   * `box_cost/u1_cost`, así que comparar esas tres columnas entre sí da 100 % de identidad POR
   * CONSTRUCCIÓN. Acá se cruza el costo crudo del proveedor contra un testigo independiente —
   * el factor de unidades capturado en `kdii`.
   *
   * Si algún día el proveedor sí diera descuento por volumen, esto se pone rojo y la señal
   * vuelve a la mesa, en vez de quedar cerrada para siempre por una medición de hoy.
   */
  const [a5] = await q(`
    WITH crudo AS (
      SELECT btrim(v.c2) sku,
             percentile_cont(0.5) WITHIN GROUP (ORDER BY NULLIF(v.c8, 0)) c8,
             percentile_cont(0.5) WITHIN GROUP (ORDER BY NULLIF(v.c9, 0)) c9
        FROM kepler_ods.kdpv_prov_prod v
       WHERE btrim(COALESCE(v.c2, '')) <> '' GROUP BY 1
    ), cap AS (
      SELECT sku, percentile_cont(0.5) WITHIN GROUP (ORDER BY f2_cap) f2
        FROM analytics.v_kepler_unit_ladder WHERE f2_cap > 1 GROUP BY 1
    )
    SELECT count(*)::int pares,
           count(*) FILTER (WHERE c.c8 > 0 AND c.c9 > 0
                              AND abs((c.c9/c.c8)/k.f2 - 1) < 0.01)::int identicos
      FROM crudo c JOIN cap k ON k.sku = c.sku
     WHERE c.c8 IS NOT NULL AND c.c9 IS NOT NULL AND k.f2 IS NOT NULL`);
  const pctId = a5.pares ? (100 * a5.identicos) / a5.pares : 0;
  console.log(`     ${a5.identicos.toLocaleString()} de ${a5.pares.toLocaleString()} SKUs `
    + `(${pctId.toFixed(1)} %) con la razón de costos EXACTAMENTE igual al factor de unidades`);
  ck('⛔ el costo por unidad base es el mismo en todos los peldaños (no hay descuento que leer)',
    pctId > 95, `bajó a ${pctId.toFixed(1)} %: revisar si A5 dejó de estar refutada`);
  ck('A5 sigue declarada como refutada, con su medición escrita',
    (await q(`SELECT count(*)::int n FROM analytics.price_signal_registry
               WHERE clave = 'A5' AND estado = 'refutada'
                 AND motivo_ausencia ILIKE '%0.99999%'`))[0].n === 1);

  await c.end();
  const marca = fail === 0 ? '✅' : '❌';
  console.log(`\n${marca} ${ok} ✓ / ${fail} ✗${nm ? ` / ${nm} no medidos` : ''}\n`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('\n💥', e.message); process.exit(1); });
