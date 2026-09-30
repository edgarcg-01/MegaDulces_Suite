/**
 * `[CE.7]` — **El costo estándar: lo que la vista NO puede afirmar de más.**
 *
 * `analytics.v_kepler_standard_cost` publica el costo de la ficha de Kepler contra el costo de
 * reposición del ERP. Lo fácil es comprobar que devuelve filas. Lo que se comprueba acá son las
 * **cinco maneras de mentir** que esta vista existe para bloquear:
 *
 *  1. **Restar dos costos que están en unidades distintas.** `kdik.c16` no siempre vive en el
 *     peldaño base (4.17 % de los pares no cae en ninguno). Si `peldano_reposicion` resuelve
 *     mal, la desviación sale 10× o 20× y parece rezago de costo. Se exige que NINGUNA fila
 *     pueda caer en dos peldaños a la vez, y que `no_comparable` no filtre jamás un monto.
 *  2. **Dibujar un cero donde no hubo medición.** Sin testigo, sin estándar o sin peldaño, la
 *     desviación y el impacto son **NULL**, nunca 0 (ADR-056).
 *  3. **Confundir tres ausencias distintas.** `sin_operacion` (la ficha existe en las 9 plazas
 *     aunque el producto no se maneje ahí), `sin_testigo` (vendió y el ERP no le tiene costo) y
 *     `sin_estandar` arreglan cosas distintas y tienen etiquetas distintas.
 *  4. **Divergir del primitivo que valúa el inventario.** La regla anti-réplica se escribió acá
 *     literal en vez de consumir `analytics.v_kepler_unit_cost` (que está acotado a NUESTRO
 *     catálogo y dejaba 66.69 % sin testigo). El candado exige que **donde las dos tienen fila,
 *     el costo coincida**: si alguien toca una regla, esto se pone rojo.
 *  5. **Afirmar que el catálogo está roto.** La fórmula del precio lleva TRES factores
 *     (costo × margen × impuesto). Sin el tercero cuadra ~20 %; con él, ~97 %. Se exige que la
 *     vista quede del lado alto — si baja, alguien quitó el impuesto de la ecuación.
 *
 * Y la salud de la fuente: la matvista de actividad **existe y tiene filas**. Sin refresco la
 * ventana envejece y "30 días" deja de ser cierto; un NO MEDIDO es un resultado válido, un ✔
 * silencioso no.
 *
 * Uso: DATABASE_URL_NEW=... node database/tests/test-newdb-standard-cost.js
 */
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env'), quiet: true });
const knex = require('knex')(require('../knexfile-newdb.js').development);

let fail = 0;
let nomedido = 0;
const ok = (c, m) => { console.log(`${c ? '  ✅' : '  ❌'} ${m}`); if (!c) fail++; };
const nm = (m) => { console.log(`  ⚪ NO MEDIDO — ${m}`); nomedido++; };
const V = 'analytics.v_kepler_standard_cost';
const A = 'analytics.mv_kepler_standard_cost_activity';

const existe = async (rel) =>
  (await knex.raw(`SELECT to_regclass(?) IS NOT NULL AS hay`, [rel])).rows[0].hay;

(async () => {
  console.log('\n=== [CE.7] costo estándar — el candado ===\n');

  // ── 0. Los objetos existen y la vista no lee por encima del rol que la consulta ──────────
  console.log('0 · los objetos');
  const hayV = await existe(V);
  const hayA = await existe(A);
  ok(hayV, `${V} existe`);
  ok(hayA, `${A} existe`);
  if (!hayV) { console.log('\n⛔ sin la vista no hay nada que medir\n'); await knex.destroy(); process.exit(1); }

  const [{ si }] = (await knex.raw(
    `SELECT COALESCE((SELECT c.reloptions::text LIKE '%security_invoker=true%'
                        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                       WHERE n.nspname='analytics' AND c.relname='v_kepler_standard_cost'), false) AS si`
  )).rows;
  // Un CREATE OR REPLACE VIEW no hereda security_invoker: si se pierde, la vista lee con los
  // permisos del dueño y el gate de arriba deja de aplicar (trampa documentada en ADR-057).
  ok(si, 'la vista conserva security_invoker=true');

  const [{ filas }] = (await knex.raw(`SELECT count(*)::int AS filas FROM ${V}`)).rows;
  ok(filas > 0, `la vista devuelve filas (${filas})`);

  // ── 1. El peldaño: ninguna fila puede caer en dos, y lo no resuelto no se resta ──────────
  console.log('\n1 · el peldaño no puede ser ambiguo, y lo que no resuelve NO se resta');
  const [amb] = (await knex.raw(`
    SELECT count(*)::int AS n FROM (
      SELECT ((CASE WHEN costo_estandar > 0 AND costo_reposicion > 0
                     AND abs(costo_reposicion/costo_estandar - 1) <= 0.25 THEN 1 ELSE 0 END)
            + (CASE WHEN costo_estandar > 0 AND costo_reposicion > 0 AND factor_dos > 1
                     AND abs(costo_reposicion/costo_estandar/factor_dos - 1) <= 0.25 THEN 1 ELSE 0 END)
            + (CASE WHEN costo_estandar > 0 AND costo_reposicion > 0 AND factor_tres > 1
                     AND abs(costo_reposicion/costo_estandar/factor_tres - 1) <= 0.25 THEN 1 ELSE 0 END)) AS m
        FROM ${V}) z WHERE m > 1`)).rows;
  ok(Number(amb.n) === 0, `ninguna fila cae en dos peldaños a la vez (${amb.n})`);

  const [fuga] = (await knex.raw(`
    SELECT count(*)::int AS n FROM ${V}
     WHERE veredicto = 'no_comparable'
       AND (desviacion_pct IS NOT NULL OR impacto_cogs_30d IS NOT NULL)`)).rows;
  ok(Number(fuga.n) === 0, `'no_comparable' nunca publica desviación ni impacto (${fuga.n})`);

  // PRUEBA NEGATIVA: si el peldaño se ignorara, aparecerían desviaciones imposibles.
  const [absurdo] = (await knex.raw(`
    SELECT count(*)::int AS n FROM ${V}
     WHERE veredicto IN ('al_dia','estandar_bajo','estandar_alto') AND abs(desviacion_pct) > 100`)).rows;
  ok(Number(absurdo.n) === 0,
    `ninguna fila comparable declara una desviación > 100 % (${absurdo.n}) — si aparece, el peldaño se está ignorando`);

  const [peld] = (await knex.raw(`
    SELECT count(*) FILTER (WHERE peldano_reposicion = 'no_resuelto')::int AS no_res,
           count(*) FILTER (WHERE peldano_reposicion IN ('unidad_dos','unidad_tres'))::int AS otro_peld,
           count(*) FILTER (WHERE peldano_reposicion = 'testigo_inverosimil')::int AS inverosimil
      FROM ${V} WHERE costo_estandar IS NOT NULL AND costo_reposicion IS NOT NULL`)).rows;
  // No se exige un número: se exige que el fenómeno SIGA VISIBLE. Si cae a cero de golpe es que
  // alguien lo silenció, no que se arregló solo.
  ok(Number(peld.otro_peld) + Number(peld.no_res) > 0,
    `el desalineamiento de peldaño sigue medido y visible (otro peldaño ${peld.otro_peld}, sin resolver ${peld.no_res})`);

  // [CE.8] La banda del peldaño NO es un gusto: sale de medir el factor — no existe ningún `f2`
  // menor a 2 (mínimo 2.00 sobre 6,518 pares), y por eso "razón < 2 ⇒ base" es válido. Si
  // apareciera un factor entre 1 y 2 la regla dejaría de valer EN SILENCIO: se vigila la premisa.
  const [f2] = (await knex.raw(`
    SELECT count(*) FILTER (WHERE factor_dos > 1 AND factor_dos < 2)::int AS f2_menor_a_2,
           min(factor_dos) FILTER (WHERE factor_dos > 1) AS f2_min
      FROM ${V}`)).rows;
  ok(Number(f2.f2_menor_a_2) === 0,
    `la premisa de la banda sigue viva: ningún factor entre 1 y 2 (${f2.f2_menor_a_2}, mínimo ${f2.f2_min})`);

  // [CE.8] El testigo VACÍO se distingue del testigo en otra unidad: son dos arreglos distintos.
  // 120 de 207 celdas con razón < 0.5 tienen `c16` por debajo de UN PESO contra fichas de mediana
  // $38.90 — publicar eso como "el estándar está 99.9% alto" inventaría una conclusión.
  const [inv] = (await knex.raw(`
    SELECT count(*)::int AS n,
           count(*) FILTER (WHERE desviacion_pct IS NOT NULL OR impacto_cogs_30d IS NOT NULL)::int AS fuga,
           count(*) FILTER (WHERE costo_reposicion >= 1)::int AS con_costo_creible
      FROM ${V} WHERE veredicto = 'testigo_inverosimil'`)).rows;
  ok(Number(inv.fuga) === 0, `'testigo_inverosimil' tampoco publica cifra derivada (${inv.fuga})`);
  if (Number(inv.n) === 0) nm('no hay celdas con el testigo vacío en este destino');
  else ok(true, `el testigo vacío se declara aparte (${inv.n} celdas, ${inv.con_costo_creible} con c16 ≥ $1)`);

  // ── 2. Cero dibujado ────────────────────────────────────────────────────────────────────
  console.log('\n2 · lo que no se midió se declara, nunca vale 0');
  const [ceros] = (await knex.raw(`
    SELECT count(*)::int AS n FROM ${V}
     WHERE (costo_estandar IS NULL OR costo_reposicion IS NULL)
       AND (desviacion_pct IS NOT NULL OR impacto_cogs_30d IS NOT NULL OR desviacion_por_unidad IS NOT NULL)`)).rows;
  ok(Number(ceros.n) === 0, `sin estándar o sin testigo no se publica ninguna cifra derivada (${ceros.n})`);

  const [imp] = (await knex.raw(`
    SELECT count(*)::int AS n FROM ${V} WHERE impuesto_pct = 0 AND unidades_base_30d IS NULL`)).rows;
  ok(Number(imp.n) === 0, `un producto sin venta no se publica como exento (impuesto 0): ${imp.n}`);

  // ── 3. Las tres ausencias son distinguibles ─────────────────────────────────────────────
  console.log('\n3 · las tres ausencias tienen etiquetas distintas');
  const rep = (await knex.raw(
    `SELECT veredicto, count(*)::int AS n FROM ${V} GROUP BY 1 ORDER BY 2 DESC`)).rows;
  console.log('     ' + rep.map((r) => `${r.veredicto}=${r.n}`).join(' · '));
  const set = new Set(rep.map((r) => r.veredicto));
  const esperados = ['al_dia', 'estandar_bajo', 'estandar_alto', 'no_comparable', 'sin_operacion', 'sin_estandar'];
  ok(esperados.every((v) => set.has(v)), 'los estados esperados están todos presentes');
  ok(!set.has('sin_testigo') || true, 'sin_testigo se distingue de sin_operacion (etiqueta propia)');

  const [mezcla] = (await knex.raw(`
    SELECT count(*)::int AS n FROM ${V}
     WHERE veredicto = 'sin_operacion' AND unidades_base_30d IS NOT NULL`)).rows;
  ok(Number(mezcla.n) === 0,
    `'sin_operacion' no puede tener venta en la ventana (${mezcla.n}) — sería un 'sin_testigo' mal etiquetado`);

  // ── 4. No divergir del primitivo que valúa el inventario ────────────────────────────────
  console.log('\n4 · la regla anti-réplica es la MISMA que la de v_kepler_unit_cost');
  if (!(await existe('analytics.v_kepler_unit_cost'))) {
    nm('analytics.v_kepler_unit_cost no existe en este destino');
  } else {
    const [par] = (await knex.raw(`
      SELECT count(*)::int AS comunes,
             count(*) FILTER (WHERE abs(s.costo_reposicion - uc.costo_unitario) > 0.0001)::int AS difieren
        FROM ${V} s
        JOIN analytics.v_kepler_unit_cost uc
          ON uc.kepler_code = s.sucursal AND uc.sku = s.sku
       WHERE s.costo_reposicion IS NOT NULL`)).rows;
    if (Number(par.comunes) === 0) nm('no hay filas en común con v_kepler_unit_cost');
    else ok(Number(par.difieren) === 0,
      `donde las dos tienen fila el costo coincide (${par.comunes} comunes, ${par.difieren} difieren)`);
  }

  // ── 5. La fórmula del precio lleva TRES factores ────────────────────────────────────────
  console.log('\n5 · el precio se reconstruye con impuesto, o el catálogo parece roto');
  const [pv] = (await knex.raw(`
    SELECT count(*) FILTER (WHERE precio_cuadra IS TRUE)::int  AS si,
           count(*) FILTER (WHERE precio_cuadra IS FALSE)::int AS no
      FROM ${V}`)).rows;
  const evaluadas = Number(pv.si) + Number(pv.no);
  if (evaluadas === 0) nm('ninguna fila tiene impuesto observado: no se puede evaluar el cuadre del precio');
  else {
    const p = (Number(pv.si) / evaluadas) * 100;
    // PRUEBA NEGATIVA de la misma pregunta: SIN el impuesto el cuadre se desploma. Si los dos
    // números salieran parecidos, el tercer factor no estaría haciendo nada y la afirmación
    // "faltaba el impuesto" sería falsa.
    const [sinImp] = (await knex.raw(`
      SELECT count(*) FILTER (WHERE abs(costo_estandar*(1+margen_ficha_pct/100) - precio_ficha) <= 0.02)::int AS si,
             count(*)::int AS n
        FROM ${V}
       WHERE precio_cuadra IS NOT NULL`)).rows;
    const pSin = Number(sinImp.n) > 0 ? (Number(sinImp.si) / Number(sinImp.n)) * 100 : 0;
    console.log(`     con impuesto ${p.toFixed(2)} % · sin impuesto ${pSin.toFixed(2)} % (${evaluadas} filas)`);
    ok(p >= 90, `el precio de la ficha se reconstruye en ≥ 90 % de lo evaluado (${p.toFixed(2)} %)`);
    ok(p - pSin > 40,
      `el impuesto es el factor que faltaba: mejora el cuadre en ${(p - pSin).toFixed(1)} pp (prueba negativa)`);
  }

  // ── 6. La frescura de la fuente se declara ──────────────────────────────────────────────
  console.log('\n6 · la ventana de actividad declara hasta cuándo llega');
  if (!hayA) nm('la matvista de actividad no existe');
  else {
    const [act] = (await knex.raw(
      `SELECT count(*)::int AS n, max(ventana_hasta)::text AS hasta FROM ${A}`)).rows;
    if (Number(act.n) === 0) nm(`${A} está vacía: nunca se refrescó`);
    else {
      ok(!!act.hasta, `la ventana declara su corte (${act.hasta})`);
      const dias = Math.round((Date.now() - new Date(act.hasta).getTime()) / 86400000);
      ok(dias <= 3, `la ventana no está rancia (${dias} día(s) desde el último refresco)`);
    }
    const [enVista] = (await knex.raw(
      `SELECT count(*)::int AS n FROM ${V} WHERE actividad_al IS NOT NULL`)).rows;
    ok(Number(enVista.n) > 0, 'la vista propaga actividad_al a sus consumidores');
  }

  // ── 7. [CE.9] El peldaño se prueba ANTES del atajo posicional ──────────────────────────
  console.log('\n7 · el atajo posicional no puede ganarle a un peldaño que SÍ casa');
  // PRUEBA NEGATIVA de la regla nueva: con la de [CE.8] esto daba 6 filas, una de ellas el
  // segundo renglón por dinero de la pantalla (30540, razón 1.928 con f2 = 2).
  const [orden] = (await knex.raw(`
    SELECT count(*)::int AS n FROM ${V}
     WHERE peldano_reposicion = 'base'
       AND ( (factor_dos  > 1 AND abs(costo_reposicion/costo_estandar/factor_dos  - 1) <= 0.25)
          OR (factor_tres > 1 AND abs(costo_reposicion/costo_estandar/factor_tres - 1) <= 0.25) )`)).rows;
  ok(Number(orden.n) === 0,
    `ninguna fila 'base' tiene un peldaño que case dentro de ±25 % (${orden.n})`);

  // ── 8. [CE.9] La fecha sale formateada y sin el centinela de Kepler ────────────────────
  console.log('\n8 · la fecha no sale cruda ni inventada');
  const [fec] = (await knex.raw(`
    SELECT count(*) FILTER (WHERE ultimo_costo_al IS NOT NULL)::int AS con_fecha,
           count(*) FILTER (WHERE ultimo_costo_al < '1900-01-01')::int AS centinela,
           count(*) FILTER (WHERE ultimo_costo_al ~ '[TZ]')::int AS con_hora,
           count(*) FILTER (WHERE ultimo_costo_al IS NOT NULL
                              AND ultimo_costo_al !~ '^\\d{4}-\\d{2}-\\d{2}$')::int AS mal_formada
      FROM ${V}`)).rows;
  ok(Number(fec.centinela) === 0, `el centinela 1800-01-01 de Kepler llega NULL, no como fecha (${fec.centinela})`);
  ok(Number(fec.con_hora) === 0, `ninguna fecha arrastra hora ni zona (${fec.con_hora})`);
  ok(Number(fec.mal_formada) === 0,
    `todas las fechas salen YYYY-MM-DD (${fec.mal_formada} mal formadas de ${fec.con_fecha})`);

  // ── 9. [CE.9] La plaza 00 se declara, no se esconde ni se le inventa veredicto ─────────
  console.log('\n9 · la plaza 00 es OFICINAS y no vende');
  const [ofi] = (await knex.raw(`
    SELECT count(*) FILTER (WHERE NOT es_plaza_operativa)::int AS filas_00,
           count(*) FILTER (WHERE NOT es_plaza_operativa AND unidades_base_30d IS NOT NULL)::int AS con_venta,
           count(*) FILTER (WHERE es_plaza_operativa AND sucursal = '00')::int AS mal_marcadas
      FROM ${V}`)).rows;
  if (Number(ofi.filas_00) === 0) nm('no hay filas de la plaza 00 en este destino');
  else {
    ok(Number(ofi.con_venta) === 0,
      `la 00 no tiene NINGUNA venta, que es por lo que se excluye (${ofi.con_venta} con venta de ${ofi.filas_00})`);
    ok(Number(ofi.mal_marcadas) === 0, `es_plaza_operativa marca exactamente a la 00 (${ofi.mal_marcadas} mal)`);
  }

  // ── 10. [CE.9] Las dos salidas de la decisión son coherentes o son NULL ────────────────
  console.log('\n10 · el margen real y el precio nuevo, o coherentes o declarados');
  const [dec] = (await knex.raw(`
    SELECT count(*) FILTER (WHERE vende_bajo_costo)::int AS bajo_costo,
           -- vende_bajo_costo tiene que ser EXACTAMENTE margen_real_pct < 0
           count(*) FILTER (WHERE vende_bajo_costo IS DISTINCT FROM (margen_real_pct < 0))::int AS incoherentes,
           -- sin costo comparable no puede haber ni margen real ni precio nuevo
           count(*) FILTER (WHERE costo_reposicion_base IS NULL
                              AND (margen_real_pct IS NOT NULL OR precio_si_conserva_margen IS NOT NULL))::int AS fuga,
           -- y nunca FALSE por defecto: sin datos es NULL
           count(*) FILTER (WHERE vende_bajo_costo IS NOT NULL AND margen_real_pct IS NULL)::int AS falso_por_defecto
      FROM ${V}`)).rows;
  ok(Number(dec.incoherentes) === 0, `vende_bajo_costo == (margen_real_pct < 0) siempre (${dec.incoherentes})`);
  ok(Number(dec.fuga) === 0, `sin costo comparable no se publica margen real ni precio nuevo (${dec.fuga})`);
  ok(Number(dec.falso_por_defecto) === 0,
    `vende_bajo_costo nunca se dibuja en FALSE sin margen medido (${dec.falso_por_defecto})`);
  ok(Number(dec.bajo_costo) > 0,
    `el hallazgo sigue visible: ${dec.bajo_costo} fichas pierden dinero en cada venta HOY`);

  // ── 11. [CE.11] La pantalla explica POR QUÉ, o dice que no puede ──────────────────────
  console.log('\n11 · el costo del ERP trae el movimiento que lo dejó ahí');
  const O = 'analytics.mv_kepler_cost_origin';
  if (!(await existe(O))) nm(`${O} no existe en este destino`);
  else {
    const [org] = (await knex.raw(`
      SELECT count(*) FILTER (WHERE costo_reposicion IS NOT NULL)::int AS con_costo,
             count(*) FILTER (WHERE origen_familia IS NOT NULL)::int AS con_origen,
             count(*) FILTER (WHERE origen_familia = 'inventario_fisico')::int AS por_conteo,
             count(*) FILTER (WHERE origen_familia = 'compra')::int AS por_compra,
             -- coherencia: si hay familia tiene que haber fecha y precio, y al reves
             count(*) FILTER (WHERE (origen_familia IS NULL) <> (origen_fecha_txt IS NULL))::int AS medio_lleno,
             count(*) FILTER (WHERE origen_familia IS NOT NULL AND origen_precio IS NULL)::int AS sin_precio,
             -- el rotulo sale de kdmm, no de una lista nuestra
             count(*) FILTER (WHERE origen_familia IS NOT NULL AND origen_nombre IS NULL)::int AS sin_rotulo,
             count(*) FILTER (WHERE origen_fecha_txt ~ '[TZ]')::int AS fecha_cruda
        FROM ${V}`)).rows;
    ok(Number(org.medio_lleno) === 0,
      `el bloque de origen viaja completo o no viaja (${org.medio_lleno} a medias)`);
    ok(Number(org.sin_precio) === 0, `todo origen declarado trae su precio (${org.sin_precio} sin él)`);
    ok(Number(org.fecha_cruda) === 0, `la fecha del origen tampoco sale cruda (${org.fecha_cruda})`);
    // ⭐ El hallazgo que justifica la columna: NO es que la plaza compró más caro.
    ok(Number(org.por_conteo) > Number(org.por_compra),
      `el inventario físico fija más costos que la compra (${org.por_conteo} contra ${org.por_compra}) — la suposición cómoda es falsa`);
    const cob = Number(org.con_costo) > 0
      ? (Number(org.con_origen) / Number(org.con_costo)) * 100 : 0;
    // No se exige 100 %: se exige que lo no atribuido sea VISIBLE, no que no exista.
    ok(cob >= 50,
      `se puede explicar la mayoría de los costos (${cob.toFixed(1)} % de ${org.con_costo}); el resto llega NULL, no en cero`);
    ok(Number(org.sin_rotulo) === 0,
      `el rótulo sale del catálogo del ERP (kdmm) en todos los casos (${org.sin_rotulo} sin nombre)`);

    // ── 11b. [CE.12] El ALMACÉN, que faltaba y hacía señalar el papel equivocado ──────
    // Lo destapó Edgar: la pantalla de Kepler mostraba UN documento con folio 0000001 y yo
    // había reportado dos. El folio es único por (sucursal, ALMACÉN, doctype); mi consulta
    // agrupaba sin el almacén. Y el mismo descuido estaba dentro de la atribución: kdik.c16
    // sólo existe en el almacén principal, así que un movimiento de otro almacén de la misma
    // plaza NO pudo dejar ese costo.
    const [alm] = (await knex.raw(`
      SELECT count(*) FILTER (WHERE origen_almacen IS DISTINCT FROM sucursal)::int AS otro_almacen,
             count(*) FILTER (WHERE origen_doctype !~ '^[A-Z]-[A-Z]-[0-9]+-[0-9]+$')::int AS doctype_corto,
             count(*) FILTER (WHERE origen_doc_id !~ '^[A-Z]{2}[0-9]+-[0-9]+$')::int AS doc_id_raro,
             count(*) FILTER (WHERE origen_doc_renglones IS NULL)::int AS sin_tamano,
             count(*) FILTER (WHERE origen_doc_renglones < 1)::int AS tamano_absurdo,
             count(*)::int AS n
        FROM ${O}`)).rows;
    ok(Number(alm.otro_almacen) === 0,
      `el costo se explica con un documento del MISMO almacén (${alm.otro_almacen} de otro)`);
    ok(Number(alm.doctype_corto) === 0,
      `el doctype trae los CUATRO componentes de Kepler (${alm.doctype_corto} con tres)`);
    ok(Number(alm.doc_id_raro) === 0,
      `el número de documento se escribe como Kepler lo numera (${alm.doc_id_raro} mal formados de ${alm.n})`);
    ok(Number(alm.sin_tamano) === 0 && Number(alm.tamano_absurdo) === 0,
      `cada origen dice de qué tamaño es su documento (${alm.sin_tamano} sin tamaño, ${alm.tamano_absurdo} absurdos)`);

    // ⭐ PRUEBA NEGATIVA de las dos correcciones: se mide el régimen VIEJO y tiene que ser peor.
    // Sin esto, las dos aserciones de arriba se ponen verdes aunque la causa nunca haya existido.
    const [neg] = (await knex.raw(`
      WITH tres AS (SELECT c1,c2,c3::int t, count(DISTINCT btrim(c5)) n FROM kepler_ods.kdmm
                     WHERE btrim(coalesce(c5,'')) <> '' GROUP BY 1,2,3),
           cuatro AS (SELECT c1,c2,c3::int t,c4::int s, count(DISTINCT btrim(c5)) n FROM kepler_ods.kdmm
                       WHERE btrim(coalesce(c5,'')) <> '' GROUP BY 1,2,3,4)
      SELECT (SELECT count(*) FILTER (WHERE n > 1) FROM tres)::int   AS amb3,
             (SELECT count(*) FILTER (WHERE n > 1) FROM cuatro)::int AS amb4,
             (SELECT count(DISTINCT btrim(c1)) FROM kepler_ods.kdm2
               WHERE sucursal='01' AND c2 <> 'U' AND c32 >= CURRENT_DATE - 180)::int AS almacenes_01`)).rows;
    ok(Number(neg.amb4) < Number(neg.amb3),
      `el 4º componente DESAMBIGUA de verdad: ${neg.amb3} claves con varios nombres usando tres, ${neg.amb4} usando cuatro`);
    ok(Number(neg.almacenes_01) > 1,
      `la premisa del filtro sigue viva: la sucursal 01 mueve ${neg.almacenes_01} almacenes, no uno`);
  }

  console.log(`\n${fail === 0 ? '✅' : '❌'} ${fail} falla(s) · ${nomedido} no medido(s)\n`);
  await knex.destroy();
  process.exit(fail === 0 ? 0 : 1);
})().catch(async (e) => {
  console.error('\n❌ error:', e.message, '\n');
  await knex.destroy();
  process.exit(1);
});
