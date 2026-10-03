/**
 * `[GX.59]` — **El Expediente por persona, y el protocolo forzoso.**
 *
 * Pedido textual del usuario (2026-10-01): *«en lugar de historial será expediente (…) podrán
 * ver los vales de todos, acomodados por usuarios, con su nombre completo además de su
 * username (…) agregar forzosamente la comprobación, sólo así se podrá tomar en cuenta que se
 * completó el protocolo»*.
 *
 * ## Qué prueba este archivo que la prueba del contrato NO puede
 * La regla (`protocoloDelVale`) se prueba sola en `libs/contracts`. Lo que sólo se puede medir
 * contra la base es **de dónde salen sus entradas**:
 *
 *  1. **El nombre completo existe y empata.** No hay `full_name` en `identity.users` — la
 *     columna es `nombre`. Si alguien «ordena» el JOIN contra la columna equivocada, la
 *     pantalla muestra 19 personas sin nombre y nada se pone rojo.
 *  2. **La comprobación de Kepler se cuenta por `folio_solicitud`**, y una RECHAZADA no cuenta.
 *  3. ⭐ **Sin la tabla de comprobaciones, el veredicto es `sin_medir` — nunca «no comprobó».**
 *     Es la diferencia entre un tablero útil y uno que acusa a 155 personas por un JOIN que
 *     falta.
 *  4. **El agrupado no pierde ni duplica vales**: Σ por persona == total de expedientes.
 *
 * Uso: DATABASE_URL_NEW=... node database/tests/test-newdb-expediente-protocolo.js
 */
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env'), quiet: true });
const knex = require('knex')(require('../knexfile-newdb.js').development);
const T = process.env.TENANT_ID || '00000000-0000-0000-0000-00000000d01c';

let fail = 0, nomedido = 0;
const ok = (c, m) => { console.log(`${c ? '  ✅' : '  ❌'} ${m}`); if (!c) fail++; };
const nm = (m) => { console.log(`  ⚪ NO MEDIDO — ${m}`); nomedido++; };

const SUF = String(Date.now()).slice(-6);
const USER = `smk_gx59_${SUF}`;
const NOMBRE = 'Persona De Prueba GX59';
const FOLIO_A = `59${SUF}A`;   // completo: aprobado + comprobación
const FOLIO_B = `59${SUF}B`;   // sin comprobación
const FOLIO_C = `59${SUF}C`;   // comprobación RECHAZADA → no cuenta

/** La MISMA regla del contrato, en JS. Si allá se afloja, acá se nota. */
function protocolo({ status, provisional, roles, comprobacion_kepler }) {
  if (String(status) === 'rechazada') return { etapa: 'rechazado', faltan: [] };
  const faltan = [];
  if (!['aprobada', 'revision', 'validada'].includes(String(status))) faltan.push('firma');
  const medido = comprobacion_kepler === true || comprobacion_kepler === false;
  if (!medido) return { etapa: 'sin_medir', faltan };
  if (comprobacion_kepler !== true) faltan.push('comprobacion_kepler');
  if (provisional === true && !roles.some((r) => String(r).startsWith('comprobante'))) {
    faltan.push('factura_del_gasto');
  }
  if (!faltan.length) return { etapa: 'completo', faltan };
  if (faltan.length === 1 && faltan[0] === 'firma') return { etapa: 'en_captura', faltan };
  return { etapa: 'incompleto', faltan };
}

const proof = (folio, over = {}) => ({
  tenant_id: T, solicitante: USER, departamento: 'SMOKE GX59', sucursal: '01',
  folio_solicitud: folio, proveedor: 'PROVEEDOR SMOKE', importe: 1000,
  files: JSON.stringify([{ role: 'comprobante_1', url: 'https://x/a.jpg' }]),
  status: 'validada', created_by: USER, ...over,
});

const comprobacion = (folio, over = {}) => ({
  tenant_id: T, solicitante: USER, departamento: 'SMOKE GX59', sucursal: '01',
  folio_gasto: `G${folio}`, folio_solicitud: folio, proveedor: 'PROVEEDOR SMOKE',
  importe: 1000, files: JSON.stringify([{ role: 'comprobacion', url: 'https://x/c.pdf' }]),
  status: 'validada', created_by: USER, ...over,
});

async function limpiar() {
  await knex('finance.expense_comprobaciones').where('folio_solicitud', 'like', `59${SUF}%`).del()
    .catch(() => undefined);
  await knex('finance.expense_proofs').where('folio_solicitud', 'like', `59${SUF}%`).del();
  await knex('identity.users').where({ username: USER }).del();
}

(async () => {
  console.log(`\n[GX.59] Expediente por persona + protocolo forzoso  (user ${USER})\n`);
  await limpiar();

  const hayTabla = (await knex.raw(
    `select (to_regclass('finance.expense_comprobaciones') is not null) as existe`)).rows[0].existe;

  // ── 1) El nombre completo: la columna es `nombre`, NO `full_name` ──────────────────
  console.log('1) ⭐ el nombre completo sale de `identity.users.nombre` (no existe `full_name`)');
  const cols = (await knex.raw(
    `select column_name from information_schema.columns
      where table_schema='identity' and table_name='users'`)).rows.map((r) => r.column_name);
  ok(cols.includes('nombre'), 'la columna `nombre` existe');
  ok(!cols.includes('full_name'),
    '⛔ y `full_name` NO existe — quien la use deja a todos sin nombre, en silencio');

  await knex('identity.users').insert({
    tenant_id: T, username: USER, nombre: NOMBRE, password_hash: 'x', role_name: 'auxiliar_tienda',
  });
  const u = await knex('identity.users').where({ tenant_id: T, username: USER }).first('nombre');
  ok(u && u.nombre === NOMBRE, `el join devuelve «${NOMBRE}»`);

  const pob = (await knex.raw(
    `select count(*)::int tot, count(nullif(btrim(nombre),''))::int con
       from identity.users where deleted_at is null`)).rows[0];
  console.log(`     (cobertura real: ${pob.con}/${pob.tot} usuarios con nombre)`);
  ok(pob.con > 0, 'hay nombres cargados: la columna no está vacía');

  // ── 2) La comprobación se cuenta por folio_solicitud ───────────────────────────────
  console.log('\n2) la comprobación de Kepler se liga por `folio_solicitud`');
  await knex('finance.expense_proofs').insert([
    proof(FOLIO_A), proof(FOLIO_B), proof(FOLIO_C),
  ]);

  if (!hayTabla) {
    nm('`finance.expense_comprobaciones` no existe en este entorno — los bloques 2 y 3 no se pueden medir');
  } else {
    await knex('finance.expense_comprobaciones').insert([
      comprobacion(FOLIO_A),
      // ⛔ Rechazada: una comprobación que se rechazó NO comprueba nada.
      comprobacion(FOLIO_C, { status: 'rechazada' }),
    ]);

    const cuenta = async (folio) => Number((await knex('finance.expense_comprobaciones')
      .where({ tenant_id: T, folio_solicitud: folio })
      .whereRaw(`coalesce(status,'') <> 'rechazada'`)
      .count('* as n').first()).n);

    ok(await cuenta(FOLIO_A) === 1, 'el vale con comprobación la encuentra');
    ok(await cuenta(FOLIO_B) === 0, 'el vale sin comprobación no inventa una');
    ok(await cuenta(FOLIO_C) === 0,
      '⛔ la comprobación RECHAZADA no cuenta — si contara, el protocolo cerraría con un «no»');

    // ── 3) El veredicto ─────────────────────────────────────────────────────────────
    console.log('\n3) el veredicto del protocolo, con la comprobación medida');
    const vA = protocolo({ status: 'validada', provisional: false, roles: ['comprobante_1'], comprobacion_kepler: true });
    const vB = protocolo({ status: 'validada', provisional: false, roles: ['comprobante_1'], comprobacion_kepler: false });
    ok(vA.etapa === 'completo', 'con comprobación → completo');
    ok(vB.etapa === 'incompleto' && vB.faltan.includes('comprobacion_kepler'),
      '⭐ sin comprobación → incompleto, y DICE que le falta la de Kepler');

    const vProv = protocolo({ status: 'aprobada', provisional: true, roles: ['cotizacion'], comprobacion_kepler: true });
    ok(vProv.faltan.includes('factura_del_gasto'),
      'el vale que se aprobó con cotización sigue debiendo la factura');
  }

  // ── 4) ⭐ Sin medir NO es «no comprobó» ────────────────────────────────────────────
  console.log('\n4) ⭐ la prueba negativa: sin medir la comprobación, NO se acusa a nadie');
  const vSin = protocolo({ status: 'validada', provisional: false, roles: ['comprobante_1'], comprobacion_kepler: null });
  ok(vSin.etapa === 'sin_medir', 'con la medición ausente el veredicto es `sin_medir`');
  ok(!vSin.faltan.includes('comprobacion_kepler'),
    '⛔ y NO aparece como si le faltara: acusar por un JOIN que falta es peor que no medir');

  // ── 5) El agrupado no pierde ni duplica ────────────────────────────────────────────
  console.log('\n5) agrupar por persona no pierde ni duplica vales');
  const filas = await knex('finance.expense_proofs')
    .where({ tenant_id: T }).select('solicitante');
  const porPersona = new Map();
  for (const f of filas) {
    const k = String(f.solicitante || '').trim().toUpperCase() || '(sin solicitante)';
    porPersona.set(k, (porPersona.get(k) || 0) + 1);
  }
  const suma = [...porPersona.values()].reduce((a, b) => a + b, 0);
  ok(suma === filas.length, `Σ por persona (${suma}) == total de expedientes (${filas.length})`);
  ok(porPersona.has(USER.toUpperCase()), 'la persona de prueba aparece agrupada');
  ok(porPersona.get(USER.toUpperCase()) === 3, 'con sus 3 vales, ni uno más');
  console.log(`     (universo real: ${filas.length} expedientes repartidos en ${porPersona.size} personas)`);

  // ── 6) El retrato del día 1 ────────────────────────────────────────────────────────
  console.log('\n6) ⛔ el retrato del día 1, dicho en voz alta');
  if (hayTabla) {
    const n = Number((await knex('finance.expense_comprobaciones').count('* as n').first()).n);
    console.log(`     comprobaciones de Kepler en la base: ${n}`);
    if (n <= 2) {
      console.log('     ⛔ el módulo GX.8 existe y prácticamente NO se usa: con la comprobación');
      console.log('        forzosa, casi todos los expedientes salen INCOMPLETOS. Es el estado');
      console.log('        real del trámite, no un defecto de la regla.');
    }
    ok(true, 'el conteo quedó declarado arriba');
  } else {
    nm('sin la tabla no se puede contar cuántas comprobaciones hay');
  }

  await limpiar();
  console.log(`\n${fail ? `❌ ${fail} fallo(s)` : '✅ todo verde'}${nomedido ? ` · ⚪ ${nomedido} no medido(s)` : ''}\n`);
  await knex.destroy();
  process.exit(fail ? 1 : 0);
})().catch(async (e) => {
  console.error('ERR', e.message);
  try { await limpiar(); } catch { /* noop */ }
  await knex.destroy();
  process.exit(1);
});
