// options/options.js — thin wiring entry for the custom-dictionary options
// page. All behaviour lives in ui/dictionary-page.js (deps-injected, like
// ui/library.js); this just binds the real DOM and the real store.

import {
  addWords, clearDictionary, loadDictionary, onDictionaryChanged, removeWord,
} from "../lib/dictionary-store.js";
import { GitHubContentClient, discoverTokenRepos } from "../lib/github-content.js";
import {
  inspectSyncRecovery, loadRecoveryBackup, recoverNotesSync, runSync,
} from "../lib/notes-sync.js";
import {
  clearSyncDiagnostic, loadSyncDiagnostic, recordSyncError,
} from "../lib/sync-diagnostics.js";
import {
  clearSyncSettings, loadSyncSettings, onSyncSettingsChanged, saveSyncSettings,
} from "../lib/sync-settings.js";
import { initDictionaryPage } from "../ui/dictionary-page.js";
import { initSyncPage } from "../ui/sync-page.js";
import {
  loadWeirpackIndex, onWeirpacksChanged, removeWeirpack, saveWeirpack,
} from "../lib/weirpack-store.js";
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
    clearBtn: $("clearBtn"),
  },
  store: { loadDictionary, addWords, removeWord, clearDictionary, onDictionaryChanged },
});

initWeirpackPage({
  els: {
    file: $("weirpackFile"),
    importBtn: $("importWeirpackBtn"),
    status: $("weirpackStatus"),
    list: $("weirpackList"),
    empty: $("weirpackEmpty"),
  },
  store: {
    loadWeirpackIndex, saveWeirpack, removeWeirpack, onWeirpacksChanged,
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
