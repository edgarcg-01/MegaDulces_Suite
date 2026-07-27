-- Fase CP (ADR-035) — Login SQL de SOLO LECTURA para el conector ContPAQi.
-- Ejecutar UNA vez en la instancia SQL Server de ContPAQi como sysadmin (sa o admin del server):
--   sqlcmd -S ".\COMPAC" -E -i 00-create-readonly-login.sql          (auth Windows, en el server)
--   sqlcmd -S "192.168.0.35\COMPAC" -U sa -P <clave> -i 00-create-readonly-login.sql
--
-- Crea/actualiza el login `platform_ro` con db_datareader (SELECT, cero escritura) en TODAS
-- las empresas + VIEW ANY DATABASE/DEFINITION (para enumerar y leer el esquema). Idempotente.
-- CHECK_POLICY=OFF permite una contraseña simple de servicio (LAN interna, read-only).
-- Empresa nueva creada después → re-ejecutar (el cursor la agrega).

USE [master];

IF EXISTS (SELECT 1 FROM sys.server_principals WHERE name = N'platform_ro')
  ALTER LOGIN [platform_ro] WITH PASSWORD = N'superoot', CHECK_POLICY = OFF;
ELSE
  CREATE LOGIN [platform_ro] WITH PASSWORD = N'superoot', CHECK_POLICY = OFF, DEFAULT_DATABASE = [master];

GRANT VIEW ANY DATABASE   TO [platform_ro];
GRANT VIEW ANY DEFINITION TO [platform_ro];

DECLARE @db SYSNAME, @s NVARCHAR(MAX);
DECLARE c CURSOR LOCAL FAST_FORWARD FOR
  SELECT name FROM sys.databases WHERE database_id > 4 AND state = 0;
OPEN c; FETCH NEXT FROM c INTO @db;
WHILE @@FETCH_STATUS = 0
BEGIN
  SET @s = N'USE ' + QUOTENAME(@db) + N';
    IF NOT EXISTS (SELECT 1 FROM sys.database_principals WHERE name = N''platform_ro'')
      CREATE USER [platform_ro] FOR LOGIN [platform_ro];
    ALTER ROLE [db_datareader] ADD MEMBER [platform_ro];';
  EXEC sys.sp_executesql @s;
  FETCH NEXT FROM c INTO @db;
END
CLOSE c; DEALLOCATE c;
