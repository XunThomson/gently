export {catalogService} from './catalog.service';
export {libraryService} from './library.service';
export {recommendService} from './recommend.service';
export {skinService} from './skin.service';
export type {SkinImportOutcome} from './skin.service';
export {audioEngine} from './audio.service';
export type {AudioHandlers} from './audio.service';
export {fileService} from './file.service';
export {
    windowService,
    isTauri,
    DESKTOP_LYRICS_LABEL,
    DESKTOP_LYRICS_EVENTS,
} from './window.service';
export {coreAvailable, corePlugin, coreSystem, describeError, invokeCore, probeCore} from './core.bridge';
export {oauthBegin, oauthCancel, oauthListen, oauthSignOut, oauthStatus} from './core.oauth';
export type {OAuthChangedPayload} from './core.oauth';
export {
    coreAlbum,
    coreCancelSearch,
    coreLyrics,
    corePlaylist,
    coreRecommend,
    coreResolveUrl,
    coreSearch,
    coreTopList,
    coreTopLists,
    coreTrackDetail,
} from './core.catalog';
export type {CoreSearchResult, SearchHandlers} from './core.catalog';
export {
    coreClearHistory,
    coreDeletePlaylist,
    coreLoadDownloads,
    coreLoadFavorites,
    coreLoadLocal,
    coreLoadPlaylists,
    coreLoadRecent,
    corePlaybackReport,
    corePushHistory,
    coreRecommendFeedback,
    coreRecommendHome,
    coreRecommendSimilar,
    coreRemoveLocal,
    coreSavePlaylist,
    coreScanLocal,
    coreSetFavorite,
    trackRefOf,
} from './core.library';
export {
    coreClearFinishedDownloads,
    coreDownloadsAvailable,
    coreCreateDownload,
    coreListenDownloads,
    corePauseDownload,
    coreRemoveDownload,
    coreResumeDownload,
} from './core.download';
export type {DownloadHandlers} from './core.download';
