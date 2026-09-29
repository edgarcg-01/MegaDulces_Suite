import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { MessageService } from 'primeng/api';
import { of } from 'rxjs';
import { ArqueoService, AvisoDobleCaja, Turno, TurnosResp } from '../arqueo.service';
import { AuthService } from '../../../core/services/auth.service';
import { PermissionsService } from '../../../core/services/permissions.service';
import { DataScopeService } from '../../../core/services/data-scope.service';
import { TiendaArqueoComponent } from './tienda-arqueo.component';

// `p-table` observa su tamaño con ResizeObserver, que jsdom no trae.
if (typeof (globalThis as any).ResizeObserver === 'undefined') {
  (globalThis as any).ResizeObserver = class {
    observe(): void { /* el mock no observa: sólo evita que p-table reviente en jsdom */ }
    unobserve(): void { /* idem */ }
    disconnect(): void { /* idem */ }
  };
}

/**
 * **[SM.40] La pantalla de arqueo, del lado de la cajera: nada la puede dejar sin
 * poder contar.**
 *
 * Esta suite existe por un incidente real (2026-09-29): dos cortes hechos y la
 * pantalla trabada, con la cajera todavía en turno. La causa de fondo fue la
 * ingesta caída 6 días, pero lo que convirtió un atraso de datos en un mostrador
 * parado fueron los tres candados que este cambio retira. Así que lo que se prueba
 * acá no es "el botón se pinta", es **que no existe un estado en el que la persona
 * no pueda registrar su conteo**.
 *
 * Cada `it` es uno de los tres candados, escrito como la situación que lo
 * disparaba en producción.
 */
const turno = (over: Partial<Turno> = {}): Turno => ({
  warehouse_code: '01', warehouse_name: 'PADRE HIDALGO',
  caja: '2', folio: '87', business_date: '2026-09-29',
  hora_apertura: '08:15', hora_cierre: null, cajero_code: '10C02',
  turno: '01', abierto: true,
  ...over,
});

class ArqueoStub {
  resp: TurnosResp = { turnos: [], aviso: null };
  /** Lo último que se mandó a `POST /store/arqueo`. */
  enviado: any = null;
  turnos() { return of(this.resp); }
  rutas() { return of({ warehouse_code: '01', rd: [], rv: [] }); }
  list() { return of([]); }
  submit(dto: any) { this.enviado = dto; return of({ tipo: dto.tipo, total_contado: 1000, reveal: false }); }
  submitRuta(dto: any) { this.enviado = dto; return of({ tipo: dto.tipo, total_contado: 1000, route_code: dto.route_code, route_label: '', medible: false, motivo_no_medible: 'sin_esperado' }); }
  validar() { return of({}); }
  porCajera() { return of({ cajeras: [], totales: { cajeras: 0, cortes: 0, sin_arqueo: 0 } }); }
}

describe('TiendaArqueoComponent · [SM.40] la cajera siempre puede contar', () => {
  let fix: ComponentFixture<TiendaArqueoComponent>;
  let cmp: TiendaArqueoComponent;
  let svc: ArqueoStub;

  const html = (): string => (fix.nativeElement as HTMLElement).textContent ?? '';
  const tick = async (): Promise<void> => {
    await fix.whenStable();
    await new Promise((r) => setTimeout(r, 0));
    fix.detectChanges();
  };

  /** Los botones de turno que la persona puede realmente pulsar. */
  const turnosPulsables = (): HTMLButtonElement[] =>
    Array.from((fix.nativeElement as HTMLElement).querySelectorAll<HTMLButtonElement>('button.arq-turno'))
      .filter((b) => !b.disabled);

  beforeEach(async () => {
    svc = new ArqueoStub();
    await TestBed.configureTestingModule({
      imports: [TiendaArqueoComponent],
      providers: [
        provideRouter([]), provideHttpClient(), provideHttpClientTesting(),
        MessageService,
        { provide: ArqueoService, useValue: svc },
        // Cajera: captura, NO revela. Es el caso que los candados castigaban.
        {
          provide: AuthService,
          useValue: {
            user: () => ({ username: '10c02', warehouse_code: '01', role_name: 'cajero', permissions: { STORE_ARQUEO_CAPTURAR: true, STORE_ARQUEO_VER: true } }),
            token: () => null,
          },
        },
        { provide: PermissionsService, useValue: { isAdmin: () => false, has: () => false } },
        { provide: DataScopeService, useValue: { warehouses: () => of([{ value: '01', label: 'PADRE HIDALGO' }]) } },
      ],
    }).compileComponents();
    fix = TestBed.createComponent(TiendaArqueoComponent);
    cmp = fix.componentInstance;
    fix.detectChanges();
    await tick();
  });

  /** Teclea un conteo cualquiera para que el botón de guardar tenga sentido. */
  const contar = async (): Promise<void> => {
    cmp.denomCount['1000'] = 1;
    cmp.recalc();
    await tick();
  };

  it('⭐ dos cajas abiertas ya NO esconden la captura — se avisa y se sigue contando', async () => {
    const aviso: AvisoDobleCaja = {
      cajas: [
        { warehouse_code: '07', caja: '1', folio: '14', business_date: '2026-09-29', hora_apertura: '08:00', dias_abierta: 0 },
        { warehouse_code: '08', caja: '1', folio: '5', business_date: '2026-09-29', hora_apertura: '09:10', dias_abierta: 0 },
      ],
      arrastradas: [],
    };
    svc.resp = { turnos: [turno()], aviso };
    cmp.ngOnInit();
    await tick();

    // El aviso se ve…
    expect(cmp.aviso()).toEqual(aviso);
    expect(html()).toContain('Tienes dos cajas abiertas con tu usuario');
    // …y NO dice que algo quedó bloqueado.
    expect(html()).not.toContain('bloqueado');
    // Lo que importa: el formulario de captura sigue en pantalla —antes el
    // bloqueo lo reemplazaba entero— con el turno ya elegido.
    expect(html()).toContain('Nuevo arqueo');
    expect(cmp.turnoSel()?.folio).toBe('87');
    await contar();
    expect(cmp.canSubmit()).toBe(true);
  });

  it('⭐ con varios turnos pendientes se puede elegir CUALQUIERA, no sólo el más viejo', async () => {
    // El escenario que trabó a 40VMC 235 días: un turno viejo que nadie va a
    // cerrar, primero en la fila, y el de hoy detrás.
    svc.resp = {
      turnos: [
        turno({ folio: '1', caja: '7', business_date: '2026-01-31', abierto: true }),
        turno({ folio: '285', caja: '2', business_date: '2026-09-29', abierto: true }),
      ],
      aviso: null,
    };
    cmp.ngOnInit();
    await tick();

    // Los DOS son accionables: antes sólo el primero, con el resto `disabled`.
    expect(turnosPulsables().length).toBe(2);
    expect(html()).not.toContain('Después de cerrar el anterior');

    // Y elegir el de hoy —el segundo— funciona.
    const hoy = cmp.turnosOrdenados().find((t) => t.folio === '285');
    expect(hoy).toBeTruthy();
    cmp.elegirTurno('285');
    await contar();
    expect(cmp.turnoSel()?.folio).toBe('285');
    expect(cmp.canSubmit()).toBe(true);
  });

  it('⭐ sin ningún turno la cajera puede contar igual — es el caso de la ingesta caída', async () => {
    svc.resp = { turnos: [], aviso: null };
    cmp.ngOnInit();
    await tick();

    // Se le OFRECE contar a mano (antes el botón sólo existía para el supervisor).
    expect(html()).toContain('Contar sin turno');
    expect(cmp.manual()).toBe(false);

    cmp.manual.set(true);
    cmp.aCaja = '2';
    await contar();

    expect(cmp.canSubmit()).toBe(true);
    cmp.submit();
    await tick();
    // Va sin folio: queda registrado y sin comparación contra Kepler, que es
    // exactamente lo que se quiere decir.
    expect(svc.enviado).toBeTruthy();
    expect(svc.enviado.cash_cut_folio).toBeUndefined();
    expect(svc.enviado.caja).toBe('2');
  });

  it('el código de cajera no se puede escribir a nombre de otra persona', async () => {
    svc.resp = { turnos: [], aviso: null };
    cmp.ngOnInit();
    await tick();
    cmp.manual.set(true);
    await tick();

    const campo = (fix.nativeElement as HTMLElement)
      .querySelector<HTMLInputElement>('input.arq-fld-cajero');
    expect(campo).toBeTruthy();
    // Quitar los candados de horario no es quitar la identidad del conteo.
    expect(campo!.readOnly).toBe(true);
    expect(cmp.aCajero).toBe('10C02');
  });
});
