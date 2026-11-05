#!/bin/sh
# Installs the Herdr half of this plugin into the Herdr app home: the artifacts and tabs-run
# mods, the main-filetree layout, settings.json and keys.json. Anything that differs is moved
# to <app home>/backup-<time>/ first (outside mods/, so Herdr does not load it). Mods the layout needs from
# cybertron288/herdr-mods (filetree, file-icons, run-scripts, session-bar) are installed
# from that repo when missing.
#
#   ./install.sh
#
# HERDR_APP_HOME picks another app home (default ~/.config/herdr-app).
set -eu

here=$(cd "$(dirname "$0")" && pwd)
home_dir=${HERDR_APP_HOME:-"$HOME/.config/herdr-app"}
stamp=$(date +%Y%m%d-%H%M%S)

if [ ! -d "$home_dir" ]; then
  echo "No Herdr app home at $home_dir. Start the Herdr app once, then run this again." >&2
  exit 1
fi
herdr=$(command -v herdr-app || echo /Applications/Herdr.app/Contents/MacOS/Herdr)

# Moves <app home>/$1 into the backup folder when it exists and differs from $2.
# Herdr's generated editor files (gpui-kit.d.ts, jsconfig.json) do not count.
keep() {
  if [ -e "$home_dir/$1" ] && ! diff -rq -x gpui-kit.d.ts -x jsconfig.json "$home_dir/$1" "$2" >/dev/null 2>&1; then
    mkdir -p "$(dirname "$home_dir/backup-$stamp/$1")"
    mv "$home_dir/$1" "$home_dir/backup-$stamp/$1"
    echo "kept   $home_dir/backup-$stamp/$1"
  fi
}

mkdir -p "$home_dir/mods" "$home_dir/layouts"
for mod in "$here"/herdr/mods/*/; do
  name=$(basename "$mod")
  target="$home_dir/mods/$name"
  keep "mods/$name" "$mod"
  rm -rf "$target"
  cp -R "$mod" "$target"
  "$herdr" check "$target" >/dev/null 2>&1 && echo "added  $target" || echo "added  $target (check FAILED: $herdr check $target)"
done
for f in layouts/main-filetree.json settings.json keys.json; do
  keep "$f" "$here/herdr/$f"
  cp "$here/herdr/$f" "$home_dir/$f"
  echo "added  $home_dir/$f"
done

missing=""
for m in filetree file-icons run-scripts session-bar; do
  [ -d "$home_dir/mods/$m" ] || missing="$missing $m"
done
if [ -n "$missing" ]; then
  echo "need  $missing (from cybertron288/herdr-mods)"
  tmp=$(mktemp -d)
  git clone -q --depth 1 https://github.com/cybertron288/herdr-mods.git "$tmp/herdr-mods"
  HERDR_APP_HOME="$home_dir" sh "$tmp/herdr-mods/install.sh"
  rm -rf "$tmp"
fi

cat <<MSG

Done. In Herdr pick the layout "main-filetree" (cmd-shift-l).
The Artefakte dropdown fills live from Claude Code once this plugin is installed:
  claude plugin install herdr@cosmic-code-marketplace
For all older claude.ai artifacts, tell Claude "Artefakte aktualisieren".
MSG
