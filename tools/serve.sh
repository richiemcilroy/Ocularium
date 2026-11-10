#!/bin/zsh
# tools/serve.sh '<command>' : runs a command with the dev server up on port 5199 for just as long as it takes.
cd "$(dirname "$0")/.."
if curl -s -o /dev/null http://127.0.0.1:5199/; then eval "$1"; exit; fi
npx vite --port 5199 --strictPort --host 127.0.0.1 > /tmp/ocularium-vite.log 2>&1 &
server=$!
trap "kill $server 2>/dev/null" EXIT
for n in {1..60}; do curl -s -o /dev/null http://127.0.0.1:5199/ && break; sleep 0.25; done
eval "$1"
