#!/usr/bin/env bash
# JARVIS Home-Base Installer (Ubuntu). Ausführen als root.
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=a
SRC="https://elmenchho.github.io/winterarc"
IP=$(curl -fsS4 https://api.ipify.org || hostname -I | awk '{print $1}')
HOST="${JARVIS_HOST:-${IP//./-}.sslip.io}"

echo ">> Pakete installieren (Node.js, Caddy) …"
apt-get update -qq
apt-get install -y -qq nodejs caddy curl >/dev/null
node -e 'const v=+process.versions.node.split(".")[0]; if(v<20){console.error("Node zu alt: "+process.version); process.exit(1)}'

echo ">> Benutzer & Ordner …"
id jarvis &>/dev/null || useradd --system --home /var/lib/jarvis --shell /usr/sbin/nologin jarvis
install -d -m 700 -o jarvis -g jarvis /var/lib/jarvis
install -d -m 750 -o root -g jarvis /etc/jarvis
install -d -m 755 /opt/jarvis
curl -fsSL "$SRC/jarvis-server.js" -o /opt/jarvis/jarvis-server.js
chmod 644 /opt/jarvis/jarvis-server.js

if [ ! -s /etc/jarvis/master.key ]; then
  head -c 32 /dev/urandom | base64 > /etc/jarvis/master.key
fi
chown root:jarvis /etc/jarvis/master.key; chmod 640 /etc/jarvis/master.key

if [ ! -s /etc/jarvis/anthropic.key ]; then
  echo
  echo ">> Jetzt deinen Claude-API-Schlüssel einfügen (sk-ant-…). Man sieht beim Tippen NICHTS – das ist Absicht."
  read -rsp "   Schlüssel: " K </dev/tty; echo
  case "$K" in sk-ant-*) ;; *) echo "   Das sieht nicht wie ein Claude-Schlüssel aus. Abbruch."; exit 1;; esac
  printf '%s' "$K" > /etc/jarvis/anthropic.key; unset K
fi
chown root:jarvis /etc/jarvis/anthropic.key; chmod 640 /etc/jarvis/anthropic.key

echo ">> Dienst einrichten …"
cat > /etc/systemd/system/jarvis.service <<'UNIT'
[Unit]
Description=JARVIS Home-Base
After=network-online.target
Wants=network-online.target
[Service]
User=jarvis
Group=jarvis
ExecStart=/usr/bin/node /opt/jarvis/jarvis-server.js
Restart=always
RestartSec=3
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
PrivateDevices=true
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
RestrictSUIDSGID=true
LockPersonality=true
MemoryDenyWriteExecute=false
ReadWritePaths=/var/lib/jarvis
ReadOnlyPaths=/etc/jarvis /opt/jarvis
CapabilityBoundingSet=
[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable --now jarvis
systemctl restart jarvis

echo ">> HTTPS (Caddy) für $HOST …"
cat > /etc/caddy/Caddyfile <<CADDY
$HOST {
	encode gzip
	header {
		Strict-Transport-Security "max-age=31536000"
		X-Content-Type-Options nosniff
		Referrer-Policy no-referrer
		-Server
	}
	handle /api/* {
		reverse_proxy 127.0.0.1:8787
	}
	handle {
		respond "JARVIS" 200
	}
}
CADDY
ufw allow 80/tcp >/dev/null; ufw allow 443/tcp >/dev/null
systemctl enable --now caddy; systemctl reload caddy || systemctl restart caddy

sleep 3
echo ">> Test …"
for i in 1 2 3 4 5 6 7 8 9 10; do
  if curl -fsS "https://$HOST/api/health" >/dev/null 2>&1; then OK=1; break; fi; sleep 3
done
echo
if [ "${OK:-}" = 1 ]; then echo "   ✅ JARVIS ist online:  https://$HOST"; else echo "   ⚠️  HTTPS noch nicht bereit – in 1 Min nochmal: curl https://$HOST/api/health"; fi
sudo -u jarvis node /opt/jarvis/jarvis-server.js pair
echo "   Server-Adresse für die App:  https://$HOST"
echo "   JARVIS-INSTALL FERTIG"
