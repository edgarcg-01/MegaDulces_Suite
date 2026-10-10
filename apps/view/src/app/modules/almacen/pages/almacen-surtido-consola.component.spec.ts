import { ComponentFixture, TestBed } from '@angular/core/testing';
import { Subject, of, throwError } from 'rxjs';
import type { ConsolaSurtidoOla, ConsolaSurtidoResponse } from '@megadulces/contracts';
import { AlmacenSurtidoConsolaComponent } from './almacen-surtido-consola.component';
import { PickingService } from '../../reparto/picking.service';

/**
 * `[GP.3c.2]` La consola del coordinador, montada de verdad (plantilla + signals) con el servidor
 * simulado. Se prueba por la PANTALLA: que cada botón llame al servidor con lo que dice, que lo
 * que exige motivo no se pueda mandar sin él, y que lo que no aplica no se pinte.
 */

const OLA = (p: Partial<ConsolaSurtidoOla> = {}): ConsolaSurtidoOla => ({
  id: 'ola-1',
  code: 'W-2026-00001',
  status: 'abierta',
  origen: 'TELEMARK',
  armada_por: 'auto',
  prioridad: 0,
  prioridad_motivo: null,
  assigned_to: null,
  assigned_nombre: null,
  created_at: new Date(Date.now() - 12 * 60000).toISOString(),
  started_at: null,
  tomable: true,
  renglones: 8,
  tocados: 0,
  pedidos: ['UD4001-0002840'],
  destinos: ['TI002 TIENDA CENTRO'],
  hora_salida: null,
  ...p,
});

const RESP = (p: Partial<ConsolaSurtidoResponse> = {}): ConsolaSurtidoResponse => ({
  warehouse_id: 'w-08',
  sucursal: '08',
  fecha: '2026-10-08',
  umbral_tanda: 5,
  olas: [
    OLA({ id: 'ola-u', code: 'W-2026-00009', prioridad: 1, prioridad_motivo: 'Cliente espera en mostrador' }),
    OLA({ id: 'ola-a', code: 'W-2026-00003', status: 'en_surtido', assigned_to: 'u-1', assigned_nombre: 'Juan Pérez', tocados: 3, tomable: false, started_at: new Date(Date.now() - 5 * 60000).toISOString(), created_at: new Date(Date.now() - 3 * 3600000).toISOString() }),
    OLA({ id: 'ola-l', code: 'W-2026-00004', pedidos: ['UD4001-1', 'UD4001-2', 'UD4001-3', 'UD4001-4'] }),
  ],
  surtidas_hoy: 7,
  por_armar: { pedidos: 4, tanda: 3, individual: 1, bloqueados: 1, atorados: { count: 0, desde: null } },
  destinos: [
    { destino_code: 'TI002', destino_nombre: 'TIENDA CENTRO', por_armar: 2, en_surtido: 1, hora_salida: '09:30' },
    { destino_code: 'C0451', destino_nombre: 'ABARROTES LUPITA', por_armar: 1, en_surtido: 0, hora_salida: null },
  ],
  ...p,
});

describe('AlmacenSurtidoConsolaComponent · la consola del coordinador (GP.3c)', () => {
  let fix: ComponentFixture<AlmacenSurtidoConsolaComponent>;
  let c: AlmacenSurtidoConsolaComponent;
  let api: Record<string, ReturnType<typeof vi.fn>>;

  const el = (): HTMLElement => fix.nativeElement as HTMLElement;
  const texto = (): string => el().textContent?.replace(/\s+/g, ' ') ?? '';
  const botones = (t: string): HTMLButtonElement[] =>
    Array.from(el().querySelectorAll('button')).filter((b) => (b.textContent ?? '').replace(/\s+/g, ' ').trim() === t) as HTMLButtonElement[];
  const fila = (code: string): HTMLTableRowElement =>
    Array.from(el().querySelectorAll('tr')).find((r) => r.textContent?.includes(code)) as HTMLTableRowElement;
  const botonEn = (tr: HTMLElement, t: string): HTMLButtonElement =>
    Array.from(tr.querySelectorAll('button')).find((b) => (b.textContent ?? '').trim() === t) as HTMLButtonElement;
  const salida = (nombre: string): HTMLTableRowElement =>
    Array.from(el().querySelectorAll('section[aria-labelledby="gp-sal-h"] tr')).find((r) => r.textContent?.includes(nombre)) as HTMLTableRowElement;
  const render = (): void => fix.detectChanges();

  async function montar(almacenes = [{ id: 'w-08', code: '08', nombre: 'Morelia Abastos' }], resp = RESP()): Promise<void> {
    api = {
      consolaAlmacenes: vi.fn(() => of(almacenes)),
      consola: vi.fn(() => of(resp)),
      consolaPrioridad: vi.fn(() => of({ id: 'x', prioridad: 1 })),
      consolaLiberar: vi.fn(() => of({ id: 'x', liberada: true })),
      consolaCancelar: vi.fn(() => of({ id: 'x', cancelada: true })),
      consolaSalida: vi.fn(() => of({ destino_code: 'x', hora_salida: null })),
      consolaUmbral: vi.fn(() => of({ umbral_tanda: 3 })),
      consolaArmar: vi.fn(() => of({ creadas: [{}, {}], fallidas: [], bloqueados: [{ code: 'x', motivo: 'y' }], vacios: [], atorados: { count: 0, desde: null } })),
    };
    try { localStorage.clear(); } catch { /* sin almacenamiento */ }
    await TestBed.configureTestingModule({
      imports: [AlmacenSurtidoConsolaComponent],
      providers: [{ provide: PickingService, useValue: api }],
    }).compileComponents();
    fix = TestBed.createComponent(AlmacenSurtidoConsolaComponent);
    c = fix.componentInstance;
    render();
    await fix.whenStable();
    render();
  }

  afterEach(() => fix?.destroy());

  it('⭐ pinta la fila en el orden del servidor, con la regla escrita y los conteos', async () => {
    await montar();
    expect(api['consola']).toHaveBeenCalledWith('w-08');
    const t = texto();
    expect(t).toContain('urgentes, luego la salida más próxima de sus destinos, luego lo más viejo');
    const codes = Array.from(el().querySelectorAll('.gp-code')).map((n) => n.textContent?.trim());
    expect(codes).toEqual(['W-2026-00009', 'W-2026-00003', 'W-2026-00004']);
    expect(c.porTomar()).toBe(2);
    // El turno es el de "Tomar siguiente": la que trae Juan no tiene turno.
    const turnos = Array.from(el().querySelectorAll('tbody tr td:first-child')).slice(0, 3).map((n) => n.textContent?.trim());
    expect(turnos).toEqual(['1', '—', '2']);
    // Lo que trae alguien se mide desde que lo tomó, no desde que se armó.
    expect(t).toContain('Lo trae hace 5 min');
    expect(t).toContain('Esperando hace 12 min');
    expect(c.enSurtido()).toBe(1);
    expect(c.urgentes()).toBe(1);
    expect(t).toContain('Motivo: Cliente espera en mostrador');
    expect(t).toContain('Juan Pérez');
    expect(t).toContain('4 pedidos en tanda: UD4001-1, UD4001-2 y 2 más');
    expect(t).toContain('1 pedido no puede armarse: trae productos que no están dados de alta en la Suite.');
  });

  it('marcar urgente exige motivo; con motivo llama al servidor y relee', async () => {
    await montar();
    botonEn(fila('W-2026-00004'), 'Marcar urgente').click();
    render();
    const ok = botones('Sí, marcar urgente')[0];
    expect(ok.disabled).toBe(true);
    c.motivo.set('ok');
    render();
    expect(ok.disabled).toBe(true);
    c.motivo.set('Sale la camioneta');
    render();
    expect(ok.disabled).toBe(false);
    ok.click();
    expect(api['consolaPrioridad']).toHaveBeenCalledWith('ola-l', true, 'Sale la camioneta');
    expect(api['consola']).toHaveBeenCalledTimes(2);
    render();
    expect(c.accion()).toBeNull();
    expect(texto()).toContain('W-2026-00004 quedó urgente: pasa antes que todo lo no urgente.');
  });

  it('quitar urgente pide confirmar (la fila se reordena sola) pero no motivo', async () => {
    await montar();
    botonEn(fila('W-2026-00009'), 'Quitar urgente').click();
    render();
    expect(api['consolaPrioridad']).not.toHaveBeenCalled();
    expect(texto()).toContain('¿Quitarle lo urgente a W-2026-00009?');
    expect(el().querySelector('#gp-motivo')).toBeNull();
    botones('Sí, quitar urgente')[0].click();
    expect(api['consolaPrioridad']).toHaveBeenCalledWith('ola-u', false);
  });

  it('Liberar sólo aparece en lo que alguien trae, y pide confirmar', async () => {
    await montar();
    expect(botonEn(fila('W-2026-00004'), 'Liberar')).toBeUndefined();
    botonEn(fila('W-2026-00003'), 'Liberar').click();
    render();
    expect(texto()).toContain('¿Quitarle W-2026-00003 a Juan Pérez?');
    expect(api['consolaLiberar']).not.toHaveBeenCalled();
    botones('Sí, liberar')[0].click();
    expect(api['consolaLiberar']).toHaveBeenCalledWith('ola-a');
  });

  it('cancelar exige motivo; "Volver" cierra sin tocar nada', async () => {
    await montar();
    botonEn(fila('W-2026-00004'), 'Cancelar surtido').click();
    render();
    expect(botones('Sí, cancelar surtido')[0].disabled).toBe(true);
    botones('Volver')[0].click();
    render();
    expect(c.accion()).toBeNull();
    expect(api['consolaCancelar']).not.toHaveBeenCalled();
  });

  it('un error del servidor se muestra y la confirmación queda abierta para reintentar', async () => {
    await montar();
    api['consolaCancelar'].mockReturnValueOnce(throwError(() => ({ error: { message: 'El surtido ya se terminó.' } })));
    botonEn(fila('W-2026-00004'), 'Cancelar surtido').click();
    c.motivo.set('Pedido duplicado');
    render();
    botones('Sí, cancelar surtido')[0].click();
    render();
    expect(texto()).toContain('No se canceló W-2026-00004. El surtido ya se terminó.');
    expect(c.accion()).not.toBeNull();
    // Un error de ACCIÓN no ofrece "Reintentar": ese botón sólo relee la fila y no repetiría nada.
    expect(botones('Reintentar')).toHaveLength(0);
  });

  it('⭐ la hora de salida se guarda AL SALIR de la casilla (sin botón "Guardar"); Borrar sólo si ya había una', async () => {
    await montar();
    const tc = salida('TIENDA CENTRO');
    const lu = salida('ABARROTES LUPITA');
    expect(botonEn(tc, 'Borrar')).toBeDefined();
    expect(botonEn(lu, 'Borrar')).toBeUndefined();
    c.setBorrador(RESP().destinos[1], '10:15');
    render();
    expect(botonEn(salida('ABARROTES LUPITA'), 'Guardar')).toBeUndefined();
    const campo = salida('ABARROTES LUPITA').querySelector('input') as HTMLInputElement;
    campo.dispatchEvent(new Event('blur'));
    expect(api['consolaSalida']).toHaveBeenCalledWith({ warehouse_id: 'w-08', destino_code: 'C0451', destino_nombre: 'ABARROTES LUPITA', hora_salida: '10:15' });
    botonEn(salida('TIENDA CENTRO'), 'Borrar').click();
    expect(api['consolaSalida']).toHaveBeenLastCalledWith({ warehouse_id: 'w-08', destino_code: 'TI002', destino_nombre: 'TIENDA CENTRO', hora_salida: null });
  });

  it('la hora es de 24 h: "930" se guarda como 09:30; una hora imposible no se guarda y lo dice', async () => {
    await montar();
    const lu = RESP().destinos[1];
    c.setBorrador(lu, '25:00');
    render();
    c.guardarSalida(lu);
    expect(api['consolaSalida']).not.toHaveBeenCalled();
    expect(texto()).toContain('Escríbela como 16:30');
    c.setBorrador(lu, '930');
    c.guardarSalida(lu);
    expect(api['consolaSalida']).toHaveBeenCalledWith({ warehouse_id: 'w-08', destino_code: 'C0451', destino_nombre: 'ABARROTES LUPITA', hora_salida: '09:30' });
  });

  it('el ejemplo del motivo de CANCELAR no es el de "urgente"', async () => {
    await montar();
    botonEn(fila('W-2026-00003'), 'Cancelar surtido').click();
    render();
    const motivo = el().querySelector('#gp-motivo') as HTMLInputElement;
    expect(motivo.placeholder).not.toContain('Zamora');
  });

  it('mientras llega la lista de almacenes hay barra de carga (antes quedaba en blanco)', async () => {
    const lista = new Subject<Array<{ id: string; code: string; nombre: string }>>();
    api = {
      consolaAlmacenes: vi.fn(() => lista.asObservable()),
      consola: vi.fn(() => of(RESP())),
    };
    await TestBed.configureTestingModule({
      imports: [AlmacenSurtidoConsolaComponent],
      providers: [{ provide: PickingService, useValue: api }],
    }).compileComponents();
    fix = TestBed.createComponent(AlmacenSurtidoConsolaComponent);
    c = fix.componentInstance;
    render();
    expect(el().querySelector('[role="progressbar"]')).not.toBeNull();
    lista.next([{ id: 'w-08', code: '08', nombre: 'Morelia Abastos' }]);
    render();
    expect(el().querySelector('[role="progressbar"]')).toBeNull();
  });

  it('el umbral fuera de 1..50 no se puede guardar', async () => {
    await montar();
    c.umbral.set(0);
    render();
    expect(texto()).toContain('Escribe un número del 1 al 50.');
    c.guardarUmbral();
    expect(api['consolaUmbral']).not.toHaveBeenCalled();
    c.umbral.set(3);
    render();
    const guardar = botones('Guardar').find((b) => b.closest('.gp-step'));
    expect(guardar).toBeDefined();
    guardar?.click();
    expect(api['consolaUmbral']).toHaveBeenCalledWith('w-08', 3);
  });

  it('armar ahora resume lo que pasó y relee la fila', async () => {
    await montar();
    botones('Armar surtidos ahora')[0].click();
    render();
    expect(api['consolaArmar']).toHaveBeenCalledWith('w-08', undefined);
    expect(texto()).toContain('Se armaron 2 surtidos · 1 pedido trae productos que no están dados de alta en la Suite.');
  });

  it('sin pedidos por armar el botón queda apagado', async () => {
    await montar(undefined, RESP({ por_armar: { pedidos: 0, tanda: 0, individual: 0, bloqueados: 0, atorados: { count: 0, desde: null } } }));
    expect(botones('Armar surtidos ahora')[0].disabled).toBe(true);
    expect(texto()).toContain('Kepler no tiene pedidos autorizados pendientes de armar.');
  });

  it('prueba negativa: sin almacén a su cargo no pide la fila y lo dice', async () => {
    await montar([]);
    expect(api['consola']).not.toHaveBeenCalled();
    expect(texto()).toContain('No tienes un almacén a tu cargo');
  });

  it('con varios almacenes muestra el selector y al cambiar relee ese almacén', async () => {
    await montar([
      { id: 'w-01', code: '01', nombre: 'Padre Hidalgo' },
      { id: 'w-08', code: '08', nombre: 'Morelia Abastos' },
    ]);
    expect(api['consola']).toHaveBeenCalledWith('w-01');
    c.pickAlmacen('w-08');
    expect(api['consola']).toHaveBeenLastCalledWith('w-08');
    expect(localStorage.getItem('gp.consola.almacen')).toBe('w-08');
  });

  it('⭐ el refresco no pisa el umbral que el coordinador está escribiendo', async () => {
    await montar();
    c.umbral.set(8);
    c.reload(true);
    expect(c.umbral()).toBe(8);
    c.reload(); // la recarga a mano sí trae lo del servidor
    expect(c.umbral()).toBe(5);
  });

  it('prueba negativa: la respuesta de otro almacén (cambiaron a media consulta) se descarta', async () => {
    await montar();
    api['consola'].mockReturnValueOnce(of(RESP({ warehouse_id: 'w-01', surtidas_hoy: 99 })));
    c.reload(true);
    expect(c.data()?.surtidas_hoy).toBe(7);
  });

  it('un surtido arrancado en Reparto sin dueño no tiene turno ni se dice "Libre"', async () => {
    await montar(undefined, RESP({ olas: [OLA({ id: 'ola-r', code: 'W-2026-00020', status: 'en_surtido', tomable: false })] }));
    expect(texto()).toContain('Arrancado en Reparto');
    expect(texto()).not.toContain('Libre');
    expect(c.porTomar()).toBe(0);
  });

  it('cancelar algo con mercancía levantada lo advierte', async () => {
    await montar();
    botonEn(fila('W-2026-00003'), 'Cancelar surtido').click();
    render();
    expect(texto()).toContain('Ya se levantaron 3 renglones: hay que regresar esa mercancía.');
  });

  it('armar sin crear nada no se pinta como éxito', async () => {
    await montar();
    api['consolaArmar'].mockReturnValueOnce(of({ creadas: [], fallidas: [], bloqueados: [], vacios: [], atorados: { count: 0, desde: null } }));
    botones('Armar surtidos ahora')[0].click();
    render();
    expect(texto()).toContain('No se armó ningún surtido.');
    expect(c.avisoOk()).toBe(false);
  });

  it('volver a escribir la hora guardada deja de ser cambio (no queda un Guardar colgado)', async () => {
    await montar();
    const tc = RESP().destinos[0];
    c.setBorrador(tc, '11:00');
    expect(c.cambio(tc)).toBe(true);
    c.setBorrador(tc, '09:30');
    expect(c.cambio(tc)).toBe(false);
    c.setBorrador(tc, '');
    expect(c.borrador(tc)).toBe('09:30');
  });

  it('fila vacía: lo dice en lugar de pintar una tabla sin renglones', async () => {
    await montar(undefined, RESP({ olas: [] }));
    expect(texto()).toContain('No hay surtidos en la fila.');
  });
});
