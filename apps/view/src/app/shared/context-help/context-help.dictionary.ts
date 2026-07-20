/**
 * DESIGN §P — Diccionario de negocio para la ayuda contextual (`<app-context-help>`).
 * FUENTE ÚNICA y versionada de las explicaciones de reglas/jerga por módulo. NO se
 * redactan descripciones ad-hoc en los templates: se agregan aquí. Cada `topic` = un
 * apartado; sus definiciones se muestran en el cajón lateral de ayuda.
 *
 * Definiciones ancladas al comportamiento real del sistema (backend libs/fiscal, etc.),
 * no inventadas.
 */
export interface HelpEntry { term: string; def: string; }
export interface HelpGroup { heading: string; entries: HelpEntry[]; }
export interface HelpTopic { title: string; intro?: string; groups: HelpGroup[]; }

export const CONTEXT_HELP: Record<string, HelpTopic> = {
  cfdi: {
    title: 'CFDI — ¿qué significan las claves?',
    intro: 'Comprobantes fiscales digitales (CFDI 4.0) del SAT. Aquí el significado de cada clave que ves en los filtros y la tabla.',
    groups: [
      {
        heading: 'Rol',
        entries: [
          { term: 'Recibidas', def: 'CFDI que tus proveedores te emitieron a ti (gastos y compras).' },
          { term: 'Emitidas', def: 'CFDI que tú emitiste a tus clientes (ventas).' },
        ],
      },
      {
        heading: 'Tipo de comprobante',
        entries: [
          { term: 'I — Ingreso', def: 'Factura de venta: dinero que entra (lo que cobras a un cliente).' },
          { term: 'E — Egreso', def: 'Nota de crédito: devoluciones, descuentos o bonificaciones sobre una factura previa.' },
          { term: 'P — Pago (REP)', def: 'Complemento de recepción de pagos: acredita el pago de una factura a crédito (PPD). No lleva importe propio.' },
          { term: 'N — Nómina', def: 'Recibo de nómina emitido a los empleados.' },
          { term: 'T — Traslado', def: 'Movimiento de mercancía sin venta (p. ej. entre sucursales o al transportista).' },
        ],
      },
      {
        heading: 'Método de pago',
        entries: [
          { term: 'PUE', def: 'Pago en Una sola Exhibición: se paga de contado al emitir. No genera complemento de pago.' },
          { term: 'PPD', def: 'Pago en Parcialidades o Diferido: es a crédito; cada pago posterior se documenta con un CFDI tipo P (REP).' },
        ],
      },
      {
        heading: 'Estatus ante el SAT',
        entries: [
          { term: 'Vigente', def: 'El CFDI está activo y es válido ante el SAT.' },
          { term: 'Cancelado', def: 'El emisor lo canceló; no tiene efectos fiscales.' },
          { term: 'Sin verificar', def: 'Aún no se ha consultado su estatus real ante el SAT.' },
        ],
      },
    ],
  },

  facturar: {
    title: 'Facturación — guía',
    intro: 'Emisión y timbrado de CFDI 4.0 vía PAC (SW/Conectia). Aquí el significado de cada opción.',
    groups: [
      {
        heading: 'Tipo de factura',
        entries: [
          { term: 'Global (mostrador)', def: 'Un solo CFDI a PÚBLICO EN GENERAL (XAXX010101000) que agrupa las ventas de mostrador del periodo. Lleva nodo de Información Global.' },
          { term: 'Nominativa', def: 'Factura a un cliente específico con sus datos fiscales (RFC, razón social, régimen, CP, uso de CFDI).' },
        ],
      },
      {
        heading: 'Método de pago',
        entries: [
          { term: 'PUE', def: 'Pago en Una Exhibición: se paga de contado al emitir.' },
          { term: 'PPD', def: 'Pago en Parcialidades o Diferido: a crédito; cada pago se documenta después con un REP.' },
        ],
      },
      {
        heading: 'Forma de pago (SAT)',
        entries: [
          { term: '01', def: 'Efectivo.' },
          { term: '03', def: 'Transferencia electrónica de fondos.' },
          { term: '04', def: 'Tarjeta de crédito.' },
          { term: '28', def: 'Tarjeta de débito.' },
          { term: '99', def: 'Por definir (habitual en PPD).' },
        ],
      },
      {
        heading: 'Motivo de cancelación (SAT)',
        entries: [
          { term: '01', def: 'Comprobante con errores CON relación: requiere el UUID del CFDI que lo sustituye.' },
          { term: '02', def: 'Comprobante con errores SIN relación (el más común).' },
          { term: '03', def: 'No se llevó a cabo la operación.' },
          { term: '04', def: 'Operación nominativa incluida en una factura global.' },
        ],
      },
      {
        heading: 'Notas',
        entries: [
          { term: 'NC (Egreso)', def: 'Nota de crédito: CFDI de Egreso relacionado (01) a una factura, para devoluciones/descuentos/bonificaciones.' },
          { term: 'REP', def: 'Complemento de recepción de pagos: acredita el pago de una factura a crédito (PPD).' },
        ],
      },
    ],
  },

  conciliacion: {
    title: 'Conciliación fiscal — guía',
    intro: 'Cruce determinista de lo descargado del SAT contra tus pagos y tu contabilidad. Solo cubre periodos ya descargados.',
    groups: [
      {
        heading: 'Vistas',
        entries: [
          { term: 'PUE/PPD ↔ REP', def: 'Verifica que las facturas a crédito (PPD) tengan su complemento de pago (REP) y sin saldo pendiente.' },
          { term: 'CFDI ↔ póliza', def: 'Cruza los CFDI descargados contra los gastos registrados en la contabilidad (heurístico).' },
        ],
      },
      {
        heading: 'Complementos de pago (REP)',
        entries: [
          { term: 'PUE', def: 'Pago en Una Exhibición: se pagó de contado; no requiere REP.' },
          { term: 'PPD', def: 'Pago en Parcialidades o Diferido: a crédito; cada pago debe documentarse con un REP.' },
          { term: 'PPD sin REP', def: 'Factura a crédito que aún no tiene su complemento de pago — hay que emitirlo/exigirlo.' },
          { term: 'Saldo insoluto', def: 'Parte de una factura PPD que todavía no se ha pagado (total − pagado).' },
        ],
      },
      {
        heading: 'Cruce CFDI ↔ póliza',
        entries: [
          { term: 'Gastos sin CFDI', def: 'Egreso registrado en la póliza sin un CFDI que lo respalde: riesgo de no poder deducir.' },
          { term: 'CFDI sin póliza', def: 'Comprobante recibido del SAT que aún no está registrado en la contabilidad.' },
        ],
      },
    ],
  },

  descarga: {
    title: 'Descarga masiva — ¿cómo funciona?',
    intro: 'Solicitudes de descarga de CFDI ante el SAT. El pipeline corre en segundo plano firmando con tu e.firma; el estado avanza solo.',
    groups: [
      {
        heading: 'Estado de la solicitud',
        entries: [
          { term: 'Nueva / Solicitada', def: 'Se registró y se pidió al SAT; esperando que la acepte.' },
          { term: 'En proceso', def: 'El SAT está generando los paquetes. Puede tardar minutos u horas.' },
          { term: 'Terminada', def: 'El SAT terminó de generar los paquetes; listos para descargar.' },
          { term: 'Descargada', def: 'Los paquetes se bajaron y sus CFDI ya están en el almacén.' },
          { term: 'Error / Rechazada / Vencida', def: 'La solicitud falló, el SAT la rechazó, o pasó la ventana de 72 h para descargar.' },
        ],
      },
      {
        heading: 'Requisitos',
        entries: [
          { term: 'e.firma', def: 'Se requiere la e.firma (FIEL) del RFC cargada en Credenciales para firmar la solicitud.' },
          { term: 'Ventana de 72 h', def: 'El SAT limita a 72 horas la descarga de los paquetes una vez generados.' },
        ],
      },
    ],
  },
};
