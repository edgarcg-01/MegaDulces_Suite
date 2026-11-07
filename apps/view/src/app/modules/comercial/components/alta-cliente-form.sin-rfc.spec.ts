import { TestBed } from '@angular/core/testing';
import { of } from 'rxjs';

import { AltaClientesService } from '../alta-clientes.service';
import { AltaClienteFormComponent } from './alta-cliente-form.component';

/**
 * `[ALC.3.3]` «Sin RFC»: el cliente sin RFC es el caso MAYORITARIO (15,160 de 22,558 fichas de
 * Kepler, 67 %, prod 2026-11-06). Elegirlo llena el RFC genérico del SAT, fija persona física y el
 * régimen 616 —el único que el SAT admite con ese RFC— para que la captura avance sola.
 * El código postal NO se llena: no hay un dato medido de dónde sacarlo.
 */
const catalogos = {
  branch: '01', sucursales: [{ clave: '01', nombre: 'Padre Hidalgo' }], vendedores: [], grupos: [], zonas: [],
  regimenes: [
    { clave: '612', descripcion: 'Actividades Empresariales', persona_fisica: true, persona_moral: false },
    { clave: '616', descripcion: 'Sin obligaciones fiscales', persona_fisica: true, persona_moral: false },
    { clave: '601', descripcion: 'General de Ley Personas Morales', persona_fisica: false, persona_moral: true },
  ],
};
const revisados: unknown[] = [];

async function montar(conCatalogos = true) {
  revisados.length = 0;
  await TestBed.configureTestingModule({
    imports: [AltaClienteFormComponent],
    providers: [{
      provide: AltaClientesService,
      useValue: { revisar: (b: unknown) => { revisados.push(b); return of({ hallazgos: [], duplicados: [] }); } },
    }],
  }).compileComponents();
  const fix = TestBed.createComponent(AltaClienteFormComponent);
  fix.componentRef.setInput('catalogos', conCatalogos ? catalogos : null);
  fix.componentRef.setInput('branchInicial', '01');
  fix.detectChanges();
  const cmp = fix.componentInstance;
  cmp.aMano();
  return cmp;
}

describe('[ALC.3.3] alta de cliente: «Sin RFC»', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('llena el RFC genérico (también en la ficha de Kepler), persona física y régimen 616', async () => {
    const cmp = await montar();
    cmp.tipo('moral');
    cmp.set('regimen_capital', 'SOCIEDAD ANONIMA');
    cmp.modoRfc('sin');
    const x = cmp.f();
    expect(cmp.sinRfc()).toBe(true);
    expect(x.rfc).toBe('XAXX010101000');
    expect(x.ficha.rfc).toBe('XAXX010101000');
    expect(x.tipo_persona).toBe('fisica');
    expect(x.regimen_capital).toBeNull();
    expect(x.regimen_fiscal).toBe('616');
    expect(x.codigo_postal_fiscal, 'el CP no se inventa').toBe('');
  });

  it('volver a «Con RFC» vacía RFC y el 616, para capturar los de verdad', async () => {
    const cmp = await montar();
    cmp.modoRfc('sin');
    cmp.modoRfc('con');
    expect(cmp.sinRfc()).toBe(false);
    expect(cmp.f().rfc).toBe('');
    expect(cmp.f().ficha.rfc).toBe('');
    expect(cmp.f().regimen_fiscal).toBe('');
  });

  it('control: con RFC propio, «Con RFC» no toca un régimen que ya se eligió', async () => {
    const cmp = await montar();
    cmp.setRfc('GORF7103285Q0');
    cmp.set('regimen_fiscal', '612');
    cmp.modoRfc('con');
    expect(cmp.f().rfc).toBe('GORF7103285Q0');
    expect(cmp.f().regimen_fiscal).toBe('612');
  });

  it('teclear el genérico a mano equivale a elegir «Sin RFC»', async () => {
    const cmp = await montar();
    cmp.setRfc('xaxx 010101000');
    expect(cmp.sinRfc()).toBe(true);
    expect(cmp.f().regimen_fiscal).toBe('616');
  });

  it('sin catálogo de regímenes no inventa el 616: lo deja por elegir', async () => {
    const cmp = await montar(false);
    cmp.modoRfc('sin');
    expect(cmp.f().rfc).toBe('XAXX010101000');
    expect(cmp.f().regimen_fiscal).toBe('');
  });
});

/**
 * `[ALC.3.4]` El CP llena el estado (el SAT da uno por CP) y SUGIERE el renglón 2 (colonia,
 * municipio) como lo escriben las fichas de Kepler con ese CP: no hay catálogo de colonias.
 */
describe('[ALC.3.4] alta de cliente: el código postal llena el estado y sugiere la colonia', () => {
  let consultas: string[] = [];
  const respuesta = (cp: string) => ({
    codigo_postal: cp, estado: cp === '00000' ? null : 'MICHOACAN',
    sugerencias_direccion_2: cp === '59300' ? [{ texto: 'CENTRO, LA PIEDAD', fichas: 510 }, { texto: 'LA PURISIMA, LA PIEDAD', fichas: 27 }] : [],
  });
  async function montarCp() {
    consultas = [];
    await TestBed.configureTestingModule({
      imports: [AltaClienteFormComponent],
      providers: [{
        provide: AltaClientesService,
        useValue: {
          revisar: () => of({ hallazgos: [], duplicados: [] }),
          codigoPostal: (cp: string) => { consultas.push(cp); return of(respuesta(cp)); },
        },
      }],
    }).compileComponents();
    const fix = TestBed.createComponent(AltaClienteFormComponent);
    fix.componentRef.setInput('catalogos', catalogos);
    fix.detectChanges();
    fix.componentInstance.aMano();
    return fix.componentInstance;
  }
  beforeEach(() => TestBed.resetTestingModule());

  it('con 5 dígitos llena el estado y ofrece las colonias de Kepler, sin llenar el renglón 2', async () => {
    const cmp = await montarCp();
    cmp.setFicha('codigo_postal', '5930');
    expect(consultas, 'con 4 dígitos no se consulta').toEqual([]);
    cmp.setFicha('codigo_postal', '59300');
    expect(consultas).toEqual(['59300']);
    expect(cmp.f().ficha.estado).toBe('MICHOACAN');
    expect(cmp.sugerenciasDir2().map((s) => s.texto)).toEqual(['CENTRO, LA PIEDAD', 'LA PURISIMA, LA PIEDAD']);
    expect(cmp.f().ficha.direccion_2, 'la colonia se elige, no se adivina').toBe('');
    cmp.usarSugerencia('LA PURISIMA, LA PIEDAD');
    expect(cmp.f().ficha.direccion_2).toBe('LA PURISIMA, LA PIEDAD');
  });

  it('⛔ no pisa un estado que la persona escribió', async () => {
    const cmp = await montarCp();
    cmp.setFicha('estado', 'JALISCO');
    cmp.setFicha('codigo_postal', '59300');
    expect(cmp.f().ficha.estado).toBe('JALISCO');
  });

  it('el CP fiscal también lo dispara, y un CP repetido no vuelve a consultar', async () => {
    const cmp = await montarCp();
    cmp.setCp('59300');
    cmp.setCp('59300');
    expect(consultas).toEqual(['59300']);
    expect(cmp.f().ficha.estado).toBe('MICHOACAN');
  });

  it('CP fuera del catálogo del SAT: no inventa estado', async () => {
    const cmp = await montarCp();
    cmp.setFicha('codigo_postal', '00000');
    expect(cmp.f().ficha.estado).toBe('');
  });
});

/**
 * `[ALC.3.5]` Ubicación opcional: buscar el domicilio (geocodificador, se paga por llamada: sólo con
 * un clic y sólo si hay calle) o el GPS del teléfono; un clic en el mapa la corrige.
 */
describe('[ALC.3.5] alta de cliente: la ubicación', () => {
  let buscadas: string[] = [];
  let resultados: { lat: number; lng: number; place_name: string; relevance: number }[] = [];
  async function montarGeo() {
    buscadas = [];
    await TestBed.configureTestingModule({
      imports: [AltaClienteFormComponent],
      providers: [{
        provide: AltaClientesService,
        useValue: {
          revisar: () => of({ hallazgos: [], duplicados: [] }),
          codigoPostal: (cp: string) => of({ codigo_postal: cp, estado: 'MICHOACAN', sugerencias_direccion_2: [] }),
          geocode: (q: string) => { buscadas.push(q); return of({ results: resultados }); },
        },
      }],
    }).compileComponents();
    const fix = TestBed.createComponent(AltaClienteFormComponent);
    fix.componentRef.setInput('catalogos', catalogos);
    fix.detectChanges();
    fix.componentInstance.aMano();
    return fix.componentInstance;
  }
  beforeEach(() => TestBed.resetTestingModule());

  it('sin calle no se busca (no se gasta una llamada); con calle busca el domicilio entero', async () => {
    const cmp = await montarGeo();
    resultados = [{ lat: 20.34561234, lng: -102.03118765, place_name: 'La Piedad', relevance: 0.9 }];
    expect(cmp.direccionParaBuscar()).toBe('');
    cmp.ubicarPorDireccion();
    expect(buscadas).toEqual([]);
    cmp.setFicha('direccion_1', 'av. hidalgo 120');
    cmp.setFicha('direccion_2', 'centro, la piedad');
    cmp.setFicha('codigo_postal', '59300');
    cmp.ubicarPorDireccion();
    expect(buscadas).toEqual(['AV. HIDALGO 120, CENTRO, LA PIEDAD, 59300, MICHOACAN, MEXICO']);
    expect(cmp.f().ubicacion).toEqual({ lat: 20.345612, lng: -102.031188, origen: 'direccion', precision_m: null });
  });

  it('si el mapa no encuentra la dirección, lo dice y no inventa un punto', async () => {
    const cmp = await montarGeo();
    resultados = [];
    cmp.setFicha('direccion_1', 'CALLE QUE NO EXISTE 1');
    cmp.ubicarPorDireccion();
    expect(cmp.f().ubicacion ?? null).toBeNull();
    expect(cmp.avisoUbicacion()).toMatch(/No se encontró/);
  });

  it('el GPS guarda su precisión; un clic en el mapa lo corrige; «Quitar» la deja vacía', async () => {
    const cmp = await montarGeo();
    const real = Object.getOwnPropertyDescriptor(globalThis.navigator, 'geolocation');
    Object.defineProperty(globalThis.navigator, 'geolocation', {
      configurable: true,
      value: { getCurrentPosition: (ok: (p: unknown) => void) => ok({ coords: { latitude: 19.7027014, longitude: -101.1923981, accuracy: 12.44 } }) },
    });
    try {
      (cmp as unknown as { hayGps: boolean }).hayGps = true;
      cmp.usarMiUbicacion();
      expect(cmp.f().ubicacion).toEqual({ lat: 19.702701, lng: -101.192398, origen: 'gps', precision_m: 12.4 });
      cmp.moverPunto({ lat: 19.7031, lng: -101.1919 });
      expect(cmp.f().ubicacion).toEqual({ lat: 19.7031, lng: -101.1919, origen: 'mapa', precision_m: null });
      cmp.quitarUbicacion();
      expect(cmp.f().ubicacion).toBeNull();
    } finally {
      if (real) Object.defineProperty(globalThis.navigator, 'geolocation', real);
      else delete (globalThis.navigator as unknown as Record<string, unknown>)['geolocation'];
    }
  });
});
