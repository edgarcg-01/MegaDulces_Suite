/* eslint-disable no-console */
/**
 * Fase CH — Checadores ZKTeco → schema `hr.*`.
 *
 * Lee los relojes por su protocolo nativo (TCP 4370) y refleja identidad,
 * usuarios enrolados y checadas. Es la carga inicial Y el poller incremental:
 * la misma corrida sirve para las dos cosas porque es idempotente.
 *
 * Idempotencia: la llave natural de una checada es
 * (device, device_user_id, punched_at). NO se usa el `uid` del equipo porque es
 * el índice de su ring buffer y se reinicia al purgar registros, lo que
 * colisionaría contra el histórico. `ON CONFLICT DO NOTHING` = append-only sin
 * churn (el equipo reenvía siempre TODO su buffer; solo entra lo nuevo).
 *
 * Los equipos NO se modifican nunca: solo comandos de lectura.
 *
 *   node database/importers/checadores/import-checadores.js                  # dry-run, todos
 *   node database/importers/checadores/import-checadores.js --apply
 *   node database/importers/checadores/import-checadores.js --apply --ip 192.168.0.80
 *   node database/importers/checadores/import-checadores.js --apply --no-logs   # solo identidad+usuarios
 */

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '..', '.env') });
const { Client } = require('pg');
const { ZKClient } = require('./zk-client');
const DEVICES = require('./devices');

const TENANT = process.env.TENANT_ID || '00000000-0000-0000-0000-00000000d01c';
// Nunca hardcodear credenciales: la conexión sale de DATABASE_URL_NEW (.env).
const DST = process.env.DATABASE_URL_NEW;
if (!DST) {
  console.error('FALTA DATABASE_URL_NEW (revisá database/.env o exportá la variable).');
  process.exit(1);
}
const APPLY = process.argv.includes('--apply');
const NO_LOGS = process.argv.includes('--no-logs');
const ipIx = process.argv.indexOf('--ip');
const ONLY_IP = ipIx > -1 ? process.argv[ipIx + 1] : null;
const CHUNK = 2000;

/** Lee un equipo. Nunca lanza: devuelve el error para que un reloj caído no tumbe la corrida. */
async function readDevice(dev) {
  const zk = new ZKClient({ ip: dev.ip, port: dev.port || 4370, commKey: dev.commKey ?? 0, timeout: 25000 });
  const t0 = Date.now();
  try {
    await zk.connect();
    const info = await zk.getInfo();
    const users = await zk.getUsers();
    const logs = NO_LOGS ? [] : await zk.getAttendance();
    return { ok: true, info, users, logs, ms: Date.now() - t0 };
  } catch (e) {
    return { ok: false, error: e.message, ms: Date.now() - t0 };
  } finally {
    await zk.disconnect().catch(() => {});
  }
}

/** Deriva de reloj vs server, en segundos (el reloj da hora de pared local MX). */
function clockDrift(deviceTime) {
  if (!deviceTime) return null;
  const nowMx = new Date().toLocaleString('sv-SE', { timeZone: 'America/Mexico_City' }).replace('T', ' ');
  return Math.round((new Date(deviceTime.replace(' ', 'T')) - new Date(nowMx.replace(' ', 'T'))) / 1000);
}

/** UPSERT del equipo por serie (identidad estable); si no dio serie, por IP. */
async function upsertDevice(db, dev, info, drift) {
  const serial = info?.serial_number || dev.serial;
  if (!serial) throw new Error('el equipo no reportó serie y no hay serie declarada en devices.js');
  const r = await db.query(
    `INSERT INTO hr.attendance_devices
       (tenant_id, serial_number, ip_address, port, comm_key, label, site_code,
        model, platform, firmware, mac, reported_ip,
        user_count, record_count, capacity_users, capacity_records,
        last_seen_at, last_sync_at, last_error, clock_drift_seconds, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16, now(), now(), NULL, $17, now())
     ON CONFLICT (tenant_id, serial_number) DO UPDATE SET
       ip_address = EXCLUDED.ip_address,
       model = COALESCE(EXCLUDED.model, hr.attendance_devices.model),
       platform = COALESCE(EXCLUDED.platform, hr.attendance_devices.platform),
       firmware = COALESCE(EXCLUDED.firmware, hr.attendance_devices.firmware),
       mac = COALESCE(EXCLUDED.mac, hr.attendance_devices.mac),
       reported_ip = EXCLUDED.reported_ip,
       -- label/site_code los cura un humano: el importer NO los pisa
       label = COALESCE(hr.attendance_devices.label, EXCLUDED.label),
       site_code = COALESCE(hr.attendance_devices.site_code, EXCLUDED.site_code),
       user_count = EXCLUDED.user_count,
       record_count = EXCLUDED.record_count,
       capacity_users = EXCLUDED.capacity_users,
       capacity_records = EXCLUDED.capacity_records,
       last_seen_at = now(), last_sync_at = now(), last_error = NULL,
       clock_drift_seconds = EXCLUDED.clock_drift_seconds,
       updated_at = now()
     RETURNING id`,
    [TENANT, serial, dev.ip, dev.port || 4370, dev.commKey ?? 0, dev.label || null, dev.site_code || null,
      info?.model || dev.model || null, info?.platform || null, info?.firmware || null, info?.mac || null,
      info?.reported_ip || null, info?.user_count ?? null, info?.record_count ?? null,
      info?.capacity_users ?? null, info?.capacity_records ?? null, drift]);
  return r.rows[0].id;
}

/** Marca el fallo en el equipo ya conocido (por serie declarada o por IP). */
async function markError(db, dev, error) {
  await db.query(
    `UPDATE hr.attendance_devices
        SET last_error = $3, last_sync_at = now(), updated_at = now()
      WHERE tenant_id = $1 AND (serial_number = $2 OR ip_address = $4)`,
    [TENANT, dev.serial || '__none__', error, dev.ip]);
}

async function upsertEnrollments(db, deviceId, users) {
  if (!users.length) return 0;
  let n = 0;
  for (const u of users) {
    const r = await db.query(
      `INSERT INTO hr.device_enrollments
         (tenant_id, device_id, device_user_id, device_uid, device_name, privilege, role,
          has_password, card, group_id, last_seen_at, is_present, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, now(), true, now())
       ON CONFLICT (tenant_id, device_id, device_user_id) DO UPDATE SET
         device_uid = EXCLUDED.device_uid,
         device_name = EXCLUDED.device_name,
         privilege = EXCLUDED.privilege,
         role = EXCLUDED.role,
         has_password = EXCLUDED.has_password,
         card = EXCLUDED.card,
         group_id = EXCLUDED.group_id,
         last_seen_at = now(), is_present = true, updated_at = now()`,
      [TENANT, deviceId, u.device_user_id, u.device_uid, u.device_name || null, u.privilege,
        u.role, u.has_password, u.card, u.group_id]);
    n += r.rowCount;
  }
  // Los que ya no aparecen en el equipo: se marcan ausentes, NO se borran
  // (su histórico de checadas sigue vivo y el crosswalk debe sobrevivir).
  await db.query(
    `UPDATE hr.device_enrollments SET is_present = false, updated_at = now()
      WHERE tenant_id = $1 AND device_id = $2 AND is_present = true
        AND device_user_id <> ALL($3::text[])`,
    [TENANT, deviceId, users.map((u) => u.device_user_id)]);
  return n;
}

/**
 * Inserta checadas nuevas. `punched_local` es hora de pared del reloj; el
 * canónico se deriva con la zona declarada del equipo (AT TIME ZONE), que es
 * DST-safe. `employee_id` se resuelve desde el crosswalk si ya está mapeado.
 */
async function insertLogs(db, deviceId, logs, tz) {
  let inserted = 0;
  for (let i = 0; i < logs.length; i += CHUNK) {
    const batch = logs.slice(i, i + CHUNK);
    const vals = [];
    const params = [TENANT, deviceId, tz];
    for (const l of batch) {
      const b = params.length;
      params.push(l.device_user_id, l.punched_local, l.device_uid, l.verify_mode,
        l.verify_label, l.punch_type, l.punch_label);
      vals.push(`($1, $2, $${b + 1}, ($${b + 2}::timestamp AT TIME ZONE $3), $${b + 2}::timestamp,
                  $${b + 3}, $${b + 4}, $${b + 5}, $${b + 6}, $${b + 7})`);
    }
    const r = await db.query(
      `INSERT INTO hr.attendance_logs
         (tenant_id, device_id, device_user_id, punched_at, punched_local,
          device_uid, verify_mode, verify_label, punch_type, punch_label)
       VALUES ${vals.join(',')}
       ON CONFLICT (tenant_id, device_id, device_user_id, punched_at) DO NOTHING`,
      params);
    inserted += r.rowCount;
  }
  // Ata las checadas nuevas a la persona cuando el crosswalk ya está resuelto.
  await db.query(
    `UPDATE hr.attendance_logs l
        SET employee_id = e.employee_id
       FROM hr.device_enrollments e
      WHERE l.tenant_id = $1 AND l.device_id = $2
        AND e.tenant_id = l.tenant_id AND e.device_id = l.device_id
        AND e.device_user_id = l.device_user_id
        AND e.employee_id IS NOT NULL AND l.employee_id IS DISTINCT FROM e.employee_id`,
    [TENANT, deviceId]);
  return inserted;
}

(async () => {
  const targets = DEVICES.filter((d) => !ONLY_IP || d.ip === ONLY_IP);
  console.log(`\n=== Checadores ZKTeco → hr.* (${APPLY ? 'APPLY' : 'DRY-RUN'}) — ${targets.length} equipo(s) ===\n`);

  const db = new Client({ connectionString: DST });
  // Sin este handler, el cierre del socket al final emite un 'error' sin dueño
  // y el proceso muere DESPUÉS de haber commiteado (parece fallo y no lo es).
  db.on('error', () => {});
  await db.connect();
  // El importer corre como owner (postgres): RLS forzado aplica a app_runtime,
  // pero el filtro por tenant va explícito en cada query de todos modos.
  await db.query(`SET search_path TO hr, public`);

  const summary = [];
  try {
    for (const dev of targets) {
      process.stdout.write(`${dev.ip.padEnd(16)} `);
      const res = await readDevice(dev);

      if (!res.ok) {
        console.log(`✗ ${res.error}`);
        summary.push({ ip: dev.ip, status: 'unreachable', error: res.error });
        if (APPLY) {
          await markError(db, dev, res.error).catch(() => {});
          await db.query(
            `INSERT INTO hr.device_sync_runs
               (tenant_id, serial_number, ip_address, finished_at, duration_ms, status, error)
             VALUES ($1,$2,$3, now(), $4, 'unreachable', $5)`,
            [TENANT, dev.serial || null, dev.ip, res.ms, res.error]);
        }
        continue;
      }

      const { info, users, logs } = res;
      const drift = clockDrift(info.device_time);
      const range = logs.length ? `${logs[0].punched_local} → ${logs[logs.length - 1].punched_local}` : 'sin checadas';
      console.log(`✓ ${String(info.model || '?').padEnd(9)} ${String(info.serial_number || '?').padEnd(14)} ` +
        `${String(users.length).padStart(3)} usr  ${String(logs.length).padStart(6)} logs  ` +
        `drift ${drift === null ? '?' : `${drift}s`}  ${range}`);

      if (!APPLY) {
        summary.push({ ip: dev.ip, status: 'ok', users: users.length, logs: logs.length, inserted: 0 });
        continue;
      }

      const t0 = Date.now();
      const runId = (await db.query(
        `INSERT INTO hr.device_sync_runs (tenant_id, serial_number, ip_address, status)
         VALUES ($1,$2,$3,'running') RETURNING id`,
        [TENANT, info.serial_number || dev.serial, dev.ip])).rows[0].id;

      try {
        await db.query('BEGIN');
        const deviceId = await upsertDevice(db, dev, info, drift);
        const enr = await upsertEnrollments(db, deviceId, users);
        const ins = logs.length ? await insertLogs(db, deviceId, logs, dev.timezone || 'America/Mexico_City') : 0;
        await db.query('COMMIT');
        await db.query(
          `UPDATE hr.device_sync_runs SET device_id=$2, finished_at=now(), duration_ms=$3, status='ok',
                  users_read=$4, logs_read=$5, logs_inserted=$6, enrollments_upserted=$7, clock_drift_seconds=$8
            WHERE id=$1`,
          [runId, deviceId, Date.now() - t0, users.length, logs.length, ins, enr, drift]);
        console.log(`${''.padEnd(16)}   → ${ins} checadas nuevas, ${enr} enrolamientos`);
        summary.push({ ip: dev.ip, status: 'ok', users: users.length, logs: logs.length, inserted: ins });
      } catch (e) {
        await db.query('ROLLBACK').catch(() => {});
        await db.query(
          `UPDATE hr.device_sync_runs SET finished_at=now(), duration_ms=$3, status='error', error=$2 WHERE id=$1`,
          [runId, e.message, Date.now() - t0]).catch(() => {});
        console.log(`${''.padEnd(16)}   ✗ error al guardar: ${e.message}`);
        summary.push({ ip: dev.ip, status: 'error', error: e.message });
      }
    }

    if (APPLY) {
      const tot = await db.query(
        `SELECT (SELECT count(*) FROM hr.attendance_devices WHERE tenant_id=$1) AS equipos,
                (SELECT count(*) FROM hr.device_enrollments WHERE tenant_id=$1) AS enrolamientos,
                (SELECT count(*) FROM hr.employees WHERE tenant_id=$1) AS empleados,
                (SELECT count(*) FROM hr.attendance_logs WHERE tenant_id=$1) AS checadas,
                (SELECT count(*) FROM hr.attendance_logs WHERE tenant_id=$1 AND employee_id IS NULL) AS sin_persona,
                (SELECT min(punched_at) FROM hr.attendance_logs WHERE tenant_id=$1) AS desde,
                (SELECT max(punched_at) FROM hr.attendance_logs WHERE tenant_id=$1) AS hasta`,
        [TENANT]);
      const t = tot.rows[0];
      console.log(`\n--- Estado de hr.* ---`);
      console.log(`  equipos=${t.equipos}  enrolamientos=${t.enrolamientos}  empleados=${t.empleados}`);
      console.log(`  checadas=${t.checadas}  (sin persona asignada: ${t.sin_persona})`);
      console.log(`  rango: ${t.desde} → ${t.hasta}`);
    }

    const ok = summary.filter((s) => s.status === 'ok').length;
    const bad = summary.filter((s) => s.status !== 'ok');
    console.log(`\n=== ${ok}/${targets.length} equipos leídos${bad.length ? `; con problema: ${bad.map((b) => b.ip).join(', ')}` : ''} ===`);
    if (!APPLY) console.log('(dry-run: nada se escribió. Agregá --apply)');
  } finally {
    await db.end().catch(() => {});
  }
  process.exit(0);
})().catch((e) => { console.error('\nFALLO: ' + e.message); process.exit(1); });
