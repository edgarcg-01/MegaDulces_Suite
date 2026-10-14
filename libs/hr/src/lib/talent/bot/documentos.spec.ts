/**
 * `[RH.3.3.4]` Los documentos del expediente, la lógica pura: la visión no puede inventar casilleros, lo que se pide no
 * incluye el CV ni llaves desconocidas, lo que falta se cuenta contra lo pedido, y «listo» cierra.
 */
import {
  CASILLEROS, PISTA_CASILLERO, acuseDocumento, cierreDocumentos, esFinDocumentos, mensajePedirDocumentos, pendientes,
  recordatorioDocumentos, solicitudDeDocumentos, veredictoDocumento,
} from './documentos';

describe('[RH.3.3.4] documentos del expediente', () => {
  it('cada casillero del expediente trae su pista para la visión', () => {
    expect(CASILLEROS).toHaveLength(12);
    for (const k of CASILLEROS) expect(PISTA_CASILLERO[k]).toBeTruthy();
  });

  it('⛔ la visión no inventa casilleros: una llave fuera del catálogo no se acepta', () => {
    expect(veredictoDocumento({ slot: 'ine', motivo: 'credencial' })).toEqual({ slot: 'ine', motivo: 'credencial', clasificado: true });
    expect(veredictoDocumento({ slot: 'pasaporte', motivo: 'x' })).toMatchObject({ slot: null, clasificado: false });
    // «otro» = la vio y no es ninguno (distinto de «no se pudo preguntar»).
    expect(veredictoDocumento({ slot: 'otro', motivo: 'una cotización' })).toEqual({ slot: null, motivo: 'una cotización', clasificado: true });
    expect(veredictoDocumento(null)).toMatchObject({ slot: null, clasificado: false });
    expect(veredictoDocumento({ slot: 7 })).toMatchObject({ slot: null, clasificado: false });
  });

  it('lo que se pide: lo que RH eligió (sin el CV, sin desconocidos, sin repetir) o los obligatorios que faltan', () => {
    expect(solicitudDeDocumentos(['ine', 'ine', 'cv', 'pasaporte', 'acta'], ['curp'])).toEqual(['ine', 'acta']);
    expect(solicitudDeDocumentos(null, ['cv', 'ine', 'curp'])).toEqual(['ine', 'curp']);
    expect(solicitudDeDocumentos([], ['banco'])).toEqual(['banco']);
  });

  it('lo que falta se cuenta contra lo pedido', () => {
    expect(pendientes(['ine', 'curp', 'acta'], ['curp', 'cv', 'otro'])).toEqual(['ine', 'acta']);
    expect(pendientes([], ['ine'])).toEqual([]);
  });

  it('los mensajes: la petición con su lista, el acuse dentro y fuera de la etapa, el recordatorio', () => {
    const m = mensajePedirDocumentos('Ana Prueba', ['ine', 'comprobante']);
    expect(m).toContain('Hola Ana');
    expect(m).toContain('1. INE\n2. Comprobante de domicilio');
    expect(acuseDocumento({ slot: 'ine', motivo: '', clasificado: true }, ['acta'], true)).toContain('Aún me faltan:\n1. Acta de nacimiento');
    expect(acuseDocumento({ slot: 'ine', motivo: '', clasificado: true }, [], true)).toContain('Escribe *listo*');
    expect(acuseDocumento({ slot: null, motivo: '', clasificado: false }, ['acta'], false)).toContain('no identifiqué cuál es');
    expect(acuseDocumento({ slot: 'ine', motivo: '', clasificado: true }, ['acta'], false)).not.toContain('Aún me faltan');
    expect(recordatorioDocumentos(['nss'])).toContain('1. NSS');
    expect(recordatorioDocumentos([])).toContain('Ya tengo todos');
  });

  it('«listo» y sus formas cierran; lo demás no', () => {
    for (const t of ['listo', 'Listo!', 'ya terminé', 'eso es todo', 'ok', 'ya']) expect(esFinDocumentos(t)).toBe(true);
    for (const t of ['hola', 'cuánto pagan', 'mañana se los mando', '']) expect(esFinDocumentos(t)).toBe(false);
    expect(cierreDocumentos([])).not.toContain('falta');
    expect(cierreDocumentos(['acta'])).toContain('el que falta');
  });
});
