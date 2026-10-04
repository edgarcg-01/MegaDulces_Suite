import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * `[PC.6]` — **El comprobante se valida solo SÓLO con las cinco condiciones.** La regla de las
 * cuatro coincidencias se prueba en `libs/contracts` (`coincidencia-pago.spec.ts`); aquí se prueba
 * que el servicio la cablea con TODAS sus guardas. Cada guarda que falte es un comprobante validado
 * sin que nadie lo vea.
 */
const soloCodigo = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const SERVICIO = soloCodigo(readFileSync(join(__dirname, 'supplier-payment-proofs.service.ts'), 'utf8'));
const decide = SERVICIO.slice(SERVICIO.indexOf('private async decidirAutomatico('), SERVICIO.indexOf('private async pagoParaCoincidir('));
const attach = SERVICIO.slice(SERVICIO.indexOf('async attach('), SERVICIO.indexOf('private async decidirAutomatico('));
const recheck = SERVICIO.slice(SERVICIO.indexOf('async recheck('), SERVICIO.indexOf('async detail('));

describe('[PC.6] decidirAutomatico tiene las cinco guardas', () => {
  it('1 · las cuatro coincidencias, con la regla de libs/contracts', () => {
    expect(decide).toContain('coincidenciasPago(a.lectura, pagoK');
    expect(decide).toContain('if (faltan.length) return { coincidencias: k, validar: false');
    expect(decide).toContain('validar: coincidenTodas(k)');
  });
  it('⛔ sin el pago en Kepler, no', () => {
    expect(decide).toContain("if (!pagoK) return { coincidencias: k, validar: false");
  });
  it('2 · ⛔ lectura no verificada (vino del request), no', () => {
    expect(decide).toContain("if (!a.verificada) return { coincidencias: k, validar: false");
  });
  it('3 · ⛔ OCR que no terminó ok, no', () => {
    expect(decide).toContain("if (a.ocrStatus !== 'ok') return { coincidencias: k, validar: false");
  });
  it('4 · ⛔ clave de rastreo en otro pago, no', () => {
    expect(decide).toContain("if (a.refDuplicada) return { coincidencias: k, validar: false");
  });
  it('5 · ⛔ el pago ya tiene otro comprobante validado, no', () => {
    expect(decide).toContain("status: 'validado' })");
    expect(decide).toContain("if (yaValidado) return { coincidencias: k, validar: false");
  });
});

describe('[PC.6] attach y recheck sólo validan con la decisión', () => {
  it('attach: la lectura verificada es la que recuperó el servidor, no la del request', () => {
    expect(attach).toContain('verificada: !!verificada');
    expect(attach).toContain('lectura_verificada: !!verificada');
  });
  it("attach: status 'validado' únicamente si auto.validar, firmado por el sistema", () => {
    expect(attach).toContain("...(auto.validar ? { status: 'validado', validated_by: VALIDADOR_AUTOMATICO");
  });
  it('recheck: sólo toca comprobantes recibidos y exige lectura_verificada === true', () => {
    expect(recheck).toContain(".where('status', 'recibido')");
    expect(recheck).toContain('verificada: p.lectura_verificada === true');
    expect(recheck).toContain(".where({ id: p.id, status: 'recibido' })");
  });
});
