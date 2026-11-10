#!/bin/zsh
# tools/hand.sh <name> <bone> "<query>" '<js run before the shots>' : four close views round one joint of the wearer, in a row.
cd "$(dirname "$0")/.."
name=$1; bone=$2; query=$3; js=${4:-0}
i=0
for off in "0.05,0.12,-0.45" "0.42,0.1,-0.1" "0.1,0.42,0.12" "-0.4,0.05,0.05"; do
  node tools/shot.mjs _h$i "auto=1&lens=0&cfov=40&third=$off&thirdat=$bone&$query" --wait 1500 --size 540x540 --eval "$js" --settle 900 | grep -v "^stats\|404\|console" &
  i=$((i+1))
done
wait
ffmpeg -loglevel error -y -i tools/out/_h0.png -i tools/out/_h1.png -i tools/out/_h2.png -i tools/out/_h3.png -filter_complex "[0][1][2][3]hstack=inputs=4" tools/out/$name.png
