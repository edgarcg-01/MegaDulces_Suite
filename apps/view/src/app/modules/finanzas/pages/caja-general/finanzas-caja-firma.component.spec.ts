import { describe, expect, it, vi } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection, signal } from '@angular/core';
import { FinanzasCajaFirmaComponent } from './finanzas-caja-firma.component';
import { CajaSocketService } from '../../caja-socket.service';

/** jsdom no implementa ResizeObserver y PrimeNG lo usa al montar el boton. */
class ResizeObserverStub {
  observe(): void { /* no-op */ }
  unobserve(): void { /* no-op */ }
  disconnect(): void { /* no-op */ }
}
(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= ResizeObserverStub;

/**
 * **[AUD] La pantalla del telefono: "todavia no" y "no se pudo" NO se pintan igual.**
 *
 * Lo que esto clava, y que costo un mensaje falso en el unico flujo que se le pasa a un tercero
 * con un reloj de tres minutos corriendo:
 *
 *   · `CajaSocketService.connected` nace en `false` y recien pasa a `true` en el evento
 *     `connect`, asi que durante TODO el handshake vale lo mismo que una caida. La pantalla
 *     mostraba el aviso ambar *"revisa la red del telefono"* apenas se escaneaba el QR.
 *   · Y como el boton Continuar quedaba habilitado en esa ventana, el toque llegaba a un socket
 *     sin conectar, volvia `sin_conexion`, y el traductor de errores lo convertia en
 *     *"El QR vencio (dura 3 minutos)"* -- falso, y mandando a la persona a pedir otro QR.
 *
 * ⚠️ PRUEBA NEGATIVA (hecha a mano al escribir esto): con la condicion vieja
 * `@if (!caja.connected())` en vez de los tres estados, los casos 1 y 4a se ponen ROJOS --
 * el aviso de red aparece mientras conecta, y el fallo se reporta como QR vencido.
 */
describe('FinanzasCajaFirmaComponent · el canal tiene TRES estados', () => {
  type Estado = 'sin_iniciar' | 'conectando' | 'vivo' | 'caido';

  type Motivo = 'sin_credencial' | 'sesion_rechazada' | 'pase_rechazado' | 'red' | null;

  function montar(estadoInicial: Estado, url = '/finanzas/caja-general/firma', motivo: Motivo = 'red') {
    const estado = signal<Estado>(estadoInicial);
    const motivoCaida = signal<Motivo>(estadoInicial === 'caido' ? motivo : null);
    const sock = {
      connect: vi.fn(),
      disconnect: vi.fn(),
      connected: () => estado() === 'vivo',
      estado,
      motivoCaida,
      tomarFirma: vi.fn(async () => ({ ok: false as const, error: 'sin_conexion' })),
      enviarFirma: vi.fn(async () => ({ ok: true as const })),
    };
    // `porPase` sale de la URL, no de un input: se arma la URL real que produce el QR.
    window.history.replaceState({}, '', url);

    TestBed.configureTestingModule({
      imports: [FinanzasCajaFirmaComponent],
      providers: [
        provideZonelessChangeDetection(),
        { provide: CajaSocketService, useValue: sock },
      ],
    });
    const fx = TestBed.createComponent(FinanzasCajaFirmaComponent);
    fx.detectChanges();
    return { fx, comp: fx.componentInstance, sock, estado };
  }

  const txt = (fx: { nativeElement: HTMLElement }) => fx.nativeElement.textContent ?? '';
  const continuar = (fx: { nativeElement: HTMLElement }) =>
    [...fx.nativeElement.querySelectorAll('button')].find((b) => (b.textContent ?? '').includes('Continuar'));

  it('1 · mientras el canal abre dice que esta abriendo, y NO acusa a la red', () => {
    const { fx } = montar('conectando');
    expect(txt(fx)).toContain('Abriendo el canal');
    expect(txt(fx)).not.toContain('Revisa la red');
  });

  it('2 · con el canal caido SI acusa a la red, y deja de decir que esta abriendo', () => {
    const { fx } = montar('caido');
    expect(txt(fx)).toContain('Revisa la red');
    expect(txt(fx)).not.toContain('Abriendo el canal');
  });

  it('3 · el boton esta apagado mientras conecta aunque el codigo este completo, y prende al abrir', async () => {
    const { fx, estado } = montar('conectando');

    // ⚠️ El codigo se TECLEA en el campo, no se asigna al componente: `codigo` es un campo plano
    // con [(ngModel)], y escribirlo desde afuera no pasa por el binding -- el boton seguiria
    // apagado por "faltan caracteres" y la prueba pasaria por el motivo equivocado. Medido: con
    // la asignacion directa este caso quedaba VERDE incluso con el arreglo quitado.
    const campo = fx.nativeElement.querySelector('input.fm-cod') as HTMLInputElement;
    campo.value = 'ABC234';
    campo.dispatchEvent(new Event('input'));
    await fx.whenStable();
    fx.detectChanges();
    expect(continuar(fx)?.disabled).toBe(true);

    estado.set('vivo');
    fx.detectChanges();
    expect(continuar(fx)?.disabled).toBe(false);
  });

  it('4a · un fallo MIENTRAS conecta no se reporta como QR vencido', async () => {
    const { fx, comp } = montar('conectando', '/firma?pase=P1');
    comp.codigo = 'ABC234';
    await comp.tomar();
    fx.detectChanges();
    expect(comp.aviso()).toContain('Todavía no abre el canal');
    expect(comp.aviso()).not.toContain('venció');
  });

  it('4b · si el servidor RECHAZO el pase, el QR vencido es la explicacion correcta', async () => {
    const { fx, comp } = montar('caido', '/firma?pase=P1', 'pase_rechazado');
    comp.codigo = 'ABC234';
    await comp.tomar();
    fx.detectChanges();
    expect(comp.aviso()).toContain('venció');
  });

  it('5 · sin pase, un canal caido habla de la red y nunca del QR', async () => {
    const { comp } = montar('caido');
    comp.codigo = 'ABC234';
    await comp.tomar();
    expect(comp.aviso()).toContain('Revisa la red');
    expect(comp.aviso()).not.toContain('venció');
  });

  // ⭐ `[CG.203]` Las dos mentiras que costaban firmar otra vez: la frase vieja decía «el QR
  // venció» siempre que hubiera pase (la 6 lo prohíbe) y «revisa la red» siempre que no (la 7).
  it('6 · con pase y la RED caida, no culpa al QR: la persona no tiene que pedir otro', async () => {
    const { fx, comp } = montar('caido', '/firma?pase=P1', 'red');
    comp.codigo = 'ABC234';
    await comp.tomar();
    fx.detectChanges();
    expect(comp.aviso()).toContain('Revisa la red');
    expect(comp.aviso()).not.toContain('venció');
  });

  it('7 · sin pase ni sesion, manda a escanear el QR y no a revisar una red que esta bien', () => {
    const { fx } = montar('caido', '/firmar?c=ABC234', 'sin_credencial');
    expect(txt(fx)).toContain('Escanea con la cámara el QR');
    expect(txt(fx)).not.toContain('Revisa la red');
  });

  it('8 · una sesion vencida en el telefono tampoco es la red', () => {
    const { fx } = montar('caido', '/firmar?c=ABC234', 'sesion_rechazada');
    expect(txt(fx)).toContain('no hace falta iniciar sesión');
  });
});
