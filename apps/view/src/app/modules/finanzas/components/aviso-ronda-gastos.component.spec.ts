import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { provideRouter } from '@angular/router';
import { AvisoRondaGastosComponent } from './aviso-ronda-gastos.component';
import { PermissionsService } from '../../../core/services/permissions.service';
import { FinanzasCapturarGastoComponent } from '../pages/finanzas-capturar-gasto.component';

/**
 * `[GX.86]` El aviso de las rondas: informa en qué ronda se revisa el gasto, NO bloquea.
 * Rondas: lunes a viernes, 8:30–10:00 am y 5:00–6:00 pm (México). 2026-10-19 = lunes.
 */
describe('[GX.86] AvisoRondaGastosComponent', () => {
  const montar = async (permisos: Record<string, boolean>, ahora: string, publico = false) => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(ahora));
    await TestBed.configureTestingModule({ imports: [AvisoRondaGastosComponent] }).compileComponents();
    TestBed.inject(PermissionsService).load(permisos, 'capturista');
    const f = TestBed.createComponent(AvisoRondaGastosComponent);
    f.componentRef.setInput('publico', publico);
    f.detectChanges();
    return f;
  };
  afterEach(() => vi.useRealTimers());

  const CAPTURISTA = { FINANCE_EXPENSES_CAPTURAR: true };

  it('primero dice que se puede subir a cualquier hora, y luego la ronda de SU gasto', async () => {
    const f = await montar(CAPTURISTA, '2026-10-19T12:40:00-06:00');
    const txt = (f.nativeElement as HTMLElement).textContent ?? '';
    expect(txt).toContain('Puedes subir tus gastos a cualquier hora del día, sin problema');
    expect(txt).toContain('se revisa en la ronda de hoy a las 5:00 pm');
    expect(txt).toContain('8:30–10:00 am y 5:00–6:00 pm');
  });

  it('durante una ronda dice «ahorita estamos revisando»', async () => {
    const f = await montar(CAPTURISTA, '2026-10-19T09:15:00-06:00');
    expect((f.nativeElement as HTMLElement).textContent).toContain('Ahorita estamos revisando');
  });

  it('quien aprueba no lo ve', async () => {
    const f = await montar({ ...CAPTURISTA, FINANCE_EXPENSES_COMPROBAR: true }, '2026-10-19T12:40:00-06:00');
    expect((f.nativeElement as HTMLElement).querySelector('.ar')).toBeNull();
  });

  it('en el link público se ve aunque no haya sesión', async () => {
    const f = await montar({}, '2026-10-24T20:00:00-06:00', true);
    expect((f.nativeElement as HTMLElement).textContent).toContain('ronda del lunes a las 8:30 am');
  });
});

/** ⛔ Regresión del primer intento (bloqueo): a mediodía, un vale completo SE PUEDE ENVIAR. */
describe('[GX.86] la captura no bloquea fuera de las rondas', () => {
  afterEach(() => vi.useRealTimers());

  it('lunes 12:00: el vale completo se puede enviar', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-19T12:00:00-06:00'));
    await TestBed.configureTestingModule({
      imports: [FinanzasCapturarGastoComponent],
      providers: [provideHttpClient(), provideHttpClientTesting(), provideRouter([])],
    }).compileComponents();
    TestBed.inject(PermissionsService).load({ FINANCE_EXPENSES_CAPTURAR: true }, 'capturista');
    const comp = TestBed.createComponent(FinanzasCapturarGastoComponent).componentInstance;
    comp.gasto.set({ folio: '0049641', beneficiario: 'X', importe: 10, sucursal: '01' } as never);
    comp.clasificacion.set('no_comprobable');
    comp.formaPago.set('efectivo');
    comp.names.set({ comprobante_1: 'vale.jpg' });
    comp.sellos.set({ comprobante_1: { live: true } } as never);
    comp.comentarios.set('Balatas');
    expect(comp.puedeEnviar()).toBe(true);
    expect(comp.enviarLabel()).toBe('Enviar a aprobación');
  });
});
