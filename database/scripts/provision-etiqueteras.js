'use strict';
/**
 * `[IDG.9.12]` — Da de alta la etiquetera que le falta a cada tienda.
 *
 * Una cuenta de PUESTO por tienda (`etiquetas.NN`, llave canónica de 2 dígitos
 * de `[RE.23]`), rol `etiquetas_anaquel` — que la migración
 * `20260908140000_etiqueteras_rol_y_convencion.js` deja recortado a la sola
 * clave `STORE_LABELS_VER`.
 *
 * ── Por qué un script y no una migración ─────────────────────────────────────
 * Crear un usuario exige una contraseña, y un hash de contraseña no va en un
 * archivo versionado. La CONFIGURACIÓN (el rol, su alcance, la convención de las
 * cuentas que ya existían) sí va en la migración; el alta de gente, acá.
 *
 * ── De dónde sale la lista de tiendas ────────────────────────────────────────
 * NO está escrita a mano: se deriva de `commercial.warehouses` con zona
 * asignada. Medido en prod — eso da exactamente las 8 tiendas con caja viva hoy
 * (`01` Padre Hidalgo · `02` La Piedad Abastos · `03` 8ESQ · `04` Yurécuaro ·
 * `05` Zamora Centro · `06` Canindo · `30` Morelia Abastos · `32` Morelia
 * Madero), y deja fuera el CEDIS `00` y las 15 filas que son rutas, que no
 * tienen zona. Si mañana abre una tienda, el script la toma solo.
 *
 * ── La contraseña ────────────────────────────────────────────────────────────
 * Una distinta por tienda, aleatoria, sin caracteres ambiguos (no hay `0/O` ni
 * `1/l/I`: se teclea en un kiosco del piso). `must_change_password = false` a
 * propósito: es una credencial compartida por el turno — si se forzara el
 * cambio, la primera persona lo cambia y las demás quedan afuera.
 *
 * Las contraseñas en claro **NO se imprimen** ni entran a git: se escriben a un
 * archivo fuera del repo, y el script sólo dice la ruta.
 *
 * `kind = 'interno'` a propósito: `kind = 'servicio'` bloquea el login
 * interactivo (`[ID.17]`, `auth-mt.service`) y estas cuentas las teclea una
 * persona.
 *
 * ── Uso ──────────────────────────────────────────────────────────────────────
 *   node database/scripts/provision-etiqueteras.js            # dry-run
 *   node database/scripts/provision-etiqueteras.js --apply    # ejecuta
 *
 * Idempotente: la tienda que ya tiene su `etiquetas.NN` se saltea, y a esa
 * cuenta no se le toca la contraseña.
 *
 * Guarda invertida (como `cleanup-test-identity-residue.js`): `--apply` exige
 * que el destino sea prod, porque el padrón vive en prod y crear cuentas en la
 * base compartida entre devs le ensuciaría el padrón a otro.
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

/** Dónde caen las contraseñas en claro. Fuera del repo, a propósito. */
const SALIDA = path.join('C:', 'tmp', `etiqueteras-credenciales-${new Date().toISOString().slice(0, 10)}.txt`);

const ROL = 'etiquetas_anaquel';
/** Llave canónica de sucursal de 2 dígitos, `[RE.23]`. */
const BK = "(CASE WHEN w.code ~ '^[0-9]{2}$' THEN w.code ELSE w.wincaja_source_branch END)";

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
  const c = new Client({ connectionString: URL, ssl: { rejectUnauthorized: false } });
  await c.connect();
  console.log(`Modo: ${APLICAR ? 'APLICAR' : 'dry-run (ROLLBACK al final)'}\n`);

  try {
    await c.query('BEGIN');

    // El rol tiene que existir y estar recortado. Si la migración no corrió, se
    // pararía acá en vez de crear 6 cuentas con permisos de más.
    const { rows: rol } = await c.query(
      `SELECT rp.tenant_id,
              (SELECT count(*)::int FROM jsonb_each(rp.permissions) e(k, v) WHERE v = 'true'::jsonb) AS claves
         FROM identity.role_permissions rp
        WHERE rp.role_name = $1 AND rp.deleted_at IS NULL`,
      [ROL],
    );
    if (!rol.length) throw new Error(`El rol ${ROL} no existe. Corré la migración 20260908140000 primero.`);
    for (const r of rol) {
      if (r.claves !== 1) {
        throw new Error(
          `El rol ${ROL} concede ${r.claves} claves, se esperaba 1 (STORE_LABELS_VER). ` +
            'Corré la migración 20260908140000 antes de dar de alta a nadie.',
        );
      }
    }

    // Las tiendas, derivadas. Con LEFT JOIN a la cuenta que le tocaría.
    const { rows: tiendas } = await c.query(
      `WITH t AS (
         SELECT w.tenant_id, ${BK} AS bk, w.name AS sucursal, z.id AS zona_id, z.name AS zona
           FROM commercial.warehouses w
           JOIN trade.zones z ON z.tenant_id = w.tenant_id AND z.id = w.zone_id
          WHERE w.deleted_at IS NULL AND ${BK} ~ '^[0-9]{2}$')
       SELECT t.*, u.username AS ya_existe
         FROM t
         LEFT JOIN identity.users u
           ON u.tenant_id = t.tenant_id AND u.deleted_at IS NULL
          AND u.username = 'etiquetas.' || t.bk
        ORDER BY t.bk`,
    );

    const faltan = tiendas.filter((t) => !t.ya_existe);
    console.log(`Tiendas derivadas de commercial.warehouses con zona: ${tiendas.length}`);
    for (const t of tiendas) {
      const marca = t.ya_existe ? '=' : '+';
      const estado = t.ya_existe ? `ya tiene ${t.ya_existe}` : 'ALTA';
      console.log(`  ${marca} ${t.bk}  ${String(t.sucursal).padEnd(30)} ${String(t.zona).padEnd(18)} ${estado}`);
    }

    if (!faltan.length) {
      console.log('\nTodas las tiendas ya tienen su etiquetera. Nada que hacer.');
      await c.query('ROLLBACK');
      return;
    }

    console.log(`\n${faltan.length} alta(s) por hacer.\n`);
    const credenciales = [];
    for (const t of faltan) {
      const username = `etiquetas.${t.bk}`;
      const pass = password();
      const hash = await bcrypt.hash(pass, 10);
      await c.query(
        `INSERT INTO identity.users
           (tenant_id, username, password_hash, nombre, role_name, zona_id, warehouse_code,
            department_code, position_code, kind, status, activo, must_change_password)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'tienda', NULL, 'interno', 'active', true, false)`,
        [t.tenant_id, username, hash, `Etiquetas - ${t.sucursal}`, ROL, t.zona_id, t.bk],
      );
      credenciales.push({ username, pass, sucursal: t.sucursal, zona: t.zona, bk: t.bk });
      console.log(`  ✓ ${username.padEnd(16)} ${t.sucursal}`);
    }

    // ── Gates, dentro de la misma transacción ──────────────────────────────
    // (a) Cada tienda con su etiquetera, ninguna de más.
    const { rows: g1 } = await c.query(
      `WITH t AS (
         SELECT w.tenant_id, ${BK} AS bk FROM commercial.warehouses w
           JOIN trade.zones z ON z.tenant_id = w.tenant_id AND z.id = w.zone_id
          WHERE w.deleted_at IS NULL AND ${BK} ~ '^[0-9]{2}$')
       SELECT count(*)::int AS n FROM t
        WHERE NOT EXISTS (
          SELECT 1 FROM identity.users u
           WHERE u.tenant_id = t.tenant_id AND u.deleted_at IS NULL
             AND u.username = 'etiquetas.' || t.bk)`,
    );
    if (g1[0].n > 0) throw new Error(`Quedaron ${g1[0].n} tienda(s) sin etiquetera.`);

    // (b) Ninguna etiquetera con un rol de más (el JWT lleva la union).
    const { rows: g2 } = await c.query(
      `SELECT u.username, ur.role_name FROM identity.users u
         JOIN identity.user_roles ur ON ur.tenant_id = u.tenant_id AND ur.user_id = u.id
        WHERE u.username ~ '^etiquetas[.]' AND u.deleted_at IS NULL AND ur.role_name <> $1`,
      [ROL],
    );
    if (g2.length) throw new Error(`Etiqueteras con rol de mas: ${g2.map((r) => r.username + '/' + r.role_name).join(', ')}`);

    // (c) Prueba NEGATIVA del gate de contraseña: el hash tiene que verificar
    //     contra la que se generó, y NO contra otra. Un gate sin prueba negativa
    //     es una intención.
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
      `Etiqueteras dadas de alta el ${new Date().toISOString()}`,
      `Rol: ${ROL} (solo STORE_LABELS_VER). Login: la app de siempre.`,
      'No fuerzan cambio de contraseña: es una credencial de puesto, compartida por turno.',
      '',
      ...credenciales.map((x) => `${x.bk}  ${x.sucursal}  (${x.zona})\n    usuario: ${x.username}\n    clave:   ${x.pass}\n`),
    ].join('\n');
    fs.writeFileSync(SALIDA, cuerpo, { encoding: 'utf8' });
    console.log(`\n✓ COMMIT. ${credenciales.length} alta(s).`);
    console.log(`Credenciales en: ${SALIDA}`);
    console.log('Ese archivo está fuera del repo. Entregalas y borralo.');
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    console.error(`\nABORT (ROLLBACK): ${e.message}`);
    process.exitCode = 2;
  } finally {
    await c.end();
  }
})();
