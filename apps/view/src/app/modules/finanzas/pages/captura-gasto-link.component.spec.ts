import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { provideRouter } from '@angular/router';
import { CapturaGastoLinkComponent } from './captura-gasto-link.component';

/**
 * `[GX.86]` El link de captura también es un alta, y quien entra por link no tiene permisos:
 * fuera del horario (lunes a viernes, 8:30–10:00 y 17:00–18:00, México) no se puede mandar,
 * y la pantalla lo dice antes de que se tomen las fotos.
 */
describe('[GX.86] CapturaGastoLinkComponent · horario de alta', () => {
  const crear = async (ahora: string) => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(ahora));
    await TestBed.configureTestingModule({
      imports: [CapturaGastoLinkComponent],
      providers: [provideHttpClient(), provideHttpClientTesting(), provideRouter([])],
    }).compileComponents();
    const comp = TestBed.createComponent(CapturaGastoLinkComponent).componentInstance;
    comp.clasificacion.set('no_comprobable');
    return comp;
  };
  afterEach(() => vi.useRealTimers());

  it('al mediodía no se puede mandar y dice cuándo abre', async () => {
    const comp = await crear('2026-10-19T12:00:00-06:00'); // lunes
    expect(comp.horario().abierto).toBe(false);
    expect(comp.listo()).toBe(false);
    expect(comp.falta()).toContain('Abre hoy a las 17:00');
  });

  it('el sábado tampoco, y abre el lunes', async () => {
    const comp = await crear('2026-10-24T09:00:00-06:00');
    expect(comp.listo()).toBe(false);
    expect(comp.falta()).toContain('lunes a las 8:30');
  });

  it('dentro del horario el horario ya no es lo que falta', async () => {
    const comp = await crear('2026-10-19T09:00:00-06:00');
    expect(comp.horario().abierto).toBe(true);
    expect(comp.falta()).toBe('Falta la foto de la solicitud firmada');
  });

  it('enviar() fuera del horario deja el motivo y no marca enviando', async () => {
    const comp = await crear('2026-10-19T12:00:00-06:00');
    comp.enviar();
    expect(comp.enviando()).toBe(false);
    expect(comp.error()).toContain('cerrada');
  });
});
