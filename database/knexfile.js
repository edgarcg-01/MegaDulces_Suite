"use strict";
const config = {
    development: {
        client: 'pg',
        connection: process.env.DATABASE_URL
            ? { connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } }
            : {
                host: process.env.DB_HOST || 'localhost',
                port: Number(process.env.DB_PORT) || 5432,
                database: process.env.DB_NAME || 'megadulces_logistica',
                user: process.env.DB_USER || 'postgres',
                password: process.env.DB_PASSWORD || 'postgres',
            },
        pool: { min: 2, max: 10 },
    },
    production: {
        client: 'pg',
        connection: process.env.DATABASE_URL
            ? { connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } }
            : {
                host: process.env.DB_HOST,
                port: Number(process.env.DB_PORT),
                database: process.env.DB_NAME || 'megadulces_logistica',
                user: process.env.DB_USER,
                password: process.env.DB_PASSWORD,
                ssl: { rejectUnauthorized: false },
            },
        pool: { min: 2, max: 10 },
    },
};

module.exports = config;
module.exports.connectionConfig = config;
