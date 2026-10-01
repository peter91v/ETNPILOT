# ETNPilot (Kurzfassung auf Deutsch)

ETNPilot ist ein anbieterneutraler Agenten-Rahmen für nachvollziehbare Softwarearbeit: isolierte Git-Arbeitsbäume,
ausdrückliche Freigaben durch Menschen, Belege (Receipts) als Hash-Kette, wiederverwendbare Agenten, Skills,
Prompts und Plugins. Bedienung über CLI, Terminal-Oberfläche (TUI) und eine Prüfseite im Browser (auch als App).
Die ausführliche Doku ist englisch; den Einstieg findest du in [docs/index.md](docs/index.md).

## In 15 Minuten

```bash
npm install
npx etnpilot init                    # legt .etnpilot/ an und vertraut dem Projekt
npx etnpilot login openai            # oder: login anthropic (Schlüssel wird gespeichert, 0600)
npx etnpilot doctor                  # was fehlt noch?
npx etnpilot smoke --provider openai # antwortet er, ruft er Werkzeuge auf, streamt er?
npx etnpilot run "Erkläre die Struktur dieses Projekts" --agent orchestrator
npx etnpilot ui                      # Prüfseite mit Freigaben, Läufen, Konten
```

Mehr: [docs/first-15-minutes.md](docs/first-15-minutes.md), [docs/login.md](docs/login.md).

## Was du wissen solltest

- **Freigaben:** Schreiben, Shell und Netzwerk brauchen standardmäßig eine Freigabe. Bei einem Lauf ohne Bildschirm
  gibt es den Posteingang (`etnpilot approval list`) und optional eine Benachrichtigung
  ([docs/approval-inbox.md](docs/approval-inbox.md)).
- **Schlüssel:** Gespeicherte Logins gehen nur an die Hosts, für die sie ausgestellt wurden. Schlüssel aus der
  Umgebung sind nicht gebunden; `etnpilot doctor` warnt davor.
- **Vertrauen:** Ein neues oder geändertes Projekt zeigt einmal, was es darf (`etnpilot trust`).
- **Belege:** Jeder Lauf schreibt eine verkettete Datei; `etnpilot receipts verify` prüft sie, optional signiert.
- **Weitere Anbieter:** `etnpilot provider presets` (Gemini, Mistral, OpenRouter, Groq, Ollama).
- **Aufräumen:** `etnpilot gc` zeigt alte Belege; gelöscht wird nur mit `--apply`.

Sicherheitsmodell: [docs/threat-model.md](docs/threat-model.md). Ehrliche Selbstkritik und offene Punkte:
[docs/review-2026-10.md](docs/review-2026-10.md), [docs/besser-machen.md](docs/besser-machen.md).
