# Ausprobieren, ohne einen Provider zu haben

Ein neuer Benutzer konnte ETNPilot bisher **gar nicht** ausführen: ohne
Copilot-SDK und ohne API-Endpunkt gab es keinen zulässigen Provider. Jeder Test
in diesem Repository setzt einen Provider ein, aber diese Naht lag allein im
Testcode.

Der `scripted`-Provider schließt das. Er fragt kein Modell. Er führt genau die
Werkzeugaufrufe aus, die in der Konfiguration stehen — durch dieselben
vermittelten Werkzeuge und denselben Genehmigungsweg wie jeder andere Provider.

Damit lässt sich prüfen, was das Gerüst ausmacht: Policy, Genehmigungen,
Worktree, Checks, Receipts, Merge-Rehearsal. Nur eben ohne Modell.

## Ein Projekt zum Ausprobieren

```bash
etnpilot init probe && cd probe
```

Dann in `.etnpilot/etnpilot.yaml`:

```yaml
defaultProvider: rehearsal
providers:
  rehearsal:
    type: scripted
    steps:
      - tool: list_files
        arguments: { path: "." }
      - tool: write_file
        arguments: { path: NOTES.md, content: "Written by a scripted run.\n" }
      - tool: run_command
        arguments: { command: ["node", "-e", "console.log('check ok')"] }
    text: Scripted run finished.
routing:
  defaults: [rehearsal]
policy:
  providers:
    default: deny
    rules:
      - { id: configured-rehearsal, effect: allow, providers: [rehearsal] }
```

Das Agent-Manifest `.etnpilot/agents/orchestrator.yaml` nennt keinen Provider,
folgt also `defaultProvider` — mehr ist nicht nötig. Dann:

```bash
etnpilot content lock
git add -A && git commit -m "Ein Projekt zum Ausprobieren"
```

**Der Provider gehört in die eingecheckte Datei, nicht in die lokale.** Wer
einen Provider aufrufen darf, entscheidet, wohin Ihr Code und Ihre Prompts
gehen — das ist eine Projektentscheidung, keine persönliche. `policy.**` ist
deshalb `stricter-only`: lokal lässt sich eine Regel nur **hinzufügen**, und
eine hinzugefügte Regel darf nie schwächer sein als der Abschnitts-Default. Ein
Provider lokal zu erlauben ist per Definition eine Erweiterung und wird
abgelehnt. Siehe [settings.md](settings.md).

## Ausführen und dabei entscheiden

```bash
etnpilot run "Leg NOTES.md an" --approvals inbox
```

`--approvals inbox` legt die Anfragen ins dauerhafte Postfach statt in das
Terminal, das den Run gestartet hat. In einem zweiten Fenster:

```bash
etnpilot tui          # a genehmigen, r ablehnen
# oder
etnpilot approval list
etnpilot approval approve <id> --actor <name>
```

Ohne `--approvals inbox` fragt der Run das Terminal, in dem er läuft — und ohne
interaktives Terminal lehnt er **jede** Anfrage ab. Das ist sicher, aber im
Hintergrund unbrauchbar.

## Modell wählen, statt tippen

In der Einstellungs-Ansicht (Browser) hat jede `providers.<name>.model`-Zeile
einen Knopf **fetch models** — ein echter Aufruf gegen `/v1/models` des
jeweiligen Anbieters, mit dem konfigurierten Schlüssel. Bei OpenAI-kompatiblen
Providern gefiltert auf das, was nach einem Chat-Modell aussieht (die
Anbieter-API trennt Embedding-, Audio- und Bildmodelle nicht selbst ab — das
ist eine eigene, dokumentierte Vermutung dieses Projekts, keine Angabe der
API). Bei Anthropic listet der Endpunkt ohnehin nur aktuell angebotene
Modelle.

Wird ein Modell gewählt, für das ein Preis bekannt ist, trägt ETNPilot
`observability.pricing.models.<id>` automatisch ein — mit Quelle und Datum in
der Meldung, denn **weder OpenAI noch Anthropic liefert Preise über eine
API**. Es gibt keinen Befehl, der sie live abfragt, weil es diesen Endpunkt
bei keinem der beiden gibt. Die mitgelieferte Tabelle enthält nur Anthropics
eigene, veröffentlichte Preise (Stand siehe Meldung); für OpenAI ist sie
bewusst leer — geratene Dollarbeträge sind schlechter als keine, bei echtem
Geld.

## Wo landen die Dateien?

Ein Run arbeitet standardmäßig in einem **eigenen Worktree**, nicht im
Checkout: `.etnpilot/worktrees/run-<id>/`, auf dem Branch
`etnpilot/run-<id>`. Geschrieben wird dort, und ohne `--publish` wird nichts
committet — im Hauptverzeichnis sehen Sie deshalb nichts.

```bash
etnpilot receipt show          # 'workspace.path' sagt, wo; 'tools', was es tat
etnpilot worktree list         # alle Worktrees mit ihren Branches
ls .etnpilot/worktrees/run-<id>/
```

In der Oberfläche: **Worktrees** zeigt die geänderten Dateien und ihren Diff;
die Run-Karte nennt Branch und Workspace-Pfad.

Wer lieber direkt im Checkout arbeitet:

```bash
etnpilot config set workspace.mode in-place    # bleibt lokal
```

## Kosten anzeigen

Ohne Preise zählt ETNPilot nur Tokens; „not priced" heißt, dass kein Satz für
das Modell hinterlegt ist. Preise stehen unter `observability.pricing` und
sind lokal setzbar — in Währung **pro einer Million Tokens**:

```bash
etnpilot config set observability.pricing.models.gpt-5.inputPerMillion 1.25
etnpilot config set observability.pricing.models.gpt-5.outputPerMillion 10
```

Oder die ganze Tabelle auf einmal, was bei Modellnamen mit Punkt (`gpt-4.1`)
der einzige Weg ist, weil der Pfad an Punkten getrennt wird:

```bash
etnpilot config set observability.pricing.models \
  '{gpt-5: {inputPerMillion: 1.25, outputPerMillion: 10, cacheReadPerMillion: 0.125}}'
```

**Preise gelten ab dem nächsten Run.** Der Betrag wird beim Aufruf berechnet
und im Receipt festgehalten — ein später gesetzter Satz erreicht keinen
Aufruf, der schon auf der Platte liegt. Die Karte sagt jetzt, welcher Fall
vorliegt:

```
1 call has no rate: set observability.pricing.models for 'gpt-5'
4 calls have no cost: they ran before the rate for 'gpt-5' was set
```

Die erste Zeile heißt: Satz fehlt. Die zweite: Satz ist da, diese Aufrufe sind
älter — der nächste Run zeigt Kosten.

**Datierte Snapshots sind mitgemeint.** OpenAI beantwortet eine Anfrage nach
`gpt-5-mini` mit `gpt-5-mini-2025-08-07`. Ein Satz unter `gpt-5-mini` gilt
auch dafür — sonst wäre jeder Satz veraltet, sobald der Anbieter den Snapshot
wechselt. Ein exakter Schlüssel gewinnt weiterhin, falls ein bestimmter
Snapshot anders abgerechnet wird. Abgeschnitten wird nur ein echtes
`-JJJJ-MM-TT` am Ende, kein Präfix: `gpt-5` erbt nie den Satz von
`gpt-5-mini`.

Der Schlüssel ist der **Modellname, den der Provider zurückmeldet** — derselbe,
der im Receipt unter `usage.model` steht. `"*"` gilt für alles, was sonst
keinen Satz hat. `currency` ist ein dreistelliger Code, Standard `USD`.
Zwischengespeicherte Eingabe-Tokens werden mit `cacheReadPerMillion`
abgerechnet und von den Eingabe-Tokens abgezogen.

```bash
etnpilot config set observability.pricing.currency EUR
etnpilot config set observability.pricing.models '{"*": {inputPerMillion: 1, outputPerMillion: 5}}'
```

## Das Receipt öffnen

Jeder Run schreibt eine Datei unter `.etnpilot/state/runs/`. Drei Wege führen
hinein, alle über denselben Leser — keine Ansicht kann etwas anderes über
denselben Run sagen als eine andere:

```bash
etnpilot receipt show                       # der neueste Run: warum er endete
etnpilot receipt show 20260924-abc.jsonl    # ein bestimmter
etnpilot receipt verify <datei>             # die Hash-Kette, nicht der Inhalt
```

`receipt show` endet mit Exit-Code 1, wenn der Run nicht erfolgreich war.

Im Browser (`etnpilot ui`): **Runs** → auf die Run-ID tippen. Im Terminal
(`etnpilot tui`): **runs**, Zeile wählen, Enter. Beide zeigen dasselbe
„Why it ended", dieselben Schritte und dieselbe Nutzung.

Welche Agenten liefen — als Baum, ein Subagent unter dem Agenten eingerückt,
der ihn gestartet hat, nicht daneben aufgelistet — und der volle Text, den
jeder Agent tatsächlich produziert hat: im Browser als aufklappbare Zeilen
unter „Agents"; im Terminal `a` zum Auswählen, `Enter` öffnet die volle
Antwort eines Agenten; auf der Kommandozeile steht derselbe Baum ungekürzt
unter `agents` im JSON von `receipt show`.

Und was der Provider **wörtlich** zurückgegeben hat — der ganze Antwort-Body,
inklusive des exakten, oft datierten Modellnamens (`gpt-5-mini-2025-08-07`
statt nur `gpt-5-mini`):

```bash
etnpilot receipt show --raw
```

Ohne `--raw` bleibt das weg, weil es pro Aufruf ein ganzer JSON-Block ist.
Das ist auch der zuverlässigste Weg zu sehen, welches Modell ein Aufruf
wirklich getroffen hat — nützlich genau dort, wo `observability.pricing`
„not priced" meldet und der Modellname der Grund ist.

## Was danach im Receipt steht

```
read   approve-once ← read-project
write  approve-once ← write-project    durch peter
shell  approve-once ← shell-with-review durch peter
```

Jede Entscheidung mit der Regel, die gefragt hat, und mit dem Namen dessen, der
geantwortet hat. Lehnen Sie stattdessen ab, **scheitert der Run**:

```
Fehler : Scripted step 2 (write_file) did not run: Nicht jetzt
Status : failed
```

Ein Skript sagt vorher, was es tun wird. Ein verweigerter Schritt heißt, dass
es das nicht getan hat — `succeeded` über einem Receipt voller Ablehnungen wäre
eine Falschaussage.

## Was das nicht ist

Der `scripted`-Provider ist **kein Agent**. Er entscheidet nichts; die Schritte
standen schon in der Konfiguration. Seine Receipts führen das Modell als
`scripted`, damit niemand später einen Modelllauf hineinliest. Für echte Arbeit
brauchen Sie ein Modell — siehe den nächsten Abschnitt.

## Mit einem echten Modell: Anthropic oder OpenAI

`etnpilot init` konfiguriert alle drei eingebauten Provider. Welcher läuft,
entscheidet die **eine** Einstellung `defaultProvider`; `routing.defaults` ist
absichtlich leer, damit nichts sie still überstimmt.

| Provider | Schlüssel | woher |
|---|---|---|
| `github-copilot` | GitHub-Login des Copilot-SDK | Copilot-Abo |
| `anthropic` | `ANTHROPIC_API_KEY` | console.anthropic.com |
| `openai` | `OPENAI_API_KEY` | platform.openai.com |

```bash
export OPENAI_API_KEY=sk-...
etnpilot config set defaultProvider openai
etnpilot run "Fasse dieses Repository zusammen."
```

Der Schlüssel wird gelesen, wenn der Provider **benutzt** wird, nicht wenn er
konfiguriert wird. Ein Projekt darf alle drei eintragen und mit einem davon
laufen; ein Provider ohne Schlüssel sagt beim Aufruf, welche Variable fehlt,
statt jeden Run zu verhindern.

Beide Adapter arbeiten über dieselben vermittelten Werkzeuge (`tools: true`):
Lesen, Schreiben und Befehle laufen durch denselben Genehmigungsweg wie bei
Copilot. Nichts geschieht ohne Ihre Zusage.

`etnpilot doctor` sagt, welchen Provider ein Run erreichen würde und ob der
hier laufen kann — samt der Variable, die zu setzen ist, und dem Befehl, der
auf einen bereits einsatzfähigen Provider umstellt. `ready: false` heißt: ein
Run würde jetzt scheitern.

### Auf Android (Tablet, Telefon)

Für `github-copilot` gibt es **keinen SDK-Build für Android** — `npm install
@github/copilot-sdk` meldet Erfolg und installiert nichts. Auf einem Tablet
nehmen Sie deshalb `anthropic` oder `openai`; beide sind reine HTTPS-Aufrufe
und brauchen nichts Plattformabhängiges. In Termux:

```bash
pkg install nodejs git
export OPENAI_API_KEY=sk-...
etnpilot config set defaultProvider openai
etnpilot ui            # öffnet den Browser mit der neuen Sitzung
```

`OPENAI_API_KEY` und `ANTHROPIC_API_KEY` stehen bereits in
`secrets.providers.env.allow`; ohne diesen Eintrag liest das env-Backend die
Variable nicht. Fehlt der Schlüssel, nennt der Provider beim Aufruf genau die
Variable, die zu setzen ist.

#### Wenn ein Check mit 126 scheitert

```
Check failed with exit code 126: npm
env: 'node': Permission denied
```

Checks erben absichtlich nur erlaubte Variablen, damit agentengeschriebener
Code keine Zugangsdaten sieht. Auf Termux gehört `LD_PRELOAD` dazu: darin
steht `libtermux-exec`, und ohne sie darf Android den Interpreter aus der
`#!`-Zeile gar nicht starten — `npm` stirbt, bevor es läuft. `LD_PRELOAD`,
`LD_LIBRARY_PATH`, `PREFIX` und die `ANDROID_*`-Paare sind deshalb in der
Standardliste.

Fehlt etwas anderes, sagt die Meldung, was der Check bekommen hat:

```
It inherited only these variables: HOME, LANG, PATH, TMPDIR.
```

Nachstellen lässt sich das direkt:

```bash
env -i PATH="$PATH" HOME="$HOME" npm test          # scheitert wie der Check
env -i PATH="$PATH" HOME="$HOME" LD_PRELOAD="$LD_PRELOAD" npm test   # läuft
```

Ergänzen lässt sich die Liste nur in der eingecheckten
`.etnpilot/etnpilot.yaml` unter `checks.envAllow` — die Einstellung ist
`stricter-only`, lokal kann man sie nur verkleinern.

### Ein anderes Modell oder ein eigener Endpunkt

```bash
etnpilot config set providers.openai.model gpt-5-mini
etnpilot config set providers.anthropic.model claude-sonnet-5
etnpilot config set providers.openai.baseUrl http://127.0.0.1:11434/v1
```

Ein Modellserver auf diesem Rechner braucht keinen Schlüssel: bei einer
Loopback-`baseUrl` verlangt der OpenAI-kompatible Adapter keinen. Erreicht ein
Modell Ihr Konto nicht, antwortet die API selbst — und der Fehler wiederholt,
was sie gesagt hat, statt nur „(404)".
