import { ComponentFixture, TestBed } from '@angular/core/testing';

import { PresupuestoDecisionComponent } from './presupuesto-decision.component';
import type { FilaVenta } from './presupuesto-decision';

/**
 * `[PVI.19]` — **La superficie de decidir: monta, pinta y NO publica lo que no puede medir.**
 *
 * ⚠️ En este repo no se puede compilar `view` en local y `view` no tiene target `typecheck`, así
 * que montar el componente es **la única verificación** de que sus imports resuelven y su
 * plantilla se renderiza antes del CI. Por eso la primera prueba es «monta y pinta».
 *
 * Lo demás protege las reglas de `DESIGN.md` que un cambio de plantilla rompe en silencio:
 *
 *   · **Q.1 answer-first** — lo primero del DOM es el veredicto, y es una FRASE. Si alguien mete
 *     una tabla arriba, esta prueba se pone roja.
 *   · **ADR-056** — sin venta real NO se pinta `0 %` de cumplimiento: se dice qué falta.
 *   · **Q.4** — la entidad concentrada es un control que navega, no un texto muerto.
 *   · **La cuarta pregunta se DECLARA** — «qué cambió desde que miraste» no existe, y la pantalla
 *     lo dice. Si alguien la borra por parecer negativa, la pantalla vuelve a mentir por omisión.
 */

const fila = (label: string, meta: number | null, is_rollup = false): FilaVenta => ({
  label, channel_label: 'Mostrador', entity_key: label.toLowerCase().replace(/ /g, '-'),
  is_rollup, meta, real: null,
});

/** El canal Mostrador del ejercicio real, medido en prod el 2026-10-09. */
const MOSTRADOR: FilaVenta[] = [
  fila('Padre Hidalgo', 58_103_857.07),
  fila('La Piedad Abastos', 22_909_527.99),
  fila('8 Esquinas', 52_778_444.77),
  fila('Yurécuaro', 6_557_858.01),
  fila('Zamora Centro', 12_838_038.62),
  fila('Canindo', 54_854_348.29),
  fila('Morelia Madero', 22_605_296.05),
  fila('Morelia Abastos', 122_891_216.83),
  fila('Subtotal Mostrador', 353_538_587.63, true),
];

describe('[PVI.19] la pantalla de decidir', () => {
  let fx: ComponentFixture<PresupuestoDecisionComponent>;

  const montar = (over: Partial<Record<string, unknown>> = {}) => {
    fx = TestBed.createComponent(PresupuestoDecisionComponent);
    fx.componentRef.setInput('filas', MOSTRADOR);
    fx.componentRef.setInput('meta', 604_775_116);
    fx.componentRef.setInput('real', null);
    fx.componentRef.setInput('realDisponible', false);
    fx.componentRef.setInput('periodosSinMeta', 3);
    fx.componentRef.setInput('firmas', { total: 156, monto: 74_809_091.57 });
    for (const [k, v] of Object.entries(over)) fx.componentRef.setInput(k, v);
    fx.detectChanges();
    return fx.nativeElement as HTMLElement;
  };

  beforeEach(() => TestBed.resetTestingModule());

  it('monta y pinta', () => {
    expect(montar().querySelector('.dec')).toBeTruthy();
  });

  it('⭐ Q.1 ANSWER-FIRST: lo primero es el veredicto y es una frase, no una tabla', () => {
    const el = montar();
    const primero = el.querySelector('.dec > p, .dec > div, .dec > table');
    expect(primero?.classList.contains('dec-verdict')).toBe(true);
    expect(primero?.textContent?.length).toBeGreaterThan(20);
    expect(el.querySelector('table')).toBeNull();
  });

  it('⛔ ADR-056: sin venta real NO publica 0 % — dice qué falta', () => {
    const el = montar();
    const txt = el.textContent ?? '';
    expect(txt).toContain('no se puede decir');
    expect(txt).toContain('venta real del ejercicio');
    expect(txt).toContain('meta de 3 períodos');
    expect(txt).not.toContain('0 %');
  });

  it('⭐ nombra la entidad concentrada con su porcentaje', () => {
    const txt = montar().textContent ?? '';
    expect(txt).toContain('Morelia Abastos');
    expect(txt).toContain('34.8 %');
  });

  it('⭐ Q.4: la entidad es un control que NAVEGA, no texto muerto', () => {
    const el = montar();
    const filas = el.querySelectorAll<HTMLButtonElement>('.dec-top-row');
    expect(filas.length).toBe(4);                       // las 4 que cargan el 81.6 %
    expect(filas[0].tagName).toBe('BUTTON');            // alcanzable por teclado
    expect(filas[0].getAttribute('aria-label')).toContain('Morelia Abastos');

    const comp = fx.componentInstance;
    const visto: (string | null)[] = [];
    comp.verEntidad.subscribe((k: string | null) => visto.push(k));
    filas[0].click();
    expect(visto).toEqual(['morelia-abastos']);
  });

  it('⛔ el subtotal NO aparece como entidad (duplicaría el canal)', () => {
    const el = montar();
    const nombres = [...el.querySelectorAll('.dec-top-name')].map((n) => n.textContent?.trim());
    expect(nombres.some((n) => n?.startsWith('Subtotal'))).toBe(false);
  });

  it('dice lo que cuesta no firmar, y el botón emite', () => {
    const el = montar();
    expect(el.textContent).toContain('Calendario de pagos');
    const comp = fx.componentInstance;
    let fue = 0;
    comp.irAFirmas.subscribe(() => fue++);
    el.querySelector<HTMLButtonElement>('.dec-block--act button')?.click();
    expect(fue).toBe(1);
  });

  it('⛔ DECLARA la pregunta que no puede contestar', () => {
    const el = montar();
    expect(el.querySelector('.dec-gap')?.textContent).toContain('cambio desde la ultima vez');
  });

  it('sin firmas pendientes no pinta el bloque de acción (ni dice «al día»)', () => {
    const el = montar({ firmas: null });
    expect(el.querySelector('.dec-block--act')).toBeNull();
    expect(el.textContent).not.toContain('al día');
  });

  it('sin metas por entidad lo declara en vez de pintar una barra vacía', () => {
    const el = montar({ filas: [fila('Subtotal', 10, true)] });
    expect(el.querySelector('app-metric-strip')).toBeNull();
    expect(el.textContent).toContain('No hay metas por entidad');
  });

  it('cargando: esqueleto dimensionado y nada de contenido a medias', () => {
    const el = montar({ cargando: true });
    expect(el.querySelectorAll('.dec-skel-line').length).toBe(3);
    expect(el.querySelector('.dec-verdict')).toBeNull();
    expect(el.querySelector('.dec-skel')?.getAttribute('aria-busy')).toBe('true');
  });

  it('con real por encima de la meta el veredicto cambia de tono y de icono', () => {
    const el = montar({ real: 640_000_000, realDisponible: true });
    const v = el.querySelector('.dec-verdict')!;
    expect(v.classList.contains('tone-ok')).toBe(true);
    expect(v.querySelector('.pi-check-circle')).toBeTruthy();
    expect(v.textContent).toContain('arriba del plan');
  });
});
