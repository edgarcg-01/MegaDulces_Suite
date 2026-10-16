import { TestBed } from '@angular/core/testing';
import { MetricStripComponent, MetricStripItem } from './metric-strip.component';

/**
 * La ausencia NO se pinta como cero (ADR-056).
 *
 * `MetricStripItem.value` admite `string`, y la rama numérica del strip pasa por
 * `num()` = `Number(value) || 0`. Un llamador que manda `'—'` y se olvida de
 * `format: 'text'` termina pintando **0** — con la bajada explicando por qué no
 * hay dato justo al lado. Pasó de verdad en `/compras/pedido`: el KPI
 * "Inventario" mostraba `0` con la bajada "sin demanda medida".
 *
 * `isText()` cierra esa puerta en el componente, no en cada llamador.
 * Las dos primeras pruebas son las NEGATIVAS: si alguien revierte la guarda,
 * se ponen rojas.
 */
describe('MetricStripComponent · isText (la ausencia no se dibuja como 0)', () => {
  // El componente declara sus entradas con `input()`, que exige contexto de inyección: un
  // `new` pelado tira NG0203 y la suite entera no arranca.
  let c: MetricStripComponent;
  beforeEach(() => {
    TestBed.configureTestingModule({});
    c = TestBed.runInInjectionContext(() => new MetricStripComponent());
  });
  const item = (v: MetricStripItem['value'], format?: MetricStripItem['format']): MetricStripItem =>
    ({ label: 'x', value: v, format });

  it('trata el guion como TEXTO aunque el llamador no declare format', () => {
    expect(c.isText(item('—'))).toBe(true);
    // La prueba negativa de verdad: lo que se evita es este 0.
    expect(c.num(item('—'))).toBe(0);
  });

  it('trata la cadena vacía como TEXTO (Number("") es 0 y es finito)', () => {
    expect(c.isText(item(''))).toBe(true);
    expect(c.isText(item('   '))).toBe(true);
  });

  it('respeta format: "text" cuando el llamador sí lo declara', () => {
    expect(c.isText(item('Sucursal 01', 'text'))).toBe(true);
  });

  it('NO desvía a texto los valores realmente numéricos', () => {
    expect(c.isText(item(42))).toBe(false);
    expect(c.isText(item(0))).toBe(false);          // un cero MEDIDO sí es un cero
    expect(c.isText(item(-3.5))).toBe(false);
    expect(c.isText(item('42'))).toBe(false);       // numérico en string
    expect(c.isText(item('0'))).toBe(false);
  });

  it('un número con formato de moneda sigue por la rama numérica', () => {
    expect(c.isText(item(1240, 'currency'))).toBe(false);
  });
});

/**
 * `[VP.MS]` El estado de MEDICIÓN es ortogonal al tono, y `no_medido` inhabilita el tono.
 *
 * Medido el 2026-10-08, antes de que esto existiera: 85 pantallas usan este organismo y hay
 * 22 sitios con `tone: 'ok'` clavado sin condición. El freno vive en el componente y no en
 * cada llamador, porque una regla que depende de que 85 se acuerden no es una regla.
 *
 * Las pruebas marcadas NEGATIVA se ponen rojas si alguien revierte la guarda.
 */
describe('MetricStripComponent · estado de medicion (VP.MS)', () => {
  let c: MetricStripComponent;
  beforeEach(() => {
    TestBed.configureTestingModule({});
    c = TestBed.runInInjectionContext(() => new MetricStripComponent());
  });
  const it_ = (p: Partial<MetricStripItem>): MetricStripItem => ({ label: 'x', value: 1, ...p });

  it('NEGATIVA: no_medido NO puede pedir verde', () => {
    // Esto es el `cfg ? classify : 'ok'` que la Fase VP documento, cerrado en el componente.
    expect(c.effTone(it_({ state: 'no_medido', tone: 'ok' }))).toBe('muted');
    expect(c.effTone(it_({ state: 'no_medido', tone: 'bad' }))).toBe('muted');
    expect(c.effTone(it_({ state: 'no_medido' }))).toBe('muted');
  });

  it('NEGATIVA: parcial y derivado CONSERVAN su tono', () => {
    // Si se neutralizaran tambien, se escoderia el juicio en vez de calificarlo: una cifra
    // parcial puede ser buena o mala DENTRO de lo que cubre.
    expect(c.effTone(it_({ state: 'parcial', tone: 'ok' }))).toBe('ok');
    expect(c.effTone(it_({ state: 'derivado', tone: 'bad' }))).toBe('bad');
    expect(c.effTone(it_({ state: 'medido', tone: 'ok' }))).toBe('ok');
  });

  it('no cambia nada para quien no declara estado (es aditivo)', () => {
    expect(c.effTone(it_({ tone: 'ok' }))).toBe('ok');
    expect(c.effTone(it_({}))).toBe('default');
  });

  it('derivado se muestra CON su metodo', () => {
    expect(c.stateText(it_({ state: 'derivado', method: 'proxy_canal' }))).toBe('derivado · proxy_canal');
    expect(c.stateText(it_({ state: 'no_medido' }))).toBe('no medido');
  });

  it('NEGATIVA: un derivado SIN metodo se declara, no se calla', () => {
    // Callarlo lo volveria indistinguible de un derivado bien documentado.
    expect(c.stateTitle(it_({ state: 'derivado' }))).toContain('sin método declarado');
    expect(c.stateTitle(it_({ state: 'derivado', method: 'estacional' }))).toBeNull();
    expect(c.stateTitle(it_({ state: 'parcial', stateNote: 've el 11.8%' }))).toBe('ve el 11.8%');
  });
});

/**
 * `[ETQ-CAMBIOS.10]` Densidad compacta: cada métrica en UNA línea. Es ADITIVA — el default no
 * puede cambiar nada para las pantallas que ya usan el organismo, y la versión compacta no puede
 * perder ninguna métrica (ahorrar alto no es quitar información).
 */
describe('MetricStripComponent · densidad compacta (ETQ-CAMBIOS.10)', () => {
  const items: MetricStripItem[] = [
    { label: 'Para reimprimir', value: 101, format: 'number', sub: 'etiquetas' },
    { label: 'Subieron', value: 90, format: 'number', tone: 'bad' },
    { label: 'Bajaron', value: 10, format: 'number', tone: 'ok' },
    { label: 'Sin precio', value: 1, format: 'number', tone: 'warn', sub: 'el ERP se lo quitó' },
  ];
  const montar = (density?: 'normal' | 'compact') => {
    TestBed.configureTestingModule({});
    const fix = TestBed.createComponent(MetricStripComponent);
    fix.componentRef.setInput('items', items);
    if (density) fix.componentRef.setInput('density', density);
    fix.detectChanges();
    return fix.nativeElement as HTMLElement;
  };

  it('el default NO es compacto: las pantallas que ya lo usan no cambian', () => {
    expect(montar().querySelector('.ms')?.classList.contains('ms--compact')).toBe(false);
  });

  it('compact marca el contenedor, sin quitar el modo', () => {
    const ms = montar('compact').querySelector('.ms')!;
    expect(ms.classList.contains('ms--compact')).toBe(true);
    expect(ms.classList.contains('ms--strip')).toBe(true);
  });

  it('NEGATIVA: compactar no pierde ninguna métrica ni su nota', () => {
    const el = montar('compact');
    expect(el.querySelectorAll('.ms-item')).toHaveLength(4);
    const t = el.textContent ?? '';
    for (const l of ['Para reimprimir', 'Subieron', 'Bajaron', 'Sin precio']) expect(t).toContain(l);
    expect(t).toContain('el ERP se lo quitó');
  });
});
