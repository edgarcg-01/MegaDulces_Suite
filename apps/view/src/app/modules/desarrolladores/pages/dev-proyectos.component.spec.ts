import { ComponentFixture, TestBed } from '@angular/core/testing';
import { HttpErrorResponse, HttpEventType, HttpResponse } from '@angular/common/http';
import { of, throwError } from 'rxjs';
import { vi } from 'vitest';
import { PermissionsService } from '../../../core/services/permissions.service';
import { Permission } from '../../../core/constants/permissions';
import { DevProjectsService, type DevProject, type DevProjectDetail } from '../dev-projects.service';
import { DevProyectosComponent, apiError, diffForm, emptyForm, humanSize } from './dev-proyectos.component';

/**
 * `[DEV.8]` La pantalla de Proyectos. Lo que se defiende:
 *  · en una alta, los archivos esperan al folio y se suben DESPUÉS de crear el proyecto;
 *  · editar manda sólo lo que cambió;
 *  · quien sólo tiene VER no ve botones para dar de alta ni editar;
 *  · sin soporte de dictado se DECLARA, no se pinta un botón que no hace nada.
 */

const TEAM = [
  { user_id: 'u-edgar', display_name: 'Edgar Dayan Cortés García', username: 'edgar_cortes' },
  { user_id: 'u-david', display_name: 'Ángel David Cisneros Salazar', username: 'david_cisneros' },
  { user_id: 'u-luis', display_name: 'Luis Francisco López Gutiérrez', username: 'superuser' },
];

const row = (over: Partial<DevProject> = {}): DevProject => ({
  id: 'p1', folio: 'DEV-2026-0001', title: 'Portal de proveedores', objective: 'Que el proveedor vea sus pagos',
  priority: 'media', status: 'nuevo', assignee_user_id: 'u-david', assignee_name: 'Ángel David Cisneros Salazar',
  due_date: null, created_at: '2026-10-01T16:00:00.000Z', created_by_username: 'david_cisneros',
  updated_at: '2026-10-01T16:00:00.000Z', attachments_count: 0, ...over,
});
const detail = (over: Partial<DevProjectDetail> = {}): DevProjectDetail => ({ ...row(), attachments: [], ...over });

function makeApi(list: DevProject[] = [row(), row({ id: 'p2', folio: 'DEV-2026-0002', title: 'App de reparto', objective: null, status: 'en_progreso', assignee_user_id: null, assignee_name: null })]) {
  return {
    team: vi.fn(() => of(TEAM)),
    list: vi.fn(() => of(list)),
    detail: vi.fn((id: string) => of(detail({ id }))),
    create: vi.fn(() => of(detail({ id: 'p-new', folio: 'DEV-2026-0003', title: 'Bitácora' }))),
    update: vi.fn((_id: string, b: unknown) => of(detail({ ...(b as object) }))),
    remove: vi.fn(() => of({ ok: true })),
    upload: vi.fn(() => of(
      { type: HttpEventType.UploadProgress, loaded: 5, total: 10 },
      new HttpResponse({ body: { id: 'a1', kind: 'imagen', source: 'camara', file_name: 'foto.jpg', mime_type: 'image/jpeg', size_bytes: 3, created_at: 'x', created_by_username: null, url: 'u' } }),
    )),
    removeAttachment: vi.fn(() => of({ ok: true })),
  };
}

describe('[DEV.8] DevProyectosComponent', () => {
  let fix: ComponentFixture<DevProyectosComponent>;
  let c: DevProyectosComponent;
  let api: ReturnType<typeof makeApi>;

  const text = () => (fix.nativeElement as HTMLElement).textContent ?? '';
  const buttons = () => Array.from((fix.nativeElement as HTMLElement).querySelectorAll('button')).map((b) => b.textContent?.trim() ?? '');

  async function render(opts: { manage?: boolean; dictation?: boolean; api?: ReturnType<typeof makeApi> } = {}) {
    api = opts.api ?? makeApi();
    const manage = opts.manage ?? true;
    TestBed.configureTestingModule({
      imports: [DevProyectosComponent],
      providers: [
        { provide: DevProjectsService, useValue: api },
        { provide: PermissionsService, useValue: { has: (p: string) => p === Permission.DEV_PROJECTS_VER || (manage && p === Permission.DEV_PROJECTS_GESTIONAR) } },
      ],
    });
    fix = TestBed.createComponent(DevProyectosComponent);
    c = fix.componentInstance;
    // Sin micrófono en pruebas: el reconocedor se reemplaza ANTES de ngOnInit.
    (c as unknown as { recognitionFactory: () => unknown }).recognitionFactory = opts.dictation === false
      ? () => null
      : () => ({ lang: '', continuous: false, interimResults: false, onresult: null, onerror: null, onend: null, start() {}, stop() {} });
    fix.detectChanges();
    await fix.whenStable();
    fix.detectChanges();
  }

  it('lista los proyectos con su folio, responsable y conteo por estado', async () => {
    await render();
    expect(text()).toContain('DEV-2026-0001');
    expect(text()).toContain('Portal de proveedores');
    expect(text()).toContain('Ángel David Cisneros Salazar');
    expect(c.countBy()).toEqual({ nuevo: 1, en_progreso: 1 });
  });

  it('filtra por estado, por «sin asignar» y por texto', async () => {
    await render();
    c.setStatus('en_progreso');
    expect(c.visible().map((p) => p.id)).toEqual(['p2']);
    c.setStatus('');
    c.fAssignee.set('sin_asignar');
    expect(c.visible().map((p) => p.id)).toEqual(['p2']);
    c.fAssignee.set(null);
    c.fSearch.set('pagos'); // está en el OBJETIVO, no en el nombre
    expect(c.visible().map((p) => p.id)).toEqual(['p1']);
  });

  it('el selector de responsable ofrece exactamente al equipo de desarrollo', async () => {
    await render();
    expect(c.team().map((t) => t.display_name)).toEqual([
      'Edgar Dayan Cortés García', 'Ángel David Cisneros Salazar', 'Luis Francisco López Gutiérrez',
    ]);
  });

  it('⛔ sólo con VER: no hay «Nuevo proyecto» ni botones de evidencia', async () => {
    await render({ manage: false });
    expect(buttons().join('|')).not.toContain('Nuevo proyecto');
    await c.abrir('p1');
    fix.detectChanges();
    expect(buttons().join('|')).not.toContain('Adjuntar archivos');
    expect(buttons().join('|')).not.toContain('Guardar cambios');
  });

  it('alta: crea el proyecto y DESPUÉS sube los archivos que esperaban el folio', async () => {
    await render();
    c.nuevo();
    c.form = { ...emptyForm(), title: '  Bitácora  ', assignee_user_id: 'u-luis', priority: 'alta' };
    c.agregar(new Blob(['abc'], { type: 'image/jpeg' }), 'foto.jpg', 'camara');
    // Todavía no hay folio: no se sube nada.
    expect(api.upload).not.toHaveBeenCalled();
    expect(c.pending()).toHaveLength(1);

    await c.guardar();
    expect(api.create).toHaveBeenCalledWith(expect.objectContaining({ title: 'Bitácora', assignee_user_id: 'u-luis', priority: 'alta', objective: null }));
    expect(api.upload).toHaveBeenCalledWith('p-new', expect.any(Blob), 'foto.jpg', 'camara');
    expect(c.pending()).toHaveLength(0);
    expect(c.current()?.attachments.map((a) => a.file_name)).toEqual(['foto.jpg']);
    expect(c.notice()).toBe('Proyecto DEV-2026-0003 dado de alta.');
  });

  it('⛔ si un archivo falla, el proyecto queda guardado y se dice cuál faltó', async () => {
    const a = makeApi();
    a.upload = vi.fn(() => throwError(() => new HttpErrorResponse({ status: 413 }))) as any;
    await render({ api: a });
    c.nuevo();
    c.form = { ...emptyForm(), title: 'Con video' };
    c.agregar(new Blob(['x'], { type: 'video/webm' }), 'video.webm', 'grabacion');
    await c.guardar();
    expect(a.create).toHaveBeenCalled();
    expect(c.formError()).toMatch(/1 archivo\(s\) no se subieron/);
    expect(c.pending()[0].error).toBe('El archivo es demasiado grande para el servidor.');
  });

  it('en un proyecto existente el archivo se sube en cuanto se elige', async () => {
    await render();
    await c.abrir('p1');
    c.agregar(new Blob(['abc'], { type: 'application/pdf' }), 'minuta.pdf', 'archivo');
    expect(api.upload).toHaveBeenCalledWith('p1', expect.any(Blob), 'minuta.pdf', 'archivo');
  });

  it('editar manda sólo lo que cambió', async () => {
    await render();
    await c.abrir('p1');
    c.form = { ...c.form, status: 'en_progreso' };
    await c.guardar();
    expect(api.update).toHaveBeenCalledWith('p1', { status: 'en_progreso' });
  });

  it('⛔ sin soporte de dictado lo declara en vez de pintar un botón muerto', async () => {
    await render({ dictation: false });
    c.nuevo();
    fix.detectChanges();
    expect(text()).toContain('Dictado no disponible en este navegador');
    expect(buttons().join('|')).not.toContain('Dictar');
  });

  it('con soporte de dictado aparece el botón', async () => {
    await render();
    c.nuevo();
    fix.detectChanges();
    expect(buttons().join('|')).toContain('Dictar');
  });
});

describe('[DEV.8] utilidades', () => {
  it('diffForm: sólo campos cambiados; vacío ↔ null es «sin cambio»', () => {
    const saved = detail({ objective: null, due_date: null });
    const f = { ...emptyForm(), title: saved.title, priority: saved.priority, status: saved.status, assignee_user_id: saved.assignee_user_id };
    expect(diffForm(saved, f)).toEqual({});
    expect(diffForm(saved, { ...f, objective: 'Nuevo', due_date: '2026-10-20', assignee_user_id: null })).toEqual({
      objective: 'Nuevo', due_date: '2026-10-20', assignee_user_id: null,
    });
  });

  it('humanSize', () => {
    expect(humanSize(500)).toBe('500 B');
    expect(humanSize(2048)).toBe('2 KB');
    expect(humanSize(5 * 1024 * 1024)).toBe('5.0 MB');
  });

  it('apiError toma el mensaje del servidor y traduce los códigos sin mensaje', () => {
    expect(apiError(new HttpErrorResponse({ status: 400, error: { message: 'El nombre es obligatorio.' } }), 'x')).toBe('El nombre es obligatorio.');
    expect(apiError(new HttpErrorResponse({ status: 400, error: { message: ['a', 'b'] } }), 'x')).toBe('a · b');
    expect(apiError(new HttpErrorResponse({ status: 403 }), 'x')).toMatch(/permiso/);
    expect(apiError(new Error('?'), 'fallback')).toBe('fallback');
  });
});
