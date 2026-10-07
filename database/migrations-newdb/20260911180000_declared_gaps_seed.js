/**
 * R.0b — LOS HUECOS DE §7, SEMBRADOS CON SU CONDICIÓN DE CADUCIDAD Y SU CIFRA RE-MEDIDA HOY.
 *
 * No se copian los montos de `docs/VERDAD_ABSOLUTA.md` §7: **se vuelven a medir**. Ése es el punto
 * de la fase — dos de esos huecos llevaban semanas con la cifra y el motivo de agosto.
 *
 * ⭐ **`ud8_sin_arbitro` y `wincaja_peldano_nulo` se siembran A PROPÓSITO antes de arreglarlos**,
 * para que el candado `test-newdb-declared-gaps.js` salga **ROJO** en su primera corrida. Un gate
 * sin prueba negativa es una intención (ADR-056): si sembrar un hueco que YA no es hueco lo dejara
 * verde, el mecanismo no serviría para nada.
 *
 * ── El contrato del `recheck_sql` ───────────────────────────────────────────────────────────
 *
 * Devuelve UNA fila: `sigue_siendo_hueco` boolean + `detalle` text. Y la pregunta que responde no
 * es *"¿el síntoma sigue ahí?"* sino **"¿sigue siendo cierto el MOTIVO por el que se declaró?"**.
 * La diferencia importa y es justo lo que se midió:
 *
 *   · `U-D-8` se declaró porque *"la fuente no da costo"*. El síntoma sigue (`c62` al 1.15%), pero
 *     el motivo es falso: `c58` está al 99.97% y hay costo del mismo almacén al 99.54%.
 *   · Wincaja se declaró porque *"no declara peldaño"*. Cierto **por renglón**
 *     (`cantidad_auxiliar` sirve en 3 de 9,962,920), pero el divisor **por artículo** se conoce y
 *     hasta se aplica: el motivo confundió "no lo declara por renglón" con "no se puede saber".
 *
 * ⚠️ Los `recheck_sql` se ejecutan acá mismo como auto-verificación: si alguno no parsea o no
 * devuelve el contrato, la migración lanza. Un recheck roto es peor que no tenerlo — se leería como
 * "todo en orden".
 *
 * @param { import("knex").Knex } knex
 */

const T = '00000000-0000-0000-0000-00000000d01c';

// El join correcto a kdm1 son las SIETE columnas de la PK. Unir por 5 abanica: 22,855 encabezados
// comparten (sucursal,c2,c3,c4,c6). Ver R.5 y ods-derived.js.
const J7 = `h.sucursal = d.sucursal AND h.c1 = d.c1 AND h.c2 = d.c2 AND h.c3 = d.c3
            AND h.c4 = d.c4 AND h.c5 = d.c5 AND h.c6 = d.c6`;

const GAPS = [
  {
    clave: 'ud8_sin_arbitro',
    titulo: 'U-D-8 (Factura Telemarketing) sin arbitro de costo',
    monto: 16197173,
    unidad: 'MXN/90d',
    declarado_en: '2026-09-09',
    motivo: 'ADR-059: "U-D-8 no es arbitrable y el limite es de la fuente" porque Kepler no escribe '
      + 'c62 ni c63 ahi (vacios en el 98.85%).',
    resolver_faltante: 'un costo por almacen x SKU al grano del renglon, mas el peldano cobrado',
    estado: 'abierto',
    recheck_sql: `
      WITH l AS (
        SELECT d.sucursal, btrim(d.c8) sku,
               NULLIF(btrim(d.c58::text), '') IS NOT NULL AS tiene_peldano
          FROM kepler_ods.kdm2 d
          JOIN kepler_ods.kdm1 h ON ${J7}
         WHERE d.c2 = 'U' AND d.c3 = 'D' AND btrim(d.c4::text) = '8'
           AND h.c9 >= current_date - 90 AND d.sucursal = btrim(d.c1))
      SELECT (count(*) FILTER (WHERE l.tiene_peldano AND kc.costo_unitario > 0)
              < count(*) * 0.90) AS sigue_siendo_hueco,
             'arbitrable ' || round(100.0 * count(*) FILTER (WHERE l.tiene_peldano
                AND kc.costo_unitario > 0) / NULLIF(count(*), 0), 2) || '% de '
                || count(*) || ' renglones' AS detalle
        FROM l
        LEFT JOIN analytics.v_kepler_unit_cost kc
               ON kc.kepler_code = l.sucursal AND kc.sku = l.sku`,
  },
  {
    clave: 'wincaja_peldano_nulo',
    titulo: 'El peldano de Wincaja es un NULL mudo sobre el 55% del ingreso',
    monto: 84070801,
    unidad: 'MXN/90d',
    declarado_en: '2026-09-07',
    motivo: 'sales_daily.rung_factor NULL en el 100% de Wincaja y units_unresolved marca 0: '
      + 'no declara peldano por renglon (cantidad_auxiliar sirve en 3 filas de 9,962,920).',
    resolver_faltante: 'un divisor conocido para esas celdas, aunque sea al grano articulo',
    estado: 'abierto',
    recheck_sql: `
      SELECT (count(*) FILTER (WHERE u.metodo_cajas IS NOT NULL
                                 AND u.metodo_cajas <> 'sin_metodo')
              < count(*) * 0.50) AS sigue_siendo_hueco,
             'v_unit_truth resuelve ' || count(*) FILTER (WHERE u.metodo_cajas IS NOT NULL
                AND u.metodo_cajas <> 'sin_metodo') || ' de ' || count(*)
                || ' celdas; con rung_factor escrito: '
                || count(*) FILTER (WHERE sd.rung_factor IS NOT NULL) AS detalle
        FROM analytics.sales_daily sd
        LEFT JOIN analytics.v_unit_truth u
               ON u.tenant_id = sd.tenant_id AND u.warehouse_id = sd.warehouse_id
              AND u.product_id = sd.product_id
       WHERE sd.sale_date > current_date - 90 AND sd.channel LIKE 'wincaja_%'`,
  },
  {
    clave: 'precio_sin_arbitro',
    titulo: 'Seis publicadores de precio y ninguno contrastado contra otro',
    monto: null,
    unidad: null,
    declarado_en: '2026-09-11',
    motivo: 'No existe ninguna vista que afirme que lo PUBLICADO y lo COBRADO concuerdan. Medido y '
      + 'escrito: 982 de 4,712 SKUs con volumen (21%) se apartan mas de 25%, en ambas direcciones.',
    resolver_faltante: 'analytics.v_erp_price_truth al grano sucursal x SKU',
    estado: 'abierto',
    recheck_sql: `
      SELECT to_regclass('analytics.v_erp_price_truth') IS NULL AS sigue_siendo_hueco,
             CASE WHEN to_regclass('analytics.v_erp_price_truth') IS NULL
                  THEN 'el arbitro de precio no existe'
                  ELSE 'analytics.v_erp_price_truth existe' END AS detalle`,
  },
  {
    clave: 'negativos_existencia',
    titulo: 'Existencia negativa recortada a cero',
    monto: 67854,
    unidad: 'unidades',
    declarado_en: '2026-09-09',
    // ⭐ El motivo CORREGIDO. El anterior ("Kepler dice que salio sin haber entrado") describia el
    // sintoma; la causa es que kdil no tiene punto de partida.
    motivo: 'kdil es UNA fila por (sucursal, almacen, SKU) -- un acumulador, no un libro -- y c4 '
      + '(el saldo inicial) es 0 en las 33,906 filas. 746 de 1,807 pares no tienen NINGUNA entrada '
      + 'y si salidas: son movimientos anteriores a que el acumulador empezara.',
    resolver_faltante: 'un corte FISICO de inventario que provea el saldo inicial que kdil no tiene',
    estado: 'irresoluble_con_la_fuente',
    recheck_sql: `
      SELECT (SELECT count(*) FROM kepler_ods.kdil WHERE c4 <> 0) = 0 AS sigue_siendo_hueco,
             'kdil.c4 distinto de 0 en ' || (SELECT count(*) FROM kepler_ods.kdil WHERE c4 <> 0)
               || ' de ' || (SELECT count(*) FROM kepler_ods.kdil) || ' filas' AS detalle`,
  },
  {
    clave: 'factor_caja_ambiguo',
    titulo: 'Contradicciones de factor de caja que ningun testigo desempata',
    monto: 189376,
    unidad: 'MXN',
    declarado_en: '2026-09-10',
    // ⭐ Motivo CORREGIDO con la medicion de hoy: se probo el tercer testigo y tampoco alcanza.
    motivo: 'Tres testigos, tres numeros. El peldano vendido es mayor que la caja publicada, y lo '
      + 'PAGADO al proveedor (v_supplier_cost_ladder.units_per_box) cubre 10 de 10 pero coincide '
      + 'con el peldano en 0 y con el catalogo en 1. Afirmar cualquiera seria inventar.',
    resolver_faltante: 'un cuarto testigo documental, o una decision humana por SKU',
    estado: 'irresoluble_con_la_fuente',
    recheck_sql: `
      SELECT count(*) FILTER (WHERE lad.units_per_box = sr.rung_max) = 0 AS sigue_siendo_hueco,
             'de ' || count(*) || ' ambiguos, lo pagado coincide con el peldano en '
               || count(*) FILTER (WHERE lad.units_per_box = sr.rung_max)
               || ' y con el catalogo en '
               || count(*) FILTER (WHERE lad.units_per_box = vbf.box_factor) AS detalle
        FROM analytics.v_warehouse_box_factor vbf
        JOIN analytics.mv_kepler_sold_rung sr
          ON sr.sucursal = vbf.warehouse_code AND sr.sku = vbf.sku::text
        LEFT JOIN analytics.v_supplier_cost_ladder lad ON lad.sku = vbf.sku::text
       WHERE vbf.erp = 'kepler' AND vbf.box_factor > 1 AND sr.rung_max > vbf.box_factor`,
  },
];

exports.up = async function up(knex) {
  // Se re-siembra completo: la tabla es la foto de lo declarado HOY, no un historico.
  await knex.raw(`DELETE FROM analytics.declared_gaps WHERE tenant_id = '${T}'`);

  for (const g of GAPS) {
    // ⚠️ El recheck se PRUEBA antes de guardarlo. Uno roto se leeria como "todo en orden".
    let row;
    try {
      row = (await knex.raw(g.recheck_sql)).rows[0];
    } catch (e) {
      throw new Error(`el recheck_sql de "${g.clave}" no corre: ${e.message}`);
    }
    if (!row || typeof row.sigue_siendo_hueco !== 'boolean' || typeof row.detalle !== 'string') {
      throw new Error(`el recheck_sql de "${g.clave}" no cumple el contrato `
        + `(sigue_siendo_hueco boolean, detalle text): ${JSON.stringify(row)}`);
    }
    await knex('analytics.declared_gaps').insert({
      tenant_id: T,
      clave: g.clave,
      titulo: g.titulo,
      monto: g.monto,
      unidad: g.unidad,
      declarado_en: g.declarado_en,
      motivo: g.motivo,
      resolver_faltante: g.resolver_faltante,
      recheck_sql: g.recheck_sql,
      estado: g.estado,
      ultima_medicion: knex.fn.now(),
      ultimo_detalle: row.detalle,
    });
    const marca = row.sigue_siendo_hueco ? 'sigue siendo hueco' : '⭐ YA NO ES HUECO';
    console.log(`  [gap] ${g.clave.padEnd(24)} ${marca} — ${row.detalle}`);
  }

  // ── Auto-verificación: el mecanismo tiene que SERVIR, y eso se prueba en negativo ──
  const n = (await knex.raw(
    `SELECT count(*)::int n FROM analytics.declared_gaps WHERE tenant_id = '${T}'`)).rows[0].n;
  if (n !== GAPS.length) throw new Error(`se sembraron ${n} de ${GAPS.length} huecos`);

  // ⭐ LA PRUEBA NEGATIVA DEL MECANISMO. Al menos un hueco declarado tiene que resultar YA
  // RESUELTO en esta primera corrida — si todos siguieran siendo huecos, la tabla seria un .md
  // con pasos extra y no habria forma de saber que la compuerta funciona.
  let yaResueltos = 0;
  for (const g of GAPS) {
    const r = (await knex.raw(g.recheck_sql)).rows[0];
    if (!r.sigue_siendo_hueco) yaResueltos++;
  }
  if (yaResueltos < 1) {
    throw new Error('ningún hueco sembrado resultó ya resuelto: el mecanismo no se puede probar '
      + 'en negativo, y un gate sin prueba negativa es una intención');
  }
  console.log(`  [declared-gaps] ${n} huecos · ⭐ ${yaResueltos} YA NO SON HUECO `
    + `-> el candado tiene que salir ROJO, y eso es la prueba de que sirve`);
};

exports.down = async function down(knex) {
  await knex.raw(`DELETE FROM analytics.declared_gaps WHERE tenant_id = '${T}'`);
};
