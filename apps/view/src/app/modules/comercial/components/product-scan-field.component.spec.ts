import { ComponentFixture, TestBed } from '@angular/core/testing';
import { AUTO_MS, ProductScanFieldComponent, esCodigoCompleto } from './product-scan-field.component';

/**
 * [P2.9.3] El campo de escaneo busca SOLO cuando entra un código completo: no toda pistola manda `Enter`
 * (reportado en Caducidades el 2026-10-29: el código quedaba escrito esperando la lupa).
 */
describe('[P2.9.3] ProductScanFieldComponent — disparo automático', () => {
  let fix: ComponentFixture<ProductScanFieldComponent>;
  let buscados: string[];
  let reloj: number;

  /** Teclea `texto` carácter por carácter, `ms` entre teclas, como lo haría el padre: el valor vuelve como input. */
  const teclear = (texto: string, ms: number): void => {
    for (let i = 1; i <= texto.length; i++) {
      reloj += ms;
      vi.setSystemTime(reloj);
      const v = texto.slice(0, i);
      fix.componentRef.setInput('valor', v);
      fix.componentInstance.alEscribir(v);
      vi.advanceTimersByTime(Math.min(ms, AUTO_MS - 1));
    }
  };

  beforeEach(() => {
    vi.useFakeTimers();
    reloj = new Date('2026-10-29T10:00:00Z').getTime();
    vi.setSystemTime(reloj);
    TestBed.configureTestingModule({ imports: [ProductScanFieldComponent] });
    fix = TestBed.createComponent(ProductScanFieldComponent);
    fix.componentRef.setInput('valor', '');
    buscados = [];
    fix.componentInstance.buscar.subscribe((c) => buscados.push(c));
    fix.detectChanges();
  });
  afterEach(() => vi.useRealTimers());

  it('⭐ pistola SIN Enter: el código de barras escaneado busca solo, una vez', () => {
    teclear('7502271913377', 8);
    expect(buscados).toEqual([]);
    vi.advanceTimersByTime(AUTO_MS);
    expect(buscados).toEqual(['7502271913377']);
  });

  it('⭐ pistola CON Enter: busca una sola vez (el Enter cancela el disparo automático)', () => {
    teclear('7502271913377', 8);
    fix.componentInstance.disparar();
    vi.advanceTimersByTime(AUTO_MS * 2);
    expect(buscados).toEqual(['7502271913377']);
  });

  it('un SKU escaneado en ráfaga (no es un código de barras) también busca solo', () => {
    teclear('88158', 8);
    vi.advanceTimersByTime(AUTO_MS);
    expect(buscados).toEqual(['88158']);
  });

  it('⛔ NEGATIVA — un SKU tecleado a mano NO se busca a medio escribir: espera Enter', () => {
    teclear('88158', 400);
    vi.advanceTimersByTime(AUTO_MS * 4);
    expect(buscados).toEqual([]);
    fix.componentInstance.disparar();
    expect(buscados).toEqual(['88158']);
  });

  it('⛔ NEGATIVA — mientras sigue llegando texto no dispara (sólo tras el silencio)', () => {
    teclear('750227191', 8);
    expect(buscados).toEqual([]);
  });

  it('esCodigoCompleto: 8–14 dígitos o ráfaga de pistola; un texto corto o a mano, no', () => {
    expect(esCodigoCompleto('7502271913377', false)).toBe(true);
    expect(esCodigoCompleto('75022719', false)).toBe(true);
    expect(esCodigoCompleto('7502271', false)).toBe(false);
    expect(esCodigoCompleto('88158', false)).toBe(false);
    expect(esCodigoCompleto('88158', true)).toBe(true);
    expect(esCodigoCompleto('ab', true)).toBe(false);
  });
});
