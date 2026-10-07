# Pasos para Ejecutar Migración de Productos y Backend

## 1. Cargar Productos en la Base de Datos

### Opción A: Usar Script Directo (Recomendado)

```bash
node scripts/load-products-updated.js
```

Este script:
- Lee `scripts/productos_final.json`
- Crea marcas que no existan
- Inserta productos nuevos
- Mueve productos a la marca correcta si están en marca incorrecta
- Mantiene integridad referencial

### Opción B: Usar Migración Knex (Solo Productos)

```bash
npx knex migrate:latest --knexfile database/knexfile-products.js
```

Esta opción usa un knexfile específico que:
- Solo incluye la migración de productos y marcas
- Usa una tabla de migraciones separada (`knex_migrations_products`)
- Evita el sistema de migraciones corrupto del proyecto principal

## 2. Verificar Carga Correcta

### Consultar cantidad de marcas y productos

```bash
node -e "
const { Pool } = require('pg');
require('dotenv').config();
const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432'),
  database: process.env.DB_NAME || 'trade_marketing',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
});
(async () => {
  const client = await pool.connect();
  const brands = await client.query('SELECT COUNT(*) FROM brands');
  const products = await client.query('SELECT COUNT(*) FROM products');
  console.log('Marcas:', brands.rows[0].count);
  console.log('Productos:', products.rows[0].count);
  client.release();
  await pool.end();
})();
"
```

### Verificar productos en marca incorrecta

```bash
node -e "
const { Pool } = require('pg');
require('dotenv').config();
const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432'),
  database: process.env.DB_NAME || 'trade_marketing',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
});
(async () => {
  const client = await pool.connect();
  const result = await client.query(\`
    SELECT p.name as producto, b.name as marca_actual
    FROM products p
    JOIN brands b ON p.brand_id = b.id
    ORDER BY b.name, p.name
    LIMIT 20
  \`);
  console.log('Primeros 20 productos:');
  result.rows.forEach(r => console.log(\`\${r.producto} - \${r.marca_actual}\`));
  client.release();
  await pool.end();
})();
"
```

## 3. Ejecutar Backend

### Iniciar Backend en Desarrollo

```bash
npx nx serve api
```

El backend se iniciará en el puerto `3334`.

### Iniciar Backend en Producción (Docker)

El archivo `start.sh` ya está configurado para ejecutar automáticamente la migración de productos antes de iniciar la API:

```bash
# En start.sh se ejecuta automáticamente:
npx knex migrate:latest --knexfile database/knexfile-products.js --env production
```

Para deploy manual:
```bash
npx nx build api
npx knex migrate:latest --knexfile database/knexfile-products.js --env production
NODE_ENV=production node dist/apps/api/main.js
```

## 4. Ejecutar Frontend

### Iniciar Frontend en Desarrollo

```bash
npx nx serve view
```

El frontend se iniciará en el puerto `4200` con proxy configurado al puerto `3334`.

## 5. Verificar Funcionamiento

1. Abre navegador en `http://localhost:4200`
2. Intenta hacer login
3. Navega a la sección de Reportes
4. Haz clic en el botón **PDF** para probar la nueva funcionalidad

## Archivos Importantes

- `scripts/productos_final.json` - Archivo con datos de productos y marcas
- `scripts/load-products-updated.js` - Script directo para carga de productos
- `database/migrations-products/20260429140000_load_products_from_json_updated.js` - Migración Knex específica
- `database/knexfile-products.js` - Configuración Knex para migración de productos
- `start.sh` - Script de inicio para Docker (ejecuta migración automáticamente)
- `Dockerfile` - Configuración de Docker para producción
- `apps/view/src/app/modules/dashboard/reports/reports.component.ts` - Componente con método PDF

## Notas Importantes

1. **Estructura de Base de Datos:**
   - Tabla `brands`: id, nombre, activo, orden
   - Tabla `products`: id, brand_id, nombre, activo, orden, puntuacion
2. **Integridad Referencial:** El script mantiene las relaciones existentes de productos con otras tablas (captures, exhibitions, etc.)
3. **Mayúsculas:** Todo se normaliza a mayúsculas para evitar duplicados por diferencias de capitalización
4. **Sin Duplicados:** Se verificó que no hay productos duplicados en diferentes marcas en el JSON
5. **Proxy:** El frontend ya está configurado para conectar al backend en puerto 3334
6. **Base de Datos:** Asegúrate de tener el archivo `.env` configurado con las credenciales correctas
