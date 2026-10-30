# Finanzas › Gastos — agregar evidencia a un vale, con su porqué (GX.87)

## Problema

La evidencia de un vale se sube al darlo de alta, en casillas fijas (solicitud firmada, comprobante, hoja 2, tres
fotos). Lo que llega **después** —la factura definitiva de una prefactura, el ticket que apareció, la foto que pidió
quien revisa— no tenía dónde entrar. El único camino era pedir la reapertura del vale (`GX.29`), que cambia su
estado y espera a que alguien la apruebe.

## Solución

Un botón **«Agregar evidencia»** junto a la sección «Evidencia» del expediente de cada vale. Abre un diálogo donde se
eligen hasta 5 archivos (foto, PDF o cualquier documento, 20 MB cada uno) y se escribe **por qué** se agregan. Al
enviar:

- los archivos se **suman** al expediente; no se reemplaza ni se borra nada;
- el vale **no cambia de estado** ni de firmas;
- cada archivo queda con su porqué, quién lo agregó y cuándo, a la vista en el expediente y en el PDF
  («Agregada después: «porqué» · quién · cuándo»).

Pueden agregar el **dueño del vale** y **quien aprueba gastos**. Un vale rechazado no acepta evidencia: se vuelve a
capturar.

## Cómo se implementó

- **Regla** en `libs/contracts/src/finance/evidencia-adicional.contract.ts`: rol `adicional`, porqué de al menos 10
  caracteres, máximo 5 archivos por envío, estados que aceptan (`recibida`, `aprobada`, `revision`, `validada`) y el
  texto de lo que falta. La usan la pantalla (botón deshabilitado y su motivo) y el servidor (400 con el mismo texto).
- **Servidor** (`expense-proofs.service.ts` › `agregarEvidenciaAdicional`, endpoint
  `POST /finance/expenses/proofs/:id/evidencia-adicional`):
  - lee el vale con `FOR UPDATE` para que dos envíos no se pisen;
  - decide quién puede: dueño con `esDuenoDelVale` (contra el nombre real del padrón) o aprobador (`COMPROBAR` o
    admin de plataforma); si no, 403;
  - el porqué, el autor y la hora los pone el servidor; del cliente sólo se toman los datos del archivo ya subido;
  - devuelve el expediente completo ya firmado, firmado **fuera** de la transacción.
- **Pantalla:** el visor compartido (`vale-gasto-peek`) recibe la acción `agregar_evidencia` y emite; el diálogo
  `evidencia-adicional-dialog` sube cada archivo (con su propio manejo de error) y registra. Cada página decide si lo
  ofrece: Mis gastos (lo tuyo), Historial («Míos», o «Todos» con `COMPROBAR`) y Aprobación (siempre: la pantalla ya
  exige `COMPROBAR`).
- **PDF:** `archivoDelExpedienteHtml` en `expediente-gasto-document.service.ts`.

## Por qué así

- **No cambiar el estado** fue la decisión del usuario («se agrega y ya»): sumar un papel no es volver a decidir el
  gasto. Si cambiara el estado, cada factura tardía reabriría la cola de aprobación.
- **El porqué es obligatorio** porque un archivo que aparece en un expediente cerrado sin explicación se lee como una
  alteración; con su porqué, quién y cuándo, se lee como lo que es.
- **Diálogo aparte del de alta:** el de alta crea el vale y tiene casillas fijas; mezclarlo haría que un mismo
  diálogo conteste dos preguntas.
- **Las decisiones del pie se separan de esta acción:** agregar evidencia no es decidir, y sin esa separación un vale
  que sólo ofrecía agregar mostraba un «Rechazar» que nadie le había ofrecido.

## Pendiente / declarado

- Sin validación visual en navegador ni prueba del endpoint contra base real.
- El servidor no verifica que la llave del archivo sea de una subida de quien la manda (mismo modelo que el alta).
- Se solapa con la reapertura (`GX.29`): falta decidir si la reapertura queda sólo para corregir datos.
- Nadie recibe aviso cuando aparece evidencia nueva en un vale ya cerrado.
