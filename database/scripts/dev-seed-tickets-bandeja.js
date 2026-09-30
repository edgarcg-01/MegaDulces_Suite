'use strict';
/**
 * `[TK.12]` — Datos de DESARROLLO para probar la bandeja de `/comercial/tickets`.
 *
 * ── Por qué hace falta ───────────────────────────────────────────────────────────────────────
 * Medido 2026-09-30 en `platform_local`: `kepler_ods.kdm1` tenía 81 movimientos y NINGUNO de
 * venta (todos X-A = compras), y `kdud`/`kduv` estaban vacías. La bandeja era correcta pero
 * mostraba "Nada", y así no se puede juzgar si sirve.
 *
 * Siembra, sobre las tablas CRUDAS de Kepler (las vistas `analytics.erp_sale_tickets`,
 * `erp_sales_invoices` y `v_customer_master` derivan solas de ahí, igual que en prod):
 *   · 12 clientes con nombre (replicados en las 3 sucursales, como el maestro real) + cajeros
 *     y vendedores;
 *   · 10 días hasta HOY (día de México) en las sucursales 01, 02 y 03:
 *       - tickets de mostrador U-D-10 en 3 cajas, ~70% a `CONTADO` (el mostrador es anónimo),
 *         con renglones y parte con precio de lista mayor al cobrado (descuento visible);
 *       - facturas de telemarketing U-D-8 y de contado no fiscal U-D-12, siempre a nombre;
 *   · el folio `0018665` repetido en dos sucursales y dos cajas, para probar la ambigüedad.
 *
 * Todo lo sembrado lleva `kdm1.c11 = 'DEV-SEED-TK10'` y claves de cliente `990xx` / de
 * vendedor `99x`: así `--limpiar` borra SÓLO esto. Cada corrida borra lo suyo y vuelve a
 * sembrar (idempotente), con fechas que siempre terminan hoy.
 *
 * ⛔ **Escribe en `kepler_ods`, así que se niega a correr fuera de local.** Contra otro host
 * aborta: el mismo comando apuntado a prod metería ventas inventadas en el ODS de la empresa.
 *
 * NO es una migración ni un importer: es andamio de desarrollo para poder MIRAR la pantalla.
 *
 * Uso:  node database/scripts/dev-seed-tickets-bandeja.js
 *       node database/scripts/dev-seed-tickets-bandeja.js --limpiar
 */
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env'), quiet: true });

const url = (process.env.DATABASE_URL_NEW || '').replace('localhost', '127.0.0.1');
if (!url) {
  console.error('Falta DATABASE_URL_NEW en el .env.');
  process.exit(1);
}
const host = new URL(url).hostname;
if (host !== '127.0.0.1' && host !== 'localhost') {
  console.error(`⛔ Este script sólo corre contra local. Destino: ${host}. Abortado.`);
  process.exit(1);
}

const knex = require('knex')({ client: 'pg', connection: { connectionString: url }, pool: { min: 1, max: 3 } });
const MARCA = 'DEV-SEED-TK10';
const TENANT = '00000000-0000-0000-0000-00000000d01c';
/** Usuario y contraseña son el mismo: es andamio local, no una cuenta. */
const USUARIO = 'dev_tk10';
const EMISOR = 'EMISOR DE DESARROLLO LOCAL (NO FISCAL)';
const SUCURSALES = ['01', '02', '03'];
const DIAS = 10;
const limpiar = process.argv.includes('--limpiar');

const CLIENTES = [
  ['99001', 'ABARROTES DOÑA MARÍA', 'IRAPUATO'],
  ['99002', 'DULCERÍA EL CARACOL', 'IRAPUATO'],
  ['99003', 'MISCELÁNEA LOS PINOS', 'SALAMANCA'],
  ['99004', 'TIENDA LA ESPERANZA', 'LA PIEDAD'],
  ['99005', 'ABARROTES JIMÉNEZ', 'LA PIEDAD'],
  ['99006', 'DULCES Y BOTANAS RAMÍREZ', 'ZAMORA'],
  ['99007', 'CREMERÍA SAN JOSÉ', 'IRAPUATO'],
  ['99008', 'MINISÚPER EL SOL', 'SALAMANCA'],
  ['99009', 'PAPELERÍA Y DULCERÍA ANA', 'YURÉCUARO'],
  ['99010', 'ABARROTES HERMANOS LÓPEZ', 'ZAMORA'],
  ['99011', 'TIENDITA DE LA ESQUINA', 'IRAPUATO'],
  ['99012', 'FIESTAS Y PIÑATAS GÓMEZ', 'LA PIEDAD'],
];
const CAJEROS = [['991', 'CAJERA LUCÍA PÉREZ'], ['992', 'CAJERO JORGE RUIZ'], ['993', 'CAJERA ANA TORRES']];
const VENDEDORES = [['994', 'VENDEDOR MARIO SALAS'], ['995', 'VENDEDORA ROSA VEGA']];

/** Pseudoaleatorio con semilla: la misma corrida del mismo día siembra lo mismo. */
function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; };
}
const r2 = (n) => Math.round(n * 100) / 100;
/** Hoy en México como AAAA-MM-DD, no el día UTC del servidor. */
const hoyMx = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/Mexico_City' });
function menosDias(iso, n) {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

async function borrar(trx) {
  const n2 = await trx.raw(`
    DELETE FROM kepler_ods.kdm2 l USING kepler_ods.kdm1 h
     WHERE h.c11 = ? AND l.sucursal = h.sucursal AND l.c1 = h.c1 AND l.c2 = h.c2 AND l.c3 = h.c3
       AND l.c4 = h.c4 AND l.c5 = h.c5 AND l.c6 = h.c6`, [MARCA]);
  const n1 = await trx('kepler_ods.kdm1').where('c11', MARCA).del();
  const nu = await trx('kepler_ods.kdud').whereIn('c2', CLIENTES.map((c) => c[0])).del();
  const nv = await trx('kepler_ods.kduv').whereIn('c2', [...CAJEROS, ...VENDEDORES].map((c) => c[0])).del();
  const nx = await trx('identity.users').where({ tenant_id: TENANT, username: USUARIO }).del();
  const ne = await trx('fiscal.issuer_config').where({ tenant_id: TENANT, tax_name: EMISOR }).del();
  return { documentos: n1, renglones: n2.rowCount, clientes: nu, personal: nv, usuario: nx, emisor: ne };
}

/**
 * Usuario LOCAL para probar por HTTP y en el navegador sin adivinar la contraseña de nadie.
 * Rol `superadmin` = ve todas las sucursales. Sólo existe en local (el script aborta fuera).
 */
/**
 * La carta PDF se NIEGA a salir sin identidad fiscal (`fiscal.issuer_config`), y la base local no
 * trae ninguna. Se siembra una de DESARROLLO, sólo si no hay otra activa, con un nombre que no se
 * puede confundir con la real: el RFC es el genérico del SAT para público en general.
 */
async function crearEmisor(trx) {
  const hay = await trx('fiscal.issuer_config').where({ tenant_id: TENANT, active: true }).first('id');
  if (hay) return;
  await trx('fiscal.issuer_config').insert({
    tenant_id: TENANT, rfc: 'XAXX010101000', tax_name: EMISOR, regimen_fiscal: '612', cp: '36500',
    is_default: true, active: true,
  });
}

async function crearUsuario(trx) {
  const bcrypt = require('bcryptjs');
  await trx('identity.users').insert({
    tenant_id: TENANT, username: USUARIO, password_hash: await bcrypt.hash(USUARIO, 10),
    role_name: 'superadmin', activo: true,
  });
}

(async () => {
  try {
    const vista = await knex.raw(`SELECT to_regclass('analytics.erp_sale_tickets') t, to_regclass('analytics.v_customer_master') c`);
    if (!vista.rows[0].t || !vista.rows[0].c) {
      console.error('Faltan vistas: aplicar antes 20260918160000…20260921220000 y 20260920130000 con apply-one-migration-local.js.');
      process.exit(2);
    }

    if (limpiar) {
      const r = await knex.transaction(borrar);
      console.log('  borrado:', r);
      return;
    }

    // Productos reales del catálogo local: el renglón liga por SKU y así el detalle trae nombre.
    const productos = (await knex.raw(`
      SELECT sku, nombre, cost_base::float8 AS costo
        FROM products
       WHERE tenant_id = '00000000-0000-0000-0000-00000000d01c' AND deleted_at IS NULL
         AND sku ~ '^[0-9]+$' AND nombre IS NOT NULL AND cost_base > 3 AND cost_base < 400
       ORDER BY sku LIMIT 40`)).rows;
    if (productos.length < 10) {
      console.error(`Sólo hay ${productos.length} productos usables en el catálogo local; hacen falta 10.`);
      process.exit(3);
    }

    const hoy = hoyMx();
    const azar = rng(Number(hoy.replace(/-/g, '')));
    const elige = (arr) => arr[Math.floor(azar() * arr.length)];
    const cabeceras = [];
    const renglones = [];
    let consecutivo = 900000;

    /**
     * El impuesto de cada producto, fijo por SKU (el mismo en todas sus ventas): ~40% IVA 16%,
     * ~40% IEPS 8% y el resto exento — IVA e IEPS nunca juntos, como mide el ERP (0 de 123,203).
     */
    const impuestoDe = (sku) => {
      const h = [...String(sku)].reduce((a, ch) => (a * 31 + ch.charCodeAt(0)) % 997, 7) % 10;
      return h < 4 ? { iva: 0.16, ieps: 0 } : h < 8 ? { iva: 0, ieps: 0.08 } : { iva: 0, ieps: 0 };
    };

    /**
     * Arma un documento con 1–4 renglones. Parte de los renglones con precio de lista mayor al
     * cobrado (descuento de producto) y, si `pctCliente`, un descuento de DOCUMENTO.
     *
     * ⚠️ La cabecera se escribe como Kepler: el IVA/IEPS de `c14`/`c15` sale del precio YA con el
     * descuento de cliente (prorrateado) — así lo compara el backend para decidir si publica el
     * desglose. Si la cabecera no cuadrara, la pantalla escondería las columnas de impuesto.
     */
    const documento = ({ suc, c4, caja, folio, fecha, cliente, nombre, persona, pctCliente = 0 }) => {
      const nLineas = 1 + Math.floor(azar() * 4);
      const propios = [];
      for (let i = 1; i <= nLineas; i++) {
        const p = elige(productos);
        const precio = r2(p.costo * (1.25 + azar() * 0.2));
        const conLista = azar() < (c4 === 10 ? 0.35 : 0.25);
        const lista = conLista ? r2(precio * (1.05 + azar() * 0.1)) : null;
        const cant = 1 + Math.floor(azar() * (c4 === 10 ? 4 : 12));
        const importe = r2(precio * cant);
        const tx = impuestoDe(p.sku);
        propios.push({ importe, tx });
        renglones.push({
          sucursal: suc, c1: suc, c2: 'U', c3: 'D', c4, c5: caja, c6: folio, c7: i,
          c8: p.sku, c9: cant, c10: p.nombre, c11: 'PZA', c12: precio, c13: importe,
          c17: String(tx.iva * 100), c18: tx.ieps * 100, c66: lista != null ? String(lista) : null,
          c55: 'PZA', c56: String(cant), c57: String(precio), c58: '1',
        });
      }
      const subtotal = r2(propios.reduce((a, x) => a + x.importe, 0));
      const descuento = r2(subtotal * pctCliente / 100);
      const total = r2(subtotal - descuento);
      const factor = subtotal > 0 ? total / subtotal : 1;
      let iva = 0;
      let ieps = 0;
      let descuentoSinImp = 0;
      for (const { importe, tx } of propios) {
        const div = (1 + tx.ieps) * (1 + tx.iva);
        const sin = (importe * factor) / div;
        ieps += r2(sin * tx.ieps);
        iva += r2(sin * (1 + tx.ieps) * tx.iva);
        descuentoSinImp += (importe * (1 - factor)) / div;
      }
      cabeceras.push({
        sucursal: suc, c1: suc, c2: 'U', c3: 'D', c4, c5: caja, c6: folio,
        c9: `${fecha} 00:00:00`, c68: `${fecha} 00:00:00`,
        c10: cliente, c32: nombre, c12: persona, c11: MARCA,
        // ⚠️ `c13` va SIN impuesto, como lo escribe Kepler (medido en TK.d3b: en el documento real
        // 07 U-D-10 f0000513 declara $135.26 contra $147.43 descontados de verdad). Nadie debe
        // leerlo como el monto: el backend MIDE el descuento como Σ renglones − total.
        c13: r2(descuentoSinImp), c14: r2(iva), c15: r2(ieps), c16: total, c43: 'N', c19: String(pctCliente),
      });
    };
    /** Descuento de cliente: a veces, y siempre 3%, 5% o 10% (el % del cliente en Kepler). */
    const pctAlAzar = (prob) => (azar() < prob ? elige([3, 5, 10]) : 0);

    for (const suc of SUCURSALES) {
      for (let d = DIAS - 1; d >= 0; d--) {
        const fecha = menosDias(hoy, d);
        // Mostrador: 6–10 tickets por día y sucursal, en 3 cajas.
        const nTk = 6 + Math.floor(azar() * 5);
        for (let t = 0; t < nTk; t++) {
          const anonimo = azar() < 0.7;
          const cli = elige(CLIENTES);
          documento({
            suc, c4: 10, caja: 1 + Math.floor(azar() * 3), folio: String(++consecutivo).padStart(7, '0'), fecha,
            cliente: anonimo ? 'CONTADO' : cli[0], nombre: anonimo ? null : cli[1], persona: elige(CAJEROS)[0],
            // El mostrador es anónimo: sólo el ticket a nombre puede traer descuento de cliente.
            pctCliente: anonimo ? 0 : pctAlAzar(0.4),
          });
        }
        // Facturas: 1–2 de telemarketing y 0–1 de contado no fiscal, siempre a nombre.
        const nFac = 1 + Math.floor(azar() * 2) + (azar() < 0.5 ? 1 : 0);
        for (let f = 0; f < nFac; f++) {
          const cli = elige(CLIENTES);
          documento({
            suc, c4: f < 2 ? 8 : 12, caja: 1, folio: String(++consecutivo).padStart(7, '0'), fecha,
            cliente: cli[0], nombre: cli[1], persona: elige(VENDEDORES)[0],
            pctCliente: pctAlAzar(0.35),
          });
        }
      }
    }

    // El caso que la pantalla tiene que resolver bien: un MISMO folio en dos plazas y dos cajas.
    for (const [suc, caja, d] of [['01', 1, 1], ['03', 2, 3], ['03', 3, 6]]) {
      documento({
        suc, c4: 10, caja, folio: '0018665', fecha: menosDias(hoy, d),
        cliente: 'CONTADO', nombre: null, persona: CAJEROS[0][0],
      });
    }

    await knex.transaction(async (trx) => {
      await borrar(trx);
      for (const suc of SUCURSALES) {
        await trx('kepler_ods.kdud').insert(CLIENTES.map(([c2, c3, c5], i) => ({
          sucursal: suc, c2, c3, c5, c13: 'CL-01', c14: String(1 + (i % 3)), c15: 20000, c16: i % 2 ? 15 : 0,
        })));
        await trx('kepler_ods.kduv').insert([...CAJEROS, ...VENDEDORES].map(([c2, c3]) => ({ sucursal: suc, c2, c3 })));
      }
      for (let i = 0; i < cabeceras.length; i += 200) await trx('kepler_ods.kdm1').insert(cabeceras.slice(i, i + 200));
      for (let i = 0; i < renglones.length; i += 200) await trx('kepler_ods.kdm2').insert(renglones.slice(i, i + 200));
      await crearUsuario(trx);
      await crearEmisor(trx);
    });

    // Se comprueba contra las VISTAS, que es lo que lee la pantalla — no contra lo insertado.
    const { rows } = await knex.raw(`
      SELECT 'mostrador' AS canal, count(*)::int AS docs, sum(total)::numeric(14,2) AS importe
        FROM analytics.erp_sale_tickets WHERE fecha BETWEEN ?::date AND ?::date AND sucursal = ANY(?)
      UNION ALL
      SELECT doc_tipo, count(*)::int, sum(total)::numeric(14,2)
        FROM analytics.erp_sales_invoices WHERE fecha BETWEEN ?::date AND ?::date AND sucursal = ANY(?)
       GROUP BY doc_tipo`,
    [menosDias(hoy, DIAS - 1), hoy, SUCURSALES, menosDias(hoy, DIAS - 1), hoy, SUCURSALES]);
    const cli = await knex('analytics.v_customer_master').whereIn('cliente_code', CLIENTES.map((c) => c[0])).count({ n: '*' });
    console.log(`  sembrado ${menosDias(hoy, DIAS - 1)} → ${hoy} en sucursales ${SUCURSALES.join(', ')}:`);
    console.log(`  ${cabeceras.length} documentos · ${renglones.length} renglones · ${CLIENTES.length} clientes`);
    console.table(rows);
    console.log(`  clientes visibles en v_customer_master: ${cli[0].n}`);
    console.log(`  login local: usuario ${USUARIO} / contraseña ${USUARIO}`);
  } catch (e) {
    console.error('✖', e.message);
    process.exitCode = 1;
  } finally {
    await knex.destroy();
  }
})();
