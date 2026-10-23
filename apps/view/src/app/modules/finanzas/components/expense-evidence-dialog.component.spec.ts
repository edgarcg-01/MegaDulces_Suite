import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { ExpenseEvidenceDialogComponent } from './expense-evidence-dialog.component';
import { ComprobacionesService } from '../comprobaciones.service';
import { PermissionsService } from '../../../core/services/permissions.service';

/**
 * `[GX.79]` El diálogo de evidencia acepta archivos de hasta **20 MB** (antes 10).
 *
 * El tope es el compartido de contracts (`MAX_ARCHIVO_GASTO_BYTES`); el candado del lado del
 * servidor (`limite-archivo-gasto.spec.ts`) comprueba que la API y el proxy lo dejan pasar.
 */
const MB = 1024 * 1024;

/** Un archivo que DICE pesar `mb`, sin reservar esa memoria: la pantalla sólo mira `size`. */
function archivoDe(mb: number, nombre: string): File {
  const f = new File(['%PDF-1.4'], nombre, { type: 'application/pdf' });
  Object.defineProperty(f, 'size', { value: mb * MB });
  return f;
}

describe('[GX.79] ExpenseEvidenceDialogComponent · tope de 20 MB', () => {
  let comp: ExpenseEvidenceDialogComponent;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [ExpenseEvidenceDialogComponent],
      providers: [provideHttpClient(), provideHttpClientTesting()],
    }).compileComponents();
    comp = TestBed.createComponent(ExpenseEvidenceDialogComponent).componentInstance;
  });

  it('el selector de archivos permite 20 MB', () => {
    expect(comp.maxArchivoBytes).toBe(20 * MB);
  });

  it('⭐ un archivo de 15 MB (antes rechazado) entra', async () => {
    comp.onFilePicked({ currentFiles: [archivoDe(15, 'factura.pdf')] }, 'comprobante_1');
    expect(comp.error()).toBe('');
    // Se espera a que el navegador termine de leerlo (bajo carga tarda más de unos ms).
    await vi.waitFor(() => expect(comp.fileNames()['comprobante_1']).toBe('factura.pdf'));
  });

  /** ⛔ Prueba negativa: más de 20 MB se rechaza y lo dice con el tope nuevo. */
  it('⛔ uno de 21 MB se rechaza diciendo el tope', () => {
    comp.onFilePicked({ currentFiles: [archivoDe(21, 'escaneo.pdf')] }, 'comprobante_1');
    expect(comp.error()).toBe('"escaneo.pdf" supera 20 MB.');
    expect(comp.fileNames()['comprobante_1']).toBeUndefined();
  });
});

/**
 * `[GX.86]` Este diálogo también da de ALTA el vale: fuera del horario (L-V 8:30–10:00 y 17:00–18:00)
 * se frena antes de subir nada. Sólo se finge `Date`.
 */
describe('[GX.86] ExpenseEvidenceDialogComponent · horario de alta', () => {
  const MEDIODIA = '2026-10-19T12:00:00-06:00'; // lunes, entre ventanas

  const armar = async (permisos: Record<string, boolean>) => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(MEDIODIA));
    await TestBed.configureTestingModule({
      imports: [ExpenseEvidenceDialogComponent],
      providers: [provideHttpClient(), provideHttpClientTesting()],
    }).compileComponents();
    TestBed.inject(PermissionsService).load(permisos, 'capturista');
    const fx = TestBed.createComponent(ExpenseEvidenceDialogComponent);
    fx.componentRef.setInput('solicitud', { folio: '0049641', importe: 10, sucursal: '01' } as never);
    const comp = fx.componentInstance;
    // Vale completo sin comprobante (solicitud + motivo): sólo el horario puede frenarlo.
    comp.clasificacion.set('no_comprobable');
    comp.comentarios = 'Propina';
    return { comp, svc: TestBed.inject(ComprobacionesService) };
  };
  afterEach(() => vi.useRealTimers());

  it('⛔ al mediodía quien sólo ve el tablero no sube ni da de alta, y dice cuándo abre', async () => {
    const { comp, svc } = await armar({ FINANCE_EXPENSES_VER: true });
    const subir = vi.spyOn(svc, 'uploadFile');
    const alta = vi.spyOn(svc, 'create');
    comp.enviar();
    expect(subir).not.toHaveBeenCalled();
    expect(alta).not.toHaveBeenCalled();
    expect(comp.error()).toContain('Abre hoy a las 17:00');
  });

  it('el aprobador (COMPROBAR) no tiene horario: a la misma hora sí da de alta', async () => {
    const { comp, svc } = await armar({ FINANCE_EXPENSES_VER: true, FINANCE_EXPENSES_COMPROBAR: true });
    const alta = vi.spyOn(svc, 'create');
    comp.enviar();
    expect(alta).toHaveBeenCalled();
  });
});
