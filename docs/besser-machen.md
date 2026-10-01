# Was könnten wir noch besser machen

Zweite, gründlichere Runde nach [der ersten Prüfung](review-2026-10.md), nachdem deren Punkte umgesetzt
waren. Diesmal wurde gemessen statt nur gelesen: Abdeckung, Komplexität, Startzeit, Größe, ungenutzter Code,
Abhängigkeiten, dazu Experimente an den Stellen, die Sicherheit behaupten.

**Grenzen:** Es ist weiter kein Zeile-für-Zeile-Audit aller 144 Quelldateien. Nicht geprüft: die
Kryptografie jenseits der Receipt-Signatur, `src/codegraph/*`, die Plugin-Worker-Schnittstelle im Einzelnen,
GitLab-Webhook-Server im Betrieb. Vor allem: **nichts davon lief gegen die echten Dienste** außer dem, was
`etnpilot smoke` auf dem Handy gezeigt hat (OpenAI: alle Schritte grün).

## Messwerte

| Was | Wert |
|---|---|
| Quelldateien / Zeilen (JS, CSS, HTML) | 144 / rund 30 400 |
| Testdateien / Tests / Laufzeit | 109 / rund 650 / 46 s, dazu 5 Browser-Tests |
| Abdeckung (Zeilen / Verzweigungen / Funktionen) | 95,1 % / 83,7 % / 91,6 % |
| Am schwächsten abgedeckt | `cli/commands/servers.js` 27 %, `plugins/sdk.js` 30 %, `cli/commands/usage.js` 39 %, `cli/commands/agents.js` 53 % |
| Start (`etnpilot --help`) | 0,18 s; Laden des Modulgraphen 0,17 s |
| `node_modules` | 351 MB, davon 282 MB das CodeGraph-Binärpaket für die Plattform |
| Bekannte Schwachstellen (`npm audit`) | 0 |
| Funktionen über Komplexität 30 | 30 |
| Ungenutzte Exporte | 0 (vier entfernt) |
| Globale `let`-Variablen im Seitenskript | 53 |

## Was ich in dieser Runde zusätzlich gefunden und behoben habe

- Receipts: jeder Eintrag las die ganze Datei neu (1 600 Einträge = 10 s; ab 16 MiB brach der Lauf ab).
- Plugin-Worker: Netzwerkzugriff trotz Sperre über den globalen HTTP-Dispatcher (belegt, geschlossen, Test).
- Zwei doppelte Objektschlüssel, eine doppelte Option, vier tote Exporte, Aufräumfehler, die den eigentlichen
  Fehler überdeckten.
- Eine unsichtbare Seite fragte weiter alle 5 s nach.

---

## A. Das Wichtigste zuerst

### A1. Live-Wahrheit statt Attrappen (Aufwand: klein, Wirkung: groß)

Die Testsuite sagt, dass ETNPilot tut, was ETNPilot erwartet. Ob die Dienste es auch so sehen, sagt nur der
Kontakt mit ihnen. Stand: OpenAI läuft (Smoke 5/5 am 2026-10-01, 6. Schritt noch nicht gesehen). **Ungeprüft:**
Anthropic, GitLab-Veröffentlichung, die Device-Flows von GitHub und GitLab, ob ein GitHub-Token für
`github-models` reicht, ob der Copilot-Provider ein Device-Flow-Token akzeptiert.

- `etnpilot smoke --provider anthropic` und `--gitlab` einmal laufen lassen und in
  `docs/first-real-run.md` eintragen (die Tabelle dort führt GitLab noch als offen).
- **Aufnehmen statt nachbauen:** `--record-fixtures` gibt es schon. Echte Antworten von OpenAI/Anthropic
  (Chat, Responses, Streaming, Fehler 400/401/429) aufnehmen, bereinigen, ins Repo legen und die Adapter
  dagegen testen. Dann fängt die CI Formatänderungen der Anbieter, ohne einen Schlüssel zu brauchen.
- Der Live-Workflow (`.github/workflows/live.yml`) ist angelegt; er braucht die Schlüssel als Repository-Secrets.

### A2. `executeProject` zerlegen (Aufwand: mittel–groß, Risiko: mittel)

`src/runtime/project-runner.js`: **448 Zeilen, Komplexität 124** in einer Funktion. Das Herz des Programms,
und dort sitzt die Geschichte der Fehler: ein Kommentar (Zeile ~449) erzählt, dass die MCP-Server nur bei
fehlgeschlagenen Läufen geschlossen wurden und bei erfolgreichen liefen, bis ein Prozess hing. So etwas entsteht in
langen Funktionen mit vielen Austrittspfaden. Vorschlag: Phasen als Funktionen mit einem gemeinsamen
`RunContext`-Objekt und einem einzigen `finally`, das die Ressourcen schließt: `prepare` (Konfiguration,
Geheimnisse, Inhalt prüfen) → `provision` (Worktree, MCP, Telemetrie) → `execute` (Workflow) → `seal`
(Receipt, Rehearsal) → `publish` → `cleanup`. Vorher: Charakterisierungstests, die das Verhalten an den
Austrittspfaden festhalten (Erfolg, Fehler vor/nach dem Worktree, Abbruch, Veröffentlichung scheitert).

Gleiche Familie, in der Reihenfolge der Dringlichkeit: `createTuiApp` (728 Zeilen, `handle` mit Komplexität
100 → eine Tabelle Taste→Aktion je Ansicht), `openProjectState` (299 Zeilen → ein Modul je Themenkreis:
Läufe, Chat, Inhalt), `updateAgent` (56), `describeOutcome` (54), `invokeChat` (46),
`summarizeTelemetryFile` (45).

### A3. Receipts: Grenzen, die einen langen Lauf unprüfbar machen (Aufwand: mittel)

- Lesen und Prüfen erlauben höchstens **16 MiB** (`readRegularFile(…, 16 * 1024 * 1024)` in
  `receipt-store.js` und `project-state`). Ein Lauf mit großen Tool-Ausgaben erreicht das; dann lässt sich
  das Receipt weder prüfen noch anzeigen. Vorschlag: zeilenweise lesen (Stream), die Grenze auf die Zeile
  beziehen, nicht auf die Datei.
- Der Signaturschlüssel liegt standardmäßig neben den Receipts (`.etnpilot/keys/…`). Wer die Dateien
  beschreiben kann, kann auch signieren. Echte Herkunft braucht den Schlüssel anderswo
  (`privateKeySecret` + Vault-Plugin) — das gehört in die Vorlage `regulated` als Voreinstellung und in `doctor`.
- Kein Widerruf, keine Rotation: ein verlorener Schlüssel macht alle bisherigen Signaturen gleich vertrauenswürdig.
  Mindestens: `validFrom`/`validUntil` je Schlüssel in der Prüfliste.
- Zeitstempel kommen von der lokalen Uhr. Für „vor dem Vorfall“-Behauptungen braucht es einen externen Anker
  (RFC 3161 / Transparenzlog). Kann warten, sollte aber in der Dokumentation als Grenze stehen.
- Ohne Prüfschlüssel prüft `receipt verify` weder Signaturen noch das Ende der Kette: eine am Ende gekürzte
  Datei gilt dann als gültig. Sinnvoller Standard: ohne Schlüssel *warnen*, dass nur Integrität geprüft wurde.

### A4. Preise: der Weg zur Zahl ist noch nicht belastbar (Aufwand: klein–mittel)

- Gelernte Preise (`pricing-sync.js`) übernehmen jeden Katalogeintrag, auch `0`. Ein falscher oder manipulierter
  Eintrag macht ein **Budget wirkungslos**. Vorschlag: Einträge ablehnen, die mehr als Faktor 10 unter dem
  Tabellenwert liegen oder 0 sind (außer ausdrücklich `:free`), und im Bericht zeigen, woher der Preis stammt.
- `normalizeModelKey` schneidet den Anbieter-Präfix ab: `openai/gpt-5` und `azure/gpt-5` fallen zusammen, der
  zuletzt gelesene gewinnt.
- Dienststufen (Batch, Flex, Priority) und Rabatte fehlen im Modell. **Die Differenz 0,2483 vs. 0,21 USD ist
  nicht geklärt.** Mit `etnpilot usage` lässt sich jetzt Tag für Tag und Modell für Modell vergleichen; die
  Token-Zahlen müssen *exakt* stimmen, nur dann ist der Rest eine Preisfrage. Ich brauche dafür die Zeilen
  des Dashboards und `observability.pricing.models`.
- Die Modell-IDs der eingefügten Tabelle sind geraten (nur `gpt-6-luna` ist belegt). `etnpilot smoke` kann die
  IDs liefern, die ein Konto tatsächlich sieht (`listModels` existiert) → daraus Tabelle prüfen.

---

## B. Sicherheit — was noch offen ist

1. **Umgebungsvariablen sind nicht an Hosts gebunden.** `OPENAI_API_KEY` geht an jede `baseUrl`, die die
   Projektkonfiguration nennt. `etnpilot trust` ist die einzige Bremse. Option: für bekannte Variablennamen
   dieselbe Host-Bindung wie bei gespeicherten Logins, mit Ausnahme per `--allow-host`.
2. **Befehle lassen sich nicht nach Inhalt regeln.** Die Policy kennt für `shell` kein Muster für den Befehlstext
   (`engine.js`: nur `kinds`, `agents`, `paths`, `hosts`). Ein `commands:`-Matcher mit Präfixen
   (`["npm","test"]` erlaubt, `["rm", …]` verboten) würde die häufigste Entscheidung („darf `npm test` ohne
   Nachfrage?“) automatisierbar machen und Genehmigungen für Wiederholbares sparen.
3. **Die Sandbox ist aus.** Voreinstellung `sandbox.enabled: false`, weil ein Containerlaufzeit nötig ist; auf
   dem Handy gibt es keinen. Ein ehrlicher Zwischenschritt: `doctor` meldet es (jetzt der Fall), und die
   Genehmigung eines Shell-Befehls zeigt „läuft direkt auf diesem Gerät“ im Dialog.
4. **Blocklisten sind brüchig, der Dispatcher-Fund war der Beweis.** Plugin-Isolation sperrt Netzwerk durch
   Entfernen von Globals und Importen. Besser: ein echter Mechanismus. Node ≥ 25 hat `--allow-net`? (prüfen);
   bis dahin den Worker in einer Umgebung ohne Netzwerk-Namensraum starten (Linux `unshare -n`) und die
   Fähigkeit in `doctor` ausweisen.
5. **Parser ohne Fuzzing.** SSE-Leser, JSON-Reparatur der Forge-Antwort, Glob→RegExp der Policy
   (`globSource` baut RegExps aus Konfigurationstext: verschachtelte `**` können lange Laufzeiten erzeugen),
   Frontmatter, YAML-Manifeste. Ein kleiner Zufallstest je Parser (zufällige Bytes in Stücken, feste Zeitgrenze)
   kostet wenig.
6. **Klartext-Login-Speicher.** Bewusst (siehe `docs/login.md`); wo ein Schlüsselbund da ist (macOS, Linux mit
   Secret Service), optional nutzen. Nur sinnvoll, wenn die Abhängigkeit optional bleibt.
7. **Lieferkette von ETNPilot selbst.** CI-Actions hängen an Tags (`actions/checkout@v7`) statt an
   Commit-SHAs; `npm publish` mit Provenance fehlt (Paket ist `private`). Dependabot gruppiert, aber Actions
   werden nicht festgeschrieben.

## C. Bedienung auf dem Handy

- **Benachrichtigung, wenn etwas auf eine Entscheidung wartet.** Heute muss man auf die Seite schauen. Eine
  PWA kann Web-Push (braucht einen Push-Dienst) oder, einfacher, ETNPilot ruft ein konfigurierbares Webhook/`ntfy`
  an, sobald eine Genehmigung offen ist. Das ist der größte Alltagsgewinn für lange Läufe.
- **Unterbrochene Läufe fortsetzen.** Die Warteschlange hat das Gerüst (Checkpoints). Läufe aus der Seite leben
  im Serverprozess und sterben mit der App; jetzt steht nur der Hinweis im Receipt. Vorschlag: beim Start
  „Lauf X wurde unterbrochen — fortsetzen / verwerfen“.
- **Kosten sichtbar machen, bevor sie entstehen:** Budget (`maxEstimatedCostPerWorkflow`) in der Oberfläche
  anzeigen und ändern, laufende Kosten live in der Karte des laufenden Laufs.
- **Inhalt sperren mit Diff:** Der Dialog nennt Namen („1 new: agent x“), nicht, *was* sich geändert hat.
  Wer sperrt, soll den Unterschied zur letzten Sperre sehen (die Daten liegen vor: Digest + Datei).
- **Erststart-Checkliste** in der Seite: Schlüssel → Smoke → Inhalt sperren → erster Lauf. Heute sind die vier
  Schritte auf vier Ansichten verteilt; `docs/first-15-minutes.md` ist die Textfassung davon.
- **Barrierefreiheit:** `aria-*` kommt im Seitenskript nur in `chat`, `core`, `worktrees`, `project`, `runs`
  vor — `accounts` und `shell` haben keines. Ein `axe-core`-Test in `test-ui/` fängt Kontrast, fehlende Namen
  und Tastaturfallen automatisch. Fokusführung in den Dialogen prüfen (Fokus in den Dialog, zurück auf den
  Auslöser).
- **Sprache:** Die Oberfläche ist englisch, der Nutzer arbeitet deutsch. Der Aufwand liegt nicht im Schalter,
  sondern in mehreren hundert Texten; erst sinnvoll, wenn Texte in eine Datei je Sprache ausgelagert sind
  (die Client-Dateien sind jetzt echte Dateien — der Weg ist frei).
- **Suchen und Filtern** in Läufen und Genehmigungen (nach Agent, Status, Zeit) — die Liste zeigt jetzt 20, mehr
  per Knopf.

## D. Anbieter und Modelle

- Voreinstellungen für **Gemini**, **Mistral** und **Ollama/llama.cpp** (alle OpenAI-kompatibel): ein
  auskommentierter Block in der Vorlage genügt. **OpenRouter** als Anbieter öffnet viele Modelle mit einem
  Schlüssel und liefert die Preise gleich mit.
- `etnpilot models`: listet, was ein Konto sieht (`listModels` ist da), mit Preis aus der Tabelle. Das
  beantwortet „welche ID ist `GPT-5.6 Luna`?“ ohne Raten.
- Fallback-Routen (`routing.fallback`) sind gebaut, aber in keiner Vorlage aktiv; für das Handy sinnvoll:
  `openai` → `anthropic`, wenn eines Kontingent oder Netz verliert.
- Anbieter-Fehler als eigene Klasse in der Oberfläche (401 → „Anmeldung erneuern“, 429 → „warten, Konto
  prüfen“, 5xx → „später“) mit der passenden Schaltfläche; der Text kommt heute aus der Fehlermeldung.

## E. Betrieb und Verteilung

- **282 MB für CodeGraph**, auch wenn `codegraph.enabled: false`. Auf einem Handy mit begrenztem Speicher ist
  das die Installationsgröße. Vorschlag: `@colbymchenry/codegraph` als `optionalDependencies`/Peer und beim
  Einschalten des Features nachinstallieren lassen (`etnpilot graph build` sagt es dann deutlich).
- **Aufräumen:** `.etnpilot/state/` wächst (Receipts, Telemetrie, Chat-Sitzungen, Worktrees). Ein
  `etnpilot gc --older-than 30d` mit Trockenlauf; die Seite zeigt, wie viel Platz belegt ist.
- **Datenschutz auf einer Seite:** Was verlässt die Maschine, wann? (Provider-Aufrufe; der Forge-Digest nach
  Rückfrage; der Preiskatalog-GET an openrouter.ai; der Device-Flow an GitHub/GitLab; sonst nichts). Eine
  Tabelle in `docs/`, geprüft mit einem Test, der alle `fetch`-Aufrufstellen im Quelltext zählt und gegen die
  Liste hält.
- **Release-Prozess:** Version 0.1.0 ohne Tags. Ein Tag je zusammengeführtem Feature-PR genügt, der CHANGELOG-Eintrag
  entsteht dann aus den PR-Titeln. `files` und der Paket-Test sind da, `private: true` ist die einzige Sperre.

## F. Tests und Qualität

- **Die zwei schwankenden Tests** (PTY-Chat, TUI-Lauf) sind nicht ergründet, nur großzügiger gemacht. Ursache
  vermutlich Last durch parallele Dateien; Abhilfe, die die Ursache beseitigt: auf Ereignisse warten statt auf
  Zeit, oder `--test-concurrency=4` in `npm test`.
- **Typprüfung ausweiten:** 12 Module sind geprüft. Der Rest zeigt ~290 Fehler, fast alle vom selben Muster
  (`{ a, b } = {}` ohne Typ). Ein Skript, das dort `= /** @type {any} */ ({})` einsetzt, bringt `src/runtime`,
  `src/providers` und `src/core` in einem Schritt dazu; danach `strict` Datei für Datei.
- **Mutationstests** (Stryker) für die Stellen, deren Fehler leise sind: Policy-Entscheidung, Hash-Kette,
  Host-Bindung, Pfad-Eingrenzung. 95 % Zeilenabdeckung sagt nicht, dass ein Test fehlschlägt, wenn man `>` in
  `>=` ändert.
- **Zufalls-/Eigenschaftstests** für `globMatch`, `normalizeRequestPath`, `parseDiff`, Receipt-Reihenfolge.
- **Abdeckung dort heben, wo sie fehlt:** `servers.js` (27 %: `ui`, `tui`, `webhook serve` starten Server und
  sind schwer zu testen → Start/Stopp in eine Funktion, die der Test mit einem Port 0 aufruft), das Plugin-SDK (30 %).

## G. Dokumentation

- **Sprachmix:** `trying-it-out.md` ist deutsch, der Rest englisch. Entscheiden; für diesen Nutzer spricht
  vieles für zwei Fassungen der Einstiegsseiten (`first-15-minutes`, `login`).
- **`roadmap-agent.md`** hat 1 091 Zeilen. Es mischt Vorhaben und Erledigtes; ein Kopf je Eintrag mit
  „Status: gebaut in PR #n / offen / verworfen“ macht daraus ein Protokoll, das nicht veraltet.
- **Entscheidungsprotokolle (ADR):** Warum JavaScript ohne Build, warum `node:sqlite`, warum kein Framework
  für die Oberfläche — die Fragen kamen schon einmal und werden wiederkommen. Ein Absatz je Entscheidung mit
  Datum und dem, was dagegen sprach.
- Die **Bedrohungsanalyse** ist aktualisiert (gespeicherte Logins, Vertrauen, Host-Bindung, Plugin-Netzwerk).
  Sie sollte bei jeder neuen Art von Geheimnis oder Netzwerkziel Pflichtbestandteil des PR sein
  (Vorlage `.github/pull_request_template.md` mit der Frage: „Was verlässt die Maschine, was kann sich
  neu auf etwas berufen?“).

## H. Arbeitsweise

- **Kleinere PRs.** Einzelne PRs der letzten Tage waren groß (Import + Forge + Ansichten + Builder in einem).
  Gut geprüft, aber schwer zu lesen. Ziel: ein PR, ein Gedanke, unter 600 Zeilen Diff ohne Tests.
- **Branch-Schutz und Pflicht-Prüfungen** auf `main` (alle vier Matrix-Jobs + UI-Job), `CODEOWNERS` für
  `src/policy`, `src/auth`, `src/trust`, `src/core/receipt-*`: diese Dateien tragen die Sicherheitsaussagen.
- **Schwierige Funktionen sichtbar halten:** `complexity` als Warnung (30) in der ESLint-Konfiguration; die 30
  heutigen Treffer als Basislinie festschreiben, damit es nicht schlimmer wird.

---

## Was ich bewusst nicht getan habe

| Punkt | Grund |
|---|---|
| `executeProject` und `createTuiApp` zerlegen | Ohne Charakterisierungstests an den Austrittspfaden riskiert die Zerlegung genau die Fehler, die sie beseitigen soll. Erst die Tests (A2). |
| Typprüfung für das ganze Repository | Mechanisch, aber ~290 Stellen; in einem eigenen Schritt, damit der Diff lesbar bleibt. |
| Oberfläche übersetzen | Siehe C: erst auslagern, dann übersetzen. |
| Schlüsselbund | Eine Abhängigkeit mehr und nicht überall vorhanden (siehe B6). |
| Läufe fortsetzen | Braucht einen Entwurf, wie Worktree, Receipt und Provider-Verlauf zusammen wieder aufgenommen werden. |
| Live-Aufrufe | Aus der Entwicklungsumgebung nicht erreichbar; das ist A1. |

## Vorschlag: die nächsten drei PRs

1. **Live-Wahrheit** (A1): `smoke` für Anthropic und GitLab laufen lassen, Fixtures aufnehmen, Adapter dagegen testen,
   `first-real-run.md` ergänzen. Klein, ohne Risiko, schließt die größte Unsicherheit.
2. **Kosten belastbar** (A4): Plausibilitätsprüfung der gelernten Preise, Anbieter-Schlüssel, `etnpilot models`;
   danach die Dashboard-Differenz klären.
3. **Benachrichtigung bei offener Genehmigung** (C): der größte Gewinn im Alltag, klein im Aufwand, nutzt vorhandene
   Ereignisse.

Danach A2 (Charakterisierungstests, dann `executeProject`) und A3 (Receipts über 16 MiB).

## Stand der zweiten Runde

Erledigt: Typprüfung auf 102 Dateien (Rest in `docs/typecheck.md`), Doctor-Warnung für Umgebungs-Schlüssel an
fremde Hosts, Zufallstests (`test/fuzz.test.js`), `CODEOWNERS`, PR-Vorlage mit „What leaves the machine?“.
Danach ebenfalls erledigt: Benachrichtigung bei offener Genehmigung (`approval.notify`), Provider-Presets
(`provider add`), `etnpilot gc`, ADRs (`docs/adr/`), Release-Prozess (`docs/releasing.md`), deutsche Kurzfassung
(`README.de.md`), Filter und Suche in der Lauf-Liste, laufende Kosten in der Karte eines laufenden Laufs,
Typprüfung jetzt für alle Dateien in `src/`, axe-core-Test über alle Ansichten in hell und dunkel (er fand eine Tabellenüberschrift ohne Text; behoben).

Außerdem: Erste-Schritte-Liste auf der Übersicht (live gelesen), `etnpilot content diff` (was sich seit dem Lock geändert hat), Komplexitäts-Ratsche in ESLint (zwei
bekannte Ausreißer festgehalten: der Request-Handler der Prüfseite mit 160, `renderRunDetail` mit 71).

Weiter offen: Lauf fortsetzen nach Abbruch, Übersetzung der Oberfläche, optionaler Schlüsselbund, Gültigkeitszeitraum für Signaturschlüssel,
aufgezeichnete Live-Fixtures, `openProjectState`/`createTuiApp` weiter zerlegen,
Komplexitäts-Baseline in ESLint, SHA-gepinnte Actions, Ursache der unsteten PTY-Tests.
