/* eslint-disable no-console */
/**
 * HEALTHCHECK de ENTREGA (OBS.4.2) — no de "el proceso está vivo".
 *
 * Esta es la diferencia que costó 6 días. El 2026-09-02 `pm2 ls` decía **online** para dos carriles
 * cuyo batch nunca se ejecutó (PM2 abrió un `cmd` interactivo): supervisor verde, cero entrega. Un
 * chequeo de PID no puede ver eso. Este mide lo único que importa — que el latido del carril
 * AVANCE en prod — y sale ≠ 0 cuando no, para que Docker reinicie el contenedor.
 *
 * Se mira el latido en PROD (no `ods.ctl` del replica) a propósito: `ods.ctl` prueba que el proceso
 * hizo su pasada local, no que el dato llegó al otro lado. Ver ADR-053 §1.
 *
 * Env: ODS_HB_URL (destino del latido = prod) · ODS_HB_KEY (clave del carril)
 *      ODS_HB_MAX_MIN (tope de antigüedad en minutos; default 20)
 *
 * Sale 0 = sano · 1 = latido viejo/ausente/en error · 0 con aviso = no configurado (no se castiga
 * un contenedor por falta de config; eso lo grita el preflight del propio shipper).
 */
const { Client } = require('pg');

const URL_ = process.env.ODS_HB_URL;
const KEY = process.env.ODS_HB_KEY;
const MAX_MIN = Math.max(1, Number(process.env.ODS_HB_MAX_MIN) || 20);
const TENANT = process.env.CRON_TENANT_ID || '00000000-0000-0000-0000-00000000d01c';

(async () => {
  if (!URL_ || !KEY) { console.log('health: sin ODS_HB_URL/ODS_HB_KEY — no se evalúa'); process.exit(0); }
  const c = new Client({
    connectionString: URL_,
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 8000,
    statement_timeout: 8000,
  });
  try {
    await c.connect();
    const r = (await c.query(
      `SELECT status,
              GREATEST(EXTRACT(EPOCH FROM (now() - COALESCE(last_finish, last_start)))/60, 0) AS min_age
         FROM analytics.cron_runs WHERE tenant_id=$1 AND job_key=$2`, [TENANT, KEY])).rows[0];

    if (!r) { console.error(`health: ${KEY} sin latido en prod — el carril no está entregando`); process.exit(1); }
    const age = Number(r.min_age);
    // `running` es legítimo mientras la pasada dure menos que el tope. Pasado el tope no dice
    // "trabajando", dice COLGADO — y un carril colgado no entrega, así que se reinicia.
    if (age > MAX_MIN) {
      console.error(`health: ${KEY} lleva ${age.toFixed(1)} min sin avanzar (tope ${MAX_MIN}, status=${r.status})`);
      process.exit(1);
    }
    if (r.status === 'error') {
      console.error(`health: ${KEY} en error (hace ${age.toFixed(1)} min)`);
      process.exit(1);
    }
    console.log(`health: ${KEY} ok (${age.toFixed(1)} min, status=${r.status})`);
    process.exit(0);
  } catch (e) {
    // Si no se puede LEER el latido no se puede afirmar que esté sano. Se reporta enfermo: un
    // healthcheck que se cae a "sano" ante un error es el falso verde otra vez.
    console.error(`health: no se pudo verificar (${String(e.message).slice(0, 80)})`);
    process.exit(1);
  } finally { await c.end().catch(() => {}); }
})();
