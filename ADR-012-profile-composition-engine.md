# ADR-012: Profile Composition Engine

- **Статус:** Accepted
- **Дата:** 2026-09-13
- **Контур:** PI-HEC multi-agent control plane
- **Связанные решения:** ADR-001, ADR-002, ADR-010, ADR-011, ADR-013; архитектура §7–8, §18–21, §31
- **Затрагиваемый код:** `@pi-hec/contracts`, `@pi-hec/domain` (`adaptive-router`, `profile-catalog`, `dag-engine`), control-plane `profile-runner` / `compiler.ts`, golden evaluation

## Контекст

Текущий Adaptive Router выбирает **один монолитный DAG** из `WorkflowProfileId`:

```text
TaskContract.kind + riskFlags
  → selectWorkflowProfile
  → FAST | FEATURE | BUGFIX | HIGH_RISK | RESEARCH | SPEC_ONLY | REFACTOR
  → static nodes
```

Это покрывает только цикл «изменить код → проверить». Каталог не выражает инциденты, security remediation, миграции, обновления зависимостей, производительность, тестовую инженерию, CI/tooling, документацию, retirement и выпуск. При этом уже существующие ID смешивают несовместимые измерения:

| Текущий ID | Фактический смысл |
|---|---|
| `FAST` | economy-pass: локальный обратимый feature/bugfix без planner |
| `FEATURE` (дырка `STANDARD` в схеме) | primary `feature` |
| `BUGFIX` | primary `bugfix` |
| `HIGH_RISK` | бандл overlay, который **подменяет** DAG |
| `RESEARCH` | primary `research` + delivery `analysis-only` |
| `SPEC_ONLY` | primary `specification` + delivery `spec-artifact` |
| `REFACTOR` | primary `refactor` |

Следствия, которые нельзя чинить добавлением ещё одного монолитного профиля:

1. `HIGH_RISK` копирует узлы `FEATURE` даже для bugfix/refactor. Auth-баг получает feature-DAG.
2. Поле `escalation[]` роутера не меняет граф. Specialist-узлы есть только внутри `HIGH_RISK`.
3. `TaskKind` в contracts — пять значений; golden уже использует девять (`security`, `migration`, `ui`, `performance`).
4. Verification знает только *когда* (`baseline` / `targeted` / `final`), не *что* доказывать.
5. Delivery не моделируется: research отличается только `acceptancePolicy.allowResearchWithoutWrite`.
6. Связанных runs нет. Nested delegation запрещён, поэтому эпик/миграция/инцидент не могут быть «агентом, который спавнит агентов».

Архитектурные инварианты, которые решение не имеет права нарушить:

- Control plane не агент: он спавнит, валидирует schema, двигает DAG, закрывает acceptance.
- `nestedDelegation: false`, `maxWriterConcurrency: 1`.
- Local model — hint; в контракт поля попадают только после cloud analyst и schema.
- Агент не двигает cursor и не объявляет READY. READY = закрытый acceptance ledger.
- Workspace = snapshot-overlay; apply в user tree только explicit.
- `compiler.ts` control-plane — компилятор **фаз run** (`CONTRACTED` → `PROFILE_SELECTED` → `PROFILE_RUNNING`), не DAG.
- Слово overlay уже занято workspace isolation. Риск-слой в типах называется только `RiskOverlay`.

Классификация сопровождения, на которую опирается таксономия intent:

- ISO/IEC/IEEE 14764:2022 различает corrective, adaptive, perfective, preventive и additive maintenance; migration и retirement — отдельные процессы; emergency — способ планирования, не шестой тип.
- NIST SSDF (SP 800-218) требует встраивать secure-development practices в любой SDLC, а не держать security финальным этапом. Отдельный vulnerability-response (группа RV) остаётся, когда задача *начинается* с уязвимости.
- Google SRE incident response: assess impact → mitigate → RCA → permanent fix + postmortem. Mitigation first.

## Решение

Роутер **не выбирает профиль из списка**. Он собирает типизированный run plan из четырёх независимых семантических измерений и двух выводимых:

```text
Run Plan =
  Primary Intent
  + Secondary Intents
  + Risk Overlays
  + Verification Packs
  + Delivery Mode
  + (derived) executionBudget     // fast | standard | thorough
  + (derived) changeClass         // ISO 14764
```

Исполняемый артефакт по-прежнему `WorkflowProfile` (его уже пишет control-plane compiler в binding `workflow-profile`). Новым входом становится `RunComposition`. `FAST` и `HIGH_RISK` — результаты компилятора, не единицы выбора.

```ts
type RunComposition = {
  schemaVersion: 2;
  primaryIntent: PrimaryIntent;
  secondaryIntents: readonly PrimaryIntent[];
  overlays: readonly RiskOverlay[];
  verificationPacks: readonly VerificationPackId[];
  deliveryMode: DeliveryMode;
  urgency: "normal" | "urgent" | "incident";
  executionBudget: "fast" | "standard" | "thorough";
  changeClass:
    | "none"
    | "corrective"
    | "adaptive"
    | "perfective"
    | "preventive"
    | "additive";
  splitIntoRelatedRuns?: readonly RelatedRunPlan[];
};

type CompiledProfile = WorkflowProfile & {
  schemaVersion: 2;
  composition: RunComposition;
  nodeProvenance: Readonly<Record<string, NodeProvenance>>;
  deferredGates: readonly ControllerOperation[];
  forbiddenActions: readonly string[];
};
```

`nodeProvenance` обязателен: каждый узел объясняет, почему он в графе (`intent` | `secondary` | `overlay` | `pack` | `delivery` | `budget`). Это и есть inspectable DAG.

Legacy `profileId` (`FAST` / `FEATURE` / …) допускается как отображаемый label, если compiled graph совпал с шаблоном. Source of truth — digest compiled profile в role `workflow-profile`.

Жизненный цикл run не меняется. Точка врезки — `selectAndPersistProfile`. `dag-engine` сохраняет `when`, skip, invalidate и single-writer.

### 1. Primary intent

Ровно один на run. Первая очередь:

| Группа | Intent | Результат | Write | changeClass |
|---|---|---|---|---|
| Discovery | `research` | доказательный ответ | нет | `none` |
| Discovery | `diagnosis` | root cause без обязательного fix | нет | `none` |
| Definition | `requirements` | проверяемые требования | spec/requirements roots | `none` |
| Definition | `specification` | нормативная техническая память | spec roots | `none` |
| Definition | `architecture-design` | ADR / design, не реализация | ADR/spec roots | `none` |
| Change | `feature` | новое пользовательское поведение | да | `additive` |
| Change | `bugfix` | исправленное неправильное поведение | да | `corrective` |
| Change | `refactor` | структура без изменения поведения | да | `perfective` |
| Change | `optimization` | измеримое улучшение | да | `perfective` |
| Change | `dependency-upgrade` | обновлённые зависимости/runtime | да | `adaptive` |
| Change | `migration` | переход состояния/контракта | да, часто series | `adaptive` |
| Change | `security-remediation` | устранённая уязвимость или её класс | да | `corrective` / `preventive` |
| Quality | `test-engineering` | покрытие без смены prod behavior | тесты | `preventive` / `perfective` |
| Quality | `documentation` | согласованная документация | docs roots | `perfective` |
| Infrastructure | `build-tooling` | build/dev/CI | tooling | `adaptive` |
| Operations | `incident-response` | восстановленный сервис + incident record | mitigation | `corrective` |
| Lifecycle | `deprecation-retirement` | безопасное удаление контракта | destructive | retirement process |

`triage` **не** отдельный run по умолчанию. Preflight hint + analyst + `blockingQuestions` уже классифицируют задачу. Отдельный triage-intent — только если контракт нельзя закрыть из-за несовместимых интерпретаций с разным продуктовым результатом.

`changeClass` выводится, не выбирается моделью.

`hotfix` **не** primary и не nested intent. Это `urgency: incident` + overlay `emergency` + delivery `mitigation-patch`.

Вторая очередь (не в первом schema bump): `data-repair`, `api-integration`, `codegen-sync`, `release-preparation`.

Границы discovery:

- `research` отвечает на вопрос.
- `diagnosis` ищет причину конкретного сбоя.
- `bugfix` чинит. В `diagnosis` implementer запрещён (`forbiddenActions`). Нужен fix — linked `bugfix` run.

Базовые фрагменты переиспользуют текущие шаблоны и роли. Новых ролей почти не требуется.

| Intent | Фрагмент |
|---|---|
| `feature` | текущий `FEATURE_PROFILE`; plan-critic включается overlay, не профилем |
| `bugfix` | текущий `BUGFIX_PROFILE`; без reproduction / `reproduction-unavailable` implementer не ready |
| `research` | текущий `RESEARCH_PROFILE` |
| `specification` | `SPEC_ONLY`; create/update/reconcile/extract/review — поле контракта, не отдельные ID |
| `refactor` | `REFACTOR_PROFILE` + behavioral equivalence |
| `diagnosis` | reproduction → RCA → blast radius → synthesizer; delivery `analysis-only` |
| `optimization` | обязательный baseline + `performance-reviewer`; AC в форме metric/baseline/target |
| `dependency-upgrade` | inventory + lockfile/supply-chain review |
| `migration` | фрагмент **одной** фазы; серия фаз — related runs |
| `security-remediation` | confirmation → similar-pattern search → fix → `security-reviewer` |
| `incident-response` | impact → mitigation → recovery verify → linked permanent run → postmortem |
| `deprecation-retirement` | consumer discovery; destructive removal только после evidence |

Secondary intent не копирует чужой полный DAG. Он добавляет 1–3 узла (spec-investigator, characterization, consumer search и т.д.).

Repair loop (`HAS_BLOCKING_FINDINGS` + invalidate) — общий хвост всех write-intent, не копипаста в каждом фрагменте. Predicate обязан связываться с `review-findings.blocking`.

### 2. Risk overlays

Intent задаёт базовый DAG. Overlay модифицирует его. Overlay доступен для любого primary, включая research. Security overlay обязателен как опция на всём SDLC (NIST SSDF), а не только как `HIGH_RISK` профиль.

Минимальный набор и якоря в текущих `RISK_FLAGS`:

| Overlay | Сигнал | Эффект |
|---|---|---|
| `security-sensitive` | `auth` / `secrets` / `crypto` / `payment` | `security-reviewer` + secret scan в VerificationPlan |
| `authentication` | `auth` | authorization/session matrix в pack |
| `public-api` | `public-api` | consumer inventory, architecture-reviewer, compatibility |
| `data-mutation` | schema/data paths | dry-run, reconciliation; apply только privileged |
| `migration` | `migration` | phase plan; часто split |
| `concurrency` | `concurrency` / `unstable-bug` | second hypothesis, stress checks |
| `cross-cutting` | `multi-subsystem` | architecture-reviewer, broader regression |
| `ui-visible` | UI paths | browser/a11y checks в plan |
| `production-impact` | incident / prod target | rollback evidence |
| `destructive` | retirement / data delete | explicit authorization, иначе `WAITING_FOR_USER` |
| `external-contract` | third-party / public-api | sandbox/contract tests |
| `no-tests` | `no-tests` | characterization или inconclusive; не ложный READY |
| `emergency` | `urgency: incident` | mitigation-first, `deferredGates` |
| `generated-code` | `generatedOutputs` в shards | generator как source of truth |

`irreversible` отдельным overlay не вводится: validator смотрит `assumptions[].reversible === false` и §23 архитектуры (вопрос пользователю).

Overlays, которые добавляют **агентов:** security/architecture/test/performance-reviewer, second investigator.  
Overlays, которые добавляют **controller ops:** только если это другой момент DAG (`MIGRATION_DRY_RUN`, `ROLLBACK_EVIDENCE`).  
Overlays, которые добавляют **checks:** secret scan, a11y, browser — в `VerificationPlan`, не отдельными агентами.  
`emergency` не удаляет gates: пропущенные проверки становятся `deferredGates` / post-deployment obligations.

### 3. Verification packs

Pack отвечает на вопрос «как доказать», не «что делаем». Control plane не предполагает `npm test`. Команды даёт `ProjectAdapter`.

Первая очередь: `frontend`, `web-ui`, `backend-api`, `database`, `library`, `cli`, `build-system`, `security`, `documentation`, `performance`.

Компиляция:

```text
pack ids
  → ProjectAdapter.verification.packs[id]
  → ProofObligation[] + CheckNode[]
  → существующие controller nodes
     VERIFICATION / REGRESSION_VERIFICATION /
     BASELINE_CHARACTERIZATION / BEHAVIORAL_EQUIVALENCE
```

Не вводить узел «frontend-react agent». Stack-специфика живёт в adapter репозитория. Packs не должны раздувать agent DAG: лимит `WorkflowProfile.nodes.maxItems` сейчас 64.

### 4. Delivery mode

Не меняет инженерную истину. Определяет хвост DAG и permissions.

| Mode | Якорь в системе |
|---|---|
| `analysis-only` | `allowResearchWithoutWrite`, без write lease |
| `spec-artifact` | writer только в `spec.roots` |
| `integration-branch` | default для change |
| `patch` | changeset без apply |
| `pull-request-ready` | integration-branch + PR description artifact |
| `mitigation-patch` | минимально безопасные gates + rollback + deferredGates |
| `migration-series` | не DAG, а `RelatedRunPlan` |
| `runbook` | инструкция; apply запрещён |
| `apply-to-worktree` | только `workspace.applyToUserTree: "explicit"` и пользовательское разрешение |
| `release-candidate` | вторая очередь |

Default: change → `integration-branch`; research/diagnosis → `analysis-only`.

### 5. Derived `executionBudget`

Сохраняет обещание не запускать лишних агентов на простом изменении.

```text
fast:      localScope ∧ reversible ∧ !behaviorChange ∧ overlays = ∅
           ∧ primary ∈ {feature, bugfix}
           → один investigator, без planner, без spec-consistency

standard:  обычный intent fragment

thorough:  любой high overlay или multi-subsystem
           → plan-critic + specialist reviewers
```

Это не пользовательское измерение.

### 6. DAG compiler

Заменяет `selectWorkflowProfile`. Живёт в `@pi-hec/domain`, не в `orchestration/compiler.ts`.

```text
1. Validate / rewrite composition (precedence + conflicts)
2. Load base fragment(primaryIntent)
3. Merge secondary fragments (additive nodes)
4. Apply overlays (insert / forbid / reorder)
5. Attach packs → VerificationPlan
6. Apply delivery tail
7. Apply executionBudget (удалить необязательное)
8. Dedup by node id, rebuild dependsOn
9. Cycle check
10. Agent/tool availability
11. Node budget; иначе split related runs
12. Acceptance + deferredGates
13. Persist CompiledProfile + provenance
```

Порядок выбора:

1. Primary из `TaskContract`. Local model — hint.
2. Secondary — только совместимые; иначе split.
3. Overlays — union(contract.riskFlags, adapter, touched paths, spec policy).
4. Packs — по затронутым subsystems adapter’а, не по языку монорепо целиком.
5. Delivery — политика проекта + формулировка.
6. Conflicts — таблица ниже.

| Комбинация | Решение |
|---|---|
| refactor + `behaviorChanges: true` | primary → `feature`, secondary `refactor`; revision контракта |
| bugfix + активный outage | primary → `incident-response`; linked `bugfix` после mitigation |
| dependency-upgrade + CVE | overlay `security-sensitive` обязателен; primary `security-remediation` только если цель — класс уязвимости, а не «поднять версию» |
| feature + destructive migration | `migration-series` |
| documentation + code change | code intent primary, documentation secondary |
| research + implementation | два related runs; research без write tools |
| optimization без baseline | `BLOCKED` или вернуть characterization; нет baseline — нет READY |
| deprecation без consumer evidence | `BLOCKED` |
| spec противоречит коду | revision контракта или blocker |
| hotfix без rollback | `BLOCKED`, privileged override отдельно |
| подмена primary DAG бандлом overlays (`HIGH_RISK` как сейчас) | запрещено |

Profile critic — cloud-агент с `review-findings`. Он может предложить исправление графа. Окончательную допустимость определяет детерминированный validator. Агент не двигает cursor.

### 7. Связанные runs

Агент не спавнит агентов. Related runs создаёт control plane.

```text
parent run
  ├── child (свой TaskContract, overlay, branch, ledger)
  └── child
```

Родитель не READY, пока children не закрыли ledger **или** gates явно deferred (`emergency`). Evidence разных commits не склеивается в одно неподтверждённое «готово».

Типичный split:

```text
incident-response → bugfix | security-remediation
research → feature | architecture-design
migration-expand → transition → backfill → switch → contract
architecture-design → feature
```

Incident Commander — control plane, не роль, которая командует другими сессиями. Incident DAG использует обычные роли.

Для production migration фазы expand-contract — отдельные child runs, не один DAG на все фазы.

### 8. Контракты

Минимальный schema bump в `@pi-hec/contracts`:

1. `TaskContract` schemaVersion 2: `primaryIntent`, `secondaryIntents`; текущий `kind` сохраняется как deprecated alias на время миграции.
2. Расширить `RISK_FLAGS` без удаления старых (`destructive`, `generated-code`, `emergency`, …).
3. Артефакты: `compiled-profile`, `run-composition`, `related-run-plan`. Research-report не плодить: расширить `InvestigationReport.kind`.
4. Packs компилируются в существующий `VerificationPlan`. Новые `CONTROLLER_OPERATIONS` — только для другого *момента* DAG.
5. Поднять `WorkflowProfile.nodes.maxItems` или вынести compiled profile из того же лимита.
6. `ProjectAdapter.verification.packs`.
7. `RunAgentsPage`: composition + digest; `profileId` — legacy label.

`logicalConflicts` расширяется: research не требует spec update; diagnosis без write; refactor + behaviorChange — конфликт; optimization без измеримого AC — конфликт.

`HARD_SKILL_RULES` вешаются на intent + overlay, не на `FAST`.

### 9. Golden evaluation

Golden kinds мапятся на composition, а не на новые монолитные профили:

| Golden kind | Composition |
|---|---|
| feature | `feature` + packs репозитория |
| bug | `bugfix` |
| refactor | `refactor` + equivalence |
| spec | `specification` / `spec-artifact` |
| research | `research` / `analysis-only` |
| security | `security-remediation` + `security-sensitive` |
| migration | `migration` + `public-api` на `migration-public-api` |
| ui | code intent + `ui-visible` + `web-ui` |
| performance | `optimization` + `performance` |

Не строить декартово 18 intents × 10 repos. Golden tasks — фикстуры `RunComposition`. False-READY считается отдельно по `primaryIntent`.

## Последствия

### Положительные

- Каталог покрывает сопровождение шире, чем feature/bug/refactor/spec/research, без комбинаторного взрыва монолитных профилей.
- Auth-bugfix компилируется как `bugfix` + `security-sensitive`, а не как `HIGH_RISK` ⊃ `FEATURE`.
- Локальный обратимый feature остаётся fast.
- Overlays реально меняют граф; escalation перестаёт быть advisory-only.
- Packs привязаны к adapter; control plane не знает package manager проекта.
- Несовместимые изменения делятся на related runs вместо ложного READY.
- Emergency сохраняет пропущенные gates как обязательства.
- Решение согласовано с ISO 14764, NIST SSDF и SRE incident order, не ломая trust model PI-HEC.

### Отрицательные / стоимость

- Schema v2 для `TaskContract` / `WorkflowProfile` и миграция binding-node `profile`.
- Нужен `parentRunId` / related-run graph в state-store. Сейчас его нет.
- Controller verification сегодня часто stub; packs бессмысленны, пока Verification Plane исполняет plan.
- Predicate `HAS_BLOCKING_FINDINGS` нужно связать с review findings, иначе repair loop останется мёртвым.
- Лимит 64 узлов и cartesian golden придётся держать компилятором и фикстурами, не полным каталогом.
- Аналитик должен заполнять более богатый контракт; local hint остаётся неавторитетным.

### Обязательные запреты

- Не добавлять 18 взаимоисключающих `WorkflowProfileId`.
- Не кодировать `frontend-react` в control plane.
- Не делать hotfix primary/nested intent.
- Не вводить Incident Commander-агента, который спавнит других.
- Не выполнять production data repair / apply без privileged path.
- Не отдавать финальную допустимость графа LLM-critic.
- Не складывать весь expand-contract в один run.
- Не путать этот ADR с «Фазой 3» плана реализации архитектуры (там workspace/writer). Это замена §18–19, реализация в Фазах 4–6.

## Критерий выполнения

Решение считается внедрённым, когда:

1. `selectWorkflowProfile` заменён компилятором; тесты проверяют composition, а не только `profileId === "FAST" | "HIGH_RISK"`.
2. Auth-bugfix → `bugfix` + `security-sensitive`.
3. Локальный обратимый feature остаётся fast (один investigator, без critic).
4. Overlays добавляют узлы; `escalation[]` больше не единственный канал specialists.
5. Packs резолвятся через adapter.
6. Compiled profile с provenance сохраняется и проходит validator.
7. Несовместимые задачи дают related runs или `BLOCKED`, не смешанный READY.
8. Emergency переносит gates в `deferredGates`.
9. Research/diagnosis не получают write lease.
10. Golden false-READY считается по intent, включая security/migration/performance.

## Альтернативы, которые отвергнуты

| Альтернатива | Почему нет |
|---|---|
| Расширить список монолитных `WorkflowProfileId` до 18+ | Вернёт взаимоисключающий выбор; overlay снова сольётся с intent |
| Оставить `HIGH_RISK` как профиль и только добавить intents | Сохраняет подмену bugfix/refactor feature-DAG |
| Сделать FAST отдельным primary | FAST — budget, не намерение |
| Отдать сборку графа cloud-агенту | Нарушает «агент не контролёр» |
| Packs как отдельные agent nodes | Лишние сессии и взрыв лимита узлов |
| Related runs через nested delegation | Запрещено runtime config |
| Заменить `orchestration/compiler.ts` DAG-compiler’ом | Это компилятор фаз run; DAG живёт в domain |

## Ссылки

- ISO/IEC/IEEE 14764:2022, Software life cycle processes — Maintenance
- NIST SP 800-218, Secure Software Development Framework (SSDF) 1.1; draft 1.2 (SP 800-218r1)
- Google SRE Workbook, Incident Response: assess → mitigate → RCA → fix → postmortem
- Expand/contract (parallel change) для zero-downtime schema migration
- `packages/domain/src/profile-catalog.ts`
- `packages/domain/src/adaptive-router.ts`
- `packages/contracts/src/schemas/agents.ts`
- `faex1/apps/control-plane/src/services/profile-runner.ts`
- `test/evaluation/golden/types.ts`
- `Pi Coding Agent надёжная мультиагентная система разработки — исправленная архитектура.md` §18–19, §31
