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
pollen. Jede Runde ist ein neuer Thread (kein `--resume`): ein fortgesetzter Thread
schleppt den ganzen Verlauf mit und kostet pro Runde Millionen Tokens; der
Delta-Brief trägt stattdessen das Nötige als Text. Sol liest das Repo und schreibt
nur in sein eigenes Arbeitsverzeichnis, kann also Tests laufen lassen
(`vitest --configLoader runner`, `tsc --incremental false`). Kein Sol erreichbar:
melden, kein Ersatzmodell.

Prüfregeln sind die SKILL.md-Dateien des `workflow`-Plugins aus demselben
Marketplace. Pfad auflösen mit
`ls -d ~/.claude/plugins/cache/cosmic-code-marketplace/workflow/*/skills/<skill>/SKILL.md | sort -V | tail -1`
und Sol den absoluten Pfad geben. Fehlt das Plugin: melden und abbrechen.

## Budget

- 3 Runden. Bis 5 nur, wenn ein `[kritisch]` (Plan) bzw. ❌/⚠️ an einer zentralen
  Anforderung (Verify) mit Beleg offen bleibt, oder auf Wunsch.
- Früh stoppen, wenn nur `[optional]` übrig ist.
- Ledger führen: Runde, Schlusslauf N/2, Befund, Schweregrad, Entscheidung, `SOL_USAGE`.
- Schlussläufe (siehe unten) haben ein eigenes, hartes Budget: **2**. Danach
  entscheidet Marcus.

## Schlusslauf

Ab Runde 2 prüft Sol nur noch Delta und offene Befunde. Was Runde 1 übersehen hat
oder was eine spätere Korrektur neu kaputt macht, bleibt so unsichtbar. Deshalb
gilt ein Ergebnis erst nach einem **Schlusslauf** als fertig:

```
Runde 1          komplett               ──► Befunde
Runde 2+         Delta (knapper Brief)  ──► bis APPROVE / vollständig
Schlusslauf 1/2  komplett, voller Brief, ohne frühere Befunde (keine Vorurteile)
                 ├─ nichts Neues        ──► fertig
                 └─ neue Befunde        ──► Delta-Runden ──► Schlusslauf 2/2
Schlusslauf 2/2  ├─ nichts Neues        ──► fertig
                 └─ neue Befunde        ──► STOPP: einarbeiten, Stand an Marcus, kein weiterer Lauf
```

- Gleicher Brief wie Runde 1, plus: „Schlussprüfung N von 2: alles prüfen, nicht nur
  Änderungen. Frühere Runden kennst du nicht.“ Die Zahl steht im Brief, damit sie
  bei jedem Lauf im Kontext ist.
- Nur wenn Runde 1 schon das Endergebnis war (APPROVE bzw. `vollständig` ohne
  Änderung dazwischen), entfällt er.
- Ein dritter Schlusslauf braucht Marcus' ausdrückliches Ja.

## sol loop plan

**Runde 1, Brief an Sol:**

```
Nur prüfen. Keine Dateien ändern, nichts committen, keine Subagenten.
Repo: <abs path>  Plan: <abs path>  Plan Version: #M
Lies die Prüfregeln in <abs path plan-review/SKILL.md> und wende sie an.
Schreibe die Review-Datei NICHT. Gib den vollständigen Review-Inhalt
(Abschnitte 1–5, ohne die Zeile "Review Version #N") als Antwort zurück.
Halte den Plan klein: unnötigen Umfang als Befund markieren, nicht ergänzen.
Verifikationsanforderungen, die Zugangsdaten, echte Drittdienste oder großen
Mock-Aufwand brauchen, als [wichtig] markieren: sie werden vor der Umsetzung
entschieden, nicht erst im Verify.
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
4. Jede Verifikationsanforderung, die ohne Zugangsdaten oder ohne
   unverhältnismäßigen Mock-Aufwand nicht zu erbringen ist, bekommt im Plan einen
   Platz: umsetzbar machen, als `Zurückgestellt` mit Grund (dann zählt sie im
   Verify nicht als Lücke) oder als `Offen:` an Marcus. Sonst meldet jede
   Verify-Runde dieselbe Lücke.

**Ab Runde 2 (Delta):** neuer Thread, Brief wie Runde 1 ohne die Prüfregeln-Zeile,
dazu die Befundliste der letzten Runde als Text (aus `<name>.review.md`), die neue
Plan-Version und der Changelog der Einarbeitung (`Geändert` / `Bewusst abgelehnt` +
Begründung). Sol prüft nur Änderungen und diese Befunde und sagt je Befund
`erledigt` oder `weiter offen: <Grund>`. Gleiche Antwortform.

**Fertig:** APPROVE im Schlusslauf auf die aktuelle Plan-Version und nichts `Offen:`. Dann ist
der Plan umsetzungsbereit. **Nicht mit der Umsetzung beginnen**, das braucht
Marcus' Go.

## sol loop verify

Voraussetzung: Umsetzung liegt im Arbeitsbaum.

**Vor Runde 1: Selbstprüfung.** Grüne Gates heißen nicht planvollständig. Claude
lädt `plan-verify` und wendet es selbst an: jeden Planpunkt und jeden Fall der
Testliste des Plans mit Datei:Zeile abhaken, auch Teile, die Subagenten gebaut
haben (deren Bericht ersetzt den Abgleich nicht). Lücken schließen. Sol startet
erst, wenn die eigene Tabelle kein ❌ mehr hat; offene ⚠️ mit Grund in den Brief.

**Vor jeder Runde** die Prüfungen selbst laufen lassen, die der Plan und das
Projekt verlangen (tsc, vitest, ggf. Browser-Verify), und die Ergebnisse in den
Brief schreiben. Sol kann gezielt nachtesten; Browser und Dienste mit
Zugangsdaten bleiben bei Claude.

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

**Ab Runde 2 (Delta):** neuer Thread, Brief wie oben ohne die Prüfregeln-Zeile,
dazu die nicht-✅-Zeilen der letzten Prüftabelle als Text (aus `<name>.verify.md`),
was geschlossen wurde, neue Prüfergebnisse und der Änderungssatz seit der letzten
Runde.

**Fertig:** Ergebnis `vollständig` im Schlusslauf. Nicht committen, nicht deployen.

## Bericht

Runden (Schlusslauf getrennt ausweisen), Modell, Plan-Version vorher → nachher, was Sol geändert hat
(eingearbeitet / abgelehnt mit Grund / offen), bei verify geschlossene Lücken und
Prüfergebnisse, `SOL_USAGE` je Runde (sonst „nicht gemeldet“), Endstand:
Plan: `Plan Version #M — Review #N eingearbeitet`; Verify: letzte Zeile der `.verify.md`.
