import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    // OneDrive's virtual filesystem does not emit reliable fs change events, so
    // Vite's native watcher silently misses edits — HMR never fires and browser
    // tabs go stale (the recurring "still loading / old code" red herring). A
    // POLLING watcher reads the files on an interval instead, so OneDrive edits
    // are always picked up and HMR works. This is the durable root-cause fix.
    watch: { usePolling: true, interval: 300 },
    proxy: {
      '/api': {
        target: 'http://localhost:8000',
        changeOrigin: true,
      },
    },
  },
})
