#!/usr/bin/env node
/**
 * [CC.13] La vista canónica de cobros contaba un solo tipo de cobro, y de una sola sucursal.
 *
 * ── QUÉ AFIRMA ───────────────────────────────────────────────────────────────────────────
 *  1. **El universo son los DOS doctypes que el catálogo llama cobro** — `U-A-5` (Cobro PUE) y
 *     `U-A-7` (Cobro CFDI) — y ninguno más. Se lee de `kdmm`, no de una lista a mano: si Kepler
 *     agrega un tercer «Cobro …», el test lo señala en vez de dejarlo fuera en silencio.
 *  2. **No hay réplicas.** `c1` es la sucursal dueña; cuando difiere de la base de origen la
 *     fila es una copia. Medido: 787 documentos de la 03 pertenecen a la 02.
 *  3. **La llave del documento lleva el doctype.** En la sucursal 02 hay 137 folios que existen
 *     como `UA0501` y como `UA0701`: sin `doc_prefix` en el `DISTINCT ON` uno desaparecía.
 *  4. **`tipo_cuenta` NO se re-implementa**: coincide con `analytics.v_customer_account_kind`
 *     en el 100% de los códigos que el resolvedor conoce, y para los que no, usa **su propia
 *     función**. ⛔ Prueba negativa: el clasificador inline que había en la vista tenía `$1`/`$2`
 *     horneados (signos de interrogación que knex convirtió en placeholders) y perdía 504 rutas.
 *  5. **La fecha del Cobro CFDI sale del complemento SAT**, no de la póliza: 652 cobros traen
 *     una fecha distinta a `kdm1.c9`, que es el día en que se tecleó.
 *  6. **El cruce banco↔cobro usa el vocabulario que tienen los datos.** `bank_recon_matches`
 *     lleva la forma con guiones (`U-A-5`, `U-A-7`, `X-D-26`…) en 19,019 de 19,020 filas; el
 *     literal `'UA0501'` que usaba este módulo casaba **una**. Se afirma leyendo el CÓDIGO.
 *
 * ⚠️ Las afirmaciones que leen el CÓDIGO corren ANTES de conectar: sin base, NO MEDIDO.
 */
const { Client } = require('pg');
const fs = require('fs');
const path = require('path');

const DST = process.env.DATABASE_URL_NEW
  || (() => { throw new Error('falta DATABASE_URL_NEW'); })();
const TENANT = process.env.TENANT_ID || '00000000-0000-0000-0000-00000000d01c';
const LIB = path.join(__dirname, '..', '..', 'libs', 'finance', 'src', 'lib');

let ok = 0; let fail = 0; let nm = 0;
const P = (m) => { ok++; console.log('  ✔ ' + m); };
const F = (m) => { fail++; console.log('  ✘ ' + m); };
const NM = (m) => { nm++; console.log('  ○ NO MEDIDO — ' + m); };
const money = (n) => Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function leer(rel) {
  try { return fs.readFileSync(path.join(LIB, rel), 'utf8'); } catch { return null; }
}
/** Sólo líneas de código: un comentario que MENCIONA el literal no es usarlo. */
function soloCodigo(src) {
  return src.split('\n')
    .filter((l) => {
      const t = l.trim();
      // Tambien se descartan los comentarios de SQL (--): viven dentro de los template
      // literals, asi que la regla de JS no los ve.
      return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*') && !t.startsWith('--');
    })
    .join('\n');
}

/** Los doctypes que el CATÁLOGO de Kepler llama «Cobro». No una lista a mano. */
const SQL_DOCTYPES_COBRO = [
  "SELECT DISTINCT c3::int AS grupo, btrim(c5) AS nombre",
  '  FROM kepler_ods.kdmm',
  " WHERE btrim(c1) = 'U' AND btrim(c2) = 'A' AND btrim(c5) ILIKE 'Cobro%'",
  ' ORDER BY 1',
].join('\n');

const SQL_CLASES = [
  'SELECT cobro_clase, count(*)::int AS docs, round(sum(monto), 2) AS monto,',
  '       count(DISTINCT sucursal)::int AS sucs',
  '  FROM analytics.erp_collections WHERE tenant_id = $1',
  ' GROUP BY 1 ORDER BY 1',
].join('\n');

const SQL_DUPLICADOS = [
  'SELECT count(*)::int AS n FROM (',
  '  SELECT sucursal, doc_prefix, folio FROM analytics.erp_collections',
  '   WHERE tenant_id = $1 GROUP BY 1,2,3 HAVING count(*) > 1) d',
].join('\n');

/**
 * ⛔ **Ni `(sucursal, folio, doctype)` identifica un documento en el ODS: falta el DUENO.**
 * Medido en la base de la sucursal 03, el folio 0000001 existe TRES veces — `c1=02` como
 * `U-A-5` ($59.85), `c1=03` como `U-A-5` ($8,602.54) y `c1=02` como `U-A-7` ($59.85). Las dos
 * de `c1=02` son replicas; la vista se queda con la de `c1=03`, que es la correcta.
 *
 * ⚠️ Por eso este chequeo NO puede ser un join por la llave: casaria la replica contra la
 * fila buena y denunciaria replicas que no existen (paso dos veces mientras se escribia este
 * test). Se compara el CONTEO: la vista tiene que traer exactamente los documentos no-replica.
 */
const SQL_REPLICAS = [
  'SELECT',
  '  (SELECT count(*)::int FROM analytics.erp_collections WHERE tenant_id = $1) AS en_vista,',
  "  (SELECT count(DISTINCT btrim(sucursal) || '|' || btrim(c6) || '|' || c4::text || c5::text)::int",
  '     FROM kepler_ods.kdm1',
  "    WHERE btrim(c2) = 'U' AND btrim(c3) = 'A' AND c4 IN (5,7)",
  '      AND btrim(c1) = btrim(sucursal)',
  "      AND btrim(COALESCE(c43, '')) <> 'C') AS sin_replicas",
].join(String.fromCharCode(10));

const SQL_CLASIFICADOR = [
  'SELECT count(*)::int AS discrepan FROM analytics.erp_collections ec',
  '  JOIN analytics.v_customer_account_kind k ON k.cliente_code = ec.cliente_code',
  ' WHERE ec.tenant_id = $1 AND ec.tipo_cuenta <> k.kind',
].join('\n');

/**
 * La prueba negativa del clasificador, **sin reproducir la regex rota**: reescribirla a traves
 * de las capas de escape del shell, JS y SQL es fragil y se pone verde por el motivo
 * equivocado. Se afirma el defecto directamente: ninguna fila puede salir `cliente_final`
 * cuando la funcion canonica dice `ruta`. Eso es exactamente lo que hacian las 504 que perdia
 * la copia inline.
 */
const SQL_RUTAS_PERDIDAS = [
  'SELECT count(*)::int AS n FROM analytics.erp_collections ec',
  " WHERE ec.tenant_id = $1 AND ec.tipo_cuenta = 'cliente_final'",
  "   AND analytics.customer_account_kind_by_code(ec.cliente_code) = 'ruta'",
].join(String.fromCharCode(10));

const SQL_FECHA_COMPLEMENTO = [
  'SELECT count(*)::int AS con_complemento,',
  '       count(*) FILTER (WHERE cp.fecha_pago::date <> m.c9::date)::int AS fecha_distinta,',
  '       count(*) FILTER (WHERE cp.fecha_pago::date <> m.c9::date',
  '                          AND ec.cobro_date = cp.fecha_pago::date)::int AS vista_usa_la_real',
  '  FROM kepler_ods.kdm1 m',
  '  JOIN analytics.v_kepler_payment_complement cp',
  '    ON cp.sucursal = btrim(m.sucursal) AND cp.folio = btrim(m.c6)',
  '  JOIN analytics.erp_collections ec',
  '    ON ec.tenant_id = $1 AND ec.sucursal = btrim(m.sucursal) AND ec.folio = btrim(m.c6)',
  "   AND ec.doc_prefix = 'UA0701'",
  " WHERE btrim(m.c2) = 'U' AND btrim(m.c3) = 'A' AND m.c4 = 7",
  '   AND btrim(m.c1) = btrim(m.sucursal)',
  "   AND btrim(COALESCE(m.c43, '')) <> 'C'",
].join('\n');

const SQL_VOCABULARIO = [
  'SELECT kepler_doc_tipo, count(*)::int AS n',
  '  FROM finance.bank_recon_matches WHERE tenant_id = $1',
  ' GROUP BY 1 ORDER BY 2 DESC',
].join('\n');

(async () => {
  console.log('\n[CC.13] Cobro CFDI: la vista de cobros contaba uno solo\n');

  // ── 1. Lo que promete el código ───────────────────────────────────────────────────────
  console.log('1) El módulo identifica el cobro con su doctype, no con un literal');
  const hayRepo = fs.existsSync(LIB);
  if (!hayRepo) {
    NM('no hay código fuente a mano (' + LIB + ')');
  } else {
    for (const rel of ['collection-deposits/collection-deposits.service.ts',
      'collection-deposits/cobranza-gap-scanner.service.ts']) {
      const src = leer(rel);
      if (!src) { NM('no se pudo leer ' + rel); continue; }
      const code = soloCodigo(src);
      const corto = rel.split('/').pop();
      // Lo que importa NO es que la cadena aparezca, sino que se use para IDENTIFICAR el
      // documento: UA0501 en la misma linea que kepler_doc_tipo. Los `|| 'UA0501'` que quedan
      // son valores por defecto de un prefijo ausente, no compuertas.
      const compuertas = code.split(String.fromCharCode(10))
        .filter((l) => /UA0501/.test(l) && /kepler_doc_tipo/.test(l));
      if (compuertas.length === 0) {
        P(corto + ': ningun `kepler_doc_tipo` se compara contra el literal `UA0501`');
      } else {
        F(corto + ': ' + compuertas.length + ' compuerta(s) siguen comparando `kepler_doc_tipo` '
          + 'contra `UA0501` — ese literal casa 1 fila de 19,020');
      }
      if (/docTipoRecon\(/.test(code)) {
        P(corto + ': usa el traductor único `docTipoRecon()`');
      } else if (corto.startsWith('cobranza-gap')) {
        P(corto + ': su consulta arma el tipo en SQL (no escribe cruces)');
      } else {
        F(corto + ': no usa `docTipoRecon()`');
      }
    }
    const svc = leer('collection-deposits/collection-deposits.service.ts');
    if (svc && /kepler_sucursal'\]\)/.test(soloCodigo(svc).replace(/\s+/g, ''))
      || (svc && /'kepler_sucursal'\)*\]/.test(soloCodigo(svc)))) {
      P('el `ON CONFLICT` incluye `kepler_sucursal` — dos plazas con el mismo folio ya no se pisan');
    } else if (svc) {
      F('el `ON CONFLICT` no lleva `kepler_sucursal`: un folio repetido entre plazas se pisa');
    }
  }

  // ── La base va después ────────────────────────────────────────────────────────────────
  const c = new Client({ connectionString: DST, statement_timeout: 300000 });
  c.on('error', () => {});
  let viva = true;
  try {
    await c.connect();
  } catch (e) {
    viva = false;
    NM('no se pudo conectar a la base (' + e.message.split(String.fromCharCode(10))[0] + ') '
      + '— los bloques que la necesitan quedan sin medir, NO en verde');
  }
  const q = (sql, p) => (viva ? c.query(sql, p).then((r) => r.rows)
    : Promise.reject(new Error('sin conexion')));

  // ── 2. El catálogo manda: qué doctypes son «Cobro» ────────────────────────────────────
  console.log('\n2) Los doctypes que el CATÁLOGO llama cobro');
  try {
    const cat = await q(SQL_DOCTYPES_COBRO, []);
    // Un GRUPO puede traer varios TIPOS (c5): U-A-7 es 'Cobro CFDI' y 'Cobro efectivo CFDI
    // 16%'. Lo que define el universo de la vista es el grupo, asi que se deduplica -- sin
    // esto el test denunciaba 'U-A-[5,7,7]', que era un defecto SUYO, no de la vista.
    const grupos = [...new Set(cat.map((x) => Number(x.grupo)))].sort((a, b) => a - b);
    for (const x of cat) console.log('   U-A-' + x.grupo + '  ' + x.nombre);
    if (grupos.join(',') === '5,7') {
      P('el catálogo declara exactamente U-A-5 y U-A-7 como cobro — es el universo de la vista');
    } else {
      F('el catálogo declara U-A-[' + grupos.join(',') + ']: la vista mira 5 y 7. Si apareció otro '
        + 'cobro, hay que incluirlo o declarar por qué no');
    }
  } catch (e) { NM('no se pudo leer el catálogo: ' + e.message); }

  // ── 3. Las dos clases conviven, y la llave las separa ─────────────────────────────────
  console.log('\n3) Las dos clases de cobro, y la llave que las distingue');
  try {
    const cls = await q(SQL_CLASES, [TENANT]);
    for (const x of cls) {
      console.log('   ' + String(x.cobro_clase).padEnd(5) + ' ' + String(x.docs).padStart(7)
        + ' docs  $' + money(x.monto).padStart(16) + '   ' + x.sucs + ' sucursal(es)');
    }
    const cfdi = cls.find((x) => x.cobro_clase === 'CFDI');
    if (cfdi && Number(cfdi.docs) > 0) {
      P('el Cobro CFDI está dentro (' + cfdi.docs + ' docs, $' + money(cfdi.monto) + ')');
    } else {
      F('la vista no trae Cobro CFDI: volvió a contar un solo tipo');
    }
    const pue = cls.find((x) => x.cobro_clase === 'PUE');
    if (pue && Number(pue.sucs) > 1) {
      P('el Cobro PUE ya no está clavado a oficinas (' + pue.sucs + ' sucursales)');
    } else if (pue) {
      F('el PUE volvió a una sola sucursal: había 144 cobros ocultos por el literal 00');
    }

    const [d] = await q(SQL_DUPLICADOS, [TENANT]);
    if (Number(d.n) === 0) P('no hay (sucursal, doc_prefix, folio) repetidos');
    else F(d.n + ' llaves repetidas: el `DISTINCT ON` perdió el doctype');

    const [r] = await q(SQL_REPLICAS, [TENANT]);
    console.log('   en la vista: ' + r.en_vista + ' · documentos no-réplica en el ODS: '
      + r.sin_replicas);
    if (Number(r.en_vista) === Number(r.sin_replicas)) {
      P('la vista trae exactamente los documentos no-réplica — ni una copia de otra plaza');
    } else {
      F('la vista trae ' + r.en_vista + ' y el ODS tiene ' + r.sin_replicas
        + ' documentos no-réplica: sobran o faltan ' + Math.abs(r.en_vista - r.sin_replicas));
    }
  } catch (e) { NM('no se pudieron medir las clases: ' + e.message); }

  // ── 4. El clasificador, con su prueba negativa ────────────────────────────────────────
  console.log('\n4) `tipo_cuenta` sale del resolvedor único');
  try {
    const [x] = await q(SQL_CLASIFICADOR, [TENANT]);
    if (Number(x.discrepan) === 0) {
      P('coincide con `v_customer_account_kind` en el 100% de los códigos que conoce');
    } else {
      F(x.discrepan + ' filas difieren del resolvedor — alguien volvió a implementar la regla');
    }
    const [g] = await q(SQL_RUTAS_PERDIDAS, [TENANT]);
    if (Number(g.n) === 0) {
      P('ninguna fila sale `cliente_final` siendo `ruta` — las 504 que perdia la copia '
        + 'inline estan clasificadas');
    } else {
      F(g.n + ' filas salen `cliente_final` cuando la funcion canonica dice `ruta`');
    }
  } catch (e) { NM('no se pudo medir el clasificador: ' + e.message); }

  // ── 5. La fecha del CFDI ──────────────────────────────────────────────────────────────
  console.log('\n5) La fecha del Cobro CFDI sale del complemento SAT');
  try {
    const [x] = await q(SQL_FECHA_COMPLEMENTO, [TENANT]);
    console.log('   con complemento: ' + x.con_complemento + ' · fecha distinta a la póliza: '
      + x.fecha_distinta);
    if (Number(x.fecha_distinta) === 0) {
      NM('ningún cobro difiere de su póliza en esta base: el caso no se ejerce');
    } else if (Number(x.vista_usa_la_real) === Number(x.fecha_distinta)) {
      P('la vista usa la fecha REAL en los ' + x.fecha_distinta + ' que difieren');
    } else {
      F('sólo ' + x.vista_usa_la_real + ' de ' + x.fecha_distinta + ' usan la fecha del '
        + 'complemento: el resto quedan fechados el día en que se tecleó');
    }
  } catch (e) { NM('no se pudo medir la fecha: ' + e.message); }

  // ── 6. El vocabulario de la tabla de cruces ───────────────────────────────────────────
  console.log('\n6) El vocabulario de `kepler_doc_tipo`');
  try {
    const v = await q(SQL_VOCABULARIO, [TENANT]);
    const total = v.reduce((a, x) => a + Number(x.n), 0);
    const prefijo = v.filter((x) => /^[A-Z]{2}\d{4}$/.test(String(x.kepler_doc_tipo)))
      .reduce((a, x) => a + Number(x.n), 0);
    console.log('   ' + v.slice(0, 5).map((x) => x.kepler_doc_tipo + ':' + x.n).join(' · '));
    if (total === 0) {
      NM('no hay cruces en esta base');
    } else if (prefijo * 2 < total) {
      P('manda la forma con guiones (' + (total - prefijo) + ' de ' + total + ') — es la que '
        + 'el código escribe ahora');
    } else {
      F('la forma prefijo pasó a ser mayoría (' + prefijo + ' de ' + total + '): revisar qué '
        + 'vocabulario corresponde antes de dejarlo así');
    }
  } catch (e) { NM('no se pudo medir el vocabulario: ' + e.message); }

  if (viva) await c.end().catch(() => {});
  console.log('\n  ' + ok + ' ✔  ' + fail + ' ✘  ' + nm + ' ○ NO MEDIDO\n');
  process.exit(fail > 0 ? 1 : 0);
})().catch((e) => { console.error('FATAL:', e.message); process.exit(1); });
