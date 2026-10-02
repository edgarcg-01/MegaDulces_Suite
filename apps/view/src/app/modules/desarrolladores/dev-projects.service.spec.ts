import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { environment } from '../../../environments/environment';
import { DevProjectsService } from './dev-projects.service';

/** `[DEV.5]` Qué viaja al API: rutas, filtros y el multipart de los adjuntos. */
const BASE = `${environment.apiUrl}/dev/projects`;
const ID = '11111111-1111-4111-8111-111111111111';

describe('[DEV.5] DevProjectsService', () => {
  let svc: DevProjectsService;
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting()] });
    svc = TestBed.inject(DevProjectsService);
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  it('el equipo sale de /team', () => {
    svc.team().subscribe();
    http.expectOne(`${BASE}/team`).flush([]);
  });

  it('⛔ un filtro vacío NO viaja (status= vacío no es «todos»)', () => {
    svc.list({ status: '', assignee: 'sin_asignar', search: '' }).subscribe();
    const req = http.expectOne((r) => r.url === BASE);
    expect(req.request.params.has('status')).toBe(false);
    expect(req.request.params.has('search')).toBe(false);
    expect(req.request.params.get('assignee')).toBe('sin_asignar');
    req.flush([]);
  });

  it('alta = POST, edición = PATCH con sólo lo que cambió, baja = DELETE', () => {
    svc.create({ title: 'X' }).subscribe();
    const c = http.expectOne(BASE);
    expect(c.request.method).toBe('POST');
    expect(c.request.body).toEqual({ title: 'X' });
    c.flush({});

    svc.update(ID, { status: 'terminado' }).subscribe();
    const u = http.expectOne(`${BASE}/${ID}`);
    expect(u.request.method).toBe('PATCH');
    expect(u.request.body).toEqual({ status: 'terminado' });
    u.flush({});

    svc.remove(ID).subscribe();
    const d = http.expectOne(`${BASE}/${ID}`);
    expect(d.request.method).toBe('DELETE');
    d.flush({ ok: true });
  });

  it('el adjunto viaja como multipart con su origen y su nombre, y pide progreso', () => {
    const blob = new Blob(['abc'], { type: 'video/webm' });
    svc.upload(ID, blob, 'video-1.webm', 'grabacion').subscribe();
    const req = http.expectOne(`${BASE}/${ID}/attachments`);
    expect(req.request.method).toBe('POST');
    expect(req.request.reportProgress).toBe(true);
    const fd = req.request.body as FormData;
    expect(fd.get('source')).toBe('grabacion');
    const f = fd.get('file') as File;
    expect(f.name).toBe('video-1.webm');
    expect(f.type).toBe('video/webm');
    req.flush({});
  });

  it('[DEV.10] una nota viaja con su tipo; quitarla es DELETE sobre su ruta', () => {
    svc.addNote(ID, 'modificacion', 'Agregar filtro').subscribe();
    const n = http.expectOne(`${BASE}/${ID}/notes`);
    expect(n.request.method).toBe('POST');
    expect(n.request.body).toEqual({ kind: 'modificacion', body: 'Agregar filtro' });
    n.flush({});

    svc.removeNote(ID, 'n1').subscribe();
    const d = http.expectOne(`${BASE}/${ID}/notes/n1`);
    expect(d.request.method).toBe('DELETE');
    d.flush({ ok: true });
  });

  it('[DEV.10] el adjunto de una nota manda note_id; el del proyecto NO lo manda', () => {
    svc.upload(ID, new Blob(['a']), 'a.txt', 'archivo', 'n1').subscribe();
    const a = http.expectOne(`${BASE}/${ID}/attachments`);
    expect((a.request.body as FormData).get('note_id')).toBe('n1');
    a.flush({});

    svc.upload(ID, new Blob(['b']), 'b.txt', 'archivo').subscribe();
    const b = http.expectOne(`${BASE}/${ID}/attachments`);
    expect((b.request.body as FormData).has('note_id')).toBe(false);
    b.flush({});
  });

  it('quitar un adjunto es DELETE sobre su ruta', () => {
    svc.removeAttachment(ID, 'a1').subscribe();
    const req = http.expectOne(`${BASE}/${ID}/attachments/a1`);
    expect(req.request.method).toBe('DELETE');
    req.flush({ ok: true });
  });
});
