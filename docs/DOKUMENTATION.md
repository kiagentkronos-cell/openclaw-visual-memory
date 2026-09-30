# Visual Memory — Ausführliche Doku

Stand: 30.09.2026 · Version 0.1.0 · MIT-Lizenz
Zuständig: Kronos (Betrieb), Athena (Bau), Hyperion (Review/PII-Gate)

---

## 1. Was ist Visual Memory?

Visual Memory ist ein lokales Bild-Erkennungssystem. Wenn in einem beliebigen Chat
(WhatsApp, Discord, Webchat, …) ein Bild ankommt, prüft ein Hook-Plugin das Bild
gegen ein lokales Register bekannter Entitäten (Personen, Tiere, Fahrzeuge,
Gebäude, Objekte) und stellt das Ergebnis **unsichtbar** als Zusatzinfo in
derselben Prompt-Turn bereit — exakt nach dem Vorbild von Active Memory.

**Kernprinzipien**

- **Unsichtbarkeit:** Der Nutzer sieht nie, dass ein Check lief. Der Block
  `[Visual Memory] …` erscheint nur im Agenten-Prompt. Kein Treffer → keine
  Bild-Erwähnung im Antworttext.
- **Lokalität:** Inferenz, Register und Referenz-Crops bleiben vollständig auf
  dem Host-Rechner. Keine Cloud, kein externer API-Aufruf.
- **Explizität:** Ins Register kommt nur, was ein Mensch ausdrücklich
  („merk dir das") angeordnet hat. Niemand wird automatisch enrolliert.
- **Eigentumsmodell:** Enrollieren darf, wer Kommunikationsrecht hat — für sich
  selbst und eigene Sachen; Personen nur mit deren Einwilligung. Löschen darf
  der Eigentümer des Eintrags (Administrator auf Host-Ebene direkt).

**Beispiel-Ausgaben des Blocks**

```
[Visual Memory] Treffer: Pippa (animal, possible, 0.93)
[Visual Memory] Treffer: Alex (person, certain, 0.81)
[Visual Memory] keine Treffer
[Visual Memory] Check nicht verfügbar (timeout)
```

---

## 2. Architektur

Zwei Schichten, bewusst getrennt:

```
Bild in Chat ──► OpenClaw Hook-Plugin (TypeScript)        dieses Repo
                 ├─ Bildpfad-Erkennung (2 Seam-Quellen)
                 ├─ Pfad-Gate (nur Workspace-Media-Wurzeln)
                 ├─ Spawn: vm.py check (hartes Timeout)
                 ├─ Formatierung → Prompt-Block
                 └─ synchrone Übergabe in denselben Turn
                          │
                          ▼
                 Visual Memory CLI (Python)                scripts/visual-memory/
                 ├─ InsightFace buffalo_l  →	Gesichts-Embeddings
                 ├─ CLIP ViT-B-32 (LAION)  →	Tier-/Objekt-Embeddings
                 ├─ SQLite-Register (privat + public)
                 └─ Schwellen + Confidence
```

Das Plugin enthält **keinerlei Register-Logik** — es ist ein dünner, testbarer
Wrapper: Medien klassifizieren, CLI mit Timeout spawnen, Ergebnis formatieren.

### 2.1 Hook-Plugin (TypeScript, dieses Repo)

Dateien (`src/`, insgesamt ~1.800 Zeilen + Tests):

| Datei | Aufgabe |
|---|---|
| `entry.ts` | Plugin-Registrierung, Hook-Registration |
| `handler.ts` | Kernlogik beider Seam-Wege, Idempotenz, Dedup |
| `promptmedia.ts` | Bildpfad-Extraktion aus Prompt/Media-Hinweisen |
| `media.ts` | Media-Root-Auflösung, Staging-Pfad-Heuristik |
| `checker.ts` | vm.py-Aufruf mit Timeout + Fehlerkapselung |
| `injection.ts` | Block-Formatierung, Übergabe an Host |
| `transcript.ts` | JSONL-Projektprotokoll je Lauf |
| `diaglog.ts` | PII-freies Diagnose-Log (eine Zeile je Entscheidung) |
| `config.ts` | Defaults + Merge mit pluginConfig |

**Zwei Seam-Wege** (`index.ts`-Kopf dokumentiert die Historie):

1. `message_received` — feuert nur, wenn der Kanal-Plugin das explizit
   konfiguriert (WhatsApp tut das per Default **nicht** → Hauptursache
   „Hook läuft nie", 29.09.).
2. `before_prompt_build` — kanalunabhängiger Agent-Turn-Hook; feuert bei
   **jedem** zugelassenen Turn. Seit 29.09. der verlässliche Hauptweg.
   Bildpfade kommen dort aus `event.media` / Prompt-Media-Hinweisen.

**Auslieferung — synchron, im selben Turn** (Betreiber-Anweisung 30.09.):
Der Handler erwartet die `vm.py`-Prüfung direkt im Hook und liefert den Block
als Prompt-Kontext **desselben** Turns. Das Gateway wartet — Active-Memory-
Parität. Hartes Abschaltdach: `checkTimeoutMs` (Default 120 s); bei Timeout
erscheint der Block `Check nicht verfügbar (timeout)` statt zu hängen.

> Vorgeschichte: Der erste Entwurf übergab das Ergebnis per
> `enqueueNextTurnInjection` ins *nächste* Turn. Live verweigerte der Host das
> (`host_refused`), wenn der laufende Turn schon in der Antwortphase war. Da
> Betreiber-Vorgabe „Gateway wartet, wie bei Active Memory" lautete, wurde der
> synchrone Weg eingebaut (Commit `05c220c`) — der enqueue-Pfad ist entfallen.

**Idempotenz & Dedup:** Ein `messageId`+Pfad-basierter Schlüssel verhindert
Doppel-Checks, wenn beide Seams oder Trigger-Varianten (`trigger_user` /
`trigger_manual` ~300 ms auseinander) denselben Turn erwischen.

### 2.2 CLI `vm.py` (Python, Workspace-Repo)

- **Gesichter:** InsightFace `buffalo_l` (Detection + arcface-r100), CPU-Default
- **Tiere/Objekte:** CLIP `ViT-B-32` (laion2B-s34B-b79K)
- **Register:** SQLite, zwei Scopes:
  - `register.db` + `references/` (privat)
  - `register_public.db` + `references_public/` (public, z. B. Prominente, Orte)
- `check` matched beide Register und liefert Hits mit `scope`-Feld.
- Von jedem Enrollieren bleibt ein Crop (~200 KB) erhalten — Migration bei
  Modellwechsel ist damit möglich (Entscheid 27.09.).

**Schwellen** (empirisch kalibriert, Stand 30.09.):

| Art | Schwelle |
|---|---|
| person | 0.40 |
| vehicle / building / object | 0.60 |
| animal | 0.85 |

Konfidenz-Stufen: `certain` ≥ Schwelle + Marge, `possible` im Grenzbereich.
Tier-Individuen-Erkennung ist best-effort (Pelage-Merkmale, kein Gesichts-Modell).

---

## 3. Konfiguration

Alles optional; Defaults aus `src/config.ts`:

| Key | Default | Bedeutung |
|---|---|---|
| `enabled` | `true` | Master-Switch |
| `workspaceDir` | `~/.openclaw/workspace` | Ort von vm.py + venv |
| `vmScriptRelPath` | `scripts/visual-memory/vm.py` | CLI-Pfad relativ dazu |
| `venvRelPath` | `scripts/visual-memory/venv/bin/python` | Python-Umgebung |
| `checkTimeoutMs` | `120000` | hartes Timeout, Active-Memory-Parität |
| `injectionTtlMs` | `120000` | TTL der Next-Turn-Injektion, nur vom Staging-Retry-Fallback genutzt |
| `maxImageSizeBytes` | `20971520` (20 MiB) | größere Bilder werden übersprungen |
| `maxImageAgeMs` | `900000` (15 min) | Altertums-Abschneiderkennung |
| `stagingRetryMs` | `5000` | Ein Retry-Probe bei `mediaStagingPending` |
| `mediaDir` | `~/.openclaw/media` | zusätzliche Media-Wurzel |
| `diagLogPath` | `~/.openclaw/logs/visual-memory-hook.log` | Diagnose-Log |
| `transcriptDir` | `~/.openclaw/plugins/visual-memory/transcripts` | JSONL je Lauf |
| `transcriptMaxFiles` | `200` | Rotationsgrenze |

Der Pfad-**Gate** akzeptiert Bildpfade ausschließlich unter den bekannten
Media-Wurzeln (Workspace `media/inbound`, `~/.openclaw/media`, Staging-
Verzeichnisse) — verhindert, dass beliebige Dateipfade aus Prompt-Texten an
die Shell übergehen (Hardening `d830134`).

---

## 4. Nachvollziehbarkeit (Verpflichtung)

Zwei Protokolle, beide PII-frei (keine Personennamen, keine Telefonnummern,
keine Bildpfade im Volltext — Pfad-Hashes statt Pfade im Diaglog):

1. **Diagnose-Log** — eine Zeile pro Entscheidung
   (`decision=prompt_fire|check|injected|no_image|… reason=…`), grepbar.
2. **JSONL-Transkript je Bild-Lauf** (Active-Memory-Parität, Anordnung 30.09.)
   unter `transcriptDir`, Dateiname `visual-memory-<UTC>-<id>.jsonl`:

```json
{"type":"run","seam":"before_prompt_build","channel":"whatsapp","images":1,"trigger":"user"}
{"type":"image","pathhash":"8bd1a5c7…","sizeBytes":126473}
{"type":"check","status":"ok","durationMs":9543,"hits":[]}
{"type":"inject","text":"[Visual Memory] keine Treffer"}
{"type":"done","decision":"injected_sync","durationMs":9554}
```

Anhand dieser Dateien ließ sich am 30.09. jeder Fehler exakt einer
Schicht zuordnen (Parsing → Gate → Check → Injektion).

---

## 5. Inbetriebnahme

Voraussetzungen: OpenClaw ≥ 2026.9.6 (typisierte Hooks, `api.session.workflow`),
Node 24+, Visual-Memory-CLI mit venv unter `workspaceDir`.

```bash
openclaw plugins install --link /path/to/openclaw-visual-memory --force
openclaw plugins enable visual-memory
```

Änderungen am Code: `openclaw plugins reload visual-memory` — der Reload braucht
ein Idle-Fenster (kein laufender Turn des Plugins); solange gearbeitet wird,
meldet er `active retained work` und ist kurz später erneut zu versuchen.

**Erster Live-Test:** Bild mit bekanntem Inhalt senden → erwartbare Antwort ist
die Trefferzeile; bei unbekanntem Bild: keine Bild-Erwähnung. Registerstand:
`vm.py list`.

## 6. Betrieb & Troubleshooting

| Symptom | Ursache | Fix |
|---|---|---|
| Block fehlt komplett | kein Seam-Hook im Kanal / Plugin inaktive Generation | Diaglog: `prompt_fire` vorhanden? Reload nötig (Idle-Fenster) |
| `check_miss` trotz Bild | Pfad außerhalb der Media-Wurzeln (Gate) | Gate-Logs im Transkript, Root-Konfig prüfen |
| `injected_sync` ohne Treffer, Bild bekannt | Schwelle nicht erreicht (z. B. Kopf-Seitenansicht) | weitere Referenz mit passendem Winkel enrollieren |
| `Check nicht verfügbar (timeout)` | vm.py > 120 s (GPU-Engpass, Modell-Download) | `checkTimeoutMs`, Ressourcenauslastung |
| Bild „zu alt" übersprungen | `maxImageAgeMs` bei nachgereichten Medien | Altersgrenze erhöhen |
| Doppel-Erkennung | — | nicht möglich: messageId+Pfad-Idempotenz, 1 Block/Turn |

Belegte Live-Fälle 29.–30.09.: (a) WhatsApp feuerte `message_received` nie →
`before_prompt_build`-Seam; (b) Staging-Pfade vom Gate verschluckt → Root-Gate;
(c) `host_refused` bei Next-Turn-Injection → synchrone Auslieferung;
(d) Tier-Treffer nach Frontal-Referenz 0,93 statt keine Treffer.

---

## 7. Stand & Historie

- Stand 30.09.: **einsatzbereit**, 93/93 Tests grün, Typecheck + Offline-
  Validierung grün, Stand `05c220c` (+ Doku/README/LICENSE im Folge-Commit).
- End-to-end verifiziert: Person (0,81 certain) und Tier (0,93 possible),
  synchrone Injektion im selben Turn, Protokoll nachweisbar.
- **Push in ein öffentliches Repo ist noch NICHT erfolgt** (Freigabe-
  Wartefrist + PII-Gate über Git-History, siehe §8).

| Commit | Inhalt |
|---|---|
| `5b27446` | Hook-Plugin (message_received → vm.py → Injection) |
| `477a2d7` | Diaglog, Staging-Retry-Probe, Immer-Injektions-Protokoll |
| `0de8d56` | Doku-Kopf Retry-Probe |
| `1ed6d36` | `before_prompt_build`-Seam (WhatsApp-Grundursache) |
| `d830134` | Pfad-Gate + Claim-Reihenfolge (Review-hart) |
| `08af016` | Gate auf Status + Workspace-Media-Wurzeln |
| `cfeef1c` | JSONL-Transkripte je Lauf |
| `fe80c1b` | PII-neutrale Fixtures + Doku-Fix |
| `05c220c` | synchrone Auslieferung im selben Turn |

## 8. Privatsphäre & Sicherheit (Release-Bedingungen)

1. **Alles lokal.** Keine Netzwerkaufrufe; Modelle nach dem ersten Start offline.
2. **Register = sensible Daten.** Gesichts-Embeddings + Crops bleiben auf dem
   dem Host-Rechner; das Plugin schreibt keine Gesichtsdaten in Logs, Transkripte oder
   Prompts (nur Entitäten-Namen + Score, aus dem eigenen Register).
3. **PII-Gate vor jedem Veröffentlichungsschritt** (Hyperion): drei Ebenen —
   Datei-Blobs, Commit-Messages, Autoren-Metadaten; Muster international +
   national (`\+49[0-9]{7,}`, `01[0-9]{8,}`, Adress-/Namensmuster).
   Erst mit ✅ FREIGEGEBEN wird gepusht. Test-Fixtures nutzen ausschließlich
   neutrale Werte (`+49x`).
4. **Keine unaufgeforderte Erkennung:** kein Enrollieren
   ohne menschliche Anweisung, kein Enrollieren dritter Personen ohne deren
   Einwilligung.

## 9. Roadmap für Veröffentlichung

- [ ] Git-History-PII-Gate final (Hyperion) → Remote einrichten → Push
- [ ] `openclaw.plugin.json`-Beschreibung + Screenshot fürs Verzeichnis
- [x] Kurzdoku (README) auf EN für ClawHub / Community, diese Doku als DE-Vollversion
- [ ] Beispiel-Repository/Seed für öffentlichen Scope (optional)
- [ ] Version 1.0.0 nach Bewährung im Dauerbetrieb (Stabilitätsfenster)

---

Diese Doku ist drittlesbar verfasst; alle Zahlen und SHAs stammen aus dem
verifizierten Stand vom 30.09.2026 (git log / validate-offline.sh / Register-
Dump). Einzige nicht-harte Angabe: die Zeit-/Ressourcenwerte stammen aus
Live-Transkripten desselben Tages.
