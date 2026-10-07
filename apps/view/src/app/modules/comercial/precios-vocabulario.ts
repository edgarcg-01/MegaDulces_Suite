/**
 * `[PR.V5]` — **Una sola voz para el vocabulario del motor de margen.**
 *
 * El motor habla con siete verbos y cinco grados de certeza, y los dos aparecen en tres lugares:
 * la cola, la ventana del expediente y la ayuda contextual. Tenerlos escritos tres veces los
 * desincroniza sin que nadie se entere — el día que «Corregir la escalera» cambie de nombre,
 * cambiaría en una pantalla y no en la otra.
 *
 * ⭐ **La glosa no es decoración.** «Corregir la escalera» no le dice nada a quien no sabe qué es
 * una escalera, y mandarlo al cajón de ayuda es pedirle un clic para entender la pantalla que ya
 * está mirando. La glosa va impresa al lado del verbo, siempre.
 *
 * ⚠️ La ayuda contextual (`context-help.dictionary.ts`) explica **a fondo**, con los números
 * medidos; esto es la línea corta que evita tener que abrirla. Si las dos se contradicen, manda
 * la ayuda, que es la que se revisa contra la regla de `analytics.v_price_action`.
 */

/** El verbo, como se imprime. */
export const ETIQUETA_ACCION: Record<string, string> = {
  corregir_escalera: 'Corregir la escalera',
  revisar_costo: 'Revisar el costo',
  aterrizar_precio: 'Aterrizar el precio',
  subir_precio: 'Subir el precio',
  liberar_capital: 'Liberar capital',
  precio_atipico: 'Precio atípico',
  sin_accion_defendible: 'Sin acción defendible',
};

/** Qué significa el verbo, en una línea y sin jerga. */
export const GLOSA_ACCION: Record<string, string> = {
  corregir_escalera: 'la caja sale más cara por pieza que la suelta',
  revisar_costo: 'el costo se movió y el precio sigue igual',
  aterrizar_precio: 'falta muy poco para el siguiente precio redondo',
  subir_precio: 'hay espacio hasta el siguiente precio redondo',
  liberar_capital: 'inventario parado que se mueve bajando el precio',
  precio_atipico: 'no es mercancía ordinaria: no se propone nada',
  sin_accion_defendible: 'no hay con qué sostener una propuesta',
};

/** Qué tan en firme está lo que el motor dice. */
export const TEXTO_CERTEZA: Record<string, string> = {
  aritmetica: 'Aritmética',
  efecto_no_medido: 'Efecto no medido',
  regla_de_operacion: 'Regla de operación',
  fuera_de_alcance: 'Fuera de alcance',
  sin_evidencia: 'Sin evidencia',
};

export const etiquetaAccion = (a: string): string => ETIQUETA_ACCION[a] ?? a;
export const glosaAccion = (a: string): string => GLOSA_ACCION[a] ?? '';
export const textoCerteza = (c: string): string => TEXTO_CERTEZA[c] ?? c;
