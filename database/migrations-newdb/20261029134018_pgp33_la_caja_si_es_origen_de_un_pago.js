/**
 * [PGP.33] La caja SI es origen de un pago: `v_supplier_payment_habit` deja de retener 111 propuestas.
 *
 * ## Que estaba mal
 *
 * [PGP.30] nacio con una premisa HEREDADA del Calendario: el selector de cuenta de origen excluia
 * `kind = 'cash'` porque *«la caja no es origen de una transferencia»*. La vista la respeto y marco
 * esas propuestas como `cuenta_estado = 'caja_general'` -- informar, en vez de proponer un id que
 * el desplegable no podia pintar. Dado el selector de entonces, era lo correcto.
 *
 * ⛔⛔ **La premisa esta medida y es falsa.** Contra prod el 2026-10-29 (sid 7688376744939610156),
 * cruzando `analytics.erp_supplier_payments` con el decode bancario del propio ERP
 * (`analytics.kepler_bank_movements`), sobre los 4,898 pagos a proveedor:
 *
 *   | de donde salio          | pagos |        dinero | % del dinero |
 *   |-------------------------|------:|--------------:|-------------:|
 *   | banco (transferencia)   | 1,788 | $338,738,907  |      73.2 %  |
 *   | banco (cheque)          |   252 |  $54,764,561  |      11.8 %  |
 *   | **CAJA GENERAL**        | 2,748 |  $54,513,146  |      11.8 %  |
 *   | banco (anticipo)        |    79 |  $10,601,640  |       2.3 %  |
 *   | CAJA GENERAL (anticipo) |    31 |   $4,285,890  |       0.9 %  |
 *
 * Y no es una lectura nuestra: de esos 2,779 pagos, **2,771 ($54,897,784)** aparecen en
 * `kepler_bank_movements` con `tipo_cuenta = 'caja'` -- o sea que **Kepler mismo** los clasifica
 * como caja. Nuestro catalogo tiene exactamente una cuenta `kind = 'cash'`, y es esa.
 *
 * ⭐ Caja General es el **56.7 % de los pagos** por conteo y el **12.7 % del dinero**: muchos y
 * chicos. El selector no podia reproducir mas de la mitad de como se ha pagado siempre, y quien
 * pagaba desde ahi tenia que mentirle al formulario eligiendo otra cuenta.
 *
 * ## Que cambia aca
 *
 * `ofrecible` deja de exigir `kind <> 'cash'` y pasa a ser solo `active`. Con eso el estado
 * `caja_general` ya no tiene razon de existir: una cuenta de caja se propone como cualquier otra,
 * con su evidencia (veces / de / ultima vez), y quien paga sigue pudiendo contradecirla.
 *
 * ⚠️ **Lo que NO se afirma** (ADR-056): si esos 2,771 salieron fisicamente en efectivo, o por una
 * transferencia ordenada desde el escritorio de Caja General, **no se puede saber desde el ODS**.
 * Kepler los rotula `transferencia` porque su `kdm1.c31` solo distingue tres valores y `efectivo`
 * no es uno. Por eso la caja se OFRECE y, cuando domina, se propone -- pero el METODO que se
 * propone sigue saliendo de c31 y no se traduce a `efectivo` por deduccion.
 *
 * Fuente: `analytics.erp_supplier_payments`. Sin tablas nuevas y sin copias (reglas 1 y 2).
 */

const pgp30 = require('./20261028163649_pgp30_habito_de_pago_del_acreedor.js');

/** Misma concentracion que [PGP.30]: si cambiara, cambiaria el universo y no solo el filtro. */
const PISO = pgp30.SQL.PISO;

/**
 * El filtro viejo y el nuevo, textuales. Se reemplaza por SUSTITUCION sobre el cuerpo de [PGP.30]
 * en vez de copiar sus ~70 lineas de SELECT: una copia se desincroniza en silencio la proxima vez
 * que alguien toque el puente de cuentas, y entonces habria DOS verdades sobre el mismo dato.
 */
const FILTRO_VIEJO = `(b.active AND coalesce(b.kind, 'bank') <> 'cash') AS ofrecible`;
const FILTRO_NUEVO = `b.active AS ofrecible`;

/** La rama que publicaba el estado 'caja_general'. Sale entera: ya no hay nada que retener. */
const RAMA_VIEJA = `         WHEN NOT c.ofrecible THEN 'caja_general'\n`;

function construir() {
  let s = pgp30.SQL.CUERPO;
  for (const [viejo, nuevo, quien] of [
    [FILTRO_VIEJO, FILTRO_NUEVO, 'el filtro de ofrecible'],
    [RAMA_VIEJA, '', "la rama caja_general"],
  ]) {
    const partes = s.split(viejo);
    if (partes.length !== 2) {
      throw new Error(
        `[PGP.33] ${quien} aparece ${partes.length - 1} veces en el cuerpo de [PGP.30]. ` +
        'Alguien lo movio: revisar a mano antes de aplicar, NO ajustar el ancla a ciegas.',
      );
    }
    s = partes.join(nuevo);
  }
  return s;
}

/**
 * El comentario viejo describia la premisa que acaba de caer. Si se queda, la vista se
 * auto-documenta mintiendo, que es peor que no tener comentario.
 */
const COMENTARIO = `
  COMMENT ON VIEW analytics.v_supplier_payment_habit IS
    'PGP.33 (antes PGP.30) - Con que se le suele pagar a cada acreedor, derivado de analytics.erp_supplier_payments. PROPONE, no decide: cada sugerencia viaja con veces/de/ultima_vez. La cuenta de origen se traduce al catalogo propio por alias o por banco+digitos (16 de 20 cuentas, 96.7 % de los pagos). CAJA GENERAL SI se propone desde PGP.33: medido 2026-10-29, 2,771 pagos ($54,897,784) salieron de ella y el propio decode de Kepler los clasifica tipo_cuenta=caja; el estado caja_general se retiro. No propone efectivo ni cargo_automatico porque Kepler (kdm1.c31) no los distingue -- ausencia de propuesta no es evidencia de que no se usen -- y excluye anticipo porque no es un metodo. no_resuelve = la cuenta existe en Kepler pero no casa con ninguna nuestra; nunca se adivina.'
`;

/**
 * La sonda. ⛔ No se mide con `count(*)` pelado: medido en [PGP.32], el planificador lo resuelve
 * SIN producir las columnas que la compuerta cree vigilar. Se piden las columnas que cambian.
 */
const SONDA = `SELECT proveedor_code, cuenta_estado, cuenta_origen_id, cuenta_origen_nombre,
                      metodo_sugerido FROM analytics.v_supplier_payment_habit`;

/** La primera medicion paga el calentamiento de cache y no se cita; se cita la segunda. */
async function medir(knex) {
  await knex.raw(SONDA);
  const t0 = process.hrtime.bigint();
  const { rows } = await knex.raw(SONDA);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  return {
    ms,
    filas: rows.length,
    conCuenta: rows.filter((x) => x.cuenta_origen_id).length,
    enCaja: rows.filter((x) => x.cuenta_estado === 'caja_general').length,
    conMetodo: rows.filter((x) => x.metodo_sugerido).length,
  };
}

/**
 * ⛔⛔ El tope es RELATIVO a lo que esta migracion mide un instante ANTES de reemplazar nada.
 * [PGP.31] se autorrevirtio en prod por copiar un tope fijo de otra migracion, que vigilaba otra
 * vista con otro piso: imposible de cumplir por construccion, habria disparado con cero cambios.
 * Un umbral copiado mide la vista de la OTRA migracion, no la tuya.
 */
const FACTOR = 1.5;
const MARGEN_MS = 500;

exports.up = async function up(knex) {
  const antes = await medir(knex);

  await knex.raw(construir());
  await knex.raw(COMENTARIO);
  await knex.raw('GRANT SELECT ON analytics.v_supplier_payment_habit TO app_runtime');
  await knex.raw('GRANT SELECT ON analytics.v_supplier_payment_habit TO dev_ro');

  const ahora = await medir(knex);

  console.log(
    `[PGP.33] acreedores ${antes.filas} -> ${ahora.filas} · ` +
    `con cuenta propuesta ${antes.conCuenta} -> ${ahora.conCuenta} (+${ahora.conCuenta - antes.conCuenta}) · ` +
    `retenidas por 'caja_general' ${antes.enCaja} -> ${ahora.enCaja} · ` +
    `metodo ${antes.conMetodo} -> ${ahora.conMetodo} · ` +
    `${antes.ms.toFixed(0)} ms -> ${ahora.ms.toFixed(0)} ms`,
  );

  // ── Controles. Al lado de cada uno, lo que devolveria si NO se hubiera aplicado nada. ──────
  // 1 · El estado que se retira no puede quedar ni uno. (Sin aplicar: 111.)
  if (ahora.enCaja !== 0) {
    throw new Error(`[PGP.33] quedan ${ahora.enCaja} acreedores en estado 'caja_general'. La rama no se retiro; se revierte.`);
  }
  // 2 · Tiene que GANAR propuestas: es el unico motivo de esta migracion. (Sin aplicar: +0.)
  if (ahora.conCuenta <= antes.conCuenta) {
    throw new Error(
      `[PGP.33] las propuestas de cuenta no subieron (${antes.conCuenta} -> ${ahora.conCuenta}). ` +
      'Si el filtro era lo unico que las retenia, esto no puede pasar: se revierte.',
    );
  }
  // 3 · Y nadie pierde lo que ya tenia: ninguna fila puede decir 'no_resuelve' y traer un id.
  const { rows: contradice } = await knex.raw(
    `SELECT count(*)::int AS n FROM analytics.v_supplier_payment_habit
      WHERE cuenta_estado = 'no_resuelve' AND cuenta_origen_id IS NOT NULL`,
  );
  if (Number(contradice[0].n) > 0) {
    throw new Error(`[PGP.33] ${contradice[0].n} filas dicen 'no_resuelve' y traen un id igual. La vista se contradice; se revierte.`);
  }
  // 4 · La cuenta que ahora se propone tiene que ser una que el selector REALMENTE ofrezca, o
  //     repetiriamos el defecto de [PGP.30] al reves: un id que el desplegable no puede pintar.
  const { rows: fantasma } = await knex.raw(
    `SELECT h.proveedor_code, h.cuenta_origen_nombre
       FROM analytics.v_supplier_payment_habit h
       LEFT JOIN finance.bank_accounts b ON b.id = h.cuenta_origen_id AND b.active
      WHERE h.cuenta_origen_id IS NOT NULL AND b.id IS NULL LIMIT 5`,
  );
  if (fantasma.length) {
    throw new Error(
      `[PGP.33] se proponen cuentas que el selector no ofrece (${fantasma.map((f) => f.cuenta_origen_nombre).join(', ')}). Se revierte.`,
    );
  }

  const tope = Math.round(antes.ms * FACTOR + MARGEN_MS);
  if (ahora.ms > tope) {
    throw new Error(
      `[PGP.33] la vista paso de ${antes.ms.toFixed(0)} ms a ${ahora.ms.toFixed(0)} ms ` +
      `(tope ${tope} ms = ${FACTOR}x lo medido antes + ${MARGEN_MS} ms). Se revierte.`,
    );
  }
};

exports.down = async function down(knex) {
  // Vuelve EXACTO a [PGP.30], comentario incluido: un down a medias deja en prod una vista que
  // ninguna migracion describe.
  await knex.raw(pgp30.SQL.CUERPO);
  await knex.raw(`
    COMMENT ON VIEW analytics.v_supplier_payment_habit IS
      'PGP.30 (restaurada por el down de PGP.33) - la cuenta de CAJA GENERAL vuelve a retenerse como cuenta_estado=caja_general y no se propone.'
  `);
  await knex.raw('GRANT SELECT ON analytics.v_supplier_payment_habit TO app_runtime');
  await knex.raw('GRANT SELECT ON analytics.v_supplier_payment_habit TO dev_ro');
};

exports.SQL = { construir, FILTRO_VIEJO, FILTRO_NUEVO, RAMA_VIEJA, PISO, FACTOR, MARGEN_MS };
