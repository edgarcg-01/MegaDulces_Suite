import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideRouter } from '@angular/router';
import { signal } from '@angular/core';
import { MessageService } from 'primeng/api';

import { MktAcuerdosComponent } from './mkt-acuerdos.component';
import { AuthService } from '../../../core/services/auth.service';
import { PermissionsService } from '../../../core/services/permissions.service';
import { Permission } from '../../../core/constants/permissions';
import { environment } from '../../../../environments/environment';

/**
 * `[MKT.1]` — **La pantalla no puede convertir "no te toca verlo" en "$0".**
 *
 * ── Qué defecto vigila ───────────────────────────────────────────────────────────────────────
 * El servidor **omite** la clave `monto` cuando el usuario no gestiona acuerdos, y la manda en
 * `null` cuando sí puede verla y no se pactó monto. Son dos hechos distintos:
 *
 *   · clave ausente → «reservado a Mercadotecnia»
 *   · `null`        → «no se pactó monto»
 *   · un número     → el monto
 *
 * Si la pantalla los colapsara —lo natural con `{{ a.monto | currency }}`, que imprime nada o
 * `$0.00`— el encargado de plaza leería que el acuerdo no costó nada, que es la conclusión
 * contraria a la verdadera (ADR-056). Y al revés: Mercadotecnia vería «$0» en un acuerdo cuyo
 * monto simplemente no se negoció todavía, y lo sumaría al comprometido.
 *
 * ── Y la otra mitad: en qué vista aterriza cada quien ───────────────────────────────────────
 * Quien SÓLO puede subir evidencia tiene que caer en «Mi plaza». Si aterrizara en el tablero,
 * vería una lista recortada por alcance sin entender por qué, y el botón de su expediente estaría
 * a dos clics de distancia — con el teléfono en la mano, frente al anaquel.
 */

const BASE = `${environment.apiUrl}/commercial/promo-agreements`;

/** Dobles de identidad: lo único que la pantalla consulta para decidir qué dibujar. */
function configurar(permisos: Partial<Record<Permission, boolean>>, warehouse_code: string | null) {
  const authDoble = { user: signal({ permissions: permisos, warehouse_code }) };
  const permsDoble = { isAdmin: () => false };

  TestBed.configureTestingModule({
    imports: [MktAcuerdosComponent],
    providers: [
      provideHttpClient(),
      provideHttpClientTesting(),
      provideRouter([]),
      MessageService,
      { provide: AuthService, useValue: authDoble },
      { provide: PermissionsService, useValue: permsDoble },
    ],
  });
  return {
    fixture: TestBed.createComponent(MktAcuerdosComponent),
    http: TestBed.inject(HttpTestingController),
  };
}

/** Fila del tablero tal como la manda el servidor a quien SÍ ve el dinero. */
const filaConMonto = {
  id: 'a-1', folio: 'MK-2026-1013', proveedor: 'Alteño', apoyo: 'sell_out',
  mecanica: '3% de descuento', status: 'vigente',
  vigencia_desde: '2026-10-05', vigencia_hasta: '2026-10-16', vigencia_hasta_texto: null,
  monto: 76946.02, canales_total: 6, canales_con_evidencia: 2, evidencia_total: 9,
};
/** La MISMA fila como la recibe quien no gestiona: **sin la clave**, no con la clave en 0. */
const filaSinClave = (() => { const { monto, ...resto } = filaConMonto; void monto; return resto; })();

describe('[MKT.1] MktAcuerdosComponent', () => {
  afterEach(() => {
    const http = TestBed.inject(HttpTestingController);
    http.verify({ ignoreCancelled: true });
  });

  describe('el dinero', () => {
    it('⭐ NEGATIVA: sin permiso de gestión, la pantalla NO dibuja el monto', () => {
      const { fixture, http } = configurar({ [Permission.MKT_AGREEMENTS_VER]: true }, null);
      fixture.detectChanges();
      http.expectOne(BASE).flush([filaSinClave]);
      http.expectOne(`${BASE}/resumen`).flush({
        activos: 1, expedientes_completos: 2, expedientes_total: 6, canales_sin_evidencia: 4,
      });
      fixture.detectChanges();

      const texto = (fixture.nativeElement as HTMLElement).textContent ?? '';
      expect(fixture.componentInstance.veDinero()).toBe(false);
      // Ni el número, ni un $0 que lo reemplace.
      expect(texto).not.toContain('76,946');
      expect(texto).not.toContain('$0.00');
      // Y la columna directamente no existe: sin esto, un encabezado "Monto" con celdas vacías
      // se lee como "no hay monto".
      expect(texto).not.toContain('Monto');
    });

    it('CONTROL POSITIVO: con permiso de gestión sí lo dibuja', () => {
      const { fixture, http } = configurar({ [Permission.MKT_AGREEMENTS_GESTIONAR]: true }, null);
      fixture.detectChanges();
      http.expectOne(BASE).flush([filaConMonto]);
      http.expectOne(`${BASE}/resumen`).flush({
        activos: 1, expedientes_completos: 2, expedientes_total: 6, canales_sin_evidencia: 4,
        monto_comprometido: 76946.02,
      });
      fixture.detectChanges();

      expect(fixture.componentInstance.veDinero()).toBe(true);
      expect((fixture.nativeElement as HTMLElement).textContent).toContain('76,946');
    });

    it('⭐ `monto: null` (no se pactó) escribe «sin monto», NUNCA $0', () => {
      const { fixture, http } = configurar({ [Permission.MKT_AGREEMENTS_GESTIONAR]: true }, null);
      fixture.detectChanges();
      http.expectOne(BASE).flush([{ ...filaConMonto, monto: null }]);
      http.expectOne(`${BASE}/resumen`).flush({
        activos: 1, expedientes_completos: 2, expedientes_total: 6, canales_sin_evidencia: 4,
        monto_comprometido: null,
      });
      fixture.detectChanges();

      const texto = (fixture.nativeElement as HTMLElement).textContent ?? '';
      expect(texto).toContain('sin monto');
      expect(texto).not.toContain('$0.00');
    });
  });

  describe('los KPIs', () => {
    it('⭐ el comprometido NO aparece cuando el servidor no manda la clave', () => {
      const { fixture, http } = configurar({ [Permission.MKT_AGREEMENTS_VER]: true }, null);
      fixture.detectChanges();
      http.expectOne(BASE).flush([filaSinClave]);
      http.expectOne(`${BASE}/resumen`).flush({
        activos: 1, expedientes_completos: 2, expedientes_total: 6, canales_sin_evidencia: 4,
      });
      fixture.detectChanges();

      const etiquetas = fixture.componentInstance.kpis().map((k) => k.label);
      expect(etiquetas).not.toContain('Comprometido');
      // Los tres que sí le tocan siguen ahí: ocultar el dinero no puede vaciar el tablero.
      expect(etiquetas).toContain('Acuerdos activos');
      expect(etiquetas).toContain('Plazas sin comprobar');
    });

    it('con la clave en `null`, el KPI lo DECLARA en vez de sumar 0', () => {
      const { fixture, http } = configurar({ [Permission.MKT_AGREEMENTS_GESTIONAR]: true }, null);
      fixture.detectChanges();
      http.expectOne(BASE).flush([{ ...filaConMonto, monto: null }]);
      http.expectOne(`${BASE}/resumen`).flush({
        activos: 1, expedientes_completos: 0, expedientes_total: 6, canales_sin_evidencia: 6,
        monto_comprometido: null,
      });
      fixture.detectChanges();

      const kpi = fixture.componentInstance.kpis().find((k) => k.label === 'Comprometido');
      expect(kpi?.value).toBe('sin monto pactado');
      expect(kpi?.value).not.toBe(0);
    });
  });

  describe('en qué vista aterriza cada quien', () => {
    it('⭐ quien SÓLO sube evidencia arranca en «Mi plaza» y pide SU sucursal', () => {
      const { fixture, http } = configurar({ [Permission.MKT_AGREEMENT_EVIDENCE_SUBIR]: true }, '03');
      fixture.detectChanges();

      expect(fixture.componentInstance.vista()).toBe('plaza');
      // La sucursal viaja explícita: el servidor la valida contra el alcance. Si la pantalla
      // pidiera el tablero y filtrara, el recorte sería de mentira.
      http.expectOne(`${BASE}/sucursal/03`).flush([]);
      // Y NO se pide el tablero: es justo lo que esa persona no puede ver entero.
      http.expectNone(BASE);
    });

    it('Mercadotecnia arranca en el tablero', () => {
      const { fixture, http } = configurar({ [Permission.MKT_AGREEMENTS_GESTIONAR]: true }, null);
      fixture.detectChanges();

      expect(fixture.componentInstance.vista()).toBe('tablero');
      http.expectOne(BASE).flush([]);
      http.expectOne(`${BASE}/resumen`).flush({
        activos: 0, expedientes_completos: 0, expedientes_total: 0, canales_sin_evidencia: 0,
      });
    });

    it('el selector de vista sólo aparece si de verdad hay dos que elegir', () => {
      const { fixture, http } = configurar({ [Permission.MKT_AGREEMENTS_VER]: true }, null);
      fixture.detectChanges();
      http.expectOne(BASE).flush([]);
      http.expectOne(`${BASE}/resumen`).flush({
        activos: 0, expedientes_completos: 0, expedientes_total: 0, canales_sin_evidencia: 0,
      });
      expect(fixture.componentInstance.puedeAmbas()).toBe(false);
    });

    it('⭐ sin sucursal asignada se DECLARA, en vez de una tabla vacía', () => {
      const { fixture, http } = configurar({ [Permission.MKT_AGREEMENT_EVIDENCE_SUBIR]: true }, null);
      fixture.detectChanges();

      // No se pide nada: sin sucursal no hay a quién preguntarle.
      http.expectNone((r) => r.url.startsWith(`${BASE}/sucursal`));
      const texto = (fixture.nativeElement as HTMLElement).textContent ?? '';
      // Una tabla vacía diría "no hay acuerdos para tu plaza", que es falso: el problema es otro
      // y se arregla en otro lado (accesos), no esperando a que Mercadotecnia levante uno.
      expect(texto).toContain('Sin sucursal asignada');
    });
  });

  describe('la fecha no se corre un día', () => {
    it('⭐ una vigencia que arranca el 1 no se dibuja el 31 del mes anterior', () => {
      const { fixture } = configurar({ [Permission.MKT_AGREEMENTS_VER]: true }, null);
      const c = fixture.componentInstance;
      // `new Date('2026-09-01')` en hora de México (−06:00) imprime el 31 de agosto: el error
      // exacto que la Fase LC pagó en el TXT del libro de compras. Se corta el string.
      expect(c.vigencia({ ...filaConMonto, vigencia_desde: '2026-09-01', vigencia_hasta: '2026-09-30' } as never))
        .toBe('01/09/26 → 30/09/26');
      const http = TestBed.inject(HttpTestingController);
      fixture.detectChanges();
      http.match(() => true).forEach((r) => r.flush([]));
    });

    it('una vigencia sin fecha de fin muestra su CONDICIÓN, no un guion', () => {
      const { fixture } = configurar({ [Permission.MKT_AGREEMENTS_VER]: true }, null);
      expect(fixture.componentInstance.vigencia({
        ...filaConMonto, vigencia_hasta: null, vigencia_hasta_texto: 'hasta agotar',
      } as never)).toBe('05/10/26 → hasta agotar');
      const http = TestBed.inject(HttpTestingController);
      fixture.detectChanges();
      http.match(() => true).forEach((r) => r.flush([]));
    });
  });

  describe('lo que el tablero tiene que gritar', () => {
    it('un acuerdo vigente con plazas sin comprobar sale marcado', () => {
      const { fixture } = configurar({ [Permission.MKT_AGREEMENTS_VER]: true }, null);
      const c = fixture.componentInstance;
      expect(c.enRiesgo({ ...filaConMonto, canales_total: 6, canales_con_evidencia: 0 } as never)).toBe(true);
      expect(c.enRiesgo({ ...filaConMonto, canales_total: 6, canales_con_evidencia: 6 } as never)).toBe(false);
      // Un BORRADOR sin evidencia no es un problema: todavía no se le prometió nada a nadie.
      expect(c.enRiesgo({ ...filaConMonto, status: 'borrador', canales_con_evidencia: 0 } as never)).toBe(false);
      // Y un acuerdo SIN canales no se marca: no hay nada que comprobar, no es que falte.
      expect(c.enRiesgo({ ...filaConMonto, canales_total: 0, canales_con_evidencia: 0 } as never)).toBe(false);
      const http = TestBed.inject(HttpTestingController);
      fixture.detectChanges();
      http.match(() => true).forEach((r) => r.flush([]));
    });
  });
});
