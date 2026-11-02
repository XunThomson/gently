export {catalogService} from './catalog.service';
export {libraryService} from './library.service';
export {recommendService} from './recommend.service';
export {skinService} from './skin.service';
export type {SkinImportOutcome} from './skin.service';
export {audioEngine} from './audio.service';
export type {AudioHandlers} from './audio.service';
export {
    syncPlaybackBanner,
    installMediaActionHandler,
    playbackBannerKey,
} from './playbackBanner.service';
export type {MediaAction} from './playbackBanner.service';
export {importAudioFiles, importedMusicDir} from './import.service';
export type {ImportAudioResult} from './import.service';
export {fileService, revealInDirAvailable} from './file.service';
export {backgroundService} from './background.service';
export type {
    BackgroundSaveError,
    BackgroundSaveResult,
    WebSaveResult,
} from './background.service';
export {
    windowService,
    isTauri,
    desktopWindowActionsAvailable,
    DESKTOP_LYRICS_LABEL,
    DESKTOP_LYRICS_EVENTS,
    PET_WINDOW_LABEL,
    PET_WINDOW_EVENTS,
    PET_WINDOW_POSITION_KEY,
    readPetPosition,
} from './window.service';
export {
    coreAvailable,
    corePlugin,
    coreSystem,
    describeError,
    hostRestartApp,
    invokeCore,
    probeCore,
} from './core.bridge';
/* 宠物域是**独立引擎**的独立门面（`pet_invoke`），与音乐核心并列 */
export {petInvoke, petService} from './core.pet';
export type {
    PetEnvelope,
    PetFrameDto,
    PetProfileDto,
    PetSpecDto,
    PetStateDto,
    PetTickInput,
    PetTickResult,
} from './core.pet';
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
