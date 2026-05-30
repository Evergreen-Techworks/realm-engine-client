// Realm Engine Dashboard
(function() {
  // ── Electron detection & window controls ──
  const isElectron = !!(window.electronAPI);
  if (isElectron) {
    document.body.classList.add('electron');

    document.getElementById('btn-minimize').addEventListener('click', () => window.electronAPI.minimize());
    document.getElementById('btn-maximize').addEventListener('click', () => window.electronAPI.maximize());
    document.getElementById('btn-close').addEventListener('click', () => window.electronAPI.close());

    // Update maximize button icon on state change
    window.electronAPI.onMaximizeChange((maximized) => {
      const svg = document.getElementById('btn-maximize').querySelector('svg');
      if (maximized) {
        svg.innerHTML = '<rect x="2.5" y="0" width="8.5" height="8.5" rx="1" fill="none" stroke="currentColor" stroke-width="1.3"/><rect x="0" y="2.5" width="8.5" height="8.5" rx="1" fill="var(--bg-card)" stroke="currentColor" stroke-width="1.3"/>';
      } else {
        svg.innerHTML = '<rect x="1" y="1" width="10" height="10" rx="1" fill="none" stroke="currentColor" stroke-width="1.5"/>';
      }
    });
  }

  const NOISY_PACKETS = new Set(['MOVE', 'NEWTICK', 'PING', 'PONG', 'UPDATEACK', 'GOTOACK']);
  const MAX_ROWS = 2000;
  const MAX_PLUGIN_LOGS = 200;

  // RotMG class objectType → name (decimal = hex type in data/objects.xml, e.g. 0x0321 → 801 Necromancer)
  const CLASS_NAMES = {
    768: 'Rogue', // 0x0300
    775: 'Archer', // 0x0307
    782: 'Wizard', // 0x030e
    784: 'Priest', // 0x0310
    785: 'Samurai', // 0x0311
    796: 'Bard', // 0x031c
    797: 'Warrior', // 0x031d
    798: 'Knight', // 0x031e
    799: 'Paladin', // 0x031f
    800: 'Assassin', // 0x0320
    801: 'Necromancer', // 0x0321
    802: 'Huntress', // 0x0322
    803: 'Mystic', // 0x0323
    804: 'Trickster', // 0x0324
    805: 'Sorcerer', // 0x0325
    806: 'Ninja', // 0x0326
    817: 'Summoner', // 0x0331
    818: 'Kensei', // 0x0332
  };

  // Class sprite colors: [primary, secondary/dark, hair/hat]
  const CLASS_COLORS = {
    768: ['#6b5b4b','#463b3b','#2a2020'], // Rogue
    775: ['#4a8c3f','#2d5a1e','#1a3a12'], // Archer
    782: ['#3366dd','#2244aa','#1a2a66'], // Wizard
    784: ['#e0d870','#c0b040','#806820'], // Priest
    785: ['#aa3333','#882222','#551111'], // Samurai
    796: ['#aa8844','#886633','#553311'], // Bard
    797: ['#cc4433','#aa3322','#661a11'], // Warrior
    798: ['#8888aa','#666688','#444466'], // Knight
    799: ['#ccaa33','#aa8822','#665511'], // Paladin
    800: ['#7744aa','#553388','#331a55'], // Assassin
    801: ['#553366','#332244','#1a1133'], // Necromancer
    802: ['#3d7a2e','#2d5a1e','#1a3a12'], // Huntress
    803: ['#aa66aa','#884488','#552255'], // Mystic
    804: ['#aa5588','#884466','#553344'], // Trickster
    805: ['#6688cc','#4466aa','#223355'], // Sorcerer
    806: ['#333333','#1a1a1a','#0a0a0a'], // Ninja
    817: ['#33aaaa','#228888','#115555'], // Summoner
    818: ['#aa3344','#882233','#551122'], // Kensei
  };

  const SKIN_COLOR = '#F5CFA0';
  const SKIN_SHADOW = '#D4A870';
  const EAM_ASSETS = window.EAMAssets || {};
  const EAM_ITEMS = EAM_ASSETS.items || {};
  const EAM_ENCHANTMENTS = window.EAMEnchantments || EAM_ASSETS.enchantments || {};
  const ITEM_RARITY_ICONS = {
    1: 'enchantments/uncommon.png',
    2: 'enchantments/rare.png',
    3: 'enchantments/legendary.png',
    4: 'enchantments/divine.png',
  };
  const THEMES = [
    { id: 'dark', label: 'Dark' },
    { id: 'light', label: 'Light' },
    { id: 'sage', label: 'Sage' },
    { id: 'mist', label: 'Mist' },
    { id: 'forest', label: 'Forest' },
    { id: 'ocean', label: 'Ocean' },
    { id: 'ember', label: 'Ember' },
  ];

  const LANGUAGES = [
    { id: 'en', label: 'English' },
    { id: 'es', label: 'Español' },
    { id: 'de', label: 'Deutsch' },
    { id: 'pt', label: 'Português' },
    { id: 'ja', label: '日本語' },
  ];

  const TRANSLATIONS = {
    en: {
      'tab.home': 'Home', 'tab.plugins': 'Plugins', 'tab.api': 'API',
      'tab.market': 'Market', 'tab.accounts': 'Accounts', 'tab.logs': 'Logs',
      'tab.damage': 'Damage Sniffer', 'tab.objects': 'Objects', 'tab.tilemap': 'Tilemap',
      'tab.gameWiki': 'Game Wiki',       'tab.nearby': 'Nearby Players', 'tab.scripts': 'Scripts',
      'tab.multibox': 'Multibox',
      'tab.memHelper': 'Mem Helper',
      'memHelper.live.refresh': 'Refresh',
      'memHelper.live.colExe': 'Executable',
      'memHelper.live.colPid': 'PID',
      'memHelper.live.colRole': 'Client resource role',
      'memHelper.live.runPolicy': 'Apply multibox policy',
      'memHelper.live.restoreAll': 'Restore all clients',
      'memHelper.live.restoreBalanced': 'Restore + Balanced power',
      'memHelper.live.killMsEdge': 'Kill all Microsoft Edge',
      'memHelper.live.killMsEdgeOk': 'Edge processes terminated (or none were running).',
      'memHelper.live.killMsEdgeErr': 'Could not terminate Edge.',
      'memHelper.live.runPolicyOk': 'Multibox policy applied.',
      'memHelper.live.restoreOk': 'Clients restored to defaults.',
      'memHelper.live.colCpuRaw': 'CPU raw %',
      'memHelper.live.colCpuEquiv': 'CPU ~equiv %',
      'memHelper.live.colRam': 'RAM',
      'memHelper.live.colPriority': 'Priority',
      'memHelper.live.colAffinity': 'Affinity',
      'memHelper.live.colTitle': 'Window title',
      'memHelper.live.colActions': 'Actions',
      'memHelper.live.applyRoles': 'Apply client roles',
      'memHelper.live.mbActive': 'Active',
      'memHelper.live.mbBackground': 'Bg',
      'memHelper.live.mbPark': 'Park',
      'memHelper.live.mbTrim': 'Trim',
      'memHelper.live.mbResize': 'Restore',
      'memHelper.live.roleActive': 'active',
      'memHelper.live.roleBackground': 'background',
      'memHelper.live.roleParked': 'parked',
      'memHelper.live.none': 'No RotMG Exalt processes detected — launch Realm or refresh.',
      'memHelper.live.metaTpl':
        'Logical CPUs: {cpus} · Foreground PID: {fg} · Realm processes: {n}',
      'memHelper.win.unsupported': 'Windows-only tuning (PowerShell, powercfg). Run Realm Engine on Windows.',
      'memHelper.tune.applyPriority': 'Apply now (all Exalt.exe)',
      'memHelper.tune.norm': 'Normal',
      'memHelper.tune.below': 'Below normal',
      'memHelper.tune.above': 'Above normal',
      'memHelper.tune.high': 'High',
      'memHelper.tune.spread': 'Spread CPUs',
      'memHelper.tune.powerPlan': 'Power plan',
      'memHelper.tune.refreshPlans': 'Refresh plans',
      'memHelper.tune.activatePlan': 'Activate',
      'memHelper.tune.idlePri': 'Saved idle priority',
      'memHelper.tune.hotPri': 'Watchdog hot priority',
      'memHelper.tune.autoApply': 'Apply idle priority + startup plan when proxy starts',
      'memHelper.tune.startupPlan': 'Startup power plan',
      'memHelper.tune.hotPlanGuid': 'Hot plan (watchdog)',
      'memHelper.tune.idlePlanGuid': 'Cooldown plan (watchdog)',
      'memHelper.tune.saveSettings': 'Save settings',
      'memHelper.tune.presetProfile': 'Profile',
      'memHelper.tune.preset.safe': 'Safe',
      'memHelper.tune.preset.balanced': 'Balanced',
      'memHelper.tune.preset.multibox': 'Multibox',
      'memHelper.tune.preset.aggressive': 'Aggressive',
      'memHelper.tune.preset.lowHeat': 'Laptop / low heat',
      'memHelper.tune.presetApplied': 'Profile applied.',
      'memHelper.tune.presetHint':
        'Profile click now applies live policy (priority/affinity/EcoQoS) and can also update smart-trim defaults.',
      'memHelper.tune.advanced': 'Advanced tuning',
      'memHelper.tune.restoreBaselineExit': 'Restore captured priority / affinity (+ power scheme) when closing this dashboard (opt-in).',
      'memHelper.tune.recaptureBaseline': 'Recapture baseline',
      'memHelper.tune.restoreBaselineNow': 'Restore baseline now',
      'memHelper.tune.baselineRestored': 'Baseline restored.',
      'memHelper.tune.baselineRecaptured': 'Baseline recaptured.',
      'memHelper.tune.savedOk': 'Saved.',
      'memHelper.tune.savedErr': 'Could not save.',
      'memHelper.tune.watchdogTitle': 'CPU watchdog',
      'memHelper.tune.watchdogDesc': 'When aggregated Realm client CPU crosses the threshold, Realm Engine can switch power plans and re-apply per-client multibox priorities, affinity, and Windows execution-speed QoS (EcoQoS-style throttling for background/parked clients; not a frame-rate cap). “Normalized” divides Σ raw Perf % by logical CPU count.',
      'memHelper.tune.thermalTitle': 'Thermal stress (advanced)',
      'memHelper.tune.thermalDesc': 'Reads WMI ACPI package temperature plus CPU percent-of-max-frequency. If stress sustains (hot or aggressively throttled clocks), temporarily tightens priority for background clients beyond normal ROLE_RULES. Many desktops omit thermal WMI; leave freq empty to use temperature only.',
      'memHelper.tune.thermalEn': 'Enabled',
      'memHelper.tune.thermalTempThr': 'Pkg °C ≥',
      'memHelper.tune.thermalTempClr': 'Clear ≤ °C',
      'memHelper.tune.thermalSus': 'Sustain (ms)',
      'memHelper.tune.thermalClr': 'Clear (ms)',
      'memHelper.tune.thermalFreqLow': 'Min freq % ≤ (empty = ignore)',
      'memHelper.tune.thermalFreqClr': 'Clear freq % ≥',
      'memHelper.tune.thermalDemote': 'Demote BG to',
      'memHelper.tune.status.unsupported': 'Tuning status: unsupported on this OS',
      'memHelper.tune.status.na': 'n/a',
      'memHelper.tune.statusline':
        'Preset: {preset} · Watchdog: {watchdog} · Thermal: {thermal} · Thermal demotion: {demote} · Temp: {temp} · Freq%: {freq}',
      'memHelper.tune.wdEnable': 'Enabled',
      'memHelper.tune.wdThreshold': 'Σ CPU % ≥',
      'memHelper.tune.wdHotMs': 'Hot debounce (ms)',
      'memHelper.tune.wdCoolMs': 'Cool debounce (ms)',
      'memHelper.tune.wdHotPlan': 'Activate hot plan',
      'memHelper.tune.wdHotPri': 'Set hot priority',
      'memHelper.tune.wdHotSpread': 'Spread cores on hot',
      'memHelper.tune.wdCoolPlan': 'Restore cooldown plan',
      'memHelper.tune.wdCoolPri': 'Restore idle priority',
      'memHelper.tune.metricNorm': 'Σ normalized (~system share)',
      'memHelper.tune.metricRaw': 'Σ raw (Perf counters)',
      'memHelper.tune.wdCaptNorm': 'Σ÷LP ≥ ',
      'memHelper.tune.wdCaptRaw': 'Σ raw % ≥ ',
      'memHelper.smart.proxyTitle': 'Automated proxy / bot-client trim',
      'memHelper.smart.proxyDesc': 'Clears packet sniffer + Packet Lab buffers (and optional GC) when RSS or sniff rate crosses limits.',
      'memHelper.smart.exaltTitle': 'Automated RotMG Exalt.exe trim',
      'memHelper.smart.exaltDesc': 'Runs Windows EmptyWorkingSet on each Exalt when per-client RAM is high, or periodically if enabled.',
      'memHelper.smart.en': 'Enabled',
      'memHelper.smart.proxyRss': 'RSS ≥ (MB)',
      'memHelper.smart.proxyRate': 'Pkt/s ≥ (0 = off)',
      'memHelper.smart.checkSec': 'Check every (s)',
      'memHelper.smart.minSec': 'Min between trims (s)',
      'memHelper.smart.trimPk': 'Trim sniffer',
      'memHelper.smart.trimLab': 'Trim Packet Lab',
      'memHelper.smart.trimWorld': 'Trim world snapshot (risky)',
      'memHelper.smart.trimGc': 'Call GC (--expose-gc)',
      'memHelper.smart.exaltWsGb': 'RAM / client ≥ (GB)',
      'memHelper.smart.exaltPeriodic': 'Also trim periodically (below threshold)',
      'memHelper.smart.trimLauncher': 'Trim launcher (RotMG Exalt.exe)',
      'memHelper.smart.trimPlayer': 'Trim Unity player (RotMGExalt.exe)',
      'memHelper.smart.sysMemPct': 'System RAM load ≥ (%, 0 = off)',
      'memHelper.smart.skipCpu': 'Skip trim if client CPU % >',
      'memHelper.smart.minWsGbExtra': 'Min WS floor (GB), 0 = off)',
      'memHelper.smart.exaltOnce': 'Trim Exalt WS now',
      'memHelper.smart.save': 'Save smart trim',
      'memHelper.smart.savedOk': 'Smart trim saved.',
      'memHelper.smart.savedErr': 'Could not save smart trim.',
      'memHelper.smart.onceOk': 'Exalt working sets trimmed.',
      'multibox.toolbar.title': 'Multibox layout',
      'multibox.toolbar.hint': 'Placeholder tiles — drag a panel to move, drag the corner to resize. Layout presets mimic common multibox tools (large focus top-right, left stack, bottom rail). Dragging Game windows here comes later.',
      'multibox.placeholder': 'Placeholder',
      'multibox.addClient': 'Add client',
      'multibox.empty': 'No clients. Click Add client to create a placeholder window.',
      'multibox.clientTitle': 'Client {n}',
      'multibox.removeClient': 'Remove',
      'multibox.presets.label': 'Layout presets',
      'multibox.presetTitle4': 'Kronk-style: 2 left + wide main top + bottom bar',
      'multibox.presetTitle6': 'Kronk-style: main top-right (~half), two left stacks, bottom row ×3 — like boxed multibox tools',
      'multibox.presetTitle8': 'Eight clients: wide main top-right, left ×2 stacks, bottom row ×5',
      'tab.developer': 'Developer',
      'sidebar.balance': 'Balance', 'sidebar.plan': 'Plan', 'sidebar.account': 'Account',
      'sidebar.server': 'Server', 'sidebar.ipConnect': 'IP Connect',
      'btn.connect': 'Connect', 'btn.launch': 'Launch', 'btn.save': 'Save',
      'btn.cancel': 'Cancel', 'btn.refresh': 'Refresh',
      'detail.level': 'Level', 'detail.stars': 'Stars', 'detail.fame': 'Fame',
      'detail.guild': 'Guild', 'detail.map': 'Map', 'detail.gameid': 'GameId',
      'detail.objectid': 'ObjectId', 'detail.objecttype': 'ObjectType',
      'detail.position': 'Position',
      'detail.questTargetId': 'Quest target ID',
      'detail.questTargetType': 'Quest target type',
      'detail.backpackTier': 'Backpack tier',
      'detail.server': 'Server',
      'status.connected': 'Connected', 'status.disconnected': 'Disconnected',
      'player.notConnected': 'Not Connected', 'player.waitingForGame': 'Waiting for game...',
      'damage.empty': 'No damage recorded yet. Hit something!',
      'damage.setting.minBossHp': 'Min Boss HP',
      'damage.setting.minMiniBossHp': 'Min Mini HP',
      'damage.setting.inGameAlerts': 'In-Game Alerts',
      'tilemap.autoRefresh': 'Auto-refresh',
      'tilemap.empty': 'No tile data. Click Refresh after connecting to a server and entering a map.',
      'objects.autoRefresh': 'Auto-refresh',
      'objects.empty': 'No object data. Click Refresh after connecting to a server and entering a map.',
      'accountPopup.title': 'Account', 'accountPopup.memberSince': 'Member since',
      'accountPopup.gemBalance': 'Gem Balance', 'accountPopup.currentPlan': 'Current Plan',
      'accountPopup.gemStatus.active': 'Active', 'accountPopup.gemStatus.inactive': 'Inactive',
      'accountPopup.plan.free': 'Free',
      'accountPopup.buyGems.title': 'Buy Gems', 'accountPopup.buyGems.desc': 'Add gems to your balance',
      'accountPopup.managePlan.title': 'Manage Plan', 'accountPopup.managePlan.desc': 'View or change your subscription',
      'accountPopup.signOut': 'Sign Out', 'accountPopup.notSignedIn': 'Not signed in',
      'accountPopup.nextDeduction': '· next deduction {date}', 'accountPopup.renews': '· renews {date}',
      'settings.title': 'Settings', 'settings.tab.visual': 'Visual',
      'settings.tab.game': 'Game', 'settings.tab.developer': 'Developer',
      'settings.tab.plugins': 'Plugins',
      'comingSoon.title': 'Coming soon',
      'comingSoon.scripts': 'Scripting is in active development and will be available in a future update.',
      'comingSoon.multibox': 'Multiboxing is in active development and will be available in a future update.',
      'settings.advancedPlugins': 'Advanced plugin settings',
      'settings.advancedPluginsDesc': 'Show every tuning knob on each plugin. Off (default) shows only the essential settings.',
      'settings.tab.admin': 'Admin', 'settings.appearance': 'Appearance',
      'settings.theme': 'Theme', 'settings.themeDesc': 'Choose the dashboard color theme.',
      'settings.language': 'Language', 'settings.languageDesc': 'Choose the dashboard display language.',
      'settings.showStatBonuses': 'Show stat bonuses',
      'settings.showServerPing': 'Show server ping',
      'settings.showServerPingDesc': 'Show latency (ms) next to each server in the Server dropdown.',
      'settings.showAccountEmails': 'Show account emails',
      'settings.showAccountEmailsDesc': 'Show or hide the email line under each account in the Accounts tab list.',
      'settings.navbarTabs': 'Navbar Tabs',
      'settings.packetSniffer': 'Packet Sniffer',
      'settings.packetSnifferDesc': 'Show or hide the bottom packet sniffer panel while Admin Mode is on.',
      'tutorial.settings.title': 'Tutorial',
      'tutorial.settings.replayLabel': 'Replay tutorial',
      'tutorial.settings.replayDesc': 'Walk through the app introduction again.',
      'tutorial.settings.replayBtn': 'Replay',
      'tutorial.step0.title': 'Welcome to Realm Engine',
      'tutorial.step0.body': 'Your all-in-one companion for Realm of the Mad God. Let\'s take a quick tour so you know where everything is.',
      'tutorial.step0.dim': 'This will only take a minute.',
      'tutorial.step1.title': 'Home',
      'tutorial.step1.body': 'The Home tab is your command center. From here you can:',
      'tutorial.step1.li1': '<strong>Active Script</strong> &mdash; Quick link to the Scripts tab for disk-based .js scripts.',
      'tutorial.step1.li2': '<strong>Session Stats</strong> &mdash; Track uptime, fame gained, white bags, events killed, and dungeons completed in real time.',
      'tutorial.step1.li3': '<strong>Accounts Ready</strong> &mdash; Quickly launch any of your saved accounts directly from the dashboard.',
      'tutorial.step1.li4': '<strong>Edit Layout</strong> &mdash; Click the pencil icon in the top corner to rearrange, hide, or restore cards. Drag to reorder and save your custom layout.',
      'tutorial.step2.title': 'Complementos',
      'tutorial.step2.body': 'Plugins extend what Realm Engine can do. The plugin hub lets you:',
      'tutorial.step2.li1': '<strong>Browse &amp; Search</strong> &mdash; Find plugins by name or filter by category.',
      'tutorial.step2.li2': '<strong>Enable / Disable</strong> &mdash; Toggle plugins on and off with a single click.',
      'tutorial.step2.li3': '<strong>Configure</strong> &mdash; Each plugin has its own settings panel &mdash; tweak them to fit your playstyle.',
      'tutorial.step2.dim': 'Plugins include utilities like auto-aim, auto-dodge, auto-nexus and more.',
      'tutorial.step3.title': 'Accounts',
      'tutorial.step3.body1': 'This is where you manage your Realm accounts. You can store multiple accounts, view character overviews, vault contents, and launch into the game.',
      'tutorial.step3.body2': 'Let\'s add your first account now to get you started.',
      'tutorial.step3.passwordPlaceholder': 'Password',
      'tutorial.step3.dim': 'You can always add more accounts later or skip this step for now.',
      'tutorial.step4.title': 'Damage Sniffer',
      'tutorial.step4.body': 'The Damage Sniffer records combat data while you play. It tracks:',
      'tutorial.step4.li1': '<strong>Runs</strong> &mdash; Each encounter is logged with a live view and saved history.',
      'tutorial.step4.li2': '<strong>Targets</strong> &mdash; See every enemy you hit, filter by boss or miniboss.',
      'tutorial.step4.li3': '<strong>Player Breakdown</strong> &mdash; View per-player DPS and damage contributions.',
      'tutorial.step4.dim': 'Data is captured automatically &mdash; just play and review your stats anytime.',
      'tutorial.step5.title': 'You\'re all set!',
      'tutorial.step5.body': 'That covers the essentials. You can explore each tab at your own pace. If you ever need to revisit this tour, you can reset it in Settings.',
      'tutorial.step5.dim': 'Happy realming!',
      'tutorial.nav.skip': 'Skip',
      'tutorial.nav.back': 'Back',
      'tutorial.nav.next': 'Next',
      'tutorial.nav.finish': 'Finish',
      'tutorial.nav.getStarted': 'Get Started',
      'tutorial.nav.continue': 'Continue',
      'tutorial.nav.addContinue': 'Add & Continue',
      'tutorial.status.saving': 'Saving account...',
      'tutorial.status.success': 'Account added successfully!',
      'tutorial.status.error': 'Failed to save - you can add it manually later.',
      'plugins.hub.aria': 'Plugins',
      'plugins.search.placeholder': 'Search plugins...',
      'plugins.search.aria': 'Search plugins',
      'plugins.category.filter.aria': 'Filter by category',
      'plugins.list.aria': 'Plugin list',
      'plugins.loading': 'Loading plugins...',
      'plugins.category.all': 'All categories',
      'plugins.category.combat': 'Combat',
      'plugins.category.movement': 'Movement',
      'plugins.category.automation': 'Automation',
      'plugins.category.visual': 'Visual',
      'plugins.category.network': 'Network',
      'plugins.category.utility': 'Utility',
      'plugins.category.admin': 'Admin',
      'plugins.teleport.beacon': 'Beacon',
      'plugins.advancedSettings': 'Advanced settings',
      'plugins.teleport.beaconSelect': 'Teleport beacon',
      'plugins.teleport.select': '-- Select beacon --',
      'plugins.teleport.none': '(no beacons visible)',
      'plugins.teleport.typePrefix': 'Type',
      'plugins.teleport.objectId': 'oid',
      'plugins.empty.enable': 'Enable plugins from the sidebar',
      'plugins.empty.none': 'No plugins loaded',
      'plugins.empty.noMatchSidebar': 'No plugins match.',
      'plugins.empty.noMatchDetail': 'No plugins match your search or category.',
      'home.activeScript': 'Active Script', 'home.sessionStats': 'Session Stats',
      'home.accountsReady': 'Accounts Ready To Launch',
      'accounts.setup.title': 'Add Your First Account',
      'accounts.setup.subtitle': 'Enter your game credentials to get started.',
      'accounts.label.alias': 'Alias', 'accounts.label.email': 'Email',
      'accounts.label.password': 'Password', 'accounts.label.server': 'Server',
      'accounts.label.notes': 'Notes', 'accounts.btn.show': 'Show',
      'accounts.placeholder.aliasOptional': 'Display name (optional)',
      'accounts.placeholder.alias': 'Display name',
      'accounts.placeholder.password': 'Password',
      'accounts.placeholder.notes': 'Optional notes',
      'accounts.btn.addFirst': 'Add Account', 'accounts.btn.addNew': '+ Add Account',
      'accounts.btn.saveChanges': 'Save Changes',
      'accounts.list.title': 'Stored Accounts',
      'accounts.sort.newest': 'Newest', 'accounts.sort.oldest': 'Oldest',
      'accounts.sort.alpha': 'Alphabetical', 'accounts.sort.fame': 'Fame',
      'accounts.ctx.refreshAll': 'Refresh All Accounts',
      'accounts.ctx.reorder': 'Reorder Accounts', 'accounts.ctx.delete': 'Delete Account',
      'accounts.empty': 'No accounts saved yet.',
      'accounts.editor.title': 'Account Details',
      'accounts.overview.title': 'Character Overview',
      'accounts.overview.summary': 'Select an account to inspect its characters.',
      'accounts.overview.refreshBtn': 'Refresh Characters',
      'accounts.overview.tab.chars': 'Characters', 'accounts.overview.tab.vault': 'Vault',
      'accounts.overview.tab.gifts': 'Gifts', 'accounts.overview.tab.potions': 'Potions',
      'accounts.overview.tab.totals': 'Total Inventory',
      'accounts.overview.emptyChars': 'No character data loaded.',
      'accounts.overview.selectChar': 'Select a character to inspect its equipment and stats.',
      'accounts.modal.delete.title': 'Delete Account',
      'accounts.modal.delete.msg': 'Are you sure you want to delete this account?',
      'accounts.modal.delete.confirm': 'Delete',
      'accounts.modal.locked.title': 'Account In Use',
      'accounts.modal.locked.msg': 'You must disconnect from the game before editing this account.',
      'accounts.modal.locked.ok': 'OK',
      'status.connecting': 'Connecting',
      'common.loading': 'Loading...',
      'common.refreshing': 'Refreshing...',
      'home.edit.title': 'Edit layout',
      'home.script.selectPlaceholder': '-- Select Script --',
      'home.script.useScriptsTab': 'Use Scripts tab',
      'home.script.runtime': 'Runtime',
      'home.script.currentStatus': 'Current Status',
      'home.script.start': 'Start',
      'home.script.pause': 'Pause',
      'home.script.openScriptsTab': 'Scripts',
      'home.script.note.setup': 'Use the Scripts tab to run .mjs script packages from Documents/Realmengine/Scripts.',
      'home.script.note.lastRun': 'Last run: {name} ({duration})',
      'home.script.state.running': 'Running',
      'home.script.state.paused': 'Paused',
      'home.script.state.idle': 'Idle',
      'home.conn.listening': 'Listening on port 2050',
      'home.conn.clientDetected': 'RotMG Exalt detected',
      'home.conn.clientWaiting': 'Waiting for RotMG Exalt...',
      'home.stat.uptime': 'Uptime',
      'home.stat.totalFameGained': 'Total Fame Gained',
      'home.stat.averageFpm': 'Average FPM',
      'home.stat.whiteBags': 'White Bags',
      'home.stat.eventsKilled': 'Events Killed',
      'home.stat.dungeonsRan': 'Dungeons Ran',
      'home.session.lastSession': 'Last session: {name} - {duration}',
      'home.session.lastEmpty': 'Last session: --',
      'home.session.ended': 'Ended: {time}',
      'home.session.endedEmpty': 'Ended: --',
      'home.feed.empty': 'No session events yet.',
      'home.feed.cleared': 'Session feed cleared.',
      'home.accounts.sortAria': 'Sort launch accounts',
      'mac.launch.sortTrigger': 'Sort & filter',
      'mac.launch.sortBy': 'Sort by',
      'mac.launch.sortOpt.newest': 'Newest saved',
      'mac.launch.sortOpt.oldest': 'Oldest saved',
      'mac.launch.sortOpt.alpha': 'A → Z',
      'mac.launch.sortOpt.fameHigh': 'Best fame (high)',
      'mac.launch.sortOpt.fameLow': 'Best fame (low)',
      'mac.launch.filterSeason': 'Seasonal',
      'mac.launch.filter.any': 'Any',
      'mac.launch.filter.yes': 'Yes',
      'mac.launch.filter.no': 'No',
      'mac.launch.minBestFame': 'Min best-char fame',
      'mac.launch.noMatch': 'No accounts match filters.',
      'mac.launch.summary.sep': ' · ',
      'mac.launch.summaryMinFame': 'Best fame ≥ {n}',
      'mac.launch.groupsTitle': 'Launch groups',
      'mac.launch.groupsNewTitle': 'Create a new launch group',
      'mac.launch.groupsEmpty': 'No groups yet. Use + to save a set of accounts for one-click launching.',
      'mac.launch.groupsLaunch': 'Launch',
      'mac.launch.groupsEdit': 'Edit',
      'mac.launch.groupsRowMeta': '{present} / {total} accounts',
      'mac.launch.groupsModal.newTitle': 'New launch group',
      'mac.launch.groupsModal.editTitle': 'Edit launch group',
      'mac.launch.groupsModal.name': 'Group name',
      'mac.launch.groupsModal.accounts': 'Accounts in group',
      'mac.launch.groupsModal.delete': 'Delete group',
      'mac.launch.groupsModal.confirmDelete': 'Delete this launch group?',
      'mac.launch.groupsModal.needName': 'Enter a group name.',
      'mac.launch.groupsModal.needAccount': 'Select at least one account.',
      'mac.launch.groupQueued': 'Launching group «{name}»: {n} client(s) queued.',
      'mac.launch.groupSkippedNoCreds': '{n} account(s) skipped (missing credentials).',
      'mac.launch.groupsSaved': 'Launch group saved.',
      'mac.launch.groupsModal.layoutRef': 'Virtual desktop (pixels)',
      'mac.launch.groupsModal.noOverlap': 'Prevent overlapping tiles',
      'mac.launch.groupsModal.layoutHint':
        'Drag and resize tiles like the Multibox tab. On Windows, Realm Engine moves each game window after launch (Win32) so positions match this layout — Unity often ignores x/y in launch flags.',
      'mac.launch.groupsLayoutW': 'W',
      'mac.launch.groupsLayoutH': 'H',
      'home.accounts.noConfigured': 'No accounts configured yet.',
      'home.accounts.loadingChars': 'Loading character data...',
      'home.accounts.fetchingTop': 'Fetching highest-fame character...',
      'home.accounts.charNotLoaded': 'Character data not loaded yet.',
      'home.accountRow.summary': '{className} | Fame {fame} | {server}',
      'home.account.unnamed': 'Unnamed Account',
      'home.action.launchSent': 'Launch request sent.',
      'home.action.launchRequested': 'Launch requested for account: {name}',
      'home.action.launchOffline': 'Dashboard connection is offline.',
      'home.action.needCredentials': 'Select an account with credentials first.',
      'home.action.missingCreds': 'Selected account is missing credentials.',
      'home.action.reconnecting': 'Reconnecting dashboard socket...',
      'home.action.gotoScripts': 'Open the Scripts tab to run .mjs script packages.',
      'home.action.scriptsRunThere': 'Scripts run from the Scripts tab.',
      'home.action.useScriptsJs': 'Use the Scripts tab to run .js scripts.',
      'home.action.nexusOk': 'Nexus escape sent.',
      'home.action.nexusFail': 'Nexus action failed.',
      'home.action.nexusReqFail': 'Nexus request failed.',
      'home.action.noPosition': 'No player position available.',
      'home.action.copiedPos': 'Copied position: {text}',
      'home.action.copyFailed': 'Copy failed.',
      'home.action.noClipboard': 'Clipboard not available in this environment.',
      'home.action.adminLogs': 'Enable Admin Mode to open Logs.',
      'accounts.search.placeholder': 'Search alias, email, server...',
      'accounts.sort.aria': 'Sort accounts',
      'accounts.ctx.more': 'More actions',
      'accounts.toolbar.countOne': '{n} ACCOUNT',
      'accounts.toolbar.countOther': '{n} ACCOUNTS',
      'accounts.empty.search': 'No accounts match that search.',
      'accounts.card.noEmail': 'No email',
      'accounts.card.noNotes': 'No notes',
      'accounts.orderDirty': 'Account order changed. Save to persist.',
      'accounts.overview.refreshAccount': 'Refresh Account',
      'accounts.refreshAllBtn': 'Refresh All',
      'accounts.overview.summary.pickChars': 'Select an account to inspect its characters.',
      'accounts.overview.summary.pickInv': 'Select an account to inspect its inventory.',
      'accounts.overview.noneSelected': 'No account selected.',
      'accounts.overview.pickEquip': 'Select an account to inspect its equipment and stats.',
      'accounts.overview.pickInvChars': 'Select an account to inspect its inventory and characters.',
      'accounts.overview.enterCredsChars': 'Enter email and password, then refresh to load characters.',
      'accounts.overview.enterCredsInv': 'Enter email and password, then refresh to load the account inventory.',
      'accounts.overview.missingLogin': 'This account is missing login credentials.',
      'accounts.overview.needCredsChars': 'Character data requires valid account credentials.',
      'accounts.overview.needCredsInv': 'Account inventory requires valid account credentials.',
      'accounts.overview.loadingList': 'Loading character list...',
      'accounts.overview.notLoadedList': 'Character list not loaded yet.',
      'accounts.overview.loadingCharsShort': 'Loading characters...',
      'accounts.overview.clickRefreshChars': 'Click Refresh Characters to load this account.',
      'accounts.overview.loadingAccount': 'Loading account data...',
      'accounts.overview.notLoadedAccount': 'Account data not loaded yet.',
      'accounts.overview.clickRefreshAccount': 'Click Refresh Account to load this account.',
      'accounts.overview.fetchChars': 'Fetching character data from RotMG...',
      'accounts.overview.fetchAccount': 'Fetching account data from RotMG...',
      'accounts.overview.hintLoadChars': 'Load the character list to inspect equipment and stats.',
      'accounts.overview.hintLoadAccount': 'Load the account data to inspect characters and stored items.',
      'accounts.summary.chars': '{n} chars',
      'accounts.summary.vault': 'Vault {n}',
      'accounts.summary.gifts': 'Gifts {n}',
      'accounts.summary.potions': 'Potions {n}',
      'accounts.summary.aliveFame': 'Total alive fame {n}',
      'accounts.summary.bestChar': 'Best char {n}',
      'accounts.summary.updated': 'Updated {time}',
      'accounts.summary.defaultName': 'Account',
      'accounts.notice.cachedFrom': 'Loaded cached character list from {time}.',
      'accounts.notice.cached': 'Loaded cached character list.',
      'accounts.notice.listAt': 'Character list updated at {time}.',
      'accounts.notice.listOk': 'Character list updated.',
      'accounts.notice.loadingList': 'Loading character list...',
      'accounts.error.loadList': 'Failed to load character list.',
      'accounts.character.none': 'This account has no characters.',
      'accounts.character.noneReturned': 'This account did not return any characters.',
      'accounts.character.pick': 'Select a character to inspect its equipment and stats.',
      'accounts.character.classDefault': 'Character',
      'accounts.character.lvl': 'Lvl {n}',
      'accounts.character.seasonal': 'Seasonal',
      'accounts.character.dead': 'Dead',
      'accounts.character.fameMeta': 'Fame {n}',
      'accounts.character.hpMeta': 'HP {n}/{max}',
      'accounts.character.idMeta': 'ID {n}',
      'accounts.equipment.slot': 'Slot {n}',
      'accounts.equipment.empty': 'Empty',
      'accounts.equipment.weapon': 'Weapon',
      'accounts.equipment.ability': 'Ability',
      'accounts.equipment.armor': 'Armor',
      'accounts.equipment.ring': 'Ring',
      'accounts.stat.hp': 'HP',
      'accounts.stat.mp': 'MP',
      'accounts.stat.fame': 'Fame',
      'accounts.stat.exp': 'Exp',
      'accounts.stat.attack': 'Attack',
      'accounts.stat.defense': 'Defense',
      'accounts.stat.speed': 'Speed',
      'accounts.stat.dexterity': 'Dexterity',
      'accounts.stat.vitality': 'Vitality',
      'accounts.stat.wisdom': 'Wisdom',
      'accounts.detail.typeLine': 'Type {hex}',
      'accounts.detail.levelPill': 'Level {n}',
      'accounts.detail.famePill': 'Fame {n}',
      'accounts.detail.charIdPill': 'Char ID {n}',
      'accounts.section.equipped': 'Equipped',
      'accounts.section.stats': 'Stats',
      'accounts.section.inventory': 'Inventory',
      'accounts.browser.noTotals': 'No cached account inventory is available yet.',
      'accounts.browser.noSectionItems': 'No {section} items found on this account.',
      'accounts.browser.hintTotals': 'Click an item to see which account has it and how many.',
      'accounts.browser.hintItems': 'Click any item to inspect its name and enchants.',
      'accounts.browser.uniqueAcrossOne': '{items} unique items across {n} loaded account',
      'accounts.browser.uniqueAcrossOther': '{items} unique items across {n} loaded accounts',
      'accounts.refreshAll.loading': 'Refreshing all account data...',
      'accounts.refreshAll.doneOne': 'Refreshed {n} account.',
      'accounts.refreshAll.doneOther': 'Refreshed {n} accounts.',
      'accounts.error.refreshAll': 'Failed to refresh all accounts.',
      'accounts.storage.summary': '{total} items | {unique} unique',
      'home.equipment.none': 'No equipment data',
      'home.equipment.noneEquipped': 'No equipment equipped',
    },
    es: {
      'tab.home': 'Inicio', 'tab.plugins': 'Complementos', 'tab.api': 'API',
      'tab.market': 'Mercado', 'tab.accounts': 'Cuentas', 'tab.logs': 'Registros',
      'tab.damage': 'Analizador de Daño', 'tab.objects': 'Objetos', 'tab.tilemap': 'Mapa de Tiles',
      'tab.gameWiki': 'Wiki del Juego', 'tab.nearby': 'Jugadores Cercanos', 'tab.scripts': 'Guiones',
      'tab.multibox': 'Multibox',
      'tab.memHelper': 'Ayuda Mem',
      'multibox.toolbar.title': 'Diseño Multibox',
      'multibox.toolbar.hint': 'Marcador — arrastra cualquier parte de una tarjeta para moverla, arrastra la esquina para redimensionar. Añade o quita con el botón o ×.',
      'multibox.placeholder': 'Marcador',
      'multibox.addClient': 'Añadir cliente',
      'multibox.empty': 'Sin clientes. Pulsa «Añadir cliente» para crear una ventana de prueba.',
      'multibox.clientTitle': 'Cliente {n}',
      'multibox.removeClient': 'Quitar',
      'multibox.presets.label': 'Disposiciones',
      'multibox.presetTitle4': 'Estilo cartas: 2 izquierda + grande + barra inferior',
      'multibox.presetTitle6': 'Estilo Kronk: grande arriba-derecha, dos a la izquierda, fila inferior ×3',
      'multibox.presetTitle8': '8 clientes: grande arriba-derecha, izquierda ×2, fila inferior ×5',
      'tab.developer': 'Desarrollador',
      'memHelper.hero.kicker': 'Realm Engine · herramientas admin',
      'memHelper.hero.title': 'Ayuda Mem',
      'memHelper.hero.tagline': 'Higiene de memoria en vivo para ROTMG: recorta colas de paquetes, cachés del Packet Lab y buffers de la UI cuando NEWTICK/MOVE saturen el panel.',
      'memHelper.btn.smartTrim': 'Recorte inteligente',
      'memHelper.btn.serverTrim': 'Recortar buffers del proxy',
      'memHelper.btn.refresh': 'Actualizar estadísticas',
      'memHelper.metrics.title': 'Proceso proxy (Node)',
      'memHelper.metrics.note': 'Mide Realm Engine / proxy — no Flash ni Unity Exalt.',
      'memHelper.metrics.rss': 'RSS',
      'memHelper.metrics.heapUsed': 'Heap usado',
      'memHelper.metrics.heapTotal': 'Heap total',
      'memHelper.metrics.external': 'Externo',
      'memHelper.feat.packetSniffer.title': 'Cola del sniffer',
      'memHelper.feat.packetSniffer.desc': 'Un tráfico alto infla filas decodificadas. El recorte conserva tráfico reciente y reduce JSON retenido.',
      'memHelper.feat.packetLab.title': 'Cache del Packet Lab',
      'memHelper.feat.packetLab.desc': 'Muestras de paquetes desconocidos acumulan hex. El recorte en servidor las borra sin tocar definiciones.',
      'memHelper.feat.dashboard.title': 'Buffers del panel',
      'memHelper.feat.dashboard.desc': 'Reduce historial de paquetes, recorta logs de plugins y compacta el feed de inicio.',
      'memHelper.feat.performance.title': 'Consejo',
      'memHelper.feat.performance.desc': 'Para afinado de CPU en Windows, inspírate en herramientas como Bitsum Process Lasso; Realm Engine solo recorta proxy y UI.',
      'memHelper.danger.title': 'Avanzado',
      'memHelper.danger.intro': 'Poco habitual. Borra entidades/tiles rastreados en el espejo del mundo del panel — los scripts pueden fallar hasta lleguen UPDATE nuevos.',
      'memHelper.danger.btnWorld': 'Reset duro del mundo del panel',
      'memHelper.status.trimOk': 'Recorte terminado.',
      'memHelper.status.worldOk': 'Instantánea del mundo borrada.',
      'memHelper.err.fetch': 'No se pudieron leer las estadísticas de memoria.',
      'sidebar.balance': 'Saldo', 'sidebar.plan': 'Plan', 'sidebar.account': 'Cuenta',
      'sidebar.server': 'Servidor', 'sidebar.ipConnect': 'Conectar por IP',
      'btn.connect': 'Conectar', 'btn.launch': 'Lanzar', 'btn.save': 'Guardar',
      'btn.cancel': 'Cancelar', 'btn.refresh': 'Actualizar',
      'detail.level': 'Nivel', 'detail.stars': 'Estrellas', 'detail.fame': 'Fama',
      'detail.guild': 'Gremio', 'detail.map': 'Mapa', 'detail.gameid': 'ID de Partida',
      'detail.objectid': 'ID de Objeto', 'detail.objecttype': 'Tipo de Objeto',
      'detail.position': 'Posición',
      'detail.questTargetId': 'ID de objetivo de misión',
      'detail.questTargetType': 'Tipo de objetivo',
      'detail.server': 'Servidor',
      'detail.backpackTier': 'Nivel mochila',
      'status.connected': 'Conectado', 'status.disconnected': 'Desconectado',
      'player.notConnected': 'No Conectado', 'player.waitingForGame': 'Esperando el juego...',
      'damage.empty': 'Aún no se registró daño. ¡Golpea algo!',
      'damage.setting.minBossHp': 'HP mín jefe',
      'damage.setting.minMiniBossHp': 'HP mín mini',
      'damage.setting.inGameAlerts': 'Alertas juego',
      'tilemap.autoRefresh': 'Actualización automática',
      'tilemap.empty': 'No hay datos de tiles. Pulsa Actualizar después de conectarte a un servidor y entrar en un mapa.',
      'objects.autoRefresh': 'Actualización automática',
      'objects.empty': 'No hay datos de objetos. Pulsa Actualizar después de conectarte a un servidor y entrar en un mapa.',
      'accountPopup.title': 'Cuenta', 'accountPopup.memberSince': 'Miembro desde',
      'accountPopup.gemBalance': 'Saldo de gemas', 'accountPopup.currentPlan': 'Plan actual',
      'accountPopup.gemStatus.active': 'Activo', 'accountPopup.gemStatus.inactive': 'Inactivo',
      'accountPopup.plan.free': 'Gratis',
      'accountPopup.buyGems.title': 'Comprar gemas', 'accountPopup.buyGems.desc': 'Añade gemas a tu saldo',
      'accountPopup.managePlan.title': 'Gestionar plan', 'accountPopup.managePlan.desc': 'Ver o cambiar tu suscripción',
      'accountPopup.signOut': 'Cerrar sesión', 'accountPopup.notSignedIn': 'No has iniciado sesión',
      'accountPopup.nextDeduction': '· próximo cargo {date}', 'accountPopup.renews': '· se renueva {date}',
      'settings.title': 'Configuración', 'settings.tab.visual': 'Visual',
      'settings.tab.game': 'Juego', 'settings.tab.developer': 'Desarrollador',
      'settings.tab.admin': 'Admin', 'settings.appearance': 'Apariencia',
      'settings.theme': 'Tema', 'settings.themeDesc': 'Elige el tema de color del panel.',
      'settings.language': 'Idioma', 'settings.languageDesc': 'Elige el idioma de visualización del panel.',
      'settings.showStatBonuses': 'Mostrar bonos de estadísticas',
      'settings.showServerPing': 'Mostrar ping del servidor',
      'settings.showServerPingDesc': 'Mostrar latencia (ms) junto a cada servidor en el selector.',
      'settings.showAccountEmails': 'Mostrar correos de cuentas',
      'settings.showAccountEmailsDesc': 'Mostrar u ocultar el correo bajo cada cuenta en la lista.',
      'settings.navbarTabs': 'Pestañas de Navegación',
      'settings.packetSniffer': 'Sniffer de paquetes',
      'settings.packetSnifferDesc': 'Mostrar u ocultar el panel inferior del sniffer mientras el modo administrador está activo.',
      'tutorial.settings.title': 'Tutorial',
      'tutorial.settings.replayLabel': 'Repetir tutorial',
      'tutorial.settings.replayDesc': 'Recorre de nuevo la introducción de la app.',
      'tutorial.settings.replayBtn': 'Repetir',
      'tutorial.step0.title': 'Bienvenido a Realm Engine',
      'tutorial.step0.body': 'Tu compañero todo en uno para Realm of the Mad God. Hagamos un recorrido rápido para que sepas dónde está todo.',
      'tutorial.step0.dim': 'Esto solo tomará un minuto.',
      'tutorial.step1.title': 'Inicio',
      'tutorial.step1.body': 'La pestaña Inicio es tu centro de mando. Desde aquí puedes:',
      'tutorial.step1.li1': '<strong>Script activo</strong> &mdash; Acceso rápido a la pestaña Guiones para scripts .js basados en disco.',
      'tutorial.step1.li2': '<strong>Estadísticas de sesión</strong> &mdash; Sigue tiempo activo, fama ganada, bolsas blancas, eventos derrotados y mazmorras completadas en tiempo real.',
      'tutorial.step1.li3': '<strong>Cuentas listas</strong> &mdash; Inicia rápidamente cualquiera de tus cuentas guardadas desde el panel.',
      'tutorial.step1.li4': '<strong>Editar diseño</strong> &mdash; Haz clic en el icono del lápiz en la esquina superior para reorganizar, ocultar o restaurar tarjetas. Arrastra para reordenar y guardar tu diseño.',
      'tutorial.step2.title': 'Plugins',
      'tutorial.step2.body': 'Los plugins amplían lo que Realm Engine puede hacer. El centro de plugins te permite:',
      'tutorial.step2.li1': '<strong>Explorar y buscar</strong> &mdash; Encuentra plugins por nombre o filtra por categoría.',
      'tutorial.step2.li2': '<strong>Activar / desactivar</strong> &mdash; Activa o desactiva plugins con un solo clic.',
      'tutorial.step2.li3': '<strong>Configurar</strong> &mdash; Cada plugin tiene su propio panel de ajustes para adaptarlo a tu estilo de juego.',
      'tutorial.step2.dim': 'Los plugins incluyen utilidades como auto-aim, auto-dodge, auto-nexus y más.',
      'tutorial.step3.title': 'Cuentas',
      'tutorial.step3.body1': 'Aquí es donde gestionas tus cuentas de Realm. Puedes guardar varias cuentas, ver resúmenes de personajes, contenidos de bóveda y entrar al juego.',
      'tutorial.step3.body2': 'Agreguemos tu primera cuenta ahora para empezar.',
      'tutorial.step3.passwordPlaceholder': 'Contraseña',
      'tutorial.step3.dim': 'Siempre puedes añadir más cuentas después o saltarte este paso por ahora.',
      'tutorial.step4.title': 'Damage Sniffer',
      'tutorial.step4.body': 'Damage Sniffer registra datos de combate mientras juegas. Rastrea:',
      'tutorial.step4.li1': '<strong>Runs</strong> &mdash; Cada encuentro se registra con una vista en vivo y un historial guardado.',
      'tutorial.step4.li2': '<strong>Objetivos</strong> &mdash; Mira todos los enemigos a los que golpeas y filtra por jefe o miniboss.',
      'tutorial.step4.li3': '<strong>Desglose por jugador</strong> &mdash; Consulta el DPS y la contribución de daño por jugador.',
      'tutorial.step4.dim': 'Los datos se capturan automáticamente &mdash; solo juega y revisa tus estadísticas cuando quieras.',
      'tutorial.step5.title': '¡Todo listo!',
      'tutorial.step5.body': 'Eso cubre lo esencial. Puedes explorar cada pestaña a tu ritmo. Si alguna vez quieres repetir este recorrido, puedes reiniciarlo en Ajustes.',
      'tutorial.step5.dim': '¡Feliz realmeo!',
      'tutorial.nav.skip': 'Saltar',
      'tutorial.nav.back': 'Atrás',
      'tutorial.nav.next': 'Siguiente',
      'tutorial.nav.finish': 'Finalizar',
      'tutorial.nav.getStarted': 'Comenzar',
      'tutorial.nav.continue': 'Continuar',
      'tutorial.nav.addContinue': 'Agregar y continuar',
      'tutorial.status.saving': 'Guardando cuenta...',
      'tutorial.status.success': '¡Cuenta agregada correctamente!',
      'tutorial.status.error': 'No se pudo guardar - puedes añadirla manualmente después.',
      'plugins.hub.aria': 'Complementos',
      'plugins.search.placeholder': 'Buscar complementos...',
      'plugins.search.aria': 'Buscar complementos',
      'plugins.category.filter.aria': 'Filtrar por categoría',
      'plugins.list.aria': 'Lista de complementos',
      'plugins.loading': 'Cargando complementos...',
      'plugins.category.all': 'Todas las categorías',
      'plugins.category.combat': 'Combate',
      'plugins.category.movement': 'Movimiento',
      'plugins.category.automation': 'Automatización',
      'plugins.category.visual': 'Visual',
      'plugins.category.network': 'Red',
      'plugins.category.utility': 'Utilidad',
      'plugins.category.admin': 'Administración',
      'plugins.teleport.beacon': 'Baliza',
      'plugins.teleport.beaconSelect': 'Baliza de teletransporte',
      'plugins.teleport.select': '-- Selecciona una baliza --',
      'plugins.teleport.none': '(no hay balizas visibles)',
      'plugins.teleport.typePrefix': 'Tipo',
      'plugins.teleport.objectId': 'oid',
      'plugins.empty.enable': 'Activa complementos desde la barra lateral',
      'plugins.empty.none': 'No hay complementos cargados',
      'plugins.empty.noMatchSidebar': 'Ningún complemento coincide.',
      'plugins.empty.noMatchDetail': 'Ningún complemento coincide con tu búsqueda o categoría.',
      'home.activeScript': 'Script Activo', 'home.sessionStats': 'Estadísticas de Sesión',
      'home.accountsReady': 'Cuentas Listas para Lanzar',
      'accounts.setup.title': 'Agregar tu Primera Cuenta',
      'accounts.setup.subtitle': 'Ingresa tus credenciales del juego para comenzar.',
      'accounts.label.alias': 'Alias', 'accounts.label.email': 'Correo',
      'accounts.label.password': 'Contraseña', 'accounts.label.server': 'Servidor',
      'accounts.label.notes': 'Notas', 'accounts.btn.show': 'Mostrar',
      'accounts.placeholder.aliasOptional': 'Nombre visible (opcional)',
      'accounts.placeholder.alias': 'Nombre visible',
      'accounts.placeholder.password': 'Contraseña',
      'accounts.placeholder.notes': 'Notas opcionales',
      'accounts.btn.addFirst': 'Agregar Cuenta', 'accounts.btn.addNew': '+ Agregar Cuenta',
      'accounts.btn.saveChanges': 'Guardar Cambios',
      'accounts.list.title': 'Cuentas Guardadas',
      'accounts.sort.newest': 'Más Reciente', 'accounts.sort.oldest': 'Más Antiguo',
      'accounts.sort.alpha': 'Alfabético', 'accounts.sort.fame': 'Fama',
      'accounts.ctx.refreshAll': 'Actualizar Todas las Cuentas',
      'accounts.ctx.reorder': 'Reordenar Cuentas', 'accounts.ctx.delete': 'Eliminar Cuenta',
      'accounts.empty': 'No hay cuentas guardadas aún.',
      'accounts.editor.title': 'Detalles de la Cuenta',
      'accounts.overview.title': 'Resumen de Personajes',
      'accounts.overview.summary': 'Selecciona una cuenta para ver sus personajes.',
      'accounts.overview.refreshBtn': 'Actualizar Personajes',
      'accounts.overview.tab.chars': 'Personajes', 'accounts.overview.tab.vault': 'Bóveda',
      'accounts.overview.tab.gifts': 'Regalos', 'accounts.overview.tab.potions': 'Pociones',
      'accounts.overview.tab.totals': 'Inventario Total',
      'accounts.overview.emptyChars': 'No hay datos de personajes cargados.',
      'accounts.overview.selectChar': 'Selecciona un personaje para ver su equipamiento y estadísticas.',
      'accounts.modal.delete.title': 'Eliminar Cuenta',
      'accounts.modal.delete.msg': '¿Estás seguro de que quieres eliminar esta cuenta?',
      'accounts.modal.delete.confirm': 'Eliminar',
      'accounts.modal.locked.title': 'Cuenta en Uso',
      'accounts.modal.locked.msg': 'Debes desconectarte del juego antes de editar esta cuenta.',
      'accounts.modal.locked.ok': 'Aceptar',
      'status.connecting': 'Conectando',
      'common.loading': 'Cargando...',
      'common.refreshing': 'Actualizando...',
      'home.edit.title': 'Editar diseño',
      'home.script.selectPlaceholder': '-- Seleccionar script --',
      'home.script.useScriptsTab': 'Usar pestaña Guiones',
      'home.script.runtime': 'Tiempo de ejecución',
      'home.script.currentStatus': 'Estado actual',
      'home.script.start': 'Iniciar',
      'home.script.pause': 'Pausa',
      'home.script.openScriptsTab': 'Guiones',
      'home.script.note.setup': 'Usa la pestaña Guiones para ejecutar paquetes .mjs desde Documents/Realmengine/Scripts.',
      'home.script.note.lastRun': 'Última ejecución: {name} ({duration})',
      'home.script.state.running': 'En ejecución',
      'home.script.state.paused': 'En pausa',
      'home.script.state.idle': 'Inactivo',
      'home.conn.listening': 'Escuchando en el puerto 2050',
      'home.conn.clientDetected': 'RotMG Exalt detectado',
      'home.conn.clientWaiting': 'Esperando RotMG Exalt...',
      'home.stat.uptime': 'Tiempo activo',
      'home.stat.totalFameGained': 'Fama total ganada',
      'home.stat.averageFpm': 'FPM promedio',
      'home.stat.whiteBags': 'White bags',
      'home.stat.eventsKilled': 'Eventos eliminados',
      'home.stat.dungeonsRan': 'Mazmorras completadas',
      'home.session.lastSession': 'Última sesión: {name} - {duration}',
      'home.session.lastEmpty': 'Última sesión: --',
      'home.session.ended': 'Finalizada: {time}',
      'home.session.endedEmpty': 'Finalizada: --',
      'home.feed.empty': 'Aún no hay eventos de sesión.',
      'home.feed.cleared': 'Feed de sesión borrado.',
      'home.accounts.sortAria': 'Ordenar cuentas para lanzar',
      'home.accounts.noConfigured': 'Aún no hay cuentas configuradas.',
      'home.accounts.loadingChars': 'Cargando datos de personajes...',
      'home.accounts.fetchingTop': 'Obteniendo personaje con más fama...',
      'home.accounts.charNotLoaded': 'Datos de personajes no cargados.',
      'home.accountRow.summary': '{className} | Fama {fame} | {server}',
      'home.account.unnamed': 'Cuenta sin nombre',
      'home.action.launchSent': 'Solicitud de lanzamiento enviada.',
      'home.action.launchRequested': 'Lanzamiento solicitado para la cuenta: {name}',
      'home.action.launchOffline': 'La conexión del panel está desconectada.',
      'home.action.needCredentials': 'Selecciona una cuenta con credenciales primero.',
      'home.action.missingCreds': 'A la cuenta seleccionada le faltan credenciales.',
      'home.action.reconnecting': 'Reconectando socket del panel...',
      'home.action.gotoScripts': 'Abre la pestaña Guiones para ejecutar paquetes .mjs.',
      'home.action.scriptsRunThere': 'Los scripts se ejecutan desde la pestaña Guiones.',
      'home.action.useScriptsJs': 'Usa la pestaña Guiones para ejecutar scripts .js.',
      'home.action.nexusOk': 'Escape al Nexo enviado.',
      'home.action.nexusFail': 'Acción del Nexo fallida.',
      'home.action.nexusReqFail': 'Solicitud al Nexo fallida.',
      'home.action.noPosition': 'No hay posición del jugador disponible.',
      'home.action.copiedPos': 'Posición copiada: {text}',
      'home.action.copyFailed': 'Copia fallida.',
      'home.action.noClipboard': 'Portapapeles no disponible en este entorno.',
      'home.action.adminLogs': 'Activa el modo administrador para abrir Registros.',
      'accounts.search.placeholder': 'Buscar alias, correo, servidor...',
      'accounts.sort.aria': 'Ordenar cuentas',
      'accounts.ctx.more': 'Más acciones',
      'accounts.toolbar.countOne': '{n} CUENTA',
      'accounts.toolbar.countOther': '{n} CUENTAS',
      'accounts.empty.search': 'Ninguna cuenta coincide con esa búsqueda.',
      'accounts.card.noEmail': 'Sin correo',
      'accounts.card.noNotes': 'Sin notas',
      'accounts.orderDirty': 'Orden de cuentas cambiado. Guarda para persistir.',
      'accounts.overview.refreshAccount': 'Actualizar cuenta',
      'accounts.refreshAllBtn': 'Actualizar todo',
      'accounts.overview.summary.pickChars': 'Selecciona una cuenta para ver sus personajes.',
      'accounts.overview.summary.pickInv': 'Selecciona una cuenta para ver su inventario.',
      'accounts.overview.noneSelected': 'Ninguna cuenta seleccionada.',
      'accounts.overview.pickEquip': 'Selecciona una cuenta para ver equipo y estadísticas.',
      'accounts.overview.pickInvChars': 'Selecciona una cuenta para ver inventario y personajes.',
      'accounts.overview.enterCredsChars': 'Introduce correo y contraseña, luego actualiza para cargar personajes.',
      'accounts.overview.enterCredsInv': 'Introduce correo y contraseña, luego actualiza para cargar el inventario.',
      'accounts.overview.missingLogin': 'A esta cuenta le faltan credenciales.',
      'accounts.overview.needCredsChars': 'Los datos de personajes requieren credenciales válidas.',
      'accounts.overview.needCredsInv': 'El inventario requiere credenciales válidas.',
      'accounts.overview.loadingList': 'Cargando lista de personajes...',
      'accounts.overview.notLoadedList': 'Lista de personajes aún no cargada.',
      'accounts.overview.loadingCharsShort': 'Cargando personajes...',
      'accounts.overview.clickRefreshChars': 'Pulsa Actualizar personajes para cargar esta cuenta.',
      'accounts.overview.loadingAccount': 'Cargando datos de la cuenta...',
      'accounts.overview.notLoadedAccount': 'Datos de la cuenta aún no cargados.',
      'accounts.overview.clickRefreshAccount': 'Pulsa Actualizar cuenta para cargar esta cuenta.',
      'accounts.overview.fetchChars': 'Obteniendo datos de personajes de RotMG...',
      'accounts.overview.fetchAccount': 'Obteniendo datos de la cuenta de RotMG...',
      'accounts.overview.hintLoadChars': 'Carga la lista de personajes para ver equipo y estadísticas.',
      'accounts.overview.hintLoadAccount': 'Carga los datos de la cuenta para ver personajes e ítems.',
      'accounts.summary.chars': '{n} pers.',
      'accounts.summary.vault': 'Bóveda {n}',
      'accounts.summary.gifts': 'Regalos {n}',
      'accounts.summary.potions': 'Pociones {n}',
      'accounts.summary.aliveFame': 'Fama viva total {n}',
      'accounts.summary.bestChar': 'Mejor pers. {n}',
      'accounts.summary.updated': 'Actualizado {time}',
      'accounts.summary.defaultName': 'Cuenta',
      'accounts.notice.cachedFrom': 'Lista de personajes en caché cargada desde {time}.',
      'accounts.notice.cached': 'Lista de personajes en caché cargada.',
      'accounts.notice.listAt': 'Lista de personajes actualizada a las {time}.',
      'accounts.notice.listOk': 'Lista de personajes actualizada.',
      'accounts.notice.loadingList': 'Cargando lista de personajes...',
      'accounts.error.loadList': 'No se pudo cargar la lista de personajes.',
      'accounts.character.none': 'Esta cuenta no tiene personajes.',
      'accounts.character.noneReturned': 'Esta cuenta no devolvió personajes.',
      'accounts.character.pick': 'Selecciona un personaje para ver equipo y estadísticas.',
      'accounts.character.classDefault': 'Personaje',
      'accounts.character.lvl': 'Nv. {n}',
      'accounts.character.seasonal': 'Temporal',
      'accounts.character.dead': 'Muerto',
      'accounts.character.fameMeta': 'Fama {n}',
      'accounts.character.hpMeta': 'PV {n}/{max}',
      'accounts.character.idMeta': 'ID {n}',
      'accounts.equipment.slot': 'Ranura {n}',
      'accounts.equipment.empty': 'Vacío',
      'accounts.equipment.weapon': 'Arma',
      'accounts.equipment.ability': 'Habilidad',
      'accounts.equipment.armor': 'Armadura',
      'accounts.equipment.ring': 'Anillo',
      'accounts.stat.hp': 'PV',
      'accounts.stat.mp': 'PM',
      'accounts.stat.fame': 'Fama',
      'accounts.stat.exp': 'Exp',
      'accounts.stat.attack': 'Ataque',
      'accounts.stat.defense': 'Defensa',
      'accounts.stat.speed': 'Velocidad',
      'accounts.stat.dexterity': 'Destreza',
      'accounts.stat.vitality': 'Vitalidad',
      'accounts.stat.wisdom': 'Sabiduría',
      'accounts.detail.typeLine': 'Tipo {hex}',
      'accounts.detail.levelPill': 'Nivel {n}',
      'accounts.detail.famePill': 'Fama {n}',
      'accounts.detail.charIdPill': 'ID pers. {n}',
      'accounts.section.equipped': 'Equipado',
      'accounts.section.stats': 'Estadísticas',
      'accounts.section.inventory': 'Inventario',
      'accounts.browser.noTotals': 'Aún no hay inventario en caché.',
      'accounts.browser.noSectionItems': 'No hay ítems de {section} en esta cuenta.',
      'accounts.browser.hintTotals': 'Pulsa un ítem para ver en qué cuenta está y cuántos hay.',
      'accounts.browser.hintItems': 'Pulsa cualquier ítem para ver nombre y encantamientos.',
      'accounts.browser.uniqueAcrossOne': '{items} ítems únicos en {n} cuenta cargada',
      'accounts.browser.uniqueAcrossOther': '{items} ítems únicos en {n} cuentas cargadas',
      'accounts.refreshAll.loading': 'Actualizando todas las cuentas...',
      'accounts.refreshAll.doneOne': '{n} cuenta actualizada.',
      'accounts.refreshAll.doneOther': '{n} cuentas actualizadas.',
      'accounts.error.refreshAll': 'No se pudieron actualizar todas las cuentas.',
      'accounts.storage.summary': '{total} objetos | {unique} únicos',
      'home.equipment.none': 'Sin datos de equipo',
      'home.equipment.noneEquipped': 'Sin equipo equipado',
    },
    de: {
      'tab.home': 'Startseite', 'tab.plugins': 'Erweiterungen', 'tab.api': 'API',
      'tab.market': 'Markt', 'tab.accounts': 'Konten', 'tab.logs': 'Protokolle',
      'tab.damage': 'Schadensanalyse', 'tab.objects': 'Objekte', 'tab.tilemap': 'Kachelkarte',
      'tab.gameWiki': 'Spiel-Wiki', 'tab.nearby': 'Nahe Spieler', 'tab.scripts': 'Skripte',
      'tab.multibox': 'Multibox',
      'tab.memHelper': 'Speicher-Hilfe',
      'multibox.toolbar.title': 'Multibox-Layout',
      'multibox.toolbar.hint': 'Platzhalter — Karte zum Verschieben ziehen, Ecke zum Größenändern ziehen. Clients mit Button oder × hinzufügen oder entfernen.',
      'multibox.placeholder': 'Platzhalter',
      'multibox.addClient': 'Client hinzufügen',
      'multibox.empty': 'Keine Clients. Klick zum Erstellen auf «Client hinzufügen».',
      'multibox.clientTitle': 'Client {n}',
      'multibox.removeClient': 'Entfernen',
      'multibox.presets.label': 'Vorlagen',
      'multibox.presetTitle4': 'Kronk-ähnlich: 2 links + breit oben + untere Leiste',
      'multibox.presetTitle6': 'Wie KronkBoxer: groß oben rechts, zwei links gestapelt, unten ×3',
      'multibox.presetTitle8': '8 Clients: groß oben rechts, links ×2, unten ×5',
      'tab.developer': 'Entwickler',
      'memHelper.hero.kicker': 'Realm Engine · Admin-Tools',
      'memHelper.hero.title': 'Speicher-Hilfe',
      'memHelper.hero.tagline': 'Live-Speicherhygiene für ROTMG: Paket-Backlog, Packet-Lab-Caches und Dashboard-Puffer kappen, wenn NEWTICK/MOVE fluten.',
      'memHelper.btn.smartTrim': 'Smart trim',
      'memHelper.btn.serverTrim': 'Proxy-Puffer leeren',
      'memHelper.btn.refresh': 'Statistik aktualisieren',
      'memHelper.metrics.title': 'Proxy-Prozess (Node)',
      'memHelper.metrics.note': 'Misst Realm Engine / Proxy — nicht Flash oder Unity Exalt.',
      'memHelper.metrics.rss': 'RSS',
      'memHelper.metrics.heapUsed': 'Heap belegt',
      'memHelper.metrics.heapTotal': 'Heap gesamt',
      'memHelper.metrics.external': 'Extern',
      'memHelper.feat.packetSniffer.title': 'Paket-Sniffer',
      'memHelper.feat.packetSniffer.desc': 'Hohe Packet-Raten blähen dekodierte Zeilen auf. Smart Trim hält letzte Pakete und schneidet große JSON-Zeilen.',
      'memHelper.feat.packetLab.title': 'Packet Lab',
      'memHelper.feat.packetLab.desc': 'Unbekannte Samples sammeln Hex. Server-Trim löscht sie, Definitionen bleiben.',
      'memHelper.feat.dashboard.title': 'Dashboard-Puffer',
      'memHelper.feat.dashboard.desc': 'Kürzt Paketliste, Plugin-Logs und Home-Feed gemeinsam mit dem Node-Trim.',
      'memHelper.feat.performance.title': 'Hinweis',
      'memHelper.feat.performance.desc': 'CPU-Affinität und Priorität: z. B. Bitsum Process Lasso; Realm Engine trimmt nur Proxy/UI.',
      'memHelper.danger.title': 'Erweitert',
      'memHelper.danger.intro': 'Löscht getrackte Entities/Tiles — Skripte können haken, bis neue UPDATEs kommen.',
      'memHelper.danger.btnWorld': 'Welt-Snapshot hart zurücksetzen',
      'memHelper.status.trimOk': 'Trim abgeschlossen.',
      'memHelper.status.worldOk': 'Welt-Snapshot gelöscht.',
      'memHelper.err.fetch': 'Speicherstatistik konnte nicht gelesen werden.',
      'sidebar.balance': 'Guthaben', 'sidebar.plan': 'Plan', 'sidebar.account': 'Konto',
      'sidebar.server': 'Server', 'sidebar.ipConnect': 'IP-Verbindung',
      'btn.connect': 'Verbinden', 'btn.launch': 'Starten', 'btn.save': 'Speichern',
      'btn.cancel': 'Abbrechen', 'btn.refresh': 'Aktualisieren',
      'detail.level': 'Stufe', 'detail.stars': 'Sterne', 'detail.fame': 'Ruhm',
      'detail.guild': 'Gilde', 'detail.map': 'Karte', 'detail.gameid': 'Spiel-ID',
      'detail.objectid': 'Objekt-ID', 'detail.objecttype': 'Objekttyp',
      'detail.position': 'Position',
      'detail.questTargetId': 'Questziel-ID',
      'detail.questTargetType': 'Questziel-Typ',
      'detail.server': 'Server',
      'detail.backpackTier': 'Rucksackstufe',
      'status.connected': 'Verbunden', 'status.disconnected': 'Getrennt',
      'player.notConnected': 'Nicht Verbunden', 'player.waitingForGame': 'Warte auf Spiel...',
      'damage.empty': 'Noch kein Schaden erfasst. Triff etwas!',
      'damage.setting.minBossHp': 'Boss-HP min.',
      'damage.setting.minMiniBossHp': 'Mini-HP min.',
      'damage.setting.inGameAlerts': 'Spiel-Alerts',
      'tilemap.autoRefresh': 'Automatisch aktualisieren',
      'tilemap.empty': 'Keine Tile-Daten. Klicke auf Aktualisieren, nachdem du dich mit einem Server verbunden und eine Karte betreten hast.',
      'objects.autoRefresh': 'Automatisch aktualisieren',
      'objects.empty': 'Keine Objektdaten. Klicke auf Aktualisieren, nachdem du dich mit einem Server verbunden und eine Karte betreten hast.',
      'accountPopup.title': 'Konto', 'accountPopup.memberSince': 'Mitglied seit',
      'accountPopup.gemBalance': 'Edelsteinguthaben', 'accountPopup.currentPlan': 'Aktueller Plan',
      'accountPopup.gemStatus.active': 'Aktiv', 'accountPopup.gemStatus.inactive': 'Inaktiv',
      'accountPopup.plan.free': 'Kostenlos',
      'accountPopup.buyGems.title': 'Edelsteine kaufen', 'accountPopup.buyGems.desc': 'Deinem Guthaben Edelsteine hinzufügen',
      'accountPopup.managePlan.title': 'Plan verwalten', 'accountPopup.managePlan.desc': 'Abo ansehen oder ändern',
      'accountPopup.signOut': 'Abmelden', 'accountPopup.notSignedIn': 'Nicht angemeldet',
      'accountPopup.nextDeduction': '· naechster Abzug {date}', 'accountPopup.renews': '· verlaengert sich am {date}',
      'settings.title': 'Einstellungen', 'settings.tab.visual': 'Visuell',
      'settings.tab.game': 'Spiel', 'settings.tab.developer': 'Entwickler',
      'settings.tab.admin': 'Admin', 'settings.appearance': 'Erscheinungsbild',
      'settings.theme': 'Thema', 'settings.themeDesc': 'Wähle das Dashboard-Farbthema.',
      'settings.language': 'Sprache', 'settings.languageDesc': 'Wähle die Dashboard-Anzeigesprache.',
      'settings.showStatBonuses': 'Statboni anzeigen',
      'settings.showServerPing': 'Serverping anzeigen',
      'settings.showServerPingDesc': 'Latenz (ms) neben jedem Server im Dropdown anzeigen.',
      'settings.showAccountEmails': 'Konto-E-Mails anzeigen',
      'settings.showAccountEmailsDesc': 'E-Mail-Zeile unter jedem Konto in der Liste ein-/ausblenden.',
      'settings.navbarTabs': 'Navigationsleisten-Tabs',
      'settings.packetSniffer': 'Paket-Sniffer',
      'settings.packetSnifferDesc': 'Unteres Paket-Sniffer-Panel ein- oder ausblenden, solange der Admin-Modus aktiv ist.',
      'tutorial.settings.title': 'Tutorial',
      'tutorial.settings.replayLabel': 'Tutorial erneut abspielen',
      'tutorial.settings.replayDesc': 'Gehe die App-Einführung noch einmal durch.',
      'tutorial.settings.replayBtn': 'Erneut abspielen',
      'tutorial.step0.title': 'Willkommen bei Realm Engine',
      'tutorial.step0.body': 'Dein All-in-One-Begleiter für Realm of the Mad God. Machen wir eine kurze Tour, damit du weißt, wo alles ist.',
      'tutorial.step0.dim': 'Das dauert nur eine Minute.',
      'tutorial.step1.title': 'Start',
      'tutorial.step1.body': 'Der Start-Tab ist deine Schaltzentrale. Von hier aus kannst du:',
      'tutorial.step1.li1': '<strong>Aktives Skript</strong> &mdash; Schnellzugriff auf den Skripte-Tab für festplattenbasierte .js-Skripte.',
      'tutorial.step1.li2': '<strong>Sitzungsstatistiken</strong> &mdash; Verfolge Laufzeit, gewonnenen Ruhm, White Bags, besiegte Events und abgeschlossene Dungeons in Echtzeit.',
      'tutorial.step1.li3': '<strong>Bereite Konten</strong> &mdash; Starte schnell jedes deiner gespeicherten Konten direkt vom Dashboard.',
      'tutorial.step1.li4': '<strong>Layout bearbeiten</strong> &mdash; Klicke auf das Stiftsymbol oben, um Karten neu anzuordnen, auszublenden oder wiederherzustellen. Ziehe sie per Drag-and-Drop und speichere dein Layout.',
      'tutorial.step2.title': 'Plugins',
      'tutorial.step2.body': 'Plugins erweitern die Möglichkeiten von Realm Engine. Im Plugin-Hub kannst du:',
      'tutorial.step2.li1': '<strong>Durchsuchen und suchen</strong> &mdash; Finde Plugins nach Namen oder filtere nach Kategorie.',
      'tutorial.step2.li2': '<strong>Aktivieren / deaktivieren</strong> &mdash; Schalte Plugins mit einem Klick ein oder aus.',
      'tutorial.step2.li3': '<strong>Konfigurieren</strong> &mdash; Jedes Plugin hat ein eigenes Einstellungsfeld, das du an deinen Spielstil anpassen kannst.',
      'tutorial.step2.dim': 'Plugins enthalten Hilfen wie Auto-Aim, Auto-Dodge, Auto-Nexus und mehr.',
      'tutorial.step3.title': 'Konten',
      'tutorial.step3.body1': 'Hier verwaltest du deine Realm-Konten. Du kannst mehrere Konten speichern, Charakterübersichten und Vault-Inhalte ansehen und ins Spiel starten.',
      'tutorial.step3.body2': 'Lass uns jetzt dein erstes Konto hinzufügen, damit du loslegen kannst.',
      'tutorial.step3.passwordPlaceholder': 'Passwort',
      'tutorial.step3.dim': 'Du kannst später immer weitere Konten hinzufügen oder diesen Schritt vorerst überspringen.',
      'tutorial.step4.title': 'Damage Sniffer',
      'tutorial.step4.body': 'Der Damage Sniffer zeichnet während des Spielens Kampfdaten auf. Er verfolgt:',
      'tutorial.step4.li1': '<strong>Runs</strong> &mdash; Jede Begegnung wird mit Live-Ansicht und gespeicherter Historie protokolliert.',
      'tutorial.step4.li2': '<strong>Ziele</strong> &mdash; Sieh jeden getroffenen Gegner und filtere nach Boss oder Miniboss.',
      'tutorial.step4.li3': '<strong>Spieleraufschlüsselung</strong> &mdash; Zeige DPS und Schadensbeiträge pro Spieler an.',
      'tutorial.step4.dim': 'Daten werden automatisch erfasst &mdash; spiele einfach und prüfe deine Statistiken jederzeit.',
      'tutorial.step5.title': 'Du bist startklar!',
      'tutorial.step5.body': 'Das deckt das Wichtigste ab. Du kannst jeden Tab in deinem eigenen Tempo erkunden. Wenn du diese Tour erneut sehen willst, kannst du sie in den Einstellungen zurücksetzen.',
      'tutorial.step5.dim': 'Viel Spaß beim Realmen!',
      'tutorial.nav.skip': 'Überspringen',
      'tutorial.nav.back': 'Zurück',
      'tutorial.nav.next': 'Weiter',
      'tutorial.nav.finish': 'Fertig',
      'tutorial.nav.getStarted': 'Los geht\'s',
      'tutorial.nav.continue': 'Weiter',
      'tutorial.nav.addContinue': 'Hinzufügen und weiter',
      'tutorial.status.saving': 'Konto wird gespeichert...',
      'tutorial.status.success': 'Konto erfolgreich hinzugefügt!',
      'tutorial.status.error': 'Speichern fehlgeschlagen - du kannst es später manuell hinzufügen.',
      'plugins.hub.aria': 'Plugins',
      'plugins.search.placeholder': 'Plugins durchsuchen...',
      'plugins.search.aria': 'Plugins durchsuchen',
      'plugins.category.filter.aria': 'Nach Kategorie filtern',
      'plugins.list.aria': 'Plugin-Liste',
      'plugins.loading': 'Plugins werden geladen...',
      'plugins.category.all': 'Alle Kategorien',
      'plugins.category.combat': 'Kampf',
      'plugins.category.movement': 'Bewegung',
      'plugins.category.automation': 'Automatisierung',
      'plugins.category.visual': 'Visuell',
      'plugins.category.network': 'Netzwerk',
      'plugins.category.utility': 'Hilfsmittel',
      'plugins.category.admin': 'Admin',
      'plugins.teleport.beacon': 'Leuchtfeuer',
      'plugins.teleport.beaconSelect': 'Teleport-Leuchtfeuer',
      'plugins.teleport.select': '-- Leuchtfeuer wählen --',
      'plugins.teleport.none': '(keine Leuchtfeuer sichtbar)',
      'plugins.teleport.typePrefix': 'Typ',
      'plugins.teleport.objectId': 'oid',
      'plugins.empty.enable': 'Aktiviere Plugins in der Seitenleiste',
      'plugins.empty.none': 'Keine Plugins geladen',
      'plugins.empty.noMatchSidebar': 'Keine passenden Plugins.',
      'plugins.empty.noMatchDetail': 'Keine Plugins passen zu deiner Suche oder Kategorie.',
      'home.activeScript': 'Aktives Skript', 'home.sessionStats': 'Sitzungsstatistiken',
      'home.accountsReady': 'Startbereite Konten',
      'accounts.setup.title': 'Erstes Konto hinzufügen',
      'accounts.setup.subtitle': 'Gib deine Spielanmeldedaten ein, um zu beginnen.',
      'accounts.label.alias': 'Alias', 'accounts.label.email': 'E-Mail',
      'accounts.label.password': 'Passwort', 'accounts.label.server': 'Server',
      'accounts.label.notes': 'Notizen', 'accounts.btn.show': 'Anzeigen',
      'accounts.placeholder.aliasOptional': 'Anzeigename (optional)',
      'accounts.placeholder.alias': 'Anzeigename',
      'accounts.placeholder.password': 'Passwort',
      'accounts.placeholder.notes': 'Optionale Notizen',
      'accounts.btn.addFirst': 'Konto hinzufügen', 'accounts.btn.addNew': '+ Konto hinzufügen',
      'accounts.btn.saveChanges': 'Änderungen speichern',
      'accounts.list.title': 'Gespeicherte Konten',
      'accounts.sort.newest': 'Neueste', 'accounts.sort.oldest': 'Älteste',
      'accounts.sort.alpha': 'Alphabetisch', 'accounts.sort.fame': 'Ruhm',
      'accounts.ctx.refreshAll': 'Alle Konten aktualisieren',
      'accounts.ctx.reorder': 'Konten neu anordnen', 'accounts.ctx.delete': 'Konto löschen',
      'accounts.empty': 'Noch keine Konten gespeichert.',
      'accounts.editor.title': 'Kontodetails',
      'accounts.overview.title': 'Charakterübersicht',
      'accounts.overview.summary': 'Wähle ein Konto, um seine Charaktere zu inspizieren.',
      'accounts.overview.refreshBtn': 'Charaktere aktualisieren',
      'accounts.overview.tab.chars': 'Charaktere', 'accounts.overview.tab.vault': 'Tresor',
      'accounts.overview.tab.gifts': 'Geschenke', 'accounts.overview.tab.potions': 'Tränke',
      'accounts.overview.tab.totals': 'Gesamtinventar',
      'accounts.overview.emptyChars': 'Keine Charakterdaten geladen.',
      'accounts.overview.selectChar': 'Wähle einen Charakter, um Ausrüstung und Werte zu prüfen.',
      'accounts.modal.delete.title': 'Konto löschen',
      'accounts.modal.delete.msg': 'Möchtest du dieses Konto wirklich löschen?',
      'accounts.modal.delete.confirm': 'Löschen',
      'accounts.modal.locked.title': 'Konto in Benutzung',
      'accounts.modal.locked.msg': 'Du musst dich vom Spiel trennen, bevor du dieses Konto bearbeitest.',
      'accounts.modal.locked.ok': 'OK',
      'status.connecting': 'Verbindung wird hergestellt',
      'common.loading': 'Lädt...',
      'common.refreshing': 'Aktualisiert...',
      'home.edit.title': 'Layout bearbeiten',
      'home.script.selectPlaceholder': '-- Skript wählen --',
      'home.script.useScriptsTab': 'Skripte-Tab verwenden',
      'home.script.runtime': 'Laufzeit',
      'home.script.currentStatus': 'Aktueller Status',
      'home.script.start': 'Start',
      'home.script.pause': 'Pause',
      'home.script.openScriptsTab': 'Skripte',
      'home.script.note.setup': 'Nutze den Skripte-Tab, um .mjs-Pakete aus Documents/Realmengine/Scripts auszuführen.',
      'home.script.note.lastRun': 'Letzter Lauf: {name} ({duration})',
      'home.script.state.running': 'Läuft',
      'home.script.state.paused': 'Pausiert',
      'home.script.state.idle': 'Leerlauf',
      'home.conn.listening': 'Lauscht auf Port 2050',
      'home.conn.clientDetected': 'RotMG Exalt erkannt',
      'home.conn.clientWaiting': 'Warte auf RotMG Exalt...',
      'home.stat.uptime': 'Betriebszeit',
      'home.stat.totalFameGained': 'Gesamter Ruhm gewonnen',
      'home.stat.averageFpm': 'Ø Ruhm/Min',
      'home.stat.whiteBags': 'White Bags',
      'home.stat.eventsKilled': 'Events besiegt',
      'home.stat.dungeonsRan': 'Dungeons gelaufen',
      'home.session.lastSession': 'Letzte Session: {name} - {duration}',
      'home.session.lastEmpty': 'Letzte Session: --',
      'home.session.ended': 'Beendet: {time}',
      'home.session.endedEmpty': 'Beendet: --',
      'home.feed.empty': 'Noch keine Session-Ereignisse.',
      'home.feed.cleared': 'Session-Feed geleert.',
      'home.accounts.sortAria': 'Start-Konten sortieren',
      'home.accounts.noConfigured': 'Noch keine Konten konfiguriert.',
      'home.accounts.loadingChars': 'Charakterdaten werden geladen...',
      'home.accounts.fetchingTop': 'Charakter mit höchstem Ruhm wird geladen...',
      'home.accounts.charNotLoaded': 'Charakterdaten noch nicht geladen.',
      'home.accountRow.summary': '{className} | Ruhm {fame} | {server}',
      'home.account.unnamed': 'Unbenanntes Konto',
      'home.action.launchSent': 'Startanfrage gesendet.',
      'home.action.launchRequested': 'Start angefordert für Konto: {name}',
      'home.action.launchOffline': 'Dashboard-Verbindung ist offline.',
      'home.action.needCredentials': 'Zuerst ein Konto mit Zugangsdaten wählen.',
      'home.action.missingCreds': 'Ausgewähltem Konto fehlen Zugangsdaten.',
      'home.action.reconnecting': 'Dashboard-Socket wird neu verbunden...',
      'home.action.gotoScripts': 'Öffne den Skripte-Tab, um .mjs-Pakete auszuführen.',
      'home.action.scriptsRunThere': 'Skripte laufen über den Skripte-Tab.',
      'home.action.useScriptsJs': 'Nutze den Skripte-Tab für .js-Skripte.',
      'home.action.nexusOk': 'Nexus-Escape gesendet.',
      'home.action.nexusFail': 'Nexus-Aktion fehlgeschlagen.',
      'home.action.nexusReqFail': 'Nexus-Anfrage fehlgeschlagen.',
      'home.action.noPosition': 'Keine Spielerposition verfügbar.',
      'home.action.copiedPos': 'Position kopiert: {text}',
      'home.action.copyFailed': 'Kopieren fehlgeschlagen.',
      'home.action.noClipboard': 'Zwischenablage in dieser Umgebung nicht verfügbar.',
      'home.action.adminLogs': 'Admin-Modus aktivieren, um Protokolle zu öffnen.',
      'accounts.search.placeholder': 'Alias, E-Mail, Server suchen...',
      'accounts.sort.aria': 'Konten sortieren',
      'accounts.ctx.more': 'Weitere Aktionen',
      'accounts.toolbar.countOne': '{n} KONTO',
      'accounts.toolbar.countOther': '{n} KONTEN',
      'accounts.empty.search': 'Keine Konten passen zur Suche.',
      'accounts.card.noEmail': 'Keine E-Mail',
      'accounts.card.noNotes': 'Keine Notizen',
      'accounts.orderDirty': 'Kontenreihenfolge geändert. Speichern zum Behalten.',
      'accounts.overview.refreshAccount': 'Konto aktualisieren',
      'accounts.refreshAllBtn': 'Alle aktualisieren',
      'accounts.overview.summary.pickChars': 'Wähle ein Konto, um Charaktere zu prüfen.',
      'accounts.overview.summary.pickInv': 'Wähle ein Konto, um das Inventar zu prüfen.',
      'accounts.overview.noneSelected': 'Kein Konto ausgewählt.',
      'accounts.overview.pickEquip': 'Wähle ein Konto für Ausrüstung und Werte.',
      'accounts.overview.pickInvChars': 'Wähle ein Konto für Inventar und Charaktere.',
      'accounts.overview.enterCredsChars': 'E-Mail und Passwort eingeben, dann aktualisieren, um Charaktere zu laden.',
      'accounts.overview.enterCredsInv': 'E-Mail und Passwort eingeben, dann aktualisieren, um das Inventar zu laden.',
      'accounts.overview.missingLogin': 'Diesem Konto fehlen Zugangsdaten.',
      'accounts.overview.needCredsChars': 'Charakterdaten erfordern gültige Zugangsdaten.',
      'accounts.overview.needCredsInv': 'Inventar erfordert gültige Zugangsdaten.',
      'accounts.overview.loadingList': 'Charakterliste wird geladen...',
      'accounts.overview.notLoadedList': 'Charakterliste noch nicht geladen.',
      'accounts.overview.loadingCharsShort': 'Charaktere werden geladen...',
      'accounts.overview.clickRefreshChars': '„Charaktere aktualisieren“, um dieses Konto zu laden.',
      'accounts.overview.loadingAccount': 'Kontodaten werden geladen...',
      'accounts.overview.notLoadedAccount': 'Kontodaten noch nicht geladen.',
      'accounts.overview.clickRefreshAccount': '„Konto aktualisieren“, um dieses Konto zu laden.',
      'accounts.overview.fetchChars': 'Charakterdaten werden von RotMG geladen...',
      'accounts.overview.fetchAccount': 'Kontodaten werden von RotMG geladen...',
      'accounts.overview.hintLoadChars': 'Charakterliste laden, um Ausrüstung und Werte zu sehen.',
      'accounts.overview.hintLoadAccount': 'Kontodaten laden, um Charaktere und Items zu sehen.',
      'accounts.summary.chars': '{n} Chars',
      'accounts.summary.vault': 'Tresor {n}',
      'accounts.summary.gifts': 'Geschenke {n}',
      'accounts.summary.potions': 'Tränke {n}',
      'accounts.summary.aliveFame': 'Lebendiger Ruhm gesamt {n}',
      'accounts.summary.bestChar': 'Bester Char {n}',
      'accounts.summary.updated': 'Aktualisiert {time}',
      'accounts.summary.defaultName': 'Konto',
      'accounts.notice.cachedFrom': 'Zwischengespeicherte Charakterliste geladen von {time}.',
      'accounts.notice.cached': 'Zwischengespeicherte Charakterliste geladen.',
      'accounts.notice.listAt': 'Charakterliste aktualisiert um {time}.',
      'accounts.notice.listOk': 'Charakterliste aktualisiert.',
      'accounts.notice.loadingList': 'Charakterliste wird geladen...',
      'accounts.error.loadList': 'Charakterliste konnte nicht geladen werden.',
      'accounts.character.none': 'Dieses Konto hat keine Charaktere.',
      'accounts.character.noneReturned': 'Dieses Konto lieferte keine Charaktere.',
      'accounts.character.pick': 'Wähle einen Charakter für Ausrüstung und Werte.',
      'accounts.character.classDefault': 'Charakter',
      'accounts.character.lvl': 'St. {n}',
      'accounts.character.seasonal': 'Saisonal',
      'accounts.character.dead': 'Tot',
      'accounts.character.fameMeta': 'Ruhm {n}',
      'accounts.character.hpMeta': 'LP {n}/{max}',
      'accounts.character.idMeta': 'ID {n}',
      'accounts.equipment.slot': 'Slot {n}',
      'accounts.equipment.empty': 'Leer',
      'accounts.equipment.weapon': 'Waffe',
      'accounts.equipment.ability': 'Fähigkeit',
      'accounts.equipment.armor': 'Rüstung',
      'accounts.equipment.ring': 'Ring',
      'accounts.stat.hp': 'LP',
      'accounts.stat.mp': 'MP',
      'accounts.stat.fame': 'Ruhm',
      'accounts.stat.exp': 'Exp',
      'accounts.stat.attack': 'Angriff',
      'accounts.stat.defense': 'Verteidigung',
      'accounts.stat.speed': 'Geschwindigkeit',
      'accounts.stat.dexterity': 'Geschick',
      'accounts.stat.vitality': 'Vitalität',
      'accounts.stat.wisdom': 'Weisheit',
      'accounts.detail.typeLine': 'Typ {hex}',
      'accounts.detail.levelPill': 'Stufe {n}',
      'accounts.detail.famePill': 'Ruhm {n}',
      'accounts.detail.charIdPill': 'Char-ID {n}',
      'accounts.section.equipped': 'Ausgerüstet',
      'accounts.section.stats': 'Werte',
      'accounts.section.inventory': 'Inventar',
      'accounts.browser.noTotals': 'Noch kein zwischengespeichertes Inventar.',
      'accounts.browser.noSectionItems': 'Keine {section}-Gegenstände auf diesem Konto.',
      'accounts.browser.hintTotals': 'Klick auf einen Gegenstand für Konto und Anzahl.',
      'accounts.browser.hintItems': 'Klick für Name und Verzauberungen.',
      'accounts.browser.uniqueAcrossOne': '{items} einzigartige Gegenstände auf {n} geladenem Konto',
      'accounts.browser.uniqueAcrossOther': '{items} einzigartige Gegenstände auf {n} geladenen Konten',
      'accounts.refreshAll.loading': 'Alle Kontodaten werden aktualisiert...',
      'accounts.refreshAll.doneOne': '{n} Konto aktualisiert.',
      'accounts.refreshAll.doneOther': '{n} Konten aktualisiert.',
      'accounts.error.refreshAll': 'Alle Konten konnten nicht aktualisiert werden.',
      'accounts.storage.summary': '{total} Gegenstände | {unique} einzigartig',
      'home.equipment.none': 'Keine Ausrüstungsdaten',
      'home.equipment.noneEquipped': 'Keine Ausrüstung angelegt',
    },
    pt: {
      'tab.home': 'Início', 'tab.plugins': 'Complementos', 'tab.api': 'API',
      'tab.market': 'Mercado', 'tab.accounts': 'Contas', 'tab.logs': 'Registros',
      'tab.damage': 'Analisador de Dano', 'tab.objects': 'Objetos', 'tab.tilemap': 'Mapa de Tiles',
      'tab.gameWiki': 'Wiki do Jogo', 'tab.nearby': 'Jogadores Próximos', 'tab.scripts': 'Roteiros',
      'tab.multibox': 'Multibox',
      'tab.memHelper': 'Ajuda Memória',
      'multibox.toolbar.title': 'Layout Multibox',
      'multibox.toolbar.hint': 'Marcador — arraste o cartão para mover, canto para redimensionar. Adicione ou remova pelo botão ou ×.',
      'multibox.placeholder': 'Marcador',
      'multibox.addClient': 'Adicionar cliente',
      'multibox.empty': 'Sem clientes. Clique em «Adicionar cliente» para criar uma janela de teste.',
      'multibox.clientTitle': 'Cliente {n}',
      'multibox.removeClient': 'Remover',
      'multibox.presets.label': 'Modelos de layout',
      'multibox.presetTitle4': 'Estilo empilhar: 2 à esquerda + grande em cima + barra inferior',
      'multibox.presetTitle6': 'Como ferramentas de multibox: grande canto superior direito, dois à esquerda, base ×3',
      'multibox.presetTitle8': '8 clientes: grande top-direito, esquerda ×2, inferior ×5',
      'tab.developer': 'Desenvolvedor',
      'memHelper.hero.kicker': 'Realm Engine · admin',
      'memHelper.hero.title': 'Ajuda Memória',
      'memHelper.hero.tagline': 'Higiene de memória ao vivo para ROTMG: reduz filas de pacotes, caches do Packet Lab e buffers do painel.',
      'memHelper.btn.smartTrim': 'Corte inteligente',
      'memHelper.btn.serverTrim': 'Limpar buffers do proxy',
      'memHelper.btn.refresh': 'Atualizar estatísticas',
      'memHelper.metrics.title': 'Processo proxy (Node)',
      'memHelper.metrics.note': 'Mede Realm Engine / proxy — não Flash nem Unity Exalt.',
      'memHelper.metrics.rss': 'RSS',
      'memHelper.metrics.heapUsed': 'Heap em uso',
      'memHelper.metrics.heapTotal': 'Heap total',
      'memHelper.metrics.external': 'Externo',
      'memHelper.feat.packetSniffer.title': 'Fila do sniffer',
      'memHelper.feat.packetSniffer.desc': 'Fluxo alto aumenta linhas JSON. O corte mantém tráfego recente.',
      'memHelper.feat.packetLab.title': 'Packet Lab',
      'memHelper.feat.packetLab.desc': 'Amostras hex somadas — o trim no servidor limpa.',
      'memHelper.feat.dashboard.title': 'Buffers da UI',
      'memHelper.feat.dashboard.desc': 'Encolhe histórico, logs de plugins e feed inicial.',
      'memHelper.feat.performance.title': 'Dica',
      'memHelper.feat.performance.desc': 'CPU no Windows: veja Bitsum Process Lasso; Realm Engine só corta proxy/UI.',
      'memHelper.danger.title': 'Avançado',
      'memHelper.danger.intro': 'Apaga entidades/tiles rastreados — scripts podem falhar até novos UPDATEs.',
      'memHelper.danger.btnWorld': 'Reset duro do snapshot do mundo',
      'memHelper.status.trimOk': 'Corte concluído.',
      'memHelper.status.worldOk': 'Snapshot do mundo apagado.',
      'memHelper.err.fetch': 'Não foi possível ler as estatísticas de memória.',
      'sidebar.balance': 'Saldo', 'sidebar.plan': 'Plano', 'sidebar.account': 'Conta',
      'sidebar.server': 'Servidor', 'sidebar.ipConnect': 'Conectar por IP',
      'btn.connect': 'Conectar', 'btn.launch': 'Iniciar', 'btn.save': 'Salvar',
      'btn.cancel': 'Cancelar', 'btn.refresh': 'Atualizar',
      'detail.level': 'Nível', 'detail.stars': 'Estrelas', 'detail.fame': 'Fama',
      'detail.guild': 'Guilda', 'detail.map': 'Mapa', 'detail.gameid': 'ID da Partida',
      'detail.objectid': 'ID do Objeto', 'detail.objecttype': 'Tipo de Objeto',
      'detail.position': 'Posição',
      'detail.questTargetId': 'ID do alvo da missão',
      'detail.questTargetType': 'Tipo do alvo',
      'detail.server': 'Servidor',
      'detail.backpackTier': 'Nível da mochila',
      'status.connected': 'Conectado', 'status.disconnected': 'Desconectado',
      'player.notConnected': 'Não Conectado', 'player.waitingForGame': 'Aguardando o jogo...',
      'damage.empty': 'Ainda não há dano registrado. Acerte algo!',
      'damage.setting.minBossHp': 'HP mín boss',
      'damage.setting.minMiniBossHp': 'HP mín mini',
      'damage.setting.inGameAlerts': 'Alertas jogo',
      'tilemap.autoRefresh': 'Atualização automática',
      'tilemap.empty': 'Não há dados de tiles. Clique em Atualizar depois de se conectar a um servidor e entrar em um mapa.',
      'objects.autoRefresh': 'Atualização automática',
      'objects.empty': 'Não há dados de objetos. Clique em Atualizar depois de se conectar a um servidor e entrar em um mapa.',
      'accountPopup.title': 'Conta', 'accountPopup.memberSince': 'Membro desde',
      'accountPopup.gemBalance': 'Saldo de gemas', 'accountPopup.currentPlan': 'Plano atual',
      'accountPopup.gemStatus.active': 'Ativo', 'accountPopup.gemStatus.inactive': 'Inativo',
      'accountPopup.plan.free': 'Grátis',
      'accountPopup.buyGems.title': 'Comprar gemas', 'accountPopup.buyGems.desc': 'Adicione gemas ao seu saldo',
      'accountPopup.managePlan.title': 'Gerenciar plano', 'accountPopup.managePlan.desc': 'Ver ou alterar sua assinatura',
      'accountPopup.signOut': 'Sair', 'accountPopup.notSignedIn': 'Sessão não iniciada',
      'accountPopup.nextDeduction': '· próxima dedução {date}', 'accountPopup.renews': '· renova em {date}',
      'settings.title': 'Configurações', 'settings.tab.visual': 'Visual',
      'settings.tab.game': 'Jogo', 'settings.tab.developer': 'Desenvolvedor',
      'settings.tab.admin': 'Admin', 'settings.appearance': 'Aparência',
      'settings.theme': 'Tema', 'settings.themeDesc': 'Escolha o tema de cores do painel.',
      'settings.language': 'Idioma', 'settings.languageDesc': 'Escolha o idioma de exibição do painel.',
      'settings.showStatBonuses': 'Mostrar bônus de atributos',
      'settings.showServerPing': 'Mostrar ping do servidor',
      'settings.showServerPingDesc': 'Mostrar latência (ms) ao lado de cada servidor no seletor.',
      'settings.showAccountEmails': 'Mostrar e-mails das contas',
      'settings.showAccountEmailsDesc': 'Mostrar ou ocultar o e-mail abaixo de cada conta na lista.',
      'settings.navbarTabs': 'Abas de Navegação',
      'settings.packetSniffer': 'Sniffer de pacotes',
      'settings.packetSnifferDesc': 'Mostrar ou ocultar o painel inferior do sniffer enquanto o modo administrador está ativo.',
      'tutorial.settings.title': 'Tutorial',
      'tutorial.settings.replayLabel': 'Rever tutorial',
      'tutorial.settings.replayDesc': 'Percorra novamente a introdução do app.',
      'tutorial.settings.replayBtn': 'Rever',
      'tutorial.step0.title': 'Bem-vindo ao Realm Engine',
      'tutorial.step0.body': 'Seu companheiro tudo-em-um para Realm of the Mad God. Vamos fazer um tour rápido para você saber onde fica tudo.',
      'tutorial.step0.dim': 'Isso leva só um minuto.',
      'tutorial.step1.title': 'Início',
      'tutorial.step1.body': 'A aba Início é seu centro de comando. A partir daqui você pode:',
      'tutorial.step1.li1': '<strong>Script ativo</strong> &mdash; Link rápido para a aba Roteiros para scripts .js baseados em disco.',
      'tutorial.step1.li2': '<strong>Estatísticas da sessão</strong> &mdash; Acompanhe tempo ativo, fama ganha, white bags, eventos derrotados e dungeons concluídas em tempo real.',
      'tutorial.step1.li3': '<strong>Contas prontas</strong> &mdash; Inicie rapidamente qualquer uma das suas contas salvas direto do painel.',
      'tutorial.step1.li4': '<strong>Editar layout</strong> &mdash; Clique no ícone de lápis no canto superior para reorganizar, ocultar ou restaurar cartões. Arraste para reordenar e salvar seu layout.',
      'tutorial.step2.title': 'Complementos',
      'tutorial.step2.body': 'Plugins ampliam o que o Realm Engine pode fazer. O hub de plugins permite:',
      'tutorial.step2.li1': '<strong>Navegar e pesquisar</strong> &mdash; Encontre plugins por nome ou filtre por categoria.',
      'tutorial.step2.li2': '<strong>Ativar / desativar</strong> &mdash; Ligue ou desligue plugins com um único clique.',
      'tutorial.step2.li3': '<strong>Configurar</strong> &mdash; Cada plugin tem seu próprio painel de configurações para ajustar ao seu estilo de jogo.',
      'tutorial.step2.dim': 'Os plugins incluem utilidades como auto-aim, auto-dodge, auto-nexus e mais.',
      'tutorial.step3.title': 'Contas',
      'tutorial.step3.body1': 'É aqui que você gerencia suas contas do Realm. Você pode guardar várias contas, ver resumos de personagens, conteúdos do vault e entrar no jogo.',
      'tutorial.step3.body2': 'Vamos adicionar sua primeira conta agora para começar.',
      'tutorial.step3.passwordPlaceholder': 'Senha',
      'tutorial.step3.dim': 'Você sempre pode adicionar mais contas depois ou pular esta etapa por enquanto.',
      'tutorial.step4.title': 'Damage Sniffer',
      'tutorial.step4.body': 'O Damage Sniffer registra dados de combate enquanto você joga. Ele acompanha:',
      'tutorial.step4.li1': '<strong>Runs</strong> &mdash; Cada encontro é registrado com visualização ao vivo e histórico salvo.',
      'tutorial.step4.li2': '<strong>Alvos</strong> &mdash; Veja todos os inimigos atingidos e filtre por boss ou miniboss.',
      'tutorial.step4.li3': '<strong>Detalhamento por jogador</strong> &mdash; Veja DPS e contribuição de dano por jogador.',
      'tutorial.step4.dim': 'Os dados são capturados automaticamente &mdash; é só jogar e revisar suas estatísticas quando quiser.',
      'tutorial.step5.title': 'Tudo pronto!',
      'tutorial.step5.body': 'Isso cobre o essencial. Você pode explorar cada aba no seu próprio ritmo. Se quiser rever este tour, pode redefini-lo em Configurações.',
      'tutorial.step5.dim': 'Bom jogo!',
      'tutorial.nav.skip': 'Pular',
      'tutorial.nav.back': 'Voltar',
      'tutorial.nav.next': 'Próximo',
      'tutorial.nav.finish': 'Concluir',
      'tutorial.nav.getStarted': 'Começar',
      'tutorial.nav.continue': 'Continuar',
      'tutorial.nav.addContinue': 'Adicionar e continuar',
      'tutorial.status.saving': 'Salvando conta...',
      'tutorial.status.success': 'Conta adicionada com sucesso!',
      'tutorial.status.error': 'Falha ao salvar - você pode adicioná-la manualmente depois.',
      'plugins.hub.aria': 'Plugins',
      'plugins.search.placeholder': 'Pesquisar plugins...',
      'plugins.search.aria': 'Pesquisar plugins',
      'plugins.category.filter.aria': 'Filtrar por categoria',
      'plugins.list.aria': 'Lista de plugins',
      'plugins.loading': 'Carregando plugins...',
      'plugins.category.all': 'Todas as categorias',
      'plugins.category.combat': 'Combate',
      'plugins.category.movement': 'Movimento',
      'plugins.category.automation': 'Automação',
      'plugins.category.visual': 'Visual',
      'plugins.category.network': 'Rede',
      'plugins.category.utility': 'Utilitários',
      'plugins.category.admin': 'Admin',
      'plugins.teleport.beacon': 'Baliza',
      'plugins.teleport.beaconSelect': 'Baliza de teleporte',
      'plugins.teleport.select': '-- Selecione uma baliza --',
      'plugins.teleport.none': '(nenhuma baliza visível)',
      'plugins.teleport.typePrefix': 'Tipo',
      'plugins.teleport.objectId': 'oid',
      'plugins.empty.enable': 'Ative plugins na barra lateral',
      'plugins.empty.none': 'Nenhum plugin carregado',
      'plugins.empty.noMatchSidebar': 'Nenhum plugin corresponde.',
      'plugins.empty.noMatchDetail': 'Nenhum plugin corresponde à sua busca ou categoria.',
      'home.activeScript': 'Script Ativo', 'home.sessionStats': 'Estatísticas da Sessão',
      'home.accountsReady': 'Contas Prontas para Iniciar',
      'accounts.setup.title': 'Adicionar Primeira Conta',
      'accounts.setup.subtitle': 'Insira suas credenciais do jogo para começar.',
      'accounts.label.alias': 'Alias', 'accounts.label.email': 'E-mail',
      'accounts.label.password': 'Senha', 'accounts.label.server': 'Servidor',
      'accounts.label.notes': 'Notas', 'accounts.btn.show': 'Mostrar',
      'accounts.placeholder.aliasOptional': 'Nome de exibição (opcional)',
      'accounts.placeholder.alias': 'Nome de exibição',
      'accounts.placeholder.password': 'Senha',
      'accounts.placeholder.notes': 'Notas opcionais',
      'accounts.btn.addFirst': 'Adicionar Conta', 'accounts.btn.addNew': '+ Adicionar Conta',
      'accounts.btn.saveChanges': 'Salvar Alterações',
      'accounts.list.title': 'Contas Armazenadas',
      'accounts.sort.newest': 'Mais Recente', 'accounts.sort.oldest': 'Mais Antigo',
      'accounts.sort.alpha': 'Alfabético', 'accounts.sort.fame': 'Fama',
      'accounts.ctx.refreshAll': 'Atualizar Todas as Contas',
      'accounts.ctx.reorder': 'Reordenar Contas', 'accounts.ctx.delete': 'Excluir Conta',
      'accounts.empty': 'Nenhuma conta salva ainda.',
      'accounts.editor.title': 'Detalhes da Conta',
      'accounts.overview.title': 'Visão Geral de Personagens',
      'accounts.overview.summary': 'Selecione uma conta para inspecionar seus personagens.',
      'accounts.overview.refreshBtn': 'Atualizar Personagens',
      'accounts.overview.tab.chars': 'Personagens', 'accounts.overview.tab.vault': 'Cofre',
      'accounts.overview.tab.gifts': 'Presentes', 'accounts.overview.tab.potions': 'Poções',
      'accounts.overview.tab.totals': 'Inventário Total',
      'accounts.overview.emptyChars': 'Nenhum dado de personagem carregado.',
      'accounts.overview.selectChar': 'Selecione um personagem para inspecionar seu equipamento e atributos.',
      'accounts.modal.delete.title': 'Excluir Conta',
      'accounts.modal.delete.msg': 'Tem certeza de que deseja excluir esta conta?',
      'accounts.modal.delete.confirm': 'Excluir',
      'accounts.modal.locked.title': 'Conta Em Uso',
      'accounts.modal.locked.msg': 'Você deve se desconectar do jogo antes de editar esta conta.',
      'accounts.modal.locked.ok': 'OK',
      'status.connecting': 'Conectando',
      'common.loading': 'Carregando...',
      'common.refreshing': 'Atualizando...',
      'home.edit.title': 'Editar layout',
      'home.script.selectPlaceholder': '-- Selecionar script --',
      'home.script.useScriptsTab': 'Usar aba Roteiros',
      'home.script.runtime': 'Tempo de execução',
      'home.script.currentStatus': 'Status atual',
      'home.script.start': 'Iniciar',
      'home.script.pause': 'Pausar',
      'home.script.openScriptsTab': 'Roteiros',
      'home.script.note.setup': 'Use a aba Roteiros para executar pacotes .mjs em Documents/Realmengine/Scripts.',
      'home.script.note.lastRun': 'Última execução: {name} ({duration})',
      'home.script.state.running': 'Em execução',
      'home.script.state.paused': 'Pausado',
      'home.script.state.idle': 'Ocioso',
      'home.conn.listening': 'Ouvindo na porta 2050',
      'home.conn.clientDetected': 'RotMG Exalt detectado',
      'home.conn.clientWaiting': 'Aguardando RotMG Exalt...',
      'home.stat.uptime': 'Tempo ativo',
      'home.stat.totalFameGained': 'Fama total ganha',
      'home.stat.averageFpm': 'FPM médio',
      'home.stat.whiteBags': 'White bags',
      'home.stat.eventsKilled': 'Eventos derrotados',
      'home.stat.dungeonsRan': 'Masmorras concluídas',
      'home.session.lastSession': 'Última sessão: {name} - {duration}',
      'home.session.lastEmpty': 'Última sessão: --',
      'home.session.ended': 'Encerrada: {time}',
      'home.session.endedEmpty': 'Encerrada: --',
      'home.feed.empty': 'Nenhum evento de sessão ainda.',
      'home.feed.cleared': 'Feed da sessão limpo.',
      'home.accounts.sortAria': 'Ordenar contas para iniciar',
      'home.accounts.noConfigured': 'Nenhuma conta configurada ainda.',
      'home.accounts.loadingChars': 'Carregando dados dos personagens...',
      'home.accounts.fetchingTop': 'Buscando personagem com maior fama...',
      'home.accounts.charNotLoaded': 'Dados dos personagens não carregados.',
      'home.accountRow.summary': '{className} | Fama {fame} | {server}',
      'home.account.unnamed': 'Conta sem nome',
      'home.action.launchSent': 'Pedido de início enviado.',
      'home.action.launchRequested': 'Início solicitado para a conta: {name}',
      'home.action.launchOffline': 'Conexão do painel está offline.',
      'home.action.needCredentials': 'Selecione uma conta com credenciais primeiro.',
      'home.action.missingCreds': 'A conta selecionada está sem credenciais.',
      'home.action.reconnecting': 'Reconectando o socket do painel...',
      'home.action.gotoScripts': 'Abra a aba Roteiros para executar pacotes .mjs.',
      'home.action.scriptsRunThere': 'Scripts são executados na aba Roteiros.',
      'home.action.useScriptsJs': 'Use a aba Roteiros para executar scripts .js.',
      'home.action.nexusOk': 'Fuga para o Nexus enviada.',
      'home.action.nexusFail': 'Ação do Nexus falhou.',
      'home.action.nexusReqFail': 'Pedido ao Nexus falhou.',
      'home.action.noPosition': 'Nenhuma posição do jogador disponível.',
      'home.action.copiedPos': 'Posição copiada: {text}',
      'home.action.copyFailed': 'Falha ao copiar.',
      'home.action.noClipboard': 'Área de transferência indisponível neste ambiente.',
      'home.action.adminLogs': 'Ative o modo administrador para abrir Registros.',
      'accounts.search.placeholder': 'Buscar alias, e-mail, servidor...',
      'accounts.sort.aria': 'Ordenar contas',
      'accounts.ctx.more': 'Mais ações',
      'accounts.toolbar.countOne': '{n} CONTA',
      'accounts.toolbar.countOther': '{n} CONTAS',
      'accounts.empty.search': 'Nenhuma conta corresponde à busca.',
      'accounts.card.noEmail': 'Sem e-mail',
      'accounts.card.noNotes': 'Sem notas',
      'accounts.orderDirty': 'Ordem das contas alterada. Salve para persistir.',
      'accounts.overview.refreshAccount': 'Atualizar conta',
      'accounts.refreshAllBtn': 'Atualizar tudo',
      'accounts.overview.summary.pickChars': 'Selecione uma conta para ver os personagens.',
      'accounts.overview.summary.pickInv': 'Selecione uma conta para ver o inventário.',
      'accounts.overview.noneSelected': 'Nenhuma conta selecionada.',
      'accounts.overview.pickEquip': 'Selecione uma conta para ver equipamento e atributos.',
      'accounts.overview.pickInvChars': 'Selecione uma conta para ver inventário e personagens.',
      'accounts.overview.enterCredsChars': 'Informe e-mail e senha, depois atualize para carregar os personagens.',
      'accounts.overview.enterCredsInv': 'Informe e-mail e senha, depois atualize para carregar o inventário.',
      'accounts.overview.missingLogin': 'Esta conta não tem credenciais.',
      'accounts.overview.needCredsChars': 'Dados de personagens exigem credenciais válidas.',
      'accounts.overview.needCredsInv': 'Inventário exige credenciais válidas.',
      'accounts.overview.loadingList': 'Carregando lista de personagens...',
      'accounts.overview.notLoadedList': 'Lista de personagens ainda não carregada.',
      'accounts.overview.loadingCharsShort': 'Carregando personagens...',
      'accounts.overview.clickRefreshChars': 'Clique em Atualizar personagens para carregar esta conta.',
      'accounts.overview.loadingAccount': 'Carregando dados da conta...',
      'accounts.overview.notLoadedAccount': 'Dados da conta ainda não carregados.',
      'accounts.overview.clickRefreshAccount': 'Clique em Atualizar conta para carregar esta conta.',
      'accounts.overview.fetchChars': 'Obtendo dados de personagens do RotMG...',
      'accounts.overview.fetchAccount': 'Obtendo dados da conta do RotMG...',
      'accounts.overview.hintLoadChars': 'Carregue a lista de personagens para ver equipamento e atributos.',
      'accounts.overview.hintLoadAccount': 'Carregue os dados da conta para ver personagens e itens.',
      'accounts.summary.chars': '{n} pers.',
      'accounts.summary.vault': 'Cofre {n}',
      'accounts.summary.gifts': 'Presentes {n}',
      'accounts.summary.potions': 'Poções {n}',
      'accounts.summary.aliveFame': 'Fama viva total {n}',
      'accounts.summary.bestChar': 'Melhor pers. {n}',
      'accounts.summary.updated': 'Atualizado {time}',
      'accounts.summary.defaultName': 'Conta',
      'accounts.notice.cachedFrom': 'Lista em cache carregada de {time}.',
      'accounts.notice.cached': 'Lista em cache carregada.',
      'accounts.notice.listAt': 'Lista de personagens atualizada às {time}.',
      'accounts.notice.listOk': 'Lista de personagens atualizada.',
      'accounts.notice.loadingList': 'Carregando lista de personagens...',
      'accounts.error.loadList': 'Falha ao carregar lista de personagens.',
      'accounts.character.none': 'Esta conta não tem personagens.',
      'accounts.character.noneReturned': 'Esta conta não retornou personagens.',
      'accounts.character.pick': 'Selecione um personagem para ver equipamento e atributos.',
      'accounts.character.classDefault': 'Personagem',
      'accounts.character.lvl': 'Nv. {n}',
      'accounts.character.seasonal': 'Sazonal',
      'accounts.character.dead': 'Morto',
      'accounts.character.fameMeta': 'Fama {n}',
      'accounts.character.hpMeta': 'PV {n}/{max}',
      'accounts.character.idMeta': 'ID {n}',
      'accounts.equipment.slot': 'Slot {n}',
      'accounts.equipment.empty': 'Vazio',
      'accounts.equipment.weapon': 'Arma',
      'accounts.equipment.ability': 'Habilidade',
      'accounts.equipment.armor': 'Armadura',
      'accounts.equipment.ring': 'Anel',
      'accounts.stat.hp': 'PV',
      'accounts.stat.mp': 'PM',
      'accounts.stat.fame': 'Fama',
      'accounts.stat.exp': 'Exp',
      'accounts.stat.attack': 'Ataque',
      'accounts.stat.defense': 'Defesa',
      'accounts.stat.speed': 'Velocidade',
      'accounts.stat.dexterity': 'Destreza',
      'accounts.stat.vitality': 'Vitalidade',
      'accounts.stat.wisdom': 'Sabedoria',
      'accounts.detail.typeLine': 'Tipo {hex}',
      'accounts.detail.levelPill': 'Nível {n}',
      'accounts.detail.famePill': 'Fama {n}',
      'accounts.detail.charIdPill': 'ID pers. {n}',
      'accounts.section.equipped': 'Equipado',
      'accounts.section.stats': 'Atributos',
      'accounts.section.inventory': 'Inventário',
      'accounts.browser.noTotals': 'Nenhum inventário em cache ainda.',
      'accounts.browser.noSectionItems': 'Nenhum item de {section} nesta conta.',
      'accounts.browser.hintTotals': 'Clique em um item para ver em qual conta está e quantos.',
      'accounts.browser.hintItems': 'Clique em um item para ver nome e encantamentos.',
      'accounts.browser.uniqueAcrossOne': '{items} itens únicos em {n} conta carregada',
      'accounts.browser.uniqueAcrossOther': '{items} itens únicos em {n} contas carregadas',
      'accounts.refreshAll.loading': 'Atualizando todas as contas...',
      'accounts.refreshAll.doneOne': '{n} conta atualizada.',
      'accounts.refreshAll.doneOther': '{n} contas atualizadas.',
      'accounts.error.refreshAll': 'Falha ao atualizar todas as contas.',
      'accounts.storage.summary': '{total} itens | {unique} únicos',
      'home.equipment.none': 'Sem dados de equipamento',
      'home.equipment.noneEquipped': 'Nenhum equipamento',
    },
    ja: {
      'tab.home': 'ホーム', 'tab.plugins': 'プラグイン', 'tab.api': 'API',
      'tab.market': 'マーケット', 'tab.accounts': 'アカウント', 'tab.logs': 'ログ',
      'tab.damage': 'ダメージ解析', 'tab.objects': 'オブジェクト', 'tab.tilemap': 'タイルマップ',
      'tab.gameWiki': '攻略Wiki', 'tab.nearby': '近くのプレイヤー', 'tab.scripts': 'スクリプト',
      'tab.multibox': 'マルチボックス',
      'tab.memHelper': 'メモリヘルパー',
      'multibox.toolbar.title': 'マルチボックスレイアウト',
      'multibox.toolbar.hint': 'プレースホルダー — カードのどこかをドラッグで移動、角でリサイズ。追加はボタン、削除は ×。実装は後日。',
      'multibox.placeholder': 'プレースホルダー',
      'multibox.addClient': 'クライアントを追加',
      'multibox.empty': 'クライアントがありません。「クライアントを追加」でプレースホルダーを作成します。',
      'multibox.clientTitle': 'クライアント {n}',
      'multibox.removeClient': '削除',
      'multibox.presets.label': 'レイアウトプリセット',
      'multibox.presetTitle4': '左2つ＋上メイン＋下全面バー',
      'multibox.presetTitle6': 'Kronk風：右上メイン約半分／左縦2／下に3並び（一般的なマルチボックス並びに近い）',
      'multibox.presetTitle8': '8窓：右上メイン広め、左縦2、下に5列',
      'tab.developer': '開発者',
      'memHelper.hero.kicker': 'Realm Engine · 管理者向け',
      'memHelper.hero.title': 'メモリヘルパー',
      'memHelper.hero.tagline': 'ROTMG向けのリアルタイムメモリ管理。パケットキュー、パケットラボ、UIバッファを整理し、NEWTICK/MOVEの多い場面でもダッシュボードを軽く。',
      'memHelper.btn.smartTrim': 'スマートトリム',
      'memHelper.btn.serverTrim': 'プロキシバッファをクリア',
      'memHelper.btn.refresh': '統計を更新',
      'memHelper.metrics.title': 'プロキシプロセス（Node）',
      'memHelper.metrics.note': 'Realm Engine / プロキシの値 — Flash や Unity Exalt ではありません。',
      'memHelper.metrics.rss': 'RSS',
      'memHelper.metrics.heapUsed': '使用中ヒープ',
      'memHelper.metrics.heapTotal': 'ヒープ合計',
      'memHelper.metrics.external': '外部',
      'memHelper.feat.packetSniffer.title': 'パケットスニファ',
      'memHelper.feat.packetSniffer.desc': '高負荷時にデコード行とJSONが膨らみます。スマートトリムで直近のみ残します。',
      'memHelper.feat.packetLab.title': 'パケットラボ',
      'memHelper.feat.packetLab.desc': '未知パケットのサンプルhexをサーバー側トリムで削除。',
      'memHelper.feat.dashboard.title': 'ダッシュボードバッファ',
      'memHelper.feat.dashboard.desc': 'パケット履歴・プラグインログ・ホームフィードをまとめて縮小。',
      'memHelper.feat.performance.title': 'ヒント',
      'memHelper.feat.performance.desc': 'CPUの割り当ては Bitsum Process Lasso などを参照。Realm EngineはプロキシとUIのみトリム。',
      'memHelper.danger.title': '上級',
      'memHelper.danger.intro': '追跡エンティティ/タイルを消去 — UPDATEが来るまでスクリプトが乱れる場合あり。',
      'memHelper.danger.btnWorld': 'ワールドスナップショットを強制リセット',
      'memHelper.status.trimOk': 'トリム完了。',
      'memHelper.status.worldOk': 'ワールドスナップショット削除。',
      'memHelper.err.fetch': 'メモリ統計を取得できませんでした。',
      'sidebar.balance': '残高', 'sidebar.plan': 'プラン', 'sidebar.account': 'アカウント',
      'sidebar.server': 'サーバー', 'sidebar.ipConnect': 'IP接続',
      'btn.connect': '接続', 'btn.launch': '起動', 'btn.save': '保存',
      'btn.cancel': 'キャンセル', 'btn.refresh': '更新',
      'detail.level': 'レベル', 'detail.stars': 'スター', 'detail.fame': 'フェイム',
      'detail.guild': 'ギルド', 'detail.map': 'マップ', 'detail.gameid': 'ゲームID',
      'detail.objectid': 'オブジェクトID', 'detail.objecttype': 'オブジェクトタイプ',
      'detail.position': '座標',
      'detail.questTargetId': 'クエスト目標ID',
      'detail.questTargetType': 'クエスト目標タイプ',
      'detail.server': 'サーバー',
      'detail.backpackTier': 'バックパック段階',
      'status.connected': '接続中', 'status.disconnected': '未接続',
      'player.notConnected': '未接続', 'player.waitingForGame': 'ゲームを待機中...',
      'damage.empty': 'まだダメージ記録がありません。何かを攻撃してください！',
      'damage.setting.minBossHp': 'ボス最小HP',
      'damage.setting.minMiniBossHp': 'ミニ最小HP',
      'damage.setting.inGameAlerts': 'ゲーム内通知',
      'tilemap.autoRefresh': '自動更新',
      'tilemap.empty': 'タイルデータがありません。サーバーに接続してマップに入った後で更新を押してください。',
      'objects.autoRefresh': '自動更新',
      'objects.empty': 'オブジェクトデータがありません。サーバーに接続してマップに入った後で更新を押してください。',
      'accountPopup.title': 'アカウント', 'accountPopup.memberSince': '登録日',
      'accountPopup.gemBalance': 'ジェム残高', 'accountPopup.currentPlan': '現在のプラン',
      'accountPopup.gemStatus.active': '有効', 'accountPopup.gemStatus.inactive': '無効',
      'accountPopup.plan.free': '無料',
      'accountPopup.buyGems.title': 'ジェムを購入', 'accountPopup.buyGems.desc': '残高にジェムを追加',
      'accountPopup.managePlan.title': 'プランを管理', 'accountPopup.managePlan.desc': 'サブスクリプションを確認または変更',
      'accountPopup.signOut': 'サインアウト', 'accountPopup.notSignedIn': '未サインイン',
      'accountPopup.nextDeduction': '・次回差し引き {date}', 'accountPopup.renews': '・{date} に更新',
      'settings.title': '設定', 'settings.tab.visual': '表示',
      'settings.tab.game': 'ゲーム', 'settings.tab.developer': '開発者',
      'settings.tab.admin': '管理者', 'settings.appearance': '外観',
      'settings.theme': 'テーマ', 'settings.themeDesc': 'ダッシュボードの配色テーマを選択。',
      'settings.language': '言語', 'settings.languageDesc': 'ダッシュボードの表示言語を選択。',
      'settings.showStatBonuses': 'ステータスボーナスを表示',
      'settings.showServerPing': 'サーバーpingを表示',
      'settings.showServerPingDesc': 'サーバー選択欄に遅延（ms）を表示する。',
      'settings.showAccountEmails': 'アカウントのメールを表示',
      'settings.showAccountEmailsDesc': 'アカウント一覧でメールアドレスの表示・非表示を切替。',
      'settings.navbarTabs': 'ナビゲーションタブ',
      'settings.packetSniffer': 'パケットスニファ',
      'settings.packetSnifferDesc': '管理者モード中に下部のパケットスニファパネルを表示するかどうか。',
      'tutorial.settings.title': 'チュートリアル',
      'tutorial.settings.replayLabel': 'チュートリアルを再生',
      'tutorial.settings.replayDesc': 'アプリの紹介をもう一度確認します。',
      'tutorial.settings.replayBtn': '再生',
      'tutorial.step0.title': 'Realm Engine へようこそ',
      'tutorial.step0.body': 'Realm of the Mad God のためのオールインワン companion です。どこに何があるか分かるように、短いツアーを始めましょう。',
      'tutorial.step0.dim': '1分ほどで終わります。',
      'tutorial.step1.title': 'ホーム',
      'tutorial.step1.body': 'ホームタブは操作の中心です。ここから次のことができます:',
      'tutorial.step1.li1': '<strong>アクティブスクリプト</strong> &mdash; ディスク上の .js スクリプト用 Scripts タブへのクイックリンク。',
      'tutorial.step1.li2': '<strong>セッション統計</strong> &mdash; 稼働時間、獲得 fame、white bag、撃破イベント、クリアした dungeon をリアルタイムで追跡。',
      'tutorial.step1.li3': '<strong>起動可能なアカウント</strong> &mdash; 保存済みアカウントをダッシュボードからすぐ起動。',
      'tutorial.step1.li4': '<strong>レイアウト編集</strong> &mdash; 右上の鉛筆アイコンからカードの並び替え、非表示、復元ができます。ドラッグして順序を保存できます。',
      'tutorial.step2.title': 'プラグイン',
      'tutorial.step2.body': 'プラグインは Realm Engine の機能を拡張します。プラグインハブでは次のことができます:',
      'tutorial.step2.li1': '<strong>閲覧と検索</strong> &mdash; 名前で探したりカテゴリで絞り込んだりできます。',
      'tutorial.step2.li2': '<strong>有効化 / 無効化</strong> &mdash; 1クリックで切り替えられます。',
      'tutorial.step2.li3': '<strong>設定</strong> &mdash; 各プラグインには専用の設定パネルがあり、プレイスタイルに合わせて調整できます。',
      'tutorial.step2.dim': 'プラグインには auto-aim、auto-dodge、auto-nexus などの便利機能があります。',
      'tutorial.step3.title': 'アカウント',
      'tutorial.step3.body1': 'ここでは Realm アカウントを管理します。複数アカウントの保存、キャラクター概要や vault 内容の確認、ゲーム起動ができます。',
      'tutorial.step3.body2': 'まず最初のアカウントを追加して始めましょう。',
      'tutorial.step3.passwordPlaceholder': 'パスワード',
      'tutorial.step3.dim': 'あとでいつでもアカウントを追加できますし、この手順は今はスキップできます。',
      'tutorial.step4.title': 'Damage Sniffer',
      'tutorial.step4.body': 'Damage Sniffer はプレイ中の戦闘データを記録します。追跡する内容:',
      'tutorial.step4.li1': '<strong>Runs</strong> &mdash; 各戦闘をライブ表示と保存済み履歴つきで記録します。',
      'tutorial.step4.li2': '<strong>ターゲット</strong> &mdash; 攻撃した敵を確認し、boss や miniboss で絞り込めます。',
      'tutorial.step4.li3': '<strong>プレイヤー別内訳</strong> &mdash; プレイヤーごとの DPS とダメージ貢献を表示します。',
      'tutorial.step4.dim': 'データは自動で記録されます &mdash; いつも通りプレイして、あとで統計を確認するだけです。',
      'tutorial.step5.title': '準備完了です!',
      'tutorial.step5.body': '基本は以上です。各タブは自分のペースで確認できます。このツアーをもう一度見たい場合は Settings からリセットできます。',
      'tutorial.step5.dim': '良い realming を!',
      'tutorial.nav.skip': 'スキップ',
      'tutorial.nav.back': '戻る',
      'tutorial.nav.next': '次へ',
      'tutorial.nav.finish': '完了',
      'tutorial.nav.getStarted': '始める',
      'tutorial.nav.continue': '続ける',
      'tutorial.nav.addContinue': '追加して続ける',
      'tutorial.status.saving': 'アカウントを保存中...',
      'tutorial.status.success': 'アカウントを追加しました!',
      'tutorial.status.error': '保存に失敗しました - 後で手動で追加できます。',
      'plugins.hub.aria': 'プラグイン',
      'plugins.search.placeholder': 'プラグインを検索...',
      'plugins.search.aria': 'プラグインを検索',
      'plugins.category.filter.aria': 'カテゴリで絞り込み',
      'plugins.list.aria': 'プラグイン一覧',
      'plugins.loading': 'プラグインを読み込み中...',
      'plugins.category.all': 'すべてのカテゴリ',
      'plugins.category.combat': '戦闘',
      'plugins.category.movement': '移動',
      'plugins.category.automation': '自動化',
      'plugins.category.visual': '表示',
      'plugins.category.network': 'ネットワーク',
      'plugins.category.utility': 'ユーティリティ',
      'plugins.category.admin': '管理',
      'plugins.teleport.beacon': 'ビーコン',
      'plugins.teleport.beaconSelect': 'テレポートビーコン',
      'plugins.teleport.select': '-- ビーコンを選択 --',
      'plugins.teleport.none': '(表示中のビーコンはありません)',
      'plugins.teleport.typePrefix': 'タイプ',
      'plugins.teleport.objectId': 'oid',
      'plugins.empty.enable': 'サイドバーからプラグインを有効化してください',
      'plugins.empty.none': '読み込まれたプラグインはありません',
      'plugins.empty.noMatchSidebar': '一致するプラグインはありません。',
      'plugins.empty.noMatchDetail': '検索またはカテゴリに一致するプラグインはありません。',
      'home.activeScript': 'アクティブスクリプト', 'home.sessionStats': 'セッション統計',
      'home.accountsReady': '起動可能なアカウント',
      'accounts.setup.title': '最初のアカウントを追加',
      'accounts.setup.subtitle': 'ゲームの認証情報を入力してください。',
      'accounts.label.alias': 'エイリアス', 'accounts.label.email': 'メール',
      'accounts.label.password': 'パスワード', 'accounts.label.server': 'サーバー',
      'accounts.label.notes': 'メモ', 'accounts.btn.show': '表示',
      'accounts.placeholder.aliasOptional': '表示名（任意）',
      'accounts.placeholder.alias': '表示名',
      'accounts.placeholder.password': 'パスワード',
      'accounts.placeholder.notes': '任意のメモ',
      'accounts.btn.addFirst': 'アカウントを追加', 'accounts.btn.addNew': '＋ アカウントを追加',
      'accounts.btn.saveChanges': '変更を保存',
      'accounts.list.title': '保存済みアカウント',
      'accounts.sort.newest': '新しい順', 'accounts.sort.oldest': '古い順',
      'accounts.sort.alpha': 'アルファベット順', 'accounts.sort.fame': 'フェイム順',
      'accounts.ctx.refreshAll': '全アカウントを更新',
      'accounts.ctx.reorder': 'アカウントを並び替え', 'accounts.ctx.delete': 'アカウントを削除',
      'accounts.empty': 'アカウントがまだ保存されていません。',
      'accounts.editor.title': 'アカウント詳細',
      'accounts.overview.title': 'キャラクター概要',
      'accounts.overview.summary': 'アカウントを選択してキャラクターを確認してください。',
      'accounts.overview.refreshBtn': 'キャラクターを更新',
      'accounts.overview.tab.chars': 'キャラクター', 'accounts.overview.tab.vault': '倉庫',
      'accounts.overview.tab.gifts': 'ギフト', 'accounts.overview.tab.potions': 'ポーション',
      'accounts.overview.tab.totals': '全アイテム',
      'accounts.overview.emptyChars': 'キャラクターデータが読み込まれていません。',
      'accounts.overview.selectChar': 'キャラクターを選択して装備とステータスを確認してください。',
      'accounts.modal.delete.title': 'アカウントを削除',
      'accounts.modal.delete.msg': 'このアカウントを本当に削除しますか？',
      'accounts.modal.delete.confirm': '削除',
      'accounts.modal.locked.title': 'アカウント使用中',
      'accounts.modal.locked.msg': 'このアカウントを編集する前にゲームから切断してください。',
      'accounts.modal.locked.ok': 'OK',
      'status.connecting': '接続中',
      'common.loading': '読み込み中...',
      'common.refreshing': '更新中...',
      'home.edit.title': 'レイアウトを編集',
      'home.script.selectPlaceholder': '-- スクリプトを選択 --',
      'home.script.useScriptsTab': 'スクリプトタブを使用',
      'home.script.runtime': '実行時間',
      'home.script.currentStatus': '現在の状態',
      'home.script.start': '開始',
      'home.script.pause': '一時停止',
      'home.script.openScriptsTab': 'スクリプト',
      'home.script.note.setup': 'Documents/Realmengine/Scripts の .mjs パッケージはスクリプトタブから実行してください。',
      'home.script.note.lastRun': '前回の実行: {name} ({duration})',
      'home.script.state.running': '実行中',
      'home.script.state.paused': '一時停止',
      'home.script.state.idle': '待機',
      'home.conn.listening': 'ポート 2050 で待受中',
      'home.conn.clientDetected': 'RotMG Exalt を検出',
      'home.conn.clientWaiting': 'RotMG Exalt を待機中...',
      'home.stat.uptime': '稼働時間',
      'home.stat.totalFameGained': '獲得フェイム合計',
      'home.stat.averageFpm': '平均 FPM',
      'home.stat.whiteBags': 'ホワイトバッグ',
      'home.stat.eventsKilled': '撃破イベント',
      'home.stat.dungeonsRan': 'ダンジョン攻略',
      'home.session.lastSession': '前回セッション: {name} - {duration}',
      'home.session.lastEmpty': '前回セッション: --',
      'home.session.ended': '終了: {time}',
      'home.session.endedEmpty': '終了: --',
      'home.feed.empty': 'セッションイベントはまだありません。',
      'home.feed.cleared': 'セッションフィードをクリアしました。',
      'home.accounts.sortAria': '起動アカウントの並べ替え',
      'home.accounts.noConfigured': 'アカウントがまだ設定されていません。',
      'home.accounts.loadingChars': 'キャラクターデータを読み込み中...',
      'home.accounts.fetchingTop': '最高フェイムのキャラを取得中...',
      'home.accounts.charNotLoaded': 'キャラクターデータ未読み込み。',
      'home.accountRow.summary': '{className} | フェイム {fame} | {server}',
      'home.account.unnamed': '名前なしアカウント',
      'home.action.launchSent': '起動リクエストを送信しました。',
      'home.action.launchRequested': 'アカウントの起動をリクエスト: {name}',
      'home.action.launchOffline': 'ダッシュボード接続がオフラインです。',
      'home.action.needCredentials': '先に認証情報のあるアカウントを選択してください。',
      'home.action.missingCreds': '選択したアカウントに認証情報がありません。',
      'home.action.reconnecting': 'ダッシュボードソケットを再接続中...',
      'home.action.gotoScripts': '.mjs パッケージはスクリプトタブから実行してください。',
      'home.action.scriptsRunThere': 'スクリプトはスクリプトタブから実行します。',
      'home.action.useScriptsJs': '.js スクリプトはスクリプトタブから実行してください。',
      'home.action.nexusOk': 'ネクサス退避を送信しました。',
      'home.action.nexusFail': 'ネクサス操作に失敗しました。',
      'home.action.nexusReqFail': 'ネクサスリクエストに失敗しました。',
      'home.action.noPosition': 'プレイヤー位置がありません。',
      'home.action.copiedPos': '座標をコピー: {text}',
      'home.action.copyFailed': 'コピーに失敗しました。',
      'home.action.noClipboard': 'この環境ではクリップボードを使用できません。',
      'home.action.adminLogs': 'ログを開くには管理者モードを有効にしてください。',
      'accounts.search.placeholder': 'エイリアス・メール・サーバーで検索...',
      'accounts.sort.aria': 'アカウントを並べ替え',
      'accounts.ctx.more': 'その他の操作',
      'accounts.toolbar.countOne': '{n} アカウント',
      'accounts.toolbar.countOther': '{n} アカウント',
      'accounts.empty.search': '検索に一致するアカウントがありません。',
      'accounts.card.noEmail': 'メールなし',
      'accounts.card.noNotes': 'メモなし',
      'accounts.orderDirty': '並び順が変わりました。保存して保持してください。',
      'accounts.overview.refreshAccount': 'アカウントを更新',
      'accounts.refreshAllBtn': 'すべて更新',
      'accounts.overview.summary.pickChars': 'アカウントを選択してキャラクターを表示。',
      'accounts.overview.summary.pickInv': 'アカウントを選択してインベントリを表示。',
      'accounts.overview.noneSelected': 'アカウントが選択されていません。',
      'accounts.overview.pickEquip': 'アカウントを選択して装備とステータスを表示。',
      'accounts.overview.pickInvChars': 'アカウントを選択してインベントリとキャラクターを表示。',
      'accounts.overview.enterCredsChars': 'メールとパスワードを入力し、更新してキャラクターを読み込んでください。',
      'accounts.overview.enterCredsInv': 'メールとパスワードを入力し、更新してインベントリを読み込んでください。',
      'accounts.overview.missingLogin': 'このアカウントにログイン情報がありません。',
      'accounts.overview.needCredsChars': 'キャラクターデータには有効な認証情報が必要です。',
      'accounts.overview.needCredsInv': 'インベントリには有効な認証情報が必要です。',
      'accounts.overview.loadingList': 'キャラクターリストを読み込み中...',
      'accounts.overview.notLoadedList': 'キャラクターリストはまだ読み込まれていません。',
      'accounts.overview.loadingCharsShort': 'キャラクターを読み込み中...',
      'accounts.overview.clickRefreshChars': '「キャラクターを更新」でこのアカウントを読み込んでください。',
      'accounts.overview.loadingAccount': 'アカウントデータを読み込み中...',
      'accounts.overview.notLoadedAccount': 'アカウントデータはまだ読み込まれていません。',
      'accounts.overview.clickRefreshAccount': '「アカウントを更新」でこのアカウントを読み込んでください。',
      'accounts.overview.fetchChars': 'RotMG からキャラクターデータを取得中...',
      'accounts.overview.fetchAccount': 'RotMG からアカウントデータを取得中...',
      'accounts.overview.hintLoadChars': 'キャラクターリストを読み込んで装備とステータスを確認。',
      'accounts.overview.hintLoadAccount': 'アカウントデータを読み込んでキャラクターと所持品を確認。',
      'accounts.summary.chars': '{n} キャラ',
      'accounts.summary.vault': '倉庫 {n}',
      'accounts.summary.gifts': 'ギフト {n}',
      'accounts.summary.potions': 'ポーション {n}',
      'accounts.summary.aliveFame': '生存フェイム計 {n}',
      'accounts.summary.bestChar': '最高キャラ {n}',
      'accounts.summary.updated': '更新 {time}',
      'accounts.summary.defaultName': 'アカウント',
      'accounts.notice.cachedFrom': '{time} のキャッシュ済みキャラクターリストを読み込みました。',
      'accounts.notice.cached': 'キャッシュ済みキャラクターリストを読み込みました。',
      'accounts.notice.listAt': 'キャラクターリスト更新: {time}',
      'accounts.notice.listOk': 'キャラクターリストを更新しました。',
      'accounts.notice.loadingList': 'キャラクターリストを読み込み中...',
      'accounts.error.loadList': 'キャラクターリストの読み込みに失敗しました。',
      'accounts.character.none': 'このアカウントにキャラクターがありません。',
      'accounts.character.noneReturned': 'このアカウントはキャラクターを返しませんでした。',
      'accounts.character.pick': 'キャラクターを選択して装備とステータスを表示。',
      'accounts.character.classDefault': 'キャラクター',
      'accounts.character.lvl': 'Lv.{n}',
      'accounts.character.seasonal': 'シーズン',
      'accounts.character.dead': '死亡',
      'accounts.character.fameMeta': 'フェイム {n}',
      'accounts.character.hpMeta': 'HP {n}/{max}',
      'accounts.character.idMeta': 'ID {n}',
      'accounts.equipment.slot': 'スロット {n}',
      'accounts.equipment.empty': '空',
      'accounts.equipment.weapon': '武器',
      'accounts.equipment.ability': 'スキル',
      'accounts.equipment.armor': '防具',
      'accounts.equipment.ring': '指輪',
      'accounts.stat.hp': 'HP',
      'accounts.stat.mp': 'MP',
      'accounts.stat.fame': 'フェイム',
      'accounts.stat.exp': '経験値',
      'accounts.stat.attack': '攻撃',
      'accounts.stat.defense': '防御',
      'accounts.stat.speed': '速度',
      'accounts.stat.dexterity': '器用',
      'accounts.stat.vitality': '体力',
      'accounts.stat.wisdom': '知恵',
      'accounts.detail.typeLine': 'タイプ {hex}',
      'accounts.detail.levelPill': 'レベル {n}',
      'accounts.detail.famePill': 'フェイム {n}',
      'accounts.detail.charIdPill': 'キャラID {n}',
      'accounts.section.equipped': '装備',
      'accounts.section.stats': 'ステータス',
      'accounts.section.inventory': 'インベントリ',
      'accounts.browser.noTotals': 'キャッシュされたインベントリはまだありません。',
      'accounts.browser.noSectionItems': 'このアカウントに {section} のアイテムはありません。',
      'accounts.browser.hintTotals': 'アイテムをクリックしてどのアカウントに何個あるか表示。',
      'accounts.browser.hintItems': 'アイテムをクリックして名称とエンチャントを表示。',
      'accounts.browser.uniqueAcrossOne': '{items} 種類のアイテム（読み込み済み {n} アカウント）',
      'accounts.browser.uniqueAcrossOther': '{items} 種類のアイテム（読み込み済み {n} アカウント）',
      'accounts.refreshAll.loading': '全アカウントのデータを更新中...',
      'accounts.refreshAll.doneOne': '{n} アカウントを更新しました。',
      'accounts.refreshAll.doneOther': '{n} アカウントを更新しました。',
      'accounts.error.refreshAll': '全アカウントの更新に失敗しました。',
      'accounts.storage.summary': '{total} アイテム | {unique} 種類',
      'home.equipment.none': '装備データなし',
      'home.equipment.noneEquipped': '装備なし',
    },
  };

  const PLUGIN_NAME_TRANSLATIONS = {
    es: {
      autododge: 'Esquiva automática',
      autonexus: 'Nexus automático',
      damagesniffer: 'Rastreador de daño',
      serverswitch: 'Cambio de servidor',
      ipconnect: 'Conectar por IP',
      packetlogger: 'Registro de paquetes',
      socket: 'Socket',
      rollback: 'Reversión',
      autoaim: 'Apuntado automático',
      autoability: 'Habilidad automática',
      antidebuffs: 'Antiestados',
      autoloot: 'Botín automático',
      o3helper: 'Asistente de O3',
      spooftiles: 'Tiles falsos',
      dllwalkto: 'Ir con DLL',
    },
    de: {
      autododge: 'Auto-Ausweichen',
      autonexus: 'Auto-Nexus',
      damagesniffer: 'Schadens-Tracker',
      serverswitch: 'Server-Wechsel',
      ipconnect: 'IP-Verbindung',
      packetlogger: 'Paket-Logger',
      socket: 'Socket',
      rollback: 'Rücksetzung',
      autoaim: 'Auto-Zielen',
      autoability: 'Auto-Fähigkeit',
      antidebuffs: 'Anti-Debuffs',
      autoloot: 'Auto-Loot',
      o3helper: 'O3-Helfer',
      spooftiles: 'Tile-Spoofing',
      dllwalkto: 'DLL-Laufziel',
    },
    pt: {
      autododge: 'Desvio automático',
      autonexus: 'Nexus automático',
      damagesniffer: 'Rastreador de dano',
      serverswitch: 'Troca de servidor',
      ipconnect: 'Conexão por IP',
      packetlogger: 'Registro de pacotes',
      socket: 'Socket',
      rollback: 'Reversão',
      autoaim: 'Mira automática',
      autoability: 'Habilidade automática',
      antidebuffs: 'Antiestados',
      autoloot: 'Saque automático',
      o3helper: 'Assistente O3',
      spooftiles: 'Tiles falsos',
      dllwalkto: 'Ir com DLL',
    },
    ja: {
      autododge: '自動回避',
      autonexus: '自動ネクサス',
      damagesniffer: 'ダメージトラッカー',
      serverswitch: 'サーバー切替',
      ipconnect: 'IP接続',
      packetlogger: 'パケットロガー',
      socket: 'ソケット',
      rollback: 'ロールバック',
      autoaim: '自動エイム',
      autoability: '自動アビリティ',
      antidebuffs: 'デバフ対策',
      autoloot: '自動ルート',
      o3helper: 'O3ヘルパー',
      spooftiles: 'タイル偽装',
      dllwalkto: 'DLL歩行',
    },
  };

  // 8x8 pixel sprite template for front-facing character
  // .: transparent, S: skin, s: skin shadow, P: primary, D: secondary/dark, H: hair/hat
  const SPRITE_TEMPLATE = [
    '..HHHH..',
    '.HSSSSH.',
    '.HSSSSH.',
    'DPPPPPD.',
    '.DPPPD..',
    '..PPPP..',
    '..D..D..',
    '..DD.DD.',
  ];

  // Render a class sprite to a data URL
  const spriteCache = {};
  const damagePortraitCache = new Map();
  const damagePortraitPending = new Set();
  let playerAvatarRenderSeq = 0;
  function renderClassSprite(classType) {
    if (spriteCache[classType]) return spriteCache[classType];

    const colors = CLASS_COLORS[classType] || ['#888888','#555555','#333333'];
    const colorMap = {
      '.': null,
      'S': SKIN_COLOR,
      's': SKIN_SHADOW,
      'P': colors[0],
      'D': colors[1],
      'H': colors[2],
    };

    const canvas = document.createElement('canvas');
    canvas.width = 8;
    canvas.height = 8;
    const ctx = canvas.getContext('2d');

    for (let y = 0; y < 8; y++) {
      const row = SPRITE_TEMPLATE[y];
      for (let x = 0; x < 8; x++) {
        const c = colorMap[row[x]];
        if (c) {
          ctx.fillStyle = c;
          ctx.fillRect(x, y, 1, 1);
        }
      }
    }

    const url = canvas.toDataURL();
    spriteCache[classType] = url;
    return url;
  }

  function getDamagePlayerPortraitUrl(player) {
    const classTypeRaw = Number(player && player.classType);
    if (!Number.isFinite(classTypeRaw) || classTypeRaw <= 0) return '';
    const classType = Math.trunc(classTypeRaw);
    const fallbackUrl = renderClassSprite(classType);

    const skinRaw = Number(player && player.skin);
    const tex1Raw = Number(player && player.tex1);
    const tex2Raw = Number(player && player.tex2);
    const skin = (Number.isFinite(skinRaw) && skinRaw > 0) ? Math.trunc(skinRaw) : classType;
    const tex1 = Number.isFinite(tex1Raw) ? Math.trunc(tex1Raw) : 0;
    const tex2 = Number.isFinite(tex2Raw) ? Math.trunc(tex2Raw) : 0;
    const key = classType + ':' + skin + ':' + tex1 + ':' + tex2;

    const cached = damagePortraitCache.get(key);
    if (cached) return cached;
    damagePortraitCache.set(key, fallbackUrl);

    if (typeof window.renderEamPortrait === 'function' && !damagePortraitPending.has(key)) {
      damagePortraitPending.add(key);
      window.renderEamPortrait(classType, skin, tex1, tex2)
        .then(function (portraitUrl) {
          if (!portraitUrl) return;
          damagePortraitCache.set(key, portraitUrl);
        })
        .catch(function () {
        })
        .finally(function () {
          damagePortraitPending.delete(key);
          if (activeTab === 'damage') renderDamageTab();
        });
    }

    return fallbackUrl;
  }

  let ws = null;
  let packets = [];
  let visiblePackets = [];
  let selectedPacketId = null;
  let paused = false;
  let hiddenTypes = new Set();
  let seenTypes = new Set();
  let totalCount = 0;
  let recentTimestamps = [];
  let devMode = localStorage.getItem('devMode') === 'true';
  /** When false, hide the packet sniffer drawer (Admin Mode still shows Logs / Packet Lab). Persisted locally. */
  let packetSnifferVisible = localStorage.getItem('packetSnifferVisible') !== 'false';
  // adminMode is always derived from server — never read from localStorage
  let adminMode = false;
  const legacyLightMode = localStorage.getItem('lightMode') === 'true';
  let currentTheme = localStorage.getItem('theme') || (legacyLightMode ? 'light' : 'dark');
  let currentLanguage = localStorage.getItem('language') || 'en';
  (function migrateStatBonuses() {
    var legacy = localStorage.getItem('showStatBonuses');
    var g = localStorage.getItem('showGearStatBonuses');
    var e = localStorage.getItem('showExaltStatBonuses');
    if (e !== null) {
      var combinedOn = g !== null ? g !== 'false' || e !== 'false' : e !== 'false';
      localStorage.setItem('showGearStatBonuses', combinedOn ? 'true' : 'false');
      localStorage.removeItem('showExaltStatBonuses');
    }
    if (legacy !== null && localStorage.getItem('showGearStatBonuses') === null) {
      localStorage.setItem('showGearStatBonuses', legacy !== 'false' ? 'true' : 'false');
    }
    if (legacy !== null) localStorage.removeItem('showStatBonuses');
  })();
  let showGearStatBonuses = localStorage.getItem('showGearStatBonuses') !== 'false';
  function buildGearExaltBonusSuffix(gearBonus, exaltBonus) {
    var parts = [];
    var g = Number(gearBonus);
    if (!Number.isFinite(g) || g <= 0) g = 0;
    var x = Number(exaltBonus);
    if (!Number.isFinite(x) || x <= 0) x = 0;
    if (!showGearStatBonuses) return '';
    if (g > 0) parts.push('(+' + g + ')');
    if (x > 0) parts.push('(+' + x + ')');
    return parts.join(' ');
  }
  function formatPlayerStatLine(base, gearBonus, exaltBonus) {
    if (base == null || base === '') return '--';
    if (!showGearStatBonuses) return String(base);
    var suf = buildGearExaltBonusSuffix(gearBonus, exaltBonus);
    return suf ? String(base) + ' ' + suf : String(base);
  }
  let showServerPing = localStorage.getItem('showServerPing') !== 'false';
  let showAccountEmails = localStorage.getItem('showAccountEmails') !== 'false';
  let showSingleAccountDock = localStorage.getItem('showSingleAccountDock') !== 'false';
  let navbarTabOrder = JSON.parse(localStorage.getItem('navbarTabOrder') || 'null');
  let navbarHiddenTabs = new Set(JSON.parse(localStorage.getItem('navbarHiddenTabs') || '[]'));
  let quickLaunchAccountId = localStorage.getItem('quickLaunchAccountId') || null;
  let activeSettingsTab = localStorage.getItem('activeSettingsTab') || 'visual';
  let snifferExpanded = false;
  let snifferPacketsSinceCollapse = 0;
  let accessToken = localStorage.getItem('accessToken') || null;
  let refreshToken = localStorage.getItem('refreshToken') || null;
  let dashboardUser = null;
  let dashboardLoggedIn = false;
  /** Plan name for sidebar + settings (from /api/payments/subscription plan_name, else Free) */
  let dashboardSubscriptionTier = 'Free';
  /** Active plan names received from the server (normalized lowercase, e.g. {'dodge', 'developer'}). */
  var activePlanNames = new Set();
  /**
   * View-as preview (admin debug). When set, activePlanNames + adminMode reflect
   * the override instead of the server's real values. _realActivePlans keeps the
   * server's last-known plans so we can restore on reset.
   */
  var _realActivePlans = new Set();
  var _realAdminMode = false;
  var viewAsOverride = null;  // null = no override; otherwise { plans, isAdmin, label }
  var VIEW_AS_PRESETS = {
    'free':      { plans: [],            isAdmin: false, label: 'Free user' },
    'dodge':     { plans: ['dodge'],     isAdmin: false, label: 'Dodge user' },
    'developer': { plans: ['developer'], isAdmin: false, label: 'Developer user' },
  };
  /** Website for gem purchases & subscriptions (Payment page) */
  var REALM_ENGINE_WEB_BASE = 'https://rotmg-engine.egtw.org';

  // Packet Lab state
  let labUnknowns = [];
  let labSelectedId = null;
  let labDefinitions = null;
  let labSubtab = 'working';
  let labSelectedDefinedPacket = null;
  let labDefinedFilter = 'all';

  function getLabPacketSearchQuery() {
    const el = document.getElementById('lab-packet-search');
    return el ? String(el.value || '').trim().toLowerCase() : '';
  }

  function labDefinedPacketMatchesSearch(p, q) {
    if (!q) return true;
    const name = (p.name || '').toLowerCase();
    if (name.indexOf(q) !== -1) return true;
    if (Number.isInteger(p.id)) {
      const dec = String(p.id);
      if (dec.indexOf(q) !== -1) return true;
      if (/^\d+$/.test(q) && parseInt(q, 10) === p.id) return true;
      const hexNorm = q.replace(/^0x/i, '');
      if (/^[0-9a-f]+$/i.test(hexNorm) && hexNorm.length <= 8) {
        const n = parseInt(hexNorm, 16);
        if (n === p.id) return true;
      }
    }
    return false;
  }

  function labUnknownMatchesSearch(u, q) {
    if (!q) return true;
    const dec = String(u.id);
    if (dec.indexOf(q) !== -1) return true;
    if (/^\d+$/.test(q) && parseInt(q, 10) === u.id) return true;
    const hexNorm = q.replace(/^0x/i, '');
    if (/^[0-9a-f]+$/i.test(hexNorm) && hexNorm.length <= 8) {
      const n = parseInt(hexNorm, 16);
      if (n === u.id) return true;
    }
    const hn = (u.hardCodedName || '').toLowerCase();
    if (hn.indexOf(q) !== -1) return true;
    return ('id ' + u.id).toLowerCase().indexOf(q) !== -1;
  }

  function syncLabPacketToolbarVisibility() {
    const searchWrap = document.getElementById('lab-packet-search-wrap');
    if (searchWrap) searchWrap.classList.toggle('hidden', labSubtab === 'byte-tool');
    const filterWrap = document.getElementById('lab-defined-filter-wrap');
    if (filterWrap) filterWrap.classList.toggle('hidden', !(labSubtab === 'working' || labSubtab === 'need-work'));
  }
  let labBytePacket = [];
  let labByteSelStart = null;
  let labByteSelEnd = null;
  let labByteDragging = false;
  let labSendReqSeq = 1;
  const labSendPending = new Map();
  const LAB_SENDABLE_PACKETS = new Set([
    'REQUESTTRADE',
    'CANCELTRADE',
    'ACCEPTTRADE',
    'CHANGETRADE',
    'PARTYACTIONRESULT',
    'PARTYJOINREQUEST',
    'INVENTORYSWAP',
  ]);
  // Damage Sniffer (RealmShark-style) state
  let damageHistory = [];
  let damageLive = null;
  let damageSelectedRun = 'live'; // 'live' | number (history index)
  let damageSelectedTargetId = null;
  let damageSelectedPlayerId = null;
  let damageFilter = localStorage.getItem('damageFilter') || 'all';
  let damageSort = localStorage.getItem('damageSort') || 'lastHit';
  let activeTab = 'home';
  let memHelperPollTimer = null;
  let homeControlsWired = false;
  let homeFeed = [];
  let homeLastCharacterKey = '';
  let homeConnectionCount = 0;
  let homeWasGameConnected = false;
  let homeWasPlayerDead = false;
  let homeLastCompletedScript = { name: '', durationMs: 0, endedAt: 0, status: '' };
  let homeLastSession = { name: '', durationMs: 0, endedAt: 0 };
  let homeActionStatus = '';
  let homeActionStatusAt = 0;
  let homeLiveTicker = null;
  let homeStats = {
    startedAt: Date.now(),
    fameGained: 0,
    averageFpm: 0,
    packetsProcessed: 0,
    teleports: 0,
    reconnects: 0,
    deaths: 0,
    pluginTriggers: 0,
    scriptRuntimeMs: 0,
    scriptRunningSince: 0,
  };
  let currentServerName = '';
  let serverSelectBaseLabels = {};
  let allPluginsData = [];
  let lastObjectsData = { portals: [], beacons: [], categories: [], beaconTypes: [] };
  let lastTilesData = { center: { x: 0, y: 0 }, radius: 12, groups: [] };
  /** Game Wiki tab — catalog from objects.xml / tiles.xml (dev dashboard) */
  var gameWikiSummaries = [];
  var gameWikiDetails = Object.create(null);
  var gameWikiTiles = [];
  var gameWikiSummaryByType = Object.create(null);
  var gameWikiTileByType = Object.create(null);
  var gameWikiSection = 'objects';
  var gameWikiSearchRaw = '';
  var gameWikiFiltered = [];
  var gameWikiLoaded = false;
  var gameWikiLoading = false;
  var gameWikiSelectedType = null;
  var gameWikiSearchTimer = null;
  var gameWikiViewportRaf = null;
  var gameWikiClassFilter = 'all';
  var gameWikiSortMode = 'name';
  var gameWikiDungeonFilter = '';
  /** LRU-ish cache of raw object/tile XML. Map so insertion order drives eviction when over cap. */
  var gameWikiXmlCache = new Map();
  /** `o:type` → parsed {file,index,cell}; avoids regex-reparsing on every scroll tick. */
  var gameWikiTextureCache = new Map();
  var gameWikiXmlPendingKey = null;
  /** `o:type` → true while `requestObjectXml` is in flight (dedupe detail + list prefetch). */
  var gameWikiObjectXmlInFlight = Object.create(null);
  var gameWikiTileXmlInFlight = Object.create(null);
  /** `o:type` → setTimeout ID for a staggered prefetch; kept so offscreen rows can cancel. */
  var gameWikiXmlPrefetchScheduled = Object.create(null);
  var GAME_WIKI_ROW_H = 40;
  var GAME_WIKI_OVERSCAN = 10;
  var GAME_WIKI_XML_CACHE_CAP = 1500;
  /** Mirrors `src/constants/ConditionEffect.ts` — bitmask column indices on PlayerData.effects[0]/[1]. */
  var GAME_WIKI_CONDITION_EFFECTS = [
    { name: 'Dead', index: 0 },
    { name: 'Quiet', index: 1 },
    { name: 'Weak', index: 2 },
    { name: 'Slowed', index: 3 },
    { name: 'Sick', index: 4 },
    { name: 'Dazed', index: 5 },
    { name: 'Stunned', index: 6 },
    { name: 'Blind', index: 7 },
    { name: 'Hallucinating', index: 8 },
    { name: 'Drunk', index: 9 },
    { name: 'Confused', index: 10 },
    { name: 'StunImmune', index: 11 },
    { name: 'Invisible', index: 12 },
    { name: 'Paralyzed', index: 13 },
    { name: 'Speedy', index: 14 },
    { name: 'Bleeding', index: 15 },
    { name: 'ArmorBrokenImmune', index: 16 },
    { name: 'Healing', index: 17 },
    { name: 'Damaging', index: 18 },
    { name: 'Berserk', index: 19 },
    { name: 'Paused', index: 20 },
    { name: 'Stasis', index: 21 },
    { name: 'StasisImmune', index: 22 },
    { name: 'Invincible', index: 23 },
    { name: 'Invulnerable', index: 24 },
    { name: 'Armored', index: 25 },
    { name: 'ArmorBroken', index: 26 },
    { name: 'Hexed', index: 27 },
    { name: 'NinjaSpeedy', index: 28 },
    { name: 'Unstable', index: 29 },
    { name: 'Darkness', index: 30 },
    { name: 'SlowedImmune', index: 31 },
    { name: 'DazedImmune', index: 32 },
    { name: 'ParalyzeImmune', index: 33 },
    { name: 'Petrified', index: 34 },
    { name: 'PetrifiedImmune', index: 35 },
    { name: 'PetDisable', index: 36 },
    { name: 'Curse', index: 37 },
    { name: 'CurseImmune', index: 38 },
    { name: 'HpBoost', index: 39 },
    { name: 'MpBoost', index: 40 },
    { name: 'AttBoost', index: 41 },
    { name: 'DefBoost', index: 42 },
    { name: 'SpdBoost', index: 43 },
    { name: 'VitBoost', index: 44 },
    { name: 'WisBoost', index: 45 },
    { name: 'DexBoost', index: 46 },
    { name: 'Silenced', index: 47 },
    { name: 'Exposed', index: 48 },
    { name: 'Energized', index: 49 },
    { name: 'InCombat', index: 58 },
  ];
  let _objectsTreeHash = null;
  let _tilemapTreeHash = null;
  let lastNearbyPlayers = [];
  let selectedNearbyPlayerId = null;
  let lastNearbyPlayerDebug = null;
  let nearbyPollTimer = null;
  let gameConnected = false;
  /** Declared before early `applyMultiAccountView()` / `renderHomeTab()` (avoids TDZ ReferenceError). */
  let lastPlayerData = null;
  /** Same: `renderHomeTab` reads scripts before former late `var` init line ran. */
  let scriptsTabLastData = { scripts: [], dir: null };
  let scriptsPageSelectedId = null;
  let scriptsPageSearch = '';
  let scriptsPageSort = 'name';
  let scriptsPageStatusFilter = 'all';
  let scriptsLogBuffer = [];
  let scriptsLogLevelFilter = 'all';
  let scriptsLogScriptFilter = 'all';
  let scriptsLogSearch = '';
  let scriptsLogPaused = false;
  let scriptsLogAutoScroll = true;
  let rotmgPath = '';
  let rotmgPathSource = 'none';
  let singleClientOnly = true;
  function normalizeAccountLayoutMode(raw) {
    var s = String(raw || '').trim().toLowerCase();
    if (s === 'mac' || s === 'multibox') return s;
    return 'single';
  }
  /** @type {'single'|'mac'|'multibox'} */
  let accountLayoutMode = normalizeAccountLayoutMode(localStorage.getItem('accountLayoutMode'));
  function isMacStyleSidebar() {
    return accountLayoutMode === 'mac' || accountLayoutMode === 'multibox';
  }
  function isMacMultiHome() {
    return accountLayoutMode === 'mac';
  }
  let multiAccountSidebarModeRaw = String(localStorage.getItem('multiAccountSidebarMode') || 'connected').trim().toLowerCase();
  let multiAccountSidebarMode = (multiAccountSidebarModeRaw === 'launch') ? 'launch' : 'connected';
  let multiHomeFocusedClientId = null;
  const SINGLE_ACCOUNT_CLIENT_ID = '__single_account__';
  let singleAccountDockMinimized = String(localStorage.getItem('singleAccountDockMinimized') || '1') !== '0';
  var connectedClients = new Map(); // clientId → compact data from clientList message
  var connectedClientFirstSeenAt = new Map(); // clientId -> first-seen timestamp (ms)
  var macScriptSelectionByClientId = (function () {
    try {
      var raw = localStorage.getItem('macScriptSelectionByClientId');
      var parsed = raw ? JSON.parse(raw) : {};
      return (parsed && typeof parsed === 'object') ? parsed : {};
    } catch (_) {
      return {};
    }
  })();
  let serverPluginConfigId = '';
  let pluginConfigs = [];
  let availableServerNames = [];
  let dashboardAccounts = [];
  let selectedAccountId = null;
  let accountsDirty = false;
  let accountsRefreshAllLoading = false;
  let suppressAccountsEditorEvents = false;

  // ── Stat-pot object type IDs (standard + greater) ─────────────────────────
  var STAT_POT_IDS = {
    atk:  [2591, 9064],
    def:  [2592, 9065],
    spd:  [2593, 9066],
    dex:  [2636, 9069],
    vit:  [2612, 9067],
    wis:  [2613, 9068],
    life: [2793, 9070],
    mana: [2794, 9071],
  };
  var ALL_STAT_POT_IDS = Object.values ? Object.values(STAT_POT_IDS).reduce(function(a, b) { return a.concat(b); }, []) : [2591,9064,2592,9065,2593,9066,2636,9069,2612,9067,2613,9068,2793,9070,2794,9071];

  function parseItemIds(str) {
    return (str || '').split(',').map(function(s) {
      var n = parseInt(s.trim(), 10);
      return isNaN(n) || n <= 0 ? null : n;
    }).filter(function(n) { return n !== null; });
  }

  function serializeItemIds(ids) {
    var seen = Object.create(null);
    var unique = ids.filter(function(id) {
      if (seen[id]) return false;
      seen[id] = true;
      return true;
    });
    unique.sort(function(a, b) { return a - b; });
    return unique.join(',');
  }

  function renderPotRowState(potRowEl, fieldEl) {
    if (!potRowEl || !fieldEl) return;
    var currentSet = Object.create(null);
    parseItemIds(fieldEl.value).forEach(function(id) { currentSet[id] = true; });
    potRowEl.querySelectorAll('.accounts-pot-btn[data-pot]').forEach(function(btn) {
      var pot = btn.getAttribute('data-pot');
      var ids = pot === 'all' ? ALL_STAT_POT_IDS : (STAT_POT_IDS[pot] || []);
      btn.classList.toggle('active', ids.length > 0 && ids.every(function(id) { return !!currentSet[id]; }));
    });
  }

  function renderAllPotRows() {
    var mulingSection = document.getElementById('accounts-muling-section');
    if (!mulingSection) return;
    mulingSection.querySelectorAll('[data-pot-field]').forEach(function(potRow) {
      var fieldName = potRow.getAttribute('data-pot-field');
      var fieldEl = fieldName === 'mule-off' ? accountsMulingItemsMuleOff
                  : fieldName === 'store'     ? accountsMulingItemsStore
                  : fieldName === 'from-main' ? accountsMulingItemsFromMain
                  : null;
      renderPotRowState(potRow, fieldEl);
    });
  }
  let accountOverviewById = Object.create(null);
  let accountOverviewNoticeById = Object.create(null);
  let selectedAccountCharacterIdByAccountId = Object.create(null);
  let accountOverviewLoadingId = null;
  let homeAccountOverviewLoadingIds = new Set();
  let homeAccountOverviewAttemptedIds = new Set();
  let selectedAccountsOverviewTab = 'characters';
  let accountsDetailsCollapsed = localStorage.getItem('accountsDetailsCollapsed') === '1';
  var activeAccountsEditorTab = 'credentials';
  function switchAccountsEditorTab(tab) {
    activeAccountsEditorTab = tab;
    var panels = {
      credentials: document.getElementById('accounts-login-section'),
      automation:  document.getElementById('accounts-muling-section'),
      overview:    document.getElementById('accounts-editor-overview-panel'),
    };
    Object.keys(panels).forEach(function(k) {
      if (panels[k]) panels[k].style.display = k === tab ? '' : 'none';
    });
    document.querySelectorAll('.accounts-editor-tab').forEach(function(btn) {
      btn.classList.toggle('active', btn.getAttribute('data-editor-tab') === tab);
    });
  }
  let accountsPasswordVisible = false;
  let accountsSortModeRaw = localStorage.getItem('accountsSortMode') || 'newest';
  let accountsSortMode = ['newest', 'oldest', 'alphabetical', 'fame'].indexOf(accountsSortModeRaw) >= 0
    ? accountsSortModeRaw
    : 'newest';
  let homeAccountsSortModeRaw = localStorage.getItem('homeAccountsSortMode') || 'newest';
  let homeAccountsSortMode = ['newest', 'oldest', 'alphabetical', 'fame'].indexOf(homeAccountsSortModeRaw) >= 0
    ? homeAccountsSortModeRaw
    : 'newest';
  let macLaunchSortModeRaw = String(localStorage.getItem('macLaunchSortMode') || 'newest').trim();
  if (macLaunchSortModeRaw === 'seasonal_first') {
    macLaunchSortModeRaw = 'newest';
    try {
      localStorage.setItem('macLaunchSortMode', 'newest');
    } catch (_e1) {}
  }
  let macLaunchSortMode = ['newest', 'oldest', 'alphabetical', 'fame_high', 'fame_low'].indexOf(macLaunchSortModeRaw) >= 0
    ? macLaunchSortModeRaw
    : 'newest';
  let macLaunchSeasonFilterRaw = String(localStorage.getItem('macLaunchSeasonFilter') || 'any').trim().toLowerCase();
  if (macLaunchSeasonFilterRaw === 'best_seasonal' || macLaunchSeasonFilterRaw === 'any_seasonal') {
    macLaunchSeasonFilterRaw = 'yes';
    try {
      localStorage.setItem('macLaunchSeasonFilter', 'yes');
    } catch (_e2) {}
  } else if (macLaunchSeasonFilterRaw === 'best_nonseasonal') {
    macLaunchSeasonFilterRaw = 'no';
    try {
      localStorage.setItem('macLaunchSeasonFilter', 'no');
    } catch (_e3) {}
  }
  let macLaunchSeasonFilter = ['any', 'yes', 'no'].indexOf(macLaunchSeasonFilterRaw) >= 0
    ? macLaunchSeasonFilterRaw
    : 'any';
  let macLaunchMinFameStored = localStorage.getItem('macLaunchMinFame');
  let macLaunchMinFameNum = Number(macLaunchMinFameStored != null && String(macLaunchMinFameStored).trim() !== '' ? macLaunchMinFameStored : 0);
  if (!Number.isFinite(macLaunchMinFameNum) || macLaunchMinFameNum < 0) macLaunchMinFameNum = 0;
  let macLaunchSortBindingsDone = false;
  let macLaunchSortPopoutOpen = false;
  let macLaunchGroupsBindingsDone = false;
  let macLaunchGroupModalEditingId = null;
  let macGroupLaunchQuietFeedUntil = 0;
  const MAC_GROUP_LAUNCH_STAGGER_MS = 1600;
  const MAC_LAUNCH_GROUP_NO_OVERLAP_LS_KEY = 'macLaunchGroupEditorNoOverlap';
  /** @type {Record<string, { x: number; y: number; width: number; height: number }>} */
  var macLaunchGroupLayoutByAccount = {};
  var macLaunchGroupLayoutRefSnapshot = { width: 1920, height: 1080 };
  let macLaunchMinFameDebounceTimer = null;
  let homeMultiSearchQuery = String(localStorage.getItem('homeMultiSearchQuery') || '').trim();
  let homeMultiStatusFilterRaw = String(localStorage.getItem('homeMultiStatusFilter') || 'all').trim().toLowerCase();
  let homeMultiStatusFilter = ['all', 'ready', 'missing', 'mule'].indexOf(homeMultiStatusFilterRaw) >= 0
    ? homeMultiStatusFilterRaw
    : 'all';
  let itemDetailPayloadSeq = 0;
  let itemDetailPayloadById = Object.create(null);

  // Elements
  const packetBody = document.getElementById('packet-body');
  const snifferTableWrap = document.getElementById('sniffer-table-wrap');
  const ppsEl = document.getElementById('pps');
  const totalEl = document.getElementById('total');
  // game-status badge was removed from the header. Stub keeps the existing
  // live-update sites writing without having to null-check everywhere.
  const gameStatus = { textContent: '', className: '' };
  const playerCard = document.getElementById('player-card');
  function setPlayerCardVisibility(connected) {
    if (!playerCard) return;
    var wasHidden = playerCard.classList.contains('player-card--hidden');
    playerCard.classList.toggle('player-card--hidden', !connected);
    playerCard.classList.toggle('player-card--dock-replaced', !isMacStyleSidebar());
    // Replay the slide-in animation each time the shelf opens. Strip and
    // re-add the class with a forced reflow in between so CSS sees the
    // transition fresh (otherwise the keyframes only run on first paint).
    if (connected && wasHidden) {
      playerCard.classList.remove('player-card--opening');
      void playerCard.offsetWidth; // force reflow
      playerCard.classList.add('player-card--opening');
      setTimeout(function () {
        playerCard.classList.remove('player-card--opening');
      }, 360);
    }
  }
  // Player card stays hidden until the first "game connected" signal.
  setPlayerCardVisibility(false);
  const detailPanel = document.getElementById('detail-panel');
  const detailTitle = document.getElementById('detail-title');
  const detailFields = document.getElementById('detail-fields');
  const detailHex = document.getElementById('detail-hex');
  const pluginHub = document.getElementById('plugin-hub');
  const pluginSidebarList = document.getElementById('plugin-sidebar-list');
  const pluginSearch = document.getElementById('plugin-search');
  const pluginCategory = document.getElementById('plugin-category');
  const pluginDetail = document.getElementById('plugin-detail');
  let pluginsReceived = false;
  const accountsSearchInput = document.getElementById('accounts-search');
  const accountsCountEl = document.getElementById('accounts-count');
  const accountsSortEl = document.getElementById('accounts-sort');
  const homeAccountsSortEl = document.getElementById('home-accounts-sort');
  const accountsNewBtn = document.getElementById('accounts-new-btn');
  const accountsSaveBtn = document.getElementById('accounts-save-btn');
  const accountsFillBtn = document.getElementById('accounts-fill-btn');
  const accountsLaunchBtn = document.getElementById('accounts-launch-btn');
  const accountsEditorPanelEl = document.getElementById('accounts-editor-panel');
  const accountsLoginSectionEl = document.getElementById('accounts-login-section');
  const accountsListEl = document.getElementById('accounts-list');
  const accountsEmptyEl = document.getElementById('accounts-empty');
  const accountsEditorTitleEl = document.getElementById('accounts-editor-title');
  const accountsAliasInput = document.getElementById('accounts-alias');
  const accountsIsSteamInput = document.getElementById('accounts-is-steam');
  const accountsSteamIdWrap = document.getElementById('accounts-steam-id-wrap');
  const accountsSteamIdInput = document.getElementById('accounts-steam-id');
  const accountsEmailLabel = document.getElementById('accounts-email-label');
  const accountsEmailInput = document.getElementById('accounts-email');
  const accountsPasswordLabel = document.getElementById('accounts-password-label');
  const accountsPasswordInput = document.getElementById('accounts-password');
  const accountsPasswordVisibilityBtn = document.getElementById('accounts-password-visibility-btn');
  const accountsServerSelect = document.getElementById('accounts-server');
  const accountsNotesInput = document.getElementById('accounts-notes');
  const accountsStatusEl = document.getElementById('accounts-status');
  // Muling section elements
  const accountsMulingSection = document.getElementById('accounts-muling-section');
  const accountsRoleNoneBtn = document.getElementById('accounts-role-none');
  const accountsRoleMainBtn = document.getElementById('accounts-role-main');
  const accountsRoleMuleBtn = document.getElementById('accounts-role-mule');
  const accountsMulingMainOpts = document.getElementById('accounts-muling-main-opts');
  const accountsMulingMuleOpts = document.getElementById('accounts-muling-mule-opts');
  const accountsModeAnyBtn = document.getElementById('accounts-mode-any');
  const accountsModeSpecificBtn = document.getElementById('accounts-mode-specific');
  const accountsMulingItemsWrap = document.getElementById('accounts-muling-items-wrap');
  const accountsMulingItemsStore = document.getElementById('accounts-muling-items-store');
  const accountsMulingItemsFromMain = document.getElementById('accounts-muling-items-from-main');
  const accountsMulingItemsMuleOff = document.getElementById('accounts-muling-items-mule-off');
  const accountsProxyInput = document.getElementById('accounts-proxy');
  const accountsProxyAuthWrap = document.getElementById('accounts-proxy-auth-wrap');
  const accountsProxyUsername = document.getElementById('accounts-proxy-username');
  const accountsProxyPassword = document.getElementById('accounts-proxy-password');
  const accountsCardCtxMenu = document.getElementById('accounts-card-ctx-menu');
  // New elements for redesigned accounts tab
  const accountsSetupEl = document.getElementById('accounts-setup');
  const accountsMainEl = document.getElementById('accounts-main');
  const accountsCtxBtn = document.getElementById('accounts-ctx-btn');
  const accountsCtxMenu = document.getElementById('accounts-ctx-menu');
  const accountsDeleteModal = document.getElementById('accounts-delete-modal');
  const accountsDeleteModalMsg = document.getElementById('accounts-delete-modal-msg');
  const accountsDeleteConfirmBtn = document.getElementById('accounts-delete-confirm-btn');
  const accountsDeleteCancelBtn = document.getElementById('accounts-delete-cancel-btn');
  const accountsLockedModal = document.getElementById('accounts-locked-modal');
  const accountsLockedOkBtn = document.getElementById('accounts-locked-ok-btn');
  let accountsReorderMode = false;
  let accountsEditorDirtyForCurrent = false;
  const accountsOverviewRefreshBtn = document.getElementById('accounts-overview-refresh-btn');
  const accountsOverviewRefreshAllBtn = document.getElementById('accounts-overview-refresh-all-btn');
  const accountsOverviewSummaryEl = document.getElementById('accounts-overview-summary');
  const accountsOverviewStatusEl = document.getElementById('accounts-overview-status');
  const accountsOverviewTabsEl = document.getElementById('accounts-overview-tabs');
  const accountsOverviewLayoutEl = document.getElementById('accounts-overview-layout');
  const accountsCharactersListEl = document.getElementById('accounts-characters-list');
  const accountsCharactersEmptyEl = document.getElementById('accounts-characters-empty');
  const accountsCharacterDetailEl = document.getElementById('accounts-character-detail');
  const logsList = document.getElementById('logs-list');
  const logsEmpty = document.getElementById('logs-empty');
  const logsClearBtn = document.getElementById('logs-clear-btn');
  const filterSearch = document.getElementById('filter-search');
  const filterCS = document.getElementById('filter-cs');
  const filterSC = document.getElementById('filter-sc');
  const filterHideNoisy = document.getElementById('filter-hide-noisy');
  const typeFilters = document.getElementById('packet-type-filters');
  const snifferDrawer = document.getElementById('sniffer-drawer');
  const snifferBadge = document.getElementById('sniffer-badge');

  /**
   * Pre-populate Packet Sniffer type chips from packet-definitions + packet-lab-name-only
   * (/api/lab/definitions). Idempotent per packet name. Admin only.
   */
  function seedSnifferPacketTypeChipsFromDefs() {
    if (!adminMode || !packetSnifferVisible) return;
    fetch('/api/lab/definitions')
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (!data || !Array.isArray(data.packets)) return;
        var uniq = [];
        var s = new Set();
        for (var i = 0; i < data.packets.length; i++) {
          var p = data.packets[i];
          var n = p && p.name;
          if (typeof n !== 'string' || !n || s.has(n)) continue;
          s.add(n);
          uniq.push(n);
        }
        uniq.sort(function (a, b) { return a.localeCompare(b); });
        for (var j = 0; j < uniq.length; j++) {
          addTypeChip(uniq[j]);
        }
        if (snifferExpanded) refreshTable();
      })
      .catch(function () { /* ignore */ });
  }

  const settingsOverlay = document.getElementById('settings-overlay');
  const settingsTabsEl = document.getElementById('settings-tabs');
  const devModeToggle = document.getElementById('setting-dev-mode');
  const adminModeToggle = document.getElementById('setting-admin-mode');
  const singleClientOnlyToggle = document.getElementById('setting-single-client-only');
  // Sign-out button now lives in the account popup (wired below)
  const themeSelect = document.getElementById('setting-theme-select');
  const langSelect = document.getElementById('setting-language-select');

  const serverSelect = document.getElementById('server-select');
  const ipInput = document.getElementById('ip-input');
  const ipConnectBtn = document.getElementById('ip-connect-btn');
  const damageEmpty = document.getElementById('damage-empty');
  const damageSettingsBar = document.getElementById('damage-settings-bar');
  const damageSplitEl = document.getElementById('damage-split');
  const damageRunListEl = document.getElementById('damage-run-list');
  const damageTargetListEl = document.getElementById('damage-target-list');
  const damagePlayerBreakdownEl = document.getElementById('damage-player-breakdown');
  const damagePlayerDetailEl = document.getElementById('damage-player-detail');
  const damagePlayerDetailEmptyEl = document.getElementById('damage-player-detail-empty');
  const damagePlayerModalOverlayEl = document.getElementById('damage-player-modal-overlay');
  const damagePlayerModalCloseBtn = document.getElementById('damage-player-modal-close');
  const damagePlayerEmptyEl = document.getElementById('damage-player-empty');
  const damagePlayerTitleEl = document.getElementById('damage-player-title');
  const damageFilterEl = document.getElementById('damage-filter');
  const damageSortEl = document.getElementById('damage-sort');
  const damageContextEl = document.getElementById('damage-context');
  const launchGameBtn = document.getElementById('btn-launch-game');
  const disconnectOverlay = document.getElementById('disconnect-overlay');
  const overlayLoginBtn = document.getElementById('overlay-login-btn');
  const rotmgPathInput = document.getElementById('setting-rotmg-path');
  const rotmgPathDesc = document.getElementById('rotmg-path-desc');
  const saveRotmgPathBtn = document.getElementById('btn-save-rotmg-path');
  const resetRotmgPathBtn = document.getElementById('btn-reset-rotmg-path');
  const pluginConfigSelect = document.getElementById('setting-plugin-config-select');
  const pluginConfigNameInput = document.getElementById('setting-plugin-config-name');
  const pluginConfigStatus = document.getElementById('plugin-config-status');
  const pluginConfigRefreshBtn = document.getElementById('btn-plugin-config-refresh');
  const pluginConfigLoadBtn = document.getElementById('btn-plugin-config-load');
  const pluginConfigSaveBtn = document.getElementById('btn-plugin-config-save');
  const showGearStatBonusesToggle = document.getElementById('setting-show-gear-stat-bonuses');
  const showServerPingToggle = document.getElementById('setting-show-server-ping');
  const showAccountEmailsToggle = document.getElementById('setting-show-account-emails');
  const showSingleAccountDockToggle = document.getElementById('setting-show-single-account-dock');
  const telemetryEnabledToggle = document.getElementById('setting-telemetry-enabled');
  const nearbyRefreshBtn = document.getElementById('nearby-refresh-btn');
  const nearbySortEl = document.getElementById('nearby-sort');
  const nearbyFilterEl = document.getElementById('nearby-filter');
  const nearbyTbody = document.getElementById('nearby-tbody');
  const nearbyEmptyEl = document.getElementById('nearby-empty');
  const nearbyDebugTreeEl = document.getElementById('nearby-debug-tree');
  const nearbyDebugEmptyEl = document.getElementById('nearby-debug-empty');
  const nearbyDebugSubtitleEl = document.getElementById('nearby-debug-subtitle');
  const overlayLoginError = document.getElementById('overlay-login-error');
  const overlayEmailInput = document.getElementById('overlay-email');
  const overlayPasswordInput = document.getElementById('overlay-password');
  const overlayPasswordToggleBtn = document.getElementById('overlay-password-toggle');
  const itemDetailOverlay = document.getElementById('item-detail-overlay');
  const itemDetailCloseBtn = document.getElementById('item-detail-close');
  const itemDetailTitleEl = document.getElementById('item-detail-title');
  const itemDetailSubtitleEl = document.getElementById('item-detail-subtitle');
  const itemDetailSpriteEl = document.getElementById('item-detail-sprite');
  const itemDetailEnchantsEl = document.getElementById('item-detail-enchants');
  const itemDetailLocationsSectionEl = document.getElementById('item-detail-locations-section');
  const itemDetailLocationsEl = document.getElementById('item-detail-locations');

  function formatDashboardDate(iso) {
    if (!iso) return '—';
    try {
      return new Date(iso).toLocaleDateString();
    } catch (e) {
      return '—';
    }
  }

  function formatGemBalanceDisplay(n) {
    var x = Number(n);
    if (!isFinite(x)) return '0';
    if (Math.floor(x) === x) return String(Math.floor(x));
    return String(x);
  }

  /** Last known gem balance from the API; null until first successful fetch. */
  var lastKnownGemBalance = null;

  /** 1 gem = 1 US cent (100 gems = $1). Returns e.g. "$1.00" or "—". */
  function formatUsdFromGemCount(gemCount) {
    var n = Number(gemCount);
    if (!isFinite(n) || n < 0) return '—';
    var dollars = n / 100;
    try {
      return dollars.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
    } catch (e) {
      return '$' + dollars.toFixed(2);
    }
  }

  /**
   * @param {{ gems?: number }} [opts] - If gems is a positive integer, appends ?gems= (gem count) to the payment URL.
   */
  /**
   * @param {{ gems?: number, method?: string }} [opts]
   * gems appends ?gems=N, method appends &method=X to the payment URL.
   */
  function openRealmEnginePaymentPage(opts) {
    opts = opts || {};
    var url = REALM_ENGINE_WEB_BASE + '/payment';
    var params = [];
    var g = opts.gems;
    if (g != null && g !== '') {
      var n = parseInt(String(g), 10);
      if (isFinite(n) && n >= 1) params.push('gems=' + encodeURIComponent(String(n)));
    }
    if (opts.method) params.push('method=' + encodeURIComponent(String(opts.method)));
    if (params.length) url += '?' + params.join('&');
    try {
      window.open(url, '_blank', 'noopener,noreferrer');
    } catch (e) {
      window.location.href = url;
    }
  }

  function getPurchaseModalGemQty() {
    var input = document.getElementById('purchase-modal-gem-qty');
    if (!input) return NaN;
    return parseInt(String(input.value).trim(), 10);
  }

  function updatePurchaseModalTotal() {
    var totalEl = document.getElementById('purchase-modal-total');
    var errEl = document.getElementById('purchase-modal-qty-error');
    if (errEl) { errEl.textContent = ''; errEl.classList.add('hidden'); }
    var n = getPurchaseModalGemQty();
    if (!totalEl) return;
    if (!isFinite(n) || n < 1) {
      totalEl.innerHTML = '= <strong>—</strong>';
      return;
    }
    if (n < 50) {
      totalEl.innerHTML = '= <strong class="purchase-qty-warn">min. 50 gems</strong>';
      return;
    }
    totalEl.innerHTML = '= <strong>' + formatUsdFromGemCount(n) + '</strong>';
    // Highlight matching quick button
    document.querySelectorAll('.purchase-quick-btn').forEach(function (btn) {
      btn.classList.toggle('active', parseInt(btn.getAttribute('data-quick-gems') || '0', 10) === n);
    });
  }

  function validatePurchaseModalQty() {
    var errEl = document.getElementById('purchase-modal-qty-error');
    var n = getPurchaseModalGemQty();
    if (!isFinite(n) || n < 50) {
      if (errEl) { errEl.textContent = 'Enter a whole number of gems (minimum 50).'; errEl.classList.remove('hidden'); }
      return null;
    }
    if (n > 999999) {
      if (errEl) { errEl.textContent = 'Maximum 999,999 gems per purchase.'; errEl.classList.remove('hidden'); }
      return null;
    }
    if (errEl) { errEl.textContent = ''; errEl.classList.add('hidden'); }
    return n;
  }

  function purchaseModalCheckout() {
    var n = validatePurchaseModalQty();
    if (n == null) return;
    // Move to step 2 — payment method
    var step1 = document.getElementById('purchase-step-qty');
    var step2 = document.getElementById('purchase-step-method');
    var summary = document.getElementById('purchase-method-summary');
    if (summary) summary.innerHTML = String(n) + '<span class="market-gem-label">G</span> (' + formatUsdFromGemCount(n) + ')';
    // Clear any previous selection
    document.querySelectorAll('.purchase-method-btn').forEach(function (b) { b.classList.remove('selected'); });
    if (step1) step1.classList.add('hidden');
    if (step2) step2.classList.remove('hidden');
  }

  function purchaseGoBack() {
    var step1 = document.getElementById('purchase-step-qty');
    var step2 = document.getElementById('purchase-step-method');
    if (step2) step2.classList.add('hidden');
    if (step1) step1.classList.remove('hidden');
    // Collapse any open payment category panels
    document.querySelectorAll('.pay-cat-options').forEach(function (p) { p.classList.add('hidden'); });
    document.querySelectorAll('.pay-cat-row--expand').forEach(function (b) { b.setAttribute('aria-expanded', 'false'); });
  }

  var CRYPTO_CURRENCIES = { btc: true, eth: true, usdt: true, ltc: true, xmr: true };

  function purchaseWithMethod(method) {
    var n = validatePurchaseModalQty();
    if (n === null) return;
    if (!dashboardLoggedIn || !accessToken) { closePurchaseModal(); return; }

    if (method === 'stripe_card') {
      var btn = document.querySelector('[data-method="stripe_card"]');
      if (btn) btn.textContent = 'Opening…';
      fetch('/api/payments/stripe/create-checkout-dynamic', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + accessToken, 'Content-Type': 'application/json' },
        body: JSON.stringify({ gems: n }),
      })
        .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, data: d }; }); })
        .then(function (result) {
          closePurchaseModal();
          if (!result.ok || !result.data.checkout_url) {
            alert('Could not start Stripe checkout: ' + (result.data.detail || 'unknown error'));
            return;
          }
          try { window.open(result.data.checkout_url, '_blank', 'noopener,noreferrer'); }
          catch (e) { window.location.href = result.data.checkout_url; }
        })
        .catch(function () { closePurchaseModal(); alert('Network error starting card checkout. Try again.'); })
        .finally(function () { if (btn) btn.textContent = 'Pay with Card'; });
      return;
    }

    if (CRYPTO_CURRENCIES[method]) {
      var cryptoBtn = document.querySelector('[data-method="' + method + '"]');
      var origText = cryptoBtn ? cryptoBtn.textContent : '';
      if (cryptoBtn) { cryptoBtn.textContent = 'Opening…'; cryptoBtn.disabled = true; }
      fetch('/api/payments/create-bundle-dynamic', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + accessToken, 'Content-Type': 'application/json' },
        body: JSON.stringify({ gems: n, pay_currency: method }),
      })
        .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, data: d }; }); })
        .then(function (result) {
          closePurchaseModal();
          if (!result.ok || !result.data.invoice_url) {
            alert('Could not create crypto invoice: ' + (result.data.detail || 'unknown error'));
            return;
          }
          try { window.open(result.data.invoice_url, '_blank', 'noopener,noreferrer'); }
          catch (e) { window.location.href = result.data.invoice_url; }
        })
        .catch(function () { closePurchaseModal(); alert('Network error starting crypto checkout. Try again.'); })
        .finally(function () {
          if (cryptoBtn) { cryptoBtn.textContent = origText; cryptoBtn.disabled = false; }
        });
      return;
    }

    closePurchaseModal();
    openRealmEnginePaymentPage({ gems: n, method: method });
  }

  function refreshAccountBillingFromApi() {
    var gemVal   = document.getElementById('account-popup-gem-balance');
    var gemNext  = document.getElementById('account-popup-gem-next-deduction');
    var gemBadge = document.getElementById('account-popup-gem-badge');
    var planEl   = document.getElementById('account-popup-plan-name');
    var stEl     = document.getElementById('account-popup-plan-status');
    var exEl     = document.getElementById('account-popup-plan-expires');
    var tbGems   = document.getElementById('titlebar-gems');
    var tbPlan   = document.getElementById('titlebar-plan');
    var macGems  = document.getElementById('multi-account-gems');
    var macPlan  = document.getElementById('multi-account-plan');

    function setSidebarBilling(gemsText, planText) {
      if (tbGems) tbGems.textContent = gemsText;
      if (tbPlan) tbPlan.textContent = planText;
      if (macGems) macGems.textContent = gemsText;
      if (macPlan) macPlan.textContent = planText;
    }

    function resetBillingUi() {
      if (gemVal)  gemVal.textContent = '0';
      if (gemBadge) { gemBadge.textContent = t('accountPopup.gemStatus.inactive'); gemBadge.classList.add('acct-badge--inactive'); gemBadge.classList.remove('acct-badge--active'); }
      if (gemNext) { gemNext.textContent = ''; gemNext.classList.add('hidden'); }
      if (planEl)  planEl.textContent = t('accountPopup.plan.free');
      if (stEl)    { stEl.textContent = ''; stEl.classList.add('hidden'); }
      if (exEl)    { exEl.textContent = ''; exEl.classList.add('hidden'); }
      setSidebarBilling('0', t('accountPopup.plan.free'));
    }

    if (!dashboardLoggedIn || !accessToken) {
      resetBillingUi();
      dashboardSubscriptionTier = 'Free';
      updateDashboardAvailabilityUi();
      return;
    }

    var headers = { Authorization: 'Bearer ' + accessToken };
    Promise.all([
      fetch('/api/payments/gems/status', { headers: headers }).then(function (r) {
        return r.json().catch(function () { return null; }).then(function (d) { return { ok: r.ok, data: d }; });
      }),
      fetch('/api/payments/subscription', { headers: headers }).then(function (r) {
        return r.json().catch(function () { return null; }).then(function (d) { return { ok: r.ok, data: d }; });
      }),
    ])
      .then(function (results) {
        var gems = results[0];
        var sub  = results[1];

        var gemsDisplay = '0';
        if (gems.ok && gems.data && typeof gems.data === 'object') {
          gemsDisplay = formatGemBalanceDisplay(gems.data.gem_balance);
          lastKnownGemBalance = isFinite(Number(gems.data.gem_balance)) ? Number(gems.data.gem_balance) : null;
          if (gemVal) gemVal.textContent = gemsDisplay;
          if (gemBadge) {
            var hasGems = lastKnownGemBalance !== null && lastKnownGemBalance > 0;
            gemBadge.textContent = hasGems ? t('accountPopup.gemStatus.active') : t('accountPopup.gemStatus.inactive');
            gemBadge.classList.toggle('acct-badge--active', hasGems);
            gemBadge.classList.toggle('acct-badge--inactive', !hasGems);
          }
          if (gemNext) {
            if (gems.data.next_deduction_at) {
              gemNext.textContent = tr('accountPopup.nextDeduction', { date: formatDashboardDate(gems.data.next_deduction_at) });
              gemNext.classList.remove('hidden');
            } else {
              gemNext.textContent = '';
              gemNext.classList.add('hidden');
            }
          }
        } else {
          if (gemVal)  gemVal.textContent = '0';
          if (gemBadge) { gemBadge.textContent = t('accountPopup.gemStatus.inactive'); gemBadge.classList.add('acct-badge--inactive'); gemBadge.classList.remove('acct-badge--active'); }
          if (gemNext) { gemNext.textContent = ''; gemNext.classList.add('hidden'); }
        }

        var planDisplay = t('accountPopup.plan.free');
        if (sub.ok && sub.data && typeof sub.data === 'object' && sub.data.plan_name) {
          planDisplay = String(sub.data.plan_name);
          if (planEl) planEl.textContent = planDisplay;
          if (stEl) {
            stEl.textContent = String(sub.data.status || '');
            stEl.classList.toggle('hidden', !sub.data.status);
          }
          if (exEl && sub.data.expires_at) {
            exEl.textContent = tr('accountPopup.renews', { date: formatDashboardDate(sub.data.expires_at) });
            exEl.classList.remove('hidden');
          } else if (exEl) {
            exEl.textContent = '';
            exEl.classList.add('hidden');
          }
          dashboardSubscriptionTier = planDisplay;
        } else {
          if (planEl) planEl.textContent = t('accountPopup.plan.free');
          if (stEl)   { stEl.textContent = ''; stEl.classList.add('hidden'); }
          if (exEl)   { exEl.textContent = ''; exEl.classList.add('hidden'); }
          dashboardSubscriptionTier = 'Free';
        }

        setSidebarBilling(gemsDisplay, planDisplay);
        updateDashboardAvailabilityUi();
        if (dashboardLoggedIn) applyAccountPermissions();
      })
      .catch(function () {
        resetBillingUi();
        dashboardSubscriptionTier = 'Free';
        updateDashboardAvailabilityUi();
      });
  }

  function openPurchaseModal() {
    trackEvent('gem_buy_open');
    var overlay = document.getElementById('purchase-modal-overlay');
    if (!overlay) { openRealmEnginePaymentPage(); return; }

    // Always start on step 1; collapse any open payment category panels
    var step1 = document.getElementById('purchase-step-qty');
    var step2 = document.getElementById('purchase-step-method');
    if (step1) step1.classList.remove('hidden');
    if (step2) step2.classList.add('hidden');
    document.querySelectorAll('.pay-cat-options').forEach(function (p) { p.classList.add('hidden'); });
    document.querySelectorAll('.pay-cat-row--expand').forEach(function (b) { b.setAttribute('aria-expanded', 'false'); });

    var errEl = document.getElementById('purchase-modal-qty-error');
    if (errEl) { errEl.textContent = ''; errEl.classList.add('hidden'); }
    updatePurchaseModalTotal();

    overlay.classList.remove('hidden');
    overlay.setAttribute('aria-hidden', 'false');
    var qty = document.getElementById('purchase-modal-gem-qty');
    if (qty) { try { qty.focus(); qty.select(); } catch (e) {} }
  }

  function closePurchaseModal() {
    var el = document.getElementById('purchase-modal-overlay');
    if (!el) return;
    el.classList.add('hidden');
    el.setAttribute('aria-hidden', 'true');
  }

  function closePlanModal() {
    var el = document.getElementById('plan-modal-overlay');
    if (!el) return;
    el.classList.add('hidden');
    el.setAttribute('aria-hidden', 'true');
  }

  function setPlanModalMsg(text, isError) {
    var el = document.getElementById('plan-modal-msg');
    if (!el) return;
    if (!text) { el.textContent = ''; el.classList.add('hidden'); return; }
    el.textContent = text;
    el.className = 'plan-modal-msg' + (isError ? ' plan-modal-msg--error' : ' plan-modal-msg--ok');
    el.classList.remove('hidden');
  }

  // Plans are fixed — no need to fetch from the server on modal open.
  // Only subscriptions (which plans the user has active) are fetched.
  // Plan prices: paid in gems, deducted monthly from balance (preload model).
  //   Dodge      = $10/mo =  1,000 G/mo
  //   Developer  = $20/mo =  2,000 G/mo
  // Rate: 100 G = $1 USD. See formatUsdFromGemCount.
  // Subscriptions unlock plugins they gate (auto-loot, auto-pot, etc.) and
  // discount consumables (potions). They do NOT discount script purchases —
  // scripts always cost gems at full price regardless of tier.
  var CLIENT_PLANS = [
    {
      name: 'Dodge',
      price_usd: 10.0,
      description: 'Advanced dodge automation and survival tooling.',
      features: [
        'Autododge (AOE, tracking, speed-aware)',
        'Godfarming script',
        'Safe-walk plugin',
        'Discount on potion purchases',
      ],
    },
    {
      name: 'Developer',
      price_usd: 8.0,
      badge: 'Pro',
      description: 'Full SDK access and developer tooling.',
      features: [
        'RealmEngine SDK bridge access',
        'Custom plugin development',
        'Script hosting & management',
        'Developer API access',
        'Discount on potion purchases',
      ],
    },
  ];

  function renderPlanModalBody(activeSubs) {
    var body = document.getElementById('plan-modal-body');
    if (!body) return;
    var gemBalance = lastKnownGemBalance;

    // Match active subs by plan name (case-insensitive)
    var activeSubsByName = {};
    (activeSubs || []).forEach(function (s) {
      if (s.plan_name) activeSubsByName[s.plan_name.toLowerCase()] = s;
    });

    var html = '';

    // Free tier card (always shown)
    html += '<div class="plan-card plan-card--free">';
    html += '<div class="plan-card-head"><span class="plan-card-name">Free</span>';
    html += '<span class="plan-card-price"><span class="plan-card-price-num">0</span><span class="market-gem-label">G</span><span class="plan-card-per">/mo</span></span>';
    html += '<span class="plan-card-badge plan-card-badge--current">Always included</span></div>';
    html += '<p class="plan-card-desc">Core bot features — no subscription required.</p>';
    html += '<ul class="plan-card-features">';
    html += '<li>Autoaim (smart target filtering)</li>';
    html += '<li>Autonexus (configurable HP &amp; status thresholds)</li>';
    html += '<li>Autoloot (potion pickup)</li>';
    html += '<li>Damage Sniffer</li>';
    html += '<li>Game Wiki</li>';
    html += '</ul>';
    html += '</div>';

    CLIENT_PLANS.forEach(function (plan) {
      var planNameLower = plan.name.toLowerCase();
      var gemCost = Math.round(plan.price_usd * 100);
      var activeSub = activeSubsByName[planNameLower];
      var isActive = !!activeSub;

      var dollarStr = '$' + (plan.price_usd % 1 === 0 ? plan.price_usd.toFixed(0) : plan.price_usd.toFixed(2));

      html += '<div class="plan-card' + (isActive ? ' plan-card--active' : '') + (plan.badge ? ' plan-card--highlight' : '') + '">';
      html += '<div class="plan-card-head">';
      html += '<span class="plan-card-name">' + escapeHtml(plan.name) + '</span>';
      html += '<span class="plan-card-price"><span class="plan-card-price-num">' + gemCost + '</span><span class="market-gem-label">G</span><span class="plan-card-per">/mo</span></span>';
      if (isActive) {
        html += '<span class="plan-card-badge plan-card-badge--active">Active</span>';
      } else if (plan.badge) {
        html += '<span class="plan-card-badge plan-card-badge--highlight">' + escapeHtml(plan.badge) + '</span>';
      }
      html += '</div>';

      html += '<p class="plan-card-desc">' + escapeHtml(plan.description) + ' <em>' + dollarStr + '/mo</em></p>';
      if (plan.features && plan.features.length) {
        html += '<ul class="plan-card-features">';
        plan.features.forEach(function (f) { html += '<li>' + escapeHtml(f) + '</li>'; });
        html += '</ul>';
      }

      if (isActive) {
        var expires = activeSub.expires_at ? new Date(activeSub.expires_at).toLocaleDateString() : '—';
        var autopay = activeSub.autopay;
        html += '<div class="plan-card-status-row">';
        html += '<span class="plan-card-expires">Active until ' + escapeHtml(expires) + '</span>';
        if (autopay) {
          html += '<button type="button" class="plan-card-cancel-btn" data-cancel-sub-id="' + escapeHtml(activeSub.id) + '">Cancel autopay</button>';
        } else {
          html += '<span class="plan-card-no-autopay">Autopay off — expires ' + escapeHtml(expires) + '</span>';
        }
        html += '</div>';
      } else {
        var canAfford = gemBalance !== null && gemBalance >= gemCost;
        var insufficientNote = (gemBalance !== null && !canAfford)
          ? ' <span class="plan-card-afford-note">Need ' + gemCost + '<span class="market-gem-label">G</span> (you have ' + Math.floor(gemBalance) + '<span class="market-gem-label">G</span>)</span>'
          : '';
        html += '<button type="button" class="plan-card-buy-btn setting-btn'
          + (canAfford ? '' : ' plan-card-buy-btn--low')
          + '" data-buy-plan-name="' + escapeHtml(plan.name) + '" data-buy-gem-cost="' + gemCost + '">'
          + 'Subscribe · ' + gemCost + '<span class="market-gem-label">G</span>/mo</button>' + insufficientNote;
      }

      html += '</div>';
    });

    body.innerHTML = html;

    // Wire buy buttons — plan name is stored; ID is lazily resolved on click
    body.querySelectorAll('[data-buy-plan-name]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var planName = btn.getAttribute('data-buy-plan-name');
        var cost = parseInt(btn.getAttribute('data-buy-gem-cost') || '0', 10);
        doPlanGemPurchase(planName, cost);
      });
    });

    // Wire cancel buttons
    body.querySelectorAll('[data-cancel-sub-id]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var subId = btn.getAttribute('data-cancel-sub-id');
        doCancelAutopay(subId);
      });
    });
  }

  function fetchActiveSubs() {
    if (!dashboardLoggedIn || !accessToken) return Promise.resolve([]);
    return fetch('/api/payments/subscriptions', {
      headers: { Authorization: 'Bearer ' + accessToken },
    }).then(function (r) { return r.json().catch(function () { return []; }); });
  }

  function openPlanModal() {
    trackEvent('plan_modal_open');
    var overlay = document.getElementById('plan-modal-overlay');
    if (!overlay) { openRealmEnginePaymentPage(); return; }

    var body = document.getElementById('plan-modal-body');
    setPlanModalMsg('', false);

    overlay.classList.remove('hidden');
    overlay.setAttribute('aria-hidden', 'false');

    if (!dashboardLoggedIn || !accessToken) {
      if (body) body.innerHTML = '<p class="plan-modal-loading">Sign in to manage your plan.</p>';
      return;
    }

    // Show plan cards immediately with hardcoded plans; subscriptions load fast
    renderPlanModalBody([]);
    fetchActiveSubs().then(function (subs) {
      renderPlanModalBody(subs);
    }).catch(function () {
      if (body) body.innerHTML = '<p class="plan-modal-loading">Failed to load subscription status.</p>';
    });
  }

  function doPlanGemPurchase(planName, gemCost) {
    if (!dashboardLoggedIn || !accessToken) {
      setPlanModalMsg('You must be signed in to purchase.', true);
      return;
    }
    setPlanModalMsg('Processing…', false);
    var headers = { Authorization: 'Bearer ' + accessToken };
    // Lazily fetch plan list only now (to get the server-side UUID for this plan name)
    fetch('/api/payments/plans', { headers: headers })
      .then(function (r) { return r.json().catch(function () { return []; }); })
      .then(function (plans) {
        var match = (plans || []).find(function (p) {
          return p.name && p.name.toLowerCase() === (planName || '').toLowerCase();
        });
        if (!match) {
          setPlanModalMsg('Plan not found on server. Contact support.', true);
          return;
        }
        return fetch('/api/payments/subscription/gem-purchase', {
          method: 'POST',
          headers: Object.assign({}, headers, { 'Content-Type': 'application/json' }),
          body: JSON.stringify({ plan_id: match.id }),
        })
          .then(function (r) {
            return r.json().then(function (d) { return { ok: r.ok, data: d }; });
          })
          .then(function (result) {
            if (!result.ok) {
              setPlanModalMsg(result.data.detail || 'Purchase failed.', true);
              return;
            }
            var charged = result.data.gems_charged;
            var newBal = result.data.gem_balance_after;
            setPlanModalMsg('Subscribed! Charged ' + charged + 'G. New balance: ' + Math.floor(newBal) + 'G.', false);
            refreshAccountBillingFromApi();
            fetchActiveSubs().then(function (subs) { renderPlanModalBody(subs); });
          });
      })
      .catch(function () {
        setPlanModalMsg('Network error. Try again.', true);
      });
  }

  function doCancelAutopay(subscriptionId) {
    if (!dashboardLoggedIn || !accessToken) return;
    setPlanModalMsg('', false);
    fetch('/api/payments/subscription/' + encodeURIComponent(subscriptionId) + '/cancel-autopay', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + accessToken },
    })
      .then(function (r) {
        return r.json().then(function (d) { return { ok: r.ok, data: d }; });
      })
      .then(function (result) {
        if (!result.ok) {
          setPlanModalMsg(result.data.detail || 'Failed to cancel autopay.', true);
          return;
        }
        var expires = result.data.expires_at ? new Date(result.data.expires_at).toLocaleDateString() : '—';
        setPlanModalMsg('Autopay cancelled. Plan stays active until ' + expires + '.', false);
        fetchActiveSubs().then(function (subs) { renderPlanModalBody(subs); });
      })
      .catch(function () {
        setPlanModalMsg('Network error. Try again.', true);
      });
  }

  function renderAccountSettings() {
    var emailEl = document.getElementById('account-popup-email');
    var memberEl = document.getElementById('account-popup-member-since');
    if (emailEl) {
      emailEl.textContent = (dashboardUser && dashboardUser.email) || (dashboardLoggedIn ? '—' : t('accountPopup.notSignedIn'));
    }
    if (memberEl) {
      memberEl.textContent =
        dashboardUser && dashboardUser.created_at ? formatDashboardDate(dashboardUser.created_at) : '—';
    }
    refreshAccountBillingFromApi();
  }

  /* ── Account popup open / close ──
     Legacy account popup is gone — both functions now route to the Settings
     tab. Kept under their original names so existing call sites (e.g. the
     sidebar account button handler) keep working without an edit. */
  function openAccountPopup() {
    renderAccountSettings();
    activateContentTab('settings');
  }

  function closeAccountPopup() {
    // No-op: the settings tab stays open until the user navigates away.
    var overlay = document.getElementById('account-popup-overlay');
    if (!overlay) return;
    overlay.classList.add('hidden');
    overlay.setAttribute('aria-hidden', 'true');
  }

  // Initialize dev mode
  function applyDevMode() {
    document.body.classList.toggle('dev-mode', devMode);
    devModeToggle.checked = devMode;
    if (!devMode) {
      if (activeTab === 'api' || activeTab === 'objects' || activeTab === 'tilemap' || activeTab === 'nearby' || activeTab === 'scripts') {
        var fallbackBtn = document.querySelector('.content-tab[data-tab="plugins"]');
        if (fallbackBtn) fallbackBtn.click();
      }
    }
  }
  applyDevMode();

  function applyPacketSnifferVisibility() {
    document.body.classList.toggle('packet-sniffer-hidden', !packetSnifferVisible);
    var pktToggle = document.getElementById('setting-packet-sniffer-visible');
    if (pktToggle) pktToggle.checked = packetSnifferVisible;
    if (!packetSnifferVisible) {
      snifferDrawer.classList.remove('expanded');
      snifferDrawer.classList.add('collapsed');
      snifferExpanded = false;
      snifferPacketsSinceCollapse = 0;
      snifferBadge.classList.add('hidden');
    }
  }

  function applyAdminMode() {
    // Admin dev: __ADMIN_BUILD__ guard removed — toggle is always enabled.
    document.body.classList.toggle('admin-mode', adminMode);
    if (adminModeToggle) {
      adminModeToggle.checked = adminMode;
      adminModeToggle.disabled = false;
      var adminRow = adminModeToggle.closest('.settings-row');
      if (adminRow) adminRow.classList.toggle('settings-row--locked', false);
    }
    if (!adminMode) {
      if (activeTab === 'logs' || activeTab === 'packet-lab' || activeTab === 'market' || activeTab === 'mem-helper' || activeTab === 'telemetry') {
        var fallbackBtn = document.querySelector('.content-tab[data-tab="plugins"]');
        if (fallbackBtn) fallbackBtn.click();
      }
      snifferDrawer.classList.remove('expanded');
      snifferDrawer.classList.add('collapsed');
      snifferExpanded = false;
      snifferPacketsSinceCollapse = 0;
      snifferBadge.classList.add('hidden');
    } else if (packetSnifferVisible) {
      seedSnifferPacketTypeChipsFromDefs();
    }
    applyPacketSnifferVisibility();
  }
  applyAdminMode();

  /**
   * View-as preview (admin debug). Swaps activePlanNames + adminMode for a
   * preset, toggles the banner + body class, and re-renders affected tabs.
   * Pass null/falsy to reset to the real account state.
   */
  function applyViewAsOverride() {
    if (viewAsOverride) {
      activePlanNames = new Set(viewAsOverride.plans);
      adminMode = !!viewAsOverride.isAdmin;
    } else {
      activePlanNames = new Set(_realActivePlans);
      adminMode = _realAdminMode;
    }
    document.body.classList.toggle('admin-mode', adminMode);
    document.body.classList.toggle('view-as-active', !!viewAsOverride);

    var banner    = document.getElementById('view-as-banner');
    var bannerLbl = document.getElementById('view-as-banner-label');
    if (banner) banner.style.display = viewAsOverride ? '' : 'none';
    if (bannerLbl) bannerLbl.textContent = viewAsOverride ? viewAsOverride.label : '—';

    // Re-render the tabs whose UI depends on plan/admin state.
    if (typeof renderPlugins === 'function' && Array.isArray(allPluginsData)) renderPlugins(allPluginsData);
    if (typeof renderHomeTab === 'function') renderHomeTab();
    if (typeof renderPremiumTab === 'function') renderPremiumTab();
    // applyAdminMode handles the admin-only tab visibility + packet sniffer.
    applyPacketSnifferVisibility();
  }

  // ─── Navbar drag-and-drop reorder + tab visibility ─────────────
  var contentTabsEl = document.getElementById('content-tabs');
  var navTabVisListEl = document.getElementById('navbar-tabs-visibility-list');

  /** All tab names in their original DOM order (source of truth for defaults) */
  var DEFAULT_TAB_ORDER = Array.from(contentTabsEl.querySelectorAll('.content-tab')).map(function (b) { return b.dataset.tab; });

  function getTabLabel(tabName) {
    var btn = contentTabsEl.querySelector('.content-tab[data-tab="' + tabName + '"]');
    return btn ? btn.textContent.trim() : tabName;
  }

  /** Persist order to localStorage */
  function saveNavbarTabOrder(order) {
    navbarTabOrder = order;
    localStorage.setItem('navbarTabOrder', JSON.stringify(order));
  }
  function saveNavbarHiddenTabs() {
    localStorage.setItem('navbarHiddenTabs', JSON.stringify(Array.from(navbarHiddenTabs)));
  }

  /** Reorder DOM buttons to match navbarTabOrder, apply hidden class */
  function applyNavbarLayout() {
    var order = navbarTabOrder || DEFAULT_TAB_ORDER;
    // Ensure any new tabs not in saved order get appended
    DEFAULT_TAB_ORDER.forEach(function (t) { if (order.indexOf(t) === -1) order.push(t); });
    // Remove tabs from order that no longer exist
    order = order.filter(function (t) { return DEFAULT_TAB_ORDER.indexOf(t) !== -1; });

    var buttons = {};
    contentTabsEl.querySelectorAll('.content-tab').forEach(function (b) { buttons[b.dataset.tab] = b; });

    order.forEach(function (tabName) {
      var btn = buttons[tabName];
      if (!btn) return;
      contentTabsEl.appendChild(btn); // moves existing element to end (in order)
      btn.setAttribute('draggable', 'true');
      btn.classList.toggle('tab-hidden', navbarHiddenTabs.has(tabName));
    });

    // Keep the Developer section label immediately above the API tab
    var devLabel = document.getElementById('content-tabs-dev-label');
    if (devLabel && buttons['api']) {
      try {
        contentTabsEl.insertBefore(devLabel, buttons['api']);
      } catch (_e) { /* ignore */ }
    }

    // If the currently active tab was hidden, switch to first visible
    if (navbarHiddenTabs.has(activeTab)) {
      var firstVisible = order.find(function (t) {
        var b = buttons[t];
        return b && !navbarHiddenTabs.has(t) && !b.classList.contains('tab-hidden');
      });
      if (firstVisible) {
        var fb = contentTabsEl.querySelector('.content-tab[data-tab="' + firstVisible + '"]');
        if (fb) fb.click();
      }
    }
  }

  /** Tabs restricted to dev/admin — not shown in user-facing settings */
  var RESTRICTED_TABS = new Set(['api', 'scripts', 'packet-lab', 'nearby', 'tilemap', 'objects', 'game-wiki', 'logs', 'multibox', 'mem-helper']);

  /** Render the settings list of tab toggles */
  function renderNavbarTabSettings() {
    if (!navTabVisListEl) return;
    var order = navbarTabOrder || DEFAULT_TAB_ORDER;
    // Ensure all tabs present
    DEFAULT_TAB_ORDER.forEach(function (t) { if (order.indexOf(t) === -1) order.push(t); });
    order = order.filter(function (t) { return DEFAULT_TAB_ORDER.indexOf(t) !== -1; });

    navTabVisListEl.innerHTML = '';
    order.forEach(function (tabName) {
      // Skip dev/admin-only tabs — they're controlled by dev/admin mode, not user settings
      if (RESTRICTED_TABS.has(tabName)) return;
      var hidden = navbarHiddenTabs.has(tabName);
      var row = document.createElement('div');
      row.className = 'navbar-tabs-list-item' + (hidden ? ' disabled-tab' : '');

      var label = document.createElement('span');
      label.className = 'navbar-tabs-list-item-label';
      label.textContent = getTabLabel(tabName);

      var toggle = document.createElement('label');
      toggle.className = 'toggle-switch';
      var cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = !hidden;
      // Don't allow hiding the Home tab
      if (tabName === 'home') {
        cb.disabled = true;
        cb.checked = true;
      }
      cb.addEventListener('change', function () {
        if (cb.checked) {
          navbarHiddenTabs.delete(tabName);
        } else {
          navbarHiddenTabs.add(tabName);
        }
        saveNavbarHiddenTabs();
        applyNavbarLayout();
        row.classList.toggle('disabled-tab', !cb.checked);
      });
      var slider = document.createElement('span');
      slider.className = 'toggle-slider';
      toggle.appendChild(cb);
      toggle.appendChild(slider);

      row.appendChild(label);
      row.appendChild(toggle);
      navTabVisListEl.appendChild(row);
    });
  }

  // ── Drag-and-drop on #content-tabs ──
  var dragSrcTab = null;

  contentTabsEl.addEventListener('dragstart', function (e) {
    var btn = e.target.closest('.content-tab');
    if (!btn) return;
    dragSrcTab = btn;
    btn.classList.add('dragging');
    contentTabsEl.classList.add('drag-active');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', btn.dataset.tab);
  });

  contentTabsEl.addEventListener('dragover', function (e) {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    var btn = e.target.closest('.content-tab');
    if (!btn || btn === dragSrcTab) return;
    // Determine which half of the button the cursor is over
    var rect = btn.getBoundingClientRect();
    var midX = rect.left + rect.width / 2;
    contentTabsEl.querySelectorAll('.content-tab').forEach(function (b) {
      b.classList.remove('drag-over-left', 'drag-over-right');
    });
    if (e.clientX < midX) {
      btn.classList.add('drag-over-left');
    } else {
      btn.classList.add('drag-over-right');
    }
  });

  contentTabsEl.addEventListener('dragleave', function (e) {
    var btn = e.target.closest('.content-tab');
    if (btn) {
      btn.classList.remove('drag-over-left', 'drag-over-right');
    }
  });

  contentTabsEl.addEventListener('drop', function (e) {
    e.preventDefault();
    var targetBtn = e.target.closest('.content-tab');
    if (!targetBtn || !dragSrcTab || targetBtn === dragSrcTab) return;

    // Build new order from current DOM
    var tabs = Array.from(contentTabsEl.querySelectorAll('.content-tab'));
    var srcIndex = tabs.indexOf(dragSrcTab);
    var targetIndex = tabs.indexOf(targetBtn);

    // Determine insert position based on cursor position
    var rect = targetBtn.getBoundingClientRect();
    var midX = rect.left + rect.width / 2;
    var insertBefore = e.clientX < midX;

    // Remove source from array
    tabs.splice(srcIndex, 1);
    // Find target's new index after removal
    var newTargetIndex = tabs.indexOf(targetBtn);
    var insertIndex = insertBefore ? newTargetIndex : newTargetIndex + 1;
    tabs.splice(insertIndex, 0, dragSrcTab);

    var newOrder = tabs.map(function (b) { return b.dataset.tab; });
    saveNavbarTabOrder(newOrder);
    applyNavbarLayout();
    renderNavbarTabSettings();

    // Clean up
    contentTabsEl.querySelectorAll('.content-tab').forEach(function (b) {
      b.classList.remove('drag-over-left', 'drag-over-right');
    });
  });

  contentTabsEl.addEventListener('dragend', function () {
    if (dragSrcTab) dragSrcTab.classList.remove('dragging');
    contentTabsEl.classList.remove('drag-active');
    contentTabsEl.querySelectorAll('.content-tab').forEach(function (b) {
      b.classList.remove('drag-over-left', 'drag-over-right');
    });
    dragSrcTab = null;
  });

  // Initialize navbar layout + settings list
  applyNavbarLayout();
  renderNavbarTabSettings();

  // Extend tab hover zone to the full left edge of the window
  document.addEventListener('mousemove', function(e) {
    var rect = contentTabsEl.getBoundingClientRect();
    if (e.clientX <= rect.right) {
      contentTabsEl.classList.add('tabs-hovered');
    } else {
      contentTabsEl.classList.remove('tabs-hovered');
    }
  });
  document.addEventListener('mouseleave', function() {
    contentTabsEl.classList.remove('tabs-hovered');
  });

  // Iframe on the API tab swallows mousemove from parent — remove hover state on entry
  var apiIframe = document.querySelector('.api-docs-iframe');
  if (apiIframe) {
    apiIframe.addEventListener('mouseenter', function() {
      contentTabsEl.classList.remove('tabs-hovered');
    });
  }

  function refreshStatBonusDisplays() {
    if (lastPlayerData) updatePlayerCard(lastPlayerData);
    if (activeTab === 'home') renderHomeTab();
  }
  if (showGearStatBonusesToggle) {
    showGearStatBonusesToggle.checked = showGearStatBonuses;
    showGearStatBonusesToggle.addEventListener('change', () => {
      showGearStatBonuses = showGearStatBonusesToggle.checked;
      localStorage.setItem('showGearStatBonuses', showGearStatBonuses);
      refreshStatBonusDisplays();
    });
  }

  var copyAllPlayersRawStatsBtn = document.getElementById('btn-copy-all-players-raw-stats');
  function requestCopyAllPlayersRawStats() {
    if (!ws || ws.readyState !== 1) {
      addHomeFeed('err', 'Dashboard socket is not connected.');
      return;
    }
    if (pendingAllPlayersRawStatsCb) {
      addHomeFeed('warn', 'Already waiting for raw player stats.');
      return;
    }
    pendingAllPlayersRawStatsCb = function (msg) {
      var payload = {
        capturedAt: msg.capturedAt,
        map: msg.map != null ? msg.map : null,
        gameId: msg.gameId != null ? msg.gameId : null,
        selfObjectId: msg.selfObjectId != null ? msg.selfObjectId : null,
        players: Array.isArray(msg.players) ? msg.players : [],
      };
      var text = JSON.stringify(payload, null, 2);
      var n = payload.players.length;
      if (navigator && navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
        navigator.clipboard.writeText(text).then(function () {
          addHomeFeed('ok', 'Copied raw stats for ' + n + ' player' + (n === 1 ? '' : 's') + ' to clipboard.');
        }).catch(function () {
          addHomeFeed('err', 'Clipboard copy failed; open devtools or try another browser.');
        });
      } else {
        addHomeFeed('err', 'Clipboard API not available here.');
      }
    };
    pendingAllPlayersRawStatsTimer = setTimeout(function () {
      pendingAllPlayersRawStatsTimer = null;
      if (pendingAllPlayersRawStatsCb) {
        pendingAllPlayersRawStatsCb = null;
        addHomeFeed('warn', 'Raw player stats request timed out.');
      }
    }, 10000);
    try {
      ws.send(JSON.stringify({ type: 'requestAllPlayersRawStats' }));
    } catch {
      if (pendingAllPlayersRawStatsTimer) {
        clearTimeout(pendingAllPlayersRawStatsTimer);
        pendingAllPlayersRawStatsTimer = null;
      }
      pendingAllPlayersRawStatsCb = null;
      addHomeFeed('err', 'Failed to request raw player stats.');
    }
  }
  if (copyAllPlayersRawStatsBtn) {
    copyAllPlayersRawStatsBtn.addEventListener('click', requestCopyAllPlayersRawStats);
  }
  var copyVaultDataBtn = document.getElementById('btn-copy-vault-data');
  if (copyVaultDataBtn) {
    copyVaultDataBtn.addEventListener('click', function () {
      if (!ws || ws.readyState !== 1) {
        addHomeFeed('err', 'Dashboard socket is not connected.');
        return;
      }
      if (pendingVaultChestRawStatsCb) {
        addHomeFeed('warn', 'Already waiting for vault data.');
        return;
      }
      pendingVaultChestRawStatsCb = function (msg) {
        if (msg.error) {
          addHomeFeed('warn', 'Vault data: ' + msg.error);
          return;
        }
        var text = JSON.stringify(msg, null, 2);
        if (navigator && navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
          navigator.clipboard.writeText(text).then(function () {
            addHomeFeed('ok', 'Copied vault data to clipboard.');
          }).catch(function () {
            addHomeFeed('err', 'Clipboard copy failed; open devtools or try another browser.');
          });
        } else {
          addHomeFeed('err', 'Clipboard API not available here.');
        }
      };
      pendingVaultChestRawStatsTimer = setTimeout(function () {
        pendingVaultChestRawStatsTimer = null;
        if (pendingVaultChestRawStatsCb) {
          pendingVaultChestRawStatsCb = null;
          addHomeFeed('warn', 'Vault data request timed out.');
        }
      }, 10000);
      try {
        ws.send(JSON.stringify({ type: 'requestVaultData' }));
      } catch {
        if (pendingVaultChestRawStatsTimer) {
          clearTimeout(pendingVaultChestRawStatsTimer);
          pendingVaultChestRawStatsTimer = null;
        }
        pendingVaultChestRawStatsCb = null;
        addHomeFeed('err', 'Failed to request vault data.');
      }
    });
  }

  if (showServerPingToggle) {
    showServerPingToggle.checked = showServerPing;
    showServerPingToggle.addEventListener('change', () => {
      showServerPing = showServerPingToggle.checked;
      localStorage.setItem('showServerPing', showServerPing);
      updateServerSelectPingDisplay();
    });
  }

  var pluginsAdvancedToggle = document.getElementById('setting-plugins-advanced');
  {
    var paOn = localStorage.getItem('pluginsAdvanced') === '1';
    document.body.classList.toggle('plugins-advanced', paOn);
    if (pluginsAdvancedToggle) {
      pluginsAdvancedToggle.checked = paOn;
      pluginsAdvancedToggle.addEventListener('change', function () {
        var on = pluginsAdvancedToggle.checked;
        localStorage.setItem('pluginsAdvanced', on ? '1' : '0');
        document.body.classList.toggle('plugins-advanced', on);
      });
    }
  }

  if (showAccountEmailsToggle) {
    showAccountEmailsToggle.checked = showAccountEmails;
    showAccountEmailsToggle.addEventListener('change', () => {
      showAccountEmails = showAccountEmailsToggle.checked;
      localStorage.setItem('showAccountEmails', showAccountEmails);
      renderAccountsList();
    });
  }

  if (showSingleAccountDockToggle) {
    showSingleAccountDockToggle.checked = showSingleAccountDock;
    showSingleAccountDockToggle.addEventListener('change', () => {
      showSingleAccountDock = showSingleAccountDockToggle.checked;
      localStorage.setItem('showSingleAccountDock', showSingleAccountDock);
      renderSingleAccountDock();
    });
  }

  if (telemetryEnabledToggle) {
    // Fire current state request once the socket is up so the checkbox reflects
    // server-side config rather than the static HTML default.
    function _requestTelemetryEnabled() {
      if (ws && ws.readyState === 1) {
        ws.send(JSON.stringify({ type: 'getTelemetryEnabled' }));
      } else {
        setTimeout(_requestTelemetryEnabled, 500);
      }
    }
    _requestTelemetryEnabled();
    telemetryEnabledToggle.addEventListener('change', function () {
      if (!ws || ws.readyState !== 1) return;
      ws.send(JSON.stringify({
        type: 'setTelemetryEnabled',
        enabled: !!telemetryEnabledToggle.checked,
      }));
    });
  }

  function getThemeMeta(themeId) {
    var id = String(themeId || '');
    return THEMES.find(function (theme) { return theme.id === id; }) || THEMES[0];
  }

  function applyTheme() {
    var themeMeta = getThemeMeta(currentTheme);
    currentTheme = themeMeta.id;
    localStorage.setItem('theme', currentTheme);
    document.body.classList.remove('theme-dark', 'theme-light', 'theme-sage', 'theme-mist', 'theme-forest', 'theme-ocean', 'theme-ember', 'light-mode');
    if (currentTheme !== 'dark') document.body.classList.add('theme-' + currentTheme);
    if (currentTheme === 'light') document.body.classList.add('light-mode');
    if (themeSelect) themeSelect.value = currentTheme;
  }
  applyTheme();

  function t(key) {
    var dict = TRANSLATIONS[currentLanguage] || TRANSLATIONS['en'];
    return dict[key] || TRANSLATIONS['en'][key] || key;
  }

  function tr(key, vars) {
    var s = t(key);
    if (!vars || typeof vars !== 'object') return s;
    Object.keys(vars).forEach(function (k) {
      s = s.split('{' + k + '}').join(String(vars[k]));
    });
    return s;
  }

  function canonicalPluginKey(value) {
    return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
  }

  function getPluginDisplayName(plugin) {
    if (!plugin) return '';
    var dict = PLUGIN_NAME_TRANSLATIONS[currentLanguage];
    if (dict) {
      var byId = canonicalPluginKey(plugin.id);
      if (byId && dict[byId]) return dict[byId];
      var byName = canonicalPluginKey(plugin.name);
      if (byName && dict[byName]) return dict[byName];
    }
    return plugin.name || plugin.id || '';
  }

  function refreshMultiboxClientTitles() {
    var st = document.getElementById('multibox-stage');
    if (!st) return;
    st.querySelectorAll('.multibox-window[data-client-index]').forEach(function (win) {
      var idx = parseInt(win.getAttribute('data-client-index'), 10);
      if (!(idx >= 1)) return;
      var span = win.querySelector('.multibox-window-title');
      if (!span) return;
      span.textContent = tr('multibox.clientTitle', { n: idx });
    });
  }

  function applyLanguage() {
    if (!TRANSLATIONS[currentLanguage]) currentLanguage = 'en';
    localStorage.setItem('language', currentLanguage);
    if (langSelect) langSelect.value = currentLanguage;
    document.querySelectorAll('[data-i18n-html]').forEach(function (el) {
      var key = el.getAttribute('data-i18n-html');
      var text = t(key);
      if (text) el.innerHTML = text;
    });
    document.querySelectorAll('[data-i18n]').forEach(function (el) {
      var key = el.getAttribute('data-i18n');
      var text = t(key);
      if (text) el.textContent = text;
    });
    document.querySelectorAll('[data-i18n-placeholder]').forEach(function (el) {
      var key = el.getAttribute('data-i18n-placeholder');
      var text = t(key);
      if (text) el.setAttribute('placeholder', text);
    });
    document.querySelectorAll('[data-i18n-aria-label]').forEach(function (el) {
      var key = el.getAttribute('data-i18n-aria-label');
      var text = t(key);
      if (text) el.setAttribute('aria-label', text);
    });
    document.querySelectorAll('[data-i18n-title]').forEach(function (el) {
      var key = el.getAttribute('data-i18n-title');
      var text = t(key);
      if (text) el.setAttribute('title', text);
    });
    refreshMultiboxClientTitles();
    renderDamageSettings(Array.isArray(allPluginsData) ? allPluginsData : []);
    renderAccountSettings();
    updateMacLaunchSortSummary();
    if (isMacStyleSidebar() && multiAccountSidebarMode === 'launch') renderMacLaunchGroupsList();
    if (typeof syncWdThresholdCaption === 'function') syncWdThresholdCaption();
  }
  applyLanguage();

  function setActiveSettingsTab(tabName) {
    activeSettingsTab = String(tabName || 'visual');
    // Account tab moved to its own popup; fall back to visual if stale value
    if (activeSettingsTab === 'dashboard') activeSettingsTab = 'visual';
    localStorage.setItem('activeSettingsTab', activeSettingsTab);
    document.querySelectorAll('.settings-tab').forEach(function (btn) {
      btn.classList.toggle('active', String(btn.getAttribute('data-settings-tab') || '') === activeSettingsTab);
    });
    document.querySelectorAll('.settings-tab-panel').forEach(function (panel) {
      panel.classList.toggle('active', String(panel.getAttribute('data-settings-panel') || '') === activeSettingsTab);
    });
  }


  if (themeSelect) {
    themeSelect.addEventListener('change', function () {
      currentTheme = String(themeSelect.value || 'dark');
      applyTheme();
    });
  }

  if (langSelect) {
    langSelect.addEventListener('change', function () {
      currentLanguage = String(langSelect.value || 'en');
      applyLanguage();
      renderPlugins(Array.isArray(allPluginsData) ? allPluginsData : []);
      populateScriptSelect();
      renderHomeTab();
      if (activeTab === 'accounts') {
        renderAccountsList();
        renderAccountsOverview();
      }
    });
  }

  // ── Settings tab integration ────────────────────────────────────────────
  //
  // Settings live inside the "Settings" content tab. The cog in the header
  // is just a shortcut that activates that tab — no separate modal. We move
  // the existing settings-modal body and account-popup body into the tab
  // panel on init so we don't have to duplicate hundreds of lines of markup.
  // activateContentTab() programmatically clicks a content tab so legacy
  // "open settings" / "open account" call sites can stay one-liners.
  function activateContentTab(name) {
    if (name === 'settings') {
      openSettingsPopout();
      return;
    }
    var btn = document.querySelector('.content-tab[data-tab="' + name + '"]');
    if (btn) btn.click();
  }

  function openSettingsPopout() {
    var settingsPopout = document.getElementById('tab-settings');
    if (!settingsPopout) return;
    refreshSettingsTab();
    settingsPopout.style.display = '';
    settingsPopout.classList.add('active', 'settings-popout-open');
    settingsPopout.setAttribute('aria-hidden', 'false');
  }

  function closeSettingsPopout() {
    var settingsPopout = document.getElementById('tab-settings');
    if (!settingsPopout) return;
    settingsPopout.style.display = 'none';
    settingsPopout.classList.remove('active', 'settings-popout-open');
    settingsPopout.setAttribute('aria-hidden', 'true');
  }

  document.addEventListener('click', function (e) {
    var launcherBtn = e.target.closest('[data-launcher-tab]');
    if (!launcherBtn) return;
    if (launcherBtn.classList.contains('launcher-quick-btn--primary')) {
      handleQuickLaunchClick();
      return;
    }
    activateContentTab(String(launcherBtn.getAttribute('data-launcher-tab') || ''));
  });

  document.addEventListener('contextmenu', function (e) {
    var qlBtn = e.target.closest('.launcher-quick-btn--primary');
    if (!qlBtn) {
      hideQuickLaunchCtxMenu();
      return;
    }
    e.preventDefault();
    showQuickLaunchCtxMenu(e.clientX, e.clientY);
  });

  document.addEventListener('click', function (e) {
    if (!e.target.closest('#ql-ctx-menu')) hideQuickLaunchCtxMenu();
    var qlAction = e.target.closest('[data-ql-action]');
    if (!qlAction) return;
    var action = qlAction.getAttribute('data-ql-action');
    hideQuickLaunchCtxMenu();
    if (action === 'edit') {
      showQuickLaunchPicker();
    } else if (action === 'launch') {
      handleQuickLaunchClick();
    } else if (action === 'clear') {
      quickLaunchAccountId = null;
      localStorage.removeItem('quickLaunchAccountId');
      updateQuickLaunchBtn();
    }
  });

  document.addEventListener('click', function (e) {
    if (e.target.id === 'ql-picker-close' || e.target.closest('#ql-picker-close')) {
      hideQuickLaunchPicker();
    } else if (e.target.classList.contains('ql-picker-backdrop')) {
      hideQuickLaunchPicker();
    } else if (e.target.id === 'ql-picker-clear') {
      quickLaunchAccountId = null;
      localStorage.removeItem('quickLaunchAccountId');
      updateQuickLaunchBtn();
      hideQuickLaunchPicker();
    }
  });

  function handleQuickLaunchClick() {
    if (quickLaunchAccountId) {
      var account = null;
      for (var i = 0; i < dashboardAccounts.length; i++) {
        if (dashboardAccounts[i].id === quickLaunchAccountId) { account = dashboardAccounts[i]; break; }
      }
      if (account && String(account.email || '').trim() && String(account.password || '')) {
        launchGameWithCredentials(
          String(account.email || '').trim(),
          String(account.password || ''),
          String(account.serverName || 'USWest').trim() || 'USWest',
          undefined,
          launchOptsWithAccount(account, {}),
        );
        return;
      }
    }
    showQuickLaunchPicker();
  }

  function showQuickLaunchPicker() {
    renderQuickLaunchPicker();
    var el = document.getElementById('ql-picker');
    if (el) el.style.display = '';
  }

  function hideQuickLaunchPicker() {
    var el = document.getElementById('ql-picker');
    if (el) el.style.display = 'none';
  }

  function renderQuickLaunchPicker() {
    var list = document.getElementById('ql-picker-list');
    if (!list) return;
    list.innerHTML = '';
    if (!dashboardAccounts.length) {
      list.innerHTML = '<div class="ql-picker-empty">No accounts saved yet. Add accounts in the Accounts tab first.</div>';
      return;
    }
    dashboardAccounts.forEach(function (account) {
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'ql-picker-account-btn' + (account.id === quickLaunchAccountId ? ' selected' : '');
      var displayName = String(account.label || account.email || 'Unnamed Account');
      btn.innerHTML =
        '<span class="ql-picker-account-name">' + escapeHtml(displayName) + '</span>' +
        '<span class="ql-picker-account-server">' + escapeHtml(String(account.serverName || 'USWest')) + '</span>';
      btn.addEventListener('click', function () {
        quickLaunchAccountId = account.id;
        localStorage.setItem('quickLaunchAccountId', account.id);
        updateQuickLaunchBtn();
        hideQuickLaunchPicker();
      });
      list.appendChild(btn);
    });
  }

  function updateQuickLaunchBtn() {
    var btn = document.querySelector('.launcher-quick-btn--primary');
    if (!btn) return;
    var iconEl = btn.querySelector('.launcher-quick-icon');
    var labelEl = btn.querySelector('.launcher-quick-label');
    if (quickLaunchAccountId) {
      var account = null;
      for (var i = 0; i < dashboardAccounts.length; i++) {
        if (dashboardAccounts[i].id === quickLaunchAccountId) { account = dashboardAccounts[i]; break; }
      }
      if (account) {
        var displayName = String(account.label || account.email || 'Account');
        if (iconEl) iconEl.textContent = displayName.charAt(0).toUpperCase();
        if (labelEl) labelEl.textContent = displayName.length > 14 ? displayName.slice(0, 13) + '…' : displayName;
        return;
      }
    }
    if (iconEl) iconEl.textContent = 'A';
    if (labelEl) labelEl.textContent = 'Quick Launch';
  }

  function showQuickLaunchCtxMenu(x, y) {
    var menu = document.getElementById('ql-ctx-menu');
    if (!menu) return;
    menu.style.left = x + 'px';
    menu.style.top = y + 'px';
    menu.style.display = '';
    var hasAccount = !!quickLaunchAccountId && dashboardAccounts.some(function (a) { return a.id === quickLaunchAccountId; });
    var launchItem = menu.querySelector('[data-ql-action="launch"]');
    var clearItem = menu.querySelector('[data-ql-action="clear"]');
    if (launchItem) launchItem.style.display = hasAccount ? '' : 'none';
    if (clearItem) clearItem.style.display = hasAccount ? '' : 'none';
  }

  function hideQuickLaunchCtxMenu() {
    var menu = document.getElementById('ql-ctx-menu');
    if (menu) menu.style.display = 'none';
  }

  var btnSettingsCog = document.getElementById('btn-settings');
  if (btnSettingsCog) {
    btnSettingsCog.addEventListener('click', function () {
      openSettingsPopout();
    });
  }

  var settingsPopoutClose = document.getElementById('settings-popout-close');
  if (settingsPopoutClose) {
    settingsPopoutClose.addEventListener('click', closeSettingsPopout);
  }

  var settingsPopout = document.getElementById('tab-settings');
  if (settingsPopout) {
    settingsPopout.addEventListener('click', function (e) {
      if (e.target.closest('[data-settings-popout-close]')) closeSettingsPopout();
    });
  }

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') closeSettingsPopout();
  });

  (function relocateSettingsAndAccountIntoTab() {
    var tabAccount = document.getElementById('settings-tab-account');
    var tabForm = document.getElementById('settings-tab-form');
    if (!tabAccount || !tabForm) return;

    // Move the account-popup body (profile card, gem/plan stats, action
    // buttons, sign out) into the Settings tab. We strip the wrapper "popup"
    // chrome so it lays out as an inline section.
    var acctOverlay = document.getElementById('account-popup-overlay');
    if (acctOverlay) {
      var acctBody = acctOverlay.querySelector('.account-popup-body');
      var acctFooter = acctOverlay.querySelector('.account-popup-footer');
      if (acctBody) tabAccount.appendChild(acctBody);
      if (acctFooter) tabAccount.appendChild(acctFooter);
      acctOverlay.remove();
    }

    // Move the actual settings form (Visual / Game / Developer / Admin
    // sub-tabs) into the Settings tab.
    var settingsOv = document.getElementById('settings-overlay');
    if (settingsOv) {
      var settingsBody = settingsOv.querySelector('#settings-body');
      if (settingsBody) tabForm.appendChild(settingsBody);
      settingsOv.remove();
    }
  })();

  // When the Settings tab becomes active, refresh the same things the old
  // cog click used to refresh (sub-tab panel, plugin configs, navbar
  // visibility list, account billing).
  function refreshSettingsTab() {
    if (typeof setActiveSettingsTab === 'function') {
      setActiveSettingsTab(activeSettingsTab);
    }
    if (typeof loadPluginConfigs === 'function') loadPluginConfigs();
    if (typeof renderNavbarTabSettings === 'function') renderNavbarTabSettings();
    if (typeof renderAccountSettings === 'function') renderAccountSettings();
  }

  var replayTutorialBtn = document.getElementById('settings-replay-tutorial');
  if (replayTutorialBtn) {
    replayTutorialBtn.addEventListener('click', function () {
      if (typeof window._resetTutorial === 'function') {
        window._resetTutorial();
      }
    });
  }

  if (itemDetailCloseBtn) {
    itemDetailCloseBtn.addEventListener('click', function () {
      closeItemDetailModal();
    });
  }

  if (itemDetailOverlay) {
    itemDetailOverlay.addEventListener('click', function (e) {
      var copyBtn = e.target.closest('.item-type-decimal-copy');
      if (copyBtn) {
        var value = String(copyBtn.getAttribute('data-copy-value') || '');
        if (value && navigator.clipboard) {
          navigator.clipboard.writeText(value).catch(function () {});
          var prev = copyBtn.textContent;
          copyBtn.textContent = 'Copied!';
          setTimeout(function () { copyBtn.textContent = prev; }, 1200);
        }
        return;
      }
      if (e.target === itemDetailOverlay) closeItemDetailModal();
    });
  }

  document.addEventListener('click', function (e) {
    var btn = e.target.closest('.rotmg-item-sprite[data-item-object-type]');
    if (!btn || btn.disabled) return;
    openItemDetailModalFromButton(btn);
  });

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && itemDetailOverlay && !itemDetailOverlay.classList.contains('hidden')) {
      closeItemDetailModal();
    }
  });

  /* ── Sidebar account button → open account popup ── */
  var sidebarAccountBtn = document.getElementById('sidebar-account-btn');
  if (sidebarAccountBtn) {
    sidebarAccountBtn.addEventListener('click', function () { openAccountPopup(); });
  }
  var multiAccountBtn = document.getElementById('multi-account-account-btn');
  if (multiAccountBtn) {
    multiAccountBtn.addEventListener('click', function () { openAccountPopup(); });
  }

  /* ── Account popup: close, buy-gems, manage-plan, sign-out ── */
  var accountPopupOverlay = document.getElementById('account-popup-overlay');
  if (accountPopupOverlay) {
    accountPopupOverlay.addEventListener('click', function (e) {
      if (e.target.closest('[data-account-popup-close]')) closeAccountPopup();
    });
  }
  var acctPopupBuyGems = document.getElementById('account-popup-buy-gems');
  var acctPopupManagePlan = document.getElementById('account-popup-manage-plan');
  var acctPopupSignout = document.getElementById('account-popup-signout');
  if (acctPopupBuyGems) {
    acctPopupBuyGems.addEventListener('click', function () { closeAccountPopup(); openPurchaseModal(); });
  }
  if (acctPopupManagePlan) {
    acctPopupManagePlan.addEventListener('click', function () { closeAccountPopup(); openPlanModal(); });
  }
  if (acctPopupSignout) {
    acctPopupSignout.addEventListener('click', function () { signOutDashboard(); });
  }

  var planModalOverlay = document.getElementById('plan-modal-overlay');
  if (planModalOverlay) {
    planModalOverlay.addEventListener('click', function (e) {
      if (e.target.closest('[data-plan-modal-close]')) closePlanModal();
    });
  }

  var purchaseModalOverlay = document.getElementById('purchase-modal-overlay');
  if (purchaseModalOverlay) {
    purchaseModalOverlay.addEventListener('click', function (e) {
      if (e.target.closest('[data-purchase-modal-close]')) closePurchaseModal();
    });
  }
  var purchaseModalGemQty = document.getElementById('purchase-modal-gem-qty');
  if (purchaseModalGemQty) {
    function sanitizePurchaseGemQtyInput() {
      var el = purchaseModalGemQty;
      var digits = String(el.value).replace(/\D/g, '').slice(0, 6);
      if (el.value !== digits) el.value = digits;
      updatePurchaseModalTotal();
    }
    purchaseModalGemQty.addEventListener('input', sanitizePurchaseGemQtyInput);
    purchaseModalGemQty.addEventListener('change', sanitizePurchaseGemQtyInput);
    purchaseModalGemQty.addEventListener('keydown', function (e) {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      purchaseModalCheckout();
    });
  }
  var purchaseModalCheckoutBtn = document.getElementById('purchase-modal-checkout');
  if (purchaseModalCheckoutBtn) {
    purchaseModalCheckoutBtn.addEventListener('click', function () {
      purchaseModalCheckout();
    });
  }

  // Quick-amount buttons
  document.querySelectorAll('.purchase-quick-btn').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var qty = document.getElementById('purchase-modal-gem-qty');
      if (qty) {
        qty.value = String(btn.getAttribute('data-quick-gems') || '100');
        updatePurchaseModalTotal();
      }
    });
  });

  // Step 2: back button
  var purchaseBackBtn = document.getElementById('purchase-modal-back');
  if (purchaseBackBtn) {
    purchaseBackBtn.addEventListener('click', purchaseGoBack);
  }

  // Step 2: category row expand/collapse
  document.querySelectorAll('.pay-cat-row--expand').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var targetId = 'pay-expand-' + (btn.getAttribute('data-expand') || '');
      var panel = document.getElementById(targetId);
      if (!panel) return;
      var isOpen = !panel.classList.contains('hidden');
      // Close all other panels first
      document.querySelectorAll('.pay-cat-options').forEach(function (p) { p.classList.add('hidden'); });
      document.querySelectorAll('.pay-cat-row--expand').forEach(function (b) { b.setAttribute('aria-expanded', 'false'); });
      if (!isOpen) {
        panel.classList.remove('hidden');
        btn.setAttribute('aria-expanded', 'true');
      }
    });
  });

  // Step 2: direct card row
  var stripeCardRow = document.querySelector('[data-method="stripe_card"]');
  if (stripeCardRow) {
    stripeCardRow.addEventListener('click', function () {
      purchaseWithMethod('stripe_card');
    });
  }

  // Step 2: individual option buttons inside expanded panels
  document.querySelectorAll('.pay-opt-btn').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var method = btn.getAttribute('data-method') || '';
      purchaseWithMethod(method);
    });
  });

  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape') return;
    var pl = document.getElementById('plan-modal-overlay');
    if (pl && !pl.classList.contains('hidden')) {
      e.preventDefault();
      closePlanModal();
      return;
    }
    var pm = document.getElementById('purchase-modal-overlay');
    if (pm && !pm.classList.contains('hidden')) {
      e.preventDefault();
      closePurchaseModal();
      return;
    }
    var ap = document.getElementById('account-popup-overlay');
    if (ap && !ap.classList.contains('hidden')) {
      e.preventDefault();
      closeAccountPopup();
    }
  });

  if (settingsTabsEl) {
    settingsTabsEl.addEventListener('click', function (e) {
      var btn = e.target.closest('.settings-tab');
      if (!btn) return;
      setActiveSettingsTab(btn.getAttribute('data-settings-tab') || 'visual');
    });
  }
  setActiveSettingsTab(activeSettingsTab);
  renderAccountSettings();

  devModeToggle.addEventListener('change', () => {
    devMode = devModeToggle.checked;
    localStorage.setItem('devMode', devMode);
    applyDevMode();
  });

  if (adminModeToggle) {
    adminModeToggle.addEventListener('change', () => {
      // Admin dev: no is_admin check — toggle freely.
      adminMode = adminModeToggle.checked;
      _realAdminMode = adminMode;  // remember the real choice for view-as resets
      applyAdminMode();
    });
  }

  // View-as preview dropdown (admin debug — preview the dashboard as a non-admin user)
  var viewAsSelect = document.getElementById('setting-view-as');
  if (viewAsSelect) {
    viewAsSelect.addEventListener('change', function () {
      // Only admins can use view-as. If not, snap back to real account.
      if (!dashboardUser || !dashboardUser.is_admin) {
        viewAsSelect.value = '';
        viewAsOverride = null;
        applyViewAsOverride();
        return;
      }
      var key = viewAsSelect.value;
      viewAsOverride = key && VIEW_AS_PRESETS[key] ? VIEW_AS_PRESETS[key] : null;
      applyViewAsOverride();
    });
  }
  var viewAsBannerReset = document.getElementById('view-as-banner-reset');
  if (viewAsBannerReset) {
    viewAsBannerReset.addEventListener('click', function () {
      viewAsOverride = null;
      var sel = document.getElementById('setting-view-as');
      if (sel) sel.value = '';
      applyViewAsOverride();
    });
  }

  if (singleClientOnlyToggle) {
    singleClientOnlyToggle.checked = singleClientOnly;
    singleClientOnlyToggle.addEventListener('change', () => {
      // Non-admins cannot disable single-client mode
      if (!dashboardUser || !dashboardUser.is_admin) {
        singleClientOnlyToggle.checked = true;
        singleClientOnly = true;
        return;
      }
      singleClientOnly = !!singleClientOnlyToggle.checked;
      if (ws && ws.readyState === 1) {
        ws.send(JSON.stringify({
          type: 'updateSingleClientOnly',
          value: singleClientOnly,
        }));
      }
    });
  }

  var packetSnifferToggle = document.getElementById('setting-packet-sniffer-visible');
  if (packetSnifferToggle) {
    packetSnifferToggle.checked = packetSnifferVisible;
    packetSnifferToggle.addEventListener('change', function () {
      packetSnifferVisible = !!packetSnifferToggle.checked;
      localStorage.setItem('packetSnifferVisible', packetSnifferVisible ? 'true' : 'false');
      applyPacketSnifferVisibility();
      if (adminMode && packetSnifferVisible) {
        seedSnifferPacketTypeChipsFromDefs();
      }
    });
  }

  var accountLayoutModeSelect = document.getElementById('setting-account-layout-mode');
  if (accountLayoutModeSelect) {
    accountLayoutModeSelect.value = accountLayoutMode;
    accountLayoutModeSelect.addEventListener('change', function () {
      accountLayoutMode = normalizeAccountLayoutMode(accountLayoutModeSelect.value);
      localStorage.setItem('accountLayoutMode', accountLayoutMode);
      applyMultiAccountView();
    });
  }
  applyMultiAccountView();
  var multiSidebarConnectedBtn = document.getElementById('multi-sidebar-mode-connected');
  var multiSidebarLaunchBtn = document.getElementById('multi-sidebar-mode-launch');
  if (multiSidebarConnectedBtn) {
    multiSidebarConnectedBtn.addEventListener('click', function () {
      setMultiAccountSidebarMode('connected');
    });
  }
  if (multiSidebarLaunchBtn) {
    multiSidebarLaunchBtn.addEventListener('click', function () {
      setMultiAccountSidebarMode('launch');
    });
  }

  // Sniffer drawer toggle
  document.getElementById('sniffer-header').addEventListener('click', (e) => {
    // Don't toggle when clicking buttons inside
    if (e.target.closest('button:not(.sniffer-toggle-btn)')) return;
    snifferExpanded = !snifferExpanded;
    snifferDrawer.classList.toggle('expanded', snifferExpanded);
    snifferDrawer.classList.toggle('collapsed', !snifferExpanded);
    if (snifferExpanded) {
      snifferPacketsSinceCollapse = 0;
      snifferBadge.classList.add('hidden');
      refreshTable();
    }
  });
  if (snifferTableWrap) {
    let snifferScrollQueued = false;
    snifferTableWrap.addEventListener('scroll', function () {
      if (!snifferExpanded) return;
      if (snifferScrollQueued) return;
      snifferScrollQueued = true;
      requestAnimationFrame(function () {
        snifferScrollQueued = false;
        refreshTable();
      });
    });
  }

  // Hotkey infrastructure — maps a single key (e.g. "j") to a plugin button setting
  let hotkeyMap = new Map(); // key → { pluginId, key: buttonSettingKey }

  document.addEventListener('keydown', (e) => {
    if (['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName)) return;
    const action = hotkeyMap.get(e.key.toLowerCase());
    if (action) {
      e.preventDefault();
      ws.send(JSON.stringify({ type: 'updateSetting', pluginId: action.pluginId, key: action.key, value: true }));
    }
  });

  function setOverlayLoginError(text) {
    if (!overlayLoginError) return;
    overlayLoginError.textContent = text || '';
    overlayLoginError.classList.toggle('hidden', !text);
  }

  function setOverlayPasswordEyeIcons(passwordVisible) {
    if (!overlayPasswordToggleBtn) return;
    var showIcon = overlayPasswordToggleBtn.querySelector('.disconnect-password-eye-show');
    var hideIcon = overlayPasswordToggleBtn.querySelector('.disconnect-password-eye-hide');
    if (showIcon) showIcon.classList.toggle('hidden', passwordVisible);
    if (hideIcon) hideIcon.classList.toggle('hidden', !passwordVisible);
  }

  function resetOverlayPasswordVisibility() {
    if (overlayPasswordInput) overlayPasswordInput.type = 'password';
    if (overlayPasswordToggleBtn) {
      overlayPasswordToggleBtn.setAttribute('aria-pressed', 'false');
      overlayPasswordToggleBtn.setAttribute('aria-label', 'Show password');
      overlayPasswordToggleBtn.title = 'Show password';
    }
    setOverlayPasswordEyeIcons(false);
  }

  if (overlayPasswordToggleBtn && overlayPasswordInput) {
    overlayPasswordToggleBtn.addEventListener('click', function () {
      var showPlain = overlayPasswordInput.type === 'password';
      overlayPasswordInput.type = showPlain ? 'text' : 'password';
      overlayPasswordToggleBtn.setAttribute('aria-pressed', showPlain ? 'true' : 'false');
      overlayPasswordToggleBtn.setAttribute('aria-label', showPlain ? 'Hide password' : 'Show password');
      overlayPasswordToggleBtn.title = showPlain ? 'Hide password' : 'Show password';
      setOverlayPasswordEyeIcons(showPlain);
    });
  }

  function persistDashboardLoginState() {
    if (accessToken) localStorage.setItem('accessToken', accessToken);
    else localStorage.removeItem('accessToken');
    if (refreshToken) localStorage.setItem('refreshToken', refreshToken);
    else localStorage.removeItem('refreshToken');
    localStorage.removeItem('dashboardLoggedIn');
    localStorage.removeItem('dashboardUsername');
    localStorage.removeItem('dashboardPassword');
    renderAccountSettings();
  }

  function clearAuthLocalState() {
    accessToken = null;
    refreshToken = null;
    dashboardUser = null;
    dashboardLoggedIn = false;
    dashboardSubscriptionTier = 'Free';
    adminMode = false;
    singleClientOnly = true;
    localStorage.removeItem('accessToken');
    localStorage.removeItem('refreshToken');
    localStorage.removeItem('dashboardLoggedIn');
    localStorage.removeItem('dashboardUsername');
    localStorage.removeItem('dashboardPassword');
  }

  function finishSignOutUi() {
    setOverlayLoginError('');
    if (overlayEmailInput) overlayEmailInput.value = localStorage.getItem('lastLoginEmail') || '';
    if (overlayPasswordInput) overlayPasswordInput.value = '';
    resetOverlayPasswordVisibility();
    if (disconnectOverlay) disconnectOverlay.setAttribute('data-mode', 'signin');
    var sub = document.getElementById('disconnect-auth-subtitle');
    if (sub) sub.textContent = 'Sign in to your account';
    if (settingsOverlay) settingsOverlay.classList.add('hidden');
    renderAccountSettings();
    updateDashboardAvailabilityUi();
    applyAccountPermissions();
  }

  function authErrorDetail(data, fallback) {
    var d = data && data.detail;
    if (typeof d === 'string') return d;
    if (Array.isArray(d) && d.length && d[0] && d[0].msg) return String(d[0].msg);
    if (data && typeof data.error === 'string') return data.error;
    if (data && typeof data.message === 'string') return data.message;
    return fallback || 'The auth server did not return an error message.';
  }

  function fetchAuthWithTimeout(url, options, timeoutMs, timeoutMessage) {
    var controller = new AbortController();
    var timer = setTimeout(function () {
      try { controller.abort(); } catch (_e) {}
    }, timeoutMs || 15000);
    var opts = Object.assign({}, options || {}, { signal: controller.signal });
    return fetch(url, opts)
      .catch(function (err) {
        if (err && err.name === 'AbortError') {
          throw new Error(timeoutMessage || 'Auth request timed out. Restart dev mode if this keeps happening.');
        }
        throw err;
      })
      .finally(function () {
        clearTimeout(timer);
      });
  }

  function readAuthResponse(r, fallback) {
    return r.text().then(function (text) {
      var data = {};
      try {
        data = text ? JSON.parse(text) : {};
      } catch (_e) {
        data = {};
      }
      if (!r.ok) throw new Error(authErrorDetail(data, fallback || ('Auth request failed with HTTP ' + r.status + '.')));
      return data;
    });
  }

  function authDisplayError(err, fallback) {
    var msg = err && err.message ? String(err.message) : '';
    if (/failed to fetch|networkerror|load failed/i.test(msg)) {
      return 'Could not reach the local dashboard server. Restart dev mode and try again.';
    }
    return msg || fallback || 'Auth request failed.';
  }

  function tryRefreshToken() {
    if (!refreshToken) return Promise.resolve(false);
    return fetchAuthWithTimeout('/api/auth/refresh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: refreshToken }),
    }, 15000, 'Session refresh timed out. Please sign in again.')
      .then(function (r) {
        return r.json().catch(function () { return {}; }).then(function (data) {
          if (!r.ok) return false;
          if (data.access_token) accessToken = data.access_token;
          if (data.refresh_token) refreshToken = data.refresh_token;
          persistDashboardLoginState();
          return true;
        });
      })
      .catch(function () {
        return false;
      });
  }

  function fetchCurrentUser(allowRefreshRetry) {
    if (!accessToken) {
      return Promise.reject(new Error('No token'));
    }
    return fetchAuthWithTimeout('/api/auth/me', {
      headers: { Authorization: 'Bearer ' + accessToken },
    }, 15000, 'Profile lookup timed out. Restart dev mode if this keeps happening.')
      .then(function (r) {
        return r.text().then(function (text) {
          var data = {};
          try {
            data = text ? JSON.parse(text) : {};
          } catch (e) {
            data = {};
          }
          if (r.status === 401 && allowRefreshRetry !== false && refreshToken) {
            return tryRefreshToken().then(function (ok) {
              if (ok) return fetchCurrentUser(false);
              clearAuthLocalState();
              finishSignOutUi();
              return Promise.reject(new Error('Session expired'));
            });
          }
          if (!r.ok) {
            var msg = authErrorDetail(data, 'Could not load your account profile.');
            if (r.status === 401) {
              clearAuthLocalState();
              finishSignOutUi();
            }
            throw new Error(msg);
          }
          return data;
        });
      })
      .then(function (profile) {
        // Admin dev: force is_admin true so the toggle is always enabled.
        profile.is_admin = true;
        dashboardUser = profile;
        dashboardLoggedIn = true;
        persistDashboardLoginState();
        updateDashboardAvailabilityUi();
        renderAccountSettings();
        // Fetch billing first so dashboardSubscriptionTier is set before applying permissions
        refreshAccountBillingFromApi();
        applyAccountPermissions();
        return profile;
      });
  }

  /**
   * Apply UI permissions based on the authenticated account.
   * - Admins: enable admin mode, can toggle single-client
   * - Non-admins: force adminMode=false, singleClientOnly=true, lock both
   * - Basic tier (or higher): show developer settings tab
   * - Free tier: hide developer settings tab
   * Called after every successful login/profile fetch.
   */
  function applyAccountPermissions() {
    var isAdmin = !!(dashboardUser && dashboardUser.is_admin);
    var tier = (dashboardSubscriptionTier || 'Free').toLowerCase();
    var hasDeveloper = tier === 'premium' || tier === 'basic' || tier === 'developer';

    // Admin dev: adminMode not forced off for non-admins — let the toggle control it.
    _realAdminMode = adminMode;  // capture real state for view-as override resets

    // If a non-admin somehow has a view-as override active, drop it.
    if (!isAdmin && viewAsOverride) {
      viewAsOverride = null;
      var vSel = document.getElementById('setting-view-as');
      if (vSel) vSel.value = '';
    }

    applyAdminMode();

    // Lock singleClientOnly to true for non-admins
    if (!isAdmin) {
      singleClientOnly = true;
      if (ws && ws.readyState === 1) {
        ws.send(JSON.stringify({ type: 'updateSingleClientOnly', value: true }));
      }
    }
    if (singleClientOnlyToggle) {
      singleClientOnlyToggle.checked = singleClientOnly;
      singleClientOnlyToggle.disabled = !isAdmin;
      var scoRow = singleClientOnlyToggle.closest('.settings-row');
      if (scoRow) scoRow.classList.toggle('settings-row--locked', !isAdmin);
    }

    // Developer settings tab: only for Developer-tier or admins
    var devSettingsTab = document.getElementById('settings-tab-developer');
    if (devSettingsTab) {
      devSettingsTab.classList.toggle('hidden', !hasDeveloper && !isAdmin);
    }

    // Admin settings tab: only for admins
    var adminSettingsTab = document.getElementById('settings-tab-admin');
    if (adminSettingsTab) {
      adminSettingsTab.classList.toggle('hidden', !isAdmin);
    }

    // Fall back active settings tab if no longer accessible
    if (!hasDeveloper && !isAdmin && activeSettingsTab === 'developer') {
      setActiveSettingsTab('visual');
    }
    if (!isAdmin && activeSettingsTab === 'admin') {
      setActiveSettingsTab('visual');
    }

    // Send tokens to DevServer so plugins use the same session (no separate login)
    if (accessToken && ws && ws.readyState === 1) {
      ws.send(JSON.stringify({
        type: 'dashboardToken',
        access_token: accessToken,
        refresh_token: refreshToken || null,
        is_admin: !!(dashboardUser && dashboardUser.is_admin),
        developer_mode: !!(dashboardUser && dashboardUser.developer_mode),
      }));
    }
  }

  function restoreDashboardSessionFromTokens() {
    if (!accessToken) return Promise.resolve(false);
    return fetchCurrentUser(true).then(function () { return true; }).catch(function () { return false; });
  }

  function signOutDashboard() {
    var tok = accessToken;
    if (tok) {
      fetch('/api/auth/signout', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer ' + tok,
        },
      }).finally(function () {
        clearAuthLocalState();
        finishSignOutUi();
      });
    } else {
      clearAuthLocalState();
      finishSignOutUi();
    }
  }

  function setOverlayAuthMode(mode) {
    if (!disconnectOverlay) return;
    disconnectOverlay.setAttribute('data-mode', mode === 'register' ? 'register' : 'signin');
    var sub = document.getElementById('disconnect-auth-subtitle');
    if (sub) sub.textContent = mode === 'register' ? 'Create a Realm Engine account' : 'Sign in to your Realm Engine account';
    var notice = document.getElementById('disconnect-auth-notice');
    if (notice) notice.textContent = mode === 'register'
      ? 'Do not use your Realm password. Create a new password for Realm Engine.'
      : 'This is not your Realm account. Use the credentials you created for Realm Engine.';
    setOverlayLoginError('');
    resetOverlayPasswordVisibility();
  }

  function openDashboardTab(tabName) {
    var btn = document.querySelector('.content-tab[data-tab="' + String(tabName) + '"]');
    if (!btn) return;
    if (btn.classList.contains('admin-only') && !adminMode) return;
    if (btn.classList.contains('dev-only') && !devMode) return;
    btn.click();
  }

  /**
   * Fire an anonymous product-analytics event. Forwarded to bot-api by DevServer
   * — the browser never holds the access token. Safe to no-op when WS is down.
   */
  function trackEvent(eventName, props) {
    if (!ws || ws.readyState !== 1) return;
    try {
      ws.send(JSON.stringify({
        type: 'trackEvent',
        event: String(eventName || ''),
        props: props && typeof props === 'object' ? props : undefined,
      }));
    } catch (_e) { /* swallow */ }
  }
  // Expose for inline handlers + cross-module callers.
  window._trackEvent = trackEvent;

  var splashDismissed = false;
  function updateDashboardAvailabilityUi() {
    // Don't show/hide login overlay while splash is still covering the screen
    if (!splashDismissed && document.getElementById('app-splash')) return;
    if (disconnectOverlay) disconnectOverlay.classList.toggle('hidden', dashboardLoggedIn);
    if (!dashboardLoggedIn) closeSettingsPopout();
    var titlebar = document.getElementById('titlebar');
    if (titlebar) titlebar.style.display = dashboardLoggedIn ? '' : 'none';
    // Hide settings cog when not logged in
    var settingsBtn = document.getElementById('btn-settings');
    if (settingsBtn) settingsBtn.style.display = dashboardLoggedIn ? '' : 'none';
  }

  function formatHomeDuration(ms) {
    var total = Math.max(0, Math.floor(Number(ms || 0) / 1000));
    var h = Math.floor(total / 3600);
    var m = Math.floor((total % 3600) / 60);
    var s = total % 60;
    if (h > 0) return h + 'h ' + m + 'm ' + s + 's';
    if (m > 0) return m + 'm ' + s + 's';
    return s + 's';
  }

  function formatHomeTime(ts) {
    if (!ts) return '--';
    var d = new Date(ts);
    return d.toLocaleTimeString();
  }

  function setHomeActionStatus(text) {
    homeActionStatus = String(text || '');
    homeActionStatusAt = Date.now();
    if (activeTab === 'home') renderHomeTab();
  }

  function addHomeFeed(level, message) {
    homeFeed.push({
      at: Date.now(),
      level: String(level || 'info'),
      message: String(message || ''),
    });
    if (homeFeed.length > 250) homeFeed.shift();
    if (activeTab === 'home') renderHomeTab();
  }

  function startHomeScriptTimer() {
    if (!homeStats.scriptRunningSince) homeStats.scriptRunningSince = Date.now();
  }

  function stopHomeScriptTimer() {
    if (!homeStats.scriptRunningSince) return;
    homeStats.scriptRuntimeMs += Math.max(0, Date.now() - homeStats.scriptRunningSince);
    homeStats.scriptRunningSince = 0;
  }

  function getHomeScriptRuntimeMs() {
    return homeStats.scriptRuntimeMs + (homeStats.scriptRunningSince ? Math.max(0, Date.now() - homeStats.scriptRunningSince) : 0);
  }

  function formatHomeFpm(value) {
    var num = Number(value || 0);
    if (!Number.isFinite(num) || num <= 0) return '0';
    var rounded = Math.round(num * 10) / 10;
    return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
  }

  function clearHomeStatsForNewSession() {
    homeStats = {
      startedAt: Date.now(),
      fameGained: 0,
      averageFpm: 0,
      packetsProcessed: 0,
      teleports: 0,
      reconnects: 0,
      deaths: 0,
      pluginTriggers: 0,
      scriptRuntimeMs: 0,
      scriptRunningSince: 0,
    };
  }

  function tickHomeLiveStats() {
    if (activeTab !== 'home') return;
    var uptimeEl = document.getElementById('home-conn-uptime');
    if (uptimeEl) uptimeEl.textContent = formatHomeDuration(Date.now() - homeStats.startedAt);

    var scriptRuntimeEl = document.getElementById('home-script-runtime');
    if (scriptRuntimeEl) {
      scriptRuntimeEl.textContent = formatHomeDuration(runnerState === 'idle' ? homeLastCompletedScript.durationMs : getHomeScriptRuntimeMs());
    }

    var sessionUptimeEl = document.getElementById('home-stat-uptime');
    if (sessionUptimeEl) sessionUptimeEl.textContent = formatHomeDuration(Date.now() - homeStats.startedAt);
    var sessionFameGainedEl = document.getElementById('home-stat-fame-gained');
    if (sessionFameGainedEl) sessionFameGainedEl.textContent = Number(homeStats.fameGained || 0).toLocaleString();
    var sessionAverageFpmEl = document.getElementById('home-stat-average-fpm');
    if (sessionAverageFpmEl) sessionAverageFpmEl.textContent = formatHomeFpm(homeStats.averageFpm);
    var multiFameGainedEl = document.getElementById('home-multi-fame-gained');
    if (multiFameGainedEl) multiFameGainedEl.textContent = Number(homeStats.fameGained || 0).toLocaleString();
    var multiAverageFpmEl = document.getElementById('home-multi-average-fpm');
    if (multiAverageFpmEl) multiAverageFpmEl.textContent = formatHomeFpm(homeStats.averageFpm);
    var multiRuntimeEl = document.getElementById('home-multi-runtime');
    if (multiRuntimeEl) multiRuntimeEl.textContent = formatHomeDuration(getMultiHomeRuntimeMs());
    if (macPopoutOpenClientId) {
      var popoutClient = connectedClients.get(macPopoutOpenClientId);
      var popoutRuntimeEl = document.getElementById('mac-popout-runtime-value');
      if (popoutRuntimeEl && popoutClient) {
        var popoutStartedAt = getClientConnectedAtMs(macPopoutOpenClientId, popoutClient);
        popoutRuntimeEl.textContent = formatHomeDuration(Math.max(0, Date.now() - popoutStartedAt));
      }
      var popoutScriptRuntimeEl = document.getElementById('mac-popout-script-runtime-value');
      if (popoutScriptRuntimeEl) {
        var popoutScriptId = getMacScriptSelection(macPopoutOpenClientId);
        var popoutScriptData = (scriptsTabLastData.scripts || []).find(function (s) { return String(s.id || '') === String(popoutScriptId || ''); });
        var popoutScriptRunning = !!popoutScriptData && String(popoutScriptData.status || '') === 'running';
        popoutScriptRuntimeEl.textContent = popoutScriptRunning ? formatHomeDuration(getHomeScriptRuntimeMs()) : '0s';
      }
    }

    var actionStatusEl = document.getElementById('home-action-status');
    if (actionStatusEl) {
      if (homeActionStatus && (Date.now() - homeActionStatusAt) < 7000) actionStatusEl.textContent = homeActionStatus;
      else actionStatusEl.textContent = '';
    }
  }

  function startHomeLiveTicker() {
    if (homeLiveTicker) return;
    homeLiveTicker = setInterval(tickHomeLiveStats, 1000);
  }

  function getHomeCurrentStatus(script) {
    var runningStatus = runContext && runContext.state ? String(runContext.state.__currentStatus || '').trim() : '';
    if (runnerState === 'paused') return t('home.script.state.paused');
    if (runnerState === 'idle') return t('home.script.state.idle');
    return runningStatus || '--';
  }

  function wireHomeControls() {
    if (homeControlsWired) return;
    homeControlsWired = true;

    var launchButtons = [
      document.getElementById('home-conn-launch-btn'),
      document.getElementById('home-quick-launch-btn'),
      document.getElementById('home-disconnected-launch-btn'),
    ];
    launchButtons.forEach(function (btn) {
      if (!btn) return;
      btn.addEventListener('click', function () {
        var account = getSelectedDashboardAccount();
        if (account && String(account.email || '').trim() && String(account.password || '')) {
          launchGameWithCredentials(
            String(account.email || '').trim(),
            String(account.password || ''),
            String(account.serverName || 'USWest').trim() || 'USWest',
            undefined,
            launchOptsWithAccount(account, {}),
          );
          addHomeFeed('act', tr('home.action.launchRequested', { name: String(account.label || account.email || t('accounts.summary.defaultName')) }));
          setHomeActionStatus(t('home.action.launchSent'));
        } else {
          openDashboardTab('accounts');
          setHomeActionStatus(t('home.action.needCredentials'));
        }
      });
    });

    var reconnectBtn = document.getElementById('home-conn-reconnect-btn');
    if (reconnectBtn) {
      reconnectBtn.addEventListener('click', function () {
        if (ws && ws.readyState === 1) ws.close();
        addHomeFeed('warn', 'Reconnect requested.');
        setHomeActionStatus(t('home.action.reconnecting'));
      });
    }

    var feedClearBtn = document.getElementById('home-feed-clear-btn');
    if (feedClearBtn) {
      feedClearBtn.addEventListener('click', function () {
        homeFeed = [];
        addHomeFeed('info', t('home.feed.cleared'));
      });
    }

    var feedOpenLogsBtn = document.getElementById('home-feed-open-logs-btn');
    if (feedOpenLogsBtn) {
      feedOpenLogsBtn.addEventListener('click', function () {
        if (!adminMode) {
          setHomeActionStatus(t('home.action.adminLogs'));
          addHomeFeed('warn', 'Open Logs blocked: Admin Mode is disabled.');
          return;
        }
        openDashboardTab('logs');
      });
    }

    var scriptPrimaryBtn = document.getElementById('home-script-primary-btn');
    if (scriptPrimaryBtn) {
      scriptPrimaryBtn.addEventListener('click', function () {
        var id = String(selectedScriptId || '');
        if (!id) return;
        fetch('/api/scripts/start', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: id }) })
          .then(function(r) { return r.json(); })
          .then(function() { populateScriptSelect(); })
          .catch(function() {});
      });
    }

    var scriptPauseToggleBtn = document.getElementById('home-script-pause-toggle-btn');
    if (scriptPauseToggleBtn) {
      scriptPauseToggleBtn.addEventListener('click', function () {
        var id = String(selectedScriptId || '');
        if (!id) return;
        fetch('/api/scripts/stop', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: id }) })
          .then(function(r) { return r.json(); })
          .then(function() { populateScriptSelect(); })
          .catch(function() {});
      });
    }


    var quickNexusBtn = document.getElementById('home-quick-nexus-btn');
    if (quickNexusBtn) {
      quickNexusBtn.addEventListener('click', function () {
        fetch('/api/client/escape', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
          .then(function (r) { return r.json(); })
          .then(function (result) {
            if (result && result.ok) {
              homeStats.teleports++;
              addHomeFeed('act', t('home.action.nexusOk'));
              setHomeActionStatus(t('home.action.nexusOk'));
            } else {
              addHomeFeed('err', result && result.message ? result.message : t('home.action.nexusFail'));
              setHomeActionStatus(result && result.message ? result.message : t('home.action.nexusFail'));
            }
          })
          .catch(function () {
            addHomeFeed('err', t('home.action.nexusReqFail'));
            setHomeActionStatus(t('home.action.nexusReqFail'));
          });
      });
    }

    var quickRunLastBtn = document.getElementById('home-quick-run-last-btn');
    if (quickRunLastBtn) {
      quickRunLastBtn.addEventListener('click', function () {
        openDashboardTab('scripts');
        setHomeActionStatus(t('home.action.useScriptsJs'));
      });
    }

    var quickPluginCfgBtn = document.getElementById('home-quick-plugin-config-btn');
    if (quickPluginCfgBtn) {
      quickPluginCfgBtn.addEventListener('click', function () {
        activateContentTab('settings');
        setActiveSettingsTab('developer');
        loadPluginConfigs();
      });
    }

    var quickCopyPosBtn = document.getElementById('home-quick-copy-pos-btn');
    if (quickCopyPosBtn) {
      quickCopyPosBtn.addEventListener('click', function () {
        var pos = lastPlayerData && lastPlayerData.pos;
        if (!pos) {
          setHomeActionStatus(t('home.action.noPosition'));
          return;
        }
        var text = Math.round(Number(pos.x || 0)) + ', ' + Math.round(Number(pos.y || 0));
        if (navigator && navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
          navigator.clipboard.writeText(text).then(function () {
            setHomeActionStatus(tr('home.action.copiedPos', { text: text }));
          }).catch(function () {
            setHomeActionStatus(t('home.action.copyFailed'));
          });
        } else {
          setHomeActionStatus(t('home.action.noClipboard'));
        }
      });
    }

    var hsAccountsSearch = document.getElementById('hs-accounts-search');
    if (hsAccountsSearch) {
      hsAccountsSearch.addEventListener('input', function () {
        renderHomeAccounts();
      });
    }
  }

  function renderHomeFeed() {
    var feedList = document.getElementById('home-feed-list');
    if (!feedList) return;
    feedList.innerHTML = '';
    if (!homeFeed.length) {
      var empty = document.createElement('div');
      empty.className = 'home-note';
      empty.textContent = t('home.feed.empty');
      feedList.appendChild(empty);
      return;
    }
    var recent = homeFeed.slice(-50);
    recent.forEach(function (entry) {
      var row = document.createElement('div');
      row.className = 'home-feed-row';
      var levelClass = entry.level === 'ok' ? 'ok'
        : (entry.level === 'warn' ? 'warn'
          : (entry.level === 'err' ? 'err'
            : (entry.level === 'act' ? 'act' : 'info')));
      row.innerHTML =
        '<span class="home-feed-time">' + escapeHtml(formatHomeTime(entry.at)) + '</span>' +
        '<span class="home-feed-level ' + levelClass + '">' + escapeHtml(levelClass.toUpperCase()) + '</span>' +
        '<span class="home-feed-msg">' + escapeHtml(entry.message) + '</span>';
      feedList.appendChild(row);
    });
    feedList.scrollTop = feedList.scrollHeight;
  }

  function renderHomeTab() {
    wireHomeControls();
    var connectedLayout = document.getElementById('home-connected-layout');
    var multiLayout = document.getElementById('home-multi-layout');
    var disconnectedLayout = document.getElementById('home-disconnected-layout');
    if (!connectedLayout) return;

    var isConnected = !!gameConnected;
    var useMultiHome = isMacMultiHome();
    var useMultiboxEmpty = accountLayoutMode === 'multibox';
    var multiPlaceholder = document.getElementById('home-multibox-placeholder');
    var homeToolbar = document.getElementById('home-toolbar');
    if (disconnectedLayout) {
      connectedLayout.classList.toggle('hidden', !isConnected || useMultiHome || useMultiboxEmpty);
      if (multiLayout) multiLayout.classList.toggle('hidden', !isConnected || !useMultiHome || useMultiboxEmpty);
      disconnectedLayout.classList.toggle('hidden', isConnected || useMultiboxEmpty);
    } else {
      connectedLayout.classList.toggle('hidden', useMultiHome || useMultiboxEmpty);
      if (multiLayout) multiLayout.classList.toggle('hidden', !useMultiHome || useMultiboxEmpty);
    }
    if (multiPlaceholder) {
      multiPlaceholder.classList.toggle('hidden', !useMultiboxEmpty);
      multiPlaceholder.setAttribute('aria-hidden', useMultiboxEmpty ? 'false' : 'true');
    }
    if (homeToolbar) homeToolbar.classList.toggle('hidden', useMultiHome || useMultiboxEmpty);
    if (useMultiHome) {
      renderMultiHomeTab();
      return;
    }
    if (useMultiboxEmpty) {
      return;
    }

    var dot = document.getElementById('home-conn-dot');
    var state = document.getElementById('home-conn-state');
    var proxyEl = document.getElementById('home-conn-proxy');
    var clientEl = document.getElementById('home-conn-client');
    var serverEl = document.getElementById('home-conn-server');
    var uptimeEl = document.getElementById('home-conn-uptime');

    var wsLive = !!ws && ws.readyState === 1;
    var statusLabel = isConnected ? t('status.connected') : (wsLive ? t('status.connecting') : t('status.disconnected'));
    if (dot) {
      dot.classList.remove('home-dot-green', 'home-dot-yellow', 'home-dot-red');
      dot.classList.add(isConnected ? 'home-dot-green' : (wsLive ? 'home-dot-yellow' : 'home-dot-red'));
    }
    if (state) state.textContent = statusLabel;
    if (proxyEl) proxyEl.textContent = t('home.conn.listening');
    if (clientEl) clientEl.textContent = isConnected ? t('home.conn.clientDetected') : t('home.conn.clientWaiting');
    if (serverEl) {
      var serverLabel = String((lastPlayerData && lastPlayerData.server) || currentServerName || '--');
      var selectedText = (serverSelect && serverSelect.selectedOptions && serverSelect.selectedOptions[0])
        ? String(serverSelect.selectedOptions[0].textContent || '')
        : '';
      var pingSuffix = selectedText.indexOf('—') >= 0 ? selectedText.slice(selectedText.indexOf('—')) : '';
      var pingMatch = selectedText.match(/(\?|\d+)\s*ms/i);
      pingSuffix = pingMatch ? ('- ' + pingMatch[1] + 'ms') : '';
      serverEl.textContent = serverLabel === '--' ? '--' : (serverLabel + (pingSuffix ? ' ' + pingSuffix : ''));
    }
    if (uptimeEl) uptimeEl.textContent = formatHomeDuration(Date.now() - homeStats.startedAt);

    var charName = document.getElementById('home-char-name');
    var charMeta = document.getElementById('home-char-meta');
    var hpFill = document.getElementById('home-char-hp-fill');
    var mpFill = document.getElementById('home-char-mp-fill');
    var hpText = document.getElementById('home-char-hp-text');
    var mpText = document.getElementById('home-char-mp-text');
    var charStats = document.getElementById('home-char-stats');
    var charFame = document.getElementById('home-char-fame');
    var charGuild = document.getElementById('home-char-guild');
    var charMap = document.getElementById('home-char-map');
    var charServer = document.getElementById('home-char-server');
    var charPos = document.getElementById('home-char-pos');
    var effects = document.getElementById('home-char-effects');
    var pd = lastPlayerData || {};

    if (charName) charName.textContent = String(pd.name || 'No character data');
    if (charMeta) {
      var className = CLASS_NAMES[pd.classType] || 'Unknown';
      charMeta.textContent = pd.name ? (className + ' • Lv ' + String(pd.level || 1) + ' • ' + String(pd.stars != null ? pd.stars : '--') + ' stars') : 'Waiting for game connection';
    }
    if (charMeta && pd.name) {
      var classNameAscii = CLASS_NAMES[pd.classType] || 'Unknown';
      charMeta.textContent = classNameAscii + ' - Lv ' + String(pd.level || 1) + ' - ' + String(pd.stars != null ? pd.stars : '--') + ' stars';
    }
    var hp = Number(pd.hp || 0);
    var maxHp = Math.max(1, Number(pd.maxHp || 0));
    var mp = Number(pd.mana || 0);
    var maxMp = Math.max(1, Number(pd.maxMana || 0));
    if (hpFill) hpFill.style.width = Math.max(0, Math.min(100, (hp / maxHp) * 100)) + '%';
    if (mpFill) mpFill.style.width = Math.max(0, Math.min(100, (mp / maxMp) * 100)) + '%';
    var hpExtra = buildGearExaltBonusSuffix(pd.healthBonus, pd.exaltedMaxHP);
    var mpExtra = buildGearExaltBonusSuffix(pd.manaBonus, pd.exaltedMaxMP);
    if (hpText) hpText.textContent = (pd.hp != null ? String(pd.hp) : '--') + ' / ' + (pd.maxHp != null ? String(pd.maxHp) : '--') + (hpExtra ? ' ' + hpExtra : '');
    if (mpText) mpText.textContent = (pd.mana != null ? String(pd.mana) : '--') + ' / ' + (pd.maxMana != null ? String(pd.maxMana) : '--') + (mpExtra ? ' ' + mpExtra : '');
    if (charStats) {
      charStats.innerHTML =
        '<div>ATK ' + escapeHtml(formatPlayerStatLine(pd.attack, pd.attackBonus, pd.exaltedAttack)) + '</div>' +
        '<div>DEF ' + escapeHtml(formatPlayerStatLine(pd.defense, pd.defenseBonus, pd.exaltedDefense)) + '</div>' +
        '<div>SPD ' + escapeHtml(formatPlayerStatLine(pd.speed, pd.speedBonus, pd.exaltedSpeed)) + '</div>' +
        '<div>DEX ' + escapeHtml(formatPlayerStatLine(pd.dexterity, pd.dexterityBonus, pd.exaltedDexterity)) + '</div>' +
        '<div>VIT ' + escapeHtml(formatPlayerStatLine(pd.vitality, pd.vitalityBonus, pd.exaltedVitality)) + '</div>' +
        '<div>WIS ' + escapeHtml(formatPlayerStatLine(pd.wisdom, pd.wisdomBonus, pd.exaltedWisdom)) + '</div>';
    }
    if (charFame) charFame.textContent = (pd.fame != null) ? Number(pd.fame).toLocaleString() : '--';
    if (charGuild) charGuild.textContent = String(pd.guild || '--');
    if (charMap) charMap.textContent = String(pd.map || '--');
    if (charServer) charServer.textContent = String(pd.server || '--');
    if (charPos) {
      if (pd.pos && Number.isFinite(Number(pd.pos.x)) && Number.isFinite(Number(pd.pos.y))) {
        charPos.textContent = Math.round(Number(pd.pos.x)) + ', ' + Math.round(Number(pd.pos.y));
      } else charPos.textContent = '--';
    }
    if (effects) {
      effects.innerHTML = '';
      var rawEffects = pd.effects && typeof pd.effects === 'object' ? pd.effects : {};
      Object.keys(rawEffects).slice(0, 12).forEach(function (key) {
        if (!rawEffects[key]) return;
        var badge = document.createElement('span');
        badge.className = 'home-badge';
        badge.textContent = String(key);
        effects.appendChild(badge);
      });
    }

    // Portrait
    var portraitEl = document.getElementById('hs-char-portrait');
    if (portraitEl) {
      if (pd.classType != null && pd.name) {
        var ct = Number(pd.classType);
        portraitEl.style.backgroundImage = 'url(' + renderClassSprite(ct) + ')';
        if (typeof window.renderEamPortrait === 'function') {
          var sk = pd.skin ? Number(pd.skin) : ct;
          var tx1 = pd.tex1 ? Number(pd.tex1) : 0;
          var tx2 = pd.tex2 ? Number(pd.tex2) : 0;
          window.renderEamPortrait(ct, sk, tx1, tx2).then(function (url) {
            if (url && portraitEl) portraitEl.style.backgroundImage = 'url(' + url + ')';
          }).catch(function () {});
        }
      } else {
        portraitEl.style.backgroundImage = '';
      }
    }

    // Equipment (first 4 inventory slots: weapon, ability, armor, ring)
    var equipEl = document.getElementById('hs-char-equip');
    if (equipEl) {
      var liveEquip = buildLiveEquipmentItemsFromPlayerData(pd);
      equipEl.innerHTML = buildEquipmentSpriteStripHtml(liveEquip);
    }

    // Inventory (slots 4–11)
    var invEl = document.getElementById('hs-char-inventory');
    if (invEl) {
      var invRaw = Array.isArray(pd.inventory) ? pd.inventory.slice(4, 12) : [];
      while (invRaw.length < 8) invRaw.push({ objectType: -1 });
      var invItems = invRaw.map(function (token) {
        var ot = -1;
        if (token && typeof token === 'object') {
          ot = Number(token.objectType != null ? token.objectType : token.itemType);
        } else if (token != null) {
          ot = Number(token);
        }
        if (!Number.isFinite(ot)) ot = -1;
        return {
          objectType: ot,
          objectTypeHex: ot >= 0 ? ('0x' + ot.toString(16)) : '',
          name: '',
          uniqueId: token && token.uniqueId != null ? String(token.uniqueId) : null,
          enchantIds: [],
        };
      });
      invEl.innerHTML = '<div class="hs-inv-grid">' +
        invItems.map(function (item) { return buildItemSpriteHtml(item); }).join('') +
        '</div>';
    }

    var script = getScript();
    var scriptStateEl = document.getElementById('home-script-state');
    var scriptRuntimeEl = document.getElementById('home-script-runtime');
    var scriptStatusEl = document.getElementById('home-script-status');
    var scriptNoteEl = document.getElementById('home-script-note');
    var stateLabel = runnerState === 'running' ? t('home.script.state.running')
      : (runnerState === 'paused' ? t('home.script.state.paused') : t('home.script.state.idle'));
    if (scriptStateEl) scriptStateEl.textContent = stateLabel;
    if (scriptRuntimeEl) scriptRuntimeEl.textContent = formatHomeDuration(runnerState === 'idle' ? homeLastCompletedScript.durationMs : getHomeScriptRuntimeMs());
    if (scriptStatusEl) scriptStatusEl.textContent = getHomeCurrentStatus(script);
    if (scriptNoteEl) scriptNoteEl.textContent = '';
    var primaryBtn = document.getElementById('home-script-primary-btn');
    var pauseToggleBtn = document.getElementById('home-script-pause-toggle-btn');
    var scriptId = String(selectedScriptId || '');
    var scriptsList = Array.isArray(scriptsTabLastData && scriptsTabLastData.scripts) ? scriptsTabLastData.scripts : [];
    var scriptData = scriptsList.find(function(s) { return String(s.id || '') === scriptId; });
    var scriptRunning = scriptData && String(scriptData.status || '') === 'running';
    if (scriptStatusEl) scriptStatusEl.textContent = scriptData ? String(scriptData.status || '--') : '--';
    if (primaryBtn) {
      primaryBtn.textContent = 'Run';
      primaryBtn.disabled = !scriptId || scriptRunning;
      primaryBtn.classList.remove('home-script-stop-mode');
    }
    if (pauseToggleBtn) {
      pauseToggleBtn.textContent = 'Stop';
      pauseToggleBtn.disabled = !scriptId || !scriptRunning;
    }
    updateScriptCurrentDisplay();

    renderHomeFeed();
    renderHomeAccounts();

    var stats = [
      ['home-stat-uptime', formatHomeDuration(Date.now() - homeStats.startedAt)],
      ['home-stat-fame-gained', Number(homeStats.fameGained || 0).toLocaleString()],
      ['home-stat-average-fpm', formatHomeFpm(homeStats.averageFpm)],
      ['home-stat-white-bags', '0'],
      ['home-stat-events-killed', '0'],
      ['home-stat-dungeons-ran', '0'],
    ];
    stats.forEach(function (entry) {
      var el = document.getElementById(entry[0]);
      if (el) el.textContent = entry[1];
    });
    var actionStatusEl = document.getElementById('home-action-status');
    if (actionStatusEl) {
      if (homeActionStatus && (Date.now() - homeActionStatusAt) < 7000) actionStatusEl.textContent = homeActionStatus;
      else actionStatusEl.textContent = '';
    }

    var lastSessionEl = document.getElementById('home-last-session');
    var lastEndedEl = document.getElementById('home-last-ended');
    if (lastSessionEl) {
      if (homeLastSession.name) {
        lastSessionEl.textContent = tr('home.session.lastSession', {
          name: homeLastSession.name,
          duration: formatHomeDuration(homeLastSession.durationMs),
        });
      }
      else lastSessionEl.textContent = t('home.session.lastEmpty');
    }
    if (lastEndedEl) {
      lastEndedEl.textContent = homeLastSession.endedAt
        ? tr('home.session.ended', { time: formatHomeTime(homeLastSession.endedAt) })
        : t('home.session.endedEmpty');
    }
  }

  function getConnectedClientSnapshot(clientId, c) {
    var pd = c && c.fullData ? c.fullData : (c || {});
    var hp = Number(c && c.hp != null ? c.hp : (pd.hp || 0));
    var maxHp = Math.max(1, Number(c && c.maxHp != null ? c.maxHp : (pd.maxHp || 1)));
    var mp = Math.max(0, Number(pd.mana || 0));
    var maxMp = Math.max(1, Number(pd.maxMana || 1));
    var classType = Number(pd.classType != null ? pd.classType : (c && c.classType));
    return {
      clientId: clientId,
      name: String(pd.name || c && c.name || 'Connecting...'),
      classType: Number.isFinite(classType) ? classType : 0,
      className: CLASS_NAMES[classType] || pd.class || 'Unknown',
      guild: String(pd.guild || c && c.guild || '').trim(),
      server: String(pd.server || c && c.server || '--'),
      map: String(pd.map || pd.mapName || '--'),
      /** Placeholder until STATS / client payload exposes real char id. */
      charIdDisplay: '--',
      pos: pd.pos || null,
      hp: hp,
      maxHp: maxHp,
      hpPct: Math.max(0, Math.min(1, hp / Math.max(1, maxHp))),
      mp: mp,
      maxMp: maxMp,
      mpPct: Math.max(0, Math.min(1, mp / Math.max(1, maxMp))),
      level: Number(pd.level || 0),
      fame: pd.fame != null ? Number(pd.fame) : null,
      attack: pd.attack,
      defense: pd.defense,
      speed: pd.speed,
      dexterity: pd.dexterity,
      vitality: pd.vitality,
      wisdom: pd.wisdom,
    };
  }

  function getClientConnectedAtMs(clientId, clientData) {
    if (connectedClientFirstSeenAt.has(clientId)) return Number(connectedClientFirstSeenAt.get(clientId) || 0);
    var raw = clientData && (clientData.connectedAt || clientData.connected_at || clientData.connectionStartedAt);
    var parsed = 0;
    if (typeof raw === 'number' && Number.isFinite(raw)) {
      parsed = raw > 1e12 ? raw : (raw > 1e9 ? raw * 1000 : 0);
    } else if (typeof raw === 'string' && raw.trim()) {
      var asNum = Number(raw);
      if (Number.isFinite(asNum) && asNum > 0) parsed = asNum > 1e12 ? asNum : (asNum > 1e9 ? asNum * 1000 : 0);
      if (!parsed) {
        var asDate = Date.parse(raw);
        if (Number.isFinite(asDate)) parsed = asDate;
      }
    }
    if (!parsed || !Number.isFinite(parsed)) parsed = Date.now();
    connectedClientFirstSeenAt.set(clientId, parsed);
    return parsed;
  }

  function getMultiHomeRuntimeMs() {
    if (!connectedClients.size) return 0;
    var earliestConnectedAt = Infinity;
    connectedClients.forEach(function (clientData, id) {
      var at = getClientConnectedAtMs(id, clientData);
      if (at > 0 && at < earliestConnectedAt) earliestConnectedAt = at;
    });
    if (!Number.isFinite(earliestConnectedAt)) return 0;
    return Math.max(0, Date.now() - earliestConnectedAt);
  }

  function persistMacScriptSelection() {
    try {
      localStorage.setItem('macScriptSelectionByClientId', JSON.stringify(macScriptSelectionByClientId || {}));
    } catch (_) {}
  }

  function getMacScriptSelection(clientId) {
    var key = String(clientId || '');
    return key ? String(macScriptSelectionByClientId[key] || '') : '';
  }

  function setMacScriptSelection(clientId, scriptId) {
    var key = String(clientId || '');
    if (!key) return;
    if (scriptId) macScriptSelectionByClientId[key] = String(scriptId);
    else delete macScriptSelectionByClientId[key];
    persistMacScriptSelection();
  }

  /**
   * Script picker snapshot for a connection: aligns MAC sidebar, popout, and home multi cards.
   */
  function computeMacScriptSelectionUi(clientId) {
    var scripts = Array.isArray(scriptsTabLastData && scriptsTabLastData.scripts) ? scriptsTabLastData.scripts : [];
    var selectedScriptId = getMacScriptSelection(clientId);
    if (!selectedScriptId && scripts.length) {
      selectedScriptId = String(scripts[0].id || '');
      setMacScriptSelection(clientId, selectedScriptId);
    }
    if (selectedScriptId && !scripts.some(function (s) { return String(s.id || '') === String(selectedScriptId); })) {
      selectedScriptId = '';
      setMacScriptSelection(clientId, '');
    }
    var selectedScript = scripts.find(function (s) { return String(s.id || '') === String(selectedScriptId || ''); }) || null;
    var selectedScriptStatus = selectedScript ? String(selectedScript.status || 'idle') : 'idle';
    var selectedScriptRunning = selectedScriptStatus === 'running';
    var scriptPillText = formatScriptStatusPillText(selectedScript, selectedScriptStatus);
    var scriptStatusClass =
      selectedScriptStatus === 'error'
        ? 'danger'
        : selectedScriptRunning
          ? 'active'
          : selectedScriptStatus !== 'idle'
            ? 'warning'
            : '';
    return {
      scripts: scripts,
      selectedScriptId: selectedScriptId,
      selectedScript: selectedScript,
      selectedScriptStatus: selectedScriptStatus,
      selectedScriptRunning: selectedScriptRunning,
      scriptPillText: scriptPillText,
      scriptStatusClass: scriptStatusClass,
    };
  }

  function refreshMacPopoutScriptPanel(clientId) {
    if (!macPopoutOpenClientId || macPopoutOpenClientId !== clientId) return;
    var selectEl = document.getElementById('mac-popout-script-select');
    var statusEl = document.getElementById('mac-popout-script-status-pill');
    var runtimeEl = document.getElementById('mac-popout-script-runtime-value');
    var runBtn = document.getElementById('mac-popout-script-run');
    var stopBtn = document.getElementById('mac-popout-script-stop');
    if (!selectEl || !statusEl || !runtimeEl || !runBtn || !stopBtn) return;

    var ui = computeMacScriptSelectionUi(clientId);
    var scripts = ui.scripts;
    var selectedScriptId = ui.selectedScriptId;

    var optionsHtml = '<option value="">-- Select Script --</option>';
    scripts.forEach(function (scriptRow) {
      var id = String(scriptRow.id || '');
      var isSelected = id && id === String(selectedScriptId || '');
      optionsHtml += '<option value="' + escapeHtml(id) + '"' + (isSelected ? ' selected' : '') + '>' + escapeHtml(String(scriptRow.name || id)) + '</option>';
    });
    selectEl.innerHTML = optionsHtml;
    selectEl.value = selectedScriptId || '';

    statusEl.textContent = ui.scriptPillText;
    statusEl.className = 'home-status-pill' + (ui.scriptStatusClass ? ' ' + ui.scriptStatusClass : '');
    runtimeEl.textContent = ui.selectedScriptRunning ? formatHomeDuration(getHomeScriptRuntimeMs()) : '0s';
    runBtn.disabled = !(selectedScriptId && !ui.selectedScriptRunning);
    stopBtn.disabled = !(selectedScriptId && ui.selectedScriptRunning);
  }

  function updateMacPopoutLiveFields(clientId) {
    if (!macPopoutOpenClientId || macPopoutOpenClientId !== clientId) return;
    var c = connectedClients.get(clientId);
    if (!c) return;
    macPopoutApplyPlayerData(clientId);
    var avatarDiv = document.getElementById('mac-popout-avatar');
    var pd = c.fullData || c;
    var classType = Number(pd.classType != null ? pd.classType : c.classType);
    if (avatarDiv && Number.isFinite(classType) && classType > 0 && !String(avatarDiv.style.backgroundImage || '').trim()) {
      avatarDiv.style.backgroundImage = 'url(' + renderClassSprite(classType) + ')';
      avatarDiv.style.backgroundSize = 'contain';
      avatarDiv.style.backgroundRepeat = 'no-repeat';
      avatarDiv.style.backgroundPosition = 'center';
      avatarDiv.style.imageRendering = 'pixelated';
    }
    refreshMacPopoutScriptPanel(clientId);
  }

  function updateMultiHomeHeroMetricsOnly() {
    var connectedCountEl = document.getElementById('home-multi-connected-count');
    var fameGainedEl = document.getElementById('home-multi-fame-gained');
    var averageFpmEl = document.getElementById('home-multi-average-fpm');
    var runtimeEl = document.getElementById('home-multi-runtime');
    var liveStatusEl = document.getElementById('home-multi-live-status');
    var primaryServerEl = document.getElementById('home-multi-primary-server');

    var clients = Array.from(connectedClients.entries()).map(function (entry) {
      return getConnectedClientSnapshot(entry[0], entry[1]);
    });

    var serverCounts = Object.create(null);
    clients.forEach(function (client) {
      var server = String(client.server || '--').trim();
      if (!server || server === '--') return;
      if (!serverCounts[server]) serverCounts[server] = 0;
      serverCounts[server] += 1;
    });
    var primaryServer = '--';
    var primaryServerCount = 0;
    Object.keys(serverCounts).forEach(function (server) {
      if (serverCounts[server] > primaryServerCount) {
        primaryServer = server;
        primaryServerCount = serverCounts[server];
      }
    });

    if (connectedCountEl) connectedCountEl.textContent = String(clients.length);
    if (fameGainedEl) fameGainedEl.textContent = Number(homeStats.fameGained || 0).toLocaleString();
    if (averageFpmEl) averageFpmEl.textContent = formatHomeFpm(homeStats.averageFpm);
    if (runtimeEl) runtimeEl.textContent = formatHomeDuration(getMultiHomeRuntimeMs());
    if (primaryServerEl) {
      primaryServerEl.textContent = primaryServer === '--'
        ? 'Primary server: --'
        : ('Primary server: ' + primaryServer + ' (' + String(primaryServerCount) + ')');
    }
    if (liveStatusEl) {
      var liveLabel = clients.length ? (String(clients.length) + ' live session' + (clients.length === 1 ? '' : 's')) : 'No live sessions';
      liveStatusEl.textContent = liveLabel;
      liveStatusEl.className = 'home-status-pill' + (clients.length ? ' active' : '');
    }
  }

  function renderMultiHomeTab() {
    updateMultiHomeHeroMetricsOnly();
    renderMultiAccountSidebar();
    renderMultiHomeConnectedCards();
  }

  function buildLiveEquipmentItemsFromPlayerData(pd) {
    var inventory = Array.isArray(pd && pd.inventory) ? pd.inventory : [];
    var equipmentTokens = inventory.slice(0, 4);
    if (!equipmentTokens.length) return [];
    return equipmentTokens.map(function (token) {
      var objectType = -1;
      var uniqueId = null;
      if (token && typeof token === 'object') {
        objectType = Number(token.objectType != null ? token.objectType : token.itemType);
        uniqueId = token.uniqueId != null ? String(token.uniqueId) : null;
      } else {
        objectType = Number(token);
      }
      if (!Number.isFinite(objectType)) objectType = -1;
      return {
        objectType: objectType,
        objectTypeHex: objectType >= 0 ? ('0x' + Number(objectType).toString(16)) : '',
        name: '',
        uniqueId: uniqueId,
        enchantIds: [],
      };
    });
  }

  /** When the script has not set RealmEngine.ui.status, show Idle/Running/Error (not raw lowercase). */
  function formatScriptEngineStatusForDisplay(engineStatusStr) {
    var s = String(engineStatusStr != null ? engineStatusStr : 'idle').toLowerCase();
    if (s === 'running') return 'Running';
    if (s === 'idle') return 'Idle';
    if (s === 'error') return 'Error';
    return String(engineStatusStr || '—');
  }

  /**
   * Backpack tier / slot-capacity telemetry from ScriptHost.activity — hide from cards/pills only.
   * (Slots still visible in MAC popout inventory; Developer tab can show tier code.)
   */
  function sanitizeScriptActivityForUi(activity) {
    if (activity == null || typeof activity !== 'string') return '';
    var t = String(activity).trim();
    if (!t) return '';
    var low = t.toLowerCase();
    if (/\bcarrying\s+slots?\b/.test(low)) return '';
    if (/\btier\s*\d+\s*[-–·]\s*\d+[^\n]*slots?/i.test(t)) return '';
    if (/\btotal\s*\(\s*\d+\s*equip/i.test(low)) return '';
    return t;
  }

  function summarizeScriptActivityHeadline(selectedScript, engineStatusStr) {
    var act = sanitizeScriptActivityForUi(selectedScript && selectedScript.activity);
    if (act) return act;
    if (!selectedScript) return 'No script';
    if (engineStatusStr === 'error') {
      var errText = String(selectedScript.error || 'Script error');
      return errText.length > 96 ? errText.slice(0, 93) + '…' : errText;
    }
    if (engineStatusStr === 'running') return 'Running';
    if (engineStatusStr === 'idle') return 'Idle';
    return formatScriptEngineStatusForDisplay(engineStatusStr);
  }

  function scriptHeroToneClass(engineStatusStr, activityTrimmed) {
    if (engineStatusStr === 'error') return 'home-multi-live-script-hero--error';
    if (activityTrimmed) return 'home-multi-live-script-hero--activity';
    if (engineStatusStr === 'running') return 'home-multi-live-script-hero--running';
    return 'home-multi-live-script-hero--idle';
  }

  function engineLifecycleLabel(selectedScript, engineStatusStr) {
    if (!selectedScript) return '—';
    if (engineStatusStr === 'error') return 'Error';
    if (engineStatusStr === 'running') return 'Running';
    if (engineStatusStr === 'idle') return 'Idle';
    return formatScriptEngineStatusForDisplay(engineStatusStr);
  }

  function engineLifecycleChipClass(engineStatusStr) {
    if (engineStatusStr === 'error') return 'danger';
    if (engineStatusStr === 'running') return 'active';
    return '';
  }

  /** Primary text for dashboard popouts when activity replaces engine status labels. */
  function formatScriptStatusPillText(selectedScript, engineStatusStr) {
    var act = sanitizeScriptActivityForUi(selectedScript && selectedScript.activity);
    if (act) return act.length > 44 ? act.slice(0, 42) + '…' : act;
    return selectedScript ? formatScriptEngineStatusForDisplay(engineStatusStr) : formatScriptEngineStatusForDisplay('idle');
  }

  function escapeAttrSelectorValue(value) {
    var s = String(value != null ? value : '');
    if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') return CSS.escape(s);
    return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  }

  /**
   * HTML inside .home-multi-live-head (everything above script Run/Stop controls).
   * Kept in sync when patching cards on playerData so the script <select> is not destroyed.
   */
  function buildMultiHomeLiveHeadInnerHtml(clientId, snap, raw, pd, scripts) {
    var hpPct = Math.max(0, Math.min(100, Math.round(Number(snap.hpPct || 0) * 100)));
    var mpPct = Math.max(0, Math.min(100, Math.round(Number(snap.mpPct || 0) * 100)));
    var hpColor = hpPct <= 20 ? '#f85149' : (hpPct <= 40 ? '#d29922' : '#3fb950');
    var mpColor = mpPct <= 20 ? '#8b5cf6' : (mpPct <= 40 ? '#388bfd' : '#58a6ff');
    var runtimeText = formatHomeDuration(Math.max(0, Date.now() - getClientConnectedAtMs(clientId, raw)));

    var selectedScriptId = getMacScriptSelection(clientId);
    if (!selectedScriptId && scripts.length) {
      selectedScriptId = String(scripts[0].id || '');
      setMacScriptSelection(clientId, selectedScriptId);
    }
    var selectedScript = scripts.find(function (s) { return String(s.id || '') === String(selectedScriptId || ''); }) || null;
    var selectedScriptStatus = selectedScript ? String(selectedScript.status || 'idle') : 'idle';

    var activityTrimmed = sanitizeScriptActivityForUi(selectedScript && selectedScript.activity);
    var headline = summarizeScriptActivityHeadline(selectedScript, selectedScriptStatus);
    var heroTone = scriptHeroToneClass(selectedScriptStatus, activityTrimmed);
    var lifecycleText = engineLifecycleLabel(selectedScript, selectedScriptStatus);
    var lifecyclePillMod = engineLifecycleChipClass(selectedScriptStatus);

    var heroSubSection = '';
    if (activityTrimmed) {
      heroSubSection =
        '<div class="home-multi-live-script-hero-sub">' +
          '<span class="home-multi-live-script-hero-lifecycle' +
          (lifecyclePillMod ? ' home-multi-live-script-hero-lifecycle--' + lifecyclePillMod : '') +
          '">' +
          escapeHtml(lifecycleText) +
          '</span>' +
        '</div>';
    }

    var liveEquipment = buildLiveEquipmentItemsFromPlayerData(pd);
    var gearHtml = liveEquipment.length
      ? buildEquipmentSpriteStripHtml(liveEquipment, 'home-multi-live-gear-strip')
      : '<div class="home-note">' + escapeHtml(t('home.equipment.none')) + '</div>';

    var charIdLabel = String(snap.charIdDisplay != null ? snap.charIdDisplay : '--');
    var mapLabel = String(snap.map != null ? snap.map : '--');
    var serverLabel = String(snap.server != null ? snap.server : '--');
    var posLabel = '--';
    var p = snap.pos;
    if (p && Number.isFinite(Number(p.x)) && Number.isFinite(Number(p.y))) {
      posLabel = Math.round(Number(p.x)) + ', ' + Math.round(Number(p.y));
    }

    return (
      '<div class="home-multi-live-ident">' +
        '<div class="home-multi-live-name-row">' +
          '<span class="home-multi-live-name">' + escapeHtml(String(snap.name || 'Unknown')) + '</span>' +
          '<span class="home-multi-live-charid-sep"> - </span>' +
          '<span class="home-multi-live-charid">' + escapeHtml(charIdLabel) + '</span>' +
          '<span class="home-multi-live-name-gap">·</span>' +
          '<span class="home-multi-live-class">' + escapeHtml(String(snap.className || 'Unknown')) + '</span>' +
        '</div>' +
        '<div class="home-multi-live-map-pos-row">' +
          '<span class="home-multi-live-pos-value" title="Position">' + escapeHtml(posLabel) + '</span>' +
          '<span class="home-multi-live-map-pos-gap">·</span>' +
          '<span class="home-multi-live-server-value" title="' + escapeHtml(t('detail.server')) + '">' + escapeHtml(serverLabel) + '</span>' +
          '<span class="home-multi-live-map-pos-gap">·</span>' +
          '<span class="home-multi-live-map-value" title="' + escapeHtml(t('detail.map')) + '">' + escapeHtml(mapLabel) + '</span>' +
        '</div>' +
        '<section class="home-multi-live-script-hero home-multi-live-script-hero--in-ident ' + heroTone + '" aria-label="Script activity">' +
          '<div class="home-multi-live-script-hero-main" title="' + escapeHtml(headline) + '">' + escapeHtml(headline) + '</div>' +
          heroSubSection +
        '</section>' +
        '<div class="home-multi-live-gear-hp-row">' +
          '<div class="home-multi-live-gear home-multi-live-gear--ident">' + gearHtml + '</div>' +
          '<div class="home-multi-live-bars-pair">' +
            '<div class="home-multi-live-hp-track" title="HP">' +
              '<div class="home-multi-live-hp-fill" style="width:' + hpPct + '%;background:' + hpColor + ';"></div>' +
              '<span class="home-multi-live-hp-inbar">' + escapeHtml(String(snap.hp)) + ' / ' + escapeHtml(String(snap.maxHp)) + '</span>' +
            '</div>' +
            '<div class="home-multi-live-hp-track home-multi-live-hp-track--mp" title="MP">' +
              '<div class="home-multi-live-mp-fill" style="width:' + mpPct + '%;background:' + mpColor + ';"></div>' +
              '<span class="home-multi-live-hp-inbar">' + escapeHtml(String(snap.mp)) + ' / ' + escapeHtml(String(snap.maxMp)) + '</span>' +
            '</div>' +
          '</div>' +
        '</div>' +
      '</div>' +
      '<span class="home-status-pill home-multi-live-connected-time" title="Time connected">' + escapeHtml(runtimeText) + '</span>'
    );
  }

  function patchMultiHomeConnectedCardDom(clientId) {
    var grid = document.getElementById('home-multi-connected-cards-grid');
    if (!grid || !isMacMultiHome() || activeTab !== 'home' || !connectedClients.has(clientId)) return false;
    var card = grid.querySelector('[data-multi-live-client-id="' + escapeAttrSelectorValue(clientId) + '"]');
    if (!card) return false;
    var raw = connectedClients.get(clientId);
    var pd = raw.fullData || raw;
    var snap = getConnectedClientSnapshot(clientId, raw);
    var scripts = Array.isArray(scriptsTabLastData && scriptsTabLastData.scripts) ? scriptsTabLastData.scripts : [];

    var head = card.querySelector('.home-multi-live-head');
    if (!head) return false;

    card.classList.toggle('active', clientId === multiHomeFocusedClientId);
    head.innerHTML = buildMultiHomeLiveHeadInnerHtml(clientId, snap, raw, pd, scripts);

    /* Run/Stop enablement depends on ScriptHost status — update without nuking controls */
    var selectedScriptId = getMacScriptSelection(clientId);
    if (!selectedScriptId && scripts.length) {
      selectedScriptId = String(scripts[0].id || '');
      setMacScriptSelection(clientId, selectedScriptId);
    }
    var selectedScript = scripts.find(function (s) { return String(s.id || '') === String(selectedScriptId || ''); }) || null;
    var selectedScriptStatus = selectedScript ? String(selectedScript.status || 'idle') : 'idle';
    var selectedScriptRunning = selectedScriptStatus === 'running';
    var runBtn = card.querySelector('[data-multi-live-script-run]');
    var stopBtn = card.querySelector('[data-multi-live-script-stop]');
    if (runBtn) runBtn.disabled = !(selectedScriptId && !selectedScriptRunning);
    if (stopBtn) stopBtn.disabled = !(selectedScriptId && selectedScriptRunning);

    return true;
  }

  function renderMultiHomeConnectedCards() {
    var grid = document.getElementById('home-multi-connected-cards-grid');
    if (!grid) return;
    grid.innerHTML = '';

    var clients = Array.from(connectedClients.entries()).map(function (entry) {
      return {
        clientId: entry[0],
        snapshot: getConnectedClientSnapshot(entry[0], entry[1]),
        raw: entry[1],
      };
    });
    if (!clients.length) {
      grid.innerHTML = '<div class="home-note">No connected accounts.</div>';
      return;
    }

    var scripts = Array.isArray(scriptsTabLastData && scriptsTabLastData.scripts) ? scriptsTabLastData.scripts : [];
    clients.forEach(function (entry) {
      var clientId = entry.clientId;
      var snap = entry.snapshot;
      var raw = entry.raw || {};
      var pd = raw.fullData || raw;

      var selectedScriptId = getMacScriptSelection(clientId);
      if (!selectedScriptId && scripts.length) {
        selectedScriptId = String(scripts[0].id || '');
        setMacScriptSelection(clientId, selectedScriptId);
      }
      var selectedScript = scripts.find(function (s) { return String(s.id || '') === String(selectedScriptId || ''); }) || null;
      var selectedScriptStatus = selectedScript ? String(selectedScript.status || 'idle') : 'idle';
      var selectedScriptRunning = selectedScriptStatus === 'running';

      var optionsHtml = '<option value="">-- Select Script --</option>';
      scripts.forEach(function (scriptRow) {
        var id = String(scriptRow.id || '');
        var isSelected = id && id === String(selectedScriptId || '');
        optionsHtml += '<option value="' + escapeHtml(id) + '"' + (isSelected ? ' selected' : '') + '>' + escapeHtml(String(scriptRow.name || id)) + '</option>';
      });

      var card = document.createElement('div');
      card.className = 'home-multi-live-card' + (clientId === multiHomeFocusedClientId ? ' active' : '');
      card.setAttribute('data-multi-live-client-id', clientId);

      card.innerHTML =
        '<div class="home-multi-live-head">' + buildMultiHomeLiveHeadInnerHtml(clientId, snap, raw, pd, scripts) + '</div>' +
        '<div class="home-multi-live-controls">' +
          '<select class="settings-select home-multi-live-script-select" data-multi-live-script-client="' + escapeHtml(clientId) + '">' + optionsHtml + '</select>' +
          '<div class="home-multi-live-script-btns">' +
            '<button type="button" class="setting-btn home-multi-live-script-btn" data-multi-live-script-run="' + escapeHtml(clientId) + '"' + ((selectedScriptId && !selectedScriptRunning) ? '' : ' disabled') + '>Run</button>' +
            '<button type="button" class="setting-btn setting-btn-secondary home-multi-live-script-btn" data-multi-live-script-stop="' + escapeHtml(clientId) + '"' + ((selectedScriptId && selectedScriptRunning) ? '' : ' disabled') + '>Stop</button>' +
          '</div>' +
        '</div>';
      grid.appendChild(card);

      card.addEventListener('click', function (e) {
        if (e.target.closest('.home-multi-live-controls')) return;
        multiHomeFocusedClientId = clientId;
        if (activeTab === 'home') renderHomeTab();
        openMacPopout(clientId);
      });
    });

    grid.querySelectorAll('[data-multi-live-script-client]').forEach(function (sel) {
      sel.addEventListener('change', function () {
        var clientId = String(sel.getAttribute('data-multi-live-script-client') || '');
        if (!clientId) return;
        setMacScriptSelection(clientId, String(sel.value || ''));
        renderMultiHomeConnectedCards();
      });
    });
    grid.querySelectorAll('[data-multi-live-script-run]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var clientId = String(btn.getAttribute('data-multi-live-script-run') || '');
        var scriptId = getMacScriptSelection(clientId);
        if (!scriptId) return;
        fetch('/api/scripts/start', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: scriptId }),
        })
          .then(function (r) { return r.json(); })
          .then(function () { return fetch('/api/scripts'); })
          .then(function (r) { return r.json(); })
          .then(function (data) {
            scriptsTabLastData = data || { scripts: [], dir: null };
            renderMultiHomeConnectedCards();
          })
          .catch(function () {});
      });
    });
    grid.querySelectorAll('[data-multi-live-script-stop]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var clientId = String(btn.getAttribute('data-multi-live-script-stop') || '');
        var scriptId = getMacScriptSelection(clientId);
        if (!scriptId) return;
        fetch('/api/scripts/stop', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: scriptId }),
        })
          .then(function (r) { return r.json(); })
          .then(function () { return fetch('/api/scripts'); })
          .then(function (r) { return r.json(); })
          .then(function (data) {
            scriptsTabLastData = data || { scripts: [], dir: null };
            renderMultiHomeConnectedCards();
          })
          .catch(function () {});
      });
    });

    if (!scripts.length) {
      fetch('/api/scripts')
        .then(function (r) { return r.json(); })
        .then(function (data) {
          scriptsTabLastData = data || { scripts: [], dir: null };
          renderMultiHomeConnectedCards();
        })
        .catch(function () {});
    }
  }

  /** 8×8 class sprite for MAC sidebar launch list (`mac-launch-row`). */
  function applyHomeAccountClassAvatar(avatarEl, bestCharacter, isLoading) {
    if (!avatarEl) return;
    avatarEl.classList.remove('home-account-class-avatar--loading', 'home-account-class-avatar--empty');
    var ct = bestCharacter && Number(bestCharacter.classType);
    if (Number.isFinite(ct) && ct > 0) {
      avatarEl.textContent = '';
      avatarEl.style.backgroundImage = 'url(' + renderClassSprite(ct) + ')';
      avatarEl.style.backgroundSize = 'contain';
      avatarEl.style.backgroundRepeat = 'no-repeat';
      avatarEl.style.backgroundPosition = 'center';
      avatarEl.style.imageRendering = 'pixelated';
      var skin = Number(bestCharacter.skin);
      var tex1 = Number(bestCharacter.tex1);
      var tex2 = Number(bestCharacter.tex2);
      if (typeof window.renderEamPortrait === 'function') {
        window
          .renderEamPortrait(
            ct,
            Number.isFinite(skin) && skin > 0 ? skin : ct,
            Number.isFinite(tex1) ? tex1 : 0,
            Number.isFinite(tex2) ? tex2 : 0,
          )
          .then(function (portraitUrl) {
            if (!portraitUrl) return;
            avatarEl.style.backgroundImage = 'url(' + portraitUrl + ')';
          })
          .catch(function () {});
      }
      return;
    }
    avatarEl.style.backgroundImage = '';
    avatarEl.style.backgroundSize = '';
    avatarEl.style.backgroundRepeat = '';
    avatarEl.style.backgroundPosition = '';
    if (isLoading) {
      avatarEl.textContent = '…';
      avatarEl.classList.add('home-account-class-avatar--loading');
    } else {
      avatarEl.textContent = '?';
      avatarEl.classList.add('home-account-class-avatar--empty');
    }
  }

  function renderHomeAccounts(rosterId, sortId) {
    var roster = document.getElementById(rosterId || 'home-accounts-roster');
    var sortEl = document.getElementById(sortId || 'home-accounts-sort');
    var controlMode = String(rosterId || '') === 'home-multi-accounts-roster';
    if (!roster) return;
    roster.innerHTML = '';
    if (sortEl && String(sortEl.value || '') !== String(homeAccountsSortMode || 'newest')) {
      sortEl.value = String(homeAccountsSortMode || 'newest');
    }
    if (!dashboardAccounts.length) {
      roster.innerHTML = '<div class="home-note">' + escapeHtml(t('home.accounts.noConfigured')) + '</div>';
      if (controlMode) {
        var emptyResultsEl = document.getElementById('home-multi-results-count');
        if (emptyResultsEl) emptyResultsEl.textContent = '0 shown';
      }
      return;
    }

    var getDisplayName = function (account) {
      return String(account.label || account.email || t('home.account.unnamed'));
    };
    var getSortFame = function (account) {
      var overview = accountOverviewById[account.id];
      if (!overview || typeof overview !== 'object') return 0;
      var bestFame = Number(overview.bestCharFame);
      if (Number.isFinite(bestFame)) return bestFame;
      var characters = Array.isArray(overview.characters) ? overview.characters : [];
      if (!characters.length) return 0;
      var fallbackBest = 0;
      characters.forEach(function (character) {
        var fame = Number(character && character.fame || 0);
        if (Number.isFinite(fame) && fame > fallbackBest) fallbackBest = fame;
      });
      return fallbackBest;
    };
    var sorted = dashboardAccounts.slice();
    sorted.sort(function (a, b) {
      var mode = String(homeAccountsSortMode || 'newest');
      if (mode === 'fame') {
        var fameDelta = getSortFame(b) - getSortFame(a);
        if (fameDelta !== 0) return fameDelta;
      } else if (mode === 'alphabetical') {
        var alpha = getDisplayName(a).localeCompare(getDisplayName(b), undefined, { sensitivity: 'base' });
        if (alpha !== 0) return alpha;
      } else if (mode === 'oldest') {
        var oldDelta = Number(a.createdAt || 0) - Number(b.createdAt || 0);
        if (oldDelta !== 0) return oldDelta;
      } else {
        var newDelta = Number(b.createdAt || 0) - Number(a.createdAt || 0);
        if (newDelta !== 0) return newDelta;
      }
      return getDisplayName(a).localeCompare(getDisplayName(b), undefined, { sensitivity: 'base' });
    });

    var visibleAccounts = sorted.slice();
    if (!controlMode) {
      var hsSearch = document.getElementById('hs-accounts-search');
      var hsQuery = String(hsSearch && hsSearch.value || '').trim().toLowerCase();
      if (hsQuery) {
        visibleAccounts = visibleAccounts.filter(function (account) {
          var haystack = [
            String(account.label || ''),
            String(account.email || ''),
            String(account.serverName || '')
          ].join(' ').toLowerCase();
          return haystack.indexOf(hsQuery) >= 0;
        });
      }
    }
    if (controlMode) {
      var filterQuery = String(homeMultiSearchQuery || '').trim().toLowerCase();
      var filterMode = String(homeMultiStatusFilter || 'all');
      visibleAccounts = visibleAccounts.filter(function (account) {
        var hasCreds = !!String(account.email || '').trim() && !!String(account.password || '');
        var isMule = account.mulingRole === 'main' || account.mulingRole === 'mule';
        if (filterMode === 'ready' && !hasCreds) return false;
        if (filterMode === 'missing' && hasCreds) return false;
        if (filterMode === 'mule' && !isMule) return false;
        if (!filterQuery) return true;
        var haystack = [
          String(account.label || ''),
          String(account.email || ''),
          String(account.serverName || ''),
          String(account.mulingRole || '')
        ].join(' ').toLowerCase();
        return haystack.indexOf(filterQuery) >= 0;
      });
      var resultsCountEl = document.getElementById('home-multi-results-count');
      if (resultsCountEl) {
        resultsCountEl.textContent = String(visibleAccounts.length) + ' shown';
      }
    }
    if (!visibleAccounts.length) {
      roster.innerHTML = '<div class="home-note">No saved accounts match the current filters.</div>';
      return;
    }

    visibleAccounts.forEach(function (account) {
      var overview = accountOverviewById[account.id] || null;
      var bestCharacter = getBestOverviewCharacter(overview);
      var isLoading = homeAccountOverviewLoadingIds.has(account.id);
      if (!bestCharacter && !isLoading) prefetchHomeDashboardAccountOverview(account);
      var characterSummary = bestCharacter
        ? formatHomeAccountCharacterSummary(bestCharacter, account)
        : (isLoading ? t('home.accounts.loadingChars') : String(account.serverName || 'USWest'));
      var equipmentSummary = bestCharacter
        ? buildEquipmentSpriteStripHtml(bestCharacter.equipment)
        : '<div class="home-note">' + escapeHtml(isLoading ? t('home.accounts.fetchingTop') : t('home.accounts.charNotLoaded')) + '</div>';
      var hasCreds = !!String(account.email || '').trim() && !!String(account.password || '');
      var roleLabel = account.mulingRole === 'main' ? 'Main' : account.mulingRole === 'mule' ? 'Mule' : 'No Role';
      var statusLabel = hasCreds ? 'Ready To Launch' : 'Missing Credentials';
      var statusClass = hasCreds ? 'active' : 'warning';
      var row = document.createElement('div');
      row.className = 'home-account-row' + (controlMode ? ' home-account-row--control' : '');
      row.innerHTML = controlMode
        ? (
          '<div class="home-account-main">' +
            '<div class="home-account-title">' +
              '<span>' + escapeHtml(String(account.label || account.email || t('home.account.unnamed'))) + '</span>' +
              '<span class="home-status-pill ' + statusClass + '">' + escapeHtml(statusLabel) + '</span>' +
            '</div>' +
            '<div class="home-account-meta">' +
              '<span class="home-account-meta-pill">' + escapeHtml(String(account.serverName || 'USWest')) + '</span>' +
              '<span class="home-account-meta-pill">' + escapeHtml(roleLabel) + '</span>' +
            '</div>' +
            '<div class="home-account-char">' + escapeHtml(characterSummary) + '</div>' +
            '<div class="home-account-gear">' + equipmentSummary + '</div>' +
          '</div>' +
          '<div class="home-account-actions">' +
            '<button class="setting-btn home-account-launch-btn" data-home-launch="' + escapeHtml(String(account.id)) + '">' + escapeHtml(hasCreds ? t('btn.launch') : 'Fix Account') + '</button>' +
            '<button class="setting-btn setting-btn-secondary home-account-edit-btn" data-home-edit="' + escapeHtml(String(account.id)) + '">Edit</button>' +
          '</div>'
        )
        : (
          '<div class="home-account-main">' +
            '<div class="home-account-title">' +
              '<span>' + escapeHtml(String(account.label || account.email || t('home.account.unnamed'))) + '</span>' +
            '</div>' +
            '<div class="home-account-char">' + escapeHtml(characterSummary) + '</div>' +
            '<div class="home-account-gear">' + equipmentSummary + '</div>' +
          '</div>' +
          '<button class="setting-btn home-account-launch-btn" data-home-launch="' + escapeHtml(String(account.id)) + '">' + escapeHtml(t('btn.launch')) + '</button>'
        );
      roster.appendChild(row);
    });
    roster.querySelectorAll('[data-home-edit]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var accountId = String(btn.getAttribute('data-home-edit') || '');
        if (!accountId) return;
        selectedAccountId = accountId;
        renderAccountsTab();
        openDashboardTab('accounts');
      });
    });
    roster.querySelectorAll('[data-home-launch]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var accountId = String(btn.getAttribute('data-home-launch') || '');
        var account = dashboardAccounts.find(function (entry) { return entry.id === accountId; });
        if (!account) return;
        selectedAccountId = account.id;
        renderAccountsTab();
        if (String(account.email || '').trim() && String(account.password || '')) {
          var launched = launchGameWithCredentials(
            String(account.email || '').trim(),
            String(account.password || ''),
            String(account.serverName || 'USWest').trim() || 'USWest',
            undefined,
            launchOptsWithAccount(account, {}),
          );
          if (launched) {
            addHomeFeed('act', tr('home.action.launchRequested', { name: String(account.label || account.email || t('accounts.summary.defaultName')) }));
            setHomeActionStatus(t('home.action.launchSent'));
          } else {
            addHomeFeed('err', t('home.action.launchOffline'));
            setHomeActionStatus(t('home.action.launchOffline'));
          }
        } else {
          openDashboardTab('accounts');
          setHomeActionStatus(t('home.action.missingCreds'));
        }
      });
    });
  }

  /**
   * Shallow-merge dashboard playerData payloads. When the incoming message omits map or sends
   * an empty/nameless map (common during reconnect before MAPINFO), retain the prior map label.
   */
  function mergePlayerDataSnapshot(previous, incoming) {
    var merged = Object.assign({}, previous || {}, incoming || {});
    function usableMap(value) {
      if (value == null) return '';
      var s = String(value).trim();
      return s === '' || s === '--' ? '' : s;
    }
    var incomingMap = usableMap(merged.map) || usableMap(merged.mapName);
    var prevMap = usableMap(previous && previous.map) || usableMap(previous && previous.mapName);
    if (!incomingMap && prevMap) merged.map = prevMap;
    return merged;
  }

  function macPopoutEffectsInnerHtml(pd) {
    var names = [];
    if (pd && Array.isArray(pd.conditionEffects) && pd.conditionEffects.length) {
      names = pd.conditionEffects.slice(0, 28);
    } else if (pd && pd.effects && typeof pd.effects === 'object' && !Array.isArray(pd.effects)) {
      names = Object.keys(pd.effects)
        .filter(function (k) {
          return pd.effects[k];
        })
        .slice(0, 28);
    }
    if (!names.length) return '<span class="mac-popout-muted">—</span>';
    return names
      .map(function (n) {
        return '<span class="home-badge">' + escapeHtml(String(n)) + '</span>';
      })
      .join('');
  }

  function macPopoutMapDisplay(pd) {
    if (!pd) return '--';
    if (pd.map != null && String(pd.map).trim()) return String(pd.map).trim();
    if (pd.mapName != null && String(pd.mapName).trim()) return String(pd.mapName).trim();
    return '--';
  }

  /** 1=no backpack · 2=backpack (first BP row usable) · 3=backpack + extender (matches SDK getBackpack / stat 130). */
  function sdkBackpackTierFromPlayerData(pd) {
    var t = pd && pd.backpackTier != null ? Math.trunc(Number(pd.backpackTier)) || 0 : 0;
    if (t >= 16) return 3;
    if (t !== 0 || !!(pd && pd.hasBackpack)) return 2;
    return 1;
  }

  function normalizeMacPopoutInvSlot(raw) {
    if (raw === undefined || raw === null) return { objectType: -1, objectTypeHex: '', name: '', enchantIds: [], uniqueId: null };
    var ot;
    if (raw && typeof raw === 'object') {
      ot = Number(raw.objectType != null ? raw.objectType : raw.itemType);
    } else {
      ot = Number(raw);
    }
    if (!Number.isFinite(ot) || ot < 0) ot = -1;
    var item = {
      objectType: ot,
      objectTypeHex: ot >= 0 ? ('0x' + ot.toString(16)) : '',
      name: '',
      enchantIds: [],
      uniqueId: raw && typeof raw === 'object' && raw.uniqueId != null ? String(raw.uniqueId) : null,
    };
    return item;
  }

  function buildMacPopoutLiveInventoryHtml(pd) {
    var inv = Array.isArray(pd && pd.inventory) ? pd.inventory : [];
    var bp = Array.isArray(pd && pd.backpack) ? pd.backpack : [];
    var sdkTier = sdkBackpackTierFromPlayerData(pd);

    var html = '';
    var chip = function (it) {
      return buildItemSpriteHtml(it, 'mac-popout-inv-sprite');
    };

    var equip = [];
    var i = 0;
    for (; i < 4; i++) equip.push(normalizeMacPopoutInvSlot(inv[i]));
    html +=
      '<div class="mac-popout-inv-group">' +
      '<div class="mac-popout-equipment-heading">' +
      '<span class="mac-popout-section-title mac-popout-section-title--equipment">' +
      escapeHtml('Equipment') +
      '</span>' +
      '<span id="mac-popout-runtime-value" class="mac-popout-connection-time" title="Time connected">--</span>' +
      '</div>' +
      '<div class="rotmg-item-strip mac-popout-inv-strip">' +
      equip.map(chip).join('') +
      '</div>' +
      '</div>';

    var bagTop = [];
    for (i = 4; i < 8; i++) bagTop.push(normalizeMacPopoutInvSlot(inv[i]));
    var bagBot = [];
    for (i = 8; i < 12; i++) bagBot.push(normalizeMacPopoutInvSlot(inv[i]));
    var bagRowsHtml =
      '<div class="mac-popout-inv-bag-rows">' +
      '<div class="rotmg-item-strip mac-popout-inv-strip mac-popout-inv-strip--bag-row">' +
      bagTop.map(chip).join('') +
      '</div>' +
      '<div class="rotmg-item-strip mac-popout-inv-strip mac-popout-inv-strip--bag-row">' +
      bagBot.map(chip).join('') +
      '</div>' +
      '</div>';
    /** Rows from backpack array [start, start+count) in 4-wide strips. */
    function backpackRowsFromBp(startSlot, slotCount) {
      var parts = '';
      var start = Math.max(0, startSlot);
      var end = start + slotCount;
      for (var s = start; s < end; s += 4) {
        var rowSlots = [];
        for (var c = 0; c < 4 && s + c < end; c++) {
          rowSlots.push(normalizeMacPopoutInvSlot(bp[s + c]));
        }
        parts +=
          '<div class="rotmg-item-strip mac-popout-inv-strip mac-popout-inv-strip--bag-row">' +
          rowSlots.map(chip).join('') +
          '</div>';
      }
      return parts;
    }

    if (sdkTier >= 2) {
      var bpBlockTier2 = '<div class="mac-popout-inv-bag-rows">' + backpackRowsFromBp(0, 8) + '</div>';
      html +=
        '<div class="mac-popout-inv-group mac-popout-inv-inline-wrap">' +
        '<div class="mac-popout-inv-inline-row">' +
        '<div class="mac-popout-inv-pane">' +
        '<div class="mac-popout-section-title">' + escapeHtml('Bag') + '</div>' +
        bagRowsHtml +
        '</div>' +
        '<div class="mac-popout-inv-pane mac-popout-inv-pane--bp">';
      if (sdkTier >= 3) {
        html +=
          '<div class="mac-popout-bp-stack">' +
          '<div class="mac-popout-bp-sub">' +
          '<div class="mac-popout-section-title">' + escapeHtml('Backpack') + '</div>' +
          '<div class="mac-popout-inv-bag-rows">' +
          backpackRowsFromBp(0, 8) +
          '</div>' +
          '</div>' +
          '<div class="mac-popout-bp-sub">' +
          '<div class="mac-popout-section-title">' + escapeHtml('Extender') + '</div>' +
          '<div class="mac-popout-inv-bag-rows">' +
          backpackRowsFromBp(8, 8) +
          '</div>' +
          '</div>' +
          '</div>';
      } else {
        html +=
          '<div class="mac-popout-section-title">' + escapeHtml('Backpack') + '</div>' +
          bpBlockTier2;
      }
      html += '</div></div></div>';
    } else {
      html +=
        '<div class="mac-popout-inv-group">' +
        '<div class="mac-popout-section-title">' + escapeHtml('Bag') + '</div>' +
        bagRowsHtml +
        '</div>';
    }

    return html;
  }

  function macPopoutDetailObjectTypeStr(pd) {
    var objectTypeNum = Number(pd && pd.objectType);
    return Number.isFinite(objectTypeNum) && objectTypeNum > 0
      ? String(Math.trunc(objectTypeNum)) + ' (0x' + Math.trunc(objectTypeNum).toString(16) + ')'
      : '--';
  }

  function macPopoutDetailQuestTargetIdStr(pd) {
    var qid = pd && pd.questObjectId;
    var qn = qid !== undefined && qid != null ? Math.trunc(Number(qid)) : NaN;
    return Number.isFinite(qn) && qn > 0 ? String(qn) : '--';
  }

  function macPopoutDetailQuestTargetTypeStr(pd) {
    var tt = pd && pd.questTargetObjectType;
    var tn = tt !== undefined && tt !== null ? Math.trunc(Number(tt)) : NaN;
    return Number.isFinite(tn) && tn > 0
      ? String(tn) + ' (0x' + tn.toString(16) + ')'
      : '--';
  }

  function macPopoutApplyPlayerData(clientId) {
    if (!clientId || macPopoutOpenClientId !== clientId) return;
    var c = connectedClients.get(clientId);
    if (!c) return;
    var pd = c.fullData || c;
    var hp = Number(c.hp != null ? c.hp : (pd.hp != null ? pd.hp : 0));
    var maxHp = Math.max(1, Number(c.maxHp != null ? c.maxHp : (pd.maxHp != null ? pd.maxHp : 1)));
    var mp = Number(pd.mana != null ? pd.mana : 0);
    var maxMp = Math.max(1, Number(pd.maxMana || 1));
    var hpPct = Math.min(100, Math.max(0, (hp / Math.max(1, maxHp)) * 100));
    var mpPct = Math.min(100, Math.max(0, (mp / Math.max(1, maxMp)) * 100));
    var classType = Number(pd.classType != null ? pd.classType : c.classType);
    var classNameFromClass =
      Number.isFinite(classType) && classType > 0 && CLASS_NAMES[classType]
        ? CLASS_NAMES[classType]
        : pd.class != null && String(pd.class).trim()
          ? String(pd.class)
          : 'Unknown';

    var nameEl = document.getElementById('mac-popout-name');
    var classEl = document.getElementById('mac-popout-class');
    var sessUpEl = document.getElementById('mac-popout-session-uptime');
    var sessFameEl = document.getElementById('mac-popout-session-fame');
    var sessFpmEl = document.getElementById('mac-popout-session-fpm');
    var hpFillEl = document.getElementById('mac-popout-hp-fill');
    var hpMainEl = document.getElementById('mac-popout-hp-main');
    var hpBonusEl = document.getElementById('mac-popout-hp-bonus');
    var hpRegenEl = document.getElementById('mac-popout-hp-regen');
    var mpFillEl = document.getElementById('mac-popout-mp-fill');
    var mpMainEl = document.getElementById('mac-popout-mp-main');
    var mpBonusEl = document.getElementById('mac-popout-mp-bonus');
    var mpRegenEl = document.getElementById('mac-popout-mp-regen');

    var connectedAtMs = getClientConnectedAtMs(clientId, c);
    var runtimeText = formatHomeDuration(Math.max(0, Date.now() - connectedAtMs));

    if (nameEl) nameEl.textContent = String(pd.name || 'Unknown');
    if (classEl) classEl.textContent = 'Lv.' + (pd.level || 1) + ' ' + classNameFromClass;

    if (sessUpEl) {
      sessUpEl.textContent =
        pd.sessionUptimeMs != null && Number.isFinite(Number(pd.sessionUptimeMs))
          ? formatHomeDuration(Number(pd.sessionUptimeMs))
          : '--';
    }
    if (sessFameEl)
      sessFameEl.textContent =
        pd.sessionFameGained != null ? Math.max(0, Number(pd.sessionFameGained || 0)).toLocaleString() : '--';
    if (sessFpmEl)
      sessFpmEl.textContent =
        pd.sessionAverageFpm != null ? formatHomeFpm(Number(pd.sessionAverageFpm || 0)) : '--';

    if (hpFillEl) hpFillEl.style.width = hpPct + '%';
    if (hpMainEl) hpMainEl.textContent = hp + ' / ' + maxHp;
    if (hpBonusEl) hpBonusEl.textContent = buildGearExaltBonusSuffix(pd.healthBonus, pd.exaltedMaxHP);
    if (hpRegenEl) {
      hpRegenEl.textContent =
        pd.hpRegenPerSec != null && pd.hpRegenPerSec !== ''
          ? pd.hpRegenPerSec + '/s'
          : '';
    }

    if (mpFillEl) mpFillEl.style.width = mpPct + '%';
    if (mpMainEl) mpMainEl.textContent = mp + ' / ' + maxMp;
    if (mpBonusEl) mpBonusEl.textContent = buildGearExaltBonusSuffix(pd.manaBonus, pd.exaltedMaxMP);
    if (mpRegenEl) {
      mpRegenEl.textContent =
        pd.mpRegenPerSec != null && pd.mpRegenPerSec !== ''
          ? pd.mpRegenPerSec + '/s'
          : '';
    }

    var statPairs = [
      ['mac-popout-stat-atk', pd.attack, pd.attackBonus, pd.exaltedAttack],
      ['mac-popout-stat-def', pd.defense, pd.defenseBonus, pd.exaltedDefense],
      ['mac-popout-stat-spd', pd.speed, pd.speedBonus, pd.exaltedSpeed],
      ['mac-popout-stat-dex', pd.dexterity, pd.dexterityBonus, pd.exaltedDexterity],
      ['mac-popout-stat-vit', pd.vitality, pd.vitalityBonus, pd.exaltedVitality],
      ['mac-popout-stat-wis', pd.wisdom, pd.wisdomBonus, pd.exaltedWisdom],
    ];
    statPairs.forEach(function (row) {
      var el = document.getElementById(row[0]);
      if (el) el.textContent = formatPlayerStatLine(row[1], row[2], row[3]);
    });

    var setDtl = function (id, val) {
      var el = document.getElementById(id);
      if (el) el.textContent = val != null ? String(val) : '--';
    };
    setDtl('mac-popout-dtl-level', pd.level != null ? pd.level : '--');
    setDtl('mac-popout-dtl-stars', pd.stars != null ? pd.stars : '--');
    setDtl('mac-popout-dtl-fame', pd.fame != null ? formatNumber(pd.fame) : '--');
    setDtl('mac-popout-dtl-guild', pd.guild || '--');
    setDtl('mac-popout-dtl-map', macPopoutMapDisplay(pd));
    setDtl(
      'mac-popout-dtl-gameid',
      pd.gameId !== undefined && pd.gameId !== null ? String(pd.gameId) : '--',
    );
    setDtl(
      'mac-popout-dtl-objectid',
      pd.objectId !== undefined && pd.objectId !== null ? String(pd.objectId) : '--',
    );
    setDtl('mac-popout-dtl-objecttype', macPopoutDetailObjectTypeStr(pd));
    setDtl(
      'mac-popout-dtl-pos',
      pd.pos && Number.isFinite(Number(pd.pos.x)) && Number.isFinite(Number(pd.pos.y))
        ? Math.round(Number(pd.pos.x)) + ', ' + Math.round(Number(pd.pos.y))
        : '--',
    );
    setDtl('mac-popout-dtl-quest-id', macPopoutDetailQuestTargetIdStr(pd));
    setDtl('mac-popout-dtl-quest-type', macPopoutDetailQuestTargetTypeStr(pd));
    setDtl('mac-popout-dtl-bptier', sdkBackpackTierFromPlayerData(pd));
    setDtl('mac-popout-dtl-server', pd.server || '--');

    setDtl(
      'mac-popout-dtl-teleport',
      pd.teleportAllowed === undefined ? '--' : pd.teleportAllowed ? 'yes' : 'no',
    );

    var invVisualEl = document.getElementById('mac-popout-inventory-inner');
    if (invVisualEl) invVisualEl.innerHTML = buildMacPopoutLiveInventoryHtml(pd);
    var runtimeEl = document.getElementById('mac-popout-runtime-value');
    if (runtimeEl) runtimeEl.textContent = runtimeText;

    var effectsWrap = document.getElementById('mac-popout-effects-inner');
    if (effectsWrap) effectsWrap.innerHTML = macPopoutEffectsInnerHtml(pd);
  }

  // WebSocket connection
  function connect() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(proto + '//' + location.host);

    ws.onopen = () => {
      updateDashboardAvailabilityUi();
      if (adminMode && packetSnifferVisible) seedSnifferPacketTypeChipsFromDefs();
      addHomeFeed('ok', 'Dashboard socket connected.');
      try { ws.send(JSON.stringify({ type: 'requestScriptPanelSnapshots' })); } catch (_e) {}
      // Re-send dashboard tokens so the server-side bot API client stays in sync
      if (dashboardLoggedIn && accessToken) {
        ws.send(JSON.stringify({
          type: 'dashboardToken',
          access_token: accessToken,
          refresh_token: refreshToken || null,
          is_admin: !!(dashboardUser && dashboardUser.is_admin),
          developer_mode: !!(dashboardUser && dashboardUser.developer_mode),
        }));
      }
    };

    ws.onclose = () => {
      labSendPending.clear();
      if (pendingAllPlayersRawStatsTimer) {
        clearTimeout(pendingAllPlayersRawStatsTimer);
        pendingAllPlayersRawStatsTimer = null;
      }
      pendingAllPlayersRawStatsCb = null;
      if (pendingVaultChestRawStatsTimer) {
        clearTimeout(pendingVaultChestRawStatsTimer);
        pendingVaultChestRawStatsTimer = null;
      }
      pendingVaultChestRawStatsCb = null;
      gameStatus.textContent = t('status.disconnected');
      gameStatus.className = 'status-badge disconnected';
      gameConnected = false;
      setPlayerCardVisibility(false);
      connectedClients.delete(SINGLE_ACCOUNT_CLIENT_ID);
      renderSingleAccountDock();
      if (activeTab === 'scripts') renderScriptsListFromData(scriptsTabLastData);
      updateDashboardAvailabilityUi();
      addHomeFeed('err', 'Dashboard socket disconnected. Reconnecting...');
      if (typeof clearObjectsAutoRefresh === 'function') clearObjectsAutoRefresh();
      if (typeof resetGameWikiOnWsClose === 'function') resetGameWikiOnWsClose();
      setTimeout(connect, 2000);
    };

    ws.onmessage = (event) => {
      const msg = JSON.parse(event.data);
      switch (msg.type) {
        case 'packet':
          onPacket(msg.data);
          break;
        case 'history':
          msg.data.forEach(p => onPacket(p, true));
          break;
        case 'plugins': {
          var pl = Array.isArray(msg.data) ? msg.data : [];
          if (pl.length > 0) pluginsReceived = true;
          allPluginsData = pl;
          renderPlugins(pl);
          populateServerSelect(pl);
          renderDamageSettings(pl);
          break;
        }
        case 'gameClient':
          updateGameStatus(msg.connected);
          break;
        case 'internalState':
          updateInternalState(msg.connected);
          break;
        case 'unresolvedClasses':
          updateUnresolvedClasses(msg.classes || []);
          break;
        case 'pluginLog':
          addPluginLog(msg.plugin, msg.message);
          break;
        case 'playerData':
          updatePlayerCard(msg);
          // Feed the inventory diff into the session tracker so it can
          // detect white-bag-tier pickups and shiny items.
          try { window._AccountSessions && window._AccountSessions.observePlayerData(msg); } catch (_) {}
          break;
        case 'pluginData':
          handlePluginData(msg);
          break;
        case 'objectsData':
          lastObjectsData = {
            portals: msg.portals || [],
            beacons: msg.beacons || [],
            categories: msg.categories || [],
            beaconTypes: msg.beaconTypes || []
          };
          renderObjectsTree(lastObjectsData);
          updateTeleportBeaconDropdown(false);
          break;
        case 'tilesData':
          lastTilesData = {
            center: msg.center || { x: 0, y: 0 },
            radius: msg.radius || 12,
            groups: msg.groups || []
          };
          if (activeTab === 'tilemap') renderTilemapTree(lastTilesData);
          break;
        case 'gameWikiCatalog':
          handleGameWikiCatalog(msg);
          break;
        case 'objectXmlResult':
          (function () {
            var k = 'o:' + String(msg.objectType);
            delete gameWikiObjectXmlInFlight[k];
            delete gameWikiXmlPrefetchScheduled[k];
            setGameWikiXmlCache(k, msg.rawXml != null ? String(msg.rawXml) : '');
            var shouldDetail = (gameWikiXmlPendingKey === k)
              || (activeTab === 'game-wiki' && gameWikiSection === 'objects' && Number(msg.objectType) === gameWikiSelectedType);
            if (shouldDetail) {
              gameWikiXmlPendingKey = null;
              renderGameWikiDetail();
            }
            if (activeTab === 'game-wiki' && gameWikiSection === 'objects') {
              scheduleGameWikiListViewport();
            }
          })();
          break;
        case 'tileXmlResult':
          (function () {
            var k = 't:' + String(msg.tileType);
            delete gameWikiTileXmlInFlight[k];
            delete gameWikiXmlPrefetchScheduled[k];
            setGameWikiXmlCache(k, msg.rawXml != null ? String(msg.rawXml) : '');
            if (gameWikiXmlPendingKey === k) {
              gameWikiXmlPendingKey = null;
              renderGameWikiDetail();
            }
            if (activeTab === 'game-wiki' && gameWikiSection === 'tiles') {
              scheduleGameWikiListViewport();
            }
          })();
          break;
        case 'nearbyPlayersData':
          lastNearbyPlayers = msg.players || [];
          if (activeTab === 'nearby') renderNearbyPlayersTab();
          break;
        case 'nearbyPlayerDebug':
          if (msg && msg.objectId != null && msg.objectId === selectedNearbyPlayerId) {
            lastNearbyPlayerDebug = msg.debug || null;
            if (activeTab === 'nearby') renderNearbyPlayerDebug();
          }
          break;
        case 'allPlayersRawStats':
          if (pendingAllPlayersRawStatsCb) {
            if (pendingAllPlayersRawStatsTimer) {
              clearTimeout(pendingAllPlayersRawStatsTimer);
              pendingAllPlayersRawStatsTimer = null;
            }
            var fn = pendingAllPlayersRawStatsCb;
            pendingAllPlayersRawStatsCb = null;
            fn(msg);
          }
          break;
        case 'vaultData':
          if (pendingVaultChestRawStatsCb) {
            if (pendingVaultChestRawStatsTimer) {
              clearTimeout(pendingVaultChestRawStatsTimer);
              pendingVaultChestRawStatsTimer = null;
            }
            var fnVault = pendingVaultChestRawStatsCb;
            pendingVaultChestRawStatsCb = null;
            fnVault(msg);
          }
          break;
        case 'config':
          handleConfig(msg);
          break;
        case 'launchGameResult':
          handleLaunchResult(msg);
          break;
        case 'labUpdate':
          handleLabUpdate(msg.unknowns);
          break;
        case 'probeResult':
          handleProbeResult(msg.result);
          break;
        case 'labPacketSendResult':
          handleLabPacketSendResult(msg);
          break;
        case 'gemStatus':
          if (Array.isArray(msg.active_plans)) {
            _realActivePlans = new Set(msg.active_plans.map(function (p) { return String(p).toLowerCase(); }));
            // If view-as override is active, keep the override; otherwise reflect server state.
            if (!viewAsOverride) activePlanNames = new Set(_realActivePlans);
            renderPlugins(Array.isArray(allPluginsData) ? allPluginsData : []);
          }
          break;
        case 'pluginToggleError':
          handlePluginToggleError(msg);
          break;
        case 'scriptLog':
          if (msg.line != null) {
            appendScriptLogLine(String(msg.line), msg.level || 'info', msg.id || '');
          }
          break;
        case 'scriptsState':
          applyScriptsStateFromSocket(msg);
          break;
        case 'scriptPanelState':
          handleScriptPanelState(msg);
          break;
        case 'scriptPanelPatches':
          handleScriptPanelPatches(msg);
          break;
        case 'scriptPanelOpen':
          openScriptPanelById(msg && msg.scriptId);
          break;
        case 'scriptPanelClose':
          closeScriptPanelById(msg && msg.scriptId, { notifyServer: false });
          break;
        case 'botApiTokenGranted':
          if (msg.access_token) window._botApiToken = String(msg.access_token);
          break;
        case 'ownedScripts':
          renderMarketplaceScripts(Array.isArray(msg.scripts) ? msg.scripts : []);
          break;
        case 'marketplaceScriptResult':
          handleMarketplaceScriptResult(msg);
          break;
        case 'muling_status':
          handleMulingStatus(msg.status);
          break;
        case 'telemetryStats':
          handleTelemetryStats(msg);
          break;
        case 'telemetryStatsError':
          handleTelemetryStatsError(msg);
          break;
        case 'telemetryEnabledState':
          if (telemetryEnabledToggle) {
            telemetryEnabledToggle.checked = !!msg.enabled;
          }
          break;
      }
    };
  }

  var internalConnected = false;

  function updateInternalState(connected) {
    internalConnected = !!connected;
    var badge = document.getElementById('internal-status-badge');
    var connDetails = document.getElementById('internal-connected-details');
    var discDetails = document.getElementById('internal-disconnected-details');
    if (badge) {
      badge.textContent = internalConnected ? 'Connected' : 'Disconnected';
      badge.className = 'status-badge ' + (internalConnected ? 'connected' : 'disconnected');
    }
    if (connDetails) connDetails.style.display = internalConnected ? '' : 'none';
    if (discDetails) discDetails.style.display = internalConnected ? 'none' : '';
  }

  function updateUnresolvedClasses(classes) {
    var section = document.getElementById('internal-unresolved-section');
    var list = document.getElementById('internal-unresolved-list');
    if (!section || !list) return;
    if (!classes || classes.length === 0) {
      section.style.display = 'none';
      return;
    }
    section.style.display = '';
    list.innerHTML = classes.map(function(cls) {
      return '<span class="unresolved-class-tag">' + cls + '</span>';
    }).join('');
  }

  function updateGameStatus(connected) {
    var wasConnected = gameConnected;
    gameConnected = connected;
    setPlayerCardVisibility(connected);
    renderSingleAccountDock();
    if (connected) {
      gameStatus.textContent = t('status.connected');
      gameStatus.className = 'status-badge connected';
      // Open/resume the per-account session tracker. Realm switches show up
      // as quick disconnect/reconnect, which the tracker treats as one
      // continuous session until its grace timer expires.
      try { window._AccountSessions && window._AccountSessions.onConnected(); } catch (_) {}
    } else {
      gameStatus.textContent = t('status.disconnected');
      gameStatus.className = 'status-badge disconnected';
      resetPlayerCard();
      try { window._AccountSessions && window._AccountSessions.onDisconnected(); } catch (_) {}
    }
    if (connected && !wasConnected) {
      homeConnectionCount++;
      if (homeConnectionCount > 1) homeStats.reconnects++;
      addHomeFeed('ok', homeConnectionCount > 1 ? 'Reconnected to game server.' : 'Game client connected.');
      homeWasGameConnected = true;
    } else if (!connected && wasConnected) {
      addHomeFeed('err', 'Lost connection to game server.');
      stopHomeScriptTimer();
      homeLastSession = {
        name: String((lastPlayerData && lastPlayerData.name) || (getSelectedDashboardAccount() && (getSelectedDashboardAccount().label || getSelectedDashboardAccount().email)) || 'Unknown'),
        durationMs: Math.max(0, Date.now() - homeStats.startedAt),
        endedAt: Date.now(),
      };
      clearHomeStatsForNewSession();
      homeWasGameConnected = false;
    }
    updateDashboardAvailabilityUi();

    if (activeTab === 'home') renderHomeTab();
    if (activeTab === 'scripts') renderScriptsListFromData(scriptsTabLastData);
  }

  let pendingAllPlayersRawStatsCb = null;
  let pendingAllPlayersRawStatsTimer = null;
  let pendingVaultChestRawStatsCb = null;
  let pendingVaultChestRawStatsTimer = null;

  // Player card updates
  function updatePlayerCard(data) {
    lastPlayerData = data;
    if (data && data.sessionUptimeMs != null) {
      var sessionUptimeMs = Math.max(0, Number(data.sessionUptimeMs || 0));
      homeStats.startedAt = Date.now() - sessionUptimeMs;
    }
    if (data && data.sessionFameGained != null) {
      homeStats.fameGained = Math.max(0, Number(data.sessionFameGained || 0));
    }
    if (data && data.sessionAverageFpm != null) {
      homeStats.averageFpm = Math.max(0, Number(data.sessionAverageFpm || 0));
    }
    var charKey = String(data.name || '') + '|' + String(data.classType || 0) + '|' + String(data.level || 0);
    if (charKey && charKey !== homeLastCharacterKey) {
      homeLastCharacterKey = charKey;
      if (data.name) {
        var clsName = CLASS_NAMES[data.classType] || 'Unknown';
        addHomeFeed('ok', 'Character loaded: ' + data.name + ' (' + clsName + ')');
      }
    }
    var nowDead = !!data.dead || Number(data.hp || 0) <= 0;
    if (nowDead && !homeWasPlayerDead) {
      homeStats.deaths++;
      addHomeFeed('err', 'Character death detected.');
    }
    homeWasPlayerDead = nowDead;

    // Name
    if (data.name) {
      document.getElementById('player-name').textContent = data.name;
    }

    // Class + Level
    const className = CLASS_NAMES[data.classType] || 'Unknown';
    document.getElementById('player-class').textContent =
      'Lv.' + (data.level || 1) + ' ' + className;

    const avatarEl = document.getElementById('player-avatar');
    const avatarRenderId = ++playerAvatarRenderSeq;
    function renderFallbackAvatar() {
      const spriteUrl = renderClassSprite(data.classType);
      avatarEl.style.backgroundImage = 'url(' + spriteUrl + ')';
      avatarEl.style.backgroundSize = 'contain';
      avatarEl.style.backgroundRepeat = 'no-repeat';
      avatarEl.style.backgroundPosition = 'center';
      avatarEl.style.imageRendering = 'pixelated';
      avatarEl.classList.remove('player-avatar-portrait');
      avatarEl.textContent = '';
    }
    if (data.classType && CLASS_COLORS[data.classType]) {
      renderFallbackAvatar();
      if (typeof window.renderEamPortrait === 'function') {
        window.renderEamPortrait(data.classType, data.skin || data.classType, data.tex1 || 0, data.tex2 || 0)
          .then(function (portraitUrl) {
            if (avatarRenderId !== playerAvatarRenderSeq || !portraitUrl) return;
            avatarEl.style.backgroundImage = 'url(' + portraitUrl + ')';
            avatarEl.style.backgroundSize = '34px 34px';
            avatarEl.style.backgroundRepeat = 'no-repeat';
            avatarEl.style.backgroundPosition = 'center';
            avatarEl.classList.add('player-avatar-portrait');
            avatarEl.textContent = '';
          })
          .catch(function () {
          });
      }
    } else {
      avatarEl.classList.remove('player-avatar-portrait');
      avatarEl.style.backgroundImage = '';
      avatarEl.textContent = '?';
    }

    // HP bar: center HP + bonus, right-align HP/s (still inside bar)
    const hp = data.hp || 0;
    const maxHp = data.maxHp || 1;
    const hpPct = Math.min(100, Math.max(0, (hp / maxHp) * 100));
    document.getElementById('hp-bar').style.width = hpPct + '%';
    const hpMainEl = document.getElementById('hp-main');
    const hpBonusEl = document.getElementById('hp-bonus');
    const hpRegenEl = document.getElementById('hp-regen');
    if (hpMainEl) hpMainEl.textContent = hp + ' / ' + maxHp;
    if (hpBonusEl) hpBonusEl.textContent = buildGearExaltBonusSuffix(data.healthBonus, data.exaltedMaxHP);
    if (hpRegenEl) hpRegenEl.textContent = (data.hpRegenPerSec != null && data.hpRegenPerSec !== '') ? (data.hpRegenPerSec + '/s') : '';

    // MP bar: center MP + bonus, right-align MP/s (still inside bar)
    const mp = data.mana || 0;
    const maxMp = data.maxMana || 1;
    const mpPct = Math.min(100, Math.max(0, (mp / maxMp) * 100));
    document.getElementById('mp-bar').style.width = mpPct + '%';
    const mpMainEl = document.getElementById('mp-main');
    const mpBonusEl = document.getElementById('mp-bonus');
    const mpRegenEl = document.getElementById('mp-regen');
    if (mpMainEl) mpMainEl.textContent = mp + ' / ' + maxMp;
    if (mpBonusEl) mpBonusEl.textContent = buildGearExaltBonusSuffix(data.manaBonus, data.exaltedMaxMP);
    if (mpRegenEl) mpRegenEl.textContent = (data.mpRegenPerSec != null && data.mpRegenPerSec !== '') ? (data.mpRegenPerSec + '/s') : '';

    document.getElementById('stat-atk').textContent = formatPlayerStatLine(data.attack, data.attackBonus, data.exaltedAttack);
    document.getElementById('stat-def').textContent = formatPlayerStatLine(data.defense, data.defenseBonus, data.exaltedDefense);
    document.getElementById('stat-spd').textContent = formatPlayerStatLine(data.speed, data.speedBonus, data.exaltedSpeed);
    document.getElementById('stat-dex').textContent = formatPlayerStatLine(data.dexterity, data.dexterityBonus, data.exaltedDexterity);
    document.getElementById('stat-vit').textContent = formatPlayerStatLine(data.vitality, data.vitalityBonus, data.exaltedVitality);
    document.getElementById('stat-wis').textContent = formatPlayerStatLine(data.wisdom, data.wisdomBonus, data.exaltedWisdom);

    // Details
    document.getElementById('detail-level').textContent = data.level || '--';
    document.getElementById('detail-stars').textContent = data.stars ?? '--';
    document.getElementById('detail-fame').textContent = formatNumber(data.fame);
    document.getElementById('detail-guild').textContent = data.guild || '--';
    // Match damage-sniffer map naming; keep last non-empty map briefly between transitions
    const mapName = (data.map != null ? String(data.map) : '').trim();
    const mapEl = document.getElementById('detail-map');
    if (mapEl) {
      if (mapName) mapEl.textContent = mapName;
      else if (!mapEl.textContent) mapEl.textContent = '--';
    }
    document.getElementById('detail-gameid').textContent = (data.gameId !== undefined && data.gameId !== null) ? String(data.gameId) : '--';
    document.getElementById('detail-objectid').textContent = (data.objectId !== undefined && data.objectId !== null) ? String(data.objectId) : '--';
    var objectTypeNum = Number(data.objectType);
    document.getElementById('detail-objecttype').textContent = Number.isFinite(objectTypeNum) && objectTypeNum > 0
      ? (String(Math.trunc(objectTypeNum)) + ' (0x' + Math.trunc(objectTypeNum).toString(16) + ')')
      : '--';

    if (data.pos) {
      var posEl = document.getElementById('detail-pos');
      posEl.textContent = Math.round(data.pos.x) + ', ' + Math.round(data.pos.y);
      posEl.title = '';
    }

    var questTargetEl = document.getElementById('detail-questtargetid');
    if (questTargetEl) {
      var qid = data.questObjectId;
      var qn = (qid !== undefined && qid !== null) ? Math.trunc(Number(qid)) : NaN;
      questTargetEl.textContent = (Number.isFinite(qn) && qn > 0) ? String(qn) : '--';
    }
    var questTargetTypeEl = document.getElementById('detail-questtargettype');
    if (questTargetTypeEl) {
      var qtt = data.questTargetObjectType;
      var qtn =
        qtt !== undefined && qtt !== null ? Math.trunc(Number(qtt)) : NaN;
      questTargetTypeEl.textContent =
        Number.isFinite(qtn) && qtn > 0 ? String(qtn) + ' (0x' + qtn.toString(16) + ')' : '--';
    }

    document.getElementById('detail-server').textContent = data.server || '--';

    // Auto-set server dropdown to current server
    if (data.server && data.server !== '--') {
      currentServerName = data.server;
      if (serverSelect && serverSelect.querySelector('option[value="' + data.server + '"]')) {
        serverSelect.value = data.server;
      }
    }
    renderSingleAccountDock();
    if (macPopoutOpenClientId === SINGLE_ACCOUNT_CLIENT_ID) macPopoutApplyPlayerData(SINGLE_ACCOUNT_CLIENT_ID);
    if (activeTab === 'home') renderHomeTab();
  }

  function resetPlayerCard() {
    document.getElementById('player-name').textContent = t('player.notConnected');
    document.getElementById('player-class').textContent = t('player.waitingForGame');
    const avatarEl = document.getElementById('player-avatar');
    avatarEl.textContent = '?';
    avatarEl.style.backgroundImage = '';
    avatarEl.style.imageRendering = '';
    document.getElementById('hp-bar').style.width = '0%';
    const hpMainEl = document.getElementById('hp-main');
    const hpBonusEl = document.getElementById('hp-bonus');
    const hpRegenEl = document.getElementById('hp-regen');
    if (hpMainEl) hpMainEl.textContent = '-- / --';
    if (hpBonusEl) hpBonusEl.textContent = '';
    if (hpRegenEl) hpRegenEl.textContent = '';
    document.getElementById('mp-bar').style.width = '0%';
    const mpMainEl = document.getElementById('mp-main');
    const mpBonusEl = document.getElementById('mp-bonus');
    const mpRegenEl = document.getElementById('mp-regen');
    if (mpMainEl) mpMainEl.textContent = '-- / --';
    if (mpBonusEl) mpBonusEl.textContent = '';
    if (mpRegenEl) mpRegenEl.textContent = '';
    ['atk','def','spd','dex','vit','wis'].forEach(s => {
      document.getElementById('stat-' + s).textContent = '--';
    });
    ['level','stars','fame','guild','map','gameid','objectid','objecttype','pos','questtargetid','questtargettype','server'].forEach(function (d) {
      document.getElementById('detail-' + d).textContent = '--';
    });
    lastPlayerData = null;
    connectedClients.delete(SINGLE_ACCOUNT_CLIENT_ID);
    renderSingleAccountDock();
    if (activeTab === 'home') renderHomeTab();
  }

  // ── Multi-account view ────────────────────────────────────────────────────

  var macPopoutOpenClientId = null;

  function syncSingleAccountSyntheticClient() {
    if (isMacStyleSidebar() || !gameConnected || !lastPlayerData) {
      connectedClients.delete(SINGLE_ACCOUNT_CLIENT_ID);
      if (macPopoutOpenClientId === SINGLE_ACCOUNT_CLIENT_ID) closeMacPopout();
      return null;
    }
    var pd = Object.assign({}, lastPlayerData);
    var client = Object.assign({}, pd, {
      id: SINGLE_ACCOUNT_CLIENT_ID,
      clientId: SINGLE_ACCOUNT_CLIENT_ID,
      fullData: pd,
      name: pd.name || 'Connected',
      server: pd.server || currentServerName || '--',
      hp: pd.hp != null ? pd.hp : 0,
      maxHp: pd.maxHp != null ? pd.maxHp : 1,
      classType: pd.classType,
      skin: pd.skin,
      tex1: pd.tex1,
      tex2: pd.tex2,
      singleAccountDock: true,
    });
    connectedClients.set(SINGLE_ACCOUNT_CLIENT_ID, client);
    if (!connectedClientFirstSeenAt.has(SINGLE_ACCOUNT_CLIENT_ID)) {
      connectedClientFirstSeenAt.set(SINGLE_ACCOUNT_CLIENT_ID, Date.now());
    }
    return client;
  }

  function setSingleAccountDockMinimized(minimized) {
    singleAccountDockMinimized = !!minimized;
    try {
      localStorage.setItem('singleAccountDockMinimized', singleAccountDockMinimized ? '1' : '0');
    } catch (_e) {}
    renderSingleAccountDock();
  }

  // Render the connected-account dock avatar using the same treatment as
  // the player-card popup: basic class-sprite fallback, then upgrade to
  // the high-quality EAM portrait (skin + textures) once it resolves. The
  // per-element render token guards against a stale promise from a
  // previous character clobbering the current one when the player swaps.
  // `pixelated` = `true` for the larger inner-card avatar (where the
  // small EAM bitmap looks better scaled crisp).
  var dockAvatarRenderSeq = 0;
  function setDockAvatarPortrait(el, pd, classType, pixelated) {
    if (!el) return;
    el.textContent = '';
    if (!Number.isFinite(classType) || classType <= 0) {
      el.style.backgroundImage = '';
      el.textContent = '?';
      return;
    }
    el.style.backgroundImage = 'url(' + renderClassSprite(classType) + ')';
    el.style.backgroundSize = 'contain';
    el.style.backgroundRepeat = 'no-repeat';
    el.style.backgroundPosition = 'center';
    el.style.imageRendering = pixelated ? 'pixelated' : '';
    var renderId = ++dockAvatarRenderSeq;
    el.dataset.dockAvatarRenderId = String(renderId);
    if (typeof window.renderEamPortrait === 'function') {
      window.renderEamPortrait(classType, pd.skin || classType, pd.tex1 || 0, pd.tex2 || 0)
        .then(function (portraitUrl) {
          if (!portraitUrl) return;
          if (el.dataset.dockAvatarRenderId !== String(renderId)) return; // stale
          el.style.backgroundImage = 'url(' + portraitUrl + ')';
          el.style.backgroundSize = 'contain';
          el.style.backgroundRepeat = 'no-repeat';
          el.style.backgroundPosition = 'center';
          // EAM portraits are already smooth; only force pixel-art rendering
          // on the larger inner-card avatar where crispness wins.
          el.style.imageRendering = pixelated ? 'pixelated' : '';
        })
        .catch(function () { /* swallow — fallback already drawn */ });
    }
  }

  function renderSingleAccountDock() {
    var dock = document.getElementById('single-account-dock');
    if (!dock) return;
    if (isMacStyleSidebar() || !gameConnected || !lastPlayerData || !showSingleAccountDock) {
      dock.classList.add('hidden');
      connectedClients.delete(SINGLE_ACCOUNT_CLIENT_ID);
      return;
    }

    var client = syncSingleAccountSyntheticClient();
    var pd = client && (client.fullData || client);
    if (!pd) {
      dock.classList.add('hidden');
      return;
    }

    dock.classList.remove('hidden');
    dock.classList.toggle('minimized', singleAccountDockMinimized);

    var toggle = document.getElementById('single-account-dock-toggle');
    if (toggle) toggle.setAttribute('aria-expanded', singleAccountDockMinimized ? 'false' : 'true');

    var nameEl = document.getElementById('single-account-dock-name');
    var metaEl = document.getElementById('single-account-dock-meta');
    var avatarEl = document.getElementById('single-account-dock-avatar');
    var chevronEl = document.getElementById('single-account-dock-chevron');
    var classType = Number(pd.classType);
    var className = Number.isFinite(classType) && CLASS_NAMES[classType] ? CLASS_NAMES[classType] : 'Unknown';
    if (nameEl) nameEl.textContent = String(pd.name || 'Connected');
    if (metaEl) metaEl.textContent = 'Lv.' + String(pd.level || 1) + ' ' + className + ' • ' + String(pd.server || currentServerName || '--');
    if (chevronEl) chevronEl.textContent = singleAccountDockMinimized ? '⌃' : '⌄';
    // Same avatar treatment the player-card popup uses: render the basic
    // class-sprite fallback first, then upgrade to the high-quality EAM
    // portrait (skin + textures) if the renderer is available. A per-
    // element render token guards against a late promise from a previous
    // character overwriting the current one.
    setDockAvatarPortrait(avatarEl, pd, classType, false);

    var slot = document.getElementById('single-account-dock-card-slot');
    if (!slot) return;
    slot.innerHTML = '';
    if (singleAccountDockMinimized) return;

    var hp = Number(pd.hp || 0);
    var maxHp = Math.max(1, Number(pd.maxHp || 1));
    var hpPct = Math.min(100, Math.max(0, (hp / maxHp) * 100));
    var hpColor = hpPct > 50 ? '#3fb950' : hpPct > 25 ? '#d29922' : '#f85149';
    var ui = computeMacScriptSelectionUi(SINGLE_ACCOUNT_CLIENT_ID);

    var card = document.createElement('button');
    card.type = 'button';
    card.className = 'mac-card single-account-dock-card active';
    card.dataset.clientId = SINGLE_ACCOUNT_CLIENT_ID;

    var avatar = document.createElement('span');
    avatar.className = 'mac-avatar';
    setDockAvatarPortrait(avatar, pd, classType, true);

    var info = document.createElement('span');
    info.className = 'mac-info';
    info.innerHTML =
      '<span class="mac-name">' + escapeHtml(String(pd.name || 'Connected')) + '</span>' +
      '<span class="mac-server">' + escapeHtml(String(pd.server || currentServerName || '--')) + '</span>' +
      '<span class="mac-script-row">' +
        '<span class="mac-script-label">Script</span>' +
        '<span class="home-status-pill' + (ui.scriptStatusClass ? ' ' + ui.scriptStatusClass : '') + '">' + escapeHtml(ui.scriptPillText) + '</span>' +
      '</span>' +
      '<span class="mac-hp-track"><span class="mac-hp-fill" style="width:' + hpPct + '%;background:' + hpColor + '"></span></span>';

    card.appendChild(avatar);
    card.appendChild(info);
    card.addEventListener('click', function () {
      syncSingleAccountSyntheticClient();
      openMacPopout(SINGLE_ACCOUNT_CLIENT_ID);
    });
    slot.appendChild(card);
  }

  var singleDockToggle = document.getElementById('single-account-dock-toggle');
  if (singleDockToggle) {
    singleDockToggle.addEventListener('click', function () {
      setSingleAccountDockMinimized(!singleAccountDockMinimized);
    });
  }
  var singleDockMinimize = document.getElementById('single-account-dock-minimize');
  if (singleDockMinimize) {
    singleDockMinimize.addEventListener('click', function () {
      setSingleAccountDockMinimized(true);
    });
  }

  function applyMultiAccountView() {
    var playerCard = document.getElementById('player-card');
    var macPanel = document.getElementById('multi-account-panel');
    if (!playerCard || !macPanel) return;
    if (isMacStyleSidebar()) {
      connectedClients.delete(SINGLE_ACCOUNT_CLIENT_ID);
      if (macPopoutOpenClientId === SINGLE_ACCOUNT_CLIENT_ID) closeMacPopout();
      playerCard.classList.add('hidden');
      macPanel.classList.remove('hidden');
      applyMultiAccountSidebarModeUi();
      renderMultiAccountSidebar();
    } else {
      playerCard.classList.remove('hidden');
      macPanel.classList.add('hidden');
      closeMacPopout();
      setPlayerCardVisibility(gameConnected);
      renderSingleAccountDock();
    }
    if (activeTab === 'home') renderHomeTab();
  }

  function setMultiAccountSidebarMode(mode) {
    var normalized = String(mode || '').trim().toLowerCase() === 'launch' ? 'launch' : 'connected';
    if (multiAccountSidebarMode === normalized) return;
    multiAccountSidebarMode = normalized;
    localStorage.setItem('multiAccountSidebarMode', multiAccountSidebarMode);
    applyMultiAccountSidebarModeUi();
    renderMultiAccountSidebar();
  }

  function applyMultiAccountSidebarModeUi() {
    var connectedBtn = document.getElementById('multi-sidebar-mode-connected');
    var launchBtn = document.getElementById('multi-sidebar-mode-launch');
    var connectedList = document.getElementById('multi-account-connected-list');
    var launchPanel = document.getElementById('multi-account-launch-panel');
    var connectedMode = multiAccountSidebarMode !== 'launch';
    if (connectedBtn) {
      connectedBtn.classList.toggle('active', connectedMode);
      connectedBtn.setAttribute('aria-selected', connectedMode ? 'true' : 'false');
    }
    if (launchBtn) {
      launchBtn.classList.toggle('active', !connectedMode);
      launchBtn.setAttribute('aria-selected', connectedMode ? 'false' : 'true');
    }
    if (connectedList) connectedList.classList.toggle('hidden', !connectedMode);
    if (launchPanel) launchPanel.classList.toggle('hidden', connectedMode);
  }

  function getSortedDashboardAccountsForHome() {
    var getDisplayName = function (account) {
      return String(account.label || account.email || t('home.account.unnamed'));
    };
    var getSortFame = function (account) {
      var overview = accountOverviewById[account.id];
      if (!overview || typeof overview !== 'object') return 0;
      var bestFame = Number(overview.bestCharFame);
      if (Number.isFinite(bestFame)) return bestFame;
      var characters = Array.isArray(overview.characters) ? overview.characters : [];
      if (!characters.length) return 0;
      var fallbackBest = 0;
      characters.forEach(function (character) {
        var fame = Number(character && character.fame || 0);
        if (Number.isFinite(fame) && fame > fallbackBest) fallbackBest = fame;
      });
      return fallbackBest;
    };
    var sorted = dashboardAccounts.slice();
    sorted.sort(function (a, b) {
      var mode = String(homeAccountsSortMode || 'newest');
      if (mode === 'fame') {
        var fameDelta = getSortFame(b) - getSortFame(a);
        if (fameDelta !== 0) return fameDelta;
      } else if (mode === 'alphabetical') {
        var alpha = getDisplayName(a).localeCompare(getDisplayName(b), undefined, { sensitivity: 'base' });
        if (alpha !== 0) return alpha;
      } else if (mode === 'oldest') {
        var oldDelta = Number(a.createdAt || 0) - Number(b.createdAt || 0);
        if (oldDelta !== 0) return oldDelta;
      } else {
        var newDelta = Number(b.createdAt || 0) - Number(a.createdAt || 0);
        if (newDelta !== 0) return newDelta;
      }
      return getDisplayName(a).localeCompare(getDisplayName(b), undefined, { sensitivity: 'base' });
    });
      return sorted;
  }

  function getMacLaunchDerived(account) {
    var overview = accountOverviewById[account.id] || null;
    var characters = overview && Array.isArray(overview.characters) ? overview.characters : [];
    var anySeasonal = characters.some(function (c) {
      return c && c.seasonal;
    });
    var anyNonSeasonal = characters.some(function (c) {
      return c && !c.seasonal;
    });
    var f = macLaunchSeasonFilter || 'any';
    var best =
      f === 'yes'
        ? getBestOverviewCharacterInPool(overview, 'seasonal')
        : f === 'no'
          ? getBestOverviewCharacterInPool(overview, 'nonseasonal')
          : getBestOverviewCharacter(overview);

    var bestFame = best ? Number(best.fame || 0) : 0;
    if (!Number.isFinite(bestFame)) bestFame = 0;
    var bestSeasonal = !!(best && best.seasonal);
    var displayName = String(account.label || account.email || t('home.account.unnamed'));
    return {
      overview: overview,
      best: best,
      bestFame: bestFame,
      bestSeasonal: bestSeasonal,
      anySeasonal: anySeasonal,
      anyNonSeasonal: anyNonSeasonal,
      displayName: displayName,
    };
  }

  function passesMacLaunchSeasonFilters(derived) {
    var f = macLaunchSeasonFilter;
    if (f === 'yes' && !derived.anySeasonal) return false;
    if (f === 'no' && !derived.anyNonSeasonal) return false;
    return true;
  }

  function getMacLaunchSortedAccountRows() {
    var minF = Number(macLaunchMinFameNum || 0);
    if (!Number.isFinite(minF) || minF < 0) minF = 0;
    var items = [];
    dashboardAccounts.forEach(function (account) {
      var derived = getMacLaunchDerived(account);
      if (derived.bestFame < minF) return;
      if (!passesMacLaunchSeasonFilters(derived)) return;
      items.push({ account: account, derived: derived });
    });
    items.sort(function (x, y) {
      var a = x.account;
      var b = y.account;
      var da = x.derived;
      var db = y.derived;
      var mode = String(macLaunchSortMode || 'newest');
      if (mode === 'fame_high') {
        var fd = db.bestFame - da.bestFame;
        if (fd !== 0) return fd;
      } else if (mode === 'fame_low') {
        var fl = da.bestFame - db.bestFame;
        if (fl !== 0) return fl;
      } else if (mode === 'alphabetical') {
        var alpha = da.displayName.localeCompare(db.displayName, undefined, { sensitivity: 'base' });
        if (alpha !== 0) return alpha;
      } else if (mode === 'oldest') {
        var oldDelta = Number(a.createdAt || 0) - Number(b.createdAt || 0);
        if (oldDelta !== 0) return oldDelta;
      } else {
        var newDelta = Number(b.createdAt || 0) - Number(a.createdAt || 0);
        if (newDelta !== 0) return newDelta;
      }
      return da.displayName.localeCompare(db.displayName, undefined, { sensitivity: 'base' });
    });
    return items;
  }

  function setMacLaunchSortPopoutOpen(open) {
    var btn = document.getElementById('mac-launch-sort-btn');
    var pop = document.getElementById('mac-launch-sort-popout');
    if (!btn || !pop) return;
    macLaunchSortPopoutOpen = !!open;
    pop.classList.toggle('hidden', !macLaunchSortPopoutOpen);
    btn.setAttribute('aria-expanded', macLaunchSortPopoutOpen ? 'true' : 'false');
  }

  function syncMacLaunchControlsFromState() {
    var sm = document.getElementById('mac-launch-sort-mode');
    var sf = document.getElementById('mac-launch-season-filter');
    var mf = document.getElementById('mac-launch-min-fame');
    var modes = ['newest', 'oldest', 'alphabetical', 'fame_high', 'fame_low'];
    var seasons = ['any', 'yes', 'no'];
    if (sm && modes.indexOf(String(macLaunchSortMode || 'newest')) >= 0) sm.value = String(macLaunchSortMode);
    if (sf && seasons.indexOf(String(macLaunchSeasonFilter || 'any')) >= 0) sf.value = String(macLaunchSeasonFilter);
    if (mf) mf.value = String(macLaunchMinFameNum);
  }

  function updateMacLaunchSortSummary() {
    var el = document.getElementById('mac-launch-sort-summary');
    if (!el) return;
    var sep = t('mac.launch.summary.sep');
    var sm = document.getElementById('mac-launch-sort-mode');
    var sf = document.getElementById('mac-launch-season-filter');
    var sortLbl = sm && sm.selectedOptions && sm.selectedOptions[0] ? String(sm.selectedOptions[0].textContent || '').trim() : '';
    var seasonLbl = sf && sf.selectedOptions && sf.selectedOptions[0] ? String(sf.selectedOptions[0].textContent || '').trim() : '';
    var bits = [];
    if (sortLbl) bits.push(sortLbl);
    if (macLaunchSeasonFilter !== 'any') {
      bits.push(t('mac.launch.filterSeason') + ': ' + (seasonLbl || String(macLaunchSeasonFilter)));
    }
    if (macLaunchMinFameNum > 0) bits.push(tr('mac.launch.summaryMinFame', { n: Number(macLaunchMinFameNum).toLocaleString() }));
    el.textContent = bits.join(sep);
    el.classList.toggle('mac-launch-sort-summary--empty', bits.length === 0);
    el.setAttribute('aria-hidden', bits.length ? 'false' : 'true');
  }

  function bindMacLaunchSortControlsOnce() {
    if (macLaunchSortBindingsDone) return;
    var btn = document.getElementById('mac-launch-sort-btn');
    var pop = document.getElementById('mac-launch-sort-popout');
    var sm = document.getElementById('mac-launch-sort-mode');
    var sf = document.getElementById('mac-launch-season-filter');
    var mf = document.getElementById('mac-launch-min-fame');
    if (!btn || !pop || !sm || !sf || !mf) return;

    function commitMinFame() {
      var raw = String(mf.value || '').trim();
      var n = raw === '' ? 0 : Number(raw);
      if (!Number.isFinite(n) || n < 0) n = 0;
      macLaunchMinFameNum = n;
      localStorage.setItem('macLaunchMinFame', String(macLaunchMinFameNum));
      renderMultiAccountLaunchList();
    }

    btn.addEventListener('click', function (e) {
      e.stopPropagation();
      setMacLaunchSortPopoutOpen(!macLaunchSortPopoutOpen);
    });
    pop.addEventListener('click', function (e) {
      e.stopPropagation();
    });

    sm.addEventListener('change', function () {
      var v = String(sm.value || 'newest');
      if (['newest', 'oldest', 'alphabetical', 'fame_high', 'fame_low'].indexOf(v) < 0) v = 'newest';
      macLaunchSortMode = v;
      localStorage.setItem('macLaunchSortMode', macLaunchSortMode);
      renderMultiAccountLaunchList();
    });
    sf.addEventListener('change', function () {
      var v = String(sf.value || 'any');
      if (['any', 'yes', 'no'].indexOf(v) < 0) v = 'any';
      macLaunchSeasonFilter = v;
      localStorage.setItem('macLaunchSeasonFilter', macLaunchSeasonFilter);
      renderMultiAccountLaunchList();
    });
    mf.addEventListener('input', function () {
      if (macLaunchMinFameDebounceTimer) clearTimeout(macLaunchMinFameDebounceTimer);
      macLaunchMinFameDebounceTimer = setTimeout(commitMinFame, 300);
    });
    mf.addEventListener('change', function () {
      if (macLaunchMinFameDebounceTimer) clearTimeout(macLaunchMinFameDebounceTimer);
      commitMinFame();
    });

    document.addEventListener('click', function (e) {
      if (!macLaunchSortPopoutOpen) return;
      if (btn.contains(e.target)) return;
      if (pop.contains(e.target)) return;
      setMacLaunchSortPopoutOpen(false);
    });
    document.addEventListener('keydown', function (e) {
      if (!macLaunchSortPopoutOpen) return;
      if (e.key === 'Escape') setMacLaunchSortPopoutOpen(false);
    });

    macLaunchSortBindingsDone = true;
  }

  function clampMacLaunchGeomToRef(g, ref) {
    var rw = ref.width;
    var rh = ref.height;
    var w = Math.max(200, Math.min(Number(g.width) || 640, rw));
    var h = Math.max(150, Math.min(Number(g.height) || 360, rh));
    var x = Math.max(0, Math.min(Number(g.x) || 0, rw - w));
    var y = Math.max(0, Math.min(Number(g.y) || 0, rh - h));
    return { x: Math.round(x), y: Math.round(y), width: Math.round(w), height: Math.round(h) };
  }

  function scaleMacLaunchLayoutGeomMap(geomMap, oldRef, newRef) {
    var sx = newRef.width / Math.max(1, oldRef.width);
    var sy = newRef.height / Math.max(1, oldRef.height);
    var out = {};
    Object.keys(geomMap || {}).forEach(function (id) {
      var g = geomMap[id];
      if (!g) return;
      out[id] = clampMacLaunchGeomToRef(
        {
          x: g.x * sx,
          y: g.y * sy,
          width: g.width * sx,
          height: g.height * sy,
        },
        newRef,
      );
    });
    return out;
  }

  function defaultMacLaunchTileGrid(refW, refH, accountIds) {
    var n = accountIds.length;
    var out = {};
    if (!n) return out;
    var cols = Math.ceil(Math.sqrt(n));
    var rows = Math.ceil(n / cols);
    var gap = 8;
    var cellW = (refW - gap * (cols + 1)) / cols;
    var cellH = (refH - gap * (rows + 1)) / rows;
    accountIds.forEach(function (id, i) {
      var col = i % cols;
      var row = Math.floor(i / cols);
      out[id] = clampMacLaunchGeomToRef(
        {
          x: gap + col * (cellW + gap),
          y: gap + row * (cellH + gap),
          width: cellW,
          height: cellH,
        },
        { width: refW, height: refH },
      );
    });
    return out;
  }

  function normalizeMacLaunchGroup(raw) {
    if (!raw || typeof raw.id !== 'string' || typeof raw.name !== 'string') return null;
    var name = String(raw.name || '').trim() || 'Untitled';
    var layoutRef = { width: 1920, height: 1080 };
    if (raw.layoutRef && typeof raw.layoutRef === 'object') {
      var rw = Number(raw.layoutRef.width);
      var rh = Number(raw.layoutRef.height);
      if (Number.isFinite(rw) && rw >= 800 && rw <= 7680) layoutRef.width = Math.round(rw);
      if (Number.isFinite(rh) && rh >= 600 && rh <= 4320) layoutRef.height = Math.round(rh);
    }
    var members = [];
    if (Array.isArray(raw.members) && raw.members.length) {
      raw.members.forEach(function (m) {
        if (!m || typeof m.accountId !== 'string') return;
        var geom = clampMacLaunchGeomToRef(
          {
            x: m.x,
            y: m.y,
            width: m.width,
            height: m.height,
          },
          layoutRef,
        );
        members.push({ accountId: String(m.accountId), x: geom.x, y: geom.y, width: geom.width, height: geom.height });
      });
    } else if (Array.isArray(raw.accountIds) && raw.accountIds.length) {
      var ids = raw.accountIds.map(String);
      var grid = defaultMacLaunchTileGrid(layoutRef.width, layoutRef.height, ids);
      ids.forEach(function (id) {
        var g = grid[id];
        if (g) members.push({ accountId: id, x: g.x, y: g.y, width: g.width, height: g.height });
      });
    }
    if (!members.length) return null;
    return { id: String(raw.id), name: name, layoutRef: layoutRef, members: members };
  }

  function loadMacLaunchGroups() {
    try {
      var raw = localStorage.getItem('macLaunchAccountGroups');
      if (!raw) return [];
      var parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      var out = [];
      parsed.forEach(function (g) {
        if (!g || typeof g.id !== 'string' || typeof g.name !== 'string') return;
        if (!Array.isArray(g.members) && !Array.isArray(g.accountIds)) return;
        var norm = normalizeMacLaunchGroup(g);
        if (norm) out.push(norm);
      });
      return out;
    } catch (_err) {
      return [];
    }
  }

  function macLaunchGroupMemberIds(g) {
    if (!g || !Array.isArray(g.members)) return [];
    return g.members.map(function (m) {
      return m.accountId;
    });
  }

  function saveMacLaunchGroups(groups) {
    try {
      localStorage.setItem('macLaunchAccountGroups', JSON.stringify(groups));
    } catch (_err) {}
  }

  function closeMacLaunchGroupModal() {
    var modal = document.getElementById('mac-launch-group-modal');
    var stage = document.getElementById('mac-launch-group-layout-stage');
    if (stage) stage.innerHTML = '';
    macLaunchGroupLayoutByAccount = {};
    if (!modal) return;
    modal.style.display = 'none';
    modal.setAttribute('aria-hidden', 'true');
    macLaunchGroupModalEditingId = null;
  }

  function compareDashboardAccountLabel(a, b) {
    var la = String(a.label || a.email || '').toLowerCase();
    var lb = String(b.label || b.email || '').toLowerCase();
    if (la < lb) return -1;
    if (la > lb) return 1;
    return 0;
  }

  function populateMacLaunchGroupModalAccounts() {
    var scroll = document.getElementById('mac-launch-group-accounts-scroll');
    if (!scroll) return;
    scroll.innerHTML = '';
    var seen = {};
    var orderedIds = [];
    if (macLaunchGroupModalEditingId) {
      var groups = loadMacLaunchGroups();
      var cur = groups.find(function (g) {
        return g.id === macLaunchGroupModalEditingId;
      });
      if (cur && cur.members) {
        cur.members.forEach(function (m) {
          var id = m.accountId;
          if (!dashboardAccounts.some(function (a) {
            return a.id === id;
          })) return;
          if (seen[id]) return;
          seen[id] = true;
          orderedIds.push(id);
        });
      }
    }
    var rest = dashboardAccounts
      .filter(function (a) {
        return !seen[a.id];
      })
      .sort(compareDashboardAccountLabel);
    rest.forEach(function (a) {
      orderedIds.push(a.id);
    });

    orderedIds.forEach(function (id) {
      var account = dashboardAccounts.find(function (a) {
        return a.id === id;
      });
      if (!account) return;
      var line = document.createElement('label');
      line.className = 'mac-launch-group-account-line';
      var cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.className = 'mac-launch-group-acc-cb';
      cb.setAttribute('data-account-id', account.id);
      if (macLaunchGroupModalEditingId) {
        var g0 = loadMacLaunchGroups().find(function (g) {
          return g.id === macLaunchGroupModalEditingId;
        });
        if (g0 && g0.members && g0.members.some(function (mm) {
          return mm.accountId === account.id;
        })) cb.checked = true;
      }
      var span = document.createElement('span');
      var labelText = String(account.label || account.email || t('home.account.unnamed'));
      var hasCreds = !!String(account.email || '').trim() && !!String(account.password || '');
      span.textContent = labelText + (hasCreds ? '' : ' (Fix)');
      line.appendChild(cb);
      line.appendChild(span);
      scroll.appendChild(line);
    });
  }

  function openMacLaunchGroupModal(editId) {
    var modal = document.getElementById('mac-launch-group-modal');
    var titleEl = document.getElementById('mac-launch-group-modal-heading');
    var nameInput = document.getElementById('mac-launch-group-name-input');
    var delBtn = document.getElementById('mac-launch-group-delete-btn');
    var refWEl = document.getElementById('mac-launch-group-ref-w');
    var refHEl = document.getElementById('mac-launch-group-ref-h');
    if (!modal || !titleEl || !nameInput) return;
    macLaunchGroupLayoutByAccount = {};
    macLaunchGroupLayoutRefSnapshot = { width: 1920, height: 1080 };
    if (refWEl) refWEl.value = '1920';
    if (refHEl) refHEl.value = '1080';
    macLaunchGroupModalEditingId = editId || null;
    if (editId) {
      var grp = loadMacLaunchGroups().find(function (g) {
        return g.id === editId;
      });
      titleEl.textContent = t('mac.launch.groupsModal.editTitle');
      nameInput.value = grp ? grp.name : '';
      if (delBtn) delBtn.style.display = '';
      if (grp && grp.layoutRef) {
        if (refWEl) refWEl.value = String(grp.layoutRef.width);
        if (refHEl) refHEl.value = String(grp.layoutRef.height);
      }
      if (grp && grp.members) {
        grp.members.forEach(function (m) {
          macLaunchGroupLayoutByAccount[m.accountId] = {
            x: m.x,
            y: m.y,
            width: m.width,
            height: m.height,
          };
        });
      }
    } else {
      titleEl.textContent = t('mac.launch.groupsModal.newTitle');
      nameInput.value = '';
      if (delBtn) delBtn.style.display = 'none';
    }
    populateMacLaunchGroupModalAccounts();
    var noOvEl = document.getElementById('mac-launch-group-no-overlap');
    if (noOvEl) {
      try {
        noOvEl.checked = localStorage.getItem(MAC_LAUNCH_GROUP_NO_OVERLAP_LS_KEY) === '1';
      } catch (_ls) {
        noOvEl.checked = false;
      }
    }
    modal.style.display = 'flex';
    modal.setAttribute('aria-hidden', 'false');
    macLaunchGroupLayoutRefSnapshot = getMacLaunchGroupLayoutRefFromInputs();
    rebuildMacLaunchGroupLayoutStage();
    try {
      nameInput.focus();
      nameInput.select();
    } catch (_e2) {}
  }

  function getMacLaunchGroupLayoutRefFromInputs() {
    var refWEl = document.getElementById('mac-launch-group-ref-w');
    var refHEl = document.getElementById('mac-launch-group-ref-h');
    var w = parseInt(refWEl && refWEl.value, 10);
    var h = parseInt(refHEl && refHEl.value, 10);
    if (!Number.isFinite(w) || w < 800) w = 1920;
    if (!Number.isFinite(h) || h < 600) h = 1080;
    if (w > 7680) w = 7680;
    if (h > 4320) h = 4320;
    return { width: w, height: h };
  }

  function saveMacLaunchGroupFromModal() {
    var nameInput = document.getElementById('mac-launch-group-name-input');
    var scroll = document.getElementById('mac-launch-group-accounts-scroll');
    if (!nameInput || !scroll) return;
    var name = String(nameInput.value || '').trim();
    if (!name) {
      setHomeActionStatus(t('mac.launch.groupsModal.needName'));
      return;
    }
    var ids = [];
    scroll.querySelectorAll('.mac-launch-group-acc-cb').forEach(function (cb) {
      if (cb.checked) ids.push(String(cb.getAttribute('data-account-id') || ''));
    });
    if (!ids.length) {
      setHomeActionStatus(t('mac.launch.groupsModal.needAccount'));
      return;
    }
    var ref = getMacLaunchGroupLayoutRefFromInputs();
    var gridFallback = defaultMacLaunchTileGrid(ref.width, ref.height, ids);
    var members = ids.map(function (id) {
      var g = macLaunchGroupLayoutByAccount[id] || gridFallback[id];
      if (!g) g = { x: 8, y: 8, width: 640, height: 360 };
      g = clampMacLaunchGeomToRef(g, ref);
      return { accountId: id, x: g.x, y: g.y, width: g.width, height: g.height };
    });
    var groups = loadMacLaunchGroups();
    if (macLaunchGroupModalEditingId) {
      var ix = groups.findIndex(function (g) {
        return g.id === macLaunchGroupModalEditingId;
      });
      if (ix >= 0) {
        groups[ix] = { id: groups[ix].id, name: name, layoutRef: ref, members: members };
      }
    } else {
      groups.push({
        id: 'lg-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8),
        name: name,
        layoutRef: ref,
        members: members,
      });
    }
    saveMacLaunchGroups(groups);
    closeMacLaunchGroupModal();
    renderMacLaunchGroupsList();
    setHomeActionStatus(t('mac.launch.groupsSaved'));
  }

  function deleteMacLaunchGroupFromModal() {
    if (!macLaunchGroupModalEditingId) return;
    if (!window.confirm(t('mac.launch.groupsModal.confirmDelete'))) return;
    var groups = loadMacLaunchGroups().filter(function (g) {
      return g.id !== macLaunchGroupModalEditingId;
    });
    saveMacLaunchGroups(groups);
    closeMacLaunchGroupModal();
    renderMacLaunchGroupsList();
  }

  function launchMacAccountGroupById(groupId) {
    var grp = loadMacLaunchGroups().find(function (g) {
      return g.id === groupId;
    });
    if (!grp || !Array.isArray(grp.members)) return;
    var withLaunch = [];
    var skipped = 0;
    grp.members.forEach(function (m) {
      var account = dashboardAccounts.find(function (a) {
        return a.id === m.accountId;
      });
      if (!account) return;
      var em = String(account.email || '').trim();
      var pw = String(account.password || '');
      if (!em || !pw) {
        skipped++;
        return;
      }
      withLaunch.push({
        account: account,
        rect: { x: m.x, y: m.y, width: m.width, height: m.height },
      });
    });
    if (!withLaunch.length) {
      addHomeFeed('err', skipped ? t('mac.launch.groupSkippedNoCreds', { n: skipped }) : t('mac.launch.groupsModal.needAccount'));
      setHomeActionStatus(t('home.action.missingCreds'));
      return;
    }
    if (!ws || ws.readyState !== 1) {
      addHomeFeed('err', t('home.action.launchOffline'));
      setHomeActionStatus(t('home.action.launchOffline'));
      return;
    }
    var totalMs = withLaunch.length * MAC_GROUP_LAUNCH_STAGGER_MS + 12000;
    macGroupLaunchQuietFeedUntil = Date.now() + totalMs;
    var summaryBits = [tr('mac.launch.groupQueued', { name: grp.name, n: withLaunch.length })];
    if (skipped) summaryBits.push(t('mac.launch.groupSkippedNoCreds', { n: skipped }));
    addHomeFeed('act', summaryBits.join(' '));
    setHomeActionStatus(t('home.action.launchSent'));
    withLaunch.forEach(function (entry, i) {
      window.setTimeout(function () {
        var account = entry.account;
        selectedAccountId = account.id;
        renderAccountsTab();
        launchGameWithCredentials(
          String(account.email || '').trim(),
          String(account.password || ''),
          String(account.serverName || 'USWest').trim() || 'USWest',
          false,
          launchOptsWithAccount(account, {
            suppressAccountsLaunchBtn: true,
            windowRect: entry.rect,
          }),
        );
      }, i * MAC_GROUP_LAUNCH_STAGGER_MS);
    });
  }

  function wireMacLaunchGroupLayoutWin(win, stage) {
    var MIN_W = 72;
    var MIN_H = 52;
    var dragging = false;
    var resizing = false;
    var resizeDir = '';
    var startClientX = 0;
    var startClientY = 0;
    var startLeft = 0;
    var startTop = 0;
    var startW = 0;
    var startH = 0;
    /** Last resize pose that did not overlap others (when “prevent overlap” is on). */
    var lastGoodResize = null;

    function macLaunchNoOverlapOn() {
      var el = document.getElementById('mac-launch-group-no-overlap');
      return !!(el && el.checked);
    }

    function getOtherWinPixelRects() {
      var sr = stage.getBoundingClientRect();
      var out = [];
      stage.querySelectorAll('.mac-launch-group-layout-win').forEach(function (wEl) {
        if (wEl === win) return;
        var wr = wEl.getBoundingClientRect();
        out.push({
          l: wr.left - sr.left,
          t: wr.top - sr.top,
          w: wr.width,
          h: wr.height,
        });
      });
      return out;
    }

    function rectsOverlap(a, b) {
      return !(a.l + a.w <= b.l || b.l + b.w <= a.l || a.t + a.h <= b.t || b.t + b.h <= a.t);
    }

    function overlapsAny(test, others) {
      for (var i = 0; i < others.length; i++) {
        if (rectsOverlap(test, others[i])) return true;
      }
      return false;
    }

    function resolveDragNoOverlap(l, t, w, h, others, sw, sh, preferL, preferT) {
      var r = clampStageRect(l, t, w, h, sw, sh);
      if (!macLaunchNoOverlapOn()) return r;
      var guard = 0;
      while (guard++ < 80) {
        var hit = null;
        for (var i = 0; i < others.length; i++) {
          if (rectsOverlap(r, others[i])) {
            hit = others[i];
            break;
          }
        }
        if (!hit) break;
        var o = hit;
        var cand = [
          { l: o.l + o.w, t: r.t },
          { l: o.l - r.w, t: r.t },
          { l: r.l, t: o.t + o.h },
          { l: r.l, t: o.t - r.h },
        ];
        var best = null;
        var bestScore = Infinity;
        for (var j = 0; j < cand.length; j++) {
          var c = cand[j];
          var nl = Math.max(0, Math.min(c.l, sw - r.w));
          var nt = Math.max(0, Math.min(c.t, sh - r.h));
          var rr = clampStageRect(nl, nt, r.w, r.h, sw, sh);
          if (!rectsOverlap(rr, o)) {
            var dist = Math.abs(rr.l - preferL) + Math.abs(rr.t - preferT);
            if (dist < bestScore) {
              bestScore = dist;
              best = rr;
            }
          }
        }
        if (best) {
          r = best;
          continue;
        }
        var overlapX = Math.min(r.l + r.w, o.l + o.w) - Math.max(r.l, o.l);
        var overlapY = Math.min(r.t + r.h, o.t + o.h) - Math.max(r.t, o.t);
        if (overlapX <= 0 || overlapY <= 0) break;
        if (overlapX < overlapY) {
          if (r.l + r.w / 2 < o.l + o.w / 2) r.l = o.l - r.w;
          else r.l = o.l + o.w;
        } else {
          if (r.t + r.h / 2 < o.t + o.h / 2) r.t = o.t - r.h;
          else r.t = o.t + o.h;
        }
        r = clampStageRect(r.l, r.t, r.w, r.h, sw, sh);
      }
      return r;
    }

    function commitGeomFromDom() {
      var ref = getMacLaunchGroupLayoutRefFromInputs();
      var sw = stage.clientWidth;
      var sh = stage.clientHeight;
      if (sw < 1 || sh < 1) return;
      var id = win.getAttribute('data-account-id');
      if (!id) return;
      var wr = win.getBoundingClientRect();
      var sr = stage.getBoundingClientRect();
      var left = wr.left - sr.left;
      var top = wr.top - sr.top;
      macLaunchGroupLayoutByAccount[id] = clampMacLaunchGeomToRef(
        {
          x: (left / sw) * ref.width,
          y: (top / sh) * ref.height,
          width: (wr.width / sw) * ref.width,
          height: (wr.height / sh) * ref.height,
        },
        ref,
      );
    }

    function clampStageRect(l, t, w, h, sw, sh) {
      w = Math.max(MIN_W, w);
      h = Math.max(MIN_H, h);
      if (l < 0) {
        w += l;
        l = 0;
      }
      if (t < 0) {
        h += t;
        t = 0;
      }
      w = Math.max(MIN_W, w);
      h = Math.max(MIN_H, h);
      if (l + w > sw) w = Math.max(MIN_W, sw - l);
      if (t + h > sh) h = Math.max(MIN_H, sh - t);
      if (l + w > sw) l = Math.max(0, sw - w);
      if (t + h > sh) t = Math.max(0, sh - h);
      return { l: l, t: t, w: w, h: h };
    }

    function applyResizeMove(e) {
      var sw = stage.clientWidth;
      var sh = stage.clientHeight;
      var dx = e.clientX - startClientX;
      var dy = e.clientY - startClientY;
      var l = startLeft;
      var t = startTop;
      var w = startW;
      var h = startH;
      switch (resizeDir) {
        case 'se':
          w = startW + dx;
          h = startH + dy;
          break;
        case 'nw':
          l = startLeft + dx;
          t = startTop + dy;
          w = startW - dx;
          h = startH - dy;
          break;
        case 'ne':
          t = startTop + dy;
          w = startW + dx;
          h = startH - dy;
          break;
        case 'sw':
          l = startLeft + dx;
          w = startW - dx;
          h = startH + dy;
          break;
        case 'n':
          t = startTop + dy;
          h = startH - dy;
          break;
        case 's':
          h = startH + dy;
          break;
        case 'e':
          w = startW + dx;
          break;
        case 'w':
          l = startLeft + dx;
          w = startW - dx;
          break;
        default:
          return;
      }
      var r = clampStageRect(l, t, w, h, sw, sh);
      if (macLaunchNoOverlapOn()) {
        var others = getOtherWinPixelRects();
        var test = { l: r.l, t: r.t, w: r.w, h: r.h };
        if (overlapsAny(test, others)) {
          if (lastGoodResize) {
            win.style.left = lastGoodResize.l + 'px';
            win.style.top = lastGoodResize.t + 'px';
            win.style.width = lastGoodResize.w + 'px';
            win.style.height = lastGoodResize.h + 'px';
          }
          return;
        }
        lastGoodResize = { l: r.l, t: r.t, w: r.w, h: r.h };
      }
      win.style.left = r.l + 'px';
      win.style.top = r.t + 'px';
      win.style.width = r.w + 'px';
      win.style.height = r.h + 'px';
      if (!macLaunchNoOverlapOn()) lastGoodResize = { l: r.l, t: r.t, w: r.w, h: r.h };
    }

    function endResizeDoc(e) {
      if (!resizing) return;
      resizing = false;
      resizeDir = '';
      document.removeEventListener('pointermove', onResizeDocMove);
      document.removeEventListener('pointerup', endResizeDoc);
      document.removeEventListener('pointercancel', endResizeDoc);
      commitGeomFromDom();
    }

    function onResizeDocMove(e) {
      if (!resizing) return;
      applyResizeMove(e);
    }

    win.addEventListener('pointerdown', function (e) {
      if (e.button !== 0) return;
      if (e.target.closest('.mac-launch-group-layout-handle')) return;
      e.preventDefault();
      dragging = true;
      resizing = false;
      startClientX = e.clientX;
      startClientY = e.clientY;
      var wr = win.getBoundingClientRect();
      var sr = stage.getBoundingClientRect();
      startLeft = wr.left - sr.left;
      startTop = wr.top - sr.top;
      startW = wr.width;
      startH = wr.height;
      try {
        win.setPointerCapture(e.pointerId);
      } catch (_e) {}
    });

    win.addEventListener('pointermove', function (e) {
      if (!dragging || resizing) return;
      var dx = e.clientX - startClientX;
      var dy = e.clientY - startClientY;
      var sw = stage.clientWidth;
      var sh = stage.clientHeight;
      var nl = startLeft + dx;
      var nt = startTop + dy;
      nl = Math.max(0, Math.min(nl, sw - startW));
      nt = Math.max(0, Math.min(nt, sh - startH));
      var others = getOtherWinPixelRects();
      var r = resolveDragNoOverlap(nl, nt, startW, startH, others, sw, sh, nl, nt);
      win.style.left = r.l + 'px';
      win.style.top = r.t + 'px';
    });

    function endDrag(e) {
      if (!dragging) return;
      dragging = false;
      try {
        win.releasePointerCapture(e.pointerId);
      } catch (_e2) {}
      commitGeomFromDom();
    }
    win.addEventListener('pointerup', endDrag);
    win.addEventListener('pointercancel', endDrag);

    win.querySelectorAll('.mac-launch-group-layout-handle').forEach(function (handleEl) {
      handleEl.addEventListener('pointerdown', function (e) {
        if (e.button !== 0) return;
        e.preventDefault();
        e.stopPropagation();
        dragging = false;
        resizing = true;
        resizeDir = String(handleEl.getAttribute('data-dir') || 'se');
        startClientX = e.clientX;
        startClientY = e.clientY;
        var wr = win.getBoundingClientRect();
        var sr = stage.getBoundingClientRect();
        startLeft = wr.left - sr.left;
        startTop = wr.top - sr.top;
        startW = wr.width;
        startH = wr.height;
        lastGoodResize = { l: startLeft, t: startTop, w: startW, h: startH };
        document.addEventListener('pointermove', onResizeDocMove);
        document.addEventListener('pointerup', endResizeDoc);
        document.addEventListener('pointercancel', endResizeDoc);
        try {
          handleEl.setPointerCapture(e.pointerId);
        } catch (_eh) {}
      });
    });
  }

  function rebuildMacLaunchGroupLayoutStage() {
    var scroll = document.getElementById('mac-launch-group-accounts-scroll');
    var stage = document.getElementById('mac-launch-group-layout-stage');
    if (!scroll || !stage) return;
    var ref = getMacLaunchGroupLayoutRefFromInputs();
    var ids = [];
    scroll.querySelectorAll('.mac-launch-group-acc-cb').forEach(function (cb) {
      if (cb.checked) ids.push(String(cb.getAttribute('data-account-id') || ''));
    });
    var prevGeom = macLaunchGroupLayoutByAccount;
    macLaunchGroupLayoutByAccount = {};
    var grid = defaultMacLaunchTileGrid(ref.width, ref.height, ids);
    ids.forEach(function (id) {
      if (prevGeom[id]) {
        macLaunchGroupLayoutByAccount[id] = clampMacLaunchGeomToRef(prevGeom[id], ref);
      } else if (grid[id]) {
        macLaunchGroupLayoutByAccount[id] = grid[id];
      }
    });
    stage.innerHTML = '';
    if (!ids.length) return;

    function paint() {
      stage.style.aspectRatio = ref.width + ' / ' + ref.height;
      var sw = stage.clientWidth;
      var sh = stage.clientHeight;
      if (sw < 24 || sh < 24) {
        window.requestAnimationFrame(paint);
        return;
      }
      ids.forEach(function (id) {
        var account = dashboardAccounts.find(function (a) {
          return a.id === id;
        });
        var g = macLaunchGroupLayoutByAccount[id];
        if (!account || !g) return;
        var win = document.createElement('div');
        win.className = 'mac-launch-group-layout-win';
        win.setAttribute('data-account-id', id);
        win.style.left = (g.x / ref.width) * sw + 'px';
        win.style.top = (g.y / ref.height) * sh + 'px';
        win.style.width = (g.width / ref.width) * sw + 'px';
        win.style.height = (g.height / ref.height) * sh + 'px';
        var head = document.createElement('div');
        head.className = 'mac-launch-group-layout-win-head';
        head.textContent = String(account.label || account.email || t('home.account.unnamed')).slice(0, 22);
        var handles = document.createElement('div');
        handles.className = 'mac-launch-group-layout-handles';
        handles.setAttribute('aria-hidden', 'true');
        ['nw', 'n', 'ne', 'w', 'e', 'sw', 's', 'se'].forEach(function (dir) {
          var h = document.createElement('div');
          h.className = 'mac-launch-group-layout-handle mac-launch-group-layout-handle--' + dir;
          h.setAttribute('data-dir', dir);
          handles.appendChild(h);
        });
        win.appendChild(head);
        win.appendChild(handles);
        stage.appendChild(win);
        wireMacLaunchGroupLayoutWin(win, stage);
      });
    }
    window.requestAnimationFrame(function () {
      window.requestAnimationFrame(paint);
    });
  }

  function renderMacLaunchGroupsList() {
    var container = document.getElementById('mac-launch-groups-list');
    if (!container) return;
    bindMacLaunchGroupsOnce();
    container.innerHTML = '';
    var groups = loadMacLaunchGroups();
    if (!groups.length) {
      var empty = document.createElement('div');
      empty.className = 'mac-launch-groups-empty';
      empty.setAttribute('data-i18n', 'mac.launch.groupsEmpty');
      empty.textContent = t('mac.launch.groupsEmpty');
      container.appendChild(empty);
      return;
    }
    groups.forEach(function (g) {
      var ids = macLaunchGroupMemberIds(g);
      var present = ids.filter(function (id) {
        return dashboardAccounts.some(function (a) {
          return a.id === id;
        });
      }).length;
      var row = document.createElement('div');
      row.className = 'mac-launch-group-row';
      row.setAttribute('role', 'listitem');
      row.innerHTML =
        '<div class="mac-launch-group-row-main">' +
          '<div class="mac-launch-group-row-name">' + escapeHtml(g.name) + '</div>' +
          '<div class="mac-launch-group-row-meta">' +
            escapeHtml(tr('mac.launch.groupsRowMeta', { present: present, total: ids.length })) +
          '</div>' +
        '</div>' +
        '<div class="mac-launch-group-row-actions">' +
          '<button type="button" class="setting-btn mac-launch-group-launch-btn" data-mac-group-launch="' +
            escapeHtml(g.id) +
            '" data-i18n="mac.launch.groupsLaunch">' +
            escapeHtml(t('mac.launch.groupsLaunch')) +
          '</button>' +
          '<button type="button" class="setting-btn setting-btn-secondary mac-launch-group-edit-btn" data-mac-group-edit="' +
            escapeHtml(g.id) +
            '" data-i18n="mac.launch.groupsEdit">' +
            escapeHtml(t('mac.launch.groupsEdit')) +
          '</button>' +
        '</div>';
      container.appendChild(row);
    });
  }

  function bindMacLaunchGroupsOnce() {
    if (macLaunchGroupsBindingsDone) return;
    macLaunchGroupsBindingsDone = true;
    var addBtn = document.getElementById('mac-launch-group-add');
    var modal = document.getElementById('mac-launch-group-modal');
    var saveBtn = document.getElementById('mac-launch-group-save-btn');
    var delBtn = document.getElementById('mac-launch-group-delete-btn');
    var list = document.getElementById('mac-launch-groups-list');
    if (addBtn) {
      addBtn.addEventListener('click', function () {
        openMacLaunchGroupModal(null);
      });
    }
    if (modal) {
      modal.querySelectorAll('[data-mac-group-modal-close]').forEach(function (el) {
        el.addEventListener('click', function () {
          closeMacLaunchGroupModal();
        });
      });
    }
    if (saveBtn) saveBtn.addEventListener('click', saveMacLaunchGroupFromModal);
    if (delBtn) delBtn.addEventListener('click', deleteMacLaunchGroupFromModal);
    var accScroll = document.getElementById('mac-launch-group-accounts-scroll');
    if (accScroll) {
      accScroll.addEventListener('change', function (e) {
        var t = e.target;
        if (!t || !t.classList || !t.classList.contains('mac-launch-group-acc-cb')) return;
        rebuildMacLaunchGroupLayoutStage();
      });
    }
    var refWInput = document.getElementById('mac-launch-group-ref-w');
    var refHInput = document.getElementById('mac-launch-group-ref-h');
    function onMacLaunchLayoutRefChange() {
      var newRef = getMacLaunchGroupLayoutRefFromInputs();
      macLaunchGroupLayoutByAccount = scaleMacLaunchLayoutGeomMap(
        macLaunchGroupLayoutByAccount,
        macLaunchGroupLayoutRefSnapshot,
        newRef,
      );
      macLaunchGroupLayoutRefSnapshot = newRef;
      rebuildMacLaunchGroupLayoutStage();
    }
    if (refWInput) refWInput.addEventListener('change', onMacLaunchLayoutRefChange);
    if (refHInput) refHInput.addEventListener('change', onMacLaunchLayoutRefChange);
    var noOvEl = document.getElementById('mac-launch-group-no-overlap');
    if (noOvEl && !noOvEl.dataset.macNoOverlapBound) {
      noOvEl.dataset.macNoOverlapBound = '1';
      noOvEl.addEventListener('change', function () {
        try {
          localStorage.setItem(MAC_LAUNCH_GROUP_NO_OVERLAP_LS_KEY, noOvEl.checked ? '1' : '0');
        } catch (_ls2) {}
      });
    }
    if (list) {
      list.addEventListener('click', function (e) {
        var launchBtn = e.target.closest('[data-mac-group-launch]');
        if (launchBtn) {
          var id = String(launchBtn.getAttribute('data-mac-group-launch') || '');
          if (id) launchMacAccountGroupById(id);
          return;
        }
        var editBtn = e.target.closest('[data-mac-group-edit]');
        if (editBtn) {
          var id2 = String(editBtn.getAttribute('data-mac-group-edit') || '');
          if (id2) openMacLaunchGroupModal(id2);
        }
      });
    }
    document.addEventListener('keydown', function (e) {
      if (e.key !== 'Escape') return;
      var m = document.getElementById('mac-launch-group-modal');
      if (m && m.style.display !== 'none') closeMacLaunchGroupModal();
    });
  }

  function renderMultiAccountSidebar() {
    if (multiAccountSidebarMode === 'launch') {
      renderMultiAccountLaunchList();
    } else {
      renderMultiAccountConnectedList();
    }
  }

  function renderMultiAccountConnectedList() {
    var list = document.getElementById('multi-account-connected-list');
    if (!list) return;
    list.innerHTML = '';
    if (connectedClients.size === 0) {
      var empty = document.createElement('div');
      empty.className = 'mac-empty';
      empty.textContent = 'No accounts connected';
      list.appendChild(empty);
      return;
    }
    connectedClients.forEach(function (c, clientId) {
      var pd = c.fullData || c;
      var hp = c.hp || 0;
      var maxHp = c.maxHp || 1;
      var hpPct = Math.min(100, Math.max(0, (hp / maxHp) * 100));
      var hpColor = hpPct > 50 ? '#3fb950' : hpPct > 25 ? '#d29922' : '#f85149';
      var classType = Number(pd.classType != null ? pd.classType : c.classType);
      var skin = Number(pd.skin != null ? pd.skin : c.skin);
      var tex1 = Number(pd.tex1 != null ? pd.tex1 : c.tex1);
      var tex2 = Number(pd.tex2 != null ? pd.tex2 : c.tex2);

      var card = document.createElement('div');
      card.className = 'mac-card' + (clientId === multiHomeFocusedClientId ? ' active' : '');
      card.dataset.clientId = clientId;

      var avatarEl = document.createElement('div');
      avatarEl.className = 'mac-avatar';
      if (classType && CLASS_COLORS && CLASS_COLORS[classType]) {
        avatarEl.textContent = '';
        avatarEl.style.backgroundImage = 'url(' + renderClassSprite(classType) + ')';
        avatarEl.style.backgroundSize = 'contain';
        avatarEl.style.backgroundRepeat = 'no-repeat';
        avatarEl.style.backgroundPosition = 'center';
        avatarEl.style.imageRendering = 'pixelated';
        if (typeof window.renderEamPortrait === 'function') {
          window.renderEamPortrait(
            classType,
            Number.isFinite(skin) && skin > 0 ? skin : classType,
            Number.isFinite(tex1) ? tex1 : 0,
            Number.isFinite(tex2) ? tex2 : 0
          ).then(function (portraitUrl) {
            if (!portraitUrl) return;
            avatarEl.style.backgroundImage = 'url(' + portraitUrl + ')';
          }).catch(function () {});
        }
      } else {
        avatarEl.textContent = '?';
      }

      var info = document.createElement('div');
      info.className = 'mac-info';

      var nameEl = document.createElement('span');
      nameEl.className = 'mac-name';
      nameEl.textContent = c.name || 'Connecting...';

      var serverEl = document.createElement('span');
      serverEl.className = 'mac-server';
      serverEl.textContent = c.server || '--';

      var barWrap = document.createElement('div');
      barWrap.className = 'mac-hp-track';
      var barFill = document.createElement('div');
      barFill.className = 'mac-hp-fill';
      barFill.style.width = hpPct + '%';
      barFill.style.background = hpColor;
      barWrap.appendChild(barFill);

      var scriptUi = computeMacScriptSelectionUi(clientId);
      var scriptRow = document.createElement('div');
      scriptRow.className = 'mac-script-row';
      var scriptLbl = document.createElement('span');
      scriptLbl.className = 'mac-script-label';
      scriptLbl.textContent = 'Script';
      var scriptPill = document.createElement('span');
      scriptPill.className =
        'home-status-pill' + (scriptUi.scriptStatusClass ? ' ' + scriptUi.scriptStatusClass : '');
      scriptPill.title = scriptUi.scriptPillText;
      scriptPill.textContent = scriptUi.scriptPillText;
      scriptRow.appendChild(scriptLbl);
      scriptRow.appendChild(scriptPill);

      info.appendChild(nameEl);
      info.appendChild(serverEl);
      info.appendChild(scriptRow);
      info.appendChild(barWrap);
      card.appendChild(avatarEl);
      card.appendChild(info);
      list.appendChild(card);

      card.addEventListener('click', function () {
        multiHomeFocusedClientId = clientId;
        if (activeTab === 'home') renderHomeTab();
        openMacPopout(clientId);
      });
    });
  }

  function renderMultiAccountLaunchList() {
    bindMacLaunchSortControlsOnce();
    syncMacLaunchControlsFromState();
    updateMacLaunchSortSummary();
    renderMacLaunchGroupsList();

    var list = document.getElementById('multi-account-launch-list');
    if (!list) return;
    list.innerHTML = '';
    if (!dashboardAccounts.length) {
      var empty = document.createElement('div');
      empty.className = 'mac-empty';
      empty.textContent = t('home.accounts.noConfigured');
      list.appendChild(empty);
      return;
    }

    var sortedRows = getMacLaunchSortedAccountRows();
    if (!sortedRows.length) {
      var emptyNm = document.createElement('div');
      emptyNm.className = 'mac-empty';
      emptyNm.textContent = t('mac.launch.noMatch');
      list.appendChild(emptyNm);
      return;
    }

    sortedRows.forEach(function (sortRow) {
      var account = sortRow.account;
      var overview = accountOverviewById[account.id] || null;
      var bestCharacter = sortRow.derived.best;
      var isLoading = homeAccountOverviewLoadingIds.has(account.id);
      if (!bestCharacter && !isLoading) prefetchHomeDashboardAccountOverview(account);

      var hasCreds = !!String(account.email || '').trim() && !!String(account.password || '');
      var name = String(account.label || account.email || t('home.account.unnamed'));
      var className = bestCharacter ? String(bestCharacter.className || bestCharacter.classTypeHex || 'Unknown') : '--';
      var fameText = bestCharacter ? Number(bestCharacter.fame || 0).toLocaleString() : '--';
      var characterLine = 'Class: ' + className + ' • Fame: ' + fameText;
      var equipmentSummary = bestCharacter
        ? buildEquipmentSpriteStripHtml(bestCharacter.equipment, 'mac-launch-gear-strip')
        : '<div class="home-note">' + escapeHtml(isLoading ? t('home.accounts.fetchingTop') : t('home.accounts.charNotLoaded')) + '</div>';

      var avatarPlaceholder =
        bestCharacter ? '' : isLoading
          ? '…'
          : '?';
      var avatarExtraClass =
        bestCharacter ? '' : isLoading ? ' home-account-class-avatar--loading' : ' home-account-class-avatar--empty';

      var rowEl = document.createElement('div');
      rowEl.className = 'mac-launch-row';
      rowEl.innerHTML =
        '<div class="home-account-class-avatar' +
          avatarExtraClass +
          '" aria-hidden="true">' +
          escapeHtml(avatarPlaceholder) +
          '</div>' +
        '<div class="mac-launch-main">' +
          '<div class="mac-launch-head">' +
            '<span class="mac-launch-name">' + escapeHtml(name) + '</span>' +
            '<button type="button" class="setting-btn mac-launch-btn" data-mac-launch-id="' + escapeHtml(String(account.id)) + '">' + escapeHtml(hasCreds ? t('btn.launch') : 'Fix') + '</button>' +
          '</div>' +
          '<div class="mac-launch-meta">' + escapeHtml(characterLine) + '</div>' +
          '<div class="mac-launch-gear">' + equipmentSummary + '</div>' +
        '</div>';
      list.appendChild(rowEl);
      applyHomeAccountClassAvatar(rowEl.querySelector('.home-account-class-avatar'), bestCharacter, isLoading);
    });

    list.querySelectorAll('[data-mac-launch-id]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var accountId = String(btn.getAttribute('data-mac-launch-id') || '');
        var account = dashboardAccounts.find(function (entry) { return entry.id === accountId; });
        if (!account) return;
        selectedAccountId = account.id;
        renderAccountsTab();
        if (String(account.email || '').trim() && String(account.password || '')) {
          var launched = launchGameWithCredentials(
            String(account.email || '').trim(),
            String(account.password || ''),
            String(account.serverName || 'USWest').trim() || 'USWest',
            true,
            launchOptsWithAccount(account, {}),
          );
          if (launched) {
            addHomeFeed('act', tr('home.action.launchRequested', { name: String(account.label || account.email || t('accounts.summary.defaultName')) }));
            setHomeActionStatus(t('home.action.launchSent'));
          } else {
            addHomeFeed('err', t('home.action.launchOffline'));
            setHomeActionStatus(t('home.action.launchOffline'));
          }
        } else {
          openDashboardTab('accounts');
          setHomeActionStatus(t('home.action.missingCreds'));
        }
      });
    });
  }

  function setMacPopoutTab(which) {
    var isDev = which === 'dev';
    var paneO = document.getElementById('mac-popout-pane-overview');
    var paneD = document.getElementById('mac-popout-pane-dev');
    var btnO = document.getElementById('mac-popout-tab-overview');
    var btnD = document.getElementById('mac-popout-tab-dev');
    if (paneO) paneO.hidden = isDev;
    if (paneD) paneD.hidden = !isDev;
    if (btnO) {
      btnO.classList.toggle('active', !isDev);
      btnO.setAttribute('aria-selected', !isDev ? 'true' : 'false');
    }
    if (btnD) {
      btnD.classList.toggle('active', isDev);
      btnD.setAttribute('aria-selected', isDev ? 'true' : 'false');
    }
    try {
      localStorage.setItem('macPopoutActiveTab', isDev ? 'dev' : 'overview');
    } catch (_e) {}
  }

  function openMacPopout(clientId) {
    var c = connectedClients.get(clientId);
    if (!c) return;
    macPopoutOpenClientId = clientId;
    var body = document.getElementById('multi-account-popout-body');
    var popout = document.getElementById('multi-account-popout');
    if (!body || !popout) return;

    var pd = c.fullData || c;
    var classType = Number(pd.classType != null ? pd.classType : c.classType);

    var ui = computeMacScriptSelectionUi(clientId);
    var scripts = ui.scripts;
    var selectedScriptId = ui.selectedScriptId;
    var scriptRuntimeText = ui.selectedScriptRunning ? formatHomeDuration(getHomeScriptRuntimeMs()) : '0s';
    var pillText = ui.scriptPillText;
    var scriptStatusClass = ui.scriptStatusClass;

    var scriptOptionsHtml = '<option value="">-- Select Script --</option>';
    scripts.forEach(function (scriptRow) {
      var id = String(scriptRow.id || '');
      var isSelected = id && id === String(selectedScriptId || '');
      scriptOptionsHtml += '<option value="' + escapeHtml(id) + '"' + (isSelected ? ' selected' : '') + '>' + escapeHtml(String(scriptRow.name || id)) + '</option>';
    });
    body.innerHTML =
      '<div class="mac-popout-header">' +
        '<div class="mac-popout-avatar" id="mac-popout-avatar"></div>' +
        '<div class="mac-popout-title">' +
          '<span class="mac-popout-name" id="mac-popout-name">' +
          escapeHtml(pd.name || 'Unknown') +
          '</span>' +
          '<span class="mac-popout-class" id="mac-popout-class"></span>' +
        '</div>' +
      '</div>' +
      '<div class="mac-popout-tab-bar" role="tablist" aria-label="Account details">' +
      '<button type="button" class="mac-popout-tab active" id="mac-popout-tab-overview" role="tab" aria-selected="true" data-mac-popout-tab="overview">Overview</button>' +
      '<button type="button" class="mac-popout-tab" id="mac-popout-tab-dev" role="tab" aria-selected="false" data-mac-popout-tab="dev">Developer</button>' +
      '</div>' +
      '<div id="mac-popout-pane-overview" class="mac-popout-pane" role="tabpanel" aria-labelledby="mac-popout-tab-overview">' +
      '<div class="mac-popout-inventory-section">' +
        '<div id="mac-popout-inventory-inner" class="mac-popout-inventory-inner"></div>' +
      '</div>' +
      '<div class="mac-popout-details mac-popout-detail-grid">' +
        '<div class="detail-row"><span>' +
        escapeHtml(t('detail.stars')) +
        '</span><span id="mac-popout-dtl-stars">--</span></div>' +
        '<div class="detail-row"><span>' +
        escapeHtml(t('detail.fame')) +
        '</span><span id="mac-popout-dtl-fame">--</span></div>' +
        '<div class="detail-row"><span>' +
        escapeHtml(t('detail.map')) +
        '</span><span id="mac-popout-dtl-map">--</span></div>' +
        '<div class="detail-row"><span>' +
        escapeHtml(t('detail.server')) +
        '</span><span id="mac-popout-dtl-server">--</span></div>' +
      '</div>' +
      '<div class="mac-popout-script">' +
        '<div class="mac-popout-script-head">' +
          '<span class="mac-popout-script-title">Script</span>' +
          '<span id="mac-popout-script-status-pill" class="home-status-pill' +
        (scriptStatusClass ? ' ' + scriptStatusClass : '') +
        '">' +
          escapeHtml(pillText) +
          '</span>' +
        '</div>' +
        '<select id="mac-popout-script-select" class="settings-select mac-popout-script-select">' +
        scriptOptionsHtml +
        '</select>' +
        '<div class="mac-popout-script-meta">Runtime: <strong id="mac-popout-script-runtime-value">' +
        escapeHtml(scriptRuntimeText) +
        '</strong></div>' +
        '<div class="mac-popout-script-actions">' +
          '<button type="button" id="mac-popout-script-run" class="setting-btn"' +
        ((selectedScriptId && !ui.selectedScriptRunning) ? '' : ' disabled') +
        '>Run</button>' +
          '<button type="button" id="mac-popout-script-stop" class="setting-btn setting-btn-secondary"' +
        ((selectedScriptId && ui.selectedScriptRunning) ? '' : ' disabled') +
        '>Stop</button>' +
        '</div>' +
      '</div>' +
      '</div>' +
      '<div id="mac-popout-pane-dev" class="mac-popout-pane mac-popout-pane--dev" role="tabpanel" aria-labelledby="mac-popout-tab-dev" hidden>' +
      '<div class="mac-popout-player-bars">' +
        '<div class="stat-bar">' +
          '<div class="bar-label">HP</div>' +
          '<div class="bar-track hp-track">' +
          '<div id="mac-popout-hp-fill" class="bar-fill hp-fill" style="width:0%"></div>' +
          '<div class="bar-value bar-value-row">' +
          '<div class="bar-value-center">' +
          '<span id="mac-popout-hp-main"></span>' +
          '<span id="mac-popout-hp-bonus" class="bar-bonus"></span>' +
          '</div>' +
          '<div id="mac-popout-hp-regen" class="bar-value-right"></div>' +
          '</div>' +
          '</div>' +
        '</div>' +
        '<div class="stat-bar">' +
          '<div class="bar-label">MP</div>' +
          '<div class="bar-track mp-track">' +
          '<div id="mac-popout-mp-fill" class="bar-fill mp-fill" style="width:0%"></div>' +
          '<div class="bar-value bar-value-row">' +
          '<div class="bar-value-center">' +
          '<span id="mac-popout-mp-main"></span>' +
          '<span id="mac-popout-mp-bonus" class="bar-bonus"></span>' +
          '</div>' +
          '<div id="mac-popout-mp-regen" class="bar-value-right"></div>' +
          '</div>' +
          '</div>' +
        '</div>' +
      '</div>' +
      '<div class="mac-popout-stats mac-popout-stats-grid">' +
        '<div class="mini-stat"><span class="stat-icon">ATK</span><span id="mac-popout-stat-atk" class="stat-val">--</span></div>' +
        '<div class="mini-stat"><span class="stat-icon">DEF</span><span id="mac-popout-stat-def" class="stat-val">--</span></div>' +
        '<div class="mini-stat"><span class="stat-icon">SPD</span><span id="mac-popout-stat-spd" class="stat-val">--</span></div>' +
        '<div class="mini-stat"><span class="stat-icon">DEX</span><span id="mac-popout-stat-dex" class="stat-val">--</span></div>' +
        '<div class="mini-stat"><span class="stat-icon">VIT</span><span id="mac-popout-stat-vit" class="stat-val">--</span></div>' +
        '<div class="mini-stat"><span class="stat-icon">WIS</span><span id="mac-popout-stat-wis" class="stat-val">--</span></div>' +
      '</div>' +
      '<div class="mac-popout-effects-section">' +
        '<div class="mac-popout-section-title">' +
        escapeHtml('Conditions') +
        '</div>' +
        '<div id="mac-popout-effects-inner" class="mac-popout-effects"></div>' +
      '</div>' +
      '<div class="mac-popout-session-kv">' +
        '<div class="detail-row"><span>' +
        escapeHtml('Session uptime') +
        '</span><span id="mac-popout-session-uptime">--</span></div>' +
        '<div class="detail-row"><span>' +
        escapeHtml('Session fame gained') +
        '</span><span id="mac-popout-session-fame">--</span></div>' +
        '<div class="detail-row"><span>' +
        escapeHtml('Session avg FPM') +
        '</span><span id="mac-popout-session-fpm">--</span></div>' +
      '</div>' +
      '<div class="mac-popout-details mac-popout-detail-grid mac-popout-details--dev">' +
        '<div class="detail-row"><span>' +
        escapeHtml(t('detail.level')) +
        '</span><span id="mac-popout-dtl-level">--</span></div>' +
        '<div class="detail-row"><span>' +
        escapeHtml(t('detail.guild')) +
        '</span><span id="mac-popout-dtl-guild">--</span></div>' +
        '<div class="detail-row"><span>' +
        escapeHtml(t('detail.gameid')) +
        '</span><span id="mac-popout-dtl-gameid">--</span></div>' +
        '<div class="detail-row"><span>' +
        escapeHtml(t('detail.objectid')) +
        '</span><span id="mac-popout-dtl-objectid">--</span></div>' +
        '<div class="detail-row"><span>' +
        escapeHtml(t('detail.objecttype')) +
        '</span><span id="mac-popout-dtl-objecttype">--</span></div>' +
        '<div class="detail-row"><span>' +
        escapeHtml(t('detail.position')) +
        '</span><span id="mac-popout-dtl-pos">--</span></div>' +
        '<div class="detail-row"><span>' +
        escapeHtml(t('detail.questTargetId')) +
        '</span><span id="mac-popout-dtl-quest-id">--</span></div>' +
        '<div class="detail-row"><span>' +
        escapeHtml(t('detail.questTargetType')) +
        '</span><span id="mac-popout-dtl-quest-type">--</span></div>' +
        '<div class="detail-row"><span>' +
        escapeHtml(t('detail.backpackTier')) +
        '</span><span id="mac-popout-dtl-bptier">--</span></div>' +
        '<div class="detail-row"><span>' +
        escapeHtml('Teleport allowed') +
        '</span><span id="mac-popout-dtl-teleport">--</span></div>' +
      '</div>' +
      '<div class="mac-popout-raw-actions">' +
        '<button type="button" id="mac-popout-copy-raw-players" class="setting-btn setting-btn-secondary">Copy raw players data</button>' +
      '</div>' +
      '</div>';

    macPopoutApplyPlayerData(clientId);

    var btnMacTabOverview = document.getElementById('mac-popout-tab-overview');
    var btnMacTabDev = document.getElementById('mac-popout-tab-dev');
    if (btnMacTabOverview) btnMacTabOverview.addEventListener('click', function () { setMacPopoutTab('overview'); });
    if (btnMacTabDev) btnMacTabDev.addEventListener('click', function () { setMacPopoutTab('dev'); });
    var savedMacTab = 'overview';
    try {
      savedMacTab = localStorage.getItem('macPopoutActiveTab') || 'overview';
    } catch (_st) {}
    setMacPopoutTab(savedMacTab === 'dev' ? 'dev' : 'overview');

    // Render avatar sprite/portrait from best available class data (fullData or clientList snapshot)
    var avatarDiv = document.getElementById('mac-popout-avatar');
    var skin = Number(pd.skin != null ? pd.skin : c.skin);
    var tex1 = Number(pd.tex1 != null ? pd.tex1 : c.tex1);
    var tex2 = Number(pd.tex2 != null ? pd.tex2 : c.tex2);
    if (avatarDiv) {
      if (Number.isFinite(classType) && classType > 0) {
        avatarDiv.style.backgroundImage = 'url(' + renderClassSprite(classType) + ')';
        avatarDiv.style.backgroundSize = 'contain';
        avatarDiv.style.backgroundRepeat = 'no-repeat';
        avatarDiv.style.backgroundPosition = 'center';
        avatarDiv.style.imageRendering = 'pixelated';
        if (typeof window.renderEamPortrait === 'function') {
          window.renderEamPortrait(
            classType,
            Number.isFinite(skin) && skin > 0 ? skin : classType,
            Number.isFinite(tex1) ? tex1 : 0,
            Number.isFinite(tex2) ? tex2 : 0
          ).then(function (portraitUrl) {
            if (!portraitUrl || macPopoutOpenClientId !== clientId) return;
            avatarDiv.style.backgroundImage = 'url(' + portraitUrl + ')';
          }).catch(function () {});
        }
      } else {
        avatarDiv.style.backgroundImage = '';
      }
    }

    var scriptSelectEl = document.getElementById('mac-popout-script-select');
    if (scriptSelectEl) {
      scriptSelectEl.addEventListener('change', function () {
        var nextScriptId = String(scriptSelectEl.value || '');
        setMacScriptSelection(clientId, nextScriptId);
        refreshMacPopoutScriptPanel(clientId);
      });
    }

    var runBtn = document.getElementById('mac-popout-script-run');
    if (runBtn) {
      runBtn.addEventListener('click', function () {
        var runScriptId = getMacScriptSelection(clientId);
        if (!runScriptId) return;
        fetch('/api/scripts/start', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: runScriptId }),
        })
          .then(function (r) { return r.json(); })
          .then(function () { return fetch('/api/scripts'); })
          .then(function (r) { return r.json(); })
          .then(function (data) {
            scriptsTabLastData = data || { scripts: [], dir: null };
            refreshMacPopoutScriptPanel(clientId);
          })
          .catch(function () {});
      });
    }

    var stopBtn = document.getElementById('mac-popout-script-stop');
    if (stopBtn) {
      stopBtn.addEventListener('click', function () {
        var stopScriptId = getMacScriptSelection(clientId);
        if (!stopScriptId) return;
        fetch('/api/scripts/stop', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: stopScriptId }),
        })
          .then(function (r) { return r.json(); })
          .then(function () { return fetch('/api/scripts'); })
          .then(function (r) { return r.json(); })
          .then(function (data) {
            scriptsTabLastData = data || { scripts: [], dir: null };
            refreshMacPopoutScriptPanel(clientId);
          })
          .catch(function () {});
      });
    }

    var copyRawBtn = document.getElementById('mac-popout-copy-raw-players');
    if (copyRawBtn) {
      copyRawBtn.addEventListener('click', requestCopyAllPlayersRawStats);
    }

    if (!scripts.length) {
      fetch('/api/scripts')
        .then(function (r) { return r.json(); })
        .then(function (data) {
          scriptsTabLastData = data || { scripts: [], dir: null };
          refreshMacPopoutScriptPanel(clientId);
        })
        .catch(function () {});
    }

    popout.classList.remove('hidden');
  }

  function closeMacPopout() {
    macPopoutOpenClientId = null;
    var popout = document.getElementById('multi-account-popout');
    if (popout) popout.classList.add('hidden');
  }

  var macPopoutCloseBtn = document.getElementById('multi-account-popout-close');
  if (macPopoutCloseBtn) macPopoutCloseBtn.addEventListener('click', closeMacPopout);

  var macPopoutEl = document.getElementById('multi-account-popout');
  if (macPopoutEl) {
    macPopoutEl.addEventListener('click', function (e) {
      if (e.target === macPopoutEl) closeMacPopout();
    });
  }

  // ─────────────────────────────────────────────────────────────────────────

  function formatNumber(n) {
    if (n === undefined || n === null) return '--';
    if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
    if (n >= 1000) return (n / 1000).toFixed(1) + 'k';
    return String(n);
  }

  // Packet handling
  function onPacket(pkt, isHistory) {
    homeStats.packetsProcessed++;

    if (!adminMode || !packetSnifferVisible) return;

    packets.push(pkt);
    if (packets.length > MAX_ROWS * 2) {
      packets = packets.slice(-MAX_ROWS);
    }

    totalCount++;
    totalEl.textContent = totalCount + ' total';

    const now = Date.now();
    recentTimestamps.push(now);
    recentTimestamps = recentTimestamps.filter(t => t > now - 1000);
    ppsEl.textContent = recentTimestamps.length + ' pkt/s';

    addTypeChip(pkt.name);

    // Badge for collapsed sniffer
    if (!snifferExpanded && adminMode) {
      snifferPacketsSinceCollapse++;
      snifferBadge.textContent = snifferPacketsSinceCollapse > 999
        ? '999+' : snifferPacketsSinceCollapse;
      snifferBadge.classList.remove('hidden');
    }

    if (!paused && !isHistory && snifferExpanded) {
      refreshTable(true);
    }
  }

  function shouldShow(pkt) {
    if (pkt.direction === 'C\u2192S' && !filterCS.checked) return false;
    if (pkt.direction === 'S\u2192C' && !filterSC.checked) return false;
    if (filterHideNoisy.checked && NOISY_PACKETS.has(pkt.name)) return false;
    if (hiddenTypes.has(pkt.name)) return false;
    const search = filterSearch.value.toLowerCase();
    if (search) {
      const haystack = (pkt.name + ' ' + (pkt.rawHex || '') + ' ' + JSON.stringify(pkt.data)).toLowerCase();
      if (!haystack.includes(search)) return false;
    }
    return true;
  }

  function addRow(pkt) {
    const tr = document.createElement('tr');
    tr.dataset.id = pkt.id;
    if (pkt.id === selectedPacketId) tr.classList.add('selected');
    const timeStr = new Date(pkt.timestamp).toISOString().slice(11, 23);
    const dirClass = pkt.direction === 'C\u2192S' ? 'dir-cs' : 'dir-sc';
    const dirSymbol = pkt.direction === 'C\u2192S' ? '\u2192' : '\u2190';
    tr.innerHTML =
      '<td class="col-time">' + timeStr + '</td>' +
      '<td class="col-dir ' + dirClass + '">' + dirSymbol + '</td>' +
      '<td class="col-name">' + pkt.name + '</td>' +
      '<td class="col-size">' + pkt.size + 'B</td>';
    tr.addEventListener('click', function () {
      selectedPacketId = pkt.id;
      showDetail(pkt, tr);
      refreshTable(false);
    });
    packetBody.appendChild(tr);
  }

  function addSpacerRow(px) {
    if (px <= 0) return;
    const tr = document.createElement('tr');
    tr.className = 'sniffer-spacer-row';
    const td = document.createElement('td');
    td.colSpan = 4;
    td.style.height = px + 'px';
    td.style.padding = '0';
    td.style.border = '0';
    tr.appendChild(td);
    packetBody.appendChild(tr);
  }

  function showDetail(pkt, row) {
    const prev = packetBody.querySelector('.selected');
    if (prev) prev.classList.remove('selected');
    if (row) row.classList.add('selected');

    const protoId = pkt.packetId !== undefined && pkt.packetId !== null ? pkt.packetId : '?';
    detailTitle.textContent = pkt.direction + ' ' + pkt.name + ' · proto id ' + protoId + ' · row #' + pkt.id;
    detailPanel.classList.remove('hidden');

    detailFields.innerHTML = '';
    renderFields(pkt.data, detailFields, 0);

    let hex = pkt.rawHex || '';
    hex = hex.replace(/(.{2})/g, '$1 ').replace(/(.{48})/g, '$1\n');
    if (pkt.rawHexTruncated) {
      hex = '[Wire image truncated for dashboard — first ' + Math.floor((pkt.rawHex || '').length / 2) + ' bytes shown]\n\n' + hex;
    }
    detailHex.textContent = hex;
  }

  function renderFields(obj, container, depth) {
    if (!obj || typeof obj !== 'object') return;
    for (const [key, value] of Object.entries(obj)) {
      const row = document.createElement('div');
      row.className = 'field-row';
      row.style.paddingLeft = (depth * 12) + 'px';

      const nameEl = document.createElement('span');
      nameEl.className = 'field-name';
      nameEl.textContent = key;

      const valueEl = document.createElement('span');
      valueEl.className = 'field-value';

      if (Array.isArray(value)) {
        valueEl.className += ' type-object';
        valueEl.textContent = 'Array(' + value.length + ')';
        row.appendChild(nameEl);
        row.appendChild(valueEl);
        container.appendChild(row);
        value.slice(0, 20).forEach((item, i) => {
          if (typeof item === 'object' && item !== null) {
            const label = document.createElement('div');
            label.className = 'field-row';
            label.style.paddingLeft = ((depth + 1) * 12) + 'px';
            const ln = document.createElement('span');
            ln.className = 'field-name';
            ln.textContent = '[' + i + ']';
            label.appendChild(ln);
            container.appendChild(label);
            renderFields(item, container, depth + 2);
          } else {
            const itemRow = document.createElement('div');
            itemRow.className = 'field-row';
            itemRow.style.paddingLeft = ((depth + 1) * 12) + 'px';
            const in_ = document.createElement('span');
            in_.className = 'field-name';
            in_.textContent = '[' + i + ']';
            const iv = document.createElement('span');
            iv.className = 'field-value type-' + typeof item;
            iv.textContent = String(item);
            itemRow.appendChild(in_);
            itemRow.appendChild(iv);
            container.appendChild(itemRow);
          }
        });
        if (value.length > 20) {
          const more = document.createElement('div');
          more.className = 'field-row';
          more.style.paddingLeft = ((depth + 1) * 12) + 'px';
          more.innerHTML = '<span class="field-name">...</span><span class="field-value">+' + (value.length - 20) + ' more</span>';
          container.appendChild(more);
        }
      } else if (typeof value === 'object' && value !== null) {
        valueEl.className += ' type-object';
        valueEl.textContent = '{...}';
        row.appendChild(nameEl);
        row.appendChild(valueEl);
        container.appendChild(row);
        renderFields(value, container, depth + 1);
      } else {
        valueEl.className += ' type-' + typeof value;
        valueEl.textContent = String(value);
        row.appendChild(nameEl);
        row.appendChild(valueEl);
        container.appendChild(row);
      }
    }
  }

  // Plugin rendering (trainer-style hub)
  const HIDDEN_PLUGINS = new Set(['packet-logger', 'server-switch', 'ip-connect', 'damage-sniffer']);
  const PLUGIN_HUB_SELECTED_KEY = 'pluginHubSelectedId';
  const PLUGIN_CATEGORY_ORDER = ['combat', 'movement', 'automation', 'visual', 'network', 'utility', 'admin'];
  const PLUGIN_CATEGORY_LABEL_KEYS = {
    combat: 'plugins.category.combat',
    movement: 'plugins.category.movement',
    automation: 'plugins.category.automation',
    visual: 'plugins.category.visual',
    network: 'plugins.category.network',
    utility: 'plugins.category.utility',
    admin: 'plugins.category.admin'
  };
  let cachedPluginsForHub = [];
  let pluginHubFiltersInitialized = false;
  let teleportBeaconSelectEl = null;
  let lastTeleportBeaconHash = '';
  let lastTeleportBeaconSentValue = null;
  let lastTeleportObjectsRequestAt = 0;

  function _teleportBeaconHash(beacons) {
    if (!beacons || !beacons.length) return '';
    return beacons.map(function (g) {
      const ids = (g.entities || []).map(function (e) { return e.objectId; }).join(',');
      return String(g.objectType || 0) + '|' + (g.name || '') + '|' + ids;
    }).join(';');
  }

  function updateTeleportBeaconDropdown(force) {
    if (!teleportBeaconSelectEl) return;
    const beacons = (lastObjectsData && lastObjectsData.beacons) || [];
    const h = _teleportBeaconHash(beacons);
    if (!force && h === lastTeleportBeaconHash) return;
    lastTeleportBeaconHash = h;

    const saved = localStorage.getItem('teleportBeaconObjectId') || '';
    const opts = [];

    // Only show 1 beacon per type: pick a random visible objectId from that type group
    (beacons || []).forEach(function (g) {
      const entities = g.entities || [];
      if (!entities.length) return;
      const pick = entities[Math.floor(Math.random() * entities.length)];
      if (!pick) return;
      const label = (g.name ? String(g.name) : (t('plugins.teleport.typePrefix') + ' ' + String(g.objectType))) +
        '  (' + t('plugins.teleport.objectId') + ' ' + String(pick.objectId) + ')';
      opts.push({ label: label, value: String(pick.objectId) });
    });

    teleportBeaconSelectEl.innerHTML = '';
    const emptyOpt = document.createElement('option');
    emptyOpt.value = '';
    emptyOpt.textContent = opts.length ? t('plugins.teleport.select') : t('plugins.teleport.none');
    teleportBeaconSelectEl.appendChild(emptyOpt);

    opts.forEach(function (o) {
      const opt = document.createElement('option');
      opt.value = o.value;
      opt.textContent = o.label;
      teleportBeaconSelectEl.appendChild(opt);
    });

    // Restore selection if still present, else pick first real option
    if (saved && opts.some(function (o) { return o.value === saved; })) {
      teleportBeaconSelectEl.value = saved;
    } else if (opts.length) {
      teleportBeaconSelectEl.value = opts[0].value;
    } else {
      teleportBeaconSelectEl.value = '';
    }

    // Push current selection into teleport plugin hidden setting
    if (ws && ws.readyState === 1) {
      // Avoid feedback loops: only send when value actually changes
      if (String(lastTeleportBeaconSentValue || '') === String(teleportBeaconSelectEl.value || '')) return;
      lastTeleportBeaconSentValue = teleportBeaconSelectEl.value || '';
      ws.send(JSON.stringify({
        type: 'updateSetting',
        pluginId: 'teleport',
        key: 'beaconObjectId',
        value: teleportBeaconSelectEl.value,
      }));
    }
  }

  function initPluginHubFiltersOnce() {
    if (pluginHubFiltersInitialized) return;
    pluginHubFiltersInitialized = true;
    if (pluginSearch) {
      pluginSearch.addEventListener('input', function () {
        renderPlugins(cachedPluginsForHub);
      });
    }
    if (pluginCategory) {
      pluginCategory.addEventListener('change', function () {
        renderPlugins(cachedPluginsForHub);
      });
    }
  }

  function populatePluginCategorySelect() {
    if (!pluginCategory) return;
    var prev = pluginCategory.value || 'all';
    pluginCategory.innerHTML = '';
    var optAll = document.createElement('option');
    optAll.value = 'all';
    optAll.textContent = t('plugins.category.all');
    pluginCategory.appendChild(optAll);
    PLUGIN_CATEGORY_ORDER.forEach(function (cat) {
      var o = document.createElement('option');
      o.value = cat;
      o.textContent = t(PLUGIN_CATEGORY_LABEL_KEYS[cat]);
      pluginCategory.appendChild(o);
    });
    var ok = Array.prototype.some.call(pluginCategory.options, function (o) { return o.value === prev; });
    pluginCategory.value = ok ? prev : 'all';
  }

  function findPluginById(plugins, id) {
    return (plugins || []).find(function (p) { return p.id === id; });
  }

  function appendTeleportBeaconSection(parent, p) {
    if (p.id !== 'teleport') return;
    var now = Date.now();
    var haveAnyObjects = !!(lastObjectsData && ((lastObjectsData.portals && lastObjectsData.portals.length) || (lastObjectsData.beacons && lastObjectsData.beacons.length) || (lastObjectsData.categories && lastObjectsData.categories.length)));
    if (ws && ws.readyState === 1 && (now - lastTeleportObjectsRequestAt > 2000) && (!haveAnyObjects || gameConnected)) {
      lastTeleportObjectsRequestAt = now;
      ws.send(JSON.stringify({ type: 'requestObjects' }));
    }
    var wrap = document.createElement('div');
    wrap.className = 'plugin-teleport-beacon';
    var row = document.createElement('div');
    row.className = 'setting-row setting-row--full';
    var label = document.createElement('span');
    label.className = 'setting-label';
    label.textContent = t('plugins.teleport.beacon');
    row.appendChild(label);
    var control = document.createElement('div');
    control.className = 'setting-control';
    var select = document.createElement('select');
    select.className = 'plugin-beacon-select';
    select.setAttribute('aria-label', t('plugins.teleport.beaconSelect'));
    teleportBeaconSelectEl = select;
    select.addEventListener('change', function () {
      localStorage.setItem('teleportBeaconObjectId', select.value || '');
      if (ws && ws.readyState === 1) {
        lastTeleportBeaconSentValue = select.value || '';
        ws.send(JSON.stringify({
          type: 'updateSetting',
          pluginId: p.id,
          key: 'beaconObjectId',
          value: select.value,
        }));
      }
    });
    control.appendChild(select);
    row.appendChild(control);
    wrap.appendChild(row);
    parent.appendChild(wrap);
    updateTeleportBeaconDropdown(true);
  }

  function appendPluginSettingsGrid(parent, p) {
    if (!p.settings || p.settings.length === 0) return;
    var settingsDiv = document.createElement('div');
    settingsDiv.className = 'plugin-settings plugin-settings-grid';

    // Simple/Advanced split: settings flagged `advanced` are hidden unless
    // the GLOBAL "Advanced plugin settings" toggle (Settings → Plugins) is
    // on. Visibility is governed by the body.plugins-advanced class, so the
    // toggle applies to every plugin instantly with no re-render.

    p.settings.forEach(function (s) {
      if (s.hidden) return;

      var row = document.createElement('div');
      var rowClass = 'setting-row';
      if (s.type === 'range' || s.type === 'select' || s.type === 'text' || s.type === 'button') {
        rowClass += ' setting-row--full';
      }
      if (s.advanced) rowClass += ' setting-advanced';
      row.className = rowClass;

      var label = document.createElement('span');
      label.className = 'setting-label';
      label.textContent = s.label;
      row.appendChild(label);

      var control = document.createElement('div');
      control.className = 'setting-control';

      if (s.type === 'range') {
        var slider = document.createElement('input');
        slider.type = 'range';
        slider.min = s.min ?? 0;
        slider.max = s.max ?? 100;
        slider.step = s.step ?? 1;
        slider.value = s.value;
        var valueDisplay = document.createElement('span');
        valueDisplay.className = 'setting-value';
        valueDisplay.textContent = s.value + (s.max === 100 ? '%' : '');
        slider.addEventListener('input', function () {
          valueDisplay.textContent = slider.value + (s.max === 100 ? '%' : '');
        });
        slider.addEventListener('change', function () {
          if (!ws || ws.readyState !== 1) return;
          ws.send(JSON.stringify({
            type: 'updateSetting',
            pluginId: p.id,
            key: s.key,
            value: Number(slider.value),
          }));
        });
        control.appendChild(slider);
        control.appendChild(valueDisplay);
      } else if (s.type === 'number') {
        var input = document.createElement('input');
        input.type = 'text';
        input.inputMode = 'numeric';
        input.className = 'settings-number-input';
        input.value = s.value;
        input.addEventListener('change', function () {
          var nextValue = Number(input.value);
          if (!Number.isFinite(nextValue)) {
            input.value = String(s.value ?? '');
            return;
          }
          if (s.min !== undefined) nextValue = Math.max(Number(s.min), nextValue);
          if (s.max !== undefined) nextValue = Math.min(Number(s.max), nextValue);
          input.value = String(nextValue);
          if (!ws || ws.readyState !== 1) return;
          ws.send(JSON.stringify({
            type: 'updateSetting',
            pluginId: p.id,
            key: s.key,
            value: nextValue,
          }));
        });
        control.appendChild(input);
      } else if (s.type === 'boolean') {
        var toggle = document.createElement('label');
        toggle.className = 'toggle-switch';
        toggle.innerHTML =
          '<input type="checkbox" ' + (s.value ? 'checked' : '') + '>' +
          '<span class="toggle-slider"></span>';
        var cb = toggle.querySelector('input');
        cb.addEventListener('change', function () {
          if (!ws || ws.readyState !== 1) return;
          ws.send(JSON.stringify({
            type: 'updateSetting',
            pluginId: p.id,
            key: s.key,
            value: cb.checked,
          }));
        });
        control.appendChild(toggle);
      } else if (s.type === 'select' && s.options) {
        var select = document.createElement('select');
        s.options.forEach(function (opt) {
          var option = document.createElement('option');
          option.value = opt.value;
          option.textContent = opt.label;
          if (opt.value === s.value) option.selected = true;
          select.appendChild(option);
        });
        select.addEventListener('change', function () {
          if (!ws || ws.readyState !== 1) return;
          ws.send(JSON.stringify({
            type: 'updateSetting',
            pluginId: p.id,
            key: s.key,
            value: select.value,
          }));
        });
        control.appendChild(select);
      } else if (s.type === 'text') {
        var tinput = document.createElement('input');
        tinput.type = 'text';
        tinput.value = s.value ?? '';
        tinput.placeholder = s.label;
        tinput.addEventListener('change', function () {
          if (!ws || ws.readyState !== 1) return;
          ws.send(JSON.stringify({
            type: 'updateSetting',
            pluginId: p.id,
            key: s.key,
            value: tinput.value,
          }));
        });
        control.appendChild(tinput);
      } else if (s.type === 'button') {
        var btn = document.createElement('button');
        btn.textContent = s.label;
        btn.className = 'setting-btn';
        btn.addEventListener('click', function () {
          if (!ws || ws.readyState !== 1) return;
          ws.send(JSON.stringify({
            type: 'updateSetting',
            pluginId: p.id,
            key: s.key,
            value: true,
          }));
        });
        control.appendChild(btn);
      }

      row.appendChild(control);
      settingsDiv.appendChild(row);
    });

    // Reset-to-defaults footer. Lives below all settings so the plugin
    // panel has a clear escape hatch when the user's sliders have drifted
    // and they want a clean baseline (esp. useful when A/B-testing new
    // behaviour). Confirm first so it's not a one-click accident.
    var resetRow = document.createElement('div');
    resetRow.className = 'setting-row setting-row--full plugin-settings-reset';
    var resetBtn = document.createElement('button');
    resetBtn.type = 'button';
    resetBtn.textContent = 'Reset to defaults';
    resetBtn.className = 'setting-btn setting-btn-secondary plugin-settings-reset-btn';
    resetBtn.addEventListener('click', function () {
      if (!ws || ws.readyState !== 1) return;
      if (!window.confirm('Reset all "' + (p.name || p.id) + '" settings to defaults?')) return;
      ws.send(JSON.stringify({ type: 'resetPluginSettings', pluginId: p.id }));
    });
    resetRow.appendChild(resetBtn);
    settingsDiv.appendChild(resetRow);

    parent.appendChild(settingsDiv);
  }

  function renderPluginDetail(p) {
    // unused — kept as no-op for any external callers
  }

  function findPluginHubElById(container, pluginId, className) {
    if (!container || !pluginId) return null;
    var nodes = container.querySelectorAll('.' + className + '[data-plugin-id]');
    for (var i = 0; i < nodes.length; i++) {
      if (nodes[i].getAttribute('data-plugin-id') === pluginId) return nodes[i];
    }
    return null;
  }

  function jumpToPluginInHub(pluginId) {
    var sideEl = pluginSidebarList || document.getElementById('plugin-sidebar-list');
    var detailEl = pluginDetail || document.getElementById('plugin-detail');
    if (sideEl) {
      sideEl.querySelectorAll('.plugin-sidebar-item--selected').forEach(function (el) {
        el.classList.remove('plugin-sidebar-item--selected');
      });
      var item = findPluginHubElById(sideEl, pluginId, 'plugin-sidebar-item');
      if (item) {
        item.classList.add('plugin-sidebar-item--selected');
        item.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    }
    if (!detailEl) return;
    var card = findPluginHubElById(detailEl, pluginId, 'plugin-active-card');
    if (card) {
      requestAnimationFrame(function () {
        card.scrollIntoView({ behavior: 'smooth', block: 'center' });
        card.classList.remove('plugin-active-card--flash');
        void card.offsetWidth;
        card.classList.add('plugin-active-card--flash');
        setTimeout(function () {
          card.classList.remove('plugin-active-card--flash');
        }, 1000);
      });
    }
  }

  function renderEnabledPluginsPanel(plugins, detailEl) {
    teleportBeaconSelectEl = null;
    detailEl.innerHTML = '';

    var enabled = plugins.filter(function (p) { return p.enabled; });
    if (enabled.length === 0) {
      var empty = document.createElement('div');
      empty.className = 'plugin-detail-loading';
      empty.innerHTML = '<svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2v4m0 12v4M4.93 4.93l2.83 2.83m8.48 8.48l2.83 2.83M2 12h4m12 0h4M4.93 19.07l2.83-2.83m8.48-8.48l2.83-2.83"/></svg>' +
        '<span>' + t('plugins.empty.enable') + '</span>';
      detailEl.appendChild(empty);
      return;
    }

    enabled.sort(function (a, b) {
      return getPluginDisplayName(a).localeCompare(getPluginDisplayName(b));
    });

    enabled.forEach(function (p) {
      var card = document.createElement('div');
      card.className = 'plugin-active-card';
      card.setAttribute('data-plugin-id', p.id);

      var header = document.createElement('div');
      header.className = 'plugin-detail-header';
      var titleWrap = document.createElement('div');
      titleWrap.className = 'plugin-detail-title-wrap';
      var hTitle = document.createElement('h3');
      hTitle.className = 'plugin-detail-title';
      hTitle.textContent = getPluginDisplayName(p);
      var catTag = document.createElement('span');
      catTag.className = 'plugin-detail-category';
      catTag.textContent = t(PLUGIN_CATEGORY_LABEL_KEYS[p.category || 'utility']) || (p.category || 'utility');
      titleWrap.appendChild(hTitle);
      titleWrap.appendChild(catTag);
      header.appendChild(titleWrap);
      card.appendChild(header);

      appendTeleportBeaconSection(card, p);
      appendPluginSettingsGrid(card, p);

      detailEl.appendChild(card);
    });
  }

  function renderPlugins(plugins) {
    cachedPluginsForHub = Array.isArray(plugins) ? plugins : [];
    initPluginHubFiltersOnce();
    populatePluginCategorySelect();

    hotkeyMap.clear();
    cachedPluginsForHub.forEach(function (p) {
      (p.settings || []).forEach(function (s) {
        if (s.hotkeyFor && s.value) {
          hotkeyMap.set(String(s.value).toLowerCase(), { pluginId: p.id, key: s.hotkeyFor });
        }
      });
    });

    var hubEl = pluginHub || document.getElementById('plugin-hub');
    var sideEl = pluginSidebarList || document.getElementById('plugin-sidebar-list');
    var detailEl = pluginDetail || document.getElementById('plugin-detail');
    if (!hubEl || !sideEl || !detailEl) return;

    var visiblePlugins = cachedPluginsForHub.filter(function (p) { return !HIDDEN_PLUGINS.has(p.id); });
    if (visiblePlugins.length === 0) {
      sideEl.innerHTML = '';
      detailEl.innerHTML = '';
      if (!pluginsReceived) {
        var skeletons = document.createElement('div');
        skeletons.className = 'plugin-sidebar-loading';
        for (var sk = 0; sk < 6; sk++) {
          var skel = document.createElement('div');
          skel.className = 'plugin-sidebar-skeleton';
          skeletons.appendChild(skel);
        }
        sideEl.appendChild(skeletons);
        var state = document.createElement('div');
        state.className = 'plugin-detail-loading';
        state.innerHTML = '<div class="plugin-loading-spinner"></div><span>' + t('plugins.loading') + '</span>';
        detailEl.appendChild(state);
      } else {
        var state2 = document.createElement('div');
        state2.className = 'plugin-detail-loading';
        state2.innerHTML = '<svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2v4m0 12v4M4.93 4.93l2.83 2.83m8.48 8.48l2.83 2.83M2 12h4m12 0h4M4.93 19.07l2.83-2.83m8.48-8.48l2.83-2.83"/></svg>' +
          '<span>' + t('plugins.empty.none') + '</span>';
        detailEl.appendChild(state2);
      }
      return;
    }

    var q = (pluginSearch && pluginSearch.value) ? pluginSearch.value.trim().toLowerCase() : '';
    var cat = (pluginCategory && pluginCategory.value) ? pluginCategory.value : 'all';

    var filtered = visiblePlugins.filter(function (p) {
      var c = p.category || 'utility';
      if (cat !== 'all' && c !== cat) return false;
      if (!q) return true;
      var name = getPluginDisplayName(p).toLowerCase();
      var rawName = (p.name || '').toLowerCase();
      var id = (p.id || '').toLowerCase();
      return name.indexOf(q) >= 0 || rawName.indexOf(q) >= 0 || id.indexOf(q) >= 0;
    });

    var _isAdmin = document.body.classList.contains('admin-mode');
    filtered.sort(function (a, b) {
      var aLocked = !_isAdmin && (a.source === 'bundled' && a.requiredPlan && !activePlanNames.has(String(a.requiredPlan).toLowerCase())) ? 1 : 0;
      var bLocked = !_isAdmin && (b.source === 'bundled' && b.requiredPlan && !activePlanNames.has(String(b.requiredPlan).toLowerCase())) ? 1 : 0;
      if (aLocked !== bLocked) return aLocked - bLocked;
      return getPluginDisplayName(a).localeCompare(getPluginDisplayName(b));
    });

    sideEl.innerHTML = '';

    if (filtered.length === 0) {
      var noMatch = document.createElement('div');
      noMatch.className = 'plugin-sidebar-empty';
      noMatch.textContent = t('plugins.empty.noMatchSidebar');
      sideEl.appendChild(noMatch);
      detailEl.innerHTML = '';
      var emptyDetail = document.createElement('div');
      emptyDetail.className = 'plugin-detail-empty';
      emptyDetail.textContent = t('plugins.empty.noMatchDetail');
      detailEl.appendChild(emptyDetail);
      teleportBeaconSelectEl = null;
      return;
    }

    filtered.forEach(function (p) {
      var isLocked = !_isAdmin && p.source === 'bundled' && p.requiredPlan && !activePlanNames.has(String(p.requiredPlan).toLowerCase());
      var item = document.createElement('div');
      item.className = 'plugin-sidebar-item' + (p.enabled ? '' : ' disabled') + (isLocked ? ' plugin-sidebar-item--locked' : '');
      item.setAttribute('data-plugin-id', p.id);

      var nameSpan = document.createElement('span');
      nameSpan.className = 'plugin-sidebar-item-name';
      nameSpan.textContent = getPluginDisplayName(p);

      if (isLocked) {
        var planDisplay = String(p.requiredPlan).charAt(0).toUpperCase() + String(p.requiredPlan).slice(1);
        var lockBadge = document.createElement('span');
        lockBadge.className = 'plugin-sidebar-plan-badge';
        lockBadge.textContent = planDisplay;
        lockBadge.title = 'Requires ' + planDisplay + ' plan';
        item.appendChild(nameSpan);
        item.appendChild(lockBadge);
      } else {
        item.appendChild(nameSpan);
      }

      var toggleLabel = document.createElement('label');
      toggleLabel.className = 'toggle-switch toggle-switch-sm';
      toggleLabel.innerHTML =
        '<input type="checkbox" ' + (p.enabled ? 'checked' : '') + (isLocked ? ' disabled' : '') + '>' +
        '<span class="toggle-slider"></span>';
      var cb = toggleLabel.querySelector('input');
      if (!isLocked) {
        cb.addEventListener('change', function (e) {
          e.stopPropagation();
          if (!ws || ws.readyState !== 1) return;
          ws.send(JSON.stringify({
            type: 'togglePlugin',
            pluginId: p.id,
            enabled: cb.checked,
          }));
        });
      }
      toggleLabel.addEventListener('click', function (e) { e.stopPropagation(); });

      item.addEventListener('click', function (e) {
        if (e.target.closest('.toggle-switch')) return;
        if (isLocked) { openPlanModal(); return; }
        jumpToPluginInHub(p.id);
      });

      item.appendChild(toggleLabel);
      sideEl.appendChild(item);
    });

    // Main panel: show all enabled plugins with their settings
    renderEnabledPluginsPanel(filtered, detailEl);
  }

  // Type filter chips
  function addTypeChip(name) {
    if (!adminMode || !packetSnifferVisible) return;
    if (typeof name !== 'string' || !name || seenTypes.has(name)) return;
    if (!typeFilters) return;
    seenTypes.add(name);
    const chip = document.createElement('span');
    chip.className = 'type-chip';
    chip.textContent = name;
    chip.addEventListener('click', () => {
      if (hiddenTypes.has(name)) {
        hiddenTypes.delete(name);
        chip.classList.remove('hidden-type');
      } else {
        hiddenTypes.add(name);
        chip.classList.add('hidden-type');
      }
      refreshTable();
    });
    typeFilters.appendChild(chip);
  }

  function refreshTable() {
    packetBody.innerHTML = '';
    visiblePackets = packets.filter(shouldShow).slice(-MAX_ROWS);
    const wrap = snifferTableWrap;
    if (!wrap || !visiblePackets.length) {
      for (var i = 0; i < visiblePackets.length; i++) addRow(visiblePackets[i]);
      return;
    }
    const rowPx = 26;
    const overscan = 12;
    const viewportRows = Math.max(1, Math.ceil((wrap.clientHeight || 320) / rowPx));
    const maxStart = Math.max(0, visiblePackets.length - viewportRows);
    const start = Math.max(0, Math.min(maxStart, Math.floor((wrap.scrollTop || 0) / rowPx) - overscan));
    const end = Math.min(visiblePackets.length, start + viewportRows + (overscan * 2));

    addSpacerRow(start * rowPx);
    for (var r = start; r < end; r++) addRow(visiblePackets[r]);
    addSpacerRow((visiblePackets.length - end) * rowPx);
  }

  function fmtMemHelperBytes(n) {
    if (n == null || !Number.isFinite(Number(n))) return '--';
    const v = Number(n);
    if (v < 1024) return String(Math.round(v)) + ' B';
    if (v < 1024 * 1024) return (v / 1024).toFixed(1) + ' KB';
    return (v / 1024 / 1024).toFixed(1) + ' MB';
  }

  function refreshMemHelperExaltUi() {
    var unsup = document.getElementById('mem-helper-win-unsupported');
    var tbody = document.getElementById('mem-helper-exalt-tbody');
    var meta = document.getElementById('mem-helper-live-meta');
    var EXALT_ROWS_COL_SPAN = 10;

    function escTitle(s) {
      if (s === null || s === undefined) return '\u2014';
      var str = String(s);
      if (!str) return '\u2014';
      if (str.length > 96) return str.slice(0, 93) + '\u2026';
      return str;
    }

    function memRoleText(r) {
      if (r === 'active') return t('memHelper.live.roleActive');
      if (r === 'parked') return t('memHelper.live.roleParked');
      return t('memHelper.live.roleBackground');
    }
    fetch('/api/admin/window-tuning/supported')
      .then(function (r) {
        return r.json();
      })
      .then(function (sup) {
        if (unsup) {
          if (!sup.ok) {
            unsup.textContent = t('memHelper.win.unsupported');
            unsup.classList.remove('hidden');
          } else {
            unsup.classList.add('hidden');
          }
        }
        var tune = document.getElementById('mem-helper-tune-panel');
        if (tune) {
          if (!sup.ok) tune.classList.add('hidden');
          else {
            tune.classList.remove('hidden');
            loadMemHelperTuneUi();
          }
        }
        var exFs = document.getElementById('mem-helper-st-exalt-fieldset');
        if (exFs) exFs.classList.toggle('hidden', !sup.ok);
        loadSmartTrimUi();
        if (!sup.ok) {
          if (meta) meta.textContent = '';
          var tuneStatUnsup = document.getElementById('mem-helper-tune-statusline');
          if (tuneStatUnsup) tuneStatUnsup.textContent = t('memHelper.tune.status.unsupported');
          return null;
        }
        refreshMemHelperTuneStatusLine();
        return fetch('/api/admin/window-tuning/exalt-processes').then(function (res) {
          return res.json();
        });
      })
      .then(function (data) {
        if (!tbody) return;
        if (data === null) {
          tbody.innerHTML = '';
          var trU = document.createElement('tr');
          var tdU = document.createElement('td');
          tdU.colSpan = EXALT_ROWS_COL_SPAN;
          tdU.className = 'mem-helper-muted';
          tdU.textContent = t('memHelper.win.unsupported');
          trU.appendChild(tdU);
          tbody.appendChild(trU);
          return;
        }
        var procs = data.processes || [];
        var lp = Number(data.logicalProcessors) || 0;
        tbody.innerHTML = '';
        var noneKey = 'memHelper.live.none';
        if (!procs.length) {
          var tr0 = document.createElement('tr');
          var td0 = document.createElement('td');
          td0.colSpan = EXALT_ROWS_COL_SPAN;
          td0.className = 'mem-helper-muted';
          td0.setAttribute('data-i18n', noneKey);
          td0.textContent = t(noneKey);
          tr0.appendChild(td0);
          tbody.appendChild(tr0);
        } else {
          procs.forEach(function (p) {
            var exeNm =
              p.imageName !== null &&
              p.imageName !== undefined &&
              String(p.imageName).trim() !== ''
                ? String(p.imageName)
                : 'RotMG Exalt.exe';
            var tr = document.createElement('tr');
            var cu = p.cpuPercent;
            var cuStr =
              cu !== null && cu !== undefined && Number.isFinite(Number(cu)) ? Number(cu).toFixed(1) : '--';
            var eqStr = '--';
            if (
              lp > 0 &&
              cu !== null &&
              cu !== undefined &&
              Number.isFinite(Number(cu))
            ) {
              eqStr = (Number(cu) / lp).toFixed(1);
            }
            var rol = p.role === 'active' || p.role === 'parked' ? p.role : 'background';
            var roleStr = memRoleText(rol);

            var rowText = [
              exeNm,
              String(p.pid),
              roleStr,
              cuStr,
              eqStr,
              fmtMemHelperBytes(p.workingSetBytes),
              String(p.priorityClass || '--'),
              String(p.processorAffinityMask ?? '--'),
              escTitle(p.mainWindowTitle),
            ];
            rowText.forEach(function (txt) {
              var td = document.createElement('td');
              td.textContent = txt;
              tr.appendChild(td);
            });

            var actionsTd = document.createElement('td');
            actionsTd.className = 'mem-helper-exalt-actions';
            function addAct(mb, key) {
              var b = document.createElement('button');
              b.type = 'button';
              b.className = 'setting-btn mem-helper-act-btn';
              b.setAttribute('data-exalt-mb', mb);
              b.setAttribute('data-pid', String(p.pid));
              b.textContent = t(key);
              actionsTd.appendChild(b);
            }
            addAct('activate', 'memHelper.live.mbActive');
            addAct('background', 'memHelper.live.mbBackground');
            addAct('park', 'memHelper.live.mbPark');
            addAct('trim', 'memHelper.live.mbTrim');
            addAct('resize', 'memHelper.live.mbResize');
            tr.appendChild(actionsTd);
            tbody.appendChild(tr);
          });
        }
        if (meta) {
          var tpl = t('memHelper.live.metaTpl');
          var fgStr =
            data.foregroundPid !== null && data.foregroundPid !== undefined && Number.isFinite(Number(data.foregroundPid))
              ? String(data.foregroundPid)
              : '\u2014';
          meta.textContent = tpl
            .replace(/\{cpus\}/g, String(lp || '--'))
            .replace(/\{fg\}/g, fgStr)
            .replace(/\{n\}/g, String(procs.length));
        }
      })
      .catch(function () {});
  }

  function memHelperFillPlanSelect(sel, plans, selectedGuid) {
    if (!sel) return;
    var want = selectedGuid != null && selectedGuid !== '' ? String(selectedGuid) : '';
    sel.innerHTML = '';
    var z = document.createElement('option');
    z.value = '';
    z.textContent = '\u2014';
    sel.appendChild(z);
    (plans || []).forEach(function (pl) {
      var op = document.createElement('option');
      op.value = pl.guid;
      op.textContent = pl.name + (pl.active ? ' *' : '');
      if (want && String(pl.guid).toLowerCase() === want.toLowerCase()) op.selected = true;
      sel.appendChild(op);
    });
  }

  function syncMemHelperPresetHighlight(settings) {
    var panel = document.getElementById('mem-helper-tune-panel');
    if (!panel) return;
    var tp = settings && settings.tuningPreset ? String(settings.tuningPreset) : '';
    var labels = {
      safe: 1,
      balanced: 1,
      multibox: 1,
      aggressive: 1,
      lowHeat: 1,
    };
    panel.querySelectorAll('[data-tuning-preset]').forEach(function (b) {
      var name = b.getAttribute('data-tuning-preset');
      var on = name && labels[name] && name === tp;
      b.classList.toggle('setting-btn-accent', !!on);
    });
  }

  function syncWdThresholdCaption() {
    var m = document.getElementById('mem-helper-wd-cpu-metric');
    var span = document.getElementById('mem-helper-wd-threshold-span');
    if (!span) return;
    var raw = m && m.value === 'raw';
    span.textContent = raw ? t('memHelper.tune.wdCaptRaw') : t('memHelper.tune.wdCaptNorm');
  }

  function refreshMemHelperTuneStatusLine() {
    var el = document.getElementById('mem-helper-tune-statusline');
    if (!el) return;
    fetch('/api/admin/window-tuning/tune-status?thermalSample=1')
      .then(function (r) {
        return r.json();
      })
      .then(function (body) {
        if (!body || !body.ok) return;
        if (body.supported === false) {
          el.textContent = t('memHelper.tune.status.unsupported');
          return;
        }
        var na = t('memHelper.tune.status.na');
        var preset = body.tuningPreset ? String(body.tuningPreset) : na;
        var wd = body.watchdogEnabled ? 'on' : 'off';
        var th = body.thermalEnabled ? 'on' : 'off';
        var dem = body.thermalBackgroundDemotionActive ? 'on' : 'off';
        var temp =
          body.thermalSample &&
          body.thermalSample.pkgMaxCelsius != null &&
          Number.isFinite(Number(body.thermalSample.pkgMaxCelsius))
            ? Number(body.thermalSample.pkgMaxCelsius).toFixed(1) + ' C'
            : na;
        var freq =
          body.thermalSample &&
          body.thermalSample.minFreqPctOfMax != null &&
          Number.isFinite(Number(body.thermalSample.minFreqPctOfMax))
            ? Number(body.thermalSample.minFreqPctOfMax).toFixed(0)
            : na;
        el.textContent = t('memHelper.tune.statusline')
          .replace(/\{preset\}/g, preset)
          .replace(/\{watchdog\}/g, wd)
          .replace(/\{thermal\}/g, th)
          .replace(/\{demote\}/g, dem)
          .replace(/\{temp\}/g, temp)
          .replace(/\{freq\}/g, freq);
      })
      .catch(function () {});
  }

  /** Populate tuning form from Realm Engine persisted JSON (see API `settingsPath`). */
  function loadMemHelperTuneUi() {
    var panel = document.getElementById('mem-helper-tune-panel');
    if (!panel || panel.classList.contains('hidden')) return;
    Promise.all([
      fetch('/api/admin/window-tuning/settings').then(function (r) {
        return r.json();
      }),
      fetch('/api/admin/window-tuning/power-plans').then(function (r) {
        return r.json();
      }),
    ])
      .then(function (arr) {
        var st = arr[0];
        var pw = arr[1];
        if (!st || !st.ok || !st.settings) return;
        if (!pw || !pw.ok || !pw.plans) return;
        var s = st.settings;
        var plans = pw.plans;
        memHelperFillPlanSelect(document.getElementById('mem-helper-power-plan-select'), plans, '');
        memHelperFillPlanSelect(document.getElementById('mem-helper-startup-plan'), plans, s.startupPowerGuid);
        memHelperFillPlanSelect(document.getElementById('mem-helper-hot-plan'), plans, s.powerGuidHot);
        memHelperFillPlanSelect(document.getElementById('mem-helper-idle-plan-select'), plans, s.powerGuidIdle);

        var ip = document.getElementById('mem-helper-idle-priority');
        var hp = document.getElementById('mem-helper-hot-priority');
        if (ip) ip.value = s.priorityPresetIdle || 'Normal';
        if (hp) hp.value = s.priorityPresetHot || 'AboveNormal';
        var auto = document.getElementById('mem-helper-auto-apply-start');
        if (auto) auto.checked = !!s.autoApplyOnProxyStart;
        var rex = document.getElementById('mem-helper-restore-baseline-on-exit');
        if (rex) rex.checked = !!s.restoreProcessBaselineOnExit;
        var wd = s.watchdog || {};
        var el = document.getElementById('mem-helper-wd-enabled');
        if (el) el.checked = !!wd.enabled;
        el = document.getElementById('mem-helper-wd-threshold');
        if (el) el.value = String(wd.cpuSumThreshold != null ? wd.cpuSumThreshold : '');
        el = document.getElementById('mem-helper-wd-cpu-metric');
        if (el) el.value = wd.cpuMetric === 'raw' ? 'raw' : 'normalized';
        syncWdThresholdCaption();
        el = document.getElementById('mem-helper-wd-hot-ms');
        if (el) el.value = String(wd.cpuSumHotDebounceMs != null ? wd.cpuSumHotDebounceMs : '');
        el = document.getElementById('mem-helper-wd-cool-ms');
        if (el) el.value = String(wd.cpuSumCoolDebounceMs != null ? wd.cpuSumCoolDebounceMs : '');
        el = document.getElementById('mem-helper-wd-hot-plan');
        if (el) el.checked = wd.onHotActivateHotPlan !== false;
        el = document.getElementById('mem-helper-wd-hot-pri');
        if (el) el.checked = wd.onHotSetPriorityHot !== false;
        el = document.getElementById('mem-helper-wd-hot-spread');
        if (el) el.checked = !!wd.onHotSpreadCores;
        el = document.getElementById('mem-helper-wd-cool-plan');
        if (el) el.checked = wd.onCoolActivateIdlePlan !== false;
        el = document.getElementById('mem-helper-wd-cool-pri');
        if (el) el.checked = wd.onCoolSetPriorityIdle !== false;
        syncMemHelperPresetHighlight(s);

        var th = s.thermal || {};
        el = document.getElementById('mem-helper-thermal-en');
        if (el) el.checked = !!th.enabled;
        el = document.getElementById('mem-helper-thermal-temp-thresh');
        if (el) el.value = String(th.pkgTempCelsiusThreshold != null ? th.pkgTempCelsiusThreshold : 84);
        el = document.getElementById('mem-helper-thermal-temp-clear');
        if (el) el.value = String(th.pkgTempCelsiusClear != null ? th.pkgTempCelsiusClear : 80);
        el = document.getElementById('mem-helper-thermal-sustain-ms');
        if (el) el.value = String(th.sustainMs != null ? th.sustainMs : 45000);
        el = document.getElementById('mem-helper-thermal-clear-ms');
        if (el) el.value = String(th.clearMs != null ? th.clearMs : 60000);
        el = document.getElementById('mem-helper-thermal-freq-low');
        if (el)
          el.value =
            th.freqPctLowThreshold != null && typeof th.freqPctLowThreshold === 'number'
              ? String(th.freqPctLowThreshold)
              : '';
        el = document.getElementById('mem-helper-thermal-freq-clear');
        if (el)
          el.value =
            th.freqPctClear != null && typeof th.freqPctClear === 'number' ? String(th.freqPctClear) : '';
        el = document.getElementById('mem-helper-thermal-demote-prio');
        if (el) el.value = th.demoteBackgroundTo === 'Idle' ? 'Idle' : 'BelowNormal';
      })
      .catch(function () {});
  }

  function collectMemHelperTuneBody() {
    function num(id, defVal) {
      var el = document.getElementById(id);
      if (!el) return defVal;
      var v = parseFloat(el.value, 10);
      return Number.isFinite(v) ? v : defVal;
    }
    function ck(id, defBool) {
      var el = document.getElementById(id);
      return el ? !!el.checked : defBool;
    }
    function gv(id) {
      var el = document.getElementById(id);
      return el && el.value ? String(el.value) : '';
    }
    function optNum(id) {
      var el = document.getElementById(id);
      if (!el || el.value === '' || String(el.value).trim() === '') return null;
      var v = parseFloat(el.value, 10);
      return Number.isFinite(v) ? v : null;
    }
    var thDem = document.getElementById('mem-helper-thermal-demote-prio');
    var thDemVal = thDem && thDem.value === 'Idle' ? 'Idle' : 'BelowNormal';
    return {
      priorityPresetIdle: (document.getElementById('mem-helper-idle-priority') || {}).value || 'Normal',
      priorityPresetHot:
        (document.getElementById('mem-helper-hot-priority') || {}).value || 'AboveNormal',
      startupPowerGuid: gv('mem-helper-startup-plan') || undefined,
      restoreProcessBaselineOnExit: ck('mem-helper-restore-baseline-on-exit', false),
      powerGuidHot: gv('mem-helper-hot-plan') || undefined,
      powerGuidIdle: gv('mem-helper-idle-plan-select') || undefined,
      autoApplyOnProxyStart: ck('mem-helper-auto-apply-start', false),
      watchdog: {
        enabled: ck('mem-helper-wd-enabled', false),
        cpuMetric: (function () {
          var met = document.getElementById('mem-helper-wd-cpu-metric');
          return met && met.value === 'raw' ? 'raw' : 'normalized';
        })(),
        cpuSumThreshold: Math.max(0, num('mem-helper-wd-threshold', 25)),
        cpuSumHotDebounceMs: Math.max(500, num('mem-helper-wd-hot-ms', 5000)),
        cpuSumCoolDebounceMs: Math.max(2000, num('mem-helper-wd-cool-ms', 45000)),
        onHotActivateHotPlan: ck('mem-helper-wd-hot-plan', true),
        onHotSetPriorityHot: ck('mem-helper-wd-hot-pri', true),
        onHotSpreadCores: ck('mem-helper-wd-hot-spread', false),
        onCoolActivateIdlePlan: ck('mem-helper-wd-cool-plan', true),
        onCoolSetPriorityIdle: ck('mem-helper-wd-cool-pri', true),
      },
      thermal: {
        enabled: ck('mem-helper-thermal-en', false),
        pkgTempCelsiusThreshold: Math.max(
          0,
          num('mem-helper-thermal-temp-thresh', 84),
        ),
        pkgTempCelsiusClear: Math.max(0, num('mem-helper-thermal-temp-clear', 80)),
        sustainMs: Math.max(3000, num('mem-helper-thermal-sustain-ms', 45000)),
        clearMs: Math.max(3000, num('mem-helper-thermal-clear-ms', 60000)),
        freqPctLowThreshold: optNum('mem-helper-thermal-freq-low'),
        freqPctClear: optNum('mem-helper-thermal-freq-clear'),
        demoteBackgroundTo: thDemVal,
      },
    };
  }

  function loadSmartTrimUi() {
    fetch('/api/admin/smart-trim/settings')
      .then(function (r) {
        return r.json();
      })
      .then(function (body) {
        if (!body || !body.ok || !body.settings) return;
        var s = body.settings;
        var px = s.proxy || {};
        var ex = s.exalt || {};
        function idSet(id, v) {
          var el = document.getElementById(id);
          if (el && v != null && v !== '') el.value = String(v);
        }
        function ckSet(id, v) {
          var el = document.getElementById(id);
          if (el) el.checked = !!v;
        }
        ckSet('mem-helper-st-proxy-en', px.enabled);
        idSet('mem-helper-st-proxy-rss-mb', Math.round((Number(px.rssBytesThreshold) || 0) / 1048576));
        idSet('mem-helper-st-proxy-rate', px.packetRateThreshold != null ? px.packetRateThreshold : '');
        idSet('mem-helper-st-proxy-check-s', Math.round((Number(px.checkIntervalMs) || 0) / 1000));
        idSet('mem-helper-st-proxy-min-s', Math.round((Number(px.minTrimIntervalMs) || 0) / 1000));
        ckSet('mem-helper-st-proxy-packets', px.trimPackets !== false);
        ckSet('mem-helper-st-proxy-lab', px.trimPacketLab !== false);
        ckSet('mem-helper-st-proxy-world', px.trimWorldSnapshot === true);
        ckSet('mem-helper-st-proxy-gc', px.runGcHint !== false);

        ckSet('mem-helper-st-exalt-en', ex.enabled);
        idSet(
          'mem-helper-st-exalt-ws-gb',
          ex.workingSetBytesPerProcessThreshold > 0
            ? (Number(ex.workingSetBytesPerProcessThreshold) / 1073741824).toFixed(2)
            : '',
        );
        ckSet('mem-helper-st-exalt-periodic', ex.periodicTrim === true);
        idSet('mem-helper-st-exalt-check-s', Math.round((Number(ex.checkIntervalMs) || 0) / 1000));
        idSet('mem-helper-st-exalt-min-s', Math.round((Number(ex.minTrimIntervalMs) || 0) / 1000));

        ckSet('mem-helper-st-exalt-trim-parent', ex.trimParentWs === true);
        ckSet('mem-helper-st-exalt-trim-child', ex.trimChildWs !== false);
        idSet(
          'mem-helper-st-exalt-mem-pct',
          typeof ex.requireMemoryLoadPercent === 'number' && ex.requireMemoryLoadPercent > 0
            ? String(ex.requireMemoryLoadPercent)
            : '',
        );
        idSet(
          'mem-helper-st-exalt-max-cpu',
          typeof ex.maxCpuPercentForTrim === 'number' && ex.maxCpuPercentForTrim > 0
            ? String(ex.maxCpuPercentForTrim)
            : '',
        );
        idSet(
          'mem-helper-st-exalt-minws-gb',
          ex.minWorkingSetBytesBeforeTrim != null &&
            typeof ex.minWorkingSetBytesBeforeTrim === 'number' &&
            Number(ex.minWorkingSetBytesBeforeTrim) > 0
            ? (Number(ex.minWorkingSetBytesBeforeTrim) / 1073741824).toFixed(2)
            : '',
        );
      })
      .catch(function () {});
  }

  function collectSmartTrimBody() {
    function nf(id, d) {
      var el = document.getElementById(id);
      if (!el || el.value === '') return d;
      var v = parseFloat(el.value, 10);
      return Number.isFinite(v) ? v : d;
    }
    function nfi(id, d) {
      var el = document.getElementById(id);
      if (!el) return d;
      var v = parseInt(el.value, 10);
      return Number.isFinite(v) ? v : d;
    }
    function ck(id, defBool) {
      var el = document.getElementById(id);
      return el ? !!el.checked : defBool;
    }
    var rssEl = document.getElementById('mem-helper-st-proxy-rss-mb');
    var rssMb = 380;
    if (rssEl && rssEl.value.trim() !== '') {
      var r = parseFloat(rssEl.value, 10);
      if (Number.isFinite(r)) rssMb = r;
    }
    var wsGbEntry = nf('mem-helper-st-exalt-ws-gb', 0);
    var reqMemPct = nf('mem-helper-st-exalt-mem-pct', 0);
    var skipCpuPct = nf('mem-helper-st-exalt-max-cpu', 0);
    var minWsGb = nf('mem-helper-st-exalt-minws-gb', 0);
    return {
      proxy: {
        enabled: ck('mem-helper-st-proxy-en', false),
        checkIntervalMs: Math.max(5000, nfi('mem-helper-st-proxy-check-s', 20) * 1000),
        rssBytesThreshold: Math.round(Math.max(0, rssMb) * 1048576),
        packetRateThreshold: Math.max(0, nf('mem-helper-st-proxy-rate', 0)),
        minTrimIntervalMs: Math.max(10000, nfi('mem-helper-st-proxy-min-s', 55) * 1000),
        trimPackets: ck('mem-helper-st-proxy-packets', true),
        trimPacketLab: ck('mem-helper-st-proxy-lab', true),
        trimWorldSnapshot: ck('mem-helper-st-proxy-world', false),
        runGcHint: ck('mem-helper-st-proxy-gc', true),
      },
      exalt: {
        enabled: ck('mem-helper-st-exalt-en', false),
        checkIntervalMs: Math.max(5000, nfi('mem-helper-st-exalt-check-s', 35) * 1000),
        workingSetBytesPerProcessThreshold:
          wsGbEntry > 0 ? Math.round(wsGbEntry * 1073741824) : 0,
        periodicTrim: ck('mem-helper-st-exalt-periodic', false),
        minTrimIntervalMs: Math.max(60_000, nfi('mem-helper-st-exalt-min-s', 180) * 1000),
        requireMemoryLoadPercent: Math.min(
          100,
          Math.max(0, Math.round(Number.isFinite(reqMemPct) ? reqMemPct : 0)),
        ),
        maxCpuPercentForTrim: Math.max(0, Number.isFinite(skipCpuPct) ? skipCpuPct : 0),
        minWorkingSetBytesBeforeTrim:
          minWsGb > 0 ? Math.round(minWsGb * 1073741824) : 0,
        trimParentWs: ck('mem-helper-st-exalt-trim-parent', false),
        trimChildWs: ck('mem-helper-st-exalt-trim-child', true),
      },
    };
  }

  function wireMemHelperTabOnce() {
    var root = document.getElementById('tab-mem-helper');
    if (!root || root.dataset.memHelperWired) return;
    root.dataset.memHelperWired = '1';
    var wdMet = document.getElementById('mem-helper-wd-cpu-metric');
    if (wdMet) {
      wdMet.addEventListener('change', syncWdThresholdCaption);
    }
    var btn = document.getElementById('mem-helper-exalt-refresh');
    if (btn) btn.addEventListener('click', refreshMemHelperExaltUi);
    var applyRolesBtn = document.getElementById('mem-helper-apply-all-roles');
    if (applyRolesBtn)
      applyRolesBtn.addEventListener('click', function () {
        fetch('/api/admin/window-tuning/client-roles/apply', { method: 'POST' })
          .then(function () {
            refreshMemHelperExaltUi();
          })
          .catch(function () {});
      });
    function memHelperPresetBodyForPolicy() {
      var panel = document.getElementById('mem-helper-tune-panel');
      var acc =
        panel && panel.querySelector('[data-tuning-preset].setting-btn-accent');
      var pname = acc && acc.getAttribute('data-tuning-preset');
      return pname ? JSON.stringify({ preset: pname }) : '{}';
    }
    var runPolicyBtn = document.getElementById('mem-helper-run-multibox-policy');
    var flashBar = document.getElementById('mem-helper-toolbar-flash');
    if (runPolicyBtn)
      runPolicyBtn.addEventListener('click', function () {
        fetch('/api/admin/window-tuning/run-multibox-policy', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: memHelperPresetBodyForPolicy(),
        })
          .then(function (r) {
            return r.json();
          })
          .then(function (body) {
            if (body && body.ok && flashBar) {
              flashBar.textContent = t('memHelper.live.runPolicyOk');
              setTimeout(function () {
                if (flashBar) flashBar.textContent = '';
              }, 4200);
            }
            refreshMemHelperExaltUi();
            loadMemHelperTuneUi();
            loadSmartTrimUi();
          })
          .catch(function () {});
      });
    var restoreBtn = document.getElementById('mem-helper-restore-all');
    if (restoreBtn)
      restoreBtn.addEventListener('click', function () {
        fetch('/api/admin/window-tuning/restore-all', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{}',
        })
          .then(function (r) {
            return r.json();
          })
          .then(function (body) {
            if (body && body.ok && flashBar) {
              flashBar.textContent = t('memHelper.live.restoreOk');
              setTimeout(function () {
                if (flashBar) flashBar.textContent = '';
              }, 4200);
            }
            loadMemHelperTuneUi();
            loadSmartTrimUi();
            refreshMemHelperExaltUi();
          })
          .catch(function () {});
      });
    var restoreBalBtn = document.getElementById('mem-helper-restore-balanced');
    if (restoreBalBtn)
      restoreBalBtn.addEventListener('click', function () {
        fetch('/api/admin/window-tuning/restore-all', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ balancedPowerPlan: true }),
        })
          .then(function (r) {
            return r.json();
          })
          .then(function (body) {
            if (body && body.ok && flashBar) {
              flashBar.textContent = t('memHelper.live.restoreOk');
              setTimeout(function () {
                if (flashBar) flashBar.textContent = '';
              }, 4200);
            }
            loadMemHelperTuneUi();
            loadSmartTrimUi();
            refreshMemHelperExaltUi();
          })
          .catch(function () {});
      });
    var killMsEdgeBtn = document.getElementById('mem-helper-kill-msedge');
    if (killMsEdgeBtn)
      killMsEdgeBtn.addEventListener('click', function () {
        fetch('/api/admin/window-tuning/kill-msedge', { method: 'POST' })
          .then(function (r) {
            return r.json();
          })
          .then(function (body) {
            if (body && body.ok && flashBar) {
              flashBar.textContent = t('memHelper.live.killMsEdgeOk');
              setTimeout(function () {
                if (flashBar) flashBar.textContent = '';
              }, 4200);
            } else if (flashBar) {
              flashBar.textContent =
                t('memHelper.live.killMsEdgeErr') +
                (body && body.error ? ' ' + body.error : '');
              setTimeout(function () {
                if (flashBar) flashBar.textContent = '';
              }, 5200);
            }
          })
          .catch(function () {
            if (flashBar) flashBar.textContent = t('memHelper.live.killMsEdgeErr');
          });
      });
    var recaptureBaselineBtn = document.getElementById('mem-helper-recapture-baseline');
    if (recaptureBaselineBtn)
      recaptureBaselineBtn.addEventListener('click', function () {
        fetch('/api/admin/window-tuning/recapture-process-baseline', { method: 'POST' })
          .then(function (r) {
            return r.json();
          })
          .then(function (body) {
            if (body && body.ok && flashBar) {
              flashBar.textContent = t('memHelper.tune.baselineRecaptured');
              setTimeout(function () {
                if (flashBar) flashBar.textContent = '';
              }, 4200);
            }
          })
          .catch(function () {});
      });
    var restoreBaselineNowBtn = document.getElementById('mem-helper-restore-baseline-now');
    if (restoreBaselineNowBtn)
      restoreBaselineNowBtn.addEventListener('click', function () {
        fetch('/api/admin/window-tuning/restore-process-baseline', { method: 'POST' })
          .then(function (r) {
            return r.json();
          })
          .then(function (body) {
            if (body && body.ok && flashBar) {
              flashBar.textContent = t('memHelper.tune.baselineRestored');
              setTimeout(function () {
                if (flashBar) flashBar.textContent = '';
              }, 4200);
            }
            refreshMemHelperExaltUi();
          })
          .catch(function () {});
      });
    var exaltTbody = document.getElementById('mem-helper-exalt-tbody');
    if (exaltTbody && !exaltTbody.dataset.mbWired) {
      exaltTbody.dataset.mbWired = '1';
      exaltTbody.addEventListener('click', function (ev) {
        var actBtn = ev.target.closest('[data-exalt-mb]');
        if (!actBtn || !exaltTbody.contains(actBtn)) return;
        ev.preventDefault();
        var mb = actBtn.getAttribute('data-exalt-mb');
        var pr = actBtn.getAttribute('data-pid');
        if (!mb || !pr) return;
        fetch('/api/admin/window-tuning/multibox-action', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ pid: parseInt(pr, 10), action: mb }),
        })
          .then(function () {
            refreshMemHelperExaltUi();
          })
          .catch(function () {});
      });
    }
    root.querySelectorAll('[data-exalt-prio]').forEach(function (b) {
      b.addEventListener('click', function () {
        var preset = b.getAttribute('data-exalt-prio');
        if (!preset) return;
        fetch('/api/admin/window-tuning/exalt-priority', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ preset: preset }),
        })
          .then(function () {
            refreshMemHelperExaltUi();
          })
          .catch(function () {});
      });
    });
    var spread = document.getElementById('mem-helper-spread-cores');
    if (spread)
      spread.addEventListener('click', function () {
        fetch('/api/admin/window-tuning/spread-cores', { method: 'POST' })
          .then(function () {
            refreshMemHelperExaltUi();
          })
          .catch(function () {});
      });
    var pr = document.getElementById('mem-helper-power-plan-refresh');
    if (pr)
      pr.addEventListener('click', function () {
        loadMemHelperTuneUi();
      });
    var pact = document.getElementById('mem-helper-power-plan-activate');
    if (pact)
      pact.addEventListener('click', function () {
        var sel = document.getElementById('mem-helper-power-plan-select');
        var guid = sel && sel.value ? String(sel.value) : '';
        if (!guid) return;
        fetch('/api/admin/window-tuning/power-plan', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ guid: guid }),
        })
          .then(function () {
            loadMemHelperTuneUi();
          })
          .catch(function () {});
      });
    root.querySelectorAll('[data-tuning-preset]').forEach(function (pb) {
      pb.addEventListener('click', function () {
        var preset = pb.getAttribute('data-tuning-preset');
        if (!preset) return;
        var stElPreset = document.getElementById('mem-helper-settings-status');
        fetch('/api/admin/window-tuning/tuning-preset', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ preset: preset }),
        })
          .then(function (r) {
            return r.json();
          })
          .then(function (body) {
            if (body && body.ok && stElPreset) {
              stElPreset.textContent = t('memHelper.tune.presetApplied');
              setTimeout(function () {
                if (stElPreset) stElPreset.textContent = '';
              }, 2600);
            } else if (stElPreset) {
              stElPreset.textContent =
                t('memHelper.tune.savedErr') + (body && body.error ? ' ' + String(body.error) : '');
            }
            loadMemHelperTuneUi();
            loadSmartTrimUi();
            refreshMemHelperExaltUi();
            refreshMemHelperTuneStatusLine();
          })
          .catch(function () {});
      });
    });
    var save = document.getElementById('mem-helper-save-settings');
    var stEl = document.getElementById('mem-helper-settings-status');
    if (save)
      save.addEventListener('click', function () {
        fetch('/api/admin/window-tuning/settings', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(collectMemHelperTuneBody()),
        })
          .then(function (r) {
            return r.json();
          })
          .then(function (body) {
            if (body && body.ok && stEl) {
              stEl.textContent = t('memHelper.tune.savedOk');
              setTimeout(function () {
                if (stEl) stEl.textContent = '';
              }, 2600);
            } else if (stEl) stEl.textContent = t('memHelper.tune.savedErr');
            loadMemHelperTuneUi();
          })
          .catch(function () {
            if (stEl) stEl.textContent = t('memHelper.tune.savedErr');
          });
      });
    var savSt = document.getElementById('mem-helper-smart-save');
    var stStatus = document.getElementById('mem-helper-smart-status');
    if (savSt)
      savSt.addEventListener('click', function () {
        fetch('/api/admin/smart-trim/settings', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(collectSmartTrimBody()),
        })
          .then(function (r) {
            return r.json();
          })
          .then(function (body) {
            if (body && body.ok && stStatus) {
              stStatus.textContent = t('memHelper.smart.savedOk');
              setTimeout(function () {
                if (stStatus) stStatus.textContent = '';
              }, 2600);
            } else if (stStatus) stStatus.textContent = t('memHelper.smart.savedErr');
            loadSmartTrimUi();
          })
          .catch(function () {
            if (stStatus) stStatus.textContent = t('memHelper.smart.savedErr');
          });
      });
    var btnExWs = document.getElementById('mem-helper-st-exalt-once');
    if (btnExWs)
      btnExWs.addEventListener('click', function () {
        fetch('/api/admin/smart-trim/exalt-once', { method: 'POST' })
          .then(function (r) {
            return r.json();
          })
          .then(function (body) {
            if (body && body.ok && stStatus) stStatus.textContent = t('memHelper.smart.onceOk');
            refreshMemHelperExaltUi();
          })
          .catch(function () {});
      });
  }

  // Sniffer controls
  document.getElementById('btn-pause').addEventListener('click', function() {
    paused = !paused;
    this.textContent = paused ? 'Resume' : 'Pause';
    this.classList.toggle('active', paused);
    if (!paused) refreshTable();
  });

  document.getElementById('btn-clear').addEventListener('click', () => {
    packets = [];
    packetBody.innerHTML = '';
    totalCount = 0;
    totalEl.textContent = '0 total';
    snifferPacketsSinceCollapse = 0;
    snifferBadge.classList.add('hidden');
  });

  document.getElementById('btn-export').addEventListener('click', () => {
    // Always export ALL captured packets, ignoring UI filters (Hide Noisy, search, etc.)
    // so that exports are complete logs suitable for analysis.
    const blob = new Blob([JSON.stringify(packets, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'packets_' + new Date().toISOString().slice(0, 19) + '.json';
    a.click();
    URL.revokeObjectURL(url);
  });

  document.getElementById('detail-close').addEventListener('click', () => {
    detailPanel.classList.add('hidden');
    const prev = packetBody.querySelector('.selected');
    if (prev) prev.classList.remove('selected');
  });

  filterCS.addEventListener('change', refreshTable);
  filterSC.addEventListener('change', refreshTable);
  filterHideNoisy.addEventListener('change', refreshTable);
  filterSearch.addEventListener('input', refreshTable);

  function appendLogEntry(targetEl, plugin, message) {
    if (!targetEl) return;
    const entry = document.createElement('div');
    entry.className = 'plugin-log-entry';
    const timeStr = new Date().toISOString().slice(11, 19);
    entry.innerHTML =
      '<span class="log-time">' + timeStr + '</span> ' +
      '<span class="log-plugin">[' + escapeHtml(plugin) + ']</span> ' +
      '<span class="log-msg">' + escapeHtml(message) + '</span>';
    targetEl.appendChild(entry);
    while (targetEl.children.length > MAX_PLUGIN_LOGS) {
      targetEl.removeChild(targetEl.firstChild);
    }
    targetEl.scrollTop = targetEl.scrollHeight;
  }

  function refreshLogsEmptyState() {
    if (!logsEmpty || !logsList) return;
    logsEmpty.style.display = logsList.children.length > 0 ? 'none' : '';
  }

  // Plugin logs
  function addPluginLog(plugin, message) {
    appendLogEntry(logsList, plugin, message);
    refreshLogsEmptyState();
    addHomeFeed('info', '[' + String(plugin || 'plugin') + '] ' + String(message || ''));
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  function formatObjVal(v) {
    return v !== null && v !== undefined ? String(v) : '--';
  }

  function _objectsTreeDataHash(data) {
    if (!data) return '';
    const parts = [];
    (data.portals || []).forEach(function (g) {
      const ids = (g.entities || []).map(function (e) { return e.objectId; }).join(',');
      parts.push('p:' + (g.name || '') + '|' + (g.objectType || 0) + '|' + ids);
    });
    (data.beacons || []).forEach(function (g) {
      const ids = (g.entities || []).map(function (e) { return e.objectId; }).join(',');
      parts.push('b:' + (g.name || '') + '|' + (g.objectType || 0) + '|' + ids);
    });
    (data.categories || []).forEach(function (cat) {
      (cat.groups || []).forEach(function (g) {
        const ids = (g.entities || []).map(function (e) { return e.objectId; }).join(',');
        parts.push(cat.category + ':' + (g.name || '') + '|' + (g.objectType || 0) + '|' + ids);
      });
    });
    return parts.join(';');
  }

  function _tilemapTreeDataHash(data) {
    if (!data) return '';
    var parts = [];
    parts.push('center:' + String((data.center && data.center.x) || 0) + ',' + String((data.center && data.center.y) || 0));
    parts.push('radius:' + String(data.radius || 0));
    (data.groups || []).forEach(function (group) {
      var coords = (group.tiles || []).map(function (tile) { return String(tile.x) + ',' + String(tile.y); }).join('|');
      parts.push(String(group.tileType || 0) + ':' + String(group.name || '') + ':' + coords);
    });
    return parts.join(';');
  }

  function appendGroupToNode(parentNode, group, depth, defaultClosed) {
    const typeHex = '0x' + group.objectType.toString(16);
    const count = (group.entities || []).length;
    const typeRow = document.createElement('div');
    typeRow.className = 'objects-tree-node objects-tree-folder' + (defaultClosed ? ' collapsed' : '');
    typeRow.setAttribute('data-depth', String(depth));
    const typeToggle = document.createElement('span');
    typeToggle.className = 'objects-tree-toggle';
    typeToggle.setAttribute('aria-label', 'Expand/collapse');
    typeRow.appendChild(typeToggle);
    const typeLabel = document.createElement('span');
    typeLabel.className = 'objects-tree-label';
    const typeName = group.name || typeHex;
    typeLabel.textContent = 'Type ' + group.objectType + (typeName !== typeHex ? ' (' + typeName + ')' : '') + '  [' + count + ']';
    typeRow.appendChild(typeLabel);
    const typeChildren = document.createElement('div');
    typeChildren.className = 'objects-tree-children';
    typeRow.appendChild(typeChildren);
    for (const ent of group.entities) {
      const objRow = document.createElement('div');
      objRow.className = 'objects-tree-node objects-tree-folder collapsed';
      objRow.setAttribute('data-depth', String(depth + 1));
      const objToggle = document.createElement('span');
      objToggle.className = 'objects-tree-toggle';
      objToggle.setAttribute('aria-label', 'Expand/collapse');
      objRow.appendChild(objToggle);
      const objLabel = document.createElement('span');
      objLabel.className = 'objects-tree-label objects-tree-monospace';
      objLabel.textContent = 'objectId: ' + String(ent.objectId);
      objRow.appendChild(objLabel);
      const objChildren = document.createElement('div');
      objChildren.className = 'objects-tree-children';
      objRow.appendChild(objChildren);
      const detailsRow = document.createElement('div');
      detailsRow.className = 'objects-tree-node objects-tree-details';
      detailsRow.setAttribute('data-depth', String(depth + 2));
      const detailsLabel = document.createElement('span');
      detailsLabel.className = 'objects-tree-label objects-tree-monospace';
      detailsLabel.textContent = 'Position: x=' + formatObjVal(ent.x) + ', y=' + formatObjVal(ent.y);
      detailsRow.appendChild(detailsLabel);
      objChildren.appendChild(detailsRow);
      if (ent.hp != null || ent.maxHp != null) {
        const hpRow = document.createElement('div');
        hpRow.className = 'objects-tree-node objects-tree-details';
        hpRow.setAttribute('data-depth', String(depth + 2));
        const hpLabel = document.createElement('span');
        hpLabel.className = 'objects-tree-label objects-tree-monospace';
        const hpVal = Number(ent.hp);
        const maxHpVal = Number(ent.maxHp);
        hpLabel.textContent = 'HP: ' + (Number.isFinite(hpVal) ? hpVal : '?') + (Number.isFinite(maxHpVal) ? ' / ' + maxHpVal : '');
        hpRow.appendChild(hpLabel);
        objChildren.appendChild(hpRow);
      }
      typeChildren.appendChild(objRow);
    }
    parentNode.appendChild(typeRow);
  }

  function isVisualOnlyObjectGroup(name) {
    if (!name || typeof name !== 'string') return false;
    const n = name.toLowerCase();
    return n.indexOf('tree') !== -1 || n.indexOf('table') !== -1 || n.indexOf('edge') !== -1 || n.indexOf('wall') !== -1 || n.indexOf('rock') !== -1 || n.indexOf('grass') !== -1 || n.indexOf('snow') !== -1 || n.indexOf('ground') !== -1 || n.indexOf('butterfly') !== -1 || n.indexOf('hanami') !== -1 || n.indexOf('bench') !== -1 || n.indexOf('lantern') !== -1;
  }

  function renderObjectsTree(data) {
    const treeEl = document.getElementById('objects-tree');
    const emptyEl = document.getElementById('objects-empty');
    if (!treeEl || !emptyEl) return;

    const portals = (data && data.portals) || [];
    const beacons = (data && data.beacons) || [];
    const categories = (data && data.categories) || [];
    const visualOnlyExtraGroups = [];
    const categoriesFiltered = categories.map(function (cat) {
      if (!cat.groups || !cat.groups.length) return cat;
      const other = [];
      cat.groups.forEach(function (group) {
        if (isVisualOnlyObjectGroup(group.name)) {
          visualOnlyExtraGroups.push(group);
        } else {
          other.push(group);
        }
      });
      return { category: cat.category, groups: other };
    }).filter(function (cat) { return cat.groups.length > 0; });

    // Merge tree/table/edge/wall/rock/grass/snow groups into Visual Only
    if (visualOnlyExtraGroups.length > 0) {
      let visualOnlyCat = categoriesFiltered.find(function (c) { return c.category === 'Visual Only'; });
      if (!visualOnlyCat) {
        visualOnlyCat = { category: 'Visual Only', groups: [] };
        categoriesFiltered.push(visualOnlyCat);
      }
      visualOnlyExtraGroups.forEach(function (g) { visualOnlyCat.groups.push(g); });
    }

    const hasAny = portals.length > 0 || beacons.length > 0 || categoriesFiltered.length > 0;

    if (!hasAny) {
      emptyEl.style.display = '';
      treeEl.innerHTML = '';
      _objectsTreeHash = null;
      return;
    }

    const newHash = _objectsTreeDataHash(data);
    if (newHash === _objectsTreeHash) {
      return;
    }
    _objectsTreeHash = newHash;

    emptyEl.style.display = 'none';
    const root = document.createElement('div');
    root.className = 'objects-tree-node objects-tree-folder';
    root.setAttribute('data-depth', '0');
    const rootToggle = document.createElement('span');
    rootToggle.className = 'objects-tree-toggle';
    rootToggle.setAttribute('aria-label', 'Expand/collapse');
    root.appendChild(rootToggle);
    const rootLabel = document.createElement('span');
    rootLabel.className = 'objects-tree-label';
    rootLabel.textContent = 'Objects';
    root.appendChild(rootLabel);

    const rootChildren = document.createElement('div');
    rootChildren.className = 'objects-tree-children';
    root.appendChild(rootChildren);

    if (portals.length > 0) {
      const portalsNode = document.createElement('div');
      portalsNode.className = 'objects-tree-node objects-tree-folder';
      portalsNode.setAttribute('data-depth', '1');
      const portalsToggle = document.createElement('span');
      portalsToggle.className = 'objects-tree-toggle';
      portalsToggle.setAttribute('aria-label', 'Expand/collapse');
      portalsNode.appendChild(portalsToggle);
      const portalsLabel = document.createElement('span');
      portalsLabel.className = 'objects-tree-label';
      portalsLabel.textContent = 'Portals  [' + portals.length + ' types]';
      portalsNode.appendChild(portalsLabel);
      const portalsChildren = document.createElement('div');
      portalsChildren.className = 'objects-tree-children';
      portalsNode.appendChild(portalsChildren);
      portals.forEach(function (group) {
        appendGroupToNode(portalsChildren, group, 2, true);
      });
      rootChildren.appendChild(portalsNode);
    }

    if (beacons.length > 0) {
      const beaconsNode = document.createElement('div');
      beaconsNode.className = 'objects-tree-node objects-tree-folder';
      beaconsNode.setAttribute('data-depth', '1');
      const beaconsToggle = document.createElement('span');
      beaconsToggle.className = 'objects-tree-toggle';
      beaconsToggle.setAttribute('aria-label', 'Expand/collapse');
      beaconsNode.appendChild(beaconsToggle);
      const beaconsLabel = document.createElement('span');
      beaconsLabel.className = 'objects-tree-label';
      beaconsLabel.textContent = 'Beacons  [' + beacons.length + ' types]';
      beaconsNode.appendChild(beaconsLabel);
      const beaconsChildren = document.createElement('div');
      beaconsChildren.className = 'objects-tree-children';
      beaconsNode.appendChild(beaconsChildren);
      beacons.forEach(function (group) {
        appendGroupToNode(beaconsChildren, group, 2, true);
      });
      rootChildren.appendChild(beaconsNode);
    }

    categoriesFiltered.forEach(function (cat) {
      if (!cat.groups || cat.groups.length === 0) return;
      const catNode = document.createElement('div');
      catNode.className = 'objects-tree-node objects-tree-folder collapsed';
      catNode.setAttribute('data-depth', '1');
      const catToggle = document.createElement('span');
      catToggle.className = 'objects-tree-toggle';
      catToggle.setAttribute('aria-label', 'Expand/collapse');
      catNode.appendChild(catToggle);
      const catLabel = document.createElement('span');
      catLabel.className = 'objects-tree-label';
      catLabel.textContent = cat.category + '  [' + cat.groups.length + ' types]';
      catNode.appendChild(catLabel);
      const catChildren = document.createElement('div');
      catChildren.className = 'objects-tree-children';
      catNode.appendChild(catChildren);
      cat.groups.forEach(function (group) {
        appendGroupToNode(catChildren, group, 2, true);
      });
      rootChildren.appendChild(catNode);
    });

    treeEl.innerHTML = '';
    treeEl.appendChild(root);
  }

  function renderTilemapTree(data) {
    var treeEl = document.getElementById('tilemap-tree');
    var emptyEl = document.getElementById('tilemap-empty');
    if (!treeEl || !emptyEl) return;

    var groups = (data && data.groups) || [];
    if (!groups.length) {
      emptyEl.style.display = '';
      treeEl.innerHTML = '';
      _tilemapTreeHash = null;
      return;
    }

    var newHash = _tilemapTreeDataHash(data);
    if (newHash === _tilemapTreeHash) return;
    _tilemapTreeHash = newHash;

    emptyEl.style.display = 'none';
    var root = document.createElement('div');
    root.className = 'objects-tree-node objects-tree-folder';
    root.setAttribute('data-depth', '0');
    var rootToggle = document.createElement('span');
    rootToggle.className = 'objects-tree-toggle';
    rootToggle.setAttribute('aria-label', 'Expand/collapse');
    root.appendChild(rootToggle);
    var rootLabel = document.createElement('span');
    rootLabel.className = 'objects-tree-label';
    rootLabel.textContent = 'Tiles around x=' + Number((data.center && data.center.x) || 0).toFixed(2) + ', y=' + Number((data.center && data.center.y) || 0).toFixed(2) + '  [' + groups.length + ' types]';
    root.appendChild(rootLabel);
    var rootChildren = document.createElement('div');
    rootChildren.className = 'objects-tree-children';
    root.appendChild(rootChildren);

    groups.forEach(function (group) {
      var node = document.createElement('div');
      node.className = 'objects-tree-node objects-tree-folder collapsed';
      node.setAttribute('data-depth', '1');
      var toggle = document.createElement('span');
      toggle.className = 'objects-tree-toggle';
      toggle.setAttribute('aria-label', 'Expand/collapse');
      node.appendChild(toggle);
      var label = document.createElement('span');
      label.className = 'objects-tree-label';
      label.textContent = 'Type ' + String(group.tileType || 0) + ' (' + String(group.name || ('0x' + Number(group.tileType || 0).toString(16))) + ')  [' + ((group.tiles || []).length) + ']';
      node.appendChild(label);
      var children = document.createElement('div');
      children.className = 'objects-tree-children';
      node.appendChild(children);
      (group.tiles || []).forEach(function (tile) {
        var row = document.createElement('div');
        row.className = 'objects-tree-node objects-tree-details';
        row.setAttribute('data-depth', '2');
        var rowLabel = document.createElement('span');
        rowLabel.className = 'objects-tree-label objects-tree-monospace';
        rowLabel.textContent = 'Tile: x=' + formatObjVal(tile.x) + ', y=' + formatObjVal(tile.y);
        row.appendChild(rowLabel);
        children.appendChild(row);
      });
      rootChildren.appendChild(node);
    });

    treeEl.innerHTML = '';
    treeEl.appendChild(root);
  }

  // One-time expand/collapse delegation on the tree container
  (function () {
    const treeEl = document.getElementById('objects-tree');
    if (treeEl) {
      treeEl.addEventListener('click', function (e) {
        const folder = e.target.closest('.objects-tree-folder');
        if (!folder) return;
        const children = folder.querySelector('.objects-tree-children');
        if (children && children.contains(e.target)) return;
        folder.classList.toggle('collapsed');
      });
    }
    const tileTreeEl = document.getElementById('tilemap-tree');
    if (tileTreeEl) {
      tileTreeEl.addEventListener('click', function (e) {
        const folder = e.target.closest('.objects-tree-folder');
        if (!folder) return;
        const children = folder.querySelector('.objects-tree-children');
        if (children && children.contains(e.target)) return;
        folder.classList.toggle('collapsed');
      });
    }
  })();

  // ─── Nearby Players tab ─────────────────────────────────

  function requestNearbyPlayersOnce() {
    if (ws && ws.readyState === 1) {
      ws.send(JSON.stringify({ type: 'requestNearbyPlayers' }));
    }
  }

  function startNearbyPolling() {
    stopNearbyPolling();
    requestNearbyPlayersOnce();
    nearbyPollTimer = setInterval(requestNearbyPlayersOnce, 500);
  }

  function stopNearbyPolling() {
    if (nearbyPollTimer) {
      clearInterval(nearbyPollTimer);
      nearbyPollTimer = null;
    }
  }

  function fmtItemId(id) {
    const n = Number(id);
    if (!Number.isFinite(n) || n === -1) return '--';
    return String(n);
  }

  function renderNearbyPlayersTab() {
    if (!nearbyTbody || !nearbyEmptyEl) return;
    const players = Array.isArray(lastNearbyPlayers) ? lastNearbyPlayers.slice() : [];

    const filter = (nearbyFilterEl && nearbyFilterEl.value || '').trim().toLowerCase();
    if (filter) {
      for (let i = players.length - 1; i >= 0; i--) {
        const nm = String(players[i].name || '').toLowerCase();
        if (!nm.includes(filter)) players.splice(i, 1);
      }
    }

    const sortMode = nearbySortEl ? nearbySortEl.value : 'distance';
    if (sortMode === 'name') {
      players.sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''), undefined, { sensitivity: 'base' }));
    } else if (sortMode === 'hp') {
      players.sort((a, b) => (a.hpPct ?? 1) - (b.hpPct ?? 1));
    } else {
      players.sort((a, b) => (a.dist ?? 0) - (b.dist ?? 0));
    }

    nearbyTbody.innerHTML = '';

    if (!players || players.length === 0) {
      nearbyEmptyEl.style.display = '';
      return;
    }
    nearbyEmptyEl.style.display = 'none';

    for (const p of players) {
      const tr = document.createElement('tr');
      tr.className = 'nearby-row' + ((p.objectId === selectedNearbyPlayerId) ? ' selected' : '');
      tr.dataset.objectId = String(p.objectId);

      const tdName = document.createElement('td');
      tdName.className = 'nearby-name';
      tdName.textContent = p.name || '?';
      tr.appendChild(tdName);

      const tdDist = document.createElement('td');
      tdDist.textContent = (p.dist != null) ? Number(p.dist).toFixed(1) : '--';
      tr.appendChild(tdDist);

      const tdHp = document.createElement('td');
      const hp = Number(p.hp ?? 0);
      const maxHp = Number(p.maxHp ?? 0);
      const hpPct = hp / Math.max(1, maxHp);
      tdHp.textContent = hp + '/' + maxHp;
      tdHp.style.color = hpPct > 0.5 ? 'rgb(120, 220, 140)' : 'rgb(240, 120, 120)';
      tr.appendChild(tdHp);

      const tdMp = document.createElement('td');
      tdMp.textContent = String(p.mp ?? 0) + '/' + String(p.maxMp ?? 0);
      tdMp.style.color = 'rgb(120, 160, 255)';
      tr.appendChild(tdMp);

      const tdLv = document.createElement('td');
      tdLv.textContent = p.level ? String(p.level) : '--';
      tr.appendChild(tdLv);

      const tdFame = document.createElement('td');
      tdFame.textContent = p.fame ? String(p.fame) : '--';
      tr.appendChild(tdFame);

      const tdEq = document.createElement('td');
      const eq = Array.isArray(p.eq) ? p.eq : [];
      tdEq.textContent = [fmtItemId(eq[0]), fmtItemId(eq[1]), fmtItemId(eq[2]), fmtItemId(eq[3])].join(' / ');
      tdEq.style.color = 'var(--text-muted)';
      tr.appendChild(tdEq);

      // Right click: open debug
      tr.addEventListener('contextmenu', function (e) {
        e.preventDefault();
        selectedNearbyPlayerId = p.objectId;
        lastNearbyPlayerDebug = null;
        if (nearbyDebugSubtitleEl) {
          const cls = p.className ? (' • ' + p.className) : '';
          nearbyDebugSubtitleEl.textContent = (p.name || '?') + cls + '  (objectId ' + p.objectId + ')';
        }
        renderNearbyPlayersTab();
        renderNearbyPlayerDebug();
        if (ws && ws.readyState === 1) {
          ws.send(JSON.stringify({ type: 'requestNearbyPlayerDebug', objectId: p.objectId }));
        }
      });

      nearbyTbody.appendChild(tr);
    }
  }

  function appendDebugNode(parent, key, value, depth) {
    const isObj = value && typeof value === 'object';
    const isArr = Array.isArray(value);
    if (isObj) {
      const row = document.createElement('div');
      row.className = 'objects-tree-node objects-tree-folder collapsed';
      row.setAttribute('data-depth', String(depth));
      const toggle = document.createElement('span');
      toggle.className = 'objects-tree-toggle';
      toggle.setAttribute('aria-label', 'Expand/collapse');
      row.appendChild(toggle);
      const label = document.createElement('span');
      label.className = 'objects-tree-label';
      label.textContent = String(key);
      row.appendChild(label);
      const children = document.createElement('div');
      children.className = 'objects-tree-children';
      row.appendChild(children);

      if (isArr) {
        for (let i = 0; i < value.length; i++) {
          appendDebugNode(children, String(i), value[i], depth + 1);
        }
      } else {
        const keys = Object.keys(value);
        // If this looks like numeric stat ids, sort numerically
        const allNumeric = keys.length > 0 && keys.every(k => /^\d+$/.test(k));
        if (allNumeric) keys.sort((a, b) => Number(a) - Number(b));
        else keys.sort();
        for (const k of keys) {
          appendDebugNode(children, k, value[k], depth + 1);
        }
      }

      parent.appendChild(row);
      return;
    }

    const leaf = document.createElement('div');
    leaf.className = 'objects-tree-node objects-tree-details';
    leaf.setAttribute('data-depth', String(depth));
    const leafLabel = document.createElement('span');
    leafLabel.className = 'objects-tree-label objects-tree-monospace';
    leafLabel.textContent = String(key) + ': ' + formatObjVal(value);
    leaf.appendChild(leafLabel);
    parent.appendChild(leaf);
  }

  function filterNearbyDebug(debug) {
    if (!debug || typeof debug !== 'object') return null;

    // Filter out the fields we already show in the table (name, dist, HP/MP, level, fame, equipped)
    const raw = debug.rawStats || {};
    const filteredRaw = {};
    const skipIds = new Set(['0','1','3','4','7','31','39','8','9','10','11']);
    Object.keys(raw).forEach(function (k) {
      if (!skipIds.has(String(k))) filteredRaw[k] = raw[k];
    });

    const misc = Object.assign({}, debug.misc || {});
    delete misc.level;
    delete misc.fame;

    const position = Object.assign({}, debug.position || {});
    delete position.dist;

    const vitals = Object.assign({}, debug.vitals || {});
    delete vitals.hp;
    delete vitals.maxHp;
    delete vitals.mp;
    delete vitals.maxMp;

    const inv = debug.inventory || {};
    const invFiltered = {
      inventory: inv.inventory || [],
      backpack: inv.backpack || [],
    };

    const identity = Object.assign({}, debug.identity || {});
    delete identity.name;

    return {
      identity,
      position,
      stats: debug.stats || {},
      boosts: debug.boosts || {},
      misc,
      inventory: invFiltered,
      effects: debug.effects || {},
      rawStats: filteredRaw,
    };
  }

  function renderNearbyPlayerDebug() {
    if (!nearbyDebugTreeEl || !nearbyDebugEmptyEl) return;
    const filtered = filterNearbyDebug(lastNearbyPlayerDebug);
    if (!filtered) {
      nearbyDebugTreeEl.innerHTML = '';
      nearbyDebugEmptyEl.style.display = '';
      return;
    }
    nearbyDebugEmptyEl.style.display = 'none';
    const root = document.createElement('div');
    root.className = 'objects-tree-node objects-tree-folder';
    root.setAttribute('data-depth', '0');
    const rootToggle = document.createElement('span');
    rootToggle.className = 'objects-tree-toggle';
    rootToggle.setAttribute('aria-label', 'Expand/collapse');
    root.appendChild(rootToggle);
    const rootLabel = document.createElement('span');
    rootLabel.className = 'objects-tree-label';
    rootLabel.textContent = 'Debug';
    root.appendChild(rootLabel);
    const children = document.createElement('div');
    children.className = 'objects-tree-children';
    root.appendChild(children);

    appendDebugNode(children, 'identity', filtered.identity, 1);
    appendDebugNode(children, 'position', filtered.position, 1);
    appendDebugNode(children, 'stats', filtered.stats, 1);
    appendDebugNode(children, 'boosts', filtered.boosts, 1);
    appendDebugNode(children, 'inventory', filtered.inventory, 1);
    appendDebugNode(children, 'effects', filtered.effects, 1);
    appendDebugNode(children, 'misc', filtered.misc, 1);
    appendDebugNode(children, 'rawStats', filtered.rawStats, 1);

    nearbyDebugTreeEl.innerHTML = '';
    nearbyDebugTreeEl.appendChild(root);
  }

  // Expand/collapse delegation on the nearby debug tree container
  (function () {
    if (nearbyDebugTreeEl) {
      nearbyDebugTreeEl.addEventListener('click', function (e) {
        const folder = e.target.closest('.objects-tree-folder');
        if (!folder) return;
        const children = folder.querySelector('.objects-tree-children');
        if (children && children.contains(e.target)) return;
        folder.classList.toggle('collapsed');
      });
    }
  })();

  if (nearbyRefreshBtn) {
    nearbyRefreshBtn.addEventListener('click', function () {
      requestNearbyPlayersOnce();
    });
  }

  if (nearbySortEl) nearbySortEl.addEventListener('change', renderNearbyPlayersTab);
  if (nearbyFilterEl) nearbyFilterEl.addEventListener('input', renderNearbyPlayersTab);

  // Damage tab controls
  if (damageFilterEl) {
    damageFilterEl.value = damageFilter;
    damageFilterEl.addEventListener('change', () => {
      damageFilter = damageFilterEl.value || 'all';
      localStorage.setItem('damageFilter', damageFilter);
      if (activeTab === 'damage') renderDamageTab();
    });
  }
  if (damageSortEl) {
    damageSortEl.value = damageSort;
    damageSortEl.addEventListener('change', () => {
      damageSort = damageSortEl.value || 'lastHit';
      localStorage.setItem('damageSort', damageSort);
      if (activeTab === 'damage') renderDamageTab();
    });
  }
  if (damagePlayerModalCloseBtn) {
    damagePlayerModalCloseBtn.addEventListener('click', () => closeDamagePlayerModal());
  }
  if (damagePlayerModalOverlayEl) {
    damagePlayerModalOverlayEl.addEventListener('click', (e) => {
      if (e.target === damagePlayerModalOverlayEl) closeDamagePlayerModal();
    });
  }
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && damagePlayerModalOverlayEl && damagePlayerModalOverlayEl.style.display !== 'none') {
      closeDamagePlayerModal();
    }
  });

  // ─── Tab switching ──────────────────────────────────────

  /**
   * Admin Multibox tab: draggable / resizable placeholder “windows” inside a canvas.
   */
  function initMultiboxPlaceholderStage() {
    var stage = document.getElementById('multibox-stage');
    if (!stage || stage.dataset.multiboxWired === '1') return;
    stage.dataset.multiboxWired = '1';

    var MIN_W = 120;
    var MIN_H = 80;
    var zStack = 1;

    function stageRect() {
      return stage.getBoundingClientRect();
    }

    function winGeom(win) {
      var sr = stageRect();
      var wr = win.getBoundingClientRect();
      return {
        left: wr.left - sr.left,
        top: wr.top - sr.top,
        width: wr.width,
        height: wr.height,
      };
    }

    function setWinGeom(win, g) {
      var sr = stageRect();
      var w = Math.max(MIN_W, g.width);
      var h = Math.max(MIN_H, g.height);
      var l = g.left;
      var t = g.top;

      if (w > sr.width) w = sr.width;
      if (h > sr.height) h = sr.height;
      w = Math.max(MIN_W, w);
      h = Math.max(MIN_H, h);

      if (l + w > sr.width) l = sr.width - w;
      if (t + h > sr.height) t = sr.height - h;
      if (l < 0) l = 0;
      if (t < 0) t = 0;

      if (l + w > sr.width) w = Math.max(MIN_W, sr.width - l);
      if (t + h > sr.height) h = Math.max(MIN_H, sr.height - t);

      win.style.left = l + 'px';
      win.style.top = t + 'px';
      win.style.width = w + 'px';
      win.style.height = h + 'px';
    }

    function clamp(win) {
      setWinGeom(win, winGeom(win));
    }

    function nextClientIndex() {
      var max = 0;
      stage.querySelectorAll('.multibox-window').forEach(function (w) {
        var i = parseInt(w.getAttribute('data-client-index'), 10);
        if (!isFinite(i)) return;
        if (i > max) max = i;
      });
      return max + 1;
    }

    function updateMultiboxEmptyState() {
      var empty = document.getElementById('multibox-empty');
      var count = stage.querySelectorAll('.multibox-window').length;
      if (empty) empty.classList.toggle('hidden', count > 0);
    }

    function getSortedMultiboxWindows() {
      return Array.from(stage.querySelectorAll('.multibox-window')).sort(function (a, b) {
        return parseInt(a.getAttribute('data-client-index'), 10) - parseInt(b.getAttribute('data-client-index'), 10);
      });
    }

    function updateMainVisualFromDom(sortedOpt) {
      var sorted =
        sortedOpt ||
        getSortedMultiboxWindows();
      sorted.forEach(function (w, idx) {
        w.classList.toggle('multibox-window--main', idx === 0);
      });
    }

    function wireMultiboxWindow(win) {
      clamp(win);

      var resizeEl = win.querySelector('.multibox-resize-handle');
      var removeBtn = win.querySelector('.multibox-window-remove');
      var dragging = false;
      var resizing = false;
      var startClientX = 0;
      var startClientY = 0;
      var startGeom = null;

      win.addEventListener('pointerdown', function (e) {
        if (e.button !== 0) return;
        if (e.target.closest('.multibox-resize-handle')) return;
        if (e.target.closest('.multibox-window-remove')) return;
        e.preventDefault();
        zStack += 1;
        win.style.zIndex = String(zStack);
        dragging = true;
        resizing = false;
        startClientX = e.clientX;
        startClientY = e.clientY;
        startGeom = winGeom(win);
        try {
          win.setPointerCapture(e.pointerId);
        } catch (err) { /* noop */ }
      });

      win.addEventListener('pointermove', function (e) {
        if (!dragging) return;
        var dx = e.clientX - startClientX;
        var dy = e.clientY - startClientY;
        setWinGeom(win, {
          left: startGeom.left + dx,
          top: startGeom.top + dy,
          width: startGeom.width,
          height: startGeom.height,
        });
      });

      function endDrag(e) {
        if (!dragging) return;
        dragging = false;
        try {
          win.releasePointerCapture(e.pointerId);
        } catch (err) { /* noop */ }
      }
      win.addEventListener('pointerup', endDrag);
      win.addEventListener('pointercancel', endDrag);

      if (removeBtn) {
        removeBtn.addEventListener('pointerdown', function (e) {
          e.stopPropagation();
        });
        removeBtn.addEventListener('click', function (e) {
          e.preventDefault();
          e.stopPropagation();
          win.remove();
          updateMultiboxEmptyState();
          updateMainVisualFromDom();
        });
      }

      if (resizeEl) {
        resizeEl.addEventListener('pointerdown', function (e) {
          if (e.button !== 0) return;
          e.preventDefault();
          e.stopPropagation();
          dragging = false;
          zStack += 1;
          win.style.zIndex = String(zStack);
          resizing = true;
          startClientX = e.clientX;
          startClientY = e.clientY;
          startGeom = winGeom(win);
          resizeEl.setPointerCapture(e.pointerId);
        });
        resizeEl.addEventListener('pointermove', function (e) {
          if (!resizing) return;
          var dx = e.clientX - startClientX;
          var dy = e.clientY - startClientY;
          setWinGeom(win, {
            left: startGeom.left,
            top: startGeom.top,
            width: startGeom.width + dx,
            height: startGeom.height + dy,
          });
        });
        function endResize(e) {
          if (!resizing) return;
          resizing = false;
          try {
            resizeEl.releasePointerCapture(e.pointerId);
          } catch (err2) { /* noop */ }
        }
        resizeEl.addEventListener('pointerup', endResize);
        resizeEl.addEventListener('pointercancel', endResize);
      }
    }

    function addMultiboxClient() {
      var idx = nextClientIndex();
      var prevCount = stage.querySelectorAll('.multibox-window').length;
      var offset = (prevCount % 10) * 18;
      var win = document.createElement('div');
      win.className = 'multibox-window';
      win.setAttribute('data-client-index', String(idx));
      win.style.left = 24 + offset + 'px';
      win.style.top = 28 + offset + 'px';
      win.style.width = '220px';
      win.style.height = '160px';

      var head = document.createElement('div');
      head.className = 'multibox-window-head';
      var title = document.createElement('span');
      title.className = 'multibox-window-title';
      title.textContent = tr('multibox.clientTitle', { n: idx });
      var removeBtnEl = document.createElement('button');
      removeBtnEl.type = 'button';
      removeBtnEl.className = 'multibox-window-remove';
      removeBtnEl.setAttribute('data-i18n-aria-label', 'multibox.removeClient');
      removeBtnEl.setAttribute('data-i18n-title', 'multibox.removeClient');
      removeBtnEl.innerHTML = '&times;';

      head.appendChild(title);
      head.appendChild(removeBtnEl);

      var body = document.createElement('div');
      body.className = 'multibox-window-body';
      var ph = document.createElement('span');
      ph.setAttribute('data-i18n', 'multibox.placeholder');
      ph.textContent = t('multibox.placeholder');
      body.appendChild(ph);

      var rh = document.createElement('div');
      rh.className = 'multibox-resize-handle';
      rh.setAttribute('tabindex', '-1');
      rh.setAttribute('aria-hidden', 'true');
      rh.setAttribute('title', 'Resize');

      win.appendChild(head);
      win.appendChild(body);
      win.appendChild(rh);

      stage.appendChild(win);
      wireMultiboxWindow(win);
      updateMultiboxEmptyState();
      updateMainVisualFromDom();
      removeBtnEl.setAttribute('aria-label', t('multibox.removeClient'));
      removeBtnEl.setAttribute('title', t('multibox.removeClient'));
    }

    function ensureMultiboxClientCount(target) {
      var cur = getSortedMultiboxWindows();
      while (cur.length < target) {
        addMultiboxClient();
        cur = getSortedMultiboxWindows();
      }
      while (cur.length > target) {
        cur[cur.length - 1].remove();
        cur = getSortedMultiboxWindows();
      }
      updateMultiboxEmptyState();
      refreshMultiboxClientTitles();
    }

    /**
     * KronkBoxer-inspired tiles: lowest index = main (large top-right strip), next two = left stack,
     * remainder across the bottom edge (similar to tiled multibox tools).
     */
    function applyMultiboxPreset(total) {
      if (total !== 4 && total !== 6 && total !== 8) return;
      var PAD = 10;
      var G = 8;
      var innerW = stage.clientWidth - 2 * PAD;
      var innerH = stage.clientHeight - 2 * PAD;
      if (innerW < 200 || innerH < 120) return;

      ensureMultiboxClientCount(total);
      var sorted = getSortedMultiboxWindows();
      if (sorted.length !== total) return;

      function place(i, left, top, w, h) {
        setWinGeom(sorted[i], { left: left, top: top, width: w, height: h });
      }

      /** Left column narrow strip + main occupying the remainder of the upper band */
      function kronkTopBand(bhPx) {
        var bhFinal = Math.max(MIN_H, Math.min(innerH - MIN_H - G, bhPx));
        var th = innerH - bhFinal - G;
        var lwBase = innerW * 0.235;
        var lw = Math.max(MIN_W, Math.round(lwBase));
        lw = Math.min(lw, Math.floor(innerW * 0.34));
        var mw = innerW - lw - G;
        if (mw < MIN_W || th < MIN_H + G + MIN_H) return null;
        return { lw: lw, mw: mw, th: th, bh: bhFinal };
      }

      if (total === 4) {
        var bd4 = kronkTopBand(Math.max(MIN_H, Math.round(innerH * 0.26)));
        if (!bd4) return;
        var hl = (bd4.th - G) / 2;
        hl = Math.max(MIN_H, hl);
        place(
          1,
          PAD,
          PAD,
          bd4.lw,
          hl,
        );
        place(
          2,
          PAD,
          PAD + hl + G,
          bd4.lw,
          Math.max(MIN_H, bd4.th - hl - G),
        );
        place(0, PAD + bd4.lw + G, PAD, bd4.mw, bd4.th);
        place(3, PAD, PAD + bd4.th + G, innerW, bd4.bh);
      } else if (total === 6) {
        var bd6 = kronkTopBand(Math.max(MIN_H, Math.round(innerH * 0.295)));
        if (!bd6) return;
        var hLeft = (bd6.th - G) / 2;
        hLeft = Math.max(MIN_H, hLeft);
        var hLeft2 = Math.max(MIN_H, bd6.th - hLeft - G);
        place(1, PAD, PAD, bd6.lw, hLeft);
        place(2, PAD, PAD + hLeft + G, bd6.lw, hLeft2);
        place(0, PAD + bd6.lw + G, PAD, bd6.mw, bd6.th);
        var bw3 = (innerW - 2 * G) / 3;
        bw3 = Math.max(MIN_W, bw3);
        var yBt = PAD + bd6.th + G;
        place(3, PAD, yBt, bw3, bd6.bh);
        place(4, PAD + bw3 + G, yBt, bw3, bd6.bh);
        place(5, PAD + 2 * (bw3 + G), yBt, bw3, bd6.bh);
      } else {
        /* total === 8: two stacked left + wide main + five along the bottom */
        var bd8 = kronkTopBand(Math.max(MIN_H, Math.round(innerH * 0.26)));
        if (!bd8) return;
        var hL = (bd8.th - G) / 2;
        hL = Math.max(MIN_H, hL);
        var hL2 = Math.max(MIN_H, bd8.th - hL - G);
        place(1, PAD, PAD, bd8.lw, hL);
        place(2, PAD, PAD + hL + G, bd8.lw, hL2);
        place(0, PAD + bd8.lw + G, PAD, bd8.mw, bd8.th);
        var bw5 = (innerW - 4 * G) / 5;
        bw5 = Math.max(MIN_W, bw5);
        var yBt8 = PAD + bd8.th + G;
        for (var b = 0; b < 5; b += 1) {
          place(3 + b, PAD + b * (bw5 + G), yBt8, bw5, bd8.bh);
        }
      }

      updateMainVisualFromDom(sorted);
    }

    var addBtnEl = document.getElementById('multibox-add-client');
    if (addBtnEl) {
      addBtnEl.addEventListener('click', function () {
        addMultiboxClient();
      });
    }

    document.querySelectorAll('#tab-multibox [data-multibox-preset]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var n = parseInt(btn.getAttribute('data-multibox-preset'), 10);
        requestAnimationFrame(function () {
          if (n === 4 || n === 6 || n === 8) applyMultiboxPreset(n);
        });
      });
    });

    stage.querySelectorAll('.multibox-window').forEach(function (w) {
      wireMultiboxWindow(w);
    });
    updateMultiboxEmptyState();
    updateMainVisualFromDom();

    window.addEventListener('resize', function () {
      stage.querySelectorAll('.multibox-window').forEach(clamp);
    });
  }

  document.getElementById('content-tabs').addEventListener('click', (e) => {
    const btn = e.target.closest('.content-tab');
    if (!btn) return;

    const tabName = btn.dataset.tab;
    if (tabName === activeTab) return;

    const prevTab = activeTab;
    if (prevTab === 'mem-helper' && memHelperPollTimer) {
      clearInterval(memHelperPollTimer);
      memHelperPollTimer = null;
    }
    if (prevTab === 'nearby') stopNearbyPolling();
    if (prevTab === 'damage' && tabName !== 'damage') closeDamagePlayerModal();
    closeSettingsPopout();

    document.querySelectorAll('.content-tab').forEach(t => t.classList.remove('active'));
    btn.classList.add('active');

    document.querySelectorAll('.tab-panel').forEach(p => {
      p.style.display = 'none';
      p.classList.remove('active');
    });
    const panel = document.getElementById('tab-' + tabName);
    if (panel) {
      panel.style.display = '';
      panel.classList.add('active');
    }

    activeTab = tabName;
    // Track tab view for the funnel breakdown.
    trackEvent('tab_view', { tab: String(tabName) });
    if (tabName === 'api') {
      requestAnimationFrame(function () {
        var fr = document.querySelector('#tab-api .api-docs-iframe');
        if (fr && fr.contentWindow && fr.contentWindow.hljs) {
          try {
            fr.contentWindow.hljs.highlightAll();
          } catch (err) {
            /* ignore */
          }
        }
      });
    }
    if (tabName === 'home') renderHomeTab();
    if (tabName === 'premium') renderPremiumTab();
    if (tabName === 'settings') refreshSettingsTab();
    if (tabName === 'accounts') renderAccountsTab();
    if (tabName === 'damage') renderDamageTab();
    if (tabName === 'logs') refreshLogsEmptyState();
    if (tabName === 'telemetry') openTelemetryTab();
    if (tabName === 'objects') renderObjectsTree(lastObjectsData);
    if (tabName === 'tilemap') {
      renderTilemapTree(lastTilesData);
      requestTilemap();
    }
    if (tabName === 'game-wiki') {
      openGameWikiTab();
    }
    if (tabName === 'nearby') {
      renderNearbyPlayersTab();
      renderNearbyPlayerDebug();
      startNearbyPolling();
    }
    if (tabName === 'multibox') {
      initMultiboxPlaceholderStage();
    }
    if (tabName === 'mem-helper') {
      wireMemHelperTabOnce();
      refreshMemHelperExaltUi();
      if (memHelperPollTimer) clearInterval(memHelperPollTimer);
      memHelperPollTimer = setInterval(refreshMemHelperExaltUi, 2500);
    }
    if (tabName === 'packet-lab') {
      syncLabPacketToolbarVisibility();
      if (!labDefinitions) {
        fetch('/api/lab/definitions').then(r => r.json()).then(function (data) {
          labDefinitions = data;
          renderLabDefinedList('working');
          renderLabDefinedList('need-work');
        }).catch(function () {
          if (document.getElementById('lab-defined-list-working')) {
            document.getElementById('lab-defined-list-working').innerHTML = '<div class="lab-empty">Failed to load definitions.</div>';
          }
          if (document.getElementById('lab-defined-list-need-work')) {
            document.getElementById('lab-defined-list-need-work').innerHTML = '<div class="lab-empty">Failed to load definitions.</div>';
          }
        });
      } else {
        renderLabDefinedList('working');
        renderLabDefinedList('need-work');
      }
      fetch('/api/lab/unknowns').then(r => r.json()).then(data => {
        handleLabUpdate(data);
      }).catch(() => {});
      if (labSubtab === 'byte-tool') renderLabByteGrid();
    }
    if (tabName === 'scripts') {
      wireScriptsPageControls();
      refreshScriptsTab();
    }
    if (tabName === 'market') {
      loadMarketTab();
    }
    if (tabName === 'plugins') {
      // Render immediately from cached data (shows spinner if not yet received)
      renderPlugins(Array.isArray(allPluginsData) ? allPluginsData : []);
      // Always fetch fresh data in background
      fetch('/api/plugins')
        .then(function (r) {
          if (!r.ok) throw new Error('bad status');
          return r.json();
        })
        .then(function (data) {
          var pl = Array.isArray(data) ? data : [];
          if (pl.length > 0) pluginsReceived = true;
          allPluginsData = pl;
          renderPlugins(pl);
          populateServerSelect(pl);
          renderDamageSettings(pl);
        })
        .catch(function () {});
    }
  });

  // ─── Market tab (GET /api/market/catalog, POST /api/market/checkout) ──
  var marketCatalog = null;
  var marketSubtab = 'scripts';
  var marketScriptCat = 'All';
  var marketScriptSort = 'Recommended';
  var marketScriptPrice = 'Any';
  var marketScriptSearch = '';
  /** @type {{ id: string, type: string, name: string, detail: string, priceGems: number }[]} */
  var marketCart = [];
  /** dupe id -> tier index */
  var marketDupeTier = {};
  /** pot id -> quantity (for maxing shop) */
  var marketMaxingQtys = {};
  var marketKeySel = { tierIdx: 0, tenStar: false };

  function normalizeMarketCatalog(data) {
    var d = data || {};
    return {
      scripts: Array.isArray(d.scripts) ? d.scripts : [],
      dupes: Array.isArray(d.dupes) ? d.dupes : [],
      items: Array.isArray(d.items) ? d.items : [],
      keyTiers: Array.isArray(d.keyTiers) && d.keyTiers.length ? d.keyTiers : [{ qty: 10, priceGems: 40 }],
      key10StarSurcharge: typeof d.key10StarSurcharge === 'number' ? d.key10StarSurcharge : 0.4,
      scriptCategories: Array.isArray(d.scriptCategories) ? d.scriptCategories : ['All'],
      sortOptions: Array.isArray(d.sortOptions) ? d.sortOptions : ['Recommended'],
      priceOptions: Array.isArray(d.priceOptions) ? d.priceOptions : ['Any'],
    };
  }

  /** % saved vs lowest-qty tier (per-unit), from catalog prices */
  function marketBulkDiscountPctRaw(baseTier, tier) {
    if (!baseTier || !tier || !baseTier.qty || !tier.qty) return 0;
    var baseUnit = baseTier.priceGems / baseTier.qty;
    if (baseUnit <= 0) return 0;
    var unit = tier.priceGems / tier.qty;
    if (unit >= baseUnit - 1e-9) return 0;
    return Math.min(100, Math.max(0, Math.round((1 - unit / baseUnit) * 100)));
  }

  function marketDupeTierDiscountPct(item, tierIdx) {
    var tiers = item.tiers || [];
    if (tiers.length < 2 || tierIdx < 1) return 0;
    return marketBulkDiscountPctRaw(tiers[0], tiers[tierIdx]);
  }

  function marketKeyTierDiscountPct(keyTiers, tierIdx) {
    if (!keyTiers || keyTiers.length < 2 || tierIdx < 1) return 0;
    return marketBulkDiscountPctRaw(keyTiers[0], keyTiers[tierIdx]);
  }

  function loadMarketTab() {
    var loadEl = document.getElementById('market-loading');
    var errEl = document.getElementById('market-error');
    var contentEl = document.getElementById('market-content');
    if (!loadEl || !contentEl) return;
    if (marketCatalog) {
      loadEl.style.display = 'none';
      if (errEl) errEl.style.display = 'none';
      contentEl.style.display = '';
      renderMarketFull();
      return;
    }
    loadEl.style.display = '';
    if (errEl) errEl.style.display = 'none';
    contentEl.style.display = 'none';
    fetch('/api/market/catalog')
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      })
      .then(function (data) {
        marketCatalog = normalizeMarketCatalog(data);
        loadEl.style.display = 'none';
        if (errEl) errEl.style.display = 'none';
        contentEl.style.display = '';
        (marketCatalog.dupes || []).forEach(function (d) {
          if (marketDupeTier[d.id] == null) marketDupeTier[d.id] = 0;
          if (marketMaxingQtys[d.id] == null) marketMaxingQtys[d.id] = 0;
        });
        renderMarketFull();
      })
      .catch(function (e) {
        loadEl.style.display = 'none';
        if (errEl) {
          errEl.style.display = '';
          errEl.textContent = 'Could not load catalog. ' + (e && e.message ? e.message : '');
        }
        contentEl.style.display = 'none';
      });
  }

  function marketCartTotal() {
    return marketCart.reduce(function (s, x) {
      return s + (Number(x.priceGems) || 0);
    }, 0);
  }

  function renderMarketCart() {
    var wrap = document.getElementById('market-cart-items');
    var countEl = document.getElementById('market-cart-count');
    var totalEl = document.getElementById('market-cart-total-gems');
    if (!wrap) return;
    if (countEl) countEl.textContent = String(marketCart.length);
    if (totalEl) totalEl.textContent = String(marketCartTotal());
    if (!marketCart.length) {
      wrap.innerHTML = '<div class="market-cart-line-meta" style="padding:8px;">Cart is empty.</div>';
      return;
    }
    wrap.innerHTML = marketCart
      .map(function (line) {
        return (
          '<div class="market-cart-line" data-cart-id="' +
          escapeHtml(line.id) +
          '">' +
          '<div><div style="font-weight:700;color:var(--text-dim);">' +
          escapeHtml(line.name) +
          '</div><div class="market-cart-line-meta">' +
          escapeHtml(line.detail) +
          ' · ' +
          escapeHtml(String(line.priceGems)) +
          'G</div></div>' +
          '<button type="button" class="market-cart-remove" data-cart-remove="' +
          escapeHtml(line.id) +
          '">×</button></div>'
        );
      })
      .join('');
  }

  function marketFilterSortScripts(scripts) {
    var list = scripts.slice();
    var q = (marketScriptSearch || '').trim().toLowerCase();
    if (q) {
      list = list.filter(function (s) {
        var blob = (
          String(s.name || '') +
          ' ' +
          String(s.author || '') +
          ' ' +
          String(s.description || '') +
          ' ' +
          String(s.category || '') +
          ' ' +
          (s.tags || []).join(' ')
        ).toLowerCase();
        return blob.indexOf(q) >= 0;
      });
    }
    if (marketScriptCat && marketScriptCat !== 'All') {
      list = list.filter(function (s) {
        return String(s.category || '') === marketScriptCat;
      });
    }
    if (marketScriptPrice === 'Free') {
      list = list.filter(function (s) {
        return s.tier === 'free';
      });
    } else if (marketScriptPrice === 'Included (Premium)') {
      list = list.filter(function (s) {
        return s.tier === 'premium';
      });
    } else if (marketScriptPrice === 'Gem Purchase') {
      list = list.filter(function (s) {
        return s.tier === 'instanced';
      });
    }
    function priceNum(s) {
      if (s.priceType === 'free') return 0;
      return Number(s.priceGems) || 0;
    }
    if (marketScriptSort === 'Price: High to Low') {
      list.sort(function (a, b) {
        return priceNum(b) - priceNum(a);
      });
    } else if (marketScriptSort === 'Price: Low to High') {
      list.sort(function (a, b) {
        return priceNum(a) - priceNum(b);
      });
    } else if (marketScriptSort === 'Most Recently Updated') {
      list.sort(function (a, b) {
        return String(b.updatedLabel || '').localeCompare(String(a.updatedLabel || ''));
      });
    } else if (marketScriptSort === 'Most Popular') {
      list.sort(function (a, b) {
        return (b.isFeatured ? 1 : 0) - (a.isFeatured ? 1 : 0) || b.id - a.id;
      });
    } else {
      list.sort(function (a, b) {
        var fs = (b.isFeatured ? 2 : 0) + (b.isNew ? 1 : 0) - ((a.isFeatured ? 2 : 0) + (a.isNew ? 1 : 0));
        if (fs !== 0) return fs;
        return a.id - b.id;
      });
    }
    return list;
  }

  var MARKET_SEARCH_ICON =
    '<svg class="market-script-search-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>';
  var MARKET_QS_ICON =
    '<svg class="market-qs-icon" width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M13 2L3 14h7l-1 8 10-12h-7l1-8z"/></svg>';

  function renderMarketToolbar() {
    var tb = document.getElementById('market-toolbar');
    if (!tb || !marketCatalog) return;
    if (marketSubtab !== 'scripts') {
      tb.innerHTML = '';
      return;
    }
    var cats = marketCatalog.scriptCategories || ['All'];
    var sorts = marketCatalog.sortOptions || ['Recommended'];
    var prices = marketCatalog.priceOptions || ['Any'];
    function opts(arr, cur) {
      return arr
        .map(function (o) {
          return (
            '<option value="' +
            escapeHtml(o) +
            '"' +
            (o === cur ? ' selected' : '') +
            '>' +
            escapeHtml(o) +
            '</option>'
          );
        })
        .join('');
    }
    var tagBtns = cats
      .map(function (cat) {
        var active = cat === marketScriptCat ? ' active' : '';
        return (
          '<button type="button" class="market-script-tag' +
          active +
          '" data-market-script-cat="' +
          escapeHtml(cat) +
          '">' +
          escapeHtml(cat) +
          '</button>'
        );
      })
      .join('');
    tb.innerHTML =
      '<div class="market-scripts-explore">' +
      '<div class="market-scripts-toprow">' +
      '<div class="market-script-search-wrap">' +
      MARKET_SEARCH_ICON +
      '<input type="search" id="market-script-search" class="market-script-search" placeholder="Search scripts..." autocomplete="off" value="' +
      escapeHtml(marketScriptSearch) +
      '">' +
      '</div>' +
      '<select id="market-select-sort" class="market-script-select" aria-label="Sort scripts">' +
      opts(sorts, marketScriptSort) +
      '</select>' +
      '<select id="market-select-price" class="market-script-select" aria-label="Filter by price">' +
      opts(prices, marketScriptPrice) +
      '</select>' +
      '</div>' +
      '<div class="market-scripts-tags" role="tablist" aria-label="Script categories">' +
      tagBtns +
      '</div></div>';
  }

  function renderMarketBody() {
    var body = document.getElementById('market-body');
    if (!body || !marketCatalog) return;
    if (marketSubtab === 'scripts') {
      var scripts = marketFilterSortScripts(marketCatalog.scripts || []);
      var n = scripts.length;
      var resultsBar =
        '<div class="market-scripts-results-bar">' +
        '<span class="market-scripts-count">Showing <strong>' +
        n +
        '</strong> script' +
        (n === 1 ? '' : 's') +
        '</span>' +
        '<div class="market-scripts-results-actions">' +
        '<button type="button" class="market-scripts-submit-btn" data-market-submit-script>Submit Script</button>' +
        '<button type="button" class="market-scripts-clear-link" data-market-scripts-clear>Clear filters <span class="market-scripts-clear-x" aria-hidden="true">×</span></button>' +
        '</div></div>';
      var paneInner =
        n === 0
          ? '<div class="market-scripts-empty">' +
            '<p class="market-scripts-empty-msg">No scripts match your filters.</p>' +
            '<button type="button" class="market-scripts-empty-clear" data-market-scripts-clear>Clear filters</button>' +
            '</div>'
          : '<div class="market-grid-scripts">' + scripts.map(marketScriptCardHtml).join('') + '</div>';
      body.innerHTML =
        resultsBar + '<div class="market-scripts-results-pane">' + paneInner + '</div>';
      return;
    }
    if (marketSubtab === 'maxing') {
      body.innerHTML = renderMarketMaxingBody();
      return;
    }
    body.innerHTML = '';
  }

  function marketScriptCardHtml(s) {
    var feat = s.isFeatured ? ' featured' : '';
    var tierClass = s.tier === 'free' ? ' free' : s.tier === 'premium' ? ' premium' : '';
    var priceBlock = '';
    if (s.priceType === 'free') {
      priceBlock = '<div class="market-script-price">0<span class="market-gem-label">G</span><span class="sub">Free</span></div>';
    } else if (s.priceType === 'monthly') {
      priceBlock =
        '<div class="market-script-price">' +
        escapeHtml(String(s.priceGems || 0)) +
        '<span class="market-gem-label">G</span><span class="sub">/mo</span>';
      if (s.perRunGems != null) {
        priceBlock +=
          '<span class="sub">or ' + escapeHtml(String(s.perRunGems)) + 'G/run</span>';
      }
      priceBlock += '</div>';
    } else if (s.priceType === 'per_run') {
      priceBlock =
        '<div class="market-script-price">' +
        escapeHtml(String(s.perRunGems || 0)) +
        '<span class="market-gem-label">G</span><span class="sub">/run</span></div>';
    }
    var tags = '';
    if (s.isNew) tags += '<span class="market-tag new">New</span>';
    if (s.isFeatured) tags += '<span class="market-tag featured">Featured</span>';
    return (
      '<div class="market-script-card' +
      feat +
      '" data-script-id="' +
      s.id +
      '">' +
      '<div class="market-script-left">' +
      '<div class="market-script-avatar">' +
      escapeHtml(String((s.name || '?')[0] || '?')) +
      '</div>' +
      '<span class="market-tier-badge' +
      tierClass +
      '">' +
      (s.tier === 'instanced' ? 'Gem Purchase' : s.tier === 'premium' ? 'Premium' : 'Free') +
      '</span>' +
      priceBlock +
      '</div><div class="market-script-right">' +
      '<h3 class="market-script-title">' +
      escapeHtml(s.name || '') +
      '</h3>' +
      '<div class="market-script-meta"><span>' +
      escapeHtml(s.author || '') +
      '</span><span>' +
      escapeHtml(s.updatedLabel || '') +
      '</span>' +
      '</div>' +
      (tags ? '<div class="market-script-tags">' + tags + '</div>' : '') +
      '<p class="market-script-desc">' +
      escapeHtml(s.description || '') +
      '</p>' +
      '<div class="market-script-actions">' +
      '<button type="button" class="setting-btn setting-btn-secondary" data-script-learn="' +
      s.id +
      '">Learn more</button>' +
      (s.priceType === 'free'
        ? '<button type="button" class="setting-btn" data-script-add="' + s.id + '">+ Add</button>'
        : '<button type="button" class="setting-btn setting-btn-secondary" data-script-try="' +
          s.id +
          '">Try</button><button type="button" class="setting-btn" data-script-buy="' +
          s.id +
          '">Buy</button>') +
      '</div></div></div>'
    );
  }

  function marketDupeCardHtml(item) {
    var ti = marketDupeTier[item.id] != null ? marketDupeTier[item.id] : 0;
    var tier = (item.tiers || [])[ti] || { qty: 1, priceGems: 0 };
    var tierBtns = (item.tiers || [])
      .map(function (t, i) {
        var disc = marketDupeTierDiscountPct(item, i);
        var pctHtml =
          disc > 0
            ? '<span class="market-dupe-tier-pct">−' + disc + '%</span>'
            : '<span class="market-dupe-tier-pct market-dupe-tier-pct-empty"></span>';
        return (
          '<button type="button" class="' +
          (i === ti ? 'active' : '') +
          '" data-dupe-tier="' +
          item.id +
          ':' +
          i +
          '">' +
          '<span class="market-dupe-tier-qty">' +
          t.qty +
          '</span>' +
          pctHtml +
          '</button>'
        );
      })
      .join('');
    var selDisc = marketDupeTierDiscountPct(item, ti);
    var savePill =
      selDisc > 0
        ? '<span class="market-dupe-save-pill">Save ' + selDisc + '%</span>'
        : '';
    return (
      '<div class="market-dupe-card" data-dupe-id="' +
      item.id +
      '">' +
      '<div class="market-dupe-head"><div class="market-dupe-icon">' +
      (item.icon || '📦') +
      '</div><div class="market-dupe-name">' +
      escapeHtml(item.name || '') +
      '</div></div>' +
      '<div class="market-dupe-tiers"><div class="market-dupe-tiers-label">Quantity <span class="market-dupe-tiers-hint">(up to 30% off at ×100)</span></div>' +
      '<div class="market-tier-btns">' +
      tierBtns +
      '</div></div>' +
      '<div class="market-dupe-foot"><div class="market-dupe-foot-price">' +
      '<div class="market-dupe-foot-price-row"><strong class="market-price-num">' +
      tier.priceGems +
      '</strong><span class="market-gem-label">G</span></div>' +
      savePill +
      '</div>' +
      '<button type="button" class="setting-btn market-dupe-buy-btn" data-dupe-add="' +
      item.id +
      '">Buy ×' +
      tier.qty +
      '</button></div></div>'
    );
  }

  function marketItemTileHtml(it) {
    var r = String(it.rarity || 'common');
    return (
      '<div class="market-item-tile rarity-' +
      escapeHtml(r) +
      '" data-item-id="' +
      it.id +
      '">' +
      '<div class="market-item-hero rarity-' +
      escapeHtml(r) +
      '">' +
      (it.isNew ? '<span class="market-item-new">NEW</span>' : '') +
      '<span>' +
      escapeHtml(String((it.name || '?')[0] || '?')) +
      '</span></div>' +
      '<div class="market-item-body">' +
      '<p class="market-item-name">' +
      escapeHtml(it.name || '') +
      '</p>' +
      '<div class="market-item-row"><span class="rarity-' +
      escapeHtml(r) +
      '" style="text-transform:capitalize;font-weight:700;font-size:10px;">' +
      escapeHtml(r) +
      '</span>' +
      (it.stat
        ? '<span style="color:var(--accent);font-size:10px;font-weight:600;">' +
          escapeHtml(it.stat) +
          '</span>'
        : '') +
      '</div>' +
      '<div class="market-item-row"><strong class="market-price-num">' +
      it.priceGems +
      '</strong><span class="market-gem-label">G</span>' +
      '<span style="color:var(--text-muted);font-size:10px;">' +
      escapeHtml(it.itemType || '') +
      '</span></div></div></div>'
    );
  }

  function marketAccountsPanelHtml() {
    var tiers = marketCatalog.keyTiers || [];
    var ti = marketKeySel.tierIdx;
    if (ti < 0 || ti >= tiers.length) ti = 0;
    var t = tiers[ti] || { qty: 0, priceGems: 0 };
    var base = t.priceGems || 0;
    var mult = marketKeySel.tenStar ? 1 + (marketCatalog.key10StarSurcharge || 0) : 1;
    var finalPrice = Math.round(base * mult);
    var kDiscSel = marketKeyTierDiscountPct(tiers, ti);
    var tierBtns = tiers
      .map(function (kt, i) {
        var kd = marketKeyTierDiscountPct(tiers, i);
        var pctLine =
          kd > 0
            ? '<span class="market-key-tier-pct">−' + kd + '%</span>'
            : '<span class="market-key-tier-pct market-key-tier-pct-empty"></span>';
        return (
          '<button type="button" class="' +
          (i === ti ? 'active' : '') +
          '" data-key-tier-idx="' +
          i +
          '"><span class="market-key-tier-main">' +
          kt.qty +
          ' keys · ' +
          kt.priceGems +
          'G</span>' +
          pctLine +
          '</button>'
        );
      })
      .join('');
    var keySavePill =
      kDiscSel > 0
        ? '<span class="market-key-save-pill">Save ' + kDiscSel + '%</span>'
        : '';
    return (
      '<div class="market-accounts-panel">' +
      '<h3>Key orders</h3>' +
      '<p>Bundle size and optional 10★ account surcharge. Larger bundles save up to <strong class="market-key-max-save">35%</strong>. Server will validate on checkout.</p>' +
      '<div class="market-key-tiers">' +
      tierBtns +
      '</div>' +
      '<div class="market-key-options">' +
      '<label class="market-key-toggle-row">' +
      '<span class="market-key-toggle-text">10★ accounts (+' +
      Math.round((marketCatalog.key10StarSurcharge || 0) * 100) +
      '%)</span>' +
      '<span class="toggle-switch market-key-toggle">' +
      '<input type="checkbox" id="market-key-10star"' +
      (marketKeySel.tenStar ? ' checked' : '') +
      ' />' +
      '<span class="toggle-slider"></span></span></label></div>' +
      '<div class="market-key-price-row">' +
      '<div class="market-key-price-wrap">' +
      '<div class="market-key-price">' +
      finalPrice +
      '<span class="market-gem-label">G</span> <span class="market-key-price-sub">(' +
      t.qty +
      ' keys)</span></div>' +
      keySavePill +
      '</div>' +
      '<button type="button" class="setting-btn market-key-add-btn" data-key-add="1">Add</button></div></div>'
    );
  }

  function maxingBestTier(item, qty) {
    var tiers = item.tiers || [];
    if (!tiers.length) return { qty: 1, priceGems: 0 };
    var best = tiers[0];
    for (var i = 1; i < tiers.length; i++) {
      if (tiers[i].qty <= qty) best = tiers[i];
    }
    return best;
  }

  function maxingSubtotal(item, qty) {
    if (qty <= 0) return 0;
    var t = maxingBestTier(item, qty);
    return Math.round(qty * (t.priceGems / t.qty));
  }

  function maxingDiscount(item, qty) {
    var tiers = item.tiers || [];
    if (tiers.length < 2 || qty < 1) return 0;
    var base = tiers[0];
    var best = maxingBestTier(item, qty);
    if (best === base || best.qty === base.qty) return 0;
    return Math.round((1 - (best.priceGems / best.qty) / (base.priceGems / base.qty)) * 100);
  }

  function maxingPotIconHtml(item) {
    if (item.objectType != null) {
      return buildItemSpriteHtml(
        { objectType: item.objectType, name: item.name, objectTypeHex: '0x' + Number(item.objectType).toString(16) },
        'market-maxing-pot-sprite',
        null,
        'strict'
      );
    }
    return '<span class="market-maxing-icon">' + escapeHtml(item.icon || '💊') + '</span>';
  }

  function renderMarketMaxingBody() {
    var pots = marketCatalog ? (marketCatalog.dupes || []) : [];
    var grandTotal = 0;
    var rows = pots.map(function (item) {
      var qty = marketMaxingQtys[item.id] || 0;
      var sub = maxingSubtotal(item, qty);
      var disc = maxingDiscount(item, qty);
      var basePrice = ((item.tiers || [])[0] || { priceGems: 0 }).priceGems;
      grandTotal += sub;
      return (
        '<div class="market-maxing-row" data-pot-id="' + item.id + '">' +
        maxingPotIconHtml(item) +
        '<span class="market-maxing-name">' + escapeHtml(item.name || '') + '</span>' +
        '<span class="market-maxing-unit">' + basePrice + 'G ea' +
          '<span class="market-maxing-disc"' + (disc > 0 ? '' : ' style="display:none"') + '>−' + disc + '%</span>' +
        '</span>' +
        '<div class="market-maxing-stepper">' +
          '<button type="button" data-maxing-dec="' + item.id + '">−</button>' +
          '<input type="number" min="0" max="9999" value="' + qty + '" data-maxing-input="' + item.id + '">' +
          '<button type="button" data-maxing-inc="' + item.id + '">+</button>' +
        '</div>' +
        '<span class="market-maxing-subtotal' + (qty <= 0 ? ' market-maxing-subtotal-dim' : '') + '">' +
          (qty > 0 ? sub + 'G' : '—') +
        '</span>' +
        '</div>'
      );
    }).join('');

    return (
      '<div class="market-maxing-panel">' +
      '<div class="market-maxing-header">' +
        '<span class="market-maxing-preset-label">Quick fill</span>' +
        '<div class="market-maxing-presets">' +
          '<button type="button" class="market-maxing-preset-btn" data-maxing-preset="10">×10 each</button>' +
          '<button type="button" class="market-maxing-preset-btn" data-maxing-preset="45">×45 each</button>' +
          '<button type="button" class="market-maxing-preset-btn market-maxing-clear-btn" data-maxing-preset="0">Clear</button>' +
        '</div>' +
      '</div>' +
      '<div class="market-maxing-list">' + rows + '</div>' +
      '<div class="market-maxing-footer">' +
        '<span class="market-maxing-footer-label">Total</span>' +
        '<span class="market-maxing-footer-total">' + (grandTotal > 0 ? grandTotal + 'G' : '—') + '</span>' +
        '<button type="button" class="setting-btn market-maxing-add-btn"' +
          (grandTotal === 0 ? ' disabled' : '') + ' data-maxing-add-all>Add to Cart</button>' +
      '</div>' +
      '</div>'
    );
  }

  function refreshMaxingTotals() {
    if (!marketCatalog || marketSubtab !== 'maxing') return;
    var pots = marketCatalog.dupes || [];
    var grandTotal = 0;
    pots.forEach(function (item) {
      var qty = marketMaxingQtys[item.id] || 0;
      var sub = maxingSubtotal(item, qty);
      var disc = maxingDiscount(item, qty);
      grandTotal += sub;
      var row = document.querySelector('.market-maxing-row[data-pot-id="' + item.id + '"]');
      if (!row) return;
      var subEl = row.querySelector('.market-maxing-subtotal');
      if (subEl) {
        subEl.textContent = qty > 0 ? sub + 'G' : '—';
        subEl.classList.toggle('market-maxing-subtotal-dim', qty <= 0);
      }
      var discEl = row.querySelector('.market-maxing-disc');
      if (discEl) {
        discEl.textContent = disc > 0 ? '−' + disc + '%' : '';
        discEl.style.display = disc > 0 ? '' : 'none';
      }
    });
    var totalEl = document.querySelector('.market-maxing-footer-total');
    if (totalEl) totalEl.textContent = grandTotal > 0 ? grandTotal + 'G' : '—';
    var addBtn = document.querySelector('[data-maxing-add-all]');
    if (addBtn) addBtn.disabled = grandTotal === 0;
  }

  function renderMarketFull() {
    renderMarketToolbar();
    renderMarketBody();
    renderMarketCart();
    syncMarketNavActive();
  }

  function syncMarketNavActive() {
    var nav = document.getElementById('market-nav');
    if (!nav) return;
    nav.querySelectorAll('.market-nav-btn').forEach(function (btn) {
      btn.classList.toggle('active', btn.getAttribute('data-market-sub') === marketSubtab);
    });
  }

  function findScriptById(id) {
    return (marketCatalog.scripts || []).find(function (s) {
      return s.id === id;
    });
  }

  function closeMarketScriptBuyModal() {
    var modal = document.getElementById('market-script-buy-modal');
    if (!modal) return;
    modal.style.display = 'none';
    modal.setAttribute('aria-hidden', 'true');
    var actions = document.getElementById('market-script-buy-modal-actions');
    if (actions) actions.innerHTML = '';
  }

  function pushScriptCartLine(script, detail, priceGems) {
    marketCart.push({
      id: 'script-' + script.id + '-' + Date.now(),
      type: 'script',
      name: script.name,
      detail: detail,
      priceGems: priceGems,
    });
    renderMarketCart();
  }

  function openMarketScriptBuyModal(script) {
    var modal = document.getElementById('market-script-buy-modal');
    var titleEl = document.getElementById('market-script-buy-modal-title');
    var actionsEl = document.getElementById('market-script-buy-modal-actions');
    if (!modal || !titleEl || !actionsEl) return;

    titleEl.textContent = script.name || 'Purchase';

    if (script.priceType === 'monthly' && script.altPriceGems != null) {
      var mo = script.priceGems || 0;
      var once = script.altPriceGems;
      actionsEl.innerHTML =
        '<button type="button" class="setting-btn market-modal-choice" data-script-billing-choice="monthly" data-script-billing-id="' +
        script.id +
        '">Monthly — ' +
        mo +
        'G<span class="market-modal-choice-sub">/mo</span></button>' +
        '<button type="button" class="setting-btn market-modal-choice" data-script-billing-choice="once" data-script-billing-id="' +
        script.id +
        '">One-time — ' +
        once +
        'G</button>';
    } else {
      actionsEl.innerHTML = '';
    }

    modal.style.display = '';
    modal.setAttribute('aria-hidden', 'false');
  }

  function marketTabClickHandler(ev) {
    var t = ev.target;
    if (!t || !t.closest) return;
    var navBtn = t.closest('.market-nav-btn');
    if (navBtn && navBtn.getAttribute('data-market-sub')) {
      marketSubtab = navBtn.getAttribute('data-market-sub');
      renderMarketFull();
      return;
    }
    var scriptPill = t.closest('[data-market-script-cat]');
    if (scriptPill && marketCatalog && marketSubtab === 'scripts') {
      marketScriptCat = scriptPill.getAttribute('data-market-script-cat') || 'All';
      var mtb = document.getElementById('market-toolbar');
      if (mtb) {
        mtb.querySelectorAll('.market-script-tag').forEach(function (b) {
          b.classList.toggle('active', b.getAttribute('data-market-script-cat') === marketScriptCat);
        });
      }
      renderMarketBody();
      return;
    }
    if (t.closest('[data-market-scripts-clear]') && marketSubtab === 'scripts') {
      marketScriptSearch = '';
      marketScriptCat = 'All';
      marketScriptSort = 'Recommended';
      marketScriptPrice = 'Any';
      renderMarketToolbar();
      renderMarketBody();
      return;
    }
    if (t.closest('[data-market-submit-script]') && marketSubtab === 'scripts') {
      openMarketSubmitScriptModal();
      return;
    }
    var rm = t.closest('[data-cart-remove]');
    if (rm) {
      var cid = rm.getAttribute('data-cart-remove');
      marketCart = marketCart.filter(function (x) {
        return x.id !== cid;
      });
      renderMarketCart();
      return;
    }
    var sid = t.closest('[data-script-learn]');
    if (sid) {
      var s1 = findScriptById(parseInt(sid.getAttribute('data-script-learn'), 10));
      if (s1) window.alert(s1.name + '\n\n' + (s1.description || ''));
      return;
    }
    var tryB = t.closest('[data-script-try]');
    if (tryB) {
      window.alert('Try flow will open when your server implements it.');
      return;
    }
    var addB = t.closest('[data-script-add]');
    if (addB && marketCatalog) {
      var s2 = findScriptById(parseInt(addB.getAttribute('data-script-add'), 10));
      if (s2 && s2.priceType === 'free') {
        marketCart.push({
          id: 'script-' + s2.id + '-' + Date.now(),
          type: 'script',
          name: s2.name,
          detail: 'Free script',
          priceGems: 0,
        });
        renderMarketCart();
      }
      return;
    }
    var billingChoice = t.closest('[data-script-billing-choice]');
    if (billingChoice && marketCatalog) {
      var bid = parseInt(billingChoice.getAttribute('data-script-billing-id'), 10);
      var mode = billingChoice.getAttribute('data-script-billing-choice');
      var sb = findScriptById(bid);
      if (sb) {
        if (mode === 'monthly') {
          pushScriptCartLine(sb, 'Monthly', sb.priceGems || 0);
        } else if (mode === 'once' && sb.altPriceGems != null) {
          pushScriptCartLine(sb, 'One-time', sb.altPriceGems);
        }
      }
      closeMarketScriptBuyModal();
      return;
    }

    var modalClose = t.closest('[data-market-modal-close]');
    if (modalClose) {
      closeMarketScriptBuyModal();
      return;
    }

    var buyB = t.closest('[data-script-buy]');
    if (buyB && marketCatalog) {
      var s3 = findScriptById(parseInt(buyB.getAttribute('data-script-buy'), 10));
      if (s3) {
        if (s3.priceType === 'monthly' && s3.altPriceGems != null) {
          openMarketScriptBuyModal(s3);
        } else if (s3.priceType === 'monthly') {
          pushScriptCartLine(s3, 'Monthly', s3.priceGems || 0);
        } else {
          pushScriptCartLine(s3, 'One-time', s3.priceGems || 0);
        }
      }
      return;
    }
    var maxDec = t.closest('[data-maxing-dec]');
    if (maxDec) {
      var mdId = parseInt(maxDec.getAttribute('data-maxing-dec'), 10);
      marketMaxingQtys[mdId] = Math.max(0, (marketMaxingQtys[mdId] || 0) - 1);
      var mdInp = document.querySelector('[data-maxing-input="' + mdId + '"]');
      if (mdInp) mdInp.value = marketMaxingQtys[mdId];
      refreshMaxingTotals();
      return;
    }
    var maxInc = t.closest('[data-maxing-inc]');
    if (maxInc) {
      var miId = parseInt(maxInc.getAttribute('data-maxing-inc'), 10);
      marketMaxingQtys[miId] = Math.min(9999, (marketMaxingQtys[miId] || 0) + 1);
      var miInp = document.querySelector('[data-maxing-input="' + miId + '"]');
      if (miInp) miInp.value = marketMaxingQtys[miId];
      refreshMaxingTotals();
      return;
    }
    var maxPreset = t.closest('[data-maxing-preset]');
    if (maxPreset && marketCatalog) {
      var mpQty = parseInt(maxPreset.getAttribute('data-maxing-preset'), 10);
      (marketCatalog.dupes || []).forEach(function (item) {
        marketMaxingQtys[item.id] = mpQty;
        var mpInp = document.querySelector('[data-maxing-input="' + item.id + '"]');
        if (mpInp) mpInp.value = mpQty;
      });
      refreshMaxingTotals();
      return;
    }
    var maxAdd = t.closest('[data-maxing-add-all]');
    if (maxAdd && marketCatalog) {
      (marketCatalog.dupes || []).forEach(function (item) {
        var qty = marketMaxingQtys[item.id] || 0;
        if (qty <= 0) return;
        var sub = maxingSubtotal(item, qty);
        marketCart.push({
          id: 'maxing-' + item.id + '-' + Date.now() + Math.random(),
          type: 'maxing',
          name: item.name,
          detail: '×' + qty,
          priceGems: sub,
        });
      });
      renderMarketCart();
      return;
    }
    var tierB = t.closest('[data-dupe-tier]');
    if (tierB) {
      var parts = (tierB.getAttribute('data-dupe-tier') || '').split(':');
      var did = parseInt(parts[0], 10);
      var idx = parseInt(parts[1], 10);
      if (!isNaN(did) && !isNaN(idx)) {
        marketDupeTier[did] = idx;
        renderMarketBody();
        renderMarketCart();
      }
      return;
    }
    var dupeAdd = t.closest('[data-dupe-add]');
    if (dupeAdd && marketCatalog) {
      var dupeId = parseInt(dupeAdd.getAttribute('data-dupe-add'), 10);
      var dupe = (marketCatalog.dupes || []).find(function (d) {
        return d.id === dupeId;
      });
      if (dupe) {
        var dti = marketDupeTier[dupe.id] != null ? marketDupeTier[dupe.id] : 0;
        var dt = (dupe.tiers || [])[dti];
        if (dt) {
          marketCart.push({
            id: 'dupe-' + dupe.id + '-' + dt.qty + '-' + Date.now(),
            type: 'dupe',
            name: dupe.name,
            detail: '×' + dt.qty,
            priceGems: dt.priceGems,
          });
          renderMarketCart();
        }
      }
      return;
    }
    var itemEl = t.closest('[data-item-id]');
    if (itemEl && marketCatalog) {
      var iid = parseInt(itemEl.getAttribute('data-item-id'), 10);
      var it = (marketCatalog.items || []).find(function (x) {
        return x.id === iid;
      });
      if (it) {
        marketCart.push({
          id: 'item-' + it.id + '-' + Date.now(),
          type: 'item',
          name: it.name,
          detail: it.seller || '',
          priceGems: it.priceGems || 0,
        });
        renderMarketCart();
      }
      return;
    }
    var kt = t.closest('[data-key-tier-idx]');
    if (kt) {
      marketKeySel.tierIdx = parseInt(kt.getAttribute('data-key-tier-idx'), 10);
      renderMarketBody();
      return;
    }
    var keyAdd = t.closest('[data-key-add]');
    if (keyAdd && marketCatalog) {
      var tiers2 = marketCatalog.keyTiers || [];
      var tix = marketKeySel.tierIdx;
      if (tix < 0 || tix >= tiers2.length) tix = 0;
      var tk = tiers2[tix];
      var b = tk.priceGems || 0;
      var m = marketKeySel.tenStar ? 1 + (marketCatalog.key10StarSurcharge || 0) : 1;
      var fp = Math.round(b * m);
      marketCart.push({
        id: 'keys-' + tk.qty + '-' + Date.now(),
        type: 'order',
        name: 'Key order (' + tk.qty + ' keys)',
        detail: marketKeySel.tenStar ? '10★ surcharge' : 'Standard',
        priceGems: fp,
      });
      renderMarketCart();
      return;
    }
  }

  function marketTabChangeHandler(ev) {
    var tg = ev.target;
    if (tg && tg.id === 'market-select-sort') {
      marketScriptSort = tg.value;
      renderMarketBody();
    } else if (tg && tg.id === 'market-select-price') {
      marketScriptPrice = tg.value;
      renderMarketBody();
    } else if (tg && tg.id === 'market-key-10star') {
      marketKeySel.tenStar = !!tg.checked;
      renderMarketBody();
    }
  }

  var marketTabEl = document.getElementById('tab-market');
  if (marketTabEl) {
    marketTabEl.addEventListener('click', marketTabClickHandler);
    marketTabEl.addEventListener('change', marketTabChangeHandler);
    marketTabEl.addEventListener('input', function (ev) {
      var tg = ev.target;
      if (tg && tg.id === 'market-script-search' && marketSubtab === 'scripts') {
        marketScriptSearch = tg.value || '';
        renderMarketBody();
      }
      var mqi = tg && tg.getAttribute && tg.getAttribute('data-maxing-input');
      if (mqi && marketSubtab === 'maxing') {
        var mqv = parseInt(tg.value, 10);
        if (isNaN(mqv) || mqv < 0) mqv = 0;
        if (mqv > 9999) mqv = 9999;
        marketMaxingQtys[parseInt(mqi, 10)] = mqv;
        refreshMaxingTotals();
      }
    });
  }

  var marketSubmitScriptOverlay = document.getElementById('market-submit-script-overlay');

  function openMarketSubmitScriptModal() {
    if (!marketSubmitScriptOverlay) return;
    if (typeof closeMarketScriptBuyModal === 'function') closeMarketScriptBuyModal();
    marketSubmitScriptOverlay.classList.remove('hidden');
    var n = document.getElementById('market-submit-script-name');
    if (n) {
      setTimeout(function () {
        n.focus();
      }, 30);
    }
  }

  function closeMarketSubmitScriptModal() {
    if (!marketSubmitScriptOverlay) return;
    marketSubmitScriptOverlay.classList.add('hidden');
    var f = document.getElementById('market-submit-script-form');
    if (f) f.reset();
    var fn = document.getElementById('market-submit-script-filename');
    if (fn) fn.textContent = 'No file chosen';
  }

  if (marketSubmitScriptOverlay) {
    marketSubmitScriptOverlay.addEventListener('click', function (e) {
      if (e.target === marketSubmitScriptOverlay) closeMarketSubmitScriptModal();
    });
  }

  var marketSubmitScriptX = document.getElementById('market-submit-script-x');
  var marketSubmitScriptCancel = document.getElementById('market-submit-script-cancel');
  if (marketSubmitScriptX) marketSubmitScriptX.addEventListener('click', closeMarketSubmitScriptModal);
  if (marketSubmitScriptCancel) marketSubmitScriptCancel.addEventListener('click', closeMarketSubmitScriptModal);

  var marketSubmitScriptFile = document.getElementById('market-submit-script-file');
  var marketSubmitScriptFilename = document.getElementById('market-submit-script-filename');
  if (marketSubmitScriptFile && marketSubmitScriptFilename) {
    marketSubmitScriptFile.addEventListener('change', function () {
      var file = marketSubmitScriptFile.files && marketSubmitScriptFile.files[0];
      marketSubmitScriptFilename.textContent = file ? file.name : 'No file chosen';
    });
  }

  var marketSubmitScriptForm = document.getElementById('market-submit-script-form');
  if (marketSubmitScriptForm) {
    marketSubmitScriptForm.addEventListener('submit', function (e) {
      e.preventDefault();
      var nameEl = document.getElementById('market-submit-script-name');
      var name = nameEl ? String(nameEl.value || '').trim() : '';
      if (!name) {
        window.alert('Please enter a script name.');
        return;
      }
      var fileEl = document.getElementById('market-submit-script-file');
      var chosen = fileEl && fileEl.files && fileEl.files[0];
      var payload = {
        name: name,
        description: String(
          (document.getElementById('market-submit-script-description') || {}).value || '',
        ).trim(),
        category: String((document.getElementById('market-submit-script-category') || {}).value || '').trim(),
        tags: String((document.getElementById('market-submit-script-tags') || {}).value || '').trim(),
        pricing: String((document.getElementById('market-submit-script-pricing') || {}).value || 'free'),
        fileName: chosen ? chosen.name : null,
        fileSize: chosen ? chosen.size : 0,
        hasFile: !!chosen,
      };
      var sendBtn = document.getElementById('market-submit-script-send');
      if (sendBtn) {
        sendBtn.disabled = true;
      }
      fetch('/api/market/script-submit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
        .then(function (r) {
          return r.text().then(function (text) {
            return { ok: r.ok, text: text };
          });
        })
        .then(function (x) {
          var j = {};
          try {
            j = x.text ? JSON.parse(x.text) : {};
          } catch (e2) {
            j = { error: x.text };
          }
          var msg = j.message || j.error || 'Done.';
          if (x.ok && j.ok !== false) {
            window.alert(msg);
            closeMarketSubmitScriptModal();
          } else {
            window.alert('Submit failed: ' + msg);
          }
        })
        .catch(function (err) {
          window.alert('Request failed: ' + (err && err.message ? err.message : err));
        })
        .then(function () {
          if (sendBtn) sendBtn.disabled = false;
        });
    });
  }

  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape') return;
    if (marketSubmitScriptOverlay && !marketSubmitScriptOverlay.classList.contains('hidden')) {
      closeMarketSubmitScriptModal();
    }
  });

  var marketCheckoutBtn = document.getElementById('market-checkout-btn');
  if (marketCheckoutBtn) {
    marketCheckoutBtn.addEventListener('click', function () {
      var payload = { items: marketCart, totalGems: marketCartTotal() };
      fetch('/api/market/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
        .then(function (r) {
          return r.text().then(function (text) {
            var j = {};
            try {
              j = text ? JSON.parse(text) : {};
            } catch (e) {
              j = { error: text || 'Non-JSON response' };
            }
            return { ok: r.ok, j: j };
          });
        })
        .then(function (x) {
          var msg = (x.j && x.j.message) || (x.j && x.j.error) || JSON.stringify(x.j);
          if (x.j && x.j.stub) {
            window.alert('Stub response:\n' + msg);
          } else if (x.ok) {
            window.alert('Checkout: ' + msg);
            marketCart = [];
            renderMarketCart();
          } else {
            window.alert('Checkout failed: ' + msg);
          }
        })
        .catch(function (e) {
          window.alert('Checkout request failed: ' + (e && e.message ? e.message : e));
        });
    });
  }

  var marketClearBtn = document.getElementById('market-cart-clear-btn');
  if (marketClearBtn) {
    marketClearBtn.addEventListener('click', function () {
      marketCart = [];
      renderMarketCart();
    });
  }

  if (logsClearBtn) {
    logsClearBtn.addEventListener('click', () => {
      if (logsList) logsList.innerHTML = '';
      refreshLogsEmptyState();
    });
  }
  refreshLogsEmptyState();

  const objectsRefreshBtn = document.getElementById('objects-refresh-btn');
  const objectsAutoRefreshCheck = document.getElementById('objects-auto-refresh');
  const tilemapRefreshBtn = document.getElementById('tilemap-refresh-btn');
  const tilemapAutoRefreshCheck = document.getElementById('tilemap-auto-refresh');
  let objectsAutoRefreshInterval = null;
  let tilemapAutoRefreshInterval = null;
  const OBJECTS_AUTO_REFRESH_MS = 5000;
  const TILEMAP_AUTO_REFRESH_MS = 3000;

  function requestObjects() {
    if (ws && ws.readyState === 1) {
      ws.send(JSON.stringify({ type: 'requestObjects' }));
    }
  }

  function requestTilemap() {
    if (ws && ws.readyState === 1) {
      ws.send(JSON.stringify({ type: 'requestTilemap', radius: 12 }));
    }
  }

  if (objectsRefreshBtn) {
    objectsRefreshBtn.addEventListener('click', requestObjects);
  }
  if (tilemapRefreshBtn) {
    tilemapRefreshBtn.addEventListener('click', requestTilemap);
  }

  if (objectsAutoRefreshCheck) {
    objectsAutoRefreshCheck.addEventListener('change', function () {
      if (objectsAutoRefreshInterval) {
        clearInterval(objectsAutoRefreshInterval);
        objectsAutoRefreshInterval = null;
      }
      if (this.checked) {
        requestObjects();
        objectsAutoRefreshInterval = setInterval(requestObjects, OBJECTS_AUTO_REFRESH_MS);
      }
    });
  }
  if (tilemapAutoRefreshCheck) {
    tilemapAutoRefreshCheck.addEventListener('change', function () {
      if (tilemapAutoRefreshInterval) {
        clearInterval(tilemapAutoRefreshInterval);
        tilemapAutoRefreshInterval = null;
      }
      if (this.checked) {
        requestTilemap();
        tilemapAutoRefreshInterval = setInterval(requestTilemap, TILEMAP_AUTO_REFRESH_MS);
      }
    });
  }

  // Clear objects auto-refresh when WebSocket closes so we don't keep firing
  function clearObjectsAutoRefresh() {
    if (objectsAutoRefreshInterval) {
      clearInterval(objectsAutoRefreshInterval);
      objectsAutoRefreshInterval = null;
    }
    if (tilemapAutoRefreshInterval) {
      clearInterval(tilemapAutoRefreshInterval);
      tilemapAutoRefreshInterval = null;
    }
    if (objectsAutoRefreshCheck) objectsAutoRefreshCheck.checked = false;
    if (tilemapAutoRefreshCheck) tilemapAutoRefreshCheck.checked = false;
  }

  // ─── Game Wiki tab (objects.xml / tiles.xml catalog) ─────

  function resetGameWikiOnWsClose() {
    gameWikiLoaded = false;
    gameWikiLoading = false;
    gameWikiSummaries = [];
    gameWikiDetails = Object.create(null);
    gameWikiTiles = [];
    gameWikiSummaryByType = Object.create(null);
    gameWikiTileByType = Object.create(null);
    gameWikiFiltered = [];
    gameWikiSelectedType = null;
    gameWikiClassFilter = 'all';
    gameWikiSortMode = 'name';
    gameWikiDungeonFilter = '';
    gameWikiXmlCache = new Map();
    gameWikiTextureCache = new Map();
    gameWikiXmlPendingKey = null;
    gameWikiObjectXmlInFlight = Object.create(null);
    gameWikiTileXmlInFlight = Object.create(null);
    for (var pk in gameWikiXmlPrefetchScheduled) {
      var pt = gameWikiXmlPrefetchScheduled[pk];
      if (typeof pt === 'number') clearTimeout(pt);
    }
    gameWikiXmlPrefetchScheduled = Object.create(null);
  }

  function requestGameWikiCatalog(force) {
    if (!ws || ws.readyState !== 1) return;
    ws.send(JSON.stringify({ type: 'requestGameWikiCatalog', force: !!force }));
  }

  /** Show the catalog list when XML data exists, or when Effects (static index list) is selected. */
  function updateGameWikiPanelVisibility() {
    var mainEl = document.getElementById('game-wiki-main');
    var emptyEl = document.getElementById('game-wiki-empty');
    var loadEl = document.getElementById('game-wiki-loading');
    if (gameWikiSection === 'effects') {
      if (loadEl) loadEl.classList.add('hidden');
      if (emptyEl) emptyEl.classList.add('hidden');
      if (mainEl) mainEl.classList.remove('hidden');
      return;
    }
    if (!gameWikiLoaded) return;
    if (gameWikiSummaries.length === 0 && gameWikiTiles.length === 0) {
      if (emptyEl) emptyEl.classList.remove('hidden');
      if (mainEl) mainEl.classList.add('hidden');
    } else {
      if (emptyEl) emptyEl.classList.add('hidden');
      if (mainEl) mainEl.classList.remove('hidden');
    }
  }

  // ── XML syntax highlight helper ──────────────────────────
  function highlightXml(xmlStr) {
    var html = xmlStr
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
    // Tag names: <TagName or </TagName
    html = html.replace(/(&lt;\/?[A-Za-z][A-Za-z0-9_:-]*)/g, '<span class="xh-tag">$1</span>');
    // Attribute names (word before =)
    html = html.replace(/\b([A-Za-z][A-Za-z0-9_:-]*)(?==)/g, '<span class="xh-attr">$1</span>');
    // Quoted values
    html = html.replace(/(&quot;[^<]*?&quot;)/g, '<span class="xh-val">$1</span>');
    // Closing > and />
    html = html.replace(/(\/?&gt;)/g, '<span class="xh-tag">$1</span>');
    return html;
  }

  function appendXmlBlock(container, xmlStr) {
    if (!xmlStr) {
      var noXml = document.createElement('p');
      noXml.className = 'game-wiki-xml-empty';
      noXml.textContent = 'Not found in loaded XML file.';
      container.appendChild(noXml);
      return;
    }
    var pre = document.createElement('pre');
    pre.className = 'game-wiki-xml-block';
    pre.innerHTML = highlightXml(xmlStr);
    container.appendChild(pre);
  }

  // ── Wiki filter / sort helpers ────────────────────────────

  function getObjClassGroup(s) {
    var c = (s.objectClass || '').toLowerCase();
    if (s.category === 'Enemy' || c === 'character') return 'enemy';
    if (s.category === 'Projectile') return 'projectile';
    if (s.category === 'Container') return 'container';
    if (s.category === 'Portal') return 'portal';
    if (s.category === 'Player') return 'player';
    if (c === 'wall' || c === 'cavewall' || c === 'connectedwall') return 'wall';
    if (s.category === 'VisualOnly') return 'visual';
    if (s.category === 'Beacon') return 'beacon';
    if (c === 'weapon') return 'weapon';
    if (c === 'ability') return 'ability';
    if (c === 'armor') return 'armor';
    if (c === 'ring') return 'ring';
    // RotMG Exalt uses <Class>Equipment</Class> for all equippable items — classify by SlotType
    if (c === 'equipment') {
      var st = Number(s.slotType);
      if (st === 9) return 'ring';
      if (st === 6 || st === 7 || st === 14) return 'armor';
      if (WEAPON_SLOT_TYPES[st]) return 'weapon';
      if (st > 0 && st !== 10 && st !== 26) return 'ability';
    }
    return 'other';
  }

  var WEAPON_SLOT_TYPES = { 1:true, 2:true, 3:true, 8:true, 17:true, 24:true, 25:true, 27:true, 28:true, 29:true, 30:true };
  var EQUIP_GROUPS = { weapon: true, ability: true, armor: true, ring: true };

  function matchesObjClassFilter(s, filter) {
    if (filter === 'all') return true;
    var grp = getObjClassGroup(s);
    if (filter === 'equip') return grp in EQUIP_GROUPS;
    if (filter === 'other') return grp === 'other' || grp === 'beacon';
    return grp === filter;
  }

  function matchesTileFilter(t, filter) {
    if (filter === 'all') return true;
    return (t.tileBucket || '') === filter;
  }

  function rebuildGameWikiFiltered() {
    gameWikiFiltered = [];
    var q = (gameWikiSearchRaw || '').trim().toLowerCase();
    var i;
    if (gameWikiSection === 'objects') {
      for (i = 0; i < gameWikiSummaries.length; i++) {
        var s = gameWikiSummaries[i];
        if (!matchesObjClassFilter(s, gameWikiClassFilter)) continue;
        if (gameWikiDungeonFilter && (s.dungeonName || '') !== gameWikiDungeonFilter) continue;
        if (q) {
          var hit = (s.id && s.id.toLowerCase().indexOf(q) >= 0)
            || (s.displayId && String(s.displayId).toLowerCase().indexOf(q) >= 0)
            || (s.typeHex && s.typeHex.toLowerCase().indexOf(q) >= 0)
            || String(s.type).indexOf(q) >= 0
            || (s.objectClass && String(s.objectClass).toLowerCase().indexOf(q) >= 0)
            || (s.category && String(s.category).toLowerCase().indexOf(q) >= 0)
            || (s.dungeonName && s.dungeonName.toLowerCase().indexOf(q) >= 0);
          if (!hit) continue;
        }
        gameWikiFiltered.push(s);
      }
      gameWikiFiltered.sort(function (a, b) {
        if (gameWikiSortMode === 'id') return a.type - b.type;
        if (gameWikiSortMode === 'hp') {
          var hpD = (b.maxHp || 0) - (a.maxHp || 0);
          if (hpD !== 0) return hpD;
        }
        // name A→Z, grouped by category
        var ga = getObjClassGroup(a);
        var gb = getObjClassGroup(b);
        if (gameWikiSortMode === 'name' && ga !== gb) return ga < gb ? -1 : 1;
        var na = (a.id || a.typeHex || '').toLowerCase();
        var nb = (b.id || b.typeHex || '').toLowerCase();
        return na < nb ? -1 : na > nb ? 1 : 0;
      });
    } else if (gameWikiSection === 'effects') {
      for (i = 0; i < GAME_WIKI_CONDITION_EFFECTS.length; i++) {
        var eff = GAME_WIKI_CONDITION_EFFECTS[i];
        if (q) {
          var hexQ = '0x' + eff.index.toString(16);
          var hitE = eff.name.toLowerCase().indexOf(q) >= 0
            || String(eff.index).indexOf(q) >= 0
            || hexQ.indexOf(q) >= 0;
          if (!hitE) continue;
        }
        gameWikiFiltered.push(eff);
      }
      gameWikiFiltered.sort(function (a, b) {
        if (gameWikiSortMode === 'id' || gameWikiSortMode === 'damage' || gameWikiSortMode === 'hp') {
          return a.index - b.index;
        }
        var na = a.name.toLowerCase();
        var nb = b.name.toLowerCase();
        return na < nb ? -1 : na > nb ? 1 : 0;
      });
    } else {
      for (i = 0; i < gameWikiTiles.length; i++) {
        var t = gameWikiTiles[i];
        if (!matchesTileFilter(t, gameWikiClassFilter)) continue;
        if (q) {
          var hitT = (t.id && t.id.toLowerCase().indexOf(q) >= 0)
            || (t.typeHex && t.typeHex.toLowerCase().indexOf(q) >= 0)
            || String(t.type).indexOf(q) >= 0
            || (t.tileBucket && t.tileBucket.toLowerCase().indexOf(q) >= 0);
          if (!hitT) continue;
        }
        gameWikiFiltered.push(t);
      }
      gameWikiFiltered.sort(function (a, b) {
        if (gameWikiSortMode === 'id') return a.type - b.type;
        if (gameWikiSortMode === 'damage') {
          var dD = (b.damagePerTick || 0) - (a.damagePerTick || 0);
          if (dD !== 0) return dD;
        }
        var na = (a.id || a.typeHex || '').toLowerCase();
        var nb = (b.id || b.typeHex || '').toLowerCase();
        return na < nb ? -1 : na > nb ? 1 : 0;
      });
    }
  }

  function scheduleGameWikiListViewport() {
    if (gameWikiViewportRaf) cancelAnimationFrame(gameWikiViewportRaf);
    gameWikiViewportRaf = requestAnimationFrame(renderGameWikiListViewport);
  }

  /** Writes to gameWikiXmlCache, evicts oldest when over cap, invalidates any parsed-texture memo. */
  function setGameWikiXmlCache(k, v) {
    if (gameWikiXmlCache.has(k)) gameWikiXmlCache.delete(k);
    gameWikiXmlCache.set(k, v);
    gameWikiTextureCache.delete(k);
    while (gameWikiXmlCache.size > GAME_WIKI_XML_CACHE_CAP) {
      var oldest = gameWikiXmlCache.keys().next().value;
      if (oldest === undefined) break;
      gameWikiXmlCache.delete(oldest);
      gameWikiTextureCache.delete(oldest);
    }
  }

  /** Memoized lookup of parsed <Texture> info from the cached XML for an object-type key. */
  function getGameWikiTextureForKey(k) {
    if (gameWikiTextureCache.has(k)) return gameWikiTextureCache.get(k);
    var xml = gameWikiXmlCache.get(k);
    var tex = xml ? parseWikiObjectTextureFromXml(xml) : null;
    gameWikiTextureCache.set(k, tex);
    return tex;
  }

  /** Cancel pending staggered prefetches whose object type isn't in the keep set. */
  function cancelStaleGameWikiPrefetches(keepKeys) {
    for (var pk in gameWikiXmlPrefetchScheduled) {
      if (keepKeys[pk]) continue;
      var pt = gameWikiXmlPrefetchScheduled[pk];
      if (typeof pt === 'number') clearTimeout(pt);
      delete gameWikiXmlPrefetchScheduled[pk];
    }
  }

  /** Fetch raw object XML for wiki texture / XML pane; no-op if cached, EAM-only, or already in flight. */
  function requestObjectXmlIfNeeded(objectType) {
    var pk = 'o:' + String(objectType);
    if (gameWikiXmlCache.has(pk)) return false;
    if (gameWikiObjectXmlInFlight[pk]) return false;
    if (!ws || ws.readyState !== 1) return false;
    gameWikiObjectXmlInFlight[pk] = true;
    ws.send(JSON.stringify({ type: 'requestObjectXml', objectType: objectType }));
    return true;
  }

  /** Fetch raw tile XML for wiki texture / XML pane; no-op if cached or already in flight. */
  function requestTileXmlIfNeeded(tileType) {
    var pk = 't:' + String(tileType);
    if (gameWikiXmlCache.has(pk)) return false;
    if (gameWikiTileXmlInFlight[pk]) return false;
    if (!ws || ws.readyState !== 1) return false;
    gameWikiTileXmlInFlight[pk] = true;
    ws.send(JSON.stringify({ type: 'requestTileXml', tileType: tileType }));
    return true;
  }

  /** Stagger requests for visible rows so list sprites fill without clicking each row. */
  function prefetchGameWikiVisibleObjectXml(start, end) {
    if (gameWikiSection !== 'objects' || activeTab !== 'game-wiki' || !ws || ws.readyState !== 1) return;
    // Cancel timers for rows that scrolled out before firing — saves requests on fast scrolling.
    var keep = Object.create(null);
    for (var kp = start; kp < end; kp++) {
      var svp = gameWikiFiltered[kp];
      if (svp) keep['o:' + String(svp.type)] = true;
    }
    cancelStaleGameWikiPrefetches(keep);
    var delay = 0;
    var pv;
    for (pv = start; pv < end; pv++) {
      var sov = gameWikiFiltered[pv];
      var kv = 'o:' + String(sov.type);
      if (gameWikiXmlCache.has(kv)) continue;
      if (getEamItemRecordStrict(sov.type)) continue;
      if (gameWikiObjectXmlInFlight[kv] || gameWikiXmlPrefetchScheduled[kv]) continue;
      gameWikiXmlPrefetchScheduled[kv] = (function (ot, d) {
        return setTimeout(function () {
          var k2 = 'o:' + String(ot);
          delete gameWikiXmlPrefetchScheduled[k2];
          if (!ws || ws.readyState !== 1) return;
          if (gameWikiXmlCache.has(k2)) return;
          requestObjectXmlIfNeeded(ot);
        }, d);
      })(sov.type, delay);
      delay += 28;
    }
  }

  /** Stagger tile XML requests so visible rows can resolve their sprite art without clicking. */
  function prefetchGameWikiVisibleTileXml(start, end) {
    if (gameWikiSection !== 'tiles' || activeTab !== 'game-wiki' || !ws || ws.readyState !== 1) return;
    var keep = Object.create(null);
    for (var kp = start; kp < end; kp++) {
      var stp = gameWikiFiltered[kp];
      if (stp) keep['t:' + String(stp.type)] = true;
    }
    cancelStaleGameWikiPrefetches(keep);
    var delay = 0;
    var pv;
    for (pv = start; pv < end; pv++) {
      var stv = gameWikiFiltered[pv];
      var kv = 't:' + String(stv.type);
      if (gameWikiXmlCache.has(kv)) continue;
      if (gameWikiTileXmlInFlight[kv] || gameWikiXmlPrefetchScheduled[kv]) continue;
      gameWikiXmlPrefetchScheduled[kv] = (function (tt, d) {
        return setTimeout(function () {
          var k2 = 't:' + String(tt);
          delete gameWikiXmlPrefetchScheduled[k2];
          if (!ws || ws.readyState !== 1) return;
          if (gameWikiXmlCache.has(k2)) return;
          requestTileXmlIfNeeded(tt);
        }, d);
      })(stv.type, delay);
      delay += 28;
    }
  }

  function renderGameWikiListViewport() {
    gameWikiViewportRaf = null;
    var scrollEl = document.getElementById('game-wiki-scroll');
    var rowsEl = document.getElementById('game-wiki-list-rows');
    var topSp = document.getElementById('game-wiki-list-spacer-top');
    var botSp = document.getElementById('game-wiki-list-spacer-bottom');
    var metaEl = document.getElementById('game-wiki-list-meta');
    if (!scrollEl || !rowsEl || !topSp || !botSp) return;
    var n = gameWikiFiltered.length;
    var total = gameWikiSection === 'objects'
      ? gameWikiSummaries.length
      : gameWikiSection === 'effects'
        ? GAME_WIKI_CONDITION_EFFECTS.length
        : gameWikiTiles.length;
    if (metaEl) {
      var detailCount = Object.keys(gameWikiDetails).length;
      var kindLabel = gameWikiSection === 'objects'
        ? 'objects'
        : gameWikiSection === 'effects'
          ? 'effects'
          : 'tiles';
      var baseText = n === total
        ? (total + ' ' + kindLabel)
        : (n + ' / ' + total + ' shown');
      metaEl.textContent = (gameWikiSection === 'objects' && detailCount > 0)
        ? baseText + ' — ' + detailCount + ' with projectile data'
        : baseText;
    }
    var rowH = GAME_WIKI_ROW_H;
    if (n === 0) {
      rowsEl.innerHTML = '<div class="game-wiki-row game-wiki-row-empty" style="cursor:default;color:var(--text-dim)">No matches</div>';
      topSp.style.height = '0px';
      botSp.style.height = '0px';
      return;
    }
    var ch = scrollEl.clientHeight || 400;
    var st = scrollEl.scrollTop;
    var start = Math.floor(st / rowH) - GAME_WIKI_OVERSCAN;
    if (start < 0) start = 0;
    var end = Math.ceil((st + ch) / rowH) + GAME_WIKI_OVERSCAN;
    if (end > n) end = n;
    topSp.style.height = (start * rowH) + 'px';
    botSp.style.height = ((n - end) * rowH) + 'px';
    var frag = document.createDocumentFragment();
    var j;
    for (j = start; j < end; j++) {
      var row = document.createElement('div');
      row.className = 'game-wiki-row';
      row.style.height = rowH + 'px';
      if (gameWikiSection === 'objects') {
        var so = gameWikiFiltered[j];
        row.dataset.type = String(so.type);
        var miniWrap = document.createElement('span');
        miniWrap.className = 'game-wiki-row-sprite-wrap';
        miniWrap.setAttribute('aria-hidden', 'true');
        var erm = getEamItemRecordStrict(so.type);
        if (erm) {
          var miniSp = document.createElement('span');
          miniSp.className = 'rotmg-item-sprite';
          miniSp.style.backgroundPosition = '-' + Math.max(0, Number(erm[3] || 0)) + 'px -' + Math.max(0, Number(erm[4] || 0)) + 'px';
          miniWrap.appendChild(miniSp);
        } else {
          var xk = 'o:' + String(so.type);
          var tex = getGameWikiTextureForKey(xk);
          if (tex && tex.file) {
            var rowImg = new Image();
            rowImg.className = 'game-wiki-row-tex-img';
            rowImg.alt = '';
            rowImg.src = '/api/wiki-texture-file?file=' + encodeURIComponent(tex.file) + '&index=' + encodeURIComponent(String(tex.index));
            (function (texLocal) {
              rowImg.onload = function () {
                var tw = rowImg.naturalWidth;
                var th = rowImg.naturalHeight;
                if (!tw || !th) return;
                var box = 32;
                var maxDim = Math.max(tw, th);
                var cropped = maxDim <= 260;
                if (cropped) {
                  var sc = box / maxDim;
                  rowImg.style.width = (tw * sc) + 'px';
                  rowImg.style.height = (th * sc) + 'px';
                  rowImg.style.marginLeft = '0px';
                  rowImg.style.marginTop = '0px';
                } else {
                  var cell = texLocal.cell || 8;
                  var perRow = Math.max(1, Math.floor(tw / cell));
                  var sx = (texLocal.index % perRow) * cell;
                  var sy = Math.floor(texLocal.index / perRow) * cell;
                  var sc2 = box / cell;
                  rowImg.style.width = (tw * sc2) + 'px';
                  rowImg.style.height = (th * sc2) + 'px';
                  rowImg.style.marginLeft = (-sx * sc2) + 'px';
                  rowImg.style.marginTop = (-sy * sc2) + 'px';
                }
                rowImg.style.imageRendering = 'pixelated';
              };
            })(tex);
            miniWrap.appendChild(rowImg);
          } else {
            miniWrap.classList.add('game-wiki-row-sprite-empty');
          }
        }
        row.appendChild(miniWrap);
        var grp = getObjClassGroup(so);
        var badge = document.createElement('span');
        badge.className = 'game-wiki-class-badge gwc-' + grp;
        badge.textContent = so.objectClass || '?';
        var nameEl = document.createElement('span');
        nameEl.className = 'game-wiki-row-name';
        nameEl.textContent = so.id || so.typeHex;
        var hexEl = document.createElement('span');
        hexEl.className = 'game-wiki-row-hex';
        hexEl.textContent = so.typeHex;
        row.appendChild(badge);
        row.appendChild(nameEl);
        row.appendChild(hexEl);
      } else if (gameWikiSection === 'effects') {
        var ee = gameWikiFiltered[j];
        row.dataset.type = String(ee.index);
        var effSp = document.createElement('span');
        effSp.className = 'game-wiki-row-sprite-wrap game-wiki-row-sprite-empty game-wiki-row-sprite-effect';
        effSp.setAttribute('aria-hidden', 'true');
        row.appendChild(effSp);
        var ebadge = document.createElement('span');
        ebadge.className = 'game-wiki-class-badge ' + (ee.index < 31 ? 'gwe-e0' : 'gwe-e1');
        ebadge.textContent = ee.index < 31 ? 'E[0]' : 'E[1]';
        var enameEl = document.createElement('span');
        enameEl.className = 'game-wiki-row-name';
        enameEl.textContent = ee.name;
        var eidxEl = document.createElement('span');
        eidxEl.className = 'game-wiki-row-hex';
        eidxEl.textContent = String(ee.index);
        row.appendChild(ebadge);
        row.appendChild(enameEl);
        row.appendChild(eidxEl);
      } else {
        var tt = gameWikiFiltered[j];
        row.dataset.type = String(tt.type);
        var tileSp = document.createElement('span');
        tileSp.className = 'game-wiki-row-sprite-wrap game-wiki-row-sprite-tile';
        var tk = 't:' + String(tt.type);
        var ttex = getGameWikiTextureForKey(tk);
        if (ttex && ttex.file) {
          var tileImg = new Image();
          tileImg.className = 'game-wiki-row-tex-img';
          tileImg.alt = '';
          tileImg.src = '/api/wiki-texture-file?file=' + encodeURIComponent(ttex.file) + '&index=' + encodeURIComponent(String(ttex.index));
          (function (texLocal) {
            tileImg.onload = function () {
              var tw = tileImg.naturalWidth;
              var th = tileImg.naturalHeight;
              if (!tw || !th) return;
              var box = 34;
              var maxDim = Math.max(tw, th);
              var cropped = maxDim <= 260;
              if (cropped) {
                var sc = box / maxDim;
                tileImg.style.width = (tw * sc) + 'px';
                tileImg.style.height = (th * sc) + 'px';
                tileImg.style.marginLeft = '0px';
                tileImg.style.marginTop = '0px';
              } else {
                var cell = texLocal.cell || 8;
                var perRow = Math.max(1, Math.floor(tw / cell));
                var sx = (texLocal.index % perRow) * cell;
                var sy = Math.floor(texLocal.index / perRow) * cell;
                var sc2 = box / cell;
                tileImg.style.width = (tw * sc2) + 'px';
                tileImg.style.height = (th * sc2) + 'px';
                tileImg.style.marginLeft = (-sx * sc2) + 'px';
                tileImg.style.marginTop = (-sy * sc2) + 'px';
              }
              tileImg.style.imageRendering = 'pixelated';
            };
          })(ttex);
          tileSp.appendChild(tileImg);
        } else {
          tileSp.classList.add('game-wiki-row-sprite-empty');
        }
        tileSp.setAttribute('aria-hidden', 'true');
        row.appendChild(tileSp);
        var tgrp = (tt.tileBucket || 'Other').toLowerCase();
        var tbadge = document.createElement('span');
        tbadge.className = 'game-wiki-class-badge gwt-' + tgrp;
        tbadge.textContent = tt.tileBucket || 'Other';
        var tnameEl = document.createElement('span');
        tnameEl.className = 'game-wiki-row-name';
        tnameEl.textContent = tt.id || tt.typeHex;
        var thexEl = document.createElement('span');
        thexEl.className = 'game-wiki-row-hex';
        thexEl.textContent = tt.typeHex;
        row.appendChild(tbadge);
        row.appendChild(tnameEl);
        row.appendChild(thexEl);
      }
      if (gameWikiSelectedType != null && Number(row.dataset.type) === gameWikiSelectedType) {
        row.classList.add('game-wiki-row-selected');
      }
      frag.appendChild(row);
    }
    rowsEl.innerHTML = '';
    rowsEl.appendChild(frag);
    // Keep viewport stable: reflows (images, spacers) must not drift scrollTop
    if (scrollEl.scrollTop !== st) scrollEl.scrollTop = st;
    if (activeTab === 'game-wiki' && gameWikiSection === 'objects') {
      prefetchGameWikiVisibleObjectXml(start, end);
    } else if (activeTab === 'game-wiki' && gameWikiSection === 'tiles') {
      prefetchGameWikiVisibleTileXml(start, end);
    }
  }

  function selectGameWikiRow(type) {
    gameWikiSelectedType = type;
    document.querySelectorAll('#game-wiki-list-rows .game-wiki-row').forEach(function (el) {
      if (!el.dataset || el.dataset.type == null) return;
      el.classList.toggle('game-wiki-row-selected', Number(el.dataset.type) === type);
    });
    renderGameWikiDetail();
  }

  /** Parse first usable <Texture> or <AnimatedTexture> block from cached wiki XML. */
  function parseWikiObjectTextureFromXml(xmlStr) {
    if (!xmlStr || typeof xmlStr !== 'string') return null;
    var block = xmlStr.match(/<Texture>[\s\S]*?<\/Texture>/i);
    if (!block) {
      block = xmlStr.match(/<AnimatedTexture>[\s\S]*?<\/AnimatedTexture>/i);
    }
    if (!block) return null;
    var inner = block[0];
    var fm = inner.match(/<File>([^<]+)<\/File>/i);
    var im = inner.match(/<Index>([^<]+)<\/Index>/i);
    if (!fm || !im) return null;
    var file = fm[1].trim();
    var idxStr = im[1].trim();
    var index;
    if (/^0x/i.test(String(idxStr))) {
      index = parseInt(String(idxStr).replace(/^0x/i, ''), 16);
    } else {
      index = parseInt(String(idxStr), 10);
    }
    if (!Number.isFinite(index)) index = 0;
    var cell = 8;
    var szm = inner.match(/<Size>(\d+)<\/Size>/i);
    if (szm) {
      var s = parseInt(szm[1], 10);
      if (s === 8 || s === 16 || s === 32 || s === 40) cell = s;
    }
    return { file: file, index: index, cell: cell };
  }

  /**
   * If raw wiki XML is cached and defines texture info, show that frame from the RotMG install sheet
   * served at /api/wiki-texture-file (same idea as in-game File.png under Drawings).
   */
  function mountGameWikiTextureFromCachedXml(spriteDiv, xmlKey) {
    var tex = getGameWikiTextureForKey(xmlKey);
    if (!tex || !tex.file) return false;
    var wrap = document.createElement('div');
    wrap.className = 'game-wiki-texture-sheet-wrap';
    var img = new Image();
    img.alt = '';
    img.className = 'game-wiki-texture-sheet-img';
    img.onload = function () {
      var tw = img.naturalWidth;
      var th = img.naturalHeight;
      if (!tw || !th) return;
      var disp = 80;
      var maxDim = Math.max(tw, th);
      var cropped = maxDim <= 260;
      if (cropped) {
        var scale = disp / maxDim;
        img.style.width = (tw * scale) + 'px';
        img.style.height = (th * scale) + 'px';
        img.style.marginLeft = '0px';
        img.style.marginTop = '0px';
      } else {
        var cell = tex.cell || 8;
        var perRow = Math.max(1, Math.floor(tw / cell));
        var sx = (tex.index % perRow) * cell;
        var sy = Math.floor(tex.index / perRow) * cell;
        var scale2 = disp / cell;
        img.style.width = (tw * scale2) + 'px';
        img.style.height = (th * scale2) + 'px';
        img.style.marginLeft = (-sx * scale2) + 'px';
        img.style.marginTop = (-sy * scale2) + 'px';
      }
      img.style.imageRendering = 'pixelated';
    };
    img.onerror = function () {
      wrap.classList.add('game-wiki-texture-missing');
      wrap.textContent = 'PNG';
      wrap.title = 'Sprite not found. Set RotMG Exalt path in Settings (Drawings/' + tex.file + '.png).';
    };
    img.src = '/api/wiki-texture-file?file=' + encodeURIComponent(tex.file) + '&index=' + encodeURIComponent(String(tex.index));
    wrap.appendChild(img);
    spriteDiv.className = 'game-wiki-detail-sprite game-wiki-detail-texture';
    spriteDiv.appendChild(wrap);
    return true;
  }

  function renderGameWikiDetail() {
    var ph = document.getElementById('game-wiki-detail-placeholder');
    var body = document.getElementById('game-wiki-detail-body');
    if (!ph || !body) return;
    if (gameWikiSelectedType == null) {
      ph.classList.remove('hidden');
      body.classList.add('hidden');
      body.innerHTML = '';
      return;
    }
    ph.classList.add('hidden');
    body.classList.remove('hidden');
    body.innerHTML = '';

    if (gameWikiSection === 'objects') {
      var sum = gameWikiSummaryByType[gameWikiSelectedType];
      if (!sum) return;

      // ── Header: sprite (same renders.png + EAM as Accounts) or class placeholder ───
      var headerDiv = document.createElement('div');
      headerDiv.className = 'game-wiki-detail-header';

      var spriteDiv = document.createElement('div');
      spriteDiv.className = 'game-wiki-detail-sprite';
      var wikiItemStub = {
        objectType: sum.type,
        objectTypeHex: sum.typeHex,
        name: sum.displayId || sum.id || '',
      };
      if (getEamItemRecordStrict(sum.type)) {
        spriteDiv.innerHTML = buildItemSpriteHtml(wikiItemStub, 'game-wiki-detail-item-sprite', null, 'strict');
      } else if (!mountGameWikiTextureFromCachedXml(spriteDiv, 'o:' + String(sum.type))) {
        var grpPh = getObjClassGroup(sum);
        spriteDiv.className = 'game-wiki-detail-sprite game-wiki-sprite-ph gwc-ph-' + grpPh;
        spriteDiv.textContent = (sum.objectClass || sum.category || '?').substring(0, 4).toUpperCase();
        spriteDiv.title = sum.objectClass || sum.category || '';
      }
      headerDiv.appendChild(spriteDiv);

      // Name + badges
      var headerInfo = document.createElement('div');
      headerInfo.className = 'game-wiki-detail-header-info';
      var h3 = document.createElement('h3');
      h3.textContent = sum.displayId || sum.id || sum.typeHex;
      headerInfo.appendChild(h3);

      var idLine = document.createElement('p');
      idLine.className = 'game-wiki-id-line';
      var hexSpanH = document.createElement('span');
      hexSpanH.className = 'game-wiki-id-hex';
      hexSpanH.textContent = sum.typeHex;
      var sepSpanH = document.createElement('span');
      sepSpanH.className = 'game-wiki-id-sep';
      sepSpanH.textContent = ' / ';
      var decSpanH = document.createElement('span');
      decSpanH.className = 'game-wiki-id-dec game-wiki-copy-num';
      decSpanH.textContent = String(sum.type);
      decSpanH.title = 'Click to copy decimal ID';
      (function (el, val) {
        el.addEventListener('click', function () {
          navigator.clipboard.writeText(val).then(function () {
            el.classList.add('copied');
            var prev = el.textContent;
            el.textContent = 'Copied!';
            setTimeout(function () { el.textContent = prev; el.classList.remove('copied'); }, 900);
          });
        });
      })(decSpanH, String(sum.type));
      idLine.appendChild(hexSpanH);
      idLine.appendChild(sepSpanH);
      idLine.appendChild(decSpanH);
      headerInfo.appendChild(idLine);

      var badges = document.createElement('div');
      badges.className = 'game-wiki-stat-badges';
      function makeBadge(text, cls) {
        var b = document.createElement('span');
        b.className = 'game-wiki-stat-badge' + (cls ? ' ' + cls : '');
        b.textContent = text;
        badges.appendChild(b);
      }
      makeBadge(sum.objectClass || '?');
      makeBadge(sum.category || '—');
      if (sum.maxHp) makeBadge('HP ' + sum.maxHp, 'badge-hp');
      if (sum.defense) makeBadge('DEF ' + sum.defense, 'badge-def');
      if (sum.quest) makeBadge('QUEST', 'badge-quest');
      if (sum.god) makeBadge('GOD', 'badge-quest');
      headerInfo.appendChild(badges);
      headerDiv.appendChild(headerInfo);
      body.appendChild(headerDiv);

      if (sum.playerStatMaxes) {
        var ps = sum.playerStatMaxes;
        var capsH4 = document.createElement('h4');
        capsH4.textContent = 'Class stat maxes (8/8)';
        body.appendChild(capsH4);
        var capsDl = document.createElement('dl');
        capsDl.className = 'game-wiki-dl';
        function addCapRow(label, val) {
          var dt = document.createElement('dt');
          dt.textContent = label;
          var dd = document.createElement('dd');
          dd.textContent = val === undefined || val === null ? '—' : String(val);
          capsDl.appendChild(dt);
          capsDl.appendChild(dd);
        }
        addCapRow('Max HP', ps.maxHitPoints);
        addCapRow('Max MP', ps.maxMagicPoints);
        addCapRow('Attack', ps.attack);
        addCapRow('Defense', ps.defense);
        addCapRow('Speed', ps.speed);
        addCapRow('Dexterity', ps.dexterity);
        addCapRow('Vit (HpRegen cap)', ps.hpRegen);
        addCapRow('Wis (MpRegen cap)', ps.mpRegen);
        body.appendChild(capsDl);
      }

      // ── Raw XML ───────────────────────────────────────────
      var xmlH4 = document.createElement('h4');
      xmlH4.textContent = 'XML Source';
      body.appendChild(xmlH4);
      appendWikiXml(body, 'o:' + String(sum.type));

    } else if (gameWikiSection === 'effects') {
      var effSel = null;
      var efi;
      for (efi = 0; efi < GAME_WIKI_CONDITION_EFFECTS.length; efi++) {
        if (GAME_WIKI_CONDITION_EFFECTS[efi].index === gameWikiSelectedType) {
          effSel = GAME_WIKI_CONDITION_EFFECTS[efi];
          break;
        }
      }
      if (!effSel) return;

      var eHeaderDiv = document.createElement('div');
      eHeaderDiv.className = 'game-wiki-detail-header';

      var eSwatchDiv = document.createElement('div');
      var eArr = effSel.index < 31 ? 0 : 1;
      eSwatchDiv.className = 'game-wiki-detail-sprite game-wiki-sprite-ph gwe-ph-e' + eArr;
      eSwatchDiv.title = 'effects[' + eArr + ']';
      eSwatchDiv.textContent = 'E' + eArr;
      eHeaderDiv.appendChild(eSwatchDiv);

      var eHeaderInfo = document.createElement('div');
      eHeaderInfo.className = 'game-wiki-detail-header-info';
      var h3e = document.createElement('h3');
      h3e.textContent = effSel.name;
      eHeaderInfo.appendChild(h3e);

      var eIdLine = document.createElement('p');
      eIdLine.className = 'game-wiki-id-line';
      var hexSpanE = document.createElement('span');
      hexSpanE.className = 'game-wiki-id-hex';
      hexSpanE.textContent = '0x' + effSel.index.toString(16);
      var sepSpanE = document.createElement('span');
      sepSpanE.className = 'game-wiki-id-sep';
      sepSpanE.textContent = ' / ';
      var decSpanE = document.createElement('span');
      decSpanE.className = 'game-wiki-id-dec game-wiki-copy-num';
      decSpanE.textContent = String(effSel.index);
      decSpanE.title = 'Click to copy bitmask column index';
      (function (el, val) {
        el.addEventListener('click', function () {
          navigator.clipboard.writeText(val).then(function () {
            el.classList.add('copied');
            var prev = el.textContent;
            el.textContent = 'Copied!';
            setTimeout(function () { el.textContent = prev; el.classList.remove('copied'); }, 900);
          });
        });
      })(decSpanE, String(effSel.index));
      eIdLine.appendChild(hexSpanE);
      eIdLine.appendChild(sepSpanE);
      eIdLine.appendChild(decSpanE);
      eHeaderInfo.appendChild(eIdLine);

      var eBadges = document.createElement('div');
      eBadges.className = 'game-wiki-stat-badges';
      function makeEBadge(text, cls) {
        var b = document.createElement('span');
        b.className = 'game-wiki-stat-badge' + (cls ? ' ' + cls : '');
        b.textContent = text;
        eBadges.appendChild(b);
      }
      makeEBadge('effects[' + eArr + ']', 'badge-cond');
      var bitInWord = effSel.index < 31 ? effSel.index : (effSel.index - 31);
      makeEBadge('bit ' + bitInWord, 'badge-def');
      eHeaderInfo.appendChild(eBadges);
      eHeaderDiv.appendChild(eHeaderInfo);
      body.appendChild(eHeaderDiv);

      var pDesc = document.createElement('p');
      pDesc.className = 'game-wiki-effect-desc';
      pDesc.textContent = 'Condition effect column index (same as `ConditionEffect` in src/constants/ConditionEffect.ts). '
        + 'PlayerData.effects[0] holds bits 0–30; effects[1] holds bits for indices 31+ (shift by index − 31).';
      body.appendChild(pDesc);
    } else {
      // ── Tile detail ───────────────────────────────────────
      var tile = gameWikiTileByType[gameWikiSelectedType];
      if (!tile) return;

      var tHeaderDiv = document.createElement('div');
      tHeaderDiv.className = 'game-wiki-detail-header';

      var tSwatchDiv = document.createElement('div');
      var tgrpPh = (tile.tileBucket || 'other').toLowerCase();
      tSwatchDiv.title = tile.tileBucket || '';
      if (!mountGameWikiTextureFromCachedXml(tSwatchDiv, 't:' + String(tile.type))) {
        tSwatchDiv.className = 'game-wiki-detail-sprite game-wiki-sprite-ph gwt-ph-' + tgrpPh;
        if (tile.damagePerTick) {
          tSwatchDiv.textContent = tile.damagePerTick;
        } else if (tile.speed && tile.speed !== 1.0) {
          tSwatchDiv.textContent = Math.round(tile.speed * 100) + '%';
        } else {
          tSwatchDiv.textContent = (tile.tileBucket || 'Other').substring(0, 3).toUpperCase();
        }
      }
      tHeaderDiv.appendChild(tSwatchDiv);

      var tHeaderInfo = document.createElement('div');
      tHeaderInfo.className = 'game-wiki-detail-header-info';
      var h3t = document.createElement('h3');
      h3t.textContent = tile.id || tile.typeHex;
      tHeaderInfo.appendChild(h3t);

      var tIdLine = document.createElement('p');
      tIdLine.className = 'game-wiki-id-line';
      var hexSpanT = document.createElement('span');
      hexSpanT.className = 'game-wiki-id-hex';
      hexSpanT.textContent = tile.typeHex;
      var sepSpanT = document.createElement('span');
      sepSpanT.className = 'game-wiki-id-sep';
      sepSpanT.textContent = ' / ';
      var decSpanT = document.createElement('span');
      decSpanT.className = 'game-wiki-id-dec game-wiki-copy-num';
      decSpanT.textContent = String(tile.type);
      decSpanT.title = 'Click to copy decimal ID';
      (function (el, val) {
        el.addEventListener('click', function () {
          navigator.clipboard.writeText(val).then(function () {
            el.classList.add('copied');
            var prev = el.textContent;
            el.textContent = 'Copied!';
            setTimeout(function () { el.textContent = prev; el.classList.remove('copied'); }, 900);
          });
        });
      })(decSpanT, String(tile.type));
      tIdLine.appendChild(hexSpanT);
      tIdLine.appendChild(sepSpanT);
      tIdLine.appendChild(decSpanT);
      tHeaderInfo.appendChild(tIdLine);

      var tBadges = document.createElement('div');
      tBadges.className = 'game-wiki-stat-badges';
      function makeTBadge(text, cls) {
        var b = document.createElement('span');
        b.className = 'game-wiki-stat-badge' + (cls ? ' ' + cls : '');
        b.textContent = text;
        tBadges.appendChild(b);
      }
      makeTBadge(tile.tileBucket || 'Other');
      if (tile.damagePerTick) makeTBadge('DMG ' + tile.damagePerTick + '/tick', 'badge-dmg');
      if (tile.noWalk) makeTBadge('NO WALK');
      if (tile.sink) makeTBadge('SINK', 'badge-hp');
      if (tile.hasConditionEffect) makeTBadge('CONDITION', 'badge-cond');
      tHeaderInfo.appendChild(tBadges);
      tHeaderDiv.appendChild(tHeaderInfo);
      body.appendChild(tHeaderDiv);

      var tXmlH4 = document.createElement('h4');
      tXmlH4.textContent = 'XML Source';
      body.appendChild(tXmlH4);
      appendWikiXml(body, 't:' + String(tile.type));
    }
  }

  // Request XML from server if not cached, otherwise render it immediately.
  function appendWikiXml(container, xmlKey) {
    if (gameWikiXmlCache.has(xmlKey)) {
      appendXmlBlock(container, gameWikiXmlCache.get(xmlKey));
      return;
    }
    var parts = xmlKey.split(':');
    var kind = parts[0];
    var typeNum = Number(parts[1]);
    // Show loading state and request from server
    var loadEl = document.createElement('p');
    loadEl.className = 'game-wiki-xml-empty';
    loadEl.textContent = 'Loading XML…';
    container.appendChild(loadEl);
    if (!ws || ws.readyState !== 1) return;
    if (kind === 'o') {
      gameWikiXmlPendingKey = xmlKey;
      requestObjectXmlIfNeeded(typeNum);
      return;
    }
    if (gameWikiXmlPendingKey !== xmlKey) {
      gameWikiXmlPendingKey = xmlKey;
      requestTileXmlIfNeeded(typeNum);
    }
  }

  function setGameWikiSection(sec) {
    gameWikiSection = sec;
    gameWikiClassFilter = 'all';
    gameWikiSortMode = 'name';
    gameWikiDungeonFilter = '';
    document.querySelectorAll('#tab-game-wiki .game-wiki-subnav-btn').forEach(function (b) {
      b.classList.toggle('active', b.dataset.gameWikiSection === sec);
    });
    // Show/hide section-specific filter chips
    var filterBar = document.getElementById('game-wiki-filter-bar');
    if (filterBar) filterBar.classList.toggle('hidden', sec === 'effects');
    var objFilters = document.getElementById('game-wiki-obj-filters');
    var tileFilters = document.getElementById('game-wiki-tile-filters');
    if (objFilters) objFilters.classList.toggle('hidden', sec !== 'objects');
    if (tileFilters) tileFilters.classList.toggle('hidden', sec !== 'tiles');
    // Reset all chip active states
    document.querySelectorAll('#tab-game-wiki .game-wiki-filter-chip').forEach(function (c) {
      c.classList.toggle('active', c.dataset.gameWikiClass === 'all');
    });
    // Reset sort dropdown
    var sortEl = document.getElementById('game-wiki-sort');
    if (sortEl) sortEl.value = 'name';
    // Show dungeon filter only on objects section; reset its value
    var dungeonFilterEl = document.getElementById('game-wiki-dungeon-filter');
    if (dungeonFilterEl) {
      dungeonFilterEl.classList.toggle('hidden', sec !== 'objects');
      dungeonFilterEl.value = '';
    }
    updateGameWikiPanelVisibility();
    rebuildGameWikiFiltered();
    var scrollEl = document.getElementById('game-wiki-scroll');
    if (scrollEl) scrollEl.scrollTop = 0;
    gameWikiSelectedType = null;
    renderGameWikiDetail();
    scheduleGameWikiListViewport();
  }

  function handleGameWikiCatalog(msg) {
    gameWikiLoading = false;
    gameWikiSummaries = Array.isArray(msg.objectSummaries) ? msg.objectSummaries : [];
    gameWikiDetails = (msg.objectDetails && typeof msg.objectDetails === 'object') ? msg.objectDetails : Object.create(null);
    gameWikiTiles = Array.isArray(msg.tiles) ? msg.tiles : [];
    gameWikiSummaryByType = Object.create(null);
    gameWikiTileByType = Object.create(null);
    var si;
    for (si = 0; si < gameWikiSummaries.length; si++) {
      var o = gameWikiSummaries[si];
      gameWikiSummaryByType[o.type] = o;
    }
    var ti;
    for (ti = 0; ti < gameWikiTiles.length; ti++) {
      var tl = gameWikiTiles[ti];
      gameWikiTileByType[tl.type] = tl;
    }
    gameWikiLoaded = true;
    // Populate dungeon filter dropdown from catalog data
    var dungeonSel = document.getElementById('game-wiki-dungeon-filter');
    if (dungeonSel) {
      var dungeonNames = [];
      var seenDungeons = Object.create(null);
      for (var di = 0; di < gameWikiSummaries.length; di++) {
        var dn = gameWikiSummaries[di].dungeonName;
        if (dn && !seenDungeons[dn]) { seenDungeons[dn] = true; dungeonNames.push(dn); }
      }
      dungeonNames.sort(function (a, b) { return a < b ? -1 : a > b ? 1 : 0; });
      dungeonSel.innerHTML = '<option value="">All Dungeons</option>';
      for (var dni = 0; dni < dungeonNames.length; dni++) {
        var opt = document.createElement('option');
        opt.value = dungeonNames[dni];
        opt.textContent = dungeonNames[dni];
        dungeonSel.appendChild(opt);
      }
      dungeonSel.value = '';
    }
    var loadEl = document.getElementById('game-wiki-loading');
    var emptyEl = document.getElementById('game-wiki-empty');
    if (loadEl) loadEl.classList.add('hidden');
    var reason = msg.reason;
    if (reason === 'no_game_data' || (gameWikiSummaries.length === 0 && gameWikiTiles.length === 0)) {
      if (emptyEl) {
        emptyEl.textContent = reason === 'no_game_data'
          ? 'No game data. Ensure objects.xml and tiles.xml are loaded in the proxy data folder.'
          : 'Catalog is empty.';
      }
      updateGameWikiPanelVisibility();
      rebuildGameWikiFiltered();
      gameWikiSelectedType = null;
      renderGameWikiDetail();
      var sc0 = document.getElementById('game-wiki-scroll');
      if (sc0) sc0.scrollTop = 0;
      scheduleGameWikiListViewport();
      return;
    }
    updateGameWikiPanelVisibility();
    rebuildGameWikiFiltered();
    gameWikiSelectedType = null;
    renderGameWikiDetail();
    var sc = document.getElementById('game-wiki-scroll');
    if (sc) sc.scrollTop = 0;
    scheduleGameWikiListViewport();
  }

  function openGameWikiTab() {
    var loadEl = document.getElementById('game-wiki-loading');
    var emptyEl = document.getElementById('game-wiki-empty');
    var mainEl = document.getElementById('game-wiki-main');
    if (gameWikiLoaded) {
      if (loadEl) loadEl.classList.add('hidden');
      updateGameWikiPanelVisibility();
      rebuildGameWikiFiltered();
      scheduleGameWikiListViewport();
      renderGameWikiDetail();
      return;
    }
    if (gameWikiLoading) return;
    gameWikiLoading = true;
    if (loadEl) loadEl.classList.remove('hidden');
    if (emptyEl) emptyEl.classList.add('hidden');
    if (mainEl) mainEl.classList.add('hidden');
    requestGameWikiCatalog(false);
  }

  (function wireGameWikiTab() {
    var root = document.getElementById('tab-game-wiki');
    if (!root) return;
    root.addEventListener('click', function (ev) {
      var sn = ev.target.closest('.game-wiki-subnav-btn');
      if (sn && sn.dataset.gameWikiSection) {
        setGameWikiSection(sn.dataset.gameWikiSection);
        return;
      }
      var chip = ev.target.closest('.game-wiki-filter-chip');
      if (chip && chip.dataset.gameWikiClass != null) {
        if (gameWikiSection !== 'objects' && gameWikiSection !== 'tiles') return;
        gameWikiClassFilter = chip.dataset.gameWikiClass;
        var filterGroup = gameWikiSection === 'objects'
          ? document.getElementById('game-wiki-obj-filters')
          : document.getElementById('game-wiki-tile-filters');
        if (filterGroup) {
          filterGroup.querySelectorAll('.game-wiki-filter-chip').forEach(function (c) {
            c.classList.toggle('active', c.dataset.gameWikiClass === gameWikiClassFilter);
          });
        }
        rebuildGameWikiFiltered();
        var sc = document.getElementById('game-wiki-scroll');
        if (sc) sc.scrollTop = 0;
        scheduleGameWikiListViewport();
        return;
      }
      var r = ev.target.closest('.game-wiki-row');
      if (r && r.dataset && r.dataset.type != null && !r.classList.contains('game-wiki-row-empty')) {
        selectGameWikiRow(Number(r.dataset.type));
      }
    });
    var searchEl = document.getElementById('game-wiki-search');
    if (searchEl) {
      searchEl.addEventListener('input', function () {
        gameWikiSearchRaw = searchEl.value;
        if (gameWikiSearchTimer) clearTimeout(gameWikiSearchTimer);
        gameWikiSearchTimer = setTimeout(function () {
          gameWikiSearchTimer = null;
          rebuildGameWikiFiltered();
          var scrollEl = document.getElementById('game-wiki-scroll');
          if (scrollEl) scrollEl.scrollTop = 0;
          scheduleGameWikiListViewport();
        }, 200);
      });
    }
    var sortEl = document.getElementById('game-wiki-sort');
    if (sortEl) {
      sortEl.addEventListener('change', function () {
        gameWikiSortMode = sortEl.value;
        rebuildGameWikiFiltered();
        var scrollEl = document.getElementById('game-wiki-scroll');
        if (scrollEl) scrollEl.scrollTop = 0;
        scheduleGameWikiListViewport();
      });
    }
    var dungeonFilterEl = document.getElementById('game-wiki-dungeon-filter');
    if (dungeonFilterEl) {
      dungeonFilterEl.addEventListener('change', function () {
        gameWikiDungeonFilter = dungeonFilterEl.value;
        rebuildGameWikiFiltered();
        var scrollEl = document.getElementById('game-wiki-scroll');
        if (scrollEl) scrollEl.scrollTop = 0;
        scheduleGameWikiListViewport();
      });
    }
    var scrollEl = document.getElementById('game-wiki-scroll');
    if (scrollEl) {
      scrollEl.addEventListener('scroll', function () {
        scheduleGameWikiListViewport();
      }, { passive: true });
    }
    var refreshBtn = document.getElementById('game-wiki-refresh-btn');
    if (refreshBtn) {
      refreshBtn.addEventListener('click', function () {
        resetGameWikiOnWsClose();
        gameWikiLoading = true;
        var le = document.getElementById('game-wiki-loading');
        var me = document.getElementById('game-wiki-main');
        var ee = document.getElementById('game-wiki-empty');
        if (le) le.classList.remove('hidden');
        if (me) me.classList.add('hidden');
        if (ee) ee.classList.add('hidden');
        requestGameWikiCatalog(true);
      });
    }
    window.addEventListener('resize', function () {
      if (activeTab === 'game-wiki' && gameWikiLoaded) scheduleGameWikiListViewport();
    });
  })();

  window.openGameWikiEffects = function () {
    if (activeTab !== 'game-wiki') {
      var gwBtn = document.querySelector('.content-tab[data-tab="game-wiki"]');
      if (gwBtn) gwBtn.click();
    }
    setGameWikiSection('effects');
  };

  // ─── Server switch dropdown ─────────────────────────────

  var serverSelectPopulated = false;
  var pingAllAbort = null;
  var pingAllInterval = null;
  var lastPingResults = null;
  var PING_INTERVAL_MS = 10000;

  function populateServerSelect(plugins) {
    const serverPlugin = plugins.find(p => p.id === 'server-switch');
    if (!serverPlugin) return;

    const serverSetting = serverPlugin.settings.find(s => s.key === 'server');
    if (!serverSetting || !serverSetting.options) return;

    var wasPopulated = serverSelectPopulated;
    serverSelectBaseLabels = {};
    serverSelect.innerHTML = '';
    serverSetting.options.forEach(opt => {
      serverSelectBaseLabels[opt.value] = opt.label;
      const option = document.createElement('option');
      option.value = opt.value;
      option.textContent = opt.label;
      serverSelect.appendChild(option);
    });

    if (currentServerName) {
      serverSelect.value = currentServerName;
    }

    // Re-apply cached ping results so labels don't flash bare on rebuild
    if (showServerPing && lastPingResults) {
      applyPingResults(lastPingResults);
    }

    if (!wasPopulated) {
      serverSelectPopulated = true;
      if (showServerPing) startPingInterval();
    }
  }

  function applyPingResults(ping) {
    for (var j = 0; j < serverSelect.options.length; j++) {
      var o = serverSelect.options[j];
      var b = serverSelectBaseLabels[o.value];
      if (!b) continue;
      var ms = ping[o.value];
      o.textContent = b + (ms != null && ms >= 0 ? ' \u2014 ' + ms + ' ms' : ' \u2014 ? ms');
    }
  }

  function startPingInterval() {
    stopPingInterval();
    fetchServerPingsAndUpdateDropdown();
    pingAllInterval = setInterval(fetchServerPingsAndUpdateDropdown, PING_INTERVAL_MS);
  }

  function stopPingInterval() {
    if (pingAllInterval) { clearInterval(pingAllInterval); pingAllInterval = null; }
    if (pingAllAbort) { try { pingAllAbort.abort(); } catch (e) {} pingAllAbort = null; }
  }

  function fetchServerPingsAndUpdateDropdown() {
    if (!serverSelect) return;
    if (pingAllAbort) { try { pingAllAbort.abort(); } catch (e) {} }
    var controller = new AbortController();
    pingAllAbort = controller;
    fetch('/api/ping-all', { signal: controller.signal })
      .then(function (res) { return res.json(); })
      .then(function (ping) {
        if (pingAllAbort === controller) pingAllAbort = null;
        lastPingResults = ping;
        applyPingResults(ping);
      })
      .catch(function (err) {
        if (err && err.name === 'AbortError') return;
        if (pingAllAbort === controller) pingAllAbort = null;
      });
  }

  function updateServerSelectPingDisplay() {
    if (!serverSelect) return;
    if (showServerPing) {
      startPingInterval();
    } else {
      stopPingInterval();
      for (var i = 0; i < serverSelect.options.length; i++) {
        var opt = serverSelect.options[i];
        if (serverSelectBaseLabels[opt.value]) {
          opt.textContent = serverSelectBaseLabels[opt.value];
        }
      }
    }
  }

  // ─── Damage sniffer settings in damage tab ──────────────

  function renderDamageSettings(plugins) {
    if (!damageSettingsBar) return;
    const dsPlugin = plugins.find(p => p.id === 'damage-sniffer');
    if (!dsPlugin || !dsPlugin.settings || dsPlugin.settings.length === 0) {
      damageSettingsBar.innerHTML = '';
      return;
    }

    damageSettingsBar.innerHTML = '';

    function getDamageSettingLabel(setting) {
      var key = String((setting && setting.key) || '').toLowerCase();
      var label = String((setting && setting.label) || '').toLowerCase();
      if (key === 'minbosshp' || label === 'min boss hp') return t('damage.setting.minBossHp');
      if (key === 'minminibosshp' || key === 'minibosshp' || label === 'min miniboss hp' || label === 'min mini boss hp') {
        return t('damage.setting.minMiniBossHp');
      }
      if (key === 'ingamealerts' || key === 'gamealerts' || label === 'in-game alerts' || label === 'ingame alerts') {
        return t('damage.setting.inGameAlerts');
      }
      return setting && setting.label ? String(setting.label) : '';
    }

    dsPlugin.settings.forEach(s => {
      const row = document.createElement('div');
      row.className = 'setting-row';

      const label = document.createElement('span');
      label.className = 'setting-label';
      label.textContent = getDamageSettingLabel(s);
      row.appendChild(label);

      const control = document.createElement('div');
      control.className = 'setting-control';

        if (s.type === 'number') {
          const input = document.createElement('input');
          input.type = 'text';
          input.inputMode = 'numeric';
          input.className = 'settings-number-input';
          input.value = s.value;
          input.addEventListener('change', () => {
            var nextValue = Number(input.value);
            if (!Number.isFinite(nextValue)) {
              input.value = String(s.value ?? '');
              return;
            }
            if (s.min !== undefined) nextValue = Math.max(Number(s.min), nextValue);
            if (s.max !== undefined) nextValue = Math.min(Number(s.max), nextValue);
            input.value = String(nextValue);
            ws.send(JSON.stringify({
              type: 'updateSetting',
              pluginId: dsPlugin.id,
              key: s.key,
              value: nextValue,
            }));
          });
          control.appendChild(input);
      } else if (s.type === 'boolean') {
        const toggle = document.createElement('label');
        toggle.className = 'toggle-switch';
        toggle.innerHTML =
          '<input type="checkbox" ' + (s.value ? 'checked' : '') + '>' +
          '<span class="toggle-slider"></span>';
        const cb = toggle.querySelector('input');
        cb.addEventListener('change', () => {
          ws.send(JSON.stringify({
            type: 'updateSetting',
            pluginId: dsPlugin.id,
            key: s.key,
            value: cb.checked,
          }));
        });
        control.appendChild(toggle);
      }

      row.appendChild(control);
      damageSettingsBar.appendChild(row);
    });
  }

  serverSelect.addEventListener('change', () => {
    const val = serverSelect.value;
    if (!val) return;
    ws.send(JSON.stringify({
      type: 'updateSetting',
      pluginId: 'server-switch',
      key: 'server',
      value: val,
    }));
    addHomeFeed('act', 'Server switch requested: ' + val);
  });

  // ─── IP Connect ─────────────────────────────────────────

  ipConnectBtn.addEventListener('click', () => {
    const ip = ipInput.value.trim();
    if (!ip) return;

    ws.send(JSON.stringify({ type: 'updateSetting', pluginId: 'ip-connect', key: 'ip', value: ip }));
    ws.send(JSON.stringify({ type: 'updateSetting', pluginId: 'ip-connect', key: 'port', value: 2050 }));
    ws.send(JSON.stringify({ type: 'updateSetting', pluginId: 'ip-connect', key: 'gameId', value: -2 }));

    setTimeout(() => {
      ws.send(JSON.stringify({ type: 'updateSetting', pluginId: 'ip-connect', key: 'connect', value: true }));
    }, 50);
    addHomeFeed('act', 'IP connect requested: ' + ip + ':2050');
  });

  ipInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') ipConnectBtn.click();
  });

  // ─── Plugin data handler ────────────────────────────────

  // ── Plugin modal ─────────────────────────────────────────

  (function initPluginModal() {
    var overlay   = document.getElementById('plugin-modal');
    var backdrop  = document.getElementById('plugin-modal-backdrop');
    var closeBtn  = document.getElementById('plugin-modal-close');
    var titleEl   = document.getElementById('plugin-modal-title');
    var bodyEl    = document.getElementById('plugin-modal-body');
    if (!overlay) return;

    function closeModal() { overlay.classList.add('hidden'); }
    closeBtn.addEventListener('click', closeModal);
    backdrop.addEventListener('click', closeModal);

    function escClose(e) { if (e.key === 'Escape') closeModal(); }
    document.addEventListener('keydown', escClose);

    window._showPluginModal = function(pluginId, data) {
      titleEl.textContent = data.title || 'Plugin';
      bodyEl.innerHTML = '';

      if (data.modal === 'listHelp') {
        bodyEl.innerHTML =
          '<p class="plugin-modal-help-desc">Use these lists to override the normal loot logic for specific items.</p>' +
          '<div class="plugin-modal-section">' +
            '<div class="plugin-modal-section-title">How it works</div>' +
            '<p style="margin:0 0 6px"><span class="plugin-modal-tag always">Whitelist</span>Always looted — overrides tier &amp; type filters.</p>' +
            '<p style="margin:0"><span class="plugin-modal-tag never">Blacklist</span>Never looted — overrides the whitelist too.</p>' +
          '</div>' +
          '<div class="plugin-modal-section">' +
            '<div class="plugin-modal-section-title">File locations</div>' +
            '<p style="margin:0 0 4px">Save these files in <code style="font-size:11px;background:rgba(0,0,0,.3);padding:1px 5px;border-radius:4px">Documents\\Realmengine\\</code></p>' +
            '<div class="plugin-modal-code">autoloot-whitelist.json\nautoloot-blacklist.json</div>' +
          '</div>' +
          '<div class="plugin-modal-section">' +
            '<div class="plugin-modal-section-title">JSON format</div>' +
            '<p style="margin:0 0 6px">Simple array of item IDs (decimal):</p>' +
            '<div class="plugin-modal-code">[12345, 67890, 11223]</div>' +
            '<p style="margin:6px 0">With optional notes for your reference:</p>' +
            '<div class="plugin-modal-code">[\n  { "id": 12345, "note": "Tablet" },\n  { "id": 67890, "note": "Conflict Shard" }\n]</div>' +
            '<p class="plugin-modal-note">Item IDs are decimal. Find them in the Game Wiki tab (convert hex → decimal) or on rotmg databases.</p>' +
          '</div>' +
          '<div class="plugin-modal-section">' +
            '<div class="plugin-modal-section-title">After editing</div>' +
            '<p style="margin:0">Use the <strong>Edit Whitelist / Edit Blacklist</strong> buttons to edit and save directly from here, or click <strong>Reload Lists from Disk</strong> after editing the files manually.</p>' +
          '</div>';

      } else if (data.modal === 'editList') {
        var descEl = document.createElement('p');
        descEl.className = 'plugin-modal-edit-desc';
        descEl.innerHTML = data.description || '';
        bodyEl.appendChild(descEl);

        var textarea = document.createElement('textarea');
        textarea.className = 'plugin-modal-textarea';
        textarea.value = typeof data.current === 'string' ? data.current : '[]';
        textarea.placeholder = '[\n  12345,\n  67890\n]';
        textarea.spellcheck = false;
        bodyEl.appendChild(textarea);

        // File import row
        var fileInput = document.createElement('input');
        fileInput.type = 'file';
        fileInput.accept = '.json';
        fileInput.style.display = 'none';
        bodyEl.appendChild(fileInput);

        var fileRow = document.createElement('div');
        fileRow.className = 'plugin-modal-file-row';
        var fileLabel = document.createElement('span');
        fileLabel.className = 'plugin-modal-file-label';
        fileLabel.textContent = 'Or import a .json file';
        var importBtn = document.createElement('button');
        importBtn.className = 'plugin-modal-btn plugin-modal-btn-ghost';
        importBtn.type = 'button';
        importBtn.textContent = 'Browse…';
        importBtn.addEventListener('click', function() { fileInput.click(); });
        fileInput.addEventListener('change', function() {
          var file = fileInput.files && fileInput.files[0];
          if (!file) return;
          var reader = new FileReader();
          reader.onload = function(ev) {
            textarea.value = String(ev.target.result || '');
            textarea.classList.remove('plugin-modal-textarea-error');
            fileLabel.textContent = file.name;
          };
          reader.readAsText(file);
        });
        fileRow.appendChild(fileLabel);
        fileRow.appendChild(importBtn);
        bodyEl.appendChild(fileRow);

        // Actions row
        var actionsRow = document.createElement('div');
        actionsRow.className = 'plugin-modal-actions';
        var errorEl = document.createElement('span');
        errorEl.className = 'plugin-modal-error';
        var cancelBtn = document.createElement('button');
        cancelBtn.className = 'plugin-modal-btn plugin-modal-btn-ghost';
        cancelBtn.type = 'button';
        cancelBtn.textContent = 'Cancel';
        cancelBtn.addEventListener('click', closeModal);
        var saveBtn = document.createElement('button');
        saveBtn.className = 'plugin-modal-btn plugin-modal-btn-primary';
        saveBtn.type = 'button';
        saveBtn.textContent = 'Save';
        saveBtn.addEventListener('click', function() {
          var content = textarea.value.trim();
          try {
            JSON.parse(content);
          } catch (e) {
            textarea.classList.add('plugin-modal-textarea-error');
            errorEl.textContent = 'Invalid JSON: ' + e.message;
            return;
          }
          textarea.classList.remove('plugin-modal-textarea-error');
          errorEl.textContent = '';
          if (ws && ws.readyState === 1) {
            ws.send(JSON.stringify({
              type: 'updateSetting',
              pluginId: pluginId,
              key: data.saveKey,
              value: content,
            }));
          }
          closeModal();
        });
        actionsRow.appendChild(errorEl);
        actionsRow.appendChild(cancelBtn);
        actionsRow.appendChild(saveBtn);
        bodyEl.appendChild(actionsRow);
      }

      overlay.classList.remove('hidden');
    };
  })();

  // ─────────────────────────────────────────────────────────

  function handlePluginData(msg) {
    if (msg.dataType === 'openModal' && msg.data && typeof window._showPluginModal === 'function') {
      window._showPluginModal(msg.pluginId, msg.data);
      return;
    }
    if (msg.pluginId !== 'damage-sniffer') return;

    if (msg.dataType === 'damageHistory') {
      damageHistory = Array.isArray(msg.data) ? msg.data : [];
      // If we were pointing at history but it shrank, clamp selection
      if (damageSelectedRun !== 'live' && typeof damageSelectedRun === 'number') {
        if (damageSelectedRun < 0 || damageSelectedRun >= damageHistory.length) {
          damageSelectedRun = 'live';
          damageSelectedTargetId = null;
        }
      }
      // Count new boss kills into the active session, if any.
      try {
        if (window._AccountSessions) window._AccountSessions.observeDamageHistory(damageHistory);
      } catch (_) {}
      if (activeTab === 'damage') renderDamageTab();
    } else if (msg.dataType === 'damageLive') {
      damageLive = msg.data || null;
      if (activeTab === 'damage') renderDamageTab();
    } else if (msg.dataType === 'encounterHistory') {
      // Backward compat (old model)
      // Keep it around for older branches; we don't render it anymore.
    } else if (msg.dataType === 'encounterComplete') {
      // Backward compat (old model)
    }
  }

  // ─── Damage Sniffer tab rendering ───────────────────────

  function renderDamageTab() {
    if (!damageEmpty || !damageSplitEl) return;

    const liveTargets = Array.isArray(damageLive && damageLive.targets) ? damageLive.targets : [];
    const hasHistory = Array.isArray(damageHistory) && damageHistory.length > 0;
    const hasAnyData = liveTargets.length > 0 || (hasHistory && damageHistory.some(r => r && Array.isArray(r.targets) && r.targets.length > 0));

    if (!hasAnyData) {
      damageEmpty.style.display = 'block';
      damageSplitEl.style.display = 'none';
      damageSelectedPlayerId = null;
      closeDamagePlayerModal();
      return;
    }

    damageEmpty.style.display = 'none';
    damageSplitEl.style.display = '';

    // Ensure a valid run selection
    if (damageSelectedRun !== 'live' && typeof damageSelectedRun === 'number') {
      if (!hasHistory || damageSelectedRun < 0 || damageSelectedRun >= damageHistory.length) {
        damageSelectedRun = 'live';
        damageSelectedTargetId = null;
        damageSelectedPlayerId = null;
      }
    }

    // Render run list (Live + history)
    renderDamageRunList();

    const run = getSelectedDamageRun();
    if (damageContextEl) {
      const tag = run.isLive ? 'LIVE' : 'RUN';
      const map = run.mapName || 'Unknown';
      damageContextEl.textContent = map + ' | ' + tag + ' | ' + run.targets.length + ' targets';
    }

    // Render target list + player breakdown
    renderDamageTargetList(run);
    renderDamagePlayerBreakdown(run);
  }

  function renderDamageRunList() {
    if (!damageRunListEl) return;
    damageRunListEl.innerHTML = '';

    const live = {
      mapName: damageLive && damageLive.mapName ? damageLive.mapName : '',
      startTime: damageLive && typeof damageLive.startTime === 'number' ? damageLive.startTime : Date.now(),
      now: damageLive && typeof damageLive.now === 'number' ? damageLive.now : Date.now(),
      targets: Array.isArray(damageLive && damageLive.targets) ? damageLive.targets : [],
    };

    const liveRow = document.createElement('div');
    liveRow.className = 'damage-run' + (damageSelectedRun === 'live' ? ' selected' : '');
    liveRow.addEventListener('click', () => {
      damageSelectedRun = 'live';
      damageSelectedTargetId = null;
      damageSelectedPlayerId = null;
      renderDamageTab();
    });
    liveRow.innerHTML =
      '<div class="damage-run-title">' +
        '<div class="damage-run-map">' + escapeHtml(live.mapName || 'Live') + '</div>' +
        '<div class="damage-run-badge">LIVE</div>' +
      '</div>' +
      '<div class="damage-run-meta">' +
        '<span>' + Math.max(0, (live.now - live.startTime) / 1000).toFixed(0) + 's</span>' +
        '<span>' + live.targets.length + ' targets</span>' +
      '</div>';
    damageRunListEl.appendChild(liveRow);

    if (!Array.isArray(damageHistory) || damageHistory.length === 0) return;

    for (let i = damageHistory.length - 1; i >= 0; i--) {
      const r = damageHistory[i];
      if (!r) continue;
      const row = document.createElement('div');
      row.className = 'damage-run' + (damageSelectedRun === i ? ' selected' : '');
      row.addEventListener('click', () => {
        damageSelectedRun = i;
        damageSelectedTargetId = null;
        damageSelectedPlayerId = null;
        renderDamageTab();
      });
      row.innerHTML =
        '<div class="damage-run-title">' +
          '<div class="damage-run-map">' + escapeHtml(r.mapName || 'Unknown') + '</div>' +
          '<div class="damage-run-badge">' + formatEncounterTime(r.timestamp || r.endTime || Date.now()) + '</div>' +
        '</div>' +
        '<div class="damage-run-meta">' +
          '<span>' + (typeof r.durationSec === 'number' ? r.durationSec.toFixed(0) : Math.max(0, (r.endTime - r.startTime) / 1000).toFixed(0)) + 's</span>' +
          '<span>' + (Array.isArray(r.targets) ? r.targets.length : 0) + ' targets</span>' +
        '</div>';
      damageRunListEl.appendChild(row);
    }
  }

  function getSelectedDamageRun() {
    if (damageSelectedRun === 'live') {
      return {
        isLive: true,
        mapName: damageLive && damageLive.mapName ? String(damageLive.mapName) : '',
        startTime: damageLive && typeof damageLive.startTime === 'number' ? damageLive.startTime : Date.now(),
        endTime: null,
        localPlayerId: (damageLive && Number.isFinite(Number(damageLive.localPlayerId))) ? Number(damageLive.localPlayerId) : null,
        targets: Array.isArray(damageLive && damageLive.targets) ? damageLive.targets : [],
      };
    }

    const idx = typeof damageSelectedRun === 'number' ? damageSelectedRun : -1;
    const r = (Array.isArray(damageHistory) && idx >= 0 && idx < damageHistory.length) ? damageHistory[idx] : null;
    return {
      isLive: false,
      mapName: r && r.mapName ? String(r.mapName) : '',
      startTime: r && typeof r.startTime === 'number' ? r.startTime : 0,
      endTime: r && typeof r.endTime === 'number' ? r.endTime : null,
      localPlayerId: (r && Number.isFinite(Number(r.localPlayerId))) ? Number(r.localPlayerId) : null,
      targets: r && Array.isArray(r.targets) ? r.targets : [],
    };
  }

  function renderDamageTargetList(run) {
    if (!damageTargetListEl) return;
    damageTargetListEl.innerHTML = '';

    let targets = Array.isArray(run.targets) ? run.targets.slice() : [];
    targets = targets.filter(t => {
      if (!t) return false;
      if (damageFilter === 'boss') return !!t.boss;
      if (damageFilter === 'miniboss') return !!t.miniboss;
      return true;
    });

    targets.sort((a, b) => {
      const aPlayers = Array.isArray(a.players) ? a.players : [];
      const bPlayers = Array.isArray(b.players) ? b.players : [];
      const aTotal = aPlayers.reduce((s, p) => s + (p.damage || 0), 0);
      const bTotal = bPlayers.reduce((s, p) => s + (p.damage || 0), 0);
      if (damageSort === 'damage') return bTotal - aTotal;
      if (damageSort === 'duration') return (b.durationSec || 0) - (a.durationSec || 0);
      if (damageSort === 'name') return String(a.targetName || '').localeCompare(String(b.targetName || ''));
      // default: recent
      return (b.lastHitAt || 0) - (a.lastHitAt || 0);
    });

    if (targets.length === 0) {
      damageSelectedTargetId = null;
      damageSelectedPlayerId = null;
      const empty = document.createElement('div');
      empty.className = 'empty-state';
      empty.textContent = 'No targets match filter.';
      damageTargetListEl.appendChild(empty);
      return;
    }

    // Keep selection if possible
    const exists = damageSelectedTargetId != null && targets.some(t => t.targetObjectId === damageSelectedTargetId);
    if (!exists) {
      damageSelectedTargetId = null;
      damageSelectedPlayerId = null;
    }

    targets.forEach((t) => {
      const el = document.createElement('div');
      el.className = 'damage-target' + (t.targetObjectId === damageSelectedTargetId ? ' selected' : '');
      el.addEventListener('click', () => {
        damageSelectedTargetId = t.targetObjectId;
        damageSelectedPlayerId = null;
        renderDamageTargetList(run);
        renderDamagePlayerBreakdown(run);
      });

      const tags = [];
      if (t.boss) tags.push('<span class="damage-tag boss">Boss</span>');
      if (t.miniboss) tags.push('<span class="damage-tag miniboss">Mini</span>');

      const total = Array.isArray(t.players) ? t.players.reduce((s, p) => s + (p.damage || 0), 0) : 0;
      const maxHp = typeof t.targetMaxHp === 'number' ? t.targetMaxHp : 0;
      const pctOfHp = maxHp > 0 ? ((total / maxHp) * 100).toFixed(1) : null;
      const killed = t.killed ? 'killed' : 'active';

      el.innerHTML =
        '<div class="damage-target-top">' +
          '<div class="damage-target-name">' + escapeHtml(t.targetName || ('0x' + (t.targetType || 0).toString(16))) + '</div>' +
          '<div class="damage-target-tags">' + tags.join('') + '</div>' +
        '</div>' +
        '<div class="damage-target-meta">' +
          '<span>' + (killed === 'killed' ? 'killed' : 'active') + '</span>' +
          '<span>' + (typeof t.durationSec === 'number' ? t.durationSec.toFixed(1) : '0.0') + 's</span>' +
          '<span>' + formatNumber(total) + ' / ' + (maxHp > 0 ? formatNumber(maxHp) : '?') + ' HP</span>' +
          (pctOfHp != null ? '<span>' + pctOfHp + '% HP</span>' : '') +
        '</div>';

      damageTargetListEl.appendChild(el);
    });
  }

  function calcDamagePerMinute(damage, durationSec) {
    const dmg = Number(damage);
    const sec = Number(durationSec);
    if (!Number.isFinite(dmg) || dmg <= 0 || !Number.isFinite(sec) || sec <= 0) return 0;
    return (dmg * 60) / sec;
  }

  function openDamagePlayerModal() {
    if (damagePlayerModalOverlayEl) damagePlayerModalOverlayEl.style.display = 'flex';
  }

  function closeDamagePlayerModal() {
    if (damagePlayerModalOverlayEl) damagePlayerModalOverlayEl.style.display = 'none';
    if (damagePlayerDetailEmptyEl && damageSelectedTargetId != null) {
      damagePlayerDetailEmptyEl.style.display = '';
      damagePlayerDetailEmptyEl.textContent = 'Click a player to view detailed stats.';
    }
  }

  function renderDamagePlayerDetailPanel(run, target, player, isLocalPlayer) {
    if (!damagePlayerDetailEl || !damagePlayerDetailEmptyEl) return;

    if (!target || !player) {
      closeDamagePlayerModal();
      damagePlayerDetailEmptyEl.style.display = '';
      damagePlayerDetailEmptyEl.textContent = 'Click a player to view detailed stats.';
      return;
    }

    const localBadge = isLocalPlayer ? '<span class="dpr-local-badge">YOU</span>' : '';
    const currentTargetDpm = calcDamagePerMinute(player.damage || 0, target.durationSec || 0);
    const classTypeRaw = Number(player.classType);
    const classType = Number.isFinite(classTypeRaw) && classTypeRaw > 0 ? Math.trunc(classTypeRaw) : 0;
    const className = classType > 0 ? (CLASS_NAMES[classType] || 'Unknown') : 'Unknown';
    const classDisplay = classType > 0 ? (className + ' (0x' + classType.toString(16) + ')') : className;

    const eq = player.equipTop || {};
    var detailEe = player.equipEnchants || {};
    const renderDetailSlot = (slotName, id, enchantIds) => {
      const objectType = Number(id);
      const item = (!Number.isFinite(objectType) || objectType <= 0)
        ? { objectType: -1 }
        : {
            objectType: objectType,
            name: String((getEamItemRecord(objectType) && getEamItemRecord(objectType)[0]) || ('Type ' + String(objectType))),
            objectTypeHex: '0x' + objectType.toString(16),
            enchantIds: Array.isArray(enchantIds) ? enchantIds : [],
          };
      const tip = slotName + ': ' + getEquipmentItemLabel(item);
      return '<span class="damage-eq-slot" title="' + escapeHtml(tip) + '">' +
        buildItemSpriteHtml(item, 'damage-eq-sprite') +
      '</span>';
    };

    damagePlayerDetailEl.innerHTML =
      '<div class="damage-player-detail-head">' +
        '<div class="damage-player-detail-name">' + escapeHtml(player.name || ('Player_' + player.objectId)) + localBadge + '</div>' +
        '<div class="damage-player-detail-sub">Target: ' + escapeHtml(target.targetName || 'Target') + '</div>' +
      '</div>' +
      '<div class="damage-player-detail-stats">' +
        '<div class="damage-detail-stat"><span class="damage-detail-label">Character Type</span><span class="damage-detail-value">' + escapeHtml(classDisplay) + '</span></div>' +
        '<div class="damage-detail-stat"><span class="damage-detail-label" title="All non-summon damage (weapon + ability share the same packets)">Weapon damage</span><span class="damage-detail-value">' + formatNumber(player.weaponDamage || 0) + '</span></div>' +
        '<div class="damage-detail-stat"><span class="damage-detail-label" title="Pets, traps, and other summons attributed to you">Summon damage</span><span class="damage-detail-value">' + formatNumber(player.summonDamage || 0) + '</span></div>' +
        '<div class="damage-detail-stat"><span class="damage-detail-label">Damage Taken</span><span class="damage-detail-value">' + formatNumber(player.damageTaken || 0) + '</span></div>' +
        '<div class="damage-detail-stat"><span class="damage-detail-label">Hits Received</span><span class="damage-detail-value">' + formatNumber(player.hitsTaken || 0) + '</span></div>' +
        '<div class="damage-detail-stat"><span class="damage-detail-label">Guarded Hits</span><span class="damage-detail-value">' + formatNumber(player.guardedHits || 0) + '</span></div>' +
        '<div class="damage-detail-stat"><span class="damage-detail-label">Guarded Damage</span><span class="damage-detail-value">' + formatNumber(player.guardedDamage || 0) + '</span></div>' +
        '<div class="damage-detail-stat"><span class="damage-detail-label">Current Target DPM</span><span class="damage-detail-value">' + formatNumber(Math.round(currentTargetDpm)) + '</span></div>' +
      '</div>' +
      '<div class="damage-detail-equip">' +
        '<div class="damage-detail-equip-strip">' +
          renderDetailSlot('Weapon', eq.wpn, detailEe.wpn) +
          renderDetailSlot('Ability', eq.abl, detailEe.abl) +
          renderDetailSlot('Armor', eq.arm, detailEe.arm) +
          renderDetailSlot('Ring', eq.rng, detailEe.rng) +
        '</div>' +
      '</div>';

    damagePlayerDetailEmptyEl.style.display = 'none';
    openDamagePlayerModal();
  }

  function renderDamagePlayerBreakdown(run) {
    if (!damagePlayerBreakdownEl || !damagePlayerEmptyEl || !damagePlayerTitleEl || !damagePlayerDetailEl || !damagePlayerDetailEmptyEl) return;

    const t = Array.isArray(run.targets) ? run.targets.find(x => x && x.targetObjectId === damageSelectedTargetId) : null;
    const localPlayerId = Number.isFinite(Number(run.localPlayerId)) ? Number(run.localPlayerId) : null;
    damagePlayerBreakdownEl.innerHTML = '';

    if (!t) {
      damagePlayerTitleEl.textContent = 'Players';
      damagePlayerBreakdownEl.style.display = 'none';
      damagePlayerEmptyEl.style.display = 'block';
      closeDamagePlayerModal();
      damagePlayerDetailEmptyEl.style.display = 'none';
      return;
    }

    damagePlayerTitleEl.textContent = 'Players - ' + (t.targetName || 'Target');
    damagePlayerEmptyEl.style.display = 'none';
    damagePlayerBreakdownEl.style.display = '';

    const players = Array.isArray(t.players) ? t.players.slice() : [];
    players.sort((a, b) => (b.damage || 0) - (a.damage || 0));
    const selectedStillExists = damageSelectedPlayerId != null && players.some((p) => Number(p.objectId) === Number(damageSelectedPlayerId));
    if (!selectedStillExists) damageSelectedPlayerId = null;

    const header = document.createElement('div');
    header.className = 'damage-player-header';
    header.innerHTML =
      '<span class="dpr-rank">#</span>' +
      '<span class="dpr-player">Player</span>' +
      '<span class="dpr-hits">Hits</span>' +
      '<span class="dpr-damage">Damage</span>' +
      '<span class="dpr-pct">%Total</span>' +
      '<span class="dpr-eq">Equip</span>';
    damagePlayerBreakdownEl.appendChild(header);

    players.forEach((p, i) => {
      const playerId = Number(p.objectId);
      const isLocal = localPlayerId != null && playerId === localPlayerId;
      const isSelected = damageSelectedPlayerId != null && playerId === Number(damageSelectedPlayerId);
      const row = document.createElement('div');
      row.className = 'damage-player-row' + (isLocal ? ' local-player' : '') + (isSelected ? ' selected' : '');
      row.addEventListener('click', () => {
        damageSelectedPlayerId = playerId;
        renderDamagePlayerBreakdown(run);
      });

      let spriteHtml = '';
      const spriteUrl = getDamagePlayerPortraitUrl(p);
      if (spriteUrl) {
        spriteHtml = '<img class="et-player-sprite" src="' + spriteUrl + '" alt="">';
      }

      const eq = p.equipTop || {};
      var ee = p.equipEnchants || {};
      const fmtSlot = (label, id, enchantIds) => {
        const objectType = Number(id);
        const item = (!Number.isFinite(objectType) || objectType <= 0)
          ? { objectType: -1 }
          : {
              objectType: objectType,
              name: String((getEamItemRecord(objectType) && getEamItemRecord(objectType)[0]) || ('Type ' + String(objectType))),
              objectTypeHex: '0x' + objectType.toString(16),
              enchantIds: Array.isArray(enchantIds) ? enchantIds : [],
            };
        const tip = label + ': ' + getEquipmentItemLabel(item);
        return '<span class="damage-eq-slot" title="' + escapeHtml(tip) + '">' +
          buildItemSpriteHtml(item, 'damage-eq-sprite') +
          '</span>';
      };

      row.innerHTML =
        '<span class="dpr-rank">' + (i + 1) + '</span>' +
        '<span class="dpr-player">' +
          spriteHtml +
          '<span class="dpr-player-name">' + escapeHtml(p.name || ('Player_' + p.objectId)) + '</span>' +
          (isLocal ? '<span class="dpr-local-badge">YOU</span>' : '') +
        '</span>' +
        '<span class="dpr-hits">' + (p.hits || 0) + '</span>' +
        '<span class="dpr-damage"><span class="damage-value">' + formatNumber(p.damage || 0) + '</span></span>' +
        '<span class="dpr-pct">' + (p.pct != null ? p.pct : '0.0') + '%</span>' +
        '<span class="dpr-eq"><span class="damage-eq-strip">' +
          fmtSlot('W', eq.wpn, ee.wpn) +
          fmtSlot('A', eq.abl, ee.abl) +
          fmtSlot('R', eq.arm, ee.arm) +
          fmtSlot('G', eq.rng, ee.rng) +
        '</span></span>';

      damagePlayerBreakdownEl.appendChild(row);
    });

    const selectedPlayer = damageSelectedPlayerId == null
      ? null
      : players.find((p) => Number(p.objectId) === Number(damageSelectedPlayerId)) || null;
    renderDamagePlayerDetailPanel(run, t, selectedPlayer, !!(selectedPlayer && localPlayerId != null && Number(selectedPlayer.objectId) === localPlayerId));
  }

  function formatEncounterTime(timestamp) {
    const d = new Date(timestamp);
    const now = new Date();
    const diffMs = now - d;
    const diffMin = Math.floor(diffMs / 60000);

    if (diffMin < 1) return 'Just now';
    if (diffMin < 60) return diffMin + 'm ago';
    const diffHr = Math.floor(diffMin / 60);
    if (diffHr < 24) return diffHr + 'h ago';
    return d.toLocaleDateString();
  }

  // ─── Copy Image (RealmShark 1.9.2 IconDpsGUI replica) ───
  //
  // Pixel-accurate replica of the Swing paint() output from IconDpsGUI.java.
  // Layout per the Java source:
  //   TitledBorder(CENTER,CENTER): "{mapName} [{duration}]"
  //   Per entity — createMainBox():
  //     mobPanel: MatteBorder(1,0,1,0,GRAY), 48px height
  //       JLabel(mobName, largeIcon, LEFT) — icon left, text "{name} HP: {hp}\n [{dur}]"
  //     Per player row — BoxLayout.X_AXIS, 6 columns sized to max:
  //       [0] deathNexusLabel  ("Nexus" text or grave icon)
  //       [1] playerIconLabel  (text=" ->1", icon=classSprite, textPos=LEFT → text left, icon right)
  //       [2] nameLabel        (player name)
  //       [3] dpsDataLabel     ("DMG: %7d %6.3f%%")
  //       [4] counterLabel     ("[Guarded Hits:N Dmg:N]")
  //       [5] inv panel        (4 × smallIcon item sprites in GridLayout(1,4))
  //     EmptyBorder(0,0,5,0) between entity blocks
  //

  var damageCopyImageBtn = document.getElementById('damage-copy-image-btn');
  if (damageCopyImageBtn) {
    damageCopyImageBtn.addEventListener('click', function () {
      copyDamageImageToClipboard();
    });
  }

  // Java String.format("%Ns") right-pad equivalent
  function rsPad(str, width) {
    while (str.length < width) str = ' ' + str;
    return str;
  }

  // Matches DpsGUI.systemTimeToString() exactly
  function rsFmtDuration(ms) {
    if (!Number.isFinite(ms) || ms < 0) ms = 0;
    if (ms === 0) return ' [-]';
    var mil = ms % 1000;
    if (ms < 1000) return ' [' + mil + 'ms]';
    var s = Math.floor(ms / 1000) % 60;
    if (ms < 60000) return ' [' + s + 's ' + mil + 'ms]';
    var m = Math.floor(ms / 60000) % 60;
    if (ms < 3600000) return ' [' + m + 'm ' + s + 's ' + mil + 'ms]';
    var h = Math.floor(ms / 3600000);
    return ' [' + h + 'h ' + m + 'm ' + s + 's ' + mil + 'ms]';
  }

  // Draw 8×8 class sprite scaled to size
  function rsDrawClassSprite(ctx, classType, dx, dy, size) {
    var colors = CLASS_COLORS[classType] || ['#888888','#555555','#333333'];
    var cmap = { '.': null, 'S': SKIN_COLOR, 's': SKIN_SHADOW, 'P': colors[0], 'D': colors[1], 'H': colors[2] };
    var px = size / 8;
    for (var y = 0; y < 8; y++) {
      var row = SPRITE_TEMPLATE[y];
      for (var x = 0; x < 8; x++) {
        var c = cmap[row[x]];
        if (c) {
          ctx.fillStyle = c;
          ctx.fillRect(dx + x * px, dy + y * px, Math.ceil(px), Math.ceil(px));
        }
      }
    }
  }

  // Draw item from renders.png spritesheet
  function rsDrawItemSprite(ctx, rendersImg, objectType, dx, dy, size) {
    var ot = Number(objectType);
    if (!Number.isFinite(ot) || ot <= 0) return;
    var record = getEamItemRecord(ot);
    if (!record) return;
    var sx = Math.max(0, Number(record[3] || 0));
    var sy = Math.max(0, Number(record[4] || 0));
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(rendersImg, sx, sy, 40, 40, dx, dy, size, size);
  }

  function copyDamageImageToClipboard() {
    var run = getSelectedDamageRun();
    if (!run || !Array.isArray(run.targets) || run.targets.length === 0) return;

    var targets = run.targets.slice().filter(function (t) { return t && Array.isArray(t.players) && t.players.length > 0; });
    targets.sort(function (a, b) { return (b.targetMaxHp || 0) - (a.targetMaxHp || 0); });
    if (damageSelectedTargetId != null) {
      var sel = targets.find(function (t) { return t.targetObjectId === damageSelectedTargetId; });
      if (sel) targets = [sel];
    }
    targets = targets.slice(0, 10);
    if (targets.length === 0) return;

    var localPlayerId = Number.isFinite(Number(run.localPlayerId)) ? Number(run.localPlayerId) : null;

    var rendersImg = new Image();
    rendersImg.src = 'renders.png';
    var doDraw = function () {

      // --- Darklaf dark theme constants ---
      var BG     = '#3c3f41';
      var FG     = '#bbbbbb';
      var GRAY   = '#808080'; // java.awt.Color.GRAY
      var FS     = 12;        // mainFont size (default 12pt)
      var FONT   = FS + 'px Consolas, "Courier New", "Liberation Mono", monospace';
      var ICO_SM = Math.max(12, Math.round((16 * FS) / 12)); // smallIconSize()
      var ICO_LG = Math.max(24, Math.round((40 * FS) / 12)); // largeIconSize()

      // Swing metrics
      var mc = document.createElement('canvas').getContext('2d');
      mc.font = FONT;
      var lineH = Math.ceil(FS * 1.4);  // FontMetrics.getHeight() ≈ size*1.4
      var ROW_H = lineH + 5;            // pref[6] + 5 from the Java code

      // --- Build data ---
      var runDurMs = run.durationSec ? run.durationSec * 1000 :
        ((run.endTime || Date.now()) - (run.startTime || Date.now()));
      var titleStr = (run.mapName || 'Unknown') + rsFmtDuration(runDurMs);

      var blocks = [];
      targets.forEach(function (target) {
        var fightMs = target.durationSec ? target.durationSec * 1000 : 0;
        // mobName: "{name} HP: {hp}\n{fightTimer}"  (JLabel renders \n as two lines)
        var mobLine1 = (target.targetName || 'Unknown') + ' HP: ' + (target.targetMaxHp || 0);
        var mobLine2 = rsFmtDuration(fightMs);
        var players = target.players.slice();
        players.sort(function (a, b) { return (b.damage || 0) - (a.damage || 0); });
        var rows = [];
        players.forEach(function (p, i) {
          var isLocal = localPlayerId != null && Number(p.objectId) === localPlayerId;
          var maxHp = target.targetMaxHp || 0;
          var pctVal = maxHp > 0 ? ((p.damage || 0) * 100 / maxHp) : 0;
          var extra = '';
          if ((p.guardedHits || 0) > 0 || (p.guardedDamage || 0) > 0) {
            extra = '[Guarded Hits:' + (p.guardedHits || 0) + ' Dmg:' + (p.guardedDamage || 0) + ']';
          }
          // userIndicator: String.format("%s%d", user?" ->":"  ", counter)
          var userInd = (isLocal ? ' ->' : '  ') + (i + 1);
          rows.push({
            isLocal: isLocal,
            userInd: userInd,
            classType: Number(p.classType) || 0,
            portraitUrl: getDamagePlayerPortraitUrl(p),
            name: String(p.name || ('Player_' + p.objectId)),
            damage: p.damage || 0,
            pct: pctVal,
            extra: extra,
            eq: p.equipTop || {},
            ee: p.equipEnchants || {},
          });
        });
        blocks.push({ mobLine1: mobLine1, mobLine2: mobLine2, rows: rows });
      });

      // Pre-load portrait images (data URLs from cache — loads instantly if cached)
      var portraitPromises = [];
      blocks.forEach(function (b) {
        b.rows.forEach(function (r) {
          if (r.portraitUrl) {
            var img = new Image();
            img.src = r.portraitUrl;
            r.portraitImg = img;
            if (!img.complete) {
              portraitPromises.push(new Promise(function (resolve) {
                img.onload = resolve;
                img.onerror = resolve;
              }));
            }
          }
        });
      });
      // Wait for any pending portrait loads, then continue drawing
      if (portraitPromises.length > 0) {
        Promise.all(portraitPromises).then(doDrawCanvas);
        return;
      }
      doDrawCanvas();

      function doDrawCanvas() {

      // --- Measure 6 column widths (Swing pref[] logic) ---
      // Each col width = max(component.preferredSize.width + 5) across all rows
      var pref = [0, 0, 0, 0, 0, 0, 0]; // [0..5]=col widths, [6]=max row height

      // Col 0: deathNexusLabel — min width = max(ICO_SM, getStringSize("Nexus")+6)
      var nexusTextW = mc.measureText('Nexus').width + 6;
      pref[0] = Math.max(ICO_SM, nexusTextW);

      blocks.forEach(function (b) {
        b.rows.forEach(function (r) {
          // Col 1: playerIconLabel preferred width = textWidth + iconGap + iconWidth
          //   JLabel with text + icon: preferredSize.width ≈ textWidth + iconTextGap(4) + iconWidth
          var indW = mc.measureText(r.userInd).width + 4 + ICO_SM;
          pref[1] = Math.max(pref[1], indW + 5);

          // Col 2: nameLabel
          var nameW = mc.measureText(r.name).width;
          pref[2] = Math.max(pref[2], nameW + 5);

          // Col 3: dpsDataLabel  "DMG: %7d %6.3f%%"
          var dpsStr = 'DMG: ' + rsPad(String(r.damage), 7) + ' ' + rsPad(r.pct.toFixed(3), 6) + '%';
          var dpsW = mc.measureText(dpsStr).width;
          pref[3] = Math.max(pref[3], dpsW + 5);

          // Col 4: counterLabel
          if (r.extra) {
            var extraW = mc.measureText(r.extra).width;
            pref[4] = Math.max(pref[4], extraW + 5);
          }

          // Col 5: inv panel = 4 * ICO_SM + 12 (GridLayout gaps)
          var invW = ICO_SM * 4 + 12;
          pref[5] = Math.max(pref[5], invW + 5);

          // pref[6]: max row height = nameLabel.preferredSize.height
          pref[6] = Math.max(pref[6], lineH);
        });
      });

      ROW_H = pref[6] + 5;
      var totalColW = pref[0] + pref[1] + pref[2] + pref[3] + pref[4] + pref[5];

      // Boss panel width: getStringSize(mobName) + 48  (48 = icon space)
      var maxBossW = 0;
      blocks.forEach(function (b) {
        var w1 = mc.measureText(b.mobLine1).width;
        var w2 = mc.measureText(b.mobLine2).width;
        var w = Math.max(w1, w2) + ICO_LG + 8;
        if (w > maxBossW) maxBossW = w;
      });

      // TitledBorder adds ~20px insets on each side
      var titleTextW = mc.measureText(titleStr).width;
      var titleBoxW = titleTextW + 40;

      var canvasW = Math.ceil(Math.max(totalColW, maxBossW, titleBoxW));

      // --- Canvas height ---
      // TitledBorder panel: ~(lineH + 10) for border + title
      var titleBoxH = lineH + 10;
      var totalH = titleBoxH + 4; // gap after title

      blocks.forEach(function (b) {
        // mobPanel: 48px height + MatteBorder(1,0,1,0)
        totalH += 48 + 2;
        // player rows
        totalH += b.rows.length * ROW_H;
        // EmptyBorder(0,0,5,0) after each block
        totalH += 5;
      });

      var canvasH = Math.ceil(totalH + 4);

      var canvas = document.createElement('canvas');
      canvas.width = canvasW;
      canvas.height = canvasH;
      var ctx = canvas.getContext('2d');

      // --- Fill background ---
      ctx.fillStyle = BG;
      ctx.fillRect(0, 0, canvasW, canvasH);

      var curY = 0;

      // --- TitledBorder (CENTER, CENTER) ---
      // Darklaf TitledBorder: rounded rect with gap at top for text
      var tbInset = 6;
      var tbTop = Math.floor(lineH / 2);
      var tbLeft = tbInset;
      var tbRight = canvasW - tbInset;
      var tbBottom = titleBoxH;

      // Border rect (with gap for title)
      var titleGapW = titleTextW + 8;
      var titleGapX = Math.floor((canvasW - titleGapW) / 2);

      ctx.strokeStyle = GRAY;
      ctx.lineWidth = 1;
      // Top line left segment
      ctx.beginPath();
      ctx.moveTo(tbLeft, tbTop + 0.5);
      ctx.lineTo(titleGapX, tbTop + 0.5);
      ctx.stroke();
      // Top line right segment
      ctx.beginPath();
      ctx.moveTo(titleGapX + titleGapW, tbTop + 0.5);
      ctx.lineTo(tbRight, tbTop + 0.5);
      ctx.stroke();
      // Left, bottom, right
      ctx.beginPath();
      ctx.moveTo(tbLeft + 0.5, tbTop);
      ctx.lineTo(tbLeft + 0.5, tbBottom);
      ctx.lineTo(tbRight - 0.5, tbBottom);
      ctx.lineTo(tbRight - 0.5, tbTop);
      ctx.stroke();

      // Title text centered in the gap
      ctx.font = FONT;
      ctx.fillStyle = FG;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(titleStr, canvasW / 2, tbTop);

      curY = tbBottom + 4;

      // --- Entity blocks ---
      blocks.forEach(function (block) {

        // mobPanel: MatteBorder(1,0,1,0, Color.GRAY), height 48
        var mobH = 48;
        // Top border
        ctx.strokeStyle = GRAY;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(0, curY + 0.5);
        ctx.lineTo(canvasW, curY + 0.5);
        ctx.stroke();
        // Bottom border
        ctx.beginPath();
        ctx.moveTo(0, curY + mobH + 0.5);
        ctx.lineTo(canvasW, curY + mobH + 0.5);
        ctx.stroke();

        // Large boss icon (placeholder — we don't have enemy sprites)
        var iconX = 4;
        var iconY = curY + Math.floor((mobH - ICO_LG) / 2) + 1;
        ctx.fillStyle = '#555';
        ctx.fillRect(iconX, iconY, ICO_LG, ICO_LG);

        // Boss text: two lines to the right of icon
        var textX = iconX + ICO_LG + 6;
        ctx.fillStyle = FG;
        ctx.font = FONT;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'alphabetic';
        ctx.fillText(block.mobLine1, textX, curY + mobH / 2 - 2);
        ctx.fillText(block.mobLine2, textX, curY + mobH / 2 + lineH - 2);

        curY += mobH + 2; // +2 for both 1px borders

        // Player rows
        block.rows.forEach(function (r) {
          var midY = curY + Math.floor(ROW_H / 2);
          var x = 0;

          // Col 0: deathNexusLabel — empty for now (nexus tracking not implemented)
          x += pref[0];

          // Col 1: playerIconLabel — text LEFT of icon (SwingConstants.LEFT)
          //   Swing JLabel with textPosition=LEFT: [text][gap][icon]
          ctx.fillStyle = FG;
          ctx.font = FONT;
          ctx.textAlign = 'left';
          ctx.textBaseline = 'middle';
          var indTextW = mc.measureText(r.userInd).width;
          ctx.fillText(r.userInd, x, midY);
          // Player portrait or class sprite
          var spriteX = x + indTextW + 4;
          var spriteY = midY - Math.floor(ICO_SM / 2);
          if (r.portraitImg && r.portraitImg.complete && r.portraitImg.naturalWidth > 0) {
            ctx.imageSmoothingEnabled = false;
            ctx.drawImage(r.portraitImg, spriteX, spriteY, ICO_SM, ICO_SM);
          } else if (r.classType > 0) {
            rsDrawClassSprite(ctx, r.classType, spriteX, spriteY, ICO_SM);
          }
          x += pref[1];

          // Col 2: nameLabel — right-aligned within column
          ctx.fillStyle = FG;
          ctx.textAlign = 'right';
          ctx.textBaseline = 'middle';
          ctx.fillText(r.name, x + pref[2] - 5, midY);
          x += pref[2];

          // Col 3: dpsDataLabel — left-aligned
          var dpsStr = 'DMG: ' + rsPad(String(r.damage), 7) + ' ' + rsPad(r.pct.toFixed(3), 6) + '%';
          ctx.fillStyle = FG;
          ctx.textAlign = 'left';
          ctx.fillText(dpsStr, x, midY);
          x += pref[3];

          // Col 4: counterLabel — right-aligned (has HorizontalGlue before it)
          if (r.extra) {
            ctx.fillStyle = FG;
            ctx.textAlign = 'right';
            ctx.fillText(r.extra, x + pref[4] - 5, midY);
          }
          x += pref[4];

          // Col 5: inv panel — 4 item sprites in GridLayout(1,4) with enchant glow
          var cellW = Math.floor(pref[5] / 4);
          var eqSlots = [r.eq.wpn, r.eq.abl, r.eq.arm, r.eq.rng];
          var eeSlots = [r.ee.wpn, r.ee.abl, r.ee.arm, r.ee.rng];
          eqSlots.forEach(function (slotId, si) {
            var sx = x + si * cellW + Math.floor((cellW - ICO_SM) / 2);
            var sy = midY - Math.floor(ICO_SM / 2);
            // Enchant glow (RealmShark: 1=green, 2=cyan, 3=purple, 4=gold)
            var slotEnchants = Array.isArray(eeSlots[si]) ? eeSlots[si].filter(function (id) { return id > 0; }) : [];
            if (slotEnchants.length > 0) {
              var glowColors = ['', '#00ff00', '#00c8ff', '#c800ff', '#ffd700'];
              var glowColor = glowColors[Math.min(slotEnchants.length, 4)] || '#00ff00';
              ctx.save();
              ctx.shadowColor = glowColor;
              ctx.shadowBlur = 3;
              ctx.fillStyle = glowColor;
              ctx.globalAlpha = 0.25;
              ctx.fillRect(sx - 1, sy - 1, ICO_SM + 2, ICO_SM + 2);
              ctx.restore();
            }
            rsDrawItemSprite(ctx, rendersImg, slotId, sx, sy, ICO_SM);
          });

          curY += ROW_H;
        });

        // EmptyBorder(0,0,5,0) gap
        curY += 5;
      });

      // Trim to actual content height
      if (curY < canvas.height) {
        var trimmed = document.createElement('canvas');
        trimmed.width = canvas.width;
        trimmed.height = Math.ceil(curY);
        var tCtx = trimmed.getContext('2d');
        tCtx.drawImage(canvas, 0, 0);
        canvas = trimmed;
      }

      // Copy to clipboard
      canvas.toBlob(function (blob) {
        if (!blob) return;
        var item = new ClipboardItem({ 'image/png': blob });
        navigator.clipboard.write([item]).then(function () {
          if (damageCopyImageBtn) {
            damageCopyImageBtn.textContent = 'Copied!';
            damageCopyImageBtn.classList.add('copied');
            setTimeout(function () {
              damageCopyImageBtn.textContent = 'Copy Image';
              damageCopyImageBtn.classList.remove('copied');
            }, 2000);
          }
        }).catch(function (err) {
          console.error('Failed to copy image:', err);
          var url = canvas.toDataURL('image/png');
          window.open(url, '_blank');
        });
      }, 'image/png');
      } // end doDrawCanvas

    }; // end doDraw

    if (rendersImg.complete && rendersImg.naturalWidth > 0) {
      doDraw();
    } else {
      rendersImg.onload = doDraw;
      rendersImg.onerror = doDraw;
    }
  }

  // ─── Config handler ─────────────────────────────────────

  function createEmptyDashboardAccount() {
    return {
      id: 'acct-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7),
      label: '',
      email: '',
      password: '',
      serverName: (availableServerNames.indexOf('USWest') >= 0 ? 'USWest' : (availableServerNames[0] || 'USWest')),
      notes: '',
      preferredScriptId: '',
      mulingRole: 'none',
      mulingStoreMode: 'any',
      mulingItemsToStore: '',
      mulingItemsFromMain: '',
      mulingItemsToMuleOff: '',
      proxy: '',
      proxyUsername: '',
      proxyPassword: '',
      // Steam-linked accounts use a different /account/verify shape (secret + steamid).
      // When isSteam is true: `email` is the Deca GUID and `password` is the Steam secret.
      isSteam: false,
      steamId: '',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
  }

  function normalizeDashboardAccount(raw) {
    var base = createEmptyDashboardAccount();
    if (!raw || typeof raw !== 'object') return base;
    return {
      id: String(raw.id || base.id),
      label: String(raw.label || ''),
      email: String(raw.email || '').trim(),
      password: String(raw.password || ''),
      serverName: String(raw.serverName || base.serverName).trim() || base.serverName,
      notes: String(raw.notes || ''),
      preferredScriptId: String(raw.preferredScriptId || ''),
      mulingRole: (['none', 'main', 'mule'].indexOf(raw.mulingRole) >= 0 ? raw.mulingRole : 'none'),
      mulingStoreMode: (raw.mulingStoreMode === 'specific' ? 'specific' : 'any'),
      mulingItemsToStore: String(raw.mulingItemsToStore || ''),
      mulingItemsFromMain: String(raw.mulingItemsFromMain || ''),
      mulingItemsToMuleOff: String(raw.mulingItemsToMuleOff || ''),
      proxy: String(raw.proxy || ''),
      proxyUsername: String(raw.proxyUsername || ''),
      proxyPassword: String(raw.proxyPassword || ''),
      isSteam: !!raw.isSteam,
      steamId: String(raw.steamId || '').trim(),
      createdAt: Number(raw.createdAt || base.createdAt) || base.createdAt,
      updatedAt: Number(raw.updatedAt || base.updatedAt) || base.updatedAt,
    };
  }

  function getSelectedDashboardAccount() {
    for (var i = 0; i < dashboardAccounts.length; i++) {
      if (dashboardAccounts[i].id === selectedAccountId) return dashboardAccounts[i];
    }
    return null;
  }

  function setAccountsStatus(text, isError) {
    if (!accountsStatusEl) return;
    accountsStatusEl.textContent = text || '';
    accountsStatusEl.classList.toggle('error', !!isError);
  }

  function setAccountsDirty(nextDirty, statusText) {
    accountsDirty = !!nextDirty;
    if (accountsSaveBtn) {
      accountsSaveBtn.textContent = accountsDirty ? 'Save Changes *' : 'Save Changes';
      accountsSaveBtn.disabled = !accountsDirty;
    }
    if (statusText) setAccountsStatus(statusText, false);
  }

  function invalidateDashboardAccountOverview(accountId) {
    if (!accountId) return;
    delete accountOverviewById[accountId];
    delete accountOverviewNoticeById[accountId];
    delete selectedAccountCharacterIdByAccountId[accountId];
    if (accountOverviewLoadingId === accountId) accountOverviewLoadingId = null;
    homeAccountOverviewLoadingIds.delete(accountId);
    homeAccountOverviewAttemptedIds.delete(accountId);
  }

  function pruneDashboardAccountOverviewState() {
    var validIds = Object.create(null);
    dashboardAccounts.forEach(function (account) {
      validIds[account.id] = true;
    });
    Object.keys(accountOverviewById).forEach(function (accountId) {
      if (!validIds[accountId]) delete accountOverviewById[accountId];
    });
    Object.keys(accountOverviewNoticeById).forEach(function (accountId) {
      if (!validIds[accountId]) delete accountOverviewNoticeById[accountId];
    });
    Object.keys(selectedAccountCharacterIdByAccountId).forEach(function (accountId) {
      if (!validIds[accountId]) delete selectedAccountCharacterIdByAccountId[accountId];
    });
    if (accountOverviewLoadingId && !validIds[accountOverviewLoadingId]) accountOverviewLoadingId = null;
    Array.from(homeAccountOverviewLoadingIds).forEach(function (accountId) {
      if (!validIds[accountId]) homeAccountOverviewLoadingIds.delete(accountId);
    });
    Array.from(homeAccountOverviewAttemptedIds).forEach(function (accountId) {
      if (!validIds[accountId]) homeAccountOverviewAttemptedIds.delete(accountId);
    });
  }

  function setAccountOverviewNotice(accountId, text, isError) {
    if (!accountId) return;
    if (text) accountOverviewNoticeById[accountId] = { text: String(text), isError: !!isError, updatedAt: Date.now() };
    else delete accountOverviewNoticeById[accountId];
  }

  function getSelectedDashboardAccountOverview() {
    return selectedAccountId ? (accountOverviewById[selectedAccountId] || null) : null;
  }

  function formatAccountOverviewTimestamp(ts) {
    if (!ts) return '';
    try {
      return new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    } catch (_) {
      return '';
    }
  }

  function getEamItemRecord(objectType) {
    if (objectType == null || objectType === '') return null;
    return EAM_ITEMS[String(objectType)] || EAM_ITEMS['0'] || null;
  }

  /** Sprite sheet row only when this object type exists in EAM (no Unknown fallback). */
  function getEamItemRecordStrict(objectType) {
    if (objectType == null || objectType === '') return null;
    var v = EAM_ITEMS[String(objectType)];
    return v !== undefined && v !== null ? v : null;
  }

  function getEquipmentItemLabel(item) {
    if (!item || Number(item.objectType) < 0) return 'Empty Slot';
    var record = getEamItemRecord(item.objectType);
    return String(item.name || (record && record[0]) || item.objectTypeHex || ('Type ' + String(item.objectType)));
  }

  function getItemEnchantIds(item) {
    return Array.isArray(item && item.enchantIds)
      ? item.enchantIds.map(function (value) { return Number(value || 0); }).filter(function (value) { return Number.isFinite(value) && value > 0; })
      : [];
  }

  function getItemRarity(item) {
    var enchantIds = getItemEnchantIds(item);
    if (!enchantIds.length) return 0;
    var rarity = enchantIds.filter(function (id) { return id >= 16; }).length;
    return Math.max(0, Math.min(4, rarity));
  }

  function getItemRarityIcon(item) {
    return ITEM_RARITY_ICONS[getItemRarity(item)] || '';
  }

  function getItemEnchantRecords(item) {
    return getItemEnchantIds(item).map(function (id) {
      var record = EAM_ENCHANTMENTS[String(id)] || null;
      return {
        id: id,
        name: String(record && record[0] || ('Enchant ' + String(id))),
        description: String(record && record[1] || ''),
      };
    });
  }

  function registerItemDetailPayload(payload) {
    if (!payload || typeof payload !== 'object') return '';
    itemDetailPayloadSeq += 1;
    var id = 'detail-' + String(itemDetailPayloadSeq);
    itemDetailPayloadById[id] = payload;
    return id;
  }

  function buildItemSpriteHtml(item, extraClassName, detailPayload, eamLookupMode) {
    var className = extraClassName ? (' ' + String(extraClassName)) : '';
    if (!item || Number(item.objectType) < 0) {
      return '<button type="button" class="rotmg-item-sprite empty' + className + '" title="Empty Slot" disabled aria-label="Empty Slot"></button>';
    }

    var record = eamLookupMode === 'strict'
      ? getEamItemRecordStrict(item.objectType)
      : getEamItemRecord(item.objectType);
    var titleRaw = eamLookupMode === 'strict'
      ? String(item.name || (record && record[0]) || item.objectTypeHex || ('Type ' + String(item.objectType)))
      : getEquipmentItemLabel(item);
    var title = escapeHtml(titleRaw);
    var enchantIds = getItemEnchantIds(item);
    var rarityIcon = getItemRarityIcon(item);
    var rarityStyle = rarityIcon ? (';--enchant-rarity-icon:url(\'' + escapeHtml(rarityIcon) + '\')') : '';
    var enchantAttr = escapeHtml(enchantIds.join(','));
    var typeHex = escapeHtml(String(item.objectTypeHex || ''));
    var detailPayloadId = registerItemDetailPayload(detailPayload);
    var detailAttr = detailPayloadId ? (' data-item-detail-id="' + escapeHtml(detailPayloadId) + '"') : '';
    if (!record) {
      return '<button type="button" class="rotmg-item-sprite empty' + (rarityIcon ? ' has-enchants' : '') + className + '"' +
        ' title="' + title + '"' +
        ' aria-label="' + title + '"' +
        ' data-item-name="' + title + '"' +
        ' data-item-type-hex="' + typeHex + '"' +
        ' data-item-object-type="' + escapeHtml(String(item.objectType)) + '"' +
        ' data-item-enchants="' + enchantAttr + '"' +
        detailAttr +
        ' style="' + (rarityStyle ? rarityStyle.slice(1) : '') + '"></button>';
    }

    var x = Math.max(0, Number(record[3] || 0));
    var y = Math.max(0, Number(record[4] || 0));
    return '<button type="button" class="rotmg-item-sprite' + (rarityIcon ? ' has-enchants' : '') + className + '"' +
      ' title="' + title + '"' +
      ' aria-label="' + title + '"' +
      ' data-item-name="' + title + '"' +
      ' data-item-type-hex="' + typeHex + '"' +
      ' data-item-object-type="' + escapeHtml(String(item.objectType)) + '"' +
      ' data-item-enchants="' + enchantAttr + '"' +
      detailAttr +
      ' style="background-position:-' + x + 'px -' + y + 'px' + rarityStyle + ';"></button>';
  }

  function buildEquipmentSpriteStripHtml(equipment, extraClassName) {
    var className = extraClassName ? (' ' + String(extraClassName)) : '';
    if (!Array.isArray(equipment) || !equipment.length) {
      return '<div class="rotmg-item-strip' + className + '"><span class="home-note">No equipment data</span></div>';
    }
    return '<div class="rotmg-item-strip' + className + '">' +
      equipment.slice(0, 4).map(function (item) { return buildItemSpriteHtml(item); }).join('') +
      '</div>';
  }

  function buildInventorySpriteStripHtml(inventory, backpacks, extraClassName) {
    var className = extraClassName ? (' ' + String(extraClassName)) : '';
    var ensureSlots = function (items, count) {
      var source = Array.isArray(items) ? items.slice(0, count) : [];
      while (source.length < count) source.push({ objectType: -1 });
      return source;
    };

    var inventorySlots = ensureSlots(inventory, 8); // 4-12
    var backpackSlots = ensureSlots(Array.isArray(backpacks) ? backpacks.slice(0, 8) : [], 8); // 12-20
    var extenderSlots = ensureSlots(Array.isArray(backpacks) ? backpacks.slice(8, 16) : [], 8); // 20-28

    var groups = [
      { title: 'Inventory (4-12)', slots: inventorySlots },
      { title: 'Backpack (12-20)', slots: backpackSlots },
      { title: 'Backpack Extender (20-28)', slots: extenderSlots },
    ];

    return '<div class="accounts-inventory-groups' + className + '">' +
      groups.map(function (group) {
        return '<div class="accounts-inventory-group">' +
          '<div class="accounts-inventory-group-title">' + escapeHtml(group.title) + '</div>' +
          '<div class="accounts-inventory-grid">' +
            group.slots.map(function (item) { return buildItemSpriteHtml(item); }).join('') +
          '</div>' +
        '</div>';
      }).join('') +
      '</div>';
  }

  function summarizeEquipmentNames(equipment) {
    if (!Array.isArray(equipment)) return t('home.equipment.none');
    var names = equipment
      .map(function (entry) {
        return entry && Number(entry.objectType) >= 0 ? String(entry.name || entry.objectTypeHex || ('Type ' + String(entry.objectType))) : '';
      })
      .filter(Boolean);
    return names.length ? names.join(' • ') : t('home.equipment.noneEquipped');
  }

  /** Highest-fame character in only seasonal or only non-seasonal rows (MAC launch filter Yes / No). */
  function getBestOverviewCharacterInPool(overview, pool) {
    var characters =
      overview && Array.isArray(overview.characters) ? overview.characters.slice() : [];
    var filtered =
      pool === 'seasonal'
        ? characters.filter(function (c) {
          return c && c.seasonal;
        })
        : characters.filter(function (c) {
          return c && !c.seasonal;
        });
    if (!filtered.length) return null;
    filtered.sort(function (a, b) {
      var fameDelta = Number(b && b.fame || 0) - Number(a && a.fame || 0);
      if (fameDelta !== 0) return fameDelta;
      return Number(a && a.charId || 0) - Number(b && b.charId || 0);
    });
    return filtered[0] || null;
  }

  function getBestOverviewCharacter(overview) {
    var characters = overview && Array.isArray(overview.characters) ? overview.characters.slice() : [];
    if (!characters.length) return null;
    characters.sort(function (a, b) {
      var fameDelta = Number(b && b.fame || 0) - Number(a && a.fame || 0);
      if (fameDelta !== 0) return fameDelta;
      return Number(a && a.charId || 0) - Number(b && b.charId || 0);
    });
    return characters[0] || null;
  }

  function formatHomeAccountCharacterSummary(character, account) {
    if (!character) return String(account && account.serverName || 'USWest');
    var className = String(character.className || character.classTypeHex || t('accounts.character.classDefault'));
    var fame = Number(character.fame || 0).toLocaleString();
    var server = String(account && account.serverName || 'USWest');
    return tr('home.accountRow.summary', { className: className, fame: fame, server: server });
  }

  function formatHomeAccountEquipmentSummary(character) {
    if (!character) return t('home.accounts.charNotLoaded');
    return summarizeEquipmentNames(character.equipment);
  }

  function getOverviewSectionItems(overview, sectionKey) {
    if (!overview || typeof overview !== 'object') return [];
    if (sectionKey === 'vault' || sectionKey === 'gifts' || sectionKey === 'potions' || sectionKey === 'temporaryGifts' || sectionKey === 'materialStorage') {
      var section = overview[sectionKey];
      return Array.isArray(section && section.items) ? section.items.slice() : [];
    }
    return [];
  }

  function collectOverviewCharacterItems(overview) {
    var characters = Array.isArray(overview && overview.characters) ? overview.characters : [];
    var items = [];
    characters.forEach(function (character) {
      ['equipment', 'inventory', 'backpacks'].forEach(function (key) {
        var arr = Array.isArray(character && character[key]) ? character[key] : [];
        arr.forEach(function (item) {
          if (item && Number(item.objectType) >= 0) items.push(item);
        });
      });
    });
    return items;
  }

  function buildStorageSummaryText(overview, sectionKey) {
    var section = overview && overview[sectionKey];
    var total = Number(section && section.totalCount || 0);
    var unique = Number(section && section.uniqueCount || 0);
    return tr('accounts.storage.summary', { total: total.toLocaleString(), unique: unique.toLocaleString() });
  }

  function aggregateTotalInventory() {
    var totals = Object.create(null);
    dashboardAccounts.forEach(function (account) {
      var overview = accountOverviewById[account.id];
      if (!overview) return;
      var allItems = []
        .concat(getOverviewSectionItems(overview, 'vault'))
        .concat(getOverviewSectionItems(overview, 'gifts'))
        .concat(getOverviewSectionItems(overview, 'temporaryGifts'))
        .concat(getOverviewSectionItems(overview, 'materialStorage'))
        .concat(getOverviewSectionItems(overview, 'potions'))
        .concat(collectOverviewCharacterItems(overview));
      allItems.forEach(function (item) {
        var objectType = Number(item && item.objectType);
        if (!Number.isFinite(objectType) || objectType < 0) return;
        var key = String(objectType);
        if (!totals[key]) {
          totals[key] = {
            item: item,
            count: 0,
            accountTotals: Object.create(null),
          };
        }
        var bucket = totals[key];
        bucket.count += 1;
        if (getItemRarity(item) > getItemRarity(bucket.item)) bucket.item = item;
        var label = String(account.label || account.email || overview.accountName || 'Account');
        if (!bucket.accountTotals[account.id]) {
          bucket.accountTotals[account.id] = {
            label: label,
            total: 0,
            vault: 0,
            gifts: 0,
            temporaryGifts: 0,
            materialStorage: 0,
            potions: 0,
            characters: 0,
          };
        }
      });
      [['vault', 'vault'], ['gifts', 'gifts'], ['temporaryGifts', 'temporaryGifts'], ['materialStorage', 'materialStorage'], ['potions', 'potions']].forEach(function (entry) {
        var items = getOverviewSectionItems(overview, entry[0]);
        items.forEach(function (item) {
          var key = String(Number(item && item.objectType));
          if (!totals[key] || !totals[key].accountTotals[account.id]) return;
          totals[key].accountTotals[account.id][entry[1]] += 1;
          totals[key].accountTotals[account.id].total += 1;
        });
      });
      collectOverviewCharacterItems(overview).forEach(function (item) {
        var key = String(Number(item && item.objectType));
        if (!totals[key] || !totals[key].accountTotals[account.id]) return;
        totals[key].accountTotals[account.id].characters += 1;
        totals[key].accountTotals[account.id].total += 1;
      });
    });
    return Object.keys(totals).map(function (key) {
      var entry = totals[key];
      return {
        item: entry.item,
        count: entry.count,
        accountTotals: Object.keys(entry.accountTotals).map(function (accountId) {
          return entry.accountTotals[accountId];
        }).sort(function (a, b) { return b.total - a.total || a.label.localeCompare(b.label); }),
      };
    }).sort(function (a, b) {
      return b.count - a.count || getEquipmentItemLabel(a.item).localeCompare(getEquipmentItemLabel(b.item));
    });
  }

  function aggregateSectionItems(items) {
    var totals = Object.create(null);
    items.forEach(function (item) {
      var objectType = Number(item && item.objectType);
      if (!Number.isFinite(objectType) || objectType < 0) return;
      var key = String(objectType);
      if (!totals[key]) {
        totals[key] = { item: item, count: 0 };
      }
      var bucket = totals[key];
      bucket.count += 1;
      if (getItemRarity(item) > getItemRarity(bucket.item)) bucket.item = item;
    });
    return Object.keys(totals).map(function (key) {
      return totals[key];
    }).sort(function (a, b) {
      return b.count - a.count || getEquipmentItemLabel(a.item).localeCompare(getEquipmentItemLabel(b.item));
    });
  }

  function buildItemLocationPayload(accountTotals) {
    return {
      locations: Array.isArray(accountTotals) ? accountTotals.map(function (entry) {
        var parts = [];
        if (entry.vault) parts.push('Vault ' + entry.vault);
        if (entry.gifts) parts.push('Gifts ' + entry.gifts);
        if (entry.temporaryGifts) parts.push('Temp Gifts ' + entry.temporaryGifts);
        if (entry.materialStorage) parts.push('Material ' + entry.materialStorage);
        if (entry.potions) parts.push('Potions ' + entry.potions);
        if (entry.characters) parts.push('Characters ' + entry.characters);
        return {
          label: String(entry.label || 'Account') + ' | x' + String(entry.total || 0),
          description: parts.join(' | ') || 'No location details',
        };
      }) : [],
    };
  }

  function buildAccountsItemBrowserHtml(items, options) {
    var opts = options && typeof options === 'object' ? options : {};
    var summaryText = String(opts.summaryText || '');
    var cards = Array.isArray(items) ? items.map(function (entry) {
      if (!entry) return '';
      if (entry.item) {
        var name = getEquipmentItemLabel(entry.item);
        return '<div class="accounts-item-stack" data-item-name="' + escapeHtml(name.toLowerCase()) + '">' +
          buildItemSpriteHtml(entry.item, '', buildItemLocationPayload(entry.accountTotals)) +
          '<div class="accounts-item-stack-count">x' + escapeHtml(String(entry.count || 0)) + '</div>' +
          '<div class="accounts-item-stack-name">' + escapeHtml(name) + '</div>' +
        '</div>';
      }
      var name = getEquipmentItemLabel(entry);
      return '<div class="accounts-item-stack" data-item-name="' + escapeHtml(name.toLowerCase()) + '">' +
        buildItemSpriteHtml(entry) +
        '<div class="accounts-item-stack-name">' + escapeHtml(name) + '</div>' +
      '</div>';
    }).join('') : '';
    return (summaryText
      ? '<div class="accounts-browser-summary-row">' +
          '<span class="accounts-browser-summary">' + escapeHtml(summaryText) + '</span>' +
          '<input class="accounts-browser-search" type="text" placeholder="Search items…" data-accounts-browser-search>' +
        '</div>'
      : '') +
      '<div class="accounts-item-browser-grid">' + cards + '</div>';
  }

  function closeItemDetailModal() {
    if (itemDetailOverlay) itemDetailOverlay.classList.add('hidden');
  }

  function openItemDetailModalFromButton(btn) {
    if (!itemDetailOverlay || !itemDetailTitleEl || !itemDetailSubtitleEl || !itemDetailSpriteEl || !itemDetailEnchantsEl || !btn) return;
    var itemName = String(btn.getAttribute('data-item-name') || 'Item');
    var objectType = Number(btn.getAttribute('data-item-object-type') || -1);
    var objectTypeHex = String(btn.getAttribute('data-item-type-hex') || '');
    var enchantIds = String(btn.getAttribute('data-item-enchants') || '')
      .split(',')
      .map(function (value) { return Number(value || 0); })
      .filter(function (value) { return Number.isFinite(value) && value > 0; });
    var detailPayloadId = String(btn.getAttribute('data-item-detail-id') || '');
    var detailPayload = detailPayloadId ? itemDetailPayloadById[detailPayloadId] : null;
    var detailItem = {
      objectType: objectType,
      objectTypeHex: objectTypeHex,
      name: itemName,
      enchantIds: enchantIds,
    };
    itemDetailTitleEl.textContent = itemName;
    var subtitleParts = [];
    if (objectTypeHex) subtitleParts.push('Type ' + escapeHtml(objectTypeHex));
    if (objectType >= 0) subtitleParts.push('<button class="item-type-decimal-copy" data-copy-value="' + objectType + '" title="Click to copy">' + objectType + '</button>');
    if (enchantIds.length) subtitleParts.push(escapeHtml(enchantIds.length + ' enchant' + (enchantIds.length === 1 ? '' : 's')));
    itemDetailSubtitleEl.innerHTML = subtitleParts.join(' | ');
    itemDetailSpriteEl.innerHTML = buildItemSpriteHtml(detailItem, 'item-detail-preview');
    var enchantRecords = getItemEnchantRecords(detailItem);
    itemDetailEnchantsEl.innerHTML = enchantRecords.length
      ? enchantRecords.map(function (entry) {
        return '<div class="item-detail-enchant">' +
          '<div class="item-detail-enchant-name">' + escapeHtml(entry.name) + '</div>' +
          '<div class="item-detail-enchant-desc">' + escapeHtml(entry.description || 'No description available.') + '</div>' +
        '</div>';
      }).join('')
      : '<div class="item-detail-empty">No enchants on this item.</div>';
    var locations = Array.isArray(detailPayload && detailPayload.locations) ? detailPayload.locations : [];
    if (itemDetailLocationsSectionEl && itemDetailLocationsEl) {
      itemDetailLocationsSectionEl.classList.toggle('hidden', !locations.length);
      itemDetailLocationsEl.innerHTML = locations.length
        ? locations.map(function (entry) {
          return '<div class="item-detail-location">' +
            '<div class="item-detail-location-name">' + escapeHtml(String(entry.label || 'Account')) + '</div>' +
            '<div class="item-detail-location-desc">' + escapeHtml(String(entry.description || '')) + '</div>' +
          '</div>';
        }).join('')
        : '';
    }
    var previewButton = itemDetailSpriteEl.querySelector('.rotmg-item-sprite');
    if (previewButton) previewButton.disabled = true;
    itemDetailOverlay.classList.remove('hidden');
  }

  function storeDashboardAccountOverview(account, overview, options) {
    if (!account || !account.id) return overview || null;
    accountOverviewById[account.id] = overview;
    var opts = options && typeof options === 'object' ? options : {};
    if (overview && Array.isArray(overview.characters) && overview.characters.length) {
      var currentSelected = Number(selectedAccountCharacterIdByAccountId[account.id]);
      var stillExists = overview.characters.some(function (character) { return Number(character.charId) === currentSelected; });
      if (!stillExists) selectedAccountCharacterIdByAccountId[account.id] = Number(overview.characters[0].charId);
    } else {
      delete selectedAccountCharacterIdByAccountId[account.id];
    }
    var noticeUpdatedAt = Number(opts.updatedAt || Date.now());
    var updatedAt = formatAccountOverviewTimestamp(noticeUpdatedAt);
    var noticeText = typeof opts.noticeText === 'string' && opts.noticeText
      ? opts.noticeText
      : (opts.cached
        ? (updatedAt ? tr('accounts.notice.cachedFrom', { time: updatedAt }) : t('accounts.notice.cached'))
        : (updatedAt ? tr('accounts.notice.listAt', { time: updatedAt }) : t('accounts.notice.listOk')));
    setAccountOverviewNotice(account.id, noticeText, false);
    if (activeTab === 'accounts' && accountsSortMode === 'fame') renderAccountsList();
    if (homeAccountsSortMode === 'fame') renderHomeAccounts();
    return overview;
  }

  function fetchDashboardAccountOverview(account, forceRefresh) {
    var email = String(account && account.email || '').trim();
    var password = String(account && account.password || '');
    if (!account || !account.id || !email || !password) return Promise.resolve(null);
    var isSteam = !!(account && account.isSteam);
    var steamId = String(account && account.steamId || '').trim();
    if (isSteam && !steamId) return Promise.resolve(null);
    var body = {
      accountId: String(account.id || ''),
      email: email,
      password: password,
      refresh: !!forceRefresh,
    };
    if (isSteam) {
      body.isSteam = true;
      body.steamId = steamId;
    }
    return fetch('/api/accounts/overview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
      .then(function (r) {
        return r.json().catch(function () { return {}; }).then(function (data) {
          if (!r.ok) throw new Error(String((data && data.error) || t('accounts.error.loadList')));
          return data;
        });
      })
      .then(function (data) {
        if (!data || !data.overview || typeof data.overview !== 'object') return null;
        return {
          overview: data.overview,
          cached: !!data.cached,
          updatedAt: Number(data.updatedAt || 0) || Date.now(),
        };
      });
  }

  function prefetchHomeDashboardAccountOverview(account) {
    if (!account || !account.id) return;
    if (accountOverviewById[account.id] || homeAccountOverviewLoadingIds.has(account.id) || homeAccountOverviewAttemptedIds.has(account.id)) return;
    if (!String(account.email || '').trim() || !String(account.password || '')) return;
    homeAccountOverviewAttemptedIds.add(account.id);
    homeAccountOverviewLoadingIds.add(account.id);
    fetchDashboardAccountOverview(account, false)
      .then(function (result) {
        if (!result) return null;
        storeDashboardAccountOverview(account, result.overview, { updatedAt: result.updatedAt, cached: !!result.cached });
      })
      .catch(function () {
      })
      .finally(function () {
        homeAccountOverviewLoadingIds.delete(account.id);
        if (activeTab === 'home') renderHomeTab();
        if (selectedAccountId === account.id) renderAccountsOverview();
      });
  }

  function renderAccountsOverview() {
    if (!accountsOverviewSummaryEl || !accountsOverviewStatusEl || !accountsCharactersListEl || !accountsCharactersEmptyEl || !accountsCharacterDetailEl) return;
    var account = getSelectedDashboardAccount();
    var overview = getSelectedDashboardAccountOverview();
    var loading = !!account && accountOverviewLoadingId === account.id;
    var notice = account ? accountOverviewNoticeById[account.id] : null;

    if (accountsOverviewRefreshBtn) {
      accountsOverviewRefreshBtn.disabled = accountsRefreshAllLoading || !account || loading || !String(account.email || '').trim() || !String(account.password || '');
      accountsOverviewRefreshBtn.textContent = loading ? 'Loading...' : 'Refresh Characters';
    }
    if (accountsOverviewRefreshAllBtn) {
      accountsOverviewRefreshAllBtn.disabled = accountsRefreshAllLoading || !dashboardAccounts.some(function (entry) {
        return String(entry.email || '').trim() && String(entry.password || '');
      });
      accountsOverviewRefreshAllBtn.textContent = accountsRefreshAllLoading ? 'Refreshing...' : 'Refresh All';
    }

    if (!account) {
      accountsOverviewSummaryEl.textContent = 'Select an account to inspect its characters.';
      accountsOverviewStatusEl.textContent = '';
      accountsOverviewStatusEl.classList.remove('error');
      accountsCharactersListEl.innerHTML = '';
      accountsCharactersEmptyEl.style.display = '';
      accountsCharactersEmptyEl.textContent = 'No account selected.';
      accountsCharacterDetailEl.innerHTML = '<div class="accounts-character-placeholder">Select an account to inspect its equipment and stats.</div>';
      return;
    }

    if (notice) {
      accountsOverviewStatusEl.textContent = String(notice.text || '');
      accountsOverviewStatusEl.classList.toggle('error', !!notice.isError);
    } else {
      accountsOverviewStatusEl.textContent = '';
      accountsOverviewStatusEl.classList.remove('error');
    }

    if (!String(account.email || '').trim() || !String(account.password || '')) {
      accountsOverviewSummaryEl.textContent = 'Enter email and password, then refresh to load characters.';
      accountsCharactersListEl.innerHTML = '';
      accountsCharactersEmptyEl.style.display = '';
      accountsCharactersEmptyEl.textContent = 'This account is missing login credentials.';
      accountsCharacterDetailEl.innerHTML = '<div class="accounts-character-placeholder">Character data requires valid account credentials.</div>';
      return;
    }

    if (!overview) {
      accountsOverviewSummaryEl.textContent = loading ? 'Loading character list...' : 'Character list not loaded yet.';
      accountsCharactersListEl.innerHTML = '';
      accountsCharactersEmptyEl.style.display = '';
      accountsCharactersEmptyEl.textContent = loading ? 'Loading characters...' : 'Click Refresh Characters to load this account.';
      accountsCharacterDetailEl.innerHTML = '<div class="accounts-character-placeholder">' + (loading ? 'Fetching character data from RotMG...' : 'Load the character list to inspect equipment and stats.') + '</div>';
      return;
    }

    var summaryParts = [];
    summaryParts.push(String(overview.accountName || account.label || account.email || 'Account'));
    summaryParts.push(String((overview.characters || []).length) + ' chars');
    if (Number(overview.aliveFame) > 0) summaryParts.push('Total alive fame ' + String(overview.aliveFame));
    if (Number(overview.bestCharFame) > 0) summaryParts.push('Best char ' + String(overview.bestCharFame));
    if (notice && !notice.isError) {
      var updatedAt = formatAccountOverviewTimestamp(notice.updatedAt);
      if (updatedAt) summaryParts.push('Updated ' + updatedAt);
    }
    accountsOverviewSummaryEl.textContent = summaryParts.join(' • ');

    var characters = Array.isArray(overview.characters) ? overview.characters : [];
    accountsCharactersListEl.innerHTML = '';
    if (!characters.length) {
      accountsCharactersEmptyEl.style.display = '';
      accountsCharactersEmptyEl.textContent = 'This account has no characters.';
      accountsCharacterDetailEl.innerHTML = '<div class="accounts-character-placeholder">This account did not return any characters.</div>';
      return;
    }

    accountsCharactersEmptyEl.style.display = 'none';
    var selectedCharacterId = Number(selectedAccountCharacterIdByAccountId[account.id]);
    var selectedCharacter = null;
    characters.forEach(function (character) {
      if (!selectedCharacter && Number(character.charId) === selectedCharacterId) selectedCharacter = character;
    });
    if (!selectedCharacter) {
      selectedCharacter = characters[0];
      selectedAccountCharacterIdByAccountId[account.id] = selectedCharacter ? Number(selectedCharacter.charId) : null;
    }

    characters.forEach(function (character) {
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'account-character-card' + (selectedCharacter && Number(selectedCharacter.charId) === Number(character.charId) ? ' selected' : '');
      var badges = [];
      badges.push('Lvl ' + String(character.level || 0));
      if (character.seasonal) badges.push('Seasonal');
      if (character.dead) badges.push('Dead');
      btn.innerHTML =
        '<div class="account-character-card-top">' +
          '<span class="account-character-card-name">' + escapeHtml(String(character.className || character.classTypeHex || 'Character')) + '</span>' +
          '<span class="account-character-card-badge">' + escapeHtml(badges.join(' • ')) + '</span>' +
        '</div>' +
        '<div class="account-character-card-meta">' +
          '<span>Fame ' + escapeHtml(String(character.fame || 0)) + '</span>' +
          '<span>HP ' + escapeHtml(String(character.hp || 0)) + '/' + escapeHtml(String(character.maxHp || 0)) + '</span>' +
          '<span>ID ' + escapeHtml(String(character.charId || 0)) + '</span>' +
        '</div>' +
        '<div class="account-character-card-equipment">' + buildEquipmentSpriteStripHtml(character.equipment) + '</div>';
      btn.addEventListener('click', function () {
        selectedAccountCharacterIdByAccountId[account.id] = Number(character.charId);
        renderAccountsOverview();
      });
      accountsCharactersListEl.appendChild(btn);
    });

    if (!selectedCharacter) {
      accountsCharacterDetailEl.innerHTML = '<div class="accounts-character-placeholder">Select a character to inspect its equipment and stats.</div>';
      return;
    }

    var slotLabels = ['Weapon', 'Ability', 'Armor', 'Ring'];
    var equipmentHtml = '';
    (selectedCharacter.equipment || []).forEach(function (item, index) {
      var isEmpty = !item || Number(item.objectType) < 0;
      equipmentHtml +=
        '<div class="accounts-equipment-slot">' +
          '<div class="accounts-equipment-label">' + escapeHtml(slotLabels[index] || ('Slot ' + String(index + 1))) + '</div>' +
          '<div class="accounts-equipment-visual">' + buildItemSpriteHtml(item) + '</div>' +
          (isEmpty ? '<div class="accounts-equipment-empty-note">Empty</div>' : '') +
        '</div>';
    });

    var stats = [
      { label: 'HP', value: String(selectedCharacter.hp || 0) + ' / ' + String(selectedCharacter.maxHp || 0) },
      { label: 'MP', value: String(selectedCharacter.mp || 0) + ' / ' + String(selectedCharacter.maxMp || 0) },
      { label: 'Fame', value: String(selectedCharacter.fame || 0) },
      { label: 'Exp', value: String(selectedCharacter.exp || 0) },
      { label: 'Attack', value: String(selectedCharacter.attack || 0) },
      { label: 'Defense', value: String(selectedCharacter.defense || 0) },
      { label: 'Speed', value: String(selectedCharacter.speed || 0) },
      { label: 'Dexterity', value: String(selectedCharacter.dexterity || 0) },
      { label: 'Vitality', value: String(selectedCharacter.vitality || 0) },
      { label: 'Wisdom', value: String(selectedCharacter.wisdom || 0) },
    ];
    var statsHtml = stats.map(function (stat) {
      return (
        '<div class="accounts-stat-tile">' +
          '<div class="accounts-stat-label">' + escapeHtml(stat.label) + '</div>' +
          '<div class="accounts-stat-value">' + escapeHtml(stat.value) + '</div>' +
        '</div>'
      );
    }).join('');
    var inventoryHtml = buildInventorySpriteStripHtml(selectedCharacter.inventory, selectedCharacter.backpacks);

    var pills = [
      '<span class="accounts-character-pill">Level ' + escapeHtml(String(selectedCharacter.level || 0)) + '</span>',
      '<span class="accounts-character-pill">Fame ' + escapeHtml(String(selectedCharacter.fame || 0)) + '</span>',
      '<span class="accounts-character-pill">Char ID ' + escapeHtml(String(selectedCharacter.charId || 0)) + '</span>',
    ];
    if (selectedCharacter.seasonal) pills.push('<span class="accounts-character-pill">Seasonal</span>');
    if (selectedCharacter.dead) pills.push('<span class="accounts-character-pill warn">Dead</span>');

    accountsCharacterDetailEl.innerHTML =
      '<div class="accounts-character-header">' +
        '<div>' +
          '<div class="accounts-character-title">' + escapeHtml(String(selectedCharacter.className || selectedCharacter.classTypeHex || 'Character')) + '</div>' +
          '<div class="accounts-character-subtitle">Type ' + escapeHtml(String(selectedCharacter.classTypeHex || '')) + '</div>' +
        '</div>' +
        '<div class="accounts-character-badges">' + pills.join('') + '</div>' +
      '</div>' +
      '<div class="accounts-character-section">' +
        '<div class="accounts-character-section-title">Equipped</div>' +
        '<div class="accounts-equipment-grid">' + equipmentHtml + '</div>' +
      '</div>' +
      '<div class="accounts-character-section">' +
        '<div class="accounts-character-section-title">Stats</div>' +
        '<div class="accounts-stats-grid">' + statsHtml + '</div>' +
      '</div>' +
      '<div class="accounts-character-section">' +
        '<div class="accounts-character-section-title">Inventory</div>' +
        inventoryHtml +
      '</div>';
  }

  // ─── Account sessions panel ─────────────────────────────────────────────
  //
  // Renders the "Sessions" overview tab. Pulls from window._AccountSessions
  // for both the live (in-progress) session and the persisted history. The
  // tracker calls our onChange listener once per second while the timer is
  // running so the live duration ticks forward without the user clicking
  // anything.

  function formatSessionDuration(ms) {
    var s = Math.floor(Math.max(0, Number(ms || 0)) / 1000);
    var h = Math.floor(s / 3600);
    var m = Math.floor((s % 3600) / 60);
    var sec = s % 60;
    if (h > 0) return h + 'h ' + m + 'm ' + sec + 's';
    if (m > 0) return m + 'm ' + sec + 's';
    return sec + 's';
  }

  function formatSessionDate(ts) {
    if (!ts) return '—';
    try { return new Date(ts).toLocaleString(); } catch (_) { return String(ts); }
  }

  function renderAccountSessionsPanel(account, container) {
    if (!container) return;
    if (!account || !String(account.email || '').trim()) {
      container.innerHTML =
        '<div class="accounts-sessions-empty">Select an account with an email to see session history.</div>';
      return;
    }
    var email = String(account.email).toLowerCase();
    var tracker = window._AccountSessions;
    var live = tracker ? tracker.getCurrent() : null;
    if (live && live.email !== email) live = null;
    var history = tracker ? tracker.getHistory(email) : [];
    var agg = tracker ? tracker.aggregate(email) : { sessions: 0, durationMs: 0, bossesKilled: 0, whiteBags: 0, shinyItems: 0 };

    var liveHtml = '';
    if (live) {
      liveHtml =
        '<div class="accounts-session-live">' +
          '<div class="accounts-session-live-head">' +
            '<span class="accounts-session-live-dot' + (live.paused ? ' paused' : '') + '"></span>' +
            '<span class="accounts-session-live-label">' + (live.paused ? 'Paused (waiting for reconnect)' : 'Active session') + '</span>' +
            '<span class="accounts-session-live-since">started ' + formatSessionDate(live.startedAt) + '</span>' +
          '</div>' +
          '<div class="accounts-session-stats">' +
            '<div class="accounts-session-stat"><span class="accounts-session-stat-label">Playtime</span><span class="accounts-session-stat-value">' + formatSessionDuration(live.durationMs) + '</span></div>' +
            '<div class="accounts-session-stat"><span class="accounts-session-stat-label">Bosses killed</span><span class="accounts-session-stat-value">' + Number(live.bossesKilled || 0) + '</span></div>' +
            '<div class="accounts-session-stat"><span class="accounts-session-stat-label">White bags</span><span class="accounts-session-stat-value">' + Number(live.whiteBags || 0) + '</span></div>' +
            '<div class="accounts-session-stat"><span class="accounts-session-stat-label">Shiny items</span><span class="accounts-session-stat-value">' + Number(live.shinyItems || 0) + '</span></div>' +
          '</div>' +
        '</div>';
    } else {
      liveHtml =
        '<div class="accounts-session-live accounts-session-live--idle">' +
          '<div class="accounts-session-live-head">' +
            '<span class="accounts-session-live-dot idle"></span>' +
            '<span class="accounts-session-live-label">No active session</span>' +
            '<span class="accounts-session-live-since">Launch this account to start tracking.</span>' +
          '</div>' +
        '</div>';
    }

    var aggHtml =
      '<div class="accounts-session-aggregate">' +
        '<div class="accounts-session-aggregate-title">Lifetime totals</div>' +
        '<div class="accounts-session-stats">' +
          '<div class="accounts-session-stat"><span class="accounts-session-stat-label">Sessions</span><span class="accounts-session-stat-value">' + agg.sessions + '</span></div>' +
          '<div class="accounts-session-stat"><span class="accounts-session-stat-label">Total playtime</span><span class="accounts-session-stat-value">' + formatSessionDuration(agg.durationMs) + '</span></div>' +
          '<div class="accounts-session-stat"><span class="accounts-session-stat-label">Bosses</span><span class="accounts-session-stat-value">' + agg.bossesKilled + '</span></div>' +
          '<div class="accounts-session-stat"><span class="accounts-session-stat-label">White bags</span><span class="accounts-session-stat-value">' + agg.whiteBags + '</span></div>' +
          '<div class="accounts-session-stat"><span class="accounts-session-stat-label">Shinies</span><span class="accounts-session-stat-value">' + agg.shinyItems + '</span></div>' +
        '</div>' +
      '</div>';

    var historyHtml = '';
    if (history.length === 0) {
      historyHtml =
        '<div class="accounts-session-history">' +
          '<div class="accounts-session-history-title">Past sessions</div>' +
          '<div class="accounts-session-history-empty">No completed sessions yet.</div>' +
        '</div>';
    } else {
      var rows = [];
      var ordered = history.slice().reverse(); // newest first
      for (var i = 0; i < ordered.length; i++) {
        var s = ordered[i];
        rows.push(
          '<tr>' +
            '<td>' + formatSessionDate(s.startedAt) + '</td>' +
            '<td>' + formatSessionDuration(s.durationMs) + '</td>' +
            '<td>' + Number(s.bossesKilled || 0) + '</td>' +
            '<td>' + Number(s.whiteBags || 0) + '</td>' +
            '<td>' + Number(s.shinyItems || 0) + '</td>' +
          '</tr>'
        );
      }
      historyHtml =
        '<div class="accounts-session-history">' +
          '<div class="accounts-session-history-title">Past sessions</div>' +
          '<table class="accounts-session-table">' +
            '<thead><tr>' +
              '<th>Started</th><th>Duration</th><th>Bosses</th><th>White Bags</th><th>Shinies</th>' +
            '</tr></thead>' +
            '<tbody>' + rows.join('') + '</tbody>' +
          '</table>' +
        '</div>';
    }

    container.innerHTML = liveHtml + aggHtml + historyHtml;
  }

  // Tracker → UI refresh wiring: re-render when the active session changes
  // (start / pause / resume / increment / finalize). Only re-renders if the
  // Sessions tab is currently in view. Deferred so the tracker's IIFE has a
  // chance to define window._AccountSessions before we try to subscribe.
  setTimeout(function wireSessionTrackerToUi() {
    if (!window._AccountSessions || typeof window._AccountSessions.onChange !== 'function') return;
    window._AccountSessions.onChange(function () {
      if (activeTab !== 'accounts') return;
      if (selectedAccountsOverviewTab !== 'sessions') return;
      var panel = document.getElementById('accounts-sessions-panel');
      if (!panel) return;
      var account = getSelectedDashboardAccount();
      renderAccountSessionsPanel(account, panel);
    });
  }, 0);

  function renderAccountsOverviewTabs() {
    if (!accountsOverviewTabsEl) return;
    accountsOverviewTabsEl.querySelectorAll('[data-accounts-overview-tab]').forEach(function (btn) {
      btn.classList.toggle('active', btn.getAttribute('data-accounts-overview-tab') === selectedAccountsOverviewTab);
    });
  }

  function renderAccountsOverview() {
    if (!accountsOverviewSummaryEl || !accountsOverviewStatusEl || !accountsCharactersListEl || !accountsCharactersEmptyEl || !accountsCharacterDetailEl) return;
    itemDetailPayloadById = Object.create(null);
    var account = getSelectedDashboardAccount();
    var overview = getSelectedDashboardAccountOverview();
    var loading = !!account && accountOverviewLoadingId === account.id;
    var notice = account ? accountOverviewNoticeById[account.id] : null;
    renderAccountsOverviewTabs();
    if (accountsOverviewLayoutEl) accountsOverviewLayoutEl.classList.toggle('is-browser', selectedAccountsOverviewTab !== 'characters');

    // The Sessions overview tab swaps the inventory browser for a dedicated
    // session-stats panel. Returning early here keeps the existing render
    // path for the other tabs untouched.
    var sessionsPanelEl = document.getElementById('accounts-sessions-panel');
    if (sessionsPanelEl) {
      var isSessionsTab = selectedAccountsOverviewTab === 'sessions';
      sessionsPanelEl.style.display = isSessionsTab ? '' : 'none';
      if (accountsOverviewLayoutEl) accountsOverviewLayoutEl.style.display = isSessionsTab ? 'none' : '';
      if (isSessionsTab) {
        renderAccountSessionsPanel(account, sessionsPanelEl);
        return;
      }
    }

    if (accountsOverviewRefreshBtn) {
      accountsOverviewRefreshBtn.disabled = accountsRefreshAllLoading || !account || loading || !String(account.email || '').trim() || !String(account.password || '');
      accountsOverviewRefreshBtn.textContent = loading ? 'Loading...' : 'Refresh Account';
    }
    if (accountsOverviewRefreshAllBtn) {
      accountsOverviewRefreshAllBtn.disabled = accountsRefreshAllLoading || !dashboardAccounts.some(function (entry) {
        return String(entry.email || '').trim() && String(entry.password || '');
      });
      accountsOverviewRefreshAllBtn.textContent = accountsRefreshAllLoading ? 'Refreshing...' : 'Refresh All';
    }

    if (!account) {
      accountsOverviewSummaryEl.textContent = 'Select an account to inspect its inventory.';
      accountsOverviewStatusEl.textContent = '';
      accountsOverviewStatusEl.classList.remove('error');
      accountsCharactersListEl.innerHTML = '';
      accountsCharactersEmptyEl.style.display = '';
      accountsCharactersEmptyEl.textContent = 'No account selected.';
      accountsCharacterDetailEl.innerHTML = '<div class="accounts-character-placeholder">Select an account to inspect its inventory and characters.</div>';
      return;
    }

    if (notice) {
      accountsOverviewStatusEl.textContent = String(notice.text || '');
      accountsOverviewStatusEl.classList.toggle('error', !!notice.isError);
    } else {
      accountsOverviewStatusEl.textContent = '';
      accountsOverviewStatusEl.classList.remove('error');
    }

    if (!String(account.email || '').trim() || !String(account.password || '')) {
      accountsOverviewSummaryEl.textContent = 'Enter email and password, then refresh to load the account inventory.';
      accountsCharactersListEl.innerHTML = '';
      accountsCharactersEmptyEl.style.display = '';
      accountsCharactersEmptyEl.textContent = 'This account is missing login credentials.';
      accountsCharacterDetailEl.innerHTML = '<div class="accounts-character-placeholder">Account inventory requires valid account credentials.</div>';
      return;
    }

    if (!overview) {
      accountsOverviewSummaryEl.textContent = loading ? 'Loading account data...' : 'Account data not loaded yet.';
      accountsCharactersListEl.innerHTML = '';
      accountsCharactersEmptyEl.style.display = '';
      accountsCharactersEmptyEl.textContent = loading ? 'Loading account data...' : 'Click Refresh Account to load this account.';
      accountsCharacterDetailEl.innerHTML = '<div class="accounts-character-placeholder">' + (loading ? 'Fetching account data from RotMG...' : 'Load the account data to inspect characters and stored items.') + '</div>';
      return;
    }

    var summaryParts = [];
    summaryParts.push(String(overview.accountName || account.label || account.email || 'Account'));
    summaryParts.push(String((overview.characters || []).length) + ' chars');
    if (overview.vault && Number(overview.vault.totalCount) > 0) summaryParts.push('Vault ' + String(overview.vault.totalCount));
    if (overview.gifts && Number(overview.gifts.totalCount) > 0) summaryParts.push('Gifts ' + String(overview.gifts.totalCount));
    if (overview.potions && Number(overview.potions.totalCount) > 0) summaryParts.push('Potions ' + String(overview.potions.totalCount));
    if (Number(overview.aliveFame) > 0) summaryParts.push('Total alive fame ' + String(overview.aliveFame));
    if (Number(overview.bestCharFame) > 0) summaryParts.push('Best char ' + String(overview.bestCharFame));
    if (notice && !notice.isError) {
      var updatedAt = formatAccountOverviewTimestamp(notice.updatedAt);
      if (updatedAt) summaryParts.push('Updated ' + updatedAt);
    }
    accountsOverviewSummaryEl.textContent = summaryParts.join(' • ');

    if (selectedAccountsOverviewTab !== 'characters') {
      var browserItems = [];
      var browserSummary = '';
      if (selectedAccountsOverviewTab === 'totals') {
        browserItems = aggregateTotalInventory();
        var loadedAccounts = dashboardAccounts.filter(function (entry) { return !!accountOverviewById[entry.id]; }).length;
        browserSummary = browserItems.length.toLocaleString() + ' unique items across ' + loadedAccounts + ' loaded account' + (loadedAccounts === 1 ? '' : 's');
      } else {
        browserItems = getOverviewSectionItems(overview, selectedAccountsOverviewTab);
        browserSummary = buildStorageSummaryText(overview, selectedAccountsOverviewTab);
      }
      accountsCharactersListEl.innerHTML = browserItems.length
        ? buildAccountsItemBrowserHtml(browserItems, { summaryText: browserSummary })
        : '';
      accountsCharactersEmptyEl.style.display = browserItems.length ? 'none' : '';
      accountsCharactersEmptyEl.textContent = selectedAccountsOverviewTab === 'totals'
        ? 'No cached account inventory is available yet.'
        : ('No ' + selectedAccountsOverviewTab + ' items found on this account.');
      accountsCharacterDetailEl.innerHTML = '<div class="accounts-character-placeholder">' +
        (selectedAccountsOverviewTab === 'totals'
          ? 'Click an item to see which account has it and how many.'
          : 'Click any item to inspect its name and enchants.') +
        '</div>';
      return;
    }

    var characters = Array.isArray(overview.characters) ? overview.characters : [];
    accountsCharactersListEl.innerHTML = '';
    if (!characters.length) {
      accountsCharactersEmptyEl.style.display = '';
      accountsCharactersEmptyEl.textContent = 'This account has no characters.';
      accountsCharacterDetailEl.innerHTML = '<div class="accounts-character-placeholder">This account did not return any characters.</div>';
      return;
    }

    accountsCharactersEmptyEl.style.display = 'none';
    var selectedCharacterId = Number(selectedAccountCharacterIdByAccountId[account.id]);
    var selectedCharacter = null;
    characters.forEach(function (character) {
      if (!selectedCharacter && Number(character.charId) === selectedCharacterId) selectedCharacter = character;
    });
    if (!selectedCharacter) {
      selectedCharacter = characters[0];
      selectedAccountCharacterIdByAccountId[account.id] = selectedCharacter ? Number(selectedCharacter.charId) : null;
    }

    characters.forEach(function (character) {
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'account-character-card' + (selectedCharacter && Number(selectedCharacter.charId) === Number(character.charId) ? ' selected' : '');
      var badges = [];
      badges.push('Lvl ' + String(character.level || 0));
      if (character.seasonal) badges.push('Seasonal');
      if (character.dead) badges.push('Dead');
      btn.innerHTML =
        '<div class="account-character-card-top">' +
          '<span class="account-character-card-name">' + escapeHtml(String(character.className || character.classTypeHex || 'Character')) + '</span>' +
          '<span class="account-character-card-badge">' + escapeHtml(badges.join(' • ')) + '</span>' +
        '</div>' +
        '<div class="account-character-card-meta">' +
          '<span>Fame ' + escapeHtml(String(character.fame || 0)) + '</span>' +
          '<span>HP ' + escapeHtml(String(character.hp || 0)) + '/' + escapeHtml(String(character.maxHp || 0)) + '</span>' +
          '<span>ID ' + escapeHtml(String(character.charId || 0)) + '</span>' +
        '</div>' +
        '<div class="account-character-card-equipment">' + buildEquipmentSpriteStripHtml(character.equipment) + '</div>';
      btn.addEventListener('click', function () {
        selectedAccountCharacterIdByAccountId[account.id] = Number(character.charId);
        renderAccountsOverview();
      });
      accountsCharactersListEl.appendChild(btn);
    });

    if (!selectedCharacter) {
      accountsCharacterDetailEl.innerHTML = '<div class="accounts-character-placeholder">Select a character to inspect its equipment and stats.</div>';
      return;
    }

    var slotLabels = ['Weapon', 'Ability', 'Armor', 'Ring'];
    var equipmentHtml = '';
    (selectedCharacter.equipment || []).forEach(function (item, index) {
      var isEmpty = !item || Number(item.objectType) < 0;
      equipmentHtml +=
        '<div class="accounts-equipment-slot">' +
          '<div class="accounts-equipment-label">' + escapeHtml(slotLabels[index] || ('Slot ' + String(index + 1))) + '</div>' +
          '<div class="accounts-equipment-visual">' + buildItemSpriteHtml(item) + '</div>' +
          (isEmpty ? '<div class="accounts-equipment-empty-note">Empty</div>' : '') +
        '</div>';
    });

    var stats = [
      { label: 'HP', value: String(selectedCharacter.hp || 0) + ' / ' + String(selectedCharacter.maxHp || 0) },
      { label: 'MP', value: String(selectedCharacter.mp || 0) + ' / ' + String(selectedCharacter.maxMp || 0) },
      { label: 'Fame', value: String(selectedCharacter.fame || 0) },
      { label: 'Exp', value: String(selectedCharacter.exp || 0) },
      { label: 'Attack', value: String(selectedCharacter.attack || 0) },
      { label: 'Defense', value: String(selectedCharacter.defense || 0) },
      { label: 'Speed', value: String(selectedCharacter.speed || 0) },
      { label: 'Dexterity', value: String(selectedCharacter.dexterity || 0) },
      { label: 'Vitality', value: String(selectedCharacter.vitality || 0) },
      { label: 'Wisdom', value: String(selectedCharacter.wisdom || 0) },
    ];
    var statsHtml = stats.map(function (stat) {
      return (
        '<div class="accounts-stat-tile">' +
          '<div class="accounts-stat-label">' + escapeHtml(stat.label) + '</div>' +
          '<div class="accounts-stat-value">' + escapeHtml(stat.value) + '</div>' +
        '</div>'
      );
    }).join('');
    var inventoryHtml = buildInventorySpriteStripHtml(selectedCharacter.inventory, selectedCharacter.backpacks);

    var pills = [
      '<span class="accounts-character-pill">Level ' + escapeHtml(String(selectedCharacter.level || 0)) + '</span>',
      '<span class="accounts-character-pill">Fame ' + escapeHtml(String(selectedCharacter.fame || 0)) + '</span>',
      '<span class="accounts-character-pill">Char ID ' + escapeHtml(String(selectedCharacter.charId || 0)) + '</span>',
    ];
    if (selectedCharacter.seasonal) pills.push('<span class="accounts-character-pill">Seasonal</span>');
    if (selectedCharacter.dead) pills.push('<span class="accounts-character-pill warn">Dead</span>');

    accountsCharacterDetailEl.innerHTML =
      '<div class="accounts-character-header">' +
        '<div>' +
          '<div class="accounts-character-title">' + escapeHtml(String(selectedCharacter.className || selectedCharacter.classTypeHex || 'Character')) + '</div>' +
          '<div class="accounts-character-subtitle">Type ' + escapeHtml(String(selectedCharacter.classTypeHex || '')) + '</div>' +
        '</div>' +
        '<div class="accounts-character-badges">' + pills.join('') + '</div>' +
      '</div>' +
      '<div class="accounts-character-section">' +
        '<div class="accounts-character-section-title">Equipped</div>' +
        '<div class="accounts-equipment-grid">' + equipmentHtml + '</div>' +
      '</div>' +
      '<div class="accounts-character-section">' +
        '<div class="accounts-character-section-title">Stats</div>' +
        '<div class="accounts-stats-grid">' + statsHtml + '</div>' +
      '</div>' +
      '<div class="accounts-character-section">' +
        '<div class="accounts-character-section-title">Inventory</div>' +
        inventoryHtml +
      '</div>';
  }

  function loadSelectedDashboardAccountOverview(forceReload) {
    var account = getSelectedDashboardAccount();
    if (!account) {
      renderAccountsOverview();
      return Promise.resolve(null);
    }
    var email = String(account.email || '').trim();
    var password = String(account.password || '');
    if (!email || !password) {
      invalidateDashboardAccountOverview(account.id);
      renderAccountsOverview();
      return Promise.resolve(null);
    }
    if (!forceReload && accountOverviewById[account.id]) {
      renderAccountsOverview();
      return Promise.resolve(accountOverviewById[account.id]);
    }

    accountOverviewLoadingId = account.id;
    setAccountOverviewNotice(account.id, 'Loading character list...', false);
    renderAccountsOverview();

    return fetchDashboardAccountOverview(account, !!forceReload)
      .then(function (result) {
        if (!result) return null;
        return storeDashboardAccountOverview(account, result.overview, { updatedAt: result.updatedAt, cached: !!result.cached });
      })
      .catch(function (err) {
        delete accountOverviewById[account.id];
        delete selectedAccountCharacterIdByAccountId[account.id];
        setAccountOverviewNotice(account.id, String(err && err.message || 'Failed to load character list.'), true);
        return null;
      })
      .finally(function () {
        if (accountOverviewLoadingId === account.id) accountOverviewLoadingId = null;
        renderAccountsOverview();
      });
  }

  function maybeLoadSelectedDashboardAccountOverview() {
    var account = getSelectedDashboardAccount();
    if (!account) {
      renderAccountsOverview();
      return;
    }
    if (!String(account.email || '').trim() || !String(account.password || '')) {
      renderAccountsOverview();
      return;
    }
    if (accountOverviewById[account.id] || accountOverviewLoadingId === account.id) {
      renderAccountsOverview();
      return;
    }
    loadSelectedDashboardAccountOverview(false);
  }

  function refreshAllDashboardAccountOverviews() {
    if (accountsRefreshAllLoading) return Promise.resolve(null);
    accountsRefreshAllLoading = true;
    renderAccountsOverview();
    setAccountsStatus('Refreshing all account data...', false);
    return fetch('/api/accounts/refresh-all', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    })
      .then(function (r) {
        return r.json().catch(function () { return {}; }).then(function (data) {
          if (!r.ok) throw new Error(String((data && data.error) || 'Failed to refresh all accounts.'));
          return data;
        });
      })
      .then(function (data) {
        var results = data && data.results && typeof data.results === 'object' ? data.results : {};
        var refreshed = 0;
        Object.keys(results).forEach(function (accountId) {
          var account = dashboardAccounts.find(function (entry) { return entry.id === accountId; });
          var result = results[accountId] || {};
          if (!account) return;
          if (result.ok && result.overview) {
            refreshed++;
            storeDashboardAccountOverview(account, result.overview, {
              updatedAt: Number(result.updatedAt || 0) || Date.now(),
              cached: false,
            });
          } else {
            setAccountOverviewNotice(account.id, String(result.error || 'Failed to refresh character list.'), true);
          }
        });
        setAccountsStatus('Refreshed ' + refreshed + ' account' + (refreshed === 1 ? '' : 's') + '.', false);
      })
      .catch(function (err) {
        setAccountsStatus(String(err && err.message || 'Failed to refresh all accounts.'), true);
      })
      .finally(function () {
        accountsRefreshAllLoading = false;
        renderAccountsTab();
      });
  }

  function refreshHwid() {
    setAccountsStatus('Refreshing HWID...', false);
    return fetch('/api/hwid/refresh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    })
      .then(function (r) {
        return r.json().catch(function () { return {}; }).then(function (data) {
          if (!r.ok) throw new Error(String((data && data.error) || 'Failed to refresh HWID.'));
          return data;
        });
      })
      .then(function (data) {
        var preview = (data && data.hwidPreview) || '';
        var msg = data && data.removed ? 'HWID refreshed (cached file cleared).' : 'HWID refreshed (no cache file present).';
        if (preview) msg += ' Now using ' + preview + '.';
        setAccountsStatus(msg, false);
      })
      .catch(function (err) {
        setAccountsStatus(String(err && err.message || 'Failed to refresh HWID.'), true);
      });
  }

  function renderAccountsServerOptions() {
    if (!accountsServerSelect) return;
    var account = getSelectedDashboardAccount();
    var currentValue = account ? String(account.serverName || '') : String(accountsServerSelect.value || '');
    var names = Array.isArray(availableServerNames) ? availableServerNames.slice() : [];
    if (currentValue && names.indexOf(currentValue) < 0) names.unshift(currentValue);
    if (!names.length) names = ['USWest'];
    accountsServerSelect.innerHTML = '';
    names.forEach(function (name) {
      var opt = document.createElement('option');
      opt.value = String(name);
      opt.textContent = String(name);
      accountsServerSelect.appendChild(opt);
    });
    accountsServerSelect.value = currentValue && names.indexOf(currentValue) >= 0 ? currentValue : names[0];
  }

  function renderAccountsList() {
    if (!accountsListEl || !accountsEmptyEl || !accountsCountEl) return;
    var query = String(accountsSearchInput && accountsSearchInput.value || '').trim().toLowerCase();
    if (accountsSortEl && String(accountsSortEl.value || '') !== String(accountsSortMode || 'newest')) {
      accountsSortEl.value = String(accountsSortMode || 'newest');
    }
    var filtered = dashboardAccounts.filter(function (account) {
      if (!query) return true;
      var haystack = [
        account.label || '',
        account.email || '',
        account.serverName || '',
        account.notes || '',
      ].join(' ').toLowerCase();
      return haystack.indexOf(query) >= 0;
    });
    var getDisplayName = function (account) {
      return String(account.label || account.email || 'Unnamed Account');
    };
    var getSortFame = function (account) {
      var overview = accountOverviewById[account.id];
      if (!overview || typeof overview !== 'object') return 0;
      var bestFame = Number(overview.bestCharFame);
      if (Number.isFinite(bestFame)) return bestFame;
      var characters = Array.isArray(overview.characters) ? overview.characters : [];
      if (!characters.length) return 0;
      var fallbackBest = 0;
      characters.forEach(function (character) {
        var fame = Number(character && character.fame || 0);
        if (Number.isFinite(fame) && fame > fallbackBest) fallbackBest = fame;
      });
      return fallbackBest;
    };
    var sorted = filtered.slice();
    sorted.sort(function (a, b) {
      var mode = String(accountsSortMode || 'newest');
      if (mode === 'fame') {
        var fameDelta = getSortFame(b) - getSortFame(a);
        if (fameDelta !== 0) return fameDelta;
      } else if (mode === 'alphabetical') {
        var alpha = getDisplayName(a).localeCompare(getDisplayName(b), undefined, { sensitivity: 'base' });
        if (alpha !== 0) return alpha;
      } else if (mode === 'oldest') {
        var oldDelta = Number(a.createdAt || 0) - Number(b.createdAt || 0);
        if (oldDelta !== 0) return oldDelta;
      } else {
        var newDelta = Number(b.createdAt || 0) - Number(a.createdAt || 0);
        if (newDelta !== 0) return newDelta;
      }
      return getDisplayName(a).localeCompare(getDisplayName(b), undefined, { sensitivity: 'base' });
    });
    accountsListEl.innerHTML = '';
    accountsListEl.classList.toggle('reorder-mode', accountsReorderMode);
    accountsCountEl.textContent = sorted.length + ' account' + (sorted.length === 1 ? '' : 's');
    accountsEmptyEl.textContent = dashboardAccounts.length ? 'No accounts match that search.' : 'No accounts saved yet.';
    accountsEmptyEl.style.display = sorted.length ? 'none' : '';
    var renderList = accountsReorderMode ? dashboardAccounts : sorted;
    renderList.forEach(function (account) {
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'account-card' + (account.id === selectedAccountId ? ' selected' : '');
      var displayName = String(account.label || account.email || 'Unnamed Account');
      btn.innerHTML =
        '<div class="account-card-title">' +
          '<span class="account-card-name">' + escapeHtml(displayName) + '</span>' +
          '<span class="account-card-server">' + escapeHtml(String(account.serverName || 'USWest')) + '</span>' +
        '</div>' +
        (showAccountEmails ? ('<div class="account-card-email">' + escapeHtml(String(account.email || 'No email')) + '</div>') : '');
      if (accountsReorderMode) {
        btn.draggable = true;
        btn.setAttribute('data-account-id', account.id);
        btn.addEventListener('dragstart', function (e) {
          e.dataTransfer.setData('text/plain', account.id);
          e.dataTransfer.effectAllowed = 'move';
        });
        btn.addEventListener('dragover', function (e) {
          e.preventDefault();
          e.dataTransfer.dropEffect = 'move';
          btn.classList.add('drag-over');
        });
        btn.addEventListener('dragleave', function () {
          btn.classList.remove('drag-over');
        });
        btn.addEventListener('drop', function (e) {
          e.preventDefault();
          btn.classList.remove('drag-over');
          var draggedId = e.dataTransfer.getData('text/plain');
          if (draggedId === account.id) return;
          var fromIdx = -1, toIdx = -1;
          dashboardAccounts.forEach(function (a, i) {
            if (a.id === draggedId) fromIdx = i;
            if (a.id === account.id) toIdx = i;
          });
          if (fromIdx < 0 || toIdx < 0) return;
          var moved = dashboardAccounts.splice(fromIdx, 1)[0];
          dashboardAccounts.splice(toIdx, 0, moved);
          setAccountsDirty(true, 'Account order changed. Save to persist.');
          renderAccountsList();
        });
      } else {
        btn.addEventListener('click', function () {
          selectedAccountId = account.id;
          renderAccountsTab();
          maybeLoadSelectedDashboardAccountOverview();
        });
      }
      accountsListEl.appendChild(btn);
    });
  }

  function toggleAccountsReorderMode() {
    accountsReorderMode = !accountsReorderMode;
    renderAccountsList();
  }

  function isSelectedAccountRunning() {
    var account = getSelectedDashboardAccount();
    if (!account || !gameConnected || !lastPlayerData) return false;
    var accountEmail = String(account.email || '').trim().toLowerCase();
    var connectedEmail = String((lastPlayerData && lastPlayerData.email) || '').trim().toLowerCase();
    if (!accountEmail) return false;
    return accountEmail === connectedEmail;
  }

  function renderAccountsEditor() {
    var account = getSelectedDashboardAccount();
    var disabled = !account;
    var isRunning = isSelectedAccountRunning();
    var fieldDisabled = disabled || isRunning;
    renderAccountsServerOptions();
    suppressAccountsEditorEvents = true;
    // Update editor header display name, sub-label, and avatar
    var displayNameEl = document.getElementById('accounts-editor-display-name');
    var displaySubEl = document.getElementById('accounts-editor-display-sub');
    var avatarEl = document.getElementById('accounts-editor-avatar');
    if (displayNameEl) displayNameEl.textContent = account ? (account.label || 'Unnamed Account') : 'Select an account';
    if (displaySubEl) displaySubEl.textContent = account ? (account.email || '') : '';
    if (avatarEl) {
      var initial = (account ? (account.label || account.email || 'A') : 'A').charAt(0).toUpperCase();
      avatarEl.textContent = initial;
    }
    var editorTitleTextEl = document.getElementById('accounts-editor-title-text');
    if (editorTitleTextEl) {
      editorTitleTextEl.textContent = account
        ? ('Account Details: ' + String(account.label || account.email || 'Unnamed'))
        : 'Account Details';
    }
    if (accountsAliasInput) {
      accountsAliasInput.disabled = fieldDisabled;
      accountsAliasInput.value = account ? String(account.label || '') : '';
    }
    if (accountsEmailInput) {
      accountsEmailInput.disabled = fieldDisabled;
      accountsEmailInput.value = account ? String(account.email || '') : '';
    }
    if (accountsPasswordInput) {
      accountsPasswordInput.disabled = fieldDisabled;
      accountsPasswordInput.value = account ? String(account.password || '') : '';
      accountsPasswordInput.type = accountsPasswordVisible && !fieldDisabled ? 'text' : 'password';
    }
    if (accountsPasswordVisibilityBtn) {
      accountsPasswordVisibilityBtn.disabled = fieldDisabled;
      accountsPasswordVisibilityBtn.textContent = accountsPasswordVisible && !fieldDisabled ? 'Hide' : 'Show';
    }
    if (accountsServerSelect) {
      accountsServerSelect.disabled = fieldDisabled;
      if (account) accountsServerSelect.value = String(account.serverName || accountsServerSelect.value || 'USWest');
    }
    if (accountsNotesInput) {
      accountsNotesInput.disabled = fieldDisabled;
      accountsNotesInput.value = account ? String(account.notes || '') : '';
    }
    var isSteam = !!(account && account.isSteam);
    if (accountsIsSteamInput) {
      accountsIsSteamInput.disabled = fieldDisabled;
      accountsIsSteamInput.checked = isSteam;
    }
    if (accountsEmailLabel) accountsEmailLabel.textContent = isSteam ? 'GUID' : 'Email';
    if (accountsPasswordLabel) accountsPasswordLabel.textContent = isSteam ? 'Steam Secret' : 'Password';
    if (accountsEmailInput) accountsEmailInput.placeholder = isSteam ? 'steamworks:…' : 'name@example.com';
    if (accountsSteamIdWrap) accountsSteamIdWrap.style.display = isSteam ? '' : 'none';
    var steamImportRow = document.getElementById('accounts-steam-import-row');
    if (steamImportRow) steamImportRow.style.display = isSteam ? '' : 'none';
    var loginCreds = document.getElementById('accounts-login-creds');
    if (loginCreds) loginCreds.classList.toggle('is-steam', isSteam);
    var steamCredsLabel = document.getElementById('accounts-steam-creds-label');
    if (steamCredsLabel) steamCredsLabel.style.display = isSteam ? '' : 'none';
    if (accountsOverviewRefreshBtn) accountsOverviewRefreshBtn.disabled = disabled;
    if (accountsFillBtn) accountsFillBtn.disabled = disabled;
    if (accountsLaunchBtn) accountsLaunchBtn.disabled = disabled;
    suppressAccountsEditorEvents = false;
  }

  function applyAccountsDetailsVisibility() { /* replaced by editor tabs */ }

  function populateSetupServerOptions() {
    if (window._populateSetupServers) window._populateSetupServers();
  }

  function renderAccountsTab() {
    var hasAccounts = dashboardAccounts.length > 0;
    if (accountsSetupEl) accountsSetupEl.style.display = hasAccounts ? 'none' : '';
    if (accountsMainEl) accountsMainEl.style.display = hasAccounts ? '' : 'none';
    if (!hasAccounts) {
      if (window._populateSetupServers) window._populateSetupServers();
      if (activeTab === 'home') renderHomeTab();
      return;
    }
    applyAccountsDetailsVisibility();
    renderAccountsList();
    renderAccountsEditor();
    renderAccountsOverview();
    if (activeTab === 'home') renderHomeTab();
  }

  function loadDashboardAccounts() {
    return fetch('/api/accounts')
      .then(function (r) { if (!r.ok) throw new Error('Failed to load accounts'); return r.json(); })
      .then(function (data) {
        dashboardAccounts = Array.isArray(data && data.accounts) ? data.accounts.map(normalizeDashboardAccount) : [];
        accountOverviewById = Object.create(null);
        accountOverviewNoticeById = Object.create(null);
        pruneDashboardAccountOverviewState();
        var cachedOverviews = data && data.cachedOverviews && typeof data.cachedOverviews === 'object' ? data.cachedOverviews : {};
        dashboardAccounts.forEach(function (account) {
          var cached = cachedOverviews[account.id];
          if (!cached || !cached.overview || typeof cached.overview !== 'object') return;
          storeDashboardAccountOverview(account, cached.overview, {
            updatedAt: Number(cached.updatedAt || 0) || Date.now(),
            cached: true,
          });
        });
        if (!selectedAccountId || !dashboardAccounts.some(function (account) { return account.id === selectedAccountId; })) {
          selectedAccountId = dashboardAccounts[0] ? dashboardAccounts[0].id : null;
        }
        setAccountsDirty(false);
        setAccountsStatus('', false);
        renderAccountsTab();
        maybeLoadSelectedDashboardAccountOverview();
        updateQuickLaunchBtn();

      })
      .catch(function () {
        dashboardAccounts = [];
        selectedAccountId = null;
        pruneDashboardAccountOverviewState();
        setAccountsStatus('Failed to load accounts.', true);
        renderAccountsTab();

      });
  }

  function saveDashboardAccounts() {
    fetch('/api/accounts/save', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accounts: dashboardAccounts }),
    })
      .then(function (r) { if (!r.ok) throw new Error('Failed to save accounts'); return r.json(); })
      .then(function (data) {
        dashboardAccounts = Array.isArray(data && data.accounts) ? data.accounts.map(normalizeDashboardAccount) : dashboardAccounts;
        pruneDashboardAccountOverviewState();
        if (!selectedAccountId && dashboardAccounts[0]) selectedAccountId = dashboardAccounts[0].id;
        setAccountsDirty(false, 'Accounts saved.');
        renderAccountsTab();
        maybeLoadSelectedDashboardAccountOverview();
    
      })
      .catch(function () {
        setAccountsStatus('Failed to save accounts.', true);
      });
  }

  function createDashboardAccount(copySelected) {
    var next = createEmptyDashboardAccount();
    if (copySelected) {
      var current = getSelectedDashboardAccount();
      if (current) {
        next.label = current.label ? String(current.label) + ' Copy' : '';
        next.email = String(current.email || '');
        next.password = String(current.password || '');
        next.serverName = String(current.serverName || next.serverName);
        next.notes = String(current.notes || '');
      }
    }
    dashboardAccounts.unshift(next);
    selectedAccountId = next.id;
    accountsDetailsCollapsed = false;
    applyAccountsDetailsVisibility();
    setAccountsDirty(true, copySelected ? 'Account duplicated. Save to persist it.' : 'New account created. Save to persist it.');
    renderAccountsTab();
    maybeLoadSelectedDashboardAccountOverview();
    if (accountsAliasInput) accountsAliasInput.focus();
  }

  function showDeleteAccountModal() {
    var account = getSelectedDashboardAccount();
    if (!account) return;
    var displayName = String(account.label || account.email || 'this account');
    if (accountsDeleteModalMsg) accountsDeleteModalMsg.textContent = 'Are you sure you want to delete "' + displayName + '"? This cannot be undone.';
    if (accountsDeleteModal) accountsDeleteModal.style.display = '';
  }

  function hideDeleteAccountModal() {
    if (accountsDeleteModal) accountsDeleteModal.style.display = 'none';
  }

  function showLockedModal() {
    if (accountsLockedModal) accountsLockedModal.style.display = '';
  }

  function hideLockedModal() {
    if (accountsLockedModal) accountsLockedModal.style.display = 'none';
  }

  function confirmDeleteSelectedAccount() {
    var account = getSelectedDashboardAccount();
    hideDeleteAccountModal();
    if (!account) return;
    invalidateDashboardAccountOverview(account.id);
    dashboardAccounts = dashboardAccounts.filter(function (entry) { return entry.id !== account.id; });
    selectedAccountId = dashboardAccounts[0] ? dashboardAccounts[0].id : null;
    renderAccountsTab();
    maybeLoadSelectedDashboardAccountOverview();
    saveDashboardAccounts();
  }

  function inferSteamIdFromAccount(account) {
    var explicit = String(account && account.steamId || '').trim();
    if (explicit) return explicit;
    var guid = String(account && account.email || '').trim();
    var match = guid.match(/^steamworks:(\d{6,20})$/i);
    return match ? match[1] : '';
  }

  function launchOptsWithAccount(account, overrides) {
    var opts = Object.assign({}, overrides || {});
    if (!account) return opts;
    if (opts.accountId == null) opts.accountId = account.id;
    if (opts.accountLabel == null) opts.accountLabel = String(account.label || account.email || '');
    if (opts.isSteam == null) opts.isSteam = !!account.isSteam;
    if (opts.steamId == null) opts.steamId = inferSteamIdFromAccount(account);
    return opts;
  }

  function launchGameWithCredentials(email, password, serverName, source, launchOpts) {
    launchOpts = launchOpts && typeof launchOpts === 'object' ? launchOpts : {};
    var compactWindow = typeof source === 'boolean' ? source : !!launchOpts.compactWindow;
    // Arm session tracking for this account so the first gameClient connect
    // we get after this point opens a session under this email.
    try { window._AccountSessions && window._AccountSessions.armLaunch(email); } catch (_) {}
    if (!email || !password) {
      setAccountsStatus(launchOpts.isSteam ? 'GUID and secret are required to launch.' : 'Email and password are required to launch.', true);
      return false;
    }
    if (launchOpts.isSteam && !String(launchOpts.steamId || '').trim()) {
      setAccountsStatus('Steam ID is required for Steam accounts.', true);
      return false;
    }
    if (!ws || ws.readyState !== 1) {
      setAccountsStatus('Dashboard connection is offline.', true);
      return false;
    }

    if (!launchOpts.suppressAccountsLaunchBtn && accountsLaunchBtn) {
      accountsLaunchBtn.disabled = true;
      accountsLaunchBtn.textContent = 'Launching...';
    }
    if (!launchOpts.suppressAccountsLaunchBtn) {
      setAccountsStatus('Launching selected account...', false);
    }

    var wr = launchOpts.windowRect;
    var hasRect =
      wr &&
      Number.isFinite(Number(wr.x)) &&
      Number.isFinite(Number(wr.y)) &&
      Number.isFinite(Number(wr.width)) &&
      Number.isFinite(Number(wr.height));
    var payload = {
      type: 'launchGameWithCredentials',
      email: email,
      password: password,
      serverName: serverName,
      compactWindow: !!compactWindow && !hasRect,
    };
    if (hasRect) {
      payload.windowRect = {
        x: Math.round(Number(wr.x)),
        y: Math.round(Number(wr.y)),
        width: Math.round(Number(wr.width)),
        height: Math.round(Number(wr.height)),
      };
    }
    var aid = launchOpts.accountId != null && String(launchOpts.accountId).trim() !== ''
      ? String(launchOpts.accountId).trim()
      : '';
    if (aid) payload.accountId = aid;
    var alab =
      launchOpts.accountLabel != null && String(launchOpts.accountLabel).trim() !== ''
        ? String(launchOpts.accountLabel).trim()
        : '';
    if (alab) payload.accountLabel = alab;
    if (launchOpts.isSteam) {
      payload.isSteam = true;
      payload.steamId = String(launchOpts.steamId || '').trim();
    }
    ws.send(JSON.stringify(payload));
    return true;
  }

  function handleConfig(msg) {
    // Capture bot API URL for direct script upload requests
    if (msg.botApiUrl) window._botApiUrl = String(msg.botApiUrl);
    rotmgPath = msg.rotmgPath || '';
    rotmgPathSource = msg.rotmgPathSource || 'none';
    var isAdminUser = !!(dashboardUser && dashboardUser.is_admin);
    // Non-admins are always locked to singleClientOnly=true regardless of server config
    if (isAdminUser) {
      singleClientOnly = msg.singleClientOnly !== false;
    } else {
      singleClientOnly = true;
    }
    serverPluginConfigId = String(msg.pluginConfigId || '');
    availableServerNames = Array.isArray(msg.serverNames) ? msg.serverNames.slice() : [];
    if (singleClientOnlyToggle) {
      singleClientOnlyToggle.checked = singleClientOnly;
      singleClientOnlyToggle.disabled = !isAdminUser;
      var scoRow = singleClientOnlyToggle.closest('.settings-row');
      if (scoRow) scoRow.classList.toggle('settings-row--locked', !isAdminUser);
    }
    if (serverPluginConfigId) localStorage.setItem('pluginConfigSelected', serverPluginConfigId);
    renderAccountsTab();

    // Update settings modal
    if (rotmgPathSource === 'custom') {
      rotmgPathInput.value = rotmgPath;
      rotmgPathDesc.textContent = 'Custom path configured';
    } else if (rotmgPathSource === 'auto') {
      rotmgPathInput.value = '';
      rotmgPathInput.placeholder = rotmgPath || 'Auto-detected';
      rotmgPathDesc.textContent = 'Auto-detected: ' + rotmgPath;
    } else {
      rotmgPathInput.value = '';
      rotmgPathInput.placeholder = 'Not found — enter path manually';
      rotmgPathDesc.textContent = 'RotMG installation not detected';
    }

    updateDashboardAvailabilityUi();
  }

  // ─── Launch game (credentials on Game Not Connected overlay) ───

  function setPluginConfigStatus(text, isError) {
    if (!pluginConfigStatus) return;
    pluginConfigStatus.textContent = text || '';
    pluginConfigStatus.style.color = isError ? 'var(--danger)' : '';
  }

  function renderPluginConfigs() {
    if (!pluginConfigSelect) return;
    const prev = pluginConfigSelect.value || serverPluginConfigId || localStorage.getItem('pluginConfigSelected') || '';
    pluginConfigSelect.innerHTML = '';
    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = pluginConfigs.length ? 'Select a config...' : 'No saved configs';
    pluginConfigSelect.appendChild(placeholder);
    pluginConfigs.forEach(function (cfg) {
      const opt = document.createElement('option');
      opt.value = String(cfg.id || '');
      opt.textContent = String(cfg.name || cfg.id || 'Unnamed');
      pluginConfigSelect.appendChild(opt);
    });
    if (prev && pluginConfigs.some(function (c) { return String(c.id) === prev; })) {
      pluginConfigSelect.value = prev;
    }
  }

  function loadPluginConfigs() {
    return fetch('/api/configs')
      .then(function (r) { if (!r.ok) throw new Error('Failed to list configs'); return r.json(); })
      .then(function (data) {
        pluginConfigs = Array.isArray(data && data.configs) ? data.configs : [];
        renderPluginConfigs();
      })
      .catch(function () {
        pluginConfigs = [];
        renderPluginConfigs();
        setPluginConfigStatus('Failed to load config list.', true);
      });
  }

  function savePluginConfig() {
    const name = (pluginConfigNameInput && pluginConfigNameInput.value || '').trim();
    if (!name) {
      setPluginConfigStatus('Enter a config name first.', true);
      return;
    }
    fetch('/api/configs/save', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: name }),
    })
      .then(function (r) { if (!r.ok) throw new Error('Save failed'); return r.json(); })
      .then(function (data) {
        const cfg = data && data.config ? data.config : null;
        const savedId = cfg && cfg.id ? String(cfg.id) : '';
        if (savedId) localStorage.setItem('pluginConfigSelected', savedId);
        setPluginConfigStatus('Config saved.', false);
        return loadPluginConfigs();
      })
      .then(function () {
        const selected = localStorage.getItem('pluginConfigSelected') || '';
        if (selected && pluginConfigSelect) pluginConfigSelect.value = selected;
      })
      .catch(function () {
        setPluginConfigStatus('Failed to save config.', true);
      });
  }

  function loadSelectedPluginConfig() {
    const id = pluginConfigSelect && pluginConfigSelect.value ? String(pluginConfigSelect.value) : '';
    if (!id) {
      setPluginConfigStatus('Select a config to load.', true);
      return;
    }
    fetch('/api/configs/load', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: id }),
    })
      .then(function (r) { if (!r.ok) throw new Error('Load failed'); return r.json(); })
      .then(function () {
        localStorage.setItem('pluginConfigSelected', id);
        setPluginConfigStatus('Config loaded.', false);
      })
      .catch(function () {
        setPluginConfigStatus('Failed to load config.', true);
      });
  }

  function doLaunchGame() {
    openDashboardTab('accounts');
  }

  function setAuthOverlayLoading(loading) {
    var mode = disconnectOverlay ? (disconnectOverlay.getAttribute('data-mode') || 'signin') : 'signin';
    if (overlayLoginBtn) {
      overlayLoginBtn.disabled = !!loading;
      overlayLoginBtn.textContent = loading && mode !== 'register' ? 'Signing in...' : 'Sign in';
    }
    var regBtn = document.getElementById('overlay-register-btn');
    if (regBtn) {
      regBtn.disabled = !!loading;
      regBtn.textContent = loading && mode === 'register' ? 'Creating account...' : 'Create account';
    }
    if (overlayPasswordToggleBtn) overlayPasswordToggleBtn.disabled = !!loading;
  }

  // ── Auth rate limiting (client-side) ──────────────────────────────────────
  function authRateLimitKey(type) {
    // type='login' → hourly bucket; type='register' → daily bucket
    var now = new Date();
    if (type === 'login') {
      return 'auth_login_' + now.getFullYear() + '-' + String(now.getMonth()+1).padStart(2,'0') + '-' + String(now.getDate()).padStart(2,'0') + 'T' + String(now.getHours()).padStart(2,'0');
    }
    return 'auth_register_' + now.getFullYear() + '-' + String(now.getMonth()+1).padStart(2,'0') + '-' + String(now.getDate()).padStart(2,'0');
  }
  function authRateLimitCount(type) {
    return parseInt(localStorage.getItem(authRateLimitKey(type)) || '0', 10);
  }
  function authRateLimitIncrement(type) {
    var key = authRateLimitKey(type);
    localStorage.setItem(key, String(parseInt(localStorage.getItem(key) || '0', 10) + 1));
  }

  function doDashboardLogin() {
    var email = (overlayEmailInput && overlayEmailInput.value || '').trim();
    var password = (overlayPasswordInput && overlayPasswordInput.value || '');
    if (!email || !password) {
      setOverlayLoginError('Enter email and password.');
      return;
    }
    if (authRateLimitCount('login') >= 4) {
      setOverlayLoginError('Too many login attempts. Try again next hour.');
      return;
    }
    authRateLimitIncrement('login');
    setOverlayLoginError('');
    setAuthOverlayLoading(true);
    fetchAuthWithTimeout('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: email, password: password }),
    }, 15000, 'Sign in timed out. The local dashboard or Realm Engine auth API is not responding.')
      .then(function (r) { return readAuthResponse(r, 'Sign in failed.'); })
      .then(function (data) {
        if (!data.access_token) throw new Error('Sign in failed: no session token returned.');
        accessToken = data.access_token || null;
        refreshToken = data.refresh_token || null;
        persistDashboardLoginState();
        if (email) localStorage.setItem('lastLoginEmail', email);
        if (overlayPasswordInput) overlayPasswordInput.value = '';
        resetOverlayPasswordVisibility();
        return fetchCurrentUser(true);
      })
      .then(function () {
        setOverlayLoginError('');
      })
      .catch(function (err) {
        setOverlayLoginError(authDisplayError(err, 'Sign in failed.'));
      })
      .finally(function () {
        setAuthOverlayLoading(false);
      });
  }

  function doRegister() {
    var email = (overlayEmailInput && overlayEmailInput.value || '').trim();
    var password = (overlayPasswordInput && overlayPasswordInput.value || '');
    if (!email || !password) {
      setOverlayLoginError('Enter email and password.');
      return;
    }
    if (password.length < 6) {
      setOverlayLoginError('Password must be at least 6 characters.');
      return;
    }
    if (authRateLimitCount('register') >= 2) {
      setOverlayLoginError('Account creation limit reached (2 per day). Try again tomorrow.');
      return;
    }
    authRateLimitIncrement('register');
    setOverlayLoginError('');
    setAuthOverlayLoading(true);
    fetchAuthWithTimeout('/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: email, password: password }),
    }, 15000, 'Account creation timed out. The local dashboard or Realm Engine auth API is not responding.')
      .then(function (r) { return readAuthResponse(r, 'Account creation failed.'); })
      .then(function (data) {
        if (!data.access_token) throw new Error('Account creation failed: no session token returned.');
        accessToken = data.access_token || null;
        refreshToken = data.refresh_token || null;
        persistDashboardLoginState();
        if (overlayPasswordInput) overlayPasswordInput.value = '';
        resetOverlayPasswordVisibility();
        return fetchCurrentUser(true);
      })
      .then(function () {
        setOverlayLoginError('');
        setOverlayAuthMode('signin');
      })
      .catch(function (err) {
        setOverlayLoginError(authDisplayError(err, 'Account creation failed.'));
      })
      .finally(function () {
        setAuthOverlayLoading(false);
      });
  }

  if (launchGameBtn) launchGameBtn.addEventListener('click', function () { doLaunchGame(); });
  if (overlayLoginBtn) overlayLoginBtn.addEventListener('click', function () { doDashboardLogin(); });
  var overlayRegisterBtn = document.getElementById('overlay-register-btn');
  if (overlayRegisterBtn) overlayRegisterBtn.addEventListener('click', function () { doRegister(); });
  var overlaySwitchRegister = document.getElementById('overlay-switch-to-register');
  var overlaySwitchSignin = document.getElementById('overlay-switch-to-signin');
  if (overlaySwitchRegister) overlaySwitchRegister.addEventListener('click', function () { setOverlayAuthMode('register'); });
  if (overlaySwitchSignin) overlaySwitchSignin.addEventListener('click', function () { setOverlayAuthMode('signin'); });

  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Enter') return;
    if (!disconnectOverlay || disconnectOverlay.classList.contains('hidden')) return;
    e.preventDefault();
    var mode = disconnectOverlay.getAttribute('data-mode') || 'signin';
    if (mode === 'register') doRegister();
    else doDashboardLogin();
  });

  function handleLaunchResult(msg) {
    if (accountsLaunchBtn) {
      accountsLaunchBtn.disabled = !getSelectedDashboardAccount();
      accountsLaunchBtn.textContent = 'Launch';
    }

    var quietOk = msg.ok && Date.now() < macGroupLaunchQuietFeedUntil;
    if (quietOk) return;

    if (msg.ok) {
      setAccountsStatus(t('home.action.launchSent'), false);
      addHomeFeed('ok', t('home.action.launchSent'));
      setHomeActionStatus(t('home.action.launchSent'));
    } else {
      macGroupLaunchQuietFeedUntil = 0;
      setAccountsStatus(msg.error || 'Launch failed.', true);
      addHomeFeed('err', msg.error || 'Launch failed.');
      setHomeActionStatus(msg.error || 'Launch failed.');
    }
  }

  // ─── Packet Lab ───────────────────────────────────────

  const labTypeList  = document.getElementById('lab-type-list');
  const labDetail    = document.getElementById('lab-detail');
  const labTabBadge  = document.getElementById('lab-tab-badge');
  const labIdInput   = document.getElementById('lab-id');
  const labSpecInput = document.getElementById('lab-spec');
  const labProbeBtn  = document.getElementById('lab-probe-btn');
  const labByteInput = document.getElementById('lab-byte-input');
  const labByteLoadBtn = document.getElementById('lab-byte-load-btn');
  const labByteClearBtn = document.getElementById('lab-byte-clear-btn');
  const labByteGrid = document.getElementById('lab-byte-grid');
  const labByteSelection = document.getElementById('lab-byte-selection');
  const labByteCount = document.getElementById('lab-byte-count');
  const labByteResults = document.getElementById('lab-byte-results');

  function sendLabPacket(packetName, data, cb) {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      if (typeof cb === 'function') cb({ ok: false, message: 'Dashboard socket is disconnected.' });
      return;
    }
    const requestId = labSendReqSeq++;
    if (typeof cb === 'function') labSendPending.set(requestId, cb);
    ws.send(JSON.stringify({
      type: 'sendLabPacket',
      requestId: requestId,
      packetName: packetName,
      data: data || {},
    }));
  }

  function handleLabPacketSendResult(msg) {
    const requestId = Number(msg.requestId);
    if (!Number.isFinite(requestId)) return;
    const cb = labSendPending.get(requestId);
    if (!cb) return;
    labSendPending.delete(requestId);
    cb(msg.result || { ok: false, message: 'No send result returned.' });
  }

  function getFieldByteSize(field) {
    const t = (field.type || '').toLowerCase();
    if (t === 'byte' || t === 'sbyte' || t === 'bool') return 1;
    if (t === 'int16' || t === 'uint16') return 2;
    if (t === 'int32' || t === 'uint32' || t === 'float') return 4;
    return null;
  }

  function buildLabPacketSender(packet) {
    if (!packet) return null;
    const packetName = String(packet.name || '').toUpperCase();
    const direction = String(packet.direction || '').toLowerCase();
    if (direction !== 'client' || !LAB_SENDABLE_PACKETS.has(packetName)) return null;

    const sec = document.createElement('div');
    sec.className = 'lab-send-section';

    const title = document.createElement('div');
    title.className = 'lab-send-title';
    title.textContent = 'Send Packet';
    sec.appendChild(title);

    const help = document.createElement('div');
    help.className = 'lab-send-help';
    if (packetName === 'ACCEPTTRADE') {
      help.textContent = 'Header and offer arrays are auto-filled from current trade state.';
    } else if (packetName === 'CHANGETRADE') {
      help.textContent = 'Enter offered slot indexes (0-based), e.g. 0,2,5 or all.';
    } else if (packetName === 'REQUESTTRADE') {
      help.textContent = 'Sends a trade request to the specified player.';
    } else if (packetName === 'PARTYACTIONRESULT') {
      help.textContent = 'C→S id 204: party UI action (e.g. refresh list). Defaults: playerId 65535, actionId 5.';
    } else if (packetName === 'PARTYJOINREQUEST') {
      help.textContent = 'C→S id 215: request to join a party. Set partyId from PARTYLISTMESSAGE; trailing byte often 1 or 4.';
    } else {
      help.textContent = 'Sends this packet with the current structure defaults.';
    }
    sec.appendChild(help);

    const status = document.createElement('div');
    status.className = 'lab-send-status';
    sec.appendChild(status);

    function setStatus(result) {
      if (!result) return;
      const ok = !!result.ok;
      status.className = 'lab-send-status ' + (ok ? 'ok' : 'err');
      status.textContent = result.message || (ok ? 'Packet sent.' : 'Failed to send packet.');
    }

    function setPending() {
      status.className = 'lab-send-status pending';
      status.textContent = 'Sending...';
    }

    const row = document.createElement('div');
    row.className = 'lab-send-row';

    const sendBtn = document.createElement('button');
    sendBtn.type = 'button';
    sendBtn.className = 'lab-send-btn';
    sendBtn.textContent = 'Send';

    function sendNow(payload) {
      sendBtn.disabled = true;
      setPending();
      sendLabPacket(packetName, payload, function (result) {
        sendBtn.disabled = false;
        setStatus(result);
      });
    }

    if (packetName === 'REQUESTTRADE') {
      const nameInput = document.createElement('input');
      nameInput.type = 'text';
      nameInput.className = 'lab-send-input';
      nameInput.placeholder = 'Target player name';
      nameInput.addEventListener('keydown', function (e) {
        if (e.key !== 'Enter') return;
        e.preventDefault();
        sendBtn.click();
      });
      sendBtn.addEventListener('click', function () {
        const target = nameInput.value.trim();
        if (!target) {
          setStatus({ ok: false, message: 'Enter a player name first.' });
          return;
        }
        sendNow({ name: target });
      });
      row.appendChild(nameInput);
    } else if (packetName === 'CHANGETRADE') {
      const offerInput = document.createElement('input');
      offerInput.type = 'text';
      offerInput.className = 'lab-send-input';
      offerInput.placeholder = 'offer slots: 0,2,5 or all';
      offerInput.addEventListener('keydown', function (e) {
        if (e.key !== 'Enter') return;
        e.preventDefault();
        sendBtn.click();
      });
      sendBtn.addEventListener('click', function () {
        sendNow({ offerSlots: offerInput.value.trim() });
      });
      row.appendChild(offerInput);
    } else if (packetName === 'PARTYACTIONRESULT') {
      const playerIdInput = document.createElement('input');
      playerIdInput.type = 'number';
      playerIdInput.className = 'lab-send-input';
      playerIdInput.min = '0';
      playerIdInput.max = '65535';
      playerIdInput.placeholder = 'playerId (65535 = self)';
      playerIdInput.value = '65535';
      const actionIdInput = document.createElement('input');
      actionIdInput.type = 'number';
      actionIdInput.className = 'lab-send-input';
      actionIdInput.min = '0';
      actionIdInput.max = '255';
      actionIdInput.placeholder = 'actionId';
      actionIdInput.value = '5';
      function partyActionPayload() {
        return {
          playerId: Number(playerIdInput.value),
          actionId: Number(actionIdInput.value),
        };
      }
      sendBtn.addEventListener('click', function () {
        sendNow(partyActionPayload());
      });
      row.appendChild(playerIdInput);
      row.appendChild(actionIdInput);
    } else if (packetName === 'INVENTORYSWAP') {
      help.textContent = 'objectType = item type id IN the slot (NOT entity type). Empty slot = -1. Vault withdraw: s1=(chestOid, vaultSlot, itemType), s2=(playerOid, invSlot, -1). time+pos auto-filled.';
      function makeSwapInput(placeholder) {
        const inp = document.createElement('input');
        inp.type = 'number';
        inp.className = 'lab-send-input';
        inp.placeholder = placeholder;
        inp.style.width = '90px';
        return inp;
      }
      const o1oidInp  = makeSwapInput('s1 objectId (chest/player oid)');
      const o1slotInp = makeSwapInput('s1 slotId (slot index)');
      const o1typeInp = makeSwapInput('s1 itemType (item IN slot, -1=empty)');
      const o2oidInp  = makeSwapInput('s2 objectId (player/chest oid)');
      const o2slotInp = makeSwapInput('s2 slotId (slot index)');
      const o2typeInp = makeSwapInput('s2 itemType (item IN slot, -1=empty)');
      const sep = document.createElement('span');
      sep.textContent = ' → ';
      sep.style.margin = '0 4px';
      row.appendChild(o1oidInp);
      row.appendChild(o1slotInp);
      row.appendChild(o1typeInp);
      row.appendChild(sep);
      row.appendChild(o2oidInp);
      row.appendChild(o2slotInp);
      row.appendChild(o2typeInp);
      sendBtn.addEventListener('click', function () {
        const vals = [o1oidInp, o1slotInp, o1typeInp, o2oidInp, o2slotInp, o2typeInp];
        for (const v of vals) {
          if (v.value.trim() === '') {
            setStatus({ ok: false, message: 'Fill all 6 fields: s1 objectId/slotId/objectType and s2 objectId/slotId/objectType.' });
            return;
          }
        }
        sendNow({
          o1oid:  Number(o1oidInp.value),  o1slot: Number(o1slotInp.value),  o1type: Number(o1typeInp.value),
          o2oid:  Number(o2oidInp.value),  o2slot: Number(o2slotInp.value),  o2type: Number(o2typeInp.value),
        });
      });
    } else if (packetName === 'PARTYJOINREQUEST') {
      const partyIdInput = document.createElement('input');
      partyIdInput.type = 'number';
      partyIdInput.className = 'lab-send-input';
      partyIdInput.min = '0';
      partyIdInput.max = '4294967295';
      partyIdInput.placeholder = 'partyId';
      partyIdInput.value = '';
      const unknownByteInput = document.createElement('input');
      unknownByteInput.type = 'number';
      unknownByteInput.className = 'lab-send-input';
      unknownByteInput.min = '0';
      unknownByteInput.max = '255';
      unknownByteInput.placeholder = 'trailing byte';
      unknownByteInput.value = '1';
      function partyJoinPayload() {
        return {
          partyId: Number(partyIdInput.value),
          unknownByte: Number(unknownByteInput.value),
        };
      }
      sendBtn.addEventListener('click', function () {
        if (!partyIdInput.value.trim()) {
          setStatus({ ok: false, message: 'Enter partyId (from PARTYLISTMESSAGE).' });
          return;
        }
        sendNow(partyJoinPayload());
      });
      row.appendChild(partyIdInput);
      row.appendChild(unknownByteInput);
    } else {
      sendBtn.addEventListener('click', function () {
        sendNow({});
      });
    }

    row.appendChild(sendBtn);
    sec.appendChild(row);
    return sec;
  }

  function renderLabStructureView(packet, detailEl) {
    if (!detailEl || !packet) return;
    detailEl.innerHTML = '';
    const table = document.createElement('table');
    table.className = 'lab-structure-table';
    const thead = document.createElement('thead');
    thead.innerHTML = '<tr><th>Section</th><th>Type</th><th>Size</th></tr>';
    table.appendChild(thead);
    const tbody = document.createElement('tbody');
    const headerRow = document.createElement('tr');
    headerRow.innerHTML = '<td>Header</td><td>length (4B BE) + packet id (1B)</td><td class="lab-structure-size">5 bytes</td>';
    tbody.appendChild(headerRow);
    for (const f of packet.fields || []) {
      const tr = document.createElement('tr');
      const size = getFieldByteSize(f);
      const sizeStr = size !== null ? size + ' bytes' : 'variable';
      const typeName = f.type || '—';
      tr.innerHTML = '<td>' + escapeHtml(f.name || '—') + '</td><td>' + escapeHtml(typeName) + '</td><td class="lab-structure-size">' + escapeHtml(sizeStr) + '</td>';
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    const wrap = document.createElement('div');
    wrap.className = 'lab-structure-section';
    const title = document.createElement('div');
    title.className = 'lab-structure-title';
    const idLabel = Number.isInteger(packet.id) ? (' (ID ' + packet.id + ')') : '';
    title.textContent = packet.name + idLabel + ' - ' + (packet.direction || '') + ' - structure';
    wrap.appendChild(title);
    wrap.appendChild(table);
    const sendSection = buildLabPacketSender(packet);
    if (sendSection) wrap.appendChild(sendSection);
    detailEl.appendChild(wrap);
  }

  function renderLabDefinedList(which) {
    const listEl = document.getElementById('lab-defined-list-' + (which === 'working' ? 'working' : 'need-work'));
    const detailEl = document.getElementById('lab-defined-detail-' + (which === 'working' ? 'working' : 'need-work'));
    if (!listEl) return;
    const status = which === 'working' ? 'working' : 'needsWork';
    if (!labDefinitions || !labDefinitions.packets) {
      listEl.innerHTML = '<div class="lab-empty">Loading...</div>';
      return;
    }
    let filtered = labDefinitions.packets.filter(function (p) { return p.status === status; });
    if (labDefinedFilter === 'incoming') filtered = filtered.filter(function (p) { return p.direction === 'server'; });
    else if (labDefinedFilter === 'outgoing') filtered = filtered.filter(function (p) { return p.direction === 'client'; });
    const searchQ = getLabPacketSearchQuery();
    if (searchQ) filtered = filtered.filter(function (p) { return labDefinedPacketMatchesSearch(p, searchQ); });
    filtered.sort(function (a, b) {
      const dirOrder = (a.direction === 'server' ? 0 : 1) - (b.direction === 'server' ? 0 : 1);
      if (dirOrder !== 0) return dirOrder;
      return (a.name || '').localeCompare(b.name || '');
    });
    if (!filtered.length) {
      listEl.innerHTML = '<div class="lab-empty">' + (searchQ ? 'No packets match search.' : 'No packets in this list.') + '</div>';
      return;
    }
    listEl.innerHTML = '';
    filtered.forEach(function (p) {
      const row = document.createElement('div');
      const packetKey = p.key || (Number.isInteger(p.id) ? ('id:' + p.id) : ('name:' + (p.direction || '') + ':' + (p.name || '')));
      row.className = 'lab-type-row' + (labSelectedDefinedPacket && (labSelectedDefinedPacket.key || '') === packetKey && labSubtab === which ? ' active' : '');
      row.dataset.key = packetKey;

      const idBadge = document.createElement('span');
      idBadge.className = 'lab-type-id' + (Number.isInteger(p.id) ? '' : ' no-id');
      idBadge.textContent = Number.isInteger(p.id) ? String(p.id) : '';

      const nameEl = document.createElement('span');
      nameEl.className = 'lab-type-name';
      nameEl.textContent = p.name || ('ID ' + p.id);

      row.appendChild(idBadge);
      row.appendChild(nameEl);
      row.addEventListener('click', function () {
        p.key = packetKey;
        labSelectedDefinedPacket = p;
        document.querySelectorAll('#lab-defined-list-working .lab-type-row, #lab-defined-list-need-work .lab-type-row').forEach(function (r) { r.classList.remove('active'); });
        row.classList.add('active');
        renderLabStructureView(p, detailEl);
      });
      listEl.appendChild(row);
    });
  }

  function parseLabHexInput(input) {
    const clean = (input || '').replace(/0x/gi, '').replace(/[^0-9a-f]/gi, '');
    if (!clean.length) return [];
    if (clean.length % 2 !== 0) throw new Error('Hex input must contain an even number of characters.');
    const out = [];
    for (let i = 0; i < clean.length; i += 2) {
      out.push(parseInt(clean.slice(i, i + 2), 16));
    }
    return out;
  }

  function getLabByteSelectionRange() {
    if (labByteSelStart === null || labByteSelEnd === null) return null;
    return {
      start: Math.min(labByteSelStart, labByteSelEnd),
      end: Math.max(labByteSelStart, labByteSelEnd),
    };
  }

  function getSelectedLabBytes() {
    const range = getLabByteSelectionRange();
    if (!range) return [];
    return labBytePacket.slice(range.start, range.end + 1);
  }

  function clearLabByteSelection() {
    labByteSelStart = null;
    labByteSelEnd = null;
    updateLabByteSelectionUi();
    renderLabByteResults();
  }

  function setLabByteSelection(start, end) {
    labByteSelStart = start;
    labByteSelEnd = end;
    updateLabByteSelectionUi();
    renderLabByteResults();
  }

  function updateLabByteSelectionUi() {
    const range = getLabByteSelectionRange();
    document.querySelectorAll('.lab-byte-chip').forEach(function (chip) {
      const idx = Number(chip.dataset.idx);
      const selected = !!range && idx >= range.start && idx <= range.end;
      chip.classList.toggle('selected', selected);
    });
    if (labByteCount) {
      labByteCount.textContent = 'Total bytes: ' + labBytePacket.length;
    }
    if (labByteSelection) {
      if (!range) {
        labByteSelection.textContent = 'Selection: none';
      } else {
        const count = range.end - range.start + 1;
        labByteSelection.textContent = 'Selection: [' + range.start + '..' + range.end + '] (' + count + ' bytes)';
      }
    }
  }

  function formatLabByteHex(bytes) {
    return bytes.map(function (b) { return b.toString(16).padStart(2, '0').toUpperCase(); }).join(' ');
  }

  function decodeLabString(bytes) {
    if (bytes.length < 2) return 'N/A (need at least 2 bytes for int16 length prefix)';
    const view = new DataView((new Uint8Array(bytes)).buffer);
    const len = view.getInt16(0, false);
    if (len < 0) return 'N/A (negative length prefix: ' + len + ')';
    if (bytes.length < 2 + len) return 'N/A (length prefix=' + len + ', available=' + (bytes.length - 2) + ')';
    try {
      const data = new Uint8Array(bytes.slice(2, 2 + len));
      const str = new TextDecoder('utf-8').decode(data);
      return JSON.stringify(str);
    } catch (e) {
      return 'Error: ' + (e && e.message ? e.message : String(e));
    }
  }

  function renderLabByteResults(errorMsg) {
    if (!labByteResults) return;
    if (errorMsg) {
      labByteResults.innerHTML = '<div class="lab-empty">' + escapeHtml(errorMsg) + '</div>';
      return;
    }

    const selected = getSelectedLabBytes();
    if (!selected.length) {
      labByteResults.innerHTML = '<div class="lab-empty">Select a contiguous byte range to decode.</div>';
      return;
    }

    const view = new DataView((new Uint8Array(selected)).buffer);
    const has = function (n) { return selected.length >= n; };
    const stringValue = decodeLabString(selected);
    const rows = [
      { method: 'Selected hex', value: formatLabByteHex(selected), ok: true },
      { method: 'readByte', value: has(1) ? (view.getUint8(0) + ' (0x' + view.getUint8(0).toString(16).toUpperCase().padStart(2, '0') + ')') : 'N/A (need 1 byte)', ok: has(1) },
      { method: 'readBool', value: has(1) ? (view.getUint8(0) !== 0 ? 'true' : 'false') : 'N/A (need 1 byte)', ok: has(1) },
      { method: 'readShort', value: has(2) ? String(view.getInt16(0, false)) : 'N/A (need 2 bytes)', ok: has(2) },
      { method: 'readInt32', value: has(4) ? String(view.getInt32(0, false)) : 'N/A (need 4 bytes)', ok: has(4) },
      { method: 'readFloat', value: has(4) ? String(view.getFloat32(0, false)) : 'N/A (need 4 bytes)', ok: has(4) },
      { method: 'readDouble', value: has(8) ? String(view.getFloat64(0, false)) : 'N/A (need 8 bytes)', ok: has(8) },
      { method: 'string', value: stringValue, ok: !stringValue.startsWith('N/A') && !stringValue.startsWith('Error:') },
    ];

    const table = document.createElement('table');
    table.className = 'lab-byte-results-table';
    const tbody = document.createElement('tbody');
    for (const row of rows) {
      const tr = document.createElement('tr');
      const th = document.createElement('th');
      th.textContent = row.method;
      const td = document.createElement('td');
      td.className = row.ok ? 'lab-byte-result-ok' : 'lab-byte-result-na';
      td.textContent = row.value;
      tr.appendChild(th);
      tr.appendChild(td);
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    labByteResults.innerHTML = '';
    labByteResults.appendChild(table);
  }

  function renderLabByteGrid() {
    if (!labByteGrid) return;
    if (!labBytePacket.length) {
      labByteGrid.innerHTML = '<div class="lab-empty">Paste bytes above and press Enter or click Load.</div>';
      updateLabByteSelectionUi();
      renderLabByteResults();
      return;
    }

    labByteGrid.innerHTML = '';
    labBytePacket.forEach(function (b, idx) {
      const chip = document.createElement('div');
      const asciiChar = (b >= 32 && b <= 126) ? String.fromCharCode(b) : '.';
      chip.className = 'lab-byte-chip';
      chip.dataset.idx = String(idx);
      chip.innerHTML = '<span class="lab-byte-idx">' + idx + '</span><span class="lab-byte-val">' + b.toString(16).toUpperCase().padStart(2, '0') + '</span><span class="lab-byte-ascii">' + escapeHtml(asciiChar) + '</span>';
      chip.addEventListener('mousedown', function (e) {
        if (e.button !== 0) return;
        e.preventDefault();
        labByteDragging = true;
        setLabByteSelection(idx, idx);
      });
      chip.addEventListener('mouseenter', function () {
        if (!labByteDragging || labByteSelStart === null) return;
        setLabByteSelection(labByteSelStart, idx);
      });
      labByteGrid.appendChild(chip);
    });
    updateLabByteSelectionUi();
    renderLabByteResults();
  }

  function loadLabBytePacketFromInput() {
    if (!labByteInput) return;
    try {
      labBytePacket = parseLabHexInput(labByteInput.value.trim());
      labByteSelStart = null;
      labByteSelEnd = null;
      renderLabByteGrid();
    } catch (e) {
      labBytePacket = [];
      labByteSelStart = null;
      labByteSelEnd = null;
      renderLabByteGrid();
      renderLabByteResults(e && e.message ? e.message : String(e));
    }
  }

  document.querySelectorAll('.lab-subtab').forEach(function (btn) {
    btn.addEventListener('click', function () {
      const sub = btn.getAttribute('data-lab-subtab');
      if (!sub) return;
      if (sub === 'need-work' || sub === 'unknowns' || sub === 'byte-tool') labSubtab = sub;
      else labSubtab = 'working';
      document.querySelectorAll('.lab-subtab').forEach(function (b) { b.classList.remove('active'); });
      btn.classList.add('active');
      document.querySelectorAll('.lab-panel').forEach(function (panel) {
        const id = panel.id;
        if (id === 'lab-panel-working') panel.classList.toggle('hidden', labSubtab !== 'working');
        else if (id === 'lab-panel-need-work') panel.classList.toggle('hidden', labSubtab !== 'need-work');
        else if (id === 'lab-panel-unknowns') panel.classList.toggle('hidden', labSubtab !== 'unknowns');
        else if (id === 'lab-panel-byte-tool') panel.classList.toggle('hidden', labSubtab !== 'byte-tool');
      });
      syncLabPacketToolbarVisibility();
      if (labSubtab === 'unknowns') renderLabTypeList();
      else if (labSubtab === 'byte-tool') renderLabByteGrid();
      else { renderLabDefinedList('working'); renderLabDefinedList('need-work'); }
    });
  });

  const labDefinedDirectionEl = document.getElementById('lab-defined-direction');
  if (labDefinedDirectionEl) {
    labDefinedDirectionEl.value = labDefinedFilter;
    labDefinedDirectionEl.addEventListener('change', function () {
      labDefinedFilter = this.value;
      renderLabDefinedList('working');
      renderLabDefinedList('need-work');
    });
  }

  const labPacketSearchEl = document.getElementById('lab-packet-search');
  if (labPacketSearchEl) {
    labPacketSearchEl.addEventListener('input', function () {
      if (activeTab !== 'packet-lab') return;
      if (labSubtab === 'working' || labSubtab === 'need-work') {
        renderLabDefinedList('working');
        renderLabDefinedList('need-work');
      } else if (labSubtab === 'unknowns') {
        renderLabTypeList();
      }
    });
  }

  function handleLabUpdate(unknowns) {
    labUnknowns = unknowns || [];
    // Update badge on tab button
    if (labUnknowns.length > 0) {
      labTabBadge.textContent = labUnknowns.length;
      labTabBadge.classList.remove('hidden');
    } else {
      labTabBadge.classList.add('hidden');
    }
    if (activeTab === 'packet-lab' && labSubtab === 'unknowns') renderLabTypeList();
  }

  function renderLabTypeList() {
    const searchQ = getLabPacketSearchQuery();
    if (!labUnknowns.length) {
      labTypeList.innerHTML = '<div class="lab-empty">No unknown packets captured yet.</div>';
      return;
    }
    const list = searchQ ? labUnknowns.filter(function (u) { return labUnknownMatchesSearch(u, searchQ); }) : labUnknowns;
    if (!list.length) {
      labTypeList.innerHTML = '<div class="lab-empty">' + (searchQ ? 'No unknown packets match search.' : 'No unknown packets captured yet.') + '</div>';
      return;
    }
    labTypeList.innerHTML = '';
    for (const u of list) {
      const row = document.createElement('div');
      row.className = 'lab-type-row' + (u.id === labSelectedId ? ' active' : '');
      row.dataset.id = u.id;

      const idBadge = document.createElement('span');
      idBadge.className = 'lab-type-id';
      idBadge.textContent = u.id;

      const nameEl = document.createElement('span');
      nameEl.className = 'lab-type-name';
      nameEl.textContent = u.hardCodedName || ('ID ' + u.id);

      const countEl = document.createElement('span');
      countEl.className = 'lab-type-count';
      countEl.textContent = u.count + 'x';

      row.appendChild(idBadge);
      row.appendChild(nameEl);
      row.appendChild(countEl);
      row.addEventListener('click', () => {
        labSelectedId = u.id;
        labIdInput.value = u.id;
        document.querySelectorAll('.lab-type-row').forEach(r => r.classList.remove('active'));
        row.classList.add('active');
        fetchAndRenderAnalysis(u.id);
      });
      labTypeList.appendChild(row);
    }
  }

  function fetchAndRenderAnalysis(id) {
    labDetail.innerHTML = '<div class="lab-empty">Loading...</div>';
    fetch('/api/lab/analyze/' + id)
      .then(r => r.json())
      .then(result => renderAnalysis(id, result))
      .catch(e => { labDetail.innerHTML = '<div class="lab-empty">Error: ' + escapeHtml(String(e)) + '</div>'; });
  }

  function renderAnalysis(id, r) {
    labDetail.innerHTML = '';

    // ── Byte diff ──
    if (r.byteDiff && r.byteDiff.length) {
      const sec = makeLabSection('Byte Diff (' + r.byteDiff.length + ' bytes)');
      const body = sec.querySelector('.lab-section-body');
      const pre = document.createElement('div');
      pre.className = 'lab-byte-diff';
      for (const d of r.byteDiff) {
        const span = document.createElement('span');
        if (d.isConst) {
          span.className = 'bd-const';
          span.textContent = d.value.toString(16).padStart(2,'0').toUpperCase() + ' ';
        } else {
          span.className = 'bd-var';
          span.textContent = '?? ';
          span.title = d.distinct + ' values, ' + d.min.toString(16) + '-' + d.max.toString(16);
        }
        pre.appendChild(span);
      }
      body.appendChild(pre);
      labDetail.appendChild(sec);
    }

    // ── Strings ──
    if (r.strings && r.strings.length) {
      const sec = makeLabSection('Strings Found');
      const body = sec.querySelector('.lab-section-body');
      for (const s of r.strings) {
        const row = document.createElement('div');
        row.className = 'lab-string-row';
        row.innerHTML = '<span class="lab-string-offset">@' + s.offset + '</span>' + escapeHtml(JSON.stringify(s.value));
        body.appendChild(row);
      }
      labDetail.appendChild(sec);
    }

    // ── CompressedInt streams ──
    if (r.compressedInts && r.compressedInts.length) {
      const sec = makeLabSection('CompressedInt Streams (first 3)');
      const body = sec.querySelector('.lab-section-body');
      for (const vals of r.compressedInts) {
        const row = document.createElement('div');
        row.className = 'lab-ci-row';
        row.textContent = vals === null ? '(parse failed)' : '[' + vals.join(', ') + ']';
        body.appendChild(row);
      }
      labDetail.appendChild(sec);
    }

    // ── Hex dumps ──
    if (r.hexSamples && r.hexSamples.length) {
      const sec = makeLabSection('Hex Dumps (up to 5)');
      const body = sec.querySelector('.lab-section-body');
      for (let i = 0; i < r.hexSamples.length; i++) {
        const title = document.createElement('div');
        title.style.cssText = 'color:var(--text-muted);font-size:10px;margin-bottom:4px;';
        title.textContent = '[' + i + '] ' + (r.hexSamples[i].length / 2) + ' bytes';
        body.appendChild(title);
        const pre = document.createElement('pre');
        pre.className = 'lab-hex';
        pre.textContent = formatHexDump(r.hexSamples[i]);
        body.appendChild(pre);
      }
      labDetail.appendChild(sec);
    }

    if (!labDetail.children.length) {
      labDetail.innerHTML = '<div class="lab-empty">No analysis data available.</div>';
    }
  }

  function formatHexDump(hexStr) {
    const bytes = [];
    for (let i = 0; i < hexStr.length; i += 2) {
      bytes.push(parseInt(hexStr.slice(i, i+2), 16));
    }
    const lines = [];
    for (let i = 0; i < bytes.length; i += 16) {
      const chunk = bytes.slice(i, i + 16);
      const offset = i.toString(16).padStart(4, '0');
      const hex = chunk.map(b => b.toString(16).padStart(2,'0')).join(' ').padEnd(47, ' ');
      const ascii = chunk.map(b => (b >= 32 && b < 127) ? String.fromCharCode(b) : '.').join('');
      lines.push(offset + '  ' + hex + '  ' + ascii);
    }
    return lines.join('\n');
  }

  function makeLabSection(title) {
    const sec = document.createElement('div');
    sec.className = 'lab-section';
    const hdr = document.createElement('div');
    hdr.className = 'lab-section-title';
    hdr.textContent = title;
    const body = document.createElement('div');
    body.className = 'lab-section-body';
    sec.appendChild(hdr);
    sec.appendChild(body);
    return sec;
  }

  labProbeBtn.addEventListener('click', () => {
    const id = labIdInput.value.trim();
    const spec = labSpecInput.value.trim();
    if (!id || !spec) return;
    labProbeBtn.textContent = 'Probing...';
    labProbeBtn.disabled = true;
    ws.send(JSON.stringify({ type: 'probePacket', id: isNaN(Number(id)) ? id : Number(id), spec }));
  });

  if (labByteInput) {
    labByteInput.addEventListener('keydown', function (e) {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      loadLabBytePacketFromInput();
    });
  }

  if (labByteLoadBtn) {
    labByteLoadBtn.addEventListener('click', function () {
      loadLabBytePacketFromInput();
    });
  }

  if (labByteClearBtn) {
    labByteClearBtn.addEventListener('click', function () {
      clearLabByteSelection();
    });
  }

  if (labByteGrid) {
    labByteGrid.addEventListener('contextmenu', function (e) {
      e.preventDefault();
      clearLabByteSelection();
    });
  }

  document.addEventListener('mouseup', function () {
    labByteDragging = false;
  });

  let pendingProbeSection = null;

  function handleProbeResult(result) {
    labProbeBtn.textContent = 'Probe';
    labProbeBtn.disabled = false;

    // Remove old probe section if present
    if (pendingProbeSection && pendingProbeSection.parentNode) {
      pendingProbeSection.parentNode.removeChild(pendingProbeSection);
    }

    const sec = makeLabSection('Probe Results');
    pendingProbeSection = sec;
    const body = sec.querySelector('.lab-section-body');

    // Badge row
    const total = result.samplesTotal;
    const badges = document.createElement('div');
    badges.className = 'lab-probe-results';
    badges.innerHTML =
      '<span class="lab-probe-badge pass">PASS ' + result.pass + '/' + total + '</span>' +
      '<span class="lab-probe-badge warn">WARN ' + result.warn + '/' + total + '</span>' +
      '<span class="lab-probe-badge error">ERR ' + result.error + '/' + total + '</span>';
    if (result.trueCount > result.samplesTotal) {
      const note = document.createElement('span');
      note.style.cssText = 'color:var(--text-muted);font-size:10px;align-self:center;';
      note.textContent = '(stored ' + total + ' of ' + result.trueCount + ' total)';
      badges.appendChild(note);
    }
    body.appendChild(badges);

    // Pass examples
    if (result.passExamples && result.passExamples.length) {
      const hdr = document.createElement('div');
      hdr.style.cssText = 'color:var(--text-muted);font-size:10px;margin:6px 0 2px;';
      hdr.textContent = 'PASS examples:';
      body.appendChild(hdr);
      for (const ex of result.passExamples) {
        const row = document.createElement('div');
        row.className = 'lab-probe-example';
        row.innerHTML = '<span class="pex-vals">' + escapeHtml(ex.fields.join('  |  ')) + '</span>';
        body.appendChild(row);
      }
    }

    // Warn examples
    if (result.warnExamples && result.warnExamples.length) {
      const hdr = document.createElement('div');
      hdr.style.cssText = 'color:var(--text-muted);font-size:10px;margin:6px 0 2px;';
      hdr.textContent = 'WARN (leftover bytes):';
      body.appendChild(hdr);
      for (const ex of result.warnExamples) {
        const row = document.createElement('div');
        row.className = 'lab-probe-example';
        row.innerHTML = '<span class="pex-warn">+' + ex.leftover + 'B</span>  ' +
          '<span class="pex-vals">' + escapeHtml((ex.fields||[]).join('  |  ')) + '</span>';
        body.appendChild(row);
      }
    }

    // Error examples
    if (result.errorExamples && result.errorExamples.length) {
      const hdr = document.createElement('div');
      hdr.style.cssText = 'color:var(--text-muted);font-size:10px;margin:6px 0 2px;';
      hdr.textContent = 'Errors:';
      body.appendChild(hdr);
      for (const ex of result.errorExamples) {
        const row = document.createElement('div');
        row.className = 'lab-probe-example';
        row.innerHTML = '<span class="pex-error">' + escapeHtml(ex.error) + '</span>';
        body.appendChild(row);
      }
    }

    // Insert at top of detail panel (or replace empty state)
    if (labDetail.innerHTML.includes('lab-empty') && labDetail.children.length === 1) {
      labDetail.innerHTML = '';
    }
    labDetail.insertBefore(sec, labDetail.firstChild);
  }

  function formatLabValue(v) {
    if (v === null || v === undefined) return 'null';
    if (typeof v === 'number') return String(v);
    if (typeof v === 'boolean') return String(v);
    if (typeof v === 'string') return JSON.stringify(v);
    if (Array.isArray(v)) {
      const items = v.slice(0, 8).map(formatLabValue);
      const suffix = v.length > 8 ? ', +' + (v.length - 8) + ' more' : '';
      return '[' + items.join(', ') + suffix + ']';
    }
    return String(v);
  }

  // ─── RotMG path settings ──────────────────────────────

  saveRotmgPathBtn.addEventListener('click', () => {
    const path = rotmgPathInput.value.trim();
    ws.send(JSON.stringify({ type: 'updateRotmgPath', path }));
  });

  resetRotmgPathBtn.addEventListener('click', () => {
    rotmgPathInput.value = '';
    ws.send(JSON.stringify({ type: 'updateRotmgPath', path: '' }));
  });



  if (pluginConfigRefreshBtn) {
    pluginConfigRefreshBtn.addEventListener('click', function () {
      loadPluginConfigs();
    });
  }
  if (pluginConfigSaveBtn) {
    pluginConfigSaveBtn.addEventListener('click', function () {
      savePluginConfig();
    });
  }
  if (pluginConfigLoadBtn) {
    pluginConfigLoadBtn.addEventListener('click', function () {
      loadSelectedPluginConfig();
    });
  }
  if (pluginConfigSelect) {
    pluginConfigSelect.addEventListener('change', function () {
      localStorage.setItem('pluginConfigSelected', String(pluginConfigSelect.value || ''));
    });
  }

  if (accountsSearchInput) {
    accountsSearchInput.addEventListener('input', function () {
      renderAccountsList();
    });
  }
  if (accountsSortEl) {
    accountsSortEl.value = String(accountsSortMode || 'newest');
    accountsSortEl.addEventListener('change', function () {
      var nextMode = String(accountsSortEl.value || 'newest');
      if (['newest', 'oldest', 'alphabetical', 'fame'].indexOf(nextMode) < 0) nextMode = 'newest';
      accountsSortMode = nextMode;
      localStorage.setItem('accountsSortMode', accountsSortMode);
      renderAccountsList();
    });
  }
  if (homeAccountsSortEl) {
    homeAccountsSortEl.value = String(homeAccountsSortMode || 'newest');
    homeAccountsSortEl.addEventListener('change', function () {
      var nextMode = String(homeAccountsSortEl.value || 'newest');
      if (['newest', 'oldest', 'alphabetical', 'fame'].indexOf(nextMode) < 0) nextMode = 'newest';
      homeAccountsSortMode = nextMode;
      localStorage.setItem('homeAccountsSortMode', homeAccountsSortMode);
      renderHomeAccounts();
    });
  }
  if (accountsNewBtn) {
    accountsNewBtn.addEventListener('click', function () {
      createDashboardAccount(false);
    });
  }
  if (accountsSaveBtn) {
    accountsSaveBtn.addEventListener('click', function () {
      saveDashboardAccounts();
    });
  }
  // --- Context menu, delete confirmation, locked modal, setup flow ---
  if (accountsCtxBtn) {
    accountsCtxBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      if (accountsCtxMenu) accountsCtxMenu.style.display = accountsCtxMenu.style.display === 'none' ? '' : 'none';
    });
  }
  document.addEventListener('click', function () {
    if (accountsCtxMenu) accountsCtxMenu.style.display = 'none';
  });
  if (accountsCtxMenu) {
    accountsCtxMenu.addEventListener('click', function (e) {
      var item = e.target.closest('[data-action]');
      if (!item) return;
      accountsCtxMenu.style.display = 'none';
      var action = item.getAttribute('data-action');
      if (action === 'delete') {
        showDeleteAccountModal();
      } else if (action === 'reorder') {
        accountsReorderMode = !accountsReorderMode;
        renderAccountsList();
      } else if (action === 'refresh-all') {
        refreshAllDashboardAccountOverviews();
      } else if (action === 'refresh-hwid') {
        refreshHwid();
      }
    });
  }
  if (accountsDeleteConfirmBtn) {
    accountsDeleteConfirmBtn.addEventListener('click', function () {
      confirmDeleteSelectedAccount();
    });
  }
  if (accountsDeleteCancelBtn) {
    accountsDeleteCancelBtn.addEventListener('click', function () {
      if (accountsDeleteModal) accountsDeleteModal.style.display = 'none';
    });
  }
  if (accountsDeleteModal) {
    var deleteBackdrop = accountsDeleteModal.querySelector('.accounts-modal-backdrop');
    if (deleteBackdrop) deleteBackdrop.addEventListener('click', function () {
      accountsDeleteModal.style.display = 'none';
    });
  }
  if (accountsLockedOkBtn) {
    accountsLockedOkBtn.addEventListener('click', function () {
      if (accountsLockedModal) accountsLockedModal.style.display = 'none';
    });
  }
  if (accountsLockedModal) {
    var lockedBackdrop = accountsLockedModal.querySelector('.accounts-modal-backdrop');
    if (lockedBackdrop) lockedBackdrop.addEventListener('click', function () {
      accountsLockedModal.style.display = 'none';
    });
  }

  // Setup flow — two-step wizard
  //   Step 1: pick method (email / steam / import)
  //   Step 2: variant-specific form
  (function () {
    var setupStep1     = document.getElementById('accounts-setup-step1');
    var setupStep2     = document.getElementById('accounts-setup-step2');
    var setupBackBtn   = document.getElementById('accounts-setup-back-btn');
    var setupMethodLbl = document.getElementById('accounts-setup-method-label');
    var setupAddBtn    = document.getElementById('accounts-setup-add-btn');

    var setupMethod = null;  // 'email' | 'steam' | 'import'

    function showStep1() {
      setupMethod = null;
      if (setupStep1) setupStep1.style.display = '';
      if (setupStep2) setupStep2.style.display = 'none';
      document.querySelectorAll('.accounts-setup-variant').forEach(function (el) {
        el.style.display = 'none';
      });
    }
    function showStep2(method) {
      setupMethod = method;
      if (setupStep1) setupStep1.style.display = 'none';
      if (setupStep2) setupStep2.style.display = '';
      var labelMap = { email: 'Email & Password', steam: 'Steam Account', import: 'Import existing' };
      if (setupMethodLbl) setupMethodLbl.textContent = labelMap[method] || method;
      document.querySelectorAll('.accounts-setup-variant').forEach(function (el) {
        el.style.display = (el.getAttribute('data-variant') === method) ? '' : 'none';
      });
      // Add Account is irrelevant in the import flow — its buttons save inline.
      if (setupAddBtn) setupAddBtn.style.display = (method === 'import') ? 'none' : '';
    }
    document.querySelectorAll('.setup-method-card').forEach(function (card) {
      card.addEventListener('click', function () {
        var m = card.getAttribute('data-method');
        if (m) showStep2(m);
      });
    });
    if (setupBackBtn) setupBackBtn.addEventListener('click', showStep1);

    // Helpers: read inputs from whichever variant is visible.
    function activeVariantEl() {
      if (!setupMethod) return null;
      return document.querySelector('.accounts-setup-variant[data-variant="' + setupMethod + '"]');
    }
    function activeInput(sel) {
      var v = activeVariantEl();
      return v ? v.querySelector(sel) : null;
    }

    // Password Show/Hide — one button per variant, all marked .accounts-setup-password-vis
    document.querySelectorAll('.accounts-setup-password-vis').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var inp = btn.parentElement && btn.parentElement.querySelector('.accounts-setup-password-input');
        if (!inp) return;
        var nowVisible = inp.type !== 'text';
        inp.type = nowVisible ? 'text' : 'password';
        btn.textContent = nowVisible ? 'Hide' : 'Show';
      });
    });

    // Populate every server select in the setup card (one per variant).
    function populateSetupServers() {
      var names = Array.isArray(availableServerNames) && availableServerNames.length ? availableServerNames.slice() : ['USWest'];
      document.querySelectorAll('.accounts-setup-server-select').forEach(function (sel) {
        sel.innerHTML = '';
        names.forEach(function (name) {
          var opt = document.createElement('option');
          opt.value = String(name);
          opt.textContent = String(name);
          sel.appendChild(opt);
        });
      });
    }
    populateSetupServers();
    window._populateSetupServers = populateSetupServers;

    // ── Steam: Connect button (Steam variant only) ─────────────────────────
    var setupSteamIdInput       = document.getElementById('accounts-setup-steam-id');
    var setupSteamConnectBtn    = document.getElementById('accounts-setup-steam-connect-btn');
    var setupSteamConnectStatus = document.getElementById('accounts-setup-steam-connect-status');
    function setSteamConnectStatusS(text, isError) {
      if (!setupSteamConnectStatus) return;
      if (!text) { setupSteamConnectStatus.style.display = 'none'; return; }
      setupSteamConnectStatus.textContent = text;
      setupSteamConnectStatus.style.color = isError ? 'var(--danger, #ef4444)' : 'var(--text-dim)';
      setupSteamConnectStatus.style.display = '';
    }
    if (setupSteamConnectBtn) {
      setupSteamConnectBtn.addEventListener('click', async function () {
        var bridge = window.electronAPI && window.electronAPI.steam;
        if (!bridge || typeof bridge.connect !== 'function') {
          setSteamConnectStatusS('Steam connect is only available in the Electron app build.', true);
          return;
        }
        setupSteamConnectBtn.disabled = true;
        setSteamConnectStatusS('Opening Steam sign-in window…');
        try {
          var result = await bridge.connect();
          if (!result || result.cancelled)        setSteamConnectStatusS('Steam sign-in cancelled.');
          else if (result.error)                  setSteamConnectStatusS(result.error, true);
          else if (result.steamId) {
            if (setupSteamIdInput) setupSteamIdInput.value = result.steamId;
            setSteamConnectStatusS('Connected as Steam ID ' + result.steamId + '. Now fill GUID and Secret below.');
          } else setSteamConnectStatusS('Steam returned an unexpected response.', true);
        } catch (err) {
          setSteamConnectStatusS('Steam connect failed: ' + ((err && err.message) || String(err)), true);
        } finally {
          setupSteamConnectBtn.disabled = false;
        }
      });
    }

    // ── Import buttons (shared logic, wired to both Steam and Import variants) ─
    function setImportStatusIn(statusId, text, isError) {
      var el = document.getElementById(statusId);
      if (!el) return;
      if (!text) { el.style.display = 'none'; return; }
      el.textContent = text;
      el.style.color = isError ? 'var(--danger, #ef4444)' : 'var(--text-dim)';
      el.style.display = '';
    }

    // 'Import from Launcher' — pre-fills the form (Steam variant) OR creates one
    // account directly (Import variant where there's no form to fill).
    function wireImportLauncher(btnId, statusId, fillForm) {
      var btn = document.getElementById(btnId);
      if (!btn) return;
      btn.addEventListener('click', async function () {
        var bridge = window.electronAPI && window.electronAPI.rotmg;
        if (!bridge || typeof bridge.readLauncherCreds !== 'function') {
          setImportStatusIn(statusId, 'Launcher import only works in the Electron app build.', true);
          return;
        }
        btn.disabled = true;
        setImportStatusIn(statusId, 'Reading RotMG Exalt Launcher credentials…');
        try {
          var result = await bridge.readLauncherCreds();
          if (!result || result.error) {
            setImportStatusIn(statusId, result && result.error ? result.error : 'Could not read launcher credentials.', true);
            return;
          }
          if (fillForm) {
            var emailEl = activeInput('.accounts-setup-email-input');
            var passEl  = activeInput('.accounts-setup-password-input');
            if (result.guid && emailEl)   emailEl.value = result.guid;
            if (result.secret && passEl)  passEl.value  = result.secret;
            setImportStatusIn(statusId, 'Filled. Click "Add Account" to save.');
          } else {
            // Import-variant: create the account immediately, no form to fill.
            var next = createEmptyDashboardAccount();
            next.email = String(result.guid || '');
            next.password = String(result.secret || '');
            var at = next.email.indexOf('@');
            next.label = at > 0 ? next.email.slice(0, at) : next.email;
            dashboardAccounts.unshift(next);
            selectedAccountId = next.id;
            accountsDetailsCollapsed = false;
            applyAccountsDetailsVisibility();
            renderAccountsTab();
            maybeLoadSelectedDashboardAccountOverview();
            saveDashboardAccounts();
            setImportStatusIn(statusId, 'Imported 1 account. Saved.');
          }
        } catch (err) {
          setImportStatusIn(statusId, 'Import failed: ' + ((err && err.message) || String(err)), true);
        } finally {
          btn.disabled = false;
        }
      });
    }
    wireImportLauncher('accounts-setup-import-launcher-btn',   'accounts-setup-import-status',   true);
    wireImportLauncher('accounts-setup-import-launcher-btn-2', 'accounts-setup-import-status-2', false);

    // 'Import All Captured' — bulk-create accounts from the DLL's JSONL log.
    function wireImportCapture(btnId, statusId) {
      var btn = document.getElementById(btnId);
      if (!btn) return;
      btn.addEventListener('click', async function () {
        var bridge = window.electronAPI && window.electronAPI.rotmg;
        if (!bridge || typeof bridge.readCaptureLog !== 'function') {
          setImportStatusIn(statusId, 'Capture-log import only works in the Electron app build.', true);
          return;
        }
        btn.disabled = true;
        setImportStatusIn(statusId, 'Reading capture log…');
        try {
          var result = await bridge.readCaptureLog();
          if (!result || result.error) {
            setImportStatusIn(statusId, result && result.error ? result.error : 'Could not read capture log.', true);
            return;
          }
          var captured = Array.isArray(result.uniqueAccounts) ? result.uniqueAccounts : [];
          if (!captured.length) {
            setImportStatusIn(statusId, 'Capture log is empty. Log into accounts via the launcher (DLL injected) first.', true);
            return;
          }
          var added = 0, lastNewId = null;
          captured.forEach(function (rec) {
            var next = createEmptyDashboardAccount();
            next.email = String(rec.guid);
            next.password = String(rec.secret || '');
            next.isSteam = !!rec.isSteam;
            next.steamId = String(rec.steamId || '');
            var at = next.email.indexOf('@');
            next.label = at > 0 ? next.email.slice(0, at) : next.email;
            next.createdAt = next.updatedAt = Date.now();
            dashboardAccounts.unshift(next);
            lastNewId = next.id;
            added++;
          });
          if (lastNewId) selectedAccountId = lastNewId;
          accountsDetailsCollapsed = false;
          applyAccountsDetailsVisibility();
          renderAccountsTab();
          maybeLoadSelectedDashboardAccountOverview();
          saveDashboardAccounts();
          setImportStatusIn(statusId, 'Imported ' + added + ' account(s) from capture log. Saved.');
        } catch (err) {
          setImportStatusIn(statusId, 'Import failed: ' + ((err && err.message) || String(err)), true);
        } finally {
          btn.disabled = false;
        }
      });
    }
    wireImportCapture('accounts-setup-import-capture-btn',   'accounts-setup-import-status');
    wireImportCapture('accounts-setup-import-capture-btn-2', 'accounts-setup-import-status-2');

    // ── Add Account button (email + steam variants) ────────────────────────
    // EAM-style: Steam variant has no separate Steam ID input — the Guid is
    // expected as "steamworks:<17-digit Steam ID>" (or bare digits, which we
    // normalize). Auto-parsed to {email, steamId} on save.
    if (setupAddBtn) {
      setupAddBtn.addEventListener('click', function () {
        if (!setupMethod || setupMethod === 'import') return; // import variant uses its own buttons
        var aliasEl = activeInput('.accounts-setup-alias-input');
        var emailEl = activeInput('.accounts-setup-email-input');
        var passEl  = activeInput('.accounts-setup-password-input');
        var serverSel = activeInput('.accounts-setup-server-select');
        var rawGuid = String(emailEl && emailEl.value || '').trim();
        var password = String(passEl && passEl.value || '');
        var isSteam = setupMethod === 'steam';
        var email = rawGuid;
        var steamId = '';
        if (isSteam) {
          var m = rawGuid.match(/^steamworks:(\d{6,20})$/i);
          if (m) {
            email = 'steamworks:' + m[1];
            steamId = m[1];
          } else if (/^\d{6,20}$/.test(rawGuid)) {
            email = 'steamworks:' + rawGuid;
            steamId = rawGuid;
          } else {
            setAccountsStatus('Guid must be steamworks:<17-digit Steam ID>.', true);
            return;
          }
        }
        if (!email || !password) {
          setAccountsStatus(isSteam ? 'Guid and Secret are required.' : 'Email and password are required.', true);
          return;
        }
        var next = createEmptyDashboardAccount();
        next.label = String(aliasEl && aliasEl.value || '');
        next.email = email;
        next.password = password;
        next.isSteam = isSteam;
        next.steamId = steamId;
        next.serverName = String(serverSel && serverSel.value || 'USWest');
        dashboardAccounts.unshift(next);
        selectedAccountId = next.id;
        accountsDetailsCollapsed = false;
        applyAccountsDetailsVisibility();
        // Clear inputs for next time
        if (aliasEl) aliasEl.value = '';
        if (emailEl) emailEl.value = '';
        if (passEl)  passEl.value  = '';
        renderAccountsTab();
        maybeLoadSelectedDashboardAccountOverview();
        saveDashboardAccounts();
      });
    }

    // Start on step 1.
    showStep1();
  })();
  if (accountsFillBtn) {
    accountsFillBtn.addEventListener('click', function () {
      var account = getSelectedDashboardAccount();
      if (!account) return;
      openDashboardTab('accounts');
    });
  }
  if (accountsOverviewRefreshBtn) {
    accountsOverviewRefreshBtn.addEventListener('click', function () {
      loadSelectedDashboardAccountOverview(true);
    });
  }
  if (accountsOverviewRefreshAllBtn) {
    accountsOverviewRefreshAllBtn.addEventListener('click', function () {
      refreshAllDashboardAccountOverviews();
    });
  }
  if (accountsOverviewTabsEl) {
    accountsOverviewTabsEl.addEventListener('click', function (e) {
      var btn = e.target.closest('[data-accounts-overview-tab]');
      if (!btn) return;
      selectedAccountsOverviewTab = String(btn.getAttribute('data-accounts-overview-tab') || 'characters');
      renderAccountsOverview();
    });
  }
  if (accountsCharactersListEl) {
    accountsCharactersListEl.addEventListener('input', function (e) {
      var input = e.target.closest('[data-accounts-browser-search]');
      if (!input) return;
      var query = input.value.trim().toLowerCase();
      var cards = accountsCharactersListEl.querySelectorAll('.accounts-item-stack');
      cards.forEach(function (card) {
        var name = String(card.getAttribute('data-item-name') || '');
        card.style.display = (!query || name.includes(query)) ? '' : 'none';
      });
    });
  }
  if (accountsLaunchBtn) {
    accountsLaunchBtn.addEventListener('click', function () {
      var account = getSelectedDashboardAccount();
      if (!account) return;
      launchGameWithCredentials(
        String(account.email || '').trim(),
        String(account.password || ''),
        String(account.serverName || 'USWest').trim() || 'USWest',
        undefined,
        launchOptsWithAccount(account, {}),
      );
    });
  }
  // Editor tab switching (delegated)
  document.addEventListener('click', function(e) {
    var editorTab = e.target.closest('.accounts-editor-tab');
    if (editorTab && editorTab.hasAttribute('data-editor-tab')) {
      switchAccountsEditorTab(editorTab.getAttribute('data-editor-tab'));
    }
  });
  if (accountsPasswordVisibilityBtn && accountsPasswordInput) {
    accountsPasswordVisibilityBtn.addEventListener('click', function () {
      if (accountsPasswordInput.disabled) return;
      accountsPasswordVisible = !accountsPasswordVisible;
      accountsPasswordInput.type = accountsPasswordVisible ? 'text' : 'password';
      accountsPasswordVisibilityBtn.textContent = accountsPasswordVisible ? 'Hide' : 'Show';
    });
  }

  function updateSelectedDashboardAccountFromEditor() {
    if (suppressAccountsEditorEvents) return;
    var account = getSelectedDashboardAccount();
    if (!account) return;
    if (isSelectedAccountRunning()) {
      showLockedModal();
      renderAccountsEditor();
      return;
    }
    var prevEmail = String(account.email || '').trim();
    var prevPassword = String(account.password || '');
    var prevIsSteam = !!account.isSteam;
    var prevSteamId = String(account.steamId || '');
    account.label = String(accountsAliasInput && accountsAliasInput.value || '');
    account.isSteam = !!(accountsIsSteamInput && accountsIsSteamInput.checked);
    // EAM-style parse: if Steam mode + the Guid is "steamworks:<id>", derive
    // the Steam ID from it. If the user typed just digits, normalize by
    // prepending the prefix. The hidden accounts-steam-id input is kept in
    // sync purely for back-compat with code that reads the legacy field.
    var rawGuid = String(accountsEmailInput && accountsEmailInput.value || '').trim();
    if (account.isSteam) {
      var m = rawGuid.match(/^steamworks:(\d{6,20})$/i);
      if (m) {
        account.email = 'steamworks:' + m[1];
        account.steamId = m[1];
      } else if (/^\d{6,20}$/.test(rawGuid)) {
        // Bare digits → treat as Steam ID, normalize to steamworks:<id>
        account.email = 'steamworks:' + rawGuid;
        account.steamId = rawGuid;
      } else {
        // Anything else: leave as-is; verify/save will catch the bad format.
        account.email = rawGuid;
        account.steamId = '';
      }
      if (accountsSteamIdInput) accountsSteamIdInput.value = account.steamId;
    } else {
      account.email = rawGuid;
      account.steamId = '';
      if (accountsSteamIdInput) accountsSteamIdInput.value = '';
    }
    account.password = String(accountsPasswordInput && accountsPasswordInput.value || '');
    account.serverName = String(accountsServerSelect && accountsServerSelect.value || account.serverName || 'USWest').trim() || 'USWest';
    account.notes = String(accountsNotesInput && accountsNotesInput.value || '');
    account.mulingItemsToMuleOff = String(accountsMulingItemsMuleOff && accountsMulingItemsMuleOff.value || '');
    account.mulingItemsToStore = String(accountsMulingItemsStore && accountsMulingItemsStore.value || '');
    account.mulingItemsFromMain = String(accountsMulingItemsFromMain && accountsMulingItemsFromMain.value || '');
    account.proxy = String(accountsProxyInput && accountsProxyInput.value || '').trim();
    account.proxyUsername = String(accountsProxyUsername && accountsProxyUsername.value || '');
    account.proxyPassword = String(accountsProxyPassword && accountsProxyPassword.value || '');
    account.updatedAt = Date.now();
    if (
      account.email !== prevEmail ||
      account.password !== prevPassword ||
      account.isSteam !== prevIsSteam ||
      account.steamId !== prevSteamId
    ) {
      invalidateDashboardAccountOverview(account.id);
    }
    setAccountsDirty(true, 'Unsaved account changes.');
    renderAccountsList();
    renderAccountsOverview();
    var editorTitleTextEl2 = document.getElementById('accounts-editor-title-text');
    if (editorTitleTextEl2) {
      editorTitleTextEl2.textContent = 'Account Details: ' + String(account.label || account.email || 'Unnamed');
    }
    // Update new editor header
    var dn2 = document.getElementById('accounts-editor-display-name');
    var ds2 = document.getElementById('accounts-editor-display-sub');
    var av2 = document.getElementById('accounts-editor-avatar');
    if (dn2) dn2.textContent = account.label || 'Unnamed Account';
    if (ds2) ds2.textContent = account.email || '';
    if (av2) av2.textContent = (account.label || account.email || 'A').charAt(0).toUpperCase();
  }

  [accountsAliasInput, accountsEmailInput, accountsPasswordInput, accountsNotesInput, accountsSteamIdInput].forEach(function (el) {
    if (!el) return;
    el.addEventListener('input', updateSelectedDashboardAccountFromEditor);
    el.addEventListener('change', updateSelectedDashboardAccountFromEditor);
  });
  if (accountsServerSelect) {
    accountsServerSelect.addEventListener('change', updateSelectedDashboardAccountFromEditor);
  }
  if (accountsIsSteamInput) {
    accountsIsSteamInput.addEventListener('change', function () {
      // Update record first, then re-render so labels and visibility flip.
      updateSelectedDashboardAccountFromEditor();
      renderAccountsEditor();
    });
  }

  // ── "Connect with Steam" button (in the Steam ID field row) ─────────────────
  // Opens Steam OpenID in a child window, parses the Steam ID from the callback,
  // and pre-fills the form. The Deca-issued Secret still has to be entered manually.
  var accountsSteamConnectBtn    = document.getElementById('accounts-steam-connect-btn');
  var accountsSteamConnectStatus = document.getElementById('accounts-steam-connect-status');
  function setSteamConnectStatus(text, isError) {
    if (!accountsSteamConnectStatus) return;
    if (!text) { accountsSteamConnectStatus.style.display = 'none'; return; }
    accountsSteamConnectStatus.textContent = text;
    accountsSteamConnectStatus.style.color = isError ? 'var(--danger, #ef4444)' : 'var(--text-dim)';
    accountsSteamConnectStatus.style.display = '';
  }
  // ── "Import from RotMG Exalt Launcher" button ───────────────────────────────
  // Reads the official launcher's saved Unity PlayerPrefs (GUID + base64 secret)
  // from the registry and fills the form. Works for both email and Steam accounts
  // since the launcher uses the same Productionguid/Productionps keys for both.
  var accountsImportLauncherBtn    = document.getElementById('accounts-import-launcher-btn');
  var accountsImportLauncherStatus = document.getElementById('accounts-import-launcher-status');
  function setImportLauncherStatus(text, isError) {
    if (!accountsImportLauncherStatus) return;
    if (!text) { accountsImportLauncherStatus.style.display = 'none'; return; }
    accountsImportLauncherStatus.textContent = text;
    accountsImportLauncherStatus.style.color = isError ? 'var(--danger, #ef4444)' : 'var(--text-dim)';
    accountsImportLauncherStatus.style.display = '';
  }
  // ── "Import All Captured Accounts" button ───────────────────────────────────
  // Reads the per-login capture log written by the internal DLL's
  // AppEngineManager.Connect hook. For each unique GUID found:
  //   - if a matching account exists (same email/GUID), update its secret/steamId
  //   - otherwise, create a new account row (alias = email prefix), select last
  var accountsImportCaptureBtn    = document.getElementById('accounts-import-capture-btn');
  var accountsImportCaptureStatus = document.getElementById('accounts-import-capture-status');
  function setImportCaptureStatus(text, isError) {
    if (!accountsImportCaptureStatus) return;
    if (!text) { accountsImportCaptureStatus.style.display = 'none'; return; }
    accountsImportCaptureStatus.textContent = text;
    accountsImportCaptureStatus.style.color = isError ? 'var(--danger, #ef4444)' : 'var(--text-dim)';
    accountsImportCaptureStatus.style.display = '';
  }
  if (accountsImportCaptureBtn) {
    accountsImportCaptureBtn.addEventListener('click', async function () {
      var bridge = window.electronAPI && window.electronAPI.rotmg;
      if (!bridge || typeof bridge.readCaptureLog !== 'function') {
        setImportCaptureStatus('Capture-log import is only available in the Electron app build.', true);
        return;
      }
      accountsImportCaptureBtn.disabled = true;
      setImportCaptureStatus('Reading capture log…');
      try {
        var result = await bridge.readCaptureLog();
        if (!result || result.error) {
          setImportCaptureStatus(result && result.error ? result.error : 'Could not read capture log.', true);
          return;
        }
        var captured = Array.isArray(result.uniqueAccounts) ? result.uniqueAccounts : [];
        if (!captured.length) {
          setImportCaptureStatus('Capture log is empty. Log into accounts via the launcher (with our DLL injected) to populate it.', true);
          return;
        }
        var added = 0, updated = 0, lastNewId = null;
        captured.forEach(function (rec) {
          // Find existing by guid (case-insensitive email match).
          var existing = null;
          for (var i = 0; i < dashboardAccounts.length; i++) {
            var a = dashboardAccounts[i];
            if (a.email && String(a.email).toLowerCase() === String(rec.guid).toLowerCase()) {
              existing = a;
              break;
            }
          }
          if (existing) {
            if (rec.secret) existing.password = String(rec.secret);
            if (rec.isSteam) {
              existing.isSteam = true;
              if (rec.steamId) existing.steamId = String(rec.steamId);
            }
            existing.updatedAt = Date.now();
            updated++;
          } else {
            var next = createEmptyDashboardAccount();
            next.email = String(rec.guid);
            next.password = String(rec.secret || '');
            next.isSteam = !!rec.isSteam;
            next.steamId = String(rec.steamId || '');
            // Suggest a label from the email prefix
            var at = next.email.indexOf('@');
            next.label = at > 0 ? next.email.slice(0, at) : next.email;
            next.createdAt = next.updatedAt = Date.now();
            dashboardAccounts.unshift(next);
            lastNewId = next.id;
            added++;
          }
        });
        if (lastNewId) selectedAccountId = lastNewId;
        renderAccountsList();
        renderAccountsEditor();
        setAccountsDirty(true, 'Imported from capture log — save to persist.');
        setImportCaptureStatus(
          'Captured ' + result.total + ' login(s), ' + captured.length + ' unique account(s). ' +
          'Added ' + added + ' new, updated ' + updated + '. Click Save Changes to persist.');
      } catch (err) {
        setImportCaptureStatus('Import failed: ' + ((err && err.message) || String(err)), true);
      } finally {
        accountsImportCaptureBtn.disabled = false;
      }
    });
  }

  if (accountsImportLauncherBtn) {
    accountsImportLauncherBtn.addEventListener('click', async function () {
      var bridge = window.electronAPI && window.electronAPI.rotmg;
      if (!bridge || typeof bridge.readLauncherCreds !== 'function') {
        setImportLauncherStatus('Launcher import is only available in the Electron app build.', true);
        return;
      }
      accountsImportLauncherBtn.disabled = true;
      setImportLauncherStatus('Reading RotMG Exalt Launcher credentials…');
      try {
        var result = await bridge.readLauncherCreds();
        if (!result || result.error) {
          setImportLauncherStatus(result && result.error ? result.error : 'Could not read launcher credentials.', true);
          return;
        }
        if (result.guid && accountsEmailInput) {
          accountsEmailInput.value = result.guid;
        }
        if (result.secret && accountsPasswordInput) {
          accountsPasswordInput.value = result.secret;
        }
        // Update record + re-render to reflect filled values.
        updateSelectedDashboardAccountFromEditor();
        var bits = [];
        if (result.guid) bits.push('GUID: ' + result.guid);
        if (result.secret) bits.push('Secret: ✓ (' + result.secret.length + ' chars)');
        if (result.tokenExpiration && result.tokenTimestamp) {
          var expiresAt = (result.tokenTimestamp + result.tokenExpiration) * 1000;
          bits.push('Active token expires: ' + new Date(expiresAt).toLocaleString());
        }
        setImportLauncherStatus('Imported. ' + bits.join(' · '));
      } catch (err) {
        setImportLauncherStatus('Import failed: ' + ((err && err.message) || String(err)), true);
      } finally {
        accountsImportLauncherBtn.disabled = false;
      }
    });
  }

  if (accountsSteamConnectBtn) {
    accountsSteamConnectBtn.addEventListener('click', async function () {
      var bridge = window.electronAPI && window.electronAPI.steam;
      if (!bridge || typeof bridge.connect !== 'function') {
        setSteamConnectStatus('Steam connect is only available in the Electron app build.', true);
        return;
      }
      accountsSteamConnectBtn.disabled = true;
      setSteamConnectStatus('Opening Steam sign-in window…');
      try {
        var result = await bridge.connect();
        if (!result || result.cancelled) {
          setSteamConnectStatus('Steam sign-in cancelled.');
        } else if (result.error) {
          setSteamConnectStatus(result.error, true);
        } else if (result.steamId) {
          if (accountsSteamIdInput) accountsSteamIdInput.value = result.steamId;
          // Make sure Steam mode is on (in case user clicked Connect before ticking the checkbox)
          if (accountsIsSteamInput && !accountsIsSteamInput.checked) {
            accountsIsSteamInput.checked = true;
            updateSelectedDashboardAccountFromEditor();
            renderAccountsEditor();
          } else {
            updateSelectedDashboardAccountFromEditor();
          }
          setSteamConnectStatus('Connected as Steam ID ' + result.steamId + '. Enter your Deca Secret below to finish.');
        } else {
          setSteamConnectStatus('Steam returned an unexpected response.', true);
        }
      } catch (err) {
        setSteamConnectStatus('Steam connect failed: ' + ((err && err.message) || String(err)), true);
      } finally {
        accountsSteamConnectBtn.disabled = false;
      }
    });
  }

  // Muling role buttons
  [accountsRoleNoneBtn, accountsRoleMainBtn, accountsRoleMuleBtn].forEach(function (btn) {
    if (!btn) return;
    btn.addEventListener('click', function () {
      if (suppressAccountsEditorEvents) return;
      var account = getSelectedDashboardAccount();
      if (!account || isSelectedAccountRunning()) return;
      account.mulingRole = btn.getAttribute('data-role') || 'none';
      account.updatedAt = Date.now();
      setAccountsDirty(true, 'Unsaved account changes.');
      renderAccountsEditor();
    });
  });

  // Store mode buttons
  [accountsModeAnyBtn, accountsModeSpecificBtn].forEach(function (btn) {
    if (!btn) return;
    btn.addEventListener('click', function () {
      if (suppressAccountsEditorEvents) return;
      var account = getSelectedDashboardAccount();
      if (!account || isSelectedAccountRunning()) return;
      account.mulingStoreMode = btn.getAttribute('data-mode') || 'any';
      account.updatedAt = Date.now();
      setAccountsDirty(true, 'Unsaved account changes.');
      renderAccountsEditor();
    });
  });

  // Proxy input — show/hide auth fields on change
  if (accountsProxyInput) {
    accountsProxyInput.addEventListener('input', function () {
      updateSelectedDashboardAccountFromEditor();
      var hasProxy = !!String(accountsProxyInput.value || '').trim();
      if (accountsProxyAuthWrap) accountsProxyAuthWrap.style.display = hasProxy ? '' : 'none';
    });
    accountsProxyInput.addEventListener('change', updateSelectedDashboardAccountFromEditor);
  }

  // Muling text inputs (items + proxy creds)
  [accountsMulingItemsMuleOff, accountsMulingItemsStore, accountsMulingItemsFromMain, accountsProxyUsername, accountsProxyPassword].forEach(function (el) {
    if (!el) return;
    el.addEventListener('input', function() {
      updateSelectedDashboardAccountFromEditor();
      // Re-render pot button active states for this input's row
      if (el.previousElementSibling && el.previousElementSibling.classList && el.previousElementSibling.classList.contains('accounts-pot-row')) {
        renderPotRowState(el.previousElementSibling, el);
      }
    });
    el.addEventListener('change', updateSelectedDashboardAccountFromEditor);
  });

  // Delegated pot button clicks on the muling section
  if (accountsMulingSection) {
    accountsMulingSection.addEventListener('click', function(e) {
      var btn = e.target.closest('.accounts-pot-btn');
      if (!btn || suppressAccountsEditorEvents) return;
      var account = getSelectedDashboardAccount();
      if (!account || isSelectedAccountRunning()) return;

      var potRow = btn.closest('[data-pot-field]');
      if (!potRow) return;
      var fieldName = potRow.getAttribute('data-pot-field');
      var fieldEl = fieldName === 'mule-off' ? accountsMulingItemsMuleOff
                  : fieldName === 'store'     ? accountsMulingItemsStore
                  : fieldName === 'from-main' ? accountsMulingItemsFromMain
                  : null;
      if (!fieldEl) return;

      var pot = btn.getAttribute('data-pot');
      var potIds = pot === 'all' ? ALL_STAT_POT_IDS : (STAT_POT_IDS[pot] || []);
      var currentSet = Object.create(null);
      parseItemIds(fieldEl.value).forEach(function(id) { currentSet[id] = true; });
      var allActive = potIds.every(function(id) { return !!currentSet[id]; });
      if (allActive) {
        potIds.forEach(function(id) { delete currentSet[id]; });
      } else {
        potIds.forEach(function(id) { currentSet[id] = true; });
      }
      fieldEl.value = serializeItemIds(Object.keys(currentSet).map(Number));

      updateSelectedDashboardAccountFromEditor();
      renderPotRowState(potRow, fieldEl);
    });
  }

  // Right-click context menu on account cards
  var accountsCardCtxTargetId = null;
  if (accountsListEl) {
    accountsListEl.addEventListener('contextmenu', function (e) {
      var card = e.target.closest('.account-card');
      if (!card) return;
      e.preventDefault();
      var accountId = card.getAttribute('data-account-id');
      accountsCardCtxTargetId = accountId;
      if (accountsCardCtxMenu) {
        var isMain = false;
        if (accountId) {
          for (var i = 0; i < dashboardAccounts.length; i++) {
            if (dashboardAccounts[i].id === accountId) {
              isMain = dashboardAccounts[i].mulingRole === 'main';
              break;
            }
          }
        }
        var startMulingItem = accountsCardCtxMenu.querySelector('[data-card-action="start-muling"]');
        if (startMulingItem) startMulingItem.style.display = isMain ? '' : 'none';
        accountsCardCtxMenu.style.left = e.clientX + 'px';
        accountsCardCtxMenu.style.top = e.clientY + 'px';
        accountsCardCtxMenu.style.display = '';
      }
    });
  }
  document.addEventListener('click', function () {
    if (accountsCardCtxMenu) accountsCardCtxMenu.style.display = 'none';
  });
  if (accountsCardCtxMenu) {
    accountsCardCtxMenu.addEventListener('click', function (e) {
      var item = e.target.closest('[data-card-action]');
      accountsCardCtxMenu.style.display = 'none';
      if (!item) return;
      var action = item.getAttribute('data-card-action');
      if (action === 'start-muling') {
        var mainId = accountsCardCtxTargetId;
        if (!mainId) { setAccountsStatus('No account selected.', true); return; }
        setAccountsStatus('Starting muling session…', false);
        fetch('/api/muling/start', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ mainAccountId: mainId }),
        })
          .then(function (r) { return r.json(); })
          .then(function (data) {
            if (data.error) { setAccountsStatus('Muling error: ' + data.error, true); return; }
            setAccountsStatus('Muling session started', false);
            showMulingPanel();
          })
          .catch(function () { setAccountsStatus('Failed to start muling.', true); });
      } else if (action === 'edit') {
        if (accountsCardCtxTargetId) {
          selectedAccountId = accountsCardCtxTargetId;
          accountsDetailsCollapsed = false;
          applyAccountsDetailsVisibility();
          renderAccountsTab();
          maybeLoadSelectedDashboardAccountOverview();
        }
      } else if (action === 'duplicate') {
        if (accountsCardCtxTargetId) {
          selectedAccountId = accountsCardCtxTargetId;
          createDashboardAccount(true);
        }
      } else if (action === 'delete') {
        if (accountsCardCtxTargetId) {
          selectedAccountId = accountsCardCtxTargetId;
          renderAccountsList();
          showDeleteAccountModal();
        }
      }
    });
  }

  // ── Muling panel ────────────────────────────────────────────────────────────

  var mulingPanel = document.getElementById('muling-panel');
  var mulingPanelPhase = document.getElementById('muling-panel-phase');
  var mulingPanelMainName = document.getElementById('muling-panel-main-name');
  var mulingPanelMainPots = document.getElementById('muling-panel-main-pots');
  var mulingPanelMainStatus = document.getElementById('muling-panel-main-status');
  var mulingPanelMules = document.getElementById('muling-panel-mules');
  var mulingPanelStopBtn = document.getElementById('muling-panel-stop');
  var mulingPanelCloseBtn = document.getElementById('muling-panel-close');
  var mulingPanelCharInfo = document.getElementById('muling-panel-char-info');

  function showMulingPanel() {
    if (mulingPanel) mulingPanel.style.display = '';
  }

  function hideMulingPanel() {
    if (mulingPanel) mulingPanel.style.display = 'none';
  }

  if (mulingPanelStopBtn) {
    mulingPanelStopBtn.addEventListener('click', function () {
      fetch('/api/muling/stop', { method: 'POST' }).catch(function () {});
      setAccountsStatus('Muling stopped.', false);
    });
  }

  if (mulingPanelCloseBtn) {
    mulingPanelCloseBtn.addEventListener('click', function () {
      hideMulingPanel();
    });
  }

  function handleMulingStatus(status) {
    if (!status || typeof status !== 'object') return;
    var phase = String(status.phase || '');

    if (phase === 'stopped') {
      if (mulingPanelPhase) mulingPanelPhase.textContent = 'Stopped';
      return;
    }

    showMulingPanel();

    if (mulingPanelPhase) {
      mulingPanelPhase.textContent = phase === 'done' ? 'Done' : phase === 'error' ? 'Error' : phase === 'trading' ? 'Trading' : 'Running';
    }

    var mainInfo = status.main || {};
    if (mulingPanelMainName) {
      var nameText = String(mainInfo.name || '—');
      var charId = mainInfo.charId;
      if (charId !== undefined) {
        mulingPanelMainName.textContent = nameText + ' · #' + charId;
      } else {
        mulingPanelMainName.textContent = nameText;
      }
    }
    if (mulingPanelMainPots && mainInfo.pots !== undefined) {
      mulingPanelMainPots.textContent = mainInfo.pots > 0 ? mainInfo.pots + ' pots' : '';
    }
    if (mulingPanelMainStatus) mulingPanelMainStatus.textContent = String(mainInfo.status || '—');
    if (mulingPanelCharInfo) mulingPanelCharInfo.textContent = '';

    if (mulingPanelMules && Array.isArray(status.mules)) {
      // Rebuild mule rows
      mulingPanelMules.innerHTML = '';
      status.mules.forEach(function (mule) {
        var row = document.createElement('div');
        row.className = 'muling-panel-row';
        var roleEl = document.createElement('span');
        roleEl.className = 'muling-panel-role muling-role-mule';
        roleEl.textContent = 'Mule';
        var nameEl = document.createElement('span');
        nameEl.className = 'muling-panel-name';
        nameEl.textContent = String(mule.name || '—');
        var potsEl = document.createElement('span');
        potsEl.className = 'muling-panel-pots';
        if (mule.deposited) potsEl.textContent = '+' + mule.deposited;
        var statusEl = document.createElement('span');
        statusEl.className = 'muling-panel-status';
        statusEl.textContent = String(mule.status || '—');
        row.appendChild(roleEl);
        row.appendChild(nameEl);
        row.appendChild(potsEl);
        row.appendChild(statusEl);
        mulingPanelMules.appendChild(row);
      });
    }
  }

  // ────────────────────────────────────────────────────────────────────────────

  loadDashboardAccounts();

  // --- Stubs after removal of visual automation (disk scripts: Scripts tab) ---
  // (homeLastCompletedScript is declared earlier with `let`; duplicate `var` here caused a SyntaxError and blocked the whole dashboard.)
  var runnerState = 'idle';
  var runnerPauseRequested = false;
  var runnerStopRequested = false;
  var runContext = null;
  var selectedScriptId = null;
  var selectedThreadId = null;
  var selectedNodeId = null;
  function getScript() { return null; }
  // getHomeScriptRuntimeMs / getHomeCurrentStatus are defined earlier — duplicate stubs here overwrote them at runtime.
  function startRunner() {}
  function stopRunner() {}
  function pauseRunner() {}
  function runnerTick() {}
  function triggerTick() {}
  function updateTransportButtons() {}
  var automationInited = false;
  function populateScriptSelect() {
    fetch('/api/scripts')
      .then(function(r) { return r.json(); })
      .then(function(data) {
        scriptsTabLastData = data || { scripts: [], dir: null };
        var scripts = Array.isArray(scriptsTabLastData.scripts) ? scriptsTabLastData.scripts : [];
        // Keep selectedScriptId valid
        if (selectedScriptId && !scripts.some(function(s) { return String(s.id || '') === selectedScriptId; })) {
          selectedScriptId = null;
        }
        renderHomeTab();
        if (isMacStyleSidebar() && multiAccountSidebarMode === 'connected') renderMultiAccountConnectedList();
        if (macPopoutOpenClientId) refreshMacPopoutScriptPanel(macPopoutOpenClientId);
      })
      .catch(function() {});
  }

  function updateScriptCurrentDisplay() {
    var nameEl = document.getElementById('home-script-current-name');
    var statusEl = document.getElementById('home-script-current-status');
    if (!nameEl) return;
    var scripts = Array.isArray(scriptsTabLastData && scriptsTabLastData.scripts) ? scriptsTabLastData.scripts : [];
    var sc = selectedScriptId ? scripts.find(function(s) { return String(s.id || '') === selectedScriptId; }) : null;
    if (sc) {
      nameEl.textContent = String(sc.name || sc.id || '');
      nameEl.classList.remove('muted');
      if (statusEl) {
        var st = String(sc.status || 'idle');
        statusEl.textContent = st.charAt(0).toUpperCase() + st.slice(1);
        statusEl.className = 'script-current-status ' + st;
      }
    } else {
      nameEl.textContent = 'No script selected';
      nameEl.classList.add('muted');
      if (statusEl) { statusEl.textContent = ''; statusEl.className = 'script-current-status'; }
    }
  }

  function openScriptPicker() {
    var overlay = document.getElementById('script-picker-overlay');
    if (!overlay) return;
    overlay.classList.remove('hidden');
    var searchEl = document.getElementById('script-picker-search');
    if (searchEl) { searchEl.value = ''; searchEl.focus(); }
    var sortEl = document.getElementById('script-picker-sort');
    if (sortEl) sortEl.value = 'name';
    renderScriptPickerList();
  }

  function closeScriptPicker() {
    var overlay = document.getElementById('script-picker-overlay');
    if (overlay) overlay.classList.add('hidden');
  }

  function renderScriptPickerList() {
    var listEl = document.getElementById('script-picker-list');
    if (!listEl) return;
    var scripts = Array.isArray(scriptsTabLastData && scriptsTabLastData.scripts) ? scriptsTabLastData.scripts : [];
    var searchEl = document.getElementById('script-picker-search');
    var sortEl = document.getElementById('script-picker-sort');
    var query = searchEl ? searchEl.value.trim().toLowerCase() : '';
    var sortBy = sortEl ? sortEl.value : 'name';

    var filtered = scripts.filter(function(sc) {
      if (!query) return true;
      return String(sc.name || '').toLowerCase().includes(query) ||
             String(sc.developer || '').toLowerCase().includes(query);
    });

    filtered.sort(function(a, b) {
      if (sortBy === 'name-desc') return String(b.name || '').localeCompare(String(a.name || ''));
      if (sortBy === 'developer') return String(a.developer || '').localeCompare(String(b.developer || ''));
      if (sortBy === 'status') return String(a.status || '').localeCompare(String(b.status || ''));
      return String(a.name || '').localeCompare(String(b.name || ''));
    });

    if (!filtered.length) {
      listEl.innerHTML = '<div class="script-picker-empty">' + (query ? 'No scripts match your search.' : 'No scripts available.') + '</div>';
      return;
    }

    listEl.innerHTML = '';
    filtered.forEach(function(sc) {
      var id = String(sc.id || '');
      var st = String(sc.status || 'idle');
      var item = document.createElement('div');
      item.className = 'script-picker-item' + (id === selectedScriptId ? ' selected' : '');
      item.setAttribute('data-script-id', id);
      var devText = sc.developer ? 'by ' + escapeHtml(String(sc.developer)) : '';
      var verText = sc.version ? 'v' + escapeHtml(String(sc.version)) : '';
      var meta = [devText, verText].filter(Boolean).join(' · ');
      item.innerHTML =
        '<div class="script-picker-item-info">' +
          '<div class="script-picker-item-name">' + escapeHtml(String(sc.name || id)) + '</div>' +
          (meta ? '<div class="script-picker-item-meta">' + meta + '</div>' : '') +
        '</div>' +
        '<span class="script-picker-item-badge ' + st + '">' + escapeHtml(st) + '</span>';
      item.addEventListener('click', function() {
        selectedScriptId = id || null;
        closeScriptPicker();
        updateScriptCurrentDisplay();
        renderHomeTab();
      });
      listEl.appendChild(item);
    });
  }

  (function initScriptPicker() {
    // Browse button is before the script tag — direct binding is fine.
    var browseBtn = document.getElementById('home-script-browse-btn');
    if (browseBtn) browseBtn.addEventListener('click', openScriptPicker);

    // The picker overlay is injected after the <script> tag so its child
    // elements don't exist yet when this IIFE runs. Use document-level
    // delegation for everything inside the overlay.
    document.addEventListener('click', function(e) {
      if (e.target.closest('#script-picker-close')) { closeScriptPicker(); return; }
      if (e.target.classList.contains('script-picker-backdrop')) { closeScriptPicker(); return; }
    });

    document.addEventListener('input', function(e) {
      if (e.target.id === 'script-picker-search') renderScriptPickerList();
    });

    document.addEventListener('change', function(e) {
      if (e.target.id === 'script-picker-sort') renderScriptPickerList();
    });
  })();

  // ===== Script-defined popout panels (RealmEngine.ui.panel) =====
  //
  // Renders a centered modal from a serializable widget tree the script
  // declared. Widget interactions are forwarded over the dashboard WS as
  // `scriptPanelEvent` messages, which DevServer dispatches into the
  // running script's handler.

  var scriptPanels = new Map();          // scriptId -> { def, isOpen, version }
  var scriptPanelOpenId = null;          // currently visible panel's scriptId

  function getScriptPanelEl() { return document.getElementById('script-panel-popout'); }

  function sendScriptPanelEvent(scriptId, widgetId, kind, value) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    try {
      ws.send(JSON.stringify({
        type: 'scriptPanelEvent',
        scriptId: String(scriptId || ''),
        widgetId: String(widgetId || ''),
        kind: kind,
        value: value,
      }));
    } catch (_e) {}
  }

  function handleScriptPanelState(msg) {
    if (!msg) return;
    var scriptId = String(msg.scriptId || '');
    if (!scriptId) return;
    if (msg.def == null) {
      scriptPanels.delete(scriptId);
      if (scriptPanelOpenId === scriptId) closeScriptPanelById(scriptId, { notifyServer: false });
    } else {
      var existing = scriptPanels.get(scriptId);
      var entry = {
        def: msg.def,
        isOpen: !!msg.isOpen,
        version: (existing ? existing.version : 0) + 1,
      };
      scriptPanels.set(scriptId, entry);
      if (scriptPanelOpenId === scriptId) renderScriptPanel(scriptId);
    }
    refreshScriptsDetailGuiButton();
  }

  function handleScriptPanelPatches(msg) {
    if (!msg) return;
    var scriptId = String(msg.scriptId || '');
    var entry = scriptPanels.get(scriptId);
    if (!entry || !Array.isArray(msg.patches)) return;
    msg.patches.forEach(function (patch) { applyPatchToDef(entry.def, patch); });
    if (scriptPanelOpenId === scriptId) {
      msg.patches.forEach(function (patch) { applyPatchToDom(scriptId, patch); });
    }
  }

  function findWidgetInDef(widgets, id) {
    if (!Array.isArray(widgets)) return null;
    for (var i = 0; i < widgets.length; i++) {
      var w = widgets[i];
      if (!w) continue;
      if (w.id === id) return w;
      if (Array.isArray(w.children)) {
        var hit = findWidgetInDef(w.children, id);
        if (hit) return hit;
      }
      if (Array.isArray(w.tabs)) {
        for (var ti = 0; ti < w.tabs.length; ti++) {
          var tab = w.tabs[ti];
          var tabHit = findWidgetInDef(tab && tab.children, id);
          if (tabHit) return tabHit;
        }
      }
    }
    return null;
  }

  function applyPatchToDef(def, patch) {
    if (!def || !patch || !patch.id) return;
    var w = findWidgetInDef(def.widgets, patch.id);
    if (!w) return;
    switch (patch.op) {
      case 'value':
        if (w.type === 'item') w.item = patch.value;
        else if (w.type === 'itemGrid') w.items = Array.isArray(patch.value) ? patch.value.slice() : [];
        else w.value = patch.value;
        break;
      case 'image': w.src = String(patch.value || ''); break;
      case 'text':
        if ('text' in w) w.text = patch.value;
        if ('label' in w) w.label = patch.value;
        if ('caption' in w) w.caption = patch.value;
        break;
      case 'enabled': w.enabled = !!patch.value; break;
      case 'visible': w.visible = !!patch.value; break;
      case 'log-append':
        if (!Array.isArray(w.lines)) w.lines = [];
        w.lines.push(String(patch.value));
        var cap = (typeof w.maxLines === 'number' && w.maxLines > 0) ? w.maxLines : 200;
        if (w.lines.length > cap) w.lines.splice(0, w.lines.length - cap);
        break;
      case 'log-set':
        w.lines = Array.isArray(patch.value) ? patch.value.slice() : [];
        break;
    }
  }

  function applyPatchToDom(scriptId, patch) {
    if (!patch || !patch.id) return;
    var sel = '[data-script-widget-id="' + cssEscape(patch.id) + '"]';
    var root = getScriptPanelEl();
    if (!root) return;
    var el = root.querySelector(sel);
    if (!el) return;
    switch (patch.op) {
      case 'value': {
        var input = el.querySelector('input,select,textarea');
        if (!input) {
          replaceScriptPanelWidgetDom(scriptId, patch.id);
          return;
        }
        if (input.type === 'checkbox') {
          input.checked = !!patch.value;
        } else {
          input.value = patch.value == null ? '' : String(patch.value);
        }
        var sliderVal = el.querySelector('.script-panel-slider-value');
        if (sliderVal) sliderVal.textContent = formatSliderValue(input.value, el.dataset.unit);
        var progressFill = el.querySelector('.script-panel-progress-fill');
        if (progressFill) progressFill.style.width = Math.max(0, Math.min(1, Number(patch.value) || 0)) * 100 + '%';
        break;
      }
      case 'image': {
        var img = el.querySelector('img.script-panel-image-img');
        if (img) img.src = String(patch.value || '');
        break;
      }
      case 'text': {
        var textTarget = el.querySelector('.script-panel-text-target');
        if (textTarget) textTarget.textContent = String(patch.value || '');
        break;
      }
      case 'enabled': {
        var controls = el.querySelectorAll('input,select,textarea,button');
        controls.forEach(function (c) { c.disabled = !patch.value; });
        break;
      }
      case 'visible': {
        el.hidden = !patch.value;
        break;
      }
      case 'log-append': {
        var logEl = el.querySelector('.script-panel-log');
        if (logEl) {
          if (logEl.querySelector('.script-panel-log-empty')) logEl.innerHTML = '';
          var line = document.createElement('div');
          line.textContent = String(patch.value || '');
          logEl.appendChild(line);
          var max = Number(el.dataset.maxLines || 200);
          while (logEl.childElementCount > max) logEl.removeChild(logEl.firstChild);
          logEl.scrollTop = logEl.scrollHeight;
        }
        break;
      }
      case 'log-set': {
        var logEl2 = el.querySelector('.script-panel-log');
        if (logEl2) {
          logEl2.innerHTML = '';
          (Array.isArray(patch.value) ? patch.value : []).forEach(function (l) {
            var line = document.createElement('div');
            line.textContent = String(l == null ? '' : l);
            logEl2.appendChild(line);
          });
          logEl2.scrollTop = logEl2.scrollHeight;
        }
        break;
      }
    }
  }

  function formatSliderValue(raw, unit) {
    var n = Number(raw);
    var text = Number.isFinite(n) ? String(n) : String(raw == null ? '' : raw);
    return unit ? text + unit : text;
  }

  function cssEscape(s) {
    if (window.CSS && typeof window.CSS.escape === 'function') return window.CSS.escape(String(s));
    return String(s).replace(/(["\\\[\]\(\)\.#:>\+~\*\^\$\|=\s])/g, '\\$1');
  }

  function openScriptPanelById(scriptId) {
    var id = String(scriptId || '').trim();
    if (!id) return;
    var entry = scriptPanels.get(id);
    if (!entry) return;
    scriptPanelOpenId = id;
    entry.isOpen = true;
    var popout = getScriptPanelEl();
    if (popout) popout.classList.remove('hidden');
    renderScriptPanel(id);
  }

  function closeScriptPanelById(scriptId, opts) {
    var notify = opts && opts.notifyServer !== false;
    var id = String(scriptId || scriptPanelOpenId || '').trim();
    if (!id) return;
    if (scriptPanelOpenId === id) {
      scriptPanelOpenId = null;
      var popout = getScriptPanelEl();
      if (popout) popout.classList.add('hidden');
    }
    var entry = scriptPanels.get(id);
    if (entry) entry.isOpen = false;
    if (notify) sendScriptPanelEvent(id, '', 'closed-by-user');
  }

  function getScriptNameForId(scriptId) {
    var scripts = (scriptsTabLastData && scriptsTabLastData.scripts) || [];
    for (var i = 0; i < scripts.length; i++) {
      if (scripts[i] && String(scripts[i].id) === String(scriptId)) {
        return String(scripts[i].name || scripts[i].id || scriptId);
      }
    }
    return String(scriptId);
  }

  function renderScriptPanel(scriptId) {
    var popout = getScriptPanelEl();
    var body = document.getElementById('script-panel-popout-body');
    var title = document.getElementById('script-panel-popout-title');
    var subtitle = document.getElementById('script-panel-popout-subtitle');
    var inner = document.getElementById('script-panel-popout-inner');
    if (!popout || !body || !title || !subtitle || !inner) return;
    var entry = scriptPanels.get(String(scriptId));
    if (!entry) {
      body.innerHTML = '<div class="script-panel-empty">Panel no longer available.</div>';
      title.textContent = 'Script panel';
      subtitle.textContent = '';
      return;
    }
    var def = entry.def || {};
    title.textContent = String(def.title || getScriptNameForId(scriptId));
    subtitle.textContent = String(def.subtitle || '');
    var width = Number(def.width);
    if (Number.isFinite(width) && width >= 280 && width <= 1200) {
      inner.style.setProperty('--script-panel-width', width + 'px');
    } else {
      inner.style.removeProperty('--script-panel-width');
    }
    body.innerHTML = '';
    var widgets = Array.isArray(def.widgets) ? def.widgets : [];
    if (!widgets.length) {
      body.innerHTML = '<div class="script-panel-empty">This script registered an empty panel.</div>';
      return;
    }
    widgets.forEach(function (w) {
      var el = renderScriptPanelWidget(w, scriptId);
      if (el) body.appendChild(el);
    });
  }

  function renderScriptPanelWidget(w, scriptId) {
    if (!w || typeof w !== 'object') return null;
    var wrap = document.createElement('div');
    wrap.className = 'script-panel-widget script-panel-' + String(w.type || 'unknown');
    if (w.id) wrap.dataset.scriptWidgetId = String(w.id);
    if (w.visible === false) wrap.hidden = true;
    if (w.tooltip) wrap.title = String(w.tooltip);

    switch (w.type) {
      case 'group':       buildGroupWidget(wrap, w, scriptId); break;
      case 'row':         buildRowWidget(wrap, w, scriptId); break;
      case 'tabs':        buildTabsWidget(wrap, w, scriptId); break;
      case 'heading':     buildHeadingWidget(wrap, w); break;
      case 'label':       buildLabelWidget(wrap, w); break;
      case 'image':       buildImageWidget(wrap, w); break;
      case 'item':        buildItemWidget(wrap, w, scriptId); break;
      case 'itemGrid':    buildItemGridWidget(wrap, w); break;
      case 'button':      buildButtonWidget(wrap, w, scriptId); break;
      case 'toggle':      buildToggleWidget(wrap, w, scriptId); break;
      case 'slider':      buildSliderWidget(wrap, w, scriptId); break;
      case 'number':      buildNumberWidget(wrap, w, scriptId); break;
      case 'text':        buildTextWidget(wrap, w, scriptId); break;
      case 'select':      buildSelectWidget(wrap, w, scriptId); break;
      case 'progress':    buildProgressWidget(wrap, w); break;
      case 'log':         buildLogWidget(wrap, w); break;
      case 'spacer':      wrap.style.height = (Number(w.size) || 8) + 'px'; break;
      default:
        wrap.textContent = 'Unknown widget: ' + String(w.type);
        wrap.className += ' script-panel-empty';
    }
    return wrap;
  }

  function buildGroupWidget(wrap, w, scriptId) {
    wrap.classList.add('script-panel-group');
    if (w.collapsed) wrap.classList.add('collapsed');
    if (w.title) {
      var t = document.createElement('div');
      t.className = 'script-panel-group-title' + (w.collapsible ? ' collapsible' : '');
      t.textContent = String(w.title);
      if (w.collapsible) t.addEventListener('click', function () { wrap.classList.toggle('collapsed'); });
      wrap.appendChild(t);
    }
    var children = document.createElement('div');
    children.className = 'script-panel-group-children';
    (Array.isArray(w.children) ? w.children : []).forEach(function (c) {
      var el = renderScriptPanelWidget(c, scriptId);
      if (el) children.appendChild(el);
    });
    wrap.appendChild(children);
  }

  function buildRowWidget(wrap, w, scriptId) {
    wrap.classList.add('script-panel-row');
    if (typeof w.gap === 'number') wrap.style.gap = w.gap + 'px';
    (Array.isArray(w.children) ? w.children : []).forEach(function (c) {
      var el = renderScriptPanelWidget(c, scriptId);
      if (el) wrap.appendChild(el);
    });
  }

  function buildTabsWidget(wrap, w, scriptId) {
    wrap.classList.add('script-panel-tabs');
    var tabs = Array.isArray(w.tabs) ? w.tabs.filter(function (tab) { return tab && tab.id != null; }) : [];
    if (!tabs.length) {
      wrap.classList.add('script-panel-empty');
      wrap.textContent = 'No tabs configured.';
      return;
    }

    var activeId = String(w.value || tabs[0].id);
    if (!tabs.some(function (tab) { return String(tab.id) === activeId; })) activeId = String(tabs[0].id);
    w.value = activeId;

    var tabList = document.createElement('div');
    tabList.className = 'script-panel-tabs-list';
    tabList.setAttribute('role', 'tablist');
    var panes = document.createElement('div');
    panes.className = 'script-panel-tabs-panes';

    function activate(nextId, notify) {
      activeId = String(nextId);
      w.value = activeId;
      tabList.querySelectorAll('.script-panel-tab-button').forEach(function (btn) {
        var isActive = btn.dataset.tabId === activeId;
        btn.classList.toggle('active', isActive);
        btn.setAttribute('aria-selected', isActive ? 'true' : 'false');
        btn.tabIndex = isActive ? 0 : -1;
      });
      panes.querySelectorAll('.script-panel-tab-pane').forEach(function (pane) {
        pane.hidden = pane.dataset.tabId !== activeId;
      });
      if (notify && w.id) sendScriptPanelEvent(scriptId, w.id, 'change', activeId);
    }

    tabs.forEach(function (tab, idx) {
      var tabId = String(tab.id);
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'script-panel-tab-button';
      btn.dataset.tabId = tabId;
      btn.setAttribute('role', 'tab');
      btn.textContent = String(tab.label != null ? tab.label : tabId);
      btn.disabled = w.enabled === false;
      btn.addEventListener('click', function () { activate(tabId, true); });
      btn.addEventListener('keydown', function (e) {
        if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
        e.preventDefault();
        var delta = e.key === 'ArrowRight' ? 1 : -1;
        var next = (idx + delta + tabs.length) % tabs.length;
        var nextBtn = tabList.querySelector('[data-tab-id="' + cssEscape(String(tabs[next].id)) + '"]');
        if (nextBtn) nextBtn.focus();
        activate(String(tabs[next].id), true);
      });
      tabList.appendChild(btn);

      var pane = document.createElement('div');
      pane.className = 'script-panel-tab-pane';
      pane.dataset.tabId = tabId;
      pane.setAttribute('role', 'tabpanel');
      (Array.isArray(tab.children) ? tab.children : []).forEach(function (child) {
        var childEl = renderScriptPanelWidget(child, scriptId);
        if (childEl) pane.appendChild(childEl);
      });
      panes.appendChild(pane);
    });

    wrap.appendChild(tabList);
    wrap.appendChild(panes);
    activate(activeId, false);
  }

  function buildHeadingWidget(wrap, w) {
    var lvl = (w.level === 1 || w.level === 3) ? w.level : 2;
    wrap.classList.add('script-panel-heading', 'lvl-' + lvl);
    wrap.textContent = String(w.text || '');
  }

  function buildLabelWidget(wrap, w) {
    wrap.classList.add('script-panel-label');
    if (w.muted) wrap.classList.add('muted');
    var span = document.createElement('span');
    span.className = 'script-panel-text-target';
    span.textContent = String(w.text || '');
    wrap.appendChild(span);
  }

  function replaceScriptPanelWidgetDom(scriptId, id) {
    var entry = scriptPanels.get(String(scriptId || scriptPanelOpenId || ''));
    var widget = entry && entry.def ? findWidgetInDef(entry.def.widgets, id) : null;
    var root = getScriptPanelEl();
    var oldEl = root ? root.querySelector('[data-script-widget-id="' + cssEscape(id) + '"]') : null;
    if (!widget || !oldEl) return;
    var nextEl = renderScriptPanelWidget(widget, String(scriptId || scriptPanelOpenId || ''));
    if (nextEl) oldEl.replaceWith(nextEl);
  }

  function normalizePanelItem(raw) {
    if (raw == null || raw === '') return { objectType: -1 };
    if (typeof raw === 'number' || typeof raw === 'string') {
      var n = Number(raw);
      return { objectType: Number.isFinite(n) ? Math.trunc(n) : -1 };
    }
    if (typeof raw !== 'object') return { objectType: -1 };
    var objectType = Number(raw.objectType != null ? raw.objectType : (raw.id != null ? raw.id : raw.type));
    return {
      objectType: Number.isFinite(objectType) ? Math.trunc(objectType) : -1,
      name: raw.name != null ? String(raw.name) : undefined,
      objectTypeHex: raw.objectTypeHex != null ? String(raw.objectTypeHex) : undefined,
      enchantIds: Array.isArray(raw.enchantIds) ? raw.enchantIds : undefined,
      quantity: raw.quantity,
      label: raw.label != null ? String(raw.label) : undefined,
    };
  }

  function normalizedPanelItemLabel(item) {
    if (!item || Number(item.objectType) < 0) return 'Empty';
    var record = getEamItemRecord(item.objectType);
    return String(item.label || item.name || (record && record[0]) || ('Type ' + String(item.objectType)));
  }

  function buildImageWidget(wrap, w) {
    wrap.classList.add('script-panel-image-wrap');
    var row = document.createElement('div');
    row.className = 'script-panel-image-frame';
    var img = document.createElement('img');
    img.className = 'script-panel-image-img' + (w.pixelated === false ? '' : ' pixelated');
    img.alt = String(w.alt || w.caption || '');
    img.src = String(w.src || '');
    var size = Math.max(16, Math.min(160, Number(w.size) || 40));
    img.style.width = size + 'px';
    img.style.height = size + 'px';
    row.appendChild(img);
    wrap.appendChild(row);
    if (w.caption) {
      var cap = document.createElement('div');
      cap.className = 'script-panel-image-caption script-panel-text-target';
      cap.textContent = String(w.caption);
      wrap.appendChild(cap);
    }
  }

  function buildPanelItemSpriteElement(rawItem, size, showQuantity, scriptClickMode) {
    var item = normalizePanelItem(rawItem);
    var holder = document.createElement('span');
    holder.className = 'script-panel-item-sprite-wrap';
    var slotSize = Math.max(24, Math.min(72, Number(size) || 40));
    holder.style.setProperty('--script-panel-item-size', slotSize + 'px');
    holder.innerHTML = buildItemSpriteHtml(item, 'script-panel-item-sprite');
    var btn = holder.querySelector('.rotmg-item-sprite');
    if (btn && scriptClickMode) {
      btn.disabled = true;
      btn.tabIndex = -1;
      btn.classList.add('script-panel-item-sprite-pass-through');
    }
    if (showQuantity && item.quantity != null && Number(item.quantity) > 1) {
      var qty = document.createElement('span');
      qty.className = 'script-panel-item-qty';
      qty.textContent = String(item.quantity);
      holder.appendChild(qty);
    }
    return holder;
  }

  function buildItemWidget(wrap, w, scriptId) {
    wrap.classList.add('script-panel-item-widget');
    var item = normalizePanelItem(w.item);
    if (w.label) {
      var label = document.createElement('div');
      label.className = 'script-panel-item-label script-panel-text-target';
      label.textContent = String(w.label);
      wrap.appendChild(label);
    }
    var row = document.createElement('div');
    row.className = 'script-panel-item-row';
    row.appendChild(buildPanelItemSpriteElement(item, w.size, w.showQuantity !== false, !!w.id));
    if (w.showName) {
      var name = document.createElement('div');
      name.className = 'script-panel-item-name';
      name.textContent = normalizedPanelItemLabel(item);
      row.appendChild(name);
    }
    if (w.id && w.enabled !== false) {
      row.addEventListener('click', function () { sendScriptPanelEvent(scriptId, w.id, 'click'); });
      row.classList.add('clickable');
    }
    wrap.appendChild(row);
  }

  function buildItemGridWidget(wrap, w) {
    wrap.classList.add('script-panel-item-grid-widget');
    var items = Array.isArray(w.items) ? w.items : [];
    var grid = document.createElement('div');
    grid.className = 'script-panel-item-grid';
    var size = Math.max(24, Math.min(72, Number(w.size) || 40));
    grid.style.setProperty('--script-panel-item-size', size + 'px');
    grid.style.setProperty('--script-panel-item-gap', Math.max(0, Math.min(16, Number(w.gap) || 4)) + 'px');
    if (Number.isFinite(Number(w.columns)) && Number(w.columns) > 0) {
      grid.style.gridTemplateColumns = 'repeat(' + Math.max(1, Math.min(12, Math.trunc(Number(w.columns)))) + ', var(--script-panel-item-size))';
    }
    items.forEach(function (raw) {
      var cell = document.createElement('div');
      cell.className = 'script-panel-item-grid-cell';
      var item = normalizePanelItem(raw);
      cell.appendChild(buildPanelItemSpriteElement(item, size, w.showQuantities !== false, false));
      if (w.showNames) {
        var name = document.createElement('div');
        name.className = 'script-panel-item-grid-name';
        name.textContent = normalizedPanelItemLabel(item);
        cell.appendChild(name);
      }
      grid.appendChild(cell);
    });
    wrap.appendChild(grid);
  }

  function buildButtonWidget(wrap, w, scriptId) {
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'script-panel-button variant-' + (w.variant || 'secondary');
    btn.disabled = w.enabled === false;
    var span = document.createElement('span');
    span.className = 'script-panel-text-target';
    span.textContent = String(w.label || w.id || 'Button');
    btn.appendChild(span);
    btn.addEventListener('click', function () { sendScriptPanelEvent(scriptId, w.id, 'click'); });
    wrap.appendChild(btn);
  }

  function buildToggleWidget(wrap, w, scriptId) {
    wrap.classList.add('script-panel-toggle');
    var label = document.createElement('span');
    label.className = 'script-panel-toggle-label script-panel-text-target';
    label.textContent = String(w.label || w.id || '');
    var switchEl = document.createElement('label');
    switchEl.className = 'script-panel-toggle-switch';
    var input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = !!w.value;
    input.disabled = w.enabled === false;
    var track = document.createElement('span');
    track.className = 'script-panel-toggle-track';
    switchEl.appendChild(input);
    switchEl.appendChild(track);
    input.addEventListener('change', function () { sendScriptPanelEvent(scriptId, w.id, 'change', !!input.checked); });
    wrap.appendChild(label);
    wrap.appendChild(switchEl);
  }

  function buildSliderWidget(wrap, w, scriptId) {
    var labelRow = document.createElement('div');
    labelRow.className = 'script-panel-slider-label';
    var labelSpan = document.createElement('span');
    labelSpan.className = 'script-panel-text-target';
    labelSpan.textContent = String(w.label || w.id || '');
    var valSpan = document.createElement('span');
    valSpan.className = 'script-panel-slider-value';
    valSpan.textContent = formatSliderValue(w.value, w.unit);
    labelRow.appendChild(labelSpan);
    labelRow.appendChild(valSpan);
    var input = document.createElement('input');
    input.type = 'range';
    input.className = 'script-panel-slider-input script-panel-input';
    input.min = String(w.min);
    input.max = String(w.max);
    input.step = String(w.step != null ? w.step : 1);
    input.value = String(w.value);
    input.disabled = w.enabled === false;
    if (w.unit) wrap.dataset.unit = String(w.unit);
    input.addEventListener('input', function () { valSpan.textContent = formatSliderValue(input.value, w.unit); });
    input.addEventListener('change', function () { sendScriptPanelEvent(scriptId, w.id, 'change', Number(input.value)); });
    wrap.appendChild(labelRow);
    wrap.appendChild(input);
  }

  function buildNumberWidget(wrap, w, scriptId) {
    var labelEl = document.createElement('div');
    labelEl.className = 'script-panel-number-label script-panel-text-target';
    labelEl.textContent = String(w.label || w.id || '');
    var input = document.createElement('input');
    input.type = 'number';
    input.className = 'script-panel-input';
    if (typeof w.min === 'number') input.min = String(w.min);
    if (typeof w.max === 'number') input.max = String(w.max);
    if (typeof w.step === 'number') input.step = String(w.step);
    input.value = String(w.value == null ? '' : w.value);
    input.disabled = w.enabled === false;
    input.addEventListener('change', function () {
      var num = Number(input.value);
      sendScriptPanelEvent(scriptId, w.id, 'change', Number.isFinite(num) ? num : 0);
    });
    wrap.appendChild(labelEl);
    wrap.appendChild(input);
  }

  function buildTextWidget(wrap, w, scriptId) {
    var labelEl = document.createElement('div');
    labelEl.className = 'script-panel-text-label script-panel-text-target';
    labelEl.textContent = String(w.label || w.id || '');
    var input = w.multiline ? document.createElement('textarea') : document.createElement('input');
    if (!w.multiline) input.type = 'text';
    input.className = 'script-panel-input';
    input.placeholder = String(w.placeholder || '');
    input.value = String(w.value == null ? '' : w.value);
    input.disabled = w.enabled === false;
    input.addEventListener('change', function () { sendScriptPanelEvent(scriptId, w.id, 'change', String(input.value)); });
    wrap.appendChild(labelEl);
    wrap.appendChild(input);
  }

  function buildSelectWidget(wrap, w, scriptId) {
    var labelEl = document.createElement('div');
    labelEl.className = 'script-panel-select-label script-panel-text-target';
    labelEl.textContent = String(w.label || w.id || '');
    var select = document.createElement('select');
    select.className = 'script-panel-input';
    select.disabled = w.enabled === false;
    (Array.isArray(w.options) ? w.options : []).forEach(function (opt) {
      if (!opt) return;
      var o = document.createElement('option');
      o.value = String(opt.value);
      o.textContent = String(opt.label != null ? opt.label : opt.value);
      if (String(opt.value) === String(w.value)) o.selected = true;
      select.appendChild(o);
    });
    select.addEventListener('change', function () { sendScriptPanelEvent(scriptId, w.id, 'change', String(select.value)); });
    wrap.appendChild(labelEl);
    wrap.appendChild(select);
  }

  function buildProgressWidget(wrap, w) {
    if (w.label) {
      var labelEl = document.createElement('div');
      labelEl.className = 'script-panel-text-label script-panel-text-target';
      labelEl.textContent = String(w.label);
      wrap.appendChild(labelEl);
    }
    var track = document.createElement('div');
    track.className = 'script-panel-progress-track';
    var fill = document.createElement('div');
    fill.className = 'script-panel-progress-fill';
    var pct = Math.max(0, Math.min(1, Number(w.value) || 0));
    fill.style.width = pct * 100 + '%';
    track.appendChild(fill);
    wrap.appendChild(track);
    if (w.caption) {
      var cap = document.createElement('div');
      cap.className = 'script-panel-progress-caption';
      cap.textContent = String(w.caption);
      wrap.appendChild(cap);
    }
  }

  function buildLogWidget(wrap, w) {
    var log = document.createElement('div');
    log.className = 'script-panel-log';
    var max = (typeof w.maxLines === 'number' && w.maxLines > 0) ? w.maxLines : 200;
    wrap.dataset.maxLines = String(max);
    var lines = Array.isArray(w.lines) ? w.lines.slice(-max) : [];
    if (!lines.length) {
      var empty = document.createElement('div');
      empty.className = 'script-panel-log-empty';
      empty.textContent = '(no log output yet)';
      log.appendChild(empty);
    } else {
      lines.forEach(function (l) {
        var line = document.createElement('div');
        line.textContent = String(l == null ? '' : l);
        log.appendChild(line);
      });
    }
    wrap.appendChild(log);
    setTimeout(function () { log.scrollTop = log.scrollHeight; }, 0);
  }

  function refreshScriptsDetailGuiButton() {
    var btn = document.getElementById('scripts-detail-open-gui');
    if (!btn) return;
    var id = scriptsPageSelectedId || '';
    var hasPanel = id && scriptPanels.has(String(id));
    btn.disabled = !hasPanel;
    btn.title = hasPanel
      ? 'Open the GUI this script registered via RealmEngine.ui.panel'
      : 'The selected script has not registered a GUI panel.';
    btn.dataset.scriptOpenGui = String(id || '');
  }

  function wireScriptPanelGlobals() {
    var popout = getScriptPanelEl();
    if (!popout || popout.dataset.wired) return;
    popout.dataset.wired = '1';
    var closeBtn = document.getElementById('script-panel-popout-close');
    if (closeBtn) closeBtn.addEventListener('click', function () { closeScriptPanelById(scriptPanelOpenId, { notifyServer: true }); });
    popout.addEventListener('click', function (e) {
      if (e.target === popout) closeScriptPanelById(scriptPanelOpenId, { notifyServer: true });
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && scriptPanelOpenId) closeScriptPanelById(scriptPanelOpenId, { notifyServer: true });
    });
  }
  wireScriptPanelGlobals();

  /** WebSocket `scriptsState` — same payload as GET /api/scripts; keeps activity text live */
  function applyScriptsStateFromSocket(msg) {
    if (!msg) return;
    scriptsTabLastData = {
      scripts: Array.isArray(msg.scripts) ? msg.scripts : [],
      dir: msg.dir !== undefined ? msg.dir : scriptsTabLastData.dir,
    };
    if (activeTab === 'scripts') renderScriptsListFromData(scriptsTabLastData);
    if (activeTab === 'home' && isMacMultiHome()) {
      connectedClients.forEach(function (_c, clientId) {
        patchMultiHomeConnectedCardDom(clientId);
      });
    }
    renderSingleAccountDock();
    if (isMacStyleSidebar() && multiAccountSidebarMode === 'connected') renderMultiAccountConnectedList();
    if (macPopoutOpenClientId) refreshMacPopoutScriptPanel(macPopoutOpenClientId);
  }

  function appendScriptLogLineLegacy(line, level) {
    var logEl = document.getElementById('scripts-log-output');
    if (!logEl) return;
    var lv = level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'info';
    var row = document.createElement('div');
    row.className = 'scripts-log-line scripts-log-line--' + lv;
    row.textContent = line;
    logEl.appendChild(row);
    logEl.scrollTop = logEl.scrollHeight;
  }

  function renderScriptsListFromDataLegacy(data) {
    var listEl = document.getElementById('scripts-list');
    var dirEl = document.getElementById('scripts-dir-display');
    if (dirEl) dirEl.textContent = (data && data.dir) ? String(data.dir) : '—';
    if (!listEl) return;
    listEl.innerHTML = '';
    var scripts = (data && Array.isArray(data.scripts)) ? data.scripts : [];
    if (!scripts.length) {
      var empty = document.createElement('div');
      empty.className = 'plugin-sidebar-empty';
      empty.textContent = 'No script packages found. Add a folder with realmengine.script.json and a .mjs entry.';
      listEl.appendChild(empty);
      return;
    }
    scripts.forEach(function (sc) {
      var row = document.createElement('div');
      row.className = 'plugin-sidebar-item scripts-row';
      row.setAttribute('data-script-id', String(sc.id || ''));
      var st = String(sc.status || 'idle');
      var isError = st === 'error';
      var badgeClass = st === 'running' ? 'scripts-badge scripts-badge-running' : isError ? 'scripts-badge scripts-badge-error' : 'scripts-badge scripts-badge-idle';
      var activityRaw =
        !isError && sc.activity != null && String(sc.activity).trim() ? String(sc.activity).trim() : '';
      var badgeText = activityRaw ? (activityRaw.length > 36 ? activityRaw.slice(0, 34) + '…' : activityRaw) : st;
      var developer = String(sc.developer || 'Unknown');
      var version = String(sc.version || 'Unknown');
      var entry = String(sc.entry || '');
      var error = String(sc.error || '');
      row.innerHTML =
        '<div class="scripts-row-main">' +
          '<span class="scripts-row-name">' + escapeHtml(String(sc.name || sc.id || '')) + '</span>' +
          '<span class="' + badgeClass + '">' + escapeHtml(badgeText) + '</span>' +
        '</div>' +
        '<div class="scripts-row-meta">' +
          '<span>Developer: ' + escapeHtml(developer) + '</span>' +
          '<span>Version: ' + escapeHtml(version) + '</span>' +
        '</div>' +
        (entry ? '<div class="scripts-row-entry">' + escapeHtml(entry) + '</div>' : '') +
        (error ? '<div class="scripts-row-error">' + escapeHtml(error) + '</div>' : '') +
        '<div class="scripts-row-actions">' +
          '<button type="button" class="setting-btn scripts-run-btn" data-script-run="' + escapeHtml(String(sc.id || '')) + '"' + (st === 'running' || isError ? ' disabled' : '') + '>Run</button>' +
          '<button type="button" class="setting-btn setting-btn-secondary scripts-stop-btn" data-script-stop="' + escapeHtml(String(sc.id || '')) + '"' + (st !== 'running' ? ' disabled' : '') + '>Stop</button>' +
        '</div>';
      listEl.appendChild(row);
    });
    listEl.querySelectorAll('[data-script-run]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var id = String(btn.getAttribute('data-script-run') || '');
        if (!id) return;
        fetch('/api/scripts/start', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: id }) })
          .then(function (r) { return r.json(); })
          .then(function () { refreshScriptsTab(); })
          .catch(function () {});
      });
    });
    listEl.querySelectorAll('[data-script-stop]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var id = String(btn.getAttribute('data-script-stop') || '');
        if (!id) return;
        fetch('/api/scripts/stop', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: id }) })
          .then(function (r) { return r.json(); })
          .then(function () { refreshScriptsTab(); })
          .catch(function () {});
      });
    });
  }

  function refreshScriptsTab() {
    fetch('/api/scripts')
      .then(function (r) { return r.json(); })
      .then(function (data) {
        scriptsTabLastData = data || { scripts: [], dir: null };
        renderScriptsListFromData(scriptsTabLastData);
        populateScriptSelect();
        if (isMacStyleSidebar() && multiAccountSidebarMode === 'connected') renderMultiAccountConnectedList();
        if (macPopoutOpenClientId) refreshMacPopoutScriptPanel(macPopoutOpenClientId);
      })
      .catch(function () {
        renderScriptsListFromData({ scripts: [], dir: null });
      });
  }

  // ── Marketplace Scripts (runtime delivery) ────────────────────────────────

  function normalizeScriptStatus(sc) {
    var st = String(sc && sc.status ? sc.status : 'idle').toLowerCase();
    if (st === 'running' || st === 'error') return st;
    return 'idle';
  }

  function getScriptDisplayName(sc) {
    return String((sc && (sc.name || sc.id)) || 'Unknown script');
  }

  function getScriptBadgeClass(status) {
    if (status === 'running') return 'scripts-badge scripts-badge-running';
    if (status === 'error') return 'scripts-badge scripts-badge-error';
    return 'scripts-badge scripts-badge-idle';
  }

  function getScriptBadgeText(sc) {
    var status = normalizeScriptStatus(sc);
    var activity = status !== 'error' && sc && sc.activity != null ? String(sc.activity).trim() : '';
    if (activity) return activity.length > 34 ? activity.slice(0, 32) + '..' : activity;
    return status;
  }

  function getScriptStartedAtMs(sc) {
    var raw = sc && sc.startedAt;
    if (raw == null || raw === '') return 0;
    if (typeof raw === 'number') return Number.isFinite(raw) && raw > 0 ? raw : 0;
    var numeric = Number(raw);
    if (Number.isFinite(numeric) && numeric > 0) return numeric;
    var parsed = Date.parse(String(raw));
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
  }

  function getScriptRuntimeMs(sc) {
    if (!sc) return 0;
    var status = normalizeScriptStatus(sc);
    var startedAt = getScriptStartedAtMs(sc);
    if (status === 'running' && startedAt) return Math.max(0, Date.now() - startedAt);
    var runtimeMs = Number(sc.runtimeMs || 0);
    return Number.isFinite(runtimeMs) && runtimeMs > 0 ? runtimeMs : 0;
  }

  function updateScriptsDetailRuntime() {
    if (activeTab !== 'scripts') return;
    var runtimeEl = document.getElementById('scripts-detail-runtime');
    if (!runtimeEl) return;
    var id = String(runtimeEl.dataset.scriptRuntimeId || '');
    var scripts = Array.isArray(scriptsTabLastData && scriptsTabLastData.scripts) ? scriptsTabLastData.scripts : [];
    var sc = scripts.find(function (row) { return String(row && row.id || '') === id; });
    if (!sc) return;
    runtimeEl.textContent = formatHomeDuration(getScriptRuntimeMs(sc));
  }

  function hasConnectedAccountForScripts() {
    return !!gameConnected || (connectedClients && connectedClients.size > 0);
  }

  function getFilteredScripts(data) {
    var scripts = (data && Array.isArray(data.scripts)) ? data.scripts.slice() : [];
    var query = scriptsPageSearch.trim().toLowerCase();
    scripts = scripts.filter(function (sc) {
      var status = normalizeScriptStatus(sc);
      if (scriptsPageStatusFilter !== 'all' && status !== scriptsPageStatusFilter) return false;
      if (!query) return true;
      return [
        sc && sc.id,
        sc && sc.name,
        sc && sc.developer,
        sc && sc.version,
        sc && sc.entry,
        sc && sc.activity,
        sc && sc.error,
      ].some(function (part) {
        return String(part || '').toLowerCase().indexOf(query) !== -1;
      });
    });
    scripts.sort(function (a, b) {
      if (scriptsPageSort === 'developer') return String(a.developer || '').localeCompare(String(b.developer || ''));
      if (scriptsPageSort === 'status') return normalizeScriptStatus(a).localeCompare(normalizeScriptStatus(b)) || getScriptDisplayName(a).localeCompare(getScriptDisplayName(b));
      if (scriptsPageSort === 'updated') return String(b.id || '').localeCompare(String(a.id || ''));
      return getScriptDisplayName(a).localeCompare(getScriptDisplayName(b));
    });
    return scripts;
  }

  function getSelectedScriptFromData(data) {
    var scripts = (data && Array.isArray(data.scripts)) ? data.scripts : [];
    if (scriptsPageSelectedId) {
      var found = scripts.find(function (sc) { return String(sc.id || '') === scriptsPageSelectedId; });
      if (found) return found;
    }
    var firstRunning = scripts.find(function (sc) { return normalizeScriptStatus(sc) === 'running'; });
    return firstRunning || scripts[0] || null;
  }

  function getRunningScriptForLog() {
    var scripts = Array.isArray(scriptsTabLastData && scriptsTabLastData.scripts) ? scriptsTabLastData.scripts : [];
    if (scriptsPageSelectedId) {
      var selectedRunning = scripts.find(function (sc) {
        return String(sc.id || '') === scriptsPageSelectedId && normalizeScriptStatus(sc) === 'running';
      });
      if (selectedRunning) return selectedRunning;
    }
    return scripts.find(function (sc) { return normalizeScriptStatus(sc) === 'running'; }) || null;
  }

  function requestScriptStart(id) {
    if (!id) return;
    if (!hasConnectedAccountForScripts()) {
      appendScriptLogLine('Connect an account before starting scripts.', 'warn', id);
      surfaceScriptStartError(id, 'Connect an account before starting scripts.');
      renderScriptsListFromData(scriptsTabLastData);
      return;
    }
    fetch('/api/scripts/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: id })
    })
      .then(function (r) { return r.json(); })
      .then(function (result) {
        if (result && result.ok === false && result.error) {
          appendScriptLogLine(String(result.error), 'error', id);
          surfaceScriptStartError(id, String(result.error));
        } else {
          clearScriptStartError(id);
        }
        refreshScriptsTab();
      })
      .catch(function (err) {
        var msg = String(err && err.message ? err.message : err);
        appendScriptLogLine(msg, 'error', id);
        surfaceScriptStartError(id, msg);
      });
  }

  // Render failed-start errors inline in the scripts detail panel — the
  // SDK log only shows lines for a currently-running script, so without
  // this the error from the /api/scripts/start response is swallowed.
  var scriptStartErrorsById = new Map();
  function surfaceScriptStartError(id, message) {
    if (!id) return;
    scriptStartErrorsById.set(String(id), { message: String(message || ''), at: Date.now() });
    paintScriptStartErrorBanner();
    try { console.error('Script start failed [' + id + ']:', message); } catch (_e) {}
  }
  function clearScriptStartError(id) {
    if (!id) return;
    if (scriptStartErrorsById.delete(String(id))) paintScriptStartErrorBanner();
  }
  function paintScriptStartErrorBanner() {
    var bodyEl = document.getElementById('scripts-detail-body');
    if (!bodyEl) return;
    var existing = bodyEl.querySelector('.scripts-detail-start-error');
    var id = scriptsPageSelectedId || '';
    var entry = id ? scriptStartErrorsById.get(String(id)) : null;
    if (!entry) {
      if (existing) existing.remove();
      return;
    }
    if (!existing) {
      existing = document.createElement('div');
      existing.className = 'scripts-detail-error scripts-detail-start-error';
      bodyEl.appendChild(existing);
    }
    existing.textContent = 'Failed to start: ' + entry.message;
  }

  function requestScriptStop(id) {
    if (!id) return;
    fetch('/api/scripts/stop', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: id })
    })
      .then(function (r) { return r.json(); })
      .then(function (result) {
        if (result && result.ok === false && result.error) appendScriptLogLine(String(result.error), 'warn', id);
        refreshScriptsTab();
      })
      .catch(function (err) { appendScriptLogLine(String(err && err.message ? err.message : err), 'error', id); });
  }

  function requestOpenScriptsFolder() {
    fetch('/api/scripts/open-folder', { method: 'POST' })
      .then(function (r) { return r.json(); })
      .then(function (result) {
        if (result && result.ok === false && result.error) {
          appendScriptLogLine(String(result.error), 'warn', scriptsPageSelectedId || '');
        }
      })
      .catch(function (err) {
        appendScriptLogLine(String(err && err.message ? err.message : err), 'error', scriptsPageSelectedId || '');
      });
  }

  function renderScriptsDetail(sc) {
    var titleEl = document.getElementById('scripts-detail-title');
    var subEl = document.getElementById('scripts-detail-sub');
    var statusEl = document.getElementById('scripts-detail-status');
    var bodyEl = document.getElementById('scripts-detail-body');
    var runBtn = document.getElementById('scripts-detail-run');
    var pauseBtn = document.getElementById('scripts-detail-pause');
    var stopBtn = document.getElementById('scripts-detail-stop');
    if (!titleEl || !bodyEl) return;

    if (!sc) {
      titleEl.textContent = 'Select a script';
      if (subEl) subEl.textContent = 'Local packages run through ScriptHost in the proxy process.';
      if (statusEl) {
        statusEl.className = 'scripts-badge scripts-badge-idle';
        statusEl.textContent = 'Idle';
      }
      bodyEl.innerHTML = '<div class="scripts-detail-empty">Select a local script to inspect its manifest, current activity, and controls.</div>';
      if (runBtn) {
        runBtn.disabled = true;
        runBtn.title = '';
      }
      if (pauseBtn) pauseBtn.disabled = true;
      if (stopBtn) stopBtn.disabled = true;
      refreshScriptsDetailGuiButton();
      return;
    }

    var id = String(sc.id || '');
    var status = normalizeScriptStatus(sc);
    var isError = status === 'error';
    var canStartScript = hasConnectedAccountForScripts();
    titleEl.textContent = getScriptDisplayName(sc);
    if (subEl) subEl.textContent = id ? id : 'Local script package';
    if (statusEl) {
      statusEl.className = getScriptBadgeClass(status);
      statusEl.textContent = getScriptBadgeText(sc);
    }
    var meta = [
      sc.developer ? 'by ' + String(sc.developer) : '',
      sc.version ? 'v' + String(sc.version) : '',
      sc.entry ? String(sc.entry) : '',
    ].filter(Boolean).join(' · ');
    var activity = sc.activity || (status === 'running' ? 'Running' : '');
    var runtime = formatHomeDuration(getScriptRuntimeMs(sc));
    bodyEl.innerHTML =
      '<div class="scripts-detail-summary">' +
        (meta ? '<div class="scripts-detail-meta">' + escapeHtml(meta) + '</div>' : '') +
        '<div class="scripts-detail-stats">' +
          '<span>Status <strong>' + escapeHtml(status) + '</strong></span>' +
          '<span>Runtime <strong id="scripts-detail-runtime" data-script-runtime-id="' + escapeHtml(id) + '">' + escapeHtml(runtime) + '</strong></span>' +
        '</div>' +
        (activity ? '<div class="scripts-detail-activity">' + escapeHtml(String(activity)) + '</div>' : '') +
      '</div>' +
      (sc.error ? '<div class="scripts-detail-error">' + escapeHtml(String(sc.error)) + '</div>' : '');
    if (runBtn) {
      runBtn.disabled = !id || !canStartScript || status === 'running' || isError;
      runBtn.title = canStartScript ? '' : 'Connect an account before starting scripts.';
      runBtn.dataset.scriptRun = id;
    }
    if (pauseBtn) {
      pauseBtn.disabled = true;
      pauseBtn.dataset.scriptPause = id;
    }
    if (stopBtn) {
      stopBtn.disabled = !id || status !== 'running';
      stopBtn.dataset.scriptStop = id;
    }
    refreshScriptsDetailGuiButton();
    paintScriptStartErrorBanner();
  }

  function renderScriptsLogScriptOptions() {
    var select = document.getElementById('scripts-log-script');
    if (!select) return;
    var current = scriptsLogScriptFilter || 'all';
    var ids = new Set();
    (scriptsTabLastData.scripts || []).forEach(function (sc) { if (sc && sc.id) ids.add(String(sc.id)); });
    scriptsLogBuffer.forEach(function (entry) { if (entry.id) ids.add(String(entry.id)); });
    var html = '<option value="all">All scripts</option>' + Array.from(ids).sort().map(function (id) {
      return '<option value="' + escapeHtml(id) + '"' + (id === current ? ' selected' : '') + '>' + escapeHtml(id) + '</option>';
    }).join('');
    select.innerHTML = html;
    if (current !== 'all' && !ids.has(current)) {
      scriptsLogScriptFilter = 'all';
      select.value = 'all';
    }
  }

  function renderScriptsLog() {
    var logEl = document.getElementById('scripts-log-output');
    if (!logEl) return;
    renderScriptsLogScriptOptions();
    logEl.innerHTML = '';
    var runningScript = getRunningScriptForLog();
    var runningId = runningScript ? String(runningScript.id || '') : '';
    if (!runningId) {
      var noRunning = document.createElement('div');
      noRunning.className = 'scripts-log-empty';
      noRunning.textContent = 'Start a script to see its SDK log here.';
      logEl.appendChild(noRunning);
      return;
    }
    var query = scriptsLogSearch.trim().toLowerCase();
    var rows = scriptsLogBuffer.filter(function (entry) {
      if (entry.id !== runningId) return false;
      if (scriptsLogLevelFilter !== 'all' && entry.level !== scriptsLogLevelFilter) return false;
      if (scriptsLogScriptFilter !== 'all' && entry.id !== scriptsLogScriptFilter) return false;
      if (!query) return true;
      return String(entry.line || '').toLowerCase().indexOf(query) !== -1 || String(entry.id || '').toLowerCase().indexOf(query) !== -1;
    });
    if (!rows.length) {
      var empty = document.createElement('div');
      empty.className = 'scripts-log-empty';
      empty.textContent = 'No log output yet for ' + getScriptDisplayName(runningScript) + '.';
      logEl.appendChild(empty);
      return;
    }
    rows.slice(-500).forEach(function (entry) {
      var row = document.createElement('div');
      row.className = 'scripts-log-line scripts-log-line--' + entry.level;
      row.innerHTML =
        '<span class="scripts-log-time">' + escapeHtml(entry.time) + '</span>' +
        (entry.id ? '<span class="scripts-log-id">[' + escapeHtml(entry.id) + ']</span>' : '') +
        '<span class="scripts-log-text">' + escapeHtml(entry.line) + '</span>';
      logEl.appendChild(row);
    });
    if (scriptsLogAutoScroll) logEl.scrollTop = logEl.scrollHeight;
  }

  function inferScriptIdFromLog(line) {
    var match = String(line || '').match(/^\[([^\]]+)\]/);
    return match ? match[1] : '';
  }

  function appendScriptLogLine(line, level, id) {
    var lv = level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'info';
    scriptsLogBuffer.push({
      id: String(id || inferScriptIdFromLog(line) || ''),
      line: String(line || ''),
      level: lv,
      time: new Date().toLocaleTimeString(),
    });
    if (scriptsLogBuffer.length > 1000) scriptsLogBuffer.splice(0, scriptsLogBuffer.length - 1000);
    if (!scriptsLogPaused) renderScriptsLog();
  }

  function wireScriptsPageControls() {
    var hub = document.getElementById('scripts-hub');
    if (!hub || hub.dataset.wired) return;
    hub.dataset.wired = '1';

    var refreshBtn = document.getElementById('scripts-refresh-btn');
    if (refreshBtn) refreshBtn.addEventListener('click', function () { refreshScriptsTab(); });
    var openFolderBtn = document.getElementById('scripts-open-folder-btn');
    if (openFolderBtn) openFolderBtn.addEventListener('click', requestOpenScriptsFolder);
    var searchEl = document.getElementById('scripts-search');
    if (searchEl) searchEl.addEventListener('input', function () { scriptsPageSearch = searchEl.value || ''; renderScriptsListFromData(scriptsTabLastData); });
    var sortEl = document.getElementById('scripts-sort');
    if (sortEl) sortEl.addEventListener('change', function () { scriptsPageSort = sortEl.value || 'name'; renderScriptsListFromData(scriptsTabLastData); });
    var statusEl = document.getElementById('scripts-status-filter');
    if (statusEl) statusEl.addEventListener('change', function () { scriptsPageStatusFilter = statusEl.value || 'all'; renderScriptsListFromData(scriptsTabLastData); });

    var detailRun = document.getElementById('scripts-detail-run');
    if (detailRun) detailRun.addEventListener('click', function () { requestScriptStart(String(detailRun.dataset.scriptRun || scriptsPageSelectedId || '')); });
    var detailStop = document.getElementById('scripts-detail-stop');
    if (detailStop) detailStop.addEventListener('click', function () { requestScriptStop(String(detailStop.dataset.scriptStop || scriptsPageSelectedId || '')); });
    var detailReload = document.getElementById('scripts-detail-reload');
    if (detailReload) detailReload.addEventListener('click', function () { refreshScriptsTab(); });
    var detailOpenGui = document.getElementById('scripts-detail-open-gui');
    if (detailOpenGui) detailOpenGui.addEventListener('click', function () {
      var id = String(detailOpenGui.dataset.scriptOpenGui || scriptsPageSelectedId || '');
      openScriptPanelById(id);
    });

    var levelEl = document.getElementById('scripts-log-level');
    if (levelEl) levelEl.addEventListener('change', function () { scriptsLogLevelFilter = levelEl.value || 'all'; renderScriptsLog(); });
    var scriptEl = document.getElementById('scripts-log-script');
    if (scriptEl) scriptEl.addEventListener('change', function () { scriptsLogScriptFilter = scriptEl.value || 'all'; renderScriptsLog(); });
    var logSearchEl = document.getElementById('scripts-log-search');
    if (logSearchEl) logSearchEl.addEventListener('input', function () { scriptsLogSearch = logSearchEl.value || ''; renderScriptsLog(); });
    var autoEl = document.getElementById('scripts-log-autoscroll');
    if (autoEl) autoEl.addEventListener('change', function () { scriptsLogAutoScroll = autoEl.checked; renderScriptsLog(); });
    var pauseEl = document.getElementById('scripts-log-paused');
    if (pauseEl) pauseEl.addEventListener('change', function () { scriptsLogPaused = pauseEl.checked; if (!scriptsLogPaused) renderScriptsLog(); });
    var clearBtn = document.getElementById('scripts-log-clear');
    if (clearBtn) clearBtn.addEventListener('click', function () { scriptsLogBuffer = []; renderScriptsLog(); });
    var copyBtn = document.getElementById('scripts-log-copy');
    if (copyBtn) copyBtn.addEventListener('click', function () {
      var text = scriptsLogBuffer.map(function (entry) {
        return entry.time + ' ' + (entry.id ? '[' + entry.id + '] ' : '') + entry.level.toUpperCase() + ' ' + entry.line;
      }).join('\n');
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).catch(function () {});
    });
  }

  function renderScriptsListFromData(data) {
    var listEl = document.getElementById('scripts-list');
    var dirEl = document.getElementById('scripts-dir-display');
    if (dirEl) dirEl.textContent = (data && data.dir) ? String(data.dir) : '-';
    if (!listEl) return;
    listEl.innerHTML = '';
    var scripts = (data && Array.isArray(data.scripts)) ? data.scripts : [];
    var selected = getSelectedScriptFromData(data);
    scriptsPageSelectedId = selected ? String(selected.id || '') : null;
    var filtered = getFilteredScripts(data);
    if (!scripts.length) {
      listEl.innerHTML = '<div class="plugin-sidebar-empty">No script packages found. Add a folder with realmengine.script.json and a .mjs entry.</div>';
      renderScriptsDetail(null);
      renderScriptsLogScriptOptions();
      renderScriptsLog();
      return;
    }
    if (!filtered.length) {
      listEl.innerHTML = '<div class="plugin-sidebar-empty">No scripts match the current filters.</div>';
      renderScriptsDetail(selected);
      renderScriptsLogScriptOptions();
      renderScriptsLog();
      return;
    }
    filtered.forEach(function (sc) {
      var id = String(sc.id || '');
      var status = normalizeScriptStatus(sc);
      var isSelected = id && id === scriptsPageSelectedId;
      var row = document.createElement('button');
      row.type = 'button';
      row.className = 'plugin-sidebar-item scripts-row scripts-row-select' + (isSelected ? ' active' : '');
      row.setAttribute('data-script-id', id);
      var error = String(sc.error || '');
      var meta = [
        sc.developer ? 'by ' + String(sc.developer) : '',
        sc.version ? 'v' + String(sc.version) : '',
        sc.entry ? String(sc.entry) : '',
      ].filter(Boolean).join(' · ');
      row.innerHTML =
        '<div class="scripts-row-main">' +
          '<span class="scripts-row-name">' + escapeHtml(getScriptDisplayName(sc)) + '</span>' +
          '<span class="' + getScriptBadgeClass(status) + '">' + escapeHtml(getScriptBadgeText(sc)) + '</span>' +
        '</div>' +
        (meta ? '<div class="scripts-row-meta">' + escapeHtml(meta) + '</div>' : '') +
        (error ? '<div class="scripts-row-error">' + escapeHtml(error) + '</div>' : '');
      row.addEventListener('click', function (event) {
        scriptsPageSelectedId = id;
        renderScriptsListFromData(scriptsTabLastData);
      });
      listEl.appendChild(row);
    });
    renderScriptsDetail(selected);
    renderScriptsLogScriptOptions();
    renderScriptsLog();
  }

  setInterval(updateScriptsDetailRuntime, 1000);

  var marketplaceScriptsPending = {};  // scriptId -> true while loading

  function refreshMarketplaceScripts() {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'getOwnedScripts' }));
    }
  }

  function renderMarketplaceScripts(scripts) {
    var listEl = document.getElementById('marketplace-scripts-list');
    if (!listEl) return;
    listEl.innerHTML = '';

    if (!scripts.length) {
      var empty = document.createElement('div');
      empty.className = 'plugin-sidebar-empty';
      empty.textContent = 'No purchased scripts. Buy scripts from the marketplace.';
      listEl.appendChild(empty);
      return;
    }

    scripts.forEach(function (sc) {
      var scriptId = String(sc.script_id || sc.id || '');
      var name = String(sc.script_name || scriptId);
      var running = sc.running === true;
      var cached = sc.cached === true;
      var pending = !!marketplaceScriptsPending[scriptId];
      var expires = sc.expires_at ? new Date(sc.expires_at).toLocaleDateString() : 'Lifetime';

      var row = document.createElement('div');
      row.className = 'plugin-sidebar-item scripts-row';
      row.setAttribute('data-mscript-id', scriptId);

      var badgeText = running ? 'running' : pending ? 'loading…' : 'idle';
      var badgeClass = running ? 'scripts-badge-running' : pending ? 'scripts-badge-loading' : 'scripts-badge-idle';

      row.innerHTML =
        '<div class="scripts-row-main">' +
          '<span class="scripts-row-name">' + escapeHtml(name) + '</span>' +
          '<span class="scripts-badge ' + badgeClass + '">' + badgeText + '</span>' +
        '</div>' +
        '<div class="scripts-row-meta">' +
          '<span>Expires: ' + escapeHtml(expires) + '</span>' +
          (cached ? '<span style="color:#4ade80;font-size:11px">cached</span>' : '') +
        '</div>' +
        '<div class="scripts-row-actions">' +
          '<button type="button" class="setting-btn scripts-run-btn" data-mscript-run="' + escapeHtml(scriptId) + '" data-mscript-name="' + escapeHtml(name) + '"' + (running || pending ? ' disabled' : '') + '>Run</button>' +
          '<button type="button" class="setting-btn setting-btn-secondary scripts-stop-btn" data-mscript-stop="' + escapeHtml(scriptId) + '"' + (!running ? ' disabled' : '') + '>Stop</button>' +
        '</div>';

      listEl.appendChild(row);
    });

    listEl.querySelectorAll('[data-mscript-run]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var scriptId = String(btn.getAttribute('data-mscript-run') || '');
        var scriptName = String(btn.getAttribute('data-mscript-name') || scriptId);
        if (!scriptId || !ws || ws.readyState !== WebSocket.OPEN) return;
        marketplaceScriptsPending[scriptId] = true;
        btn.disabled = true;
        ws.send(JSON.stringify({ type: 'runMarketplaceScript', scriptId: scriptId, scriptName: scriptName }));
        // Refresh to show loading state
        refreshMarketplaceScripts();
      });
    });

    listEl.querySelectorAll('[data-mscript-stop]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var scriptId = String(btn.getAttribute('data-mscript-stop') || '');
        if (!scriptId || !ws || ws.readyState !== WebSocket.OPEN) return;
        ws.send(JSON.stringify({ type: 'stopMarketplaceScript', scriptId: scriptId }));
        refreshMarketplaceScripts();
      });
    });
  }

  function handleMarketplaceScriptResult(msg) {
    var scriptId = String(msg.scriptId || '');
    delete marketplaceScriptsPending[scriptId];
    if (!msg.ok && msg.error && !msg.stopped) {
      var toast = document.createElement('div');
      toast.className = 'gem-toast';
      toast.textContent = 'Script error: ' + String(msg.error);
      document.body.appendChild(toast);
      setTimeout(function () { if (toast.parentNode) toast.remove(); }, 4500);
    }
    // Refresh to show updated running state
    refreshMarketplaceScripts();
  }

  // Rate-limited script submission helpers (client-side)
  function getSubmitCountToday() {
    var today = new Date().toISOString().slice(0, 10);
    return parseInt(localStorage.getItem('script_submits_' + today) || '0', 10);
  }

  function incrementSubmitCountToday() {
    var today = new Date().toISOString().slice(0, 10);
    var key = 'script_submits_' + today;
    localStorage.setItem(key, String(parseInt(localStorage.getItem(key) || '0', 10) + 1));
  }

  function handleMarketplaceScriptSubmit(formEl, statusEl) {
    if (getSubmitCountToday() >= 3) {
      statusEl.textContent = 'Daily submission limit reached (3 per day). Try again tomorrow.';
      statusEl.style.color = '#f87171';
      return;
    }

    var nameEl = formEl.querySelector('[name="script_name"]');
    var descEl = formEl.querySelector('[name="script_description"]');
    var categoryEl = formEl.querySelector('[name="script_category"]');
    var priceTypeEl = formEl.querySelector('[name="script_price_type"]');
    var gemCostEl = formEl.querySelector('[name="script_gem_cost"]');
    var fileEl = formEl.querySelector('[name="script_file"]');

    if (!fileEl || !fileEl.files || !fileEl.files[0]) {
      statusEl.textContent = 'Select a .mjs file to upload.';
      statusEl.style.color = '#f87171';
      return;
    }

    var file = fileEl.files[0];
    if (!file.name.endsWith('.mjs')) {
      statusEl.textContent = 'Only .mjs files are accepted.';
      statusEl.style.color = '#f87171';
      return;
    }

    var formData = new FormData();
    formData.append('name', nameEl ? nameEl.value.trim() : '');
    formData.append('description', descEl ? descEl.value.trim() : '');
    formData.append('category', categoryEl ? categoryEl.value : '');
    formData.append('price_type', priceTypeEl ? priceTypeEl.value : 'free');
    formData.append('gem_cost', gemCostEl ? gemCostEl.value : '0');
    formData.append('file', file);

    // Read token from bot API session
    var submitBtn = formEl.querySelector('[type="submit"]');
    if (submitBtn) submitBtn.disabled = true;
    statusEl.textContent = 'Uploading…';
    statusEl.style.color = '';

    // We need the JWT — request it via WS then do the upload
    // For now use the global dashboardToken if available, or the plugin login token
    var token = window._botApiToken || '';
    if (!token) {
      statusEl.textContent = 'Log in to the Bot API first.';
      statusEl.style.color = '#f87171';
      if (submitBtn) submitBtn.disabled = false;
      return;
    }

    var botApiUrl = (window._botApiUrl || '').replace(/\/+$/, '');
    fetch((botApiUrl || '') + '/api/marketplace/scripts/upload', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + token },
      body: formData,
    })
    .then(function (r) {
      return r.json().then(function (d) { return { ok: r.ok, data: d }; });
    })
    .then(function (result) {
      if (result.ok) {
        incrementSubmitCountToday();
        statusEl.textContent = 'Script submitted! It will be reviewed before going live.';
        statusEl.style.color = '#4ade80';
        formEl.reset();
      } else {
        statusEl.textContent = result.data.detail || 'Upload failed';
        statusEl.style.color = '#f87171';
      }
    })
    .catch(function (e) {
      statusEl.textContent = 'Upload error: ' + e.message;
      statusEl.style.color = '#f87171';
    })
    .finally(function () {
      if (submitBtn) submitBtn.disabled = false;
    });
  }

  // Wire up script submission form
  (function () {
    var form = document.getElementById('marketplace-submit-form');
    var status = document.getElementById('marketplace-submit-status');
    if (!form || !status) return;
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      handleMarketplaceScriptSubmit(form, status);
    });
    // Show remaining submissions today
    var remaining = document.getElementById('marketplace-submit-remaining');
    if (remaining) {
      remaining.textContent = String(3 - getSubmitCountToday()) + ' submissions remaining today';
    }
  })();

  function handlePluginToggleError(msg) {
    var toast = document.createElement('div');
    toast.className = 'gem-toast';
    if (msg.requiredPlan) {
      var planDisplay = String(msg.requiredPlan).charAt(0).toUpperCase() + String(msg.requiredPlan).slice(1);
      toast.innerHTML =
        '<span>' + (msg.reason || ('Requires ' + planDisplay + ' plan')) + '</span>' +
        '<button class="gem-toast-action">Manage Plan</button>';
      var actionBtn = toast.querySelector('.gem-toast-action');
      if (actionBtn) {
        actionBtn.addEventListener('click', function () { toast.remove(); openPlanModal(); });
      }
    } else {
      toast.textContent = msg.reason || 'Cannot enable plugin';
    }
    document.body.appendChild(toast);
    setTimeout(function () { if (toast.parentNode) toast.remove(); }, 4500);
  }

  // ── Home layout edit mode (drag-to-reorder, add/remove cards) ──
  (function homeEditMode() {
    var STORAGE_KEY = 'home-layout-order';
    var HIDDEN_KEY = 'home-layout-hidden';
    var layout = document.getElementById('home-connected-layout');
    var editBtn = document.getElementById('home-edit-btn');
    var editActions = document.getElementById('home-edit-actions');
    var saveBtn = document.getElementById('home-edit-save');
    var cancelBtn = document.getElementById('home-edit-cancel');
    if (!layout || !editBtn) return;

    var editing = false;
    var dragEl = null;
    var addCardEl = null;
    var savedSnapshot = null;

    function cardLabel(card) {
      var title = card.querySelector('.home-card-title');
      return title ? title.textContent.trim() : (card.getAttribute('data-card-id') || 'this card');
    }

    // ── Persist / restore order ──
    function saveOrder() {
      var cards = layout.querySelectorAll('.home-card[data-card-id]');
      var order = [];
      for (var i = 0; i < cards.length; i++) order.push(cards[i].getAttribute('data-card-id'));
      try { localStorage.setItem(STORAGE_KEY, JSON.stringify(order)); } catch (e) {}
    }

    function saveHidden(ids) {
      try { localStorage.setItem(HIDDEN_KEY, JSON.stringify(ids)); } catch (e) {}
    }

    function getHidden() {
      try { var v = localStorage.getItem(HIDDEN_KEY); return v ? JSON.parse(v) : []; } catch (e) { return []; }
    }

    function restoreOrder() {
      try {
        var raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return;
        var order = JSON.parse(raw);
        if (!Array.isArray(order)) return;
        var hidden = getHidden();
        for (var i = order.length - 1; i >= 0; i--) {
          var card = layout.querySelector('.home-card[data-card-id="' + order[i] + '"]');
          if (card) {
            if (hidden.indexOf(order[i]) !== -1) {
              card.style.display = 'none';
              card.setAttribute('data-card-hidden', '1');
            }
            layout.insertBefore(card, layout.firstChild);
          }
        }
      } catch (e) {}
    }

    // ── Inject / remove per-card remove buttons ──
    function injectRemoveButtons() {
      var cards = layout.querySelectorAll('.home-card[data-card-id]');
      for (var i = 0; i < cards.length; i++) {
        if (cards[i].querySelector('.home-card-remove-btn')) continue;
        var btn = document.createElement('button');
        btn.className = 'home-card-remove-btn';
        btn.type = 'button';
        btn.title = 'Remove card';
        btn.innerHTML = '&#10005;';
        btn.setAttribute('data-remove-target', cards[i].getAttribute('data-card-id'));
        cards[i].insertBefore(btn, cards[i].firstChild);
      }
    }

    function removeRemoveButtons() {
      var btns = layout.querySelectorAll('.home-card-remove-btn');
      for (var i = 0; i < btns.length; i++) btns[i].remove();
    }

    // ── Add-card placeholder ──
    function createAddCard() {
      if (addCardEl) return;
      addCardEl = document.createElement('div');
      addCardEl.className = 'home-card-add';
      addCardEl.title = 'Add a card';
      addCardEl.innerHTML = '+';
      addCardEl.addEventListener('click', function () {
        openAddModal();
      });
      layout.appendChild(addCardEl);
    }

    function removeAddCard() {
      if (addCardEl) { addCardEl.remove(); addCardEl = null; }
    }

    // ── Add-card picker modal ──
    var addModal = document.getElementById('home-add-modal');
    var addModalList = document.getElementById('home-add-modal-list');
    var addModalCloseBtn = document.getElementById('home-add-modal-close');

    function openAddModal() {
      if (!addModal || !addModalList) return;
      addModalList.innerHTML = '';
      var hidden = layout.querySelectorAll('.home-card[data-card-hidden="1"]');
      if (!hidden.length) {
        addModalList.innerHTML = '<div class="home-add-modal-empty">No cards available to add.</div>';
      } else {
        for (var i = 0; i < hidden.length; i++) {
          var card = hidden[i];
          var id = card.getAttribute('data-card-id');
          var label = cardLabel(card);
          var item = document.createElement('div');
          item.className = 'home-add-modal-item';
          item.setAttribute('data-add-card-id', id);
          item.innerHTML = '<span class="home-add-modal-item-name">' + label + '</span><span class="home-add-modal-item-add">+ Add</span>';
          addModalList.appendChild(item);
        }
      }
      addModal.classList.remove('hidden');
      addModal.setAttribute('aria-hidden', 'false');
    }

    function closeAddModal() {
      if (addModal) { addModal.classList.add('hidden'); addModal.setAttribute('aria-hidden', 'true'); }
    }

    if (addModalList) addModalList.addEventListener('click', function (e) {
      var item = e.target.closest('.home-add-modal-item');
      if (!item) return;
      var cardId = item.getAttribute('data-add-card-id');
      var card = layout.querySelector('.home-card[data-card-id="' + cardId + '"]');
      if (card) {
        card.style.display = '';
        card.style.opacity = '0.45';
        card.removeAttribute('data-card-hidden');
      }
      item.remove();
      // If list is now empty, show empty message
      if (!addModalList.querySelector('.home-add-modal-item')) {
        addModalList.innerHTML = '<div class="home-add-modal-empty">No cards available to add.</div>';
      }
    });

    if (addModalCloseBtn) addModalCloseBtn.addEventListener('click', closeAddModal);
    if (addModal) {
      var addBackdrop = addModal.querySelector('.home-add-modal-backdrop');
      if (addBackdrop) addBackdrop.addEventListener('click', closeAddModal);
    }

    // ── Remove-confirm modal ──
    var removeModal = document.getElementById('home-remove-modal');
    var removeNameEl = document.getElementById('home-remove-card-name');
    var removeConfirmBtn = document.getElementById('home-remove-confirm');
    var removeCancelBtn = document.getElementById('home-remove-cancel');
    var pendingRemoveId = null;

    function openRemoveModal(cardId, label) {
      pendingRemoveId = cardId;
      if (removeNameEl) removeNameEl.textContent = label;
      if (removeModal) { removeModal.classList.remove('hidden'); removeModal.setAttribute('aria-hidden', 'false'); }
    }

    function closeRemoveModal() {
      pendingRemoveId = null;
      if (removeModal) { removeModal.classList.add('hidden'); removeModal.setAttribute('aria-hidden', 'true'); }
    }

    if (removeConfirmBtn) removeConfirmBtn.addEventListener('click', function () {
      if (!pendingRemoveId) return;
      var card = layout.querySelector('.home-card[data-card-id="' + pendingRemoveId + '"]');
      if (card) {
        card.style.display = 'none';
        card.setAttribute('data-card-hidden', '1');
      }
      closeRemoveModal();
    });

    if (removeCancelBtn) removeCancelBtn.addEventListener('click', closeRemoveModal);
    if (removeModal) {
      var backdrop = removeModal.querySelector('.home-remove-modal-backdrop');
      if (backdrop) backdrop.addEventListener('click', closeRemoveModal);
    }

    layout.addEventListener('click', function (e) {
      if (!editing) return;
      var btn = e.target.closest('.home-card-remove-btn');
      if (!btn) return;
      var targetId = btn.getAttribute('data-remove-target');
      var card = layout.querySelector('.home-card[data-card-id="' + targetId + '"]');
      var label = card ? cardLabel(card) : targetId;
      openRemoveModal(targetId, label);
    });

    // ── Drag-and-drop reorder ──
    function onDragStart(e) {
      if (!editing) return;
      var card = e.target.closest('.home-card[data-card-id]');
      if (!card) return;
      dragEl = card;
      card.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', card.getAttribute('data-card-id'));
    }

    function onDragOver(e) {
      if (!editing || !dragEl) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      var card = e.target.closest('.home-card[data-card-id]');
      if (!card || card === dragEl) return;
      var all = layout.querySelectorAll('.home-card.drag-over');
      for (var i = 0; i < all.length; i++) all[i].classList.remove('drag-over');
      card.classList.add('drag-over');
    }

    function onDrop(e) {
      if (!editing || !dragEl) return;
      e.preventDefault();
      var target = e.target.closest('.home-card[data-card-id]');
      if (!target || target === dragEl) return;
      var cards = Array.prototype.slice.call(layout.querySelectorAll('.home-card[data-card-id]'));
      var fromIdx = cards.indexOf(dragEl);
      var toIdx = cards.indexOf(target);
      if (fromIdx < toIdx) {
        layout.insertBefore(dragEl, target.nextSibling);
      } else {
        layout.insertBefore(dragEl, target);
      }
      if (addCardEl) layout.appendChild(addCardEl);
    }

    function onDragEnd() {
      if (dragEl) dragEl.classList.remove('dragging');
      dragEl = null;
      var all = layout.querySelectorAll('.home-card.drag-over');
      for (var i = 0; i < all.length; i++) all[i].classList.remove('drag-over');
    }

    layout.addEventListener('dragstart', onDragStart);
    layout.addEventListener('dragover', onDragOver);
    layout.addEventListener('drop', onDrop);
    layout.addEventListener('dragend', onDragEnd);

    // ── Enter / exit edit mode ──
    function enterEditMode() {
      editing = true;
      savedSnapshot = { order: [], hidden: [] };
      var cards = layout.querySelectorAll('.home-card[data-card-id]');
      for (var i = 0; i < cards.length; i++) {
        savedSnapshot.order.push(cards[i].getAttribute('data-card-id'));
        if (cards[i].getAttribute('data-card-hidden') === '1') savedSnapshot.hidden.push(cards[i].getAttribute('data-card-id'));
      }
      layout.classList.add('editing');
      editBtn.classList.add('active');
      if (editActions) editActions.classList.remove('hidden');
      cards = layout.querySelectorAll('.home-card[data-card-id]');
      for (var j = 0; j < cards.length; j++) {
        cards[j].setAttribute('draggable', 'true');
        if (cards[j].getAttribute('data-card-hidden') === '1') {
          cards[j].style.display = '';
          cards[j].style.opacity = '0.45';
        }
      }
      injectRemoveButtons();
      createAddCard();
    }

    function exitEditMode(save) {
      editing = false;
      layout.classList.remove('editing');
      editBtn.classList.remove('active');
      if (editActions) editActions.classList.add('hidden');
      removeRemoveButtons();
      removeAddCard();
      var cards = layout.querySelectorAll('.home-card[data-card-id]');
      for (var j = 0; j < cards.length; j++) {
        cards[j].removeAttribute('draggable');
        cards[j].style.opacity = '';
      }
      if (save) {
        saveOrder();
        var hiddenIds = [];
        var hiddenCards = layout.querySelectorAll('.home-card[data-card-hidden="1"]');
        for (var k = 0; k < hiddenCards.length; k++) hiddenIds.push(hiddenCards[k].getAttribute('data-card-id'));
        saveHidden(hiddenIds);
        for (var h = 0; h < hiddenCards.length; h++) hiddenCards[h].style.display = 'none';
      } else if (savedSnapshot) {
        for (var r = savedSnapshot.order.length - 1; r >= 0; r--) {
          var c = layout.querySelector('.home-card[data-card-id="' + savedSnapshot.order[r] + '"]');
          if (c) layout.insertBefore(c, layout.firstChild);
        }
        cards = layout.querySelectorAll('.home-card[data-card-id]');
        for (var s = 0; s < cards.length; s++) {
          var cid = cards[s].getAttribute('data-card-id');
          if (savedSnapshot.hidden.indexOf(cid) !== -1) {
            cards[s].style.display = 'none';
            cards[s].setAttribute('data-card-hidden', '1');
          } else {
            cards[s].style.display = '';
            cards[s].removeAttribute('data-card-hidden');
          }
        }
      }
      savedSnapshot = null;
    }

    editBtn.addEventListener('click', function () {
      if (editing) exitEditMode(false);
      else enterEditMode();
    });

    if (saveBtn) saveBtn.addEventListener('click', function () { exitEditMode(true); });
    if (cancelBtn) cancelBtn.addEventListener('click', function () { exitEditMode(false); });

    restoreOrder();
  })();

  // ═══════════════════════════════════════════════════════
  //  FIRST-TIME TUTORIAL
  // ═══════════════════════════════════════════════════════
  (function initTutorial() {
    var TUTORIAL_KEY = 'realmengine_tutorial_done';
    var overlay = document.getElementById('tutorial-overlay');
    if (!overlay) return;

    var steps = overlay.querySelectorAll('.tutorial-step');
    var totalSteps = steps.length;
    var dotsContainer = document.getElementById('tutorial-dots');
    var nextBtn = document.getElementById('tutorial-next-btn');
    var backBtn = document.getElementById('tutorial-back-btn');
    var skipBtn = document.getElementById('tutorial-skip-btn');
    var tutorialEmailInput = document.getElementById('tutorial-email');
    var tutorialPasswordInput = document.getElementById('tutorial-password');
    var tutorialAccountStatus = document.getElementById('tutorial-account-status');
    var currentStep = 0;
    var tutorialAccountAdded = false;

    var stepTabs = [null, 'home', 'plugins', 'accounts', 'damage', null];

    for (var i = 0; i < totalSteps; i++) {
      var dot = document.createElement('div');
      dot.className = 'tutorial-dot' + (i === 0 ? ' active' : '');
      dotsContainer.appendChild(dot);
    }
    var dots = dotsContainer.querySelectorAll('.tutorial-dot');

    function switchBackgroundTab(tabName) {
      if (!tabName) return;
      var btn = document.querySelector('.content-tab[data-tab="' + tabName + '"]');
      if (btn) btn.click();
    }

    function showStep(idx) {
      currentStep = idx;
      steps.forEach(function (s) { s.classList.add('hidden'); });
      steps[idx].classList.remove('hidden');

      dots.forEach(function (d, j) {
        d.classList.remove('active', 'completed');
        if (j === idx) d.classList.add('active');
        else if (j < idx) d.classList.add('completed');
      });

      var tab = stepTabs[idx];
      if (tab) switchBackgroundTab(tab);

      if (idx === 0) backBtn.classList.add('hidden');
      else backBtn.classList.remove('hidden');

      if (idx === 0) {
        nextBtn.textContent = tr('tutorial.nav.getStarted');
      } else if (idx === 3) {
        nextBtn.textContent = tutorialAccountAdded ? tr('tutorial.nav.continue') : tr('tutorial.nav.addContinue');
      } else if (idx === totalSteps - 1) {
        nextBtn.textContent = tr('tutorial.nav.finish');
      } else {
        nextBtn.textContent = tr('tutorial.nav.next');
      }

      if (idx === totalSteps - 1) skipBtn.classList.add('hidden');
      else skipBtn.classList.remove('hidden');
    }

    function addTutorialAccount(cb) {
      var email = (tutorialEmailInput.value || '').trim();
      var password = (tutorialPasswordInput.value || '').trim();

      if (!email || !password) {
        cb(true);
        return;
      }

      var account = createEmptyDashboardAccount();
      account.email = email;
      account.password = password;
      account.label = email.split('@')[0] || '';
      dashboardAccounts.unshift(account);
      selectedAccountId = account.id;
      setAccountsDirty(false);

      tutorialAccountStatus.textContent = tr('tutorial.status.saving');
      tutorialAccountStatus.className = 'tutorial-account-status';

      fetch('/api/accounts/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accounts: dashboardAccounts }),
      })
        .then(function (r) {
          if (!r.ok) throw new Error('Failed');
          return r.json();
        })
        .then(function (data) {
          dashboardAccounts = Array.isArray(data && data.accounts) ? data.accounts.map(normalizeDashboardAccount) : dashboardAccounts;
          pruneDashboardAccountOverviewState();
          if (!selectedAccountId && dashboardAccounts[0]) selectedAccountId = dashboardAccounts[0].id;
          setAccountsDirty(false);
          renderAccountsTab();
          tutorialAccountAdded = true;
          tutorialAccountStatus.textContent = tr('tutorial.status.success');
          tutorialAccountStatus.className = 'tutorial-account-status success';
          cb(true);
        })
        .catch(function () {
          tutorialAccountStatus.textContent = tr('tutorial.status.error');
          tutorialAccountStatus.className = 'tutorial-account-status error';
          cb(true);
        });
    }

    function completeTutorial() {
      localStorage.setItem(TUTORIAL_KEY, '1');
      overlay.classList.add('hidden');
      switchBackgroundTab('home');
    }

    nextBtn.addEventListener('click', function () {
      if (currentStep === 3 && !tutorialAccountAdded) {
        nextBtn.disabled = true;
        addTutorialAccount(function () {
          nextBtn.disabled = false;
          if (currentStep === totalSteps - 1) {
            completeTutorial();
          } else {
            showStep(currentStep + 1);
          }
        });
        return;
      }
      if (currentStep === totalSteps - 1) {
        completeTutorial();
      } else {
        showStep(currentStep + 1);
      }
    });

    backBtn.addEventListener('click', function () {
      if (currentStep > 0) showStep(currentStep - 1);
    });

    skipBtn.addEventListener('click', function () {
      completeTutorial();
    });

    // Only show tutorial after login AND accounts have loaded — avoids false-positive on existing users.
    function tryShowTutorial() {
      if (!dashboardLoggedIn || !window._accountsLoaded) {
        setTimeout(tryShowTutorial, 500);
        return;
      }
      if (!localStorage.getItem(TUTORIAL_KEY) && !dashboardAccounts.length) {
        overlay.classList.remove('hidden');
        showStep(0);
      }
    }
    setTimeout(tryShowTutorial, 600);

    window._resetTutorial = function () {
      localStorage.removeItem(TUTORIAL_KEY);
      location.reload();
    };
  })();

  // Start — show splash while restoring session, then reveal UI
  var splash = document.getElementById('app-splash');
  var splashStatus = document.getElementById('app-splash-status');
  var hasStoredToken = !!accessToken;

  function setSplashStatus(text, isError) {
    if (splashStatus) {
      splashStatus.textContent = text;
      splashStatus.className = 'app-splash-status' + (isError ? ' error' : '');
    }
  }

  function dismissSplash() {
    if (!splash) {
      splashDismissed = true;
      updateDashboardAvailabilityUi();
      return;
    }
    splashDismissed = true;
    splash.classList.add('fade-out');
    setTimeout(function () { splash.remove(); }, 400);
    // Show login overlay now that splash is gone
    updateDashboardAvailabilityUi();
  }

  // Restore session (returns promise); splash stays visible for at least 600ms
  var splashMinReady = false;
  // If no stored token, dismiss quickly — go straight to login
  var sessionReady = !hasStoredToken;
  var eamReady = !window._eamPromise;
  var splashMinTimer = setTimeout(function () { splashMinReady = true; maybeFinishSplash(); }, 600);
  // Reduced from 5s to 3s — don't hold the splash forever if restore fails
  var splashTimeout = setTimeout(function () { splashMinReady = true; sessionReady = true; eamReady = true; maybeFinishSplash(); }, 3000);

  function maybeFinishSplash() {
    if (!splashMinReady || !sessionReady || !eamReady) return;
    clearTimeout(splashTimeout);
    updateDashboardAvailabilityUi();
    dismissSplash();
  }

  if (window._eamPromise) {
    window._eamPromise.then(function() { eamReady = true; maybeFinishSplash(); });
  }

  if (hasStoredToken) setSplashStatus('Restoring session...');
  restoreDashboardSessionFromTokens().then(function (ok) {
    sessionReady = true;
    if (!ok) setSplashStatus('Session expired — please sign in');
    maybeFinishSplash();
  }).catch(function () {
    sessionReady = true;
    setSplashStatus('Could not reach server', true);
    maybeFinishSplash();
  });

  // ── Plugin Store ───────────────────────────────────────────────────────────
  var storeManifest = null;
  var storeInstalledMap = {};
  var storeActiveCategory = 'all';

  var STORE_CAT_COLORS = {
    all:        null,
    automation: '#6366f1',
    combat:     '#ef4444',
    visual:     '#a855f7',
    movement:   '#14b8a6',
    network:    '#0ea5e9',
    utility:    '#94a3b8',
  };

  function initPluginStore() {
    var tabNav = document.getElementById('plugin-tab-nav');
    if (!tabNav) return;
    tabNav.addEventListener('click', function (e) {
      var btn = e.target.closest('.plugin-tab-nav-btn');
      if (!btn) return;
      var view = btn.getAttribute('data-plugin-view');
      tabNav.querySelectorAll('.plugin-tab-nav-btn').forEach(function (b) { b.classList.remove('active'); });
      btn.classList.add('active');
      var installedEl = document.getElementById('plugin-view-installed');
      var storeEl = document.getElementById('plugin-view-store');
      if (installedEl) installedEl.style.display = view === 'installed' ? '' : 'none';
      if (storeEl) storeEl.style.display = view === 'store' ? '' : 'none';
      if (view === 'store' && !storeManifest) loadPluginStore();
    });
    var searchEl = document.getElementById('store-search');
    var refreshBtn = document.getElementById('store-refresh-btn');
    if (searchEl) searchEl.addEventListener('input', renderStoreGrid);
    if (refreshBtn) refreshBtn.addEventListener('click', function () {
      storeManifest = null;
      storeActiveCategory = 'all';
      loadPluginStore();
    });
  }

  function loadPluginStore() {
    var statusEl = document.getElementById('store-status');
    var gridEl = document.getElementById('store-grid');
    var chipsEl = document.getElementById('store-category-chips');
    if (statusEl) statusEl.style.display = 'none';
    if (chipsEl) chipsEl.innerHTML = '';
    showStoreSkeletons();

    Promise.all([
      fetch('/api/plugins/store/installed').then(function (r) { return r.json(); }),
      fetch('/api/plugins/store/manifest').then(function (r) { return r.json(); }),
    ]).then(function (results) {
      var installedData = results[0];
      var manifestData = results[1];
      storeInstalledMap = {};
      if (installedData && Array.isArray(installedData.installed)) {
        installedData.installed.forEach(function (r) { storeInstalledMap[r.id] = r; });
      }
      if (gridEl) gridEl.style.display = 'none';
      if (gridEl) gridEl.innerHTML = '';
      if (manifestData && manifestData.error) {
        if (statusEl) { statusEl.textContent = 'Could not load store: ' + manifestData.error; statusEl.style.display = ''; }
        return;
      }
      if (!manifestData || !Array.isArray(manifestData.plugins)) {
        if (statusEl) { statusEl.textContent = 'Store unavailable.'; statusEl.style.display = ''; }
        return;
      }
      storeManifest = manifestData.plugins;
      populateStoreCategoryChips();
      if (gridEl) gridEl.style.display = '';
      renderStoreGrid();
    }).catch(function (err) {
      if (gridEl) { gridEl.style.display = 'none'; gridEl.innerHTML = ''; }
      if (statusEl) { statusEl.textContent = 'Error: ' + err.message; statusEl.style.display = ''; }
    });
  }

  function showStoreSkeletons() {
    var gridEl = document.getElementById('store-grid');
    if (!gridEl) return;
    gridEl.innerHTML = '';
    gridEl.style.display = '';
    for (var i = 0; i < 6; i++) {
      var skel = document.createElement('div');
      skel.className = 'store-card store-card-skeleton';
      skel.innerHTML =
        '<div class="store-skel-banner"></div>' +
        '<div class="store-skel-body">' +
          '<div class="store-skel-line store-skel-title"></div>' +
          '<div class="store-skel-line store-skel-meta"></div>' +
          '<div class="store-skel-line store-skel-desc"></div>' +
          '<div class="store-skel-line store-skel-desc2"></div>' +
        '</div>' +
        '<div class="store-skel-footer"></div>';
      gridEl.appendChild(skel);
    }
  }

  function populateStoreCategoryChips() {
    var chipsEl = document.getElementById('store-category-chips');
    if (!chipsEl || !storeManifest) return;
    var cats = ['all'];
    storeManifest.forEach(function (p) {
      if (p.category && cats.indexOf(p.category) < 0) cats.push(p.category);
    });
    chipsEl.innerHTML = '';
    cats.forEach(function (c) {
      var chip = document.createElement('button');
      chip.className = 'store-chip' + (c === storeActiveCategory ? ' active' : '');
      chip.setAttribute('data-cat', c);
      var color = STORE_CAT_COLORS[c] || '#40916c';
      if (color) chip.style.setProperty('--chip-color', color);
      chip.textContent = c === 'all' ? 'All' : (c.charAt(0).toUpperCase() + c.slice(1));
      chip.addEventListener('click', function () {
        storeActiveCategory = c;
        chipsEl.querySelectorAll('.store-chip').forEach(function (el) { el.classList.remove('active'); });
        chip.classList.add('active');
        renderStoreGrid();
      });
      chipsEl.appendChild(chip);
    });
  }

  function renderStoreGrid() {
    var gridEl = document.getElementById('store-grid');
    if (!gridEl || !storeManifest) return;
    var q = ((document.getElementById('store-search') || {}).value || '').trim().toLowerCase();
    var cat = storeActiveCategory || 'all';
    var filtered = storeManifest.filter(function (p) {
      if (cat !== 'all' && p.category !== cat) return false;
      if (!q) return true;
      return (p.name || '').toLowerCase().indexOf(q) >= 0 ||
             (p.description || '').toLowerCase().indexOf(q) >= 0 ||
             (p.id || '').toLowerCase().indexOf(q) >= 0;
    });
    gridEl.innerHTML = '';
    if (filtered.length === 0) {
      var empty = document.createElement('div');
      empty.className = 'store-empty';
      empty.innerHTML =
        '<svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/></svg>' +
        '<span>' + (q ? 'No plugins match your search.' : 'No plugins available.') + '</span>';
      gridEl.appendChild(empty);
      return;
    }
    filtered.forEach(function (p) { gridEl.appendChild(buildStoreCard(p)); });
  }

  function buildStoreCard(p) {
    var installed = storeInstalledMap[p.id];
    var isInstalled = !!installed;
    var hasUpdate = isInstalled && installed.version !== p.version;
    var cat = p.category || 'utility';
    var words = (p.name || p.id).split(/[\s\-_]+/);
    var initials = (words[0] ? words[0][0] : '') + (words[1] ? words[1][0] : (words[0] && words[0][1] ? words[0][1] : ''));
    initials = initials.toUpperCase() || '??';

    var card = document.createElement('div');
    card.className = 'store-card' + (isInstalled ? ' store-card--installed' : '');
    card.setAttribute('data-category', cat);

    // Banner
    var banner = document.createElement('div');
    banner.className = 'store-card-banner';

    var icon = document.createElement('div');
    icon.className = 'store-card-icon';
    icon.textContent = initials;

    var catLabel = document.createElement('div');
    catLabel.className = 'store-card-cat-label';
    catLabel.textContent = cat;

    banner.appendChild(icon);
    banner.appendChild(catLabel);

    if (isInstalled) {
      var checkEl = document.createElement('div');
      checkEl.className = 'store-card-installed-check';
      checkEl.innerHTML = '<svg width="11" height="11" viewBox="0 0 12 12" fill="none"><path d="M2 6l3 3 5-5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
      banner.appendChild(checkEl);
    }
    card.appendChild(banner);

    // Body
    var body = document.createElement('div');
    body.className = 'store-card-body';

    var nameRow = document.createElement('div');
    nameRow.className = 'store-card-name-row';
    var nameEl = document.createElement('div');
    nameEl.className = 'store-card-name';
    nameEl.textContent = p.name || p.id;
    nameRow.appendChild(nameEl);
    if (hasUpdate) {
      var pip = document.createElement('span');
      pip.className = 'store-update-pip';
      pip.textContent = 'Update';
      nameRow.appendChild(pip);
    }
    body.appendChild(nameRow);

    var meta = document.createElement('div');
    meta.className = 'store-card-meta';
    var authorSpan = document.createElement('span');
    authorSpan.textContent = p.author || 'Unknown';
    var versionSpan = document.createElement('span');
    versionSpan.className = 'store-card-version';
    versionSpan.textContent = 'v' + (p.version || '0.0.0');
    meta.appendChild(authorSpan);
    meta.appendChild(versionSpan);
    body.appendChild(meta);

    if (p.description) {
      var desc = document.createElement('div');
      desc.className = 'store-card-desc';
      desc.textContent = p.description;
      body.appendChild(desc);
    }

    if (p.tags && p.tags.length) {
      var tags = document.createElement('div');
      tags.className = 'store-card-tags';
      p.tags.slice(0, 4).forEach(function (tag) {
        var t = document.createElement('span');
        t.className = 'store-tag';
        t.textContent = tag;
        tags.appendChild(t);
      });
      body.appendChild(tags);
    }
    card.appendChild(body);

    // Footer
    var footer = document.createElement('div');
    footer.className = 'store-card-footer';

    var planSpacer = document.createElement('span');
    if (p.requiredPlan) {
      planSpacer.className = 'store-plan-req';
      planSpacer.textContent = p.requiredPlan.charAt(0).toUpperCase() + p.requiredPlan.slice(1);
    }
    footer.appendChild(planSpacer);

    var btnWrap = document.createElement('div');
    btnWrap.className = 'store-btn-wrap';

    if (!isInstalled) {
      var installBtn = document.createElement('button');
      installBtn.className = 'store-install-btn';
      installBtn.innerHTML = 'Install <svg width="11" height="11" viewBox="0 0 12 12" fill="none" aria-hidden="true"><path d="M6 1v7M3 5.5l3 3 3-3" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';
      installBtn.addEventListener('click', function () { storeInstallPlugin(p, installBtn); });
      btnWrap.appendChild(installBtn);
    } else {
      if (hasUpdate) {
        var updateBtn = document.createElement('button');
        updateBtn.className = 'store-install-btn store-update-btn';
        updateBtn.textContent = '↑ Update';
        updateBtn.addEventListener('click', function () { storeInstallPlugin(p, updateBtn); });
        btnWrap.appendChild(updateBtn);
      }
      var removeBtn = document.createElement('button');
      removeBtn.className = 'store-remove-btn';
      removeBtn.textContent = 'Remove';
      removeBtn.addEventListener('click', function () { storeRemovePlugin(p.id, removeBtn); });
      btnWrap.appendChild(removeBtn);
    }
    footer.appendChild(btnWrap);
    card.appendChild(footer);
    return card;
  }

  function storeInstallPlugin(p, btn) {
    var orig = btn.innerHTML;
    btn.disabled = true;
    btn.textContent = '…';
    fetch('/api/plugins/store/install', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: p.id, bundleUrl: p.bundleUrl, version: p.version, name: p.name }),
    }).then(function (r) { return r.json(); }).then(function (data) {
      if (data.ok) {
        storeInstalledMap[p.id] = { id: p.id, version: p.version, bundleUrl: p.bundleUrl, installedAt: new Date().toISOString() };
        renderStoreGrid();
      } else {
        btn.disabled = false;
        btn.innerHTML = orig;
        showStoreError(data.error || 'Install failed');
      }
    }).catch(function (err) {
      btn.disabled = false;
      btn.innerHTML = orig;
      showStoreError(err.message);
    });
  }

  function storeRemovePlugin(id, btn) {
    var orig = btn.textContent;
    btn.disabled = true;
    btn.textContent = '…';
    fetch('/api/plugins/store/remove', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: id }),
    }).then(function (r) { return r.json(); }).then(function (data) {
      if (data.ok) {
        delete storeInstalledMap[id];
        renderStoreGrid();
      } else {
        btn.disabled = false;
        btn.textContent = orig;
        showStoreError(data.error || 'Remove failed');
      }
    }).catch(function (err) {
      btn.disabled = false;
      btn.textContent = orig;
      showStoreError(err.message);
    });
  }

  function showStoreError(msg) {
    var statusEl = document.getElementById('store-status');
    if (!statusEl) return;
    statusEl.textContent = '⚠ ' + msg;
    statusEl.style.display = '';
    setTimeout(function () { if (statusEl) statusEl.style.display = 'none'; }, 5000);
  }

  initPluginStore();

  // ── Premium tab ───────────────────────────────────────────────────────────
  var premRendered = false;

  function renderPremiumTab() {
    if (!document.getElementById('tab-premium')) return;
    var emailEl   = document.getElementById('prem-email');
    var sinceEl   = document.getElementById('prem-since');
    var gemsEl    = document.getElementById('prem-gems');
    var gemBadge  = document.getElementById('prem-gem-badge');
    var gemNext   = document.getElementById('prem-gem-next');
    var planEl    = document.getElementById('prem-plan-name');
    var planSt    = document.getElementById('prem-plan-status');
    var planEx    = document.getElementById('prem-plan-expires');
    var plansBody = document.getElementById('prem-plans-body');

    // Wire up buttons once
    if (!premRendered) {
      premRendered = true;
      var buyBtn     = document.getElementById('prem-buy-gems');
      var manageBtn  = document.getElementById('prem-manage-plan');
      var signoutBtn = document.getElementById('prem-signout');
      var upgradeBtn = document.getElementById('prem-hero-upgrade');
      if (buyBtn)     buyBtn.addEventListener('click',    function () { openPurchaseModal(); });
      if (manageBtn)  manageBtn.addEventListener('click', function () { openPlanModal(); });
      if (signoutBtn) signoutBtn.addEventListener('click',function () { signOutDashboard(); });
      if (upgradeBtn) upgradeBtn.addEventListener('click',function () {
        var plansSection = document.querySelector('.prem-plans-section');
        if (plansSection) plansSection.scrollIntoView({ behavior: 'smooth' });
      });
    }

    // Populate from cached account data
    if (dashboardLoggedIn && dashboardUser) {
      if (emailEl) emailEl.textContent = dashboardUser.email || '—';
      if (sinceEl && dashboardUser.created_at) sinceEl.textContent = formatDashboardDate(dashboardUser.created_at);
    } else {
      if (emailEl) emailEl.textContent = 'Not signed in';
    }

    if (!dashboardLoggedIn || !accessToken) {
      if (gemsEl)   gemsEl.textContent = '0';
      if (gemBadge) { gemBadge.textContent = 'Inactive'; gemBadge.className = 'acct-badge acct-badge--inactive'; }
      if (planEl)   planEl.textContent = 'Free';
      if (plansBody) plansBody.innerHTML = '<p class="prem-plans-loading">Sign in to manage your subscription.</p>';
      return;
    }

    if (plansBody) plansBody.innerHTML = '<p class="prem-plans-loading">Loading…</p>';

    var headers = { 'Authorization': 'Bearer ' + accessToken };

    fetch('/api/payments/gems/status', { headers: headers })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (gemsEl)   gemsEl.textContent = Number(d.gem_balance || 0).toLocaleString();
        if (gemBadge) {
          var active = d.active;
          gemBadge.textContent = active ? 'Active' : 'Inactive';
          gemBadge.className = 'acct-badge ' + (active ? 'acct-badge--active' : 'acct-badge--inactive');
        }
        if (gemNext && d.next_deduction_at) {
          gemNext.textContent = 'Next deduction: ' + new Date(d.next_deduction_at).toLocaleDateString();
          gemNext.classList.remove('hidden');
        }
      }).catch(function () {});

    fetch('/api/payments/subscription', { headers: headers })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        var name = d.plan_name || 'Free';
        if (planEl) planEl.textContent = name;
        if (planSt) {
          if (d.status) { planSt.textContent = d.status; planSt.classList.remove('hidden'); }
          else planSt.classList.add('hidden');
        }
        if (planEx) {
          if (d.expires_at) { planEx.textContent = 'Renews ' + new Date(d.expires_at).toLocaleDateString(); planEx.classList.remove('hidden'); }
          else planEx.classList.add('hidden');
        }
      }).catch(function () {});

    fetch('/api/payments/plans', { headers: headers })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (!plansBody) return;
        var plans = Array.isArray(d) ? d : (Array.isArray(d.plans) ? d.plans : []);
        if (!plans.length) { plansBody.innerHTML = '<p class="prem-plans-loading">No plans available.</p>'; return; }
        plansBody.innerHTML = '';
        plans.forEach(function (plan) {
          var card = document.createElement('div');
          var isFree = String(plan.name || '').toLowerCase() === 'free';
          card.className = 'prem-plan-card-item' + (isFree ? '' : ' prem-plan-card-item--premium');
          var priceStr = plan.price_usd != null
            ? (plan.price_usd === 0 ? 'Free' : '$' + Number(plan.price_usd).toFixed(2) + '/mo')
            : (isFree ? 'Free' : '');
          var features = Array.isArray(plan.features) ? plan.features : [];
          card.innerHTML =
            '<div class="prem-plan-header">' +
              '<div class="prem-plan-name">' + escapeHtml(plan.name || 'Plan') + '</div>' +
              '<div class="prem-plan-price">' + escapeHtml(priceStr) + '</div>' +
            '</div>' +
            (plan.description ? '<div class="prem-plan-desc">' + escapeHtml(plan.description) + '</div>' : '') +
            (features.length ? '<ul class="prem-plan-features">' + features.map(function (f) { return '<li>' + escapeHtml(f) + '</li>'; }).join('') + '</ul>' : '') +
            (!isFree ? '<button class="prem-plan-cta" data-plan-id="' + escapeHtml(String(plan.id || plan.name)) + '">Get ' + escapeHtml(plan.name) + '</button>' : '');
          var cta = card.querySelector('.prem-plan-cta');
          if (cta) cta.addEventListener('click', function () { openPlanModal(); });
          plansBody.appendChild(card);
        });
      }).catch(function () {
        if (plansBody) {
          plansBody.innerHTML = '';
          // Fallback: render static plan cards if API unavailable
          renderPremiumFallbackPlans(plansBody);
        }
      });
  }

  function renderPremiumFallbackPlans(container) {
    // Paid in gems (preload model). Rate: 100 G = $1.
    //   Dodge:     $10/mo = 1,000 G/mo, auto-deducted monthly from balance
    //   Developer: $20/mo = 2,000 G/mo, auto-deducted monthly from balance
    var PLANS = [
      { name: 'Free',      price: 'Free',      gemsPerMonth: 0,    color: '#94a3b8', badge: null,
        desc: 'Core features — no subscription required.',
        features: ['Auto Nexus', 'Loot Notifier', 'Server Switch', 'IP Connect', 'Rollback', 'O3 Helper'] },
      { name: 'Dodge',     price: '$10/mo',    gemsPerMonth: 1000, color: '#2dd4bf', badge: 'Popular',
        desc: 'Everything in Free plus full movement automation. Auto-renews from your gem balance.',
        features: ['Auto Dodge', 'Safe Walk', 'Auto Aim', 'God Farming', 'Potion discount', 'All Free features'] },
      { name: 'Developer', price: '$20/mo',    gemsPerMonth: 2000, color: '#a855f7', badge: 'Pro',
        desc: 'Complete access including analytics and DLL bridge. Auto-renews from your gem balance.',
        features: ['Damage Sniffer', 'Spoof Push Tiles', 'Packet Lab', 'DLL Walk-To', 'Potion discount', 'All Dodge features'] },
    ];
    PLANS.forEach(function (plan) {
      var card = document.createElement('div');
      card.className = 'prem-plan-card-item';
      card.style.setProperty('--pc', plan.color);
      var priceBlock = plan.gemsPerMonth > 0
        ? plan.price + '<div class="prem-plan-banner-subprice">' + plan.gemsPerMonth.toLocaleString() + ' G/mo</div>'
        : plan.price;
      card.innerHTML =
        '<div class="prem-plan-banner">' +
          (plan.badge ? '<div class="prem-plan-badge">' + plan.badge + '</div>' : '') +
          '<div class="prem-plan-banner-name">' + plan.name + '</div>' +
          '<div class="prem-plan-banner-price">' + priceBlock + '</div>' +
        '</div>' +
        '<div class="prem-plan-content">' +
          '<div class="prem-plan-desc">' + plan.desc + '</div>' +
          '<ul class="prem-plan-features">' + plan.features.map(function (f) { return '<li>' + f + '</li>'; }).join('') + '</ul>' +
        '</div>' +
        (plan.price !== 'Free'
          ? '<button class="prem-plan-cta">Subscribe with Gems →</button>'
          : '<div class="prem-plan-current">Your current plan</div>');
      var cta = card.querySelector('.prem-plan-cta');
      if (cta) cta.addEventListener('click', function () { openPlanModal(); });
      container.appendChild(card);
    });
  }

  // ── Home tab extras ────────────────────────────────────────────────────────
  var homeNewsItems = [
    { date: 'May 11 2026', tag: 'New',    color: '#22c55e', title: 'Plugin Store is Live',           body: 'Browse, install, and update signed plugins directly from the dashboard.' },
    { date: 'May 10 2026', tag: 'Update', color: '#60a5fa', title: 'Auto Dodge v2.0',                body: 'Smarter dodge algorithm — 40% better reaction time on burst projectile patterns.' },
    { date: 'May 9 2026',  tag: 'Fix',    color: '#fb923c', title: 'O3 Helper Phase Detection',      body: 'Fixed Dammah coins phase not being detected correctly in multi-phase encounters.' },
    { date: 'May 8 2026',  tag: 'New',    color: '#a78bfa', title: 'Packet Throttle Plugin',         body: 'Rate-limit outgoing MOVE packets to reduce bandwidth and server-side flags.' },
  ];

  function initHomeExtras() {
    var plansBtn   = document.getElementById('home-hero-plans-btn');
    var pluginsBtn = document.getElementById('home-hero-plugins-btn');
    var upgradeBtn = document.getElementById('home-upgrade-btn');

    if (plansBtn) plansBtn.addEventListener('click', function () {
      var t = document.querySelector('[data-tab="market"]');
      if (t) t.click();
    });
    if (pluginsBtn) pluginsBtn.addEventListener('click', function () {
      var t = document.querySelector('[data-tab="plugins"]');
      if (t) { t.click(); setTimeout(function () {
        var s = document.querySelector('[data-plugin-view="store"]');
        if (s) s.click();
      }, 60); }
    });
    if (upgradeBtn) upgradeBtn.addEventListener('click', function () {
      var t = document.querySelector('[data-tab="market"]');
      if (t) t.click();
    });

    renderHomeNews();
    fetchHomeFeatured();
    updateHomeHero();
  }

  function renderHomeNews() {
    var list = document.getElementById('home-news-list');
    if (!list) return;
    list.innerHTML = '';
    homeNewsItems.forEach(function (item) {
      var row = document.createElement('div');
      row.className = 'home-news-row';
      row.innerHTML =
        '<div class="home-news-tag" style="background:' + item.color + '22;color:' + item.color + ';border-color:' + item.color + '55">' + item.tag + '</div>' +
        '<div class="home-news-body"><div class="home-news-title">' + escapeHtml(item.title) + '</div>' +
        '<div class="home-news-desc">' + escapeHtml(item.body) + '</div></div>' +
        '<div class="home-news-date">' + escapeHtml(item.date) + '</div>';
      list.appendChild(row);
    });
  }

  function fetchHomeFeatured() {
    if (storeManifest && storeManifest.length) { renderHomeFeatured(storeManifest.slice(0, 3)); return; }
    fetch('/api/plugins/store/manifest').then(function (r) { return r.json(); }).then(function (data) {
      if (data && Array.isArray(data.plugins) && data.plugins.length) {
        if (!storeManifest) storeManifest = data.plugins;
        renderHomeFeatured(data.plugins.slice(0, 3));
      }
    }).catch(function () {});
  }

  var FEAT_COLORS = { automation:'#818cf8', combat:'#fb2c54', visual:'#c084fc', movement:'#2dd4bf', network:'#38bdf8', utility:'#94a3b8' };

  function renderHomeFeatured(plugins) {
    var grid = document.getElementById('home-featured-grid');
    if (!grid) return;
    grid.innerHTML = '';
    plugins.forEach(function (p) {
      var cat     = p.category || 'utility';
      var color   = FEAT_COLORS[cat] || '#94a3b8';
      var installed = storeInstalledMap && storeInstalledMap[p.id];
      var words   = (p.name || p.id).split(/[\s\-_]+/);
      var initials = ((words[0] || '')[0] || '') + ((words[1] ? words[1][0] : (words[0] || '')[1]) || '');

      var card = document.createElement('div');
      card.className = 'home-featured-card';
      card.style.setProperty('--fc', color);

      var locked = p.requiredPlan && !(activePlanNames && activePlanNames.has(String(p.requiredPlan).toLowerCase())) && !document.body.classList.contains('admin-mode');
      var btnLabel = installed ? '✓ Installed' : locked ? '🔒 ' + p.requiredPlan.charAt(0).toUpperCase() + p.requiredPlan.slice(1) : 'Install';
      var btnClass = 'home-featured-btn' + (installed ? ' home-featured-btn--installed' : locked ? ' home-featured-btn--locked' : '');

      card.innerHTML =
        '<div class="home-featured-banner">' +
          '<div class="home-featured-icon">' + initials.toUpperCase() + '</div>' +
          '<span class="home-featured-cat">' + cat + '</span>' +
        '</div>' +
        '<div class="home-featured-body">' +
          '<div class="home-featured-name">' + escapeHtml(p.name || p.id) + '</div>' +
          '<div class="home-featured-desc">' + escapeHtml((p.description || '').slice(0, 72) + ((p.description || '').length > 72 ? '…' : '')) + '</div>' +
        '</div>' +
        '<button class="' + btnClass + '">' + btnLabel + '</button>';

      if (!installed) {
        card.querySelector('button').addEventListener('click', function () {
          if (locked) { var t = document.querySelector('[data-tab="market"]'); if (t) t.click(); }
          else storeInstallPlugin(p, card.querySelector('button'));
        });
      }
      grid.appendChild(card);
    });
  }

  function updateHomeHero() {
    var badge     = document.getElementById('home-hero-plan-badge');
    var gemsEl    = document.getElementById('home-hero-gems-val');
    var pluginsEl = document.getElementById('home-hero-plugins-val');

    if (badge) {
      var isAdmin   = document.body.classList.contains('admin-mode');
      var isPremium = isAdmin || (activePlanNames && activePlanNames.size > 0);
      var planName  = isAdmin
        ? 'Admin'
        : isPremium
          ? Array.from(activePlanNames)[0].charAt(0).toUpperCase() + Array.from(activePlanNames)[0].slice(1) + ' Plan'
          : 'Free Plan';
      badge.textContent = planName;
      badge.className = 'home-hero-stat-badge' + (isPremium ? ' home-hero-stat-badge--premium' : '');
    }
    var tbGems = document.getElementById('titlebar-gems');
    if (gemsEl && tbGems) gemsEl.textContent = tbGems.textContent || '0';
    if (pluginsEl) pluginsEl.textContent = cachedPluginsForHub ? cachedPluginsForHub.length : '—';
  }

  initHomeExtras();

  populateScriptSelect();
  renderHomeTab();
  startHomeLiveTicker();

  // ─── Per-account session tracker ─────────────────────────────────────────
  //
  // A "session" is the continuous span of time an account is playing. It
  // starts on the first "game connected" we receive after the account is
  // armed (via launchGameWithCredentials), persists across brief
  // disconnect/reconnect cycles (realm switches are typically <60s), and
  // finalizes after a grace period of sustained disconnection or when a
  // different account is launched.
  //
  // Counters tracked per session: durationMs, bossesKilled, whiteBags,
  // shinyItems.
  // - durationMs: tick-based timestamp math, always reliable
  // - bossesKilled: pulled from damageHistory deltas (any new completed run
  //   target with `boss: true`)
  // - whiteBags: detected by diffing player inventory against the previous
  //   snapshot — a new item entering inventory whose EAM record reports
  //   bagType >= 6 (UT / rare drop tier) counts as a white bag. Multiple
  //   items entering within a 5s window collapse into a single bag (since
  //   one bag can drop multiple items).
  // - shinyItems: detected the same way, but using the isShiny flag in the
  //   EAM record (record[10]) or a "Shiny" name suffix fallback. Each
  //   shiny is counted individually — no time-grouping.
  //
  // Persistence: completed sessions append to localStorage under
  // "account-sessions:<email>" (latest 50 kept).
  var _AccountSessions = (function () {
    var GRACE_MS = 120 * 1000;       // 2 minutes for realm switches / quick blips
    var WHITE_BAG_GROUP_MS = 5000;   // Multiple UT pickups within 5s = same bag
    var WHITE_BAG_MIN_BAGTYPE = 6;   // Items in bag tier 6+ are white-bag-ish
    var KEY_PREFIX = 'account-sessions:';
    var MAX_HISTORY = 50;

    var current = null;          // { email, startedAt, accumulatedMs, lastTickAt, paused, stats: {...} }
    var pauseTimer = null;
    var armedEmail = null;       // Email of the most recently launched account
    var lastSeenRunId = null;    // Track damageHistory growth for boss-kill counting
    var lastInventorySig = null; // Multiset of objectTypes from the prior playerData
    var lastWhiteBagAt = 0;      // Timestamp of the last white-bag-counted pickup
    var listeners = [];

    function lsKey(email) { return KEY_PREFIX + String(email || '').toLowerCase(); }

    function loadHistory(email) {
      if (!email) return [];
      try {
        var raw = localStorage.getItem(lsKey(email));
        var arr = raw ? JSON.parse(raw) : [];
        return Array.isArray(arr) ? arr : [];
      } catch (_) { return []; }
    }

    function saveHistory(email, list) {
      try {
        localStorage.setItem(lsKey(email), JSON.stringify(list.slice(-MAX_HISTORY)));
      } catch (_) { /* quota: best-effort */ }
    }

    function notifyChanged() {
      for (var i = 0; i < listeners.length; i++) {
        try { listeners[i](); } catch (_) {}
      }
    }

    function liveDurationMs() {
      if (!current) return 0;
      var base = current.accumulatedMs || 0;
      if (!current.paused) {
        base += Math.max(0, Date.now() - (current.lastTickAt || current.startedAt));
      }
      return base;
    }

    function tick() {
      if (!current || current.paused) return;
      current.accumulatedMs = (current.accumulatedMs || 0) + Math.max(0, Date.now() - (current.lastTickAt || Date.now()));
      current.lastTickAt = Date.now();
    }

    function startSession(email) {
      if (current && current.email === email) return; // already running
      if (current) finalizeSession();
      current = {
        email: email,
        startedAt: Date.now(),
        accumulatedMs: 0,
        lastTickAt: Date.now(),
        paused: false,
        stats: { bossesKilled: 0, whiteBags: 0, shinyItems: 0 },
      };
      lastSeenRunId = null;
      lastInventorySig = null;
      lastWhiteBagAt = 0;
      notifyChanged();
    }

    function finalizeSession() {
      if (!current) return;
      tick();
      var record = {
        email: current.email,
        startedAt: current.startedAt,
        endedAt: Date.now(),
        durationMs: current.accumulatedMs,
        bossesKilled: current.stats.bossesKilled,
        whiteBags: current.stats.whiteBags,
        shinyItems: current.stats.shinyItems,
      };
      var hist = loadHistory(current.email);
      hist.push(record);
      saveHistory(current.email, hist);
      current = null;
      if (pauseTimer) { clearTimeout(pauseTimer); pauseTimer = null; }
      notifyChanged();
    }

    function armLaunch(email) {
      var e = String(email || '').toLowerCase().trim();
      if (!e) return;
      // If a different account is launching while another session is active,
      // finalize the old one first so stats don't bleed across accounts.
      if (current && current.email !== e) {
        finalizeSession();
      }
      armedEmail = e;
    }

    function onConnected() {
      var email = armedEmail || (current && current.email);
      if (!email) return;
      if (current && current.email === email) {
        // Resume: cancel pause, reset tick
        if (pauseTimer) { clearTimeout(pauseTimer); pauseTimer = null; }
        current.paused = false;
        current.lastTickAt = Date.now();
      } else {
        startSession(email);
      }
      notifyChanged();
    }

    function onDisconnected() {
      if (!current) return;
      tick();
      current.paused = true;
      if (pauseTimer) clearTimeout(pauseTimer);
      pauseTimer = setTimeout(function () {
        finalizeSession();
      }, GRACE_MS);
      notifyChanged();
    }

    function incrementStat(name, delta) {
      if (!current) return;
      var d = Number(delta || 1);
      if (!current.stats[name]) current.stats[name] = 0;
      current.stats[name] = Math.max(0, current.stats[name] + d);
      notifyChanged();
    }

    function observeDamageHistory(history) {
      if (!current || !Array.isArray(history)) return;
      // Each entry is a completed run with targets[]. Use the run's
      // id/endedAt as a high-water mark so we don't double-count when the
      // server resends the full list.
      var newKills = 0;
      for (var i = 0; i < history.length; i++) {
        var run = history[i];
        var key = String((run && (run.id || run.endedAt)) || i);
        if (lastSeenRunId && key <= String(lastSeenRunId)) continue;
        lastSeenRunId = key;
        var targets = (run && Array.isArray(run.targets)) ? run.targets : [];
        for (var j = 0; j < targets.length; j++) {
          if (targets[j] && targets[j].boss) newKills++;
        }
      }
      if (newKills > 0) incrementStat('bossesKilled', newKills);
    }

    // ── Inventory diff: white bags + shinies ─────────────────────────────
    //
    // Each playerData update brings the player's current inventory + backpack
    // as arrays of objectType numbers. We compute the multiset of pickups
    // since the last snapshot and look each new item up in EAM_ITEMS.
    //
    // Schema of an EAM record (positional, observed from eam-assets.js):
    //   [0] name, [1] slotType, [2] tier (-1=UT), [3-4] sprite x/y,
    //   [5] rarityIdx, [6] cost, [7] bagType, [8] soulbound,
    //   [9] consumable-ish, [10] isShiny
    //
    // - bagType >= 6 → white-bag-tier loot. Multiple within 5s collapse
    //   into a single bag drop (one bag can contain several items).
    // - record[10] === true OR name endsWith "Shiny" → shiny item.
    function buildInventorySig(inv, backpack) {
      var counts = Object.create(null);
      function bump(arr) {
        if (!Array.isArray(arr)) return;
        for (var i = 0; i < arr.length; i++) {
          var n = Number(arr[i] || 0);
          if (!Number.isFinite(n) || n <= 0) continue;
          counts[n] = (counts[n] || 0) + 1;
        }
      }
      bump(inv);
      bump(backpack);
      return counts;
    }

    function diffPickups(prev, next) {
      // For each objectType in next with a higher count than prev, the delta
      // is the number of new pickups of that item.
      var added = [];
      if (!prev) prev = {};
      var keys = Object.keys(next);
      for (var i = 0; i < keys.length; i++) {
        var key = keys[i];
        var delta = next[key] - (prev[key] || 0);
        for (var j = 0; j < delta; j++) added.push(Number(key));
      }
      return added;
    }

    function lookupItem(objectType) {
      try {
        if (typeof window !== 'undefined' && window.EAM_ASSETS && window.EAM_ASSETS.items) {
          return window.EAM_ASSETS.items[String(objectType)] || null;
        }
      } catch (_) {}
      // Fall back to the local EAM_ITEMS captured by the surrounding closure.
      // (Available because this module is defined inside the main IIFE.)
      try { return EAM_ITEMS[String(objectType)] || null; } catch (_) { return null; }
    }

    function observePlayerData(data) {
      if (!current || !data) return;
      var nextSig = buildInventorySig(data.inventory, data.backpack);
      // First observation just primes the cache — we don't know what was
      // in inventory before the player connected, so we can't infer pickups
      // from the initial snapshot.
      if (lastInventorySig === null) {
        lastInventorySig = nextSig;
        return;
      }
      var pickups = diffPickups(lastInventorySig, nextSig);
      lastInventorySig = nextSig;
      if (!pickups.length) return;

      var newShinies = 0;
      var sawWhiteBagPickup = false;
      for (var i = 0; i < pickups.length; i++) {
        var rec = lookupItem(pickups[i]);
        if (!rec) continue;
        var name = String(rec[0] || '');
        var bagType = Number(rec[7] || 0);
        var isShiny = rec[10] === true || /\bShiny$/i.test(name);
        if (isShiny) newShinies++;
        if (bagType >= WHITE_BAG_MIN_BAGTYPE) sawWhiteBagPickup = true;
      }
      if (newShinies > 0) incrementStat('shinyItems', newShinies);
      if (sawWhiteBagPickup) {
        // Time-group: if the last white-bag pickup we counted was very
        // recent, treat this burst as the same bag (one bag can contain
        // multiple items). Otherwise count a new bag.
        var now = Date.now();
        if (now - lastWhiteBagAt > WHITE_BAG_GROUP_MS) {
          incrementStat('whiteBags', 1);
        }
        lastWhiteBagAt = now;
      }
    }

    function getCurrent() {
      if (!current) return null;
      return {
        email: current.email,
        startedAt: current.startedAt,
        durationMs: liveDurationMs(),
        paused: current.paused,
        bossesKilled: current.stats.bossesKilled,
        whiteBags: current.stats.whiteBags,
        shinyItems: current.stats.shinyItems,
      };
    }

    function getHistory(email) { return loadHistory(email); }

    function aggregate(email) {
      var hist = loadHistory(email).slice();
      var live = getCurrent();
      if (live && live.email === String(email || '').toLowerCase()) hist.push(live);
      return hist.reduce(function (acc, s) {
        acc.sessions += 1;
        acc.durationMs += Number(s.durationMs || 0);
        acc.bossesKilled += Number(s.bossesKilled || 0);
        acc.whiteBags += Number(s.whiteBags || 0);
        acc.shinyItems += Number(s.shinyItems || 0);
        return acc;
      }, { sessions: 0, durationMs: 0, bossesKilled: 0, whiteBags: 0, shinyItems: 0 });
    }

    function onChange(fn) { listeners.push(fn); }

    // Keep the live duration display moving even when nothing else changes.
    setInterval(function () { if (current && !current.paused) notifyChanged(); }, 1000);

    return {
      armLaunch: armLaunch,
      onConnected: onConnected,
      onDisconnected: onDisconnected,
      incrementStat: incrementStat,
      observeDamageHistory: observeDamageHistory,
      observePlayerData: observePlayerData,
      getCurrent: getCurrent,
      getHistory: getHistory,
      aggregate: aggregate,
      onChange: onChange,
      // Manual recorders if downstream code wants to bump counters directly:
      recordBossKill: function () { incrementStat('bossesKilled', 1); },
      recordWhiteBag: function () { incrementStat('whiteBags', 1); },
      recordShiny: function () { incrementStat('shinyItems', 1); },
    };
  })();
  window._AccountSessions = _AccountSessions;

  connect();

  // ─── Admin Telemetry tab ─────────────────────────────────────────────────
  var telemetryRefreshTimer = null;
  var telemetryWindowMinutes = 5;
  var telemetryPendingKinds = new Set();

  function openTelemetryTab() {
    if (!adminMode) return;
    var sel = document.getElementById('telemetry-window-select');
    if (sel) telemetryWindowMinutes = Number(sel.value || 5) || 5;
    requestTelemetryRefresh();
    // Auto-refresh while the tab is open. 30s cadence keeps it lively without
    // hammering — heartbeats themselves arrive on a 60s cycle.
    if (telemetryRefreshTimer) clearInterval(telemetryRefreshTimer);
    telemetryRefreshTimer = setInterval(function () {
      if (activeTab === 'telemetry') requestTelemetryRefresh();
    }, 30000);
  }

  function requestTelemetryRefresh() {
    if (!ws || ws.readyState !== 1) {
      setTelemetryStatus('Dashboard offline.', true);
      return;
    }
    setTelemetryStatus('Loading…', false);
    var kinds = ['overview', 'servers', 'classes', 'plugins', 'settings', 'eventsTop', 'timeline'];
    telemetryPendingKinds = new Set(kinds);
    // Buckets: 5m for short windows, 1h for >24h windows.
    var bucketSeconds = telemetryWindowMinutes >= 1440 ? 3600 : 300;
    kinds.forEach(function (kind) {
      var req = {
        type: 'requestTelemetryStats',
        kind: kind,
        window: telemetryWindowMinutes,
      };
      if (kind === 'timeline') req.bucket = bucketSeconds;
      ws.send(JSON.stringify(req));
    });
  }

  function setTelemetryStatus(text, isError) {
    var el = document.getElementById('telemetry-status');
    if (!el) return;
    el.textContent = text || '';
    el.classList.toggle('error', !!isError);
  }

  function handleTelemetryStats(msg) {
    if (!msg || !msg.kind || !msg.data) return;
    if (msg.kind === 'overview') {
      renderTelemetryOverview(msg.data);
    } else if (msg.kind === 'servers') {
      renderTelemetryBreakdown('telemetry-servers-tbody', 'telemetry-servers-empty', msg.data);
    } else if (msg.kind === 'classes') {
      renderTelemetryBreakdown('telemetry-classes-tbody', 'telemetry-classes-empty', msg.data);
    } else if (msg.kind === 'plugins') {
      renderTelemetryBreakdown('telemetry-plugins-tbody', 'telemetry-plugins-empty', msg.data);
    } else if (msg.kind === 'eventsTop') {
      renderTelemetryBreakdown('telemetry-events-tbody', 'telemetry-events-empty', msg.data);
    } else if (msg.kind === 'settings') {
      renderTelemetrySettings(msg.data);
    } else if (msg.kind === 'timeline') {
      renderTelemetryTimeline(msg.data);
    }
    telemetryPendingKinds.delete(msg.kind);
    if (telemetryPendingKinds.size === 0) {
      var sampled = msg.data && msg.data.sampled_at ? new Date(msg.data.sampled_at) : new Date();
      setTelemetryStatus('Updated ' + sampled.toLocaleTimeString(), false);
    }
  }

  function renderTelemetrySettings(data) {
    var tbody = document.getElementById('telemetry-settings-tbody');
    var empty = document.getElementById('telemetry-settings-empty');
    if (!tbody) return;
    var rows = (data && Array.isArray(data.rows)) ? data.rows : [];
    if (rows.length === 0) {
      tbody.innerHTML = '';
      if (empty) empty.style.display = '';
      return;
    }
    if (empty) empty.style.display = 'none';
    tbody.innerHTML = rows.map(function (r) {
      return '<tr><td>' + escapeHtml(String(r.key || ''))
        + '</td><td>' + escapeHtml(String(r.value || ''))
        + '</td><td class="telemetry-num">' + (Number(r.count) || 0) + '</td></tr>';
    }).join('');
  }

  function renderTelemetryTimeline(data) {
    var svg = document.getElementById('telemetry-sparkline-svg');
    var meta = document.getElementById('telemetry-sparkline-meta');
    if (!svg) return;
    var points = (data && Array.isArray(data.points)) ? data.points : [];
    if (points.length === 0) {
      svg.innerHTML = '';
      if (meta) meta.textContent = 'No data';
      return;
    }
    // Build a polyline + fill path over a 600×60 viewBox.
    var W = 600, H = 60;
    var max = 0;
    for (var i = 0; i < points.length; i++) {
      if ((points[i].active_users || 0) > max) max = points[i].active_users;
    }
    if (max < 1) max = 1;
    var stepX = W / Math.max(1, points.length - 1);
    var d = '';
    for (var j = 0; j < points.length; j++) {
      var x = j * stepX;
      var y = H - 2 - ((points[j].active_users || 0) / max) * (H - 4);
      d += (j === 0 ? 'M' : 'L') + x.toFixed(1) + ',' + y.toFixed(1) + ' ';
    }
    // Fill path: extend down to the baseline so the area shades.
    var fillD = d + 'L' + W + ',' + H + ' L0,' + H + ' Z';
    svg.innerHTML =
      '<path class="telemetry-sparkline-path" d="' + fillD + '"></path>';
    if (meta) {
      var peak = max;
      var latest = points[points.length - 1].active_users || 0;
      var bucket = Math.round((Number(data.bucket_seconds) || 0) / 60);
      meta.textContent = 'peak ' + peak + ' · now ' + latest + ' · ' + bucket + 'm buckets';
    }
  }

  function handleTelemetryStatsError(msg) {
    var err = msg && msg.error ? String(msg.error) : 'Failed to load telemetry.';
    setTelemetryStatus(err, true);
  }

  function renderTelemetryOverview(data) {
    var setText = function (id, val) {
      var el = document.getElementById(id);
      if (el) el.textContent = val == null ? '—' : String(val);
    };
    setText('telemetry-active-5m', data.active_5m);
    setText('telemetry-active-1h', data.active_1h);
    setText('telemetry-active-24h', data.active_24h);
    setText('telemetry-free-users', data.free_users);
    setText('telemetry-paid-users', data.paid_users);
    var totalUsers = (Number(data.free_users) || 0) + (Number(data.paid_users) || 0);
    var shareEl = document.getElementById('telemetry-paid-share');
    if (shareEl) {
      if (totalUsers > 0) {
        var pct = Math.round((Number(data.paid_users) / totalUsers) * 100);
        shareEl.textContent = pct + '% of active';
      } else {
        shareEl.textContent = '—';
      }
    }
    var plansTbody = document.getElementById('telemetry-plans-tbody');
    var plansEmpty = document.getElementById('telemetry-plans-empty');
    if (plansTbody) {
      var dist = (data && data.plan_distribution) || {};
      var entries = Object.keys(dist).map(function (k) { return { key: k, count: Number(dist[k]) || 0 }; });
      entries.sort(function (a, b) { return b.count - a.count; });
      plansTbody.innerHTML = entries.map(function (e) {
        var label = e.key.replace(/^(.)/, function (c) { return c.toUpperCase(); });
        return '<tr><td>' + escapeHtml(label) + '</td><td class="telemetry-num">' + e.count + '</td></tr>';
      }).join('');
      if (plansEmpty) plansEmpty.style.display = entries.length ? 'none' : '';
    }
  }

  function renderTelemetryBreakdown(tbodyId, emptyId, data) {
    var tbody = document.getElementById(tbodyId);
    var empty = document.getElementById(emptyId);
    if (!tbody) return;
    var rows = (data && Array.isArray(data.rows)) ? data.rows : [];
    if (rows.length === 0) {
      tbody.innerHTML = '';
      if (empty) empty.style.display = '';
      return;
    }
    if (empty) empty.style.display = 'none';
    tbody.innerHTML = rows.map(function (r) {
      return '<tr><td>' + escapeHtml(String(r.label || r.key || '—'))
        + '</td><td class="telemetry-num">' + (Number(r.count) || 0) + '</td></tr>';
    }).join('');
  }

  var telemetryWindowSelect = document.getElementById('telemetry-window-select');
  if (telemetryWindowSelect) {
    telemetryWindowSelect.addEventListener('change', function () {
      telemetryWindowMinutes = Number(telemetryWindowSelect.value || 5) || 5;
      if (activeTab === 'telemetry') requestTelemetryRefresh();
    });
  }
  var telemetryRefreshBtn = document.getElementById('telemetry-refresh-btn');
  if (telemetryRefreshBtn) {
    telemetryRefreshBtn.addEventListener('click', function () {
      requestTelemetryRefresh();
    });
  }
})();
