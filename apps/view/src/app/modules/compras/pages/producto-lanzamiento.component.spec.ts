import { ComponentFixture, TestBed } from '@angular/core/testing';
import { HttpErrorResponse } from '@angular/common/http';
import { NEVER, of, throwError } from 'rxjs';
import { vi } from 'vitest';
import { DetalleNuevo, ProductosNuevosService } from '../productos-nuevos.service';
import { ProductoLanzamientoComponent, noEsNuevo } from './producto-lanzamiento.component';
import { DETALLE, producto } from '../../../../testing/productos-nuevos.fixture';

/**
 * `[NP.22]` La sección «Lanzamiento» de la ficha: lo que mostraba el panel de la pantalla Productos nuevos. Las pruebas
 * son las de aquel panel, MOVIDAS (mismos datos y mismas afirmaciones); cambian los selectores y que ahora se monta
 * dentro de la ficha. «¿Hay que comprar?» ya no va aquí (es «Qué hacer» de la ficha Detallada).
 */
const tick = async (fix: ComponentFixture<unknown>) => {
  fix.detectChanges();
  await fix.whenStable();
  await new Promise((r) => setTimeout(r, 0));
  fix.detectChanges();
};

const CON_FOTO: DetalleNuevo = {
  ...DETALLE,
  hitos_info: { umbrales_disponibles: true, umbrales: 0 },
  compra_info: { medida: true, documentos: 3, descontados: 1, sin_documento: 0, no_cuadra: 0 },
  producto: producto({
    venta_neta_total: 29469.83,
    hitos: {
      30: { cerrado: true, inversion: 26000, venta: 22260, venta_neta: 19189.66, venta_por_peso: 0.74, unidades: { CJA: 10 },
        semaforo: { kpi_key: 'compras.productos_nuevos.venta_por_peso.d30', valor: 0.74, estado: 'sin_meta',
          motivo: 'Hay cifra y no hay meta registrada', escala_a: null, avance: null } },
      60: { cerrado: false, inversion: 26000, venta: 34185, venta_neta: 29469.83, venta_por_peso: 1.13, unidades: {}, semaforo: null },
      90: { cerrado: false, inversion: 26000, venta: 34185, venta_neta: 29469.83, venta_por_peso: 1.13, unidades: {}, semaforo: null },
    },
  }),
};

describe('[NP.22] ProductoLanzamientoComponent — «Lanzamiento» en la ficha', () => {
  let fix: ComponentFixture<ProductoLanzamientoComponent>;
  let api: { detalle: ReturnType<typeof vi.fn>; listar: ReturnType<typeof vi.fn> };

  async function montar(respuesta: (id?: unknown) => unknown, inputs: { esNuevo?: boolean | null; veredictoCompra?: string | null; id?: string; sinEsperar?: boolean } = {}) {
    api = { detalle: vi.fn(respuesta), listar: vi.fn() };
    await TestBed.configureTestingModule({
      imports: [ProductoLanzamientoComponent],
      providers: [{ provide: ProductosNuevosService, useValue: api }],
    }).compileComponents();
    fix = TestBed.createComponent(ProductoLanzamientoComponent);
    fix.componentRef.setInput('productId', inputs.id ?? 'p-1');
    if (inputs.esNuevo !== undefined) fix.componentRef.setInput('esNuevo', inputs.esNuevo);
    if (inputs.veredictoCompra !== undefined) fix.componentRef.setInput('veredictoCompra', inputs.veredictoCompra);
    // Con una respuesta que nunca llega, whenStable no regresaría: se pinta sin esperarla.
    if (inputs.sinEsperar) { for (let i = 0; i < 3; i++) { fix.detectChanges(); await new Promise((r) => setTimeout(r, 0)); } } else await tick(fix);
    return fix.nativeElement as HTMLElement;
  }

  afterEach(() => {
    vi.useRealTimers();
    TestBed.resetTestingModule();
  });

  /** Las tres tarjetas de cortes, como texto plano. */
  const cortes = (el: HTMLElement) => Array.from(el.querySelectorAll('.lz-corte')).map((li) => li.textContent!.replace(/\s+/g, ' '));

  it('⛔ [NP.22] la tarjeta del resultado se retiró (David): el resultado está en la lista; la sección abre con los cortes', async () => {
    const el = await montar(() => of(DETALLE));
    expect(api.detalle).toHaveBeenCalledWith('p-1');
    expect(el.querySelector('.lz-ver')).toBeNull();
    expect(el.textContent).not.toContain('Se vendió 27 de los últimos 28 días');
    expect(el.querySelector('.lz-cuerpo')!.firstElementChild?.querySelector('.lz-cortes')).not.toBeNull();
  });

  it('⛔ [NP.22] «Comportamiento global» se retiró completo: ni cifras, ni avisos, ni tendencia, ni gráfica semanal, ni la nota larga', async () => {
    const el = await montar(() => of(DETALLE));
    expect(el.querySelector('.lz-global')).toBeNull();
    expect(el.querySelector('app-metric-strip')).toBeNull();
    for (const t of ['Comportamiento global', 'Llegó a la empresa', 'camiones de ruta', 'contra las 4 semanas anteriores',
      'Venta por semana completa', 'no se puede reconstruir', 'Qué recomendaba la pantalla']) expect(el.textContent).not.toContain(t);
    // La gráfica grande se fue; las mini de cada sucursal se quedan.
    expect(el.querySelector('.lz-spk')).toBeNull();
  });

  it('⛔ «¿Hay que comprar?» NO se repite aquí (es «Qué hacer» de la ficha Detallada)', async () => {
    const el = await montar(() => of(DETALLE));
    expect(el.textContent).not.toContain('¿Hay que comprar?');
  });

  it('⭐ «Sacar» aquí y «Comprar» en Qué hacer: queda UNA línea que lo explica, arriba de los cortes', async () => {
    const sacar = { ...DETALLE, producto: producto({ recomendacion: { veredicto: 'sacar', motivos: ['Lleva 25 días sin venderse'] } }) };
    const el = await montar(() => of(sacar), { veredictoCompra: 'comprar' });
    expect(el.querySelector('.lz-cruce')?.textContent).toContain('Antes de reponer');
  });

  it('[negativa] sin el veredicto de compra de la ficha (Sencillo) no hay cruce que explicar', async () => {
    const sacar = { ...DETALLE, producto: producto({ recomendacion: { veredicto: 'sacar', motivos: ['Lleva 25 días sin venderse'] } }) };
    const el = await montar(() => of(sacar));
    expect(el.querySelector('.lz-cruce')).toBeNull();
  });

  it('⭐ cortes 30 · 60 · 90 en tres tarjetas (sin tabla): definitivo, en curso o todavía no llega, con sus unidades', async () => {
    const el = await montar(() => of(DETALLE));
    expect(el.querySelector('.lz-cortes p-table, .lz-cortes table')).toBeNull();
    const c = cortes(el);
    expect(c.length).toBe(3);
    expect(c[0]).toContain('A 30 días');
    expect(c[0]).toContain('Definitivo');
    expect(c[1]).toContain('En curso');
    expect(c[2]).toContain('Todavía no llega');
    // 10 cajas y 20 piezas = 11 cajas y 8 piezas con caja de 12.
    expect(c[0]).toContain('11 cajas y 8 piezas');
    expect(c[1]).toContain('25 cajas y 4 piezas');
    // Lo que no aplica todavía va con guion, nunca $0.
    expect(c[2]).toContain('—');
    expect(c[2]).not.toContain('$0');
    expect(el.querySelector('.lz-corte.is-curso')).not.toBeNull();
  });

  it('⭐ venta por $1 en la tarjeta, SIN meta (David la quitó el 2026-11-04), y «sin impuestos» dicho en el encabezado', async () => {
    const el = await montar(() => of(CON_FOTO));
    const c30 = cortes(el)[0];
    expect(c30).toContain('Definitivo');
    expect(c30).toContain('Vendido');
    expect(c30).toContain('Invertido');
    expect(c30).toContain('$0.74');
    // [negativa] la meta y su semáforo ya no se pintan en las tarjetas.
    expect(c30).not.toContain('Meta');
    expect(c30).not.toContain('Sin meta');
    expect(el.querySelector('.lz-h-nota')?.textContent).toContain('venta sin impuestos ÷ compra sin impuestos');
    expect(el.textContent).not.toMatch(/[Cc]ongelad|la foto dice/);
  });

  it('⛔ sin permiso de costo: ni «Invertido», ni «Por $1», ni la meta, ni márgenes; sí dónde se mueve mejor', async () => {
    const sinCosto = { ...CON_FOTO, costo_visible: false, producto: { ...CON_FOTO.producto, margenes: null },
      plazas: DETALLE.plazas.map((p) => ({ ...p, margenes: null })) };
    const el = await montar(() => of(sinCosto));
    for (const c of cortes(el)) {
      expect(c).not.toContain('Invertido');
      expect(c).not.toContain('Por $1');
      expect(c).not.toContain('Meta');
    }
    expect(el.querySelector('.lz-h-nota')).toBeNull();
    expect(el.querySelector('.lz-margenes')).toBeNull();
    expect(el.querySelector('.lz-rank')?.textContent).not.toContain('Margen real');
    expect(el.querySelectorAll('.lz-sucs > li').length).toBe(2);
  });

  it('[NP.18] si los renglones de compra no se pudieron leer, se dice (la inversión puede traer impuestos); [negativa] medida, no', async () => {
    let el = await montar(() => of({ ...CON_FOTO, compra_info: { medida: false, documentos: 0, descontados: 0, sin_documento: 0, no_cuadra: 0 } }));
    expect(el.textContent).toContain('No se pudieron leer los renglones de compra');
    TestBed.resetTestingModule();
    el = await montar(() => of(CON_FOTO));
    expect(el.textContent).not.toContain('No se pudieron leer los renglones de compra');
  });

  it('[NP.15] ⭐ los tres márgenes y dónde se mueve mejor', async () => {
    const el = await montar(() => of(DETALLE));
    const margenes = Array.from(el.querySelectorAll('.lz-margenes > div'));
    expect(margenes.map((t) => t.querySelector('b')?.textContent?.trim())).toEqual(['17.0%', '10.1%', '—']);
    // [NP.22] Sin leyendas a la vista (pedido de David); la cobertura parcial SIGUE declarada en el «*» (no se pinta como completo).
    expect(margenes[1].querySelector('.lz-ast')?.getAttribute('aria-label')).toContain('no registró el costo en el 20%');
    expect(margenes[2].querySelector('.lz-ast')?.getAttribute('title')).toContain('Sin compras en Kepler');
    expect(margenes[0].querySelector('.lz-ast')).toBeNull(); // [negativa] el completo no lleva «*»
    expect(el.querySelector('.lz-margenes')!.textContent).not.toContain('¿Con qué margen');
    expect(el.querySelector('.lz-margenes')!.textContent).not.toContain('de margen');
    const filas = Array.from(el.querySelectorAll('.lz-sucs > li'));
    expect(filas[0].textContent).toContain('Padre Hidalgo');
    expect(filas[0].classList.contains('is-mejor')).toBe(true);
    expect(filas[1].textContent).toContain('90%');
  });

  it('⭐ [NP.22] el CEDIS no tiene tarjeta en «Por sucursal», y lo que compró se dice en la frase de lo que llegó', async () => {
    const cedis = { ...DETALLE.plazas[1], plaza: '00', nombre: 'CEDIS BPIRAPUATO', unidades_recibidas: { CAJAS: 788 } };
    const el = await montar(() => of({ ...DETALLE, plazas: [...DETALLE.plazas, cedis] } as typeof DETALLE));
    const tarjetas = Array.from(el.querySelectorAll('.lz-sucs > li')).map((li) => li.textContent ?? '');
    expect(tarjetas.length).toBe(DETALLE.plazas.length);
    expect(tarjetas.some((t) => t.includes('CEDIS'))).toBe(false);
    expect(el.querySelector('.lz-texto')!.textContent!.replace(/\s+/g, ' ')).toMatch(/de ellas, 788 \S+ por el CEDIS/);
    // [negativa] sin CEDIS en los datos, la frase no lo menciona.
    TestBed.resetTestingModule();
    const el2 = await montar(() => of(DETALLE));
    expect(el2.querySelector('.lz-texto')!.textContent).not.toContain('CEDIS');
  });

  it('⭐ ¿Dónde se mueve mejor? trae lo vendido en unidades de Kepler y la existencia de hoy', async () => {
    const el = await montar(() => of(DETALLE));
    const filas = Array.from(el.querySelectorAll('.lz-sucs > li'));
    const celda = (tr: Element, label: string) => tr.querySelector(`[data-label="${label}"]`)!;
    const limpio = (x: Element | null) => x?.textContent?.replace(/\s+/g, ' ').trim();
    // [NP.22] «Le llegó» = Compró + Le llegó de otra: en la lista unificada se ven por separado (no la suma repetida).
    expect(Array.from(celda(filas[0], 'Compró').querySelectorAll('.lz-cant')).map(limpio)).toEqual(['100 cajas']);
    expect(limpio(celda(filas[0], 'Vendido'))).toContain('22 cajas');
    expect(celda(filas[0], 'Existencia hoy').textContent).toContain('Agotado');
    expect(limpio(celda(filas[1], 'Vendido'))).toContain('3 cajas y 4 piezas');
    expect(Array.from(celda(filas[1], 'Compró').querySelectorAll('.lz-cant')).map(limpio)).toEqual(['35 cajas']);
    expect(Array.from(celda(filas[1], 'Le llegó de otra').querySelectorAll('.lz-cant')).map(limpio)).toEqual(['10 cajas']);
    expect(Array.from(celda(filas[1], 'Existencia hoy').querySelectorAll('.lz-cant')).map(limpio)).toEqual(['3 cajas']);
    expect(celda(filas[1], 'Existencia hoy').textContent).not.toContain('≈');
  });

  it('⭐ una sucursal con la existencia en duda: la etiqueta y lo que debería haber', async () => {
    const plazas = DETALLE.plazas.map((p, i) => (i === 0 ? { ...p, existencia_duda: { kepler: -3, estimada: 60, base: 'PZA', otros: ['PAQ'] } } : p));
    const el = await montar(() => of({ ...DETALLE, plazas }));
    const td = el.querySelector('.lz-sucs > li [data-label="Existencia hoy"]')!;
    expect(td.textContent).toContain('En duda');
    expect(td.textContent).not.toContain('Agotado');
    expect(td.querySelector('.lz-cant')?.textContent?.replace(/\s+/g, ' ').trim()).toBe('5 cajas');
  });

  it('⭐ por sucursal: lo que nos llegó en compras, cómo se repartió y cada sucursal con su resultado', async () => {
    const el = await montar(() => of(DETALLE));
    expect(el.textContent).toContain('Nos llegaron');
    expect(el.textContent).toContain('135 cajas');
    // [NP.22] Una tarjeta por sucursal con su reparto y su resultado (ya no tabla de reparto aparte).
    expect(el.querySelector('p-table')).toBeNull();
    const plazas = Array.from(el.querySelectorAll('.lz-sucs > li.lz-plaza')).map((li) => li.textContent!.replace(/\s+/g, ' '));
    expect(plazas.length).toBe(2);
    expect(plazas[0]).toContain('Padre Hidalgo');
    expect(plazas[0]).toMatch(/Compró\s*100 cajas/);
    expect(plazas[0]).toContain('4 paquetes');
    expect(plazas[0]).toContain('Agotado');
    expect(plazas[0]).toContain('22 cajas');
    expect(plazas[1]).toContain('Yurécuaro');
    expect(plazas[1]).toMatch(/Le llegó de otra\s*10 cajas/);
    expect(plazas[1]).toMatch(/Hoy\s*3 cajas/);
    expect(plazas[1]).toContain('3 cajas y 4 piezas');
    // Cada cantidad una sola vez: «Compró» aparece una vez por sucursal, no en tabla y en tarjeta.
    expect((el.textContent!.match(/Compró/g) ?? []).length).toBe(2);
    // [negativa] las notas largas se quitaron a pedido de David; la edad del dato SÍ se queda (regla de frescura).
    expect(el.textContent).not.toContain('Compró = ');
    expect(el.textContent).not.toContain('Sólo Kepler');
    expect(el.textContent).not.toContain('¿Dónde se mueve mejor?');
    expect(el.querySelector('.lz-pie')?.textContent).toContain('En vivo al');
    // [negativa] sin gráficas ni línea de motivos por sucursal (se quitaron a pedido de David); la venta de hoy se queda.
    expect(el.querySelector('.lz-sucs app-sparkline')).toBeNull();
    expect(el.querySelector('.lz-rk-motivo')).toBeNull();
    for (const p of DETALLE.plazas) for (const m of p.recomendacion.motivos) expect(el.querySelector('.lz-sucs')!.textContent).not.toContain(m);
    if (DETALLE.plazas.some((p) => p.venta_hoy > 0)) expect(el.querySelector('.lz-sucs')!.textContent).toContain('Vendido hoy');
  });

  it('⛔ [NP.22] una sucursal agotada NO pinta «Agotado: no se juzga» (ya lo dice «Hoy · Agotado»); otro resultado sí se pinta', async () => {
    const plazas = DETALLE.plazas.map((p, i) => ({ ...p, recomendacion: { ...p.recomendacion, veredicto: i === 0 ? 'agotado' : 'se_queda' } }));
    const el = await montar(() => of({ ...DETALLE, plazas } as typeof DETALLE));
    const tarjetas = Array.from(el.querySelectorAll('.lz-sucs > li'));
    expect(tarjetas[0].textContent).not.toContain('no se juzga');
    expect(tarjetas[0].querySelector('.lz-rk-cab p-tag')).toBeNull();
    // [negativa] la otra sí lleva su resultado.
    expect(tarjetas[1].querySelector('.lz-rk-cab p-tag')).not.toBeNull();
  });

  it('⛔ un producto que NO es nuevo (404) no pinta nada ni se reporta como falla', async () => {
    const el = await montar(() => throwError(() => new HttpErrorResponse({ status: 404, statusText: 'Not Found' })));
    expect(el.querySelector('.lz')).toBeNull();
    expect(el.textContent).not.toContain('No se pudo');
    expect(noEsNuevo(new HttpErrorResponse({ status: 404 }))).toBe(true);
    expect(noEsNuevo({ cause: new HttpErrorResponse({ status: 500 }) })).toBe(false);
  });

  it('[negativa] una falla de verdad (500) SÍ se dice, con reintentar', async () => {
    const el = await montar(() => throwError(() => new HttpErrorResponse({ status: 500 })));
    expect(el.querySelector('.lz')).not.toBeNull();
    expect(el.textContent).toContain('No se pudo leer el lanzamiento');
  });

  it('el renglón dice que NO es nuevo: ni se pide', async () => {
    const el = await montar(() => of(DETALLE), { esNuevo: false });
    expect(api.detalle).not.toHaveBeenCalled();
    expect(el.querySelector('.lz')).toBeNull();
  });

  it('el renglón dice que SÍ es nuevo: la sección aparece mientras carga (no salta después)', async () => {
    const el = await montar(() => NEVER, { esNuevo: true, sinEsperar: true });
    expect(el.querySelector('.lz')).not.toBeNull();
    expect(el.querySelector('.lz-corte')).toBeNull();
  });

  it('⭐ en vivo: se vuelve a pedir cada minuto y, mientras, se queda lo que había (sin pantallazo)', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    let llamadas = 0;
    const el = await montar(() => (++llamadas === 1 ? of(DETALLE) : NEVER), { sinEsperar: true });
    expect(el.querySelectorAll('.lz-plaza').length).toBe(2);
    vi.advanceTimersByTime(60_000);
    for (let i = 0; i < 3; i++) { fix.detectChanges(); await new Promise((r) => setTimeout(r, 0)); }
    expect(api.detalle).toHaveBeenCalledTimes(2);
    expect(el.querySelectorAll('.lz-plaza').length).toBe(2);
  });

  it('[negativa] al cambiar de producto no se muestra el lanzamiento del anterior', async () => {
    await montar((id?: unknown) => (id === 'p-1' ? of(DETALLE) : NEVER), { sinEsperar: true });
    expect(fix.componentInstance.det()?.producto.product_id).toBe('p-1');
    fix.componentRef.setInput('productId', 'p-2');
    for (let i = 0; i < 3; i++) { fix.detectChanges(); await new Promise((r) => setTimeout(r, 0)); }
    expect(fix.componentInstance.det()).toBeNull();
  });
});
