'use strict';
/**
 * ⭐⭐ `[CSU.11]` — **Las aplicaciones de Kepler se leen VIGENTES: nadie suma `kepler_ods.kdm5` crudo.**
 *
 * ── El incidente que la funda, medido en PROD el 2026-10-21 ────────────────────────────────
 *
 * Cuando un documento se cancela en Kepler, su cabecera queda en `kdm1.c43 = 'C'` (importe 0)
 * pero sus aplicaciones en `kdm5` CONSERVAN el monto. Quien suma `kdm5.c13` sin mirar la
 * cabecera cuenta dinero que no existe:
 *
 *     854 de 70,478 aplicaciones · cobros de cliente $6.8 M · pagos a proveedor $13.3 M
 *     Cortes/Sucursales: el cobrado de octubre inflado $171,986.56 (14 cobros cancelados)
 *
 * Ya se había corregido TRES veces por separado, cada consumidor con su propio filtro —y uno de
 * ellos (`v_route_credit_sales`) lo aplicaba a la fecha del cobro y no al monto—. La regla ahora
 * vive en UN lugar, `analytics.kepler_kdm5_vigente`, y esta compuerta impide que el siguiente
 * consumidor vuelva a leer la tabla cruda.
 *
 * ── Qué mira ───────────────────────────────────────────────────────────────────────────────
 *
 *   · `apps/` y `libs/` (TS/JS, sin pruebas): `FROM`/`JOIN kepler_ods.kdm5` y `('kepler_ods.kdm5')`
 *     de knex. Un comentario que la NOMBRA no es una lectura; `to_regclass('kepler_ods.kdm5')`
 *     tampoco.
 *   · `database/migrations-newdb/`: sólo las POSTERIORES a la vista canónica. Las anteriores son
 *     historia aplicada; lo que dejaron vivo en la base lo mira `--db`.
 *   · `--db` (no corre al push: necesita base): el CATÁLOGO. Una migración que recrea una vista
 *     desde `pg_get_viewdef` no deja el texto en el repo, así que sólo la base dice qué lee qué.
 *
 * ── El trinquete ───────────────────────────────────────────────────────────────────────────
 *
 * Lo que YA lee `kdm5` crudo está declarado abajo, contado y con su salida. No pone roja la
 * compuerta —la apagaría el primer día— pero el SIGUIENTE sí. Si un archivo baja, avisa para
 * que se baje el número: un permiso que sobra es un permiso que alguien usa.
 *
 * uso:  node scripts/check-kdm5-vigente.js [--probar-negativo] [--db]
 */
const fs = require('fs');
const path = require('path');

const RAIZ = path.resolve(__dirname, '..');
const DIRS = ['apps', 'libs'];
const MIGS = path.join('database', 'migrations-newdb');
/** La migración que crea la vista canónica: las posteriores ya no pueden leer kdm5 crudo. */
const MARCA_VISTA = '20261021102646';
const EXT = new Set(['.ts', '.js', '.mjs', '.cjs']);
const IGNORAR = new Set(['node_modules', 'dist', '.git', '.nx', 'coverage', 'tmp']);
const VISTA = 'analytics.kepler_kdm5_vigente';

/** Una LECTURA de la tabla cruda: en SQL o en el constructor de knex. */
const PATRONES = [
  /\b(?:FROM|JOIN)\s+kepler_ods\.kdm5\b/i,
  /(?<!to_regclass)\(\s*['"`]kepler_ods\.kdm5\b/i,
];

/** Unix siempre: `gate-push` cruza estas rutas con las del push, y su regex usa `/`. */
const rel = (...p) => path.join(...p).split(path.sep).join('/');

/**
 * El trinquete: lo que HOY lee `kdm5` crudo, por archivo. Bajar `n` al migrarlo; nunca subirlo sin
 * escribir acá por qué.
 */
const DEUDA_DECLARADA = [
  {
    rel: rel('libs', 'commercial', 'src', 'lib', 'commercial-analytics', 'commercial-analytics.service.ts'),
    n: 1,
    motivo: '`incomeDocPagos` ya excluye el cancelado con su propio JOIN a kdm1 (regla duplicada, no defecto)',
    salida: 'leer la vista y quitar el filtro propio',
  },
  {
    rel: rel('libs', 'finance', 'src', 'lib', 'expense-proofs', 'transferencias-del-gasto.ts'),
    n: 1,
    motivo: 'MUESTRA la transferencia cancelada marcada como tal (no la suma): necesita verla',
    salida: 'leer la vista para lo vigente y `analytics.kepler_cancelled_docs` para marcar lo cancelado',
  },
];

/** El archivo que documenta la trampa puede nombrarla sin ser culpable de ella. */
const EXENTOS = new Set([rel('scripts', 'check-kdm5-vigente.js')]);

/** En `--db`: objetos que leen kdm5 crudo A PROPÓSITO, con el porqué. */
const DB_PERMITIDOS = new Map([
  [VISTA, 'es la vista canónica: la única que debe leer la tabla cruda'],
  ['md.kdm5', 'espejo de compatibilidad 1:1 de la tabla (importadores legados), no suma nada'],
  ['analytics.income_bridge_src', 'casa cada aplicación con su documento y MARCA el cancelado a propósito ([CXC] casar_cancelados)'],
]);

/**
 * En `--db`, la otra mitad del mismo defecto: vistas/funciones que leen la CABECERA `kdm1` con columnas
 * de dinero (c14 IVA, c16 total, c84 descuento) y no mencionan `c43`. Medido el 2026-10-21: 8 objetos;
 * `expense_documents` ($3.18 M de cancelados) y `mv_supplier_prompt_discount` ($1.45 M de descuento
 * que no existió) se corrigen en `20261021121257`. Los demás quedan declarados con su porqué.
 */
const DB_KDM1_DECLARADOS = new Map([
  ['analytics.erp_sale_tickets', 'ticket POS U-D-10: el estatus c43 del ticket NO es señal (ERP_KEPLER.md); un ticket anulado ya sale en 0'],
  ['analytics.v_transfer_true_origin', 'traspasos: mide unidades/origen, no suma dinero'],
  ['analytics.erp_shipment_headers', 'embarques (logística): el total de un cancelado ya es 0; pendiente que no CUENTE el documento'],
  ['analytics.erp_shipment_billing', 'embarcado vs facturado: totales bien (c16 = 0), pero un cancelado cuenta en n_facturas — deuda CXC'],
  ['analytics.v_cfdi_emitido_match', 'cruce CFDI: un cancelado sale como «difiere_importe» — deuda de su dueño (IG)'],
  ['analytics.erp_sales_invoice_lines', 'líneas de factura (kdm2) de documentos cancelados — deuda: el reporte de cliente las muestra'],
]);

function archivos(dir, acc) {
  let entradas;
  try { entradas = fs.readdirSync(dir, { withFileTypes: true }); } catch { return acc; }
  for (const e of entradas) {
    if (IGNORAR.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) archivos(p, acc);
    else if (EXT.has(path.extname(e.name)) && !/\.(spec|test)\.[cm]?[jt]s$/.test(e.name)) acc.push(p);
  }
  return acc;
}

/** Un comentario que MENCIONA la tabla no es una lectura. */
function esComentario(linea) {
  const t = linea.trim();
  return t.startsWith('//') || t.startsWith('*') || t.startsWith('/*') || t.startsWith('--');
}

const esLectura = (linea) => !esComentario(linea) && PATRONES.some((p) => p.test(linea));

function revisar() {
  const lista = [];
  for (const d of DIRS) lista.push(...archivos(path.join(RAIZ, d), []));
  for (const f of archivos(path.join(RAIZ, MIGS), [])) {
    const marca = path.basename(f).slice(0, 14);
    if (/^\d{14}$/.test(marca) && marca > MARCA_VISTA) lista.push(f);
  }
  const hallazgos = [];
  for (const f of lista) {
    const r = rel(path.relative(RAIZ, f));
    if (EXENTOS.has(r)) continue;
    fs.readFileSync(f, 'utf8').split(/\r?\n/).forEach((linea, i) => {
      if (esLectura(linea)) hallazgos.push({ rel: r, n: i + 1, linea: linea.trim().slice(0, 110) });
    });
  }
  return hallazgos;
}

// ── Prueba negativa: una compuerta que nunca se vio en rojo es una intención ────────────────
if (process.argv.includes('--probar-negativo')) {
  const malos = [
    '    FROM kepler_ods.kdm5 m',
    '  LEFT JOIN kepler_ods.kdm5 x ON x.c11 = d.folio',
    "  .from('kepler_ods.kdm5 as m')",
    "  const q = trx('kepler_ods.kdm5').where('c2', 'U');",
    'select sum(c13) from kepler_ods.kdm5 where c8 = \'D\'',
  ];
  const buenos = [
    '    FROM analytics.kepler_kdm5_vigente m',                   // la forma correcta
    '// antes leía FROM kepler_ods.kdm5 crudo',                      // un comentario
    ' * Cobros = `kepler_ods.kdm5` aplicaciones',                    // documentación
    "  `(to_regclass('kepler_ods.kdm5') IS NOT NULL) AS existe`",  // sólo pregunta si existe
    '    FROM kepler_ods.kdm5_historia h',                        // otra tabla, mismo prefijo
    "const ORIGEN = 'kepler_ods.kdm5';",                            // una constante, no una lectura
  ];
  let fallas = 0;
  for (const l of malos) if (!esLectura(l)) { console.error(`  ✗ NO detectó: ${l.trim()}`); fallas++; }
  for (const l of buenos) if (esLectura(l)) { console.error(`  ✗ FALSO POSITIVO: ${l.trim()}`); fallas++; }
  // Y la ruta sale con `/`: si no, gate-push no la cruza con el push y la compuerta queda muda.
  if (rel('libs', 'x', 'y.ts') !== 'libs/x/y.ts') { console.error('  ✗ la ruta no sale en formato unix'); fallas++; }
  if (fallas) { console.error(`\n⛔ la prueba negativa falló en ${fallas} caso(s).`); process.exit(1); }
  console.log(`✓ prueba negativa: detecta los ${malos.length} casos malos y no marca los ${buenos.length} buenos`);
  console.log('  (la vista, un comentario, la documentación, to_regclass, otra tabla con el mismo prefijo, una constante).');
  process.exit(0);
}

// ── --db: el catálogo de la base, que es lo único que sabe qué lee qué ──────────────────────
if (process.argv.includes('--db')) {
  require('dotenv').config({ path: path.join(RAIZ, '.env'), quiet: true });
  const { Client } = require('pg');
  const url = process.env.CHECK_DB_URL || process.env.PROD_DB_URL;
  if (!url) { console.log('NO MEDIDO: sin CHECK_DB_URL ni PROD_DB_URL. El catálogo no se revisó.'); process.exit(1); }
  (async () => {
    const c = new Client({ connectionString: url, application_name: 'check-kdm5-vigente' });
    await c.connect();
    try {
      await c.query('BEGIN TRANSACTION READ ONLY');
      const r = await c.query(`
        SELECT n.nspname || '.' || cl.relname AS obj, 'vista' AS tipo FROM pg_class cl JOIN pg_namespace n ON n.oid = cl.relnamespace
         WHERE cl.relkind IN ('v', 'm') AND pg_get_viewdef(cl.oid) ~ 'kepler_ods\\.kdm5\\M'
        UNION ALL
        SELECT n.nspname || '.' || p.proname, 'función' FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname NOT IN ('pg_catalog', 'information_schema') AND p.prokind = 'f' AND p.prosrc ~ 'kepler_ods\\.kdm5\\M'
         ORDER BY 1`);
      let rojo = false;
      console.log('');
      for (const o of r.rows) {
        if (DB_PERMITIDOS.has(o.obj)) console.log(`·  ${o.obj} (${o.tipo}) — ${DB_PERMITIDOS.get(o.obj)}`);
        else { rojo = true; console.log(`⛔ ${o.obj} (${o.tipo}) lee kepler_ods.kdm5 crudo: suma aplicaciones de documentos cancelados. Debe leer ${VISTA}.`); }
      }
      const vista = (await c.query(`SELECT to_regclass('${VISTA}') AS x`)).rows[0].x;
      if (!vista) { rojo = true; console.log(`⛔ ${VISTA} no existe en esta base: falta 20261021102646_kepler_kdm5_vigente.`); }

      // ── Cabeceras kdm1 con dinero y sin c43 ──
      const k = await c.query(`
        WITH defs AS (
          SELECT n.nspname || '.' || cl.relname AS obj, pg_get_viewdef(cl.oid) AS d FROM pg_class cl JOIN pg_namespace n ON n.oid = cl.relnamespace
           WHERE cl.relkind IN ('v', 'm')
          UNION ALL
          SELECT n.nspname || '.' || p.proname, p.prosrc FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
           WHERE n.nspname NOT IN ('pg_catalog', 'information_schema') AND p.prokind = 'f')
        SELECT obj FROM defs WHERE d ~ 'kepler_ods\\.kdm1\\M' AND d !~ '\\mc43\\M' AND d ~ '\\mc(16|84|14)\\M' ORDER BY 1`);
      console.log('\n— cabeceras kdm1 con dinero (c14/c16/c84) que no miran c43 —');
      const vistos = new Set();
      for (const o of k.rows) {
        vistos.add(o.obj);
        if (DB_KDM1_DECLARADOS.has(o.obj)) console.log(`·  ${o.obj} — ${DB_KDM1_DECLARADOS.get(o.obj)}`);
        else { rojo = true; console.log(`⛔ ${o.obj} suma la cabecera de kdm1 sin excluir CANCELADOS (c43 = 'C'). Agregá el filtro o declaralo con su porqué.`); }
      }
      for (const [o] of DB_KDM1_DECLARADOS) if (!vistos.has(o)) console.log(`·  ${o} — ya mira c43 (o no existe): quitalo de DB_KDM1_DECLARADOS.`);
      console.log(rojo ? '\n⛔ compuerta en ROJO.\n' : `\n✓ En la base, sólo ${VISTA} y lo declarado leen kdm5 crudo.\n`);
      process.exitCode = rojo ? 1 : 0;
    } finally {
      await c.query('ROLLBACK').catch(() => {});
      await c.end();
    }
  })().catch((e) => { console.error('ERROR', e.message); process.exit(1); });
  return;
}

const hallazgos = revisar();
const porArchivo = new Map();
for (const h of hallazgos) porArchivo.set(h.rel, (porArchivo.get(h.rel) || 0) + 1);
let rojo = false;
console.log('');
for (const [r, n] of [...porArchivo].sort()) {
  const d = DEUDA_DECLARADA.find((x) => x.rel === r);
  if (!d) {
    rojo = true;
    console.log(`⛔ ${r} — ${n} lectura(s) de kepler_ods.kdm5 crudo, SIN declarar`);
    for (const h of hallazgos.filter((x) => x.rel === r)) console.log(`     ${r}:${h.n}  ${h.linea}`);
    console.log(`   Leé ${VISTA} (mismas columnas): kdm5 crudo trae las aplicaciones de documentos`);
    console.log('   CANCELADOS en Kepler con su monto completo. Ver GOTCHAS (kdm5 y cancelados).\n');
  } else if (n > d.n) {
    rojo = true;
    console.log(`⛔ ${r} — ${n} lecturas, pero sólo hay ${d.n} declaradas. El trinquete subió.\n`);
  } else if (n < d.n) {
    console.log(`·  ${r} — ${n} de ${d.n} declaradas: bajá el número en DEUDA_DECLARADA.\n`);
  } else {
    console.log(`·  ${r} — ${n} declarada(s): ${d.motivo}`);
    console.log(`   salida: ${d.salida}\n`);
  }
}
for (const d of DEUDA_DECLARADA) {
  if (!porArchivo.has(d.rel)) console.log(`·  ${d.rel} — ya no lee kdm5 crudo. Quitá su entrada de DEUDA_DECLARADA.\n`);
}
if (rojo) { console.log('⛔ compuerta en ROJO.\n'); process.exit(1); }
console.log(`✓ Ningún consumidor nuevo lee kepler_ods.kdm5 crudo (se lee ${VISTA}).\n`);
process.exit(0);
