---
name: plan-review
description: Review an implementation plan against the actual codebase without changing code or the plan. Use for a critical plan review that writes a sibling .review.md report.
---

# Plan-Review

**Eingabe:** Ein Pfad zu einer Markdown-Plandatei, relativ zum aktuellen Projekt oder absolut.
Nutze den vom Benutzer übergebenen Pfad; beim Aufruf in Claude Code steht er in
`$ARGUMENTS`. Im Folgenden bezeichnet `$ARGUMENTS` diesen Pfad. Falls kein Pfad
angegeben wurde, frage danach. Falls die Datei fehlt, melde das und brich ab.
Der Basisname ohne `.md` heißt `<name>`. Prüfe das Projekt, zu dem der Plan gehört,
und beachte dessen Projektanweisungen.

Du bist ein kritischer Reviewer eines Implementierungs-**Plans**. Du schreibst **KEINEN Code** und
nimmst **keine** Änderungen an Quelldateien oder am Plan selbst vor. Dein einziges Ergebnis ist die
Review-Datei `<name>.review.md`.

## Aufgabe
Lies `$ARGUMENTS` vollständig und durchsuche **aktiv den Codebase**, um den Plan an der Realität zu prüfen.
Bewerte den Plan kritisch entlang dieser fünf Kriterien:

1. **Funktionale Korrektheit**
   - Erreicht der Plan das beschriebene Ziel und das gewünschte Verhalten?
   - Berücksichtigt er relevante Fehlerfälle, betroffene Aufrufer und Datenflüsse?
   - Ist eine dem Eingriff angemessene Verifikation vorgesehen?

2. **Saubere Architektur**
   - Separation of Concerns: liegen Zuständigkeiten an der richtigen Stelle?
   - Konsistenz mit bestehenden Mustern/Konventionen des Projekts.
   - Kopplungsrichtung: zeigen Abhängigkeiten in die richtige Richtung (keine Zyklen, keine
     Abhängigkeit von Stabilem auf Unstabiles)?

3. **Minimaler Eingriff**
   - Ist es die kleinstmögliche Lösung, die das Ziel erreicht?
   - Gibt es unnötige Änderungen, die gestrichen werden können?
   - Existieren einfachere Alternativen? Benenne sie konkret.

4. **Wiederverwendung** (aktiv recherchieren, nicht raten)
   - Durchsuche den Codebase nach bereits vorhandenen Funktionen, Komponenten, Utilities oder
     Mustern, die der Plan nutzen/erweitern sollte. Nenne **konkrete Stellen** (Datei + Symbol).
   - Markiere ausdrücklich jede Stelle, an der der Plan etwas **neu erfindet**, das es schon gibt.
   - Empfiehl Wiederverwendung nur, wenn sie fachlich passt und die Lösung vereinfacht.
     Ähnlichkeit allein rechtfertigt keine gemeinsame Abstraktion.

5. **Wartbarkeit**
   - Verständlichkeit, Testbarkeit, eingeführte technische Schuld.

Erfinde keine Befunde, um Abschnitte zu füllen. Wenn keine relevanten Probleme vorliegen, sage das
ausdrücklich. Reine Geschmackspräferenzen sind keine Probleme.

## Ausgabe-Struktur (genau diese Reihenfolge)
1. **Gesamteinschätzung** — 2–4 Sätze: ist der Plan tragfähig, mit welchen Vorbehalten?
2. **Stärken** — was der Plan gut macht.
3. **Konkrete Probleme** — je Punkt mit **Schweregrad** in `[kritisch]` / `[wichtig]` / `[optional]`,
   betroffener Planstelle, Beschreibung, konkreter Auswirkung **und** Verbesserungsvorschlag.
   Belege technische Beanstandungen mit passenden Code-Stellen (Datei + Symbol/Zeile);
   kennzeichne unbestätigte Annahmen als offene Fragen.
4. **Wiederverwendbare bestehende Komponenten** — konkrete Datei/Symbol + wie zu nutzen.
5. **Offene Fragen** — was vor der Umsetzung geklärt werden muss.

Schweregrade:
- `[kritisch]` — verhindert eine korrekte oder sichere Umsetzung.
- `[wichtig]` — sollte vor der Umsetzung geklärt werden.
- `[optional]` — konkrete Verbesserung; die Umsetzung bleibt auch ohne sie tragfähig.

## Schreiben & Versionierung
- Schreibe das Ergebnis nach `<name>.review.md` (gleicher Basisname wie `$ARGUMENTS`, gleiches Verzeichnis).
- Bestimme die Review-Nr **#N**: Falls `<name>.review.md` bereits existiert, lies deren bisherige
  höchste **Review Version #X** und setze **#N = #X + 1**; andernfalls **#N = #1**.
- **Ganz oben** in der Datei steht die Zeile:

  ```
  Review Version #N
  ```

  (Optional darunter: gegen welche **Plan Version** reviewt wurde, sofern im Plan-Header vermerkt.)
- Eine bereits vorhandene `.review.md` wird durch die neue Version **ersetzt** (höchstes #N gilt);
  der Header muss die aktuelle, hochgezählte Nummer tragen.
