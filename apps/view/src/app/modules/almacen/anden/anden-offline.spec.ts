import type { AndenPaqueteOffline, AndenValeOffline } from '@megadulces/contracts';
import type { ReceivingLine, ReceivingSession } from '../receiving-session.service';
import {
  OpAnden,
  ValeGuardado,
  discrepancia,
  emparejarRenglones,
  esFallaDeRed,
  esSinRed,
  incompletosLocales,
  menuDesdePaquetes,
  mismoDocumento,
  superponer,
  valeLocal,
  valesDisponibles,
} from './anden-offline';

/**
 * `[WMS-REC.20]` Las decisiones del Andén sin red, sin Angular ni base.
 *
 * Lo que más cuesta si se rompe: que una captura hecha sin red caiga en OTRO renglón al
 * sincronizar, o que lo ya fechado desaparezca de la pantalla (y se feche dos veces).
 */

const linea = (id: string, sku: string, qty: number, extra: Partial<ReceivingLine> = {}): ReceivingLine => ({
  id, product_id: `p-${sku}`, expected_sku: sku, expected_qty: qty, received_qty: 0,
  discrepancy_kind: 'pending', declared_qty: 0, held_qty: 0, ...extra,
});

const vale = (lines: ReceivingLine[], extra: Partial<ReceivingSession> = {}): ReceivingSession => ({
  id: 's1', folio: 'VE-2026-00001', warehouse_id: 'w1', source_kind: 'erp_receipt', status: 'open', lines, ...extra,
});

let seq = 0;
const op = (o: Partial<OpAnden> & Pick<OpAnden, 'tipo'>): OpAnden =>
  ({ id: `o${++seq}`, seq: seq, valeKey: 's1', creadoEn: '', intentos: 0, estado: 'pendiente', ...o }) as OpAnden;

const pv = (folio: string, extra: Partial<AndenValeOffline> = {}): AndenValeOffline => ({
  sucursal: '01', folio, receipt_date: '2026-10-07', proveedor_code: 'C001', proveedor_nombre: 'DE LA ROSA',
  monto: 100, warehouse_id: 'w1', warehouse_code: '01', warehouse_name: 'Padre Hidalgo', line_count: 1, service_count: 0,
  origin: { kind: 'supplier', isCedis: false, label: 'Proveedor', name: 'DE LA ROSA' }, tipo: 'compra',
  fuente: 'orden_entrada',
  lineas: [{ expected_sku: '70001', expected_name: 'PALETA', expected_qty: 24, expected_unit: 'PZA', product_id: 'p-70001', sku: '70001', product_name: 'PALETA' }],
  ...extra,
} as AndenValeOffline);

describe('[WMS-REC.20] renglón local ↔ renglón del servidor', () => {
  it('se empareja por SKU y cantidad, NO por posición (el servidor ordena distinto)', () => {
    const locales = [linea('local:0', 'A', 12), linea('local:1', 'B', 5)];
    const servidor = [linea('srv-b', 'B', 5), linea('srv-a', 'A', 12)];
    expect(emparejarRenglones(locales, servidor)).toEqual({ 'local:0': 'srv-a', 'local:1': 'srv-b' });
  });

  it('el mismo SKU dos veces se empareja uno a uno, sin repetir renglón', () => {
    const locales = [linea('local:0', 'A', 12), linea('local:1', 'A', 12), linea('local:2', 'A', 3)];
    const servidor = [linea('x', 'A', 12), linea('y', 'A', 3), linea('z', 'A', 12)];
    const m = emparejarRenglones(locales, servidor);
    expect(new Set([m['local:0'], m['local:1']])).toEqual(new Set(['x', 'z']));
    expect(m['local:2']).toBe('y');
  });

  it('un renglón que el servidor no tiene queda sin pareja (no se inventa)', () => {
    expect(emparejarRenglones([linea('local:0', 'Z', 1)], [linea('a', 'A', 1)])).toEqual({});
  });
});

describe('[WMS-REC.20] lo pendiente encima de la base', () => {
  it('una caducidad en cola cuenta como declarada; un renglón cerrado, como cerrado', () => {
    const base = vale([linea('s-a', 'A', 24), linea('s-b', 'B', 10)]);
    const v = superponer(base, [
      op({ tipo: 'fechar', lineaId: 's-a', payload: { quantity: 20 } as never }),
      op({ tipo: 'renglon', lineaId: 's-b', received_qty: 6 }),
    ]);
    expect(v.lines![0].declared_qty).toBe(20);
    expect(v.lines![1]).toMatchObject({ received_qty: 6, discrepancy_kind: 'faltante' });
    // La base no se toca: es lo que dijo el servidor.
    expect(base.lines![0].declared_qty).toBe(0);
  });

  it('la cola que todavía nombra renglones LOCALES cae en el del servidor por el mapa', () => {
    const base = vale([linea('srv-a', 'A', 24)]);
    const v = superponer(base, [op({ tipo: 'fechar', lineaId: 'local:0', payload: { quantity: 24 } as never })], { 'local:0': 'srv-a' });
    expect(v.lines![0].declared_qty).toBe(24);
  });

  it('cerrar en cola deja el vale cerrado en pantalla', () => {
    expect(superponer(vale([]), [op({ tipo: 'cerrar' })]).status).toBe('closed');
  });

  it('una captura suelta (sin renglón) no toca ningún renglón', () => {
    const v = superponer(vale([linea('s-a', 'A', 24)]), [op({ tipo: 'fechar', lineaId: '', payload: { quantity: 5 } as never })]);
    expect(v.lines![0].declared_qty).toBe(0);
  });

  it('el renglón cerrado sin red se ve igual que lo calcularía el servidor', () => {
    expect(discrepancia(24, 0)).toBe('pending');
    expect(discrepancia(24, 10)).toBe('faltante');
    expect(discrepancia(24, 30)).toBe('sobrante');
    expect(discrepancia(24, 24)).toBe('ok');
  });
});

describe('[WMS-REC.20] el vale abierto sin red', () => {
  it('tiene la forma del detalle del servidor, con renglones locales y sin folio todavía', () => {
    const v = valeLocal(pv('0000412'), 'abc');
    expect(v.id).toBe('local:abc');
    expect(v.folio).toBe('Sin folio aún');
    expect(v.source_kind).toBe('erp_receipt');
    expect(v.lines).toEqual([expect.objectContaining({ id: 'local:0', product_id: 'p-70001', expected_qty: 24, discrepancy_kind: 'pending' })]);
    expect(valeLocal(pv('1', { fuente: 'embarque', serie: 2, tipo: 'traspaso' }), 'x').source_kind).toBe('erp_transfer');
  });

  it('un embarque se reconoce también por su serie (el folio se repite entre series)', () => {
    const a = { sucursal: '00', folio: '1048', serie: 2, fuente: 'embarque' as const };
    expect(mismoDocumento(a, { ...a })).toBe(true);
    expect(mismoDocumento(a, { ...a, serie: 3 })).toBe(false);
    expect(mismoDocumento(a, { ...a, fuente: 'orden_entrada' })).toBe(false);
  });
});

describe('[WMS-REC.20] ¿red o negocio?', () => {
  it('sin respuesta, tiempo agotado y la puerta caída son "sin red": se cae a lo guardado', () => {
    for (const s of [0, 408, 502, 503, 504]) expect(esSinRed({ status: s })).toBe(true);
    expect(esSinRed(new Error('Timeout has occurred'))).toBe(true);
  });

  it('un 500 SÍ contestó: no se esconde detrás de datos guardados', () => {
    expect(esSinRed({ status: 500 })).toBe(false);
    expect(esSinRed({ status: 409 })).toBe(false);
  });

  it('en la cola, 500/401/429 se reintentan; 400/403/404/409 detienen el vale', () => {
    for (const s of [0, 401, 408, 429, 500, 503]) expect(esFallaDeRed({ status: s })).toBe(true);
    for (const s of [400, 403, 404, 409, 422]) expect(esFallaDeRed({ status: s })).toBe(false);
  });
});

describe('[WMS-REC.20] el menú sin red', () => {
  const paquete = (vales: AndenValeOffline[]): AndenPaqueteOffline => ({ sucursal: '01', generado_en: '2026-10-07T18:00:00Z', vales });
  const guardado = (erpFolio: string): ValeGuardado => ({
    key: `local:${erpFolio}`, sessionId: null, vale: valeLocal(pv(erpFolio), erpFolio), mapa: {}, sucursal: '01',
    erp: pv(erpFolio), actualizado: '',
  });

  it('cuenta lo que queda por abrir: lo ya abierto en el equipo no se ofrece otra vez', () => {
    const p = paquete([pv('1'), pv('2', { receipt_date: '2026-10-05' }), pv('3', { fuente: 'embarque', tipo: 'traspaso', serie: 1 })]);
    expect(valesDisponibles(p, [guardado('1')]).map((v) => v.folio)).toEqual(['2', '3']);
    const [b] = menuDesdePaquetes([p], [guardado('1')], '2026-10-07');
    expect(b).toMatchObject({ sucursal: '01', pendientes: 2, compras: 1, anteriores: 1, traspasos: 1, sin_almacen: false });
  });

  it('una sucursal sin nada por abrir no sale en el menú', () => {
    expect(menuDesdePaquetes([paquete([pv('1')])], [guardado('1')], '2026-10-07')).toEqual([]);
  });
});

describe('[WMS-REC.20] incompletos del equipo', () => {
  it('cuenta lo que falta fechar con la cola encima, y no lista lo cerrado', () => {
    const abierto: ValeGuardado = {
      key: 'local:a', sessionId: null, vale: vale([linea('l0', 'A', 24), linea('l1', 'B', 5)], { id: 'local:a', folio: 'Sin folio aún' }),
      mapa: {}, sucursal: '01', erp: pv('9'), actualizado: '2026-10-07T10:00:00Z',
    };
    const cerrado: ValeGuardado = { ...abierto, key: 'local:c', vale: { ...abierto.vale, id: 'local:c' } };
    const ops = [
      op({ tipo: 'fechar', valeKey: 'local:a', lineaId: 'l0', payload: { quantity: 24 } as never }),
      op({ tipo: 'cerrar', valeKey: 'local:c' }),
    ];
    const r = incompletosLocales([abierto, cerrado], ops);
    expect(r.map((x) => x.id)).toEqual(['local:a']);
    expect(r[0]).toMatchObject({ por_fechar: 1, renglones: 2, documento: '01/9' });
  });
});
