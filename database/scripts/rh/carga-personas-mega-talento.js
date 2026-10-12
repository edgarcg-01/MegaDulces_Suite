'use strict';
/**
 * Fase RH · `[RH.1.4]` — CARGA ÚNICA del padrón de Mega Talento (`empleados`) a `identity.users`, y la
 * liga de cada código de reloj (`hr.device_enrollments.user_id`) con su persona.
 *
 * No es un importer (CLAUDE.md, regla principal; ADR-084 D4): corre UNA vez, en el corte, después de
 * `carga-unica-mega-talento.js` (que deja los enrolamientos). Por omisión es ENSAYO: escribe dentro de
 * una transacción, imprime el cuadre y la deshace.
 *
 *   MT_DATABASE_URL=… DATABASE_URL_NEW=… node database/scripts/rh/carga-personas-mega-talento.js            # ensayo
 *   MT_DATABASE_URL=… DATABASE_URL_NEW=… node database/scripts/rh/carga-personas-mega-talento.js --aplicar  # deja lo cargado
 *   … --informe=<archivo.json>   # las listas para RH (con nombres: NUNCA dentro del repo)
 *   … --con-cargas               # ensayo en una base sin la fase: corre migraciones + carga de checadas en la misma transacción
 *   … --destino-prod             # el corte, dentro del pod (CARGA_URL="$DATABASE_URL_NEW"), igual que la carga de checadas
 *
 * ── Por qué hace falta (medido 2026-10-07, `[RH.1.8]`) ───────────────────────────────────────
 * Tras la carga de checadas hay 991 enrolamientos activos y NINGUNO ligado a una persona: el pre-vuelo
 * bloquea. Sin personas la asistencia no sabe quién faltó (el padrón es lo LIGADO), ni quién es
 * promotora, ni quién está de baja. La paridad de 0 diferencias simuló exactamente esto: una persona
 * por ficha de Mega Talento, con su estado y su promotoría.
 *
 * ── Las reglas (no adivinar: lo que no se decide con evidencia va a la lista de RH) ───────────
 *  · Una ficha = `(sitio, código del reloj)`. Mega Talento no guarda CURP/RFC/NSS, así que dos fichas
 *    con el mismo nombre en dos plazas NO se unen: salen como «posibles repetidas».
 *  · Si un enrolamiento de la ficha ya tiene persona, se REUSA (la carga es idempotente).
 *  · Si no, se busca una cuenta de la Suite con el MISMO nombre completo (normalizado, de 3 palabras o
 *    más) en el mismo almacén o sin almacén. Exactamente una → se liga a esa cuenta, sin tocarla. Más de
 *    una, o un nombre de menos de 3 palabras que coincide → NO se crea ni se liga: «por decidir».
 *  · Si no hay ninguna, se CREA la persona: `kind='interno'`, sin contraseña, rol `sin_acceso`;
 *    `invited` si la ficha está activa, `terminated` si no (`activo` lo deriva el trigger de `status`); departamento, puesto y
 *    almacén del mapeo (`mapeo-personas-mega-talento.json`).
 *  · La promotora DE MARCA (casilla `es_promotora` o «promotor» en el departamento, salvo «Mega
 *    Dulces») va al departamento `promotoria_marca`: es lo que la asistencia usa para no medirla
 *    con la vara de piso.
 *  · Los sitios sin almacén toman el del mapeo (sólo si están vacíos).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const carga = require('./carga-unica-mega-talento.js');

const TENANT_MD = carga.TENANT_MD;
const PROD_CLUSTER_ID = carga.PROD_CLUSTER_ID;
/** La migración de esta carga: bajas sin contraseña, rol `sin_acceso`, departamento de promotoría. */
const MIGRACION_PERSONAS = '20261012094356_rh_personas_bajas_y_sin_acceso';
const ROL_SIN_ACCESO = 'sin_acceso';
const DEPTO_PROMOTORIA = 'promotoria_marca';
const MAPEO_POR_OMISION = path.join(__dirname, 'mapeo-personas-mega-talento.json');
const RE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ── Reglas puras (las prueba `personas-carga.spec.ts` sin base) ──────────────────────────────────

/** Texto de departamento comparable: mayúsculas, sin acentos ni puntos, espacios colapsados. */
function normalizarTexto(v) {
  return String(v ?? '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toUpperCase().replace(/[.,]/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Nombre comparable: como el texto, y además sin guiones ni dobles espacios. */
function normalizarNombre(v) {
  return normalizarTexto(v).replace(/[-_]/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * COPIA de `esDeptoDePromotoria` (`libs/hr/.../logic/tipos.ts`, `[RH.1.5c]`): este guion corre solo en
 * el pod y no puede requerir TypeScript. `personas-carga.spec.ts` exige que las dos den lo mismo.
 */
function esDeptoDePromotoria(departamento) {
  const d = String(departamento || '');
  return /promotor/i.test(d) && !/mega\s*dulces/i.test(d);
}

/** Valida el mapeo y lo deja listo para buscar por texto normalizado. Lanza si hay variantes repetidas. */
function prepararMapeo(mapeo) {
  const porTexto = new Map();
  for (const g of mapeo.departamentos || []) {
    for (const v of g.variantes || []) {
      const k = normalizarTexto(v);
      if (porTexto.has(k)) throw new Error(`mapeo: la variante «${v}» está en dos grupos`);
      porTexto.set(k, g);
    }
  }
  return { sitios: mapeo.sitios || {}, porTexto };
}

/**
 * Qué departamento, puesto y almacén le tocan a una ficha según el mapeo. Nunca inventa: lo que no
 * está mapeado vuelve en `null` con su aviso.
 */
function resolverFicha(ficha, mp) {
  const avisos = [];
  const sitio = mp.sitios[ficha.sitio];
  if (!sitio) avisos.push('sitio_sin_mapeo');
  const warehouse_code = sitio?.warehouse_code ?? null;
  const promotora = ficha.es_promotora === true || esDeptoDePromotoria(ficha.departamento);
  const texto = normalizarTexto(ficha.departamento);
  const grupo = texto ? mp.porTexto.get(texto) : null;
  let department_code = grupo?.department_code ?? null;
  let position_code = grupo?.position_code ?? null;
  if (!texto) avisos.push('sin_departamento');
  else if (!grupo) avisos.push('departamento_sin_mapeo');
  if (promotora && department_code !== DEPTO_PROMOTORIA) {
    // La casilla manda: es lo que la asistencia mide. El puesto del grupo ya no aplica.
    department_code = DEPTO_PROMOTORIA;
    position_code = null;
  }
  const validado = !!(sitio?.validado && (grupo ? grupo.validado : true));
  return { warehouse_code, department_code, position_code, promotora, validado, avisos };
}

/**
 * La decisión por ficha. `ligadas` = personas que YA tienen sus enrolamientos; `cuentas` = cuentas
 * de la Suite con el mismo nombre normalizado (ya filtradas por almacén compatible).
 */
function decidir({ ligadas, cuentas, palabras }) {
  if (ligadas.length === 1) return { accion: 'reusar', userId: ligadas[0] };
  if (ligadas.length > 1) return { accion: 'por_decidir', motivo: 'codigo_ligado_a_dos_personas' };
  if (cuentas.length === 1 && palabras >= 3) return { accion: 'ligar_cuenta', userId: cuentas[0] };
  if (cuentas.length > 1) return { accion: 'por_decidir', motivo: 'varias_cuentas_con_el_mismo_nombre' };
  if (cuentas.length === 1) return { accion: 'por_decidir', motivo: 'nombre_corto_coincide_con_una_cuenta' };
  return { accion: 'crear' };
}

/** Username estable y único por ficha. */
function usernameDe(sitio, codigo) {
  const limpio = (s) => String(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return `mt.${limpio(sitio)}.${limpio(codigo)}`;
}

// ── La carga ─────────────────────────────────────────────────────────────────────────────────────

/**
 * Carga dentro de `trx` (con `app.tenant_id` puesto). `fichas` es la lista ya leída de Mega Talento
 * (ver `leerFichas`), para poder probarla sin una base de Mega Talento.
 */
async function cargarPersonas(trx, fichas, { mapeo, tenantId = TENANT_MD, log = null } = {}) {
  if (!RE_UUID.test(tenantId)) throw new Error(`tenant inválido: ${tenantId}`);
  const avisar = typeof log === 'function' ? log : () => undefined;
  const mp = prepararMapeo(mapeo);

  const rol = await trx('identity.role_permissions').where({ tenant_id: tenantId, role_name: ROL_SIN_ACCESO }).whereNull('deleted_at').first('role_name');
  if (!rol) throw new Error(`no existe el rol ${ROL_SIN_ACCESO}: falta la migración ${MIGRACION_PERSONAS}`);
  const deptos = new Set((await trx('identity.departments').where({ tenant_id: tenantId }).whereNull('deleted_at').select('code')).map((r) => r.code));
  const puestos = new Set((await trx('identity.positions').where({ tenant_id: tenantId }).whereNull('deleted_at').select('code')).map((r) => r.code));
  if (!deptos.has(DEPTO_PROMOTORIA)) throw new Error(`no existe el departamento ${DEPTO_PROMOTORIA}: falta la migración ${MIGRACION_PERSONAS}`);

  // Sitios: el almacén del mapeo, sólo donde está vacío.
  let sitiosConAlmacen = 0;
  for (const [code, s] of Object.entries(mp.sitios)) {
    if (!s.warehouse_code) continue;
    sitiosConAlmacen += await trx('hr.attendance_sites').where({ tenant_id: tenantId, code }).whereNull('warehouse_code')
      .update({ warehouse_code: s.warehouse_code, updated_at: trx.fn.now() });
  }

  // Lo que ya está ligado: (sitio|código) → personas.
  const ligadasPor = new Map();
  for (const r of (await trx.raw(`
      SELECT d.site_code, COALESCE(e.person_code, e.device_user_id) AS code, e.user_id
        FROM hr.device_enrollments e
        JOIN hr.attendance_devices d ON d.tenant_id = e.tenant_id AND d.id = e.device_id
       WHERE e.tenant_id = ? AND e.user_id IS NOT NULL`, [tenantId])).rows) {
    const k = `${r.site_code}|${r.code}`;
    if (!ligadasPor.has(k)) ligadasPor.set(k, new Set());
    ligadasPor.get(k).add(r.user_id);
  }

  // Cuentas de personas que ya existen en la Suite, por nombre normalizado.
  const cuentasPorNombre = new Map();
  for (const u of await trx('identity.users').where({ tenant_id: tenantId }).whereNull('deleted_at')
    .whereIn('kind', ['interno', 'externo']).select('id', 'nombre', 'warehouse_code', 'username')) {
    if (String(u.username).startsWith('mt.')) continue;   // las que creó esta carga se encuentran por su enrolamiento
    const k = normalizarNombre(u.nombre);
    if (!k) continue;
    if (!cuentasPorNombre.has(k)) cuentasPorNombre.set(k, []);
    cuentasPorNombre.get(k).push(u);
  }
  const usernames = new Set((await trx('identity.users').where({ tenant_id: tenantId }).select('username')).map((r) => r.username));

  const c = {
    fichas: fichas.length, creadas: 0, creadas_activas: 0, creadas_bajas: 0, reusadas: 0, ligadas_a_cuenta_existente: 0,
    por_decidir: 0, sin_departamento: 0, departamento_sin_mapeo: 0, sitio_sin_mapeo: 0, codigo_de_departamento_inexistente: 0,
    codigo_de_puesto_inexistente: 0, promotoras: 0, mapeo_validado: 0, enrolamientos_ligados: 0, sitios_con_almacen: sitiosConAlmacen,
  };
  const listas = { por_decidir: [], departamento_sin_mapeo: [], posibles_repetidas: [], cuentas_existentes_ligadas: [] };
  const reclamadas = new Map();   // cuenta existente → ficha que la tomó (una cuenta no se liga a dos fichas del mismo sitio)
  const personaDeFicha = new Map();

  for (const f of fichas) {
    const k = `${f.sitio}|${f.codigo}`;
    const r = resolverFicha(f, mp);
    for (const a of r.avisos) c[a]++;
    if (r.promotora) c.promotoras++;
    if (r.validado) c.mapeo_validado++;
    if (r.department_code && !deptos.has(r.department_code)) { c.codigo_de_departamento_inexistente++; r.department_code = null; r.position_code = null; }
    if (r.position_code && !puestos.has(r.position_code)) { c.codigo_de_puesto_inexistente++; r.position_code = null; }
    if (r.avisos.includes('departamento_sin_mapeo')) listas.departamento_sin_mapeo.push({ sitio: f.sitio, codigo: f.codigo, departamento: f.departamento });

    const nombre = String(f.nombre_completo || f.nombre || '').trim();
    const normal = normalizarNombre(nombre);
    const cuentas = (cuentasPorNombre.get(normal) || [])
      .filter((u) => !u.warehouse_code || !r.warehouse_code || u.warehouse_code === r.warehouse_code)
      .map((u) => u.id);
    const d = decidir({ ligadas: [...(ligadasPor.get(k) || [])], cuentas, palabras: normal ? normal.split(' ').length : 0 });

    let userId = null;
    if (d.accion === 'reusar') { userId = d.userId; c.reusadas++; }
    else if (d.accion === 'ligar_cuenta') {
      const otra = reclamadas.get(d.userId);
      if (otra && otra.startsWith(`${f.sitio}|`)) {
        c.por_decidir++; listas.por_decidir.push({ sitio: f.sitio, codigo: f.codigo, nombre, motivo: 'la_cuenta_ya_la_tomo_otra_ficha_del_sitio', otra });
        continue;
      }
      reclamadas.set(d.userId, k);
      userId = d.userId; c.ligadas_a_cuenta_existente++;
      listas.cuentas_existentes_ligadas.push({ sitio: f.sitio, codigo: f.codigo, nombre, user_id: userId });
    } else if (d.accion === 'por_decidir') {
      c.por_decidir++; listas.por_decidir.push({ sitio: f.sitio, codigo: f.codigo, nombre, motivo: d.motivo });
      continue;
    } else {
      const username = usernameDe(f.sitio, f.codigo);
      if (usernames.has(username)) {
        c.por_decidir++; listas.por_decidir.push({ sitio: f.sitio, codigo: f.codigo, nombre, motivo: 'username_ocupado_sin_enrolamiento', username });
        continue;
      }
      const activa = f.activo === true;
      const [u] = await trx('identity.users').insert({
        tenant_id: tenantId, username, password_hash: null, nombre: nombre || f.codigo,
        role_name: ROL_SIN_ACCESO, kind: 'interno',
        // `activo` lo deriva el trigger de `status` (`[ID.8]`): invited y terminated quedan en false.
        status: activa ? 'invited' : 'terminated',
        terminated_at: activa ? null : (f.baja_en || f.eliminado_en || null),
        department_code: r.department_code, position_code: r.position_code, warehouse_code: r.warehouse_code,
      }).returning('id');
      userId = u.id ?? u;
      usernames.add(username);
      c.creadas++;
      if (activa) c.creadas_activas++; else c.creadas_bajas++;
    }
    personaDeFicha.set(k, { userId, nombre: normal, sitio: f.sitio });

    const res = await trx.raw(`
      UPDATE hr.device_enrollments e SET user_id = ?, updated_at = now()
        FROM hr.attendance_devices d
       WHERE d.tenant_id = e.tenant_id AND d.id = e.device_id AND e.tenant_id = ?
         AND d.site_code = ? AND COALESCE(e.person_code, e.device_user_id) = ? AND e.user_id IS NULL`,
    [userId, tenantId, f.sitio, f.codigo]);
    c.enrolamientos_ligados += res.rowCount || 0;
  }

  // Mismo nombre completo en dos sitios distintos con personas distintas: RH decide si es la misma.
  const porNombre = new Map();
  for (const [k, p] of personaDeFicha) {
    if (!p.nombre || p.nombre.split(' ').length < 2) continue;
    if (!porNombre.has(p.nombre)) porNombre.set(p.nombre, []);
    porNombre.get(p.nombre).push({ ficha: k, ...p });
  }
  for (const [nombre, xs] of porNombre) {
    if (new Set(xs.map((x) => x.sitio)).size > 1 && new Set(xs.map((x) => x.userId)).size > 1) {
      listas.posibles_repetidas.push({ nombre, fichas: xs.map((x) => x.ficha) });
    }
  }
  c.posibles_repetidas = listas.posibles_repetidas.length;

  const [{ total, ligados }] = (await trx.raw(`
    SELECT count(*)::int AS total, count(*) FILTER (WHERE user_id IS NOT NULL)::int AS ligados
      FROM hr.device_enrollments WHERE tenant_id = ? AND match_status <> 'ignorado'`, [tenantId])).rows;
  c.enrolamientos_activos = total;
  c.enrolamientos_activos_ligados = ligados;

  for (const [kk, v] of Object.entries(c)) avisar(`  ${kk.padEnd(36)} ${v}`);
  return { cuadre: c, listas };
}

/** Lee las fichas de Mega Talento (sólo lectura). `to_jsonb` para no depender de columnas opcionales. */
async function leerFichas(mt) {
  const { rows } = await mt.query(`SELECT to_jsonb(e) AS j FROM empleados e WHERE btrim(coalesce(e.codigo_checador, '')) <> ''`);
  return rows.map(({ j }) => ({
    sitio: String(j.sucursal_id || '').trim(),
    codigo: String(j.codigo_checador || '').trim(),
    nombre: j.nombre || null,
    nombre_completo: j.nombre_completo || null,
    departamento: j.departamento || null,
    activo: j.activo === true,
    es_promotora: j.es_promotora === true,
    baja_en: j.baja_en || null,
    eliminado_en: j.eliminado_en || null,
  }));
}

async function main() {
  const aplicar = process.argv.includes('--aplicar');
  const destinoProd = process.argv.includes('--destino-prod');
  const conCargas = process.argv.includes('--con-cargas');
  const informe = (process.argv.find((a) => a.startsWith('--informe=')) || '').slice('--informe='.length)
    || path.join(os.tmpdir(), `rh-personas-${Date.now()}.json`);
  try { require('dotenv').config({ path: process.env.DOTENV_PATH || path.resolve(__dirname, '../../../.env') }); } catch { /* sin dotenv */ }
  if (path.resolve(informe).startsWith(path.resolve(__dirname, '../../..'))) {
    throw new Error('El informe lleva nombres de personas: no puede quedar dentro del repo (es público).');
  }
  if (conCargas && (aplicar || destinoProd)) throw new Error('--con-cargas es sólo para ensayo.');
  let url;
  if (destinoProd) {
    url = process.env.CARGA_URL;
    if (!url) throw new Error('--destino-prod necesita CARGA_URL (dentro del pod: CARGA_URL="$DATABASE_URL_NEW").');
  } else {
    require('../../tests/_lib/assert-safe-target').assertSafeTarget('carga-personas-mega-talento');
    url = process.env.DATABASE_URL_NEW;
  }
  const knex = require('knex')({ client: 'pg', connection: url, pool: { min: 0, max: 1 } });
  if (destinoProd) {
    try {
      await carga.verificarDestinoProd(knex);
      const aplicadas = new Set((await knex.raw('SELECT name FROM public.knex_migrations')).rows.map((r) => r.name.replace(/\.js$/, '')));
      if (!aplicadas.has(MIGRACION_PERSONAS)) throw new Error(`falta la migración ${MIGRACION_PERSONAS} en prod (se aplica antes, una por una)`);
    } catch (e) { await knex.destroy(); throw e; }
  }
  const mapeo = JSON.parse(fs.readFileSync(process.env.RH_MAPEO || MAPEO_POR_OMISION, 'utf8'));
  const mt = await carga.conectarMegaTalento(process.env.MT_DATABASE_URL);
  const DESHACER = new Error('ensayo');
  try {
    await knex.transaction(async (trx) => {
      if (conCargas) {
        // Las de identity que la carga supone y una base local atrasada puede no tener (en prod ya están).
        // Primero hr.*, después identity: el mismo orden de candados que las pruebas.
        const previasIdentity = [
          '20260910120000_kind_dispositivo_y_hash_nullable',
          '20260911120000_positions_oficina',
          '20260911180000_departamentos_reales',
          '20261001120000_zn8_alcance_por_area',
        ];
        const migs = [carga.MIGRACION_BASE_CH, ...carga.MIGRACIONES_FASE, ...previasIdentity, MIGRACION_PERSONAS];
        const aplicadas = new Set((await trx.raw('SELECT name FROM public.knex_migrations')).rows.map((r) => r.name.replace(/\.js$/, '')));
        for (const m of migs) if (!aplicadas.has(m)) await require(path.resolve(__dirname, '../../migrations-newdb', `${m}.js`)).up(trx);
      }
      await trx.raw(`SELECT set_config('app.tenant_id', ?, true)`, [TENANT_MD]);
      if (conCargas) { console.log('Carga de checadas (ensayo, misma transacción)…'); await carga.cargarMegaTalento(trx, mt, {}); }
      console.log(`Carga de personas de Mega Talento → ${destinoProd ? 'PROD · ' : ''}${aplicar ? 'SE APLICA' : 'ENSAYO (se deshace al final)'}`);
      const { cuadre, listas } = await cargarPersonas(trx, await leerFichas(mt), { mapeo, log: console.log });
      fs.writeFileSync(informe, JSON.stringify({ generado: new Date().toISOString(), aplicado: aplicar, cuadre, listas }, null, 2));
      console.log(`\nInforme para RH (con nombres — no subirlo al repo): ${informe}`);
      if (!aplicar) throw DESHACER;
    });
  } catch (e) {
    if (e !== DESHACER) throw e;
    console.log('Ensayo: no quedó nada escrito.');
  } finally {
    await mt.end();
    await knex.destroy();
  }
}

if (require.main === module) {
  main().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
}

module.exports = {
  normalizarTexto, normalizarNombre, esDeptoDePromotoria, prepararMapeo, resolverFicha, decidir, usernameDe,
  cargarPersonas, leerFichas, MIGRACION_PERSONAS, ROL_SIN_ACCESO, DEPTO_PROMOTORIA, MAPEO_POR_OMISION, PROD_CLUSTER_ID,
};
