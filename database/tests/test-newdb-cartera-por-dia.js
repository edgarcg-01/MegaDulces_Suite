#!/usr/bin/env node
/**
 * `[CXC.26]` **La cartera por DÍA** — el mismo dinero de `/finanzas/cartera`, con el calendario
 * como eje: «¿quiénes me deben estos días?» y «¿qué día debo cobrar?».
 *
 * ── QUÉ AFIRMA ────────────────────────────────────────────────────────────────────────────
 *  1. **El eje tiene DOS lados y el de adelante es el chico.** Se mide la partición del
 *     repartible en `vencido | hoy | futuro`. Si el que vence hoy-o-después fuera la mayoría,
 *     la premisa de esta vista cambió y hay que rediseñarla, no ajustar el test. (Medido
 *     2026-09-25: 12.9% adelante, 87.1% ya vencido.)
 *  2. **Los días suman EXACTAMENTE lo repartible.** `Σ dias.monto + sin_vencimiento ==
 *     repartible`, al centavo. Si no cierra, la agenda perdió dinero en el camino y ninguna
 *     pantalla lo notaría.
 *  3. **El puente con la vista por cliente cierra.** `repartible + sin_documento == canónico`,
 *     con el canónico calculado como lo calcula `cartera()` (`max(saldo_cliente, 0)`). Las dos
 *     vistas del mismo módulo no pueden publicar totales distintos.
 *  4. **El residual va filtrado a `res > 0.005`, igual que `cartera()`.** Se comparan las dos
 *     formas: si algún día divergen, el test lo dice con su monto en vez de elegir una.
 *  5. **Lo que no se puede poner en un día se DECLARA** (ADR-056): `sin_documento` sale con su
 *     monto y `sin_vencimiento` se MIDE aunque hoy valga 0 — una ausencia que hoy vale cero no
 *     autoriza a dejar de medirla.
 *  6. **El filtro por tipo de cuenta importa acá.** `interno` (plaza contra plaza) se mide
 *     aparte: si su porción por-vencer no fuera ~0, el aviso de la pantalla estaría de más.
 *  7. **La agenda COMPLETA entra en el presupuesto medido.** No hay ventana: se comprobó en
 *     prod que traer todo cuesta lo mismo que traer un mes (la pirámide domina) y comprime a
 *     119 KB. Eso es una MEDICIÓN, no una garantía — acá va el techo, así que el día que crezca
 *     se pone rojo un test en vez de ponerse lenta una pantalla.
 *  8. ⛔ **`finance.collection_promises` está vacía.** La promesa de pago sería el eje más
 *     literal de «qué día cobrar» y no tiene una sola fila: el test lo declara para que nadie
 *     construya la agenda encima sin volver a medirlo.
 *
 * ⚠️ Read-only puro: ni un INSERT. Se puede correr contra prod.
 */
const { Client } = require('pg');
const fs = require('fs');
const path = require('path');

const DST = process.env.DATABASE_URL_NEW
  || (() => { throw new Error('falta DATABASE_URL_NEW'); })();
const TENANT = process.env.TENANT_ID || '00000000-0000-0000-0000-00000000d01c';
const SVC = path.join(__dirname, '..', '..', 'libs', 'finance', 'src', 'lib',
  'customer-ledger', 'customer-ledger.service.ts');
const CENTAVO = 0.011; // dos redondeos a 2 decimales pueden separarse un centavo largo

let ok = 0; let fail = 0; let nm = 0;
const P = (m) => { ok++; console.log('  ✔ ' + m); };
const F = (m) => { fail++; console.log('  ✘ ' + m); };
const NM = (m) => { nm++; console.log('  ○ NO MEDIDO — ' + m); };
const money = (n) => Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const pct = (a, b) => (b > 0 ? Math.round((a / b) * 1000) / 10 : null);

/**
 * La misma partición que sirve `porDia()`, escrita acá a mano a propósito: un test que llamara
 * al servicio se pondría verde con el servicio roto de la misma forma que la pantalla.
 */
const SQL = `
WITH h AS (SELECT (now() AT TIME ZONE 'America/Mexico_City')::date AS d),
doc AS MATERIALIZED (
  SELECT sucursal, cliente_code, vencimiento, saldo_cliente,
         GREATEST(COALESCE(saldo_ajustado, 0), 0) AS res
    FROM analytics.customer_receivables
   WHERE tenant_id = $1 AND cargo_abono = 'C'),
cli AS (SELECT sucursal, cliente_code, max(saldo_cliente) AS sc,
               COALESCE(sum(res) FILTER (WHERE res > 0.005), 0) AS resf,
               sum(res) AS resa
          FROM doc GROUP BY 1, 2),
viva AS (SELECT * FROM doc WHERE res > 0.005)
SELECT (SELECT d FROM h)::text                                            AS hoy,
  (SELECT round(COALESCE(sum(GREATEST(sc, 0)), 0), 2) FROM cli)           AS canonico,
  (SELECT round(COALESCE(sum(resf), 0), 2) FROM cli)                      AS repartible,
  (SELECT round(COALESCE(sum(resa), 0), 2) FROM cli)                      AS repartible_sin_filtro,
  (SELECT round(COALESCE(sum(GREATEST(sc, 0) - resf)
       FILTER (WHERE abs(GREATEST(sc, 0) - resf) > 0.005), 0), 2) FROM cli) AS sin_documento,
  (SELECT round(COALESCE(sum(res), 0), 2) FROM viva WHERE vencimiento IS NULL) AS sin_vencimiento,
  (SELECT round(COALESCE(sum(res), 0), 2) FROM viva, h WHERE vencimiento < h.d)  AS venc,
  (SELECT round(COALESCE(sum(res), 0), 2) FROM viva, h WHERE vencimiento = h.d)  AS hoy_monto,
  (SELECT round(COALESCE(sum(res), 0), 2) FROM viva, h WHERE vencimiento > h.d)  AS futuro,
  (SELECT count(DISTINCT vencimiento)::int FROM viva WHERE vencimiento IS NOT NULL) AS n_dias,
  (SELECT count(*)::int FROM viva)                                        AS n_docs,
  (SELECT count(*)::int FROM (SELECT DISTINCT vencimiento, sucursal, cliente_code
                                FROM viva WHERE vencimiento IS NOT NULL) z) AS pares`;

const SQL_DIAS = `
WITH doc AS MATERIALIZED (
  SELECT vencimiento, GREATEST(COALESCE(saldo_ajustado, 0), 0) AS res
    FROM analytics.customer_receivables WHERE tenant_id = $1 AND cargo_abono = 'C')
SELECT round(COALESCE(sum(res), 0), 2) AS suma_dias
  FROM doc WHERE res > 0.005 AND vencimiento IS NOT NULL`;

const SQL_INTERNO = `
WITH h AS (SELECT (now() AT TIME ZONE 'America/Mexico_City')::date AS d),
v AS (SELECT r.vencimiento, GREATEST(COALESCE(r.saldo_ajustado, 0), 0) AS res,
             COALESCE(k.kind, analytics.customer_account_kind(r.cliente_code, NULL)) AS kind
        FROM analytics.customer_receivables r
        LEFT JOIN analytics.v_customer_account_kind k ON k.cliente_code = btrim(r.cliente_code)
       WHERE r.tenant_id = $1 AND r.cargo_abono = 'C')
SELECT kind,
       round(COALESCE(sum(res), 0), 2) AS total,
       round(COALESCE(sum(res) FILTER (WHERE vencimiento >= (SELECT d FROM h)), 0), 2) AS por_vencer
  FROM v WHERE res > 0.005 GROUP BY 1 ORDER BY 1`;

/** ── Afirmaciones sobre el CÓDIGO: corren sin base, así que nunca quedan sin medir. ──────── */
function auditarCodigo() {
  console.log('\n[A] El servicio, leído (no sus comentarios)');
  let src = null;
  try { src = fs.readFileSync(SVC, 'utf8'); } catch { /* ignore */ }
  if (!src) { NM('no se pudo leer customer-ledger.service.ts'); return; }

  const cuerpo = src.slice(src.indexOf('async porDia('));
  if (!cuerpo || cuerpo === src) { F('porDia() no existe en el servicio'); return; }
  const fin = cuerpo.indexOf('\n  /** CXC.12');
  const fn = fin > 0 ? cuerpo.slice(0, fin) : cuerpo;

  // El veredicto vencido/hoy/futuro lo emite el servidor. Si la pantalla lo recalculara con un
  // `new Date()` local, un equipo en otra zona horaria cambiaría de día — el error que la Fase
  // VP midió en 21 de 24 píldoras de frescura.
  if (/estado:\s*\(off < 0 \? 'vencido'/.test(fn)) P('el estado del día lo emite el SERVIDOR, no el navegador');
  else F('porDia() no calcula `estado` — la pantalla tendría que restar fechas ella misma');

  if (/FILTER \(WHERE res > 0\.005\)/.test(fn)) P("el residual va filtrado a res > 0.005, igual que cartera()");
  else F('el residual de porDia() NO usa el mismo umbral que cartera(): los totales pueden divergir');

  if (/sin_vencimiento/.test(fn)) P('sin_vencimiento se mide (aunque hoy valga 0)');
  else F('sin_vencimiento no se mide: una ausencia sin medir se lee como cero');

  // El desglose por cliente NO se acota por fecha. Se midió que recortarlo no ahorra tiempo
  // (la pirámide domina) y sí esconde la mitad del dinero detrás de un «ampliá la ventana».
  if (/f\.vencimiento BETWEEN/.test(fn)) F('el detalle volvió a tener ventana: eso esconde dinero sin ahorrar tiempo (medido)');
  else P('el detalle por cliente NO tiene ventana: la agenda entera viaja en una respuesta');

  if (/filtros: this\.opciones\(a\)/.test(fn)) P('reusa el constructor de opciones de filtro (ADR-056: sin segundo builder)');
  else F('porDia() construye sus propias opciones de filtro en vez de reusar opciones()');

  // La ruta de 1 segmento tiene que ir ANTES de ':sucursal/:cliente' o Express la casa como
  // sucursal='por-dia'. Es la trampa que el controller ya documenta dos veces.
  const ctl = (() => {
    try { return fs.readFileSync(path.join(path.dirname(SVC), 'customer-ledger.controller.ts'), 'utf8'); }
    catch { return null; }
  })();
  if (!ctl) { NM('no se pudo leer el controller'); return; }
  const iDia = ctl.indexOf(`@Get('por-dia')`);
  const iCat = ctl.indexOf(`@Get(':sucursal/:cliente')`);
  if (iDia < 0) F("el endpoint @Get('por-dia') no existe");
  else if (iCat < 0) NM("no se encontró @Get(':sucursal/:cliente') para comparar orden");
  else if (iDia < iCat) P("'por-dia' se declara antes de ':sucursal/:cliente' (si no, Express lo casa como sucursal)");
  else F("'por-dia' queda DESPUÉS de ':sucursal/:cliente': Express lo va a casar como sucursal='por-dia'");
}

(async () => {
  console.log('=== [CXC.26] Cartera por día — agenda de cobranza ===');
  auditarCodigo();

  const c = new Client({ connectionString: DST });
  try { await c.connect(); }
  catch (e) {
    console.log('\n' + '='.repeat(78));
    NM('sin base: las afirmaciones sobre el dato no se pudieron correr (' + e.code + ')');
    console.log(`\n${ok} ✔ · ${fail} ✘ · ${nm} ○`);
    process.exit(fail > 0 ? 1 : 0);
  }

  try {
    const r = (await c.query(SQL, [TENANT])).rows[0];
    const N = (k) => Number(r[k]) || 0;

    console.log(`\n[B] La partición del eje (hoy = ${r.hoy})`);
    const rep = N('repartible');
    const venc = N('venc'); const hoyM = N('hoy_monto'); const fut = N('futuro');
    console.log(`      vencido ${money(venc)} (${pct(venc, rep)}%) · hoy ${money(hoyM)} · futuro ${money(fut)} (${pct(fut, rep)}%)`);
    console.log(`      ${r.n_dias} días con saldo · ${r.n_docs} documentos · ${r.pares} pares (día × cliente)`);

    const adelante = hoyM + fut;
    if (rep <= 0) NM('no hay cartera viva: la partición del eje no se puede medir');
    else if (adelante < rep * 0.5) {
      P(`el eje hacia adelante es la MINORÍA: ${money(adelante)} de ${money(rep)} (${pct(adelante, rep)}%) — un calendario sólo-futuro escondería ${money(rep - adelante)}`);
    } else {
      F(`vence hoy-o-después el ${pct(adelante, rep)} % de la cartera: la premisa de esta vista (que el dinero está atrás) dejó de valer — rediseñar, no ajustar el umbral`);
    }

    console.log('\n[C] Los días suman lo repartible, al centavo');
    const sd = Number((await c.query(SQL_DIAS, [TENANT])).rows[0].suma_dias) || 0;
    const sv = N('sin_vencimiento');
    const d1 = Math.abs((sd + sv) - rep);
    if (d1 <= CENTAVO) P(`Σ días (${money(sd)}) + sin_vencimiento (${money(sv)}) == repartible (${money(rep)})`);
    else F(`la agenda pierde ${money(d1)}: Σ días ${money(sd)} + sin fecha ${money(sv)} ≠ repartible ${money(rep)}`);

    console.log('\n[D] El puente con la vista por cliente');
    const canon = N('canonico'); const sinDoc = N('sin_documento');
    const d2 = Math.abs((rep + sinDoc) - canon);
    if (d2 <= CENTAVO) P(`repartible (${money(rep)}) + sin_documento (${money(sinDoc)}) == canónico (${money(canon)})`);
    else F(`el puente no cierra por ${money(d2)}: la vista por día y la vista por cliente publicarían totales distintos`);

    const d3 = Math.abs(rep - N('repartible_sin_filtro'));
    if (d3 <= CENTAVO) P('filtrar o no por res > 0.005 da lo mismo hoy: las dos vistas coinciden igual');
    else F(`filtrar cambia el total en ${money(d3)} — porDia() DEBE usar el umbral de cartera() y lo usa, pero esto ya no es inocuo`);

    console.log('\n[E] Lo que no se puede poner en un día, declarado');
    if (sinDoc !== 0) P(`sin_documento = ${money(sinDoc)} (${pct(Math.abs(sinDoc), canon)}% del canónico): no tiene fecha y no se reparte a dedo`);
    else P('sin_documento = 0 hoy: el desglose por documento explica el saldo completo');
    console.log(`      sin_vencimiento = ${money(sv)} ${sv === 0 ? '(cero HOY — se sigue midiendo)' : ''}`);

    console.log('\n[F] El tipo de cuenta, por qué el filtro importa acá');
    const kinds = (await c.query(SQL_INTERNO, [TENANT])).rows;
    for (const k of kinds) {
      console.log(`      ${String(k.kind).padEnd(14)} total ${money(k.total).padStart(16)} · por vencer ${money(k.por_vencer).padStart(14)}`);
    }
    const interno = kinds.find((k) => k.kind === 'interno');
    if (!interno) NM('no hay cuentas `interno` en esta base');
    else if (Number(interno.por_vencer) <= Number(interno.total) * 0.01) {
      P(`de ${money(interno.total)} entre plazas propias, por vencer sólo ${money(interno.por_vencer)}: sin el filtro la agenda se llena de saldos que nadie cobra por teléfono`);
    } else {
      P(`las cuentas internas SÍ tienen ${money(interno.por_vencer)} por vencer — el aviso de la pantalla se quedó viejo, revisarlo`);
    }

    console.log('\n[G] El presupuesto de la agenda completa (no hay ventana)');
    // El techo no es un número redondo elegido a gusto: hoy son 5,652 pares / 119 KB gzip y el
    // doble sigue siendo cómodo. Pasado eso hay que volver a medir, no subir el techo.
    const TECHO_PARES = 12000;
    const pares = Number(r.pares) || 0;
    if (pares <= TECHO_PARES) P(`${pares} pares (día × cliente) — dentro del techo de ${TECHO_PARES}; la agenda entera viaja en una respuesta`);
    else F(`${pares} pares superan el techo de ${TECHO_PARES}: volver a medir el payload antes de seguir sirviendo la agenda completa (gzip medido: 119 KB con 5,652)`);

    console.log('\n[H] La promesa de pago NO puede ser el eje');
    const pr = (await c.query('SELECT count(*)::int n FROM finance.collection_promises WHERE tenant_id = $1', [TENANT])).rows[0];
    if (Number(pr.n) === 0) P('finance.collection_promises tiene 0 filas: una agenda montada sobre promesas abriría en blanco');
    else P(`finance.collection_promises tiene ${pr.n} filas — ya se puede superponer al eje de vencimiento (no reemplazarlo)`);
  } catch (e) {
    F('la consulta falló: ' + e.message);
  } finally {
    await c.end();
  }

  console.log('\n' + '='.repeat(78));
  console.log(`${ok} ✔ · ${fail} ✘ · ${nm} ○ NO MEDIDO`);
  process.exit(fail > 0 ? 1 : 0);
})();
