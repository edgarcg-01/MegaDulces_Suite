'use strict';
/**
 * `[CH.1.4]` — Da de alta la cuenta del checador (kiosco de asistencia) de cada sitio.
 *
 * Una cuenta de DISPOSITIVO por sitio (`checador.NN`, llave canónica de 2 dígitos de
 * `[RE.23]`), rol `checador_kiosco` — que la migración
 * `20260909131000_rol_checador_kiosco.js` deja con la sola clave
 * `HR_ATTENDANCE_CHECAR` y el alcance recortado a su sucursal.
 *
 * ── Lo que hace distinto a este script: el token no expira cada mañana ───────
 * Cada cuenta nace con `token_ttl_days = 365` (columna de
 * `20260909130000_users_token_ttl_days.js`), así que su JWT vive un año en vez de las
 * 12 h globales. Es lo que permite que la pantalla se prenda una vez y se quede
 * prendida. Sigue siendo revocable: `activo = false` la mata en ≤30 s
 * (`[AUTHZ-HARD.2]`, `jwt-auth.guard`), y por eso hay UNA cuenta por sitio — apagar un
 * kiosco comprometido no puede implicar apagar los otros.
 *
 * ── Por qué un script y no una migración ─────────────────────────────────────
 * Crear un usuario exige una contraseña, y un hash de contraseña no va en un archivo
 * versionado. La CONFIGURACIÓN (rol, alcance, la columna del TTL) va en migraciones;
 * el alta de cuentas, acá. Misma división que `provision-etiqueteras.js`.
 *
 * ── De dónde sale la lista de sitios ─────────────────────────────────────────
 * NO está escrita a mano: se deriva de `commercial.warehouses` con zona asignada —
 * los mismos sitios con nombre que usa la etiquetera. `--sucursal NN` (repetible)
 * acota el alta a las que se quieran arrancar.
 *
 * ⚠️ **La correspondencia kiosco ↔ reloj ZKTeco no se puede establecer hoy.** Los 11
 * checadores de `hr.attendance_devices` tienen `label`/`site_code` en NULL (item
 * `[CH.0.7]` abierto) y viven en subredes que no se pueden mapear a sucursal sin
 * adivinar. Este script provisiona por SITIO, que es el único inventario con nombre;
 * atar cada cuenta a su equipo es trabajo de CH.0.7, no de acá.
 *
 * ── La contraseña ────────────────────────────────────────────────────────────
 * Una por sitio, aleatoria, sin caracteres ambiguos (no hay `0/O` ni `1/l/I`: se
 * teclea en un kiosco del piso, una sola vez). `must_change_password = false` a
 * propósito: si se forzara el cambio, la primera persona lo cambia y el kiosco queda
 * afuera. Las contraseñas en claro NO se imprimen ni entran a git: van a un archivo
 * fuera del repo y el script sólo dice la ruta.
 *
 * `kind = 'interno'` a propósito: `kind = 'servicio'` bloquea el login interactivo
 * (`[ID.17]`, `auth-mt.service`) y a esta cuenta la teclea una persona una vez.
 *
 * ── Uso ──────────────────────────────────────────────────────────────────────
 *   node database/scripts/provision-checadores.js                      # dry-run, todos
 *   node database/scripts/provision-checadores.js --sucursal 03        # dry-run, una
 *   node database/scripts/provision-checadores.js --sucursal 03 --apply
 *   node database/scripts/provision-checadores.js --apply --ttl-dias 180
 *
 * Idempotente: el sitio que ya tiene su `checador.NN` se saltea y a esa cuenta no se
 * le toca la contraseña.
 *
 * Guarda invertida (igual que el de etiqueteras): `--apply` exige que el destino sea
 * prod, porque el padrón vive en prod y crear cuentas en la base compartida entre
 * devs le ensucia el padrón a otro.
 *
 * NUNCA imprime la cadena de conexión.
 */
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env') });
const { Client } = require('pg');
const bcrypt = require('bcryptjs');

const APLICAR = process.argv.includes('--apply');
const URL = process.env.FLEET_DB_URL;

const ROL = 'checador_kiosco';
const CLAVE = 'HR_ATTENDANCE_CHECAR';
/** Llave canónica de sucursal de 2 dígitos, `[RE.23]`. */
const BK = "(CASE WHEN w.code ~ '^[0-9]{2}$' THEN w.code ELSE w.wincaja_source_branch END)";

/** Dónde caen las contraseñas en claro. Fuera del repo, a propósito. */
const SALIDA = path.join('C:', 'tmp', `checadores-credenciales-${new Date().toISOString().slice(0, 10)}.txt`);

/** `--sucursal 03 --sucursal 04` → ['03','04']. Vacío = todas las derivadas. */
function sucursalesPedidas() {
  const out = [];
  const a = process.argv;
  for (let i = 0; i < a.length; i++) {
    if (a[i] === '--sucursal' && a[i + 1]) out.push(String(a[i + 1]).padStart(2, '0'));
  }
  return out;
}

/** `--ttl-dias N`. Default 365; el CHECK de la columna acota 1..3650. */
function ttlDias() {
  const i = process.argv.indexOf('--ttl-dias');
  if (i === -1) return 365;
  const n = Number(process.argv[i + 1]);
  if (!Number.isFinite(n) || n < 1 || n > 3650) {
    console.error('--ttl-dias debe ser un entero entre 1 y 3650 (el CHECK de la columna lo exige).');
    process.exit(1);
  }
  return Math.trunc(n);
}

if (!URL) {
  console.error('Falta FLEET_DB_URL en .env');
  process.exit(1);
}
if (APLICAR && !/rlwy\.net|railway/i.test(URL)) {
  console.error('ABORT: --apply exige que FLEET_DB_URL apunte a prod. El padron vive en prod.');
  process.exit(3);
}

/** Sin caracteres ambiguos: se teclea en un kiosco, a veces a mano alzada. */
const ALFABETO = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
function password(largo = 12) {
  const bytes = crypto.randomBytes(largo * 2);
  let out = '';
  for (let i = 0; out.length < largo && i < bytes.length; i++) {
    // Rechazo del resto para no sesgar hacia el principio del alfabeto.
    if (bytes[i] < 256 - (256 % ALFABETO.length)) out += ALFABETO[bytes[i] % ALFABETO.length];
  }
  return out;
}

(async () => {
  const TTL = ttlDias();
  const PEDIDAS = sucursalesPedidas();
  // SSL sólo si el destino es Railway: con `ssl` prendido contra un Postgres local la
  // conexión falla, y el dry-run contra la base de dev es justo cómo se verifica este
  // script sin tocar el padrón de prod.
  const c = new Client({
    connectionString: URL,
    ssl: /rlwy\.net|railway|proxy/i.test(URL) ? { rejectUnauthorized: false } : false,
  });
  await c.connect();
  console.log(`Modo: ${APLICAR ? 'APLICAR' : 'dry-run (ROLLBACK al final)'} · TTL del token: ${TTL} día(s)`);
  console.log(PEDIDAS.length ? `Sucursales pedidas: ${PEDIDAS.join(', ')}\n` : 'Sucursales: todas las derivadas\n');

  try {
    await c.query('BEGIN');

    // ── Gate 0: la columna del TTL tiene que existir ──────────────────────────
    // Sin ella el INSERT falla, pero el mensaje de Postgres no dice qué hacer. Y si
    // alguien la quitara, estas cuentas volverían al TTL de 12h en silencio: el kiosco
    // pediría login cada mañana y nadie sabría por qué.
    const { rows: col } = await c.query(
      `SELECT count(*)::int n FROM information_schema.columns
        WHERE table_schema='identity' AND table_name='users' AND column_name='token_ttl_days'`,
    );
    if (!col[0].n) {
      throw new Error('Falta identity.users.token_ttl_days. Corré la migración 20260909130000 primero.');
    }

    // ── Gate 1: el rol tiene que existir y estar recortado ────────────────────
    // Si la migración no corrió, esto se para acá en vez de crear N cuentas con
    // permisos de más.
    const { rows: rol } = await c.query(
      `SELECT rp.tenant_id,
              (rp.permissions -> $2::text = 'true'::jsonb) AS concede,
              (SELECT count(*)::int FROM jsonb_each(rp.permissions) e(k, v) WHERE v = 'true'::jsonb) AS claves
         FROM identity.role_permissions rp
        WHERE rp.role_name = $1 AND rp.deleted_at IS NULL`,
      [ROL, CLAVE],
    );
    if (!rol.length) throw new Error(`El rol ${ROL} no existe. Corré la migración 20260909131000 primero.`);
    for (const r of rol) {
      if (!r.concede) throw new Error(`El rol ${ROL} no concede ${CLAVE}.`);
      if (r.claves !== 1) {
        throw new Error(`El rol ${ROL} concede ${r.claves} claves, se esperaba 1 (${CLAVE}).`);
      }
    }

    // ── Los sitios, derivados. Con LEFT JOIN a la cuenta que le tocaría ───────
    const { rows: sitios } = await c.query(
      `WITH t AS (
         SELECT w.tenant_id, ${BK} AS bk, w.name AS sucursal, z.id AS zona_id, z.name AS zona
           FROM commercial.warehouses w
           JOIN trade.zones z ON z.tenant_id = w.tenant_id AND z.id = w.zone_id
          WHERE w.deleted_at IS NULL AND ${BK} ~ '^[0-9]{2}$')
       SELECT t.*, u.username AS ya_existe
         FROM t
         LEFT JOIN identity.users u
           ON u.tenant_id = t.tenant_id AND u.deleted_at IS NULL
          AND u.username = 'checador.' || t.bk
        ORDER BY t.bk`,
    );

    const enAlcance = PEDIDAS.length ? sitios.filter((s) => PEDIDAS.includes(s.bk)) : sitios;
    const desconocidas = PEDIDAS.filter((p) => !sitios.some((s) => s.bk === p));
    if (desconocidas.length) {
      throw new Error(
        `No existe(n) la(s) sucursal(es) ${desconocidas.join(', ')} en commercial.warehouses con zona. ` +
          `Derivadas: ${sitios.map((s) => s.bk).join(', ')}`,
      );
    }

    console.log(`Sitios derivados de commercial.warehouses con zona: ${sitios.length}`);
    for (const s of sitios) {
      const dentro = enAlcance.includes(s);
      const marca = s.ya_existe ? '=' : dentro ? '+' : '·';
      const estado = s.ya_existe ? `ya tiene ${s.ya_existe}` : dentro ? 'ALTA' : 'fuera de --sucursal';
      console.log(`  ${marca} ${s.bk}  ${String(s.sucursal).padEnd(30)} ${String(s.zona).padEnd(18)} ${estado}`);
    }

    // ── Contexto que se DECLARA, no se adivina: los relojes ZK ────────────────
    // La cuenta es del SITIO. Cuál reloj está en cuál sitio no se sabe (CH.0.7), y
    // callarlo dejaría creer que la cuenta quedó atada a un equipo.
    try {
      const { rows: zk } = await c.query(
        `SELECT count(*)::int total, count(site_code)::int con_sitio FROM hr.attendance_devices`,
      );
      if (zk[0].total) {
        console.log(
          `\n  ZKTeco en hr.attendance_devices: ${zk[0].total} equipo(s), ${zk[0].con_sitio} con site_code.` +
            (zk[0].con_sitio < zk[0].total ? '  ← CH.0.7: la cuenta NO queda atada a un equipo.' : ''),
        );
      } else {
        console.log('\n  hr.attendance_devices está vacío en este destino (el inventario vive en la base dedicada `hr`).');
      }
    } catch {
      console.log('\n  hr.attendance_devices no existe en este destino (la migración de CH.0 no corrió acá).');
    }

    const faltan = enAlcance.filter((s) => !s.ya_existe);
    if (!faltan.length) {
      console.log('\nTodos los sitios en alcance ya tienen su checador. Nada que hacer.');
      await c.query('ROLLBACK');
      return;
    }

    console.log(`\n${faltan.length} alta(s) por hacer.\n`);
    const credenciales = [];
    for (const s of faltan) {
      const username = `checador.${s.bk}`;
      const pass = password();
      const hash = await bcrypt.hash(pass, 10);
      await c.query(
        `INSERT INTO identity.users
           (tenant_id, username, password_hash, nombre, role_name, zona_id, warehouse_code,
            department_code, position_code, kind, status, activo, must_change_password, token_ttl_days)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'tienda', NULL, 'interno', 'active', true, false, $8)`,
        [s.tenant_id, username, hash, `Checador - ${s.sucursal}`, ROL, s.zona_id, s.bk, TTL],
      );
      credenciales.push({ username, pass, sucursal: s.sucursal, zona: s.zona, bk: s.bk });
      console.log(`  ✓ ${username.padEnd(16)} ${s.sucursal}`);
    }

    // ── Gates, dentro de la misma transacción ─────────────────────────────────
    // (a) Cada cuenta creada quedó con el TTL pedido. Es LO que hace este script:
    //     si el INSERT lo perdiera (columna renombrada, default que gana), el kiosco
    //     pediría login cada mañana y el script habría reportado éxito igual.
    const { rows: g1 } = await c.query(
      `SELECT username, token_ttl_days FROM identity.users
        WHERE username = ANY($1) AND deleted_at IS NULL`,
      [credenciales.map((x) => x.username)],
    );
    const sinTtl = g1.filter((r) => Number(r.token_ttl_days) !== TTL);
    if (sinTtl.length) {
      throw new Error(
        `Cuenta(s) sin el TTL de ${TTL}d: ${sinTtl.map((r) => r.username + '=' + r.token_ttl_days).join(', ')}`,
      );
    }
    console.log(`  ✓ ${g1.length} cuenta(s) con token_ttl_days = ${TTL}.`);

    // (b) Ninguna con un rol complemento: el JWT lleva la UNIÓN de los roles
    //     (`[ID.13]`), así que un rol de más le regala permisos al kiosco.
    const { rows: g2 } = await c.query(
      `SELECT u.username, ur.role_name FROM identity.users u
         JOIN identity.user_roles ur ON ur.tenant_id = u.tenant_id AND ur.user_id = u.id
        WHERE u.username ~ '^checador[.]' AND u.deleted_at IS NULL AND ur.role_name <> $1`,
      [ROL],
    );
    if (g2.length) {
      throw new Error(`Checadores con rol de mas: ${g2.map((r) => r.username + '/' + r.role_name).join(', ')}`);
    }

    // (c) Prueba NEGATIVA del hash: verifica contra la contraseña generada y NO
    //     contra otra. Un gate sin prueba negativa es una intención.
    for (const cred of credenciales) {
      const { rows } = await c.query('SELECT password_hash FROM identity.users WHERE username = $1', [cred.username]);
      const ok = await bcrypt.compare(cred.pass, rows[0].password_hash);
      const noOk = await bcrypt.compare(cred.pass + 'x', rows[0].password_hash);
      if (!ok || noOk) throw new Error(`El hash de ${cred.username} no verifica como debe.`);
    }
    console.log(`  ✓ ${credenciales.length} hash(es) verificado(s), y rechazan una contraseña distinta.`);

    if (!APLICAR) {
      await c.query('ROLLBACK');
      console.log('\nROLLBACK — dry-run. Con --apply se aplica y se escriben las credenciales.');
      return;
    }

    await c.query('COMMIT');

    // Las credenciales, fuera del repo y sólo después del COMMIT.
    fs.mkdirSync(path.dirname(SALIDA), { recursive: true });
    const cuerpo = [
      `Checadores (kiosco de asistencia) dados de alta el ${new Date().toISOString()}`,
      `Rol: ${ROL} (solo ${CLAVE}). Login: la app de siempre.`,
      `Token de ${TTL} día(s): la pantalla se loguea UNA vez y no vuelve a pedir contraseña.`,
      'No fuerzan cambio de contraseña: si la primera persona la cambia, el kiosco queda afuera.',
      'Para revocar uno: activo = false en identity.users (surte efecto en <=30s). No hace falta',
      'tocar los demás, y por eso hay una cuenta por sitio.',
      '',
      ...credenciales.map((x) => `${x.bk}  ${x.sucursal}  (${x.zona})\n    usuario: ${x.username}\n    clave:   ${x.pass}\n`),
    ].join('\n');
    fs.writeFileSync(SALIDA, cuerpo, { encoding: 'utf8' });
    console.log(`\n✓ COMMIT. ${credenciales.length} alta(s).`);
    console.log(`Credenciales en: ${SALIDA}`);
    console.log('Ese archivo está fuera del repo. Entregalas y borralo.');
    console.log('\n⚠️ La pantalla del checador (CH.0.10) todavía no existe: estas cuentas pueden');
    console.log('   entrar y no tienen a dónde ir hasta que se construya.');
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    console.error(`\nABORT (ROLLBACK): ${e.message}`);
    process.exitCode = 2;
  } finally {
    await c.end();
  }
})();
