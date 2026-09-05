/**
 * catalogo-kp — admin usuarios
 *
 * **Portada desde `apps/catalogo-kp/sql/001_create_users.sql` (CV.22, review del PR #62).**
 * admin.usuarios — usuarios del tablero de catalogo-kp (auth propio, bcrypt).
 *
 * Antes estos schemas vivían en `KP_CONCENTRADA` y se aplicaban a mano con
 * `psql` como superusuario. Con el repunte de catalogo-kp a `postgres_platform`
 * pasan a ser migraciones versionadas de la Suite, corridas por el mismo
 * `knexfile-newdb.js` que el resto — que es lo que pidió el review: que no
 * queden sueltas contra una base ajena.
 *
 * **Idempotente**: el SQL original ya venía escrito así (`CREATE ... IF NOT
 * EXISTS`, `ADD COLUMN IF NOT EXISTS`, bloques `DO $$ IF NOT EXISTS ... $$`
 * para los constraints), así que se ejecuta tal cual, sin reescribirlo. Se
 * preserva a propósito el texto y los comentarios originales: son la
 * documentación de por qué cada columna existe, y reescribirlos los perdería.
 *
 * Los GRANT del archivo van a `app_runtime`, que es el rol de runtime de esta
 * base — el mismo que ya tiene SELECT sobre `kepler_ods` (mig 20260811120000).
 * El rol dedicado `catalogo_kp_runtime` de `sql/007_rol_dedicado.sql` queda
 * **obsoleto**: existía para no compartir credencial entre dos bases del mismo
 * cluster (GOTCHAS §24), y ahora hay una sola base.
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  await knex.raw(`-- Tabla de usuarios de la aplicación.
--
-- Ejecutar en KP_CONCENTRADA con una cuenta administrativa:
--   psql -h 192.168.0.245 -U postgres -d KP_CONCENTRADA -f 001_create_users.sql
--
-- IMPORTANTE: este archivo NO crea ninguna cuenta.
-- Antes traía un usuario administrador sembrado con una contraseña escrita en
-- texto plano en un comentario, y este archivo viaja dentro de los respaldos:
-- cualquiera que abriera el ZIP tenía la contraseña del administrador.
-- El alta del primer usuario se hace aparte (ver el bloque del final).

CREATE SCHEMA IF NOT EXISTS admin;

CREATE TABLE IF NOT EXISTS admin.usuarios (
  id           SERIAL PRIMARY KEY,
  email        VARCHAR(120) UNIQUE NOT NULL,
  nombre       VARCHAR(80)  NOT NULL,
  password     VARCHAR(200) NOT NULL,          -- hash bcrypt, nunca la contraseña
  rol          VARCHAR(20)  NOT NULL DEFAULT 'viewer',  -- admin | editor | viewer
  activo       BOOLEAN      NOT NULL DEFAULT TRUE,
  sucursales   TEXT[]       DEFAULT '{}',      -- vacío = todas
  creado_en    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  ultimo_login TIMESTAMPTZ
);

-- La API sólo necesita leer esta tabla para validar el login.
GRANT USAGE ON SCHEMA admin TO app_runtime;
GRANT SELECT ON admin.usuarios TO app_runtime;

-- ---------------------------------------------------------------------------
-- ALTA DEL PRIMER ADMINISTRADOR
--
-- NO se incluye aquí a propósito. Para crearlo:
--
--   1. Genera el hash en el servidor, sin dejar la contraseña en ningún archivo:
--        node -e "require('bcrypt').hash(process.argv[1],10).then(h=>console.log(h))" "TU_CONTRASENA"
--
--   2. Inserta usando ese hash:
--        INSERT INTO admin.usuarios (email, nombre, password, rol)
--        VALUES ('alguien@megadulces.com.mx', 'Nombre', '<hash>', 'admin');
--
--   3. Borra el historial de la terminal si la contraseña quedó ahí:
--        Clear-History; Remove-Item (Get-PSReadlineOption).HistorySavePath
--
-- Reglas: una cuenta por persona (no compartidas), y contraseñas que no se
-- reutilicen de otros sistemas.
-- ---------------------------------------------------------------------------`);
};

/**
 * Sin `down`. Estos schemas guardan **pedidos de clientes con dinero real**
 * (`tienda.pedidos`), los usuarios del tablero y el historial de errores: un
 * rollback de esquema no puede llevárselos por delante. Mismo criterio que el
 * resto de las migraciones de datos vivos del repo. Para desarmarlo, se hace a
 * mano y a conciencia.
 *
 * @param { import("knex").Knex } knex
 */
exports.down = async function () {
  // no-op deliberado (ver arriba)
};
