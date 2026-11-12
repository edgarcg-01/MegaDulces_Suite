import { Permission } from '../../core/constants/permissions';
import { pestanaVisible } from '../../shared/components/page-tabs/pestanas-de-area';
import { PROMOS_TABS } from './promos-tabs';

/**
 * `[MKT.7]` La barra de Promociones MKT debe enseñar lo mismo que dejan entrar los guards de
 * `app.routes.ts` (bloque `mkt`). Los repartos son los MEDIDOS en prod el 2026-11-11.
 */
const con = (...ps: Permission[]) => (p: Permission) => ps.includes(p);
const visibles = (tiene: (p: Permission) => boolean) =>
  PROMOS_TABS.filter((t) => pestanaVisible(t, tiene)).map((t) => t.label);

describe('[MKT.7] pestañas de Promociones MKT', () => {
  it('Mercadotecnia (VER + GESTIONAR acuerdos, sin subir evidencia) ve las cuatro', () => {
    const marketing = con(
      Permission.COMMERCIAL_PROMOTIONS_VER,
      Permission.COMMERCIAL_ERP_PROMOS_VER,
      Permission.MKT_AGREEMENTS_VER,
      Permission.MKT_AGREEMENTS_GESTIONAR,
    );
    expect(visibles(marketing)).toEqual(['Promociones', 'Promos ERP', 'Acuerdos', 'Resultado']);
  });

  it('la plaza que sólo sube evidencia sigue viendo Acuerdos y Resultado', () => {
    expect(visibles(con(Permission.MKT_AGREEMENT_EVIDENCE_SUBIR))).toEqual(['Acuerdos', 'Resultado']);
  });

  it('sólo GESTIONAR acuerdos: ve Acuerdos (su guard lo acepta) y no Resultado (el suyo no)', () => {
    expect(visibles(con(Permission.MKT_AGREEMENTS_GESTIONAR))).toEqual(['Acuerdos']);
  });

  it('«Promos ERP» pide el MISMO permiso que su ruta, no el de las promociones propias', () => {
    expect(visibles(con(Permission.COMMERCIAL_ERP_PROMOS_VER))).toEqual(['Promos ERP']);
    expect(visibles(con(Permission.COMMERCIAL_PROMOTIONS_VER))).toEqual(['Promociones']);
  });

  it('sin permisos no ve ninguna', () => {
    expect(visibles(con())).toEqual([]);
  });
});
