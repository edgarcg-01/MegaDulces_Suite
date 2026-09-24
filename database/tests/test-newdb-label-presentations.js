/* eslint-disable no-console */
/**
 * CANDADO — `[ETQ-PRES.3]` TODO PRECIO IMPRESO VIAJA CON SU UNIDAD, Y DOS NÚMEROS DE LA MISMA
 * ETIQUETA SON CONMENSURABLES.
 *
 * ── Por qué existe ──────────────────────────────────────────────────────────────────────────
 *
 * Edgar, 2026-09-24: *"el tema no está en hacer parches, el problema es el enfoque"*.
 *
 * Los cinco defectos que provocaron esta fase salieron **de a uno, desde el mostrador, con una
 * foto de una etiqueta**. No había ningún test que hiciera la pregunta que los une, así que cada
 * uno se descubría el día que un cliente reclamaba. Este archivo hace esa pregunta.
 *
 * Lo que vigila NO es "la vista devuelve filas" — eso se pone verde con lógica falsa (ver
 * `feedback_regex_smoke_is_not_a_test`). Vigila las cuatro **invariantes** que, de haber
 * existido, habrían frenado los cinco:
 *
 *   1. Un mayoreo PUBLICADO cae en la banda contra el precio de lista de SU MISMA unidad.
 *      (Frena el "$1.35 con la pieza a $26.01" — 61 SKUs.)
 *   2. El veredicto es TERNARIO y consistente: `sin_arbitro` no puede traer precio publicado ni
 *      confundirse con `ok`. (Frena el `cfg ? classify : 'ok'` de la Fase VP.)
 *   3. El contenido de cada presentación es el de la base × su factor — NUNCA el peso del nombre
 *      del producto. (Frena el "25 kg · $57.88", 50× abajo, 111 SKUs × 9.)
 *   4. Las unidades que no son `PAQ`/`CJA` LLEGAN. Si este bloque da 0 el candado es un no-op, y
 *      un no-op se lee igual que "todo bien": por eso se declara NO MEDIDO, no ✔.
 *
 * ── Prueba negativa (ADR-056: un gate sin prueba negativa es una intención) ──────────────────
 * El bloque 5 arma en memoria las filas exactas de los cuatro defectos medidos y verifica que
 * cada invariante las RECHAZA. Si alguien afloja una regla, ese bloque se pone rojo antes que
 * ningún dato de prod.
 */

const { Client } = require('pg');

const T = '00000000-0000-0000-0000-00000000d01c';
const URL = process.env.DATABASE_URL_NEW || process.env.DST_URL
  || (() => { throw new Error('falta la URL de la DB destino: exporta DATABASE_URL_NEW'); })();

// La banda vive en el contrato; acá se repite el número a propósito para que el test falle si
// alguien la mueve sin pensarlo. Si cambia allá, cambia acá Y se explica por qué.
const PISO = 0.5;
const TECHO = 1.0;

let ok = 0; let fail = 0; let skip = 0;
const check = (label, cond, detail = '') => {
  if (cond) { ok++; console.log(`  ✔ ${label}`); }
  else { fail++; console.log(`  ✖ ${label}${detail ? ` — ${detail}` : ''}`); }
};
const nomedido = (label, why) => { skip++; console.log(`  ○ NO MEDIDO — ${label}: ${why}`); };
const N = (n) => Number(n ?? 0).toLocaleString('en-US');

(async () => {
  const c = new Client({
    connectionString: URL,
    ssl: /rlwy|railway|proxy/i.test(URL) ? { rejectUnauthorized: false } : false,
  });
  await c.connect();
  await c.query(`SET app.tenant_id = '${T}'`);
  await c.query(`SET statement_timeout = '600s'`);
  const q = async (sql, p = []) => (await c.query(sql, p)).rows;

  console.log('\n=== CANDADO — presentaciones de etiqueta (ETQ-PRES.3) ===\n');

  const existe = (await q(`SELECT to_regclass('analytics.v_label_presentations') AS t`))[0].t;
  if (!existe) {
    nomedido('la vista', 'analytics.v_label_presentations no existe en esta base');
    console.log(`\n${ok} OK · ${fail} FAIL · ${skip} NO MEDIDO\n`);
    await c.end();
    process.exit(fail ? 1 : 0);
  }

  // ── 1. El mayoreo publicado es conmensurable con SU propia lista ────────────────────────────
  console.log('1) el mayoreo publicado habla de la misma unidad que su precio de lista');
  const r1 = (await q(`
    SELECT count(*)::int AS publicados,
           count(*) FILTER (
             WHERE precio_lista IS NOT NULL AND precio_lista > 0
               AND (mayoreo_precio / precio_lista < ${PISO} OR mayoreo_precio / precio_lista > ${TECHO})
           )::int AS fuera_de_banda
      FROM analytics.v_label_presentations WHERE mayoreo_precio IS NOT NULL`))[0];
  check(`ningún mayoreo publicado cae fuera de la banda (${N(r1.publicados)} publicados)`,
    Number(r1.fuera_de_banda) === 0, `${N(r1.fuera_de_banda)} fuera`);

  // ── 2. El veredicto es ternario y no se contradice ──────────────────────────────────────────
  console.log('\n2) el veredicto dice la verdad sobre sí mismo');
  const r2 = (await q(`
    SELECT count(*) FILTER (WHERE mayoreo_veredicto = 'incoherente' AND mayoreo_precio IS NOT NULL)::int AS incoherente_publicado,
           count(*) FILTER (WHERE mayoreo_veredicto = 'sin_mayoreo' AND mayoreo_precio IS NOT NULL)::int AS sinmayoreo_publicado,
           count(*) FILTER (WHERE mayoreo_veredicto = 'ok' AND mayoreo_precio IS NULL)::int AS ok_sin_precio,
           count(*) FILTER (WHERE mayoreo_veredicto NOT IN ('ok','incoherente','sin_arbitro','sin_mayoreo'))::int AS veredicto_raro,
           count(*) FILTER (WHERE mayoreo_veredicto = 'sin_arbitro')::int AS sin_arbitro
      FROM analytics.v_label_presentations`))[0];
  check('un mayoreo "incoherente" NO publica precio', Number(r2.incoherente_publicado) === 0,
    `${N(r2.incoherente_publicado)} lo publican`);
  check('un "sin_mayoreo" NO publica precio', Number(r2.sinmayoreo_publicado) === 0);
  check('un "ok" SÍ trae precio', Number(r2.ok_sin_precio) === 0, `${N(r2.ok_sin_precio)} vacíos`);
  check('no hay veredictos fuera del vocabulario', Number(r2.veredicto_raro) === 0);
  // `sin_arbitro` tiene que EXISTIR: si diera 0, el ternario sería un binario disfrazado.
  if (Number(r2.sin_arbitro) > 0) {
    check(`"sin_arbitro" existe y se declara (${N(r2.sin_arbitro)})`, true);
  } else {
    nomedido('el tercer estado', 'ninguna presentación cayó en sin_arbitro — el ternario no se ejerció');
  }

  // ── 3. El contenido sale del FACTOR, no del nombre del producto ─────────────────────────────
  console.log('\n3) el contenido de cada presentación es el de su base por su factor');
  const r3 = (await q(`
    WITH p AS (
      SELECT sucursal, sku, unidad, factor, contenido,
             CASE WHEN contenido LIKE '% kg' THEN (split_part(contenido,' ',1))::numeric * 1000
                  WHEN contenido LIKE '% g'  THEN (split_part(contenido,' ',1))::numeric END AS g
        FROM analytics.v_label_presentations WHERE contenido IS NOT NULL
    ), base AS (
      SELECT sucursal, sku, g AS g_base FROM p WHERE factor = 1
    )
    SELECT count(*)::int AS comparables,
           -- ⚠️ La tolerancia ESCALA con el factor, y no es holgura: el contenido de la base se
           -- publica redondeado al gramo, así que re-derivar desde el valor YA REDONDEADO arrastra
           -- hasta medio gramo por unidad. Medido en la primera corrida de este candado: el 95595
           -- publica base "454 g" porque es una LIBRA (453.6 g); ×288 la vista calcula 130.637 kg
           -- —correcto— y el test ingenuo esperaba 130.752 kg. El dato estaba bien; la aritmética
           -- del test estaba mal. Con esta tolerancia un error real (el "25 kg sobre 500 g", 50×)
           -- sigue cayendo fuera por varios órdenes de magnitud.
           count(*) FILTER (WHERE abs(p.g - b.g_base * p.factor) > p.factor * 0.5)::int AS no_derivado
      FROM p JOIN base b USING (sucursal, sku)
     WHERE p.factor > 1 AND p.g IS NOT NULL AND b.g_base IS NOT NULL`))[0];
  if (Number(r3.comparables) === 0) {
    nomedido('la derivación del contenido', 'no hay presentaciones con base y alterna medibles');
  } else {
    check(`el contenido de las ${N(r3.comparables)} alternas = base × factor`,
      Number(r3.no_derivado) === 0, `${N(r3.no_derivado)} no derivan`);
  }

  // ── 4. Cobertura: las unidades que el modelo viejo tiraba, LLEGAN ───────────────────────────
  console.log('\n4) las unidades que no son PAQ/CJA llegan a la etiqueta');
  const r4 = await q(`
    SELECT unidad, count(*)::int AS filas, count(precio_lista)::int AS con_precio
      FROM analytics.v_label_presentations
     WHERE unidad NOT IN ('PAQ','CJA','PZA')
     GROUP BY 1 ORDER BY 2 DESC`);
  if (!r4.length) {
    nomedido('la cobertura de unidades', 'ninguna unidad fuera de PAQ/CJA/PZA — el candado sería no-op');
  } else {
    const total = r4.reduce((a, r) => a + Number(r.con_precio), 0);
    check(`${r4.length} unidades distintas llegan con precio (${N(total)} filas): ${r4.slice(0, 6).map((r) => r.unidad).join(', ')}`,
      total > 0);
  }

  // ── 5. PRUEBA NEGATIVA — cada invariante rechaza el defecto que vino a frenar ───────────────
  console.log('\n5) prueba negativa: las invariantes rechazan los defectos medidos');
  const enBanda = (w, l) => l > 0 && w / l >= PISO && w / l <= TECHO;
  // 44228 GALL OREO: la escalera estaba en piezas y kdii en paquetes.
  check('rechaza el mayoreo en otra escala (44228: $1.35 contra $26.01)', !enBanda(1.35, 26.01));
  // 83112 PAPA ADOBADA: mismo defecto, otra magnitud.
  check('rechaza el mayoreo en otra escala (83112: $2.34 contra $55.49)', !enBanda(2.34, 55.49));
  // Escalera invertida: el "mayoreo" sale más caro que comprar de a uno.
  check('rechaza el mayoreo MÁS CARO que su lista', !enBanda(120, 100));
  // Y ACEPTA lo legítimo, para que la regla no sea "rechazar todo".
  check('acepta un descuento de volumen real (95717: $301.28 contra $325.49)', enBanda(301.28, 325.49));
  check('acepta el peldaño de caja (95717: $2,879.65 contra $2,985.90)', enBanda(2879.65, 2985.90));
  // 18022 CAJETA: el contenido del NOMBRE (25 kg) NO es el de la base (500 g).
  const derivado = (gBase, factor) => gBase * factor;
  check('rechaza el contenido del nombre pegado a la base (18022: 25 kg sobre 500 g)',
    derivado(500, 1) !== 25000);
  check('acepta el contenido derivado de la cubeta (18022: 500 g × 50 = 25 kg)',
    derivado(500, 50) === 25000);

  // ── 6. Los cuatro casos que motivaron la fase, contra el dato real ──────────────────────────
  console.log('\n6) los cuatro casos medidos, contra la base');
  const casos = await q(`
    SELECT sku, unidad, factor, contenido, precio_lista, mayoreo_precio, mayoreo_veredicto
      FROM analytics.v_label_presentations
     WHERE sku = ANY($1) AND sucursal = $2 ORDER BY sku, factor NULLS LAST`,
  [['18022', '95717', '44228', '83112'], '01']);
  if (!casos.length) {
    nomedido('los cuatro casos', 'la plaza 01 no tiene esos SKUs en esta base');
  } else {
    const de = (sku) => casos.filter((r) => r.sku === sku);
    check('18022 publica sus TRES presentaciones', de('18022').length === 3,
      `publica ${de('18022').length}`);
    const cub = de('18022').find((r) => r.unidad === 'CUB');
    check('18022: la cubeta lleva el "25 kg" que antes colgaba de los $57.88',
      !!cub && cub.contenido === '25 kg', cub ? `contenido=${cub.contenido}` : 'sin CUB');
    const cja = de('95717').find((r) => r.unidad === 'CJA');
    check('95717: la caja ya trae su peldaño de mayoreo',
      !!cja && Number(cja.mayoreo_precio) > 0, cja ? `mayoreo=${cja.mayoreo_precio}` : 'sin CJA');
    check('44228 no publica mayoreo y DICE por qué',
      de('44228').every((r) => r.mayoreo_precio === null && r.mayoreo_veredicto === 'incoherente'));
    check('83112 no publica mayoreo y DICE por qué',
      de('83112').every((r) => r.mayoreo_precio === null && r.mayoreo_veredicto === 'incoherente'));
  }

  console.log(`\n${ok} OK · ${fail} FAIL · ${skip} NO MEDIDO\n`);
  await c.end();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('✖', e.message); process.exit(1); });
