import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // All unit suites: *.test.ts and *.test.tsx anywhere under tests/.
    // Playwright uses *.spec.ts, so its suites are excluded here.
    include: ['tests/**/*.test.{ts,tsx}'],
    environment: 'node',
  },
})
