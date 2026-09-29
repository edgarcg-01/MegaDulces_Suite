/**
 * `[GX.41]` — **Datos de prueba para ver «Mis gastos» funcionando en local.**
 *
 * Siembra en la réplica local de Kepler (`kepler_ods.kdm1`) las solicitudes que hacen falta
 * para que la pantalla muestre **cada uno de sus estados**, y los expedientes nuestros que
 * los acompañan. Es idempotente: borra lo suyo y lo vuelve a poner.
 *
 * ⛔ **Sólo local.** Se niega a correr si la URL no apunta a `127.0.0.1`/`localhost`: escribir
 * en `kepler_ods` de producción sería meter documentos que Kepler no emitió, y el ODS es una
 * réplica — nadie los borraría después.
 *
 * ## Qué se va a ver, y dónde
 * Entrando como **`demo_captura`** en `/finanzas/mis-gastos`:
 *
 *   «Te tocan a vos»  (vales de Kepler asignados por la caja «Solicita», sin expediente)
 *     0097001  pendiente, sucursal 00      → el caso típico
 *     0097002  ya aplicado en Kepler       → chip «Ya ejercido en Kepler»
 *     0097003  sucursal 02                 → el botón lleva `sucursal=02` en la URL
 *
 *   La lista de abajo (expedientes nuestros, con su etapa de ejercicio)
 *     0097010  recibida                    → «En trámite»
 *     0097011  validada, sin gasto Kepler  → «Por ejercer»
 *     0097012  validada, con gasto Kepler  → «Ejercido» + la frase del dinero
 *     0097013  validada, folio que NO está en Kepler → «Sin medir»
 *     0097014  rechazada (hace 1 h)        → «Devuelto» con su motivo
 *
 *   ⛔ Lo que NO tiene que aparecer en «Te tocan a vos»
 *     0097020  cancelado en Kepler
 *     0097021  asignado a `demo_ana`       → sólo lo ve ella
 *     0097010  ya capturado                → está abajo, no arriba
 *
 * Uso: node database/scripts/dev-seed-vales-asignados.js
 *      node database/scripts/dev-seed-vales-asignados.js --limpiar   (sólo borra)
 */
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env'), quiet: true });
const knex = require('knex')(require('../knexfile-newdb.js').development);

const T = process.env.TENANT_ID || '00000000-0000-0000-0000-00000000d01c';
const USUARIO = 'demo_captura';      // cajero: LEVANTA gastos (no ve el detalle, es correcto)
const OTRO = 'demo_ana';             // cajero: para comprobar que no ve lo ajeno
const APROBADOR = 'demo_gx20';       // tesoreria: SÍ ve el detalle y aprueba
const CLAVE = 'demo1234';
/** Todo lo sembrado vive en este rango de folios. Es la marca, y lo que se limpia. */
const PREFIJO = '00970';

const SOLO_LIMPIAR = process.argv.includes('--limpiar');

/** Fecha ISO de hace `d` días, que es lo que `kdm1.c9` guarda. */
const hace = (d) => {
  const x = new Date();
  x.setDate(x.getDate() - d);
  return x.toISOString().slice(0, 10);
};

/** Una solicitud X-A-15 tal como la emite Kepler (anti-réplica: `c1` = sucursal). */
const solicitud = (folio, solicita, over = {}) => ({
  sucursal: '00', c1: '00', c2: 'X', c3: 'A', c4: '15', c5: '1', c6: folio,
  c9: hace(3), c16: '1250.00', c14: '172.41', c10: 'GG015',
  c24: 'COMBUSTIBLE Y CASETAS', c30: 'FINANZAS',
  c32: 'ESTACION DE SERVICIO TAVISA',
  c43: 'N', c48: solicita, c67: '3001', c68: hace(3), c69: '09:30', c90: '01',
  ...over,
});

/** El gasto X-A-10 que Kepler genera al aplicar la solicitud (apunta por `c39`). */
const gasto = (folio, solicitudFolio, over = {}) => ({
  sucursal: '00', c1: '00', c2: 'X', c3: 'A', c4: '10', c5: '1', c6: folio,
  c9: hace(1), c16: '1250.00', c10: 'GG015', c24: 'COMBUSTIBLE Y CASETAS',
  c30: 'FINANZAS', c32: 'ESTACION DE SERVICIO TAVISA', c31: 'Gas',
  c37: '15', c38: '1', c39: solicitudFolio,
  c43: 'N', c48: USUARIO, c67: '3001', c68: hace(1), c69: '11:05',
  ...over,
});

/** Un expediente NUESTRO. `status` decide qué etapa se ve. */
const expediente = (folio, status, over = {}) => ({
  tenant_id: T,
  solicitante: 'DEMO CAPTURA',
  departamento: 'FINANZAS',
  sucursal: '00',
  fecha_gasto: hace(3),
  folio_solicitud: folio,
  proveedor: 'ESTACION DE SERVICIO TAVISA',
  importe: 1250,
  files: JSON.stringify([]),
  status,
  clasificacion: 'no_comprobable',
  forma_pago: 'efectivo',
  created_by: USUARIO,
  ...over,
});

async function limpiar() {
  const k1 = await knex('kepler_ods.kdm1').where('c6', 'like', `${PREFIJO}%`).del();
  const k2 = await knex('kepler_ods.kdm1').where('c39', 'like', `${PREFIJO}%`).del();
  const p = await knex('finance.expense_proofs')
    .where('tenant_id', T).where('folio_solicitud', 'like', `${PREFIJO}%`).del();
  console.log(`  limpiado: ${k1 + k2} documento(s) de Kepler · ${p} expediente(s) nuestro(s)`);
}

(async () => {
  const url = String(process.env.DATABASE_URL_NEW || '');
  if (!/127\.0\.0\.1|localhost/.test(url)) {
    console.error('\n⛔ Esto escribe en `kepler_ods`, que es una RÉPLICA: sólo corre contra local.');
    console.error(`   DATABASE_URL_NEW apunta a: ${url.replace(/:[^:@]*@/, ':***@') || '(vacío)'}\n`);
    await knex.destroy();
    process.exit(1);
  }

  console.log(`\n[GX.41] datos de prueba · usuario «${USUARIO}» · folios ${PREFIJO}xx\n`);
  await limpiar();
  if (SOLO_LIMPIAR) { console.log('\n✅ sólo limpieza, nada sembrado\n'); await knex.destroy(); return; }

  // ── «Te tocan a vos»: vales de Kepler asignados y SIN expediente nuestro ─────────────
  await knex('kepler_ods.kdm1').insert([
    solicitud(`${PREFIJO}01`, USUARIO),
    solicitud(`${PREFIJO}02`, USUARIO, { c16: '3480.50', c24: 'REFACCIONES CAMIONETA', c32: 'AUTOPARTES DEL BAJIO' }),
    // Otra plaza: el botón «Subir evidencia» tiene que llevar `sucursal=02` en la URL.
    solicitud(`${PREFIJO}03`, USUARIO, { sucursal: '02', c1: '02', c16: '640.00', c24: 'PAPELERIA OFICINA', c32: 'OFFICE DEPOT' }),
  ]);
  // El 02 ya lo aplicó Kepler: su gasto existe y apunta a él.
  await knex('kepler_ods.kdm1').insert(gasto(`${PREFIJO}92`, `${PREFIJO}02`, { c16: '3480.50' }));

  // ── La lista de abajo: expedientes nuestros, uno por etapa ──────────────────────────
  await knex('kepler_ods.kdm1').insert([
    solicitud(`${PREFIJO}10`, USUARIO, { c24: 'VIATICOS RUTA NORTE', c32: 'GASTOS GENERALES CAJA CHICA' }),
    solicitud(`${PREFIJO}11`, USUARIO, { c24: 'MANTENIMIENTO AIRE', c32: 'SERVICIOS INTEGRALES MD', c43: 'A' }),
    solicitud(`${PREFIJO}12`, USUARIO, { c24: 'FLETE FORANEO', c32: 'TRANSPORTES LA PIEDAD', c43: 'F' }),
    solicitud(`${PREFIJO}14`, USUARIO, { c24: 'COMIDA PERSONAL', c32: 'RESTAURANTE EL PORTON' }),
  ]);
  // El 12 ya se ejerció: Kepler generó su gasto.
  await knex('kepler_ods.kdm1').insert(gasto(`${PREFIJO}93`, `${PREFIJO}12`));

  const ahora = new Date();
  const haceUnaHora = new Date(ahora.getTime() - 60 * 60 * 1000);
  await knex('finance.expense_proofs').insert([
    expediente(`${PREFIJO}10`, 'recibida'),
    expediente(`${PREFIJO}11`, 'validada', { validated_by: 'demo_gx20', validated_at: ahora }),
    expediente(`${PREFIJO}12`, 'validada', { validated_by: 'demo_gx20', validated_at: ahora }),
    /**
     * ⭐ Folio que NO existe en Kepler: es el caso `sin_medir`. Pasa de verdad cuando el feed
     * del ODS no trajo la solicitud todavía — como está pasando ahora mismo en producción.
     */
    expediente(`${PREFIJO}13`, 'validada', {
      validated_by: 'demo_gx20', validated_at: ahora,
      proveedor: 'PROVEEDOR QUE EL FEED NO TRAJO', importe: 777.77,
    }),
    /** El rechazo se oculta a las 24 h: se fecha hace 1 hora para que se vea. */
    expediente(`${PREFIJO}14`, 'rechazada', {
      validated_by: 'demo_gx20', validated_at: haceUnaHora,
      motivo_rechazo: 'La foto del vale está movida, no se lee el importe. Volvé a tomarla.',
    }),
  ]);

  // ── Lo que NO tiene que aparecer en «Te tocan a vos» ────────────────────────────────
  await knex('kepler_ods.kdm1').insert([
    // Cancelado en Kepler: no hay nada que perseguir.
    solicitud(`${PREFIJO}20`, USUARIO, { c43: 'C', c24: 'CANCELADO EN KEPLER', c32: 'NO DEBE APARECER' }),
    // De otra persona: sólo lo ve ella.
    solicitud(`${PREFIJO}21`, OTRO, { c24: 'VALE DE OTRA PERSONA', c32: 'SOLO LO VE DEMO_ANA' }),
  ]);

  // ── Las contraseñas de los demos, para que se pueda entrar con los tres roles ───────
  /**
   * ⚠️ Esto **pisa la contraseña** de tres usuarios de demostración. Sólo corre en local (ya
   * se verificó arriba) y sólo sobre esos tres: sin esto la prueba se queda a medias, porque
   * `demo_captura` es `cajero` y **no tiene `FINANCE_EXPENSES_VER`** — el detalle del vale y
   * la pantalla de Aprobación le responden 403, que es lo correcto. Para ver el expediente
   * completo hay que entrar con alguien de finanzas.
   */
  const bcrypt = require('bcryptjs');
  const hash = await bcrypt.hash(CLAVE, 10);
  const tocados = await knex('users')
    .whereIn('username', [USUARIO, OTRO, APROBADOR])
    .update({ password_hash: hash, must_change_password: false });
  console.log(`  contraseña «${CLAVE}» puesta en ${tocados} usuario(s) de demo`);

  // ── Resumen ────────────────────────────────────────────────────────────────────────
  const asignados = await knex('analytics.expense_requests as r')
    .where('r.tenant_id', T)
    .whereRaw(`upper(btrim(r.solicitante)) = ?`, [USUARIO.toUpperCase()])
    .whereRaw(`coalesce(btrim(r.estado),'') <> 'C'`)
    .whereNotExists(function () {
      this.select(knex.raw('1')).from('finance.expense_proofs as p')
        .whereRaw('p.tenant_id = r.tenant_id')
        .whereRaw('p.folio_solicitud = r.folio')
        .whereRaw('p.sucursal = r.sucursal');
    })
    .count({ n: '*' });
  const mios = await knex('finance.expense_proofs')
    .where({ tenant_id: T }).where('folio_solicitud', 'like', `${PREFIJO}%`).count({ n: '*' });

  console.log(`\n  «Te tocan a vos» para ${USUARIO}: ${asignados[0].n} vale(s)`);
  console.log(`  expedientes suyos en la lista:    ${mios[0].n}`);
  console.log(`
  Entrá como «${USUARIO}» a /finanzas/mis-gastos y verificá:
    · arriba, «Te tocan a vos» con 3 vales — uno con chip «Ya ejercido en Kepler»
      y uno de la sucursal 02 (su botón lleva sucursal=02 en la URL)
    · abajo, las pestañas En trámite / Por ejercer / Ejercido / Sin medir
    · el ${PREFIJO}12 dice que el dinero salió; el ${PREFIJO}13 dice «Sin medir»
    · el ${PREFIJO}20 (cancelado) y el ${PREFIJO}21 (de ${OTRO}) NO están arriba
    · «Subir evidencia» abre la captura con el folio ya puesto

  Entrás con:
    ${USUARIO} / ${CLAVE}   (cajero — levanta; NO ve el detalle: 403 a propósito)
    ${OTRO} / ${CLAVE}       (cajero — sólo tiene que ver el 0097021)
    ${APROBADOR} / ${CLAVE}       (tesorería — ve el expediente completo y aprueba)

  Para borrarlo todo:  node database/scripts/dev-seed-vales-asignados.js --limpiar
`);
  await knex.destroy();
})().catch(async (e) => { console.error('ERR', e.message); await knex.destroy(); process.exit(1); });
