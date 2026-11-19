/**
 * `[CC.20]` La página pública donde el CLIENTE sube su ficha de depósito, montada de verdad:
 *  1. Saluda por nombre y, si le rechazaron una ficha, el motivo va ARRIBA.
 *  2. Elegir la foto sube y lee AL MISMO TIEMPO, y la lectura llena monto y fecha (sin pisar lo que ya escribió).
 *  3. El monto acepta la forma («12,500.00», «$12500») y no adivina el significado.
 *  4. Enviar manda el número, la fecha y el archivo con su huella; el botón se apaga en el primer clic.
 *  5. ⛔ Un envío que falla SE DICE y lo capturado se queda para reintentar.
 *  6. Un enlace dado de baja (403) dice por qué, sin formulario.
 */
import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap } from '@angular/router';
import { provideZonelessChangeDetection } from '@angular/core';
import { of, throwError, Subject } from 'rxjs';
import { vi } from 'vitest';
import { DepositoClienteComponent, leerMonto } from './deposito-cliente.component';
import { DepositoClienteService, ContextoDeposito } from '../deposito-cliente.service';

const CTX: ContextoDeposito = {
  cliente: 'ABARROTES PEÑA', sucursal: 'La Piedad',
  fichas: [
    { id: 'f1', status: 'rechazado', motivo_rechazo: 'La foto no se lee, súbela otra vez', monto: 900, fecha: '2026-11-10', enviado: '2026-11-10T10:00:00Z', aplicado: false },
    { id: 'f2', status: 'validado', motivo_rechazo: null, monto: 1500, fecha: '2026-11-08', enviado: '2026-11-08T10:00:00Z', aplicado: true },
  ],
};

describe('DepositoClienteComponent — [CC.20]', () => {
  let svc: Record<string, ReturnType<typeof vi.fn>>;
  afterEach(() => TestBed.resetTestingModule());

  function crear(token = 'TOKEN') {
    TestBed.configureTestingModule({
      imports: [DepositoClienteComponent],
      providers: [
        provideZonelessChangeDetection(),
        { provide: ActivatedRoute, useValue: { snapshot: { paramMap: convertToParamMap({ token }) } } },
        { provide: DepositoClienteService, useValue: svc },
      ],
    });
    const f = TestBed.createComponent(DepositoClienteComponent);
    f.detectChanges();
    return f;
  }
  const txt = (f: { nativeElement: HTMLElement }) => f.nativeElement.textContent || '';

  beforeEach(() => {
    svc = {
      contexto: vi.fn(() => of(CTX)),
      subir: vi.fn(() => of({ url: 'finance/t/customer-deposits/a.jpg', kind: 'image' })),
      leer: vi.fn(() => of({ monto: 12500, fecha: '2026-11-15', banco: 'BBVA', referencia: '123', ocr_status: 'ok', sha256: 'HUELLA' })),
      enviar: vi.fn(() => of({ id: 'n1', status: 'recibido', ya_estaba: false })),
      estadoCuentaUrl: vi.fn((tk: string) => '/api/finance/deposito/' + encodeURIComponent(tk) + '/estado-de-cuenta.pdf'),
    };
  });

  it('3 · el monto acepta la forma y no adivina', () => {
    expect(leerMonto('12,500.00')).toBe(12500);
    expect(leerMonto('$12500')).toBe(12500);
    expect(leerMonto('0')).toBeNull();
    expect(leerMonto('12.345')).toBeNull();
    expect(leerMonto('doce mil')).toBeNull();
  });

  it('1 · saluda por nombre y el rechazo va arriba con su motivo', () => {
    const f = crear();
    expect(txt(f)).toContain('Hola, ABARROTES PEÑA');
    const rech = f.nativeElement.querySelector('.dc-rech') as HTMLElement;
    expect(rech.textContent).toContain('La foto no se lee');
    expect(rech.compareDocumentPosition(f.nativeElement.querySelector('.dc-btn-main') as Node) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(txt(f)).toContain('Aplicada');
  });

  it('7 · [CC.20.2] el PDF del estado de cuenta está en la página, con SU token y después del botón de subir', () => {
    const f = crear('TK.1');
    const a = f.nativeElement.querySelector('[data-testid="estado-cuenta-pdf"]') as HTMLAnchorElement;
    expect(a.getAttribute('href')).toBe('/api/finance/deposito/TK.1/estado-de-cuenta.pdf');
    expect(a.textContent).toContain('Descargar mi estado de cuenta (PDF)');
    expect(svc['estadoCuentaUrl']).toHaveBeenCalledWith('TK.1');
    const subir = f.nativeElement.querySelector('.dc-btn-main') as Node;
    expect(subir.compareDocumentPosition(a) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('2 y 4 · subir y leer en paralelo, la lectura llena los campos, y enviar manda lo correcto una sola vez', () => {
    const envio = new Subject<{ id: string; status: string; ya_estaba: boolean }>();
    svc['enviar'] = vi.fn(() => envio);
    const f = crear();
    const c = f.componentInstance;
    (c as unknown as { procesar: (u: string) => void }).procesar('data:image/jpeg;base64,AAAA');
    f.detectChanges();
    expect(svc['subir']).toHaveBeenCalledTimes(1);
    expect(svc['leer']).toHaveBeenCalledTimes(1);
    expect(c.montoTxt).toBe('12500.00');
    expect(c.fecha).toBe('2026-11-15');
    c.montoTxt = '12,500.00';
    c.enviar(); c.enviar(); // doble clic
    expect(svc['enviar']).toHaveBeenCalledTimes(1);
    expect(svc['enviar'].mock.calls[0][1]).toMatchObject({ monto: 12500, fecha: '2026-11-15', files: [{ url: 'finance/t/customer-deposits/a.jpg', sha256: 'HUELLA' }] });
    envio.next({ id: 'n1', status: 'recibido', ya_estaba: false });
    f.detectChanges();
    expect(txt(f)).toContain('¡Listo! Recibimos tu ficha');
  });

  it('2b · la lectura no pisa lo que el cliente ya escribió', () => {
    const f = crear();
    const c = f.componentInstance;
    c.montoTxt = '500';
    (c as unknown as { procesar: (u: string) => void }).procesar('data:image/jpeg;base64,AAAA');
    expect(c.montoTxt).toBe('500');
  });

  it('5 · ⛔ un envío que falla se dice, y lo capturado se queda', () => {
    svc['enviar'] = vi.fn(() => throwError(() => ({ status: 400, error: { message: 'Escribe la fecha del depósito.' } })));
    const f = crear();
    const c = f.componentInstance;
    (c as unknown as { procesar: (u: string) => void }).procesar('data:image/jpeg;base64,AAAA');
    c.enviar();
    f.detectChanges();
    expect(txt(f)).toContain('Escribe la fecha del depósito.');
    expect(c.paso()).toBe('revisar');
    expect(c.montoTxt).toBe('12500.00');
  });

  it('6 · un enlace dado de baja dice por qué, sin formulario', () => {
    svc['contexto'] = vi.fn(() => throwError(() => ({ status: 403, error: { message: 'Este enlace fue reemplazado por uno nuevo.' } })));
    const f = crear();
    expect(txt(f)).toContain('Este enlace fue reemplazado por uno nuevo.');
    expect(f.nativeElement.querySelector('.dc-file')).toBeNull();
  });
});
