/* eslint-disable no-console */
/**
 * Smoke TK.0 — vistas en vivo del ticket de venta (`analytics.erp_sale_tickets` / `_lines`)
 * y las columnas de precio de lista que TK.0b le agrega a la vista de facturas.
 *
 * Ancla en el ticket **05UD1004-0010027** (Zamora Centro, caja 4, 2026-08-21), elegido porque
 * ejercita todo a la vez: 5 renglones, descuento real en los 5, venta a granel con decimales
 * (20.4 KG) y peldaños distintos (KG cobrado como BTO). Verificado a mano:
 *
 *     precio de lista   10,497.86      (25x60.95 + 25x60.95 + 3x1500.08 + 20.4x69.92 + 25x60.95)
 *   - descuento precio     -643.66
 *   ------------------------------
 *   = subtotal           9,854.20      == total del ticket  ->  descuento de documento 0.00
 *
 * Lo que este smoke protege, y que se puede romper en silencio:
 *
 *   1. **El decode de `kdm2.c66` como precio de lista.** Es el hallazgo de la fase: el
 *      descuento del ticket de mostrador no esta en la cabecera (`kdm1.c13` = 0.00 en el 100%)
 *      sino en el renglon. Si alguien lo cambia por el precio del CATALOGO (`kdii.c90`), la
 *      asercion de "cobra de mas" se dispara: medido, el catalogo da 1.9% de renglones
 *      cobrando por encima de lista contra 0.106% del renglon -- 18x peor.
 *   2. **Que la resta cierre.** Es lo unico que un cliente puede comprobar con una calculadora.
 *   3. **Que el descuento nunca sea negativo**, con su PRUEBA NEGATIVA: se comprueba que
 *      EXISTEN renglones donde el cobrado supera al de lista (o sea que el tope no es un no-op)
 *      y que aun asi salen en 0.00.
 *   4. **Que sigan siendo VISTAS.** Materializarlas reintroduciria el lag de batch que la
 *      regla principal del proyecto prohibe.
 *
 *   node database/tests/test-newdb-sale-tickets.js
 *   DATABASE_URL_NEW=<prod> node database/tests/test-newdb-sale-tickets.js
 */
const { Client } = require('pg');

const DST = process.env.DATABASE_URL_NEW || process.env.PLATFORM_TEST_URL || (() => {
  throw new Error('falta la URL de la DB destino: exporta DATABASE_URL_NEW (o PLATFORM_TEST_URL para staging)');
})();

const FOLIO = '05UD1004-0010027';
const ESPERADO = {
  sucursal: '05', caja: 4, fecha: '2026-08-21',
  doc_label: 'Ticket Contado Caja 4',
  cliente_nombre: 'CONTADO', cliente_rfc: 'XAXX010101000',
  total: 9854.20, iva: 785.14, ieps: 308.29,
  descuento_documento: 0,           // el mostrador NUNCA trae descuento de cabecera
  lineas: 5,
  importe_lista: 10497.86,
  descuento_precio: 643.66,
  subtotal: 9854.20,
};
/** Folio compartido entre plazas y cajas: la prueba de que el folio NO identifica un documento. */
const FOLIO_AMBIGUO = '0018665';

let ok = 0; const fallos = [];
const chk = (cond, msg) => { cond ? ok++ : fallos.push(msg); };
const num = (v) => Math.round(Number(v) * 100) / 100;

(async () => {
  const db = new Client({
    connectionString: DST,
    ssl: /rlwy|railway|proxy/i.test(DST) ? { rejectUnauthorized: false } : false,
    statement_timeout: 120000,
  });
  await db.connect();
  console.log(`\n=== Smoke TK.0 — ticket de venta en vivo (${FOLIO}) ===\n`);

  // skip-graceful: sin las vistas (migracion pendiente en esta DB) no hay nada que afirmar, y
  // un bloque sin datos con que comprobarse reporta NO MEDIDO, no verde (ADR-056).
  const existen = (await db.query(`SELECT
      to_regclass('analytics.erp_sale_tickets')      AS h,
      to_regclass('analytics.erp_sale_ticket_lines') AS l`)).rows[0];
  if (!existen.h || !existen.l) {
    console.log('SKIP — faltan las vistas analytics.erp_sale_ticket*; corre la migracion 20260918160000.');
    await db.end();
    process.exit(2);
  }

  // ── 1. derive-no-copy ───────────────────────────────────────────────────
  for (const v of ['erp_sale_tickets', 'erp_sale_ticket_lines']) {
    const r = (await db.query(`SELECT relkind FROM pg_class WHERE oid = to_regclass($1)`, [`analytics.${v}`])).rows[0];
    chk(r && r.relkind === 'v', `analytics.${v} debe ser VISTA (derive-no-copy), es: ${r ? r.relkind : 'no existe'}`);
  }

  // ── 2. la cabecera del ancla ────────────────────────────────────────────
  const { rows: [h] } = await db.query(
    `SELECT *, to_char(fecha,'YYYY-MM-DD') AS fecha_iso FROM analytics.erp_sale_tickets WHERE folio_digital = $1`, [FOLIO]);
  if (!h) {
    console.log(`SKIP — el ticket ancla ${FOLIO} no esta en esta DB (ventana de datos distinta).`);
    await db.end();
    process.exit(2);
  }
  chk(h.sucursal === ESPERADO.sucursal, `sucursal: ${h.sucursal}`);
  chk(Number(h.caja) === ESPERADO.caja, `caja: ${h.caja}`);
  // `String(date)` de pg da 'Fri Aug 21 2026 00:00:00 GMT-0600' -- la MISMA trampa que la
  // Fase LC.16 pago con el dia corrido en un entregable. Se formatea en SQL, no en JS.
  chk(h.fecha_iso === ESPERADO.fecha, `fecha: ${h.fecha_iso}`);
  chk(h.doc_label === ESPERADO.doc_label, `doc_label: ${h.doc_label} (el rotulo sale de kdmm, c5 es LA CAJA)`);
  chk(h.cliente_rfc === ESPERADO.cliente_rfc, `RFC: ${h.cliente_rfc}`);
  chk(num(h.total) === ESPERADO.total, `total: ${h.total}`);
  chk(num(h.iva) === ESPERADO.iva, `IVA (kdm1.c14): ${h.iva}`);
  chk(num(h.ieps) === ESPERADO.ieps, `IEPS (kdm1.c15): ${h.ieps}`);
  chk(num(h.descuento_documento) === ESPERADO.descuento_documento,
    `descuento de cabecera: ${h.descuento_documento} (en mostrador SIEMPRE 0; si deja de serlo, el decode cambio)`);

  // ── 3. la cascada cierra ────────────────────────────────────────────────
  const { rows: L } = await db.query(
    `SELECT * FROM analytics.erp_sale_ticket_lines WHERE folio_digital = $1 ORDER BY linea`, [FOLIO]);
  chk(L.length === ESPERADO.lineas, `renglones: ${L.length}`);

  const lista = num(L.reduce((a, l) => a + Number(l.precio_lista) * Number(l.cantidad), 0));
  const desc = num(L.reduce((a, l) => a + Number(l.descuento_linea), 0));
  const sub = num(L.reduce((a, l) => a + Number(l.importe), 0));
  chk(lista === ESPERADO.importe_lista, `precio de lista: ${lista} (esperado ${ESPERADO.importe_lista})`);
  chk(desc === ESPERADO.descuento_precio, `descuento en precio: ${desc} (esperado ${ESPERADO.descuento_precio})`);
  chk(sub === ESPERADO.subtotal, `subtotal: ${sub} (esperado ${ESPERADO.subtotal})`);
  // LA asercion: la resta que el cliente hace con la calculadora.
  chk(num(lista - desc) === sub, `LA CASCADA NO CIERRA: ${lista} - ${desc} = ${num(lista - desc)}, no ${sub}`);
  chk(sub === num(h.total), `los renglones no suman el total del ticket: ${sub} vs ${h.total}`);

  // ── 4. la aritmetica de cada renglon ────────────────────────────────────
  for (const l of L) {
    chk(Math.abs(Number(l.cantidad) * Number(l.precio_unitario) - Number(l.importe)) <= 0.011,
      `renglon ${l.linea}: ${l.cantidad} x ${l.precio_unitario} != ${l.importe}`);
    chk(Math.abs((Number(l.precio_lista) - Number(l.precio_unitario)) * Number(l.cantidad) - Number(l.descuento_linea)) <= 0.011,
      `renglon ${l.linea}: el descuento no cuadra con la diferencia de precios`);
  }

  // ── 5. el descuento nunca es negativo — CON prueba negativa ─────────────
  // Un tope sin prueba de que alguna vez actua es una intencion (ADR-056).
  const { rows: [tope] } = await db.query(`
    SELECT count(*) FILTER (WHERE descuento_unitario < 0)                        AS negativos,
           count(*) FILTER (WHERE precio_lista IS NULL)                         AS sin_lista,
           count(*) FILTER (WHERE precio_unitario > precio_lista + 0.005)        AS cobra_de_mas,
           count(*) FILTER (WHERE precio_unitario > precio_lista + 0.005
                              AND descuento_unitario <> 0)                       AS mal_topados,
           count(*)                                                              AS total
      FROM analytics.erp_sale_ticket_lines
     WHERE fecha >= (SELECT max(fecha) FROM analytics.erp_sale_tickets) - 12`);
  chk(Number(tope.negativos) === 0, `hay ${tope.negativos} renglones con descuento NEGATIVO`);
  // ⭐ La cobertura se DECLARA, siempre, y en pantalla. Sin esto la puerta es muda: un
  // `sin_lista` alto se lee igual que "no hubo descuentos".
  const pctSinLista = Number(tope.total) ? (100 * Number(tope.sin_lista) / Number(tope.total)) : 100;
  console.log(`  . cobertura del precio de lista en la ventana: ${(100 - pctSinLista).toFixed(2)}% `
    + `(${tope.sin_lista} de ${tope.total} renglones SIN lista -- Kepler empezo a guardarla el 2026-08-13)`);
  chk(Number(tope.cobra_de_mas) > 0,
    'PRUEBA NEGATIVA VACIA: no se encontro ningun renglon donde el cobrado supere al de lista, '
    + 'asi que el tope de GREATEST(...,0) no se ejercio y esta asercion no prueba nada');
  chk(Number(tope.mal_topados) === 0,
    `${tope.mal_topados} renglones cobran mas que la lista y NO salieron en 0.00: el tope no esta funcionando`);
  console.log(`  · tope ejercido sobre ${tope.cobra_de_mas} de ${tope.total} renglones de la muestra`);

  // ── 6. el folio NO identifica un documento ──────────────────────────────
  const { rows: [amb] } = await db.query(
    `SELECT count(*) n, count(DISTINCT sucursal) sucs, count(DISTINCT caja) cajas
       FROM analytics.erp_sale_tickets WHERE folio = $1`, [FOLIO_AMBIGUO]);
  chk(Number(amb.n) > 1,
    `el folio ${FOLIO_AMBIGUO} devolvio ${amb.n} documento(s): la pantalla se apoya en que puede haber varios`);
  console.log(`  · folio ${FOLIO_AMBIGUO}: ${amb.n} documentos en ${amb.sucs} sucursal(es) y ${amb.cajas} caja(s)`);

  // ── 7. TK.0b: las columnas de lista tambien en la vista de facturas ─────
  const { rows: cols } = await db.query(`
    SELECT column_name FROM information_schema.columns
     WHERE table_schema='analytics' AND table_name='erp_sales_invoice_lines'
       AND column_name IN ('precio_lista','descuento_unitario','descuento_linea')`);
  if (cols.length === 3) {
    const { rows: [f] } = await db.query(`
      SELECT count(*) FILTER (WHERE descuento_unitario < 0) AS negativos,
             count(*) FILTER (WHERE descuento_linea > 0)    AS con_desc
        FROM analytics.erp_sales_invoice_lines
       WHERE folio_digital IN (SELECT folio_digital FROM analytics.erp_sales_invoices
                                WHERE fecha >= current_date - 30 LIMIT 300)`);
    chk(Number(f.negativos) === 0, `facturas: ${f.negativos} renglones con descuento NEGATIVO`);
    console.log(`  · facturas (U/D/8-12): ${f.con_desc} renglones con descuento de precio en la muestra`);
  } else {
    console.log(`  · NO MEDIDO — la vista de facturas aun no trae las columnas de TK.0b `
      + `(migracion 20260918160100 pendiente en esta DB): ${cols.length}/3 columnas.`);
  }

  // ── 8. PRUEBA NEGATIVA del detector de despliegue a medias ─────────────
  // La mig 20260918160100 NO escribe datos, asi que su ausencia no deja ninguna huella: ni una
  // tabla vacia, ni una fila faltante. Y la consulta de renglones usa `select *`, con lo cual la
  // columna ausente llega `undefined` y se confunde con "el ERP no tiene el dato" -- el papel
  // terminaria afirmando algo FALSO sobre Kepler por culpa de un despliegue incompleto nuestro.
  // `CommercialTicketsService.soporteLista()` lo detecta preguntandole al CATALOGO. Aca se
  // comprueba que esa pregunta distingue los dos estados, porque un detector que siempre dice
  // que si es un no-op que se lee igual que "todo bien".
  const existeCol = async (col) => (await db.query(
    `SELECT 1 FROM information_schema.columns
      WHERE table_schema='analytics' AND table_name='erp_sales_invoice_lines' AND column_name=$1`,
    [col])).rowCount > 0;
  chk(await existeCol('importe') === true,
    'el detector de columnas da false para una columna que SI existe: no sirve para nada');
  chk(await existeCol('columna_que_no_existe_jamas') === false,
    'PRUEBA NEGATIVA FALLIDA: el detector dice que existe una columna inventada, o sea que '
    + 'nunca va a detectar un despliegue a medias');
  const soporte = await existeCol('precio_lista');
  console.log(`  · detector de despliegue a medias: soporte de precio de lista = ${soporte} `
    + `(si es false, el papel avisa "falta la migracion", NO "el ERP no lo guarda")`);

  // ── 9. TK.4: el impuesto por renglon, contra el ARBITRO ────────────────
  // El precio de Kepler ya trae el impuesto dentro, asi que se DESCOMPONE; y antes hay que
  // prorratear el descuento del documento. El arbitro no es la formula: es la cabecera
  // (kdm1.c14 = IVA, c15 = IEPS), un hecho independiente que Kepler ya escribio. Medido en
  // prod: sin prorratear cae a 1.93% en telemarketing; prorrateando, 100.00% en los 3 doctipos.
  const tieneTasas = (await db.query(`
    SELECT count(*) n FROM information_schema.columns
     WHERE table_schema='analytics' AND table_name='erp_sale_ticket_lines'
       AND column_name IN ('iva_tasa','ieps_tasa')`)).rows[0];
  if (Number(tieneTasas.n) === 2) {
    const { rows: [imp] } = await db.query(`
      with l as (
        select sucursal, doc_prefix, folio, importe, iva_tasa, ieps_tasa
          from analytics.erp_sale_ticket_lines
         where fecha >= (select max(fecha) from analytics.erp_sale_tickets) - 7
      ), sub as (select sucursal, doc_prefix, folio, sum(importe) st from l group by 1,2,3),
      d as (
        select l.sucursal, l.doc_prefix, l.folio,
               sum(round(((l.importe * (t.total/nullif(sub.st,0)))/((1+l.ieps_tasa)*(1+l.iva_tasa)))*l.ieps_tasa,2)) ieps,
               sum(round(((l.importe * (t.total/nullif(sub.st,0)))/((1+l.ieps_tasa)*(1+l.iva_tasa)))*(1+l.ieps_tasa)*l.iva_tasa,2)) iva,
               max(t.iva) iva_cab, max(t.ieps) ieps_cab
          from l join sub using (sucursal, doc_prefix, folio)
               join analytics.erp_sale_tickets t using (sucursal, doc_prefix, folio)
         group by 1,2,3)
      select count(*) docs,
             count(*) filter (where abs(iva-iva_cab)<=0.05 and abs(ieps-ieps_cab)<=0.05) cuadran,
             count(*) filter (where iva_cab > 0 or ieps_cab > 0) con_impuesto
        from d`);
    const pct = Number(imp.docs) ? (100 * Number(imp.cuadran) / Number(imp.docs)) : 0;
    chk(Number(imp.con_impuesto) > 0,
      'PRUEBA NEGATIVA VACIA: ningun documento de la muestra declara impuesto, asi que este '
      + 'bloque no comprueba nada aunque salga verde');
    chk(pct >= 99,
      `el impuesto por renglon solo reproduce la cabecera en ${pct.toFixed(2)}% de ${imp.docs} documentos `
      + '(se espera >=99%: si cae, el desglose por producto NO se puede publicar)');
    console.log(`  . impuesto por renglon vs cabecera: ${imp.cuadran}/${imp.docs} (${pct.toFixed(2)}%)`
      + ` · documentos con impuesto declarado: ${imp.con_impuesto}`);
  } else {
    console.log('  . NO MEDIDO — la vista aun no trae iva_tasa/ieps_tasa (migracion 20260918160000 sin re-aplicar).');
  }

  await db.end();
  console.log(`\n${fallos.length ? 'FALLOS' : 'OK'} — ${ok} aserciones verdes, ${fallos.length} fallidas`);
  for (const f of fallos) console.log(`  x ${f}`);
  process.exit(fallos.length ? 1 : 0);
})().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
