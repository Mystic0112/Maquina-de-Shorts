import { configDefaults, defineConfig } from "vitest/config";

// Agent worktrees live under .claude/worktrees/: their copies of the tests are not this checkout's tests.
export default defineConfig({ test: { exclude: [...configDefaults.exclude, ".claude/**"] } });
