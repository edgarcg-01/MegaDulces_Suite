#!/usr/bin/env node
/* eslint-disable no-console */
'use strict';
/**
 * `[KR.14]` El ARCHIVO MAESTRO de la escritura a Kepler — uno solo, fuera del repo.
 *
 *   node ops/prod/kepler-push-secretos.js            # crea o completa el maestro
 *   node ops/prod/kepler-push-secretos.js --dir D:\secretos\kepler
 *
 * Produce en `<dir>` (default `%USERPROFILE%\kepler-push-secretos`), NUNCA en el repo
 * (el repo es PÚBLICO):
 *
 *   kepler-push.env    El maestro. Alimenta el secreto `kepler-push` del namespace `prod`, que
 *                      el deployment `api` lee con `envFrom` (ops/k3s/41-redis-worker-api.yaml).
 *                      Una sección por servidor: URL con su contraseña, plantillas y tope.
 *                      ⛔ Un servidor con sus líneas COMENTADAS está APAGADO: `--from-env-file`
 *                      ignora los comentarios. Encenderlo = descomentar sus líneas (runbook §9).
 *   roles/md_NN.sql    El `CREATE ROLE kepler_push` de cada servidor, con SU contraseña, más los
 *                      GRANT y la línea de `pg_hba`. Se corre una vez como superusuario.
 *   kepler-admin.env   Plantilla para las URL de SUPERUSUARIO que usa el rollback
 *                      (`kepler-push-ops.js deshacer/restaurar`). ⛔ NUNCA entra al clúster.
 *
 * ── Reglas ──────────────────────────────────────────────────────────────────────────────
 * - **No rota nada en silencio.** Si un servidor ya está en el maestro, se respeta su
 *   contraseña. Una contraseña cambiada en el archivo y no en el servidor apaga ese servidor.
 * - `00` reusa la contraseña que ya existe (`KEPLER_PUSH_URL` del `.env` local): el rol ya está
 *   creado en `.9.95` y verificado con `kepler-push-ops.js revisar`.
 * - Contraseñas de 32 caracteres [A-Za-z0-9]: sin símbolos que rompan una URL, cmd o psql.
 * - El script NO imprime contraseñas.
 * - `08` (Morelia Abastos): host tomado de database/importers/lib/kepler-branches.js.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

require('dotenv').config({ path: path.resolve(__dirname, '../../.env'), quiet: true });

/** Publicadores medidos (ops/vl/vl0-verify.sh, de pg_subscription, 2026-09-10). */
const SERVIDORES = {
  '00': { host: '192.168.9.95', port: 5432 },
  '01': { host: '192.168.10.10', port: 1977 },
  '02': { host: '192.168.42.42', port: 5432, su: 'sa' },
  '03': { host: '192.168.40.40', port: 5432 },
  '04': { host: '192.168.44.44', port: 5432 },
  '05': { host: '192.168.54.54', port: 5432 },
  '06': { host: '192.168.50.50', port: 1977 },
  '07': { host: '192.168.32.32', port: 1977 },
  '08': { host: '192.168.30.30', port: 1977 }, // database/importers/lib/kepler-branches.js
};

/** Plantillas candidatas (runbook §8.3). Confirmarlas en Kepler antes de encender. */
const PLANTILLAS = {
  '00': ['0000424', '0000450'], '01': ['0000092', null], '02': ['0000101', '0002124'],
  '03': ['0000158', '0000002'], '04': ['0000059', null], '05': ['0000007', null],
  '06': ['0000001', '0000895'], '07': ['0000035', null], '08': ['0000005', '0000028'],
};

const PROD_IP = '192.168.0.222';
const OPERADOR_IP = '192.168.0.243';

const args = process.argv.slice(2);
const dirArg = args.includes('--dir') ? args[args.indexOf('--dir') + 1] : null;
const DIR = path.resolve(dirArg || path.join(os.homedir(), 'kepler-push-secretos'));
const MAESTRO = path.join(DIR, 'kepler-push.env');

const repo = path.resolve(__dirname, '../..');
if (DIR.toLowerCase().startsWith(repo.toLowerCase())) {
  console.error(`⛔ ${DIR} está dentro del repo, que es PÚBLICO. Elegí un directorio afuera.`);
  process.exit(2);
}

function clave() {
  const abc = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const b = crypto.randomBytes(64);
  let s = '';
  for (let i = 0; s.length < 32 && i < b.length; i++) if (b[i] < 248) s += abc[b[i] % 62];
  return s;
}

/** Lee el maestro existente, incluidas las líneas comentadas (servidores apagados). */
function leerMaestro() {
  const v = {};
  if (!fs.existsSync(MAESTRO)) return v;
  for (const line of fs.readFileSync(MAESTRO, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^#?\s*(KEPLER_[A-Z_]+_\d{2})=(.*)$/);
    if (m) v[m[1]] = { valor: m[2], activa: !line.startsWith('#') };
  }
  return v;
}

function passDe(url) {
  const m = String(url || '').match(/^postgres(?:ql)?:\/\/[^:]+:([^@]+)@/);
  return m ? m[1] : null;
}

const previo = leerMaestro();
fs.mkdirSync(path.join(DIR, 'roles'), { recursive: true });

const out = [
  '# Archivo maestro de la escritura a Kepler — [KR.14]. NO VERSIONAR. Generado por',
  '# ops/prod/kepler-push-secretos.js. Alimenta el secreto k3s `kepler-push` (namespace prod).',
  '#',
  '# ⛔ Línea comentada = servidor APAGADO. Encender = descomentar, recrear el secreto y',
  '#    reiniciar `api` (comandos al final). Protocolo: KEPLER_PUSH_DESPLIEGUE.md §9.',
  '# ⛔ Las URL de superusuario NO van aquí: van en kepler-admin.env, que nunca entra al clúster.',
  '',
];
const resumen = [];

for (const [s, srv] of Object.entries(SERVIDORES)) {
  const kUrl = `KEPLER_PUSH_URL_${s}`;
  let pass = passDe(previo[kUrl]?.valor);
  let origen = 'ya estaba en el maestro';
  if (!pass && s === '00') { pass = passDe(process.env.KEPLER_PUSH_URL_00 || process.env.KEPLER_PUSH_URL); origen = 'tomada del .env local (rol ya creado)'; }
  if (!pass) { pass = clave(); origen = 'NUEVA — falta crear el rol con roles/md_' + s + '.sql'; }

  // Por defecto, encendido SÓLO `00` y sólo compra, con tope 1 (paso P1). El resto, apagado.
  const activaDef = s === '00';
  const act = (k, def) => (previo[k] ? previo[k].activa : def);
  const val = (k, def) => (previo[k] ? previo[k].valor : def);
  const linea = (k, def, activaDefecto) => `${act(k, activaDefecto) ? '' : '# '}${k}=${val(k, def)}`;
  const [req, ped] = PLANTILLAS[s] || [];

  out.push(`# ── ${s} · ${srv.host}:${srv.port}/md_${s} ${'─'.repeat(40)}`);
  out.push(linea(kUrl, 'postgresql://kepler_push:' + pass + `@${srv.host}:${srv.port}/md_${s}`, activaDef));
  out.push(linea(`KEPLER_REQ_TEMPLATE_FOLIO_${s}`, req || '', activaDef));
  out.push(ped ? linea(`KEPLER_PED_TEMPLATE_FOLIO_${s}`, ped, false) : `# (sin plantilla sana de traspaso en ${s})`);
  out.push(linea(`KEPLER_PUSH_MAX_DIA_${s}`, '1', activaDef));
  out.push('');

  if (s !== '00' && !fs.existsSync(path.join(DIR, 'roles', `md_${s}.sql`))) {
    fs.writeFileSync(path.join(DIR, 'roles', `md_${s}.sql`), [
      `-- [KR.14] Rol de escritura de la Suite en md_${s} (${srv.host}:${srv.port}).`,
      `-- Correr UNA vez como superusuario (${srv.su || 'postgres'}). NO VERSIONAR: trae la contraseña.`,
      `DO $$ BEGIN`,
      `  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kepler_push') THEN`,
      `    RAISE EXCEPTION 'kepler_push ya existe en md_${s}: no se pisa su contraseña. Revisar a mano.';`,
      `  END IF;`,
      `  CREATE ROLE kepler_push LOGIN PASSWORD '${pass}';`,
      `END $$;`,
      `GRANT CONNECT, TEMPORARY ON DATABASE md_${s} TO kepler_push;`,
      `GRANT USAGE ON SCHEMA md TO kepler_push;`,
      `GRANT SELECT ON md.kdm1, md.kdm2, md.pv_suc_ip, md.kdxd, md.kdii TO kepler_push;`,
      `GRANT INSERT ON md.kdm1, md.kdm2 TO kepler_push;`,
      ``,
      `-- Y en pg_hba.conf (después: SELECT pg_reload_conf();):`,
      `--   host  md_${s}  kepler_push  ${PROD_IP}/32  scram-sha-256     <- prod`,
      `--   host  md_${s}  kepler_push  ${OPERADOR_IP}/32  scram-sha-256  <- para correr revisar`,
      ``,
    ].join('\n'), { mode: 0o600 });
  }
  resumen.push(`${s}  ${act(kUrl, activaDef) ? 'ENCENDIDO' : 'apagado  '}  contraseña ${origen}`);
}

out.push('');
out.push('# ── Cargar en prod (en md, con este archivo copiado a ~/kepler-push.env):');
out.push('#   kubectl -n prod create secret generic kepler-push --from-env-file=$HOME/kepler-push.env \\');
out.push('#     --dry-run=client -o yaml | kubectl apply -f -');
out.push('#   kubectl -n prod rollout restart deployment/api');
out.push('#   kubectl -n prod logs deployment/api | grep "Escritura a Kepler"');
out.push('# ── Apagar TODO de golpe:  kubectl -n prod delete secret kepler-push && kubectl -n prod rollout restart deployment/api');

fs.writeFileSync(MAESTRO, out.join('\n') + '\n', { mode: 0o600 });

const ADMIN = path.join(DIR, 'kepler-admin.env');
if (!fs.existsSync(ADMIN)) {
  fs.writeFileSync(ADMIN, [
    '# URL de SUPERUSUARIO por servidor, SÓLO para el rollback (kepler-push-ops.js deshacer/restaurar).',
    '# ⛔ NUNCA al clúster ni al .env del repo. Llenar sólo el día que se necesite y vaciar después.',
    ...Object.keys(SERVIDORES).map((s) => `# KEPLER_ADMIN_URL_${s}=postgresql://<superusuario>` + ':<clave>@' + `${SERVIDORES[s].host}:${SERVIDORES[s].port}/md_${s}`),
    '',
  ].join('\n'), { mode: 0o600 });
}

console.log(`Maestro: ${MAESTRO}`);
console.log(`Roles:   ${path.join(DIR, 'roles')}`);
console.log(`Admin:   ${ADMIN}`);
console.log('');
resumen.forEach((r) => console.log(r));

console.log('\n⚠️ En Windows el modo 600 no aplica: la carpeta queda con los permisos de tu usuario.');
