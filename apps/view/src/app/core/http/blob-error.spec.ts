import { mensajeDeErrorBlob } from './blob-error';

/**
 * `[GX.70]` Con `responseType: 'blob'` el error del backend llega como Blob. Si este lector
 * falla, la pantalla vuelve a decir «no se pudo» sin motivo — el síntoma que lo originó.
 */
describe('[GX.70] mensajeDeErrorBlob', () => {
  const blob = (o: unknown) => new Blob([typeof o === 'string' ? o : JSON.stringify(o)], { type: 'application/json' });

  it('lee el message del JSON que viene DENTRO del blob', async () => {
    expect(await mensajeDeErrorBlob({ error: blob({ statusCode: 404, message: 'fuera de tu alcance' }) }))
      .toBe('fuera de tu alcance');
  });

  it('une los mensajes de validación (message en arreglo)', async () => {
    expect(await mensajeDeErrorBlob({ error: blob({ message: ['falta folio', 'falta sucursal'] }) }))
      .toBe('falta folio · falta sucursal');
  });

  it('también sirve cuando el error NO es blob (JSON ya parseado)', async () => {
    expect(await mensajeDeErrorBlob({ error: { message: 'ya parseado' } })).toBe('ya parseado');
  });

  it('cuerpo que no es JSON (p. ej. un 502 de nginx) → fallback, sin lanzar', async () => {
    expect(await mensajeDeErrorBlob({ error: blob('<html>502 Bad Gateway</html>') }, 'otra vez')).toBe('otra vez');
  });

  it('JSON sin message, error vacío o undefined → fallback', async () => {
    expect(await mensajeDeErrorBlob({ error: blob({ statusCode: 500 }) })).toBe('Intenta de nuevo.');
    expect(await mensajeDeErrorBlob({})).toBe('Intenta de nuevo.');
    expect(await mensajeDeErrorBlob(undefined)).toBe('Intenta de nuevo.');
  });
});
