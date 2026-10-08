import { TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { Observable, of, throwError } from 'rxjs';
import type { ReceivingLine, ReceivingSession } from '../receiving-session.service';
import { ReceivingSessionService } from '../receiving-session.service';
import { ReceivingAuditorService } from '../receiving-auditor.service';
import { AndenOfflineService } from './anden-offline.service';
import { ANDEN_STORE, MemoriaAndenStore } from './anden-offline.store';
import { MAX_INTENTOS_500, valeLocal } from './anden-offline';

/**
 * `[WMS-REC.20]` **La cola del Andén**, con un almacén en memoria y un servidor falso.
 *
 * Lo que se cuida: el orden (abrir → fechar → cerrar renglón → cerrar), que la captura sin red
 * caiga en el renglón del servidor, que una caída de red no pierda nada ni duplique, y que un
 * rechazo del servidor detenga SÓLO ese vale y quede a la vista.
 */

const linea = (id: string, sku: string, qty: number): ReceivingLine => ({
  id, product_id: `p-${sku}`, expected_sku: sku, expected_qty: qty, received_qty: 0,
  discrepancy_kind: 'pending', declared_qty: 0, held_qty: 0,
});

/** El vale como lo crea el servidor: OTRO orden que el del paquete, a propósito. */
const servidor = (status: ReceivingSession['status'] = 'open'): ReceivingSession => ({
  id: 'srv-1', folio: 'VE-2026-00042', warehouse_id: 'w1', source_kind: 'erp_receipt', status,
  lines: [linea('srv-b', 'B', 5), linea('srv-a', 'A', 24)],
});

const paqueteVale = {
  sucursal: '01', folio: '0000412', receipt_date: '2026-10-07', proveedor_code: 'C001', proveedor_nombre: 'DE LA ROSA',
  monto: 1, warehouse_id: 'w1', warehouse_code: '01', warehouse_name: 'PH', line_count: 2, service_count: 0,
  origin: { kind: 'supplier', isCedis: false, label: 'Proveedor', name: 'DE LA ROSA' }, tipo: 'compra', fuente: 'orden_entrada',
  lineas: [
    { expected_sku: 'A', expected_name: 'A', expected_qty: 24, expected_unit: 'PZA', product_id: 'p-A', sku: 'A', product_name: 'A' },
    { expected_sku: 'B', expected_name: 'B', expected_qty: 5, expected_unit: 'PZA', product_id: 'p-B', sku: 'B', product_name: 'B' },
  ],
} as never;

const error = (status: number, cuerpo: unknown = { message: `HTTP ${status}` }) => throwError(() => ({ status, error: cuerpo }));

interface Llamada { que: string; datos: unknown }

describe('[WMS-REC.20] la cola del Andén', () => {
  let store: MemoriaAndenStore;
  let red: AndenOfflineService;
  let llamadas: Llamada[];
  let respuestas: Record<string, () => Observable<unknown>>;

  beforeEach(() => {
    store = new MemoriaAndenStore();
    llamadas = [];
    respuestas = {};
    const responde = (que: string, porDefecto: () => Observable<unknown>) => (datos: unknown) => {
      llamadas.push({ que, datos });
      return (respuestas[que] ?? porDefecto)();
    };
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        { provide: ANDEN_STORE, useValue: store },
        {
          provide: ReceivingSessionService,
          useValue: {
            open: responde('open', () => of(servidor())),
            detail: responde('detail', () => of(servidor())),
            setLine: (id: string, lineId: string, p: unknown) => responde('setLine', () => of(servidor()))({ id, lineId, p }),
            close: responde('close', () => of(servidor('closed'))),
            offlinePack: responde('pack', () => of({ sucursal: '01', generado_en: '', vales: [] })),
          },
        },
        {
          provide: ReceivingAuditorService,
          useValue: { evaluate: responde('evaluate', () => of({ id: 'c1', verdict: 'green', status: 'accepted' })) },
        },
      ],
    });
    red = TestBed.inject(AndenOfflineService);
  });

  afterEach(() => TestBed.resetTestingModule());

  /** Un vale abierto sin red con dos caducidades y un renglón cerrado, todo en cola. */
  async function trabajoSinRed(): Promise<string> {
    red.online.set(false);
    const v = valeLocal(paqueteVale, '11111111-aaaa-4aaa-8aaa-000000000001');
    await red.guardarValeLocal(v, { sucursal: '01', erp: paqueteVale });
    await red.encolar({ tipo: 'abrir', valeKey: v.id, dto: { source_kind: 'erp_receipt', erp_sucursal: '01', erp_folio: '0000412', client_uuid: 'k-abrir' } });
    await red.encolar({ tipo: 'fechar', valeKey: v.id, lineaId: 'local:0', payload: { warehouse_id: 'w1', product_id: 'p-A', quantity: 24, client_uuid: 'k-fechar-a' } });
    await red.encolar({ tipo: 'fechar', valeKey: v.id, lineaId: 'local:1', payload: { warehouse_id: 'w1', product_id: 'p-B', quantity: 3, client_uuid: 'k-fechar-b' } });
    await red.encolar({ tipo: 'renglon', valeKey: v.id, lineaId: 'local:1', received_qty: 3 });
    await red.encolar({ tipo: 'cerrar', valeKey: v.id });
    return v.id;
  }

  it('sin red no manda nada, y lo hecho se ve en pantalla igual', async () => {
    const key = await trabajoSinRed();
    expect(llamadas).toEqual([]);
    expect(red.pendientes()).toBe(5);
    const vista = await red.vista(key);
    expect(vista!.lines!.map((l) => Number(l.declared_qty))).toEqual([24, 3]);
    expect(vista!.status).toBe('closed');
  });

  it('al volver la red manda TODO en orden, y cada captura cae en el renglón del servidor', async () => {
    const key = await trabajoSinRed();
    red.online.set(true);
    await red.flush();
    expect(llamadas.map((l) => l.que)).toEqual(['open', 'evaluate', 'evaluate', 'setLine', 'close']);
    // El renglón local:0 (SKU A) es srv-a aunque el servidor lo devolvió segundo.
    expect(llamadas[1].datos).toMatchObject({ receiving_line_id: 'srv-a', source_ref: 'VE-2026-00042', client_uuid: 'k-fechar-a' });
    expect(llamadas[2].datos).toMatchObject({ receiving_line_id: 'srv-b', client_uuid: 'k-fechar-b' });
    expect(llamadas[3].datos).toMatchObject({ id: 'srv-1', lineId: 'srv-b', p: { received_qty: 3 } });
    expect(red.pendientes()).toBe(0);
    expect(await red.sesionDe(key)).toBe('srv-1');
    expect(red.ultimoEnvio()).toMatchObject({ key, sessionId: 'srv-1', error: null });
  });

  it('si la red se cae a mitad, para ahí: lo enviado no se repite y lo demás sigue en cola CON SU LLAVE', async () => {
    await trabajoSinRed();
    let n = 0;
    respuestas['evaluate'] = () => (++n === 2 ? error(0) : of({ id: 'c', verdict: 'green' }));
    red.online.set(true);
    await red.flush();
    expect(llamadas.map((l) => l.que)).toEqual(['open', 'evaluate', 'evaluate']);
    expect(red.online()).toBe(false);
    expect(red.pendientes()).toBe(3);
    // Reintento: sigue donde se quedó, con la MISMA llave (si sí había llegado, el servidor no duplica).
    llamadas = [];
    red.online.set(true);
    await red.flush();
    expect(llamadas.map((l) => l.que)).toEqual(['evaluate', 'setLine', 'close']);
    expect(llamadas[0].datos).toMatchObject({ client_uuid: 'k-fechar-b' });
    expect(red.pendientes()).toBe(0);
  });

  it('lo ya enviado queda en la base aunque se caiga la red: no invita a fecharlo otra vez', async () => {
    const key = await trabajoSinRed();
    respuestas['evaluate'] = (() => {
      let n = 0;
      return () => (++n === 2 ? error(0) : of({ id: 'c', verdict: 'green' }));
    })();
    red.online.set(true);
    await red.flush();
    const vista = await red.vista(key);
    // A (24) se mandó y quedó en la base; B (3) sigue en cola encima. Ninguno aparece dos veces.
    expect(vista!.lines!.find((l) => l.id === 'srv-a')!.declared_qty).toBe(24);
    expect(vista!.lines!.find((l) => l.id === 'srv-b')!.declared_qty).toBe(3);
  });

  it('un rechazo del servidor detiene SÓLO ese vale y queda a la vista con su motivo', async () => {
    const key = await trabajoSinRed();
    respuestas['evaluate'] = () => error(409, { message: 'El almacén está congelado por INV-2026-00009' });
    red.online.set(true);
    await red.flush();
    expect(llamadas.map((l) => l.que)).toEqual(['open', 'evaluate']);
    expect(red.conError().map((o) => o.error)).toEqual(['El almacén está congelado por INV-2026-00009']);
    expect(red.online()).toBe(true);
    // No se reintenta solo…
    llamadas = [];
    await red.flush();
    expect(llamadas).toEqual([]);
    // …sino cuando alguien lo pide, después de arreglar la causa.
    respuestas['evaluate'] = () => of({ id: 'c', verdict: 'green' });
    await red.reintentar(key);
    expect(llamadas.map((l) => l.que)).toEqual(['evaluate', 'evaluate', 'setLine', 'close']);
    expect(red.pendientes()).toBe(0);
  });

  it('si otra persona abrió el mismo documento y sigue abierto, lo de este equipo se suma a ESE vale', async () => {
    await trabajoSinRed();
    respuestas['open'] = () => error(409, { error: 'folio_ya_recibido', message: 'ya se recibió', previous: { id: 'srv-1', folio: 'VE-2026-00042', status: 'open' } });
    red.online.set(true);
    await red.flush();
    expect(llamadas.map((l) => l.que)).toEqual(['open', 'detail', 'evaluate', 'evaluate', 'setLine', 'close']);
    expect(red.ultimoEnvio()!.avisos.join(' ')).toContain('VE-2026-00042');
  });

  it('si ya lo recibió y CERRÓ otra persona, no hay a dónde mandarlo: se detiene y se dice', async () => {
    await trabajoSinRed();
    respuestas['open'] = () => error(409, { error: 'folio_ya_recibido', message: 'El folio 01/0000412 ya se recibió en el vale VE-2026-00040 (closed).', previous: { id: 'srv-0', folio: 'VE-2026-00040', status: 'closed' } });
    red.online.set(true);
    await red.flush();
    expect(llamadas.map((l) => l.que)).toEqual(['open']);
    expect(red.conError()[0].error).toContain('VE-2026-00040');
  });

  it('cerrar un vale que ya estaba cerrado cuenta como hecho', async () => {
    await trabajoSinRed();
    respuestas['close'] = () => error(409, { message: 'La sesión está closed' });
    respuestas['detail'] = () => of(servidor('closed'));
    red.online.set(true);
    await red.flush();
    expect(red.pendientes()).toBe(0);
    expect(red.conError()).toEqual([]);
  });

  it(`un 500 se reintenta, pero a los ${MAX_INTENTOS_500} intentos el vale se detiene`, async () => {
    await trabajoSinRed();
    respuestas['open'] = () => error(500, { message: 'Internal server error' });
    for (let i = 0; i < MAX_INTENTOS_500; i++) {
      red.online.set(true);
      await red.flush();
    }
    expect(llamadas.filter((l) => l.que === 'open')).toHaveLength(MAX_INTENTOS_500);
    expect(red.conError()).toHaveLength(1);
    // Un 500 contestó: no es "sin red".
    expect(red.online()).toBe(true);
  });

  it('descartar tira lo pendiente y el vale que sólo existía en el equipo', async () => {
    const key = await trabajoSinRed();
    await red.descartar(key);
    expect(red.pendientes()).toBe(0);
    expect(await store.vale(key)).toBeNull();
  });

  it('un vale con algo en cola manda TODO lo nuevo a la cola, aunque haya red (no se salta el orden)', async () => {
    const key = await trabajoSinRed();
    red.online.set(true);
    expect(red.usaCola(key)).toBe(true);
    expect(red.usaCola('otro-vale-del-servidor')).toBe(false);
    red.online.set(false);
    expect(red.usaCola('otro-vale-del-servidor')).toBe(true);
  });

  it('ya mandada la apertura, lo nuevo del vale (aún llamado local:…) cae en el renglón y el folio del servidor', async () => {
    const key = await trabajoSinRed();
    red.online.set(true);
    await red.flush();
    llamadas = [];
    // La pantalla todavía muestra el vale local (el bodeguero está en un renglón): su escritura va a la cola.
    expect(red.usaCola(key)).toBe(true);
    await red.encolar({ tipo: 'fechar', valeKey: key, lineaId: 'local:0', payload: { warehouse_id: 'w1', product_id: 'p-A', quantity: 1, client_uuid: 'k-extra' } });
    await red.flush();
    expect(llamadas.map((l) => l.que)).toEqual(['evaluate', 'detail']);
    expect(llamadas[0].datos).toMatchObject({ receiving_line_id: 'srv-a', source_ref: 'VE-2026-00042', client_uuid: 'k-extra' });
  });

  it('el detalle que llega del servidor se guarda bajo la llave que el vale ya tenía', async () => {
    const key = await trabajoSinRed();
    red.online.set(true);
    await red.flush();
    await red.registrarDetalle(servidor());
    expect((await store.vales()).map((g) => g.key)).toEqual([key]);
    expect(await red.llaveDe('srv-1')).toBe(key);
  });
});
