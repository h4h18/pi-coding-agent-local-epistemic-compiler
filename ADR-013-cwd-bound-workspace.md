# ADR-013: CWD-bound workspace и демон-брокер

- **Статус:** Accepted
- **Дата:** 2026-09-13
- **Контур:** PI-HEC host broker + project onboarding + preflight adapter lock
- **Связанные решения:** ADR-001, ADR-002, ADR-007, ADR-011, ADR-012; архитектура §8, §12, §15, §26–27, §31; спека §5 ADR-011, §13.2 workspace-registration, §15 snapshot
- **Затрагиваемый код:** `native/runner` (`run_broker`, `registered_workspaces`, `START_RUN`), `client/apps/pi-extension`, `@pi-hec/contracts` (broker frames), `@pi-hec/domain` (`project-adapter`), control-plane `profile-runner` / `compiler.ts`, `@pi-hec/instructions`, control API `createProject` / `setProjectTrust` / `createWorkspace`

## Контекст

Целевой UX: пользователь переходит в каталог любого репозитория и вызывает `/hec`. Run, snapshot, adapter, verification и `/hec apply` относятся **к git-root этой папки**, а не к дереву PI-HEC и не к единственному env-workspace, с которым стартовал runner.

Текущий путь это запрещает.

```text
PI_HEC_WORKSPACE_ID + PI_HEC_WORKSPACE_ROOT + PI_HEC_PROJECT_ID
  → bootstrap_workspace_from_env  (один INSERT)
  → run_broker() запускает confined Pi и умирает вместе с ним
  → /hec START_RUN { workspaceAlias: basename(cwd) }
  → lookup_workspace WHERE workspace_id = alias
```

Следствия:

1. **Инверсия жизненного цикла.** Брокер — родитель одного Pi, не демон. `CreateProcess` не ставит cwd проекта (`lpCurrentDirectory = None`). Самостоятельно запущенный `cd && pi` не проходит `validate_confined_client` (`in_broker_job`). Production `/hec` отказывает unconfined клиенту.
2. **Неверная идентичность.** Alias = последний сегмент пути. `MyApp` ≠ `my-app`. Два репозитория с одним именем папки неразличимы. `ProjectIdSchema` (`^[a-z0-9][a-z0-9._-]*$`) не совпадает с произвольным именем каталога.
3. **Нет onboarding.** `/hec init` только пишет alias в session pointer. `createProject` → `setProjectTrust` → enroll `permittedProjectIds` → `createWorkspace` живут в live-тесте. Без `trusted` `createRun` даёт 404. FK `runs → workspaces` требует строку workspace заранее.
4. **Путь workspace неизменяем.** `register_workspace` — INSERT. Повторный старт с другим `PI_HEC_WORKSPACE_ROOT` не переписывает корень. Fingerprint в live-пути считается от `workspaceId`, не от дерева.
5. **Адаптер не из папки.** `profile-runner` и `compiler.ts` вызывают `lockProjectAdapter(undefined)`. Verification packs ADR-012 резолвятся в дефолты `pnpm`/`specs/`, не в команды целевого стека.
6. **One-shot argv.** Production-пример — `PI_HEC_PI_ARGS` с `-p "/hec …"`. Это не интерактивный TUI из произвольного cwd.

Архитектура уже формулирует нужное поведение и не реализует его: preflight «находит Git root через broker» (§8); workspace-registration требует approval и новый subject при drift корня (§13.2 спеки); snapshot принимает только зарегистрированный absolute local-volume root (§15.1); project adapter валидируется control’ом и даёт `project-lock` (§26).

Инварианты, которые решение не имеет права нарушить:

- ADR-001: Pi extension — untrusted UX. Не оркестратор, не signer, не writer workspace.
- ADR-011: production Pi — AppContainer + broker Job. User-token Pi = `COMPATIBILITY_UNCONFINED`, без role-isolation claims.
- ADR-002: control plane на FA-EX1 — единственный writer authoritative state. Control plane не ставится в целевой git.
- ADR-007: канонизация пути, volume serial, file ID, `GetFinalPathNameByHandleW` — в Rust runner, не в TypeScript-строках.
- Workspace = snapshot-overlay. Apply в user tree только explicit (`/hec apply`).
- `network.default: deny` адаптер не ослабляет. `nestedDelegation: false`.
- Pi не диктует корень записи. Claimed path из extension не является authority.

## Решение

Сессия HEC биндится к **каноническому git-root на локальном томе**, который установил и проверил **брокер**. Pi выбирает папку только как UX cwd. Брокер живёт как per-user демон и attach’ит confined TUI к уже выбранному workspace.

```text
cd <repo>
hec                  # attach-launcher, тот же principal что брокер
  → демон-брокер канонизирует git-root
  → ENSURE_WORKSPACE (тихо, если уже registered+trusted)
  → spawn confined Pi в Job брокера, session.workspaceId = bind
/hec <задача>
  → START_RUN по workspaceId сессии, не по basename(cwd)
  → snapshot этого корня
  → project-lock из adapter в snapshot
  → DAG / overlay / apply — только этот корень
```

### 1. Демон-брокер и attach

`pi-hec-runner` разделяет два режима:

| Режим | Поведение |
|---|---|
| `serve` (default, долгоживущий) | Открывает named pipe, claim loop, **не** запускает Pi. Живёт, пока жив пользовательский сеанс. |
| `attach` | Привилегированный helper того же SID. Передаёт брокерy наблюдаемый cwd. Брокер канонизирует, биндит session, спавнит confined Pi в свой Job. |

Handshake не требует «это единственный child, который мы только что создали». Требует: тот же user SID, AppContainer, restricted token, **этот** Job брокера, совпадение claimed PID/creation time. Несколько confined Pi к одному демону допустимы; у каждого соединения свой `workspaceId`.

`CreateProcess` для TUI не обязан иметь cwd = project root. HEC mode блокирует tools и shell Pi. Корень нужен брокеру для snapshot/promotion, не AppContainer’у для записи.

Отдельный `PI_HEC_DATA_DIR` на каждый репозиторий запрещён как основной путь. Один `broker.sqlite` держит много `registered_workspaces`.

`PI_HEC_WORKSPACE_ID` / `ROOT` / `PROJECT_ID` остаются bootstrap-override для e2e и recovery, не продуктовый onboarding.

### 2. Ключ workspace

Source of truth локальной привязки:

```ts
type WorkspaceBindKey = {
  canonicalRoot: string;      // GetFinalPathNameByHandleW, без UNC/WebDAV/device
  volumeIdentity: string;     // volume serial
  rootFileIdentity: string;   // file ID корня
};
```

Lookup:

1. Открыть handle на путь attach-launcher’а (не на строку extension).
2. Запретить UNC, WebDAV, device namespace, drive-relative, reparse, которые уводят с тома (спека §15.1).
3. Подняться до git-root (`inspect_git`). Нет git → `BLOCKED` / вопрос пользователю, не «взять cwd как есть» молча.
4. Найти строку по `(volumeIdentity, rootFileIdentity)`. Не по alias. Не по basename.
5. Сверить `canonicalRoot`. Расхождение = drift → новый `workspace-registration` subject, не silent rewrite.

`workspaceId` на control plane — стабильный id (`^[a-z0-9][a-z0-9._-]*$`), не имя папки. Производный порядок:

1. `.pi/hec.json` `projectId` / `workspaceId` **после** project-trust (файл в snapshot, не authority до lock).
2. Иначе стабильный slug от канонического git remote `origin` (NFC, усечённый под schema).
3. Иначе брокер генерирует id и хранит его только в своей таблице + control plane. Переименование папки не создаёт второй проект.

`workspaceAlias` остаётся отображаемым ярлыком и override (`PI_HEC_WORKSPACE_ALIAS`). `START_RUN.workspaceAlias` больше не ключ lookup. После attach ключ — `workspaceId` сессии pipe.

Extension по-прежнему может прислать alias. Брокер **игнорирует его как authority**, если соединение уже bound attach’ем. Неbound соединение в production отказывается, а не угадывает по basename.

### 3. ENSURE_WORKSPACE

Новый broker method, вызываемый `hec attach` и `/hec init`. Не vitest, не ручной `ControlPlaneClient`.

```text
ENSURE_WORKSPACE
  → bind key из наблюдаемого пути
  → если local row + control workspace + project trusted + runner grant
        → READY, session bound
  → иначе церемония в trusted UI, по шагам:
        createProject (untrusted)
        ApprovalChallenge project-trust
        setProjectTrust
        расширить runner grant (permittedProjectIds)
        putBlob attestation
        ApprovalChallenge workspace-registration
          subject = canonicalRoot + volume + fileId + runnerId + platform
        createWorkspace
        local register_workspace (реальный корень, не INSERT-игнор)
```

Правила церемонии:

- Silent auto-trust запрещён. Первый заход в папку — короткие approval’ы в trusted UI, не «просто завелось».
- Replay той же registration с тем же subject идемпотентен (спека). Drift корня/runner/platform — новый subject и новый grant.
- `createProject` не подписывает недоверенный Pi. Либо брокер имеет узкий capability `workspace-enroll` для своего principal, либо trusted UI коммитит admin/user approval, а брокер только поставляет attestation. Principal и grant выбирает control plane, не JSON extension.
- Повторный `/hec` в той же папке церемонию не повторяет.

`/hec init` становится UX над `ENSURE_WORKSPACE`, а не записью alias.

### 4. START_RUN после bind

```text
START_RUN
  params: originalRequest, attachmentHandles, requestedDeploymentId?
  session → workspaceId (уже bound)
  recovery_state MUST be READY
  createRun(projectId, workspaceId, task)
```

`workspaceAlias` в схеме можно оставить optional для совместимости кадров; сервер lookup по нему не делает, если session bound. Неbound START_RUN в production — ошибка, не fallback на basename.

Snapshot и promotion читают `root_path` из локальной строки workspace (DPAPI), как сейчас, но корень принадлежит bind key, а не env.

### 5. Project adapter из snapshot этой папки

После sealed snapshot, до `selectAndPersistProfile`:

1. Найти в snapshot `.pi/hec-adapter.yaml`. Нет файла → `lockProjectAdapter(undefined)` (авто-дефолты), `tightened: false`.
2. Есть файл → `validateProjectAdapter` + `mergeTightening` с immutable defaults. Ослабление `network.default` отвергается.
3. Canonical JSON → CAS artifact role `project-lock`.
4. `profile-runner` / `compiler.ts` / ADR-012 packs читают **этот** lock, не `undefined`.

Адаптер — не workflow script и не исполняется на discovery (архитектура §26). Команды verification попадают в allowlist lock текущего run. Автодетект `package.json` / `Cargo.toml` может быть **предложением** в preflight; в lock они входят только после schema и (если tightening) без ослабления policy.

`AGENTS.md` и `.pi/skills` уже умеет `@pi-hec/instructions`. Preflight обязан брать их из **этого** snapshot, не из checkout PI-HEC.

### 6. Глобальный TUI `/hec`

- `@pi-hec/pi-extension` ставится в `~\.pi\agent\extensions\` (user/global). Не копируется в `.pi/extensions/` целевого репозитория: project-local Pi-extensions грузятся только после Pi project-trust и не являются control plane (ADR-001).
- `hec` / `pi-hec-runner attach` — вход из cwd. Интерактивные `/hec`, `/hec status`, `/hec agents`, `/hec apply` без перезапуска демона.
- `PI_HEC_PI_ARGS` one-shot остаётся для golden/e2e, не для повседневной разработки.

### 7. Фазы внедрения

Решение одно. Поставка нарезается, чтобы не смешивать onboarding с verification.

| Фаза | Готовность |
|---|---|
| **A** | Демон + attach + bind по `(volume, fileId)` + `ENSURE_WORKSPACE` + `START_RUN` без alias-lookup. `/hec` в папке снимает правильный snapshot. |
| **B** | Adapter из `.pi/hec-adapter.yaml` → `project-lock` → packs в compiler. Gates принадлежат стеку папки. |
| **C** | Глобальный extension, несколько сессий на демон, rebind после переезда репо через новый registration subject. |

Фаза A без B даёт правильный корень и чужие дефолтные команды. Это допустимый промежуточный инвариант, его нельзя называть «проект адаптирован».

## Последствия

### Положительные

- `cd <repo> && hec && /hec …` выбирает этот git-root без live-теста и без второго `DATA_DIR`.
- Имя папки, регистр и кириллица перестают быть ключом control plane.
- Несколько репозиториев живут в одном брокере.
- Первый заход остаётся явной церемонией trust/registration — короче, чем API-прогон, без silent trust.
- ADR-012 packs начинают значить что-то вне дерева PI-HEC.
- Production confinement сохраняется: пользователь не запускает writable `pi` «просто так».

### Отрицательные / стоимость

- Runner перестаёт быть «запустил Pi и вышел». Нужен serve-режим, attach, session table на соединении, переживание смерти Pi без смерти брокера.
- Control plane должен уметь расширять runner grant на новый project без полного re-enroll, либо ENSURE обязан проходить enroll-challenge. Сейчас `permittedProjectIds` фиксируется на enroll.
- Нужен broker capability или trusted-UI путь для `createProject`, которого у Pi нет.
- `START_RUN` / `BrokerRequest` schema bump: session-bound workspace вместо alias-as-key.
- Lookup по file ID ломается, если корень пересоздали (clone заново). Это drift → новая registration, не «найти по path string».
- Пока Фаза B не сделана, чужой репозиторий без адаптера гоняет дефолтный `pnpm` pack — ложный смысл «заработало».
- AppContainer по-прежнему не пишет user tree; пользователь, который ждёт, что `/hec` = обычный Pi edit в cwd, получит overlay + apply. Это продукт, не регресс.

### Обязательные запреты

- Не принимать путь или alias от extension как корень snapshot/promotion.
- Не делать silent `setProjectTrust` / silent `createWorkspace`.
- Не ослаблять `network.default` адаптером или AGENTS.md.
- Не stash/reset/commit пользовательской ветки, чтобы «просто начать».
- Не ставить control plane, broker sqlite или PKI в целевой git.
- Не считать `COMPATIBILITY_UNCONFINED` (`cd && pi` user-token) production-путём.
- Не использовать basename папки как `projectId` / `workspaceId`.
- Не держать один workspace на брокер через env как продуктовый onboarding.
- Не читать adapter из working tree в обход sealed snapshot.
- Не класть HEC extension в `.pi/extensions/` чужого репо как способ «подключить систему».
- Не обновлять `root_path` в `registered_workspaces` без нового `workspace-registration` grant.

## Критерий выполнения

Решение считается внедрённым, когда:

1. Брокер в `serve` переживает выход Pi; второй `attach` из другой папки не требует рестарта и не делит workspace с первой.
2. `cd D:\work\my-app && hec` затем `/hec init` регистрирует git-root `D:\work\my-app` (канонический), а не basename и не `PI_HEC_WORKSPACE_ROOT` от прошлого запуска.
3. Повторный `/hec <задача>` в той же папке не показывает trust/registration, если bind key не изменился.
4. `START_RUN` без bound session в production отвергается. Alias-only lookup отсутствует.
5. Два репозитория с именем папки `app` получают разные workspace и разные snapshot.
6. Перенос корня на другой volume / смена file ID требует нового `workspace-registration`, user tree не трогается.
7. Unconfined `pi` в production не стартует run.
8. После Фазы B: `.pi/hec-adapter.yaml` в snapshot становится `project-lock`; packs compiler’а берутся из него; ослабление network отвергается.
9. `/hec apply` пишет в зарегистрированный корень этой сессии.
10. Golden/e2e env-override (`PI_HEC_WORKSPACE_*`) сохраняется и не является единственным путём регистрации.

## Альтернативы, которые отвергнуты

| Альтернатива | Почему нет |
|---|---|
| Оставить env-один-workspace и документировать ручной live-тест | UX «перейти в папку» не существует |
| Доверять `workspaceAliasFromCwd` / `ctx.cwd` extension | ADR-011: Pi лжёт; claimed path ≠ handle |
| User-token `cd && pi` как основной путь | Явно `COMPATIBILITY_UNCONFINED`; не проходит production acceptance |
| Копировать PI-HEC / extension в целевой репозиторий | Control plane не живёт в проверяемом git; путает product и substrate |
| Авто-trust при первом `/hec` | Спека: untrusted project не получает workspace/runs |
| Ключ = canonical path string без file ID | Junction/rename/reparse; спека §15.1 требует handle identity |
| Отдельный `broker.sqlite` на каждый репозиторий | Ломает один демон, усложняет enroll и promotion journal |
| Читать adapter из live working tree до snapshot | Dirty tree и TOCTOU против sealed baseline |
| Сделать `/hec` обычным Pi tool loop в cwd | HEC mode блокирует tools; writer — overlay + VM (ADR-008) |
| Nested «агент-онбордер», который спавнит регистрацию | Агент не контролёр; registration — broker + control + approval |

## Ссылки

- `native/runner/src/operations.rs` — `run_broker`, `start_run`, `bootstrap_workspace_from_env`
- `native/runner/src/local_store.rs` — `lookup_workspace`, `register_workspace`
- `native/runner/src/platform/windows/jobs.rs` — `launch_confined`
- `native/runner/src/platform/windows/mod.rs` — `validate_confined_client`
- `client/apps/pi-extension/src/commands.ts` — `/hec init`, `START_RUN` alias
- `client/apps/pi-extension/src/index.ts` — `PI_HEC_WORKSPACE_ALIAS`
- `packages/contracts/src/schemas/broker.ts` — `START_RUN`
- `packages/domain/src/project-adapter.ts`
- `faex1/apps/control-plane/src/services/profile-runner.ts`
- `faex1/apps/control-plane/src/orchestration/compiler.ts`
- `faex1/apps/control-plane/test/live-hec-task-project.test.ts`
- `PI_HYBRID_EPISTEMIC_COMPILER_IMPLEMENTATION_SPEC.md` §5 ADR-011, §13.2, §15
- `Pi Coding Agent надёжная мультиагентная система разработки — исправленная архитектура.md` §8, §15, §26, §31
- `ADR-012-profile-composition-engine.md` — packs требуют adapter целевого проекта
- [Pi extensions](https://pi.dev/docs/latest/extensions) — global vs project-local discovery
