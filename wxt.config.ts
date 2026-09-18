import { defineConfig } from 'wxt'

export default defineConfig({
  manifest: {
    name: 'Plain Wallet',
    permissions: ['storage'],
    // lets the background reach any user-specified RPC endpoint regardless of its CORS policy
    host_permissions: ['http://*/*', 'https://*/*'],
  },
})
