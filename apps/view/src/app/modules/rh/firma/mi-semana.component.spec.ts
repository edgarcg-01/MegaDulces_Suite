import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ActivatedRoute, convertToParamMap } from '@angular/router';
import type { HrFirmaPublicaDto } from '@megadulces/contracts';
import { MiSemanaComponent } from './mi-semana.component';
import { RUTAS_PUBLICAS, esRutaPublica } from '../../../core/auth/rutas-publicas';

/**
 * `[RH.15.11]` «Mi semana»: la persona abre su QR, ve su semana y firma (la firma es la autorización: sin número de
 * reloj). Lo que importa que no se rompa: dice para QUIÉN es la liga, muestra la semana, el botón de firmar no se
 * enciende sin trazo, manda sólo el trazo, y una liga muerta lo dice sin dejar seguir.
 */
const TOKEN = 'AAAAAAAAAAAAAAAAAAAAAOx2v_9k-ZmQ3hT1cW8yLr0aBcDe';
const liga: HrFirmaPublicaDto = {
  nombre: 'PRUEBA UNO', site_name: 'Plaza de prueba', period_start: '2026-11-05', period_end: '2026-11-11',
  expires_at: '2026-11-20T18:00:00.000Z', horas_semana: '8:00', faltas: 1,
  dias: [
    { fecha: '2026-11-05', estado: 'a_tiempo', etiqueta: 'Asistió', entrada: '08:00', salida: '17:00', horas: '8:00', incidencias: [] },
    { fecha: '2026-11-06', estado: 'falta', etiqueta: 'Falta', entrada: null, salida: null, horas: null, incidencias: [] },
  ],
};
const TRAZO = 'data:image/png;base64,AAAA';

const montar = async () => {
  await TestBed.configureTestingModule({
    imports: [MiSemanaComponent],
    providers: [provideHttpClient(), provideHttpClientTesting(),
      { provide: ActivatedRoute, useValue: { snapshot: { paramMap: convertToParamMap({ token: TOKEN }) } } }],
  }).compileComponents();
  const fix = TestBed.createComponent(MiSemanaComponent);
  const http = TestBed.inject(HttpTestingController);
  fix.detectChanges();
  return { fix, http, el: fix.nativeElement as HTMLElement };
};
const texto = (el: HTMLElement) => el.textContent?.replace(/\s+/g, ' ') ?? '';
/** El lienzo de jsdom no dibuja: se sustituye el pad por uno que ya tiene trazo. */
const conTrazo = (cmp: MiSemanaComponent) => { (cmp as unknown as { pad: () => unknown }).pad = () => ({ aPng: () => TRAZO }); };

describe('[RH.15.11] mi semana (pública, desde el celular)', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('es pública: está en la lista única de pantallas sin sesión', () => {
    expect(RUTAS_PUBLICAS).toContain('mi-semana');
    expect(esRutaPublica(`/mi-semana/${TOKEN}`)).toBe(true);
  });

  it('abre directo en su semana: para quién es, el resumen y los días; sin campo de número de reloj', async () => {
    const { fix, http, el } = await montar();
    http.expectOne((r) => r.method === 'GET' && r.url.endsWith(`/hr/attendance/firma/${TOKEN}`)).flush(liga);
    fix.detectChanges();
    expect(texto(el)).toContain('Tu semana del 5 de noviembre al 11 de noviembre');
    expect(texto(el)).toContain('Esta liga es sólo para PRUEBA UNO. Si no eres tú, no firmes');
    expect(texto(el)).toContain('8:00 h trabajadas · 1 falta');
    expect(texto(el)).toContain('Jueves 5');
    expect(texto(el)).toContain('¿Algo no está bien? No firmes');
    expect(el.querySelector('input')).toBeNull();
    const firmar = [...el.querySelectorAll('button')].find((b) => b.textContent?.includes('firmar mi semana')) as HTMLButtonElement;
    expect(firmar.disabled).toBe(true);   // sin trazo no se firma
  });

  it('firmar manda SÓLO el trazo, una vez aunque toquen dos veces, y deja la constancia', async () => {
    const { fix, http, el } = await montar();
    http.expectOne(() => true).flush(liga);
    fix.detectChanges();
    conTrazo(fix.componentInstance);
    fix.componentInstance.firmar();
    fix.componentInstance.firmar();   // doble toque: una sola petición
    const req = http.expectOne((r) => r.method === 'POST');
    expect(req.request.body).toEqual({ firma_png: TRAZO });
    req.flush({ ok: true, signed_at: '2026-11-17T20:03:00.000Z' });
    fix.detectChanges();
    expect(texto(el)).toContain('Firmaste tu semana');
    expect(el.querySelector('canvas')).toBeNull();
  });

  it('si al firmar la liga ya no sirve (403), lo dice y quita el recuadro; sin señal, deja reintentar', async () => {
    const { fix, http, el } = await montar();
    http.expectOne(() => true).flush(liga);
    fix.detectChanges();
    conTrazo(fix.componentInstance);
    fix.componentInstance.firmar();
    http.expectOne((r) => r.method === 'POST').flush({ message: 'Error de red' }, { status: 0, statusText: 'Unknown' });
    fix.detectChanges();
    expect(el.querySelector('canvas')).not.toBeNull();   // la señal falló: puede volver a intentar
    fix.componentInstance.firmar();
    http.expectOne((r) => r.method === 'POST').flush({ message: 'Tu semana ya está firmada.' }, { status: 403, statusText: 'Forbidden' });
    fix.detectChanges();
    expect(texto(el)).toContain('Tu semana ya está firmada.');
    expect(el.querySelector('canvas')).toBeNull();
  });

  it('una liga muerta (vencida, usada, de otra versión) lo dice y no deja seguir', async () => {
    const { fix, http, el } = await montar();
    http.expectOne(() => true).flush({ message: 'Esta liga venció. Pide otra a tu jefe de área.' }, { status: 403, statusText: 'Forbidden' });
    fix.detectChanges();
    expect(texto(el)).toContain('Esta liga venció');
    expect(el.querySelector('canvas')).toBeNull();
  });

});
