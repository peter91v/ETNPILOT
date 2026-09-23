# Roadmap: the user interfaces

Ein neuer Session-Start soll allein aus dieser Datei arbeiten können.

**Das Ziel, wörtlich:** *„Alle Varianten sollen alles können."* CLI, TUI, Web
und App sind vier Fenster auf dieselbe Sache, keines ist das kleine. Die
Absicherung ist nie die Oberfläche, sondern die Policy und die
Settings-Schichten.

**Die zweite Regel:** *„Jede Einstellungsänderung bleibt lokal beim User, wird
nie eingecheckt; eingecheckt ist nur die Default-Einstellung."*

---

## Was schon steht (nicht neu bauen)

| Modul | Was es liefert |
| --- | --- |
| `src/runtime/project-state.js` | `openProjectState({root, env})` → `{ root, config, inbox, queue, runsDirectory, collect(), decide(), cancelJob(), resumeJob(), startRun(), readReceipt(), worktrees(), removeWorktree(), mergeRequests(), setSetting(), unsetSetting(), close() }` — **die eine Quelle für jede Oberfläche** |
| `src/git/worktrees.js` | `WorktreeManager.describe()` — Branch, Herkunft und ob ein Entfernen Arbeit wegwirft; `removeIfClean(name)` |
| `src/config/settings.js` | `describeSettings`, `diffSettings`, `setSetting`, `unsetSetting`, `parseSettingValue`, `scopeFile`, `SettingsRefused` |
| `src/config/layers.js` | Schichten, Modi (`open` / `stricter-only` / `locked`), `settingsEvidence()` |
| `src/tui/render.js` | Reine Renderer: State + Viewport rein, Zeilen raus |
| `src/tui/app.js` | Tastenrouting, kennt kein Layout |
| `src/ui/server.js` | Loopback, Token, `/api/state`, `/api/approvals/decide`, `/api/queue/cancel` |
| `src/ui/page.js` | `renderReviewPage(token)`, eine Seite ohne Build-Schritt |

Jede neue Oberflächenfunktion geht durch `project-state.js`. Kein zweiter
Lesepfad, keine zweite Wahrheit.

---

## Wo wir stehen

| Fähigkeit | CLI | TUI | Web | App |
| --- | :-: | :-: | :-: | :-: |
| Approvals listen und entscheiden | ✅ | ✅ | ✅ | — |
| Approval im Volltext + auslösende Regel | ✅ | ✅ | teilw. | — |
| Queue listen / abbrechen | ✅ | ✅ | ✅ | — |
| Queue fortsetzen (`resume`) | ✅ | ✅ | ✗ | — |
| Runs listen | ✗ | ✅ | ✅ | — |
| Receipt eines Runs im Detail | teilw. | ✅ | ✗ | — |
| Run starten | ✅ | ✅ | ✗ | — |
| Settings listen / diff | ✅ | ✅ | ✗ | — |
| Settings ändern (lokal/global) | ✅ | ✅ | ✗ | — |
| `policy check` | ✅ | ✗ | ✗ | — |
| `receipt verify`, `replay`, `attest` | ✅ | ✗ | ✗ | — |
| `deps check`, `sbom`, `scan secrets` | ✅ | ✗ | ✗ | — |
| `graph *`, `content lock/verify` | ✅ | ✗ | ✗ | — |
| `doctor`, `telemetry summary` | ✅ | ✗ | ✗ | — |
| `init` | ✅ | ✗ | ✗ | — |
| Worktrees listen, mit ungespeicherter Arbeit | ✅ | ✅ | ✗ | — |
| Worktree entfernen (nur wenn sauber) | ✅ | ✅ | ✗ | — |
| Eigene Merge Requests listen | ✅ | ✅ | ✗ | — |

Die App existiert als Code **gar nicht** — nur als Artboards im Design-Canvas
(`https://claude.ai/artifact/Rr65iXmq1fgRSZMKMwD1YH`).

---

## UI-1 — Web auf TUI-Niveau

Die größte Lücke. Reihenfolge einhalten: jeder Schritt ist für sich
abschließbar und testbar.

### UI-1.1 Queue fortsetzen
- `src/ui/server.js`: `POST /api/queue/resume`, Body `{ id, force? }` → `state.resumeJob(id, { force })`.
- `src/ui/page.js`: Knopf „Resume" in der Queue-Zeile, sichtbar nur bei `failed` / `orphaned`.
- **Fertig wenn:** `test/ui.test.js` zeigt, dass ein `failed` Job wieder `pending` ist und ein unbekannter Job 409 statt 500 liefert.

### UI-1.2 Receipt eines Runs
- `src/ui/server.js`: `GET /api/runs/:file` → `state.readReceipt(file)`. **Den Dateinamen nicht selbst prüfen** — `readReceipt` weist alles ab, was kein `*.jsonl` ohne Pfadtrenner ist.
- `src/ui/page.js`: Klick auf eine Run-Zeile öffnet ein Panel mit Branch, Sandbox, Merge-Rehearsal samt Konflikten, Approvals mit Entscheider, `settings.layers` / `settings.overrides`, Receipt-Datei, Signaturstatus.
- **Fertig wenn:** `test/ui.test.js` prüft `../../etc/passwd` → 400, und dass `settings.overrides` im Panel steht.

### UI-1.3 Settings-Seite
- `src/ui/server.js`: `GET /api/settings` → `describeSettings`; `POST /api/settings/set` `{ path, value, scope }`; `POST /api/settings/unset` `{ path, scope }`.
- `SettingsRefused` → **HTTP 409** mit `{ error, path, reason }`, nie 500.
- `src/ui/page.js`: vierter Abschnitt „Settings". Pro Zeile Pfad, Wert, Herkunft (`committed` / `local` / `global`), Modus. `locked` ist nicht editierbar und sagt warum. Eingabe ist YAML, wie in CLI und TUI.
- Umschalter lokal ↔ global, Filterfeld, „nur geänderte".
- Abgelehnte lokale Settings (`describeSettings().refusals`) **über** der Liste anzeigen, mit dem Satz, dass ein Run damit nicht startet.
- **Fertig wenn:** `test/ui-settings.test.js` deckt ab: offen ändern, `stricter-only` verengen, Verweiterung → 409, `locked` → 409, `unset` → Default, `refusals` erscheinen im `/api/settings`-Body.

### UI-1.4 Run starten
- `src/ui/server.js`: `POST /api/runs/start` `{ task, agent? }` → `state.startRun(...)`. **Nicht auf den Run warten** — sofort `202` mit `{ started: true, task }` antworten, das Promise im Serverprozess halten und Fehler in einen Puffer schreiben, den `/api/state` mitliefert (`activeRuns`, `recentRunErrors`).
- `openProjectState` bekommt dafür eine Liste laufender Runs; `collect()` gibt sie als `active: [{ task, startedAt }]` zurück (die TUI hält das heute selbst in `src/tui/app.js` — beim Umzug dort entfernen, nicht doppeln).
- Beim Schließen des Servers jeden laufenden Run abbrechen, wie `app.stop()` es tut.
- **Fertig wenn:** `test/ui.test.js` startet einen Run mit Stub-Provider, sieht dessen Approval über `/api/state`, entscheidet es über `/api/approvals/decide`, und der Run endet `succeeded`.

### UI-1.5 Die Seite ansehen
- Chromium-Screenshot bei 1280px **und** 390px, beide Farbschemata.
- **Fertig wenn:** jeder Knopf, den die Seite zeigt, etwas tut; keine Zahl widerspricht den Zeilen darunter; nichts wird ohne Hinweis abgeschnitten.

---

## UI-2 — TUI: die restlichen Befehle

Neue Ansicht `tools` (Taste `5`), Liste von Prüfungen, `enter` führt aus,
Ergebnis im Panel. Alles bereits vorhandene Funktionen, nur ohne CLI.

### UI-2.1 Prüfungen
- `policy check` (`src/policy/engine.js`), `content verify`, `deps check`, `scan secrets`, `doctor`, `telemetry summary`.
- Jede ist ein Eintrag mit Name, letzter Ausführung und Ergebnis (`ok` / `findings: n`).
- **Fertig wenn:** `test/tui-tools.test.js` rendert die Ansicht, führt `doctor` und `scan secrets` gegen ein Testprojekt aus und prüft das Ergebnis im Rahmen.

### UI-2.2 Receipt prüfen
- In der Run-Detailansicht `v` → `verifyReceiptFile` (`src/core/receipt-store.js`), Ergebnis unter „Receipt": gültig, Hash-Kette, Signatur, `encoding`.
- **Fertig wenn:** ein manipuliertes Receipt in der Ansicht als ungültig erscheint.

### UI-2.3 Worktrees — erledigt
- Ansicht `worktrees` (Taste `5`): `WorktreeManager.describe()` — Branch, HEAD,
  ob ETNPilot ihn angelegt hat, und was ein Entfernen wegwerfen würde. `x` geht
  durch `removeIfClean(name)`.
- Dieselbe Beschreibung liefert `etnpilot worktree list`, und `state.worktrees()`
  in `project-state.js` ist der eine Lesepfad für beide.
- **Erledigt:** ein Worktree mit ungespeicherter Arbeit wird nicht entfernt und
  sagt, was er behält (`test/tui-worktrees.test.js`). Die Artefakte, die
  ETNPilot selbst in einen Workspace schreibt, zählen dabei nicht als Arbeit —
  dieselbe Liste wie in `removeIfClean`.

### UI-2.5 Eigene Merge Requests — erledigt
- Ansicht `merges` (Taste `6`): die offenen Merge Requests des Projekts, die
  eigenen zuerst. Eigen heißt: der Quellbranch beginnt mit `etnpilot/`, nicht
  ein Name im Titel, den jeder abschreiben kann.
- Fremde stehen daneben, aus demselben Grund, aus dem ein Run seinen Merge gegen
  den Zielbranch probt: was vor uns landet, bricht uns.
- Als einzige Ansicht braucht sie Netz und Token, also liest sie beim Öffnen und
  auf `g` — nie im Poll. Ohne `git.project`, ohne Token oder bei einer Absage
  von GitLab sagt sie das; der Rest der Oberfläche arbeitet weiter.
- Auch als `etnpilot merge list [--status …]`, über denselben Lesepfad
  (`state.mergeRequests()`).
- **Offen für Web und App:** beide Ansichten fehlen dort noch (UI-1, UI-3).

### UI-2.4 Erste Schritte
- Wenn `.etnpilot/etnpilot.yaml` fehlt: statt eines Fehlers eine Ansicht, die `initializeProject` mit Template-Auswahl anbietet.
- **Fertig wenn:** `etnpilot tui` in einem leeren Verzeichnis nicht mehr abbricht.

---

## UI-3 — Die App

Noch keine Zeile Code. Vor dem Bauen zu entscheiden (**dem User vorlegen, nicht
selbst annehmen**):

1. **Form** — PWA auf der bestehenden Seite (kein neues Ökosystem, offline
   begrenzt) oder nativ (Push, Biometrie, größerer Unterhalt)?
2. **Reichweite** — nur Loopback im selben Netz, oder über ein Relay? Ein Relay
   bricht die heutige Sicherheitsaussage („gebunden an 127.0.0.1"), das ist ein
   Entwurf für sich und keine Nebensache.
3. **Identität** — wer ist `decidedBy`, wenn die Entscheidung vom Telefon kommt?

Erst danach:
- **UI-3.1** Approvals lesen und entscheiden, mit der auslösenden Regel.
- **UI-3.2** Runs und Receipts.
- **UI-3.3** Settings, mit denselben Modi und denselben Ablehnungen.
- **UI-3.4** Run starten.

---

## UI-4 — Quer durch

### UI-4.1 Design-Canvas korrigieren
Die Artboards `Tui-Policy`, `Web-Policy`, `App-Policy` zeigen noch ein
„Commit the change"-Modell. Das ist seit der Entscheidung „Settings bleiben
lokal" falsch. Ersetzen durch die Schicht-Ansicht mit `open` /
`stricter-only` / `locked`.

### UI-4.2 Ein echter Durchlauf

**Belegt am 2026-09-23, Termux auf Android/arm64, Node 26.3.1:** 196 von 201
Tests grün, `doctor` meldet `ready: true`, `node:sqlite` vorhanden,
`content verify` grün. Alle fünf Fehlschläge hatten eine Ursache — kein
CodeGraph-Bundle für Android — und zwei davon waren Kern-Run-Tests, weil ein
optionaler Index den ganzen Run mitriss. Das ist behoben. Node 26 und
Android/arm64 gelten damit als geprüft; ein Provider- und GitLab-Durchlauf
steht weiterhin aus:
**Der größte offene Punkt im ganzen Projekt.** Es gibt keinen End-to-End-Lauf
gegen einen echten Provider und eine echte GitLab-Instanz. Alle Run-Tests
laufen gegen eingesetzte Stub-Provider. Nötig: eine dokumentierte Anleitung
(`docs/first-real-run.md`) und ein Bericht, was dabei tatsächlich gebrochen
ist. Das ist keine Aufräumarbeit, sondern die Frage, ob das Ganze funktioniert.

### UI-4.3 Eine Fähigkeitstabelle, die sich selbst prüft
`test/parity.test.js`: eine Liste von Fähigkeiten, pro Oberfläche belegt durch
einen Test oder ausdrücklich als offen markiert. Dann kann die Tabelle in dieser
Datei nicht mehr unbemerkt veralten.

---

## Regeln, die beim Bauen dieser Oberflächen gelernt wurden

Jede stammt aus einem Fehler, der erst beim Ansehen auffiel — nicht im Test.

1. **Ansehen, nicht nur behaupten.** Rendern und hinschauen (Terminal-Preview,
   Chromium-Screenshot). Der abgeschnittene Hilfetext, der falsche Footer, die
   Approval-Liste mit „(2)" über einer Zeile: alle drei hatten grüne Tests.
2. **Jede Taste und jeder Knopf, den die Oberfläche nennt, muss dort etwas
   tun.** Sonst bringt die Oberfläche die falsche Bedienung bei.
3. **Eine Zahl muss zu den Zeilen darunter passen.** Lieber eine Liste, die
   sagt, dass sie gekürzt ist.
4. **Eine Ablehnung wird nie verschluckt** — sie erscheint dort, wo die
   Änderung gemacht wurde, mit Grund, und die Eingabe bleibt offen.
5. **Kein Feld, das ignoriert wird.** Das Agent-Feld deckte auf, dass
   `--agent` seit jeher stillschweigend übergangen wurde, sobald ein Projekt
   `workflow.steps` hatte.
6. **Was eine offene Oberfläche schon hält, kann eine Einstellung nicht mehr
   ändern** (`queue.database`, `approval.inbox.database`) — das sagt sie, statt
   eine Änderung vorzutäuschen.
7. **Renderer bleiben reine Funktionen.** State und Viewport rein, Zeilen oder
   Knoten raus. Nur deshalb sind diese Oberflächen überhaupt testbar.

## Sicherheitsrahmen für neue Web-Endpunkte

Nicht aufweichen: Loopback-Bindung, Token in `?token=` für die Seite und in
`x-etnpilot-token` für jeden `/api/`-Aufruf, `OPTIONS` → 405, keine
Cross-Origin-Anfragen. Ein neuer mutierender Endpunkt erbt das unverändert.
