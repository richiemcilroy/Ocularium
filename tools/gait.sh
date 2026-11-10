#!/bin/zsh
# tools/gait.sh <name> "<keys js array>" [query] : the wearer from the side at four moments of a stride.
cd "$(dirname "$0")/.."
name=$1; keys=$2; query=${3:-"third=2.6,0.9,-0.3&thirdy=0.85&lens=0&cfov=42"}
js() { echo "(async () => { const g = window.__game; $keys.forEach(k => g.input.keys.add(k)); await new Promise(r => setTimeout(r, $1)); window.__freeze = true; return g.body.figure.sink.toFixed(3) + ' ' + g.player.speed.toFixed(2); })()"; }
for pair in "0 1" "2 3"; do
  for i in ${=pair}; do
    node tools/shot.mjs _g$i "auto=1&$query" --wait 1500 --size 480x560 --eval "$(js $((2600 + i * 110)))" --settle 60 | grep "^eval" &
  done
  wait
done
ffmpeg -loglevel error -y -i tools/out/_g0.png -i tools/out/_g1.png -i tools/out/_g2.png -i tools/out/_g3.png -filter_complex "[0][1][2][3]hstack=inputs=4" tools/out/$name.png
