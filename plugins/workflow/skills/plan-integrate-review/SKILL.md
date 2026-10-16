---
name: plan-integrate-review
description: Incorporate a plan review into its implementation plan without changing application code. Use to accept or reject each finding and update the plan and version.
---

# Review in den Plan einarbeiten

Du arbeitest das Review zu **einem** Plan ein. **Schreibe KEINEN Anwendungscode** und
ändere KEINE Quelldateien des Projekts — du bearbeitest ausschließlich die Plandatei.

## Eingabe
- Plan-Pfad: vom Benutzer übergeben, relativ zum aktuellen Projekt oder absolut. In Claude Code
  steht er in `$ARGUMENTS`; im Folgenden bezeichnet `$ARGUMENTS` diesen Pfad.
  Falls kein Pfad angegeben wurde, frage danach.
- Zugehöriges Review: dieselbe Datei mit Basisname + `.review.md`.
  Beispiel: `$ARGUMENTS` = `.claude/plans/foo.md` → Review = `.claude/plans/foo.review.md`.

## Vorgehen
1. Lies den Plan unter `$ARGUMENTS` vollständig. Falls die Datei fehlt: melde das und brich ab.
2. Lies die zugehörige `<name>.review.md`. Falls sie fehlt: melde das und brich ab
   (ohne Review gibt es nichts einzuarbeiten).
3. Lies aus dem Review-Header die **Review Version #N**. Diese Zahl wird unverändert übernommen.
4. Lies aus dem bisherigen Plan-Header die bestehende **Plan Version #M** (falls keiner existiert: #M = 0,
   d. h. das Ergebnis wird #1).
5. Gehe **jeden** Review-Punkt einzeln durch. Entscheide für jeden Punkt **bewusst**:
   - **einarbeiten** — den Plan entsprechend anpassen, oder
   - **begründet ablehnen** — mit kurzer, sachlicher Begründung.
   Leitlinien bei jeder Entscheidung:
   - **Funktionale Korrektheit** (vereinbartes Verhalten, relevante Fehlerfälle und Datenflüsse).
   - **Saubere Architektur** (Separation of Concerns, Kopplungsrichtung, Konsistenz mit bestehenden Mustern).
   - **Minimaler Eingriff** (kleinstmögliche Lösung, keine unnötigen Änderungen).
   - **Wiederverwendung**, wenn sie fachlich passt und die Lösung vereinfacht.
   - **Wartbarkeit** (Verständlichkeit, Testbarkeit, technische Schuld).
6. Schreibe den **vollständigen, aktualisierten Plan** zurück in **dieselbe** Datei `$ARGUMENTS`
   (kein zweites Dokument, keine Teil-Patches — die Datei enthält danach den kompletten neuen Plan).

## Pflicht-Struktur der zurückgeschriebenen Plandatei
1. **Ganz oben** ein kurzer **Changelog** dieser Einarbeitung:
   - `Geändert:` — was aufgrund des Reviews angepasst wurde (knappe Punkte).
   - `Bewusst abgelehnt:` — welche Review-Punkte nicht übernommen wurden **+ Grund**.
2. Danach der vollständige, überarbeitete Plaintext des Plans.
3. **Ganz unten** als letzte Zeile der Header:

   ```
   Plan Version #M — Review #N eingearbeitet
   ```

   - `#N` exakt aus der `.review.md` übernehmen.
   - `#M` = bisherige Plan-Version + 1 (ohne vorhandenen Header: `#1`).

## Abschlussmeldung an mich
Gib in der Antwort knapp aus: neue Plan-Version, eingearbeitete Review-Nr, sowie wie viele Punkte
eingearbeitet und wie viele begründet abgelehnt wurden.
