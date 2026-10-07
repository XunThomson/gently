/**
 * 领域模型的线上表示（wire DTO）。
 *
 * 与桌面端 `src/types/index.ts` 对齐；差异只在「后端不必下发的字段」，
 * 任何新增字段都必须可选，避免老客户端解析失败。
 */
import {z} from 'zod';
import {apiErrorSchema, qualitySchema, trackRefSchema} from './primitives.js';

/* ============================== 曲目 ============================== */

/** 展示用时长，形如 03:45 */
export const durationTextSchema = z.string().regex(/^\d{1,3}:[0-5]\d$/);

export const trackSchema = z.object({
    id: z.string(),
    title: z.string(),
    artist: z.string(),
    album: z.string(),
    duration: durationTextSchema,
    durationSec: z.number().int().nonnegative(),
    source: z.string(),
    gradient: z.string().describe('无封面图时的占位渐变'),
    tags: z.array(z.string()).describe('个性化推荐的基础'),
    albumId: z.string().optional(),
});

export const trackCandidateSchema = z.object({
    source: z.string(),
    track: trackSchema,
    qualities: z.array(qualitySchema).describe('该音源支持的档位，由高到低'),
});

/** 聚合歌曲：**候选顺序即优先级**，前端按序回退 */
export const groupedTrackSchema = trackSchema.extend({
    candidates: z.array(trackCandidateSchema),
    sourceCount: z.number().int().positive(),
});

export const lyricLineSchema = z.object({
    time: z.number().nonnegative().describe('该行开始时间（秒）'),
    text: z.string(),
});

export const lyricsSchema = z.object({
    format: z.enum(['lrc', 'plain']),
    content: z.string(),
    translated: z.string().optional(),
    lines: z.array(lyricLineSchema).optional().describe('后端已解析时直接下发，省去客户端解析'),
});

/* ============================== 专辑 / 歌单 ============================== */

export const albumSchema = z.object({
    id: z.string(),
    title: z.string(),
    artist: z.string(),
    cover: z.string(),
    year: z.number().int(),
    tags: z.array(z.string()),
    source: z.string(),
    tracks: z.array(trackSchema),
});

export const curatedPlaylistSchema = z.object({
    id: z.string(),
    title: z.string(),
    description: z.string(),
    cover: z.string(),
    tags: z.array(z.string()),
    source: z.string(),
    tracks: z.array(trackSchema),
});

/** 用户自建歌单 */
export const playlistSchema = z.object({
    id: z.string(),
    name: z.string(),
    createdAt: z.number().int(),
    tracks: z.array(trackSchema),
});

export const playlistPayloadSchema = z.object({
    id: z.string().optional(),
    name: z.string().min(1).max(80),
    description: z.string().max(500).optional(),
    trackRefs: z.array(trackRefSchema).max(5000),
});

/* ============================== 榜单 ============================== */

export const chartTypeSchema = z.enum(['hot', 'new', 'rise', 'origin']);
export const periodSchema = z.enum(['day', 'week', 'month', 'year']);

export const chartEntrySchema = z.object({
    rank: z.number().int().positive(),
    track: groupedTrackSchema,
    /** 热度，用于「趋势」列 */
    heat: z.number(),
    /** 相比上一周期排名变化，正数表示上升 */
    delta: z.number().int().optional(),
});

/* ============================== 用户与收藏 ============================== */

export const userProfileSchema = z.object({
    id: z.string(),
    nickname: z.string(),
    avatarUrl: z.string().optional(),
    level: z.number().int().optional(),
    createdAt: z.string().describe('ISO 8601'),
});

export const favoriteDeltaSchema = z.object({
    idempotencyKey: z.string().min(8),
    added: z.array(trackRefSchema).max(1000),
    removed: z.array(trackRefSchema).max(1000),
    clientTime: z.string().describe('ISO 8601，用于后写覆盖的冲突合并'),
});

export const recentTrackSchema = z.object({
    trackRef: trackRefSchema,
    playedAt: z.number().int(),
    playCount: z.number().int().positive(),
    /** 播放完成度 0~1，用于推荐回路的负反馈识别 */
    completed: z.number().min(0).max(1).optional(),
});

/* ============================== 推荐 ============================== */

export const recommendationReasonSchema = z.object({
    kind: z.enum(['tag', 'artist', 'trending', 'similar']),
    value: z.string(),
    score: z.number().min(0).max(1),
});

export const recommendedTrackSchema = groupedTrackSchema.extend({reason: recommendationReasonSchema});
export const recommendedAlbumSchema = albumSchema.extend({reason: recommendationReasonSchema});
export const recommendedPlaylistSchema = curatedPlaylistSchema.extend({reason: recommendationReasonSchema});

export const tasteProfileSchema = z.object({
    tags: z.record(z.number()),
    artists: z.record(z.number()),
    sampleSize: z.number().int().nonnegative(),
    updatedAt: z.number().int(),
});

export const recommendationBundleSchema = z.object({
    profile: tasteProfileSchema,
    tracks: z.array(recommendedTrackSchema),
    albums: z.array(recommendedAlbumSchema),
    playlists: z.array(recommendedPlaylistSchema),
});

export const recommendFeedbackSchema = z.object({
    trackRef: trackRefSchema,
    kind: z.enum(['play', 'skip', 'like', 'unlike', 'complete']),
    /** 播放时长占比 0~1，用于区分「跳过」与「没听完」 */
    progress: z.number().min(0).max(1).optional(),
    clientTime: z.string(),
});

/* ============================== 播放 ============================== */

export const playbackResolveRequestSchema = z.object({
    track: trackRefSchema,
    quality: qualitySchema,
    network: z.enum(['wifi', 'cellular', 'unknown']).optional(),
    /** 用户偏好的音源顺序；缺省由后端按偏好决定 */
    preferredSources: z.array(z.string()).optional(),
});

export const playbackResolveResponseSchema = z.object({
    url: z.string(),
    quality: qualitySchema.describe('实际下发的档位，可能低于期望'),
    expiresInSec: z.number().int().positive(),
    source: z.string(),
});

export const playbackReportSchema = z.object({
    trackRef: trackRefSchema,
    source: z.string(),
    playedSec: z.number().nonnegative(),
    completed: z.boolean(),
    clientTime: z.string(),
});

/* ============================== 插件 ============================== */

export const pluginSummarySchema = z.object({
    id: z.string(),
    name: z.string(),
    version: z.string(),
    author: z.string(),
    description: z.string(),
    homepage: z.string().optional(),
    builtin: z.boolean(),
    qualities: z.array(qualitySchema),
    healthy: z.boolean().optional().describe('服务端探测结果'),
});

export const pluginConfigSchema = z.object({
    /** 插件自定义配置：结构由插件清单声明，后端只做透传与版本化 */
    values: z.record(z.unknown()),
    /** 乐观并发：客户端提交时回传，冲突返回 common.conflict */
    revision: z.number().int().nonnegative(),
});

export const pluginInstallRequestSchema = z.object({
    id: z.string(),
    version: z.string().optional(),
    confirmed: z.boolean().describe('用户显式确认，避免静默安装'),
});

/* ============================== 下载 ============================== */

export const downloadStatusSchema = z.enum(['pending', 'downloading', 'paused', 'done', 'error']);

export const downloadTaskSchema = z.object({
    id: z.string(),
    trackRef: trackRefSchema,
    title: z.string(),
    status: downloadStatusSchema,
    progress: z.number().min(0).max(1),
    totalBytes: z.number().int().nonnegative(),
    doneBytes: z.number().int().nonnegative(),
    error: apiErrorSchema.optional(),
});

export const downloadCreateRequestSchema = z.object({
    trackRef: trackRefSchema,
    quality: qualitySchema,
    relativeDir: z.string().optional().describe('相对用户音乐库根目录'),
});

/* ============================== 皮肤 ============================== */

/**
 * 皮肤在服务端是**不透明文档**：后端只保证结构与版本，不理解 token 语义。
 * 这样前端新增 token 不必改后端。
 */
export const skinSchema = z.object({
    id: z.string(),
    name: z.string(),
    author: z.string(),
    version: z.string(),
    description: z.string().optional(),
    /** 覆盖 theme.config.json 任意 token 组，键与前端 ThemeSkin 一致 */
    overrides: z.record(z.unknown()),
    downloaded: z.number().int().nonnegative().optional(),
});

export const skinSyncPayloadSchema = z.object({
    idempotencyKey: z.string().min(8),
    installed: z.array(skinSchema).max(200),
    activeSkinId: z.string().optional(),
    clientTime: z.string(),
});

/* ============================== 实时事件 ============================== */

export const realtimeEventSchema = z.discriminatedUnion('type', [
    z.object({type: z.literal('download.progress'), payload: downloadTaskSchema}),
    z.object({type: z.literal('download.done'), payload: downloadTaskSchema}),
    z.object({type: z.literal('plugin.health'), payload: pluginSummarySchema}),
    z.object({type: z.literal('session.revoked'), payload: z.object({reason: z.string()})}),
]);

export type TrackDto = z.infer<typeof trackSchema>;
export type GroupedTrackDto = z.infer<typeof groupedTrackSchema>;
export type AlbumDto = z.infer<typeof albumSchema>;
export type PlaylistDto = z.infer<typeof playlistSchema>;
export type PluginSummaryDto = z.infer<typeof pluginSummarySchema>;
export type DownloadTaskDto = z.infer<typeof downloadTaskSchema>;
export type SkinDto = z.infer<typeof skinSchema>;
export type RealtimeEventDto = z.infer<typeof realtimeEventSchema>;
export type UserProfileDto = z.infer<typeof userProfileSchema>;
