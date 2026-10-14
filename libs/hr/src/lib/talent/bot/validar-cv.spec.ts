/**
 * `[RH.3.3.2]` ¿Es un CV? La regla asimétrica de Mega Talento: sólo pasa CV u hoja de solicitud; lo ilegible no pasa
 * pero se le piden tips (no se le acusa); y lo que NO se pudo revisar se ACEPTA marcado — un filtro que no puede
 * evaluar no se vuelve un muro.
 */
import { mensajeCvRechazado, veredictoCv, visionPuedeLeer } from './validar-cv';
import { HrCvValidatorService } from './validar-cv.service';

function falso(o: { hasApiKey?: boolean; responde?: unknown; truena?: string } = {}) {
  const llamadas: Array<Record<string, unknown>> = [];
  const cliente = {
    hasApiKey: o.hasApiKey ?? true,
    messages: async (p: Record<string, unknown>) => { llamadas.push(p); if (o.truena) throw new Error(o.truena); return o.responde; },
  };
  return { svc: new HrCvValidatorService(cliente as never), llamadas };
}
const uso = (input: unknown) => ({ content: [{ type: 'tool_use', name: 'clasificar_archivo', input }] });
const PDF = Buffer.from('%PDF-1.7 cv');

describe('[RH.3.3.2] la regla', () => {
  it('pasa CV y hoja de solicitud; lo dudoso pasa MARCADO; lo demás no pasa', () => {
    expect(veredictoCv({ tipo: 'cv', seguro: true, que_es: 'un CV' })).toMatchObject({ valido: true, revisar: false });
    expect(veredictoCv({ tipo: 'solicitud_empleo', seguro: false, que_es: 'solicitud a mano' })).toMatchObject({ valido: true, revisar: true });
    for (const tipo of ['identificacion', 'comprobante', 'foto_persona', 'ilegible', 'otro_documento']) {
      expect([tipo, veredictoCv({ tipo, seguro: true, que_es: 'x' }).valido]).toEqual([tipo, false]);
    }
  });
  it('⛔ una respuesta que no se reconoce no se acepta a ciegas: pasa marcada para revisión', () => {
    expect(veredictoCv({ tipo: 'inventado' })).toMatchObject({ valido: true, tipo: 'sin_revisar', revisar: true });
    expect(veredictoCv(null)).toMatchObject({ valido: true, revisar: true });
  });
  it('lo ilegible pide otra foto con tips; lo incorrecto dice qué parece y qué sirve', () => {
    const ilegible = mensajeCvRechazado({ valido: false, tipo: 'ilegible', motivo: 'foto muy oscura', revisar: false });
    expect(ilegible).toContain('no alcanzo a leerlo');
    expect(ilegible).not.toContain('parece');
    const recibo = mensajeCvRechazado({ valido: false, tipo: 'comprobante', motivo: 'es un recibo de CFE', revisar: false });
    expect(recibo).toContain('parece un comprobante — es un recibo de CFE.');
    expect(recibo).toContain('hoja de solicitud de empleo');
  });
  it('la visión lee PDF y JPG/PNG/WEBP/GIF; HEIC no', () => {
    expect(['application/pdf', 'image/jpeg', 'image/png'].every(visionPuedeLeer)).toBe(true);
    expect(visionPuedeLeer('image/heic')).toBe(false);
  });
});

describe('[RH.3.3.2] el servicio de visión', () => {
  it('⭐ manda el PDF como documento, forzado a la herramienta, y aplica la regla', async () => {
    const { svc, llamadas } = falso({ responde: uso({ tipo: 'comprobante', seguro: true, que_es: 'es un recibo de agua' }) });
    const v = await svc.validar(PDF, 'application/pdf');
    expect(v).toMatchObject({ valido: false, tipo: 'comprobante', motivo: 'es un recibo de agua' });
    const contenido = ((llamadas[0]['messages'] as Array<{ content: Array<{ type: string }> }>)[0]).content;
    expect(contenido[0].type).toBe('document');
    expect(llamadas[0]['toolChoice']).toEqual({ type: 'tool', name: 'clasificar_archivo' });
  });
  it('⛔ si no puede revisar, ACEPTA y marca: sin clave, HEIC, error de red', async () => {
    const sinClave = falso({ hasApiKey: false });
    expect(await sinClave.svc.validar(PDF, 'application/pdf')).toMatchObject({ valido: true, revisar: true });
    expect(sinClave.llamadas).toHaveLength(0);
    expect(await falso().svc.validar(PDF, 'image/heic')).toMatchObject({ valido: true, revisar: true });
    expect(await falso({ truena: 'Anthropic HTTP 529: overloaded' }).svc.validar(PDF, 'application/pdf')).toMatchObject({ valido: true, revisar: true });
  });
  it('un PDF que el proveedor rechaza por páginas NO es un CV: ese error ya es la respuesta', async () => {
    const v = await falso({ truena: 'Anthropic HTTP 400: A maximum of 100 PDF pages may be provided' }).svc.validar(PDF, 'application/pdf');
    expect(v).toMatchObject({ valido: false, tipo: 'demasiadas_paginas' });
  });
});
