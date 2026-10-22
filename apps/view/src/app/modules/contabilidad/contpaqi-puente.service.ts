import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { environment } from '../../../environments/environment';

/**
 * `[CP.8.33]` — Cliente de **la bandeja del puente** (`/contabilidad/contpaqi-puente`).
 *
 * ⚠️ No confundir con `contabilidad-contpaqi.service.ts`, que es el otro sentido: ése LEE los
 * libros fiscales que ya están en ContPAQi (balanza, bancos, EFOS). Éste mira la **ida**: qué
 * saldría de póliza desde los egresos de banco, y qué no sale y por qué.
 *
 * ⛔ Todo es de SOLO LECTURA salvo `confirmarAlias` y `entregar` (`[CP.8.54]`), que exigen
 * `_GESTIONAR`. `entregar` no manda nada a ContPAQi: registra que contabilidad ya lo cargó.
 */
@Injectable({ providedIn: 'root' })
export class ContpaqiPuenteService {
  private readonly http = inject(HttpClient);
  private readonly base = `${environment.apiUrl}/finance/contpaqi`;

  lotes(mes?: string): Observable<LotesResp> {
    const qs = mes ? `?mes=${encodeURIComponent(mes)}` : '';
    return this.http.get<LotesResp>(`${this.base}/lotes${qs}`);
  }

  /**
   * `[CP.8.37]` Lo que falta enlazar, agrupado por nombre y ordenado por dinero.
   * ⚠️ Es `_VER`: mirar el trabajo pendiente no es hacerlo.
   */
  pendientes(mes?: string): Observable<PendientesResp> {
    const qs = mes ? `?mes=${encodeURIComponent(mes)}` : '';
    return this.http.get<PendientesResp>(`${this.base}/proveedores-pendientes${qs}`);
  }

  /** Confirma que un concepto del banco carga a una cuenta. Exige `_GESTIONAR`. */
  confirmarAlias(body: { concepto_banco: string; cuenta: string; rubro?: string; nota?: string }) {
    return this.http.post<{ alias_normalizado: string; cuenta: string }>(`${this.base}/alias-proveedor`, body);
  }

  /**
   * `[CP.8.38]` El TXT del mes. ⛔ Generar NO es entregar: el backend no escribe
   * `poliza_exports`, así que esto no arranca el reloj del cuadre.
   */
  archivo(mes: string): Observable<Blob> {
    return this.http.get(`${this.base}/archivo?mes=${encodeURIComponent(mes)}`, { responseType: 'blob' });
  }

  /**
   * `[CP.8.54]` «Ya lo cargué en ContPAQi». Manda el MISMO archivo que se importó; el backend lo
   * compara byte a byte con el que genera hoy y responde 409 si no es ése. Exige `_GESTIONAR`.
   */
  entregar(mes: string, archivoBase64: string): Observable<EntregaResp> {
    return this.http.post<EntregaResp>(`${this.base}/entregas`, { mes, archivo_base64: archivoBase64 });
  }

  /** `[CP.8.14]` Las reglas de cuenta con su evidencia y lo que traban en el mes. `_VER`. */
  reglas(mes: string): Observable<ReglasResp> {
    return this.http.get<ReglasResp>(`${this.base}/reglas?mes=${encodeURIComponent(mes)}`);
  }

  /** Las cuentas de gasto `52*` afectables que puede llevar una regla por categoría. */
  cuentasGasto(): Observable<{ cuentas: CuentaGasto[] }> {
    return this.http.get<{ cuentas: CuentaGasto[] }>(`${this.base}/cuentas-gasto`);
  }

  /** ⛔ Firmar es del contador: `_GESTIONAR`, y queda su nombre. */
  firmarRegla(categoria: string, cuenta: string): Observable<ReglaVista> {
    return this.http.post<ReglaVista>(`${this.base}/reglas/${encodeURIComponent(categoria)}/firma`, { cuenta });
  }

  revocarRegla(categoria: string): Observable<ReglaVista> {
    return this.http.post<ReglaVista>(`${this.base}/reglas/${encodeURIComponent(categoria)}/revocar`, {});
  }

  /** `[CP.8.73]` Los pagos a proveedor del mes que esperan confirmar qué facturas pagan. */
  pagosPorConfirmar(mes: string): Observable<{ mes: string; pagos: PagoPorConfirmar[] }> {
    return this.http.get<{ mes: string; pagos: PagoPorConfirmar[] }>(`${this.base}/pagos-por-confirmar?mes=${encodeURIComponent(mes)}`);
  }

  /** `[CP.8.73]` 409 con el motivo si no cuadra o las facturas no son del proveedor. */
  confirmarPago(movimiento: string, facturas: string[], notas: string[]): Observable<{ movimiento_id: string; renglones: number; total: number; redondeo: number }> {
    return this.http.post<{ movimiento_id: string; renglones: number; total: number; redondeo: number }>(
      `${this.base}/pagos/${encodeURIComponent(movimiento)}/confirmar`, { facturas, notas });
  }

  desconfirmarPago(movimiento: string): Observable<{ movimiento_id: string; apagadas: number }> {
    return this.http.post<{ movimiento_id: string; apagadas: number }>(`${this.base}/pagos/${encodeURIComponent(movimiento)}/desconfirmar`, {});
  }

  /**
   * `[CP.8.77]`/`[CP.8.78]` Los movimientos detrás de cualquier cifra, o los que coinciden con una búsqueda
   * (`q`: concepto, razón social, RFC, banco). Los filtros se suman. `_VER`.
   */
  movimientos(mes: string, filtro: FiltroMovimientos): Observable<MovimientosResp> {
    const qs = new URLSearchParams({ mes });
    for (const [k, v] of Object.entries(filtro)) {
      if (v === undefined || v === null || v === '') continue;
      qs.set(k, typeof v === 'boolean' ? (v ? '1' : '0') : String(v));
    }
    return this.http.get<MovimientosResp>(`${this.base}/movimientos?${qs.toString()}`);
  }

  cuadre(): Observable<CuadreResp> {
    return this.http.get<CuadreResp>(`${this.base}/cuadre`);
  }
}

/** Un lote = una póliza candidata, al grano real: **(cuenta de banco × día)**. */
export interface LoteRow {
  cuenta_banco: string;
  /** Cómo lo nombra finanzas (`BBAJIO 4166`). Viaja ADEMÁS de la cuenta, no en vez de ella. */
  banco_label: string | null;
  fecha: string;
  movimientos: number;
  incluidas: number;
  renglones: number;
  total: number;
  iva_traspaso: 'no_emitido' | null;
  /** Conteo POR motivo. Cuatro rechazos distintos tienen cuatro dueños distintos. */
  motivos: Record<string, number>;
  /** `[CP.8.72]` `pago_proveedor` = un pago a proveedor armado completo (una póliza por pago). Ausente = lote del día. */
  tipo?: 'lote' | 'pago_proveedor';
  /** De dónde salieron las facturas del pago: la cadena de Kepler o una factura por importe. */
  fuente?: 'cadena_kepler' | 'importe_una' | 'confirmada' | null;
  /** UUID (facturas y notas) que lleva el pago. */
  cfdis?: number;
  /** Identidad de la fila: un pago y el lote de su día comparten banco y fecha. */
  clave?: string;
}

/** `[CP.8.73]` Un CFDI candidato para confirmar un pago. */
export interface CfdiPropuesto {
  uuid: string;
  folio: string | null;
  fecha: string;
  total: number;
  /** Fecha de una póliza de pago anterior que ya lo trae: se advierte, no se oculta. */
  pagada_antes?: string | null;
}

/** `[CP.8.73]` Un pago a proveedor que no se armó solo, con su propuesta. */
export interface PagoPorConfirmar {
  movimiento_id: string;
  fecha: string;
  cuenta_banco: string;
  banco_label: string | null;
  importe: number;
  concepto: string;
  motivo: string;
  propuesta: {
    rfc: string;
    proveedor_por_nombre: boolean;
    pagado: number;
    facturas: CfdiPropuesto[];
    notas: CfdiPropuesto[];
    /** ⛔ Nunca se preselecciona: la pantalla ofrece «usar la sugerencia». */
    sugerencia: string[];
    origen: 'kepler' | 'importe' | null;
  } | null;
  confirmacion: { facturas: string[]; notas: string[]; confirmado_por: string; vigente: boolean } | null;
}

/**
 * `[CP.8.34]` Lo que no entra a ningún lote, con nombre e importe.
 * Medido en enero: `CAJA CG` (864) y `FACTORAJE FAC` (12) — **no son bancos**, no les falta
 * un mapeo. Se declara para que `movimientos` no se lea como el universo del mes.
 */
export interface FueraDeLote {
  movimientos: number;
  importe: number;
  cuentas: { cuenta: string; movimientos: number; importe: number }[];
}

export interface LotesResp {
  mes: string;
  lotes: LoteRow[];
  resumen: {
    lotes: number;
    con_asiento: number;
    movimientos: number;
    incluidas: number;
    universo: number;
  };
  fuera_de_lote: FueraDeLote;
  /** Ya viene ordenado de mayor a menor: lo primero que se ve es lo que más trabajo representa. */
  motivos: { motivo: string; movimientos: number; dueno: string }[];
}

/** `[CP.8.53]` Una regla como la ve el contador (espejo de `ReglaVista` del backend). */
export interface ReglaVista {
  categoria_code: string;
  tipo_regla: string;
  estado: string;
  tiene_fila: boolean;
  cuenta_gasto: string | null;
  cuenta_nombre: string | null;
  aprobada_por: string | null;
  aprobada_en: string | null;
  firmable: boolean;
  motivo_no_firmable: string | null;
  /** ⛔ Indicio del derivador. Nunca se preselecciona. */
  indicio: string | null;
  evidencia: string | null;
  salvedad: string | null;
  pareados: number | null;
  movimientos_mes: number;
  importe_mes: number;
}

export interface ReglasResp {
  mes: string;
  reglas: ReglaVista[];
}

export interface CuentaGasto {
  codigo: string;
  nombre: string;
}

/** `[CP.8.52]` Lo que se registró. `ya_registradas` = marcar dos veces no duplica. */
export interface EntregaResp {
  mes: string;
  polizas: number;
  nuevas: number;
  ya_registradas: number;
  total: number;
  archivo_sha256: string;
}

/** `[CP.8.77]` Espejo de `MovimientoVista` del backend. */
export interface MovimientoBanco {
  id: string;
  fecha: string;
  banco: string | null;
  concepto: string;
  importe: number;
  iva: number | null;
  categoria: string | null;
  categoria_nombre: string | null;
  /** La llave del nombre del banco (la de proveedores pendientes). */
  nombre: string;
  /** Sólo si se identificó; `null` = no se sabe. */
  razon_social: string | null;
  rfc: string | null;
  /** Por qué no entra al archivo; `null` = entra. */
  motivo: string | null;
  /** La póliza donde entra o se cuenta (la `clave` del lote o del pago). */
  poliza: string | null;
}

/** `[CP.8.78]` Los filtros del desglose y del buscador; se suman. */
export interface FiltroMovimientos {
  categoria?: string; nombre?: string; motivo?: string; poliza?: string; entra?: boolean; espera?: boolean; q?: string;
}

export interface MovimientosResp {
  mes: string;
  filas: MovimientoBanco[];
  total: number;
  /** Con `q`: en qué otros meses aparece, por el texto del banco. */
  otros_meses: { mes: string; movimientos: number }[];
}

export interface CuadreResp {
  /**
   * ⭐ `false` = **nunca se entregó nada**. Sin esto, un `0 %` de cuadre se lee como "falla"
   * cuando lo que pasa es que el denominador es cero (ADR-056).
   */
  hay_entregas: boolean;
  por_estado: Record<string, number>;
  verificadas: number;
  esperando: number;
  divergentes: number;
  plazo_dias: number;
}

/** `[CP.8.37]` Un nombre del banco que todavía no llega a una cuenta, con sus pistas. */
export interface PendienteProveedor {
  alias_normalizado: string;
  concepto_banco: string;
  movimientos: number;
  importe: number;
  veredicto: string;
  motivo: string | null;
  rubro: string;
  /** ⛔ Pistas por palabras en común. La pantalla NO las aplica sola. */
  sugerencias: { cuenta: string; nombre: string; veredicto: string; parecido: number }[];
}

export interface PendientesResp {
  mes: string;
  total_importe: number;
  filas: PendienteProveedor[];
}
