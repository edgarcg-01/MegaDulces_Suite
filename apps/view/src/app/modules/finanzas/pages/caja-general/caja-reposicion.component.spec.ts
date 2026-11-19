import { describe, expect, it, vi } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { provideRouter } from '@angular/router';
import { MessageService } from 'primeng/api';
import { NEVER, Subject, of, throwError, type Observable } from 'rxjs';
import type {
  HojaAbierta, HojaGastos, HojasDeGastos, PagoHojaResultado, ReposicionDoc, ReposicionGrupo, ReposicionSucursales, ReposicionVinculo,
} from '@megadulces/contracts';
import { CashLedgerService, type ResumenLote } from '../../cash-ledger.service';
import { CaosService } from '../../caos.service';
import { AuthService } from '../../../../core/services/auth.service';
import { PermissionsService } from '../../../../core/services/permissions.service';
import { money } from '../finanzas-format';
import { avisoDePagoHoja, avisoDeReposicion, CajaReposicionComponent } from './caja-reposicion.component';

/**
 * El aviso de «Reponer». Canindo 30/10 (2026-10-30): decía «0 de 1… 1 no se pudieron» y el servidor
 * sí había mandado el porqué; lo que importa es que el folio y el motivo lleguen a la pantalla.
 */
const HOJA = 'Va en la hoja de gastos de Zona Canindo: se paga con la reposición de la zona, en Caja General › Reposición (toca la fila en la cola).';
const doc = (folio: string) => ({ origen_ref: `06|X-D-26|${folio}|0011`, doc_tipo: 'X-D-26', folio });
const lote = (p: Partial<ResumenLote>): ResumenLote => ({
  filas: [], guardados: 0, duplicados: 0, rechazados: 0, no_confirmables: 0, monto_guardado: 0, ...p,
});

describe('avisoDeReposicion · lo que no entró dice cuál y por qué', () => {
  it('Canindo 30/10: nombra el folio y el motivo del servidor, y se queda hasta cerrarlo', () => {
    const a = avisoDeReposicion(lote({
      filas: [{ origen_ref: '06|X-D-26|0000373|0011', estado: 'no_confirmable', motivo: HOJA }],
      no_confirmables: 1,
      retiro: { device: 'AST700-19758', external_id: 1818, ref: 'bono productividad canindo', libre_antes: 24220, tomado: 0, libre_despues: 24220, del_cajon: 0 },
    }), 1, [doc('0000373')]);
    expect(a.detail).toContain('No entró (sigue en la cola) — X-D-26 0000373: Va en la hoja de gastos de Zona Canindo');
    expect(a.detail).toContain('Caja General › Reposición');
    expect(a.severity).toBe('error');
    expect(a.sticky).toBe(true);
  });

  it('[negativa] nada guardado no presume un reparto: sin «CAOS $0.00, cajón $0.00»', () => {
    const a = avisoDeReposicion(lote({
      filas: [{ origen_ref: 'x', estado: 'rechazado', motivo: 'algo' }], rechazados: 1,
      retiro: { device: 'd', external_id: 1, ref: null, libre_antes: 10, tomado: 0, libre_despues: 10, del_cajon: 0 },
    }), 1, []);
    expect(a.detail).not.toContain('CAOS');
  });

  it('todo entró: verde, con lo que tomó del retiro y lo del cajón, y se va solo', () => {
    const a = avisoDeReposicion(lote({
      filas: [{ origen_ref: '06|X-D-26|0000373|0011', estado: 'guardado', folio: 'CG-1' }], guardados: 1, monto_guardado: 24229.73,
      retiro: { device: 'd', external_id: 1818, ref: null, libre_antes: 24220, tomado: 24220, libre_despues: 0, del_cajon: 9.73 },
    }), 1, [doc('0000373')]);
    expect(a.detail).toBe(`1 de 1 egresos guardados por ${money(24229.73)} · CAOS ${money(24220)}, cajón ${money(9.73)}.`);
    expect(a.severity).toBe('success');
    expect(a.sticky).toBe(false);
  });

  it('a medias: junta los folios por motivo y cuenta aparte lo que ya estaba capturado', () => {
    const a = avisoDeReposicion(lote({
      filas: [
        { origen_ref: '06|X-D-26|0000001|0011', estado: 'guardado', folio: 'CG-1' },
        { origen_ref: '06|X-D-26|0000002|0011', estado: 'rechazado', motivo: 'Falta el concepto.' },
        { origen_ref: '06|X-D-26|0000003|0011', estado: 'rechazado', motivo: 'Falta el concepto.' },
        { origen_ref: '06|X-D-26|0000004|0011', estado: 'duplicado', motivo: 'Otra persona confirmó este mismo documento.' },
      ],
      guardados: 1, rechazados: 2, duplicados: 1, monto_guardado: 100,
    }), 4, [doc('0000001'), doc('0000002'), doc('0000003'), doc('0000004')]);
    expect(a.detail).toContain('1 ya estaba capturado');
    expect(a.detail).toContain('2 no entraron (siguen en la cola) — X-D-26 0000002, X-D-26 0000003: Falta el concepto.');
    expect(a.severity).toBe('warn');
  });

  it('[negativa] un rechazo sin motivo lo dice, en vez de dejar el hueco', () => {
    const a = avisoDeReposicion(lote({ filas: [{ origen_ref: 'ref-suelta', estado: 'rechazado' }], rechazados: 1 }), 1, []);
    expect(a.detail).toContain('ref-suelta: el servidor no dijo por qué.');
  });
});

// ── `[LE.6.34]` Las ventanas de Reposición, montadas y usadas como las usaría la cajera ─────────────

class ResizeObserverStub { observe(): void { /* no-op */ } unobserve(): void { /* no-op */ } disconnect(): void { /* no-op */ } }
(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= ResizeObserverStub;

/** Una hoja de zona aprobada que se paga del cajón: $1,000. */
const HOJA_CAJON = { id: 'h1', folio: 'HG-1', total: 1000, retiros_que_cuadran: [], renglones: [] } as unknown as HojaGastos;

function montar(pago: () => Observable<PagoHojaResultado> = () => NEVER,
  o: { hojas?: HojasDeGastos; reposicion?: ReposicionSucursales } = {}) {
  const api = {
    reposicion: vi.fn((): Observable<ReposicionSucursales> => (o.reposicion ? of(o.reposicion) : NEVER)),
    hojasDeGastos: vi.fn((): Observable<HojasDeGastos> => (o.hojas ? of(o.hojas) : NEVER)),
    pagarHojaDeGastos: vi.fn(pago), pagarHojaAbierta: vi.fn(() => NEVER), capturarHojaDeGastos: vi.fn(() => NEVER),
    confirmarLote: vi.fn(() => NEVER),
  };
  const toast = { add: vi.fn() };
  TestBed.configureTestingModule({
    imports: [CajaReposicionComponent],
    providers: [
      provideZonelessChangeDetection(), provideRouter([]),
      { provide: CashLedgerService, useValue: api },
      { provide: CaosService, useValue: { moverVinculo: vi.fn(() => NEVER) } },
      { provide: MessageService, useValue: toast },
      { provide: AuthService, useValue: { user: () => ({ sub: 'u1' }), token: () => null } },
      { provide: PermissionsService, useValue: { has: () => true, hasAny: () => true, isAdmin: () => false, isSuperadmin: () => true, cargado: () => true } },
    ],
  });
  const fixture = TestBed.createComponent(CajaReposicionComponent);
  fixture.componentRef.setInput('puedeGestionar', true);
  fixture.detectChanges();
  const comp = fixture.componentInstance;
  const pinta = async () => { fixture.detectChanges(); await fixture.whenStable(); fixture.detectChanges(); };
  const boton = (testid: string) => document.body.querySelector<HTMLButtonElement>(`[data-testid="${testid}"] button, button[data-testid="${testid}"]`);
  /** Abre el arqueo de lo que sale del cajón para la hoja de $1,000. */
  const abrirConteo = async () => { comp.elegirHoja(HOJA_CAJON, 'cajon'); comp.pagarHoja(HOJA_CAJON); await pinta(); };
  return { fixture, comp, api, toast, pinta, boton, abrirConteo };
}

describe('[LE.6.34] Reposición · el arqueo de lo que sale del cajón', () => {
  it('con piezas, «Volver» pregunta y la ventana sigue abierta (sin X); sin piezas cierra directo', async () => {
    const m = montar();
    await m.abrirConteo();
    expect(m.comp.contando()?.clave).toBe('hoja|h1');
    // Control: limpia, la X está y «Volver» cierra.
    expect(document.body.querySelector('.p-dialog [aria-label="Cerrar"]')).not.toBeNull();
    m.comp.conteoPiezas.set({ '500': 1 });
    await m.pinta();
    expect(document.body.querySelector('.p-dialog [aria-label="Cerrar"]')).toBeNull();
    m.boton('dc-cancelar')!.click();
    await m.pinta();
    expect(m.comp.contando()).not.toBeNull();
    expect(document.body.querySelector('[data-testid="dc-pregunta"]')).not.toBeNull();
    m.boton('dc-descartar')!.click();
    await m.pinta();
    expect(m.comp.contando()).toBeNull();
    expect(m.comp.conteoPiezas()).toEqual({});

    await m.abrirConteo();
    m.boton('dc-cancelar')!.click();
    await m.pinta();
    expect(m.comp.contando()).toBeNull();
  });

  it('reabrir el arqueo del MISMO pago conserva las piezas', async () => {
    const m = montar();
    await m.abrirConteo();
    m.comp.conteoPiezas.set({ '500': 1 });
    m.comp.cerrarConteo();
    await m.abrirConteo();
    expect(m.comp.conteoPiezas()).toEqual({ '500': 1 });
  });

  it('mientras paga, «Volver» está apagado y la ventana no se cierra', async () => {
    const enVuelo = new Subject<PagoHojaResultado>();
    const m = montar(() => enVuelo);
    await m.abrirConteo();
    m.comp.conteoPiezas.set({ '1000': 1 });
    await m.pinta();
    expect(m.comp.conteoListo()).toBe(true);
    m.boton('rp-pagar-conteo')!.click();
    await m.pinta();
    expect(m.api.pagarHojaDeGastos).toHaveBeenCalledTimes(1);
    expect(m.boton('dc-cancelar')!.disabled).toBe(true);
    m.comp.cerrarConteo();
    m.comp.descartarConteo();
    await m.pinta();
    expect(m.comp.contando()).not.toBeNull();
    expect(m.comp.conteoPiezas()).toEqual({ '1000': 1 });
  });

  it('Enter en la última pieza lleva el foco a «Pagar…», no a «Volver»', async () => {
    const m = montar();
    await m.abrirConteo();
    m.comp.conteoPiezas.set({ '1000': 1 });
    await m.pinta();
    const campos = [...document.body.querySelectorAll<HTMLInputElement>('.p-dialog input.cc-in')];
    expect(campos.length).toBeGreaterThan(3);
    const ultimo = campos[campos.length - 1];
    ultimo.focus();
    ultimo.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    expect(document.activeElement).toBe(m.boton('rp-pagar-conteo'));
    // Y nada se descartó.
    expect(m.comp.contando()).not.toBeNull();
  });

  it('si el pago falla, el error aparece DENTRO de la ventana (role="alert"), no en un toast detrás', async () => {
    const m = montar(() => throwError(() => ({ status: 409, error: { message: 'El cajón no alcanza para HG-1' } })));
    await m.abrirConteo();
    m.comp.conteoPiezas.set({ '1000': 1 });
    await m.pinta();
    m.boton('rp-pagar-conteo')!.click();
    await m.pinta();
    const err = document.body.querySelector('.p-dialog [data-testid="rp-conteo-err"]');
    expect(err?.getAttribute('role')).toBe('alert');
    expect(err?.textContent).toContain('El cajón no alcanza para HG-1');
    expect(m.toast.add).not.toHaveBeenCalledWith(expect.objectContaining({ severity: 'error' }));
    // Las piezas siguen: se corrige y se reintenta sin volver a contar.
    expect(m.comp.conteoPiezas()).toEqual({ '1000': 1 });
  });
});

describe('[LE.6.34] Reposición · «Cambiar de retiro» en vuelo', () => {
  it('mientras cambia no se cierra: sin X y «Cancelar» apagado (antes Esc la dejaba trabada)', async () => {
    const m = montar();
    m.comp.abrirMover({ link_id: 'l1', monto: 100, ref: 'gnf', external_id: 9 } as unknown as ReposicionVinculo,
      { folio: 'X-1', cg_folio: null } as unknown as ReposicionDoc);
    await m.pinta();
    expect(document.body.querySelector('.p-dialog [aria-label="Cerrar"]')).not.toBeNull();
    m.comp.ocupado.set('mover');
    await m.pinta();
    expect(document.body.querySelector('.p-dialog [aria-label="Cerrar"]')).toBeNull();
    expect(m.boton('rp-mover-cancelar')!.disabled).toBe(true);
  });
});

describe('[LE.6.34] avisoDePagoHoja · lo que no entró dice TODOS sus motivos y se queda', () => {
  const resultado = (sin: PagoHojaResultado['sin_capturar']) => ({
    sin_capturar: sin,
    hoja: { renglones: [{ origen_ref: 'r1', doc_tipo: 'X-D-26', folio: '0000001' }, { origen_ref: 'r2', doc_tipo: 'X-D-26', folio: '0000002' }] },
  }) as unknown as PagoHojaResultado;

  it('dos motivos distintos: los nombra los dos, con su folio, y es sticky', () => {
    const a = avisoDePagoHoja(resultado([{ origen_ref: 'r1', motivo: 'Falta la cuenta contable.' }, { origen_ref: 'r2', motivo: 'El beneficiario no existe' }]),
      '1 pago quedó explicado por el cajón.');
    expect(a.detail).toContain('X-D-26 0000001: Falta la cuenta contable');
    expect(a.detail).toContain('X-D-26 0000002: El beneficiario no existe');
    expect(a.severity).toBe('warn');
    expect(a.sticky).toBe(true);
  });

  it('[control] todo entró: verde y se va solo', () => {
    const a = avisoDePagoHoja(resultado([]), '2 pagos quedaron explicados por el cajón.');
    expect(a).toEqual({ severity: 'success', detail: '2 pagos quedaron explicados por el cajón.', sticky: false });
  });
});

/** [LE.6.35] Desde la cola, un pago «en hoja» lleva a SU hoja (PM, 2026-11-19). */
describe('[LE.6.35] abrirEn · el pago «en hoja» de la cola lleva a su reposición', () => {
  const R = (folio: string) => ({ origen_ref: '06|X-D-26|' + folio + '|0011', sucursal: '06', doc_tipo: 'X-D-26', folio, fecha_pago: '2026-11-19', beneficiario: 'MANIOBRAS', importe: 100 });
  const abierta = (over: Record<string, unknown> = {}) => ({ zona: 'canindo', nombre: 'Zona Canindo', renglones: [R('0000547')], detenidos: [], fuera: [], pagados_aparte: [], sin_deposito: [], ...over });
  const conHojas = (hojas: unknown) => { const m = montar(); m.api.hojasDeGastos.mockReturnValue(of(hojas) as never); return m; };

  it('⭐ en la hoja abierta: despliega la zona, resalta el renglón y dice dónde está', () => {
    const { comp } = conHojas({ abiertas: [abierta()], cerradas: [] });
    comp.abrirEn('06|X-D-26|0000547|0011');
    expect(comp.abierta()).toBe(true);
    expect(comp.abiertas()['abierta|canindo']).toBe(true);
    expect(comp.resaltado()).toBe('06|X-D-26|0000547|0011');
    expect(comp.avisoBuscado()).toContain('reposición abierta de Zona Canindo');
  });

  it('detenido sin renglones que pagar: dice por qué no entra, sin desplegar nada', () => {
    const { comp } = conHojas({ abiertas: [abierta({ renglones: [], detenidos: [{ ...R('0000547'), motivo: 'espera su aprobación' }] })], cerradas: [] });
    comp.abrirEn('06|X-D-26|0000547|0011');
    expect(comp.avisoBuscado()).toContain('espera su aprobación');
    expect(comp.resaltado()).toBeNull();
  });

  it('sin depósito: dice que no se repone aquí y por qué', () => {
    const { comp } = conHojas({ abiertas: [abierta({ renglones: [], sin_deposito: [{ ...R('0000547'), motivo: 'el banco lo cubre sin depósito' }] })], cerradas: [] });
    comp.abrirEn('06|X-D-26|0000547|0011');
    expect(comp.avisoBuscado()).toContain('no se repone aquí: el banco lo cubre sin depósito');
  });

  it('⛔ [negativa] un pago que no está en ninguna hoja lo dice; no inventa una zona', () => {
    const { comp } = conHojas({ abiertas: [abierta()], cerradas: [] });
    comp.abrirEn('06|X-D-26|0000999|0011');
    expect(comp.avisoBuscado()).toContain('no aparece en ninguna reposición');
    expect(comp.resaltado()).toBeNull();
  });

  it('⛔ [negativa] si las hojas no se pudieron leer, lo dice (no lo da por ausente)', () => {
    const m = montar(); m.api.hojasDeGastos.mockReturnValue(throwError(() => new Error('503')) as never);
    m.comp.abrirEn('06|X-D-26|0000547|0011');
    expect(m.comp.avisoBuscado()).toContain('No se pudieron leer las hojas');
  });

  it('CONTROL: abrir la ventana desde la barra no arrastra el aviso de una búsqueda vieja', () => {
    const { comp } = conHojas({ abiertas: [abierta()], cerradas: [] });
    comp.abrirEn('06|X-D-26|0000547|0011');
    comp.cerrarVentana();
    comp.abrirVentana();
    expect(comp.avisoBuscado()).toBeNull();
    expect(comp.resaltado()).toBeNull();
  });
});

// ── `[LE.6.36]` Control por hoja: arriba lo que se paga hoy, abajo el depósito de cada hoja pagada ─────────
//
// PM, 2026-11-19: «la interfaz de reposición es muy complicada para que el usuario lleve un control de
// reposiciones». El trabajo diario son DOS actos: pagar la hoja de cada zona y vigilar que llegue su depósito.
describe('[LE.6.36] Reposición · control por hoja', () => {
  const RENG = (folio: string, sucursal = '08', importe = 100) => ({ origen_ref: `${sucursal}|X-D-26|${folio}|0011`, sucursal, doc_tipo: 'X-D-26', folio,
    fecha_pago: '2026-11-17', fecha_captura: '2026-11-17', beneficiario: 'PROVEEDOR', clave: 'CB013', centro: '007', clase: 'proveedor' as const, importe });
  const ABIERTA = (zona: 'morelia' | 'canindo', nombre: string, renglones: Array<ReturnType<typeof RENG>>, extra: Partial<HojaAbierta> = {}): HojaAbierta => ({
    zona, nombre, desde: '2026-10-12', renglones, total: Math.round(renglones.reduce((t, r) => t + r.importe, 0) * 100) / 100,
    por_sucursal: [], por_clase: [], fuera: [], pagados_aparte: [], instruccion: null, datos_al: null, pagado_en_control: [], control_medido: true,
    detenidos: [], retiros_que_cuadran: [], ya_repuestos: [], sin_deposito: [], banco: { cuenta: '1604', cargado_hasta: '2026-11-18' }, ...extra,
  });
  type Dep = NonNullable<HojaGastos['pago']>['deposito'];
  const VENCIDO: Dep = { estado: 'no_aparece', depositos: null, diferencia: null, vencido: true,
    nota: 'Morelia Madero ya capturó depósitos el 19/11 y éste no está: no hay un U-A-5 a la clave 1604 por el total (±$0.50) del 18/11 a siete días.' };
  const ESPERA: Dep = { estado: 'no_aparece', depositos: null, diferencia: null, vencido: false,
    nota: 'Kepler todavía no trae depósitos (U-A-5) de la zona capturados después del 17/11.' };
  const SIN_MEDIR: Dep = { estado: 'sin_medir', depositos: null, diferencia: null,
    nota: 'La clave de banco donde se deposita la reposición de esta zona no está medida.' };
  const DEPOSITADA = (folio: string): Dep => ({ estado: 'depositada', diferencia: 0, nota: null,
    depositos: [{ id: `06|U-A-5|${folio}|5854`, dia: '2026-11-14', importe: 950, folio, sucursal: '06', banco: '5854' }] });
  const HOJA = (numero: number, zona: 'morelia' | 'canindo', total: number, deposito: Dep | null, extra: Partial<HojaGastos> = {}): HojaGastos => ({
    id: `h${numero}`, numero, folio: `HG-${numero}`, zona, nombre_zona: zona === 'morelia' ? 'Zona Morelia' : 'Zona Canindo',
    venta_del_dia: '2026-11-17', estado: deposito ? 'pagada' : 'aprobada', total, renglones: [RENG(`00${numero}`)],
    por_sucursal: [{ sucursal: '08', renglones: 1, total }], cerrada_por: 'u-zona', cerrada_por_nombre: 'aaron', cerrada_at: '2026-11-17T18:00:00Z',
    aprobada_por: 'u-fin', aprobada_por_nombre: 'maria', aprobada_at: '2026-11-17T19:00:00Z', resuelta_por_nombre: null, resuelta_at: null, motivo: null,
    instruccion: { retiro: total, cajon: 0, deposito: total, referencia: `HG-${numero}` }, retiros_que_cuadran: [],
    pago: deposito ? { medio: 'caos', retiro: { device: 'AST700', external_id: numero, ref: 'gnf ma', total, dia: '2026-11-18' }, cajon: 0,
      pagada_por_nombre: 'carmen', pagada_at: '2026-11-18T20:00:00Z', sin_capturar: 0, deposito } : null,
    ...extra,
  });
  const HOJAS = (o: Partial<HojasDeGastos>): HojasDeGastos => ({ abiertas: [], cerradas: [], instalada: true, datos_al: null, caos_al: null, ...o });
  type M = ReturnType<typeof montar>;
  // El día de hoy fijo: «vencido · 1 día» no puede depender del reloj de quien corre la prueba.
  const conHoy = async (m: M) => { m.comp.hoy.set('2026-11-19'); await m.pinta(); return m; };
  const el = (m: M) => m.fixture.nativeElement as HTMLElement;
  const texto = (e: Element | null | undefined) => (e?.textContent ?? '').replace(/\s+/g, ' ').trim();
  const filasControl = (m: M) => [...el(m).querySelectorAll<HTMLElement>('[data-testid="rp-ctl-fila"]')];
  const foliosControl = (m: M) => filasControl(m).map((tr) => tr.getAttribute('data-hoja'));
  const botonCon = (m: M, t: string) => [...el(m).querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.includes(t)) ?? null;

  // Prod 19/11, recortado: hojas pagadas en sus tres estados (vencida, en espera, repuesta).
  const HG27 = HOJA(27, 'morelia', 65962.36, ESPERA);
  const HG26 = HOJA(26, 'morelia', 250, VENCIDO);
  const HG24 = HOJA(24, 'morelia', 137749.7, VENCIDO);
  const HG22 = HOJA(22, 'canindo', 950, DEPOSITADA('0000412'));
  const PAGADAS = [HG27, HG26, HG24, HG22];

  it('⭐ «Por pagar hoy»: una fila por zona con renglones, cada una con su botón, y el total en la tira', async () => {
    const m = await conHoy(montar(undefined, { hojas: HOJAS({
      abiertas: [ABIERTA('morelia', 'Zona Morelia', [RENG('1'), RENG('2', '07', 65862.36)]), ABIERTA('canindo', 'Zona Canindo', [RENG('3', '06', 3405)]),
        ABIERTA('canindo', 'Zona Vacía', [])],
      cerradas: PAGADAS,
    }) }));
    const filas = [...el(m).querySelectorAll<HTMLElement>('[data-testid="rp-por-pagar"] [data-testid="rp-pagar-fila"]')];
    expect(filas.map((f) => texto(f.querySelector('[data-label="Zona"]')))).toEqual(['Zona Morelia', 'Zona Canindo']);
    expect(texto(filas[0])).toContain('2 pagos');
    expect(texto(filas[0])).toContain('$65,962.36');
    expect(filas[0].querySelector('button')?.getAttribute('aria-expanded')).toBe('false');
    expect(botonCon(m, 'Pagar Zona Morelia')).not.toBeNull();
    expect(botonCon(m, 'Pagar Zona Canindo')).not.toBeNull();
    expect(texto(el(m).querySelector('[data-testid="rp-total-pagar"]'))).toBe('$69,367.36');
    expect(m.comp.kpis()[0]).toMatchObject({ label: 'Por pagar hoy', value: 69367.36 });
    // Lo pagado no está arriba: arriba sólo se paga.
    expect(texto(el(m).querySelector('[data-testid="rp-por-pagar"]'))).not.toContain('HG-27');
  });

  it('la hoja aprobada del carril viejo también es «por pagar», con su botón; la que ya salió no suma al total', async () => {
    const aprobada = HOJA(3, 'morelia', 1000, null);
    const base = HOJA(5, 'morelia', 500, ESPERA);
    const sinCapturar = { ...base, pago: { ...base.pago!, sin_capturar: 2 } };
    const m = await conHoy(montar(undefined, { hojas: HOJAS({ cerradas: [aprobada, sinCapturar] }) }));
    expect(botonCon(m, 'Pagar HG-3')).not.toBeNull();
    expect(botonCon(m, 'Capturar lo que falta (2)')).not.toBeNull();
    expect(texto(el(m).querySelector('[data-testid="rp-total-pagar"]'))).toBe('$1,000.00');
  });

  it('⭐ «Esperan depósito» (abre ahí): lo vencido primero, sin las depositadas, y la etiqueta corta dice cuántos días', async () => {
    const m = await conHoy(montar(undefined, { hojas: HOJAS({ cerradas: PAGADAS }) }));
    expect(m.comp.vista()).toBe('deposito');
    expect(foliosControl(m)).toEqual(['HG-26', 'HG-24', 'HG-27']);
    const dep = filasControl(m).map((tr) => texto(tr.querySelector('[data-testid="rp-deposito"]')));
    expect(dep[0]).toBe('vencido · 1 día');
    expect(dep[2]).toBe('esperando · día 1 de 7');
    // La etiqueta es corta (≤ 8 palabras): la nota larga NO está en la fila.
    for (const d of dep) expect(d.split(' ').filter((w) => w !== '·').length).toBeLessThanOrEqual(8);
    expect(texto(filasControl(m)[0])).not.toContain('ya capturó depósitos');
    // Palabra + icono, no sólo color.
    expect(filasControl(m)[0].querySelector('[data-testid="rp-deposito"] .pi-times-circle')).not.toBeNull();
    const k = m.comp.kpis()[1];
    expect(k).toMatchObject({ label: 'Esperan depósito', value: 203962.06, tone: 'bad' });
    expect(k.sub).toBe('3 hojas · 2 vencidas');
  });

  it('el renglón abierto dice en UNA línea qué falta y quién; la nota larga va plegada en «Lo que se buscó»', async () => {
    const m = await conHoy(montar(undefined, { hojas: HOJAS({ cerradas: PAGADAS }) }));
    m.comp.alternar('ctl|h26');
    await m.pinta();
    expect(filasControl(m)[0].querySelector('button')?.getAttribute('aria-expanded')).toBe('true');
    expect(texto(el(m).querySelector('[data-testid="rp-que-falta"]'))).toBe('Falta su depósito de $250.00: lo deposita y lo captura Morelia Abastos o Morelia Madero.');
    const nota = el(m).querySelector('[data-testid="rp-falta-deposito"]');
    expect(nota?.closest('details'), 'la nota larga no está plegada').not.toBeNull();
    expect(texto(nota)).toContain('Depósito vencido: Morelia Madero ya capturó depósitos el 19/11');
    // Con qué se pagó: el retiro de CAOS.
    expect(texto(el(m).querySelector('.rp-det .rp-pagado'))).toContain('«gnf ma» del 18/11');
  });

  it('«Repuestas» trae sólo las depositadas, con su folio U-A-5', async () => {
    const m = await conHoy(montar(undefined, { hojas: HOJAS({ cerradas: PAGADAS }) }));
    m.comp.vista.set('repuestas');
    await m.pinta();
    expect(foliosControl(m)).toEqual(['HG-22']);
    expect(texto(filasControl(m)[0].querySelector('[data-testid="rp-deposito"]'))).toBe('U-A-5 0000412');
  });

  it('⭐ los conteos de los filtros cuadran con las listas («Todas» es cada hoja del servidor, lo vencido primero)', async () => {
    const aprobada = HOJA(28, 'morelia', 10, null);
    const m = await conHoy(montar(undefined, { hojas: HOJAS({ cerradas: [aprobada, ...PAGADAS] }) }));
    const cuenta: Record<string, number> = {};
    for (const v of ['deposito', 'repuestas', 'todas'] as const) {
      m.comp.vista.set(v);
      await m.pinta();
      cuenta[v] = filasControl(m).length;
    }
    expect(cuenta).toEqual({ deposito: 3, repuestas: 1, todas: 5 });
    expect(m.comp.opcionesVista().map((o) => o.count)).toEqual([3, 1, 5]);
    const seg = [...el(m).querySelectorAll('.seg-btn')].map((b) => texto(b));
    expect(seg).toEqual(['Esperan depósito 3', 'Repuestas 1', 'Todas 5']);
    expect(foliosControl(m).slice(0, 2)).toEqual(['HG-26', 'HG-24']);
    expect(m.comp.kpis()[2]).toMatchObject({ label: 'Repuestas', value: 1 });
  });

  it('⛔ una hoja con la cuenta sin medir no dice «vencido» ni «$0»; la zona se dice UNA vez junto al filtro', async () => {
    const a = HOJA(25, 'canindo', 3405, SIN_MEDIR);
    const b = HOJA(23, 'canindo', 1200, SIN_MEDIR);
    const m = await conHoy(montar(undefined, { hojas: HOJAS({ cerradas: [a, b] }) }));
    expect(foliosControl(m)).toEqual(['HG-25', 'HG-23']);
    for (const tr of filasControl(m)) {
      expect(texto(tr.querySelector('[data-testid="rp-deposito"]'))).toBe('cuenta sin medir');
      expect(texto(tr)).not.toMatch(/vencid/i);
      expect(texto(tr)).not.toContain('$0.00');
    }
    const notas = el(m).querySelectorAll('[data-testid="rp-cuenta-sin-medir"]');
    expect(notas.length).toBe(1);
    expect(texto(notas[0])).toContain('Zona Canindo');
    expect(m.comp.kpis()[1].tone, 'sin medir no es incidencia').not.toBe('bad');
  });

  it('⛔ si las hojas no se pudieron leer se dice en los dos bloques, sin «nada por pagar» ni cifras en cero', async () => {
    const m = montar();
    m.api.hojasDeGastos.mockReturnValue(throwError(() => ({ status: 503 })) as never);
    m.comp.cargar();
    await m.pinta();
    expect(texto(el(m).querySelector('[data-testid="rp-por-pagar"]'))).toContain('Las hojas de zona no se pudieron leer');
    expect(texto(el(m).querySelector('[data-testid="rp-control"]'))).toContain('Las hojas de zona no se pudieron leer');
    expect(texto(el(m))).not.toContain('Nada por pagar hoy');
    expect(m.comp.opcionesVista().every((o) => o.count === undefined)).toBe(true);
    expect(m.comp.kpis().every((k) => k.state === 'no_medido' && typeof k.value === 'string')).toBe(true);
    expect(texto(el(m).querySelector('.rp-kpis'))).not.toContain('$0.00');
  });

  // `[CGA-A.61]` La reposición POR SUCURSAL no se borra: va al final, con sus acciones.
  const grupo = (clave: string, estado: ReposicionGrupo['estado']): ReposicionGrupo => ({
    clave, fecha: '2026-11-18', sucursal: '03', docs: [{ origen_ref: `03|X-D-26|${clave}|0011`, sucursal: '03', doc_tipo: 'X-D-26', folio: clave,
      fecha_valor: '2026-11-18', fecha_captura: '2026-11-18', beneficiario: 'GASTOS', monto: 100, clase: 'gasto', en_kepler: true, ledger_id: null,
      cg_folio: null, origen_efectivo: null, enlazado: 0, falta: 100, estado: estado === 'por_capturar' ? 'por_capturar' : 'sin_vincular', vinculos: [],
      aprobacion: null } as unknown as ReposicionDoc],
    total: 100, por_capturar: estado === 'por_capturar' ? 100 : 0, n_por_capturar: estado === 'por_capturar' ? 1 : 0, caos: 0, cajon: 0,
    sin_vincular: estado === 'sin_vincular' ? 100 : 0, n_sin_vincular: estado === 'sin_vincular' ? 1 : 0, n_sin_aprobar: 0, n_pagado_antes_de_aprobar: 0,
    estado, propuesta: null, retiro_sugerido: null, por_hoja: false,
  });
  const REPO = (grupos: ReposicionGrupo[]): ReposicionSucursales => ({ desde: '2026-11-13', hasta: '2026-11-19', grupos,
    retiros: [{ device: 'AST700', external_id: 77, ref: 'gnf ca', dia: '2026-11-18', libre: 500 }] as unknown as ReposicionSucursales['retiros'],
    datos_al: '2026-11-19T15:00:00Z', caos_al: '2026-11-19T15:00:00Z', universo: { sucursales: [], sin_documentos: [], excluidas: [] } });

  it('⭐ las reposiciones por sucursal siguen con su acción («Reponer»), abiertas al final porque hay algo que resolver', async () => {
    const m = await conHoy(montar(undefined, { hojas: HOJAS({}), reposicion: REPO([grupo('0000901', 'por_capturar')]) }));
    const otras = el(m).querySelector<HTMLDetailsElement>('[data-testid="rp-otras"]')!;
    expect(otras.open).toBe(true);
    expect(texto(otras.querySelector('summary'))).toContain('1 por resolver');
    m.comp.elegir(m.comp.grupos()[0], 'AST700|77');
    await m.pinta();
    const reponer = [...otras.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.includes('Reponer 1'));
    expect(reponer, 'la sucursal perdió su «Reponer»').not.toBeUndefined();
    reponer!.click();
    expect(m.api.confirmarLote).toHaveBeenCalledWith([{ origen_ref: '03|X-D-26|0000901|0011' }], { device: 'AST700', external_id: 77 }, null);
  });

  it('[control] sin nada que se resuelva en la fila, «Otras sucursales» queda plegada pero sus renglones siguen ahí', async () => {
    const m = await conHoy(montar(undefined, { hojas: HOJAS({}), reposicion: REPO([grupo('0000902', 'sin_vincular')]) }));
    const otras = el(m).querySelector<HTMLDetailsElement>('[data-testid="rp-otras"]')!;
    expect(otras.open).toBe(false);
    expect(texto(otras.querySelector('summary'))).toContain('1 sin retiro');
    expect(otras.querySelectorAll('.rp-tbl tbody tr').length).toBe(1);
  });

  it('[LE.6.35] un pago de una hoja YA pagada lleva al control: pone el filtro donde está, abre la hoja y resalta el renglón', async () => {
    const m = montar();
    m.api.hojasDeGastos.mockReturnValue(of(HOJAS({ cerradas: PAGADAS })) as never);
    m.comp.vista.set('repuestas');
    m.comp.abrirEn(HG24.renglones[0].origen_ref);
    await m.pinta();
    expect(m.comp.vista()).toBe('deposito');
    expect(m.comp.abiertas()['ctl|h24']).toBe(true);
    expect(m.comp.resaltado()).toBe(HG24.renglones[0].origen_ref);
    expect(el(m).querySelector(`.rp-buscado[data-rp-ref="${HG24.renglones[0].origen_ref}"]`)).not.toBeNull();
    expect(m.comp.avisoBuscado()).toContain('HG-24');
  });

  it('[LE.6.35] un pago de la hoja abierta queda en «Por pagar hoy» sin tocar el filtro del control', async () => {
    const m = montar();
    const ref = '08|X-D-26|1|0011';
    m.api.hojasDeGastos.mockReturnValue(of(HOJAS({ abiertas: [ABIERTA('morelia', 'Zona Morelia', [RENG('1')])], cerradas: PAGADAS })) as never);
    m.comp.vista.set('repuestas');
    m.comp.abrirEn(ref);
    await m.pinta();
    expect(m.comp.vista()).toBe('repuestas');
    expect(m.comp.abiertas()['abierta|morelia']).toBe(true);
    expect(el(m).querySelector(`[data-testid="rp-por-pagar"] .rp-buscado[data-rp-ref="${ref}"]`)).not.toBeNull();
  });
});
