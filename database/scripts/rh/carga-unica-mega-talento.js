'use strict';
/**
 * Fase RH · `[RH.1.8]` (preparación) — CARGA ÚNICA de la asistencia de Mega Talento a `hr.*`.
 *
 * No es un importer (CLAUDE.md, regla principal): corre UNA vez, en el corte, y verifica lo que
 * movió (ADR-084 D3). Mientras tanto corre en ENSAYO: carga dentro de una transacción, imprime el
 * cuadre y la deshace. Así se mide antes de comprometer nada.
 *
 *   MT_DATABASE_URL=… DATABASE_URL_NEW=… node database/scripts/rh/carga-unica-mega-talento.js            # ensayo
 *   MT_DATABASE_URL=… DATABASE_URL_NEW=… node database/scripts/rh/carga-unica-mega-talento.js --aplicar  # deja lo cargado
 *
 * La base de Mega Talento se abre en SÓLO LECTURA (`default_transaction_read_only=on`) y el script
 * aborta si la sesión no lo confirma.
 *
 * El DESTINO tiene dos caminos, y ninguno es por omisión hacia prod:
 *   · desarrollo (por omisión): `DATABASE_URL_NEW` + `assert-safe-target`, que rechaza prod.
 *   · `--destino-prod` (el corte, `[RH.1.8]`): corre DENTRO del pod `api` con
 *     `CARGA_URL="$DATABASE_URL_NEW"` y exige (1) que el clúster sea el de prod (misma identidad que
 *     `apply-one-migration-prod.js`) y (2) que la cadena de migraciones ya esté aplicada. Sigue siendo
 *     ENSAYO salvo `--aplicar`. El paso a paso está en `docs/IMPLEMENTACION/RUNBOOKS/RH_CORTE_ASISTENCIA.md`.
 *     ⚠️ La imagen de prod no trae `libs/`: por eso este modo no usa `assert-safe-target`.
 *
 * ── Lo que se medía antes de escribir esto (2026-10-07) ──────────────────────────────────────
 *   · 214,784 checadas, y la mayoría SIN reloj de origen (`serie_reloj` NULL: 8-Esquinas 50,688
 *     de 56,652). Son de cargas viejas. No se les inventa reloj: van a un reloj DESCONOCIDO por
 *     sitio (`MT-SIN-RELOJ-<sitio>`, inactivo, nunca recibe ingesta). Pegarlas al reloj real del
 *     sitio sería adivinar, y donde un reloj traduce códigos las atribuiría a otra persona.
 *   · Sólo el reloj de comida de corporativo traduce códigos (`reloj_codigo_map`, 41, sin choques):
 *     su checada vuelve a su código CRUDO en el reloj y el enrolamiento lleva el código del sitio.
 *   · 8 checadas de `corporativo-comida` tienen la serie de un reloj que hoy es de `corporativo`:
 *     manda el sitio de Mega Talento, así que van al reloj desconocido de su sitio.
 *   · `padron_depurado` (501) es una BAJA: la persona sale de la medición y vuelve si su número
 *     checa otra vez. En la Suite es `match_status = 'ignorado'` (mismo efecto en el reporte).
 *   · `asistencia_revision` y `asistencia_cierres` tienen 0 filas; `asistencia_alertas` 10,429 y
 *     NINGUNA decidida. Se cargan igual: el cuadre las cuenta.
 *
 * Lo que NO hace: crear personas (`identity.users`) — eso es `[RH.1.4]`, con los mapeos de RH.
 * Hasta entonces el padrón queda en los enrolamientos y el reporte marca `fuera_del_padron`.
 *
 * ── Duplicados con el histórico (resuelto 2026-10-07, `[RH.1.8]`) ───────────────────────────────
 * Esta cabecera decía que prod «ya tiene ~129 mil checadas de la Fase CH». **Era falso:** CH cargó sus
 * 129,461 en su base DEDICADA `hr` de `.245` (`knexfile-hr.js`; `[CH.0.5]` se validó en local y
 * `[CH.0.9]` «aplicar a Railway» nunca se hizo). No se pudo leer prod desde la máquina de trabajo para
 * confirmarlo, así que la carga NO depende de eso: una checada del reloj desconocido CEDE ante la misma
 * (sitio, persona, hora de pared) en un reloj real del destino — venga de esta carga, de CH o de la
 * ingesta viva. Lo que se descarta así sale en el cuadre como `ya_en_un_reloj_del_sitio`.
 * El riesgo real estaba del otro lado: un lector sin marca de agua reenvía el buffer completo del
 * reloj (años) con su serie. Eso lo frena la ingesta (`insertPunches`), con el mismo puente que ya
 * tenía Mega Talento. Medido: Mega Talento tiene 0 gemelas al segundo entre lo que trae reloj y lo
 * que no (corte limpio el 5-ago-2026: antes todo sin reloj, después todo con serie).
 */
const path = require('path');
const crypto = require('crypto');

const TENANT_MD = '00000000-0000-0000-0000-00000000d01c';
/** La misma regla que la ingesta: una fecha anterior es la de un reloj sin hora (2000-01-01). */
const FECHA_MINIMA = '2001-01-01';
const LOTE = 5000;
/**
 * La identidad del clúster de PROD. COPIA de `apply-one-migration-prod.js` (la fuente): este archivo
 * se ejecuta solo dentro del pod y no puede requerir otro script. `corte-scripts.spec.ts` exige que
 * las copias coincidan.
 */
const PROD_CLUSTER_ID = '7688376744939610156';
/** La base de la Fase CH: las de RH la extienden. En prod la carga exige que esté aplicada. */
const MIGRACION_BASE_CH = '20260817220000_hr_attendance';
/** Las migraciones de la fase RH que la carga necesita. */
const MIGRACIONES_FASE = [
  '20261007100000_hr_relojes_y_checadas',
  '20261007110000_hr_horarios_y_alertas',
  '20261007304401_hr_incidencias_y_cierres',
  '20261007310000_hr_agente_corridas',
  '20261007320000_hr_ordenes_quien',
];

const limpio = (v) => String(v ?? '').trim();
const RE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Corre `fn` en un savepoint: si falla, lo deshace y devuelve el motivo en vez de tumbar la carga. */
async function conSavepoint(trx, fn) {
  await trx.raw('SAVEPOINT carga_fila');
  try {
    await fn();
    await trx.raw('RELEASE SAVEPOINT carga_fila');
    return null;
  } catch (e) {
    await trx.raw('ROLLBACK TO SAVEPOINT carga_fila');
    return e.constraint || e.code || 'error';
  }
}
const serieDesconocida = (sitio) => `MT-SIN-RELOJ-${sitio}`;

/** Conecta a Mega Talento en sólo lectura, y lo comprueba. */
async function conectarMegaTalento(url) {
  const { Client } = require('pg');
  if (!url) throw new Error('Falta MT_DATABASE_URL.');
  const sep = url.includes('?') ? '&' : '?';
  const c = new Client({
    connectionString: `${url}${sep}options=-c%20default_transaction_read_only%3Don`,
    ssl: /localhost|127\.0\.0\.1/.test(url) ? undefined : { rejectUnauthorized: false },
  });
  await c.connect();
  const ro = (await c.query('SHOW default_transaction_read_only')).rows[0].default_transaction_read_only;
  if (ro !== 'on') { await c.end(); throw new Error('La conexión a Mega Talento NO quedó en sólo lectura: no sigo.'); }
  return c;
}

/** Inserta en lotes con jsonb_to_recordset; devuelve cuántas entraron. */
async function insertarLotes(trx, filas, sql) {
  let n = 0;
  for (let i = 0; i < filas.length; i += LOTE) {
    const r = await trx.raw(sql, [JSON.stringify(filas.slice(i, i + LOTE))]);
    n += r.rowCount || 0;
  }
  return n;
}

/**
 * Carga todo dentro de `trx` (ya con `app.tenant_id` puesto). Devuelve el cuadre: por tabla,
 * cuánto había en Mega Talento, cuánto entró, y lo que no entró con su motivo.
 *
 * `recibidasHasta` (ISO): deja fuera las checadas que llegaron DESPUÉS de esa hora. Sirve para
 * comparar contra una foto de Mega Talento tomada en ese instante (la paridad); en el corte va vacío.
 */
async function cargarMegaTalento(trx, mt, { tenantId = TENANT_MD, log = null, recibidasHasta = null } = {}) {
  if (!RE_UUID.test(tenantId)) throw new Error(`tenant inválido: ${tenantId}`);
  const avisar = typeof log === 'function' ? log : null;
  const q = async (sql, params = []) => (await mt.query(sql, params)).rows;
  const cuadre = {};
  const anotar = (tabla, origen, cargadas, descartes = {}) => {
    cuadre[tabla] = { origen, cargadas, descartes };
    if (avisar) avisar(`  ${tabla}: ${cargadas} de ${origen}${Object.keys(descartes).length ? ` · fuera: ${JSON.stringify(descartes)}` : ''}`);
  };

  // ── Sitios ─────────────────────────────────────────────────────────────────────────────
  const relojes = await q(`SELECT serie, sucursal_id, alias, ip, puerto, modo, comm_key, activo, pendiente, nota FROM relojes`);
  const sitiosMt = (await q(`
    SELECT sucursal_id FROM relojes UNION SELECT sucursal_id FROM checadas
    UNION SELECT sucursal_id FROM empleados UNION SELECT sucursal_id FROM asistencia_incidencias
    UNION SELECT sucursal_id FROM horarios_sucursal`)).map((r) => limpio(r.sucursal_id)).filter(Boolean);
  const nombreSitio = (s) => {
    const als = relojes.filter((r) => r.sucursal_id === s).map((r) => r.alias).filter(Boolean);
    if (als.length === 1) return als[0];
    return s.split('-').map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join(' ');
  };
  for (const s of sitiosMt) {
    await trx('hr.attendance_sites').insert({
      tenant_id: tenantId, code: s, name: nombreSitio(s),
      notes: 'Cargado de Mega Talento. warehouse_code pendiente de validar con RH ([RH.0.4]).',
    }).onConflict(['tenant_id', 'code']).ignore();
  }
  anotar('attendance_sites', sitiosMt.length, sitiosMt.length);

  // ── Relojes: los reales, y uno DESCONOCIDO por sitio ───────────────────────────────────
  const devPorSerie = new Map();
  for (const r of relojes) {
    const [d] = await trx('hr.attendance_devices').insert({
      tenant_id: tenantId, serial_number: r.serie, label: r.alias, site_code: limpio(r.sucursal_id),
      ip_address: r.ip, port: r.puerto || 4370, comm_key: r.comm_key || 0,
      is_active: r.activo !== false, is_paused: r.pendiente === true, notes: r.nota,
      ingest_mode: ['agente', 'push', 'manual'].includes(r.modo) ? r.modo : 'agente',
    }).onConflict(['tenant_id', 'serial_number']).merge(['label', 'site_code', 'ip_address', 'port', 'comm_key']).returning(['id', 'site_code']);
    devPorSerie.set(r.serie, d);
  }
  const desconocido = new Map();
  for (const s of sitiosMt) {
    const [d] = await trx('hr.attendance_devices').insert({
      tenant_id: tenantId, serial_number: serieDesconocida(s), label: `${nombreSitio(s)} · reloj desconocido`,
      site_code: s, is_active: false, is_paused: true, ingest_mode: 'manual',
      notes: 'No es un reloj: agrupa el padrón y las checadas de Mega Talento sin reloj de origen. Nunca recibe ingesta.',
    }).onConflict(['tenant_id', 'serial_number']).merge(['label']).returning(['id', 'site_code']);
    desconocido.set(s, d.id);
  }
  anotar('attendance_devices', relojes.length, relojes.length);
  if (avisar) avisar(`  (+ ${sitiosMt.length} relojes desconocidos, uno por sitio: no son equipos, agrupan lo que no trae reloj)`);

  // ── Traducción de códigos y bajas ──────────────────────────────────────────────────────
  const mapa = await q(`SELECT serie, btrim(codigo_reloj) AS crudo, btrim(codigo_empleado) AS codigo FROM reloj_codigo_map`);
  const crudoDe = new Map(mapa.map((m) => [`${m.serie}|${m.codigo}`, m.crudo]));          // (serie, código del sitio) → código crudo
  const codigoDeCrudo = new Map(mapa.map((m) => [`${m.serie}|${m.crudo}`, m.codigo]));
  // Una lápida de `padron_depurado` sólo cuenta si la ficha NO está activa: Mega Talento mide por
  // `empleados.activo`, y hay fichas reactivadas a mano con la lápida todavía puesta (medido: 1).
  const depurados = new Set((await q(`
    SELECT d.sucursal_id, btrim(d.codigo_checador) AS c FROM padron_depurado d
     WHERE NOT EXISTS (SELECT 1 FROM empleados e WHERE e.sucursal_id = d.sucursal_id
                         AND btrim(e.codigo_checador) = btrim(d.codigo_checador) AND e.activo)`)).map((d) => `${d.sucursal_id}|${d.c}`));

  // ── Enrolamientos: el padrón (en el reloj desconocido) y lo que checó en cada reloj real ──
  const enr = new Map();   // `${deviceId}|${crudo}` → fila
  const conflictos = { codigo_crudo_con_dos_personas: 0 };
  const enrolar = (deviceId, crudo, codigoSitio, sitio, nombre) => {
    const k = `${deviceId}|${crudo}`;
    const prev = enr.get(k);
    if (prev) {
      if ((prev.person_code || prev.device_user_id) !== codigoSitio) { conflictos.codigo_crudo_con_dos_personas++; return false; }
      if (!prev.device_name && nombre) prev.device_name = nombre;
      return true;
    }
    enr.set(k, {
      device_id: deviceId, device_user_id: crudo, person_code: crudo === codigoSitio ? null : codigoSitio,
      device_name: nombre || null, match_status: depurados.has(`${sitio}|${codigoSitio}`) ? 'ignorado' : 'pendiente',
    });
    return true;
  };
  const empleados = await q(`SELECT sucursal_id, btrim(codigo_checador) AS codigo, nombre FROM empleados WHERE btrim(coalesce(codigo_checador,'')) <> ''`);
  for (const e of empleados) enrolar(desconocido.get(e.sucursal_id), e.codigo, e.codigo, e.sucursal_id, e.nombre);

  // ── Checadas, sitio por sitio ──────────────────────────────────────────────────────────
  let origenChecadas = 0, cargadasChecadas = 0;
  const descChecadas = { fecha_basura: 0, duplicada_en_destino: 0, ya_en_un_reloj_del_sitio: 0 };
  for (const s of sitiosMt) {
    const filas = await q(
      `SELECT btrim(empleado_codigo) AS codigo, empleado_nombre AS nombre, fecha_hora, fecha, tipo, serie_reloj
         FROM checadas
        WHERE sucursal_id = $1
          AND ($2::timestamptz IS NULL OR coalesce(recibido_en, importado_en) IS NULL OR coalesce(recibido_en, importado_en) <= $2)`,
      [s, recibidasHasta]);
    origenChecadas += filas.length;
    const logs = [];
    for (const f of filas) {
      if (!f.codigo) continue;
      if (String(f.fecha) < FECHA_MINIMA) { descChecadas.fecha_basura++; continue; }
      const real = f.serie_reloj ? devPorSerie.get(f.serie_reloj) : null;
      let deviceId, crudo;
      if (real && real.site_code === s) {
        deviceId = real.id;
        crudo = crudoDe.get(`${f.serie_reloj}|${f.codigo}`) || f.codigo;
        // Un código crudo que el mapa manda a OTRA persona no puede ser de ésta: reloj desconocido.
        const destino = codigoDeCrudo.get(`${f.serie_reloj}|${crudo}`);
        if (destino && destino !== f.codigo) { deviceId = desconocido.get(s); crudo = f.codigo; }
      } else {
        deviceId = desconocido.get(s);
        crudo = f.codigo;
      }
      if (!enrolar(deviceId, crudo, f.codigo, s, f.nombre)) { deviceId = desconocido.get(s); crudo = f.codigo; enrolar(deviceId, crudo, f.codigo, s, f.nombre); }
      logs.push({ d: deviceId, u: crudo, l: String(f.fecha_hora).replace(' ', 'T').slice(0, 19), t: f.tipo });
    }
    // Primero las que traen su reloj; después las del reloj desconocido, que CEDEN ante una checada
    // del mismo sitio, persona e instante que ya esté en un reloj real (de esta carga, de la Fase CH si
    // el destino la tuviera, o de la ingesta viva si la carga corre tarde). Es el mismo puente que la
    // ingesta (`insertPunches`) aplica en sentido contrario. Medido 2026-10-07: Mega Talento tiene CERO
    // gemelas al segundo, así que en una base vacía esto no descarta nada — protege el destino que no
    // se pudo medir desde aquí (prod).
    const desc = desconocido.get(s);
    const reales = logs.filter((x) => x.d !== desc);
    const sinReloj = logs.filter((x) => x.d === desc);
    const nReales = await insertarLotes(trx, reales, `
      INSERT INTO hr.attendance_logs (tenant_id, device_id, device_user_id, punched_at, punched_local, punch_type, source)
      SELECT '${tenantId}'::uuid, x.d, x.u, (x.l::timestamp AT TIME ZONE dv.timezone), x.l::timestamp, x.t, 'carga_unica'
        FROM jsonb_to_recordset(?::jsonb) AS x(d uuid, u text, l text, t smallint)
        JOIN hr.attendance_devices dv ON dv.id = x.d
      ON CONFLICT DO NOTHING`);
    // Los relojes REALES del sitio en el destino (de esta carga, de CH o dados de alta a mano). Se pasan
    // como lista para entrar por el índice (tenant, reloj, instante): con un EXISTS que los buscaba por
    // sitio, cada lote de 5,000 tardaba ~15 s (medido; el ensayo pasó de ~20 s a más de 10 min).
    // El instante se compara con la zona del reloj desconocido; los relojes de la empresa están todos en
    // la zona de México, y la hora de pared se compara además textual (si un día no coinciden las zonas,
    // el puente deja pasar — duplica, nunca borra ni atribuye mal).
    const relojesDelSitio = (await trx('hr.attendance_devices').where({ site_code: s }).whereNot({ id: desc }).pluck('id'));
    let yaEnReloj = 0, nSinReloj = 0;
    for (let i = 0; i < sinReloj.length; i += LOTE) {
      const r = await trx.raw(`
        WITH x AS (
          SELECT x.d, x.u, x.l, x.t, (x.l::timestamp AT TIME ZONE dv.timezone) AS at
            FROM jsonb_to_recordset(?::jsonb) AS x(d uuid, u text, l text, t smallint)
            JOIN hr.attendance_devices dv ON dv.id = x.d
        ), m AS (
          SELECT x.*, EXISTS (
            SELECT 1 FROM hr.attendance_logs r
              LEFT JOIN hr.device_enrollments re
                ON re.tenant_id = r.tenant_id AND re.device_id = r.device_id AND re.device_user_id = r.device_user_id
             WHERE r.tenant_id = '${tenantId}'::uuid AND r.device_id = ANY(?::uuid[])
               AND r.punched_at = x.at AND r.punched_local = x.l::timestamp
               AND COALESCE(re.person_code, r.device_user_id) = x.u) AS ya
            FROM x
        ), ins AS (
          INSERT INTO hr.attendance_logs (tenant_id, device_id, device_user_id, punched_at, punched_local, punch_type, source)
          SELECT '${tenantId}'::uuid, m.d, m.u, m.at, m.l::timestamp, m.t, 'carga_unica' FROM m WHERE NOT m.ya
          ON CONFLICT DO NOTHING
          RETURNING 1
        )
        SELECT (SELECT count(*)::int FROM m WHERE m.ya) AS ya, (SELECT count(*)::int FROM ins) AS n`,
        [JSON.stringify(sinReloj.slice(i, i + LOTE)), relojesDelSitio]);
      yaEnReloj += r.rows[0].ya;
      nSinReloj += r.rows[0].n;
    }
    cargadasChecadas += nReales + nSinReloj;
    descChecadas.ya_en_un_reloj_del_sitio += yaEnReloj;
    descChecadas.duplicada_en_destino += (reales.length - nReales) + (sinReloj.length - yaEnReloj - nSinReloj);
  }

  // Los enrolamientos se escriben DESPUÉS de las checadas para que traigan todos los nombres.
  const filasEnr = [...enr.values()];
  const nEnr = await insertarLotes(trx, filasEnr, `
    INSERT INTO hr.device_enrollments (tenant_id, device_id, device_user_id, person_code, device_name, match_status, match_reason)
    SELECT '${tenantId}'::uuid, x.device_id, x.device_user_id, x.person_code, x.device_name, x.match_status,
           CASE WHEN x.match_status = 'ignorado' THEN 'padron_depurado de Mega Talento' END
      FROM jsonb_to_recordset(?::jsonb) AS x(device_id uuid, device_user_id text, person_code text, device_name text, match_status text)
    ON CONFLICT (tenant_id, device_id, device_user_id) DO NOTHING`);
  anotar('device_enrollments', filasEnr.length, nEnr, filasEnr.length - nEnr ? { ya_existian: filasEnr.length - nEnr } : {});
  anotar('attendance_logs', origenChecadas, cargadasChecadas, Object.fromEntries(Object.entries(descChecadas).filter(([, v]) => v)));
  if (conflictos.codigo_crudo_con_dos_personas) {
    if (avisar) avisar(`  (${conflictos.codigo_crudo_con_dos_personas} checadas cuyo código crudo ya era de otra persona en su reloj: cargadas en el reloj desconocido del sitio)`);
  }

  // ── Órdenes a los relojes (con los RESPALDOS que permiten restaurar a alguien) ───────────
  // Mega Talento guardaba el código del SITIO; aquí cada orden lleva el código CRUDO de su reloj
  // (es el que usa el agente para encontrar a la persona en el equipo).
  const ordenes = await q(`SELECT *, btrim(empleado_codigo) AS codigo FROM reloj_comandos ORDER BY creado_en`);
  const TIPO = { borrar_usuario: 'borrar', renombrar_usuario: 'renombrar', restaurar_usuario: 'restaurar' };
  const descOrd = {};
  const filasOrd = [];
  for (const c of ordenes) {
    const d = devPorSerie.get(c.serie);
    const orden = TIPO[c.tipo];
    if (!d) { descOrd.reloj_no_registrado = (descOrd.reloj_no_registrado || 0) + 1; continue; }
    if (!orden) { descOrd.tipo_desconocido = (descOrd.tipo_desconocido || 0) + 1; continue; }
    const terminada = ['hecho', 'error', 'cancelado'].includes(c.estado);
    filasOrd.push({
      device_id: d.id, device_user_id: crudoDe.get(`${c.serie}|${c.codigo}`) || c.codigo, command: orden,
      payload: c.payload || {}, status: c.estado, attempts: Math.min(Number(c.intentos) || 0, 3), detail: c.detalle,
      backup: c.respaldo, requested_by_name: c.creado_por, requested_at: c.creado_en,
      completed_at: terminada ? (c.actualizado_en || c.creado_en) : null, updated_at: c.actualizado_en || c.creado_en,
    });
  }
  const nOrd = await insertarLotes(trx, filasOrd, `
    INSERT INTO hr.device_commands (tenant_id, device_id, device_user_id, command, payload, status, attempts, detail,
           backup, requested_by_name, requested_at, completed_at, updated_at)
    SELECT '${tenantId}'::uuid, x.device_id, x.device_user_id, x.command, x.payload, x.status, x.attempts, x.detail,
           x.backup, x.requested_by_name, x.requested_at, x.completed_at, x.updated_at
      FROM jsonb_to_recordset(?::jsonb) AS x(device_id uuid, device_user_id text, command text, payload jsonb, status text,
           attempts int, detail text, backup jsonb, requested_by_name text, requested_at timestamptz,
           completed_at timestamptz, updated_at timestamptz)`);
  anotar('device_commands', ordenes.length, nOrd, descOrd);

  // ── Horarios y reglas ──────────────────────────────────────────────────────────────────
  const horarios = await q(`SELECT * FROM horarios_sucursal`);
  let nH = 0;
  for (const h of horarios) {
    const conComida = !!(h.inicio_comida && h.fin_comida);
    await trx('hr.work_schedules').insert({
      id: h.id, tenant_id: tenantId, site_code: limpio(h.sucursal_id), name: h.nombre, weekdays: h.dias || [],
      starts_at: h.entrada, ends_at: h.salida,
      lunch_starts_at: conComida ? h.inicio_comida : null, lunch_ends_at: conComida ? h.fin_comida : null,
      tolerance_minutes: h.tolerancia_min || 0, is_active: h.activo !== false, created_at: h.creado_en,
    }).onConflict(['id']).ignore();
    nH++;
  }
  anotar('work_schedules', horarios.length, nH);

  const confirmados = await q(`SELECT * FROM horarios_confirmados`);
  const conTurnoDeSitio = await q(`SELECT sucursal_id, btrim(codigo_checador) AS codigo, horario_id FROM empleados WHERE horario_id IS NOT NULL`);
  let nPs = 0;
  const descPs = {};
  for (const c of confirmados) {
    const turnos = (Array.isArray(c.turnos) ? c.turnos : String(c.turnos || '').split(',')).map(limpio).filter(Boolean);
    const sab = !!c.sabado;
    const turnoSitio = conTurnoDeSitio.find((e) => e.sucursal_id === c.sucursal_id && e.codigo === limpio(c.empleado_codigo));
    const malo = await conSavepoint(trx, () => trx('hr.person_schedules').insert({
      tenant_id: tenantId, site_code: limpio(c.sucursal_id), person_code: limpio(c.empleado_codigo),
      shift_starts: trx.raw('?::time[]', [`{${turnos.join(',')}}`]), schedule_id: turnoSitio?.horario_id || null,
      ends_at: c.salida || null, lunch_minutes: c.comida_min ?? null, works_saturday: sab,
      saturday_starts_at: sab ? c.sabado_entrada || null : null, saturday_ends_at: sab ? c.sabado_salida || null : null,
      note: c.nota, confirmed_by_name: c.confirmado_por, created_at: c.creado_en, updated_at: c.actualizado_en || c.creado_en,
    }).onConflict(['tenant_id', 'site_code', 'person_code']).ignore());
    if (malo) descPs[malo] = (descPs[malo] || 0) + 1; else nPs++;
  }
  for (const e of conTurnoDeSitio) {
    if (confirmados.some((c) => c.sucursal_id === e.sucursal_id && limpio(c.empleado_codigo) === e.codigo)) continue;
    await trx('hr.person_schedules').insert({
      tenant_id: tenantId, site_code: e.sucursal_id, person_code: e.codigo, schedule_id: e.horario_id,
      note: 'Turno de sitio asignado en Mega Talento (empleados.horario_id).',
    }).onConflict(['tenant_id', 'site_code', 'person_code']).ignore();
    nPs++;
  }
  anotar('person_schedules', confirmados.length + conTurnoDeSitio.length, nPs, descPs);

  const config = await q(`SELECT sucursal_id, config FROM asistencia_config`);
  for (const c of config) {
    await trx.raw(`
      INSERT INTO hr.attendance_rules (tenant_id, site_code, config) VALUES (?, ?, ?::jsonb)
      ON CONFLICT (tenant_id, (COALESCE(site_code, ''))) DO NOTHING`,
      [tenantId, c.sucursal_id === '__global__' ? null : c.sucursal_id, JSON.stringify(c.config || {})]);
  }
  anotar('attendance_rules', config.length, config.length);

  // ── Incidencias y su bitácora (una por una: el CHECK que no se cumpla queda contado) ─────
  // Fechas como texto: un `date` convertido en JS se corre un día en México (GOTCHAS, LC.16).
  const incidencias = await q(`SELECT *, to_char(desde, 'YYYY-MM-DD') AS desde_t, to_char(hasta, 'YYYY-MM-DD') AS hasta_t FROM asistencia_incidencias`);
  const descInc = {};
  let nInc = 0;
  for (const i of incidencias) {
    const malo = await conSavepoint(trx, () => trx('hr.attendance_incidents').insert({
        id: i.id, tenant_id: tenantId, site_code: limpio(i.sucursal_id), person_code: limpio(i.empleado_codigo),
        incident_type: i.tipo, date_from: i.desde_t, date_to: i.hasta_t, minutes: i.minutos, note: i.nota,
        status: i.estado || 'calificada', authorized_by_name: i.autorizo, base_schedule_minutes: i.horario_base_min,
        created_by_name: i.creado_por, created_at: i.creado_en,
        rated_by_name: i.calificado_por, rated_at: i.calificado_en, rejection_reason: i.motivo_rechazo,
        audited_by_name: i.auditado_por, audited_at: i.auditado_en, audit_note: i.nota_auditoria,
        voided_by_name: i.anulado_por, voided_at: i.anulado_en, void_reason: i.motivo_anulacion,
      }));
    if (malo) descInc[malo] = (descInc[malo] || 0) + 1; else nInc++;
  }
  anotar('attendance_incidents', incidencias.length, nInc, descInc);

  const bitacora = await q(`SELECT b.* FROM asistencia_incidencias_bitacora b ORDER BY b.cuando, b.id`);
  const filasBit = bitacora.map((b) => ({
    id: crypto.randomUUID(), incident_id: b.incidencia_id, action: b.accion, status_before: b.estado_antes,
    status_after: b.estado_despues, actor_name: b.quien, acted_at: b.cuando, detail: b.detalle, row_snapshot: b.fila,
  }));
  const nBit = await insertarLotes(trx, filasBit, `
    INSERT INTO hr.attendance_incident_log (id, tenant_id, incident_id, action, status_before, status_after, actor_name, acted_at, detail, row_snapshot)
    SELECT x.id, '${tenantId}'::uuid, x.incident_id, x.action, x.status_before, x.status_after, x.actor_name, x.acted_at, x.detail, x.row_snapshot
      FROM jsonb_to_recordset(?::jsonb) AS x(id uuid, incident_id uuid, action text, status_before text, status_after text,
           actor_name text, acted_at timestamptz, detail text, row_snapshot jsonb)
     WHERE EXISTS (SELECT 1 FROM hr.attendance_incidents i WHERE i.id = x.incident_id)`);
  anotar('attendance_incident_log', bitacora.length, nBit, bitacora.length - nBit ? { de_incidencia_no_cargada: bitacora.length - nBit } : {});

  // ── Cierres, revisiones y alertas ──────────────────────────────────────────────────────
  const cierres = await q(`SELECT *, to_char(desde, 'YYYY-MM-DD') AS desde_t, to_char(hasta, 'YYYY-MM-DD') AS hasta_t FROM asistencia_cierres`);
  const descCi = {};
  let nCi = 0;
  for (const c of cierres) {
    const malo = await conSavepoint(trx, () => trx('hr.attendance_closures').insert({
      id: c.id, tenant_id: tenantId, site_code: c.sucursal_id, period_start: c.desde_t, period_end: c.hasta_t,
      closed_by_name: c.cerrado_por, closed_at: c.cerrado_en, summary: c.resumen, snapshot: c.foto || {},
      reopened_by_name: c.reabierto_por, reopened_at: c.reabierto_en, reopen_reason: c.motivo_reapertura,
    }));
    if (malo) descCi[malo] = (descCi[malo] || 0) + 1; else nCi++;
  }
  anotar('attendance_closures', cierres.length, nCi, descCi);

  const revisiones = await q(`SELECT * FROM asistencia_revision`);
  for (const r of revisiones) {
    await trx('hr.attendance_reviews').insert({
      tenant_id: tenantId, site_code: r.sucursal_id, person_code: limpio(r.empleado_codigo), work_date: r.fecha,
      justification: r.justificacion, status: r.estado || 'pendiente', updated_at: r.actualizado_en || trx.fn.now(),
    }).onConflict(['tenant_id', 'site_code', 'person_code', 'work_date']).ignore();
  }
  anotar('attendance_reviews', revisiones.length, revisiones.length);

  const alertas = await q(`SELECT * FROM asistencia_alertas`);
  const filasAl = alertas.map((a) => ({
    id: a.id, site_code: limpio(a.sucursal_id), person_code: limpio(a.empleado_codigo), person_name: a.empleado_nombre,
    work_date: a.fecha, rule: a.regla, severity: a.severidad, detail: a.detalle, evidence: a.evidencia || {},
    suggested_justification: a.justificacion_sugerida, status: a.estado, origin: a.origen || 'agente_ia',
    decided_by_name: a.decidido_por, decided_at: a.decidido_en, code: a.codigo,
    supervisor_justification: a.justificacion_jefe, responded_by: a.respondido_por, responded_at: a.respondido_en,
    analyzed_at: a.analizado_en,
  }));
  const nAl = await insertarLotes(trx, filasAl, `
    INSERT INTO hr.attendance_alerts (id, tenant_id, site_code, person_code, person_name, work_date, rule, severity, detail,
           evidence, suggested_justification, status, origin, decided_by_name, decided_at, code, supervisor_justification,
           responded_by, responded_at, analyzed_at)
    SELECT x.id, '${tenantId}'::uuid, x.site_code, x.person_code, x.person_name, x.work_date::date, x.rule, x.severity, x.detail,
           x.evidence, x.suggested_justification, x.status, x.origin, x.decided_by_name, x.decided_at, x.code,
           x.supervisor_justification, x.responded_by, x.responded_at, coalesce(x.analyzed_at, now())
      FROM jsonb_to_recordset(?::jsonb) AS x(id uuid, site_code text, person_code text, person_name text, work_date text,
           rule text, severity text, detail text, evidence jsonb, suggested_justification text, status text, origin text,
           decided_by_name text, decided_at timestamptz, code text, supervisor_justification text, responded_by text,
           responded_at timestamptz, analyzed_at timestamptz)
    ON CONFLICT DO NOTHING`);
  anotar('attendance_alerts', alertas.length, nAl, alertas.length - nAl ? { duplicada: alertas.length - nAl } : {});

  return cuadre;
}

/**
 * `--destino-prod`: antes de escribir una sola fila, que el clúster SEA prod y que la cadena de
 * migraciones esté aplicada. Un destino equivocado no falla: triunfa en el lugar equivocado.
 */
async function verificarDestinoProd(knex, { clusterId = PROD_CLUSTER_ID } = {}) {
  const { rows: [id] } = await knex.raw(
    'select (select system_identifier from pg_control_system())::text as id, current_database() as db');
  if (id.id !== clusterId) {
    throw new Error(`DESTINO EQUIVOCADO — no se escribe nada. Clúster ${id.id} (base "${id.db}"), se esperaba ${clusterId}.`);
  }
  const aplicadas = new Set((await knex.raw('SELECT name FROM public.knex_migrations')).rows.map((r) => r.name.replace(/\.js$/, '')));
  const faltan = [MIGRACION_BASE_CH, ...MIGRACIONES_FASE].filter((m) => !aplicadas.has(m));
  if (faltan.length) {
    throw new Error(`faltan migraciones en prod (se aplican antes, una por una): ${faltan.join(', ')}`);
  }
  console.log(`  destino verificado: prod (clúster ${id.id}, base "${id.db}"), cadena de migraciones aplicada`);
}

async function main() {
  const aplicar = process.argv.includes('--aplicar');
  const destinoProd = process.argv.includes('--destino-prod');
  // En el pod no hay `.env` ni, quizá, `dotenv`: ahí las URLs ya vienen del entorno.
  try { require('dotenv').config({ path: process.env.DOTENV_PATH || path.resolve(__dirname, '../../../.env') }); } catch { /* sin dotenv */ }
  let url;
  if (destinoProd) {
    if (process.argv.includes('--con-migraciones')) throw new Error('--con-migraciones no va con --destino-prod: en prod las migraciones se aplican aparte, una por una.');
    url = process.env.CARGA_URL;
    if (!url) throw new Error('--destino-prod necesita CARGA_URL (dentro del pod: CARGA_URL="$DATABASE_URL_NEW"). Ver el runbook.');
  } else {
    require('../../tests/_lib/assert-safe-target').assertSafeTarget('carga-unica-mega-talento');
    url = process.env.DATABASE_URL_NEW;
  }
  const knex = require('knex')({ client: 'pg', connection: url, pool: { min: 0, max: 1 } });
  if (destinoProd) {
    try { await verificarDestinoProd(knex); } catch (e) { await knex.destroy(); throw e; }
  }
  const mt = await conectarMegaTalento(process.env.MT_DATABASE_URL);
  const t0 = Date.now();
  const DESHACER = new Error('ensayo');
  try {
    await knex.transaction(async (trx) => {
      if (process.argv.includes('--con-migraciones')) {
        // Sólo para ensayar en una base que todavía no tiene la fase: corren dentro de la misma
        // transacción y se deshacen con ella. Nunca con --aplicar (las migraciones van por su carril).
        if (aplicar) throw new Error('--con-migraciones es sólo para ensayo: las migraciones se aplican aparte, una por una.');
        for (const m of MIGRACIONES_FASE) await require(path.resolve(__dirname, '../../migrations-newdb', `${m}.js`)).up(trx);
      }
      await trx.raw(`SELECT set_config('app.tenant_id', ?, true)`, [TENANT_MD]);
      console.log(`Carga única de Mega Talento → ${destinoProd ? 'PROD · ' : ''}${aplicar ? 'SE APLICA' : 'ENSAYO (se deshace al final)'}`);
      const cuadre = await cargarMegaTalento(trx, mt, { log: console.log });
      const fuera = Object.values(cuadre).reduce((s, c) => s + Object.values(c.descartes).reduce((a, b) => a + b, 0), 0);
      console.log(`\nListo en ${Math.round((Date.now() - t0) / 1000)} s · ${fuera} fila(s) fuera, todas con motivo arriba.`);
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

module.exports = { cargarMegaTalento, conectarMegaTalento, serieDesconocida, verificarDestinoProd, TENANT_MD, MIGRACIONES_FASE, MIGRACION_BASE_CH, PROD_CLUSTER_ID };
