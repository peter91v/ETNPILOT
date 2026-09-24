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
