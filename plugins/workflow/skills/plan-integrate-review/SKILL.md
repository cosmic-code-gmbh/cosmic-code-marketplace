---
name: plan-integrate-review
description: Incorporate a plan review into its implementation plan without changing application code. Use to assess findings, record unresolved decisions, and update the plan and version.
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

1. Lies Plan und zugehörige Review-Datei vollständig. Fehlt eine Datei, melde das und brich ab.
2. Lies die **Review Version #N** aus dem Review. Fehlt eine eindeutige Nummer, melde das und
   ändere nichts; erfinde keine Review-Version.
3. Bestimme die aktuelle **Plan Version #M** und den Stand der Review-Einarbeitung.
   Nutze vorrangig die letzte Versionszeile am Dateiende, andernfalls den aktuellen Plan-Header.
   Historische Changelog-Einträge sind keine aktuellen Versionsangaben. Ohne Plan-Version gilt
   #M = 0, d. h. die erste Änderung erhält #1.
   Ist Review #N bereits dokumentiert und müssen weder Planinhalt noch Bearbeitungsstand geändert werden,
   melde das ohne Dateiänderung oder Versionsanhebung. Eine ausdrücklich gewünschte
   Neubewertung bleibt möglich.
4. Vergleiche die im Review angegebene geprüfte Plan-Version, sofern vorhanden, mit dem aktuellen
   Plan. Berücksichtige zwischenzeitliche Änderungen: bereits erledigte oder überholte Befunde
   nicht erneut einarbeiten. Behaupte ohne Versionsnachweis keine Übereinstimmung.
5. Gehe jeden Befund, Verbesserungsvorschlag und jede offene Frage einzeln durch.
   Prüfe technische Behauptungen anhand der relevanten Code-Stellen und Projektanweisungen.
   Bewahre das vereinbarte Ziel und ausdrückliche Nutzerentscheidungen; das Review ist ein
   Vorschlag, keine verbindliche Vorgabe. Entscheide je Punkt:
   - **einarbeiten** — den Plan entsprechend anpassen,
   - **begründet ablehnen** — mit kurzer, sachlicher Begründung, auch bei bereits erledigten
     oder überholten Befunden, oder
   - **offen lassen** — wenn eine erforderliche Nutzerentscheidung oder ein belastbarer Nachweis
     fehlt. Benenne die konkrete Frage beziehungsweise den fehlenden Nachweis und seine Auswirkung.
     Nutze vorhandene Nutzerantworten; erfinde keine Präferenz.
   Leitlinien bei jeder Entscheidung:
   - **Funktionale Korrektheit** (vereinbartes Verhalten, relevante Fehlerfälle und Datenflüsse).
   - **Saubere Architektur** (Separation of Concerns, Kopplungsrichtung, Konsistenz mit bestehenden Mustern).
   - **Minimaler Eingriff** (kleinstmögliche Lösung, keine unnötigen Änderungen).
   - **Wiederverwendung**, wenn sie fachlich passt und die Lösung vereinfacht.
   - **Wartbarkeit** (Verständlichkeit, Testbarkeit, technische Schuld).
6. Passe den Plan gezielt in derselben Datei an. Erhalte unbetroffene Inhalte, frühere Entscheidungen
   und die Markdown-Struktur einschließlich Tabellen und Codeblöcken. Aktualisiere betroffene
   Abschnitte und Verweise konsistent; die Datei muss den vollständigen, widerspruchsfreien Plan
   enthalten. Eine Einarbeitung ohne inhaltliche Änderung des Plans kann dennoch die erstmalige
   Dokumentation der Review-Entscheidungen und der aktuellen Review-Nr erfordern.

## Ergebnis in der Plandatei

1. Halte oben einen kurzen Changelog der Einarbeitung fest. Mache je Review-Punkt nachvollziehbar:
   - `Geändert:` — was angepasst wurde.
   - `Bewusst abgelehnt:` — was nicht übernommen wurde und warum.
   - `Offen:` — ausstehende Entscheidungen oder Nachweise; falls keine, ausdrücklich so vermerken.
2. Erhalte danach den vollständigen, überarbeiteten Markdown-Plan.
3. Aktualisiere die Versionszeile am Dateiende:

   ```
   Plan Version #M — Review #N eingearbeitet
   ```

   Solange Punkte offen sind, verwende stattdessen:

   ```
   Plan Version #M — Review #N teilweise eingearbeitet
   ```

   - `#N` exakt aus der Review-Datei übernehmen.
   - Bei einer Änderung `#M` = bisherige Plan-Version + 1.
   - Ersetze die bisherige aktuelle Versionszeile und gleiche weitere aktuelle Status- und
     Versionsangaben ab. Historische Changelog-Einträge bleiben erhalten.
   - Stelle den Plan bei offenen, umsetzungsrelevanten Entscheidungen nicht als vollständig
     geklärt oder umsetzungsbereit dar.

## Abschlussmeldung

Nenne knapp die Plan-Version, die Review-Nr und wie viele Punkte eingearbeitet, begründet
abgelehnt oder noch offen sind. Bei einem unveränderten Wiederholungsaufruf melde diesen Zustand.
