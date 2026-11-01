import { defineConfig } from "vitest/config";

// Real Chromium fixtures share CI CPU and memory with the web tests.
export default defineConfig({ test: { maxWorkers: 2 } });
