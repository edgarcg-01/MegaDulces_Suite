import { HttpClient, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import type {
  ArchivoParaLeerAlta,
  BandejaAlta,
  DocumentoDeSolicitud,
  LeerDocumentosRespuesta,
  CatalogosAlta,
  CodigoPostalAlta,
  CrearSolicitudRespuesta,
  DecidirCreditoBody,
  EstadoSolicitudAlta,
  PlanAltaKepler,
  RevisionAlta,
  SolicitudAlta,
  SolicitudAltaBody,
  SubirConstanciaRespuesta,
} from '@megadulces/contracts';
import { environment } from '../../../environments/environment';

/** Lado mayor de una foto antes de subirla: de sobra para leerla (el servidor la deja en 1568 px). */
const LADO_MAX_FOTO = 2000;

/**
 * `[ALC.4]` Un archivo del selector → `data:` URI para leer. Una foto del celular (3–6 MB) se re-codifica
 * a JPEG de ≤2000 px (~0.5 MB): cuatro caben en una petición y la orientación de la cámara queda
 * aplicada. Un PDF va tal cual. ⚠️ Es el tercer compresor de fotos del front (Compras:
 * `imagenes-a-pdf.ts`; Finanzas: `camera-shot`): deuda `[ALC.9b]`, unificarlos en `shared/`.
 */
export async function archivoParaLeer(f: File): Promise<ArchivoParaLeerAlta> {
  const comoDataUri = (b: Blob) => new Promise<string>((ok, mal) => {
    const r = new FileReader();
    r.onload = () => ok(String(r.result ?? ''));
    r.onerror = () => mal(new Error('No se pudo abrir el archivo.'));
    r.readAsDataURL(b);
  });
  if (f.type === 'application/pdf' || /\.pdf$/i.test(f.name)) return { data_uri: await comoDataUri(f), nombre: f.name };
  const bmp = await createImageBitmap(f, { imageOrientation: 'from-image' });
  const k = Math.min(1, LADO_MAX_FOTO / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas');
  c.width = Math.round(bmp.width * k);
  c.height = Math.round(bmp.height * k);
  c.getContext('2d')?.drawImage(bmp, 0, 0, c.width, c.height);
  bmp.close();
  return { data_uri: c.toDataURL('image/jpeg', 0.85), nombre: f.name };
}

/** `[ALC]` Alta de clientes: constancia → solicitud → crédito → liga con Kepler. */
@Injectable({ providedIn: 'root' })
export class AltaClientesService {
  private readonly http = inject(HttpClient);
  private readonly base = `${environment.apiUrl}/commercial/customer-onboarding`;

  catalogos(branch?: string | null): Observable<CatalogosAlta> {
    return this.http.get<CatalogosAlta>(`${this.base}/catalogs`, { params: branch ? new HttpParams().set('branch', branch) : undefined });
  }

  /** `[ALC.3.4]` Estado del CP y cómo escribe Kepler el renglón 2 con ese CP. */
  codigoPostal(cp: string): Observable<CodigoPostalAlta> {
    return this.http.get<CodigoPostalAlta>(`${this.base}/postal-code/${encodeURIComponent(cp)}`);
  }

  /**
   * `[ALC.3.5]` El geocodificador de la Suite (`/reports/geocode`, Mapbox, sesgo a MX). Se paga por
   * llamada: la pantalla lo llama con un clic, nunca al teclear.
   */
  geocode(q: string): Observable<{ results: { lat: number; lng: number; place_name: string; relevance: number }[] }> {
    return this.http.get<{ results: { lat: number; lng: number; place_name: string; relevance: number }[] }>(
      `${environment.apiUrl}/reports/geocode`, { params: new HttpParams().set('q', q) });
  }

  /**
   * `[ALC.4]` De 1 a 4 archivos del mismo cliente (constancia, fotos, capturas). El PDF del SAT se lee
   * sin IA; lo demás, con IA si está encendida. Devuelve el prellenado y el `lectura_id`; no crea nada.
   */
  leerDocumentos(archivos: ArchivoParaLeerAlta[], branch?: string | null): Observable<LeerDocumentosRespuesta> {
    return this.http.post<LeerDocumentosRespuesta>(`${this.base}/documentos`, { archivos, branch: branch ?? null });
  }

  /** `[ALC.4]` Ligas temporales a los archivos de los que salió una solicitud. */
  documentos(id: string): Observable<DocumentoDeSolicitud[]> {
    return this.http.get<DocumentoDeSolicitud[]>(`${this.base}/${id}/documentos`);
  }

  /** El PDF en data URI. La API lo lee, lo guarda y devuelve el prellenado; no crea nada. */
  subirConstancia(pdf: string, branch?: string | null): Observable<SubirConstanciaRespuesta> {
    return this.http.post<SubirConstanciaRespuesta>(`${this.base}/constancia`, { pdf, branch: branch ?? null });
  }

  revisar(body: SolicitudAltaBody): Observable<RevisionAlta> {
    return this.http.post<RevisionAlta>(`${this.base}/validate`, body);
  }

  crear(body: SolicitudAltaBody): Observable<CrearSolicitudRespuesta> {
    return this.http.post<CrearSolicitudRespuesta>(this.base, body);
  }

  bandeja(estado?: EstadoSolicitudAlta | null): Observable<BandejaAlta> {
    return this.http.get<BandejaAlta>(this.base, { params: estado ? new HttpParams().set('estado', estado) : undefined });
  }

  urlConstancia(id: string): Observable<{ url: string }> {
    return this.http.get<{ url: string }>(`${this.base}/${id}/constancia`);
  }

  decidirCredito(id: string, body: DecidirCreditoBody): Observable<SolicitudAlta> {
    return this.http.post<SolicitudAlta>(`${this.base}/${id}/credit`, body);
  }

  /** `[ALC.2.8]` Lo que se escribiría en Kepler y por qué no se puede todavía. No escribe. */
  planKepler(id: string): Observable<PlanAltaKepler> {
    return this.http.get<PlanAltaKepler>(`${this.base}/${id}/kepler`);
  }

  /** `[ALC.2.8]` Da de alta al cliente en las 10 bases de Kepler (sólo con la escritura encendida y la llave). */
  escribirEnKepler(id: string): Observable<SolicitudAlta> {
    return this.http.post<SolicitudAlta>(`${this.base}/${id}/kepler`, {});
  }

  /** Con `clave` vacía, la API usa la que la Suite escribió en Kepler (`[ALC.2.8]`). */
  ligar(id: string, clave: string): Observable<SolicitudAlta> {
    return this.http.post<SolicitudAlta>(`${this.base}/${id}/link`, { erp_customer_code: clave });
  }

  cancelar(id: string, motivo: string): Observable<SolicitudAlta> {
    return this.http.post<SolicitudAlta>(`${this.base}/${id}/cancel`, { motivo });
  }
}
