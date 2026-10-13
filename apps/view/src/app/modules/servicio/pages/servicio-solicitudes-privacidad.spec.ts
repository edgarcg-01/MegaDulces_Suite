import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ActivatedRoute, Router, convertToParamMap } from '@angular/router';
import { BehaviorSubject, NEVER, of } from 'rxjs';
import { vi } from 'vitest';
import type { SdCatalogResponse, SdPrivacyNoticeDto } from '@megadulces/contracts';
import { ServiceDeskService } from '../service-desk.service';
import { ServicioSolicitudesComponent } from './servicio-solicitudes.component';

/**
 * `[PRV.2]` «Nueva solicitud» hacia un área que exige aviso de privacidad. Lo que se defiende:
 *  · se MUESTRA el aviso y su casilla, y SIN marcarla no se puede enviar;
 *  · lo enviado lleva el id exacto del aviso (el servidor exige la versión vigente);
 *  · quien ya aceptó esta versión no vuelve a marcar y se envía sin id;
 *  · si el aviso aún no está publicado, se dice y NO se puede enviar;
 *  · cambiar de área descarta lo marcado (la casilla es de un solo aviso);
 *  · TI no cambia (control).
 */
const AVISO = (o: Partial<SdPrivacyNoticeDto> = {}): SdPrivacyNoticeDto => ({
  id: 'aviso-v1', version: 1, title: 'Aviso de privacidad — Recursos Humanos', summary_text: 'Usaremos tus datos para atender tu solicitud.',
  consent_text: 'He leído el aviso y consiento el tratamiento de mis datos.', full_url: 'https://ejemplo.mx/aviso', accepted: false, ...o,
});
const catalogo = (aviso: SdPrivacyNoticeDto | null): SdCatalogResponse => ({
  queues: [
    { id: 'q-ti', code: 'ti', name: 'TI (Sistemas)', priority_model: 'impacto', asks_zone: false, confidential: false, uses_priority: true, sla_enabled: true },
    { id: 'q-rh', code: 'rh', name: 'Recursos Humanos', priority_model: 'impacto', asks_zone: false, confidential: true, uses_priority: false, sla_enabled: false, privacy_required: true, privacy_notice: aviso },
  ],
  zones: [],
  fields: [],
  categories: [
    { id: 'c-ti', queue_id: 'q-ti', code: 'caja', name: 'Caja', default_priority: 'media', requires_branch: false },
    { id: 'c-rh', queue_id: 'q-rh', code: 'queja', name: 'Queja', default_priority: 'media', requires_branch: false },
  ],
  impacts: ['yo', 'varios', 'sucursal', 'red'],
});

describe('[PRV.2] ServicioSolicitudesComponent — aviso de privacidad', () => {
  let fix: ComponentFixture<ServicioSolicitudesComponent>;
  let c: ServicioSolicitudesComponent;
  let api: { mine: ReturnType<typeof vi.fn>; catalog: ReturnType<typeof vi.fn>; create: ReturnType<typeof vi.fn>; detail: ReturnType<typeof vi.fn> };
  const texto = () => (fix.nativeElement as HTMLElement).textContent ?? '';

  async function render(aviso: SdPrivacyNoticeDto | null) {
    api = { mine: vi.fn(() => of({ rows: [], total: 0 })), catalog: vi.fn(() => of(catalogo(aviso))), create: vi.fn(() => of({ id: 'n' })), detail: vi.fn(() => NEVER) };
    await TestBed.configureTestingModule({
      imports: [ServicioSolicitudesComponent],
      providers: [
        { provide: ServiceDeskService, useValue: api },
        { provide: ActivatedRoute, useValue: { snapshot: { queryParamMap: convertToParamMap({}) }, queryParamMap: new BehaviorSubject(convertToParamMap({})).asObservable() } },
        { provide: Router, useValue: { navigate: vi.fn(() => Promise.resolve(true)) } },
      ],
    }).compileComponents();
    fix = TestBed.createComponent(ServicioSolicitudesComponent);
    c = fix.componentInstance;
    fix.detectChanges();
    await fix.whenStable();
    c.nueva();
    c.elegirArea('q-rh');
    c.elegirCategoria('c-rh');
    c.form.title = 'Una queja';
    fix.detectChanges();
  }
  afterEach(() => TestBed.resetTestingModule());

  it('se muestra el aviso (título, resumen, enlace) y la casilla con su texto', async () => {
    await render(AVISO());
    expect(texto()).toContain('Aviso de privacidad — Recursos Humanos');
    expect(texto()).toContain('Usaremos tus datos para atender tu solicitud.');
    expect(texto()).toContain('He leído el aviso y consiento');
    expect((fix.nativeElement as HTMLElement).querySelector('.ss-priv a')?.getAttribute('href')).toBe('https://ejemplo.mx/aviso');
  });

  it('⛔ NEGATIVA — sin marcar la casilla NO se puede enviar; marcada, sí', async () => {
    await render(AVISO());
    expect(c.puedeEnviar()).toBe(false);
    c.form.acepta_aviso = true;
    expect(c.puedeEnviar()).toBe(true);
  });

  it('lo enviado lleva el id EXACTO del aviso aceptado', async () => {
    await render(AVISO());
    c.form.acepta_aviso = true;
    c.enviar();
    await vi.waitFor(() => expect(api.create).toHaveBeenCalled());
    expect(api.create.mock.calls[0][0].privacy_notice_id).toBe('aviso-v1');
  });

  it('⭐ quien ya aceptó esta versión NO vuelve a marcar: se envía sin id y no hay casilla', async () => {
    await render(AVISO({ accepted: true }));
    expect(texto()).toContain('Ya aceptaste esta versión');
    expect((fix.nativeElement as HTMLElement).querySelector('.ss-priv input[type="checkbox"]')).toBeNull();
    expect(c.puedeEnviar()).toBe(true);
    c.enviar();
    await vi.waitFor(() => expect(api.create).toHaveBeenCalled());
    expect(api.create.mock.calls[0][0].privacy_notice_id).toBeUndefined();
  });

  it('⛔ NEGATIVA — aviso aún NO publicado: se dice y NO se puede enviar, ni marcando nada', async () => {
    await render(null);
    expect(texto()).toContain('aún no está publicado');
    c.form.acepta_aviso = true;
    expect(c.puedeEnviar()).toBe(false);
  });

  it('⛔ NEGATIVA — cambiar de área descarta la casilla marcada (es de un solo aviso)', async () => {
    await render(AVISO());
    c.form.acepta_aviso = true;
    c.elegirArea('q-ti');
    expect(c.form.acepta_aviso).toBe(false);
    c.elegirArea('q-rh');
    c.elegirCategoria('c-rh');
    expect(c.puedeEnviar()).toBe(false);
  });

  it('⭐ CONTROL — TI no cambia: sin aviso, sin casilla y sin id', async () => {
    await render(AVISO());
    c.elegirArea('q-ti');
    c.elegirCategoria('c-ti');
    c.form.title = 'Reporte';
    fix.detectChanges();
    expect(c.privacidadRequerida()).toBe(false);
    expect(texto()).not.toContain('Aviso de privacidad');
    expect(c.puedeEnviar()).toBe(true);
    c.enviar();
    await vi.waitFor(() => expect(api.create).toHaveBeenCalled());
    expect(api.create.mock.calls[0][0].privacy_notice_id).toBeUndefined();
  });
});
