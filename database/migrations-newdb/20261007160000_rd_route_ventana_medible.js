'use strict';
/**
 * `[RD.40]` — **El ledger deja de contar lo que la declaracion llama "sin medir".**
 *
 * Lo pidio Edgar el 2026-10-07: *"quiero que no se este arrastrando valores que puedan dar a
 * error o malinterpretacion"*. Tenia razon, y el valor que se arrastraba lo metí yo.
 *
 * ── EL DEFECTO, en una linea ────────────────────────────────────────────────────────────────
 *
 * Desde `[RD.37]` (ayer), `analytics.v_rd_route_opening` publica **$303,294** rotulados
 * *"mercancia real que ninguna fuente mide"* y `analytics.mv_rd_route_ledger` cuenta **ese mismo
 * dinero** como carga. El mismo peso esta, al mismo tiempo, declarado como no medible y usado en
 * una cifra publicada. Las dos cosas no pueden ser ciertas.
 *
 * `[RD.30]` habia fijado `carga_desde = GREATEST(primer embarque, primera venta)` — la primera
 * fecha en que **los dos lados son observables** — y declaraba el resto aparte. `[RD.37]` lo
 * cambio a `LEAST(...)` para "dejar de tirar embarque documentado". El embarque es real, si; lo
 * que no es real es **netearlo contra una venta que no existe**.
 *
 * ── POR QUE la venta no existe (la causa raiz, medida hoy) ──────────────────────────────────
 *
 * El push de ventas de cada camioneta trae `h.c9 >= current_date - DAYS` con **`DAYS=15`**
 * (`push-ruta.v2.template.cmd:26`). O sea: la historia de venta de un camion empieza 15 dias
 * antes **del dia en que le instalamos el push**, no cuando el camion empezo a vender. La carga,
 * en cambio, viene completa del ERP central. Medido contra prod el 2026-10-07:
 *
 *   · 6 rutas de PH recibieron **$349,962** antes de tener una sola venta registrada.
 *   · La ruta 21: **$113,441 en 6 dias**, contra un descuadre publicado de **-$82,909**.
 *     El artefacto es MAS GRANDE que la cifra que explica.
 *   · Las 5 de Canindo tienen el defecto **al reves**: vendian antes de su primer embarque
 *     registrado (traian existencia de Wincaja) y el ledger descarta **$87,000** de esa venta.
 *
 * ⇒ Con una sola foto y una historia de venta truncada, el residuo **no es publicable**: con
 *   `LEAST` sale negativo por artefacto y con `GREATEST` sale positivo por artefacto. Esta
 *   migracion no elige el signo que mas guste — **declara que no se puede medir**.
 *
 * ── QUE HACE ────────────────────────────────────────────────────────────────────────────────
 *   (a) `desde` vuelve a `i.carga_desde` (revierte el `LEAST` de `[RD.37]`), y se quita el
 *       `LEFT JOIN v_rd_route_opening` que ya no se usa — y que ademas costaba: esa vista pega
 *       tres laterales contra `kepler_ods` en cada evaluacion del ledger.
 *   (b) `v_rd_route_opening` se EXTIENDE (no se duplica en una vista nueva: regla del proyecto)
 *       con el lado que le faltaba — la venta descartada — y con el veredicto `medible`.
 *   (c) deja de filtrar el embarque por sucursal: el CEDIS tambien le embarca a las rutas
 *       (`RD 502` $23,263 el 11-ago, `RD023` $2,659 el 8-jul) y eso se declaraba en cero.
 *       Se verifico contra prod que ningun `dest_code` apunta a mas de un almacen, asi que el
 *       destino desambigua solo.
 *
 * ⚠️ **Lo que esto cuesta, dicho de frente:** la columna "cargado" vuelve a quedarse corta por
 *    $303,294 de embarque documentado. Es el precio de que el residuo signifique algo, y queda
 *    con nombre y monto en `v_rd_route_opening`. El arreglo que cierra las dos puntas no es una
 *    vista: es **subir `DAYS` y correr el push una vez** en cada camioneta.
 *
 * ⚠️ El saldo publicado NO se mueve: sigue anclado a lo que el camion declara. Lo que cambia es
 *    de que esta hecho el residuo, y que ahora dice cuando no se puede creer.
 *
 * Hereda ADR-056 (lo que no se puede medir se declara) y la leccion de `[RD.33]`: los frenos
 * verifican el PROPOSITO (que la contradiccion se cerro), no la forma (que la vista se parcho).
 *
 * @param { import("knex").Knex } knex
 */

const LEDGER = 'analytics.v_rd_route_ledger';
const OPEN = 'analytics.v_rd_route_opening';

/** Los rotulos de un almacen de ruta, como dato (`[RD.30]`). */
const ROTULOS = `
  SELECT x.dest_code FROM analytics.transfer_dest_map x
   WHERE x.tenant_id = i.tenant_id AND x.warehouse_id = i.warehouse_id`;

exports.up = async function up(knex) {
  // ── 0. El antes, para que el freno pueda comparar contra un hecho y no contra una intencion ─
  const ant = (await knex.raw(`
    SELECT round(sum(costo_doc), 2)::float AS carga,
           round(sum(costo_doc) FILTER (WHERE route_no = '21'), 2)::float AS carga_21
      FROM analytics.mv_rd_route_ledger WHERE clase = 'carga'`)).rows[0];

  // ── 1. (a) `desde` vuelve a la fecha en que los DOS lados son observables ──────────────────
  const vieja = (await knex.raw(`SELECT pg_get_viewdef('${LEDGER}'::regclass, true) AS d`)).rows[0].d;
  const PARCHES = [
    ['LEAST(i.carga_desde, COALESCE(o.primer_embarque, i.carga_desde)) AS desde',
     'i.carga_desde AS desde'],
    ['LEFT JOIN analytics.v_rd_route_opening o ON o.tenant_id = i.tenant_id AND o.route_no = i.route_no',
     ''],
    // (c) El CEDIS tambien le embarca a las rutas y el ledger lo tiraba: el destino ya
    //     identifica a la camioneta (verificado contra prod: ningun `dest_code` apunta a mas de
    //     un almacen), asi que el filtro de sucursal no desambiguaba nada -- solo descartaba.
    ["h.sucursal = a.suc_emisor AND h.c2 = 'U'::text AND h.c3 = 'D'::text AND h.c4 = 41::numeric",
     "h.c2 = 'U'::text AND h.c3 = 'D'::text AND h.c4 = 41::numeric"],
  ];
  let nueva = vieja;
  for (const [viejo, nuevoTxt] of PARCHES) {
    const veces = nueva.split(viejo).length - 1;
    if (veces !== 1) {
      throw new Error(`[RD.40] el fragmento "${viejo.slice(0, 48)}..." aparece ${veces} veces (esperaba 1). ` +
        'El ledger cambio desde [RD.37]: parar y revisar a mano.');
    }
    nueva = nueva.replace(viejo, nuevoTxt);
  }
  await knex.raw(`CREATE OR REPLACE VIEW ${LEDGER} AS ${nueva}`);
  // ⚠️ `CREATE OR REPLACE VIEW` NO conserva `security_invoker` ni los GRANT (GOTCHAS).
  await knex.raw(`ALTER VIEW ${LEDGER} SET (security_invoker = true)`);
  await knex.raw(`GRANT SELECT ON ${LEDGER} TO app_runtime`);

  // ── 2. (b)+(c) La declaracion cubre los DOS lados y emite veredicto ────────────────────────
  // Se conservan nombre, tipo y orden de las 9 columnas que ya tenia; las nuevas van al final,
  // que es lo que `CREATE OR REPLACE VIEW` permite.
  await knex.raw(`
    CREATE OR REPLACE VIEW ${OPEN} AS
    SELECT i.tenant_id, i.route_no, i.plaza,
           c.primer_embarque, v.primera_venta, i.carga_desde,
           GREATEST(0, (i.carga_desde - c.primer_embarque))::int AS dias_ciegos,
           coalesce(a.carga_sin_medir, 0)::numeric               AS carga_sin_medir,
           coalesce(a.docs_sin_medir, 0)::int                    AS docs_sin_medir,
           -- ── nuevas en [RD.40] ──────────────────────────────────────────────────────────
           -- La venta que el ledger descarta por caer antes de su ventana. Se valua AL COSTO,
           -- no al precio con el que viene en el push: tiene que ser conmensurable con
           -- carga_sin_medir y con el residuo, que se publican en costo. El mismo hueco medido
           -- en dos monedas no se puede sumar ni comparar.
           coalesce(b.venta_sin_medir, 0)::numeric               AS venta_sin_medir,
           GREATEST(0, (i.carga_desde - v.primera_venta))::int   AS dias_ciegos_venta,
           -- Cuanto puede mover el ARTEFACTO al residuo publicado. Las dos mitades se suman en
           -- valor absoluto: una lo empuja hacia abajo y la otra hacia arriba, asi que su neto
           -- no acota nada. El que acota es el bruto.
           (coalesce(a.carga_sin_medir, 0) + coalesce(b.venta_sin_medir, 0))::numeric
                                                                 AS exposicion_costo,
           (coalesce(a.docs_sin_medir, 0) = 0
              AND coalesce(b.dias, 0) = 0
              AND v.primera_venta IS NOT NULL)                   AS medible,
           CASE
             WHEN v.primera_venta IS NULL
               THEN 'la camioneta no reporta ventas: no hay con que netear la carga'
             WHEN coalesce(a.docs_sin_medir, 0) > 0 AND coalesce(b.dias, 0) > 0
               THEN 'las dos mitades arrancan en fechas distintas, por los dos lados'
             WHEN coalesce(a.docs_sin_medir, 0) > 0
               THEN 'recibio carga antes de que el push trajera ventas (DAYS=15 en la camioneta)'
             WHEN coalesce(b.dias, 0) > 0
               THEN 'vendia antes de su primer embarque registrado: traia existencia sin medir'
             ELSE NULL
           END                                                   AS motivo
      FROM analytics.mv_rd_route_identity i
      CROSS JOIN LATERAL (
           -- ⛔ Sin filtro de sucursal desde [RD.40]: el CEDIS tambien le embarca a las rutas y
           --    con "h.sucursal = i.suc_emisor" esos embarques se declaraban en CERO.
           SELECT min(h.c9)::date AS primer_embarque
             FROM kepler_ods.kdm1 h
            WHERE h.c2='U' AND h.c3='D' AND h.c4=41
              AND h.c9 > '2020-01-01' AND h.c10 IN (${ROTULOS})
      ) c
      CROSS JOIN LATERAL (
           SELECT min(p.business_date)::date AS primera_venta
             FROM analytics.route_push_lines p
            WHERE p.tenant_id = i.tenant_id AND p.route_no = i.route_no
      ) v
      LEFT JOIN LATERAL (
           SELECT sum(d.c13::numeric)             AS carga_sin_medir,
                  count(DISTINCT (h.c6, h.c9))    AS docs_sin_medir
             FROM kepler_ods.kdm1 h
             JOIN kepler_ods.kdm2 d
               ON d.sucursal = h.sucursal AND d.c1 = h.c1 AND d.c2 = h.c2 AND d.c3 = h.c3
              AND d.c4 = h.c4 AND d.c5 = h.c5 AND d.c6 = h.c6
            WHERE h.c2='U' AND h.c3='D' AND h.c4=41
              AND h.c9 > '2020-01-01' AND h.c9::date < i.carga_desde
              AND h.c10 IN (${ROTULOS})
              AND coalesce(btrim(d.c11),'') NOT IN ('SER','')
      ) a ON true
      LEFT JOIN LATERAL (
           SELECT count(DISTINCT p.business_date)::int           AS dias,
                  sum(p.qty * coalesce(u.costo_u, 0))            AS venta_sin_medir
             FROM analytics.route_push_lines p
             LEFT JOIN analytics.mv_rd_route_unit_value u
               ON u.tenant_id = p.tenant_id AND u.route_no = p.route_no
              AND u.sku = btrim(p.sku) AND u.unidad = upper(btrim(p.unidad))
            WHERE p.tenant_id = i.tenant_id AND p.route_no = i.route_no
              AND p.business_date < i.carga_desde
      ) b ON true
  `);
  await knex.raw(`ALTER VIEW ${OPEN} SET (security_invoker = true)`);
  await knex.raw(`GRANT SELECT ON ${OPEN} TO app_runtime`);
  await knex.raw(`COMMENT ON VIEW ${OPEN} IS
    'RD.40 (extiende RD.30) - lo que NO se puede medir de cada ruta, en la misma moneda que el
     residuo publicado (costo resuelto). Dos huecos: carga que entro antes de que el push trajera
     ventas (DAYS=15 en la camioneta) y venta que el ledger descarta por caer antes de su
     ventana. "medible"=false significa que el residuo de esa ruta NO es publicable tal cual: el
     artefacto puede explicarlo entero. Se publica AL LADO del saldo, nunca sumado. ADR-056.'`);

  // ── 3. La copia por costo, para que el freno mida lo que la pantalla va a leer ─────────────
  const t0 = Date.now();
  await knex.raw('REFRESH MATERIALIZED VIEW CONCURRENTLY analytics.mv_rd_route_ledger');
  console.log(`  · [RD.40] mv_rd_route_ledger refrescada en ${Date.now() - t0} ms`);

  // ── 4. Frenos de PROPOSITO ─────────────────────────────────────────────────────────────────
  const op = (await knex.raw(`SELECT * FROM ${OPEN} ORDER BY route_no`)).rows;
  if (op.length < 10) throw new Error(`[RD.40] la declaracion cubre ${op.length} rutas; esperaba 10+.`);

  /**
   * ⭐ EL FRENO QUE IMPORTA: la contradiccion tiene que haberse cerrado. Ni un peso declarado
   *    "sin medir" puede seguir contado como carga en el ledger.
   *
   * ⚠️ Pero NO todo lo anterior a la ventana es artefacto. `[RD.36]` mete a proposito la
   *    `apertura` -- el conteo fisico que el ERP le hizo al almacen de la ruta ANTES de que
   *    arrancara la ventana. Eso SI esta medido (es un conteo, no una inferencia) y debe
   *    contar. Medido contra prod: existe exactamente uno, el de la ruta 28 del 26-jun, 324
   *    renglones / $47,596.87; ninguna otra ruta tiene conteo de apertura.
   *
   * ⇒ El freno no exige CERO: exige que lo anterior a la ventana sea EXACTAMENTE la apertura
   *   medida, ni un peso mas. La primera version exigia cero y habria tumbado una migracion
   *   correcta -- un freno demasiado estricto miente igual que uno demasiado flojo.
   */
  const contra = (await knex.raw(`
    WITH previo AS (
      SELECT l.route_no, count(*)::int AS celdas, round(coalesce(sum(l.costo_doc), 0), 2) AS imp
        FROM analytics.mv_rd_route_ledger l
        JOIN analytics.mv_rd_route_identity i
          ON i.tenant_id = l.tenant_id AND i.route_no = l.route_no
       WHERE l.clase = 'carga' AND l.business_date < i.carga_desde
       GROUP BY 1
    ), apertura AS (
      SELECT i.route_no,
             round(sum(CASE WHEN v.signo = 'faltante' THEN -v.importe ELSE v.importe END), 2) AS imp
        FROM analytics.mv_rd_route_identity i
        JOIN analytics.mv_erp_physical_count_variance v
          ON v.kepler_sucursal = i.suc_emisor AND v.kepler_almacen = i.almacen_erp
         AND v.fecha < i.carga_desde
       WHERE i.almacen_erp IS NOT NULL
         AND coalesce(btrim(v.sku), '') <> '' AND coalesce(btrim(v.unidad_erp), '') <> ''
       GROUP BY 1
    )
    SELECT coalesce(p.route_no, a.route_no) AS route_no,
           coalesce(p.celdas, 0)::int       AS celdas,
           coalesce(p.imp, 0)::float        AS en_el_ledger,
           coalesce(a.imp, 0)::float        AS conteo_de_apertura
      FROM previo p FULL JOIN apertura a ON a.route_no = p.route_no
     WHERE abs(coalesce(p.imp, 0) - coalesce(a.imp, 0)) > 0.01`)).rows;
  if (contra.length) {
    const d = contra.map((x) => `${x.route_no}: ledger $${x.en_el_ledger} vs apertura $${x.conteo_de_apertura}`).join(' · ');
    throw new Error('[RD.40] antes de la ventana el ledger tiene carga que NO es el conteo de apertura ' +
      `(${d}). Eso es justo lo que v_rd_route_opening declara como no medible: el parche de "desde" no surtio efecto.`);
  }

  // La carga TIENE que bajar: si no bajo, se reverso nada. $303,294 es lo medido por [RD.37].
  const des = (await knex.raw(`
    SELECT round(sum(costo_doc), 2)::float AS carga,
           round(sum(costo_doc) FILTER (WHERE route_no = '21'), 2)::float AS carga_21
      FROM analytics.mv_rd_route_ledger WHERE clase = 'carga'`)).rows[0];
  const bajo = Number(ant.carga) - Number(des.carga);
  if (!(bajo > 200000)) {
    throw new Error(`[RD.40] la carga del ledger bajo solo $${bajo.toFixed(2)} (de ${ant.carga} a ${des.carga}); ` +
      'esperaba ~$303,294. La reversion de [RD.37] no surtio efecto.');
  }
  console.log(`  · [RD.40] carga del ledger: ${ant.carga} -> ${des.carga}  (-$${bajo.toFixed(2)}, declarado en v_rd_route_opening)`);

  // El CEDIS entra a la DECLARACION (no al ledger): la 502 recibio $23,263 el 11-ago.
  const r502 = op.find((x) => x.route_no === '502');
  if (!r502 || !(Number(r502.carga_sin_medir) > 20000)) {
    throw new Error(`[RD.40] el embarque del CEDIS a la 502 ($23,263) no aparece en la declaracion ` +
      `(carga_sin_medir=${r502 && r502.carga_sin_medir}). El filtro de sucursal sigue puesto.`);
  }

  // Y el CEDIS entra al LEDGER cuando cae dentro de la ventana: la 23 recibio $2,659 el 8-jul,
  // y su `carga_desde` es el 29-jun, asi que ese embarque es medible y debe contar.
  const d23 = (await knex.raw(`
    SELECT round(coalesce(sum(costo_doc), 0), 2)::float AS imp
      FROM analytics.mv_rd_route_ledger
     WHERE route_no = '23' AND clase = 'carga' AND business_date = DATE '2026-07-08'`)).rows[0];
  if (!(Number(d23.imp) > 2000)) {
    throw new Error(`[RD.40] el embarque del CEDIS a la 23 del 8-jul ($2,659) no entro al ledger ` +
      `(imp=${d23.imp}). El filtro de sucursal del embarque sigue puesto.`);
  }

  // El lado que [RD.30] no cubria: Canindo vende antes de su primer embarque.
  const r501 = op.find((x) => x.route_no === '501');
  if (!r501 || !(Number(r501.venta_sin_medir) > 0)) {
    throw new Error(`[RD.40] la 501 vendia antes de su primer embarque y la declaracion no lo ve ` +
      `(venta_sin_medir=${r501 && r501.venta_sin_medir}).`);
  }

  // PRUEBA NEGATIVA: el veredicto no puede ser decorativo. Sin esto es el `cfg ? classify : 'ok'`
  // que la Fase VP midio dando verde incondicional a tres matvistas del sell-out.
  const mentira = op.filter((x) => x.medible && Number(x.exposicion_costo) > 0);
  if (mentira.length) {
    throw new Error(`[RD.40] ${mentira.length} ruta(s) salen medibles con exposicion > 0: ` +
      mentira.map((x) => x.route_no).join(', '));
  }
  // Y al reves, para que no quede clavado en false.
  const clavado = op.filter((x) => !x.medible && Number(x.exposicion_costo) === 0 &&
    Number(x.docs_sin_medir) === 0 && x.primera_venta);
  if (clavado.length) {
    throw new Error(`[RD.40] ${clavado.length} ruta(s) sin exposicion salen NO medibles: el veredicto esta clavado.`);
  }

  const expuesto = op.reduce((s, x) => s + Number(x.exposicion_costo || 0), 0);
  console.log(`  · [RD.40] ${op.filter((x) => x.medible).length} de ${op.length} rutas con residuo publicable` +
    ` · exposicion declarada: $${expuesto.toFixed(2)}`);
};

exports.down = async function down(knex) {
  // Volver atras es volver a la contradiccion, asi que el `down` solo quita las columnas nuevas
  // de la declaracion. El `desde` del ledger NO se restaura al `LEAST` de [RD.37] a proposito.
  await knex.raw(`
    CREATE OR REPLACE VIEW ${OPEN} AS
    SELECT i.tenant_id, i.route_no, i.plaza,
           c.primer_embarque, v.primera_venta, i.carga_desde,
           GREATEST(0, (i.carga_desde - c.primer_embarque))::int AS dias_ciegos,
           coalesce(a.carga_sin_medir, 0)::numeric               AS carga_sin_medir,
           coalesce(a.docs_sin_medir, 0)::int                    AS docs_sin_medir
      FROM analytics.mv_rd_route_identity i
      CROSS JOIN LATERAL (
           SELECT min(h.c9)::date AS primer_embarque
             FROM kepler_ods.kdm1 h
            WHERE h.sucursal = i.suc_emisor AND h.c2='U' AND h.c3='D' AND h.c4=41
              AND h.c9 > '2020-01-01' AND h.c10 IN (${ROTULOS})
      ) c
      CROSS JOIN LATERAL (
           SELECT min(p.business_date)::date AS primera_venta
             FROM analytics.route_push_lines p
            WHERE p.tenant_id = i.tenant_id AND p.route_no = i.route_no
      ) v
      LEFT JOIN LATERAL (
           SELECT sum(d.c13::numeric)             AS carga_sin_medir,
                  count(DISTINCT (h.c6, h.c9))    AS docs_sin_medir
             FROM kepler_ods.kdm1 h
             JOIN kepler_ods.kdm2 d
               ON d.sucursal = h.sucursal AND d.c1 = h.c1 AND d.c2 = h.c2 AND d.c3 = h.c3
              AND d.c4 = h.c4 AND d.c5 = h.c5 AND d.c6 = h.c6
            WHERE h.sucursal = i.suc_emisor AND h.c2='U' AND h.c3='D' AND h.c4=41
              AND h.c9 > '2020-01-01' AND h.c9::date < i.carga_desde
              AND h.c10 IN (${ROTULOS})
              AND coalesce(btrim(d.c11),'') NOT IN ('SER','')
      ) a ON true
  `);
  await knex.raw(`ALTER VIEW ${OPEN} SET (security_invoker = true)`);
  await knex.raw(`GRANT SELECT ON ${OPEN} TO app_runtime`);
};
