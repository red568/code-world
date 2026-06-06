# 并发与竞态条件分析

## 架构概览

```
用户 → Next.js API → Prisma DB + BullMQ 队列
                                    ↓
                          Worker (concurrency=50)
                                    ↓
                          Dispatcher → E2B Sandbox
                                    ↓
                        agent-runtime 进程（沙盒内）
                                    ↓
                  Internal API 回调 (finalize/pause/resume)
```

并发参与者：
- 用户（可能双击、多 Tab）
- Worker（最多 50 并发处理）
- E2B 沙盒内 agent-runtime（异步回调）
- Stop API / Answer API（用户操作）

---

## 已有的防护机制

| 机制 | 位置 | 作用 |
|------|------|------|
| Worker 乐观锁 | `worker-new.ts` `updateMany where status="queued"` | 同一 run 不会被两个 Worker 同时认领 |
| jobId = runId | `queue.ts` enqueue 时 | BullMQ 去重，同一 run 不会重复入队 |
| Dispatcher 二次校验 | `dispatcher.ts` `if (run.status !== "running") return` | 取消后 dispatcher 不创建沙盒 |
| sandboxId 匹配 | `sandbox-session.ts` `terminateSession(projectId, expectedSandboxId)` | 旧 run 的退出回调不误杀新沙盒 |
| 条件更新 session | `sandbox-session.ts` `updateMany where sandboxId` | 不覆盖新 session 的状态 |
| Redis SET NX 答案去重 | `answer/route.ts` | 防止用户双击提交答案 |
| askCount 匹配 | `answer/route.ts` | 防止回答过期问题 |
| $transaction 创建项目 | `projects/route.ts` | project + message + run 原子创建 |
| 活跃 run 检查 | `messages/route.ts` | 防止同项目并行迭代 |

---

## 已识别的竞态场景

### P0 — 必须修复

#### 1. Internal API 回调无条件更新

**文件**：`finalize/route.ts`、`pause/route.ts`、`resume/route.ts`

**问题**：这三个端点直接 `prisma.projectRun.update({ where: { id: runId }, data: { status } })`，不检查当前状态。

**时序**：
```
T1: 用户取消 → run.status = "cancelled"
T2: 沙盒内 agent-runtime 调用 finalize(status="succeeded")
T3: prisma.update 无条件覆盖 → status 变成 "succeeded" 💥
```

**影响**：已取消的 run 被复活为 "succeeded" 或 "running"，成为僵尸状态。

**修复方案**：使用条件更新：
```typescript
await prisma.projectRun.updateMany({
  where: { id: runId, status: { in: ["running", "paused"] } },
  data: { status, finishedAt: new Date() },
});
```

---

#### 2. `/messages` 路由 TOCTOU 创建并行 Run

**文件**：`messages/route.ts`

**问题**：两个并发 POST 请求同时查询活跃 run，都找不到（第一个的 run 还没入库），都创建新 run。

**时序**：
```
T1: Request A 查询活跃 run → 无
T2: Request B 查询活跃 run → 无（A 的 run 还没写入）
T3: Request A 创建 Run A → 入队
T4: Request B 创建 Run B → 入队
T5: 两个 sandbox 同时操作同一项目文件 💥
```

**影响**：同一项目两个 agent-runtime 并发修改文件，产出损坏。

**修复方案**：Redis SET NX 项目级锁：
```typescript
const lockKey = `project:${projectId}:run-lock`;
const locked = await redis.set(lockKey, runId, "EX", 600, "NX");
if (!locked) return Response.json({ error: "已有运行中的任务" }, { status: 409 });
```

---

#### 3. `paused` 状态未被活跃 run 检查覆盖

**文件**：`messages/route.ts`

**问题**：活跃 run 查询 `status in ["queued", "running", "cancelling", "waiting_for_user"]`，不包含 `"paused"`。用户可以在 ask_user 等待期间提交新迭代，创建第二个 run。

**修复方案**：将 `"paused"` 加入活跃状态列表。

---

### P1 — 应该修复

#### 4. 取消时 Dispatcher 已在创建沙盒

**文件**：`dispatcher.ts`、`stop/route.ts`

**问题**：Worker 乐观锁成功后，Dispatcher 的二次校验也通过了，正在 `acquireForProject` 创建沙盒。此时用户取消，但 `sandboxId` 尚未写入 DB。

**时序**：
```
T1: Worker 认领 run → status=running
T2: Dispatcher 状态校验通过 → 开始创建沙盒...
T3: 用户取消 → Stop API 发现 sandboxId=null → 无法 kill
T4: Dispatcher 创建完沙盒 → 启动 agent-runtime → 写入 sandboxId
T5: agent-runtime 在已取消的 run 上运行 💥
```

**影响**：沙盒创建后无法被立即停止，需等 agent-runtime 自行调用 finalize（如果 finalize 有条件更新，则 "cancelled" 不会被覆盖，但沙盒浪费了资源）。

**修复方案**：在启动进程前（写入 sandboxId 后）再做一次状态检查：
```typescript
await prisma.projectRun.update({ where: { id: runId }, data: { sandboxId } });

// 最终校验：如果在此期间被取消，杀掉沙盒
const finalCheck = await prisma.projectRun.findUnique({ where: { id: runId } });
if (finalCheck?.status === "cancelled") {
  await sandbox.kill();
  return;
}
```

---

#### 5. Worker 重试无效

**文件**：`worker-new.ts`

**问题**：BullMQ 配置了 `attempts: 3`，但第一次尝试就把 status 从 "queued" 改成 "running"。重试时乐观锁 `where status="queued"` 匹配不上，永远跳过。

**影响**：重试配置形同虚设，无法真正重试 dispatch 失败的 run。

**修复方案**：两种选择：
- A) 去掉重试配置（`attempts: 1`），dispatch 失败就 failed
- B) 在 catch 中把 status 改回 "queued" 再 throw（让重试有效）

---

### P2 — 可接受或低优先级

#### 6. 文件同步非事务性

**文件**：`internal/files/sync/route.ts`

**问题**：文件逐个 upsert，sandbox 被 kill 时可能只写了一半文件。

**影响**：项目文件处于不一致状态。

**修复方案**：`prisma.$transaction` 包裹所有 upsert，或记录 sync 状态供前端展示。

---

#### 7. 沙盒泄露

**文件**：`sandbox-session.ts`

**问题**：如果进程在 `Sandbox.create()` 和数据库 `upsert` 之间崩溃，沙盒在 E2B 上运行但无人跟踪。

**影响**：浪费 E2B 额度直到 15 分钟 TTL 过期。

**修复方案**：
- 短期：可接受（TTL 自动回收）
- 长期：定期扫描 E2B 沙盒列表，清理不在 DB 中的孤儿

---

#### 8. 答案推送到已死亡的沙盒

**文件**：`answer/route.ts`

**问题**：用户提交答案时沙盒已超时死亡，LPUSH 成功但无人 BRPOP 消费。

**影响**：用户收到 `{ ok: true }` 但答案未被处理。Redis key 会在 TTL 后自动清理。

**修复方案**：可接受，或在 LPUSH 后设置 key 的 TTL（已隐含在 agent-runtime 的 30 分钟 BRPOP 超时中）。

---

#### 9. Stop 双击

**文件**：`stop/route.ts`

**问题**：两次并发 stop 请求都找到同一个 activeRun，都尝试 kill。

**影响**：无害 — 第二次 kill 静默失败，DB 更新幂等。

**修复方案**：不需要修复，已天然幂等。

---

## 修复优先级路线图

```
立即修复（P0）:
  1. Internal API 回调加条件更新（finalize/pause/resume）
  2. messages/route.ts 加 Redis 项目级锁
  3. paused 加入活跃状态检查

后续修复（P1）:
  4. Dispatcher 写入 sandboxId 后最终校验
  5. Worker 重试策略调整

可选优化（P2）:
  6. 文件同步事务化
  7. 沙盒泄露清理机制
  8. 答案推送后验证
```

---

## 关键设计原则

1. **条件更新优于直接覆盖** — 所有状态变更应带 `where status in [...]` 条件
2. **绑定具体 ID 而非项目级操作** — 退出回调绑定 sandboxId，避免误杀
3. **幂等设计** — 所有 API 应支持安全重试
4. **最后写入者不一定对** — 被取消的状态是终态，不应被后续回调覆盖
