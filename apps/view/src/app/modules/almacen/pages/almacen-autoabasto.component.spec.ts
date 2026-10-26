import { TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { provideRouter } from '@angular/router';
import { of } from 'rxjs';
import { vi } from 'vitest';
import type { AutoabastoPedidoGrupo, AutoabastoPedidoLinea, AutoabastoPedidoResponse, AutoabastoVieneDoc } from '@megadulces/contracts';
import { AlmacenAutoabastoComponent } from './almacen-autoabasto.component';
import { AutoabastoService } from '../autoabasto.service';
import { AuthService } from '../../../core/services/auth.service';
import { CONTEXT_HELP } from '../../../shared/context-help/context-help.dictionary';

/**
 * `[AB.39]` Autoabasto es UNA pantalla: la mesa y «Mi pedido» eran la misma cuenta pintada dos veces.
 * Estas pruebas son las de las dos pantallas viejas (`[AB.23]`, `[AB.28]`, `[AB.29]`) sobre la única,
 * más lo que la fusión tiene que garantizar: los filtros cambian lo que se VE, nunca lo que se PIDE.
 */
class ResizeObserverStub { observe(): void { /* */ } unobserve(): void { /* */ } disconnect(): void { /* */ } }
(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= ResizeObserverStub;

const doc = (p: Partial<AutoabastoVieneDoc>): AutoabastoVieneDoc => ({
  tipo: 'embarque', origen: '00', serie: 2, folio: '0001', estado: 'EMBARCADO', fecha: '2026-10-21', dias: 1, renglones: 4, monto: 1000, se_resta: true, ...p,
});
const linea = (p: Partial<AutoabastoPedidoLinea> = {}): AutoabastoPedidoLinea => ({
  product_id: 'p-1', sku: '70056', nombre: 'MAZAPÁN', venta_30d: 10, existencia: 2, objetivo: 12, falta: 10,
  ya_pedido: 2, atorado: 0, negado_30d: 0, en_camino: 3, planeado_compras: 0, pedido_sucursal: 0, falta_neta: 5,
  a_pedir: { cantidad: 5, unidad: 'cj', factor: 16, cantidad_base: 80, regla: 'cajas' } as never,
  ajuste: null, valor: 100, costo_base: 1, posicion: 'bajo_minimo', minimo_menor: 'no_aplica' as never, valor_menor: null,
  estado: 'sin_pedir', surte: { tipo: 'matriz', clave: '00', nombre: '00' },
  diagnostico: { min_stock: 1, reorder_point: 3, max_stock: 12, oc_en_camino: 0, venta_diaria: 0.4, next_due_date: null,
    lead_time_days: null, cadence_days: null, abc_class: null, rung_veredicto: null, sales_rank: 3 },
  ...p,
});
const grupo = (lineas: AutoabastoPedidoLinea[], p: Partial<AutoabastoPedidoGrupo> = {}): AutoabastoPedidoGrupo => ({
  tipo: 'matriz', clave: '00', nombre: '00', lineas, renglones_a_pedir: lineas.length, total_cajas: 5, renglones_sin_caja: 0,
  total_valor: 100, sin_valuar: 0, minimo_cajas: null, minimo_valor: null, ...p,
});
const RESP = (docs: AutoabastoVieneDoc[] = [], extra: Partial<AutoabastoPedidoResponse> = {}): AutoabastoPedidoResponse => ({
  almacen: { id: 'w-01', code: '01', name: 'Padre Hidalgo' }, fecha_mx: '2026-10-22', hora_mx: '13:00', cobertura_dias: 15,
  ventana_ya_pedido_dias: 7, ventana_negado_dias: 30, ventana_en_camino_dias: 7,
  viene: { documentos: docs, renglones_sin_unidad: 0 },
  grupos: [grupo([linea()])],
  pedidos_medidos: true, pedido_id: null, puede_ajustar: false, guardado_disponible: true, posiciones: ['agotado', 'bajo_minimo'] as never,
  ...extra,
});
const UNO = [{ id: 'w-01', code: '01', name: 'Padre Hidalgo', purchase_zone: null, is_purchase_hub: false }];

function montar(resp: AutoabastoPedidoResponse, extra: Record<string, unknown> = {}, warehouses = UNO) {
  const pedidos: string[] = [];
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    imports: [AlmacenAutoabastoComponent],
    providers: [
      provideZonelessChangeDetection(), provideRouter([]),
      { provide: AutoabastoService, useValue: {
        filtros: () => of({ warehouses }),
        pedido: (id: string) => { pedidos.push(id); return of(resp); }, abrirPedido: () => of(null), ...extra,
      } },
      { provide: AuthService, useValue: { user: () => ({ sub: 'u1', username: 'u1', permissions: {} }), token: () => null } },
    ],
  });
  const f = TestBed.createComponent(AlmacenAutoabastoComponent);
  f.detectChanges();
  return { f, c: f.componentInstance, pedidos };
}
const texto = (f: ReturnType<typeof montar>['f']) => ((f.nativeElement as HTMLElement).textContent || '').replace(/\s+/g, ' ');

describe('[AB.39] una sola pantalla: un almacén a la vez (D2)', () => {
  it('con un solo almacén, el pedido es de ese almacén y se carga solo', () => {
    const { f, pedidos } = montar(RESP());
    expect(pedidos).toEqual(['w-01']);
    expect(texto(f)).toContain('Padre Hidalgo');
  });

  it('con varios almacenes no adivina uno: pide elegir y no carga nada', () => {
    const dos = [...UNO, { id: 'w-03', code: '03', name: '8 Esquinas', purchase_zone: null, is_purchase_hub: false }];
    const { f, pedidos } = montar(RESP(), {}, dos);
    expect(pedidos).toHaveLength(0);
    expect(texto(f)).toContain('El pedido es de un solo almacén');
  });

  it('⛔ si lo ya pedido no se pudo medir, lo dice arriba', () => {
    expect(texto(montar(RESP([], { pedidos_medidos: false })).f)).toContain('no se pudo medir');
  });

  it('⛔ la matriz que surte se NOMBRA, nunca se numera (ni «00 · CEDIS»)', () => {
    const { f } = montar(RESP());
    const titulo = ((f.nativeElement as HTMLElement).querySelector('.ab-gtitle strong')?.textContent || '').trim();
    expect(titulo).toBe('CEDIS');
  });
});

describe('[AB.39] lo que traía la mesa sigue en la pantalla única', () => {
  it('el primario es cuántos productos faltan por pedir, y dice cuántos van en tu pedido', () => {
    const { c } = montar(RESP());
    expect(c.kpis()[0]).toMatchObject({ label: 'Falta por pedir', value: 1, tone: 'bad', sub: '1 en tu pedido' });
  });

  it('⛔ un importe que no se pudo medir sale «—», nunca $0; sin renglones es un cero medido', () => {
    const r = RESP();
    const sinCosto = { ...r, grupos: [grupo([linea({ valor: null, costo_base: null })])] };
    const { c } = montar(sinCosto);
    expect(c.kpis().find((k) => k.label === 'Se pide a la matriz')).toMatchObject({ value: '—', format: 'text' });
    expect(c.kpis().find((k) => k.label === 'Se pide al proveedor')).toMatchObject({ value: 0 });
  });

  it('muestra Falta neta, Estado y lo que explica la posición (mínimo, reorden, máximo)', () => {
    const t = texto(montar(RESP()).f);
    expect(t).toContain('Falta neta');
    expect(t).toContain('Falta por pedir');
    expect(t).toContain('mín 1 · reorden 3 · máx 12');
    expect(t).not.toContain('Acción');
  });

  it('un servidor que todavía no manda el diagnóstico no dibuja ceros', () => {
    const r = RESP();
    const { f } = montar({ ...r, grupos: [grupo([linea({ diagnostico: undefined })])] });
    expect(texto(f)).not.toContain('mín 0');
  });

  it('la vista filtra por estado y la búsqueda por SKU o nombre, sin acentos', () => {
    const r = RESP();
    const { c } = montar({ ...r, grupos: [grupo([linea(), linea({ product_id: 'p-2', sku: '999', nombre: 'CHICLE', estado: 'ya_viene', a_pedir: { cantidad: 0, unidad: 'cj', factor: 16, cantidad_base: 0, regla: 'nada' } as never })])] });
    const ids = () => c.gruposVisibles().flatMap((g) => c.lineasVisibles(g)).map((l) => l.product_id);
    expect(ids()).toEqual(['p-1']);
    c.setVista('ya_viene');
    expect(ids()).toEqual(['p-2']);
    c.setVista('todos');
    expect(ids()).toEqual(['p-1', 'p-2']);
    c.onSearch('mazapan');
    return new Promise<void>((res) => setTimeout(() => { expect(ids()).toEqual(['p-1']); res(); }, 400));
  });

  it('el conteo de cada estado va DENTRO del control', () => {
    const { c } = montar(RESP());
    expect(c.vistaOpts().find((o) => o.value === 'pedido')?.count).toBe(1);
    expect(c.vistaOpts().find((o) => o.value === 'todos')?.count).toBe(1);
  });
});

describe('[AB.23] lo que te va a llegar', () => {
  it('arriba dice cuántos embarques y pedidos vienen, por NOMBRE de sucursal, y que ya se restaron', () => {
    const { f } = montar(RESP([doc({}), doc({ folio: '0002', origen: '08' }), doc({ tipo: 'pedido', estado: 'SURTIDO', folio: '0450', origen: '01', dias: 2 })]));
    const t = texto(f);
    expect(t).toContain('Lo que te va a llegar');
    expect(t).toContain('2 embarques en camino');
    expect(t).toContain('1 pedido en preparación');
    expect(t).toContain('ya se restaron');
    expect(t).toContain('desde CEDIS');
    expect(t).toContain('desde Morelia Abastos');
    expect(t).not.toMatch(/desde 0[0-9]\b/);
  });

  it('⛔ lo viejo se muestra para reclamarlo y NO se cuenta como «ya se restó»', () => {
    const { c } = montar(RESP([doc({}), doc({ folio: '0009', dias: 12, se_resta: false })]));
    expect(c.viene()!.embarques).toBe(1);
    expect(c.viene()!.viejos).toBe(1);
  });

  it('lo que planeó Compras y no está en Kepler se muestra aparte y nunca se resta', () => {
    const { f, c } = montar(RESP([doc({}), doc({ tipo: 'plan', estado: 'PLANEADO', folio: 'RQ-1', se_resta: false, origen: '00' })]));
    expect(c.viene()!.planes).toBe(1);
    expect(c.viene()!.viejos).toBe(0);
    expect(texto(f)).toContain('aún no está en Kepler');
  });

  it('«Ya viene» suma lo pedido y lo que va en camino, y la cuenta lo explica', () => {
    const { c } = montar(RESP());
    const l = linea();
    expect(c.yaViene(l)).toBe(5);
    expect(c.yaVieneTitle(l)).toBe('Ya viene: pedido a la matriz 2 + en camino 3 cajas. Ya se restó de «A pedir».');
    expect(c.porQueAPedir(l)).toContain('Falta 10 − ya pedido 2 − en camino 3 = 5 cajas.');
  });

  it('nunca esconde documentos sin decirlo: muestra 6 y ofrece «Ver los N»', () => {
    const { f, c } = montar(RESP(Array.from({ length: 9 }, (_, i) => doc({ folio: String(i) }))));
    expect(c.viene()!.visibles.length).toBe(6);
    expect(texto(f)).toContain('Ver los 9');
    c.verTodoViene.set(true);
    expect(c.viene()!.visibles.length).toBe(9);
  });
});

describe('[AB.29] Enviar a Compras', () => {
  /** Un pedido que la persona PUEDE ajustar, con renglones de los cuatro casos. */
  const conCasos = (docs: AutoabastoVieneDoc[] = []): AutoabastoPedidoResponse => RESP(docs, {
    puede_ajustar: true,
    grupos: [
      grupo([
        linea({ product_id: 'p-falta' }),
        linea({ product_id: 'p-mandado', sku: '111', estado: 'lo_pediste', pedido_sucursal: 5 }),
        linea({ product_id: 'p-planeado', sku: '222', estado: 'compras_lo_planeo', planeado_compras: 5 }),
      ]),
      grupo([linea({ product_id: 'p-sinruta', sku: '333', surte: { tipo: 'sin_ruta', clave: null, nombre: 'Sin ruta configurada' } })],
        { tipo: 'sin_ruta', clave: null, nombre: 'Sin ruta configurada' }),
    ],
  });

  it('manda SÓLO lo que falta por pedir (no lo ya mandado, ni lo planeado, ni lo sin ruta), con la nota', () => {
    const enviar = vi.fn(() => of({ requisiciones: [{ id: 'r1', folio: 'RQ-2026-00001', surte: { tipo: 'matriz', clave: '00', nombre: '00' }, renglones: 1, total_cajas: 5 }],
      omitidos: [], le_llega_a: ['yajaira arizbeth gonzalez'] }));
    const { f, c } = montar(conCasos(), { enviar });
    expect(c.porEnviar().ids).toEqual(['p-falta']);
    c.abrirEnvio();
    c.notaEnvio.set('  viene promoción  ');
    c.enviar();
    expect(enviar).toHaveBeenCalledWith({ warehouse_id: 'w-01', product_ids: ['p-falta'], nota: 'viene promoción' });
    f.detectChanges();
    const t = texto(f);
    expect(t).toContain('Se mandó a Compras: RQ-2026-00001 (traspaso de CEDIS, 1 producto).');
    expect(t).toContain('Le llegó a Yajaira Arizbeth Gonzalez');
  });

  it('⭐ el pedido cuenta lo MISMO que se manda: lo que Compras planeó, lo que ya viene y lo sin ruta no entran', () => {
    const { c } = montar(conCasos());
    expect(c.enPedido().map((l) => l.product_id)).toEqual(c.porEnviar().ids);
    expect(c.enPedido().map((l) => l.product_id)).toEqual(['p-falta']);
    const plan = c.data()!.grupos[0].lineas.find((l) => l.product_id === 'p-planeado')!;
    expect(c.incluida(plan)).toBe(false);
    expect(c.editable(plan)).toBe(false);
    expect(c.fueraDelPedido(plan)).toBe('Compras ya lo planeó');
    // El importe de «Se pide a la matriz» es el de lo que sale, no el de lo planeado.
    expect(c.kpis().find((k) => k.label === 'Se pide a la matriz')).toMatchObject({ value: 80, sub: '1 renglón' }); // 5 cj × 16 × $1, en vivo
    // Y en «Todos» se ve, con su porqué.
    c.setVista('todos');
    expect(c.lineasVisibles(c.data()!.grupos[0]).map((l) => l.product_id)).toContain('p-planeado');
  });

  it('⭐ los filtros de la vista cambian lo que se VE, nunca lo que se manda', () => {
    const { c } = montar(conCasos());
    c.setVista('ya_viene');
    c.surte.set('proveedor');
    expect(c.gruposVisibles()).toHaveLength(0);
    expect(c.porEnviar().ids).toEqual(['p-falta']);
  });

  it('⛔ con un renglón movido y sin guardar, no se puede enviar: se manda lo guardado', () => {
    const { c } = montar(conCasos());
    c.edicion.set({ 'p-falta': { cantidad: 7, motivo: null, guardando: false, guardado: false, error: null, desde: null } });
    expect(c.sinGuardar()).toBe(1);
    expect(c.porQueNoEnviar()).toContain('Espera a que se guarden tus cambios');
    c.abrirEnvio();
    expect(c.envioAbierto()).toBe(false);
  });

  it('lo ya mandado no entra al pedido, un aviso dice cuántos son, y en «Todos» se ve con su porqué', () => {
    const { f, c } = montar(conCasos());
    expect(c.yaMandados()).toBe(1);
    expect(c.lineasVisibles(c.data()!.grupos[0]).map((l) => l.product_id)).not.toContain('p-mandado');
    expect(texto(f)).toContain('1 producto ya lo pediste a Compras');
    c.setVista('todos');
    const mandado = c.data()!.grupos[0].lineas.find((l) => l.product_id === 'p-mandado')!;
    expect(c.lineasVisibles(c.data()!.grupos[0]).map((l) => l.product_id)).toContain('p-mandado');
    expect(c.editable(mandado)).toBe(false);
    expect(c.fueraDelPedido(mandado)).toBe('Ya lo pediste a Compras');
  });

  it('una requisición rechazada se ve con el motivo de Compras', () => {
    const { f, c } = montar(conCasos([doc({ tipo: 'requisicion', estado: 'RECHAZADA', folio: 'RQ-2026-00009', origen: '00', se_resta: false,
      motivo: 'Hay existencia en la matriz para la otra semana' })]));
    const t = texto(f);
    expect(c.viene()!.rechazadas).toBe(1);
    expect(t).toContain('Rechazada');
    expect(t).toContain('Motivo de Compras: «Hay existencia en la matriz para la otra semana»');
    expect(t).not.toContain('ya se restaron');
  });
});

describe('[AB.40] el motor único dice lo que le hizo a la cantidad', () => {
  it('un renglón recortado por el tope de 45 días lo dice en el aviso y en el porqué', () => {
    const recortada = linea({ tope: { motivo: 'recortado', antes_base: 25920, dias: 44.6, dias_hoy: 0 } });
    const { f, c } = montar(RESP([], { grupos: [grupo([recortada])] }));
    expect(c.avisoTope(recortada)).toBe('Tope 45 días');
    expect(c.porQueAPedir(recortada)).toContain('Recortado por el tope de 45 días');
    expect(texto(f)).toContain('Tope 45 días');
  });

  it('con la unidad en duda dice que no se pide y por qué; sin tope medido, no inventa aviso', () => {
    const { c } = montar(RESP());
    expect(c.avisoTope(linea({ tope: { motivo: 'unidad_dudosa', antes_base: 80, dias: null, dias_hoy: null } }))).toBe('Unidad en duda');
    expect(c.textoTope(linea({ tope: { motivo: 'unidad_dudosa', antes_base: 80, dias: null, dias_hoy: null } }))).toContain('No se pide');
    expect(c.avisoTope(linea({ tope: { motivo: 'sin_medir', antes_base: 80, dias: null, dias_hoy: null } }))).toBeNull();
    expect(c.avisoTope(linea())).toBeNull();
  });
});

describe('[AB.39] la tabla nunca esconde renglones sin decirlo', () => {
  it('con más de 150, pinta 150, dice cuántos son y «Ver los N» los trae todos', () => {
    const muchas = Array.from({ length: 160 }, (_, i) => linea({ product_id: `p-${i}`, sku: String(1000 + i) }));
    const { f, c } = montar(RESP([], { grupos: [grupo(muchas)] }));
    const g = c.data()!.grupos[0];
    expect(c.tabla(g, 'mayor')).toHaveLength(150);
    expect(texto(f)).toContain('Se ven 150 de 160');
    c.expandir(g, 'mayor');
    expect(c.tabla(g, 'mayor')).toHaveLength(160);
  });
});

describe('[AB.39] la ayuda de la pantalla existe en el diccionario', () => {
  const topic = CONTEXT_HELP['almacen-autoabasto'];
  const terminos = topic.groups!.flatMap((g) => g.entries.map((e) => e.term));
  it.each(['A pedir', '¿Hasta dónde pides?', 'En tu pedido', 'Mínimo, reorden y máximo', 'Entrega',
    'Falta', 'Ya viene', 'Falta neta', 'Surte', 'Posición', 'Falta por pedir', 'Compras lo planeó', 'Valor sin medir'])(
    'documenta «%s»', (t) => {
      expect(terminos).toContain(t);
    });
  it('no repite términos', () => {
    expect(new Set(terminos).size).toBe(terminos.length);
  });
});
