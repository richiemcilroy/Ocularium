#!/bin/zsh
# tools/thumb.sh <name> "lift:roll[:extra query]" ... : the sword hand from the wearer's side and from the thumb side, one column per variant.
cd "$(dirname "$0")/.."
name=$1; shift
views=("0.05,1.42,-0.15" "-0.16,1.24,-0.5" "0.3,1.5,-0.62")
rows=()
vi=0
for pos in $views; do
  cols=(); ci=0
  for spec in "$@"; do
    l=${spec%%:*}; rest=${spec#*:}; r=${rest%%:*}; x=""; [[ $rest == *:* ]] && x="&${rest#*:}"
    f="_th_${vi}_${ci}"
    node tools/shot.mjs $f "mode=rig&pose=still&lens=0&cfov=26&lift=$l&roll=$r&radius=0.012&off=0.0265&pos=$pos&look=0.24,1.165,-0.37$x" --wait 1500 --size 520x520 > /tmp/$f.log 2>&1 &
    cols+=(-i tools/out/$f.png); ci=$((ci+1))
  done
  wait
  ffmpeg -y -loglevel error $cols -filter_complex "hstack=inputs=$ci" tools/out/_th_row$vi.png
  rows+=(-i tools/out/_th_row$vi.png); vi=$((vi+1))
done
ffmpeg -y -loglevel error $rows -filter_complex "vstack=inputs=$vi" tools/out/$name.png
rm -f tools/out/_th_*.png
