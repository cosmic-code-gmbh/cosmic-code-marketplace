---
name: sol-plan
description: Use when the user says "sol loop plan" or "sol loop verify" (plan ping-pong with GPT Sol as reviewer).
---

# sol-plan

Der Plan-Workflow (Plan → Review → Einarbeiten → Verify) als Schleife mit GPT Sol
als Reviewer. Sol prüft, Claude arbeitet ein bzw. schließt Lücken, bis beide sich
einig sind oder das Budget endet. Ersetzt das manuelle Hin und Her mit Codex.

- **sol loop plan `<plan.md>`**: Sol macht `plan-review`, Claude macht
  `plan-integrate-review`. Kein Anwendungscode, nur die Plandatei.
- **sol loop verify `<plan.md>`**: Sol macht `plan-verify`, Claude schließt die
  Lücken im Code und lässt erneut prüfen.

Ohne Pfad: den Plan aus dem Kontext nehmen (Fokusboard, zuletzt bearbeiteter Plan
in `.claude/plans/`). Bei Zweifel fragen.

## Sol aufrufen

Über `scripts/sol` dieses Plugins (zwei Ebenen über dem Basisverzeichnis dieses
Skills), wie im `sol-loop`-Skill unter „Claude Code route“: `<plugin>/scripts/sol -C <repo>`,
Brief über stdin, Bash mit `run_in_background: true`, auf die Meldung warten, nicht
pollen. Ab Runde 2 `--resume <SOL_THREAD>`. Sol ist read-only und schreibt keine
Dateien. Kein Sol erreichbar: melden, kein Ersatzmodell.

Prüfregeln sind die SKILL.md-Dateien des `workflow`-Plugins aus demselben
Marketplace. Pfad auflösen mit
`ls -d ~/.claude/plugins/cache/cosmic-code-marketplace/workflow/*/skills/<skill>/SKILL.md | sort -V | tail -1`
und Sol den absoluten Pfad geben. Fehlt das Plugin: melden und abbrechen.

## Budget

- 3 Runden. Bis 5 nur, wenn ein `[kritisch]` (Plan) bzw. ❌/⚠️ an einer zentralen
  Anforderung (Verify) mit Beleg offen bleibt, oder auf Wunsch.
- Früh stoppen, wenn nur `[optional]` übrig ist.
- Ledger führen: Runde, Befund, Schweregrad, Entscheidung, `SOL_USAGE`.
- Der Schlusslauf (siehe unten) zählt nicht zum Budget.

## Schlusslauf

Ab Runde 2 prüft Sol nur noch Delta und offene Befunde. Was Runde 1 übersehen hat
oder was eine spätere Korrektur neu kaputt macht, bleibt so unsichtbar. Deshalb
gilt ein Ergebnis erst nach einem **Schlusslauf** als fertig:

```
Runde 1     komplett          ──► Befunde
Runde 2+    Delta (resume)    ──► bis APPROVE / vollständig
Schlusslauf komplett, OHNE --resume (neuer Thread, keine Vorurteile)
            ├─ nichts Neues   ──► fertig
            └─ neue Befunde   ──► Delta-Runden, danach erneut Schlusslauf
```

- Gleicher Brief wie Runde 1, plus: „Schlussprüfung: alles prüfen, nicht nur
  Änderungen. Frühere Runden kennst du nicht.“
- Nur wenn Runde 1 schon das Endergebnis war (APPROVE bzw. `vollständig` ohne
  Änderung dazwischen), entfällt er.
- Höchstens zwei Schlussläufe; findet auch der zweite Neues, Stand an Marcus
  melden statt weiterzuschleifen.

## sol loop plan

**Runde 1, Brief an Sol:**

```
Nur prüfen. Keine Dateien ändern, nichts committen, keine Subagenten.
Repo: <abs path>  Plan: <abs path>  Plan Version: #M
Lies die Prüfregeln in <abs path plan-review/SKILL.md> und wende sie an.
Schreibe die Review-Datei NICHT. Gib den vollständigen Review-Inhalt
(Abschnitte 1–5, ohne die Zeile "Review Version #N") als Antwort zurück.
Halte den Plan klein: unnötigen Umfang als Befund markieren, nicht ergänzen.
Letzte Zeile: VERDICT: APPROVE (kein [kritisch]/[wichtig] offen) oder CHANGES.
```

**Dann Claude:**

1. Sols Antwort nach `<name>.review.md` schreiben, mit Kopfzeile
   `Review Version #N` (Nummerierung wie in `plan-review`) und darunter
   `Geprüft gegen Plan Version #M · GPT Sol (sol-plan, Runde R)`.
2. `plan-integrate-review` für den Plan ausführen (Skill laden und befolgen).
   Befunde selbst am Code prüfen; Sol ist ein Vorschlag, keine Vorgabe.
   Nicht zustimmen, nur um die Schleife zu beenden.
3. Punkte, die eine Entscheidung von Marcus brauchen (`Offen:`), beenden die
   Schleife: mit `AskUserQuestion` fragen, die Frage ins Fokusboard, danach weiter.

**Ab Runde 2 (resume):** Neue Plan-Version, Changelog der Einarbeitung
(`Geändert` / `Bewusst abgelehnt` + Begründung). Sol soll nur Änderungen und
offene Befunde prüfen und je alten Befund `erledigt` oder `weiter offen: <Grund>`
sagen. Gleiche Antwortform.

**Fertig:** APPROVE im Schlusslauf auf die aktuelle Plan-Version und nichts `Offen:`. Dann ist
der Plan umsetzungsbereit. **Nicht mit der Umsetzung beginnen**, das braucht
Marcus' Go.

## sol loop verify

Voraussetzung: Umsetzung liegt im Arbeitsbaum.

**Vor jeder Runde** die Prüfungen selbst laufen lassen, die der Plan und das
Projekt verlangen (tsc, vitest, ggf. Browser-Verify); Sol kann im Read-only-Modus
nicht zuverlässig testen. Ergebnisse in den Brief.

**Brief an Sol:**

```
Nur prüfen. Keine Dateien ändern, nichts committen, keine Subagenten.
Repo: <abs path>  Plan: <abs path>  Plan Version: #M
Änderungssatz: <git diff-Befehl auf die Pfade dieses Plans>; parallele Arbeit anderer Sessions ignorieren.
Prüfungen (von Claude ausgeführt): <Befehl → Ergebnis>
Lies die Prüfregeln in <abs path plan-verify/SKILL.md> und wende sie an.
Schreibe die Verify-Datei NICHT. Gib den vollständigen Bericht (inkl. letzter
Zeile "Verifikation gegen Plan Version #M — Ergebnis: …") als Antwort zurück.
```

**Dann Claude:**

1. Sols Bericht nach `<name>.verify.md` schreiben (ersetzen).
2. ❌/⚠️/❔ selbst prüfen und nur im Rahmen des Plans schließen: kleinste
   Änderung, Wurzel statt Pflaster. Scope Creep, den Sol meldet, prüfen; eigenen
   zurücknehmen, fremde Änderungen nie anfassen. Danach Prüfungen erneut laufen.
3. Abweichung vom Plan, die eine Entscheidung braucht: fragen wie oben, nicht
   eigenmächtig den Plan umschreiben.

**Ab Runde 2 (resume):** was geschlossen wurde, neue Prüfergebnisse, nur offene
Punkte und geänderter Code.

**Fertig:** Ergebnis `vollständig` im Schlusslauf. Nicht committen, nicht deployen.

## Bericht

Runden (Schlusslauf getrennt ausweisen), Modell, Plan-Version vorher → nachher, was Sol geändert hat
(eingearbeitet / abgelehnt mit Grund / offen), bei verify geschlossene Lücken und
Prüfergebnisse, `SOL_USAGE` je Runde (sonst „nicht gemeldet“), Endstand:
Plan: `Plan Version #M — Review #N eingearbeitet`; Verify: letzte Zeile der `.verify.md`.
