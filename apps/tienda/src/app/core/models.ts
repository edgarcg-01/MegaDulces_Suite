// Formas de respuesta espejadas literal de apps/catalogo-kp/src/tienda/*.service.ts
// y catalogo.service.ts — no inventar campos, actualizar aquí si el backend cambia.

export interface UnidadTienda {
  unidad: string;
  etiqueta: string;
  piezas: number;
  precio: number;
  precio_sin_iva: number;
  precio_unitario: number;
}

export interface ProductoTienda {
  codigo: string;
  nombre: string;
  familia: string | null;
  marca: string | null;
  existencia: number;
  disponible: number;
  bajo_pedido: boolean;
  unidades: UnidadTienda[];
  desde: number;
}

export interface CatalogoTiendaResponse {
  sucursal: string;
  total: number;
  page: number;
  limit: number;
  paginas: number;
  envio: EnvioConfig;
  productos: ProductoTienda[];
}

export interface ProductoTiendaResult {
  ok: boolean;
  codigo?: string;
  error?: string;
  producto?: ProductoTienda;
}

export interface EnvioConfig {
  costo: number;
  gratis_desde: number;
  paqueterias: string[];
}

export interface TiendaConfig {
  sucursal: string;
  solo_mayoreo: boolean;
  envio: EnvioConfig;
}

export interface FiltroOpcion {
  codigo: string;
  nombre: string;
}

export interface CatalogoFiltros {
  familias: FiltroOpcion[];
  subfamilias: FiltroOpcion[];
  marcas: FiltroOpcion[];
}

// ── Carrito ──────────────────────────────────────────────────────────────────

export interface CarritoItem {
  id: number;
  codigo: string;
  nombre: string;
  unidad: string;
  etiqueta: string;
  cantidad: number;
  piezas_por_unidad: number;
  precio_unitario: number;
  importe: number;
  /** Aviso si cambió el precio o ya no hay existencia — nunca se reconcilia en silencio. */
  aviso: string | null;
}

export interface CarritoView {
  id: number;
  items: CarritoItem[];
  subtotal: number;
  envio: number;
  total: number;
  hay_avisos: boolean;
  cliente_nombre: string | null;
  cliente_email: string | null;
  cliente_tel: string | null;
}

export interface CarritoResult {
  ok: boolean;
  error?: string;
  token?: string;
  carrito?: CarritoView;
}

// ── Checkout ─────────────────────────────────────────────────────────────────

export interface MetodoPagoOpcion {
  clave: 'TARJETA' | 'OXXO' | 'SPEI';
  nombre: string;
  nota: string;
}

export interface CheckoutOpciones {
  envio: EnvioConfig;
  metodos_pago: MetodoPagoOpcion[];
  privacidad: { version: string };
  horario: { dias: string; de: string; a: string };
  atencion: string;
}

export interface DireccionEnvio {
  calle: string;
  numero: string;
  colonia: string;
  ciudad: string;
  estado: string;
  cp: string;
}

export interface DatosFiscales {
  rfc: string;
  razon_social: string;
  regimen: string;
  uso_cfdi: string;
  cp: string;
}

export interface CheckoutRequest {
  metodo_pago: string;
  direccion: DireccionEnvio;
  requiere_factura: boolean;
  datos_fiscales?: DatosFiscales;
  acepta_privacidad: true;
}

export interface CheckoutResult {
  ok: boolean;
  error?: string;
  folio?: string;
  seguimiento?: string;
  total?: number;
  metodo_pago?: string;
  siguiente_paso?: 'AUTORIZAR_PAGO' | 'ESPERAR_CONFIRMACION';
  confirmar_antes_de?: string;
  atencion?: string;
  mensaje?: string;
}

export interface PedidoItem {
  codigo: string;
  nombre: string;
  unidad: string;
  piezas_por_unidad: number;
  cantidad: number;
  precio_unitario: number;
  importe: number;
  cantidad_surtida: number | null;
}

export interface PedidoDetalle {
  folio: string;
  estado: string;
  estado_texto: string;
  creado_en: string;
  cliente: { nombre: string; email: string; tel: string };
  metodo_pago: string;
  entrega: string;
  direccion: DireccionEnvio | null;
  requiere_factura: boolean;
  datos_fiscales: DatosFiscales | null;
  subtotal: number;
  envio: number;
  total: number;
  confirmar_antes_de: string | null;
  confirmado_en: string | null;
  capturado_en: string | null;
  cancelado_motivo: string | null;
}

export interface PedidoResult {
  ok: boolean;
  error?: string;
  pedido?: PedidoDetalle;
  items?: PedidoItem[];
}

/** Lista cerrada de estados — espejo exacto de ESTADOS_MX en checkout.service.ts. */
export const ESTADOS_MX: string[] = [
  'AGUASCALIENTES', 'BAJA CALIFORNIA', 'BAJA CALIFORNIA SUR', 'CAMPECHE',
  'CHIAPAS', 'CHIHUAHUA', 'CIUDAD DE MEXICO', 'COAHUILA', 'COLIMA', 'DURANGO',
  'ESTADO DE MEXICO', 'GUANAJUATO', 'GUERRERO', 'HIDALGO', 'JALISCO',
  'MICHOACAN', 'MORELOS', 'NAYARIT', 'NUEVO LEON', 'OAXACA', 'PUEBLA',
  'QUERETARO', 'QUINTANA ROO', 'SAN LUIS POTOSI', 'SINALOA', 'SONORA',
  'TABASCO', 'TAMAULIPAS', 'TLAXCALA', 'VERACRUZ', 'YUCATAN', 'ZACATECAS',
];
