# Entwurf: einen abgebrochenen Lauf fortsetzen

Status: **Vorschlag. Gebaut sind die Etappen E1 und E2** (E2: `etnpilot resume <lauf> --dry-run`, nur Plan, es
wird nichts ausgeführt) (`run-start`- und `step`-Einträge mit Digests, siehe
`docs/signed-receipts.md`, „What a run writes“); E3 bis E5 sind offen (die Prüfseite zeigt
schon den Plan für Läufe, die nicht erfolgreich waren, mit einem „Check“-Knopf; fortsetzen kann sie noch nicht). Geschrieben, um vor dem Bauen zu entscheiden, was
„fortsetzen“ hier überhaupt heißen darf. Die offenen Fragen stehen am Ende (Abschnitt 9).

## 1. Das Problem

Ein Lauf kann mitten in der Arbeit enden: der Prozess wird beendet, das Telefon geht aus, ein Schritt
scheitert nach zwanzig Minuten, das Budget ist aufgebraucht. Heute bleibt dann nur, den Lauf **von vorn**
zu starten. Der Preis ist Zeit und Geld; auf einem Telefon mit mobilem Netz ist es auch Geduld.

## 2. Was es schon gibt (und was nicht)

| Baustein | Stand |
|---|---|
| Workflow als Schritte mit Abhängigkeiten (`WorkflowEngine`) | Schritte kennen ihre Ergebnisse (`dependencyResults`), laufen aber nur im Speicher |
| Beleg pro Lauf als Hash-Kette | Jeder Agenten-Eintrag trägt `workflowStep`, `result`, `usage`, `approvals` |
| Ein fehlgeschlagener Abschluss wird als `failed` versiegelt (`phase: "finish"`) | ja |
| Ein **getöteter** Prozess | hinterlässt einen **unversiegelten** Beleg, den Worktree und die Arbeitsbereichs-Sperre (`etnpilot lease recover`) |
| `etnpilot queue resume <job>` | startet den **ganzen** Job neu (`attempts = 0`); bei `orphaned` nur mit `--force`. Kein Schritt wird übersprungen |
| Chat-Sitzungen | haben ein Zug-Journal und `undo`; ein eigenes Thema, hier ausgeklammert |

Was **fehlt**: ein Beleg, der sagt, in welchem Zustand der Arbeitsbereich nach jedem Schritt war, und ein
Weg, fertige Schritte wiederzuverwenden, ohne dem Ergebnis blind zu glauben.

## 3. Was „sicher fortsetzen“ verlangt

Fortsetzen ist gefährlicher als Neustarten, weil es **glaubt**, was ein früherer Lauf getan hat. Jede der
folgenden Bedingungen muss geprüft werden, sonst wird abgelehnt:

1. **Der alte Beleg stimmt.** Die Kette verifiziert (`receipts verify`); bei Signatur-Pflicht auch die
   Signaturen. Ein beschädigter oder manipulierter Beleg setzt nichts fort.
2. **Der Arbeitsbereich ist so, wie der letzte fertige Schritt ihn hinterließ.** Sonst gilt das Ergebnis
   dieses Schritts nicht mehr (eine Änderung im Worktree kann seine Aussage ungültig machen).
3. **Konfiguration und Inhalt sind dieselben.** Sonst läuft der Rest unter anderen Regeln als der Anfang
   (Policy, Agenten-Prompts, Content-Lock).
4. **Nichts außerhalb des Arbeitsbereichs wurde schon getan**, was sich nicht wiederholen lässt:
   Veröffentlichen, Merge-Request, GitLab-Notiz, Netzwerkaufrufe mit Wirkung.
5. **Freigaben gelten nicht stillschweigend weiter.** Eine Freigabe gehört zu einer Anfrage und einem Lauf.
6. **Die Kosten bleiben sichtbar.** Was der alte Lauf schon gekostet hat, verschwindet nicht aus der Rechnung.

Nicht fortsetzbar, aus Prinzip: **mitten in einem Schritt.** Eine Anbieter-Sitzung lässt sich nicht
serialisieren (`docs/workflow-queue.md`: Checkpoints „recreate no provider session“), und ein halb
ausgeführter Werkzeugaufruf hat vielleicht schon gewirkt. Die kleinste Einheit ist der **Workflow-Schritt**.

## 4. Optionen

- **A. Nichts ändern** (Neustart). Einfach und ehrlich, aber teuer bei langen Läufen.
- **B. Fortsetzen auf Schrittebene** (dieser Entwurf). Fertige Schritte werden wiederverwendet, der Rest
  läuft neu. Grobkörnig, aber ohne neue Annahmen über Anbieter.
- **C. Fortsetzen auf Werkzeug-/Zugebene** (ein Journal im Agenten). Würde auch einen halben Schritt
  retten, braucht aber Wiedergabe von Anbieter-Zustand und macht jede Werkzeug-Wirkung zur Frage. Nicht
  empfohlen; wenn nötig, ein späteres Projekt.

**Empfehlung: B.**

## 5. Der Entwurf zu B

### 5.1 Ein neuer Lauf, der auf den alten verweist

Fortsetzen **hängt nichts an die alte Kette an.** Ein versiegelter Beleg darf nicht wachsen (ADR 0001), und
ein unversiegelter gehört einem Prozess, der nicht mehr da ist. Stattdessen entsteht ein **neuer Lauf** mit
eigener Kette, dessen erster Eintrag sagt:

```json
{
  "resumedFrom": {
    "runId": "…", "receiptHash": "<letzter Hash der alten Kette>", "verified": true,
    "reusedSteps": [{ "step": "analyse", "entryHash": "…" }, { "step": "plan", "entryHash": "…" }]
  }
}
```

Jeder wiederverwendete Schritt erscheint im neuen Beleg als `reused: true` mit dem Hash des Eintrags, aus
dem sein Ergebnis stammt. Wer prüft, kann der Spur bis in den alten Beleg folgen.

### 5.2 Neue Belege, die vorher nicht nötig waren

Das ist der eigentliche Bauaufwand und **nützt auch ohne Fortsetzen**:

- **`workspaceDigest` nach jedem Schritt:** ein Hash über den Git-Stand des Arbeitsbereichs (HEAD plus
  Baum der Änderungen, z. B. `git add -N` + `git write-tree` in einem temporären Index, damit der echte
  nicht berührt wird). Er beantwortet Bedingung 2.
- **`configDigest` am Anfang des Laufs:** Hash der wirksamen Konfiguration (Schichten + Policy) neben dem,
  was `content` schon als Beweis trägt. Beantwortet Bedingung 3.
- **Pro Schritt eine Wirkungsklasse:** `workspace` (wirkt nur im Arbeitsbereich), `read` (wirkt nicht),
  `external` (Netzwerk-/Forge-Wirkung). Heute weiß die Maschine das nur aus den Freigaben eines Schritts;
  die Klasse wird daraus abgeleitet und im Beleg festgehalten.

### 5.3 Der Planer (zuerst, ohne etwas auszuführen)

`etnpilot resume <lauf|belegdatei> --dry-run` liest, prüft und **druckt einen Plan**:

```
Lauf run-7f3a (failed in 'review', 3 von 5 Schritten fertig)
  wiederverwendet   analyse   (workspace, Beleg-Eintrag 3f9c…)
  wiederverwendet   plan      (read,      Beleg-Eintrag 81ab…)
  wiederverwendet   build     (workspace, Arbeitsbereich unverändert seit 5d20…)
  läuft neu         review    (der Schritt, der scheiterte)
  läuft neu         publish   (external – nie automatisch; braucht --include-external)
Bisherige Kosten: 0,4120 USD (werden angezeigt, zählen nicht gegen das Budget dieses Laufs)
```

Gründe für eine Ablehnung stehen im Klartext daneben: „Beleg verifiziert nicht“, „der Worktree wurde
geändert (Digest weicht ab)“, „die Konfiguration ist eine andere“, „Worktree existiert nicht mehr“.

### 5.4 Ausführen

Ohne `--dry-run` führt `resume` genau den Plan aus: neuer Lauf, gleicher Worktree und Branch (wenn der
Digest passt), wiederverwendete Schritte liefern ihre Ergebnisse an `dependencyResults`, der Rest läuft.
Alle Prüfungen laufen **unmittelbar vor dem Start** noch einmal, nicht nur im Plan.

Regeln:

- **Schritte mit Wirkungsklasse `external` laufen nie von selbst wieder.** Sie brauchen
  `--include-external` und eine ausdrückliche Bestätigung; nach einem Abbruch ist unklar, ob sie gewirkt
  haben (derselbe Gedanke wie `orphaned` + `--force` in der Warteschlange).
- **Ein Schritt, der scheiterte oder dessen Ergebnis fehlt, läuft neu**, auch wenn Teile seiner Arbeit im
  Worktree liegen; sein Ausgangszustand ist der Digest nach dem letzten *fertigen* Schritt. Weicht der
  Worktree davon ab (Teilarbeit des gescheiterten Schritts), gilt: **zurücksetzen auf den Digest** (mit
  Hinweis und Bestätigung) oder ablehnen. Nie stillschweigend weiterbauen auf unbekanntem Stand.
- **Freigaben:** Einmal-Freigaben der alten Läufe gelten nicht. Freigaben „für den Lauf“ (`approve-for-run`)
  gehören zu einem Lauf und werden nicht übernommen; wiederverwendete Schritte brauchen keine, die
  neu laufenden fragen neu.
- **Abweichung** von Konfiguration/Inhalt: abgelehnt, außer `--allow-drift`; dann steht die Abweichung
  (welche Schichten, welche Dateien) im neuen Beleg.
- Die **Sperre des Arbeitsbereichs** verhindert zwei gleichzeitige Fortsetzungen desselben Worktrees.
  Zwei Fortsetzungen *nacheinander* aus demselben alten Lauf sind erlaubt und ergeben zwei Läufe.

### 5.5 Kosten und Budget

Wiederverwendete Schritte zählen in der Anzeige (`Bisher + neu`), aber **nicht gegen das Budget des neuen
Laufs** — das Budget begrenzt, was dieser Lauf noch ausgibt. (Frage 2 unten: Soll es anders sein?)

### 5.6 Oberflächen

- **CLI:** `etnpilot resume`, `--dry-run`, `--allow-drift`, `--include-external`, `--json`. Ein *handelnder*
  Befehl, also hinter dem Vertrauens-Tor (`etnpilot trust`).
- **Prüfseite:** Bei Läufen mit Status `failed`/`incomplete` ein Knopf „Fortsetzen…“, der **zuerst den
  Plan zeigt** und erst dann bestätigen lässt. Im Beleg-Detail ein Block „Fortgesetzt von …“ bzw.
  „Fortgesetzt als …“ mit Verweisen.
- **TUI:** eine Taste in der Lauf-Ansicht, gleicher Ablauf (Plan, dann Bestätigung).
- **Warteschlange:** `queue resume` bleibt ein Neustart des ganzen Jobs. Optional später:
  `queue resume --continue` nutzt denselben Planer für Läufe, die ein Job gestartet hat; Schritte mit
  GitLab-Wirkungen sind `external` und bleiben ausgeschlossen.

## 6. Änderungen an Format und Prüfung

- Neue Felder (`resumedFrom`, `reused`, `workspaceDigest`, `configDigest`, `effect`) sind **additiv**; alte
  Belege bleiben gültig und verifizierbar, sie sind nur nicht fortsetzbar (kein Digest → Planer sagt es).
- `receipts verify` bekommt eine Option, der `resumedFrom`-Spur zu folgen und die alte Kette mitzuprüfen.
- `etnpilot replay` und die Beleg-Ansichten zeigen wiederverwendete Schritte als solche.
- `docs/signed-receipts.md` und der ADR 0001 bekommen einen Absatz: Fortsetzen verlängert nie eine Kette.

## 7. Teststrategie

Mit dem skriptbaren Anbieter (`scripted`), ohne Netz:

1. Prozess an jeder Schrittgrenze beenden (Abbruch-Signal im Test), dann `resume`: erwartet: fertige Schritte
   werden nicht erneut ausgeführt (Zähler im Skript), der Rest schon, das Ergebnis gleicht einem
   ununterbrochenen Lauf.
2. Worktree zwischen Abbruch und Fortsetzen ändern → abgelehnt; mit Zurücksetzen → fortgesetzt.
3. Belegzeile manipuliert → abgelehnt, mit dem Grund aus `verify`.
4. Konfiguration geändert → abgelehnt; mit `--allow-drift` → Abweichung im Beleg.
5. `external`-Schritt → nicht ohne `--include-external`.
6. Doppelt gleichzeitig → zweite Sperre scheitert; nacheinander → zwei Läufe.
7. Alte Belege ohne Digest → Planer sagt „nicht fortsetzbar: kein Arbeitsbereichs-Digest“.
8. Browser-Test für Plan und Bestätigung; axe-Test deckt die neue Ansicht mit ab.

## 8. Aufwand und Reihenfolge

| Etappe | Inhalt | Nutzen für sich |
|---|---|---|
| E1 | `workspaceDigest`, `configDigest`, Wirkungsklasse in den Belegen | ja: stärkere Beweise, auch für `replay` |
| E2 | Planer: `resume --dry-run`, Prüfungen, Klartext-Gründe | ja: erklärt, warum ein Lauf nicht fortsetzbar ist |
| E3 | Ausführung: neuer Lauf, wiederverwendete Schritte, Zurücksetzen | das eigentliche Fortsetzen |
| E4 | Prüfseite, TUI, Beleg-Ansichten | Bedienung |
| E5 | `queue resume --continue` | optional |

E1 und E2 sind in sich nützlich und riskieren nichts; **nach E2 kann entschieden werden, ob E3 den Aufwand
wert ist.**

## 9. Offene Fragen an dich

1. **Neuer Lauf mit Verweis** (5.1) statt Anhängen an die alte Kette — einverstanden? Alternative wäre
   ein „Fortsetzungs-Eintrag“ in der alten Kette, was versiegelte Ketten aufweichen würde.
2. **Budget:** Sollen wiederverwendete Kosten gegen das Budget des neuen Laufs zählen (strenger) oder nur
   angezeigt werden (dieser Entwurf)?
3. **Granularität:** Reicht der Workflow-Schritt? Ein einzelner Agenten-Schritt von 30 Minuten geht bei
   einem Abbruch komplett verloren. Wenn das der Hauptfall ist, lohnt Option C erst später und mit eigenem
   Entwurf.
4. **Zurücksetzen des Worktrees** (Teilarbeit des gescheiterten Schritts verwerfen) nur mit Bestätigung —
   oder gar nicht anbieten und stattdessen ablehnen?
5. **Digest-Kosten:** Auf sehr großen Repositories kostet der Git-Baum-Hash pro Schritt Zeit. Akzeptabel,
   oder nur am Ende der Schritte, die Dateien ändern dürfen?
6. **`external`-Schritte:** Bleibt es bei „nie automatisch“, oder soll es pro Schritt als „wiederholbar“
   deklarierbar sein (etwa ein idempotenter Merge-Request-Update)?

## 10. Was ausdrücklich nicht Teil davon ist

Fortsetzen mitten in einem Schritt oder Werkzeugaufruf, automatisches Fortsetzen ohne Mensch, Fortsetzen
nach geändertem Code ohne `--allow-drift`, Zusammenführen von Belegketten, und alles bei Chat-Sitzungen
(dort gibt es `undo` und das Zug-Journal).
