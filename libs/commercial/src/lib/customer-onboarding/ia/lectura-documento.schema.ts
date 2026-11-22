/**
 * `[ALC.4.1]` Lo que viaja al modelo junto con los archivos del cliente: el JSON Schema de la respuesta
 * (`output_config.format`) y el system prompt. Los dos son ESTABLES (sin fechas, ids, sucursal ni nombre
 * del cliente): el prefijo se cachea y el esquema se compila una vez del lado de la API.
 *
 * Plan: `FASE_ALC_ALTA_DE_CLIENTES.md` §4.2. Pedido de Francisco (2026-11-22): las altas llegan como
 * fotos de la constancia, capturas de Wincaja o de otro sistema, etiquetas y facturas viejas, no sólo
 * como el PDF del SAT; *«privilegiando la transformación digital a través de la IA»*.
 *
 * ⛔ **Sin uniones.** Structured outputs admite a lo más 16 parámetros con `anyOf`/`null` en todo el
 * esquema (lo documentó NP.7, `lector-foto.schema.ts`). Aquí hay CERO: todo campo es texto y «no se ve»
 * es `""`. `lecturaDocumentoDesdeModelo` convierte el vacío en ausente (regla 11: nunca un relleno).
 * ⛔ **El modelo no decide nada**: copia. El dígito verificador del RFC y de la CURP, el catálogo del SAT
 * (régimen, uso de CFDI, forma de pago) y el estado del CP los revisa el código después, no el modelo.
 */

type Esquema = Record<string, unknown>;

const texto: Esquema = { type: 'string' };
const enumerado = (valores: readonly string[]): Esquema => ({ type: 'string', enum: [...valores] });
const lista = (items: Esquema): Esquema => ({ type: 'array', items });

/** Objeto cerrado: todas sus propiedades requeridas y nada extra (lo exige structured outputs). */
function objeto(propiedades: Record<string, Esquema>): Esquema {
  return { type: 'object', properties: propiedades, required: Object.keys(propiedades), additionalProperties: false };
}

export const TIPOS_DOCUMENTO_ALTA = [
  'constancia_sat', 'factura_cfdi', 'captura_de_sistema', 'etiqueta_o_nota', 'identificacion', 'otro',
] as const;
export type TipoDocumentoAlta = (typeof TIPOS_DOCUMENTO_ALTA)[number];

/** Los campos que el modelo copia. Todos texto; `""` = no aparece en ningún archivo. */
export const CAMPOS_LEIDOS = [
  'rfc', 'curp', 'nombres', 'primer_apellido', 'segundo_apellido', 'razon_social', 'regimen_capital',
  'nombre_comercial', 'codigo_postal', 'tipo_vialidad', 'vialidad', 'numero_exterior', 'numero_interior',
  'colonia', 'localidad', 'municipio', 'entidad', 'entre_calle', 'y_calle', 'email', 'telefono',
  'uso_cfdi', 'forma_pago', 'metodo_pago', 'clave_en_otro_sistema', 'fecha_emision',
] as const;
export type CampoLeido = (typeof CAMPOS_LEIDOS)[number];

export const ESQUEMA_LECTURA_ALTA: Esquema = objeto({
  // Primero lo que dice si sirve; después la copia; al final la duda.
  tipo_documento: enumerado(TIPOS_DOCUMENTO_ALTA),
  legible: enumerado(['si', 'parcial', 'no']),
  tipo_persona: enumerado(['fisica', 'moral', 'no_se']),
  ...Object.fromEntries(CAMPOS_LEIDOS.map((c) => [c, texto])),
  regimenes: lista(objeto({ descripcion: texto, vigente: enumerado(['si', 'no', 'no_se']) })),
  dudosos: lista(enumerado(CAMPOS_LEIDOS)),
  avisos: lista(texto),
});

export const SYSTEM_LECTURA_ALTA = [
  'Lees los documentos que un cliente de una distribuidora de dulces en México entregó para darse de alta y',
  'facturarle: la Constancia de Situación Fiscal del SAT (una o varias hojas, en PDF, foto o captura del celular),',
  'una factura CFDI vieja, la captura de pantalla de otro sistema (punto de venta o ERP) o una etiqueta o nota',
  'con sus datos. Varias imágenes son del MISMO cliente (por ejemplo, las dos hojas de la constancia): júntalas en',
  'una sola respuesta.',
  '',
  'Reglas:',
  '1. Extrae los datos del CLIENTE. En una factura el cliente es el RECEPTOR, nunca el emisor (quien vende).',
  '2. Copia lo que se ve, carácter por carácter. No completes, no corrijas y no deduzcas: un RFC o una CURP que no',
  '   se lee completa va vacía y en «dudosos». Nunca armes el RFC ni la CURP con el nombre o la fecha.',
  '3. Vacío ("") = no aparece en ningún archivo. No escribas «N/A», «DESCONOCIDO» ni otro relleno. Si el documento',
  '   dice algo como «SIN NUMERO», cópialo tal cual.',
  '4. Persona física: nombre(s) y apellidos por separado cuando el documento los separa; si sólo trae el nombre',
  '   completo, va entero en «nombres». Persona moral: la razón social en «razon_social», sin el régimen de capital',
  '   («SA DE CV» va en «regimen_capital»).',
  '5. Régimen fiscal: cada régimen tal como lo escribe el documento (con su clave si la trae), y «vigente» = no si',
  '   tiene fecha de fin.',
  '6. Uso de CFDI, forma de pago y método de pago: tal como aparecen (texto o clave: «G03 Gastos en general»,',
  '   «Efectivo», «PUE»).',
  '7. «clave_en_otro_sistema»: el número o clave de cliente que muestra otro sistema («NoCliente», «Clave»).',
  '8. «fecha_emision»: la fecha de emisión de la constancia como AAAA-MM-DD; vacío si no es una constancia.',
  '9. Las fotos pueden venir giradas, de cabeza, borrosas o con reflejos: léelas igual. Lo que no leas con',
  '   seguridad, ponlo en «dudosos».',
  '10. «avisos»: frases cortas con lo que quien revisa debe saber (por ejemplo, «las hojas son de dos RFC',
  '   distintos», «la constancia es de 2023», «la etiqueta no trae código postal»).',
].join('\n');
