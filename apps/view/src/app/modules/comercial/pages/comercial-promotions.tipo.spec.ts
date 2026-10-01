import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { provideRouter } from '@angular/router';
import { MessageService, ConfirmationService } from 'primeng/api';

import { ComercialPromotionsComponent } from './comercial-promotions.component';

/**
 * **Abrir "Nueva promoción" tiene que dejarte creando, y cambiar de mecánica no puede
 * costarte lo que ya escribiste.**
 *
 * ── Los dos defectos que cierra ─────────────────────────────────────────────────────────────
 *  1. `openCreate()` abría en una antesala (`wizardStep='choose-type'`) **sin formulario**: el
 *     primer clic no producía trabajo.
 *  2. Al colapsar el paso, aparece un riesgo NUEVO y peor: si cambiar de tipo reconstruye el
 *     formulario desde cero, se lleva el código, el nombre y la vigencia que la persona ya
 *     tecleó. Eso sería un retroceso respecto del paso previo, no una mejora — y es
 *     invisible para `tsc`, para el build y para cualquier revisión que no lo ejercite.
 *
 * El tipo por defecto es un **supuesto declarado**: `commercial.promotions` tiene 0 filas
 * (medido 2026-09-30), así que no hay uso real del cual derivarlo. Lo que este spec fija no es
 * *cuál* es, sino que **haya uno** — que es lo que permite abrir ya creando.
 */

function montar() {
  TestBed.configureTestingModule({
    imports: [ComercialPromotionsComponent],
    providers: [
      provideHttpClient(),
      provideHttpClientTesting(),
      provideRouter([]),
      MessageService,
      ConfirmationService,
    ],
  });
  const fixture = TestBed.createComponent(ComercialPromotionsComponent);
  return { fixture, c: fixture.componentInstance };
}

describe('ComercialPromotionsComponent · el alta abre creando', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('⭐ openCreate() deja el formulario ARMADO y una mecánica elegida', () => {
    const { c } = montar();
    c.openCreate();
    // Las dos cosas juntas son "ya se está creando": sin form no hay nada que llenar, y sin
    // tipo el form no sabe qué campos mostrar.
    expect(c.form).toBeTruthy();
    expect(c.selectedType()).toBeTruthy();
    expect(c.dialogVisible).toBe(true);
  });

  it('el encabezado nombra la mecánica desde el arranque, sin "Elegí el tipo"', () => {
    const { c } = montar();
    c.openCreate();
    expect(c.dialogHeader()).toContain('Nueva promoción · ');
    expect(c.dialogHeader()).not.toContain('Elegí el tipo');
  });

  it('⭐ NEGATIVA: cambiar de mecánica CONSERVA código, nombre y vigencia', () => {
    const { c } = montar();
    c.openCreate();
    const desde = new Date('2026-10-01');
    const hasta = new Date('2026-10-15');
    c.form!.patchValue({
      code: 'PROMO_OCT', name: 'Arranque de octubre',
      description: 'texto', starts_at: desde, ends_at: hasta,
      priority: 250, active: false,
    });

    c.chooseType('volume_discount');

    const v = c.form!.getRawValue();
    expect(c.selectedType()).toBe('volume_discount');
    expect(v.code).toBe('PROMO_OCT');
    expect(v.name).toBe('Arranque de octubre');
    expect(v.description).toBe('texto');
    expect(v.starts_at).toEqual(desde);
    expect(v.ends_at).toEqual(hasta);
    expect(v.priority).toBe(250);
    // `active` en false es el caso que un `||` mal puesto pisaría de vuelta a true.
    expect(v.active).toBe(false);
  });

  it('cambiar de mecánica SÍ intercambia los campos propios del tipo', () => {
    const { c } = montar();
    c.openCreate();
    // El default pide producto + porcentaje; el de volumen no tiene `percent`.
    expect(c.form!.get('percent')).toBeTruthy();
    c.chooseType('volume_discount');
    expect(c.form!.get('percent')).toBeNull();
  });

  it('elegir la mecánica que ya estaba no reconstruye nada', () => {
    const { c } = montar();
    c.openCreate();
    const antes = c.form;
    c.chooseType(c.selectedType()!);
    // Misma instancia: si se reconstruyera, un re-render perdería el foco del campo activo.
    expect(c.form).toBe(antes);
  });
});
