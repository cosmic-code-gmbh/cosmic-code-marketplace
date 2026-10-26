# Sol

GPT Sol als Reviewer direkt aus Claude Code, über die Codex-CLI und das
Codex-Abo. Claude schreibt, Sol prüft in Runden, bis beide sich einig sind.
Kein Proxy und kein API-Key nötig.

```
Claude Code ── "sol loop …" ──► scripts/sol ── codex exec (read-only) ──► GPT Sol
     ▲                                                                      │
     └────────────── Befunde, Runde für Runde im selben Codex-Thread ◄──────┘
```

| Sag | Skill | Was passiert |
| --- | --- | --- |
| „sol loop“ | `sol-loop` | Sol prüft eine Code-Änderung (Diff), Claude behebt oder widerspricht, max. 3 Runden. |
| „sol loop plan `<plan.md>`“ | `sol-plan` | Plan-Ping-Pong: Sol macht `plan-review`, Claude `plan-integrate-review`, bis der Plan steht. |
| „sol loop verify `<plan.md>`“ | `sol-plan` | Sol macht `plan-verify`, Claude schließt Lücken, bis das Ergebnis `vollständig` ist. |
| „council“ | `council` | Claude Opus und GPT Sol prüfen parallel (kein Gemini in Claude Code). |
| „full send“ / „full stop“ | `full-send`, `full-stop` | Ende-zu-Ende bis zum gemergten bzw. merge-fertigen PR. |
| „file a PR“, „babysit“, „take over“, „modernize“ | `file-pr`, `babysit-pr`, `takeover`, `modernize` | PR-Handwerk, von den Skills oben genutzt. |

Die Skills werden über ihre Auslösewörter geladen, nicht per Slash-Befehl.
Mehrere lassen sich kombinieren („take over, full stop“).

Sol ändert nie Dateien. Bei `sol-plan` schreibt Claude Sols Bericht in die
`.review.md` bzw. `.verify.md`, mit denselben Versionsköpfen wie das
`workflow`-Plugin, sodass `plan-status` weiter stimmt.

## Voraussetzungen

- **Codex-CLI**, angemeldet mit dem ChatGPT/Codex-Abo:
  ```sh
  npm i -g @openai/codex
  codex login
  ```
  Standardmodell in `~/.codex/config.toml`, z. B. `model = "gpt-6.1-sol"`.
  Das Skript nimmt dieses Modell mit Reasoning `high`.
- **`workflow`-Plugin** aus diesem Marketplace (für `sol-plan`, liefert die Prüfregeln).
- **`gh`**, angemeldet (für die PR-Skills), und `python3` (für `babysit-pr`).

## Installation: einmal pro Rechner

In Claude Code:

```text
/plugin marketplace add cosmic-code-gmbh/cosmic-code-marketplace
/plugin install workflow@cosmic-code-marketplace --scope user
/plugin install sol@cosmic-code-marketplace --scope user
```

Ist der Marketplace schon da, vorher `/plugin marketplace update cosmic-code-marketplace`.
User-Scope gilt für alle Projekte. Danach eine neue Sitzung starten.

Kurztest im Terminal (in einem Git-Repo):

```sh
echo "Reply with exactly: VERDICT: APPROVE" | \
  ~/.claude/plugins/cache/cosmic-code-marketplace/sol/*/scripts/sol --effort low
```

Erwartet: `SOL_THREAD=…`, `SOL_USAGE=…` und `VERDICT: APPROVE`.

## Aktualisieren

```text
/plugin marketplace update cosmic-code-marketplace
/plugin update sol@cosmic-code-marketplace
```

## Einstellungen

- Modell und Reasoning pro Aufruf: `--model`, `--effort`, oder dauerhaft über
  `SOL_MODEL` / `SOL_EFFORT` (z. B. in `~/.claude/settings.json` unter `env`).
- Eigene Vorlieben (Council-Mitglieder, Budget) gehören in die `CLAUDE.md`,
  nicht in die Skills.

## Herkunft

`sol-loop`, `council`, `full-send`, `full-stop`, `file-pr`, `babysit-pr`,
`takeover`, `modernize` und `leaving-pr-comments` stammen aus
[t3dotgg/tstack](https://github.com/t3dotgg/tstack) (MIT, siehe `LICENSE-tstack`),
Stand `7de017b`. Angepasst: der Weg zu Sol in Claude Code (`sol-loop`, `council`)
und die Beschreibung von `sol-loop`, damit „sol loop plan/verify“ bei `sol-plan`
landet. `sol-plan` und `scripts/sol` sind eigene Ergänzungen.
