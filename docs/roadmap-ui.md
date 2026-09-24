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
| `src/ui/page.js` | `renderReviewPage(token)`, eine Seite ohne Build-Schritt, Material Design 3 aus eigenen Tokens |
| `src/ui/app.js` | Manifest, Icons und Service Worker — die App ist diese Seite, installiert |
| `src/ui/setup-page.js` | Die Seite für ein Verzeichnis ohne Projekt |
| `src/runtime/project-checks.js` | `listChecks()` / `runCheck(id)` — die Prüfungen, eine Registry für alle Oberflächen |
| `src/runtime/first-run.js` | `describeProject()` / `createProject()` — gibt es hier ein Projekt, und was würde eines anlegen |
| `src/runtime/diagnose.js` | `diagnose(root)` — ob ein Run hier starten könnte und gegen welchen Provider |

Jede neue Oberflächenfunktion geht durch `project-state.js`. Kein zweiter
Lesepfad, keine zweite Wahrheit.

---

## Wo wir stehen

| Fähigkeit | CLI | TUI | Web | App |
| --- | :-: | :-: | :-: | :-: |
| Approvals: list and decide | ✅ | ✅ | ✅ | ✅ |
| Approval in full, with the rule that stopped it | ✅ | ✅ | ✅ | ✅ |
| Queue: list, cancel, resume | ✅ | ✅ | ✅ | ✅ |
| Runs: list | ✅ | ✅ | ✅ | ✅ |
| A run's receipt in detail | ✅ | ✅ | ✅ | ✅ |
| The agents that ran, each one readable in full | ✅ | ✅ | ✅ | ✅ |
| Verify a receipt: hash chain and signatures | ✅ | ✅ | ✅ | ✅ |
| Start a run | ✅ | ✅ | ✅ | ✅ |
| Settings: list, diff, change locally or globally | ✅ | ✅ | ✅ | ✅ |
| Worktrees: list, and remove only when clean | ✅ | ✅ | ✅ | ✅ |
| What a worktree holds, and one file's diff | ✅ | ✅ | ✅ | ✅ |
| The project's own merge requests | ✅ | ✅ | ✅ | ✅ |
| The checks: doctor, policy, content, deps, secrets, telemetry | ✅ | ✅ | ✅ | ✅ |
| A project where there is none yet | ✅ | ✅ | ✅ | ✅ |
| The models a provider can reach, and their published prices | ✗ | ✗ | ✅ | ✅ |
| An SBOM, an attestation, a replay | ✅ | ✗ | ✗ | ✗ |
TAP version 13
# Subtest: every capability the table claims is in the code
ok 1 - every capability the table claims is in the code
  ---
  duration_ms: 6.057198
  type: 'test'
  ...
# Subtest: a capability that is open says so, and says why
ok 2 - a capability that is open says so, and says why
  ---
  duration_ms: 0.311122
  type: 'test'
  ...
# Subtest: the table in docs/roadmap-ui.md is the one these rows produce
not ok 3 - the table in docs/roadmap-ui.md is the one these rows produce
  ---
  duration_ms: 3.185708
  type: 'test'
  location: '/home/user/ETNPILOT/test/parity.test.js:157:1'
  failureType: 'testCodeFailure'
  error: |-
    docs/roadmap-ui.md is out of date. Replace its capability table with:
    
    | Fähigkeit | CLI | TUI | Web | App |
    | --- | :-: | :-: | :-: | :-: |
    | Approvals: list and decide | ✅ | ✅ | ✅ | ✅ |
    | Approval in full, with the rule that stopped it | ✅ | ✅ | ✅ | ✅ |
    | Queue: list, cancel, resume | ✅ | ✅ | ✅ | ✅ |
    | Runs: list | ✅ | ✅ | ✅ | ✅ |
    | A run's receipt in detail | ✅ | ✅ | ✅ | ✅ |
    | The agents that ran, each one readable in full | ✅ | ✅ | ✅ | ✅ |
    | Verify a receipt: hash chain and signatures | ✅ | ✅ | ✅ | ✅ |
    | Start a run | ✅ | ✅ | ✅ | ✅ |
    | Settings: list, diff, change locally or globally | ✅ | ✅ | ✅ | ✅ |
    | Worktrees: list, and remove only when clean | ✅ | ✅ | ✅ | ✅ |
    | What a worktree holds, and one file's diff | ✅ | ✅ | ✅ | ✅ |
    | The project's own merge requests | ✅ | ✅ | ✅ | ✅ |
    | The checks: doctor, policy, content, deps, secrets, telemetry | ✅ | ✅ | ✅ | ✅ |
    | A project where there is none yet | ✅ | ✅ | ✅ | ✅ |
    | The models a provider can reach, and their published prices | ✗ | ✗ | ✅ | ✅ |
    | An SBOM, an attestation, a replay | ✅ | ✗ | ✗ | ✗ |
    
    
    false !== true
    
  code: 'ERR_ASSERTION'
  name: 'AssertionError'
  expected: true
  actual: false
  operator: 'strictEqual'
  stack: |-
    TestContext.<anonymous> (file:///home/user/ETNPILOT/test/parity.test.js:160:10)
    async Test.run (node:internal/test_runner/test:1054:7)
    async Test.processPendingSubtests (node:internal/test_runner/test:744:7)
  ...
# Subtest: the app column is the web column, because the app is the page
ok 4 - the app column is the web column, because the app is the page
  ---
  duration_ms: 0.28567
  type: 'test'
  ...
1..4
# tests 4
# suites 0
# pass 3
# fail 1
# cancelled 0
# skipped 0
# todo 0
# duration_ms 16.150046

**Diese Tabelle prüft sich selbst.** Sie wird aus `test/parity.test.js`
erzeugt, und jede Zeile nennt dort pro Oberfläche das Beleg-Stück im Code —
den CLI-Befehl, die Ansicht oder Taste, die HTTP-Route. Der Test sucht sie und
schlägt fehl, wenn eine Behauptung nicht stimmt oder wenn diese Tabelle von den
Zeilen abweicht. Ein ✗ muss einen Grund haben, sonst schlägt er auch fehl.

Die App-Spalte ist die Web-Spalte, weil die App die Seite *ist* — installiert
(UI-3). Das ist eine Entscheidung, keine Lücke: eine zweite Implementierung
jeder Ansicht wäre genau der zweite Lesepfad, den dieses Projekt vermeidet.

Der Design-Canvas mit den Artboards liegt weiterhin unter
`https://claude.ai/artifact/Rr65iXmq1fgRSZMKMwD1YH`.

---

## UI-1 — Web auf TUI-Niveau — erledigt

War die größte Lücke. Die Seite kann jetzt, was die TUI kann; jeder Schritt hat
Tests in `test/ui.test.js`, `test/ui-settings.test.js` und `test/ui-run.test.js`.

**UI-1.1 Queue fortsetzen.** `POST /api/queue/resume` mit `{ id, force? }`.
Cancel und Resume stehen nur an Jobs, die die Queue auch annimmt — Resume also
an `failed`, `canceled`, `orphaned`, und bei `orphaned` als „Resume anyway",
weil das wie `--force` eine zweite, ausdrückliche Entscheidung ist. Ein Job im
falschen Zustand und ein unbekannter Job sind 409, kein 500.

**UI-1.2 Receipt eines Runs.** `GET /api/runs/:file`; der Dateiname wird hier
nicht geprüft, das macht `readReceipt`. Ein Klick auf eine Run-Zeile öffnet
Branch, Sandbox, Merge-Rehearsal samt Kollisionen aus dem Merge-Train,
Approvals mit Entscheider, `settings.layers` und `overrides`, Datei und
Signaturstatus. Ein Name mit Pfadtrenner ist 400, ein Weg, den schon die
URL-Auflösung wegkürzt, 404 — beides, bevor irgendetwas gelesen wird.

**UI-1.3 Settings-Seite.** `GET /api/settings`, `POST /api/settings/set|unset`.
`SettingsRefused` ist **409** mit `{ error, path, reason }`, nie 500; die
Ablehnung erscheint im Editor, wo die Änderung gemacht wurde, und die Eingabe
bleibt stehen. Kaputtes YAML ist 400. `locked` öffnet gar nicht erst und sagt
warum. Filter, Umschalter lokal ↔ global, „nur geänderte", und die abgelehnten
lokalen Settings über der Liste, mit dem Satz, dass ein Run damit nicht startet.

**UI-1.4 Run starten.** `POST /api/runs/start` antwortet sofort mit `202`; der
Run wird nicht abgewartet. Das Tracking liegt jetzt in `project-state.js` statt
doppelt in der TUI: `collect()` liefert `active` und `recentRunErrors`, und wer
die Oberfläche schließt, bricht ab, was sie gestartet hat — die TUI über
`app.stop()`, der Server über `close()`, beide über `state.stopRuns()`.

**UI-1.5 Die Seite ansehen.** Chromium bei 1280px und 390px, beide
Farbschemata. Drei Dinge, die kein Test zeigte: eine breite Tabelle zog die
Seite auf 2537px auseinander (Grid-Kinder sind `min-width: auto`), die
Settings-Liste war 122 Zeilen lang, und der 5-Sekunden-Poll überschrieb die
Rückmeldung einer Änderung. Jetzt: `overflow 0px` in allen vier Kombinationen,
eine Liste, die sagt „Showing 25 of 122", und ein Poll, der stillhält, solange
ein Feld den Fokus hat. Jeder Knopf wurde im Browser gedrückt: entscheiden,
abbrechen, fortsetzen, Worktree entfernen, Setting speichern und ablehnen
lassen, Run starten.

**UI-1.6 Der GUI-Entwurf.** Aus dem Entwurf übernommen: die Shell aus Sidebar,
Topbar und Panels, die Statusanzeigen als Pills, die Kennzahlen-Karten, die
Befehlspalette auf `ctrl` `K`, Toasts statt einer Statuszeile, der Dialog zum
Starten eines Runs, die Schublade auf dem Telefon und die Fokus-Ringe. Nicht
übernommen: die Ansichten für Dinge, die es nicht gibt (Brainstorming, Agenten,
Plugins, Codegraph, Observability, Repositories, ein CLI-Nachbau) — eine leere
Seite lehrt das Falsche —, die erfundenen Zahlen, `overflow-x: hidden` auf dem
`body`, das Fehler versteckt statt behebt, und die Festlegung auf Dunkel. Die
Sprache bleibt vorerst Englisch wie im ganzen Repository.

---

## UI-2 — TUI: die restlichen Befehle — erledigt

### UI-2.1 Prüfungen — erledigt
- Ansicht `checks` (Taste `7`): `doctor`, die Policy über alle konfigurierten
  Provider, `content verify`, `deps check`, `scan secrets`, `telemetry
  summary`. `enter` führt die markierte aus, `A` alle der Reihe nach.
- Eine Registry, `src/runtime/project-checks.js`, über `project-state` wie
  alles andere; `etnpilot check [name...]` ist derselbe Lesepfad. Eine zweite
  Implementierung pro Oberfläche wäre eine zweite Antwort auf „ist dieses
  Projekt in Ordnung", und zwei Antworten sind schlimmer als keine.
- **Nichts davon läuft von selbst.** `scan secrets` liest jede getrackte Datei,
  `doctor` spricht mit einem Secret-Store — der Poll darf keine davon starten,
  und der Test prüft genau das.
- Vier Zustände, nie verwechselt: nie gelaufen, läuft gerade, was sie gefunden
  hat, und *kein Urteil* — Telemetrie ohne aufgezeichneten Run ist kein
  bestandener Test, und `scan secrets` außerhalb eines Checkouts sagt „kein
  git-Checkout" statt „nichts gefunden".
- **Erledigt:** `test/tui-checks.test.js` rendert die Ansicht, führt sie gegen
  ein echtes Testprojekt aus, pflanzt ein Credential und liest den Fund
  zurück — ohne dass der Wert selbst je im Fund auftaucht.

### UI-2.2 Receipt prüfen — erledigt
- In der Run-Detailansicht `v` → unter „Receipt": gültig, Hash-Kette,
  Signatur, `encoding`. Auf der Seite derselbe Knopf, über `GET /api/verify/`.
- Der Grund-Code ist für ein Programm; `describeVerification` macht daraus den
  Satz, den ein Mensch braucht: nicht `hash-mismatch`, sondern „ein Eintrag
  passt nicht zu seinem eigenen Hash, Zeile 3: er wurde nach dem Schreiben
  geändert".
- Ohne konfigurierten Public Key wird die Kette geprüft und die Signatur
  nicht — und die Zeile sagt das, statt „verifiziert" beides bedeuten zu
  lassen.
- **Erledigt:** `test/tui-run.test.js` verändert ein Byte eines gesiegelten
  Receipts und liest den Satz vom Schirm ab.

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
- **Erledigt für Web und App:** beide Ansichten gibt es dort, über dieselben
  Routen (`/api/worktrees`, `/api/merges`).

### UI-2.4 Erste Schritte — erledigt
- Fehlt `.etnpilot/etnpilot.yaml`, zeigt `etnpilot tui` die drei Templates mit
  je einem Satz, legt das gewählte an und öffnet die echte Oberfläche darauf.
  `etnpilot ui` tut dasselbe über eine eigene Seite und
  `POST /api/project/create`.
- Jede Zeile listet die Einstellungen, die dieses Template wirklich ändert —
  aus dem Template selbst gelesen, nicht daneben geschrieben.
- Zwei Dinge, die das ENOENT nicht sagen konnte: dass das Verzeichnis kein
  git-Checkout ist (die nächste Wand), und dass außerhalb von `.etnpilot/`
  nichts angefasst und nichts committet wird.
- **Erledigt:** `test/tui-first-run.test.js` und `test/ui.test.js` — `q` legt
  nichts an, ein fehlgeschlagener Schreibvorgang lässt den Schirm mit dem Grund
  offen, und ein Template-Name von außerhalb der Liste erreicht
  `initializeProject` nie.

---

## UI-3 — Die App — erledigt

Die drei offenen Entscheidungen sind getroffen. Die Begründung steht in
`src/ui/app.js`, damit eine spätere Änderung etwas zum Widersprechen hat:

1. **Form — PWA auf der bestehenden Seite.** Die Regel dieses Projekts ist ein
   Lesepfad und keine zweite Wahrheit. Eine native App ist eine zweite
   Implementierung jeder Ansicht und driftet beim ersten neuen Feld. So kostet
   „installieren" ein Manifest und einen Service Worker, und installiert wird
   die Oberfläche, die bereits getestet und bereits Material Design ist.
2. **Reichweite — Loopback, unverändert.** Ein Relay legt Approvals auf fremde
   Maschinen und bricht den Satz, auf dem diese Oberfläche steht.
   `etnpilot ui --host` bedient schon heute ein Tablet im selben Netz und sagt
   dazu, was das kostet; die App fügt dem nichts hinzu.
3. **Identität — das Token weist den aus, der es hat, keine Person.**
   Installieren ändert daran nichts. Die App merkt sich den Namen, den man
   eingibt, auf dem Gerät, schickt ihn mit jeder Entscheidung, und das Feld
   sagt selbst, dass diese Seite nie geprüft hat, wer man ist.

Offline gilt dasselbe Prinzip: der Worker cacht die beiden Icons und sich
selbst, nie `/api/` und nie eine Navigation. Eine Review-Oberfläche, die
jemandem beim Entscheiden die Approvals von gestern zeigt, wäre offline
schlechter als abwesend — ohne Netz kommt eine Seite, die das sagt.

- **UI-3.1 bis UI-3.4** sind damit die Seite selbst: Approvals mit der
  auslösenden Regel, Runs und Receipts, Settings mit denselben Modi und
  denselben Ablehnungen, Run starten. `test/ui-app.test.js` hält die Schale
  und die Regel, dass nie Evidenz gecacht wird.

---

## UI-4 — Quer durch

### UI-4.1 Design-Canvas korrigieren
Die Artboards `Tui-Policy`, `Web-Policy`, `App-Policy` zeigen noch ein
„Commit the change"-Modell. Das ist seit der Entscheidung „Settings bleiben
lokal" falsch. Ersetzen durch die Schicht-Ansicht mit `open` /
`stricter-only` / `locked`.

### UI-4.2 Ein echter Durchlauf — Anleitung steht, Durchlauf fehlt

`docs/first-real-run.md` ist die Anleitung: Provider, Workflow im Worktree,
echtes GitLab, Evidenz prüfen. Sie beginnt mit einer Tabelle, was tatsächlich
belegt ist — und zwei Zeilen darin lauten **nichts**. Das Dokument zu schreiben
ändert daran nichts, und es sagt das ausdrücklich, statt wie ein Bericht über
einen Lauf zu klingen, den es nicht gab. `test/docs.test.js` prüft, dass jeder
dort genannte `etnpilot …`-Befehl existiert.


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

### UI-4.3 Eine Fähigkeitstabelle, die sich selbst prüft — erledigt
`test/parity.test.js`: jede Zeile nennt pro Oberfläche das Beleg-Stück im Code,
der Test sucht es, und die Tabelle oben in dieser Datei wird aus denselben
Zeilen erzeugt. Ein `✗` ohne Begründung schlägt ebenfalls fehl — das ist, was
„noch nicht" davon abhält, unbemerkt „nie" zu werden.

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
7. **Eine Prüfung, die ihre Frage nicht stellen konnte, hat sie nicht
   bestanden.** `scan secrets` außerhalb eines Checkouts liest keine Datei;
   „nichts gefunden" wäre eine Behauptung über einen Baum, den sie nie
   geöffnet hat. Dafür gibt es *kein Urteil* als eigenen Zustand.
8. **Eine Oberfläche sagt, welche Frage sie beantwortet hat.** „Verifiziert"
   ohne konfigurierten Public Key heißt: die Kette stimmt, die Signaturen
   wurden nicht geprüft. Ein Wort für beides ist die stärkere Behauptung von
   zweien, und damit die falsche.
9. **Design ist ein System, kein Anstrich.** Tokens zuerst, Komponenten
   danach; kein Literal für eine Farbe unterhalb des Token-Blocks, sonst folgt
   sie dem Dunkelmodus nicht. `test/ui-material.test.js` hält das fest.
10. **Renderer bleiben reine Funktionen.** State und Viewport rein, Zeilen oder
   Knoten raus. Nur deshalb sind diese Oberflächen überhaupt testbar.

## Sicherheitsrahmen für neue Web-Endpunkte

Nicht aufweichen: Loopback-Bindung, Token in `?token=` für die Seite und in
`x-etnpilot-token` für jeden `/api/`-Aufruf, `OPTIONS` → 405, keine
Cross-Origin-Anfragen. Ein neuer mutierender Endpunkt erbt das unverändert.
