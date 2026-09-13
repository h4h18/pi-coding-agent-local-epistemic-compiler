# PI-HEC Multi-Agent: надёжная мультиагентная система разработки

Адаптация исходного черновика под топологию, trust model и пакеты уже построенного PI-HEC.

**Это мультиагентная система.** Не «эпистемический компилятор с одним cloud completion», в котором роли размазаны по пакетам. Отдельные cloud-сессии с отдельным контекстом, tool profile, artifact type и запретом self-approval. Control Plane не агент и не чат: он запускает работников, принимает типизированные артефакты и один решает, какой узел DAG следующий.

**Статус:** эволюция PI-HEC 1.1 → multi-agent control plane.  
**Что явно снимается из v1:** инварианты «обычный успешный путь = один cloud completion», «запрет параллельных cloud completions», «cloud не получает tool loop», метрика `Strict-1C` как главная цель.  
**Что сохраняется:** ADR-001/002/007/008/010/011, запрет local model писать код, запрет LLM объявлять задачу принятой, snapshot вне user tree, disposable VM для команд, SQLite+CAS, нет экономических квот.  
**Trigger из §29.5, который этим документом считается сработавшим:** продукт требует отдельные headless-сессии (`Pi SDK supervisor`).  
**Дата:** 2026-09-13.  
**Хост:** Windows 11 + FA-EX1 (`SINGLE_HOST`), Pi `@earendil-works/pi-coding-agent` 0.84.3.

Предыдущая адаптация была ошибкой: она сохранила инфраструктуру и уничтожила продукт. Ниже — обратная сборка. Мультиагентность остаётся центром. Меняется только то, *где* живут оркестратор, state и sandbox, потому что черновой «trusted Pi extension + pi-subagents» на этой машине не является доверенным контролёром.

```text
Продукт (из черновика, без сжатия)
  analyst / investigator / planner / implementer / reviewer
  как отдельные cloud-агенты
  + specialist roles после стабилизации
  + profile DAG (feature, bugfix, research, spec, refactor)
  + typed artifacts, independent review, repair loop

Субстрат (из PI-HEC, без подмены ролей)
  /hec UX → Windows broker → FA-EX1 control plane
  control.sqlite + CAS + operations
  snapshot + disposable VM
  local Qwen только classification + retrieval ranking
```

Так делают и соседние системы 2026 года: Orkestra, Revo, pm-go, Spec Guard. Агенты — короткоживущие недоверенные работники с typed result. Cursor процесса, policy и DoD принадлежат детерминированному ядру. Claude Code Agent Teams для сравнения — наоборот: lead тоже модель, координация файлами в `~/.claude`. Этот путь отвергается: модель не оркестрирует модели.

---

## 1. Назначение

Система автономно выполняет широкий класс задач разработки: реализация, исправление, исследование, спецификации, рефакторинг, обслуживание. Пользователь формулирует задачу один раз. Дальше работают агенты до доказательно готового результата. Вопрос пользователю — только при настоящем блокере.

Цель — не «рой, способный идеально решить любую задачу», а **мультиагентный контур с явными ролями, явными артефактами и явными границами доказательности**. Универсален orchestration-протокол. Правила сборки, тестов и проверки всегда зависят от проекта.

Разделение полномочий:

| Плоскость | Кто | Делает | Не делает |
|---|---|---|---|
| Interaction | Pi extension `/hec` | Команды, статус, preview агентов | Spawn, state, approvals, tools |
| Privilege | `pi-hec-runner` | Snapshot, confinement, promotion | Cloud credentials, agent loop |
| Control | FA-EX1 TypeScript control plane | DAG, права, spawn, schema, acceptance | Инженерные решения, код |
| Local model | Qwen 3.8-27B | Классификация запроса, ranking RAG, поиск дыр в контракте | Код, план, review, spawn |
| Cloud agents | отдельные сессии | Контракт, исследование, план, код, semantic review | Переходы state, apply, self-approval |
| Verification | Command broker + disposable VM | Исполняемые gates, provenance | Смысловой accept |
| Acceptance | Control + user/broker | DoD, apply grant | Авто-merge |

Local model не решает задачу даже при изменении одного–трёх файлов. Это не делает её «следователем»: следователь — cloud `investigator`.

---

## 2. Гарантии

### Система гарантирует

- Ни один агент не пропускает обязательный узел DAG и не объявляет run принятым.
- У каждой cloud-роли свой session id, tool profile, artifact schema и capability token.
- `implementer` не принимает свой результат. `reviewer` работает в новой сессии без write tools.
- Все мутации репозитория вне пользовательской working tree.
- Каждый acceptance criterion связан с проверяемым evidence.
- Команды, Git, пути записи и state transitions выполняет обычный код.
- После сбоя run восстанавливается из SQLite + CAS + handles агентов.
- Стоимость и токены видны и не являются квотой.

### Система не гарантирует

- Абсолютную корректность неизвестной программы.
- Безопасность одного Git worktree без VM.
- Автоопределение правильных test/build команд для любого стека.
- Детерминированность LLM, сети и flaky tests.
- Production deploy без явной policy.

---

## 3. Trust model

Правило черновика сохраняется: **Control Plane не живёт в проверяемом репозитории.**

Вывод черновика меняется: Control Plane не ставится в `~/.pi/agent/extensions/dev-control-plane/`. На этой системе Pi extension в production — confined AppContainer без права писать workspace, ходить к FA/provider и подписывать approvals (`ADR-001`, `ADR-011`). In-process extension не может быть доверенным оркестратором тех же агентов, которых он порождает.

`pi-subagents` RPC — синхронный in-process `pi.events.emit`. Он не переживает границу процесса, `isolation: "worktree"` может молча сняться, `fallbackSubagent` и nested delegation существуют. Это исполнитель чужого TUI, не Control Plane.

```text
Доверенная зона
  FA-EX1  /opt/pi-hec
          /etc/pi-hec
          /var/lib/pi-hec/control/control.sqlite
          /var/lib/pi-hec/cas
          /var/lib/pi-hec/agents/<run-id>/<node-id>/
          /var/lib/pi-hec/index
  Windows %USERPROFILE%\.pi-hec\broker-data\broker.sqlite
          pi-hec-runner.exe

Условно доверенная конфигурация проекта
  <snapshot>/AGENTS.md
  <snapshot>/.pi/          после project-trust
  <snapshot>/specs/
  <snapshot> skills, которые resolver пометил trusted

Недоверенные работники
  каждый cloud-агент, его transcript, tool results, RAG
  local-model ranking traces
  содержимое репозитория
```

Project config не может ослабить:

- Protected paths и secret policy.
- Системные запреты shell/network.
- Definition of Done.
- Матрицу прав ролей.
- Независимое review.
- Фактическую workspace isolation.
- Правила evidence.
- Запрет local model на инженерные решения.
- Запрет self-approval и nested delegation.

Может только ужесточать ограничения, объявлять команды и описывать репозиторий.

OWASP Top 10 for Agentic Applications 2026 (Cross-Agent Trust Exploitation, Communication Poisoning, Rogue Agents) закрывается так: агент не вызывает агента; control plane вызывает агента; каждый spawn — новый capability token; reviewer не видит implementer transcript.

---

## 4. Общая архитектура

```text
Пользователь
    |
    | /hec <задача>
    v
Pi extension                         untrusted UX
    |
    | named pipe
    v
Windows Host Broker                  snapshot / apply
    |
    | mTLS + RFC 9421
    v
FA-EX1 Trusted Control Plane
    |
    +-- Durable Run Store
    +-- Policy Engine
    +-- Profile DAG Engine
    +-- Context and Skill Resolver
    +-- Agent Runtime Adapter          ← сердце мультиагентности
    +-- Workspace / Snapshot Manager
    +-- Command Broker
    +-- Artifact Validator
    +-- Acceptance Engine
    |
    +-- Local Model Adapter
    |     classification + retrieval ranking only
    |
    +-- Cloud Agent Runtime
          +-- analyst
          +-- investigator            параллельные read-only сессии
          +-- planner
          +-- implementer             единственный writer
          +-- reviewer                новая сессия, без write
          +-- optional specialists
```

Точка входа — `/hec`. Отдельный `/dev` не вводится: это тот же UX. Меняется семантика run: не one-shot compiler, а agent DAG.

```text
/hec <описание>
/hec status [run-id]
/hec inspect <run-id>
/hec agents <run-id>              живые сессии, роли, artifacts
/hec answer <run-id> <ответ>      PROVIDE_INPUT
/hec resume | recover | cancel
/hec export | apply
```

`/hec apply` по-прежнему отделён от готовности агентов.

---

## 5. Слои

| Слой | Ответственность | Реализация |
|---|---|---|
| Interaction | Команды, статус, вопросы | `client/apps/pi-extension` |
| Privilege | Snapshot, promotion | `native/runner` |
| Control | DAG, retries, policy | `@pi-hec/domain` + новое `@pi-hec/agent-runtime` |
| Context | AGENTS/spec/skills, index, RAG | `@pi-hec/instructions`, `@pi-hec/repository` |
| Agent runtime | Fast spawn, resume, steer, stop | control-owned adapter на FA-EX1 |
| Workspace | Snapshot, lease overlay, isolation verify | broker + sandbox |
| Execution | Инженерная работа | cloud-агенты |
| Verification | Build, tests, lint, reproduction | `@pi-hec/verification` + VM |
| Evidence | Immutable artifacts | `@pi-hec/cas` |
| Acceptance | DoD, criteria ledger | control engine |

---

## 6. Durable Run Store

Не `.pi/runs` в репозитории и не `%LOCALAPPDATA%\pi-dev`. Authoritative store остаётся пользовательским по владению (FA-EX1 host), недоступным writers для прямой записи и живым после удаления overlay.

```text
/var/lib/pi-hec/control/control.sqlite
/var/lib/pi-hec/cas
/var/lib/pi-hec/agents/<run-id>/
    <node-id>/
      session.json
      transcript.jsonl
      artifacts/
      command-output/
    events продолжают писаться в control events
```

`run.db` смысла в отдельном файле на run нет: один WAL, один reducer. У run появляются дочерние сущности.

```ts
interface AgentNodeEvent {
  eventId: string;
  runId: string;
  nodeId: string;
  sequence: number;
  type: "NODE_SPAWNED" | "ARTIFACT_ACCEPTED" | "NODE_FAILED" | "NODE_COMPLETED";
  state: RunState;
  actor: "control";
  agentId?: string;
  timestamp: string;
  payloadHash: string;
  payload: unknown;
}
```

Переход транзакционен: событие, materialized state, набор следующих узлов. Повтор того же `operationId` безопасен.

---

## 7. Run lifecycle

Грубый контур из черновика сохраняется. Мелкие HEC-состояния snapshot/egress/apply не выкидываются: они — обвязка, не замена агентов.

```text
CREATED
  → PREFLIGHT                  snapshot, instructions, baseline, TaskProfile hint
  → CONTRACTED                 cloud analyst сдал Task Contract
  → PROFILE_SELECTED           control выбрал DAG
  → PROFILE_RUNNING            узлы агентов и controller operations
  → ACCEPTANCE_CHECK
  → READY                      = VERIFIED_ACCEPTED + AWAITING_APPLY_APPROVAL

Любое активное
  → WAITING_FOR_USER
  → BLOCKED
  → FAILED
  → CANCELLED
```

`PROFILE_RUNNING` — это не одно состояние-мешок. Внутри него control держит node cursor:

```ts
type NodeStatus =
  | "PENDING"
  | "SPAWNED"
  | "WAITING_ARTIFACT"
  | "VALIDATING"
  | "ACCEPTED"
  | "RETRYING"
  | "FAILED";
```

Существующие 65 `RunState` расширяются, а не схлопываются. Новые фазы (`CONTRACTED`, `PROFILE_SELECTED`, `PROFILE_RUNNING`, node-level) — часть этой эволюции. One-shot ветка `CLOUD_DISPATCHING → SOLUTION_RECEIVED` перестаёт быть единственным путём исполнения.

```ts
interface WorkflowProfile {
  id: string;
  appliesTo: TaskKind[];
  nodes: WorkflowNode[];
  requiredArtifacts: ArtifactType[];
  acceptancePolicy: AcceptancePolicy;
}

interface WorkflowNode {
  id: string;
  role?: AgentRole;
  operation?: ControllerOperation;
  dependsOn: string[];
  when?: Predicate;
  retryPolicy: RetryPolicy;
  invalidates?: string[];
  concurrencyGroup?: "read" | "write" | "review";
}
```

Research не гоняется через code integration. Spec-only не гоняется через build, если build не доказывает criterion.

---

## 8. Preflight

До первого cloud-агента Control Plane:

1. Находит Git root и canonical paths через broker.
2. Снимает HEAD, index, fingerprint, branch.
3. Детектит submodules, sparse, LFS, case-sensitivity.
4. Находит project config, AGENTS, specs, skills в snapshot.
5. Проверяет project-trust.
6. Создаёт sealed snapshot — это и есть synthetic baseline.
7. Определяет verification commands как предложения.
8. Гоняет разрешённые baseline checks в VM.
9. Фиксирует `policy-lock`, `project-lock`, `baseline-seal`, `task-profile` hint.

Автообнаруженные команды не исполняются, пока не пройдут allowlist и не попадут в lock текущего run.

Local model на этом шаге только классифицирует kind/risk *как hint* и ранжирует optional RAG. В контракт hint не попадает, пока cloud analyst не подтвердит поля, а control не проверит schema.

---

## 9. Task Contract

Контракт пишет **cloud `analyst`**, не local model и не детерминированный экстрактор в одиночку. Local может разметить пробелы. Semantic fields добавляет и исправляет только analyst. Control принимает объект только после JSON Schema, evidence refs и проверки логических конфликтов. Невалидный JSON возвращается *тому же* analyst session как validation errors. Local schema repair запрещён.

```json
{
  "taskId": "DEV-2026-0913-001",
  "kind": "feature",
  "objective": "Наблюдаемый итог",
  "inScope": ["..."],
  "outOfScope": ["..."],
  "constraints": ["..."],
  "assumptions": [
    {
      "id": "A-1",
      "text": "...",
      "reversible": true,
      "evidence": ["repo:path:line"]
    }
  ],
  "acceptanceCriteria": [
    {
      "id": "AC-1",
      "statement": "...",
      "verification": ["test", "inspection"],
      "requiredEvidence": ["command", "diff"]
    }
  ],
  "riskFlags": ["public-api"],
  "specPolicy": {
    "paths": ["specs/..."],
    "behaviorChanges": true,
    "updateRequired": true
  },
  "blockingQuestions": []
}
```

В PI-HEC это новый artifact role `task-contract` рядом с `task-envelope` (исходный user text) и `requirement-ledger` (control проецирует принятый контракт в ledger, чтобы verification продолжал есть `RequirementId`).

Analyst не получает write tools и не видит последующий implementer context.

---

## 10. Agent Runtime Adapter

Control Plane не зависит от внутренней реализации одного расширения. Это и есть место, где система становится мультиагентной.

```ts
type AgentRole =
  | "analyst"
  | "investigator"
  | "planner"
  | "implementer"
  | "reviewer"
  | "spec-reviewer"
  | "security-reviewer"
  | "architecture-reviewer"
  | "test-reviewer"
  | "performance-reviewer"
  | "conflict-resolver"
  | "final-synthesizer";

interface SpawnRequest {
  runId: string;
  nodeId: string;
  role: AgentRole;
  modelDeploymentId: string;
  toolProfile: "read" | "write" | "review";
  workspaceLeaseId?: string;
  inputArtifacts: ArtifactReference[];
  outputSchema: string;
  idempotencyKey: string;
  inheritTranscriptFrom?: string;
}

interface AgentRuntime {
  capabilities(): Promise<RuntimeCapabilities>;
  spawn(request: SpawnRequest): Promise<AgentHandle>;
  consume(handle: AgentHandle): Promise<AgentResult>;
  steer(handle: AgentHandle, message: string): Promise<void>;
  stop(handle: AgentHandle): Promise<void>;
  reconcile(runId: string): Promise<RuntimeSnapshot>;
}
```

Порядок реализаций — обратный черновому:

1. **`ControlPlaneSessionAdapter` (MVP).** FA-EX1 worker поднимает headless сессию через Pi SDK `createAgentSession` / `createAgentSessionRuntime`: свой `SessionManager`, свои `customTools`, `noTools: "builtin"`, без project extensions. Это ровно trigger «Pi SDK supervisor». Cloud credentials видит только этот worker, не Windows Pi и не агентный overlay.
2. **`DirectProviderLoopAdapter`.** Тот же tool loop без SDK, если SDK мешает isolation. Расширение `@pi-hec/cloud-gateway` с one-shot до multi-turn *внутри одной роли*, не как замена ролей.
3. **`PiSubagentsRuntimeAdapter` — не первая и не default.** Допустим только если capability handshake показал нужные операции *и* spawn идёт из FA-EX1 процесса, не из confined Windows Pi. `fallbackSubagent=none`, `nestedDelegation=false`. Worktree parameter не считается isolation, пока Workspace Manager не выставил `isolationVerified`.

Capability handshake обязателен. Версия пакета не доказывает наличие `steer`/`resume`.

Агенты не получают инструмент «запусти другого агента». Nested delegation запрещён. Параллель делает DAG engine.

---

## 11. Artifact Bridge

Агент не пишет control-state и не завершает узел свободным текстом. Каждый worker видит минимальный набор tools, которые ходят в control plane. Это аналог чернового `dev-agent-bridge`, но это **customTools сессии на FA-EX1**, не extension внутри пользовательского Pi.

```text
request_context
submit_artifact
report_progress
report_blocker
```

`submit_artifact`:

1. Проверяет capability token, `runId`, `nodeId`, `agentId`, session id.
2. Проверяет допустимый artifact type для роли и узла.
3. JSON Schema.
4. Ссылки на evidence.
5. Пишет в CAS + control store.
6. Content hash, immutable reference.
7. Событие `ARTIFACT_ACCEPTED`.

```ts
interface ArtifactEnvelope<T> {
  schemaVersion: string;
  artifactType: string;
  runId: string;
  nodeId: string;
  agentId: string;
  producedFromCommit?: string;
  inputs: ArtifactReference[];
  payload: T;
}
```

Последнее сообщение агента — пояснение. Authoritative output — принятый артефакт.

Минимальные типы:

| Роль | Artifact |
|---|---|
| analyst | `task-contract` |
| investigator | `investigation-report` |
| planner | `implementation-plan`, optional `change-shards` |
| implementer | `change-manifest`, `changeset` / overlay commit |
| reviewer | `review-findings` |
| controller | `command-evidence`, `verdict-report`, `acceptance-ledger` |

---

## 12. Контекст и skills

Контекст собирает control **до** spawn, слоями:

1. Immutable role policy и output schema.
2. Task Contract.
3. AGENTS/constitution с origin и hash.
4. Specs и сценарии.
5. Выбранные skills с причиной и hash.
6. Релевантные исходники, symbols, тесты, история.
7. Артефакты предыдущих узлов этой роли-цепочки.
8. RAG, явно помеченный untrusted.

Агент не видит чужие transcripts. Reviewer не видит implementer chain-of-thought. Investigator A не видит investigator B до contradiction-узла, если профиль не требует иначе.

Skill Resolver до spawn:

```text
Task kind + risk flags + changed behavior
  → hard rules
  → candidate skills
  → local-model ranking optional candidates
  → dependency expansion
  → conflict resolution
  → skill-lock.json
  → assembled worker context
```

Hard rules (код, не prompt):

```text
bug            → debugging + project-testing
refactor       → behavior-preservation + project-architecture
spec           → spec-read + spec-write
behaviorChange → spec-read + spec-write
public-api     → api-compatibility
migration      → migration-safety
```

Именно поэтому вводится мультиагентность с control-owned skills: Qwen-класс модели не вызывает `spec-read`/`spec-write` по инструкции. Prompt-enforcement отвергнут повторно.

---

## 13. Роли — настоящие агенты

MVP — пять cloud-ролей. Это отдельные сессии, отдельные модели могут отличаться, отдельные права.

| Роль | Права | Обязанность | Терминальный артефакт |
|---|---|---|---|
| `analyst` | read + artifact bridge | Task Contract и критерии | `task-contract` |
| `investigator` | read + safe commands | Repo evidence, behavior, root cause | `investigation-report` |
| `planner` | read + artifact bridge | План, зависимости, shards | `implementation-plan` |
| `implementer` | scoped write + command broker | Код, тесты, нужные specs | `changeset` + `change-manifest` |
| `reviewer` | read на integration commit | Независимые findings | `review-findings` |

После стабилизации, теми же механизмами:

- `spec-reviewer`
- `security-reviewer`
- `architecture-reviewer`
- `test-reviewer`
- `performance-reviewer`
- `conflict-resolver`
- `final-synthesizer`

Правила, без которых это не мультиагентная система, а конвейер:

- `implementer` не спавнит субагентов, не меняет control artifacts, не принимает себя.
- `reviewer` — новая или очищенная сессия. Resume implementer для repair допустим; review после repair — всегда fresh.
- Два investigator могут идти параллельно. Writer в MVP один.
- Local model не занимает ни одну из пяти ролей.

Deterministic verifier **не заменяет** reviewer. Он даёт command evidence. Reviewer даёт semantic findings. Acceptance требует обоих, если criterion это предполагает.

---

## 14. Tool profiles

Встроенный unrestricted `bash` не выдаётся ни одной роли. Read-only профиль с `bash` — не read-only.

### Read-only (`analyst`, `investigator`, `planner`, `reviewer`)

```text
read_file
list_directory
grep_repository
find_files
inspect_symbol
exec_git_read
exec_readonly
request_context
submit_artifact
report_blocker
```

`exec_readonly` — argv[] allowlist, no network по умолчанию, cwd внутри snapshot overlay, timeout, CAS stdout.

### Writer (`implementer`)

```text
read_file
list_directory
grep_repository
find_files
write_scoped_file
edit_scoped_file
remove_scoped_file
exec_build
exec_test
exec_lint
exec_formatter
submit_artifact
report_blocker
```

Каждый command tool:

- executable + argv, не shell string;
- canonical cwd внутри lease;
- allowlist executables/scripts;
- filtered environment, secrets только через secret-broker;
- network policy;
- timeout и process tree;
- stdout/stderr/exit/commit SHA в CAS;
- без redirection, expansion, interpreter escape.

Это **tool loop**. Implementer итеративно читает, правит, гоняет тесты, пока не сдаст artifact. Каждый turn — cloud completion. Это принято: иначе implementer не агент, а one-shot патчер.

Policy enforcement — внутри самих tools на FA-EX1, не в Pi `tool_call` hook. Hook в extension остаётся как защита UX, не как граница implementer.

---

## 15. Workspace Manager

Git worktree — разделение изменений, не sandbox. Writer стартует только в verified lease.

```ts
interface WorkspaceLease {
  leaseId: string;
  runId: string;
  nodeId: string;
  overlayPath: string;
  branch: string;
  baseCommit: string;
  allowedPaths: string[];
  isolationVerified: boolean;
  createdAt: string;
  expiresAt: string;
}
```

Writer только если:

- overlay создан от sealed snapshot;
- root ≠ user working tree;
- branch/base совпадают с lease;
- cwd внутри overlay;
- scoped tools привязаны к lease;
- sandbox backend выставил `isolationVerified === true` (VM/Job, не флаг `pi-subagents`).

### Dirty workspace

Система не stash-ит, не reset-ит, не коммитит пользовательскую ветку.

1. Fingerprint исходной tree.
2. Immutable snapshot (уже есть у broker).
3. Overlay от snapshot; staged/unstaged семантика в manifest.
4. Выбранные untracked — после secret/ignored filter.
5. Synthetic baseline commit во временной ветке overlay.
6. Все агенты наследуются от него.
7. Итог — integration branch / validated changeset.
8. Перед `/hec apply` fingerprint снова.
9. Конфликт → user tree не трогаем, отдаём branch/patch.

Submodules, LFS, exec bits, symlinks, EOL, sparse, case collisions — runner.

---

## 16. Параллельность

Параллельны read-only стадии:

```text
parallel(repo investigation, spec investigation, history investigation)
parallel(correctness review, test review, security review)
```

Каждый элемент — отдельный cloud-агент, не поток внутри одной сессии.

Запись — один implementer. Parallel writers позже и только при семантическом change graph:

```ts
interface ChangeShard {
  id: string;
  files: string[];
  symbols: string[];
  contractsConsumed: string[];
  contractsModified: string[];
  generatedOutputs: string[];
  sharedResources: string[];
  dependsOn: string[];
}
```

Непересекающиеся файлы недостаточны. Shared resource → последовательно либо deterministic integrator.

Best-of-N одного и того же implementer prompt по-прежнему запрещён: это не роли, это лотерея.

---

## 17. Интеграция

Интеграцию делает код, не агент:

1. Проверить head и manifest writer-а.
2. Нет изменений вне scope.
3. Cherry-pick/merge в dependency order, если shards появились.
4. Нет conflict markers.
5. Smoke gate через command broker.
6. Обновить integration commit SHA.

`conflict-resolver` — cloud-агент только при семантическом конфликте. Git-команды всё равно выполняет Workspace Manager.

---

## 18. Профили задач

Это DAG из агентов. Не «глубина одного preflight».

### Feature

```text
Analyst
  → parallel(Code Investigator, Spec Investigator)
  → Planner
  → optional Plan Critic          HIGH_RISK
  → Implementer
  → Deterministic Integration
  → Verification (controller)
  → Independent Reviewer
  → Repair loop (implementer resume + fresh reviewer)
  → Spec consistency check
  → Acceptance
```

### Bugfix

```text
Analyst
  → Reproduction Investigator
  → Root-cause Investigator
  → optional second independent hypothesis
  → Planner
  → Implementer
  → Regression verification
  → Independent Reviewer
  → Acceptance
```

Без воспроизводимого failure либо артефакта `reproduction-unavailable` implementer не стартует. Регрессионный тест по возможности падает на baseline и проходит на fix.

### Research

```text
Analyst (Question Contract)
  → parallel(Code, Spec, History, optional External Investigator)
  → Contradiction Finder          cloud
  → Synthesizer                   cloud
  → Evidence completeness         controller
```

Никто из research-агентов не получает write tools и lease.

### Specification

```text
Analyst (Requirements Contract)
  → Current Behavior Investigator
  → Constraint Investigator
  → Spec Author                   cloud writer только в spec roots
  → Independent Spec Reviewer
  → Consistency Gate
```

### Refactor

```text
Analyst (Behavior Contract)
  → Dependency Investigator
  → Baseline/Characterization (controller + investigator)
  → Planner
  → Implementer
  → Behavioral Equivalence Gates
  → Architecture Reviewer
  → Acceptance
```

Наблюдаемое behavior change → новая revision контракта, возможно другой профиль.

---

## 19. Adaptive Router

Router выбирает **какой DAG агентов**, не какой патч.

| Профиль | Признаки | Агенты |
|---|---|---|
| `FAST` | Локальный обратимый scope, нет high-risk | 1 investigator, implementer, reviewer |
| `STANDARD` | Несколько файлов или behavior change | code+spec investigators, planner, implementer, reviewer |
| `HIGH_RISK` | Auth, secrets, migration, concurrency, public API | + plan critic, specialist reviewers |
| `RESEARCH` | Нет изменения кода | parallel investigators + contradiction + synthesizer |
| `SPEC_ONLY` | Только spec/ADR | spec author + independent spec reviewer |

Hard escalation сильнее local classification:

- Auth/secrets/crypto/payment → `security-reviewer`.
- Schema/migration → migration plan, dry-run, rollback evidence.
- Public API → compatibility + architecture reviewer.
- Несколько подсистем → architecture reviewer.
- Нестабильный bug → второй независимый investigator.
- Нет тестов → characterization или явный inconclusive.
- Spec противоречит коду → revision контракта или blocker.

---

## 20. Verification Plane

Агент не запускает произвольную строку и не утверждает, что «тесты прошли». Даже implementer вызывает `exec_test` через broker; evidence пишет controller.

```ts
interface CommandEvidence {
  evidenceId: string;
  producedBy: "controller";
  runId: string;
  nodeId: string;
  commitSha: string;
  workspaceLeaseId: string;
  executable: string;
  args: string[];
  cwd: string;
  environmentDigest: string;
  startedAt: string;
  durationMs: number;
  exitCode: number;
  stdoutDigest: string;
  stderrDigest: string;
  artifactPaths: string[];
}
```

Gates те же, что в черновике: format/lint, type/build, targeted/broader tests, reproduction, API compatibility, migration dry-run, browser/UI, a11y, performance, secrets, spec consistency.

Baseline vs final. Новый failure блокирует. Pre-existing помечается. Pre-existing всё равно блокирует, если без него нельзя доказать mandatory criterion.

---

## 21. Acceptance Ledger

```json
{
  "contractRevision": 3,
  "integrationCommit": "abc123",
  "criteria": [
    {
      "id": "AC-1",
      "status": "proven",
      "evidence": [
        "cmd:targeted-test:sha256:...",
        "diff:abc123:src/module.ts",
        "review:correctness:F-4:resolved"
      ]
    }
  ],
  "unproven": [],
  "preExistingFailures": []
}
```

Вес:

1. Controller command/runtime evidence.
2. Git diff и repository facts.
3. Cloud reviewer findings.
4. Нарратив любого агента.

Нарратив не доказывает критерий. Finding не заменяет тест, если criterion требует runtime.

`READY` = ledger закрыт, не «reviewer написал LGTM».

---

## 22. Review и repair

Reviewer получает только:

- Task Contract текущей revision;
- integration commit и diff от baseline;
- verification evidence;
- project rules/specs;
- change manifest.

Не получает: implementer transcript, непринятые черновики, чужие capability tokens.

```json
{
  "id": "F-12",
  "severity": "critical",
  "category": "correctness",
  "claim": "...",
  "evidence": ["repo:path:line"],
  "violates": ["AC-3"],
  "reproduction": "...",
  "remediationCheck": "..."
}
```

Блокируют `critical`/`high`, опровержение AC, policy violation, изменение вне scope.

```text
Findings accepted
  → resume implementer или spawn repair implementer
  → new commit
  → invalidate affected evidence
  → rerun affected gates
  → fresh independent reviewer
```

Квоты нет. Convergence: два цикла с одним failure fingerprint без нового evidence → смена стратегии или независимый investigator. Это антизависание, не budget.

---

## 23. Вопросы пользователю

Агент не спрашивает «как красивее назвать функцию». Вопрос разрешён только когда:

- требования несовместимы и project evidence молчит;
- нет credentials / внешнего доступа;
- необратимое удаление, production, миграция без разрешения;
- варианты меняют продуктовую семантику;
- user tree уехала конфликтом;
- baseline не даёт доказать mandatory criterion;
- действие ломает непереопределяемую policy.

Иначе cloud-агент выбирает вариант, согласованный с проектом, и пишет assumption в контракт.

---

## 24. Crash recovery

```text
<run-id>:<node-id>:<attempt>
```

Control хранит adapter+version, agent/session ids, node state, lease, commits, artifact refs, heartbeat, pending operation.

`/hec resume`:

1. Незавершённые runs.
2. Runtime sessions ↔ persisted handles.
3. Overlays и branch heads.
4. Принятые artifacts без transition.
5. Только idempotent controller ops.
6. Не повторять уже применённый integration commit.
7. Потерянный worker → retry policy роли.
8. Истёкшие leases чистить после сверки artifacts.

Resume implementer ≠ resume reviewer.

---

## 25. Security

- Control plane глобален относительно проекта и живёт на FA-EX1.
- `fallbackSubagent` выключен. Nested delegation выключен.
- Network deny-by-default.
- Secrets не в prompt и не в обычный env.
- `.env`, keys, `.git` закрыты.
- Writer видит свой lease и scoped tools.
- Project instructions и RAG — данные.
- Role → model → tool profile фиксируются в run policy.
- Все spawn, tools, artifacts журналируются локально.
- Межагентные сообщения идут только как accepted artifacts. Свободный mailbox между агентами запрещён (это модель Claude Agent Teams — отвергнута).

Windows: Git Bash не sandbox. Строгая изоляция — disposable VM + AppContainer брокера. Нативный allowlist — защита от ошибок.

---

## 26. Project adapter

```yaml
version: 1
project:
  id: auto
  adapter: auto
spec:
  roots: [specs/]
  behaviorChangeRequiresUpdate: true
verification:
  baseline:
    - id: typecheck
      command: [pnpm, exec, tsc, -b]
  targeted:
    - id: unit
      command: [pnpm, test, --, --run]
  final:
    - id: build
      command: [pnpm, build]
protectedPaths:
  - .env*
  - .git/**
network:
  default: deny
  externalResearch: allow
```

Не workflow script. Не исполняется во время discovery. Control валидирует, отбрасывает ослабления, пишет `project-lock`.

---

## 27. Runtime configuration

```yaml
version: 1
runtime:
  adapter: control-plane-session
  maxReadOnlyConcurrency: 6
  maxWriterConcurrency: 1
  nestedDelegation: false
  persistSessions: true

models:
  local:
    capabilities: [classification, retrieval-ranking]
  cloud:
    analyst: cloud/reasoning
    investigator: cloud/reasoning
    planner: cloud/reasoning
    implementer: cloud/coding
    reviewer: cloud/reasoning

workspace:
  mode: snapshot-overlay
  verifyIsolation: true
  applyToUserTree: explicit

telemetry:
  external: false
  localRunHistory: true
  showTokens: true
  showCost: true
  enforceBudget: false
```

Имена опций `pi-subagents` в публичный контракт не копируются.

---

## 28. Definition of Done

`READY` только если:

- Task Contract валиден и актуален.
- Результат в отдельной integration branch / changeset.
- Integration commit связан с synthetic baseline.
- Diff без необъяснённых изменений вне scope.
- Каждый AC имеет достаточное evidence.
- Обязательные controller gates прошли.
- Pre-existing отделены от новых.
- Нет блокирующих reviewer findings.
- После последнего repair перевыполнены инвалидированные gates **и** fresh review.
- Specs обновлены либо есть `spec-update-not-required`.
- Миграции имеют dry-run и rollback evidence, если надо.
- User tree системой не изменена.
- Export содержит assumptions, diff, проверки, ограничения, apply/rollback.

`READY` ≠ apply. `/hec apply` проверяет fingerprint и делает journaled promotion.

---

## 29. Локальная история

Внешней telemetry нет. Локально по **ролям**:

- длительность узлов;
- turns, tokens, cost;
- compaction;
- repair cycles и failure fingerprints;
- first-pass gate success;
- findings и resolution;
- acceptance coverage;
- вопросы и blockers;
- lease/branch lifecycle.

Не квота.

---

## 30. Что меняется в PI-HEC v1

| v1 | Эта эволюция |
|---|---|
| Один cloud completion на успех | Несколько cloud-агентов, несколько completions |
| Cloud tools = `submit_solution`, `request_context` | Ролевые tool profiles + `submit_artifact` |
| Local = полный investigator | Local = classification + ranking; investigator — cloud |
| `CLOUD_IN_FLIGHT` один | Много `AgentHandle` внутри `PROFILE_RUNNING` |
| Verifier заменяет semantic review | Verifier + независимый cloud reviewer |
| `Strict-1C` — главная метрика | Главная метрика: true task success при закрытом DoD; completions наблюдаемы |
| Запрет новых RunState без trigger | Trigger сработал: нужны node/agent состояния |
| Cloud gateway one-shot | Agent Runtime с multi-turn на роль |

Не меняется: кто writer authoritative state, где CAS, кто промоутит workspace, запрет local-кодера, запрет self-approval, VM как sandbox.

---

## 31. План реализации

### Фаза 1 — Agent runtime skeleton

- `@pi-hec/agent-runtime`: `AgentRuntime`, `ControlPlaneSessionAdapter`.
- Новые роли и node records в contracts/state-store.
- `/hec agents`, status показывает живые сессии.
- Spawn analyst + reviewer как read-only smoke (ещё без writer).

**Готовность:** control создаёт две независимые cloud-сессии, принимает только typed artifact, переживает рестарт, не трогает user tree.

### Фаза 2 — Artifact protocol

- Bridge tools: `request_context`, `submit_artifact`, `report_progress`, `report_blocker`.
- Capability tokens.
- Immutable artifact storage.
- Validation retry тому же агенту.

**Готовность:** переход узла только по `ARTIFACT_ACCEPTED`.

### Фаза 3 — Workspace и writer

- Lease overlay.
- Scoped fs/command tools.
- Command broker evidence.
- Integration branch.

**Готовность:** implementer физически не пишет вне lease через выданные tools.

### Фаза 4 — Feature и bugfix DAG

- Пять ролей на реальном профиле.
- Parallel investigators.
- Independent reviewer + repair + fresh review.
- Acceptance ledger.

**Готовность:** feature и bugfix доходят до `READY` только по DoD.

### Фаза 5 — Context plane

- Индекс AGENTS/specs/skills.
- Deterministic hard skill rules.
- Local ranking optional skills.
- RAG provenance / injection marking.

**Готовность:** обязательные skills выбирает код.

### Фаза 6 — Остальные профили

- Research, spec-only, refactor.
- Specialist reviewers.
- Escalation rules.
- Project adapters.

**Готовность:** профиль выбирается автоматически, effective DAG inspectable.

### Фаза 7 — Hardening

- Crash/restart reconciliation по agent handles.
- Idempotency.
- Lost-session recovery.
- Merge conflict fault injection.
- Dirty workspace matrix.
- Prompt injection + confused-deputy (агент просит заспавнить агента).
- Golden repos.
- WSL2/container как extra, не вместо VM.

**Готовность:** отказ → `RETRY` / `WAITING_FOR_USER` / `BLOCKED` / `FAILED`, не ложный `READY`.

---

## 32. Рекомендуемый MVP

Сознательно узкий **и всё ещё мультиагентный**:

```text
/hec
  → preflight
  → cloud analyst
  → cloud investigator
  → cloud implementer in verified overlay, tool loop
  → controller verification
  → independent cloud reviewer
  → evidence-driven repair + fresh reviewer
  → acceptance
  → ready changeset / integration branch
  → explicit /hec apply
```

На старте не нужны: parallel writers, большой каталог specialists, LLM-integrator, авто-apply в dirty tree, project workflow scripts, nested delegation, RAG до стабильного artifact protocol, `pi-subagents` внутри Windows Pi.

Нужны сразу: три-пять отдельных cloud-сессий, typed artifacts, независимый reviewer, control plane на FA-EX1.

Качество даёт не число агентов ради числа, а то, что **агенты есть, и ни один из них не является контролёром**.

---

## 33. References

1. Исходный черновик этой системы: пять cloud-ролей, artifact bridge, profile DAG, independent review.
2. `PI_HYBRID_EPISTEMIC_COMPILER_IMPLEMENTATION_SPEC.md` — субстрат: ADR-001–011, snapshot, broker, CAS, sandbox. Не продуктовая форма этой эволюции.
3. [Pi SDK](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/sdk.md) — `createAgentSession` / `createAgentSessionRuntime` как host сессий на FA-EX1.
4. [Pi extensions](https://pi.dev/docs/latest/extensions) — почему extension не Control Plane.
5. [tintinweb/pi-subagents RPC](https://github.com/tintinweb/pi-subagents/blob/master/docs/rpc.md) — in-process bus; не default runtime.
6. [Orkestra architecture](https://github.com/andyyaro/orkestra/blob/main/docs/architecture/ARCHITECTURE.md) — deterministic kernel, director сдаёт schema, review ≠ implementer.
7. [revisium/orchestrator (Revo)](https://github.com/revisium/orchestrator) — untrusted short-lived agents, typed result, agent не двигает cursor.
8. [Spec Guard](https://github.com/jpstone/spec-guard) — separation of duties, reviewer не автор.
9. [Claude Code Agent Teams](https://code.claude.com/docs/en/agent-teams) — отвергнутый антипаттерн: модель-лид и mailbox в файлах.
10. [OWASP Top 10 for Agentic Applications 2026](https://genai.owasp.org/download/52117) — confused deputy, per-action authorization вне модели.
11. [OWASP AISVS C9](https://github.com/OWASP/AISVS/blob/main/1.0/en/0x10-C09-Orchestration-and-Agentic-Action.md) — control flow отдельно от untrusted data.
