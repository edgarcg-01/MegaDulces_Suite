/* eslint-disable no-console */
/**
 * CANDADO — LO PUBLICADO CONTRA EL ÁRBITRO, EN EL DATO (VA.2).
 *
 * Edgar, 2026-09-11: *"tu verdad absoluta fallo"* · *"que no vuelva a ocurrir"*.
 *
 * ── Por qué este archivo y no el anterior ───────────────────────────────────────────────────
 *
 * El primer intento (`test-newdb-resolver-adoption.js`, VA.1) mide **quién importa qué**. Es un
 * trinquete útil, pero hay que decirlo sin adornos: **NO habría atrapado el bug que lo motivó.**
 * Sell-Out **sí** leía el resolvedor (`v_unit_truth`, desde U.7) y **aun así** publicaba el `UxC`
 * desde `catalog.products.factor_sale`. Un candado que no atrapa el caso que lo originó es teatro.
 *
 * Tiene además dos agujeros propios: se satisface **borrando** un archivo que mencionaba el token,
 * y su chequeo de huérfanos se cierra con un `import` trivial — dice "alguien lo lee", no "alguien
 * publica desde ahí".
 *
 * La raíz del error: **se midió el CÓDIGO cuando el problema estaba en el DATO.** El bug se
 * encontró a mano comparando `factor_sale` contra el resolvedor y contando discrepancias. Eso es
 * lo que había que automatizar.
 *
 * ── Qué hace ────────────────────────────────────────────────────────────────────────────────
 *
 * Por cada **valor almacenado que se publica** y que tiene un árbitro canónico, compara los dos
 * en la base y cuenta las discrepancias, con su dinero. Rojo cuando **crecen** contra un baseline
 * MEDIDO (trinquete a nivel dato, no a nivel import).
 *
 * ⭐⭐ Y la compuerta que de verdad cierra el agujero: **un resolvedor de `VERDAD_ABSOLUTA` §5 sin
 * paridad registrada es una FALLA.** Ése era exactamente el estado del factor de caja — resolvedor
 * canónico, ADR firmado, candados que lo verificaban contra su testigo… y nada que comparara lo
 * publicado contra él. Así se fue un `UxC = 1` donde son 58 durante meses.
 *
 * ── ⚠️ Umbrales CALIBRADOS, no elegidos ─────────────────────────────────────────────────────
 *
 * Cada paridad trae el umbral con el que se midió y por qué. La primera versión de la paridad de
 * costo usaba "difiere en más de $0.01" y daba **5,916 discrepancias**: ruido puro. Medida la
 * distribución real (`cost_base / costo_del_ERP`: mediana 0.9731, p90 1.0000, p10 0.81), la señal
 * son las **583 por debajo de 0.5x**. Una paridad sin umbral calibrado no es una medición.
 *
 * ── ⛔ Lo que este candado NO alcanza, dicho antes de que alguien lo suponga ─────────────────
 *
 * Sólo ve valores **almacenados**. Un número que el servicio calcula en TypeScript al vuelo —como
 * el `uxc` de Sell-Out, que no se guarda en ninguna tabla— es invisible para SQL. Para ésos hoy
 * sólo existe VA.1 (código) y el candado propio de cada pantalla. Cerrarlo del todo pide golpear
 * el endpoint y comparar la respuesta contra el árbitro; no está hecho.
 */

const { Client } = require('pg');

const T = '00000000-0000-0000-0000-00000000d01c';
const URL = process.env.DATABASE_URL_NEW || process.env.DST_URL
  || (() => { throw new Error('falta la URL de la DB destino: exporta DATABASE_URL_NEW'); })();

/**
 * El registro de paridades. `baseline` es lo MEDIDO el 2026-09-11 contra prod — el trinquete.
 * `arbitro` nombra el resolvedor de VERDAD_ABSOLUTA §5 que esta paridad cubre; la compuerta del
 * bloque 3 exige que TODOS los resolvedores estén cubiertos o declarados con motivo.
 */
const PARIDADES = [
  {
    nombre: 'factor de caja publicado vs arbitrado',
    arbitro: 'v_product_box_factor',
    publicado: 'catalog.products.factor_sale',
    // ⭐ El caso de Edgar: factor_sale = 1 contra un resolvedor que dice mas. Es la forma
    // PELIGROSA de la discrepancia -- publica "se vende por pieza" sobre una caja de 58.
    umbral: 'cualquier desacuerdo donde el arbitro TIENE testigo (source <> default)',
    porque: 'la direccion importa: un 1 se lee como "pieza" y multiplica mal en cualquier '
      + 'pantalla que convierta. El caso 96504 (UxC 1, son 58) es de este grupo.',
    // ⭐⭐ CERO, no 208. VA.3 (mig 20260912000000, prod batch 399) dejo de ADMINISTRAR esta
    // divergencia y la elimino: catalog.products.factor_sale se escribio con el valor del
    // arbitro en las 854 filas donde el arbitro tiene TESTIGO. Un baseline distinto de cero
    // seria deuda formalizada -- un parche. Cero lo vuelve un INVARIANTE: si vuelve a aparecer
    // una discrepancia, alguien escribio un factor que el arbitro contradice, y eso es un bug,
    // no un pendiente.
    // ⛔ Las 1,479 con source='default' NO entran: ahi el arbitro no afirma nada (un 'default'
    // es ausencia de testigo, y escribirlo convertiria "no se" en 1).
    baseline: 0,
    sql: `
      SELECT count(*)::int discrepancias,
             round(COALESCE(sum(v.rev), 0))::numeric dinero
        FROM catalog.products p
        JOIN analytics.v_product_box_factor b
          ON b.product_id = p.id AND b.tenant_id = p.tenant_id
        LEFT JOIN (SELECT product_id, sum(revenue)::numeric rev FROM analytics.sales_daily
                    WHERE tenant_id = '${T}' AND sale_date >= current_date - 90
                    GROUP BY 1) v ON v.product_id = p.id
       WHERE p.tenant_id = '${T}' AND p.deleted_at IS NULL
         AND b.source <> 'default'
         AND p.factor_sale::numeric IS DISTINCT FROM b.box_factor::numeric`,
  },
];

/** Se agregan al registro de arriba; van aparte sólo para no hacer ilegible el literal. */
PARIDADES.push(
  {
    nombre: 'existencia publicada vs existencia del ERP',
    arbitro: 'v_erp_stock_on_hand',
    publicado: 'commercial.stock.quantity',
    // ⚠️ Umbral CALIBRADO. "Difiere en algo" da 4,047 de 35,489 y es ruido: la existencia se
    // mueve entre la foto del ERP y la tabla. Lo que NO es ruido es la contradiccion
    // CUALITATIVA -- uno dice que hay y el otro que no. Son dos errores distintos y los dos
    // duelen: 0 con ERP>0 esconde mercancia; >0 con ERP=0 promete lo que no existe.
    umbral: 'uno dice 0 y el otro dice que hay (contradiccion de existencia, no de cantidad)',
    porque: 'medido: 35,489 pares, 4,047 difieren en cantidad pero solo 196 se contradicen sobre '
      + 'si hay o no hay (116 con stock=0 y ERP>0; 80 con stock>0 y ERP=0).',
    // ⚠️ UNICA paridad sobre dato VIVO: dos observaciones con minutos de diferencia dieron 196 y
    // 140 (~30% de vaiven intradia, la existencia se mueve todo el dia). Un trinquete clavado en
    // el valor medido parpadearia en rojo sin que nadie rompa nada, y una alarma que grita en
    // falso ensena a ignorar el tablero. El tope lleva margen EXPLICITO sobre el maximo visto;
    // el bloque 2 imprime el valor de hoy, asi que la deriva se ve igual.
    vivo: true,
    baseline: 250,
    sql: `
      SELECT count(*)::int discrepancias, NULL::numeric dinero
        FROM commercial.stock s
        JOIN analytics.v_erp_stock_on_hand e
          ON e.tenant_id = s.tenant_id AND e.warehouse_id = s.warehouse_id
         AND e.product_id = s.product_id
       WHERE s.tenant_id = '${T}'
         AND ((s.quantity::numeric = 0 AND e.qty_stock_units::numeric > 0)
           OR (s.quantity::numeric > 0 AND e.qty_stock_units::numeric = 0))`,
  },
  {
    nombre: 'clase ABC guardada vs clase ABC arbitrada',
    arbitro: 'v_abc_class',
    publicado: 'commercial.abc_classification.abc_class',
    // La doc ya advertia que la tabla "llega tarde" (KE.4). Esto le pone numero y DIRECCION:
    // la guardada es mas GENEROSA que el arbitro -- 784 guardadas A y 1,062 B que el resolvedor
    // dice C. No son faltantes: es colchon de seguridad de mas, o sea capital inmovilizado.
    // ⚠️ La primera medicion de la direccion salio 0 porque la escribi al reves (busque
    // resolvedor A / guardada C). El dato estaba bien; la consulta no.
    umbral: 'guardada A o B mientras el arbitro dice C',
    porque: 'de 55,396 pares difieren 1,846, y los 1,846 son de esa forma: cero en la direccion '
      + 'contraria. Un A/B guardado se sirve al 0.98/0.95 en vez del 0.90 que le toca.',
    baseline: 1846,
    sql: `
      SELECT count(*)::int discrepancias, NULL::numeric dinero
        FROM commercial.abc_classification a
        JOIN analytics.v_abc_class v
          ON v.tenant_id = a.tenant_id AND v.product_id = a.product_id
         AND v.warehouse_id = a.warehouse_id
       WHERE a.tenant_id = '${T}'
         AND a.abc_class IN ('A', 'B') AND v.abc_class = 'C'`,
  },
);

/**
 * Los resolvedores de VERDAD_ABSOLUTA §5. La compuerta del bloque 3 exige que cada uno tenga
 * paridad registrada, o que esté acá con el motivo por el que no puede tenerla.
 *
 * ⛔ Este objeto es la salida de emergencia del mecanismo, y por eso es donde va a pudrirse si
 * alguien la usa de atajo. Un motivo tiene que decir POR QUÉ no se puede comparar — no "no
 * aplica". Si al leerlo no se entiende qué haría falta para que sí hubiera paridad, está mal.
 */
const SIN_PARIDAD_CON_MOTIVO = {
  // El motivo de este es una BUENA noticia, no una excusa. Hasta VA.4 el reabasto valuaba con
  // `COALESCE(pr.cost_with_tax, pr.cost_base, 0)` -- el catalogo -- y habia paridad que medir
  // porque habia DOS valores. VA.4 cableo la pierna Kepler al arbitro con un CASE por ERP: ya no
  // hay segundo valor almacenado, no queda nada que comparar en el DATO.
  // ⚠️ Una version de este archivo intento medirlo igual y escribio una paridad que daba 1,342 --
  // pero lo que media era "el arbitro se aparta del catalogo mas alla de la banda fiscal", que es
  // esperado y NO es un defecto. Una metrica mal rotulada es peor que ninguna.
  v_erp_unit_cost: 'desde VA.4 el consumidor LEE el arbitro (CASE por ERP en '
    + 'commercial-replenishment.costUnit()), asi que no hay segundo valor almacenado contra el '
    + 'cual cotejar: el guardian correcto es la asercion de CODIGO del bloque 4bis. La pierna '
    + 'Wincaja quedo con el catalogo por decision de alcance y vive declarada en '
    + 'analytics.declared_gaps (costo_arbitro_no_conmensurable_reabasto)',
  v_kepler_unit_cost: 'es la pierna Kepler de v_erp_unit_cost, que YA tiene paridad registrada. '
    + 'Compararlo aparte mediria dos veces el mismo desacuerdo',
  mv_kepler_sales_daily: 'su paridad existe y vive en su propio candado '
    + '(test-newdb-sellout-parity.js, VP.1): mide doble conteo, hueco y rollup==vista al peso. '
    + 'Duplicarla aca seria un segundo primitivo del mismo control',
  sales_by_route_monthly: 'el "nunca" de §5 no es otra FUENTE sino un filtro (route_code LIKE '
    + 'WIN-%): no hay dos valores que comparar, hay un universo mal recortado. Lo que haria falta '
    + 'es un candado de recorte, no de paridad',
  v_route_monthly_provenance: 'ES la vista de procedencia -- responde quien escribio cada llave. '
    + 'No publica una cantidad contra la cual cotejar otra',
  v_warehouse_box_factor: 'deriva de v_product_box_factor, que ya tiene paridad; su eje extra '
    + '(almacen) no tiene columna publicada equivalente contra la cual comparar',
  v_unit_truth: 'no hay columna almacenada que publique "el metodo de conversion": lo consume '
    + 'el servicio al vuelo. Queda para la paridad por endpoint, que no esta hecha',
  v_supplier_cost_ladder: 'es el TESTIGO, no lo publicado: compararlo consigo mismo seria un '
    + 'espejo (ADR-059 R5)',
  v_erp_sales_line_units: 'CERO consumidores -- no publica nada que comparar. Declarado en '
    + 'analytics.declared_gaps como resolvedores_sin_adopcion',
  v_erp_stock_truth: 'CERO consumidores -- mismo caso',
};

/**
 * ⭐⭐ Lee los resolvedores canónicos de la TABLA §5 de `docs/VERDAD_ABSOLUTA.md`.
 *
 * El documento es la declaración; esta compuerta tiene que obedecerla, no tener su propia copia.
 * Si mañana alguien agrega un resolvedor a §5 sin registrar su paridad ni escribir por qué no
 * puede tenerla, este candado se pone rojo solo. Ése es el único mecanismo de acá que no depende
 * de que alguien se acuerde.
 */
function resolvedoresDeLaDoc() {
  const fs = require('fs');
  const path = require('path');
  const DOC = path.resolve(__dirname, '..', '..', 'docs', 'VERDAD_ABSOLUTA.md');
  let txt;
  try { txt = fs.readFileSync(DOC, 'utf8'); } catch { return []; }
  const i = txt.indexOf('## 5. Los resolvedores canónicos');
  if (i < 0) return [];
  const j = txt.indexOf('\n## ', i + 10);
  const bloque = txt.slice(i, j < 0 ? undefined : j);
  const out = new Set();
  for (const linea of bloque.split('\n')) {
    if (!linea.trim().startsWith('|')) continue;
    const cols = linea.split('|');
    if (cols.length < 3) continue;
    // Columna 2 = "leé". Sólo de ahí: la columna "nunca" nombra justamente lo que NO hay que leer.
    for (const m of cols[2].matchAll(/analytics\.([a-z0-9_]+)/g)) out.add(m[1]);
  }
  return Array.from(out).sort();
}

let ok = 0; let fail = 0; let skip = 0;
const check = (label, cond, detail = '') => {
  if (cond) { ok++; console.log(`  ✔ ${label}`); }
  else { fail++; console.log(`  ✖ ${label}${detail ? ` — ${detail}` : ''}`); }
};
// ⛔ `Number(n || 0)` convierte un campo INEXISTENTE en 0. Paso el 2026-09-11: una consulta
// aliaseaba `sin_testigo_NO_escribir` y Postgres devuelve `sin_testigo_no_escribir` (baja a
// minusculas los identificadores sin comillas); el helper dibujo 1,479 como CERO y por poco
// se decide sobre ese cero. Un campo ausente NO es un cero -- se grita.
const N = (n) => {
  if (n === undefined) throw new Error('N() recibio undefined: nombre de columna mal escrito '
    + '(Postgres devuelve los alias en MINUSCULAS). Un campo ausente no es un cero.');
  return Number(n ?? 0).toLocaleString('en-US', { maximumFractionDigits: 0 });
};

(async () => {
  const c = new Client({
    connectionString: URL,
    ssl: /rlwy|railway|proxy/i.test(URL) ? { rejectUnauthorized: false } : false,
  });
  await c.connect();
  await c.query(`SET app.tenant_id = '${T}'`);
  await c.query(`SET statement_timeout = '300s'`);

  console.log('\n=== CANDADO: lo publicado contra el árbitro, EN EL DATO (VA.2) ===\n');
  console.log('  VA.1 mide quién importa qué — y no habría atrapado el UxC de Edgar, porque');
  console.log('  Sell-Out SÍ leía el resolvedor y publicaba el número desde otro lado.\n');

  // ── 1. Cada paridad, con su umbral calibrado ─────────────────────────────────────────────
  console.log('── 1. Las paridades registradas ──');
  const medidas = [];
  for (const p of PARIDADES) {
    let row = null; let err = null;
    try { row = (await c.query(p.sql)).rows[0]; } catch (e) { err = e.message; }
    if (err) {
      check(`la paridad \`${p.nombre}\` corre`, false, err.slice(0, 100));
      continue;
    }
    medidas.push({ ...p, ...row });
    console.log(`\n     ${p.nombre}`);
    console.log(`       publicado: ${p.publicado}   árbitro: ${p.arbitro}`);
    console.log(`       umbral:    ${p.umbral}`);
    const plata = row.dinero == null ? 'dinero NO MEDIDO' : `$${N(row.dinero)} de venta 90 d`;
    console.log(`       hoy:       ${N(row.discrepancias)} discrepancias · ${plata}`
      + `  (baseline ${N(p.baseline)})`);
  }

  // ── 2. ⭐⭐ EL TRINQUETE, a nivel dato ────────────────────────────────────────────────────
  console.log('\n── 2. ⭐⭐ El trinquete: las discrepancias pueden bajar, nunca subir ──');
  for (const m of medidas) {
    check(`⭐ \`${m.nombre}\`: no crecieron contra el baseline 2026-09-11`,
      m.discrepancias <= m.baseline,
      `${N(m.discrepancias)} contra ${N(m.baseline)} — alguien publicó un valor nuevo que el `
      + 'árbitro contradice');
    if (m.discrepancias < m.baseline && !m.vivo) {
      console.log(`     ⭐ mejoró: ${N(m.baseline)} → ${N(m.discrepancias)}. Bajá el baseline acá.`);
    } else if (m.discrepancias < m.baseline) {
      // ⛔ En una paridad sobre dato VIVO el tope lleva margen a proposito. Invitar a bajarlo
      // al valor de hoy es invitar a que parpadee manana: el margen NO es holgura sobrante.
      console.log(`     · dato vivo: hoy ${N(m.discrepancias)}, tope ${N(m.baseline)} con margen`
        + ' declarado. NO bajar el tope al valor de hoy.');
    }
  }

  // ── 3. ⭐⭐ LA COMPUERTA: un árbitro sin paridad registrada es una falla ──────────────────
  console.log('\n── 3. ⭐⭐ Ningún árbitro de §5 queda sin paridad NI sin motivo ──');
  console.log('     (éste es el agujero exacto por el que se fue el UxC: resolvedor canónico,');
  console.log('      ADR firmado, candados contra su testigo… y nada comparando lo publicado)');
  // ⭐⭐ La lista se LEE del documento, no se copia. La primera versión la traía a mano con 7
  // entradas mientras §5 declara 13 — y la compuerta pasaba en verde con 6 resolvedores sin
  // paridad. Una copia a mano de una declaración se despega de la declaración: es EXACTAMENTE
  // el defecto que este archivo existe para impedir, cometido dentro del archivo mismo.
  const RESOLVEDORES = resolvedoresDeLaDoc();
  if (!RESOLVEDORES.length) {
    check('se pudo leer la tabla §5 de docs/VERDAD_ABSOLUTA.md', false,
      'sin la lista del documento esta compuerta no vale nada');
  }
  console.log(`     (${RESOLVEDORES.length} resolvedores leídos de docs/VERDAD_ABSOLUTA.md §5)`);
  const cubiertos = new Set(PARIDADES.map((p) => p.arbitro));
  const sueltos = RESOLVEDORES.filter((r) => !cubiertos.has(r) && !SIN_PARIDAD_CON_MOTIVO[r]);
  for (const r of RESOLVEDORES) {
    if (cubiertos.has(r)) console.log(`     ✓ ${r.padEnd(24)} paridad registrada`);
    else if (SIN_PARIDAD_CON_MOTIVO[r]) console.log(`     · ${r.padEnd(24)} sin paridad — ${SIN_PARIDAD_CON_MOTIVO[r]}`);
    else console.log(`     ⛔ ${r.padEnd(24)} SIN PARIDAD Y SIN MOTIVO`);
  }
  check('⭐⭐ todo árbitro de §5 tiene paridad registrada o motivo escrito de por qué no',
    sueltos.length === 0,
    `${sueltos.join(', ')} — publicar un número arbitrado sin nada que lo compare es el estado `
    + 'exacto que dejó pasar el UxC=1 sobre una caja de 58');

  // ── 4. ⛔ PRUEBA NEGATIVA: el umbral discrimina ───────────────────────────────────────────
  console.log('\n── 4. ⛔ PRUEBA NEGATIVA: el umbral no es decorativo ──');
  const [t] = (await c.query(`
    SELECT count(*)::int n FROM catalog.products p
     JOIN analytics.v_product_box_factor b ON b.product_id = p.id AND b.tenant_id = p.tenant_id
    WHERE p.tenant_id = '${T}' AND p.deleted_at IS NULL
      AND p.factor_sale::numeric <> b.box_factor::numeric`)).rows;
  const dir = medidas.find((m) => m.arbitro === 'v_product_box_factor');
  if (dir) {
    console.log(`     cualquier diferencia: ${N(t.n)} · sólo la dirección peligrosa: ${N(dir.discrepancias)}`);
    check('⭐ el umbral RECORTA: no cuenta toda diferencia como si fuera un error',
      dir.discrepancias < t.n,
      `${N(dir.discrepancias)} vs ${N(t.n)} — si fueran iguales, el umbral no estaría filtrando nada`);
  }

  // ── 4bis. ⭐⭐ El guardián del COSTO es de CÓDIGO, no de dato ─────────────────────────────
  console.log('\n── 4bis. ⭐⭐ El costo del reabasto lee el árbitro (VA.4) ──');
  console.log('     No hay paridad de dato posible: desde VA.4 no existe un segundo valor');
  console.log('     almacenado. Lo que se puede afirmar es que el consumidor lee el árbitro.');
  {
    const fs2 = require('fs');
    const path2 = require('path');
    const REP = path2.resolve(__dirname, '..', '..',
      'libs/commercial/src/lib/commercial-replenishment/commercial-replenishment.service.ts');
    if (!fs2.existsSync(REP)) {
      skip++; console.log('  ○ NO MEDIDO — el cableado del costo: no se encontró el servicio');
    } else {
      const rep = fs2.readFileSync(REP, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
      check('⭐⭐ el reabasto lee el ÁRBITRO del costo en la pierna Kepler (VA.4)',
        rep.includes('euc.costo_unitario'),
        'costUnit() volvió al catálogo: el costo del reabasto dejó de ser el arbitrado');
      check('⭐ y con un CASE por ERP, no un COALESCE que cruce los dos (ADR-059 R1)',
        rep.includes("costo_source = 'wincaja_costo_promedio'"),
        'desapareció el CASE por ERP: o se unificaron las piernas, o se perdió el guard');
      check('⛔ y el catálogo ya NO se usa para valuar ahí',
        !/COALESCE\(pr\.cost_with_tax, pr\.cost_base, 0\)\s*'/.test(rep)
        || !rep.includes('private costUnit() { return'),
        'costUnit() volvió a devolver el catálogo crudo');
    }
  }

  // ── 5. Lo que este candado NO alcanza ────────────────────────────────────────────────────
  console.log('\n── 5. Lo que este candado no alcanza ──');
  console.log('     ⛔ Sólo ve valores ALMACENADOS. El `uxc` de Sell-Out se calcula al vuelo y no');
  console.log('        vive en ninguna tabla: para ése, hoy sólo hay VA.1 (código) y su candado');
  console.log('        propio. Cerrarlo pide golpear el endpoint y comparar la respuesta contra');
  console.log('        el árbitro — NO está hecho, y se declara en vez de suponerlo cubierto.');
  console.log('     ⚠️  Los baselines son deuda; un objetivo CERO es un invariante.');
  console.log('        factor de caja y costo-Kepler estan en CERO: si aparece una');
  console.log('        discrepancia es un bug, no un pendiente. Existencia (tope 250, dato');
  console.log('        vivo) y ABC (1,846) siguen siendo DEUDA: el trinquete impide que');
  console.log('        crezcan, cerrarlas es trabajo aparte.');

  console.log(`\n=== ${ok} OK · ${fail} FAIL · ${skip} NO MEDIDO ===\n`);
  await c.end();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
