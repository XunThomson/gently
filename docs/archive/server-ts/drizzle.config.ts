/**
 * drizzle-kit 配置：迁移与 Studio。
 *
 * 用法：
 *   pnpm db:generate   # 依据 src/infra/db/schema 生成 SQL 迁移到 ./drizzle
 *   pnpm db:migrate    # 应用迁移（需要 DATABASE_URL）
 *
 * 迁移文件进版本库（`server/drizzle/`），保证任何环境可重放出相同结构。
 */
import {defineConfig} from 'drizzle-kit';

const url = process.env.DATABASE_URL ?? 'postgres://gently:gently@127.0.0.1:5432/gently';

export default defineConfig({
    schema: './src/infra/db/schema/index.ts',
    out: './drizzle',
    dialect: 'postgresql',
    dbCredentials: {url},
    strict: true,
    verbose: true,
});
