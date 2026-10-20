'use strict';
/**
 * ⭐⭐ `[CGA-A.37]` — **El conteo REAL del 12-oct, recuperado de una foto.**
 *
 * ── Lo que pasó, fechado contra la base ─────────────────────────────────────────────────────
 *
 * Edgar, 2026-10-20: *«los primeros días el sistema no dejaba hacer arqueos, yo tengo fotos de
 * los mismos»*, y después: *«daba error al querer generar el arqueo»*.
 *
 * La línea de tiempo lo confirma al minuto, leída de `knex_migrations` y de los propios cortes:
 *
 *     06-oct 14:21   se aplica `20261006123000`: `denom_key` pasa a NOT NULL,
 *                    actualizando UNO de los dos caminos de inserción (el defecto de `[CG.155]`)
 *     12-oct 18:00   `carmen_rodriguez` ABRE el corte del 12 y cuenta el efectivo
 *                    ⛔ al guardar: ERROR. El conteo se pierde. **Ésta es la foto.**
 *     15-oct 11:26   se aplica `20261014212702` (invariantes del corte) — el arreglo
 *     15-oct 18:02   recién ahí se cierra el corte del 12, con $3,653.50
 *     15-oct 18:02   y el del 13, VEINTIDÓS SEGUNDOS después
 *     16-oct 19:04   y los del 14, 15 y 16: los tres en 63 segundos
 *
 * ⭐ **Nadie cuenta efectivo en 63 segundos.** Los cortes del 12 al 16 se cerraron en ráfaga
 * después del arreglo: lo que está sellado en esos días se transcribió de memoria o de papel,
 * días más tarde, no se contó con el cajón delante.
 *
 * ── Qué dice la foto ────────────────────────────────────────────────────────────────────────
 *
 *     $500      x   1  =    500.00
 *     $100      x   5  =    500.00
 *     $10 moneda x 160 =  1,600.00
 *     $5  moneda x 114 =    570.00
 *     $2  moneda x  57 =    114.00
 *     $1  moneda x  56 =     56.00
 *                        ──────────
 *                         3,340.00     contra los $3,653.50 que quedaron sellados (−$313.50)
 *
 * ── ⛔ Lo que esta migración NO hace, y por qué ─────────────────────────────────────────────
 *
 * **No toca `contado`, `esperado`, `diferencia` ni `estado`.** El corte está cerrado y firmado;
 * reescribir la cifra de un arqueo sellado es justo lo que `[CG.156]` prohíbe, y además la foto
 * muestra un conteo **interrumpido por el error** — no hay forma de saber si era el final.
 *
 * Decisión de Edgar (2026-10-20), sobre tres opciones planteadas: **guardar la foto como primer
 * conteo, sin tocar lo sellado.** Los dos quedan a la vista y nadie reescribe una cifra firmada.
 *
 * ⭐ Va a `conteo_previo`, que es **exactamente** el primitivo para esto: lo creó `[CGP-L.3]`
 * para que *«el primero no se borre y los dos queden a la vista»*. Acá el primero es el del
 * 12-oct (la foto) y el segundo es la transcripción del 15-oct.
 *
 * ⚠️ **Efecto colateral declarado:** `revelacion()` publica `ya_reconto: c.conteo_previo != null`,
 * así que la pantalla va a decir que este corte ya tuvo un reconteo y no va a ofrecer otro. En un
 * corte cerrado hace ocho días eso no quita nada — y es más cierto que lo contrario.
 *
 * ⛔ **No se inventa morralla ni se completa el desglose.** Lo que la foto no muestra, no entra.
 *
 * ── Guardas ─────────────────────────────────────────────────────────────────────────────────
 *
 * El `up` **aborta entero** si: el corte no existe; ya tiene un `conteo_previo` (idempotente);
 * su `contado` dejó de ser $3,653.50 o su `esperado` dejó de ser $3,402.45 — porque entonces no
 * es el corte que medí; o si el desglose de la foto no suma $3,340.00 al centavo.
 *
 * ⚠️ **Sólo hace UPDATE: la compuerta del despliegue la clasifica NO_MEDIDO y FRENA al equipo.
 *    Va aplicada ANTES de mergear**, con `apply-one-migration-prod.js` (y `--field-selector=
 *    status.phase=Running` para elegir el pod, que el runbook todavía no dice).
 *
 * @param { import("knex").Knex } knex
 */

const TENANT = '00000000-0000-0000-0000-00000000d01c';
const FOLIO = 'CC-2026-00001';

/**
 * El desglose tal como se lee en la foto.
 *
 * ⚠️ Las llaves salen del catálogo compartido (`libs/contracts/.../denominations.ts`), NO del
 * valor: `10`, `5`, `2` y `1` **son monedas** —no existe billete de esos valores en México— y
 * sólo el `$20` lleva sufijo (`20m`), por ser el único que existe de las dos formas.
 */
const FOTO = [
  { denom_key: '500', denominacion: 500, piezas: 1 },
  { denom_key: '100', denominacion: 100, piezas: 5 },
  { denom_key: '10', denominacion: 10, piezas: 160 },
  { denom_key: '5', denominacion: 5, piezas: 114 },
  { denom_key: '2', denominacion: 2, piezas: 57 },
  { denom_key: '1', denominacion: 1, piezas: 56 },
];
const CONTADO_FOTO = 3340.00;
const MORRALLA_FOTO = 0;

/** Lo que el corte tiene hoy. Si cambió, no es el corte que medí y la migración se niega. */
const ESPERADO_HOY = 3402.45;
const CONTADO_HOY = 3653.50;

const MOTIVO = [
  'CGA-A.37 (2026-10-20): el conteo guardado acá NO es un reconteo: es el conteo ORIGINAL del',
  '12-oct, recuperado de una fotografia de la pantalla "Cerrar corte" tomada ese dia.',
  'El guardado fallo con error (denom_key NOT NULL, el defecto de [CG.155], migracion',
  '20261006123000 del 06-oct) y el corte recien pudo cerrarse el 15-oct 18:02, tres dias despues',
  'y 2 minutos despues de que se aplicara el arreglo 20261014212702. Lo sellado ($3,653.50) se',
  'tecleo esos tres dias mas tarde; esto ($3,340.00) se conto con el cajon delante.',
  'Diferencia entre los dos: $313.50. NO se toco contado, esperado ni diferencia: el corte esta',
  'firmado y la foto muestra un conteo interrumpido por el error, no necesariamente el final.',
].join(' ');

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);

  const abortar = (m) => {
    throw new Error(`[CGA-A.37] ${m} -- migracion abortada, no se toco ninguna fila.`);
  };

  // Guarda 0: el desglose de la foto suma lo que dice la foto.
  const suma = FOTO.reduce((a, d) => a + d.denominacion * d.piezas, 0) + MORRALLA_FOTO;
  if (Math.abs(suma - CONTADO_FOTO) > 0.001) {
    abortar(`el desglose de la foto suma ${suma.toFixed(2)} y deberia sumar ${CONTADO_FOTO}`);
  }

  // Guarda 1: el corte existe y sigue siendo el que medi.
  const { rows } = await knex.raw(
    `SELECT id, fecha::text AS fecha, estado, contado, esperado, conteo_previo, closed_at
       FROM finance.cash_ledger_cuts WHERE tenant_id = ? AND folio = ?`, [TENANT, FOLIO]);
  if (rows.length !== 1) abortar(`${FOLIO}: esperaba 1 fila y hay ${rows.length}`);
  const c = rows[0];
  if (c.conteo_previo != null) return;                 // ya aplicada: idempotente, sin ruido
  if (c.fecha !== '2026-10-12') abortar(`${FOLIO}: su fecha es ${c.fecha}, no 2026-10-12`);
  if (c.estado !== 'cerrado') abortar(`${FOLIO}: esta en estado ${c.estado}`);
  if (Math.abs(Number(c.contado) - CONTADO_HOY) > 0.001) {
    abortar(`${FOLIO}: su contado es ${c.contado} y se midio ${CONTADO_HOY}`);
  }
  if (Math.abs(Number(c.esperado) - ESPERADO_HOY) > 0.001) {
    abortar(`${FOLIO}: su esperado es ${c.esperado} y se midio ${ESPERADO_HOY}`);
  }

  // La escritura. `cut_reconteo_chk` exige que los DOS campos vayan juntos y el motivo >= 5.
  const previo = {
    denominaciones: FOTO,
    morralla: MORRALLA_FOTO,
    contado: CONTADO_FOTO,
    sellado_at: null,                 // nunca se sello: el guardado fallo
    recontado_por: 'carmen_rodriguez',
    origen: 'foto de la pantalla Cerrar corte, 2026-10-12',
  };
  await knex.raw(
    `UPDATE finance.cash_ledger_cuts
        SET conteo_previo = ?::jsonb, reconteo_motivo = ?, updated_at = now()
      WHERE tenant_id = ? AND folio = ? AND conteo_previo IS NULL`,
    [JSON.stringify(previo), MOTIVO, TENANT, FOLIO]);

  // ⚠️ La nota se AÑADE: el corte ya trae la de `[CG.100]` (el fondo corregido con el arqueo
  // A23641) y pisarla borraria el rastro de por que el fondo es 3,327.50 y no 617,505.50.
  await knex.raw(
    `UPDATE finance.cash_ledger_cuts
        SET nota = COALESCE(NULLIF(btrim(nota), '') || ' | ', '') || ?, updated_at = now()
      WHERE tenant_id = ? AND folio = ? AND position('CGA-A.37' in COALESCE(nota, '')) = 0`,
    ['CGA-A.37: existe un conteo contemporaneo del 12-oct por $3,340.00 en conteo_previo; lo sellado se tecleo el 15-oct.', TENANT, FOLIO]);

  // Comprobacion: quedo escrito y lo sellado sigue intacto.
  const { rows: fin } = await knex.raw(
    `SELECT contado, esperado, diferencia, (conteo_previo IS NOT NULL) AS tiene_previo
       FROM finance.cash_ledger_cuts WHERE tenant_id = ? AND folio = ?`, [TENANT, FOLIO]);
  if (!fin[0].tiene_previo) abortar('el conteo_previo no quedo escrito');
  if (Math.abs(Number(fin[0].contado) - CONTADO_HOY) > 0.001
      || Math.abs(Number(fin[0].esperado) - ESPERADO_HOY) > 0.001) {
    abortar('se movio una cifra sellada: eso era justo lo que no debia pasar');
  }
};

/** Deshace EXACTAMENTE lo que hizo el `up`, ni una fila mas. */
exports.down = async function down(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  // Los dos a la vez: `cut_reconteo_chk` no admite uno sin el otro.
  await knex.raw(
    `UPDATE finance.cash_ledger_cuts
        SET conteo_previo = NULL, reconteo_motivo = NULL, updated_at = now()
      WHERE tenant_id = ? AND folio = ? AND position('CGA-A.37' in COALESCE(reconteo_motivo, '')) > 0`,
    [TENANT, FOLIO]);
  await knex.raw(
    `UPDATE finance.cash_ledger_cuts
        SET nota = NULLIF(regexp_replace(nota, '( \\| )?CGA-A\\.37:.*$', ''), ''), updated_at = now()
      WHERE tenant_id = ? AND folio = ? AND position('CGA-A.37' in COALESCE(nota, '')) > 0`,
    [TENANT, FOLIO]);
};
