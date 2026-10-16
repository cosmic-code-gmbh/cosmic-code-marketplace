# Workflow

Vier gemeinsame Skills für Claude Code und Codex. Die Anweisungen liegen direkt in
`skills/*/SKILL.md`; dieses Plugin ist die einzige gepflegte Quelle.

| Schritt | Ergebnis |
| --- | --- |
| `plan-review` | Prüft einen Plan gegen den tatsächlichen Code und schreibt eine benachbarte `.review.md`. |
| `plan-integrate-review` | Prüft Review-Befunde, arbeitet sie ein, lehnt sie begründet ab oder dokumentiert offene Entscheidungen. |
| `plan-verify` | Prüft die Implementierung gegen den Plan und schreibt eine benachbarte `.verify.md`. |
| `plan-status` | Zeigt Plan-Version, letztes Review und Einarbeitungsstatus als Tabelle. |

Review und Verifikation ändern weder den Plan noch Anwendungscode. Die Einarbeitung
ändert ausschließlich den Plan; die Implementierung erfolgt als eigener Auftrag.

## Claude Code: einmal pro Rechner

In Claude Code:

```text
/plugin marketplace add cosmic-code-gmbh/cosmic-code-marketplace
/plugin install workflow@cosmic-code-marketplace --scope user
```

Ist der Marketplace bereits hinzugefügt, reicht vor der Installation
`/plugin marketplace update cosmic-code-marketplace`. Die Installation im
User-Scope gilt für alle Projekte auf diesem Rechner. Claude Code bei Bedarf neu starten.

```text
/workflow:plan-review .claude/plans/beispiel.md
/workflow:plan-integrate-review .claude/plans/beispiel.md
/workflow:plan-verify .claude/plans/beispiel.md
/workflow:plan-status
```

## Codex: einmal pro Rechner

Das Repository an einen dauerhaften Ort klonen (bei einem vorhandenen Checkout diesen verwenden):

```sh
git clone https://github.com/cosmic-code-gmbh/cosmic-code-marketplace.git ~/cosmic-code-marketplace
bash ~/cosmic-code-marketplace/plugins/workflow/scripts/install-codex.sh
```

Der Installer verlinkt die vier Skills nach `~/.agents/skills/`, wo Codex sie
projektübergreifend findet. Er ist wiederholt ausführbar und überschreibt keine
vorhandenen anderen Skills. Ein abweichendes Ziel kann als einziges Argument übergeben werden.
Den Checkout beibehalten: Die Links zeigen auf seine Dateien.

In Codex:

```text
$plan-review .claude/plans/beispiel.md
$plan-integrate-review .claude/plans/beispiel.md
$plan-verify .claude/plans/beispiel.md
$plan-status
```

Falls die Skills noch nicht erscheinen, Codex neu starten.

## Ablauf und Planablage

1. Einen Implementierungsplan als Markdown im jeweiligen Projekt erstellen.
2. `plan-review` ausführen und die Befunde mit `plan-integrate-review` einarbeiten.
   Bei Bedarf wiederholen.
3. Den überarbeiteten Plan mit einem eigenen Auftrag implementieren.
4. `plan-verify` ausführen, Lücken beheben und erforderliche Prüfungen wiederholen.
5. `plan-status` zeigt jederzeit den Stand der Review-Einarbeitung.

Bei den ersten drei Skills den Planpfad explizit angeben; relative und absolute
Pfade sind möglich. Berichte liegen neben dem Plan. `plan-status` akzeptiert ein
Planverzeichnis; ohne Argument nutzt er `plansDirectory` aus den Projekt-Settings
`.claude/settings.json` oder standardmäßig `.claude/plans`. Er liest nur direkt
dort liegende Pläne und ignoriert `.review.md` sowie `.verify.md`.

Für Claude Code kann jedes Projekt diese optionale Einstellung verwenden:

```json
{
  "plansDirectory": ".claude/plans"
}
```

Die Skills ändern keine Projekt-Settings. Bestehende Pläne, Reviews und Berichte
bleiben im jeweiligen Projekt. Empfohlene Header:

| Datei | Header |
| --- | --- |
| Plan | `Plan Version #M` |
| Review | `Review Version #N` |
| Plan nach Einarbeitung | `Plan Version #M — Review #N eingearbeitet` |
| Plan bei offenen Review-Punkten | `Plan Version #M — Review #N teilweise eingearbeitet` |
| Verifikation | `Verifikation gegen Plan Version #M — Ergebnis: vollständig / Lücken / unvollständig` |

Wiederholte Einarbeitung desselben bereits verarbeiteten Reviews ohne neuen Änderungsbedarf
lässt Plan und Version unverändert. Teilweise eingearbeitete Reviews bleiben in `plan-status` offen.

Projektlokale Skills oder Commands mit denselben Namen bei der Umstellung entfernen,
nachdem die globale Installation funktioniert. So bleiben keine veralteten Kopien aktiv.

## Auf jedem Rechner aktualisieren

Claude Code:

```text
/plugin marketplace update cosmic-code-marketplace
/plugin update workflow@cosmic-code-marketplace
```

Codex (Pfad an den eigenen Checkout anpassen):

```sh
git -C ~/cosmic-code-marketplace pull --ff-only
bash ~/cosmic-code-marketplace/plugins/workflow/scripts/install-codex.sh
```

Danach bei Bedarf eine neue Sitzung starten. Änderungen müssen im Marketplace-Repo
committet und gepusht sein, bevor andere Rechner sie abrufen können. Bei neuen
Plugin-Versionen die Versionsnummer in `.claude-plugin/plugin.json` dieses Plugins
und im Eintrag der Marketplace-Datei `.claude-plugin/marketplace.json` gemeinsam erhöhen.

## Quellen

- [Claude Code: Skills und Plugin-Namensräume](https://code.claude.com/docs/en/skills)
- [Claude Code: Plugin-Installation und Scopes](https://code.claude.com/docs/en/plugins)
- [Codex: globale Skills und Symlinks](https://learn.chatgpt.com/docs/build-skills)
