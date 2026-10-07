import { NuevoEmbarqueHoja, NuevoEmbarqueParada } from '../app/modules/logistica/logistica.service';

/**
 * EMB.12 — La hoja de «Nuevo embarque» de la guía 0001419 de Canindo (3-oct-2026), con los datos
 * REALES que devolvió Kepler (clientes con su código, choferes abreviados). Sirve a las pruebas
 * de las tres pantallas para que comprueben números que existen, no números inventados.
 */

const res = (nombre: string | null) => ({ codigo: nombre ? '01' : null, nombre, metodo: nombre ? 'exacto' as const : null });

function parada(
  folio: string, cli: string, ruta: string, rutaClave: string, orden: number, ciudad: string,
  total: number, cajas: number, sueltos: number, kg: number | null, facturado: boolean, nota: string,
): NuevoEmbarqueParada {
  return {
    serie: 1, serie_label: 'Embarque Telemarketing.', folio, folio_digital: `06UD4101-${folio}`, fecha: '2026-10-03',
    cliente_code: cli, destino_nombre: null, destino_colonia: null, destino_ciudad: ciudad, destino_estado: 'MICHOACAN',
    domicilio: '1', domicilio_supuesto: false, domicilio_calle: null, domicilio_ciudad: ciudad,
    ruta_clave: rutaClave, ruta_nombre: ruta, orden_visita: orden, ruta_metodo: 'domicilio',
    total, cajas, sueltos, kg, renglones: 1, renglones_sin_empaque: 0,
    facturacion: facturado ? 'F' : 'A', facturado, hora_captura: '12:55', nota_almacen: nota,
    pedido_folio: '0001105', pedido_folio_digital: null,
    surtio: res('JORGE'), checo: res('ANA GABRIELA C.'), embarco: res('JUAN MANUEL E.'),
  };
}

export function hojaGuia0001419(over: Partial<NuevoEmbarqueHoja> = {}): NuevoEmbarqueHoja {
  const paradas = [
    parada('0001052', 'C3098', 'JIQUILPAN', 'R0057', 2, 'CENTRO, JIQUILPAN', 54468.36, 67, 0, null, true, '67  CAJAS  B-4'),
    parada('0001053', 'C3098', 'JIQUILPAN', 'R0057', 2, 'CENTRO, JIQUILPAN', 2002.49, 5, 0, null, true, '5 CAJAS  C-5'),
    parada('0001058', 'C3079', 'SAHUAYO', 'R0039', 1, 'CENTRO, SAHUAYO', 38668.53, 43, 10, null, true, '43  CAJAS  1 PAQ.   A-4'),
    parada('0001059', 'C3078', 'SAHUAYO', 'R0039', 5, 'CENTRO, SAHUAYO', 9194.14, 18, 0, null, true, '18C B5'),
    parada('0001060', 'C3064', 'SAHUAYO', 'R0039', 6, 'JIQUILPAN', 3807.91, 3, 0, null, true, '3 CAJAS   A-4'),
    parada('0001051', 'C3051', 'SANTAGIO TANGAMNADAPIO', 'R0041', 1, 'SANTIAGO TANGAMANDAPIO', 12054.93, 10, 6, null, true, '10  CAJAS    A-1'),
    parada('0001061', 'C3054', 'VENUSTIANO CARRANZA', 'R0043', 1, 'CENTRO VENUSTIANO CARRANZA', 2752.66, 1, 33, null, true, '1  CAJA   2 PAQ.  C-5'),
    parada('0001062', 'C3054', 'VENUSTIANO CARRANZA', 'R0043', 1, 'CENTRO VENUSTIANO CARRANZA', 3459.73, 2, 26, 18, true, '26  CAJAS  2 PAQ.  B-3'),
    parada('0001054', 'C3080', 'VENUSTIANO CARRANZA', 'R0043', 2, 'VENUSTIANO CARRANZA', 1389.25, 0, 1, 21, true, '1  CAJA  A-1'),
    parada('0001055', 'C3080', 'VENUSTIANO CARRANZA', 'R0043', 2, 'VENUSTIANO CARRANZA', 24217.71, 24, 0, null, false, '24  CAJAS   B-3'),
    parada('0001056', 'C3080', 'VENUSTIANO CARRANZA', 'R0043', 2, 'VENUSTIANO CARRANZA', 305.86, 0, 9, null, true, '1 PAQ.  B-3'),
    parada('0001057', 'C3080', 'VENUSTIANO CARRANZA', 'R0043', 2, 'VENUSTIANO CARRANZA', 440.93, 1, 0, null, true, '1 CAJA   A-1'),
    parada('0001067', 'C3080', 'VENUSTIANO CARRANZA', 'R0043', 2, 'VENUSTIANO CARRANZA', 6833.7, 16, 0, null, true, '16  CAJAS   A-4'),
  ];
  return {
    viaje: {
      sucursal: '06', sucursal_nombre: 'Sucursal Canindo', guia: '0001419', guia_digital: '06-G0001419',
      fecha: '2026-10-03', hora_captura_desde: '10:23', hora_captura_hasta: '13:15',
      tipo: { tipo: 'entrega', etiqueta: 'Entrega a cliente', mixto: false, destinos: { cliente: 13, sucursal: 0, ruta: 0 } },
      multi_transporte: false, multi_chofer: false, multi_fecha: false,
    },
    unidad: {
      kepler_code: '00017', descripcion: 'FORD 450 GASOLINA SUPER DUTY', placas: 'NC-1134-D', metodo: 'exacto',
      vehicle_id: 'aaaaaaaa-0000-4000-8000-000000000017', suite: { plate: 'NC-1134-D', model: 'F-450', brand: 'FORD', status: 'disponible' },
      gps: false, motivo: 'La unidad no tiene rastreador: los km se capturan.',
    },
    chofer: {
      kepler_code: '00017', nombre: 'CESAR C.', metodo: 'exacto', asignado_a_la_unidad: 'CESAR C.',
      driver_id: 'bbbbbbbb-0000-4000-8000-000000000017', en_suite: true, falta: false, motivo: null,
    },
    responsables: { surtio: ['JORGE', 'JOSE RAMON'], checo: ['ANA GABRIELA C.'], embarco: ['JUAN MANUEL E.'], sin_resolver: 0 },
    paradas,
    resumen: {
      paradas: 13, clientes: 7,
      rutas: [
        { clave: 'R0057', nombre: 'JIQUILPAN', paradas: 2 },
        { clave: 'R0039', nombre: 'SAHUAYO', paradas: 3 },
        { clave: 'R0041', nombre: 'SANTAGIO TANGAMNADAPIO', paradas: 1 },
        { clave: 'R0043', nombre: 'VENUSTIANO CARRANZA', paradas: 7 },
      ],
      paradas_sin_ruta: 0, cajas: 190, sueltos: 85, kg_vendido_por_kilo: 39, peso_total: null,
      renglones_sin_empaque: 0, valor_venta: 159596.2, valor_traspaso: 0, facturadas: 12, paradas_a_cliente: 13,
    },
    comision: {
      driver: 98.04, helper: 57.76, regla: 'mayor_comision_del_viaje',
      ruta_usada: { clave: 'R0057', nombre: 'JIQUILPAN', route_id: 'cccccccc-0000-4000-8000-000000000057' },
      emparejadas: [
        { clave: 'R0057', nombre: 'JIQUILPAN', route_id: 'cccccccc-0000-4000-8000-000000000057', metodo: 'nombre', driver: 98.04, helper: 57.76 },
        { clave: 'R0039', nombre: 'SAHUAYO', route_id: 'cccccccc-0000-4000-8000-000000000039', metodo: 'nombre', driver: 92.88, helper: 51.68 },
        { clave: 'R0043', nombre: 'VENUSTIANO CARRANZA', route_id: 'cccccccc-0000-4000-8000-000000000043', metodo: 'nombre', driver: 77.4, helper: 48.64 },
      ],
      sin_tarifa: [{ clave: 'R0041', nombre: 'SANTAGIO TANGAMNADAPIO' }],
    },
    tomado: null,
    procedencia: {},
    ...over,
  };
}

/**
 * La guía con TODAS sus rutas tarifadas. La real trae SANTAGIO TANGAMNADAPIO sin tarifa, y desde
 * que la comisión se calcula (2026-10-07) eso frena la toma — es lo correcto, pero las pruebas de
 * lo que pasa cuando SÍ se puede crear necesitan una guía tarifada. La tarifa de SANTAGIO aquí es
 * SUPUESTA (menor que JIQUILPAN, así que la del viaje sigue siendo 98.04 / 57.76).
 */
export function conTarifaCompleta(h: NuevoEmbarqueHoja): NuevoEmbarqueHoja {
  return {
    ...h,
    comision: {
      ...h.comision,
      emparejadas: [
        ...h.comision.emparejadas,
        { clave: 'R0041', nombre: 'SANTAGIO TANGAMNADAPIO', route_id: 'cccccccc-0000-4000-8000-000000000041', metodo: 'kepler_code', driver: 87.72, helper: 54.72 },
      ],
      sin_tarifa: [],
    },
  };
}

/** La misma guía, pero como sale la unidad 00008 de Padre Hidalgo: sin chofer en Kepler. */
export function hojaSinChofer(): NuevoEmbarqueHoja {
  const h = hojaGuia0001419();
  return {
    ...h,
    chofer: {
      kepler_code: null, nombre: null, metodo: null, asignado_a_la_unidad: null, driver_id: null,
      en_suite: false, falta: true,
      motivo: 'Kepler no trae chofer: lo precarga de la unidad y esta unidad no tiene uno asignado.',
    },
  };
}
