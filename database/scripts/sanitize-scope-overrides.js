#!/usr/bin/env node
/**
 * `[AUTHZ-HARD.3]` — Saneo de los overrides `identity.user_scopes` que el
 * materializador `[ID.3]` dejó como `all` para no cegar a nadie durante el
 * cutover CASL→alcance. Ya NO hacen falta (el código es fail-closed) y hoy
 * REABREN el fail-open que AUTHZ-HARD.3 cerró: un `cajero`/`encargado_tienda`
 * con override `all` sigue viendo toda la red.
 *
 * SOLO toca el subconjunto SEGURO (cae a un alcance correcto, sin cegar):
 *   1. REDUNDANTE  — el rol ya es `all` en esa dimensión → quitar no cambia nada.
 *   2. OWN-POBLADO — el usuario TIENE su `warehouse_code`/`zona_id` → cae a `own`
 *                    = su sucursal/zona real (scoping correcto).
 *   3. customer_b2b — cliente de portal: quitar es un FIX de seguridad (no debe
 *                    ver sucursal/zona internas; usa scope de cliente).
 *
 * NO toca (se REPORTAN como pendientes de padrón): overrides de usuarios con la
 * columna propia VACÍA (route/telemarketing/supervisor sin sucursal) — quitarlos
 * los cegaría; primero hay que asignarles su sucursal/zona. Tampoco cuentas *_smoke.
 *
 * Quitar el override = el usuario vuelve al DEFAULT DE SU ROL (borra la fila de
 * `user_scopes`, exactamente como `PUT /users/:id/scope/:dim` con `mode:null`).
 * Escribe un `identity.user_events` por cambio (auditoría). Idempotente.
 *
 * Uso:
 *   node database/scripts/sanitize-scope-overrides.js            # DRY-RUN (default, read-only)
 *   node database/scripts/sanitize-scope-overrides.js --apply    # ejecuta (backup + delete + audit)
 *   DB=FLEET   → prod (FLEET_DB_URL);  DB=NEW (default) → DATABASE_URL_NEW (local/test)
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

const APPLY = process.argv.includes('--apply');
const DBSEL = (process.env.DB || 'NEW').toUpperCase();
const URL = DBSEL === 'FLEET' ? process.env.FLEET_DB_URL : process.env.DATABASE_URL_NEW;
if (!URL) { console.error(`Falta la env para DB=${DBSEL}`); process.exit(1); }

// Criterio SEGURO (ver cabecera). `us` = user_scopes, `u` = users, `rs` = role_scopes.
const SAFE_WHERE = `
  us.dimension in ('warehouse','zone')
  and us.mode in ('all','listed')
  and u.role_name not ilike '%\\_smoke'
  and (
        rs.mode = 'all'                                   -- redundante
     or lower(u.role_name) = 'customer_b2b'               -- portal (fix seguridad)
     or (us.dimension='warehouse' and u.warehouse_code is not null)  -- own poblado
     or (us.dimension='zone'      and u.zona_id       is not null)   -- own poblado
  )`;

const useSsl = /proxy\.rlwy\.net|railway|rlwy/.test(URL);

(async () => {
  const c = new Client({ connectionString: URL, ssl: useSsl ? { rejectUnauthorized: false } : false });
  await c.connect();
  const db = (await c.query('select current_database() d')).rows[0].d;
  console.log(`DB=${DBSEL} (${db})  modo=${APPLY ? 'APPLY' : 'DRY-RUN'}\n`);

  const targets = (await c.query(`
    select us.tenant_id, us.user_id, us.dimension, us.mode as override,
           us.values as bak_values, us.mode_write as bak_mode_write, us.nota as bak_nota,
           coalesce(rs.mode,'(sin regla)') as rol_default,
           u.username, u.role_name,
           case when us.dimension='warehouse' then u.warehouse_code else u.zona_id::text end as col_propia,
           case
             when rs.mode='all' then 'redundante'
             when lower(u.role_name)='customer_b2b' then 'portal'
             else 'own-poblado' end as motivo
    from identity.user_scopes us
    join identity.users u on u.id = us.user_id
    left join identity.role_scopes rs on lower(rs.role_name)=lower(u.role_name) and rs.dimension=us.dimension
    where ${SAFE_WHERE}
    order by us.dimension, motivo, u.role_name, u.username`)).rows;

  // Pendientes (columna propia vacía, se RETIENEN) — solo para reporte.
  const held = (await c.query(`
    select us.dimension, u.role_name, count(*)::int n
    from identity.user_scopes us
    join identity.users u on u.id = us.user_id
    left join identity.role_scopes rs on lower(rs.role_name)=lower(u.role_name) and rs.dimension=us.dimension
    where us.dimension in ('warehouse','zone') and us.mode in ('all','listed')
      and u.role_name not ilike '%\\_smoke'
      and not (${SAFE_WHERE})
    group by us.dimension, u.role_name order by us.dimension, n desc`)).rows;

  const byMotivo = targets.reduce((a, r) => (a[`${r.dimension}/${r.motivo}`] = (a[`${r.dimension}/${r.motivo}`] || 0) + 1, a), {});
  console.log('A QUITAR (seguro):', targets.length);
  console.table(Object.entries(byMotivo).map(([k, n]) => ({ dim_motivo: k, n })));
  console.log('\nA RETENER (columna propia vacía → asignar sucursal/zona primero):');
  console.table(held);

  if (!APPLY) {
    const out = path.join(path.dirname(__filename), `_sanitize-scope-preview-${db}.json`);
    fs.writeFileSync(out, JSON.stringify(targets, null, 2));
    console.log(`\nDRY-RUN. Sin cambios. Detalle de las ${targets.length} filas → ${out}`);
    await c.end(); return;
  }

  // APPLY: backup + delete + audit, en UNA transacción.
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const bak = path.join(path.dirname(__filename), `_sanitize-scope-backup-${db}-${stamp}.json`);
  fs.writeFileSync(bak, JSON.stringify(targets, null, 2));
  console.log(`\nBackup de ${targets.length} filas → ${bak}`);

  await c.query('begin');
  try {
    let del = 0;
    for (const r of targets) {
      const res = await c.query(
        `delete from identity.user_scopes where tenant_id=$1 and user_id=$2 and dimension=$3`,
        [r.tenant_id, r.user_id, r.dimension]);
      del += res.rowCount;
      // Mismo evento y forma que `setScope(... mode:null)`: `scope_changed`,
      // `de` = lo que había, `a` = null (vuelve al default del rol).
      await c.query(
        `insert into identity.user_events (tenant_id, user_id, event, detalle, actor_username)
         values ($1,$2,'scope_changed',$3::jsonb,'AUTHZ-HARD.3')`,
        [r.tenant_id, r.user_id, JSON.stringify({
          dimension: r.dimension, de: { mode: r.override }, a: null,
          hereda_del_rol: true, motivo: r.motivo, origen: 'AUTHZ-HARD.3 saneo [ID.3]',
        })]);
    }
    await c.query('commit');
    console.log(`APLICADO: ${del} overrides quitados (→ default del rol) + ${del} eventos de auditoría.`);
  } catch (e) {
    await c.query('rollback');
    console.error('ROLLBACK:', e.message);
    process.exit(1);
  }
  await c.end();
})().catch(e => { console.error(e.message); process.exit(1); });
