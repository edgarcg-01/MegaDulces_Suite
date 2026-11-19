import { ComponentFixture, TestBed } from '@angular/core/testing';
import { of, throwError } from 'rxjs';
import { vi } from 'vitest';
import type { HrNombrePorConfirmarDto } from '@megadulces/contracts';
import { RhService } from '../rh.service';
import { RhNombresPorConfirmarComponent } from './rh-nombres-por-confirmar.component';

/**
 * `[RH.14.4]` Nombres por confirmar. Lo que se defiende: la lista abre con la plaza en pantalla; guardar manda el nombre por
 * su primera plaza y, si se pidió, a los relojes de TODAS sus plazas; ⛔ si el reloj falla, el nombre no se deshace y se
 * dice; ⛔ con una sola palabra no se puede guardar.
 */
const fila = (o: Partial<HrNombrePorConfirmarDto> = {}): HrNombrePorConfirmarDto => ({
  user_id: 'u-1', nombre: 'Claudia', motivo: 'apodo_del_reloj', nombre_reloj: 'CLAUDIA',
  plazas: [{ site_code: 'PH', site_name: 'Sucursal PH', person_code: '1' }, { site_code: 'ZC', site_name: 'Zamora Canindo', person_code: '8' }],
  visto_en_reloj: null, ...o,
});

describe('[RH.14.4] RhNombresPorConfirmarComponent', () => {
  let fix: ComponentFixture<RhNombresPorConfirmarComponent>;
  let api: Record<string, ReturnType<typeof vi.fn>>;

  async function render(o: { filas: HrNombrePorConfirmarDto[]; renombrar?: ReturnType<typeof vi.fn> }) {
    api = {
      nombresPorConfirmar: vi.fn(() => of({ filas: o.filas, total: o.filas.length })),
      editarFicha: vi.fn(() => of({ site_code: 'PH', person_code: '1', seccion: null, promotora: false, nombre: 'Claudia Pérez Ruiz' })),
      renombrar: o.renombrar ?? vi.fn(() => of({ ok: true, nombre: 'CLAUDIA PEREZ RUIZ', relojes: 1 })),
    };
    await TestBed.configureTestingModule({ imports: [RhNombresPorConfirmarComponent], providers: [{ provide: RhService, useValue: api }] }).compileComponents();
    fix = TestBed.createComponent(RhNombresPorConfirmarComponent);
    fix.componentRef.setInput('sitio', 'PH');
    fix.componentRef.setInput('puedeEditar', true);
    fix.detectChanges();
    await fix.whenStable();
    fix.detectChanges();
  }

  afterEach(() => TestBed.resetTestingModule());

  it('abre con la plaza en pantalla; «Todas las plazas» quita el filtro', async () => {
    await render({ filas: [fila()] });
    expect(api['nombresPorConfirmar']).toHaveBeenLastCalledWith('PH');
    fix.componentInstance.todas.set(true);
    fix.detectChanges();
    expect(api['nombresPorConfirmar']).toHaveBeenLastCalledWith(null);
  });

  it('⭐ guarda por la primera plaza, manda a los relojes de todas, y sale de la lista', async () => {
    await render({ filas: [fila()] });
    const c = fix.componentInstance;
    const emitido = vi.fn();
    c.cambio.subscribe(emitido);
    const f = c.filas()![0];
    expect(c.renglon(f).nombre).toBe('');                    // el apodo no se copia al campo
    c.editar(f, { nombre: '  Claudia   Pérez Ruiz ' });
    await c.guardar(f);
    expect(api['editarFicha']).toHaveBeenCalledWith({ site_code: 'PH', person_code: '1', nombre: 'Claudia Pérez Ruiz' });
    expect(api['renombrar'].mock.calls).toEqual([['PH', '1', 'Claudia Pérez Ruiz'], ['ZC', '8', 'Claudia Pérez Ruiz']]);
    expect(c.filas()).toEqual([]);
    expect(c.aviso()?.mal).toBe(false);
    expect(emitido).toHaveBeenCalledTimes(1);
  });

  it('⛔ si el reloj falla, el nombre ya guardado no se deshace y se dice dónde falló', async () => {
    const renombrar = vi.fn((site: string) => (site === 'ZC' ? throwError(() => new Error('sin reloj')) : of({ ok: true, nombre: 'X', relojes: 1 })));
    await render({ filas: [fila()], renombrar });
    const c = fix.componentInstance;
    const f = c.filas()![0];
    c.editar(f, { nombre: 'Claudia Pérez Ruiz' });
    await c.guardar(f);
    expect(api['editarFicha']).toHaveBeenCalledTimes(1);
    expect(c.aviso()?.mal).toBe(true);
    expect(c.aviso()?.texto).toContain('Zamora Canindo');
  });

  it('⛔ con una sola palabra no se guarda; sin «También en el reloj» no se toca el reloj', async () => {
    await render({ filas: [fila()] });
    const c = fix.componentInstance;
    const f = c.filas()![0];
    c.editar(f, { nombre: 'Claudia' });
    await c.guardar(f);
    expect(api['editarFicha']).not.toHaveBeenCalled();
    c.editar(f, { nombre: 'Claudia Pérez', alReloj: false });
    await c.guardar(f);
    expect(api['editarFicha']).toHaveBeenCalledTimes(1);
    expect(api['renombrar']).not.toHaveBeenCalled();
  });
});
