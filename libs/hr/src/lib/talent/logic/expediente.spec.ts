/**
 * `[RH.2.2]` El expediente del candidato: catálogo, retiro y faltantes (corre en CI, sin base).
 */
import { DOCUMENTOS_EXPEDIENTE, esCasillero, faltantes, llaveDocumento, retirar, vigente } from './expediente';
import { tieneCv } from './etapas';

describe('[RH.2.2] expediente', () => {
  it('el catálogo es el del bot (las llaves tienen que coincidir exacto)', () => {
    expect(DOCUMENTOS_EXPEDIENTE.map((d) => d.key)).toEqual([
      'cv', 'ine', 'curp', 'rfc', 'nss', 'comprobante', 'acta', 'banco', 'avisoPrivacidad', 'licencia', 'midot', 'contrato']);
    expect(DOCUMENTOS_EXPEDIENTE.filter((d) => d.obligatorio).length).toBe(9);
  });

  it('casilleros válidos: los del catálogo y «otro»', () => {
    expect(esCasillero('ine')).toBe(true);
    expect(esCasillero('otro')).toBe(true);
    expect(esCasillero('pasaporte')).toBe(false);
    expect(esCasillero(undefined)).toBe(false);
  });

  it('la llave: la del bucket, si no la URL, si no la ruta local del bot', () => {
    expect(llaveDocumento({ storage_key: 'talent/t/c/a.pdf', url: 'x' })).toBe('talent/t/c/a.pdf');
    expect(llaveDocumento({ url: 'https://res.cloudinary.com/a.jpg' })).toBe('https://res.cloudinary.com/a.jpg');
    expect(llaveDocumento({ archivo_local: '/data/media/b.pdf' })).toBe('/data/media/b.pdf');
  });

  const docs = [
    { slot: 'cv', storage_key: 'k/cv.pdf', filename: 'cv.pdf' },
    { slot: 'ine', url: 'https://w/ine.jpg' },
  ];
  const quien = { motivo: 'es de otra persona', por_id: null, por_nombre: 'rh', ahora: '2026-10-12T20:00:00Z' };

  it('retirar marca, no borra; y retirar dos veces no es retirar', () => {
    const r = retirar(docs, 'k/cv.pdf', quien);
    expect(r?.docs.length).toBe(2);
    expect(r?.retirada).toMatchObject({ slot: 'cv', retired_at: '2026-10-12T20:00:00Z', retire_reason: 'es de otra persona' });
    expect(vigente(r!.docs[0])).toBe(false);
    expect(retirar(r!.docs, 'k/cv.pdf', quien)).toBeNull();
    expect(retirar(docs, 'no-existe', quien)).toBeNull();
  });

  it('⛔ NEGATIVA — un CV retirado ya no cuenta como CV ni llena su casillero', () => {
    expect(tieneCv({ documents: docs })).toBe(true);
    const sinCv = retirar(docs, 'k/cv.pdf', quien)!.docs;
    expect(tieneCv({ documents: sinCv })).toBe(false);
    expect(faltantes(sinCv, false)).toContain('cv');
    // El CV de la web cuenta aunque no haya archivo en el expediente.
    expect(faltantes(sinCv, true)).not.toContain('cv');
  });

  it('faltantes: los obligatorios sin documento vigente', () => {
    expect(faltantes(docs, false)).toEqual(['curp', 'rfc', 'nss', 'comprobante', 'acta', 'banco', 'avisoPrivacidad']);
  });
});
