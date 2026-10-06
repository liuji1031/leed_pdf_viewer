#!/bin/sh
# Publishes MDNS_NAME on the LAN through the host's Avahi daemon, pointing at
# the address the host reaches the LAN on, and republishes when that changes
# (DHCP renewal, switching between Wi-Fi and Ethernet).
set -u

name="${MDNS_NAME:-leed-pdf-viewer.local}"
interval="${MDNS_RECHECK_SECONDS:-30}"
pid=""

lan_address() {
	ip -4 route get 1.1.1.1 2>/dev/null | awk '{ for (i = 1; i < NF; i++) if ($i == "src") { print $(i + 1); exit } }'
}

stop() {
	[ -n "$pid" ] && kill "$pid" 2>/dev/null
	exit 0
}
trap stop INT TERM

current=""
while :; do
	address="$(lan_address)"
	if [ "$address" != "$current" ] || { [ -n "$pid" ] && ! kill -0 "$pid" 2>/dev/null; }; then
		[ -n "$pid" ] && kill "$pid" 2>/dev/null && wait "$pid" 2>/dev/null
		pid=""
		current="$address"
		if [ -n "$address" ]; then
			echo "publishing $name -> $address"
			# -R: the address already has a reverse record (the host's own name).
			avahi-publish -a -R "$name" "$address" &
			pid=$!
		else
			echo "no LAN address yet; retrying in ${interval}s"
		fi
	fi
	sleep "$interval" &
	wait $!
done
