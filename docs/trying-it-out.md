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

Im Agent-Manifest `.etnpilot/agents/orchestrator.yaml` noch
`provider: rehearsal` setzen, dann:

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
brauchen Sie `github-copilot` oder `openai-compatible`.
