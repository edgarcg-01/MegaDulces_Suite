import { ComponentFixture, TestBed } from '@angular/core/testing';

import { PresupuestoDecisionComponent } from './presupuesto-decision.component';
import type { FilaConcentracion, VistaConcentracion } from './presupuesto-decision';

/**
 * `[PVI.19]`/`[PVI.20]` — **La superficie de decidir: monta, pinta y NO esconde ninguna fila.**
 *
 * ⚠️ En este repo no se puede compilar `view` en local y `view` no tiene target `typecheck`, así
 * que montar el componente es **la única verificación** de que sus imports resuelven y su
 * plantilla se renderiza antes del CI. Por eso la primera prueba es «monta y pinta».
 *
 * Lo demás protege lo que la auditoría de los carriles hermanos encontró, y que una edición de
 * plantilla vuelve a romper en silencio:
 *
 *   · **Las tres bandas en pantalla** — antes se pintaban 4 y se contaban 2, y $45,514,824 se
 *     caían sin dejar rastro.
 *   · **El universo declarado** — «el 81.6 % del plan» era de Mostrador; del plan es 47.72 %.
 *   · **Q.1 answer-first** — lo primero del DOM es el veredicto, y es una frase.
 *   · **ADR-056** — sin venta real no se pinta `0 %`: se dice qué falta.
 *   · **La cuarta pregunta se DECLARA** — si alguien borra esa línea por parecer negativa, la
 *     pantalla vuelve a mentir por omisión.
 */

const f = (concepto: string, monto: number | null, pct: number | null, acumulado: number | null): FilaConcentracion =>
  ({ id: concepto.toLowerCase().replace(/ /g, '-'), concepto, monto, pct, acumulado });

/** Mostrador del ejercicio real, los OCHO renglones (2026-10-09). */
const MOSTRADOR: VistaConcentracion = {
  total: 353_538_587.63,
  partidas_80: 4,
  pct_mayor: 34.7607,
  sin_monto: 0,
  universo: 'Mostrador',
  parte_de: { de: 'el ingreso del ejercicio', pct: 58.4578 },
  filas: [
    f('Morelia Abastos', 122_891_216.83, 34.7607, 34.7607),
    f('Padre Hidalgo', 58_103_857.07, 16.4350, 51.1957),
    f('Canindo', 54_854_348.29, 15.5157, 66.7114),
    f('8 Esquinas', 52_778_444.77, 14.9286, 81.6400),
    f('La Piedad Abastos', 22_909_527.99, 6.4800, 88.1200),
    f('Morelia Madero', 22_605_296.05, 6.3941, 94.5141),
    f('Zamora Centro', 12_838_038.62, 3.6311, 98.1452),
    f('Yurécuaro', 6_557_858.01, 1.8549, 100.0000),
  ],
};

describe('[PVI.20] la pantalla de decidir', () => {
  let fx: ComponentFixture<PresupuestoDecisionComponent>;

  const montar = (over: Record<string, unknown> = {}) => {
    fx = TestBed.createComponent(PresupuestoDecisionComponent);
    fx.componentRef.setInput('concentracion', MOSTRADOR);
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

  it('⛔ EL DEFECTO QUE CIERRA: las dos bandas que no son cabeza ESTÁN en pantalla', () => {
    const txt = montar().textContent ?? '';
    expect(txt).toContain('2 partidas intermedias');
    expect(txt).toContain('$45,514,824');
    expect(txt).toContain('2 bajo el 5 % cada una');
    expect(txt).toContain('$19,395,897');
  });

  it('⛔ y la frase ya NO invita a leer el resto como chico', () => {
    const txt = montar().textContent ?? '';
    expect(txt).toContain('Las intermedias si');
  });

  it('⛔ EL UNIVERSO: la pantalla dice de qué es el 80 % y de qué es recorte', () => {
    const el = montar();
    expect(el.querySelector('.dec-universo')?.textContent)
      .toContain('Mostrador — 58.5 % de el ingreso del ejercicio');
    const txt = el.textContent ?? '';
    expect(txt).toContain('4 partidas cruzan el 80 % de Mostrador');
    expect(txt).not.toContain('del plan');
  });

  it('⛔ ADR-056: sin venta real NO publica un cumplimiento — dice qué falta', () => {
    const el = montar();
    const txt = el.textContent ?? '';
    expect(txt).toContain('no se puede decir');
    expect(txt).toContain('venta real del ejercicio');
    expect(txt).toContain('meta de 3 períodos');
    /*
     * ⚠️ La aserción se acota al VEREDICTO. Buscar «0 %» en todo el DOM no sirve: «cruzan el
     * 80 %» lo contiene, y el test se ponía rojo por una subcadena. Lo que de verdad se afirma
     * es que el bloque que contesta «¿vamos a llegar?» no publica NINGÚN porcentaje cuando no
     * se puede medir — ni 0 %, ni ninguno.
     */
    const veredicto = (el.querySelector('.dec-verdict')?.textContent ?? '')
      + (el.querySelector('.dec-falta')?.textContent ?? '');
    expect(veredicto).not.toMatch(/\d+(\.\d+)?\s*%/);
  });

  it('⭐ Q.4: la partida es un control que NAVEGA, no texto muerto', () => {
    const el = montar();
    const filas = el.querySelectorAll<HTMLButtonElement>('.dec-top-row');
    expect(filas.length).toBe(4);
    expect(filas[0].tagName).toBe('BUTTON');
    expect(filas[0].getAttribute('aria-label')).toContain('Morelia Abastos');

    const visto: (string | null)[] = [];
    fx.componentInstance.verPartida.subscribe((k: string | null) => visto.push(k));
    filas[0].click();
    expect(visto).toEqual(['morelia-abastos']);
  });

  it('la barra tiene TRES segmentos: ninguna fila queda fuera del dibujo', () => {
    const el = montar();
    expect(el.querySelectorAll('app-metric-strip .ms-seg').length).toBe(3);
  });

  it('dice lo que cuesta no firmar, y el botón emite', () => {
    const el = montar();
    expect(el.textContent).toContain('Calendario de pagos');
    let fue = 0;
    fx.componentInstance.irAFirmas.subscribe(() => fue++);
    el.querySelector<HTMLButtonElement>('.dec-block--act button')?.click();
    expect(fue).toBe(1);
  });

  it('⛔ DECLARA la pregunta que no puede contestar', () => {
    expect(montar().querySelector('.dec-gap')?.textContent).toContain('cambio desde la ultima vez');
  });

  it('una partida sin monto legible se declara, no se descarta', () => {
    const el = montar({
      concentracion: {
        ...MOSTRADOR, sin_monto: 1,
        filas: [...MOSTRADOR.filas, f('Partida sin importe', null, null, null)],
      },
    });
    expect(el.textContent).toContain('1 sin monto legible');
    expect(el.textContent).toContain('no medible');
  });

  it('sin firmas pendientes no pinta el bloque de acción (ni dice «al día»)', () => {
    const el = montar({ firmas: null });
    expect(el.querySelector('.dec-block--act')).toBeNull();
    expect(el.textContent).not.toContain('al día');
  });

  it('sin concentración lo declara en vez de pintar una barra vacía', () => {
    const el = montar({ concentracion: null });
    expect(el.querySelector('app-metric-strip')).toBeNull();
    expect(el.textContent).toContain('No hay partidas');
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
