import { describe, expect, it } from 'vitest';
import type { AutoabastoVieneDoc, ConsolaSurtidoOla, ConsolaSurtidoResponse } from '@megadulces/contracts';
import type { EntradaRow } from '../compras/entradas.service';
import {
  diasEntre, masViejo, ordenarSecciones, seccionEntradas, seccionLlega, seccionSurtido, veredicto,
  type EstadoSeccion, type Seccion,
} from './pendientes-sucursal.util';

const doc = (p: Partial<AutoabastoVieneDoc>): AutoabastoVieneDoc => ({
  tipo: 'embarque', origen: '00', serie: 2, folio: '100', estado: 'EMBARCADO', fecha: '2026-11-01',
  dias: 2, renglones: 3, monto: 1000, se_resta: true, ...p,
});

const ola = (p: Partial<ConsolaSurtidoOla>): ConsolaSurtidoOla => ({
  id: 'o1', code: 'OLA-1', status: 'abierta', origen: null, armada_por: 'consola', prioridad: 0, prioridad_motivo: null,
  assigned_to: null, assigned_nombre: null, created_at: '2026-11-01T15:00:00Z', started_at: null, tomable: true,
  renglones: 4, tocados: 0, pedidos: [], destinos: [], hora_salida: null, ...p,
} as ConsolaSurtidoOla);

describe('[AB.44] Pendientes de la sucursal — qué es pendiente', () => {
  it('el embarque sin recibir ES pendiente de la sucursal; el pedido sin embarcar y la requisición por aprobar NO', () => {
    const s = seccionLlega([
      doc({ tipo: 'embarque', folio: 'E1', dias: 3 }),
      doc({ tipo: 'pedido', folio: 'P1', estado: 'AUTORIZADO' }),
      doc({ tipo: 'requisicion', folio: 'R1', estado: 'POR APROBAR', id: 'r1' }),
      doc({ tipo: 'plan', folio: 'PL1', estado: 'PLANEADO', id: 'p1' }),
    ]);
    expect(s.pendientes.map((p) => p.folio)).toEqual(['E1']);
    expect(s.total).toBe(1);
    expect(s.informativo).toContain('1 pedido de traspaso');
    expect(s.informativo).toContain('2 requisiciones con Compras');
  });

  it('la requisición RECHAZADA sí es pendiente, con su motivo', () => {
    const s = seccionLlega([doc({ tipo: 'requisicion', folio: 'R9', estado: 'RECHAZADA', motivo: 'Ya hay en CEDIS', id: 'r9' })]);
    expect(s.total).toBe(1);
    expect(s.pendientes[0].detalle).toBe('Motivo: Ya hay en CEDIS');
  });

  it('el origen se NOMBRA, no se numera', () => {
    const s = seccionLlega([doc({ origen: '00' })]);
    expect(s.pendientes[0].detalle).not.toMatch(/\b00\b/);
  });

  it('lo más viejo primero', () => {
    const s = seccionLlega([doc({ folio: 'A', dias: 1 }), doc({ folio: 'B', dias: 9 }), doc({ folio: 'C', dias: 4 })]);
    expect(s.pendientes.map((p) => p.folio)).toEqual(['B', 'C', 'A']);
    expect(masViejo(s)).toBe(9);
  });

  it('entradas: el total es el del servidor aunque la página venga recortada', () => {
    const rows = [{ sucursal: '01', folio: 'X1', receipt_date: '2026-10-01', proveedor_nombre: 'Prov', proveedor_code: null, monto: '120.5' }] as unknown as EntradaRow[];
    const s = seccionEntradas(rows, 37, '2026-11-03', '01', '2026-08-05');
    expect(s.total).toBe(37);
    expect(s.pendientes[0].dias).toBe(33);
    expect(s.pendientes[0].monto).toBe(120.5);
    expect(s.queryParams).toEqual({ suc: '01', estado: 'pendiente', from: '2026-08-05' });
  });

  it('surtido: sólo abiertas y en surtido; lo surtido no cuenta', () => {
    const c = { olas: [ola({ id: 'a', status: 'abierta' }), ola({ id: 'b', status: 'en_surtido' }), ola({ id: 'c', status: 'surtida' })],
      por_armar: { pedidos: 2, tanda: 0, individual: 0, bloqueados: 0, atorados: { count: 0, desde: null } } } as unknown as ConsolaSurtidoResponse;
    const s = seccionSurtido(c, '2026-11-03');
    expect(s.total).toBe(2);
    expect(s.informativo).toContain('2 pedidos autorizados');
  });
});

describe('[AB.44] el veredicto no confunde «no se pudo leer» con «cero»', () => {
  const ok = (total: number, dias: number | null): EstadoSeccion<Seccion> => ({
    estado: 'ok',
    data: { id: 'llega', titulo: '', ruta: '', rutaLabel: '', informativo: null, total,
      pendientes: Array.from({ length: total }, (_, i) => ({ clave: String(i), titulo: '', folio: String(i), detalle: '', dias, monto: null, accion: '' })) },
  });

  it('una sección con error se cuenta como sin leer, no como cero', () => {
    const v = veredicto([ok(2, 5), { estado: 'error', mensaje: 'x' }]);
    expect(v).toEqual({ total: 2, masViejo: 5, sinLeer: 1, cargando: 0 });
  });

  it('prueba negativa: sin errores, sinLeer es 0', () => {
    expect(veredicto([ok(0, null)]).sinLeer).toBe(0);
  });

  it('las secciones con pendientes van antes que las que están al día', () => {
    const a = (ok(0, null) as { data: Seccion }).data;
    const b = { ...(ok(1, 2) as { data: Seccion }).data, id: 'entradas' as const };
    expect(ordenarSecciones([a, b]).map((s) => s.id)).toEqual(['entradas', 'llega']);
  });

  it('diasEntre toma el día de México de un ISO, y no da negativos', () => {
    expect(diasEntre('2026-11-03T05:00:00Z', '2026-11-03')).toBe(1); // 23:00 del día 2 en México
    expect(diasEntre('2026-11-05', '2026-11-03')).toBe(0);
    expect(diasEntre(null, '2026-11-03')).toBeNull();
  });
});
