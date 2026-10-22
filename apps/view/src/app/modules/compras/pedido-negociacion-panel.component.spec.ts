import { TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { provideRouter } from '@angular/router';
import type { PedidoNegociacionDto } from '@megadulces/contracts';
import { PedidoNegociacionPanelComponent } from './pedido-negociacion-panel.component';

/**
 * `[RA-NEG.1]` El panel «Costo y negociación». Los números son los de 70056 La Rosa Mazapán medidos
 * en prod el 2026-10-22; los controles de la calculadora se calcularon a mano antes de escribir esto.
 */
const DTO: PedidoNegociacionDto = {
  product_id: 'p-70056', sku: '70056', unidad_base: 'PAQ', base_por_caja: 16,
  costo: { estandar_base: 78.595625, reposicion_base: 82.68, precio_ficha: 102.94, impuesto_pct: 8, precio_igual_en_todas: true,
    margen_ficha_pct: 21.27, precio_conserva_margen: 108.29, impacto_30d: 17735.76, sucursales_afectadas: ['01', '03', '07', '08'] },
  pagado: { desde: '2025-10-22', hasta: '2026-10-22',
    meses: [{ mes: '2026-01', base: 2400, promedio: 89, min: 84.88, max: 89.3 }, { mes: '2026-10', base: 6320, promedio: 81.7, min: 78.6, max: 82.68 }],
    ultimo: { fecha: '2026-10-21', sucursal: '06', costo_base: 78.595 }, minimo: { fecha: '2026-06-29', sucursal: '06', costo_base: 72.44, base: 1280 },
    total_base: 52368, total_valor: 4455190.69, renglones: 81, renglones_sin_unidad: 0, renglones_atipicos: 0, al_estandar_reciente: [], entradas: [] },
  proveedor: { supplier_id: 's-1', nombre: 'DISTRIBUIDORA DE LA ROSA SA DE CV', compras_12m: 81143559.22, recepciones_12m: 618,
    descuento_pago_12m: 3131340.22, descuento_notas_12m: 2092748.91, descuento_pct: 6.44, pronto_pago: null,
    plazo_dias: 20, plazo_base: 'factura', plazo_kepler: [{ dias: 19, recepciones: 388 }, { dias: 21, recepciones: 230 }], tiempo_entrega_dias: null,
    reclamos: { del_proveedor: 0, en_la_base: 0 } },
  generado_at: '2026-10-22T12:00:00Z',
};

function montar(d: PedidoNegociacionDto = DTO, cajas = 82, links = { costos: true, descuentos: true, proveedores: true }) {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({ imports: [PedidoNegociacionPanelComponent], providers: [provideZonelessChangeDetection(), provideRouter([])] });
  const f = TestBed.createComponent(PedidoNegociacionPanelComponent);
  f.componentRef.setInput('d', d);
  f.componentRef.setInput('cajas', cajas);
  f.componentRef.setInput('links', links);
  f.detectChanges();
  return f;
}
const texto = (f: ReturnType<typeof montar>) => ((f.nativeElement as HTMLElement).textContent || '').replace(/\s+/g, ' ');

describe('[RA-NEG.1] panel «Costo y negociación»', () => {
  it('lo primario: costo de hoy por caja, estándar, precio y el margen REAL (no el de la ficha)', () => {
    const f = montar();
    const t = texto(f);
    expect(t).toContain('$1,322.88');          // 82.68 × 16
    expect(t).toContain('$1,257.53');          // 78.595625 × 16
    expect(t).toContain('$102.94');
    expect(t).toContain('15.3 %');
    expect(t).toContain('ficha 21.3 %');
  });

  it('CONTROL de la calculadora: al estándar el margen sube a 21.3 % y en 82 cajas ahorras $5,359', () => {
    const f = montar();
    const c = f.componentInstance;
    c.fijar(c.cajaEst());
    f.detectChanges();
    expect(c.calc().margen!).toBeCloseTo(21.27, 1);
    expect(c.verbo(c.calc().dif)).toBe('ahorras ');
    expect(c.monto(c.calc().dif * 82)).toBe('$5,359');                // (1322.88 − 1257.53) × 82
    expect(c.monto(c.calc().dif * c.cajasAnio())).toBe('$213,891');   // × 3,273 cajas del año
    expect(texto(f)).toContain('ahorras $5,359');
  });

  it('un costo MÁS caro se dice «pagas de más», no con un signo', () => {
    const c = montar().componentInstance;
    c.fijar(1400);
    expect(c.verbo(c.calc().dif)).toBe('pagas de más ');
    expect(c.calc().margen!).toBeLessThan(15.3);
  });

  it('«hoy» regresa al costo de hoy', () => {
    const c = montar().componentInstance;
    c.fijar(1000);
    c.costoProbado.set(null);
    expect(c.calc().dif).toBe(0);
  });

  it('el mínimo del año se nombra por su sucursal, y lo de oficinas no se llama CEDIS', () => {
    const f = montar();
    expect(texto(f)).toContain('en Canindo');
    expect(f.componentInstance.dondeTxt('00')).toBe('(oficinas)');
  });

  it('⛔ reclamos con la tabla vacía: «sin registro», nunca un «0» que se lea «nada faltó»', () => {
    const t = texto(montar());
    expect(t).toContain('sin registro');
  });

  it('el tiempo de entrega no capturado se DECLARA y lleva a capturarlo', () => {
    const f = montar();
    expect(texto(f)).toContain('no capturado');
    expect((f.nativeElement as HTMLElement).querySelector('a[href*="/compras/proveedores"]')).not.toBeNull();
  });

  it('⛔ sin permiso, no hay enlace a una pantalla que diría «sin acceso»', () => {
    const f = montar(DTO, 82, { costos: false, descuentos: false, proveedores: false });
    expect((f.nativeElement as HTMLElement).querySelectorAll('a').length).toBe(0);
  });

  it('sin proveedor y sin compras: se dice, no se dibujan ceros', () => {
    const vacio: PedidoNegociacionDto = { ...DTO, proveedor: null,
      pagado: { ...DTO.pagado, meses: [], ultimo: null, minimo: null, total_base: 0, total_valor: 0, renglones: 0 } };
    const t = texto(montar(vacio));
    expect(t).toContain('no tiene proveedor');
    expect(t).toContain('Sin compras a este proveedor en 12 meses');
  });

  it('[RA-NEG.3] «Historial» y «Descuentos» ABREN el detalle aquí: emiten, no navegan', () => {
    const f = montar();
    const vistas: string[] = [];
    f.componentInstance.abrir.subscribe((v) => vistas.push(v));
    const bs = [...(f.nativeElement as HTMLElement).querySelectorAll('button.ng-lnk')] as HTMLButtonElement[];
    bs.forEach((b) => b.click());
    expect(vistas).toEqual(['historial', 'descuentos']);
    expect((f.nativeElement as HTMLElement).querySelector('a[href*="/compras/catalogo"], a[href*="/compras/descuentos"]')).toBeNull();
  });

  it('lo que sí lleva a otra pantalla (capturar el tiempo de entrega) se abre en OTRA pestaña, dicho', () => {
    const a = (montar().nativeElement as HTMLElement).querySelector('a[href*="/compras/proveedores"]') as HTMLAnchorElement;
    expect(a.target).toBe('_blank');
    expect(a.textContent).toContain('otra pestaña');
  });

  it('dos precios entre sucursales se declaran junto al precio', () => {
    const t = texto(montar({ ...DTO, costo: { ...DTO.costo, precio_igual_en_todas: false } }));
    expect(t).toContain('distinto por sucursal');
  });
});
