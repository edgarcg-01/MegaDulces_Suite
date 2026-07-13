/**
 * W.1 — Importer Wincaja (POS Access 97) → landing `wincaja.*`. ADR-031 / Fase W.
 *
 * 2 etapas por (sucursal, tabla):
 *   (A) extract-table.ps1 en PROCESO 32-BIT (Jet 4.0) → JSONL temporal.
 *   (B) load: parse JSONL → coerción → RECARGA FULL (DELETE por source_branch +
 *       INSERT chunked) dentro de una trx, con SET LOCAL app.tenant_id (pasa FORCE RLS).
 *
 * Recarga full = idempotente (los .mdb "Concentrada" son snapshots, no incrementales).
 *
 * Uso (desde database/):
 *   node importers/wincaja/import-wincaja.js --branch 30 --domain catalogo        # dry-run
 *   node importers/wincaja/import-wincaja.js --branch 30 --domain catalogo --apply
 *   node importers/wincaja/import-wincaja.js --branch all --domain all --apply
 *
 * Env:
 *   WINCAJA_DIR   carpeta de los .mdb (default Z:\Salidas\Bases\Concentradas)
 *   DATABASE_URL_NEW  destino (si ausente, usa knexfile-newdb development)
 */
'use strict';
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '..', '.env') });
const os = require('os');
const fs = require('fs');
const { spawnSync } = require('child_process');
const knexLib = require('knex');

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const APPLY = process.argv.includes('--apply');
const BRANCH = arg('branch', '30');
const DOMAIN = arg('domain', 'catalogo');
const TENANT = process.env.WINCAJA_TENANT_ID || '00000000-0000-0000-0000-00000000d01c';
const WINCAJA_DIR = process.env.WINCAJA_DIR || 'Z:\\Salidas\\Bases\\Concentradas';
const PS32 = 'C:\\Windows\\SysWOW64\\WindowsPowerShell\\v1.0\\powershell.exe';
const EXTRACT = path.join(__dirname, 'extract-table.ps1');

// sucursales vivas/relevantes → archivo .mdb (los stubs de 2MB se ignoran)
const BRANCH_FILES = {
  '10': '10 PHIDALGO.MDB',
  '30': '30 MORELIA ABASTOS.mdb',
  '32': '32 MORELIA MADERO.MDB',
  '50': '50 CANINDO.MDB',
};

// tipos: t=text n=numeric i=int b=bool ts=timestamp
const S = (pg, access, cols, opts = {}) => ({ pg, access, cols, ...opts });
const DOMAINS = {
  catalogo: [
    S('familias', 'Familias', [['familia', 'Familia', 't'], ['descripcion', 'Descripcion', 't'], ['fecha_alta', 'FechaAlta', 'ts'], ['fecha_ult_mod', 'FechaUltimaModificacion', 'ts']]),
    S('subfamilias', 'Subfamilias', [['subfamilia', 'Subfamilia', 't'], ['descripcion', 'Descripcion', 't'], ['familia', 'Familia', 't'], ['fecha_alta', 'FechaAlta', 'ts'], ['fecha_ult_mod', 'FechaUltimaModificacion', 'ts']]),
    S('articulos', 'Articulos', [['articulo', 'Articulo', 't'], ['codigo_barras', 'CodigoBarras', 't'], ['subfamilia', 'Subfamilia', 't'], ['nombre', 'Nombre', 't'], ['descripcion', 'Descripcion', 't'], ['categoria', 'Categoria', 't'], ['es_compuesto', 'EsCompuesto', 'b'], ['unidad_compra', 'UnidadCompra', 't'], ['unidad_venta', 'UnidadVenta', 't'], ['factor_compra', 'FactorCompra', 'n'], ['factor_venta', 'FactorVenta', 'n'], ['iva_venta', 'IVAVenta', 'n'], ['ieps_venta', 'IEPSVenta', 'n'], ['venta_valor_anual', 'VentaValorAnual', 'n'], ['venta_unidad_anual', 'VentaUnidadAnual', 'n'], ['tipo', 'Tipo', 't'], ['fecha_alta', 'FechaAlta', 'ts'], ['fecha_ult_mod', 'FechaUltimaModificacion', 'ts']]),
    S('precios', 'Precios', [['articulo', 'Articulo', 't'], ['no_precio', 'NoPrecio', 'i'], ['precio', 'Precio', 'n'], ['cantidad_automatico', 'CantidadAutomatico', 'n'], ['margen_utilidad', 'MargenUtilidad', 'n'], ['margen_costo_promedio', 'MargenCostoPromedio', 'n'], ['comision_vendedor', 'ComisionVendedor', 'n'], ['fecha_ult_mod', 'FechaUltimaModificacion', 'ts']]),
    S('existencias', 'Existencias', [['almacen', 'Almacen', 't'], ['articulo', 'Articulo', 't'], ['ubicacion', 'Ubicacion', 't'], ['existencia_inicial', 'ExistenciaInicialRegular', 'n'], ['entrada', 'EntradaRegular', 'n'], ['salida', 'SalidaRegular', 'n'], ['stock_maximo', 'StockMaximo', 'n'], ['stock_minimo', 'StockMinimo', 'n'], ['costo_existencia', 'CostoExistencia', 'n'], ['costo_promedio', 'CostoPromedio', 'n'], ['ultimo_costo', 'UltimoCosto', 'n'], ['apartado', 'ApartadoRegular', 'n'], ['fecha_ult_compra', 'FechaUltimaCompra', 'ts'], ['fecha_ult_venta', 'FechaUltimaVenta', 'ts']], { derive: (r) => { r.existencia = (Number(r.existencia_inicial) || 0) + (Number(r.entrada) || 0) - (Number(r.salida) || 0); } }),
    S('articulo_proveedor', 'Productos', [['articulo', 'Articulo', 't'], ['proveedor', 'Proveedor', 't'], ['codigo_proveedor', 'CodigoProveedor', 't'], ['costo', 'Costo', 'n'], ['prioridad', 'Prioridad', 'i'], ['fecha_ult_compra', 'FechaUltimaCompra', 'ts']]),
  ],
  cartera: [
    S('clientes', 'Clientes', [['cliente', 'Cliente', 't'], ['tipo', 'Tipo', 't'], ['nombre', 'Nombre', 't'], ['razon', 'Razon', 't'], ['rfc', 'RFC', 't'], ['vendedor', 'Vendedor', 't'], ['descuento', 'Descuento', 'n'], ['direccion', 'Direccion', 't'], ['colonia', 'Colonia', 't'], ['cd', 'Cd', 't'], ['cp', 'Cp', 't'], ['telefono', 'Telefono', 't'], ['email', 'EMail', 't'], ['saldo_mn', 'SaldoMN', 'n'], ['maximo_mn', 'MaximoMN', 'n'], ['plazo', 'Plazo', 'i'], ['credito', 'Credito', 'b'], ['puntos_acumulados', 'PuntosAcumulados', 'n'], ['territorio', 'Territorio', 't'], ['bloqueado', 'Bloqueado', 'b'], ['fecha_alta', 'FechaAlta', 'ts'], ['fecha_ult_mod', 'FechaUltimaModificacion', 'ts']]),
    S('movimiento_clientes', 'MovimientoClientes', [['documento', 'Documento', 't'], ['tipo', 'Tipo', 't'], ['tercero', 'Tercero', 't'], ['referencia', 'Referencia', 't'], ['fecha', 'Fecha', 'ts'], ['hora', 'Hora', 't'], ['fecha_vencimiento', 'FechaVencimiento', 'ts'], ['fecha_ultimo_pago', 'FechaUltimoPago', 'ts'], ['caja', 'Caja', 't'], ['cajero', 'Cajero', 't'], ['vendedor', 'Vendedor', 't'], ['valor', 'Valor', 'n'], ['descuento', 'Descuento', 'n'], ['costo', 'Costo', 'n'], ['iva', 'IVA', 'n'], ['ieps', 'IEPS', 'n'], ['saldo', 'Saldo', 'n'], ['moneda', 'Moneda', 't'], ['paridad', 'Paridad', 'n'], ['comision_generada', 'ComisionGenerada', 'n'], ['comision_pendiente', 'ComisionPendiente', 'n'], ['almacen', 'Almacen', 't'], ['observaciones', 'Observaciones', 't'], ['fecha_captura', 'FechaCaptura', 'ts']]),
  ],
  compras: [
    S('proveedores', 'Proveedores', [['proveedor', 'Proveedor', 't'], ['nombre', 'Nombre', 't'], ['rfc', 'RFC', 't'], ['direccion', 'Direccion', 't'], ['colonia', 'Colonia', 't'], ['cd', 'Cd', 't'], ['telefonos', 'Telefonos', 't'], ['email', 'EMail', 't'], ['saldo_mn', 'SaldoMN', 'n'], ['limite_credito_mn', 'LimitecreditoMN', 'n'], ['tipo', 'Tipo', 't'], ['fecha_alta', 'FechaAlta', 'ts'], ['fecha_ult_mod', 'FechaUltimaModificacion', 'ts']]),
    S('movimiento_proveedores', 'MovimientoProveedores', [['documento', 'Documento', 't'], ['tipo', 'Tipo', 't'], ['tercero', 'Tercero', 't'], ['referencia', 'Referencia', 't'], ['fecha', 'Fecha', 'ts'], ['fecha_vencimiento', 'FechaVencimiento', 'ts'], ['valor', 'Valor', 'n'], ['descuento', 'Descuento', 'n'], ['iva', 'IVA', 'n'], ['ieps', 'IEPS', 'n'], ['saldo', 'Saldo', 'n'], ['moneda', 'Moneda', 't'], ['almacen', 'Almacen', 't'], ['observaciones', 'Observaciones', 't'], ['fecha_captura', 'FechaCaptura', 'ts']]),
    S('ordenes_compra', 'OrdenesCompra', [['consecutivo', 'Consecutivo', 't'], ['articulo', 'Articulo', 't'], ['fecha', 'Fecha', 'ts'], ['codigo_proveedor', 'CodigoProveedor', 't'], ['cantidad_pedida', 'CantidadPedida', 'n'], ['cantidad_surtida', 'CantidadSurtida', 'n'], ['costo_pedido', 'CostoPedido', 'n'], ['ultimo_costo_surtido', 'UltimoCostoSurtido', 'n'], ['almacen', 'Almacen', 't'], ['emitio', 'Emitio', 't'], ['autorizo', 'Autorizo', 't'], ['moneda', 'Moneda', 't']]),
  ],
  caja: [
    S('formas_pago', 'FormasPago', [['forma_pago', 'FormaPago', 't'], ['descripcion', 'Descripcion', 't'], ['credito', 'Credito', 'b'], ['tarjeta_credito', 'Tarjetadecredito', 'b'], ['vale_interno', 'ValeInterno', 'b'], ['paridad', 'Paridad', 'n']]),
    S('pagos_dia', 'PagosDia', [['consecutivo', 'Consecutivo', 't'], ['folio', 'Folio', 't'], ['forma_pago', 'FormaPago', 't'], ['referencia', 'Referencia', 't'], ['pagado', 'Pagado', 'n'], ['hora', 'Hora', 't'], ['vendedor', 'Vendedor', 't'], ['moneda', 'Moneda', 't'], ['paridad', 'Paridad', 'n'], ['caja', 'Caja', 't'], ['cobranza', 'Cobranza', 'b'], ['propina', 'Propina', 'n']]),
    S('cortes', 'Cortes', [['folio', 'Folio', 't'], ['caja', 'caja', 't'], ['fecha_corte', 'FechaCorte', 'ts'], ['cajero', 'Cajero', 't'], ['folio_inicial_retiro', 'FolioInicialRetiro', 't'], ['folio_final_retiro', 'FolioFinalRetiro', 't'], ['folio_inicial_pago', 'FolioInicialPago', 't'], ['folio_final_pago', 'FolioFinalPago', 't'], ['folio_inicial_movto', 'FolioInicialMovto', 't'], ['folio_final_movto', 'FolioFinalMovto', 't'], ['canceladas', 'Canceladas', 'i'], ['monto_canceladas', 'MontoCanceladas', 'n'], ['eliminadas', 'Eliminadas', 'i'], ['monto_eliminadas', 'MontoEliminadas', 'n']]),
    S('arqueos', 'Arqueos', [['consecutivo', 'Consecutivo', 't'], ['folio', 'Folio', 't'], ['caja', 'Caja', 't'], ['denominacion', 'Denominacion', 'n'], ['cantidad', 'Cantidad', 'n']]),
    S('retiros', 'Retiros', [['folio', 'Folio', 't'], ['caja', 'Caja', 't'], ['monto', 'Monto', 'n'], ['fecha', 'Fecha', 'ts'], ['forma_de_pago', 'FormaDePago', 't'], ['moneda', 'Moneda', 't'], ['cajero', 'Cajero', 't'], ['incremento', 'Incremento', 'b'], ['dotacion_inicial', 'DotacionInicial', 'b'], ['por_diferencia_corte', 'PorDiferenciaCorte', 'b'], ['observacion', 'Observacion', 't']]),
  ],
  ventas: [
    S('maestro_mov_almacen', 'MaestroMovAlmacen', [['consecutivo', 'Consecutivo', 't'], ['tipo', 'Tipo', 't'], ['documento', 'Documento', 't'], ['tercero', 'Tercero', 't'], ['referencia', 'Referencia', 't'], ['fecha', 'Fecha', 'ts'], ['hora', 'Hora', 't'], ['almacen', 'Almacen', 't'], ['moneda', 'Moneda', 't'], ['paridad', 'Paridad', 'n'], ['caja', 'Caja', 't'], ['cajero', 'Cajero', 't'], ['vendedor', 'Vendedor', 't'], ['cancelado', 'Cancelado', 'b'], ['observaciones', 'Observaciones', 't'], ['fecha_captura', 'FechaCaptura', 'ts']]),
    S('detalles_mov_almacen', 'DetallesMovAlmacen', [['consecutivo', 'Consecutivo', 't'], ['articulo', 'Articulo', 't'], ['tipo', 'Tipo', 't'], ['documento', 'Documento', 't'], ['cantidad_regular', 'CantidadRegular', 'n'], ['cantidad_auxiliar', 'CantidadAuxiliar', 'n'], ['valor_costo', 'ValorCosto', 'n'], ['valor_venta', 'ValorVenta', 'n'], ['iva', 'IVA', 'n'], ['ieps', 'IEPS', 'n'], ['descuento1', 'Descuento1', 'n'], ['descuento2', 'Descuento2', 'n'], ['tipo_precio', 'TipoPrecio', 't'], ['unidad_venta', 'UnidadVenta', 't']], { surrogate: true }),
  ],
  ref: [
    S('vendedores', 'Vendedores', [['vendedor', 'Vendedor', 't'], ['nombre', 'Nombre', 't'], ['comision', 'Comision', 'n']]),
    S('ofertas', 'Ofertas', [['consecutivo', 'Consecutivo', 't'], ['articulo', 'Articulo', 't'], ['descuento', 'Descuento', 'n'], ['porcentaje', 'Porcentaje', 'n'], ['nivel_precio', 'NivelPrecio', 'i'], ['fecha_inicial', 'FechaInicial', 'ts'], ['fecha_final', 'FechaFinal', 'ts'], ['limite', 'Limite', 'n'], ['remanente', 'Remanente', 'n'], ['id_oferta', 'ID_OFERTA', 't'], ['no_caduca', 'NoCaduca', 'b']]),
  ],
};

// PK natural por tabla (para onConflict.merge → tolera dups intra-fuente, last-wins).
// Las que no aparecen (detalles_mov_almacen) usan surrogate → insert plano.
const PK = {
  familias: ['familia'], subfamilias: ['subfamilia'], articulos: ['articulo'],
  precios: ['articulo', 'no_precio'], existencias: ['almacen', 'articulo'],
  articulo_proveedor: ['articulo', 'proveedor'],
  clientes: ['cliente'], movimiento_clientes: ['documento', 'tipo'],
  proveedores: ['proveedor'], movimiento_proveedores: ['documento', 'tipo'],
  ordenes_compra: ['consecutivo', 'articulo'],
  formas_pago: ['forma_pago'], pagos_dia: ['consecutivo'], cortes: ['folio', 'caja'],
  arqueos: ['consecutivo', 'denominacion'], retiros: ['folio', 'caja'],
  maestro_mov_almacen: ['consecutivo'], vendedores: ['vendedor'], ofertas: ['consecutivo'],
};

function coerce(type, v) {
  if (v === null || v === undefined) return null;
  if (type === 't') { const s = String(v).trim(); return s === '' ? null : s; }
  if (type === 'n') { const n = Number(v); return Number.isFinite(n) ? n : null; }
  if (type === 'i') { const n = parseInt(v, 10); return Number.isFinite(n) ? n : null; }
  if (type === 'b') { if (v === true || v === -1 || v === 1 || v === '1' || v === 'True') return true; if (v === false || v === 0 || v === '0' || v === 'False') return false; return null; }
  if (type === 'ts') { const s = String(v); if (!/^\d{4}/.test(s) || s < '1900-01-01') return null; return s; }
  return v;
}

function extract(mdb, accessTable, cols) {
  const out = path.join(os.tmpdir(), `wincaja_${accessTable}_${process.pid}.jsonl`);
  const colList = cols.map((c) => `[${c[1]}]`).join(', ');
  const res = spawnSync(PS32, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', EXTRACT, '-Mdb', mdb, '-Table', accessTable, '-Out', out, '-Columns', colList], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (res.status !== 0) throw new Error(`extract ${accessTable} falló: ${(res.stderr || res.stdout || '').slice(0, 400)}`);
  const m = /ROWS=(\d+)/.exec(res.stdout || '');
  return { out, rows: m ? parseInt(m[1], 10) : null };
}

function loadJsonl(file, spec) {
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean);
  return lines.map((ln) => {
    const raw = JSON.parse(ln);
    const r = {};
    for (const [pg, ac, ty] of spec.cols) r[pg] = coerce(ty, raw[ac]);
    if (spec.derive) spec.derive(r);
    return r;
  });
}

async function reload(db, branch, spec, rows) {
  const pk = PK[spec.pg];
  const conflict = pk ? ['tenant_id', 'source_branch', ...pk] : null;
  let data = rows;
  let dropped = 0;
  if (pk) {
    // dedupe por PK natural (last-wins): la fuente repite claves (ej. Productos
    // con (articulo,proveedor) duplicado) y un INSERT no puede tocar la misma
    // clave 2 veces. Recarga full => quedarse con la última ocurrencia es correcto.
    const m = new Map();
    for (const r of rows) m.set(pk.map((k) => r[k]).join(''), r);
    dropped = rows.length - m.size;
    data = [...m.values()];
  }
  await db.transaction(async (trx) => {
    await trx.raw(`SET LOCAL app.tenant_id = '${TENANT}'`);
    await trx(`wincaja.${spec.pg}`).where({ tenant_id: TENANT, source_branch: branch }).del();
    const stamped = data.map((r) => ({ tenant_id: TENANT, source_branch: branch, ...r }));
    for (let i = 0; i < stamped.length; i += 500) {
      const chunk = stamped.slice(i, i + 500);
      const q = trx(`wincaja.${spec.pg}`).insert(chunk);
      await (conflict ? q.onConflict(conflict).merge() : q);
    }
  });
  return dropped;
}

(async () => {
  const branches = BRANCH === 'all' ? Object.keys(BRANCH_FILES) : [BRANCH];
  const domains = DOMAIN === 'all' ? Object.keys(DOMAINS) : [DOMAIN];
  const specs = domains.flatMap((d) => DOMAINS[d] || []);
  if (!specs.length) { console.error(`Dominio desconocido: ${DOMAIN}. Opciones: ${Object.keys(DOMAINS).join(', ')}, all`); process.exit(1); }

  let db = null;
  if (APPLY) {
    const cfg = process.env.DATABASE_URL_NEW
      ? { client: 'pg', connection: { connectionString: process.env.DATABASE_URL_NEW, ssl: /@(localhost|127\.0\.0\.1|192\.168\.)/.test(process.env.DATABASE_URL_NEW) ? false : { rejectUnauthorized: false } }, pool: { min: 0, max: 3 } }
      : require(path.resolve(__dirname, '..', '..', 'knexfile-newdb.js')).development;
    db = knexLib(cfg);
  }

  for (const branch of branches) {
    const file = BRANCH_FILES[branch];
    if (!file) { console.warn(`suc ${branch}: sin archivo mapeado, skip`); continue; }
    const mdb = path.join(WINCAJA_DIR, file);
    if (!fs.existsSync(mdb)) { console.warn(`suc ${branch}: no existe ${mdb}, skip`); continue; }
    console.log(`\n═══ Sucursal ${branch} (${file}) ═══`);
    for (const spec of specs) {
      const t0 = Date.now();
      try {
        const { out, rows } = extract(mdb, spec.access, spec.cols);
        const data = loadJsonl(out, spec);
        fs.unlinkSync(out);
        if (APPLY) await reload(db, branch, spec, data);
        const ms = Date.now() - t0;
        console.log(`  ${spec.access.padEnd(22)} → wincaja.${spec.pg.padEnd(22)} ${String(data.length).padStart(7)} filas ${APPLY ? '✅' : '(dry)'} ${ms}ms`);
      } catch (e) {
        console.error(`  ${spec.access}: ERROR ${e.message}`);
      }
    }
  }
  if (db) await db.destroy();
  if (!APPLY) console.log('\n(dry-run — usar --apply para escribir a wincaja.*)');
})().catch((e) => { console.error(e); process.exit(1); });
