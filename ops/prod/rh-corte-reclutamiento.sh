#!/usr/bin/env bash
# `[RH.3.5]` Corte de reclutamiento y bot: Mega Talento → Suite. Se corre EN md, paso por paso.
# El porqué de cada paso y la reversa: docs/IMPLEMENTACION/RUNBOOKS/RH_CORTE_RECLUTAMIENTO.md
#
# Antes, desde la laptop (raíz del repo):
#   scp ops/prod/rh-corte-reclutamiento.sh database/scripts/rh/carga-reclutamiento-mega-talento.js \
#       database/scripts/rh/carga-archivos-mega-talento.js superoot@192.168.0.222:/tmp/
#
# En md:
#   bash /tmp/rh-corte-reclutamiento.sh numero        # en el día: el número de RH a su flujo
#   bash /tmp/rh-corte-reclutamiento.sh credenciales  # en el día, con David: clave y token de la app de RH
#   bash /tmp/rh-corte-reclutamiento.sh ensayo        # 19:00: la carga en prod, se deshace sola
#   bash /tmp/rh-corte-reclutamiento.sh aplicar       # la carga de verdad → David mueve el webhook → otra vez `aplicar`
#   bash /tmp/rh-corte-reclutamiento.sh archivos      # los archivos al bucket (~15–20 min)
#   bash /tmp/rh-corte-reclutamiento.sh verificar     # conteos, sólo lectura
#
# Ningún secreto pasa por la línea de comandos ni por la pantalla: viven en ~/secrets (600) y en prod-env.
set -euo pipefail
export KUBECONFIG=/etc/rancher/k3s/k3s.yaml

NUMERO_RH=1202633676268668
APP_RH=1325462126340938
TENANT=00000000-0000-0000-0000-00000000d01c
SCRIPTS=(carga-reclutamiento-mega-talento.js carga-archivos-mega-talento.js)
SELLO=$(date +%Y%m%d-%H%M)

api() { kubectl get pods -n prod -l app=api -o jsonpath='{.items[0].metadata.name}'; }
psql_prod() { kubectl -n prod exec -i deploy/pg-prod -- psql -U postgres -d railway -v ON_ERROR_STOP=1 -P pager=off "$@"; }

# Los scripts no vienen en la imagen: se copian al MISMO pod en que se corren (un reinicio los borra).
copiar() {
  local pod=$1
  for s in "${SCRIPTS[@]}"; do
    [ -f "/tmp/$s" ] || { echo "⛔ falta /tmp/$s: copiarlo desde la laptop (ver la cabecera)"; exit 1; }
    kubectl cp "/tmp/$s" "prod/$pod:/app/database/scripts/rh/$s" -c api
  done
}

carga() {
  local pod; pod=$(api)
  [ -f ~/secrets/mt.url ] || { echo "⛔ falta ~/secrets/mt.url (install -m 600 /dev/null ~/secrets/mt.url && nano ~/secrets/mt.url)"; exit 1; }
  copiar "$pod"
  kubectl cp ~/secrets/mt.url "prod/$pod:/tmp/mt.url" -c api
  echo "pod $pod · $*"
  kubectl exec -n prod "$pod" -c api -- sh -c \
    "CARGA_URL=\"\$DATABASE_URL_NEW\" MT_DATABASE_URL=\"\$(cat /tmp/mt.url)\" \
     node /app/database/scripts/rh/carga-reclutamiento-mega-talento.js --con-bot --destino-prod $*; s=\$?; rm -f /tmp/mt.url; exit \$s"
}

case "${1:-}" in
  numero)
    psql_prod -c "INSERT INTO whatsapp.phone_number_tenant_map (phone_number_id, tenant_id, label, flow)
      VALUES ('$NUMERO_RH', '$TENANT', 'Reclutamiento RH (+52 352 123 1708)', 'recruitment')
      ON CONFLICT (phone_number_id) DO UPDATE SET flow = 'recruitment';" \
      -c "SELECT phone_number_id, flow, label FROM whatsapp.phone_number_tenant_map ORDER BY created_at;"
    ;;

  credenciales)
    for f in wa-rh.secret wa-rh.token; do
      [ -s ~/secrets/$f ] || { echo "⛔ falta ~/secrets/$f: install -m 600 /dev/null ~/secrets/$f && nano ~/secrets/$f"; exit 1; }
      [ "$(stat -c %a ~/secrets/$f)" = 600 ] || { echo "⛔ ~/secrets/$f no es 600"; exit 1; }
      printf '%s  huella %s\n' "$f" "$(tr -d '\n' < ~/secrets/$f | sha256sum | cut -c1-16)"
    done
    kubectl -n prod get secret prod-env -o yaml > ~/secrets/prod-env.respaldo-$SELLO.yaml
    chmod 600 ~/secrets/prod-env.respaldo-$SELLO.yaml
    echo "respaldo: ~/secrets/prod-env.respaldo-$SELLO.yaml (la reversa)"
    largo=$(kubectl -n prod get secret prod-env -o jsonpath='{.data.WHATSAPP_VERIFY_TOKEN}' | base64 -d | wc -c)
    [ "$largo" -gt 0 ] || echo "⚠️  WHATSAPP_VERIFY_TOKEN está vacío: sin él Meta no verifica el webhook (agregarlo antes de §3.4)"
    # `[RH.3.5c]` ya está desplegado: la app de RH entra con SUS variables y las de Ventas no se tocan. Si el código del
    # pod no las conoce, cargarlas no serviría de nada: no sigo.
    for p in $(kubectl get pods -n prod -l app=api -o jsonpath='{.items[*].metadata.name}'); do
      kubectl exec -n prod "$p" -c api -- grep -q WHATSAPP_RECRUITMENT_APP_SECRET /app/dist/apps/api/main.js \
        || { echo "⛔ el pod $p no trae [RH.3.5c] (WHATSAPP_RECRUITMENT_*): desplegar primero"; exit 1; }
    done
    kubectl -n prod patch secret prod-env --type merge -p "{\"stringData\":{\
\"WHATSAPP_RECRUITMENT_APP_SECRET\":\"$(tr -d '\n' < ~/secrets/wa-rh.secret)\",\
\"WHATSAPP_RECRUITMENT_ACCESS_TOKEN\":\"$(tr -d '\n' < ~/secrets/wa-rh.token)\",\
\"WHATSAPP_RECRUITMENT_PHONE_NUMBER_ID\":\"$NUMERO_RH\"}}" > /dev/null
    kubectl -n prod rollout restart deploy/api && kubectl -n prod rollout status deploy/api
    pod=$(api)
    echo "— la clave (debe decir mega-dulces-rh):"
    kubectl exec -n prod "$pod" -c api -- node -e "fetch('https://graph.facebook.com/v21.0/$APP_RH?fields=name&access_token=$APP_RH%7C'+process.env.WHATSAPP_RECRUITMENT_APP_SECRET).then(r=>r.text()).then(console.log)"
    echo "— el token (debe decir el +52 1 352 123 1708):"
    kubectl exec -n prod "$pod" -c api -- node -e "fetch('https://graph.facebook.com/v21.0/$NUMERO_RH?fields=display_phone_number,verified_name',{headers:{Authorization:'Bearer '+process.env.WHATSAPP_RECRUITMENT_ACCESS_TOKEN}}).then(r=>r.text()).then(console.log)"
    ;;

  ensayo)  carga | tee ~/rh-reclutamiento-ensayo-$SELLO.txt ;;
  aplicar) carga --aplicar | tee ~/rh-reclutamiento-aplicado-$SELLO.txt ;;

  archivos)
    pod=$(api); copiar "$pod"
    kubectl exec -n prod "$pod" -c api -- sh -c \
      'CARGA_URL="$DATABASE_URL_NEW" node /app/database/scripts/rh/carga-archivos-mega-talento.js --destino-prod --aplicar' \
      | tee ~/rh-archivos-$SELLO.txt
    ;;

  verificar)
    psql_prod -c "SELECT set_config('app.tenant_id', '$TENANT', false);" -c "
      SELECT 'candidatos' que, count(*) FROM talent.candidates
      UNION ALL SELECT 'conversaciones del bot', count(*) FROM talent.bot_conversations
      UNION ALL SELECT 'mensajes de reclutamiento', count(*) FROM whatsapp.messages WHERE flow = 'recruitment'
      UNION ALL SELECT 'mensajes de hoy (Suite)', count(*) FROM whatsapp.messages WHERE flow = 'recruitment' AND created_at::date = current_date AND payload->>'origen' IS DISTINCT FROM 'mega_talento'
      UNION ALL SELECT 'mensajes con archivo en el bucket', count(*) FROM whatsapp.messages WHERE flow = 'recruitment' AND payload ? 'storage_key';"
    ;;

  *) sed -n '2,17p' "$0"; exit 1 ;;
esac
