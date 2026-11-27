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
  /** `[CC.20.2]` La URL del PDF del estado de cuenta (se abre con un `<a>`: sin interceptor, sin sesión). */
  estadoCuentaUrl(token: string): string {
    return `${this.base}/${encodeURIComponent(token)}/estado-de-cuenta.pdf`;
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
  /** `[CC.21]` ¿Entró al banco? Sólo en las que esperan revisión. */
  banco?: FichaEnBanco | null;
}
/** `[CC.21]` Un abono del estado de cuenta que puede ser la ficha. */
export interface AbonoBanco {
  id: string; fecha: string; monto: number; banco: string; cuenta: string; declarado: string | null; en_cuenta?: boolean;
  cobros: { sucursal: string; folio: string; tipo: string; cliente_code: string | null; cliente_nombre: string | null }[] | null;
}
export type EstadoBanco = 'aplicado' | 'sin_aplicar' | 'de_otro_cliente' | 'varios' | 'no_aparece' | 'banco_sin_cargar' | 'sin_dato';
export interface FichaEnBanco {
  estado: EstadoBanco; cargado_hasta: string | null; abonos: AbonoBanco[];
  cobro: { sucursal: string; folio: string; cliente_code: string | null; cliente_nombre: string | null } | null;
  disputado_con: string | null;
}
export interface BandejaFichas {
  estado: string; por_estado: Record<string, number>; fichas: FichaClienteBandeja[];
  /** false = la consulta al banco falló (no es «no aparece»). */
  banco_medido?: boolean;
}
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
  /**
   * `[CC.31]` Que factura del cliente cuadra con este deposito. ⛔ No captura nada: el cobro lo da de alta una
   * persona en Kepler, que es donde se timbra (CC.26). Esto solo le quita el trabajo de BUSCARLA.
   */
  facturasQueCuadran(id: string): Observable<FacturasQueCuadran> {
    return this.http.get<FacturasQueCuadran>(`${this.base}/${encodeURIComponent(id)}/facturas-que-cuadran`);
  }

  /**
   * `[CC.33]` Si en esta sucursal se puede registrar el cobro desde la Suite. Se pregunta ANTES de ofrecer el
   * boton: un boton que falla ensena a desconfiar de todos.
   */
  cobroHabilitado(sucursal: string): Observable<{ habilitado: boolean; motivo?: string }> {
    return this.http.get<{ habilitado: boolean; motivo?: string }>(`${this.base}/cobro/habilitado/${encodeURIComponent(sucursal)}`);
  }

  /**
   * `[CC.33]` ⭐⭐ **Registra el cobro en Kepler.** Escribe el documento con su renglon de cartera, sus
   * aplicaciones y su poliza. ⛔ **No timbra**: el complemento de pago lo emite el programa de Kepler, y el
   * resultado lo dice (`timbrado: false`).
   */
  escribirCobro(id: string, facturas?: { doc_code: string; folio: string; monto: number }[]): Observable<ResultadoCobro> {
    return this.http.post<ResultadoCobro>(`${this.base}/${encodeURIComponent(id)}/escribir-cobro`, { facturas });
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
  /** `[CC.21]` Declara el abono (que el servidor vuelve a cruzar) como de este cliente. */
  declararAbono(id: string): Observable<{ ok: boolean; bank_movement_id: string; customer_code: string | null }> {
    return this.http.post<{ ok: boolean; bank_movement_id: string; customer_code: string | null }>(`${this.base}/${encodeURIComponent(id)}/abono`, {});
  }
}

/** `[CC.31]` Una factura viva del cliente, como la ve quien va a capturar el cobro en Kepler. */
export interface FacturaQueCuadra {
  doc_code: string; folio: string; importe: number; saldo: number;
  fecha: string | null; vencimiento: string | null;
}
/**
 * `[CC.31]` Que factura cuadra con el deposito. `modo` dice CUANTA CONFIANZA tiene la propuesta, que es la
 * diferencia entre ayudar y afirmar: `exacta` (una, al centavo) · `una_de_varias` (hay empate, elige la
 * persona) · `parcial` (ninguna sola cuadra; van las mas viejas para que decida).
 */
export interface FacturasQueCuadran {
  modo: 'exacta' | 'una_de_varias' | 'parcial';
  monto: number;
  facturas: FacturaQueCuadra[];
}

/**
 * `[CC.33]` Lo que contesta registrar el cobro en Kepler. ⛔ `timbrado` siempre llega en `false`: escribir las
 * tablas no emite el complemento de pago — eso lo hace el programa de Kepler. El tipo lo lleva encima para que
 * ninguna pantalla pueda decir «listo» sin decir tambien que falta el timbre.
 */
export interface CobroEscritoEnKepler {
  sucursal: string;
  folio: string;
  caja: string;
  poliza: number;
  tablaPoliza: string;
  facturas: number;
  total: number;
  saldos: { factura: string; antes: number; aplicado: number; despues: number }[];
  timbrado: false;
}
export type ResultadoCobro =
  | { estado: 'escrito'; ya_estaba?: boolean; kepler: CobroEscritoEnKepler }
  | { estado: 'apagado'; motivo: string }
  | { estado: 'rechazado'; motivo: string; reintentable: boolean };
