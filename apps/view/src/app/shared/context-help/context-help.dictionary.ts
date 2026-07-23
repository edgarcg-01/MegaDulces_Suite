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
/** Bloque "cómo se resuelve": pasos accionables. kind='fix' = se corrige (en Kepler/aquí);
 *  kind='info' = no requiere acción (se explica por qué). */
export interface HelpResolveBlock { heading: string; kind?: 'fix' | 'info'; intro?: string; steps: string[]; }
export interface HelpTopic { title: string; intro?: string; groups?: HelpGroup[]; resolve?: HelpResolveBlock[]; }

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

  diagnostico: {
    title: 'Diagnóstico de facturación — guía',
    intro: 'Errores de timbrado/cancelación/REP traducidos con la base de conocimiento SAT/PAC, con su causa y solución.',
    groups: [
      {
        heading: 'Tipo de error',
        entries: [
          { term: 'Timbrado', def: 'Falló el sellado/timbrado de una factura ante el PAC/SAT.' },
          { term: 'Nota de crédito', def: 'Falló la emisión de un CFDI de Egreso (devolución/descuento).' },
          { term: 'Complemento de pago (REP)', def: 'Falló la emisión del complemento que acredita el pago de una PPD.' },
          { term: 'Cancelación', def: 'Falló la solicitud de cancelación de un CFDI ante el SAT.' },
        ],
      },
      {
        heading: 'Severidad',
        entries: [
          { term: 'Crítico', def: 'Bloquea la operación fiscal; requiere atención inmediata.' },
          { term: 'Aviso', def: 'Debe resolverse pero no bloquea del todo.' },
          { term: 'Info', def: 'Informativo; útil para contexto.' },
        ],
      },
      {
        heading: 'Cómo funciona',
        entries: [
          { term: 'Auto-registro', def: 'Cada error se registra solo cuando falla un timbrado/cancelación/REP.' },
          { term: 'Auto-resolución', def: 'Se marca resuelto cuando un intento posterior tiene éxito.' },
          { term: 'Reintentar', def: 'Vuelve a intentar el timbrado de los pedidos pendientes; es idempotente (no duplica).' },
        ],
      },
    ],
  },

  diot: {
    title: 'DIOT / IVA — guía',
    intro: 'Declaración Informativa de Operaciones con Terceros + resumen de IVA, calculado con flujo efectivo sobre los CFDI.',
    groups: [
      {
        heading: 'Tipo de tercero',
        entries: [
          { term: '04 Nacional', def: 'Proveedor con RFC mexicano.' },
          { term: '05 Extranjero', def: 'Proveedor del extranjero (sin RFC mexicano).' },
          { term: '15 Global', def: 'Operaciones agrupadas con público en general.' },
        ],
      },
      {
        heading: 'IVA',
        entries: [
          { term: 'IVA trasladado', def: 'El IVA que cobras en tus ventas (emitidas).' },
          { term: 'IVA acreditable', def: 'El IVA que pagas en tus compras y puedes descontar (recibidas).' },
          { term: 'IVA a cargo', def: 'Trasladado − acreditable, cuando es positivo: es lo que pagas al SAT.' },
          { term: 'IVA a favor', def: 'Cuando el acreditable supera al trasladado: queda saldo a favor.' },
        ],
      },
      {
        heading: 'Flujo efectivo',
        entries: [
          { term: 'PUE', def: 'Pago en Una Exhibición: el IVA cuenta en el mes de emisión.' },
          { term: 'PPD', def: 'Parcialidades/Diferido: el IVA cuenta cuando se paga (al recibirse el REP), no al emitir.' },
        ],
      },
    ],
  },

  impuestos: {
    title: 'Impuestos provisionales — guía',
    intro: 'Cálculo de APOYO del pago provisional mensual (ISR + IVA). Siempre valida con tu contador antes de declarar.',
    groups: [
      {
        heading: 'ISR provisional',
        entries: [
          { term: 'Coeficiente de utilidad', def: 'Factor de tu declaración anual del año pasado; estima la utilidad a partir de los ingresos (ingresos × coeficiente).' },
          { term: 'Ingresos nominales acum.', def: 'Ingresos del ejercicio acumulados hasta el mes, sin ajuste inflacionario.' },
          { term: 'Base gravable', def: 'Utilidad estimada − PTU pagada − pérdidas pendientes. Sobre esto se aplica la tasa.' },
          { term: 'PTU pagada', def: 'Participación de los Trabajadores en las Utilidades pagada en el año; se resta de la base.' },
          { term: 'Pérdidas pendientes', def: 'Pérdidas fiscales de años anteriores por amortizar; se restan de la base.' },
          { term: 'Tasa ISR', def: 'Tasa aplicable (30% para personas morales).' },
          { term: 'Pagos previos / retenido', def: 'Pagos provisionales de meses anteriores e ISR que te retuvieron; se acreditan contra el ISR causado.' },
        ],
      },
      {
        heading: 'IVA (flujo efectivo)',
        entries: [
          { term: 'IVA trasladado', def: 'El IVA que cobraste y que efectivamente se pagó (PUE, o PPD con REP).' },
          { term: 'IVA acreditable', def: 'El IVA que pagaste en compras y puedes descontar.' },
          { term: 'IVA a cargo / a favor', def: 'Trasladado − acreditable − retenido: si es positivo pagas al SAT; si es negativo queda a favor.' },
        ],
      },
    ],
  },

  materialidad: {
    title: 'Materialidad — guía',
    intro: 'Expediente de defensa por proveedor: demuestra que la operación fue real. Crítico si el proveedor aparece en listas negras del SAT.',
    groups: [
      {
        heading: 'Listas negras del SAT',
        entries: [
          { term: 'EFOS 69-B', def: 'Empresas que Facturan Operaciones Simuladas: el SAT presume que sus facturas son falsas. Comprar a un EFOS pone en riesgo tu deducción.' },
          { term: 'Art. 69', def: 'Contribuyentes con incumplimientos publicados (no localizados, créditos firmes, etc.).' },
        ],
      },
      {
        heading: 'Cadena de suministro',
        entries: [
          { term: 'Orden → Recepción → Factura → Pago', def: 'La secuencia que prueba que la operación existió.' },
          { term: 'Recepción', def: 'La entrada física a almacén: es la evidencia MÁS fuerte de materialidad.' },
          { term: 'Materialidad', def: 'Demostrar con documentos y hechos que el bien/servicio realmente se recibió y se pagó.' },
        ],
      },
      {
        heading: 'Conciliación CFDI ↔ operación',
        entries: [
          { term: 'Confirmada', def: 'Ligaste el CFDI a una operación real: cuenta como evidencia.' },
          { term: 'Sugerida', def: 'El motor propone el enlace por RFC + importe (±$1) + fecha (±5 días); falta que confirmes.' },
          { term: 'Match débil / sin RFC', def: 'La operación no trae RFC; se cruzó solo por importe+fecha. Verifica el nombre antes de confirmar.' },
          { term: 'Sin operación', def: 'No hay operación que respalde el CFDI en el rango: es un riesgo.' },
        ],
      },
      {
        heading: 'Veredicto',
        entries: [
          { term: 'Sólida / Revisar / Crítico', def: 'Nivel de defensa del expediente según listas negras, % de recepción física y completitud de la cadena.' },
        ],
      },
    ],
  },

  credenciales: {
    title: 'Credenciales SAT — guía',
    intro: 'Bóveda de la e.firma para autorizar la descarga masiva del SAT. El material privado se cifra y nunca se devuelve por la API.',
    groups: [
      {
        heading: 'Qué es cada cosa',
        entries: [
          { term: 'e.firma (FIEL)', def: 'Firma Electrónica Avanzada: identifica al contribuyente ante el SAT. Autoriza la descarga masiva de CFDI. (No es el CSD del timbrado, ese vive en el PAC.)' },
          { term: '.cer', def: 'El certificado (parte pública) de la e.firma.' },
          { term: '.key', def: 'La llave privada de la e.firma — el material secreto; se cifra en reposo.' },
          { term: 'Contraseña de la llave', def: 'La clave que protege el archivo .key.' },
          { term: 'CIEC', def: 'Clave de acceso al portal web del SAT (usuario/contraseña). Opcional aquí.' },
        ],
      },
      {
        heading: 'Estado',
        entries: [
          { term: 'Vigente / Vencida', def: 'Si el certificado sigue válido según su fecha de vencimiento.' },
          { term: 'Días', def: 'Días restantes antes de que venza el certificado (se marca en rojo si faltan menos de 30).' },
        ],
      },
      {
        heading: 'Seguridad',
        entries: [
          { term: 'AES-256-GCM', def: 'El .key y las contraseñas se cifran en reposo; solo se descifran un instante al firmar ante el SAT.' },
        ],
      },
    ],
  },

  'listas-sat': {
    title: 'Listas SAT — guía',
    intro: 'Proveedores tuyos que aparecen en las listas negras del SAT, cruzados contra tus egresos. El triage alimenta a Maat.',
    groups: [
      {
        heading: 'Listas',
        entries: [
          { term: 'EFOS 69-B', def: 'Empresas que Facturan Operaciones Simuladas: el SAT presume factura falsa. Comprarles arriesga tu deducción.' },
          { term: 'Art. 69', def: 'Contribuyentes con incumplimientos publicados (no localizados, créditos firmes, etc.).' },
        ],
      },
      {
        heading: 'Situación (severidad)',
        entries: [
          { term: 'Definitivo / Firme', def: 'Crítico: el estatus en la lista es definitivo. Máximo riesgo fiscal.' },
          { term: 'Presunto / No localizado / Exigible', def: 'Medio: aún no definitivo, pero requiere revisión.' },
          { term: 'Otros', def: 'Informativo.' },
        ],
      },
      {
        heading: 'Triage',
        entries: [
          { term: 'Confirmado', def: 'Revisaste y el riesgo es real; queda registrado para defensa/decisión.' },
          { term: 'Descartado', def: 'Falso positivo (p. ej. RFC homónimo); no se vuelve a marcar.' },
          { term: 'RFC con problema', def: 'RFC con formato inválido o genérico en tus egresos: corrige la captura.' },
        ],
      },
    ],
  },

  'contabilidad-e': {
    title: 'Contabilidad electrónica — guía',
    intro: 'Genera los XML que exige el SAT (contabilidad electrónica 1.3) desde tu balanza contable.',
    groups: [
      {
        heading: 'Documentos',
        entries: [
          { term: 'Catálogo de cuentas', def: 'Estructura de tus cuentas con nivel, naturaleza y código agrupador SAT.' },
          { term: 'Balanza de comprobación', def: 'Saldo inicial, cargos (Debe), abonos (Haber) y saldo final por cuenta.' },
        ],
      },
      {
        heading: 'Código agrupador SAT',
        entries: [
          { term: 'Qué es', def: 'Clave del catálogo estándar del SAT (formato NNN o NNN.NN) a la que se mapea cada cuenta mayor tuya. Hace el catálogo 100% válido.' },
          { term: 'Cuenta mayor', def: 'Tu cuenta contable de primer nivel.' },
          { term: 'Naturaleza (D/A)', def: 'Deudora (D) o Acreedora (A).' },
          { term: 'manual / auto', def: 'Origen del mapeo: capturado por ti (manual) o auto-sugerido (conviene revisarlo).' },
        ],
      },
      {
        heading: 'Tipo de envío',
        entries: [
          { term: 'Normal', def: 'Primer envío del periodo.' },
          { term: 'Complementaria', def: 'Corrige una balanza ya enviada del mismo periodo.' },
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

  arqueo: {
    title: 'Arqueo de caja — guía',
    intro: 'Conteo del efectivo físico en la caja. Es CIEGO: cuentas por denominación sin ver el monto esperado; al guardar, el sistema revela tu diferencia real. Solo ves tu sucursal.',
    groups: [
      {
        heading: 'Tipo de arqueo',
        entries: [
          { term: 'Cierre de día', def: 'Conteo final de la jornada de una caja; se compara contra el corte del sistema.' },
          { term: 'Relevo (cambio de turno)', def: 'Entrega de la caja de un cajero saliente a uno entrante; se sella el monto entregado.' },
        ],
      },
      {
        heading: 'Resultado',
        entries: [
          { term: 'Contado', def: 'La suma del efectivo que capturaste por denominación.' },
          { term: 'Esperado', def: 'Lo que el sistema (corte) dice que debería haber en la caja. No lo ves hasta guardar.' },
          { term: 'Faltante', def: 'Contaste MENOS de lo esperado (diferencia positiva): falta dinero en la caja.' },
          { term: 'Sobrante', def: 'Contaste MÁS de lo esperado (diferencia negativa): sobra dinero en la caja.' },
          { term: 'Cuadrado', def: 'Contado = esperado: la caja cuadra exacto.' },
          { term: 'Sin corte aún', def: 'Se guardó tu conteo pero todavía no hay corte del sistema para comparar; la diferencia aparecerá cuando se procese.' },
        ],
      },
      {
        heading: 'Por qué es ciego',
        entries: [
          { term: 'Arqueo ciego', def: 'Cuentas sin ver el esperado para que el conteo sea honesto y no se ajuste al número objetivo. La diferencia se revela solo al final.' },
        ],
      },
    ],
  },
  bancos: {
    title: 'Conciliación bancaria — guía',
    intro: 'Reemplaza el Excel manual de bancos. Cada mes: subís los estados de cuenta, el motor clasifica los movimientos contra un catálogo alineado a Kepler, y la pantalla te dice si TODO cuadra — y si no, exactamente qué falta y dónde.',
    groups: [
      {
        heading: 'Las vistas',
        entries: [
          { term: 'Cierre', def: 'La respuesta del mes: ¿cuadra o no? Arriba el veredicto y el resumen del dinero; abajo la lista de "qué falta", ordenada por impacto, con un botón que te lleva al lugar exacto de arreglarlo.' },
          { term: 'Movimientos', def: 'Todos los ingresos y egresos del periodo. Aquí clasificás (asignás categoría) lo que el motor dejó "sin clasificar".' },
          { term: 'Concentrado', def: 'Pivote cuenta × grupo (ingresos, compras, gastos, traspasos…): en qué se movió el dinero por banco.' },
          { term: 'Conciliación', def: 'Cruce contra Kepler: cuántos retiros ya tienen su pago en el mayor, y qué quedó sin casar por ambos lados.' },
          { term: 'Cuentas', def: 'Cuadre de saldos por cuenta. Clic en una cuenta para ver sus movimientos.' },
        ],
      },
      {
        heading: 'Cuadre de saldos',
        entries: [
          { term: 'Cuadre', def: 'Saldo inicial + depósitos − retiros debe dar el saldo final del estado de cuenta. Si no da, falta capturar un movimiento o el saldo está mal tecleado.' },
          { term: 'Δ (delta)', def: 'La diferencia entre el saldo calculado y el saldo final real. Δ = 0 (o ±$1,000 de tolerancia) = cuadra.' },
          { term: 'Renglón donde salta', def: 'Cuando una cuenta no cuadra, la fila expande el/los movimiento(s) exactos donde el saldo del banco salta más de lo que explica el movimiento: ahí está el error.' },
          { term: 'TI = TE', def: 'Traspasos internos: dinero movido entre cuentas propias. Lo que entra (TI) debe ser igual a lo que sale (TE) y netear a cero. Si no netean, falta el otro lado del traspaso.' },
        ],
      },
      {
        heading: 'Conciliación vs Kepler',
        entries: [
          { term: '102', def: 'La cuenta contable única con la que Kepler agrupa TODOS los bancos. El workbook es el detalle por banco que Kepler colapsa en ese 102.' },
          { term: 'Casado / sin casar', def: 'Un retiro del banco "casa" cuando se encuentra su pago equivalente en el 102 de Kepler (mismo monto ± fecha). "Sin casar" = aún no se le encontró par.' },
          { term: 'Caja (control-total)', def: 'Compara el total de depósitos/retiros del banco contra los cargos/abonos del 102. Excluye traspasos internos.' },
          { term: 'Retiros vs depósitos', def: 'El lado de RETIROS (banco vs abonos del 102) es la conciliación real: cada diferencia se persigue. El lado de DEPÓSITOS es un memo — mezcla banco + CAJA GENERAL (efectivo) + cobranza de otra sucursal, y el 102 no es su espejo, así que ese Δ no se persigue 1 a 1.' },
          { term: 'Factoraje', def: 'Financiamiento de compras. Los pagos por factoraje reducen el pasivo en Kepler (cuenta 210), NO son abono al 102 — por eso nunca casan contra el 102 y no son un gap.' },
        ],
      },
      {
        heading: 'Clasificación',
        entries: [
          { term: 'Sin clasificar', def: 'Movimiento sin categoría asignada. No entra a ningún grupo del cuadre → hay que clasificarlo (a mano o creando una regla).' },
          { term: 'Regla', def: 'Patrón (código + concepto → categoría) que el motor aplica automáticamente al importar. Editable en ⚙ Config. "Reclasificar" re-aplica las reglas respetando lo que marcaste a mano.' },
          { term: 'Categoría', def: 'Etiqueta limpia alineada a una cuenta contable de Kepler (nómina, compra_mercancia, comisión_bancaria…).' },
        ],
      },
    ],
  },
  // ── Abouts enfocados por sección del tablero de bancos (CB.13.1) ──
  bancos_caja: {
    title: 'Cuadre de caja: cómo cerrarlo',
    intro: 'Compara lo que entró/salió del banco contra el 102 de Kepler. El lado de RETIROS es la conciliación real (cada diferencia se persigue); el de DEPÓSITOS es un memo. El número rojo del lado retiros NO es todo error de Kepler — se parte en tres cosas, y solo una se captura en Kepler.',
    resolve: [
      {
        heading: 'Depósitos (Δ del lado que entra) — memo',
        kind: 'info',
        intro: 'No es un gap. Los depósitos mezclan banco + efectivo de CAJA GENERAL (que Kepler asienta en caja, no en el 102) + cobranza que entra por otra sucursal. La columna de depósitos no es espejo del mayor 102.',
        steps: [
          'No se corrige contra el 102: es informativo.',
          'Si se quiere cuadrar, se hace por caja/sucursal por separado, no contra el 102 de banco.',
        ],
      },
      {
        heading: 'Retiros ① — Factoraje',
        kind: 'info',
        intro: 'Los pagos por factoraje reducen el pasivo en Kepler (cuenta 210); no son abono al 102, así que nunca casan contra el 102.',
        steps: [
          'En Kepler confirmá que el pago esté en 210 (acreedor factoraje).',
          'Si está en 210, es correcto — no se toca.',
        ],
      },
      {
        heading: 'Retiros ② — Nómina, comisiones y tarjeta',
        kind: 'info',
        intro: 'Kepler los agrupa en una póliza mensual (nómina en 601, comisiones bancarias en 611-003), no transfer por transfer. El dinero YA está en el 102, solo que agrupado.',
        steps: [
          'No se corrige: es diferencia de granularidad de captura.',
          'Por eso el cuadre casa por monto pero no 1 a 1 por conteo.',
        ],
      },
      {
        heading: 'Retiros ③ — Pagos a proveedor sin póliza en el 102',
        kind: 'fix',
        intro: 'Éste SÍ se captura en Kepler: pagos de mercancía que salieron del banco pero no tienen egreso aplicado en el 102.',
        steps: [
          'En Kepler abrí el auxiliar del 102 (bancos) del periodo.',
          'Buscá la póliza de egreso por beneficiario + monto + fecha.',
          'Si NO existe → capturala: abono al 102 / cargo al proveedor (aplicá el pago a su factura).',
          'Si existe pero en otra cuenta de banco → reclasificala al 102 correcto.',
          'La lista exacta por proveedor está en el tab Conciliación → "Pagos Kepler (102) sin casar".',
        ],
      },
    ],
  },

  bancos_sin_clasificar: {
    title: 'Movimientos sin clasificar',
    intro: 'Movimientos del banco a los que el motor aún no les asignó categoría. Por ahora la clasificación NO se edita aquí — para el cuadre lo que importa es que el movimiento esté bien registrado en Kepler.',
    resolve: [
      {
        heading: 'Qué hacer en Kepler',
        kind: 'fix',
        steps: [
          'En Kepler, buscá cada movimiento por monto + fecha en el auxiliar del 102 (o en la cuenta del beneficiario).',
          'La contracuenta que usó Kepler te dice su naturaleza: nómina 601, servicios 603, comisión bancaria 611-003, etc.',
          'Si el movimiento NO está registrado en Kepler, capturalo en la cuenta correcta — ese es el gap real que cierra el cuadre.',
          'Los patrones que más pesan salen listados abajo (código + concepto) para ubicarlos rápido.',
        ],
      },
    ],
  },

  bancos_saldo_no_cuadra: {
    title: 'El saldo de una cuenta no cierra',
    intro: 'Saldo inicial + depósitos − retiros debería dar el saldo final del estado de cuenta. Si no da, falta capturar un movimiento o un saldo/monto está mal tecleado.',
    resolve: [
      {
        heading: 'Encontrar y corregir el error',
        kind: 'fix',
        steps: [
          'La fila expande el/los renglón(es) donde el saldo del banco salta más de lo que explica el movimiento: ahí está el error.',
          'Si falta un movimiento, capturalo (o volvé a subir el estado de cuenta si el Excel venía incompleto).',
          'Si el saldo inicial/final está mal tecleado, corregilo en la fuente y reimportá.',
        ],
      },
    ],
  },

  bancos_traspaso_descuadre: {
    title: 'Los traspasos internos no netean',
    intro: 'Los traspasos entre cuentas propias (TI = entra, TE = sale) deben netear a cero: lo que sale de una cuenta entra en otra.',
    resolve: [
      {
        heading: 'Qué hacer en Kepler',
        kind: 'fix',
        steps: [
          'Si TI ≠ TE, en Kepler revisá que el traspaso tenga sus DOS lados capturados (cuenta origen y cuenta destino).',
          'Si falta un lado, capturalo en Kepler.',
          'Los traspasos reales (TI/TE) ya se miden aparte y netean a cero; un Spei u otro movimiento mal etiquetado como traspaso también descuadra — en Kepler verificá su cuenta real.',
        ],
      },
    ],
  },

  bancos_cuenta_sin_cargar: {
    title: 'Cuenta sin estado de cuenta',
    intro: 'La cuenta existe en el catálogo pero no tiene estado de cuenta cargado en este periodo, así que su movimiento no entra al cuadre.',
    resolve: [
      {
        heading: 'Cargarla o desactivarla',
        kind: 'fix',
        steps: [
          'Subí el estado de cuenta del periodo para esa cuenta.',
          'Si la cuenta ya no aplica, desactivala en Admin → Cuentas.',
          'CAJA GENERAL tiene un layout de columnas distinto — puede requerir su importador propio.',
        ],
      },
    ],
  },

  bancos_retiros_sin_casar: {
    title: 'Retiros del banco sin casar',
    intro: 'Retiros que salieron del banco y no encontraron su pago equivalente en el 102 de Kepler. NO todos son un error — mirá la columna "Categoría": según qué sean, se resuelven distinto (o no requieren nada).',
    resolve: [
      {
        heading: '① Pago a factoraje / Compra con factoraje',
        kind: 'info',
        intro: 'Reducen el pasivo de factoraje en Kepler (cuenta 210); no son abono al 102, por eso nunca casan.',
        steps: [
          'En Kepler confirmá que el pago esté en 210 (acreedor factoraje).',
          'Si está en 210, es correcto — no se toca.',
        ],
      },
      {
        heading: '② Nómina, comisión bancaria, tarjeta/TPV',
        kind: 'info',
        intro: 'Kepler los agrupa en una póliza mensual (nómina 601, comisión 611-003), no transfer por transfer. El dinero YA está en el 102, solo agrupado.',
        steps: [
          'No se corrige: es diferencia de granularidad, no un gap.',
        ],
      },
      {
        heading: '③ Compra de mercancía / gasto directo',
        kind: 'fix',
        intro: 'Éstos SÍ se capturan en Kepler: pagos que salieron del banco sin egreso aplicado en el 102 (p. ej. REM BOLSAS, SWEETS DIMENSION, CANEL\'S).',
        steps: [
          'En Kepler abrí el auxiliar del 102 (bancos) del periodo.',
          'Buscá la póliza de egreso por beneficiario + monto + fecha.',
          'Si NO existe → capturala: abono al 102 / cargo al proveedor (aplicá el pago a su factura).',
          'Si existe pero en otra cuenta de banco → reclasificala al 102 correcto.',
        ],
      },
    ],
  },

  bancos_kepler_sin_casar: {
    title: 'Pagos de Kepler (102) sin casar',
    intro: 'El lado inverso: pagos que Kepler registró en el 102 pero que no encontraron su retiro equivalente en el banco (por monto + fecha). Kepler dice que pagó; el banco no lo muestra o no casó.',
    resolve: [
      {
        heading: 'Qué hacer en Kepler',
        kind: 'fix',
        steps: [
          'Abrí cada póliza por su folio (columna Doc) y mirá contra qué banco y fecha se registró.',
          'Si salió de OTRA cuenta de banco (o de caja/factoraje) → es correcto, solo no casó contra este banco.',
          'Si tiene fecha/monto mal capturado o está duplicada en Kepler → corregila ahí.',
          'Si de verdad no salió del banco → revisá si es una provisión / cuenta por pagar que todavía no se paga.',
        ],
      },
    ],
  },

  egresos: {
    title: 'Egresos contables — guía',
    intro: 'Todo lo que sale (pólizas de cargo 5xx/6xx del mayor de Kepler): compras a proveedor y gastos. Podés ver el árbol por cuenta, la tendencia mensual, el ranking de proveedores y hacer drill hasta el documento y su cadena.',
    groups: [
      {
        heading: 'Familia del egreso',
        entries: [
          { term: 'Compra', def: 'Pago/registro de mercancía a proveedor (cuenta 511/510 y afines). Es el grueso del egreso.' },
          { term: 'Gasto', def: 'Egreso operativo que no es mercancía: nómina, servicios, comisiones, renta, viáticos (cuentas 6xx).' },
        ],
      },
      {
        heading: 'Cómo leer',
        entries: [
          { term: 'Cuenta', def: 'Cuenta contable de Kepler (código + nombre). Agrupa el gasto por su naturaleza.' },
          { term: 'Beneficiario', def: 'A quién se le pagó (proveedor o tercero). El drill por beneficiario acumula el filtro de cuenta.' },
          { term: 'Póliza / documento', def: 'El asiento contable concreto. Su detalle abre la cadena pedido → factura → pago (materialidad de la operación).' },
          { term: 'Δ vs periodo previo', def: 'Variación del gasto contra el mes anterior. ▲ = subió, ▼ = bajó.' },
        ],
      },
    ],
  },
  hallazgos: {
    title: 'Hallazgos de Maat — guía',
    intro: 'Patrones que el motor detecta en los libros. Vos confirmás o descartás cada uno: ese veredicto ENTRENA la precisión de la regla (las reglas ruidosas se auto-suprimen). El motor decide, vos validás, el LLM queda fuera del número.',
    groups: [
      {
        heading: 'Clase de hallazgo',
        entries: [
          { term: 'Riesgo', def: 'Posible pérdida o exposición (pago sin soporte, duplicado, descuadre). Máxima prioridad.' },
          { term: 'Error de captura', def: 'Dato mal tecleado o inconsistente (saldo que no cierra, sin clasificar). Se corrige en la fuente.' },
          { term: 'Oportunidad', def: 'Ahorro o mejora detectable (descuento no aplicado, condición mejor).' },
        ],
      },
      {
        heading: 'Severidad',
        entries: [
          { term: 'Crítico', def: 'Impacto alto ($ grande o riesgo serio) — atender primero.' },
          { term: 'Alerta', def: 'Impacto medio — revisar.' },
          { term: 'Info', def: 'Bajo impacto / informativo.' },
        ],
      },
      {
        heading: 'Triage (tu veredicto entrena)',
        entries: [
          { term: 'Confirmar', def: 'Es real y útil → sube la precisión de esa regla y queda para seguimiento.' },
          { term: 'Descartar (falso positivo)', def: 'No aplica → baja la precisión; si una regla acumula falsos, se auto-suprime.' },
          { term: 'Precisión de regla', def: '% de aciertos según tu feedback. Reglas de baja precisión se silencian salvo que las fijes (pin).' },
        ],
      },
    ],
  },
  reembolsos: {
    title: 'Reembolsos / comprobaciones — guía',
    intro: 'Comprobación de gastos: ligás la evidencia (facturas, tickets, XMLs) a una solicitud de gasto de Kepler para que el egreso quede soportado.',
    groups: [
      {
        heading: 'Estado',
        entries: [
          { term: 'Recibida', def: 'Se subió la comprobación; falta validarla.' },
          { term: 'Validada', def: 'Revisada y aceptada como soporte del gasto.' },
          { term: 'Rechazada', def: 'No cumple; se indica el motivo para recapturar.' },
        ],
      },
      {
        heading: 'Archivos',
        entries: [
          { term: 'Comprobante por rol', def: 'Cada gasto puede pedir distintos documentos (factura, ticket, XML). Subí el archivo en su casilla.' },
          { term: 'Solicitud (Kepler)', def: 'El folio de gasto autorizado en Kepler al que se liga la comprobación.' },
        ],
      },
    ],
  },
  solicitudes: {
    title: 'Solicitudes de gasto — guía',
    intro: 'Solicitudes de gasto capturadas en Kepler. Desde aquí ves su estado y saltás a comprobarlas (subir soporte) o a ver el egreso ya contabilizado.',
    groups: [
      {
        heading: 'Estado de la solicitud',
        entries: [
          { term: 'Nueva', def: 'Capturada, pendiente de aprobación.' },
          { term: 'Aprobada', def: 'Autorizada; puede ejercerse el gasto.' },
          { term: 'Cerrada / ejercida', def: 'Gasto realizado y contabilizado.' },
          { term: 'Cancelada', def: 'Anulada; no procede.' },
        ],
      },
      {
        heading: 'Acciones',
        entries: [
          { term: 'Comprobar', def: 'Ir a Reembolsos con el folio y proveedor precargados para subir el soporte.' },
          { term: 'Ver gasto', def: 'Abrir el egreso contable ligado a esta solicitud (si ya se contabilizó).' },
          { term: 'Comprobante recibido/validado', def: 'Indicador de si la solicitud ya tiene soporte cargado y en qué estado está.' },
        ],
      },
    ],
  },
};
