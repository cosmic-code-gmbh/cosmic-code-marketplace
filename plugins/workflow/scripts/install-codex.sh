#!/usr/bin/env bash
# Verlinkt die Workflow-Skills dieses Checkouts für alle Codex-Projekte.
set -euo pipefail

if [[ $# -gt 1 ]]; then
  echo "Nutzung: bash install-codex.sh [skills-verzeichnis]" >&2
  exit 1
fi

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
plugin_dir="$(cd "$script_dir/.." && pwd)"
skills_dir="${1:-$HOME/.agents/skills}"
case "$skills_dir" in
  /*) ;;
  *) skills_dir="$PWD/$skills_dir" ;;
esac
skills=(plan-review plan-verify plan-integrate-review plan-status)

# Erst alle Ziele prüfen, damit ein Namenskonflikt keine Teilinstallation erzeugt.
for skill in "${skills[@]}"; do
  source_dir="$plugin_dir/skills/$skill"
  target="$skills_dir/$skill"
  if [[ ! -f "$source_dir/SKILL.md" ]]; then
    echo "Skill fehlt: $source_dir/SKILL.md" >&2
    exit 1
  fi
  if [[ -e "$target" || -L "$target" ]]; then
    if [[ ! -L "$target" ]] || [[ "$(readlink "$target")" != "$source_dir" ]]; then
      echo "Konflikt: $target existiert bereits. Es wurde nichts verändert." >&2
      exit 1
    fi
  fi
done

mkdir -p "$skills_dir"
for skill in "${skills[@]}"; do
  target="$skills_dir/$skill"
  if [[ ! -L "$target" ]]; then
    ln -s "$plugin_dir/skills/$skill" "$target"
  fi
  echo "$skill -> $plugin_dir/skills/$skill"
done

echo "Workflow-Skills installiert. Falls sie noch nicht erscheinen, Codex neu starten."
