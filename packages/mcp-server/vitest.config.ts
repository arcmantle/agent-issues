import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		environment: "node",
		include: ["src/**/*.test.ts"]
	},
	resolve: {
		alias: {
			"@agent-issues/core": fileURLToPath(new URL("../core/src/index.ts", import.meta.url)),
			"@agent-issues/api-local": fileURLToPath(new URL("../api-local/src/index.ts", import.meta.url))
		}
	}
});