BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '300s';
SELECT 'sysid', system_identifier FROM pg_control_system();
