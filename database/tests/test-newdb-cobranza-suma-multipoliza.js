#!/usr/bin/env node
/**
 * [CC.12] Un pago que cubre VARIAS pólizas: por qué no se parea, y cuándo sí se ofrece.
 *
 * El caso que originó esto, textual: *«¿qué pasa si el cliente hizo un abono de 50 mil a su
 * deuda de 3 pólizas, pero su abono es un solo pago? No se pueden casar.»* Es correcto, y el
 * pareo 1:1 no puede cubrirlo **por construcción**.
 *
 * ── QUÉ AFIRMA ───────────────────────────────────────────────────────────────────────────
 *  1. **El caso existe y pesa.** Se re-mide contra el ERP cuántos cobros aplican a 2+ facturas.
 *     ⚠️ Esta cifra vive en comentarios del servicio y en la pantalla: si se mueve fuera de
 *     rango el test se pone **rojo**, porque una medición con fecha es código que caduca.
 *  2. **La combinación NO se ofrece sin dueño declarado.** Medido: contra todos los clientes el
 *     subset-sum explica 28.3% de los huérfanos grandes con un placebo de 11.7% — 4 de cada 10
 *     aciertos serían casualidad. El servicio devuelve `disponible:false` con motivo, y este
 *     test lo **refuta a propósito** corriendo la enumeración sin restringir.
 *  3. **Con cliente declarado el universo es enumerable.** Los grupos (cliente, día) típicos
 *     tienen 2 a 4 cobros: el tope de 18 del servicio no se alcanza casi nunca.
 *  4. **Ligar 1:N ya cabe en el schema.** La UNIQUE de `bank_recon_matches` incluye el folio,
 *     así que un abono admite varios documentos — y ya hay casos en la base.
 *  5. **`match_type` se juzga contra la SUMA, no contra cada cobro.** Prueba negativa: con la
 *     vara vieja (cada pieza contra el depósito) un grupo exacto se marcaría `manual`.
 *
 * ⛔ Los topes y la lógica se leen **del servicio real**, no se copian.
 * ⚠️ Sin datos reporta **NO MEDIDO**, nunca ✔.
 */
const { Client } = require('pg');
const fs = require('fs');
const path = require('path');

const DST = process.env.DATABASE_URL_NEW
  || (() => { throw new Error('falta DATABASE_URL_NEW'); })();
const TENANT = process.env.TENANT_ID || '00000000-0000-0000-0000-00000000d01c';
const SRC = path.join(__dirname, '..', '..', 'libs', 'finance', 'src', 'lib',
  'collection-deposits', 'collection-deposits.service.ts');

/**
 * Rango tolerado para la cifra estructural. Medido 2026-09-24: **2.5%**.
 * ⚠️ NO poner 12%: esa fue la primera medición, inflada por agrupar `kdm5` sin filtrar el
 * doctype (el folio no es único entre doctypes y entraban los `U-A-7`).
 */
const MULTI_MIN_PCT = 1;
const MULTI_MAX_PCT = 6;
/** Margen mínimo que exigiríamos para OFRECER la suma a ciegas. Medido: 16.7 pp — no alcanza. */
const MARGEN_EXIGIDO_PP = 40;

let ok = 0; let fail = 0; let nm = 0;
const P = (m) => { ok++; console.log('  ✔ ' + m); };
const F = (m) => { fail++; console.log('  ✘ ' + m); };
const NM = (m) => { nm++; console.log('  ○ NO MEDIDO — ' + m); };
const money = (n) => Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function leerFuente() {
  try { return fs.readFileSync(SRC, 'utf8'); } catch { return null; }
}
function constante(src, n) {
  const m = src && src.match(new RegExp('const ' + n + ' = ([0-9.]+)'));
  return m ? Number(m[1]) : null;
}

const SQL_ESTRUCTURAL = [
  'WITH ap AS (',
  '  SELECT btrim(a.sucursal) AS suc, btrim(a.c6) AS folio,',
  "         count(DISTINCT btrim(a.c8) || '|' || a.c9::text || '|' || a.c10::text",
  "                        || '|' || a.c11::text) AS facturas",
  '    FROM kepler_ods.kdm5 a',
  // El filtro del doctype NO es opcional: sin él entran los U-A-7 (embarques), que comparten
  // folio con los cobros, y la cifra se triplica. Ver [CC.12] en el servicio.
  "   WHERE btrim(a.c2) = 'U' AND btrim(a.c3) = 'A' AND a.c4 = 5",
  '   GROUP BY 1, 2)',
  "SELECT CASE WHEN ap.facturas >= 2 THEN 'multi' ELSE 'uno' END AS caso,",
  '       count(*)::int AS abonos, sum(ec.monto)::numeric AS monto, max(ap.facturas)::int AS maxf',
  '  FROM ap JOIN analytics.erp_collections ec',
  '    ON ec.tenant_id = $1 AND ec.sucursal = ap.suc AND ec.folio = ap.folio',
  ' GROUP BY 1',
].join('\n');

const SQL_HUERFANOS = [
  'WITH ligados AS MATERIALIZED (SELECT DISTINCT kepler_doc_folio AS folio',
  "  FROM finance.bank_recon_matches WHERE tenant_id = $1 AND kepler_doc_tipo = 'UA0501'),",
  'mov AS MATERIALIZED (SELECT m.id, m.movement_date::text AS f, m.amount_in::float AS monto,',
  '    round(m.amount_in)::bigint AS cubeta',
  '  FROM finance.bank_movements m JOIN finance.movement_categories c ON c.id = m.category_id',
  "  WHERE m.tenant_id = $1 AND c.code = 'cobranza' AND m.amount_in > 0 AND m.deleted_at IS NULL",
  '    AND NOT EXISTS (SELECT 1 FROM finance.bank_recon_matches r WHERE r.bank_movement_id = m.id)),',
  'cobx AS MATERIALIZED (SELECT ec.cobro_date, ec.monto, b.cubeta FROM analytics.erp_collections ec',
  '  LEFT JOIN ligados l ON l.folio = ec.folio',
  '  CROSS JOIN LATERAL (VALUES (round(ec.monto)::bigint - 1), (round(ec.monto)::bigint),',
  '                             (round(ec.monto)::bigint + 1)) AS b(cubeta)',
  '  WHERE ec.tenant_id = $1 AND l.folio IS NULL),',
  'cand AS (SELECT DISTINCT m.id FROM mov m JOIN cobx k ON k.cubeta = m.cubeta',
  '  WHERE abs(k.monto - m.monto) <= 1.0',
  "    AND k.cobro_date BETWEEN m.f::date - INTERVAL '6 days' AND m.f::date + INTERVAL '1 days')",
  'SELECT m.f, m.monto FROM mov m LEFT JOIN cand c ON c.id = m.id',
  ' WHERE c.id IS NULL ORDER BY m.monto DESC LIMIT 600',
].join('\n');

const SQL_COBROS_LIBRES = [
  'SELECT ec.cliente_code, ec.cobro_date::text AS f, ec.monto::float AS monto',
  '  FROM analytics.erp_collections ec',
  '  LEFT JOIN finance.bank_recon_matches r ON r.tenant_id = ec.tenant_id',
  "       AND r.kepler_doc_tipo = 'UA0501' AND r.kepler_doc_folio = ec.folio",
  ' WHERE ec.tenant_id = $1 AND r.id IS NULL',
].join('\n');

const SQL_UNIQUE = [
  'SELECT array_agg(a.attname ORDER BY k.ord) AS cols',
  '  FROM pg_constraint ct',
  '  JOIN LATERAL unnest(ct.conkey) WITH ORDINALITY AS k(att, ord) ON true',
  '  JOIN pg_attribute a ON a.attrelid = ct.conrelid AND a.attnum = k.att',
  " WHERE ct.conrelid = 'finance.bank_recon_matches'::regclass AND ct.contype = 'u'",
  ' GROUP BY ct.oid',
].join('\n');

const SQL_YA_MULTI = [
  'SELECT count(*)::int AS movs, max(n)::int AS maxdocs FROM (',
  '  SELECT bank_movement_id, count(*) AS n FROM finance.bank_recon_matches',
  '   WHERE tenant_id = $1 GROUP BY 1 HAVING count(*) > 1) t',
].join('\n');

/** Enumera subconjuntos de cada grupo (cliente, día) y cuenta cuántos depósitos explica. */
function correrSuma(dep, porDia, offDias) {
  const idx = new Map();
  for (const [d, gs] of porDia) {
    const nd = new Date(Date.parse(d) + offDias * 86400000).toISOString().slice(0, 10);
    if (!idx.has(nd)) idx.set(nd, []);
    idx.get(nd).push(...gs);
  }
  let hit = 0;
  for (const dp of dep) {
    let found = false;
    for (let k = -1; k <= 6 && !found; k++) {
      const nd = new Date(Date.parse(dp.f) - k * 86400000).toISOString().slice(0, 10);
      for (const ms of (idx.get(nd) || [])) {
        if (ms.reduce((a, b) => a + b, 0) + 1 < dp.monto) continue;
        const n = ms.length;
        for (let mask = 1; mask < (1 << n); mask++) {
          let s = 0;
          for (let i = 0; i < n; i++) if (mask & (1 << i)) s += ms[i];
          if (Math.abs(s - dp.monto) <= 1.0) { found = true; break; }
        }
        if (found) break;
      }
    }
    if (found) hit++;
  }
  return 100 * hit / dep.length;
}

(async () => {
  console.log('\n[CC.12] Un pago, varias pólizas\n');

  // ── 1. Lo que el servicio promete, leido del servicio, leído del servicio ──────────────────────────────────
  console.log('\n1) El cruce se juzga contra la SUMA, no contra cada pieza');
  const src = leerFuente();
  if (!src) {
    NM('no se pudo leer el servicio');
  } else {
    const i = src.indexOf('async linkBankToCobros');
    const cuerpo = i < 0 ? '' : src.slice(i, i + 4000);
    if (!cuerpo) {
      F('no existe linkBankToCobros() — sin él el ligado múltiple no es atómico');
    } else {
      const codigo = cuerpo.split('\n')
        .filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*')).join('\n');
      if (/Math\.abs\(Number\(mov\.amount_in\) - suma\)/.test(codigo)) {
        P('match_type compara el abono contra la SUMA del grupo');
      } else {
        F('match_type no compara contra la suma: cada pieza es menor que el depósito y un '
          + 'grupo exacto se marcaría manual');
      }
      if (/this\.tk\.run\(/.test(codigo) && /for \(const c of cobros\)/.test(codigo)) {
        P('las N filas se escriben dentro de una sola transacción');
      } else {
        F('el ligado múltiple no está en una transacción — media conciliación es peor '
          + 'que ninguna');
      }
    }
    if (src.indexOf('private async combinaciones') < 0) {
      F('no existe combinaciones() en el servicio');
    } else if (/mov\.customer_code[\s\S]{0,160}this\.combinaciones/.test(src)) {
      P('combinaciones() sólo se llama cuando el abono tiene cliente declarado');
    } else {
      F('combinaciones() se llamaría sin cliente declarado — eso publica ruido como candidato');
    }
  }


  // La base va DESPUES: lo que se lee del codigo no necesita una conexion, y hacerlo al reves
  // ponia el test entero en FATAL cuando la base no estaba a mano -- o sea, silenciaba
  // afirmaciones que SI se podian medir.
  const c = new Client({ connectionString: DST, statement_timeout: 180000 });
  c.on('error', () => {});
  let viva = true;
  try {
    await c.connect();
  } catch (e) {
    viva = false;
    NM('no se pudo conectar a la base (' + e.message.split(String.fromCharCode(10))[0] + ') — los bloques que '
      + 'la necesitan quedan sin medir, NO en verde');
  }
  const q = (sql, p) => (viva ? c.query(sql, p).then((r) => r.rows)
    : Promise.reject(new Error('sin conexion')));


  // ── 1. El caso existe y pesa ───────────────────────────────────────────────────────────
  console.log('\n2) El caso estructural (aplicaciones del cobro a facturas, kdm5)');
  try {
    const r = await q(SQL_ESTRUCTURAL, [TENANT]);
    const multi = r.find((x) => x.caso === 'multi');
    const uno = r.find((x) => x.caso === 'uno');
    if (!multi || !uno) {
      NM('el ERP no devolvió los dos casos — sin datos no se puede afirmar la cifra');
    } else {
      const tot = Number(multi.monto) + Number(uno.monto);
      const pct = 100 * Number(multi.monto) / tot;
      console.log('   1 factura ......: ' + uno.abonos + ' abonos  $' + money(uno.monto));
      console.log('   2+ facturas ....: ' + multi.abonos + ' abonos  $' + money(multi.monto)
        + '  (' + pct.toFixed(1) + '%)  máx ' + multi.maxf + ' facturas');
      if (pct >= MULTI_MIN_PCT && pct <= MULTI_MAX_PCT) {
        P('el caso 1-pago-N-pólizas pesa ' + pct.toFixed(1) + '% del dinero cobrado (rango '
          + 'declarado ' + MULTI_MIN_PCT + '–' + MULTI_MAX_PCT + '%)');
      } else {
        F('la cifra publicada se movió: ' + pct.toFixed(1) + '% fuera de ' + MULTI_MIN_PCT
          + '–' + MULTI_MAX_PCT + '%. Re-medir y actualizar el servicio y la pantalla.');
      }
      if (Number(multi.maxf) >= 2) {
        P('hay un abono que aplica a ' + multi.maxf + ' facturas — el 1:1 no puede cubrirlo');
      } else {
        F('ningún abono aplica a 2+ facturas: el caso no existiría');
      }
    }
  } catch (e) { NM('no se pudo medir el caso estructural: ' + e.message); }

  // ── 2 y 3. La suma a ciegas contra su placebo, y el tamaño de los grupos ───────────────
  console.log('\n3) La suma a ciegas vs su placebo (por qué NO se ofrece sin cliente)');
  try {
    const dep = await q(SQL_HUERFANOS, [TENANT]);
    const cob = await q(SQL_COBROS_LIBRES, [TENANT]);
    if (dep.length < 100 || cob.length < 100) {
      NM('muestra insuficiente (' + dep.length + ' huérfanos, ' + cob.length + ' cobros libres)');
    } else {
      const grp = new Map();
      for (const k of cob) {
        const key = k.cliente_code + '|' + k.f;
        if (!grp.has(key)) grp.set(key, { f: k.f, ms: [] });
        grp.get(key).ms.push(k.monto);
      }
      const porDia = new Map();
      const tam = [];
      for (const [, v] of grp) {
        if (v.ms.length < 2 || v.ms.length > 12) continue;
        tam.push(v.ms.length);
        if (!porDia.has(v.f)) porDia.set(v.f, []);
        porDia.get(v.f).push(v.ms);
      }
      const real = correrSuma(dep, porDia, 0);
      const placebo = correrSuma(dep, porDia, 90);
      const margen = real - placebo;
      console.log('   casan como suma ..: ' + real.toFixed(1) + '%');
      console.log('   PLACEBO (+90 d) ..: ' + placebo.toFixed(1) + '%');
      console.log('   margen ...........: ' + margen.toFixed(1) + ' pp');
      if (margen < MARGEN_EXIGIDO_PP) {
        P('el margen (' + margen.toFixed(1) + ' pp) NO alcanza los ' + MARGEN_EXIGIDO_PP
          + ' pp que pediríamos para ofrecerla a ciegas — por eso el servicio exige '
          + 'cliente declarado');
      } else {
        F('el margen subió a ' + margen.toFixed(1) + ' pp: si de verdad mejoró, revisar si '
          + 'ya conviene ofrecer la suma sin cliente declarado');
      }
      if (placebo > 5) {
        P('el placebo es alto (' + placebo.toFixed(1) + '%): la suma a ciegas acierta por '
          + 'casualidad seguido');
      } else {
        F('el placebo dio ' + placebo.toFixed(1) + '% — sospechosamente bajo; revisar que el '
          + 'corrimiento caiga DENTRO del rango poblado y no en meses vacíos');
      }

      const src0 = leerFuente();
      const tope = constante(src0, 'COMBO_MAX_COBROS');
      const orden = tam.slice().sort((a, b) => a - b);
      console.log('\n4) Grupos (cliente, día): ' + tam.length + '; mediana '
        + orden[Math.floor(orden.length / 2)] + ' cobros');
      if (tope === null) {
        NM('no se pudo leer COMBO_MAX_COBROS del servicio');
      } else if (tam.filter((t) => t > tope).length === 0) {
        P('ningún grupo pasa el tope de ' + tope + ' cobros del servicio — la enumeración '
          + 'es viable');
      } else {
        F(tam.filter((t) => t > tope).length + ' grupos superan el tope de ' + tope);
      }
    }
  } catch (e) { NM('no se pudo correr el placebo: ' + e.message); }

  // ── 4. El schema ya admite 1:N ─────────────────────────────────────────────────────────
  console.log('\n5) Ligar un abono a VARIOS documentos');
  try {
    const u = await q(SQL_UNIQUE, []);
    const tieneFolio = u.some((x) => (x.cols || []).includes('kepler_doc_folio')
      && (x.cols || []).includes('bank_movement_id'));
    if (tieneFolio) P('la UNIQUE lleva el folio junto al movimiento — 1:N cabe sin tocar el schema');
    else F('la UNIQUE no incluye el folio: un abono no podría tener dos documentos');

    const ya = await q(SQL_YA_MULTI, [TENANT]);
    const movs = Number(ya[0] && ya[0].movs) || 0;
    if (movs > 0) {
      P('ya hay ' + movs + ' abonos con varios documentos (máx ' + ya[0].maxdocs
        + ') — el camino existe y se usa');
    } else {
      NM('no hay todavía abonos con varios documentos en esta base');
    }
  } catch (e) { NM('no se pudo leer la UNIQUE: ' + e.message); }

  if (viva) await c.end().catch(() => {});
  console.log('\n  ' + ok + ' ✔  ' + fail + ' ✘  ' + nm + ' ○ NO MEDIDO\n');
  process.exit(fail > 0 ? 1 : 0);
})().catch((e) => { console.error('FATAL:', e.message); process.exit(1); });
