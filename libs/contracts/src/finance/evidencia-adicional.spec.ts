import {
  aceptaEvidenciaAdicional, esEvidenciaAdicional, faltaParaEvidenciaAdicional,
  MAX_ARCHIVOS_EVIDENCIA_ADICIONAL, ROL_EVIDENCIA_ADICIONAL,
} from './evidencia-adicional.contract';

/** `[GX.87]` Evidencia adicional: se agrega con su porqué, sin cambiar el estado del vale. */
const A = (url = 'k/1.jpg') => ({ role: ROL_EVIDENCIA_ADICIONAL, url });
const MOTIVO = 'Llegó la factura que faltaba';

describe('[GX.87] aceptaEvidenciaAdicional', () => {
  it.each(['recibida', 'aprobada', 'revision', 'validada'])('%s sí', (s) => expect(aceptaEvidenciaAdicional(s)).toBe(true));
  it.each(['rechazada', '', null, undefined, 'otro'])('%s no', (s) => expect(aceptaEvidenciaAdicional(s)).toBe(false));
});

describe('[GX.87] faltaParaEvidenciaAdicional', () => {
  it('con archivo y motivo, se puede', () => {
    expect(faltaParaEvidenciaAdicional({ motivo: MOTIVO, archivos: [A()] })).toBeNull();
  });
  it('sin archivos no', () => {
    expect(faltaParaEvidenciaAdicional({ motivo: MOTIVO, archivos: [] })).toMatch(/al menos un archivo/);
    expect(faltaParaEvidenciaAdicional({ motivo: MOTIVO, archivos: [{ role: ROL_EVIDENCIA_ADICIONAL, url: '  ' }] })).toMatch(/al menos/);
  });
  it('sin motivo, o con uno de puros espacios o muy corto, no', () => {
    for (const m of ['', '   ', 'factura']) expect(faltaParaEvidenciaAdicional({ motivo: m, archivos: [A()] })).toMatch(/por qué/);
  });
  it('más del tope de archivos no', () => {
    const muchos = Array.from({ length: MAX_ARCHIVOS_EVIDENCIA_ADICIONAL + 1 }, (_, i) => A(`k/${i}.jpg`));
    expect(faltaParaEvidenciaAdicional({ motivo: MOTIVO, archivos: muchos })).toMatch(/máximo/);
  });
  it('un archivo con otro rol no entra por acá (no reemplaza el comprobante ni la solicitud)', () => {
    for (const role of ['comprobante_1', 'solicitud_kepler', 'evidencia_1']) {
      expect(faltaParaEvidenciaAdicional({ motivo: MOTIVO, archivos: [{ role, url: 'k/x.jpg' }] })).toMatch(/no es evidencia adicional/);
    }
  });
});

describe('[GX.87] esEvidenciaAdicional', () => {
  it('sólo el rol adicional', () => {
    expect(esEvidenciaAdicional(A())).toBe(true);
    expect(esEvidenciaAdicional({ role: 'comprobante_1' })).toBe(false);
    expect(esEvidenciaAdicional(null)).toBe(false);
  });
});
