-- Tabla de usuarios de la aplicación.
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
-- ---------------------------------------------------------------------------
