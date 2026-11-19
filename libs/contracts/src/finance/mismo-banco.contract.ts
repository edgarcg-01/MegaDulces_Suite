/**
 * `[PGP.155]` **Una transferencia a una cuenta SIN CLABE sólo sale de una cuenta nuestra del mismo banco.**
 *
 * Sin CLABE no hay SPEI: el banco sólo mueve dinero entre sus propias cuentas con el número de cuenta.
 * VUMERSOFT (`CD004`) se paga así: su cuenta del catálogo es BBVA, 10 dígitos, sin CLABE. Medido en prod el
 * 2026-11-18 (sólo lectura): sus 40 salidas del banco identificadas salieron de cinco cuentas BBVA nuestras
 * (5712, 6586, 4176, 2182, 4885), rotando, y su hábito de origen es «variable» (22 de 42 con la más usada).
 * Por eso la regla NO elige una cuenta BBVA: restringe a las BBVA, y la Tesorería decide cuál (`[PGP.75]`).
 *
 * La misma regla en la pantalla (el diálogo «Preparar» ofrece sólo las del banco) y en el servidor (que
 * rechaza otro banco). ⛔ Un banco que no se reconoce NO se bloquea: se compara sólo lo que se sabe nombrar.
 */

/**
 * Los nombres con que se escriben los bancos, a uno solo. Las cuentas nuestras (`finance.bank_accounts.bank`)
 * se llaman BANAMEX · BANORTE · BBAJIO · BBVA · SANTANDER (medido); las del catálogo de proveedor son texto
 * libre («BBVA», «Bancomer», «BanBajío»…).
 */
const ALIAS_BANCO: ReadonlyArray<[canonico: string, alias: readonly string[]]> = [
  ['BBVA', ['BBVA', 'BANCOMER', 'BBVA BANCOMER', 'BBVA MEXICO']],
  ['BANAMEX', ['BANAMEX', 'CITIBANAMEX', 'CITI BANAMEX', 'BANCO NACIONAL DE MEXICO']],
  ['BBAJIO', ['BBAJIO', 'BAJIO', 'BANBAJIO', 'BANCO DEL BAJIO', 'BANCO BAJIO']],
  ['BANORTE', ['BANORTE', 'BANCO MERCANTIL DEL NORTE']],
  ['SANTANDER', ['SANTANDER', 'BANCO SANTANDER']],
  ['HSBC', ['HSBC']],
  ['SCOTIABANK', ['SCOTIABANK', 'SCOTIA']],
  ['INBURSA', ['INBURSA']],
  ['AZTECA', ['AZTECA', 'BANCO AZTECA']],
  ['BANREGIO', ['BANREGIO']],
  ['AFIRME', ['AFIRME']],
];

/** El banco con su nombre canónico, o `null` si no se reconoce (entonces no se compara). */
export function bancoCanonico(nombre: string | null | undefined): string | null {
  const n = String(nombre ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase()
    .replace(/[^A-Z ]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!n) return null;
  for (const [canonico, alias] of ALIAS_BANCO) if (alias.includes(n)) return canonico;
  return null;
}

/**
 * La cuenta destino no tiene una CLABE de 18 dígitos y se paga con su número de cuenta, así que sólo se le
 * transfiere desde el mismo banco. `[PGP.155.2]` Una TARJETA de débito (16 dígitos) no cuenta: SPEI la acepta
 * desde cualquier banco (revisión independiente; hoy no hay ninguna en el catálogo, medido 2026-11-18).
 */
export function destinoSinClabe(d: { clabe: string | null | undefined; account_number?: string | null } | null | undefined): boolean {
  if (!d || String(d.clabe ?? '').replace(/\D/g, '').length === 18) return false;
  return String(d.account_number ?? '').replace(/\D/g, '').length !== 16;
}

/**
 * Por qué ese origen no sirve para ese destino (null = sirve, o no se puede saber). Sólo aplica a una cuenta
 * del catálogo sin CLABE y a un origen que es cuenta de banco; caja o factoraje no se juzgan aquí.
 */
export function faltaOrigenMismoBanco(p: {
  destino: { clabe: string | null | undefined; bank_name: string | null | undefined; account_number?: string | null } | null;
  origen: { bank: string | null | undefined; kind?: string | null } | null;
}): string | null {
  if (!p.destino || !p.origen || !destinoSinClabe(p.destino)) return null;
  if (p.origen.kind && p.origen.kind !== 'bank') return null;
  const dest = bancoCanonico(p.destino.bank_name), orig = bancoCanonico(p.origen.bank);
  if (!dest || !orig || dest === orig) return null;
  return `La cuenta destino no tiene CLABE: la transferencia sale sólo de una cuenta ${dest} nuestra (es entre cuentas del mismo banco). Elige una cuenta ${dest}.`;
}

/**
 * El origen que se deja puesto cuando el destino obliga un banco. Qué cuenta de ese banco NO se adivina
 * (`[PGP.75]`): se queda la que ya estaba si sirve; si no, la del día (la barra de la Tesorería); si no, la de su
 * historial; si sólo sirve una, ésa; si no, ninguna (la Tesorería elige entre las que sirven).
 */
export function origenPropuesto(p: {
  actual: string | null; sirven: readonly string[]; delDia: string | null; historial: string | null;
}): string | null {
  const ok = new Set(p.sirven);
  for (const id of [p.actual, p.delDia, p.historial]) if (id && ok.has(id)) return id;
  return p.sirven.length === 1 ? p.sirven[0] : null;
}

type DestinoCatalogo = { clabe: string | null | undefined; bank_name: string | null | undefined; account_number?: string | null };
const esCuentaDeBanco = (o: { kind?: string | null }) => !o.kind || o.kind === 'bank';

/**
 * Los orígenes que sirven para ese destino: si es una cuenta sin CLABE de un banco conocido, de las cuentas de
 * banco nuestras sólo las de ese banco; caja y factoraje se quedan (`faltaOrigenMismoBanco` no los juzga — la
 * pantalla y el servidor con la MISMA regla, `[PGP.155.2]`). Nunca deja la lista vacía: si no tenemos cuenta de
 * ese banco devuelve todas, y la pantalla lo dice con `bancoSinCuentaNuestra` (no con «sólo se ofrecen ésas»).
 */
export function origenesParaDestino<T extends { bank: string | null | undefined; kind?: string | null }>(
  origenes: readonly T[], destino: DestinoCatalogo | null,
): T[] {
  if (!destino || !destinoSinClabe(destino)) return [...origenes];
  const dest = bancoCanonico(destino.bank_name);
  if (!dest) return [...origenes];
  const delBanco = origenes.filter((o) => esCuentaDeBanco(o) && bancoCanonico(o.bank) === dest);
  if (!delBanco.length) return [...origenes];
  return origenes.filter((o) => !esCuentaDeBanco(o) || delBanco.includes(o));
}

/**
 * `[PGP.155.2]` El banco de un destino sin CLABE del que NO tenemos ninguna cuenta (p. ej. HSBC): así no se le
 * puede transferir desde nuestras cuentas. `null` si el destino no obliga banco, no se reconoce, o sí tenemos.
 */
export function bancoSinCuentaNuestra(
  origenes: readonly { bank: string | null | undefined; kind?: string | null }[], destino: DestinoCatalogo | null,
): string | null {
  if (!destino || !destinoSinClabe(destino)) return null;
  const dest = bancoCanonico(destino.bank_name);
  if (!dest) return null;
  return origenes.some((o) => esCuentaDeBanco(o) && bancoCanonico(o.bank) === dest) ? null : dest;
}
