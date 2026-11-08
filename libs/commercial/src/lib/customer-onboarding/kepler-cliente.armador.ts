import {
  CASILLAS_KEPLER,
  type CasillaKepler,
  type ColumnaPlanKepler,
  type HallazgoAlta,
  type SolicitudAlta,
  type UsoCfdiOpcion,
} from '@megadulces/contracts';

/**
 * `[ALC.1.6]` — **La solicitud de alta en el idioma de Kepler, armada sin tocar Kepler** (D1-b).
 *
 * Plan: [`FASE_ALC_ALTA_DE_CLIENTES.md`](../../../../../docs/IMPLEMENTACION/FASES/FASE_ALC_ALTA_DE_CLIENTES.md)
 * §4.1 «Lo que escribe un alta en Kepler (medido)». Capa C1: funciones puras. El adaptador de C2
 * (`kepler-cliente-sink.adapter.ts`) lee lo vivo de las 10 bases y escribe lo que esto decide.
 *
 * ── Lo que escribe un alta (medido el 2026-11-07, sólo lectura) ─────────────────────────────
 *
 * Testigo: la clave **21054**, dada de alta en Kepler desde el concentrador ese día.
 *
 * | Tabla | Qué | Dónde la dejó Kepler |
 * |---|---|---|
 * | `md.kdud` | la ficha (30 columnas `c1`…`c30`) | **idéntica en las 9 bases** (00…08) |
 * | `md.kdfedir` | lo fiscal del receptor (`c1=3`, `c2=clave`, `c3='1'`) | **sólo en la 08**, donde se abrió la pantalla `FE33Dir` |
 *
 * La forma `md_cat_cli.kpl` escribe casilla por casilla en la base del servidor y, si ese servidor
 * es el **concentrador** (`pv_suc_ip.c6 = 'SC'`), la librería del cliente `pv_sc_lib` repite la
 * escritura en las sucursales. La base no replica nada: por eso la Suite escribe en las **10**.
 * `FE33Dir` no tiene ese paso: de 2,041 clientes con `kdfedir`, 1,157 lo tienen en UNA sola base y
 * 259 en las nueve. La Suite lo escribe en las 10 para que cualquier sucursal pueda facturarle.
 *
 * ── `kdfedir` (`c1=3`, 5,622 filas): lo que contesta ALC.0.3 ───────────────────────────────
 *  · `c18` régimen fiscal · `c16` uso de CFDI · `c14` forma de pago (los tres los registra la
 *    bitácora `kdlogmov` de 21054 con su número de columna) · `c13` CP fiscal (886 iguales al
 *    `kdud.c27`, 116 distintos, 2,444 vacíos) · `c19` nombre fiscal (233 iguales al `kdud.c3`).
 *  · Forma de pago: con crédito (claves `C…`) 689 de 769 son `99`; de contado 1,788 de 2,297 son `01`.
 *  · Uso de CFDI: régimen 616 → `S01` en 3,542 de 3,567.
 */

/** Los servidores donde vive el maestro de clientes: el concentrador primero (ahí se dan las altas). */
export const SERVIDORES_CLIENTE = ['SC', '00', '01', '02', '03', '04', '05', '06', '07', '08'] as const;

/**
 * Zona de clientes (`kduk`) que corresponde a cada sucursal. CEDIS (`00`) no tiene: ahí se atiende
 * telemarketing de las tres zonas (1M001, 2M001, 3M001), así que se elige.
 */
export const ZONA_DE_SUCURSAL: Readonly<Record<string, string>> = Object.freeze({
  '01': '10000', '02': '10000', '03': '10000', '04': '10000',
  '05': '30000', '06': '30000',
  '07': '20000', '08': '20000',
});

/**
 * Grupo de «venta de piso» de cada sucursal: el nombre del grupo en `kduj` nombra la sucursal
 * (`2VP01` VENTA DE PISO MORELIA ABASTOS…) y su vendedor de piso lo confirma (`20002` SUC MORELIA
 * ABASTOS PISO, en 168 de 178 fichas del grupo).
 */
export const PISO_DE_SUCURSAL: Readonly<Record<string, string>> = Object.freeze({
  '01': '1VP01', '02': '1VP03', '03': '1VP02', '04': '1VP04',
  '05': '3VP02', '06': '3VP01',
  '07': '2VP02', '08': '2VP01',
});

// ── La clave ─────────────────────────────────────────────────────────────────────────────

/**
 * La nomenclatura de claves (Francisco, 2026-11-07; medida en las 2,468 fichas de la base 00):
 *  · **contado**: `1xxxx` La Piedad, `2xxxx` Morelia, `3xxxx` Zamora (1,005 + 1,027 + 230; de las
 *    claves `2xxxx`, 1,008 de 1,027 tienen zona 20000);
 *  · **crédito**: `CR` + zona + consecutivo de 3 (`CR1001` = crédito, La Piedad, 001 — Francisco,
 *    2026-11-08). En Kepler conviven dos formas de crédito: `C1xxx`/`C2xxx`/`C3xxx` (351 fichas,
 *    C1001…C1120, C2001…C2120, C3001…C3111; la última, C1120, dada de alta el 2026-11-07) y
 *    `CR1xxx`/`CR2xxx`/`CR3xxx` (10). ⚠️ 9 de las 10 `CR` son el MISMO cliente que la `C` de su número
 *    (CR1026 y C1026, mismo nombre): no son un consecutivo aparte. Por eso el consecutivo de crédito
 *    cuenta **las dos formas** —`C1120` y `CR1066` → la siguiente es `CR1121`— y un número nuevo nunca
 *    repite el de otro cliente de crédito (decisión de Claude, 2026-11-08: D8).
 *  · `O…` otros ingresos no comerciales y `TI…` traspasos internos: **no** son altas de este módulo.
 */
export interface SerieClave {
  tipo: 'contado' | 'credito';
  /** `1`, `2` o `3`. */
  zona: string;
  prefijo: string;
  digitos: number;
  patron: string;
  /** La forma de una clave NUEVA de la serie (`c2 ~ regex`). */
  regex: string;
  /**
   * Las claves que ocupan un número del consecutivo (para SQL y para `siguienteClave`). En crédito
   * incluye la forma vieja `C1xxx`: el número es el mismo consecutivo.
   */
  cuenta: string;
}

export function serieDe(zonaCodigo: string | null | undefined, credito: boolean): SerieClave | null {
  const z = /^([123])0000$/.exec(String(zonaCodigo ?? '').trim())?.[1];
  if (!z) return null;
  return credito
    ? { tipo: 'credito', zona: z, prefijo: `CR${z}`, digitos: 3, patron: `CR${z}###`, regex: `^CR${z}[0-9]{3}$`, cuenta: `^CR?${z}[0-9]{3}$` }
    : { tipo: 'contado', zona: z, prefijo: z, digitos: 4, patron: `${z}####`, regex: `^${z}[0-9]{4}$`, cuenta: `^${z}[0-9]{4}$` };
}

export const enSerie = (serie: SerieClave, clave: string): boolean => new RegExp(serie.regex).test(String(clave ?? '').trim().toUpperCase());

/** El siguiente consecutivo de la serie, sobre TODAS las claves que se le pasen (las 10 bases + las reservadas). */
export function siguienteClave(serie: SerieClave, existentes: Iterable<string>): { ok: true; clave: string } | { ok: false; motivo: string } {
  const ocupa = new RegExp(serie.cuenta);
  let max = 0;
  for (const c of existentes) {
    const t = String(c ?? '').trim().toUpperCase();
    if (ocupa.test(t)) max = Math.max(max, Number(t.slice(-serie.digitos)));
  }
  const n = max + 1;
  const tope = 10 ** serie.digitos - 1;
  if (n > tope) return { ok: false, motivo: `La serie ${serie.patron} se acabó (${serie.prefijo}${tope} ya existe): hay que decidir la nueva nomenclatura.` };
  return { ok: true, clave: `${serie.prefijo}${String(n).padStart(serie.digitos, '0')}` };
}

/** ¿Lleva crédito en Kepler? Sólo lo APROBADO: límite o plazo. Un descuento solo sigue siendo de contado. */
export function llevaCredito(s: Pick<SolicitudAlta, 'credito'>): boolean {
  const c = s.credito;
  return !!c && c.decision === 'aprobado' && (Number(c.credito_aprobado) > 0 || Number(c.plazo_aprobado) > 0);
}

// ── El texto ─────────────────────────────────────────────────────────────────────────────

const VOCALES: Readonly<Record<string, string>> = {
  Á: 'A', À: 'A', Ä: 'A', Â: 'A', É: 'E', È: 'E', Ë: 'E', Ê: 'E', Í: 'I', Ì: 'I', Ï: 'I', Î: 'I',
  Ó: 'O', Ò: 'O', Ö: 'O', Ô: 'O', Ú: 'U', Ù: 'U', Ü: 'U', Û: 'U',
};

/**
 * Como escribe Kepler (medido en `kdud` de la base 00, 2,468 fichas): MAYÚSCULAS, **sin acentos**
 * (`MICHOACAN` 1,599 contra `MICHOACÁN` 361) pero **con Ñ** (70 nombres), sin caracteres de control
 * (42 fichas traen un `\r` pegado, p. ej. `MICHOACAN\r`) y **sin comillas**: las formas de Kepler
 * arman sus comandos entre comillas simples (`6,'valor'`), y una comilla en el dato rompe la edición
 * posterior en la propia forma (hay 1 ficha con apóstrofo).
 */
export function textoKepler(v: unknown): string {
  return String(v ?? '')
    .normalize('NFC')
    .toUpperCase()
    .replace(/[ÁÀÄÂÉÈËÊÍÌÏÎÓÒÖÔÚÙÜÛ]/g, (x) => VOCALES[x] ?? x)
    .replace(/[̀-ͯ]/g, '')
    .replace(/['"`´‘’“”]/g, '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Teléfono: sólo dígitos (75 de 369 teléfonos de Kepler traen guiones, espacios o texto). */
export const telefonoKepler = (v: unknown): string => String(v ?? '').replace(/\D/g, '');

// ── El plan ──────────────────────────────────────────────────────────────────────────────

export type FilaKepler = Record<string, string | number>;

export interface PlanClienteKepler {
  /** `''` hasta que el adaptador la calcula contra las bases vivas (`planConClave`). */
  clave: string;
  kdud: FilaKepler;
  kdfedir: FilaKepler;
}

export interface EntradaClienteKepler {
  solicitud: Pick<SolicitudAlta,
    'rfc' | 'curp' | 'tipo_persona' | 'nombre_fiscal' | 'regimen_fiscal' | 'codigo_postal_fiscal' | 'uso_cfdi' | 'forma_pago'
    | 'ficha' | 'vendedor_code' | 'grupo_code' | 'zona_code' | 'credito'>;
  /** Estado del SAT (como lo escribe Kepler) del CP de la ficha; `null` = CP fuera del catálogo o sin consultar. */
  estadoDelCp: string | null;
  usos: UsoCfdiOpcion[];
  /** Claves de `kdfe33satfopg`. */
  formasPago: string[];
}

export interface ArmadoClienteKepler {
  plan: PlanClienteKepler;
  serie: SerieClave | null;
  hallazgos: HallazgoAlta[];
}

const RFC_GENERICOS = new Set(['XAXX010101000', 'XEXX010101000']);

/** Uso de CFDI de costumbre (medido): sin RFC → S01; con RFC → G01 (adquisición de mercancías: el cliente revende). */
export function usoCfdiPorDefecto(rfc: string, regimen: string): string {
  return RFC_GENERICOS.has(String(rfc ?? '').trim().toUpperCase()) || String(regimen ?? '').trim() === '616' ? 'S01' : 'G01';
}

/** Forma de pago de costumbre (medido): con crédito 99 «por definir»; de contado 01 «efectivo». */
export const formaPagoPorDefecto = (conCredito: boolean): string => (conCredito ? '99' : '01');

const dinero = (n: unknown): string => (Math.round(Number(n ?? 0) * 100) / 100).toFixed(2);
const pct = (n: unknown): string => {
  const x = Math.round(Number(n ?? 0) * 100) / 100;
  return x > 0 ? String(x) : '';
};

/**
 * La solicitud → la fila de `kdud` y la de `kdfedir`, o por qué no se puede escribir así.
 * `bloquea` = no se escribe; `aviso` = se escribe y se dice qué se cambió.
 * ⛔ Nada se recorta: si no cabe, bloquea (la persona decide cómo abreviar, no la Suite).
 */
export function armarClienteKepler(e: EntradaClienteKepler): ArmadoClienteKepler {
  const s = e.solicitud;
  const h: HallazgoAlta[] = [];
  const bloquea = (campo: string, mensaje: string) => h.push({ campo, gravedad: 'bloquea', mensaje });
  const aviso = (campo: string, mensaje: string) => h.push({ campo, gravedad: 'aviso', mensaje });
  const f = s.ficha;

  // ── cartera: zona, grupo, vendedor ──
  const zona = String(s.zona_code ?? '').trim();
  const grupo = String(s.grupo_code ?? '').trim().toUpperCase();
  const vendedor = String(s.vendedor_code ?? '').trim().toUpperCase();
  const credito = llevaCredito(s);
  const serie = serieDe(zona, credito);
  if (!zona) bloquea('zona_code', 'Falta la zona: de ella sale la clave (1xxxx La Piedad, 2xxxx Morelia, 3xxxx Zamora).');
  else if (!serie) bloquea('zona_code', `La zona «${zona}» no es de clientes: se usa 10000 (La Piedad), 20000 (Morelia) o 30000 (Zamora).`);
  if (!grupo) bloquea('grupo_code', 'Falta el grupo (venta de piso, vecinal, telemarketing o ruta).');
  else if (serie && grupo[0] !== serie.zona) bloquea('grupo_code', `El grupo ${grupo} es de otra zona: en la zona ${zona} los grupos empiezan con ${serie.zona}.`);
  if (!vendedor) bloquea('vendedor_code', 'Falta el vendedor.');
  else if (serie && vendedor[0] !== serie.zona) aviso('vendedor_code', `El vendedor ${vendedor} es de otra zona (la ${zona} usa claves que empiezan con ${serie.zona}): revisa que sea el correcto.`);

  // ── la ficha ──
  const nombre = textoKepler(f?.nombre || s.nombre_fiscal);
  const dir1 = textoKepler(f?.direccion_1);
  const dir2 = textoKepler(f?.direccion_2);
  const cpFicha = String(f?.codigo_postal || s.codigo_postal_fiscal || '').trim();
  if (!f?.codigo_postal && cpFicha) aviso('ficha.codigo_postal', `La ficha no traía código postal: se usa el fiscal (${cpFicha}).`);
  if (!/^\d{5}$/.test(cpFicha)) bloquea('ficha.codigo_postal', 'El código postal de la ficha lleva 5 dígitos.');

  const estadoEscrito = textoKepler(f?.estado);
  let estado = estadoEscrito;
  if (e.estadoDelCp) {
    estado = textoKepler(e.estadoDelCp);
    if (estadoEscrito && estadoEscrito !== estado) {
      aviso('ficha.estado', `El CP ${cpFicha} es de ${estado} (catálogo del SAT): se escribe ése y no «${estadoEscrito}».`);
    }
  } else if (/^\d{5}$/.test(cpFicha)) {
    aviso('ficha.estado', `El CP ${cpFicha} no está en el catálogo del SAT: el estado va como se escribió.`);
  }
  if (!estado) bloquea('ficha.estado', 'Falta el estado.');
  if (!nombre) bloquea('ficha.nombre', 'Falta el nombre.');
  if (!dir1) aviso('ficha.direccion_1', 'La ficha va sin calle ni número.');

  const tels = [f?.telefono_1, f?.telefono_2, f?.telefono_3].map(telefonoKepler);
  tels.forEach((t, i) => {
    if (t && t.length !== 10) aviso(`ficha.telefono_${i + 1}`, `El teléfono ${i + 1} tiene ${t.length} dígitos (en México son 10).`);
  });
  const email = String(f?.email ?? '').trim().toLowerCase();
  const rfc = String(s.rfc ?? '').trim().toUpperCase();
  if (!/^[A-ZÑ&0-9]{12,13}$/.test(rfc)) bloquea('rfc', 'El RFC lleva 12 o 13 letras y números.');
  const curp = s.tipo_persona === 'fisica' && !RFC_GENERICOS.has(rfc) ? String(s.curp ?? '').trim().toUpperCase() : '';

  const valores: Record<CasillaKepler, string> = {
    nombre, direccion_1: dir1, direccion_2: dir2, estado, codigo_postal: cpFicha,
    telefono_1: tels[0], telefono_2: tels[1], telefono_3: tels[2], rfc, curp, email,
  };
  for (const k of Object.keys(CASILLAS_KEPLER) as CasillaKepler[]) {
    const { largo, rotulo } = CASILLAS_KEPLER[k];
    if (valores[k].length > largo) bloquea(`ficha.${k}`, `${rotulo}: Kepler guarda ${largo} caracteres y trae ${valores[k].length}. Abrévialo tú; la Suite no lo corta.`);
  }

  // ── lo fiscal del receptor (kdfedir) ──
  const regimen = String(s.regimen_fiscal ?? '').trim();
  const uso = String(s.uso_cfdi ?? '').trim().toUpperCase() || usoCfdiPorDefecto(rfc, regimen);
  const forma = String(s.forma_pago ?? '').trim() || formaPagoPorDefecto(credito);
  if (!s.uso_cfdi) aviso('uso_cfdi', `Sin uso de CFDI elegido: se escribe ${uso}, el de costumbre.`);
  if (!s.forma_pago) aviso('forma_pago', `Sin forma de pago elegida: se escribe ${forma}, la de costumbre ${credito ? 'con crédito' : 'de contado'}.`);
  const usoCat = e.usos.find((u) => u.clave === uso);
  if (!usoCat) bloquea('uso_cfdi', `El uso de CFDI «${uso}» no está en el catálogo del SAT.`);
  else if (regimen && usoCat.regimenes.length && !usoCat.regimenes.includes(regimen)) {
    bloquea('uso_cfdi', `El SAT no admite el uso ${uso} (${usoCat.descripcion}) con el régimen ${regimen}.`);
  }
  if (!e.formasPago.includes(forma)) bloquea('forma_pago', `La forma de pago «${forma}» no está en el catálogo del SAT.`);
  if (!regimen) bloquea('regimen_fiscal', 'Falta el régimen fiscal.');
  const cpFiscal = String(s.codigo_postal_fiscal ?? '').trim();
  if (!/^\d{5}$/.test(cpFiscal)) bloquea('codigo_postal_fiscal', 'El código postal fiscal lleva 5 dígitos.');

  // ── crédito ──
  const c = credito ? s.credito : null;
  const limite = dinero(c?.credito_aprobado ?? 0);
  const plazo = Math.max(0, Math.trunc(Number(c?.plazo_aprobado ?? 0)));
  const descuento = s.credito?.decision === 'aprobado' ? pct(s.credito.descuento_aprobado) : '';

  const kdud: FilaKepler = {
    c1: '', c2: '', c3: nombre, c4: dir1, c5: dir2, c6: estado, c7: tels[0], c8: tels[1], c9: tels[2],
    c10: rfc, c11: email, c12: vendedor, c13: grupo, c14: zona, c15: limite, c16: plazo, c17: descuento,
    c18: '', c19: '', c20: '', c21: '', c22: '', c23: '', c24: '', c25: '', c26: '',
    c27: cpFicha, c28: '0.0000', c29: '0.0000', c30: curp,
  };
  // CP y nombre fiscal: Kepler los deja VACÍOS cuando son los de la ficha (así quedó 21054) y los
  // llena cuando difieren (116 CP y 51 nombres distintos, medido). Se copia esa conducta.
  const nombreFiscal = textoKepler(s.nombre_fiscal);
  const kdfedir: FilaKepler = {
    c1: 3, c2: '', c3: '1', c4: '', c5: '', c6: '', c7: '', c8: '', c9: '', c10: '', c11: '', c12: '',
    c13: cpFiscal !== cpFicha ? cpFiscal : '', c14: forma, c15: '', c16: uso, c17: 0, c18: regimen,
    c19: nombreFiscal && nombreFiscal !== nombre ? nombreFiscal : '',
  };
  return { plan: { clave: '', kdud, kdfedir }, serie, hallazgos: h };
}

/** La clave ya decidida, en las dos filas. */
export function planConClave(plan: PlanClienteKepler, clave: string): PlanClienteKepler {
  return { clave, kdud: { ...plan.kdud, c2: clave }, kdfedir: { ...plan.kdfedir, c2: clave } };
}

/** Sólo nombres de columna de Kepler: lo que se interpola en el SQL nunca viene de fuera. */
export const COLUMNA_KEPLER = /^c\d{1,3}$/;

const ROTULOS_KDUD: Readonly<Record<string, string>> = {
  c2: 'Clave', c3: 'Nombre', c4: 'Dirección (renglón 1)', c5: 'Dirección (renglón 2)', c6: 'Estado', c27: 'Código postal',
  c7: 'Tel .1', c8: 'Tel .2', c9: 'Tel .3', c10: 'RFC', c30: 'CURP', c11: 'Email',
  c12: 'Vendedor', c13: 'Grupo', c14: 'Zona', c15: 'Límite de crédito', c16: 'Plazo', c17: 'Descuentos (1)',
};
const ROTULOS_KDFEDIR: Readonly<Record<string, string>> = {
  c18: 'Régimen fiscal', c16: 'Uso de CFDI', c14: 'Forma de pago', c13: 'CP fiscal', c19: 'Nombre fiscal',
};

/** Lo que la persona vería en las pantallas de Kepler, en su orden (las columnas siempre vacías no se listan). */
export function columnasDelPlan(plan: PlanClienteKepler): { kdud: ColumnaPlanKepler[]; kdfedir: ColumnaPlanKepler[] } {
  const lista = (fila: FilaKepler, rotulos: Readonly<Record<string, string>>): ColumnaPlanKepler[] =>
    Object.entries(rotulos).map(([columna, rotulo]) => ({ columna, rotulo, valor: String(fila[columna] ?? '') }));
  return { kdud: lista(plan.kdud, ROTULOS_KDUD), kdfedir: lista(plan.kdfedir, ROTULOS_KDFEDIR) };
}
