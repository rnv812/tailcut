import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Все модульные наборы: *.test.ts в любом каталоге tests/.
    // Playwright держит свои наборы в *.spec.ts и сюда не попадает.
    include: ['tests/**/*.test.ts'],
    environment: 'node',
  },
})
