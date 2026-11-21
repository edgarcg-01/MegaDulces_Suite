import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { provideZonelessChangeDetection } from '@angular/core';
import { of } from 'rxjs';
import type { BandejaAutorizacion, PedidoPorAutorizar, ResultadoAutorizacion } from '@megadulces/contracts';
import { FinanzasPorAutorizarComponent, datoDe, etiquetaDe, fraseDe, hechosDe } from './finanzas-por-autorizar.component';
import { AutorizacionPedidosService } from '../autorizacion-pedidos.service';
import { AuthService } from '../../../core/services/auth.service';
import { PermissionsService } from '../../../core/services/permissions.service';

/** `[GP.A.4]` La bandeja «Por autorizar» montada: lo que ve Crédito y cobranza y lo que todavía no puede hacer. */
const res = (motivos: ResultadoAutorizacion['motivos'], o: Partial<ResultadoAutorizacion['numeros']> = {}): ResultadoAutorizacion => ({
  decision: motivos.some((m) => m.condicion === 7 || m.condicion === 8) ? 'aparte' : motivos.length ? 'bandeja' : 'autorizar',
  bloqueado: motivos.some((m) => m.condicion === 4),
  motivos,
  numeros: { limite: 25_000, comprometido: null, excedente: null, vencido_fuera_de_gracia: 0, dias_vencido_max: null, resto_ignorado: 0, dias_sin_movimiento: 1, ...o },
});
const ped = (folio: string, nombre: string, motivos: ResultadoAutorizacion['motivos'], o: Partial<PedidoPorAutorizar> = {}): PedidoPorAutorizar => ({
  sucursal: '08', sucursal_nombre: 'Morelia Abastos', serie: 1, folio, fecha: '2026-11-14', dias_esperando: 6,
  cliente: 'C' + folio, cliente_nombre: nombre, es_contado: false, ruta_vecinal: false, importe: 18_420.5, resultado: res(motivos),
  limite: 25_000, plazo_dias: 15, por_cobrar_kepler: 12_760.9, saldo_cartera: 12_760.9, otros_pedidos: 0,
  pago: { facturas_pagadas: 23, mediana_dias: 14, a_tiempo: 20, peor_atraso: 16 },
  ...o,
});
const apagado = { condicion: 6 as const, texto: 'la autorización automática está apagada en esta sucursal' };
const bandeja = (pendientes: PedidoPorAutorizar[], aparte: PedidoPorAutorizar[] = []): BandejaAutorizacion => ({
  hoy: '2026-11-20',
  freshness: { data_as_of: '2026-11-20T18:00:00Z', status: 'fresh', stale: false, age_human: '2 min', inputs: [] },
  parametros: { graciaDias: 15, pedidoViejoDias: 2, abiertosHorizonteDias: 30, frescuraMaxMin: 15, origen: 'propuesta' },
  pendientes, aparte, contado: [], sucursales_encendidas: [], autorizados_hoy: null,
});

describe('FinanzasPorAutorizarComponent — [GP.A.4]', () => {
  function crear(b: BandejaAutorizacion) {
    TestBed.configureTestingModule({
      imports: [FinanzasPorAutorizarComponent],
      providers: [
        provideZonelessChangeDetection(),
        provideRouter([]),
        { provide: AutorizacionPedidosService, useValue: { bandeja: () => of(b) } },
        { provide: AuthService, useValue: { user: () => ({ permissions: {} }) } },
        { provide: PermissionsService, useValue: { isAdmin: () => true } },
      ],
    });
    const f = TestBed.createComponent(FinanzasPorAutorizarComponent);
    f.detectChanges();
    return f;
  }
  afterEach(() => TestBed.resetTestingModule());
  const el = (f: { nativeElement: HTMLElement }) => f.nativeElement as HTMLElement;

  it('abre con la respuesta: cuántos esperan, por qué cada uno, y que el automático está apagado', () => {
    const f = crear(bandeja([
      ped('0001842', 'Abarrotes El Sol', [{ condicion: 2, texto: 'excede $6,181.40 su límite' }, apagado]),
      ped('0001851', 'Cremería Doña Lupe', [{ condicion: 1, texto: 'sin límite en Kepler' }, apagado], { limite: null }),
    ], [ped('0000312', 'Abarrotes Santa Fe', [{ condicion: 7, texto: 'lleva 58 días sin movimiento' }])]));
    const t = el(f).textContent ?? '';
    expect(t).toContain('Esperan tu decisión');
    expect(f.componentInstance.cifras().map((c) => c.value)).toEqual([2, 1]);
    expect(t).toContain('La autorización automática está apagada');
    expect(t).toContain('Viejos, aparte');
    expect(t).toContain('Excede');
    expect(t).toContain('excede $6,181.40 su límite');
    expect(t).toContain('Sin límite');
    // la condición del sistema (6) NO se repite en cada fila
    expect(t.match(/está apagada en esta sucursal/g)).toBeNull();
  });

  it('tocar un pedido abre el panel con el veredicto y los 3 números; Autorizar está apagado y dice dónde se hace hoy', () => {
    const f = crear(bandeja([ped('0001842', 'Abarrotes El Sol', [{ condicion: 2, texto: 'excede $6,181.40 su límite' }, apagado])]));
    f.componentInstance.abrir(f.componentInstance.lista()[0]);
    f.detectChanges();
    const t = el(f).textContent ?? '';
    expect(t).toContain('Excede $6,181.40 su límite');
    expect(t).toContain('Por cobrar en Kepler');
    expect(t).toContain('$12,760.90');
    expect(t).toContain('en Kepler › Autorización de Pedidos');
    const autorizar = Array.from(el(f).querySelectorAll('button')).find((b) => b.textContent?.includes('Autorizar')) as HTMLButtonElement;
    expect(autorizar.disabled).toBe(true);
  });

  it('la cifra «Viejos, aparte» cambia a la lista de los viejos, y regresa', () => {
    const f = crear(bandeja([ped('1', 'A', [apagado])], [ped('2', 'Viejo', [{ condicion: 7, texto: 'lleva 58 días sin movimiento' }])]));
    f.componentInstance.verAparte.set(true);
    f.detectChanges();
    expect(el(f).textContent).toContain('no se autorizan solos');
    expect(f.componentInstance.lista().map((p) => p.folio)).toEqual(['2']);
    f.componentInstance.verAparte.set(false);
    f.detectChanges();
    expect(f.componentInstance.lista().map((p) => p.folio)).toEqual(['1']);
  });

  it('«Siguiente pedido» recorre la lista sin cerrar el panel', () => {
    const f = crear(bandeja([ped('1', 'A', [apagado]), ped('2', 'B', [apagado])]));
    const c = f.componentInstance;
    c.abrir(c.lista()[0]);
    expect(c.posicion()).toBe('1 de 2');
    c.siguiente();
    expect(c.sel()?.folio).toBe('2');
    expect(c.haySiguiente()).toBe(false);
  });
});

describe('[GP.A.4] las frases de cada caso', () => {
  it('cada condición tiene su palabra; con sólo condiciones del sistema dice «Pasaría solo»', () => {
    expect(etiquetaDe(ped('1', 'x', [{ condicion: 4, texto: 'NO TOCAR' }])).texto).toBe('NO TOCAR');
    expect(etiquetaDe(ped('1', 'x', [{ condicion: 3, texto: 'vencido' }])).texto).toBe('Vencido');
    expect(etiquetaDe(ped('1', 'x', [apagado])).texto).toBe('Pasaría solo');
    expect(fraseDe(ped('1', 'x', [apagado]))).toContain('se autorizaría solo');
  });

  it('[D-A13] en «aparte», la ruta vecinal se nombra y su motivo va primero', () => {
    const p = ped('1', 'x', [{ condicion: 1, texto: 'sin límite en Kepler' }, { condicion: 8, texto: 'es de la ruta vecinal: va aparte' }], { ruta_vecinal: true });
    expect(etiquetaDe(p).texto).toBe('Ruta vecinal');
    expect(fraseDe(p)).toBe('es de la ruta vecinal: va aparte');
  });

  it('CONTADO: «venta de contado», sin segunda línea de pago', () => {
    const p = ped('1', 'CONTADO', [{ condicion: 2, texto: 'no pude verificar el saldo' }], { es_contado: true, por_cobrar_kepler: null, saldo_cartera: null });
    expect(etiquetaDe(p).texto).toBe('Contado');
    expect(fraseDe(p)).toBe('venta de contado: no usa crédito');
    expect(datoDe(p)).toBeNull();
  });

  it('la segunda línea dice primero si Kepler cuenta de más; si no, cómo paga', () => {
    expect(datoDe(ped('1', 'x', [], { por_cobrar_kepler: 12_760.9, saldo_cartera: 8_550.9 }))).toBe('Kepler cuenta $4,210.00 más que la cartera');
    expect(datoDe(ped('1', 'x', []))).toBe('suele pagar a 14 días con plazo de 15');
    expect(datoDe(ped('1', 'x', [], { pago: { facturas_pagadas: 0, mediana_dias: null, a_tiempo: null, peor_atraso: null } }))).toBe('sin historial de pago');
  });

  it('negativo: una diferencia de centavos con Kepler no se dice', () => {
    expect(datoDe(ped('1', 'x', [], { por_cobrar_kepler: 100.5, saldo_cartera: 100 }))).toBe('suele pagar a 14 días con plazo de 15');
  });

  it('«Para decidir» trae a lo más 3 hechos', () => {
    const p = ped('1', 'x', [], { otros_pedidos: 7_500 });
    p.resultado.numeros.resto_ignorado = 0.37;
    expect(hechosDe(p).length).toBeLessThanOrEqual(3);
    expect(hechosDe(p)[0]).toBe('Pagó 23 facturas; suele pagar a 14 días con plazo de 15; 20 a tiempo.');
  });
});
