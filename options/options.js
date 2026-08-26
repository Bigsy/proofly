// options/options.js — thin wiring entry for the custom-dictionary options
// page. All behaviour lives in ui/dictionary-page.js (deps-injected, like
// ui/library.js); this just binds the real DOM and the real store.

import {
  addWords, clearDictionary, loadDictionary, loadDictionarySettings, onDictionaryChanged,
  onDictionarySettingsChanged, removeWord, setDictionarySyncEnabled,
} from "../lib/dictionary-store.js";
import { GitHubContentClient, discoverTokenRepos } from "../lib/github-content.js";
import { runSync } from "../lib/full-sync.js";
import {
  inspectSyncRecovery, loadRecoveryBackup, recoverNotesSync,
} from "../lib/notes-sync.js";
import {
  clearSyncDiagnostic, loadSyncDiagnostic, recordSyncError,
} from "../lib/sync-diagnostics.js";
import {
  clearSyncSettings, loadSyncSettings, onSyncSettingsChanged, saveSyncSettings,
} from "../lib/sync-settings.js";
import { initDictionaryPage } from "../ui/dictionary-page.js";
import { initDocumentsPage } from "../ui/documents-page.js";
import { listIndex, listNotes, mergeNotes } from "../lib/notes-store.js";
import { initSyncPage } from "../ui/sync-page.js";
import {
  loadWeirpackIndex, maxWeirpackFileBytes, onWeirpacksChanged, removeWeirpack, saveWeirpack,
} from "../lib/weirpack-store.js";
import {
  disableGitHubWeirpackSync, enableGitHubWeirpackSync, runWeirpackSync,
} from "../lib/weirpack-sync.js";
import {
  loadWeirpackSyncSettings, onWeirpackSyncSettingsChanged,
} from "../lib/weirpack-sync-settings.js";
import { validateWeirpack } from "../lib/weirpack-validator.js";
import { initWeirpackPage } from "../ui/weirpack-page.js";

const $ = (id) => document.getElementById(id);

initDictionaryPage({
  els: {
    search: $("dictSearch"),
    bulkInput: $("bulkInput"),
    bulkBtn: $("bulkBtn"),
    bulkReport: $("bulkReport"),
    list: $("wordList"),
    empty: $("dictEmpty"),
    meter: $("quotaMeter"),
    importFile: $("dictImportFile"),
    importBtn: $("importDictBtn"),
    exportBtn: $("exportDictBtn"),
    transferStatus: $("dictTransferStatus"),
    clearBtn: $("clearBtn"),
    syncToggle: $("dictSyncEnabled"),
    syncStatus: $("dictSyncStatus"),
  },
  store: {
    loadDictionary, loadDictionarySettings, addWords, removeWord, clearDictionary,
    setDictionarySyncEnabled, onDictionaryChanged, onDictionarySettingsChanged,
  },
});

initDocumentsPage({
  els: {
    count: $("docsCount"),
    importFile: $("docsImportFile"),
    importBtn: $("importDocsBtn"),
    exportBtn: $("exportDocsBtn"),
    status: $("docsTransferStatus"),
  },
  store: { listIndex, listNotes, mergeNotes },
  // Push imported notes to GitHub when sync is connected; otherwise the side
  // panel's scheduler picks them up from local storage on its next run.
  sync: async () => {
    const settings = await loadSyncSettings();
    if (!settings) return false;
    await runSync({ settings });
    return true;
  },
});

initWeirpackPage({
  els: {
    file: $("weirpackFile"),
    importBtn: $("importWeirpackBtn"),
    status: $("weirpackStatus"),
    list: $("weirpackList"),
    empty: $("weirpackEmpty"),
    syncWrap: $("weirpackSyncWrap"),
    syncToggle: $("weirpackSyncEnabled"),
    syncStatus: $("weirpackSyncStatus"),
  },
  store: {
    loadWeirpackIndex, saveWeirpack, removeWeirpack, onWeirpacksChanged,
    maxWeirpackFileBytes,
  },
  githubSettingsStore: { loadSyncSettings, onSyncSettingsChanged },
  syncModeStore: { loadWeirpackSyncSettings, onWeirpackSyncSettingsChanged },
  syncActions: {
    enable: enableGitHubWeirpackSync,
    disable: disableGitHubWeirpackSync,
    sync: runWeirpackSync,
  },
  validate: validateWeirpack,
});

initSyncPage({
  els: {
    createRepo: $("createRepoLink"),
    createToken: $("createTokenLink"),
    setup: $("syncSetup"),
    token: $("syncToken"),
    repoWrap: $("syncRepoWrap"),
    repoSelect: $("syncRepo"),
    connected: $("syncConnected"),
    syncNow: $("syncNowBtn"),
    disconnect: $("disconnectSyncBtn"),
    status: $("syncStatus"),
    diagnostic: $("syncDiagnostic"),
    diagnosticMessage: $("syncDiagnosticMessage"),
    technicalText: $("syncTechnicalText"),
    resolve: $("resolveSyncBtn"),
    downloadBackup: $("downloadSyncBackupBtn"),
    recovery: $("syncRecovery"),
    recoverySummary: $("syncRecoverySummary"),
    recoveryChoices: $("syncRecoveryChoices"),
    recoveryConfirm: $("syncRecoveryConfirm"),
    recoveryWarning: $("syncRecoveryWarning"),
    repair: $("repairSyncBtn"),
    useGitHub: $("useGitHubSyncBtn"),
    useLocal: $("useLocalSyncBtn"),
    closeRecovery: $("closeSyncRecoveryBtn"),
    cancelRecovery: $("cancelSyncRecoveryBtn"),
    confirmRecovery: $("confirmSyncRecoveryBtn"),
  },
  settingsStore: {
    loadSyncSettings,
    saveSyncSettings,
    clearSyncSettings,
    onSyncSettingsChanged,
  },
  discoverRepos: (token) => discoverTokenRepos(token),
  makeClient: (settings) => new GitHubContentClient(settings),
  runSync,
  inspectSyncRecovery,
  recoverNotesSync,
  diagnosticStore: { loadSyncDiagnostic, recordSyncError, clearSyncDiagnostic },
  recoveryStore: { loadRecoveryBackup },
});
