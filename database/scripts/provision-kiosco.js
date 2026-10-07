'use strict';
/**
 * Da de alta las cuentas de KIOSCO: una terminal por sucursal, no una persona.
 *
 * Un kiosco es una pantalla de piso que tiene que entrar sin que nadie teclee una
 * contraseña cada mañana. Ya hay dos clases y comparten todo salvo el rol:
 *
 *   --tipo=verificador  ->  `verificador.NN`  rol `verificador_precios`
 *                           (STORE_PRICE_CHECK_VER, /tienda/verificador)
 *   --tipo=checador     ->  `checador.NN`     rol `checador_kiosco`
 *                           (HR_ATTENDANCE_CHECAR, asistencia)
 *
 * ── Por qué uno solo y no un script por clase ────────────────────────────────
 * Éste nació como `provision-checadores.js`, copia casi exacta de
 * `provision-etiqueteras.js`. Al necesitar el tercero quedaba claro que la copia era
 * el patrón, no la excepción: mismas guardas, mismo generador de contraseña, misma
 * validación de sitio, mismo archivo de credenciales. ADR-056 — un mecanismo que se
 * reinventa en cada fase no cierra la fase. Así que se parametriza.
 *
 * ⬜ DECLARADO: `provision-etiqueteras.js` sigue aparte. Funciona y es anterior;
 * plegarlo acá es churn sobre algo que nadie pidió tocar. Cuando haya que editarlo,
 * que se pliegue.
 *
 * ── Por qué un script y no una migración ─────────────────────────────────────
 * Crear un usuario exige una contraseña, y un hash de contraseña no va en un archivo
 * versionado. La CONFIGURACIÓN (el rol y su alcance) vive en la migración; el alta de
 * cuentas, acá.
 *
 * ── ⚠️ Por qué la lista de sitios va EXPLÍCITA y no derivada ─────────────────
 * `provision-etiqueteras.js` deriva las tiendas de `commercial.warehouses`, y ése es
 * el mejor camino cuando aplica: toda tienda lleva etiquetera. Acá NO aplica — un
 * kiosco no está en toda tienda, y cuáles lo tienen es un hecho del mundo físico que
 * la base no sabe. Derivarlo daría altas de más.
 *
 * Los sitios se pasan y se VALIDAN contra el catálogo: si el código no existe o no
 * tiene zona, **aborta**, no lo inventa.
 *
 * ── La contraseña ────────────────────────────────────────────────────────────
 * Una por sitio, aleatoria, sin caracteres ambiguos (no hay `0/O` ni `1/l/I`: se
 * teclea en un kiosco del piso). `must_change_password = false` a propósito: es una
 * credencial compartida por el turno — si se forzara el cambio, la primera persona lo
 * cambia y las demás quedan afuera.
 *
 * Las contraseñas en claro **NO se imprimen** ni entran a git: van a un archivo fuera
 * del repo y el script sólo dice la ruta.
 *
 * `kind = 'interno'` a propósito: `kind = 'servicio'` bloquea el login interactivo
 * (`[ID.17]`, `auth-mt.service`) y estas cuentas las teclea una persona.
 *
 * ── Uso ──────────────────────────────────────────────────────────────────────
 *   node database/scripts/provision-kiosco.js --tipo=verificador            # dry-run
 *   node database/scripts/provision-kiosco.js --tipo=verificador --apply
 *   node database/scripts/provision-kiosco.js --tipo=checador --sucursales=01,03 --apply
 *
 * Idempotente: el sitio que ya tiene su cuenta se saltea, y no se le toca la
 * contraseña.
 *
 * Guarda invertida: `--apply` exige que el destino sea prod, porque el padrón vive en
 * prod y crear cuentas en la base compartida entre devs se lo ensuciaría a otro.
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

/**
 * Las clases de kiosco. Cada una es un rol de UNA sola clave, creado por su migración.
 * `aviso` sale en el archivo de credenciales: lo que hay que saber al entregarlas.
 */
const TIPOS = {
  verificador: {
    rol: 'verificador_precios',
    clave: 'STORE_PRICE_CHECK_VER',
    prefijo: 'verificador',
    titulo: 'Verificador',
    mig: '20260912130000',
    aviso: 'Entra directo a /tienda/verificador. Funciona sin red (respaldo por sucursal).',
  },
  checador: {
    rol: 'checador_kiosco',
    clave: 'HR_ATTENDANCE_CHECAR',
    prefijo: 'checador',
    titulo: 'Checador',
    mig: '20260909131000',
    aviso: 'AVISO: la pantalla del kiosco de asistencia (CH.0.10) TODAVIA NO EXISTE. '
      + 'Estas cuentas pueden entrar y no tienen a donde ir hasta que se construya.',
  },
};
const tipoArg = (process.argv.find((a) => a.startsWith('--tipo=')) || '').split('=')[1];
const TIPO = TIPOS[tipoArg];

/** Los dos sitios con kiosco hoy: `01` Padre Hidalgo y `03` 8ESQ. */
const SUCURSALES_DEFAULT = ['01', '03'];
const arg = (process.argv.find((a) => a.startsWith('--sucursales=')) || '').split('=')[1];
const SUCURSALES = arg
  ? arg.split(',').map((s) => s.trim()).filter(Boolean)
  : SUCURSALES_DEFAULT;

if (!TIPO) {
  console.error(`ABORT: --tipo espera uno de: ${Object.keys(TIPOS).join(' | ')}. Recibi: ${tipoArg || '(nada)'}`);
  process.exit(3);
}

/** Dónde caen las contraseñas en claro. Fuera del repo, a propósito. */
const SALIDA = path.join('C:', 'tmp', `${TIPO.prefijo}-credenciales-${new Date().toISOString().slice(0, 10)}.txt`);

const ROL = TIPO.rol;
const CLAVE = TIPO.clave;
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
if (!SUCURSALES.every((s) => /^[0-9]{2}$/.test(s))) {
  console.error(`ABORT: --sucursales espera codigos de 2 digitos. Recibi: ${SUCURSALES.join(',')}`);
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
  console.log(`Modo: ${APLICAR ? 'APLICAR' : 'dry-run (ROLLBACK al final)'}`);
  console.log(`Sitios: ${SUCURSALES.join(', ')}${arg ? '' : '  (default)'}\n`);

  try {
    await c.query('BEGIN');

    // (0) El rol tiene que existir y estar recortado. Si la migración no corrió, se
    //     para acá en vez de crear cuentas con permisos de más.
    const { rows: rol } = await c.query(
      `SELECT rp.tenant_id,
              (SELECT count(*)::int FROM jsonb_each(rp.permissions) e(k, v) WHERE v = 'true'::jsonb) AS claves,
              (rp.permissions -> $2) = 'true'::jsonb AS tiene_la_clave
         FROM identity.role_permissions rp
        WHERE rp.role_name = $1 AND rp.deleted_at IS NULL`,
      [ROL, CLAVE],
    );
    if (!rol.length) throw new Error(`El rol ${ROL} no existe. Corré la migración ${TIPO.mig} primero.`);
    for (const r of rol) {
      if (r.claves !== 1 || !r.tiene_la_clave) {
        throw new Error(
          `El rol ${ROL} concede ${r.claves} clave(s) y ${CLAVE}=${r.tiene_la_clave}; se esperaba exactamente 1 y esa. ` +
            `Corré la migración ${TIPO.mig} antes de dar de alta a nadie.`,
        );
      }
    }

    // (1) Los sitios pedidos, VALIDADOS contra el catálogo. Uno que no existe o que
    //     no tiene zona no se inventa: aborta. La zona hace falta porque el alcance
    //     del rol es `zone: own` y sin `zona_id` ese `own` es indistinguible de
    //     `none` — emite el mismo WHERE false (`[ID.26]`).
    const { rows: sitios } = await c.query(
      `WITH t AS (
         SELECT w.tenant_id, ${BK} AS bk, w.name AS sucursal, z.id AS zona_id, z.name AS zona
           FROM commercial.warehouses w
           LEFT JOIN trade.zones z ON z.tenant_id = w.tenant_id AND z.id = w.zone_id
          WHERE w.deleted_at IS NULL AND ${BK} = ANY($1))
       SELECT t.*, u.username AS ya_existe
         FROM t
         LEFT JOIN identity.users u
           ON u.tenant_id = t.tenant_id AND u.deleted_at IS NULL
          AND u.username = $2 || '.' || t.bk
        ORDER BY t.bk`,
      [SUCURSALES, TIPO.prefijo],
    );

    const encontrados = new Set(sitios.map((s) => s.bk));
    const ausentes = SUCURSALES.filter((s) => !encontrados.has(s));
    if (ausentes.length) throw new Error(`Estos codigos no existen en commercial.warehouses: ${ausentes.join(', ')}`);
    const sinZona = sitios.filter((s) => !s.zona_id);
    if (sinZona.length) {
      throw new Error(
        `Sin zona asignada: ${sinZona.map((s) => s.bk).join(', ')}. ` +
          'El rol es zone:own — sin zona la cuenta no puede resolver su alcance.',
      );
    }

    const faltan = sitios.filter((t) => !t.ya_existe);
    console.log(`Sitios validados contra el catálogo: ${sitios.length}`);
    for (const t of sitios) {
      const marca = t.ya_existe ? '=' : '+';
      const estado = t.ya_existe ? `ya tiene ${t.ya_existe}` : 'ALTA';
      console.log(`  ${marca} ${t.bk}  ${String(t.sucursal).padEnd(20)} ${String(t.zona).padEnd(16)} ${estado}`);
    }

    if (!faltan.length) {
      console.log('\nTodos los sitios ya tienen su cuenta de kiosco. Nada que hacer.');
      await c.query('ROLLBACK');
      return;
    }

    console.log(`\n${faltan.length} alta(s) por hacer.\n`);
    const credenciales = [];
    for (const t of faltan) {
      const username = `${TIPO.prefijo}.${t.bk}`;
      const pass = password();
      const hash = await bcrypt.hash(pass, 10);
      await c.query(
        `INSERT INTO identity.users
           (tenant_id, username, password_hash, nombre, role_name, zona_id, warehouse_code,
            department_code, position_code, kind, status, activo, must_change_password)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'tienda', NULL, 'interno', 'active', true, false)`,
        [t.tenant_id, username, hash, `${TIPO.titulo} - ${t.sucursal}`, ROL, t.zona_id, t.bk],
      );
      credenciales.push({ username, pass, sucursal: t.sucursal, zona: t.zona, bk: t.bk });
      console.log(`  ✓ ${username.padEnd(16)} ${t.sucursal}`);
    }

    // ── Gates, dentro de la misma transacción ──────────────────────────────
    // (a) Cada sitio pedido con su cuenta.
    const { rows: g1 } = await c.query(
      `SELECT count(*)::int AS n FROM unnest($1::text[]) bk
        WHERE NOT EXISTS (
          SELECT 1 FROM identity.users u
           WHERE u.deleted_at IS NULL AND u.username = $2 || '.' || bk)`,
      [SUCURSALES, TIPO.prefijo],
    );
    if (g1[0].n > 0) throw new Error(`Quedaron ${g1[0].n} sitio(s) sin cuenta de kiosco.`);

    // (b) Ninguna cuenta con un rol de más: el JWT lleva la UNIÓN de roles, así que
    //     un complemento silencioso le daría a una pantalla de piso permisos que
    //     nadie le concedió a la vista.
    const { rows: g2 } = await c.query(
      `SELECT u.username, ur.role_name FROM identity.users u
         JOIN identity.user_roles ur ON ur.tenant_id = u.tenant_id AND ur.user_id = u.id
        WHERE u.username ~ ('^' || $2 || '[.]') AND u.deleted_at IS NULL AND ur.role_name <> $1`,
      [ROL, TIPO.prefijo],
    );
    if (g2.length) throw new Error(`Cuentas con rol de mas: ${g2.map((r) => r.username + '/' + r.role_name).join(', ')}`);

    // (c) El alcance es RESOLUBLE: sin `warehouse_code` el `warehouse: own` del rol
    //     no distingue de `none` y la cuenta quedaría ciega sin que nada falle.
    const { rows: g3 } = await c.query(
      `SELECT username FROM identity.users
        WHERE username ~ ('^' || $1 || '[.]') AND deleted_at IS NULL
          AND (btrim(coalesce(warehouse_code, '')) = '' OR zona_id IS NULL)`,
      [TIPO.prefijo],
    );
    if (g3.length) throw new Error(`Cuentas sin alcance resoluble: ${g3.map((r) => r.username).join(', ')}`);

    // (d) Prueba NEGATIVA del hash: tiene que verificar contra la contraseña que se
    //     generó y RECHAZAR otra. Un gate sin prueba negativa es una intención.
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
      `Cuentas de kiosco (${tipoArg}) dadas de alta el ${new Date().toISOString()}`,
      `Rol: ${ROL} (solo ${CLAVE}). Login: la app de siempre.`,
      'No fuerzan cambio de contraseña: es una credencial de puesto, compartida por turno.',
      '',
      TIPO.aviso,
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
