# Pi Hybrid Epistemic Compiler (PI-HEC)

Расширение экосистемы [Pi](https://github.com/mariozechner/pi-mono) для software-engineering задач. Cloud-модель пишет решение одним completion. Локальная модель на FA-EX1 только анализирует: evidence, preflight, контекст. Она не пишет код, не вызывает shell и не отдаёт cloud-инструкции.

Нормативный источник — [`PI_HYBRID_EPISTEMIC_COMPILER_IMPLEMENTATION_SPEC.md`](PI_HYBRID_EPISTEMIC_COMPILER_IMPLEMENTATION_SPEC.md). Этот файл описывает, как систему ставят и запускают.

## Состав

```text
Windows (Pi + broker)                         FA-EX1 (Linux)
┌─────────────────────────────┐               ┌──────────────────────────────────┐
│ Pi + @pi-hec/pi-extension   │  named pipe   │ llama.cpp  Qwen3.8-27B  :8000    │
│   slash-команда /hec        │◄─────────────►│ control plane  mTLS :8443        │
│                             │               │                enroll :8444      │
│ pi-hec-runner               │    mTLS       │ worker (preflight/context/verify)│
│   AppContainer + Job Object │──────────────►│ secret-broker  inject.sock       │
│   broker.sqlite / DPAPI     │               │ SQLite WAL + filesystem CAS      │
└─────────────────────────────┘               └──────────────────────────────────┘
```

| Компонент | Роль |
|-----------|------|
| Cloud model | Единственный источник патча и решения |
| Local model `Qwen/Qwen3.8-27B` | Read-only аналитик на Vulkan llama.cpp |
| Control plane | Authoritative state, API, enrollment, scheduler |
| Secret broker | Inject секретов в sandbox через Unix socket |
| `pi-hec-runner` | Привилегированный Windows-брокер: pipe к Pi, confinement, promotion |
| Pi extension | Untrusted UX. Команда `hec`, TUI, вызовы брокера |

Профиль хоста: `SINGLE_HOST`. Это не Byzantine-топология. Root FA-EX1 может подделать FA-подписи и потерять credentials; он не обходит нескомпрометированный Windows-брокер.

Режим расширения:

- `PI_HEC_SECURITY_MODE=production` — Pi должен быть confined (AppContainer + Job Object). Иначе run блокируется.
- `compatibility` — обычный user token. Для production-acceptance не годится.

## Репозиторий

```text
.
├── client/apps/pi-extension/     Pi extension
├── client/bootstrap.ps1          Windows client: Node, PKI, control.env
├── faex1/bootstrap.sh            полный install FA-EX1
├── faex1/apps/control-plane/     API, worker, bootstrap-host
├── faex1/apps/secret-broker/     Unix-socket inject
├── faex1/deploy/systemd/         unit-файлы
├── native/runner/                pi-hec-runner (Rust)
└── packages/                     @pi-hec/{contracts,domain,cas,state-store,...}
```

Production-checkout на FA-EX1 копируется в `/opt/pi-hec`. Docker Compose в репозитории нет.

## Требования

| Что | Версия / условие |
|-----|------------------|
| Node.js | ≥ 24.20.0, в bootstrap закреплён **24.21.0 LTS Krypton** |
| pnpm | **12.0.0** (`packageManager` + corepack) |
| Rust | stable (`rust-toolchain.toml`) |
| FA-EX1 | Debian/Ubuntu, root, Vulkan (Radeon ICD), диск под GGUF ~18 ГиБ |
| Windows | PowerShell, Python 3 + paramiko (SFTP PKI), Pi 0.84.3 |
| Часы | skew Windows ↔ FA-EX1 < 25 с, иначе mutations отклоняются |

## Деплой FA-EX1

Из полного checkout, от root. Скрипт сам вызовет `sudo`, если запущен не от root.

```bash
PI_HEC_LISTEN_HOST=10.10.10.184 bash faex1/bootstrap.sh
```

Что делает `faex1/bootstrap.sh`:

1. Ставит пакеты (`curl`, `build-essential`, `mesa-vulkan-drivers`, …).
2. Копирует дерево в `/opt/pi-hec` (без `node_modules`, `dist`, `target`, `.git`).
3. Создаёт system users и каталоги (`faex1/deploy/systemd/install-users.sh`).
4. Ставит Node 24.21.0 в `/usr/local` и активирует `pnpm@12.0.0`.
5. Собирает llama.cpp и качает `Qwen3.8-27B-Q4_K_M.gguf` в `/var/lib/pi-hec/models/`.
6. `pnpm install` и `tsc -b` control-plane + secret-broker.
7. Если нет `/etc/pi-hec/host-config.json` — генерирует PKI и signed host-config.
8. Копирует клиентские сертификаты в `/home/heir/.pi-hec/pki/`.
9. Включает systemd-сервисы и проверяет inference + mTLS.

Переопределения:

| Переменная | Default |
|------------|---------|
| `PI_HEC_LISTEN_HOST` | `10.10.10.184` |
| `PI_HEC_NODE_VERSION` | `24.21.0` |
| `PI_HEC_PNPM_VERSION` | `12.0.0` |
| `PI_HEC_CLIENT_USER` | `heir` |
| `PI_HEC_GGUF_URL` | Distillio Qwen3.8-27B Q4_K_M |
| `PI_HEC_GGUF_BYTES` | `17772537440` |

Повторный запуск безопасен: существующий `host-config.json` не переписывается.

### Сервисы

| Unit | Процесс | Слушает |
|------|---------|---------|
| `pi-hec-inference.service` | llama-server Vulkan | `127.0.0.1:8000` |
| `pi-hec-control.service` | `dist/start.js` | `8443` mTLS, `8444` enroll |
| `pi-hec-worker.service` | `dist/start-worker.js` | исходящие к control |
| `pi-hec-broker.service` | secret-broker | `/var/lib/pi-hec/broker/inject.sock` |

`pi-hec-runner.service` в дереве есть, bootstrap его **не** включает. Windows-брокер — отдельный бинарник.

Ручной запуск тех же процессов:

```bash
PI_HEC_ETC=/etc/pi-hec node /opt/pi-hec/faex1/apps/control-plane/dist/start.js
PI_HEC_ETC=/etc/pi-hec node /opt/pi-hec/faex1/apps/control-plane/dist/start-worker.js
PI_HEC_ETC=/etc/pi-hec PI_HEC_BROKER_SOCKET=/var/lib/pi-hec/broker/inject.sock \
  node /opt/pi-hec/faex1/apps/secret-broker/dist/start.js
```

Проверка после деплоя:

```bash
systemctl status pi-hec-inference pi-hec-control pi-hec-worker pi-hec-broker
curl -sf http://127.0.0.1:8000/v1/models
openssl s_client -connect 10.10.10.184:8443 -tls1_3 \
  -CAfile /etc/pi-hec/pki/ca.crt.pem \
  -cert /etc/pi-hec/pki/admin.crt.pem \
  -key /etc/pi-hec/pki/admin.key.pem </dev/null
```

Ожидаемый итог bootstrap:

```json
{
  "ok": true,
  "inference": "http://127.0.0.1:8000/v1",
  "control": "https://10.10.10.184:8443",
  "model": "Qwen/Qwen3.8-27B",
  "contextPerSlot": 262144,
  "parallelSlots": 4
}
```

### Пути на хосте

| Путь | Содержимое |
|------|------------|
| `/opt/pi-hec` | production checkout |
| `/etc/pi-hec` | `host-config.json`, `identities.json`, `keys.json`, `pki/` |
| `/var/lib/pi-hec/control/control.sqlite` | control DB |
| `/var/lib/pi-hec/cas` | content-addressed store |
| `/var/lib/pi-hec/index` | индекс репозиториев |
| `/var/lib/pi-hec/models` | GGUF |
| `/var/lib/pi-hec/broker/inject.sock` | secret inject |
| `/var/lib/pi-hec/backup` | restic/AEAD бэкапы |

`bootstrap-host` читает:

| Переменная | Default |
|------------|---------|
| `PI_HEC_ETC` | `/etc/pi-hec` |
| `PI_HEC_LISTEN_HOST` | `10.10.10.184` |
| `PI_HEC_MTLS_PORT` | `8443` |
| `PI_HEC_ENROLL_PORT` | `8444` |
| `PI_HEC_DB_PATH` | `/var/lib/pi-hec/control/control.sqlite` |
| `PI_HEC_CAS_ROOT` | `/var/lib/pi-hec/cas` |
| `PI_HEC_INDEX_ROOT` | `/var/lib/pi-hec/index` |

В `pki/` появляются `ca`, `server`, `admin`, `broker`, `runner`, `worker`, `pi-agent` (`*.crt.pem` / `*.key.pem` / signing keys). Пользователю `heir` копируются только `ca`, `admin`, `broker`, `pi-agent`.

## Инициализация Windows-клиента

FA-EX1 уже должен отвечать на `:8443`.

```powershell
$env:PI_HEC_FAEX1_PASSWORD = "<пароль heir>"
.\client\bootstrap.ps1 -Faex1Host 10.10.10.184 -ControlEndpoint https://10.10.10.184:8443
```

Скрипт ставит Node 24.x и pnpm, собирает extension, забирает PKI по SFTP из `/home/heir/.pi-hec/pki/`, пишет `%USERPROFILE%\.pi-hec\control.env` и проверяет TLS 1.3 + clock skew.

`control.env`:

```text
PI_HEC_CONTROL_ENDPOINT=https://10.10.10.184:8443
PI_HEC_SECURITY_MODE=production
PI_HEC_TLS_CA=%USERPROFILE%\.pi-hec\pki\ca.crt.pem
PI_HEC_TLS_CERT=%USERPROFILE%\.pi-hec\pki\pi-agent.crt.pem
PI_HEC_TLS_KEY=%USERPROFILE%\.pi-hec\pki\pi-agent.key.pem
```

Extension ходит в control plane через брокер, не по этим TLS-путям напрямую.

## Инициализация проекта и runner

Отдельного CLI нет. Операции идут через `ControlPlaneClient` (`@pi-hec/client`): mTLS + RFC 9421 signatures. Воспроизводимый путь — live-тест (нужны PKI из `~/.pi-hec/pki` и `PI_HEC_LIVE_STACK=1`):

```bash
PI_HEC_LIVE_STACK=1 \
PI_HEC_CONTROL_ENDPOINT=https://10.10.10.184:8443 \
PI_HEC_ENROLL_ENDPOINT=https://10.10.10.184:8444 \
PI_HEC_CLIENT_PKI="$HOME/.pi-hec/pki" \
PI_HEC_PROJECT_ID=live.hec.task \
PI_HEC_WORKSPACE_ID=pi-hec-prod-e2e \
PI_HEC_RUNNER_ID=win.broker.1 \
  pnpm exec vitest run faex1/apps/control-plane/test/live-hec-task-project.test.ts
```

Порядок API:

1. `createProject` (admin) — проект создаётся `untrusted`.
2. `setProjectTrust` → `trusted` (`if-match` etag, `approvalId`). Без trust `createRun` отвечает 404 (`UntrustedProjectError`).
3. `createRunnerEnrollmentChallenge` — `runnerPlatform: "windows"`, `permittedProjectIds`.
4. `enrollRunner` на `:8444` (TLS без client cert) — CSR, `proofOfPossession`, `runnerId`.
5. `putBlob` attestation + `createWorkspace` (broker). Без строки workspace `createRun` падает на FK `runs → workspaces`.

Defaults теста: `projectId=live.hec.task`, `workspaceId=pi-hec-prod-e2e`, `runnerId=win.broker.1`.

## Сборка и запуск Windows-брокера

```powershell
cargo build --release -p pi-hec-runner
# либо из корня: pnpm build
```

Бинарник: `target/release/pi-hec-runner.exe`. Процесс — `run_broker()`: named pipe `\\.\pipe\pi-hec-v1-{hash(SID)}`, SQLite, mTLS к control plane.

Обязательные переменные:

| Переменная | Назначение |
|------------|------------|
| `PI_HEC_DATA_DIR` | `broker.sqlite`, `broker.lock` |
| `PI_HEC_CONTROL_URL` | `https://10.10.10.184:8443` |
| `PI_HEC_RUNNER_ID` | enrolled id, например `win.broker.1` |
| `PI_HEC_KEY_ID` | id ключа подписи mutations |
| `PI_HEC_PI_EXECUTABLE` | `node.exe` или `pi`, которым поднимается confined Pi |

Опционально:

| Переменная | Default / смысл |
|------------|-----------------|
| `PI_HEC_IDENTITY_DIR` | `{DATA_DIR}/identity` |
| `PI_HEC_CAPABILITIES_PATH` | `{DATA_DIR}/capabilities.json` |
| `PI_HEC_PI_ARGS` | JSON-массив argv, например `["C:\\…\\cli.js","-p","--no-session",…]` |
| `PI_HEC_PI_STDIO_LOG` | файл stdio confined-процесса |
| `PI_HEC_WORKSPACE_ID` | если задан — ещё `PI_HEC_PROJECT_ID` и `PI_HEC_WORKSPACE_ROOT` |
| `PI_HEC_VOLUME_IDENTITY` | sha256 корня workspace |
| `PI_HEC_ROOT_FILE_IDENTITY` | sha256 `workspaceId` |
| `PI_HEC_SECURITY_MODE` | `production` |

`PI_HEC_PI_ARGS` должен быть JSON-массивом строк. В PowerShell не читайте файл через `Get-Content` без `-Encoding utf8`: не-ASCII в argv ломается.

Файлы identity (`PI_HEC_IDENTITY_DIR`):

```text
mtls.crt
mtls.key
ca.crt
ed25519.key    # 32 байта hex, без префикса
```

Пример запуска:

```powershell
$env:PI_HEC_DATA_DIR = "$env:USERPROFILE\.pi-hec\broker-data"
$env:PI_HEC_IDENTITY_DIR = "$env:USERPROFILE\.pi-hec\broker-identity"
$env:PI_HEC_CONTROL_URL = "https://10.10.10.184:8443"
$env:PI_HEC_RUNNER_ID = "win.broker.1"
$env:PI_HEC_KEY_ID = "broker-1"
$env:PI_HEC_PI_EXECUTABLE = "C:\ProgramData\pi-lifecycle\runtime\node.exe"
$env:PI_HEC_PI_ARGS = Get-Content -Raw -Encoding utf8 "$env:USERPROFILE\.pi-hec\pi-args.json"
$env:PI_HEC_WORKSPACE_ID = "pi-hec-prod-e2e"
$env:PI_HEC_PROJECT_ID = "live.hec.task"
$env:PI_HEC_WORKSPACE_ROOT = "$env:TEMP\pi-hec-prod-e2e"
$env:PI_HEC_SECURITY_MODE = "production"

.\target\release\pi-hec-runner.exe
```

`pi-args.json` задаёт bundle Pi, extension и prompt. Slash-команда срабатывает, когда `-p` начинается с `/hec`:

```json
[
  "C:\\ProgramData\\pi-lifecycle\\runtime\\pi\\dist\\bundle\\cli.js",
  "-p",
  "--no-session",
  "--no-extensions",
  "-e",
  "C:\\ProgramData\\pi-lifecycle\\runtime\\ext\\index.js",
  "--no-tools",
  "/hec fix the failing test without touching the generated file"
]
```

В runtime Pi нужны workspace-пакеты `@pi-hec/{contracts,usage,state-store,domain}` и `@koromix/koffi-win32-x64` рядом с `node.exe`. Без koffi extension не читает AppContainer.

Интерактивно: загрузить `~\.pi-hec\control.env`, затем `pi` и команда `hec` / prompt `/hec …`. Extension соединяется с брокером по named pipe, не с `:8443`.

Успешный production-путь: confined Pi → `/hec` → `START_RUN` → broker `createRun` **201** (`state=CREATED`).

## Разработка

```bash
pnpm install
pnpm check:deps
pnpm lint
pnpm typecheck
pnpm test
pnpm test:evaluation
pnpm test:e2e
pnpm test:security
pnpm build
```

`pnpm check` = deps + lint + typecheck + test + `cargo clippy -D warnings`.

## Статус гейтов

- Секция **2.4** (frozen holdout, 1000 пар): claimed. См. `test/evaluation/harness/section24.ts` и go-live checklist (`holdout-mean-p95-ci`, `quality-uplift-2-4`, `false-verified-rate-2-4`).
- Секция **33** (полный go-live): claimed. См. `test/e2e/golive/section33.ts` и go-live checklist (`section33GatesClaimed`).

Qwen на FA-EX1 — локальный аналитик. Cloud dispatch идёт отдельным cloud deployment; отсутствие Qwen в `cloudDeployments` не мешает `createRun`.
