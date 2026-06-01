# Railway Database Migration

当用户修改了 `prisma/schema.prisma` 并需要将变更同步到 Railway 远程数据库时，执行以下流程。

## 背景

- 本项目不使用 `prisma migrate dev`（没有 migrations 目录），因为远程库有 drift 会触发 reset
- Railway 数据库有两个地址：
  - 内网（部署用）：`postgres.railway.internal:5432`
  - 公网代理（本地迁移用）：`kodama.proxy.rlwy.net:23429`
- `.env` 默认配置为内网地址，本地执行迁移时需临时切换为公网代理

## 执行步骤

### Step 1: 切换 DATABASE_URL 为公网代理

读取 `.env`，将 `postgres.railway.internal:5432` 替换为 `kodama.proxy.rlwy.net:23429`。

### Step 2: 生成增量 SQL

```powershell
npx prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --script
```

如果输出为空（exit code 0 with `--exit-code` flag），说明数据库已经同步，跳到 Step 5。

### Step 3: 执行 SQL

将 Step 2 的 SQL 输出通过管道传给：

```powershell
$sql | npx prisma db execute --stdin
```

### Step 4: 验证无差异

```powershell
npx prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --exit-code
```

期望 exit code 为 0 且输出 "No difference detected."。如果仍有差异，报告错误并停止。

### Step 5: 还原 .env

将 `DATABASE_URL` 恢复为内网地址 `postgres.railway.internal:5432`。无论前面步骤成功或失败都必须执行此步。

### Step 6: 重新生成 Prisma Client

```powershell
npx prisma generate
```

## 注意事项

- 绝不使用 `prisma migrate dev`，它会尝试 reset 远程数据库
- 绝不使用 `--from-url`（已从 Prisma 移除），用 `--from-config-datasource`
- 执行前确认 schema 变更是正确的（可以先 `npx prisma validate`）
- 如果 SQL 包含 enum ADD VALUE，PostgreSQL 要求该语句不在事务中执行（Prisma db execute 默认非事务，无需额外处理）
