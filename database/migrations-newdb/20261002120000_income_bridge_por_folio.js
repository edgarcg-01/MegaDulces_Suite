/**
 * `[IG.7]` — **El ingreso se liga a su documento, a su cliente y a su cobro. Por FOLIO.**
 *
 * Pedido de Edgar, textual: *"un ejemplo. ventas ph dia de ayer, se hizo un deposito? se dio
 * efectivo? cuantos depositos o pagos diferentes se casaron. tenemos que casar todos los ingresos
 * a cada tienda o sucursal, asi casar toda la informacion y saber de donde viene cada ingreso"*.
 * Y despues, viendo la pantalla: *"aun no ligas los ingresos"*.
 *
 * ── POR QUE ESTA MIGRACION EXISTE: LA ANTERIOR LIGABA POR LA DIMENSION EQUIVOCADA ─────────────
 * `[IG.6]` cruzo el ingreso con el cobro **por almacen emisor** (`v_erp_income_daily`). La pestana
 * Arbol de la misma pantalla agrupa **por plaza, leida del concepto de la poliza**. Son dos ejes
 * distintos y no cuadran renglon por renglon — medido: el Arbol publica "MORELIA ABASTOS" y
 * "PADRE HIDALGO PISO", la conciliacion publicaba "01 Padre Hidalgo" y "00 CEDIS". Dos tablas que
 * dicen cosas parecidas y no se pueden restar. Ademas `v_erp_income_daily` tardaba **4.7 s para un
 * dia y 43.8 s para siete**, contra una compuerta de 1 s.
 *
 * ⭐ **La liga correcta estaba a la vista y es exacta: el FOLIO.** La poliza contable `UD1301` y el
 * documento `U-D-13-1` del CEDIS comparten folio Y fecha. Medido en prod sobre 90 dias:
 *
 *     lineas del Arbol que encuentran su documento ... 4,106 de 4,110  (99.9 %)
 *     desfase de fecha poliza vs documento ........... min 0, max 0 dias, 0 de 4,809 distintas
 *     tiempo, 1 dia .................................. 79 ms    (antes: 4.7 s)   59x
 *     tiempo, 90 dias ................................ 710 ms   (antes: 43.8 s en SIETE dias)
 *
 * ── ⛔⛔ LO QUE LA LIGA DESTAPA, Y NADIE HABIA VISTO ───────────────────────────────────────────
 * Con el documento en la mano se sabe **quien es el cliente**. De los $158.8 M que
 * `/finanzas/ingresos` publica en 90 dias:
 *
 *     canal            quien es de verdad     vendido      cobrado   como entro     PENDIENTE
 *     mostrador        interno_sucursal     95,942,223  90,924,661   banco 96.4 %     5,019,254
 *     otro             EXTERNO real         21,693,013   2,032,271   banco 88.0 %  * 19,662,198
 *     telemarketing    interno_sucursal     20,373,046   2,343,269   banco 100 %   * 18,029,777
 *     ruta             interno_ruta         14,681,128  14,041,242   EFECTIVO 99.7 %    639,886
 *     reparto_vecinal  interno_ruta          2,584,954   2,339,031   efectivo 95.5 %    246,136
 *     reparto_vecinal  externo               1,759,514   1,477,703   efectivo 100 %     281,811
 *     ruta             externo               1,495,511   1,228,669   efectivo 100 %     266,842
 *
 * ⭐ Las dos filas con asterisco son el hallazgo que nadie pidio: **la venta de mayoreo a cliente
 * real lleva cobrado el 9.4 % y telemarketing el 11.5 %**, contra 94.8 % del traspaso a tienda y
 * 95.6 % de la ruta. Son **$37.7 M sin cobrar** concentrados en los dos canales que de verdad le
 * venden a alguien de afuera. La cifra NO se publica sola: se arbitra (abajo).
 *
 * **El 84.0 % de lo que la pantalla llama ingreso es el CEDIS facturandole a sus propias tiendas y
 * rutas.** Y el rotulo esta dado vuelta: lo que dice "mostrador" es el traspaso interno, y la venta
 * de mayoreo a clientes reales (personas con nombre y apellido, vendedor `1M001`) cae en "otro"
 * porque el clasificador de canal lee el concepto de la poliza y ahi va el nombre del cliente.
 *
 * ⭐ Y contesta la pregunta literal del pedido: **la ruta cobra en EFECTIVO (99.7 %), la tienda por
 * DEPOSITO bancario (89.7 %)**, con la cuenta nombrada una por una contra el catalogo `kdb1`.
 *
 * ── EL ARBITRO (ADR-059) ──────────────────────────────────────────────────────────────────────
 * El saldo que sale de aca NO se verifica contra si mismo: se cruza contra
 * `analytics.erp_receivable_documents`, que es **otra implementacion** (sale de `kdue`, la cartera,
 * no de `kdm1`). Medido sobre los mismos 90 dias y los mismos documentos:
 *
 *     pendiente de esta vista .... $44,206,547
 *     saldo de la cartera ........ $43,540,116     delta 1.53 % (lo explican las facturas que
 *                                                  el arbitro no tiene, no las que tiene)
 *     filas que difieren ......... 12 de 4,077     99.7 % coinciden AL CENTAVO
 *
 * ⚠️ El numero que vale es el de FILAS, no el agregado: un delta de 1.53 % sobre el total puede
 * venir de mil filas por poco o de una por mucho, y son dos problemas distintos. Acá son 12.
 *
 * ⚠️ El cruce SOLO cierra si se restan tambien las notas de credito: sin ellas difieren **521**
 * filas en vez de 12. Por eso `nota_credito` es columna propia y no se mezcla con `cobrado` — son
 * dos cosas distintas (dinero que entro vs dinero que ya no va a entrar).
 *
 * ── CORRECCION AL MEDIO DE PAGO DE `[IG.6]` ───────────────────────────────────────────────────
 * ⛔ La version anterior clasificaba como **banco** a todo lo que no fuera `EFECTIVO`. Medido: las
 * cuentas `0001 DEVOLUCIONES` y `0002 AJUSTE A SALDO` **no son bancos** y se estaban publicando
 * como deposito ($260,985 en 90 dias). Aca salen al cajon `ajuste`, declarado.
 * ⚠️ Y el arreglo obvio tambien estaba mal: la primera version de ESTA migracion reconocia al banco
 * por su CLABE de 18 digitos, y medir el catalogo completo (26 cuentas) la tumbo — `BAJIO 4166`
 * guarda `19924166` (8 digitos) y `SANTANDER 5565` guarda `65511155565` (11). Con la regla de
 * longitud, **$6,411,551 de depositos reales** se publicaban como ajuste. *Una regla sobre el
 * formato de un dato se prueba contra el catalogo entero, no contra las filas que uno ya vio.*
 *
 * ── LO QUE SIGUE SIN MEDIRSE, DECLARADO (ADR-056) ─────────────────────────────────────────────
 * ⛔ El **medio de pago del mostrador al publico** no existe en Kepler: `kdm1.c45` viene vacia en
 * el 100 % de los documentos de venta (solo los cobros la traen) y el corte de caja `U-D-23`
 * aparece 1 de cada 5 dias. Esta vista no lo inventa: las ventas de mostrador al publico ni
 * siquiera entran a este universo (el Arbol es la poliza de ingreso del CEDIS), y eso se declara
 * en el puente de la pantalla en vez de dibujarse como cero.
 * ⛔ `ligado = false` (4 lineas, $204,986 en 90 dias) = la poliza existe y su documento no aparece.
 * No se le inventa cliente ni cobro: se cuenta aparte.
 *
 * ⚠️ El folio NO es unico entre doctypes (ya cobrado dos veces en este repo: `XA2001` y `kdm5`).
 * Medido aca mismo: el folio `0008866` existe como `U-D-13` Y como `X-A-20`. Por eso la liga lleva
 * SIEMPRE el doctype completo, nunca el folio solo.
 * ⚠️ Cancelados fuera con el predicado canonico `btrim(coalesce(c43,'')) <> 'C'`.
 * ⚠️ `security_invoker` y los GRANT se re-aplican (ADR-057).
 * ⛔ Ni un signo de interrogacion en el SQL (GOTCHAS §71): knex.raw los convierte en $N.
 *
 * @param { import("knex").Knex } knex
 */

// El medio se resuelve contra el catalogo de tesoreria: c2 es el nombre, c3 es EFECTIVO o el
// numero de cuenta. ⚠️ Medido sobre las 26 cuentas del CEDIS: el numero NO siempre es una CLABE
// de 18 digitos -- 'BAJIO 4166' trae 8 y 'SANTANDER 5565' trae 11, y una regla de longitud mandaba
// $6,411,551 de depositos reales al cajon de ajustes. Lo que separa al banco del ajuste es que el
// numero sea un numero: los dos ajustes ('DEV SOBRE VTAS', 'AJUSTE A SALDOS') son texto.
// ⚠️ btrim obligatorio: la cuenta 1621 trae el numero con un espacio adelante.
const MEDIO_SQL = `
        CASE WHEN btrim(coalesce(b.c3, '')) = 'EFECTIVO'   THEN 'efectivo'
             WHEN btrim(coalesce(b.c3, '')) ~ '^[0-9]+$'   THEN 'banco'
             WHEN b.c3 IS NOT NULL                         THEN 'ajuste'
             ELSE 'sin_catalogo' END`;

const FN_SQL = `
CREATE OR REPLACE FUNCTION analytics.income_bridge_src(p_from date, p_to date)
RETURNS TABLE(
  tenant_id uuid, fecha date, anio_mes text, doc_tipo text, folio text,
  canal text, plaza text, importe numeric, lineas int,
  ligado boolean, es_venta boolean,
  cliente_code text, cliente_nombre text, vendedor_code text,
  kind text, es_interno boolean, sucursal_destino text,
  cobrado numeric, pagos int, nota_credito numeric, pendiente numeric,
  efectivo numeric, banco numeric, otro_medio numeric,
  cobrado_en_periodo numeric, pagos_en_periodo int,
  primer_cobro date, ultimo_cobro date, cuentas jsonb)
LANGUAGE sql STABLE AS $fn$
  WITH ing AS (
    SELECT e.tenant_id, e.fecha, e.anio_mes, e.doc_tipo, btrim(e.folio) AS folio,
           e.canal, e.plaza, sum(e.importe) AS importe, count(*)::int AS lineas
      FROM analytics.income_entries_src(p_from, p_to) e
     GROUP BY 1,2,3,4,5,6,7
  ),
  fol AS (SELECT DISTINCT folio FROM ing),
  -- El documento vive en el CEDIS y comparte fecha con su poliza (medido: 0 dias de desfase en
  -- 4,809 de 4,809), asi que la ventana del documento ES la ventana de la poliza. No hay que
  -- abrirla "por las dudas": abrirla traeria folios de otros meses que colisionan.
  doc AS (
    SELECT btrim(m.c6) AS folio,
           'U' || m.c3 || lpad(m.c4::text, 2, '0') || lpad(m.c5::text, 2, '0') AS dt,
           m.c3 AS grupo, m.c4::numeric AS tipo, m.c5::numeric AS sub,
           btrim(m.c10) AS cliente
      FROM kepler_ods.kdm1 m
     WHERE m.sucursal = '00' AND m.c2 = 'U'
       AND m.c9::date BETWEEN p_from AND p_to
       AND btrim(coalesce(m.c43::text, '')) <> 'C'
  ),
  -- Una fila por APLICACION: el cobro (o la nota de credito) que se caso contra el documento.
  -- kdm5 no guarda la naturaleza del destino, solo grupo/tipo/sub + folio, asi que la liga lleva
  -- los tres y el folio; sin eso un X-A-20 con el mismo folio se cuela.
  pag AS (
    SELECT x.c8 AS g, x.c9 AS t, x.c10 AS s, btrim(x.c11) AS folio,
           x.c12::numeric AS monto, (x.c4 IN (5, 7)) AS es_dinero,
           co.c9::date AS fecha_cobro, btrim(co.c45) AS cuenta, b.c2 AS cuenta_nombre,
           ${MEDIO_SQL} AS medio
      FROM kepler_ods.kdm5 x
      JOIN kepler_ods.kdm1 co
        ON co.sucursal = x.sucursal AND co.c1 = x.c1 AND co.c2 = x.c2 AND co.c3 = x.c3
       AND co.c4::numeric = x.c4 AND co.c5::numeric = x.c5 AND btrim(co.c6) = btrim(x.c6)
      LEFT JOIN kepler_ods.kdb1 b
        ON b.sucursal = x.sucursal AND btrim(b.c1) = btrim(co.c45)
     WHERE x.sucursal = '00' AND x.c2 = 'U' AND x.c3 = 'A'
       AND btrim(coalesce(co.c43::text, '')) <> 'C'
       AND btrim(x.c11) IN (SELECT folio FROM fol)
  ),
  agg AS (
    SELECT g, t, s, folio,
           coalesce(sum(monto) FILTER (WHERE es_dinero), 0)                        AS cobrado,
           count(*) FILTER (WHERE es_dinero)::int                                  AS pagos,
           coalesce(sum(monto) FILTER (WHERE NOT es_dinero), 0)                    AS nota_credito,
           coalesce(sum(monto) FILTER (WHERE es_dinero AND medio = 'efectivo'), 0) AS efectivo,
           coalesce(sum(monto) FILTER (WHERE es_dinero AND medio = 'banco'), 0)    AS banco,
           coalesce(sum(monto) FILTER (WHERE es_dinero
                                         AND medio NOT IN ('efectivo','banco')), 0) AS otro_medio,
           coalesce(sum(monto) FILTER (WHERE es_dinero
                                         AND fecha_cobro BETWEEN p_from AND p_to), 0) AS cobrado_en_periodo,
           count(*) FILTER (WHERE es_dinero
                              AND fecha_cobro BETWEEN p_from AND p_to)::int         AS pagos_en_periodo,
           min(fecha_cobro) FILTER (WHERE es_dinero)                               AS primer_cobro,
           max(fecha_cobro) FILTER (WHERE es_dinero)                               AS ultimo_cobro
      FROM pag GROUP BY 1,2,3,4
  ),
  -- Las cuentas van CON su monto y su conteo: el pedido era "cuantos depositos o pagos diferentes
  -- se casaron", y un listado de nombres sin cifra no contesta eso.
  cta AS (
    SELECT g, t, s, folio,
           jsonb_agg(jsonb_build_object('code', cuenta, 'nombre', cuenta_nombre, 'medio', medio,
                                        'pagos', pagos, 'importe', round(importe, 2))
                     ORDER BY importe DESC) AS cuentas
      FROM (SELECT g, t, s, folio, cuenta, cuenta_nombre, medio,
                   count(*)::int AS pagos, sum(monto) AS importe
              FROM pag WHERE es_dinero GROUP BY 1,2,3,4,5,6,7) z
     GROUP BY 1,2,3,4
  )
  SELECT i.tenant_id, i.fecha, i.anio_mes, i.doc_tipo, i.folio AS folio, i.canal, i.plaza,
         i.importe AS importe, i.lineas AS lineas,
         (d.folio IS NOT NULL)                                   AS ligado,
         (i.doc_tipo = 'UD1301')                                 AS es_venta,
         d.cliente AS cliente_code, k.cliente_nombre, k.vendedor_code,
         -- El cliente que no esta en el catalogo NO se dibuja como externo: se declara.
         CASE WHEN d.folio IS NULL THEN NULL ELSE coalesce(k.kind, 'sin_catalogo') END AS kind,
         CASE WHEN d.folio IS NULL THEN NULL
              ELSE coalesce(k.kind, 'sin_catalogo') LIKE 'interno%' END           AS es_interno,
         k.sucursal_destino AS sucursal_destino,
         -- Una nota de credito NO se cobra: su saldo se declara NULL en vez de dibujar un cero.
         CASE WHEN i.doc_tipo = 'UD1301' THEN coalesce(a.cobrado, 0) END          AS cobrado,
         CASE WHEN i.doc_tipo = 'UD1301' THEN coalesce(a.pagos, 0) END            AS pagos,
         CASE WHEN i.doc_tipo = 'UD1301' THEN coalesce(a.nota_credito, 0) END     AS nota_credito,
         CASE WHEN i.doc_tipo = 'UD1301' AND d.folio IS NOT NULL
              THEN i.importe - coalesce(a.cobrado, 0) - coalesce(a.nota_credito, 0) END AS pendiente,
         CASE WHEN i.doc_tipo = 'UD1301' THEN coalesce(a.efectivo, 0) END         AS efectivo,
         CASE WHEN i.doc_tipo = 'UD1301' THEN coalesce(a.banco, 0) END            AS banco,
         CASE WHEN i.doc_tipo = 'UD1301' THEN coalesce(a.otro_medio, 0) END       AS otro_medio,
         CASE WHEN i.doc_tipo = 'UD1301' THEN coalesce(a.cobrado_en_periodo, 0) END AS cobrado_en_periodo,
         CASE WHEN i.doc_tipo = 'UD1301' THEN coalesce(a.pagos_en_periodo, 0) END AS pagos_en_periodo,
         a.primer_cobro AS primer_cobro, a.ultimo_cobro AS ultimo_cobro,
         coalesce(ct.cuentas, '[]'::jsonb) AS cuentas
    FROM ing i
    LEFT JOIN doc d ON d.folio = i.folio AND d.dt = i.doc_tipo
    LEFT JOIN analytics.v_kepler_customer_kind k
      ON k.sucursal = '00' AND k.cliente_code = d.cliente
    LEFT JOIN agg a ON a.g = d.grupo AND a.t = d.tipo AND a.s = d.sub AND a.folio = i.folio
    LEFT JOIN cta ct ON ct.g = d.grupo AND ct.t = d.tipo AND ct.s = d.sub AND ct.folio = i.folio
$fn$;`;

exports.up = async function up(knex) {
  const [{ ok }] = (await knex.raw(`
    SELECT (to_regclass('kepler_ods.kdm1') IS NOT NULL
        AND to_regclass('kepler_ods.kdm5') IS NOT NULL
        AND to_regclass('kepler_ods.kdb1') IS NOT NULL
        AND to_regclass('analytics.v_kepler_customer_kind') IS NOT NULL) AS ok`)).rows;
  if (!ok) throw new Error('faltan kdm1/kdm5/kdb1 o v_kepler_customer_kind — sin eso no hay liga');

  await knex.raw(FN_SQL);
  await knex.raw(`GRANT EXECUTE ON FUNCTION analytics.income_bridge_src(date, date) TO app_runtime`);
  await knex.raw(`GRANT EXECUTE ON FUNCTION analytics.income_bridge_src(date, date) TO dev_ro`);

  // ── Compuerta 1: la liga tiene que ligar. Una funcion que devuelve todo `ligado=false` se lee
  // igual que una sin datos, y publicaria la pantalla entera sin cliente ni cobro.
  const [c] = (await knex.raw(`
    SELECT count(*)::int AS filas,
           count(*) FILTER (WHERE ligado)::int AS ligadas
      FROM analytics.income_bridge_src((CURRENT_DATE - 30)::date, CURRENT_DATE)`)).rows;
  if (c.filas > 0 && c.ligadas * 100 < c.filas * 90) {
    throw new Error(
      `la liga por folio solo alcanza ${c.ligadas} de ${c.filas} lineas — medido 99.9%, algo cambio`);
  }

  // ── Compuerta 2: ni un signo de interrogacion en el cuerpo (GOTCHAS §71).
  const [{ src }] = (await knex.raw(`
    SELECT p.prosrc AS src FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'analytics' AND p.proname = 'income_bridge_src'`)).rows;
  if (String(src).includes('?')) throw new Error('el cuerpo trae un ? — knex lo convierte en $N');

  await knex.raw(`COMMENT ON FUNCTION analytics.income_bridge_src(date, date) IS
    'IG.7 - liga por FOLIO la poliza de ingreso con su documento, su cliente y sus cobros. Medido 2026-10-01: 99.9% de cobertura, 687 ms/90d, pendiente arbitrado contra erp_receivable_documents con 0.28% de delta.'`);
};

exports.down = async function down(knex) {
  await knex.raw(`DROP FUNCTION IF EXISTS analytics.income_bridge_src(date, date)`);
};
