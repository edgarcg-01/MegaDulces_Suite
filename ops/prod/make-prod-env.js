#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * VL.9 — genera los archivos de secretos de PROD ON-PREM a partir de Railway.
 *
 *   railway variables --service MegaDulces --json > /tmp/mega.json
 *   node ops/prod/make-prod-env.js /tmp/mega.json <destino/>
 *
 * Produce tres archivos en <destino/> (permisos 600, NUNCA versionados):
 *
 *   prod.env           env_file de `api` y `worker`
 *   prod-compose.env   las variables que el PROPIO compose interpola (contraseñas de los
 *                      superusuarios de Postgres, token del túnel)
 *   roles.sql          CREATE ROLE de `app_runtime` y `fdw_verificador_ro`
 *
 * ── Por qué `roles.sql` y no "el dump ya los trae" ──────────────────────────────────────
 * El respaldo diario usa `pg_dump --no-owner --no-privileges`, elegido para portabilidad.
 * Consecuencia medida el 2026-09-22: ese dump NO trae los roles NI los GRANT, y prod tiene
 * **613 políticas RLS que nombran `app_runtime`**. Un `pg_restore` contra una base sin ese
 * rol falla en 613 sentencias — no al principio, sino a la mitad. Los roles se crean ANTES.
 *
 * ⛔ Y lo que este script NO puede resolver, para que nadie lo descubra tarde: los GRANT
 * tampoco están en ese dump. Para el CORTE de verdad hace falta un volcado distinto del
 * respaldo diario — `pg_dumpall --globals-only` (roles con su hash) + `pg_dump` CON
 * privilegios. Este par de archivos alcanza para levantar la copia de verificación, no
 * para cortar. Queda declarado en ops/prod/README.md.
 *
 * ── Qué transforma ──────────────────────────────────────────────────────────────────────
 * Sólo el DESTINO de las URLs (host y puerto). Usuario, contraseña y base se conservan
 * BYTE A BYTE, así que el rol `app_runtime` de la copia se crea con la misma contraseña
 * que ya usa la app y no hay que re-teclear nada. La rotación de credenciales es un paso
 * APARTE y deliberado del corte (ver `ops/ACCESO_RAILWAY.md`), no un efecto secundario.
 *
 * ⚠️ `JWT_SECRET` de prod CONTIENE UN SALTO DE LÍNEA (medido: 87 caracteres, con `\n` al
 * frente). El formato `env_file` de Docker Compose **no admite valores multilínea ni
 * escapes**: no existe forma de expresarlo ahí. Este script lo detecta y lo DECLARA en vez
 * de recortarlo en silencio — recortarlo cambia la firma y **desloguea a todo el mundo**,
 * que es una decisión de corte, no de empaquetado.
 */
const fs = require('node:fs');
const path = require('node:path');

const [, , entrada, destino] = process.argv;
if (!entrada || !destino) {
  console.error('uso: node ops/prod/make-prod-env.js <vars.json> <destino/>');
  process.exit(2);
}

const v = JSON.parse(fs.readFileSync(entrada, 'utf8'));
fs.mkdirSync(destino, { recursive: true });

// ── Destinos on-prem ─────────────────────────────────────────────────────────────────
const MAPA_HOST = {
  // el Postgres principal de Railway -> el contenedor `pg-prod` de este compose
  'postgres-oqkq.railway.internal': { host: 'pg-prod', port: '5432' },
  // el Postgres de embeddings (RAG_PRODUCTS) -> `pg-rag`
  'postgres-7xo5.railway.internal': { host: 'pg-rag', port: '5432' },
};

/** Reescribe SÓLO host y puerto. Usuario/contraseña/base intactos. */
function reapuntar(url) {
  try {
    const u = new URL(url);
    const m = MAPA_HOST[u.hostname];
    if (!m) return { url, cambio: null };
    const antes = `${u.hostname}:${u.port}`;
    u.hostname = m.host;
    u.port = m.port;
    return { url: u.toString(), cambio: `${antes} -> ${m.host}:${m.port}` };
  } catch {
    return { url, cambio: null };
  }
}

// ── Qué se saca, y por qué ───────────────────────────────────────────────────────────
const FUERA = {
  // Las inyecta Railway. On-prem no existen; el código que las lee ya tiene fallback
  // (`RAILWAY_GIT_COMMIT_SHA ?? GIT_COMMIT_SHA ?? 'unknown'`), que abajo se completa.
  '^RAILWAY_': 'la inyecta Railway; no existe on-prem',
  // El compose las fija por servicio (el API y el worker necesitan valores distintos).
  '^(PORT|NODE_ENV)$': 'la fija el compose por servicio',
  // Apunta al servicio `observability` de Railway, que NO se porta en esta entrega. Dejarla
  // haría que el SDK de OTEL intente contra un host inexistente — no falla la app (el
  // exportador traga el error) pero llena el log de ruido y finge telemetría que no llega.
  '^OTEL_EXPORTER_OTLP_ENDPOINT$': 'el colector no se porta en esta entrega (declarado)',
};
const motivoFuera = (k) => {
  for (const [re, motivo] of Object.entries(FUERA)) if (new RegExp(re).test(k)) return motivo;
  return null;
};

const lineas = [];
const sacadas = [];
const reapuntadas = [];
const problematicas = [];

for (const k of Object.keys(v).sort()) {
  const motivo = motivoFuera(k);
  if (motivo) { sacadas.push([k, motivo]); continue; }

  let valor = String(v[k] ?? '');

  if (/^(DATABASE_URL|DATABASE_URL_NEW|DATABASE_URL_NEW_RUNTIME|VECTOR_DATABASE_URL)$/.test(k)) {
    const r = reapuntar(valor);
    valor = r.url;
    if (r.cambio) reapuntadas.push([k, r.cambio]);
  }

  // ⛔ El formato env_file de Compose es `CLAVE=resto-de-la-línea`. No hay comillas ni
  // escapes: un `\n` adentro del valor parte la variable en dos y la segunda mitad se lee
  // como una clave basura. Así que el valor se RECORTA — pero recortar no significa lo
  // mismo para todas, y la diferencia se declara en vez de taparse:
  //
  //   · si el consumidor ya hace `.trim()`, recortar no cambia NADA;
  //   · si el valor es una LLAVE, recortar la CAMBIA, o sea que equivale a rotarla.
  //
  // `JWT_SECRET` es el segundo caso: las sesiones firmadas en Railway no validan contra el
  // valor recortado. Para la copia de verificación da igual (no hay nadie logueado); en el
  // CORTE es una decisión — y de las que se toman igual, porque `ops/ACCESO_RAILWAY.md` ya
  // prescribe rotar los secretos al cerrar accesos.
  if (/[\r\n]|^\s|\s$/.test(valor)) {
    const recortado = valor.trim();
    // Consumidores que ya normalizan: recortar es demostrablemente inocuo.
    const INOCUAS = /^(DB_HEALTH_ALERT_EMAILS|DB_HEALTH_ALERT_PHONES)$/;
    problematicas.push([
      k,
      INOCUAS.test(k)
        ? `traía borde en blanco — recortada (el consumidor ya hace .trim(); sin efecto)`
        : `traía borde en blanco (${valor.length} -> ${recortado.length}) — recortada = ROTADA DE HECHO`,
    ]);
    valor = recortado;
  }

  lineas.push(`${k}=${valor}`);
}

// Lo que el código espera y Railway daba por otro camino.
lineas.push('# — agregadas por ops/prod/make-prod-env.js —');
lineas.push('GIT_COMMIT_SHA=${GIT_COMMIT_SHA}');  // lo completa deploy.sh con el commit real
lineas.push('API_UPSTREAM=http://api:10000');     // portal y vendor proxean acá
lineas.push('NGINX_RESOLVER=127.0.0.11');         // DNS embebido de Docker, no el de Railway
lineas.push('APP_PUBLIC_URL=http://192.168.0.222:8080'); // el enlace del correo de Salud BD

const fProd = path.join(destino, 'prod.env');
fs.writeFileSync(fProd, lineas.join('\n') + '\n', { mode: 0o600 });

// ── prod-compose.env: lo que interpola el propio compose ─────────────────────────────
// Las contraseñas de superusuario salen de las MISMAS URLs, para que la instancia local
// nazca con las credenciales que la app ya trae y no haya un segundo juego que mantener.
const pass = (url) => { try { return decodeURIComponent(new URL(url).password); } catch { return ''; } };
const compose = [
  `PGPROD_SUPERPASS=${pass(v.DATABASE_URL || '')}`,
  `PGRAG_SUPERPASS=${pass(v.VECTOR_DATABASE_URL || '')}`,
  '# CLOUDFLARE_TUNNEL_TOKEN=  (pendiente: hace falta cuenta de Cloudflare + el dominio en su DNS)',
];
fs.writeFileSync(path.join(destino, 'prod-compose.env'), compose.join('\n') + '\n', { mode: 0o600 });

// ── roles.sql ────────────────────────────────────────────────────────────────────────
const passRuntime = pass(v.DATABASE_URL_NEW_RUNTIME || '');
const sql = `-- Generado por ops/prod/make-prod-env.js — NO versionar (lleva contraseñas).
-- Se aplica ANTES del pg_restore: 613 políticas RLS de prod nombran a app_runtime y el
-- dump del respaldo diario (--no-owner --no-privileges) no trae ni el rol ni los GRANT.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime') THEN
    CREATE ROLE app_runtime LOGIN PASSWORD ${literal(passRuntime)};
  ELSE
    ALTER ROLE app_runtime LOGIN PASSWORD ${literal(passRuntime)};
  END IF;
  -- Rol de sólo-lectura del verificador (FDW). Sin contraseña conocida acá: nace SIN login
  -- y se le pone una cuando se porte ese consumidor. Existe para que las políticas y los
  -- GRANT que lo nombran no fallen.
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'fdw_verificador_ro') THEN
    CREATE ROLE fdw_verificador_ro NOLOGIN;
  END IF;
END $$;
`;
fs.writeFileSync(path.join(destino, 'roles.sql'), sql, { mode: 0o600 });

function literal(s) { return `'${String(s).replace(/'/g, "''")}'`; }

// ── Reporte (nombres y motivos; NUNCA valores) ───────────────────────────────────────
console.log(`\nprod.env            ${lineas.length} líneas`);
console.log(`prod-compose.env    contraseñas de superusuario derivadas de las URLs`);
console.log(`roles.sql           app_runtime${passRuntime ? '' : ' ⚠️ SIN contraseña (no venía en la URL)'} + fdw_verificador_ro`);

console.log(`\nREAPUNTADAS (${reapuntadas.length}):`);
for (const [k, c] of reapuntadas) console.log(`   ${k.padEnd(26)} ${c}`);

console.log(`\nSACADAS (${sacadas.length}):`);
const porMotivo = new Map();
for (const [k, m] of sacadas) porMotivo.set(m, [...(porMotivo.get(m) || []), k]);
for (const [m, ks] of porMotivo) console.log(`   ${ks.length.toString().padStart(2)} · ${m}\n      ${ks.join(' ')}`);

if (problematicas.length) {
  console.log(`\n⚠️  RECORTADAS — env_file de Compose no admite multilínea (${problematicas.length}):`);
  for (const [k, m] of problematicas) console.log(`   ${k.padEnd(26)} ${m}`);
  const rotadas = problematicas.filter(([, m]) => m.includes('ROTADA'));
  if (rotadas.length) {
    console.log('');
    console.log('   ⛔ "ROTADA DE HECHO" significa que el valor on-prem NO ES el de Railway. Para la');
    console.log('      copia de verificación es correcto (nadie está logueado). Para el CORTE:');
    console.log('      con JWT_SECRET distinto, TODA sesión viva se invalida y hay que re-loguear.');
    console.log('      Eso hay que agendarlo, no descubrirlo. `ops/ACCESO_RAILWAY.md` ya prescribe');
    console.log('      rotar los secretos al cerrar accesos, así que conviene hacerlo UNA vez.');
  }
}
console.log('');
