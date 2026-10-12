import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { debeComprobante, soloCotizacion } from './debe-comprobante';

/**
 * `[GX.81]` Los vales aprobados sólo con cotización se quedaban sin salida: la pantalla pedía la
 * factura y el servidor la rebotaba («no lleva evidencia»). 70 en prod, ya pagados en Kepler.
 */
const COT = [{ role: 'cotizacion' }];

describe('[GX.81] soloCotizacion', () => {
  it('cotización(es) sin comprobante = sí', () => {
    expect(soloCotizacion(COT)).toBe(true);
    expect(soloCotizacion([{ role: 'cotizacion' }, { role: 'cotizacion_2' }])).toBe(true);
    expect(soloCotizacion([{ role: 'cotizacion_2' }])).toBe(true);
  });
  it('con comprobante, o sin cotización = no', () => {
    expect(soloCotizacion([{ role: 'cotizacion' }, { role: 'comprobante_1' }])).toBe(false);
    expect(soloCotizacion([{ role: 'solicitud_kepler' }])).toBe(false);
    expect(soloCotizacion([])).toBe(false);
    expect(soloCotizacion(null)).toBe(false);
  });
});

describe('[GX.81] debeComprobante', () => {
  /** ⭐ El caso de los 70: no comprobable, sin la casilla, sólo cotización. */
  it('⭐ sin comprobante + sólo cotización + sin marcar provisional: SÍ se le puede subir', () => {
    expect(debeComprobante({ provisional: false, lleva_evidencia: false, files: COT })).toBe(true);
  });
  it('provisional marcado: sí (GX.55 se conserva)', () => {
    expect(debeComprobante({ provisional: true, lleva_evidencia: false, files: [{ role: 'comprobante_1' }] })).toBe(true);
  });
  it('gasto que exige evidencia: sí', () => {
    expect(debeComprobante({ provisional: false, lleva_evidencia: true, files: [] })).toBe(true);
  });
  /** ⛔ Prueba negativa: un no comprobable de verdad (sin cotización, sin marca) sigue sin admitir archivos. */
  it('⛔ sin comprobante de verdad, sin cotización ni marca: no', () => {
    expect(debeComprobante({ provisional: false, lleva_evidencia: false, files: [{ role: 'solicitud_kepler' }] })).toBe(false);
  });
});

describe('[GX.81] el servicio usa la regla en los dos lados', () => {
  const src = readFileSync(join(__dirname, 'expense-proofs.service.ts'), 'utf8');
  it('aprobar sólo con cotización deja la marca provisional', () => {
    expect(src).toContain('provisional: prov || soloCotizacion,');
  });
  /** La pantalla de captura y «Mis gastos» deciden con `provisional`: el servidor lo publica ya corregido. */
  it('la captura y la lista publican el provisional efectivo (marca o sólo cotización)', () => {
    expect(src).toContain("provisional: r.provisional === true || (r.status === 'aprobada' && esSoloCotizacion(files)),");
    expect(src).toContain("provisional: r.provisional === true || (r.status === 'aprobada' && esSoloCotizacion(archivosDe(r.files))),");
  });
  it('subir evidencia usa debeComprobante (no el guard viejo)', () => {
    expect(src).toContain('if (!debeComprobante({');
    expect(src).not.toContain("if (!requiereEvidencia(base.clasificacion) && base.cur.provisional !== true) {");
  });
});
