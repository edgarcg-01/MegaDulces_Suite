import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { of } from 'rxjs';
import { MessageService, ConfirmationService } from 'primeng/api';
import { ComercialService } from '../../comercial/comercial.service';
import { PermissionsService } from '../../../core/services/permissions.service';
import { TiendaCaducidadesComponent } from './tienda-caducidades.component';

if (typeof (globalThis as any).ResizeObserver === 'undefined') {
  (globalThis as any).ResizeObserver = class { observe(): void { /* jsdom */ } unobserve(): void { /* jsdom */ } disconnect(): void { /* jsdom */ } };
}

/**
 * `[CAD.1]` Una marca fuera de alcance NO se registra «con el código tal cual».
 *
 * El servidor distingue dos cosas que la pantalla mezclaba:
 *
 *   out_of_scope = true   el producto SÍ está en el catálogo y el servidor lo identificó, pero es
 *                         de una marca que quien captura no lleva, así que lo oculta a propósito
 *                         (`commercial-expiry-reviews.service.ts`: visible = hits.filter(marca ∈ sus marcas)).
 *   out_of_scope = false  el código no existe en el catálogo: ahí «tal cual» sí es la salida.
 *
 * El defecto medido en una foto de la pantalla viva (2026-11-20, sucursal Morelia): el aviso decía
 * «Ese código es de una marca que no llevas. Avísale al encargado.» y AL MISMO TIEMPO ofrecía
 * «Registrarlo con el código tal cual». Si lo tocaba, se guardaba un renglón con id/sku/brand en
 * null — tirando la identidad que el sistema ya tenía y salteando la regla de alcance.
 */
const RESPUESTA = (out_of_scope: boolean) => ({
  code: '83368', match: null, candidates: [], source: 'none', out_of_scope,
});

function montar(out_of_scope: boolean) {
  const svc = {
    resolveExpiryCode: () => of(RESPUESTA(out_of_scope)),
    // El constructor resuelve la sucursal de quien captura antes que nada.
    expiryCaptureContext: () => of({ mode: 'own', warehouse: { id: 'w1', name: 'Morelia Madero' }, options: [] }),
    myExpiryEntries: () => of({ data: [] }),
    listExpediente: () => of({ data: [] }),
    unidadesDeProducto: () => of([]),
    listExpiryUnits: () => of([]),
    searchProducts: () => of([]),
  };
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    imports: [TiendaCaducidadesComponent],
    providers: [
      provideRouter([]), provideHttpClient(), provideHttpClientTesting(),
      MessageService, ConfirmationService,
      { provide: ComercialService, useValue: svc },
      { provide: PermissionsService, useValue: { has: () => true, hasAny: () => true, can: () => true } },
    ],
  });
  // Sin detectChanges: se ejerce la lógica, no se pinta la plantilla.
  return TestBed.createComponent(TiendaCaducidadesComponent).componentInstance as any;
}

describe('TiendaCaducidadesComponent · [CAD.1] marca fuera de alcance', () => {
  it('marca fueraDeAlcance y NO deja registrar el código tal cual', () => {
    const c = montar(true);
    c.codigo.set('83368');
    c.resolverCodigo('83368');

    expect(c.fueraDeAlcance()).toBe(true);
    expect(c.avisoCodigo()).toContain('marca que no llevas');

    // El candado: aunque alguien llame al método (botón escondido, atajo, doble toque), no guarda.
    c.usarCodigoCrudo();
    expect(c.producto()).toBeNull();
  });

  // ❌ Control negativo: si esta prueba pasara también con out_of_scope=false, no estaría midiendo
  // nada — probaría que «tal cual» nunca funciona, que es justo lo que NO queremos.
  it('cuando el código sólo no está en el catálogo, SÍ se registra tal cual', () => {
    const c = montar(false);
    c.codigo.set('83368');
    c.resolverCodigo('83368');

    expect(c.fueraDeAlcance()).toBe(false);
    expect(c.avisoCodigo()).toContain('no está en el catálogo');

    c.usarCodigoCrudo();
    expect(c.producto()).not.toBeNull();
    expect(c.producto().raw).toBe('83368');
  });

  it('un código fuera de alcance no deja marcada la bandera para el siguiente disparo', () => {
    const c = montar(true);
    c.codigo.set('83368');
    c.resolverCodigo('83368');
    expect(c.fueraDeAlcance()).toBe(true);

    // El mismo componente, ahora con un código que sí se puede registrar tal cual.
    (c as any).svc.resolveExpiryCode = () => of(RESPUESTA(false));
    c.codigo.set('99999');
    c.resolverCodigo('99999');

    expect(c.fueraDeAlcance()).toBe(false);
  });
});
