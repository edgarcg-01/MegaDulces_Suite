import { TestBed } from '@angular/core/testing';
import { of } from 'rxjs';

import { AltaClientesService } from '../alta-clientes.service';
import { AltaClienteFormComponent } from './alta-cliente-form.component';

/**
 * `[ALC.3.6]` «Que el módulo asista demasiado al usuario» (Francisco, 2026-11-07): la cartera llega
 * puesta por la sucursal y lo que Kepler guarda para timbrar toma el valor de costumbre. Los códigos
 * son los de Kepler medidos (zona 20000 Morelia, piso de Morelia Abastos 2VP01 → vendedor 20002).
 */
const catalogos = {
  branch: '08',
  sucursales: [{ clave: '08', nombre: 'Morelia Abastos' }, { clave: '00', nombre: 'CEDIS' }],
  zonas: [{ clave: '02', nombre: 'ZONA MORELIA' }, { clave: '10000', nombre: 'CLIENTES ZONA LA PIEDAD' }, { clave: '20000', nombre: 'CLIENTES ZONA MORELIA' }],
  grupos: [{ clave: '1V001', nombre: 'VECINAL ZONA LA PIEDAD' }, { clave: '2V001', nombre: 'VECINAL MORELIA' }, { clave: '2VP01', nombre: 'VENTA DE PISO MORELIA ABASTOS' }],
  vendedores: [{ clave: '10002', nombre: 'TLMK LA PIEDAD' }, { clave: '20002', nombre: 'SUC MORELIA ABASTOS PISO' }, { clave: '2V003', nombre: 'VECINAL MORELIA 3' }],
  regimenes: [
    { clave: '612', descripcion: 'Actividades Empresariales', persona_fisica: true, persona_moral: false },
    { clave: '616', descripcion: 'Sin obligaciones fiscales', persona_fisica: true, persona_moral: false },
  ],
  usos_cfdi: [
    { clave: 'G01', descripcion: 'Adquisición de mercancías.', regimenes: ['612'] },
    { clave: 'S01', descripcion: 'Sin efectos fiscales.', regimenes: ['612', '616'] },
  ],
  formas_pago: [{ clave: '01', nombre: 'Efectivo' }, { clave: '99', nombre: 'Por definir' }],
  sugeridos: { zona: '20000', grupo_piso: '2VP01', vendedor_por_grupo: { '2VP01': '20002', '2V001': '2V003', '1V001': '1V003' } },
};

async function montar() {
  await TestBed.configureTestingModule({
    imports: [AltaClienteFormComponent],
    providers: [{ provide: AltaClientesService, useValue: { revisar: () => of({ hallazgos: [], duplicados: [] }) } }],
  }).compileComponents();
  const fix = TestBed.createComponent(AltaClienteFormComponent);
  fix.componentRef.setInput('catalogos', catalogos);
  fix.componentRef.setInput('branchInicial', '08');
  fix.detectChanges();
  const cmp = fix.componentInstance;
  cmp.aMano();
  fix.detectChanges();
  return { cmp, fix };
}

describe('[ALC.3.6] alta de cliente: la cartera y lo fiscal, asistidos', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('la sucursal pone zona, su grupo de piso y el vendedor de ese grupo', async () => {
    const { cmp } = await montar();
    expect(cmp.f()).toMatchObject({ zona_code: '20000', grupo_code: '2VP01', vendedor_code: '20002' });
  });

  it('sólo zonas de clientes, y grupos y vendedores de la zona', async () => {
    const { cmp } = await montar();
    expect(cmp.zonas().map((z) => z.clave)).toEqual(['10000', '20000']);
    expect(cmp.grupos().map((g) => g.clave)).toEqual(['2V001', '2VP01']);
    expect(cmp.vendedores().map((v) => v.clave)).toEqual(['20002', '2V003']);
  });

  it('otro grupo trae su vendedor si el anterior era el sugerido; uno elegido a mano no se pisa', async () => {
    const { cmp } = await montar();
    cmp.cambiarGrupo('2V001');
    expect(cmp.f().vendedor_code).toBe('2V003');
    cmp.set('vendedor_code', '20002');
    cmp.cambiarGrupo('2VP01');
    expect(cmp.f().vendedor_code).toBe('20002');
    cmp.set('vendedor_code', '2V003');
    cmp.cambiarGrupo('2V001');
    expect(cmp.f().vendedor_code, 'elegido a mano: se queda').toBe('2V003');
  });

  it('NEGATIVA: cambiar a otra zona suelta el grupo y el vendedor que no son de ella', async () => {
    const { cmp } = await montar();
    cmp.cambiarZona('10000');
    expect(cmp.f()).toMatchObject({ zona_code: '10000', grupo_code: null, vendedor_code: null });
    expect(cmp.grupos().map((g) => g.clave)).toEqual(['1V001']);
  });

  it('lo vacío se llena; lo que la persona quitó a mano no vuelve solo', async () => {
    const { cmp, fix } = await montar();
    cmp.set('vendedor_code', null);
    fix.detectChanges();
    expect(cmp.f().vendedor_code).toBeNull();
  });

  it('uso de CFDI y forma de pago de costumbre: G01/01 con RFC; S01 sin RFC; 99 con crédito', async () => {
    const { cmp } = await montar();
    expect(cmp.usoEfectivo()).toBe('G01');
    expect(cmp.formaEfectiva()).toBe('01');
    cmp.set('credito_solicitado', 5000);
    expect(cmp.formaEfectiva()).toBe('99');
    cmp.modoRfc('sin');
    expect(cmp.usoEfectivo()).toBe('S01');
    // con el 616 sólo se ofrecen los usos que el SAT admite
    expect(cmp.usosCfdi().map((u) => u.clave)).toEqual(['S01']);
    expect(cmp.f().uso_cfdi, 'no se guarda: lo pone el servidor con la misma regla').toBeUndefined();
  });
});
