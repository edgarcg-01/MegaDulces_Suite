import { ChangeDetectionStrategy, Component } from '@angular/core';
import { AnalisisProximaEtapaComponent } from './analisis-proxima-etapa.component';

/**
 * `[TDA.A1]` Sección **Promociones** de `/tienda/analisis-semanal` — declarada, sin dato aún.
 *
 * Es la que está más lejos de las cuatro, y conviene que se sepa antes de planearla: en
 * este momento **no hay un registro de qué promoción estuvo vigente y cuándo**. El fact
 * de venta guarda lo que se cobró, no por qué se cobró eso; el descuento por volumen que
 * sí existe en el ERP vive como códigos aparte (los «DESC…» que se toparon en Fase CV),
 * no como una campaña con fechas.
 *
 * Medir el efecto de una promoción sin saber cuándo estuvo prendida no es difícil: es
 * imposible. Por eso esta pestaña no arranca con gráficas, arranca con el pendiente.
 */
@Component({
  selector: 'app-tienda-analisis-promociones',
  standalone: true,
  imports: [AnalisisProximaEtapaComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <app-analisis-proxima-etapa
      icon="pi pi-percentage"
      titulo="Promociones — próxima etapa"
      lead="Qué promoción corrió, cuándo, y qué pasó con la venta mientras corría."
      [puntos]="puntos"
      falta="Lo primero no es la pantalla: es el registro. Hoy no existe una tabla que diga qué promoción estuvo vigente, en qué sucursales y entre qué fechas. Sin eso, cualquier «la promo subió la venta 12%» sería una cifra inventada. El descuento por volumen que ya maneja el ERP vive como códigos sueltos, no como campaña con fechas." />
  `,
})
export class TiendaAnalisisPromocionesComponent {
  protected readonly puntos = [
    'Calendario de promociones: qué corrió, dónde y entre qué fechas.',
    'Venta y margen del producto en promoción contra sus semanas normales.',
    'Si la promo arrastró otras compras o sólo movió el mismo ticket.',
    'Qué costó el descuento contra lo que sumó de venta.',
  ];
}
