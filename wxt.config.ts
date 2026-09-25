import { defineConfig } from 'wxt'

export default defineConfig({
  // Firefox reviewers rebuild from the sources zip: it keeps .npmrc (no install scripts), not caches or the Android
  // app's build output.
  zip: { dotSources: true, excludeSources: ['.git/**', '.wxt/**', 'android/.gradle/**', 'android/**/build/**', '**/*.hprof'] },
  manifest: ({ browser }) => ({
    name: 'Plain Wallet',
    permissions: ['storage', 'alarms', ...(browser === 'firefox' ? [] : ['sidePanel'])],
    // lets the background reach any user-specified RPC endpoint regardless of its CORS policy
    host_permissions: ['http://*/*', 'https://*/*'],
    // Firefox refuses MV3 extensions without an ID
    ...(browser === 'firefox' ? {
      browser_specific_settings: { gecko: {
        id: 'plainwallet@backmeupplz',
        strict_min_version: '142.0', // the first Firefox (desktop and Android) that reads data_collection_permissions
        // AMO: addresses and signed transactions go to the RPC the user picked; nothing reaches the developer
        data_collection_permissions: { required: ['financialAndPaymentInfo'] },
      } },
      sidebar_action: { default_title: 'Plain Wallet', default_panel: 'popup.html?view=sidebar', default_icon: 'icon/32.png', open_at_install: false },
    } : { side_panel: { default_path: 'popup.html?view=sidebar' } }),
  }),
})
