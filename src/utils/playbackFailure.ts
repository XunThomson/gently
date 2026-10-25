import type {TFunction} from 'i18next';
import type {PlaybackFailure} from '../store/types';

/**
 * 播放失败的一句话原因。
 *
 * 播放条与迷你播放器共用这一份，避免一边说「所有音源都放不了（3 个）」、
 * 另一边只说「无法播放」。`detail` 是媒体原始错误，只作为次要说明。
 */
export function playbackFailureText(error: PlaybackFailure, t: TFunction): string {
    const reason = error.kind === 'noSource'
        ? t('player.failureNoSource', {count: error.failedSources.length})
        : t('player.failureMedia');
    return error.detail ? `${reason} · ${error.detail}` : reason;
}
