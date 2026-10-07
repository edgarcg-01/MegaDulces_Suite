'use strict';
/**
 * Fase RH · `[RH.1.8]` — PRE-VUELO del corte de asistencia (Mega Talento → Suite). SÓLO LECTURA.
 *
 * Contesta, contra la base real, lo que el corte necesita saber ANTES de tocar nada. Nació porque dos
 * cosas se habían DADO POR HECHAS sin medirlas: que prod «ya tenía ~129 mil checadas de la Fase CH»
 * (era falso) y que la migración base de CH estaba aplicada (`[CH.0.9]` dice que nunca se aplicó).
 *
 * ── Cómo se corre (el mismo camino que `apply-one-migration-prod.js`, ver su cabecera) ─────────
 *
 *     scp database/scripts/rh/prevuelo-corte-asistencia.js superoot@192.168.0.222:/tmp/
 *     ssh superoot@192.168.0.222
 *       export KUBECONFIG=/etc/rancher/k3s/k3s.yaml
 *       API=$(kubectl get pods -n prod -l app=api -o jsonpath='{.items[0].metadata.name}')
 *       kubectl cp /tmp/prevuelo-corte-asistencia.js prod/$API:/app/database/scripts/ -c api
 *       kubectl exec -n prod $API -c api -- sh -c \
 *         'PREVUELO_URL="$DATABASE_URL_NEW" node /app/database/scripts/prevuelo-corte-asistencia.js --exigir-prod'
 *
 *   ⚠️ A `/app/database/scripts/`, no a `/tmp`: Node busca `pg` subiendo desde la carpeta DEL ARCHIVO
 *      (no desde el directorio actual), y sólo `/app/node_modules` lo tiene.
 *
 *   Con Mega Talento (opcional: confirma que el pod lo alcanza, que es lo que necesita la carga):
 *   copiar un archivo con la URL (chmod 600) al pod y leerlo ahí, para que no quede en ningún argv:
 *       kubectl cp ~/secrets/mt.url prod/$API:/tmp/mt.url -c api
 *       kubectl exec ... -- sh -c 'PREVUELO_URL="$DATABASE_URL_NEW" MT_DATABASE_URL="$(cat /tmp/mt.url)" \
 *         node /app/database/scripts/prevuelo-corte-asistencia.js --exigir-prod; rm -f /tmp/mt.url'
 *
 *   En desarrollo: `PREVUELO_URL=postgres://…/platform_local node database/scripts/rh/prevuelo-corte-asistencia.js`
 *
 * ── Qué hace y qué no ─────────────────────────────────────────────────────────────────────────
 * Abre la sesión en `default_transaction_read_only` y aborta si no lo confirma. No escribe nada, no
 * toma candados más allá de lecturas de catálogo, y NUNCA imprime una cadena de conexión.
 * Un archivo, sólo `pg`: se copia al pod igual que el aplicador (la imagen no trae `libs/`).
 *
 * Cada revisión sale OK · AVISO · BLOQUEA · NO MEDIDO. Lo que no se pudo medir se DECLARA, nunca se
 * pinta como OK (ADR-056). Sale con 1 si algo BLOQUEA.
 */

/**
 * La identidad del clúster de PROD. COPIA de `apply-one-migration-prod.js` (que es la fuente: un
 * archivo que se copia solo al pod no puede requerir otro). `corte-scripts.spec.ts` exige que las
 * copias coincidan.
 */
const PROD_CLUSTER_ID = '7688376744939610156';

/**
 * La cadena de migraciones que el corte necesita, EN ORDEN. La primera es la base de la Fase CH: las de
 * RH la extienden (ALTER TABLE hr.attendance_devices…) y fallan si no está.
 */
const CADENA = [
  '20260817220000_hr_attendance.js',
  '20261007100000_hr_relojes_y_checadas.js',
  '20261007110000_hr_horarios_y_alertas.js',
  '20261007300000_hr_incidencias_y_cierres.js',
  '20261007310000_hr_agente_corridas.js',
  '20261007320000_hr_ordenes_quien.js',
  '20261007330000_hr_reparto_asistencia.js',
];

/** Nombres que estas migraciones tuvieron antes de renombrarlas (2026-10-07, chocaban con `main`). */
const NOMBRES_VIEJOS = [
  '20261007120000_hr_incidencias_y_cierres.js',
  '20261007130000_hr_agente_corridas.js',
  '20261007140000_hr_ordenes_quien.js',
  '20261007150000_hr_reparto_asistencia.js',
];

/** Las claves que reparte `20261007330000`, y a quién. */
const REPARTO = {
  recursos_humanos: ['HR_ATTENDANCE_VER', 'HR_ATTENDANCE_GESTIONAR', 'HR_INCIDENTS_CAPTURAR', 'HR_INCIDENTS_CALIFICAR', 'HR_PERIOD_CLOSE', 'HR_DEVICES_GESTIONAR'],
  contabilidad: ['HR_INCIDENTS_AUDITAR'],
};

const TABLAS_HR = [
  'attendance_devices', 'attendance_logs', 'device_enrollments', 'employees', 'attendance_sites', 'ingest_batches',
  'device_commands', 'attendance_alerts', 'attendance_incidents', 'attendance_closures', 'attendance_agent_runs',
];

const JOBS = ['hr_attendance_ingest', 'hr_attendance_agent'];

// ── Evaluación pura (se prueba sin base) ───────────────────────────────────────────────────────

const ts = (nombre) => String(nombre).slice(0, 14);

/**
 * El estado del ledger frente a la cadena. `aplicadas` = nombres de `public.knex_migrations`.
 * - pendientes: las de la cadena que faltan, en el orden en que hay que aplicarlas.
 * - fueraDeOrden: aplicada una que va DESPUÉS de una pendiente (knex no lo impide; el esquema sí).
 * - viejas: alguien aplicó un nombre anterior al renombre → knex dirá «directory is corrupt».
 * - colisiones: otra migración del ledger con el MISMO timestamp que una de la cadena.
 */
function evaluarLedger(aplicadas, cadena = CADENA, viejos = NOMBRES_VIEJOS) {
  const set = new Set(aplicadas);
  const pendientes = cadena.filter((m) => !set.has(m));
  const primeraPendiente = cadena.findIndex((m) => !set.has(m));
  const fueraDeOrden = primeraPendiente < 0 ? [] : cadena.slice(primeraPendiente + 1).filter((m) => set.has(m));
  const viejas = viejos.filter((m) => set.has(m));
  const nuestros = new Set([...cadena, ...viejos]);
  const colisiones = aplicadas
    .filter((a) => !nuestros.has(a) && cadena.some((m) => ts(m) === ts(a)))
    .map((a) => ({ aplicada: a, choca_con: cadena.find((m) => ts(m) === ts(a)) }));
  return { pendientes, fueraDeOrden, viejas, colisiones };
}

/**
 * El padrón ligado a personas (`[RH.1.4]`). La paridad de 0 diferencias se midió CON las personas ligadas
 * (la prueba creó los usuarios desde `empleados` de Mega Talento). Sin ligar, una persona sólo aparece si
 * checó — y así se pierden la falta de quien no vino en toda la semana, el corte planta/promotoras
 * (sale del departamento) y la exclusión de las bajas. Cero ligadas con padrón cargado = el reporte no
 * mide lo mismo que Mega Talento: BLOQUEA.
 */
function evaluarPadron({ total, ligados, sinLigarRecientes }) {
  if (!total) return { estado: 'NO MEDIDO', detalle: 'sin enrolamientos todavía (antes de la carga): se vuelve a revisar después de cargar' };
  if (!ligados) {
    return { estado: 'BLOQUEA', detalle: `${total} enrolamientos y NINGUNO ligado a una persona: falta [RH.1.4]. Sin eso no hay faltas de quien no checó, ni planta/promotoras, ni bajas` };
  }
  if (sinLigarRecientes) {
    return { estado: 'AVISO', detalle: `${ligados} de ${total} ligados; ${sinLigarRecientes} código(s) que checaron en los últimos 30 días siguen sin ligar (salen como «sin ligar a una persona»)` };
  }
  return { estado: 'OK', detalle: `${ligados} de ${total} enrolamientos ligados; todo lo que checó en 30 días tiene persona` };
}

/** ¿Hora hábil en México? (lunes a sábado, 08:00–20:00). La carga escribe ~215 mil filas. */
function enHorarioHabil(ahora = new Date()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Mexico_City', weekday: 'short', hour: '2-digit', hourCycle: 'h23',
  }).formatToParts(ahora).map((x) => [x.type, x.value]));
  const h = Number(p.hour);
  return p.weekday !== 'Sun' && h >= 8 && h < 20;
}

/** El veredicto final a partir de las revisiones. */
function veredicto(revisiones) {
  const bloquea = revisiones.filter((r) => r.estado === 'BLOQUEA');
  return { bloquea: bloquea.length, avisos: revisiones.filter((r) => r.estado === 'AVISO').length,
    noMedido: revisiones.filter((r) => r.estado === 'NO MEDIDO').length, ok: bloquea.length === 0 };
}

// ── Contra la base ─────────────────────────────────────────────────────────────────────────────

async function revisar({ url, mtUrl = null, exigirProd = false, env = process.env, ahora = new Date() }) {
  const { Client } = require('pg');
  const out = [];
  const anotar = (area, estado, detalle) => out.push({ area, estado, detalle });

  const c = new Client({ connectionString: url, ...(/rlwy\.net|railway\.app/.test(url) ? { ssl: { rejectUnauthorized: false } } : {}) });
  await c.connect();
  try {
    await c.query('SET default_transaction_read_only = on');
    const ro = (await c.query('SHOW transaction_read_only')).rows[0].transaction_read_only;
    if (ro !== 'on') throw new Error('la sesión no quedó en sólo lectura: se aborta sin revisar nada');
    const q = async (sql, p = []) => (await c.query(sql, p)).rows;

    // 1) Identidad
    const [id] = await q(`SELECT (SELECT system_identifier FROM pg_control_system())::text AS id, current_database() AS db`);
    const esProd = id.id === PROD_CLUSTER_ID;
    anotar('identidad', esProd ? 'OK' : (exigirProd ? 'BLOQUEA' : 'AVISO'),
      esProd ? `prod (clúster ${id.id}, base "${id.db}")` : `NO es prod: clúster ${id.id}, base "${id.db}"${exigirProd ? ' — se pidió --exigir-prod' : ' (ensayo)'}`);

    // 2) Ledger
    const hayLedger = (await q(`SELECT to_regclass('public.knex_migrations') AS t`))[0].t;
    let repartoAplicado = false;
    if (!hayLedger) {
      anotar('migraciones', 'BLOQUEA', 'no existe public.knex_migrations en esta base');
    } else {
      const aplicadas = (await q(`SELECT name FROM public.knex_migrations`)).map((r) => r.name);
      const e = evaluarLedger(aplicadas);
      repartoAplicado = !e.pendientes.includes(CADENA[CADENA.length - 1]);
      if (e.viejas.length) anotar('migraciones', 'BLOQUEA', `aplicadas con el NOMBRE VIEJO (antes del renombre): ${e.viejas.join(', ')} — knex dirá «directory is corrupt»`);
      if (e.colisiones.length) anotar('migraciones', 'BLOQUEA', `otra migración ya aplicada comparte timestamp con la cadena: ${e.colisiones.map((x) => `${x.aplicada} ↔ ${x.choca_con}`).join('; ')} — renombrar la nuestra antes del corte`);
      if (e.fueraDeOrden.length) anotar('migraciones', 'BLOQUEA', `aplicadas fuera de orden (hay una pendiente antes): ${e.fueraDeOrden.join(', ')}`);
      anotar('migraciones', e.pendientes.length ? 'AVISO' : 'OK',
        e.pendientes.length ? `pendientes, EN ESTE ORDEN: ${e.pendientes.join(' → ')}` : `las ${CADENA.length} de la cadena aplicadas`);
      if (e.pendientes.includes(CADENA[0])) {
        anotar('migraciones', 'AVISO', `la base de la Fase CH (${CADENA[0]}) NO está aplicada: va PRIMERO; sin ella las de RH fallan`);
      }
    }

    // 3) Esquema y datos previos en hr.*
    const existentes = new Set((await q(`SELECT table_name FROM information_schema.tables WHERE table_schema = 'hr'`)).map((r) => r.table_name));
    anotar('esquema hr', 'OK', existentes.size ? `tablas presentes: ${TABLAS_HR.filter((t) => existentes.has(t)).join(', ') || '(ninguna de las del corte)'}` : 'el schema hr no existe todavía');
    for (const t of ['attendance_logs', 'attendance_devices', 'device_enrollments', 'employees', 'attendance_incidents', 'attendance_alerts']) {
      if (!existentes.has(t)) continue;
      const [{ n }] = await q(`SELECT count(*)::int AS n FROM hr.${t}`);
      if (t === 'attendance_logs' && n > 0) {
        const tieneSource = (await q(`SELECT 1 FROM information_schema.columns WHERE table_schema='hr' AND table_name='attendance_logs' AND column_name='source'`)).length > 0;
        const por = await q(`SELECT ${tieneSource ? `coalesce(source, '(sin source = Fase CH)')` : `'(sin columna source = Fase CH)'`} AS origen, count(*)::int AS n,
                                    min(punched_local)::text AS desde, max(punched_local)::text AS hasta, count(DISTINCT device_id)::int AS relojes
                               FROM hr.attendance_logs GROUP BY 1 ORDER BY 2 DESC`);
        anotar('datos previos', 'AVISO', `hr.attendance_logs YA tiene ${n} checadas: ${por.map((p) => `${p.origen} ${p.n} (${p.desde?.slice(0, 10)}→${p.hasta?.slice(0, 10)}, ${p.relojes} relojes)`).join('; ')}. La carga cede ante ellas en el mismo sitio (cuadre: ya_en_un_reloj_del_sitio), pero hay que saber de dónde salieron`);
      } else {
        anotar('datos previos', n > 0 ? 'AVISO' : 'OK', `hr.${t}: ${n} filas`);
      }
    }
    if (existentes.has('attendance_devices')) {
      const relojes = await q(`SELECT serial_number, site_code FROM hr.attendance_devices ORDER BY serial_number`);
      if (relojes.length) anotar('datos previos', 'AVISO', `relojes ya registrados (la carga los empata POR SERIE): ${relojes.map((r) => `${r.serial_number}${r.site_code ? `@${r.site_code}` : ''}`).join(', ')}`);
    }

    // 3b) Padrón ligado a personas ([RH.1.4])
    const conUserId = existentes.has('device_enrollments') && (await q(
      `SELECT 1 FROM information_schema.columns WHERE table_schema='hr' AND table_name='device_enrollments' AND column_name='user_id'`)).length > 0;
    if (!conUserId) {
      anotar('padrón', 'NO MEDIDO', 'hr.device_enrollments todavía no tiene user_id (faltan las migraciones de RH)');
    } else {
      const [p] = await q(`
        SELECT count(*)::int AS total, count(*) FILTER (WHERE e.user_id IS NOT NULL)::int AS ligados,
               (SELECT count(DISTINCT (d.site_code, COALESCE(e2.person_code, e2.device_user_id)))::int
                  FROM hr.attendance_logs l
                  JOIN hr.attendance_devices d ON d.tenant_id = l.tenant_id AND d.id = l.device_id
                  JOIN hr.device_enrollments e2 ON e2.tenant_id = l.tenant_id AND e2.device_id = l.device_id AND e2.device_user_id = l.device_user_id
                 WHERE l.punched_at > now() - interval '30 days' AND e2.user_id IS NULL AND e2.match_status <> 'ignorado') AS sin_ligar_recientes
          FROM hr.device_enrollments e WHERE e.match_status <> 'ignorado'`);
      const r = evaluarPadron({ total: p.total, ligados: p.ligados, sinLigarRecientes: p.sin_ligar_recientes });
      anotar('padrón', r.estado, r.detalle);
    }

    // 4) Roles del reparto: que existan y que tengan gente
    for (const [rol, claves] of Object.entries(REPARTO)) {
      const fila = (await q(`SELECT permissions FROM identity.role_permissions WHERE lower(role_name) = $1 AND deleted_at IS NULL LIMIT 1`, [rol]).catch(() => []))[0];
      if (!fila) { anotar('reparto', 'AVISO', `el rol "${rol}" no existe: la migración del reparto no le dará nada`); continue; }
      const [{ n }] = await q(`
        SELECT count(DISTINCT u.id)::int AS n FROM identity.users u
         WHERE u.deleted_at IS NULL AND coalesce(u.status, 'active') = 'active' AND (lower(u.role_name) = $1
            OR EXISTS (SELECT 1 FROM identity.user_roles ur WHERE ur.user_id = u.id AND lower(ur.role_name) = $1))`, [rol])
        .catch(async () => q(`SELECT count(*)::int AS n FROM identity.users WHERE deleted_at IS NULL AND lower(role_name) = $1`, [rol]));
      const perms = fila.permissions || {};
      const conTrue = claves.filter((k) => perms[k] === true);
      const enFalse = claves.filter((k) => perms[k] === false);
      const faltanClaves = repartoAplicado && conTrue.length < claves.length;
      anotar('reparto', n === 0 || faltanClaves || enFalse.length ? 'AVISO' : 'OK',
        `${rol}: ${n} persona(s)${n === 0 ? ' — las pantallas de RH no le llegan a nadie por este rol' : ''}; ` +
        `claves en true ${conTrue.length}/${claves.length}${repartoAplicado ? '' : ' (el reparto todavía no se aplica)'}` +
        `${enFalse.length ? `; en FALSE explícito (la migración NO las pisa): ${enFalse.join(', ')}` : ''}`);
    }

    // 5) Variables de entorno de ESTE proceso (sólo si existen; nunca el valor)
    const tiene = (k) => typeof env[k] === 'string' && env[k].trim() !== '';
    anotar('entorno', tiene('HR_INGEST_KEY') ? 'OK' : 'AVISO',
      tiene('HR_INGEST_KEY') ? 'HR_INGEST_KEY presente' : 'HR_INGEST_KEY NO está: la ingesta responde 401 y el agente no puede entregar (se agrega en el secreto prod-env)');
    anotar('entorno', 'OK', `ENABLE_HR_ATTENDANCE_AGENT=${env.ENABLE_HR_ATTENDANCE_AGENT === 'true' ? 'true (ENCENDIDO)' : 'apagado'} en este proceso` +
      ' — el agente corre en el WORKER; si este es el pod de api, lo que cuenta es el valor del worker (mismo secreto prod-env)');
    if (!exigirProd) anotar('entorno', 'NO MEDIDO', 'sin --exigir-prod: el entorno revisado es el de esta máquina, no el del pod');

    // 6) Latidos ya existentes
    const hayCron = (await q(`SELECT to_regclass('analytics.cron_runs') AS t`))[0].t;
    if (hayCron) {
      // Una fila por job (`latirCron` la pisa en cada corrida): el último latido y su estado.
      const lat = await q(`SELECT job_key, last_finish::text AS ultimo, status FROM analytics.cron_runs WHERE job_key = ANY($1) ORDER BY 1`, [JOBS]);
      anotar('latidos', 'OK', lat.length ? lat.map((l) => `${l.job_key}: último ${l.ultimo} (${l.status})`).join('; ') : 'ningún latido de RH todavía (esperado antes del corte)');
    } else {
      anotar('latidos', 'NO MEDIDO', 'no existe analytics.cron_runs en esta base');
    }

    // 7) Candados y transacciones largas: no aplicar con alguien a media migración
    const largas = await q(`SELECT pid, usename, (now() - xact_start)::text AS dura, left(coalesce(query, '-'), 60) AS q
                              FROM pg_stat_activity WHERE xact_start IS NOT NULL AND pid <> pg_backend_pid()
                               AND datname = current_database() AND now() - xact_start > interval '2 minutes' ORDER BY xact_start`);
    anotar('actividad', largas.length ? 'AVISO' : 'OK', largas.length
      ? `transacciones de más de 2 min: ${largas.map((l) => `pid ${l.pid} ${l.usename || '?'} ${l.dura.split('.')[0]} «${l.q}»`).join(' | ')}`
      : 'sin transacciones largas en curso');

    // 8) Horario
    anotar('horario', enHorarioHabil(ahora) ? 'AVISO' : 'OK', enHorarioHabil(ahora)
      ? 'es horario hábil en México: la carga escribe ~215 mil filas y reiniciar pods corta conexiones — hacerlo fuera de horario'
      : 'fuera de horario hábil');
  } finally {
    await c.end().catch(() => undefined);
  }

  // 9) Mega Talento (opcional): ¿el pod lo alcanza, en sólo lectura?
  if (!mtUrl) {
    anotar('mega talento', 'NO MEDIDO', 'sin MT_DATABASE_URL: no se comprobó que este proceso alcance la base de Mega Talento (la carga la necesita)');
  } else {
    const m = new (require('pg').Client)({ connectionString: `${mtUrl}${mtUrl.includes('?') ? '&' : '?'}options=-c%20default_transaction_read_only%3Don`, ssl: { rejectUnauthorized: false } });
    try {
      await m.connect();
      const ro = (await m.query('SHOW transaction_read_only')).rows[0].transaction_read_only;
      const [{ checadas, sin_reloj }] = (await m.query(`SELECT count(*)::int AS checadas, count(*) FILTER (WHERE serie_reloj IS NULL)::int AS sin_reloj FROM checadas`)).rows;
      anotar('mega talento', ro === 'on' ? 'OK' : 'BLOQUEA', `alcanzable, sólo lectura=${ro}; ${checadas} checadas (${sin_reloj} sin reloj)`);
    } catch (e) {
      anotar('mega talento', 'BLOQUEA', `no se pudo leer: ${String(e.message).replace(/postgres(ql)?:\/\/\S+/g, '<url>')}`);
    } finally {
      await m.end().catch(() => undefined);
    }
  }
  return out;
}

function imprimir(revisiones) {
  const sello = { OK: '✓', AVISO: '!', BLOQUEA: '✗', 'NO MEDIDO': '?' };
  console.log('\nPre-vuelo del corte de asistencia (sólo lectura)\n');
  for (const r of revisiones) console.log(`  ${sello[r.estado]} [${r.estado}] ${r.area}: ${r.detalle}`);
  const v = veredicto(revisiones);
  console.log(`\n${v.ok ? 'SIN BLOQUEOS' : `${v.bloquea} BLOQUEO(S)`} · ${v.avisos} aviso(s) · ${v.noMedido} sin medir`);
  return v;
}

if (require.main === module) {
  try { require('dotenv').config({ path: require('path').resolve(__dirname, '../../../.env') }); } catch { /* en el pod no hay dotenv ni .env */ }
  const url = process.env.PREVUELO_URL;
  if (!url) {
    console.error('Falta PREVUELO_URL (dentro del pod: PREVUELO_URL="$DATABASE_URL_NEW"). Ver la cabecera.');
    process.exit(1);
  }
  revisar({ url, mtUrl: process.env.MT_DATABASE_URL || null, exigirProd: process.argv.includes('--exigir-prod') })
    .then((r) => process.exit(imprimir(r).ok ? 0 : 1))
    .catch((e) => { console.error('FALLA:', String(e.message).replace(/postgres(ql)?:\/\/\S+/g, '<url>')); process.exit(1); });
}

module.exports = { PROD_CLUSTER_ID, CADENA, NOMBRES_VIEJOS, REPARTO, evaluarLedger, evaluarPadron, enHorarioHabil, veredicto, revisar };
