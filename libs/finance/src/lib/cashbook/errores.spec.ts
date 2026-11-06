import { ConflictException, UnprocessableEntityException } from '@nestjs/common';
import { traducirErrorDelLibro } from './errores';

/** Lo que la base del libro rechaza llega con su frase y su código HTTP, nunca como un 500 con SQL. */
const traducir = (e: unknown): unknown => { try { traducirErrorDelLibro(e); } catch (x) { return x; } return null; };

describe('traducirErrorDelLibro', () => {
  it('[LE.6.12] el documento que Captura ya registró es un 409 con su frase y el folio en el detalle', () => {
    const x = traducir({ code: '23514', constraint: 'cashbook_documento_en_captura',
      detail: 'el 00|X-D-26|0024013|0011 ya está registrado en Captura con el folio CG-2026-00900: un documento entra a un solo libro' });
    expect(x).toBeInstanceOf(ConflictException);
    const cuerpo = (x as ConflictException).getResponse() as { codigo: string; mensaje: string; detalle: string };
    expect(cuerpo.codigo).toBe('cashbook_documento_en_captura');
    expect(cuerpo.mensaje).toContain('ya está registrado en Captura');
    expect(cuerpo.detalle).toContain('CG-2026-00900');
  });

  it('[negativa] una regla del libro sin frase de ESTADO no se vuelve 409', () => {
    expect(traducir({ code: '23514', constraint: 'cashbook_desbalance' })).toBeInstanceOf(UnprocessableEntityException);
  });

  it('lo que no es del libro se deja pasar tal cual', () => {
    const e = new Error('otra cosa');
    expect(traducir(e)).toBe(e);
  });
});
