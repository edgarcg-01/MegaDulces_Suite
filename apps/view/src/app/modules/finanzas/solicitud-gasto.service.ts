import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { Observable } from 'rxjs';
import { environment } from '../../../environments/environment';
import type {
  AcreedorDeGasto, BandejaDeFacturasSat, CatalogoDeLaSolicitud, CrearSolicitudGastoDto, DescartarFacturaSatDto, DetalleDeFacturaSat,
  DetalleDeLaSolicitud, DisponibilidadDeLaSolicitud, DuplicadoProbable, EstadoKeplerDeLaSolicitud, FacturaDescartada, LecturaDelComprobante,
  PrecargaDeLaSolicitud, SolicitudGastoCreada, SucursalesAbiertasDeLaSolicitud,
} from '@megadulces/contracts';

/**
 * `[PGP.122]` — La solicitud de gasto que nace en la Suite (`/finance/expenses/solicitudes`). Las formas
 * viajan con los tipos del contrato compartido: son las mismas que valida el backend.
 */
@Injectable({ providedIn: 'root' })
export class SolicitudGastoService {
  private readonly http = inject(HttpClient);
  private readonly base = `${environment.apiUrl}/finance/expenses/solicitudes`;

  disponibilidad(sucursal: string): Observable<DisponibilidadDeLaSolicitud> {
    return this.http.get<DisponibilidadDeLaSolicitud>(`${this.base}/disponibilidad`, { params: new HttpParams().set('sucursal', sucursal) });
  }

  /** Las sucursales donde hoy se puede pedir: la pestaña sólo aparece donde hay algo que abrir. */
  abiertas(): Observable<SucursalesAbiertasDeLaSolicitud> {
    return this.http.get<SucursalesAbiertasDeLaSolicitud>(`${this.base}/abiertas`);
  }

  /** Lo que se escribe en Kepler al firmarla: Aprobación lo muestra antes del botón. */
  detalle(id: string): Observable<DetalleDeLaSolicitud> {
    return this.http.get<DetalleDeLaSolicitud>(`${this.base}/${encodeURIComponent(id)}/detalle`);
  }

  catalogo(sucursal: string): Observable<CatalogoDeLaSolicitud> {
    return this.http.get<CatalogoDeLaSolicitud>(`${this.base}/catalogo`, { params: new HttpParams().set('sucursal', sucursal) });
  }

  acreedores(sucursal: string, q: string, limit = 20): Observable<AcreedorDeGasto[]> {
    return this.http.get<AcreedorDeGasto[]>(`${this.base}/acreedores`, { params: new HttpParams().set('sucursal', sucursal).set('q', q).set('limit', String(limit)) });
  }

  precarga(sucursal: string, acreedor: string): Observable<PrecargaDeLaSolicitud> {
    return this.http.get<PrecargaDeLaSolicitud>(`${this.base}/precarga`, { params: new HttpParams().set('sucursal', sucursal).set('acreedor', acreedor) });
  }

  duplicados(sucursal: string, acreedor: string, total: number, fecha: string): Observable<DuplicadoProbable[]> {
    return this.http.get<DuplicadoProbable[]>(`${this.base}/duplicados`, {
      params: new HttpParams().set('sucursal', sucursal).set('acreedor', acreedor).set('total', String(total)).set('fecha', fecha),
    });
  }

  leerComprobante(sucursal: string, archivo: { public_id?: string; url?: string; kind?: string }): Observable<LecturaDelComprobante> {
    return this.http.post<LecturaDelComprobante>(`${this.base}/leer-comprobante`, { sucursal, archivo });
  }

  crear(dto: CrearSolicitudGastoDto): Observable<SolicitudGastoCreada> {
    return this.http.post<SolicitudGastoCreada>(this.base, dto);
  }

  reintentarKepler(id: string): Observable<EstadoKeplerDeLaSolicitud | null> {
    return this.http.post<EstadoKeplerDeLaSolicitud | null>(`${this.base}/${id}/reintentar-kepler`, {});
  }

  /** `[PGP.122]` F3 (DS40): cancela en Kepler la solicitud que escribió la Suite y cierra el vale. */
  cancelarEnKepler(id: string, motivo: string): Observable<EstadoKeplerDeLaSolicitud> {
    return this.http.post<EstadoKeplerDeLaSolicitud>(`${this.base}/${id}/cancelar-en-kepler`, { motivo });
  }

  // ── S.13 · La bandeja de facturas del SAT por registrar ─────────────────────────────────────────
  facturasSat(sucursal: string): Observable<BandejaDeFacturasSat> {
    return this.http.get<BandejaDeFacturasSat>(`${this.base}/facturas-sat`, { params: new HttpParams().set('sucursal', sucursal) });
  }

  facturaSat(uuid: string, sucursal: string): Observable<DetalleDeFacturaSat> {
    return this.http.get<DetalleDeFacturaSat>(`${this.base}/facturas-sat/${encodeURIComponent(uuid)}`, { params: new HttpParams().set('sucursal', sucursal) });
  }

  /** El XML tal cual (se descarga con el permiso de la bandeja de ESA sucursal, no con el de `/fiscal/cfdi`). */
  xmlDeFacturaSat(uuid: string, sucursal: string): Observable<Blob> {
    return this.http.get(`${this.base}/facturas-sat/${encodeURIComponent(uuid)}/xml`, { params: new HttpParams().set('sucursal', sucursal), responseType: 'blob' });
  }

  descartarFacturaSat(uuid: string, dto: DescartarFacturaSatDto): Observable<FacturaDescartada> {
    return this.http.post<FacturaDescartada>(`${this.base}/facturas-sat/${encodeURIComponent(uuid)}/descartar`, dto);
  }

  restaurarFacturaSat(uuid: string, sucursal: string): Observable<{ uuid: string; restaurada: true }> {
    return this.http.post<{ uuid: string; restaurada: true }>(`${this.base}/facturas-sat/${encodeURIComponent(uuid)}/restaurar`, { sucursal });
  }
}
