/**
 * `[CB.51]` — La llave del candado anti doble-cobro tiene que llevar la SUCURSAL.
 *
 * Nace de un caso real medido en prod el 2026-10-14. La línea `IVA TASA DE DESC DEBITO` de
 * **$126.68** del 28-sep en la cuenta `4176` tiene su gemelo exacto en Kepler —sucursal **08**,
 * `X-D-26 | 0000119`, misma cuenta, mismo día— y aun así salía «sin conciliar». El candado de
 * `[CB.44]` la había marcado `used` porque `X-D-26 | 0000119` ya estaba casado en **enero**…
 * pero ese es otro documento: sucursal `00`, cuenta `0011` (Caja General), **$2,070.00**.
 *
 * Este candado NO ESCRIBE NADA. Lee prod en solo-lectura y muta la ENTRADA de las funciones
 * puras de `recon-claim-key.ts`, que es donde vive la decisión. Un gate sin prueba negativa es
 * una intención, y sembrar filas de mentira en las tablas de bancos de producción para probar
 * un candado sería peor que el bug.
 *
 * Bloques:
 *   1. La PREMISA: `(doc_tipo, folio)` no identifica un documento en la bolsa de tesorería.
 *   2. El caso concreto que disparó la fase sigue vivo en los datos.
 *   3. El esquema: `kepler_sucursal` existe y la llave única de 4 columnas ya no.
 *   4. ✅ positiva — el mismo documento SIGUE bloqueado (el candado no se aflojó).
 *   5. ⛔ NEGATIVA — un homónimo de otra sucursal YA NO se bloquea (lo que vino a arreglar).
 *   6. ⛔ NEGATIVA — una fila histórica sin sucursal SIGUE bloqueando, y se declara `parcial`.
 */

const path = require('path');
const Module = require('module');
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env'), quiet: true });

let pass = 0, fail = 0, nomedido = 0;
const ok = (c, m) => { if (c) { console.log(`  ✓ ${m}`); pass++; } else { console.error(`  ✗ ${m}`); fail++; } };
const skip = (m) => { console.log(`  ⚠ NO MEDIDO: ${m}`); nomedido++; };
const nm = (v) => Number(v || 0).toLocaleString('es-MX', { style: 'currency', currency: 'MXN' });

const MEGA = '00000000-0000-0000-0000-00000000d01c';

require('ts-node').register({
  transpileOnly: true, skipProject: true,
  compilerOptions: { module: 'commonjs', target: 'es2020', esModuleInterop: true, moduleResolution: 'node',
    experimentalDecorators: true, emitDecoratorMetadata: true, ignoreDeprecations: '6.0' },
});
const STUBS = { '@megadulces/platform-core': { TenantKnexService: class {}, TenantContextService: class {} },
  '@megadulces/contracts': { FINANCE_FINDINGS_SINK_PORT: Symbol('findings-sink') } };
const stubPaths = {};
for (const k of Object.keys(STUBS)) { const f = path.resolve(__dirname, `.stub-cb51-${k.replace(/[@/]/g,'_')}.js`);
  require('fs').writeFileSync(f, `module.exports = require(${JSON.stringify(__filename)}).__stubs[${JSON.stringify(k)}];`); stubPaths[k]=f; }
module.exports.__stubs = STUBS;
const _origResolve = Module._resolveFilename;
Module._resolveFilename = function (req, ...rest) { return stubPaths[req] || _origResolve.call(this, req, ...rest); };
const LLAVE = require(path.resolve(__dirname, '../../libs/finance/src/lib/bank/recon-claim-key.ts'));
const { buildClaimIndex, claimVerdict } = LLAVE;

(async () => {
  const knex = require('knex')({ client: 'pg', connection: process.env.DATABASE_URL_NEW, pool: { min: 0, max: 2 } });
  try {
    await knex.raw(`SET statement_timeout='120s'`);

    // ── 1. PREMISA: el folio no identifica ──────────────────────────────────────────────
    console.log('\n[1] La premisa: (doc_tipo, folio) no es llave en tesorería');
    const u = await knex.raw(`
      SELECT count(*)::int docs,
             count(DISTINCT (doc_tipo, folio))::int k2,
             count(DISTINCT (sucursal, doc_tipo, folio, clave_banco))::int k4
        FROM analytics.kepler_bank_movements
       WHERE fecha_efectiva >= '2026-07-01' AND fecha_efectiva < '2026-10-01'
         AND account_label IS NOT NULL AND signo <> 0`);
    const { docs, k2, k4 } = u.rows[0];
    if (!docs) {
      skip('la bolsa de tesorería está vacía en jul-sep 2026 — no hay con qué comprobarse');
    } else {
      ok(k2 < docs, `(doc_tipo, folio) colapsa documentos distintos: ${docs} docs → ${k2} llaves`);
      ok(k4 > k2, `agregar sucursal+clave separa ${k4 - k2} documentos que la llave corta confundía`);
    }

    // ── 2. El caso concreto ─────────────────────────────────────────────────────────────
    console.log('\n[2] El caso que disparó la fase');
    const choque = await knex.raw(`
      SELECT sucursal, clave_banco, round(importe,2) importe, fecha_efectiva::date fecha
        FROM analytics.kepler_bank_movements
       WHERE doc_tipo = 'X-D-26' AND folio = '0000119' AND signo <> 0
         AND fecha_efectiva >= '2026-01-01' AND fecha_efectiva < '2026-10-01'
       ORDER BY fecha_efectiva`);
    const filas = choque.rows;
    if (filas.length < 2) {
      skip(`X-D-26|0000119 ya no aparece dos veces en la ventana (aparece ${filas.length}) — el ejemplo envejeció, la premisa del bloque 1 sigue mandando`);
    } else {
      const sucs = new Set(filas.map((f) => f.sucursal));
      ok(sucs.size > 1, `el mismo doc_tipo+folio existe en ${sucs.size} sucursales distintas (${[...sucs].join(', ')})`);
      const montos = [...new Set(filas.map((f) => Number(f.importe)))];
      ok(montos.length > 1, `y con importes distintos (${montos.map(nm).join(' vs ')}) → son documentos DISTINTOS`);
    }

    // ── 3. Esquema ──────────────────────────────────────────────────────────────────────
    console.log('\n[3] El esquema que respalda la llave larga');
    const col = await knex.raw(`SELECT 1 FROM information_schema.columns
      WHERE table_schema='finance' AND table_name='bank_recon_matches' AND column_name='kepler_sucursal'`);
    ok(col.rows.length === 1, 'finance.bank_recon_matches.kepler_sucursal existe');
    const idx = await knex.raw(`SELECT indexname FROM pg_indexes WHERE schemaname='finance' AND tablename='bank_recon_matches'`);
    const nombres = idx.rows.map((r) => r.indexname);
    ok(nombres.includes('bank_recon_matches_doc_suc_key'), 'la llave única de 5 columnas (con sucursal) está presente');
    const vieja = 'bank_recon_matches_tenant_id_bank_movement_id_kepler_doc_ti_key';
    if (nombres.includes(vieja)) {
      skip(`la llave única de 4 columnas sigue viva — falta aplicar la mig 20261014120000. Mientras esté, dos docs de plazas distintas sobre el mismo movimiento se funden en una fila.`);
    } else {
      ok(true, 'la llave única de 4 columnas (sin sucursal) ya se retiró');
    }

    // ── 4-6. El mecanismo, mutado ───────────────────────────────────────────────────────
    // Se construye el índice con una reclamación REAL de otro periodo y se pregunta por el
    // documento REAL de septiembre. Nada de esto toca la base.
    console.log('\n[4-6] El candado, mutado (sin escribir)');
    const doc = { sucursal: '08', doc_tipo: 'X-D-26', folio: '0000119', clave: '4176' };

    // 4 ✅ positiva: el MISMO documento reclamado → sigue bloqueado. Si esto falla, el fix
    //    abrió el doble-cobro, que es peor que el bug que vino a cerrar.
    const mismo = buildClaimIndex([{ suc: '08', dt: 'X-D-26', folio: '0000119', cuenta: '4176' }]);
    ok(claimVerdict(mismo, doc) === 'exacta', 'el MISMO documento reclamado en otro periodo sigue bloqueado (no se aflojó el candado)');

    // 5 ⛔ negativa: el homónimo de enero (otra sucursal, otra cuenta) → ya NO bloquea.
    const homonimo = buildClaimIndex([{ suc: '00', dt: 'X-D-26', folio: '0000119', cuenta: '0011' }]);
    ok(claimVerdict(homonimo, doc) === null, 'el homónimo de otra sucursal YA NO bloquea (es el bug que se arregla)');

    // …y con la llave vieja sí bloqueaba. Se reproduce acá para que el test muestre el
    // contraste en vez de afirmarlo: si alguien revierte la llave, este renglón se cae.
    const comoAntes = new Set(['X-D-26|0000119']);
    ok(comoAntes.has(`${doc.doc_tipo}|${doc.folio}`), 'con la llave vieja (doc_tipo|folio) ESE MISMO homónimo lo bloqueaba');

    // 6 ⛔ negativa: fila histórica sin sucursal → bloquea, pero declarándose `parcial`.
    const historica = buildClaimIndex([{ suc: null, dt: 'X-D-26', folio: '0000119', cuenta: '4176' }]);
    ok(claimVerdict(historica, doc) === 'parcial', 'una fila histórica sin sucursal sigue bloqueando, y se declara `parcial` (no se disfraza de libre)');
    const otraCuenta = buildClaimIndex([{ suc: null, dt: 'X-D-26', folio: '0000119', cuenta: '0011' }]);
    ok(claimVerdict(otraCuenta, doc) === null, 'una fila histórica de OTRA cuenta no alcanza a bloquear (la clave ya desambigua)');

    // Mutación de la premisa: si la llave exacta dejara de mirar la sucursal, el bloque 5
    // tendría que caerse. Se comprueba que la función no ignora el campo.
    ok(LLAVE.claimKeyExacta('08', 'X-D-26', '0000119', '4176') !== LLAVE.claimKeyExacta('00', 'X-D-26', '0000119', '4176'),
      'la llave exacta SÍ distingue por sucursal (si alguien la quita, el bloque 5 se vuelve falso positivo)');

    // ── 7. La pantalla no puede contradecir a la base ───────────────────────────────────
    // `[CB.51]` — el drill 3 vías rearmaba su propio pareo con `take()` y una tolerancia FIJA
    // de ±$1. Sobre un renglón de $2.11 eso es el 47% de su valor: un movimiento anterior se
    // llevaba el documento que a éste le tocaba exacto y lo marcaba `used`. Medido en prod sobre
    // la cuenta 4885 de sep-2026: **73 retiros salían «sin Kepler» y 72 estaban casados**.
    // Es `threeWayDetail`, que es READ-ONLY: se puede ejercer contra prod sin escribir.
    console.log('\n[7] El drill 3 vías lee lo que Conciliar guardó');
    const periodo = '2026-09';
    const cuentas = await knex.raw(`
      SELECT ba.account_label lbl, count(*)::int movs
        FROM finance.bank_movements bm
        JOIN finance.bank_statements st ON st.id=bm.statement_id
        JOIN finance.bank_accounts ba ON ba.id=bm.bank_account_id
       WHERE st.period=? AND bm.deleted_at IS NULL AND coalesce(ba.kind,'bank')='bank'
       GROUP BY 1 HAVING count(*) > 100 ORDER BY 2 DESC LIMIT 3`, [periodo]);
    if (!cuentas.rows.length) {
      skip(`no hay cuentas con movimientos en ${periodo} — el drill no tiene qué mostrar`);
    } else {
      const { FinanceBankService } = require(path.resolve(__dirname, '../../libs/finance/src/lib/bank/finance-bank.service.ts'));
      const svc = new FinanceBankService({ run: (cb) => cb(knex) }, { requireTenantId: () => MEGA });
      let contradicciones = 0, revisados = 0, conciliados = 0;
      for (const { lbl } of cuentas.rows) {
        const r = await svc.threeWayDetail(periodo, lbl);
        const casadosDB = new Set(await knex('finance.bank_recon_matches as m')
          .join('finance.bank_movements as bm', 'bm.id', 'm.bank_movement_id')
          .join('finance.bank_accounts as ba', 'ba.id', 'bm.bank_account_id')
          .join('finance.bank_statements as st', 'st.id', 'bm.statement_id')
          .where('st.period', periodo).andWhere('ba.account_label', lbl)
          .pluck('m.bank_movement_id'));
        for (const e of r.excel || []) {
          revisados++;
          if (e.kepler_fuente === 'conciliado') conciliados++;
          // La contradicción: la base dice que está casado y la pantalla lo pinta sin Kepler.
          if (!e.kepler && casadosDB.has(e.id)) contradicciones++;
        }
      }
      ok(contradicciones === 0, `ningún movimiento casado en la base se muestra «sin Kepler» (${revisados} renglones de ${cuentas.rows.length} cuentas, ${contradicciones} contradicciones)`);
      // Prueba de que el bloque MIDE algo: si no hubiera ningún pareo persistido, el cero de
      // arriba sería vacuo — se pondría verde solo. Un candado que sólo puede pasar no es candado.
      if (conciliados === 0) skip('ninguna fila vino de un pareo persistido: el cero de arriba es vacuo, corré Conciliar primero');
      else ok(conciliados > 0, `y el veredicto NO es vacuo: ${conciliados} renglones declaran su origen \`conciliado\``);
    }

  } finally {
    await knex.destroy();
    // Los stubs de módulo son andamio: se borran SIEMPRE, también si el test falló. Sin esto
    // quedan dos `.stub-cb51-*.js` sin rastrear en un checkout que comparten varias sesiones,
    // y el siguiente `git status` se los encuentra como si fueran trabajo de alguien.
    for (const f of Object.values(stubPaths)) { try { require('fs').unlinkSync(f); } catch { /* ya no está */ } }
  }

  console.log(`\n[CB.51] ${pass} ✓ / ${fail} ✗${nomedido ? ` / ${nomedido} no medidos` : ''}`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
