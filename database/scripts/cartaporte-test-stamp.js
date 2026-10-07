/**
 * J12.0 (D) — Prueba de timbrado Carta Porte 3.1 contra el sandbox de Facturama.
 *
 * Arma un CFDI de Traslado + Complemento CartaPorte31 de MUESTRA (mismo shape que
 * produce LogisticsCartaporteService) y lo manda a timbrar. Sirve para validar
 * (1) que las credenciales funcionan y (2) que Facturama acepta nuestro payload,
 * sin depender de seedear un embarque completo en la DB.
 *
 *   node cartaporte-test-stamp.js          # imprime el payload (no timbra sin creds)
 *   node cartaporte-test-stamp.js --stamp  # timbra contra el sandbox
 *
 * Requiere en .env (solo para --stamp):
 *   FACTURAMA_BASE_URL=https://apisandbox.facturama.mx
 *   FACTURAMA_USER=...        FACTURAMA_PASSWORD=...
 *   CP_TEST_RFC=EKU9003173C9  # RFC de la cuenta sandbox (emisor = receptor en Traslado)
 */
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env') });

const STAMP = process.argv.includes('--stamp');
const BASE = process.env.FACTURAMA_BASE_URL || 'https://apisandbox.facturama.mx';
const RFC = process.env.CP_TEST_RFC || 'EKU9003173C9';
const CP = '59300'; // CP de expedición de muestra (La Piedad, Mich.)

const domicilio = (zip, calle) => ({
  Calle: calle, NumeroExterior: '100', Colonia: 'Centro',
  Municipio: 'La Piedad', Estado: 'MIC', Pais: 'MEX', CodigoPostal: zip,
});

const payload = {
  NameId: '36',
  CfdiType: 'T',
  ExpeditionPlace: CP,
  Receiver: { Rfc: RFC, Name: 'PUBLICO EN GENERAL', CfdiUse: 'S01', FiscalRegime: '601', TaxZipCode: CP },
  Items: [{
    ProductCode: '01010101', Quantity: '1', UnitCode: 'H87',
    Description: 'Traslado de mercancía — PRUEBA', UnitPrice: '0', Subtotal: '0', Total: '0', TaxObject: '01',
  }],
  Complemento: {
    CartaPorte31: {
      TranspInternac: 'No',
      TotalDistRec: 120,
      Ubicaciones: [
        { TipoUbicacion: 'Origen', RFCRemitenteDestinatario: RFC,
          FechaHoraSalidaLlegada: '2026-06-22T08:00:00', Domicilio: domicilio(CP, 'Av. Lazaro Cardenas') },
        { TipoUbicacion: 'Destino', RFCRemitenteDestinatario: 'XAXX010101000', DistanciaRecorrida: '120',
          FechaHoraSalidaLlegada: '2026-06-22T13:00:00', Domicilio: domicilio('58000', 'Av. Madero') },
      ],
      Mercancias: {
        PesoBrutoTotal: 50, UnidadPeso: 'KGM', NumTotalMercancias: 1,
        Mercancia: [{ BienesTransp: '50181900', Descripcion: 'Dulces surtidos', Cantidad: 10,
          ClaveUnidad: 'H87', PesoEnKg: 50, MaterialPeligroso: 'No' }],
        Autotransporte: {
          PermSCT: 'TPAF01', NumPermisoSCT: '0000000000',
          IdentificacionVehicular: { ConfigVehicular: 'C2', PlacaVM: 'ABC1234', AnioModeloVM: '2020' },
          Seguros: { AseguraRespCivil: 'GNP Seguros', PolizaRespCivil: 'POL-DEMO-123' },
        },
      },
      FiguraTransporte: [{ TipoFigura: '01', RFCFigura: 'XAXX010101000', NombreFigura: 'Juan Perez', NumLicencia: 'A1234567' }],
    },
  },
};

(async () => {
  console.log('\n── Payload Carta Porte de prueba (shape Facturama) ──\n');
  console.log(JSON.stringify(payload, null, 2));

  if (!STAMP) {
    console.log('\n🔎 Solo impresión. Para timbrar: --stamp (requiere FACTURAMA_USER/PASSWORD en .env).\n');
    return;
  }
  if (!process.env.FACTURAMA_USER || !process.env.FACTURAMA_PASSWORD) {
    console.error('\n❌ Faltan FACTURAMA_USER / FACTURAMA_PASSWORD en .env.\n');
    process.exit(2);
  }
  const auth = Buffer.from(`${process.env.FACTURAMA_USER}:${process.env.FACTURAMA_PASSWORD}`).toString('base64');
  console.log(`\n⚙️  Timbrando contra ${BASE}/3/cfdis (RFC ${RFC}) ...`);
  const res = await fetch(`${BASE}/3/cfdis`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Basic ${auth}` },
    body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.error(`\n❌ Facturama ${res.status}:\n`, JSON.stringify(data, null, 2));
    process.exit(1);
  }
  console.log('\n✅ Timbrado OK');
  console.log('UUID:', data?.Complement?.TaxStamp?.Uuid || data?.Uuid || '(ver respuesta)');
  console.log('Folio:', data?.Folio, '· Serie:', data?.Serie);
})().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
