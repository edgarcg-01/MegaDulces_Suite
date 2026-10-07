import { ComponentFixture, TestBed } from '@angular/core/testing';
import { AndenEnCursoComponent } from './anden-en-curso.component';
import { AndenValeEnCurso } from '../../receiving-session.service';

/**
 * `[WMS-REC.17]` — **los vales a medias, para cambiar de camión.**
 *
 * Lo que se cuida: que un vale abierto se pueda RETOMAR (el botón sirve y emite el vale
 * correcto), que diga cuánto le falta, y que la lista no ocupe lugar cuando no hay nada —
 * pero que un ERROR no se lea como "no hay nada a medias".
 */
function vale(extra: Partial<AndenValeEnCurso> = {}): AndenValeEnCurso {
  return {
    id: '11111111-1111-1111-1111-111111111111',
    folio: 'VE-2026-00013',
    source_kind: 'erp_transfer',
    documento: 'Embarque 06-2-0001048',
    warehouse_id: '22222222-2222-2222-2222-222222222222',
    warehouse_code: '01',
    warehouse_name: 'Padre Hidalgo',
    origin: { kind: 'transfer', isCedis: false, label: 'Traspaso', name: 'Canindo' },
    renglones: 3,
    por_fechar: 2,
    abierto_por: 'Juan Pérez',
    created_at: '2026-10-06T18:41:43.352Z',
    ...extra,
  };
}

describe('AndenEnCursoComponent', () => {
  let fixture: ComponentFixture<AndenEnCursoComponent>;
  const el = () => fixture.nativeElement as HTMLElement;
  const filas = () => Array.from(el().querySelectorAll<HTMLButtonElement>('button.ec-row'));

  beforeEach(async () => {
    await TestBed.configureTestingModule({ imports: [AndenEnCursoComponent] }).compileComponents();
    fixture = TestBed.createComponent(AndenEnCursoComponent);
  });

  it('sin vales a medias no ocupa ni un renglón', () => {
    fixture.componentRef.setInput('vales', []);
    fixture.detectChanges();
    expect(el().querySelector('.ec')).toBeNull();
    expect(el().textContent?.trim()).toBe('');
  });

  it('cada vale dice folio, de dónde viene, a qué almacén y cuánto le falta', () => {
    fixture.componentRef.setInput('vales', [vale()]);
    fixture.detectChanges();
    const t = filas()[0].textContent || '';
    expect(t).toContain('VE-2026-00013');
    expect(t).toContain('Traspaso');
    expect(t).toContain('Canindo');
    expect(t).toContain('01');
    expect(t).toContain('faltan 2');
    expect(t).toContain('Juan Pérez');
  });

  it('un vale ya fechado entero lo dice, en vez de "faltan 0"', () => {
    fixture.componentRef.setInput('vales', [vale({ por_fechar: 0 })]);
    fixture.detectChanges();
    const t = filas()[0].textContent || '';
    expect(t).toContain('todo fechado');
    expect(t).not.toContain('faltan 0');
  });

  it('tocar un vale lo emite para retomarlo', () => {
    const v = vale();
    fixture.componentRef.setInput('vales', [v, vale({ id: '33333333-3333-3333-3333-333333333333', folio: 'VE-2026-00014' })]);
    fixture.detectChanges();
    const emitidos: AndenValeEnCurso[] = [];
    fixture.componentInstance.retomar.subscribe((x) => emitidos.push(x));
    filas()[1].click();
    expect(emitidos.map((x) => x.folio)).toEqual(['VE-2026-00014']);
  });

  it('mientras se abre uno, no se puede tocar otro (dos toques = dos cargas cruzadas)', () => {
    fixture.componentRef.setInput('vales', [vale()]);
    fixture.componentRef.setInput('abriendo', true);
    fixture.detectChanges();
    expect(filas()[0].disabled).toBe(true);
  });

  it('una compra lleva el chip neutro; un traspaso, el ámbar', () => {
    fixture.componentRef.setInput('vales', [
      vale(),
      vale({
        id: '44444444-4444-4444-4444-444444444444', source_kind: 'erp_receipt', documento: '01/0000412',
        origin: { kind: 'supplier', isCedis: false, label: 'Proveedor', name: null },
      }),
    ]);
    fixture.detectChanges();
    const chips = Array.from(el().querySelectorAll('.ec-chip'));
    expect(chips[0].classList.contains('ec-tr')).toBe(true);
    expect(chips[1].classList.contains('ec-tr')).toBe(false);
    // Sin nombre de proveedor se muestra el documento de Kepler, no un hueco.
    expect(filas()[1].textContent).toContain('01/0000412');
  });

  it('si la lista no se pudo leer se DICE: no es lo mismo que no tener nada a medias', () => {
    fixture.componentRef.setInput('vales', []);
    fixture.componentRef.setInput('error', 'Tu sesión expiró.');
    fixture.detectChanges();
    expect(el().textContent).toContain('No se pudieron leer los vales incompletos');
    expect(el().textContent).toContain('Tu sesión expiró.');
  });
});
