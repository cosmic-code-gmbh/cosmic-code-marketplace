---
name: plan-status
description: Show implementation plan versions, latest reviews, and review integration status without changing files. Use for an overview of the plans in a project.
---

# Stand aller Pläne

Gib mir einen Überblick über **alle** parallelen Pläne. **Kein Code, keine Änderungen** — nur lesen
und als Tabelle ausgeben.

## Eingabe
Nutze das vom Benutzer angegebene Planverzeichnis, falls vorhanden (in Claude Code:
`$ARGUMENTS`). Andernfalls verwende das konfigurierte `plansDirectory` aus den Projekt-Settings
`.claude/settings.json`, mit `.claude/plans` als Standard. Löse relative Pfade im aktuellen
Projekt auf.

## Vorgehen
1. Liste alle Plandateien direkt im gewählten Verzeichnis: alle `*.md`, **aber ohne** die abgeleiteten Dateien
   `*.review.md` und `*.verify.md`. Jede verbleibende `<name>.md` ist eine Arbeitseinheit.
   Falls das Verzeichnis fehlt oder leer ist: sag das und beende.
2. Lies je Plan (für aktuelle Plan- und Einarbeitungsangaben vorrangig die letzte Versionszeile
   am Dateiende, andernfalls den aktuellen Plan-Header; historische Changelog-Einträge ignorieren):
   - Die aktuelle **Plan Version** (z. B. `Plan Version #3`; ohne Versionsangabe: `—`).
   - Die zuletzt vollständig **eingearbeitete Review-Nr** (aus
     `Plan Version #M — Review #N eingearbeitet`; ohne diesen Vermerk: keine eingearbeitet).
   - Aus der zugehörigen `<name>.review.md` die zuletzt vergebene **Review Version #N**
     (höchste/letzte im Header). Existiert keine `.review.md`: kein Review.
3. Ermittle je Plan den **Status**:
   - `—` wenn noch **kein** Review existiert.
   - ✅ **aktuelles Review eingearbeitet** wenn die im Plan-Header vermerkte Review-Nr
     **gleich** der letzten Review-Nr der `.review.md` ist.
   - ⚠️ **Review offen** sonst (Review existiert, aber neuer als das, was eingearbeitet wurde —
     oder noch gar nicht eingearbeitet).
     Auch `Review #N teilweise eingearbeitet` gilt als offen.

## Ausgabe (genau diese Tabelle)

| Planname | Plan-Version | letztes Review | Status |
| --- | --- | --- | --- |
| <name> | #M | #N (oder —) | ✅ / ⚠️ / — |

Eine Zeile pro Plan, alphabetisch nach Planname sortiert. Darunter optional ein Einzeiler-Hinweis,
wenn ein Plan ein offenes Review hat (z. B. „foo: Review-Einarbeitung ausstehend“).
