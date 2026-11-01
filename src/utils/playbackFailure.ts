import type {TFunction} from 'i18next';
import type {PlaybackFailure} from '../store/types';

/**
 * 播放失败的一句话原因。
 *
 * 播放条与迷你播放器共用这一份，避免一边说「所有音源都放不了（3 个）」、
 * 另一边只说「无法播放」。`detail` 是媒体原始错误，只作为次要说明。
 *
 * 三种失败要分开说（R111）：
 * - `noSource`：解析不到任何地址（没有源 / 源都失败）；
 * - `media`：有地址但媒体元素报错（解码、请求被拒、地址过期）；
 * - `interrupted`：**地址没问题**，是系统把播放管道掐了（安卓锁屏/后台一段时间后，
 *   `play()` 既不成功也不报错）。这时让用户看到「点播放继续」比只说「无法播放」有用。
 */
export function playbackFailureText(error: PlaybackFailure, t: TFunction): string {
    const reason =
        error.kind === 'noSource'
            ? t('player.failureNoSource', {count: error.failedSources.length})
            : error.kind === 'interrupted'
              ? t('player.failureInterrupted')
              : t('player.failureMedia');
    return error.detail ? `${reason} · ${error.detail}` : reason;
}
