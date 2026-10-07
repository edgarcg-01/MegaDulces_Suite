/* eslint-disable */
const { Client } = require('pg');
(async()=>{const c=new Client({connectionString:process.env.CHK_DB});await c.connect();
const cols=await c.query(`SELECT column_name FROM information_schema.columns WHERE table_schema='wincaja' AND table_name='articulos' ORDER BY ordinal_position`);
console.log('articulos cols:', cols.rows.map(r=>r.column_name).join(', '));
await c.end();})().catch(e=>{console.error(e.message);process.exit(1)});
