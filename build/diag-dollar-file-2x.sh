#!/usr/bin/env bash
X=hello
echo "X=$X"
for f in /etc/hostname /etc/hosts; do b=$(basename "$f"); echo "B=$b"; done
