'use strict';
/**
 * Fase RH · `[RH.14.2]` — rescatar de Mega Talento el NOMBRE COMPLETO de quien en la Suite quedó con el apodo del reloj.
 *
 * Medido el 2026-11-18 en prod: de 513 personas activas en alguna plaza, 212 tienen como nombre el apodo del reloj y
 * menos de 3 palabras. La carga de personas (`carga-personas-mega-talento.js`, 11-nov) usó `nombre_completo || nombre`:
 * si hoy Mega Talento tiene el nombre completo de alguien que en la Suite sigue con apodo, RH lo capturó allá DESPUÉS
 * de la carga. Mega Talento se apaga el 24-nov (`[RH.4]`): después de esa fecha este dato ya no existe.
 *
 * No es un importer: corre una vez, antes del apagado. Por omisión MIDE y no escribe nada. Con `--aplicar` cambia el
 * nombre SÓLO cuando se cumplen las cuatro reglas de `proponer()`, en una transacción, con su asiento en
 * `identity.user_events` (evento `nombre_desde_mega_talento`, con el nombre anterior para poder deshacerlo).
 *
 *   # en md, dentro del pod (la cadena de Mega Talento nunca sale del servidor):
 *   kubectl cp ~/secrets/mt.url prod/$API:/tmp/mt.url -c api
 *   kubectl cp database/scripts/rh/nombres-completos-mega-talento.js prod/$API:/app/database/scripts/rh/ -c api
 *   kubectl exec -n prod $API -c api -- sh -c \
 *     'CARGA_URL="$DATABASE_URL_NEW" MT_DATABASE_URL="$(cat /tmp/mt.url)" \
 *      node /app/database/scripts/rh/nombres-completos-mega-talento.js --destino-prod; rm -f /tmp/mt.url'
 *   # con el cuadre revisado, lo mismo con --aplicar
 *
 *   node database/scripts/rh/nombres-completos-mega-talento.js --self   # los controles de proponer(), sin base
 *
 * El informe con nombres va a /tmp (el repo es público): nunca dentro del repo.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
// La copia en JavaScript de `nombrePropio` (la de la migración que corrigió los nombres; misma regla, probada en paridad).
const { nombrePropio } = require('../../migrations-newdb/20261118181036_rh_nombres_forma_propia.js');

const PROD_CLUSTER_ID = '7688376744939610156';
const TENANT_MD = '00000000-0000-0000-0000-00000000d01c';
const PALABRAS_MINIMAS = 3;
const ROL_SIN_ACCESO = 'sin_acceso';

const palabras = (s) => String(s || '').trim().split(/\s+/).filter(Boolean).length;
const normal = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim().toUpperCase();

/**
 * Lo que se propone cambiar. Una persona de la Suite recibe el nombre completo de Mega Talento sólo si:
 *  1. su nombre de hoy es CORTO (menos de 3 palabras) o es igual al apodo del reloj — nunca se pisa un nombre completo;
 *  2. no tiene acceso a la Suite (rol `sin_acceso`): a quien tiene acceso lo corrige Sistemas;
 *  3. Mega Talento trae un `nombre_completo` de 3 palabras o más, distinto del que ya tiene;
 *  4. todas sus fichas de Mega Talento con nombre completo dicen el MISMO nombre (si dos plazas dicen distinto, no se adivina).
 *
 * @param personas  [{ user_id, nombre, role_name, fichas: [{ sitio, codigo, apodo }] }]   (la Suite)
 * @param mt        Map `${sitio}|${codigo}` → { nombre_completo }                            (Mega Talento)
 */
function proponer(personas, mt) {
  const cuadre = { personas: 0, nombre_ya_completo: 0, con_acceso: 0, sin_ficha_en_mt: 0, mt_sin_nombre_completo: 0, mt_igual: 0, mt_en_conflicto: 0, propuestas: 0 };
  const propuestas = [];
  const conflictos = [];
  for (const p of personas) {
    cuadre.personas++;
    const corto = palabras(p.nombre) < PALABRAS_MINIMAS || p.fichas.some((f) => normal(f.apodo) === normal(p.nombre));
    if (!corto) { cuadre.nombre_ya_completo++; continue; }
    if (p.role_name !== ROL_SIN_ACCESO) { cuadre.con_acceso++; continue; }
    const deMt = p.fichas.map((f) => mt.get(`${f.sitio}|${f.codigo}`)).filter(Boolean);
    if (!deMt.length) { cuadre.sin_ficha_en_mt++; continue; }
    const completos = [...new Set(deMt.map((x) => String(x.nombre_completo || '').replace(/\s+/g, ' ').trim()).filter((n) => palabras(n) >= PALABRAS_MINIMAS))];
    if (!completos.length) { cuadre.mt_sin_nombre_completo++; continue; }
    if (new Set(completos.map(normal)).size > 1) { cuadre.mt_en_conflicto++; conflictos.push({ user_id: p.user_id, nombre: p.nombre, opciones: completos }); continue; }
    if (normal(completos[0]) === normal(p.nombre)) { cuadre.mt_igual++; continue; }
    cuadre.propuestas++;
    // `[RH.14.9]` Entra ya en su forma propia (Mega Talento lo guarda casi siempre en MAYÚSCULAS).
    propuestas.push({ user_id: p.user_id, antes: p.nombre, despues: nombrePropio(completos[0]), fichas: p.fichas.map((f) => `${f.sitio}|${f.codigo}`) });
  }
  return { cuadre, propuestas, conflictos };
}

/** Controles: cada regla con un caso que la cumple y uno que la rompe. Si uno falla, el guion no sirve. */
function self() {
  const mt = new Map([
    ['z|1', { nombre_completo: 'María Dolores Berber Tovar' }],
    ['z|2', { nombre_completo: 'Juan' }],
    ['z|3', { nombre_completo: 'Ana López Ruiz' }], ['p|3', { nombre_completo: 'Ana Lopez Ruiz' }],
    ['z|4', { nombre_completo: 'Ana López Ruiz' }], ['p|4', { nombre_completo: 'Ana María Torres Gil' }],
    ['z|5', { nombre_completo: 'Pedro Ramos Díaz' }],
    ['z|6', { nombre_completo: 'Luis Pérez Soto' }],
  ]);
  const f = (codigo, apodo, sitio = 'z') => ({ sitio, codigo, apodo });
  const casos = [
    ['apodo corto + MT completo → propone', { user_id: 'a', nombre: 'Dolores', role_name: 'sin_acceso', fichas: [f('1', 'Dolores')] }, 'propuestas'],
    ['MT de una palabra → no propone', { user_id: 'b', nombre: 'Juan', role_name: 'sin_acceso', fichas: [f('2', 'Juan')] }, 'mt_sin_nombre_completo'],
    ['dos plazas, mismo nombre con y sin acento → propone', { user_id: 'c', nombre: 'Ana', role_name: 'sin_acceso', fichas: [f('3', 'Ana'), f('3', 'Ana', 'p')] }, 'propuestas'],
    ['dos plazas, nombres distintos → conflicto', { user_id: 'd', nombre: 'Ana', role_name: 'sin_acceso', fichas: [f('4', 'Ana'), f('4', 'Ana', 'p')] }, 'mt_en_conflicto'],
    ['NEGATIVO: ya tiene nombre completo → no se pisa', { user_id: 'e', nombre: 'Pedro Ramos Diaz Gil', role_name: 'sin_acceso', fichas: [f('5', 'Pedro')] }, 'nombre_ya_completo'],
    ['NEGATIVO: con acceso a la Suite → lo corrige Sistemas', { user_id: 'g', nombre: 'Luis', role_name: 'vendedor', fichas: [f('6', 'Luis')] }, 'con_acceso'],
    ['sin ficha en MT → no propone', { user_id: 'h', nombre: 'Rosa', role_name: 'sin_acceso', fichas: [f('99', 'Rosa')] }, 'sin_ficha_en_mt'],
    ['apodo de 3 palabras igual al reloj → cuenta como corto', { user_id: 'i', nombre: 'Jose Alberto Moreno Vil', role_name: 'sin_acceso', fichas: [f('1', 'JOSE ALBERTO MORENO VIL')] }, 'propuestas'],
  ];
  let mal = 0;
  for (const [nombre, persona, esperado] of casos) {
    const { cuadre } = proponer([persona], mt);
    const ok = cuadre[esperado] === 1;
    if (!ok) mal++;
    console.log(`${ok ? '✔' : '✖'} ${nombre}  (esperado ${esperado}; cuadre ${JSON.stringify(cuadre)})`);
  }
  if (mal) { console.error(`✖ ${mal} control(es) fallaron: el guion no sirve.`); process.exit(1); }
  console.log('✔ los controles pasan');
}

async function leerSuite(knex) {
  // Personas ACTIVAS ligadas a algún código de reloj, con el apodo de cada reloj.
  const { rows } = await knex.raw(`
    SELECT u.id::text AS user_id, u.nombre, u.role_name, d.site_code AS sitio, COALESCE(e.person_code, e.device_user_id) AS codigo,
           max(e.device_name) AS apodo
      FROM hr.device_enrollments e
      JOIN hr.attendance_devices d ON d.id = e.device_id
      JOIN identity.users u ON u.id = e.user_id AND u.deleted_at IS NULL AND u.status IN ('active', 'invited')
     WHERE u.tenant_id = ?
     GROUP BY 1, 2, 3, 4, 5`, [TENANT_MD]);
  const porPersona = new Map();
  for (const r of rows) {
    if (!porPersona.has(r.user_id)) porPersona.set(r.user_id, { user_id: r.user_id, nombre: r.nombre, role_name: r.role_name, fichas: [] });
    porPersona.get(r.user_id).fichas.push({ sitio: r.sitio, codigo: r.codigo, apodo: r.apodo });
  }
  return [...porPersona.values()];
}

async function leerMegaTalento(mt) {
  const { rows } = await mt.query(`SELECT to_jsonb(e) AS j FROM empleados e WHERE btrim(coalesce(e.codigo_checador, '')) <> ''`);
  const m = new Map();
  for (const { j } of rows) m.set(`${String(j.sucursal_id || '').trim()}|${String(j.codigo_checador || '').trim()}`, { nombre_completo: j.nombre_completo || null });
  return m;
}

async function main() {
  if (process.argv.includes('--self')) return self();
  const aplicar = process.argv.includes('--aplicar');
  const destinoProd = process.argv.includes('--destino-prod');
  const informe = path.join(os.tmpdir(), `rh-nombres-mt-${Date.now()}.json`);
  try { require('dotenv').config({ path: process.env.DOTENV_PATH || path.resolve(__dirname, '../../../.env'), quiet: true }); } catch { /* sin dotenv */ }
  let url;
  if (destinoProd) {
    url = process.env.CARGA_URL;
    if (!url) throw new Error('--destino-prod necesita CARGA_URL (dentro del pod: CARGA_URL="$DATABASE_URL_NEW").');
  } else {
    require('../../tests/_lib/assert-safe-target').assertSafeTarget('nombres-completos-mega-talento');
    url = process.env.DATABASE_URL_NEW;
  }
  // En ensayo la conexión a la Suite nace en SÓLO LECTURA: la base rechaza cualquier escritura, no sólo el código.
  const connection = aplicar ? url : { connectionString: url, options: '-c default_transaction_read_only=on' };
  const knex = require('knex')({ client: 'pg', connection, pool: { min: 0, max: 1 } });
  const { conectarMegaTalento } = require('./carga-unica-mega-talento');
  let mt;
  try {
    if (!aplicar) {
      const ro = (await knex.raw('SHOW default_transaction_read_only')).rows[0].default_transaction_read_only;
      if (ro !== 'on') throw new Error('El ensayo NO quedó en sólo lectura contra la Suite: no sigo.');
      console.log('  ensayo: la conexión a la Suite está en sólo lectura');
    }
    if (destinoProd) {
      const { rows: [id] } = await knex.raw('select (select system_identifier from pg_control_system())::text as id');
      if (id.id !== PROD_CLUSTER_ID) throw new Error(`DESTINO EQUIVOCADO — clúster ${id.id}, se esperaba ${PROD_CLUSTER_ID}. No sigo.`);
    }
    mt = await conectarMegaTalento(process.env.MT_DATABASE_URL);
    const { cuadre, propuestas, conflictos } = proponer(await leerSuite(knex), await leerMegaTalento(mt));
    console.log('Cuadre (personas activas ligadas a un reloj):');
    for (const [k, v] of Object.entries(cuadre)) console.log(`  ${k.padEnd(24)} ${v}`);
    const cuadra = cuadre.personas === cuadre.nombre_ya_completo + cuadre.con_acceso + cuadre.sin_ficha_en_mt
      + cuadre.mt_sin_nombre_completo + cuadre.mt_igual + cuadre.mt_en_conflicto + cuadre.propuestas;
    console.log(`  CONTROL: las partes suman el total → ${cuadra ? 'sí' : 'NO (el guion está mal: no sigo)'}`);
    if (!cuadra) throw new Error('el cuadre no cierra');
    fs.writeFileSync(informe, JSON.stringify({ cuadre, propuestas, conflictos }, null, 2), { mode: 0o600 });
    console.log(`Informe con nombres (fuera del repo): ${informe}`);
    if (!aplicar) { console.log('ENSAYO: no se escribió nada. Con --aplicar se cambian las propuestas.'); return; }
    await knex.transaction(async (trx) => {
      await trx.raw(`SELECT set_config('app.tenant_id', ?, true)`, [TENANT_MD]);
      let n = 0;
      for (const p of propuestas) {
        // Se vuelve a exigir el nombre de antes: si alguien lo corrigió entre la lectura y ahora, no se pisa.
        const k = await trx('identity.users').where({ id: p.user_id, nombre: p.antes, role_name: ROL_SIN_ACCESO }).update({ nombre: p.despues, updated_at: trx.fn.now() });
        if (!k) continue;
        n++;
        await trx('identity.user_events').insert({
          tenant_id: TENANT_MD, user_id: p.user_id, event: 'nombre_desde_mega_talento',
          detalle: JSON.stringify({ antes: p.antes, despues: p.despues, fichas: p.fichas, fuente: 'mega_talento.empleados.nombre_completo' }),
          actor_user_id: null, actor_username: 'nombres-completos-mega-talento.js',
        });
      }
      console.log(`APLICADO: ${n} de ${propuestas.length} nombres cambiados (los demás cambiaron mientras tanto y no se pisaron).`);
    });
  } finally {
    if (mt) await mt.end();
    await knex.destroy();
  }
}

if (require.main === module) main().catch((e) => { console.error(`✖ ${e.message}`); process.exit(1); });
module.exports = { proponer };
