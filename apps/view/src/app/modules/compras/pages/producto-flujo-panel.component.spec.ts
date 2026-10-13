import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { NEVER, of, throwError } from 'rxjs';
import { vi } from 'vitest';
import { escaleraUnidades } from '@megadulces/contracts';
import { FlujoDetalle, PlazaFlujo, ProductosFlujoService } from '../productos-flujo.service';
import type { LoteCaducidad, MargenesProducto } from '../productos-flujo.service';
import {
  ProductoFlujoPanelComponent,
  diasTexto,
  liderTexto,
  cantidadEnCajas,
  trazos,
  variacionTexto,
} from './producto-flujo-panel.component';

// 96087: paquete de 10, caja de 60.
const KINDER = escaleraUnidades({ u1: 'PZA', u2: 'PAQ', u3: 'CJA', f2: 10, f3: 60, uxc: 60 });

const plaza = (over: Partial<PlazaFlujo>): PlazaFlujo => ({
  plaza: '01', nombre: 'Padre Hidalgo', mes: 900, mes_anterior_mismo: 800, mes_anterior_total: 2500, variacion: 0.13,
  venta_dia: 100, unidades_dia: 10, ultima_venta: '2026-10-09', dias_sin_venta: 0,
  existencia: 334, existencia_duda: null, existencia_usada: 334, cobertura_dias: 33.4,
  estado: 'se_mueve', motivo: 'Alcanza para 33 días al ritmo actual', escalera: KINDER, inmovilizado: null, ...over,
});

const DETALLE: FlujoDetalle = {
  product_id: 'p-1', sku: '96087', nombre: 'KINDER DELICE',
  periodos: { hoy: '2026-10-09', mesIni: '2026-10-01', dias: 9, prevIni: '2026-09-01', prevFin: '2026-09-10', desde30: '2026-09-10', desdeHistoria: '2026-06-11' },
  corte: '2026-10-09', en_vivo_al: '2026-10-09T18:00:00.000Z', costo_visible: false,
  criterio: { ventanaRitmo: 30, ventanaHistoria: 120, diasEstancado: 14, caidaFrenado: 0.5, diasMinimosComparar: 7,
    coberturaComprar: 15, coberturaSobra: 60, coberturaQueSeQueda: 30, ventanaReparto: 90,
    lideresCorte: 0.5, coberturaComprarLider: 21, caducidadAviso: 30,
    diasSinVenta: 30, ventanaSinVenta: 365, ventanaNuevos: 90, limiteNoSeVenden: 300, ventanaMargen: 30 },
  resumen: {
    product_id: 'p-1', mes: 15000, mes_anterior_mismo: 12000, mes_anterior_total: 46000, variacion: 0.25, venta_dia: 1500,
    estancadas: [{ plaza: '06', nombre: 'Canindo', dias_sin_venta: 20 }], frenadas: [], agotadas: [{ plaza: '04', nombre: 'Yurécuaro', venta_dia: 150 }],
    lider: null, caducidad: null,
    compra: {
      veredicto: 'traspasar', titulo: 'No comprar: mover entre sucursales',
      motivos: ['Estancado en Canindo', 'Agotado en Yurécuaro, donde sí se vende'],
      impacto: ['Mover la existencia evita comprar y libera lo estancado'],
      traspasos: [{ desde: '06', desde_nombre: 'Canindo', hacia: '04', hacia_nombre: 'Yurécuaro', cantidad: 130 }],
      cobertura_dias: 40, se_acaba: '2026-11-18', venta_en_riesgo_dia: 1500, inmovilizado: null,
    },
  },
  serie: { dias: [1, 2, 3], actual: [100, 250, null], anterior: [80, 200, 300] },
  plazas: [
    plaza({ plaza: '04', nombre: 'Yurécuaro', estado: 'agotado', existencia: 0, existencia_usada: 0, cobertura_dias: null, motivo: 'Se vende y hoy no tiene existencia' }),
    plaza({ plaza: '06', nombre: 'Canindo', estado: 'estancado', dias_sin_venta: 20, existencia: 0, existencia_usada: 1500,
      existencia_duda: { kepler: -3, estimada: 1500, base: 'PZA', otros: ['PAQ'] }, cobertura_dias: null, motivo: 'Hay existencia y lleva 20 días sin venderse' }),
    plaza({ plaza: '08', nombre: 'Morelia Abastos' }),
  ],
  llegada: { primera_compra: '2026-09-18', primera_compra_plazas: [{ plaza: '01', nombre: 'Padre Hidalgo' }],
    ultima_compra: '2026-10-06', ultima_compra_plazas: [{ plaza: '08', nombre: 'Morelia Abastos' }] },
  reparto: [{ plaza: '01', nombre: 'Padre Hidalgo', comprado: { PZA: 3000 }, recibido: {}, mandado_sucursales: { PZA: 1500 }, mandado_rutas: { PAQ: 13 }, escalera: KINDER }],
  escalera: KINDER,
  lotes: [],
};

const tick = async (fix: ComponentFixture<unknown>) => { fix.detectChanges(); await fix.whenStable(); fix.detectChanges(); };
const pendiente = async (fix: ComponentFixture<unknown>) => {
  for (let i = 0; i < 3; i++) { fix.detectChanges(); await new Promise((r) => setTimeout(r, 0)); }
};

async function montar(detalle: ProductosFlujoService['detalle'], margenes: ProductosFlujoService['margenes'] = vi.fn(() => NEVER)) {
  await TestBed.configureTestingModule({
    imports: [ProductoFlujoPanelComponent],
    providers: [provideHttpClient(), provideHttpClientTesting(), { provide: ProductosFlujoService, useValue: { detalle, margenes, listar: vi.fn() } }],
  }).compileComponents();
  const fix = TestBed.createComponent(ProductoFlujoPanelComponent);
  fix.componentRef.setInput('productId', 'p-1');
  return fix;
}

describe('[PF.1] panel de flujo de un producto', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('⭐ primero el veredicto: qué hacer, por qué, en qué afecta y qué mover (en cajas)', async () => {
    const fix = await montar(vi.fn(() => of(DETALLE)));
    await tick(fix);
    const v = fix.nativeElement.querySelector('.pf-veredicto') as HTMLElement;
    expect(v.classList).toContain('is-traspasar');
    expect(v.textContent).toContain('No comprar: mover entre sucursales');
    expect(v.textContent).toContain('Estancado en Canindo');
    expect(v.textContent).toContain('En qué afecta');
    // 130 piezas = 2 cajas y 1 paquete (caja de 60, paquete de 10).
    expect(v.textContent?.replace(/\s+/g, ' ')).toContain('2 cajas y 1 paquete de Canindo a Yurécuaro');
  });

  it('⭐ el flujo: el mes contra los mismos días del anterior, y el mes anterior completo aparte', async () => {
    const fix = await montar(vi.fn(() => of(DETALLE)));
    await tick(fix);
    const k = (fix.nativeElement.querySelector('#pf-flujo') as HTMLElement).parentElement!.textContent!.replace(/\s+/g, ' ');
    expect(k).toContain('Octubre (1 al 9)');
    expect(k).toContain('Septiembre, mismos días');
    expect(k).toContain('+25%');
    expect(fix.nativeElement.querySelectorAll('.pf-graf polyline').length).toBe(2);
  });

  it('⭐ cada sucursal con su estado, días sin vender y existencia en cajas; la que está en duda se marca', async () => {
    const fix = await montar(vi.fn(() => of(DETALLE)));
    await tick(fix);
    const filas = Array.from(fix.nativeElement.querySelectorAll('#pf-plazas ~ .dt-scope tbody tr')) as HTMLElement[];
    expect(filas.map((f) => f.querySelector('.pf-estado')?.textContent)).toEqual(['Agotado', 'Estancado', 'Se mueve']);
    expect(filas[1].textContent).toContain('20 días');
    expect(filas[1].querySelector('.pf-tag-duda')?.textContent).toBe('En duda');
    expect(filas[1].textContent?.replace(/\s+/g, ' ')).toContain('25 cajas');
    // 334 piezas = 5 cajas, 3 paquetes y 4 piezas.
    expect(Array.from(filas[2].querySelectorAll('.pf-cant')).map((c) => c.textContent?.replace(/\s+/g, ' ').trim()))
      .toEqual(['5 cajas', '3 paquetes', '4 piezas']);
    expect(filas[0].querySelector('.pf-tag-agotado')).not.toBeNull();
  });

  it('el reparto en cajas: compró, mandó a otras y a rutas', async () => {
    const fix = await montar(vi.fn(() => of(DETALLE)));
    await tick(fix);
    const t = (fix.nativeElement.querySelector('#pf-llegada') as HTMLElement).parentElement!.textContent!.replace(/\s+/g, ' ');
    expect(t).toContain('50 cajas');
    expect(t).toContain('25 cajas');
    expect(t).toContain('2 cajas y 1 paquete');
  });

  it('⭐ al recargar cada minuto se queda lo que había (sin pantallazo)', async () => {
    let n = 0;
    const det = vi.fn(() => (++n === 1 ? of(DETALLE) : NEVER));
    const fix = await montar(det);
    await tick(fix);
    expect(fix.nativeElement.querySelector('.pf-veredicto')).not.toBeNull();
    (fix.componentInstance as unknown as { recarga: { update: (f: (n: number) => number) => void } }).recarga.update((x) => x + 1);
    await pendiente(fix);
    expect(det).toHaveBeenCalledTimes(2);
    expect(fix.nativeElement.querySelector('.pf-veredicto')).not.toBeNull();
    expect(fix.nativeElement.textContent).not.toContain('Cargando comportamiento');
  });

  it('[PF.2] un líder lo dice arriba del veredicto, con su lugar en la venta de la red', async () => {
    const d = { ...DETALLE, resumen: { ...DETALLE.resumen, lider: { rank: 3, participacion: 0.0123 } } };
    const fix = await montar(vi.fn(() => of(d)));
    await tick(fix);
    expect(fix.nativeElement.querySelector('.pf-veredicto .pf-lider')?.textContent).toBe('Líder · #3 en venta de la red (1.2%)');
  });

  it('⭐ [PF.3] la caducidad va antes del flujo: qué caduca, cuánto no alcanza a venderse (en cajas) y a dónde moverlo', async () => {
    const lote: LoteCaducidad = {
      plaza: '06', nombre: 'Canindo', lote: 'L-77', caduca: '2026-10-29', dias: 20, registrado: 1500, en_existencia: 1500,
      se_vende_antes: 1370, queda: 130, estado: 'no_alcanza', accion: 'Aquí no se alcanza a vender antes de que caduque: moverlo a donde sí se vende',
      mover_a: [{ plaza: '08', nombre: 'Morelia Abastos', cantidad: 70 }, { plaza: '01', nombre: 'Padre Hidalgo', cantidad: 60 }],
      sin_destino: 0, escalera: KINDER,
    };
    const fix = await montar(vi.fn(() => of({ ...DETALLE, lotes: [lote] })));
    await tick(fix);
    const sec = (fix.nativeElement.querySelector('#pf-cad') as HTMLElement).parentElement!;
    const secciones = Array.from(fix.nativeElement.querySelectorAll('section h3')).map((h) => (h as HTMLElement).id);
    expect(secciones.indexOf('pf-cad')).toBeLessThan(secciones.indexOf('pf-flujo'));
    const t = sec.textContent!.replace(/\s+/g, ' ');
    expect(t).toContain('No alcanza a venderse');
    expect(t).toContain('Lote L-77');
    expect(t).toContain('en 20 días');
    expect(t).toContain('Mover 1 caja y 1 paquete a Morelia Abastos');
    expect(t).toContain('Mover 1 caja a Padre Hidalgo');
    expect(t).not.toContain('Promover o devolver');
    expect(sec.querySelector('.pf-down')?.textContent).toBe('2 cajas y 1 paquete');
  });

  it('[negativa] sin fechas registradas no hay tabla de caducidad, y se dice que eso NO es "no caduca"', async () => {
    const fix = await montar(vi.fn(() => of(DETALLE)));
    await tick(fix);
    expect(fix.nativeElement.querySelector('#pf-cad')).toBeNull();
    expect(fix.nativeElement.textContent).toContain('Sin fecha registrada no quiere decir que no caduque');
  });

  const M = (pct: number | null, cobertura: number | null, nota: string | null = null) => ({ pct, utilidad: null, cobertura, nota });
  const MARGENES: MargenesProducto = {
    product_id: 'p-1', desde: '2026-09-09', hasta: '2026-10-08', dias: 30,
    total: { venta_neta: 350000, lista: M(14.1, 1), real: M(13.6, 0.64, 'Kepler no registró el costo en el 36% de la venta'),
      pagado: M(7.9, 1), costo_pagado: { unidad: 'PZA', por_unidad: 2.4567 } },
    plazas: [{ plaza: '08', nombre: 'Morelia Abastos', margenes: { venta_neta: 106891, lista: M(13.2, 1), real: M(10.1, 0.52),
      pagado: M(-2.5, 1), costo_pagado: null } }],
  };

  it('⭐ [PF.5] con permiso de costo, los tres márgenes como en Productos nuevos, y por sucursal', async () => {
    const margenes = vi.fn(() => of(MARGENES));
    const fix = await montar(vi.fn(() => of({ ...DETALLE, costo_visible: true })), margenes);
    await tick(fix);
    expect(margenes).toHaveBeenCalledWith('p-1');
    const sec = (fix.nativeElement.querySelector('#pf-margen') as HTMLElement).parentElement!;
    const k = Array.from(sec.querySelectorAll('.pf-kpis > div')).map((d) => (d.querySelector('span')?.textContent ?? '') + ' ' + d.querySelector('b')?.textContent);
    expect(k).toEqual(['De lista 14.1%', 'Real 13.6%', 'Sobre lo pagado 7.9%']);
    expect(sec.textContent).toContain('Kepler no registró el costo en el 36% de la venta');
    const fila = sec.querySelector('tbody tr') as HTMLElement;
    expect(fila.textContent).toContain('Morelia Abastos');
    expect(fila.querySelector('.pf-down')?.textContent).toBe('-2.5%');
  });

  it('[PF.8] si los márgenes se calcularon en el momento (no de la noche), lo dice', async () => {
    const vivo = { ...MARGENES, origen: { fuente: 'en_vivo' as const, calculado_at: '2026-10-12T15:00:00Z' } };
    const fix = await montar(vi.fn(() => of({ ...DETALLE, costo_visible: true })), vi.fn(() => of(vivo)));
    await tick(fix);
    expect(fix.nativeElement.textContent).toContain('el cálculo de la noche no está al día');
    TestBed.resetTestingModule();
    const foto = { ...MARGENES, origen: { fuente: 'foto' as const, calculado_at: '2026-10-12T12:20:00Z' } };
    const fix2 = await montar(vi.fn(() => of({ ...DETALLE, costo_visible: true })), vi.fn(() => of(foto)));
    await tick(fix2);
    expect(fix2.nativeElement.textContent).not.toContain('el cálculo de la noche no está al día');
  });

  it('[negativa] [PF.5] sin permiso de costo no se piden ni se pintan márgenes', async () => {
    const margenes = vi.fn(() => of(MARGENES));
    const fix = await montar(vi.fn(() => of(DETALLE)), margenes);
    await tick(fix);
    expect(margenes).not.toHaveBeenCalled();
    expect(fix.nativeElement.querySelector('#pf-margen')).toBeNull();
  });

  it('[negativa] si falla de entrada lo dice, no pinta ceros', async () => {
    const fix = await montar(vi.fn(() => throwError(() => new Error('x'))));
    await tick(fix);
    expect(fix.nativeElement.textContent).toContain('No se pudo cargar');
    expect(fix.nativeElement.querySelector('.pf-veredicto')).toBeNull();
  });
});

describe('[PF.1] funciones de presentación', () => {
  it('la variación con signo; sin base, guion (no +100%)', () => {
    expect(variacionTexto(0.254)).toBe('+25%');
    expect(variacionTexto(-0.4)).toBe('−40%');
    expect(variacionTexto(0)).toBe('0%');
    expect(variacionTexto(null)).toBe('—');
  });

  it('[PF.3] los días a una fecha en palabras; [PF.2] el texto del líder', () => {
    expect(diasTexto(0)).toBe('hoy');
    expect(diasTexto(1)).toBe('mañana');
    expect(diasTexto(25)).toBe('en 25 días');
    expect(diasTexto(-8)).toBe('hace 8 días');
    expect(liderTexto({ rank: 1, participacion: 0.025 })).toBe('Líder · #1 en venta de la red (2.5%)');
  });

  it('una cantidad en unidad base, en cajas completas y lo demás', () => {
    expect(cantidadEnCajas(130, KINDER)).toBe('2 cajas y 1 paquete');
    expect(cantidadEnCajas(7, null)).toBe('7 piezas');
  });

  it('la gráfica: el mes en curso se corta en hoy; los dos trazos comparten la escala', () => {
    const t = trazos(DETALLE.serie);
    expect(t.max).toBe(300);
    expect(t.actual.split(' ').length).toBe(2);
    expect(t.anterior.split(' ').length).toBe(3);
  });
});
