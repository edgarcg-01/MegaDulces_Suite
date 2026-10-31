/**
 * [PGP.41] `analytics.v_pago_sugerido` — QUE HAY QUE PAGAR, dicho por el sistema.
 *
 * ## Por que existe
 *
 * Pedido de Edgar, 2026-10-31: *«te pedi 100% de automatizacion. ya el mismo sistema me debe
 * decir que pago»*. Hasta hoy el Calendario sabia todo lo necesario y **no lo decia solo**:
 * alguien tenia que abrir el dia, apretar «proponer», y la propuesta ordenaba por la factura mas
 * vieja — que pone adelante deuda de 22 meses y nunca llega a lo que gana descuento.
 *
 * Medido contra prod el 2026-10-31 (sid 7688376744939610156), el sabado que lo motivo: el dia
 * estaba **sin pagos y sin tope**, y al mismo tiempo habia **$2,965.58** de descuento venciendo
 * ESE dia y **$215,308.35** venciendo en los tres siguientes. Nadie lo habria visto.
 *
 * ## Que responde, por acreedor
 *
 *   - **cuanto hay que pagarle** y **cuanto se gana** si sale dentro de su ventana;
 *   - **cuando cierra** esa ventana y cuantos dias quedan;
 *   - **si se puede preparar hoy**: `cuenta_estado` sale del REP que el propio proveedor timbra,
 *     asi que la respuesta ya viene con su evidencia, no con una promesa.
 *
 * ## Lo que DEJA FUERA, y por que (cada exclusion es una decision, no un filtro)
 *
 *   1. ⛔ **Los compromisos financieros** (`grupo 140`, prefijos `A`/`TC`/`B.B.`). Medido: los
 *      dos mayores son **prestamos de socios** por $14,480,000, vencidos hace 22 meses, que
 *      encabezan cualquier orden por antiguedad y **nunca caben** en el tope de un dia. No son
 *      deuda de proveedor y no se programan por este carril. Siguen enteros en su estado de
 *      cuenta de acreedor.
 *   2. ⛔ **Lo que no gana nada por adelantarse**: sin ventana medida, o con la ventana ya
 *      cerrada. Adelantar dinero sin descuento medido es sacarlo antes por nada.
 *   3. ⚠️ **NO excluye** al proveedor inactivo ni a la factura vieja: eso lo decide quien paga.
 *      Esta vista PROPONE por dinero en riesgo; no depura la cartera.
 *
 * ⚠️ **Lo que la cifra NO es** (ADR-056): el descuento es la **ventana OBSERVADA** —lo que de
 * hecho se cobro con ese proveedor—, no una condicion pactada; ese dato no existe en ningun
 * sistema. Es una guia medida, no una promesa, y la vista lo dice en su comentario.
 *
 * Fuente: `analytics.v_supplier_payables` (ODS) + `analytics.mv_supplier_prompt_discount` +
 * `analytics.v_supplier_account_proposal`. Sin tablas nuevas y sin copias (reglas 1 y 2).
 */

const { PRONTO_PAGO_MIN_OBS } = { PRONTO_PAGO_MIN_OBS: 3 };

/**
 * Horizonte de la propuesta, en dias. Siete porque cubre la semana completa que la pantalla ya
 * muestra: una ventana que cierra el jueves tiene que verse el viernes anterior, no el mismo dia.
 * ⚠️ NO es el margen de aviso del renglon (`PRONTO_PAGO_DIAS_AVISO = 5`): aquel dice "esto urge",
 * este dice "esto entra en la propuesta". Mezclarlos haria que la propuesta ignorara dos dias.
 */
const HORIZONTE_DIAS = 7;

/** El predicado de "es financiero", EXACTO al de `sqlClassificationKepler` del Calendario. */
const FINANCIERO = `(btrim(coalesce(v.grupo, '')) = '140'
                     OR upper(btrim(v.proveedor)) LIKE 'A%'
                     OR upper(btrim(v.proveedor)) LIKE 'TC%'
                     OR upper(btrim(v.proveedor)) LIKE 'B.B.%')`;

const CUERPO = `
  CREATE OR REPLACE VIEW analytics.v_pago_sugerido AS
  WITH
  -- Una fila por acreedor con su mejor estado de cuenta destino. ⛔ Sin este DISTINCT ON el join
  -- infla: v_supplier_account_proposal es una fila por acreedor X cuenta declarada (hasta 9).
  cta AS (
    SELECT DISTINCT ON (proveedor_code) proveedor_code, estado, clabe_propuesta
      FROM analytics.v_supplier_account_proposal
     ORDER BY proveedor_code, (estado = 'propuesta') DESC, veces_declarada DESC NULLS LAST),
  fac AS (
    SELECT v.proveedor, v.proveedor_nombre, v.sucursal, v.folio, v.vencimiento, v.pendiente,
           d.tasa_observada,
           CASE WHEN d.n_observaciones >= ${PRONTO_PAGO_MIN_OBS} AND v.fecha IS NOT NULL
                THEN v.fecha + d.dias_mediana END AS limite,
           CASE WHEN d.n_observaciones >= ${PRONTO_PAGO_MIN_OBS} AND d.tasa_observada IS NOT NULL
                THEN round(v.pendiente * d.tasa_observada, 2) END AS gana
      FROM analytics.v_supplier_payables v
      LEFT JOIN analytics.mv_supplier_prompt_discount d
             ON btrim(d.proveedor_code) = btrim(v.proveedor)
     WHERE NOT ${FINANCIERO})
  SELECT
    (nullif(current_setting('app.tenant_id', true), ''))::uuid AS tenant_id,
    f.proveedor        AS proveedor_code,
    max(f.proveedor_nombre) AS proveedor_nombre,
    count(*)::int      AS facturas,
    sum(f.pendiente)   AS importe,
    sum(f.gana)        AS gana,
    max(f.tasa_observada) AS tasa,
    min(f.limite)      AS cierra,
    (min(f.limite) - current_date)::int AS dias_restantes,
    min(f.vencimiento) AS vence_la_mas_vieja,
    -- Que tan cara sale la espera: pesos de descuento por cada peso que hay que adelantar.
    round(sum(f.gana) / nullif(sum(f.pendiente), 0), 4) AS rendimiento,
    coalesce(max(c.estado), 'sin_cruce') AS cuenta_estado,
    -- ⛔ La CLABE NO viaja en la propuesta: esta vista dice A QUIEN pagarle, no a que cuenta.
    -- El numero se ve al firmar el alta, que es donde alguien se hace responsable.
    (max(c.estado) = 'propuesta') AS se_puede_preparar_hoy
  FROM fac f
  LEFT JOIN cta c ON btrim(c.proveedor_code) = btrim(f.proveedor)
 WHERE f.limite IS NOT NULL
   AND f.limite >= current_date
   AND f.limite <= current_date + ${HORIZONTE_DIAS}
   AND f.gana > 0
 GROUP BY f.proveedor
`;

const COMENTARIO = `
  COMMENT ON VIEW analytics.v_pago_sugerido IS
    'PGP.41 - Que hay que pagar, por acreedor, ordenado por el dinero que se pierde si se espera. Entra lo que tiene ventana de pronto pago ABIERTA que cierra dentro de 7 dias y beneficio medido > 0. Excluye compromisos financieros (grupo 140 y prefijos A/TC/B.B.): los dos mayores son prestamos de socios por $14,480,000 vencidos hace 22 meses que encabezan cualquier orden por antiguedad y nunca caben en el tope de un dia. NO excluye proveedor inactivo ni factura vieja: eso lo decide quien paga. El descuento es la ventana OBSERVADA (lo que de hecho se cobro con ese proveedor), NO una condicion pactada: guia medida, no promesa.'
`;

/** La sonda pide las columnas que cambian: un count(*) pelado no las produce (leccion de PGP.32). */
const SONDA = `SELECT proveedor_code, facturas, importe, gana, cierra, dias_restantes,
                      cuenta_estado, se_puede_preparar_hoy FROM analytics.v_pago_sugerido`;

const FACTOR = 1.5;
const MARGEN_MS = 500;

exports.up = async function up(knex) {
  // El piso: lo que cuesta la fuente ANTES de crear nada. El tope se compara contra esto, no
  // contra un numero copiado de otra migracion (por eso [PGP.31] se autorrevirtio en prod).
  const t0 = process.hrtime.bigint();
  await knex.raw('SELECT count(*) FROM analytics.v_supplier_payables');
  const msPiso = Number(process.hrtime.bigint() - t0) / 1e6;

  await knex.raw(CUERPO);
  await knex.raw(COMENTARIO);
  await knex.raw('GRANT SELECT ON analytics.v_pago_sugerido TO app_runtime');
  await knex.raw('GRANT SELECT ON analytics.v_pago_sugerido TO dev_ro');

  await knex.raw(SONDA);
  const t1 = process.hrtime.bigint();
  const { rows } = await knex.raw(SONDA);
  const ms = Number(process.hrtime.bigint() - t1) / 1e6;

  const dinero = rows.reduce((s, r) => s + Number(r.importe || 0), 0);
  const gana = rows.reduce((s, r) => s + Number(r.gana || 0), 0);
  const hoy = rows.filter((r) => Number(r.dias_restantes) === 0);
  const listos = rows.filter((r) => r.se_puede_preparar_hoy).length;
  const f = (n) => '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  console.log(
    `[PGP.41] ${rows.length} acreedores sugeridos · pagar ${f(dinero)} · ganar ${f(gana)} · ` +
    `${hoy.length} cierran HOY · ${listos} con cuenta proponible · ${ms.toFixed(0)} ms`,
  );

  // ── Controles, con lo que daria si la vista estuviera mal ──────────────────────────────────
  // 1 · Una propuesta vacia no es barata: no sirve. (Medido el 2026-10-31: 15 acreedores.)
  if (rows.length === 0) {
    throw new Error('[PGP.41] 0 acreedores sugeridos. Con la deuda viva de hoy eso es imposible; se revierte.');
  }
  // 2 · Ninguna fila puede proponer sin ganar: es la unica razon por la que entra.
  const sinGanar = rows.filter((r) => !(Number(r.gana) > 0)).length;
  if (sinGanar > 0) {
    throw new Error(`[PGP.41] ${sinGanar} acreedores entraron sin beneficio medido. Se revierte.`);
  }
  // 3 · Ninguna ventana cerrada ni fuera del horizonte.
  const fueraDeRango = rows.filter((r) => Number(r.dias_restantes) < 0 || Number(r.dias_restantes) > HORIZONTE_DIAS).length;
  if (fueraDeRango > 0) {
    throw new Error(`[PGP.41] ${fueraDeRango} acreedores fuera del horizonte de ${HORIZONTE_DIAS} dias. Se revierte.`);
  }
  // 4 · PRUEBA NEGATIVA de la exclusion financiera: los prestamos de socios NO pueden aparecer.
  //     Sin el filtro aparecerian (su deuda es la mas vieja de todas).
  const { rows: socios } = await knex.raw(
    `SELECT count(*)::int AS n FROM analytics.v_pago_sugerido WHERE upper(btrim(proveedor_code)) LIKE 'A%'`,
  );
  if (Number(socios[0].n) > 0) {
    throw new Error(`[PGP.41] ${socios[0].n} acreedores financieros se colaron en la propuesta. Se revierte.`);
  }
  // 5 · Y no infla: un acreedor, una fila.
  const { rows: dup } = await knex.raw(
    `SELECT count(*)::int AS filas, count(DISTINCT proveedor_code)::int AS acreedores FROM analytics.v_pago_sugerido`,
  );
  if (Number(dup[0].filas) !== Number(dup[0].acreedores)) {
    throw new Error(`[PGP.41] ${dup[0].filas} filas para ${dup[0].acreedores} acreedores: el join infla. Se revierte.`);
  }

  const tope = Math.round(msPiso * FACTOR + MARGEN_MS);
  if (ms > tope) {
    throw new Error(
      `[PGP.41] la vista cuesta ${ms.toFixed(0)} ms contra un piso de ${msPiso.toFixed(0)} ms de su fuente ` +
      `(tope ${tope} ms = ${FACTOR}x + ${MARGEN_MS} ms). Una propuesta que frena la pantalla no se usa; se revierte.`,
    );
  }
};

exports.down = async function down(knex) {
  await knex.raw('DROP VIEW IF EXISTS analytics.v_pago_sugerido');
};

exports.SQL = { CUERPO, SONDA, HORIZONTE_DIAS, FINANCIERO, FACTOR, MARGEN_MS };
