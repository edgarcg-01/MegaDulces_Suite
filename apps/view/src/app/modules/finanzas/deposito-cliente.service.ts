import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { environment } from '../../../environments/environment';

/** `[CC.20]` Una ficha que el cliente ya envió, tal como la ve él (su estado y, si se rechazó, el motivo). */
export interface FichaEnviada {
  id: string;
  status: 'recibido' | 'validado' | 'rechazado';
  motivo_rechazo: string | null;
  monto: number | null;
  fecha: string | null;
  enviado: string;
  aplicado: boolean;
}
export interface ContextoDeposito { cliente: string; sucursal: string | null; fichas: FichaEnviada[] }
export interface ArchivoSubido { url: string; kind?: string; role?: string; sha256?: string }
/** Lo que leyó el servidor en la ficha: una PROPUESTA para llenar los campos, editable. */
export interface LecturaFicha {
  monto: number | null; fecha: string | null; banco: string | null; referencia: string | null;
  ocr_status: string; sha256: string;
}

/**
 * `[CC.20]` La superficie PÚBLICA del depósito del cliente: sin sesión, autorizada por el token del enlace.
 * `authInterceptor` exceptúa `/finance/deposito` (no pega ni pierde sesión aquí).
 */
@Injectable({ providedIn: 'root' })
export class DepositoClienteService {
  private readonly http = inject(HttpClient);
  private readonly base = `${environment.apiUrl}/finance/deposito`;

  contexto(token: string): Observable<ContextoDeposito> {
    return this.http.get<ContextoDeposito>(`${this.base}/${encodeURIComponent(token)}`);
  }
  subir(token: string, dataUri: string): Observable<ArchivoSubido> {
    return this.http.post<ArchivoSubido>(`${this.base}/${encodeURIComponent(token)}/subir`, { file_base64: dataUri });
  }
  leer(token: string, dataUri: string): Observable<LecturaFicha> {
    return this.http.post<LecturaFicha>(`${this.base}/${encodeURIComponent(token)}/leer`, { file_base64: dataUri });
  }
  enviar(token: string, body: { files: ArchivoSubido[]; monto: number; fecha: string; nota?: string }): Observable<{ id: string; status: string; ya_estaba: boolean }> {
    return this.http.post<{ id: string; status: string; ya_estaba: boolean }>(`${this.base}/${encodeURIComponent(token)}`, body);
  }
}

/** `[CC.20]` Una ficha que subió un cliente, en la bandeja de Cobranza. */
export interface FichaClienteBandeja {
  id: string; status: 'recibido' | 'validado' | 'rechazado';
  cuenta_sucursal: string | null; cliente_code: string | null; cliente_nombre: string | null;
  files: { url: string; kind?: string }[]; sucursal: string | null; folio: string | null;
  monto: number | null; fecha: string | null; nota: string | null;
  ocr_monto: number | null; ocr_fecha: string | null; ocr_banco: string | null; ocr_referencia: string | null;
  ocr_status: string | null; monto_match: boolean | null; motivo_rechazo: string | null;
  validated_by: string | null; validated_at: string | null; enviado: string;
}
export interface BandejaFichas { estado: string; por_estado: Record<string, number>; fichas: FichaClienteBandeja[] }
export interface CobroCandidato {
  sucursal: string; folio: string; cobro_date: string | null; cliente_code: string | null; cliente_nombre: string | null;
  forma_pago: string | null; monto: number; deposits: number; del_cliente: boolean;
}

/** `[CC.20]` El lado de Cobranza: la bandeja de fichas que subieron los clientes. */
@Injectable({ providedIn: 'root' })
export class FichasClientesService {
  private readonly http = inject(HttpClient);
  private readonly base = `${environment.apiUrl}/finance/collections/clientes`;

  bandeja(estado: string): Observable<BandejaFichas> {
    return this.http.get<BandejaFichas>(this.base, { params: { estado } });
  }
  candidatos(id: string): Observable<{ cobros: CobroCandidato[] }> {
    return this.http.get<{ cobros: CobroCandidato[] }>(`${this.base}/${encodeURIComponent(id)}/candidatos`);
  }
  ligar(id: string, sucursal: string, folio: string): Observable<{ id: string; status: string }> {
    return this.http.post<{ id: string; status: string }>(`${this.base}/${encodeURIComponent(id)}/ligar`, { sucursal, folio });
  }
  rechazar(id: string, motivo: string): Observable<{ id: string; status: string }> {
    return this.http.post<{ id: string; status: string }>(`${this.base}/${encodeURIComponent(id)}/rechazar`, { motivo });
  }
}
