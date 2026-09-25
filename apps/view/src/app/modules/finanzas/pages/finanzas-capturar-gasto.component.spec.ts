import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { FinanzasCapturarGastoComponent } from './finanzas-capturar-gasto.component';

/**
 * [GX.17] **El botón tiene que decir por qué está apagado.**
 *
 * Acá vivía una lista de faltantes («Cómo se pagó» / «La foto del comprobante») que se
 * retiró por pedido del usuario. Lo que esa lista hacía —explicar por qué «Enviar a
 * aprobación» está deshabilitado— pasó a la ETIQUETA del botón, porque el `title` de un
 * botón deshabilitado no se lee: no hay hover en táctil y varios navegadores ni lo
 * muestran.
 *
 * Si alguien vuelve a poner un texto fijo en el botón, esto se pone rojo. Un botón apagado
 * sin motivo visible es el mismo callejón que un botón que no hace nada — que es,
 * literalmente, lo que se reportó de la cámara en esta misma pantalla.
 */
describe('[GX.17] FinanzasCapturarGastoComponent · qué dice el botón', () => {
  let comp: FinanzasCapturarGastoComponent;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [FinanzasCapturarGastoComponent],
      providers: [provideHttpClient(), provideHttpClientTesting()],
    }).compileComponents();
    comp = TestBed.createComponent(FinanzasCapturarGastoComponent).componentInstance;
  });

  it('sin la solicitud firmada, lo nombra', () => {
    expect(comp.enviarLabel()).toBe('Falta la solicitud firmada');
  });

  /**
   * El orden importa: primero el papel que respalda la salida de dinero, después el tipo de
   * gasto. Decir «elegí el tipo» cuando falta la firma manda a resolver lo que no bloquea.
   */
  it('con la firma puesta pero sin tipo de gasto, pide el tipo', () => {
    comp.names.set({ solicitud_kepler: 'solicitud.jpg' });
    expect(comp.enviarLabel()).toBe('Elige el tipo de gasto');
  });

  it('elegido el tipo, nombra el primer faltante de la compuerta', () => {
    comp.names.set({ solicitud_kepler: 'solicitud.jpg' });
    comp.clasificacion.set('no_fiscal_comprobable');
    // La compuerta es `faltaParaMandar()`, la MISMA función que devuelve el 400 del backend:
    // el botón no inventa su propia idea de qué falta.
    expect(comp.enviarLabel()).toContain('Falta');
  });

  /**
   * ⭐ La prueba negativa de la que se retiró: mientras algo falte, el texto NUNCA puede ser
   * la acción a secas. Si lo fuera, el botón quedaría gris y mudo.
   */
  it('mientras falte algo, el botón no dice «Enviar a aprobación»', () => {
    expect(comp.puedeEnviar()).toBe(false);
    expect(comp.enviarLabel()).not.toBe('Enviar a aprobación');
  });

  it('mientras guarda, lo dice', () => {
    comp.saving.set(true);
    expect(comp.enviarLabel()).toBe('Enviando…');
  });
});
