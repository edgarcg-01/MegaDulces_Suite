const { Client } = require('pg');
(async () => {
  for (const db of ['KP_CONCENTRADA','Mega_Dulces']) {
    const c = new Client({ connectionString: `postgresql://postgres:superoot@192.168.0.245:5432/${db}`, connectionTimeoutMillis: 8000 });
    try {
      await c.connect();
      const t = (await c.query(`SELECT table_schema, table_name FROM information_schema.tables WHERE table_name ILIKE 'kdii' ORDER BY 1`)).rows;
      console.log(`\n[${db}] tablas kdii:`, JSON.stringify(t));
      for (const row of t) {
        const sch = row.table_schema;
        try {
          const q = await c.query(`SELECT c1 sku, c2 nombre, c7 barcode, c11 unidad, c90 pieza, c80 u1, c81 f1, c91 p1, c83 u2, c84 f2, c92 p2 FROM "${sch}".kdii WHERE btrim(c7)='6925374538055' OR c2 ILIKE '%OJILOCOS%' LIMIT 10`);
          console.log(`   ${sch}.kdii OJILOCOS/barcode →`, JSON.stringify(q.rows,null,2));
        } catch(e){ console.log(`   ${sch}.kdii query err:`, e.message); }
      }
      await c.end();
    } catch(e){ console.log(`[${db}] conexión err:`, e.message); try{await c.end();}catch{} }
  }
})();
