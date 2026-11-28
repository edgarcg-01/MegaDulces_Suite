import { TestBed } from '@angular/core/testing';
import { of } from 'rxjs';
import type { OpcionesCitas } from '@megadulces/contracts';
import { AcuerdoFormComponent } from './acuerdo-form.component';
import { AcuerdosProveedoresService } from '../acuerdos-proveedores.service';
import { CitasProveedoresService } from '../citas-proveedores.service';

/**
 * `[PQ.3.10]` El formulario del acuerdo: sólo ofrece como responsables a quienes AGENDAN Citas. DC44: los que agendan
 * crean, cambian y cierran, y cada responsable cierra el suyo; quien sólo ve (Dirección) no podría cerrar el suyo. Lo
 * encontró la revisión independiente del PR. La API lo vuelve a exigir (`test-newdb-pq3-10-acuerdos-api.js`).
 */
function montar() {
  const opciones: OpcionesCitas = { personas: [
    { user_id: 'U-AG', nombre: 'Prueba Compras', puesto: 'compras', area: 'compras', agenda: true },
    { user_id: 'U-VE', nombre: 'Prueba Dirección', puesto: 'direccion', area: 'direccion', agenda: false },
  ] };
  const api = { capturar: vi.fn(() => of({ id: 'nuevo' })), editar: vi.fn() };
  TestBed.configureTestingModule({
    imports: [AcuerdoFormComponent],
    providers: [
      { provide: AcuerdosProveedoresService, useValue: api },
      { provide: CitasProveedoresService, useValue: { opciones: vi.fn(() => of(opciones)) } },
    ],
  });
  const f = TestBed.createComponent(AcuerdoFormComponent);
  f.detectChanges();
  f.componentInstance.capturar({ meetingId: 'r1', meetingDate: '2026-11-24', proveedor: 'Dulcería de Prueba', organizador: 'Prueba Gerencia' });
  return { c: f.componentInstance, api };
}

describe('[PQ.3.10] el formulario del acuerdo', () => {
  it('ofrece como responsables sólo a quienes agendan Citas (Dirección, que sólo ve, no aparece)', () => {
    const { c } = montar();
    expect(c.personasOpciones()).toEqual([{ label: 'Prueba Compras', value: 'U-AG' }]);
  });

  it('dice lo que falta antes de mandar y, completo, manda el payload de la pantalla', () => {
    const { c, api } = montar();
    c.fArea = 'compras';
    c.fDesc = '  Revisar el mínimo de compra  ';
    expect(c.falta()).toBe('Elige quién de Mega Dulces es responsable.');
    c.fResponsable = 'U-AG';
    c.fFecha = new Date(2026, 11, 1);
    expect(c.falta()).toBeNull();
    c.guardar();
    expect(api.capturar).toHaveBeenCalledWith('r1', {
      area: 'compras', description: 'Revisar el mínimo de compra', due_date: '2026-12-01', assigned_to: 'U-AG', supplier_contact: null,
    });
  });

  it('el del proveedor no manda responsable (lo pone el servidor: quien organizó, DC43)', () => {
    const { c, api } = montar();
    c.fArea = 'supplier';
    c.fDesc = 'Mandar la lista de precios';
    c.fContacto = 'Ejecutivo';
    c.fResponsable = 'U-AG'; // quedó de antes: no viaja
    c.fFecha = new Date(2026, 11, 1);
    c.guardar();
    expect(api.capturar).toHaveBeenCalledWith('r1', expect.objectContaining({ area: 'supplier', assigned_to: null, supplier_contact: 'Ejecutivo' }));
  });
});
