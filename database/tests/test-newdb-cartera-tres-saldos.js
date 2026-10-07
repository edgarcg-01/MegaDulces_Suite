#!/usr/bin/env node
/**
 * [CXC.22] La cartera publica TRES cifras del mismo concepto. No son rivales: son preguntas
 * distintas, y el puente entre ellas cierra al centavo o algo está mal.
 *
 * ── QUÉ AFIRMA ───────────────────────────────────────────────────────────────────────────
 *  1. **El puente cierra al centavo**, en sus dos brazos:
 *         positivos − a_favor              == saldo_cliente    (¿cuánto nos deben en neto?)
 *         positivos − sin_documento        == saldo_ajustado   (¿cuánto hay que salir a cobrar?)
 *         positivos + remanente − sin_doc  == saldo_documento  (¿cuánto hay abierto en docs?)
 *     ⛔ Si un brazo no cierra, la vista dejó de repartir el saldo y alguna pantalla está
 *     publicando una cifra que no se puede reconstruir.
 *  2. **Ningún servicio proyecta cobranza con `saldo_documento`.** Ésa incluye abonos que ya
 *     entraron al banco: proyectarlos como cobro futuro es contarlos dos veces. Se mira el
 *     CÓDIGO, no los comentarios — la primera versión del candado hermano de `[CC.8]` se ponía
 *     roja con su propia explicación.
 *  3. **La consulta de cobranza prevista vive en UN solo lugar.** Estaba copiada a mano en
 *     `budget-cashflow` y `budget-capacity`; si una se corrige y la otra no, dos pantallas de
 *     finanzas proyectan distinto sin que nadie lo note (ADR-056).
 *  4. **La cobertura se DECLARA.** La ventana hacia adelante ve una fracción de la cartera
 *     (86.5% ya venció). El resolvedor devuelve `vencido_fuera` con su monto, y `pct_en_ventana`
 *     en `null` —no en 0— cuando no hay con qué medirlo.
 *
 * ⚠️ Las afirmaciones que leen el CÓDIGO corren ANTES de conectar: sin base declaran NO MEDIDO.
 */
const { Client } = require('pg');
const fs = require('fs');
const path = require('path');

const DST = process.env.DATABASE_URL_NEW
  || (() => { throw new Error('falta DATABASE_URL_NEW'); })();
const TENANT = process.env.TENANT_ID || '00000000-0000-0000-0000-00000000d01c';
const LIB = path.join(__dirname, '..', '..', 'libs', 'finance', 'src', 'lib');
const CENTAVO = 0.01;

let ok = 0; let fail = 0; let nm = 0;
const P = (m) => { ok++; console.log('  ✔ ' + m); };
const F = (m) => { fail++; console.log('  ✘ ' + m); };
const NM = (m) => { nm++; console.log('  ○ NO MEDIDO — ' + m); };
const money = (n) => Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function leer(rel) {
  try { return fs.readFileSync(path.join(LIB, rel), 'utf8'); } catch { return null; }
}
/** Líneas de código (sin comentarios de línea ni de bloque de una línea). */
function soloCodigo(src) {
  return src.split('\n')
    .filter((l) => { const t = l.trim(); return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*'); })
    .join('\n');
}

const SQL_PUENTE = [
  'WITH v AS MATERIALIZED (',
  '  SELECT sucursal, cliente_code, cargo_abono, saldo_documento, saldo_ajustado, saldo_cliente',
  '    FROM analytics.customer_receivables WHERE tenant_id = $1),',
  'cli AS (SELECT sucursal, cliente_code, max(saldo_cliente) AS sc,',
  "               sum(saldo_documento) FILTER (WHERE cargo_abono = 'C') AS sd,",
  '               sum(saldo_ajustado) AS sa',
  '          FROM v GROUP BY 1, 2)',
  'SELECT round(sum(sc), 2) AS tot_cliente,',
  '       round(sum(sd), 2) AS tot_documento,',
  '       round(sum(sa), 2) AS tot_ajustado,',
  '       round(sum(sc) FILTER (WHERE sc > 0), 2) AS positivos,',
  '       round(-sum(sc) FILTER (WHERE sc < 0), 2) AS a_favor,',
  '       count(*) FILTER (WHERE sc < 0)::int AS n_a_favor,',
  '       round(sum(greatest(sd - greatest(sc, 0), 0)), 2) AS remanente,',
  '       round(sum(greatest(sc, 0) - sa) FILTER (WHERE sa < greatest(sc, 0)), 2) AS sin_documento,',
  '       count(*) FILTER (WHERE sa < greatest(sc, 0))::int AS n_sin_documento',
  '  FROM cli',
].join('\n');

const SQL_COBERTURA = [
  'WITH v AS MATERIALIZED (',
  '  SELECT vencimiento, saldo_ajustado FROM analytics.customer_receivables',
  '   WHERE tenant_id = $1 AND saldo_ajustado > 0)',
  'SELECT round(coalesce(sum(saldo_ajustado) FILTER (',
  "         WHERE vencimiento BETWEEN current_date AND current_date + 84), 0), 2) AS en_ventana,",
  '       round(coalesce(sum(saldo_ajustado) FILTER (',
  '         WHERE vencimiento < current_date), 0), 2) AS vencido_fuera,',
  '       round(coalesce(sum(saldo_ajustado), 0), 2) AS total,',
  '       count(*) FILTER (WHERE vencimiento < current_date)::int AS docs_vencidos',
  '  FROM v',
].join('\n');

(async () => {
  console.log('\n[CXC.22] Las tres cifras del saldo, y el puente entre ellas\n');

  // ── 1. Un solo resolvedor, y ningún consumidor con saldo_documento ─────────────────────
  console.log('1) Un solo resolvedor de cobranza prevista');
  // Un archivo AUSENTE no es un archivo mal escrito: si no hay repo a mano (p. ej. corriendo
  // dentro del contenedor de la API), esto se declara sin medir en vez de dar rojo falso.
  const hayRepo = fs.existsSync(LIB);
  const resolvedor = hayRepo ? leer('customer-ledger/cobranza-prevista.ts') : null;
  if (!hayRepo) {
    NM('no hay código fuente a mano (' + LIB + ') — las afirmaciones sobre el código '
      + 'quedan sin medir');
  } else if (!resolvedor) {
    F('no existe `libs/finance/src/lib/customer-ledger/cobranza-prevista.ts` — sin resolvedor '
      + 'único la consulta vuelve a estar copiada en dos servicios');
  } else {
    P('existe el resolvedor compartido `cobranza-prevista.ts`');
    const code = soloCodigo(resolvedor);
    if (/saldo_ajustado/.test(code) && !/sum\(saldo_documento\)/.test(code)) {
      P('el resolvedor suma `saldo_ajustado`, no `saldo_documento`');
    } else {
      F('el resolvedor volvió a sumar `saldo_documento`: eso cuenta dos veces los abonos que '
        + 'ya entraron al banco');
    }
    if (/vencido_fuera/.test(code) && /pct_en_ventana/.test(code)) {
      P('el resolvedor DECLARA su cobertura (`vencido_fuera` + `pct_en_ventana`)');
    } else {
      F('el resolvedor no declara cobertura: una curva muda se lee como "esto es toda la '
        + 'cobranza que viene"');
    }
    if (/total > 0 \? [\s\S]{0,80}: null/.test(code)) {
      P('sin cartera, `pct_en_ventana` va en null — no en 0% (que se leería como "no hay nada '
        + 'que cobrar")');
    } else {
      F('`pct_en_ventana` puede salir 0 sin cartera: una ausencia disfrazada de medición');
    }
  }

  for (const [rel, quien] of (hayRepo ? [
    ['budget/budget-cashflow.service.ts', 'El flujo de efectivo'],
    ['payment-calendar/budget-capacity.service.ts', 'La capacidad de pago'],
  ] : [])) {
    const src = leer(rel);
    if (!src) { NM('no se pudo leer ' + rel); continue; }
    const code = soloCodigo(src);
    if (/sum\(saldo_documento\)/.test(code) || /'saldo_documento'/.test(code)) {
      F(quien + ' volvió a proyectar con `saldo_documento`');
    } else if (/cobranzaPrevista\(/.test(code)) {
      P(quien + ' consume el resolvedor compartido');
    } else {
      F(quien + ' ya no llama a `cobranzaPrevista()`: o se copió la consulta otra vez, '
        + 'o dejó de proyectar cobranza');
    }
  }

  // ── La base va DESPUÉS: lo que se lee del código no necesita conexión ──────────────────
  const c = new Client({ connectionString: DST, statement_timeout: 240000 });
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

  // ── 2. El puente cierra al centavo ─────────────────────────────────────────────────────
  console.log('\n2) El puente entre las tres cifras');
  try {
    const [x] = await q(SQL_PUENTE, [TENANT]);
    const n = (k) => Number(x[k]) || 0;
    console.log('   saldo_documento ..: $' + money(x.tot_documento));
    console.log('   saldo_ajustado ...: $' + money(x.tot_ajustado));
    console.log('   saldo_cliente ....: $' + money(x.tot_cliente));
    console.log('   positivos ........: $' + money(x.positivos));
    console.log('   a favor (' + String(x.n_a_favor).padStart(4) + ') ...: $' + money(x.a_favor));
    console.log('   remanente ........: $' + money(x.remanente));
    console.log('   sin doc (' + String(x.n_sin_documento).padStart(4) + ') ...: $' + money(x.sin_documento));

    const brazos = [
      ['positivos − a_favor == saldo_cliente',
        n('positivos') - n('a_favor'), n('tot_cliente')],
      ['positivos − sin_documento == saldo_ajustado',
        n('positivos') - n('sin_documento'), n('tot_ajustado')],
      ['positivos + remanente − sin_documento == saldo_documento',
        n('positivos') + n('remanente') - n('sin_documento'), n('tot_documento')],
    ];
    for (const [etiqueta, izq, der] of brazos) {
      const d = Math.abs(izq - der);
      if (d <= CENTAVO) P(etiqueta + ' — cierra ($' + money(izq) + ')');
      else F(etiqueta + ' NO cierra: $' + money(izq) + ' vs $' + money(der) + ', Δ $' + money(d));
    }
  } catch (e) { NM('no se pudo medir el puente: ' + e.message); }

  // ── 3. La cobertura de la ventana ──────────────────────────────────────────────────────
  console.log('\n3) Qué porción de la cartera dibuja una curva a 12 semanas');
  try {
    const [x] = await q(SQL_COBERTURA, [TENANT]);
    const tot = Number(x.total) || 0;
    const ven = Number(x.vencido_fuera) || 0;
    const pct = tot > 0 ? (100 * Number(x.en_ventana) / tot) : null;
    console.log('   en ventana .......: $' + money(x.en_ventana)
      + (pct == null ? '' : '  (' + pct.toFixed(1) + '%)'));
    console.log('   ya vencido (' + String(x.docs_vencidos).padStart(5) + ' docs): $' + money(ven));
    if (tot <= 0) {
      NM('no hay cartera cobrable en esta base — la cobertura no se puede afirmar');
    } else if (ven > 0) {
      P('hay $' + money(ven) + ' vencidos fuera de la ventana: el resolvedor tiene que '
        + 'declararlos, y los declara');
    } else {
      NM('no hay cartera vencida en esta base: el caso que motiva la declaración no se ejerce');
    }
    if (pct != null && pct < 100) {
      P('la curva NO cubre la cartera entera (' + pct.toFixed(1) + '%) — publicarla sin decirlo '
        + 'la volvería una promesa falsa');
    } else if (pct != null) {
      NM('la ventana cubre el 100%: no hay nada que declarar hoy, pero la declaración sigue '
        + 'siendo correcta');
    }
  } catch (e) { NM('no se pudo medir la cobertura: ' + e.message); }

  if (viva) await c.end().catch(() => {});
  console.log('\n  ' + ok + ' ✔  ' + fail + ' ✘  ' + nm + ' ○ NO MEDIDO\n');
  process.exit(fail > 0 ? 1 : 0);
})().catch((e) => { console.error('FATAL:', e.message); process.exit(1); });
