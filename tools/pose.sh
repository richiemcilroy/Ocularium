#!/bin/zsh
# tools/pose.sh <name> "<query>" '<js run before the shots>' : chest view plus two outside views of the wearer, side by side.
cd "$(dirname "$0")/.."
name=$1; query=$2; js=${3:-0}
node tools/shot.mjs _p0 "auto=1&$query" --wait 1500 --size 960x540 --eval "$js" --settle 900 | grep -v "^stats" &
node tools/shot.mjs _p1 "auto=1&third=1.6,1.5,-2.2&$query" --wait 1500 --size 540x540 --eval "$js" --settle 900 | grep -v "^stats" &
node tools/shot.mjs _p2 "auto=1&third=-2.4,1.3,-0.3&$query" --wait 1500 --size 540x540 --eval "$js" --settle 900 | grep -v "^stats" &
wait
ffmpeg -loglevel error -y -i tools/out/_p0.png -i tools/out/_p1.png -i tools/out/_p2.png -filter_complex "[0][1][2]hstack=inputs=3" tools/out/$name.png
