import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { computed, provideZonelessChangeDetection } from '@angular/core';
import { Observable, of, throwError } from 'rxjs';
import type { BandejaAutorizacion, DecisionVigente, PedidoPorAutorizar, ResultadoAutorizacion, ResultadoDecisionPedido } from '@megadulces/contracts';
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
  decision: null,
  ...o,
});
const apagado = { condicion: 6 as const, texto: 'la autorización automática está apagada en esta sucursal' };
const bandeja = (pendientes: PedidoPorAutorizar[], aparte: PedidoPorAutorizar[] = [], o: Partial<BandejaAutorizacion> = {}): BandejaAutorizacion => ({
  hoy: '2026-11-20',
  freshness: { data_as_of: '2026-11-20T18:00:00Z', status: 'fresh', stale: false, age_human: '2 min', inputs: [] },
  parametros: { graciaDias: 15, pedidoViejoDias: 2, abiertosHorizonteDias: 30, frescuraMaxMin: 15, origen: 'propuesta' },
  pendientes, aparte, contado: [], decididos: [], sucursales_encendidas: [], autorizados_hoy: 0,
  ...o,
});

describe('FinanzasPorAutorizarComponent — [GP.A.4]', () => {
  /** Lo que mandó el panel al servidor, para probar la decisión sin base. */
  let enviado: Array<{ sucursal: string; serie: number; folio: string; accion: string; motivo: string }>;
  function crear(b: BandejaAutorizacion, opts: { puede?: boolean; resultado?: ResultadoDecisionPedido } = {}) {
    enviado = [];
    const api = {
      bandeja: () => of(b),
      decidir: (p: PedidoPorAutorizar, accion: string, motivo: string) => {
        enviado.push({ sucursal: p.sucursal, serie: p.serie, folio: p.folio, accion, motivo });
        return of(opts.resultado ?? { id: 'x', accion, estado: 'escrito', mensaje: 'Autorizado en Kepler.', reintentable: false } as ResultadoDecisionPedido);
      },
    };
    TestBed.configureTestingModule({
      imports: [FinanzasPorAutorizarComponent],
      providers: [
        provideZonelessChangeDetection(),
        provideRouter([]),
        { provide: AutorizacionPedidosService, useValue: api },
        { provide: AuthService, useValue: { user: () => ({ permissions: {} }) } },
        { provide: PermissionsService, useValue: { isAdmin: () => true, has$: () => computed(() => opts.puede ?? true) } },
      ],
    });
    const f = TestBed.createComponent(FinanzasPorAutorizarComponent);
    f.detectChanges();
    return f;
  }
  const boton = (f: { nativeElement: HTMLElement }, texto: string) =>
    Array.from((f.nativeElement as HTMLElement).querySelectorAll('button')).find((b) => b.textContent?.includes(texto)) as HTMLButtonElement;
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

  it('tocar un pedido abre el panel con el veredicto y los 3 números; con la escritura apagada, Autorizar dice dónde se hace hoy', () => {
    const f = crear(bandeja([ped('0001842', 'Abarrotes El Sol', [{ condicion: 2, texto: 'excede $6,181.40 su límite' }, apagado])]));
    f.componentInstance.abrir(f.componentInstance.lista()[0]);
    f.componentInstance.motivo.set('Lo revisé con el cliente');
    f.detectChanges();
    const t = el(f).textContent ?? '';
    expect(t).toContain('Excede $6,181.40 su límite');
    expect(t).toContain('Por cobrar en Kepler');
    expect(t).toContain('$12,760.90');
    expect(t).toContain('está apagado en Morelia Abastos');
    expect(t).toContain('en Kepler › Autorización de Pedidos');
    expect(boton(f, 'Autorizar').disabled).toBe(true);
    // ⭐ Rechazar NO depende de Kepler: no lo toca, sólo deja dicho por qué.
    expect(boton(f, 'Rechazar').disabled).toBe(false);
  });

  it('la cifra «Viejos, aparte» cambia a la lista de los viejos, y regresa', () => {
    const f = crear(bandeja([ped('1', 'A', [apagado])], [ped('2', 'Viejo', [{ condicion: 7, texto: 'lleva 58 días sin movimiento' }])]));
    f.componentInstance.vista.set('aparte');
    f.detectChanges();
    expect(el(f).textContent).toContain('no se autorizan solos');
    expect(f.componentInstance.lista().map((p) => p.folio)).toEqual(['2']);
    f.componentInstance.vista.set('pendientes');
    f.detectChanges();
    expect(f.componentInstance.lista().map((p) => p.folio)).toEqual(['1']);
  });

  // ── `[GP.A.5]` La decisión ───────────────────────────────────────────────────────────────────
  it('⭐ con la sucursal encendida y un motivo, Autorizar manda la acción, el motivo y el pedido', () => {
    const f = crear(bandeja([ped('0001842', 'Abarrotes El Sol', [{ condicion: 2, texto: 'excede $6,181.40 su límite' }])], [], { sucursales_encendidas: ['08'] }));
    const c = f.componentInstance;
    c.abrir(c.lista()[0]);
    c.motivo.set('Habló el cliente, deposita mañana');
    f.detectChanges();
    expect(boton(f, 'Autorizar').disabled).toBe(false);
    boton(f, 'Autorizar').click();
    expect(enviado).toEqual([{ sucursal: '08', serie: 1, folio: '0001842', accion: 'autorizar', motivo: 'Habló el cliente, deposita mañana' }]);
  });

  // ⭐ Los botones quedan HABILITADOS a propósito: uno apagado no se enfoca y no dice por qué
  // (modern-web-guidance «required-field-feedback»). El que no se mande nada lo garantiza el código.
  it('⛔ sin motivo no se manda nada: el botón sigue vivo, el campo se marca inválido y el error se dice', () => {
    const f = crear(bandeja([ped('1', 'A', [])], [], { sucursales_encendidas: ['08'] }));
    const c = f.componentInstance;
    c.abrir(c.lista()[0]);
    f.detectChanges();
    const campo = el(f).querySelector('#pa-motivo') as HTMLTextAreaElement;
    expect(boton(f, 'Rechazar').disabled).toBe(false);
    // Al abrir, el campo NO está marcado inválido: un required vacío marcado de entrada hace que un lector
    // de pantalla cante «no válido» antes de que la persona lo toque.
    expect(campo.getAttribute('aria-invalid')).toBe('false');
    expect(el(f).textContent).not.toContain('Escribe el motivo');

    boton(f, 'Rechazar').click();
    f.detectChanges();
    expect(enviado).toEqual([]);
    expect(c.motivoInvalido()).toBe(true);
    expect((el(f).querySelector('#pa-motivo') as HTMLTextAreaElement).getAttribute('aria-invalid')).toBe('true');
    expect(el(f).textContent).toContain('Escribe el motivo: queda registrado con tu nombre.');
    expect(el(f).querySelector('#pa-motivo-error')).not.toBeNull();

    // Y al escribir, el error se va.
    c.escribirMotivo('ya lo revisé');
    f.detectChanges();
    expect(c.motivoInvalido()).toBe(false);
  });

  it('⭐ lo tecleado no se pierde: el panel se declara sucio para que cerrar pregunte', () => {
    const f = crear(bandeja([ped('1', 'A', [])], [], { sucursales_encendidas: ['08'] }));
    const c = f.componentInstance;
    c.abrir(c.lista()[0]);
    f.detectChanges();
    const peek = () => f.debugElement.query((n) => n.name === 'app-side-peek')?.componentInstance as { sucio: () => boolean };
    expect(peek().sucio()).toBe(false);
    c.escribirMotivo('debe desde agosto');
    f.detectChanges();
    expect(peek().sucio()).toBe(true);
  });

  it('el resultado se dice DENTRO del panel (un toast de afuera no llega a un lector dentro de un modal)', () => {
    const f = crear(bandeja([ped('1', 'A', []), ped('2', 'B', [])], [], { sucursales_encendidas: ['08'] }));
    const c = f.componentInstance;
    c.abrir(c.lista()[0]);
    c.escribirMotivo('va');
    c.decidir(c.lista()[0], 'autorizar');
    f.detectChanges();
    const vivo = el(f).querySelector('[role="status"]');
    expect(vivo?.textContent).toContain('Autorizado en Kepler.');
  });

  it('un error del servidor conserva lo tecleado para reintentar', () => {
    const f = crear(bandeja([ped('1', 'A', [])], [], { sucursales_encendidas: ['08'] }));
    const c = f.componentInstance;
    TestBed.inject(AutorizacionPedidosService).decidir = (() =>
      throwError(() => ({ error: { message: 'Ese pedido se está escribiendo en Kepler en este momento.' } }))) as never;
    c.abrir(c.lista()[0]);
    c.escribirMotivo('reintento');
    c.decidir(c.lista()[0], 'autorizar');
    expect(c.motivo()).toBe('reintento');
    expect(c.resultado()).toContain('se está escribiendo en Kepler');
  });

  it('⛔ el doble clic del pánico no decide dos veces', () => {
    // El resultado nunca llega: el segundo clic cae con la primera en vuelo.
    const f = crear(bandeja([ped('1', 'A', [])], [], { sucursales_encendidas: ['08'] }));
    const c = f.componentInstance;
    TestBed.inject(AutorizacionPedidosService).decidir = ((p: PedidoPorAutorizar, accion: string, motivo: string) => {
      enviado.push({ sucursal: p.sucursal, serie: p.serie, folio: p.folio, accion, motivo });
      return new Observable<ResultadoDecisionPedido>(() => undefined);
    }) as never;
    c.abrir(c.lista()[0]);
    c.motivo.set('va');
    c.decidir(c.lista()[0], 'autorizar');
    c.decidir(c.lista()[0], 'autorizar');
    expect(enviado).toHaveLength(1);
    expect(c.enviando()).toBe('autorizar');
  });

  it('un error del servidor se dice con su mensaje y no deja el botón trabado', () => {
    const f = crear(bandeja([ped('1', 'A', [])], [], { sucursales_encendidas: ['08'] }));
    const c = f.componentInstance;
    TestBed.inject(AutorizacionPedidosService).decidir = (() =>
      throwError(() => ({ error: { message: 'Autorizar desde la Suite está apagado en esta sucursal.' } }))) as never;
    c.abrir(c.lista()[0]);
    c.motivo.set('va');
    c.decidir(c.lista()[0], 'autorizar');
    expect(c.enviando()).toBeNull();
    expect(c.motivo()).toBe('va');
  });

  it('⭐ lo ya decidido no se vuelve a pedir: sale en su propia cifra, con quién y por qué', () => {
    const dec: DecisionVigente = { accion: 'rechazar', estado: 'registrado', motivo: 'Debe de agosto', automatica: false, quien: 'ggarcia', cuando: '2026-11-23T16:00:00Z' };
    const f = crear(bandeja([], [], { decididos: [ped('0001842', 'Abarrotes El Sol', [], { decision: dec })] }));
    const c = f.componentInstance;
    expect(c.cifras().map((x) => x.label)).toContain('Ya decididos');
    c.vista.set('decididos');
    f.detectChanges();
    c.abrir(c.lista()[0]);
    f.detectChanges();
    const t = el(f).textContent ?? '';
    expect(t).toContain('ggarcia lo rechazó');
    expect(t).toContain('Debe de agosto');
  });

  it('negativo: sin la cifra en cero — si nadie decidió nada, no aparece la lista', () => {
    const f = crear(bandeja([ped('1', 'A', [])]));
    expect(f.componentInstance.cifras().map((x) => x.label)).not.toContain('Ya decididos');
  });

  it('⛔ sin el permiso no hay botones de decisión, y se dice dónde se hace', () => {
    const f = crear(bandeja([ped('1', 'A', [])], [], { sucursales_encendidas: ['08'] }), { puede: false });
    f.componentInstance.abrir(f.componentInstance.lista()[0]);
    f.detectChanges();
    expect(boton(f, 'Autorizar')).toBeUndefined();
    expect(boton(f, 'Rechazar')).toBeUndefined();
    expect(el(f).textContent).toContain('No tienes el permiso para autorizar pedidos');
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
    // La etiqueta dice «Bloqueado» y no una marca concreta: Kepler escribe «NO TOCAR» y también
    // «NO USAR» (63 filas medidas el 2026-11-23), y nombrar sólo una dejaba la otra sin etiqueta.
    expect(etiquetaDe(ped('1', 'x', [{ condicion: 4, texto: 'el cliente está marcado «NO USAR» en Kepler' }])).texto).toBe('Bloqueado');
    expect(etiquetaDe(ped('1', 'x', [{ condicion: 4, texto: 'el cliente está marcado «NO TOCAR» en Kepler' }])).texto).toBe('Bloqueado');
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
