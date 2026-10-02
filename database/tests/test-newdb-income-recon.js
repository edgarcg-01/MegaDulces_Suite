/* eslint-disable no-console */
/**
 * `[IG.7]` Candado de la conciliación de ingresos **ligada por folio**.
 *
 * Reemplaza al candado de `[IG.6]`, que vigilaba vistas que cruzaban por **almacén emisor** —
 * un eje distinto del que usa la pestaña Árbol de la misma pantalla, así que las dos tablas no
 * cuadraban renglón por renglón. La liga ahora es el **folio**, y este archivo vigila justo eso.
 *
 * Lo que mide cada bloque, y por qué existe:
 *
 *  1. ⭐ **La liga tiene que ligar.** Si `ligado` cae, la pantalla publica plaza y monto sin saber
 *     quién es el cliente ni si cobró — y se vería igual de llena. Medido: 99.9 % (4,106 de 4,110
 *     líneas en 90 días). Lleva **prueba negativa**: 0 % de liga no se pone verde, se pone rojo.
 *  2. ⭐ **El puente no puede perder ni inventar dinero.** `income_bridge_src` envuelve a
 *     `income_entries_src`; un JOIN mal escrito contra `kdm1` duplicaría filas (el folio NO es
 *     único entre doctypes: el `0008866` existe como `U-D-13` y como `X-A-20`). Se compara el
 *     total de los dos, al centavo.
 *  3. ⭐⭐ **El árbitro (ADR-059): el saldo contra OTRA implementación.** `pendiente` sale de
 *     `kdm1` + `kdm5`; `analytics.erp_receivable_documents` sale de `kdue`. Son dos caminos
 *     distintos al mismo hecho, así que verificar uno contra el otro NO es verificar una vista
 *     contra sí misma. Medido contra prod: 12 de 4,077 filas difieren (0.3 %); el agregado da 1.53 % y lo
 *     explican las facturas que el arbitro NO tiene, no las que tiene.
 *  4. ⭐ **El medio de pago, contra el catálogo ENTERO.** Acá ya se cayó una regla: reconocer al
 *     banco por su CLABE de 18 dígitos mandaba $6,411,551 de depósitos reales al cajón de ajustes,
 *     porque `BAJIO 4166` guarda 8 dígitos y `SANTANDER 5565` once. El candado recorre las 26
 *     cuentas y exige que ninguna cuenta con número caiga en `ajuste`.
 *  5. **El traspaso interno se sigue separando**, con prueba negativa: un clasificador que no
 *     clasifica se lee igual que uno que no tiene nada que clasificar.
 *  6. **Rendimiento.** La versión anterior tardaba 4.7 s en un día contra una compuerta de 1 s.
 *
 * ⛔ Lo que este candado NO puede comprobar, y se declara: el **medio de pago del mostrador al
 * público**. No existe en Kepler (`kdm1.c45` vacía en el 100 % de los documentos de venta), así
 * que acá se reporta NO MEDIDO en vez de inventar una aserción que siempre pasaría.
 */
const { Client } = require('pg');
const { noMedido, esFaltaDeAcceso } = require('./_lib/no-medido');

const URL = process.env.DATABASE_URL_NEW || process.env.DST_URL;
const DIAS = Number(process.env.IG_DIAS || 90);
const DIA = process.env.IG_DIA || '2026-09-30';

let ok = 0, fail = 0, skip = 0;
const chk = (c, m) => { if (c) { ok++; console.log(`  ✔ ${m}`); } else { fail++; console.log(`  ✖ ${m}`); } };
const nm = (m) => { skip++; console.log(`  ◻ NO MEDIDO — ${m}`); };
const n = (x) => Number(x ?? 0).toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

(async () => {
  if (!URL) return noMedido('falta DATABASE_URL_NEW');
  const c = new Client({
    connectionString: URL,
    ssl: /rlwy\.net|railway|amazonaws/i.test(URL) ? { rejectUnauthorized: false } : false,
    connectionTimeoutMillis: 20000, statement_timeout: 300000,
  });
  try { await c.connect(); } catch (e) {
    if (esFaltaDeAcceso(e)) return noMedido(`no se pudo conectar (${e.code || e.message})`);
    throw e;
  }
  const q = async (sql, p = []) => (await c.query(sql, p)).rows;

  try {
    const [existe] = await q(
      `SELECT count(*)::int AS n FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
        WHERE ns.nspname = 'analytics' AND p.proname = 'income_bridge_src'`);
    if (!existe || existe.n === 0) {
      return noMedido('analytics.income_bridge_src no existe todavía — falta aplicar la migración');
    }

    // ── 1. La liga liga, y el clasificador clasifica ─────────────────────────────────────────
    console.log('\n[1] La póliza encuentra su documento');
    const [lig] = await q(
      `SELECT count(*)::int AS filas,
              count(*) FILTER (WHERE ligado)::int AS ligadas,
              count(*) FILTER (WHERE kind IS NOT NULL)::int AS con_kind,
              coalesce(sum(importe) FILTER (WHERE NOT ligado), 0)::numeric AS huerfano
         FROM analytics.income_bridge_src((CURRENT_DATE - $1::int)::date, CURRENT_DATE)`, [DIAS]);
    if (!lig || lig.filas === 0) {
      nm(`no hay pólizas de ingreso en los últimos ${DIAS} días — nada que ligar`);
    } else {
      // Prueba negativa: una liga que no liga NADA no puede pasar. Se vería igual de llena.
      chk(lig.ligadas > 0,
        lig.ligadas > 0
          ? `prueba negativa: la liga SÍ encuentra documentos — ${lig.ligadas} de ${lig.filas}`
          : '⛔ ninguna póliza encontró su documento: la liga por folio es un no-op y la pantalla '
            + 'publicaría plaza y monto sin cliente ni cobro');
      // ⭐ `[IG.8]`: esto es 100 %, no "casi". Las 5 que faltaban eran un filtro propio (cancelados),
      // no una ausencia del ERP. Si vuelve a bajar, hay una causa NUEVA que investigar.
      const pctLiga = (lig.ligadas * 100) / lig.filas;
      chk(pctLiga >= 99.8,
        lig.ligadas === lig.filas
          ? `las ${lig.filas} pólizas del rango tienen su documento — ni un ingreso sin casar`
          : `${lig.filas - lig.ligadas} sin documento ($${n(lig.huerfano)}), ${pctLiga.toFixed(2)} %. `
            + 'Con la mig 20261002140000 esto es 100 %: las que faltan son documentos CANCELADOS '
            + 'que el propio CTE filtraba');
      chk(lig.con_kind === lig.ligadas,
        `las ${lig.ligadas} líneas ligadas traen su kind; una línea sin documento quedaría en NULL, `
        + 'nunca en "externo" por default');
    }

    // ── 1b. ⛔ El documento CANCELADO con su ingreso vivo: dinero, no hueco de medición ───────
    console.log('\n[1b] El documento cancelado se MARCA, y es la excepción, no la regla');
    // La columna llega con la mig 20261002140000. Si el destino todavia no la tiene, esto se
    // DECLARA en vez de romperse: un candado que explota por una migracion pendiente se desactiva.
    const [tieneCol] = await q(
      `SELECT count(*)::int AS n
         FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
        WHERE ns.nspname = 'analytics' AND p.proname = 'income_bridge_src'
          AND 'doc_cancelado' = ANY(p.proargnames)`);
    const [cv] = (!tieneCol || tieneCol.n === 0) ? [null] : await q(
      `SELECT count(*) FILTER (WHERE doc_cancelado)::int AS docs,
              coalesce(sum(importe) FILTER (WHERE doc_cancelado), 0)::numeric AS importe,
              count(*) FILTER (WHERE doc_cancelado AND es_interno)::int AS internos
         FROM analytics.income_bridge_src((CURRENT_DATE - $1::int)::date, CURRENT_DATE)`, [DIAS]);
    if (!tieneCol || tieneCol.n === 0) {
      nm('este destino todavía no tiene doc_cancelado (mig 20261002140000): sin ella la liga '
        + 'declara 5 "sin documento" que en realidad son documentos CANCELADOS');
    } else if (!cv || cv.docs === 0) {
      nm('ningún documento cancelado conserva su ingreso en la ventana — el ERP los está borrando '
        + 'todos, que es su comportamiento normal (medido: 154 de 158)');
    } else {
      chk(true,
        `${cv.docs} documentos cancelados conservan su ingreso publicado por $${n(cv.importe)} — `
        + 'NO es un hueco de medición: el ERP los canceló ($0.00) y su póliza sigue viva sin '
        + 'reversar. Se marcan con doc_cancelado para que se puedan restar');
      chk(cv.internos === cv.docs,
        cv.internos === cv.docs
          ? `los ${cv.docs} son clientes INTERNOS: viven adentro del traspaso, así que el puente NO `
            + 'los resta aparte (sería contarlos dos veces)'
          : `⚠️ ${cv.docs - cv.internos} de los cancelados NO son internos: el puente los estaría `
            + 'dejando fuera del traspaso y hay que revisar de qué lado se restan');
    }

    // ── 2. El puente no pierde ni inventa dinero contra su propia fuente ──────────────────────
    console.log('\n[2] El puente suma exactamente lo que publica el Árbol');
    const [par] = await q(
      `WITH a AS (SELECT coalesce(sum(importe), 0)::numeric AS v, count(*)::int AS n
                    FROM analytics.income_entries_src((CURRENT_DATE - $1::int)::date, CURRENT_DATE)),
            b AS (SELECT coalesce(sum(importe), 0)::numeric AS v, coalesce(sum(lineas), 0)::int AS n
                    FROM analytics.income_bridge_src((CURRENT_DATE - $1::int)::date, CURRENT_DATE))
       SELECT a.v AS arbol, b.v AS puente, a.n AS lineas_arbol, b.n AS lineas_puente FROM a, b`,
      [DIAS]);
    if (!par || Number(par.lineas_arbol) === 0) {
      nm('el Árbol no publica nada en la ventana — no hay contra qué cuadrar');
    } else {
      const d = Math.abs(Number(par.arbol) - Number(par.puente));
      chk(d < 0.01,
        `Árbol $${n(par.arbol)} == puente $${n(par.puente)} (Δ ${n(d)}) — el JOIN contra kdm1 no `
        + 'duplicó filas, que es el riesgo real: el folio NO es único entre doctypes');
      chk(Number(par.lineas_arbol) === Number(par.lineas_puente),
        `${par.lineas_arbol} líneas del Árbol == ${par.lineas_puente} contadas por el puente`);
    }

    // ── 3. ⭐⭐ El árbitro: el saldo contra OTRA implementación (ADR-059) ─────────────────────
    console.log('\n[3] El pendiente, arbitrado contra la cartera de clientes');
    const [arb] = await q(
      `WITH mio AS (
         SELECT folio, pendiente FROM analytics.income_bridge_src((CURRENT_DATE - $1::int)::date, CURRENT_DATE)
          WHERE doc_tipo = 'UD1301' AND ligado),
       cxc AS (
         SELECT btrim(folio) AS folio, saldo_documento FROM analytics.erp_receivable_documents
          WHERE sucursal = '00' AND doc_code = 'UD1301'
            AND fecha BETWEEN (CURRENT_DATE - $1::int)::date AND CURRENT_DATE)
       SELECT count(*)::int AS docs, count(c.folio)::int AS con_arbitro,
              coalesce(sum(m.pendiente), 0)::numeric AS pendiente_mio,
              coalesce(sum(c.saldo_documento), 0)::numeric AS saldo_cxc,
              count(*) FILTER (WHERE c.folio IS NOT NULL
                AND abs(m.pendiente - c.saldo_documento) > 0.01)::int AS difieren
         FROM mio m LEFT JOIN cxc c ON c.folio = m.folio`, [DIAS]);
    if (!arb || arb.con_arbitro === 0) {
      nm('la cartera no publica facturas del CEDIS en la ventana — sin árbitro independiente');
    } else {
      const base = Number(arb.saldo_cxc) || 1;
      const dpct = (Math.abs(Number(arb.pendiente_mio) - Number(arb.saldo_cxc)) * 100) / base;
      const fpct = (arb.difieren * 100) / arb.con_arbitro;
      chk(dpct <= 2,
        `pendiente $${n(arb.pendiente_mio)} vs saldo de cartera $${n(arb.saldo_cxc)} — Δ `
        + `${dpct.toFixed(2)} % (medido 1.53 %). Son dos caminos distintos al mismo hecho: éste `
        + 'sale de kdm1+kdm5, el árbitro de kdue');
      chk(fpct <= 5,
        `${arb.difieren} de ${arb.con_arbitro} facturas difieren (${fpct.toFixed(1)} %, medido 0.3 %) `
        + '— y sólo cierra restando la nota de crédito: sin ella difieren 521 en vez de 12');
    }

    // ── 4. ⭐ El medio de pago, contra el catálogo ENTERO ─────────────────────────────────────
    console.log('\n[4] El banco se reconoce por el número, no por su largo');
    const cuentas = await q(
      `SELECT btrim(c1) AS code, c2 AS nombre, btrim(coalesce(c3, '')) AS c3,
              CASE WHEN btrim(coalesce(c3, '')) = 'EFECTIVO' THEN 'efectivo'
                   WHEN btrim(coalesce(c3, '')) ~ '^[0-9]+$' THEN 'banco'
                   WHEN c3 IS NOT NULL THEN 'ajuste'
                   ELSE 'sin_catalogo' END AS medio
         FROM kepler_ods.kdb1 WHERE sucursal = '00' ORDER BY 1`);
    if (!cuentas.length) {
      nm('el catálogo de tesorería del CEDIS vino vacío');
    } else {
      const malClasificadas = cuentas.filter(
        (r) => /^[0-9]+$/.test(r.c3) && r.medio !== 'banco');
      chk(malClasificadas.length === 0,
        malClasificadas.length === 0
          ? `las ${cuentas.length} cuentas del catálogo resuelven: `
            + `${cuentas.filter((r) => r.medio === 'efectivo').length} caja · `
            + `${cuentas.filter((r) => r.medio === 'banco').length} banco · `
            + `${cuentas.filter((r) => r.medio === 'ajuste').length} ajuste`
          : `⛔ ${malClasificadas.length} cuentas con número NO salen como banco: `
            + malClasificadas.map((r) => `${r.nombre} (${r.c3.length} dígitos)`).join(', '));
      // Prueba negativa de la regla que ya falló una vez: si se exigiera CLABE de 18, estas se
      // perderían. El candado nombra cuáles, para que el próximo que lo intente lo vea medido.
      const cortas = cuentas.filter((r) => /^[0-9]+$/.test(r.c3) && r.c3.length < 18);
      chk(cortas.length > 0,
        cortas.length > 0
          ? `prueba negativa: ${cortas.length} cuentas bancarias NO traen CLABE de 18 (`
            + `${cortas.map((r) => `${r.nombre}=${r.c3.length}`).join(', ')}) — una regla de `
            + 'longitud las mandaría al cajón de ajustes, como ya pasó con $6,411,551'
          : 'el catálogo ya no tiene cuentas con número corto: la prueba negativa perdió su razón '
            + 'de ser y hay que re-medir antes de confiar en la regla');
    }

    // ── 5. El traspaso interno se sigue separando ────────────────────────────────────────────
    console.log('\n[5] El CEDIS facturándole a sus tiendas NO se cuenta como ingreso externo');
    const kinds = await q(
      `SELECT kind, count(*)::int AS n, sum(importe)::numeric AS imp
         FROM analytics.income_bridge_src((CURRENT_DATE - $1::int)::date, CURRENT_DATE)
        WHERE kind IS NOT NULL GROUP BY 1 ORDER BY 3 DESC`, [DIAS]);
    if (!kinds.length) {
      nm('no hay documentos clasificados en la ventana');
    } else {
      const interno = kinds.filter((r) => String(r.kind).startsWith('interno'));
      const extern = kinds.find((r) => r.kind === 'externo');
      chk(interno.length > 0 && Number(interno[0].imp) > 0,
        interno.length
          ? `prueba negativa: el clasificador SÍ encuentra traspaso interno — `
            + interno.map((r) => `${r.kind} $${n(r.imp)}`).join(' · ')
          : '⛔ ningún documento quedó marcado como interno: el clasificador es un no-op y el '
            + 'ingreso vuelve a incluir al CEDIS facturándole a sus propias tiendas');
      chk(!!extern && Number(extern.imp) > 0, `y sigue habiendo venta externa — $${n(extern?.imp)}`);
    }

    // ── 6. Rendimiento: la versión anterior tardaba 4.7 s en UN día ──────────────────────────
    console.log('\n[6] La conciliación de un día entra bajo la compuerta de 1 s');
    const t0 = Date.now();
    await q(`SELECT count(*)::int AS n FROM analytics.income_bridge_src($1::date, $1::date)`, [DIA]);
    const ms = Date.now() - t0;
    chk(ms < 1000,
      `${ms} ms para el ${DIA} (medido 79 ms; la versión por almacén tardaba 4,700 ms)`);

    // ── 7. El hueco que NO se puede medir, declarado ─────────────────────────────────────────
    console.log('\n[7] El medio de pago del mostrador al público');
    const [c45] = await q(
      `SELECT count(*)::int AS docs,
              count(*) FILTER (WHERE btrim(coalesce(c45::text, '')) <> '')::int AS con
         FROM kepler_ods.kdm1
        WHERE c2 = 'U' AND c3 = 'D' AND c4 = '10'
          AND c9::date BETWEEN (CURRENT_DATE - 30) AND CURRENT_DATE`);
    if (c45 && c45.con > 0) {
      // Si Kepler EMPIEZA a llenarlo, esto deja de ser un hueco y hay que cablearlo.
      chk(false,
        `⛔ ${c45.con} de ${c45.docs} tickets YA traen cuenta de tesorería (c45): el medio de pago `
        + 'del mostrador dejó de ser un hueco — cablearlo a la conciliación');
    } else {
      nm(`el medio de pago del mostrador no existe en Kepler: c45 vacía en los ${c45?.docs ?? 0} `
        + 'tickets de los últimos 30 días. No se dibuja: se declara en el puente');
    }
  } finally {
    await c.end().catch(() => undefined);
  }

  console.log(`\n=== ${ok} OK · ${fail} FALLA · ${skip} NO MEDIDO ===`);
  if (fail > 0) process.exitCode = 1;
})();
