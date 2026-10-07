/**
 * FAC.0 — Prueba de timbrado de FACTURA DE INGRESO (CFDI 4.0) contra sandbox de PAC.
 *
 * "Pruebas con el SAT": no hay sandbox directo del SAT para contribuyentes; se timbra
 * contra el sandbox de un PAC con el RFC de pruebas oficial EKU9003173C9. La estructura
 * CFDI 4.0 es la misma para cualquier PAC (ESS Conexial Tech en prod), así que esto
 * valida la factura contra las reglas reales del SAT sin timbres reales.
 *
 *   node database/scripts/invoice-test-stamp.js          # imprime el payload (no timbra)
 *   node database/scripts/invoice-test-stamp.js --stamp  # timbra contra el sandbox
 *
 * Requiere en .env (solo para --stamp) — cuenta sandbox GRATIS en facturama.mx:
 *   FACTURAMA_BASE_URL=https://apisandbox.facturama.mx
 *   FACTURAMA_USER=...        FACTURAMA_PASSWORD=...
 */
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env') });

const STAMP = process.argv.includes('--stamp');
const BASE = process.env.FACTURAMA_BASE_URL || 'https://apisandbox.facturama.mx';
const CP = process.env.FAC_EXPEDITION_CP || '59300'; // CP de expedición registrado en la cuenta sandbox

// Factura de Ingreso a Público en General (patrón mostrador, evita el match estricto
// de razón social del CFDI 4.0). En prod: receptor = cliente real con RFC/razón/CP/régimen/uso.
const payload = {
  CfdiType: 'I',            // Ingreso (factura de venta)
  PaymentForm: '01',        // 01 = Efectivo
  PaymentMethod: 'PUE',     // Pago en una sola exhibición
  ExpeditionPlace: CP,      // CP del emisor
  Currency: 'MXN',
  Receiver: {
    Rfc: 'XAXX010101000',
    Name: 'PUBLICO EN GENERAL',
    CfdiUse: 'S01',         // Sin efectos fiscales
    FiscalRegime: '616',    // Sin obligaciones fiscales (público en general)
    TaxZipCode: CP,
  },
  Items: [{
    ProductCode: '01010101',   // ClaveProdServ genérica (aceptada en pruebas). En prod: clave real por SKU.
    Description: 'Dulces surtidos — PRUEBA',
    Unit: 'Pieza',
    UnitCode: 'H87',           // ClaveUnidad
    Quantity: '1',
    UnitPrice: '100.00',
    Subtotal: '100.00',
    TaxObject: '02',           // 02 = Sí objeto de impuesto
    Taxes: [{ Total: '16.00', Name: 'IVA', Base: '100.00', Rate: '0.160000', IsRetention: false }],
    Total: '116.00',
  }],
};

(async () => {
  console.log('\n── Payload de factura de Ingreso de prueba (shape Facturama) ──\n');
  console.log(JSON.stringify(payload, null, 2));

  if (!STAMP) {
    console.log('\n🔎 Solo impresión. Para timbrar: --stamp (requiere FACTURAMA_USER/PASSWORD en .env).\n');
    return;
  }
  if (!process.env.FACTURAMA_USER || !process.env.FACTURAMA_PASSWORD) {
    console.error('\n❌ Faltan FACTURAMA_USER / FACTURAMA_PASSWORD en .env (cuenta sandbox gratis en facturama.mx).\n');
    process.exit(2);
  }
  const auth = Buffer.from(`${process.env.FACTURAMA_USER}:${process.env.FACTURAMA_PASSWORD}`).toString('base64');
  console.log(`\n⚙️  Timbrando contra ${BASE}/3/cfdis ...`);
  const res = await fetch(`${BASE}/3/cfdis`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Basic ${auth}` },
    body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.error(`\n❌ ${BASE} respondió ${res.status}:\n`, JSON.stringify(data, null, 2));
    process.exit(1);
  }
  console.log('\n✅ Timbrado OK (sandbox)');
  console.log('UUID :', data?.Complement?.TaxStamp?.Uuid || data?.Uuid || '(ver respuesta)');
  console.log('Folio:', data?.Folio, '· Serie:', data?.Serie);
  console.log('Total:', data?.Total, data?.Currency);
})().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
