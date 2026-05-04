const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

module.exports = {
  development: {
    client: 'postgresql',
    connection: {
      host: process.env.DB_HOST || 'localhost',
      port: Number(process.env.DB_PORT) || 5432,
      database: process.env.DB_NAME || 'trade_marketing',
      user: process.env.DB_USER || 'postgres',
      password: process.env.DB_PASSWORD || 'postgres',
    },
    pool: { min: 2, max: 10 },
    migrations: {
      tableName: 'knex_migrations_products',
      directory: path.join(__dirname, 'migrations-products'),  
      loadExtensions: ['.js'],
    },
  },
  production: {
    client: 'postgresql',
    connection: process.env.DATABASE_URL
      ? { connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } }
      : {
          host: process.env.DB_HOST,
          port: Number(process.env.DB_PORT),
          database: process.env.DB_NAME,
          user: process.env.DB_USER,
          password: process.env.DB_PASSWORD,
          ssl: { rejectUnauthorized: false },
        },
    pool: { min: 2, max: 10 },
    migrations: {
      tableName: 'knex_migrations_products',
      directory: path.join(__dirname, 'migrations-products'),
      extension: 'js',
    },
  },
};
