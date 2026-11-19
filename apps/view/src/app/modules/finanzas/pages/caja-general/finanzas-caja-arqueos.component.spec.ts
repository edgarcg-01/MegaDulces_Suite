import { TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { provideRouter } from '@angular/router';
import { NEVER, of } from 'rxjs';
import type { ArqueoDia, ArqueoGuardadoDto } from '@megadulces/contracts';
import { FinanzasCajaArqueosComponent } from './finanzas-caja-arqueos.component';
import { CashLedgerService } from '../../cash-ledger.service';
import { CaosService } from '../../caos.service';
import { CajaSocketService } from '../../caja-socket.service';
import { CaosSocketService } from '../../caos-socket.service';
import { AuthService } from '../../../../core/services/auth.service';
import { PermissionsService } from '../../../../core/services/permissions.service';

/**
 * `[LE.6.34]` Auditoría del 2026-11-18: la ventana del arqueo (y del recuento a ciegas) se cerraba con
 * Esc, la X o «Cancelar» sin preguntar, y al reabrirla las piezas volvían a cero. Aquí se monta Arqueos
 * con sus fuentes sustituidas y se usa la ventana como la usaría quien cuenta.
 */
class ResizeObserverStub { observe(): void { /* no-op */ } unobserve(): void { /* no-op */ } disconnect(): void { /* no-op */ } }
(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= ResizeObserverStub;

const GUARDADO = {
  arqueo: { efectivo: 2000, total_mxn: 2000 }, contra_corte: null, documentos: null,
} as unknown as ArqueoGuardadoDto;

function montar() {
  const cajas = {
    arqueoDia: vi.fn(() => NEVER), arqueosCaja: vi.fn(() => NEVER), autorizarCorte: vi.fn(() => NEVER), candado: vi.fn(() => NEVER),
    darLlave: vi.fn(() => NEVER), documentosEnCaja: vi.fn(() => NEVER), fondoSugerido: vi.fn(() => NEVER),
    observarCorte: vi.fn(() => NEVER), posicion: vi.fn(() => NEVER), saldo: vi.fn(() => NEVER),
    registrarArqueoCaja: vi.fn(() => of(GUARDADO)),
  };
  const sock = () => ({ connect: vi.fn(), disconnect: vi.fn(), change$: NEVER });
  TestBed.configureTestingModule({
    imports: [FinanzasCajaArqueosComponent],
    providers: [
      provideZonelessChangeDetection(), provideRouter([]), provideHttpClient(), provideHttpClientTesting(),
      { provide: CashLedgerService, useValue: cajas },
      { provide: CaosService, useValue: { saldo: vi.fn(() => NEVER) } },
      { provide: CajaSocketService, useValue: sock() },
      { provide: CaosSocketService, useValue: sock() },
      { provide: AuthService, useValue: { user: () => ({ sub: 'u1' }), token: () => null } },
      { provide: PermissionsService, useValue: { has: () => true, hasAny: () => true, hasExplicit: () => false, isAdmin: () => false,
        isSuperadmin: () => false, cargado: () => true } },
    ],
  });
  const fixture = TestBed.createComponent(FinanzasCajaArqueosComponent);
  fixture.detectChanges();
  const comp = fixture.componentInstance;
  const pinta = async () => { fixture.detectChanges(); await fixture.whenStable(); fixture.detectChanges(); };
  const boton = (testid: string) => document.body.querySelector<HTMLButtonElement>(`[data-testid="${testid}"] button, button[data-testid="${testid}"]`);
  return { fixture, comp, cajas, pinta, boton };
}

const CORTE = { corte_id: 'c-1', folio: 'CC-9', fecha: '2026-11-17' } as unknown as ArqueoDia;

describe('[LE.6.34] Arqueos · lo contado no se pierde sin preguntar', () => {
  it('con piezas, «Cancelar» pregunta y la ventana sigue abierta; sin la X ni Esc mientras está sucia', async () => {
    const m = montar();
    m.comp.abrirArqueo('intermedio', null);
    await m.pinta();
    m.comp.ponerPieza(m.comp.BILLETES[0].key, 2);
    await m.pinta();
    expect(m.comp.arqSucio()).toBe(true);
    expect(m.comp.arqTrabado()).toBe(true);
    // PrimeNG no pinta su X cuando closable es falso.
    expect(document.body.querySelector('.p-dialog [aria-label="Cerrar"]')).toBeNull();

    m.boton('dc-cancelar')!.click();
    await m.pinta();
    expect(m.comp.arqDlg()).not.toBeNull();
    expect(document.body.querySelector('[data-testid="dc-pregunta"]')?.textContent).toContain('¿Descartar?');

    // Confirmar el descarte sí cierra y tira lo contado.
    m.boton('dc-descartar')!.click();
    await m.pinta();
    expect(m.comp.arqDlg()).toBeNull();
    expect(m.comp.arqPiezas()).toEqual({});
  });

  it('un 0 tecleado también cuenta como contado (dice «no hay», no «no se contó»)', async () => {
    const m = montar();
    m.comp.abrirArqueo('intermedio', null);
    m.comp.ponerPieza(m.comp.MONEDAS[0].key, 0);
    await m.pinta();
    expect(m.comp.arqSucio()).toBe(true);
  });

  it('[control] sin nada tecleado, «Cancelar» cierra directo, sin pregunta', async () => {
    const m = montar();
    m.comp.abrirArqueo('intermedio', null);
    await m.pinta();
    expect(m.comp.arqSucio()).toBe(false);
    // El control de la prueba de arriba: limpia, la X sí está (si no, «no hay X» no probaría nada).
    expect(document.body.querySelector('.p-dialog [aria-label="Cerrar"]')).not.toBeNull();
    m.boton('dc-cancelar')!.click();
    await m.pinta();
    expect(m.comp.arqDlg()).toBeNull();
    expect(document.body.querySelector('[data-testid="dc-pregunta"]')).toBeNull();
  });

  it('reabrir el MISMO arqueo sin guardar conserva lo contado; otro arqueo empieza de cero', async () => {
    const m = montar();
    m.comp.abrirArqueo('recuento', CORTE);
    m.comp.ponerPieza(m.comp.BILLETES[0].key, 3);
    m.comp.arqNota.set('faltó contar la bolsa');
    await m.pinta();
    m.comp.cerrarArqueo();
    await m.pinta();
    m.comp.abrirArqueo('recuento', CORTE);
    await m.pinta();
    expect(m.comp.arqPiezas()[m.comp.BILLETES[0].key]).toBe(3);
    expect(m.comp.arqNota()).toBe('faltó contar la bolsa');

    m.comp.cerrarArqueo();
    m.comp.abrirArqueo('intermedio', null);
    await m.pinta();
    expect(m.comp.arqPiezas()).toEqual({});
    expect(m.comp.arqNota()).toBe('');
  });

  it('después de guardar, el resultado se anuncia (role="status") y el foco cae en «Listo»; reabrir empieza de cero', async () => {
    const m = montar();
    m.comp.abrirArqueo('intermedio', null);
    m.comp.ponerPieza(m.comp.BILLETES[0].key, 2);
    await m.pinta();
    m.comp.guardarArqueo();
    await m.pinta();
    expect(m.cajas.registrarArqueoCaja).toHaveBeenCalledTimes(1);
    const resultado = document.body.querySelector('[data-testid="arq-resultado"]');
    expect(resultado?.getAttribute('role')).toBe('status');
    expect(resultado?.textContent).toContain('Contaste');
    expect(document.activeElement).toBe(m.boton('arq-listo'));
    // Ya guardado no está sucio: «Listo» cierra.
    expect(m.comp.arqSucio()).toBe(false);
    m.boton('arq-listo')!.click();
    await m.pinta();
    expect(m.comp.arqDlg()).toBeNull();
    m.comp.abrirArqueo('intermedio', null);
    expect(m.comp.arqPiezas()).toEqual({});
  });
});
