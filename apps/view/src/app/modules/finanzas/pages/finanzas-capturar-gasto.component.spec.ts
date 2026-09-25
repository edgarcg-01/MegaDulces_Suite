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

  /**
   * [GX.19] Ya no hay paso de «tipo de gasto»: la clasificacion se fija sola al elegir la
   * solicitud. El primer faltante real es el METODO DE PAGO, que es una de las dos cosas
   * que Kepler no tiene y esta pantalla existe para juntar.
   */
  it('el primer faltante es como se pago', () => {
    comp.clasificacion.set('no_comprobable');
    expect(comp.enviarLabel()).toContain('Cómo se pagó');
  });

  it('elegido el tipo, nombra el primer faltante de la compuerta', () => {
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

  /**
   * [GX.22] **Escribir el dato del pago tiene que DESBLOQUEAR el boton.**
   *
   * No lo hacia: `formaPagoDetalleV` era una propiedad plana y la leia el `computed` de la
   * compuerta, que solo se recalcula cuando cambia una SENAL. Elegias Transferencia,
   * escribias la referencia, y el boton seguia diciendo «Falta: El dato del pago» -- el
   * gasto no se podia enviar. Se destapo probando «Otro» en el navegador.
   *
   * Vale para las CUATRO formas que piden dato (tarjeta, transferencia, cheque, otro).
   */
  it('escribir el dato del pago desbloquea el boton', () => {
    comp.clasificacion.set('no_comprobable');
    comp.formaPago.set('transferencia');
    expect(comp.enviarLabel()).toContain('El dato del pago');

    comp.formaPagoDetalle.set('882301');
    expect(comp.enviarLabel()).not.toContain('El dato del pago');
  });

  it('mientras guarda, lo dice', () => {
    comp.saving.set(true);
    expect(comp.enviarLabel()).toBe('Enviando…');
  });
});
