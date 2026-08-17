/* eslint-disable no-console */
/**
 * Fase CH — Resuelve el crosswalk (equipo, user_id) → persona real.
 *
 * El checador no sabe quién es la gente: guarda un `user_id` local y un nombre
 * corto escrito a mano. Y `user_id` NO es único entre equipos (el `2` es "Tania"
 * en .0.81 y .0.153 pero "Lupita" en .0.196), así que la persona hay que armarla
 * aparte. Este script la propone; el humano confirma.
 *
 * CRITERIO CONSERVADOR — sobre-fusionar corrompe la asistencia (mezcla las
 * checadas de dos personas), sub-fusionar solo duplica una ficha y se arregla
 * después. Entonces:
 *
 *   1. NUNCA fusiona dos enrolamientos del MISMO equipo. Una persona tiene un
 *      solo enrolamiento por reloj, así que dos registros en el mismo equipo son
 *      dos personas — aunque se llamen igual. Verificado: .0.80 tiene dos "Clau"
 *      (117 y 126) y dos "Lupita" (104 y 131), y son gente distinta.
 *   2. Fusiona SOLO el par .0.80/.0.81 con la regla verificada `id_80 = id_81 + 100`
 *      (Tania 102/2, Ubaldo 107/7, Joan 152/52 …) Y además exigiendo que el nombre
 *      concuerde, porque en ese renumerado algunos nombres se corrieron de lugar
 *      (Arizbeth quedó en 112 y "Ariz" en 119, cruzados contra el otro equipo).
 *   3. Todo lo demás arranca como su propia persona. Los homónimos entre equipos
 *      distintos NO se fusionan solos: se listan para revisión humana.
 *
 * Idempotente: no toca enrolamientos que ya tengan persona asignada ni pisa
 * confirmaciones humanas (`match_status='confirmado'`).
 *
 *   node database/importers/checadores/link-employees.js            # dry-run
 *   node database/importers/checadores/link-employees.js --apply
 */

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '..', '.env') });
const { Client } = require('pg');

const TENANT = process.env.TENANT_ID || '00000000-0000-0000-0000-00000000d01c';
const DST = process.env.DATABASE_URL_NEW;
if (!DST) { console.error('FALTA DATABASE_URL_NEW'); process.exit(1); }
const APPLY = process.argv.includes('--apply');

/**
 * Pares de equipos que cubren la MISMA plantilla con numeración corrida.
 * Verificado en vivo 2026-08-17: 33 nombres concuerdan con offset 100.
 */
const SAME_SITE_PAIRS = [
  { a: 'UEED255000166', b: 'CLXK233460626', offset: 100 }, // .0.80 = .0.81 + 100
];

/** Normaliza para comparar nombres escritos a mano en el reloj. */
const norm = (s) => String(s || '')
  .normalize('NFD').replace(/[̀-ͯ]/g, '')
  .toLowerCase().replace(/[^a-z0-9]/g, '');

/** ¿Son plausiblemente el mismo nombre? Cubre las abreviaturas del reloj (Gera/Gerardo). */
function nameAgrees(x, y) {
  const a = norm(x), b = norm(y);
  if (!a || !b) return false;
  if (a === b) return true;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  return short.length >= 3 && long.startsWith(short);
}

(async () => {
  console.log(`\n=== Crosswalk enrolamiento → persona (${APPLY ? 'APPLY' : 'DRY-RUN'}) ===\n`);
  const db = new Client({ connectionString: DST });
  // El server cierra el socket al terminar; sin este handler pg emite un
  // 'error' sin dueño y el proceso muere DESPUÉS de haber commiteado (parece
  // que falló cuando en realidad escribió). Ver corrida 2026-08-17.
  db.on('error', () => {});
  await db.connect();

  try {
    const { rows: enr } = await db.query(
      `SELECT e.id, e.device_id, e.device_user_id, e.device_name, e.employee_id, e.match_status,
              d.serial_number, d.label AS device_label, d.ip_address
         FROM hr.device_enrollments e
         JOIN hr.attendance_devices d ON d.tenant_id = e.tenant_id AND d.id = e.device_id
        WHERE e.tenant_id = $1
        ORDER BY d.ip_address, e.device_user_id`, [TENANT]);

    const pending = enr.filter((e) => !e.employee_id && e.match_status !== 'confirmado');
    console.log(`enrolamientos: ${enr.length} total, ${pending.length} sin persona\n`);
    if (!pending.length) { console.log('nada que resolver.'); return; }

    // ── 1) Fusiones por regla de par de equipos (misma plantilla renumerada) ──
    const bySerial = new Map();
    for (const e of pending) {
      if (!bySerial.has(e.serial_number)) bySerial.set(e.serial_number, []);
      bySerial.get(e.serial_number).push(e);
    }

    const groups = [];           // cada grupo = una persona
    const claimed = new Set();   // ids de enrolamiento ya asignados a un grupo
    const merges = [];

    for (const pair of SAME_SITE_PAIRS) {
      const A = bySerial.get(pair.a) || [];
      const B = bySerial.get(pair.b) || [];
      for (const b of B) {
        const wantA = String(Number(b.device_user_id) + pair.offset);
        const a = A.find((x) => x.device_user_id === wantA && !claimed.has(x.id));
        if (!a || claimed.has(b.id)) continue;
        if (!nameAgrees(a.device_name, b.device_name)) continue;   // offset ok pero nombre no → a revisión
        claimed.add(a.id); claimed.add(b.id);
        groups.push({
          members: [a, b],
          name: (a.device_name || '').length >= (b.device_name || '').length ? a.device_name : b.device_name,
          score: 0.95,
          reason: `regla ${pair.offset >= 0 ? '+' : ''}${pair.offset} entre equipos de la misma plantilla + nombre concuerda (${a.device_user_id}/${b.device_user_id})`,
        });
        merges.push(`${a.device_name} ← ${a.ip_address}#${a.device_user_id} + ${b.ip_address}#${b.device_user_id} (${b.device_name})`);
      }
    }

    // ── 2) El resto: una persona por enrolamiento (sin fusionar a ciegas) ──
    for (const e of pending) {
      if (claimed.has(e.id)) continue;
      groups.push({
        members: [e],
        name: e.device_name || `SIN_NOMBRE_${e.device_user_id}`,
        score: 1.0,
        reason: 'enrolamiento único: 1 registro en el reloj = 1 persona',
      });
    }

    console.log(`--- Fusiones automáticas por regla de par: ${merges.length} ---`);
    merges.slice(0, 40).forEach((m) => console.log('  ' + m));
    if (merges.length > 40) console.log(`  ... y ${merges.length - 40} más`);

    // ── 3) Homónimos entre equipos distintos: NO se fusionan, se reportan ──
    const byName = new Map();
    for (const g of groups) {
      const k = norm(g.name);
      if (!k) continue;
      if (!byName.has(k)) byName.set(k, []);
      byName.get(k).push(g);
    }
    const review = [...byName.entries()].filter(([, gs]) => gs.length > 1);
    console.log(`\n--- Homónimos que quedan como personas separadas (revisión humana): ${review.length} ---`);
    for (const [k, gs] of review.slice(0, 25)) {
      const where = gs.map((g) => g.members.map((m) => `${m.ip_address}#${m.device_user_id}`).join('+')).join('  |  ');
      console.log(`  "${gs[0].name}" (${k}) → ${gs.length} fichas: ${where}`);
    }
    if (review.length > 25) console.log(`  ... y ${review.length - 25} más`);

    console.log(`\n--- Resumen ---`);
    console.log(`  personas a crear: ${groups.length}`);
    console.log(`  de las cuales fusionan 2 enrolamientos: ${merges.length}`);
    console.log(`  enrolamientos cubiertos: ${groups.reduce((n, g) => n + g.members.length, 0)}`);

    if (!APPLY) { console.log('\n(dry-run: nada se escribió. Agregá --apply)'); return; }

    // ── 4) Escritura ──────────────────────────────────────────────────────
    await db.query('BEGIN');
    let created = 0, linked = 0;
    for (const g of groups) {
      const site = g.members[0].device_label || null;
      const { rows } = await db.query(
        `INSERT INTO hr.employees (tenant_id, full_name, short_name, site_code, status, notes)
         VALUES ($1, $2, $3, NULL, 'activo', $4) RETURNING id`,
        [TENANT, g.name, g.name, `alta automática desde checador (${g.reason})`]);
      const empId = rows[0].id;
      created++;
      for (const m of g.members) {
        await db.query(
          `UPDATE hr.device_enrollments
              SET employee_id = $2, match_status = 'auto', match_score = $3, match_reason = $4, updated_at = now()
            WHERE tenant_id = $1 AND id = $5 AND employee_id IS NULL AND match_status <> 'confirmado'`,
          [TENANT, empId, g.score, g.reason, m.id]);
        linked++;
      }
      void site;
    }

    // Propaga la persona a las checadas ya cargadas.
    const upd = await db.query(
      `UPDATE hr.attendance_logs l
          SET employee_id = e.employee_id
         FROM hr.device_enrollments e
        WHERE l.tenant_id = $1
          AND e.tenant_id = l.tenant_id AND e.device_id = l.device_id
          AND e.device_user_id = l.device_user_id
          AND e.employee_id IS NOT NULL
          AND l.employee_id IS DISTINCT FROM e.employee_id`, [TENANT]);
    await db.query('COMMIT');

    console.log(`\n  personas creadas: ${created}`);
    console.log(`  enrolamientos ligados: ${linked}`);
    console.log(`  checadas atadas a persona: ${upd.rowCount}`);

    const { rows: t } = await db.query(
      `SELECT (SELECT count(*) FROM hr.employees WHERE tenant_id=$1) AS empleados,
              (SELECT count(*) FROM hr.device_enrollments WHERE tenant_id=$1 AND employee_id IS NULL) AS enr_sin_persona,
              (SELECT count(*) FROM hr.attendance_logs WHERE tenant_id=$1 AND employee_id IS NULL) AS logs_sin_persona,
              (SELECT count(*) FROM hr.attendance_logs WHERE tenant_id=$1) AS logs`, [TENANT]);
    console.log(`\n--- Estado de hr.* ---`);
    console.log(`  empleados=${t[0].empleados}  enrolamientos sin persona=${t[0].enr_sin_persona}`);
    console.log(`  checadas=${t[0].logs}  sin persona=${t[0].logs_sin_persona}`);
  } catch (e) {
    await db.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    await db.end().catch(() => {});
  }
  process.exit(0);
})().catch((e) => { console.error('\nFALLO: ' + e.message); process.exit(1); });
