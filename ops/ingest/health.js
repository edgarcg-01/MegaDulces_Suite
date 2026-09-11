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
 *      ODS_HB_IGNORE_ERROR=1 → juzga SÓLO la antigüedad, no `status='error'`
 *
 * ⭐ `ODS_HB_KEY` acepta VARIAS claves separadas por coma, y entonces el veredicto es
 * "sano si CUALQUIERA está al día" — semántica de CANARIO, no de auditoría. Existe para
 * `feeds-cron`, que no tiene un carril propio sino once: preguntar por uno solo lo ataría a
 * ese carril (si se retira o se renombra, el contenedor entraría en bucle de reinicio
 * eterno por una clave que ya no existe), y preguntar por TODOS sería peor — reiniciaría
 * los once porque la fuente de uno está caída, cuando reiniciar no repone nada. Lo que
 * este contenedor tiene que probar es que el camino cron → run-feed.sh → node → prod
 * ENTREGA; con que un carril lo demuestre, alcanza. Que un carril concreto esté mal lo
 * grita db-health, que sí mira uno por uno y tiene el umbral de cada cual.
 * Con una sola clave el comportamiento es idéntico al de siempre.
 *
 * Sobre `ODS_HB_IGNORE_ERROR`: hay carriles cuyo `status='error'` es una alarma de **DATO**, no de
 * vivencia. El reconciliador marca `error` cuando encuentra huecos por encima del umbral: eso dice
 * "el pipeline está perdiendo filas", no "este contenedor está roto" — y reiniciarlo no repone una
 * sola fila. Sin este flag, Docker reiniciaría en bucle un proceso perfectamente sano cada vez que
 * el dato viene mal, que es precisamente cuando más falta hace que siga corriendo y avisando.
 *
 * Sale 0 = sano · 1 = latido viejo/ausente/en error · 0 con aviso = no configurado (no se castiga
 * un contenedor por falta de config; eso lo grita el preflight del propio shipper).
 */
const { Client } = require('pg');

const URL_ = process.env.ODS_HB_URL;
const KEY = process.env.ODS_HB_KEY;
const KEYS = String(KEY || '').split(',').map((k) => k.trim()).filter(Boolean);
const MAX_MIN = Math.max(1, Number(process.env.ODS_HB_MAX_MIN) || 20);
const IGNORE_ERROR = /^(1|true|yes)$/i.test(String(process.env.ODS_HB_IGNORE_ERROR || ''));
const TENANT = process.env.CRON_TENANT_ID || '00000000-0000-0000-0000-00000000d01c';

(async () => {
  if (!URL_ || !KEYS.length) { console.log('health: sin ODS_HB_URL/ODS_HB_KEY — no se evalúa'); process.exit(0); }
  const c = new Client({
    connectionString: URL_,
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 8000,
    statement_timeout: 8000,
  });
  try {
    await c.connect();
    const filas = (await c.query(
      `SELECT job_key, status, host,
              GREATEST(EXTRACT(EPOCH FROM (now() - COALESCE(last_finish, last_start)))/60, 0) AS min_age
         FROM analytics.cron_runs WHERE tenant_id=$1 AND job_key = ANY($2)`, [TENANT, KEYS])).rows;

    // ── Modo CANARIO (varias claves): sano si CUALQUIERA entrega. Ver el encabezado.
    if (KEYS.length > 1) {
      const YO = require('os').hostname();
      const vivas = filas.filter((f) => {
        if (f.host && f.host !== YO) return false;                 // la late otro proceso
        if (Number(f.min_age) > MAX_MIN) return false;              // vieja
        if (f.status === 'error' && !IGNORE_ERROR) return false;
        return true;
      });
      const detalle = KEYS.map((k) => {
        const f = filas.find((x) => x.job_key === k);
        return f ? `${k}=${Number(f.min_age).toFixed(1)}min/${f.status}` : `${k}=sin latido`;
      }).join(' · ');
      if (vivas.length) {
        console.log(`health: canario ok — ${vivas.length}/${KEYS.length} entregando (${detalle})`);
        process.exit(0);
      }
      console.error(`health: NINGUNO de los ${KEYS.length} carriles canario entrega (tope ${MAX_MIN} min): ${detalle}`);
      process.exit(1);
    }

    const r = filas[0];
    if (!r) { console.error(`health: ${KEY} sin latido en prod — el carril no está entregando`); process.exit(1); }
    const age = Number(r.min_age);

    // ¿ES NUESTRO EL PULSO QUE ESTAMOS LEYENDO? `cron_runs` tiene PRIMARY KEY (tenant_id, job_key):
    // UNA fila por carril, sin host. Dos procesos con el mismo ODS_HB_KEY se pisan el renglón, y
    // entonces este chequeo le toma el pulso al OTRO. Pasó el 04-09-2026: el contenedor llevaba
    // 15 h colgado y salía `healthy` porque una tarea de Windows escribía ese mismo renglón desde
    // la máquina de al lado. Un carril = UN dueño; si el renglón trae otro `host`, este contenedor
    // no está entregando aunque el carril "lata".
    const YO = require('os').hostname();
    if (r.host && r.host !== YO) {
      console.error(`health: ${KEY} lo está latiendo '${r.host}', no yo ('${YO}') — hay otro proceso en el mismo carril`);
      process.exit(1);
    }
    // `running` es legítimo mientras la pasada dure menos que el tope. Pasado el tope no dice
    // "trabajando", dice COLGADO — y un carril colgado no entrega, así que se reinicia.
    if (age > MAX_MIN) {
      console.error(`health: ${KEY} lleva ${age.toFixed(1)} min sin avanzar (tope ${MAX_MIN}, status=${r.status})`);
      process.exit(1);
    }
    if (r.status === 'error' && !IGNORE_ERROR) {
      console.error(`health: ${KEY} en error (hace ${age.toFixed(1)} min)`);
      process.exit(1);
    }
    if (r.status === 'error' && IGNORE_ERROR) {
      // Late y a tiempo: el proceso ENTREGA. El `error` es del dato y lo grita db-health, no Docker.
      console.log(`health: ${KEY} vivo y al día (${age.toFixed(1)} min) — status=error es alarma de dato, no de proceso`);
      process.exit(0);
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
