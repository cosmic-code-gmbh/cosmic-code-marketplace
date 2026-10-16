---
name: plan-verify
description: Verify implemented code against an implementation plan without making fixes. Use for a plan verification that writes a sibling .verify.md report.
---

# Implementierungs-Verifikation

**Eingabe:** Ein Pfad zu einer Markdown-Plandatei, relativ zum aktuellen Projekt oder absolut.
Nutze den vom Benutzer übergebenen Pfad; beim Aufruf in Claude Code steht er in
`$ARGUMENTS`. Im Folgenden bezeichnet `$ARGUMENTS` diesen Pfad. Falls kein Pfad
angegeben wurde, frage danach. Falls die Datei fehlt, melde das und brich ab.
Der Basisname ohne `.md` heißt `<name>`. Prüfe das Projekt, zu dem der Plan gehört,
und beachte dessen Projektanweisungen.

Du prüfst **nach** der Implementierung kritisch, ob der Plan tatsächlich umgesetzt wurde. Du schreibst
**KEINEN Code** und nimmst **keinen** Fix vor — du lieferst ausschließlich einen **Bericht** in
`<name>.verify.md`. Sei streng: „sieht plausibel aus" zählt nicht, nur am echten Code belegte Umsetzung.

## Aufgabe
1. Lies `$ARGUMENTS` vollständig und entnimm dem Plan-Header die **Plan Version #M**.
   Fehlt die Version, vermerke „nicht angegeben“; erfinde keine Nummer.
2. Zerlege den Plan in **einzelne, prüfbare Punkte**. Ergänze implizite Anforderungen nur, wenn sie
   für das vereinbarte Verhalten zwingend erforderlich sind, und begründe sie. Trenne diese von
   optionalen Verbesserungen. Kennzeichne ausdrücklich zurückgestellte Arbeiten als außerhalb des
   aktuellen Prüfungsumfangs; werte sie nicht als fehlende Umsetzung.
3. Verifiziere **jeden** Punkt am **tatsächlichen Code** des Repositorys und, wo erforderlich, anhand
   ausgeführter Prüfungen oder Laufnachweise. Belege jeden Befund mit einer **konkreten Stelle**
   (Datei + Funktion/Zeile) beziehungsweise dem passenden Prüfnachweis. Vergib je Punkt einen Status:
   - ✅ **umgesetzt**
   - ⚠️ **teilweise oder abweichend** (mit Erläuterung der Abweichung)
   - ❌ **fehlt** — nachweislich nicht umgesetzt
   - ❔ **nicht verifiziert** — Nachweis fehlt oder Prüfung war nicht möglich; benenne die Grenze

   Begründete, funktional gleichwertige Abweichungen sind nicht automatisch Mängel. Dokumentiere sie
   und werte den Punkt als umgesetzt, sofern keine verbindliche Vorgabe verletzt wird.
4. Identifiziere zusätzlich:
   - **Ungeplante Änderungen / Scope Creep** — ordne Änderungen nur anhand eines nachvollziehbaren
     Diffs beziehungsweise Änderungssatzes zu. Bereits vorhandenen Code und parallele Arbeit nicht
     pauschal zurechnen; fehlt eine belastbare Grundlage, kennzeichne die Zuordnung als unklar.
   - **Verstöße gegen die Plan-Prinzipien** (z. B. saubere Architektur, minimaler Eingriff,
     Wiederverwendung), auch wenn der Punkt formal „umgesetzt" ist.

## Prüfungen & Nachweise
- Führe dem Eingriff angemessene lokale Prüfungen aus, soweit autorisiert. Dokumentiere den
  geprüften Stand, Befehle, Ergebnisse und nicht ausgeführte Prüfungen samt Grund.
- Unterscheide Codeprüfung, erfolgreichen Testlauf und Bestätigung im laufenden System.
  Vorhandener Testcode belegt keinen erfolgreichen Testlauf. Frühere Ergebnisse dürfen nur als
  Nachweis gelten, wenn ihre Gültigkeit für den geprüften Stand nachvollziehbar ist.
- Trenne Fehler im geprüften Änderungssatz von bestehenden oder fremden Fehlern. Benenne bei
  blockierten Prüfungen, welche Aussagen dadurch offenbleiben.

## Ausgabe-Struktur (genau diese Reihenfolge)
1. **Gesamtergebnis** — eine Zeile: `vollständig` / `Lücken` / `unvollständig` + ein Satz Begründung.
   - `vollständig`: Alle Anforderungen im aktuellen Prüfungsumfang sind nachgewiesen erfüllt;
     es bestehen keine relevanten Mängel oder offenen Pflichtprüfungen.
   - `Lücken`: Die Umsetzung ist im Wesentlichen nachgewiesen, einzelne Anforderungen oder
     erforderliche Nachweise fehlen beziehungsweise weichen relevant ab.
   - `unvollständig`: Zentrale Anforderungen fehlen oder sind nicht verifiziert, sodass eine
     tragfähige Gesamtbestätigung nicht möglich ist.
2. **Prüftabelle**:

   | Planpunkt | Status | Beleg (Code-Stelle / Prüfnachweis) | Anmerkung |
   | --- | --- | --- | --- |

3. **Fehlende / abweichende Punkte** — priorisiert (wichtigstes zuerst), je mit nötigem nächsten Schritt.
   Führe nicht verifizierte Punkte gesondert innerhalb dieses Abschnitts auf und fasse hier die
   ausgeführten sowie offenen Prüfungen zusammen.
4. **Ungeplante Änderungen** — Scope Creep / Prinzipien-Verstöße.
5. **Nächste Schritte** — konkrete, umsetzbare To-dos zur Schließung der Lücken.

## Schreiben & Versionierung
- Schreibe das Ergebnis nach `<name>.verify.md` (gleicher Basisname wie `$ARGUMENTS`, gleiches Verzeichnis).
- **Ganz unten** als letzte Zeile der Header:

  ```
  Verifikation gegen Plan Version #M — Ergebnis: [vollständig | Lücken | unvollständig]
  ```

  - `#M` exakt aus dem Plan-Header übernehmen. Fehlt die Version, ersetze `Plan Version #M`
    durch `Plan Version nicht angegeben`.
  - Das Ergebnis-Schlagwort muss mit dem **Gesamtergebnis** oben übereinstimmen.
