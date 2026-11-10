#!/bin/zsh
# Renders the hand-study contact sheet: rows = views (top, thumb side, fingertips), columns = poses.
# usage: tools/handstudy.sh <sheetname> "<extra query>" pose:curl:thumb ...
cd "$(dirname "$0")/.."
name=$1; extra=$2; shift 2
views=("0.22,1.62,-0.499:0.22,1.15,-0.5" "0.70,1.22,-0.52:0.22,1.16,-0.5" "0.30,1.30,-0.98:0.22,1.16,-0.5")
rows=()
vi=0
for view in $views; do
  pos=${view%%:*}; look=${view##*:}
  cols=()
  ci=0
  for spec in "$@"; do
    p=${spec%%:*}; rest=${spec#*:}; c=${rest%%:*}; t=${rest##*:}
    f="_hs_${vi}_${ci}"
    node tools/shot.mjs $f "mode=rig&model=_rigtest&tint=1&lens=0&cfov=24&pose=$p&curl=$c&thumb=$t&pos=$pos&look=$look$extra" --wait 1500 --size 560x560 > /tmp/hs_$f.log 2>&1 &
    cols+=("tools/out/$f.png")
    ci=$((ci+1))
  done
  wait
  args=(); for c in $cols; do args+=(-i $c); done
  ffmpeg -y -loglevel error $args -filter_complex "hstack=inputs=${#cols}" tools/out/_hs_row$vi.png
  rows+=(-i tools/out/_hs_row$vi.png)
  vi=$((vi+1))
done
ffmpeg -y -loglevel error $rows -filter_complex "vstack=inputs=3" tools/out/$name.png
rm -f tools/out/_hs_*.png
grep -h "console\|error" /tmp/hs__hs_*.log | sort -u | head -5
echo "sheet $name ok"
