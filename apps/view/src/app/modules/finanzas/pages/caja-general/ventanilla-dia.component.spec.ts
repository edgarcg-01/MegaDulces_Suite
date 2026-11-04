import { TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { of } from 'rxjs';
import type { SaldosDelLibro } from '@megadulces/contracts';
import { VentanillaDiaComponent } from './ventanilla-dia.component';
import { LibroEfectivoService } from '../../libro-efectivo.service';
import { PermissionsService } from '../../../../core/services/permissions.service';
import { Permission } from '../../../../core/constants/permissions';
import { todayMx } from '../../../../core/utils/mx-date';

/**
 * `[LE.6.3]` `[LE.6.4]` `[LE.6.6]` «Tu día», montado y usado: qué día está abierto (y si es viejo,
 * primero eso), el saldo de arranque, el conteo ciego, el arqueo sorpresa con testigo y la firma.
 */
const saldos = (jornada: string | null, cajaSeq = '12'): SaldosDelLibro => ({
  cuentas: [{ code: 'CAJA_MXN', name: 'Caja', class: 'fisica', currency: 'MXN', balance_minor: '50000', last_seq: cajaSeq }],
  ultimo_asiento: '12', jornada_abierta: jornada, integridad: { integra: true, problemas: [] },
});

function montar(o: { jornada?: string | null; cajaSeq?: string; autorizar?: boolean } = {}) {
  const libro = {
    saldos: vi.fn(() => of(saldos(o.jornada === undefined ? todayMx() : o.jornada, o.cajaSeq))),
    hallazgos: vi.fn(() => of([{ id: 'h1', source: 'arqueo', account_code: 'CAJA_MXN', business_date: null, amount_minor: '-5000', detail: null,
      owner_user: null, opened_at: '2026-11-04T10:00:00Z', dias_abierto: 2 }])),
    solicitudes: vi.fn(() => of([{ id: 's1', event_kind: 'apertura', gross_minor: '50000', registered_by: 'u1', created_at: '2026-11-04T10:00:00Z',
      expires_at: '2026-11-07T10:00:00Z', payload: null }])),
    abrirJornada: vi.fn(() => of(undefined)),
    cerrarJornada: vi.fn(() => of({ cerro: 'u1', autorizo: 'u2' })),
    contar: vi.fn(() => of({ ciego: false as const, count_id: 'c1', total_minor: '45000', esperado_minor: '50000', diferencia_minor: '-5000', hallazgo_id: 'h2' })),
    registrarHecho: vi.fn(() => of({ estado: 'por_autorizar' as const, request_id: 'r1', motivo: 'apertura: siempre lo autoriza otra persona' })),
    autorizar: vi.fn(() => of({ entry_id: 'e1' })),
    rechazar: vi.fn(() => of(undefined)),
  };
  TestBed.configureTestingModule({
    imports: [VentanillaDiaComponent],
    providers: [
      provideZonelessChangeDetection(),
      { provide: LibroEfectivoService, useValue: libro },
      { provide: PermissionsService, useValue: { has: (p: string) => p === Permission.FINANCE_CAJA_GESTIONAR || (o.autorizar === true && p === Permission.FINANCE_CAJA_AUTORIZAR) } },
    ],
  });
  const fixture = TestBed.createComponent(VentanillaDiaComponent);
  fixture.detectChanges();
  return { fixture, comp: fixture.componentInstance, libro, el: fixture.nativeElement as HTMLElement };
}

describe('[LE.6.4] Tu día', () => {
  it('un día viejo abierto se dice primero: se cierra antes de operar hoy', () => {
    const { el } = montar({ jornada: '2026-10-27' });
    expect(el.querySelector('[data-testid="dia-estado"]')?.textContent).toContain('no hoy');
  });

  it('sin día abierto: abrir el día de hoy', () => {
    const { comp, libro, el } = montar({ jornada: null });
    expect(el.textContent).toContain('No hay día abierto');
    comp.abrirDia();
    expect(libro.abrirJornada).toHaveBeenCalledWith(todayMx());
  });

  it('el saldo de arranque sólo si el cajón nunca tuvo un asiento, y lo firma Tesorería', () => {
    const { comp, libro, el } = montar({ cajaSeq: '0' });
    expect(el.textContent).toContain('Saldo de arranque');
    comp.abrirConteo('arranque');
    comp.piezas.set({ 500: 1 });
    comp.registrarConteo();
    expect(libro.registrarHecho).toHaveBeenCalledWith({ tipo: 'apertura', moneda: 'MXN', fecha: todayMx(), conteos: [{ cuenta: 'CAJA_MXN', piezas: { 500: '1' } }] },
      expect.stringMatching(/^[0-9a-f-]{36}$/));
  });

  it('contar para cerrar: ciego por pieza; la diferencia se dice después y queda un hallazgo', () => {
    const { fixture, comp, libro } = montar();
    comp.abrirConteo('cierre');
    expect(comp.listoParaContar()).toBe(false);
    comp.piezas.set({ 200: 2, 50: 1 });
    comp.registrarConteo();
    fixture.detectChanges();
    expect(libro.contar).toHaveBeenCalledWith(expect.objectContaining({ cuenta: 'CAJA_MXN', tipo: 'cierre', piezas: { 200: '2', 50: '1' } }));
    expect(document.body.querySelector('[data-testid="resultado-conteo"]')?.textContent).toContain('quedó un hallazgo');
  });

  it('NEGATIVA: el arqueo sorpresa no se registra sin testigo', () => {
    const { comp, libro } = montar();
    comp.abrirConteo('sorpresa');
    comp.piezas.set({ 500: 1 });
    expect(comp.listoParaContar()).toBe(false);
    comp.registrarConteo();
    expect(libro.contar).not.toHaveBeenCalled();
    comp.testigo.set('Contabilidad');
    expect(comp.listoParaContar()).toBe(true);
  });

  it('cerrar y firmar sólo con AUTORIZAR; rechazar pide su motivo', () => {
    const sin = montar();
    expect(sin.el.textContent).not.toContain('Cerrar el día');
    TestBed.resetTestingModule();
    const { comp, libro, el } = montar({ autorizar: true });
    expect(el.textContent).toContain('Cerrar el día');
    comp.cerrarDia();
    expect(libro.cerrarJornada).toHaveBeenCalledWith(todayMx());
    comp.rechazar('s1');
    expect(libro.rechazar).not.toHaveBeenCalled();         // sin motivo, no
    comp.nota.set('no cuadra con el conteo');
    comp.rechazar('s1');
    expect(libro.rechazar).toHaveBeenCalledWith('s1', 'no cuadra con el conteo');
    comp.firmar('s1');
    expect(libro.autorizar).toHaveBeenCalledWith('s1');
  });
});
