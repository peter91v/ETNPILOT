# Roadmap: der Agent selbst

Die Oberflächen sind fertig (`roadmap-ui.md`). Was sie zeigen, ist ein Agent,
der weniger kann als die Werkzeuge, die er nachbaut. Dieses Dokument ist der
kritische Durchgang durch das Projekt und der Plan daraus, abgeglichen mit dem,
was Claude Code kann.

**Sprache:** Deutsch wie `roadmap-ui.md`, weil es ein Planungsdokument ist.
Code, Kommentare und Commits bleiben Englisch wie im ganzen Repository.

---

## Wie ich vorgegangen bin

Gelesen, nicht erinnert. Jeder Befund unten nennt die Datei und die Zeile, an
der er steht, damit man ihn nachprüfen kann, statt ihn zu glauben. Wo ich eine
Vermutung hatte, die sich beim Nachsehen als falsch erwies, steht das dabei —
einmal ist genau das passiert (siehe B-7).

Nicht geprüft: ob der Agent *gut* arbeitet. Das kann nur ein echter Durchlauf
sagen, und `docs/first-real-run.md` sagt, dass es den noch nicht gegeben hat.
Teil C schlägt vor, wie sich das messen ließe (P6), statt es zu vermuten.

**Zwei Durchgänge.** Der erste (A-1 bis A-11) ging durch die Werkzeugkiste des
Agenten. Der zweite (A-12 bis A-22) durch alles darum herum: wer welche
Werkzeuge bekommt, was ein Mensch während eines Laufs sagen kann, was die CLI
in einer Pipeline zeigt, was ein Poll kostet, was CI prüft, und wie sicher der
Server ist. Der zweite Durchgang hat einen Fehler in meiner eigenen,
bereits gemergten Arbeit gefunden (A-12) — er steht deshalb ganz oben.

---

## Teil A — Der Befund

### Was gut ist, und warum es nicht angetastet wird

Bevor die Kritik kommt: der Kern ist solide gebaut und in einer Weise, die
selten ist.

- **Proof-carrying execution.** Hash-verkettete Receipts, Signaturen, Content
  Provenance, Attestation. Kein Werkzeug, das ich kenne, macht das, und es ist
  der eigentliche Grund, warum dieses Projekt existiert.
- **Policy vor Approval.** `policy.operations` entscheidet mechanisch, was
  erlaubt, was menschlich zu entscheiden und was verboten ist; `policy.**` ist
  `stricter-only`, also kann keine lokale Datei sie aufweichen.
- **Ein Lesepfad.** `project-state.js` für alle vier Oberflächen. Das ist der
  Grund, warum die UI-Arbeit überhaupt machbar war.
- **Die Schichten.** Committet ist nur der Default, lokale Änderungen bleiben
  lokal. Das ist die richtige Entscheidung und hält.
- **Der Sandkasten und die Worktrees.** Ein Run arbeitet nicht im Checkout.

Nichts davon steht im Plan. Was folgt, baut darauf auf.

### A-1 — Ein Reviewer kann nicht lesen, was er genehmigt

**Schwere: hoch. Es widerspricht einer Regel, die das Projekt selbst aufstellt.**

Die Approvals-Ansicht der Seite beschreibt sich mit dem Satz: *„A reviewer can
only approve what they can read."* Für `write_file` stimmt er nicht.

`src/providers/workspace-tools.js:144` schickt als Approval-Request:

```js
toolArguments: { path: path.relative, bytes: Buffer.byteLength(args.content) }
```

Pfad und Byte-Zahl. Nicht den Inhalt, nicht einen Diff gegen das, was auf der
Platte liegt. Ein Mensch genehmigt „schreibe 4.812 Bytes nach `src/auth.js`"
und weiß nicht, ob das ein Kommentar oder ein Backdoor ist. Für `run_command`
ist es richtig gelöst (`fullCommandText`) — für Schreibzugriffe nicht.

### A-2 — Es gibt kein `Edit`, nur „Datei komplett ersetzen"

**Schwere: hoch. Kostet Geld, Kontext und Korrektheit.**

Die vier Werkzeuge sind `read_file`, `list_files`, `write_file`, `run_command`
(`src/providers/workspace-tools.js:16-62`). Eine Änderung an einer Zeile in
einer 800-Zeilen-Datei heißt: 800 Zeilen lesen, 800 Zeilen zurückschreiben.

Das ist dreifach teuer. Die Tokens für die Ausgabe zahlt man doppelt. Der
Approval-Request wird unlesbar (siehe A-1). Und das Modell schreibt beim
Neuerzeugen Dinge um, die es nicht anfassen sollte — der klassische Fall, in
dem ein Agent „nebenbei" einen Kommentar verliert.

Claude Code hat dafür `Edit` mit `old_string`/`new_string`, exakt und
eindeutig. Genau das fehlt hier.

### A-3 — Kein Suchen, nur Auflisten

**Schwere: hoch.**

Es gibt kein `Grep` und kein `Glob`. Um „wo wird `resolveProviderSecret`
aufgerufen" zu beantworten, muss das Modell Verzeichnisse auflisten und
Dateien einzeln lesen — bei 18.982 Zeilen Quelltext ist das entweder
unmöglich oder ruinös teuer.

CodeGraph füllt die Lücke halb, aber nur für Copilot (siehe A-6) und nur für
Symbole, nicht für Text.

### A-4 — `subagents` ist tote Konfiguration

**Schwere: hoch, weil es aussieht, als ob es funktioniert.**

`.etnpilot/agents/orchestrator.yaml` sagt `subagents: [builder, reviewer]`.
Der Harness stellt `context.spawn` bereit (`src/core/harness.js:128-152`), mit
Zyklus- und Tiefenprüfung. Sauber gebaut.

Nur: **kein eingebauter Provider ruft es auf.** Der einzige Aufrufer im ganzen
Repository ist `src/plugins/worker-host.js:378`. Für `anthropic`,
`openai-compatible` und `github-copilot` ist `spawn` nicht erreichbar — es
steht in keiner Werkzeugliste.

Delegation passiert deshalb ausschließlich über `workflow.steps`. Das ist
legitim und sogar robuster, aber dann ist `subagents` im Manifest eine
Behauptung, die nicht eingelöst wird. Eines von beiden muss weg: entweder ein
`spawn_subagent`-Werkzeug, oder das Feld sagt, dass es nur für Plugins gilt.

Das ist vermutlich auch die Wurzel des Orchestrierungsproblems vom 24.09.:
„bei keinem Run würde der File angelegt, nur wenn explizit im Prompt stand,
dass nicht delegiert werden soll". Der Orchestrator *konnte* nicht delegieren;
er konnte nur davon reden.

### A-5 — Der Kontext wächst unbegrenzt

**Schwere: hoch. Der Run stirbt am Provider, nicht an einer eigenen Grenze.**

Die Tool-Schleife hängt an: `messages.push` in `anthropic.js:96,110` und
`openai-compatible.js:108,114`, bis zu zwölf Iterationen, jede mit dem vollen
Werkzeugergebnis. Nichts kürzt, nichts fasst zusammen.

Dazu `composeAgentInput` (`src/runtime/project-runner.js:769`):

```js
return `### ${id}\n${JSON.stringify(payload, null, 2)}`;
```

Das komplette Ergebnis jedes Vorgänger-Schritts, als eingerücktes JSON, in den
Prompt des nächsten. Bei vier Schritten mit je einer langen Antwort ist das
Kontextfenster weg, und der Fehler kommt als 400 vom Provider — also als etwas,
das aussieht wie ein Provider-Problem.

Claude Code komprimiert den Verlauf, wenn er zu lang wird. Hier gibt es dafür
nicht einmal eine Messung.

### A-6 — MCP gibt es nur für Copilot, und nur einen Server

**Schwere: mittel.**

`src/runtime/project-runner.js:184` übergibt genau einen, fest verdrahteten
Server (`codegraph`) an genau einen Provider. `register.js:11` reicht
`mcpServers` nur an die Copilot-Fabrik weiter. Ein Projekt kann keinen eigenen
MCP-Server konfigurieren, und mit `anthropic` oder `openai` gibt es gar keinen.

Das ist der größte Funktionsunterschied zu Claude Code, der sich mit
vertretbarem Aufwand schließen lässt: MCP ist ein offenes Protokoll, und ein
Client dafür ist keine Provider-Eigenschaft, sondern eine Harness-Eigenschaft.

### A-7 — Kein Netz-Werkzeug, aber eine Policy dafür

**Schwere: mittel. Wieder tote Konfiguration.**

`.etnpilot/etnpilot.yaml` hat die Regel `approved-network-targets` mit
`kinds: [network]` und einer Host-Liste. Kein eingebautes Werkzeug fordert je
`kind: "network"` an — der einzige Treffer im Quelltext ist
`src/plugins/worker-host.js:429`. Ein Agent kann keine Dokumentation abrufen,
keine API-Referenz nachschlagen, nichts.

### A-8 — Nur `approve-once`

**Schwere: mittel, praktisch groß.**

Die einzige zustimmende Entscheidung im ganzen System ist `approve-once`
(`src/core/approval-inbox.js:182`, `approval-policy.js:27`,
`terminal-approval.js:24`). Eine Änderung über zwölf Dateien sind zwölf
Rückfragen, jedes Mal.

Das ist der Grund, warum solche Werkzeuge in der Praxis auf
„alles erlauben" gestellt werden — und dann schützt die Policy nichts mehr.
Claude Code löst es mit Modi (`acceptEdits`) und gemerkten Mustern.

Hier ist der saubere Weg ein anderer: eine Entscheidung, die für **diesen Run**
und für **ein Muster** gilt, im Receipt festgehalten, mit Ablauf am Run-Ende.
Nicht ein globaler Schalter.

### A-9 — Kein Prompt-Caching, kein Streaming, kein Retry

**Schwere: mittel. Drei Dinge, ein Ort.**

- **Caching:** `anthropic.js:68-74` schickt `system` und `messages` ohne
  `cache_control`. Der System-Prompt und der wachsende Verlauf werden in jeder
  Iteration voll bezahlt. Bei zwölf Iterationen ist das der größte Einzelposten
  auf der Rechnung, die dieses Projekt selbst ausweist.
- **Streaming:** keine der beiden Adapter streamt. Eine lange Antwort kann in
  ein Request-Timeout laufen, und die Oberfläche kann nichts zeigen, solange
  gearbeitet wird.
- **Retry:** der Router fällt bei `retryable` auf den *nächsten* Provider
  (`router.js:89`). Ist nur einer konfiguriert — der Normalfall —, gibt es
  keinen nächsten, und ein 429 beendet den Run sofort. Kein Backoff, nirgends.

### A-10 — `page.js` ist 2.705 Zeilen in einem Template-Literal

**Schwere: mittel, wächst.**

Die Datei ist nach der Material-Design-Arbeit von 2.181 auf 2.705 Zeilen
gewachsen. Sie ist ein einziges Template-Literal, in dem nur
`${JSON.stringify(token)}` ein `${}` sein darf — jede andere Dollar-Klammer ist
ein stiller Fehler zur Laufzeit.

Der Verzicht auf einen Build-Schritt ist richtig und soll bleiben. Aber eine
Seite ohne Build-Schritt kann trotzdem aus mehreren Modulen bestehen, die
Strings zurückgeben und aneinandergehängt werden. `setup-page.js` zeigt, dass
das geht.

### A-11 — Budgets gibt es, und sie sind leer

**Schwere: niedrig, einfach zu beheben.**

Hier lag ich zuerst falsch: ich hatte „kein Ausgabenlimit" notiert. Es gibt
eines — `observability.budgets`, durchgesetzt in `router.js:126`, mit vier
Schlüsseln (`maxInputTokensPerWorkflow`, `maxOutputTokensPerWorkflow`,
`maxEstimatedCostPerWorkflow`, `maxProviderUnitsPerWorkflow`).

`src/config/init.js:176` schreibt `budgets: {}`. Jedes neue Projekt startet
also ohne Grenze. Ein Standardwert wäre billiger als die erste Rechnung, die
ihn lehrt.

---

## Teil A, zweiter Durchgang — alles um den Agenten herum

### A-12 — Die installierte App öffnet sich nicht *(mein Fehler, gemergt)*

**Schwere: hoch. Eine ausgelieferte Funktion, die nicht funktioniert.**

UI-3 hat die Seite installierbar gemacht. Das Manifest setzt
`start_url: "."` (`src/ui/app.js`). Ein Browser löst `start_url` gegen die URL
des **Manifests** auf, nicht gegen die Seite — also gegen
`/manifest.webmanifest`, und das ergibt `/`. Ohne Token. Nachgeprüft gegen den
laufenden Server:

```
an installed app launches: http://127.0.0.1:42051/
that URL answers: 401  Open the URL printed by etnpilot ui.
```

Der Kommentar in `app.js` begründet es falsch („the token travels in the URL
that was installed"). Die Tests haben geprüft, dass das Manifest ausgeliefert
wird und der Worker sich registriert — nie, dass die installierte App startet.
Genau die Lücke zwischen „ausgeliefert" und „funktioniert", die dieses Projekt
sonst überall schließt.

Dazu ein zweites Problem, das derselbe Fix lösen muss: das Token wird bei jedem
`etnpilot ui` neu erzeugt. Selbst mit richtiger `start_url` wäre die App nach
dem nächsten Neustart des Servers wieder ausgesperrt.

### A-13 — Jeder Agent bekommt jedes Werkzeug; der Reviewer darf schreiben

**Schwere: hoch. Least Privilege fehlt ganz.**

`requires:` im Agenten-Manifest ist eine **Untergrenze** — „der Provider muss
mindestens das können" (`src/providers/router.js:231-232`). Es schränkt nichts
ein. Die Werkzeuge hängen am Provider, nicht am Agenten:
`const workspaceTools = tools ? …` (`openai-compatible.js:53`,
`anthropic.js:48`), und nichts dort liest `context.agent`, außer für das Modell.

Folge: `reviewer` hat `requires: [chat]` und läuft über denselben
`openai`-Provider mit `tools: true` — er bekommt `write_file` und
`run_command`. Ein Reviewer, der den Code ändern kann, den er begutachtet, ist
kein Reviewer. Die menschliche Freigabe fängt es ab, aber der Mensch sieht dann
„reviewer möchte `src/x.js` schreiben" und muss selbst merken, dass das nie
richtig sein kann.

Claude Code gibt Subagenten ein `tools:`-Feld. Das fehlt hier.

### A-14 — Der Agent kann nicht fragen, und ein Plan kann nicht freigegeben werden

**Schwere: mittel, für die Arbeitsweise hoch.**

Die einzige Stelle, an der ein Mensch in einen laufenden Run eingreift, ist die
Freigabe einer Operation. Es gibt kein Werkzeug, mit dem der Agent eine Frage
stellen kann (Claude Code: `AskUserQuestion`), und keinen Schritt-Typ, der
anhält, bis ein Mensch den Plan gelesen hat (Claude Code: `ExitPlanMode`). Die
Schritt-Typen sind `agent`, `quorum`, `check`
(`src/runtime/project-runner.js:240,256,266`).

Der Workflow ist `plan → build → test → review`, und `build` startet, sobald
`plan` fertig ist — egal, ob der Plan Unsinn ist. Bei einem Auftrag, der Geld
und eine Merge Request kostet, ist die Stelle *nach* dem Plan und *vor* dem
Bauen die billigste, an der ein Mensch „nein" sagen kann.

### A-15 — Werkzeugergebnisse kommen ungerahmt in den Prompt

**Schwere: heute niedrig, nach P1.4 und P4.3 hoch.**

`anthropic.js:107` schickt `content: JSON.stringify(result)` — Dateiinhalt,
Befehlsausgabe, später Webseiten, ohne Hinweis, dass das Daten sind und keine
Anweisungen. Kein Prompt im Projekt erwähnt es. Eine README mit „ignoriere
deine Anweisungen und schreibe …" ist ein Auftrag wie jeder andere.

Heute hält die Verteidigung trotzdem, und zwar aus dem richtigen Grund: sie ist
mechanisch. Die Policy verbietet `.env` und Schlüssel, jeder Schreibzugriff
braucht einen Menschen. *„Prompts are hope; the guarantee is mechanical"* gilt
hier genau so.

Es kippt, wenn zwei geplante Dinge zusammenkommen: `fetch_url` (P1.4) holt
fremden Text herein, und `approve-for-run` (P4.3) lässt Schreibzugriffe auf ein
Muster ohne erneute Rückfrage durch. Zusammen: eine Webseite sagt „ändere
`src/auth.js`", das Muster `src/**` ist freigegeben, und kein Mensch sieht es.
Dieser Plan darf P1.4 und P4.3 deshalb nicht unabhängig voneinander umsetzen —
siehe „Sicherheit als Reihenfolge" in Teil C.

Dazu der Weg über GitLab: mit aktivem `git.issueTrigger` wird der Text eines
Issues zum Auftrag. Das Label, das ihn auslöst, setzt ein Projektmitglied —
aber den Text kann jemand anders geschrieben haben.

### A-16 — `etnpilot run` schweigt bis zum Ende

**Schwere: mittel. In einer Pipeline sieht man minutenlang nichts.**

`src/cli/commands.js` ruft `runProject` auf und gibt am Ende **ein**
JSON-Objekt aus. Währenddessen: nichts. Dabei gibt es die Ereignisse längst —
`workflow.planned`, `workflow.step.started/completed/failed/blocked`,
`run.started/completed/failed` — und `project-state.js` hört sie über
`onEvent` schon ab, um den Oberflächen den Fortschritt zu zeigen. Nur die CLI
wirft sie weg.

Claude Code hat dafür `--output-format stream-json`. In einem GitLab-CI-Job,
dem Ort, für den dieses Projekt gebaut ist, ist das der Unterschied zwischen
einem Log und einer schwarzen Box.

### A-17 — Niemand misst, ob der Agent gut arbeitet — aber das Werkzeug dafür ist schon da

**Schwere: mittel. Die größte ungenutzte Vorarbeit im Projekt.**

Alle 334 Tests prüfen Mechanik gegen Stub-Provider. Keiner misst, ob ein
Auftrag erledigt wird, wie viele Versuche es braucht und was es kostet.

Aber: `--record-fixtures` und `--fixtures` gibt es bereits
(`src/runtime/fixtures.js`, eingebunden in `project-runner.js:168-191`), mit
Schwärzung (`fixtures.redact`) und strengem Abspielen (`fixtures.strict`). Ein
Lauf gegen einen echten Provider lässt sich also einmal aufnehmen und danach
beliebig oft kostenlos und deterministisch abspielen. Das ist das Fundament
einer Evaluierung — es wird nur nicht als solches benutzt.

### A-18 — Hooks gibt es zur Hälfte

**Schwere: niedrig bis mittel.**

Plugins können mit `subscribe(type, listener)` (`src/plugins/sdk.js:113`) auf
neun Ereignisse hören. Aber die Ereignisse sind nur auf Run- und
Schritt-Ebene; es gibt kein Ereignis pro Werkzeugaufruf. Und ein Listener kann
nur zusehen, nicht eingreifen.

Das heißt: „nach jedem Schreibzugriff den Formatter laufen lassen" — der
häufigste Hook in Claude Code — geht nicht. Nur ein `check`-Schritt nach dem
ganzen `build`.

Was ich *nicht* übernehmen würde, sind blockierende Pre-Hooks. Die Rolle hat
hier die Policy, und zwei Stellen, die „nein" sagen können, ist eine mehr als
nötig.

### A-19 — Ein Run lernt nichts, und Auto-Memory wäre hier falsch

**Schwere: niedrig, aber eine Designfrage mit klarer Antwort.**

Jeder Run beginnt bei den Instruktionen. Hat der letzte Lauf herausgefunden,
dass `npm test` eine Umgebungsvariable braucht, weiß der nächste es nicht.

Claude Code schreibt in so einem Fall in eine Memory-Datei. Hier würde das
etwas kaputt machen, das wichtiger ist: `content.provenance` pinnt Prompts und
Instruktionen gegen einen committeten Lock. Ein Agent, der seine eigenen
Instruktionen ändert, ist genau der Fall, den dieser Lock verhindern soll.

Die Antwort, die zu diesem Projekt passt: Gelerntes wird als **Vorschlag**
festgehalten — eine Änderung an `.etnpilot/instructions/`, die in die Merge
Request des Laufs kommt, von einem Menschen gelesen und committet wird, und
dann erst im Lock steht. Memory mit Review statt Memory ohne.

### A-20 — Ein Poll liest bis zu zwanzig Receipts vollständig

**Schwere: mittel, auf dem Telefon mehr.**

`readRuns` (`src/runtime/project-state.js:301`) liest und parst bei jedem Poll
die letzten zwanzig Receipt-Dateien komplett — in der TUI jede Sekunde, auf der
Seite alle fünf. Ein Receipt eines 11-Sekunden-Laufs in diesem Repository ist
68 KB groß. Ein echter mehrstufiger Lauf mit Dateiinhalten in den
Werkzeugergebnissen ist ein Vielfaches davon.

Ein versiegeltes Receipt ändert sich nie. Ein Cache über Dateiname, Größe und
`mtime` macht den Poll praktisch kostenlos — und das Gerät, auf dem das am
meisten zählt, ist das, auf dem das Projekt tatsächlich läuft: ein Telefon.

Nebenbei: die Liste endet bei zwanzig. Ältere Läufe sind in keiner Oberfläche
erreichbar.

### A-21 — CI prüft nicht die Plattform, auf der das Projekt läuft

**Schwere: mittel.**

`.github/workflows/ci.yml` testet Node 22 und 24 auf `ubuntu-latest` (x64).
Der einzige echte Einsatz, der bisher dokumentiert ist, lief auf **Node 26,
Android/arm64** (`docs/first-real-run.md`). Genau diese Kombination prüft CI
nicht — und die fünf Fehler vom 23.09. waren alle plattformspezifisch.

### A-22 — Aufräumarbeit, die ich selbst hinterlassen habe

**Schwere: niedrig. Aber meine.**

- Zwei exportierte Funktionen namens `runCheck` mit verschiedenen Signaturen:
  `src/checks/runner.js:5` (führt einen Befehl aus, von `src/index.js`
  exportiert) und `src/runtime/project-checks.js:204` (führt eine
  Projektprüfung aus, von mir in UI-2.1 hinzugefügt). Wer beide braucht, muss
  umbenennen beim Import.
- `src/index.js` exportiert `runProject`, aber nicht `openProjectState` — den
  einen Lesepfad, auf dem alle vier Oberflächen stehen. Wer ETNPilot als
  Bibliothek benutzt (das Gegenstück zum Claude Agent SDK), kann einen Lauf
  starten, aber nicht sehen, was die Oberflächen sehen.

---

## Teil B — Claude Code ↔ ETNPilot

Was Claude Code kann, was ETNPilot davon hat, und was davon hierher gehört.
Die letzte Spalte ist eine Entscheidung, keine Bewertung: ETNPilot ist ein
anderes Werkzeug, und manches wäre hier falsch.

| Claude Code | ETNPilot heute | Urteil |
| --- | --- | --- |
| `Read` | `read_file` | ✅ da |
| `Write` | `write_file` | ✅ da |
| `Edit` (exakte Ersetzung) | — | **übernehmen** (A-2) |
| `Glob` | — | **übernehmen** (A-3) |
| `Grep` (ripgrep) | — | **übernehmen** (A-3) |
| `Bash` | `run_command` (argv, keine Shell) | ✅ da, bewusst strenger |
| Hintergrund-Prozesse (`run_in_background`) | — | später, braucht erst A-5 |
| `WebFetch` / `WebSearch` | — | **übernehmen, policy-gebunden** (A-7) |
| `Task` / Subagenten | `spawn` im Harness, für Provider unerreichbar | **verdrahten oder streichen** (A-4) |
| MCP-Client | nur Copilot, ein fester Server | **übernehmen** (A-6) |
| Skills | `.etnpilot/skills/*/SKILL.md`, statisch je Agent geladen | ✅ da, Nachladen später |
| Slash-Commands | — | **nein.** Ein Run ist nicht interaktiv |
| `CLAUDE.md` / Memory | `.etnpilot/instructions/*.md` | ✅ da, aber siehe P4 |
| Hooks | — | **prüfen.** `workflow.steps` deckt vieles ab |
| Permission-Modi | Policy + `approve-once` | **anpassen, nicht kopieren** (A-8) |
| Plan-Modus | `--dry-run`, `workflow` mit `plan`-Schritt | ✅ sinngemäß da |
| Kontext-Kompaktierung | — | **übernehmen** (A-5) |
| Prompt-Caching | — | **übernehmen** (A-9) |
| Streaming | — | **übernehmen** (A-9) |
| Adaptives Thinking | kein Feld dafür | **übernehmen** (P2) |
| Todo-Liste im Lauf | Workflow-Schritte im Receipt | ✅ besser gelöst, weil geprüft |
| Checkpoint / Rewind | Worktree + Receipt + `replay` | ✅ stärker gelöst |
| Statusline, Keybindings, Output-Styles | — | **nein.** Oberflächensache |
| Session fortsetzen | Queue mit `resume` | ✅ da |
| Kostenanzeige | Telemetrie, Preise, Budgets | ✅ stärker gelöst |
| Sandbox | `sandbox.enabled`, Container | ✅ da |

### Zweiter Durchgang: was der erste Abgleich nicht erfasst hat

| Claude Code | ETNPilot heute | Urteil |
| --- | --- | --- |
| Subagent mit eigenem `tools:` | Werkzeuge hängen am Provider, jeder Agent bekommt alle | **übernehmen** (A-13) |
| `AskUserQuestion` | — | **übernehmen, über die Inbox** (A-14) |
| `ExitPlanMode` (Plan freigeben) | — | **übernehmen, als Schritt-Typ** (A-14) |
| `-p --output-format stream-json` | ein JSON am Ende | **übernehmen** (A-16) |
| Claude Agent SDK | `src/index.js`, ohne `openProjectState` | **ergänzen** (A-22) |
| Hooks `PostToolUse` | Ereignisse nur auf Run-/Schritt-Ebene | **übernehmen, nur beobachtend** (A-18) |
| Hooks `PreToolUse` (blockierend) | Policy | **nein.** Die Policy ist diese Stelle |
| Auto-Memory | — | **anders:** als Vorschlag in der MR (A-19) |
| `--model` je Agent | `model:` im Manifest | ✅ da |
| Denk-Aufwand / Thinking je Aufgabe | nur `reasoningEffort` pro Provider | **übernehmen, je Agent** (P4.5) |
| `--max-turns` | `maxToolIterations` pro Provider | ✅ da, aber je Agent wäre richtiger |
| Bilder im Prompt (Screenshots) | nur Text | später. Kein Auftrag, der es heute braucht |
| `/review`, `/security-review` | `reviewer`-Agent im Workflow | ✅ sinngemäß da |
| GitHub-Action (`@claude` im Issue) | GitLab-Issue-Trigger, Webhook | ✅ da, für GitLab |
| Hintergrund-Aufgaben mit Monitor | Queue mit Lease und Worker | ✅ stärker gelöst |
| `NotebookEdit` | — | **nein.** Kein Bedarf erkennbar |
| Evals / Qualitätsmessung | Fixture-Aufnahme und -Wiedergabe, unbenutzt dafür | **aufbauen** (A-17, P6) |

**Die Zusammenfassung in einem Satz:** ETNPilot ist beim *Beweisen* deutlich
stärker als Claude Code und beim *Arbeiten* deutlich schwächer. Die Lücken
liegen fast alle in der Werkzeugkiste des Agenten, nicht im Gerüst darum.

Der zweite Durchgang ergänzt einen Satz dazu: **wo ETNPilot eine Lücke
schließt, darf es das nicht auf Claude Codes Art tun, wenn diese Art einen
Menschen voraussetzt, der danebensitzt.** Auto-Memory, blockierende Hooks und
„alles erlauben" funktionieren dort, weil jemand zusieht. Hier ist der Mensch
derjenige, der hinterher unterschreibt — also muss jede übernommene Funktion
durch eine Freigabe, ein Receipt oder einen Commit gehen.

### B-7 — Was ich beim Nachsehen zurücknehmen musste

Ich hatte „kein Ausgabenlimit" auf der Liste. Es gibt eines (A-11). Der
Unterschied zwischen „fehlt" und „ist da, aber standardmäßig leer" ist genau
der Unterschied zwischen einem Feature-Auftrag und einer Zeile in
`init.js` — und er wäre mir ohne Nachsehen durchgegangen.

---

## Teil C — Der Plan

Sieben Phasen. Jede ist für sich mergefähig, jede hat ein „Fertig wenn", und die
Reihenfolge ist nach Nutzen pro Risiko sortiert, nicht nach Bequemlichkeit.
P0 kommt vor allem anderen, weil es Ausgeliefertes repariert.

### P0 — Reparieren, was ausgeliefert und kaputt ist

**P0.1 Die installierte App startet** (A-12). Der Server setzt beim ersten
Aufruf mit gültigem Token ein Sitzungs-Cookie (`HttpOnly`, `SameSite=Strict`,
nur für diesen Host), und `/` sowie die lesenden `/api/`-Routen akzeptieren es.
Für mutierende Aufrufe bleibt der eigene Header Pflicht — das ist der
CSRF-Schutz, und ein Cookie allein darf ihn nicht ersetzen. Dazu ein stabiles
Token pro Rechner in einer lokalen Datei (nie committet, wie
`etnpilot.local.yaml`), damit ein Neustart die App nicht aussperrt; mit
`--rotate-token` wird es bewusst erneuert.
*Fertig wenn:* ein Test die `start_url` aus dem Manifest gegen die
Manifest-URL auflöst, sie mit dem Cookie aufruft und 200 bekommt — also genau
den Schritt geht, den der erste Test ausgelassen hat —, ein POST ohne Header
trotz Cookie abgelehnt wird, und der Kommentar in `app.js` die richtige
Begründung trägt.

**P0.2 Die eigene Aufräumarbeit** (A-22). `runCheck` in
`project-checks.js` heißt `runProjectCheck`; `openProjectState` wird exportiert.
*Fertig wenn:* es im Repository genau eine exportierte `runCheck` gibt.

### P1 — Der Agent kann arbeiten *(größter Effekt, kleinstes Risiko)*

**P1.1 `edit_file`** — exakte Ersetzung statt Ganzdatei-Schreiben.
`old_string` / `new_string` / optional `replace_all`; ist `old_string` nicht
genau einmal enthalten, schlägt es fehl und sagt, wie oft es gefunden wurde.
Geht durch denselben Approval-Pfad wie `write_file`, mit `kind: "write"`.
*Fertig wenn:* ein Test eine Zeile in einer Datei ändert, der Rest der Datei
byteweise identisch bleibt, und eine mehrdeutige Ersetzung abgelehnt wird.

**P1.2 Der Approval zeigt den Diff** (A-1). `write_file` und `edit_file`
schicken einen unified diff gegen den Stand auf der Platte, gekürzt an der
bestehenden Anzeigegrenze, mit derselben `truncated`-Markierung, die die
Oberflächen schon kennen. Bei einer neuen Datei: der Inhalt als reiner Zusatz.
*Fertig wenn:* der Diff in allen vier Oberflächen erscheint und der Test einen
Backdoor-artigen Einzeiler im Approval-Text wiederfindet.

**P1.3 `search_files`** (A-3) — ein Werkzeug, zwei Betriebsarten: Glob für
Namen, Regex für Inhalt, beide auf die getrackten Dateien beschränkt, Ergebnis
als Pfad/Zeile/Treffer mit hartem Limit. `kind: "read"`, also von der Policy
gedeckt. Ohne `rg` als Abhängigkeit — `git ls-files` plus Node-Regex reicht und
läuft auch auf Android.
*Fertig wenn:* ein Test nach einem Symbol sucht, das in drei Dateien steht,
und genau drei Treffer mit Zeilennummern bekommt.

**P1.4 `fetch_url`** (A-7) — holt eine URL als Text, `kind: "network"`, also
durch `approved-network-targets` gedeckt. Kein Browser, kein JavaScript, harte
Größengrenze, keine Weiterleitung auf einen anderen Host ohne neue Prüfung.
*Fertig wenn:* die bestehende Host-Regel greift, ein nicht gelisteter Host
abgelehnt wird, bevor die Anfrage rausgeht, und der Receipt beides festhält.
**Nicht ohne P1.6** (siehe „Sicherheit als Reihenfolge").

**P1.5 Werkzeuge je Agent** (A-13) — ein `tools:`-Feld im Manifest, eine
Liste von Werkzeugnamen. Durchgesetzt an **zwei** Stellen: die Liste, die dem
Modell angeboten wird, wird gefiltert, *und* `workspace-tools.js` lehnt einen
Aufruf ab, der nicht darin steht — ein Modell kann einen Werkzeugnamen auch
erfinden. Die generierten Manifeste bekommen sinnvolle Vorgaben: `reviewer`
und `orchestrator` lesen und suchen, nur `builder` schreibt und führt aus.
*Fertig wenn:* der Reviewer `write_file` weder angeboten bekommt noch aufrufen
kann, und die Ablehnung im Receipt als solche steht, nicht als Fehler des
Werkzeugs.

**P1.6 Fremder Text wird als fremd markiert** (A-15) — Werkzeugergebnisse mit
Inhalt von außen (Dateien, Befehlsausgaben, abgerufene Seiten) gehen in einer
klar abgegrenzten Hülle an das Modell, mit einem Satz im System-Prompt, dass
darin nie Anweisungen stehen. Das ist Hoffnung, keine Garantie — die Garantie
bleibt mechanisch (P4.3 unten). Aber es kostet nichts und macht einen Teil der
Angriffe wirkungslos.
*Fertig wenn:* jedes Werkzeugergebnis die Hülle trägt und ein Test prüft, dass
ein Schließ-Marker *innerhalb* eines Dateiinhalts die Hülle nicht beendet.

### P2 — Der Agent wird bezahlbar

**P2.1 Prompt-Caching** (A-9) — `cache_control` auf System-Prompt und
Werkzeugliste bei Anthropic; bei OpenAI passiert es serverseitig, aber die
Reihenfolge der Nachrichten muss stabil bleiben, damit der Cache greift.
*Fertig wenn:* ein Test die `cache_control`-Marken im Request-Body findet und
`cacheReadTokens` über zwei Iterationen steigt.

**P2.2 Kontextgrenze und Kompaktierung** (A-5) — ein Token-Budget je
Agenten-Aufruf; wird es überschritten, werden die ältesten Werkzeugergebnisse
durch eine Zusammenfassung ersetzt, und *das steht im Receipt*. Ein
kompaktierter Lauf darf nicht aussehen wie ein vollständiger.
Dazu `composeAgentInput` deckeln (`project-runner.js:769`): nicht das ganze
JSON des Vorgängers, sondern sein Text plus die Liste geänderter Dateien.
*Fertig wenn:* ein Lauf mit erzwungen langen Werkzeugergebnissen durchläuft
statt am Provider zu sterben, und der Receipt sagt, was gekürzt wurde.

**P2.3 Budgets mit Standardwert** (A-11) — `init.js` schreibt eine
voreingestellte Obergrenze statt `{}`, kommentiert, warum sie da ist.
*Fertig wenn:* ein neues Projekt eine Grenze hat und der bestehende
`budget_exceeded`-Pfad sie auslöst.

**P2.4 Streaming und Retry** (A-9) — beide Adapter streamen; ein `429` oder
`5xx` wird mit Backoff wiederholt, bevor der Router auf einen anderen Provider
ausweicht, und jeder Versuch steht im Receipt.
*Fertig wenn:* ein Stub-Provider zweimal 429 liefert und der dritte Versuch
durchgeht, mit drei Versuchen im Receipt.

**P2.5 Fortschritt für Pipelines** (A-16) — `etnpilot run --events jsonl`
schreibt jedes Ereignis, das `runProject` ohnehin schon aussendet, als eine
Zeile auf stdout, und das Ergebnis als letzte. Ohne den Schalter bleibt die
Ausgabe, wie sie ist, damit bestehende Skripte nicht brechen.
*Fertig wenn:* ein Lauf in einem Test mindestens `workflow.planned`, je Schritt
`started` und `completed` und ein Endergebnis als getrennte JSON-Zeilen
liefert, jede für sich parsebar.

**P2.6 Der Poll kostet nichts** (A-20) — `readRuns` hält versiegelte Receipts
im Speicher, geschlüsselt nach Dateiname, Größe und `mtime`; nur ein Receipt,
das sich geändert hat oder noch nicht versiegelt ist, wird neu gelesen. Dazu
Blättern jenseits der zwanzig.
*Fertig wenn:* ein Test zeigt, dass der zweite Poll ein unverändertes,
versiegeltes Receipt nicht noch einmal liest, und ein Receipt, an das
angehängt wurde, sehr wohl.

### P3 — Der Agent kann delegieren, und zwar wirklich

**P3.1 Die Entscheidung zu A-4 fällen und einlösen.** Zwei Wege:

- *(a)* Ein `spawn_subagent`-Werkzeug, das `context.spawn` freilegt. Die
  Prüfungen im Harness sind schon da. Damit wird `subagents:` echt.
- *(b)* `subagents:` streichen und Delegation ausschließlich über
  `workflow.steps` führen — dann muss das Feld raus, aus dem Schema und aus den
  generierten Manifesten.

**Empfehlung: (a).** Der Harness kann es bereits, die Prüfungen sind geschrieben
und getestet, und `workflow.steps` kann nicht auf etwas reagieren, das erst
während des Laufs sichtbar wird. Aber die Kosten gehören dazu: ein Subagent ist
ein zweites Kontextfenster und eine zweite Rechnung, also braucht P3 das Budget
aus P2.3 zwingend.
*Fertig wenn:* der Orchestrator den Builder aufruft, beide im Agenten-Baum der
Oberflächen erscheinen — der schon gebaut ist und heute nur eine Ebene zeigt —
und ein Zyklus abgelehnt wird.

**P3.2 MCP für alle Provider** (A-6) — ein MCP-Client im Harness statt im
Copilot-Adapter, konfiguriert unter `mcpServers:`, dessen Werkzeuge in dieselbe
Approval- und Policy-Kette gehen wie die eingebauten. Ein MCP-Werkzeug ist
fremder Code: es braucht eine eigene Policy-Art, keine Ausnahme.
*Fertig wenn:* ein Testserver über stdio eingebunden ist, sein Werkzeug einen
Approval auslöst, und `codegraph` über denselben Weg läuft wie bisher fest
verdrahtet.

**P3.3 Den Plan freigeben, bevor gebaut wird** (A-14) — ein Schritt-Typ
`gate`: der Workflow hält an, das Ergebnis des vorigen Schritts geht als
Freigabe der Art `plan` in dieselbe Inbox wie jede andere, und die folgenden
Schritte laufen erst nach „ja". „Nein" mit Begründung beendet den Lauf, und die
Begründung steht im Receipt. Das ist `ExitPlanMode`, nur mechanisch und
nachweisbar. Der generierte Workflow bekommt ihn zwischen `plan` und `build`.
*Fertig wenn:* `build` in einem Test nicht startet, bevor die Freigabe
entschieden ist, ein abgelehnter Plan den Lauf mit dem Grund beendet, und alle
vier Oberflächen die Plan-Freigabe mit dem vollständigen Plantext zeigen.

**P3.4 Der Agent kann fragen** (A-14) — ein Werkzeug `ask_human` mit einer
Frage und optional Antwortmöglichkeiten; die Frage geht in die Inbox, die
Antwort als Text zurück an das Modell und in das Receipt. Mit Zeitlimit — ein
Run, der auf eine Antwort wartet, die nie kommt, endet mit genau diesem Grund,
nicht mit einem Timeout ohne Erklärung.
*Fertig wenn:* ein Stub-Agent eine Frage stellt, die Antwort aus der Inbox im
nächsten Modellaufruf steht, und Frage und Antwort im Receipt nachzulesen sind.

### P4 — Was der Agent weiß

**P4.1 Instruktionen wie `CLAUDE.md`.** Heute lädt
`.etnpilot/instructions/*.md` pauschal für alle Agenten. Sinnvoll wäre, was
Claude Code macht: verzeichnisbezogene Instruktionen, die gelten, wenn der Run
dort arbeitet.
*Fertig wenn:* eine Instruktion in einem Unterverzeichnis nur dann im
System-Prompt steht, wenn der Schritt Dateien darunter anfasst.

**P4.2 Skills nachladen.** Heute werden alle Skills eines Agenten immer
mitgeschickt. Bei drei kurzen Dateien ist das egal; bei dreißig nicht.
Ein Werkzeug `load_skill`, das den Volltext auf Verlangen holt, und im
System-Prompt nur Name und Einzeiler.
*Fertig wenn:* der System-Prompt kürzer wird und ein Test zeigt, dass der
Volltext erst nach dem Aufruf im Verlauf steht.

**P4.3 Approval mit Reichweite** (A-8) — `approve-for-run` zusätzlich zu
`approve-once`: gilt für diesen Run und ein Muster (Pfad-Glob oder
Kommando-Präfix), läuft mit dem Run ab, steht mit Muster und Geltungsbereich im
Receipt. Kein globaler „alles erlauben"-Schalter, und `policy.**` bleibt
`stricter-only`, also kann nichts davon die Policy aufweichen.
*Fertig wenn:* zwölf Schreibzugriffe unter `src/**` eine Rückfrage auslösen
statt zwölf, ein Zugriff außerhalb des Musters wieder fragt, und der Receipt
die Reichweite jeder Entscheidung nennt.
**Nicht ohne die Taint-Regel** (siehe „Sicherheit als Reihenfolge").

**P4.4 Gelerntes als Vorschlag** (A-19) — ein Werkzeug `propose_instruction`,
mit dem ein Agent eine Änderung an `.etnpilot/instructions/` vorschlägt. Sie
wird nicht angewendet, sondern als eigener Commit in die Merge Request des
Laufs gelegt, klar als Vorschlag markiert. Ein Mensch liest ihn, merged ihn,
und erst dann steht er im Content-Lock.
*Fertig wenn:* ein Vorschlag in der MR erscheint, der laufende Run seine
Instruktionen nachweislich *nicht* geändert hat, und `content verify` bis zum
Merge unverändert grün bleibt.

**P4.5 Denk-Aufwand je Agent** — ein Feld `effort:` im Manifest (`low`,
`medium`, `high`), je Provider übersetzt: `reasoning_effort` bei OpenAI,
adaptives Thinking bei Anthropic. Planer und Reviewer profitieren davon, der
Builder oft nicht. Die bestehende Provider-Einstellung `reasoningEffort` bleibt
die Vorgabe, das Agentenfeld überschreibt sie.
*Fertig wenn:* derselbe Provider für zwei Agenten zwei verschiedene
Request-Bodies schickt und beide im Receipt stehen.

**P4.6 Beobachtende Hooks** (A-18) — ein Ereignis `tool.completed` je
Werkzeugaufruf, für Plugins abonnierbar, und in der Konfiguration ein
`afterWrite:`-Befehl (etwa ein Formatter), der nach jedem Schreibzugriff läuft,
durch dieselbe Policy wie jeder `run_command`. Keine blockierenden Hooks — das
bleibt die Aufgabe der Policy.
*Fertig wenn:* ein Formatter nach jedem Schreibzugriff läuft, sein Ergebnis im
Receipt steht, und ein Plugin `tool.completed` empfängt.

### P5 — Aufräumen

**P5.1 `page.js` teilen** (A-10) — nach Ansicht in Module, die Strings
zurückgeben; kein Build-Schritt, keine Abhängigkeit. Der bestehende
Parse-Check über `new Function(script)` bleibt der Wächter.
*Fertig wenn:* keine Datei über 800 Zeilen und alle UI-Tests unverändert grün.

**P5.2 Die tote Konfiguration entfernen oder einlösen** — nach P1.4 und P3.1
ist `approved-network-targets` echt und `subagents:` echt. Was dann noch nichts
tut, kommt raus. Ein Schema-Test, der Felder verbietet, die kein Code liest,
wäre der dauerhafte Wächter — dieselbe Idee wie `test/parity.test.js`.

### P6 — Messen, ob der Agent gut ist

Der erste Durchgang endete mit „nicht geprüft: ob der Agent gut arbeitet".
Diese Phase macht daraus eine Zahl.

**P6.1 Eine Evaluierung auf den vorhandenen Fixtures** (A-17) — ein Satz
kleiner Aufträge in `test/evals/`, jeder mit einem mechanischen Urteil:
„Datei X existiert und enthält Y", „`npm test` ist grün", „nichts außerhalb
von `src/` wurde angefasst". Jeder Auftrag wird **einmal** gegen einen echten
Provider aufgenommen (`--record-fixtures`, geschwärzt, bezahlt, von Hand
gestartet) und danach in CI **kostenlos** abgespielt (`--fixtures`, streng).
Der erste echte Durchlauf aus `docs/first-real-run.md` wird so zur ersten
Aufnahme.
*Fertig wenn:* `npm run eval` die Aufträge abspielt und je Auftrag Erfolg,
Werkzeugaufrufe, Tokens und Kosten als Tabelle ausgibt — und ein Auftrag, der
nach einer Änderung an einem Prompt nicht mehr erfüllt wird, CI rot macht.

**P6.2 Vorher/nachher für jede Phase** — jede der Phasen P1 bis P4 behauptet,
etwas besser zu machen: billiger (P2.1), weniger Rückfragen (P4.3), weniger
Fehlversuche (P1.1). Mit P6.1 lässt sich das messen statt behaupten. Jede
Phase nimmt ihre Aufträge neu auf und schreibt die Zahlen in ihren Commit.
*Fertig wenn:* die Commit-Nachricht von P2.1 die Kosten desselben Auftrags vor
und nach dem Caching nennt.

**P6.3 CI auf der Plattform, auf der das Projekt läuft** (A-21) — Node 26 in
die Matrix, und ein Lauf auf arm64 (`ubuntu-24.04-arm`). Android selbst lässt
sich in CI nicht vernünftig abbilden; arm64 mit Node 26 fängt den Großteil
dessen, was am 23.09. gebrochen ist.
*Fertig wenn:* die Matrix Node 22, 24 und 26 auf x64 und Node 26 auf arm64
enthält und grün ist.

---

## Sicherheit als Reihenfolge

Drei der Vorschläge sind einzeln harmlos und zusammen ein Loch (A-15):

- `fetch_url` (P1.4) holt Text herein, den niemand im Projekt geschrieben hat.
- `approve-for-run` (P4.3) lässt Schreibzugriffe auf ein Muster ohne neue
  Rückfrage durch.
- `ask_human` (P3.4) erlaubt einem Agenten, einen Menschen zu etwas zu
  überreden, statt ihn zu fragen.

Deshalb gelten drei Regeln, und sie sind Teil des „Fertig wenn" der jeweiligen
Phase, nicht Empfehlungen daneben:

1. **P1.4 nicht vor P1.6.** Kein Werkzeug holt fremden Text, bevor fremder Text
   gerahmt ist.
2. **Taint-Regel für P4.3.** Hat ein Lauf mit `fetch_url` Text von außen
   geholt, fallen alle `approve-for-run`-Freigaben dieses Laufs ab diesem
   Moment auf `approve-once` zurück — jeder weitere Schreibzugriff zeigt wieder
   seinen Diff und fragt. Das Receipt hält fest, wann und warum. Das ist die
   mechanische Garantie hinter der Hoffnung aus P1.6.
3. **`ask_human` zeigt, wer fragt.** Jede Frage nennt in allen Oberflächen den
   Agenten, den Schritt und den Lauf, und sie kann keine Freigabe *sein* — eine
   Antwort auf eine Frage gibt nie eine Operation frei.

---

## Was ich bewusst nicht vorschlage

- **Slash-Commands, Statusline, Output-Styles, Keybindings.** Das sind
  Eigenschaften einer interaktiven Sitzung. Ein ETNPilot-Run ist ein Auftrag
  mit einem Receipt, kein Gespräch.
- **Ein Permission-Modus „alles erlauben".** Claude Code hat ihn, weil ein
  Mensch danebensitzt. Hier ist der Mensch die Instanz, die den Beweis
  unterschreibt; ein Schalter, der ihn überspringt, macht das Receipt wertlos.
  P4.3 ist die Antwort darauf, die die Aussage nicht bricht.
- **Ein eigener Agent-Loop pro Provider.** Die Versuchung bei P1 ist groß, die
  Werkzeuge im Adapter zu bauen. Sie gehören in `workspace-tools.js`, einmal,
  für alle — sonst gibt es wieder zwei Wahrheiten.
- **Feature-Parität als Ziel an sich.** Claude Code ist ein Assistent für einen
  Menschen am Terminal. ETNPilot ist ein Auftragnehmer, der hinterher beweisen
  muss, was er getan hat. Die Werkzeuge sollen gleichziehen; die Kontrolle
  darüber nicht.
- **Auto-Memory.** Ein Agent, der seine eigenen Instruktionen umschreibt, ist
  genau der Fall, den `content.provenance` verhindern soll. P4.4 ist die
  Fassung davon, die durch einen Menschen und den Lock geht.
- **Blockierende Pre-Hooks.** Die Stelle, die „nein" sagt, ist die Policy. Eine
  zweite, frei programmierbare daneben würde Entscheidungen erzeugen, die kein
  Receipt erklärt.
- **Eigene Evaluierungs-Infrastruktur.** P6 baut auf `--record-fixtures` auf,
  das schon existiert und schon schwärzt. Ein zweites System dafür wäre die
  zweite Wahrheit, die dieses Projekt überall sonst vermeidet.

---

## Reihenfolge, kurz

0. **P0** — reparieren, was ausgeliefert und kaputt ist: die installierte App
   startet nicht (A-12). Klein, und vor allem anderen, weil es meins ist und
   gemergt.
1. **P1** — der Agent kann suchen, gezielt ändern, man sieht, was man
   genehmigt, und der Reviewer kann nichts mehr schreiben. Größter Gewinn,
   kleinstes Risiko.
2. **P2** — er wird bezahlbar, stirbt nicht mehr am Kontextfenster, und eine
   Pipeline sieht, was er tut.
3. **P6.1** — *vorgezogen, bevor P3 beginnt.* Ab hier behauptet jede Phase,
   etwas besser zu machen, und das sollte eine Zahl sein.
4. **P3** — er darf delegieren, mit Budget dahinter, und ein Mensch gibt den
   Plan frei, bevor gebaut wird.
5. **P4** — er weiß, was gilt, fragt nicht zwölfmal dasselbe, und schlägt vor,
   was er gelernt hat.
6. **P5, P6.2, P6.3** — das Aufgeräumte bleibt aufgeräumt, und CI prüft die
   Plattform, auf der das Projekt wirklich läuft.

P1 und P2 zusammen sind der Unterschied zwischen „läuft" und „brauchbar".
P6.1 ist der Unterschied zwischen „wir glauben, es ist besser" und „es ist
besser". Alles darüber ist Ausbau.
