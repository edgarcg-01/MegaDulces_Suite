/**
 * `[CC.20.1]` El enlace que se manda a un cliente nunca nace con la IP de la oficina. El caso real (2026-11-18): en prod
 * `APP_PUBLIC_URL=http://192.168.0.222:8080` pisaba el origen y el primer estado de cuenta salió con un enlace que el
 * celular del cliente no abre.
 */
import { DOMINIO_PUBLICO_SUITE, esOrigenPrivado, origenPublicoParaEnlace } from './request-origin';

describe('origenPublicoParaEnlace', () => {
  const antes = { app: process.env['APP_PUBLIC_URL'], link: process.env['PUBLIC_LINK_URL'] };
  afterEach(() => {
    if (antes.app === undefined) delete process.env['APP_PUBLIC_URL']; else process.env['APP_PUBLIC_URL'] = antes.app;
    if (antes.link === undefined) delete process.env['PUBLIC_LINK_URL']; else process.env['PUBLIC_LINK_URL'] = antes.link;
  });
  beforeEach(() => { delete process.env['APP_PUBLIC_URL']; delete process.env['PUBLIC_LINK_URL']; });

  it('el caso de prod: APP_PUBLIC_URL en la IP de la oficina y la petición por la misma IP → el dominio', () => {
    process.env['APP_PUBLIC_URL'] = 'http://192.168.0.222:8080';
    expect(origenPublicoParaEnlace('http://192.168.0.222:8080')).toBe(DOMINIO_PUBLICO_SUITE);
  });

  it('la petición que llega por el dominio se respeta aunque APP_PUBLIC_URL sea privada', () => {
    process.env['APP_PUBLIC_URL'] = 'http://192.168.0.222:8080';
    expect(origenPublicoParaEnlace('https://otra.megadulces.test/')).toBe('https://otra.megadulces.test');
  });

  it('PUBLIC_LINK_URL manda si es pública; una APP_PUBLIC_URL pública también se respeta', () => {
    process.env['PUBLIC_LINK_URL'] = 'https://enlaces.test';
    process.env['APP_PUBLIC_URL'] = 'https://app.test';
    expect(origenPublicoParaEnlace('https://peticion.test')).toBe('https://enlaces.test');
    delete process.env['PUBLIC_LINK_URL'];
    expect(origenPublicoParaEnlace('https://peticion.test')).toBe('https://app.test');
  });

  it('sin nada configurado ni petición → el dominio (nunca vacío)', () => {
    expect(origenPublicoParaEnlace(undefined)).toBe(DOMINIO_PUBLICO_SUITE);
  });

  it('esOrigenPrivado: redes de oficina y la propia máquina sí; dominios e IP públicas no', () => {
    for (const u of ['http://192.168.0.222:8080', 'http://10.0.0.5', 'http://172.20.1.1', 'http://127.0.0.1:4200',
      'http://localhost:4200', 'http://md.local', 'no-es-url']) expect(esOrigenPrivado(u)).toBe(true);
    for (const u of ['https://megadulcessuite.com', 'http://172.32.0.1', 'http://8.8.8.8', 'https://192-168.test'])
      expect(esOrigenPrivado(u)).toBe(false);
  });
});
