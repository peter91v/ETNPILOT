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

**Die Zusammenfassung in einem Satz:** ETNPilot ist beim *Beweisen* deutlich
stärker als Claude Code und beim *Arbeiten* deutlich schwächer. Die Lücken
liegen fast alle in der Werkzeugkiste des Agenten, nicht im Gerüst darum.

### B-7 — Was ich beim Nachsehen zurücknehmen musste

Ich hatte „kein Ausgabenlimit" auf der Liste. Es gibt eines (A-11). Der
Unterschied zwischen „fehlt" und „ist da, aber standardmäßig leer" ist genau
der Unterschied zwischen einem Feature-Auftrag und einer Zeile in
`init.js` — und er wäre mir ohne Nachsehen durchgegangen.

---

## Teil C — Der Plan

Fünf Phasen. Jede ist für sich mergefähig, jede hat ein „Fertig wenn", und die
Reihenfolge ist nach Nutzen pro Risiko sortiert, nicht nach Bequemlichkeit.

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

### P5 — Aufräumen

**P5.1 `page.js` teilen** (A-10) — nach Ansicht in Module, die Strings
zurückgeben; kein Build-Schritt, keine Abhängigkeit. Der bestehende
Parse-Check über `new Function(script)` bleibt der Wächter.
*Fertig wenn:* keine Datei über 800 Zeilen und alle UI-Tests unverändert grün.

**P5.2 Die tote Konfiguration entfernen oder einlösen** — nach P1.4 und P3.1
ist `approved-network-targets` echt und `subagents:` echt. Was dann noch nichts
tut, kommt raus. Ein Schema-Test, der Felder verbietet, die kein Code liest,
wäre der dauerhafte Wächter — dieselbe Idee wie `test/parity.test.js`.

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

---

## Reihenfolge, kurz

1. **P1** — der Agent kann suchen, gezielt ändern und man sieht, was man
   genehmigt. Größter Gewinn, kleinstes Risiko.
2. **P2** — er wird bezahlbar und stirbt nicht mehr am Kontextfenster.
3. **P3** — er darf delegieren, mit Budget dahinter.
4. **P4** — er weiß, was gilt, und fragt nicht zwölfmal dasselbe.
5. **P5** — das Aufgeräumte bleibt aufgeräumt.

P1 und P2 zusammen sind der Unterschied zwischen „läuft" und „brauchbar".
Alles darüber ist Ausbau.
