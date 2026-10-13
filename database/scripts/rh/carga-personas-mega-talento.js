'use strict';
/**
 * Fase RH · `[RH.1.4]`/`[RH.1.4b]` — CARGA ÚNICA del padrón de Mega Talento (`empleados`) a la Suite:
 * la PERSONA a `identity.users`, su FICHA de cada plaza a `hr.person_site_profiles`, y la liga de cada
 * código de reloj (`hr.device_enrollments.user_id`) con su persona.
 *
 * No es un importer (CLAUDE.md, regla principal; ADR-084 D4): corre UNA vez, en el corte, después de
 * `carga-unica-mega-talento.js` (que deja los enrolamientos). Por omisión es ENSAYO: escribe dentro de
 * una transacción, imprime el cuadre y la deshace.
 *
 *   MT_DATABASE_URL=… DATABASE_URL_NEW=… node database/scripts/rh/carga-personas-mega-talento.js            # ensayo
 *   MT_DATABASE_URL=… DATABASE_URL_NEW=… node database/scripts/rh/carga-personas-mega-talento.js --aplicar  # deja lo cargado
 *   … --informe=<archivo.json>   # las listas (con nombres: NUNCA dentro del repo)
 *   … --con-cargas               # ensayo en una base sin la fase: corre migraciones + carga de checadas en la misma transacción
 *   … --destino-prod             # el corte, dentro del pod (CARGA_URL="$DATABASE_URL_NEW"), igual que la carga de checadas
 *
 * ── Lo que Mega Talento YA sabe, y por eso no se le pregunta a RH (medido 2026-10-12) ─────────
 *  · El «departamento» de Mega Talento es la SECCIÓN del reporte de RH (sale de los PDF de nómina de
 *    ContPAQi) y mezcla área con plaza a propósito («SUC.PADRE HIDALGO», «STAFF LA PIEDAD»…). Se
 *    guarda TAL CUAL por ficha: el reporte de la Suite agrupa por ella igual que el de Mega Talento.
 *    La primera versión la traducía a los 21 departamentos de la Suite y el reporte dejaba de ser el
 *    de RH. Ahora no se le pone departamento ni puesto de la Suite a nadie: no hay de dónde sacarlos
 *    (485 de 488 activos sin puesto) y lo que no tiene fuente no se inventa.
 *  · 21 nombres completos aparecen en dos o tres plazas: es la MISMA persona (staff que rota entre
 *    sucursales), con fichas activas y checadas de esta semana en las dos. Aquí es UNA persona con una
 *    ficha por plaza. Regla: mismo nombre completo normalizado de 3 palabras o más (los nombres salen
 *    de los reportes de nómina: completos). Un nombre más corto no se une con nada.
 *  · Activa o de baja es POR FICHA: quien se mudó tiene la vieja de baja y la nueva activa. La persona
 *    queda `invited` si alguna ficha está activa y `terminated` si ninguna.
 *  · Las plazas → almacén salen de `mapeo-personas-mega-talento.json`, confirmado contra la tabla de
 *    plazas de Mega Talento (`docs/CONTEXTO-AGENTE.md` §1).
 *
 * ── Ligar con cuentas que ya existen en la Suite ─────────────────────────────────────────────
 *  · Si un enrolamiento de alguna de sus fichas ya tiene persona, se REUSA (la carga es idempotente).
 *  · Si no, una cuenta de la Suite con el MISMO nombre completo (3 palabras o más) y almacén compatible:
 *    exactamente una → se liga a esa cuenta sin tocarla.
 *  · Si no hay ninguna —o si el empate es con VARIAS cuentas de la Suite, o con una por un nombre corto—
 *    se CREA la persona desde Mega Talento (`kind='interno'`, sin contraseña, rol `sin_acceso`): Mega
 *    Talento sabe que es un empleado y la asistencia lo necesita ligado. El empate se deja como AVISO
 *    para Sistemas (son cuentas duplicadas de la propia Suite, no una duda de RH). La primera versión no
 *    creaba nada y la paridad lo midió: 3 personas fuera del padrón, 27 diferencias.
 *  · Sólo se detiene («por decidir») si los códigos de reloj de la persona YA están ligados a dos
 *    personas distintas: ahí no hay con qué escoger.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const carga = require('./carga-unica-mega-talento.js');

const TENANT_MD = carga.TENANT_MD;
const PROD_CLUSTER_ID = carga.PROD_CLUSTER_ID;
/** Bajas sin contraseña y rol `sin_acceso` (`[RH.1.4]`). */
const MIGRACION_PERSONAS = '20261012094356_rh_personas_bajas_y_sin_acceso';
/** La ficha por plaza: sección, casilla de promotora y activa en esa plaza (`[RH.1.4b]`). */
const MIGRACION_FICHAS = '20261012151620_hr_secciones_por_ficha';
const ROL_SIN_ACCESO = 'sin_acceso';
const MAPEO_POR_OMISION = path.join(__dirname, 'mapeo-personas-mega-talento.json');
const RE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Palabras mínimas de un nombre para unir fichas o ligarlo a una cuenta: menos es un apodo. */
const PALABRAS_MINIMAS = 3;

// ── Reglas puras (las prueba `personas-carga.spec.ts` sin base) ──────────────────────────────────

/** Nombre comparable: mayúsculas, sin acentos ni signos, espacios colapsados. */
function normalizarNombre(v) {
  return String(v ?? '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toUpperCase().replace(/[.,_-]/g, ' ').replace(/\s+/g, ' ').trim();
}
const palabras = (normal) => (normal ? normal.split(' ').length : 0);

/** La sección de RH como la guarda Mega Talento (MAYÚSCULAS, sin espacios de sobra); null si no hay. */
function seccionDe(departamento) {
  const s = String(departamento ?? '').replace(/\s+/g, ' ').trim().toUpperCase();
  return s || null;
}

/** El nombre que identifica a la persona: el completo de RH, o el del reloj si no hay. */
function nombreDe(f) {
  return String(f.nombre_completo || f.nombre || '').trim();
}

/**
 * Junta las fichas de la MISMA persona: mismo nombre completo normalizado de 3 palabras o más. Las
 * demás quedan solas. Devuelve [{ clave, nombre, fichas[] }] en orden estable.
 */
function agruparPersonas(fichas) {
  const grupos = new Map();
  for (const f of fichas) {
    const normal = normalizarNombre(nombreDe(f));
    const clave = palabras(normal) >= PALABRAS_MINIMAS ? `n:${normal}` : `f:${f.sitio}|${f.codigo}`;
    if (!grupos.has(clave)) grupos.set(clave, { clave, nombre: nombreDe(f), normal, fichas: [] });
    grupos.get(clave).fichas.push(f);
  }
  return [...grupos.values()];
}

/** El almacén de la persona: el de sus plazas si todas coinciden; null si son varios o ninguno. */
function almacenDe(fichasDePersona, sitios) {
  const set = new Set(fichasDePersona.map((f) => sitios[f.sitio]?.warehouse_code ?? null));
  return set.size === 1 ? [...set][0] : null;
}

/**
 * La decisión por persona. `ligadas` = personas que YA tienen los enrolamientos de alguna de sus fichas;
 * `cuentas` = cuentas de la Suite con el mismo nombre normalizado (ya filtradas por almacén compatible).
 */
function decidir({ ligadas, cuentas, palabras: n }) {
  if (ligadas.length === 1) return { accion: 'reusar', userId: ligadas[0] };
  if (ligadas.length > 1) return { accion: 'por_decidir', motivo: 'sus_codigos_estan_ligados_a_dos_personas' };
  if (cuentas.length === 1 && n >= PALABRAS_MINIMAS) return { accion: 'ligar_cuenta', userId: cuentas[0] };
  if (cuentas.length > 1) return { accion: 'crear', aviso: 'varias_cuentas_de_la_suite_con_el_mismo_nombre' };
  if (cuentas.length === 1) return { accion: 'crear', aviso: 'nombre_corto_coincide_con_una_cuenta' };
  return { accion: 'crear' };
}

/** Username estable por persona: el de su primera ficha (plaza + código). */
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
  const sitios = mapeo?.sitios || {};

  const rol = await trx('identity.role_permissions').where({ tenant_id: tenantId, role_name: ROL_SIN_ACCESO }).whereNull('deleted_at').first('role_name');
  if (!rol) throw new Error(`no existe el rol ${ROL_SIN_ACCESO}: falta la migración ${MIGRACION_PERSONAS}`);
  if (!(await trx.schema.withSchema('hr').hasTable('person_site_profiles'))) {
    throw new Error(`no existe hr.person_site_profiles: falta la migración ${MIGRACION_FICHAS}`);
  }

  // Sitios: el almacén del mapeo, sólo donde está vacío.
  let sitiosConAlmacen = 0;
  for (const [code, s] of Object.entries(sitios)) {
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

  const personas = agruparPersonas(fichas);
  const c = {
    fichas: fichas.length, personas: personas.length, personas_con_varias_fichas: 0, fichas_unidas: 0,
    creadas: 0, creadas_activas: 0, creadas_bajas: 0, reusadas: 0, ligadas_a_cuenta_existente: 0, por_decidir: 0,
    avisos_para_sistemas: 0,
    fichas_guardadas: 0, fichas_con_seccion: 0, fichas_sin_seccion: 0, fichas_promotora: 0, fichas_de_baja: 0,
    sitio_sin_mapeo: 0, enrolamientos_ligados: 0, sitios_con_almacen: sitiosConAlmacen,
  };
  const listas = { por_decidir: [], personas_con_varias_fichas: [], cuentas_existentes_ligadas: [], avisos_para_sistemas: [] };

  // ── La ficha de cada plaza: sección, casilla de promotora, activa en esa plaza (siempre, se ligue o no) ──
  for (const f of fichas) {
    if (!sitios[f.sitio]) c.sitio_sin_mapeo++;
    const seccion = seccionDe(f.departamento);
    if (seccion) c.fichas_con_seccion++; else c.fichas_sin_seccion++;
    if (f.es_promotora) c.fichas_promotora++;
    if (!f.activo) c.fichas_de_baja++;
    await trx('hr.person_site_profiles').insert({
      tenant_id: tenantId, site_code: f.sitio, person_code: f.codigo,
      report_section: seccion, is_promoter: f.es_promotora === true, is_active: f.activo === true,
    }).onConflict(['tenant_id', 'site_code', 'person_code']).merge(['report_section', 'is_promoter', 'is_active', 'updated_at']);
    c.fichas_guardadas++;
  }

  const reclamadas = new Map();   // cuenta existente → persona que la tomó (una cuenta no se liga a dos personas)
  for (const p of personas) {
    if (p.fichas.length > 1) {
      c.personas_con_varias_fichas++;
      c.fichas_unidas += p.fichas.length;
      listas.personas_con_varias_fichas.push({ nombre: p.nombre, fichas: p.fichas.map((f) => `${f.sitio}|${f.codigo}|${f.activo ? 'activa' : 'baja'}`) });
    }
    const almacen = almacenDe(p.fichas, sitios);
    const ligadas = [...new Set(p.fichas.flatMap((f) => [...(ligadasPor.get(`${f.sitio}|${f.codigo}`) || [])]))];
    const cuentas = (cuentasPorNombre.get(p.normal) || [])
      .filter((u) => !u.warehouse_code || !almacen || u.warehouse_code === almacen)
      .map((u) => u.id);
    const d = decidir({ ligadas, cuentas, palabras: palabras(p.normal) });

    let userId = null;
    if (d.accion === 'reusar') { userId = d.userId; c.reusadas++; }
    else if (d.accion === 'ligar_cuenta') {
      if (reclamadas.has(d.userId)) {
        c.por_decidir++; listas.por_decidir.push({ nombre: p.nombre, fichas: p.fichas.map((f) => `${f.sitio}|${f.codigo}`), motivo: 'la_cuenta_ya_la_tomo_otra_persona', otra: reclamadas.get(d.userId) });
        continue;
      }
      reclamadas.set(d.userId, p.clave);
      userId = d.userId; c.ligadas_a_cuenta_existente++;
      listas.cuentas_existentes_ligadas.push({ nombre: p.nombre, fichas: p.fichas.map((f) => `${f.sitio}|${f.codigo}`), user_id: userId });
    } else if (d.accion === 'por_decidir') {
      c.por_decidir++; listas.por_decidir.push({ nombre: p.nombre, fichas: p.fichas.map((f) => `${f.sitio}|${f.codigo}`), motivo: d.motivo });
      continue;
    } else {
      const primera = p.fichas[0];
      const username = usernameDe(primera.sitio, primera.codigo);
      if (usernames.has(username)) {
        c.por_decidir++; listas.por_decidir.push({ nombre: p.nombre, fichas: p.fichas.map((f) => `${f.sitio}|${f.codigo}`), motivo: 'username_ocupado_sin_enrolamiento', username });
        continue;
      }
      const activa = p.fichas.some((f) => f.activo === true);
      const bajas = p.fichas.map((f) => f.baja_en || f.eliminado_en).filter(Boolean).sort();
      const [u] = await trx('identity.users').insert({
        tenant_id: tenantId, username, password_hash: null, nombre: p.nombre || primera.codigo,
        role_name: ROL_SIN_ACCESO, kind: 'interno',
        // `activo` lo deriva el trigger de `status` (`[ID.8]`): invited y terminated quedan en false.
        status: activa ? 'invited' : 'terminated',
        terminated_at: activa ? null : (bajas[bajas.length - 1] || null),
        // Sin departamento ni puesto de la Suite: Mega Talento no los tiene, y lo que no tiene fuente no se
        // inventa. La sección de RH vive en la ficha (hr.person_site_profiles).
        department_code: null, position_code: null, warehouse_code: almacen,
      }).returning('id');
      userId = u.id ?? u;
      usernames.add(username);
      if (d.aviso) {
        c.avisos_para_sistemas++;
        listas.avisos_para_sistemas.push({ nombre: p.nombre, fichas: p.fichas.map((f) => `${f.sitio}|${f.codigo}`), aviso: d.aviso, user_id: userId });
      }
      c.creadas++;
      if (activa) c.creadas_activas++; else c.creadas_bajas++;
    }

    for (const f of p.fichas) {
      const res = await trx.raw(`
        UPDATE hr.device_enrollments e SET user_id = ?, updated_at = now()
          FROM hr.attendance_devices d
         WHERE d.tenant_id = e.tenant_id AND d.id = e.device_id AND e.tenant_id = ?
           AND d.site_code = ? AND COALESCE(e.person_code, e.device_user_id) = ? AND e.user_id IS NULL`,
      [userId, tenantId, f.sitio, f.codigo]);
      c.enrolamientos_ligados += res.rowCount || 0;
    }
  }

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
      const faltan = [MIGRACION_PERSONAS, MIGRACION_FICHAS].filter((m) => !aplicadas.has(m));
      if (faltan.length) throw new Error(`faltan migraciones en prod (se aplican antes, una por una): ${faltan.join(', ')}`);
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
        const migs = [carga.MIGRACION_BASE_CH, ...carga.MIGRACIONES_FASE, ...previasIdentity, MIGRACION_PERSONAS, MIGRACION_FICHAS];
        const aplicadas = new Set((await trx.raw('SELECT name FROM public.knex_migrations')).rows.map((r) => r.name.replace(/\.js$/, '')));
        for (const m of migs) if (!aplicadas.has(m)) await require(path.resolve(__dirname, '../../migrations-newdb', `${m}.js`)).up(trx);
      }
      await trx.raw(`SELECT set_config('app.tenant_id', ?, true)`, [TENANT_MD]);
      if (conCargas) { console.log('Carga de checadas (ensayo, misma transacción)…'); await carga.cargarMegaTalento(trx, mt, {}); }
      console.log(`Carga de personas de Mega Talento → ${destinoProd ? 'PROD · ' : ''}${aplicar ? 'SE APLICA' : 'ENSAYO (se deshace al final)'}`);
      const { cuadre, listas } = await cargarPersonas(trx, await leerFichas(mt), { mapeo, log: console.log });
      fs.writeFileSync(informe, JSON.stringify({ generado: new Date().toISOString(), aplicado: aplicar, cuadre, listas }, null, 2));
      console.log(`\nInforme (con nombres — no subirlo al repo): ${informe}`);
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
  normalizarNombre, seccionDe, agruparPersonas, almacenDe, decidir, usernameDe,
  cargarPersonas, leerFichas, MIGRACION_PERSONAS, MIGRACION_FICHAS, ROL_SIN_ACCESO, MAPEO_POR_OMISION, PROD_CLUSTER_ID,
  PALABRAS_MINIMAS,
};
