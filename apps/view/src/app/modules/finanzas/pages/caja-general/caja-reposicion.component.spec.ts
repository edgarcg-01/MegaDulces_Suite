import { describe, expect, it, vi } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { provideRouter } from '@angular/router';
import { MessageService } from 'primeng/api';
import { NEVER, Subject, of, throwError, type Observable } from 'rxjs';
import type { HojaGastos, PagoHojaResultado, ReposicionDoc, ReposicionVinculo } from '@megadulces/contracts';
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

function montar(pago: () => Observable<PagoHojaResultado> = () => NEVER) {
  const api = {
    reposicion: vi.fn(() => NEVER), hojasDeGastos: vi.fn(() => NEVER),
    pagarHojaDeGastos: vi.fn(pago), pagarHojaAbierta: vi.fn(() => NEVER), capturarHojaDeGastos: vi.fn(() => NEVER),
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
