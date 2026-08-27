/* eslint-disable no-console */
/**
 * CDC.7 — reconciliación de DELETEs del ODS. Borra de `kepler_ods` las filas que YA NO existen
 * en la réplica de su sucursal.
 *
 * POR QUÉ EXISTE. El ODS se pobló con el poll (`replicate-ods-live.js`), que es UPSERT-only:
 * **no puede ver un DELETE**. Después tomó el relevo el WAL (`ods-cdc-wal.js`), que sí los aplica
 * (handler `raw-delete`), pero el WAL sólo trae cambios ocurridos DESPUÉS de que existe su slot.
 * Resultado: todo lo borrado en Kepler antes de la ventana del WAL —o durante un hueco del
 * consumidor— queda en el ODS para siempre. Medido en prod el 2026-08-26:
 *
 *   tabla       fuente      ODS      Δ      residuo
 *   kdpord       77,343   81,148   +3,805    4.92%
 *   kdc22608     30,028   31,148   +1,120    3.73%   <- pólizas del MES ABIERTO
 *   kdii         66,534   66,667     +133    0.20%
 *   kdud          8,233    8,239       +6    0.07%
 *   kdc22607     41,953   41,953        0    0.00%   <- mes CERRADO: cuadra exacto
 *   total: ~5,064 filas sobre 4.59M (0.11%)
 *
 * El patrón es claro: el residuo está en lo que se sigue editando (mes abierto, pedidos), no en
 * el histórico. Y `kdm1`/`kdm2` salen NEGATIVOS (−0.03%): eso es atraso normal del CDC, no residuo.
 *
 * POR QUÉ IMPORTA AHORA. Sin esto no se puede repointear ningún importer al ODS: los seis feeds
 * contables (`import-expenses-polizas`, `import-ledger-chain`, `import-ap-findings`,
 * `import-bank-postings`, `import-kepler-polizas`, `import-sales-by-channel`) leen `kdc2YYMM`, y
 * un 3.73% de asientos fantasma entra directo a la balanza y al P&L de Maat.
 *
 * CÓMO. Corre on-prem (es el único lado que ve las dos verdades): lee las llaves de la réplica
 * `:5433/kepler_md_XX`, las compara con las del ODS para esa `sucursal`, y manda las huérfanas por
 * el sink `raw-delete` (que ya existe y borra por `(sucursal, PK)`).
 *
 * GUARDAS (borrar es irreversible, así que el default es no borrar):
 *   - dry-run salvo `--apply`.
 *   - si la réplica no responde o devuelve 0 filas y el ODS tiene filas → SKIP (nunca borra).
 *   - si las huérfanas superan `--max-pct` (default 20%) del total del ODS → SKIP + aviso: eso
 *     huele a réplica reconstruida/truncada, no a borrados reales.
 *   - tablas con más de `--max-keys` filas (default 300k) se omiten salvo `--include-big`: cargar
 *     3.7M llaves de `kdm2` en memoria por sucursal no vale la pena para un residuo negativo.
 *
 *   node database/importers/kepler/reconcile-ods-deletes.js                      # dry-run, todas
 *   node database/importers/kepler/reconcile-ods-deletes.js --tables=kdc22608,kdpord --apply
 *   node database/importers/kepler/reconcile-ods-deletes.js --branch=01 --apply
 */

const { Client } = require('pg');
const { ship } = require('../lib/sink');

const M = '00000000-0000-0000-0000-00000000d01c';
const DST = process.env.DATABASE_URL_NEW || 'postgresql://postgres:superoot@localhost:5433/postgres_platform';
const SRC_BASE = process.env.ODS_SOURCE_BASE || process.env.DATABASE_URL
  || 'postgresql://postgres:superoot@localhost:5433/postgres_platform';
const APPLY = process.argv.includes('--apply');
const INCLUDE_BIG = process.argv.includes('--include-big');
const argOf = (name, def) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : def;
};
const MAX_PCT = Number(argOf('max-pct', 20));
const MAX_KEYS = Number(argOf('max-keys', 300000));
const ONLY_TABLES = (argOf('tables', '') || '').split(',').map((s) => s.trim()).filter(Boolean);
const ONLY_BRANCH = argOf('branch', '');
const CHUNK = 5000;

// La 03 se llama kepler_pilot (histórico): el resto sigue kepler_md_<code>.
const localDbName = (code) => (code === '03' ? 'kepler_pilot' : `kepler_md_${code}`);
const branchUrl = (code) => SRC_BASE.replace(/\/[^/]*$/, '/' + localDbName(code));

// Tipos que acepta el handler raw-delete (el resto degrada a text del otro lado).
const TYPE_MAP = {
  text: 'text', 'character varying': 'text', character: 'text', name: 'text', uuid: 'text',
  numeric: 'numeric', 'double precision': 'double precision', real: 'real',
  integer: 'integer', bigint: 'bigint', smallint: 'smallint', boolean: 'boolean',
  date: 'date', 'timestamp without time zone': 'timestamp', 'timestamp with time zone': 'timestamptz',
};

async function main() {
  const dst = new Client({ connectionString: DST, ssl: /rlwy|railway|proxy/i.test(DST) ? { rejectUnauthorized: false } : false });
  await dst.connect();
  await dst.query(`SET statement_timeout='600s'`);
  console.log(`\n=== Reconciliación de DELETEs del ODS (${APPLY ? 'APPLY' : 'DRY-RUN'}) ===`);
  console.log(`  guardas: max-pct=${MAX_PCT}%  max-keys=${MAX_KEYS}${INCLUDE_BIG ? '  (--include-big)' : ''}\n`);

  // Sucursales presentes en el ODS = la verdad de qué ramas hay replicadas.
  let branches = (await dst.query(
    `SELECT DISTINCT btrim(sucursal) s FROM kepler_ods.ctl ORDER BY 1`)).rows.map((r) => r.s).filter(Boolean);
  if (!branches.length) {
    branches = (await dst.query(`SELECT DISTINCT btrim(sucursal) s FROM kepler_ods.doctype ORDER BY 1`)).rows.map((r) => r.s);
  }
  if (ONLY_BRANCH) branches = branches.filter((b) => b === ONLY_BRANCH);
  console.log(`  sucursales: ${branches.join(' ')}\n`);

  // Tablas del ODS con PK (sin PK no hay llave por la que borrar) y su tipo de columna.
  const meta = new Map();
  const pkRows = (await dst.query(`
    SELECT c.relname AS tabla, a.attname AS col, t.typname,
           format_type(a.atttypid, a.atttypmod) AS decl,
           array_position(k.conkey, a.attnum) AS pos
    FROM pg_constraint k
    JOIN pg_class c ON c.oid = k.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = ANY(k.conkey)
    JOIN pg_type t ON t.oid = a.atttypid
    WHERE n.nspname='kepler_ods' AND k.contype='p' AND c.relkind='r'
    ORDER BY c.relname, pos`)).rows;
  for (const r of pkRows) {
    if (!meta.has(r.tabla)) meta.set(r.tabla, []);
    meta.get(r.tabla).push({ name: r.col, type: TYPE_MAP[r.decl] || 'text' });
  }

  let tables = [...meta.keys()].filter((t) => !t.startsWith('_') && t !== 'ctl' && t !== 'shadow');
  if (ONLY_TABLES.length) tables = tables.filter((t) => ONLY_TABLES.includes(t));
  console.log(`  tablas del ODS con PK: ${tables.length}\n`);

  const resumen = [];
  const duplicados = [];
  const omitidasPorTamano = [];
  let totalBorradas = 0, totalSkip = 0;

  for (const code of branches) {
    let src;
    try {
      src = new Client({ connectionString: branchUrl(code), connectionTimeoutMillis: 8000, statement_timeout: 600000 });
      await src.connect();
    } catch (e) {
      console.log(`  ⚠ sucursal ${code}: no pude conectar a ${localDbName(code)} (${e.message.slice(0, 60)}) — OMITIDA sin borrar nada`);
      continue;
    }
    // Tablas que existen del lado origen (el ODS puede tener tablas que la rama no).
    const srcTables = new Set((await src.query(
      `SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
       WHERE n.nspname='md' AND c.relkind='r'`)).rows.map((r) => r.relname));

    let borradasRama = 0, revisadas = 0;
    for (const tabla of tables) {
      const cols = meta.get(tabla);
      const keyCols = cols.filter((c) => c.name !== 'sucursal');
      if (!keyCols.length) continue;                 // PK sólo (sucursal) → no hay llave comparable
      if (!srcTables.has(tabla)) continue;           // no existe en la rama

      const odsCount = Number((await dst.query(
        `SELECT count(*)::bigint n FROM kepler_ods.${tabla} WHERE btrim(sucursal)=$1`, [code])).rows[0].n);
      if (!odsCount) continue;
      if (odsCount > MAX_KEYS && !INCLUDE_BIG) {
        // Nunca en silencio: un cap invisible se lee como "revisé todo" cuando no revisé nada.
        omitidasPorTamano.push(`${code}/${tabla} (${odsCount})`);
        continue;
      }

      // LLAVE A PRUEBA DEL CORRIMIENTO DE TIMESTAMPS. El ODS guarda los `timestamp without time
      // zone` **+6h** respecto del origen (medido 2026-08-26: origen `2026-07-01 00:00:00` → ODS
      // `2026-07-01 06:00:00`; el pipeline los pasa por un Date de JS que los interpreta como hora
      // local MX y los reescribe como UTC). Con el timestamp crudo en la llave, NADA empareja: la
      // primera versión de este script reportó 1527/1527 huérfanas en `kdc22607` de un mes CERRADO
      // — y el guard de max-pct fue lo único que evitó borrar 1,527 asientos legítimos.
      // Solución sin constante mágica: si el origen guarda esa columna SIEMPRE a medianoche
      // (semántica de fecha, que es el caso en Kepler), la llave usa sólo el día — +6h no cruza el
      // día, así que ambos lados coinciden. Si hubiera hora real, no se puede comparar por llave
      // con el corrimiento presente: se OMITE la tabla en vez de adivinar.
      let bad = null;
      const parts = [];
      for (const c of keyCols) {
        if (!/timestamp|date/.test(c.type)) { parts.push(`btrim(${quote(c.name)}::text)`); continue; }
        const nz = Number((await src.query(
          `SELECT count(*)::bigint n FROM md.${tabla} WHERE ${quote(c.name)} IS NOT NULL AND ${quote(c.name)}::time <> '00:00:00'`)).rows[0].n);
        if (nz > 0) { bad = `${c.name} tiene hora real en ${nz} filas`; break; }
        parts.push(`to_char(date_trunc('day', ${quote(c.name)}), 'YYYY-MM-DD')`);
      }
      if (bad) {
        console.log(`  ⚠ ${code}/${tabla}: no comparable por llave (${bad}) mientras el ODS corra los timestamps — SKIP`);
        totalSkip++; continue;
      }
      const keyExpr = parts.join(`, chr(1), `);
      let srcKeys;
      try {
        srcKeys = new Set((await src.query(
          `SELECT concat(${keyExpr}) k FROM md.${tabla}`)).rows.map((r) => r.k));
      } catch (e) {
        console.log(`  ⚠ ${code}/${tabla}: falló la lectura del origen (${e.message.slice(0, 50)}) — SKIP`);
        totalSkip++; continue;
      }
      revisadas++;
      if (!srcKeys.size) {
        console.log(`  ⚠ ${code}/${tabla}: el origen devolvió 0 filas y el ODS tiene ${odsCount} — SKIP (nunca borro contra un origen vacío)`);
        totalSkip++; continue;
      }

      const sel = keyCols.map((c) => quote(c.name)).join(', ');
      const odsRows = (await dst.query(
        `SELECT ${sel}, concat(${keyExpr}) AS _k FROM kepler_ods.${tabla} WHERE btrim(sucursal)=$1`, [code])).rows;

      // DUPLICADOS (se reportan, NO se borran). Si la misma fila lógica aparece 2 veces con
      // timestamps distintos (00:00 y 06:00), no es residuo: es que el POLL y el WAL escriben el
      // mismo dato con renderizado distinto y, al estar el timestamp en la PK, el UPSERT no las
      // colapsa. Medido en prod 2026-08-26 en `kdc22608`: 1,120 filas extra repartidas en 6
      // sucursales (04: 1,105 filas a las 06:00 + 200 a las 00:00 = 200 grupos duplicados). Eso
      // DUPLICA asientos en la balanza. Elegir cuál sobra es decisión de quien arregle el pipeline
      // (la fuente fiel es el WAL: pgoutput entrega texto y no pasa por un Date de JS), así que acá
      // sólo se avisa.
      const vistas = new Set(); let dupes = 0;
      for (const r of odsRows) { if (vistas.has(r._k)) dupes++; else vistas.add(r._k); }
      if (dupes) {
        duplicados.push({ code, tabla, dupes, odsCount });
        console.log(`  ⚠ ${code}/${tabla}: ${dupes} filas DUPLICADAS de ${odsCount} (misma llave lógica dos veces) — no las borro, es el bug de timestamps del poll`);
      }

      const huerfanas = odsRows.filter((r) => !srcKeys.has(r._k));
      if (!huerfanas.length) continue;

      const pct = (huerfanas.length / odsCount) * 100;
      if (pct > MAX_PCT) {
        console.log(`  ⛔ ${code}/${tabla}: ${huerfanas.length}/${odsCount} huérfanas (${pct.toFixed(1)}% > ${MAX_PCT}%) — SKIP. Eso no parece borrado normal; revisá si la réplica se reconstruyó.`);
        totalSkip++; continue;
      }

      resumen.push({ code, tabla, huerfanas: huerfanas.length, odsCount, pct });
      console.log(`  ${APPLY ? '🗑' : '·'} ${code}/${tabla}: ${huerfanas.length} huérfanas de ${odsCount} (${pct.toFixed(2)}%)`);
      if (!APPLY) continue;

      const shipMeta = { table: tabla, pk: keyCols.map((c) => c.name), columns: [{ name: 'sucursal', type: 'text' }, ...keyCols] };
      for (let i = 0; i < huerfanas.length; i += CHUNK) {
        const rows = huerfanas.slice(i, i + CHUNK).map((r) => {
          const o = { sucursal: code };
          for (const c of keyCols) o[c.name] = r[c.name];
          return o;
        });
        // `client: dst` para que funcione en los DOS modos del sink: en `pg` aplica en proceso contra
        // esta conexión (el modo pg lanza si no se le pasa cliente) y en `http` lo ignora.
        const r = await ship('raw-delete', { rows, tenantId: M, client: dst, meta: shipMeta });
        borradasRama += Number(r && (r.rowCount ?? r)) || 0;
      }
    }
    console.log(`  sucursal ${code}: ${revisadas} tablas comparadas · ${APPLY ? borradasRama + ' filas borradas' : 'dry-run'}`);
    totalBorradas += borradasRama;
    await src.end();
  }

  console.log(`\n${'─'.repeat(70)}`);
  if (omitidasPorTamano.length) {
    console.log(`⚠ OMITIDAS POR TAMAÑO (${omitidasPorTamano.length}) — pasá --include-big para revisarlas:`);
    console.log('   ' + omitidasPorTamano.slice(0, 12).join(' · ') + (omitidasPorTamano.length > 12 ? ` … (+${omitidasPorTamano.length - 12})` : ''));
    console.log('   OJO: acá se esconde residuo real. Medido 2026-08-27: el delta GLOBAL de kdm2 era');
    console.log('   negativo (−1,159 = atraso del CDC) pero POR SUCURSAL había residuo (+484 en la 01,');
    console.log('   +150 en la 06, +28 en la 00) y eso descuadraba el tránsito de compras.');
  }
  if (!resumen.length) console.log('Sin residuo: el ODS coincide con las réplicas en todo lo comparado.');
  else {
    const porTabla = {};
    for (const r of resumen) porTabla[r.tabla] = (porTabla[r.tabla] || 0) + r.huerfanas;
    console.log('residuo por tabla: ' + Object.entries(porTabla).sort((a, b) => b[1] - a[1])
      .map(([t, n]) => `${t}=${n}`).join('  '));
  }
  if (duplicados.length) {
    const porTabla = {};
    for (const d of duplicados) porTabla[d.tabla] = (porTabla[d.tabla] || 0) + d.dupes;
    const tot = Object.values(porTabla).reduce((a, b) => a + b, 0);
    console.log(`\n⚠ DUPLICADOS (NO se borran acá): ${tot} filas · ` + Object.entries(porTabla)
      .sort((a, b) => b[1] - a[1]).map(([t, n]) => `${t}=${n}`).join('  '));
    console.log('   Causa: el poll (replicate-ods-live) escribe los timestamps +6h y el WAL no, y el');
    console.log('   timestamp está en la PK → la misma fila entra dos veces. Los dos carriles siguen');
    console.log('   corriendo (\\Tienda\\OdsLiveLoop + OdsFullMirror), así que esto crece a diario.');
    console.log('   Arreglo de raíz: completar el cutover CDC.6 (apagar el poll) o normalizar su');
    console.log('   renderizado de timestamps. Después, deduplicar quedándose con la fila del WAL.');
  }
  console.log(APPLY
    ? `APPLY — ${totalBorradas} filas borradas del ODS${totalSkip ? ` · ${totalSkip} skips` : ''}.`
    : `DRY-RUN — nada se borró. Corré con --apply para aplicarlo${totalSkip ? ` (${totalSkip} skips)` : ''}.`);
  await dst.end();
}

// Identificador de columna citado (las cN de Kepler son seguras, pero no adivinamos).
function quote(id) { return '"' + String(id).replace(/"/g, '""') + '"'; }

if (require.main === module) {
  main().catch((e) => { console.error('\nERROR: ' + e.message); process.exitCode = 1; });
}
module.exports = { main };
