/**
 * RD.6 — Siembra de la escala `RD-2026`: el tabulador, los bonos, las 13 rutas y las 27
 * quincenas, tal como los tiene hoy `INDICADORES RD 2026.xlsx`.
 *
 * Es el equivalente de CB.6, que sembró 26 reglas reproduciendo exacto el `classify()`
 * hardcodeado para que la migración fuera NEUTRAL y el cambio se pudiera medir contra el
 * comportamiento previo. Acá igual: estos valores tienen que reproducir el `A PAGAR` del
 * Excel al centavo, y el smoke lo verifica.
 *
 * ── EL COMPARADOR IMPORTA ───────────────────────────────────────────────────────────────
 * El Excel no usa el mismo operador en todas las reglas: los escalones comparan con `<`
 * (o sea el piso es `>=`), los bonos del chofer con `>=` (`IF(BQ11>=215999.99,200,0)`) y
 * el bono del supervisor con `>` (`IF(D13>25%,500,…)`). Un `>` donde va `>=` cambia el pago
 * exactamente en el borde, que es justo donde caen los umbrales redondos. Se guarda el
 * operador en lugar de elegir uno.
 *
 * ── DOS COSAS QUE SE SIEMBRAN DECLARANDO, NO ADIVINANDO ─────────────────────────────────
 *  1. NÓMINA DE BANCO. El Excel tiene SEIS valores para el mismo concepto (FASE_RD §4.7).
 *     Se siembra el de la hoja `COMISIONES` — 3,484.96 en PH/Morelia y 5,000 en Canindo —
 *     porque es el que entra en `A PAGAR = L5 − M5`, o sea el que de verdad se paga.
 *     ⚠️ `FORMATO DE PAGO` dice 4,413.08 / 5,000 para las mismas rutas y no coincide. El
 *     smoke cuadra contra `A PAGAR`, así que si la elección está mal, sale rojo ahí.
 *  2. CHOFERES. Hay TRES maestros en el libro y ninguno concuerda (FASE_RD §5.13). Se
 *     siembra el de `FORMATO DE PAGO`, que es el del recibo de pago. La ruta 505 va en NULL
 *     porque su celda de nombre (`K4`) está vacía en el Excel; no se inventa.
 *
 * ── LO QUE NO SE SIEMBRA, Y POR QUÉ ─────────────────────────────────────────────────────
 * Las rutas 321 y 322 no llevan bono de supervisor: `FORMATO DE SUPERVISOR` sólo lista 11
 * rutas (21,22,23,26,27,28,501-505) y ellas no están. No se les inventa una regla.
 *
 * @param { import("knex").Knex } knex
 */

const TENANT = process.env.WINCAJA_TENANT_ID || '00000000-0000-0000-0000-00000000d01c';
const CODE = 'RD-2026';

// Escalones: min inclusivo, max exclusivo. El último SIN techo (FASE_RD §4.6).
const TIERS = [
  { min: 189999.99, max: 194999.99, pct: 3.75 },
  { min: 194999.99, max: 199999.99, pct: 4.25 },
  { min: 199999.99, max: 215999.99, pct: 4.562 },
  { min: 215999.99, max: null, pct: 5.0 },
];

// Bonos del chofer, por VENTA del periodo. El Excel compara con `>=`.
const BONOS_CHOFER = [
  { nombre: 'Lavadas', umbral: 215999.99, monto: 200 },
  { nombre: 'Lonche', umbral: 239999.99, monto: 800 },
  { nombre: 'Chalán', umbral: 259999.99, monto: 1000 },
];

// Bono del supervisor, por MARGEN. El Excel compara con `>` y agrega compuerta de venta.
const BONOS_SUPERVISOR = [
  { rutas: ['21', '22', '23', '26', '27', '28'], umbral: 25.0, monto: 500 },
  { rutas: ['501'], umbral: 16.499, monto: 600 },
  { rutas: ['502'], umbral: 15.299, monto: 600 },
  { rutas: ['503'], umbral: 14.499, monto: 600 },
  { rutas: ['504', '505'], umbral: 16.499, monto: 600 },
];
const GATE_VENTA = 189999.0;

const ZONA_PH = 'La Piedad y Padre Hidalgo';
const ZONA_MOR = 'Morelia, Michoacán';
const ZONA_ZAM = 'Zamora, Michoacán';
const SUP_PH = 'ANGEL ALBERTO VAZQUEZ MEJIA';
const SUP_CAN = 'FRANCISCO DE JESUS MARTINEZ RAZO';
const SUP_MOR = 'EDUARDO LOPEZ SAINZ';

// route_code, nómina banco, zona, supervisor, chofer (maestro de FORMATO DE PAGO)
const RUTAS = [
  ['21', 3484.96, ZONA_PH, SUP_PH, 'Victorino Urbano Olivarez'],
  ['22', 3484.96, ZONA_PH, SUP_PH, 'Enrique Fuentes Montes'],
  ['23', 3484.96, ZONA_PH, SUP_PH, 'Joaquin Hurtado Orozco'],
  ['26', 3484.96, ZONA_PH, SUP_PH, 'Victor Hugo Garcia Hurtado'],
  ['27', 3484.96, ZONA_PH, SUP_PH, 'Mariano Martinez Patlan'],
  ['28', 3484.96, ZONA_PH, SUP_PH, 'Maria Elena Valadez Limon'],
  ['321', 3484.96, ZONA_MOR, SUP_MOR, 'Joseph Agustin Guerrero Perez'],
  ['322', 3484.96, ZONA_MOR, SUP_MOR, 'Eduardo Miranda Romero'],
  ['501', 5000.0, ZONA_ZAM, SUP_CAN, 'Victor Manuel Zalapa Barriga'],
  ['502', 5000.0, ZONA_ZAM, SUP_CAN, 'Daniel Padilla Rojano'],
  ['503', 5000.0, ZONA_ZAM, SUP_CAN, 'Jose De Jesus Zavala Villalobos'],
  ['504', 5000.0, ZONA_ZAM, SUP_CAN, 'Jose Luis Muñoz Mota'],
  ['505', 5000.0, ZONA_ZAM, SUP_CAN, null], // K4 vacía en el Excel — no se inventa
];

exports.up = async function up(knex) {
  // El operador de comparación no estaba en el esquema y el Excel usa dos distintos.
  if (!(await knex.schema.withSchema('commercial').hasColumn('commission_bonuses', 'comparador'))) {
    await knex.raw(`
      ALTER TABLE commercial.commission_bonuses
        ADD COLUMN comparador varchar(4) NOT NULL DEFAULT 'gte',
        ADD CONSTRAINT commission_bonuses_comparador_valid CHECK (comparador IN ('gt','gte'))`);
    await knex.raw(`
      COMMENT ON COLUMN commercial.commission_bonuses.comparador IS
        'RD.6 — el Excel no usa el mismo operador en todas las reglas: bonos del chofer con >= y bono del supervisor con >. Un > donde va >= cambia el pago justo en el borde, que es donde caen los umbrales redondos.'`);
  }

  const ya = await knex('commercial.commission_scales')
    .where({ tenant_id: TENANT, code: CODE }).whereNull('deleted_at').first('id');
  if (ya) return; // idempotente

  await knex.transaction(async (trx) => {
    await trx.raw(`SET LOCAL app.tenant_id = '${TENANT}'`);

    const [scale] = await trx('commercial.commission_scales')
      .insert({
        tenant_id: TENANT,
        code: CODE,
        nombre: 'Ruta Directa 2026 — tabulador vigente del workbook INDICADORES RD',
        valid_from: '2026-01-01',
        valid_to: null,
        base_field: 'subtotal',
        gate_field: 'venta',
        share_supervisor_pct: 20,
        notes: 'Sembrada de INDICADORES RD 2026.xlsx (hoja COMISIONES). Corrige al migrar: un solo umbral (el Excel usaba 169,999.99 en las rutas 22 y 23), escalon superior sin techo (el Excel devolvia FALSE arriba de 400,000 y pagaba cero) y factor de supervisor del periodo (estaba anclado a una fila fija).',
      })
      .returning('id');
    const scaleId = scale.id || scale;

    await trx('commercial.commission_scale_tiers').insert(
      TIERS.map((t) => ({
        tenant_id: TENANT, scale_id: scaleId, min_amount: t.min, max_amount: t.max, pct: t.pct,
      })),
    );

    const bonos = BONOS_CHOFER.map((b) => ({
      tenant_id: TENANT, scale_id: scaleId, beneficiario: 'chofer', nombre: b.nombre,
      metrica: 'venta', umbral: b.umbral, monto: b.monto, comparador: 'gte',
      route_code: null, gate_venta_min: null,
    }));
    for (const g of BONOS_SUPERVISOR) {
      for (const r of g.rutas) {
        bonos.push({
          tenant_id: TENANT, scale_id: scaleId, beneficiario: 'supervisor',
          nombre: 'Alcance de margen', metrica: 'margen_pct', umbral: g.umbral,
          monto: g.monto, comparador: 'gt', route_code: r, gate_venta_min: GATE_VENTA,
        });
      }
    }
    await trx('commercial.commission_bonuses').insert(bonos);

    await trx('commercial.commission_route_config').insert(
      RUTAS.map(([route_code, nomina_banco, zona, supervisor_nombre, chofer_nombre]) => ({
        tenant_id: TENANT, route_code, scale_id: scaleId, nomina_banco, zona,
        supervisor_nombre, chofer_nombre, activo: true,
      })),
    );

    // 27 quincenas de 2026. El Excel: fin del periodo 1 = 2026-01-14, +14 dias cada uno;
    // inicio = fin - 13, pago = fin + 3.
    await trx.raw(`
      INSERT INTO commercial.commission_periods (tenant_id, anio, period_no, date_from, date_to, pay_date)
      SELECT ?, 2026, n,
             (DATE '2026-01-14' + (n - 1) * 14) - 13,
              DATE '2026-01-14' + (n - 1) * 14,
             (DATE '2026-01-14' + (n - 1) * 14) + 3
        FROM generate_series(1, 27) AS n`, [TENANT]);
  });
};

exports.down = async function down(knex) {
  const sc = await knex('commercial.commission_scales')
    .where({ tenant_id: TENANT, code: CODE }).first('id');
  if (sc) {
    // tiers y bonuses caen por CASCADE; route_config es RESTRICT, va primero.
    await knex('commercial.commission_route_config').where({ tenant_id: TENANT, scale_id: sc.id }).del();
    await knex('commercial.commission_scales').where({ id: sc.id }).del();
  }
  await knex('commercial.commission_periods').where({ tenant_id: TENANT, anio: 2026 }).del();
};
