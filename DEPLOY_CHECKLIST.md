# Checklist de Deploy a Producción

## 1. Preparar Deploy

### Verificar archivos necesarios estén en git
```bash
git add -A
git commit -m "Migración de productos lista para producción"
git push origin main
```

## 2. Deploy en Railway/Render

### Opción A: Deploy Automático (Git)
1. Railway/Render detectará el push automáticamente
2. El `Dockerfile` construirá la imagen
3. El `start.sh` ejecutará la migración antes de iniciar la API

### Opción B: Deploy Manual con Docker
```bash
# Construir imagen
docker build -t trade-marketing .

# Ejecutar localmente para probar
docker run -e DB_HOST=$DB_HOST -e DB_PORT=$DB_PORT -e DB_NAME=$DB_NAME -e DB_USER=$DB_USER -e DB_PASSWORD=$DB_PASSWORD -p 10000:10000 trade-marketing
```

## 3. Verificar Migración en Producción

### Conectar a BD de Producción y verificar
```bash
# Variables de entorno de producción (Railway/Render ya las configura)
export DB_HOST=tu-host-de-railway
export DB_PORT=5432
export DB_NAME=railway
export DB_USER=postgres
export DB_PASSWORD=tu-password

# Verificar marcas
node -e "
const { Pool } = require('pg');
const pool = new Pool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  ssl: { rejectUnauthorized: false }
});
(async () => {
  const client = await pool.connect();
  const result = await client.query('SELECT COUNT(*) FROM brands');
  console.log('Marcas en producción:', result.rows[0].count);
  const result2 = await client.query('SELECT COUNT(*) FROM products');
  console.log('Productos en producción:', result2.rows[0].count);
  client.release();
  await pool.end();
})();
"
```

## 4. Verificaciones Post-Deploy

### A. Logs del Deploy
Verificar en Railway/Render que se vea:
```
Running product migration...
📦 Iniciando carga de productos desde JSON actualizado...
📊 Total de marcas en JSON: 47
...
✅ Migración completada exitosamente
```

### B. Verificar Migración Ejecutada
```bash
# Conectar a BD de producción y verificar que knex_migrations_products tenga el registro
psql $DATABASE_URL -c "SELECT * FROM knex_migrations_products;"
```

### C. Conteo de Datos Esperado
- Marcas: ~61
- Productos: ~800+
- No debe haber duplicados de "LA ROSA" o "HERSHEY"

### D. Verificar API Funcionando
```bash
curl https://tu-app.railway.app/api/health
curl https://tu-app.railway.app/api/data/version
```

## 5. Si Hay Errores

### Revisar logs de Railway/Render
```bash
# En Railway dashboard o CLI
railway logs
```

### Ejecutar migración manualmente si falló
```bash
# Conectar a Railway via CLI
railway connect

# Ejecutar migración manual
npx knex migrate:latest --knexfile database/knexfile-products.js --env production
```

## 6. Rollback (Si es necesario)

```bash
# Rollback de la última migración
npx knex migrate:rollback --knexfile database/knexfile-products.js --env production
```

## Estado Esperado Final

✅ Aplicación corriendo en producción  
✅ Base de datos con migración ejecutada  
✅ Marcas consolidadas (sin duplicados)  
✅ Productos cargados correctamente  
✅ API respondiendo correctamente  
