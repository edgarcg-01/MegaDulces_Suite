import { EmissionErrorKind } from './emission-errors.service';

/**
 * FD.1 — Base de conocimiento SAT/PAC. Traduce el código/mensaje críptico del PAC a
 * lenguaje humano y propone la solución concreta (pasos + a dónde ir a arreglarlo).
 * El tablero de Diagnóstico (FD.2/FD.4) resuelve cada error contra este catálogo.
 *
 * Curado, NO exhaustivo: cubre los errores más comunes de CFDI 4.0 (validación de
 * receptor, sello/CSD, listas del SAT) + fallbacks por operación. Ampliable.
 */
export interface SatErrorSolution {
  /** Código exacto SAT/PAC (CFDI40147, 302, …). Match preferente. */
  code?: string;
  /** Fallback: regex contra `mensaje + detalle` cuando no hay código. */
  match?: RegExp;
  /** Limita la entrada a ciertas operaciones (timbrado/cancelación/…). */
  kinds?: EmissionErrorKind[];
  titulo: string;
  causa: string;
  solucion: string;
  /** Ruta SPA donde se corrige (deep-link del botón "Ir a arreglar"). */
  deep_link?: string;
  fix_label?: string;
  severity?: 'critical' | 'warn' | 'info';
}

export const SAT_ERROR_CATALOG: SatErrorSolution[] = [
  // ── Validación del receptor (CFDI 4.0: datos deben coincidir con el SAT) ──
  {
    code: 'CFDI40147',
    match: /RFC.*(no se encuentra|no existe|lista de RFC|LCO)/i,
    titulo: 'El RFC del receptor no está registrado en el SAT',
    causa: 'CFDI 4.0 valida el RFC del cliente contra el padrón del SAT (LCO). El RFC capturado no existe o está mal escrito.',
    solucion: 'Verifica el RFC contra la Constancia de Situación Fiscal del cliente y corrígelo en su ficha. Ojo con la homoclave y la Ñ/&.',
    deep_link: '/comercial', fix_label: 'Ir a clientes', severity: 'critical',
  },
  {
    code: 'CFDI40148',
    match: /(Nombre|Raz[oó]n social).*(no coincide|no corresponde)/i,
    titulo: 'La razón social del receptor no coincide con el SAT',
    causa: 'El nombre debe ser EXACTO al registrado en el SAT (mayúsculas, sin “S.A. de C.V.” si la constancia no lo trae, sin acentos de más).',
    solucion: 'Copia la razón social tal cual aparece en la Constancia de Situación Fiscal del cliente (régimen de capital incluido/excluido según la constancia).',
    deep_link: '/comercial', fix_label: 'Ir a clientes', severity: 'critical',
  },
  {
    code: 'CFDI40149',
    match: /(C[oó]digo postal|DomicilioFiscalReceptor).*(no coincide|no corresponde)/i,
    titulo: 'El CP fiscal del receptor no coincide con el SAT',
    causa: 'El código postal fiscal del cliente no corresponde al registrado en su constancia.',
    solucion: 'Corrige el CP fiscal del cliente con el de su Constancia de Situación Fiscal (es el CP del domicilio fiscal, no el de entrega).',
    deep_link: '/comercial', fix_label: 'Ir a clientes', severity: 'critical',
  },
  {
    code: 'CFDI40157',
    match: /RegimenFiscalReceptor.*(no coincide|no corresponde|no v[aá]lido)/i,
    titulo: 'El régimen fiscal del receptor es incorrecto',
    causa: 'El régimen capturado no coincide con el registrado por el cliente en el SAT.',
    solucion: 'Corrige el régimen fiscal del cliente con el de su constancia (ej. 601, 603, 612, 626).',
    deep_link: '/comercial', fix_label: 'Ir a clientes', severity: 'critical',
  },
  {
    code: 'CFDI40158',
    match: /UsoCFDI.*(no v[aá]lido|no corresponde|r[eé]gimen)/i,
    titulo: 'El uso de CFDI no aplica al régimen del receptor',
    causa: 'El uso de CFDI elegido no es válido para el régimen fiscal del cliente (ej. G03 no aplica a ciertos regímenes).',
    solucion: 'Cambia el uso de CFDI a uno permitido para el régimen del cliente (ej. G01/G03 para actividad empresarial, S01 sin efectos fiscales).',
    deep_link: '/comercial', fix_label: 'Ir a clientes', severity: 'warn',
  },

  // ── Sello / CSD / certificado del emisor ──
  {
    code: 'CFDI40102',
    match: /(NoCertificado|Certificado).*(no cumple|no v[aá]lido|patr[oó]n)/i,
    titulo: 'Problema con el certificado (CSD) del emisor',
    causa: 'El No. de Certificado o el CSD no es válido o no está bien cargado en el PAC.',
    solucion: 'Verifica que el CSD (Certificado de Sello Digital) esté cargado y vigente en tu cuenta del PAC (Conectia/SW), y que corresponda al RFC del emisor.',
    fix_label: 'Revisar emisor', deep_link: '/contabilidad/facturar', severity: 'critical',
  },
  {
    code: '302',
    match: /sello.*(no v[aá]lido|inv[aá]lido|mal)/i,
    titulo: 'Sello inválido',
    causa: 'El sello del CFDI no es válido — normalmente el CSD cargado en el PAC no corresponde al emisor o está mal.',
    solucion: 'Revisa el CSD activo en tu cuenta del PAC. Debe ser el CSD (no la e.firma/FIEL) del RFC emisor y estar vigente.',
    fix_label: 'Revisar emisor', deep_link: '/contabilidad/facturar', severity: 'critical',
  },
  {
    code: '303',
    titulo: 'El sello no corresponde al emisor',
    causa: 'El CSD con el que se selló no pertenece al RFC del emisor del comprobante.',
    solucion: 'Confirma que el RFC del emisor y el CSD cargado en el PAC sean del mismo contribuyente.',
    fix_label: 'Revisar emisor', deep_link: '/contabilidad/facturar', severity: 'critical',
  },
  {
    code: '304',
    match: /certificado.*(revocad|caduc|vencid)/i,
    titulo: 'Certificado (CSD) revocado o vencido',
    causa: 'El CSD del emisor está revocado o ya caducó.',
    solucion: 'Tramita un nuevo CSD en el SAT y cárgalo en tu cuenta del PAC. Verifica la vigencia de la e.firma también.',
    fix_label: 'Revisar e.firma', deep_link: '/contabilidad/credenciales', severity: 'critical',
  },
  {
    code: '305',
    match: /fecha.*(fuera de rango|72)/i,
    titulo: 'Fecha del comprobante fuera de rango',
    causa: 'La fecha de emisión está fuera del rango permitido (más de 72 horas atrás, o en el futuro).',
    solucion: 'Emite con fecha actual. Si el reloj del servidor está desfasado, avísale al equipo técnico.',
    severity: 'warn',
  },
  {
    code: '307',
    match: /(duplicad|ya (fue|est[aá]) timbrad)/i,
    titulo: 'CFDI duplicado',
    causa: 'Ya existe un CFDI timbrado con los mismos datos (mismo folio/emisor/receptor/total).',
    solucion: 'Revisa si la factura ya se emitió (búscala en la bandeja). Si es un reintento, no la vuelvas a timbrar.',
    fix_label: 'Ver facturas', deep_link: '/contabilidad/facturar', severity: 'info',
  },

  // ── Emisor / listas del SAT ──
  {
    code: '402',
    match: /(emisor|contribuyente).*(no.*(LCO|vigente|efos)|69-?B)/i,
    titulo: 'El emisor no está vigente ante el SAT',
    causa: 'El RFC emisor no está en la lista de contribuyentes obligados (LCO) o tiene una restricción.',
    solucion: 'Verifica el estatus del RFC emisor en el SAT y que el régimen del emisor esté correcto.',
    fix_label: 'Revisar emisor', deep_link: '/contabilidad/facturar', severity: 'critical',
  },

  // ── Impuestos / totales ──
  {
    match: /(TotalImpuestosTrasladados|Total).*(no.*(corresponde|coincide|suma)|c[aá]lculo)/i,
    titulo: 'El total de impuestos no cuadra',
    causa: 'La suma de traslados (IVA) del comprobante no coincide con el total declarado.',
    solucion: 'Revisa cantidades y precios de los conceptos. Si persiste, es un tema de redondeo del motor — repórtalo al equipo.',
    severity: 'warn',
  },

  // ── Autenticación / configuración del PAC ──
  {
    match: /(PAC SW no configurado|SW_TOKEN|SW_USER|auth fall[oó]|authenticate)/i,
    titulo: 'El PAC no está configurado',
    causa: 'Faltan las credenciales del PAC (SW_TOKEN o SW_USER/SW_PASSWORD) o son inválidas.',
    solucion: 'Configura las variables del PAC en el entorno (Railway) y verifica el token con el PAC. Sin esto no se puede timbrar nada.',
    severity: 'critical',
  },

  // ── Cancelación ──
  {
    kinds: ['cancelacion'],
    match: /(no.*cancelable|no se puede cancelar|fuera de plazo)/i,
    titulo: 'El CFDI no es cancelable',
    causa: 'El SAT no permite cancelar este CFDI (fuera de plazo, ya tiene REP/relacionados, o requiere aceptación no otorgada).',
    solucion: 'Si tiene complementos de pago o CFDI relacionados, atiéndelos primero. Para errores, considera una nota de crédito en vez de cancelar.',
    fix_label: 'Ver facturas', deep_link: '/contabilidad/facturar', severity: 'warn',
  },
  {
    kinds: ['cancelacion'],
    match: /(sustituci[oó]n|folioSustituci|motivo 01)/i,
    titulo: 'Falta el UUID de sustitución (motivo 01)',
    causa: 'El motivo 01 exige el folio fiscal (UUID) de la factura que sustituye a la cancelada.',
    solucion: 'Emite primero la factura correcta y usa su UUID en el campo de sustitución, o cancela con motivo 02 si no hay reemplazo.',
    fix_label: 'Ver facturas', deep_link: '/contabilidad/facturar', severity: 'info',
  },

  // ── REP ──
  {
    kinds: ['rep'],
    match: /.*/,
    titulo: 'No se pudo timbrar el complemento de pago (REP)',
    causa: 'El REP (Pagos 2.0) de esta factura a crédito fue rechazado por el PAC.',
    solucion: 'Revisa el detalle del error del PAC. Casos típicos: la factura no es PPD, saldos que no cuadran, o forma de pago inválida. Reintenta desde el pago.',
    severity: 'warn',
  },

  // ── XML mal formado ──
  {
    code: '301',
    match: /(XML mal formado|esquema|schema)/i,
    titulo: 'XML mal formado',
    causa: 'El comprobante no cumple el esquema del SAT (falta un dato obligatorio o tiene un formato inválido).',
    solucion: 'Revisa que todos los campos obligatorios estén completos. Si persiste, es un tema del armado — repórtalo al equipo técnico con el detalle.',
    severity: 'warn',
  },
];

/** Fallbacks por operación cuando ningún patrón coincide. */
const GENERIC_BY_KIND: Record<EmissionErrorKind, SatErrorSolution> = {
  timbrado: {
    titulo: 'El PAC rechazó el timbrado',
    causa: 'El comprobante no pasó la validación del PAC/SAT por un motivo no catalogado.',
    solucion: 'Lee el detalle del PAC en este error. Revisa datos del receptor (RFC/razón social/régimen/CP/uso) y el CSD del emisor. Reintenta.',
    severity: 'warn',
  },
  nota_credito: {
    titulo: 'El PAC rechazó la nota de crédito',
    causa: 'La nota de crédito (Egreso relacionado) fue rechazada por el PAC/SAT.',
    solucion: 'Verifica que la factura original esté vigente y que los datos del receptor coincidan. Revisa el detalle del PAC.',
    severity: 'warn',
  },
  rep: {
    titulo: 'El PAC rechazó el complemento de pago',
    causa: 'El REP fue rechazado por el PAC/SAT.',
    solucion: 'Revisa que la factura sea PPD y que los saldos (anterior/pagado/insoluto) cuadren. Reintenta desde el pago.',
    severity: 'warn',
  },
  cancelacion: {
    titulo: 'El PAC rechazó la cancelación',
    causa: 'La solicitud de cancelación fue rechazada por el PAC/SAT.',
    solucion: 'Revisa el motivo y, si aplica, el UUID de sustitución. Algunos CFDI requieren aceptación del receptor.',
    severity: 'warn',
  },
};

/**
 * Resuelve la mejor solución para un error: por código exacto primero, luego por
 * regex contra mensaje+detalle, y por último el fallback de la operación.
 */
export function resolveSolution(q: {
  code?: string | null;
  message?: string | null;
  detail?: string | null;
  kind?: EmissionErrorKind;
}): SatErrorSolution {
  const code = (q.code || '').toUpperCase().trim();
  const hay = `${q.message || ''}\n${q.detail || ''}`;
  const kindOk = (e: SatErrorSolution) => !e.kinds || (q.kind ? e.kinds.includes(q.kind) : true);

  if (code) {
    const byCode = SAT_ERROR_CATALOG.find((e) => e.code && e.code.toUpperCase() === code && kindOk(e));
    if (byCode) return byCode;
  }
  const byMatch = SAT_ERROR_CATALOG.find((e) => e.match && kindOk(e) && e.match.test(hay));
  if (byMatch) return byMatch;

  return GENERIC_BY_KIND[q.kind || 'timbrado'];
}
