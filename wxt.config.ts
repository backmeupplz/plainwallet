import { defineConfig } from 'wxt'

export default defineConfig({
  suppressWarnings: { firefoxDataCollection: true }, // AMO-only requirement; this isn't published there
  manifest: ({ browser }) => ({
    name: 'Plain Wallet',
    permissions: ['storage', 'alarms', ...(browser === 'firefox' ? [] : ['sidePanel'])],
    // lets the background reach any user-specified RPC endpoint regardless of its CORS policy
    host_permissions: ['http://*/*', 'https://*/*'],
    // Firefox refuses MV3 extensions without an ID
    ...(browser === 'firefox' ? {
      browser_specific_settings: { gecko: { id: 'plainwallet@backmeupplz' } },
      sidebar_action: { default_title: 'Plain Wallet', default_panel: 'popup.html?view=sidebar', default_icon: 'icon/32.png', open_at_install: false },
    } : { side_panel: { default_path: 'popup.html?view=sidebar' } }),
  }),
})
