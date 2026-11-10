#!/bin/zsh
# tools/act.sh <name> <key> "<t0 t1 t2 t3 in ms>" [query] [size] : what the camera sees at four moments after a key is pressed.
cd "$(dirname "$0")/.."
name=$1; key=$2; times=(${=3}); query=${4:-""}; size=${5:-800x450}
js() { echo "(async () => { const g = window.__game; g.input.inject({ keysDown: ['$key'] }); await new Promise(r => setTimeout(r, $1)); window.__freeze = true; return g.arms.phase + ' ' + g.arms.t.toFixed(2); })()"; }
for pair in "1 2" "3 4"; do
  for i in ${=pair}; do
    node tools/shot.mjs _a$i "auto=1&$query" --wait 1800 --size $size --eval "$(js $times[$i])" --settle 60 | grep "^eval" &
  done
  wait
done
ffmpeg -loglevel error -y -i tools/out/_a1.png -i tools/out/_a2.png -i tools/out/_a3.png -i tools/out/_a4.png -filter_complex "[0][1]hstack[t];[2][3]hstack[b];[t][b]vstack" tools/out/$name.png
