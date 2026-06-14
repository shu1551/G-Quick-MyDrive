/**
 * Code.gs - Googleドライブ Explorer 統合・最速版 (G-クイック MYDRIVE専用)
 * マイドライブのみ対応（共有ドライブ・共有アイテムは非対応）
 */

/**
 * 【V208 Keep-Alive】GASコンテナのコールドスタートを防ぐため、
 * 定期的にキャッシュを更新する関数。
 * Time-based Trigger（10〜15分間隔）で実行することで、
 * 初回起動を15秒→1〜3秒に短縮できる。
 * 設定方法: GASエディタ → 時計アイコン(トリガー) → +トリガーを追加
 *   関数: keepAliveCache / イベント: 時間ベース / 間隔: 10分
 */
function keepAliveCache() {
  try {
    console.log('Keep-Alive: Refreshing cache at ' + new Date().toISOString());
    getAppData(true); // キャッシュを強制更新
    console.log('Keep-Alive: Cache refreshed successfully.');
  } catch (e) {
    console.error('Keep-Alive Error: ' + e.message);
  }
}

/**
 * 【V211 差分同期】指定タイムスタンプ以降に変更されたファイルのみ取得
 * 既存の getAppData を一切変更せず、追加のみで実装する安全な差分同期用関数。
 */
function getRecentChanges(sinceTimestamp) {
  try {
    const sinceDate = new Date(sinceTimestamp);
    const formatted = Utilities.formatDate(sinceDate, 'UTC', "yyyy-MM-dd'T'HH:mm:ss'Z'");
    const query = `trashed = false and modifiedTime > '${formatted}' and 'me' in owners`;

    const changedFiles = [];
    let token = null;
    do {
      const res = Drive.Files.list({
        q: query,
        fields: 'nextPageToken, files(id, name, mimeType, createdTime, modifiedTime, webViewLink, parents)',
        pageSize: 1000,
        pageToken: token
      });
      (res.files || []).forEach(f => {
        if (f.mimeType !== 'application/vnd.google-apps.folder') {
          const parentId = (f.parents && f.parents.length > 0) ? f.parents[0] : null;
          changedFiles.push([
            f.id, f.name,
            detectFileType_(f.mimeType, f.name),
            new Date(f.modifiedTime).getTime(),
            new Date(f.createdTime).getTime(),
            f.webViewLink, parentId
          ]);
        }
      });
      token = res.nextPageToken;
    } while (token);

    const deletedIds = [];
    let dtoken = null;
    do {
      const deletedRes = Drive.Files.list({
        q: `trashed = true and modifiedTime > '${formatted}' and 'me' in owners`,
        fields: 'nextPageToken, files(id)',
        pageSize: 1000,
        pageToken: dtoken
      });
      (deletedRes.files || []).forEach(f => deletedIds.push(f.id));
      dtoken = deletedRes.nextPageToken;
    } while (dtoken);

    return { success: true, files: changedFiles, deletedIds: deletedIds };
  } catch (e) {
    return { success: false, message: e.message };
  }
}

/**
 * 【独立化】起点フォルダIDを固定（スプレッドシート依存を排除）
 */
function getDynamicStartFolderId() {
  // PropertiesService から保存された設定を取得
  const savedId = PropertiesService.getUserProperties().getProperty('START_FOLDER_ID');
  if (savedId) return savedId;

  // 設定がない場合のデフォルト（必要に応じてここに初期IDを入れるか、nullを返す）
  return null;
}

/** プリセット設定（現在はフォルダ一覧から選択するため未使用） */
function getStartFolderPresets() {
  return [];
}

/** 【新機能】指定した親フォルダ直下のフォルダ一覧を取得（ドリルダウン用） */
function getSubFolders(parentId) {
  try {
    const realRoot = getRootFolderOnce();
    const realRootId = realRoot.getId();
    const id = (parentId === realRootId || parentId === 'root') ? getDriveRootIdOnce() : parentId;

    // Drive API で子フォルダを取得
    const res = Drive.Files.list({
      q: `'${id}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
      fields: 'files(id, name, webViewLink)',
      pageSize: 1000
    });

    const result = (res.files || []).map(f => ({
      id: f.id,
      name: f.name,
      url: f.webViewLink
    }));

    // 名前順にソート
    result.sort((a, b) => a.name.localeCompare(b.name, 'ja'));

    // 親フォルダ名の解決 (最適化: キャッシュから取得)
    let pName = 'マイドライブ';
    if (id !== getDriveRootIdOnce()) {
      const folderMap = getAllFoldersInfoMap();
      const folderInfo = folderMap.get(id);
      pName = folderInfo ? folderInfo.name : 'マイドライブ';
    }

    return { success: true, folders: result, parentName: pName };
  } catch (e) {
    return { success: false, message: e.message };
  }
}

/** 【新機能】現在のスタートフォルダ情報を取得（パスを含む） */
function getCurrentStartFolderInfo() {
  try {
    const id = getDynamicStartFolderId();
    const driveRootId = getDriveRootIdOnce();

    // マイドライブ（デフォルト）
    if (!id || id === driveRootId) {
      return { id: driveRootId, name: 'マイドライブ', path: [{ id: driveRootId, name: 'マイドライブ' }] };
    }

    const path = [];
    let currentId = id;

    // パスを遡る（最適化: キャッシュから取得、最大10階層程度に制限して無限ループ防止）
    const folderMap = getAllFoldersInfoMap();
    for (let i = 0; i < 10; i++) {
      const folderInfo = folderMap.get(currentId);
      if (!folderInfo) break;

      path.unshift({ id: currentId, name: folderInfo.name });

      if (currentId === driveRootId || !folderInfo.parents || folderInfo.parents.length === 0) break;
      currentId = folderInfo.parents[0];
    }

    return { id: id, name: path[path.length - 1].name, path: path };
  } catch (e) {
    console.error('getCurrentStartFolderInfo error: ' + e);
    const drId = getDriveRootIdOnce();
    return { id: drId, name: 'マイドライブ', path: [{ id: drId, name: 'マイドライブ' }] };
  }
}

/** スタートフォルダの設定を保存 (PropertiesServiceへ移行) */
function updateStartFolder(idOrUrl) {
  try {
    let id = idOrUrl;
    if (idOrUrl.indexOf('http') !== -1) {
      id = extractFolderIdFromUrl(idOrUrl);
    }
    if (!id) throw new Error('有効なフォルダIDまたはURLではありません');

    // 「すべて表示（ルート）」の場合は検証をスキップして保存
    if (id === '__ROOT__') {
      PropertiesService.getUserProperties().deleteProperty('START_FOLDER_ID');
      return { success: true, id: id };
    }

    // 【修正】ショートカットIDの場合は実体IDに解決して保存する
    try {
      const file = Drive.Files.get(id, { fields: 'mimeType, shortcutDetails' });
      if (file.mimeType === 'application/vnd.google-apps.shortcut' && file.shortcutDetails) {
        id = file.shortcutDetails.targetId;
      }
    } catch (ignore) {
      // 取得エラー（権限不足など）の場合は元のIDをそのまま試行するために無視
    }

    PropertiesService.getUserProperties().setProperty('START_FOLDER_ID', id);

    return { success: true, id: id };
  } catch (e) {
    return { success: false, message: e.message };
  }
}

/**
 * 【スタートフォルダ切替専用】フォルダリストを取得する
 * ※既存のキャッシュ・モード設定を一切参照しない独立した関数
 * ※マイドライブ全体のフォルダのみを返す
 */
function getFolderListForSelector() {
  try {
    const driveRootId = getDriveRootIdOnce();

    // マイドライブの全フォルダをキャッシュなしで直接取得
    const myFolderMap = new Map();
    let token = null;
    do {
      const res = Drive.Files.list({
        q: "mimeType = 'application/vnd.google-apps.folder' and trashed = false and 'me' in owners",
        fields: 'nextPageToken, files(id, name, parents)',
        pageSize: 1000,
        pageToken: token
      });
      (res.files || []).forEach(f => {
        myFolderMap.set(f.id, { name: f.name, parents: f.parents || [] });
      });
      token = res.nextPageToken;
    } while (token);

    // マイドライブ自体を追加
    if (!myFolderMap.has(driveRootId)) {
      myFolderMap.set(driveRootId, { name: 'マイドライブ', parents: [] });
    }

    // Map → [id, name, canDelete, parents] 形式の配列に変換
    const myFolders = [];
    myFolderMap.forEach((info, id) => {
      myFolders.push([id, id === driveRootId ? 'マイドライブ' : info.name, info.parents.length > 0, info.parents]);
    });

    return {
      success: true,
      myFolders: myFolders,
      driveRootId: driveRootId,
      currentStartFolderId: getDynamicStartFolderId()
    };
  } catch (e) {
    console.error('getFolderListForSelector error: ' + e);
    return { success: false, message: e.message };
  }
}

/** 除外フォルダIDリストを取得（実行内メモ化済み） */
function getExcludeFolders() {
  if (_globalExcludeFoldersCache !== null) return _globalExcludeFoldersCache;
  try {
    const saved = PropertiesService.getUserProperties().getProperty('EXCLUDE_FOLDER_IDS');
    _globalExcludeFoldersCache = JSON.parse(saved || '[]');
    return _globalExcludeFoldersCache;
  } catch (e) {
    _globalExcludeFoldersCache = [];
    return [];
  }
}

/** 除外フォルダIDリストを保存 */
function updateExcludeFolders(folderIds) {
  try {
    if (!Array.isArray(folderIds)) throw new Error('データ形式が正しくありません');
    _globalExcludeFoldersCache = folderIds; // メモ化キャッシュも更新
    // 【最適化】setProperties で1回のAPI呼び出しにまとめる
    PropertiesService.getUserProperties().setProperties({
      'EXCLUDE_FOLDER_IDS': JSON.stringify(folderIds),
      'FORCE_REFRESH_FLAG': 'true'
    });
    return { success: true, count: folderIds.length };
  } catch (e) {
    return { success: false, message: e.message };
  }
}

/** 【新機能】スタートフォルダ選択用の全オプション取得（現在のフォルダを先頭にする） */
function getStartFolderOptions() {
  try {
    const driveRootId = getDriveRootIdOnce();
    // 強制的にマイドライブ全体のフォルダ情報を取得（フィルタリングをバイパス）
    const folderMap = getAllFoldersInfoMap(false, true);
    // マイドライブの本当のルートを起点にリストを生成
    const allFolders = getAllFoldersList(folderMap, driveRootId);

    // 現在のフォルダを解決
    const rawId = getDynamicStartFolderId();
    const currentId = rawId || 'root';

    let currentFolderMatch = null;
    if (rawId === null) {
      // 未設定（null）の場合は「すべて表示」として定義
      currentFolderMatch = ['__ROOT__', 'すべて表示', 0, []];
    } else {
      currentFolderMatch = allFolders.find(f => f[0] === currentId);
      if (!currentFolderMatch && currentId === 'root') {
        currentFolderMatch = [driveRootId, 'マイドライブ', 0, []];
      } else if (!currentFolderMatch) {
        try {
          const folder = Drive.Files.get(currentId, { fields: 'id, name' });
          currentFolderMatch = [folder.id, folder.name, 0, []];
        } catch (e) {
          currentFolderMatch = [driveRootId, 'マイドライブ', 0, []];
        }
      }
    }

    // デフォルト（マイドライブ）がリストにない場合は追加
    if (!allFolders.some(f => f[0] === driveRootId)) {
      allFolders.unshift([driveRootId, 'マイドライブ', 0, []]);
    }

    return {
      success: true,
      current: currentFolderMatch,
      // 【重要】重複防止のため、リスト自体からは現在のフォルダを除外する
      allFolders: allFolders.filter(f => f[0] !== currentFolderMatch[0])
    };
  } catch (e) {
    return { success: false, message: e.message };
  }
}
function extractFolderIdFromUrl(url) {
  if (!url) return null;
  // URL以外の文字列（IDそのもの）が入力されている場合への配慮
  if (url.indexOf('http') === -1) return url;

  // 通常のドライブURL: .../folders/ID
  const match = url.match(/[\/\=]([a-zA-Z0-9-_]{25,})[?&/]?/);
  return match ? match[1] : null;
}

const CACHE_KEY_FOLDERS = 'FOLDERS_CACHE_CHUNK_v115_';
const CACHE_CHUNK_COUNT_FOLDERS = 10;

// 【復旧】GASの100KB制限を超えるデータをチャンク分割してキャッシュするユーティリティ
const CacheManager = {
  save: function (baseKey, chunkCount, data, expirationInSeconds = 21600) {
    try {
      const cache = CacheService.getUserCache();
      const jsonStr = JSON.stringify(data);
      const chunkSize = 100000; // 安全マージンを取って約100KB以内
      const chunks = [];

      for (let i = 0; i < jsonStr.length; i += chunkSize) {
        chunks.push(jsonStr.substring(i, i + chunkSize));
      }

      if (chunks.length > chunkCount) {
        console.warn(`Data too large: requires ${chunks.length} chunks, but limit is ${chunkCount}.`);
        return false;
      }

      const cacheObj = {};
      for (let i = 0; i < chunkCount; i++) {
        const key = baseKey + i;
        if (i < chunks.length) {
          cacheObj[key] = chunks[i];
        } else {
          cache.remove(key); // 不要になった古いチャンクを消去
        }
      }

      if (Object.keys(cacheObj).length > 0) {
        cache.putAll(cacheObj, expirationInSeconds);
      }
      return true;
    } catch (e) {
      console.error('CacheManager.save error: ', e);
      return false;
    }
  },

  load: function (baseKey, chunkCount) {
    try {
      const cache = CacheService.getUserCache();
      const keys = [];
      for (let i = 0; i < chunkCount; i++) {
        keys.push(baseKey + i);
      }

      const cachedChunks = cache.getAll(keys);
      let jsonStr = '';
      for (let i = 0; i < chunkCount; i++) {
        const chunk = cachedChunks[baseKey + i];
        if (chunk) {
          jsonStr += chunk;
        } else {
          break; // 連続していなければ終了
        }
      }

      if (jsonStr) {
        return JSON.parse(jsonStr);
      }
      return null;
    } catch (e) {
      console.error('CacheManager.load error: ', e);
      return null;
    }
  },

  clear: function (baseKey, chunkCount) {
    try {
      const cache = CacheService.getUserCache();
      const keys = [];
      for (let i = 0; i < chunkCount; i++) {
        keys.push(baseKey + i);
      }
      cache.removeAll(keys);
    } catch (e) { }
  }
};

// 【高速化】スクリプト実行中のAPIキャッシュ
var _globalRootFolderCache = null;
var _globalDriveRootIdCache = null;
var _globalFolderMapCache = null;       // 【最適化】実行内メモリキャッシュ（同一実行内の重複CacheService呼び出しを排除）
var _globalExcludeFoldersCache = null;  // 【最適化】getExcludeFolders のメモ化（PropertiesService+JSON.parse を1回に）

function getRootFolderOnce() {
  if (_globalRootFolderCache) return _globalRootFolderCache;

  const dynamicId = getDynamicStartFolderId();
  let id = dynamicId || 'root';

  try {
    const folder = Drive.Files.get(id, {
      fields: 'id, name, webViewLink'
    });
    _globalRootFolderCache = {
      getId: () => folder.id,
      getName: () => (id === 'root' ? 'マイドライブ' : folder.name),
      getUrl: () => folder.webViewLink
    };
  } catch (e) {
    console.error('フォルダ取得エラー: ' + e);
    const fallback = id === 'root' ? DriveApp.getRootFolder() : DriveApp.getFolderById(id);
    _globalRootFolderCache = {
      getId: () => fallback.getId(),
      getName: () => fallback.getName(),
      getUrl: () => fallback.getUrl()
    };
  }
  return _globalRootFolderCache;
}

function getDriveRootIdOnce() {
  if (_globalDriveRootIdCache) return _globalDriveRootIdCache;
  const root = Drive.Files.get('root', { fields: 'id' });
  _globalDriveRootIdCache = root.id;
  return _globalDriveRootIdCache;
}

// スプレッドシート連携用メニューと関数を削除（独立化のため）
function doGet(e) {
  // 1. データ取得API (JSON)
  if (e && e.parameter && e.parameter.action === 'getData') {
    const ignoreCache = e.parameter.refresh === 'true';
    return ContentService.createTextOutput(JSON.stringify(getAppData(ignoreCache))).setMimeType(ContentService.MimeType.JSON);
  }

  if (e && e.parameter && e.parameter.action === 'syncData') {
    return ContentService.createTextOutput(JSON.stringify(getAppData())).setMimeType(ContentService.MimeType.JSON);
  }

  // 2. アプリ本体 (デフォルト表示)
  const template = HtmlService.createTemplateFromFile('index');
  const scriptUrl = ScriptApp.getService().getUrl();

  // 【究極の高速化：第2段階】JSON処理を一切介さず、キャッシュ文字列をそのまま流し込む
  const rawCachedJson = loadAppDataFromCacheRaw_();
  let dataObj = rawCachedJson ? JSON.parse(rawCachedJson) : { files: [], folders: [], folderList: [], ghost: true };

  // 【V194】scriptUrl を初期データに含めることで、インクルードファイル内でのテンプレート評価を不要にする
  dataObj.scriptUrl = scriptUrl;

  // JSON内の制御文字や HTML タグ分断を防ぐための徹底的なエスケープ
  template.initialDataJsonStr = safeJsonStringifyRaw_(JSON.stringify(dataObj));

  return template.evaluate()
    .setTitle('Google Drive')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

/**
 * 文字列（JSON）に含まれる制御文字や HTML タグ分断文字を安全にエスケープする
 */
function safeJsonStringifyRaw_(str) {
  if (!str) return 'null';
  // 制御文字 (0-31), DEL(127), および </script> タグの分断防止
  // すべての非ASCII文字も \uXXXX 形式にすることで、テンプレート注入時の安全性を最大化
  return str.replace(/[\u0000-\u001f\u007f-\uffff]/g, function (c) {
    return "\\u" + ("000" + c.charCodeAt(0).toString(16)).slice(-4);
  }).replace(/<\/script/gi, '<\\/script');
}



/**
 * 【Hyper-Sync V2】アプリ起動・同期用の全データ取得
 * 1リクエストで全ての情報を最速で返す統合版。（マイドライブ専用）
 */
function getAppData(ignoreCache = false) {
  const t0 = Date.now();
  const forceRefresh = PropertiesService.getUserProperties().getProperty('FORCE_REFRESH_FLAG');
  if (!ignoreCache && !forceRefresh) {
    const cachedData = loadAppDataFromCache_();
    if (cachedData) return cachedData;
  }

  // 基本情報の取得を先に行う
  const currentRoot = getRootFolderOnce();
  const currentRootId = currentRoot.getId();
  const driveRootId = getDriveRootIdOnce();
  const startFolderId = getDynamicStartFolderId();

  // [一括取得] マイドライブの全データを取得
  let files = [];
  let folderMap = new Map();
  const allData = fetchAllDriveDataCombined_();
  files = allData.files;
  folderMap = allData.folderMap;

  try {
    // フォルダリストの構築
    const folderList = getAllFoldersList(folderMap, driveRootId);

    const result = {
      files: files,
      folders: getOrderedFolderNames(folderMap),
      folderList: folderList,
      stamps: getStampPresets(),
      rootId: currentRootId,
      driveRootId: driveRootId,
      isSharedRoot: false,
      rootName: (currentRootId === driveRootId) ? 'マイドライブ' : currentRoot.getName(),
      rawStartFolderId: startFolderId,
      syncVersion: '165' // クライアント側のキャッシュ強制更新用
    };

    if (ignoreCache || forceRefresh) { // 【V207】フラグ起因のフル取得時もフラグを削除する
      PropertiesService.getUserProperties().deleteProperty('FORCE_REFRESH_FLAG');
    }
    saveAppDataToCache_(result);
    return result;

  } catch (e) {
    console.error('getAppData Optimized Error: ' + e);
    // 最小限のフォールバック
    return { files: files, folderList: [], error: e.toString() };
  }
}

// 分割関数は廃止
function getMyDriveData(ignoreCache) { return getAppData(ignoreCache); }


/** サーバー側キャッシュからデータを復元（超高速CacheService専用） */
function loadAppDataFromCache_() {
  const jsonStr = loadAppDataFromCacheRaw_();
  if (!jsonStr) return null;

  try {
    const data = JSON.parse(jsonStr);
    // 互換性チェック（最低限 files があること）
    return (data && data.files) ? data : null;
  } catch (e) {
    console.error('Cache parse error:', e);
    return null;
  }
}

/** 【新設：第2段階】キャッシュを文字列（生データ）のまま取得する（高速配信用） */
function loadAppDataFromCacheRaw_() {
  const cache = CacheService.getScriptCache();
  const countStr = cache.get('APP_DATA_CHUNK_COUNT');
  if (!countStr) return null;

  let jsonStr = '';
  const count = parseInt(countStr, 10);
  const keys = Array.from({ length: count }, (_, i) => 'APP_DATA_CHUNK_' + i);
  const results = cache.getAll(keys);

  for (let i = 0; i < count; i++) {
    const chunk = results['APP_DATA_CHUNK_' + i];
    if (chunk) jsonStr += chunk;
    else return null;
  }
  return jsonStr;
}

/** データをサーバー側に保存（高速CacheService専用へ一本化し10秒遅延を排除） */
function saveAppDataToCache_(data) {
  if (!data) return;
  try {
    const jsonStr = JSON.stringify(data);

    // CacheService 用 (100KB制限)
    const cacheSize = 90000;
    const cacheChunks = [];
    for (let i = 0; i < jsonStr.length; i += cacheSize) {
      cacheChunks.push(jsonStr.substring(i, i + cacheSize));
    }

    const cache = CacheService.getScriptCache();

    // CacheService 保存のみ実行
    const cacheObj = {};
    cacheChunks.forEach((c, idx) => cacheObj['APP_DATA_CHUNK_' + idx] = c);
    cacheObj['APP_DATA_CHUNK_COUNT'] = cacheChunks.length.toString();
    cache.putAll(cacheObj, 21600); // 6時間

    console.log('Cache saved to CacheService. Chunks:', cacheChunks.length);
  } catch (e) {
    console.warn('Cache save error:', e);
  }
}

/** 【新設：案A】サーバー側のアプリデータキャッシュを強制クリア */
function clearAppDataCache_() {
  try {
    const cache = CacheService.getScriptCache();
    const countStr = cache.get('APP_DATA_CHUNK_COUNT');
    if (countStr) {
      const count = parseInt(countStr, 10);
      const keys = ['APP_DATA_CHUNK_COUNT'];
      for (let i = 0; i < count; i++) {
        keys.push('APP_DATA_CHUNK_' + i);
      }
      cache.removeAll(keys);
      console.log('App data cache cleared.');
    }
    // フォルダ構成キャッシュもクリア
    try {
      const userCache = CacheService.getUserCache();
      const folderKeys = [];
      for (let i = 0; i < 20; i++) { // 安全のため多めに（CACHE_CHUNK_COUNT_FOLDERSより多め）
        folderKeys.push('FOLDERS_CACHE_CHUNK_v115_' + i);
      }
      userCache.removeAll(folderKeys);
      console.log('Folder structure cache swept.');
    } catch (e) {
      console.warn('Folder cache clear error:', e);
    }
  } catch (e) {
    console.warn('Cache clear error:', e);
  }
}
/**
 * 【最適化】キャッシュクリア + FORCE_REFRESH_FLAG セットを1回の PropertiesService API 呼び出しで実施
 */
function clearCacheAndSetFlag_() {
  clearAppDataCache_();
  PropertiesService.getUserProperties().setProperty('FORCE_REFRESH_FLAG', 'true');
}

/**
 * 特定のフォルダ直下のファイルのみを取得（APIスキャン抑制による超高速取得）
 */
function getFileListForFolder_(folderId) {
  const fileDataList = [];
  const query = `trashed = false and mimeType != 'application/vnd.google-apps.folder' and '${folderId}' in parents`;

  let token = null;
  do {
    const res = Drive.Files.list({
      q: query,
      fields: 'nextPageToken, files(id, name, mimeType, createdTime, modifiedTime, webViewLink)',
      pageSize: 1000,
      pageToken: token
    });

    if (res.files) {
      res.files.forEach(f => {
        const type = detectFileType_(f.mimeType, f.name);
        fileDataList.push({
          id: f.id,
          name: f.name,
          type: type,
          createDate: f.createdTime,
          updateDate: f.modifiedTime,
          url: f.webViewLink,
          folderId: folderId
        });
      });
    }
    token = res.nextPageToken;
  } while (token);

  return fileDataList;
}



function moveToTrash(fileId, targetUrl) {
  if (!fileId && !targetUrl) return { success: false, message: '不足' };
  try {
    let id = fileId;
    if (!id && targetUrl) {
      const p = [/\/d\/([a-zA-Z0-9_-]+)/, /id=([a-zA-Z0-9_-]+)/, /\/(?:prompts|models)\/([a-zA-Z0-9_-]+)/];
      for (const reg of p) {
        const m = targetUrl.match(reg);
        if (m) { id = m[1]; break; }
      }
    }
    if (!id) return { success: false, message: '不可' };

    // 共通関数を利用
    return deleteFiles([id]);
  } catch (e) { return { success: false, message: e.toString() }; }
}

// 【最適化】getAllFilesInfoFromDriveAPI を削除 — fetchAllDriveDataCombined_() が同等機能を担っておりデッドコードだった

function getOrderedFolderNames(providedMap) {
  const folderMap = providedMap || getAllFoldersInfoMap();
  const rootId = getRootFolderOnce().getId();
  const orderedNames = [];
  const childrenMap = new Map();
  folderMap.forEach((info, id) => {
    (info.parents || []).forEach(pId => {
      if (!childrenMap.has(pId)) childrenMap.set(pId, []);
      childrenMap.get(pId).push(id);
    });
  });
  const visited = new Set();
  const queue = [rootId];
  while (queue.length > 0) {
    const currentId = queue.shift();
    if (visited.has(currentId)) continue;
    visited.add(currentId);
    const folder = folderMap.get(currentId);
    if (folder) orderedNames.push(currentId === rootId ? 'マイドライブ' : folder.name);
    const childrenIds = childrenMap.get(currentId) || [];
    childrenIds.forEach(cId => queue.push(cId));
  }
  return [...new Set(orderedNames)];
}

function getAllFoldersInfoMap(ignoreCache = false, forceFullDrive = false) {

  // 【最適化】実行内メモリキャッシュ（同一GAS実行内に複数回呼ばれるケースをゼロコストで返す）
  if (!ignoreCache && !forceFullDrive && _globalFolderMapCache) {
    return _globalFolderMapCache;
  }

  // 【黄金期】 ignoreCache が false の場合のみ、二段キャッシュから復元を試みる
  if (!ignoreCache && !forceFullDrive) {
    const cached = CacheManager.load(CACHE_KEY_FOLDERS, CACHE_CHUNK_COUNT_FOLDERS);
    if (cached && cached.mapData) {
      _globalFolderMapCache = new Map(cached.mapData);
      return _globalFolderMapCache;
    }
  }

  const fullMap = new Map();
  const root = getRootFolderOnce();
  const rootId = root.getId();
  const driveRootId = getDriveRootIdOnce();

  let token = null;
  let query = "mimeType = 'application/vnd.google-apps.folder' and trashed = false and 'me' in owners";

  do {
    const res = Drive.Files.list({
      q: query,
      fields: 'nextPageToken, files(id, name, webViewLink, parents, capabilities, ownedByMe)',
      pageSize: 1000,
      pageToken: token
    });
    if (res.files) res.files.forEach(f => {
      const caps = f.capabilities || {};
      // 自分がオーナーであるか、あるいは削除/ゴミ箱移動のいずれかの権限を持っていればTrue
      const deletable = (f.ownedByMe === true) || caps.canDelete || caps.canTrash || caps.canMoveToTrash || false;

      fullMap.set(f.id, {
        name: f.name,
        url: f.webViewLink,
        parents: f.parents || [],
        canDelete: deletable
      });
    });
    token = res.nextPageToken;
  } while (token);

  // 【再起フィルタリング】起点フォルダ配下のフォルダのみを抽出
  const filteredMap = new Map();
  filteredMap.set(rootId, { name: root.getName(), url: root.getUrl(), parents: [] });

  // forceFullDrive が true の場合はフィルタリングをスキップしてすべて返す
  if (forceFullDrive) {
    fullMap.forEach((info, id) => filteredMap.set(id, info));
  } else if (getDynamicStartFolderId()) {
    // START_FOLDER_ID から辿れる全フォルダを特定
    // 【最速化】親子関係の逆引きマップを作成
    const childrenMap = new Map();
    fullMap.forEach((info, id) => {
      (info.parents || []).forEach(pId => {
        if (!childrenMap.has(pId)) childrenMap.set(pId, []);
        childrenMap.get(pId).push(id);
      });
    });

    const allowedIds = new Set([rootId]);
    let queue = [rootId];

    // BFS（幅優先探索）で全子孫を特定
    while (queue.length > 0) {
      const nextQueue = [];
      for (const currentId of queue) {
        const children = childrenMap.get(currentId) || [];
        for (const childId of children) {
          if (!allowedIds.has(childId)) {
            allowedIds.add(childId);
            filteredMap.set(childId, fullMap.get(childId));
            nextQueue.push(childId);
          }
        }
      }
      queue = nextQueue;
    }
  } else {
    // 起点指定がなければ全て
    fullMap.forEach((info, id) => filteredMap.set(id, info));
  }

  // 【黄金期】PropertiesService と CacheService に二段構えで保存
  try {
    const folders = getOrderedFolderNames(filteredMap);
    const folderList = getAllFoldersList(filteredMap);
    CacheManager.save(CACHE_KEY_FOLDERS, CACHE_CHUNK_COUNT_FOLDERS, {
      folders: folders,
      folderList: folderList,
      mapData: Array.from(filteredMap.entries())
    });
  } catch (e) { console.error('DoubleCache Error: ' + e); }

  // 【最適化】実行内メモリキャッシュに保存
  if (!forceFullDrive) {
    _globalFolderMapCache = filteredMap;
  }

  return filteredMap;
}

/**
 * スプレッドシートへ出力 (サイレント実行対応・高速版)
 */
function outputToSpreadsheet(clearOnly = false) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getActiveSheet();

  // 1. シートをクリア
  const lastRow = sheet.getLastRow();
  if (lastRow > 1) {
    sheet.getRange(2, 1, lastRow - 1, 6).clearContent().setBorder(false, false, false, false, false, false);
  }
  if (clearOnly) return { success: true };

  // 2. データを取得（基本はキャッシュから爆速取得）
  const data = getAppData();
  const files = data.files || [];
  if (files.length === 0) return { success: false, message: 'データがありません' };

  // 3. 書き込み用に整形 (30年の知恵：一括setValues)
  // [name, createDate, updateDate, url, folderName]
  const listData = files.map(f => [
    f[1], // name
    Utilities.formatDate(new Date(f[4]), "JST", "yyyy-MM-dd HH:mm:ss"), // create
    Utilities.formatDate(new Date(f[3]), "JST", "yyyy-MM-dd HH:mm:ss"), // update
    f[5], // url
    (getAllFoldersInfoMap().get(f[6]) || { name: '不明' }).name // folderName
  ]);

  // 4. 一括書き込み
  sheet.getRange(2, 1, listData.length, 5).setValues(listData);
  sheet.getRange(1, 1, listData.length + 1, 5).setBorder(true, true, true, true, true, true, 'black', SpreadsheetApp.BorderStyle.SOLID);

  return { success: true, count: listData.length };
}

/**
 * サイレント実行用：メニューからのエントリポイント
 */
function runSilent(action, params = {}) {
  const template = HtmlService.createTemplateFromFile('SilentRunner');
  template.action = action;
  template.paramsJson = JSON.stringify(params);

  const ui = HtmlService.createHtmlOutput(template.evaluate())
    .setTitle('処理を実行中...')
    .setWidth(250)
    .setHeight(50);

  SpreadsheetApp.getUi().showSidebar(ui);
}

/**
 * 各メニューのアクション（サイレント呼び出しへの橋渡し）
 */
function menuAction_FetchAll() { runSilent('fetchAll'); }
function menuAction_Clear() { runSilent('clear'); }

/**
 * サイレントサイドバーからの実際の実行命令
 */
function executeBacksideAction(action, params) {
  if (action === 'fetchAll') {
    return outputToSpreadsheet(false);
  } else if (action === 'clear') {
    return outputToSpreadsheet(true);
  }
  return { success: false, message: '不明なアクション' };
}

/** カスタムメニューの作成（サイレント化対応） */
function onOpen() {
  const ui = SpreadsheetApp.getUi();
  ui.createMenu('取得メニュー')
    .addItem('マイドライブの一覧（サイレント）', 'menuAction_FetchAll')
    .addSeparator()
    .addItem('シートをクリア（サイレント）', 'menuAction_Clear')
    .addToUi();
}

/**
 * 【爆速化ヘルパー】指定したIDのファイル情報を、フロントエンドが期待する形式で取得します。
 */
function getFileInfo_(fileId) {
  const file = Drive.Files.get(fileId, { fields: 'id, name, mimeType, createdTime, modifiedTime, webViewLink, parents, shared' });
  const rootFolder = getRootFolderOnce();
  const rootId = rootFolder.getId();

  let fName = getDynamicStartFolderId() ? rootFolder.getName() : 'マイドライブ';
  let fUrl = rootFolder.getUrl();

  if (file.parents && file.parents.length > 0) {
    const parentId = file.parents[0];
    if (parentId !== rootId) {
      // 【神速】フォルダマップから一撃で解決（API通信をスキップ）
      const folderMap = getAllFoldersInfoMap();
      const p = folderMap.get(parentId);
      if (p) {
        fName = p.name;
        fUrl = p.url;
      } else {
        try {
          // キャッシュにない場合のみDrive API
          const parent = Drive.Files.get(parentId, { fields: 'name, webViewLink' });
          fName = parent.name;
          fUrl = parent.webViewLink;
        } catch (e) { }
      }
    }
  }

  const type = detectFileType_(file.mimeType || '', file.name || '');

  return {
    id: file.id,
    name: file.name,
    type: type,
    createDate: file.createdTime,
    updateDate: file.modifiedTime,
    url: file.webViewLink,
    folderName: fName,
    folderId: (file.parents && file.parents.length > 0) ? file.parents[0] : rootId,
    folderUrl: fUrl,
    shared: file.shared
  };
}

function renameFile(fileId, newName) {
  if (!fileId || !newName) return { success: false, message: 'IDまたは新しい名前が不足しています' };
  try {
    Drive.Files.update({ name: newName }, fileId, null);
    const info = getFileInfo_(fileId);

    clearCacheAndSetFlag_(); // キャッシュ破棄 + フラグ
    return { success: true, file: packFileInfo_(info) };
  } catch (e) {
    return { success: false, message: e.message };
  }
}


/**
 * 【軽量化】フロントエンドに送るファイル情報を配列形式に圧縮します。
 * [id, name, type, updateDate(ms), createDate(ms), url, folderId]
 * 【最適化】updateDate/createDate が既に数値(ms)の場合はDate変換をスキップ
 */
function packFileInfo_(i) {
  return [
    i.id,
    i.name,
    i.type,
    typeof i.updateDate === 'number' ? i.updateDate : new Date(i.updateDate).getTime(),
    typeof i.createDate === 'number' ? i.createDate : new Date(i.createDate).getTime(),
    i.url,
    i.folderId
  ];
}

/**
 * 【軽量化】フォルダ情報を配列形式にパッキング
 * [id, name, canDelete(0/1), parents[]]
 */
function packFolderInfo_(id, name, canDelete, parents) {
  return [
    id,
    name,
    canDelete ? 1 : 0,
    parents || []
  ];
}


/** 一括削除（ゴミ箱へ移動）【V290 最適化】エラー耐性追加（1件失敗しても残りは続行） */
function deleteFiles(fileIds) {
  if (!Array.isArray(fileIds) || fileIds.length === 0) return { success: false, message: '対象がありません' };
  const errors = [];
  fileIds.forEach(id => {
    try {
      Drive.Files.update({ trashed: true }, id, null);
    } catch (e) {
      console.error('deleteFiles error for ' + id + ':', e.message);
      errors.push(id);
    }
  });

  clearCacheAndSetFlag_(); // キャッシュ破棄 + フラグ
  if (errors.length > 0) {
    return { success: true, message: errors.length + '件でエラー', errorIds: errors };
  }
  return { success: true };
}

/**
 * 【シンプル化】共有を「確実にON」にして情報を返す（OFFにはしない）
 */
function ensureFileShared(fileId) {
  if (!fileId) return { success: false, message: 'ID不足' };
  try {
    // Drive API で共有権限を追加（リンクを知っている全員に閲覧権限）
    try {
      Drive.Permissions.create({
        role: 'reader',
        type: 'anyone'
      }, fileId);
    } catch (e) {
      // すでに共有済み、または権限不足などの場合はスキップ
    }

    const info = getFileInfo_(fileId);
    // 強制更新フラグを立てて、次回一覧取得時に最新情報を反映させる


    return {
      success: true,
      file: packFileInfo_(info)
    };
  } catch (e) {
    console.error('Sharing ensure failed:', e.message);
    return { success: false, message: e.toString() };
  }
}

/** 一括コピー (V206: GASファイルをコピー後に元フォルダへ移動) */
function copyFiles(fileIds) {
  if (!Array.isArray(fileIds) || fileIds.length === 0) return { success: false, message: '対象がありません' };
  const results = [];
  try {
    const timestamp = Utilities.formatDate(new Date(), "JST", "yyyyMMdd HHmmss");
    for (const id of fileIds) {
      const source = Drive.Files.get(id, { fields: 'name,parents' });
      const originalName = source.name || '無題のファイル';
      // 元のフォルダIDを取得（移動先として使用する）
      const originalParentId = (source.parents && source.parents.length > 0) ? source.parents[0] : null;

      let newName;
      const lastDotIndex = originalName.lastIndexOf('.');
      if (lastDotIndex > 0) {
        const baseName = originalName.substring(0, lastDotIndex);
        const extension = originalName.substring(lastDotIndex);
        newName = baseName + ' ' + timestamp + extension;
      } else {
        newName = originalName + ' ' + timestamp;
      }

      // コピーを実行（GASファイルはマイドライブルートに作成される）
      const resource = { name: newName };
      const newFile = Drive.Files.copy(resource, id, { fields: 'id, name, webViewLink, createdTime, modifiedTime, mimeType, parents' });

      // 【V206】元のフォルダへ移動（GASファイルのマイドライブ保存問題を修正）
      let actualParentId = (newFile.parents && newFile.parents.length > 0) ? newFile.parents[0] : '';
      if (originalParentId && actualParentId !== originalParentId) {
        try {
          Drive.Files.update(
            {},
            newFile.id,
            null,
            {
              addParents: originalParentId,
              removeParents: actualParentId,
              fields: 'id, parents'
            }
          );
          actualParentId = originalParentId;
        } catch (moveErr) {
          console.error('Move after copy failed: ' + moveErr.message);
        }
      }

      const packedFile = [
        newFile.id,
        newFile.name,
        detectFileType_(newFile.mimeType, newFile.name),
        new Date(newFile.modifiedTime).getTime(),
        new Date(newFile.createdTime).getTime(),
        newFile.webViewLink,
        actualParentId
      ];
      results.push(packedFile);
    }

    clearCacheAndSetFlag_(); // キャッシュ破棄 + フラグ
    return { success: true, files: results };
  } catch (e) {
    return { success: false, message: e.message };
  }
}

/** 単体コピー（クイックメニュー用） */
function copyFile(fileId) {
  if (!fileId) return { success: false, message: 'ID不足' };
  return copyFiles([fileId]);
}

/**
 * ファイル削除（ゴミ箱へ移動）
 * フロントエンドからの呼び出し用エイリアス
 */
function moveToTrash(id, url) {
  return deleteFiles([id]);
}

function getAllFoldersList(providedMap, customRootId = null) {
  const map = providedMap || getAllFoldersInfoMap();
  const driveRootId = getDriveRootIdOnce();
  const startFolderId = getDynamicStartFolderId();

  // エントリポイントはマイドライブのルート（とスタートフォルダ）
  const entryPoints = [driveRootId];
  if (startFolderId && !entryPoints.includes(startFolderId)) {
    entryPoints.push(startFolderId);
  }

  const childrenMap = new Map();
  map.forEach((info, id) => {
    (info.parents || []).forEach(pId => {
      if (!childrenMap.has(pId)) childrenMap.set(pId, []);
      childrenMap.get(pId).push(id);
    });
  });

  const list = [];
  const visited = new Set();
  let queue = [...entryPoints];

  while (queue.length > 0) {
    const nextQueue = [];
    for (const currentId of queue) {
      if (visited.has(currentId)) continue;

      const folder = map.get(currentId);
      if (folder) {
        visited.add(currentId);
        let displayName = folder.name;
        if (currentId === driveRootId) displayName = 'マイドライブ';

        list.push(packFolderInfo_(
          currentId,
          displayName,
          folder.canDelete,
          folder.parents
        ));
      }

      const children = childrenMap.get(currentId) || [];
      children.sort((a, b) => {
        const nameA = map.get(a) ? map.get(a).name : '';
        const nameB = map.get(b) ? map.get(b).name : '';
        return nameA.localeCompare(nameB, 'ja');
      });

      for (const childId of children) {
        nextQueue.push(childId);
      }
    }
    queue = nextQueue;
  }

  // 【救済措置】どこからも辿れなかった「孤立フォルダ」をルート直下として表示
  map.forEach((info, id) => {
    if (!visited.has(id)) {
      list.push(packFolderInfo_(id, info.name, info.canDelete, [driveRootId]));
      visited.add(id);
    }
  });

  return list;
}


/** フォルダー名からフォルダーIDを特定するヘルパー（高度な高速化のためにキャッシュを利用） */
function getFolderIdByName_(folderName) {
  if (!folderName || folderName === 'マイドライブ' || folderName === 'マイドライブ (ルート)') return getRootFolderOnce().getId();

  // キャッシュされたフォルダーマップからIDを検索
  const folderMap = getAllFoldersInfoMap();
  for (let [id, info] of folderMap.entries()) {
    if (info.name === folderName) return id;
  }
  return null;
}

function createFolder(folderName, parentId = null) {
  if (!folderName) return { success: false, message: 'フォルダ名が不足しています' };
  try {
    let actualParentId = parentId;
    const realRootId = getRootFolderOnce().getId();

    // 【神速】parentIdが名前に見えればIDに解決（後方互換性と柔軟性のため）
    if (parentId && parentId !== 'root' && parentId !== realRootId && parentId !== 'all' && (parentId.length < 15 || !/^[A-Za-z0-9_-]+$/.test(parentId))) {
      const foundId = getFolderIdByName_(parentId);
      if (foundId) actualParentId = foundId;
    }

    if (!actualParentId || actualParentId === 'root' || actualParentId === 'all') {
      actualParentId = realRootId;
    }

    // Drive API でフォルダ作成
    const folder = Drive.Files.create({
      name: folderName,
      mimeType: 'application/vnd.google-apps.folder',
      parents: [actualParentId]
    });

    clearAppDataCache_(); // キャッシュ破棄
    return { success: true, folder: { id: folder.id, name: folder.name } };
  } catch (e) {
    return { success: false, message: e.message };
  }
}

/** ゴミ箱の一覧を取得 */
function getTrashedFiles() {
  const info = [];
  let token = null;
  do {
    const res = Drive.Files.list({
      q: "trashed = true and 'me' in owners",
      fields: 'nextPageToken, files(id, name, mimeType, createdTime, modifiedTime, webViewLink, parents, explicitlyTrashed)',
      pageSize: 1000,
      pageToken: token
    });

    if (res.files) {
      res.files.forEach(file => {
        // 直接ゴミ箱に捨てられたアイテムのみを表示（親が捨てられたことによる連動削除は除外）
        if (file.explicitlyTrashed === false) {
          return;
        }

        const mime = file.mimeType || '';
        let type = 'file';
        if (mime.includes('spreadsheet')) type = 'spreadsheet';
        else if (mime.includes('document')) type = 'document';
        else if (mime.includes('presentation')) type = 'presentation';
        else if (mime.includes('pdf')) type = 'pdf';
        else if (mime.startsWith('image/')) type = 'image';
        else if (mime.startsWith('video/')) type = 'video';
        else if (mime.includes('zip')) type = 'zip';
        else if (mime.includes('folder')) type = 'folder';

        const packed = packFileInfo_({
          id: file.id,
          name: file.name,
          type: type,
          updateDate: file.modifiedTime,
          createDate: file.createdTime,
          url: file.webViewLink,
          folderId: 'trash'
        });
        info.push(packed);
      });
    }
    token = res.nextPageToken;
  } while (token);
  return info;
}

function moveFile(fileIds, targetFolderId) {
  if (!fileIds || !targetFolderId) return { success: false, message: '引数が不足しています' };
  try {
    const ids = Array.isArray(fileIds) ? fileIds : [fileIds];
    const destinationId = targetFolderId === 'root' ? getRootFolderOnce().getId() : targetFolderId;

    // 【最適化】移動前に1回だけ全情報取得（parents + 表示情報を同時取得）
    // 移動後は name/mimeType/dates/url は変わらないため再フェッチ不要
    const fileInfosBefore = ids.map(id => {
      const file = Drive.Files.get(id, { fields: 'id, name, mimeType, createdTime, modifiedTime, webViewLink, parents' });
      return { id, file };
    });

    // 移動実行（previousParents を事前取得済み情報から構築）
    fileInfosBefore.forEach(({ id, file }) => {
      const previousParents = (file.parents || []).join(',');
      Drive.Files.update({}, id, null, {
        addParents: destinationId,
        removeParents: previousParents
      });
    });

    // 【最適化】移動後の再フェッチ不要 — 変わるのは folderId のみ
    const updatedFiles = fileInfosBefore.map(({ file }) => {
      const type = detectFileType_(file.mimeType || '', file.name || '');
      return packFileInfo_({
        id: file.id,
        name: file.name,
        type: type,
        updateDate: file.modifiedTime,
        createDate: file.createdTime,
        url: file.webViewLink,
        folderId: destinationId
      });
    });

    clearCacheAndSetFlag_(); // キャッシュ破棄 + フラグ
    return { success: true, files: updatedFiles };
  } catch (e) {
    return { success: false, message: e.message };
  }
}

/** ファイルをゴミ箱から復元 */
function restoreFile(fileId) {
  if (!fileId) return { success: false, message: 'IDが不足しています' };
  try {
    Drive.Files.update({ trashed: false }, fileId, null);
    const info = getFileInfo_(fileId);

    clearCacheAndSetFlag_(); // キャッシュ破棄 + フラグ
    return { success: true, file: packFileInfo_(info) };
  } catch (e) {
    return { success: false, message: e.message };
  }
}

function deleteForever(fileId) {
  if (!fileId) return { success: false, message: 'IDが不足しています' };
  try {
    Drive.Files.remove(fileId);

    clearCacheAndSetFlag_(); // キャッシュ破棄 + フラグ
    return { success: true };
  } catch (e) {
    return { success: false, message: e.message };
  }
}

function restoreFiles(fileIds) {
  if (!fileIds || fileIds.length === 0) return { success: false, message: 'IDが不足しています' };
  try {
    const updatedFiles = [];
    fileIds.forEach(id => {
      Drive.Files.update({ trashed: false }, id, null);
      updatedFiles.push(packFileInfo_(getFileInfo_(id)));
    });

    clearCacheAndSetFlag_(); // キャッシュ破棄 + フラグ
    return { success: true, files: updatedFiles };
  } catch (e) {
    return { success: false, message: e.message };
  }
}

function deleteFilesForever(fileIds) {
  if (!fileIds || fileIds.length === 0) return { success: false, message: 'IDが不足しています' };
  try {
    fileIds.forEach(id => {
      Drive.Files.remove(id);
    });

    clearCacheAndSetFlag_(); // キャッシュ破棄 + フラグ
    return { success: true };
  } catch (e) {
    return { success: false, message: e.message };
  }
}

function deleteFolder(id) {
  if (!id) return { success: false, message: 'IDが不足しています' };
  try {
    // Drive API でゴミ箱へ
    Drive.Files.update({ trashed: true }, id, null);

    clearCacheAndSetFlag_(); // キャッシュ破棄 + フラグ（フォルダ削除後のゾンビ防止）

    return { success: true };
  } catch (e) {
    return { success: false, message: e.message };
  }
}

/** Googleファイルを新規作成（名前指定版） - 爆速化 V20 */
function createGoogleFile(type, parentId = null, fileName = null) {
  try {
    let mimeType;
    const defaultName = '無題の' + (type === 'spreadsheet' ? 'スプレッドシート' :
      type === 'document' ? 'ドキュメント' :
        type === 'presentation' ? 'スライド' :
          type === 'form' ? 'フォーム' : 'ファイル');

    const finalName = fileName || defaultName;

    switch (type) {
      case 'spreadsheet': mimeType = 'application/vnd.google-apps.spreadsheet'; break;
      case 'document': mimeType = 'application/vnd.google-apps.document'; break;
      case 'presentation': mimeType = 'application/vnd.google-apps.presentation'; break;
      case 'form': mimeType = 'application/vnd.google-apps.form'; break;
      default: throw new Error('未対応のファイルタイプです');
    }

    // 親フォルダの解決
    let actualParentId = parentId;
    const rootFolder = getRootFolderOnce();
    const realRootId = rootFolder.getId();

    if (!actualParentId || actualParentId === 'root' || actualParentId === 'all') {
      actualParentId = realRootId;
    } else if (actualParentId.length < 15 || !/^[A-Za-z0-9_-]+$/.test(actualParentId)) {
      const foundId = getFolderIdByName_(actualParentId);
      if (foundId) actualParentId = foundId;
    }

    // 【爆速化】Drive API で作成と同時に必要なフィールドをすべて取得
    const fileMetadata = {
      name: finalName,
      mimeType: mimeType,
      parents: [actualParentId]
    };
    const newFile = Drive.Files.create(fileMetadata, null, {
      fields: 'id, name, webViewLink, mimeType, parents, createdTime, modifiedTime, shared'
    });

    // 【爆速化】getFileInfo_ (追加API) を呼ばずに、現在のレスポンスからフロント用データを生成
    const packedFile = [
      newFile.id,
      newFile.name,
      detectFileType_(newFile.mimeType, newFile.name),
      new Date(newFile.modifiedTime).getTime(),
      new Date(newFile.createdTime).getTime(),
      newFile.webViewLink,
      actualParentId
    ];

    clearCacheAndSetFlag_(); // キャッシュ破棄 + フラグ
    return {
      success: true,
      url: newFile.webViewLink,
      file: packedFile
    };
  } catch (e) {
    console.error('createGoogleFile optimized error:', e.message);
    return { success: false, message: e.message };
  }
}

/**
 * ファイルをアップロード (PC -> Google Drive)
 */
function uploadFile(filename, contentType, base64Data, parentId = null) {
  try {
    const decodedDate = Utilities.base64Decode(base64Data);
    const blob = Utilities.newBlob(decodedDate, contentType, filename);

    let actualParentId = parentId;
    const realRootId = getRootFolderOnce().getId();

    if (parentId && parentId !== 'root' && parentId !== realRootId && parentId !== 'all' && (parentId.length < 15 || !/^[A-Za-z0-9_-]+$/.test(parentId))) {
      const foundId = getFolderIdByName_(parentId);
      if (foundId) actualParentId = foundId;
    }

    if (!actualParentId || actualParentId === 'root' || actualParentId === 'all') {
      actualParentId = realRootId;
    }

    // Drive API でアップロード
    const fileMetadata = {
      name: filename,
      parents: [actualParentId]
    };
    const file = Drive.Files.create(fileMetadata, blob);


    clearCacheAndSetFlag_(); // キャッシュ破棄 + フラグ
    return {
      success: true,
      file: packFileInfo_(getFileInfo_(file.id))
    };
  } catch (e) {
    return { success: false, message: e.toString() };
  }
}
/**
 * 【新機能】スタンププリセットを取得 (UserProperties優先)
 */
function getStampPresets() {
  try {
    const props = PropertiesService.getUserProperties();
    const savedStamps = props.getProperty('STAMP_PRESETS');
    if (savedStamps) {
      return JSON.parse(savedStamps);
    }

    // 保存されていない場合はスタンプ.htmlまたはデフォルトから取得
    try {
      const content = HtmlService.createHtmlOutputFromFile('スタンプ').getContent();
      return content.split('\n')
        .map(s => s.trim())
        .filter(s => s.length > 0);
    } catch (e) {
      // スタンプ.htmlは廃止済み。デフォルト値を使用する
      return ['[重要]', '[保存]', '[作業中]', '[原本]'];
    }
  } catch (e) {
    console.error('スタンプの取得に失敗しました: ' + e.message);
    return ['[重要]', '[保存]', '[作業中]', '[原本]'];
  }
}

/**
 * 【新機能】スタンププリセットを保存 (UserPropertiesへ)
 */
function saveStampPresets(stamps) {
  try {
    if (!Array.isArray(stamps)) throw new Error('データ形式が正しくありません');
    PropertiesService.getUserProperties().setProperty('STAMP_PRESETS', JSON.stringify(stamps));
    return { success: true };
  } catch (e) {
    return { success: false, message: e.message };
  }
}
/**
 * 【新機能】複数のファイルのダウンロード情報を一括取得 (V66 堅牢版)
 */
function getDownloadInfo(fileIds) {
  if (!Array.isArray(fileIds) || fileIds.length === 0) return { success: false, message: '対象がありません' };

  const results = [];
  const errors = [];

  fileIds.forEach(id => {
    try {
      // 1. 基本メタデータの取得
      const file = Drive.Files.get(id, { fields: 'id, name, mimeType, webContentLink, shortcutDetails' });
      let targetId = id;
      let targetMime = file.mimeType;
      let targetName = file.name;
      let downloadUrl = file.webContentLink;

      // 2. ショートカットの場合はターゲットを参照
      if (targetMime === 'application/vnd.google-apps.shortcut' && file.shortcutDetails) {
        targetId = file.shortcutDetails.targetId;
        const targetFile = Drive.Files.get(targetId, { fields: 'mimeType, name, webContentLink' });
        targetMime = targetFile.mimeType;
        targetName = targetFile.name;
        downloadUrl = targetFile.webContentLink;
      }

      let filename = targetName;

      // 3. Google形式の場合はエクスポートURLを優先
      if (targetMime === 'application/vnd.google-apps.spreadsheet') {
        downloadUrl = `https://docs.google.com/spreadsheets/d/${targetId}/export?format=xlsx`;
        if (!filename.toLowerCase().endsWith('.xlsx')) filename += '.xlsx';
      } else if (targetMime === 'application/vnd.google-apps.document') {
        downloadUrl = `https://docs.google.com/document/d/${targetId}/export?format=docx`;
        if (!filename.toLowerCase().endsWith('.docx')) filename += '.docx';
      } else if (targetMime === 'application/vnd.google-apps.presentation') {
        downloadUrl = `https://docs.google.com/presentation/d/${targetId}/export/pptx`;
      } else if (targetMime === 'application/vnd.google-apps.script') {
        // GASファイルはJSONとしてエクスポート
        downloadUrl = `https://script.google.com/feeds/download/export?id=${targetId}&format=json`;
        if (!filename.toLowerCase().endsWith('.json')) filename += '.json';
      } else if (targetMime === 'application/vnd.google-apps.folder') {
        // フォルダは直接ダウンロードできないためエラーとする（将来的にZip機能をつけるならここ）
        throw new Error('フォルダ（.app含む）は直接ダウンロードできません。中身を開いて個別にダウンロードしてください。');
      }

      // 4. URLが取得できた場合のみ追加
      if (downloadUrl) {
        results.push({ id: id, name: filename, url: downloadUrl });
      } else {
        errors.push(`${targetName}: ダウンロードURLを取得できませんでした`);
      }
    } catch (e) {
      console.error(`Download Info Error (${id}): ` + e);
      errors.push(`ID ${id}: ${e.message}`);
    }
  });

  if (results.length === 0 && errors.length > 0) {
    return { success: false, message: 'ダウンロード情報の取得にすべて失敗しました: ' + errors[0] };
  }

  return { success: true, downloads: results, errorCount: errors.length };
}


function include(filename) {
  // 【V194 軽量化】テンプレート評価を廃止し、純粋なHTML出力として取得することでロードを劇的に高速化
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}



// 【V290 最適化】MIMEタイプ→ファイルタイプのキャッシュ（同じMIMEの繰り返し呼び出しを高速化）
var _fileTypeCache = {};

function detectFileType_(mime, name) {
  // MIMEのみでキャッシュ可能なケース（拡張子に依存しない判定）
  var cached = _fileTypeCache[mime];
  if (cached !== undefined) {
    // 拡張子による分岐が必要なケースのみ再判定
    if (cached !== '__check_ext__') return cached;
  }

  var result;
  if (mime.includes('spreadsheet') || name.endsWith('.xlsx') || name.endsWith('.xlsm') || name.endsWith('.xls')) {
    result = (mime.includes('google-apps.spreadsheet')) ? 'spreadsheet' : 'excel';
  } else if (mime.includes('document') || name.endsWith('.docx') || name.endsWith('.doc')) {
    result = (mime.includes('google-apps.document')) ? 'document' : 'word';
  } else if (mime.includes('presentation') || name.endsWith('.pptx') || name.endsWith('.ppt')) {
    result = 'presentation';
  } else if (mime.includes('pdf')) {
    result = 'pdf';
  } else if (mime.startsWith('image/')) {
    result = 'image';
  } else if (mime.startsWith('video/')) {
    result = 'video';
  } else if (mime.startsWith('audio/') || name.endsWith('.wav') || name.endsWith('.mp3') || name.endsWith('.m4a')) {
    result = 'audio';
  } else if (mime.includes('zip') || name.endsWith('.zip') || name.endsWith('.lzh')) {
    result = 'zip';
  } else if (mime === 'application/vnd.google-apps.script' || name.endsWith('.gs')) {
    result = 'script';
  } else if (mime === 'application/vnd.google-apps.folder') {
    result = 'folder';
  } else {
    result = 'file';
  }

  // MIMEだけで判定できるものはキャッシュ
  if (mime.includes('spreadsheet') || mime.includes('document') || mime.includes('presentation') ||
      mime.includes('pdf') || mime.startsWith('image/') || mime.startsWith('video/') ||
      mime.startsWith('audio/') || mime.includes('zip') ||
      mime === 'application/vnd.google-apps.script' || mime === 'application/vnd.google-apps.folder') {
    _fileTypeCache[mime] = result;
  }

  return result;
}

function fetchAllDriveDataCombined_() {
  const resultFiles = [];
  const folderMap = new Map();
  const root = getRootFolderOnce();
  const rootId = root.getId();
  const startFolderId = getDynamicStartFolderId();

  // 【V260 高速化】1クエリに統合しつつ不要フィールドを削除
  // lastModifyingUser(カード未使用)・shared(未使用)を除外し、API応答を軽量化
  let token = null;
  do {
    const res = Drive.Files.list({
      q: "trashed = false and 'me' in owners",
      fields: 'nextPageToken, files(id, name, mimeType, createdTime, modifiedTime, webViewLink, parents, capabilities, ownedByMe)',
      pageSize: 1000,
      pageToken: token
    });

    if (res.files) {
      res.files.forEach(f => {
        if (f.mimeType === 'application/vnd.google-apps.folder') {
          const caps = f.capabilities || {};
          const deletable = (f.ownedByMe === true) || caps.canDelete || caps.canTrash || caps.canMoveToTrash || false;
          folderMap.set(f.id, {
            name: f.name,
            url: f.webViewLink,
            parents: f.parents || [],
            canDelete: deletable
          });
        } else {
          resultFiles.push(f);
        }
      });
    }
    token = res.nextPageToken;
  } while (token);

  if (!folderMap.has(rootId)) {
    folderMap.set(rootId, { name: root.getName(), url: root.getUrl(), parents: [] });
  }

  // 【最適化】childrenMap を1回だけ構築し、startFolderId フィルタと除外フォルダの両方で再利用
  const childrenMap = new Map();
  folderMap.forEach((info, id) => {
    (info.parents || []).forEach(p => {
      if (!childrenMap.has(p)) childrenMap.set(p, []);
      childrenMap.get(p).push(id);
    });
  });

  if (startFolderId) {
    const validIds = new Set();
    const queue = [startFolderId];
    if (folderMap.has(startFolderId)) {
      validIds.add(startFolderId);
      while (queue.length > 0) {
        const curr = queue.shift();
        const children = childrenMap.get(curr) || [];
        children.forEach(c => {
          if (!validIds.has(c) && folderMap.has(c)) {
            validIds.add(c);
            queue.push(c);
          }
        });
      }
      folderMap.forEach((_v, id) => { if (!validIds.has(id)) folderMap.delete(id); });
    }
  }

  // 【除外フォルダ】指定フォルダ配下の全子孫を folderMap から削除
  const excludedIds = getExcludeFolders();
  if (excludedIds.length > 0) {
    const toRemove = new Set(excludedIds);
    let exclQueue = [...excludedIds];
    while (exclQueue.length > 0) {
      const nextQueue = [];
      for (const fId of exclQueue) {
        const children = childrenMap.get(fId) || [];
        for (const childId of children) {
          if (!toRemove.has(childId)) { toRemove.add(childId); nextQueue.push(childId); }
        }
      }
      exclQueue = nextQueue;
    }
    toRemove.forEach(id => folderMap.delete(id));
  }

  const packedFiles = [];
  resultFiles.forEach(f => {
    let parentId = (f.parents && f.parents.length > 0) ? f.parents[0] : null;
    if (!parentId || !folderMap.has(parentId)) return;

    packedFiles.push([
      f.id,
      f.name,
      detectFileType_(f.mimeType, f.name),
      new Date(f.modifiedTime).getTime(),
      new Date(f.createdTime).getTime(),
      f.webViewLink,
      parentId
    ]);
  });

  return { files: packedFiles, folderMap: folderMap };
}

function executeTransfer(sourceIds, targetFolderId) {
  try {
    if (!sourceIds || sourceIds.length === 0 || !targetFolderId) {
      throw new Error('移動対象または移動先が指定されていません。');
    }

    const destinationId = (targetFolderId === 'root' || targetFolderId === 'マイドライブ') ?
      getDriveRootIdOnce() : targetFolderId;

    sourceIds.forEach(id => {
      const file = Drive.Files.get(id, { fields: 'parents' });
      const previousParents = (file.parents || []).join(',');

      Drive.Files.update({}, id, null, {
        addParents: destinationId,
        removeParents: previousParents
      });
    });

    clearAppDataCache_();
    return { success: true };
  } catch (e) {
    console.error('executeTransfer error:', e);
    return { success: false, message: e.toString() };
  }
}
