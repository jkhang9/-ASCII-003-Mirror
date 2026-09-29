#!/bin/sh
# Stamp a new cache-busting version on the stylesheet, the entry script and
# every module import, so browsers fetch fresh files after a change.
# Every import of a module must carry the same version, or the browser loads
# it twice. Run from the repo root: sh tools/bump-version.sh
set -e
v=$(date +%Y%m%d%H%M%S)
sed -i.bak -E "s#(styles\.css|js/main\.js)(\?v=[0-9]+)?\"#\1?v=$v\"#g" index.html
for f in js/*.js; do
  sed -i.bak -E "s#from '(\./[a-z]+\.js)(\?v=[0-9]+)?'#from '\1?v=$v'#g" "$f"
done
rm -f index.html.bak js/*.js.bak
echo "version $v"
