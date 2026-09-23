import { motivoHttp } from './http-motivo';

/**
 * Candados del traductor de fallas.
 *
 * Nacen de un caso real: crear una ubicación fallaba y la pantalla decía "No se
 * pudo crear" y nada más, así que el reporte desde la bodega no alcanzaba para
 * saber si era un permiso, un duplicado, la sesión vencida, la red o el
 * servidor. La regla que se fija acá es que **nunca** se devuelve "Error".
 */

const ACCION = 'crear la ubicación';

describe('motivoHttp', () => {
  it('sin respuesta (status 0) NO se reporta como error del servidor', () => {
    // Confundirlos manda a revisar el log equivocado: acá la petición ni salió.
    const t = motivoHttp({ status: 0 }, ACCION);
    expect(t).toContain('No hubo respuesta del servidor');
    expect(t).toContain(ACCION);
    expect(t.toLowerCase()).not.toContain('error 0');
  });

  it('un error sin objeto tampoco devuelve "Error" pelado', () => {
    expect(motivoHttp(null, ACCION)).toContain('No hubo respuesta del servidor');
    expect(motivoHttp(undefined, ACCION)).toContain('No hubo respuesta del servidor');
  });

  it('400: manda el mensaje del servidor, que es quien conoce la regla', () => {
    const t = motivoHttp({ status: 400, error: { message: 'El código no puede pasar de 40 caracteres.' } }, ACCION);
    expect(t).toBe('El código no puede pasar de 40 caracteres.');
  });

  it('400 sin mensaje dice que el problema es el dato, no el permiso', () => {
    const t = motivoHttp({ status: 400 }, ACCION);
    expect(t).toContain('dato');
    expect(t).not.toBe('Error');
  });

  it('401 manda a volver a entrar', () => {
    expect(motivoHttp({ status: 401 }, ACCION)).toContain('sesión venció');
  });

  it('403 nombra el permiso que falta, no un "prohibido" seco', () => {
    const t = motivoHttp({ status: 403 }, ACCION);
    expect(t).toContain('no tiene permiso');
    expect(t).toContain('inventario');
  });

  it('409 usa el mensaje del servidor (el duplicado se explica solo)', () => {
    expect(motivoHttp({ status: 409, error: { message: "Ya existe la ubicación 'R-12'." } }, ACCION))
      .toBe("Ya existe la ubicación 'R-12'.");
  });

  it('429 dice que espere, no que falló', () => {
    expect(motivoHttp({ status: 429 }, ACCION)).toContain('Esperá');
  });

  it('500: da el número para reportarlo y dice que no lo puede arreglar el operario', () => {
    const t = motivoHttp({ status: 500, error: { message: 'Internal server error' } }, ACCION);
    expect(t).toContain('error 500');
    expect(t).toContain('avisá a sistemas');
    // "Internal server error" no informa: repetirlo tal cual sería ruido.
    expect(t).not.toContain('Internal server error');
  });

  it('500 con un mensaje real SÍ lo conserva entre paréntesis', () => {
    const t = motivoHttp({ status: 502, error: { message: 'upstream timeout' } }, ACCION);
    expect(t).toContain('error 502');
    expect(t).toContain('upstream timeout');
  });

  it('un cuerpo HTML (página de error del proxy) no se escupe en pantalla', () => {
    const t = motivoHttp({ status: 502, error: '<!DOCTYPE html><html>…' }, ACCION);
    expect(t).not.toContain('DOCTYPE');
    expect(t).toContain('error 502');
  });

  it('un array de mensajes (validación de Nest) se une legible', () => {
    const t = motivoHttp({ status: 400, error: { message: ['code requerido', 'quantity debe ser > 0'] } }, ACCION);
    expect(t).toBe('code requerido · quantity debe ser > 0');
  });

  it('NUNCA devuelve la palabra "Error" sola, en ningún estado', () => {
    for (const status of [0, 400, 401, 403, 404, 409, 413, 418, 422, 429, 500, 503]) {
      const t = motivoHttp({ status }, ACCION);
      expect(t.trim()).not.toBe('Error');
      expect(t.length).toBeGreaterThan(10);
    }
  });
});
